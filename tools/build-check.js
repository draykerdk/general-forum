#!/usr/bin/env node
'use strict';

/*
 * Checks for the data core: sanitizer, text extraction, reference parsing,
 * GitHub client retries and recording, the snapshot contract built from the
 * recorded fixture, and the preview server.
 * Usage: node tools/build-check.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { sanitizeHtml, htmlToText } = require('./lib/sanitize');
const { createClient, fixtureName, trimForFixture, isApiUrl } = require('./lib/github');
const { findReferences, sanitizeFragment, clip, hiddenReason, buildSnapshot, SCHEMA } = require('./build-forum-snapshot');
const { clipText, titleText, ASSEMBLY_NOTICE, ASSEMBLY_MERGED_NOTICE, TALLY_WORKFLOW, HIDDEN_VOTE_NOTE, WITHHELD_NOTE, voteText, voteTag } = require('./prerender');
const vote = require('./lib/vote');
const { scriptInMarkup, markupUrls, ownMarkers } = require('./forum-check');
const { createServer } = require('./serve');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-build-check-'));

function build(fixture, out) {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'tools/build-forum-snapshot.js'), '--fixture', fixture, '--out', out], { encoding: 'utf8' });
  return run;
}
const runTool = (file, args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', file)].concat(args), { encoding: 'utf8', cwd: ROOT });
function buildOk(fixture, out) {
  const run = build(fixture, out);
  assert.strictEqual(run.status, 0, 'build failed: ' + run.stderr);
  return out;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Every place untrusted HTML ends up must be free of these.
function assertSafe(html, where) {
  const label = where ? ' in ' + where : '';
  assert.ok(!/<\s*(script|style|iframe|frame|object|embed|svg|math|form|textarea|select|option|button|link|meta|base|audio|video|source|canvas|template|noscript)\b/i.test(html), 'forbidden tag survived' + label);
  // Text is escaped, so every literal '<' that remains opens a real tag.
  const tags = (html.match(/<[A-Za-z][^>]*>/g) || []).join(' ');
  assert.ok(!/\son[a-z]+\s*=/i.test(tags), 'event handler attribute survived' + label);
  assert.ok(!/\sstyle\s*=/i.test(tags), 'style attribute survived' + label);
  assert.ok(!/\s(id|name|data-[a-z-]+|aria-[a-z-]+|target)\s*=/i.test(tags), 'disallowed attribute survived' + label);
  const urls = [];
  tags.replace(/\s(href|src)="([^"]*)"/g, (_m, _k, v) => urls.push(v));
  for (const value of urls) {
    assert.ok(/^(https?:|mailto:|\/t\/)/i.test(value), 'unexpected URL scheme' + label + ': ' + value);
    assert.ok(!/^\s*(javascript|vbscript|data):/i.test(value), 'dangerous URL' + label + ': ' + value);
  }
  html.replace(/<a\b[^>]*>/g, (tag) => {
    assert.ok(tag.includes('rel="nofollow ugc noopener noreferrer"'), 'link without rel' + label + ': ' + tag);
    return tag;
  });
  html.replace(/<img\b[^>]*>/g, (tag) => {
    assert.ok(/src="https:\/\//.test(tag), 'image without https src' + label + ': ' + tag);
    assert.ok(tag.includes('loading="lazy"') && tag.includes('referrerpolicy="no-referrer"'), 'image without lazy/referrer policy' + label);
    assert.ok(!tag.includes('private-user-images'), 'expiring private image URL survived' + label);
    return tag;
  });
  tags.replace(/\sclass="([^"]*)"/g, (_m, value) => {
    for (const token of value.split(' ')) assert.ok(/^(pl-[a-z0-9]+|task-list-item|task-list-item-checkbox|contains-task-list|user-mention|issue-link)$/.test(token), 'class not allowed: ' + token);
  });
}

// ---------------------------------------------------------------- sanitizer

const ctx = { org: 'draykerdk', threadExists: (repo, num) => (repo.toLowerCase() === 'uid' && num === 1 ? 'uid' : null), rawBody: '' };
const clean = (html, extra) => sanitizeHtml(html, Object.assign({}, ctx, extra || {}));

const VECTORS = {
  script: '<p>a<script>alert(1)</script>b</p>',
  scriptUnclosed: '<p>a</p><script>alert(1)',
  imgOnerror: '<img src=x onerror=alert(1)>',
  imgOnerrorHttps: '<img src="https://example.com/a.png" onerror="alert(1)" onload=alert(2)>',
  jsHref: '<a href="javascript:alert(1)">x</a>',
  jsHrefCase: '<a href="JaVaScRiPt:alert(1)">x</a>',
  jsHrefEntity: '<a href="&#106;avascript:alert(1)">x</a>',
  jsHrefHex: '<a href="&#x6A;avascript&colon;alert(1)">x</a>',
  jsHrefNoSemicolon: '<a href="&#106&#97&#118&#97&#115&#99&#114&#105&#112&#116&#58alert(1)">x</a>',
  jsHrefWhitespace: '<a href=" \t java\nscript:alert(1)">x</a>',
  jsHrefControl: '<a href="\u0001javascript:alert(1)">x</a>',
  dataHref: '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
  dataImg: '<img src="data:image/png;base64,AAAA">',
  vbHref: '<a href="vbscript:msgbox(1)">x</a>',
  svg: '<svg onload=alert(1)><script>alert(2)</script><text>svgtext</text></svg>',
  svgSelfClosing: '<svg/onload=alert(1)>after',
  iframe: '<iframe src="https://example.com">iframetext</iframe>',
  style: '<style>body{background:red}</style><p style="color:red">s</p>',
  noscriptMxss: '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  math: '<math><mi xlink:href="javascript:alert(1)">mathtext</mi></math>',
  form: '<form action="https://evil.example"><input name="q"><button>go</button>formtext</form>',
  unclosed: '<p><b>bold <i>italic',
  attrsUnquoted: '<a href=https://example.com/x onclick=alert(1) title=t>x</a>',
  attrBreakout: '<a href="https://example.com/&quot;onmouseover=&quot;alert(1)">x</a>',
  commentTrick: '<!--><script>alert(1)</script>--><p>after</p>',
  cdata: '<![CDATA[<img src=x onerror=alert(1)>]]>',
  doctype: '<!doctype html><?xml version="1.0"?><p>ok</p>',
  objectEmbed: '<object data="x.swf"><param name=a value=b>objtext</object><embed src="x.swf">',
  base: '<base href="https://evil.example/"><link rel=stylesheet href=x><meta http-equiv=refresh content="0;url=javascript:alert(1)">',
  template: '<template><img src=x onerror=alert(1)></template>',
  nestedTags: '<scr<script>ipt>alert(1)</script>',
  textareaBreakout: '<textarea></textarea><img src=x onerror=alert(1)></textarea>',
  titleRcdata: '<title><img src=x onerror=alert(1)></title>',
  xmp: '<xmp><img src=x onerror=alert(1)></xmp>',
  hiddenInput: '<input type="hidden" value="x"><input type="image" src="x">'
};

test('sanitizer removes every attack vector', () => {
  for (const [name, html] of Object.entries(VECTORS)) {
    const out = clean(html);
    assertSafe(out, name);
    // Every remaining '<' must open an allowlisted tag; anything else is escaped text.
    const tags = out.match(/<\/?([a-z0-9]+)/g) || [];
    for (const tag of tags) assert.ok(/^<\/?(p|br|hr|h[3-6]|a|strong|em|b|i|del|s|ins|sup|sub|kbd|code|pre|blockquote|ul|ol|li|table|thead|tbody|tr|th|td|img|details|summary|span|div|input)$/.test(tag), 'unexpected tag ' + tag + ' in ' + name);
  }
  assert.strictEqual(clean(VECTORS.script), '<p>ab</p>');
  assert.strictEqual(clean(VECTORS.jsHref), '<a rel="nofollow ugc noopener noreferrer">x</a>');
  assert.strictEqual(clean(VECTORS.jsHrefEntity), '<a rel="nofollow ugc noopener noreferrer">x</a>');
  assert.strictEqual(clean(VECTORS.jsHrefNoSemicolon), '<a rel="nofollow ugc noopener noreferrer">x</a>');
  assert.strictEqual(clean(VECTORS.svg), '');
  assert.strictEqual(clean(VECTORS.iframe), '');
  assert.strictEqual(clean(VECTORS.style), '<p>s</p>');
  assert.strictEqual(clean(VECTORS.math), '');
  assert.strictEqual(clean(VECTORS.form), '');
  assert.strictEqual(clean(VECTORS.imgOnerror), '', 'an image without an https source is dropped');
  assert.strictEqual(clean(VECTORS.noscriptMxss), '&quot;&gt;');
  assert.strictEqual(clean(VECTORS.commentTrick), '--&gt;<p>after</p>');
  assert.strictEqual(clean(VECTORS.template), '');
  assert.strictEqual(clean(VECTORS.base), '');
  assert.strictEqual(clean(VECTORS.titleRcdata), '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(clean(VECTORS.hiddenInput), '');
  assert.ok(clean(VECTORS.attrBreakout).startsWith('<a href="https://example.com/%22onmouseover=%22alert(1)"'));
  assert.strictEqual(clean(VECTORS.unclosed), '<p><b>bold <i>italic</i></b></p>');
});

test('sanitizer keeps the allowed structure', () => {
  const html = '<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6>'
    + '<p>x<br>y<hr><strong>s</strong><em>e</em><b>b</b><i>i</i><del>d</del><s>s</s><ins>n</ins><sup>1</sup><sub>2</sub><kbd>k</kbd></p>'
    + '<pre><code class="pl-k notranslate">a &lt; b</code></pre><blockquote>q</blockquote>'
    + '<ol start="3"><li>x</li></ol><table><thead><tr><th align="right">h</th></tr></thead><tbody><tr><td align="center" valign="top">c</td></tr></tbody></table>'
    + '<details open><summary>S</summary>D</details><span class="user-mention">@a</span><div>d</div>';
  const out = clean(html);
  assert.strictEqual(out, '<h3>A</h3><h3>B</h3><h4>C</h4><h5>D</h5><h6>E</h6><h6>F</h6>'
    + '<p>x<br>y</p><hr><strong>s</strong><em>e</em><b>b</b><i>i</i><del>d</del><s>s</s><ins>n</ins><sup>1</sup><sub>2</sub><kbd>k</kbd>'
    + '<pre><code class="pl-k">a &lt; b</code></pre><blockquote>q</blockquote>'
    + '<ol start="3"><li>x</li></ol><table><thead><tr><th align="right">h</th></tr></thead><tbody><tr><td align="center">c</td></tr></tbody></table>'
    + '<details open><summary>S</summary>D</details><span class="user-mention">@a</span><div>d</div>');
  assert.strictEqual(clean('<custom-el>text <font color=red>red</font></custom-el>'), 'text red');
  assert.strictEqual(clean('a &amp; b &lt; c &copy; &hellip; &#x1F600; &bogus;'), 'a &amp; b &lt; c © … 😀 &amp;bogus;');
  // '"' in text is escaped, so text never reads as attribute syntax.
  assert.strictEqual(clean('<p>write href="/x" or src="/y"</p>'), '<p>write href=&quot;/x&quot; or src=&quot;/y&quot;</p>');
  assert.strictEqual(clean(clean('<p>a "b"</p>')), '<p>a &quot;b&quot;</p>', 'escaped quotes are a fixed point');
});

test('sanitizer adds rel, resolves and rewrites links', () => {
  assert.strictEqual(clean('<a href="https://example.com" target="_blank" rel="opener">x</a>'), '<a href="https://example.com/" rel="nofollow ugc noopener noreferrer">x</a>');
  assert.strictEqual(clean('<a href="/draykerdk/dk">x</a>'), '<a href="https://github.com/draykerdk/dk" rel="nofollow ugc noopener noreferrer">x</a>');
  assert.strictEqual(clean('<a href="//example.com/p">x</a>'), '<a href="https://example.com/p" rel="nofollow ugc noopener noreferrer">x</a>');
  assert.strictEqual(clean('<a href="mailto:a@example.com">m</a>'), '<a href="mailto:a@example.com" rel="nofollow ugc noopener noreferrer">m</a>');
  assert.strictEqual(clean('<a href="https://github.com/draykerdk/uid/issues/1" class="issue-link js-issue-link" data-hovercard-url="/x">#1</a>'),
    '<a href="/t/uid/1/" class="issue-link" rel="nofollow ugc noopener noreferrer">#1</a>');
  assert.strictEqual(clean('<a href="https://github.com/DraykerDK/UID/issues/1#issuecomment-9">c</a>'), '<a href="/t/uid/1/#issuecomment-9" rel="nofollow ugc noopener noreferrer">c</a>');
  assert.strictEqual(clean('<a href="https://github.com/draykerdk/uid/issues/2">x</a>'), '<a href="https://github.com/draykerdk/uid/issues/2" rel="nofollow ugc noopener noreferrer">x</a>', 'unknown thread stays on GitHub');
  assert.strictEqual(clean('<a href="https://github.com/other/uid/issues/1">x</a>'), '<a href="https://github.com/other/uid/issues/1" rel="nofollow ugc noopener noreferrer">x</a>', 'other orgs are not rewritten');
  assert.strictEqual(clean('<a href="https://github.com/draykerdk/uid/pull/1">x</a>'), '<a href="https://github.com/draykerdk/uid/pull/1" rel="nofollow ugc noopener noreferrer">x</a>');
  // A malformed percent-escape in the repository part is left unrewritten instead of throwing.
  assert.strictEqual(clean('<a href="https://github.com/draykerdk/a%E9/issues/1">x</a>'), '<a href="https://github.com/draykerdk/a%E9/issues/1" rel="nofollow ugc noopener noreferrer">x</a>');
  assert.strictEqual(clean('<a href="https://github.com/draykerdk/a%/issues/1">x</a>'), '<a href="https://github.com/draykerdk/a%/issues/1" rel="nofollow ugc noopener noreferrer">x</a>');
});

test('sanitizer keeps its own forum paths only with ctx.internalPath', () => {
  const internal = { internalPath: (slug, num) => slug === 'uid' && num === 1 };
  // First pass: a user's /t/ path or github.com/t/ link stays on github.com.
  assert.strictEqual(clean('<a href="/t/uid/1/">x</a>'), '<a href="https://github.com/t/uid/1/" rel="nofollow ugc noopener noreferrer">x</a>');
  assert.strictEqual(clean('<a href="https://github.com/t/uid/1/">x</a>'), '<a href="https://github.com/t/uid/1/" rel="nofollow ugc noopener noreferrer">x</a>');
  // Second pass: the build's own rewrites are kept, so sanitizing again is a fixed point.
  for (const html of ['<a href="https://github.com/draykerdk/uid/issues/1">x</a>', '<a href="https://github.com/draykerdk/uid/issues/1#issuecomment-9">x</a>',
    '<a href="https://github.com/t/uid/1/">x</a>', '<a href="/t/uid/1/">x</a>', '<a href="https://github.com/draykerdk/uid/issues/1#a&amp;b\'c">x</a>']) {
    const once = clean(html);
    assert.strictEqual(clean(once, internal), once, 'fixed point for ' + html);
  }
  assert.strictEqual(clean('<a href="/t/uid/2/">x</a>', internal), '<a href="https://github.com/t/uid/2/" rel="nofollow ugc noopener noreferrer">x</a>', 'only existing pages are kept');
  assert.strictEqual(clean('<a href="/t/uid/1/?x=1">x</a>', internal), '<a href="https://github.com/t/uid/1/?x=1" rel="nofollow ugc noopener noreferrer">x</a>');
  assert.strictEqual(clean('<a href="/t/%E9/1/">x</a>', { internalPath: () => true }), '<a href="https://github.com/t/%E9/1/" rel="nofollow ugc noopener noreferrer">x</a>', 'malformed slug escape');
});

test('one fragment that cannot be sanitized does not stop the build', () => {
  const warnings = [];
  const throwing = () => { throw new URIError('URI malformed'); };
  const out = sanitizeFragment('<p>Hello <b>world</b> <script>x()</script> & <i>more</i></p>', ctx, 'lab#1', throwing, (m) => warnings.push(m));
  assert.strictEqual(out, '<p>Hello world &amp; more</p>');
  assert.strictEqual(warnings.length, 1);
  assert.ok(/lab#1 could not be sanitized \(URI malformed\)/.test(warnings[0]), warnings[0]);
  assert.strictEqual(sanitizeFragment('', ctx, 'x', throwing, () => {}), '');
  assert.strictEqual(sanitizeFragment('<p>ok</p>', ctx, 'x'), '<p>ok</p>');
});

test('sanitizer rewrites expiring private images and keeps image policy', () => {
  const uuid = '0a1b2c3d-1111-2222-3333-444455556666';
  const priv = 'https://private-user-images.githubusercontent.com/2/398765432-' + uuid + '.png?jwt=eyJ.x.y';
  const out = clean('<a href="' + priv + '"><img src="' + priv + '" alt="shot" style="max-width:100%" width="300" height="x"></a>');
  assert.strictEqual(out, '<a href="https://github.com/user-attachments/assets/' + uuid + '" rel="nofollow ugc noopener noreferrer"><img src="https://github.com/user-attachments/assets/' + uuid
    + '" alt="shot" width="300" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>');
  const other = 'ffffffff-1111-2222-3333-444455556666';
  const fromRaw = clean('<img src="https://private-user-images.githubusercontent.com/2/no-id.png?jwt=1">', { rawBody: '![a](https://github.com/user-attachments/assets/' + other + ')' });
  assert.ok(fromRaw.includes('src="https://github.com/user-attachments/assets/' + other + '"'), 'id recovered from raw markdown');
  assert.strictEqual(clean('<img src="https://private-user-images.githubusercontent.com/2/no-id.png?jwt=1">'), '', 'unrecoverable private image dropped');
  assert.strictEqual(clean('<img src="http://example.com/a.png">'), '', 'http image dropped');
  assert.strictEqual(clean('<img src="/relative.png">'), '', 'relative image dropped');
});

test('sanitizer handles task lists, inputs and depth', () => {
  assert.strictEqual(clean('<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" id="" class="task-list-item-checkbox" checked=""> a</li></ul>'),
    '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked disabled class="task-list-item-checkbox"> a</li></ul>');
  assert.strictEqual(clean('<input type="checkbox">'), '<input type="checkbox" disabled>');
  const deep = clean('<div>'.repeat(40) + 'deep' + '</div>'.repeat(40));
  assert.strictEqual((deep.match(/<div>/g) || []).length, 32);
  assert.strictEqual((deep.match(/<\/div>/g) || []).length, 32);
  assert.ok(deep.includes('deep'));
  const mixed = clean('<blockquote>'.repeat(50) + '<p>inner</p>' + '</blockquote>'.repeat(50));
  assert.strictEqual((mixed.match(/<blockquote>/g) || []).length, 32);
  assert.ok(mixed.includes('inner') && !mixed.includes('<p>'), 'content beyond the depth limit is flattened to text');
  assert.strictEqual(clean('<ul><li>a<li>b</ul>'), '<ul><li>a</li><li>b</li></ul>');
  assert.strictEqual(clean('</div></p>text</b>'), 'text');
  assert.strictEqual(clean(null), '');
});

test('htmlToText extracts readable plain text', () => {
  assert.strictEqual(htmlToText('<h3>Title</h3><p>One &amp; two</p><ul><li>a</li><li>b</li></ul><script>x()</script><style>p{}</style>'), 'Title One & two a b');
  assert.strictEqual(htmlToText('<p>a<br>b</p><table><tr><td>1</td><td>2</td></tr></table>'), 'a b 1 2');
  assert.strictEqual(htmlToText('<svg><text>no</text></svg>yes'), 'yes');
  assert.strictEqual(htmlToText('  spaced \n\n text here '), 'spaced text here');
  assert.strictEqual(htmlToText(''), '');
  const long = clip('word '.repeat(100), 280);
  assert.ok(long.length <= 280 && long.endsWith('…'));
  assert.strictEqual(clip('short', 280), 'short');
});

test('clipping never splits a surrogate pair', () => {
  const emoji = '\u{1F600}'.repeat(1200);
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const max of [280, 279, 2000, 180, 181]) {
    for (const [name, fn] of [['clip', clip], ['clipText', clipText]]) {
      const out = fn(emoji, max);
      assert.ok(out.length <= max && out.endsWith('…'), name + ' ' + max + ' length');
      assert.ok(!lone.test(out), name + ' ' + max + ' left a lone surrogate');
      assert.strictEqual(Array.from(out.slice(0, -1)).every((c) => c === '\u{1F600}'), true, name + ' ' + max + ' kept whole emoji');
    }
  }
  assert.strictEqual(clip('ab\u{1F600}', 3), 'ab…');
  assert.strictEqual(clipText('ab\u{1F600}', 3), 'ab…');
});

test('titles keep only characters XML can carry', () => {
  assert.strictEqual(titleText('\u0001'), '(untitled)');
  assert.strictEqual(titleText('\uFFFF'), '(untitled)');
  assert.strictEqual(titleText(' \uD800 \u0008 '), '(untitled)', 'lone surrogates and controls only');
  assert.strictEqual(titleText('a\u0001b \u{1F600}'), 'ab \u{1F600}', 'surrogate pairs are kept');
  assert.strictEqual(titleText('>'), '>');
});

test('comments hidden on GitHub keep only their reason', () => {
  assert.strictEqual(hiddenReason({ minimized: null }), null);
  assert.strictEqual(hiddenReason({}), null);
  assert.strictEqual(hiddenReason({ minimized: { reason: 'off-topic' } }), 'off-topic');
  assert.strictEqual(hiddenReason({ minimized: { reason: 'OFF_TOPIC' } }), 'off-topic');
  assert.strictEqual(hiddenReason({ minimized: { reason: 'abuse' } }), 'abuse');
  assert.strictEqual(hiddenReason({ minimized: {} }), 'hidden');
  assert.strictEqual(hiddenReason({ minimized: { reason: '<b>x</b>' } }), 'hidden');
  assert.strictEqual(hiddenReason({ minimized: true }), 'hidden');
});

test('references are read from the anchors GitHub rendered', () => {
  const link = (href, text, cls) => '<a' + (cls ? ' class="issue-link js-issue-link"' : '') + ' href="' + href + '">' + text + '</a>';
  const html = '<p>Closes ' + link('https://github.com/draykerdk/dfmp/issues/3', '#3', true)
    + ', fixes ' + link('https://github.com/draykerdk/dk/issues/2', 'draykerdk/dk#2', true)
    + ' and ' + link('https://github.com/DraykerDK/uid/pull/7#issuecomment-1', 'a pull request')
    + '. Also ' + link('https://github.com/other/x/issues/9', 'other/x#9', true)
    + ', ' + link('https://github.com/draykerdk/dfmp/issues/3', '#3 again', true) + '.</p>'
    // None of these are references: GitHub renders no link for them.
    + '<pre><code>    #7 in indented code</code></pre><code>#8</code><pre>#9</pre><p><code>``code #13 ``</code> '
    + link('#11', 'see') + ' ' + link('https://example.com/page#12', 'x') + ' ' + link('https://github.com/draykerdk/dk/issues', 'list')
    + ' ' + link('https://github.com/draykerdk/dk/issues/5?x=1', 'query') + '</p>';
  assert.deepStrictEqual(findReferences(html), [{ repo: 'dfmp', num: 3 }, { repo: 'dk', num: 2 }, { repo: 'uid', num: 7 }]);
  assert.deepStrictEqual(findReferences('Closes #3 and draykerdk/dk#2 in plain text'), []);
  assert.deepStrictEqual(findReferences(''), []);
  assert.deepStrictEqual(findReferences(null), []);
});

test('fixture trimming keeps the fields the builder reads', () => {
  const [repo] = trimForFixture([{ name: 'x', full_name: 'draykerdk/x', has_issues: true, default_branch: 'main', owner: { login: 'draykerdk' } }]);
  assert.deepStrictEqual(repo, { name: 'x', has_issues: true, default_branch: 'main' });
  const [pr] = trimForFixture([{ number: 4, state: 'closed', merged_at: '2026-01-01T00:00:00Z', base: { ref: 'main', sha: 'abc' }, head: { ref: 'f' }, title: 't', body: 'b' }]);
  assert.deepStrictEqual(pr, { number: 4, state: 'closed', merged_at: '2026-01-01T00:00:00Z', base: { ref: 'main' } });
  const [item] = trimForFixture([{ number: 1, state: 'open', title: 't', locked: true, active_lock_reason: 'resolved', author_association: 'OWNER', user: { login: 'a', id: 1, type: 'User' } }]);
  assert.deepStrictEqual(item, { number: 1, title: 't', state: 'open', locked: true, active_lock_reason: 'resolved', user: { login: 'a', id: 1 }, labels: [] });
  const [hidden, shown] = trimForFixture([
    { id: 9, issue_url: 'u', html_url: 'h', created_at: 'c', updated_at: 'u', minimized: { reason: 'spam' }, body: 'b', body_html: '<p>b</p>', body_text: 'b', reactions: {}, author_association: 'NONE', user: { login: 'a', id: 1, type: 'User' } },
    { id: 10, issue_url: 'u', minimized: null, user: null }
  ]);
  // A comment keeps its author's type: the tally comment is recognised by it.
  assert.deepStrictEqual(hidden, { id: 9, issue_url: 'u', html_url: 'h', created_at: 'c', updated_at: 'u', minimized: { reason: 'spam' }, body: 'b', body_html: '<p>b</p>', user: { login: 'a', id: 1, type: 'User' } });
  assert.deepStrictEqual(shown, { id: 10, issue_url: 'u', minimized: null, user: null });
});

// ---------------------------------------------------------------- GitHub client

test('GitHub client retries, paginates, records without secrets and replays', async () => {
  const dir = path.join(tmp, 'record');
  const calls = [];
  const responses = [
    { status: 502, headers: {}, body: { message: 'bad gateway' } },
    { status: 403, headers: { 'retry-after': '1' }, body: { message: 'You have exceeded a secondary rate limit' } },
    { status: 200, headers: { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"' }, body: [1, 2] },
    { status: 200, headers: {}, body: [3] }
  ];
  const fakeFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, accept: init.headers.Accept });
    const r = responses.shift();
    return {
      ok: r.status < 300, status: r.status, statusText: '',
      headers: { get: (k) => r.headers[k.toLowerCase()] || null },
      json: async () => r.body, text: async () => JSON.stringify(r.body)
    };
  };
  const waits = [];
  const gh = createClient({ token: 'secret-token-value', record: dir, fetch: fakeFetch, sleep: async (ms) => waits.push(ms), log: () => {} });
  const items = await gh.paginate('/x');
  assert.deepStrictEqual(items, [1, 2, 3]);
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(waits, [1000, 1000]);
  assert.strictEqual(calls[0].accept, 'application/vnd.github.full+json');
  assert.strictEqual(calls[0].auth, 'Bearer secret-token-value');
  const saved = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(!saved.includes('secret-token-value') && !/authorization|bearer/i.test(saved), 'recording leaked a credential');
  assert.ok(fs.existsSync(path.join(dir, fixtureName('https://api.github.com/x?page=2'))));
  const replay = createClient({ fixture: dir, fetch: () => { throw new Error('network used during replay'); } });
  assert.deepStrictEqual(await replay.paginate('/x'), [1, 2, 3]);
  await assert.rejects(replay.get('/missing'), /No fixture response/);

  const failing = createClient({ fetch: async () => ({ ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, json: async () => ({}), text: async () => '{"message":"Not Found"}' }), sleep: async () => {}, log: () => {} });
  await assert.rejects(failing.get('/repos/draykerdk/none'), /HTTP 404 .*Not Found/);
  let attempts = 0;
  const down = createClient({ fetch: async () => { attempts++; return { ok: false, status: 503, statusText: '', headers: { get: () => null }, json: async () => ({}), text: async () => '' }; }, sleep: async () => {}, log: () => {} });
  await assert.rejects(down.get('/x'), /HTTP 503/);
  assert.strictEqual(attempts, 5);
});

test('the GitHub token is sent to api.github.com only', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return { ok: true, status: 200, headers: { get: (k) => (k === 'link' && url.endsWith('/list') ? '<https://example.com/steal?page=2>; rel="next"' : null) }, json: async () => [1], text: async () => '[1]' };
  };
  const gh = createClient({ token: 'secret-token-value', fetch: fakeFetch, sleep: async () => {}, log: () => {} });
  await gh.get('/repos/draykerdk/daf/issues');
  await gh.get('https://api.github.com/repos/draykerdk/daf');
  assert.deepStrictEqual(calls.map((c) => c.auth), ['Bearer secret-token-value', 'Bearer secret-token-value']);
  for (const url of ['https://example.com/x', 'https://api.github.com.example.com/x', 'https://api.github.com:8443/x', 'https://user@api.github.com/x', 'https://uploads.github.com/x', 'https://github.com/draykerdk']) {
    calls.length = 0;
    await assert.rejects(gh.get(url), /Refusing to send the GitHub token/, url);
    assert.strictEqual(calls.length, 0, 'no request made to ' + url);
  }
  // A Link header naming another host stops the pagination before any request there.
  calls.length = 0;
  await assert.rejects(gh.paginate('/list'), /Refusing to send the GitHub token/);
  assert.deepStrictEqual(calls.map((c) => c.url), ['https://api.github.com/list']);
  // Without a token, nothing secret is at stake: the request is made, unauthenticated.
  calls.length = 0;
  const open = createClient({ fetch: fakeFetch, sleep: async () => {}, log: () => {} });
  await open.get('https://example.com/x');
  assert.deepStrictEqual(calls, [{ url: 'https://example.com/x', auth: undefined }]);
  assert.ok(isApiUrl('https://api.github.com/x') && !isApiUrl('http://api.github.com/x') && !isApiUrl('not a url'));
});

// ---------------------------------------------------------------- votes

test('votes are read with DAF\'s parser, copied unchanged', () => {
  // The regular expressions of draykerdk/daf tools/lib/tally.js at 5f62b6b, byte for byte.
  assert.strictEqual(vote.VOTE_RE.toString(), '/^\\s*VOTE:\\s*(for|against|abstain)\\s*$/im');
  assert.strictEqual(vote.AS_RE.toString(), '/^\\s*AS:\\s*`?([a-z0-9-]+)`?\\s*$/im');
  // index.html carries the same two for the live layer.
  const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(page.includes('const VOTE_RE = ' + vote.VOTE_RE.toString() + ';'), 'index.html VOTE_RE differs');
  assert.ok(page.includes('const AS_RE = ' + vote.AS_RE.toString() + ';'), 'index.html AS_RE differs');
  assert.ok(page.includes('const ASSEMBLY_TITLE = ' + vote.ASSEMBLY_TITLE.toString() + ';'), 'index.html ASSEMBLY_TITLE differs');
  assert.ok(page.includes('const TALLY_MARKER = ' + vote.TALLY_MARKER.toString() + ';'), 'index.html TALLY_MARKER differs');
  // The tally comment is the bot's, as in daf tools/lib/sticky.js isOurs; the live layer uses the same rule.
  assert.ok(page.includes("const TALLY_BOT = '" + vote.TALLY_BOT + "';") && page.includes('const isTallyComment = ' + vote.isTallyComment.toString() + ';'), 'index.html tally rule differs');
  const tally = '<!-- daf-tally:v1 -->\n## Tally';
  assert.strictEqual(vote.isTallyComment({ body: tally, user: { login: 'github-actions[bot]', type: 'Bot' } }), true);
  assert.strictEqual(vote.isTallyComment({ body: tally, user: { login: 'example-cedar-gh', type: 'User' } }), false, 'a person\'s comment that starts with the marker');
  assert.strictEqual(vote.isTallyComment({ body: tally, user: { login: 'github-actions[bot]', type: 'User' } }), false, 'the login alone is not enough');
  assert.strictEqual(vote.isTallyComment({ body: 'Before\n' + tally, user: { login: 'github-actions[bot]', type: 'Bot' } }), false, 'the marker starts the body');
  assert.strictEqual(vote.isTallyComment({ body: tally, user: null }), false);
  // DAF's own examples (tools/test/helpers.js and tally.test.js).
  assert.deepStrictEqual(vote.readVote('Discussion first.\n\nVOTE: for\nAS: `example-delta`\n'), { vote: 'for', holder: 'example-delta' });
  assert.deepStrictEqual(vote.readVote('VOTE: For\nAS: Example-Delta'), { vote: 'for', holder: 'example-delta' });
  assert.strictEqual(vote.readVote('I would vote for this, but this is discussion.'), null);
  assert.deepStrictEqual(vote.voteOf('VOTE: abstain\nAS: example-cedar'), { vote: 'abstain', as: 'example-cedar' });
  assert.strictEqual(vote.voteOf('VOTE: maybe\nAS: example-cedar'), null);
  assert.strictEqual(vote.voteOf('VOTE: for'), null, 'a vote names its holder');
  assert.strictEqual(vote.voteOf(null), null);
  for (const t of ['Assembly 2026-11', 'Assembly 2027-01']) assert.ok(vote.ASSEMBLY_TITLE.test(t), t);
  for (const t of ['Assembly 2026-13', 'Assembly 2026-00', 'assembly 2026-11', 'Assembly 2026-11 report', '[Cycle] Assembly 2026-11', ' Assembly 2026-11']) assert.ok(!vote.ASSEMBLY_TITLE.test(t), t);
});

test('static and app wording of assembly reports match, and mirrored content cannot forge the markers', () => {
  const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(page.includes('<p>' + ASSEMBLY_NOTICE + '</p>'), 'index.html open assembly notice differs from tools/prerender.js');
  assert.ok(page.includes('<p>' + ASSEMBLY_MERGED_NOTICE + '</p>'), 'index.html merged assembly notice differs from tools/prerender.js');
  assert.ok(ASSEMBLY_NOTICE.endsWith(' A vote line counts only if its author speaks for the holder it names and it falls inside the voting window; the Federation tally checks this on GitHub.'));
  assert.ok(page.includes("voteText: vote ? 'Vote line: ' + String(vote.vote) + ' · names ' + String(vote.as) : ''"), 'index.html vote tag differs');
  assert.strictEqual(voteText({ vote: 'against', as: 'example-cedar' }), 'Vote line: against · names example-cedar');
  // The sanitizer drops the vote tag class and the notice markup from mirrored
  // content, so ownMarkers (tools/forum-check.js) never counts them.
  const forged = sanitizeHtml('<p class="fs-meta fs-vote">Vote line: for · names x</p><section aria-label="Assembly report"><p>n</p></section><p class="fs-vote ugc pl-k">y</p>', {});
  assert.ok(!/fs-vote|fs-meta|aria-label|<section|ugc"/.test(forged), forged);
  assert.deepStrictEqual(ownMarkers(forged), { votes: [], notices: 0 });
  assert.deepStrictEqual(ownMarkers('<div class="fs-body ugc">' + forged + '</div>'), { votes: [], notices: 0 });
});

test('assembly reports become threads in daf only, and votes are only tagged', () => {
  const R = 'https://github.com/draykerdk/';
  const repo = (name) => ({ name, default_branch: 'master', html_url: R + name, description: null, homepage: null });
  const pr = (name, n, title, state, merged) => ({
    number: n, title, html_url: R + name + '/pull/' + n, state, state_reason: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z',
    closed_at: state === 'open' ? null : '2026-11-03T00:00:00Z', comments: 0, locked: false, body: 'Report', body_html: '<p>Report</p>',
    user: { login: 'steward', id: 1 }, labels: [], pull_request: { html_url: R + name + '/pull/' + n, merged_at: merged || null }
  });
  const comment = (name, n, id, body, extra) => Object.assign({ id, issue_url: 'https://api.github.com/repos/draykerdk/' + name + '/issues/' + n,
    html_url: R + name + '/pull/' + n + '#issuecomment-' + id, created_at: '2026-11-01T0' + (id % 10) + ':00:00Z', updated_at: '2026-11-01T0' + (id % 10) + ':00:00Z',
    minimized: null, body, body_html: '<p>' + body.replace(/\n/g, '<br>') + '</p>', user: { login: 'voter', id: 2 } }, extra || {});
  const issue = { number: 1, title: '[Claim] Something', html_url: R + 'daf/issues/1', state: 'open', state_reason: null, created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z', closed_at: null, comments: 1, locked: false, body: '', body_html: '', user: { login: 'a', id: 3 }, labels: [{ name: 'claim' }] };
  const org = [
    { repo: repo('daf'), items: [issue, pr('daf', 2, 'Assembly 2026-11', 'open'), pr('daf', 3, 'Assembly 2026-10', 'closed', '2026-10-09T00:00:00Z'),
      pr('daf', 4, 'Assembly 2026-09', 'closed', '2026-09-09T00:00:00Z'), pr('daf', 5, 'Assembly 2026-08', 'closed'), pr('daf', 6, 'Assembly 2026-13', 'open'),
      pr('daf', 7, 'Fix a typo', 'open')],
    comments: [
      comment('daf', 1, 11, 'VOTE: for\nAS: example-river'),
      comment('daf', 2, 21, 'VOTE: for\nAS: `example-river`'),
      comment('daf', 2, 22, 'VOTE: against\nAS: hidden-holder', { minimized: { reason: 'spam' } }),
      comment('daf', 2, 23, '<!-- daf-tally:v1 -->\n## Tally\n\nfor: 4 points', { user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' } }),
      comment('daf', 2, 24, 'Just discussion.'),
      // A person's comment that starts with the marker is not the tally.
      comment('daf', 2, 25, '<!-- daf-tally:v1 -->\nVOTE: for\nAS: example-cedar', { user: { login: 'cedar', id: 5, type: 'User' } }),
      // A vote line by an account that is not the holder's speaker is tagged
      // with what it names: whether it counts is for the Federation tally.
      comment('daf', 2, 26, 'VOTE: against\nAS: example-cedar', { user: { login: 'mallory', id: 6, type: 'User' } })
    ],
    pulls: [{ number: 3, state: 'closed', merged_at: '2026-10-09T00:00:00Z', base: { ref: 'master' } }, { number: 4, state: 'closed', merged_at: '2026-09-09T00:00:00Z', base: { ref: 'side' } }] },
    { repo: repo('dk'), items: [pr('dk', 8, 'Assembly 2026-11', 'open')], comments: [], pulls: null }
  ];
  const { forum, threadFiles } = buildSnapshot(org, '2026-11-05T00:00:00Z');
  assert.strictEqual(forum.schema, 3);
  assert.deepStrictEqual(forum.threads.map((t) => t.repo + '#' + t.num + ':' + t.kind).sort(), ['daf#1:issue', 'daf#2:pr', 'daf#3:pr']);
  const open = forum.threads.find((t) => t.num === 2);
  assert.strictEqual(open.url, R + 'daf/pull/2');
  // A merged assembly report is a thread and stays a decision; a merge into a side branch is neither.
  assert.deepStrictEqual(forum.decisions.map((d) => d.num), [3]);
  // Assembly reports are threads: they count in threads and open; decisions are unchanged.
  assert.deepStrictEqual([forum.counts.threads, forum.counts.open, forum.counts.decisions, forum.counts.comments], [3, 2, 1, 7]);
  // merged: the merge time of a merged report, null for an open one and for an issue.
  assert.deepStrictEqual(forum.threads.map((t) => [t.num, t.merged]).sort((a, b) => a[0] - b[0]), [[1, null], [2, null], [3, '2026-10-09T00:00:00Z']]);
  assert.deepStrictEqual([forum.repos[0].threads, forum.repos[0].open], [3, 2]);
  const file = threadFiles.find((f) => f.path === 't/daf/2.json').data;
  assert.strictEqual(file.kind, 'pr');
  const byId = new Map(file.comments.map((c) => [c.id, c]));
  assert.deepStrictEqual(byId.get(21).vote, { vote: 'for', as: 'example-river' });
  assert.deepStrictEqual([byId.get(22).hidden, byId.get(22).html, byId.get(22).vote], ['spam', '', null], 'a hidden vote is not read');
  assert.deepStrictEqual([byId.get(23).html, byId.get(23).vote], ['', null], 'the federation\'s tally comment is never published');
  assert.strictEqual(byId.get(24).vote, null);
  assert.deepStrictEqual([byId.get(25).html !== '', byId.get(25).vote], [true, { vote: 'for', as: 'example-cedar' }], 'a person\'s comment with the marker is shown and its vote line read');
  assert.deepStrictEqual(byId.get(26).vote, { vote: 'against', as: 'example-cedar' });
  assert.strictEqual(threadFiles.find((f) => f.path === 't/daf/3.json').data.merged, '2026-10-09T00:00:00Z');
  assert.strictEqual(threadFiles.find((f) => f.path === 't/daf/1.json').data.comments[0].vote, null, 'votes are read on assembly reports only');
  const all = JSON.stringify(forum) + threadFiles.map((f) => JSON.stringify(f.data)).join('');
  assert.ok(!all.includes('hidden-holder') && !all.includes('4 points'), 'hidden or tally content published');
});

// ---------------------------------------------------------------- snapshot contract

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const THREAD_KEYS = ['repo', 'slug', 'num', 'kind', 'title', 'url', 'user', 'user_id', 'labels', 'state', 'state_reason', 'open', 'locked', 'lock_reason', 'created', 'at', 'closed', 'merged', 'comments', 'last_user', 'last_at', 'participants', 'excerpt', 'text', 'refs'];
const REF_KEYS = ['repo', 'slug', 'num', 'kind', 'title', 'url', 'merged', 'state'];
const DECISION_KEYS = ['repo', 'slug', 'num', 'title', 'url', 'user', 'merged', 'excerpt', 'text', 'threads'];
const COMMENT_KEYS = ['id', 'user', 'user_id', 'created', 'updated', 'hidden', 'html', 'url', 'vote'];
const COUNT_KEYS = ['repos', 'threads', 'open', 'closed', 'unanswered', 'comments', 'decisions'];

function validateSnapshot(dataDir) {
  const forum = readJson(path.join(dataDir, 'forum.json'));
  const meta = readJson(path.join(dataDir, 'meta.json'));
  assert.strictEqual(forum.schema, 3);
  assert.strictEqual(SCHEMA, 3);
  assert.strictEqual(forum.org, 'draykerdk');
  assert.ok(ISO.test(forum.generated_at));
  assert.deepStrictEqual(Object.keys(forum), ['schema', 'generated_at', 'org', 'repos', 'threads', 'decisions', 'counts']);

  assert.ok(forum.repos.length > 0);
  const repoNames = forum.repos.map((r) => r.name);
  const sortedNames = repoNames.slice().sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  assert.deepStrictEqual(repoNames, sortedNames, 'repos sorted by name');
  const repoByName = new Map();
  for (const repo of forum.repos) {
    assert.deepStrictEqual(Object.keys(repo), ['name', 'slug', 'description', 'homepage', 'url', 'threads', 'open']);
    assert.strictEqual(repo.slug, repo.name === '.github' ? 'dot-github' : repo.name);
    assert.ok(/^[A-Za-z0-9._-]+$/.test(repo.slug) && !repo.slug.startsWith('.'), 'slug is URL-safe: ' + repo.slug);
    assert.strictEqual(repo.url, 'https://github.com/draykerdk/' + repo.name);
    repoByName.set(repo.name, repo);
  }

  const threadKeys = new Set();
  for (let i = 0; i < forum.threads.length; i++) {
    const t = forum.threads[i];
    const where = t.repo + '#' + t.num;
    assert.deepStrictEqual(Object.keys(t), THREAD_KEYS, 'thread keys for ' + where);
    assert.ok(repoByName.has(t.repo), 'thread repo exists: ' + where);
    assert.strictEqual(t.slug, repoByName.get(t.repo).slug);
    // Issues, and the federation's assembly reports (pull requests in daf).
    assert.ok(t.kind === 'issue' || t.kind === 'pr', 'thread kind: ' + where);
    assert.strictEqual(t.url, 'https://github.com/draykerdk/' + t.repo + (t.kind === 'pr' ? '/pull/' : '/issues/') + t.num);
    if (t.kind === 'pr') assert.ok(t.repo === 'daf' && vote.ASSEMBLY_TITLE.test(t.title), 'only assembly reports are pull request threads: ' + where);
    assert.ok(Number.isInteger(t.num) && t.num > 0);
    assert.ok(typeof t.title === 'string' && typeof t.user === 'string');
    assert.ok(t.labels.every((l) => l === l.toLowerCase()), 'labels lowercased: ' + where);
    assert.ok(t.state === 'open' || t.state === 'closed');
    assert.strictEqual(t.open, t.state === 'open');
    assert.strictEqual(typeof t.locked, 'boolean', 'locked is a boolean: ' + where);
    assert.ok(t.lock_reason === null || (t.locked && typeof t.lock_reason === 'string'), 'lock_reason only on locked threads: ' + where);
    assert.ok(t.state_reason === null || ['completed', 'not_planned', 'reopened', 'duplicate'].includes(t.state_reason), 'state_reason: ' + t.state_reason);
    assert.ok(ISO.test(t.created) && ISO.test(t.at));
    assert.ok(t.open ? t.closed === null || ISO.test(t.closed) : ISO.test(t.closed));
    // merged: null on issues and open reports; the merge time on a merged report
    // (a closed report is in the snapshot only when it was merged).
    assert.ok(t.kind === 'pr' && !t.open ? ISO.test(t.merged) : t.merged === null, 'merged for ' + where + ': ' + t.merged);
    assert.ok(t.excerpt.length <= 280 && t.text.length <= 2000);
    assert.ok(!/\s{2}/.test(t.excerpt) && !/\s{2}/.test(t.text), 'whitespace collapsed: ' + where);
    assert.ok(t.text.startsWith(t.excerpt.replace(/…$/, '')), 'excerpt is a prefix of text: ' + where);
    assert.strictEqual(t.participants[0], t.user);
    assert.ok(t.participants.length <= 12 && new Set(t.participants).size === t.participants.length);
    if (i > 0) {
      const p = forum.threads[i - 1];
      assert.ok(p.at > t.at || (p.at === t.at && (p.repo < t.repo || (p.repo === t.repo && p.num > t.num))), 'threads sorted by at desc at ' + where);
    }
    const key = t.repo + '#' + t.num;
    assert.ok(!threadKeys.has(key), 'duplicate thread ' + key);
    threadKeys.add(key);

    const file = path.join(dataDir, 't', t.slug, t.num + '.json');
    assert.ok(fs.existsSync(file), 'thread file exists: ' + file);
    const detail = readJson(file);
    const expectedKeys = THREAD_KEYS.filter((k) => k !== 'excerpt' && k !== 'text' && k !== 'comments').concat(['html', 'comments']);
    assert.deepStrictEqual(Object.keys(detail), expectedKeys, 'thread file keys for ' + where);
    for (const k of THREAD_KEYS) if (k !== 'excerpt' && k !== 'text' && k !== 'comments') assert.deepStrictEqual(detail[k], t[k], k + ' matches for ' + where);
    assert.strictEqual(detail.comments.length, t.comments, 'comment count for ' + where);
    assertSafe(detail.html, where);
    let previous = '';
    for (const c of detail.comments) {
      assert.deepStrictEqual(Object.keys(c), COMMENT_KEYS);
      assert.ok(c.created >= previous, 'comments oldest first in ' + where);
      previous = c.created;
      assert.ok(c.url.startsWith(t.url + '#issuecomment-'));
      assert.ok(c.hidden === null || (/^[a-z][a-z-]*$/.test(c.hidden) && c.html === ''), 'a hidden comment has a reason and no content: ' + where + ' comment ' + c.id);
      // A vote is { vote, as }, read on assembly reports only, never from hidden content.
      assert.ok(c.vote === null || (t.kind === 'pr' && c.hidden === null && JSON.stringify(Object.keys(c.vote)) === '["vote","as"]'
        && ['for', 'against', 'abstain'].includes(c.vote.vote) && /^[a-z0-9-]+$/.test(c.vote.as)), 'vote on ' + where + ' comment ' + c.id);
      assertSafe(c.html, where + ' comment ' + c.id);
    }
    const last = detail.comments[detail.comments.length - 1];
    assert.strictEqual(t.last_user, last ? last.user : null);
    assert.strictEqual(t.last_at, last ? last.created : null);
    for (const c of detail.comments) if (t.participants.length < 12) assert.ok(t.participants.includes(c.user));
  }

  const decisionKeys = new Set(forum.decisions.map((d) => d.repo + '#' + d.num));
  for (const t of forum.threads) {
    const seen = new Set();
    for (const ref of t.refs) {
      assert.deepStrictEqual(Object.keys(ref), REF_KEYS);
      const key = ref.repo + '#' + ref.num;
      assert.ok(!seen.has(key), 'refs deduplicated in ' + t.repo + '#' + t.num);
      seen.add(key);
      assert.ok(key !== t.repo + '#' + t.num, 'no self reference');
      assert.ok(repoByName.has(ref.repo) && repoByName.get(ref.repo).slug === ref.slug);
      assert.ok(ref.kind === 'pr' || ref.kind === 'issue');
      assert.strictEqual(ref.url, 'https://github.com/draykerdk/' + ref.repo + (ref.kind === 'pr' ? '/pull/' : '/issues/') + ref.num);
      if (ref.kind === 'issue') assert.ok(threadKeys.has(key), 'issue ref points to a thread: ' + key);
      // A merged pull request is a decision only when it went into the default branch.
      if (ref.kind === 'pr' && ref.merged) assert.ok(ISO.test(ref.merged), 'merged PR ref has a merge time: ' + key);
      if (ref.kind === 'pr' && decisionKeys.has(key)) assert.ok(ref.merged, 'decision ref is merged: ' + key);
      if (ref.kind === 'issue') assert.strictEqual(ref.merged, null);
    }
  }

  for (let i = 0; i < forum.decisions.length; i++) {
    const d = forum.decisions[i];
    assert.deepStrictEqual(Object.keys(d), DECISION_KEYS);
    assert.ok(ISO.test(d.merged));
    assert.strictEqual(d.url, 'https://github.com/draykerdk/' + d.repo + '/pull/' + d.num);
    assert.ok(d.excerpt.length <= 280 && d.text.length <= 2000);
    assert.ok(!/\s{2}/.test(d.excerpt) && !/\s{2}/.test(d.text), 'whitespace collapsed: ' + d.repo + '#' + d.num);
    assert.ok(d.text.startsWith(d.excerpt.replace(/…$/, '')), 'excerpt is a prefix of text: ' + d.repo + '#' + d.num);
    for (const ref of d.threads) {
      assert.deepStrictEqual(Object.keys(ref), ['repo', 'slug', 'num']);
      assert.ok(threadKeys.has(ref.repo + '#' + ref.num), 'decision thread exists: ' + ref.repo + '#' + ref.num);
    }
    if (i > 0) assert.ok(forum.decisions[i - 1].merged >= d.merged, 'decisions sorted by merged desc');
  }

  const c = forum.counts;
  assert.deepStrictEqual(Object.keys(c), COUNT_KEYS);
  assert.strictEqual(c.repos, forum.repos.length);
  assert.strictEqual(c.threads, forum.threads.length);
  assert.strictEqual(c.open, forum.threads.filter((t) => t.open).length);
  assert.strictEqual(c.closed, c.threads - c.open);
  assert.strictEqual(c.unanswered, forum.threads.filter((t) => t.open && t.comments === 0).length);
  assert.strictEqual(c.comments, forum.threads.reduce((s, t) => s + t.comments, 0));
  assert.strictEqual(c.decisions, forum.decisions.length);
  assert.strictEqual(forum.repos.reduce((s, r) => s + r.threads, 0), c.threads);
  assert.strictEqual(forum.repos.reduce((s, r) => s + r.open, 0), c.open);

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(path.join(dataDir, 't'));
  assert.strictEqual(files.length, c.threads, 'one file per thread, no stale files');

  assert.deepStrictEqual(Object.keys(meta), ['generated_at', 'content_hash', 'site_rev', 'counts']);
  assert.strictEqual(meta.generated_at, forum.generated_at);
  assert.ok(/^[0-9a-f]{64}$/.test(meta.content_hash));
  assert.ok(typeof meta.site_rev === 'string' && meta.site_rev.length > 0);
  assert.deepStrictEqual(meta.counts, c);
  const hash = crypto.createHash('sha256');
  const stable = Object.assign({}, forum);
  delete stable.generated_at;
  hash.update('forum.json\n' + JSON.stringify(stable) + '\n');
  for (const t of forum.threads.map((x) => 't/' + x.slug + '/' + x.num + '.json').sort()) {
    hash.update(t + '\n' + JSON.stringify(readJson(path.join(dataDir, t))) + '\n');
  }
  assert.strictEqual(hash.digest('hex'), meta.content_hash, 'content_hash matches the files');
  return { forum, meta };
}

test('recorded fixture builds a valid, stable snapshot', () => {
  const fixture = path.join(ROOT, 'test/fixtures/github');
  const a = validateSnapshot(path.join(buildOk(fixture, path.join(tmp, 'a')), 'data'));
  const b = validateSnapshot(path.join(buildOk(fixture, path.join(tmp, 'b')), 'data'));
  assert.strictEqual(a.meta.content_hash, b.meta.content_hash, 'content_hash stable across builds');
  assert.ok(a.forum.repos.some((r) => r.name === '.github' && r.slug === 'dot-github'), '.github maps to dot-github');
  assert.ok(a.forum.threads.length > 0 && a.forum.decisions.length > 0);
  assert.ok(a.forum.threads.some((t) => t.refs.length > 0), 'some thread has back-links');
  assert.ok(a.forum.decisions.some((d) => d.threads.length > 0), 'some decision points to a thread');
  const forumText = fs.readFileSync(path.join(tmp, 'a/data/forum.json'), 'utf8');
  assert.ok(!/author_association|"MEMBER"|"OWNER"|"CONTRIBUTOR"/.test(forumText), 'author_association is never emitted');

  // The synthetic federation threads (test/fixtures/make-daf-federation-fixture.js).
  const byKey = new Map(a.forum.threads.map((t) => [t.repo + '#' + t.num, t]));
  assert.deepStrictEqual(['daf#9001', 'daf#9002', 'daf#9003', 'daf#9004', 'daf#9005'].map((k) => byKey.has(k) && byKey.get(k).kind), ['issue', 'issue', 'pr', 'pr', 'issue']);
  assert.deepStrictEqual([byKey.get('daf#9003').merged, byKey.get('daf#9004').merged], [null, '2026-10-08T04:30:00Z']);
  assert.ok(a.forum.decisions.some((d) => d.repo === 'daf' && d.num === 9004), 'a merged assembly report is also a decision');
  assert.ok(!byKey.get('daf#9004').open && byKey.get('daf#9004').url === 'https://github.com/draykerdk/daf/pull/9004');
  const report = byKey.get('daf#9003');
  assert.deepStrictEqual([report.url, report.open, report.comments], ['https://github.com/draykerdk/daf/pull/9003', true, 3]);
  assert.ok(!a.forum.decisions.some((d) => d.repo === 'daf' && d.num === 9003), 'an open assembly report is not a decision');
  assert.ok(a.forum.threads.filter((t) => t.kind === 'pr').every((t) => t.repo === 'daf'));
  assert.ok(byKey.get('daf#9002').refs.some((r) => r.kind === 'pr' && r.num === 9003), 'the cycle issue links back to its report');
  const detail = readJson(path.join(tmp, 'a/data/t/daf/9003.json'));
  assert.deepStrictEqual(detail.comments.map((c) => [c.hidden, c.vote]), [[null, { vote: 'for', as: 'example-river' }], [null, null], ['off-topic', null]]);

  // Built site from the recorded fixture: the static page of the report, and the
  // hidden vote in no file at all.
  const pre = runTool('prerender.js', ['--out', path.join(tmp, 'a')]);
  assert.strictEqual(pre.status, 0, 'prerender failed: ' + pre.stderr);
  const page = fs.readFileSync(path.join(tmp, 'a/t/daf/9003/index.html'), 'utf8');
  const staticOf = (html) => html.slice(html.indexOf('<!-- FORUM_STATIC_START -->'), html.indexOf('<!-- FORUM_STATIC_END -->'));
  const region = staticOf(page);
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  assert.ok(region.includes('<p>' + esc(ASSEMBLY_NOTICE) + '</p>') && !region.includes(esc(ASSEMBLY_MERGED_NOTICE)), 'open assembly notice');
  assert.ok(region.includes('<a href="https://github.com/draykerdk/daf/pull/9003">The pull request on GitHub</a>') && region.includes('<a href="' + TALLY_WORKFLOW + '">The Federation tally workflow</a>'));
  assert.ok(region.indexOf('aria-label="Assembly report"') < region.indexOf('aria-label="Replies"'), 'the notice is above the replies');
  // The tag names what the vote line names; it does not say the vote is the holder's.
  assert.strictEqual(voteTag({ vote: 'for', as: 'example-river' }), '<p class="fs-meta fs-vote">Vote line: for · names <span class="ugc">example-river</span></p>');
  assert.ok(region.includes(voteTag({ vote: 'for', as: 'example-river' })), 'vote tag');
  assert.strictEqual((region.match(/Vote line: /g) || []).length, 1, 'one tag, for the one visible vote');
  assert.deepStrictEqual(ownMarkers(region).votes, [{ comment: 900300001, text: 'Vote line: for · names example-river' }]);
  // A merged report: the merged notice, and "Merged", never "closed".
  const merged = staticOf(fs.readFileSync(path.join(tmp, 'a/t/daf/9004/index.html'), 'utf8'));
  assert.ok(merged.includes('<section aria-label="Assembly report"><p>' + esc(ASSEMBLY_MERGED_NOTICE) + '</p>') && !merged.includes(esc(ASSEMBLY_NOTICE)), 'merged assembly notice');
  assert.ok(merged.includes('<span class="fs-state">merged 8 Oct 2026</span>') && !merged.includes('<span class="fs-state">closed'), 'merged state label');
  assert.ok(staticOf(fs.readFileSync(path.join(tmp, 'a/index.html'), 'utf8')).includes('daf #9004 · <span class="fs-state">merged 8 Oct 2026</span>'), 'merged state in the list');
  // The cycle issue links back to the report's forum page, not to GitHub.
  const cycle = staticOf(fs.readFileSync(path.join(tmp, 'a/t/daf/9002/index.html'), 'utf8'));
  assert.ok(cycle.includes('<a class="ugc" href="/t/daf/9003/">Assembly 2026-11</a><p class="fs-meta">Pull request daf #9003 · open</p>'), 'back-link to the report page');
  assert.ok(region.includes('<p class="fs-meta">Hidden on GitHub (off-topic)</p><p class="fs-meta">' + esc(HIDDEN_VOTE_NOTE) + '</p>'));
  assert.ok(!region.includes(esc(WITHHELD_NOTE)));
  for (const file of [path.join(tmp, 'a/t/daf/9002/index.html'), path.join(tmp, 'a/t/daf/9001/index.html'), path.join(tmp, 'a/t/daf/9005/index.html')]) {
    assert.ok(!staticOf(fs.readFileSync(file, 'utf8')).includes('aria-label="Assembly report"'), 'no assembly notice on an issue');
  }
  const everything = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else everything.push(full);
    }
  };
  walk(path.join(tmp, 'a'));
  for (const file of everything) {
    const text = fs.readFileSync(file);
    assert.ok(!text.includes('hidden-holder-4c1e') && !text.includes('HIDDENVOTE-4c1e'), 'hidden vote published in ' + path.relative(tmp, file));
  }
});

test('synthetic attack fixture is neutralised end to end', () => {
  const data = path.join(buildOk(path.join(ROOT, 'test/fixtures/xss'), path.join(tmp, 'xss')), 'data');
  const { forum } = validateSnapshot(data);
  const detail = readJson(path.join(data, 't/xss-lab/1.json'));
  const all = [detail.html].concat(detail.comments.map((c) => c.html)).join('\n');
  assertSafe(all, 'xss fixture');
  assert.ok(!/svgtext|iframetext|mathtext|formtext|buttontext|alert\(9\)|alert\(14\)/.test(all), 'dropped content survived');
  assert.ok(all.includes('<a href="/t/xss-lab/1/#issuecomment-2" class="issue-link" rel="nofollow ugc noopener noreferrer">#1</a>'), 'issue link rewritten');
  assert.ok(all.includes('href="https://github.com/draykerdk/xss-lab/issues/99"'), 'unknown issue link kept');
  assert.ok(all.includes('<img src="https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666" alt="shot"'), 'private image rewritten');
  assert.ok(!all.includes('jwt='), 'expiring token removed');
  assert.ok(all.includes('<p class="pl-k task-list-item">styled</p>'), 'style, on*, id, data-*, aria-* removed and classes filtered');
  assert.ok(all.includes('<p><b>unclosed bold <i>and italic</i></b></p>'), 'unclosed tags closed');
  assert.strictEqual((detail.comments[1].html.match(/<div>/g) || []).length, 32, 'depth limited to 32');
  assert.ok(detail.comments[1].html.includes('<h3>Heading one</h3><h5>Heading four</h5>'), 'headings remapped');
  assert.ok(!all.includes('example.com/plain.png') && !all.includes('data:image'), 'non-https images dropped');
  assert.ok(all.includes('<a href="https://github.com/draykerdk/a%E9/issues/1" rel="nofollow ugc noopener noreferrer">bad escape</a>'), 'malformed escape kept as a GitHub link, build not aborted');
  const thread = forum.threads[0];
  assert.deepStrictEqual(thread.labels, ['proposal']);
  assert.deepStrictEqual(thread.participants, ['tester', 'replier']);
  assert.strictEqual(thread.last_user, 'tester');
  assert.deepStrictEqual(thread.refs, [], 'a thread does not reference itself');
  assert.ok(!/<|>/.test(thread.excerpt.replace(/"&gt;|">/g, '')), 'excerpt is plain text');
});

// Content anyone can post on GitHub must never block a deploy: the live-mode
// site check passes on it, the output stays safe, and the data cases for
// decisions, references and locked threads hold.
test('live-safety fixture passes the live-mode checks and stays safe', () => {
  const out = path.join(tmp, 'live-safety');
  const data = path.join(buildOk(path.join(ROOT, 'test/fixtures/live-safety'), out), 'data');
  const { forum } = validateSnapshot(data);
  const pre = runTool('prerender.js', ['--out', out]);
  assert.strictEqual(pre.status, 0, 'prerender failed: ' + pre.stderr);
  const live = runTool('forum-check.js', ['--site', out, '--live']);
  assert.strictEqual(live.status, 0, 'live-mode forum-check failed:\n' + live.stdout + live.stderr);
  const strict = runTool('forum-check.js', ['--site', out]);
  assert.notStrictEqual(strict.status, 0, 'fixture-mode forum-check should flag the template and script wording');
  assert.ok(/raw template expression/.test(strict.stderr) && /mentions script/.test(strict.stderr), strict.stderr);

  const byNum = new Map(forum.threads.map((t) => [t.num, t]));
  const page = (rel) => fs.readFileSync(path.join(out, rel), 'utf8');
  const region = (html) => html.slice(html.indexOf('<!-- FORUM_STATIC_START -->'), html.indexOf('<!-- FORUM_STATIC_END -->'));
  for (const t of forum.threads) {
    const where = t.repo + '#' + t.num;
    const detail = readJson(path.join(data, 't/' + t.slug + '/' + t.num + '.json'));
    for (const html of [detail.html].concat(detail.comments.map((c) => c.html))) assertSafe(html, where);
    const r = region(page('t/' + t.slug + '/' + t.num + '/index.html'));
    assert.deepStrictEqual(scriptInMarkup(r), [], 'no script in ' + where);
    assert.ok(markupUrls(r).every((u) => /^(\/|https?:\/\/|mailto:)/.test(u)), 'absolute URLs in ' + where);
  }
  // F1: "Vote: " in titles, bodies and comments, on issues and on assembly
  // reports, never blocks a deploy, and only the forum's own tags are counted.
  const daf = (n) => region(page('t/daf/' + n + '/index.html'));
  const dafJson = (n) => readJson(path.join(data, 't/daf/' + n + '.json'));
  assert.deepStrictEqual(forum.threads.filter((t) => t.repo === 'daf').map((t) => t.num + ':' + t.kind + ':' + t.merged).sort(),
    ['21:pr:2026-03-29T00:00:00Z', '22:pr:null', '23:issue:null', '24:issue:null', '25:issue:null']);
  assert.deepStrictEqual(dafJson(22).comments.map((c) => [c.id, c.html === '', c.vote]), [
    [2201, false, { vote: 'for', as: 'example-river' }],
    [2202, false, null],
    [2203, false, { vote: 'for', as: 'example-cedar' }],
    [2204, true, null],
    [2205, false, { vote: 'against', as: 'example-cedar' }],
    [2206, false, null],
    [2207, true, { vote: 'for', as: 'example-oak' }]
  ], 'mixed case read, prose not a vote, a person\'s marker comment shown, the bot\'s tally withheld, a non-speaker\'s line tagged, a line inside an HTML comment read');
  assert.deepStrictEqual(ownMarkers(daf(22)), { votes: [
    { comment: 2201, text: 'Vote line: for · names example-river' },
    { comment: 2203, text: 'Vote line: for · names example-cedar' },
    { comment: 2205, text: 'Vote line: against · names example-cedar' },
    { comment: 2207, text: 'Vote line: for · names example-oak' }
  ], notices: 1 });
  assert.ok(daf(22).includes('<p class="fs-meta">' + WITHHELD_NOTE + '</p>') && !fs.readFileSync(path.join(data, 't/daf/22.json'), 'utf8').includes('TALLYCOUNT-5e2b'), 'the bot\'s tally is withheld');
  assert.ok(!daf(22).includes('fs-vote">Vote line: for · names example-river</p>'), 'a forged tag keeps no class');
  assert.deepStrictEqual(ownMarkers(daf(21)), { votes: [{ comment: 2101, text: 'Vote line: for · names example-river' }], notices: 1 });
  assert.ok(daf(21).includes(ASSEMBLY_MERGED_NOTICE) && daf(21).includes('<span class="fs-state">merged 29 Mar 2026</span>'), 'merged report');
  for (const n of [23, 24, 25]) {
    assert.deepStrictEqual(ownMarkers(daf(n)), { votes: [], notices: 0 }, 'no tag or notice on daf#' + n);
    assert.ok(dafJson(n).comments.every((c) => c.vote === null), 'no vote read on daf#' + n);
  }
  assert.ok(daf(23).includes('<h1 class="ugc">Vote: should we move the meeting?</h1>'));
  // The [Veto] issue links back to the report that mentions it, on the forum.
  assert.ok(daf(24).includes('<a class="ugc" href="/t/daf/22/">Assembly 2026-10</a>'), 'back-link to the report page');
  assert.ok(daf(25).includes('Conversation locked on GitHub') && daf(25).includes('Reply on GitHub when you can.') && !daf(25).includes('#new_comment_field'), 'locked, with a reply that says Reply on GitHub');
  // SEC-1: the malformed escape survives as an unrewritten GitHub link.
  assert.ok(readJson(path.join(data, 't/lab/1.json')).html.includes('href="https://github.com/draykerdk/a%E9/issues/1"'));
  // SEC-3: logins are mirrored text.
  const one = region(page('t/lab/1/index.html'));
  assert.ok(one.includes('<a class="ugc" href="https://github.com/open-source-fan">open-source-fan</a>') && one.includes('<a class="ugc" href="https://github.com/OWNER-dev">OWNER-dev</a>'));
  assert.ok(region(page('decisions/index.html')).includes('by <span class="ugc">MEMBER-bot</span>'));
  // SEC-4: titles are shown as written, never emptied.
  assert.strictEqual(byNum.get(1).title, '>');
  assert.ok(one.includes('<h1 class="ugc">&gt;</h1>') && page('t/lab/1/index.html').includes('<title>&gt; — Drayker General Forum</title>'));
  assert.ok(page('t/lab/2/index.html').includes('<h1 class="ugc">- item</h1>'));
  assert.ok(page('feed.xml').includes('<title>&gt;</title>') && page('feed.xml').includes('<title>- item</title>'));
  // SEC-5: a user's link to https://github.com/t/<slug>/<n>/ stays on github.com.
  const two = region(page('t/lab/2/index.html'));
  assert.ok(two.includes('<a href="https://github.com/t/lab/1/" rel="nofollow ugc noopener noreferrer">github.com/t/lab/1</a>'));
  assert.ok(two.includes('<a href="https://github.com/t/lab/1/" rel="nofollow ugc noopener noreferrer">/t/lab/1/</a>'), 'a relative /t/ link in a body resolves to github.com');
  // DB-5: only pull requests merged into the default branch are decisions.
  const labDecisions = forum.decisions.filter((d) => d.repo === 'lab');
  assert.deepStrictEqual(labDecisions.map((d) => d.num), [8, 7, 4]);
  assert.deepStrictEqual(labDecisions[2].threads, [{ repo: 'lab', slug: 'lab', num: 1 }]);
  assert.deepStrictEqual(forum.decisions.filter((d) => d.repo === 'daf').map((d) => d.num), [21], 'the merged assembly report is a decision');
  // CF2-10: a decision carries its description as text for search, beyond the excerpt.
  const seven = labDecisions.find((d) => d.num === 7);
  assert.ok(seven.text.includes('zeppelin') && !seven.excerpt.includes('zeppelin') && seven.excerpt.endsWith('…'), 'decision text holds the whole description');
  // lab#8 repeats the assembly note word for word in its description: the
  // forum-check --live run above passes only if mirrored text never counts as it.
  assert.ok(labDecisions.some((d) => d.num === 8), 'lab#8 restates the assembly note');
  // SEC-CI-1: titles, logins and labels made only of XML-invalid characters
  // never write an empty feed element.
  for (const feed of ['feed.xml', 'decisions/feed.xml']) {
    const xml = page(feed);
    assert.ok(!/<title><\/title>|<name><\/name>|term=""/.test(xml), feed + ' has an empty title, author or category');
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(xml), feed + ' has XML-invalid characters');
  }
  assert.ok(page('feed.xml').includes('<title>(untitled)</title>') && page('feed.xml').includes('<author><name>ghost</name>'));
  assert.ok(page('decisions/feed.xml').includes('<title>(untitled)</title>'));
  assert.ok(page('t/lab/6/index.html').includes('<title>(untitled) — Drayker General Forum</title>'));
  // SEC-CI-5: an emoji-only body is clipped without splitting a surrogate pair.
  assert.ok(!/\uFFFD/.test(page('t/lab/6/index.html')) && !/\uFFFD/.test(fs.readFileSync(path.join(data, 'forum.json'), 'utf8')), 'a clipped emoji became U+FFFD');
  assert.ok(byNum.get(6).excerpt.endsWith('\u{1F600}…'));
  // SEC-CI-6: prose that looks like an attribute is not rewritten in the feed.
  assert.ok(!page('feed.xml').includes('forum.drayker.org/x') && page('feed.xml').includes('href=&amp;quot;/x&amp;quot;'), 'feed rewrote mirrored text');
  // CF2-01: a comment hidden on GitHub keeps its place, author and date, and
  // none of its content is published anywhere.
  const hidden = readJson(path.join(data, 't/lab/2.json')).comments.find((c) => c.id === 203);
  assert.deepStrictEqual([hidden.hidden, hidden.html, hidden.user, hidden.created], ['abuse', '', 'hidden-author', '2026-02-04T00:00:00Z']);
  assert.strictEqual(byNum.get(2).comments, 1, 'a hidden comment still counts');
  const twoPage = region(page('t/lab/2/index.html'));
  assert.ok(twoPage.includes('<p class="fs-meta">Hidden on GitHub (abuse)</p>') && twoPage.includes('hidden-author') && twoPage.includes('<h2>1 reply</h2>'));
  const twoLd = JSON.parse(/<script id="drayker-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page('t/lab/2/index.html'))[1]);
  const posting = twoLd['@graph'].find((n) => n['@type'] === 'DiscussionForumPosting');
  assert.strictEqual(posting.commentCount, 1);
  assert.deepStrictEqual(posting.comment, [], 'JSON-LD describes no hidden comment');
  const everything = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else everything.push(full);
    }
  };
  walk(out);
  assert.ok(everything.length > 10);
  for (const file of everything) assert.ok(!fs.readFileSync(file).includes('HIDDENMARKER-7f3a'), 'hidden comment content published in ' + path.relative(out, file));
  // DB-6: references come from rendered links only (not from code or in-page anchors).
  assert.deepStrictEqual(byNum.get(1).refs.map((r) => r.num), [4]);
  assert.deepStrictEqual(byNum.get(2).refs.map((r) => r.kind + r.num), ['pr5', 'issue1']);
  assert.deepStrictEqual(byNum.get(3).refs, []);
  // DB-8: lock state is kept and the page says the conversation is locked.
  assert.strictEqual(byNum.get(3).locked, true);
  assert.strictEqual(byNum.get(3).lock_reason, 'resolved');
  assert.strictEqual(byNum.get(1).locked, false);
  assert.strictEqual(byNum.get(1).lock_reason, null);
  const three = region(page('t/lab/3/index.html'));
  assert.ok(three.includes('Conversation locked on GitHub') && three.includes('>Read on GitHub</a>') && !three.includes('Reply on GitHub'));
  assert.ok(one.includes('#new_comment_field">Reply on GitHub</a>'));
});

test('builder fails clearly on missing data', () => {
  const empty = path.join(tmp, 'empty-fixture');
  fs.mkdirSync(empty, { recursive: true });
  const url = 'https://api.github.com/orgs/draykerdk/repos?type=public&per_page=100';
  fs.writeFileSync(path.join(empty, fixtureName(url)), JSON.stringify({ url, link: null, body: [] }));
  const none = build(empty, path.join(tmp, 'empty-out'));
  assert.notStrictEqual(none.status, 0);
  assert.ok(/no public repositories/.test(none.stderr), none.stderr);
  const missing = build(path.join(tmp, 'does-not-exist'), path.join(tmp, 'missing-out'));
  assert.notStrictEqual(missing.status, 0);
  assert.ok(/Fixture directory not found/.test(missing.stderr), missing.stderr);
  const partial = path.join(tmp, 'partial-fixture');
  fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(path.join(partial, fixtureName(url)), JSON.stringify({ url, link: null, body: [{ name: 'x', full_name: 'draykerdk/x', private: false, archived: false, has_issues: true, html_url: 'https://github.com/draykerdk/x' }] }));
  const gap = build(partial, path.join(tmp, 'partial-out'));
  assert.notStrictEqual(gap.status, 0);
  assert.ok(/No fixture response for https:\/\/api\.github\.com\/repos\/draykerdk\/x\/issues/.test(gap.stderr), gap.stderr);
});

// ---------------------------------------------------------------- preview server

test('preview server behaves like GitHub Pages', async () => {
  const site = path.join(tmp, 'site');
  fs.mkdirSync(path.join(site, 'about'), { recursive: true });
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), 'home');
  fs.writeFileSync(path.join(site, 'about/index.html'), 'about');
  fs.writeFileSync(path.join(site, '404.html'), 'missing');
  fs.writeFileSync(path.join(site, 'data/forum.json'), '{}');
  fs.writeFileSync(path.join(site, 'feed.xml'), '<feed/>');
  const server = createServer(site);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
  try {
    let r = await get('/');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body, 'home'); assert.ok(r.headers['content-type'].startsWith('text/html'));
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    r = await get('/about/'); assert.strictEqual(r.body, 'about');
    r = await get('/about'); assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.location, '/about/');
    r = await get('/nope/'); assert.strictEqual(r.status, 404); assert.strictEqual(r.body, 'missing');
    r = await get('/t/x/9/'); assert.strictEqual(r.status, 404);
    r = await get('/data/forum.json'); assert.strictEqual(r.status, 200); assert.ok(r.headers['content-type'].startsWith('application/json'));
    r = await get('/feed.xml'); assert.ok(r.headers['content-type'].startsWith('application/xml'));
    r = await get('/../../etc/passwd'); assert.strictEqual(r.status, 404);
    r = await get('/%2e%2e/%2e%2e/etc/passwd'); assert.strictEqual(r.status, 404);
    fs.rmSync(path.join(site, '404.html'));
    r = await get('/nope'); assert.strictEqual(r.status, 404); assert.strictEqual(r.body, 'home');
  } finally {
    server.close();
  }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('ok   ' + t.name);
    } catch (error) {
      failed++;
      console.log('FAIL ' + t.name + '\n     ' + (error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n     ') : error));
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log((tests.length - failed) + '/' + tests.length + ' checks passed');
  if (failed) process.exit(1);
})();

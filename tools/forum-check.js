#!/usr/bin/env node
'use strict';

/*
 * Validates the built site and the repository configuration it depends on.
 *
 *   node tools/forum-check.js [--site _site] [--live]
 *
 * Run after a build (npm run build:fixture or npm run build). It checks the
 * pages written by tools/prerender.js, the sitemap and feeds, the template
 * contract in index.html, the issue form field ids and the workflows.
 * UI behaviour is not tested here.
 *
 * --live is for a build from the live GitHub data, which anyone can write to.
 * It keeps only checks that such content cannot fail: structure (files,
 * canonical and robots tags, JSON-LD, the static region, sitemap, feeds and
 * entry counts), wording checks that skip mirrored content (class="ugc"), the
 * forum's own markers read with the tokenizer outside mirrored content (vote
 * tags, assembly notices), and security checks that read the parsed markup
 * (tags and attributes), never the escaped text. Without --live (the fixture
 * builds), the stricter text checks, the exact markup of the vote tags and the
 * sanitizer fixed-point check run as well.
 */

const fs = require('fs');
const path = require('path');
const pre = require('./prerender');
const { tokenize } = require('./lib/sanitize');

const ROOT = path.join(__dirname, '..');
const BASE = pre.BASE;
const SUFFIX = ' — Drayker General Forum';
const FORBIDDEN = [/Dknowledger/i, /open[\s-]source/i, /organization’s|organization's/i, /\b(MEMBER|OWNER|CONTRIBUTOR|COLLABORATOR)\b/];
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));

const failures = [];
let checks = 0;
const check = (condition, message) => { checks++; if (!condition) failures.push(message); return Boolean(condition); };

function parseArgs(argv) {
  const args = { site: '_site', live: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site') args.site = argv[++i];
    else if (argv[i] === '--live') args.live = true;
    else throw new Error('Unknown argument: ' + argv[i]);
  }
  return args;
}

const read = (file) => fs.readFileSync(file, 'utf8');
const exists = (file) => fs.existsSync(file);
// Decodes the references the site and feeds write, in one pass.
const ENTITIES = { quot: '"', lt: '<', gt: '>', nbsp: '\u00a0', amp: '&', apos: "'" };
const decode = (s) => String(s).replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (m, ref) => {
  if (ref[0] === '#') {
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  }
  return Object.prototype.hasOwnProperty.call(ENTITIES, ref) ? ENTITIES[ref] : m;
});

// ------------------------------------------------------------ XML checking

// Minimal well-formedness check: one root, balanced and properly nested
// elements, quoted unique attributes, valid entity references, no stray '<'.
function xmlError(xml) {
  let i = 0;
  const stack = [];
  let roots = 0;
  const entity = /^&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/;
  const name = /^[A-Za-z_:][A-Za-z0-9_:.-]*/;
  if (xml.charCodeAt(0) === 0xFEFF) i = 1;
  if (xml.startsWith('<?xml', i)) {
    const end = xml.indexOf('?>', i);
    if (end < 0) return 'unterminated XML declaration';
    i = end + 2;
  }
  while (i < xml.length) {
    const c = xml[i];
    if (c === '<') {
      if (xml.startsWith('<!--', i)) {
        const end = xml.indexOf('-->', i + 4);
        if (end < 0) return 'unterminated comment';
        i = end + 3; continue;
      }
      if (xml.startsWith('<![CDATA[', i)) {
        if (!stack.length) return 'CDATA outside the root';
        const end = xml.indexOf(']]>', i);
        if (end < 0) return 'unterminated CDATA';
        i = end + 3; continue;
      }
      if (xml.startsWith('<?', i)) {
        const end = xml.indexOf('?>', i);
        if (end < 0) return 'unterminated processing instruction';
        i = end + 2; continue;
      }
      if (xml.startsWith('<!', i)) return 'unexpected declaration at ' + i;
      if (xml[i + 1] === '/') {
        const m = name.exec(xml.slice(i + 2));
        if (!m) return 'bad end tag at ' + i;
        const close = xml.indexOf('>', i);
        if (close < 0 || xml.slice(i + 2 + m[0].length, close).trim()) return 'bad end tag at ' + i;
        const open = stack.pop();
        if (open !== m[0]) return 'end tag </' + m[0] + '> does not match <' + open + '> at ' + i;
        i = close + 1; continue;
      }
      const m = name.exec(xml.slice(i + 1));
      if (!m) return 'bad start tag at ' + i;
      if (!stack.length && ++roots > 1) return 'more than one root element';
      let j = i + 1 + m[0].length;
      const seen = new Set();
      for (;;) {
        const ws = /^\s*/.exec(xml.slice(j))[0];
        j += ws.length;
        if (xml.startsWith('/>', j)) { j += 2; break; }
        if (xml[j] === '>') { j += 1; stack.push(m[0]); break; }
        if (!ws) return 'missing space before attribute at ' + j;
        const a = name.exec(xml.slice(j));
        if (!a) return 'bad attribute at ' + j;
        if (seen.has(a[0])) return 'duplicate attribute ' + a[0] + ' at ' + j;
        seen.add(a[0]);
        j += a[0].length;
        const eq = /^\s*=\s*/.exec(xml.slice(j));
        if (!eq) return 'attribute without value at ' + j;
        j += eq[0].length;
        const q = xml[j];
        if (q !== '"' && q !== "'") return 'unquoted attribute at ' + j;
        const end = xml.indexOf(q, j + 1);
        if (end < 0) return 'unterminated attribute at ' + j;
        const value = xml.slice(j + 1, end);
        if (value.includes('<')) return "'<' in attribute at " + j;
        for (let k = value.indexOf('&'); k >= 0; k = value.indexOf('&', k + 1)) {
          if (!entity.test(value.slice(k))) return 'bad entity in attribute at ' + (j + 1 + k);
        }
        j = end + 1;
      }
      i = j; continue;
    }
    if (c === '&') {
      if (!entity.test(xml.slice(i))) return 'bad entity at ' + i;
      i++; continue;
    }
    if (!stack.length && !/\s/.test(c)) return 'text outside the root at ' + i;
    i++;
  }
  if (stack.length) return 'unclosed <' + stack[stack.length - 1] + '>';
  if (roots !== 1) return 'expected one root element';
  return null;
}

// ------------------------------------------------------------ HTML helpers

// Removes elements whose class list contains "ugc" (text mirrored from
// GitHub), <style> and <script> content and comments, and returns the
// remaining text. Uses the sanitizer's tokenizer, so escaped text is never
// mistaken for markup.
function siteText(html) {
  const out = [];
  const stack = [];
  let skip = 0;
  tokenize(html, (tok) => {
    if (tok.type === 'text') { if (!skip) out.push(tok.text); return; }
    out.push(' ');
    if (tok.type === 'end') {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag !== tok.name) continue;
        while (stack.length > k) if (stack.pop().skip) skip--;
        break;
      }
      return;
    }
    if (VOID.has(tok.name) || tok.selfClosing) return;
    const isSkipped = tok.name === 'style' || tok.name === 'script'
      || String(tok.attrs.get('class') || '').split(/\s+/).includes('ugc');
    stack.push({ tag: tok.name, skip: isSkipped });
    if (isSkipped) skip++;
  });
  return out.join('').replace(/\s+/g, ' ').trim();
}

// The forum's own markers in a static region, read with the sanitizer's
// tokenizer; subtrees with class "ugc" (mirrored content), <style> and <script>
// are skipped. Returns { votes: [{ comment, text }], notices }: each vote tag
// (an element with class fs-vote) with the id of the comment it sits in (null
// outside a comment) and its text, and the number of assembly notices
// (<section aria-label="Assembly report">). Mirrored content cannot produce
// either marker: the sanitizer drops the class and the attribute, its text is
// escaped, and its subtree is skipped here.
function ownMarkers(html) {
  const votes = [];
  let notices = 0;
  const stack = [];
  let skip = 0;
  let current = null;
  tokenize(html, (tok) => {
    if (tok.type === 'text') { if (current) current.text += tok.text; return; }
    if (tok.type === 'end') {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag !== tok.name) continue;
        while (stack.length > k) {
          const e = stack.pop();
          if (e.skip) skip--;
          if (e.vote) current = null;
        }
        break;
      }
      return;
    }
    if (VOID.has(tok.name) || tok.selfClosing) return;
    const classes = String(tok.attrs.get('class') || '').split(/\s+/);
    const entry = { tag: tok.name, skip: false, vote: false, comment: null };
    if (!skip) {
      const id = /^comment-(\d+)$/.exec(tok.name === 'li' ? String(tok.attrs.get('id') || '') : '');
      if (id) entry.comment = Number(id[1]);
      if (tok.name === 'section' && tok.attrs.get('aria-label') === 'Assembly report') notices++;
      if (classes.includes(pre.VOTE_CLASS) && !current) {
        let comment = null;
        for (let k = stack.length - 1; k >= 0; k--) if (stack[k].comment !== null) { comment = stack[k].comment; break; }
        entry.vote = true;
        current = { comment, text: '' };
        votes.push(current);
      }
    }
    if (classes.includes('ugc') || tok.name === 'style' || tok.name === 'script') { entry.skip = true; skip++; }
    stack.push(entry);
  });
  for (const v of votes) v.text = v.text.replace(/\s+/g, ' ').trim();
  return { votes, notices };
}

// Start tags of an HTML fragment as { name, attrs: Map } with attribute
// values decoded, read with the sanitizer's tokenizer.
function startTags(html) {
  const tags = [];
  tokenize(html, (tok) => { if (tok.type === 'start') tags.push({ name: tok.name, attrs: tok.attrs }); });
  return tags;
}

const DANGEROUS_URL = /^(javascript|vbscript|data):/i;
const urlCore = (value) => String(value).replace(/[\u0000-\u0020\u007f-\u009f]/g, '');

// Script in real markup: <script> elements, on* attributes, and
// javascript:, vbscript: or data: in href or src. Returns a list of findings.
function scriptInMarkup(html) {
  const found = [];
  for (const tag of startTags(html)) {
    if (tag.name === 'script') found.push('<script> element');
    for (const [name, value] of tag.attrs) {
      if (/^on/i.test(name)) found.push(name + ' attribute on <' + tag.name + '>');
      if ((name === 'href' || name === 'src') && DANGEROUS_URL.test(urlCore(value))) found.push(name + '="' + String(value).slice(0, 40) + '" on <' + tag.name + '>');
    }
  }
  return found;
}

// href and src values of real markup.
function markupUrls(html) {
  const urls = [];
  for (const tag of startTags(html)) for (const [name, value] of tag.attrs) if (name === 'href' || name === 'src') urls.push(value);
  return urls;
}

function staticRegion(page) {
  const a = page.indexOf(pre.START);
  const b = page.indexOf(pre.END);
  if (a < 0 || b < a) return null;
  return page.slice(a + pre.START.length, b);
}

const metaContent = (page, attr, key) => {
  const m = new RegExp('<meta ' + attr + '="' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '" content="([^"]*)">').exec(page);
  return m ? decode(m[1]) : null;
};

function jsonLd(page) {
  const m = /<script id="drayker-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (error) { return null; }
}

// --------------------------------------------------------------- checks

function checkPlain() {
  const cases = [
    ['well-founded', 'well-founded'],
    ['Write DFMP-000, the proposal process paper', 'Write DFMP-000, the proposal process paper'],
    ['snake_case_name, C# and #12', 'snake_case_name, C# and #12'],
    ['a - b -- c', 'a - b -- c'],
    ['Use `__init__` and `a*b*c`', 'Use __init__ and a*b*c'],
    ['**bold**, _em_ and *em*', 'bold, em and em'],
    ['[a link](https://example.com) and ![an image](https://example.com/x.png)', 'a link and an image'],
    ['# Heading\n\n> quoted\n- item', 'Heading quoted item'],
    ['  many\n\n spaces\t here ', 'many spaces here'],
    ['~~gone~~ 2 * 3 * 4', 'gone 2 * 3 * 4']
  ];
  for (const [input, expected] of cases) {
    const got = pre.plain(input);
    check(got === expected, 'plain(' + JSON.stringify(input) + ') gave ' + JSON.stringify(got) + ', expected ' + JSON.stringify(expected));
  }
  const long = 'word '.repeat(60);
  const clipped = pre.compact(long, 180);
  check(clipped.length <= 180 && clipped.endsWith('…') && !/\s…$/.test(clipped) && /word…$/.test(clipped), 'compact() must cut at a word boundary within the limit');
}

function checkTemplate() {
  const html = read(path.join(ROOT, 'index.html'));
  check(/<body[^>]*>\s*<!-- FORUM_STATIC_START --><!-- FORUM_STATIC_END -->/.test(html), 'index.html <body> must begin with the empty static region markers');
  check(!html.includes('FORUM_PRERENDER_START'), 'index.html still has the old prerender block');
  check(html.includes('<link rel="alternate" type="application/atom+xml" href="/feed.xml"'), 'index.html does not link the threads feed');
  check(html.includes('<link rel="alternate" type="application/atom+xml" href="/decisions/feed.xml"'), 'index.html does not link the decisions feed');
  let meta = null;
  try { meta = pre.readMeta(html); } catch (error) { check(false, 'META cannot be read from index.html: ' + error.message); }
  if (meta) for (const key of pre.META_KEYS) check(meta[key].t.endsWith(SUFFIX) || key === 'list', 'META.' + key + '.t should end with "' + SUFFIX + '"');
}

// Reads the permissions block at the given indentation in a workflow (or a
// job's block of it) into { scope: access }; null when there is none.
function permissionsBlock(text, indent) {
  const m = new RegExp('(?:^|\\n)' + indent + 'permissions:[ \\t]*\\n((?:' + indent + '  [^\\n]*\\n?)*)').exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s+([a-z-]+):\s*([a-z]+)\s*$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}
// Returns the lines of one job of a workflow (indented by four spaces), or ''.
function jobBlock(workflow, name) {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  const m = new RegExp('\\n  ' + name + ':\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)').exec(jobs);
  return m ? m[1] + '\n' : '';
}
const samePermissions = (actual, expected) => JSON.stringify(Object.entries(actual || {}).sort()) === JSON.stringify(Object.entries(expected).sort());

const FORUM_NOTE = 'Public threads in the draykerdk repositories are also shown on forum.drayker.org.';

function checkConfig() {
  const proposal = read(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'proposal.yml'));
  const PROPOSAL_IDS = ['summary', 'problem', 'change', 'component', 'smallest_step', 'against', 'public'];
  const ids = [...proposal.matchAll(/^\s+id: ([a-z_]+)\s*$/gm)].map((m) => m[1]);
  check(JSON.stringify(ids) === JSON.stringify(PROPOSAL_IDS), 'proposal form field ids must be ' + PROPOSAL_IDS.join(', ') + ' in that order (found ' + ids.join(', ') + ')');
  check(/id: problem\n\s+attributes:\n\s+label: What problem does it address\?\n/.test(proposal), 'proposal form field problem must be labelled "What problem does it address?"');
  check(!/id: problem\n[\s\S]*?required: true[\s\S]*?id: change/.test(proposal), 'proposal form field problem must be optional');
  for (const form of ['proposal.yml', 'partnership.yml', 'volunteer-introduction.yml']) {
    const text = read(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', form));
    const intro = (/- type: markdown\n\s+attributes:\n\s+value: \|\n([\s\S]*?)\n  - type:/.exec(text) || [])[1] || '';
    check(intro.includes(FORUM_NOTE), form + ' intro does not say that public threads are shown on forum.drayker.org');
  }
  check(!/the project should/i.test(proposal), 'proposal form still says "the project"');
  check(!proposal.includes('postUrl()'), 'proposal form comment still names postUrl()');

  const site = read(path.join(ROOT, '.github', 'workflows', 'forum-site.yml'));
  check(site.includes('tools/build-forum-snapshot.js') && site.includes('--out _site'), 'site workflow does not build the snapshot into _site');
  check(site.includes('tools/prerender.js'), 'site workflow does not prerender');
  check(/run:\s*node tools\/test\.js --live\s*\n/.test(site), 'site workflow does not run the tests in live mode (node tools/test.js --live)');
  check(!/npm test/.test(site), 'site workflow must not run the fixture-mode tests on live data');
  check(/actions\/upload-pages-artifact@v4[\s\S]*?path:\s*_site\b/.test(site), 'site workflow must upload _site with upload-pages-artifact@v4');
  check(site.includes('actions/deploy-pages@v4'), 'site workflow does not deploy with deploy-pages@v4');
  // Least privilege per job: only the deploy job can publish or mint an OIDC
  // token; the build job, which reads content anyone can write, only reads.
  check(samePermissions(permissionsBlock(site, ''), { contents: 'read' }), 'site workflow-level permissions must be only contents: read');
  check(samePermissions(permissionsBlock(jobBlock(site, 'build'), '    '), { contents: 'read', pages: 'read' }), 'build job permissions must be only contents: read and pages: read');
  check(samePermissions(permissionsBlock(jobBlock(site, 'deploy'), '    '), { pages: 'write', 'id-token': 'write' }), 'deploy job permissions must be only pages: write and id-token: write');
  check(samePermissions(permissionsBlock(jobBlock(site, 'keepalive'), '    '), { actions: 'write' }), 'keepalive job permissions must be only actions: write');
  check(jobBlock(site, 'deploy').includes('actions/deploy-pages@v4') && jobBlock(site, 'build').includes('actions/configure-pages@v5'), 'deploy-pages must run in the deploy job and configure-pages in the build job');
  check(site.includes("cron: '7,22,37,52 * * * *'"), 'site workflow schedule is not every 15 minutes');
  check(site.includes('tools/deploy-decision.js') && site.includes('https://forum.drayker.org/data/meta.json'), 'site workflow does not compare the deployed meta.json');
  check(/if:\s*steps\.decide\.outputs\.deploy == 'true'\s*\n\s*uses: actions\/upload-pages-artifact@v4/.test(site), 'site workflow uploads the artifact without a deploy decision');
  check(/if:\s*needs\.build\.outputs\.deploy == 'true'/.test(site), 'deploy job does not depend on the deploy decision');
  // Keepalive: GitHub disables schedules after 60 days without repository activity.
  check(site.includes("cron: '7 3 * * 1'"), 'site workflow has no weekly keepalive schedule');
  const keepalive = (/\n  keepalive:\n([\s\S]*?)\n  [a-z]+:\n/.exec(site) || [])[1] || '';
  check(/if: github\.event_name == 'schedule' && github\.event\.schedule == '7 3 \* \* 1'/.test(keepalive), 'keepalive job must run only on its own schedule');
  check(/permissions:\s*\n\s*actions: write\s*\n/.test(keepalive) && !/pages: write|id-token: write|contents: write/.test(keepalive), 'keepalive job must have only actions: write');
  check(keepalive.includes('gh api -X PUT "repos/${{ github.repository }}/actions/workflows/forum-site.yml/enable"') && keepalive.includes('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), 'keepalive job does not re-enable the workflow');
  check(/\n  build:\n    if: github\.event_name != 'schedule' \|\| github\.event\.schedule != '7 3 \* \* 1'\n/.test(site), 'build job must not run on the keepalive schedule');
  const decision = read(path.join(ROOT, 'tools', 'deploy-decision.js'));
  check(decision.includes('content_hash') && decision.includes('site_rev'), 'deploy decision does not compare content_hash and site_rev');
  check(/group:.*'github-pages'/.test(site) && /cancel-in-progress:\s*false/.test(site), 'site workflow concurrency changed');

  const prFile = path.join(ROOT, '.github', 'workflows', 'forum-check.yml');
  check(exists(prFile), 'forum-check workflow is missing');
  if (exists(prFile)) {
    const pr = read(prFile);
    check(pr.includes('pull_request') && /forum-check:/.test(pr), 'forum-check workflow must run on pull requests as job forum-check');
    check(pr.includes('npm run build:fixture') && pr.includes('npm test'), 'forum-check workflow must build from the fixture and run the tests');
  }

  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  for (const name of ['build', 'build:fixture', 'serve', 'test']) check(pkg.scripts && pkg.scripts[name], 'package.json script missing: ' + name);
  check(!(pkg.scripts && pkg.scripts.snapshot), 'package.json still has the snapshot script');
  check(!pkg.dependencies && !pkg.devDependencies, 'package.json must not have dependencies');

  for (const stale of ['t', 'about', 'new', 'decisions', 'routing', 'sitemap.xml', 'data', 'design/Drayker Forum.dc.html']) {
    check(!exists(path.join(ROOT, stale)), 'generated or stale output is committed at the repository root: ' + stale);
  }
  check(read(path.join(ROOT, '.gitignore')).split(/\r?\n/).includes('_site/'), '_site/ is not git-ignored');
}

function checkSite(siteDir, live) {
  const at = (rel) => path.join(siteDir, rel);
  if (!check(exists(at('data/forum.json')) && exists(at('index.html')), 'no built site in ' + siteDir + ' (run npm run build:fixture first)')) return;

  for (const file of ['support.js', 'favicon.ico', 'robots.txt', 'llms.txt', 'CNAME', 'assets/forum-social.png', 'assets/logo/drayker-icone.svg', 'data/meta.json', 'sitemap.xml', 'feed.xml', 'decisions/feed.xml', '404.html']) {
    check(exists(at(file)), 'built site is missing ' + file);
  }
  for (const unpublished of ['design', 'tools', 'test', '.github', 'node_modules', 'package.json', 'README.md']) {
    check(!exists(at(unpublished)), 'built site must not contain ' + unpublished);
  }

  const forum = JSON.parse(read(at('data/forum.json')));
  const metaJson = JSON.parse(read(at('data/meta.json')));
  check(metaJson.generated_at === forum.generated_at && /^[0-9a-f]{64}$/.test(metaJson.content_hash || ''), 'data/meta.json does not match forum.json');

  const pages = [
    { file: 'index.html', url: BASE, kind: 'list' },
    { file: 'new/index.html', url: BASE + 'new/', kind: 'new' },
    { file: 'decisions/index.html', url: BASE + 'decisions/', kind: 'decisions' },
    { file: 'routing/index.html', url: BASE + 'routing/', kind: 'routing' },
    { file: 'about/index.html', url: BASE + 'about/', kind: 'about' }
  ];
  for (const t of forum.threads) {
    pages.push({ file: 't/' + t.slug + '/' + t.num + '/index.html', url: BASE + pre.threadPath(t.slug, t.num).slice(1), kind: 'thread', thread: t });
  }
  pages.push({ file: '404.html', url: null, kind: 'notfound' });

  const resanitize = pre.makeResanitize(forum);
  const threadByKey = new Map(forum.threads.map((t) => [t.repo.toLowerCase() + '#' + t.num, t]));
  const routes = pre.readRoutes(read(path.join(ROOT, 'index.html')));
  for (const p of pages) {
    const label = '/' + p.file;
    if (!check(exists(at(p.file)), 'missing page ' + label)) continue;
    const page = read(at(p.file));
    const canonicals = page.match(/<link rel="canonical"[^>]*>/g) || [];
    if (p.url) {
      check(canonicals.length === 1 && canonicals[0] === '<link rel="canonical" href="' + p.url + '">', label + ' must have exactly one canonical ' + p.url);
      check(!/<meta name="robots"[^>]*noindex/.test(page), label + ' must not be noindex');
    } else {
      check(canonicals.length === 0, label + ' must not have a canonical link');
      check(page.includes('<meta name="robots" content="noindex">'), label + ' must be noindex');
    }
    check(metaContent(page, 'property', 'og:type') === (p.kind === 'thread' ? 'article' : 'website'), label + ' has the wrong og:type');
    const title = decode((/<title>([\s\S]*?)<\/title>/.exec(page) || [])[1] || '');
    const description = metaContent(page, 'name', 'description') || '';
    check(title && metaContent(page, 'property', 'og:title') === title && metaContent(page, 'name', 'twitter:title') === title, label + ' title tags disagree');
    check(description && description.length <= pre.DESCRIPTION_MAX, label + ' description is empty or longer than ' + pre.DESCRIPTION_MAX);
    check(metaContent(page, 'property', 'og:description') === description && metaContent(page, 'name', 'twitter:description') === description, label + ' description tags disagree');
    check(page.includes('src="/support.js"') && page.includes('href="/assets/logo/drayker-icone.svg'), label + ' asset paths are not root-absolute');

    const head = page.slice(0, page.indexOf('</head>'));
    const region = staticRegion(page);
    if (!check(region !== null, label + ' has no static region')) continue;
    for (const part of [head, region]) {
      for (const url of markupUrls(part)) {
        check(/^(\/|https?:\/\/|mailto:|#)/.test(url) && !url.startsWith('//'), label + ' has a relative URL: ' + url);
      }
    }
    check(region.startsWith('<div id="forum-static"><style>') && region.endsWith('</div>'), label + ' static region is not a single #forum-static block');
    const text = siteText(region);
    check(text.length > 40, label + ' static region has no site text');
    check(!text.includes('{{'), label + ' static region shows a raw template expression');
    const script = scriptInMarkup(region);
    check(!script.length, label + ' static region contains script: ' + script.join(', '));
    const stray = [];
    for (const tag of startTags(region)) {
      for (const name of tag.attrs.keys()) {
        if (name === 'id' && ((tag.name === 'div' && tag.attrs.get('id') === 'forum-static') || (tag.name === 'li' && /^comment-\d+$/.test(tag.attrs.get('id'))))) continue;
        if (name === 'style' || name === 'id' || name.startsWith('data-')) stray.push(name + ' on <' + tag.name + '>');
      }
    }
    check(!stray.length, label + ' static region has attributes outside the policy: ' + stray.slice(0, 5).join(', '));
    if (!live) {
      // Text checks over everything, mirrored content included: fixture builds only.
      const allText = decode(region.replace(/<style\b[\s\S]*?<\/style>/g, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
      check(allText.length > 80, label + ' static region is empty');
      check(!allText.includes('{{'), label + ' static region text shows a raw template expression');
      check(!/<script\b/i.test(region) && !/\son[a-z]+\s*=/i.test(region) && !/javascript:/i.test(region), label + ' static region text mentions script');
    }
    const own = [text];
    if (p.kind !== 'thread') own.push(title, description);
    for (const re of FORBIDDEN) check(!own.some((s) => re.test(s)), label + ' site text contains ' + re);

    const ld = jsonLd(page);
    if (!check(ld && Array.isArray(ld['@graph']), label + ' JSON-LD does not parse')) continue;
    const graph = ld['@graph'];
    const byType = (type) => graph.filter((n) => n['@type'] === type);
    check(byType('WebSite').length === 1, label + ' JSON-LD has no WebSite');

    if (p.kind === 'thread') {
      const t = p.thread;
      const detailFile = at('data/t/' + t.slug + '/' + t.num + '.json');
      const detail = JSON.parse(read(detailFile));
      check(title === pre.titleText(t.title) + SUFFIX, label + ' title is not the full thread title');
      const post = byType('DiscussionForumPosting')[0];
      if (check(post, label + ' has no DiscussionForumPosting')) {
        check(post.url === p.url && post.headline === pre.titleText(t.title), label + ' posting url or headline is wrong');
        check(post.datePublished === t.created && post.dateModified === t.at, label + ' posting dates are wrong');
        check(post.author && post.author['@type'] === 'Person' && post.author.name === t.user && post.author.url === 'https://github.com/' + encodeURIComponent(t.user), label + ' posting author is wrong');
        check(typeof post.text === 'string' && post.text.length <= 1000, label + ' posting text is missing or too long');
        // Hidden comments count but are not described.
        const shown = detail.comments.filter((c) => !c.hidden);
        check(post.commentCount === detail.comments.length && Array.isArray(post.comment) && post.comment.length === shown.length, label + ' comment count is wrong');
        check((post.comment || []).every((c, i) => shown[i] && c.url === shown[i].url), label + ' JSON-LD describes a hidden comment');
        check((post.comment || []).every((c) => c['@type'] === 'Comment' && c.author && c.author.name && c.datePublished && typeof c.text === 'string' && c.text.length <= 500 && c.url), label + ' comments are incomplete');
        check(post.isPartOf && post.isPartOf['@id'] === BASE + '#website' && post.mainEntityOfPage, label + ' posting is not linked to the site');
      }
      if (t.locked) {
        // The forum's own text only: a reply may well say "Reply on GitHub".
        check(region.includes('Conversation locked on GitHub') && region.includes('href="' + t.url + '">Read on GitHub</a>') && !text.includes('Reply on GitHub'), label + ' is locked but does not say so');
      } else {
        check(region.includes('href="' + t.url + '#new_comment_field">Reply on GitHub</a>'), label + ' has no Reply on GitHub link');
      }
      check((region.match(/<li class="fs-comment"/g) || []).length === detail.comments.length, label + ' does not show every comment');
      check(t.kind === 'issue' || t.kind === 'pr', label + ' has no thread kind');
      check(t.url === 'https://github.com/' + 'draykerdk/' + t.repo + (t.kind === 'pr' ? '/pull/' : '/issues/') + t.num, label + ' thread url does not match its kind');
      // Vote tags and notices are counted as the forum's own markup only, never
      // as text: a title, a body or a comment may say "Vote: " anything.
      const own = ownMarkers(region);
      if (t.kind === 'pr') {
        // An assembly report of the federation: the notice for its state above
        // the replies, a tag for each vote line, and never a count, a weight, a
        // quorum or an outcome.
        const notice = '<section aria-label="Assembly report"><p>' + pre.esc(pre.assemblyNotice(t)) + '</p>';
        check(t.repo === 'daf', label + ' is a pull request thread outside daf');
        check(t.merged === null || /^\d{4}-\d{2}-\d{2}T[0-9:]+Z$/.test(t.merged), label + ' has a bad merged time');
        check(own.notices === 1 && region.includes(notice) && region.indexOf(notice) < region.indexOf('<section aria-label="Replies">'), label + ' has no assembly notice for its state above the replies');
        check(region.includes('<span class="fs-state">' + pre.esc(pre.stateLabel(t)) + '</span>'), label + ' state label does not match the data');
        check(region.includes('<a href="' + t.url + '">The pull request on GitHub</a>') && region.includes('<a href="' + pre.TALLY_WORKFLOW + '">The Federation tally workflow</a>'), label + ' assembly notice does not link the pull request and the tally workflow');
        // (A date before a tag, as in "8 Oct 2026 Vote line: for", is not a
        // count; the merged notice says where the outcome is written, which is
        // not an outcome.) Fixture builds only: in live mode a label or a login
        // could match the pattern, and content from GitHub must never block a deploy.
        if (!live) check(!/\b\d+\s*(votes?(?! line\b)|points?|for|against|abstain(ed|s)?)\b(?!:)|\b(for|against|abstain)\s*[:=]?\s*\d|\b(totals?|quorum|weights?|weighted|outcomes?|majority)\b|%/i.test(text.split(pre.ASSEMBLY_MERGED_NOTICE).join(' ')), label + ' shows a count, a weight, a quorum or an outcome');
        for (const c of detail.comments) {
          const item = (new RegExp('<li class="fs-comment" id="comment-' + Number(c.id) + '">([\\s\\S]*?)</li>').exec(region) || [])[1] || '';
          const tags = own.votes.filter((v) => v.comment === Number(c.id)).map((v) => v.text);
          check(c.vote ? !c.hidden && tags.length === 1 && tags[0] === pre.voteText(c.vote) : tags.length === 0, label + ' comment ' + c.id + ' vote tag does not match the data');
          if (!live && c.vote) check(item.includes(pre.voteTag(c.vote)), label + ' comment ' + c.id + ' vote tag markup changed');
          if (c.hidden) check(item.includes('<p class="fs-meta">' + pre.esc(pre.HIDDEN_VOTE_NOTE) + '</p>'), label + ' hidden comment ' + c.id + ' does not say its vote is not shown');
        }
        check(own.votes.length === detail.comments.filter((c) => c.vote).length && own.votes.every((v) => v.comment !== null), label + ' tags a comment that holds no vote');
      } else {
        check(own.notices === 0 && own.votes.length === 0 && t.merged === null && detail.comments.every((c) => c.vote === null), label + ' is an issue with assembly markup or votes');
      }
      for (const c of detail.comments) {
        if (c.hidden === null) continue;
        check(typeof c.hidden === 'string' && /^[a-z][a-z-]*$/.test(c.hidden) && c.html === '', label + ' hidden comment ' + c.id + ' keeps content or has a bad reason');
        const item = (new RegExp('<li class="fs-comment" id="comment-' + Number(c.id) + '">([\\s\\S]*?)</li>').exec(region) || [])[1] || '';
        check(item.includes('<p class="fs-meta">Hidden on GitHub (' + c.hidden + ')</p>') && !item.includes('fs-body'), label + ' hidden comment ' + c.id + ' is not shown as hidden');
      }
      check(region.includes('<div class="fs-body ugc">' + (detail.html ? resanitize(detail.html) : '')) || !detail.html, label + ' does not show the sanitized body');
      // A back-link goes to the forum page of the issue or pull request when it
      // has one (an assembly report), and to GitHub otherwise.
      for (const r of t.refs || []) {
        const local = threadByKey.get(String(r.repo).toLowerCase() + '#' + r.num);
        const href = local ? pre.threadPath(local.slug, local.num) : r.url;
        check(region.includes('<a class="ugc" href="' + pre.esc(href) + '">'), label + ' does not link the back-link ' + r.repo + '#' + r.num + ' to ' + href);
      }
    } else if (p.kind === 'list') {
      const page0 = byType('CollectionPage')[0];
      const list = page0 && page0.mainEntity;
      check(list && list['@type'] === 'ItemList' && list.itemListElement.length === Math.min(pre.FEED_MAX, forum.threads.length), label + ' has no CollectionPage with an ItemList of the newest threads');
      for (const t of forum.threads) check(region.includes('href="' + pre.threadPath(t.slug, t.num) + '"'), label + ' does not link thread ' + t.slug + '/' + t.num);
    } else {
      const web = byType('WebPage')[0];
      check(web && (p.url ? web.url === p.url : !web.url), label + ' has no WebPage node for its URL');
    }
    if (p.kind === 'decisions') {
      for (const d of forum.decisions) check(region.includes('href="' + d.url + '"'), label + ' does not link decision ' + d.repo + '#' + d.num);
      // A merged assembly report carries the note that the merge is not the outcome, and only it does.
      const note = '<p>' + pre.esc(pre.ASSEMBLY_DECISION_NOTE) + '</p>';
      for (const d of forum.decisions) {
        const at = region.indexOf('<li><a class="ugc" href="' + pre.esc(d.url) + '">');
        const item = at < 0 ? '' : region.slice(at, region.indexOf('</li>', region.indexOf('</p>', at) + 4) + 5);
        check(item.includes(note) === pre.isAssemblyDecision(d), label + ' decision ' + d.repo + '#' + d.num + (pre.isAssemblyDecision(d) ? ' lacks' : ' has') + ' the assembly note');
      }
      check(region.split(note).length - 1 === forum.decisions.filter(pre.isAssemblyDecision).length, label + ' assembly note count is wrong');
    }
    if (p.kind === 'routing') {
      for (const r of forum.repos) check(region.includes('href="' + r.url + '"'), label + ' does not list repository ' + r.name);
      // The routing table of index.html, row for row, with its form links.
      for (const r of routes) {
        check(region.includes('<li><p>' + pre.esc(r.about) + '</p>'), label + ' does not list the route ' + r.about);
        for (const repo of r.repos) check(region.includes('<a href="https://github.com/draykerdk/' + repo + '/issues">draykerdk/' + repo + '</a>'), label + ' route ' + r.about + ' does not link ' + repo);
        if (r.form) check(region.includes('<a href="' + pre.esc(r.form.href) + '">' + pre.esc('or ' + r.form.label) + '</a>'), label + ' route ' + r.about + ' does not link its form');
      }
      check(routes.some((r) => r.repos.join() === 'daf' && r.form && r.form.href === 'https://github.com/draykerdk/daf/issues/new?template=claim.yml'), 'the federation route does not offer the claim form');
    }
    // The founding line: once on each route that opens a DAF form while no
    // assembly has been held (no merged assembly report among the decisions),
    // and on no page once one has. Mirrored content cannot write the fs-meta class.
    const founding = region.split(pre.foundingNote()).length - 1;
    const foundingWanted = p.kind === 'routing' && !pre.assemblyHeld(forum) ? routes.filter((r) => pre.isDafForm(r.form)).length : 0;
    check(founding === foundingWanted, label + ' carries the founding line ' + founding + ' times, expected ' + foundingWanted
      + (pre.assemblyHeld(forum) ? ' (a merged assembly report is in the decisions)' : ' (no assembly has been held)'));
    if (p.kind === 'new' || p.kind === 'about') {
      check(region.includes('https://github.com/draykerdk/general-forum/issues/new/choose'), label + ' does not link the GitHub issue forms');
    }
    if (p.kind === 'notfound') {
      check(region.includes('href="/"') && region.includes('href="https://github.com/draykerdk"') && /last update/i.test(text), label + ' does not explain the missing page');
    }
  }

  // Every data fragment must be a fixed point of the sanitizer (fixture builds
  // only: the pages show the second pass either way, so this checks the
  // sanitizer, not the safety of the output).
  let fragments = 0;
  let unstable = 0;
  for (const t of live ? [] : forum.threads) {
    const file = at('data/t/' + t.slug + '/' + t.num + '.json');
    if (!check(exists(file), 'missing thread data ' + t.slug + '/' + t.num)) continue;
    const detail = JSON.parse(read(file));
    for (const html of [detail.html].concat(detail.comments.map((c) => c.html))) {
      fragments++;
      if (resanitize(html) !== html) unstable++;
    }
  }
  if (!live) check(unstable === 0, unstable + ' of ' + fragments + ' HTML fragments change when sanitized again');

  // Sitemap: exactly the indexable pages.
  const sitemap = read(at('sitemap.xml'));
  const sitemapError = xmlError(sitemap);
  check(!sitemapError, 'sitemap.xml is not well-formed: ' + sitemapError);
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => decode(m[1])).sort();
  const expected = pages.filter((p) => p.url).map((p) => p.url).sort();
  check(JSON.stringify(locs) === JSON.stringify(expected), 'sitemap.xml must list exactly the ' + expected.length + ' indexable pages (has ' + locs.length + ')');
  check(sitemap.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'), 'sitemap.xml namespace is missing');
  check([...sitemap.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].length === locs.length, 'sitemap.xml lastmod missing');

  // Feeds.
  const feeds = [
    // Thread entries are issues, or assembly reports of the federation (daf pull requests).
    { file: 'feed.xml', count: Math.min(pre.FEED_MAX, forum.threads.length), idRe: /^https:\/\/github\.com\/draykerdk\/(?:[^/]+\/issues|daf\/pull)\/\d+$/ },
    { file: 'decisions/feed.xml', count: Math.min(pre.FEED_MAX, forum.decisions.length), idRe: /^https:\/\/github\.com\/draykerdk\/[^/]+\/pull\/\d+$/ }
  ];
  for (const f of feeds) {
    const xml = read(at(f.file));
    const error = xmlError(xml);
    check(!error, f.file + ' is not well-formed XML: ' + error);
    check(/<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/.test(xml), f.file + ' is not an Atom feed');
    check(/<feed[^>]*>\s*<id>https:\/\/forum\.drayker\.org\//.test(xml) && /<link rel="self" type="application\/atom\+xml" href="https:\/\/forum\.drayker\.org\//.test(xml), f.file + ' feed id or self link is wrong');
    check(/<updated>\d{4}-\d{2}-\d{2}T[^<]+<\/updated>/.test(xml), f.file + ' has no feed updated time');
    const entries = xml.split('<entry>').slice(1);
    check(entries.length === f.count && entries.length <= pre.FEED_MAX, f.file + ' has ' + entries.length + ' entries, expected ' + f.count);
    for (const e of entries) {
      const id = decode((/<id>([^<]*)<\/id>/.exec(e) || [])[1] || '');
      check(f.idRe.test(id), f.file + ' entry id is not a GitHub URL: ' + id);
      check(/<title>[^<]+<\/title>/.test(e) && /<updated>\d{4}-[^<]+<\/updated>/.test(e) && /<author><name>[^<]+<\/name>/.test(e), f.file + ' entry is incomplete: ' + id);
      check(/<link rel="alternate" type="text\/html" href="https:\/\/[^"]+"\/>/.test(e), f.file + ' entry link is not absolute: ' + id);
      const content = /<content type="html">([\s\S]*?)<\/content>/.exec(e);
      if (check(content, f.file + ' entry has no html content: ' + id)) {
        const html = decode(content[1]);
        const script = scriptInMarkup(html);
        check(!script.length, f.file + ' entry content contains script: ' + id + ': ' + script.join(', '));
        if (!live) check(!/<script\b/i.test(html) && !/\son[a-z]+\s*=/i.test(html) && !/javascript:/i.test(html), f.file + ' entry content text mentions script: ' + id);
        for (const url of markupUrls(html)) check(/^(https?:\/\/|mailto:|#)/.test(url), f.file + ' entry content has a relative URL: ' + url);
      }
    }
    if (f.file === 'decisions/feed.xml') {
      for (const e of entries) {
        const id = decode((/<id>([^<]*)<\/id>/.exec(e) || [])[1] || '');
        const d = forum.decisions.find((x) => x.url === id);
        const content = decode((/<content type="html">([\s\S]*?)<\/content>/.exec(e) || [])[1] || '');
        if (d) check(content.includes('<p>' + pre.esc(pre.ASSEMBLY_DECISION_NOTE) + '</p>') === pre.isAssemblyDecision(d), f.file + ' entry ' + id + ' assembly note does not match');
      }
    }
    const own = [(/<title>([^<]*)<\/title>/.exec(xml) || [])[1] || '', (/<subtitle>([^<]*)<\/subtitle>/.exec(xml) || [])[1] || ''];
    for (const re of FORBIDDEN) check(!own.some((s) => re.test(s)), f.file + ' feed text contains ' + re);
  }
}

function checkXmlChecker() {
  check(xmlError('<a><b x="1"/>t &amp; u</a>') === null, 'XML checker rejects a well-formed document');
  for (const bad of ['<a><b></a></b>', '<a>x &nbsp; y</a>', '<a x=1></a>', '<a></a><b></b>', '<a>1 < 2</a>', '<a x="1" x="2"></a>', '<a>']) {
    check(xmlError(bad) !== null, 'XML checker accepts ' + bad);
  }
  check(siteText('<p>own <a class="ugc" href="/">open source <b>x</b></a> text</p>') === 'own text', 'mirrored text is not excluded from site text');
  // Markers inside mirrored content never count; the forum's own do, with their comment.
  const m = ownMarkers('<li class="fs-comment" id="comment-7"><p class="fs-meta fs-vote">Vote line: for · names <span class="ugc">x</span></p>'
    + '<div class="fs-body ugc"><p class="fs-vote">Vote line: for</p><section aria-label="Assembly report"></section></div></li>');
  check(JSON.stringify(m) === JSON.stringify({ votes: [{ comment: 7, text: 'Vote line: for · names x' }], notices: 0 }), 'vote markers are not read from the forum\'s own markup only: ' + JSON.stringify(m));
}

async function checkDeployDecision() {
  const { decide } = require('./deploy-decision');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-deploy-'));
  const meta = path.join(dir, 'meta.json');
  const now = '2026-10-08T12:00:00Z';
  fs.writeFileSync(meta, JSON.stringify({ generated_at: now, content_hash: 'a'.repeat(64), site_rev: 'r1' }));
  const hoursBefore = (h) => new Date(Date.parse(now) - h * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const live = (value) => async () => value;
  const same = (extra) => live(Object.assign({ generated_at: hoursBefore(1), content_hash: 'a'.repeat(64), site_rev: 'r1' }, extra || {}));
  const fail = async () => { throw new Error('offline'); };
  const cases = [
    ['push', same(), true, 'push'],
    ['workflow_dispatch', same(), true, 'workflow_dispatch'],
    ['schedule', same(), false, 'unchanged and an hour old'],
    ['schedule', same({ generated_at: hoursBefore(23.5) }), false, 'unchanged and 23.5 h old'],
    ['schedule', same({ generated_at: hoursBefore(25) }), true, 'unchanged but 25 h old'],
    ['schedule', same({ generated_at: undefined }), true, 'live generated_at missing'],
    ['schedule', same({ content_hash: 'b'.repeat(64) }), true, 'content changed'],
    ['schedule', same({ site_rev: 'r2' }), true, 'site changed'],
    ['schedule', fail, true, 'live unreadable']
  ];
  for (const [event, read, expected, what] of cases) {
    const result = await decide({ event, meta, live: 'https://example.invalid/meta.json' }, read);
    check(result.deploy === expected && result.reason, 'deploy decision (' + what + ') should be ' + expected);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const siteDir = path.resolve(ROOT, args.site);
  await checkDeployDecision();
  checkPlain();
  checkXmlChecker();
  checkTemplate();
  checkConfig();
  checkSite(siteDir, args.live);
  if (failures.length) {
    failures.slice(0, 200).forEach((failure) => console.error('FAIL: ' + failure));
    console.error(failures.length + ' of ' + checks + ' site checks failed');
    process.exit(1);
  }
  console.log(checks + ' site checks passed (' + (path.relative(process.cwd(), siteDir) || '.') + (args.live ? ', live mode' : '') + ')');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('forum-check: ' + error.stack);
    process.exit(1);
  });
}

module.exports = { xmlError, siteText, ownMarkers, scriptInMarkup, markupUrls };

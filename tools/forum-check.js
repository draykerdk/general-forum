#!/usr/bin/env node
'use strict';

/*
 * Validates the built site and the repository configuration it depends on.
 *
 *   node tools/forum-check.js [--site _site]
 *
 * Run after a build (npm run build:fixture or npm run build). It checks the
 * pages written by tools/prerender.js, the sitemap and feeds, the template
 * contract in index.html, the issue form field ids and the workflows.
 * UI behaviour is not tested here.
 */

const fs = require('fs');
const path = require('path');
const pre = require('./prerender');

const ROOT = path.join(__dirname, '..');
const BASE = pre.BASE;
const SUFFIX = ' — Drayker Forum';
const FORBIDDEN = [/Dknowledger/i, /open[\s-]source/i, /organization’s|organization's/i, /\b(MEMBER|OWNER|CONTRIBUTOR|COLLABORATOR)\b/];
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));

const failures = [];
let checks = 0;
const check = (condition, message) => { checks++; if (!condition) failures.push(message); return Boolean(condition); };

function parseArgs(argv) {
  const args = { site: '_site' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site') args.site = argv[++i];
    else throw new Error('Unknown argument: ' + argv[i]);
  }
  return args;
}

const read = (file) => fs.readFileSync(file, 'utf8');
const exists = (file) => fs.existsSync(file);
const decode = (s) => String(s)
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

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
// GitHub), <style> blocks and comments, and returns the remaining text.
function siteText(html) {
  const out = [];
  let skip = 0;
  const stack = [];
  const re = /<!--[\s\S]*?-->|<style\b[\s\S]*?<\/style>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) { if (!skip) out.push(m[4]); continue; }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      while (stack.length) {
        const top = stack.pop();
        if (top.skip) skip--;
        if (top.tag === tag) break;
      }
      out.push(' ');
      continue;
    }
    if (VOID.has(tag) || /\/\s*$/.test(m[3])) { out.push(' '); continue; }
    const cls = /\bclass="([^"]*)"/.exec(m[3]);
    const isUgc = Boolean(cls && cls[1].split(/\s+/).includes('ugc'));
    stack.push({ tag, skip: isUgc });
    if (isUgc) skip++;
    out.push(' ');
  }
  return decode(out.join('')).replace(/\s+/g, ' ').trim();
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

function checkConfig() {
  const proposal = read(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'proposal.yml'));
  for (const id of ['summary', 'change', 'component']) check(proposal.includes('id: ' + id), 'proposal form is missing field id ' + id);
  check(!/the project should/i.test(proposal), 'proposal form still says "the project"');
  check(!proposal.includes('postUrl()'), 'proposal form comment still names postUrl()');

  const site = read(path.join(ROOT, '.github', 'workflows', 'forum-site.yml'));
  check(site.includes('tools/build-forum-snapshot.js') && site.includes('--out _site'), 'site workflow does not build the snapshot into _site');
  check(site.includes('tools/prerender.js'), 'site workflow does not prerender');
  check(site.includes('npm test'), 'site workflow does not run the tests');
  check(/actions\/upload-pages-artifact@v4[\s\S]*?path:\s*_site\b/.test(site), 'site workflow must upload _site with upload-pages-artifact@v4');
  check(site.includes('actions/deploy-pages@v4'), 'site workflow does not deploy with deploy-pages@v4');
  check(site.includes('pages: write') && site.includes('id-token: write') && site.includes('contents: read'), 'site workflow permissions are incomplete');
  check(site.includes("cron: '7,22,37,52 * * * *'"), 'site workflow schedule is not every 15 minutes');
  check(site.includes('tools/deploy-decision.js') && site.includes('https://forum.drayker.org/data/meta.json'), 'site workflow does not compare the deployed meta.json');
  check(/if:\s*steps\.decide\.outputs\.deploy == 'true'\s*\n\s*uses: actions\/upload-pages-artifact@v4/.test(site), 'site workflow uploads the artifact without a deploy decision');
  check(/if:\s*needs\.build\.outputs\.deploy == 'true'/.test(site), 'deploy job does not depend on the deploy decision');
  const decision = read(path.join(ROOT, 'tools', 'deploy-decision.js'));
  check(decision.includes('content_hash') && decision.includes('site_rev'), 'deploy decision does not compare content_hash and site_rev');
  check(/group:\s*github-pages/.test(site) && /cancel-in-progress:\s*false/.test(site), 'site workflow concurrency changed');

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

function checkSite(siteDir) {
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
      for (const m of part.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
        check(/^(\/|https?:\/\/|mailto:|#)/.test(m[1]) && !m[1].startsWith('//'), label + ' has a relative URL: ' + m[1]);
      }
    }
    check(region.startsWith('<div id="forum-static"><style>') && region.endsWith('</div>'), label + ' static region is not a single #forum-static block');
    const text = siteText(region);
    const allText = decode(region.replace(/<style\b[\s\S]*?<\/style>/g, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    check(allText.length > 80, label + ' static region is empty');
    check(!allText.includes('{{'), label + ' static region shows a raw template expression');
    check(!/<script\b/i.test(region) && !/\son[a-z]+\s*=/i.test(region) && !/javascript:/i.test(region), label + ' static region contains script');
    check(!/\s(?:style|data-[\w-]+|id)="/.test(region.replace(/<div id="forum-static">/, '').replace(/<li class="fs-comment" id="comment-\d+">/g, '')), label + ' static region has attributes outside the policy');
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
      check(title === pre.plain(t.title) + SUFFIX, label + ' title is not the full thread title');
      const post = byType('DiscussionForumPosting')[0];
      if (check(post, label + ' has no DiscussionForumPosting')) {
        check(post.url === p.url && post.headline === pre.plain(t.title), label + ' posting url or headline is wrong');
        check(post.datePublished === t.created && post.dateModified === t.at, label + ' posting dates are wrong');
        check(post.author && post.author['@type'] === 'Person' && post.author.name === t.user && post.author.url === 'https://github.com/' + t.user, label + ' posting author is wrong');
        check(typeof post.text === 'string' && post.text.length <= 1000, label + ' posting text is missing or too long');
        check(post.commentCount === detail.comments.length && Array.isArray(post.comment) && post.comment.length === detail.comments.length, label + ' comment count is wrong');
        check((post.comment || []).every((c) => c['@type'] === 'Comment' && c.author && c.author.name && c.datePublished && typeof c.text === 'string' && c.text.length <= 500 && c.url), label + ' comments are incomplete');
        check(post.isPartOf && post.isPartOf['@id'] === BASE + '#website' && post.mainEntityOfPage, label + ' posting is not linked to the site');
      }
      check(region.includes('href="' + t.url + '#new_comment_field">Reply on GitHub</a>'), label + ' has no Reply on GitHub link');
      check((region.match(/<li class="fs-comment"/g) || []).length === detail.comments.length, label + ' does not show every comment');
      check(region.includes('<div class="fs-body ugc">' + (detail.html ? resanitize(detail.html) : '')) || !detail.html, label + ' does not show the sanitized body');
      for (const r of t.refs || []) check(region.includes(r.url) || r.kind === 'issue', label + ' does not list the back-link ' + r.repo + '#' + r.num);
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
    }
    if (p.kind === 'routing') {
      for (const r of forum.repos) check(region.includes('href="' + r.url + '"'), label + ' does not list repository ' + r.name);
    }
    if (p.kind === 'new' || p.kind === 'about') {
      check(region.includes('https://github.com/draykerdk/general-forum/issues/new/choose'), label + ' does not link the GitHub issue forms');
    }
    if (p.kind === 'notfound') {
      check(region.includes('href="/"') && region.includes('href="https://github.com/draykerdk"') && /last update/i.test(text), label + ' does not explain the missing page');
    }
  }

  // Every data fragment must be a fixed point of the sanitizer.
  let fragments = 0;
  let unstable = 0;
  for (const t of forum.threads) {
    const file = at('data/t/' + t.slug + '/' + t.num + '.json');
    if (!check(exists(file), 'missing thread data ' + t.slug + '/' + t.num)) continue;
    const detail = JSON.parse(read(file));
    for (const html of [detail.html].concat(detail.comments.map((c) => c.html))) {
      fragments++;
      if (resanitize(html) !== html) unstable++;
    }
  }
  check(unstable === 0, unstable + ' of ' + fragments + ' HTML fragments change when sanitized again');

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
    { file: 'feed.xml', count: Math.min(pre.FEED_MAX, forum.threads.length), idRe: /^https:\/\/github\.com\/draykerdk\/[^/]+\/issues\/\d+$/ },
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
        check(!/<script\b/i.test(html) && !/\son[a-z]+\s*=/i.test(html) && !/javascript:/i.test(html), f.file + ' entry content contains script: ' + id);
        for (const m of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) check(/^(https?:\/\/|mailto:|#)/.test(m[1]), f.file + ' entry content has a relative URL: ' + m[1]);
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
}

async function checkDeployDecision() {
  const { decide } = require('./deploy-decision');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-deploy-'));
  const meta = path.join(dir, 'meta.json');
  fs.writeFileSync(meta, JSON.stringify({ content_hash: 'a'.repeat(64), site_rev: 'r1' }));
  const live = (value) => async () => value;
  const fail = async () => { throw new Error('offline'); };
  const cases = [
    ['push', live({ content_hash: 'a'.repeat(64), site_rev: 'r1' }), true],
    ['workflow_dispatch', live({ content_hash: 'a'.repeat(64), site_rev: 'r1' }), true],
    ['schedule', live({ content_hash: 'a'.repeat(64), site_rev: 'r1' }), false],
    ['schedule', live({ content_hash: 'b'.repeat(64), site_rev: 'r1' }), true],
    ['schedule', live({ content_hash: 'a'.repeat(64), site_rev: 'r2' }), true],
    ['schedule', fail, true]
  ];
  for (const [event, read, expected] of cases) {
    const result = await decide({ event, meta, live: 'https://example.invalid/meta.json' }, read);
    check(result.deploy === expected && result.reason, 'deploy decision for ' + event + ' should be ' + expected);
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
  checkSite(siteDir);
  if (failures.length) {
    failures.slice(0, 200).forEach((failure) => console.error('FAIL: ' + failure));
    console.error(failures.length + ' of ' + checks + ' site checks failed');
    process.exit(1);
  }
  console.log(checks + ' site checks passed (' + path.relative(process.cwd(), siteDir) + ')');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('forum-check: ' + error.stack);
    process.exit(1);
  });
}

module.exports = { xmlError, siteText };

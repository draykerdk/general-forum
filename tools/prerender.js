#!/usr/bin/env node
'use strict';

/*
 * Builds the static site from index.html and the forum snapshot.
 *
 *   node tools/prerender.js [--out _site] [--data <out>/data]
 *
 * Copies the public sources (index.html as the template, support.js, assets/,
 * favicon.ico, robots.txt, llms.txt, CNAME) into <out> and writes one page per
 * route: /, /new/, /decisions/, /routing/, /about/, /t/<slug>/<num>/ for every
 * thread in the snapshot, and /404.html. Each page is index.html with its head
 * tags rewritten and the static region between FORUM_STATIC_START and
 * FORUM_STATIC_END filled with readable HTML that works without JavaScript.
 * Also writes sitemap.xml, feed.xml and decisions/feed.xml.
 *
 * All text is escaped. The only HTML inserted as-is is issue and comment HTML,
 * which is passed through the sanitizer again here.
 *
 * A thread of kind 'pr' is an assembly report of the federation (daf): its page
 * carries the fixed assembly notice and tags each comment that holds a vote. No
 * page ever counts votes or shows a total, a weight, a quorum or an outcome.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sanitizeHtml, htmlToText } = require('./lib/sanitize');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://forum.drayker.org/';
const ORG = 'draykerdk';
const SITE = 'Drayker Forum';
const SUFFIX = ' — ' + SITE;
const START = '<!-- FORUM_STATIC_START -->';
const END = '<!-- FORUM_STATIC_END -->';
const EMPTY_REGION = START + END;
const NEW_THREAD = 'https://github.com/' + ORG + '/general-forum/issues/new/choose';
const PUBLIC_SOURCES = ['index.html', 'support.js', 'assets', 'favicon.ico', 'robots.txt', 'llms.txt', 'CNAME'];
const GENERATED = ['index.html', '404.html', 't', 'new', 'decisions', 'routing', 'about', 'sitemap.xml', 'feed.xml',
  'assets', 'support.js', 'favicon.ico', 'robots.txt', 'llms.txt', 'CNAME'];
const META_KEYS = ['list', 'thread', 'new', 'decisions', 'routing', 'about', 'notfound'];
const STATIC_ROUTES = [
  { path: '', key: 'list' },
  { path: 'new/', key: 'new' },
  { path: 'decisions/', key: 'decisions' },
  { path: 'routing/', key: 'routing' },
  { path: 'about/', key: 'about' }
];
const NAV = [
  { href: '/', label: 'Threads', key: 'list' },
  { href: '/decisions/', label: 'Decisions', key: 'decisions' },
  { href: '/routing/', label: 'Where things belong', key: 'routing' },
  { href: '/about/', label: 'About', key: 'about' },
  { href: '/new/', label: 'Start a thread', key: 'new' }
];
const SCHEMA = 3;
const DESCRIPTION_MAX = 180;
const FEED_MAX = 50;
// The assembly notice, word for word as index.html shows it.
const ASSEMBLY_NOTICE = 'Assembly report, proposed: nothing in it is in the record until the assembly accepts it. Voting is transitional. The tally is computed on GitHub by the federation’s Federation tally workflow, from the comments there, not from this page.';
const TALLY_WORKFLOW = 'https://github.com/' + ORG + '/daf/actions/workflows/federation-tally.yml';
const HIDDEN_VOTE_NOTE = 'Whether it holds a vote is not shown on this page.';
const WITHHELD_NOTE = 'Not shown on the forum. Read this reply on GitHub.';
// A merged assembly report on the Decisions page and in its feed: it is merged
// whether the assembly passed or failed, so no outcome is implied by the merge.
const ASSEMBLY_DECISION_NOTE = 'An assembly report is merged whether the assembly passed or failed. The outcome is written in the report on GitHub.';
const ASSEMBLY_TITLE = /^Assembly \d{4}-(0[1-9]|1[0-2])$/;
const isAssemblyDecision = (d) => d.repo === 'daf' && ASSEMBLY_TITLE.test(String(d.title || ''));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- text helpers

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Markdown-ish text to plain text: removes markdown syntax and collapses
// whitespace, keeping every word intact (well-founded, DFMP-000, snake_case,
// C#, #12 and a - b all survive).
function plain(value) {
  // Code spans are set aside first so that nothing inside them is touched.
  const codes = [];
  return String(value == null ? '' : value)
    .replace(/[]/g, '')
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => '' + (codes.push(code.trim()) - 1) + '')
    .replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+(?=\S)/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(\d+)/g, (m, i) => codes[Number(i)])
    .replace(/\s+/g, ' ')
    .trim();
}

// Characters XML 1.0 does not allow (C0 controls other than tab, newline and
// carriage return, U+FFFE, U+FFFF) and lone surrogates. With the u flag a
// surrogate pair is one code point, so only lone surrogates match the range.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/gu;
const xmlText = (value) => String(value == null ? '' : value).replace(XML_INVALID, '');

// Issue and pull request titles are plain text on GitHub: whitespace is
// collapsed and characters XML cannot carry are removed, nothing else is
// changed. A title left empty reads "(untitled)".
const titleText = (value) => xmlText(value).replace(/\s+/g, ' ').trim() || '(untitled)';

// Clips already-plain text to max characters at a word boundary, '…' when cut.
// A cut never splits a surrogate pair.
function clipText(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.5) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.\-–—]+$/, '') + '…';
}

// Markdown-ish text to plain text clipped at a word boundary.
const compact = (value, max) => clipText(plain(value), max);

function dateOf(iso) {
  const d = new Date(iso);
  return iso && !Number.isNaN(d.getTime()) ? d : null;
}
function fmtDate(iso) {
  const d = dateOf(iso);
  return d ? d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear() : '';
}
function fmtDateTime(iso) {
  const d = dateOf(iso);
  if (!d) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return fmtDate(iso) + ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
}
const time = (iso, text) => (iso ? '<time datetime="' + esc(iso) + '">' + esc(text || fmtDate(iso)) + '</time>' : '');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const isHttpUrl = (value) => /^https?:\/\/[^\s"'<>]+$/i.test(String(value || ''));
const byCreatedDesc = (a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0);

// ------------------------------------------------------------------- template

// Returns the source of the object (or array) literal that follows
// `const <name> =`, skipping strings, template literals and comments while
// matching brackets.
function literal(source, name, open, close) {
  const decl = new RegExp('const\\s+' + name + '\\s*=\\s*\\' + open);
  const m = decl.exec(source);
  if (!m) throw new Error('const ' + name + ' = ' + open + ' … ' + close + ' not found in index.html');
  const start = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('const ' + name + ' in index.html is not balanced');
}
const objectLiteral = (source, name) => literal(source, name, '{', '}');
const arrayLiteral = (source, name) => literal(source, name, '[', ']');

function readMeta(source) {
  const literal = objectLiteral(source, 'META');
  const meta = vm.runInNewContext('(' + literal + ')', Object.create(null), { timeout: 1000 });
  for (const key of META_KEYS) {
    const entry = meta && meta[key];
    if (!entry || typeof entry.t !== 'string' || typeof entry.d !== 'string') {
      throw new Error('META.' + key + ' with string t and d is missing in index.html');
    }
  }
  return meta;
}

// The routing table of index.html (ROUTES): [{ about, repos, form? }], where
// form is { label, href } for a route that also offers an issue form.
function readRoutes(source) {
  const routes = vm.runInNewContext('(' + arrayLiteral(source, 'ROUTES') + ')', Object.create(null), { timeout: 1000 });
  if (!Array.isArray(routes) || !routes.length) throw new Error('ROUTES is empty in index.html');
  for (const r of routes) {
    if (!r || typeof r.about !== 'string' || !Array.isArray(r.repos) || !r.repos.length || !r.repos.every((x) => typeof x === 'string')) {
      throw new Error('every ROUTES entry needs about and repos in index.html');
    }
    if (r.form !== undefined && !(r.form && typeof r.form.label === 'string' && /^https:\/\/github\.com\/[^\s"<>]+$/.test(String(r.form.href)))) {
      throw new Error('ROUTES form for "' + r.about + '" needs a label and a github.com href');
    }
  }
  return routes;
}

function checkTemplate(source) {
  const count = source.split(EMPTY_REGION).length - 1;
  if (count !== 1) throw new Error('index.html must contain ' + EMPTY_REGION + ' exactly once (found ' + count + ')');
  const required = [
    [/<title>[\s\S]*?<\/title>/, '<title>'],
    [/<meta name="description" content="[^"]*">/, 'meta description'],
    [/<link rel="canonical" href="[^"]*">/, 'canonical link'],
    [/<meta property="og:type" content="[^"]*">/, 'og:type'],
    [/<meta property="og:title" content="[^"]*">/, 'og:title'],
    [/<meta property="og:description" content="[^"]*">/, 'og:description'],
    [/<meta property="og:url" content="[^"]*">/, 'og:url'],
    [/<meta name="twitter:title" content="[^"]*">/, 'twitter:title'],
    [/<meta name="twitter:description" content="[^"]*">/, 'twitter:description'],
    [/<script id="drayker-structured-data" type="application\/ld\+json">[\s\S]*?<\/script>/, 'structured data script']
  ];
  for (const [re, label] of required) if (!re.test(source)) throw new Error('index.html is missing its ' + label);
}

// ------------------------------------------------------------------ snapshot

function readSnapshot(dataDir) {
  const file = path.join(dataDir, 'forum.json');
  if (!fs.existsSync(file)) throw new Error('snapshot not found: ' + file + ' (run the data build first)');
  const forum = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (forum.schema !== SCHEMA) throw new Error('unsupported snapshot schema: ' + forum.schema);
  const details = new Map();
  for (const thread of forum.threads) {
    const threadFile = path.join(dataDir, 't', thread.slug, thread.num + '.json');
    if (!fs.existsSync(threadFile)) throw new Error('thread file missing: ' + threadFile);
    details.set(thread.slug + '/' + thread.num, JSON.parse(fs.readFileSync(threadFile, 'utf8')));
  }
  return { forum, details };
}

const threadPath = (slug, num) => '/t/' + encodeURIComponent(slug) + '/' + Number(num) + '/';

// Sanitizes snapshot HTML again, so that the result is the build output when
// the snapshot is intact. Two parts of the policy are not idempotent and are
// handled for the second pass: headings were already demoted (h3..h5 are
// promoted back one level first), and the forum links the build wrote
// (/t/<slug>/<num>/ for threads that have a page) are kept as they are
// (ctx.internalPath). Any other link is treated as on the first pass, so a
// user's link to https://github.com/t/... stays on github.com.
function makeResanitize(forum) {
  const known = new Map();
  for (const t of forum.threads) known.set(t.repo.toLowerCase() + '#' + t.num, t.slug);
  const pages = new Set(forum.threads.map((t) => t.slug + '/' + t.num));
  const ctx = {
    org: ORG,
    threadExists: (repo, num) => known.get(String(repo).toLowerCase() + '#' + Number(num)) || null,
    internalPath: (slug, num) => pages.has(slug + '/' + Number(num))
  };
  const promote = (html) => String(html || '').replace(/<(\/?)h([3-5])(?=[\s/>])/gi, (m, slash, n) => '<' + slash + 'h' + (Number(n) - 1));
  return (html) => sanitizeHtml(promote(html), ctx);
}

// ---------------------------------------------------------------- head tags

function structuredData(page) {
  const websiteId = BASE + '#website';
  const graph = [
    {
      '@type': 'Organization', '@id': 'https://drayker.com/#organization', name: 'Drayker',
      url: 'https://drayker.com/',
      logo: { '@type': 'ImageObject', url: 'https://drayker.org/assets/logo/kit/icon-512.png', width: 512, height: 512 },
      sameAs: ['https://github.com/draykerdk', 'https://twitter.com/Draykerdk', 'https://medium.com/drayker']
    },
    {
      '@type': 'WebSite', '@id': websiteId, name: SITE, alternateName: 'Drayker Public Forum',
      url: BASE, publisher: { '@id': 'https://drayker.com/#organization' }, inLanguage: 'en'
    }
  ];
  const url = page.url;
  const pageId = (url || BASE + '404.html') + '#webpage';
  const webPage = { '@type': page.kind === 'list' ? 'CollectionPage' : 'WebPage', '@id': pageId };
  if (url) webPage.url = url;
  Object.assign(webPage, { name: page.title, description: page.description, isPartOf: { '@id': websiteId }, inLanguage: 'en' });
  if (page.kind === 'thread') {
    const t = page.thread;
    const d = page.detail;
    graph.push({
      '@type': 'DiscussionForumPosting', '@id': url + '#posting', url,
      headline: titleText(t.title), text: clipText(t.text, 1000),
      datePublished: t.created, dateModified: t.at,
      author: { '@type': 'Person', name: t.user, url: 'https://github.com/' + encodeURIComponent(t.user) },
      commentCount: d.comments.length,
      // A comment hidden on GitHub counts, but nothing of it is described.
      comment: d.comments.filter((c) => !c.hidden).map((c) => ({
        '@type': 'Comment',
        author: { '@type': 'Person', name: c.user, url: 'https://github.com/' + encodeURIComponent(c.user) },
        datePublished: c.created, text: clipText(htmlToText(c.html), 500), url: c.url
      })),
      isPartOf: { '@id': websiteId }, mainEntityOfPage: { '@id': pageId },
      sameAs: t.url, inLanguage: 'en'
    });
    webPage.about = { '@id': url + '#posting' };
  } else if (page.kind === 'list') {
    const newest = page.forum.threads.slice().sort(byCreatedDesc).slice(0, FEED_MAX);
    webPage.about = { '@id': 'https://drayker.com/#organization' };
    webPage.mainEntity = {
      '@type': 'ItemList', numberOfItems: newest.length, itemListOrder: 'https://schema.org/ItemListOrderDescending',
      itemListElement: newest.map((t, i) => ({ '@type': 'ListItem', position: i + 1, url: BASE + threadPath(t.slug, t.num).slice(1), name: titleText(t.title) }))
    };
  } else {
    webPage.about = { '@id': 'https://drayker.com/#organization' };
  }
  graph.push(webPage);
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function rewriteHead(template, page) {
  const title = esc(page.title);
  const description = esc(page.description);
  let html = template
    .replace(/<title>[\s\S]*?<\/title>/, () => '<title>' + title + '</title>')
    .replace(/(<meta name="description" content=")[^"]*(">)/, (m, a, b) => a + description + b)
    .replace(/(<meta property="og:type" content=")[^"]*(">)/, (m, a, b) => a + (page.kind === 'thread' ? 'article' : 'website') + b)
    .replace(/(<meta property="og:title" content=")[^"]*(">)/, (m, a, b) => a + title + b)
    .replace(/(<meta property="og:description" content=")[^"]*(">)/, (m, a, b) => a + description + b)
    .replace(/(<meta property="og:url" content=")[^"]*(">)/, (m, a, b) => a + (page.url || BASE) + b)
    .replace(/(<meta name="twitter:title" content=")[^"]*(">)/, (m, a, b) => a + title + b)
    .replace(/(<meta name="twitter:description" content=")[^"]*(">)/, (m, a, b) => a + description + b)
    .replace(/(<script id="drayker-structured-data" type="application\/ld\+json">)[\s\S]*?(<\/script>)/, (m, a, b) => a + structuredData(page) + b);
  if (page.url) {
    html = html.replace(/(<link rel="canonical" href=")[^"]*(">)/, (m, a, b) => a + page.url + b);
  } else {
    html = html
      .replace(/[ \t]*<link rel="canonical" href="[^"]*">\r?\n?/, '')
      .replace(/<meta name="description"/, () => '<meta name="robots" content="noindex">\n<meta name="description"');
  }
  return html;
}

// ------------------------------------------------------------- static region

// Scoped to #forum-static and independent of the app's CSS variables, which
// only exist after JavaScript runs.
const STYLE = [
  '#forum-static{--fs-bg:#08080A;--fs-fg:#EDECF0;--fs-muted:#9898A8;--fs-accent:#FF5500;--fs-link:#FF5500;--fs-line:rgba(237,236,240,.16);--fs-soft:rgba(237,236,240,.07);',
  'color:var(--fs-fg);background:var(--fs-bg);font:16px/1.6 Archivo,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;min-height:100vh;-webkit-text-size-adjust:100%}',
  '@media (prefers-color-scheme: light){#forum-static{--fs-bg:#FAF8F5;--fs-fg:#14141A;--fs-muted:#56545F;--fs-link:#B83D00;--fs-line:rgba(20,20,26,.16);--fs-soft:rgba(20,20,26,.05)}}',
  'html:not(.js) body,html.fs-fallback body{margin:0;background:#08080A}',
  '@media (prefers-color-scheme: light){html:not(.js) body,html.fs-fallback body{background:#FAF8F5}}',
  '#forum-static *{box-sizing:border-box}',
  '#forum-static .fs-wrap{max-width:48rem;margin:0 auto;padding:0 16px}',
  '#forum-static a{color:var(--fs-link);text-underline-offset:2px}',
  '#forum-static a:focus-visible{outline:2px solid var(--fs-accent);outline-offset:2px}',
  '#forum-static .fs-top{border-bottom:1px solid var(--fs-line)}',
  '#forum-static .fs-top .fs-wrap{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 24px;padding-top:16px;padding-bottom:16px}',
  '#forum-static .fs-brand{color:var(--fs-fg);font-weight:700;text-decoration:none;letter-spacing:.01em}',
  '#forum-static .fs-brand span{color:var(--fs-accent)}',
  '#forum-static .fs-nav ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 18px;font-size:.9375rem}',
  '#forum-static .fs-nav a{color:var(--fs-muted);text-decoration:none}',
  '#forum-static .fs-nav a:hover,#forum-static .fs-nav a[aria-current]{color:var(--fs-fg);text-decoration:underline}',
  '#forum-static main{padding-bottom:32px}',
  '#forum-static h1{font-size:1.875rem;line-height:1.2;margin:32px 0 12px;overflow-wrap:anywhere}',
  '#forum-static h2{font-size:1.25rem;line-height:1.3;margin:32px 0 8px}',
  '#forum-static .fs-lead{font-size:1.0625rem;margin:0 0 12px}',
  '#forum-static .fs-meta{color:var(--fs-muted);font-size:.875rem;margin:4px 0 0}',
  '#forum-static .fs-list{list-style:none;margin:16px 0 0;padding:0}',
  '#forum-static .fs-list>li{padding:12px 0;border-bottom:1px solid var(--fs-line)}',
  '#forum-static .fs-list>li>a:first-child{color:var(--fs-fg);font-weight:600;text-decoration:none;overflow-wrap:anywhere}',
  '#forum-static .fs-list>li>a:first-child:hover{text-decoration:underline}',
  '#forum-static .fs-list>li>p{margin:4px 0 0}',
  '#forum-static .fs-sub{list-style:none;margin:4px 0 0;padding:0;font-size:.875rem}',
  '#forum-static .fs-state{display:inline-block;padding:0 6px;border:1px solid var(--fs-line);border-radius:4px;font-size:.75rem;line-height:1.5;text-transform:uppercase;letter-spacing:.04em}',
  '#forum-static .fs-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;margin:20px 0}',
  '#forum-static .fs-locked{color:var(--fs-muted)}',
  '#forum-static .fs-button{display:inline-block;padding:8px 14px;border:1px solid var(--fs-link);border-radius:6px;font-weight:600;text-decoration:none}',
  '#forum-static .fs-body{overflow-wrap:anywhere}',
  '#forum-static .fs-body img{max-width:100%;height:auto}',
  '#forum-static .fs-body pre{overflow:auto;padding:12px;border-radius:6px;background:var(--fs-soft);font-size:.875rem;line-height:1.5}',
  '#forum-static .fs-body code,#forum-static .fs-body kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}',
  '#forum-static .fs-body :not(pre)>code{padding:1px 4px;border-radius:4px;background:var(--fs-soft)}',
  '#forum-static .fs-body blockquote{margin:0 0 16px;padding:0 0 0 12px;border-left:3px solid var(--fs-line);color:var(--fs-muted)}',
  '#forum-static .fs-body table{display:block;overflow:auto;border-collapse:collapse;margin:0 0 16px}',
  '#forum-static .fs-body th,#forum-static .fs-body td{border:1px solid var(--fs-line);padding:4px 8px}',
  '#forum-static .fs-body h3,#forum-static .fs-body h4,#forum-static .fs-body h5,#forum-static .fs-body h6{line-height:1.3;margin:24px 0 8px}',
  '#forum-static .fs-body .task-list-item{list-style:none}',
  '#forum-static .fs-comments{list-style:none;margin:0;padding:0}',
  '#forum-static .fs-comment{border-top:1px solid var(--fs-line);padding:16px 0 4px}',
  '#forum-static .fs-comment header{font-size:.875rem;color:var(--fs-muted);margin-bottom:8px}',
  '#forum-static .fs-comment header a:first-child{color:var(--fs-fg);font-weight:600}',
  '#forum-static .fs-foot{border-top:1px solid var(--fs-line);color:var(--fs-muted);font-size:.875rem;padding:24px 0 40px}',
  '#forum-static .fs-foot p{margin:0 0 8px}'
].join('');

function header(activeKey) {
  const items = NAV.map((n) => '<li><a href="' + n.href + '"' + (n.key === activeKey ? ' aria-current="page"' : '') + '>' + esc(n.label) + '</a></li>').join('');
  return '<header class="fs-top"><div class="fs-wrap"><a class="fs-brand" href="/">Drayker <span>·</span> forum</a>'
    + '<nav class="fs-nav" aria-label="Forum"><ul>' + items + '</ul></nav></div></header>';
}

function footer(forum) {
  return '<footer class="fs-foot"><div class="fs-wrap">'
    + '<p>Read from public issues and pull requests at <a href="https://github.com/' + ORG + '">github.com/' + ORG + '</a>. Publishing and replying happen on GitHub.</p>'
    + '<p>Last update ' + time(forum.generated_at, fmtDateTime(forum.generated_at)) + ' · <a href="/feed.xml">Threads feed</a> · <a href="/decisions/feed.xml">Decisions feed</a> · <a href="https://drayker.org/">drayker.org</a></p>'
    + '</div></footer>';
}

function region(forum, activeKey, mainHtml) {
  return '<div id="forum-static"><style>' + STYLE + '</style>' + header(activeKey)
    + '<main class="fs-wrap">' + mainHtml + '</main>' + footer(forum) + '</div>';
}

const heading = (meta) => (meta.t.endsWith(SUFFIX) ? meta.t.slice(0, -SUFFIX.length) : meta.t);
const stateLabel = (t) => (t.open ? 'open' : t.state_reason === 'not_planned' ? 'closed, not planned' : 'closed');

// Elements with class "ugc" hold text mirrored from GitHub (titles, bodies,
// comments, descriptions); everything else is the site's own wording.
function listMain(forum, meta) {
  const c = forum.counts;
  const rows = forum.threads.map((t) => '<li><a class="ugc" href="' + threadPath(t.slug, t.num) + '">' + esc(titleText(t.title)) + '</a>'
    + '<p class="fs-meta">' + esc(t.repo) + ' #' + t.num + ' · <span class="fs-state">' + esc(t.open ? 'open' : 'closed') + '</span> · '
    + esc(plural(t.comments, 'reply', 'replies')) + ' · last activity ' + time(t.at) + '</p></li>').join('');
  return '<h1>' + esc(meta.list.t) + '</h1>'
    + '<p class="fs-lead">' + esc(meta.list.d) + '</p>'
    + '<p class="fs-meta">' + esc(plural(c.threads, 'thread', 'threads') + ', ' + c.open + ' open, across ' + plural(c.repos, 'repository', 'repositories') + '.') + '</p>'
    + '<p class="fs-actions"><a class="fs-button" href="' + NEW_THREAD + '">Start a thread on GitHub</a></p>'
    + '<ol class="fs-list">' + rows + '</ol>';
}

function threadMain(forum, thread, detail, resanitize) {
  const lookup = new Map(forum.threads.map((t) => [t.repo.toLowerCase() + '#' + t.num, t]));
  // GitHub logins are mirrored text, so they are marked ugc like titles and bodies.
  const person = (login) => '<a class="ugc" href="https://github.com/' + encodeURIComponent(login) + '">' + esc(login) + '</a>';
  const meta = [
    esc(thread.repo) + ' #' + thread.num,
    '<span class="fs-state">' + esc(stateLabel(thread)) + '</span>',
    'opened by ' + person(thread.user) + ' on ' + time(thread.created),
    esc(plural(detail.comments.length, 'reply', 'replies')),
    'last activity ' + time(thread.at)
  ].join(' · ');
  const labels = thread.labels && thread.labels.length ? '<p class="fs-meta">Labels: <span class="ugc">' + esc(thread.labels.join(', ')) + '</span></p>' : '';
  const body = detail.html ? resanitize(detail.html) : '<p><em>No description was written.</em></p>';
  const assembly = thread.kind === 'pr';
  // A comment hidden on GitHub shows only its author, date and the reason. On
  // an assembly report, a comment that holds a vote is tagged with it; a
  // comment with nothing to show (the federation's tally) points to GitHub.
  const comments = detail.comments.map((c) => '<li class="fs-comment" id="comment-' + Number(c.id) + '"><article>'
    + '<header>' + person(c.user) + ' · <a href="' + esc(c.url) + '">' + time(c.created) + '</a>'
    + (!c.hidden && c.updated && c.updated !== c.created ? ' · edited' : '') + '</header>'
    + (c.hidden
      ? '<p class="fs-meta">' + esc('Hidden on GitHub (' + c.hidden + ')') + '</p>'
        + (assembly ? '<p class="fs-meta">' + esc(HIDDEN_VOTE_NOTE) + '</p>' : '')
      : assembly && !c.html
        ? '<p class="fs-meta">' + esc(WITHHELD_NOTE) + '</p>'
        : (assembly && c.vote ? '<p class="fs-meta">' + esc('Vote: ' + c.vote.vote + ' · as ') + '<span class="ugc">' + esc(c.vote.as) + '</span></p>' : '')
          + '<div class="fs-body ugc">' + resanitize(c.html) + '</div>')
    + '</article></li>').join('');
  const notice = assembly
    ? '<section aria-label="Assembly report"><p>' + esc(ASSEMBLY_NOTICE) + '</p>'
      + '<p class="fs-meta"><a href="' + esc(thread.url) + '">The pull request on GitHub</a> · <a href="' + esc(TALLY_WORKFLOW) + '">The Federation tally workflow</a></p></section>'
    : '';
  const refs = (thread.refs || []).map((r) => {
    const local = r.kind === 'issue' ? lookup.get(String(r.repo).toLowerCase() + '#' + r.num) : null;
    const href = local ? threadPath(local.slug, local.num) : r.url;
    const what = (r.kind === 'pr' ? 'Pull request ' : 'Issue ') + r.repo + ' #' + r.num;
    const status = r.kind === 'pr' && r.merged ? 'merged ' + fmtDate(r.merged) : r.state;
    return '<li><a class="ugc" href="' + esc(href) + '">' + esc(titleText(r.title)) + '</a><p class="fs-meta">' + esc(what + ' · ' + status) + '</p></li>';
  }).join('');
  return '<p class="fs-meta"><a href="/">All threads</a></p>'
    + '<article>'
    + '<h1 class="ugc">' + esc(titleText(thread.title)) + '</h1>'
    + '<p class="fs-meta">' + meta + '</p>' + labels
    + '<div class="fs-body ugc">' + body + '</div>'
    + '</article>'
    + (thread.locked
      ? '<p class="fs-actions"><span class="fs-locked">Conversation locked on GitHub</span>'
        + '<a class="fs-button" href="' + esc(thread.url) + '">Read on GitHub</a></p>'
      : '<p class="fs-actions"><a class="fs-button" href="' + esc(thread.url) + '#new_comment_field">Reply on GitHub</a>'
        + '<a href="' + esc(thread.url) + '">Read on GitHub</a></p>')
    + notice
    + '<section aria-label="Replies"><h2>' + esc(plural(detail.comments.length, 'reply', 'replies')) + '</h2>'
    + (comments ? '<ol class="fs-comments">' + comments + '</ol>' : '<p class="fs-meta">No replies yet.</p>') + '</section>'
    + (refs ? '<section aria-label="Referenced by"><h2>Referenced by</h2><ul class="fs-list">' + refs + '</ul></section>' : '');
}

function decisionsMain(forum, meta) {
  const lookup = new Map(forum.threads.map((t) => [t.slug + '/' + t.num, t]));
  const groups = [];
  for (const d of forum.decisions) {
    const month = String(d.merged || '').slice(0, 7);
    if (!groups.length || groups[groups.length - 1].month !== month) groups.push({ month, items: [] });
    groups[groups.length - 1].items.push(d);
  }
  const monthName = (m) => (/^\d{4}-\d{2}$/.test(m) ? MONTHS[Number(m.slice(5)) - 1] + ' ' + m.slice(0, 4) : 'Undated');
  const body = groups.map((g) => '<section><h2>' + esc(monthName(g.month)) + '</h2><ul class="fs-list">'
    + g.items.map((d) => {
      const threads = (d.threads || []).map((r) => lookup.get(r.slug + '/' + r.num)).filter(Boolean)
        .map((t) => '<li>Thread: <a class="ugc" href="' + threadPath(t.slug, t.num) + '">' + esc(titleText(t.title)) + '</a></li>').join('');
      return '<li><a class="ugc" href="' + esc(d.url) + '">' + esc(titleText(d.title)) + '</a>'
        + '<p class="fs-meta">' + esc(d.repo) + ' #' + d.num + ' · merged ' + time(d.merged) + ' · by <span class="ugc">' + esc(d.user) + '</span></p>'
        + (isAssemblyDecision(d) ? '<p>' + esc(ASSEMBLY_DECISION_NOTE) + '</p>' : '')
        + (threads ? '<ul class="fs-sub">' + threads + '</ul>' : '') + '</li>';
    }).join('') + '</ul></section>').join('');
  return '<h1>' + esc(heading(meta.decisions)) + '</h1>'
    + '<p class="fs-lead">' + esc(meta.decisions.d) + '</p>'
    + '<p class="fs-meta">' + esc(plural(forum.counts.decisions, 'merged pull request', 'merged pull requests') + ', newest first.') + '</p>'
    + body;
}

function routingMain(forum, meta, routes) {
  const routeRows = routes.map((r) => {
    const links = r.repos.map((repo) => '<a href="https://github.com/' + ORG + '/' + esc(repo) + '/issues">' + esc(ORG + '/' + repo) + '</a>');
    if (r.form) links.push('<a href="' + esc(r.form.href) + '">' + esc('or ' + r.form.label) + '</a>');
    return '<li><p>' + esc(r.about) + '</p><p class="fs-meta">' + links.join(' · ') + '</p></li>';
  }).join('');
  const rows = forum.repos.map((r) => {
    const links = [
      '<a href="' + esc(r.url) + '/issues">Issues on GitHub</a>',
      '<a href="' + esc(r.url) + '/issues/new/choose">Open an issue here</a>'
    ];
    if (isHttpUrl(r.homepage)) links.push('<a class="ugc" href="' + esc(r.homepage) + '">' + esc(String(r.homepage).replace(/^https?:\/\//i, '').replace(/\/$/, '')) + '</a>');
    return '<li><a class="ugc" href="' + esc(r.url) + '">' + esc(r.name) + '</a>'
      + (r.description ? '<p class="ugc">' + esc(r.description) + '</p>' : '')
      + '<p class="fs-meta">' + esc(plural(r.threads, 'thread', 'threads') + ', ' + r.open + ' open') + ' · ' + links.join(' · ') + '</p></li>';
  }).join('');
  return '<h1>' + esc(heading(meta.routing)) + '</h1>'
    + '<p class="fs-lead">' + esc(meta.routing.d) + '</p>'
    + '<h2>Where each subject belongs</h2>'
    + '<ul class="fs-list">' + routeRows + '</ul>'
    + '<h2>Every repository this forum reads</h2>'
    + '<ul class="fs-list">' + rows + '</ul>';
}

function textMain(meta, key) {
  return '<h1>' + esc(heading(meta[key])) + '</h1>'
    + '<p class="fs-lead">' + esc(meta[key].d) + '</p>'
    + '<p class="fs-actions"><a class="fs-button" href="' + NEW_THREAD + '">Choose a form on GitHub</a>'
    + '<a href="https://github.com/' + ORG + '">github.com/' + ORG + '</a></p>'
    + '<p>A subject that belongs to one component can be opened in that repository instead: see <a href="/routing/">where things belong</a>.</p>';
}

function notFoundMain(forum, meta) {
  return '<h1>' + esc(heading(meta.notfound)) + '</h1>'
    + '<p class="fs-lead">' + esc(meta.notfound.d) + '</p>'
    + '<p>The last update is from ' + time(forum.generated_at, fmtDateTime(forum.generated_at)) + '.</p>'
    + '<p class="fs-actions"><a class="fs-button" href="/">All threads</a><a href="https://github.com/' + ORG + '">github.com/' + ORG + '</a></p>';
}

// ------------------------------------------------------------------- feeds

const xmlEsc = (value) => xmlText(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Makes root-relative href and src attributes absolute. The sanitizer escapes
// '"' in text as &quot;, so only real attributes can match: mirrored prose
// such as href="/x" is never rewritten.
const absolutize = (html) => html.replace(/(href|src)="\/(?!\/)/g, (m, attr) => attr + '="' + BASE);

// Author names and category terms are mirrored text: an author name left
// empty reads "ghost" (GitHub's name for a deleted account), and an empty
// category is left out.
function author(name) {
  const clean = xmlText(name).trim() || 'ghost';
  return '    <author><name>' + xmlEsc(clean) + '</name><uri>https://github.com/' + xmlEsc(encodeURIComponent(clean)) + '</uri></author>\n';
}

function atom({ id, title, subtitle, self, alternate, entries, fallbackUpdated }) {
  const updated = entries.reduce((max, e) => (e.updated > max ? e.updated : max), '') || fallbackUpdated;
  return '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">\n'
    + '  <id>' + xmlEsc(id) + '</id>\n'
    + '  <title>' + xmlEsc(title) + '</title>\n'
    + '  <subtitle>' + xmlEsc(subtitle) + '</subtitle>\n'
    + '  <link rel="self" type="application/atom+xml" href="' + xmlEsc(self) + '"/>\n'
    + '  <link rel="alternate" type="text/html" href="' + xmlEsc(alternate) + '"/>\n'
    + '  <updated>' + xmlEsc(updated) + '</updated>\n'
    + '  <icon>' + BASE + 'favicon.ico</icon>\n'
    + entries.map((e) => '  <entry>\n'
      + '    <id>' + xmlEsc(e.id) + '</id>\n'
      + '    <title>' + xmlEsc(e.title) + '</title>\n'
      + '    <link rel="alternate" type="text/html" href="' + xmlEsc(e.link) + '"/>\n'
      + (e.related ? '    <link rel="related" type="text/html" href="' + xmlEsc(e.related) + '"/>\n' : '')
      + (e.published ? '    <published>' + xmlEsc(e.published) + '</published>\n' : '')
      + '    <updated>' + xmlEsc(e.updated) + '</updated>\n'
      + author(e.author)
      + (e.categories || []).map((c) => xmlText(c).trim()).filter(Boolean).map((c) => '    <category term="' + xmlEsc(c) + '"/>\n').join('')
      + '    <content type="html">' + xmlEsc(e.content) + '</content>\n'
      + '  </entry>\n').join('')
    + '</feed>\n';
}

function threadFeed(forum, details, resanitize) {
  const newest = forum.threads.slice().sort(byCreatedDesc).slice(0, FEED_MAX);
  return atom({
    id: BASE + 'feed.xml', title: 'Drayker Forum — threads',
    subtitle: 'The newest public threads across github.com/' + ORG + '.',
    self: BASE + 'feed.xml', alternate: BASE, fallbackUpdated: forum.generated_at,
    entries: newest.map((t) => {
      const d = details.get(t.slug + '/' + t.num);
      return {
        id: t.url, title: titleText(t.title), link: BASE + threadPath(t.slug, t.num).slice(1), related: t.url,
        published: t.created, updated: t.at, author: t.user, categories: [t.repo].concat(t.labels || []),
        content: absolutize(d && d.html ? resanitize(d.html) : '<p>' + esc(t.excerpt) + '</p>')
      };
    })
  });
}

function decisionFeed(forum) {
  const lookup = new Map(forum.threads.map((t) => [t.slug + '/' + t.num, t]));
  return atom({
    id: BASE + 'decisions/feed.xml', title: 'Drayker Forum — decisions',
    subtitle: 'The newest merged pull requests across github.com/' + ORG + '.',
    self: BASE + 'decisions/feed.xml', alternate: BASE + 'decisions/', fallbackUpdated: forum.generated_at,
    entries: forum.decisions.slice(0, FEED_MAX).map((d) => {
      const threads = (d.threads || []).map((r) => lookup.get(r.slug + '/' + r.num)).filter(Boolean)
        .map((t) => '<li><a href="' + BASE + threadPath(t.slug, t.num).slice(1) + '">' + esc(titleText(t.title)) + '</a></li>').join('');
      return {
        id: d.url, title: titleText(d.title), link: d.url, published: d.merged, updated: d.merged, author: d.user, categories: [d.repo],
        content: (d.excerpt ? '<p>' + esc(d.excerpt) + '</p>' : '') + '<p>' + esc(d.repo + ' #' + d.num) + ', merged ' + esc(fmtDate(d.merged)) + '.</p>'
          + (isAssemblyDecision(d) ? '<p>' + esc(ASSEMBLY_DECISION_NOTE) + '</p>' : '')
          + (threads ? '<p>Threads:</p><ul>' + threads + '</ul>' : '')
      };
    })
  });
}

function sitemap(pages, generatedAt) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + pages.filter((p) => p.url).map((p) => '  <url><loc>' + xmlEsc(p.url) + '</loc><lastmod>'
      + xmlEsc(p.thread ? p.thread.at : String(generatedAt).slice(0, 10)) + '</lastmod></url>\n').join('')
    + '</urlset>\n';
}

// -------------------------------------------------------------------- build

function parseArgs(argv) {
  const args = { out: '_site', data: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(key + ' needs a value');
      return v;
    };
    if (key === '--out') args.out = value();
    else if (key === '--data') args.data = value();
    else if (key === '--help' || key === '-h') args.help = true;
    else throw new Error('Unknown argument: ' + key);
  }
  return args;
}

function pagesFor(forum, details, meta) {
  const pages = STATIC_ROUTES.map((r) => ({
    kind: r.key, key: r.key, file: r.path + 'index.html', url: BASE + r.path, forum,
    title: meta[r.key].t, description: compact(meta[r.key].d, DESCRIPTION_MAX)
  }));
  for (const thread of forum.threads) {
    const lead = thread.excerpt || 'Thread #' + thread.num + ' in ' + ORG + '/' + thread.repo + ', read from GitHub.';
    pages.push({
      kind: 'thread', key: 'thread', file: 't/' + thread.slug + '/' + thread.num + '/index.html',
      url: BASE + threadPath(thread.slug, thread.num).slice(1), forum,
      title: titleText(thread.title) + SUFFIX, description: clipText(lead, DESCRIPTION_MAX),
      thread, detail: details.get(thread.slug + '/' + thread.num)
    });
  }
  pages.push({ kind: 'notfound', key: 'notfound', file: '404.html', url: null, forum, title: meta.notfound.t, description: compact(meta.notfound.d, DESCRIPTION_MAX) });
  return pages;
}

function mainFor(page, forum, meta, resanitize, routes) {
  switch (page.kind) {
    case 'list': return listMain(forum, meta);
    case 'thread': return threadMain(forum, page.thread, page.detail, resanitize);
    case 'decisions': return decisionsMain(forum, meta);
    case 'routing': return routingMain(forum, meta, routes);
    case 'notfound': return notFoundMain(forum, meta);
    default: return textMain(meta, page.key);
  }
}

function build(args) {
  const out = path.resolve(args.out || '_site');
  const dataDir = path.resolve(args.data || path.join(out, 'data'));
  if (out === path.resolve(ROOT) || path.resolve(ROOT).startsWith(out + path.sep)) {
    throw new Error('--out must be a build directory, not the repository or a parent of it');
  }
  const template = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  checkTemplate(template);
  const meta = readMeta(template);
  const routes = readRoutes(template);
  const { forum, details } = readSnapshot(dataDir);
  const resanitize = makeResanitize(forum);

  fs.mkdirSync(out, { recursive: true });
  for (const name of GENERATED) fs.rmSync(path.join(out, name), { recursive: true, force: true });
  for (const name of PUBLIC_SOURCES) {
    const from = path.join(ROOT, name);
    if (!fs.existsSync(from)) throw new Error('public source missing: ' + name);
    if (name !== 'index.html') fs.cpSync(from, path.join(out, name), { recursive: true });
  }
  const outData = path.join(out, 'data');
  if (dataDir !== path.resolve(outData)) {
    fs.rmSync(outData, { recursive: true, force: true });
    fs.cpSync(dataDir, outData, { recursive: true });
  }

  const pages = pagesFor(forum, details, meta);
  for (const page of pages) {
    const regionHtml = region(forum, page.key, mainFor(page, forum, meta, resanitize, routes));
    const html = rewriteHead(template, page).replace(EMPTY_REGION, () => START + regionHtml + END);
    const target = path.join(out, page.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, html);
  }
  fs.writeFileSync(path.join(out, 'sitemap.xml'), sitemap(pages, forum.generated_at));
  fs.writeFileSync(path.join(out, 'feed.xml'), threadFeed(forum, details, resanitize));
  fs.mkdirSync(path.join(out, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(out, 'decisions', 'feed.xml'), decisionFeed(forum));
  return { out, pages: pages.length, threads: forum.threads.length };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: node tools/prerender.js [--out _site] [--data <out>/data]');
    } else {
      const result = build(args);
      console.log('prerendered ' + result.pages + ' pages (' + result.threads + ' threads and 404.html), sitemap.xml and two feeds into '
        + (path.relative(process.cwd(), result.out) || '.'));
    }
  } catch (error) {
    console.error('prerender: ' + error.message);
    process.exit(1);
  }
}

module.exports = {
  plain, titleText, xmlText, compact, clipText, esc, objectLiteral, arrayLiteral, readMeta, readRoutes, makeResanitize, threadPath,
  BASE, START, END, EMPTY_REGION, META_KEYS, DESCRIPTION_MAX, FEED_MAX, SCHEMA,
  ASSEMBLY_NOTICE, TALLY_WORKFLOW, HIDDEN_VOTE_NOTE, WITHHELD_NOTE, ASSEMBLY_DECISION_NOTE, isAssemblyDecision
};

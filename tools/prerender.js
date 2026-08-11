#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'index.html');
const SNAPSHOT = path.join(ROOT, 'data', 'forum.json');
const BASE = 'https://forum.drayker.org/';
const START = '<!-- FORUM_PRERENDER_START -->';
const END = '<!-- FORUM_PRERENDER_END -->';

let source = fs.readFileSync(SOURCE, 'utf8');
source = source.replace(new RegExp(START + '[\\s\\S]*?' + END, 'g'), '');
source = source.replace(/<body>\s*<x-dc>/, '<body>\n<x-dc>');

function block(name) {
  const at = source.indexOf('const ' + name + ' = ');
  if (at < 0) throw new Error(name + ' not found in index.html');
  const equal = source.indexOf('=', at);
  const square = source.indexOf('[', equal);
  const brace = source.indexOf('{', equal);
  const open = square >= 0 && (brace < 0 || square < brace) ? square : brace;
  const close = source[open] === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === source[open]) depth++;
    if (source[i] === close && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(name + ' is not balanced');
}

const META = eval('(' + block('META') + ')'); // eslint-disable-line no-eval
const STATIC_ROUTES = [
  { path: '', key: 'list' },
  { path: 'new', key: 'new' },
  { path: 'decisions', key: 'decisions' },
  { path: 'routing', key: 'routing' },
  { path: 'about', key: 'about' }
];
const snapshot = fs.existsSync(SNAPSHOT)
  ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))
  : { generated_at: '', threads: [] };
const THREAD_ROUTES = (snapshot.threads || []).map((thread) => ({
  path: 't/' + encodeURIComponent(thread.repo) + '/' + encodeURIComponent(String(thread.num)),
  key: 'thread',
  thread
}));
const ROUTES = STATIC_ROUTES.concat(THREAD_ROUTES);

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plain = (value) => String(value || '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[`#>*_|~\-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const urlFor = (route) => BASE + (route.path ? route.path + '/' : '');

function routeMeta(route) {
  if (!route.thread) return META[route.key];
  const thread = route.thread;
  const body = plain(thread.body);
  const lead = body || 'A public discussion in the Drayker organization.';
  const clipped = lead.length > 176 ? lead.slice(0, 173).trim() + '…' : lead;
  return {
    t: thread.title + ' — Drayker Forum',
    d: clipped + ' · draykerdk/' + thread.repo + ' #' + thread.num
  };
}

function navigation() {
  return STATIC_ROUTES.map((route) => '<li><a href="' + urlFor(route) + '">' + esc(META[route.key].t) + '</a></li>').join('');
}

function fallback(route) {
  const meta = routeMeta(route);
  let content = '<h1>' + esc(meta.t) + '</h1><p>' + esc(meta.d) + '</p>';
  if (route.thread) {
    const thread = route.thread;
    const excerpt = plain(thread.body).slice(0, 900);
    content += '<p><strong>' + esc(thread.repo + ' #' + thread.num) + '</strong> · '
      + esc(thread.open === false ? 'closed' : 'open') + ' · ' + esc(String(thread.comments || 0)) + ' replies</p>';
    if (excerpt) content += '<p>' + esc(excerpt) + (plain(thread.body).length > excerpt.length ? '…' : '') + '</p>';
    content += '<p><a href="' + esc(thread.url) + '">Read and reply on GitHub</a></p>';
  } else {
    content += '<p>The forum reads public conversations from <a href="https://github.com/draykerdk">github.com/draykerdk</a>. Publishing and replying happen on GitHub.</p>';
  }
  return START + '<noscript><div style="max-width:64ch;margin:0 auto;padding:40px 20px;font-family:Archivo,Helvetica,Arial,sans-serif;color:#EDECF0;background:#08080A">'
    + content + '<ul>' + navigation() + '</ul></div></noscript>' + END;
}

function documentFor(route) {
  const meta = routeMeta(route);
  const url = urlFor(route);
  let html = source
    .replace(/<title>[\s\S]*?<\/title>/, '<title>' + esc(meta.t) + '</title>')
    .replace(/(<meta name="description" content=")[^"]*(">)/, '$1' + esc(meta.d) + '$2')
    .replace(/(<link rel="canonical" href=")[^"]*(">)/, '$1' + url + '$2')
    .replace(/(<meta property="og:type" content=")[^"]*(">)/, '$1' + (route.thread ? 'article' : 'website') + '$2')
    .replace(/(<meta property="og:title" content=")[^"]*(">)/, '$1' + esc(meta.t) + '$2')
    .replace(/(<meta property="og:description" content=")[^"]*(">)/, '$1' + esc(meta.d) + '$2')
    .replace(/(<meta property="og:url" content=")[^"]*(">)/, '$1' + url + '$2')
    .replace(/(<meta name="twitter:title" content=")[^"]*(">)/, '$1' + esc(meta.t) + '$2')
    .replace(/(<meta name="twitter:description" content=")[^"]*(">)/, '$1' + esc(meta.d) + '$2');
  return html.replace('<body>', '<body>\n' + fallback(route));
}

fs.rmSync(path.join(ROOT, 't'), { recursive: true, force: true });
for (const route of ROUTES) {
  const directory = path.join(ROOT, route.path);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.html'), documentFor(route));
}

const today = new Date().toISOString().slice(0, 10);
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + ROUTES.map((route) => {
    const changed = route.thread && route.thread.at ? String(route.thread.at).slice(0, 10) : today;
    return '  <url><loc>' + urlFor(route) + '</loc><lastmod>' + changed + '</lastmod></url>';
  }).join('\n')
  + '\n</urlset>\n';
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);
console.log('prerendered ' + STATIC_ROUTES.length + ' forum routes and ' + THREAD_ROUTES.length + ' thread routes');

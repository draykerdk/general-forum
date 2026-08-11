#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'index.html');
const BASE = 'https://forum.drayker.org/';
const START = '<!-- FORUM_PRERENDER_START -->';
const END = '<!-- FORUM_PRERENDER_END -->';

let source = fs.readFileSync(SOURCE, 'utf8');
source = source.replace(new RegExp(START + '[\\s\\S]*?' + END, 'g'), '');

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
const ROUTES = [
  { path: '', key: 'list' },
  { path: 'new', key: 'new' },
  { path: 'decisions', key: 'decisions' },
  { path: 'routing', key: 'routing' },
  { path: 'about', key: 'about' }
];

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const urlFor = (route) => BASE + (route.path ? route.path + '/' : '');

function fallback(current) {
  const meta = META[current.key];
  const links = ROUTES.map((route) => '<li><a href="' + urlFor(route) + '">' + esc(META[route.key].t) + '</a></li>').join('');
  return START + '<noscript><div style="max-width:64ch;margin:0 auto;padding:40px 20px;font-family:Archivo,Helvetica,Arial,sans-serif;color:#EDECF0;background:#08080A">'
    + '<h1>' + esc(meta.t) + '</h1><p>' + esc(meta.d) + '</p>'
    + '<p>The forum reads public conversations from <a href="https://github.com/draykerdk">github.com/draykerdk</a>. Publishing and replying happen on GitHub.</p>'
    + '<ul>' + links + '</ul></div></noscript>' + END;
}

function documentFor(route) {
  const meta = META[route.key];
  const url = urlFor(route);
  let html = source
    .replace(/<title>[\s\S]*?<\/title>/, '<title>' + esc(meta.t) + '</title>')
    .replace(/(<meta name="description" content=")[^"]*(">)/, '$1' + esc(meta.d) + '$2')
    .replace(/(<link rel="canonical" href=")[^"]*(">)/, '$1' + url + '$2')
    .replace(/(<meta property="og:title" content=")[^"]*(">)/, '$1' + esc(meta.t) + '$2')
    .replace(/(<meta property="og:description" content=")[^"]*(">)/, '$1' + esc(meta.d) + '$2')
    .replace(/(<meta property="og:url" content=")[^"]*(">)/, '$1' + url + '$2');
  if (route.path) {
    html = html.replace(/(src|href)="\.\//g, '$1="../');
    html = html.replace('</head>', START + '<script>if(!location.hash)location.replace(' + JSON.stringify('#/' + route.path) + ');</script>' + END + '\n</head>');
  }
  return html.replace('<body>', '<body>\n' + fallback(route));
}

for (const route of ROUTES) {
  const directory = path.join(ROOT, route.path);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.html'), documentFor(route));
}

const date = new Date().toISOString().slice(0, 10);
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + ROUTES.map((route) => '  <url><loc>' + urlFor(route) + '</loc><lastmod>' + date + '</lastmod></url>').join('\n')
  + '\n</urlset>\n';
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);
console.log('prerendered ' + ROUTES.length + ' canonical forum routes');

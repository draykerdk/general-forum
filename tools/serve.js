#!/usr/bin/env node
'use strict';

/*
 * Local preview server that behaves like GitHub Pages for this site.
 * Usage: node tools/serve.js [--dir _site] [--port 4321]
 *   /path/          -> /path/index.html
 *   /path (a dir)   -> 301 to /path/
 *   missing         -> 404.html with status 404 (index.html when there is no 404.html)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json'
};

function parseArgs(argv) {
  const args = { dir: '_site', port: 4321 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else throw new Error('Unknown argument: ' + argv[i]);
  }
  if (!args.dir || !Number.isInteger(args.port)) throw new Error('Usage: node tools/serve.js [--dir _site] [--port 4321]');
  return args;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch (error) { return false; }
}
function isDir(file) {
  try { return fs.statSync(file).isDirectory(); } catch (error) { return false; }
}

function createServer(root) {
  const base = path.resolve(root);
  const send = (res, status, file, method) => {
    const body = fs.readFileSync(file);
    res.writeHead(status, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    res.end(method === 'HEAD' ? undefined : body);
  };
  const notFound = (res, method) => {
    const page = [path.join(base, '404.html'), path.join(base, 'index.html')].find(isFile);
    if (page) return send(res, 404, page, method);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(method === 'HEAD' ? undefined : 'Not found\n');
  };

  return http.createServer((req, res) => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (error) {
      res.writeHead(400);
      res.end();
      return;
    }
    const target = path.resolve(base, '.' + pathname);
    if (target !== base && !target.startsWith(base + path.sep)) return notFound(res, method);
    if (pathname.endsWith('/')) {
      const index = path.join(target, 'index.html');
      return isFile(index) ? send(res, 200, index, method) : notFound(res, method);
    }
    if (isFile(target)) return send(res, 200, target, method);
    if (isDir(target)) {
      const query = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?')) : '';
      res.writeHead(301, { Location: encodeURI(pathname) + '/' + query, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    notFound(res, method);
  });
}

if (require.main === module) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(1); }
  if (!isDir(args.dir)) {
    console.error('Directory not found: ' + args.dir + ' (build the site first)');
    process.exit(1);
  }
  createServer(args.dir).listen(args.port, () => {
    console.log('serving ' + path.resolve(args.dir) + ' at http://localhost:' + args.port + '/');
  });
}

module.exports = { createServer };

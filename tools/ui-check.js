#!/usr/bin/env node
'use strict';

/*
 * UI checks for index.html: the page contract, and the logic script run in a bare
 * VM against a real snapshot.
 *
 *   node tools/ui-check.js [path/to/data/forum.json]
 *
 * Without an argument it reads _site/data/forum.json, and if that is missing it
 * builds one from test/fixtures/github with tools/build-forum-snapshot.js.
 * Thread files are read from the t/ directory next to forum.json.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = (html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/) || [])[1];
const template = (html.match(/<x-dc>([\s\S]*?)<\/x-dc>/) || [])[1];

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push(name + ': ' + (e && e.message ? e.message : e)); }
}

// ---------------------------------------------------------------------------
// Snapshot data
// ---------------------------------------------------------------------------
function findData() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const built = path.join(root, '_site', 'data', 'forum.json');
  if (fs.existsSync(built)) return built;
  const builder = path.join(root, 'tools', 'build-forum-snapshot.js');
  const fixture = path.join(root, 'test', 'fixtures', 'github');
  if (fs.existsSync(builder) && fs.existsSync(fixture)) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-ui-check-'));
    execFileSync(process.execPath, [builder, '--fixture', fixture, '--out', out], { stdio: 'ignore' });
    return path.join(out, 'data', 'forum.json');
  }
  console.error('No snapshot: pass the path to data/forum.json, or run `npm run data:fixture` first.');
  process.exit(2);
}
const dataFile = findData();
const DATA = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
// The live layer depends on the snapshot's age; the checks pin it to two hours.
DATA.generated_at = new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
const threadDir = path.join(path.dirname(dataFile), 't');
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// The logic in a VM with minimal browser stubs
// ---------------------------------------------------------------------------
class DCLogic {
  constructor() { this.props = {}; }
  setState(update, cb) {
    const next = typeof update === 'function' ? update(this.state) : update;
    this.state = Object.assign({}, this.state, next || {});
    if (cb) cb();
  }
}

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
};

function response(status, body, headers) {
  const h = Object.assign({}, headers || {});
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (Object.prototype.hasOwnProperty.call(h, k.toLowerCase()) ? h[k.toLowerCase()] : null) },
    json: async () => clone(body)
  };
}

const env = { api: () => Promise.reject(new TypeError('Failed to fetch')), calls: [] };
const headState = {};
const win = {
  innerWidth: 1440,
  location: { pathname: '/', search: '', hash: '', href: 'https://forum.drayker.org/', origin: 'https://forum.drayker.org' },
  history: {
    pushState: (_s, _t, target) => setLocation(target),
    replaceState: (_s, _t, target) => setLocation(target)
  },
  scrollTo: () => {}, open: () => {}, addEventListener: () => {}, removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
};
function setLocation(target) {
  const m = String(target).match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  win.location.pathname = m[1] || '/';
  win.location.search = m[2] || '';
  win.location.hash = m[3] || '';
}

const context = {
  DCLogic,
  React: { createRef: () => ({ current: null }) },
  console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Intl,
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  performance: { now: () => 0 },
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  navigator: {},
  window: win,
  document: {
    title: '', hidden: false,
    documentElement: { setAttribute: () => {}, classList: { add: () => {}, remove: () => {} } },
    head: { querySelector: (sel) => ({ getAttribute: (n) => headState[sel + '|' + n], setAttribute: (n, v) => { headState[sel + '|' + n] = v; } }) },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {}
  },
  fetch: (url) => {
    env.calls.push(url);
    if (url === '/data/forum.json') return Promise.resolve(response(200, DATA));
    const m = String(url).match(/^\/data\/t\/([^/]+)\/([0-9]+)\.json$/);
    if (m) {
      const file = path.join(threadDir, decodeURIComponent(m[1]), m[2] + '.json');
      return Promise.resolve(fs.existsSync(file) ? response(200, JSON.parse(fs.readFileSync(file, 'utf8'))) : response(404, {}));
    }
    if (String(url).startsWith('https://api.github.com/')) return env.api(url);
    return Promise.reject(new TypeError('unexpected fetch ' + url));
  }
};
vm.createContext(context);
vm.runInContext(script + '\n;globalThis.__forum = { Component, PARTS, ROUTES, POST, META, TYPES, composePost, componentFor, similarThreads, meaningfulWords, URL_MAX, TITLE_MIN };', context);
const F = context.__forum;

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

async function boot(url, opts) {
  opts = opts || {};
  setLocation(url);
  context.sessionStorage.clear();
  context.localStorage.clear();
  env.calls = [];
  env.api = opts.api || (() => Promise.reject(new TypeError('Failed to fetch')));
  win.innerWidth = opts.vw || 1440;
  const c = new F.Component();
  c.props = {};
  c.state = Object.assign({}, c.state, { vw: win.innerWidth });
  c.readRoute();
  if (opts.data !== false) c.setData(clone(opts.data || DATA), 'published');
  await flush();
  c.syncRoute();
  return c;
}

// ---------------------------------------------------------------------------
// Template bindings: every {{ path }} must resolve to a real value
// ---------------------------------------------------------------------------
const BAD_STRING = /undefined|NaN|\[object Object\]/;
function badValue(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' && !isFinite(v)) return 'NaN';
  if (typeof v === 'string' && BAD_STRING.test(v)) return 'string "' + v.slice(0, 80) + '"';
  return '';
}
function deepScan(v, where, out, seen) {
  if (v && typeof v === 'object') {
    if (seen.has(v)) return;
    seen.add(v);
    if ('current' in v && Object.keys(v).length === 1) return; // React ref
    for (const k of Object.keys(v)) deepScan(v[k], where + '.' + k, out, seen);
    return;
  }
  if (typeof v === 'function') return;
  const bad = badValue(v);
  if (bad) out.push(where + ' is ' + bad);
}
function getPath(obj, parts) {
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}
// Each sc-for gets its own scope id, because loops may reuse an `as` name.
const tplScopes = (() => {
  const re = /<sc-for\s+list="\{\{\s*([^}]+?)\s*\}\}"\s+as="([^"]+)"|<\/sc-for>|\{\{\s*([^}]+?)\s*\}\}/g;
  const stack = [];
  const scopes = [];
  const uses = [];
  const visible = () => { const v = {}; stack.forEach((id) => { v[scopes[id].as] = id; }); return v; };
  let m;
  while ((m = re.exec(template))) {
    if (m[1]) { scopes.push({ list: m[1], as: m[2], outer: visible() }); stack.push(scopes.length - 1); continue; }
    if (m[0] === '</sc-for>') { stack.pop(); continue; }
    const expr = m[3].replace(/^!/, '').trim();
    if (/^(true|false|null|[0-9]+)$/.test(expr)) continue;
    uses.push({ expr, vis: visible() });
  }
  return { scopes, uses };
})();
function itemsFor(vals, id) {
  const sc = tplScopes.scopes[id];
  const parts = sc.list.split('.');
  if (sc.outer[parts[0]] !== undefined) {
    return itemsFor(vals, sc.outer[parts[0]]).reduce((acc, it) => acc.concat(getPath(it, parts.slice(1)) || []), []);
  }
  return getPath(vals, parts) || [];
}
function checkBindings(vals, label) {
  const problems = [];
  deepScan(vals, label, problems, new Set());
  for (const use of tplScopes.uses) {
    const parts = use.expr.split('.');
    if (use.vis[parts[0]] !== undefined) {
      for (const it of itemsFor(vals, use.vis[parts[0]])) {
        const v = parts.length === 1 ? it : getPath(it, parts.slice(1));
        const bad = badValue(v);
        if (bad) problems.push(label + ' {{ ' + use.expr + ' }} is ' + bad);
      }
    } else {
      const bad = badValue(getPath(vals, parts));
      if (bad) problems.push(label + ' {{ ' + use.expr + ' }} is ' + bad);
    }
  }
  tplScopes.scopes.forEach((sc) => {
    const head = sc.list.split('.')[0];
    if (sc.outer[head] === undefined && !Array.isArray(getPath(vals, sc.list.split('.')))) problems.push(label + ' sc-for ' + sc.list + ' is not an array');
  });
  assert.deepStrictEqual(problems.slice(0, 10), []);
}

// ---------------------------------------------------------------------------
(async () => {
  await check('page contract', () => {
    assert(script, 'logic script missing');
    assert(template, 'x-dc template missing');
    assert(/<body>\n<!-- FORUM_STATIC_START --><!-- FORUM_STATIC_END -->\n<x-dc>/.test(html), 'static region markers must open <body>');
    assert(!html.includes('FORUM_PRERENDER_START'), 'old prerender block still present');
    assert(html.includes('<style>x-dc{display:none!important}html.js #forum-static{display:none}html.fs-fallback #forum-static{display:block!important}'), 'static region style rules missing');
    const head = html.slice(0, html.indexOf('</head>'));
    assert(/classList\.add\('js'\)/.test(head) && head.includes("'drayker-theme'") && head.includes('fs-fallback') && head.includes('8000'), 'pre-paint script incomplete');
    assert(head.indexOf("classList.add('js')") < head.indexOf('src="/support.js"'), 'pre-paint script must run before the runtime');
    assert(head.includes('<link rel="alternate" type="application/atom+xml" href="/feed.xml" title="Drayker Forum — new threads">'), 'thread feed link missing');
    assert(head.includes('<link rel="alternate" type="application/atom+xml" href="/decisions/feed.xml" title="Drayker Forum — decisions">'), 'decisions feed link missing');
    for (const tag of ['<title>Drayker Forum — every public thread</title>', '<meta name="description" content="', '<link rel="canonical" href="https://forum.drayker.org/">',
      '<meta property="og:title" content="', '<meta name="twitter:title" content="', '<script id="drayker-structured-data" type="application/ld+json">']) assert(head.includes(tag), 'head tag format changed: ' + tag);
    assert(html.includes('const META = {') && html.includes('readRoute = () =>'), 'prerender anchors missing');
    assert(!/<script[^>]+src="https:\/\/cdn\.jsdelivr\.net\/npm\/(d3|topojson)/.test(html), 'd3/topojson must be loaded lazily, not by a script tag');
    assert(html.includes('d3@7.9.0/dist/d3.min.js') && html.includes('topojson-client@3.1.0/dist/topojson-client.min.js'), 'Earth library versions changed');
    assert(html.includes("fetch('/data/forum.json'"), 'snapshot must use a root-absolute URL');
  });

  await check('copy and markup rules', () => {
    assert(!/Dknowledger/.test(html), 'private name present');
    assert(!/author_association|"MEMBER"|"OWNER"|"CONTRIBUTOR"/.test(html), 'author association displayed');
    assert(!/open source/i.test(html), '"open source" present');
    assert(!/the organization|organization's|organization’s/i.test(template), 'Drayker called an organization');
    assert(!/style="[^"]*outline:\s*none/.test(html), 'inline outline:none removes focus rings');
    assert(!/role="button"/.test(template), 'div buttons remain');
    assert(/:focus-visible\{outline:2px solid #FF5500/.test(html), 'focus ring missing');
    assert(/prefers-reduced-motion: reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important/.test(html), 'reduced-motion CSS missing');
    const slots = template.match(/<[a-z]+[^>]*data-slot="[^"]*"[^>]*>[\s\S]*?<\//g) || [];
    assert(slots.length >= 2 && slots.every((s) => /data-slot="[^"]*"[^>]*><\/$/.test(s)), 'data-slot containers must be childless');
    for (const t of ['sc-if', 'sc-for']) assert.strictEqual((template.match(new RegExp('<' + t + '[\\s>]', 'g')) || []).length, (template.match(new RegExp('</' + t + '>', 'g')) || []).length, t + ' tags unbalanced');
    assert(!/\{\{[^}]*(\?|&&|\|\||\(\s*\w+\s*\))[^}]*\}\}/.test(template), 'template expression uses unsupported syntax');
    assert.strictEqual(Object.keys(F.META).length, 7, 'META must have seven routes');
    assert(F.META.notfound && F.META.notfound.t && F.META.notfound.d, 'notfound META missing');
    assert.strictEqual(F.PARTS.length, 26, 'one part per public repository');
    assert.strictEqual(new Set(F.PARTS.map((p) => p.repo)).size, 26, 'parts map to distinct repositories');
    assert.strictEqual(new Set(F.PARTS.map((p) => p.key)).size, 26, 'part keys are unique');
  });

  await check('list renders every thread with paging', async () => {
    const c = await boot('/');
    const v = c.renderVals();
    checkBindings(v, 'list');
    assert(v.isList && !v.isNotFound);
    assert.strictEqual(v.rows.length, Math.min(30, DATA.threads.length));
    assert.strictEqual(v.showing, 'Showing ' + v.rows.length + ' of ' + DATA.threads.length + ' threads');
    assert.deepStrictEqual(clone(v.stats.map((s) => s.v)), [DATA.counts.threads, DATA.counts.open, DATA.counts.unanswered, DATA.counts.decisions].map(String));
    assert(v.rows.every((r) => /^\/t\/[^/]+\/[0-9]+\/$/.test(r.href)), 'row links must be clean thread paths');
    assert(v.sync.stamp.startsWith('Updated from GitHub ') && / UTC\)$/.test(v.sync.stamp));
    assert(!env.calls.some((u) => u.startsWith('https://api.github.com/')), 'list must make no API call on load');
    assert(v.partOpts.length - 1 === new Set(DATA.threads.map((t) => t.slug)).size, 'every repo with threads is a part option');
  });

  await check('paging, show more and n in the URL', async () => {
    const many = clone(DATA);
    const base = DATA.threads[0];
    many.threads = [];
    for (let i = 1; i <= 75; i++) many.threads.push(Object.assign(clone(base), { num: 1000 + i, title: 'Paging thread ' + i, at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    const c = await boot('/', { data: many });
    let v = c.renderVals();
    assert.strictEqual(v.rows.length, 30);
    assert(v.hasMore && v.showing === 'Showing 30 of 75 threads' && v.moreLabel === 'Show more (30)');
    v.showMore();
    c.syncRoute();
    v = c.renderVals();
    assert.strictEqual(v.rows.length, 60);
    assert.strictEqual(win.location.search, '?n=60');
    v.showMore();
    v = c.renderVals();
    assert.strictEqual(v.rows.length, 75);
    assert(!v.hasMore);
    const again = await boot('/?n=60', { data: many });
    assert.strictEqual(again.renderVals().rows.length, 60, 'n restored from the URL');
  });

  await check('search: case, accents, all words, #number', async () => {
    const c = await boot('/');
    const titles = (q) => { c.setState({ q }); return c.renderVals().rows.map((r) => r.title); };
    const veto = titles('VETO');
    assert(veto.length > 0);
    assert(veto.every((t) => c.hay[DATA.threads.find((x) => x.title === t).slug + '/' + DATA.threads.find((x) => x.title === t).num].includes('veto')));
    assert.deepStrictEqual(clone(titles('veto banana-nothing')), []);
    const both = titles('veto chain');
    assert(both.includes('Specify one entry of the veto chain'));
    assert(both.length <= veto.length);
    const portuguese = DATA.threads.find((t) => /Português/.test(t.title));
    if (portuguese) assert(titles('portugues').includes(portuguese.title), 'accent-insensitive search failed');
    c.setState({ q: '#5' });
    const rows5 = c.renderVals().rows;
    assert(rows5.length > 0 && rows5.every((r) => / #5$/.test(r.where)), '#number must match the number exactly');
    c.setState({ q: 'hyadhuad' });
    assert(c.renderVals().rows.length > 0, 'search must include the author');
    c.setState({ q: 'skill:research' });
    assert.strictEqual(c.renderVals().rows.length, DATA.threads.filter((t) => t.labels.includes('skill:research')).length, 'search must include labels');
  });

  await check('kind, label and status filters', async () => {
    const c = await boot('/');
    const count = (patch) => { c.setState(Object.assign({ kind: 'all', label: '', status: 'all', part: 'all', q: '' }, patch)); return c.filterList(c.state).length; };
    const open = DATA.threads.filter((t) => t.open).length;
    assert.strictEqual(count({ status: 'open' }), open);
    assert.strictEqual(count({ status: 'closed' }), DATA.threads.length - open);
    assert.strictEqual(count({ status: 'waiting' }), DATA.threads.filter((t) => t.open && !t.comments).length);
    assert.strictEqual(count({ kind: 'work' }), DATA.threads.filter((t) => c.kindOf(t.labels) === 'work').length);
    assert.strictEqual(count({ label: 'skill:research' }), DATA.threads.filter((t) => t.labels.includes('skill:research')).length);
    assert.strictEqual(count({ part: 'uid' }), DATA.threads.filter((t) => t.slug === 'uid').length);
    c.setState({ kind: 'proposal', label: '', status: 'all', part: 'all' });
    const v = c.renderVals();
    checkBindings(v, 'empty list');
    if (!DATA.threads.some((t) => c.kindOf(t.labels) === 'proposal')) assert(v.noMatch && !v.hasRows, 'an empty filter shows the no-match panel');
    const present = new Set(DATA.threads.map((t) => c.kindOf(t.labels)));
    assert.strictEqual(v.kindChips.filter((k) => k.t !== 'EVERYTHING').length, present.size + (present.has('proposal') ? 0 : 1), 'kind chips: present kinds plus the selected one');
    const groups = c.renderVals().labelGroups.map((g) => g.name);
    for (const [prefix, name] of [['skill:', 'Skill'], ['level:', 'Level'], ['effort:', 'Effort']]) {
      assert.strictEqual(groups.includes(name), DATA.threads.some((t) => t.labels.some((l) => l.startsWith(prefix))), name + ' facet');
    }
    const pressed = c.renderVals().kindChips.find((k) => k.pressed === 'true');
    assert(pressed && pressed.t === 'PROPOSALS');
  });

  await check('sort orders', async () => {
    const c = await boot('/');
    const ms = (s) => Date.parse(s || '') || 0;
    const order = (sort) => { c.setState({ sort, q: '', kind: 'all', status: 'all', label: '', part: 'all' }); return c.filterList(c.state); };
    const pairs = (list, ok) => list.slice(1).every((t, i) => ok(list[i], t));
    assert(pairs(order('recent'), (a, b) => ms(a.at) >= ms(b.at)), 'recent');
    assert(pairs(order('newest'), (a, b) => ms(a.created) >= ms(b.created)), 'newest');
    assert(pairs(order('oldest'), (a, b) => ms(a.created) <= ms(b.created)), 'oldest');
    assert(pairs(order('replies'), (a, b) => (a.comments || 0) >= (b.comments || 0)), 'replies');
  });

  await check('routing round trips', async () => {
    let c = await boot('/?q=veto+chain&part=uid&kind=work&label=skill:research&status=open&sort=newest&n=60');
    assert.strictEqual(c.state.q, 'veto chain');
    assert.deepStrictEqual([c.state.part, c.state.kind, c.state.label, c.state.status, c.state.sort, c.state.n], ['uid', 'work', 'skill:research', 'open', 'newest', 60]);
    assert.strictEqual(win.location.pathname + win.location.search, '/?q=veto+chain&part=uid&kind=work&label=skill:research&status=open&sort=newest&n=60');
    c.setFilter({ status: 'all' });
    c.syncRoute();
    assert.strictEqual(win.location.search, '?q=veto+chain&part=uid&kind=work&label=skill:research&sort=newest', 'filter change resets n and updates the query');
    c = await boot('/?sort=bogus&status=nope&kind=zzz&n=abc');
    assert.deepStrictEqual([c.state.sort, c.state.status, c.state.kind, c.state.n], ['recent', 'all', 'all', 30]);
    assert.strictEqual(win.location.search, '', 'invalid filters are dropped from the URL');

    const t = DATA.threads[0];
    c = await boot('/t/' + t.slug + '/' + t.num + '/');
    assert.strictEqual(c.state.page, 'thread');
    assert.strictEqual(c.routePath(), '/t/' + encodeURIComponent(t.slug) + '/' + t.num + '/');
    assert.strictEqual(headState['link[rel="canonical"]|href'], 'https://forum.drayker.org/t/' + encodeURIComponent(t.slug) + '/' + t.num + '/');
    assert.strictEqual(context.document.title, t.title + ' — Drayker Forum');

    c = await boot('/#/t/dk/2');
    assert.strictEqual(win.location.pathname, '/t/dk/2/', 'legacy hash upgraded');
    assert.strictEqual(c.state.page, 'thread');
    c = await boot('/#/t/.github/1', { data: false });
    assert.strictEqual(win.location.pathname, '/t/dot-github/1/', 'legacy .github hash uses the slug');

    c = await boot('/t/dk/2/#c-123');
    assert.strictEqual(c.state.page, 'thread', 'comment anchors are not routes');
    for (const [p, page] of [['/new/', 'new'], ['/decisions/', 'decisions'], ['/routing/', 'routing'], ['/about/', 'about'], ['/about', 'about'], ['/index.html', 'list'],
      ['/nope/', 'notfound'], ['/t/dk/', 'notfound'], ['/t/dk/abc/', 'notfound'], ['/404.html', 'notfound'], ['/new/extra/', 'notfound']]) {
      c = await boot(p);
      assert.strictEqual(c.state.page, page, p);
    }
    assert(c.isAppPath('/') && c.isAppPath('/t/dk/2/') && c.isAppPath('/about/') && !c.isAppPath('/feed.xml') && !c.isAppPath('/data/forum.json'));
  });

  await check('thread with comments from the snapshot', async () => {
    const withComments = DATA.threads.find((t) => t.comments > 0) || DATA.threads[0];
    const c = await boot('/t/' + withComments.slug + '/' + withComments.num + '/');
    const v = c.renderVals();
    checkBindings(v, 'thread');
    assert(v.isThread && v.tReadyBody && v.tv.show, 'thread not ready: ' + c.state.tState);
    assert.strictEqual(v.cmts.length, withComments.comments);
    if (v.cmts.length) {
      const first = v.cmts[0];
      assert(/^c-[0-9]+$/.test(first.anchor) && first.permalink === '#' + first.anchor);
      assert(/^https:\/\/avatars\.githubusercontent\.com\/u\/[0-9]+\?s=64$/.test(first.avatar));
      assert.strictEqual(first.isOpener, first.user === withComments.user);
      assert(c.slots[first.slot] && c.slots[first.slot].mode === 'snapshot', 'comment slot registered');
    }
    assert(c.slots[v.tv.bodySlot], 'body slot registered');
    assert.strictEqual(v.tv.replyUrl, withComments.url + '#new_comment_field');
    assert.strictEqual(v.stands[0].t.indexOf('Opened '), 0);
    if (!withComments.open) assert(v.stands.some((s) => /^Closed/.test(s.t)), 'closed state listed');
    assert(v.stands.every((s) => /^(Opened|Waiting|No replies|[0-9]+ repl|Claimed|Pull request|Referenced in|Closed|Replies not loaded)/.test(s.t)), 'only data-backed stages');
    assert(!v.tLive);
    // The snapshot is older than 10 minutes in this check, so exactly one call is made
    // for newer comments, and its failure is shown as a failure.
    const api = env.calls.filter((u) => u.startsWith('https://api.github.com/'));
    assert.strictEqual(api.length, 1);
    assert(/\/issues\/[0-9]+\/comments\?since=.+&per_page=100$/.test(api[0]));
    assert(v.fresh.show && /Could not check GitHub/.test(v.fresh.text));
  });

  await check('a fresh snapshot makes no thread call', async () => {
    const t = DATA.threads[0];
    const fresh = Object.assign(clone(DATA), { generated_at: new Date(Date.now() - 60000).toISOString() });
    const c = await boot('/t/' + t.slug + '/' + t.num + '/', { data: fresh });
    const v = c.renderVals();
    assert(v.tReadyBody && !v.fresh.show);
    assert(!env.calls.some((u) => u.startsWith('https://api.github.com/')), 'snapshot younger than 10 minutes must not call GitHub');
  });

  await check('thread freshen merges new comments', async () => {
    const t = DATA.threads.find((x) => x.comments === 0 && x.open) || DATA.threads[0];
    const c = await boot('/t/' + t.slug + '/' + t.num + '/', {
      api: () => Promise.resolve(response(200, [{ id: 99, user: { login: 'reader', id: 5 }, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z', body_html: '<p>new</p>', html_url: 'x' }],
        { 'x-ratelimit-remaining': '57', 'x-ratelimit-reset': '1900000000', 'x-ratelimit-resource': 'core' }))
    });
    const v = c.renderVals();
    checkBindings(v, 'fresh thread');
    assert.strictEqual(v.fresh.text, '1 new since the last update.');
    assert.strictEqual(v.cmts.length, t.comments + 1);
    assert(c.slots[v.cmts[v.cmts.length - 1].slot].mode === 'live', 'live comments are sanitized as live HTML');
    assert.strictEqual(JSON.parse(context.sessionStorage.getItem('drayker-gh-rate')).core.remaining, 57);
  });

  await check('rate limit skips live calls', async () => {
    const t = DATA.threads[0];
    setLocation('/t/' + t.slug + '/' + t.num + '/');
    const c = new F.Component();
    c.props = {};
    context.sessionStorage.setItem('drayker-gh-rate', JSON.stringify({ core: { remaining: 2, reset: Date.now() + 600000 } }));
    env.calls = [];
    c.readRoute();
    c.setData(clone(DATA), 'published');
    await flush();
    const v = c.renderVals();
    assert(!env.calls.some((u) => u.startsWith('https://api.github.com/')), 'no API call while limited');
    assert(/hourly limit/.test(v.fresh.text) && / UTC\.$/.test(v.fresh.text));
    context.sessionStorage.clear();
  });

  await check('missing thread: live attempt then not found', async () => {
    const c = await boot('/t/dfmp/99999/', { api: () => Promise.resolve(response(404, { message: 'Not Found' })) });
    const v = c.renderVals();
    checkBindings(v, 'missing thread');
    assert.deepStrictEqual(env.calls.filter((u) => u.startsWith('https://api.github.com/')), ['https://api.github.com/repos/draykerdk/dfmp/issues/99999']);
    assert(v.isNotFound && !v.isThread);
    assert.strictEqual(v.nf.title, 'No thread at this address.');
    assert.strictEqual(context.document.title, F.META.notfound.t);
  });

  await check('pull request number is not a thread', async () => {
    const c = await boot('/t/dfmp/6/', { data: Object.assign(clone(DATA), { threads: DATA.threads.filter((t) => !(t.slug === 'dfmp' && t.num === 6)) }),
      api: () => Promise.resolve(response(200, { number: 6, pull_request: {}, html_url: 'https://github.com/draykerdk/dfmp/pull/6' })) });
    const v = c.renderVals();
    assert(v.isNotFound && /pull request/.test(v.nf.title) && v.nf.ghHref === 'https://github.com/draykerdk/dfmp/pull/6');
  });

  await check('thread missing from the snapshot is read live', async () => {
    const api = (url) => url.endsWith('/comments?per_page=100')
      ? Promise.resolve(response(200, [{ id: 7, user: { login: 'b', id: 2 }, created_at: '2026-10-08T01:00:00Z', updated_at: '2026-10-08T01:00:00Z', body_html: '<h2>x</h2>', html_url: 'u' }]))
      : Promise.resolve(response(200, { number: 77, title: 'Brand new', html_url: 'https://github.com/draykerdk/uid/issues/77', user: { login: 'a', id: 1 }, labels: [{ name: 'Help Wanted' }],
        state: 'open', state_reason: null, created_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T01:00:00Z', comments: 1, body_html: '<p>body</p>' }));
    const c = await boot('/t/uid/77/', { api });
    const v = c.renderVals();
    checkBindings(v, 'live thread');
    assert(v.tLive && v.tReadyBody && v.tv.title === 'Brand new' && v.cmts.length === 1);
    assert.deepStrictEqual(clone(v.tv.labels), [{ t: 'help wanted' }]);
    assert.strictEqual(env.calls.filter((u) => u.startsWith('https://api.github.com/')).length, 2);
  });

  await check('failed thread file is a failure, not an empty thread', async () => {
    const t = DATA.threads[0];
    const realFetch = context.fetch;
    context.fetch = (url) => (String(url).startsWith('/data/t/') ? Promise.resolve(response(500, {})) : realFetch(url));
    const c = await boot('/t/' + t.slug + '/' + t.num + '/');
    context.fetch = realFetch;
    const v = c.renderVals();
    checkBindings(v, 'failed thread');
    assert(v.tFailed && !v.tReadyBody && /HTTP 500/.test(v.tFailedText) && !v.cmtNote.show);
  });

  await check('list check merges newer activity', async () => {
    const c = await boot('/');
    const t = c.state.threads[c.state.threads.length - 1];
    const items = [
      { repository_url: 'https://api.github.com/repos/draykerdk/' + t.repo, number: t.num, title: 'Renamed', html_url: t.url, user: { login: t.user, id: 1 }, labels: [], state: 'closed', state_reason: 'completed',
        created_at: t.created, updated_at: '2031-01-01T00:00:00Z', closed_at: '2031-01-01T00:00:00Z', comments: (t.comments || 0) + 2, body_text: 'Body  text' },
      { repository_url: 'https://api.github.com/repos/draykerdk/uid', number: 4242, title: 'New one', html_url: 'https://github.com/draykerdk/uid/issues/4242', user: { login: 'x', id: 3 }, labels: [], state: 'open',
        created_at: '2031-01-01T00:00:00Z', updated_at: '2031-01-02T00:00:00Z', comments: 0, body_text: 'b' },
      { repository_url: 'https://api.github.com/repos/draykerdk/uid', number: 9, pull_request: {}, updated_at: '2031-01-01T00:00:00Z' }
    ];
    env.api = (url) => {
      assert(/\/search\/issues\?q=org%3Adraykerdk%20is%3Aissue%20updated%3A%3E%3D[0-9]{4}-[0-9]{2}-[0-9]{2}&/.test(url), 'search query ' + url);
      return Promise.resolve(response(200, { total_count: 3, items }, { 'x-ratelimit-remaining': '9', 'x-ratelimit-reset': '1900000000', 'x-ratelimit-resource': 'search' }));
    };
    c.checkGitHub();
    await flush();
    const v = c.renderVals();
    checkBindings(v, 'checked list');
    assert.strictEqual(c.state.check.changed, 1);
    assert.strictEqual(c.state.check.added, 1);
    assert.strictEqual(v.rows[0].title, 'New one');
    assert(v.rows[1].title === 'Renamed' && v.rows[1].newer && v.rows[1].stateText === 'Closed — completed');
    assert(/^last activity /.test(v.rows[1].last), 'unknown last replier is not invented');
    const calls = env.calls.length;
    c.checkGitHub();
    await flush();
    assert.strictEqual(env.calls.length, calls, 'a second check within 10 minutes uses the cache');
  });

  await check('other routes render', async () => {
    for (const p of ['/new/', '/decisions/', '/routing/', '/about/', '/nope/']) {
      const c = await boot(p);
      const v = c.renderVals();
      checkBindings(v, p);
      assert(!env.calls.some((u) => u.startsWith('https://api.github.com/')), p + ' must make no API call');
      if (p === '/decisions/') {
        const items = v.dec.groups.reduce((a, g) => a.concat(g.items), []);
        assert.strictEqual(items.length, Math.min(50, DATA.decisions.length));
        assert(items.every((d) => /^Merged [0-9]/.test(d.meta)));
      }
      if (p === '/nope/') assert(v.isNotFound && v.nf.ghHref === 'https://github.com/draykerdk');
    }
    const nav = (await boot('/decisions/')).renderVals().nav;
    assert.deepStrictEqual(clone(nav.map((n) => n.href)), ['/', '/decisions/', '/routing/', '/about/']);
    assert.deepStrictEqual(clone(nav.map((n) => n.current)), ['false', 'page', 'false', 'false']);
    const narrow = (await boot('/', { vw: 390 })).renderVals();
    assert(!narrow.showMark, 'mark hidden below 720px');
  });

  await check('loading and error states', async () => {
    const c = await boot('/', { data: false });
    let v = c.renderVals();
    checkBindings(v, 'loading');
    assert(v.listLoading && !v.hasRows && v.stats.every((s) => s.v === '—'));
    const realFetch = context.fetch;
    context.fetch = () => Promise.resolve(response(503, {}));
    await c.loadData(true);
    context.fetch = realFetch;
    v = c.renderVals();
    checkBindings(v, 'data error');
    assert(v.listError && /HTTP 503/.test(v.listErrorText) && !v.nothing && !v.noMatch);
    assert.strictEqual(context.localStorage.getItem('drayker-forum-v1'), null);
    context.localStorage.setItem('drayker-forum-v1', 'old');
    await c.loadData(true);
    assert.strictEqual(context.localStorage.getItem('drayker-forum-v1'), null, 'obsolete cache key removed');
    assert(JSON.parse(context.localStorage.getItem('drayker-forum-v2')).data.schema === 2);
    const bad = await boot('/', { data: false });
    context.fetch = () => Promise.resolve(response(200, { schema: 1, threads: [] }));
    await bad.loadData(true);
    context.fetch = realFetch;
    assert(bad.renderVals().listError, 'schema other than 2 is rejected');
  });

  await check('theme cycles light, dark, auto', async () => {
    const c = await boot('/');
    c.applyTheme('auto');
    const seen = [];
    for (let i = 0; i < 4; i++) { c.toggleTheme(); seen.push(c.renderVals().themeText); }
    assert.deepStrictEqual(seen, ['LIGHT', 'DARK', 'AUTO', 'LIGHT']);
  });

  // -------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------
  const qs = (url) => {
    const out = {};
    url.split('?')[1].split('&').forEach((kv) => { const i = kv.indexOf('='); out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
    return out;
  };
  const keys = (url) => url.split('?')[1].split('&').map((kv) => kv.split('=')[0]);
  const TITLE = 'Specify how a veto reaches the kernel';
  const PROPOSAL_FIELDS = { problem: '\n  \nThe problem.  \n', change: 'The change.', against: 'The objection.' };

  await check('composer: general-forum proposal and every component mapping', () => {
    const expected = {
      dfmp: 'DFM Protocol', dk: 'Dk', bsdk: 'Base structure (BSDK)', 'dk-network': 'Dk Network', 'living-cryptography': 'Living Cryptography',
      uid: 'Universal Identity (UID)', daf: 'DAF — the federation', dknowledge: 'Dknowledge', 'drayker.org': 'The public websites',
      'drayker.com': 'The public websites', 'drayker-theme': 'The public websites', 'drayker-propagation': 'The public websites',
      '': 'Not sure yet', 'general-forum': 'Something else', osdk: 'Something else', pap: 'Something else', '.github': 'Something else'
    };
    for (const [repo, option] of Object.entries(expected)) assert.strictEqual(F.componentFor(repo), option, 'component for ' + (repo || 'none'));
    const options = fs.readFileSync(path.join(root, '.github', 'ISSUE_TEMPLATE', 'proposal.yml'), 'utf8').match(/options:\n((?:\s+- .+\n)+)/)[1]
      .split('\n').map((l) => l.replace(/^\s+- /, '').trim()).filter(Boolean);
    for (const option of new Set(Object.values(expected))) assert(options.includes(option), 'not a proposal.yml dropdown option: ' + option);
    for (const [repo, component] of [['', 'Not sure yet'], ['general-forum', 'Something else']]) {
      const p = F.composePost({ kind: 'proposal', repo, title: '  ' + TITLE + '  ', fields: PROPOSAL_FIELDS });
      assert(p.url.startsWith('https://github.com/draykerdk/general-forum/issues/new?template=proposal.yml&title='), p.url);
      assert.deepStrictEqual(keys(p.url), ['template', 'title', 'summary', 'change', 'against', 'component']);
      assert.deepStrictEqual(qs(p.url), { template: 'proposal.yml', title: '[Proposal] ' + TITLE, summary: TITLE,
        change: 'The problem.\n\nThe change.', against: 'The objection.', component });
      assert.strictEqual(p.form, 'proposal.yml');
      assert(!/labels=|body=/.test(p.url), 'no labels or body parameter');
    }
  });

  await check('composer: motion form in repositories that inherit the org templates', () => {
    const inherit = F.PARTS.map((x) => x.repo).filter((r) => ['general-forum', 'daf', 'drayker.org'].indexOf(r) < 0);
    assert.strictEqual(inherit.length, 23);
    for (const repo of inherit) {
      const p = F.composePost({ kind: 'proposal', repo, title: TITLE, fields: PROPOSAL_FIELDS });
      assert(p.url.startsWith('https://github.com/draykerdk/' + repo + '/issues/new?template=motion.yml&'), p.url);
      assert.deepStrictEqual(qs(p.url), { template: 'motion.yml', title: '[Motion] ' + TITLE, problem: 'The problem.', proposal: 'The change.', alternatives: 'The objection.' });
      assert(/known evidence/.test(p.left));
    }
    const partial = F.composePost({ kind: 'proposal', repo: 'dk', title: TITLE, fields: { change: 'Only the change.' } });
    assert.deepStrictEqual(keys(partial.url), ['template', 'title', 'proposal'], 'empty motion fields omitted');
  });

  await check('composer: daf and drayker.org proposals are plain issues', () => {
    for (const repo of ['daf', 'drayker.org']) {
      const p = F.composePost({ kind: 'proposal', repo, title: TITLE, fields: PROPOSAL_FIELDS });
      assert.deepStrictEqual(keys(p.url), ['title', 'body']);
      assert(p.url.startsWith('https://github.com/draykerdk/' + repo + '/issues/new?title='));
      assert.deepStrictEqual(qs(p.url), { title: '[Proposal] ' + TITLE,
        body: '### What problem does it address?\n\nThe problem.\n\n### What exactly would change?\n\nThe change.\n\n### The strongest argument against it\n\nThe objection.' });
      assert.strictEqual(p.form, '');
    }
  });

  await check('composer: question, idea and report bodies, empty fields omitted', () => {
    const cases = [
      ['question', '[Question] ', { know: 'What is X?', tried: 'The README.' }, '### What do you want to know?\n\nWhat is X?\n\n### What have you already read or tried?\n\nThe README.'],
      ['idea', '[Idea] ', { idea: 'Do Y.', matter: 'Because Z.' }, '### The idea\n\nDo Y.\n\n### Why it might matter\n\nBecause Z.'],
      ['report', '[Report] ', { wrong: 'Broken link.', where: 'https://drayker.org/x' }, '### What happened or what is wrong?\n\nBroken link.\n\n### Where (link or page)\n\nhttps://drayker.org/x']
    ];
    for (const [kind, prefix, fields, body] of cases) {
      for (const repo of ['', 'general-forum', 'uid', 'daf']) {
        const p = F.composePost({ kind, repo, title: TITLE, fields });
        assert(p.url.startsWith('https://github.com/draykerdk/' + (repo || 'general-forum') + '/issues/new?title='), p.url);
        assert.deepStrictEqual(qs(p.url), { title: prefix + TITLE, body });
      }
      const empty = F.composePost({ kind, repo: 'dk', title: TITLE, fields: {} });
      assert.deepStrictEqual(keys(empty.url), ['title'], 'no body when every field is empty');
    }
    const one = F.composePost({ kind: 'question', repo: '', title: TITLE, fields: { know: 'Only this.', tried: '   \n ' } });
    assert.strictEqual(qs(one.url).body, '### What do you want to know?\n\nOnly this.');
    const all = ['proposal', 'question', 'idea', 'report'].map((kind) => F.composePost({ kind, repo: 'uid', title: TITLE, fields: {} }).url).join(' ');
    assert(!/writing this here|untitled|labels=|forum\.drayker\.org|collected/.test(decodeURIComponent(all)), 'no placeholder text, labels or footer line');
  });

  await check('composer: title rule, length guard and disabled state', async () => {
    assert.strictEqual(F.TITLE_MIN, 8);
    assert(F.composePost({ kind: 'idea', repo: '', title: '  1234567 ', fields: {} }).disabled, 'seven characters are not enough');
    assert(!F.composePost({ kind: 'idea', repo: '', title: '12345678', fields: {} }).disabled);
    assert(F.composePost({ kind: 'idea', repo: '', title: '', fields: {} }).disabled);
    const big = (n) => F.composePost({ kind: 'idea', repo: '', title: TITLE, fields: { idea: 'x'.repeat(n) } });
    let n = 3000;
    while (big(n).url.length <= F.URL_MAX) n++;
    assert(!big(n - 1).tooLong && !big(n - 1).disabled && big(n - 1).url.length === F.URL_MAX, 'exactly 3800 characters is allowed');
    assert(big(n).tooLong && big(n).disabled, 'over 3800 characters disables the handover');
    assert(/<button type="button" class="cta cta-lg cmp-go" onClick="\{\{ openPost \}\}" disabled="\{\{ cp\.disabled \}\}">/.test(template), 'submit control uses the disabled attribute');
    assert(template.includes('Too long to hand over in a link. Shorten it here and continue writing on GitHub.'));
    assert(template.includes('Everything you post is public on GitHub and mirrored here. Share only what you are comfortable publishing.'));
    assert(template.includes('Kind to people, relentless with ideas.') && template.includes('not even Drayker’s own.') && template.includes('https://github.com/draykerdk/.github/blob/master/CONTRIBUTING.md'));
    assert(template.includes('https://github.com/draykerdk/general-forum/issues/new?template=volunteer-introduction.yml') && template.includes('https://github.com/draykerdk/general-forum/issues/new?template=partnership.yml'));

    const c = await boot('/new/');
    const opened = [];
    win.open = (u) => { opened.push(u); return null; };
    let v = c.renderVals();
    checkBindings(v, 'composer');
    assert(v.cp.disabled);
    v.openPost();
    assert.strictEqual(opened.length, 0, 'nothing opens while invalid');
    assert.strictEqual(v.cPartOpts.length, 1 + 26, 'Not sure yet plus every repository');
    assert.strictEqual(v.cPartOpts[0].v, '');
    v.setCTitle({ target: { value: TITLE } });
    v = c.renderVals();
    v.cFields[0].set({ target: { value: 'Problem text' } });
    v = c.renderVals();
    v.setCPart({ target: { value: 'metadfmp' } });
    v = c.renderVals();
    checkBindings(v, 'composer filled');
    assert.deepStrictEqual(clone(v.cp.preview.map((r) => r.k)), ['Repository', 'Form', 'Title', 'Problem']);
    assert.strictEqual(v.cp.preview[0].v, 'draykerdk/metadfmp');
    v.openPost();
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0], 'https://github.com/draykerdk/metadfmp/issues/new?template=motion.yml&title=%5BMotion%5D%20' + encodeURIComponent(TITLE) + '&problem=Problem%20text');
    assert(c.renderVals().cOpened);
    const q = v.kinds.find((k) => k.t === 'QUESTION');
    q.pick();
    v = c.renderVals();
    assert.deepStrictEqual(clone(v.cFields.map((f) => f.q)), ['What do you want to know?', 'What have you already read or tried?']);
    assert(!v.cOpened, 'changing the kind resets the opened note');
    assert(!env.calls.some((u) => u.startsWith('https://api.github.com/')), 'the composer makes no API call');
    win.open = () => {};
  });

  await check('composer: similar threads', async () => {
    const threads = [
      { slug: 'dk', num: 1, repo: 'dk', title: 'Specify one entry of the veto chain', text: 'kernel', at: '2026-01-01T00:00:00Z' },
      { slug: 'dk', num: 2, repo: 'dk', title: 'Unrelated subject', text: 'mentions the veto once', at: '2026-02-01T00:00:00Z' },
      { slug: 'uid', num: 3, repo: 'uid', title: 'Identity recovery path', text: 'nothing shared', at: '2026-03-01T00:00:00Z' },
      { slug: 'dk', num: 4, repo: 'dk', title: 'Veto chains and kernel entries', text: '', at: '2026-04-01T00:00:00Z' }
    ];
    assert.deepStrictEqual(clone(F.meaningfulWords('The Veto of the Kernel, and its vetoes, Kernels and processes')), ['veto', 'kernel', 'process']);
    assert.strictEqual(F.similarThreads('the veto', threads).show, false, 'one meaningful word is not enough');
    assert.strictEqual(F.similarThreads('what is the drayker forum', threads).show, false, 'stop-words do not count');
    const r = F.similarThreads('Veto chain entry', threads);
    assert(r.show);
    assert.deepStrictEqual(clone(r.items.map((t) => t.num)), [1, 4, 2]);
    assert.deepStrictEqual(clone(F.similarThreads('Banana orchard planning', threads).items), []);
    const many = Array.from({ length: 9 }, (_, i) => ({ slug: 'dk', num: i + 10, repo: 'dk', title: 'Veto kernel ' + i, at: '2026-01-01T00:00:00Z' }));
    assert.strictEqual(F.similarThreads('veto kernel', many).items.length, 5, 'at most five');
    const c = await boot('/new/');
    const real = DATA.threads[0];
    c.setState({ cTitle: real.title });
    const v = c.renderVals();
    checkBindings(v, 'composer similar');
    if (F.meaningfulWords(real.title).length >= 2) assert(v.similar.show && v.similar.items[0].href === '/t/' + real.slug + '/' + real.num + '/', 'a thread matches its own title');
  });

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthOf = (iso) => { const d = new Date(iso); return MONTHS_LONG[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
  const decItems = (v) => v.dec.groups.reduce((a, g) => a.concat(g.items), []);

  await check('decisions: month groups, paging and count', async () => {
    const many = clone(DATA);
    const base = { repo: 'dk', slug: 'dk', title: 'x', url: 'https://github.com/draykerdk/dk/pull/1', user: 'a', excerpt: 'Ex', threads: [] };
    many.decisions = [];
    for (let i = 0; i < 120; i++) many.decisions.push(Object.assign({}, base, { num: i + 1, title: 'Decision ' + i, merged: new Date(Date.UTC(2026, 9, 30) - i * 2 * 86400000).toISOString() }));
    many.decisions.reverse();
    many.counts = Object.assign({}, many.counts, { decisions: 120 });
    const c = await boot('/decisions/', { data: many });
    let v = c.renderVals();
    checkBindings(v, 'decisions');
    let items = decItems(v);
    assert.strictEqual(items.length, 50);
    assert.strictEqual(items[0].title, 'Decision 0', 'newest first');
    assert.strictEqual(v.dec.groups[0].month, 'October 2026');
    assert(v.dec.groups.every((g, i) => i === 0 || g.month !== v.dec.groups[i - 1].month), 'one heading per month');
    const flat = many.decisions.slice().sort((a, b) => Date.parse(b.merged) - Date.parse(a.merged)).slice(0, 50);
    v.dec.groups.forEach((g) => g.items.forEach((it) => { const d = flat.find((x) => x.title === it.title); assert.strictEqual(monthOf(d.merged), g.month); }));
    assert.strictEqual(v.dec.showing, 'Showing 50 of 120 merged pull requests');
    assert.strictEqual(v.dec.total, '120 merged pull requests across 1 repository in the last update');
    assert(v.dec.hasMore && v.dec.moreLabel === 'Show more (50)');
    v.decMore();
    c.syncRoute();
    assert.strictEqual(win.location.search, '?n=100');
    v = c.renderVals();
    assert.strictEqual(decItems(v).length, 100);
    v.decMore();
    v = c.renderVals();
    assert(decItems(v).length === 120 && !v.dec.hasMore);
    const again = await boot('/decisions/?n=100', { data: many });
    assert.strictEqual(decItems(again.renderVals()).length, 100, 'n restored from the URL');
  });

  await check('decisions: rows, thread links, search and part filter in the URL', async () => {
    const c = await boot('/decisions/');
    let v = c.renderVals();
    const items = decItems(v);
    const first = DATA.decisions[0];
    assert.strictEqual(items[0].url, first.url);
    assert.strictEqual(items[0].where, '#' + first.num);
    assert.strictEqual(items[0].partName, c.partName(first.repo));
    assert(items[0].meta.indexOf('Merged ') === 0 && items[0].meta.endsWith(' · by ' + first.user));
    const linked = DATA.decisions.findIndex((d) => d.threads && d.threads.length);
    if (linked >= 0 && linked < 50) {
      const t = DATA.decisions[linked].threads[0];
      assert.strictEqual(items[linked].threads[0].href, '/t/' + t.slug + '/' + t.num + '/');
      assert(template.includes('Discussed in:'));
    }
    assert(template.includes('In the founding phase, a merged pull request is how a decision enters the record.'));
    assert(template.includes('If a change arrived as a pull request, it is in this list. Direct changes by the founding steward appear in each repository’s history.'));
    const slug = first.slug;
    v.setDpart({ target: { value: slug } });
    c.syncRoute();
    assert.strictEqual(win.location.search, '?part=' + slug);
    v = c.renderVals();
    assert.strictEqual(v.dec.groups.reduce((a, g) => a + g.items.length, 0), Math.min(50, DATA.decisions.filter((d) => d.slug === slug).length));
    assert(v.dec.filtered && /matching$/.test(v.dec.showing));
    assert.strictEqual(v.dec.partOpts.length - 1, new Set(DATA.decisions.map((d) => d.slug)).size);
    const word = first.title.split(/\s+/).find((w) => w.length > 4) || first.title;
    v.setDq({ target: { value: word.toUpperCase() } });
    c.syncRoute();
    assert(win.location.search.indexOf('q=') === 1 && win.location.search.indexOf('part=' + slug) > 0);
    v = c.renderVals();
    assert(decItems(v).some((d) => d.title === first.title), 'search is case-insensitive');
    v.setDq({ target: { value: '#' + first.num } });
    v = c.renderVals();
    assert(decItems(v).every((d) => d.where === '#' + first.num));
    v.setDq({ target: { value: 'zzzz-nothing-matches' } });
    v = c.renderVals();
    checkBindings(v, 'decisions no match');
    assert(v.dec.noMatch && !decItems(v).length);
    v.clearDec();
    c.syncRoute();
    assert.strictEqual(win.location.search, '');
    const back = await boot('/decisions/?q=' + encodeURIComponent(word) + '&part=' + slug);
    assert.deepStrictEqual([back.state.dq, back.state.dpart], [word, slug], 'filters restored from the URL');
    const empty = await boot('/decisions/', { data: Object.assign(clone(DATA), { decisions: [] }) });
    const ev = empty.renderVals();
    checkBindings(ev, 'no decisions');
    assert(ev.dec.none && !ev.dec.ready);
  });

  // -------------------------------------------------------------------------
  // Routing, about and copy
  // -------------------------------------------------------------------------
  await check('routing: every repository from the snapshot', async () => {
    const c = await boot('/routing/');
    const v = c.renderVals();
    checkBindings(v, 'routing');
    assert.strictEqual(v.repoList.length, DATA.repos.length);
    assert.strictEqual(v.repoCount, DATA.repos.length + ' public repositories with issues enabled');
    for (const r of DATA.repos) {
      const row = v.repoList.find((x) => x.repo === 'draykerdk/' + r.name);
      assert(row, 'missing ' + r.name);
      assert.strictEqual(row.name, c.partName(r.name));
      assert.strictEqual(row.url, r.url);
      assert.strictEqual(row.hasHome, /^https:\/\//.test(r.homepage || ''));
      if (row.hasHome) assert.strictEqual(row.home, r.homepage);
      assert(row.threads.startsWith(r.threads + ' thread'));
      assert.strictEqual(row.hasThreads, r.threads > 0);
      if (r.threads) assert.strictEqual(row.threadsHref, '/?part=' + r.slug);
    }
    const names = v.repoList.map((x) => x.name.toLowerCase());
    assert.deepStrictEqual(names, names.slice().sort(), 'sorted by display name');
    for (const r of DATA.repos) assert(F.PARTS.some((p) => p.repo === r.name), r.name + ' has a display name in PARTS');
    assert.strictEqual(c.partName('metadfmp'), 'Meta DFM');
    assert.deepStrictEqual(clone(v.routes.map((r) => r.repo.split('/')[1])), ['dfmp', 'dknowledge', 'dk', 'uid', 'daf', 'dfmpproject', 'emergence-initiative', 'drayker.org', 'general-forum']);
    const loading = (await boot('/routing/', { data: false })).renderVals();
    checkBindings(loading, 'routing loading');
    assert(!loading.hasRepoList && loading.listLoading);
  });

  await check('about: repository count, feeds and refresh', async () => {
    const v = (await boot('/about/')).renderVals();
    assert.strictEqual(v.aboutLead, 'Drayker’s public discussion happens in the issues of its ' + DATA.counts.repos + ' public repositories.');
    assert.strictEqual((await boot('/about/', { data: false })).renderVals().aboutLead, 'Drayker’s public discussion happens in the issues of its public repositories.');
    for (const s of ['href="/feed.xml"', 'href="/decisions/feed.xml"', 'about every 15 minutes', 'It is the first step of the public contribution path.',
      'Nothing here is decided in a private meeting or a private vote. In the founding phase the founding steward integrates changes in public, as <a href="https://github.com/draykerdk/.github/blob/master/GOVERNANCE.md">GOVERNANCE.md</a> documents.',
      'The merge is how the decision enters the record.', 'Drayker’s code of conduct', 'where Drayker keeps its review history', 'https://drayker.org/fn/',
      'CC BY 4.0 · PUBLIC DOCUMENTATION · NON-PROFIT', 'unpkg, jsDelivr', 'Google Fonts']) assert(template.includes(s), 'missing: ' + s);
    assert(!template.includes('#org/fn'));
  });

  await check('no forbidden strings in user-visible text', async () => {
    const FORBIDDEN = [/organi[sz]ation/i, /the project\b/i, /open[\s-]source/i, /Dknowledger/, /MetaDFMP/, /seventeen/i,
      /transmits nothing/i, /collects? nothing/i, /stores nothing/i, /writes nothing/i, /READING THE ORGANIZATION/i, /no analytics|no tracking/i];
    const visible = template.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<style>[\s\S]*?<\/style>/g, ' ');
    const text = visible.replace(/<[^>]+>/g, ' ');
    const attrs = (visible.match(/\s(?:placeholder|aria-label|title|alt|label)="[^"]*"/g) || []).join(' ');
    for (const re of FORBIDDEN) {
      assert(!re.test(text), 'template text matches ' + re + ': ' + (text.match(new RegExp('.{0,40}' + re.source + '.{0,40}', re.flags)) || [''])[0]);
      assert(!re.test(attrs), 'template attribute matches ' + re);
    }
    const strings = [];
    const collect = (v, seen) => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object' && !seen.has(v)) { seen.add(v); Object.keys(v).forEach((k) => collect(v[k], seen)); }
    };
    for (const p of ['/', '/new/', '/decisions/', '/routing/', '/about/', '/nope/', '/t/' + DATA.threads[0].slug + '/' + DATA.threads[0].num + '/']) collect((await boot(p)).renderVals(), new Set());
    collect(clone(F.META), new Set());
    collect(clone(F.POST), new Set());
    // Thread, decision and repository text is other people’s words, not this page’s copy.
    const before = strings.length;
    collect(DATA, new Set());
    const dataStrings = strings.splice(before).map((d) => d.replace(/\s+/g, ' ')).filter((d) => d.length >= 8);
    const own = strings.filter((s) => {
      const bare = s.replace(/…$/, '').replace(/\s+/g, ' ');
      return !dataStrings.some((d) => s.includes(d) || (bare.length >= 8 && d.includes(bare)));
    });
    for (const re of FORBIDDEN) { const hit = own.find((s) => re.test(s)); assert(!hit, 'rendered string matches ' + re + ': ' + hit); }
    assert(!F.PARTS.some((p) => /MetaDFMP/.test(p.name)));
  });

  if (failures.length) {
    failures.forEach((f) => console.error('FAIL ' + f));
    console.error(failures.length + ' failed, ' + passed + ' passed');
    process.exit(1);
  }
  console.log(passed + ' UI check groups passed (' + path.relative(process.cwd(), dataFile) + ', ' + DATA.threads.length + ' threads)');
})();

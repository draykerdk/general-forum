#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = (html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/) || [])[1];
const failures = [];
let checks = 0;
const check = (condition, message) => { checks++; if (!condition) failures.push(message); };

check(Boolean(script), 'Design Component logic is missing');
check(html.includes('<html lang="en">'), 'document language is missing');
check(html.includes('<title>Drayker Forum — every public thread</title>'), 'initial title is missing');
check(html.includes('https://forum.drayker.org/'), 'canonical forum domain is missing');
check(!html.includes('dknowledge.drayker.org'), 'retired Dknowledger hostname is still linked');
check(html.includes('https://dknowledger.drayker.org/'), 'canonical Dknowledger link is missing');
check(html.includes("const PROPOSAL_TEMPLATE = true"), 'proposal form integration is not enabled');
check(html.includes("fetch('/data/forum.json'"), 'snapshot must use a root-absolute URL');
check(html.includes('d3@7.9.0') && html.includes('topojson-client@3.1.0'), 'optional Earth renderer dependencies are missing');
check(html.includes('meta name="twitter:card" content="summary_large_image"'), 'Twitter card metadata is missing');
check(html.includes('meta property="og:image" content="https://forum.drayker.org/assets/forum-social.png"'), 'Open Graph image is missing');
check(html.includes('meta property="og:site_name" content="Drayker Forum"'), 'Open Graph site name is missing');
check(html.includes('id="drayker-structured-data"'), 'structured data placeholder is missing');
check(html.includes('href="/llms.txt"'), 'llms.txt discovery link is missing');
check(fs.existsSync(path.join(root, 'llms.txt')), 'llms.txt is missing');
check(fs.readFileSync(path.join(root, 'robots.txt'), 'utf8').includes('OAI-SearchBot'), 'AI search crawler policy is missing');
check(html.includes('readRoute = () =>') && html.includes('window.history.pushState'), 'clean History API routing is missing');
check(!html.includes('syncHash = () =>'), 'legacy hash routing is still the primary router');

for (const asset of [
  'assets/logo/drayker-icone.svg', 'assets/logo/escuro/drayker-icone.svg',
  'assets/logo/kit/icon-512.png', 'assets/logo/kit/icon-512-escuro.png',
  'assets/logo/kit/apple-touch-icon.png', 'assets/forum-social.png', 'support.js', 'CNAME'
]) check(fs.existsSync(path.join(root, asset)), 'missing required asset: ' + asset);

const headIcons = ['drayker-icone.svg', 'escuro/drayker-icone.svg', 'icon-512.png', 'icon-512-escuro.png'];
for (const icon of headIcons) check(html.includes(icon + '?v=20260813'), 'head does not cache-bust ' + icon);
check(html.includes('prefers-color-scheme: light') && html.includes('prefers-color-scheme: dark'), 'favicon theme variants are incomplete');

class DCLogic {
  setState(update, callback) {
    const next = typeof update === 'function' ? update(this.state) : update;
    this.state = Object.assign({}, this.state, next || {});
    if (callback) callback();
  }
}

const headState = {};
const context = {
  DCLogic,
  React: { createRef: () => ({ current: null }) },
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  performance: { now: () => 0 },
  localStorage: { getItem: () => null, setItem: () => {} },
  fetch: () => Promise.reject(new Error('offline test')),
  window: {
    innerWidth: 1440,
    location: { hash: '', href: '', pathname: '/', search: '' },
    history: {
      pushState: (_state, _title, target) => { context.window.location.pathname = target; },
      replaceState: (_state, _title, target) => { context.window.location.pathname = String(target).split('?')[0]; context.window.location.hash = ''; }
    },
    scrollTo: () => {},
    open: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
  },
  document: {
    title: '',
    documentElement: { setAttribute: () => {} },
    head: { querySelector: (selector) => ({ getAttribute: (name) => headState[selector + name], setAttribute: (name, value) => { headState[selector + name] = value; } }) }
  }
};
vm.createContext(context);
vm.runInContext(script + '\n;globalThis.__forum = { Component, PARTS, ROUTES, POST, META };', context);
const bundle = context.__forum;
check(bundle.PARTS.length === 20, 'expected the twenty system parts');
check(bundle.ROUTES.length === 9, 'routing table is incomplete');
check(Object.keys(bundle.META).length === 6, 'route metadata is incomplete');
check(bundle.PARTS.some((part) => part.name === 'Dknowledger' && part.repo === 'dknowledge'), 'Dknowledger naming is inconsistent');

const component = new bundle.Component();
component.props = {};
const values = component.renderVals();
check(values.nav.length === 5, 'forum navigation is incomplete');
check(values.isList && values.stats.length === 4, 'forum home does not render its base state');
check(values.routes.length === 9 && values.repoList.length === 17, 'routing view does not match the repository model');
check(component.kindOf(['motion']) === 'proposal', 'motion label must classify as proposal');
check(component.kindOf(['open-function']) === 'work', 'open-function label must classify as work');

const filterComponent = new bundle.Component();
filterComponent.props = {};
filterComponent.state = Object.assign({}, filterComponent.state, {
  ghState: 'ready', ghSource: 'test', ghAt: Date.now(), status: 'closed', sort: 'recent',
  threads: [
    { num: 1, title: 'Open thread', repo: 'uid', labels: [], user: 'one', body: 'identity', comments: 0, at: '2026-08-11T00:00:00Z', open: true },
    { num: 2, title: 'Closed thread', repo: 'dk', labels: ['documentation'], user: 'two', body: 'kernel', comments: 4, at: '2026-08-10T00:00:00Z', open: false }
  ]
});
let filtered = filterComponent.renderVals();
check(filtered.rows.length === 1 && filtered.rows[0].title === 'Closed thread', 'status filtering does not isolate closed threads');
filterComponent.state.status = 'all';
filterComponent.state.q = 'documentation';
filtered = filterComponent.renderVals();
check(filtered.rows.length === 1 && filtered.rows[0].title === 'Closed thread', 'search does not include labels and subjects');
filterComponent.state.q = '';
filterComponent.state.sort = 'replies';
filtered = filterComponent.renderVals();
check(filtered.rows[0].title === 'Closed thread', 'reply sorting is not applied');

filterComponent.state = Object.assign({}, filterComponent.state, { page: 'thread', tRepo: 'uid', tNum: '1' });
filterComponent.syncRoute();
check(context.window.location.pathname === '/t/uid/1/', 'thread navigation did not produce a clean URL');
check(headState['link[rel="canonical"]href'] === 'https://forum.drayker.org/t/uid/1/', 'runtime thread canonical is not clean');

component.state = Object.assign({}, component.state, {
  page: 'new', cKind: 'proposal', cPart: '', cTitle: 'Trace decisions',
  cWhat: 'Connect decisions to sources', cWhy: 'Readers can follow the change'
});
const proposal = decodeURIComponent(component.postUrl());
check(proposal.includes('general-forum/issues/new?template=proposal.yml'), 'general proposal must open the proposal form');
check(proposal.includes('&summary=') && proposal.includes('&change=') && proposal.includes('&component='), 'proposal field ids are not prefilled');

component.state.cPart = 'dk';
const targeted = decodeURIComponent(component.postUrl());
check(targeted.includes('/dk/issues/new?title='), 'component-specific thread must open in its owning repository');
check(!targeted.includes('template=proposal.yml'), 'general-forum proposal form must not be forced on another repository');

for (const route of ['', 'new', 'decisions', 'routing', 'about']) {
  const file = path.join(root, route, 'index.html');
  check(fs.existsSync(file), 'missing prerendered route: /' + route);
  if (!fs.existsSync(file)) continue;
  const page = fs.readFileSync(file, 'utf8');
  const expected = 'https://forum.drayker.org/' + (route ? route + '/' : '');
  check(page.includes('<link rel="canonical" href="' + expected + '">'), 'wrong canonical for /' + route);
  check((page.match(/<link rel="canonical"/g) || []).length === 1, 'duplicate canonical for /' + route);
  check(page.includes('<noscript>'), 'missing readable no-script fallback for /' + route);
}

const proposalForm = fs.readFileSync(path.join(root, '.github', 'ISSUE_TEMPLATE', 'proposal.yml'), 'utf8');
for (const id of ['summary', 'change', 'component']) check(proposalForm.includes('id: ' + id), 'proposal form is missing field id ' + id);
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'forum-site.yml'), 'utf8');
check(workflow.includes('data/forum.json') && workflow.includes('org:draykerdk is:issue'), 'snapshot workflow contract is incomplete');
check(workflow.includes('node tools/prerender.js') && workflow.includes('actions/upload-pages-artifact@v4'), 'site workflow does not publish clean thread routes');
check(workflow.includes('actions/deploy-pages@v4') && workflow.includes('pages: write'), 'site workflow cannot deploy the refreshed snapshot');

const snapshotFile = path.join(root, 'data', 'forum.json');
check(fs.existsSync(snapshotFile), 'initial forum snapshot is missing');
if (fs.existsSync(snapshotFile)) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  check(Array.isArray(snapshot.threads) && snapshot.threads.length > 0, 'snapshot has no public threads');
  check(Array.isArray(snapshot.decisions), 'snapshot decisions are missing');
  for (const thread of snapshot.threads || []) {
    const route = path.join(root, 't', thread.repo, String(thread.num), 'index.html');
    check(fs.existsSync(route), 'missing clean thread route: ' + thread.repo + ' #' + thread.num);
    if (!fs.existsSync(route)) continue;
    const page = fs.readFileSync(route, 'utf8');
    const canonical = 'https://forum.drayker.org/t/' + encodeURIComponent(thread.repo) + '/' + thread.num + '/';
    check(page.includes('<link rel="canonical" href="' + canonical + '">'), 'wrong thread canonical: ' + thread.repo + ' #' + thread.num);
    check(page.includes('<meta property="og:type" content="article">'), 'thread social type is not article: ' + thread.repo + ' #' + thread.num);
    const structured = page.match(/<script id="drayker-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/);
    let graph = [];
    try { graph = JSON.parse(structured && structured[1])['@graph'] || []; } catch (_) { check(false, 'invalid thread JSON-LD: ' + thread.repo + ' #' + thread.num); }
    check(graph.some((entry) => entry['@type'] === 'DiscussionForumPosting' && entry.url === canonical), 'thread schema is missing: ' + thread.repo + ' #' + thread.num);
    const escapedTitle = String(thread.title).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const twitterTitle = (page.match(/<meta name="twitter:title" content="([^"]*)">/) || [])[1] || '';
    check(twitterTitle.startsWith(escapedTitle.replace(/-/g, ' ').slice(0, 18)) && twitterTitle.includes('Drayker Forum'), 'thread Twitter title is not specific: ' + thread.repo + ' #' + thread.num);
    check(page.includes('src="/support.js"') && page.includes('href="/assets/logo/drayker-icone.svg'), 'thread asset paths are not route-safe: ' + thread.repo + ' #' + thread.num);
  }
}

if (failures.length) {
  failures.forEach((failure) => console.error('FAIL: ' + failure));
  console.error(failures.length + ' of ' + checks + ' checks failed');
  process.exit(1);
}
console.log(checks + ' forum checks passed');

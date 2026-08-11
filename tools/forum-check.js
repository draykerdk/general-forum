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

for (const asset of [
  'favicon.ico', 'assets/logo/drayker-favicon.svg', 'assets/logo/kit/favicon-32.png',
  'assets/logo/kit/favicon-16.png', 'assets/logo/kit/apple-touch-icon.png', 'support.js', 'CNAME'
]) check(fs.existsSync(path.join(root, asset)), 'missing required asset: ' + asset);

const headIcons = ['favicon.ico', 'drayker-favicon.svg', 'favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png'];
for (const icon of headIcons) check(html.includes(icon + '?v=20260811'), 'head does not cache-bust ' + icon);

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
    location: { hash: '', href: '' },
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
  check(page.includes('<noscript>'), 'missing readable no-script fallback for /' + route);
}

const proposalForm = fs.readFileSync(path.join(root, '.github', 'ISSUE_TEMPLATE', 'proposal.yml'), 'utf8');
for (const id of ['summary', 'change', 'component']) check(proposalForm.includes('id: ' + id), 'proposal form is missing field id ' + id);
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'forum-snapshot.yml'), 'utf8');
check(workflow.includes('data/forum.json') && workflow.includes('org:draykerdk is:issue'), 'snapshot workflow contract is incomplete');

const snapshotFile = path.join(root, 'data', 'forum.json');
check(fs.existsSync(snapshotFile), 'initial forum snapshot is missing');
if (fs.existsSync(snapshotFile)) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  check(Array.isArray(snapshot.threads) && snapshot.threads.length > 0, 'snapshot has no public threads');
  check(Array.isArray(snapshot.decisions), 'snapshot decisions are missing');
}

if (failures.length) {
  failures.forEach((failure) => console.error('FAIL: ' + failure));
  console.error(failures.length + ' of ' + checks + ' checks failed');
  process.exit(1);
}
console.log(checks + ' forum checks passed');

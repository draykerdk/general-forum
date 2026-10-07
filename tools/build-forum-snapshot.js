#!/usr/bin/env node
'use strict';

/*
 * Reads every public draykerdk repository with issues enabled and writes the
 * forum snapshot:
 *   <out>/data/forum.json            index of repositories, threads and decisions
 *   <out>/data/t/<slug>/<num>.json   one file per thread with sanitized HTML and comments
 *   <out>/data/meta.json             generation time, content hash, site revision, counts
 *
 * Usage: node tools/build-forum-snapshot.js [--out _site] [--fixture <dir> | --record <dir>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createClient } = require('./lib/github');
const { sanitizeHtml, htmlToText } = require('./lib/sanitize');

const ORG = 'draykerdk';
const ROOT = path.join(__dirname, '..');
const EXCERPT_MAX = 280;
const TEXT_MAX = 2000;
const PARTICIPANTS_MAX = 12;

function parseArgs(argv) {
  const args = { out: '_site', fixture: null, record: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(key + ' needs a value');
      return v;
    };
    if (key === '--out') args.out = value();
    else if (key === '--fixture') args.fixture = value();
    else if (key === '--record') args.record = value();
    else if (key === '--help' || key === '-h') args.help = true;
    else throw new Error('Unknown argument: ' + key);
  }
  if (args.fixture && args.record) throw new Error('--fixture and --record cannot be combined');
  return args;
}

const slugFor = (name) => String(name).replace(/^\./, 'dot-');
const keyFor = (repo, num) => String(repo).toLowerCase() + '#' + Number(num);
const login = (user) => (user && user.login) || 'ghost';
const userId = (user) => (user && typeof user.id === 'number' ? user.id : null);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const numFromIssueUrl = (url) => Number(String(url || '').split('/').slice(-1)[0]);

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  let cut = value.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.6) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.\-–—]+$/, '') + '…';
}

// Removes fenced and inline code so that '#12' inside code is not read as a reference.
function stripCode(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

// Returns [{ repo, num }] in order of appearance, duplicates removed.
function findReferences(markdown, repo) {
  const text = stripCode(markdown);
  const found = [];
  const push = (r, n, at) => found.push({ repo: r, num: Number(n), at });
  let m;
  const url = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/([0-9]+)/gi;
  while ((m = url.exec(text))) if (m[1].toLowerCase() === ORG) push(m[2], m[3], m.index);
  const full = /(^|[^A-Za-z0-9_/.-])([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([0-9]+)\b/g;
  while ((m = full.exec(text))) if (m[2].toLowerCase() === ORG) push(m[3], m[4], m.index + m[1].length);
  const short = /(^|[^A-Za-z0-9_/&#.-])#([0-9]+)\b/g;
  while ((m = short.exec(text))) push(repo, m[2], m.index + m[1].length);
  found.sort((a, b) => a.at - b.at);
  const seen = new Set();
  const refs = [];
  for (const ref of found) {
    const key = keyFor(ref.repo, ref.num);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ repo: ref.repo, num: ref.num });
  }
  return refs;
}

function siteRevision() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'local';
  } catch (error) {
    return 'local';
  }
}

async function readOrg(gh) {
  const listed = await gh.paginate('/orgs/' + ORG + '/repos?type=public&per_page=100');
  const repos = listed
    .filter((r) => r && !r.private && (r.visibility === undefined || r.visibility === 'public') && !r.archived && r.has_issues)
    .sort((a, b) => byText(a.name.toLowerCase(), b.name.toLowerCase()) || byText(a.name, b.name));
  if (!repos.length) throw new Error('GitHub returned no public repositories with issues for ' + ORG);
  const result = [];
  for (const repo of repos) {
    const base = '/repos/' + ORG + '/' + encodeURIComponent(repo.name);
    const items = await gh.paginate(base + '/issues?state=all&per_page=100&sort=updated');
    const comments = await gh.paginate(base + '/issues/comments?per_page=100&sort=created&direction=asc');
    result.push({ repo, items, comments });
  }
  return result;
}

function buildSnapshot(org, generatedAt) {
  // Index every issue first so that links can be rewritten and references resolved.
  const threadIndex = new Map(); // key -> { repo, slug, num }
  for (const { repo, items } of org) {
    for (const item of items) {
      if (item.pull_request) continue;
      threadIndex.set(keyFor(repo.name, item.number), { repo: repo.name, slug: slugFor(repo.name), num: item.number });
    }
  }
  const threadExists = (repo, num) => {
    const hit = threadIndex.get(keyFor(repo, num));
    return hit ? hit.slug : null;
  };
  const ctxFor = (rawBody) => ({ org: ORG, threadExists, rawBody: rawBody || '' });

  const repos = [];
  const threads = [];
  const files = new Map(); // '<slug>/<num>' -> { html, comments }
  const sources = []; // issues and pull requests that may reference threads
  const decisions = [];

  for (const { repo, items, comments } of org) {
    const slug = slugFor(repo.name);
    const commentsByNum = new Map();
    for (const comment of comments) {
      const num = numFromIssueUrl(comment.issue_url);
      if (!commentsByNum.has(num)) commentsByNum.set(num, []);
      commentsByNum.get(num).push(comment);
    }
    for (const list of commentsByNum.values()) {
      list.sort((a, b) => byText(a.created_at, b.created_at) || a.id - b.id);
    }

    let repoThreads = 0;
    let repoOpen = 0;
    const seenNums = new Set();
    for (const item of items) {
      if (seenNums.has(item.number)) continue; // paging by update time can repeat an item
      seenNums.add(item.number);
      const itemComments = commentsByNum.get(item.number) || [];
      const isPr = Boolean(item.pull_request);
      sources.push({ repo: repo.name, slug, item, isPr, comments: itemComments });

      if (isPr) {
        const merged = item.pull_request.merged_at || null;
        if (!merged) continue;
        const html = sanitizeHtml(item.body_html || '', ctxFor(item.body));
        decisions.push({
          repo: repo.name, slug, num: item.number, title: item.title, url: item.html_url,
          user: login(item.user), merged,
          excerpt: clip(htmlToText(html), EXCERPT_MAX),
          threads: findReferences(item.body, repo.name)
            .map((ref) => threadIndex.get(keyFor(ref.repo, ref.num)))
            .filter(Boolean)
            .map((t) => ({ repo: t.repo, slug: t.slug, num: t.num }))
        });
        continue;
      }

      repoThreads++;
      const open = item.state === 'open';
      if (open) repoOpen++;
      const html = sanitizeHtml(item.body_html || '', ctxFor(item.body));
      const plain = htmlToText(html);
      const participants = [];
      for (const who of [login(item.user)].concat(itemComments.map((c) => login(c.user)))) {
        if (participants.length >= PARTICIPANTS_MAX) break;
        if (participants.indexOf(who) < 0) participants.push(who);
      }
      const last = itemComments.length ? itemComments[itemComments.length - 1] : null;
      threads.push({
        repo: repo.name,
        slug,
        num: item.number,
        title: item.title,
        url: item.html_url,
        user: login(item.user),
        user_id: userId(item.user),
        labels: (item.labels || []).map((label) => String((label && label.name) || label || '').toLowerCase()),
        state: open ? 'open' : 'closed',
        state_reason: item.state_reason || null,
        open,
        created: item.created_at,
        at: item.updated_at,
        closed: item.closed_at || null,
        comments: itemComments.length,
        last_user: last ? login(last.user) : null,
        last_at: last ? last.created_at : null,
        participants,
        excerpt: clip(plain, EXCERPT_MAX),
        text: clip(plain, TEXT_MAX),
        refs: []
      });
      files.set(slug + '/' + item.number, {
        html,
        comments: itemComments.map((c) => ({
          id: c.id,
          user: login(c.user),
          user_id: userId(c.user),
          created: c.created_at,
          updated: c.updated_at,
          html: sanitizeHtml(c.body_html || '', ctxFor(c.body)),
          url: c.html_url
        }))
      });
    }
    repos.push({
      name: repo.name, slug, description: repo.description || null, homepage: repo.homepage || null,
      url: repo.html_url, threads: repoThreads, open: repoOpen
    });
  }

  // Back-links: which issues and pull requests mention each thread.
  const threadByKey = new Map(threads.map((t) => [keyFor(t.repo, t.num), t]));
  const refsByKey = new Map();
  for (const source of sources) {
    const own = keyFor(source.repo, source.item.number);
    const texts = [source.item.body].concat(source.comments.map((c) => c.body));
    for (const text of texts) {
      for (const ref of findReferences(text, source.repo)) {
        const key = keyFor(ref.repo, ref.num);
        if (key === own || !threadByKey.has(key)) continue;
        if (!refsByKey.has(key)) refsByKey.set(key, new Map());
        const bucket = refsByKey.get(key);
        if (bucket.has(own)) continue;
        bucket.set(own, {
          created: source.item.created_at,
          ref: {
            repo: source.repo,
            slug: source.slug,
            num: source.item.number,
            kind: source.isPr ? 'pr' : 'issue',
            title: source.item.title,
            url: source.item.html_url,
            merged: source.isPr ? source.item.pull_request.merged_at || null : null,
            state: source.item.state === 'open' ? 'open' : 'closed'
          }
        });
      }
    }
  }
  for (const [key, bucket] of refsByKey) {
    threadByKey.get(key).refs = Array.from(bucket.values())
      .sort((a, b) => byText(b.created, a.created) || byText(a.ref.repo, b.ref.repo) || b.ref.num - a.ref.num)
      .map((entry) => entry.ref);
  }

  threads.sort((a, b) => byText(b.at, a.at) || byText(a.repo, b.repo) || b.num - a.num);
  decisions.sort((a, b) => byText(b.merged, a.merged) || byText(a.repo, b.repo) || b.num - a.num);

  const counts = {
    repos: repos.length,
    threads: threads.length,
    open: threads.filter((t) => t.open).length,
    closed: threads.filter((t) => !t.open).length,
    unanswered: threads.filter((t) => t.open && t.comments === 0).length,
    comments: threads.reduce((sum, t) => sum + t.comments, 0),
    decisions: decisions.length
  };

  const forum = { schema: 2, generated_at: generatedAt, org: ORG, repos, threads, decisions, counts };

  const threadFiles = [];
  for (const thread of threads) {
    const extra = files.get(thread.slug + '/' + thread.num);
    const data = {};
    for (const key of Object.keys(thread)) {
      if (key !== 'excerpt' && key !== 'text' && key !== 'comments') data[key] = thread[key];
    }
    data.html = extra.html;
    data.comments = extra.comments;
    threadFiles.push({ path: 't/' + thread.slug + '/' + thread.num + '.json', data });
  }
  threadFiles.sort((a, b) => byText(a.path, b.path));
  return { forum, threadFiles };
}

function contentHash(forum, threadFiles) {
  const hash = crypto.createHash('sha256');
  const stable = Object.assign({}, forum);
  delete stable.generated_at;
  hash.update('forum.json\n' + JSON.stringify(stable) + '\n');
  for (const file of threadFiles) hash.update(file.path + '\n' + JSON.stringify(file.data) + '\n');
  return hash.digest('hex');
}

function writeSnapshot(outDir, forum, threadFiles) {
  const dataDir = path.join(outDir, 'data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'forum.json'), JSON.stringify(forum) + '\n');
  for (const file of threadFiles) {
    const target = path.join(dataDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(file.data) + '\n');
  }
  const meta = {
    generated_at: forum.generated_at,
    content_hash: contentHash(forum, threadFiles),
    site_rev: siteRevision(),
    counts: forum.counts
  };
  fs.writeFileSync(path.join(dataDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node tools/build-forum-snapshot.js [--out _site] [--fixture <dir> | --record <dir>]');
    return;
  }
  const token = args.fixture ? '' : process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const gh = createClient({ token, fixture: args.fixture, record: args.record });
  const org = await readOrg(gh);
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { forum, threadFiles } = buildSnapshot(org, generatedAt);
  const outDir = path.resolve(args.out);
  const meta = writeSnapshot(outDir, forum, threadFiles);
  const c = forum.counts;
  console.log('wrote ' + (path.relative(process.cwd(), path.join(outDir, 'data')) || '.') + ': '
    + c.repos + ' repos, ' + c.threads + ' threads (' + c.open + ' open), ' + c.comments + ' comments, '
    + c.decisions + ' decisions; ' + threadFiles.length + ' thread files; hash ' + meta.content_hash.slice(0, 12)
    + (args.fixture ? ' [fixture]' : ' [' + gh.stats().requests + ' API requests]'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('build-forum-snapshot: ' + error.message);
    process.exit(1);
  });
}

module.exports = { buildSnapshot, findReferences, clip, contentHash, slugFor };

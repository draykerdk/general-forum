'use strict';

/*
 * Sequential GitHub REST client for the snapshot builder.
 *
 *   const gh = createClient({ token, record, fixture });
 *   const items = await gh.paginate('/orgs/draykerdk/repos?per_page=100');
 *
 * record:  directory; every response body (trimmed to the fields the builder
 *          reads, see trimForFixture) and its Link header are saved as
 *          <name>.json, where <name> is derived from the request URL only.
 *          Tokens and request headers are never written.
 * fixture: directory; responses are replayed from it and the network is never used.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.github.com';
const API_HOST = 'api.github.com';
const MAX_ATTEMPTS = 5;
const MAX_WAIT_MS = 15 * 60 * 1000;

function absolute(pathOrUrl) {
  return /^https:\/\//.test(pathOrUrl) ? pathOrUrl : API + (pathOrUrl.startsWith('/') ? '' : '/') + pathOrUrl;
}

// True only for an https URL whose host is exactly api.github.com (no port, no
// credentials). The token is sent to no other address.
function isApiUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (error) { return false; }
  return parsed.protocol === 'https:' && parsed.hostname === API_HOST && parsed.host === API_HOST && !parsed.username && !parsed.password;
}

function fixtureName(url) {
  const rel = absolute(url).replace(/^https:\/\/api\.github\.com\//, '');
  const readable = rel.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+|_+$/g, '').slice(0, 90);
  const hash = crypto.createHash('sha256').update(rel).digest('hex').slice(0, 10);
  return readable + '-' + hash + '.json';
}

function nextLink(link) {
  if (!link) return null;
  for (const part of String(link).split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}

// Recorded fixtures keep only the fields the snapshot builder reads, so the
// committed fixture stays small. Lists of repositories, pull requests, issues
// and comments are recognised by their item shape; any other body is saved
// unchanged.
const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
};
const pickUser = (user) => (user ? pick(user, ['login', 'id']) : user);

function trimForFixture(body) {
  if (!Array.isArray(body)) return body;
  return body.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if ('full_name' in item && 'has_issues' in item) {
      return pick(item, ['name', 'private', 'visibility', 'archived', 'has_issues', 'description', 'homepage', 'html_url', 'default_branch']);
    }
    if ('number' in item && 'base' in item && 'head' in item) {
      const out = pick(item, ['number', 'state', 'merged_at']);
      out.base = item.base ? pick(item.base, ['ref']) : item.base;
      return out;
    }
    if ('issue_url' in item) {
      return Object.assign(pick(item, ['id', 'issue_url', 'html_url', 'created_at', 'updated_at', 'minimized', 'body', 'body_html']), { user: pickUser(item.user) });
    }
    if ('number' in item && 'state' in item) {
      const out = pick(item, ['number', 'title', 'html_url', 'state', 'state_reason', 'created_at', 'updated_at', 'closed_at', 'comments', 'locked', 'active_lock_reason', 'body', 'body_html']);
      out.user = pickUser(item.user);
      out.labels = (item.labels || []).map((label) => pick(label, ['name']));
      if (item.pull_request) out.pull_request = pick(item.pull_request, ['html_url', 'merged_at']);
      return out;
    }
    return item;
  });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createClient(options) {
  const opts = options || {};
  const token = opts.token || '';
  const record = opts.record ? path.resolve(opts.record) : null;
  const fixture = opts.fixture ? path.resolve(opts.fixture) : null;
  const log = opts.log || ((message) => process.stderr.write(message + '\n'));
  const sleep = opts.sleep || defaultSleep;
  const fetchImpl = opts.fetch || globalThis.fetch;
  let requests = 0;

  if (fixture && !fs.existsSync(fixture)) throw new Error('Fixture directory not found: ' + fixture);
  if (record) fs.mkdirSync(record, { recursive: true });

  async function network(url) {
    const headers = {
      Accept: 'application/vnd.github.full+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'drayker-forum-snapshot'
    };
    if (token) {
      // A caller or a Link header could name another host: the token never goes there.
      if (!isApiUrl(url)) throw new Error('Refusing to send the GitHub token to a URL outside https://api.github.com: ' + url);
      headers.Authorization = 'Bearer ' + token;
    }

    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        requests++;
        response = await fetchImpl(url, { headers });
      } catch (error) {
        if (attempt < MAX_ATTEMPTS) {
          const wait = 1000 * 2 ** (attempt - 1);
          log('network error on ' + url + ' (' + error.message + '); retrying in ' + wait / 1000 + 's');
          await sleep(wait);
          continue;
        }
        throw new Error('GitHub request failed after ' + attempt + ' attempts: ' + url + ': ' + error.message);
      }
      if (response.ok) {
        return { body: await response.json(), link: response.headers.get('link') || null };
      }

      const status = response.status;
      const text = await response.text().catch(() => '');
      let message = '';
      try { message = JSON.parse(text).message || ''; } catch (error) { message = text.slice(0, 200); }
      const retryAfter = Number(response.headers.get('retry-after'));
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      let wait = null;
      if (status >= 500) {
        wait = 1000 * 2 ** (attempt - 1);
      } else if (status === 403 || status === 429) {
        if (retryAfter > 0) wait = retryAfter * 1000;
        else if (remaining === '0' && reset > 0) wait = Math.max(0, reset * 1000 - Date.now()) + 1000;
        else if (status === 429 || /secondary rate limit|abuse/i.test(message)) wait = Math.max(60000, 1000 * 2 ** attempt);
      }
      if (wait !== null && attempt < MAX_ATTEMPTS && wait <= MAX_WAIT_MS) {
        log('GitHub returned HTTP ' + status + ' for ' + url + '; retrying in ' + Math.ceil(wait / 1000) + 's');
        await sleep(wait);
        continue;
      }
      let detail = 'GitHub API returned HTTP ' + status + ' for ' + url + (message ? ': ' + message : '');
      if (remaining === '0' && reset > 0) {
        detail += ' (rate limit exhausted; resets at ' + new Date(reset * 1000).toISOString() + (token ? '' : '; set GITHUB_TOKEN or GH_TOKEN for a higher limit') + ')';
      }
      throw new Error(detail);
    }
  }

  async function get(pathOrUrl) {
    const url = absolute(pathOrUrl);
    if (fixture) {
      const file = path.join(fixture, fixtureName(url));
      if (!fs.existsSync(file)) throw new Error('No fixture response for ' + url + ' (expected ' + path.relative(process.cwd(), file) + ')');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { body: saved.body, link: saved.link || null };
    }
    const result = await network(url);
    if (record) {
      const file = path.join(record, fixtureName(url));
      fs.writeFileSync(file, JSON.stringify({ url, link: result.link, body: trimForFixture(result.body) }) + '\n');
    }
    return result;
  }

  async function paginate(pathOrUrl) {
    const items = [];
    let url = absolute(pathOrUrl);
    const seen = new Set();
    while (url) {
      if (seen.has(url)) throw new Error('Pagination loop at ' + url);
      seen.add(url);
      const { body, link } = await get(url);
      if (!Array.isArray(body)) throw new Error('Expected a list from ' + url);
      items.push(...body);
      url = nextLink(link);
    }
    return items;
  }

  return { get, paginate, stats: () => ({ requests }) };
}

module.exports = { createClient, fixtureName, nextLink, trimForFixture, isApiUrl };

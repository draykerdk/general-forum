#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ORG = 'draykerdk';
const OUT = path.join(__dirname, '..', 'data', 'forum.json');
const API = 'https://api.github.com/search/issues?q=';

async function search(query, limit) {
  const url = API + encodeURIComponent(query) + '&sort=updated&order=desc&per_page=' + limit;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'drayker-forum-snapshot'
    }
  });
  if (!response.ok) throw new Error('GitHub API returned HTTP ' + response.status);
  const payload = await response.json();
  return payload.items || [];
}

async function main() {
  const [issues, prs] = await Promise.all([
    search('org:' + ORG + ' is:issue', 60),
    search('org:' + ORG + ' is:pr is:merged', 24)
  ]);
  const data = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    threads: issues.map((item) => ({
      num: item.number,
      title: item.title,
      url: item.html_url,
      repo: String(item.repository_url || '').split('/').pop(),
      labels: (item.labels || []).map((label) => String(label.name || '').toLowerCase()),
      user: item.user ? item.user.login : '',
      body: item.body || '',
      comments: item.comments || 0,
      at: item.updated_at,
      open: item.state !== 'closed'
    })),
    decisions: prs.map((item) => ({
      num: item.number,
      title: item.title,
      url: item.html_url,
      repo: String(item.repository_url || '').split('/').pop(),
      user: item.user ? item.user.login : '',
      at: item.closed_at || item.updated_at
    }))
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log('wrote ' + path.relative(process.cwd(), OUT) + ': ' + data.threads.length + ' threads, ' + data.decisions.length + ' decisions');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

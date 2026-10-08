'use strict';
// Writes the synthetic fixture in test/fixtures/live-safety: ordinary content
// that anyone can post on GitHub and that must never block a deploy, plus the
// data cases for decisions, references and locked threads.
// Run: node test/fixtures/make-live-safety-fixture.js
const fs = require('fs'); const path = require('path');
const { fixtureName } = require('../../tools/lib/github.js');
const dir = path.join(__dirname, 'live-safety');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const A = 'https://api.github.com';
const save = (rel, body) => {
  const url = A + rel;
  fs.writeFileSync(path.join(dir, fixtureName(url)), JSON.stringify({ url, link: null, body }, null, 1) + '\n');
};
const R = 'https://github.com/draykerdk/lab';
const issueLink = (n, kind) => '<a class="issue-link js-issue-link" data-hovercard-type="' + (kind === 'pull' ? 'pull_request' : 'issue') + '" href="' + R + '/' + (kind || 'issues') + '/' + n + '">#' + n + '</a>';
const issue = (n, title, login, extra) => Object.assign({
  number: n, title, html_url: R + '/issues/' + n, state: 'open', state_reason: null,
  created_at: '2026-02-0' + n + 'T00:00:00Z', updated_at: '2026-03-0' + n + 'T00:00:00Z', closed_at: null,
  comments: 0, locked: false, active_lock_reason: null, body: '', body_html: '', user: { login, id: 100 + n }, labels: []
}, extra || {});
const pull = (n, title, login, merged, extra) => issue(n, title, login, Object.assign({
  html_url: R + '/pull/' + n, state: 'closed', closed_at: merged, pull_request: { html_url: R + '/pull/' + n, merged_at: merged }
}, extra || {}));

save('/orgs/draykerdk/repos?type=public&per_page=100', [
  { name: 'lab', private: false, visibility: 'public', archived: false, has_issues: true, description: 'Synthetic repository for the live-mode checks', homepage: null, html_url: R, default_branch: 'main' }
]);

save('/repos/draykerdk/lab/issues?state=all&per_page=100&sort=created&direction=asc', [
  // A title that markdown stripping would empty, prose about templates and
  // script, text that looks like attributes, and a malformed percent-escape.
  issue(1, '>', 'open-source-fan', {
    comments: 2,
    body: 'See #2. Not a reference: `#3`.',
    body_html: '<p>See ' + issueLink(2) + '. Not a reference: <code>#3</code>, nor <a href="#3">#3</a>.</p>'
      + '<p>Templates look like {{ name }}. Never allow <code>javascript:</code> URLs. Set onclick = handler, or write href="relative", id="x" and style="color:red".</p>'
      + '<p><a href="https://github.com/draykerdk/a%E9/issues/1">A malformed escape</a></p>'
  }),
  issue(2, '- item', 'OWNER-dev', {
    body: 'A link to https://github.com/t/lab/1/',
    body_html: '<p>A user link to <a href="https://github.com/t/lab/1/">github.com/t/lab/1</a> and a relative one to <a href="/t/lab/1/">/t/lab/1/</a>.</p>'
  }),
  issue(3, 'How do {{ placeholders }} work? javascript: onclick=x', 'dknowledger-x', {
    locked: true, active_lock_reason: 'resolved',
    body: 'Locked.', body_html: '<p>Locked.</p>'
  }),
  pull(4, 'Merge the {{ template }} change', 'MEMBER-bot', '2026-03-10T00:00:00Z', {
    body: 'Closes #1', body_html: '<p>Closes ' + issueLink(1) + '</p>'
  }),
  pull(5, 'Sync master into side', 'COLLABORATOR-x', '2026-03-11T00:00:00Z', {
    body: 'update', body_html: '<p>update, see ' + issueLink(2) + '</p>'
  })
]);

save('/repos/draykerdk/lab/issues/comments?per_page=100&sort=created&direction=asc', [
  {
    id: 201, issue_url: A + '/repos/draykerdk/lab/issues/1', html_url: R + '/issues/1#issuecomment-201',
    created_at: '2026-02-02T00:00:00Z', updated_at: '2026-02-02T00:00:00Z', user: { login: 'OWNER-dev', id: 102 },
    body: 'In Handlebars you write `{{ name }}`',
    body_html: '<p>In Handlebars you write <code>{{ name }}</code></p><p>Never allow <code>javascript:</code> URLs or <code>onclick=</code> handlers.</p>'
  },
  {
    id: 202, issue_url: A + '/repos/draykerdk/lab/issues/1', html_url: R + '/issues/1#issuecomment-202',
    created_at: '2026-02-03T00:00:00Z', updated_at: '2026-02-03T00:00:00Z', user: { login: 'open-source-fan', id: 101 },
    body: 'See https://github.com/t/lab/1/',
    body_html: '<p>See <a href="https://github.com/t/lab/1/">this</a>, ' + issueLink(2) + ' and <a href="https://github.com/DraykerDK/LAB/issues/2#issuecomment-1">that</a>.</p>'
  }
]);

save('/repos/draykerdk/lab/pulls?state=closed&per_page=100', [
  { number: 5, state: 'closed', merged_at: '2026-03-11T00:00:00Z', base: { ref: 'side' } },
  { number: 4, state: 'closed', merged_at: '2026-03-10T00:00:00Z', base: { ref: 'main' } }
]);

console.log('wrote ' + fs.readdirSync(dir).length + ' files to ' + path.relative(process.cwd(), dir));

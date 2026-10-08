'use strict';
// Writes the synthetic fixture in test/fixtures/live-safety: ordinary content
// that anyone can post on GitHub and that must never block a deploy, plus the
// data cases for decisions, references, locked threads and hidden comments.
// The daf repository holds the federation's cases: assembly reports (one
// merged into the default branch, one open) with vote lines in mixed case, by
// an account that is not the holder's speaker, prose that starts with "Vote: ",
// a person's comment that starts with the tally marker, the tally bot's comment
// and a comment that writes the forum's own vote tag markup; an issue titled
// "Vote: …", a [Veto] issue and a locked issue whose reply says "Reply on GitHub".
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
const D = 'https://github.com/draykerdk/daf';
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
  { name: 'daf', private: false, visibility: 'public', archived: false, has_issues: true, description: 'Synthetic federation repository for the live-mode checks', homepage: null, html_url: D, default_branch: 'master' },
  { name: 'lab', private: false, visibility: 'public', archived: false, has_issues: true, description: 'Synthetic repository for the live-mode checks', homepage: null, html_url: R, default_branch: 'main' }
]);

save('/repos/draykerdk/lab/issues?state=all&per_page=100&sort=created&direction=asc', [
  // A title that markdown stripping would empty, prose about templates and
  // script, text that looks like attributes, and a malformed percent-escape.
  issue(1, '>', 'open-source-fan', {
    comments: 2,
    body: 'See #2. Not a reference: `#3`.',
    body_html: '<p>See ' + issueLink(2) + '. Not a reference: <code>#3</code>, nor <a href="#3">#3</a>.</p>'
      + '<p>Templates look like {{ name }}. Never allow <code>javascript:</code> URLs. Set onclick = handler, or write href="relative", href="/x", id="x" and style="color:red".</p>'
      + '<p><a href="https://github.com/draykerdk/a%E9/issues/1">A malformed escape</a></p>'
  }),
  issue(2, '- item', 'OWNER-dev', {
    comments: 1,
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
  }),
  // Titles, a login and a label made only of characters XML cannot carry, and
  // a body of emoji only (no word boundary to clip at).
  issue(6, '\u0001', '\u0003', {
    labels: [{ name: '\u0002' }, { name: 'question' }],
    body: '\u{1F600}'.repeat(300), body_html: '<p>' + '\u{1F600}'.repeat(300) + '</p>'
  }),
  pull(7, '\uFFFF', 'MEMBER-bot', '2026-03-12T00:00:00Z', {
    body: 'Long description', body_html: '<p>' + 'This change records the agreed wording for the lab repository. '.repeat(6)
      + 'The last sentence names the zeppelin, which only the full text holds.</p>'
  }),
  // A description that repeats the forum's assembly note word for word: it is
  // mirrored text, so it must never pass for the note.
  pull(8, 'Restate the assembly note', 'noter-gh', '2026-03-13T00:00:00Z', {
    body: 'An assembly report is merged whether the assembly passed or failed. The outcome is written in the report on GitHub.', body_html: '<p>An assembly report is merged whether the assembly passed or failed. The outcome is written in the report on GitHub.</p>'
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
  },
  // Hidden on GitHub: kept as a placeholder, none of its content is published
  // and its link to #1 is not a reference.
  {
    id: 203, issue_url: A + '/repos/draykerdk/lab/issues/2', html_url: R + '/issues/2#issuecomment-203',
    created_at: '2026-02-04T00:00:00Z', updated_at: '2026-02-05T00:00:00Z', user: { login: 'hidden-author', id: 109 },
    minimized: { reason: 'abuse' },
    body: 'HIDDENMARKER-7f3a see #1',
    body_html: '<p>HIDDENMARKER-7f3a see ' + issueLink(1) + '</p>'
  }
]);

save('/repos/draykerdk/lab/pulls?state=closed&per_page=100', [
  { number: 8, state: 'closed', merged_at: '2026-03-13T00:00:00Z', base: { ref: 'main' } },
  { number: 7, state: 'closed', merged_at: '2026-03-12T00:00:00Z', base: { ref: 'main' } },
  { number: 5, state: 'closed', merged_at: '2026-03-11T00:00:00Z', base: { ref: 'side' } },
  { number: 4, state: 'closed', merged_at: '2026-03-10T00:00:00Z', base: { ref: 'main' } }
]);

// ------------------------------------------------------------------ daf
const dafItem = (n, title, login, id, extra) => Object.assign({
  number: n, title, html_url: D + '/issues/' + n, state: 'open', state_reason: null,
  created_at: '2026-03-' + n + 'T00:00:00Z', updated_at: '2026-04-' + n + 'T00:00:00Z', closed_at: null,
  comments: 0, locked: false, active_lock_reason: null, body: '', body_html: '', user: { login, id }, labels: []
}, extra || {});
const dafPull = (n, title, merged, extra) => dafItem(n, title, 'steward-gh', 300, Object.assign({
  html_url: D + '/pull/' + n, state: merged ? 'closed' : 'open', closed_at: merged || null, pull_request: { html_url: D + '/pull/' + n, merged_at: merged || null }
}, extra || {}));
const dafComment = (n, id, login, userId, body, bodyHtml, extra) => Object.assign({
  id, issue_url: A + '/repos/draykerdk/daf/issues/' + n, html_url: D + (n === 21 || n === 22 ? '/pull/' : '/issues/') + n + '#issuecomment-' + id,
  created_at: '2026-03-' + n + 'T0' + (id % 10) + ':00:00Z', updated_at: '2026-03-' + n + 'T0' + (id % 10) + ':00:00Z',
  minimized: null, body, body_html: bodyHtml, user: { login, id: userId, type: 'User' }
}, extra || {});

save('/repos/draykerdk/daf/issues?state=all&per_page=100&sort=created&direction=asc', [
  dafPull(21, 'Assembly 2026-09', '2026-03-29T00:00:00Z', { comments: 1, body: 'The report.', body_html: '<p>The report.</p>' }),
  dafPull(22, 'Assembly 2026-10', null, {
    comments: 7, body: 'Vote: the report for the cycle in #24.', body_html: '<p>Vote: the report for the cycle in <a class="issue-link js-issue-link" href="' + D + '/issues/24">#24</a>.</p>'
  }),
  dafItem(23, 'Vote: should we move the meeting?', 'meeting-gh', 301, { comments: 2, body: 'Vote: yes or no.', body_html: '<p>Vote: yes or no.</p>' }),
  dafItem(24, '[Veto] The 2026-09 assembly decision', 'example-delta-gh', 302, {
    body: 'Vote: against the award, on these grounds.', body_html: '<h3>Grounds</h3><p>Vote: against the award, on these grounds.</p>'
  }),
  dafItem(25, 'A locked question', 'asker-gh', 303, { comments: 1, locked: true, active_lock_reason: 'resolved', body: 'Locked.', body_html: '<p>Locked.</p>' })
]);

save('/repos/draykerdk/daf/issues/comments?per_page=100&sort=created&direction=asc', [
  dafComment(21, 2101, 'example-river-gh', 311, 'Vote: For\nAS: Example-River', '<p>Vote: For<br>\nAS: Example-River</p>'),
  // A valid vote line in mixed case: DAF's parser reads it.
  dafComment(22, 2201, 'example-river-gh', 311, 'Vote: for\nAS: example-river', '<p>Vote: for<br>\nAS: example-river</p>'),
  // Prose that starts with "Vote: ": not a vote line.
  dafComment(22, 2202, 'talker-gh', 312, 'Vote: I would support this.', '<p>Vote: I would support this.</p>'),
  // A person's comment that starts with the tally marker: an ordinary comment,
  // and DAF still reads the vote line in it.
  dafComment(22, 2203, 'example-cedar-gh', 313, '<!-- daf-tally:v1 -->\nVOTE: for\nAS: example-cedar', '<p>VOTE: for<br>\nAS: example-cedar</p>'),
  // The federation's tally, by its bot: kept in place, its count never published.
  dafComment(22, 2204, 'github-actions[bot]', 41898282, '<!-- daf-tally:v1 -->\n## Tally\n\nTALLYCOUNT-5e2b for: 4 points',
    '<h2>Tally</h2>\n<p>TALLYCOUNT-5e2b for: 4 points</p>', { user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' } }),
  // A vote line by an account that is not the holder's speaker: tagged with
  // what it names, never as the holder's vote.
  dafComment(22, 2205, 'mallory-gh', 314, 'VOTE: against\nAS: example-cedar', '<p>VOTE: against<br>\nAS: example-cedar</p>'),
  // A comment that writes the forum's own markup: the sanitizer drops the class
  // and the attribute, so it is neither a vote tag nor an assembly notice.
  dafComment(22, 2206, 'forger-gh', 315, 'Vote line: for · names example-river',
    '<p class="fs-meta fs-vote">Vote line: for · names example-river</p><section aria-label="Assembly report"><p>Assembly report, proposed.</p></section><p>Reply on GitHub</p>'),
  // A vote line inside an HTML comment: GitHub renders nothing, DAF still reads
  // the line, so the forum shows the tag and points to GitHub for the rest.
  dafComment(22, 2207, 'hider-gh', 317, '<!--\nVOTE: for\nAS: example-oak\n-->', ''),
  dafComment(23, 2301, 'meeting-gh', 301, 'Vote: yes, merge it', '<p>Vote: yes, merge it</p>'),
  // On an issue, a vote line is never read.
  dafComment(23, 2302, 'example-river-gh', 311, 'VOTE: for\nAS: example-river', '<p>VOTE: for<br>\nAS: example-river</p>'),
  dafComment(25, 2501, 'helper-gh', 316, 'Reply on GitHub when you can.', '<p>Reply on GitHub when you can.</p>')
]);

save('/repos/draykerdk/daf/pulls?state=closed&per_page=100', [
  { number: 21, state: 'closed', merged_at: '2026-03-29T00:00:00Z', base: { ref: 'master' } }
]);

console.log('wrote ' + fs.readdirSync(dir).length + ' files to ' + path.relative(process.cwd(), dir));

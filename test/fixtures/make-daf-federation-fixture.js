'use strict';
// Adds synthetic federation threads to the daf responses of the recorded
// fixture in test/fixtures/github: one [Claim] issue, one [Cycle] issue and one
// open "Assembly 2026-11" pull request with three comments (a vote, a plain
// discussion comment, and a vote hidden on GitHub), and a merged
// "Assembly 2026-10" pull request (a thread and a decision). Nothing else in the
// recording is changed. Synthetic items use numbers 9001-9004 and are replaced
// on every run, so running it twice gives the same files.
// Run after re-recording (see test/fixtures/README.md):
//   node test/fixtures/make-daf-federation-fixture.js
const fs = require('fs'); const path = require('path');
const { fixtureName } = require('../../tools/lib/github.js');
const dir = path.join(__dirname, 'github');
const A = 'https://api.github.com';
const R = 'https://github.com/draykerdk/daf';
const NUMS = [9001, 9002, 9003, 9004];
const COMMENT_IDS = [900300001, 900300002, 900300003];

function load(rel) {
  const url = A + rel;
  const file = path.join(dir, fixtureName(url));
  if (!fs.existsSync(file)) throw new Error('recorded response missing: ' + path.relative(process.cwd(), file) + ' (record the fixture first)');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (saved.url !== url || !Array.isArray(saved.body)) throw new Error('unexpected recording in ' + file);
  return { file, saved };
}
// Same layout as the recorder writes (tools/lib/github.js): one line.
const save = ({ file, saved }) => fs.writeFileSync(file, JSON.stringify(saved) + '\n');

const issueLink = (n) => '<a class="issue-link js-issue-link" data-hovercard-type="issue" href="' + R + '/issues/' + n + '">#' + n + '</a>';
const item = (n, title, login, id, extra) => Object.assign({
  number: n, title, html_url: R + '/issues/' + n, state: 'open', state_reason: null,
  created_at: '2026-10-08T0' + (n - 9000) + ':00:00Z', updated_at: '2026-10-08T0' + (n - 9000) + ':30:00Z', closed_at: null,
  comments: 0, locked: false, active_lock_reason: null, body: '', body_html: '', user: { login, id }, labels: []
}, extra || {});

const synthetic = [
  item(9001, '[Claim] Plain-language summary of DAF-001', 'example-river-gh', 7001, {
    labels: [{ name: 'claim' }],
    body: '### Function delivered\n\nA plain-language summary of DAF-001.\n\n### Where it is\n\nhttps://github.com/draykerdk/daf/pull/21',
    body_html: '<h3>Function delivered</h3>\n<p>A plain-language summary of DAF-001.</p>\n<h3>Where it is</h3>\n<p><a href="https://github.com/draykerdk/daf/pull/21">https://github.com/draykerdk/daf/pull/21</a></p>'
  }),
  item(9002, '[Cycle] Assembly 2026-11', 'example-cedar-gh', 7002, {
    labels: [{ name: 'assembly' }],
    body: '### Cycle\n\n2026-11\n\n### Claims\n\n#9001',
    body_html: '<h3>Cycle</h3>\n<p>2026-11</p>\n<h3>Claims</h3>\n<p>' + issueLink(9001) + '</p>'
  }),
  item(9003, 'Assembly 2026-11', 'example-cedar-gh', 7002, {
    html_url: R + '/pull/9003', comments: 3, updated_at: '2026-10-08T06:00:00Z',
    pull_request: { html_url: R + '/pull/9003', merged_at: null },
    body: 'The report for the cycle in #9002. Proposed: nothing in it is in the record until the assembly accepts it.',
    body_html: '<p>The report for the cycle in ' + issueLink(9002) + '. Proposed: nothing in it is in the record until the assembly accepts it.</p>'
  }),
  // Merged into the default branch: a thread, and a decision on the Decisions page.
  item(9004, 'Assembly 2026-10', 'example-cedar-gh', 7002, {
    html_url: R + '/pull/9004', state: 'closed', closed_at: '2026-10-08T04:30:00Z',
    pull_request: { html_url: R + '/pull/9004', merged_at: '2026-10-08T04:30:00Z' },
    body: 'The report for the cycle 2026-10.',
    body_html: '<p>The report for the cycle 2026-10.</p>'
  })
];

const comment = (id, login, userId, at, body, bodyHtml, extra) => Object.assign({
  id, issue_url: A + '/repos/draykerdk/daf/issues/9003', html_url: R + '/pull/9003#issuecomment-' + id,
  created_at: at, updated_at: at, minimized: null, body, body_html: bodyHtml, user: { login, id: userId }
}, extra || {});

const comments = [
  // A vote, written as DAF's own examples write it.
  comment(COMMENT_IDS[0], 'example-river-gh', 7001, '2026-10-08T04:00:00Z',
    'Discussion first.\n\nVOTE: for\nAS: `example-river`\n',
    '<p>Discussion first.</p>\n<p>VOTE: for<br>\nAS: <code>example-river</code></p>'),
  // Discussion that mentions voting but holds no vote.
  comment(COMMENT_IDS[1], 'example-delta-gh', 7003, '2026-10-08T05:00:00Z',
    'I would vote for this, but this is discussion.',
    '<p>I would vote for this, but this is discussion.</p>'),
  // A vote hidden on GitHub: its holder and text must appear in no built file.
  comment(COMMENT_IDS[2], 'example-ghost-gh', 7004, '2026-10-08T06:00:00Z',
    'HIDDENVOTE-4c1e\n\nVOTE: against\nAS: hidden-holder-4c1e\n',
    '<p>HIDDENVOTE-4c1e</p>\n<p>VOTE: against<br>\nAS: hidden-holder-4c1e</p>',
    { minimized: { reason: 'off-topic' } })
];

const issues = load('/repos/draykerdk/daf/issues?state=all&per_page=100&sort=created&direction=asc');
const recorded = issues.saved.body.filter((i) => !NUMS.includes(i.number));
const clash = recorded.find((i) => i.number >= 9000);
if (clash) throw new Error('daf #' + clash.number + ' exists on GitHub; move the synthetic numbers');
issues.saved.body = recorded.concat(synthetic);
save(issues);

const pulls = load('/repos/draykerdk/daf/pulls?state=closed&per_page=100');
pulls.saved.body = [{ number: 9004, state: 'closed', merged_at: '2026-10-08T04:30:00Z', base: { ref: 'master' } }].concat(pulls.saved.body.filter((p) => !NUMS.includes(p.number)));
save(pulls);

const list = load('/repos/draykerdk/daf/issues/comments?per_page=100&sort=created&direction=asc');
list.saved.body = list.saved.body.filter((c) => !COMMENT_IDS.includes(c.id)).concat(comments);
save(list);

console.log('added ' + synthetic.length + ' synthetic daf items and ' + comments.length + ' comments to ' + path.relative(process.cwd(), dir));

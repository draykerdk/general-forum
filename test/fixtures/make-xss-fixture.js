'use strict';
// Writes the synthetic sanitizer fixture in test/fixtures/xss (one repository,
// one issue, two comments). Run: node test/fixtures/make-xss-fixture.js
const fs = require('fs'); const path = require('path');
const { fixtureName } = require('../../tools/lib/github.js');
const dir = path.join(__dirname, 'xss');
fs.mkdirSync(dir, { recursive: true });
const A = 'https://api.github.com';
const user = { login: 'tester', id: 1 };
const save = (rel, body) => {
  const url = A + rel;
  fs.writeFileSync(path.join(dir, fixtureName(url)), JSON.stringify({ url, link: null, body }, null, 1) + '\n');
};
save('/orgs/draykerdk/repos?type=public&per_page=100', [
  { name: 'xss-lab', private: false, visibility: 'public', archived: false, has_issues: true, description: 'Synthetic repository for sanitizer tests', homepage: null, html_url: 'https://github.com/draykerdk/xss-lab', default_branch: 'main' }
]);
const issueBody = [
  '<p>Intro <script>alert("script")</script>text</p>',
  '<img src=x onerror=alert("img")>',
  '<p><a href="javascript:alert(1)">js</a> <a href="JaVaScRiPt:alert(2)">mixed</a> <a href="&#106;avascript:alert(3)">entity</a>',
  '<a href="&#x6A;&#x61;vascript&colon;alert(4)">hex</a> <a href=" java&Tab;script:alert(5)">tab</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCg2KTwvc2NyaXB0Pg==">data</a> <a href="vbscript:msgbox(7)">vb</a></p>',
  '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="data image"><img src="http://example.com/plain.png" alt="http image">',
  '<svg onload=alert(8)><circle r=1 /><text>svgtext</text></svg>',
  '<iframe src="https://example.com/frame">iframetext</iframe>',
  '<style>body{background:url(javascript:alert(9))}</style>',
  '<p style="color:red;background:url(javascript:alert(10))" onclick="alert(11)" id="x" data-x="y" aria-label="z" class="pl-k evil task-list-item">styled</p>',
  '<noscript><p title="</noscript><img src=x onerror=alert(12)>"></noscript>',
  '<math><mi xlink:href="javascript:alert(13)">mathtext</mi></math>',
  '<form action="https://example.com/steal"><input name="q" value="formtext"><button>buttontext</button></form>',
  '<p>Link to <a href="https://github.com/draykerdk/xss-lab/issues/1#issuecomment-2" class="issue-link js-issue-link" data-hovercard-type="issue" data-hovercard-url="/draykerdk/xss-lab/issues/1/hovercard">#1</a> and to <a href="https://github.com/draykerdk/xss-lab/issues/99">#99</a></p>',
  '<p>A malformed escape: <a href="https://github.com/draykerdk/a%E9/issues/1">bad escape</a></p>',
  '<p><b>unclosed bold <i>and italic'
].join('\n');
save('/repos/draykerdk/xss-lab/issues?state=all&per_page=100&sort=created&direction=asc', [
  {
    number: 1, title: 'Sanitizer <script>alert("title")</script> test', html_url: 'https://github.com/draykerdk/xss-lab/issues/1',
    state: 'open', state_reason: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', closed_at: null,
    comments: 2, body: 'Raw markdown, see #1 and draykerdk/xss-lab#1.', body_html: issueBody, user, labels: [{ name: 'Proposal' }]
  }
]);
const deep = '<div>'.repeat(40) + 'deepest' + '</div>'.repeat(40);
save('/repos/draykerdk/xss-lab/issues/comments?per_page=100&sort=created&direction=asc', [
  {
    id: 101, issue_url: 'https://api.github.com/repos/draykerdk/xss-lab/issues/1', html_url: 'https://github.com/draykerdk/xss-lab/issues/1#issuecomment-101',
    created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', user: { login: 'replier', id: 2 },
    body: '![shot](https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666)',
    body_html: '<p><a target="_blank" rel="noopener noreferrer" href="https://private-user-images.githubusercontent.com/2/398765432-0a1b2c3d-1111-2222-3333-444455556666.png?jwt=eyJhbGciOiJIUzI1NiJ9.e30.sig"><img src="https://private-user-images.githubusercontent.com/2/398765432-0a1b2c3d-1111-2222-3333-444455556666.png?jwt=eyJhbGciOiJIUzI1NiJ9.e30.sig" alt="shot" style="max-width: 100%;"></a></p>\n<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" checked=""> done</li><li>plain <input type="text" value="nope"></li></ul>'
  },
  {
    id: 102, issue_url: 'https://api.github.com/repos/draykerdk/xss-lab/issues/1', html_url: 'https://github.com/draykerdk/xss-lab/issues/1#issuecomment-102',
    created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', user: { login: 'tester', id: 1 },
    body: 'deep', body_html: deep + '<h1>Heading one</h1><h4>Heading four</h4><table><tr><td align="center" onmouseover="x">cell</td></tr></table><a href="mailto:a@example.com">mail</a><a href="/draykerdk/xss-lab">relative</a><a href="//example.com/proto">protocol relative</a><!-- comment <script>alert(14)</script> --><![CDATA[<img src=x onerror=alert(15)>]]>'
  }
]);
console.log('wrote ' + fs.readdirSync(dir).length + ' files to ' + path.relative(process.cwd(), dir));

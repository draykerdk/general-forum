# Fixtures

Recorded and synthetic GitHub API responses for building the forum data without network access.

## Format

Each file holds one API response: `{ "url": …, "link": …, "body": … }`. `link` is the response's `Link` header, used for pagination. The file name is derived from the request URL only (a readable part plus a short SHA-256 prefix; see `fixtureName` in `tools/lib/github.js`). Tokens and request headers are never written.

## `github/`: recorded from the live API

Replay:

```sh
node tools/build-forum-snapshot.js --fixture test/fixtures/github --out _site
```

Re-record (deletes the old recording first so stale responses do not remain):

```sh
rm -rf test/fixtures/github
GH_TOKEN="$(gh auth token)" node tools/build-forum-snapshot.js --record test/fixtures/github --out /tmp/forum-record
node tools/build-forum-snapshot.js --fixture test/fixtures/github --out /tmp/forum-replay
grep -rlF "$(gh auth token)" test/fixtures/github   # must print nothing
node test/fixtures/make-daf-federation-fixture.js     # then add the synthetic federation threads
```

The record and replay builds must produce the same `content_hash` in `data/meta.json`. Compare them before running `make-daf-federation-fixture.js`, which adds data that is not on GitHub.

### Synthetic federation threads

`make-daf-federation-fixture.js` adds to the recorded `daf` issues, comments and closed pulls responses, and changes nothing else: a `[Claim]` issue (#9001, label `claim`), a `[Cycle] Assembly 2026-11` issue (#9002, label `assembly`), and an open pull request `Assembly 2026-11` (#9003) with three comments: a vote (`VOTE: for` / ``AS: `example-river` ``), a discussion comment that holds no vote, and a vote hidden on GitHub (`minimized`) whose text and holder (`HIDDENVOTE-4c1e`, `hidden-holder-4c1e`) must appear nowhere in the built site; a pull request `Assembly 2026-10` (#9004) merged into `master`, which is both a thread and a decision; and a `[Veto]` issue (#9005) with no label, as DAF's veto form opens it, which the forum lists as FEDERATION. It replaces its own items on every run and stops if GitHub has a `daf` issue numbered 9000 or above.

### Trimming

To keep the recording small, the recorder saves only the fields the builder reads (`trimForFixture` in `tools/lib/github.js`):

- repositories: `name`, `private`, `visibility`, `archived`, `has_issues`, `description`, `homepage`, `html_url`, `default_branch`
- issues and pull requests (issues endpoint): `number`, `title`, `html_url`, `state`, `state_reason`, `created_at`, `updated_at`, `closed_at`, `comments`, `locked`, `active_lock_reason`, `body`, `body_html`, `user.login`, `user.id`, `labels[].name`, `pull_request.html_url`, `pull_request.merged_at`
- pull requests (pulls endpoint, read only for repositories with merged pull requests): `number`, `state`, `merged_at`, `base.ref`
- comments: `id`, `issue_url`, `html_url`, `created_at`, `updated_at`, `minimized` (set when the comment is hidden on GitHub), `body`, `body_html`, `user.login`, `user.id`, `user.type` (the federation's tally comment is recognised by its author, `github-actions[bot]` with type `Bot`; recordings made before `user.type` was kept have no tally comment)

Everything else (`body_text`, reactions, full user objects, API URLs, `author_association`) is dropped. The output of a build is the same with or without trimming. If the builder starts reading a new field, add it to `trimForFixture` and re-record.

## `xss/`: synthetic attack dataset

One repository (`xss-lab`), one issue and two comments whose `body_html` carries the sanitizer test vectors: `<script>`, `onerror`, `javascript:` in several encodings, `data:` and `vbscript:` URLs, `<svg onload>`, `<iframe>`, `<style>`, `style=`, a nested `<noscript>` breakout, `<math>`, `<form>`, unclosed tags, an expiring private image URL, a draykerdk issue link to rewrite and 40 nested `<div>` elements.

It also carries a link with a malformed percent-escape (`%E9`), which must not stop the build.

Regenerate with `rm -rf test/fixtures/xss && node test/fixtures/make-xss-fixture.js`.

## `live-safety/`: content that must never block a deploy

One repository (`lab`) with what anyone can post on GitHub and what the deploy checks must accept: prose with `{{ … }}`, `javascript:`, `onclick=`, `href="…"` and `id="…"`; logins such as `open-source-fan`, `OWNER-dev` and `MEMBER-bot`; the titles `>` and `- item`; a user link to `https://github.com/t/lab/1/`; a malformed percent-escape. It also covers the data rules: a pull request merged into a side branch (not a decision), references that are only in code or in-page anchors (not references), and a locked issue. It has an issue title, a login and a label made only of characters XML cannot carry (`\u0001`, `\u0003`, `\u0002`), a merged pull request titled `\uFFFF` with a description longer than the excerpt, a body of emoji only, prose with `href="/x"`, and a comment hidden on GitHub (`minimized`) whose text must appear nowhere in the built site.

A second repository (`daf`) holds the federation's cases, none of which may block a deploy: an assembly report merged into `master` (#21) and an open one (#22); on #22, a vote line in mixed case (`Vote: for`), prose that starts with `Vote: `, a person's comment that starts with the tally marker `<!-- daf-tally:v1 -->` (shown, and its vote line read), the tally bot's comment (withheld), a vote line by an account that is not the holder's speaker (tagged with what it names), and a comment that writes the forum's own vote tag and notice markup (the sanitizer drops it); an issue titled `Vote: should we move the meeting?` with `Vote: ` replies (#23), a `[Veto]` issue whose body holds `Vote: ` prose (#24), and a locked issue with a reply that says `Reply on GitHub` (#25). Vote tags and notices are counted as the forum's own markup only (`ownMarkers` in `tools/forum-check.js`), never as text.

`node tools/build-check.js` builds it, prerenders it and runs `tools/forum-check.js --live` on the result, which must pass; the fixture-mode check must flag the wording. Regenerate with `node test/fixtures/make-live-safety-fixture.js`.

`node tools/build-check.js` builds all three fixtures and checks the output.

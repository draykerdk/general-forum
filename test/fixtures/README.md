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
```

The record and replay builds must produce the same `content_hash` in `data/meta.json`.

### Trimming

To keep the recording small, the recorder saves only the fields the builder reads (`trimForFixture` in `tools/lib/github.js`):

- repositories: `name`, `private`, `visibility`, `archived`, `has_issues`, `description`, `homepage`, `html_url`, `default_branch`
- issues and pull requests (issues endpoint): `number`, `title`, `html_url`, `state`, `state_reason`, `created_at`, `updated_at`, `closed_at`, `comments`, `locked`, `active_lock_reason`, `body`, `body_html`, `user.login`, `user.id`, `labels[].name`, `pull_request.html_url`, `pull_request.merged_at`
- pull requests (pulls endpoint, read only for repositories with merged pull requests): `number`, `state`, `merged_at`, `base.ref`
- comments: `id`, `issue_url`, `html_url`, `created_at`, `updated_at`, `minimized` (set when the comment is hidden on GitHub), `body`, `body_html`, `user.login`, `user.id`

Everything else (`body_text`, reactions, full user objects, API URLs, `author_association`) is dropped. The output of a build is the same with or without trimming. If the builder starts reading a new field, add it to `trimForFixture` and re-record.

## `xss/`: synthetic attack dataset

One repository (`xss-lab`), one issue and two comments whose `body_html` carries the sanitizer test vectors: `<script>`, `onerror`, `javascript:` in several encodings, `data:` and `vbscript:` URLs, `<svg onload>`, `<iframe>`, `<style>`, `style=`, a nested `<noscript>` breakout, `<math>`, `<form>`, unclosed tags, an expiring private image URL, a draykerdk issue link to rewrite and 40 nested `<div>` elements.

It also carries a link with a malformed percent-escape (`%E9`), which must not stop the build.

Regenerate with `rm -rf test/fixtures/xss && node test/fixtures/make-xss-fixture.js`.

## `live-safety/`: content that must never block a deploy

One repository (`lab`) with what anyone can post on GitHub and what the deploy checks must accept: prose with `{{ … }}`, `javascript:`, `onclick=`, `href="…"` and `id="…"`; logins such as `open-source-fan`, `OWNER-dev` and `MEMBER-bot`; the titles `>` and `- item`; a user link to `https://github.com/t/lab/1/`; a malformed percent-escape. It also covers the data rules: a pull request merged into a side branch (not a decision), references that are only in code or in-page anchors (not references), and a locked issue. It has an issue title, a login and a label made only of characters XML cannot carry (`\u0001`, `\u0003`, `\u0002`), a merged pull request titled `\uFFFF` with a description longer than the excerpt, a body of emoji only, prose with `href="/x"`, and a comment hidden on GitHub (`minimized`) whose text must appear nowhere in the built site.

`node tools/build-check.js` builds it, prerenders it and runs `tools/forum-check.js --live` on the result, which must pass; the fixture-mode check must flag the wording. Regenerate with `node test/fixtures/make-live-safety-fixture.js`.

`node tools/build-check.js` builds all three fixtures and checks the output.

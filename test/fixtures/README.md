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

- repositories: `name`, `private`, `visibility`, `archived`, `has_issues`, `description`, `homepage`, `html_url`
- issues and pull requests: `number`, `title`, `html_url`, `state`, `state_reason`, `created_at`, `updated_at`, `closed_at`, `comments`, `body`, `body_html`, `user.login`, `user.id`, `labels[].name`, `pull_request.html_url`, `pull_request.merged_at`
- comments: `id`, `issue_url`, `html_url`, `created_at`, `updated_at`, `body`, `body_html`, `user.login`, `user.id`

Everything else (`body_text`, reactions, full user objects, API URLs, `author_association`) is dropped. The output of a build is the same with or without trimming. If the builder starts reading a new field, add it to `trimForFixture` and re-record.

## `xss/`: synthetic attack dataset

One repository (`xss-lab`), one issue and two comments whose `body_html` carries the sanitizer test vectors: `<script>`, `onerror`, `javascript:` in several encodings, `data:` and `vbscript:` URLs, `<svg onload>`, `<iframe>`, `<style>`, `style=`, a nested `<noscript>` breakout, `<math>`, `<form>`, unclosed tags, an expiring private image URL, a draykerdk issue link to rewrite and 40 nested `<div>` elements.

Regenerate with `node test/fixtures/make-xss-fixture.js`. `node tools/build-check.js` builds both fixtures and checks the output.

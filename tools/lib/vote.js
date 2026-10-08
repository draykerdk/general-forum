'use strict';

/*
 * DAF's vote parser, copied so that the forum reads a vote comment exactly as
 * the federation does.
 *
 * Source: draykerdk/daf, tools/lib/tally.js at commit
 * 5f62b6b908dc6c61c508ded5100defd461dcd25a (branch phase-0/instruments).
 * VOTE_RE, AS_RE and readVote are copied unchanged; index.html carries the same
 * two regular expressions for the live layer, and build-check compares them.
 *
 * The forum only reads a vote to tag the comment that holds it. It never counts
 * votes, weighs them, checks a quorum or derives an outcome: the tally is the
 * federation's, computed on GitHub by its Federation tally workflow.
 */

const VOTE_RE = /^\s*VOTE:\s*(for|against|abstain)\s*$/im;
const AS_RE = /^\s*AS:\s*`?([a-z0-9-]+)`?\s*$/im;

/** Read a vote from a comment body, or null. */
function readVote(body) {
  const v = VOTE_RE.exec(body || '');
  const a = AS_RE.exec(body || '');
  if (!v || !a) return null;
  return { vote: v[1].toLowerCase(), holder: a[1].toLowerCase() };
}

// The forum's shape of a vote: { vote, as } or null.
function voteOf(body) {
  const v = readVote(body);
  return v ? { vote: v.vote, as: v.holder } : null;
}

// The title of an assembly report pull request (daf federation/README.md).
const ASSEMBLY_TITLE = /^Assembly \d{4}-(0[1-9]|1[0-2])$/;

// The first line of the comment that DAF's Federation tally workflow keeps on
// an assembly pull request (daf .github/workflows/federation-tally.yml writes
// '<!-- daf-tally:v1 -->'). That comment carries the federation's count, which
// the forum never shows.
const TALLY_MARKER = /^<!-- daf-tally:v[0-9]+ -->/;
// The account that workflow posts as. A comment is the tally only when that
// account (type Bot) wrote it and its body starts with the marker, the rule of
// daf tools/lib/sticky.js isOurs: a person's comment that happens to start with
// the marker is an ordinary comment, and DAF still reads the vote in it.
const TALLY_BOT = 'github-actions[bot]';
const isTallyComment = (c) => !!(c && c.user && c.user.login === TALLY_BOT && c.user.type === 'Bot' && TALLY_MARKER.test(String(c.body || '')));

module.exports = { VOTE_RE, AS_RE, readVote, voteOf, ASSEMBLY_TITLE, TALLY_MARKER, TALLY_BOT, isTallyComment };

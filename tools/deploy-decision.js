#!/usr/bin/env node
'use strict';

/*
 * Decides whether the site workflow deploys the build it just made.
 *
 *   node tools/deploy-decision.js --event <github event name> [--meta _site/data/meta.json]
 *                                 [--live https://forum.drayker.org/data/meta.json]
 *
 * push and workflow_dispatch always deploy. A scheduled run skips the deploy
 * only when the live meta.json has the same content_hash and site_rev as the
 * new build; if the live file cannot be read, it deploys. Writes deploy=true
 * or deploy=false to $GITHUB_OUTPUT when that variable is set, and logs why.
 */

const fs = require('fs');

function parseArgs(argv) {
  const args = { event: process.env.GITHUB_EVENT_NAME || '', meta: '_site/data/meta.json', live: 'https://forum.drayker.org/data/meta.json' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[++i];
    if (value === undefined) throw new Error(key + ' needs a value');
    if (key === '--event') args.event = value;
    else if (key === '--meta') args.meta = value;
    else if (key === '--live') args.live = value;
    else throw new Error('Unknown argument: ' + key);
  }
  return args;
}

async function readLive(url) {
  const response = await fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

async function decide(args, read = readLive) {
  const local = JSON.parse(fs.readFileSync(args.meta, 'utf8'));
  if (args.event !== 'schedule') return { deploy: true, reason: 'event "' + (args.event || 'unknown') + '" always deploys' };
  let live;
  try {
    live = await read(args.live);
  } catch (error) {
    return { deploy: true, reason: 'live meta.json could not be read (' + error.message + ')' };
  }
  const sameContent = live && live.content_hash === local.content_hash;
  const sameRev = live && live.site_rev === local.site_rev;
  if (sameContent && sameRev) {
    return { deploy: false, reason: 'content_hash ' + String(local.content_hash).slice(0, 12) + ' and site_rev ' + String(local.site_rev).slice(0, 12) + ' are already live' };
  }
  const changed = [];
  if (!sameContent) changed.push('content_hash ' + String(live && live.content_hash).slice(0, 12) + ' -> ' + String(local.content_hash).slice(0, 12));
  if (!sameRev) changed.push('site_rev ' + String(live && live.site_rev).slice(0, 12) + ' -> ' + String(local.site_rev).slice(0, 12));
  return { deploy: true, reason: changed.join(', ') };
}

if (require.main === module) {
  (async () => {
    const result = await decide(parseArgs(process.argv.slice(2)));
    console.log((result.deploy ? 'Deploying: ' : 'Skipping the deploy: ') + result.reason);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'deploy=' + result.deploy + '\n');
  })().catch((error) => {
    console.error('deploy-decision: ' + error.message);
    process.exit(1);
  });
}

module.exports = { decide };

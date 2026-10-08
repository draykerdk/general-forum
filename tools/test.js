#!/usr/bin/env node
'use strict';

/*
 * npm test: runs the data checks, the site checks and the UI checks, in that
 * order, and stops at the first failure.
 *
 *   node tools/test.js [--live] [--site _site]
 *
 * build-check builds its own fixtures. forum-check checks the built site in
 * --site (run a build first: npm run build:fixture or npm run build); with
 * --live it runs in live mode (see tools/forum-check.js), for a build from the
 * live GitHub data. ui-check always runs on a snapshot built here from the
 * recorded fixture in a temporary directory, never on the site's data, because
 * it asserts specific content.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'github');

function parseArgs(argv) {
  const args = { live: false, site: '_site' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') args.live = true;
    else if (argv[i] === '--site' && argv[i + 1] !== undefined) args.site = argv[++i];
    else throw new Error('Unknown argument: ' + argv[i]);
  }
  return args;
}

// Runs one check and returns its exit status (0 when it passed).
function run(file, argv) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)].concat(argv || []), { stdio: 'inherit', cwd: ROOT });
  if (result.status === 0) return 0;
  console.error('npm test: ' + file + ' failed');
  return result.status || 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let status = run('build-check.js');
  if (!status) status = run('forum-check.js', ['--site', path.resolve(args.site)].concat(args.live ? ['--live'] : []));
  if (status) return status;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-test-fixture-'));
  try {
    const out = path.join(tmp, 'site');
    const build = spawnSync(process.execPath, [path.join(__dirname, 'build-forum-snapshot.js'), '--fixture', FIXTURE, '--out', out], { encoding: 'utf8', cwd: ROOT });
    if (build.status !== 0) {
      process.stderr.write(build.stdout + build.stderr);
      console.error('npm test: building the fixture snapshot for ui-check failed');
      return build.status || 1;
    }
    return run('ui-check.js', [path.join(out, 'data', 'forum.json')]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

let code;
try {
  code = main();
} catch (error) {
  console.error('npm test: ' + error.message);
  code = 1;
}
process.exitCode = code;

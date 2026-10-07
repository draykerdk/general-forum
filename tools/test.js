#!/usr/bin/env node
'use strict';

/*
 * npm test: runs the data checks, the site checks and, when present, the UI
 * checks, in that order, and stops at the first failure.
 * Run a build first (npm run build:fixture or npm run build).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const steps = ['build-check.js', 'forum-check.js', 'ui-check.js'];
for (const step of steps) {
  const file = path.join(__dirname, step);
  if (step === 'ui-check.js' && !fs.existsSync(file)) continue;
  const run = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (run.status !== 0) {
    console.error('npm test: ' + step + ' failed');
    process.exit(run.status || 1);
  }
}

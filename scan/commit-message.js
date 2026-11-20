#!/usr/bin/env node
// Prints the subject line for the daily data commit, read from what the run
// recorded in data/status.json, so the commit says what happened: a published
// scan, a scan that stopped, a result that was not published, or no scan.
//
//   node scan/commit-message.js [--data <dir>] [--since <ISO time>]
//
// --since is the start of the run: an outcome recorded before it is not this
// run's. An empty or unreadable value is ignored.

import path from 'node:path';
import { SITE_ROOT } from '../lib/checker.js';
import { readJsonIfExists } from '../lib/fsutil.js';
import { commitSubject } from './core.js';

const argv = process.argv.slice(2);
let data = path.join(SITE_ROOT, 'data');
let since = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--data') data = path.resolve(argv[++i] ?? '');
  else if (argv[i] === '--since') since = argv[++i] || null;
  else {
    process.stderr.write(`unknown argument ${argv[i]}\nnode scan/commit-message.js [--data <dir>] [--since <ISO time>]\n`);
    process.exit(1);
  }
}
let status = null;
try {
  status = readJsonIfExists(path.join(data, 'status.json'));
} catch {
  status = null;
}
process.stdout.write(`${commitSubject(status, { since })}\n`);

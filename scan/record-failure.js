#!/usr/bin/env node
// Records a failed attempt in data/status.json, so the front page shows it.
// The daily workflow runs it when the tests fail, or when the site cannot be
// built from the data a scan wrote; data/latest.json is not changed.
//
//   node scan/record-failure.js --phase <tests|build> --reason <text> [--kind <error|rejected>] [--data <dir>]

import path from 'node:path';
import { SITE_ROOT } from '../lib/checker.js';
import { recordFailure } from './core.js';

const USAGE = 'node scan/record-failure.js --phase <tests|build> --reason <text> [--kind <error|rejected>] [--data <dir>]\n';
const argv = process.argv.slice(2);
const o = { data: path.join(SITE_ROOT, 'data'), phase: null, reason: null, kind: 'error' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--data') o.data = path.resolve(argv[++i] ?? '');
  else if (a === '--phase') o.phase = argv[++i] ?? '';
  else if (a === '--reason') o.reason = argv[++i] ?? '';
  else if (a === '--kind') o.kind = argv[++i] ?? '';
  else {
    process.stderr.write(`unknown argument ${a}\n${USAGE}`);
    process.exit(1);
  }
}
if (!['tests', 'build'].includes(o.phase) || !o.reason || !['error', 'rejected'].includes(o.kind)) {
  process.stderr.write(USAGE);
  process.exit(1);
}
recordFailure(o.data, { reason: o.reason, phase: o.phase, kind: o.kind });
process.stdout.write(`recorded in ${path.join(path.basename(o.data), 'status.json')}: ${o.reason}\n`);

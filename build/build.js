#!/usr/bin/env node
// node build/build.js [--data <dir>] [--out <dir>]
// Turns data/ into dist/. Exit code 0 on success, 2 when the data cannot be
// built (dist/ is then left as it was).

import path from 'node:path';
import { SITE_ROOT } from '../lib/checker.js';
import { buildSite } from './core.js';

const argv = process.argv.slice(2);
let data = path.join(SITE_ROOT, 'data');
let out = path.join(SITE_ROOT, 'dist');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--data') data = path.resolve(argv[++i] ?? '');
  else if (argv[i] === '--out') out = path.resolve(argv[++i] ?? '');
  else {
    process.stderr.write(`unknown argument ${argv[i]}\n`);
    process.exit(1);
  }
}
try {
  const r = buildSite({ dataDir: data, outDir: out });
  process.stdout.write(`built ${r.pages} pages into ${path.relative(SITE_ROOT, out) || out}\n`);
} catch (e) {
  process.stderr.write(`build failed: ${e && e.message ? e.message : e}\n`);
  process.exitCode = 2;
}

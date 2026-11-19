#!/usr/bin/env node
// Prints the kind of pass a scheduled run should make: "full" or "since".
//
//   node scan/next-pass.js [--data <dir>]
//
// "full" means: node scan/scan.js (a full pass, or the continuation of a full
// pass that stopped). "since" means: node scan/scan.js --since auto. The reason
// goes to stderr. The rules are in choosePass (scan/core.js): a full pass
// whose saved progress can still be continued first, then a full pass when no
// published scan rests on one or on Sundays (UTC), otherwise "since".

import path from 'node:path';
import { SITE_ROOT } from '../lib/checker.js';
import { choosePass } from './core.js';

const argv = process.argv.slice(2);
let data = path.join(SITE_ROOT, 'data');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--data') data = path.resolve(argv[++i] ?? '');
  else {
    process.stderr.write(`unknown argument ${argv[i]}\nnode scan/next-pass.js [--data <dir>]\n`);
    process.exit(1);
  }
}
const r = choosePass({ dataDir: data });
process.stderr.write(`${r.reason}\n`);
process.stdout.write(`${r.pass}\n`);

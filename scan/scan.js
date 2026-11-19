#!/usr/bin/env node
// Daily scan for declaredlist.com.
//
//   node scan/scan.js [--since auto|<ISO time>] [--fresh] [--data <dir>] [--max-minutes <n>]
//
// Without --since: a full pass over the registry list. With --since: a pass
// over the listings published or changed since that time (updated_since), on
// top of the last published scan; "auto" takes the start of that scan less two
// hours.
//
// Environment:
//   DECLARED_CHECKER_DIR  the public checker (default ../public-repo/addon-declaration)
//   DECLARED_REGISTRY     registry base URL (default https://registry.modelcontextprotocol.io)
//
// Exit code 0 when a new data/latest.json was written, 2 when the scan failed
// or stopped (data/latest.json is then unchanged), 1 for usage errors.

import path from 'node:path';
import { loadChecker, SITE_ROOT } from '../lib/checker.js';
import { readJsonIfExists } from '../lib/fsutil.js';
import { makeRegistryClient } from './registry.js';
import { makeListingChecker } from './check.js';
import { runScan, autoSince, recordFailure, LOCK_STALE_MS } from './core.js';

const USAGE = 'node scan/scan.js [--since auto|<ISO time>] [--fresh] [--data <dir>] [--max-minutes <n>]\n';

function parse(argv) {
  const o = { since: null, fresh: false, data: path.join(SITE_ROOT, 'data'), maxMinutes: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fresh') o.fresh = true;
    else if (a === '--since') o.since = argv[++i] ?? '';
    else if (a === '--data') o.data = path.resolve(argv[++i] ?? '');
    else if (a === '--max-minutes') o.maxMinutes = Number(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  // The time budget stays well below the age at which a lock is taken over.
  const maxAllowed = Math.floor((LOCK_STALE_MS * 5) / 6 / 60000);
  if (!Number.isFinite(o.maxMinutes) || o.maxMinutes <= 0 || o.maxMinutes > maxAllowed) throw new Error(`--max-minutes must be a number above 0 and at most ${maxAllowed}`);
  if (o.since !== null && o.since !== 'auto' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(o.since)) throw new Error('--since must be auto or a UTC time such as 2026-11-19T00:00:00Z');
  return o;
}

async function main() {
  let o;
  try {
    o = parse(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n${USAGE}`);
    return 1;
  }
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const log = (m) => process.stdout.write(`[${new Date().toISOString()}] ${m}\n`);
  // A failure before the scan starts is recorded in data/status.json too, so
  // the front page shows it.
  const failBeforeStart = (reason) => {
    process.stderr.write(`${reason}\n`);
    try {
      recordFailure(o.data, { reason, phase: 'start', kind: 'error' });
    } catch (e) {
      process.stderr.write(`the failure could not be recorded in data/status.json: ${e && e.message ? e.message : e}\n`);
    }
    return 2;
  };
  let since = o.since;
  if (since === 'auto') {
    let latest = null;
    try {
      latest = readJsonIfExists(path.join(o.data, 'latest.json'));
    } catch {
      return failBeforeStart('--since auto could not read data/latest.json; nothing was done');
    }
    since = autoSince(latest);
    if (!since) return failBeforeStart('--since auto needs a published scan in the data folder; run a full pass first; nothing was done');
  }
  if (since !== null) since = new Date(Date.parse(since)).toISOString();
  log(since === null ? 'full pass over the registry list' : `pass over the listings published or changed since ${since}`);
  let checker;
  let registry;
  try {
    checker = await loadChecker();
    registry = checker.listing.registryBase(process.env.DECLARED_REGISTRY || checker.listing.DEFAULT_REGISTRY);
  } catch (e) {
    return failBeforeStart(`the scan could not start: ${e && e.message ? e.message : 'unknown error'}; nothing was done`);
  }
  const client = makeRegistryClient({ registry, log });
  const checkOne = makeListingChecker({ checker, registryClient: client, registry, log });
  const r = await runScan({
    dataDir: o.data,
    registryBase: registry.base,
    checkerVersion: checker.version,
    since,
    fresh: o.fresh,
    maxRunMs: o.maxMinutes * 60000,
    deps: { listPage: client.listPage, checkOne, stoppedReason: client.stoppedReason, log },
  });
  log(`registry requests in this run: ${client.requestCount()}`);
  return r.ok ? 0 : 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`scan error: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 2;
  },
);

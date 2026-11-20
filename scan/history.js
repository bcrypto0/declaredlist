// Keeps data/history/ bounded.
//
// Every published scan writes one full snapshot, data/history/<date>.json.
// Snapshots older than HISTORY_KEEP_DAYS are folded into one digest per
// calendar month, data/history/<YYYY-MM>.json, and then removed from the
// folder. A digest keeps one short row per scan and, for every listing, one
// row per run: scans of that month that follow one another, each of which
// showed the listing with the same version, state and declaration (first
// check, last check, number of checks). A scan that did not show the listing
// ends its run, and so does the end of the month. So the folder holds about
// HISTORY_KEEP_DAYS days of snapshots, and grows by one small file per month.
//
// The full snapshots stay in the git history of the repository: a digest row
// names the snapshot files it was made from.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../lib/fsutil.js';

export const MONTH_SCHEMA = 'declaredlist/history-month-1';
export const HISTORY_KEEP_DAYS = 45;
export const SNAPSHOT_NAME = /^(\d{4}-\d{2})-(\d{2})(T\d{6}Z(-\d{1,3})?)?\.json$/;
export const MONTH_NAME = /^\d{4}-\d{2}\.json$/;
const MAX_WITHDRAWN_PER_MONTH = 500;
const DAY = 24 * 3600 * 1000;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const isTime = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

function emptyMonth(month) {
  return {
    schema: MONTH_SCHEMA,
    month,
    note: 'Digest of the scan snapshots of this month. One row per scan, and for each listing one row per run: scans that follow one another in this month, each of which showed the listing with the same version, state and declaration. The full snapshots named in scans[].file are in the git history of this repository.',
    scans: [],
    listings: [],
    withdrawn: [],
  };
}

function readMonth(file, month) {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return emptyMonth(month);
    throw new Error(`the digest ${path.basename(file)} cannot be read`);
  }
  if (!m || typeof m !== 'object' || m.schema !== MONTH_SCHEMA || m.month !== month || !Array.isArray(m.scans) || !Array.isArray(m.listings)) {
    throw new Error(`the digest ${path.basename(file)} is not a month digest`);
  }
  if (!Array.isArray(m.withdrawn)) m.withdrawn = [];
  return m;
}

// Adds one snapshot to a month digest (in place). A snapshot whose file name
// the digest already holds is not added twice. Snapshots are added in the
// order of their scans; a run goes on only when the scan added just before
// this one showed the listing too.
export function foldSnapshot(month, fileName, snap) {
  if (month.scans.some((s) => s && s.file === fileName)) return false;
  const previous = month.scans.length ? month.scans[month.scans.length - 1].file : null;
  const counts = snap.counts && typeof snap.counts === 'object' ? snap.counts : {};
  const int = (v) => (Number.isInteger(v) ? v : null);
  month.scans.push({
    file: fileName,
    scanStartedAt: str(snap.scanStartedAt, 40),
    scanFinishedAt: str(snap.scanFinishedAt, 40),
    mode: snap.coverage && typeof snap.coverage === 'object' ? str(snap.coverage.mode, 40) : null,
    listingsScanned: int(counts.listingsScanned),
    listed: Array.isArray(snap.listings) ? snap.listings.length : null,
    withdrawn: Array.isArray(snap.withdrawn) ? snap.withdrawn.length : null,
  });
  const byName = new Map(month.listings.filter((l) => l && typeof l.name === 'string' && Array.isArray(l.runs)).map((l) => [l.name, l]));
  for (const r of Array.isArray(snap.listings) ? snap.listings : []) {
    if (!r || typeof r.name !== 'string' || !isTime(r.checkedAt)) continue;
    const row = {
      version: str(r.version, 200),
      state: str(r.state, 80),
      declaration: r.inForce && typeof r.inForce === 'object' ? str(r.inForce.hash, 80) : null,
    };
    let entry = byName.get(r.name);
    if (!entry) {
      entry = { name: r.name, runs: [] };
      byName.set(r.name, entry);
      month.listings.push(entry);
    }
    const last = entry.runs[entry.runs.length - 1];
    if (last && last.lastFile === previous && last.version === row.version && last.state === row.state && last.declaration === row.declaration && Date.parse(r.checkedAt) >= Date.parse(last.lastCheckedAt)) {
      // The same check carried by two snapshots is counted once.
      if (r.checkedAt !== last.lastCheckedAt) {
        last.lastCheckedAt = r.checkedAt;
        last.checks += 1;
      }
      last.lastFile = fileName;
    } else {
      entry.runs.push({ ...row, firstCheckedAt: r.checkedAt, lastCheckedAt: r.checkedAt, checks: 1, lastFile: fileName });
    }
  }
  for (const w of Array.isArray(snap.withdrawn) ? snap.withdrawn : []) {
    if (!w || typeof w.name !== 'string' || month.withdrawn.length >= MAX_WITHDRAWN_PER_MONTH) continue;
    const row = { name: w.name, version: str(w.version, 200), checkedAt: str(w.checkedAt, 40), state: str(w.state, 80), reason: str(w.reason, 300) };
    if (!month.withdrawn.some((x) => x.name === row.name && x.checkedAt === row.checkedAt)) month.withdrawn.push(row);
  }
  month.listings.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return true;
}

// Folds every snapshot older than keepDays into its month digest, then removes
// it. The digest is written in full before a snapshot it holds is removed, so
// a run that stops in between loses nothing and the next run finishes the
// job. A snapshot that cannot be read as a scan is left where it is.
// Returns { folded: [file names], kept: number, skipped: [file names] }.
export function compactHistory(historyDir, { now = new Date(), keepDays = HISTORY_KEEP_DAYS, log = () => {} } = {}) {
  let names;
  try {
    names = fs.readdirSync(historyDir);
  } catch (e) {
    if (e.code === 'ENOENT') return { folded: [], kept: 0, skipped: [] };
    throw e;
  }
  const cutoff = new Date(now.getTime() - keepDays * DAY).toISOString().slice(0, 10);
  const snapshots = names.filter((n) => SNAPSHOT_NAME.test(n)).sort();
  const old = snapshots.filter((n) => n.slice(0, 10) < cutoff);
  const byMonth = new Map();
  for (const n of old) {
    const month = n.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(n);
  }
  const folded = [];
  const skipped = [];
  for (const [month, files] of byMonth) {
    const monthFile = path.join(historyDir, `${month}.json`);
    let digest;
    try {
      digest = readMonth(monthFile, month);
    } catch (e) {
      log(`${e.message}; the snapshots of ${month} are left as they are`);
      skipped.push(...files);
      continue;
    }
    const done = [];
    const readable = [];
    for (const n of files) {
      let snap;
      try {
        snap = JSON.parse(fs.readFileSync(path.join(historyDir, n), 'utf8'));
      } catch {
        snap = null;
      }
      if (!snap || typeof snap !== 'object' || !Array.isArray(snap.listings) || !isTime(snap.scanFinishedAt)) {
        log(`the history file ${n} cannot be read as a scan; it is left as it is`);
        skipped.push(n);
        continue;
      }
      readable.push({ n, snap });
    }
    // In the order of the scans, which is not always the order of the file
    // names (a second scan of a day can sort before the first).
    readable.sort((a, b) => Date.parse(a.snap.scanFinishedAt) - Date.parse(b.snap.scanFinishedAt) || (a.n < b.n ? -1 : 1));
    for (const { n, snap } of readable) {
      foldSnapshot(digest, n, snap);
      done.push(n);
    }
    if (!done.length) continue;
    writeJsonAtomic(monthFile, digest);
    for (const n of done) fs.rmSync(path.join(historyDir, n), { force: true });
    folded.push(...done);
  }
  if (folded.length) log(`history: ${folded.length} snapshot${folded.length === 1 ? '' : 's'} older than ${keepDays} days folded into the month digest${byMonth.size === 1 ? '' : 's'}`);
  return { folded, kept: snapshots.length - folded.length, skipped };
}

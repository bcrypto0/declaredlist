// The scan: one pass over the registry list, then one check per listing that
// carries a declaration pointer. Resumable and fail closed:
//
// * Progress (list cursor, listings found, checks done) is saved after every
//   page and every check in data/.scan/state.json. A run that stops is
//   continued by a later run of the same kind, while the progress was saved
//   less than RESUME_WINDOW_MS ago (longer than the daily run interval) and
//   the scan started less than MAX_PASS_AGE_MS ago.
// * data/latest.json is replaced only by a scan that finished and passed its
//   sanity checks. A failed scan leaves it as it was and records the failure in
//   data/status.json. An empty list is not published in place of a full one.
// * data/history/<date>.json files are created once and not changed. After a
//   scan is published, those older than HISTORY_KEEP_DAYS are folded into one
//   digest per month and removed from the folder (scan/history.js).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonIfExists, writeJsonAtomic, writeJsonExclusive } from '../lib/fsutil.js';
import { isoDay, scrubPaths, clip } from '../lib/text.js';
import { rowFacts } from './check.js';
import { ScanStop } from './registry.js';
import { latestProblem } from '../lib/validate.js';
import { compactHistory, HISTORY_KEEP_DAYS } from './history.js';

export const SCHEMA = 'declaredlist/scan-1';
const HOUR = 3600 * 1000;
// A lock not refreshed for this long is left from a run that ended without
// cleaning up, and may be taken over. A running scan refreshes its lock at
// least every LOCK_REFRESH_MS while it saves progress, and one run may not be
// given a time budget as long as this (scan.js caps --max-minutes at 300).
export const LOCK_STALE_MS = 6 * HOUR;
export const LOCK_REFRESH_MS = 60 * 1000;
// Saved progress is continued while its last save is less than this old. Runs
// are scheduled 24 hours apart and may start late, so the window is well above
// that: a stopped pass is continued by the next run instead of started over.
export const RESUME_WINDOW_MS = 48 * HOUR;
// A pass that keeps stopping is not continued for ever: one that started more
// than a week ago is dropped and a new one starts.
export const MAX_PASS_AGE_MS = 7 * 24 * HOUR;

export class ScanRejected extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScanRejected';
  }
}

export function paths(dataDir) {
  return {
    latest: path.join(dataDir, 'latest.json'),
    status: path.join(dataDir, 'status.json'),
    history: path.join(dataDir, 'history'),
    work: path.join(dataDir, '.scan'),
    state: path.join(dataDir, '.scan', 'state.json'),
    lock: path.join(dataDir, '.scan', 'lock.json'),
  };
}

// The last full pass a published scan rests on. A scan file written before the
// coverage member existed came from a full pass (the only kind there was).
export function lastFullPassOf(latest) {
  if (!latest || typeof latest !== 'object') return null;
  if (latest.coverage && typeof latest.coverage === 'object') return latest.coverage.lastFullPass || null;
  if (latest.counts && Number.isInteger(latest.counts.listingsScanned)) {
    return { startedAt: latest.scanStartedAt, finishedAt: latest.scanFinishedAt, listingsScanned: latest.counts.listingsScanned, withPublisherMetadata: latest.counts.withPublisherMetadata };
  }
  return null;
}

// The updated_since time for a pass that follows the published scan: its
// start, less a margin for clock differences and listings in flight.
export function autoSince(latest, marginMs = 2 * HOUR) {
  const t = latest ? Date.parse(latest.scanStartedAt) : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t - marginMs).toISOString();
}

function freshState(startedAt, since) {
  return { schema: SCHEMA, startedAt, savedAt: startedAt, since, phase: 'list', cursor: null, pages: 0, scanned: 0, withPublisherMeta: 0, rowsWithoutName: 0, pointers: {}, seenPrevious: {}, pending: null, results: {}, resumed: 0 };
}

// Why saved progress cannot be continued at time now, or null when it can.
// Progress written before savedAt existed is aged from its start.
export function resumeRefusal(state, now, { maxResumeAgeMs = RESUME_WINDOW_MS, maxPassAgeMs = MAX_PASS_AGE_MS } = {}) {
  if (!state || typeof state !== 'object' || state.schema !== SCHEMA) return 'saved progress is of another format';
  const started = Date.parse(state.startedAt);
  const saved = Number.isFinite(Date.parse(state.savedAt)) ? Date.parse(state.savedAt) : started;
  if (!Number.isFinite(started)) return 'saved progress has no start time';
  const t = now.getTime();
  if (t - saved > maxResumeAgeMs) return `saved progress was last saved more than ${Math.round(maxResumeAgeMs / HOUR)} hours ago`;
  if (t - started > maxPassAgeMs) return `saved progress belongs to a scan started more than ${Math.round(maxPassAgeMs / (24 * HOUR))} days ago`;
  return null;
}

// Which kind of pass a scheduled run should make: 'full' or 'since' (the
// scan.js option --since auto), with the reason. A full pass whose saved
// progress can still be continued comes first, so it is finished before any
// other pass; saved progress that can no longer be continued does not start a
// new full pass on a day without one. A full pass also runs when no published
// scan rests on one, and on the day given by fullPassDay (0 is Sunday, UTC).
export function choosePass({ dataDir, now = new Date(), fullPassDay = 0 }) {
  const p = paths(dataDir);
  let state = null;
  try {
    state = readJsonIfExists(p.state);
  } catch {
    state = null;
  }
  if (state && typeof state === 'object' && (state.since ?? null) === null) {
    const refusal = resumeRefusal(state, now);
    if (!refusal) return { pass: 'full', reason: 'a full pass that stopped is continued' };
  }
  let latest = null;
  try {
    latest = readJsonIfExists(p.latest);
  } catch {
    return { pass: 'full', reason: 'data/latest.json cannot be read; the scan reports it' };
  }
  if (!latest || !lastFullPassOf(latest)) return { pass: 'full', reason: 'no published scan rests on a full pass' };
  if (now.getUTCDay() === fullPassDay) return { pass: 'full', reason: 'the weekly full pass' };
  return { pass: 'since', reason: 'a pass over listings published or changed since the last scan' };
}

const BUSY = 'another scan holds the lock (data/.scan/lock.json, refreshed less than six hours ago); nothing was done';

// The lock file's text, undefined when there is none.
function readLockText(p) {
  try {
    return fs.readFileSync(p.lock, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
}

function parseLock(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && Number.isFinite(Date.parse(v.at)) ? v : null;
  } catch {
    return null;
  }
}

// Takes the lock: { ok: true, lock } or { ok: false, why }. The lock holds a
// random id, so a run only refreshes and removes a lock it owns.
function takeLock(p, now) {
  fs.mkdirSync(p.work, { recursive: true });
  const mine = { id: randomUUID(), pid: process.pid, startedAt: now.toISOString(), at: now.toISOString() };
  const create = () => {
    try {
      fs.writeFileSync(p.lock, JSON.stringify(mine), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
  };
  if (create()) return { ok: true, lock: mine };
  const text = readLockText(p);
  if (text === undefined) return create() ? { ok: true, lock: mine } : { ok: false, why: BUSY };
  const held = parseLock(text);
  // A lock that cannot be read may be one another run is writing this moment;
  // it is not taken over.
  if (!held) return { ok: false, why: 'the lock file data/.scan/lock.json cannot be read; if no scan is running, delete it by hand; nothing was done' };
  if (now.getTime() - Date.parse(held.at) < LOCK_STALE_MS) return { ok: false, why: BUSY };
  // A stale lock is moved aside (only one run can move a given file). If the
  // file moved is not the stale lock read above, another run took the lock
  // over in between, and this run gives way.
  const aside = `${p.lock}.stale-${mine.id}`;
  try {
    fs.renameSync(p.lock, aside);
  } catch {
    return { ok: false, why: BUSY };
  }
  let movedText = null;
  try {
    movedText = fs.readFileSync(aside, 'utf8');
  } catch {
    movedText = null;
  }
  if (movedText !== text) {
    try {
      if (!fs.existsSync(p.lock)) fs.renameSync(aside, p.lock);
    } catch {
      // the other run notices at its next refresh and stops
    }
    return { ok: false, why: BUSY };
  }
  fs.rmSync(aside, { force: true });
  return create() ? { ok: true, lock: mine } : { ok: false, why: BUSY };
}

// Refreshes the lock; a run whose lock was taken over stops.
function refreshLock(p, mine, now) {
  let text;
  try {
    text = readLockText(p);
  } catch {
    text = undefined;
  }
  const held = text === undefined ? null : parseLock(text);
  if (!held || held.id !== mine.id) throw new ScanStop('this run no longer holds the scan lock (data/.scan/lock.json); the scan stopped');
  mine.at = now.toISOString();
  writeJsonAtomic(p.lock, mine);
}

// Removes the lock only when this run owns it.
function releaseLock(p, mine) {
  try {
    const text = readLockText(p);
    const held = text === undefined ? null : parseLock(text);
    if (held && held.id === mine.id) fs.unlinkSync(p.lock);
  } catch {
    // already gone, or not ours
  }
}

function updateStatus(p, change) {
  let status = null;
  try {
    status = readJsonIfExists(p.status);
  } catch {
    status = null;
  }
  status = status && typeof status === 'object' ? status : { lastSuccess: null, lastFailure: null, lastAttempt: null, failures: [] };
  Object.assign(status, change);
  if (change.lastFailure) status.failures = [change.lastFailure, ...(Array.isArray(status.failures) ? status.failures : [])].slice(0, 30);
  writeJsonAtomic(p.status, status);
  return status;
}

// Records a failure that happened before a scan could start (for example the
// checker was not found), so the front page shows it.
export function recordFailure(dataDir, { reason, phase = 'start', kind = 'error', at = new Date() }) {
  const p = paths(dataDir);
  const when = at.toISOString();
  return updateStatus(p, { lastAttempt: { at: when, ok: false }, lastFailure: { at: when, phase, reason: clip(scrubPaths(reason), 400), kind } });
}

// The subject line of the daily data commit, from what the run recorded in
// data/status.json. It says "success" only for a published scan. A status
// whose last attempt is older than maxAgeMs, or older than the start of the
// run when that is given (since), was not written by this run.
export function commitSubject(status, { now = new Date(), maxAgeMs = 6 * HOUR, since = null } = {}) {
  const stamp = `${now.toISOString().slice(0, 16)}Z`;
  const a = status && typeof status === 'object' && status.lastAttempt && typeof status.lastAttempt === 'object' ? status.lastAttempt : null;
  const at = a ? Date.parse(a.at) : NaN;
  const from = since === null ? NaN : Date.parse(since);
  if (!a || !Number.isFinite(at) || now.getTime() - at > maxAgeMs || at - now.getTime() > HOUR || (Number.isFinite(from) && at < from)) return `Scan ${stamp}: outcome not recorded`;
  if (a.ok === true) return `Scan ${stamp}: success`;
  const f = status.lastFailure && typeof status.lastFailure === 'object' && status.lastFailure.at === a.at ? status.lastFailure : {};
  if (f.phase === 'setup') return `Scan ${stamp}: no scan, a setup step failed`;
  if (f.phase === 'tests') return `Scan ${stamp}: no scan, the tests failed`;
  if (f.phase === 'build') return `Scan ${stamp}: not published, the site build refused the data`;
  if (f.kind === 'rejected') return `Scan ${stamp}: not published, the result was rejected`;
  if (f.kind === 'stopped') return `Scan ${stamp}: stopped`;
  if (f.kind === 'busy') return `Scan ${stamp}: no scan, the scan lock was held or could not be read`;
  return `Scan ${stamp}: failed`;
}

// options:
//   dataDir
//   deps: { listPage(cursor) -> { servers, nextCursor }, checkOne(entry) -> record,
//           stoppedReason() -> string|null, now() -> Date, log(msg) }
//   registryBase, checkerVersion
//   since: null for a full pass over the list; an ISO time for a pass over
//   the listings published or changed since then (updated_since), which needs
//   a previous complete scan and keeps every listing it found
//   fresh: ignore saved progress; maxResumeAgeMs (since the last save) and
//   maxPassAgeMs (since the start of the saved scan); minFraction (of the last
//   full pass a new full pass must reach); maxPages; maxRunMs (time budget of this run);
//   lockRefreshMs (how often the lock is refreshed while progress is saved)
//   historyKeepDays (snapshots in data/history older than this are folded
//   into month digests after a scan is published)
// Returns { ok, latest?, reason?, resumable? }.
export async function runScan({ dataDir, deps, registryBase, checkerVersion = null, since = null, fresh = false, maxResumeAgeMs = RESUME_WINDOW_MS, maxPassAgeMs = MAX_PASS_AGE_MS, minFraction = 0.5, maxPages = 2000, maxRunMs = 60 * 60 * 1000, lockRefreshMs = LOCK_REFRESH_MS, historyKeepDays = HISTORY_KEEP_DAYS }) {
  const p = paths(dataDir);
  const log = deps.log || (() => {});
  const now = deps.now || (() => new Date());
  const runStarted = now();
  const t0 = Date.now();
  const taken = takeLock(p, runStarted);
  if (!taken.ok) {
    // Recorded like any other failed attempt, so the front page shows that
    // this run did nothing. The run that holds the lock writes the status
    // file only when it ends.
    try {
      const at = runStarted.toISOString();
      updateStatus(p, { lastAttempt: { at, ok: false }, lastFailure: { at, phase: 'start', reason: clip(scrubPaths(taken.why), 400), kind: 'busy' } });
    } catch (e) {
      log(`the refused start could not be recorded in data/status.json: ${clip(scrubPaths(e && e.message ? e.message : 'unknown error'), 200)}`);
    }
    log(`scan not started: ${taken.why}`);
    return { ok: false, reason: taken.why, resumable: true };
  }
  const lock = taken.lock;
  let lastRefresh = -Infinity;
  let state = null;
  let published = null;
  try {
    const previous = readJsonIfExists(p.latest);
    const prevListed = previous && Array.isArray(previous.listings) ? previous.listings.map((x) => x.name).filter((n) => typeof n === 'string') : [];
    const prevSet = new Set(prevListed);
    const prevByName = new Map(previous && Array.isArray(previous.listings) ? previous.listings.filter((x) => x && typeof x.name === 'string').map((x) => [x.name, x]) : []);
    const prevFull = lastFullPassOf(previous);
    if (since !== null) {
      if (!Number.isFinite(Date.parse(since))) throw new ScanRejected('the time given for updated_since is not a time; nothing was done');
      if (!previous || !prevFull) throw new ScanRejected('a pass over updated listings needs a previous complete scan that started from a full pass; run a full pass first');
      if (Date.parse(since) > Date.parse(previous.scanStartedAt)) throw new ScanRejected('updated_since must not be later than the start of the previous complete scan, or changes in between would be missed');
    }

    state = fresh ? null : readJsonIfExists(p.state);
    const refusal = state ? resumeRefusal(state, runStarted, { maxResumeAgeMs, maxPassAgeMs }) : null;
    if (refusal) {
      log(`${refusal}; starting a new scan`);
      state = null;
    }
    if (state && (state.since ?? null) !== since) {
      log('saved progress is for another kind of pass; starting a new scan');
      state = null;
    }
    if (state) {
      state.resumed = (state.resumed || 0) + 1;
      log(`resuming the scan started ${state.startedAt} (phase ${state.phase}, ${state.pages} pages, ${Object.keys(state.results).length} checks done)`);
    } else state = freshState(runStarted.toISOString(), since);
    const save = () => {
      if (Date.now() - lastRefresh >= lockRefreshMs) {
        refreshLock(p, lock, now());
        lastRefresh = Date.now();
      }
      state.savedAt = now().toISOString();
      writeJsonAtomic(p.state, state);
    };
    const budget = () => {
      if (Date.now() - t0 > maxRunMs) throw new ScanStop(`the time budget of this run (${Math.round(maxRunMs / 60000)} minutes) ran out; the next run continues from the saved progress`);
    };
    save();

    // 1. The list, page by page.
    while (state.phase === 'list') {
      budget();
      const page = await deps.listPage(state.cursor, since);
      for (const row of page.servers) {
        const f = rowFacts(row);
        state.scanned++;
        if (f.name === null || f.version === null) {
          state.rowsWithoutName++;
          continue;
        }
        if (f.hasPublisherMeta) state.withPublisherMeta++;
        if (f.hasPointer) state.pointers[f.name] = f;
        else if (prevSet.has(f.name)) state.seenPrevious[f.name] = f;
      }
      state.pages++;
      state.cursor = page.nextCursor;
      if (!page.nextCursor) state.phase = 'check';
      else if (state.pages >= maxPages) throw new ScanStop(`the list did not end within ${maxPages} pages; the scan stopped`);
      save();
      if (state.pages % 10 === 0) log(`pages ${state.pages}, listings ${state.scanned}, with a pointer ${Object.keys(state.pointers).length}`);
    }

    // 2. One check per listing with a pointer, and per listing shown in the
    // last published scan (so a removed pointer is reported once). Whether a
    // listing still names a declaration is decided by the checker's own read
    // of it, not by the list: a check that gives no_declaration withdraws it in
    // every kind of pass.
    if (state.pending === null) {
      const entries = Object.values(state.pointers);
      for (const name of prevListed) {
        if (state.pointers[name]) continue;
        if (state.seenPrevious[name]) {
          entries.push(state.seenPrevious[name]);
          continue;
        }
        // Not in this list read. In a pass over updated listings, the listing
        // did not change since the previous scan, so its latest version is the
        // one that scan checked. In a full pass, the list did not return it
        // (removed, or skipped while the list moved): one read of the version
        // found before decides whether it is withdrawn.
        const pr = prevByName.get(name);
        entries.push({
          name,
          version: pr.version ?? null,
          title: pr.title ?? null,
          description: pr.description ?? null,
          websiteUrl: pr.websiteUrl ?? null,
          publishedAt: pr.publishedAt ?? null,
          registryStatus: pr.registryStatus ?? null,
          hasPublisherMeta: true,
          hasPointer: pr.pointerInList === true,
          ...(since === null ? { notInList: true } : {}),
        });
      }
      state.pending = entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      save();
    }
    for (const entry of state.pending) {
      if (state.results[entry.name]) continue;
      budget();
      log(`checking ${entry.name} ${entry.version}`);
      const rec = await deps.checkOne(entry);
      const stop = deps.stoppedReason ? deps.stoppedReason() : null;
      if (stop) throw new ScanStop(stop);
      state.results[entry.name] = rec;
      save();
    }

    // 3. Sanity checks before anything is published. A pass over updated
    // listings may legitimately read none; a full pass may not.
    if (since === null) {
      if (state.scanned === 0 || state.pages === 0) throw new ScanRejected('the registry list returned no listings; nothing was published');
      const prevScanned = prevFull && Number.isInteger(prevFull.listingsScanned) ? prevFull.listingsScanned : 0;
      if (prevScanned > 0 && state.scanned < prevScanned * minFraction) {
        throw new ScanRejected(`the list returned ${state.scanned} listings, less than ${Math.round(minFraction * 100)} percent of the ${prevScanned} of the last full pass; nothing was published`);
      }
      const prevMeta = prevFull && Number.isInteger(prevFull.withPublisherMetadata) ? prevFull.withPublisherMetadata : 0;
      if (prevMeta > 0 && state.withPublisherMeta === 0) {
        throw new ScanRejected(`no listing in the list carried publisher metadata, while the last full pass found ${prevMeta}; the list format may have changed, so nothing was published`);
      }
    } else if (state.pages === 0) throw new ScanRejected('the registry list was not read; nothing was published');

    const finished = now();
    const records = [];
    const listings = [];
    const withdrawn = [];
    for (const e of state.pending) {
      const r = state.results[e.name];
      if (!r) continue;
      records.push(r);
      const out = (reason) => withdrawn.push({ name: r.name, version: r.version, checkedAt: r.checkedAt, state: r.state, reason });
      if (r.state === 'no_declaration') {
        // A listing found in this list read that names nothing was not shown
        // before; it is left out, not reported as withdrawn.
        if (prevSet.has(r.name)) out(e.notInList ? 'the listing was not in the registry list of latest versions, and the version found before names no declaration' : 'the listing no longer names a declaration');
        continue;
      }
      if (e.notInList && r.state === 'registry_not_found') {
        out('the listing was not in the registry list of latest versions, and the registry had no listing for the version found before');
        continue;
      }
      listings.push(r);
    }
    const byState = {};
    for (const r of listings) byState[r.state] = (byState[r.state] || 0) + 1;
    const latest = {
      schema: SCHEMA,
      scanStartedAt: state.startedAt,
      scanFinishedAt: finished.toISOString(),
      durationSeconds: Math.round((finished.getTime() - Date.parse(state.startedAt)) / 1000),
      resumed: state.resumed,
      registry: registryBase,
      coverage: {
        mode: since === null ? 'full' : 'updated_since',
        since,
        lastFullPass:
          since === null
            ? { startedAt: state.startedAt, finishedAt: finished.toISOString(), listingsScanned: state.scanned, withPublisherMetadata: state.withPublisherMeta }
            : prevFull,
      },
      method: {
        list: `${registryBase}/v0/servers?version=latest&limit=100${since === null ? '' : '&updated_since=<time>'} (cursor paging)`,
        listing: `${registryBase}/v0.1/servers/<name>/versions/<version> (read by the checker for each listing with a pointer)`,
        maxRegistryRequestsPerSecond: 1,
        listIncludesPublisherMetadata: state.withPublisherMeta > 0,
      },
      checker: { name: 'addon-declare', version: checkerVersion, source: 'https://github.com/bcrypto0/addon-declaration', command: 'check-listing --fetch-tools' },
      counts: {
        listingsScanned: state.scanned,
        pages: state.pages,
        rowsWithoutName: state.rowsWithoutName,
        withPublisherMetadata: state.withPublisherMeta,
        // Rows of this list read whose publisher metadata holds a declaration
        // pointer (or is present but malformed). The listings shown are
        // "listed": those, plus listings shown before and checked again.
        pointersInListRead: Object.keys(state.pointers).length,
        checked: records.length,
        listed: listings.length,
        withdrawn: withdrawn.length,
        byState,
      },
      listings,
      withdrawn,
    };
    // A result the site build would refuse is not published: the build
    // applies the same rules (lib/validate.js), and a refused build would
    // leave the site on its previous deployment without a notice. A pass over
    // updated listings that read none passes only when it rests on a full pass.
    const problem = latestProblem(latest);
    if (problem) throw new ScanRejected(`the scan result ${problem}; nothing was published`);
    // The history file is written first: a scan whose history cannot be
    // written is not published in latest.json.
    const day = isoDay(latest.scanFinishedAt);
    // The first scan of a day is <date>.json; a later one the same day adds its
    // time, and a number if even that is taken. Existing files are not touched.
    const stamp = latest.scanFinishedAt.slice(11, 19).replace(/:/g, '');
    const names = [`${day}.json`, `${day}T${stamp}Z.json`, ...Array.from({ length: 50 }, (_, i) => `${day}T${stamp}Z-${i + 2}.json`)];
    let histFile = null;
    for (const n of names) {
      try {
        writeJsonExclusive(path.join(p.history, n), latest);
        histFile = path.join(p.history, n);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    if (!histFile) throw new Error('no free history file name for this scan');
    writeJsonAtomic(p.latest, latest);
    published = latest;
    // Published: the saved progress is not used again.
    fs.rmSync(p.state, { force: true });
    updateStatus(p, { lastAttempt: { at: latest.scanFinishedAt, ok: true }, lastSuccess: { at: latest.scanFinishedAt, history: path.basename(histFile) } });
    // Old snapshots are folded into month digests. A failure here changes
    // nothing that was published and is only logged.
    try {
      compactHistory(p.history, { now: finished, keepDays: historyKeepDays, log });
    } catch (e) {
      log(`history: old snapshots were not folded (${clip(scrubPaths(e && e.message ? e.message : 'unknown error'), 200)})`);
    }
    log(`done: ${latest.counts.listingsScanned} listings scanned, ${latest.counts.pointersInListRead} with a pointer in the list, ${records.length} checked, ${listings.length} listed`);
    return { ok: true, latest };
  } catch (e) {
    if (published) {
      // The scan was published; only the bookkeeping after it failed. No
      // failure dated after the new latest.json is recorded over it.
      const reason = clip(scrubPaths(e && e.message ? e.message : 'unknown error'), 400);
      log(`the scan was published, but a step after it failed: ${reason}`);
      try {
        fs.rmSync(p.state, { force: true });
      } catch {
        // ignored
      }
      return { ok: true, latest: published, warning: reason };
    }
    const rejected = e instanceof ScanRejected;
    const stop = e instanceof ScanStop;
    const reason = clip(scrubPaths(e && e.message ? e.message : 'unknown error'), 400);
    const at = now().toISOString();
    updateStatus(p, { lastAttempt: { at, ok: false }, lastFailure: { at, phase: state ? state.phase : 'start', reason, kind: rejected ? 'rejected' : stop ? 'stopped' : 'error' } });
    // A rejected result is not resumed (it would be rejected again); a stopped
    // or failed run keeps its progress for the next run.
    if (rejected) fs.rmSync(p.state, { force: true });
    log(`scan failed: ${reason}`);
    return { ok: false, reason, resumable: !rejected };
  } finally {
    releaseLock(p, lock);
  }
}

// The daily job: what it records when a step fails, what the commit subject
// says, the runtime of the pinned actions, and the bound on data/history.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScan, recordFailure, commitSubject } from '../scan/core.js';
import { compactHistory, foldSnapshot, HISTORY_KEEP_DAYS, MONTH_SCHEMA } from '../scan/history.js';
import { buildSite } from '../build/core.js';
import { tempDir, removeTempDirs } from '../testlib/fixture.js';

after(removeTempDirs);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const node = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
const NOW = new Date('2026-11-20T06:30:00Z');

// ---- a failed setup step is recorded -------------------------------------

test('record-failure.js records a failed setup step in status.json', () => {
  const dir = tempDir();
  const r = node(['scan/record-failure.js', '--data', dir, '--phase', 'setup', '--reason', 'the Node setup failed before the tests; no scan was run']);
  assert.equal(r.status, 0, r.stderr);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.lastAttempt.ok, false);
  assert.equal(status.lastFailure.phase, 'setup');
  assert.match(status.lastFailure.reason, /the Node setup failed before the tests/);
  assert.equal(status.failures.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'latest.json')));
  // An unknown phase is refused and writes nothing.
  const dir2 = tempDir();
  assert.equal(node(['scan/record-failure.js', '--data', dir2, '--phase', 'other', '--reason', 'x']).status, 1);
  assert.ok(!fs.existsSync(path.join(dir2, 'status.json')));
});

test('the daily workflow records a failed setup step and commits it', () => {
  const y = read('.github/workflows/daily-scan.yml');
  // The setup steps have ids, and the recording step comes after the test step
  // (its condition reads the outcome of that step).
  for (const id of ['site', 'checker', 'node', 'restore', 'test', 'setup']) assert.match(y, new RegExp(`^        id: ${id}$`, 'm'), id);
  const at = (s) => {
    const i = y.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  };
  assert.ok(at('id: restore') < at('id: test'));
  assert.ok(at('id: test') < at('- name: Record a failed setup step'));
  assert.ok(at('- name: Record a failed setup step') < at('- name: Scan'));
  assert.match(y, /if: failure\(\) && steps\.site\.outcome == 'success' && steps\.test\.outcome == 'skipped'\n/);
  assert.match(y, /node scan\/record-failure\.js --phase setup --reason "\$what failed before the tests; no scan was run"/);
  // The commit step also runs after a recorded setup failure.
  assert.match(y, /- name: Commit data\n        if: always\(\) && \(steps\.test\.outcome == 'success' \|\| steps\.test\.outcome == 'failure' \|\| steps\.setup\.outcome == 'success'\)\n/);
});

// ---- the commit subject says what happened --------------------------------

test('the commit subject says success only for a published scan', () => {
  const at = '2026-11-20T06:25:00.000Z';
  const fail = (f) => ({ lastAttempt: { at, ok: false }, lastFailure: { at, reason: 'r', ...f } });
  const subject = (status) => commitSubject(status, { now: NOW });
  assert.equal(subject({ lastAttempt: { at, ok: true }, lastSuccess: { at } }), 'Scan 2026-11-20T06:30Z: success');
  assert.equal(subject(fail({ phase: 'build', kind: 'rejected' })), 'Scan 2026-11-20T06:30Z: not published, the site build refused the data');
  assert.equal(subject(fail({ phase: 'tests', kind: 'error' })), 'Scan 2026-11-20T06:30Z: no scan, the tests failed');
  assert.equal(subject(fail({ phase: 'setup', kind: 'error' })), 'Scan 2026-11-20T06:30Z: no scan, a setup step failed');
  assert.equal(subject(fail({ phase: 'check', kind: 'rejected' })), 'Scan 2026-11-20T06:30Z: not published, the result was rejected');
  assert.equal(subject(fail({ phase: 'list', kind: 'stopped' })), 'Scan 2026-11-20T06:30Z: stopped');
  assert.equal(subject(fail({ phase: 'start', kind: 'busy' })), 'Scan 2026-11-20T06:30Z: no scan, the scan lock was held or could not be read');
  assert.equal(subject(fail({ phase: 'list', kind: 'error' })), 'Scan 2026-11-20T06:30Z: failed');
  // A status this run did not write (too old, in the future, absent, damaged).
  for (const s of [null, {}, 'x', { lastAttempt: { at: '2026-11-19T06:25:00Z', ok: true } }, { lastAttempt: { at: '2026-11-21T06:25:00Z', ok: true } }, { lastAttempt: { at: 'no time', ok: true } }]) {
    assert.equal(subject(s), 'Scan 2026-11-20T06:30Z: outcome not recorded');
  }
  // A failed attempt whose failure record is of another time gives no detail.
  assert.equal(subject({ lastAttempt: { at, ok: false }, lastFailure: { at: '2026-11-19T00:00:00Z', phase: 'tests' } }), 'Scan 2026-11-20T06:30Z: failed');
  // No subject holds anything but plain characters (it is passed to a shell).
  for (const f of [{ phase: 'build' }, { phase: 'tests' }, { kind: 'stopped' }, {}]) assert.match(subject(fail(f)), /^[A-Za-z0-9 :,-]+$/);
});

test('commit-message.js reads the outcome the run recorded, including a refused build', () => {
  const dir = tempDir();
  // As the workflow does after a build it refused.
  recordFailure(dir, { reason: 'the site could not be built from the data this scan wrote; the scan was not published', phase: 'build', kind: 'rejected' });
  let r = node(['scan/commit-message.js', '--data', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Scan \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z: not published, the site build refused the data\n$/);
  assert.doesNotMatch(r.stdout, /success/);
  // No status file, and a damaged one: a subject is still printed.
  const empty = tempDir();
  r = node(['scan/commit-message.js', '--data', empty]);
  assert.match(r.stdout, /: outcome not recorded\n$/);
  fs.writeFileSync(path.join(empty, 'status.json'), '{');
  r = node(['scan/commit-message.js', '--data', empty]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /: outcome not recorded\n$/);
});

test('the daily workflow takes the commit subject from the recorded outcome', () => {
  const y = read('.github/workflows/daily-scan.yml');
  assert.match(y, /subject="\$\(node scan\/commit-message\.js --since "\$RUN_START" 2>\/dev\/null\)" \|\| subject=''/);
  assert.match(y, /echo "RUN_START=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)" >> "\$GITHUB_ENV"/);
  assert.match(y, /git commit -q -m "\$subject"/);
  assert.doesNotMatch(y, /SCAN_OUTCOME/);
  assert.doesNotMatch(y, /steps\.scan\.outcome \|\|/);
});

// ---- the pinned actions ----------------------------------------------------

test('the workflows pin only the action commits listed here', () => {
  // Each action.yml at these commits declared the node24 runtime when read on
  // 20 November 2026 (a test cannot read that offline). A new pin is added
  // here only after its action.yml was read.
  const NODE24 = {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1', // v7.0.1
    'actions/setup-node': '949feb2413d6458794dcd2491c4babbbce0c15c1', // v7.1.0
    'actions/cache/restore': '55cc8345863c7cc4c66a329aec7e433d2d1c52a9', // v6.1.0
    'actions/cache/save': '55cc8345863c7cc4c66a329aec7e433d2d1c52a9', // v6.1.0
  };
  let seen = 0;
  for (const f of ['.github/workflows/daily-scan.yml', '.github/workflows/test.yml']) {
    const y = read(f);
    for (const m of y.matchAll(/uses: ([^@\s]+)@([0-9a-f]{40})/g)) {
      assert.equal(m[2], NODE24[m[1]], `${f}: ${m[1]} is pinned to a commit whose runtime was not checked`);
      seen++;
    }
    assert.equal((y.match(/uses: /g) || []).length, [...y.matchAll(/uses: ([^@\s]+)@([0-9a-f]{40})/g)].length);
    // setup-node from v5 on can cache packages by itself; this site installs none.
    assert.match(y, /uses: actions\/setup-node@[0-9a-f]{40}[^\n]*\n        with:\n          package-manager-cache: false\n/);
  }
  assert.equal(seen, 8);
});

// ---- data/history stays bounded -------------------------------------------

const rec = (name, checkedAt, extra = {}) => ({ name, version: '1.0.0', state: 'verified', checkedAt, inForce: { hash: 'sha256:aa' }, ...extra });
const snap = (day, listings, extra = {}) => ({
  schema: 'declaredlist/scan-1',
  scanStartedAt: `${day}T06:17:00.000Z`,
  scanFinishedAt: `${day}T06:18:00.000Z`,
  coverage: { mode: 'updated_since' },
  counts: { listingsScanned: 12 },
  listings,
  withdrawn: [],
  ...extra,
});
const writeSnap = (dir, name, value) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

test('snapshots older than the keep window are folded into month digests and removed', () => {
  const hist = path.join(tempDir(), 'history');
  const all = days('2026-09-25', 57); // 25 September to 20 November
  for (const d of all) {
    const version = d < '2026-10-10' ? '1.0.0' : '1.0.1';
    const state = d === '2026-10-03' ? 'tools_changed' : 'verified';
    writeSnap(hist, `${d}.json`, snap(d, [rec('com.a/x', `${d}T06:17:30.000Z`, { version, state }), rec('com.b/y', `${d}T06:17:40.000Z`)]));
  }
  // A second scan on an old day, and files that are not snapshots.
  writeSnap(hist, '2026-09-30T120000Z.json', snap('2026-09-30', [rec('com.a/x', '2026-09-30T12:00:00.000Z')], { withdrawn: [{ name: 'com.c/z', version: '1', checkedAt: '2026-09-30T12:00:01.000Z', state: 'no_declaration', reason: 'the listing no longer names a declaration' }] }));
  writeSnap(hist, 'notes.txt', 'kept');
  const logs = [];
  const r = compactHistory(hist, { now: NOW, log: (m) => logs.push(m) });
  // 45 days back from 20 November is 6 October: everything before it is folded.
  const cutoff = '2026-10-06';
  const left = fs.readdirSync(hist).sort();
  const expectDaily = all.filter((d) => d >= cutoff).map((d) => `${d}.json`);
  assert.deepEqual(left, ['2026-09.json', '2026-10.json', ...expectDaily, 'notes.txt'].sort());
  assert.equal(r.folded.length, all.filter((d) => d < cutoff).length + 1);
  assert.equal(r.kept, expectDaily.length);
  assert.equal(expectDaily.length, HISTORY_KEEP_DAYS + 1);
  assert.match(logs.join('\n'), /12 snapshots older than 45 days folded/);

  const sep = JSON.parse(fs.readFileSync(path.join(hist, '2026-09.json'), 'utf8'));
  assert.equal(sep.schema, MONTH_SCHEMA);
  assert.equal(sep.month, '2026-09');
  assert.deepEqual(sep.scans.map((s) => s.file), ['2026-09-25.json', '2026-09-26.json', '2026-09-27.json', '2026-09-28.json', '2026-09-29.json', '2026-09-30.json', '2026-09-30T120000Z.json']);
  assert.equal(sep.scans[0].mode, 'updated_since');
  assert.equal(sep.scans[0].listed, 2);
  const a = sep.listings.find((l) => l.name === 'com.a/x');
  assert.deepEqual(a.runs, [{ version: '1.0.0', state: 'verified', declaration: 'sha256:aa', firstCheckedAt: '2026-09-25T06:17:30.000Z', lastCheckedAt: '2026-09-30T12:00:00.000Z', checks: 7, lastFile: '2026-09-30T120000Z.json' }]);
  assert.equal(sep.withdrawn.length, 1);
  assert.equal(sep.withdrawn[0].name, 'com.c/z');

  // October: the day with another state breaks the run in three.
  const oct = JSON.parse(fs.readFileSync(path.join(hist, '2026-10.json'), 'utf8'));
  const runs = oct.listings.find((l) => l.name === 'com.a/x').runs;
  assert.deepEqual(runs.map((x) => [x.state, x.firstCheckedAt.slice(0, 10), x.lastCheckedAt.slice(0, 10), x.checks]), [
    ['verified', '2026-10-01', '2026-10-02', 2],
    ['tools_changed', '2026-10-03', '2026-10-03', 1],
    ['verified', '2026-10-04', '2026-10-05', 2],
  ]);
  assert.deepEqual(oct.listings.find((l) => l.name === 'com.b/y').runs.map((x) => x.checks), [5]);

  // A second run the same day changes nothing; a later day folds one more
  // snapshot into the digest that exists.
  const before = fs.readFileSync(path.join(hist, '2026-10.json'), 'utf8');
  assert.deepEqual(compactHistory(hist, { now: NOW }).folded, []);
  assert.equal(fs.readFileSync(path.join(hist, '2026-10.json'), 'utf8'), before);
  assert.deepEqual(compactHistory(hist, { now: new Date('2026-11-21T06:30:00Z') }).folded, ['2026-10-06.json']);
  const oct2 = JSON.parse(fs.readFileSync(path.join(hist, '2026-10.json'), 'utf8'));
  assert.deepEqual(oct2.listings.find((l) => l.name === 'com.a/x').runs.at(-1).checks, 3);
  assert.equal(oct2.scans.length, 6);
});

test('folding loses nothing when a run stops half way, and leaves unreadable files alone', () => {
  const hist = path.join(tempDir(), 'history');
  writeSnap(hist, '2026-08-01.json', snap('2026-08-01', [rec('com.a/x', '2026-08-01T06:17:30.000Z')]));
  writeSnap(hist, '2026-08-02.json', snap('2026-08-02', [rec('com.a/x', '2026-08-02T06:17:30.000Z')]));
  writeSnap(hist, '2026-08-03.json', '{ not json');
  writeSnap(hist, '2026-08-04.json', { listings: 'none' });
  // The digest was written, but the first snapshot was not removed yet.
  const digest = { schema: MONTH_SCHEMA, month: '2026-08', scans: [], listings: [], withdrawn: [] };
  assert.equal(foldSnapshot(digest, '2026-08-01.json', JSON.parse(fs.readFileSync(path.join(hist, '2026-08-01.json'), 'utf8'))), true);
  fs.writeFileSync(path.join(hist, '2026-08.json'), JSON.stringify(digest));
  const logs = [];
  const r = compactHistory(hist, { now: NOW, log: (m) => logs.push(m) });
  assert.deepEqual(r.folded, ['2026-08-01.json', '2026-08-02.json']);
  assert.deepEqual(r.skipped, ['2026-08-03.json', '2026-08-04.json']);
  assert.deepEqual(fs.readdirSync(hist).sort(), ['2026-08-03.json', '2026-08-04.json', '2026-08.json']);
  const m = JSON.parse(fs.readFileSync(path.join(hist, '2026-08.json'), 'utf8'));
  // The snapshot already in the digest was not counted twice.
  assert.deepEqual(m.scans.map((s) => s.file), ['2026-08-01.json', '2026-08-02.json']);
  assert.equal(m.listings[0].runs.length, 1);
  assert.equal(m.listings[0].runs[0].checks, 2);
  assert.match(logs.join('\n'), /2026-08-03\.json cannot be read as a scan/);

  // A digest that cannot be read: its snapshots stay, nothing is overwritten.
  const hist2 = path.join(tempDir(), 'history');
  writeSnap(hist2, '2026-08-01.json', snap('2026-08-01', [rec('com.a/x', '2026-08-01T06:17:30.000Z')]));
  writeSnap(hist2, '2026-08.json', 'damaged');
  const r2 = compactHistory(hist2, { now: NOW });
  assert.deepEqual(r2.folded, []);
  assert.deepEqual(r2.skipped, ['2026-08-01.json']);
  assert.equal(fs.readFileSync(path.join(hist2, '2026-08.json'), 'utf8'), 'damaged');
  // No folder at all is not an error.
  assert.deepEqual(compactHistory(path.join(hist2, 'none'), { now: NOW }).folded, []);
});

test('a published scan folds old snapshots, and a fold that fails does not undo the scan', async () => {
  const PUB = 'io.modelcontextprotocol.registry/publisher-provided';
  const row = (name, pointer) => ({
    server: { name, version: '1.0.0', description: 'd', ...(pointer ? { _meta: { [PUB]: { addonDeclaration: { url: 'https://x/', hash: 'sha256:00' } } } } : {}) },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: '2026-11-01T00:00:00Z', isLatest: true } },
  });
  const deps = () => ({
    log: () => {},
    now: () => NOW,
    async listPage() {
      return { servers: [row('com.a/x', true), row('com.b/y', false)], nextCursor: null };
    },
    async checkOne(entry) {
      return { name: entry.name, version: entry.version, pointerInList: entry.hasPointer, checkedAt: NOW.toISOString(), state: 'verified', exitCode: 0 };
    },
    stoppedReason: () => null,
  });
  const dir = tempDir();
  const hist = path.join(dir, 'history');
  writeSnap(hist, '2026-09-01.json', snap('2026-09-01', [rec('com.a/x', '2026-09-01T06:17:30.000Z')]));
  writeSnap(hist, '2026-11-19.json', snap('2026-11-19', [rec('com.a/x', '2026-11-19T06:17:30.000Z')]));
  let r = await runScan({ dataDir: dir, deps: deps(), registryBase: 'https://registry.modelcontextprotocol.io' });
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readdirSync(hist).sort(), ['2026-09.json', '2026-11-19.json', '2026-11-20.json']);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.lastSuccess.history, '2026-11-20.json');

  // The listing page shows the folded run under the daily results.
  const dist = path.join(dir, 'dist');
  buildSite({ dataDir: dir, outDir: dist });
  const page = fs.readFileSync(path.join(dist, 'listing', 'com.a__x.html'), 'utf8');
  assert.match(page, /<h2>Earlier results<\/h2>/);
  assert.match(page, /<h2>Older results, by month<\/h2>/);
  assert.match(page, /<td data-label="First check">1 September 2026<\/td><td data-label="Last check">1 September 2026<\/td><td data-label="Checks">1<\/td>/);

  // A digest that cannot be read does not fail the scan.
  const dir2 = tempDir();
  const hist2 = path.join(dir2, 'history');
  writeSnap(hist2, '2026-09-01.json', snap('2026-09-01', [rec('com.a/x', '2026-09-01T06:17:30.000Z')]));
  writeSnap(hist2, '2026-09.json', 'damaged');
  r = await runScan({ dataDir: dir2, deps: deps(), registryBase: 'https://registry.modelcontextprotocol.io' });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(dir2, 'latest.json')));
  assert.ok(fs.existsSync(path.join(hist2, '2026-09-01.json')));
});

test('month digests are cleaned like other data before they reach a page', () => {
  const dir = tempDir();
  const latest = snap('2026-11-20', [rec('com.a/x', '2026-11-20T06:17:30.000Z')], { registry: 'https://registry.modelcontextprotocol.io', coverage: { mode: 'full', since: null, lastFullPass: { startedAt: '2026-11-20T06:17:00.000Z', finishedAt: '2026-11-20T06:18:00.000Z', listingsScanned: 12, withPublisherMetadata: 1 } } });
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(latest));
  writeSnap(path.join(dir, 'history'), '2026-08.json', {
    schema: MONTH_SCHEMA,
    month: '2026-08',
    scans: [],
    listings: [
      { name: 'com.a/x', runs: [{ version: '<b>old.contact@example.org</b>', state: '<script>', firstCheckedAt: '2026-08-01T00:00:00Z', lastCheckedAt: '2026-08-09T00:00:00Z', checks: '<i>9</i>' }, { version: '1', state: 'verified', firstCheckedAt: 'not a time', lastCheckedAt: 'x', checks: 1 }, null] },
      { name: 5 },
    ],
  });
  writeSnap(path.join(dir, 'history'), '2026-07.json', '{ damaged');
  const dist = path.join(dir, 'dist');
  buildSite({ dataDir: dir, outDir: dist });
  const page = fs.readFileSync(path.join(dist, 'listing', 'com.a__x.html'), 'utf8');
  assert.match(page, /Older results, by month/);
  assert.doesNotMatch(page, /@example\.org/);
  assert.doesNotMatch(page, /<script>|<b>old|<i>9/);
  assert.match(page, /<td data-label="Checks">1<\/td>/);
  assert.equal((page.match(/data-label="First check"/g) || []).length, 1);
});

test('runs follow the order of the scans, and a scan without the listing ends a run', () => {
  const hist = path.join(tempDir(), 'history');
  // The second scan of the day sorts before the first by file name.
  writeSnap(hist, '2026-08-05.json', snap('2026-08-05', [rec('com.a/x', '2026-08-05T16:43:00.000Z')], { scanFinishedAt: '2026-08-05T16:43:10.000Z' }));
  writeSnap(hist, '2026-08-05T145711Z.json', snap('2026-08-05', [rec('com.a/x', '2026-08-05T14:57:00.000Z')], { scanFinishedAt: '2026-08-05T14:57:11.000Z' }));
  // Shown on the 6th, not on the 7th, shown again on the 8th.
  writeSnap(hist, '2026-08-06.json', snap('2026-08-06', [rec('com.a/x', '2026-08-06T06:17:30.000Z')]));
  writeSnap(hist, '2026-08-07.json', snap('2026-08-07', []));
  writeSnap(hist, '2026-08-08.json', snap('2026-08-08', [rec('com.a/x', '2026-08-08T06:17:30.000Z')]));
  compactHistory(hist, { now: NOW });
  const m = JSON.parse(fs.readFileSync(path.join(hist, '2026-08.json'), 'utf8'));
  assert.deepEqual(m.scans.map((s) => s.file), ['2026-08-05T145711Z.json', '2026-08-05.json', '2026-08-06.json', '2026-08-07.json', '2026-08-08.json']);
  assert.deepEqual(m.listings[0].runs.map((x) => [x.firstCheckedAt, x.lastCheckedAt, x.checks]), [
    ['2026-08-05T14:57:00.000Z', '2026-08-06T06:17:30.000Z', 3],
    ['2026-08-08T06:17:30.000Z', '2026-08-08T06:17:30.000Z', 1],
  ]);
});

test('an outcome recorded before the run started is not taken for this run', () => {
  const status = { lastAttempt: { at: '2026-11-20T04:00:00.000Z', ok: true } };
  assert.equal(commitSubject(status, { now: NOW }), 'Scan 2026-11-20T06:30Z: success');
  assert.equal(commitSubject(status, { now: NOW, since: '2026-11-20T06:17:00Z' }), 'Scan 2026-11-20T06:30Z: outcome not recorded');
  assert.equal(commitSubject(status, { now: NOW, since: '2026-11-20T03:00:00Z' }), 'Scan 2026-11-20T06:30Z: success');
  // An unreadable start time is ignored.
  assert.equal(commitSubject(status, { now: NOW, since: 'x' }), 'Scan 2026-11-20T06:30Z: success');
  const dir = tempDir();
  recordFailure(dir, { reason: 'r', phase: 'tests', kind: 'error', at: new Date(Date.now() - 600000) });
  assert.match(node(['scan/commit-message.js', '--data', dir, '--since', '']).stdout, /: no scan, the tests failed\n$/);
  assert.match(node(['scan/commit-message.js', '--data', dir, '--since', new Date().toISOString()]).stdout, /: outcome not recorded\n$/);
});

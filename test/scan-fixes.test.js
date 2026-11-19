// The scanner's fail closed rules, locking, pass logic and request routing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runScan, paths, recordFailure, choosePass, RESUME_WINDOW_MS, SCHEMA } from '../scan/core.js';
import { makeRegistryClient, ScanStop } from '../scan/registry.js';
import { rowFacts, makeListingChecker, RETRY_STATES } from '../scan/check.js';
import { loadChecker } from '../lib/checker.js';
import { tempDir, removeTempDirs } from '../testlib/fixture.js';

after(removeTempDirs);

const base = 'https://registry.modelcontextprotocol.io';
const PUB = 'io.modelcontextprotocol.registry/publisher-provided';
const reg = { base, loopback: false };
const off = { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: '2026-11-01T00:00:00Z', isLatest: true } };
const row = (name, version, pointer) => ({ server: { name, version, ...(pointer ? { _meta: { [PUB]: { addonDeclaration: { url: 'https://x/', hash: 'sha256:00' } } } } : {}) }, _meta: off });
const filler = (n, prefix = 'com.f') => Array.from({ length: n }, (_, i) => row(`${prefix}${i}/s`, '1.0.0', false));

// deps for runScan: pages of rows, and a check that answers from a table
// (name -> state, or a function of the entry), recording what it was asked.
function deps(pages, states = {}) {
  const asked = [];
  return {
    asked,
    deps: {
      log: () => {},
      async listPage(cursor) {
        const i = cursor === null ? 0 : Number(cursor.slice(1));
        return { servers: pages[i] || [], nextCursor: i + 1 < pages.length ? `p${i + 1}` : null };
      },
      async checkOne(e) {
        asked.push({ name: e.name, version: e.version, hasPointer: e.hasPointer, notInList: e.notInList === true });
        const st = typeof states[e.name] === 'function' ? states[e.name](e) : states[e.name] ?? (e.hasPointer ? 'verified' : 'no_declaration');
        return { name: e.name, version: e.version, pointerInList: Boolean(e.hasPointer), checkedAt: new Date().toISOString(), state: st, exitCode: 0 };
      },
      stoppedReason: () => null,
    },
  };
}

// A body stream that fails on the first read.
const brokenBody = () => new ReadableStream({ pull(c) { c.error(new Error('connection reset')); } });

test('a 429 whose body cannot be read still stops the scan at once', async () => {
  let calls = 0;
  const fetchImpl = async () => (calls++, new Response(brokenBody(), { status: 429 }));
  const c = makeRegistryClient({ registry: reg, fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
  await assert.rejects(c.listPage(null), (e) => e instanceof ScanStop && /429/.test(e.message));
  assert.equal(calls, 1, 'no retry after a 429');
  assert.match(c.stoppedReason(), /429/);
  for (let i = 0; i < 5; i++) await assert.rejects(c.get(`${base}/v0.1/servers/a%2Fb/versions/1`), ScanStop);
  assert.equal(calls, 1, 'nothing more is sent');
});

test('5xx answers and bodies that break off count as failures in a row and stop the scan', async () => {
  let calls = 0;
  const c = makeRegistryClient({ registry: reg, fetchImpl: async () => (calls++, new Response(brokenBody(), { status: 503 })), sleep: async () => {}, minIntervalMs: 0 });
  await assert.rejects(c.listPage(null), ScanStop);
  assert.equal(calls, 3);
  assert.match(c.stoppedReason(), /three registry requests in a row failed/);
  await assert.rejects(c.get(`${base}/v0.1/servers/a%2Fb/versions/1`), ScanStop);
  assert.equal(calls, 3);

  // A 200 whose body breaks off, three times: stopped as well.
  let n2 = 0;
  const c2 = makeRegistryClient({ registry: reg, fetchImpl: async () => (n2++, new Response(brokenBody(), { status: 200 })), sleep: async () => {}, minIntervalMs: 0 });
  await assert.rejects(c2.listPage(null), ScanStop);
  assert.equal(n2, 3);
  assert.ok(c2.stoppedReason());
  // Single listing reads that break off are counted too.
  let n3 = 0;
  const c3 = makeRegistryClient({ registry: reg, fetchImpl: async () => (n3++, new Response(brokenBody(), { status: 200 })), sleep: async () => {}, minIntervalMs: 0 });
  for (let i = 0; i < 3; i++) await assert.rejects(c3.get(`${base}/v0.1/servers/a%2Fb/versions/1`));
  assert.ok(c3.stoppedReason(), 'three failed single reads stop the scan');
  await assert.rejects(c3.get(`${base}/v0.1/servers/a%2Fb/versions/1`), ScanStop);
  assert.equal(n3, 3);
  // An answer over the size limit is a failure too, and says so.
  const c4 = makeRegistryClient({ registry: reg, fetchImpl: async () => new Response('x'.repeat(100), { status: 200 }), sleep: async () => {}, minIntervalMs: 0 });
  await assert.rejects(c4.get(`${base}/v0.1/servers/a%2Fb/versions/1`, { maxBytes: 10 }), (e) => e.tooLarge === true);
  // A good answer resets the count.
  const seq = [503, 503, 200, 503, 503];
  const c5 = makeRegistryClient({ registry: reg, fetchImpl: async () => new Response('{}', { status: seq.shift() ?? 200 }), sleep: async () => {}, minIntervalMs: 0 });
  for (let i = 0; i < 5; i++) await c5.get(`${base}/v0.1/servers/a%2Fb/versions/1`);
  assert.equal(c5.stoppedReason(), null);
});

test('row facts mark malformed publisher metadata for checking and keep no raw email or path', () => {
  // Present but not an object: the checker gives pointer_malformed, so the row is checked.
  assert.equal(rowFacts({ server: { name: 'com.a/b', version: '1', _meta: { [PUB]: 'addonDeclaration' } } }).hasPointer, true);
  assert.equal(rowFacts({ server: { name: 'com.a/b', version: '1', _meta: { [PUB]: [1] } } }).hasPointer, true);
  assert.equal(rowFacts({ server: { name: 'com.a/b', version: '1', _meta: 'x' } }).hasPointer, true);
  assert.equal(rowFacts({ server: { name: 'com.a/b', version: '1', _meta: [] } }).hasPointer, true);
  // Absent, or an object without the pointer member: no_declaration, not checked.
  assert.equal(rowFacts({ server: { name: 'com.a/b', version: '1' } }).hasPointer, false);
  assert.equal(rowFacts({ server: { name: 'com.a/b', version: '1', _meta: {} } }).hasPointer, false);
  assert.equal(rowFacts({ server: { name: 'com.a/b', version: '1', _meta: { [PUB]: { other: 1 } } } }).hasPointer, false);
  // A name or version holding an email address or a path is stored cleaned and marked.
  const f = rowFacts({ server: { name: 'com.a/b', version: 'contact.me@example.org', _meta: { [PUB]: { addonDeclaration: {} } } } });
  assert.equal(f.textAltered, true);
  assert.doesNotMatch(JSON.stringify(f), /@example\.org/);
  const g = rowFacts({ server: { name: 'com.a/b', version: 'C:\\Users\\someone\\leak' } });
  assert.equal(g.textAltered, true);
  assert.doesNotMatch(JSON.stringify(g), /someone/);
  assert.equal(rowFacts({ server: { name: 'com.a/b', version: '1.0.0' } }).textAltered, undefined);
});

test('a pass over updated listings withdraws a carried listing once its check finds no declaration', async () => {
  const dir = tempDir();
  // Day 0, full pass: com.a/x 1.0.0 carries a pointer.
  const full = deps([[row('com.a/x', '1.0.0', true), ...filler(20)]]);
  assert.equal((await runScan({ dataDir: dir, deps: full.deps, registryBase: base })).ok, true);
  // Day 1: 2.0.0 is published without a pointer; its check hits a registry failure.
  const d1 = deps([[row('com.a/x', '2.0.0', false)]], { 'com.a/x': 'registry_unreachable' });
  const r1 = await runScan({ dataDir: dir, deps: d1.deps, registryBase: base, since: new Date(Date.now() - 3 * 3600e3).toISOString() });
  assert.equal(r1.ok, true, r1.reason);
  assert.deepEqual(r1.latest.listings.map((x) => `${x.name} ${x.version} ${x.pointerInList} ${x.state}`), ['com.a/x 2.0.0 false registry_unreachable']);
  // Day 2: nothing new; the carried listing is checked as it was stored, not as one with a pointer.
  const d2 = deps([[]], { 'com.a/x': 'no_declaration' });
  const r2 = await runScan({ dataDir: dir, deps: d2.deps, registryBase: base, since: r1.latest.scanStartedAt });
  assert.equal(r2.ok, true, r2.reason);
  assert.deepEqual(d2.asked, [{ name: 'com.a/x', version: '2.0.0', hasPointer: false, notInList: false }]);
  assert.deepEqual(r2.latest.listings, []);
  assert.deepEqual(r2.latest.withdrawn.map((w) => `${w.name} ${w.version} ${w.reason}`), ['com.a/x 2.0.0 the listing no longer names a declaration']);
  assert.equal(r2.latest.counts.pointersInListRead, 0);
  assert.equal(r2.latest.counts.listed, 0);
});

test('a full pass checks a listing the list did not return before withdrawing it', async () => {
  const dir = tempDir();
  const first = deps([[row('com.a/x', '1.0.0', true), row('com.b/y', '1.0.0', true), row('com.c/z', '1.0.0', true), ...filler(20)]]);
  assert.equal((await runScan({ dataDir: dir, deps: first.deps, registryBase: base })).ok, true);
  // None of the three is in the next list read.
  const withMeta = { server: { name: 'com.m/s', version: '1.0.0', _meta: { [PUB]: { other: 1 } } } };
  const next = deps([[withMeta, ...filler(20)]], { 'com.a/x': 'verified', 'com.b/y': 'registry_not_found', 'com.c/z': 'no_declaration' });
  const r = await runScan({ dataDir: dir, deps: next.deps, registryBase: base });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(next.asked.map((a) => `${a.name} ${a.version} ${a.notInList}`), ['com.a/x 1.0.0 true', 'com.b/y 1.0.0 true', 'com.c/z 1.0.0 true']);
  assert.deepEqual(r.latest.listings.map((x) => `${x.name} ${x.state}`), ['com.a/x verified'], 'still there: kept');
  assert.deepEqual(r.latest.withdrawn.map((w) => w.name), ['com.b/y', 'com.c/z']);
  assert.match(r.latest.withdrawn[0].reason, /not in the registry list of latest versions, and the registry had no listing/);
  assert.equal(r.latest.withdrawn[0].state, 'registry_not_found');
  assert.equal(r.latest.counts.pointersInListRead, 0);
  assert.equal(r.latest.counts.listed, 1, 'the count of listings shown agrees with the list');
});

test('a new listing whose check finds no declaration is left out, not reported as withdrawn', async () => {
  const dir = tempDir();
  const d = deps([[row('com.a/x', '1.0.0', true), ...filler(5)]], { 'com.a/x': 'no_declaration' });
  const r = await runScan({ dataDir: dir, deps: d.deps, registryBase: base });
  assert.equal(r.ok, true);
  assert.deepEqual(r.latest.listings, []);
  assert.deepEqual(r.latest.withdrawn, []);
});

test('the history file is written before latest.json; a failed write publishes nothing', async () => {
  const dir = tempDir();
  // A file where the history folder should be: the history write fails.
  fs.writeFileSync(path.join(dir, 'history'), 'not a folder');
  const r = await runScan({ dataDir: dir, deps: deps([[row('com.a/x', '1.0.0', true)]]).deps, registryBase: base });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(dir, 'latest.json')), 'latest.json not written');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.lastAttempt.ok, false);
  assert.equal(status.lastSuccess, null);
});

test('the lock: unreadable locks are not taken over, stale ones are, and a run removes only its own', async () => {
  const dir = tempDir();
  const p = paths(dir);
  fs.mkdirSync(p.work, { recursive: true });
  // Unreadable (for example a lock another run is writing this moment).
  fs.writeFileSync(p.lock, '');
  let r = await runScan({ dataDir: dir, deps: deps([[row('com.a/x', '1.0.0', true)]]).deps, registryBase: base });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot be read/);
  assert.equal(fs.readFileSync(p.lock, 'utf8'), '', 'left as it was');
  // Fresh: refused.
  fs.writeFileSync(p.lock, JSON.stringify({ id: 'other', at: new Date().toISOString() }));
  r = await runScan({ dataDir: dir, deps: deps([[row('com.a/x', '1.0.0', true)]]).deps, registryBase: base });
  assert.equal(r.ok, false);
  assert.match(r.reason, /another scan holds the lock/);
  // Stale (not refreshed for more than six hours): taken over, and released after the run.
  fs.writeFileSync(p.lock, JSON.stringify({ id: 'other', at: new Date(Date.now() - 7 * 3600e3).toISOString() }));
  r = await runScan({ dataDir: dir, deps: deps([[row('com.a/x', '1.0.0', true)]]).deps, registryBase: base });
  assert.equal(r.ok, true, r.reason);
  assert.ok(!fs.existsSync(p.lock));
  assert.deepEqual(fs.readdirSync(p.work).filter((f) => f.startsWith('lock')), [], 'no file left aside');
});

test('a run whose lock was taken over stops and leaves the other lock in place', async () => {
  const dir = tempDir();
  const p = paths(dir);
  const d = deps([[row('com.a/x', '1.0.0', true)], [row('com.b/y', '1.0.0', true)]]);
  const inner = d.deps.listPage;
  const seen = [];
  d.deps.listPage = async (cursor) => {
    seen.push(JSON.parse(fs.readFileSync(p.lock, 'utf8')));
    // Another run takes the lock over during this run.
    if (cursor === null) fs.writeFileSync(p.lock, JSON.stringify({ id: 'intruder', at: new Date().toISOString() }));
    return inner(cursor);
  };
  const r = await runScan({ dataDir: dir, deps: d.deps, registryBase: base, lockRefreshMs: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer holds the scan lock/);
  assert.equal(typeof seen[0].id, 'string');
  assert.equal(typeof seen[0].pid, 'number');
  assert.equal(JSON.parse(fs.readFileSync(p.lock, 'utf8')).id, 'intruder', 'the other run keeps its lock');
});

test('a running scan refreshes its lock', async () => {
  const dir = tempDir();
  const p = paths(dir);
  const d = deps([[row('com.a/x', '1.0.0', true)], filler(3)]);
  const inner = d.deps.listPage;
  const ats = [];
  d.deps.listPage = async (cursor) => {
    ats.push(JSON.parse(fs.readFileSync(p.lock, 'utf8')).at);
    await new Promise((res) => setTimeout(res, 15));
    return inner(cursor);
  };
  const r = await runScan({ dataDir: dir, deps: d.deps, registryBase: base, lockRefreshMs: 0 });
  assert.equal(r.ok, true, r.reason);
  assert.ok(Date.parse(ats[1]) > Date.parse(ats[0]), `lock refreshed: ${ats.join(', ')}`);
});

test('a stopped pass is continued by runs a day apart, and dropped only when too old', async () => {
  const H = 3600e3;
  const dir = tempDir();
  const p = paths(dir);
  // Three pages; reading the third fails until the last run.
  const pagesOf = () => [[row('com.a/x', '1.0.0', true), ...filler(5)], filler(5, 'com.g'), filler(5, 'com.h')];
  const at = (ms) => () => new Date(Date.now() + ms);
  const failing = (offset) => {
    const d = deps(pagesOf());
    const inner = d.deps.listPage;
    d.deps.listPage = async (cursor) => {
      if (cursor === 'p2') throw new ScanStop('the registry answered HTTP 503 three times in a row; the scan stopped');
      return inner(cursor);
    };
    d.deps.now = at(offset);
    return d;
  };
  assert.equal((await runScan({ dataDir: dir, deps: failing(0).deps, registryBase: base })).ok, false);
  // One day later (a scheduled run may start late): continued, and stopped again.
  const second = failing(25 * H);
  const calls = [];
  const inner2 = second.deps.listPage;
  second.deps.listPage = async (c) => (calls.push(c), inner2(c));
  assert.equal((await runScan({ dataDir: dir, deps: second.deps, registryBase: base })).ok, false);
  assert.deepEqual(calls, ['p2'], 'continued from the saved cursor');
  // Two days after the start, one after the last save: continued and finished.
  const third = deps(pagesOf());
  third.deps.now = at(50 * H);
  const calls3 = [];
  const inner3 = third.deps.listPage;
  third.deps.listPage = async (c) => (calls3.push(c), inner3(c));
  const r3 = await runScan({ dataDir: dir, deps: third.deps, registryBase: base });
  assert.equal(r3.ok, true, r3.reason);
  assert.deepEqual(calls3, ['p2']);
  assert.equal(r3.latest.resumed, 2);
  assert.equal(r3.latest.counts.listingsScanned, 16);

  // Progress last saved longer ago than the window is dropped.
  const d2 = tempDir();
  assert.equal((await runScan({ dataDir: d2, deps: failing(0).deps, registryBase: base })).ok, false);
  const late = deps(pagesOf());
  late.deps.now = at(RESUME_WINDOW_MS + H);
  const callsLate = [];
  const innerLate = late.deps.listPage;
  late.deps.listPage = async (c) => (callsLate.push(c), innerLate(c));
  assert.equal((await runScan({ dataDir: d2, deps: late.deps, registryBase: base })).ok, true);
  assert.equal(callsLate[0], null, 'started over');

  // A pass started more than a week ago is dropped even when saved recently.
  const d3 = tempDir();
  assert.equal((await runScan({ dataDir: d3, deps: failing(0).deps, registryBase: base })).ok, false);
  const st = JSON.parse(fs.readFileSync(paths(d3).state, 'utf8'));
  st.startedAt = new Date(Date.now() - 8 * 24 * H).toISOString();
  fs.writeFileSync(paths(d3).state, JSON.stringify(st));
  const old = deps(pagesOf());
  const callsOld = [];
  const innerOld = old.deps.listPage;
  old.deps.listPage = async (c) => (callsOld.push(c), innerOld(c));
  assert.equal((await runScan({ dataDir: d3, deps: old.deps, registryBase: base })).ok, true);
  assert.equal(callsOld[0], null, 'started over');
  assert.ok(!fs.existsSync(p.lock));
});

test('the pass chooser continues a stopped full pass and otherwise runs the weekly full pass', async () => {
  const H = 3600e3;
  // A Wednesday and a Sunday, UTC.
  const wed = new Date('2026-11-25T06:17:00Z');
  const sun = new Date('2026-11-29T06:17:00Z');
  const dir = tempDir();
  const p = paths(dir);
  assert.equal(choosePass({ dataDir: dir, now: wed }).pass, 'full', 'nothing published yet');
  assert.equal((await runScan({ dataDir: dir, deps: deps([[row('com.a/x', '1.0.0', true), ...filler(5)]]).deps, registryBase: base })).ok, true);
  assert.equal(choosePass({ dataDir: dir, now: wed }).pass, 'since');
  assert.equal(choosePass({ dataDir: dir, now: sun }).pass, 'full');
  const save = (o) => {
    fs.mkdirSync(p.work, { recursive: true });
    fs.writeFileSync(p.state, JSON.stringify({ schema: SCHEMA, phase: 'list', ...o }));
  };
  // A full pass that stopped yesterday is continued on a weekday.
  save({ since: null, startedAt: new Date(wed - 30 * H).toISOString(), savedAt: new Date(wed - 23 * H).toISOString() });
  assert.deepEqual(choosePass({ dataDir: dir, now: wed }), { pass: 'full', reason: 'a full pass that stopped is continued' });
  // One the scanner would no longer continue does not start a new full pass on a weekday.
  save({ since: null, startedAt: new Date(wed - 60 * H).toISOString(), savedAt: new Date(wed - RESUME_WINDOW_MS - H).toISOString() });
  assert.equal(choosePass({ dataDir: dir, now: wed }).pass, 'since');
  // Saved progress of a pass over updated listings does not make a full pass.
  save({ since: '2026-11-20T00:00:00.000Z', startedAt: new Date(wed - 2 * H).toISOString(), savedAt: new Date(wed - H).toISOString() });
  assert.equal(choosePass({ dataDir: dir, now: wed }).pass, 'since');
  // Unreadable progress is ignored.
  fs.writeFileSync(p.state, '{');
  assert.equal(choosePass({ dataDir: dir, now: wed }).pass, 'since');
});

test('a failure before the scan starts is recorded for the front page', () => {
  const dir = tempDir();
  recordFailure(dir, { reason: 'the checker was not found at C:\\Users\\someone\\x; set DECLARED_CHECKER_DIR' });
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(s.lastAttempt.ok, false);
  assert.match(s.lastFailure.reason, /checker was not found/);
  assert.doesNotMatch(JSON.stringify(s), /someone/);
});

test('a check that fails on one read is run once more before it is stored', async () => {
  const real = await loadChecker();
  const states = ['registry_unreachable', 'verified'];
  let runs = 0;
  const waits = [];
  const fake = {
    ...real,
    listing: { ...real.listing, async checkListing() { runs++; const st = states.shift(); return { state: st, exitCode: 0, reasons: [], report: { listing: {}, pointer: null, declaration: null, inForce: null, tools: { check: 'not_run' }, checked: [], notChecked: [], notes: [], fetched: [], newer: [], chain: [] } }; } },
  };
  const client = { isRegistryUrl: () => false, get: async () => ({}), stoppedReason: () => null };
  const checkOne = makeListingChecker({ checker: fake, registryClient: client, registry: reg, sleep: async (ms) => waits.push(ms) });
  const rec = await checkOne({ name: 'com.a/b', version: '1.0.0', hasPointer: true });
  assert.equal(rec.state, 'verified');
  assert.equal(rec.attempts, 2);
  assert.equal(runs, 2);
  assert.deepEqual(waits, [5000]);
  assert.deepEqual([...RETRY_STATES].sort(), ['declaration_unreachable', 'key_lookup_failed', 'registry_unreachable']);
  // Not retried more than once, and not at all once the scan stopped.
  states.push('declaration_unreachable', 'declaration_unreachable', 'declaration_unreachable');
  runs = 0;
  assert.equal((await checkOne({ name: 'com.a/b', version: '1.0.0' })).attempts, 2);
  assert.equal(runs, 2);
  const stoppedClient = { ...client, stoppedReason: () => 'the registry answered HTTP 429' };
  const stoppedCheck = makeListingChecker({ checker: fake, registryClient: stoppedClient, registry: reg, sleep: async () => {} });
  runs = 0;
  states.length = 0;
  states.push('registry_unreachable');
  assert.equal((await stoppedCheck({ name: 'com.a/b', version: '1.0.0' })).attempts, 1);
  assert.equal(runs, 1);
});

test('only GET reads of single listings go to the registry host', async () => {
  const real = await loadChecker();
  const viaRegistry = [];
  const outcomes = [];
  const fake = {
    ...real,
    listing: {
      ...real.listing,
      async checkListing(o) {
        for (const [u, opts] of [
          [`${base}/v0.1/servers/com.a%2Fb/versions/1.0.0`, { method: 'GET' }],
          [`${base}/mcp`, { method: 'POST', body: '{}' }],
          [`${base}/v0/servers?limit=1`, { method: 'GET' }],
          [`${base}/v0.1/servers/com.a%2Fb/versions/1.0.0`, { method: 'DELETE' }],
        ]) {
          try {
            await o.request(u, opts);
            outcomes.push('sent');
          } catch (e) {
            outcomes.push(e.refused ? 'refused' : 'error');
          }
        }
        return { state: 'verified', exitCode: 0, reasons: [], report: { listing: {}, pointer: null, declaration: null, inForce: null, tools: { check: 'not_run' }, checked: [], notChecked: [], notes: [], fetched: [], newer: [], chain: [] } };
      },
    },
    resolve: { ...real.resolve, httpsRequest: async () => assert.fail('nothing goes to the checker fetch here') },
  };
  const client = { isRegistryUrl: (u) => u.startsWith(base), get: async (u) => (viaRegistry.push(u), { status: 200, headers: {}, body: Buffer.from('{}') }), stoppedReason: () => null };
  await makeListingChecker({ checker: fake, registryClient: client, registry: reg })({ name: 'com.a/b', version: '1.0.0', hasPointer: true });
  assert.deepEqual(outcomes, ['sent', 'refused', 'refused', 'refused']);
  assert.deepEqual(viaRegistry, [`${base}/v0.1/servers/com.a%2Fb/versions/1.0.0`]);
});

test('a name or version holding text the site does not store is not checked', async () => {
  const real = await loadChecker();
  const fake = { ...real, listing: { ...real.listing, checkListing: async () => assert.fail('not run') } };
  const checkOne = makeListingChecker({ checker: fake, registryClient: { isRegistryUrl: () => false, stoppedReason: () => null }, registry: reg });
  const f = rowFacts({ server: { name: 'com.a/b', version: 'me@example.org', _meta: { [PUB]: { addonDeclaration: {} } } } });
  const rec = await checkOne(f);
  assert.equal(rec.state, 'not_checkable');
  assert.doesNotMatch(JSON.stringify(rec), /@example\.org/);
});

test('the scan command records failures before the start and caps its time budget', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scan', 'scan.js');
  const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });
  // No published scan for --since auto: nothing is read, and the failure is recorded.
  const d1 = tempDir();
  const r1 = run(['--since', 'auto', '--data', d1]);
  assert.equal(r1.status, 2, r1.stderr);
  const s1 = JSON.parse(fs.readFileSync(path.join(d1, 'status.json'), 'utf8'));
  assert.match(s1.lastFailure.reason, /needs a published scan/);
  // The checker is not where DECLARED_CHECKER_DIR says: recorded too, with no local path.
  const d2 = tempDir();
  const r2 = run(['--data', d2], { DECLARED_CHECKER_DIR: tempDir('declared-empty-') });
  assert.equal(r2.status, 2, r2.stderr);
  const s2 = JSON.parse(fs.readFileSync(path.join(d2, 'status.json'), 'utf8'));
  assert.match(s2.lastFailure.reason, /checker was not found/);
  assert.doesNotMatch(JSON.stringify(s2), /declared-empty-|AppData|\/tmp\//);
  // A time budget near the age at which a lock is taken over is refused.
  const r3 = run(['--max-minutes', '301', '--data', tempDir()]);
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /at most 300/);
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runScan, paths } from '../scan/core.js';
import { makeRegistryClient, ScanStop, USER_AGENT } from '../scan/registry.js';
import { recordFrom, rowFacts } from '../scan/check.js';
import { tempDir, removeTempDirs } from '../testlib/fixture.js';

after(removeTempDirs);

const PUB = 'io.modelcontextprotocol.registry/publisher-provided';
const row = (name, pointer = false, meta = false) => ({
  server: { name, version: '1.0.0', description: 'd', ...(pointer || meta ? { _meta: { [PUB]: pointer ? { addonDeclaration: { url: 'https://x/', hash: 'sha256:00' } } : { other: 1 } } } : {}) },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: '2026-11-01T00:00:00Z', isLatest: true } },
});

// Three pages: 250 listings, two with a pointer.
function pages() {
  const all = [];
  for (let i = 0; i < 250; i++) all.push(row(`com.ex${i}/s`, i === 7 || i === 160, i % 50 === 0));
  return [all.slice(0, 100), all.slice(100, 200), all.slice(200)];
}

function fakeDeps({ failAt = null, data = pages(), stopAfterCheck = null } = {}) {
  const calls = [];
  let checks = 0;
  let stopped = null;
  return {
    calls,
    deps: {
      log: () => {},
      async listPage(cursor) {
        calls.push(cursor);
        const i = cursor === null ? 0 : Number(cursor.slice(1));
        if (failAt !== null && i === failAt) throw new ScanStop('the registry answered HTTP 503 three times in a row; the scan stopped');
        return { servers: data[i] || [], nextCursor: i + 1 < data.length ? `p${i + 1}` : null };
      },
      async checkOne(entry) {
        checks++;
        if (stopAfterCheck !== null && checks >= stopAfterCheck) stopped = 'the registry answered HTTP 429 (too many requests); the scan stopped';
        return { name: entry.name, version: entry.version, pointerInList: entry.hasPointer, checkedAt: '2026-11-19T00:00:00.000Z', state: entry.hasPointer ? 'verified' : 'no_declaration', exitCode: entry.hasPointer ? 0 : 12 };
      },
      stoppedReason: () => stopped,
    },
  };
}

const base = 'https://registry.modelcontextprotocol.io';

test('a full scan writes latest, history and status', async () => {
  const dir = tempDir();
  const { deps } = fakeDeps();
  const r = await runScan({ dataDir: dir, deps, registryBase: base, checkerVersion: '0.2.0' });
  assert.equal(r.ok, true);
  const latest = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
  assert.equal(latest.counts.listingsScanned, 250);
  assert.equal(latest.counts.pointersInListRead, 2);
  assert.equal(latest.counts.listed, 2);
  assert.equal(latest.counts.withPointer, undefined, 'the ambiguous count name is gone');
  assert.equal(latest.counts.withPublisherMetadata, 7);
  assert.deepEqual(latest.listings.map((x) => x.name), ['com.ex160/s', 'com.ex7/s']);
  assert.ok(Number.isFinite(Date.parse(latest.scanFinishedAt)) && latest.scanFinishedAt.endsWith('Z'));
  assert.equal(fs.readdirSync(path.join(dir, 'history')).length, 1);
  assert.ok(!fs.existsSync(paths(dir).state), 'progress removed after success');
  assert.ok(!fs.existsSync(paths(dir).lock), 'lock released');
  // A second scan the same day adds a second history file and keeps the first.
  const first = fs.readdirSync(path.join(dir, 'history'))[0];
  const before = fs.readFileSync(path.join(dir, 'history', first), 'utf8');
  await new Promise((res) => setTimeout(res, 1100));
  assert.equal((await runScan({ dataDir: dir, deps: fakeDeps().deps, registryBase: base })).ok, true);
  assert.equal(fs.readdirSync(path.join(dir, 'history')).length, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'history', first), 'utf8'), before);
});

test('a scan that fails keeps the previous data, records the failure, and resumes', async () => {
  const dir = tempDir();
  assert.equal((await runScan({ dataDir: dir, deps: fakeDeps().deps, registryBase: base })).ok, true);
  const latestBefore = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8');

  const failing = fakeDeps({ failAt: 2 });
  const r = await runScan({ dataDir: dir, deps: failing.deps, registryBase: base });
  assert.equal(r.ok, false);
  assert.equal(r.resumable, true);
  assert.equal(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'), latestBefore, 'latest.json unchanged');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.lastAttempt.ok, false);
  assert.match(status.lastFailure.reason, /503/);
  assert.equal(status.lastFailure.phase, 'list');
  const saved = JSON.parse(fs.readFileSync(paths(dir).state, 'utf8'));
  assert.equal(saved.cursor, 'p2');
  assert.equal(saved.pages, 2);

  const resumed = fakeDeps();
  const r2 = await runScan({ dataDir: dir, deps: resumed.deps, registryBase: base });
  assert.equal(r2.ok, true);
  assert.deepEqual(resumed.calls, ['p2'], 'continued from the saved cursor');
  assert.equal(r2.latest.counts.listingsScanned, 250);
  assert.equal(r2.latest.resumed, 1);
});

test('a stop during the checks keeps the checks already done', async () => {
  const dir = tempDir();
  const first = fakeDeps({ stopAfterCheck: 2 });
  const r = await runScan({ dataDir: dir, deps: first.deps, registryBase: base });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(dir, 'latest.json')), 'nothing published');
  const saved = JSON.parse(fs.readFileSync(paths(dir).state, 'utf8'));
  assert.equal(saved.phase, 'check');
  assert.equal(Object.keys(saved.results).length, 1);
  const again = fakeDeps();
  let checked = 0;
  const inner = again.deps.checkOne;
  again.deps.checkOne = async (e) => {
    checked++;
    return inner(e);
  };
  const r2 = await runScan({ dataDir: dir, deps: again.deps, registryBase: base });
  assert.equal(r2.ok, true);
  assert.equal(checked, 1, 'only the check not yet done ran');
  assert.deepEqual(again.calls, [], 'the list was not read again');
});

test('an empty list is not published in place of a full one', async () => {
  const dir = tempDir();
  assert.equal((await runScan({ dataDir: dir, deps: fakeDeps().deps, registryBase: base })).ok, true);
  const before = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8');
  const r = await runScan({ dataDir: dir, deps: fakeDeps({ data: [[]] }).deps, registryBase: base });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no listings/);
  assert.equal(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(paths(dir).state), 'a rejected result is not resumed');
  // Far fewer listings than before is rejected as well.
  const few = await runScan({ dataDir: dir, deps: fakeDeps({ data: [pages()[0].slice(0, 50)] }).deps, registryBase: base });
  assert.equal(few.ok, false);
  assert.match(few.reason, /less than 50 percent/);
  assert.equal(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'), before);
  // A list that suddenly carries no publisher metadata at all is rejected.
  const bare = pages().map((p) => p.map((x) => ({ ...x, server: { name: x.server.name, version: '1.0.0' } })));
  const nometa = await runScan({ dataDir: dir, deps: fakeDeps({ data: bare }).deps, registryBase: base });
  assert.equal(nometa.ok, false);
  assert.match(nometa.reason, /publisher metadata/);
  assert.equal(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'), before);
});

test('a damaged latest.json stops the scan instead of being replaced', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'latest.json'), '{ not json');
  const r = await runScan({ dataDir: dir, deps: fakeDeps().deps, registryBase: base });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'), '{ not json');
});

test('a listing whose pointer was removed is reported once as no longer listed', async () => {
  const dir = tempDir();
  assert.equal((await runScan({ dataDir: dir, deps: fakeDeps().deps, registryBase: base })).ok, true);
  const data = pages();
  data[0][7] = row('com.ex7/s', false, false);
  const r = await runScan({ dataDir: dir, deps: fakeDeps({ data }).deps, registryBase: base });
  assert.equal(r.ok, true);
  assert.deepEqual(r.latest.listings.map((x) => x.name), ['com.ex160/s']);
  assert.deepEqual(r.latest.withdrawn.map((x) => x.name), ['com.ex7/s']);
});

test('a second scan does not start while another holds the lock', async () => {
  const dir = tempDir();
  fs.mkdirSync(paths(dir).work, { recursive: true });
  fs.writeFileSync(paths(dir).lock, JSON.stringify({ at: new Date().toISOString() }));
  const r = await runScan({ dataDir: dir, deps: fakeDeps().deps, registryBase: base });
  assert.equal(r.ok, false);
  assert.match(r.reason, /lock/);
  // The refused start is recorded for the front page, and nothing else changes.
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.lastAttempt.ok, false);
  assert.equal(status.lastFailure.kind, 'busy');
  assert.match(status.lastFailure.reason, /another scan holds the lock/);
  assert.ok(!fs.existsSync(path.join(dir, 'latest.json')));
  assert.ok(!fs.existsSync(paths(dir).state));
});

function fakeFetch(statuses) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url, init });
    const st = statuses.length ? statuses.shift() : 200;
    const body = st === 200 ? JSON.stringify({ servers: [], metadata: {} }) : 'x';
    return new Response(body, { status: st });
  };
  fn.seen = seen;
  return fn;
}

test('the registry client stops at HTTP 429 and sends nothing more', async () => {
  const f = fakeFetch([429]);
  const c = makeRegistryClient({ registry: { base, loopback: false }, fetchImpl: f, sleep: async () => {}, minIntervalMs: 0 });
  await assert.rejects(c.listPage(null), (e) => e instanceof ScanStop && /429/.test(e.message));
  await assert.rejects(c.get(`${base}/v0.1/servers/a%2Fb/versions/1`), ScanStop);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].init.headers['User-Agent'], USER_AGENT);
  assert.match(USER_AGENT, /declaredlist\.com/);
  assert.equal(f.seen[0].init.redirect, 'manual');
});

test('the registry client retries a 5xx, then stops after three in a row', async () => {
  const ok = fakeFetch([503, 200]);
  const c1 = makeRegistryClient({ registry: { base, loopback: false }, fetchImpl: ok, sleep: async () => {}, minIntervalMs: 0 });
  assert.deepEqual(await c1.listPage(null), { servers: [], nextCursor: null });
  const bad = fakeFetch([503, 502, 500, 200]);
  const c2 = makeRegistryClient({ registry: { base, loopback: false }, fetchImpl: bad, sleep: async () => {}, minIntervalMs: 0 });
  await assert.rejects(c2.listPage(null), ScanStop);
  assert.equal(bad.seen.length, 3);
});

test('the registry client keeps at least the minimum interval between requests', async () => {
  const f = fakeFetch([200, 200, 200]);
  const waits = [];
  const c = makeRegistryClient({ registry: { base, loopback: false }, fetchImpl: f, sleep: async (ms) => waits.push(ms), minIntervalMs: 1000 });
  await c.listPage(null);
  await c.listPage(null);
  await c.listPage(null);
  assert.equal(waits.length, 2);
  for (const w of waits) assert.ok(w > 900 && w <= 1000);
});

test('the registry client refuses other hosts', async () => {
  const c = makeRegistryClient({ registry: { base, loopback: false }, fetchImpl: fakeFetch([]), sleep: async () => {}, minIntervalMs: 0 });
  await assert.rejects(c.get('https://evil.example/v0/servers'), /not a registry URL/);
  assert.equal(c.isRegistryUrl('https://registry.modelcontextprotocol.io.evil.example/x'), false);
});

test('row facts and records keep no email address or local path', () => {
  const f = rowFacts({ server: { name: 'com.a/b', version: '1', description: 'write me at x.y@example.com', title: 'C:\\Users\\someone\\file' } });
  assert.doesNotMatch(f.description, /@/);
  assert.doesNotMatch(f.title, /Users/);
  assert.equal(f.hasPointer, false);
  const rec = recordFrom(
    { name: 'com.a/b', version: '1', hasPointer: true },
    { state: 'declaration_unreachable', exitCode: 16, reasons: ['failed for a@b.example at /home/someone/x'], report: { listing: {}, pointer: { url: 'https://a/', hash: 'sha256:00' }, declaration: null, inForce: null, tools: { check: 'not_run' }, checked: [], notChecked: [], notes: [], fetched: [], newer: [], chain: [] } },
    { checkedAt: '2026-11-19T00:00:00Z', durationMs: 5, inForceDecl: { contact: 'mailto:someone@example.com', key: { method: 'http', domain: 'a', id: 'k', alg: 'ed25519' } }, registryBase: base },
  );
  const json = JSON.stringify(rec);
  assert.doesNotMatch(json, /@/);
  assert.doesNotMatch(json, /home\/someone/);
  assert.equal(rec.registryUrl, `${base}/v0.1/servers/com.a%2Fb/versions/1`);
});

test('a pass over updated listings keeps the listings found before and adds new ones', async () => {
  const dir = tempDir();
  const full = await runScan({ dataDir: dir, deps: fakeDeps().deps, registryBase: base });
  assert.equal(full.ok, true);
  assert.equal(full.latest.coverage.mode, 'full');
  const since = new Date(Date.parse(full.latest.scanStartedAt) - 3600000).toISOString();
  // Only one changed listing, which now carries a pointer.
  const seen = [];
  const inc = fakeDeps({ data: [[row('com.new/s', true)]] });
  const listPage = inc.deps.listPage;
  inc.deps.listPage = async (cursor, s) => {
    seen.push(s);
    return listPage(cursor);
  };
  const checked = [];
  const inner = inc.deps.checkOne;
  inc.deps.checkOne = async (e) => {
    checked.push(`${e.name} ${e.version}`);
    return inner(e);
  };
  const r = await runScan({ dataDir: dir, deps: inc.deps, registryBase: base, since });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(seen, [since]);
  assert.deepEqual(r.latest.listings.map((x) => x.name), ['com.ex160/s', 'com.ex7/s', 'com.new/s']);
  assert.deepEqual(checked.sort(), ['com.ex160/s 1.0.0', 'com.ex7/s 1.0.0', 'com.new/s 1.0.0']);
  assert.equal(r.latest.coverage.mode, 'updated_since');
  assert.equal(r.latest.coverage.since, since);
  assert.equal(r.latest.coverage.lastFullPass.listingsScanned, 250);
  assert.equal(r.latest.counts.listingsScanned, 1);
  assert.deepEqual(r.latest.withdrawn, []);
  // An update pass that reads no changed listing is still published.
  const none = await runScan({ dataDir: dir, deps: fakeDeps({ data: [[]] }).deps, registryBase: base, since: r.latest.scanStartedAt });
  assert.equal(none.ok, true, none.reason);
  assert.equal(none.latest.listings.length, 3);
});

test('a pass over updated listings needs a full pass before it and a start no later than it', async () => {
  const dir = tempDir();
  const r = await runScan({ dataDir: dir, deps: fakeDeps().deps, registryBase: base, since: '2026-11-01T00:00:00.000Z' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /full pass first/);
  assert.ok(!fs.existsSync(path.join(dir, 'latest.json')));
  assert.equal((await runScan({ dataDir: dir, deps: fakeDeps().deps, registryBase: base })).ok, true);
  const late = await runScan({ dataDir: dir, deps: fakeDeps().deps, registryBase: base, since: '2099-01-01T00:00:00.000Z' });
  assert.equal(late.ok, false);
  assert.match(late.reason, /must not be later/);
});

test('the listing check sends registry reads through the polite client and the rest through the checker', async () => {
  const { makeListingChecker } = await import('../scan/check.js');
  const { loadChecker } = await import('../lib/checker.js');
  const real = await loadChecker();
  const viaRegistry = [];
  const viaChecker = [];
  const declUrl = 'https://example.com/.well-known/addon-declaration/com.example/w/by-hash/00.json';
  const fake = {
    listing: {
      ...real.listing,
      async checkListing(o) {
        assert.equal(o.fetchTools, true, '--fetch-tools behaviour');
        assert.equal(o.version, '1.0.0');
        await o.request(`${base}/v0.1/servers/com.example%2Fw/versions/1.0.0`, { maxBytes: 100 });
        await o.request(declUrl, { method: 'GET', maxBytes: 16384 });
        return { state: 'verified', exitCode: 0, reasons: [], report: { listing: {}, pointer: null, declaration: null, inForce: { source: 'pointer', url: declUrl, hash: 'sha256:00', format: 'addon-declaration/0.2', state: 'valid' }, tools: { check: 'run', result: 'match' }, checked: [], notChecked: [], notes: [], fetched: [], newer: [], chain: [] } };
      },
    },
    resolve: {
      ...real.resolve,
      async httpsRequest(url) {
        viaChecker.push(url);
        return { status: 200, headers: {}, body: Buffer.from('{"x":1}') };
      },
    },
    declaration: { parseDeclarationText: (b) => ({ expiresAt: '2027-05-18T00:00:00Z', issuedAt: '2026-11-19T00:00:00Z', key: { method: 'http', domain: 'example.com', id: 'sha256:k', alg: 'ed25519' }, parsed: JSON.parse(b.toString()) }) },
  };
  const client = { isRegistryUrl: (u) => u.startsWith(base), get: async (u) => (viaRegistry.push(u), { status: 200, headers: {}, body: Buffer.from('{}') }) };
  const checkOne = makeListingChecker({ checker: fake, registryClient: client, registry: { base, loopback: false } });
  const rec = await checkOne({ name: 'com.example/w', version: '1.0.0', hasPointer: true });
  assert.equal(rec.state, 'verified');
  assert.deepEqual(viaRegistry, [`${base}/v0.1/servers/com.example%2Fw/versions/1.0.0`]);
  assert.deepEqual(viaChecker, [declUrl]);
  assert.equal(rec.declaration.expiresAt, '2027-05-18T00:00:00Z');
  assert.equal(rec.declaration.keyDomain, 'example.com');
  const bad = await checkOne({ name: '../x', version: '1.0.0' });
  assert.equal(bad.state, 'not_checkable');
  const throwing = makeListingChecker({ checker: { ...fake, listing: { ...real.listing, checkListing: async () => { throw new Error('boom at /home/someone/x.js'); } } }, registryClient: client, registry: { base, loopback: false } });
  const err = await throwing({ name: 'com.example/w', version: '1.0.0' });
  assert.equal(err.state, 'check_error');
  assert.doesNotMatch(JSON.stringify(err), /someone/);
});

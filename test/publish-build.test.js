// The scanner publishes only results the site build accepts, and the build
// accepts every result the scanner publishes (lib/validate.js holds the rules).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runScan } from '../scan/core.js';
import { buildSite } from '../build/core.js';
import { latestProblem, MAX_LISTINGS } from '../lib/validate.js';
import { tempDir, removeTempDirs, plainLatest } from '../testlib/fixture.js';

after(removeTempDirs);

const base = 'https://registry.modelcontextprotocol.io';
const PUB = 'io.modelcontextprotocol.registry/publisher-provided';
const row = (name, pointer = false) => ({
  server: { name, version: '1.0.0', description: 'd', ...(pointer ? { _meta: { [PUB]: { addonDeclaration: { url: 'https://x/', hash: 'sha256:00' } } } } : {}) },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: '2026-11-01T00:00:00Z', isLatest: true } },
});

function deps(pagesOfRows) {
  return {
    log: () => {},
    async listPage(cursor) {
      const i = cursor === null ? 0 : Number(cursor.slice(1));
      return { servers: pagesOfRows[i] || [], nextCursor: i + 1 < pagesOfRows.length ? `p${i + 1}` : null };
    },
    async checkOne(entry) {
      return { name: entry.name, version: entry.version, pointerInList: entry.hasPointer, checkedAt: '2026-11-19T00:00:00.000Z', state: 'verified', exitCode: 0 };
    },
    stoppedReason: () => null,
  };
}

test('a pass over updated listings that reads none is published and the site builds from it', async () => {
  const root = tempDir();
  const data = path.join(root, 'data');
  const full = await runScan({ dataDir: data, deps: deps([[row('com.a/x', true), row('com.b/y')]]), registryBase: base });
  assert.equal(full.ok, true, full.reason);
  // The registry answers with an empty list: nothing changed since the last scan.
  const r = await runScan({ dataDir: data, deps: deps([[]]), registryBase: base, since: full.latest.scanStartedAt });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.latest.counts.listingsScanned, 0);
  assert.equal(r.latest.coverage.mode, 'updated_since');
  assert.equal(r.latest.listings.length, 1);
  const dist = path.join(root, 'dist');
  buildSite({ dataDir: data, outDir: dist });
  const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.match(index, /<dt>Listings read in this scan<\/dt><dd>0 \(/);
  assert.match(index, /Last full pass over the registry/);
});

test('a pass over updated listings that reads none is rejected when it rests on no full pass that read some', async () => {
  const data = tempDir();
  // A hand made result whose full pass read nothing.
  const prev = { ...plainLatest(), coverage: { mode: 'updated_since', since: '2026-11-18T00:00:00.000Z', lastFullPass: { startedAt: '2026-11-18T00:00:00.000Z', finishedAt: '2026-11-18T00:10:00.000Z', listingsScanned: 0, withPublisherMetadata: 0 } } };
  prev.listings = [];
  prev.scanStartedAt = '2026-11-19T00:00:00.000Z';
  fs.writeFileSync(path.join(data, 'latest.json'), JSON.stringify(prev));
  const before = fs.readFileSync(path.join(data, 'latest.json'), 'utf8');
  const r = await runScan({ dataDir: data, deps: deps([[]]), registryBase: base, since: '2026-11-19T00:00:00.000Z' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no scanned listings and rests on no full pass/);
  assert.equal(fs.readFileSync(path.join(data, 'latest.json'), 'utf8'), before, 'latest.json unchanged');
  const status = JSON.parse(fs.readFileSync(path.join(data, 'status.json'), 'utf8'));
  assert.equal(status.lastFailure.kind, 'rejected');
});

test('the build rules', () => {
  const ok = plainLatest();
  assert.equal(latestProblem(ok), null);
  assert.match(latestProblem({ ...ok, counts: { listingsScanned: 0 } }), /no scanned listings/);
  assert.match(latestProblem({ ...ok, counts: { listingsScanned: 0 }, coverage: { mode: 'updated_since', lastFullPass: null } }), /no scanned listings/);
  assert.match(latestProblem({ ...ok, counts: { listingsScanned: 0 }, coverage: { mode: 'full', lastFullPass: { listingsScanned: 10 } } }), /no scanned listings/);
  assert.equal(latestProblem({ ...ok, counts: { listingsScanned: 0 }, coverage: { mode: 'updated_since', lastFullPass: { listingsScanned: 10 } } }), null);
  assert.match(latestProblem({ ...ok, counts: { listingsScanned: -1 } }), /no scanned listings/);
  assert.match(latestProblem(null), /missing/);
  assert.match(latestProblem([]), /missing/);
  assert.match(latestProblem({ ...ok, scanFinishedAt: 'x' }), /no scan time/);
  assert.match(latestProblem({ ...ok, listings: [{ name: '' }] }), /without a name/);
  assert.match(latestProblem({ ...ok, listings: Array.from({ length: MAX_LISTINGS + 1 }, (_, i) => ({ name: `com.a/${i}` })) }), new RegExp(`more than ${MAX_LISTINGS} listings`));
});

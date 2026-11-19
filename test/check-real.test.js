// The scanner's listing check with the checker's real checkListing: the
// registry is a local double on 127.0.0.1 read through the polite registry
// client (real fetch), and the publisher's files come from a fake request in
// place of the checker's hardened fetch. Nothing leaves the machine. This
// covers the report fields recordFrom reads, so a change in the checker's
// report shape shows up here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadChecker, checkerDir } from '../lib/checker.js';
import { makeRegistryClient, USER_AGENT } from '../scan/registry.js';
import { makeListingChecker } from '../scan/check.js';

const dir = checkerDir();
const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
const real = await loadChecker();
const { signDeclaration, declarationHash, SPEC_ID_02 } = await imp('lib/declaration.js');
const { parseProofRecords } = await imp('lib/keys.js');
const { toolSetDigestsFromPages } = await imp('lib/tool-set-digest.js');
const { makeKey, TOOLS } = await imp('testlib/helpers.js');

const NAME = 'com.example/weather';
const VERSION = '1.0.0';
const HOST = 'example.com';
const PP = 'io.modelcontextprotocol.registry/publisher-provided';
const key = makeKey('ed25519');
const keys = parseProofRecords(key.record).keys;
const tsd = toolSetDigestsFromPages([JSON.stringify(TOOLS)]);

function declaration(over = {}) {
  return signDeclaration(
    { spec: SPEC_ID_02, name: NAME, version: VERSION, toolSetDigest: { spec: 'mcp-tool-set-digest/1', contract: tsd.contract.digest, extras: tsd.extras.digest }, issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2030-01-01T00:00:00Z', key: { method: 'http', domain: HOST }, ...over },
    key.loaded,
  );
}

// One listing whose pointer names decl, served by a registry double, and a
// fake request that serves decl at its by-hash path (404 for everything else).
async function world(decl) {
  const hex = declarationHash(decl).slice('sha256:'.length);
  const pointerUrl = `https://${HOST}/.well-known/addon-declaration/${NAME}/by-hash/${hex}.json`;
  const listing = { server: { name: NAME, version: VERSION, _meta: { [PP]: { addonDeclaration: { url: pointerUrl, hash: declarationHash(decl) } } } }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: '2026-11-19T01:16:58.545256Z', isLatest: true } } };
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, ua: req.headers['user-agent'] });
    const parts = req.url.split('/').map((x) => decodeURIComponent(x));
    if (req.method === 'GET' && parts[1] === 'v0.1' && parts[2] === 'servers' && parts[3] === NAME && parts[4] === 'versions' && parts[5] === VERSION) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(listing));
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const registry = real.listing.registryBase(`http://127.0.0.1:${server.address().port}`);
  const published = new Map([[pointerUrl, Buffer.from(JSON.stringify(decl, null, 2) + '\n')]]);
  const viaChecker = [];
  const checker = {
    ...real,
    resolve: {
      ...real.resolve,
      async httpsRequest(url, opts = {}) {
        viaChecker.push(`${opts.method || 'GET'} ${url}`);
        const body = published.get(url);
        return body ? { status: 200, headers: { 'content-type': 'application/json' }, body } : { status: 404, headers: {}, body: Buffer.from('not found') };
      },
      keysFromHttp: async () => ({ keys, notes: [] }),
      keysFromDns: async () => assert.fail('the declaration names the http method'),
      dnsResolverFor: () => ({}),
    },
  };
  const client = makeRegistryClient({ registry, minIntervalMs: 0, sleep: async () => {} });
  const checkOne = makeListingChecker({ checker, registryClient: client, registry, sleep: async () => {} });
  return { checkOne, seen, viaChecker, pointerUrl, registry, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

test('a real check through the scanner stores the facts of the declaration in force', async () => {
  const decl = declaration();
  const w = await world(decl);
  try {
    const rec = await w.checkOne({ name: NAME, version: VERSION, hasPointer: true, title: 'Weather' });
    assert.equal(rec.state, 'verified', JSON.stringify(rec.reasons));
    assert.equal(rec.exitCode, 0);
    assert.equal(rec.attempts, 1);
    assert.equal(rec.pointerInList, true);
    assert.equal(rec.publishedAt, '2026-11-19T01:16:58.545256Z');
    assert.equal(rec.registryStatus, 'active');
    assert.equal(rec.pointer.url, w.pointerUrl);
    assert.equal(rec.pointer.hash, declarationHash(decl));
    assert.equal(rec.declarationNamed.hash, declarationHash(decl));
    assert.equal(rec.declarationNamed.state, 'valid');
    assert.equal(rec.inForce.source, 'pointer');
    assert.equal(rec.inForce.state, 'valid');
    assert.equal(rec.declaration.of, 'in_force');
    assert.equal(rec.declaration.issuedAt, '2026-01-01T00:00:00Z');
    assert.equal(rec.declaration.expiresAt, '2030-01-01T00:00:00Z');
    assert.equal(rec.declaration.keyMethod, 'http');
    assert.equal(rec.declaration.keyDomain, HOST);
    assert.equal(rec.declaration.alg, 'ed25519');
    assert.ok(rec.keyId && rec.keyId.startsWith('sha256:'), rec.keyId);
    assert.equal(rec.tools.check, 'not_checked', 'no remote is declared');
    assert.ok(rec.checked.some((c) => /hash equals the pointer hash/.test(c)), rec.checked.join('; '));
    assert.ok(rec.requests.some((q) => q.purpose === 'registry listing' && q.status === 200));
    assert.ok(rec.requests.some((q) => q.purpose === 'declaration named by the listing' && q.status === 200));
    // The registry read went through the polite client, with the site's User-Agent, once.
    assert.equal(w.seen.length, 1);
    assert.equal(w.seen[0].ua, USER_AGENT);
    // The publisher's files went through the checker's fetch.
    assert.ok(w.viaChecker.includes(`GET ${w.pointerUrl}`));
    assert.ok(w.viaChecker.every((x) => x.startsWith('GET https://example.com/')), w.viaChecker.join('\n'));
  } finally {
    await w.close();
  }
});

test('a real check that stops at an expired declaration still stores its dates and key', async () => {
  const decl = declaration({ issuedAt: '2025-01-01T00:00:00Z', expiresAt: '2025-06-01T00:00:00Z' });
  const w = await world(decl);
  try {
    const rec = await w.checkOne({ name: NAME, version: VERSION, hasPointer: true });
    assert.equal(rec.state, 'expired', JSON.stringify(rec.reasons));
    assert.equal(rec.inForce, null);
    assert.ok(rec.declaration, 'declaration facts kept');
    assert.equal(rec.declaration.of, 'named');
    assert.equal(rec.declaration.expiresAt, '2025-06-01T00:00:00Z');
    assert.equal(rec.declaration.keyDomain, HOST);
    assert.ok(rec.notChecked.length > 0);
  } finally {
    await w.close();
  }
});

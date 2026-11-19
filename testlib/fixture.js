// Fixtures shared by the tests (outside test/ so the runner does not treat
// this file as a suite).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every folder made here is removed by removeTempDirs, which each suite that
// makes one runs in an after hook.
const made = new Set();

export function tempDir(prefix = 'declared-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  return dir;
}

export function removeTempDirs() {
  for (const dir of made) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    made.delete(dir);
  }
}

export const HOSTILE_NAMES = [
  '<script>alert(1)</script>/x',
  'com.evil/"><img src=x onerror=alert(1)>',
  '../../../etc/passwd',
  'nul.example/aux',
  'COM.Example/Upper',
  'com.example/ok',
  'com.example/\u202Egnp.exe',
  "com.example/'onmouseover='x",
];

function result(name, extra = {}) {
  return {
    name,
    version: '1.0.0',
    title: 'Title <b>bold</b> \u202Ereversed',
    description: "</p><script>alert('x')</script> write to someone@example.org <img src=x onerror=alert(2)>",
    websiteUrl: 'javascript:alert(3)',
    publishedAt: '2026-11-19T01:16:58.545256Z',
    registryStatus: 'active',
    registryUrl: `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(name)}/versions/1.0.0`,
    pointerInList: true,
    checkedAt: '2026-11-19T14:00:00.000Z',
    durationMs: 1200,
    state: 'pointer_refused',
    exitCode: 14,
    reasons: ['the pointer URL is on <evil.example>; "quoted" & more'],
    pointer: { url: 'javascript:alert(1)', hash: 'sha256:<x>' },
    declarationNamed: null,
    inForce: { source: 'pointer', url: 'http://insecure.example/x.json', hash: 'sha256:abc', format: 'addon-declaration/0.2', state: 'valid' },
    declaration: { issuedAt: '2026-11-01T00:00:00Z', expiresAt: '2027-05-01T00:00:00Z', keyMethod: 'http', keyDomain: 'evil.example', keyId: 'sha256:k', alg: 'ed25519', remotes: [{ type: 'streamable-http', url: 'https://user:pw@evil.example/mcp' }], previous: null },
    keySource: 'http: https://evil.example/.well-known/mcp-registry-auth',
    keyRecord: null,
    keyId: 'sha256:k',
    alg: 'ed25519',
    tools: { check: 'not_run', result: null, source: null, remote: 'data:text/html,<script>alert(4)</script>', protocolVersion: null, era: null, pages: null, reason: null },
    toolSetDigest: null,
    newer: [],
    chain: [],
    checked: ['<iframe src="https://evil.example">'],
    notChecked: ['x" onload="y'],
    notes: [],
    requests: [{ purpose: 'declaration', method: 'GET', rpc: null, url: 'data:text/html,<script>alert(5)</script>', status: 200, error: null }],
    ...extra,
  };
}

export function hostileLatest() {
  return {
    schema: 'declaredlist/scan-1',
    scanStartedAt: '2026-11-19T13:58:00.000Z',
    scanFinishedAt: '2026-11-19T14:01:00.000Z',
    durationSeconds: 180,
    resumed: 0,
    registry: 'https://registry.modelcontextprotocol.io',
    method: {},
    checker: { name: 'addon-declare', version: '0.2.0<script>', source: 'https://github.com/bcrypto0/addon-declaration' },
    counts: { listingsScanned: 5000, pages: 50, withPublisherMetadata: 9, withPointer: HOSTILE_NAMES.length, checked: HOSTILE_NAMES.length, listed: HOSTILE_NAMES.length, withdrawn: 1, byState: {} },
    listings: HOSTILE_NAMES.map((n) => result(n)),
    withdrawn: [{ name: '<b>gone</b>', version: null, checkedAt: '2026-11-19T14:01:00.000Z', state: null, reason: '<i>reason</i>' }],
  };
}

// A plain fixture with the shape of a real result, for wording checks.
export function plainLatest() {
  return {
    ...hostileLatest(),
    checker: { name: 'addon-declare', version: '0.2.0', source: 'https://github.com/bcrypto0/addon-declaration' },
    listings: [
      result('com.example/weather', {
        title: 'Weather',
        description: 'Forecasts.',
        websiteUrl: 'https://example.com',
        state: 'verified_newer_declaration',
        exitCode: 11,
        reasons: [],
        pointer: { url: 'https://example.com/.well-known/addon-declaration/com.example/weather/by-hash/aa.json', hash: 'sha256:aa' },
        inForce: { source: 'versions/1.0.0.json', url: 'https://example.com/.well-known/addon-declaration/com.example/weather/versions/1.0.0.json', hash: 'sha256:bb', format: 'addon-declaration/0.2', state: 'valid' },
        declaration: { issuedAt: '2026-11-01T00:00:00Z', expiresAt: '2027-05-01T00:00:00Z', keyMethod: 'http', keyDomain: 'example.com', keyId: 'sha256:k', alg: 'ed25519', remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }], previous: 'sha256:aa' },
        tools: { check: 'run', result: 'match', source: 'remote', remote: 'https://example.com/mcp', protocolVersion: '2026-07-28', era: 'modern', pages: 1, reason: null },
        toolSetDigest: { contract: { result: 'match', declared: 'sha256-x', computed: 'sha256-x' }, extras: { result: 'match', declared: 'sha256-y', computed: 'sha256-y' }, comparable: true },
        checked: ['signature'],
        notChecked: [],
        requests: [{ purpose: 'registry listing', method: 'GET', rpc: null, url: 'https://registry.modelcontextprotocol.io/v0.1/servers/com.example%2Fweather/versions/1.0.0', status: 200, error: null }],
      }),
    ],
    withdrawn: [],
  };
}

export function writeData(dir, latest, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(latest, null, 2));
  if (extra.status) fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(extra.status, null, 2));
}

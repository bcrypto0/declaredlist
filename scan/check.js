// Runs the checker's check-listing logic (lib/listing.js checkListing) for one
// listing, with --fetch-tools behaviour, and turns its report into the record
// the site stores. Registry reads go through the polite registry client; every
// other read (the publisher's site, the key lookup, the declared MCP remote)
// goes through the checker's own hardened fetch and key lookup, exactly as the
// command line does.

import { untrusted, clip, scrubPaths } from '../lib/text.js';

const MAX_LIST = 60;
const list = (a, n = 500) => (Array.isArray(a) ? a.slice(0, MAX_LIST).map((x) => untrusted(typeof x === 'string' ? x : JSON.stringify(x), n)) : []);
const str = (v, n = 500) => (typeof v === 'string' ? untrusted(v, n) : null);
const PUBLISHER_META_KEY = 'io.modelcontextprotocol.registry/publisher-provided';
const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The facts the scanner keeps from one list row ({ server, _meta }).
//
// A name or version that cleaning would change (an email address, a local
// path, an invisible character, or more than 200 or 255 characters) is kept
// only in its cleaned form, marked textAltered, and is not checked: the raw
// text is not stored, and the cleaned text is not the listing's name.
//
// hasPointer follows step 2 of the checker (SPEC.md section 8a): a listing is
// checked when its publisher metadata holds an addonDeclaration member, and
// also when server._meta or the publisher metadata is present but not a JSON
// object (the checker reports that as pointer_malformed, not no_declaration).
export function rowFacts(row) {
  const s = isObj(row) && isObj(row.server) ? row.server : {};
  const off = isObj(row) && isObj(row._meta) && isObj(row._meta[OFFICIAL_META_KEY]) ? row._meta[OFFICIAL_META_KEY] : {};
  const sm = s._meta;
  const pub = isObj(sm) ? sm[PUBLISHER_META_KEY] : undefined;
  const rawName = typeof s.name === 'string' ? s.name : null;
  const rawVersion = typeof s.version === 'string' ? s.version : null;
  const name = rawName === null ? null : untrusted(rawName, 200);
  const version = rawVersion === null ? null : untrusted(rawVersion, 255);
  return {
    name,
    version,
    ...(name !== rawName || version !== rawVersion ? { textAltered: true } : {}),
    title: str(s.title, 200),
    description: str(s.description, 600),
    websiteUrl: str(s.websiteUrl, 600),
    publishedAt: str(off.publishedAt, 64),
    registryStatus: str(off.status, 64),
    hasPublisherMeta: pub !== undefined,
    hasPointer: (sm !== undefined && !isObj(sm)) || (pub !== undefined && !isObj(pub)) || (isObj(pub) && pub.addonDeclaration !== undefined),
  };
}

function digestPart(x) {
  if (!isObj(x)) return null;
  return { result: str(x.result, 40), declared: str(x.declared, 120), computed: str(x.computed, 120), ...(x.code ? { code: str(x.code, 40) } : {}) };
}

// The record of one check, from checkListing's { state, exitCode, reasons, report }.
// inForceDecl: the parsed declaration whose facts are shown, and declOf which
// one it is: "in_force" (the declaration in force) or "named" (the one the
// listing names, when the check stopped before a declaration was put in force).
export function recordFrom(entry, r, { checkedAt, durationMs, inForceDecl, declOf = 'in_force', attempts = 1, registryBase }) {
  const R = r.report;
  const F = R.inForce;
  const V = F && F.verify ? F.verify : R.declaration && R.declaration.verify ? R.declaration.verify : null;
  const T = R.tools || {};
  const tsd = V && isObj(V.toolSetDigest) ? V.toolSetDigest : null;
  const enc = (s) => encodeURIComponent(s);
  return {
    name: entry.name,
    version: entry.version,
    title: entry.title ?? null,
    description: entry.description ?? null,
    websiteUrl: entry.websiteUrl ?? null,
    publishedAt: str(R.listing && R.listing.publishedAt, 64) ?? entry.publishedAt ?? null,
    registryStatus: str(R.listing && R.listing.registryStatus, 64) ?? entry.registryStatus ?? null,
    registryUrl: `${registryBase}/v0.1/servers/${enc(entry.name)}/versions/${enc(entry.version)}`,
    pointerInList: Boolean(entry.hasPointer),
    checkedAt,
    durationMs,
    attempts,
    state: r.state,
    exitCode: r.exitCode,
    reasons: list(r.reasons),
    pointer: R.pointer ? { url: str(R.pointer.url, 600), hash: str(R.pointer.hash, 80) } : null,
    declarationNamed: R.declaration ? { url: str(R.declaration.url, 600), hash: str(R.declaration.hash, 80), format: str(R.declaration.format, 60), state: str(R.declaration.state, 60) } : null,
    inForce: F ? { source: str(F.source, 80), url: str(F.url, 600), hash: str(F.hash, 80), format: str(F.format, 60), state: str(F.state, 60) } : null,
    declaration: inForceDecl
      ? {
          of: declOf === 'named' ? 'named' : 'in_force',
          issuedAt: str(inForceDecl.issuedAt, 64),
          expiresAt: str(inForceDecl.expiresAt, 64),
          keyMethod: str(inForceDecl.key && inForceDecl.key.method, 20),
          keyDomain: str(inForceDecl.key && inForceDecl.key.domain, 260),
          keyId: str(inForceDecl.key && inForceDecl.key.id, 120),
          alg: str(inForceDecl.key && inForceDecl.key.alg, 20),
          remotes: Array.isArray(inForceDecl.remotes) ? inForceDecl.remotes.slice(0, 10).map((x) => ({ type: str(x && x.type, 40), url: str(x && x.url, 600) })) : [],
          previous: str(inForceDecl.previous, 80),
        }
      : null,
    keySource: V ? str(V.keySource, 300) : null,
    keyRecord: V ? str(V.keyRecord, 120) : null,
    keyId: V ? str(V.keyId, 120) : null,
    alg: V ? str(V.alg, 20) : null,
    tools: {
      check: str(T.check, 20),
      result: str(T.result, 20),
      source: str(T.source, 20),
      remote: str(T.remote, 600),
      protocolVersion: str(T.protocolVersion, 40),
      era: str(T.era, 20),
      pages: Number.isInteger(T.pages) ? T.pages : null,
      reason: str(T.reason, 500),
    },
    toolSetDigest: tsd ? { contract: digestPart(tsd.contract), extras: digestPart(tsd.extras), comparable: tsd.comparable === true } : null,
    newer: Array.isArray(R.newer) ? R.newer.slice(0, 5).map((c) => ({ path: str(c.path, 200), result: str(c.result, 40), hash: str(c.hash, 80), format: str(c.format, 60), reason: str(c.reason, 300) })) : [],
    chain: Array.isArray(R.chain) ? R.chain.slice(0, 10).map((c) => ({ hash: str(c.hash, 80), format: str(c.format, 60), issuedAt: str(c.issuedAt, 64) })) : [],
    checked: [...list(R.checked), ...(V ? list(V.checked).map((x) => `${F && F.source !== 'pointer' && F.verify ? 'declaration in force: ' : ''}${x}`) : [])],
    notChecked: [...list(R.notChecked), ...(V ? list(V.notChecked) : [])],
    notes: [...(V ? list(V.keyNotes) : []), ...(V ? list(V.notes) : []), ...list(T.notes), ...list(R.notes)],
    requests: Array.isArray(R.fetched)
      ? R.fetched.slice(0, 40).map((f) => ({ purpose: str(f.purpose, 80), method: str(f.method, 10), rpc: str(f.rpc, 40), url: str(f.url, 600), status: Number.isInteger(f.status) ? f.status : null, error: str(f.error, 300) }))
      : [],
  };
}

// A record for a check that did not run or did not finish.
export function scannerRecord(entry, state, reason, { checkedAt, registryBase }) {
  const enc = (s) => encodeURIComponent(String(s));
  return {
    name: entry.name,
    version: entry.version,
    title: entry.title ?? null,
    description: entry.description ?? null,
    websiteUrl: entry.websiteUrl ?? null,
    publishedAt: entry.publishedAt ?? null,
    registryStatus: entry.registryStatus ?? null,
    registryUrl: `${registryBase}/v0.1/servers/${enc(entry.name)}/versions/${enc(entry.version)}`,
    pointerInList: Boolean(entry.hasPointer),
    checkedAt,
    durationMs: 0,
    state,
    exitCode: null,
    reasons: [untrusted(reason, 500)],
    pointer: null,
    declarationNamed: null,
    inForce: null,
    declaration: null,
    keySource: null,
    keyRecord: null,
    keyId: null,
    alg: null,
    tools: { check: 'not_run', result: null, source: null, remote: null, protocolVersion: null, era: null, pages: null, reason: null },
    toolSetDigest: null,
    newer: [],
    chain: [],
    checked: [],
    notChecked: [],
    notes: [],
    requests: [],
  };
}

// States that a single failed read can cause. Such a check is run once more,
// after a pause, before its result is stored.
export const RETRY_STATES = Object.freeze(['registry_unreachable', 'declaration_unreachable', 'key_lookup_failed']);

// checker: loadChecker() result; registryClient: makeRegistryClient() result.
export function makeListingChecker({ checker, registryClient, registry, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 5000, retries = 1, log = () => {} }) {
  const { checkListing, isServerName, isVersionArgument, shownUrl } = checker.listing;
  const { httpsRequest, keysFromDns, keysFromHttp, dnsResolverFor } = checker.resolve;
  const { parseDeclarationText } = checker.declaration;
  const keyLookup = (method, domain) => (method === 'dns' ? keysFromDns(domain, { resolver: dnsResolverFor() }) : keysFromHttp(domain));
  const shown = typeof shownUrl === 'function' ? shownUrl : (u) => u;
  // Only GET reads of single listings go to the registry host, through the
  // polite client. Anything else aimed at that host (for example a tools/list
  // POST to a remote declared on it) is refused, not turned into a GET.
  const listingPrefix = `${new URL(registry.base).pathname.replace(/\/+$/, '')}/v0.1/servers/`;
  const stopped = () => (typeof registryClient.stoppedReason === 'function' ? registryClient.stoppedReason() : null);

  async function runOnce(entry) {
    // Bodies of declaration files read during the check, by the URL requested
    // and by the URL as the report shows it, so the expiry, key and remotes of
    // the declaration can be shown. A shown URL that two requests share is
    // ambiguous and not used.
    const bodies = new Map();
    const byShown = new Map();
    const remember = (url, body) => {
      bodies.set(url, body);
      const s = shown(url);
      if (s === url) return;
      if (byShown.has(s) && byShown.get(s) !== url) byShown.set(s, null);
      else byShown.set(s, url);
    };
    const request = async (url, opts = {}) => {
      const method = String(opts.method || 'GET').toUpperCase();
      let res;
      if (registryClient.isRegistryUrl(url)) {
        let p = '';
        try {
          p = new URL(url).pathname;
        } catch {
          p = '';
        }
        if (method !== 'GET' || !p.startsWith(listingPrefix)) throw Object.assign(new Error('refused: only GET reads of single listings are sent to the registry host'), { refused: true });
        res = await registryClient.get(url, { maxBytes: opts.maxBytes });
      } else res = await httpsRequest(url, opts);
      if (method === 'GET' && res.status === 200 && res.body.length <= 16384) remember(url, res.body);
      return res;
    };
    const bodyOf = (u) => {
      if (typeof u !== 'string') return null;
      if (bodies.has(u)) return bodies.get(u);
      const real = byShown.get(u);
      return real ? bodies.get(real) : null;
    };
    const t0 = Date.now();
    const r = await checkListing({ name: entry.name, version: entry.version, registry, fetchTools: true, now: Date.now(), request, keyLookup });
    return { r, bodyOf, durationMs: Date.now() - t0 };
  }

  return async function checkOne(entry) {
    let checkedAt = now().toISOString();
    if (entry.textAltered || !isServerName(entry.name) || !isVersionArgument(entry.version) || entry.version === 'latest') {
      return scannerRecord(entry, 'not_checkable', 'the listing name or version is not one the checker accepts, or holds text this site does not store', { checkedAt, registryBase: registry.base });
    }
    let out;
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        out = await runOnce(entry);
      } catch (e) {
        return scannerRecord(entry, 'check_error', `the check ended with an error: ${clip(scrubPaths(e && e.message ? e.message : 'unknown error'), 300)}`, { checkedAt, registryBase: registry.base });
      }
      if (attempts > retries || !RETRY_STATES.includes(out.r.state) || stopped()) break;
      log(`${entry.name}: ${out.r.state}; checking once more in ${retryDelayMs / 1000} s`);
      await sleep(retryDelayMs);
      if (stopped()) break;
      checkedAt = now().toISOString();
    }
    const { r, bodyOf, durationMs } = out;
    // The facts of the declaration in force; when the check stopped before one
    // was put in force, those of the declaration the listing names (only when
    // the served file is that one, by hash).
    const R = r.report;
    let source = null;
    let declOf = 'in_force';
    if (R.inForce && R.inForce.url) source = R.inForce.url;
    else if (R.declaration && R.declaration.url && R.pointer && R.declaration.hash === R.pointer.hash) {
      source = R.declaration.url;
      declOf = 'named';
    }
    let inForceDecl = null;
    const body = source ? bodyOf(source) : null;
    if (body) {
      try {
        inForceDecl = parseDeclarationText(body);
      } catch {
        inForceDecl = null;
      }
    }
    return recordFrom(entry, r, { checkedAt, durationMs, inForceDecl, declOf, attempts, registryBase: registry.base });
  };
}

// A polite client for the public API of the official MCP Registry.
//
// * At most one request per second (minIntervalMs between request starts).
// * A User-Agent that names the site.
// * HTTP 429 stops the scan at once, whether or not its body can be read;
//   three failures in a row (5xx answers, network failures, bodies that break
//   off, stall or are too large) stop it too. A stopped client sends nothing more.
// * Redirects are not followed, bodies are read up to a size limit.

export const USER_AGENT = 'declaredlist.com-scanner/0.1 (+https://declaredlist.com; one pass a day, at most 1 request per second)';
export const LIST_PATH = '/v0/servers';
export const PAGE_LIMIT = 100;
export const MAX_LIST_PAGE_BYTES = 8 * 1024 * 1024;
export const LIST_TIMEOUT_MS = 120000;
export const GET_TIMEOUT_MS = 30000;

export class ScanStop extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScanStop';
  }
}

async function readCapped(res, maxBytes) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignored
      }
      throw Object.assign(new Error(`the answer is larger than ${maxBytes} bytes`), { tooLarge: true });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

// registry: { base, loopback } as the checker's registryBase() returns it.
export function makeRegistryClient({ registry, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minIntervalMs = 1000, retryDelaysMs = [5000, 20000], log = () => {} }) {
  const origin = new URL(registry.base).origin;
  let lastStart = 0;
  let stopped = null;
  let failuresInRow = 0;
  let requests = 0;

  async function throttle() {
    const wait = lastStart + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
  }

  function isRegistryUrl(url) {
    try {
      const u = new URL(url);
      return u.origin === origin;
    } catch {
      return false;
    }
  }

  // One GET. Returns { status, headers, body (Buffer) } like the checker's
  // hardened fetch, so the checker can use it for its registry read.
  async function get(url, { maxBytes = 262144, timeoutMs = GET_TIMEOUT_MS } = {}) {
    if (stopped) throw new ScanStop(stopped);
    if (!isRegistryUrl(url)) throw Object.assign(new Error('not a registry URL'), { refused: true });
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(registry.loopback && u.protocol === 'http:')) throw Object.assign(new Error('only https is used'), { refused: true });
    await throttle();
    requests++;
    let res;
    const failed = (why) => {
      failuresInRow++;
      if (failuresInRow >= 3 && !stopped) stopped = `three registry requests in a row failed (the last: ${why}); the scan stopped`;
    };
    try {
      res = await fetchImpl(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const why = e && e.name === 'TimeoutError' ? 'timed out' : e && e.cause && e.cause.code ? e.cause.code : 'network error';
      failed(why);
      throw new Error(`the registry request failed (${why})`);
    }
    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    // The status decides before the body is read, so a 429 or a 5xx whose body
    // cannot be read still stops or counts. Their bodies are not needed.
    const drop = () => {
      try {
        if (res.body) res.body.cancel().catch(() => {});
      } catch {
        // ignored
      }
    };
    if (res.status === 429) {
      stopped = 'the registry answered HTTP 429 (too many requests); the scan stopped';
      drop();
      return { status: res.status, headers, body: Buffer.alloc(0) };
    }
    if (res.status >= 500) {
      failed(`HTTP ${res.status}`);
      drop();
      return { status: res.status, headers, body: Buffer.alloc(0) };
    }
    let body;
    try {
      body = await readCapped(res, maxBytes);
    } catch (e) {
      // A body that breaks off, stalls past the time limit or is too large
      // counts as a failed request.
      const why = e && e.tooLarge ? `the answer is larger than ${maxBytes} bytes` : e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'the answer timed out' : 'the answer broke off';
      failed(why);
      throw Object.assign(new Error(`the registry request failed (${why})`), e && e.tooLarge ? { tooLarge: true } : {});
    }
    failuresInRow = 0;
    return { status: res.status, headers, body };
  }

  // One page of the list: { servers, nextCursor }. Retries a 5xx or a network
  // failure after a pause (at most retryDelaysMs.length times), stops on 429.
  // since: an ISO time; only listings published or changed since then.
  async function listPage(cursor, since = null) {
    const q = new URLSearchParams({ limit: String(PAGE_LIMIT), version: 'latest' });
    if (since) q.set('updated_since', since);
    if (cursor) q.set('cursor', cursor);
    const url = `${registry.base}${LIST_PATH}?${q}`;
    let lastError;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        log(`retrying the list page after ${retryDelaysMs[attempt - 1] / 1000} s (${lastError.message})`);
        await sleep(retryDelaysMs[attempt - 1]);
      }
      let r;
      try {
        r = await get(url, { maxBytes: MAX_LIST_PAGE_BYTES, timeoutMs: LIST_TIMEOUT_MS });
      } catch (e) {
        if (e instanceof ScanStop) throw e;
        lastError = e;
        if (stopped) throw new ScanStop(stopped);
        continue;
      }
      if (r.status === 429) throw new ScanStop(stopped);
      if (r.status >= 500) {
        lastError = new Error(`the registry answered HTTP ${r.status}`);
        if (stopped) throw new ScanStop(stopped);
        continue;
      }
      if (r.status !== 200) throw new ScanStop(`the registry list answered HTTP ${r.status}; the scan stopped`);
      let data;
      try {
        data = JSON.parse(r.body.toString('utf8'));
      } catch {
        throw new ScanStop('the registry list answer is not JSON; the scan stopped');
      }
      if (!data || typeof data !== 'object' || !Array.isArray(data.servers)) throw new ScanStop('the registry list answer has no "servers" array; the scan stopped');
      const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
      const next = typeof meta.nextCursor === 'string' && meta.nextCursor.length > 0 ? meta.nextCursor : null;
      if (next !== null && next === cursor) throw new ScanStop('the registry returned the same cursor again; the scan stopped');
      return { servers: data.servers, nextCursor: next };
    }
    throw new ScanStop(`the registry list could not be read after ${retryDelaysMs.length + 1} attempts (${lastError ? lastError.message : 'unknown'}); the scan stopped`);
  }

  return {
    get,
    listPage,
    isRegistryUrl,
    stoppedReason: () => stopped,
    requestCount: () => requests,
  };
}

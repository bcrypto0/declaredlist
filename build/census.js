// The census section of the site: one dated page of counts read from the
// Official MCP Registry, and a data file that holds exactly what the page
// shows. It is built only when build/census.config.json says "publish": true
// (or a build is asked for it with --census on); otherwise the site is built
// exactly as without it.
//
// The snapshot in data/census/ holds counts only: no listing, namespace,
// address or description from the rows behind them. Those rows are kept
// privately, outside every repository; the page gives their SHA-256 hashes.
// The snapshot is read only when its hash equals the one in the config, so a
// published figure cannot change without a new, dated snapshot.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { esc, httpsLink, localLink } from '../lib/html.js';
import { formatDate } from '../lib/text.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CENSUS_CONFIG_FILE = path.join(HERE, 'census.config.json');

// The site's own address for census requests: a role address at the site's
// domain, never a person's.
const ROLE_EMAIL_RE = /^census@declaredlist\.com$/;
const REL_RE = /^census\/[a-z0-9-]+\.json$/;

const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= 10_000_000;
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
const isTime = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

// Whether the config file turns the census on: true only when the file
// exists, parses and says "publish": true. A missing or unreadable file is the
// switch off, so the daily build of the site never depends on the census.
export function censusSwitchOn(file = CENSUS_CONFIG_FILE) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(cfg && cfg.publish === true);
  } catch {
    return false;
  }
}

// A census config, checked. Read only for a build that includes the census.
export function checkCensusConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || typeof cfg.publish !== 'boolean') throw new Error('census config: publish must be true or false');
  if (typeof cfg.snapshot !== 'string' || !REL_RE.test(cfg.snapshot)) throw new Error('census config: snapshot must be a file under data/census');
  if (typeof cfg.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(cfg.sha256)) throw new Error('census config: sha256 must be 64 hex digits');
  if (cfg.corrections !== undefined && (typeof cfg.corrections !== 'string' || !REL_RE.test(cfg.corrections))) throw new Error('census config: corrections must be a file under data/census');
  if (typeof cfg.correctionsEmail !== 'string' || !ROLE_EMAIL_RE.test(cfg.correctionsEmail)) throw new Error('census config: correctionsEmail must be the census address at declaredlist.com');
  // The page promises a private route for requests. It may go live only after
  // a test message to that address has reached a person.
  if (cfg.publish === true && !isDay(cfg.correctionsAddressTested)) throw new Error('census config: publish is true but correctionsAddressTested has no date; send a test message to the census address first');
  return cfg;
}

// The config of the census section, read from its file and checked.
export function readCensusConfig(file = CENSUS_CONFIG_FILE) {
  return checkCensusConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// The rules a snapshot must meet before any figure in it is shown.
export function censusProblem(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'is missing';
  if (s.schema !== 'declaredlist/census-1') return 'has an unknown schema';
  if (s.registry !== 'https://registry.modelcontextprotocol.io') return 'names another registry';
  if (!isTime(s.readStartedAt) || !isTime(s.readFinishedAt) || !isDay(s.madeOn)) return 'has no reading time';
  const R = s.registryCounts || {};
  for (const k of ['latestListings', 'active', 'deprecated', 'namespacesWithActiveListings', 'domainNamespaces', 'githubNamespaces']) if (!isCount(R[k])) return `has no count registryCounts.${k}`;
  if (R.active + R.deprecated !== R.latestListings) return 'has active and deprecated counts that do not add up';
  if (R.domainNamespaces + R.githubNamespaces !== R.namespacesWithActiveListings) return 'has namespace counts that do not add up';
  const W = s.words || {};
  for (const k of ['wordsCounted', 'listings', 'namespaces', 'perWordTotal']) if (!isCount(W[k])) return `has no count words.${k}`;
  if (!W.domain || !W.github || ![W.domain.listings, W.domain.namespaces, W.github.listings, W.github.namespaces].every(isCount)) return 'has no split by namespace kind';
  if (W.domain.listings + W.github.listings !== W.listings || W.domain.namespaces + W.github.namespaces !== W.namespaces) return 'has a split that does not add up';
  if (typeof W.sharePercentOfActive !== 'number' || Math.abs(W.sharePercentOfActive - Math.round((10000 * W.listings) / R.active) / 100) > 1e-9) return 'has a share that is not listings over active listings';
  const WORD = (w) => typeof w === 'string' && /^[a-z0-9]{2,40}$/.test(w);
  const F = W.fewerNamespaces || {};
  const MIN = W.minNamespacesForARow;
  if (!isCount(MIN) || MIN < 3) return 'has no smallest namespace count for a row of its own';
  if (![F.words, F.listings, F.namespaces].every(isCount) || (F.words > 0 && F.namespaces < MIN)) return 'has no row for the words under fewer namespaces';
  if (!Array.isArray(W.perWord) || W.perWord.length + F.words !== W.wordsCounted) return 'has a word table of the wrong length';
  let prev = '';
  let sum = F.listings;
  for (const r of W.perWord) {
    if (!r || !WORD(r.word) || r.word <= prev) return 'has a word table that is not lowercase words in order';
    if (!isCount(r.listings) || !isCount(r.namespaces) || r.namespaces > r.listings) return `has bad counts for one word`;
    // No row of its own may rest on fewer namespaces than the smallest shown.
    if (r.namespaces > 0 && r.namespaces < MIN) return 'has a word row under fewer namespaces than a row may show';
    prev = r.word;
    sum += r.listings;
  }
  if (sum !== W.perWordTotal) return 'has word rows that do not add up';
  const T = W.table || {};
  if (![T.wordsInTable, T.setAside, T.checkedAgainstCompanyPages, T.notChecked].every(isCount) || !isDay(T.checkedOn)) return 'has no word table facts';
  if (T.checkedAgainstCompanyPages + T.notChecked !== W.wordsCounted) return 'has word table checks that do not add up';
  for (const list of [T.leftOutAfterHandCheck, T.setAsideAsOpenNetworks]) if (!Array.isArray(list) || list.length < 1 || !list.every(WORD)) return 'has no list of words left out';
  if (T.wordsInTable - T.setAside - T.setAsideAsOpenNetworks.length - T.leftOutAfterHandCheck.length !== W.wordsCounted) return 'has a word count that does not follow from the table';
  for (const r of [...T.leftOutAfterHandCheck, ...T.setAsideAsOpenNetworks]) if (W.perWord.some((x) => x.word === r)) return 'counts a word it left out';
  const HW = W.handCheck || {};
  const hk = ['drawn', 'frameMatches', 'frameWords', 'ruleErrors', 'readingErrors', 'readInFullWords', 'readInFullNames', 'readInFullOtherMeaning', 'readInFullKeptWords', 'readInFullKeptNames', 'readInFullKeptCounted', 'readInFullKeptAlsoDrawn'];
  if (!hk.every((k) => isCount(HW[k])) || !isDay(HW.on)) return 'has no hand check of the word count';
  if (HW.readInFullKeptCounted > HW.readInFullKeptNames || HW.readInFullKeptNames + HW.readInFullOtherMeaning > HW.readInFullNames || HW.readInFullKeptAlsoDrawn > HW.drawn) return 'has a hand check that does not add up';
  const A = s.sharedAddresses || {};
  if (![A.addresses, A.listings, A.connectedByListingFields, A.otherAddresses].every(isCount) || !isDay(A.date)) return 'has no shared address counts';
  if (A.connectedByListingFields + A.otherAddresses !== A.addresses) return 'has shared address counts that do not add up';
  const D = s.sharedDescriptions || {};
  if (![D.groups, D.listings, D.connectedByListingFields, D.minCharacters].every(isCount) || !isDay(D.date)) return 'has no shared description counts';
  for (const h of [A.handCheck, D.handCheck]) if (!h || ![h.drawn, h.ruleErrors].every(isCount) || !isDay(h.on)) return 'has no hand check of a shared count';
  if (!isDay(R.date) || !isDay(W.date)) return 'has a count without a date';
  if (!Array.isArray(s.keptRecord) || s.keptRecord.length < 1) return 'has no kept record';
  for (const k of s.keptRecord) if (!k || typeof k.file !== 'string' || !/^[a-z0-9_]+\.json$/.test(k.file) || !/^[0-9a-f]{64}$/.test(k.sha256) || !isDay(k.date)) return 'has a kept record entry without a file, date or hash';
  return null;
}

// Dated corrections: [{ "date": "2026-11-23", "text": "..." }], oldest first.
// A note says what changed and when. It names neither the requester nor the
// namespace, so text with a slash, an @ or a dotted name (a namespace, a
// domain, an address) is refused; the site's own domain is the one exception.
const NAMING_RE = /[/@]|\b[a-z0-9-]+\.[a-z][a-z0-9.-]*/i;
export function correctionsProblem(c) {
  if (!Array.isArray(c)) return 'is not a list';
  for (const x of c) {
    if (!x || !isDay(x.date) || typeof x.text !== 'string' || x.text.length < 1 || x.text.length > 600) return 'has an entry without a date or text';
    if (NAMING_RE.test(x.text.replace(/\bdeclaredlist\.com\b/gi, ''))) return 'has an entry that may name a namespace, an address or a person';
  }
  return null;
}

// The snapshot and its corrections, read from dataDir and checked. Throws when
// the snapshot is missing, changed or malformed, so nothing is built from it.
export function loadCensus(dataDir, cfg) {
  const file = path.join(dataDir, ...cfg.snapshot.split('/'));
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    throw new Error(`census snapshot data/${cfg.snapshot} is missing; nothing was built`);
  }
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  if (hash !== cfg.sha256) throw new Error(`census snapshot data/${cfg.snapshot} does not have the sha256 in build/census.config.json; nothing was built`);
  const snap = JSON.parse(raw.toString('utf8'));
  const problem = censusProblem(snap);
  if (problem) throw new Error(`census snapshot ${problem}; nothing was built`);
  let corrections = [];
  if (cfg.corrections) {
    const cf = path.join(dataDir, ...cfg.corrections.split('/'));
    if (fs.existsSync(cf)) {
      corrections = JSON.parse(fs.readFileSync(cf, 'utf8'));
      const p = correctionsProblem(corrections);
      if (p) throw new Error(`census corrections ${p}; nothing was built`);
    }
  }
  return { snap, corrections };
}

const n = (v) => v.toLocaleString('en-US');
// The title with its date kept on one line: "Registry census, 20 November 2026".
const titleHtml = (t) => {
  const i = t.lastIndexOf(', ');
  return i > 0 ? `${esc(t.slice(0, i + 1))} <span class="d">${esc(t.slice(i + 2))}</span>` : esc(t);
};
const day = (d) => formatDate(`${d}T00:00:00Z`);
const hhmm = (iso) => new Date(Date.parse(iso)).toISOString().slice(11, 16);

// The public data file: what the page shows, and nothing more.
export function censusPublic(snap, corrections, pageUrl) {
  const W = snap.words;
  return {
    schema: snap.schema,
    page: pageUrl,
    title: snap.title,
    note: 'Counts from the Official MCP Registry as read on the dates shown. Declared is not affiliated with or endorsed by the Model Context Protocol project or its registry. The census counts names; no figure is a rating of any listing, namespace or company.',
    registry: snap.registry,
    read: { date: snap.registryCounts.date, from: hhmm(snap.readStartedAt), to: hhmm(snap.readFinishedAt), timeZone: 'UTC' },
    countedOn: snap.madeOn,
    registryCounts: snap.registryCounts,
    words: {
      date: W.date,
      wordsCounted: W.wordsCounted,
      listings: W.listings,
      sharePercentOfActive: W.sharePercentOfActive,
      namespaces: W.namespaces,
      domain: W.domain,
      github: W.github,
      perWordTotal: W.perWordTotal,
      table: W.table,
      handCheck: W.handCheck,
      minNamespacesForARow: W.minNamespacesForARow,
      perWord: W.perWord,
      fewerNamespaces: W.fewerNamespaces,
    },
    sharedAddresses: snap.sharedAddresses,
    sharedDescriptions: snap.sharedDescriptions,
    keptRecord: snap.keptRecord,
    corrections,
  };
}

// The census page. h holds the page helpers of build/core.js.
export function censusPage(snap, corrections, cfg, h) {
  const { layout, section, railed, contentsList, fact, hashHtml, issuesUrl, authorsListing } = h;
  const R = snap.registryCounts;
  const W = snap.words;
  const T = W.table;
  const HW = W.handCheck;
  const A = snap.sharedAddresses;
  const D = snap.sharedDescriptions;
  // The host rewrites e-mail addresses into a script-decoded form by default;
  // this site runs no script, so the address is fenced with the host's own
  // opt-out comments and stays plain text.
  const mail = esc(cfg.correctionsEmail);
  const timeSpan = (iso) => `<time class="tm" datetime="${esc(new Date(Date.parse(iso)).toISOString())}">${esc(hhmm(iso))}</time>`;
  const dated = (d) => `<p class="typed-line">Registry read on <time datetime="${esc(d)}">${esc(day(d))}</time></p>`;
  const handLine = (hc, unit, from = '') => `${esc(n(hc.drawn))} ${esc(unit)} drawn at random${from} and read on ${esc(day(hc.on))}: ${esc(n(hc.ruleErrors))} did not meet the rule`;
  const andList = (l) => (l.length === 1 ? l[0] : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
  const orList = (l) => (l.length === 1 ? l[0] : `${l.slice(0, -1).join(', ')} or ${l[l.length - 1]}`);
  const left = T.leftOutAfterHandCheck;
  const leftText = andList(left);
  const nets = T.setAsideAsOpenNetworks;
  const F = W.fewerNamespaces;

  const head = `<div class="row head hero census-head">
<div class="b hero-body">
<p class="tally"><span class="tally-num d4">${esc(n(R.active))}</span><span class="tally-cap">active listings read on ${esc(day(R.date))}</span></p>
<div class="hero-text">
<h1>${titleHtml(snap.title)}</h1>
<p class="lead">A dated count of what the Official MCP Registry showed: how many listings carry a product or company word in their name, and how many remote addresses and descriptions appear under more than one namespace.</p>
<p>The data comes from the Official MCP Registry (registry.modelcontextprotocol.io), read on ${esc(day(R.date))} between ${timeSpan(snap.readStartedAt)} and ${timeSpan(snap.readFinishedAt)} UTC. Declared is not affiliated with or endorsed by the Model Context Protocol project or its registry.</p>
<p>No figure here is a rating of any listing, namespace or company.</p>
</div>
</div>
<aside class="n" aria-label="Notes">
<p class="note"><span class="sc">The date</span>Each figure is the registry as read on the date shown. Listings are added, changed and removed every day, so a later reading may give different figures.</p>
</aside>
</div>`;

  const items = [];
  let no = 0;
  const add = (id, h2, inner, opts = {}) => {
    items.push([no, id, h2]);
    return section(no++, `<h2>${esc(h2)}</h2>\n${inner}`, { ...opts, id });
  };

  const registry = add(
    'registry',
    `The registry on ${day(R.date)}`,
    `<dl class="facts">
${fact('Registry read', `<time datetime="${esc(R.date)}">${esc(day(R.date))}</time>, ${timeSpan(snap.readStartedAt)} to ${timeSpan(snap.readFinishedAt)} UTC`)}${fact('Listings', `${esc(n(R.latestListings))} (the latest version of each listing name)`)}${fact('Active', esc(n(R.active)))}${fact('Deprecated', esc(n(R.deprecated)))}${fact('Namespaces with active listings', `${esc(n(R.namespacesWithActiveListings))}: ${esc(n(R.domainNamespaces))} domain namespaces and ${esc(n(R.githubNamespaces))} GitHub namespaces`)}</dl>
<p>A namespace is the part of a listing name before the slash. The census counts namespaces, not people or companies. One operator may use several namespaces, and one namespace may hold listings by several authors.</p>
<p>A domain namespace such as <code>com.example</code> means that, at publishing time, the registry checked that the publisher controlled that domain by DNS or HTTP. A GitHub namespace such as <code>io.github.example</code> means that the publisher signed in as that GitHub account. The census shows nothing more than that about either.</p>`,
  );

  const wordRows = W.perWord
    .map((r, i) => `<tr role="row"><td class="w" role="cell"><span class="no" aria-hidden="true">${i + 1}</span><code>${esc(r.word)}</code></td><td class="num" role="cell">${esc(n(r.listings))}</td><td class="num" role="cell">${esc(n(r.namespaces))}</td></tr>`)
    .join('\n');
  const words = add(
    'words',
    'Product and company words in listing names',
    `${dated(W.date)}
<p class="recital census-recital">On ${esc(day(W.date))}, ${esc(n(W.listings))} of the ${esc(n(R.active))} active listings (${esc(String(W.sharePercentOfActive))} percent) carry one of ${esc(n(W.wordsCounted))} product or company words as a whole word in the part of their name after the slash, under a namespace that our own word table does not list for that word.</p>
<p>These ${esc(n(W.listings))} listings sit under ${esc(n(W.namespaces))} namespaces: ${esc(n(W.domain.listings))} listings under ${esc(n(W.domain.namespaces))} domain namespaces and ${esc(n(W.github.listings))} listings under ${esc(n(W.github.namespaces))} GitHub namespaces.</p>
<dl class="facts">
${fact('Listings', esc(n(W.listings)))}${fact('Share of active listings', `${esc(String(W.sharePercentOfActive))} percent`)}${fact('Namespaces', esc(n(W.namespaces)))}${fact('Under domain namespaces', `${esc(n(W.domain.listings))} listings under ${esc(n(W.domain.namespaces))} namespaces`)}${fact('Under GitHub namespaces', `${esc(n(W.github.listings))} listings under ${esc(n(W.github.namespaces))} namespaces`)}${fact('Reading check', `${handLine(HW, 'matches', ` from the ${esc(n(HW.frameMatches))} matches of all ${esc(n(HW.frameWords))} words, before any word was left out,`)}, and in ${esc(n(HW.readingErrors))} the word meant something other than the product. The sample is small, so it gives no precise error rate.`)}${fact('Read in full', `${esc(n(HW.readInFullWords))} words were read in full on the same day (${esc(n(HW.readInFullNames))} names). In ${esc(n(HW.readInFullOtherMeaning))} names, all under ${esc(orList(left))}, the word meant something else, so those words were left out; ${esc(andList(nets))} were set aside as open networks. Under the other ${esc(n(HW.readInFullKeptWords))} words the word named the product in each of the ${esc(n(HW.readInFullKeptNames))} names read: ${esc(n(HW.readInFullKeptCounted))} of them are among the counted listings, and ${esc(n(HW.readInFullKeptAlsoDrawn))} of them ${HW.readInFullKeptAlsoDrawn === 1 ? 'is' : 'are'} also among the ${esc(n(HW.drawn))} drawn.`)}</dl>
<h3>What this count shows, and what it does not</h3>
<ul class="plain">
<li>Listing names that carry a product&#39;s name are common. In the matches we read, such a name described a connector to the product, data about it, or a tool that works with it.</li>
<li>The census counts names. It does not say whether any listing is connected to the company that owns the product name.</li>
<li>The word table is ours, not the registry&#39;s. For ${esc(n(T.checkedAgainstCompanyPages))} of its ${esc(n(W.wordsCounted))} words the namespaces it lists were reviewed against public sources on ${esc(day(T.checkedOn))}, some only in part; the other ${esc(n(T.notChecked))} were not reviewed. So a company may publish under a namespace the table leaves out.</li>
<li>A word with no listing under a namespace in our table does not show that the company has no server. Many companies run their server outside the registry.</li>
<li>Only whole words count: a name that joins the word to another word is not counted.</li>
</ul>
<h3 id="by-word">By word</h3>
<p class="muted">Each word, lowercase as matched, in alphabetical order, with the listings counted for it and the namespaces they sit under. Counts under ${esc(n(W.minNamespacesForARow))} namespaces are not shown word by word, so that no row points to a single namespace: the ${esc(n(F.words))} words whose listings sit under fewer than ${esc(n(W.minNamespacesForARow))} namespaces are counted together in the last row. A listing whose name carries two of the words is counted under each, so the rows add up to ${esc(n(W.perWordTotal))} listings, not ${esc(n(W.listings))}.</p>
<div class="words-wrap">
<table class="words" role="table">
<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader"><span class="no" aria-hidden="true">Row</span>Word</th><th scope="col" class="num" role="columnheader">Listings</th><th scope="col" class="num" role="columnheader">Namespaces</th></tr></thead>
<tbody role="rowgroup">
<tr class="day" role="row"><th colspan="3" scope="rowgroup" role="rowheader">Registry read on ${esc(day(W.date))}</th></tr>
${wordRows}${F.words ? `\n<tr class="fold" role="row"><td class="w" role="cell">Other words, each under fewer than ${esc(n(W.minNamespacesForARow))} namespaces (${esc(n(F.words))} words)</td><td class="num" role="cell">${esc(n(F.listings))}</td><td class="num" role="cell">${esc(n(F.namespaces))}</td></tr>` : ''}
</tbody>
<tfoot role="rowgroup"><tr role="row"><th scope="row" role="rowheader">All ${esc(n(W.wordsCounted))} words, each listing once</th><td class="num" role="cell">${esc(n(W.listings))}</td><td class="num" role="cell">${esc(n(W.namespaces))}</td></tr></tfoot>
</table>
</div>`,
  );

  const addresses = add(
    'addresses',
    'One remote address under two or more namespaces',
    `${dated(A.date)}
<p class="recital census-recital">${esc(n(A.addresses))} remote addresses are named by active listings under two or more namespaces (${esc(n(A.listings))} listings).</p>
<dl class="facts">
${fact('Addresses', esc(n(A.addresses)))}${fact('Listings', esc(n(A.listings)))}${fact("Addresses whose listings' fields connect the namespaces", esc(n(A.connectedByListingFields)))}${fact('Other addresses (the test reads two fields only; they may be connected too)', esc(n(A.otherAddresses)))}${fact('Reading check', `${handLine(A.handCheck, 'addresses')}.`)}</dl>
<p>For ${esc(n(A.connectedByListingFields))} of them, the listings&#39; own repository or website fields connect the namespaces. That test reads only those two fields, so the other ${esc(n(A.otherAddresses))} may be connected too. The registry allows several listings to name one address, and its documentation says not to infer ownership or endorsement from a shared address.</p>`,
  );

  const descriptions = add(
    'descriptions',
    'One description under two or more namespaces',
    `${dated(D.date)}
<p class="recital census-recital">On ${esc(day(D.date))}, ${esc(n(D.groups))} descriptions of ${esc(n(D.minCharacters))} or more characters appeared word for word under two or more namespaces (${esc(n(D.listings))} listings).</p>
<dl class="facts">
${fact('Descriptions', esc(n(D.groups)))}${fact('Listings', esc(n(D.listings)))}${fact("Descriptions whose listings' fields connect the namespaces", esc(n(D.connectedByListingFields)))}${fact('Reading check', `${handLine(D.handCheck, 'descriptions')}.`)}</dl>
<p>For ${esc(n(D.connectedByListingFields))} of them, the listings&#39; own repository or website fields connect the namespaces. The census does not show who wrote any text first. This count is from the reading of ${esc(day(D.date))}, because the reading of ${esc(day(R.date))} did not record descriptions.</p>`,
  );

  const unpublished = add(
    'not-published',
    'What is not published',
    `<p>We also compared names that differ by one character. The pairs we read were ordinary words, separate products, or names whose own listing text connects them, so those counts are not published.</p>
<p>This page gives counts only. It names nothing from the rows behind them: no listing, namespace, address or description.</p>`,
  );

  const kept = add(
    'kept-record',
    'The kept record',
    `<p>The full rows behind these counts are kept privately. Their SHA-256 hashes are given here so that the record of this date can be checked later.</p>
<p>If a namespace is left out on request, the kept file changes, and the hashes given here then belong to the file as it was read on this date; the Corrections list says when that happened.</p>
<dl class="facts">
${snap.keptRecord.map((k) => fact(`Rows of ${day(k.date)}`, `<code class="nw">${esc(k.file)}</code><br>${hashHtml(`sha256:${k.sha256}`, 80)}`)).join('')}</dl>`,
  );

  const method = add(
    'method',
    'Method',
    `<ul class="plain">
<li>The ${esc(day(R.date))} reading is a list of the latest version of every listing name, read through the registry&#39;s public API between ${timeSpan(snap.readStartedAt)} and ${timeSpan(snap.readFinishedAt)} UTC. It holds names, status, remote addresses and repository and website fields, not descriptions. The description count uses a complete reading made on ${esc(day(D.date))}.</li>
<li>Only active listings are counted; deprecated ones are left out. A share is a count divided by the active listings of the same reading.</li>
<li>Names and namespaces are compared lowercased. A GitHub namespace is one GitHub account.</li>
<li>Words: the part of a name after the slash is lowercased and split at every character that is not a letter or a digit. A listing counts for a word when the word is one of the pieces.</li>
<li>The word table has ${esc(n(T.wordsInTable))} words. ${esc(n(T.setAside))} were set aside before counting because they are also ordinary words or names of open source software. Of the others, ${esc(andList(nets))} were set aside after counting because they name open networks that no single company owns, and ${esc(leftText)} were left out after the reading check, because in some of the names we read the word carried another meaning, such as an id format or an ordinary word. That leaves ${esc(n(W.wordsCounted))} words.</li>
<li>For each word the table lists namespaces. A listing counts for the word only when its namespace is not one of them, or a subdomain of one (except where a company gives its customers subdomains of its domain).</li>
<li>Remote addresses are compared lowercased and without a trailing slash. Addresses with a template mark, a placeholder host such as example.com or localhost, or no host are set aside.</li>
<li>Descriptions are compared after lowercasing and collapsing white space.</li>
<li>Two namespaces are connected by the listings&#39; fields when their listings name the same repository owner or the same website host, or when a GitHub namespace is the owner of another listing&#39;s repository. The test does not prove common or separate ownership.</li>
<li>Reading check: rows were drawn at random with a fixed seed and read on ${esc(day(snap.madeOn))} by one reader, an AI model working for the authors, from the saved readings only. The figures are given with each count.</li>
<li>One reading per date: a listing added and removed between readings does not appear. The registry checks a domain when a listing is published, so a later change of the domain does not show here.</li>
</ul>`,
  );

  const correctionList = corrections.length
    ? `<ul class="plain">\n${corrections.map((c) => `<li>Corrected <time datetime="${esc(c.date)}">${esc(day(c.date))}</time>: ${esc(c.text)}</li>`).join('\n')}\n</ul>`
    : '<p class="muted">No correction has been made to this page.</p>';
  const requests = add(
    'corrections',
    'Corrections and requests',
    `<p>To correct a figure, or to have a namespace left out of any data we keep or release, write to <!--email_off--><a class="census-mail" href="mailto:${mail}">${mail}</a><!--/email_off--> with the listing name. Requests are read by a person, and corrections appear on this page with their date.</p>
<p>Counts for a past date stay as read; a namespace left out is removed from the kept rows, and a dated note says that one namespace was left out.</p>
<p>A request can also be made on the public ${httpsLink(issuesUrl, 'issues page of the site repository')}. To ask for a namespace to be left out without asking in public, use the address above.</p>
<p>This applies to the census. The register of declarations on the <a href="./">front page</a> lists what the registry serves and does not take listings in or out by request.</p>
<h3>Corrections</h3>
${correctionList}`,
  );

  const independence = add(
    'independence',
    'Independence and data',
    `<p>Declared is not affiliated with or endorsed by the Model Context Protocol project or its registry.</p>
<p>The authors of this site also publish the listing <code>${esc(authorsListing)}</code> and the add on declaration format. The census counts do not depend on whether a listing carries a declaration.</p>
<p>Every figure on this page is in ${localLink('census.json', 'census.json')}, with its date.</p>`,
  );

  const rail = `<nav aria-label="Contents">
<p class="sc rail-h">Contents</p>
${contentsList(items)}
</nav>
<div class="rail-notes">
<p class="note"><span class="sc">Counted on</span>${esc(day(snap.madeOn))}, from the readings of ${esc(day(D.date))} and ${esc(day(R.date))}.</p>
</div>`;

  const body = `${head}\n${railed(rail, [registry, words, addresses, descriptions, unpublished, kept, method, requests, independence].join('\n'))}`;
  return layout({
    title: `${snap.title} | Declared`,
    description: `Dated counts from the Official MCP Registry as read on ${day(R.date)}: product and company words in listing names, and remote addresses and descriptions under more than one namespace.`,
    body,
    canonical: 'census',
    current: 'census',
    styles: ['census.css'],
  });
}

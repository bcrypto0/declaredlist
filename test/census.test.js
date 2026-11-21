// The census section: off in the committed config, so the built site is the
// site as it was; on, one dated page of counts and a data file that holds
// what the page shows and nothing more. The snapshot is the real one in
// data/census, read only when its hash equals the one in the config.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildSite, CSP } from '../build/core.js';
import { readCensusConfig, checkCensusConfig, censusProblem, correctionsProblem } from '../build/census.js';
import { tempDir, removeTempDirs, plainLatest, writeData } from '../testlib/fixture.js';
import { BANNED, DASHES, visibleText } from '../testlib/wording.js';

after(removeTempDirs);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = readCensusConfig();
const SNAPSHOT_FILE = path.join(ROOT, 'data', ...CONFIG.snapshot.split('/'));
const SNAP = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// A data folder with the plain fixture and, unless told otherwise, a copy of
// the real census snapshot.
function dataDir({ snapshot = true, edit = null } = {}) {
  const root = tempDir();
  const data = path.join(root, 'data');
  writeData(data, plainLatest());
  if (snapshot) {
    const target = path.join(data, ...CONFIG.snapshot.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let bytes = fs.readFileSync(SNAPSHOT_FILE);
    if (edit) bytes = Buffer.from(edit(bytes.toString('utf8')), 'utf8');
    fs.writeFileSync(target, bytes);
  }
  return { root, data };
}

function build(census, opts = {}) {
  const { root, data } = dataDir(opts);
  const dist = path.join(root, 'dist');
  const r = buildSite({ dataDir: data, outDir: dist, census, ...(opts.censusConfigFile ? { censusConfigFile: opts.censusConfigFile } : {}) });
  const files = new Map(walk(dist).map((f) => [path.relative(dist, f).split(path.sep).join('/'), fs.readFileSync(f)]));
  return { r, dist, data, files, read: (f) => fs.readFileSync(path.join(dist, f), 'utf8') };
}

const mainOf = (html) => (html.match(/<main id="main">([\s\S]*)<\/main>/) || [])[1] || '';
const textOf = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

// Words and phrases no census sentence may carry: verdicts, framing the
// reviewers cut, and claims about who a namespace belongs to.
const CENSUS_BANNED = [
  /\bfake/i, /impersonat/i, /\bscam/i, /squat/i, /malicious/i, /suspicious/i, /unofficial/i, /counterfeit/i, /copycat/i, /fraud/i,
  /\bunsafe\b/i, /\brisky?\b/i, /deceptive/i, /look-?alike/i, /\bcopied\b/i, /\bcopy\b/i, /third[ -]party/i, /\bbrand/i,
  /\bown listings?\b(?! text)/i, /\bpublishers\b/i, /different publisher/i, /\bofficial listing/i, /\breal one\b/i, /\bgenuine\b/i,
  /protection/i, /certificate transparency/i, /\btop\b/i, /\branking\b/i, /\branked\b/i, /percent of the registry|% of the registry/i,
  /\bpresence\b/i, /\bwrongdoing\b/i, /\babuse\b/i, /\bmisleading\b/i, /\bviolat/i, /\binfring/i, /\bsign a declaration\b/i,
];
// A deny list kept outside this repository, next to the census working files.
// Where it is absent (a clone of the public repository) that check is skipped.
// It is not kept here as hashes: hashing every name the registry serves would
// undo them.
const DENY_FILE = path.join(ROOT, '..', 'census', '2026-11-21', 'private_names.json');
const PRIVATE_NAMES = fs.existsSync(DENY_FILE) ? JSON.parse(fs.readFileSync(DENY_FILE, 'utf8')).names : null;
// Every country name, so that none is added to a census file.
const COUNTRIES = 'Afghanistan Albania Algeria Andorra Angola Argentina Armenia Australia Austria Azerbaijan Bahamas Bahrain Bangladesh Barbados Belarus Belgium Belize Benin Bhutan Bolivia Bosnia Botswana Brazil Brunei Bulgaria Burkina Burundi Cambodia Cameroon Canada Chad Chile China Colombia Comoros Congo Croatia Cuba Cyprus Czechia Denmark Djibouti Dominica Ecuador Egypt Salvador Eritrea Estonia Eswatini Ethiopia Fiji Finland France Gabon Gambia Georgia Germany Ghana Greece Grenada Guatemala Guinea Guyana Haiti Honduras Hungary Iceland India Indonesia Iran Iraq Ireland Israel Italy Jamaica Japan Jordan Kazakhstan Kenya Kiribati Korea Kosovo Kuwait Kyrgyzstan Laos Latvia Lebanon Lesotho Liberia Libya Liechtenstein Lithuania Luxembourg Madagascar Malawi Malaysia Maldives Mali Malta Mauritania Mauritius Mexico Micronesia Moldova Monaco Mongolia Montenegro Morocco Mozambique Myanmar Namibia Nauru Nepal Netherlands Zealand Nicaragua Niger Nigeria Norway Oman Pakistan Palau Palestine Panama Papua Paraguay Peru Philippines Poland Portugal Qatar Romania Russia Rwanda Samoa Marino Saudi Senegal Serbia Seychelles Sierra Singapore Slovakia Slovenia Solomon Somalia Spain Lanka Sudan Suriname Sweden Switzerland Syria Taiwan Tajikistan Tanzania Thailand Togo Tonga Trinidad Tunisia Turkey Turkmenistan Tuvalu Uganda Ukraine Emirates Kingdom Uruguay Uzbekistan Vanuatu Vatican Venezuela Vietnam Yemen Zambia Zimbabwe'.split(' ');
// The capitalised words the census page may use. Any other (a person's name,
// a company, a place) fails the test until someone decides it belongs.
const CAPITALISED = new Set([
  'A', 'Active', 'Addresses', 'All', 'An', 'API', 'Corrected', 'Corrections', 'Contents', 'Counted', 'DNS', 'Declared', 'Deprecated', 'Descriptions', 'Each',
  'Every', 'For', 'GitHub', 'HTTP', 'Hand', 'I', 'II', 'III', 'IV', 'IX', 'In', 'Independence', 'Listing', 'Listings', 'MCP', 'Many', 'Method', 'Model', 'Context',
  'Protocol', 'Namespaces', 'No', 'Nobody', 'Not', 'November', 'Of', 'Official', 'On', 'One', 'Only', 'Product', 'Registry', 'Remote', 'Requests', 'Row', 'Rows',
  'SHA', 'Share', 'Skip', 'That', 'The', 'Their', 'These', 'This', 'To', 'Two', 'UTC', 'Under', 'V', 'VI', 'VII', 'VIII', 'We', 'What', 'Word', 'Words', 'Date',
  'Kept', 'Record', 'List', 'Publishers', 'Census', 'Data', 'Corrections', 'It', 'Hashes', 'Apart', 'And', 'By', 'Namespace', 'Only', 'A',
  'AI', 'Other', 'If', 'Counts', 'Reading', 'Read', 'Names', 'So',
]);

// Every number in the snapshot, as the page writes it.
function snapshotNumbers(v, out = new Set()) {
  if (typeof v === 'number') out.add(Number.isInteger(v) ? v.toLocaleString('en-US') : String(v));
  else if (Array.isArray(v)) v.forEach((x) => snapshotNumbers(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => snapshotNumbers(x, out));
  return out;
}
// The numbers a reader sees in the main text of the census page: the row
// numbers in the margin, the hashes, dates, times, file names and the name of
// the hash function taken out.
function pageNumbers(html) {
  const t = textOf(
    mainOf(html)
      .replace(/<span class="no" aria-hidden="true">\d+<\/span>/g, ' ')
      .replace(/<code class="hash">[\s\S]*?<\/code>/g, ' '),
  )
    .replace(/\b\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/g, ' ')
    .replace(/\b\d{2}:\d{2}\b/g, ' ')
    .replace(/SHA-256/g, ' ')
    .replace(/rows_\d+[a-z]+\.json/g, ' ');
  return [...t.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,$/, ''));
}

// The committed config as it stood before the owner said yes: no test date,
// switch off. Tests of the refusal and of the switch start from these.
const { correctionsAddressTested: TESTED_ON, ...UNTESTED } = CONFIG;
const OFF = { ...UNTESTED, publish: false };

test('the committed config is published with a dated address test, and the snapshot is the one the config names', () => {
  assert.equal(CONFIG.publish, true, 'the owner said yes on 2026-11-21');
  assert.match(String(TESTED_ON), /^\d{4}-\d{2}-\d{2}$/, 'the day a test message reached the census address');
  assert.equal(checkCensusConfig(CONFIG).publish, true);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(SNAPSHOT_FILE)).digest('hex');
  assert.equal(hash, CONFIG.sha256, 'the dated snapshot is unchanged');
  assert.equal(censusProblem(SNAP), null);
  assert.equal(CONFIG.correctionsEmail, 'census@declaredlist.com');
});

test('publish true is refused until a test message to the census address has arrived', () => {
  assert.throws(() => checkCensusConfig({ ...UNTESTED, publish: true }), /correctionsAddressTested/);
  assert.throws(() => checkCensusConfig({ ...UNTESTED, publish: true, correctionsAddressTested: 'soon' }), /correctionsAddressTested/);
  assert.equal(checkCensusConfig({ ...UNTESTED, publish: true, correctionsAddressTested: '2026-11-25' }).publish, true);
  // The same refusal from a config file, as the deployed build reads it.
  const { root, data } = dataDir();
  const file = path.join(root, 'census.config.json');
  fs.writeFileSync(file, JSON.stringify({ ...UNTESTED, publish: true }));
  assert.throws(() => buildSite({ dataDir: data, outDir: path.join(root, 'dist'), censusConfigFile: file }), /correctionsAddressTested/);
  fs.writeFileSync(file, JSON.stringify({ ...UNTESTED, publish: true, correctionsAddressTested: '2026-11-25' }));
  assert.equal(buildSite({ dataDir: data, outDir: path.join(root, 'dist'), censusConfigFile: file }).census, true);
});

test('the snapshot holds counts only: no listing, namespace, address or description', () => {
  const strings = [];
  const keys = [];
  const walkV = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walkV);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.push(k), walkV(x));
  };
  walkV(SNAP);
  for (const s of strings) {
    const ok = s === SNAP.registry || s === SNAP.schema || s === SNAP.title || /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(s) || /^[0-9a-f]{64}$/.test(s) || /^[a-z0-9]{2,40}$/.test(s) || /^rows_\d+[a-z]+\.json$/.test(s);
    assert.ok(ok, `unexpected string in the snapshot: ${s}`);
  }
  for (const k of keys) assert.doesNotMatch(k, /^(name|names|rows|description|remote|remotes|namespace|listing|host|url)$/i, `unexpected key ${k}`);
  // The measures the reviewers cut have no field.
  const text = JSON.stringify(SNAP);
  for (const cut of ['oneCharacter', 'lookalike', 'pairs', 'presence', 'underTable', 'notTiedCovered']) assert.ok(!text.toLowerCase().includes(cut.toLowerCase()), cut);
  // The headline split is the one for the 76 words.
  // The headline: 74 words, after ethereum and solana were set aside as open networks.
  assert.deepEqual([SNAP.words.listings, SNAP.words.namespaces, SNAP.words.domain.listings, SNAP.words.domain.namespaces, SNAP.words.github.listings, SNAP.words.github.namespaces], [1204, 630, 408, 195, 796, 435]);
  assert.equal(SNAP.words.sharePercentOfActive, 1.8);
  assert.equal(SNAP.words.wordsCounted, 74);
  assert.deepEqual(SNAP.words.table.setAsideAsOpenNetworks, ['ethereum', 'solana']);
  // No word row of its own rests on 1 or 2 namespaces.
  assert.equal(SNAP.words.minNamespacesForARow, 3);
  for (const r of SNAP.words.perWord) assert.ok(r.namespaces === 0 || r.namespaces >= 3, `${r.word} has a row under ${r.namespaces} namespaces`);
  assert.ok(SNAP.words.fewerNamespaces.namespaces >= 3);
  assert.equal(SNAP.registryCounts.active, 66937);
  for (const w of [...SNAP.words.table.leftOutAfterHandCheck, ...SNAP.words.table.setAsideAsOpenNetworks]) assert.ok(!SNAP.words.perWord.some((r) => r.word === w), `${w} is left out of the table`);
});

test('switch off: the build is the site without a census, byte for byte, whatever data/census holds', () => {
  // The switch read from a config file that says off, as the deployed build reads it.
  const offDir = tempDir();
  const offFile = path.join(offDir, 'off.json');
  fs.writeFileSync(offFile, JSON.stringify(OFF));
  const off = build(undefined, { censusConfigFile: offFile });
  const offFalse = build(false);
  const none = build(undefined, { snapshot: false, censusConfigFile: offFile });
  const broken = build(false, { edit: (t) => t.replace('1204', '1205') });
  // With no config file, or one that does not parse, the census is off and
  // the build does not fail: the daily build never depends on the census.
  const cfgDir = tempDir();
  const missingCfg = build(undefined, { censusConfigFile: path.join(cfgDir, 'none.json') });
  fs.writeFileSync(path.join(cfgDir, 'bad.json'), '{ "publish": tru');
  const badCfg = build(undefined, { censusConfigFile: path.join(cfgDir, 'bad.json') });
  fs.writeFileSync(path.join(cfgDir, 'partial.json'), '{ "publish": false }');
  const partialCfg = build(undefined, { censusConfigFile: path.join(cfgDir, 'partial.json') });
  assert.equal(off.r.census, false);
  for (const other of [offFalse, none, broken, missingCfg, badCfg, partialCfg]) {
    assert.deepEqual([...other.files.keys()].sort(), [...off.files.keys()].sort());
    for (const [f, bytes] of off.files) assert.ok(bytes.equals(other.files.get(f)), `${f} differs`);
  }
  for (const f of ['census.html', 'census.json', 'census.css']) assert.ok(!off.files.has(f), `${f} is not built`);
  for (const [f, bytes] of off.files) {
    if (f.endsWith('.woff2')) continue;
    assert.doesNotMatch(bytes.toString('utf8'), /census/i, `${f} mentions the census`);
  }
  const sitemap = off.read('sitemap.xml');
  assert.equal([...sitemap.matchAll(/<loc>/g)].length, 4);
});

test('switch on: the census page, its data file and one navigation entry appear; the other pages change only by that entry', () => {
  const off = build(false);
  const on = build(true);
  assert.equal(on.r.census, true);
  assert.equal(on.r.pages, off.r.pages + 1);
  for (const f of ['census.html', 'census.json', 'census.css']) assert.ok(on.files.has(f), f);
  const added = new Set(['census.html', 'census.json', 'census.css']);
  assert.deepEqual([...on.files.keys()].filter((f) => !added.has(f)).sort(), [...off.files.keys()].sort());
  for (const [f, bytes] of off.files) {
    const a = bytes.toString('utf8');
    const b = on.files.get(f).toString('utf8');
    if (f.endsWith('.html')) {
      const entry = b.match(/\n<a href="(?:\/|\.\.\/)?census\.html"(?: aria-current="page")?>Census<\/a>/);
      assert.ok(entry, `${f} has the navigation entry`);
      assert.equal(b.replace(entry[0], ''), a, `${f} differs only by the navigation entry`);
      assert.ok(b.indexOf('>Publishers</a>') < b.indexOf('>Census</a>') && b.indexOf('>Census</a>') < b.indexOf('>Data</a>'));
    } else if (f === 'sitemap.xml') {
      assert.equal(b.replace(/<url><loc>https:\/\/declaredlist\.com\/census<\/loc><lastmod>[\d-]+<\/lastmod><\/url>\n/, ''), a);
    } else if (!f.endsWith('.woff2')) {
      assert.equal(b, a, `${f} is unchanged`);
    }
  }
  assert.match(on.read('census.html'), /<a href="census\.html" aria-current="page">Census<\/a>/);
  // A changed snapshot is refused and the previous site stays.
  const before = on.read('index.html');
  fs.writeFileSync(path.join(on.data, ...CONFIG.snapshot.split('/')), fs.readFileSync(SNAPSHOT_FILE, 'utf8').replace('"listings": 1204', '"listings": 1203'));
  assert.throws(() => buildSite({ dataDir: on.data, outDir: on.dist, census: true }), /does not have the sha256/);
  assert.equal(on.read('index.html'), before);
  const missing = dataDir({ snapshot: false });
  assert.throws(() => buildSite({ dataDir: missing.data, outDir: path.join(missing.root, 'dist'), census: true }), /is missing/);
});

test('every count on the census page is the snapshot, with its date', () => {
  const { read } = build(true);
  const html = read('census.html');
  const allowed = snapshotNumbers(SNAP);
  const nums = pageNumbers(html);
  assert.ok(nums.length > 150);
  for (const x of nums) assert.ok(allowed.has(x), `the page shows ${x}, which the snapshot does not hold`);
  const t = textOf(mainOf(html));
  const W = SNAP.words;
  const R = SNAP.registryCounts;
  assert.match(t, /On 20 November 2026, 1,204 of the 66,937 active listings \(1\.8 percent\) carry one of 74 product or company words as a whole word in the part of their name after the slash, under a namespace that our own word table does not list for that word\./);
  assert.match(t, /These 1,204 listings sit under 630 namespaces: 408 listings under 195 domain namespaces and 796 listings under 435 GitHub namespaces\./);
  assert.doesNotMatch(t, /GitHub accounts/, 'one name for the unit');
  assert.match(t, /Names and namespaces are compared lowercased\. A GitHub namespace is one GitHub account\./);
  assert.match(t, /131 remote addresses are named by active listings under two or more namespaces \(281 listings\)\. /);
  assert.match(t, /For 74 of them, the listings' own repository or website fields connect the namespaces\. That test reads only those two fields, so the other 57 may be connected too\./);
  assert.match(t, /On 18 November 2026, 512 descriptions of 40 or more characters appeared word for word under two or more namespaces \(1,224 listings\)\. /);
  assert.match(t, /For 170 of them, the listings' own repository or website fields connect the namespaces\./);
  // The fact labels name the unit they count.
  assert.match(t, /Addresses whose listings' fields connect the namespaces 74 Other addresses \(the test reads two fields only; they may be connected too\) 57 /);
  assert.match(t, /Descriptions whose listings' fields connect the namespaces 170 /);
  assert.doesNotMatch(t, /Namespaces connected by|Not connected by/);
  assert.match(t, /read on 20 November 2026 between 02:08 and 02:28 UTC/);
  assert.match(t, new RegExp(`Listings ${R.latestListings.toLocaleString('en-US')} \\(the latest version of each listing name\\)`));
  // Each count block carries the date of its reading.
  assert.equal((html.match(/<p class="typed-line">Registry read on <time datetime="2026-11-20">20 November 2026<\/time><\/p>/g) || []).length, 2);
  assert.equal((html.match(/<p class="typed-line">Registry read on <time datetime="2026-11-18">18 November 2026<\/time><\/p>/g) || []).length, 1);
  // The table of words: the snapshot rows, in order, three columns, then one
  // row for the words under fewer than 3 namespaces.
  const rows = [...html.matchAll(/<tr role="row"><td class="w" role="cell"><span class="no" aria-hidden="true">(\d+)<\/span><code>([a-z0-9]+)<\/code><\/td><td class="num" role="cell">([\d,]+)<\/td><td class="num" role="cell">([\d,]+)<\/td><\/tr>/g)];
  assert.deepEqual(rows.map((m) => ({ word: m[2], listings: Number(m[3].replace(/,/g, '')), namespaces: Number(m[4].replace(/,/g, '')) })), W.perWord);
  assert.deepEqual(rows.map((m) => Number(m[1])), W.perWord.map((_, i) => i + 1));
  assert.deepEqual(W.perWord.map((r) => r.word), [...W.perWord.map((r) => r.word)].sort(), 'alphabetical, not by count');
  assert.match(html, /<th scope="col" role="columnheader"><span class="no" aria-hidden="true">Row<\/span>Word<\/th><th scope="col" class="num" role="columnheader">Listings<\/th><th scope="col" class="num" role="columnheader">Namespaces<\/th>/);
  assert.match(html, /<tr class="fold" role="row"><td class="w" role="cell">Other words, each under fewer than 3 namespaces \(12 words\)<\/td><td class="num" role="cell">24<\/td><td class="num" role="cell">16<\/td><\/tr>\n<\/tbody>/);
  assert.match(t, /Counts under 3 namespaces are not shown word by word, so that no row points to a single namespace/);
  assert.match(html, /<th scope="row" role="rowheader">All 74 words, each listing once<\/th><td class="num" role="cell">1,204<\/td><td class="num" role="cell">630<\/td>/);
  // The reading check is shown with each count it checked, and says who read.
  assert.match(t, /10 matches drawn at random from the 1,306 matches of all 79 words, before any word was left out, and read on 21 November 2026: 0 did not meet the rule, and in 0 the word meant something other than the product\./);
  assert.match(t, /14 words were read in full on the same day \(166 names\)\. In 10 names, all under confluence, intercom or snowflake, the word meant something else, so those words were left out; ethereum and solana were set aside as open networks\. Under the other 9 words the word named the product in each of the 100 names read: 99 of them are among the counted listings, and 1 of them is also among the 10 drawn\./);
  assert.match(t, /read on 21 November 2026 by one reader, an AI model working for the authors, from the saved readings only\./);
  assert.doesNotMatch(t, /by hand|one person|Hand check/);
  assert.match(t, /For 28 of its 74 words the namespaces it lists were reviewed against public sources on 18 November 2026, some only in part; the other 46 were not reviewed\./);
  assert.match(t, /6 addresses drawn at random and read on 21 November 2026: 0 did not meet the rule\./);
  assert.match(t, /4 descriptions drawn at random and read on 21 November 2026: 0 did not meet the rule\./);
  // The kept record: both hashes, whole when copied.
  for (const k of SNAP.keptRecord) assert.ok(textOf(html).replace(/\s+/g, '').includes(`sha256:${k.sha256}`), k.file);
  // Every table carries its roles for screen readers.
  for (const m of mainOf(html).matchAll(/<(table|thead|tbody|tfoot|tr|th|td)\b[^>]*>/g)) assert.match(m[0], / role="(table|rowgroup|row|columnheader|rowheader|cell)"/, m[0]);
});

test('the census data file holds exactly what the page shows', () => {
  const { read } = build(true);
  const html = read('census.html');
  const data = JSON.parse(read('census.json'));
  assert.equal(data.page, 'https://declaredlist.com/census');
  const shown = new Set(pageNumbers(html));
  for (const x of snapshotNumbers(data)) assert.ok(shown.has(x), `census.json holds ${x}, which the page does not show`);
  for (const x of shown) assert.ok(snapshotNumbers(data).has(x), `the page shows ${x}, which census.json does not hold`);
  const text = textOf(html);
  const flat = text.replace(/\s+/g, '');
  const strings = [];
  const walkV = (v, k = '') => {
    if (typeof v === 'string') strings.push([k, v]);
    else if (Array.isArray(v)) v.forEach((x) => walkV(x, k));
    else if (v && typeof v === 'object') for (const [kk, x] of Object.entries(v)) walkV(x, kk);
  };
  walkV(data);
  for (const [k, v] of strings) {
    if (['schema', 'page', 'note', 'registry'].includes(k)) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(`${v}T00:00:00Z`);
      assert.ok(text.includes(`${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${d.getUTCFullYear()}`), `date ${v} is on the page`);
    } else assert.ok(text.includes(v) || flat.includes(v), `${k}: ${v} is on the page`);
  }
  assert.ok(text.includes('registry.modelcontextprotocol.io'));
  assert.deepEqual(Object.keys(data).sort(), ['corrections', 'countedOn', 'keptRecord', 'note', 'page', 'read', 'registry', 'registryCounts', 'schema', 'sharedAddresses', 'sharedDescriptions', 'title', 'words'].sort());
  assert.deepEqual(data.corrections, []);
});

test('no census sentence carries a verdict, a cut measure, a personal name, an e-mail address or a country', () => {
  const { read, files } = build(true);
  const html = read('census.html');
  const main = mainOf(html);
  const text = visibleText(main);
  const json = read('census.json');
  for (const t of [text, JSON.parse(json).note, read('census.css')]) {
    for (const w of BANNED) assert.doesNotMatch(t, w, String(w));
    assert.doesNotMatch(t, DASHES, 'a dash used as punctuation');
  }
  for (const w of CENSUS_BANNED) {
    assert.doesNotMatch(text, w, String(w));
    assert.doesNotMatch(JSON.parse(json).note, w, String(w));
  }
  if (PRIVATE_NAMES) {
    assert.ok(PRIVATE_NAMES.length > 20);
    for (const [f, bytes] of files) {
      if (f.endsWith('.woff2')) continue;
      const s = bytes.toString('utf8').toLowerCase();
      for (const n of PRIVATE_NAMES) assert.ok(!s.includes(n.toLowerCase()), `${f} holds a name from the deny list`);
    }
  }
  // E-mail addresses: the site's own census address and nothing else.
  for (const t of [html, json]) {
    for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) assert.equal(m[0], 'census@declaredlist.com');
  }
  // Countries: none, in the page or the data file.
  for (const c of COUNTRIES) {
    assert.doesNotMatch(text, new RegExp(`\\b${c}\\b`), c);
    assert.doesNotMatch(json, new RegExp(`\\b${c}\\b`), c);
  }
  // Capitalised words: only those the page is known to need, so no name of a
  // person, company or place is added without a test change.
  const caps = new Set([...textOf(main).matchAll(/\b[A-Z][A-Za-z]*\b/g)].map((m) => m[0]));
  for (const c of caps) assert.ok(CAPITALISED.has(c), `capitalised word on the census page: ${c}`);
  // Listing names: only the example namespaces and the authors' own listing.
  for (const m of textOf(main).matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[A-Za-z0-9._-]+)?/g)) {
    assert.ok(['com.example', 'io.github.example', 'com.rtlpdf/arabic-pdf', 'registry.modelcontextprotocol.io', 'example.com', 'census.json', 'declaredlist.com', 'rows_20nov.json', 'rows_18nov.json'].includes(m[0]) || /^\d/.test(m[0]) || /^census@/.test(m[0]), `name on the census page: ${m[0]}`);
  }
  // The page states what it is and is not.
  const t = textOf(main);
  assert.match(t, /Declared is not affiliated with or endorsed by the Model Context Protocol project or its registry\./);
  assert.match(t, /The authors of this site also publish the listing com\.rtlpdf\/arabic-pdf and the add on declaration format\. The census counts do not depend on whether a listing carries a declaration\./);
  assert.match(t, /No figure here is a rating of any listing, namespace or company\./);
  assert.match(t, /Each figure is the registry as read on the date shown\. Listings are added, changed and removed every day, so a later reading may give different figures\./);
  assert.match(t, /We also compared names that differ by one character\. .* so those counts are not published\./);
  assert.match(t, /To correct a figure, or to have a namespace left out of any data we keep or release, write to census@declaredlist\.com with the listing name\. Requests are read by a person, and corrections appear on this page with their date\./);
  assert.match(html, /<a class="census-mail" href="mailto:census@declaredlist\.com">census@declaredlist\.com<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/bcrypto0\/declaredlist\/issues" rel="noopener noreferrer nofollow"/);
  assert.match(t, /The full rows behind these counts are kept privately\./);
  assert.match(t, /If a namespace is left out on request, the kept file changes, and the hashes given here then belong to the file as it was read on this date; the Corrections list says when that happened\./);
  assert.match(t, /Counts for a past date stay as read; a namespace left out is removed from the kept rows, and a dated note says that one namespace was left out\./);
  assert.match(t, /does not show that the company has no server/);
  // The heads name no company: the h1, the section heads and the column heads.
  for (const m of html.matchAll(/<h[123][^>]*>([\s\S]*?)<\/h[123]>|<th[^>]*>([\s\S]*?)<\/th>/g)) {
    const head = textOf(m[1] || m[2]);
    for (const r of SNAP.words.perWord) assert.doesNotMatch(head, new RegExp(`\\b${r.word}\\b`, 'i'), `${r.word} in a heading`);
  }
});

test('the census page keeps the security policy: no script, no outside request, the same policy as every page', () => {
  const { read, files } = build(true);
  const html = read('census.html');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
  assert.equal(meta[1], CSP);
  // The host turns a bare address into a script-decoded link; fenced, it stays text.
  assert.match(html, /<!--email_off--><a class="census-mail" href="mailto:census@declaredlist.com">census@declaredlist.com</a><!--/email_off-->/);
  assert.match(read('_headers'), /Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; font-src 'self'; frame-ancestors 'none'/);
  for (const [f, bytes] of files) {
    if (!f.endsWith('.html')) continue;
    const s = bytes.toString('utf8');
    assert.doesNotMatch(s, /<(script|img|iframe|object|embed|form|style)\b/i, f);
    assert.doesNotMatch(s, /\son[a-z]+\s*=/i, f);
    assert.doesNotMatch(s, /\sstyle\s*=/i, f);
    for (const m of s.matchAll(/<link rel="(?:stylesheet|icon)" href="([^"]*)"/g)) assert.doesNotMatch(m[1], /^https?:|^\/\//, `${f} loads ${m[1]}`);
  }
  for (const m of html.matchAll(/\shref="([^"]*)"/g)) {
    const h = m[1];
    const ok = h === '#main' || /^#[a-z][a-z0-9-]*$/.test(h) || /^https:\/\/(github\.com\/bcrypto0\/|declaredlist\.com\/)/.test(h) || /^[A-Za-z0-9._\/-]+$/.test(h) || h === './' || h === 'mailto:census@declaredlist.com';
    assert.ok(ok, `unexpected href ${h}`);
  }
  assert.match(html, /<link rel="stylesheet" href="style\.css">\n<link rel="stylesheet" href="census\.css">/);
  const css = read('census.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.doesNotMatch(css, /@import|url\(|https?:/i, 'the census stylesheet loads nothing');
  // No colour marks a count: the census stylesheet uses the site's tokens only.
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb|hsl|green|red\b|orange/i);
  // Dark and print follow from the site's stylesheet tokens.
  assert.match(css, /@media print/);
});

test('corrections, when there are any, are listed with their dates', () => {
  const { root, data } = dataDir();
  fs.writeFileSync(path.join(data, ...CONFIG.corrections.split('/')), JSON.stringify([{ date: '2026-11-23', text: 'One namespace left out of the kept data on request.' }]));
  const dist = path.join(root, 'dist');
  buildSite({ dataDir: data, outDir: dist, census: true });
  const html = fs.readFileSync(path.join(dist, 'census.html'), 'utf8');
  assert.match(html, /<li>Corrected <time datetime="2026-11-23">23 November 2026<\/time>: One namespace left out of the kept data on request\.<\/li>/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dist, 'census.json'), 'utf8')).corrections, [{ date: '2026-11-23', text: 'One namespace left out of the kept data on request.' }]);
  fs.writeFileSync(path.join(data, ...CONFIG.corrections.split('/')), JSON.stringify([{ text: 'no date' }]));
  assert.throws(() => buildSite({ dataDir: data, outDir: dist, census: true }), /corrections/);
  // A note names neither the requester nor the namespace.
  for (const text of ['Left out io.github.someone on request.', 'Left out com.example at the request of a@b.example.', 'Row for example.org removed.', 'Removed owner/repo.']) {
    assert.match(correctionsProblem([{ date: '2026-11-23', text }]), /may name/, text);
    fs.writeFileSync(path.join(data, ...CONFIG.corrections.split('/')), JSON.stringify([{ date: '2026-11-23', text }]));
    assert.throws(() => buildSite({ dataDir: data, outDir: dist, census: true }), /may name/);
  }
  for (const text of ['One namespace left out of the kept data on request.', 'The share was 1.8 percent. See declaredlist.com for the method.']) assert.equal(correctionsProblem([{ date: '2026-11-23', text }]), null, text);
});

test('a malformed snapshot is refused before any figure is shown', () => {
  const bad = (f) => {
    const s = structuredClone(SNAP);
    f(s);
    return censusProblem(s);
  };
  assert.match(bad((s) => (s.words.listings = 1250)), /split|share/);
  assert.match(bad((s) => (s.words.perWord[0].word = 'Adobe')), /lowercase words in order/);
  assert.match(bad((s) => s.words.perWord.reverse()), /in order/);
  assert.match(bad((s) => (s.words.perWord[1].listings += 1)), /add up/);
  assert.match(bad((s) => (s.registryCounts.active += 1)), /add up/);
  assert.match(bad((s) => (s.keptRecord[0].sha256 = 'x')), /kept record/);
  assert.match(bad((s) => (s.sharedAddresses.otherAddresses = 1)), /add up/);
  assert.match(bad((s) => s.words.perWord.push({ word: 'snowflake', listings: 3, namespaces: 3 })), /wrong length|in order|left out/);
  assert.match(bad((s) => s.words.perWord.splice(5, 0, { word: s.words.perWord[4].word + 'a', listings: 2, namespaces: 2 })), /wrong length|fewer namespaces/);
  assert.match(bad((s) => (s.words.perWord.find((r) => r.namespaces >= 3).namespaces = 2)), /fewer namespaces/);
  assert.match(bad((s) => (s.words.minNamespacesForARow = 1)), /smallest/);
  assert.match(bad((s) => (s.words.fewerNamespaces.listings += 1)), /add up/);
  assert.match(bad((s) => (s.words.handCheck.readInFullKeptCounted = 101)), /add up/);
  assert.equal(censusProblem(null), 'is missing');
});

// The layout of the register and of the listing pages: rows grouped under the
// day they were checked, the chain of statements a check reached, hashes that
// copy as one value, and the typefaces served from the site itself. The names
// here are example names for the tests only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSite, hashHtml, addressHtml, commandHtml, byTimeNewestFirst, CSP } from '../build/core.js';
import { tempDir, removeTempDirs, plainLatest, writeData } from '../testlib/fixture.js';
import { BANNED, DASHES, visibleText } from '../testlib/wording.js';

after(removeTempDirs);

function build(latest) {
  const root = tempDir();
  const data = path.join(root, 'data');
  const dist = path.join(root, 'dist');
  writeData(data, latest);
  buildSite({ dataDir: data, outDir: dist });
  return { dist, read: (f) => fs.readFileSync(path.join(dist, f), 'utf8') };
}

const H = (c) => `sha256:${c.repeat(64).slice(0, 64)}`;

// Twelve listings checked on three days, in several states.
function manyLatest() {
  const base = plainLatest();
  const r0 = base.listings[0];
  const at = (day, hh) => `2026-11-${day}T${hh}:15:00.000Z`;
  const rows = [
    ['com.example/weather', 'verified_newer_declaration', at(20, '06')],
    ['com.example/maps', 'verified', at(20, '06')],
    ['org.example/translate', 'invalid_signature', at(20, '07')],
    ['net.example/search', 'tools_hash_mismatch', at(20, '07')],
    ['io.example/notes', 'declaration_unreachable', at(20, '07')],
    ['dev.example/calendar', 'key_not_found', at(19, '22')],
    ['com.example/calendar', 'expired', at(19, '22')],
    ['com.example/payments', 'listing_mismatch', at(19, '23')],
    ['app.example/files', 'pointer_refused', at(18, '05')],
    ['com.example/mail', 'registry_unreachable', at(18, '05')],
    ['org.example/docs', 'no_declaration', at(18, '05')],
    ['com.example/tickets', 'verified', at(18, '06')],
  ];
  return { ...base, listings: rows.map(([name, state, checkedAt]) => ({ ...r0, name, state, checkedAt, title: null, description: null })) };
}

test('the register groups rows under the day they were checked, newest day first', () => {
  const { read } = build(manyLatest());
  const index = read('index.html');
  const days = [...index.matchAll(/<tr class="day" role="row"><th colspan="3" scope="rowgroup" role="rowheader">([^<]*)<\/th><\/tr>/g)].map((m) => m[1]);
  assert.deepEqual(days, ['Checked on 20 November 2026', 'Checked on 19 November 2026', 'Checked on 18 November 2026']);
  assert.equal((index.match(/<tbody role="rowgroup">/g) || []).length, 3, 'one row group per day');
  assert.equal((index.match(/<tr role="row"><td class="name"/g) || []).length, 12);
  // Within a day, names in order; the row numbers count the rows as shown,
  // under a head that says so (they name no entry).
  assert.match(index, /<span class="no" aria-hidden="true">Row<\/span>Listing/);
  const names = [...index.matchAll(/<td class="name" data-label="Listing" role="cell"><span class="no" aria-hidden="true">(\d+)<\/span><a href="listing\/([^"]+)\.html">/g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(names.map((x) => x[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(names.slice(0, 5).map((x) => x[1]), ['com.example__maps', 'com.example__weather', 'io.example__notes', 'net.example__search', 'org.example__translate']);
  assert.match(index, /<span class="tally-num d2">12<\/span><span class="tally-cap">listings shown below<\/span>/);
  assert.doesNotMatch(index, /class="blank"/, 'no blank lines under a long register');
  const text = visibleText(index);
  for (const w of BANNED) assert.doesNotMatch(text, w);
  assert.doesNotMatch(text, DASHES);
});

test('a register of one listing has one day, a singular count and blank lines under it', () => {
  const { read } = build(plainLatest());
  const index = read('index.html');
  assert.equal((index.match(/<tr class="day"/g) || []).length, 1);
  assert.match(index, /<span class="tally-num d1">1<\/span><span class="tally-cap">listing shown below<\/span>/);
  assert.match(index, /<div class="blank" aria-hidden="true"><\/div>/);
  assert.equal((index.match(/<h1>/g) || []).length, 1, 'one h1');
});

test('the chain shows the statements a check reached, each joined to the next', () => {
  const base = plainLatest();
  const r0 = base.listings[0];
  const listings = [
    // A newer declaration in force: listing, named, in force, key, remote.
    { ...r0, name: 'com.example/newer', declarationNamed: { url: r0.pointer.url, hash: H('a1'), format: 'addon-declaration/0.1', state: 'valid' }, pointer: { ...r0.pointer, hash: H('a1') } },
    // The named declaration is the one in force: a shorter chain.
    { ...r0, name: 'com.example/named', state: 'verified', pointer: { ...r0.pointer, hash: H('a1') }, inForce: { ...r0.inForce, source: 'pointer', url: r0.pointer.url, hash: H('a1') }, declarationNamed: { url: r0.pointer.url, hash: H('a1'), format: 'addon-declaration/0.2', state: 'valid' } },
    // The pointer address served another file: the checker records that
    // file's hash before it stops, and that file is not the named declaration.
    { ...r0, name: 'com.example/other', state: 'declaration_not_the_named_one', pointer: { ...r0.pointer, hash: H('b2') }, declarationNamed: { url: r0.pointer.url, hash: H('cc'), format: 'addon-declaration/0.2', state: null }, inForce: null, declaration: null, keyId: null, keySource: null, tools: { check: 'not_run' }, toolSetDigest: null },
    // The check stopped before the declaration was read.
    { ...r0, name: 'com.example/stopped', state: 'declaration_unreachable', declarationNamed: null, inForce: null, declaration: null, keyId: null, keySource: null, tools: { check: 'not_run' }, toolSetDigest: null },
    // No listing was read.
    { ...r0, name: 'com.example/unread', state: 'registry_unreachable', pointer: null, declarationNamed: null, inForce: null, declaration: null, keyId: null, keySource: null, tools: { check: 'not_run' }, toolSetDigest: null },
  ];
  const { read } = build({ ...base, listings });
  const heads = (page) => [...page.matchAll(/<li class="stmt">\n<p class="stmt-no" aria-hidden="true">\d+<\/p>\n<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);
  const joins = (page) => [...page.matchAll(/<p class="join">([^<]*)<\/p>/g)].map((m) => m[1]);

  const newer = read('listing/com.example__newer.html');
  assert.deepEqual(heads(newer), ['The listing, as the registry served it', 'The declaration the listing names', 'The declaration in force', 'The key', 'The remote and its tool list']);
  assert.deepEqual(joins(newer), ['names, by its hash,', 'is followed, under the same key, by', 'names as its key', 'and the same declaration names the remote']);
  assert.match(newer, /<dt>Read from<\/dt><dd><code>versions\/1\.0\.0\.json<\/code><\/dd>/);
  assert.doesNotMatch(newer, /<h2>What was compared<\/h2>[\s\S]*<dl class="facts">\n<dt>Declaration pointer/, 'the flat list is gone');

  const named = read('listing/com.example__named.html');
  assert.deepEqual(heads(named), ['The listing, as the registry served it', 'The declaration the listing names, in force', 'The key', 'The remote and its tool list']);
  assert.deepEqual(joins(named), ['names, by its hash,', 'names as its key', 'and the same declaration names the remote']);
  // The head says the named declaration is in force; no row repeats it, and no
  // row names whose dates these are.
  assert.doesNotMatch(named, /<dt>Declaration in force<\/dt>|<dt>Dates, key and remotes of<\/dt>/);
  assert.doesNotMatch(newer, /<dt>Dates, key and remotes of<\/dt>/);

  const other = read('listing/com.example__other.html');
  assert.deepEqual(heads(other), ['The listing, as the registry served it']);
  assert.deepEqual(joins(other), []);
  assert.doesNotMatch(other, /The declaration the listing names/);
  // The served file is shown with the result facts, by what it is.
  assert.match(other, /<dt>File served at the pointer address<\/dt>/);
  assert.match(other, /<dt>Hash of the file served there<\/dt><dd><code class="hash"><span class="pre">sha256:<\/span><wbr><span class="g">cccccccc<\/span>/);

  const stopped = read('listing/com.example__stopped.html');
  assert.deepEqual(heads(stopped), ['The listing, as the registry served it']);
  assert.deepEqual(joins(stopped), []);
  // Facts the chain does not reach stay with the result.
  assert.match(stopped, /<dt>Tool list<\/dt><dd>check <code>not_run<\/code><\/dd>/);

  const unread = read('listing/com.example__unread.html');
  assert.deepEqual(heads(unread), []);
  assert.match(unread, /Nothing was compared: no listing was read in this check\./);
  // No line about reading the chain from the top when there is no chain.
  assert.doesNotMatch(unread, /class="chain-sub"/);
  assert.match(newer, /class="chain-sub"/);

  for (const page of [newer, named, other, stopped, unread]) {
    const text = visibleText(page);
    for (const w of BANNED) assert.doesNotMatch(text, w);
    assert.doesNotMatch(text, DASHES);
  }
});

test('hashes are set in groups of eight and copy as one value', () => {
  const hex = 'b2e0e69dd371a6ae776b09b459acefb1625e3584ce47f8f341b3b0f15c1ebb24';
  const h = hashHtml(`sha256:${hex}`);
  assert.equal((h.match(/<span class="g">/g) || []).length, 8);
  // The text of the element, as a copy gives it: the value unchanged.
  assert.equal(h.replace(/<[^>]+>/g, ''), `sha256:${hex}`);
  assert.doesNotMatch(h, /[\u200B-\u200D\u2060\uFEFF\u00AD]/, 'no invisible character added');
  const b64 = 'sha256-+q4/BoqWmGGjGJw7VgeYkxe99dw6scmRsiGkGhwP8n8=';
  assert.equal(hashHtml(b64).replace(/<[^>]+>/g, '').replace(/&#61;/g, '='), b64);
  // Anything else is shown as it is, escaped.
  assert.equal(hashHtml('sha256:<x>'), '<code>sha256:&lt;x&gt;</code>');
  assert.equal(hashHtml(null), '');
});

test('the typefaces are served from the site under their licences, and no state has a colour', () => {
  const { dist, read } = build(plainLatest());
  const css = read('style.css');
  const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 4);
  for (const u of urls) {
    assert.match(u, /^fonts\/[A-Za-z0-9-]+\.woff2$/, 'fonts load from the site only');
    assert.ok(fs.existsSync(path.join(dist, u)), u);
  }
  for (const lic of ['LibreCaslonText-OFL.txt', 'LibreCaslonDisplay-OFL.txt', 'DMMono-OFL.txt']) {
    assert.match(fs.readFileSync(path.join(dist, 'fonts', lic), 'utf8'), /SIL Open Font License, Version 1\.1/);
  }
  assert.doesNotMatch(css, /@import|https?:\/\//, 'no request to another domain');
  assert.doesNotMatch(css, /Courier/);
  assert.match(CSP, /font-src 'self'/);
  // No selector names a state: the site gives no verdicts.
  for (const st of ['verified', 'invalid', 'mismatch', 'expired', 'unreachable', 'not_found']) assert.doesNotMatch(css, new RegExp(`[.#\\[][^{}]*${st}[^{}]*\\{`), st);
  // Every face declared is one the pages use: no weight ships for nothing.
  assert.doesNotMatch(css, /font-weight: 500/);
  assert.equal(fs.readdirSync(path.join(dist, 'fonts')).filter((f) => f.endsWith('.woff2')).length, urls.length);
  // The tab icon is served from the site and linked from every page.
  assert.match(read('favicon.svg'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(read('favicon.svg'), /<text|<image|href=/, 'drawn outlines only, nothing loaded');
  for (const f of ['index.html', 'method.html', '404.html', 'listing/com.example__weather.html']) assert.match(read(f), /<link rel="icon" href="(\.\.\/|\/)?favicon\.svg" type="image\/svg\+xml">/, f);
});

const textOf = (html) => html.replace(/<[^>]+>/g, '');

test('addresses and commands break only at their own break points and copy unchanged', () => {
  const u = 'https://rtlpdf.com/.well-known/addon-declaration/com.rtlpdf/arabic-pdf/by-hash/b2e0e69dd371a6ae776b09b459acefb1625e3584ce47f8f341b3b0f15c1ebb24.json';
  const h = addressHtml(u);
  assert.equal(textOf(h), u, 'a copy gives the address as written');
  assert.doesNotMatch(h, /[\u200b-\u200d\u2060\ufeff\u00ad]/);
  const pieces = [...h.matchAll(/<span class="u">([^<]*)<\/span>/g)].map((m) => m[1]);
  // Each piece stays whole: the scheme with the host, every path segment, and
  // the hash in groups of eight with the extension on the last group.
  assert.deepEqual(pieces.slice(0, 7), ['https://rtlpdf.com/', '.well-known/', 'addon-declaration/', 'com.rtlpdf/', 'arabic-pdf/', 'by-hash/', 'b2e0e69d']);
  assert.equal(pieces[pieces.length - 1], '5c1ebb24.json');
  assert.ok(pieces.every((p) => [...p].length <= 32), 'no piece longer than a line holds');
  // A long host breaks after its dots, not inside a word.
  assert.deepEqual([...addressHtml('https://registry.modelcontextprotocol.io/v0.1/x').matchAll(/<span class="u">([^<]*)<\/span>/g)].map((m) => m[1]), ['https://registry.', 'modelcontextprotocol.', 'io/', 'v0.1/', 'x']);
  // Commands: one line each, every argument whole, nothing added.
  const cmd = 'node ../addon-declaration/bin/addon-declare.js sign unsigned.json --key-env MCP_PRIVATE_KEY --out declaration.json';
  const c = commandHtml(`git clone https://github.com/x/y\n${cmd}`);
  assert.equal(textOf(c), `git clone https://github.com/x/y\n${cmd}`);
  assert.equal((c.match(/<span class="ln">/g) || []).length, 2);
  assert.match(c, /<span class="arg">--key-env<\/span> <span class="arg">MCP_PRIVATE_KEY<\/span>/);
  assert.doesNotMatch(c, /https:\/<wbr>/, 'no break inside the scheme');
});

test('earlier results are listed newest first by time, whatever the history file names', () => {
  const base = plainLatest();
  const r0 = { ...base.listings[0], checkedAt: '2026-11-20T15:22:00.000Z' };
  const root = tempDir();
  const data = path.join(root, 'data');
  const dist = path.join(root, 'dist');
  writeData(data, { ...base, listings: [r0] });
  fs.mkdirSync(path.join(data, 'history'));
  const snap = (checkedAt, version) => JSON.stringify({ listings: [{ name: r0.name, version, state: 'verified', checkedAt }] });
  // The day file holds the later scan of 19 November; the timestamped file
  // sorts after it by name and holds the earlier one.
  fs.writeFileSync(path.join(data, 'history', '2026-11-19.json'), snap('2026-11-19T16:43:00.000Z', '1.0.2'));
  fs.writeFileSync(path.join(data, 'history', '2026-11-19T145711Z.json'), snap('2026-11-19T14:57:11.000Z', '1.0.1'));
  fs.writeFileSync(path.join(data, 'history', '2026-11-20.json'), snap('2026-11-20T11:57:00.000Z', '1.0.3'));
  buildSite({ dataDir: data, outDir: dist });
  const page = fs.readFileSync(path.join(dist, 'listing', 'com.example__weather.html'), 'utf8');
  const versions = [...page.split('<h2>Earlier results</h2>')[1].matchAll(/<td data-label="Version" role="cell"><code[^>]*>([^<]*)<\/code>/g)].map((m) => m[1]);
  assert.deepEqual(versions, ['1.0.3', '1.0.2', '1.0.1']);
  assert.deepEqual(byTimeNewestFirst([{ checkedAt: 'x' }, { checkedAt: '2026-01-01T00:00:00Z' }]).map((r) => r.checkedAt), ['2026-01-01T00:00:00Z', 'x']);
});

test('publisher text in a right to left script takes its direction from the text', () => {
  const base = plainLatest();
  const r0 = { ...base.listings[0], title: '\u0646\u0633\u062e\u0629 \u0639\u0631\u0628\u064a\u0629 \u0645\u0646 \u0627\u0644\u0623\u062f\u0627\u0629', description: '\u0623\u062f\u0627\u0629 \u0644\u0625\u0646\u0634\u0627\u0621 \u0645\u0644\u0641\u0627\u062a PDF \u0639\u0631\u0628\u064a\u0629 \u0639\u0644\u0649 rtlpdf.com' };
  const { read } = build({ ...base, listings: [r0] });
  const page = read('listing/com.example__weather.html');
  assert.match(page, /<p class="entry-title" dir="auto">\u0646\u0633\u062e\u0629 \u0639\u0631\u0628\u064a\u0629 \u0645\u0646 \u0627\u0644\u0623\u062f\u0627\u0629<\/p>/);
  assert.match(page, /<blockquote class="pubtext"><p dir="auto">\u0623\u062f\u0627\u0629/);
  assert.match(read('index.html'), /<span class="e-title" dir="auto">\u0646\u0633\u062e\u0629 \u0639\u0631\u0628\u064a\u0629 \u0645\u0646 \u0627\u0644\u0623\u062f\u0627\u0629<\/span>/);
  const css = read('style.css');
  assert.match(css, /:is\(\.entry-title, \.e-title, \.pubtext p\):dir\(rtl\) \{ font-style: normal; \}/);
});

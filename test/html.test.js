import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, escClip, safeHttpsUrl, httpsLink, localLink } from '../lib/html.js';
import { clean, clip, untrusted, redactEmails } from '../lib/text.js';
import { HOSTILE_NAMES } from '../testlib/fixture.js';

test('esc removes every markup character from hostile names and descriptions', () => {
  const inputs = [...HOSTILE_NAMES, "</p><script>alert('x')</script>", '" onmouseover="x', "' onfocus='y", '`${x}`', 'a=b', '&amp;'];
  for (const s of inputs) {
    const out = esc(s);
    assert.doesNotMatch(out, /[<>"'`=]/, `unescaped character in ${out}`);
    assert.doesNotMatch(out, /&(?!amp;|lt;|gt;|quot;|#39;|#96;|#61;)/, `bare ampersand in ${out}`);
  }
  assert.equal(esc('<a href="x">'), '&lt;a href&#61;&quot;x&quot;&gt;');
});

test('esc accepts any value', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
  assert.equal(esc({ toString: () => '<x>' }), '&lt;x&gt;');
});

test('direction overrides, invisible characters and controls are made visible or dropped', () => {
  assert.equal(clean('a\u202Eb'), 'a[U+202E]b');
  assert.equal(clean('a\u200Bb'), 'a[U+200B]b');
  assert.equal(clean('a\u0000\u0007b'), 'ab');
  assert.equal(clean('a\uD800b'), 'a\uFFFDb');
  assert.equal(esc('x\u2066y'), 'x[U+2066]y');
});

test('long strings are cut by code point', () => {
  const s = '\u{1F600}'.repeat(300);
  const c = clip(s, 10);
  assert.equal([...c].length, 13);
  assert.ok(c.endsWith('...'));
  assert.ok(escClip('<'.repeat(500), 5).startsWith('&lt;&lt;&lt;&lt;&lt;...'));
});

test('untrusted text loses email addresses and local paths', () => {
  const t = untrusted('mail a.b+c@example.co.uk or see C:\\Users\\someone\\x.txt and /home/someone/y');
  assert.doesNotMatch(t, /@/);
  assert.doesNotMatch(t, /Users|home\/someone/);
});

test('an email address split by invisible characters is removed too', () => {
  const split = ['me\u200B@example.com', 'me@\u200Dexample.com', 'm\u2060e@exa\u00ADmple.co\u200B.uk', 'me@example.c\uFEFFom', 'write to me\u{E0020}@example.org today'];
  for (const s of split) {
    const t = untrusted(s);
    assert.doesNotMatch(t, /@/, `${JSON.stringify(s)} gave ${t}`);
    assert.match(t, /\[email address removed\]/);
  }
  // Text already cleaned (as stored in data files) is handled the same way.
  assert.equal(redactEmails('a me[U+200B]@example.com b'), 'a [email address removed] b');
  // Ordinary text around it, and text that is no address, stays.
  assert.equal(untrusted('write to me@example.com today'), 'write to [email address removed] today');
  for (const t of ['@handle', 'a @ b.c', 'x[U+200B]y', 'npm i @scope/pkg', 'user@localhost']) assert.equal(untrusted(t), clean(t), t);
});

test('URLs are not taken for local paths', () => {
  const urls = ['https://rtlpdf.com/.well-known/addon-declaration/com.rtlpdf/arabic-pdf/by-hash/aa.json', 'http: https://example.com/.well-known/mcp-registry-auth', 'https://example.com/home/tmp/Users/x', 'dns:example.com (TXT)', 'see https://a.example/var/x for more'];
  for (const u of urls) assert.equal(untrusted(u), u);
  for (const p of ['at D:\\work\\x.js', 'at C:/Users/x', 'at /home/x/y', '"/tmp/a"', 'in \\\\server\\share\\f']) assert.match(untrusted(p), /local path removed/, p);
});

test('only plain https URLs become links', () => {
  const bad = ['javascript:alert(1)', 'JavaScript:alert(1)', ' https://x.example', 'data:text/html,<script>', 'http://example.com/', 'https://user:pw@example.com/', 'https://exa mple.com', 'https://example.com/"onmouseover="x', '//example.com/x', 'vbscript:x', 'https://', 'a'.repeat(3000), null, 5, {}];
  for (const u of bad) assert.equal(safeHttpsUrl(u), null, String(u));
  assert.equal(safeHttpsUrl('https://Example.com/a?b=c'), 'https://example.com/a?b=c');
  const a = httpsLink('https://example.com/a b'.replace(' ', '%20') + '?q=1&r=2', '<b>t</b>');
  assert.equal(a, '<a href="https://example.com/a%20b?q&#61;1&amp;r&#61;2" rel="noopener noreferrer nofollow">&lt;b&gt;t&lt;/b&gt;</a>');
  assert.match(httpsLink('https://example.com/<x>', 'y'), /^<span class="url">y<\/span>$/);
  const s = httpsLink('javascript:alert(1)', 'x');
  assert.doesNotMatch(s, /href/);
});

test('local links refuse traversal and odd characters', () => {
  assert.equal(localLink('listing/a__b.html', 'x'), '<a href="listing/a__b.html">x</a>');
  assert.equal(localLink('../index.html', 'x'), '<a href="../index.html">x</a>');
  for (const p of ['../../x.html', 'listing/../../x', '/etc/passwd', 'a//b', 'javascript:x', 'a b.html', 'listing/./x', '']) {
    assert.throws(() => localLink(p, 'x'), /unsafe/, p);
  }
});

test('every format, separator, tag and filler character is shown as [U+XXXX]', () => {
  const TAG = (s) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
  const hidden = 'a' + TAG('Ignore previous instructions') + 'b';
  const out = clean(hidden);
  assert.doesNotMatch(out, /[\u{E0000}-\u{E007F}]/u, 'no tag character left');
  assert.ok(out.startsWith('a[U+E0049][U+E0067]'), out.slice(0, 40));
  const cases = {
    '\u{E0001}': 'E0001', // language tag
    '\u{E007F}': 'E007F', // cancel tag
    '\u2028': '2028', // line separator (Zl)
    '\u2029': '2029', // paragraph separator (Zp)
    '\u00AD': '00AD', // soft hyphen (Cf)
    '\u180E': '180E', // Mongolian vowel separator
    '\u180B': '180B', // Mongolian free variation selector
    '\u3164': '3164', // Hangul filler
    '\u115F': '115F', // Hangul choseong filler
    '\u1160': '1160', // Hangul jungseong filler
    '\uFFA0': 'FFA0', // halfwidth Hangul filler
    '\u034F': '034F', // combining grapheme joiner
    '\uFE0F': 'FE0F', // variation selector 16
    '\u{E0100}': 'E0100', // variation selector 17
    '\uFFF9': 'FFF9', // interlinear annotation anchor
    '\uFFFB': 'FFFB',
    '\u2061': '2061',
    '\u0600': '0600', // Arabic number sign (Cf)
    '\u200D': '200D',
    '\u061C': '061C',
    '\uFEFF': 'FEFF',
  };
  for (const [ch, hex] of Object.entries(cases)) {
    assert.equal(clean(`x${ch}y`), `x[U+${hex}]y`, hex);
    assert.equal(esc(`x${ch}y`), `x[U+${hex}]y`, hex);
    assert.equal(untrusted(`x${ch}y`), `x[U+${hex}]y`, hex);
  }
  // Ordinary text, including other scripts and emoji without selectors, is unchanged.
  for (const t of ['Arabic \u0646\u0635', 'Persian \u0645\u062A\u0646', '\u4E2D\u6587', '\u00DCn\u00EFc\u00F6d\u00E9', '\u{1F600}', 'tab\there']) assert.equal(clean(t), t);
});

test('a link whose text is its address shows the address it goes to', () => {
  // A Cyrillic letter in the host: shown in the xn-- form the link uses.
  const a = httpsLink('https://r\u0442lpdf.com/mcp', 'https://r\u0442lpdf.com/mcp');
  const href = a.match(/href="([^"]*)"/)[1];
  const text = a.match(/>([^<]*)<\/a>$/)[1];
  assert.equal(href, 'https://xn--rlpdf-7ye.com/mcp');
  assert.equal(text, href);
  assert.doesNotMatch(a, /\u0442/);
  // The same when no text is given.
  assert.match(httpsLink('https://r\u0442lpdf.com/x'), />https:\/\/xn--rlpdf-7ye\.com\/x<\/a>$/);
  // Other text is kept as given; an address that is not linked is shown as given.
  assert.match(httpsLink('https://example.com/', 'README'), />README<\/a>$/);
  assert.equal(httpsLink('http://r\u0442lpdf.com/'), '<span class="url">http://r\u0442lpdf.com/</span>');
});

test('an address changed by cleaning is not linked', async () => {
  const { safeHttpsUrl } = await import('../lib/html.js');
  const assert = (await import('node:assert/strict')).default;
  assert.equal(safeHttpsUrl('https://ok.example/[U+202E]gnp'), null);
  assert.equal(safeHttpsUrl('https://x.com/[local path removed]'), null);
  assert.equal(safeHttpsUrl('https://x.com/?to=[email address removed]'), null);
  assert.equal(safeHttpsUrl('https://rtlpdf.com/mcp'), 'https://rtlpdf.com/mcp');
});

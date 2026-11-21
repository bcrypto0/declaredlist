// Static site generator for declaredlist.com. Reads data/ and writes dist/.
// Every string from data/ came from the registry, a publisher's site or a
// server, so every one is escaped (esc) and cut short; outside links are
// accepted only as plain https URLs (httpsLink). Pages carry no script, no
// external request and no cookie.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, escClip, httpsLink, localLink, localLinkHtml, safeHttpsUrl } from '../lib/html.js';
import { formatDate, formatDateTime, isoDay, clip, redactEmails, scrubPaths } from '../lib/text.js';
import { stateSentence, stateLabel, toolsSentence, knownState } from '../lib/states.js';
import { assignFileBases, isSafeFileBase } from '../lib/names.js';
import { readJsonIfExists } from '../lib/fsutil.js';
import { CHECKER_SOURCE, CHECKER_ISSUES } from '../lib/checker.js';
import { latestProblem } from '../lib/validate.js';
import { CENSUS_CONFIG_FILE, censusSwitchOn, checkCensusConfig, readCensusConfig, loadCensus, censusPage, censusPublic } from './census.js';

export const SITE_URL = 'https://declaredlist.com';
// The public repository of this site (code, data and tests) and its issues page.
export const SITE_SOURCE = 'https://github.com/bcrypto0/declaredlist';
export const SITE_ISSUES = `${SITE_SOURCE}/issues`;
// The Content Security Policy of every page: in a meta element, and in the
// _headers file Cloudflare Pages reads, which adds frame-ancestors (a meta
// element cannot carry it). The fonts are served from the site itself
// (build/fonts, see build/fonts/FONTS.md).
export const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; font-src 'self'";
// The pages.dev addresses of the Pages project (production alias and preview
// deployments) serve the same pages as declaredlist.com; they are kept out of
// search results.
export const HEADERS = `/*
  Content-Security-Policy: ${CSP}; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY

https://:project.pages.dev/*
  X-Robots-Tag: noindex

https://:version.:project.pages.dev/*
  X-Robots-Tag: noindex
`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The font files (WOFF2) and their licences, copied to dist/fonts.
const FONT_DIR = path.join(HERE, 'fonts');
const FONT_FILE_RE = /^[A-Za-z0-9-]+\.(woff2|txt)$/;
const MAX_HISTORY_FILES = 400;
// Month digests of older scans (scan/history.js) and the runs shown per listing.
const MAX_MONTH_FILES = 120;
const MAX_MONTH_RUNS = 60;
// Daily results shown per listing: more than the days the scanner keeps as
// snapshots (HISTORY_KEEP_DAYS in scan/history.js), so no day falls between
// the daily table and the month digests.
const MAX_EARLIER_ROWS = 200;
// Below this many listings the register shows a few blank ruled lines under
// the last entry, as a register page does.
const BLANK_LINES_BELOW = 8;
const README_URL = `${CHECKER_SOURCE}#readme`;
const SPEC_URL = `${CHECKER_SOURCE}/blob/main/SPEC.md`;
const DEFAULT_REGISTRY = 'https://registry.modelcontextprotocol.io';
// The checker as a publisher runs it from the folder that holds server.json,
// with the checker cloned next to that folder.
const TOOL = 'node ../addon-declaration/bin/addon-declare.js';
// Listings published by the authors of this site. The scan and the check treat
// them like every other listing; their pages say who publishes them.
export const AUTHORS_LISTINGS = new Set(['com.rtlpdf/arabic-pdf']);
const INDEPENDENCE = 'Declared is independent of the Model Context Protocol project. It is not affiliated with or endorsed by the Model Context Protocol project or its registry. The authors of this site also publish the listing com.rtlpdf/arabic-pdf (rtlpdf.com), which the site lists and checks like every other listing.';
// Scanner and checker states in which the check read no listing from the registry.
const NO_LISTING_READ = new Set(['registry_not_found', 'registry_unreachable', 'registry_response_invalid', 'not_checkable', 'check_error']);
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI'];

// Cloudflare Pages serves a page at its address without .html (a request for
// /method.html is redirected to /method, and /index.html to /), so canonical
// links, the sitemap and the feed name pages that way.
export const pageUrl = (rel) => `${SITE_URL}/${rel === 'index' ? '' : rel}`;

const FOOTER = (root) => `<footer class="site"><div class="frame row">
<p class="m colophon-mark" aria-hidden="true">Declared</p>
<div class="b">
<p>${esc(INDEPENDENCE)}</p>
<p>This site, its scanner and the checker it runs were written with substantial AI assistance. Every result except the scanner states <code>not_checkable</code> and <code>check_error</code> comes from the public checker, and most listing pages give the command that repeats the check.</p>
<p>A result that looks wrong, or a question about this site: ${httpsLink(SITE_ISSUES, 'issues page of the site repository')}. About the checker or the spec: ${httpsLink(CHECKER_ISSUES, 'issues page of the public checker')}. <a href="${esc(root + 'method.html')}">Method and limits</a>.</p>
</div>
</div></footer>`;

// Whether the build in progress includes the census section (set by
// buildSite for the length of one build; the build is synchronous). With it
// off, every page is the page the site had before the census existed.
let WITH_CENSUS = false;

function layout({ title, description, body, root = '', canonical, absolute = false, current = null, styles = [] }) {
  const base = absolute ? '/' : root;
  // The front page as the folder it is served from (Pages redirects /index.html to /).
  const home = base || './';
  const nav = [
    [null, 'List', 'list'],
    ['method.html', 'Method', 'method'],
    ['publishers.html', 'Publishers', 'publishers'],
    ...(WITH_CENSUS ? [['census.html', 'Census', 'census']] : []),
    ['data.json', 'Data', 'data'],
  ]
    .map(([href, text, key]) => `<a href="${esc(href === null ? home : base + href)}"${key === current ? ' aria-current="page"' : ''}>${esc(text)}</a>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(pageUrl(canonical))}">` : ''}
<link rel="stylesheet" href="${esc(base + 'style.css')}">
${styles.map((x) => `<link rel="stylesheet" href="${esc(base + x)}">
`).join('')}<link rel="icon" href="${esc(base + 'favicon.svg')}" type="image/svg+xml">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site"><div class="frame">
<a class="brand" href="${esc(home)}">Declared <small>declaredlist.com</small></a>
<nav class="site" aria-label="Site">
${nav}
</nav>
</div></header>
<main id="main"><div class="frame">
${body}
</div></main>
${FOOTER(base)}
</body>
</html>
`;
}

// Turns any value into an array of strings for display.
const strings = (a, n = 80) => (Array.isArray(a) ? a.slice(0, n).filter((x) => typeof x === 'string') : []);
const s = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

function listItems(items, n = 500, cls = 'plain', tag = 'ul') {
  if (!items.length) return '<p class="muted">None.</p>';
  return `<${tag} class="${cls}">\n${items.map((x) => `<li>${escClip(x, n)}</li>`).join('\n')}\n</${tag}>`;
}

function fact(label, valueHtml) {
  if (!valueHtml) return '';
  return `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>\n`;
}
const code = (v, n = 200) => (v ? `<code>${escClip(v, n)}</code>` : '');
// A short value that must not wrap inside itself (a version, a protocol
// version such as 2026-07-28). A long one may still wrap, so no line runs
// off the page.
const codeNw = (v, n = 200) => {
  if (!v) return '';
  const text = clip(v, n);
  return `<code${[...text].length <= 24 ? ' class="nw"' : ''}>${esc(text)}</code>`;
};

// A digest such as sha256:<64 hex> or sha256-<base64>, set in groups of eight
// characters so it wraps cleanly between groups (the stylesheet sets four
// groups to a line). The groups are separate elements spaced by the
// stylesheet, and the break points are <wbr> elements: no character is added,
// so a copy gives the exact value. Anything else is shown as it is.
export function hashHtml(v, n = 120) {
  if (!v) return '';
  const text = clip(v, n);
  const m = text.match(/^(sha(?:256|384|512)[:-])([A-Za-z0-9+/=]{9,})$/);
  if (!m) return `<code>${esc(text)}</code>`;
  const groups = m[2].match(/.{1,8}/g);
  return `<code class="hash"><span class="pre">${esc(m[1])}</span>${groups.map((g) => `<wbr><span class="g">${esc(g)}</span>`).join('')}</code>`;
}

// The pieces of one path segment that may be set on separate lines: the
// segment whole when it is short; a long run of hex digits (a hash) in groups
// of eight, as hashHtml sets them; other long segments after a ".", "-" or
// "_", and any piece still too long in groups of eight.
const LONG_SEGMENT = 24;
function segmentPieces(seg) {
  const chunk = (x) => [...x].length > LONG_SEGMENT ? x.match(/.{1,8}/gu) : [x];
  if ([...seg].length <= LONG_SEGMENT) return [seg];
  const hex = seg.match(/^([0-9A-Fa-f]{24,})(.*)$/u);
  if (hex) {
    const groups = hex[1].match(/.{1,8}/g);
    groups[groups.length - 1] += hex[2];
    return groups.flatMap((g) => ([...g].length > LONG_SEGMENT ? chunk(g) : [g]));
  }
  return seg.split(/(?<=[._-])/u).flatMap(chunk);
}

// Text that holds addresses (a URL, "http: https://...", "dns:example.com
// (TXT)"), as escaped HTML that may break only after a "/" or between the
// pieces segmentPieces gives, never inside a piece: each piece is an element
// the stylesheet keeps on one line, and the break points are <wbr> elements,
// so a copy gives the text unchanged. The scheme stays with the first piece
// of the host.
export function addressHtml(text) {
  const unit = (pieces) => pieces.map((p) => `<span class="u">${esc(p)}</span>`).join('<wbr>');
  return text
    .split(' ')
    .map((word) => {
      const m = word.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
      const head = m ? m[1] : '';
      const rest = m ? m[2] : word;
      const pieces = rest.split(/(?<=\/)/u).flatMap(segmentPieces);
      if (head) pieces[0] = head + (pieces[0] || '');
      return unit(pieces.filter((p) => p !== ''));
    })
    .join(' ');
}

// An outside address in the typed face, linked when it is a plain https URL
// (httpsLink's rules: the address shown is the canonical form linked).
function urlHtml(u, n = 300) {
  if (u === null || u === undefined || u === '') return '';
  const href = safeHttpsUrl(u);
  const inner = addressHtml(clip(href || u, n));
  return `<span class="url">${href ? `<a href="${esc(href)}" rel="noopener noreferrer nofollow">${inner}</a>` : inner}</span>`;
}

// Commands, one per line, set on a slip. Each line is a block with a hanging
// indent, each argument stays whole (a path may break after a "/"), so a
// wrapped line never splits "--key-env" or "check-listing". No character is
// added: a copy gives the commands as written.
export function commandHtml(text) {
  const lines = text.split('\n');
  return lines
    .map((line, i) => `<span class="ln">${line
      .split(' ')
      .map((a) => `<span class="arg">${esc(a).replace(/(?<![/.])\/(?=[^/])/g, '/<wbr>')}</span>`)
      .join(' ')}${i + 1 < lines.length ? '\n' : ''}</span>`)
    .join('');
}

// A block of JSON, one line per element: a wrapped line hangs four
// characters in from its own indent (classes j0 to j8), and an address in it
// breaks only after a "/" (addressHtml). No character is added.
export function jsonHtml(text) {
  const lines = text.split('\n');
  return lines
    .map((line, i) => {
      const n = Math.min(8, line.match(/^ */)[0].length);
      const body = line
        .split(/(https:\/\/[^"\s]+|[^"\s]*\/[^"\s]*)/)
        .map((part, k) => (k % 2 ? addressHtml(part) : esc(part)))
        .join('');
      return `<span class="ln j${n}">${body}${i + 1 < lines.length ? '\n' : ''}</span>`;
    })
    .join('');
}

// "20 November 2026, 15:22 UTC" with the time in the typed face.
function dateTimeHtml(iso) {
  const t = formatDateTime(iso);
  const i = t.lastIndexOf(', ');
  return i > 0 ? `${esc(t.slice(0, i))}, <span class="tm">${esc(t.slice(i + 2))}</span>` : esc(t);
}

// A listing name with a line break opportunity after its namespace, and the
// namespace set apart (it names the domain that signs).
function nameHtml(name, n = 200) {
  const text = clip(name, n);
  const i = text.indexOf('/');
  if (i <= 0 || i === text.length - 1) return esc(text);
  return `<span class="ns">${esc(text.slice(0, i + 1))}</span><wbr>${esc(text.slice(i + 1))}`;
}

// "11:57 UTC" from an ISO time.
function timeOf(iso) {
  const t = formatDateTime(iso);
  return t.includes(', ') ? t.slice(t.lastIndexOf(', ') + 2) : t;
}

// A time element for a stored time, or the formatted text alone when the
// stored value is not a time.
function timeHtml(iso, text) {
  return Number.isFinite(Date.parse(iso)) ? `<time datetime="${esc(new Date(Date.parse(iso)).toISOString())}">${esc(text)}</time>` : esc(text);
}

// One section of a page: its numeral in the margin, its text, and notes in
// the note column.
function section(no, inner, { notes = '', wide = false, cls = '', id = '' } = {}) {
  return `<section class="row sec${cls ? ` ${cls}` : ''}"${id ? ` id="${esc(id)}"` : ''}>
<p class="m secno" aria-hidden="true">${ROMAN[no] || ''}</p>
<div class="b${wide ? ' wide' : ''}">
${inner.trim()}
</div>${notes ? `\n<aside class="n" aria-label="Notes">\n${notes}\n</aside>` : ''}
</section>`;
}

// An anchor name from a heading the generator wrote.
const slug = (t) => t.toLowerCase().replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The numbered sections of a page as a contents list, set like register
// particulars: numeral, then heading.
function contentsList(items) {
  return `<ol class="contents">
${items.map(([no, id, text]) => `<li><a href="#${esc(id)}"><span class="cn" aria-hidden="true">${ROMAN[no] || ''}</span>${esc(text)}</a></li>`).join('\n')}
</ol>`;
}

// The sections of a page beside a rail in the note column, which keeps its
// contents in view while the page scrolls. On narrow screens the rail is set
// before the sections.
function railed(rail, sections) {
  return `<div class="railed">
<div class="rail">
<div class="rail-in">
${rail}
</div>
</div>
${sections}
</div>`;
}

// Inline code in the prose of the method and publishers pages: a short value
// stays on one line (so "mcp-publisher" or "--dry-run" never breaks at its
// hyphen), and a long path breaks only after a "/" (addressHtml). Only code
// with plain text inside is touched; nothing is added to the text.
const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`', '&#61;': '=' };
function inlineCode(html) {
  return html.replace(/<code>([^<]+)<\/code>/g, (m, x) => {
    const text = x.replace(/&(?:amp|lt|gt|quot|#39|#96|#61);/g, (e) => UNESC[e]);
    if ([...text].length <= 28) return `<code class="nw">${x}</code>`;
    if (text.includes('/')) return `<code class="addr">${addressHtml(text)}</code>`;
    return m;
  });
}

// A page of plain text: what stands before the first h2 opens the page, and
// each h2 starts a numbered section. The note column holds the contents.
function sectioned(html) {
  const parts = inlineCode(html).split(/(?=<h2>)/);
  const head = parts.shift();
  const items = parts.map((p, i) => {
    const t = (p.match(/^<h2>([^<]*)<\/h2>/) || [])[1] || '';
    return [i, slug(t) || `s${i + 1}`, t.replace(/&amp;/g, '&')];
  });
  return `<div class="row head">
<div class="b">
${head.trim()}
</div>
</div>
${railed(`<nav aria-label="Contents">\n<p class="sc rail-h">Contents</p>\n${contentsList(items)}\n</nav>`, parts.map((p, i) => section(i, p, { id: items[i][1] })).join('\n'))}`;
}

// The command a reader can run to repeat a check, or null when the name, the
// version or the registry cannot be put on a command line as it is (every
// character allowed here reads the same in bash, zsh, cmd and PowerShell, and
// no argument starts with a hyphen). A command that checked another version,
// or another registry, than the one shown would describe another check, so
// none is shown then.
export function repeatCommand(name, version, registry = null) {
  if (typeof name !== 'string' || name.length > 200 || !/^[A-Za-z0-9.][A-Za-z0-9.-]*\/[A-Za-z0-9._-]+$/.test(name)) return null;
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(version)) return null;
  let reg = '';
  if (registry !== null && registry !== undefined && registry !== DEFAULT_REGISTRY) {
    if (typeof registry !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~-]+)*$/.test(registry)) return null;
    reg = ` --registry ${registry}`;
  }
  return `node bin/addon-declare.js check-listing ${name} --version ${version}${reg} --fetch-tools`;
}

// The state code (with a break opportunity after each underscore) and its
// short label. Every state is set the same way: no state is marked as better
// or worse than another.
const stateCode = (st) => `<span class="state">${esc(knownState(st) ? st : 'unknown').replace(/_/g, '_<wbr>')}</span>`;
function stateCell(r) {
  return `${stateCode(r.state)}<span class="gloss">${esc(stateLabel(r.state))}</span>`;
}

function digestLine(label, d) {
  if (!d || typeof d !== 'object') return '';
  let out = esc(s(d.result) || 'unknown');
  const rows = [];
  if (d.declared) rows.push(`<span class="dk">declared</span><span>${hashHtml(d.declared, 120)}</span>`);
  if (d.computed) rows.push(`<span class="dk">computed</span><span>${hashHtml(d.computed, 120)}</span>`);
  if (d.code) rows.push(`<span class="dk">code</span><span>${code(d.code, 40)}</span>`);
  if (rows.length) out += `<span class="pair">${rows.join('')}</span>`;
  return fact(label, out);
}

// The tool list facts of a result.
function toolFacts(r) {
  const T = r.tools && typeof r.tools === 'object' ? r.tools : {};
  const G = r.toolSetDigest && typeof r.toolSetDigest === 'object' ? r.toolSetDigest : null;
  return `${fact('Tool list', T.check ? `check ${code(T.check, 20)}${T.result ? `, result ${code(T.result, 20)}` : ''}` : '')}${fact('Tool list read from', T.remote ? `${urlHtml(T.remote, 200)}${T.protocolVersion ? ` with MCP protocol version ${codeNw(T.protocolVersion, 40)}` : ''}${T.era ? ` (${T.era === 'modern' ? 'per request metadata, no session' : 'initialize flow'})` : ''}${Number.isInteger(T.pages) ? `, ${esc(T.pages)} page${T.pages === 1 ? '' : 's'}` : ''}` : '')}${fact('Tool check note', T.reason ? escClip(T.reason, 300) : '')}${G ? digestLine('Contract digest', G.contract) + digestLine('Extras digest', G.extras) : ''}`;
}

// The key facts of a result.
function keyFacts(r, D) {
  const key = D ? fact('Key', `${code(D.alg, 20)} ${hashHtml(D.keyId, 120)}`) + fact('Key published by', D.keyMethod ? `${esc(clip(D.keyMethod, 10))} method at ${code(D.keyDomain, 200)}` : '') : r.keyId ? fact('Key', `${code(r.alg, 20)} ${hashHtml(r.keyId, 120)}`) : '';
  return `${key}${fact('Key source', r.keySource ? `<span class="url">${addressHtml(clip(r.keySource, 300))}</span>` : '')}${fact('Key record', r.keyRecord ? esc(clip(r.keyRecord, 120)) : '')}`;
}

// What the check compared, as a chain of statements on one spine: the
// listing, the declaration it names, the declaration in force (when a newer
// one is), the key and the remote, each joined to the next by what links
// them. Only the statements the check reached are shown. Facts the chain
// does not hold (when it stops before them) are returned as `rest`, for the
// result facts.
function chainOf(r) {
  const D = r.declaration && typeof r.declaration === 'object' ? r.declaration : null;
  const P = r.pointer && typeof r.pointer === 'object' ? r.pointer : null;
  const N = r.declarationNamed && typeof r.declarationNamed === 'object' ? r.declarationNamed : null;
  const F = r.inForce && typeof r.inForce === 'object' ? r.inForce : null;
  const tools = toolFacts(r);
  const keys = keyFacts(r, D);
  const listingRead = !NO_LISTING_READ.has(r.state) || P || N || F || D;
  if (!listingRead) return { html: '<p class="muted">Nothing was compared: no listing was read in this check.</p>', rest: keys + tools, count: 0 };
  const stmts = [];
  stmts.push({
    title: 'The listing, as the registry served it',
    facts: `${fact('Name', `<code>${escClip(r.name, 200)}</code>`)}${fact('Version', codeNw(r.version, 120))}${fact('Published in the registry', r.publishedAt ? dateTimeHtml(r.publishedAt) : '')}${fact('Registry status', r.registryStatus ? code(r.registryStatus, 60) : '')}${fact('Registry entry', httpsLink(r.registryUrl, 'listing as the registry API serves it (JSON)'))}${P ? fact('Declaration pointer in the listing', urlHtml(P.url, 300)) + fact('Pointer hash', hashHtml(P.hash, 80)) : fact('Declaration pointer in the listing', esc('none read'))}`,
  });
  // The statement head says which declaration the dates belong to.
  const dates = D ? fact('Issued at', D.issuedAt ? dateTimeHtml(D.issuedAt) : '') + fact('Expires at', D.expiresAt ? dateTimeHtml(D.expiresAt) : esc('no expiry time in the declaration')) : '';
  // The checker records the file the pointer address served (N) before it
  // compares that file's hash with the pointer hash. Only a file whose hash
  // equals the pointer hash is the declaration the listing names; any other
  // file stays out of the chain and is shown with the result facts.
  const namedMatches = Boolean(N && P && N.hash === P.hash);
  const servedOther = N && !namedMatches ? N : null;
  const namedInForce = Boolean(!servedOther && F && F.source === 'pointer');
  const namedRead = Boolean(namedMatches || (!servedOther && D && D.of === 'named') || namedInForce);
  if (namedRead) {
    let facts = '';
    if (namedMatches) facts += `${fact('Hash', hashHtml(N.hash, 80))}${fact('Format', code(N.format, 60))}${fact('Verify state', code(N.state, 60))}${fact('Served at', urlHtml(N.url, 300))}`;
    else if (namedInForce) facts += `${fact('Hash', hashHtml(F.hash, 80))}${fact('Format', code(F.format, 60))}${fact('Served at', urlHtml(F.url, 300))}`;
    if (D && (D.of === 'named' || namedInForce)) facts += dates;
    // With no declaration in force, the dates, key and remotes that follow
    // are those of the named declaration.
    const note = D && D.of === 'named' && !namedInForce ? 'The dates, key and remotes below are those of the declaration the listing names (no declaration was put in force).' : '';
    stmts.push({ join: 'names, by its hash,', title: namedInForce ? 'The declaration the listing names, in force' : 'The declaration the listing names', note, facts });
  }
  let rest = servedOther ? `${fact('File served at the pointer address', urlHtml(servedOther.url, 300))}${fact('Hash of the file served there', hashHtml(servedOther.hash, 80))}${fact('Its format', code(servedOther.format, 60))}` : '';
  if (F && F.hash && !namedInForce && !servedOther) {
    const facts = `${fact('Hash', hashHtml(F.hash, 80))}${fact('Format', code(F.format, 60))}${fact('Read from', code(F.source, 80))}${fact('Served at', urlHtml(F.url, 300))}${D && D.of !== 'named' ? dates : ''}`;
    // A newer declaration is put in force only when it follows the named one
    // under the same key (the checker's verified_newer_declaration path).
    stmts.push({ join: namedRead ? 'is followed, under the same key, by' : 'names a declaration that is followed, under the same key, by', title: 'The declaration in force', facts });
  }
  const hasDeclaration = stmts.length > 1;
  if (hasDeclaration && keys) stmts.push({ join: 'names as its key', title: 'The key', facts: keys });
  else rest += keys;
  const remotes = D && Array.isArray(D.remotes) ? D.remotes.slice(0, 10) : [];
  if (hasDeclaration && remotes.length) {
    const plural = remotes.length === 1 ? 'remote' : 'remotes';
    const afterKey = stmts[stmts.length - 1].title === 'The key';
    stmts.push({
      join: afterKey ? `and the same declaration names the ${plural}` : `names the ${plural}`,
      title: remotes.length === 1 ? 'The remote and its tool list' : 'The remotes and the tool list',
      facts: `${fact('Declared remotes', remotes.map((x) => `${code(x && x.type, 40)} ${urlHtml(x && x.url, 200)}`).join('<br>'))}${tools}`,
    });
  } else rest += tools;
  const html = `<ol class="chain">
${stmts
  .map(
    (st, i) => `<li class="stmt">
<p class="stmt-no" aria-hidden="true">${i + 1}</p>
<h3>${esc(st.title)}</h3>${st.note ? `\n<p class="stmt-note">${esc(st.note)}</p>` : ''}
<dl class="facts">
${st.facts}</dl>${i + 1 < stmts.length ? `\n<p class="join">${esc(stmts[i + 1].join)}</p>` : ''}
</li>`,
  )
  .join('\n')}
</ol>`;
  return { html, rest, count: stmts.length };
}

function listingPage(r, file, hist, scan, older = []) {
  const name = s(r.name);
  const title = `${clip(name, 120)} | Declared`;
  const sentence = stateSentence(r);
  const tools = toolsSentence(r);
  const cmd = repeatCommand(r.name, r.version, scan.registry);
  const checkerVersion = scan.checker && typeof scan.checker.version === 'string' ? scan.checker.version : null;
  const requests = Array.isArray(r.requests) ? r.requests.slice(0, 40) : [];
  const chain = chainOf(r);
  let no = 0;

  // Publisher text can be in any script: its direction is read from the text
  // (dir="auto"), and the name, version and addresses keep their own spans.
  const head = `<div class="row head listing-head">
<p class="m crumbs-m" aria-hidden="true"></p>
<div class="b">
<p class="crumbs"><a href="../">List</a> / listing</p>
<h1 class="entry-name">${nameHtml(name, 200)}</h1>
${r.title ? `<p class="entry-title" dir="auto">${escClip(r.title, 200)}</p>` : ''}
${r.description ? `<blockquote class="pubtext"><p dir="auto">${escClip(r.description, 400)}</p><footer>Description from the listing, as the publisher wrote it.</footer></blockquote>` : ''}
</div>${AUTHORS_LISTINGS.has(name) ? `\n<aside class="n" aria-label="Notes">\n<div class="note disclose"><span class="sc">Disclosure</span>\n<p class="muted">The authors of this site publish this listing. The scan and the check treat it like every other listing.</p>\n</div>\n</aside>` : ''}
</div>`;

  const sections = [];
  const add = (id, h2, inner, opts = {}) => {
    sections.push([no, id, h2]);
    return section(no++, `<h2>${esc(h2)}</h2>\n${inner}`, { ...opts, id });
  };

  const result = add(
    'result',
    'Result',
    `<p class="typed-line">Checked ${timeHtml(r.checkedAt, formatDateTime(r.checkedAt))}</p>
<p class="lead recital">${esc(sentence)}</p>
${tools ? `<p class="tools">${esc(tools)}</p>` : ''}
<dl class="facts">
${fact('State', `${stateCode(r.state)}${Number.isInteger(r.exitCode) ? `, exit code <code>${esc(r.exitCode)}</code> of <code class="nw">check-listing</code>` : ''}`)}${fact('Listing version', codeNw(r.version, 120))}${chain.rest}</dl>
${strings(r.reasons).length ? `<h3>Reasons the checker gave</h3>\n${listItems(strings(r.reasons))}` : ''}`,
  );

  const compared = add(
    'compared',
    'What was compared',
    `${chain.count ? `<p class="chain-sub">Read from the top: the listing, then each statement it leads to, as far as the check reached on ${esc(formatDate(r.checkedAt))}.</p>\n` : ''}${chain.html}`,
  );

  const checks = add(
    'checks',
    'Checks and requests',
    `<h3>Checked</h3>
${listItems(strings(r.checked), 500, 'clauses', 'ol')}
<h3>Not checked</h3>
${listItems(strings(r.notChecked), 500, 'clauses', 'ol')}
${strings(r.notes).length ? `<h3>Notes</h3>\n${listItems(strings(r.notes))}` : ''}
<h3>Requests the check made</h3>
${requests.length ? `<ul class="log">\n${requests.map((q) => `<li><span class="lm">${esc(s(q.method) || 'GET')}${q.rpc ? ` ${esc(clip(q.rpc, 40))}` : ''}</span> <span class="la">${urlHtml(q.url, 200)}</span> <span class="lr">${q.error ? `failed (${escClip(q.error, 200)})` : Number.isInteger(q.status) ? `HTTP ${esc(q.status)}` : 'answered'}</span></li>`).join('\n')}\n</ul>` : '<p class="muted">None.</p>'}`,
  );

  const repeat = add(
    'repeat',
    'Repeat this check',
    cmd
      ? `<p>With Node 20 or later and a copy of the public checker (no dependencies, nothing to install):</p>
<pre class="slip"><code>${commandHtml(`git clone ${CHECKER_SOURCE}\ncd addon-declaration\n${cmd}`)}</code></pre>
<p class="muted">The result can differ from the one above if the listing, the publisher's site, the key, the server or the checker changed since ${esc(formatDate(r.checkedAt))}${checkerVersion ? ` (this result used <code class="nw">addon-declare ${escClip(checkerVersion, 20)}</code>)` : ''}. Add <code>--json</code> for the full report.</p>`
      : '<p>This listing name or version cannot be written on a command line as it is, so no command is shown.</p>',
  );

  let body = `${result}\n${compared}\n${checks}\n${repeat}`;
  if (hist.length) {
    body += `\n${add(
      'earlier',
      'Earlier results',
      `<div class="table-wrap">${tableRoles(`<table class="list earlier">
<thead><tr><th scope="col">Scan date</th><th scope="col">Version</th><th scope="col">State</th></tr></thead>
<tbody>
${hist.map((h) => `<tr><td data-label="Scan date">${esc(formatDate(h.checkedAt))}<span class="when-t">${esc(timeOf(h.checkedAt))}</span></td><td data-label="Version">${codeNw(h.version, 60)}</td><td data-label="State">${stateCell(h)}</td></tr>`).join('\n')}
</tbody></table>`)}</div>`,
    )}`;
  }
  if (older.length) {
    body += `\n${add(
      'older',
      'Older results, by month',
      `<p class="muted">Scans older than about six weeks are kept as one row per run: scans of one month that follow one another, each of which showed this listing with the same version, state and declaration.</p>
<div class="table-wrap">${tableRoles(`<table class="list older">
<thead><tr><th scope="col">First check</th><th scope="col">Last check</th><th scope="col">Checks</th><th scope="col">Version</th><th scope="col">Declaration</th><th scope="col">State</th></tr></thead>
<tbody>
${older.map((h) => `<tr><td data-label="First check">${esc(formatDate(h.firstCheckedAt))}</td><td data-label="Last check">${esc(formatDate(h.lastCheckedAt))}</td><td data-label="Checks">${esc(h.checks)}</td><td data-label="Version">${codeNw(h.version, 60)}</td><td class="full" data-label="Declaration">${h.declaration ? hashHtml(h.declaration, 80) : ''}</td><td class="full" data-label="State">${stateCell(h)}</td></tr>`).join('\n')}
</tbody></table>`)}</div>`,
    )}`;
  }

  // The rail in the note column: the particulars of this result and the
  // numbered sections, kept in view, then the notes of the page.
  const rail = `<aside class="stub" aria-label="Particulars">
<p class="sc rail-h">Particulars</p>
<dl class="stub-l">
<dt>State</dt><dd>${stateCode(r.state)}</dd>
${r.version ? `<dt>Version</dt><dd>${codeNw(r.version, 60)}</dd>\n` : ''}<dt>Checked</dt><dd>${dateTimeHtml(r.checkedAt)}</dd>
</dl>
<nav aria-label="Sections">
${contentsList(sections)}
</nav>
</aside>
<div class="rail-notes">
<p class="note"><span class="sc">The date</span>Each result is a snapshot from one check on one day. A listing, a site or a server can change the next minute.</p>
<p class="note"><span class="sc">Hashes</span>Hashes are set in groups of eight characters for the eye. A copy gives the value as one unbroken string.</p>
</div>`;

  body = `${head}\n${railed(rail, body)}`;
  body += `\n<div class="row"><p class="b muted endnote">From the scan finished ${dateTimeHtml(scan.scanFinishedAt)}.</p></div>`;
  return layout({ title, description: `Dated check result for the registry listing ${clip(name, 120)}.`, body, root: '../', canonical: `listing/${file}` });
}

function failureNotice(status, latest) {
  const f = status && status.lastFailure && typeof status.lastFailure === 'object' ? status.lastFailure : null;
  if (!f || !Number.isFinite(Date.parse(f.at)) || Date.parse(f.at) <= Date.parse(latest.scanFinishedAt)) return '';
  return `<p class="notice">The scan attempted ${esc(formatDateTime(f.at))} did not complete (${escClip(f.reason, 300)}). The list below is from the last complete scan, ${esc(formatDateTime(latest.scanFinishedAt))}.</p>`;
}

// The scan facts at the top of the front page: what was read, and how.
function coverageFacts(latest, n) {
  const c = latest.counts || {};
  const cov = latest.coverage && typeof latest.coverage === 'object' ? latest.coverage : { mode: 'full' };
  const full = cov.lastFullPass && typeof cov.lastFullPass === 'object' ? cov.lastFullPass : null;
  // Two counts that differ in meaning: pointers seen in this scan's list read,
  // and the listings shown below (those, plus listings shown before and
  // checked again). The table is described by the second.
  const pointers = Number.isInteger(c.pointersInListRead) ? c.pointersInListRead : c.withPointer;
  const shown = `${esc(n(latest.listings.length))} (each with a declaration pointer found in this scan or an earlier one, checked again in this scan)`;
  let out = fact('Last complete scan', dateTimeHtml(latest.scanFinishedAt));
  if (cov.mode === 'updated_since') {
    out += fact('Listings read in this scan', `${esc(n(c.listingsScanned))} (the latest version of each listing published or changed since ${dateTimeHtml(cov.since)})`);
    out += fact('Of these, with a declaration pointer', esc(n(pointers)));
    if (full) out += fact('Last full pass over the registry', `${dateTimeHtml(full.finishedAt)}: ${esc(n(full.listingsScanned))} listings read, ${esc(n(full.withPublisherMetadata))} with publisher metadata`);
  } else {
    out += fact('Listings scanned', `${esc(n(c.listingsScanned))} (the latest version of each listing in the registry, read in full)`);
    out += fact('With publisher metadata', esc(n(c.withPublisherMetadata)));
    out += fact('With a declaration pointer in this scan', esc(n(pointers)));
  }
  out += fact('Listings shown below', shown);
  return out;
}

// Table roles written out, so a table the phone stylesheet stacks (as block
// and grid boxes) keeps its rows, cells and headers for screen readers. Only
// markup the generator wrote is matched: data text is escaped.
function tableRoles(html) {
  return html
    .replace(/<table class="([^"]*)">/g, '<table class="$1" role="table">')
    .replace(/<(thead|tbody)>/g, '<$1 role="rowgroup">')
    .replace(/<tr( class="[^"]*")?>/g, '<tr$1 role="row">')
    .replace(/<th scope="col">/g, '<th scope="col" role="columnheader">')
    .replace(/<th colspan="3" scope="rowgroup">/g, '<th colspan="3" scope="rowgroup" role="rowheader">')
    .replace(/<td((?: [a-z-]+="[^"]*")*)>/g, '<td$1 role="cell">');
}

// The register on the front page: one row per listing, grouped under the day
// it was checked (newest day first, names in order within a day). The row
// numbers in the margin count the rows as shown; they are not stored, name
// no entry, and can change from one scan to the next, so the column is headed
// "Row", not "No.".
function registerTable(latest, files) {
  const dayOf = (r) => {
    try {
      return isoDay(r.checkedAt);
    } catch {
      return '';
    }
  };
  const days = new Map();
  for (const r of latest.listings) {
    const d = dayOf(r);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(r);
  }
  const order = [...days.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? 1 : a > b ? -1 : 0));
  let no = 0;
  const groups = order.map((d) => {
    const rows = days.get(d);
    const label = d ? `Checked on ${formatDate(rows[0].checkedAt)}` : 'Checked at a time the data does not give';
    return `<tbody>
<tr class="day"><th colspan="3" scope="rowgroup">${esc(label)}</th></tr>
${rows
  .map((r) => {
    no++;
    const file = files.get(r.name);
    return `<tr><td class="name" data-label="Listing"><span class="no" aria-hidden="true">${no}</span>${localLinkHtml(`listing/${file}.html`, nameHtml(s(r.name), 120))}${r.title ? `<span class="e-title" dir="auto">${escClip(r.title, 120)}</span>` : ''}${r.version ? `<span class="e-ver">version ${codeNw(r.version, 40)}</span>` : ''}</td><td data-label="Result">${stateCell(r)}</td><td class="when" data-label="Checked">${esc(timeOf(r.checkedAt)).replace(/ UTC$/, '<span class="tz"> UTC</span>')}</td></tr>`;
  })
  .join('\n')}
</tbody>`;
  });
  return tableRoles(`<table class="list register">
<thead><tr><th scope="col"><span class="no" aria-hidden="true">Row</span>Listing</th><th scope="col">Result</th><th scope="col">Checked<span class="tz-h"> (UTC)</span></th></tr></thead>
${groups.join('\n')}
</table>`);
}

function indexPage(latest, files, status) {
  const n = (v) => (Number.isInteger(v) ? v.toLocaleString('en-US') : 'unknown');
  const count = latest.listings.length;
  const digits = String(count).length;
  const withdrawn = Array.isArray(latest.withdrawn) ? latest.withdrawn.slice(0, 200) : [];
  let no = 0;
  const head = `<div class="row head hero">
<div class="b hero-body">
<p class="tally"><span class="tally-num d${Math.min(digits, 4)}">${esc(n(count))}</span><span class="tally-cap">${count === 1 ? 'listing' : 'listings'} shown below</span></p>
<div class="hero-text">
<h1>Registry listings that point to an add&nbsp;on declaration</h1>
<p class="lead">Declared lists every server in the official MCP Registry whose listing points to an add on declaration, and shows the dated result of checking it with the public checker.</p>
<p>Each result is a dated fact about what the check found on that day, including whether a signature was found and valid; it is not a rating of the server or its publisher.</p>
</div>
</div>
<aside class="n" aria-label="Notes">
<p class="note"><span class="sc">Declaration</span>A declaration is a short statement of what one server version offers (name, version, remotes and tool list, and optionally a price, a pay address and a contact), signed with the key of the domain the server is published under.</p>
</aside>
</div>`;
  const scan = section(
    no++,
    `<h2>The last scan</h2>
${failureNotice(status, latest)}
<dl class="facts particulars">
${coverageFacts(latest, n)}${fact('Checker', `<code>addon-declare</code> ${code(latest.checker && latest.checker.version, 20)}, command <code>check-listing --fetch-tools</code>`)}
</dl>`,
    { wide: true },
  );
  const register = section(
    no++,
    `<h2>Listings with a declaration pointer</h2>
${count ? `${registerTable(latest, files)}
${count < BLANK_LINES_BELOW ? '<div class="blank" aria-hidden="true"></div>' : ''}
<p class="muted">Each result is what the check found at the time shown on the listing page. Open a listing for every checked fact and the command that repeats the check.</p>` : '<p>No listing carried a declaration pointer in this scan.</p>'}`,
    { wide: true, cls: 'register-sec', id: 'register' },
  );
  const gone = withdrawn.length
    ? section(
        no++,
        `<h2>No longer listed</h2>
<p>These listings named a declaration in the previous published scan and do not now.</p>
<ul class="plain withdrawn">${withdrawn.map((w) => `<li>${escClip(w.name, 120)}${w.version ? ` ${codeNw(w.version, 40)}` : ''}: ${escClip(w.reason, 200)} (${esc(formatDate(w.checkedAt))})</li>`).join('\n')}</ul>`,
        { wide: true },
      )
    : '';
  const publish = section(
    no++,
    `<h2>Publishing a declaration</h2>
<p>A publisher with a domain namespace can sign a declaration with the key they already use for the registry and point to it from their listing. ${localLink('publishers.html', 'The steps')}.</p>`,
    { wide: true },
  );
  const body = [head, scan, register, gone, publish].filter(Boolean).join('\n');
  return layout({ title: 'Declared: MCP Registry listings that point to a declaration', description: 'Registry listings that point to an add on declaration, with dated check results.', body, canonical: 'index', current: 'list' });
}

function publishersPage() {
  const body = `<h1>Publishing a declaration</h1>
<p class="lead">A short path, taken from the README of the public checker. The README and the spec are the full reference: ${httpsLink(README_URL, 'README')}, ${httpsLink(SPEC_URL, 'SPEC.md')}.</p>
<p>You need a server published under a domain namespace (such as <code>com.example/weather</code>) with <code>mcp-publisher login dns</code> or <code>mcp-publisher login http</code>, and the private key you made for that login. Names under <code>io.github</code> are out of scope, because no domain key can prove them. The checker needs Node 20 or later and has no dependencies, so nothing needs installing.</p>
<h2>The short way: one command</h2>
<p>If your server is already listed in the registry, the checker can do the reading, signing and checking in one run. Clone it as in step 0 below, then, from the folder that holds your server.json, give the name of your listing and the version you are about to publish:</p>
<pre><code>${commandHtml(`${TOOL} prepare com.example/weather --for-version 1.4.1 --key-env MCP_PRIVATE_KEY`)}</code></pre>
<p>The version must be a new one, because a published version cannot be changed. The run reads your listing and your key record, reads the tool list from your running server, and stops before signing if the private key is not the one you published. It links your last declaration, signs the new one, checks the result, and writes a folder <code>addon-declaration-out</code> with:</p>
<ul class="plain">
<li><code>site/</code>: the files to upload to your domain, at the paths they already have inside that folder;</li>
<li><code>pointer.json</code>: the block to put into the server.json of the new version;</li>
<li><code>NEXT_STEPS.txt</code>: the upload addresses, the edit to server.json, the publish step and the command that checks the listing afterwards.</li>
</ul>
<p>Add <code>--dry-run</code> to see what it would do without signing anything. If the new version changes your tools or your remotes, give <code>--tools</code> and <code>--server-json</code> for that build, as the README describes. After you publish the version with <code>mcp-publisher</code>, check the listing as this site does:</p>
<pre><code>${commandHtml(`${TOOL} check-listing com.example/weather --fetch-tools`)}</code></pre>
<h2>The same steps by hand</h2>
<p>For a server that is not listed yet, or to run each step yourself.</p>
<ol class="steps" start="0">
<li><p>Get the checker. From the folder above the one that holds your server.json, clone it, so that it sits next to that folder:</p>
<pre><code>${commandHtml(`git clone ${CHECKER_SOURCE}`)}</code></pre>
<p>Run every command below from the folder that holds your server.json. They call the checker by its path, <code>../addon-declaration/bin/addon-declare.js</code>; change that path if you cloned it somewhere else. Keep the private key out of that folder.</p></li>
<li><p>Save the <code>tools/list</code> result of this exact build as <code>tools.json</code>, as the server sent it, in UTF-8. If your server pages the list, save each page as its own file and give <code>--tools</code> once per page, in order, in every command below (for example <code>--tools tools-1.json --tools tools-2.json</code>). If the answer arrived as server sent events (lines starting with <code>event:</code> and <code>data:</code>), save only the JSON-RPC message the <code>data:</code> lines carry, without that framing.</p></li>
<li><p>Create the unsigned declaration from your server.json. Its version must be one you have not published in the registry yet, because a published version cannot be changed. If you logged in with <code>mcp-publisher login http</code>, add <code>--method http</code>: without it the declaration names the dns method, and every check looks for a TXT record at your domain.</p>
<pre><code>${commandHtml(`${TOOL} init --server-json server.json --tools tools.json --expires-in-days 180 --out unsigned.json`)}</code></pre>
<p>If you change the version in server.json afterwards, run this step and the next one again; otherwise the check reports that the declaration differs from the listing (<code>listing_mismatch</code>). The README lists the other options, such as a price per call, a contact and a link to your last declaration.</p></li>
<li><p>Sign it. Give the name of an environment variable that holds the key (set from a secret store, not typed on the command line), or a key file kept outside the repository:</p>
<pre><code>${commandHtml(`${TOOL} sign unsigned.json --key-env MCP_PRIVATE_KEY --out declaration.json`)}</code></pre>
<p>It prints the proof record the key matches: a TXT record at your domain for the dns method, or a line of <code>https://&lt;your domain&gt;/.well-known/mcp-registry-auth</code> for the http method. It must be one you already published.</p></li>
<li><p>Check it the way a reader would:</p>
<pre><code>${commandHtml(`${TOOL} verify declaration.json --tools tools.json`)}</code></pre></li>
<li><p>Serve it at the paths <code>sign</code> printed: <code>/.well-known/addon-declaration/&lt;namespace&gt;/&lt;server&gt;/by-hash/&lt;hex&gt;.json</code> (keep every one of these), <code>.../versions/&lt;version&gt;.json</code>, and <code>.../latest.json</code> when this is your newest declaration. Here <code>&lt;hex&gt;</code> is the 64 hex digits of the declaration hash, without its <code>sha256:</code> prefix.</p></li>
<li><p>Point to it from server.json, with the same <code>&lt;hex&gt;</code>:</p>
<pre class="json"><code>${jsonHtml(`"_meta": {
  "io.modelcontextprotocol.registry/publisher-provided": {
    "addonDeclaration": {
      "url": "https://example.com/.well-known/addon-declaration/com.example/weather/by-hash/<hex>.json",
      "hash": "sha256:<hex>"
    }
  }
}`)}</code></pre>
<p>The URL must be exactly the by-hash path on the domain the namespace names (or a parent of it), with the same hash.</p></li>
<li><p>Publish the version with <code>mcp-publisher</code>, then check the listing as this site does:</p>
<pre><code>${commandHtml(`${TOOL} check-listing com.example/weather --fetch-tools`)}</code></pre>
<p>A scan after the version is published lists it; the front page gives the time of the last scan. Each release that passes the previous signed declaration to <code>--previous</code> builds a history that a check can follow. The checker repository has a GitHub Action and a sample workflow for signing on release.</p></li>
</ol>
<p class="muted">Publishing a declaration is free and needs no account with this site. The site lists what the registry serves and what the check finds; it does not accept or remove listings by request.</p>
`;
  return layout({ title: 'Publishing a declaration | Declared', description: 'How a publisher signs an add on declaration with the public checker, in one command or step by step, and points to it from a registry listing.', body: sectioned(body), canonical: 'publishers', current: 'publishers' });
}

function methodPage(latest) {
  const body = `<h1>Method and limits</h1>
<h2>How the scan works</h2>
<p>The scanner reads the list of listings from the public API of the official MCP Registry (<code>/v0/servers?version=latest</code>, 100 listings per page, cursor paging), at most one request per second, with a User-Agent that names this site. There are two kinds of pass: a full pass reads the latest version of every listing, and a pass over updated listings reads only the latest version of the listings published or changed since the previous scan (the API's <code>updated_since</code> parameter, with a margin of two hours). The list answer carries each listing's publisher metadata, so a listing is read again only when that metadata holds a declaration pointer (<code>_meta["io.modelcontextprotocol.registry/publisher-provided"].addonDeclaration</code>) or is present but malformed, or when the listing was shown in the previous result. The scan stops at the first HTTP 429 answer or after three failed registry requests in a row.</p>
<p>The registry holds tens of thousands of listings, and a full pass over the list took about 20 minutes at this rate on 19 November 2026. So a full pass runs from time to time, and the scans in between are passes over updated listings. A pointer can only appear in a newly published version, which such a pass reads. Every listing shown in the previous result is checked again in every scan, and one whose check finds that it names no declaration is moved to "No longer listed". The front page gives the time of the last scan and says which kind of pass it was.</p>
<p>For each listing with a pointer the scanner runs the logic of <code>check-listing --fetch-tools</code> from the public checker, imported from its published code. That check reads the listing by name and version, fetches the declaration the pointer names from the publisher's domain, compares its hash, name, version and remotes with the listing, looks up the key by DNS or at the domain's web server and verifies the signature and the time window, reads newer declarations for the same version next to it, and reads the tool list from the declared remote to compare it with the declaration in force. Every request is listed on the listing page.</p>
<p>A scan that does not finish, or whose result fails a sanity check (a full pass that read no listings, fewer than half the listings of the last full pass, or no publisher metadata at all), is not published: the previous result stays in place and the failure is shown on the front page. Each published scan is also kept as a dated file.</p>

<h2>What a result shows</h2>
<p>A result of <code>verified</code> or <code>verified_newer_declaration</code> shows, on the date of the check:</p>
<ul class="plain">
<li>the holder of the key named in the declaration signed exactly that content, and that key was published at the declared domain by the declared method;</li>
<li>that domain proves the listing's namespace under the registry's rules;</li>
<li>the listing the registry served names this declaration by its hash, the publisher's site served it, and its name, version and remotes equal the listing's;</li>
<li>for <code>verified_newer_declaration</code>, the declaration in force follows the named one under the same key and is the newest one the publisher's site served;</li>
<li>when the tool list was compared, the list the declared remote sent equals the declared one (for format 0.2, its two digests under mcp-tool-set-digest/1).</li>
</ul>

<h2>What a result does not show</h2>
<ul class="plain">
<li>that the server, its publisher or any tool is harmless, honest or lawful;</li>
<li>that the server returns these tools to every client, or that the tools behave as described;</li>
<li>that the remote endpoints are operated by the publisher (a domain can declare an endpoint on another party's host);</li>
<li>that a pay address belongs to the publisher, or that a payment request at call time matches;</li>
<li>that this is the newest declaration the key holder signed (the publisher's site chooses which one it serves), or that no newer one exists beyond the two paths read;</li>
<li>that another registry, mirror or client is given the same listing;</li>
<li>that the tool list a client receives later, or under another protocol version or authorization, is the one compared;</li>
<li>across a change of key, that the same holder signed both linked declarations.</li>
</ul>

<h2>Limits of the tool check</h2>
<p>A server that asks for authorization leaves the tool list not compared, and the state stays <code>verified</code> or <code>verified_newer_declaration</code>; the listing page says so. A tool list can differ by MCP protocol version and authorization while the server changed nothing, so each page names the protocol version the check used. The digests of format 0.2 read some lists the same way (for example a missing description and an empty one), and when two tools share a name they do not pin which tool carries an annotation; the checker notes such lists.</p>

<h2>Limits of this site</h2>
<ul class="plain">
<li>Each result is a snapshot from one check on one day. A listing, a site or a server can change the next minute.</li>
<li>Listing names, titles and descriptions are publisher text from the registry. They are shown escaped and shortened, and email addresses in them are removed.</li>
<li>The registry does not check publisher metadata or remotes. A listing can point to anything; the check reports what it found.</li>
<li>The registry asks host applications to read it through aggregators. This site reads the list at a low rate, at most one request per second, and reads single listings only for the listings it checks.</li>
<li>No result here is a rating, a score or a recommendation.</li>
</ul>

<h2>Independence and AI assistance</h2>
<p>${esc(INDEPENDENCE)} The site, the scanner and the checker were written with substantial AI assistance. The code, data and tests of this site are public: ${httpsLink(SITE_SOURCE, SITE_SOURCE)}. The checker's code and tests are public: ${httpsLink(CHECKER_SOURCE, CHECKER_SOURCE)}.</p>

<h2>Data</h2>
<p>The full result of the last scan is at ${localLink('data.json', 'data.json')}. Every published scan is kept as a dated file in the site repository. The pages use no JavaScript, no cookies, no trackers and no outside requests. The typefaces (Libre Caslon Text, Libre Caslon Display and DM Mono, under the SIL Open Font License) are served from this site.</p>

<h2>Reporting a wrong result</h2>
<p>If a result here does not match what the check finds for you, open an issue on the ${httpsLink(SITE_ISSUES, 'issues page of the site repository')} with the listing name, the version and the output of the command on its listing page (add <code>--json</code>). Problems with the checker or the spec go to the ${httpsLink(CHECKER_ISSUES, 'issues page of the public checker')}. The site does not accept or remove listings by request.</p>
<p class="muted">Last complete scan: ${esc(formatDateTime(latest.scanFinishedAt))}.</p>
`;
  return layout({ title: 'Method and limits | Declared', description: 'How the scan and the check work, and what a result does and does not show.', body: sectioned(body), canonical: 'method', current: 'method' });
}

function notFoundPage() {
  const body = `<div class="row head">
<div class="b">
<h1>Page not found</h1>
<p class="lead">There is no page at this address. The list of listings is on the <a href="/">front page</a>.</p>
<div class="blank" aria-hidden="true"></div>
</div>
</div>`;
  return layout({ title: 'Page not found | Declared', description: 'Page not found.', body, absolute: true });
}

function feed(latest, files, status) {
  const pick = (r) => ({
    name: r.name,
    version: r.version,
    title: r.title ?? null,
    state: r.state,
    exitCode: r.exitCode,
    result: stateSentence(r),
    checkedAt: r.checkedAt,
    page: pageUrl(`listing/${files.get(r.name)}`),
    registryUrl: safeHttpsUrl(r.registryUrl),
    pointer: r.pointer ?? null,
    declarationNamed: r.declarationNamed ?? null,
    inForce: r.inForce ?? null,
    declaration: r.declaration ?? null,
    keySource: r.keySource ?? null,
    tools: r.tools ?? null,
    toolSetDigest: r.toolSetDigest ?? null,
    reasons: strings(r.reasons),
    checked: strings(r.checked),
    notChecked: strings(r.notChecked),
    notes: strings(r.notes),
    command: repeatCommand(r.name, r.version, latest.registry),
  });
  // Counts named for what they count: pointers seen in this scan's list read,
  // and the listings in this feed.
  const c = latest.counts && typeof latest.counts === 'object' ? latest.counts : {};
  const { withPointer, ...rest } = c;
  const counts = { ...rest, pointersInListRead: Number.isInteger(c.pointersInListRead) ? c.pointersInListRead : Number.isInteger(withPointer) ? withPointer : null, listed: latest.listings.length };
  const f = status && status.lastFailure && Date.parse(status.lastFailure.at) > Date.parse(latest.scanFinishedAt) ? { at: status.lastFailure.at, reason: status.lastFailure.reason } : null;
  return {
    schema: 'declaredlist/feed-1',
    site: SITE_URL,
    note: 'Dated results of check-listing from the public checker. Independent of the Model Context Protocol project, and not affiliated with or endorsed by it or its registry. The authors of this site also publish the listing com.rtlpdf/arabic-pdf. No result is a rating.',
    scan: { startedAt: latest.scanStartedAt, finishedAt: latest.scanFinishedAt, registry: latest.registry, checker: latest.checker ?? null, method: latest.method ?? null },
    lastFailedAttempt: f,
    counts,
    listings: latest.listings.map(pick),
    withdrawn: Array.isArray(latest.withdrawn) ? latest.withdrawn : [],
  };
}

// Rows newest first by their check time. History files are read in file name
// order, and "2026-11-19T145711Z.json" sorts before "2026-11-19.json", which
// can hold the later scan of that day. Rows without a time go last.
export function byTimeNewestFirst(rows) {
  const at = (r) => {
    const v = Date.parse(r && r.checkedAt);
    return Number.isFinite(v) ? v : -Infinity;
  };
  return [...rows].sort((x, y) => at(y) - at(x));
}

// Results of earlier scans for each name, newest first, from data/history.
function readHistory(dataDir) {
  const dir = path.join(dataDir, 'history');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}(T\d{6}Z(-\d{1,3})?)?\.json$/.test(f)).sort().reverse().slice(0, MAX_HISTORY_FILES);
  } catch {
    return new Map();
  }
  const by = new Map();
  for (const f of files) {
    let h;
    try {
      // History files are data like latest.json: cleaned the same way.
      h = sanitizeData(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {
      continue;
    }
    if (!h || !Array.isArray(h.listings)) continue;
    for (const r of h.listings) {
      if (!r || typeof r.name !== 'string') continue;
      if (!by.has(r.name)) by.set(r.name, []);
      const list = by.get(r.name);
      if (list.length <= MAX_EARLIER_ROWS && !list.some((x) => x.checkedAt === r.checkedAt)) list.push({ checkedAt: r.checkedAt, version: r.version, state: r.state });
    }
  }
  return by;
}

// Runs of results from the month digests in data/history (written by
// scan/history.js from snapshots older than about six weeks), for each name,
// newest first.
function readMonthRuns(dataDir) {
  const dir = path.join(dataDir, 'history');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, MAX_MONTH_FILES);
  } catch {
    return new Map();
  }
  const by = new Map();
  const isTime = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
  for (const f of files) {
    let m;
    try {
      m = sanitizeData(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {
      continue;
    }
    if (!m || !Array.isArray(m.listings)) continue;
    for (const l of m.listings) {
      if (!l || typeof l.name !== 'string' || !Array.isArray(l.runs)) continue;
      if (!by.has(l.name)) by.set(l.name, []);
      const list = by.get(l.name);
      for (const run of [...l.runs].reverse()) {
        if (list.length >= MAX_MONTH_RUNS) break;
        if (!run || !isTime(run.firstCheckedAt) || !isTime(run.lastCheckedAt)) continue;
        list.push({ firstCheckedAt: run.firstCheckedAt, lastCheckedAt: run.lastCheckedAt, checks: Number.isInteger(run.checks) && run.checks > 0 ? run.checks : 1, version: run.version, declaration: typeof run.declaration === 'string' ? run.declaration : null, state: run.state });
      }
    }
  }
  return by;
}

// Every string in the data, with email addresses and local paths removed again
// (the scanner already does this; data/ may come from elsewhere).
export function sanitizeData(v, depth = 0) {
  if (depth > 20) return null;
  if (typeof v === 'string') return redactEmails(scrubPaths(v));
  if (Array.isArray(v)) return v.map((x) => sanitizeData(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (k !== '__proto__') out[k] = sanitizeData(x, depth + 1);
    return out;
  }
  return v;
}

// The rules are in lib/validate.js, which the scanner applies before it
// publishes a scan.
export function validateLatest(latest) {
  const problem = latestProblem(latest);
  if (problem) throw new Error(`data/latest.json ${problem}; nothing was built`);
}

// Builds into a fresh folder next to outDir, then puts it in place, so a
// failed build leaves the previous dist/ as it was. The previous dist/ is
// moved aside first and removed only after the new one is in place; if that
// move fails, the previous one is put back. rename is replaceable in tests.
export function buildSite({ dataDir, outDir, rename = fs.renameSync, census, censusConfigFile = CENSUS_CONFIG_FILE }) {
  const latest = sanitizeData(readJsonIfExists(path.join(dataDir, 'latest.json')));
  validateLatest(latest);
  const cen = censusFor(census, dataDir, censusConfigFile);
  WITH_CENSUS = Boolean(cen);
  try {
    return writeSite({ dataDir, outDir, rename, latest, cen });
  } finally {
    WITH_CENSUS = false;
  }
}

// Whether this build includes the census, and its data. census: undefined
// reads build/census.config.json, and only "publish": true turns it on; a
// missing or unreadable config file is the switch off, so the daily build never
// depends on it. true or false overrides "publish" (a preview build); an
// object is a whole config (tests). With the census off nothing under
// data/census is read and the config is not checked.
function censusFor(census, dataDir, configFile) {
  if (census === false) return null;
  if (census === undefined && !censusSwitchOn(configFile)) return null;
  const cfg = census && typeof census === 'object' ? checkCensusConfig(census) : readCensusConfig(configFile);
  if (typeof census === 'object' && cfg.publish !== true) return null;
  return { cfg, ...loadCensus(dataDir, cfg) };
}

function writeSite({ dataDir, outDir, rename, latest, cen }) {
  let status = null;
  try {
    status = sanitizeData(readJsonIfExists(path.join(dataDir, 'status.json')));
  } catch {
    status = null;
  }
  latest.listings = [...latest.listings].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = assignFileBases(latest.listings.map((r) => r.name));
  for (const b of files.values()) if (!isSafeFileBase(b)) throw new Error('an unsafe file name was produced; nothing was built');
  const history = readHistory(dataDir);
  const monthRuns = readMonthRuns(dataDir);

  const tmp = `${outDir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'listing'), { recursive: true });
  const write = (rel, content) => {
    const target = path.resolve(tmp, rel);
    if (!target.startsWith(path.resolve(tmp) + path.sep)) throw new Error('refusing to write outside the output folder');
    fs.writeFileSync(target, content);
  };
  write('style.css', fs.readFileSync(path.join(HERE, 'style.css')));
  // The tab icon: the D of the wordmark on register paper, beside the red
  // margin line (drawn from the Libre Caslon Display outline).
  write('favicon.svg', fs.readFileSync(path.join(HERE, 'favicon.svg')));
  // The typefaces, served from the site itself, with their licences.
  fs.mkdirSync(path.join(tmp, 'fonts'));
  for (const f of fs.readdirSync(FONT_DIR)) if (FONT_FILE_RE.test(f)) write(path.join('fonts', f), fs.readFileSync(path.join(FONT_DIR, f)));
  // Response headers for Cloudflare Pages (the file itself is not served).
  write('_headers', HEADERS);
  write('index.html', indexPage(latest, files, status));
  write('publishers.html', publishersPage());
  write('method.html', methodPage(latest));
  write('404.html', notFoundPage());
  for (const r of latest.listings) {
    const file = files.get(r.name);
    const hist = byTimeNewestFirst((history.get(r.name) || []).filter((h) => h.checkedAt !== r.checkedAt)).slice(0, MAX_EARLIER_ROWS);
    write(path.join('listing', `${file}.html`), listingPage(r, file, hist, latest, monthRuns.get(r.name) || []));
  }
  write('data.json', JSON.stringify(feed(latest, files, status), null, 2) + '\n');
  if (cen) {
    const helpers = { layout, section, railed, contentsList, fact, hashHtml, issuesUrl: SITE_ISSUES, authorsListing: [...AUTHORS_LISTINGS][0] };
    write('census.css', fs.readFileSync(path.join(HERE, 'census.css')));
    write('census.html', censusPage(cen.snap, cen.corrections, cen.cfg, helpers));
    write('census.json', JSON.stringify(censusPublic(cen.snap, cen.corrections, pageUrl('census')), null, 2) + '\n');
  }
  write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  const day = isoDay(latest.scanFinishedAt);
  const urls = ['index', 'method', 'publishers', ...(cen ? ['census'] : []), ...latest.listings.map((r) => `listing/${files.get(r.name)}`)];
  write(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(pageUrl(u))}</loc><lastmod>${day}</lastmod></url>`).join('\n')}\n</urlset>\n`,
  );
  const old = `${outDir}.tmp-old-${process.pid}`;
  fs.rmSync(old, { recursive: true, force: true });
  const hadOld = fs.existsSync(outDir);
  if (hadOld) rename(outDir, old);
  try {
    rename(tmp, outDir);
  } catch (e) {
    if (hadOld) {
      try {
        rename(old, outDir);
      } catch {
        // the previous site stays in the folder named above
      }
    }
    throw e;
  }
  if (hadOld) fs.rmSync(old, { recursive: true, force: true });
  return { pages: latest.listings.length + 5 + (cen ? 1 : 0), files, census: Boolean(cen) };
}

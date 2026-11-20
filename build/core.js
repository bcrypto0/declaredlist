// Static site generator for declaredlist.com. Reads data/ and writes dist/.
// Every string from data/ came from the registry, a publisher's site or a
// server, so every one is escaped (esc) and cut short; outside links are
// accepted only as plain https URLs (httpsLink). Pages carry no script, no
// external request and no cookie.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, escClip, httpsLink, localLink, safeHttpsUrl } from '../lib/html.js';
import { formatDate, formatDateTime, isoDay, clip, redactEmails, scrubPaths } from '../lib/text.js';
import { stateSentence, stateLabel, toolsSentence, knownState } from '../lib/states.js';
import { assignFileBases, isSafeFileBase } from '../lib/names.js';
import { readJsonIfExists } from '../lib/fsutil.js';
import { CHECKER_SOURCE, CHECKER_ISSUES } from '../lib/checker.js';
import { latestProblem } from '../lib/validate.js';

export const SITE_URL = 'https://declaredlist.com';
// The public repository of this site (code, data and tests) and its issues page.
export const SITE_SOURCE = 'https://github.com/bcrypto0/declaredlist';
export const SITE_ISSUES = `${SITE_SOURCE}/issues`;
// The Content Security Policy of every page: in a meta element, and in the
// _headers file Cloudflare Pages reads, which adds frame-ancestors (a meta
// element cannot carry it).
export const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";
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
const MAX_HISTORY_FILES = 400;
// Month digests of older scans (scan/history.js) and the runs shown per listing.
const MAX_MONTH_FILES = 120;
const MAX_MONTH_RUNS = 60;
// Daily results shown per listing: more than the days the scanner keeps as
// snapshots (HISTORY_KEEP_DAYS in scan/history.js), so no day falls between
// the daily table and the month digests.
const MAX_EARLIER_ROWS = 200;
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

// Cloudflare Pages serves a page at its address without .html (a request for
// /method.html is redirected to /method, and /index.html to /), so canonical
// links, the sitemap and the feed name pages that way.
export const pageUrl = (rel) => `${SITE_URL}/${rel === 'index' ? '' : rel}`;

const FOOTER = (root) => `<footer class="site"><div class="wrap">
<p>${esc(INDEPENDENCE)}</p>
<p>This site, its scanner and the checker it runs were written with substantial AI assistance. Every result except the scanner states not_checkable and check_error comes from the public checker, and most listing pages give the command that repeats the check.</p>
<p>A result that looks wrong, or a question about this site: ${httpsLink(SITE_ISSUES, 'issues page of the site repository')}. About the checker or the spec: ${httpsLink(CHECKER_ISSUES, 'issues page of the public checker')}. <a href="${esc(root + 'method.html')}">Method and limits</a>.</p>
</div></footer>`;

function layout({ title, description, body, root = '', canonical, absolute = false }) {
  const base = absolute ? '/' : root;
  // The front page as the folder it is served from (Pages redirects /index.html to /).
  const home = base || './';
  const nav = [
    [null, 'List'],
    ['method.html', 'Method'],
    ['publishers.html', 'Publishers'],
    ['data.json', 'Data'],
  ]
    .map(([href, text]) => `<a href="${esc(href === null ? home : base + href)}">${esc(text)}</a>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(pageUrl(canonical))}">` : ''}
<link rel="stylesheet" href="${esc(base + 'style.css')}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site"><div class="wrap">
<a class="brand" href="${esc(home)}">Declared<small>declaredlist.com</small></a>
<nav class="site" aria-label="Site">
${nav}
</nav>
</div></header>
<main id="main"><div class="wrap">
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

function listItems(items, n = 500) {
  if (!items.length) return '<p class="muted">None.</p>';
  return `<ul class="plain">\n${items.map((x) => `<li>${escClip(x, n)}</li>`).join('\n')}\n</ul>`;
}

function fact(label, valueHtml) {
  if (!valueHtml) return '';
  return `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>\n`;
}
const code = (v, n = 200) => (v ? `<code>${escClip(v, n)}</code>` : '');

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

function stateCell(r) {
  const known = knownState(r.state);
  return `<span class="state">${esc(known ? r.state : 'unknown')}</span><br>${esc(stateLabel(r.state))}`;
}

function digestLine(label, d) {
  if (!d || typeof d !== 'object') return '';
  const parts = [`${esc(s(d.result) || 'unknown')}`];
  if (d.declared) parts.push(`declared ${code(d.declared, 120)}`);
  if (d.computed) parts.push(`computed ${code(d.computed, 120)}`);
  if (d.code) parts.push(`code ${code(d.code, 40)}`);
  return fact(label, parts.join(', '));
}

function listingPage(r, file, hist, scan, older = []) {
  const name = s(r.name);
  const title = `${clip(name, 120)} | Declared`;
  const sentence = stateSentence(r);
  const tools = toolsSentence(r);
  const cmd = repeatCommand(r.name, r.version, scan.registry);
  const checkerVersion = scan.checker && typeof scan.checker.version === 'string' ? scan.checker.version : null;
  const D = r.declaration && typeof r.declaration === 'object' ? r.declaration : null;
  const P = r.pointer && typeof r.pointer === 'object' ? r.pointer : null;
  const N = r.declarationNamed && typeof r.declarationNamed === 'object' ? r.declarationNamed : null;
  const F = r.inForce && typeof r.inForce === 'object' ? r.inForce : null;
  const T = r.tools && typeof r.tools === 'object' ? r.tools : {};
  const G = r.toolSetDigest && typeof r.toolSetDigest === 'object' ? r.toolSetDigest : null;
  const requests = Array.isArray(r.requests) ? r.requests.slice(0, 40) : [];

  let body = `<p class="muted"><a href="../">List</a> / listing</p>
<h1>${escClip(name, 200)}</h1>
${r.title ? `<p><strong>${escClip(r.title, 200)}</strong></p>` : ''}
${r.description ? `<p class="muted">Description from the listing, as the publisher wrote it: ${escClip(r.description, 400)}</p>` : ''}
${AUTHORS_LISTINGS.has(name) ? '<p class="muted">The authors of this site publish this listing. The scan and the check treat it like every other listing.</p>' : ''}

<h2>Result</h2>
<p class="lead">${esc(sentence)}</p>
${tools ? `<p>${esc(tools)}</p>` : ''}
<dl class="facts">
${fact('Checked at', esc(formatDateTime(r.checkedAt)))}${fact('State', `<span class="state">${esc(knownState(r.state) ? r.state : 'unknown')}</span>${Number.isInteger(r.exitCode) ? `, exit code ${esc(r.exitCode)} of check-listing` : ''}`)}${fact('Listing version', code(r.version, 120))}${fact('Published in the registry', r.publishedAt ? esc(formatDateTime(r.publishedAt)) : '')}${fact('Registry status', r.registryStatus ? esc(clip(r.registryStatus, 60)) : '')}${fact('Registry entry', httpsLink(r.registryUrl, 'listing as the registry API serves it (JSON)'))}
</dl>
${strings(r.reasons).length ? `<h3>Reasons the checker gave</h3>\n${listItems(strings(r.reasons))}` : ''}

<h2>What was compared</h2>
<dl class="facts">
${P ? fact('Declaration pointer in the listing', httpsLink(P.url, P.url, 300)) + fact('Pointer hash', code(P.hash, 80)) : fact('Declaration pointer in the listing', esc('none read'))}${N ? fact('Declaration the listing names', `${code(N.hash, 80)}${N.format ? ` (${esc(clip(N.format, 60))})` : ''}${N.state ? `, verify state ${code(N.state, 60)}` : ''}`) : ''}${F && F.hash ? fact('Declaration in force', `${code(F.hash, 80)}${F.format ? ` (${esc(clip(F.format, 60))})` : ''}, ${F.source === 'pointer' ? 'the one the listing names' : `read from ${code(F.source, 80)}`}${F.url ? `<br>${httpsLink(F.url, F.url, 300)}` : ''}`) : ''}${D ? fact('Dates, key and remotes of', D.of === 'named' ? esc('the declaration the listing names (no declaration was put in force)') : esc('the declaration in force')) + fact('Issued at', D.issuedAt ? esc(formatDateTime(D.issuedAt)) : '') + fact('Expires at', D.expiresAt ? esc(formatDateTime(D.expiresAt)) : esc('no expiry time in the declaration')) + fact('Key', `${code(D.alg, 20)} ${code(D.keyId, 120)}`) + fact('Key published by', D.keyMethod ? `${esc(clip(D.keyMethod, 10))} method at ${code(D.keyDomain, 200)}` : '') : r.keyId ? fact('Key', `${code(r.alg, 20)} ${code(r.keyId, 120)}`) : ''}${fact('Key source', r.keySource ? esc(clip(r.keySource, 300)) : '')}${fact('Key record', r.keyRecord ? esc(clip(r.keyRecord, 120)) : '')}${D && Array.isArray(D.remotes) && D.remotes.length ? fact('Declared remotes', D.remotes.slice(0, 10).map((x) => `${code(x && x.type, 40)} ${httpsLink(x && x.url, x && x.url, 200)}`).join('<br>')) : ''}${fact('Tool list', T.check ? `check ${code(T.check, 20)}${T.result ? `, result ${code(T.result, 20)}` : ''}` : '')}${fact('Tool list read from', T.remote ? `${httpsLink(T.remote, T.remote, 200)}${T.protocolVersion ? ` with MCP protocol version ${code(T.protocolVersion, 40)}` : ''}${T.era ? ` (${T.era === 'modern' ? 'per request metadata, no session' : 'initialize flow'})` : ''}${Number.isInteger(T.pages) ? `, ${esc(T.pages)} page${T.pages === 1 ? '' : 's'}` : ''}` : '')}${fact('Tool check note', T.reason ? escClip(T.reason, 300) : '')}${G ? digestLine('Contract digest', G.contract) + digestLine('Extras digest', G.extras) : ''}
</dl>

<h3>Checked</h3>
${listItems(strings(r.checked))}
<h3>Not checked</h3>
${listItems(strings(r.notChecked))}
${strings(r.notes).length ? `<h3>Notes</h3>\n${listItems(strings(r.notes))}` : ''}
<h3>Requests the check made</h3>
${requests.length ? `<ul class="plain">\n${requests.map((q) => `<li>${esc(s(q.method) || 'GET')}${q.rpc ? ` ${esc(clip(q.rpc, 40))}` : ''} ${httpsLink(q.url, q.url, 200)}: ${q.error ? `failed (${escClip(q.error, 200)})` : Number.isInteger(q.status) ? `HTTP ${esc(q.status)}` : 'answered'}</li>`).join('\n')}\n</ul>` : '<p class="muted">None.</p>'}

<h2>Repeat this check</h2>
${cmd ? `<p>With Node 20 or later and a copy of the public checker (no dependencies, nothing to install):</p>
<pre><code>git clone ${esc(CHECKER_SOURCE)}
cd addon-declaration
${esc(cmd)}</code></pre>
<p class="muted">The result can differ from the one above if the listing, the publisher's site, the key, the server or the checker changed since ${esc(formatDate(r.checkedAt))}${checkerVersion ? ` (this result used addon-declare ${escClip(checkerVersion, 20)})` : ''}. Add <code>--json</code> for the full report.</p>` : '<p>This listing name or version cannot be written on a command line as it is, so no command is shown.</p>'}
`;
  if (hist.length) {
    body += `
<h2>Earlier results</h2>
<div class="table-wrap"><table class="list">
<thead><tr><th scope="col">Scan date</th><th scope="col">Version</th><th scope="col">State</th></tr></thead>
<tbody>
${hist.map((h) => `<tr><td data-label="Scan date">${esc(formatDate(h.checkedAt))}</td><td data-label="Version">${code(h.version, 60)}</td><td data-label="State">${stateCell(h)}</td></tr>`).join('\n')}
</tbody></table></div>`;
  }
  if (older.length) {
    body += `
<h2>Older results, by month</h2>
<p class="muted">Scans older than about six weeks are kept as one row per run: scans of one month that follow one another, each of which showed this listing with the same version, state and declaration.</p>
<div class="table-wrap"><table class="list">
<thead><tr><th scope="col">First check</th><th scope="col">Last check</th><th scope="col">Checks</th><th scope="col">Version</th><th scope="col">Declaration</th><th scope="col">State</th></tr></thead>
<tbody>
${older.map((h) => `<tr><td data-label="First check">${esc(formatDate(h.firstCheckedAt))}</td><td data-label="Last check">${esc(formatDate(h.lastCheckedAt))}</td><td data-label="Checks">${esc(h.checks)}</td><td data-label="Version">${code(h.version, 60)}</td><td data-label="Declaration">${h.declaration ? code(h.declaration, 80) : ''}</td><td data-label="State">${stateCell(h)}</td></tr>`).join('\n')}
</tbody></table></div>`;
  }
  body += `\n<p class="muted">From the scan finished ${esc(formatDateTime(scan.scanFinishedAt))}.</p>`;
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
  let out = fact('Last complete scan', esc(formatDateTime(latest.scanFinishedAt)));
  if (cov.mode === 'updated_since') {
    out += fact('Listings read in this scan', `${esc(n(c.listingsScanned))} (the latest version of each listing published or changed since ${esc(formatDateTime(cov.since))})`);
    out += fact('Of these, with a declaration pointer', esc(n(pointers)));
    if (full) out += fact('Last full pass over the registry', `${esc(formatDateTime(full.finishedAt))}: ${esc(n(full.listingsScanned))} listings read, ${esc(n(full.withPublisherMetadata))} with publisher metadata`);
  } else {
    out += fact('Listings scanned', `${esc(n(c.listingsScanned))} (the latest version of each listing in the registry, read in full)`);
    out += fact('With publisher metadata', esc(n(c.withPublisherMetadata)));
    out += fact('With a declaration pointer in this scan', esc(n(pointers)));
  }
  out += fact('Listings shown below', shown);
  return out;
}

function indexPage(latest, files, status) {
  const c = latest.counts || {};
  const n = (v) => (Number.isInteger(v) ? v.toLocaleString('en-US') : 'unknown');
  const rows = latest.listings
    .map((r) => {
      const file = files.get(r.name);
      return `<tr><td class="name" data-label="Listing">${localLink(`listing/${file}.html`, clip(s(r.name), 120))}</td><td data-label="Version">${code(r.version, 40)}</td><td data-label="Result">${stateCell(r)}</td><td data-label="Checked">${esc(formatDate(r.checkedAt))}</td></tr>`;
    })
    .join('\n');
  const withdrawn = Array.isArray(latest.withdrawn) ? latest.withdrawn.slice(0, 200) : [];
  const body = `<h1>Registry listings that point to an add on declaration</h1>
<p class="lead">Declared lists every server in the official MCP Registry whose listing points to an add on declaration, and shows the dated result of checking it with the public checker. A declaration is a short statement of what one server version offers (name, version, remotes and tool list, and optionally a price, a pay address and a contact), signed with the key of the domain the server is published under. Each result is a dated fact about what the check found on that day, including whether a signature was found and valid; it is not a rating of the server or its publisher.</p>
${failureNotice(status, latest)}
<dl class="facts">
${coverageFacts(latest, n)}${fact('Checker', `addon-declare ${code(latest.checker && latest.checker.version, 20)}, command <code>check-listing --fetch-tools</code>`)}
</dl>
<h2>Listings with a declaration pointer</h2>
${latest.listings.length ? `<div class="table-wrap"><table class="list">
<thead><tr><th scope="col">Listing</th><th scope="col">Version</th><th scope="col">Result</th><th scope="col">Checked</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
<p class="muted">Each result is what the check found at the time shown on the listing page. Open a listing for every checked fact and the command that repeats the check.</p>` : '<p>No listing carried a declaration pointer in this scan.</p>'}
${withdrawn.length ? `<h2>No longer listed</h2>
<p>These listings named a declaration in the previous published scan and do not now.</p>
<ul class="plain">${withdrawn.map((w) => `<li>${escClip(w.name, 120)}${w.version ? ` ${code(w.version, 40)}` : ''}: ${escClip(w.reason, 200)} (${esc(formatDate(w.checkedAt))})</li>`).join('\n')}</ul>` : ''}
<h2>Publishing a declaration</h2>
<p>A publisher with a domain namespace can sign a declaration with the key they already use for the registry and point to it from their listing. ${localLink('publishers.html', 'The steps')}.</p>
`;
  return layout({ title: 'Declared: MCP Registry listings that point to a declaration', description: 'Registry listings that point to an add on declaration, with dated check results.', body, canonical: 'index' });
}

function publishersPage() {
  const body = `<h1>Publishing a declaration</h1>
<p class="lead">A short path, taken from the README of the public checker. The README and the spec are the full reference: ${httpsLink(README_URL, 'README')}, ${httpsLink(SPEC_URL, 'SPEC.md')}.</p>
<p>You need a server published under a domain namespace (such as <code>com.example/weather</code>) with <code>mcp-publisher login dns</code> or <code>mcp-publisher login http</code>, and the private key you made for that login. Names under <code>io.github</code> are out of scope, because no domain key can prove them. The checker needs Node 20 or later and has no dependencies, so nothing needs installing.</p>
<h2>The short way: one command</h2>
<p>If your server is already listed in the registry, the checker can do the reading, signing and checking in one run. Clone it as in step 0 below, then, from the folder that holds your server.json, give the name of your listing and the version you are about to publish:</p>
<pre><code>${esc(TOOL)} prepare com.example/weather --for-version 1.4.1 --key-env MCP_PRIVATE_KEY</code></pre>
<p>The version must be a new one, because a published version cannot be changed. The run reads your listing and your key record, reads the tool list from your running server, and stops before signing if the private key is not the one you published. It links your last declaration, signs the new one, checks the result, and writes a folder <code>addon-declaration-out</code> with:</p>
<ul class="plain">
<li><code>site/</code>: the files to upload to your domain, at the paths they already have inside that folder;</li>
<li><code>pointer.json</code>: the block to put into the server.json of the new version;</li>
<li><code>NEXT_STEPS.txt</code>: the upload addresses, the edit to server.json, the publish step and the command that checks the listing afterwards.</li>
</ul>
<p>Add <code>--dry-run</code> to see what it would do without signing anything. If the new version changes your tools or your remotes, give <code>--tools</code> and <code>--server-json</code> for that build, as the README describes. After you publish the version with <code>mcp-publisher</code>, check the listing as this site does:</p>
<pre><code>${esc(TOOL)} check-listing com.example/weather --fetch-tools</code></pre>
<h2>The same steps by hand</h2>
<p>For a server that is not listed yet, or to run each step yourself.</p>
<ol class="steps" start="0">
<li><p>Get the checker. From the folder above the one that holds your server.json, clone it, so that it sits next to that folder:</p>
<pre><code>git clone ${esc(CHECKER_SOURCE)}</code></pre>
<p>Run every command below from the folder that holds your server.json. They call the checker by its path, <code>../addon-declaration/bin/addon-declare.js</code>; change that path if you cloned it somewhere else. Keep the private key out of that folder.</p></li>
<li><p>Save the <code>tools/list</code> result of this exact build as <code>tools.json</code>, as the server sent it, in UTF-8. If your server pages the list, save each page as its own file and give <code>--tools</code> once per page, in order, in every command below (for example <code>--tools tools-1.json --tools tools-2.json</code>). If the answer arrived as server sent events (lines starting with <code>event:</code> and <code>data:</code>), save only the JSON-RPC message the <code>data:</code> lines carry, without that framing.</p></li>
<li><p>Create the unsigned declaration from your server.json. Its version must be one you have not published in the registry yet, because a published version cannot be changed. If you logged in with <code>mcp-publisher login http</code>, add <code>--method http</code>: without it the declaration names the dns method, and every check looks for a TXT record at your domain.</p>
<pre><code>${esc(TOOL)} init --server-json server.json --tools tools.json --expires-in-days 180 --out unsigned.json</code></pre>
<p>If you change the version in server.json afterwards, run this step and the next one again; otherwise the check reports that the declaration differs from the listing (<code>listing_mismatch</code>). The README lists the other options, such as a price per call, a contact and a link to your last declaration.</p></li>
<li><p>Sign it. Give the name of an environment variable that holds the key (set from a secret store, not typed on the command line), or a key file kept outside the repository:</p>
<pre><code>${esc(TOOL)} sign unsigned.json --key-env MCP_PRIVATE_KEY --out declaration.json</code></pre>
<p>It prints the proof record the key matches: a TXT record at your domain for the dns method, or a line of <code>https://&lt;your domain&gt;/.well-known/mcp-registry-auth</code> for the http method. It must be one you already published.</p></li>
<li><p>Check it the way a reader would:</p>
<pre><code>${esc(TOOL)} verify declaration.json --tools tools.json</code></pre></li>
<li><p>Serve it at the paths <code>sign</code> printed: <code>/.well-known/addon-declaration/&lt;namespace&gt;/&lt;server&gt;/by-hash/&lt;hex&gt;.json</code> (keep every one of these), <code>.../versions/&lt;version&gt;.json</code>, and <code>.../latest.json</code> when this is your newest declaration. Here <code>&lt;hex&gt;</code> is the 64 hex digits of the declaration hash, without its <code>sha256:</code> prefix.</p></li>
<li><p>Point to it from server.json, with the same <code>&lt;hex&gt;</code>:</p>
<pre><code>"_meta": {
  "io.modelcontextprotocol.registry/publisher-provided": {
    "addonDeclaration": {
      "url": "https://example.com/.well-known/addon-declaration/com.example/weather/by-hash/&lt;hex&gt;.json",
      "hash": "sha256:&lt;hex&gt;"
    }
  }
}</code></pre>
<p>The URL must be exactly the by-hash path on the domain the namespace names (or a parent of it), with the same hash.</p></li>
<li><p>Publish the version with <code>mcp-publisher</code>, then check the listing as this site does:</p>
<pre><code>${esc(TOOL)} check-listing com.example/weather --fetch-tools</code></pre>
<p>A scan after the version is published lists it; the front page gives the time of the last scan. Each release that passes the previous signed declaration to <code>--previous</code> builds a history that a check can follow. The checker repository has a GitHub Action and a sample workflow for signing on release.</p></li>
</ol>
<p class="muted">Publishing a declaration is free and needs no account with this site. The site lists what the registry serves and what the check finds; it does not accept or remove listings by request.</p>
`;
  return layout({ title: 'Publishing a declaration | Declared', description: 'How a publisher signs an add on declaration with the public checker, in one command or step by step, and points to it from a registry listing.', body, canonical: 'publishers' });
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
<p>The full result of the last scan is at ${localLink('data.json', 'data.json')}. Every published scan is kept as a dated file in the site repository. The pages use no JavaScript, no cookies, no trackers and no outside requests.</p>

<h2>Reporting a wrong result</h2>
<p>If a result here does not match what the check finds for you, open an issue on the ${httpsLink(SITE_ISSUES, 'issues page of the site repository')} with the listing name, the version and the output of the command on its listing page (add <code>--json</code>). Problems with the checker or the spec go to the ${httpsLink(CHECKER_ISSUES, 'issues page of the public checker')}. The site does not accept or remove listings by request.</p>
<p class="muted">Last complete scan: ${esc(formatDateTime(latest.scanFinishedAt))}.</p>
`;
  return layout({ title: 'Method and limits | Declared', description: 'How the scan and the check work, and what a result does and does not show.', body, canonical: 'method' });
}

function notFoundPage() {
  const body = `<h1>Page not found</h1>
<p>There is no page at this address. The list of listings is on the <a href="/">front page</a>.</p>`;
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
export function buildSite({ dataDir, outDir, rename = fs.renameSync }) {
  const latest = sanitizeData(readJsonIfExists(path.join(dataDir, 'latest.json')));
  validateLatest(latest);
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
  // Response headers for Cloudflare Pages (the file itself is not served).
  write('_headers', HEADERS);
  write('index.html', indexPage(latest, files, status));
  write('publishers.html', publishersPage());
  write('method.html', methodPage(latest));
  write('404.html', notFoundPage());
  for (const r of latest.listings) {
    const file = files.get(r.name);
    const hist = (history.get(r.name) || []).filter((h) => h.checkedAt !== r.checkedAt).slice(0, MAX_EARLIER_ROWS);
    write(path.join('listing', `${file}.html`), listingPage(r, file, hist, latest, monthRuns.get(r.name) || []));
  }
  write('data.json', JSON.stringify(feed(latest, files, status), null, 2) + '\n');
  write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  const day = isoDay(latest.scanFinishedAt);
  const urls = ['index', 'method', 'publishers', ...latest.listings.map((r) => `listing/${files.get(r.name)}`)];
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
  return { pages: latest.listings.length + 5, files };
}

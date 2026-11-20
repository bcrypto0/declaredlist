# declaredlist.com: scanner and static site

Declared (declaredlist.com) lists every server listing in the official MCP Registry that points to an add on declaration, and shows for each one a dated result of checking it with the public checker [addon-declare](https://github.com/bcrypto0/addon-declaration) (the command `check-listing --fetch-tools`). It also says how many listings were read and how many carry a declaration pointer.

A declaration is a short statement of what one server version offers (name, version, remotes and tool list, and optionally a price, a pay address and a contact), signed with the key of the domain the server is published under. The pointer is `server._meta["io.modelcontextprotocol.registry/publisher-provided"].addonDeclaration`, an object with `url` and `hash` (sections 8 and 8a of the checker's SPEC.md).

Each result is a dated fact about what one check found on one day. No result is a rating, a score or a recommendation of a server, a listing or a publisher.

This repository holds the scanner, the static site generator, the tests and the scan data (`data/`). Node 20 or later, no dependencies, nothing to install.

## Independence and AI assistance

Declared is independent of the Model Context Protocol project. It is not affiliated with or endorsed by the Model Context Protocol project or its registry.

The authors of this site also publish the listing `com.rtlpdf/arabic-pdf` (rtlpdf.com). The scan and the check treat it like every other listing, and its listing page says who publishes it.

The site, the scanner and the checker were written with substantial AI assistance. The code, the tests and every published scan are public, so each result can be checked again with the command shown on its listing page.

## How it runs

* Once a day, the GitHub Actions workflow `.github/workflows/daily-scan.yml` checks out this repository and the checker at a pinned commit, runs the tests, runs one scan, builds the site from the new data as a check (outside the checkout), and commits `data/` back to `main` as `github-actions[bot]`. A failed setup step, failed tests, and data the build refuses are recorded in `data/status.json` instead of a new scan, so nearly every run makes a commit and the front page shows the failure. The subject of that commit is read from `data/status.json` (`scan/commit-message.js`) and says `success` only when a scan was published. A failed checkout of this repository itself, or a step that fails before it can write `data/status.json`, leaves no record in `data/`; the failed run in the Actions tab is the record of that. The workflow token is given to git only in the commit step.
* Cloudflare Pages builds the site from `main` through its Git integration on every push: build command `node build/build.js`, output folder `dist`. No deploy token or other secret is stored in this repository. The build reads only `data/`; it does not need the checker.
* `.github/workflows/test.yml` runs the tests and a build on every push by a person and every pull request, with read only permissions. The daily data commits are pushed with the workflow token, which starts no workflow; they are tested and built by the daily job before the push, and built by Cloudflare Pages after it.
* `data/` on `main` is written by the daily job only. A hand edit to `data/` pushed while a run is going makes that run's push fail; the next run repeats the scan from the data on `main`.

## Layout

* `scan/`: the scanner. `scan.js` is the command, `core.js` the resumable scan that publishes only complete results, `registry.js` the rate limited registry client, `check.js` the check of one listing (the checker's `checkListing`, imported by path, with `fetchTools: true`), `next-pass.js` the choice of pass for a scheduled run, `record-failure.js` the record of failed tests or a refused build in `data/status.json`.
* `build/`: the static generator. `build.js` is the command, `core.js` the pages, `style.css` the one stylesheet, `fonts/` the typefaces the pages use (WOFF2 files with their licences; `fonts/FONTS.md` names each family, its source and its licence).
* `lib/`: shared helpers (HTML escaping and link checks, file names from listing names, state sentences, text cleaning, loading the checker, and `validate.js`, the rules a scan result must meet to be built).
* `data/`: written by the scanner. `latest.json` (the last complete scan), `history/<date>.json` (one full snapshot per published scan, created once and not changed; a second scan on the same day gets the time in its name), `history/<YYYY-MM>.json` (one digest per month, made from the snapshots older than 45 days, which are then removed from the folder), `status.json` (last attempt, last success, last failures). `data/.scan/` holds the progress of an unfinished scan and the lock; it is not committed (the daily workflow keeps it in the Actions cache).
* `dist/`: written by the build. This is the site. It is not committed.
* `test/`: `node:test` suites; `testlib/`: fixtures and wording rules for them.

## Running it

The scanner and the tests need a copy of the checker. By default they look for it at `../public-repo/addon-declaration`; point `DECLARED_CHECKER_DIR` at any other copy:

```
git clone https://github.com/bcrypto0/addon-declaration
DECLARED_CHECKER_DIR=$PWD/addon-declaration node --test
```

Build the site from `data/` (no checker needed):

```
node build/build.js
```

Run a scan (this reads the live registry; see the rate limits below):

```
node scan/scan.js                 # full pass over the registry list
node scan/scan.js --since auto    # pass over listings published or changed since the last scan
node scan/scan.js --since 2026-11-19T00:00:00Z
node scan/next-pass.js            # prints "full" or "since": what a scheduled run would do
```

Options of `scan.js`: `--fresh` (ignore saved progress), `--max-minutes <n>` (time budget of one run, default 60, at most 300; the next run continues), `--data <dir>`. `DECLARED_REGISTRY` sets another registry base with the same API (an https URL, or `http://127.0.0.1:<port>` for a local test double). Exit code 0 when a new `data/latest.json` was written, 2 when the scan failed, stopped or could not start, 1 for usage errors. Every attempt that gets past the command line is recorded in `data/status.json`, including a failure before the scan starts (the checker not found, `--since auto` without a published scan) and a start refused because another scan holds the lock, so the front page shows it.

## The scan

1. Reads `GET /v0/servers?version=latest&limit=100` page by page with the cursor (plus `updated_since` with `--since`). The list answer includes each listing's `server._meta`, publisher metadata included (checked against the live API on 19 November 2026), so no listing has to be read on its own to find the pointers.
2. For each listing with a pointer (or whose publisher metadata is present but not a JSON object, which the checker reports as `pointer_malformed`), and each listing shown in the last published scan, runs the checker's `checkListing` with `fetchTools: true`. A listing shown before that a full pass did not find in the list is checked at the version found before, and withdrawn only when that check gives `registry_not_found` or `no_declaration`. A check that gives `no_declaration` moves a listing shown before to "No longer listed", in every kind of pass. A check that ends in `registry_unreachable`, `declaration_unreachable` or `key_lookup_failed` is run once more after 5 seconds before its result is stored. Each record keeps the state, exit code, reasons, declaration hashes and formats, issue and expiry time, key id and source, the tool check, what was checked and not checked, notes and every request.
3. Checks the result, writes a new `data/history/` file, then `data/latest.json`, then `data/status.json`. A scan whose history file cannot be written is not published. After that, snapshots older than 45 days are folded into the digest of their month (`scan/history.js`) and removed from the folder: the digest keeps one row per scan and, for each listing, one row per run (scans of that month that follow one another, each of which showed the listing with the same version, state and declaration), with the first check, the last check and the number of checks. The listing pages show these runs under the daily results. The full snapshots stay in the git history of the repository, and each digest names the files it was made from.

Rate limits: every registry request (list pages and the checker's single listing reads) goes through one client that starts at most one request per second, sends `User-Agent: declaredlist.com-scanner/0.1 (+https://declaredlist.com; ...)`, follows no redirect, stops the whole scan at the first HTTP 429, retries a failed list page twice (after 5 and 20 seconds), and stops after three failures in a row. Only GET reads of single listings are sent to the registry host during a check. Requests to publishers' domains and MCP remotes go through the checker's own fetch (public addresses only, no redirects, size and time limits), with the checker's own User-Agent.

Resuming: progress is saved after every page and every check in `data/.scan/state.json`. A run that stops (HTTP 429, failures, the time budget, a crash) is continued by a later run of the same kind while its progress was saved less than 48 hours ago and the scan started less than 7 days ago. Scheduled runs are 24 hours apart, so a stopped pass is continued by the next run instead of started over. A lock in `data/.scan/lock.json` keeps two scans from running at once; a lock not refreshed for six hours is taken over, and a lock that cannot be read is left for a person to remove.

Publishing only complete results: `data/latest.json` is replaced only by a scan that finished and passed its checks. A full pass is rejected when it read no listings, fewer than half the listings of the last full pass, or no publisher metadata at all while the last full pass found some. Every scan is also held to the rules the build applies (`lib/validate.js`): a pass over updated listings that read no listing is published only when it rests on a full pass that read some, and a result with more than 5,000 listings is rejected. A failed or rejected scan leaves `data/latest.json` as it was and records the failure in `data/status.json`; the site then shows the last complete scan with a notice. A damaged `latest.json` stops the scan instead of being overwritten.

### Full passes and passes over updated listings

The registry held about 67,000 listings (latest versions) in November 2026, and a full pass at one request per second took about 20 minutes on 19 November 2026. So the daily workflow (through `scan/next-pass.js`) runs:

* a full pass on Sundays (UTC), when no published scan rests on a full pass, and whenever a full pass that stopped can still be continued (it is finished before any other pass);
* otherwise `--since auto`: only listings published or changed since the start of the last published scan, less two hours. A pointer can only appear in a newly published version, which such a pass reads. Every listing shown before is checked again, so a changed or removed pointer is seen.

Saved progress that can no longer be continued does not start a full pass on a weekday; that day runs `--since auto`. The front page and `data.json` say which kind of pass a result comes from (`coverage.mode`, `coverage.since`, `coverage.lastFullPass`).

## The build

`node build/build.js` reads `data/` and writes `dist/`: `index.html`, one page per listing under `listing/`, `publishers.html`, `method.html`, `404.html`, `data.json` (feed), `robots.txt`, `sitemap.xml`, `style.css`, `fonts/` (the typefaces, served from the site itself) and `_headers` (response headers for Cloudflare Pages: a Content Security Policy with `default-src 'none'`, `font-src 'self'` and `frame-ancestors 'none'`, `nosniff`, `no-referrer`, and `X-Robots-Tag: noindex` on the project's `pages.dev` addresses, which serve the same pages). Pages serves each page at its address without `.html` (for example `/method`), so canonical links, `sitemap.xml` and the page links in `data.json` use that form; links between pages are relative and keep `.html`, so `dist/` also works from any static server. No `_redirects` file is needed. It builds into a temporary folder and replaces `dist/` only when the build succeeded. It refuses data without scanned listings.

Untrusted input: every string from the registry, a declaration or a server is cleaned (controls dropped, every invisible or direction character shown as `[U+XXXX]`), cut short and HTML escaped. Email addresses, including ones split by invisible characters, and local file paths are removed from the data again at build time. Outside links are emitted only for plain https URLs without user name or password, with `rel="noopener noreferrer nofollow"`, and a link whose text is its own address shows the address it goes to (a host with letters outside ASCII in its `xn--` form). The pages use no JavaScript, no cookies, no trackers and no outside requests.

## Cloudflare Pages settings

* Production branch: `main`
* Build command: `node build/build.js`
* Build output directory: `dist`
* Root directory: the repository root
* Environment variable: `NODE_VERSION` = `22`
* Preview deployments: none (otherwise every pushed branch is served at a public `pages.dev` address)

## Repository settings

* Private vulnerability reporting: on (Settings, Code security), the route SECURITY.md names.
* Issues: on, the route for wrong results and questions.
* Actions: the daily workflow needs workflow permissions that let `GITHUB_TOKEN` write contents when the workflow asks for it; it asks for `contents: write` only.

## Tests

```
DECLARED_CHECKER_DIR=/path/to/addon-declaration node --test
```

The tests cover HTML escaping with hostile listing names and descriptions, invisible and tag characters, look alike hosts in links, link checks, file name sanitising and collisions, every checker state (read from the checker's own `LISTING_STATES`) mapped to dated sentences, the wording rules of the site text, publishing only complete results, the lock, resuming across runs a day apart, the choice of pass, the `updated_since` pass, withdrawal rules, the registry client, the checker's real `checkListing` run through the scanner against a registry double on the loopback address, the headers file, and a build from fixtures. They use no network other than the loopback address, and remove the temporary folders they make.

## Limits

* Each result is a snapshot from one check on one day. A listing, a site or a server can change the next minute.
* A result shows what the checker checked and nothing more; the method page of the site lists what a result does and does not show.
* Listing names, titles and descriptions are publisher text from the registry, shown cleaned, escaped and shortened.
* The checker's own User-Agent (`addon-declare/0.2`) is used for publishers' domains and MCP remotes; only registry requests carry the site's User-Agent.
* `latest.json` and the history snapshots are full copies of a scan. `data/history/` holds about 45 days of them and grows by one small digest per month; the git history of the repository still grows with every daily commit. A digest row gives the first and last check of a run and the number of checks, not each single day; it keeps at most 500 withdrawn rows per month, and the build reads the newest 120 digests.
* The site has no search, no per publisher pages and no feed other than `data.json`.
* `data.json` keeps URLs as the publisher wrote them (including look alike hosts); only the pages show the linked form.
* `data/latest.json` and `data/history/2026-11-19T145711Z.json` were written before the scanner changes of 19 November 2026 and were not rescanned: they carry `counts.withPointer` (the build reads it as `pointersInListRead`), records without `attempts`, and the declaration block without `of`. In the history file the field `websiteUrl` of `com.rtlpdf/arabic-pdf` reads `http[local path removed]` (a cleaning pattern of that time also matched `https://`; fixed, and corrected by hand in `data/latest.json` only). History files are left as written until they are folded into the digest of their month. The next scan writes the new fields.
* `coverage.lastFullPass` in `data/latest.json` (67,587 listings read, 2,703 with publisher metadata, finished 19 November 2026, 14:56 UTC) comes from a full pass whose own result was not published, so `data/history/` has no file for it. The next full pass writes one.
* The 404 page uses root relative links, so it shows unstyled when opened as a local file; served from the site root it is styled.

## Reporting a wrong result

If a result on the site does not match what the check finds for you, open an issue at https://github.com/bcrypto0/declaredlist/issues with the listing name, the version and the output of the command shown on its listing page (add `--json`). Problems with the checker or the spec go to https://github.com/bcrypto0/addon-declaration/issues. Vulnerabilities go through private reporting (see SECURITY.md). The site does not accept or remove listings by request.

## Licence

Apache License, Version 2.0. See LICENSE and NOTICE.

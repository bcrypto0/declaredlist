// The wording rules of the site text apply to the repository's public text as
// well: README, SECURITY, NOTICE and the comments in the workflow files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANNED, DASHES } from '../testlib/wording.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// Prose of a Markdown file: fenced blocks and inline code removed.
const prose = (md) => md.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
// Comment text of a YAML file.
const comments = (yml) =>
  yml
    .split('\n')
    .map((l) => l.match(/^\s*#(.*)$/))
    .filter(Boolean)
    .map((m) => m[1])
    .join('\n');
const WORKFLOWS = ['.github/workflows/daily-scan.yml', '.github/workflows/test.yml'];

test('public text follows the wording rules', () => {
  const texts = { 'README.md': prose(read('README.md')), 'SECURITY.md': prose(read('SECURITY.md')), NOTICE: read('NOTICE') };
  for (const f of WORKFLOWS) texts[f] = comments(read(f));
  for (const [f, t] of Object.entries(texts)) {
    for (const w of BANNED) assert.doesNotMatch(t, w, `${f}: ${w}`);
    assert.doesNotMatch(t, DASHES, `${f} has a dash used as punctuation`);
  }
});

test('the README states independence, AI assistance and where to report a wrong result', () => {
  const r = read('README.md');
  assert.match(r, /not affiliated with or endorsed by the Model Context Protocol project or its registry/);
  assert.match(r, /substantial AI assistance/);
  assert.match(r, /https:\/\/github\.com\/bcrypto0\/declaredlist\/issues/);
  assert.match(r, /Build command: `node build\/build\.js`/);
  assert.match(r, /Build output directory: `dist`/);
});

test('public text names no email address other than GitHub noreply addresses', () => {
  for (const f of ['README.md', 'SECURITY.md', 'NOTICE', 'package.json', ...WORKFLOWS]) {
    for (const m of read(f).matchAll(/[A-Za-z0-9._%+\[\]-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      assert.match(m[0], /@users\.noreply\.github\.com$/, `${f}: ${m[0]}`);
    }
  }
});

test('the workflows pin the checker and third party actions to full commit SHAs', () => {
  const shas = new Set();
  for (const f of WORKFLOWS) {
    const y = read(f);
    const sha = y.match(/^\s+CHECKER_SHA: ([0-9a-f]+)$/m);
    assert.ok(sha && sha[1].length === 40, `${f}: checker pinned to a full SHA`);
    shas.add(sha[1]);
    for (const m of y.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]}`);
  }
  assert.equal(shas.size, 1, 'both workflows use the same checker commit');
  const daily = read('.github/workflows/daily-scan.yml');
  assert.match(daily, /^permissions:\n  contents: write\n\n/m);
  assert.doesNotMatch(daily, /secrets\./);
  assert.match(read('.github/workflows/test.yml'), /^permissions:\n  contents: read\n/m);
});

test('the daily workflow keeps the token out of the checkout and checks the build before it pushes', () => {
  const daily = read('.github/workflows/daily-scan.yml');
  // Every checkout leaves no token in .git/config; only the commit step gets it.
  const checkouts = [...daily.matchAll(/uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n(?:        [^\n]*\n)+/g)].map((m) => m[0]);
  assert.equal(checkouts.length, 2);
  for (const c of checkouts) assert.match(c, /persist-credentials: false/);
  assert.equal((daily.match(/github\.token/g) || []).length, 1);
  assert.match(daily, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  // Only main runs the job, and a rerun saves its own cache entry.
  assert.match(daily, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.equal((daily.match(/key: scan-progress-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g) || []).length, 2);
  assert.match(daily, /restore-keys: scan-progress-\n/);
  // The build Pages runs is run first, outside the checkout.
  assert.match(daily, /node build\/build\.js --out "\$RUNNER_TEMP\/dist-check"/);
  assert.match(daily, /node scan\/record-failure\.js --phase tests/);
  assert.match(daily, /node scan\/record-failure\.js --phase build/);
  assert.match(daily, /41898282\+github-actions\[bot\]@users\.noreply\.github\.com/);
});

test('the README states what the site is independent of and that its authors publish a listing it shows', () => {
  const r = read('README.md');
  assert.match(r, /Declared is independent of the Model Context Protocol project\./);
  assert.doesNotMatch(r, /Declared is independent\./);
  assert.match(r, /The authors of this site also publish the listing `com\.rtlpdf\/arabic-pdf`/);
  assert.match(r, /Preview deployments: none/);
  assert.match(read('NOTICE'), /adapted\s+from the README of addon-declaration/);
});

// Source and text files hold printable ASCII only: invisible and direction
// characters are written as \u escapes, so no file shows one hidden (GitHub
// warns about such files). data/ holds publisher text and is not checked.
test('source and text files hold no invisible, direction or other non ASCII characters', () => {
  const skip = new Set(['.git', 'dist', 'data', 'node_modules']);
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith('scratch') && !e.name.startsWith('dist.tmp-')) walk(rel);
      } else if (/\.(js|json|md|yml|css)$|^(LICENSE|NOTICE|\.gitignore|\.gitattributes)$/.test(e.name)) files.push(rel);
    }
  };
  walk('');
  assert.ok(files.includes('lib/text.js') && files.includes('testlib/fixture.js'));
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => assert.doesNotMatch(l, /[^\t\r\x20-\x7E]/, `${f}:${i + 1}`));
  }
});

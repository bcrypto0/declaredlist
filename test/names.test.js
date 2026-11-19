import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileBaseFor, assignFileBases, isSafeFileBase } from '../lib/names.js';
import { HOSTILE_NAMES } from '../testlib/fixture.js';

test('a plain registry name keeps a readable file name', () => {
  assert.equal(fileBaseFor('com.rtlpdf/arabic-pdf'), 'com.rtlpdf__arabic-pdf');
  assert.equal(fileBaseFor('io.github.someone/tool_x'), 'io.github.someone__tool_x');
});

test('hostile names become plain file names that stay in the folder', () => {
  const names = [...HOSTILE_NAMES, '', null, undefined, '/', '..', '.', 'a/../../b', 'CON', 'con/x', 'prn.example/x', 'x/' + 'y'.repeat(5000), '\u0000/\u0001', '\u{1F600}/\u{1F601}', 'a\\b/c', 'a:b/c*?'];
  for (const n of names) {
    const b = fileBaseFor(n);
    assert.ok(isSafeFileBase(b), `unsafe: ${JSON.stringify(b)} for ${JSON.stringify(n)}`);
    assert.ok(b.length <= 120, `too long for ${JSON.stringify(n)}`);
    const joined = path.resolve('/out/listing', `${b}.html`);
    assert.ok(joined.startsWith(path.resolve('/out/listing') + path.sep));
  }
  assert.match(fileBaseFor('../../../etc/passwd'), /^etc_passwd-[0-9a-f]{12}$/);
  assert.match(fileBaseFor('nul.example/aux'), /-[0-9a-f]{12}$/);
  assert.match(fileBaseFor('COM.Example/Upper'), /^com.example_upper-[0-9a-f]{12}$/);
});

test('names that differ only in case or punctuation get distinct files', () => {
  const names = ['com.example/a', 'COM.EXAMPLE/A', 'Com.Example/A', 'com.example/a!', 'com.example/a?', 'com.example/a', '<x>/y', '"x"/y'];
  const m = assignFileBases(names);
  const bases = [...m.values()].map((b) => b.toLowerCase());
  assert.equal(new Set(bases).size, bases.length);
  assert.equal(m.size, new Set(names).size);
  for (const b of m.values()) assert.ok(isSafeFileBase(b));
});

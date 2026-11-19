// File names for listing pages, derived from untrusted listing names.
//
// A name that already has the plain registry form (lowercase namespace of
// letters, digits, "." and "-", a "/", a lowercase server name of letters,
// digits, ".", "_" and "-") becomes "<namespace>__<server>". Anything else is
// reduced to the characters [a-z0-9._-] and given a short hash of the exact name, so two
// names can not share a page and no name can leave the output folder.

import { sha256Hex } from './text.js';

const SIMPLE_RE = /^[a-z0-9][a-z0-9.-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;
// Device names that Windows refuses as a file name, with or without extension.
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'clock$', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

function isReserved(base) {
  return RESERVED.has(base.split('.')[0].toLowerCase());
}

// The file base (no extension) for one name.
export function fileBaseFor(name) {
  const s = typeof name === 'string' ? name : String(name ?? '');
  if (SIMPLE_RE.test(s) && !s.includes('..')) {
    const base = s.replace('/', '__');
    if (!isReserved(base)) return base;
  }
  let cleaned = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  cleaned = [...cleaned].slice(0, 80).join('');
  if (!cleaned || isReserved(cleaned)) cleaned = 'listing';
  return `${cleaned}-${sha256Hex(s).slice(0, 12)}`;
}

// File bases for a list of names. Names that would share a base (the same
// name twice, or two names that differ only in letter case after the
// fallback) get the full hash appended, so every name maps to one file.
export function assignFileBases(names) {
  const out = new Map();
  const used = new Map();
  for (const n of names) {
    if (out.has(n)) continue;
    let base = fileBaseFor(n);
    if (used.has(base.toLowerCase()) && used.get(base.toLowerCase()) !== n) base = `${base}-${sha256Hex(n).slice(0, 32)}`;
    let i = 2;
    while (used.has(base.toLowerCase()) && used.get(base.toLowerCase()) !== n) base = `${base}-${i++}`;
    used.set(base.toLowerCase(), n);
    out.set(n, base);
  }
  return out;
}

// Final check before a name is used as a path: the characters [a-z0-9._-] only.
export function isSafeFileBase(b) {
  return typeof b === 'string' && /^[a-z0-9][a-z0-9._-]{0,250}$/.test(b) && !b.includes('..') && !isReserved(b);
}

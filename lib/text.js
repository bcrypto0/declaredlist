// Text helpers for untrusted strings (registry listings, declarations, server
// answers). Nothing here trusts its input: every function accepts any value.

import { createHash } from 'node:crypto';

// Bidirectional controls and invisible characters that can make one string look
// like another, or hide text from a person while a program still reads it. They
// are shown as [U+XXXX] instead of being acted on: every format character
// (Unicode category Cf: direction controls, zero width characters, soft
// hyphen, tag characters U+E0001 and U+E0020 to U+E007F, U+FFF9 to U+FFFB),
// the line and paragraph separators (Zl, Zp), the rest of the tag block,
// variation selectors, the combining grapheme joiner, the Hangul fillers,
// the Mongolian free variation selectors, the Khmer inherent vowels and the
// blank braille pattern.
const INVISIBLE_RE = /[\p{Cf}\p{Zl}\p{Zp}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
// C0 and C1 controls other than tab and line feed.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// An email address, also one split by invisible characters: clean() shows
// those as [U+XXXX], so that marker may stand anywhere inside the address
// (for example "me[U+200B]@example.com" or "me@exa[U+200D]mple.c[U+200B]om").
const MARK = String.raw`\[U\+[0-9A-F]{4,6}\]`;
const EMAIL_RE = new RegExp(
  String.raw`(?:[A-Za-z0-9._%+-]|${MARK})+@(?:${MARK})*(?:[A-Za-z0-9-]|${MARK})(?:[A-Za-z0-9.-]|${MARK})*\.(?:${MARK})*[A-Za-z](?:${MARK})*[A-Za-z](?:[A-Za-z]|${MARK})*`,
  'g',
);
// Absolute local paths (Windows drive paths, UNC paths, common Unix home and temp folders).
// A drive letter counts only when no letter, digit or URL scheme character
// stands before it and no second slash follows (so "https://" is not a path);
// a Unix path only at the start or after a space, quote, bracket or "=" (so a
// URL path such as https://example.com/home/ is not one).
const LOCAL_PATH_RE = /(?<![A-Za-z0-9+.-])[A-Za-z]:(?:\\|\/(?!\/))[^\s'"<>]*|(?<![^\s'"(=[])\\\\[^\s'"<>]+|(?<![^\s'"(=[])\/(?:home|Users|tmp|var|mnt|root|opt|private)\/[^\s'"<>]*/g;

// Any value as a well formed, visible string: lone surrogates become U+FFFD,
// controls are dropped, invisible and direction characters are made visible.
export function clean(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : String(v);
  s = typeof s.toWellFormed === 'function' ? s.toWellFormed() : s.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  s = s.replace(CONTROL_RE, '');
  s = s.replace(INVISIBLE_RE, (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);
  return s;
}

// Cut to at most n code points, marking the cut.
export function clip(v, n = 200) {
  const s = clean(v);
  const cps = [...s];
  return cps.length > n ? cps.slice(0, n).join('') + '...' : s;
}

// Email addresses in publisher text are not repeated on the site.
export function redactEmails(v) {
  return clean(v).replace(EMAIL_RE, '[email address removed]');
}

// Local file paths do not belong in data or pages (they would leak the
// machine that ran the scan).
export function scrubPaths(v) {
  return clean(v).replace(LOCAL_PATH_RE, '[local path removed]');
}

// Untrusted text as stored in data files: cleaned, emails removed, cut short.
export function untrusted(v, n = 500) {
  if (v === null || v === undefined) return null;
  return clip(redactEmails(scrubPaths(v)), n);
}

export function sha256Hex(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "19 November 2026" from an ISO time, or "unknown date".
export function formatDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown date';
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// "19 November 2026, 14:24 UTC".
export function formatDateTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown time';
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(iso)}, ${hh}:${mm} UTC`;
}

// "2026-11-19" (UTC) for file names and sitemap dates.
export function isoDay(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error('not a time');
  return new Date(t).toISOString().slice(0, 10);
}

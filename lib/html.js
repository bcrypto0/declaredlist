// HTML output helpers. Every string from the registry, a declaration or a
// server goes through esc(); links from such strings go through httpsLink(),
// which accepts plain https URLs only.

import { clean, clip } from './text.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;' };

// Escapes for element content and for quoted attribute values alike.
export function esc(v) {
  return clean(v).replace(/[&<>"'`=]/g, (c) => ESC[c]);
}

// Escaped and cut to n code points.
export function escClip(v, n = 200) {
  return esc(clip(v, n));
}

// The URL in canonical form when it is an https URL without user name or
// password and at most 2048 characters long; otherwise null.
export function safeHttpsUrl(u) {
  if (typeof u !== 'string' || u.length === 0 || u.length > 2048) return null;
  if (/[\s\u0000-\u001F\u007F-\u009F<>"'`\\]/.test(u)) return null;
  // A cleaning marker ("[local path removed]", "[U+202E]") means the stored
  // text is no longer the address the publisher wrote, so it is not linked.
  if (/\[(?:local path removed|email address removed|U\+[0-9A-Fa-f]{4,6})\]/.test(u)) return null;
  let x;
  try {
    x = new URL(u);
  } catch {
    return null;
  }
  if (x.protocol !== 'https:' || x.username || x.password || !x.hostname) return null;
  return x.href;
}

// A link to an outside address. Anything that is not a plain https URL is
// shown as text and not linked. When the text shown is the address itself, the
// canonical form is shown (the form the link goes to: a host with letters
// outside ASCII appears in its xn-- form), so a look-alike host does not read
// as the real one.
export function httpsLink(u, text, n = 300) {
  const href = safeHttpsUrl(u);
  const shown = escClip(text === undefined || text === u ? href || u : text, n);
  if (!href) return `<span class="url">${shown}</span>`;
  return `<a href="${esc(href)}" rel="noopener noreferrer nofollow">${shown}</a>`;
}

// A link inside the site. The target is built by the generator from sanitised
// file names; it is still checked to be a relative path of the characters [A-Za-z0-9._/-].
export function localLink(path, text) {
  return localLinkHtml(path, esc(text));
}

// The same, with link content the generator has already escaped (for example
// a listing name with a line break opportunity after its namespace).
export function localLinkHtml(path, html) {
  const rest = typeof path === 'string' && path.startsWith('../') ? path.slice(3) : path;
  if (typeof rest !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(rest) || rest.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error('refusing to emit an unsafe local link');
  }
  return `<a href="${esc(path)}">${html}</a>`;
}

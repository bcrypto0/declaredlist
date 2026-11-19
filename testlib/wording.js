// The site text rules, as patterns the tests apply to generated text.
export const BANNED = [/\bnever\b/i, /\bguaranteed?\b/i, /\bsafe\b/i, /\bsafely\b/i, /\btrusted\b/i, /verified publisher/i, /\bsecure\b/i];
// Every dash punctuation character (Unicode category Pd) other than the ASCII
// hyphen, the minus sign, and a hyphen used as punctuation (with a space on
// both sides).
export const DASHES = /(?!-)\p{Pd}|\u2212| - /u;

// Visible text of an HTML page: tags, code and pre blocks removed.
export function visibleText(html) {
  return html
    .replace(/<pre>[\s\S]*?<\/pre>/g, ' ')
    .replace(/<code>[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
}

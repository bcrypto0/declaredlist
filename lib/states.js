// Plain words for every result state of the checker's check-listing command
// (lib/listing.js LISTING_STATES in the public checker), plus the two states
// the scanner adds for a check it could not run. Each sentence states what the
// check found on a date. None of them rates a listing, a server or a publisher.

import { formatDate } from './text.js';

// state -> function(date) -> sentence. "date" is a formatted date.
export const STATE_SENTENCES = Object.freeze({
  verified: (d) => `Declaration found and signature valid on ${d}; the declaration the listing names is the one in force.`,
  verified_newer_declaration: (d) => `Declaration found and signature valid on ${d}; a newer declaration for the same version, which follows the named one under the same key, is the one in force.`,
  malformed: (d) => `Declaration found on ${d}, but the file does not follow the rules of its declaration format.`,
  invalid_signature: (d) => `Declaration found on ${d}, but its signature does not match its content and the key it names.`,
  key_not_found: (d) => `Declaration found on ${d}, but the key it names was not among the keys its domain published at that time.`,
  expired: (d) => `Declaration found on ${d} with a valid signature, but it had expired at that time and no renewed declaration was put in force.`,
  not_yet_valid: (d) => `Declaration found on ${d} with a valid signature, but its issue time was still in the future at that time.`,
  name_domain_mismatch: (d) => `Declaration found on ${d}, but the key domain it names does not cover the namespace of the listing.`,
  tools_hash_mismatch: (d) => `Declaration found and signature valid on ${d}; the tool list read from the declared remote differed from the one the declaration signs, or could not be compared with it.`,
  chain_mismatch: (d) => `Declaration found on ${d}, but its link to the earlier declaration it names does not hold.`,
  key_lookup_failed: (d) => `Declaration found on ${d}, but the key lookup at its domain failed at that time, so the signature was not checked.`,
  no_declaration: (d) => `On ${d} the listing named no declaration.`,
  pointer_malformed: (d) => `On ${d} the declaration pointer in the listing did not have the required form; nothing was fetched from it.`,
  pointer_refused: (d) => `On ${d} the declaration pointer named a host or path that the fetch rules do not allow; nothing was fetched from it.`,
  namespace_out_of_scope: (d) => `On ${d} the listing was in a namespace (io.github) that declarations do not cover; nothing was fetched.`,
  declaration_unreachable: (d) => `On ${d} the declaration the listing names could not be fetched from the publisher's site.`,
  declaration_not_the_named_one: (d) => `On ${d} the pointer address served a file that is not the declaration the listing names by hash.`,
  listing_mismatch: (d) => `Declaration found on ${d}, but the declaration the listing names, or a newer one in force, differs from the listing in name, version or remotes.`,
  tools_fetch_failed: (d) => `Declaration found and signature valid on ${d}; the tool list could not be read from the declared remote, so the tool list was not compared.`,
  registry_not_found: (d) => `On ${d} the registry had no listing for this name and version.`,
  registry_unreachable: (d) => `On ${d} the registry could not be read for this listing.`,
  registry_response_invalid: (d) => `On ${d} the registry answer for this listing was not a usable listing.`,
  // Scanner states, not checker states.
  not_checkable: (d) => `On ${d} the listing name or version could not be passed to the checker, so no check was run.`,
  check_error: (d) => `On ${d} the check could not be completed because of an error while running it; no result is shown.`,
});

export const SCANNER_STATES = Object.freeze(['not_checkable', 'check_error']);

// Short labels for the list on the front page.
export const STATE_LABELS = Object.freeze({
  verified: 'signature valid, named declaration in force',
  verified_newer_declaration: 'signature valid, newer declaration in force',
  malformed: 'declaration malformed',
  invalid_signature: 'signature does not match',
  key_not_found: 'key not found at domain',
  expired: 'declaration expired',
  not_yet_valid: 'declaration not valid yet',
  name_domain_mismatch: 'key domain does not cover namespace',
  tools_hash_mismatch: 'tool list did not match or could not be compared',
  chain_mismatch: 'history link does not hold',
  key_lookup_failed: 'key lookup failed',
  no_declaration: 'no declaration named',
  pointer_malformed: 'pointer malformed',
  pointer_refused: 'pointer refused by fetch rules',
  namespace_out_of_scope: 'namespace out of scope',
  declaration_unreachable: 'declaration not reachable',
  declaration_not_the_named_one: 'served file is not the named declaration',
  listing_mismatch: 'declaration differs from listing',
  tools_fetch_failed: 'signature valid, tool list not read',
  registry_not_found: 'listing not found in registry',
  registry_unreachable: 'registry not reachable',
  registry_response_invalid: 'registry answer not usable',
  not_checkable: 'not checked',
  check_error: 'check not completed',
});

export function knownState(state) {
  return Object.hasOwn(STATE_SENTENCES, state);
}

// The dated sentence for one stored result.
export function stateSentence(result) {
  const date = formatDate(result && result.checkedAt);
  const f = result && knownState(result.state) ? STATE_SENTENCES[result.state] : null;
  if (!f) return `On ${date} the check gave a state this site does not know.`;
  return f(date);
}

export function stateLabel(state) {
  return knownState(state) ? STATE_LABELS[state] : 'unknown state';
}

// What the tool comparison shows, as a sentence, or null when nothing applies.
export function toolsSentence(result) {
  const t = result && result.tools;
  if (!t) return null;
  if (t.check === 'run' && t.result === 'match') return 'The tool list read from the declared remote matched the one the declaration in force signs.';
  if (t.check === 'run' && t.result === 'mismatch') return 'The tool list read from the declared remote did not match the one the declaration in force signs, or could not be compared with it.';
  if (t.check === 'not_checked') return 'The tool list was not compared: the declared remote asked for authorization, or the declaration names no remote the checker reads tool lists from.';
  if (t.check === 'failed') return 'The tool list could not be read from the declared remote.';
  if (t.check === 'not_run') return 'The tool list was not compared, because the check stopped before that step.';
  return null;
}

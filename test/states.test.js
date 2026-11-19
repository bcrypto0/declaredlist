import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadChecker } from '../lib/checker.js';
import { STATE_SENTENCES, STATE_LABELS, SCANNER_STATES, stateSentence, stateLabel, toolsSentence } from '../lib/states.js';
import { BANNED, DASHES } from '../testlib/wording.js';

const checker = await loadChecker();
const CHECKER_STATES = Object.keys(checker.listing.LISTING_STATES);

test('every checker state and every scanner state has a sentence and a label', () => {
  assert.ok(CHECKER_STATES.length >= 22, 'the checker exports its states');
  for (const st of [...CHECKER_STATES, ...SCANNER_STATES]) {
    assert.equal(typeof STATE_SENTENCES[st], 'function', `no sentence for ${st}`);
    assert.equal(typeof STATE_LABELS[st], 'string', `no label for ${st}`);
  }
  // No sentence for a state the checker does not have (other than the scanner's own).
  for (const st of Object.keys(STATE_SENTENCES)) assert.ok(CHECKER_STATES.includes(st) || SCANNER_STATES.includes(st), `stale state ${st}`);
});

test('each sentence is dated and follows the wording rules', () => {
  for (const st of [...CHECKER_STATES, ...SCANNER_STATES]) {
    const s = stateSentence({ state: st, checkedAt: '2026-11-19T14:00:00Z' });
    assert.match(s, /19 November 2026/, st);
    for (const w of BANNED) assert.doesNotMatch(s, w, `${st}: ${s}`);
    assert.doesNotMatch(s, DASHES, `${st}: ${s}`);
    for (const w of BANNED) assert.doesNotMatch(stateLabel(st), w);
  }
  assert.equal(stateSentence({ state: 'verified', checkedAt: '2026-11-19T14:00:00Z' }), 'Declaration found and signature valid on 19 November 2026; the declaration the listing names is the one in force.');
});

test('an unknown state is reported as unknown, not mapped', () => {
  assert.match(stateSentence({ state: '__proto__', checkedAt: '2026-11-19T00:00:00Z' }), /does not know/);
  assert.match(stateSentence({ state: 'constructor' }), /unknown date/);
  assert.equal(stateLabel('toString'), 'unknown state');
});

test('tool sentences cover each tool check value', () => {
  for (const t of [{ check: 'run', result: 'match' }, { check: 'run', result: 'mismatch' }, { check: 'not_checked' }, { check: 'failed' }, { check: 'not_run' }]) {
    const s = toolsSentence({ tools: t });
    assert.equal(typeof s, 'string');
    assert.doesNotMatch(s, DASHES);
    for (const w of BANNED) assert.doesNotMatch(s, w);
  }
});

test('labels and sentences say no more than the check found', () => {
  // A tools_hash_mismatch also comes from a digest that could not be computed.
  assert.equal(stateLabel('tools_hash_mismatch'), 'tool list did not match or could not be compared');
  const d = { checkedAt: '2026-11-19T14:00:00Z' };
  // An expired declaration can have a renewed one that was found and set aside.
  assert.match(stateSentence({ ...d, state: 'expired' }), /no renewed declaration was put in force\.$/);
  assert.doesNotMatch(stateSentence({ ...d, state: 'expired' }), /was found\.$/);
  // listing_mismatch also comes from a newer declaration in force.
  assert.match(stateSentence({ ...d, state: 'listing_mismatch' }), /the declaration the listing names, or a newer one in force, differs from the listing/);
  // check_error comes from an error while the checker ran, not only in the scanner.
  assert.match(stateSentence({ ...d, state: 'check_error' }), /an error while running it/);
});

test('the dash pattern catches every dash character', () => {
  for (const c of ['\u2010', '\u2013', '\u2014', '\u2015', '\u2212', '\u2E3A', '\u2E3B', '\uFE58', '\uFE63', '\uFF0D', 'a - b']) assert.match(c, DASHES, c);
  // Dashes the earlier list missed: every character of category Pd counts.
  for (const c of ['\u2011', '\u058A', '\u05BE', '\u1400', '\u1806', '\u2E17', '\u2E1A', '\u2E5D', '\u301C', '\u30A0', '\u{10EAD}']) assert.match(`a${c}b`, DASHES, c.codePointAt(0).toString(16));
  for (const c of ['a-b', 'mcp-publisher', 'x--y', '--since', 'a\u00ADb']) assert.doesNotMatch(c, DASHES, c);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEAL_SEMANTIC_MATCHER_VERSION,
  dealSemanticFamilies,
  dealSemanticSuppressionReasons,
  matchSemanticFamily,
} from '../server/services/dealHunterSemanticMatcher.js';

// The matcher is pure, so these tests exercise it directly rather than through
// the scorer. Text is pre-lowercased the way matchDealNarrative normalizes it.
function positive(text, terms) {
  return matchSemanticFamily({ text, terms, polarity: 'positive' });
}
function risk(text, terms, containers = []) {
  return matchSemanticFamily({ text, terms, polarity: 'risk', containers });
}

const recurring = ['recurring revenue', 'maintenance contracts', 'service agreements'];
const management = ['management in place', 'general manager'];
const capex = ['heavy equipment', 'fleet'];
const concentration = ['customer concentration', 'customer accounts for'];

test('the matcher declares a version and a closed set of suppression reasons', () => {
  assert.equal(DEAL_SEMANTIC_MATCHER_VERSION, 'deal-semantic-matcher-v1');
  assert.deepEqual([...dealSemanticSuppressionReasons].sort(), [
    'adverse-context', 'favorable-qualifier', 'future-or-conditional', 'historical-only',
    'longer-phrase-precedence', 'negated-positive', 'negated-risk',
  ]);
  // Category gates stay on raw matching; suppressing one would admit a
  // disqualified listing, which is the expensive error.
  assert.equal(Object.hasOwn(dealSemanticFamilies, 'excluded'), false);
});

// ---------------------------------------------------------------------------
// Negation
// ---------------------------------------------------------------------------

test('single-token negators suppress a positive match', () => {
  for (const phrase of [
    'no recurring revenue here',
    'the business lacks recurring revenue',
    'operates without service agreements',
    'never had maintenance contracts',
  ]) {
    const result = positive(phrase, recurring);
    assert.equal(result.matched.length, 0, `expected suppression for: ${phrase}`);
    assert.equal(result.suppressed[0].reason, 'negated-positive');
  }
});

test('multi-token negator sequences suppress a positive match', () => {
  for (const phrase of [
    'the company does not have maintenance contracts',
    'there is no recurring revenue',
    'they have no service agreements',
    'the business is not sold with maintenance contracts',
    'no longer has recurring revenue',
  ]) {
    assert.equal(positive(phrase, recurring).matched.length, 0, `expected suppression for: ${phrase}`);
  }
});

test('"not only" is emphasis and must not suppress', () => {
  const result = positive('not only recurring revenue but also project work', recurring);
  assert.deepEqual(result.matched, ['recurring revenue']);
});

test('a negator does not reach across a sentence boundary', () => {
  const result = positive('there is no franchise agreement. recurring revenue covers most of the year.', recurring);
  assert.deepEqual(result.matched, ['recurring revenue']);
});

test('a negator does not reach across a semicolon', () => {
  const result = positive('no owner financing is offered; maintenance contracts renew annually', recurring);
  assert.deepEqual(result.matched, ['maintenance contracts']);
});

test('an adversative conjunction resets the negation window', () => {
  const result = positive('the prior owner had no systems but recurring revenue is now contracted', recurring);
  assert.deepEqual(result.matched, ['recurring revenue']);
});

test('a distant negator outside the window does not suppress', () => {
  const result = positive(
    'no formal marketing plan has ever been produced by the current ownership team so far and maintenance contracts renew annually',
    recurring,
  );
  assert.deepEqual(result.matched, ['maintenance contracts']);
});

test('one accepted occurrence keeps the term even when another is negated', () => {
  const result = positive('there is no recurring revenue in the retail arm. recurring revenue drives the service arm.', recurring);
  assert.deepEqual(result.matched, ['recurring revenue']);
});

// ---------------------------------------------------------------------------
// Phrase precedence and qualifiers
// ---------------------------------------------------------------------------

test('a longer opposite-polarity phrase takes precedence over a contained risk phrase', () => {
  const text = 'the business has low customer concentration across the base';
  const containers = [{ start: text.indexOf('low customer concentration'), end: text.indexOf('low customer concentration') + 'low customer concentration'.length, polarity: 'positive' }];
  const result = risk(text, concentration, containers);
  assert.equal(result.matched.length, 0);
  assert.equal(result.suppressed[0].reason, 'favorable-qualifier');
});

test('favorable qualifiers suppress a risk match on a tight window', () => {
  for (const phrase of [
    'the business has low customer concentration',
    'minimal customer concentration across accounts',
    'negligible customer concentration risk',
  ]) {
    assert.equal(risk(phrase, concentration).matched.length, 0, `expected suppression for: ${phrase}`);
  }
});

test('a favorable qualifier far from the risk phrase does not suppress it', () => {
  // "low" here describes margins, not concentration.
  const result = risk('low margins across the portfolio mean customer concentration is a serious problem', concentration);
  assert.deepEqual(result.matched, ['customer concentration']);
});

test('a negated risk phrase is suppressed', () => {
  const result = risk('no customer accounts for more than 10% of annual revenue', concentration);
  assert.equal(result.matched.length, 0);
  assert.equal(result.suppressed[0].reason, 'negated-risk');
});

test('a "non-" prefix suppresses the term it negates', () => {
  assert.equal(positive('non-recurring revenue only', ['recurring revenue']).matched.length, 0);
  // The hyphenated token itself is a distinct keyword and is not self-suppressed.
  assert.deepEqual(positive('non-discretionary work', ['non-discretionary']).matched, ['non-discretionary']);
});

test('negated capex language is not treated as a capex risk', () => {
  assert.equal(risk('no fleet is required to operate', capex).matched.length, 0);
  assert.equal(risk('no heavy equipment is required', capex).matched.length, 0);
  assert.deepEqual(risk('a fleet of twelve service vehicles conveys', capex).matched, ['fleet']);
});

// ---------------------------------------------------------------------------
// Adverse, temporal and conditional context
// ---------------------------------------------------------------------------

test('adverse context suppresses a positive match', () => {
  for (const phrase of [
    'losing maintenance contracts to competitors',
    'declining recurring revenue year over year',
    'customers cancelled service agreements last quarter',
  ]) {
    const result = positive(phrase, recurring);
    assert.equal(result.matched.length, 0, `expected suppression for: ${phrase}`);
    assert.equal(result.suppressed[0].reason, 'adverse-context');
  }
});

test('"no longer declining" is not treated as a financial risk', () => {
  const financialRisk = ['declining revenue', 'revenue decline'];
  assert.deepEqual(risk('the business has declining revenue', financialRisk).matched, ['declining revenue']);
  const recovered = risk('the business no longer has declining revenue', financialRisk);
  assert.equal(recovered.matched.length, 0, '"no longer" must cancel the risk term it negates');
  assert.equal(recovered.suppressed[0].reason, 'negated-risk');
});

// Documented limitation, asserted so it cannot drift silently.
//
// Negation scope is clause-bounded but does not model English coordination. In
// "revenue is no longer declining and maintenance contracts renew annually" the
// negator sits in the same clause as a later, genuinely positive term, so that
// term is conservatively withheld. Breaking the window on "and" would fix this
// sentence but would wrongly accept "there are no maintenance contracts and
// recurring revenue", where negation legitimately distributes across the
// conjunction. Withholding credit is the safe direction: it declines to invent
// support rather than inventing it.
test('negation conservatively withholds a coordinated positive in the same clause', () => {
  const result = positive('revenue is no longer declining and maintenance contracts renew annually', recurring);
  assert.equal(result.matched.length, 0, 'conservative withholding, not a claim of absence');
  assert.equal(result.suppressed[0].reason, 'negated-positive');

  // A sentence break is enough to recover the positive, which is the shape this
  // language usually takes in a real listing.
  const separated = positive('revenue is no longer declining. maintenance contracts renew annually.', recurring);
  assert.deepEqual(separated.matched, ['maintenance contracts']);
});

test('future and conditional plans do not count as current support', () => {
  for (const phrase of [
    'the company plans to add maintenance contracts',
    'the buyer expects to introduce service agreements',
    'management will be hired after closing to run maintenance contracts',
  ]) {
    assert.equal(positive(phrase, recurring).matched.length, 0, `expected suppression for: ${phrase}`);
  }
});

test('historical-only statements do not count as current support', () => {
  for (const phrase of [
    'the company formerly had maintenance contracts',
    'it previously ran on recurring revenue',
    'the shop used to hold service agreements',
  ]) {
    assert.equal(positive(phrase, recurring).matched.length, 0, `expected suppression for: ${phrase}`);
  }
});

test('a recovered historical decline keeps the later positive', () => {
  const result = positive('revenue declined in 2024 but recurring revenue recovered in 2025', recurring);
  assert.deepEqual(result.matched, ['recurring revenue']);
});

// ---------------------------------------------------------------------------
// Text-shape robustness
// ---------------------------------------------------------------------------

test('unicode apostrophes and dashes are normalized by the caller contract', () => {
  // matchSemanticFamily receives already-normalized text; these are the shapes
  // matchDealNarrative produces from curly punctuation.
  assert.equal(positive("the owner doesn't have maintenance contracts", recurring).matched.length, 0);
  assert.equal(positive('non-recurring revenue only', ['recurring revenue']).matched.length, 0);
});

test('repeated and contradictory clauses keep both readings available', () => {
  const result = positive(
    'there are no maintenance contracts on the retail side. service agreements cover every commercial account.',
    recurring,
  );
  assert.deepEqual(result.matched, ['service agreements']);
  assert.equal(result.suppressed.some((item) => item.term === 'maintenance contracts'), true);
});

test('management phrases follow the same negation rules', () => {
  assert.equal(positive('there is no management in place and no general manager', management).matched.length, 0);
  assert.deepEqual(
    positive('a general manager runs the company day to day', management).matched,
    ['general manager'],
  );
});

test('suppressed entries always carry a known reason', () => {
  const result = positive('no recurring revenue and the shop formerly had service agreements', recurring);
  assert.ok(result.suppressed.length > 0);
  for (const item of result.suppressed) {
    assert.ok(dealSemanticSuppressionReasons.includes(item.reason), `unknown reason ${item.reason}`);
    assert.ok(item.term);
  }
});

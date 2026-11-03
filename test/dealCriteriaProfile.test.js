import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEAL_CRITERIA_PROFILE_VERSION, evaluateDealCriteria, getDealCriteriaProfile,
} from '../server/services/dealCriteriaProfile.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function deal(overrides = {}) {
  return {
    fitScore: 92,
    annualProfit: 450000,
    profitMultiple: 3.2,
    location: 'Phoenix, AZ',
    industry: 'HVAC service',
    gates: [],
    ...overrides,
  };
}

function mustHave(result, id) {
  return result.mustHaves.find((entry) => entry.id === id).outcome;
}

test('profit band edges', () => {
  for (const [profit, outcome] of [[299999, 'fail'], [300000, 'pass'], [750000, 'pass'], [750001, 'fail'], [null, 'unknown'], ['n/a', 'unknown']]) {
    assert.equal(mustHave(evaluateDealCriteria(deal({ annualProfit: profit })), 'profit'), outcome);
  }
});

test('multiple edges and implied multiple', () => {
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: 4.0 })), 'multiple'), 'pass');
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: 4.01 })), 'multiple'), 'fail');
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: 0 })), 'multiple'), 'fail');
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: null, askingPrice: 1200000, annualProfit: 400000 })), 'multiple'), 'pass');
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: null, askingPrice: null })), 'multiple'), 'unknown');
});

test('geography tokens and full state names', () => {
  for (const [location, outcome] of [['Phoenix, AZ', 'pass'], ['Phoenix, Arizona', 'pass'], ['NYC Metro, NY', 'pass'], ['CAN', 'fail'], ['Austin, TX', 'fail'], ['', 'unknown']]) {
    assert.equal(mustHave(evaluateDealCriteria(deal({ location, state: '' })), 'geography'), outcome, location);
  }
});

test('geography evaluates location and state together', () => {
  for (const [location, state, outcome] of [
    ['Greater Phoenix', 'AZ', 'pass'],
    ['', 'Nevada', 'pass'],
    ['Austin', 'TX', 'fail'],
    ['', '', 'unknown'],
    ['  ', ' ', 'unknown'],
  ]) {
    assert.equal(mustHave(evaluateDealCriteria(deal({ location, state })), 'geography'), outcome, `${location}/${state}`);
  }
});

test('industry and gates', () => {
  assert.equal(mustHave(evaluateDealCriteria(deal({ industry: 'Commercial HVAC' })), 'industry'), 'pass');
  assert.equal(mustHave(evaluateDealCriteria(deal({ industry: 'Restaurant', name: 'Taco Spot' })), 'industry'), 'fail');
  assert.equal(mustHave(evaluateDealCriteria(deal({ industry: '', name: '' })), 'industry'), 'unknown');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 95, gates: [{ ruleId: 'gate.franchise' }] })).group, 'near-miss');
});

test('group precedence', () => {
  assert.equal(evaluateDealCriteria(deal({ fitScore: 74 })).group, 'below-review');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 95, annualProfit: 900000 })).group, 'near-miss');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 95, annualProfit: null })).group, 'needs-info');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 90 })).group, 'auto');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 89 })).group, 'review');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 75 })).group, 'review');
});

test('automatic floor cannot be configured below 90', () => {
  assert.equal(getDealCriteriaProfile({ dealHunter: { criteria: { automaticFloor: 80 } } }).automaticFloor, 90);
});

test('failed and passing must-haves carry the profile limits the owner is shown', () => {
  const profile = getDealCriteriaProfile();
  const result = evaluateDealCriteria(deal({ annualProfit: 900000, profitMultiple: 5.1 }));
  const byId = Object.fromEntries(result.mustHaves.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.profit.limit, { min: profile.minimumAnnualProfit, max: profile.maximumAnnualProfit });
  assert.deepEqual(byId.multiple.limit, { max: profile.maximumProfitMultiple });
  assert.deepEqual(byId.geography.targetStates, [...profile.targetStates]);
  assert.equal(Object.hasOwn(byId.industry, 'limit'), false);
  assert.equal(Object.hasOwn(byId.gates, 'limit'), false);
});

test('unknown must-haves still state the limits', () => {
  const result = evaluateDealCriteria(deal({ annualProfit: null, profitMultiple: null, askingPrice: null }));
  assert.deepEqual(result.mustHaves.find((entry) => entry.id === 'profit').limit, { min: 300000, max: 750000 });
  assert.deepEqual(result.mustHaves.find((entry) => entry.id === 'multiple').limit, { max: 4 });
});

test('whitespace-only numbers are unknown, never zero (spec 4.2)', () => {
  assert.equal(mustHave(evaluateDealCriteria(deal({ annualProfit: '  ' })), 'profit'), 'unknown');
  assert.equal(mustHave(evaluateDealCriteria(deal({ annualProfit: '\t\n' })), 'profit'), 'unknown');
  assert.equal(mustHave(evaluateDealCriteria(deal({ annualProfit: ' 450000 ' })), 'profit'), 'pass');
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: ' ', askingPrice: 1200000 })), 'multiple'), 'pass',
    'a blank multiple falls back to asking price over profit');
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: ' ', askingPrice: ' ' })), 'multiple'),
    'unknown');
  const blank = evaluateDealCriteria(deal({ annualProfit: '  ' }));
  assert.equal(blank.mustHaves.find((entry) => entry.id === 'profit').observed, null);
  assert.deepEqual(blank.unknown, ['profit']);
});

test('observed text is bounded to 200 characters (spec 5)', () => {
  const longName = `HVAC ${'x'.repeat(400)}`;
  const longLocation = `Phoenix, AZ ${'y'.repeat(400)}`;
  const result = evaluateDealCriteria(deal({ name: longName, industry: 'z'.repeat(400), location: longLocation,
    state: 'AZ' }));
  for (const id of ['geography', 'industry']) {
    const entry = result.mustHaves.find((item) => item.id === id);
    assert.equal(typeof entry.observed, 'string', id);
    assert.equal(entry.observed.length, 200, id);
    assert.equal(entry.outcome, 'pass', id);
  }
  assert.ok(JSON.stringify(result).length < 2000);
});

test('observed text truncation keeps a surrogate pair whole', () => {
  const location = `${'a'.repeat(199)}😀bbb`;
  const result = evaluateDealCriteria(deal({ location, state: '' }));
  const { observed } = result.mustHaves.find((item) => item.id === 'geography');
  assert.equal(observed, `${'a'.repeat(199)}😀`);
  assert.equal(Array.from(observed).length, 200);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(observed), false, 'no lone high surrogate');
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(observed), false, 'no lone low surrogate');
});

test('every criteria version literal hard-coded in SQL is the current profile version', () => {
  for (const file of ['supabase/schema.sql', 'supabase/migrations/20261102120000_best_first_deal_list.sql']) {
    const sql = fs.readFileSync(path.join(root, file), 'utf8');
    // Any quoted '<name>-criteria-v<n>' literal, in code or comments.
    const literals = [...sql.matchAll(/'([a-z0-9]+(?:-[a-z0-9]+)*-criteria-v[0-9]+)'/gi)].map((match) => match[1]);
    assert.ok(literals.length > 0, `${file} names the criteria version it groups by`);
    assert.deepEqual([...new Set(literals)], [DEAL_CRITERIA_PROFILE_VERSION], file);
  }
});

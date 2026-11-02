import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateDealCriteria, getDealCriteriaProfile } from '../server/services/dealCriteriaProfile.js';

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

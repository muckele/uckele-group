import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';

// These fixtures freeze the four semantic defects found during Phase 3A
// production validation. Each was demonstrated to fail against the plain
// substring matcher before the semantic matcher existed:
//   D2: "no recurring revenue" earned positive recurring-revenue points
//   D2: "losing maintenance contracts" earned positive points
//   D3: "not recession resistant" earned positive resilience points
//   D4: "no management in place" earned positive management points
//   D6: "low customer concentration" was penalised as a concentration risk

const { scoreOpportunity } = await import('../server/services/dealHunterScoring.js');

function baseDeal(overrides = {}) {
  const deal = {
    id: 'semantic-deal',
    dealKey: 'semantic-deal',
    name: 'Synthetic Services Co',
    industry: 'Commercial services',
    description: '',
    city: 'Springfield',
    county: '',
    state: 'NY',
    country: 'USA',
    location: 'Springfield, NY',
    annualProfit: 450000,
    annualRevenue: 1800000,
    askingPrice: 1300000,
    profitMultiple: 2.9,
    netMargin: 25,
    yearsEstablished: 14,
    fiveYearsFlag: 'Yes',
    remoteFlag: '',
    franchiseFlag: '',
    brokerName: 'Broker',
    brokerEmail: 'broker@example.invalid',
    brokerContact: '',
    listingUrl: 'https://listings.example.invalid/semantic-deal',
    dateAdded: '2026-01-05',
    lastUpdated: '2026-01-06',
    ...overrides,
  };
  deal.fullText = [
    deal.name, deal.industry, deal.description, deal.city, deal.county, deal.state, deal.remoteFlag, deal.franchiseFlag,
  ].join(' ').replace(/\s+/g, ' ').trim();
  return deal;
}

function dimension(result, id) {
  return result.dimensions.find((item) => item.id === id);
}

function positiveRules(dim, prefix) {
  return dim.rules.filter((rule) => rule.ruleId.startsWith(prefix) && rule.delta > 0);
}

// ---------------------------------------------------------------------------
// D2 — revenue durability
// ---------------------------------------------------------------------------

test('D2: explicit absence of recurring revenue earns no positive credit', () => {
  const result = scoreOpportunity(baseDeal({
    description: 'No recurring revenue and no service contracts. All work is won through one-off project bidding.',
  }));
  const durability = dimension(result, 'revenue-durability');

  assert.equal(positiveRules(durability, 'recurring.').length, 0,
    'a listing that states it has no recurring revenue must not earn recurring-revenue points');
  assert.equal(durability.verdict === 'supported', false);
  // The explicit statement is surfaced as suppressed-match evidence rather than
  // silently vanishing.
  assert.equal(result.suppressedMatches.some(
    (item) => item.family === 'recurring' && item.reason === 'negated-positive',
  ), true);
  // Existing v2 absent-branch behavior still applies: the score is capped below
  // high fit and the concern is recorded.
  assert.ok(result.fitScore < 75, `expected sub-high-fit score, got ${result.fitScore}`);
});

test('D2: deteriorating contracts earn no positive credit merely by mentioning contracts', () => {
  const result = scoreOpportunity(baseDeal({
    description: 'The company is losing maintenance contracts and recurring revenue has declined sharply this year.',
  }));
  const durability = dimension(result, 'revenue-durability');

  assert.equal(positiveRules(durability, 'recurring.').length, 0,
    'losing contracts is not recurring-revenue support');
  assert.equal(result.suppressedMatches.some(
    (item) => item.family === 'recurring' && item.reason === 'adverse-context',
  ), true);
  assert.ok(result.fitScore < 75);
});

test('D2: genuine recurring revenue keeps its existing positive contribution', () => {
  const result = scoreOpportunity(baseDeal({
    description: 'Recurring maintenance contracts generate most of the company revenue under multi-year service agreements.',
  }));
  const durability = dimension(result, 'revenue-durability');

  assert.ok(positiveRules(durability, 'recurring.').length > 0);
  assert.equal(durability.verdict, 'supported');
});

// ---------------------------------------------------------------------------
// D3 — demand resilience
// ---------------------------------------------------------------------------

// The Phase 3A report described this defect as '"not recession resistant"
// earning resilience points'. That attribution was wrong: recessionProofKeywords
// contains no term matching "recession", so that phrase never matched anything.
// The points in the original probe came from the word "commercial" in the
// industry field. The real negation defect in this dimension is that explicitly
// negated resilience keywords still scored, which is what this asserts.
test('D3: explicitly negated resilience keywords earn no positive credit', () => {
  const result = scoreOpportunity(baseDeal({
    industry: 'Widget sales',
    description: 'This is not an essential service and there is no compliance requirement for the work.',
  }));
  const resilience = dimension(result, 'demand-resilience');

  assert.equal(positiveRules(resilience, 'recession.').length, 0,
    'negated "essential" and "compliance" must not earn resilience points');
  assert.equal(result.suppressedMatches.some(
    (item) => item.family === 'recession' && item.reason === 'negated-positive',
  ), true);
});

test('D3: a non- prefix suppresses the term it negates without touching its own keyword', () => {
  // "non-essential" must not score as "essential"; "non-discretionary" is itself
  // a resilience keyword and must keep scoring.
  const negated = scoreOpportunity(baseDeal({
    industry: 'Widget sales',
    description: 'This is a non-essential discretionary purchase for most buyers.',
  }));
  assert.equal(positiveRules(dimension(negated, 'demand-resilience'), 'recession.').length, 0);

  const genuine = scoreOpportunity(baseDeal({
    industry: 'Widget sales',
    description: 'The work is non-discretionary for every commercial building owner.',
  }));
  assert.ok(positiveRules(dimension(genuine, 'demand-resilience'), 'recession.').length > 0,
    '"non-discretionary" is itself a resilience keyword and must still score');
});

test('D3: genuine resilience keeps its existing positive contribution', () => {
  const result = scoreOpportunity(baseDeal({
    description: 'The business provides essential non-discretionary inspection and repair services under regulated compliance requirements.',
  }));
  const resilience = dimension(result, 'demand-resilience');

  assert.ok(positiveRules(resilience, 'recession.').length > 0);
  assert.ok(positiveRules(resilience, 'ai-resistance.').length > 0,
    'non-discretionary must not be mistaken for a negation of nearby resilience terms');
});

// ---------------------------------------------------------------------------
// D4 — transferability
// ---------------------------------------------------------------------------

test('D4: explicit absence of management earns no positive credit', () => {
  const result = scoreOpportunity(baseDeal({
    description: 'There is no management in place and no general manager. The owner runs every job personally.',
  }));
  const transferability = dimension(result, 'transferability');

  assert.equal(positiveRules(transferability, 'management.').length, 0,
    '"no management in place" must not earn management points');
  assert.equal(result.suppressedMatches.some(
    (item) => item.family === 'management' && item.reason === 'negated-positive',
  ), true);
});

test('D4: genuine management depth keeps its existing positive contribution', () => {
  const result = scoreOpportunity(baseDeal({
    description: 'A general manager and trained staff run the company day to day with the owner absentee.',
  }));
  const transferability = dimension(result, 'transferability');

  assert.ok(positiveRules(transferability, 'management.').length > 0);
});

// ---------------------------------------------------------------------------
// D6 — concentration and quality risk
// ---------------------------------------------------------------------------

test('D6: a favorable low-concentration statement is not penalised as a risk', () => {
  const clean = scoreOpportunity(baseDeal({
    description: 'The account base is broad and diversified across many commercial customers.',
  }));
  const favorable = scoreOpportunity(baseDeal({
    description: 'The business has low customer concentration across a broad and diversified account base of commercial customers.',
  }));
  const risk = dimension(favorable, 'concentration-quality-risk');

  assert.equal(risk.negativePoints, 0, '"low customer concentration" must not be a concentration penalty');
  assert.equal(favorable.suppressedMatches.some(
    (item) => item.family === 'concentrationRisk' && item.reason === 'favorable-qualifier',
  ), true);
  // The favorable statement must never leave the listing scoring below an
  // equivalent listing that said nothing about concentration.
  assert.ok(favorable.fitScore >= clean.fitScore);
});

test('D6: explicit diversification with a negated risk phrase is not penalised', () => {
  const result = scoreOpportunity(baseDeal({
    description: 'No customer accounts for more than 10% of annual revenue. The base is broadly diversified.',
  }));
  const risk = dimension(result, 'concentration-quality-risk');

  assert.equal(risk.negativePoints, 0,
    '"no customer accounts for more than 10%" is diversification, not concentration risk');
});

test('D6: genuine concentration risk keeps its existing treatment', () => {
  const result = scoreOpportunity(baseDeal({
    description: 'One customer represents the majority of revenue and customer concentration is significant.',
  }));
  const risk = dimension(result, 'concentration-quality-risk');

  assert.ok(risk.negativePoints > 0, 'a real single-customer risk still deducts');
  assert.equal(risk.verdict, 'negative');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';

const { scoreDeal } = await import('../server/services/dealHunter.js');
const {
  dealScoreFingerprint,
  dealScoreFingerprintFields,
  scoreOpportunity,
} = await import('../server/services/dealHunterScoring.js');
const {
  DEAL_SCORING_RULES_VERSION,
  dealScoreDimensionIds,
  dealScoreRules,
} = await import('../server/services/dealHunterScoringPolicy.js');
const { buildScoringCorpus } = await import('./fixtures/dealHunterScoringCorpus.js');

const baseline = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('./fixtures/dealHunterFitV2Baseline.json', import.meta.url)),
  'utf8',
));

function baseDeal(overrides = {}) {
  const deal = {
    id: 'unit-deal',
    dealKey: 'unit-deal',
    name: 'Commercial Fire Safety Inspection Co',
    industry: 'Fire safety inspection',
    description: 'Recurring maintenance contracts and service agreements with commercial customers on scheduled preventive maintenance.',
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
    listingUrl: 'https://listings.example.invalid/unit-deal',
    dateAdded: '2026-01-05',
    lastUpdated: '2026-01-06',
    ...overrides,
  };
  deal.fullText = [
    deal.name, deal.industry, deal.description, deal.city, deal.county, deal.state, deal.remoteFlag, deal.franchiseFlag,
  ].join(' ').replace(/\s+/g, ' ').trim();
  return deal;
}

// ---------------------------------------------------------------------------
// v2 compatibility. This is the load-bearing guarantee of Phase 3A: decomposing
// the scorer into dimensions must not move a single score, status, or gate.
// ---------------------------------------------------------------------------

test('the frozen deal-hunter-fit-v2 corpus scores identically after decomposition', () => {
  assert.equal(baseline.scoringRuleVersion, DEAL_SCORING_RULES_VERSION);
  const corpus = buildScoringCorpus();
  assert.equal(corpus.length, baseline.caseCount);
  assert.equal(baseline.caseCount, 506);

  const byId = new Map(baseline.cases.map((item) => [item.id, item]));
  const drift = [];
  for (const deal of corpus) {
    const expected = byId.get(deal.id);
    assert.ok(expected, `baseline is missing case ${deal.id}`);
    const scored = scoreDeal(deal);
    if (scored.score !== expected.score
      || scored.shouldRemove !== expected.shouldRemove
      || scored.scoreStatus !== expected.scoreStatus
      || scored.evidenceConfidence !== expected.evidenceConfidence
      || scored.completenessScore !== expected.completenessScore
      || scored.actionEligibility.highFit !== expected.highFit
      || scored.actionEligibility.cimRequest !== expected.cimRequest) {
      drift.push({ id: deal.id, expected, actual: { score: scored.score, status: scored.scoreStatus } });
    }
  }
  assert.deepEqual(drift, [], `v2 scoring drifted on ${drift.length} case(s)`);
});

test('scoreOpportunity reports the v2 score verbatim and reconciles to it', () => {
  const corpus = buildScoringCorpus();
  for (const deal of corpus) {
    const plain = scoreDeal(deal);
    const result = scoreOpportunity(deal);
    assert.equal(result.fitScore, plain.score, `fitScore drifted for ${deal.id}`);
    assert.equal(result.scoreStatus, plain.scoreStatus);
    assert.equal(result.confidence, plain.evidenceConfidence);
    assert.equal(result.completenessScore, plain.completenessScore);
    assert.equal(result.shouldRemove, plain.shouldRemove);

    // Baseline plus every attributed dimension contribution must reproduce the
    // pre-cap arithmetic, so no scoring fact is invisible to the explanation.
    const attributed = result.dimensions.reduce((sum, dimension) => sum + dimension.contribution, 0);
    const preCap = result.baselinePoints + attributed;
    const bounded = Math.max(0, Math.min(100, Math.round(preCap)));
    const capped = result.appliedCaps.length > 0 || result.gates.length > 0 || deal.annualProfit === null;
    if (!capped) {
      assert.equal(result.fitScore, bounded, `unexplained score for ${deal.id}: ${result.fitScore} vs ${bounded}`);
    } else {
      assert.ok(result.fitScore <= bounded, `capped score exceeded its uncapped value for ${deal.id}`);
    }
  }
});

test('threshold bands and gates keep their existing meaning', () => {
  const highFit = scoreOpportunity(baseDeal());
  assert.ok(highFit.fitScore >= 75, `expected a high-fit score, got ${highFit.fitScore}`);
  assert.equal(highFit.scoreStatus, 'high-fit');
  assert.equal(highFit.actionEligibility.highFit, true);
  assert.deepEqual(highFit.gates, []);

  const franchise = scoreOpportunity(baseDeal({ franchiseFlag: 'Yes' }));
  assert.equal(franchise.shouldRemove, true);
  assert.equal(franchise.gates.some((gate) => gate.ruleId === 'gate.franchise'), true);
  assert.equal(franchise.actionEligibility.highFit, false);

  const excluded = scoreOpportunity(baseDeal({
    industry: 'Restaurant and catering',
    description: 'A restaurant serving food and beverage in a hospitality setting.',
  }));
  assert.equal(excluded.shouldRemove, true);
  assert.equal(excluded.gates.some((gate) => gate.ruleId === 'gate.excluded-category'), true);
});

test('a gated opportunity keeps its explanatory dimensions but is never actionable', () => {
  const gated = scoreOpportunity(baseDeal({ franchiseFlag: 'Yes' }));
  const financial = gated.dimensions.find((dimension) => dimension.id === 'financial-fit');
  assert.ok(financial.rules.length > 0, 'a gated deal still explains its financial evidence');
  assert.ok(financial.contribution > 0, 'a gated deal retains its positive financial contribution');
  assert.equal(gated.actionEligibility.highFit, false);
  assert.ok(gated.gates.length > 0);
});

// ---------------------------------------------------------------------------
// Dimensions and evidence
// ---------------------------------------------------------------------------

test('every dimension is reported and every scoring rule maps to a known dimension', () => {
  const result = scoreOpportunity(baseDeal());
  assert.deepEqual(result.dimensions.map((dimension) => dimension.id), dealScoreDimensionIds);

  for (const [ruleId, rule] of Object.entries(dealScoreRules)) {
    if (rule.dimension === null) continue;
    assert.ok(
      dealScoreDimensionIds.includes(rule.dimension),
      `rule ${ruleId} points at unknown dimension ${rule.dimension}`,
    );
  }
});

test('each scored contribution carries traceable provenance', () => {
  const result = scoreOpportunity(baseDeal());
  assert.ok(result.evidence.length > 0);
  for (const row of result.evidence) {
    assert.ok(row.ruleId, 'evidence row without a rule id');
    assert.ok(row.ruleLabel, 'evidence row without a human label');
    assert.ok(
      ['observed', 'calculated', 'heuristic', 'inferred', 'missing', 'contradicted'].includes(row.evidenceClass),
      `unexpected evidence class ${row.evidenceClass}`,
    );
  }
  // Phase 3A must never produce model-generated evidence.
  assert.equal(result.evidence.some((row) => row.evidenceClass === 'inferred'), false);
});

test('a dimension explanation is reconstructable from its recorded rules', () => {
  const result = scoreOpportunity(baseDeal());
  for (const dimension of result.dimensions) {
    const summed = dimension.rules.reduce((total, rule) => total + rule.delta, 0);
    assert.equal(summed, dimension.contribution, `${dimension.id} rules do not sum to its contribution`);
  }
});

// ---------------------------------------------------------------------------
// Unknown is not negative. This is the semantic requirement of the phase.
// ---------------------------------------------------------------------------

test('absent evidence never deducts points while explicit negative evidence does', () => {
  // Silent on management: the listing simply does not say.
  const silent = scoreOpportunity(baseDeal({
    description: 'Recurring maintenance contracts and service agreements with commercial customers.',
  }));
  // Explicitly owner dependent: the listing states the negative characteristic.
  const negative = scoreOpportunity(baseDeal({
    description: 'Recurring maintenance contracts and service agreements with commercial customers. '
      + 'The owner operator performs all sales personally and the business depends on the owner relationships.',
  }));

  const silentTransfer = silent.dimensions.find((d) => d.id === 'transferability');
  const negativeTransfer = negative.dimensions.find((d) => d.id === 'transferability');

  assert.equal(silentTransfer.verdict, 'absent', 'a silent listing is absent, not negative');
  assert.equal(silentTransfer.negativePoints, 0, 'absent evidence must not deduct points');
  assert.ok(silentTransfer.missing.length > 0, 'absent evidence is recorded as missing');

  assert.equal(negativeTransfer.verdict, 'negative', 'stated owner dependence is negative evidence');
  assert.ok(negativeTransfer.negativePoints > 0, 'observed negative evidence deducts points');

  assert.ok(
    negative.fitScore < silent.fitScore,
    'a listing that states a negative must score below one that is merely silent',
  );
});

test('missing fields lower completeness and confidence rather than fit contributions', () => {
  const complete = scoreOpportunity(baseDeal());
  const sparse = scoreOpportunity(baseDeal({ annualRevenue: null, askingPrice: null, brokerEmail: '', brokerName: '' }));

  assert.ok(sparse.completenessScore < complete.completenessScore);
  assert.ok(sparse.missingEvidence.length > complete.missingEvidence.length);
  assert.ok(sparse.confidenceReasons.length > 0);

  // Missing revenue and broker contact contribute no scoring rules at all, so
  // the revenue-durability dimension is untouched by their absence.
  const completeDurability = complete.dimensions.find((d) => d.id === 'revenue-durability');
  const sparseDurability = sparse.dimensions.find((d) => d.id === 'revenue-durability');
  assert.equal(sparseDurability.contribution, completeDurability.contribution);
});

test('missing annual profit caps the score without deducting points', () => {
  const known = scoreOpportunity(baseDeal());
  const unknown = scoreOpportunity(baseDeal({ annualProfit: null, annualRevenue: null }));

  const unknownFinancial = unknown.dimensions.find((d) => d.id === 'financial-fit');
  assert.equal(unknownFinancial.missing.some((item) => item.field === 'annualProfit'), true);
  assert.equal(unknownFinancial.negativePoints, 0, 'unknown profit must not be scored as bad profit');
  assert.ok(unknown.fitScore < 75, 'unknown profit still cannot reach high fit');
  assert.equal(unknown.actionEligibility.highFit, false);
  assert.ok(known.fitScore >= 75);
});

test('source contradictions surface as evidence and confidence reasons without changing fit', () => {
  const clean = scoreOpportunity(baseDeal());
  const conflicted = scoreOpportunity(baseDeal({
    fieldConflicts: [{
      field: 'annualProfit',
      canonicalValue: 450000,
      observedValue: 520000,
      canonicalSource: { sourceId: 'deal-os-export', sourceName: 'Deal OS' },
      observedSource: { sourceId: 'daily-deal-update', sourceName: 'Daily update' },
      resolution: 'preserved-canonical',
    }],
  }));

  assert.equal(conflicted.fitScore, clean.fitScore, 'a contradiction must not silently move the score');
  assert.equal(conflicted.contradictionCount, 1);
  assert.equal(conflicted.evidence.some((row) => row.evidenceClass === 'contradicted'), true);
  assert.ok(conflicted.confidenceReasons.some((reason) => /disagree/i.test(reason)));
  const financial = conflicted.dimensions.find((d) => d.id === 'financial-fit');
  assert.equal(financial.contradictions.length, 1);
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

test('identical scoring inputs produce an identical fingerprint', () => {
  assert.equal(dealScoreFingerprint(baseDeal()), dealScoreFingerprint(baseDeal()));
});

test('volatile bookkeeping does not change the fingerprint', () => {
  const original = dealScoreFingerprint(baseDeal());
  const noisy = dealScoreFingerprint(baseDeal({
    firstSeenAt: '2026-02-01T00:00:00.000Z',
    lastSeenAt: '2026-08-16T00:00:00.000Z',
    isNew: true,
    dateAdded: '2026-07-01',
    lastUpdated: '2026-08-16',
    netMargin: 99,
    sourceRecords: [{ sourceId: 'x' }],
    deduplicationMatches: [{ id: 'y' }],
    raw: { anything: 'else' },
  }));
  assert.equal(noisy, original, 'observation bookkeeping must not look like a scoring change');
});

test('a material source change changes the fingerprint', () => {
  const original = dealScoreFingerprint(baseDeal());
  assert.notEqual(dealScoreFingerprint(baseDeal({ annualProfit: 460000 })), original);
  assert.notEqual(dealScoreFingerprint(baseDeal({ state: 'TX' })), original);
  assert.notEqual(dealScoreFingerprint(baseDeal({ description: 'Something materially different about the business.' })), original);
});

test('every fingerprint field is one the scorer or completeness policy reads', () => {
  // Guards against quietly widening the fingerprint back into volatile territory.
  assert.deepEqual([...dealScoreFingerprintFields].sort(), [
    'annualProfit', 'annualRevenue', 'askingPrice', 'brokerContact', 'brokerEmail', 'brokerName',
    'city', 'country', 'county', 'description', 'fiveYearsFlag', 'franchiseFlag', 'fullText',
    'industry', 'listingUrl', 'location', 'name', 'profitMultiple', 'remoteFlag', 'state',
    'yearsEstablished',
  ]);
});

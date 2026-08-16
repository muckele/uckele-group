import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';

const { createSqliteStorage, dealHunterOperatorOwnedScoreFields } = await import('../server/storage/sqlite.js');
const supabaseModule = await import('../server/storage/supabase.js');

function scorePayload(overrides = {}) {
  return {
    opportunity_id: 'opp-score-1',
    scored_at: '2026-08-16T12:00:00.000Z',
    deal_key: 'deal-score-1',
    name: 'Commercial Fire Safety Inspection Co',
    state: 'NY',
    listing_url: 'https://listings.example.invalid/opp-score-1',
    fit_score: 81,
    score_status: 'high-fit',
    confidence: 'high',
    completeness_score: 92,
    contradiction_count: 0,
    missing_evidence_count: 1,
    should_remove: false,
    high_fit: true,
    gate_count: 0,
    score_fingerprint: 'fingerprint-a',
    engine_version: 'deal-scoring-engine-v1',
    rules_version: 'deal-hunter-fit-v2',
    profile_version: 'deal-hunter-profile-v1',
    completeness_policy_version: 'deal-hunter-completeness-v1',
    dimensions: [{ id: 'financial-fit', contribution: 37 }],
    gates: [],
    applied_caps: [],
    missing_evidence: ['annualRevenue'],
    confidence_reasons: [],
    summary: { recommendation: 'High fit.' },
    ...overrides,
  };
}

function evidencePayload(fingerprint = 'fingerprint-a') {
  return [
    {
      ruleId: 'profit.in-band',
      ruleLabel: 'Annual profit inside the target band',
      dimension: 'financial-fit',
      evidenceClass: 'observed',
      field: 'annualProfit',
      value: 450000,
      terms: [],
      sourceId: 'deal-os-export',
      sourceName: 'Deal OS',
      sourceRecordId: 'row-9',
      listingUrl: 'https://listings.example.invalid/opp-score-1',
      observedAt: '2026-08-15',
    },
    {
      ruleId: 'recurring.present',
      ruleLabel: 'Recurring or repeat revenue signals',
      dimension: 'revenue-durability',
      evidenceClass: 'heuristic',
      field: 'fullText',
      value: null,
      terms: [`maintenance contracts (${fingerprint})`],
      sourceId: 'deal-os-export',
      sourceName: 'Deal OS',
      sourceRecordId: 'row-9',
      listingUrl: 'https://listings.example.invalid/opp-score-1',
      observedAt: '2026-08-15',
    },
  ];
}

async function seedOpportunity(storage, opportunityId = 'opp-score-1') {
  const now = '2026-08-16T11:00:00.000Z';
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: now,
    updated_at: now,
    canonical_name: 'Commercial Fire Safety Inspection Co',
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: null,
    identity_version: 'score-test-v1',
    status: 'active',
    metadata: {},
  });
}

function withStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-score-storage-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'scores.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

test('a machine score write persists the score and its evidence together', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);

  const written = await storage.writeDealHunterOpportunityScore(scorePayload(), evidencePayload());
  assert.equal(written.opportunity_id, 'opp-score-1');
  assert.equal(written.fit_score, 81);
  assert.equal(written.high_fit, true);
  assert.equal(written.should_remove, false);
  assert.deepEqual(written.missing_evidence, ['annualRevenue']);
  assert.equal(written.summary.recommendation, 'High fit.');

  const evidence = await storage.listDealHunterScoreEvidence('opp-score-1');
  assert.equal(evidence.length, 2);
  assert.equal(evidence.every((row) => row.score_fingerprint === 'fingerprint-a'), true);
  const observed = evidence.find((row) => row.rule_id === 'profit.in-band');
  assert.equal(observed.evidence_class, 'observed');
  assert.equal(observed.source_id, 'deal-os-export');
  assert.equal(observed.source_record_id, 'row-9');
});

test('rewriting a score replaces its evidence so none survives from an older fingerprint', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await storage.writeDealHunterOpportunityScore(scorePayload(), evidencePayload('fingerprint-a'));

  await storage.writeDealHunterOpportunityScore(
    scorePayload({ score_fingerprint: 'fingerprint-b', fit_score: 64, score_status: 'watchlist', high_fit: false }),
    evidencePayload('fingerprint-b').slice(0, 1),
  );

  const stored = await storage.getDealHunterOpportunityScore('opp-score-1');
  const evidence = await storage.listDealHunterScoreEvidence('opp-score-1');
  assert.equal(stored.score_fingerprint, 'fingerprint-b');
  assert.equal(stored.fit_score, 64);
  assert.equal(evidence.length, 1, 'stale evidence from the previous fingerprint must not survive');
  assert.equal(evidence.every((row) => row.score_fingerprint === 'fingerprint-b'), true);
});

test('a machine score write refuses to carry operator-owned fields', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);

  for (const field of dealHunterOperatorOwnedScoreFields) {
    await assert.rejects(
      storage.writeDealHunterOpportunityScore({ ...scorePayload(), [field]: 'anything' }, []),
      new RegExp(`operator-owned field "${field}"`),
      `machine writes must reject ${field}`,
    );
  }
});

test('operator decisions survive any number of machine rescores', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await storage.writeDealHunterOpportunityScore(scorePayload(), evidencePayload());

  await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-score-1',
    priority: 'urgent',
    note: 'Broker call scheduled; verify the maintenance contract base.',
    reviewed: true,
    reviewedBy: 'owner@example.invalid',
    reviewedFingerprint: 'fingerprint-a',
    reviewedAt: '2026-08-16T13:00:00.000Z',
  });

  for (const fingerprint of ['fingerprint-b', 'fingerprint-c', 'fingerprint-d']) {
    await storage.writeDealHunterOpportunityScore(
      scorePayload({ score_fingerprint: fingerprint, fit_score: 55, score_status: 'watchlist', high_fit: false }),
      evidencePayload(fingerprint),
    );
  }

  const stored = await storage.getDealHunterOpportunityScore('opp-score-1');
  assert.equal(stored.operator_priority, 'urgent');
  assert.equal(stored.operator_note, 'Broker call scheduled; verify the maintenance contract base.');
  assert.equal(stored.reviewed_by, 'owner@example.invalid');
  assert.equal(stored.reviewed_at, '2026-08-16T13:00:00.000Z');
  assert.equal(stored.reviewed_fingerprint, 'fingerprint-a');
  // The machine number moved underneath the human decision, and the row reports
  // the divergence rather than resolving it.
  assert.equal(stored.fit_score, 55);
  assert.equal(stored.changed_since_review, true);
});

test('an operator decision never rewrites machine-computed score fields', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await storage.writeDealHunterOpportunityScore(scorePayload(), evidencePayload());
  const before = await storage.getDealHunterOpportunityScore('opp-score-1');

  await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-score-1',
    priority: 'watch',
    // Machine-owned keys are simply not part of the operator contract.
    fit_score: 3,
    score_fingerprint: 'tampered',
    confidence: 'low',
  });

  const after = await storage.getDealHunterOpportunityScore('opp-score-1');
  assert.equal(after.operator_priority, 'watch');
  assert.equal(after.fit_score, before.fit_score);
  assert.equal(after.score_fingerprint, before.score_fingerprint);
  assert.equal(after.confidence, before.confidence);
  assert.equal(after.scored_at, before.scored_at);
});

test('changed-since-review is derived, not stored as its own workflow state', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await storage.writeDealHunterOpportunityScore(scorePayload(), evidencePayload());

  const unreviewed = await storage.getDealHunterOpportunityScore('opp-score-1');
  assert.equal(unreviewed.reviewed, false);
  assert.equal(unreviewed.changed_since_review, false, 'never reviewed is not the same as changed');

  await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-score-1', reviewed: true, reviewedBy: 'admin', reviewedFingerprint: 'fingerprint-a',
  });
  const reviewed = await storage.getDealHunterOpportunityScore('opp-score-1');
  assert.equal(reviewed.reviewed, true);
  assert.equal(reviewed.changed_since_review, false);

  await storage.writeDealHunterOpportunityScore(scorePayload({ score_fingerprint: 'fingerprint-z' }), []);
  const drifted = await storage.getDealHunterOpportunityScore('opp-score-1');
  assert.equal(drifted.changed_since_review, true);
});

test('an operator decision on an unscored opportunity is a no-op rather than a partial row', async (t) => {
  const storage = withStorage(t);
  const result = await storage.setDealHunterOpportunityOperatorDecision({ opportunityId: 'missing-opp', priority: 'high' });
  assert.equal(result, null);
  assert.equal(await storage.getDealHunterOpportunityScore('missing-opp'), null);
});

test('fingerprint lookup returns only the columns the refresh gate needs', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await seedOpportunity(storage, 'opp-score-2');
  await storage.writeDealHunterOpportunityScore(scorePayload(), []);
  await storage.writeDealHunterOpportunityScore(
    scorePayload({ opportunity_id: 'opp-score-2', deal_key: 'deal-score-2', score_fingerprint: 'fingerprint-two' }),
    [],
  );

  const fingerprints = await storage.listDealHunterOpportunityScoreFingerprints(['opp-score-1', 'opp-score-2', 'absent']);
  assert.equal(fingerprints.length, 2);
  assert.deepEqual(
    [...fingerprints].sort((left, right) => left.opportunity_id.localeCompare(right.opportunity_id))
      .map((row) => row.score_fingerprint),
    ['fingerprint-a', 'fingerprint-two'],
  );
  // semantic_digest joins the gate columns so the refresh can tell a material
  // change from a version-only rewrite without a per-row lookup.
  assert.deepEqual(
    Object.keys(fingerprints[0]).sort(),
    ['engine_version', 'opportunity_id', 'profile_version', 'rules_version', 'score_fingerprint', 'semantic_digest'],
  );
  assert.equal(await storage.listDealHunterOpportunityScoreFingerprints([]).then((rows) => rows.length), 0);
});

test('both storage providers expose the same scoring surface', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-score-parity-'));
  const sqlite = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'parity.sqlite') } });
  const supabase = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: { from: () => ({}), rpc: () => ({}) } },
  );
  try {
    for (const method of [
      'writeDealHunterOpportunityScore',
      'setDealHunterOpportunityOperatorDecision',
      'getDealHunterOpportunityScore',
      'listDealHunterOpportunityScores',
      'listDealHunterOpportunityScoreFingerprints',
      'listDealHunterScoreEvidence',
    ]) {
      assert.equal(typeof sqlite[method], 'function', `sqlite is missing ${method}`);
      assert.equal(typeof supabase[method], 'function', `supabase is missing ${method}`);
    }
    assert.deepEqual(
      [...supabaseModule.dealHunterOperatorOwnedScoreFields],
      [...dealHunterOperatorOwnedScoreFields],
      'providers must agree on which columns an operator owns',
    );
  } finally {
    sqlite.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

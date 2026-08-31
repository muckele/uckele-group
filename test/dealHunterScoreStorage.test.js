import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

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

test('only eligibility reconciliation can place historical scores in the current triage set', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await seedOpportunity(storage, 'opp-score-2');
  await storage.writeDealHunterOpportunityScore(scorePayload(), evidencePayload());
  await storage.writeDealHunterOpportunityScore(
    scorePayload({
      opportunity_id: 'opp-score-2',
      deal_key: 'deal-score-2',
      name: 'Second Current Opportunity',
      listing_url: 'https://listings.example.invalid/opp-score-2',
      score_fingerprint: 'fingerprint-two',
      fit_score: 72,
      score_status: 'watchlist',
      high_fit: false,
    }),
    evidencePayload('fingerprint-two'),
  );

  assert.ok(await storage.getDealHunterOpportunityScore('opp-score-1'), 'the historical score is durable');
  assert.equal(await storage.getCurrentDealHunterOpportunityScore('opp-score-1'), null);
  assert.equal(await storage.getCurrentDealHunterOpportunityScoreByDealKey('deal-score-1'), null);
  assert.deepEqual(
    await storage.listDealHunterOpportunityScores({ view: 'all', page: 1, pageSize: 1 }),
    {
      rows: [], total: 0,
      summary: { needsReview: 0, highPriority: 0, watchlist: 0, lowConfidence: 0, currentOpportunities: 0 },
      page: 1, pageSize: 1, totalPages: 1,
    },
  );

  const activated = await storage.reconcileDealHunterCurrentScoreEligibility(['opp-score-1', 'opp-score-2']);
  assert.deepEqual(activated, { activated: 2, deactivated: 0 });
  assert.ok(await storage.getCurrentDealHunterOpportunityScore('opp-score-1'));
  assert.equal(
    (await storage.getCurrentDealHunterOpportunityScoreByDealKey('deal-score-1')).opportunity_id,
    'opp-score-1',
  );

  const firstPage = await storage.listDealHunterOpportunityScores({ view: 'all', page: 1, pageSize: 1 });
  const secondPage = await storage.listDealHunterOpportunityScores({ view: 'all', page: 2, pageSize: 1 });
  assert.equal(firstPage.total, 2, 'counting must use the same current-only population as row selection');
  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.rows.length, 1);
  assert.equal(secondPage.rows.length, 1);
  assert.notEqual(firstPage.rows[0].opportunity_id, secondPage.rows[0].opportunity_id);

  const narrowed = await storage.reconcileDealHunterCurrentScoreEligibility(['opp-score-2']);
  assert.deepEqual(narrowed, { activated: 0, deactivated: 1 });
  assert.equal(await storage.getCurrentDealHunterOpportunityScore('opp-score-1'), null);
  assert.equal(await storage.getCurrentDealHunterOpportunityScoreByDealKey('deal-score-1'), null);
  const searched = await storage.listDealHunterOpportunityScores({
    view: 'all', search: 'Commercial Fire Safety', page: 1, pageSize: 25,
  });
  assert.equal(searched.total, 0, 'filters must never reach an inactive historical row');

  const historical = await storage.getDealHunterOpportunityScore('opp-score-1');
  const evidence = await storage.listDealHunterScoreEvidence('opp-score-1');
  assert.equal(historical.score_fingerprint, 'fingerprint-a');
  assert.equal(evidence.length, 2, 'deactivation preserves historical evidence');
});

test('superseded opportunities retain score history but cannot be scored, reactivated, or used in current triage', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await storage.writeDealHunterOpportunityScore(scorePayload(), evidencePayload());
  await storage.reconcileDealHunterCurrentScoreEligibility(['opp-score-1']);
  const opportunity = await storage.getDealHunterOpportunity('opp-score-1');
  await storage.upsertDealHunterOpportunity({
    ...opportunity,
    updated_at: '2026-08-27T11:00:00.000Z',
    status: 'superseded',
    metadata: { canonicalOpportunityMerge: { mergedInto: 'opp-score-survivor' } },
  });

  assert.equal((await storage.getDealHunterOpportunityScore('opp-score-1')).score_fingerprint, 'fingerprint-a');
  assert.equal((await storage.listDealHunterScoreEvidence('opp-score-1')).length, 2);
  assert.equal(await storage.getCurrentDealHunterOpportunityScore('opp-score-1'), null);
  assert.deepEqual(
    await storage.listDealHunterOpportunityScores({ view: 'all', page: 1, pageSize: 25 }),
    {
      rows: [], total: 0,
      summary: { needsReview: 0, highPriority: 0, watchlist: 0, lowConfidence: 0, currentOpportunities: 0 },
      page: 1, pageSize: 25, totalPages: 1,
    },
  );
  assert.deepEqual(
    await storage.reconcileDealHunterCurrentScoreEligibility(['opp-score-1']),
    { activated: 0, deactivated: 1 },
  );
  assert.equal(await storage.getCurrentDealHunterOpportunityScore('opp-score-1'), null);
  await assert.rejects(
    storage.writeDealHunterOpportunityScore(
      scorePayload({ score_fingerprint: 'superseded-rewrite' }),
      evidencePayload('superseded-rewrite'),
    ),
    /superseded|not current/i,
  );
  await assert.rejects(
    storage.setDealHunterOpportunityOperatorDecision({
      opportunityId: 'opp-score-1',
      priority: 'urgent',
      updatedAt: '2026-08-27T11:01:00.000Z',
    }),
    /superseded|not current/i,
  );
  assert.equal((await storage.getDealHunterOpportunityScore('opp-score-1')).operator_priority, 'normal');
});

test('machine score payloads cannot set current-triage eligibility', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await assert.rejects(
    storage.writeDealHunterOpportunityScore({ ...scorePayload(), current_triage_eligible: true }, []),
    /eligibility-owned field "current_triage_eligible"/,
  );
});

test('SQLite forward migration preserves existing scores as last-good current but keeps later inserts inactive', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-score-eligibility-migration-'));
  const sqlitePath = path.join(directory, 'legacy.sqlite');
  let storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => {
    storage?.close?.();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await seedOpportunity(storage);
  await storage.writeDealHunterOpportunityScore(scorePayload(), evidencePayload());
  await storage.reconcileDealHunterCurrentScoreEligibility(['opp-score-1']);
  storage.close();
  storage = null;

  const legacy = new Database(sqlitePath);
  legacy.exec(`
    DROP INDEX IF EXISTS idx_deal_hunter_scores_current_queue;
    DROP INDEX IF EXISTS idx_deal_hunter_scores_acquisition_priority;
    ALTER TABLE deal_hunter_opportunity_scores DROP COLUMN current_triage_eligible;
  `);
  legacy.close();

  storage = createSqliteStorage({ storage: { sqlitePath } });
  assert.ok(
    await storage.getCurrentDealHunterOpportunityScore('opp-score-1'),
    'the additive migration preserves the existing queue as last-known-good',
  );

  await seedOpportunity(storage, 'opp-score-2');
  await storage.writeDealHunterOpportunityScore(
    scorePayload({ opportunity_id: 'opp-score-2', deal_key: 'deal-score-2', score_fingerprint: 'fingerprint-two' }),
    [],
  );
  assert.equal(
    await storage.getCurrentDealHunterOpportunityScore('opp-score-2'),
    null,
    'the score INSERT explicitly remains inactive even though the legacy column default preserves old rows',
  );
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
    [
      'completeness_policy_version',
      'engine_version',
      'opportunity_id',
      'profile_version',
      'reviewed_at',
      'rules_version',
      'score_fingerprint',
      'semantic_digest',
    ],
  );
  assert.equal(await storage.listDealHunterOpportunityScoreFingerprints([]).then((rows) => rows.length), 0);
});

test('Supabase fingerprint lookup projects the same complete currentness contract', async () => {
  let selected = '';
  const row = {
    opportunity_id: 'opp-score-1',
    score_fingerprint: 'fingerprint-a',
    semantic_digest: 'digest-a',
    rules_version: 'deal-hunter-fit-v2.1',
    engine_version: 'deal-scoring-engine-v1',
    profile_version: 'deal-hunter-profile-v1',
    completeness_policy_version: 'deal-hunter-completeness-v1',
    reviewed_at: null,
  };
  const chain = {
    from(table) {
      assert.equal(table, 'deal_hunter_opportunity_scores');
      return chain;
    },
    select(fields) {
      selected = fields;
      return chain;
    },
    async in(column, values) {
      assert.equal(column, 'opportunity_id');
      assert.deepEqual(values, ['opp-score-1']);
      return { data: [row], error: null };
    },
  };
  const storage = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: chain },
  );

  assert.deepEqual(
    await storage.listDealHunterOpportunityScoreFingerprints(['opp-score-1']),
    [row],
  );
  assert.deepEqual(selected.split(/,\s*/).sort(), [
    'completeness_policy_version',
    'engine_version',
    'opportunity_id',
    'profile_version',
    'reviewed_at',
    'rules_version',
    'score_fingerprint',
    'semantic_digest',
  ]);
});

test('SQLite batches only core contradiction evidence for legacy digest compatibility', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await seedOpportunity(storage, 'opp-score-2');
  await storage.writeDealHunterOpportunityScore(scorePayload(), [{
    ruleId: 'evidence.contradiction',
    ruleLabel: 'Sources disagree on annualProfit',
    evidenceClass: 'contradicted',
    field: 'annualProfit',
    value: 450000,
    observedValue: 520000,
    sourceId: 'canonical-source',
    sourceRecordId: 'volatile-row-1',
    observedAt: '2026-08-29T00:00:00.000Z',
  }]);
  await storage.writeDealHunterOpportunityScore(
    scorePayload({
      opportunity_id: 'opp-score-2',
      deal_key: 'deal-score-2',
      score_fingerprint: 'fingerprint-two',
    }),
    evidencePayload('fingerprint-two'),
  );

  assert.deepEqual(
    await storage.listDealHunterContradictionEvidence(['opp-score-1', 'opp-score-2']),
    [{
      opportunity_id: 'opp-score-1',
      evidence_class: 'contradicted',
      field: 'annualProfit',
      value: '450000',
      observed_value: '520000',
    }],
  );
  assert.deepEqual(await storage.listDealHunterContradictionEvidence([]), []);
});

test('Supabase batches the same core contradiction evidence without provenance', async () => {
  let selected = '';
  const row = {
    opportunity_id: 'opp-score-1',
    evidence_class: 'contradicted',
    field: 'annualProfit',
    value: '450000',
    observed_value: '520000',
  };
  const chain = {
    from(table) {
      assert.equal(table, 'deal_hunter_score_evidence');
      return chain;
    },
    select(fields) {
      selected = fields;
      return chain;
    },
    eq(column, value) {
      assert.equal(column, 'evidence_class');
      assert.equal(value, 'contradicted');
      return chain;
    },
    async in(column, values) {
      assert.equal(column, 'opportunity_id');
      assert.deepEqual(values, ['opp-score-1']);
      return { data: [row], error: null };
    },
  };
  const storage = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: chain },
  );

  assert.deepEqual(await storage.listDealHunterContradictionEvidence(['opp-score-1']), [row]);
  assert.equal(
    selected,
    'opportunity_id, evidence_class, field, value, observed_value',
  );
  assert.deepEqual(await storage.listDealHunterContradictionEvidence([]), []);
});

// ---------------------------------------------------------------------------
// Supabase provider parity (Phase 3A.1 provider-parity patch)
//
// The SQL RPC (list_deal_hunter_opportunity_scores) already implements
// semantic-digest-first review comparison, validated against real PostgreSQL
// in Phase 3A.1 commit 4. This section covers the JS-side row normalization in
// server/storage/supabase.js, used by getDealHunterOpportunityScore and by the
// row returned from setDealHunterOpportunityOperatorDecision, which had drifted
// from that behaviour by comparing only the fingerprint.
// ---------------------------------------------------------------------------

// Minimal chainable stub matching exactly the query shapes
// getDealHunterOpportunityScore and setDealHunterOpportunityOperatorDecision
// issue against `deal_hunter_opportunity_scores`, following the inline mock
// convention used elsewhere for createSupabaseStorage (see
// communicationsStorage.test.js).
function supabaseRowClient(row) {
  let table = null;
  let pendingUpdate = null;
  let currentOnly = false;
  let currentAuthorityOnly = false;
  const chain = {
    from(name) {
      table = name;
      pendingUpdate = null;
      currentOnly = false;
      currentAuthorityOnly = false;
      return chain;
    },
    select() {
      return chain;
    },
    update(payload) {
      pendingUpdate = payload;
      return chain;
    },
    eq(column, value) {
      assert.equal(table, 'deal_hunter_opportunity_scores');
      if (column === 'opportunity_id') assert.equal(value, row.opportunity_id);
      else if (column === 'current_triage_eligible') {
        assert.equal(value, true);
        currentOnly = true;
      } else if (column === 'deal_hunter_opportunities.status') {
        assert.equal(value, 'active');
        currentAuthorityOnly = true;
      } else assert.fail(`unexpected Supabase score filter ${column}`);
      if (pendingUpdate) Object.assign(row, pendingUpdate);
      return chain;
    },
    limit() {
      return chain;
    },
    async maybeSingle() {
      if (currentOnly && !row.current_triage_eligible) return { data: null, error: null };
      if (currentAuthorityOnly && row.opportunity_status !== 'active') return { data: null, error: null };
      return { data: { ...row }, error: null };
    },
    async rpc(name, payload) {
      assert.equal(name, 'set_deal_hunter_opportunity_operator_decision');
      assert.equal(payload.p_opportunity_id, row.opportunity_id);
      Object.assign(row, payload.p_decision);
      return { data: { ...row }, error: null };
    },
  };
  return chain;
}

function storedScoreRow(overrides = {}) {
  return {
    opportunity_id: 'opp-score-1',
    scored_at: '2026-08-16T12:00:00.000Z',
    deal_key: 'deal-score-1',
    name: 'Commercial Fire Safety Inspection Co',
    fit_score: 81,
    score_status: 'high-fit',
    confidence: 'high',
    completeness_score: 92,
    should_remove: false,
    high_fit: true,
    score_fingerprint: 'fingerprint-a',
    semantic_digest: 'digest-a',
    rules_version: 'deal-hunter-fit-v2.1',
    dimensions: [],
    gates: [],
    applied_caps: [],
    missing_evidence: [],
    confidence_reasons: [],
    summary: {},
    operator_priority: 'normal',
    operator_note: null,
    reviewed_at: null,
    reviewed_by: null,
    reviewed_fingerprint: null,
    reviewed_semantic_digest: null,
    current_triage_eligible: true,
    opportunity_status: 'active',
    ...overrides,
  };
}

function supabaseStorageOver(row) {
  return supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: supabaseRowClient(row) },
  );
}

test('Supabase: same semantic digest with a different fingerprint is a version-only rewrite, not a change', async () => {
  const storage = supabaseStorageOver(storedScoreRow({
    reviewed_at: '2026-08-16T13:00:00.000Z',
    reviewed_by: 'owner@example.invalid',
    reviewed_fingerprint: 'fingerprint-old',
    reviewed_semantic_digest: 'digest-a',
    score_fingerprint: 'fingerprint-new',
    semantic_digest: 'digest-a',
  }));
  const row = await storage.getDealHunterOpportunityScore('opp-score-1');
  assert.equal(row.reviewed, true);
  assert.equal(row.changed_since_review, false, 'a version-only rewrite must not read as changed');
});

test('Supabase: a different semantic digest reads as changed since review', async () => {
  const storage = supabaseStorageOver(storedScoreRow({
    reviewed_at: '2026-08-16T13:00:00.000Z',
    reviewed_by: 'owner@example.invalid',
    reviewed_fingerprint: 'fingerprint-a',
    reviewed_semantic_digest: 'digest-old',
    semantic_digest: 'digest-new',
  }));
  const row = await storage.getDealHunterOpportunityScore('opp-score-1');
  assert.equal(row.changed_since_review, true);
});

test('Supabase: a legacy reviewed row with no semantic digest falls back to the fingerprint comparison', async () => {
  const unchanged = supabaseStorageOver(storedScoreRow({
    reviewed_at: '2026-08-16T13:00:00.000Z',
    reviewed_by: 'owner@example.invalid',
    reviewed_fingerprint: 'fingerprint-a',
    reviewed_semantic_digest: null,
    score_fingerprint: 'fingerprint-a',
  }));
  assert.equal((await unchanged.getDealHunterOpportunityScore('opp-score-1')).changed_since_review, false);

  const changed = supabaseStorageOver(storedScoreRow({
    reviewed_at: '2026-08-16T13:00:00.000Z',
    reviewed_by: 'owner@example.invalid',
    reviewed_fingerprint: 'fingerprint-old',
    reviewed_semantic_digest: null,
    score_fingerprint: 'fingerprint-new',
  }));
  assert.equal((await changed.getDealHunterOpportunityScore('opp-score-1')).changed_since_review, true);
});

test('Supabase: an opportunity that has never been reviewed is never changed since review', async () => {
  const storage = supabaseStorageOver(storedScoreRow({
    reviewed_at: null,
    reviewed_fingerprint: null,
    reviewed_semantic_digest: null,
  }));
  const row = await storage.getDealHunterOpportunityScore('opp-score-1');
  assert.equal(row.reviewed, false);
  assert.equal(row.changed_since_review, false, 'never reviewed is not the same as changed');
});

test('Supabase: an operator review decision persists the semantic digest alongside the fingerprint', async () => {
  const storage = supabaseStorageOver(storedScoreRow());
  const updated = await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-score-1',
    reviewed: true,
    reviewedBy: 'owner@example.invalid',
    reviewedFingerprint: 'fingerprint-a',
    reviewedSemanticDigest: 'digest-a',
    reviewedAt: '2026-08-16T13:00:00.000Z',
  });
  assert.equal(updated.reviewed_at, '2026-08-16T13:00:00.000Z');
  assert.equal(updated.reviewed_by, 'owner@example.invalid');
  assert.equal(updated.reviewed_fingerprint, 'fingerprint-a');
  assert.equal(updated.reviewed_semantic_digest, 'digest-a');
  assert.equal(updated.changed_since_review, false);
});

test('Supabase: omitting reviewedSemanticDigest persists null, never an empty string', async () => {
  const storage = supabaseStorageOver(storedScoreRow());
  const updated = await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-score-1',
    reviewed: true,
    reviewedBy: 'legacy-caller',
    reviewedFingerprint: 'fingerprint-a',
    // reviewedSemanticDigest intentionally omitted, as an older caller would.
  });
  assert.equal(updated.reviewed_semantic_digest, null, 'an omitted digest must persist as null, not ""');
  assert.notEqual(updated.reviewed_semantic_digest, '');

  // With no digest recorded, changed-since-review falls back to the
  // fingerprint comparison rather than treating "" as a meaningful digest.
  assert.equal(updated.changed_since_review, false, 'unchanged fingerprint, no digest recorded');
});

test('Supabase: a machine score write refuses to carry reviewed_semantic_digest', async () => {
  const storage = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: { rpc: () => { throw new Error('the ownership guard must reject before any network call'); } } },
  );
  await assert.rejects(
    storage.writeDealHunterOpportunityScore({ ...scorePayload(), reviewed_semantic_digest: 'attacker-supplied' }, []),
    /operator-owned field "reviewed_semantic_digest"/,
  );
});

test('Supabase: current lookup filters eligibility and reconciliation uses the dedicated RPC', async () => {
  const inactive = supabaseStorageOver(storedScoreRow({ current_triage_eligible: false }));
  assert.equal(await inactive.getCurrentDealHunterOpportunityScore('opp-score-1'), null);
  assert.ok(await inactive.getDealHunterOpportunityScore('opp-score-1'), 'historical lookup remains unfiltered');

  const calls = [];
  const storage = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    {
      client: {
        async rpc(name, payload) {
          calls.push({ name, payload });
          return { data: [{ activated: 3, deactivated: 2 }], error: null };
        },
      },
    },
  );
  assert.deepEqual(
    await storage.reconcileDealHunterCurrentScoreEligibility(['opp-3', 'opp-1', 'opp-3']),
    { activated: 3, deactivated: 2 },
  );
  assert.deepEqual(calls, [{
    name: 'reconcile_deal_hunter_current_score_eligibility',
    payload: { p_opportunity_ids: ['opp-3', 'opp-1'] },
  }]);
});

test('Supabase: current score lookup rejects a superseded opportunity without hiding score history', async () => {
  const storage = supabaseStorageOver(storedScoreRow({ opportunity_status: 'superseded' }));

  assert.equal(await storage.getCurrentDealHunterOpportunityScore('opp-score-1'), null);
  assert.equal((await storage.getDealHunterOpportunityScore('opp-score-1')).score_fingerprint, 'fingerprint-a');
});

test('Supabase: exact deal-key lookup requires current Inbox and canonical authority', async () => {
  const row = storedScoreRow();
  const filters = [];
  const chain = {
    from(table) {
      assert.equal(table, 'deal_hunter_opportunity_scores');
      return chain;
    },
    select(fields) {
      assert.equal(fields, '*,deal_hunter_opportunities!inner(status)');
      return chain;
    },
    eq(column, value) {
      filters.push([column, value]);
      return chain;
    },
    async limit(value) {
      assert.equal(value, 2);
      return { data: [{ ...row, deal_hunter_opportunities: { status: 'active' } }], error: null };
    },
  };
  const storage = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: chain },
  );

  assert.equal(
    (await storage.getCurrentDealHunterOpportunityScoreByDealKey('deal-score-1')).opportunity_id,
    'opp-score-1',
  );
  assert.deepEqual(filters, [
    ['deal_key', 'deal-score-1'],
    ['current_triage_eligible', true],
    ['deal_hunter_opportunities.status', 'active'],
  ]);
});

test('Supabase queue uses the bounded RPC and preserves its database summary', async () => {
  const calls = [];
  const storage = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    {
      client: {
        async rpc(name, payload) {
          calls.push({ name, payload });
          return {
            data: {
              total: 1,
              summary: {
                needsReview: 1, highPriority: 1, watchlist: 0, lowConfidence: 0, currentOpportunities: 1,
              },
              rows: [storedScoreRow({ opportunity_id: 'opp-queue', dimensions: undefined, summary: undefined })],
            },
            error: null,
          };
        },
      },
    },
  );

  const result = await storage.listDealHunterOpportunityScores({ page: 0, pageSize: 1000 });
  assert.deepEqual(calls, [{
    name: 'list_deal_hunter_opportunity_scores',
    payload: {
      p_view: 'needs-review', p_page: 1, p_page_size: 100, p_search: '',
      p_sort: 'fit-score', p_direction: 'desc', p_min_score: null,
      p_confidence: '', p_priority: '', p_state: '',
    },
  }]);
  assert.deepEqual(result.summary, {
    needsReview: 1, highPriority: 1, watchlist: 0, lowConfidence: 0, currentOpportunities: 1,
  });
  assert.equal(result.rows.length, 1);
});

test('Supabase queue forwards every advertised sort and normalizes the fixed acquisition ladder direction', async () => {
  const calls = [];
  const storage = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: { async rpc(name, payload) { calls.push({ name, payload }); return { data: { total: 0, rows: [], summary: {} }, error: null }; } } },
  );
  const sorts = ['acquisition-priority', 'fit-score', 'confidence', 'completeness', 'scored-at', 'name', 'changed'];
  for (const sort of sorts) {
    await storage.listDealHunterOpportunityScores({ sort, direction: 'asc' });
    await storage.listDealHunterOpportunityScores({ sort, direction: 'desc' });
  }
  await storage.listDealHunterOpportunityScores({ sort: 'not-an-advertised-sort' });
  assert.deepEqual(
    calls.map(({ name, payload }) => [name, payload.p_sort, payload.p_direction]),
    [
      ...sorts.flatMap((sort) => [
        ['list_deal_hunter_opportunity_scores', sort, sort === 'acquisition-priority' ? 'desc' : 'asc'],
        ['list_deal_hunter_opportunity_scores', sort, 'desc'],
      ]),
      ['list_deal_hunter_opportunity_scores', 'fit-score', 'desc'],
    ],
  );
});

test('both storage adapters normalize fractional and malformed queue pagination before SQL or RPC', async (t) => {
  const sqlite = withStorage(t);
  const sqlitePage = await sqlite.listDealHunterOpportunityScores({ page: '1.9', pageSize: '1.9' });
  assert.equal(sqlitePage.page, 1);
  assert.equal(sqlitePage.pageSize, 1);
  const sqliteMalformed = await sqlite.listDealHunterOpportunityScores({ page: 'not-a-number', pageSize: Infinity });
  assert.equal(sqliteMalformed.page, 1);
  assert.equal(sqliteMalformed.pageSize, 25);

  const calls = [];
  const supabase = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: { async rpc(name, payload) { calls.push({ name, payload }); return { data: { total: 0, rows: [], summary: {} }, error: null }; } } },
  );
  await supabase.listDealHunterOpportunityScores({ page: '1.9', pageSize: '1.9' });
  await supabase.listDealHunterOpportunityScores({ page: 'not-a-number', pageSize: Infinity });
  assert.deepEqual(calls.map(({ payload }) => [payload.p_page, payload.p_page_size]), [[1, 1], [1, 25]]);
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
      'getCurrentDealHunterOpportunityScore',
      'getCurrentDealHunterOpportunityScoreByDealKey',
      'reconcileDealHunterCurrentScoreEligibility',
      'listDealHunterOpportunityScores',
      'listDealHunterOpportunityScoreFingerprints',
      'listDealHunterContradictionEvidence',
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

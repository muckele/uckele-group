import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://example.invalid/daily-deal-hunter.csv';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

globalThis.fetch = async () => {
  throw new Error('The required Google Sheet is unavailable in this score-refresh test.');
};

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { importDealOsExport } = await import('../server/services/dealHunter.js');
const {
  fullRebuildConfirmation,
  previewOpportunityScoreRefresh,
  refreshOpportunityScores,
  requestOpportunityScoreRefresh,
} = await import('../server/services/dealHunterScoreStore.js');
const { listTriageQueue } = await import('../server/services/dealHunterTriage.js');
const { createManualSubmission } = await import('../server/services/submissions.js');
const { DEAL_SCORING_RULES_VERSION } = await import('../server/services/dealHunterScoringPolicy.js');

function scoredDeal(overrides = {}) {
  const deal = {
    id: 'source-1',
    opportunityId: 'opp-refresh-1',
    identityStatus: 'resolved',
    dealKey: 'deal-refresh-1',
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
    yearsEstablished: 14,
    fiveYearsFlag: 'Yes',
    remoteFlag: '',
    franchiseFlag: '',
    brokerName: 'Broker',
    brokerEmail: 'broker@example.invalid',
    brokerContact: '',
    listingUrl: 'https://listings.example.invalid/opp-refresh-1',
    sourceId: 'deal-os-export',
    sourceName: 'Deal OS',
    dateAdded: '2026-01-05',
    lastUpdated: '2026-01-06',
    ...overrides,
  };
  deal.fullText = [
    deal.name, deal.industry, deal.description, deal.city, deal.county, deal.state, deal.remoteFlag, deal.franchiseFlag,
  ].join(' ').replace(/\s+/g, ' ').trim();
  return deal;
}

function withStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-score-refresh-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'refresh.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

async function seedOpportunity(storage, opportunityId, primarySubmissionId = null) {
  const now = '2026-08-16T10:00:00.000Z';
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: now,
    updated_at: now,
    canonical_name: opportunityId,
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: primarySubmissionId,
    identity_version: 'refresh-test-v1',
    status: 'active',
    metadata: {},
  });
}

async function seedFreshCanonicalSources(t, storage, {
  sheetName = 'Current Required Sheet Co',
  sheetListingUrl = 'https://listings.example.invalid/current-sheet',
  dealOsName = 'Supplemental Deal OS Co',
  dealOsListingUrl = 'https://dealos.example.invalid/fresh-001',
} = {}) {
  const originalSheetUrl = process.env.DEAL_HUNTER_SHEET_CSV_URL;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  // This file configures the required Sheet before importing the service; the
  // application config is intentionally cached after import.
  const sheetUrl = 'https://example.invalid/daily-deal-hunter.csv';
  const baseNow = originalNow();
  process.env.DEAL_HUNTER_SHEET_CSV_URL = sheetUrl;
  Date.now = () => baseNow;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), sheetUrl);
    return new Response([
      'Business Name,State,Earnings,Revenue,Asking Price,Date Added,View Listing URL,Description',
      `${sheetName},CA,$450000,$1800000,$1250000,2026-08-25,${sheetListingUrl},Recurring commercial inspection contracts`,
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/csv' } });
  };
  t.after(() => {
    process.env.DEAL_HUNTER_SHEET_CSV_URL = originalSheetUrl;
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  });

  const imported = await importDealOsExport({
    fileName: 'fresh-deal-os.csv',
    fileBuffer: Buffer.from([
      'Listing ID,Business Name,State,Earnings,Revenue,Asking Price,Date Added,View Listing URL,Description',
      `FRESH-001,${dealOsName},TX,$700000,$2800000,$1900000,2026-08-20,${dealOsListingUrl},Recurring service contracts`,
    ].join('\n')),
    exportedAt: new Date(baseNow - (60 * 60 * 1000)).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Complete fresh saved-search export',
    importedBy: 'score-refresh-test',
    storage,
    now: new Date(baseNow),
  });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  return {
    advanceBeyondFreshness() {
      Date.now = () => baseNow + (80 * 60 * 60 * 1000);
    },
  };
}

test('the first refresh scores and persists evidence, and a repeat refresh writes nothing', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  const deals = [scoredDeal()];

  const first = await refreshOpportunityScores({ deals, storage });
  assert.equal(first.ok, true);
  assert.deepEqual(first.counts, { considered: 1, scored: 1, skipped: 0, failed: 0, changed: 1, versionOnly: 0 });

  const stored = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.ok(stored.fit_score > 0);
  assert.ok((await storage.listDealHunterScoreEvidence('opp-refresh-1')).length > 0);

  // A second pass over identical inputs must not write a row, replace evidence,
  // or emit an event.
  let writes = 0;
  const realWrite = storage.writeDealHunterOpportunityScore.bind(storage);
  storage.writeDealHunterOpportunityScore = async (...args) => { writes += 1; return realWrite(...args); };

  const second = await refreshOpportunityScores({ deals, storage });
  assert.equal(second.ok, true);
  assert.deepEqual(second.counts, { considered: 1, scored: 0, skipped: 1, failed: 0, changed: 0, versionOnly: 0 });
  assert.equal(writes, 0, 'an unchanged opportunity must not be rewritten');

  const after = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.equal(after.scored_at, stored.scored_at, 'scored_at must not churn on a no-op refresh');
});

test('a material source change rescores and replaces evidence atomically', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');

  await refreshOpportunityScores({ deals: [scoredDeal()], storage });
  const before = await storage.getDealHunterOpportunityScore('opp-refresh-1');

  const changed = await refreshOpportunityScores({
    deals: [scoredDeal({ annualProfit: 120000, annualRevenue: 400000 })],
    storage,
  });
  assert.deepEqual(changed.counts, { considered: 1, scored: 1, skipped: 0, failed: 0, changed: 1, versionOnly: 0 });

  const after = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.notEqual(after.score_fingerprint, before.score_fingerprint);
  assert.notEqual(after.fit_score, before.fit_score);

  const evidence = await storage.listDealHunterScoreEvidence('opp-refresh-1');
  assert.ok(evidence.length > 0);
  assert.equal(
    evidence.every((row) => row.score_fingerprint === after.score_fingerprint),
    true,
    'evidence must never describe a superseded fingerprint',
  );
});

test('volatile bookkeeping alone does not trigger a rescore', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await refreshOpportunityScores({ deals: [scoredDeal()], storage });

  const noisy = await refreshOpportunityScores({
    deals: [scoredDeal({
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-08-16T00:00:00.000Z',
      isNew: true,
      netMargin: 91,
      dateAdded: '2026-08-01',
      lastUpdated: '2026-08-16',
    })],
    storage,
  });
  assert.deepEqual(noisy.counts, { considered: 1, scored: 0, skipped: 1, failed: 0, changed: 0, versionOnly: 0 });
});

test('operator decisions survive rescoring, forced refresh, and retries', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await refreshOpportunityScores({ deals: [scoredDeal()], storage });

  await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-refresh-1',
    priority: 'urgent',
    note: 'Confirmed the contract base with the broker.',
    reviewed: true,
    reviewedBy: 'owner@example.invalid',
    reviewedFingerprint: (await storage.getDealHunterOpportunityScore('opp-refresh-1')).score_fingerprint,
  });

  await refreshOpportunityScores({ deals: [scoredDeal({ annualProfit: 500000 })], storage });
  await refreshOpportunityScores({ deals: [scoredDeal({ annualProfit: 500000 })], storage, force: true });
  await refreshOpportunityScores({ deals: [scoredDeal({ askingPrice: 2600000 })], storage });

  const stored = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.equal(stored.operator_priority, 'urgent');
  assert.equal(stored.operator_note, 'Confirmed the contract base with the broker.');
  assert.equal(stored.reviewed_by, 'owner@example.invalid');
  assert.equal(stored.changed_since_review, true, 'the operator should see that the machine judgment moved');
});

test('a forced refresh over unchanged inputs rewrites without claiming a change', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await refreshOpportunityScores({ deals: [scoredDeal()], storage });
  const before = await storage.getDealHunterOpportunityScore('opp-refresh-1');

  await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-refresh-1', reviewed: true, reviewedBy: 'admin', reviewedFingerprint: before.score_fingerprint,
  });

  const forced = await refreshOpportunityScores({ deals: [scoredDeal()], storage, force: true });
  // Rewritten, but the conclusions are identical, so it is a version-only write
  // and must not be reported or evented as a change.
  assert.deepEqual(forced.counts, { considered: 1, scored: 1, skipped: 0, failed: 0, changed: 0, versionOnly: 1 });

  const after = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.equal(after.score_fingerprint, before.score_fingerprint);
  assert.equal(after.changed_since_review, false, 'a forced rewrite of identical inputs is not a change');
});

test('a failed opportunity is reported without stopping the batch, and a retry resumes it', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await seedOpportunity(storage, 'opp-refresh-2');
  const deals = [
    scoredDeal(),
    scoredDeal({ opportunityId: 'opp-refresh-2', dealKey: 'deal-refresh-2', id: 'source-2', name: 'Second Synthetic Co' }),
  ];

  const realWrite = storage.writeDealHunterOpportunityScore.bind(storage);
  let injected = 0;
  storage.writeDealHunterOpportunityScore = async (score, evidence) => {
    if (score.opportunity_id === 'opp-refresh-2' && injected === 0) {
      injected += 1;
      throw new Error('injected transient score write failure');
    }
    return realWrite(score, evidence);
  };

  const partial = await refreshOpportunityScores({ deals, storage });
  assert.equal(partial.ok, false);
  assert.equal(partial.status, 207);
  assert.deepEqual(partial.counts, { considered: 2, scored: 1, skipped: 0, failed: 1, changed: 1, versionOnly: 0 });
  assert.equal(partial.errors[0].opportunityId, 'opp-refresh-2');
  assert.ok(await storage.getDealHunterOpportunityScore('opp-refresh-1'));
  assert.equal(await storage.getDealHunterOpportunityScore('opp-refresh-2'), null);

  // The retry redoes only the opportunity that did not land.
  const retry = await refreshOpportunityScores({ deals, storage });
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.counts, { considered: 2, scored: 1, skipped: 1, failed: 0, changed: 1, versionOnly: 0 });
  assert.ok(await storage.getDealHunterOpportunityScore('opp-refresh-2'));
});

test('refresh can be scoped to specific opportunities', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await seedOpportunity(storage, 'opp-refresh-2');
  const deals = [
    scoredDeal(),
    scoredDeal({ opportunityId: 'opp-refresh-2', dealKey: 'deal-refresh-2', id: 'source-2' }),
  ];

  const scoped = await refreshOpportunityScores({ deals, opportunityIds: ['opp-refresh-2'], storage });
  assert.deepEqual(scoped.counts, { considered: 1, scored: 1, skipped: 0, failed: 0, changed: 1, versionOnly: 0 });
  assert.equal(await storage.getDealHunterOpportunityScore('opp-refresh-1'), null);
  assert.ok(await storage.getDealHunterOpportunityScore('opp-refresh-2'));
});

test('unresolved canonical identities are never scored into the queue', async (t) => {
  const storage = withStorage(t);
  const result = await refreshOpportunityScores({
    deals: [scoredDeal({ identityStatus: 'ambiguous' }), scoredDeal({ opportunityId: '', identityStatus: 'unavailable' })],
    storage,
  });
  assert.deepEqual(result.counts, { considered: 0, scored: 0, skipped: 0, failed: 0, changed: 0, versionOnly: 0 });
});

test('a rescore emits one activity event only when the score actually moved', async (t) => {
  const storage = withStorage(t);
  const created = await createManualSubmission({
    name: 'Broker',
    email: 'broker@example.invalid',
    company: 'Commercial Fire Safety Inspection Co',
    message: 'Seed CRM record for the rescore activity event test.',
  }, 'admin', { storage });
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  const submission = created.submission;
  await seedOpportunity(storage, 'opp-refresh-1', submission.id);

  await refreshOpportunityScores({ deals: [scoredDeal()], storage });
  const afterFirst = await storage.listCrmActivityEvents({ submissionId: submission.id, limit: 50 });
  const firstRescores = afterFirst.filter((event) => event.event_type === 'opportunity.rescored');
  assert.equal(firstRescores.length, 1);
  assert.equal(firstRescores[0].metadata.previousScore, null);

  await refreshOpportunityScores({ deals: [scoredDeal()], storage });
  const afterNoop = await storage.listCrmActivityEvents({ submissionId: submission.id, limit: 50 });
  assert.equal(
    afterNoop.filter((event) => event.event_type === 'opportunity.rescored').length,
    1,
    'a fingerprint-identical refresh must not emit a rescore event',
  );

  await refreshOpportunityScores({ deals: [scoredDeal({ annualProfit: 120000 })], storage });
  const afterChange = await storage.listCrmActivityEvents({ submissionId: submission.id, limit: 50 });
  const rescores = afterChange.filter((event) => event.event_type === 'opportunity.rescored');
  assert.equal(rescores.length, 2);
  // Events written in the same millisecond have no guaranteed order, so assert
  // on the pair rather than on a position.
  const initial = rescores.filter((event) => event.metadata.previousScore === null);
  const moved = rescores.filter((event) => typeof event.metadata.previousScore === 'number');
  assert.equal(initial.length, 1, 'exactly one event records the first scoring');
  assert.equal(moved.length, 1, 'exactly one event records the score moving');
  assert.notEqual(moved[0].metadata.previousFingerprint, moved[0].metadata.fingerprint);
  assert.equal(moved[0].metadata.rulesVersion, DEAL_SCORING_RULES_VERSION);
  assert.ok(Array.isArray(moved[0].metadata.dimensionChanges));
  assert.ok(moved[0].metadata.dimensionChanges.some((change) => change.dimension === 'financial-fit'));
});

test('required-source outage defers implicit refresh and preview without erasing scores or writing activity', async (t) => {
  const storage = withStorage(t);
  const created = await createManualSubmission({
    name: 'Broker',
    email: 'broker@example.invalid',
    company: 'Preserved Score Co',
    message: 'Seed an existing score that must survive a temporary required-source outage.',
  }, 'admin', { storage });
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  await seedOpportunity(storage, 'opp-refresh-1', created.submission.id);
  await refreshOpportunityScores({ deals: [scoredDeal()], storage });
  await storage.reconcileDealHunterCurrentScoreEligibility(['opp-refresh-1']);
  const beforeScore = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  const beforeQueue = await listTriageQueue({ view: 'all', storage });
  assert.deepEqual(beforeQueue.rows.map((row) => row.opportunityId), ['opp-refresh-1']);
  const beforeEvents = await storage.listCrmActivityEvents({ submissionId: created.submission.id, limit: 50 });

  const refreshed = await refreshOpportunityScores({ storage });
  const previewed = await previewOpportunityScoreRefresh({ storage });

  assert.equal(refreshed.ok, false);
  assert.equal(refreshed.status, 503);
  assert.equal(refreshed.scoringDeferred, true);
  assert.deepEqual(refreshed.counts, { considered: 0, scored: 0, skipped: 0, failed: 0, changed: 0, versionOnly: 0 });
  assert.equal(previewed.ok, false);
  assert.equal(previewed.status, 503);
  assert.equal(previewed.scoringDeferred, true);
  const afterScore = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.equal(afterScore.score_fingerprint, beforeScore.score_fingerprint);
  assert.equal(afterScore.scored_at, beforeScore.scored_at);
  const afterEvents = await storage.listCrmActivityEvents({ submissionId: created.submission.id, limit: 50 });
  assert.equal(afterEvents.length, beforeEvents.length);
  assert.equal(afterEvents.filter((event) => event.event_type === 'opportunity.rescored').length, 1);
  const afterQueue = await listTriageQueue({ view: 'all', storage });
  assert.deepEqual(afterQueue.rows.map((row) => row.opportunityId), ['opp-refresh-1']);
});

test('fresh Deal OS becomes current, scoped calls preserve it, and authoritative recovery removes it only from current triage', async (t) => {
  const storage = withStorage(t);
  const sources = await seedFreshCanonicalSources(t, storage);

  const fresh = await refreshOpportunityScores({ storage });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  const freshQueue = await listTriageQueue({ view: 'all', pageSize: 100, storage });
  assert.deepEqual(new Set(freshQueue.rows.map((row) => row.name)), new Set([
    'Current Required Sheet Co', 'Supplemental Deal OS Co',
  ]));
  const sheet = freshQueue.rows.find((row) => row.name === 'Current Required Sheet Co');
  const supplemental = freshQueue.rows.find((row) => row.name === 'Supplemental Deal OS Co');
  assert.ok(sheet?.opportunityId);
  assert.ok(supplemental?.opportunityId);
  const historicalScore = await storage.getDealHunterOpportunityScore(supplemental.opportunityId);
  const historicalEvidence = await storage.listDealHunterScoreEvidence(supplemental.opportunityId);
  assert.ok(historicalEvidence.length > 0);

  const created = await createManualSubmission({
    name: 'Supplemental broker',
    email: 'supplemental-broker@example.invalid',
    company: 'Supplemental Deal OS Co',
    message: 'Link the historical score to verify reconciliation emits no fake rescore activity.',
  }, 'admin', { storage });
  const opportunity = await storage.getDealHunterOpportunity(supplemental.opportunityId);
  await storage.upsertDealHunterOpportunity({
    ...opportunity,
    updated_at: new Date().toISOString(),
    primary_submission_id: created.submission.id,
  });
  const eventsBefore = await storage.listCrmActivityEvents({ submissionId: created.submission.id, limit: 50 });

  sources.advanceBeyondFreshness();

  const preview = await previewOpportunityScoreRefresh({ storage });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(
    (await listTriageQueue({ view: 'all', pageSize: 100, storage })).rows.some(
      (row) => row.opportunityId === supplemental.opportunityId,
    ),
    true,
    'preview must never reconcile current-triage eligibility',
  );

  const partial = await refreshOpportunityScores({ reviewMode: 'daily', storage });
  assert.equal(partial.ok, true, JSON.stringify(partial));
  assert.equal(
    (await listTriageQueue({ view: 'all', pageSize: 100, storage })).rows.some(
      (row) => row.opportunityId === supplemental.opportunityId,
    ),
    true,
    'a partial daily refresh must never globally reconcile',
  );

  const explicit = await refreshOpportunityScores({
    deals: [scoredDeal({
      opportunityId: sheet.opportunityId,
      dealKey: sheet.dealKey,
      name: sheet.name,
      listingUrl: sheet.listingUrl,
      sourceId: 'google-sheet',
      sourceName: 'Required Google Sheet',
    })],
    storage,
  });
  assert.equal(explicit.ok, true, JSON.stringify(explicit));
  assert.equal(
    (await listTriageQueue({ view: 'all', pageSize: 100, storage })).rows.some(
      (row) => row.opportunityId === supplemental.opportunityId,
    ),
    true,
    'a generic refreshOpportunityScores({ deals: [...] }) must never globally reconcile',
  );

  const narrowed = await refreshOpportunityScores({ opportunityIds: [sheet.opportunityId], storage });
  assert.equal(narrowed.ok, true, JSON.stringify(narrowed));
  assert.equal(
    (await listTriageQueue({ view: 'all', pageSize: 100, storage })).rows.some(
      (row) => row.opportunityId === supplemental.opportunityId,
    ),
    true,
    'a narrowed opportunityIds refresh must never globally reconcile',
  );

  const reconciled = await refreshOpportunityScores({ storage });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  const current = await listTriageQueue({ view: 'all', pageSize: 100, storage });
  assert.deepEqual(current.rows.map((row) => row.name), ['Current Required Sheet Co']);
  assert.equal(await storage.getCurrentDealHunterOpportunityScore(supplemental.opportunityId), null);
  assert.equal(
    (await storage.getDealHunterOpportunityScore(supplemental.opportunityId)).score_fingerprint,
    historicalScore.score_fingerprint,
  );
  assert.equal(
    (await storage.listDealHunterScoreEvidence(supplemental.opportunityId)).length,
    historicalEvidence.length,
  );
  const eventsAfter = await storage.listCrmActivityEvents({ submissionId: created.submission.id, limit: 50 });
  assert.deepEqual(eventsAfter, eventsBefore, 'eligibility reconciliation must not fabricate a rescore event');
});

test('a cross-source canonical opportunity stays current when its supplemental representation becomes stale', async (t) => {
  const storage = withStorage(t);
  const listingUrl = 'https://listings.example.invalid/shared-canonical-listing';
  const sources = await seedFreshCanonicalSources(t, storage, {
    sheetName: 'Shared Canonical Services',
    sheetListingUrl: listingUrl,
    dealOsName: 'Shared Canonical Services',
    dealOsListingUrl: listingUrl,
  });

  const fresh = await refreshOpportunityScores({ storage });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  const before = await listTriageQueue({ view: 'all', pageSize: 100, storage });
  assert.equal(before.total, 1);
  const canonicalId = before.rows[0].opportunityId;

  sources.advanceBeyondFreshness();
  assert.equal((await refreshOpportunityScores({ storage })).ok, true);
  const after = await listTriageQueue({ view: 'all', pageSize: 100, storage });
  assert.equal(after.total, 1);
  assert.equal(after.rows[0].opportunityId, canonicalId);
});

test('authoritative reconciliation waits until every attempted score write succeeds', async (t) => {
  const storage = withStorage(t);
  const sources = await seedFreshCanonicalSources(t, storage);
  assert.equal((await refreshOpportunityScores({ storage })).ok, true);
  sources.advanceBeyondFreshness();

  const realWrite = storage.writeDealHunterOpportunityScore.bind(storage);
  storage.writeDealHunterOpportunityScore = async () => { throw new Error('injected authoritative write failure'); };
  const failed = await refreshOpportunityScores({ storage, force: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.counts.failed, 1);
  assert.equal(
    (await listTriageQueue({ view: 'all', pageSize: 100, storage })).total,
    2,
    'failed scoring preserves the entire last-good current set',
  );

  storage.writeDealHunterOpportunityScore = realWrite;
  assert.equal((await refreshOpportunityScores({ storage })).ok, true);
  assert.equal((await listTriageQueue({ view: 'all', pageSize: 100, storage })).total, 1);
});

test('an unavailable supplemental import lookup is excluded by the next healthy authoritative refresh', async (t) => {
  const storage = withStorage(t);
  await seedFreshCanonicalSources(t, storage);
  assert.equal((await refreshOpportunityScores({ storage })).ok, true);
  const before = await listTriageQueue({ view: 'all', pageSize: 100, storage });
  const supplemental = before.rows.find((row) => row.name === 'Supplemental Deal OS Co');
  assert.ok(supplemental);

  storage.getLatestDealHunterDealOsImport = async () => { throw new Error('injected import lookup outage'); };
  const refreshed = await refreshOpportunityScores({ storage });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  assert.equal((await listTriageQueue({ view: 'all', pageSize: 100, storage })).total, 1);
  assert.equal(await storage.getCurrentDealHunterOpportunityScore(supplemental.opportunityId), null);
  assert.ok(await storage.getDealHunterOpportunityScore(supplemental.opportunityId));
  assert.ok((await storage.listDealHunterScoreEvidence(supplemental.opportunityId)).length > 0);
});

test('a full forced rebuild requires the typed confirmation', async (t) => {
  const storage = withStorage(t);
  const rejected = await requestOpportunityScoreRefresh({ force: true, confirmation: 'nope', storage });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 400);
  assert.match(rejected.error, /REBUILD ALL SCORES/);

  // A scoped forced refresh is bounded and needs no confirmation.
  await seedOpportunity(storage, 'opp-refresh-1');
  const scoped = await requestOpportunityScoreRefresh({
    force: true, opportunityIds: ['opp-refresh-1'], requestedBy: 'admin', storage,
  });
  assert.notEqual(scoped.status, 400);
  assert.equal(fullRebuildConfirmation, 'REBUILD ALL SCORES');
});

test('scoring reports unavailable storage instead of failing opaquely', async () => {
  const result = await refreshOpportunityScores({ deals: [scoredDeal()], storage: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.ok(result.missingMethods.includes('writeDealHunterOpportunityScore'));
});

// ---------------------------------------------------------------------------
// Rules-version bump behaviour (Phase 3A.1)
//
// A rules bump stales every stored fingerprint. These assert that a bump which
// reproduces the same conclusions is a version-only rewrite: it does not flood
// the review queue and does not emit a rescore event.
// ---------------------------------------------------------------------------

test('a version-only rewrite does not flag a reviewed opportunity as changed', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await refreshOpportunityScores({ deals: [scoredDeal()], storage });

  const scored = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-refresh-1',
    reviewed: true,
    reviewedBy: 'owner@example.invalid',
    reviewedFingerprint: scored.score_fingerprint,
    reviewedSemanticDigest: scored.semantic_digest,
  });
  assert.equal((await storage.getDealHunterOpportunityScore('opp-refresh-1')).changed_since_review, false);

  // Simulate the version bump: force a rewrite over identical inputs. The row is
  // rewritten and its fingerprint may move, but the conclusions did not.
  const forced = await refreshOpportunityScores({ deals: [scoredDeal()], storage, force: true });
  assert.equal(forced.counts.versionOnly, 1);
  assert.equal(forced.counts.changed, 0);

  const after = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.equal(after.changed_since_review, false, 'a version-only rewrite must not stale the review');
  assert.equal(after.reviewed_by, 'owner@example.invalid');
});

test('a semantic change still flags a reviewed opportunity as changed', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await refreshOpportunityScores({ deals: [scoredDeal()], storage });

  const scored = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-refresh-1',
    reviewed: true,
    reviewedBy: 'owner@example.invalid',
    reviewedFingerprint: scored.score_fingerprint,
    reviewedSemanticDigest: scored.semantic_digest,
  });

  const changed = await refreshOpportunityScores({ deals: [scoredDeal({ annualProfit: 120000 })], storage });
  assert.equal(changed.counts.changed, 1);
  assert.equal(changed.counts.versionOnly, 0);

  const after = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.equal(after.changed_since_review, true);
  assert.equal(after.reviewed_by, 'owner@example.invalid', 'the earlier review is remembered, not erased');
});

test('the refresh preview separates material change from version-only change and writes nothing', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await seedOpportunity(storage, 'opp-refresh-2');
  const first = scoredDeal();
  const second = scoredDeal({ opportunityId: 'opp-refresh-2', dealKey: 'deal-refresh-2', id: 'source-2' });
  await refreshOpportunityScores({ deals: [first, second], storage });
  const before = await storage.getDealHunterOpportunityScore('opp-refresh-1');

  const preview = await previewOpportunityScoreRefresh({
    deals: [first, scoredDeal({ opportunityId: 'opp-refresh-2', dealKey: 'deal-refresh-2', id: 'source-2', annualProfit: 120000 })],
    storage,
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview, true);
  assert.equal(preview.counts.considered, 2);
  assert.equal(preview.counts.unchanged, 1, 'the untouched listing needs no write');
  assert.equal(preview.counts.semanticChange, 1);
  assert.equal(preview.counts.scoreChange, 1);
  assert.equal(preview.counts.estimatedWrites, 1);
  assert.equal(preview.proposedRulesVersion, 'deal-hunter-fit-v2.1');
  assert.ok(preview.samples.some((item) => item.opportunityId === 'opp-refresh-2'));

  // A preview is read-only.
  const after = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.equal(after.scored_at, before.scored_at);
  assert.equal(after.score_fingerprint, before.score_fingerprint);
});

test('the preview counts opportunities that have never been scored', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  const preview = await previewOpportunityScoreRefresh({ deals: [scoredDeal()], storage });
  assert.equal(preview.counts.newlyScored, 1);
  assert.equal(preview.counts.estimatedWrites, 1);
  assert.equal(preview.counts.semanticChange, 0);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  buildOpportunitySourceObservationSnapshot,
  setOperatorOpportunityFact,
} from '../server/services/dealHunterOpportunityFacts.js';
import { refreshOpportunityScores } from '../server/services/dealHunterScoreStore.js';
import { getTriageOpportunityDetail, passTriageOpportunity } from '../server/services/dealHunterTriage.js';
import { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } from '../server/services/dealHunterSourceSnapshotAdmission.js';
import { restoreDealHunterOpportunity } from '../server/services/leadLifecycle.js';

process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/test/gviz/tq?tqx=out:csv&gid=123';
process.env.DEAL_HUNTER_AIRTABLE_TOKEN = 'test-token';
process.env.DEAL_HUNTER_AIRTABLE_BASE_ID = 'appTest';
process.env.DEAL_HUNTER_AIRTABLE_TABLE_ID = 'tblTest';
process.env.DEAL_HUNTER_AIRTABLE_VIEW_ID = 'viwTest';

const originalFetch = globalThis.fetch;
const { importDealOsExport, parseSheetCsvDeals, reviewDailyDeals } = await import('../server/services/dealHunter.js');

test('an admitted complete Sheet with an identity exception retains evidence and defers current projection', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-deferred-sheet-'));
  const sqlitePath = path.join(directory, 'deferred.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const at = '2026-09-23T12:00:00.000Z';
  const [resolvedDeal, ambiguousDeal] = parseSheetCsvDeals([
    'Listing ID,Business Name,Listing URL,Posted Date',
    'DEFER-1,Resolved Shop,https://example.test/defer-1,2026-09-22',
    'DEFER-2,Ambiguous Shop,https://example.test/defer-2,2026-09-22',
  ].join('\n')).deals;
  const positionDeal = { ...resolvedDeal, id: '', stableExternalId: false,
    idFromSourceRowPosition: true, sourceRowId: '2' };
  const movedPositionDeal = { ...positionDeal, sourceRowId: '5' };
  const ambiguousPositionDeal = { ...ambiguousDeal, id: '', stableExternalId: false,
    idFromSourceRowPosition: true, sourceRowId: '3' };
  const movedAmbiguousDeal = { ...ambiguousPositionDeal, sourceRowId: '6' };
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'op-deferred-resolved', created_at: at, updated_at: at,
    canonical_name: 'Resolved Shop', identity_version: 'test', status: 'active', metadata: {},
  });
  await storage.markDealHunterOpportunityDiscoveryPending({ opportunityId: 'op-deferred-resolved', createdAt: at });
  const prior = buildOpportunitySourceObservationSnapshot({
    opportunityId: 'op-deferred-resolved', deal: positionDeal, now: at,
  });
  await storage.replaceDealHunterOpportunitySourceObservationSnapshot(prior);
  await storage.upsertDealHunterIdentityException({
    id: 'deferred-exception', created_at: at, updated_at: at, status: 'open',
    reason: 'ambiguous', evidence_version: 'test', candidate_opportunity_ids: [], metadata: {},
  });
  const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId: 'deferred-run' });
  const accepted = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
    storage, reviewMode: 'full-backfill', run,
    sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
      sourceRowCount: 2, rowCount: 2, coverageLimitReached: false },
    deals: [positionDeal, ambiguousPositionDeal] },
    records: [prior],
    unresolved: [{ source_record_id: 'sheet-row:3', identity_exception_id: 'deferred-exception',
      freshness_evidence: ambiguousDeal.freshnessEvidence }],
  });
  assert.equal(accepted.reconciled, true);
  const db = new Database(sqlitePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT projection_state FROM deal_hunter_source_freshness_state WHERE source_id='sheet-0'").get().projection_state, 'deferred');
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_freshness_evidence WHERE run_id='deferred-run' AND event_type='accepted_source_record' AND field_key=''").get().n, 2);
  assert.equal(db.prepare("SELECT identity_exception_id FROM deal_hunter_freshness_evidence WHERE source_record_id='sheet-row:3' AND event_type='accepted_source_record' AND field_key=''").get().identity_exception_id, 'deferred-exception');
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_opportunity_source_observations WHERE source_id='sheet-0'").get().n, prior.observations.length);
  assert.equal((await storage.getDealHunterOpportunity('op-deferred-resolved')).first_accepted_at, null);
  const deferredProof = db.prepare("SELECT id, accepted_at FROM deal_hunter_freshness_evidence WHERE source_record_id='sheet-row:3' AND event_type='accepted_source_record' AND field_key=''").get();
  const resolvedDeferredProof = db.prepare("SELECT id, accepted_at FROM deal_hunter_freshness_evidence WHERE source_record_id='sheet-row:2' AND event_type='accepted_source_record' AND field_key=''").get();
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'op-deferred-later', created_at: at, updated_at: at,
    canonical_name: 'Ambiguous Shop', identity_version: 'test', status: 'active', metadata: {},
  });
  await storage.markDealHunterOpportunityDiscoveryPending({ opportunityId: 'op-deferred-later', createdAt: at });
  await storage.upsertDealHunterIdentityException({
    id: 'deferred-exception', created_at: at, updated_at: at, status: 'resolved',
    reason: 'ambiguous', evidence_version: 'test', resolved_at: at,
    resolved_by: 'synthetic-test', resolution_reason: 'proved listing identity',
    candidate_opportunity_ids: [], metadata: { resolvedOpportunityId: 'op-deferred-later' },
  });
  const secondRun = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId: 'resolved-run' });
  const resolved = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
    storage, reviewMode: 'full-backfill', run: secondRun,
    sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
      sourceRowCount: 2, rowCount: 2, coverageLimitReached: false },
    deals: [movedPositionDeal, movedAmbiguousDeal] },
    records: [buildOpportunitySourceObservationSnapshot({
      opportunityId: 'op-deferred-resolved', deal: movedPositionDeal, now: at,
    }), buildOpportunitySourceObservationSnapshot({
      opportunityId: 'op-deferred-later', deal: movedAmbiguousDeal, now: at,
    })],
  });
  assert.equal(resolved.reconciled, true);
  const later = await storage.getDealHunterOpportunity('op-deferred-later');
  assert.equal(later.first_discovery_evidence_id, deferredProof.id);
  assert.equal(later.first_accepted_at, deferredProof.accepted_at);
  assert.equal(later.discovery_state, 'known_recovered');
  assert.equal(later.discovery_revision, 1);
  assert.equal(db.prepare('SELECT current_canonical_id FROM deal_hunter_freshness_evidence WHERE id = ?').get(deferredProof.id).current_canonical_id, 'op-deferred-later');
  const earlyResolved = await storage.getDealHunterOpportunity('op-deferred-resolved');
  assert.equal(earlyResolved.first_discovery_evidence_id, resolvedDeferredProof.id);
  assert.equal(earlyResolved.first_accepted_at, resolvedDeferredProof.accepted_at);
  assert.equal(earlyResolved.discovery_state, 'known_recovered');
});

test('comparable Sheet price A to B to A to B creates three retained material transitions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-material-'));
  const sqlitePath = path.join(directory, 'material.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const at = '2026-09-23T12:00:00.000Z';
  const opportunityId = 'op-price-transition';
  await storage.upsertDealHunterOpportunity({ opportunity_id: opportunityId, created_at: at,
    updated_at: at, canonical_name: 'Price Transition', identity_version: 'test',
    status: 'active', metadata: {} });
  await storage.markDealHunterOpportunityDiscoveryPending({ opportunityId, createdAt: at });
  let firstRecord;
  let firstRun;
  for (const [index, value] of [100, 120, 100, 120].entries()) {
    const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId: `price-run-${index}` });
    const record = { opportunity_id: opportunityId, source_id: 'sheet-0', source_name: 'Synthetic Sheet',
      source_record_id: 'external:PRICE-1', observations: [{
        id: 'price-observation', opportunity_id: opportunityId, source_id: 'sheet-0',
        source_name: 'Synthetic Sheet', source_record_id: 'external:PRICE-1',
        field: 'asking_price', value: String(value), observed_at: at, created_at: at, updated_at: at,
      }], freshness_evidence: { askingPrice: { rawHeader: 'Asking Price', rawValue: String(value),
        metric: 'asking_price', currency: 'USD', period: 'total' } } };
    if (index === 0) { firstRecord = record; firstRun = run; }
    const accepted = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage, reviewMode: 'full-backfill', run,
      sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
        sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-0', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'PRICE-1' }] },
      records: [record],
    });
    assert.equal(accepted.reconciled, true);
  }
  const db = new Database(sqlitePath, { readonly: true });
  t.after(() => db.close());
  const events = db.prepare("SELECT before_value, after_value, before_evidence_id, after_evidence_id, material_revision FROM deal_hunter_freshness_evidence WHERE event_type='material_change' ORDER BY generation").all();
  assert.deepEqual(events.map(({ before_value, after_value }) => [before_value, after_value]),
    [[100, 120], [120, 100], [100, 120]]);
  assert.deepEqual(events.map((event) => event.material_revision), [1, 2, 3]);
  assert.equal(events.every((event) => event.before_evidence_id && event.after_evidence_id), true);
  assert.equal((await storage.getDealHunterOpportunity(opportunityId)).material_revision, 3);
  await assert.rejects(reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
    storage, reviewMode: 'full-backfill', run: firstRun,
    sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
      sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
    deals: [{ sourceId: 'sheet-0', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'PRICE-1' }] },
    records: [firstRecord],
  }), /Stale or conflicting complete Sheet freshness run/);
  const removalRun = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId: 'price-removal' });
  const removed = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
    storage, reviewMode: 'full-backfill', run: removalRun,
    sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
      sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
    deals: [{ sourceId: 'sheet-0', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'OTHER' }] },
    records: [{ opportunity_id: opportunityId, source_id: 'sheet-0', source_name: 'Synthetic Sheet',
      source_record_id: 'external:OTHER', observations: [{ id: 'other-observation',
        opportunity_id: opportunityId, source_id: 'sheet-0', source_name: 'Synthetic Sheet',
        source_record_id: 'external:OTHER', field: 'name', value: 'Price Transition',
        observed_at: at, created_at: at, updated_at: at }], freshness_evidence: null }],
  });
  assert.equal(removed.reconciled, true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_opportunity_source_observations WHERE source_id='sheet-0' AND field='asking_price'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_freshness_evidence WHERE event_type='evidence_state_change' AND classification='disappearance'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_freshness_evidence WHERE event_type='material_change'").get().n, 3);
  assert.equal((await storage.getDealHunterOpportunity(opportunityId)).material_revision, 3);
});

test('synthetic supported Sheet publication keeps date precision and rejects malformed or future recency', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-publication-'));
  const sqlitePath = path.join(directory, 'publication.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const at = '2026-09-23T12:00:00.000Z';
  await storage.upsertDealHunterOpportunity({ opportunity_id: 'op-publication', created_at: at,
    updated_at: at, canonical_name: 'Publication Fixture', identity_version: 'test',
    status: 'active', metadata: {} });
  await storage.markDealHunterOpportunityDiscoveryPending({ opportunityId: 'op-publication', createdAt: at });
  const db = new Database(sqlitePath);
  t.after(() => db.close());
  db.prepare(`INSERT INTO deal_hunter_opportunity_scores
    (opportunity_id, created_at, scored_at, deal_key, name, fit_score,
      confidence, score_fingerprint, engine_version, rules_version,
      profile_version, completeness_policy_version, current_triage_eligible)
    VALUES ('op-publication', ?, ?, 'op-publication', 'Publication Fixture', 90,
      'high', 'publication-score', 'test', 'test', 'test', 'test', 1)`).run(at, at);
  for (const [index, rawValue, state] of [
    [0, '2026-09-22', 'valid'], [1, '2026-02-30', 'invalid'], [2, '2099-01-01', 'future'],
  ]) {
    const runId = `publication-${index}`;
    const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId });
    const record = { opportunity_id: 'op-publication', source_id: 'sheet-0',
      source_name: 'Synthetic Sheet', source_record_id: 'external:PUB-1',
      observations: [{ id: 'pub-observation', opportunity_id: 'op-publication',
        source_id: 'sheet-0', source_name: 'Synthetic Sheet', source_record_id: 'external:PUB-1',
        field: 'date_added', value: rawValue, observed_at: at, created_at: at, updated_at: at }],
      freshness_evidence: { dateAdded: { rawHeader: 'Posted Date', rawValue,
        precision: 'date', offset: null, meaning: 'listing_publication' } } };
    const accepted = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage, reviewMode: 'full-backfill', run,
      sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
        sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-0', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'PUB-1' }] },
      records: [record],
    });
    assert.equal(accepted.reconciled, true);
    const event = db.prepare("SELECT publication_state, publication_precision, publication_date FROM deal_hunter_freshness_evidence WHERE run_id=? AND event_type='publication_evidence'").get(runId);
    assert.equal(event.publication_state, state);
    assert.equal(event.publication_precision, 'date');
    if (state === 'valid') assert.equal(event.publication_date, rawValue);
    const inbox = await storage.listDealHunterFreshInbox({ area: 'new-important', asOf: at });
    assert.equal(inbox.areas[0].rows[0].recently_listed, state === 'valid');
    assert.equal(inbox.areas[0].rows[0].age_unknown, state !== 'valid');
    if (index === 0) {
      db.prepare(`INSERT INTO deal_hunter_freshness_evidence
        (id, source_id, source_name, source_record_id, run_id, generation,
          event_type, current_canonical_id)
        VALUES ('publication-peer-core', 'synthetic-peer', 'Synthetic peer',
          'external:PEER', 'publication-peer-run', 1, 'accepted_source_record',
          'op-publication')`).run();
      db.prepare(`INSERT INTO deal_hunter_freshness_evidence
        (id, source_id, source_name, source_record_id, run_id, generation,
          event_type, field_key, current_canonical_id, publication_meaning,
          publication_date, publication_precision, publication_state)
        VALUES ('publication-peer-date', 'synthetic-peer', 'Synthetic peer',
          'external:PEER', 'publication-peer-run', 1, 'publication_evidence',
          'date_added', 'op-publication', 'listing_publication', '2026-09-20',
          'date', 'valid')`).run();
      db.prepare(`INSERT INTO deal_hunter_opportunity_source_observations
        (id, opportunity_id, source_id, source_name, source_record_id, field,
          value, observed_at, created_at, updated_at, accepted_evidence_id)
        VALUES ('publication-peer-observation', 'op-publication', 'synthetic-peer',
          'Synthetic peer', 'external:PEER', 'date_added', '2026-09-20',
          ?, ?, ?, 'publication-peer-core')`).run(at, at, at);
      const conflict = await storage.listDealHunterFreshInbox({ area: 'new-important', asOf: at });
      assert.equal(conflict.areas[0].rows[0].recently_listed, false);
      assert.equal(conflict.areas[0].rows[0].age_unknown, true);
    }
  }
});

test('a pre-cutover legacy opportunity stays first-seen unknown after its first accepted Sheet refresh', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-legacy-'));
  const sqlitePath = path.join(directory, 'legacy.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const at = '2026-09-23T12:00:00.000Z';
  await storage.upsertDealHunterOpportunity({ opportunity_id: 'op-legacy-fl01', created_at: at,
    updated_at: at, canonical_name: 'Legacy Fixture', identity_version: 'test',
    status: 'active', metadata: {} });
  const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId: 'legacy-first-refresh' });
  const accepted = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
    storage, reviewMode: 'full-backfill', run,
    sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
      sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
    deals: [{ sourceId: 'sheet-0', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'LEGACY' }] },
    records: [{ opportunity_id: 'op-legacy-fl01', source_id: 'sheet-0',
      source_name: 'Synthetic Sheet', source_record_id: 'external:LEGACY',
      observations: [{ id: 'legacy-observation', opportunity_id: 'op-legacy-fl01',
        source_id: 'sheet-0', source_name: 'Synthetic Sheet', source_record_id: 'external:LEGACY',
        field: 'name', value: 'Legacy Fixture', observed_at: at, created_at: at, updated_at: at }],
      freshness_evidence: null }],
  });
  assert.equal(accepted.reconciled, true);
  const legacy = await storage.getDealHunterOpportunity('op-legacy-fl01');
  assert.equal(legacy.discovery_state, 'untracked_legacy');
  assert.equal(legacy.first_accepted_at, null);
  assert.equal(legacy.discovery_revision, 0);
  const db = new Database(sqlitePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_freshness_evidence WHERE run_id='legacy-first-refresh'").get().n, 1);
});

test('two disagreeing current sources classify a price conflict rather than a canonical price rise', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-price-conflict-'));
  const sqlitePath = path.join(directory, 'conflict.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const at = '2026-09-23T12:00:00.000Z';
  const opportunityId = 'op-price-conflict';
  await storage.upsertDealHunterOpportunity({ opportunity_id: opportunityId,
    created_at: at, updated_at: at, canonical_name: 'Conflicting Price',
    identity_version: 'test', status: 'active', metadata: {} });
  await storage.markDealHunterOpportunityDiscoveryPending({ opportunityId, createdAt: at });
  const acceptPrice = async (value, runId) => {
    const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId });
    return reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage, reviewMode: 'full-backfill', run,
      sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
        sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-0', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'CONFLICT' }] },
      records: [{ opportunity_id: opportunityId, source_id: 'sheet-0', source_name: 'Synthetic Sheet',
        source_record_id: 'external:CONFLICT', observations: [{ id: 'conflict-sheet-price',
          opportunity_id: opportunityId, source_id: 'sheet-0', source_name: 'Synthetic Sheet',
          source_record_id: 'external:CONFLICT', field: 'asking_price', value: String(value),
          observed_at: at, created_at: at, updated_at: at }],
        freshness_evidence: { askingPrice: { rawHeader: 'Asking Price', rawValue: String(value),
          metric: 'asking_price', currency: 'USD', period: 'total' } } }],
    });
  };
  assert.equal((await acceptPrice(100, 'conflict-first')).reconciled, true);
  await storage.upsertDealHunterOpportunitySourceObservation({
    id: 'competing-price', opportunity_id: opportunityId, source_id: 'deal-os-export',
    source_name: 'Synthetic Deal OS', source_record_id: 'external:OTHER',
    field: 'asking_price', value: '90', observed_at: at, created_at: at, updated_at: at,
  });
  assert.equal((await acceptPrice(120, 'conflict-second')).reconciled, true);
  const db = new Database(sqlitePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_freshness_evidence WHERE event_type='material_change'").get().n, 0);
  assert.equal(db.prepare("SELECT classification FROM deal_hunter_freshness_evidence WHERE run_id='conflict-second' AND event_type='evidence_state_change'").get().classification, 'conflict');
  assert.equal((await storage.getDealHunterOpportunity(opportunityId)).material_revision, 0);
});

test('source parsing retains bounded date and financial provenance before aliases collapse', () => {
  const [deal] = parseSheetCsvDeals([
    'Listing ID,Business Name,Listing URL,Posted Date,Annual Profit,Annual Revenue,Asking Price',
    'PROVENANCE-1,Provenance Shop,https://example.test/provenance,2026-09-22,450000,900000,800000',
  ].join('\n')).deals;
  assert.equal(deal.freshnessEvidence.dateAdded.rawHeader, 'Posted Date');
  assert.equal(deal.freshnessEvidence.dateAdded.rawValue, '2026-09-22');
  assert.equal(deal.freshnessEvidence.dateAdded.precision, 'date');
  assert.equal(deal.freshnessEvidence.dateAdded.meaning, 'unknown');
  assert.equal(deal.freshnessEvidence.annualProfit.rawHeader, 'Annual Profit');
  assert.equal(deal.freshnessEvidence.annualProfit.metric, 'unknown');
  assert.equal(deal.freshnessEvidence.annualProfit.currency, 'unknown');
  assert.equal(deal.freshnessEvidence.annualProfit.period, 'unknown');
  assert.ok(JSON.stringify(deal.freshnessEvidence).length < 1500);
  const snapshot = buildOpportunitySourceObservationSnapshot({
    opportunityId: 'opp-provenance-1', deal, now: '2026-09-23T12:00:00.000Z',
  });
  assert.equal(snapshot.freshness_evidence.dateAdded.rawHeader, 'Posted Date');
  assert.equal(snapshot.freshness_evidence.annualProfit.metric, 'unknown');
});

test('separate identical Deal OS uploads each accept bounded row evidence while a same-run retry is idempotent', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-import-evidence-'));
  const sqlitePath = path.join(directory, 'imports.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const now = new Date();
  const input = {
    fileBuffer: Buffer.from([
      'Listing ID,Business Name,View Listing URL,Annual Profit,Asking Price,Posted Date',
      'FL01-1,Freshness Fixture,https://broker.example/fl01-1,450000,800000,2026-09-22',
    ].join('\n')),
    fileName: 'fl01.csv', mimeType: 'text/csv', exportedAt: now.toISOString(),
    scope: 'saved-search', coverageLabel: 'Synthetic freshness upload', expectedRowCount: 1,
    importedBy: 'synthetic-test', storage, now,
  };
  const first = await importDealOsExport(input);
  assert.equal(first.ok, true);
  const savedFirst = await storage.getDealHunterDealOsImport(first.import.id);
  assert.equal(savedFirst.freshness_generation, 1);
  assert.equal(savedFirst.freshness_projection_state, 'pending');
  assert.equal(savedFirst.records[0].freshnessEvidence.dateAdded.rawHeader, 'Posted Date');
  await storage.insertDealHunterDealOsImport(savedFirst);
  const second = await importDealOsExport(input);
  assert.equal(second.ok, true);
  assert.notEqual(first.import.id, second.import.id);
  const savedSecond = await storage.getDealHunterDealOsImport(second.import.id);
  assert.equal(savedSecond.freshness_generation, 2);
  const db = new Database(sqlitePath, { readonly: true });
  t.after(() => db.close());
  const events = db.prepare("SELECT * FROM deal_hunter_freshness_evidence WHERE source_id = 'deal-os-export' AND event_type = 'accepted_source_record' AND field_key = '' ORDER BY generation").all();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.run_id), [first.import.id, second.import.id]);
  assert.equal(events.every((event) => event.accepted_at && event.publication_meaning === 'unknown'), true);
  const failedRun = await storage.allocateDealHunterSourceGeneration({ sourceId: 'deal-os-export', runId: 'fl01-rollback' });
  await assert.rejects(storage.insertDealHunterDealOsImport({
    ...savedSecond, id: 'fl01-rollback', accepted_row_count: 2,
    freshnessRun: failedRun, acceptedRowEvidence: [
      { sourceRecordId: 'external:SAFE', eventOrdinal: 0, freshnessEvidence: null },
      { sourceRecordId: `external:${'X'.repeat(201)}`, eventOrdinal: 1, freshnessEvidence: null },
    ],
  }), /source-row identity is invalid/);
  assert.equal(await storage.getDealHunterDealOsImport('fl01-rollback'), null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_freshness_evidence WHERE run_id='fl01-rollback'").get().n, 0);
  assert.equal(db.prepare("SELECT accepted_generation FROM deal_hunter_source_freshness_state WHERE source_id='deal-os-export'").get().accepted_generation, 2);
});

test('newer Deal OS binding first recovers proven older discovery before showing the Inbox', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-bind-order-'));
  const sqlitePath = path.join(directory, 'bindings.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const opportunityId = 'bind-order-opportunity';
  const sourceRecordId = 'external:BIND-1';
  const listingUrl = 'https://broker.example/bind-1';
  const at = new Date().toISOString();
  await storage.upsertDealHunterOpportunity({ opportunity_id: opportunityId, created_at: at,
    updated_at: at, canonical_name: 'Bind order HVAC', identity_version: 'test', status: 'active', metadata: {} });
  await storage.markDealHunterOpportunityDiscoveryPending({ opportunityId, createdAt: at });
  const imports = [];
  for (const [index, price] of [100, 120].entries()) {
    const id = `bind-order-${index}`;
    const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'deal-os-export', runId: id });
    await storage.insertDealHunterDealOsImport({
      id, created_at: at, imported_by: 'synthetic-test', exported_at: at,
      file_name: 'bind.csv', file_type: 'text/csv', file_size: 100,
      file_sha256: String(index + 1).repeat(64), scope: 'saved-search', coverage_label: 'Synthetic',
      expected_row_count: 1, row_count: 1, source_row_count: 1, accepted_row_count: 1,
      rejected_row_count: 0, canonical_record_count: 1, parser_version: 'deal-os-export-v2',
      row_accounting: [{ sourceRowNumber: 2, status: 'accepted',
        listingIdentity: listingUrl }], duplicate_count: 0,
      stable_id_count: 1, listing_url_count: 1, coverage_limit_reached: false,
      records: [{ stableId: 'BIND-1', name: 'Bind order HVAC', listingUrl }], metadata: {},
      freshnessRun: run, acceptedRowEvidence: [{ sourceRecordId, eventOrdinal: 0,
        freshnessEvidence: { askingPrice: { rawHeader: 'Asking Price', rawValue: String(price),
          metric: 'asking_price', currency: 'USD', period: 'total' } } }],
    });
    imports.push({ id, run, price });
  }
  const db = new Database(sqlitePath);
  t.after(() => db.close());
  const olderDate = '2026-09-14T12:00:00.000Z';
  // Fixture chronology only: accepted_at is immutable in the real writer.
  db.exec('DROP TRIGGER deal_hunter_freshness_evidence_no_payload_update');
  db.prepare('UPDATE deal_hunter_freshness_evidence SET accepted_at = ? WHERE run_id = ?')
    .run(olderDate, imports[0].id);
  db.exec(`CREATE TRIGGER deal_hunter_freshness_evidence_no_payload_update
    BEFORE UPDATE OF id, source_id, source_name, source_record_id, run_id, generation,
      record_digest, event_type, field_key, event_ordinal, accepted_at, original_canonical_id,
      identity_exception_id, provenance_version, raw_header, raw_value, publication_meaning,
      publication_date, publication_instant, publication_precision, publication_offset,
      publication_state, before_value, after_value, before_evidence_id, after_evidence_id,
      metric, currency, period, classification, material_revision
    ON deal_hunter_freshness_evidence BEGIN
      SELECT RAISE(ABORT, 'freshness evidence payload is immutable');
    END`);
  const snapshot = (price) => ({ opportunity_id: opportunityId, source_id: 'deal-os-export',
    source_name: 'SMB Deal OS Export', source_record_id: sourceRecordId,
    observations: [{ id: 'bind-order-price', opportunity_id: opportunityId, source_id: 'deal-os-export',
      source_name: 'SMB Deal OS Export', source_record_id: sourceRecordId, field: 'asking_price',
      value: String(price), observed_at: at, created_at: at, updated_at: at }],
    freshness_evidence: { askingPrice: { rawHeader: 'Asking Price', rawValue: String(price),
      metric: 'asking_price', currency: 'USD', period: 'total' } } });
  await storage.bindAcceptedDealHunterFreshness({ importId: imports[1].id, opportunityId,
    sourceRecordId, expectedGeneration: imports[1].run.generation, snapshot: snapshot(120) });
  const intermediate = await storage.getDealHunterOpportunity(opportunityId);
  assert.equal(intermediate.first_accepted_at, olderDate);
  assert.equal(intermediate.discovery_state, 'known_recovered');
  await storage.writeDealHunterOpportunityScore({ opportunity_id: opportunityId, scored_at: at,
    deal_key: opportunityId, name: 'Bind order HVAC', fit_score: 86, confidence: 'high',
    score_fingerprint: 'bind-order', engine_version: 'test', rules_version: 'test',
    profile_version: 'test', completeness_policy_version: 'test' }, []);
  await storage.reconcileDealHunterCurrentScoreEligibility([opportunityId]);
  const reader = await storage.listDealHunterFreshInbox({ area: 'all-active', asOf: at });
  assert.equal(reader.areas[0].rows.find((row) => row.opportunity_id === opportunityId).new_to_ug, false);
  assert.equal((await storage.listDealHunterOpportunitySourceObservations(opportunityId))
    .find((row) => row.field === 'asking_price').value, '120');
  await Promise.all([0, 1].map(() => storage.bindAcceptedDealHunterFreshness({
    importId: imports[1].id, opportunityId, sourceRecordId,
    expectedGeneration: imports[1].run.generation, snapshot: snapshot(120),
  })));
  assert.equal((await storage.getDealHunterOpportunity(opportunityId)).discovery_revision, 1);
  await storage.bindAcceptedDealHunterFreshness({ importId: imports[0].id, opportunityId,
    sourceRecordId, expectedGeneration: imports[0].run.generation, snapshot: snapshot(100) });
  assert.equal((await storage.getDealHunterOpportunity(opportunityId)).first_accepted_at, olderDate);
  assert.equal((await storage.listDealHunterOpportunitySourceObservations(opportunityId))
    .find((row) => row.field === 'asking_price').value, '120');
  const ambiguousId = 'bind-order-ambiguous';
  const ambiguousRecordId = 'external:BIND-AMBIG';
  await storage.upsertDealHunterOpportunity({ opportunity_id: ambiguousId, created_at: at,
    updated_at: at, canonical_name: 'Ambiguous bind', identity_version: 'test', status: 'active', metadata: {} });
  await storage.markDealHunterOpportunityDiscoveryPending({ opportunityId: ambiguousId, createdAt: at });
  const ambiguousImports = [];
  for (const [index, url] of ['https://broker.example/ambiguous-a',
    'https://broker.example/ambiguous-b'].entries()) {
    const id = `ambiguous-bind-${index}`;
    const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'deal-os-export', runId: id });
    await storage.insertDealHunterDealOsImport({
      id, created_at: at, imported_by: 'synthetic-test', exported_at: at,
      file_name: 'bind.csv', file_type: 'text/csv', file_size: 100,
      file_sha256: String(index + 3).repeat(64), scope: 'saved-search', coverage_label: 'Synthetic',
      expected_row_count: 1, row_count: 1, source_row_count: 1, accepted_row_count: 1,
      rejected_row_count: 0, canonical_record_count: 1, parser_version: 'deal-os-export-v2',
      row_accounting: [{ sourceRowNumber: 2, status: 'accepted', listingIdentity: url }],
      duplicate_count: 0, stable_id_count: 1, listing_url_count: 1, coverage_limit_reached: false,
      records: [{ stableId: 'BIND-AMBIG', name: 'Ambiguous bind', listingUrl: url }], metadata: {},
      freshnessRun: run, acceptedRowEvidence: [{ sourceRecordId: ambiguousRecordId, eventOrdinal: 0,
        freshnessEvidence: null }],
    });
    ambiguousImports.push({ id, run });
  }
  db.exec('DROP TRIGGER deal_hunter_freshness_evidence_no_payload_update');
  db.prepare('UPDATE deal_hunter_freshness_evidence SET accepted_at = ? WHERE run_id = ?')
    .run(olderDate, ambiguousImports[0].id);
  db.exec(`CREATE TRIGGER deal_hunter_freshness_evidence_no_payload_update
    BEFORE UPDATE OF accepted_at ON deal_hunter_freshness_evidence BEGIN
      SELECT RAISE(ABORT, 'freshness evidence payload is immutable'); END`);
  const ambiguousSnapshot = { opportunity_id: ambiguousId, source_id: 'deal-os-export',
    source_name: 'SMB Deal OS Export', source_record_id: ambiguousRecordId,
    observations: [{ id: 'ambiguous-observation', opportunity_id: ambiguousId,
      source_id: 'deal-os-export', source_name: 'SMB Deal OS Export',
      source_record_id: ambiguousRecordId, field: 'name', value: 'Ambiguous bind',
      observed_at: at, created_at: at, updated_at: at }] };
  await storage.bindAcceptedDealHunterFreshness({ importId: ambiguousImports[1].id,
    opportunityId: ambiguousId, sourceRecordId: ambiguousRecordId,
    expectedGeneration: ambiguousImports[1].run.generation, snapshot: ambiguousSnapshot });
  const uncertain = await storage.getDealHunterOpportunity(ambiguousId);
  assert.equal(uncertain.discovery_state, 'pending');
  assert.equal(uncertain.first_accepted_at, null);
  assert.equal(db.prepare(`SELECT current_canonical_id FROM deal_hunter_freshness_evidence
    WHERE run_id = ? AND field_key = ''`).get(ambiguousImports[0].id).current_canonical_id, null);
});

test('accepted Deal OS price A to B to A to B retains three comparable transitions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-dos-material-'));
  const sqlitePath = path.join(directory, 'deal-os.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const at = '2026-09-23T12:00:00.000Z';
  const opportunityId = 'op-deal-os-price';
  const sourceRecordId = 'external:DOS-PRICE';
  await storage.upsertDealHunterOpportunity({ opportunity_id: opportunityId, created_at: at,
    updated_at: at, canonical_name: 'Synthetic Deal OS', identity_version: 'test', status: 'active', metadata: {} });
  await storage.markDealHunterOpportunityDiscoveryPending({ opportunityId, createdAt: at });
  for (const [index, price] of [100, 120, 100, 120].entries()) {
    const id = `dos-price-${index}`;
    const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'deal-os-export', runId: id });
    const claim = { rawHeader: 'Asking Price', rawValue: String(price), metric: 'asking_price',
      currency: 'USD', period: 'total' };
    const evidence = { askingPrice: claim };
    await storage.insertDealHunterDealOsImport({
      id, created_at: at, imported_by: 'synthetic-test', exported_at: at,
      file_name: 'price.csv', file_type: 'text/csv', file_size: 100,
      file_sha256: String(index + 1).repeat(64), scope: 'saved-search',
      coverage_label: 'Synthetic', expected_row_count: 1, row_count: 1, source_row_count: 1,
      accepted_row_count: 1, rejected_row_count: 0, canonical_record_count: 1,
      parser_version: 'deal-os-export-v2', row_accounting: [{ sourceRowNumber: 2, status: 'accepted' }],
      duplicate_count: 0, stable_id_count: 1, listing_url_count: 1,
      coverage_limit_reached: false, records: [{ stableId: 'DOS-PRICE', name: 'Synthetic' }],
      metadata: {}, freshnessRun: run,
      acceptedRowEvidence: [{ sourceRecordId, eventOrdinal: 0, freshnessEvidence: evidence }],
    });
    const bound = await storage.bindAcceptedDealHunterFreshness({
      importId: id, opportunityId, sourceRecordId, expectedGeneration: run.generation,
      snapshot: { opportunity_id: opportunityId, source_id: 'deal-os-export',
        source_name: 'SMB Deal OS Export', source_record_id: sourceRecordId,
        observations: [{ id: 'dos-price-observation', opportunity_id: opportunityId,
          source_id: 'deal-os-export', source_name: 'SMB Deal OS Export', source_record_id: sourceRecordId,
          field: 'asking_price', value: String(price), observed_at: at, created_at: at, updated_at: at }],
        freshness_evidence: evidence },
    });
    assert.equal(bound.projectionState, 'accepted');
  }
  const db = new Database(sqlitePath, { readonly: true });
  t.after(() => db.close());
  const events = db.prepare(`SELECT before_value, after_value, before_evidence_id, after_evidence_id,
    material_revision FROM deal_hunter_freshness_evidence WHERE event_type='material_change'
    AND source_id='deal-os-export' ORDER BY generation`).all();
  assert.deepEqual(events.map(({ before_value, after_value }) => [before_value, after_value]),
    [[100, 120], [120, 100], [100, 120]]);
  assert.deepEqual(events.map((event) => event.material_revision), [1, 2, 3]);
  assert.equal(events.every((event) => event.before_evidence_id && event.after_evidence_id), true);
  assert.equal((await storage.getDealHunterOpportunity(opportunityId)).material_revision, 3);
  await storage.writeDealHunterOpportunityScore({ opportunity_id: opportunityId, scored_at: at,
    deal_key: opportunityId, name: 'Synthetic Deal OS', fit_score: 86, confidence: 'high',
    score_fingerprint: 'dos-material-reader', engine_version: 'test', rules_version: 'test',
    profile_version: 'test', completeness_policy_version: 'test' }, []);
  await storage.reconcileDealHunterCurrentScoreEligibility([opportunityId]);
  const updated = await storage.listDealHunterFreshInbox({ area: 'updated', asOf: new Date().toISOString() });
  const row = updated.areas[0].rows.find((candidate) => candidate.opportunity_id === opportunityId);
  assert.deepEqual([row.material_before_value, row.material_after_value, row.material_field,
    row.material_currency], [100, 120, 'asking_price', 'USD']);
  assert.equal(row.latest_accepted_observation_at, db.prepare(`SELECT MAX(accepted_at) AS at
    FROM deal_hunter_opportunity_source_observations WHERE opportunity_id = ?`).get(opportunityId).at);
  assert.notEqual(row.latest_accepted_observation_at, at, 'accepted time must remain distinct from source observation time');
  const detail = await getTriageOpportunityDetail({ opportunityId, storage });
  assert.equal(detail.opportunity.freshness.latestAcceptedObservationAt, row.latest_accepted_observation_at);
  assert.deepEqual([detail.opportunity.freshness.materialChange.beforeValue,
    detail.opportunity.freshness.materialChange.afterValue], [100, 120]);
  assert.deepEqual(await storage.getLatestDealHunterMaterialChange({ opportunityId, materialRevision: 3 })
    .then((event) => [event.before_value, event.after_value, event.field_key]), [100, 120, 'asking_price']);
});

test('a complete admitted Sheet run creates one prospective discovery and a no-op run preserves its evidence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-sheet-evidence-'));
  const sqlitePath = path.join(directory, 'sheet.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const date = new Date().toISOString().slice(0, 10);
  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Posted Date,Annual Profit,Annual Revenue,Asking Price,Description',
    `FL01-SHEET-1,Synthetic Fresh Sheet,https://broker.example/fl01-sheet-1,CA,${date},450000,1200000,800000,Commercial HVAC maintenance company`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  const first = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'synthetic-test' });
  assert.equal(first.ok, true);
  const [opportunity] = await storage.listCurrentDealHunterOpportunities({ limit: 10 });
  assert.equal(opportunity.discovery_state, 'known_prospective');
  assert.equal(opportunity.discovery_revision, 1);
  assert.ok(opportunity.first_accepted_at);
  const firstEvidenceId = opportunity.first_discovery_evidence_id;
  const second = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'synthetic-test' });
  assert.equal(second.ok, true);
  const refreshed = await storage.getDealHunterOpportunity(opportunity.opportunity_id);
  assert.equal(refreshed.first_accepted_at, opportunity.first_accepted_at);
  assert.equal(refreshed.first_discovery_evidence_id, firstEvidenceId);
  assert.equal(refreshed.discovery_revision, 1);
  const db = new Database(sqlitePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_freshness_evidence WHERE source_id = 'sheet-0' AND event_type = 'accepted_source_record' AND field_key = ''").get().n, 1);
  assert.equal(db.prepare("SELECT accepted_generation FROM deal_hunter_source_freshness_state WHERE source_id = 'sheet-0'").get().accepted_generation, 2);
  const currentScore = await storage.getDealHunterOpportunityScore(opportunity.opportunity_id);
  const passed = await passTriageOpportunity({ opportunityId: opportunity.opportunity_id,
    reason: 'not-a-fit', expectedDiscoveryRevision: 1, expectedMaterialRevision: 0,
    storage, getCachedSourceHealth: null });
  assert.equal(passed.ok, true);
  const archived = await storage.listDealHunterFreshInbox({ area: 'new-important' });
  assert.equal(archived.areas[0].rows.some((row) => row.opportunity_id === opportunity.opportunity_id), false);
  const reimport = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'synthetic-test' });
  assert.equal(reimport.ok, true);
  const restored = await restoreDealHunterOpportunity({ dealKey: currentScore.deal_key,
    actor: 'synthetic-test', storage });
  assert.equal(restored.ok, true);
  const afterRestore = await storage.listDealHunterFreshInbox({ area: 'new-important' });
  assert.equal(afterRestore.areas[0].rows.some((row) => row.opportunity_id === opportunity.opportunity_id), false);
  assert.equal((await storage.getDealHunterOpportunity(opportunity.opportunity_id)).first_accepted_at,
    opportunity.first_accepted_at);
  const restoredScore = await storage.getDealHunterOpportunityScore(opportunity.opportunity_id);
  assert.deepEqual([restoredScore.reviewed_discovery_revision,
    restoredScore.reviewed_material_revision], [1, 0]);
});

test('daily-first Sheet discovery stays pending until complete acceptance and is never called newly accepted', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-daily-first-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'daily.sqlite') } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  sourceWorkbook = buildWorkbook([]);
  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Annual Profit,Description',
    'DAILY-NEW,Daily first HVAC,https://broker.example/daily-first,CA,450000,Commercial HVAC maintenance company',
  ].join('\n');
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'daily', actor: 'fl01-r1' })).ok, true);
  const [daily] = await storage.listCurrentDealHunterOpportunities({ limit: 10 });
  assert.equal(daily.discovery_state, 'pending');
  assert.equal(daily.first_accepted_at, null);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'fl01-r1' })).ok, true);
  const accepted = await storage.getDealHunterOpportunity(daily.opportunity_id);
  assert.equal(accepted.discovery_state, 'known_recovered');
  assert.ok(accepted.first_accepted_at);
});

test('real complete, daily changed, complete Sheet sequence detaches stale provenance and records the transition', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-mixed-sheet-'));
  const sqlitePath = path.join(directory, 'mixed.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  sourceWorkbook = buildWorkbook([]);
  const csv = (profit, posted) => [
    'Listing ID,Business Name,Listing URL,State,Posted Date,Annual Profit,Description',
    `MIXED-1,Mixed HVAC,https://broker.example/mixed-hvac,CA,${posted},${profit},Commercial HVAC maintenance company`,
  ].join('\n');
  sourceCsv = csv(450000, '2026-09-22');
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'fl01-r1' })).ok, true);
  const [opportunity] = await storage.listCurrentDealHunterOpportunities({ limit: 10 });
  const profit = async () => (await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id))
    .find((row) => row.source_id === 'sheet-0' && row.field === 'annual_profit');
  const first = await profit();
  assert.equal(first.value, '450000');
  assert.ok(first.accepted_evidence_id);
  sourceCsv = csv(475000, '2026-09-23');
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'daily', actor: 'fl01-r1' })).ok, true);
  const daily = await profit();
  assert.equal(daily.value, '475000');
  assert.equal(daily.accepted_evidence_id ?? null, null);
  assert.equal(daily.accepted_run_id ?? null, null);
  const dailyDate = (await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id))
    .find((row) => row.source_id === 'sheet-0' && row.field === 'date_added');
  assert.equal(dailyDate.accepted_evidence_id ?? null, null);
  assert.equal(dailyDate.publication_raw_header ?? null, null);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'fl01-r1' })).ok, true);
  const complete = await profit();
  assert.equal(complete.value, '475000');
  assert.ok(complete.accepted_evidence_id);
  const completeDate = (await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id))
    .find((row) => row.source_id === 'sheet-0' && row.field === 'date_added');
  assert.ok(completeDate.accepted_evidence_id);
  const db = new Database(sqlitePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_freshness_evidence WHERE source_id='sheet-0' AND field_key='annual_profit' AND event_type='evidence_state_change'").get().n, 1);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'daily', actor: 'fl01-r1' })).ok, true);
  assert.equal((await profit()).accepted_evidence_id, complete.accepted_evidence_id);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'fl01-r1' })).ok, true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM deal_hunter_freshness_evidence WHERE source_id='sheet-0' AND field_key='annual_profit' AND event_type='evidence_state_change'").get().n, 1);
});

test('a proven Sheet and Deal OS match binds accepted import evidence to one canonical opportunity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-cross-source-'));
  const sqlitePath = path.join(directory, 'sources.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const now = new Date();
  const url = 'https://broker.example/fl01-cross-source';
  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Annual Profit,Annual Revenue,Asking Price,Description',
    `SHEET-FL01,Cross Source HVAC,${url},CA,450000,1200000,800000,Commercial HVAC maintenance company`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from([
      'Listing ID,Business Name,View Listing URL,State,Annual Profit,Annual Revenue,Asking Price,Description',
      `DOS-FL01,Cross Source HVAC,${url},CA,450000,1200000,800000,Commercial HVAC maintenance company`,
    ].join('\n')),
    fileName: 'cross-source.csv', exportedAt: now.toISOString(), scope: 'saved-search',
    coverageLabel: 'Synthetic cross source', expectedRowCount: 1, importedBy: 'synthetic-test', storage, now,
  });
  assert.equal(imported.ok, true);
  const refreshed = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'synthetic-test' });
  assert.equal(refreshed.ok, true);
  const opportunities = await storage.listCurrentDealHunterOpportunities({ limit: 10 });
  assert.equal(opportunities.length, 1);
  const opportunity = opportunities[0];
  assert.equal(opportunity.discovery_state, 'known_prospective');
  const db = new Database(sqlitePath, { readonly: true });
  t.after(() => db.close());
  const importEvent = db.prepare("SELECT * FROM deal_hunter_freshness_evidence WHERE run_id = ? AND event_type = 'accepted_source_record' AND field_key = ''").get(imported.import.id);
  assert.equal(importEvent.current_canonical_id, opportunity.opportunity_id);
  const current = db.prepare("SELECT * FROM deal_hunter_opportunity_source_observations WHERE source_id = 'deal-os-export' AND opportunity_id = ? LIMIT 1").get(opportunity.opportunity_id);
  assert.equal(current.accepted_evidence_id, importEvent.id);
  assert.equal(current.accepted_run_id, imported.import.id);
  assert.equal((await storage.getDealHunterDealOsImport(imported.import.id)).freshness_projection_state, 'accepted');
});
let sourceCsv;
let sourceWorkbook;
let airtableFetchCount;
let sheetFetchStatus;
let dealOsImport;

function buildWorkbook(rows) {
  const worksheetRows = rows.map(({ name, row, url }) => [
    `<row r="${row}">`,
    `<c r="B${row}" t="inlineStr"><is><t>${name}</t></is></c>`,
    `<c r="U${row}"/>`,
    `<c r="V${row}" t="str"><f>HYPERLINK(&quot;${url}&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c>`,
    '</row>',
  ].join('')).join('');
  const worksheet = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    '<row r="1"><c r="B1" t="inlineStr"><is><t>Name</t></is></c><c r="V1" t="inlineStr"><is><t>View Listing</t></is></c></row>',
    worksheetRows,
    '</sheetData></worksheet>',
  ].join('');
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8(worksheet) });
}

function sourceStorage() {
  return {
    async getLatestDealHunterDealOsImport() {
      return dealOsImport;
    },
  };
}

function freshDealOsImport() {
  const now = new Date().toISOString();
  return {
    id: 'source-health-fresh-import',
    created_at: now,
    imported_by: 'admin',
    exported_at: now,
    file_name: 'fresh-deal-os.csv',
    file_type: 'text/csv',
    file_size: 100,
    file_sha256: 'a'.repeat(64),
    scope: 'saved-search',
    coverage_label: 'Source-health regression fixture',
    expected_row_count: 1,
    source_row_count: 1,
    accepted_row_count: 1,
    rejected_row_count: 0,
    canonical_record_count: 1,
    parser_version: 'deal-os-export-v2',
    row_accounting: [],
    row_count: 1,
    duplicate_count: 0,
    stable_id_count: 1,
    listing_url_count: 1,
    coverage_limit_reached: false,
    records: [{
      stableId: 'DEAL-OS-ONLY-1',
      name: 'Deal OS Must Stay Supplemental',
      listingUrl: 'https://broker.example/deal-os-only',
      annualProfit: 425000,
      state: 'CA',
      brokerContacts: [],
    }],
    metadata: {},
  };
}

function assertFailClosedReview(reviewed) {
  assert.deepEqual(reviewed.scoredDeals, []);
  assert.equal(reviewed.review.scoringDeferred, true);
  assert.deepEqual(reviewed.review.qualified, []);
  assert.deepEqual(reviewed.review.watchlist, []);
  assert.deepEqual(reviewed.review.removalCandidates, []);
  assert.deepEqual(reviewed.review.newlySeenMatches, []);
  assert.deepEqual(reviewed.review.criteriaRecommendations, []);
  assert.deepEqual(reviewed.review.crmSyncPreview, { count: 0, dealKeys: [] });
  assert.equal(reviewed.review.totals.cimReady, 0);
}

beforeEach(() => {
  sourceCsv = [
    'Name,View Listing',
    'Alpha HVAC,View Listing',
    'Beta Plumbing,View Listing',
  ].join('\n');
  sourceWorkbook = buildWorkbook([
    { row: 2, name: 'Alpha HVAC', url: 'https://broker.example/alpha' },
    { row: 3, name: 'Workbook Only', url: 'https://broker.example/workbook-only' },
    { row: 4, name: 'Beta Plumbing', url: 'https://broker.example/beta' },
  ]);
  airtableFetchCount = 0;
  sheetFetchStatus = 200;
  dealOsImport = null;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/gviz/tq')) return new Response(sourceCsv, { status: sheetFetchStatus });
    if (value.includes('/export?')) return new Response(sourceWorkbook, { status: 200 });
    if (value.includes('airtable.com')) {
      airtableFetchCount += 1;
      return Response.json({ records: [] });
    }
    return new Response('not found', { status: 404 });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

test('Google Sheet source health ignores workbook-only links when every imported row is linked', async () => {
  const review = await reviewDailyDeals({ storage: sourceStorage() });
  const source = review.sources.find((item) => item.id === 'sheet-0');

  assert.equal(source.rowCount, 2);
  assert.equal(source.listingUrlCount, 2);
  assert.equal(source.listingUrlExpectedCount, 2);
  assert.equal(source.listingUrlUnresolvedCount, 0);
  assert.equal(source.unmatchedWorkbookListingUrlCount, 1);
  assert.equal(source.listingUrlWarning, '');
});

test('legacy Airtable configuration cannot reactivate the retired source', async () => {
  const review = await reviewDailyDeals({ storage: sourceStorage() });

  assert.equal(airtableFetchCount, 0);
  assert.equal(review.sources.some((source) => /airtable/i.test(source.id || source.name)), false);
  assert.equal(review.disabledSources[0].sourceRole, 'retired');
  assert.equal(review.disabledSources[0].retired, true);
});

test('Google Sheet source health reports imported rows that genuinely lack a safe link', async () => {
  sourceCsv = `${sourceCsv}\nGamma Electric,View Listing`;
  const review = await reviewDailyDeals({ storage: sourceStorage() });
  const source = review.sources.find((item) => item.id === 'sheet-0');

  assert.equal(source.rowCount, 3);
  assert.equal(source.listingUrlCount, 2);
  assert.equal(source.listingUrlExpectedCount, 3);
  assert.equal(source.listingUrlUnresolvedCount, 1);
  assert.match(source.listingUrlWarning, /1 imported CSV row displays a View Listing label/);
});

test('an unexpected workbook link cannot mask a missing expected listing link', async () => {
  sourceCsv = [
    'Name,View Listing',
    'Alpha HVAC,View Listing',
    'Beta Plumbing,',
  ].join('\n');
  sourceWorkbook = buildWorkbook([
    { row: 2, name: 'Beta Plumbing', url: 'https://broker.example/beta' },
  ]);
  const review = await reviewDailyDeals({ storage: sourceStorage() });
  const source = review.sources.find((item) => item.id === 'sheet-0');

  assert.equal(source.listingUrlCount, 0);
  assert.equal(source.listingUrlExpectedCount, 1);
  assert.equal(source.listingUrlUnresolvedCount, 1);
  assert.match(source.listingUrlWarning, /1 imported CSV row displays a View Listing label/);
});

test('a failed required Sheet suppresses every scored output even when Deal OS is fresh', async () => {
  dealOsImport = freshDealOsImport();
  sheetFetchStatus = 503;

  const reviewed = await reviewDailyDeals({ storage: sourceStorage(), withScoredDeals: true });

  assert.equal(reviewed.review.sources.find((source) => source.id === 'deal-os-export').fetched, true);
  assert.equal(reviewed.review.sources.find((source) => source.id === 'sheet-0').fetched, false);
  assertFailClosedReview(reviewed);
  assert.equal(JSON.stringify(reviewed).includes('Deal OS Must Stay Supplemental'), false);
});

test('a header-only required Sheet suppresses every scored output even when Deal OS is fresh', async () => {
  dealOsImport = freshDealOsImport();
  sourceCsv = 'Name,View Listing';
  sourceWorkbook = buildWorkbook([]);

  const reviewed = await reviewDailyDeals({ storage: sourceStorage(), withScoredDeals: true });

  const sheet = reviewed.review.sources.find((source) => source.id === 'sheet-0');
  assert.equal(sheet.fetched, true);
  assert.equal(sheet.rowCount, 0);
  assertFailClosedReview(reviewed);
  assert.equal(JSON.stringify(reviewed).includes('Deal OS Must Stay Supplemental'), false);
});

test('canonical ingestion retains separate bounded Sheet and Deal OS observations, refreshes the Sheet record, and leaves operator facts untouched', async (t) => {
  // Break caught: canonical ingestion drops source-specific values, grows
  // duplicate observations across refreshes, or rewrites operator facts.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-observations-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const description = 'Commercial HVAC maintenance company with recurring service agreements, trained field technicians, and diversified B2B customers.';
  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Broker Name,Broker Email,Description,Unbounded Workbook Blob',
    `SHEET-42,Observation HVAC Services,https://broker.example/sheet-observation,CA,${new Date().toISOString().slice(0, 10)},450000,1200000,900000,Sheet Broker,sheet@example.test,${description},RAW_WORKBOOK_CONTENT_MUST_NOT_PERSIST`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  dealOsImport = {
    ...freshDealOsImport(),
    id: 'observation-deal-os-import',
    records: [{
      stableId: 'DEAL-OS-42',
      name: 'Observation HVAC Services',
      listingUrl: 'https://broker.example/sheet-observation',
      state: 'CA',
      annualProfit: 455000,
      annualRevenue: 1200000,
      askingPrice: 900000,
      brokerName: 'Deal OS Broker',
      brokerEmail: 'deal-os@example.test',
      description,
      brokerContacts: [],
    }],
  };
  await storage.insertDealHunterDealOsImport(dealOsImport);

  const first = await reviewDailyDeals({ storage, withScoredDeals: true });
  assert.equal(first.review.sources.find((source) => source.id === 'deal-os-export').fetched, true);
  assert.equal(first.scoredDeals.length, 1);
  assert.equal(Object.hasOwn(first.scoredDeals[0], 'sourceObservationDeals'), false);
  assert.deepEqual(new Set(first.scoredDeals[0].sourceRecords.map((record) => record.sourceId)), new Set(['sheet-0', 'deal-os-export']));
  const opportunityId = first.scoredDeals[0].opportunityId;
  assert.ok(opportunityId);
  await setOperatorOpportunityFact({
    opportunityId,
    field: 'seller_name',
    value: 'Operator-verified seller',
    actor: 'acquisition-admin',
    verified: true,
    storage,
  });
  const operatorFactsBeforeRefresh = await storage.listDealHunterOpportunityFacts(opportunityId);

  const firstObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const firstSheetProfit = firstObservations.find((observation) => (
    observation.source_id === 'sheet-0' && observation.field === 'annual_profit'
  ));
  assert.ok(firstSheetProfit);
  assert.doesNotMatch(JSON.stringify(firstObservations), /RAW_WORKBOOK_CONTENT_MUST_NOT_PERSIST/);
  assert.deepEqual(
    firstObservations
      .filter((observation) => observation.field === 'annual_profit')
      .map((observation) => [observation.source_id, observation.value])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ['deal-os-export', '455000'],
      ['sheet-0', '450000'],
    ],
  );

  sourceCsv = sourceCsv.replace(',450000,', ',475000,').replace(',sheet@example.test,', ',,');
  await reviewDailyDeals({ storage, withScoredDeals: true });

  const refreshedObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const refreshedSheetProfit = refreshedObservations.find((observation) => (
    observation.source_id === 'sheet-0' && observation.field === 'annual_profit'
  ));
  assert.equal(refreshedObservations.length, firstObservations.length - 1);
  assert.equal(refreshedSheetProfit.id, firstSheetProfit.id);
  assert.equal(refreshedSheetProfit.created_at, firstSheetProfit.created_at);
  assert.deepEqual(
    refreshedObservations
      .filter((observation) => observation.field === 'annual_profit')
      .map((observation) => [observation.source_id, observation.value])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ['deal-os-export', '455000'],
      ['sheet-0', '475000'],
    ],
  );
  assert.equal(refreshedObservations.some((observation) => (
    observation.source_id === 'sheet-0' && observation.field === 'broker_email'
  )), false);
  assert.deepEqual(await storage.listDealHunterOpportunityFacts(opportunityId), operatorFactsBeforeRefresh);
});

test('a literal Broker Phone Deal OS value survives import canonicalization with distinct generic contact provenance', async (t) => {
  // Break caught: the real Deal OS importer parses `Broker Phone`, but its
  // bounded canonical record drops that field before SQLite persistence and
  // later rehydrates only the generic `Broker Contact` value.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-deal-os-broker-phone-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const now = new Date();
  const observedDate = now.toISOString().slice(0, 10);
  const listingUrl = 'https://broker.example/listings/deal-os-literal-broker-phone';
  const description = 'Commercial HVAC maintenance company with recurring service agreements and trained field technicians.';
  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `SHEET-DEAL-OS-BROKER-PHONE,Deal OS Literal Broker Phone Services,${listingUrl},NY,${observedDate},450000,1200000,900000,${description}`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from([
      'Listing ID,Business Name,View Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Broker Contact,Broker Phone,Description',
      `DEAL-OS-BROKER-PHONE,Deal OS Literal Broker Phone Services,${listingUrl},NY,${observedDate},450000,1200000,900000,broker@example.test,+1 315 555 1212,${description}`,
    ].join('\n')),
    fileName: 'deal-os-broker-phone.csv',
    mimeType: 'text/csv',
    exportedAt: now.toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Explicit Deal OS broker phone regression',
    expectedRowCount: 1,
    importedBy: 'acquisition-admin@example.test',
    storage,
    now,
  });
  assert.equal(imported.ok, true);

  const refreshed = await refreshOpportunityScores({
    storage,
    reviewMode: 'full-backfill',
    actor: 'deal-os-broker-phone-source-test',
  });
  assert.equal(refreshed.ok, true);
  const [opportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((item) => item.metadata?.identitySnapshot?.listingUrl === listingUrl);
  assert.ok(opportunity, 'the matched Sheet and Deal OS records resolve to one canonical opportunity');
  const opportunityId = opportunity.opportunity_id;

  const storedImport = await storage.getLatestDealHunterDealOsImport();
  const storedRecord = storedImport.records[0];
  const sourceRows = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const detail = await getTriageOpportunityDetail({ opportunityId, storage });
  assert.equal(detail.ok, true);
  const sourceGroup = detail.sourceObservations.find((source) => (
    source.sourceId === 'deal-os-export'
    && source.sourceRecordId === 'external:DEAL-OS-BROKER-PHONE'
  ));

  assert.deepEqual({
    storedBrokerContact: storedRecord.brokerContact,
    storedBrokerPhone: storedRecord.brokerPhone,
    storedBrokerPhoneOwnProperty: Object.hasOwn(storedRecord, 'brokerPhone'),
    durableBrokerRows: sourceRows
      .filter((row) => row.source_id === 'deal-os-export' && row.field.startsWith('broker_'))
      .map((row) => ({ field: row.field, value: row.value, sourceName: row.source_name, sourceRecordId: row.source_record_id }))
      .sort((left, right) => left.field.localeCompare(right.field)),
    sourceBrokerContact: sourceGroup?.values.broker_contact,
    sourceBrokerPhone: sourceGroup?.values.broker_phone,
    effectiveBrokerPhone: detail.effectiveFacts.broker_phone,
    brokerPhoneMissing: detail.missingCriticalFields.includes('broker_phone'),
  }, {
    storedBrokerContact: 'broker@example.test',
    storedBrokerPhone: '+1 315 555 1212',
    storedBrokerPhoneOwnProperty: true,
    durableBrokerRows: [
      {
        field: 'broker_contact',
        value: 'broker@example.test',
        sourceName: 'SMB Deal OS export',
        sourceRecordId: 'external:DEAL-OS-BROKER-PHONE',
      },
      {
        field: 'broker_phone',
        value: '+1 315 555 1212',
        sourceName: 'SMB Deal OS export',
        sourceRecordId: 'external:DEAL-OS-BROKER-PHONE',
      },
    ],
    sourceBrokerContact: 'broker@example.test',
    sourceBrokerPhone: '+1 315 555 1212',
    effectiveBrokerPhone: {
      value: '+1 315 555 1212',
      provenance: 'structured-source',
      verified: false,
      actor: null,
      note: null,
    },
    brokerPhoneMissing: false,
  });
});

test('a literal Broker Phone Sheet value retains phone identity and provenance through persisted detail', async (t) => {
  // Break caught: the real Sheet `Broker Phone` column is normalized as a
  // generic broker contact, so a durable current source record exists but the
  // consolidated detail reports broker_phone as missing.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-broker-phone-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const observedDate = new Date().toISOString().slice(0, 10);
  const listingUrl = 'https://broker.example/listings/literal-broker-phone';
  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Broker Phone,Description',
    `SHEET-BROKER-PHONE,Literal Broker Phone Services,${listingUrl},CA,${observedDate},450000,1200000,900000,555-1212,Commercial HVAC maintenance company with recurring service agreements and trained field technicians.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);

  const refreshed = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'broker-phone-source-test' });
  assert.equal(refreshed.ok, true);
  const [opportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((item) => item.metadata?.identitySnapshot?.listingUrl === listingUrl);
  assert.ok(opportunity, 'the real Sheet row resolves to a current canonical opportunity');

  const sourceRows = await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id);
  assert.equal(
    sourceRows.some((row) => row.source_id === 'sheet-0' && row.source_name === 'SMB Deal Hunter Google Sheet' && row.source_record_id === 'external:SHEET-BROKER-PHONE'),
    true,
    'the current Sheet source record is durably attributable before its contact fact is composed',
  );

  const sourceDetail = await getTriageOpportunityDetail({ opportunityId: opportunity.opportunity_id, storage });
  await setOperatorOpportunityFact({
    opportunityId: opportunity.opportunity_id,
    field: 'broker_phone',
    value: '310-555-0199',
    verified: true,
    actor: 'acquisition-admin',
    storage,
  });
  const operatorDetail = await getTriageOpportunityDetail({ opportunityId: opportunity.opportunity_id, storage });
  const sourceGroup = sourceDetail.sourceObservations.find((source) => source.sourceId === 'sheet-0');

  assert.deepEqual({
    brokerRows: sourceRows
      .filter((row) => row.source_id === 'sheet-0' && row.field.startsWith('broker_'))
      .map((row) => ({ field: row.field, value: row.value, sourceId: row.source_id, sourceName: row.source_name, sourceRecordId: row.source_record_id })),
    sourcePhone: sourceGroup?.values.broker_phone,
    effectiveSourcePhone: sourceDetail.effectiveFacts.broker_phone,
    sourceClaimsPhoneMissing: sourceDetail.missingCriticalFields.includes('broker_phone'),
    effectiveOperatorPhone: operatorDetail.effectiveFacts.broker_phone,
  }, {
    brokerRows: [{
      field: 'broker_phone', value: '555-1212', sourceId: 'sheet-0', sourceName: 'SMB Deal Hunter Google Sheet', sourceRecordId: 'external:SHEET-BROKER-PHONE',
    }],
    sourcePhone: '555-1212',
    effectiveSourcePhone: {
      value: '555-1212', provenance: 'structured-source', verified: false, actor: null, note: null,
    },
    sourceClaimsPhoneMissing: false,
    effectiveOperatorPhone: {
      value: '310-555-0199', provenance: 'operator', verified: true, actor: 'acquisition-admin', note: null,
    },
  });
});

test('a Sheet with distinct Broker Contact and Broker Phone values retains both truthful source fields', () => {
  // Break caught: recognizing an explicit phone silently removes a separate
  // generic source contact, making the retained provenance claim incomplete.
  const [deal] = parseSheetCsvDeals([
    'Listing ID,Business Name,Listing URL,State,Broker Contact,Broker Phone',
    'SHEET-BOTH-CONTACTS,Separate Contact Fields Co,https://broker.example/listings/separate-contact-fields,CA,broker@example.test,555-1212',
  ].join('\n')).deals;
  const snapshot = buildOpportunitySourceObservationSnapshot({
    opportunityId: 'opp-separate-broker-contact-fields',
    deal,
    now: '2026-08-31T00:00:00.000Z',
  });

  assert.deepEqual(
    snapshot.observations
      .filter((observation) => observation.field.startsWith('broker_'))
      .map(({ field, value }) => ({ field, value }))
      .sort((left, right) => left.field.localeCompare(right.field)),
    [
      { field: 'broker_contact', value: 'broker@example.test' },
      { field: 'broker_phone', value: '555-1212' },
    ],
  );
});

test('a no-explicit-ID Sheet row keeps one source observation snapshot when its listing URL is corrected', async (t) => {
  // Break caught: the supported positional Sheet record shape uses a mutable
  // listing URL as its observation identity and forks observations after the
  // existing canonical resolver has identified the same opportunity.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-sheet-url-correction-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const firstCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Broker Name,Broker Email,Description',
    `No-ID URL Correction HVAC,https://broker.example/no-id-original,CA,${new Date().toISOString().slice(0, 10)},450000,1200000,900000,Sheet Broker,sheet@example.test,Commercial HVAC maintenance company`,
  ].join('\n');
  const correctedCsv = firstCsv.replace('https://broker.example/no-id-original', 'https://broker.example/no-id-corrected');
  const [firstDeal] = parseSheetCsvDeals(firstCsv).deals;
  const [correctedDeal] = parseSheetCsvDeals(correctedCsv).deals;
  const opportunityId = 'opp-no-id-sheet-url-correction';
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: '2026-08-30T12:00:00.000Z',
    updated_at: '2026-08-30T12:00:00.000Z',
    canonical_name: 'No-ID URL Correction HVAC',
    canonical_recipient: null,
    canonical_location: 'CA',
    primary_submission_id: null,
    identity_version: 'test',
    status: 'active',
    metadata: {},
  });
  await storage.replaceDealHunterOpportunitySourceObservationSnapshot(
    buildOpportunitySourceObservationSnapshot({ opportunityId, deal: firstDeal, now: '2026-08-30T12:30:00.000Z' }),
  );
  const firstObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const firstListing = firstObservations.find((observation) => observation.field === 'listing_url');
  assert.equal(firstListing.source_record_id, 'sheet-row:1');

  await storage.replaceDealHunterOpportunitySourceObservationSnapshot(
    buildOpportunitySourceObservationSnapshot({ opportunityId, deal: correctedDeal, now: '2026-08-30T13:30:00.000Z' }),
  );
  const refreshedObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const refreshedListing = refreshedObservations.find((observation) => observation.field === 'listing_url');
  assert.equal(refreshedListing.source_record_id, 'sheet-row:1');
  assert.equal(refreshedListing.id, firstListing.id);
  assert.equal(refreshedListing.value, 'https://broker.example/no-id-corrected');
  assert.equal(refreshedObservations.length, firstObservations.length);
});

test('a complete Sheet refresh removes the stale positional observation when a listing moves to a new row', async (t) => {
  // Break caught: a complete Sheet refresh treats a position-derived source
  // record as independently current after the same listing moves rows, so the
  // old value remains authoritative and conflicts with the refreshed value.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-sheet-row-movement-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const observedDate = new Date().toISOString().slice(0, 10);
  const moverListingUrl = 'https://broker.example/listings/moving-hvac';
  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Moving HVAC Services,${moverListingUrl},CA,${observedDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  dealOsImport = {
    ...freshDealOsImport(),
    id: 'row-movement-deal-os-import',
    records: [{
      stableId: 'DEAL-OS-MOVING-HVAC',
      name: 'Moving HVAC Services',
      listingUrl: moverListingUrl,
      state: 'CA',
      annualProfit: 455000,
      annualRevenue: 1200000,
      askingPrice: 900000,
      description: 'Commercial HVAC maintenance with recurring service agreements.',
      brokerContacts: [],
    }],
  };
  await storage.insertDealHunterDealOsImport(dealOsImport);

  const firstRefresh = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'sheet-row-movement-test' });
  assert.equal(firstRefresh.ok, true);
  const [firstOpportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((opportunity) => opportunity.metadata?.identitySnapshot?.listingUrl === moverListingUrl);
  assert.ok(firstOpportunity, 'the first full refresh resolves a canonical opportunity by listing identity');
  const opportunityId = firstOpportunity.opportunity_id;
  const aliases = await storage.listDealHunterOpportunityAliases({ opportunityIds: [opportunityId], limit: 20 });
  assert.equal(
    aliases.some((alias) => alias.alias_type === 'listing-url' && alias.alias_value === moverListingUrl),
    true,
    'the reproduction is anchored by the durable listing identity, not business name or location matching',
  );
  const firstObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  assert.deepEqual(
    firstObservations.filter((observation) => observation.source_id === 'sheet-0' && observation.field === 'annual_profit')
      .map((observation) => [observation.source_record_id, observation.value]),
    [['sheet-row:1', '450000']],
  );

  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Inserted Roofing,https://broker.example/listings/inserted-roofing,TX,${observedDate},300000,1000000,700000,Commercial roofing repair company with contracted work.`,
    `Moving HVAC Services,${moverListingUrl},CA,${observedDate},475000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  const secondRefresh = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'sheet-row-movement-test' });
  assert.equal(secondRefresh.ok, true);

  const [refreshedOpportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((opportunity) => opportunity.metadata?.identitySnapshot?.listingUrl === moverListingUrl);
  assert.equal(refreshedOpportunity.opportunity_id, opportunityId, 'the listing remains the same canonical opportunity after row movement');
  const refreshedObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  assert.deepEqual(
    refreshedObservations.filter((observation) => observation.source_id === 'sheet-0' && observation.field === 'annual_profit')
      .map((observation) => [observation.source_record_id, observation.value]),
    [['sheet-row:2', '475000']],
    'only the moved Sheet row contributes the refreshed profit',
  );
  assert.equal(refreshedObservations.length, firstObservations.length, 'the complete refresh does not grow durable current observations');
  assert.equal(
    refreshedObservations.some((observation) => observation.source_id === 'deal-os-export' && observation.field === 'annual_profit' && observation.value === '455000'),
    true,
    'the unrelated Deal OS observation remains current',
  );

  const detail = await getTriageOpportunityDetail({ opportunityId, storage });
  assert.equal(detail.ok, true);
  const sheetGroups = detail.sourceObservations.filter((source) => source.sourceId === 'sheet-0');
  assert.equal(sheetGroups.length, 1, 'only one current Sheet source record remains in the authoritative detail projection');
  assert.equal(sheetGroups[0].sourceRecordId, 'sheet-row:2');
  const profitConflict = sheetGroups[0].conflicts.find((conflict) => conflict.field === 'annual_profit');
  assert.ok(profitConflict, 'the current Sheet and Deal OS values remain visibly attributable as a real cross-source conflict');
  assert.equal(
    profitConflict.observations.some((observation) => observation.value === '450000'),
    false,
    'the stale pre-move Sheet value no longer participates in current conflict authority',
  );
});

test('a complete Sheet refresh removes observations for a business absent from the authoritative source while preserving Deal OS', async (t) => {
  // Break caught: reconciling only canonical opportunities still represented
  // by the new Sheet leaves a fully removed business's old Sheet source rows
  // current forever. A proven complete source snapshot must remove every stale
  // `(opportunity, source-record, field)` triple for that source ID.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-sheet-removed-business-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const currentDate = new Date().toISOString().slice(0, 10);
  const retainedListingUrl = 'https://broker.example/listings/retained-hvac';
  const removedListingUrl = 'https://broker.example/listings/removed-plumbing';
  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Retained HVAC Services,${retainedListingUrl},CA,${currentDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
    `Removed Plumbing Services,${removedListingUrl},TX,${currentDate},500000,1500000,1000000,Commercial plumbing maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  dealOsImport = {
    ...freshDealOsImport(),
    id: 'removed-sheet-business-deal-os-import',
    records: [{
      stableId: 'DEAL-OS-REMOVED-PLUMBING',
      name: 'Removed Plumbing Services',
      listingUrl: removedListingUrl,
      state: 'TX',
      annualProfit: 505000,
      annualRevenue: 1500000,
      askingPrice: 1000000,
      description: 'Commercial plumbing maintenance with recurring service agreements.',
      brokerContacts: [],
    }],
  };
  await storage.insertDealHunterDealOsImport(dealOsImport);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'removed-sheet-business-test' })).ok, true);

  const [removedOpportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((opportunity) => opportunity.metadata?.identitySnapshot?.listingUrl === removedListingUrl);
  assert.ok(removedOpportunity, 'the first complete source run resolves the later-removed business by durable listing identity');
  const before = await storage.listDealHunterOpportunitySourceObservations(removedOpportunity.opportunity_id);
  assert.equal(before.some((observation) => observation.source_id === 'sheet-0'), true);
  assert.equal(before.some((observation) => observation.source_id === 'deal-os-export' && observation.value === '505000'), true);

  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Retained HVAC Services,${retainedListingUrl},CA,${currentDate},475000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  const refreshed = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'removed-sheet-business-test' });
  assert.equal(refreshed.ok, true);

  const after = await storage.listDealHunterOpportunitySourceObservations(removedOpportunity.opportunity_id);
  assert.equal(
    after.some((observation) => observation.source_id === 'sheet-0'),
    false,
    'the complete current Sheet snapshot removes source evidence for an absent business',
  );
  assert.equal(
    after.some((observation) => observation.source_id === 'deal-os-export' && observation.value === '505000'),
    true,
    'the source-wide deletion boundary excludes the unrelated Deal OS source ID',
  );
});

test('an incremental Sheet review preserves observations outside its partial candidate set', async (t) => {
  // Break caught: source-wide reconciliation runs for a partial/incremental
  // review and deletes a valid Sheet observation the run did not represent.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-incremental-sheet-observations-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const currentDate = new Date().toISOString().slice(0, 10);
  const olderListingUrl = 'https://broker.example/listings/older-preserved';
  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Fresh HVAC Services,https://broker.example/listings/fresh-hvac,CA,${currentDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
    `Older Plumbing Services,${olderListingUrl},CA,2020-01-01,500000,1500000,1000000,Commercial plumbing maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'partial-sheet-test' })).ok, true);
  const [olderOpportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((opportunity) => opportunity.metadata?.identitySnapshot?.listingUrl === olderListingUrl);
  assert.ok(olderOpportunity);
  const before = await storage.listDealHunterOpportunitySourceObservations(olderOpportunity.opportunity_id);
  assert.ok(before.length > 0);

  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Fresh HVAC Services,https://broker.example/listings/fresh-hvac,CA,${currentDate},475000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  const incremental = await refreshOpportunityScores({ storage, reviewMode: 'daily', actor: 'partial-sheet-test' });
  assert.equal(incremental.ok, true);
  assert.deepEqual(
    await storage.listDealHunterOpportunitySourceObservations(olderOpportunity.opportunity_id),
    before,
    'a non-complete review does not erase the valid older Sheet source record it did not carry',
  );
});

test('a full Sheet refresh with an unresolved row leaves its prior Sheet observation snapshot intact', async (t) => {
  // Break caught: a source-wide delete proceeds when one authoritative Sheet
  // row lacks durable identity evidence, discarding valid prior observations;
  // record-by-record writes would also leave a hybrid snapshot behind.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-partial-identity-sheet-observations-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const currentDate = new Date().toISOString().slice(0, 10);
  const moverListingUrl = 'https://broker.example/listings/identity-gated-hvac';
  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Identity Gated HVAC,${moverListingUrl},CA,${currentDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'partial-identity-test' })).ok, true);
  const [moverOpportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((opportunity) => opportunity.metadata?.identitySnapshot?.listingUrl === moverListingUrl);
  assert.ok(moverOpportunity);
  const before = await storage.listDealHunterOpportunitySourceObservations(moverOpportunity.opportunity_id);

  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Identity Missing Listing,,TX,${currentDate},300000,1000000,700000,Short description.`,
    `Identity Gated HVAC,${moverListingUrl},CA,${currentDate},475000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  const partialIdentity = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'partial-identity-test' });
  assert.equal(partialIdentity.ok, false);
  assert.equal(partialIdentity.status, 409);
  assert.deepEqual(
    await storage.listDealHunterOpportunitySourceObservations(moverOpportunity.opportunity_id),
    before,
    'an unresolved authoritative Sheet row prevents both stale deletion and a hybrid replacement for that source',
  );
});

test('a complete Sheet payload with duplicate stable source-record identities fails closed before any Sheet observation write', async (t) => {
  // Break caught: duplicate stable Listing IDs make the raw source identity
  // set ambiguous. A full backfill must defer/fail rather than write one row
  // while deleting or updating the last-known-good snapshot for another.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-duplicate-stable-sheet-observations-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const currentDate = new Date().toISOString().slice(0, 10);
  const listingUrl = 'https://broker.example/listings/duplicate-stable-sheet-hvac';
  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `SHEET-STABLE-42,Duplicate Stable HVAC,${listingUrl},CA,${currentDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  const initial = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'duplicate-stable-sheet-test' });
  assert.equal(initial.ok, true);
  const [opportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((item) => item.metadata?.identitySnapshot?.listingUrl === listingUrl);
  assert.ok(opportunity);
  const before = await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id);
  assert.ok(before.some((observation) => observation.source_id === 'sheet-0'));

  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `SHEET-STABLE-42,Duplicate Stable HVAC,${listingUrl},CA,${currentDate},475000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
    `SHEET-STABLE-42,Duplicate Stable Plumbing,https://broker.example/listings/duplicate-stable-sheet-plumbing,TX,${currentDate},500000,1500000,1000000,Commercial plumbing maintenance with recurring service agreements.`,
  ].join('\n');
  const duplicate = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'duplicate-stable-sheet-test' });

  assert.equal(duplicate.ok, false, 'a successfully fetched but duplicate-identity Sheet cannot authorize a complete snapshot');
  assert.equal(duplicate.status, 503, 'the admission proof fails closed before a full-backfill score write');
  assert.equal(duplicate.scoringDeferred, true);
  assert.deepEqual(duplicate.review.sourceSnapshotAdmissionDeferredSources, ['sheet-0']);
  assert.equal(
    duplicate.review.sources.find((source) => source.id === 'sheet-0')?.fetched,
    true,
    'the rejection is an identity/admission failure, not a source collection failure',
  );
  assert.deepEqual(
    await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id),
    before,
    'the last-known-good Sheet observations remain byte-for-byte unchanged with no partial source write',
  );
});

test('a failed complete Sheet collection leaves current source observations untouched', async (t) => {
  // Break caught: a failed collection is interpreted as an empty complete
  // source snapshot and deletes the last known-good source observations.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-failed-sheet-observations-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const currentDate = new Date().toISOString().slice(0, 10);
  const listingUrl = 'https://broker.example/listings/failed-collection-hvac';
  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Failed Collection HVAC,${listingUrl},CA,${currentDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'failed-sheet-test' })).ok, true);
  const [opportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((item) => item.metadata?.identitySnapshot?.listingUrl === listingUrl);
  const before = await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id);

  sheetFetchStatus = 503;
  const failed = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'failed-sheet-test' });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 503);
  assert.deepEqual(await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id), before);
});

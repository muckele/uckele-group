import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://example.test/required-sheet.csv';
process.env.DEAL_HUNTER_DEAL_OS_EXPORT_MAX_AGE_HOURS = '72';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url) === process.env.DEAL_HUNTER_SHEET_CSV_URL) {
    return new Response('Name\nHealthy Required Sheet Control', { status: 200 });
  }
  return originalFetch(url, options);
};
after(() => {
  globalThis.fetch = originalFetch;
});

const {
  auditDealHunterCrmIntegrity,
  executeDealOsCrmReconciliation,
  importDealOsExport,
  previewDealOsCrmReconciliation,
} = await import('../server/services/dealHunter.js');
const { createManualSubmission } = await import('../server/services/submissions.js');
const { createSqliteStorage } = await import('../server/storage/sqlite.js');

function reconciliationCsv() {
  return [
    'Listing ID,Business Name,State,Earnings,Revenue,Asking Price,Years Established,Industry,Description,View Listing URL',
    'DOS-REC-1,Commercial HVAC Maintenance Co,CA,$450000,$1800000,$1400000,12,Commercial HVAC,"Recurring maintenance contracts service agreements scheduled maintenance field technicians compliance repair management in place SBA eligible seller financing",https://dealos.example/listing/DOS-REC-1',
    'DOS-REC-1,Commercial HVAC Maintenance Co,CA,$450000,$1800000,$1400000,12,Commercial HVAC,,https://dealos.example/listing/DOS-REC-1',
    'DOS-REC-2,General Local Services Co,NJ,$320000,$900000,$950000,,Misc,,https://dealos.example/listing/DOS-REC-2',
  ].join('\n');
}

function singleListingCsv() {
  return reconciliationCsv().split('\n').slice(0, 2).join('\n');
}

test('exact-import reconciliation remains blocked when the selected Deal OS import is stale', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-stale-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const historicNow = new Date(Date.now() - 80 * 60 * 60 * 1000);
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(singleListingCsv()),
    fileName: 'deal-os-stale-selected-import.csv',
    exportedAt: new Date(historicNow.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Stale selected reconciliation fixture',
    expectedRowCount: 1,
    importedBy: 'admin@example.com',
    storage,
    now: historicNow,
  });
  assert.equal(imported.ok, true);

  const preview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });

  assert.equal(preview.ok, false);
  assert.equal(preview.status, 503);
  assert.match(preview.error, /reconciliation preview is blocked/i);
  assert.match(preview.review.sources.find((source) => source.id === 'deal-os-export').error, /freshness limit/i);
});

test('exact-import reconciliation accounts for every row, creates one CRM owner per opportunity, and is idempotent', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(reconciliationCsv()),
    fileName: 'deal-os-reconciliation.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Exact reconciliation test set',
    expectedRowCount: 3,
    importedBy: 'admin@example.com',
    storage,
    now,
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.import.sourceRowCount, 3);
  assert.equal(imported.import.acceptedRowCount, 3);
  assert.equal(imported.import.canonicalRecordCount, 2);
  assert.equal(imported.import.duplicateCount, 1);

  const preview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(preview.ok, true, JSON.stringify({ error: preview.error, sources: preview.review?.sources }, null, 2));
  assert.equal(preview.counts.acceptedRows, 3);
  assert.equal(preview.counts.mappedSourceRows, 3);
  assert.equal(preview.counts.unmappedSourceRows, 0);
  assert.equal(preview.counts.canonicalImportRecords, 2);
  assert.equal(preview.counts.create, 2);
  assert.equal(preview.expectedOpportunityIds.length, 2);

  const executed = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: preview.generatedAt,
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(executed.ok, true, JSON.stringify({ resultCounts: executed.resultCounts, run: executed.run }, null, 2));
  assert.equal(executed.resultCounts.created, 2);
  const submissions = await storage.listSubmissions({ status: 'all', page: 1, limit: 100 });
  assert.equal(submissions.rows.length, 2);
  assert.equal(new Set(submissions.rows.map((row) => row.deal_hunter_opportunity_id)).size, 2);
  const sourced = submissions.rows.find((row) => row.status === 'sourced');
  const actionable = submissions.rows.find((row) => row.status === 'review');
  assert.ok(sourced);
  assert.ok(actionable);
  assert.equal(sourced.follow_up_state, 'completed');
  assert.equal(sourced.next_action_at, null);
  assert.equal(sourced.tags.includes('high-fit'), false);
  assert.equal(actionable.tags.includes('high-fit'), true);

  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'opportunity-regression-cross-link',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    canonical_name: 'Cross-link regression fixture',
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: null,
    identity_version: 'test-v1',
    status: 'active',
    metadata: {},
  });
  await assert.rejects(
    storage.linkDealHunterCrmSubmission({
      opportunityId: 'opportunity-regression-cross-link',
      submissionId: submissions.rows[0].id,
    }),
    /already belongs to another canonical opportunity/i,
  );

  const repeated = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: preview.generatedAt,
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
  assert.equal((await storage.listSubmissions({ status: 'all', page: 1, limit: 100 })).rows.length, 2);

  const audit = await auditDealHunterCrmIntegrity({ storage });
  assert.equal(audit.ok, true);
  assert.equal(audit.counts.duplicatePrimaries, 0);
  assert.equal(audit.counts.identityMismatches, 0);
  assert.equal(audit.counts.ownershipCollisions, 0);

  const firstSubmission = submissions.rows[0];
  await storage.updateSubmission(firstSubmission.id, {
    metadata: {
      ...firstSubmission.metadata,
      dealHunter: {
        ...firstSubmission.metadata.dealHunter,
        opportunityId: 'opportunity-regression-wrong-metadata-owner',
      },
    },
  });
  const mismatchedAudit = await auditDealHunterCrmIntegrity({ storage });
  assert.equal(mismatchedAudit.ok, false);
  assert.equal(mismatchedAudit.safeToReconcile, false);
  assert.equal(mismatchedAudit.counts.identityMismatches, 1);
});

test('exact-import reconciliation preserves crm-deleted tombstones', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-tombstone-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(singleListingCsv()),
    fileName: 'deal-os-reconciliation-tombstone.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Exact reconciliation tombstone test',
    expectedRowCount: 1,
    importedBy: 'admin@example.com',
    storage,
    now,
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.import.acceptedRowCount, 1);
  assert.equal(imported.import.canonicalRecordCount, 1);

  const initialPreview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(initialPreview.ok, true);
  assert.equal(initialPreview.items.length, 1);
  assert.equal(initialPreview.counts.unmappedSourceRows, 0);
  assert.equal(initialPreview.counts.ambiguous, 0);
  const exactItem = initialPreview.items[0];
  assert.ok(exactItem.opportunityId);
  assert.ok(exactItem.dealKey);
  assert.deepEqual(initialPreview.expectedOpportunityIds, [exactItem.opportunityId]);
  assert.equal(exactItem.action, 'create');

  const tombstonedAt = new Date().toISOString();
  const claim = await storage.claimDealHunterCrmImport({
    id: 'crm-deleted-dos-rec-1',
    created_at: tombstonedAt,
    updated_at: tombstonedAt,
    opportunity_id: exactItem.opportunityId,
    deal_key: exactItem.dealKey,
    listing_identity: 'dealos.example/listing/dos-rec-1',
    listing_url: 'https://dealos.example/listing/DOS-REC-1',
    submission_id: null,
    status: 'crm-deleted',
    source_name: 'Deal OS tombstone acceptance fixture',
    metadata: {
      acceptanceFixture: 'exact-import-crm-deleted-non-recreation',
      opportunityId: exactItem.opportunityId,
    },
  }, { pendingCutoff: tombstonedAt });
  assert.equal(claim.claimed, true);
  assert.equal(claim.importRecord.opportunity_id, exactItem.opportunityId);
  assert.equal(claim.importRecord.status, 'crm-deleted');
  assert.equal(claim.importRecord.submission_id, null);

  const storedTombstone = await storage.getDealHunterCrmImport({ opportunityId: exactItem.opportunityId });
  assert.equal(storedTombstone.id, claim.importRecord.id);
  assert.equal(storedTombstone.opportunity_id, exactItem.opportunityId);
  assert.equal(storedTombstone.deal_key, exactItem.dealKey);
  assert.equal(storedTombstone.status, 'crm-deleted');
  assert.equal(storedTombstone.submission_id, null);
  const residue = await createManualSubmission({
    company: exactItem.name,
    seller_name: 'Historical Seller',
    seller_email: 'tombstone-residue@example.test',
    listing_url: 'https://dealos.example/listing/DOS-REC-1',
    asking_price: '$1,400,000',
    ttm_revenue: '$1,800,000',
    ttm_ebitda: '$450,000',
    status: 'review',
    metadata: {},
  }, 'tombstone-residue-fixture', { storage });
  assert.equal(residue.ok, true);
  const residueBefore = structuredClone(await storage.getSubmission(residue.submission.id));
  assert.equal((await storage.listSubmissions({ status: 'all', page: 1, limit: 100 })).rows.length, 1);
  const opportunityBefore = await storage.getCurrentDealHunterOpportunity(exactItem.opportunityId);
  assert.ok(opportunityBefore);
  assert.equal(opportunityBefore.primary_submission_id, null);

  const tombstonePreview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(tombstonePreview.ok, true);
  assert.equal(tombstonePreview.items.length, 1);
  assert.deepEqual(tombstonePreview.expectedOpportunityIds, [exactItem.opportunityId]);
  assert.equal(tombstonePreview.items[0].opportunityId, exactItem.opportunityId);
  assert.equal(tombstonePreview.items[0].dealKey, exactItem.dealKey);
  assert.equal(tombstonePreview.items[0].action, 'tombstoned');
  assert.equal(tombstonePreview.items.some((item) => item.action === 'create'), false);
  assert.equal(tombstonePreview.items.some((item) => item.action === 'update'), false);
  assert.equal(tombstonePreview.counts.tombstoned, 1);
  assert.equal(tombstonePreview.counts.create, 0);
  assert.equal(tombstonePreview.counts.update, 0);
  assert.equal(tombstonePreview.counts.mutable, 0);
  assert.equal(tombstonePreview.counts.ambiguous, 0);
  assert.equal(tombstonePreview.counts.unmappedSourceRows, 0);
  assert.equal(tombstonePreview.confirmationRequired, 'RECONCILE 0 CANONICAL');

  const executed = await executeDealOsCrmReconciliation({
    importId: tombstonePreview.import.id,
    planDigest: tombstonePreview.planDigest,
    previewGeneratedAt: tombstonePreview.generatedAt,
    expectedOpportunityIds: tombstonePreview.expectedOpportunityIds,
    confirmation: tombstonePreview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(executed.ok, true);
  assert.equal(executed.status, 200);
  assert.equal(executed.run.status, 'completed');
  assert.equal(executed.resultCounts.tombstoned, 1);
  assert.equal(executed.resultCounts.created, 0);
  assert.equal(executed.resultCounts.updated, 0);
  assert.equal(executed.resultCounts.enriched, 0);
  assert.equal(executed.resultCounts.failed, 0);
  const durableItems = await storage.listDealHunterCrmReconciliationItems(executed.run.id, { limit: 100 });
  assert.equal(durableItems.length, 1);
  assert.equal(durableItems[0].opportunity_id, exactItem.opportunityId);
  assert.equal(durableItems[0].action, 'tombstoned');
  assert.equal(durableItems[0].status, 'tombstoned');
  assert.equal(durableItems[0].submission_id, null);

  assert.deepEqual(await storage.getSubmission(residue.submission.id), residueBefore);
  const tombstoneAfterExecution = await storage.getDealHunterCrmImport({ opportunityId: exactItem.opportunityId });
  assert.equal(tombstoneAfterExecution.id, storedTombstone.id);
  assert.equal(tombstoneAfterExecution.opportunity_id, exactItem.opportunityId);
  assert.equal(tombstoneAfterExecution.deal_key, exactItem.dealKey);
  assert.equal(tombstoneAfterExecution.status, 'crm-deleted');
  assert.equal(tombstoneAfterExecution.submission_id, null);
  assert.equal((await storage.getCurrentDealHunterOpportunity(exactItem.opportunityId)).primary_submission_id, null);

  const repeatPreview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(repeatPreview.ok, true);
  assert.equal(repeatPreview.items.length, 1);
  assert.equal(repeatPreview.items[0].opportunityId, exactItem.opportunityId);
  assert.equal(repeatPreview.items[0].action, 'tombstoned');
  assert.equal(repeatPreview.counts.tombstoned, 1);
  assert.equal(repeatPreview.counts.create, 0);
  assert.equal(repeatPreview.counts.update, 0);
  assert.equal(repeatPreview.counts.mutable, 0);

  const repeated = await executeDealOsCrmReconciliation({
    importId: repeatPreview.import.id,
    planDigest: repeatPreview.planDigest,
    previewGeneratedAt: repeatPreview.generatedAt,
    expectedOpportunityIds: repeatPreview.expectedOpportunityIds,
    confirmation: repeatPreview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.run.status, 'completed');
  assert.equal(repeated.run.counts.results.tombstoned, 1);
  assert.deepEqual(await storage.getSubmission(residue.submission.id), residueBefore);
  const tombstoneAfterRepeat = await storage.getDealHunterCrmImport({ opportunityId: exactItem.opportunityId });
  assert.equal(tombstoneAfterRepeat.id, storedTombstone.id);
  assert.equal(tombstoneAfterRepeat.status, 'crm-deleted');
  assert.equal(tombstoneAfterRepeat.submission_id, null);
  assert.equal((await storage.getCurrentDealHunterOpportunity(exactItem.opportunityId)).primary_submission_id, null);
});

test('exact-import reconciliation creates no outbound communication side effects', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-no-outbound-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const syntheticSheetFetch = globalThis.fetch;
  const unexpectedNetworkUrls = [];
  let syntheticSheetFetchCount = 0;
  globalThis.fetch = async (url, options) => {
    const requestedUrl = String(url);
    if (requestedUrl === process.env.DEAL_HUNTER_SHEET_CSV_URL) {
      syntheticSheetFetchCount += 1;
      return syntheticSheetFetch(url, options);
    }
    unexpectedNetworkUrls.push(requestedUrl);
    throw new Error(`Unexpected application network request: ${requestedUrl}`);
  };
  t.after(() => {
    globalThis.fetch = syntheticSheetFetch;
  });

  const readOutboundEvidence = async () => {
    const [
      outboundCommunications,
      emailOutbox,
      emailEvents,
      cimRequests,
      stage2Activations,
      stage2Runs,
      stage2Decisions,
      scheduledJobs,
    ] = await Promise.all([
      storage.countCrmCommunications({ direction: 'outbound' }),
      storage.listCrmEmailOutbox({ limit: 100 }),
      storage.listEmailEvents({ limit: 500 }),
      storage.listDealHunterCimRequests({ limit: 100000 }),
      storage.listCimStage2Activations({ limit: 500 }),
      storage.listCimStage2Runs({ limit: 500 }),
      storage.listCimStage2Decisions({ limit: 500 }),
      storage.listScheduledJobs({ limit: 500 }),
    ]);
    return {
      outboundCommunications,
      emailOutbox: emailOutbox.length,
      emailEvents: emailEvents.length,
      cimRequests: cimRequests.length,
      stage2Activations: stage2Activations.length,
      stage2Runs: stage2Runs.length,
      stage2Decisions: stage2Decisions.length,
      dailyDigestJobs: scheduledJobs.filter((job) => (
        job.job_name === 'daily-deal-hunter-email'
        || String(job.job_key || '').startsWith('daily-deal-hunter-email:')
      )).length,
    };
  };
  const zeroOutboundEvidence = {
    outboundCommunications: 0,
    emailOutbox: 0,
    emailEvents: 0,
    cimRequests: 0,
    stage2Activations: 0,
    stage2Runs: 0,
    stage2Decisions: 0,
    dailyDigestJobs: 0,
  };
  assert.deepEqual(await readOutboundEvidence(), zeroOutboundEvidence);

  const now = new Date();
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(singleListingCsv()),
    fileName: 'deal-os-reconciliation-no-outbound.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Exact reconciliation zero-outbound test',
    expectedRowCount: 1,
    importedBy: 'admin@example.com',
    storage,
    now,
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.import.acceptedRowCount, 1);
  assert.equal(imported.import.canonicalRecordCount, 1);

  const preview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(preview.ok, true, JSON.stringify({ error: preview.error, sources: preview.review?.sources }, null, 2));
  assert.equal(preview.items.length, 1);
  const item = preview.items[0];
  assert.ok(item.opportunityId);
  assert.equal(item.action, 'create');
  assert.equal(item.actionable, true);
  assert.equal(preview.counts.create, 1);
  assert.equal(preview.counts.mutable, 1);
  assert.equal(preview.counts.ambiguous, 0);
  assert.equal(preview.counts.unmappedSourceRows, 0);
  assert.deepEqual(preview.expectedOpportunityIds, [item.opportunityId]);
  assert.ok(preview.confirmationRequired);

  const preExecutionOutboundEvidence = await readOutboundEvidence();
  assert.deepEqual(preExecutionOutboundEvidence, zeroOutboundEvidence);
  assert.equal(await storage.getDealHunterCimOpportunityClaim(item.opportunityId), null);
  assert.deepEqual(unexpectedNetworkUrls, []);
  assert.ok(syntheticSheetFetchCount >= 1);

  const executed = await executeDealOsCrmReconciliation({
    importId: preview.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: preview.generatedAt,
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(executed.ok, true, JSON.stringify({ resultCounts: executed.resultCounts, run: executed.run }, null, 2));
  assert.equal(executed.status, 200);
  assert.equal(executed.run.status, 'completed');
  assert.equal(executed.resultCounts.created, 1);
  assert.equal(executed.resultCounts.failed, 0);

  const durableItems = await storage.listDealHunterCrmReconciliationItems(executed.run.id, { limit: 100 });
  assert.equal(durableItems.length, 1);
  assert.equal(durableItems[0].opportunity_id, item.opportunityId);
  assert.equal(durableItems[0].action, 'create');
  assert.equal(durableItems[0].status, 'created');
  assert.ok(durableItems[0].submission_id);

  const submissions = await storage.listSubmissions({ status: 'all', page: 1, limit: 100 });
  assert.equal(submissions.rows.length, 1);
  const submission = submissions.rows.find((row) => row.deal_hunter_opportunity_id === item.opportunityId);
  assert.ok(submission);
  assert.equal(submission.status, 'review');
  assert.equal(submission.tags.includes('high-fit'), true);
  assert.equal(submission.delivery_provider, 'manual-entry');
  assert.equal(submission.delivery_status, 'not-applicable');
  assert.equal(submission.crm_status, 'manual-entry');

  const postExecutionOutboundEvidence = await readOutboundEvidence();
  assert.deepEqual(postExecutionOutboundEvidence, preExecutionOutboundEvidence);
  assert.deepEqual(postExecutionOutboundEvidence, zeroOutboundEvidence);
  assert.equal(await storage.getDealHunterCimOpportunityClaim(item.opportunityId), null);
  assert.deepEqual(unexpectedNetworkUrls, []);
  assert.ok(syntheticSheetFetchCount >= 1);
});

test('a re-run over unchanged listings plans no writes and keeps operator workflow', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-unchanged-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(reconciliationCsv()),
    fileName: 'deal-os-reconciliation.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Unchanged re-run test',
    expectedRowCount: 3,
    importedBy: 'admin@example.com',
    storage,
    now,
  });
  const preview = await previewDealOsCrmReconciliation({ importId: imported.import.id, requestedBy: 'admin@example.com', storage });
  const executed = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: preview.generatedAt,
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(executed.ok, true);

  // Observation bookkeeping moves on its own between review runs and must not
  // be mistaken for a listing change that needs another CRM write.
  const repeatPreview = await previewDealOsCrmReconciliation({ importId: imported.import.id, requestedBy: 'admin@example.com', storage });
  assert.equal(
    repeatPreview.counts.unchanged,
    2,
    JSON.stringify({ counts: repeatPreview.counts, items: repeatPreview.items }, null, 2),
  );
  assert.equal(repeatPreview.counts.update, 0);
  assert.equal(repeatPreview.counts.mutable, 0);
  assert.deepEqual(repeatPreview.items.map((item) => item.changedFields), [[], []]);

  const created = (await storage.listSubmissions({ status: 'all', page: 1, limit: 100 })).rows;
  const actionable = created.find((row) => row.status === 'review');
  const scheduledNextAction = actionable.next_action_at;
  assert.ok(scheduledNextAction, 'an actionable Deal Hunter record is created with a scheduled next action');
  await storage.updateSubmission(actionable.id, {
    status: 'contacted',
    tags: [...actionable.tags, 'operator-priority'],
    updated_at: new Date().toISOString(),
  });

  // A later export of the same listings must report the refreshed listing facts
  // without reverting the status, follow-up date, or tags an operator set.
  const reimported = await importDealOsExport({
    fileBuffer: Buffer.from(reconciliationCsv()),
    fileName: 'deal-os-reconciliation-later.csv',
    exportedAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Unchanged re-run test',
    expectedRowCount: 3,
    importedBy: 'admin@example.com',
    storage,
    now: new Date(now.getTime() + 1000),
  });
  const laterPreview = await previewDealOsCrmReconciliation({ importId: reimported.import.id, requestedBy: 'admin@example.com', storage });
  const laterExecuted = await executeDealOsCrmReconciliation({
    importId: reimported.import.id,
    planDigest: laterPreview.planDigest,
    previewGeneratedAt: laterPreview.generatedAt,
    expectedOpportunityIds: laterPreview.expectedOpportunityIds,
    confirmation: laterPreview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(laterExecuted.ok, true);
  const refreshed = await storage.getSubmission(actionable.id);
  assert.equal(refreshed.status, 'contacted');
  assert.equal(refreshed.next_action_at, scheduledNextAction);
  assert.equal(refreshed.tags.includes('operator-priority'), true);
});

test('a run that ended with failures resumes and retries the failed item', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-retry-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  // A single listing keeps the refreshed plan identical after the failure, which
  // is the case where the run's own idempotency key would otherwise lock the
  // failed item out of every later attempt.
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(singleListingCsv()),
    fileName: 'deal-os-reconciliation-single.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Retry test',
    expectedRowCount: 1,
    importedBy: 'admin@example.com',
    storage,
    now,
  });
  const preview = await previewDealOsCrmReconciliation({ importId: imported.import.id, requestedBy: 'admin@example.com', storage });

  const realClaim = storage.claimDealHunterCrmImport.bind(storage);
  let injectedFailures = 0;
  storage.claimDealHunterCrmImport = async (...args) => {
    if (injectedFailures === 0) {
      injectedFailures += 1;
      throw new Error('injected transient ownership claim failure');
    }
    return realClaim(...args);
  };
  const partial = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: preview.generatedAt,
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.status, 207);
  assert.equal(partial.resultCounts.failed, 1);
  assert.equal(partial.run.status, 'completed-with-errors');

  storage.claimDealHunterCrmImport = realClaim;
  const resumed = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: new Date().toISOString(),
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.resultCounts.failed, 0);
  assert.equal(resumed.resultCounts.created, 1);
  assert.equal((await storage.listSubmissions({ status: 'all', page: 1, limit: 100 })).rows.length, 1);

  const completed = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: new Date().toISOString(),
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(completed.idempotent, true);
  assert.equal((await storage.listSubmissions({ status: 'all', page: 1, limit: 100 })).rows.length, 1);
});

test('reconciliation marks its durable import claim failed when CRM ambiguity appears after claiming', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-post-claim-race-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(singleListingCsv()),
    fileName: 'deal-os-reconciliation-post-claim-race.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Post-claim ambiguity bookkeeping fixture',
    expectedRowCount: 1,
    importedBy: 'admin@example.com',
    storage,
    now,
  });
  const preview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  const [deal] = [...preview.dealsByOpportunity.values()];
  const realClaim = storage.claimDealHunterCrmImport.bind(storage);
  storage.claimDealHunterCrmImport = async (...args) => {
    const claim = await realClaim(...args);
    for (const suffix of ['a', 'b']) {
      const created = await createManualSubmission({
        company: deal.name,
        seller_name: 'Race Fixture',
        seller_email: `reconciliation-race-${suffix}@example.test`,
        listing_url: deal.listingUrl,
        asking_price: `$${Number(deal.askingPrice).toLocaleString('en-US')}`,
        ttm_revenue: `$${Number(deal.annualRevenue).toLocaleString('en-US')}`,
        ttm_ebitda: `$${Number(deal.annualProfit).toLocaleString('en-US')}`,
        status: 'review',
        metadata: {},
      }, 'post-claim-race-fixture', { storage });
      assert.equal(created.ok, true);
    }
    return claim;
  };

  const executed = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: preview.generatedAt,
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });

  assert.equal(executed.ok, false);
  assert.equal(executed.status, 207);
  assert.equal(executed.resultCounts.failed, 1);
  assert.equal(executed.resultCounts.created, 0);
  const [importRecord] = await storage.listDealHunterCrmImports({ limit: 100 });
  assert.equal(importRecord.status, 'failed');
  assert.match(importRecord.metadata.error, /multiple CRM records/i);
  const [item] = await storage.listDealHunterCrmReconciliationItems(executed.run.id, { limit: 100 });
  assert.equal(item.status, 'failed');
  assert.match(item.error, /multiple CRM records/i);
});

test('reconciliation refuses a malformed durable CRM ownership claim result', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-invalid-claim-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(singleListingCsv()),
    fileName: 'deal-os-reconciliation-invalid-claim.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'Malformed claim fixture',
    expectedRowCount: 1,
    importedBy: 'admin@example.com',
    storage,
    now,
  });
  const preview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  storage.claimDealHunterCrmImport = async (record) => ({ importRecord: record });

  const executed = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: preview.generatedAt,
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });

  assert.equal(executed.ok, false);
  assert.equal(executed.status, 207);
  assert.equal(executed.resultCounts.failed, 1);
  assert.equal(executed.resultCounts.created, 0);
  assert.equal((await storage.listSubmissions({ status: 'all', page: 1, limit: 100 })).rows.length, 0);
  assert.equal((await storage.listDealHunterCrmImports({ limit: 100 })).length, 0);
  const [item] = await storage.listDealHunterCrmReconciliationItems(executed.run.id, { limit: 100 });
  assert.match(item.error, /durable CRM ownership claim returned an invalid result/i);
});

test('Deal OS preview exposes CRM ambiguity and execution blocks before claims or run bookkeeping', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-ambiguity-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(singleListingCsv()),
    fileName: 'deal-os-reconciliation-ambiguity.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'CRM ambiguity guard integration fixture',
    expectedRowCount: 1,
    importedBy: 'admin@example.com',
    storage,
    now,
  });
  const initial = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(initial.ok, true);
  assert.equal(initial.items.length, 1);
  const [deal] = [...initial.dealsByOpportunity.values()];
  assert.ok(deal?.opportunityId);

  const legacyIds = [];
  for (const [label, updatedAt] of [
    ['legacy-preview-a', '2026-08-01T00:00:00.000Z'],
    ['legacy-preview-b', '2026-09-01T00:00:00.000Z'],
  ]) {
    const created = await createManualSubmission({
      company: deal.name,
      seller_name: 'Synthetic Seller',
      seller_email: `${label}@example.test`,
      asking_price: `$${Number(deal.askingPrice).toLocaleString('en-US')}`,
      ttm_revenue: `$${Number(deal.annualRevenue).toLocaleString('en-US')}`,
      ttm_ebitda: `$${Number(deal.annualProfit).toLocaleString('en-US')}`,
      status: 'review',
      metadata: { dealHunter: { raw: { State: deal.state } } },
    }, 'ambiguity-fixture', { storage });
    assert.equal(created.ok, true);
    legacyIds.push(created.submission.id);
    await storage.updateSubmission(created.submission.id, { updated_at: updatedAt });
  }

  const submissionsBefore = await storage.listSubmissions({ status: 'all', page: 1, limit: 100 });
  const importsBefore = await storage.listDealHunterCrmImports({ limit: 100 });
  const preview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.counts.ambiguous, 1);
  assert.equal(preview.counts.mutable, 0);
  assert.equal(preview.items[0].action, 'ambiguous');
  assert.equal(preview.items[0].blocker.code, 'CRM_MATCH_AMBIGUOUS');
  assert.equal(preview.items[0].submissionId, '');
  assert.deepEqual(preview.items[0].blocker.candidateIds, legacyIds.sort());
  assert.equal((await storage.listSubmissions({ status: 'all', page: 1, limit: 100 })).rows.length, submissionsBefore.rows.length);
  assert.equal((await storage.listDealHunterCrmImports({ limit: 100 })).length, importsBefore.length);

  const executed = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: preview.generatedAt,
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });

  assert.equal(executed.ok, false);
  assert.equal(executed.status, 409);
  assert.match(executed.error, /ambiguous/i);
  assert.equal((await storage.listDealHunterCrmImports({ limit: 100 })).length, importsBefore.length);
  assert.equal(await storage.getDealHunterCrmReconciliationRun({
    idempotencyKey: `deal-os-crm-reconciliation:${preview.import.id}:${preview.planDigest}`,
  }), null);
  assert.equal((await storage.listSubmissions({ status: 'all', page: 1, limit: 100 })).rows.length, submissionsBefore.rows.length);
  assert.equal((await storage.listDealHunterCimRequests({ limit: 100 })).length, 0);
  assert.equal((await storage.listCrmEmailOutbox({ limit: 100 })).length, 0);
  assert.equal((await storage.listEmailEvents({ limit: 100 })).length, 0);
});

test('Deal OS preview exposes CRM lookup failure as an explicit blocker instead of absence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-lookup-failure-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(singleListingCsv()),
    fileName: 'deal-os-reconciliation-lookup-failure.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'CRM lookup failure integration fixture',
    expectedRowCount: 1,
    importedBy: 'admin@example.com',
    storage,
    now,
  });
  const listSubmissions = storage.listSubmissions.bind(storage);
  const readDealHunterCrmMatchAuthority = storage.readDealHunterCrmMatchAuthority.bind(storage);
  const getDealHunterCrmImport = storage.getDealHunterCrmImport.bind(storage);
  storage.readDealHunterCrmMatchAuthority = async () => {
    throw new Error('synthetic CRM candidate lookup outage');
  };

  const preview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });

  assert.equal(preview.ok, false);
  assert.equal(preview.status, 503);
  assert.equal(preview.code, 'CRM_MATCH_LOOKUP_FAILED');
  assert.deepEqual(preview.candidateIds, []);
  assert.deepEqual(preview.evidenceCategories, ['lookup-failure']);
  assert.equal(await storage.getDealHunterCrmReconciliationRun({
    idempotencyKey: `deal-os-crm-reconciliation:${imported.import.id}:not-created`,
  }), null);
  assert.equal((await storage.listDealHunterCrmImports({ limit: 100 })).length, 0);
  assert.equal((await listSubmissions({ status: 'all', page: 1, limit: 100 })).rows.length, 0);
  assert.equal((await storage.listDealHunterCimRequests({ limit: 100 })).length, 0);
  assert.equal((await storage.listCrmEmailOutbox({ limit: 100 })).length, 0);

  storage.readDealHunterCrmMatchAuthority = readDealHunterCrmMatchAuthority;
  storage.getDealHunterCrmImport = async () => {
    throw new Error('synthetic durable import authority outage');
  };
  const importAuthorityFailure = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(importAuthorityFailure.ok, false);
  assert.equal(importAuthorityFailure.status, 503);
  assert.equal(importAuthorityFailure.code, 'CRM_MATCH_LOOKUP_FAILED');
  assert.deepEqual(importAuthorityFailure.evidenceCategories, ['import-authority-lookup-failure']);

  storage.getDealHunterCrmImport = undefined;
  const missingImportAuthority = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(missingImportAuthority.ok, false);
  assert.equal(missingImportAuthority.status, 503);
  assert.equal(missingImportAuthority.code, 'CRM_MATCH_LOOKUP_INCOMPLETE');
  assert.deepEqual(missingImportAuthority.evidenceCategories, ['import-authority-lookup-incomplete']);
  storage.getDealHunterCrmImport = getDealHunterCrmImport;
});

test('reconciliation execution rejects stale plan inputs before claiming CRM ownership', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-reconciliation-stale-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'crm.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(reconciliationCsv()),
    fileName: 'deal-os-reconciliation.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'deal-radar',
    coverageLabel: 'Stale plan test',
    expectedRowCount: 3,
    importedBy: 'admin@example.com',
    storage,
    now,
  });
  const preview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'admin@example.com',
    storage,
  });
  const expired = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.status, 409);
  assert.match(expired.error, /preview.*expired/i);
  const rejected = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: 'stale-plan-digest',
    previewGeneratedAt: preview.generatedAt,
    expectedOpportunityIds: ['stale-opportunity'],
    confirmation: 'RECONCILE 2 CANONICAL',
    requestedBy: 'admin@example.com',
    storage,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 409);
  assert.match(rejected.error, /plan changed/i);
  assert.equal((await storage.listSubmissions({ status: 'all', page: 1, limit: 100 })).rows.length, 0);
  assert.equal((await storage.listDealHunterCrmImports({ limit: 100 })).length, 0);
});

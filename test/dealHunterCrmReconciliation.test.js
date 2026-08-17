import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
process.env.DEAL_HUNTER_DEAL_OS_EXPORT_MAX_AGE_HOURS = '72';

const {
  auditDealHunterCrmIntegrity,
  executeDealOsCrmReconciliation,
  importDealOsExport,
  previewDealOsCrmReconciliation,
} = await import('../server/services/dealHunter.js');
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
  assert.equal(preview.ok, true);
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
  assert.equal(repeatPreview.counts.unchanged, 2);
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

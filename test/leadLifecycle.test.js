import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';

process.env.DEAL_HUNTER_SHEET_CSV_URLS = 'https://example.test/archive-review.csv';
process.env.DEAL_HUNTER_AIRTABLE_TOKEN = 'test-token';
process.env.DEAL_HUNTER_AIRTABLE_BASE_ID = 'appTest';
process.env.DEAL_HUNTER_AIRTABLE_TABLE_ID = 'tblTest';
process.env.DEAL_HUNTER_AIRTABLE_SHARED_VIEW_URL = '';
process.env.DEAL_HUNTER_LOOKBACK_DAYS = '30';

const today = new Date().toISOString().slice(0, 10);
const sourceCsv = [
  'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Broker Name,Broker Email,Listing URL,Description',
  `"Archive Test Services","Commercial maintenance","CA","${today}","$425,000","$1,600,000","$1,200,000","Pat Broker","pat@example.com","https://broker.example.test/archive-test","Recurring commercial maintenance contracts, compliance, repair, field technicians, management in place, SBA eligible."`,
].join('\n');
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://example.test/archive-review.csv') {
      return new Response(sourceCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
    }
    if (String(url).includes('api.airtable.com')) return Response.json({ records: [] });
    return new Response('not found', { status: 404 });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

function testStorage(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-lead-lifecycle-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return storage;
}

async function createLead(storage, company = 'Lifecycle Services') {
  const { createManualSubmission } = await import('../server/services/submissions.js');
  const result = await createManualSubmission({
    company,
    lead_type: 'broker',
    broker_name: 'Jordan Broker',
    broker_email: 'jordan@example.com',
    listing_url: `https://broker.example.test/${company.toLowerCase().replace(/\s+/g, '-')}`,
    status: 'review',
    follow_up_state: 'scheduled',
    next_action_at: new Date(Date.now() + 86_400_000).toISOString(),
    notes: 'Lifecycle test lead.',
  }, 'lifecycle-admin', { storage });
  assert.equal(result.ok, true);
  return result.submission;
}

test('archive is explicit, audited, searchable, and stops linked CIM outreach; restore does not restart it', async (t) => {
  const storage = testStorage(t);
  const { archiveLead, restoreLead } = await import('../server/services/leadLifecycle.js');
  const { updateSubmissionWorkflow } = await import('../server/services/submissions.js');
  const lead = await createLead(storage);
  const firstRequestedAt = '2026-08-01T10:00:00.000Z';
  await storage.upsertDealHunterCimRequest({
    id: 'archive-linked-request',
    created_at: firstRequestedAt,
    updated_at: firstRequestedAt,
    submission_id: lead.id,
    deal_key: 'archive-deal-key',
    recipient_email: 'jordan@example.com',
    requested_by: 'lifecycle-admin',
    status: 'sent',
    delivery_error: '',
    provider_message_id: 'archive-provider-message',
    subject: 'CIM / NDA request for Lifecycle Services',
    deal_name: 'Lifecycle Services',
    source_name: 'test',
    listing_url: lead.listing_url,
    score: 85,
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'scheduled',
    first_requested_at: firstRequestedAt,
    next_follow_up_at: new Date(Date.now() + 86_400_000).toISOString(),
    follow_up_count: 0,
    last_follow_up_at: null,
    responded_at: null,
    metadata: {},
  });

  const genericArchive = await updateSubmissionWorkflow(lead.id, {
    expected_updated_at: lead.updated_at,
    status: 'archived',
  }, { actor: 'lifecycle-admin', role: 'admin', storage });
  assert.equal(genericArchive, null, 'generic status update must not bypass archive disposition rules');

  const archived = await archiveLead({
    submissionId: lead.id,
    reason: 'unavailable',
    note: 'Broker confirmed the seller accepted another offer.',
    actor: 'lifecycle-admin',
    storage,
  });
  assert.equal(archived.ok, true);
  assert.equal(archived.submission.status, 'archived');
  assert.equal(archived.submission.archive_reason, 'unavailable');
  assert.equal(archived.submission.follow_up_state, 'completed');
  assert.equal(archived.submission.next_action_at, null);
  assert.ok(archived.submission.archived_at);

  const linkedRequest = await storage.getDealHunterCimRequestById('archive-linked-request');
  assert.equal(linkedRequest.request_state, 'stopped');
  assert.equal(linkedRequest.follow_up_state, 'stopped');
  assert.equal(linkedRequest.next_follow_up_at, null);
  assert.equal(linkedRequest.first_requested_at, firstRequestedAt);

  const searchable = await storage.listSubmissions({ search: 'Lifecycle Services', status: 'all', page: 1, limit: 25 });
  assert.equal(searchable.total, 1);
  assert.equal(searchable.rows[0].status, 'archived');
  const archiveActivity = await storage.listCrmActivityEvents({ submissionId: lead.id, limit: 100 });
  assert.ok(archiveActivity.some((event) => event.event_type === 'submission.archived' && event.metadata.archiveReason === 'unavailable'));

  const restored = await restoreLead({
    submissionId: lead.id,
    status: 'review',
    actor: 'lifecycle-admin',
    storage,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.submission.status, 'review');
  assert.equal(restored.submission.follow_up_state, 'completed');
  assert.equal(restored.submission.next_action_at, null);
  assert.ok(restored.submission.restored_at);
  const afterRestoreRequest = await storage.getDealHunterCimRequestById('archive-linked-request');
  assert.equal(afterRestoreRequest.request_state, 'stopped');
  assert.equal(afterRestoreRequest.next_follow_up_at, null);
  const restoreActivity = await storage.listCrmActivityEvents({ submissionId: lead.id, limit: 100 });
  assert.ok(restoreActivity.some((event) => event.event_type === 'submission.restored' && event.metadata.outreachRestarted === false));
});

test('Command Center Pass & Archive uses the same reversible archive semantics', async (t) => {
  const storage = testStorage(t);
  const { updateAcquisitionCommandCenterRecord } = await import('../server/services/acquisitionCommandCenter.js');
  const lead = await createLead(storage, 'Command Center Services');
  const result = await updateAcquisitionCommandCenterRecord({
    submissionId: lead.id,
    passReason: 'too-expensive',
    feedbackNote: 'Valuation is outside the approved range.',
    updatedBy: 'command-admin',
    storage,
  });

  assert.equal(result.ok, true);
  assert.equal(result.archived, true);
  assert.equal(result.submission.status, 'archived');
  assert.equal(result.submission.archive_reason, 'valuation');
  assert.equal(result.submission.follow_up_state, 'completed');
  assert.equal(result.acquisitionCommand.pipelineStage, 'passed');
  assert.equal(result.submission.metadata.acquisitionCommand.passReason, 'too-expensive');
  const activity = await storage.listCrmActivityEvents({ submissionId: lead.id, limit: 100 });
  assert.ok(activity.some((event) => event.event_type === 'submission.archived'));
});

test('linked Deal Hunter dismissal archives and stores disposition in one CRM activity mutation', async () => {
  const { dismissDealHunterOpportunity } = await import('../server/services/leadLifecycle.js');
  const linkedSubmission = {
    id: 'linked-dismissal-submission',
    status: 'review',
    updated_at: '2026-08-06T12:00:00.000Z',
    metadata: {
      dealHunter: { dealKey: 'linked-dismissal-deal' },
      acquisitionCommand: { pipelineStage: 'screening' },
    },
  };
  const mutations = [];
  let directDispositionWrites = 0;
  const storage = {
    async getSubmission(id) {
      assert.equal(id, linkedSubmission.id);
      return structuredClone(linkedSubmission);
    },
    async mutateWithCrmActivity(mutation) {
      mutations.push(structuredClone(mutation));
      return {
        applied: true,
        record: {
          submission: { ...linkedSubmission, ...structuredClone(mutation.payload.values) },
          disposition: structuredClone(mutation.payload.disposition),
        },
        activity: structuredClone(mutation.activity),
      };
    },
    async upsertDealHunterDisposition() {
      directDispositionWrites += 1;
      throw new Error('linked non-archived dismissal must not write disposition separately');
    },
  };

  const result = await dismissDealHunterOpportunity({
    dealKey: 'linked-dismissal-deal',
    listingUrl: 'https://broker.example.test/linked-dismissal',
    dealName: 'Linked Dismissal Services',
    reason: 'not-a-fit',
    note: 'Does not fit the approved service profile.',
    submissionId: linkedSubmission.id,
    actor: 'dismissal-admin',
    storage,
  });

  assert.equal(result.ok, true);
  assert.equal(result.archived, true);
  assert.equal(result.submission.status, 'archived');
  assert.equal(result.disposition.disposition, 'dismissed');
  assert.equal(directDispositionWrites, 0);
  assert.equal(mutations.length, 1);
  const [mutation] = mutations;
  assert.equal(mutation.operation, 'dismiss_deal_hunter_opportunity');
  assert.equal(mutation.payload.submissionId, linkedSubmission.id);
  assert.equal(mutation.payload.expectedUpdatedAt, linkedSubmission.updated_at);
  assert.equal(mutation.payload.values.status, 'archived');
  assert.equal(mutation.payload.values.follow_up_state, 'completed');
  assert.equal(mutation.payload.values.metadata.acquisitionCommand.pipelineStage, 'passed');
  assert.equal(mutation.payload.values.metadata.leadArchive.previousStatus, 'review');
  assert.equal(mutation.payload.disposition.submission_id, linkedSubmission.id);
  assert.equal(mutation.payload.disposition.deal_key, 'linked-dismissal-deal');
  assert.equal(mutation.activity.event_type, 'submission.archived');
  assert.equal(mutation.activity.metadata.archiveReason, 'not-a-fit');
  assert.equal(mutation.activity.metadata.dealKey, 'linked-dismissal-deal');
});

test('Deal Hunter dismissal refuses a supplied CRM record linked to another opportunity', async () => {
  const { dismissDealHunterOpportunity } = await import('../server/services/leadLifecycle.js');
  let mutationCalls = 0;
  let dispositionWrites = 0;
  const storage = {
    async getSubmission(id) {
      return {
        id,
        status: 'review',
        updated_at: '2026-08-06T12:00:00.000Z',
        listing_url: 'https://broker.example.test/wrong-listing',
        metadata: { dealHunter: { dealKey: 'different-deal-key' } },
      };
    },
    async getDealHunterCrmImport({ dealKey }) {
      assert.equal(dealKey, 'authoritative-deal-key');
      return { deal_key: dealKey, submission_id: 'authoritative-submission' };
    },
    async getSubmissionByListingUrl() {
      return { id: 'authoritative-submission' };
    },
    async mutateWithCrmActivity() {
      mutationCalls += 1;
      return { applied: true };
    },
    async upsertDealHunterDisposition() {
      dispositionWrites += 1;
      return null;
    },
  };

  const result = await dismissDealHunterOpportunity({
    dealKey: 'authoritative-deal-key',
    listingUrl: 'https://broker.example.test/authoritative-listing',
    reason: 'not-a-fit',
    submissionId: 'wrong-submission',
    actor: 'dismissal-admin',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /not authoritatively linked/i);
  assert.equal(mutationCalls, 0);
  assert.equal(dispositionWrites, 0);
});

test('Deal Hunter dismissal does not fall back to another CRM record when a supplied ID is missing', async () => {
  const { dismissDealHunterOpportunity } = await import('../server/services/leadLifecycle.js');
  let mutationCalls = 0;
  const storage = {
    async getSubmission(id) {
      if (id === 'missing-submission') return null;
      return { id, status: 'review', metadata: { dealHunter: { dealKey: 'missing-id-deal' } } };
    },
    async getDealHunterCrmImport() {
      return { submission_id: 'different-import-submission' };
    },
    async mutateWithCrmActivity() {
      mutationCalls += 1;
      return { applied: true };
    },
  };

  const result = await dismissDealHunterOpportunity({
    dealKey: 'missing-id-deal',
    reason: 'not-a-fit',
    submissionId: 'missing-submission',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(mutationCalls, 0);
});

test('caller-supplied listing URL alone cannot authorize a Deal Hunter dismissal', async () => {
  const { dismissDealHunterOpportunity } = await import('../server/services/leadLifecycle.js');
  let listingLookupCalls = 0;
  let mutationCalls = 0;
  const storage = {
    async getSubmission(id) {
      return {
        id,
        status: 'review',
        updated_at: '2026-08-06T12:00:00.000Z',
        listing_url: '',
        metadata: {},
      };
    },
    async getDealHunterCrmImport() {
      return null;
    },
    async getSubmissionByListingUrl() {
      listingLookupCalls += 1;
      return { id: 'caller-chosen-submission' };
    },
    async mutateWithCrmActivity() {
      mutationCalls += 1;
      return { applied: true };
    },
  };

  const result = await dismissDealHunterOpportunity({
    dealKey: 'non-url-deal-key',
    listingUrl: 'https://broker.example.test/caller-chosen-listing',
    reason: 'not-a-fit',
    submissionId: 'caller-chosen-submission',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /not authoritatively linked/i);
  assert.equal(listingLookupCalls, 0);
  assert.equal(mutationCalls, 0);
});

test('a URL-derived deal key can authorize its matching stored CRM listing identity', async () => {
  const { dismissDealHunterOpportunity } = await import('../server/services/leadLifecycle.js');
  const listingUrl = 'https://broker.example.test/legacy-listing';
  const dealKey = `url:${listingUrl}`;
  let mutationCalls = 0;
  const storage = {
    async getSubmission(id) {
      return {
        id,
        status: 'review',
        updated_at: '2026-08-06T12:00:00.000Z',
        listing_url: listingUrl,
        metadata: {},
      };
    },
    async getDealHunterCrmImport() {
      return null;
    },
    async mutateWithCrmActivity(mutation) {
      mutationCalls += 1;
      return {
        applied: true,
        record: {
          submission: { id: mutation.payload.submissionId, ...mutation.payload.values },
          disposition: mutation.payload.disposition,
        },
        activity: mutation.activity,
      };
    },
  };

  const result = await dismissDealHunterOpportunity({
    dealKey,
    listingUrl,
    reason: 'not-a-fit',
    submissionId: 'legacy-url-submission',
    storage,
  });

  assert.equal(result.ok, true);
  assert.equal(result.archived, true);
  assert.equal(result.disposition.deal_key, dealKey);
  assert.equal(result.disposition.listing_url, listingUrl);
  assert.equal(mutationCalls, 1);
});

test('a caller listing URL that conflicts with a URL-derived deal key is rejected', async () => {
  const { dismissDealHunterOpportunity } = await import('../server/services/leadLifecycle.js');
  let storageReads = 0;
  const storage = {
    async getSubmission() {
      storageReads += 1;
      return null;
    },
    async getDealHunterCrmImport() {
      storageReads += 1;
      return null;
    },
  };

  const result = await dismissDealHunterOpportunity({
    dealKey: 'url:https://broker.example.test/authoritative-listing',
    listingUrl: 'https://broker.example.test/different-listing',
    reason: 'not-a-fit',
    submissionId: 'arbitrary-submission',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /listing URL does not match/i);
  assert.equal(storageReads, 0);
});

test('linked Deal Hunter dismissal returns 409 on compound mutation conflict without a separate disposition write', async () => {
  const { dismissDealHunterOpportunity } = await import('../server/services/leadLifecycle.js');
  let directDispositionWrites = 0;
  const storage = {
    async getSubmission() {
      return {
        id: 'conflicted-dismissal-submission',
        status: 'review',
        updated_at: '2026-08-06T12:00:00.000Z',
        metadata: { dealHunter: { dealKey: 'conflicted-dismissal-deal' } },
      };
    },
    async mutateWithCrmActivity() {
      return { applied: false, record: null, activity: null };
    },
    async upsertDealHunterDisposition() {
      directDispositionWrites += 1;
      return null;
    },
  };
  const result = await dismissDealHunterOpportunity({
    dealKey: 'conflicted-dismissal-deal',
    reason: 'not-a-fit',
    submissionId: 'conflicted-dismissal-submission',
    actor: 'dismissal-admin',
    storage,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(directDispositionWrites, 0);
});

test('already-archived Deal Hunter dismissal stores only disposition and does not archive again', async () => {
  const { dismissDealHunterOpportunity } = await import('../server/services/leadLifecycle.js');
  const archivedSubmission = {
    id: 'already-archived-submission',
    status: 'archived',
    updated_at: '2026-08-06T12:00:00.000Z',
    metadata: { dealHunter: { dealKey: 'already-archived-deal' } },
  };
  let mutationCalls = 0;
  let directDispositionWrites = 0;
  const storage = {
    async getSubmission() {
      return structuredClone(archivedSubmission);
    },
    async mutateWithCrmActivity() {
      mutationCalls += 1;
      throw new Error('already-archived CRM record must not be archived again');
    },
    async upsertDealHunterDisposition(disposition) {
      directDispositionWrites += 1;
      return structuredClone(disposition);
    },
  };
  const result = await dismissDealHunterOpportunity({
    dealKey: 'already-archived-deal',
    reason: 'not-a-fit',
    submissionId: archivedSubmission.id,
    actor: 'dismissal-admin',
    storage,
  });
  assert.equal(result.ok, true);
  assert.equal(result.archived, true);
  assert.equal(result.submission.status, 'archived');
  assert.equal(mutationCalls, 0);
  assert.equal(directDispositionWrites, 1);
});

test('source-only Deal Hunter dismissals remain suppressed until explicitly restored', async (t) => {
  const storage = testStorage(t);
  const {
    dismissDealHunterOpportunity,
    restoreDealHunterOpportunity,
  } = await import('../server/services/leadLifecycle.js');
  const { reviewDailyDeals } = await import('../server/services/dealHunter.js');
  const initial = await reviewDailyDeals({ storage });
  const deal = initial.qualified.find((item) => item.name === 'Archive Test Services');
  assert.ok(deal);

  const dismissed = await dismissDealHunterOpportunity({
    dealKey: deal.dealKey,
    listingUrl: deal.listingUrl,
    dealName: deal.name,
    reason: 'not-a-fit',
    note: 'Outside the service profile after manual review.',
    actor: 'deal-hunter-admin',
    storage,
  });
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.archived, false);
  assert.equal(dismissed.disposition.disposition, 'dismissed');

  const afterDismissal = await reviewDailyDeals({ storage });
  assert.equal(afterDismissal.qualified.some((item) => item.dealKey === deal.dealKey), false);
  assert.equal(afterDismissal.totals.dismissed, 1);

  const restored = await restoreDealHunterOpportunity({
    dealKey: deal.dealKey,
    actor: 'deal-hunter-admin',
    storage,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.disposition.disposition, 'restored');
  const afterRestore = await reviewDailyDeals({ storage });
  assert.equal(afterRestore.qualified.some((item) => item.dealKey === deal.dealKey), true);
});

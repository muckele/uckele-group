import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { listCrmActivity, projectCrmActivityTimeline } from '../server/services/activity.js';
import { listCrmCommunications } from '../server/services/communications.js';
import { listCrmDocumentHistory } from '../server/services/documentVault.js';
import { getDashboardSubmission } from '../server/services/submissions.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const timestamp = '2026-09-17T18:00:00.000Z';
const digest = 'd'.repeat(64);

function submission(id, overrides = {}) {
  return {
    id, created_at: timestamp, updated_at: timestamp, status: 'review', spam_score: 0,
    spam_reasons: [], delivery_provider: 'manual', delivery_status: 'not-applicable',
    delivery_error: null, crm_status: 'not-applicable', crm_error: null, source: 'read-through-test',
    ip_hash: '', user_agent: '', name: id, email: `${id}@example.test`, phone: '',
    company: `${id} company`, role: 'Broker', message: 'fixture', status_updated_at: timestamp,
    listing_url: '', business_website: '', prospectus_url: '', asking_price: '', ttm_revenue: '',
    ttm_ebitda: '', ebitda_multiple: '', net_margin: '', business_age: '', sba_eligible: 'unknown',
    broker_name: '', broker_email: '', broker_phone: '', seller_name: '', seller_email: '', seller_phone: '',
    lead_type: 'broker', priority: 'normal', tags: [], assigned_to: '', notes: `${id} note`,
    follow_up_state: 'needs-response', next_action_at: null, last_contacted_at: null,
    deal_hunter_opportunity_id: null, metadata: {}, ...overrides,
  };
}

function communication(id, submissionId, occurredAt) {
  return {
    id, submission_id: submissionId, deal_key: 'pair', cim_request_id: null, direction: 'inbound',
    channel: 'email', source: 'fixture', kind: 'broker-reply', provider: 'fixture',
    provider_message_id: `${id}-provider`, source_event_id: `${id}-event`,
    idempotency_key: `${id}-idempotency`, in_reply_to: null, reply_to_address: '',
    from_address: `${submissionId}@example.test`, to_addresses: ['owner@example.test'],
    cc_addresses: [], bcc_addresses: [], subject: id, body_text: `${id} body`, body_html_sanitized: '',
    occurred_at: occurredAt, created_at: occurredAt, updated_at: occurredAt, delivery_state: 'delivered',
    delivery_state_at: occurredAt, content_state: 'complete', content_attempt_count: 1,
    content_last_error: null, content_next_attempt_at: null, attachment_metadata: [],
    assigned_at: occurredAt, assigned_by: 'fixture', created_by: 'fixture', updated_by: 'fixture', metadata: {},
  };
}

function tableDigest(sqlitePath) {
  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const tables = ['contact_submissions', 'crm_activity_events', 'email_events', 'crm_communications', 'secure_upload_requests', 'secure_documents'];
    const state = Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
    return createHash('sha256').update(JSON.stringify(state)).digest('hex');
  } finally {
    database.close();
  }
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-read-through-'));
  const sqlitePath = path.join(directory, 'crm.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await storage.insertSubmission(submission('survivor', { deal_hunter_opportunity_id: 'opportunity' }));
  await storage.insertSubmission(submission('loser'));
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'opportunity', created_at: timestamp, updated_at: timestamp,
    canonical_name: 'Read-through opportunity', canonical_recipient: null, canonical_location: null,
    primary_submission_id: 'survivor', identity_version: 'read-through-v1', status: 'active', metadata: {},
  });
  await storage.upsertDealHunterCimRepairManifest({
    id: 'receipt', created_at: timestamp, updated_at: timestamp, mode: 'crm-duplicate-consolidation',
    status: 'applied', actor: 'test', backup_reference: 'fixture-backup', checksum: digest,
    manifest: { version: 1 }, metadata: {},
  });
  const database = new Database(sqlitePath);
  database.prepare(`
    INSERT INTO crm_submission_supersessions (
      id, created_at, updated_at, status, survivor_submission_id, superseded_submission_id,
      opportunity_id, reason_code, reason_text, approved_by, approved_at, actor,
      repair_version, repair_manifest_id, repair_digest, metadata
    ) VALUES (
      'relation', ?, ?, 'active', 'survivor', 'loser', 'opportunity', 'confirmed-duplicate',
      'Owner reviewed duplicate.', 'owner@example.test', ?, 'test', 'v1', 'receipt', ?, '{}'
    )
  `).run(timestamp, timestamp, timestamp, digest);
  database.close();

  for (const [id, submissionId, createdAt] of [
    ['activity-survivor', 'survivor', '2026-09-17T18:02:00.000Z'],
    ['activity-loser', 'loser', '2026-09-17T18:03:00.000Z'],
  ]) {
    await storage.insertCrmActivityEvent({
      id, submission_id: submissionId, opportunity_id: 'opportunity', created_at: createdAt,
      actor: 'fixture', role: 'system', event_type: 'submission.updated', summary: id, metadata: {},
    });
  }
  for (const [id, submissionId, createdAt] of [
    ['legacy-survivor', 'survivor', '2026-09-17T18:04:00.000Z'],
    ['legacy-loser', 'loser', '2026-09-17T18:05:00.000Z'],
  ]) {
    await storage.insertEmailEvent({
      id, created_at: createdAt, provider: 'fixture', event_type: 'delivered', message_id: `${id}-message`,
      provider_event_id: `${id}-provider`, event_key: `${id}-key`, recipient_email: `${submissionId}@example.test`,
      subject: id, submission_id: submissionId, communication_id: null, source: 'fixture', metadata: {},
    });
  }
  await storage.insertCrmCommunication(communication('communication-survivor', 'survivor', '2026-09-17T18:06:00.000Z'));
  await storage.insertCrmCommunication(communication('communication-loser', 'loser', '2026-09-17T18:07:00.000Z'));
  for (const [id, submissionId, createdAt] of [
    ['request-survivor', 'survivor', '2026-09-17T18:08:00.000Z'],
    ['request-loser', 'loser', '2026-09-17T18:09:00.000Z'],
  ]) {
    await storage.insertSecureUploadRequest({
      id, submission_id: submissionId, created_at: createdAt, updated_at: createdAt,
      email: `${submissionId}@example.test`, contact_name: submissionId, requested_by: 'fixture',
      status: 'closed', expires_at: '2026-09-18T18:00:00.000Z', nda_required: false,
      nda_accepted_at: null, last_uploaded_at: createdAt, note: id, requested_documents: [],
      revoked_at: null, closed_at: createdAt, upload_batch_count: 1,
    });
    await storage.insertSecureDocument({
      id: `document-${submissionId}`, request_id: id, submission_id: submissionId, created_at: createdAt,
      document_type: 'other', file_name: `${submissionId}.txt`, original_name: `${submissionId}.txt`,
      mime_type: 'text/plain', size_bytes: 10, storage_path: `/fixture/${submissionId}.txt`,
      uploaded_by_email: `${submissionId}@example.test`, note: id, nda_accepted_at: null,
    });
  }
  return { sqlitePath, storage };
}

test('historical detail keeps the requested loser row and exposes bounded supersession context', async (t) => {
  const { storage } = await fixture(t);
  const detail = await getDashboardSubmission('loser', { storage });

  assert.equal(detail.id, 'loser');
  assert.equal(detail.notes, 'loser note');
  assert.equal(detail.supersession.isSuperseded, true);
  assert.equal(detail.supersession.canonicalSubmissionId, 'survivor');
  assert.equal(detail.supersession.opportunityId, 'opportunity');
  assert.equal(detail.supersession.relation.reasonText, 'Owner reviewed duplicate.');
  assert.equal(detail.supersession.relation.approvedBy, 'owner@example.test');
  assert.equal(detail.supersession.relation.repairManifestId, 'receipt');
  assert.equal(detail.supersession.survivorUrl, '/admin/crm/survivor');
  assert.deepEqual(detail.supersession.historySubmissionIds, ['survivor', 'loser']);
  assert.deepEqual(detail.secure_documents.map((row) => row.originSubmissionId).sort(), ['loser', 'survivor']);
  assert.deepEqual(detail.secure_upload_requests.map((row) => row.originSubmissionId).sort(), ['loser', 'survivor']);
  assert.equal(detail.email_engagement.total, 2);
});

test('survivor read-through unions direct histories, preserves ordering and leaves stored owners byte-identical', async (t) => {
  const { sqlitePath, storage } = await fixture(t);
  const before = tableDigest(sqlitePath);
  const context = await storage.getCrmSubmissionSupersessionContext('survivor');

  const rawEvents = await listCrmActivity({
    submissionId: 'survivor', historySubmissionIds: context.historySubmissionIds, storage,
  });
  const timeline = projectCrmActivityTimeline(rawEvents);
  const communications = await listCrmCommunications({
    submissionId: 'survivor', historySubmissionIds: context.historySubmissionIds, storage,
  });
  const documents = await listCrmDocumentHistory({
    submissionId: 'survivor', historySubmissionIds: context.historySubmissionIds, storage,
  });

  assert.deepEqual(rawEvents.map((row) => row.id), ['activity-loser', 'activity-survivor']);
  assert.deepEqual(rawEvents.map((row) => row.originSubmissionId), ['loser', 'survivor']);
  assert.deepEqual(timeline.events.map((row) => row.originSubmissionId), ['loser', 'survivor']);
  assert.deepEqual(communications.rows.map((row) => row.id), ['communication-loser', 'communication-survivor']);
  assert.deepEqual(communications.rows.map((row) => row.originSubmissionId), ['loser', 'survivor']);
  assert.deepEqual(documents.uploadRequests.map((row) => row.id), ['request-loser', 'request-survivor']);
  assert.deepEqual(documents.documents.map((row) => row.originSubmissionId), ['loser', 'survivor']);
  assert.equal(tableDigest(sqlitePath), before);

  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  assert.deepEqual(database.prepare('SELECT id, submission_id FROM crm_activity_events ORDER BY id').all(), [
    { id: 'activity-loser', submission_id: 'loser' },
    { id: 'activity-survivor', submission_id: 'survivor' },
  ]);
  database.close();
});

test('ordinary records retain single-record history behavior', async (t) => {
  const { storage } = await fixture(t);
  await storage.insertSubmission(submission('ordinary'));
  const detail = await getDashboardSubmission('ordinary', { storage });
  assert.equal(detail.supersession.isSuperseded, false);
  assert.deepEqual(detail.supersession.historySubmissionIds, ['ordinary']);
  assert.equal(detail.supersession.survivorUrl, '');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';
import { listCrmActivity, recordCrmActivity, summarizeSubmissionChanges } from '../server/services/activity.js';

function submission(id, updatedAt = '2026-07-13T10:00:00.000Z') {
  return {
    id,
    created_at: updatedAt,
    updated_at: updatedAt,
    status: 'review',
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: '',
    crm_status: 'not-applicable',
    crm_error: '',
    source: 'activity-test',
    ip_hash: '',
    user_agent: '',
    name: 'Activity Seller',
    email: 'activity@example.com',
    phone: '',
    company: 'Activity Co',
    role: 'Seller',
    message: 'Atomic activity test',
    status_updated_at: updatedAt,
    listing_url: '',
    business_website: '',
    prospectus_url: '',
    asking_price: '',
    ttm_revenue: '',
    ttm_ebitda: '',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: '',
    broker_email: '',
    broker_phone: '',
    seller_name: 'Activity Seller',
    seller_email: 'activity@example.com',
    seller_phone: '',
    lead_type: 'seller',
    priority: 'normal',
    tags: [],
    assigned_to: '',
    notes: '',
    follow_up_state: 'needs-response',
    next_action_at: null,
    last_contacted_at: null,
    metadata: {},
  };
}

test('CRM activity events are durable, ordered, and filterable', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-activity-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });

  await recordCrmActivity({
    submissionId: 'deal-1',
    eventType: 'submission.created',
    summary: 'Record created.',
    actor: 'matt',
    role: 'admin',
    createdAt: '2026-07-13T10:00:00.000Z',
    storage,
  });
  await recordCrmActivity({
    submissionId: 'deal-1',
    eventType: 'documents.uploaded',
    summary: 'Financials uploaded.',
    actor: 'seller@example.com',
    role: 'contact',
    createdAt: '2026-07-13T11:00:00.000Z',
    metadata: { category: 'financials' },
    storage,
  });
  await recordCrmActivity({
    submissionId: 'deal-2',
    eventType: 'email.replied',
    summary: 'Unrelated deal reply.',
    storage,
  });

  const all = await listCrmActivity({ submissionId: 'deal-1', storage });
  const documents = await listCrmActivity({ submissionId: 'deal-1', eventTypes: ['documents.uploaded'], storage });

  assert.equal(all.length, 2);
  assert.equal(all[0].summary, 'Financials uploaded.');
  assert.equal(all[0].actor, 'seller@example.com');
  assert.deepEqual(all[0].metadata, { category: 'financials' });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].event_type, 'documents.uploaded');
});

test('submission change summaries omit version fields and retain before/after values', () => {
  assert.deepEqual(
    summarizeSubmissionChanges(
      { status: 'new', priority: 'normal', updated_at: 'old' },
      { status: 'review', priority: 'normal', updated_at: 'new' },
    ),
    [{ field: 'status', before: 'new', after: 'review' }],
  );
});

test('SQLite rolls back primary CRM mutations when durable activity persistence fails', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-activity-rollback-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  const duplicateActivity = {
    id: 'duplicate-activity-id',
    submission_id: 'seed',
    created_at: '2026-07-13T10:00:00.000Z',
    actor: 'test',
    role: 'system',
    event_type: 'submission.created',
    summary: 'Seed event.',
    metadata: {},
  };
  await storage.insertCrmActivityEvent(duplicateActivity);

  await assert.rejects(
    () => storage.mutateWithCrmActivity({
      operation: 'insert_submission',
      payload: { submission: submission('rolled-back-insert') },
      activity: { ...duplicateActivity, submission_id: 'rolled-back-insert' },
    }),
    /unique|constraint/i,
  );
  assert.equal(await storage.getSubmission('rolled-back-insert'), null);

  await storage.insertSubmission(submission('rolled-back-update'));
  await assert.rejects(
    () => storage.mutateWithCrmActivity({
      operation: 'update_submission',
      payload: {
        id: 'rolled-back-update',
        values: { notes: 'must not commit', updated_at: '2026-07-13T10:01:00.000Z' },
      },
      activity: { ...duplicateActivity, submission_id: 'rolled-back-update' },
    }),
    /unique|constraint/i,
  );
  assert.equal((await storage.getSubmission('rolled-back-update')).notes, '');
});

test('deleting a SQLite CRM record removes its activity history', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-activity-delete-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  await storage.insertSubmission(submission('activity-delete'));
  await recordCrmActivity({
    submissionId: 'activity-delete',
    eventType: 'submission.created',
    summary: 'Delete me with the record.',
    storage,
  });

  await storage.deleteSubmission('activity-delete');

  assert.deepEqual(await listCrmActivity({ submissionId: 'activity-delete', storage }), []);
});

test('Supabase sends primary mutations and activity through one transactional RPC', async () => {
  const calls = [];
  const inputSubmission = submission('00000000-0000-4000-8000-000000000001');
  const inputActivity = {
    id: '00000000-0000-4000-8000-000000000002',
    submission_id: inputSubmission.id,
    created_at: '2026-07-13T10:00:00.000Z',
    actor: 'test',
    role: 'system',
    event_type: 'submission.created',
    summary: 'Created atomically.',
    metadata: {},
  };
  const client = {
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      return {
        data: { applied: true, record: inputSubmission, activity: inputActivity },
        error: null,
      };
    },
  };
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    { client },
  );

  const result = await storage.mutateWithCrmActivity({
    operation: 'insert_submission',
    payload: { submission: inputSubmission },
    activity: inputActivity,
  });

  assert.deepEqual(calls, [{
    name: 'insert_submission_with_crm_activity',
    parameters: {
      p_payload: { submission: inputSubmission },
      p_activity: inputActivity,
    },
  }]);
  assert.equal(result.applied, true);
  assert.equal(result.record.id, inputSubmission.id);
  assert.equal(result.activity.event_type, 'submission.created');
});

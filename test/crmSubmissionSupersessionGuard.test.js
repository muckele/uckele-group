import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  CRM_SUBMISSION_SUPERSEDED,
  CRM_SUPERSESSION_UNAVAILABLE,
  CrmSubmissionSupersededError,
  CrmSupersessionUnavailableError,
  assertCrmSubmissionWritable,
  getCrmSubmissionSupersessionContext,
  projectCrmSupersessionHttpError,
} from '../server/services/crmSubmissionSupersession.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';
import { archiveLead, restoreLead } from '../server/services/leadLifecycle.js';
import { deleteDashboardSubmission, updateSubmissionWorkflow } from '../server/services/submissions.js';

const timestamp = '2026-09-17T18:00:00.000Z';
const digest = 'a'.repeat(64);

function baseSubmission(id, owner = null) {
  return {
    id, created_at: timestamp, updated_at: timestamp, status: 'review', spam_score: 0,
    spam_reasons: [], delivery_provider: 'manual', delivery_status: 'not-applicable',
    delivery_error: null, crm_status: 'not-applicable', crm_error: null, source: 'guard-test',
    ip_hash: '', user_agent: '', name: id, email: `${id}@example.test`, phone: '', company: '',
    role: '', message: 'fixture', status_updated_at: timestamp, listing_url: '', business_website: '',
    prospectus_url: '', asking_price: '', ttm_revenue: '', ttm_ebitda: '', ebitda_multiple: '',
    net_margin: '', business_age: '', sba_eligible: 'unknown', broker_name: '', broker_email: '',
    broker_phone: '', seller_name: '', seller_email: '', seller_phone: '', lead_type: 'broker',
    priority: 'normal', tags: [], assigned_to: '', notes: '', follow_up_state: 'needs-response',
    next_action_at: null, last_contacted_at: null, deal_hunter_opportunity_id: owner, metadata: {},
  };
}

async function seededStorage(t, { loserStatus = 'review' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-supersession-guard-'));
  const sqlitePath = path.join(directory, 'storage.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await storage.insertSubmission(baseSubmission('survivor', 'opportunity'));
  await storage.insertSubmission({
    ...baseSubmission('loser'),
    status: loserStatus,
    archived_at: loserStatus === 'archived' ? timestamp : null,
    archive_reason: loserStatus === 'archived' ? 'duplicate' : null,
  });
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'opportunity', created_at: timestamp, updated_at: timestamp,
    canonical_name: 'Canonical', canonical_recipient: null, canonical_location: null,
    primary_submission_id: 'survivor', identity_version: 'guard-test-v1', status: 'active', metadata: {},
  });
  await storage.upsertDealHunterCimRepairManifest({
    id: 'receipt', created_at: timestamp, updated_at: timestamp, mode: 'crm-duplicate-consolidation',
    status: 'applied', actor: 'test', backup_reference: 'backup', checksum: digest,
    manifest: { version: 1 }, metadata: {},
  });
  const database = new Database(sqlitePath);
  database.prepare(`
    INSERT INTO crm_submission_supersessions (
      id, created_at, updated_at, status, survivor_submission_id, superseded_submission_id,
      opportunity_id, reason_code, reason_text, approved_by, approved_at, actor,
      repair_version, repair_manifest_id, repair_digest, metadata
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, 'confirmed-duplicate', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'relation', timestamp, timestamp, 'survivor', 'loser', 'opportunity', 'Reviewed duplicate.',
    'owner@example.test', timestamp, 'test', 'v1', 'receipt', digest, JSON.stringify({ safe: true }),
  );
  database.close();
  return { storage, sqlitePath };
}

function guardedStateHash(sqlitePath) {
  const database = new Database(sqlitePath, { readonly: true });
  const snapshot = {
    contacts: database.prepare('SELECT * FROM contact_submissions ORDER BY id').all(),
    dispositions: database.prepare('SELECT * FROM deal_hunter_dispositions ORDER BY id').all(),
    activity: database.prepare('SELECT * FROM crm_activity_events ORDER BY id').all(),
    cleanupJobs: database.prepare('SELECT * FROM secure_document_cleanup_jobs ORDER BY id').all(),
    opportunityPrimary: database.prepare(`
      SELECT opportunity_id, primary_submission_id
      FROM deal_hunter_opportunities
      ORDER BY opportunity_id
    `).all(),
  };
  database.close();
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function assertSupersededError(error) {
  assert.deepEqual({
    code: error.code,
    status: error.status,
    submissionId: error.submissionId,
    survivorSubmissionId: error.survivorSubmissionId,
    opportunityId: error.opportunityId,
  }, {
    code: CRM_SUBMISSION_SUPERSEDED,
    status: 409,
    submissionId: 'loser',
    survivorSubmissionId: 'survivor',
    opportunityId: 'opportunity',
  });
  return true;
}

test('SQLite returns the bounded stable context for loser, survivor, and unrelated submissions', async (t) => {
  const { storage } = await seededStorage(t);
  await storage.insertSubmission(baseSubmission('unrelated'));
  const loser = await storage.getCrmSubmissionSupersessionContext('loser');
  assert.deepEqual(loser, {
    requestedSubmissionId: 'loser',
    canonicalSubmissionId: 'survivor',
    opportunityId: 'opportunity',
    isSuperseded: true,
    relation: {
      id: 'relation', createdAt: timestamp, updatedAt: timestamp, status: 'active',
      survivorSubmissionId: 'survivor', supersededSubmissionId: 'loser', opportunityId: 'opportunity',
      reasonCode: 'confirmed-duplicate', reasonText: 'Reviewed duplicate.', approvedBy: 'owner@example.test',
      approvedAt: timestamp, actor: 'test', repairVersion: 'v1', repairManifestId: 'receipt',
      repairDigest: digest, reversedAt: null, reversedBy: null, reversalReason: null,
      reversalManifestId: null, metadata: { safe: true },
    },
    supersededSubmissions: [],
    historySubmissionIds: ['survivor', 'loser'],
  });
  const survivor = await storage.getCrmSubmissionSupersessionContext('survivor');
  assert.equal(survivor.isSuperseded, false);
  assert.equal(survivor.canonicalSubmissionId, 'survivor');
  assert.equal(survivor.opportunityId, 'opportunity');
  assert.deepEqual(survivor.supersededSubmissions, [loser.relation]);
  assert.deepEqual(survivor.historySubmissionIds, ['survivor', 'loser']);
  assert.deepEqual(await storage.getCrmSubmissionSupersessionContext('unrelated'), {
    requestedSubmissionId: 'unrelated', canonicalSubmissionId: 'unrelated', opportunityId: null,
    isSuperseded: false, relation: null, supersededSubmissions: [], historySubmissionIds: ['unrelated'],
  });
  assert.deepEqual(await storage.listActiveCrmSubmissionSupersessions({ submissionIds: ['loser'] }), [loser.relation]);
  assert.deepEqual(await storage.listActiveCrmSubmissionSupersessions({ opportunityIds: ['opportunity'] }), [loser.relation]);
});

test('SQLite writable guard and service wrappers expose only typed safe fields', async (t) => {
  const { storage } = await seededStorage(t);
  await assert.doesNotReject(storage.assertCrmSubmissionWritable('survivor'));
  await assert.rejects(storage.assertCrmSubmissionWritable('loser'), (error) => {
    assert.equal(error instanceof CrmSubmissionSupersededError, true);
    assert.deepEqual({
      code: error.code, status: error.status, submissionId: error.submissionId,
      survivorSubmissionId: error.survivorSubmissionId, opportunityId: error.opportunityId,
    }, {
      code: CRM_SUBMISSION_SUPERSEDED, status: 409, submissionId: 'loser',
      survivorSubmissionId: 'survivor', opportunityId: 'opportunity',
    });
    return true;
  });
  assert.equal((await getCrmSubmissionSupersessionContext({ storage, submissionId: 'loser' })).isSuperseded, true);
  await assert.rejects(assertCrmSubmissionWritable({ storage, submissionId: 'loser' }), { code: CRM_SUBMISSION_SUPERSEDED });
  assert.deepEqual(projectCrmSupersessionHttpError(new CrmSubmissionSupersededError({
    submissionId: 'loser', survivorSubmissionId: 'survivor', opportunityId: 'opportunity',
  })), {
    status: 409,
    body: {
      success: false, code: CRM_SUBMISSION_SUPERSEDED,
      error: 'This CRM record is historical and cannot be changed.',
      submissionId: 'loser', survivorSubmissionId: 'survivor', opportunityId: 'opportunity',
    },
  });
  assert.equal(projectCrmSupersessionHttpError(new Error('secret SQL')), null);
  assert.equal(projectCrmSupersessionHttpError({
    code: CRM_SUBMISSION_SUPERSEDED,
    message: 'forged internal error',
    submissionId: 'loser',
    survivorSubmissionId: 'survivor',
    opportunityId: 'opportunity',
  }), null, 'only the typed public error may use the supersession projection');
});

test('SQLite supersession audit reports zero violations for a valid relation', async (t) => {
  const { storage } = await seededStorage(t);
  assert.deepEqual(await storage.auditCrmSubmissionSupersessions(), {
    ok: true,
    violationCount: 0,
    violations: [],
  });
});

test('core services reject superseded CRM writes before any guarded state changes', async (t) => {
  const cases = [
    {
      name: 'workflow update',
      invoke: (storage) => updateSubmissionWorkflow('loser', {
        expected_updated_at: timestamp,
        notes: 'must not be written',
      }, { storage }),
    },
    {
      name: 'archive',
      invoke: (storage) => archiveLead({ submissionId: 'loser', reason: 'duplicate', storage }),
    },
    {
      name: 'delete',
      invoke: (storage) => deleteDashboardSubmission('loser', { storage }),
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (subtest) => {
      const { storage, sqlitePath } = await seededStorage(subtest);
      const before = guardedStateHash(sqlitePath);
      await assert.rejects(testCase.invoke(storage), assertSupersededError);
      assert.equal(guardedStateHash(sqlitePath), before);
    });
  }

  await t.test('restore', async (subtest) => {
    const { storage, sqlitePath } = await seededStorage(subtest, { loserStatus: 'archived' });
    const before = guardedStateHash(sqlitePath);
    await assert.rejects(
      restoreLead({ submissionId: 'loser', status: 'review', storage }),
      assertSupersededError,
    );
    assert.equal(guardedStateHash(sqlitePath), before);
  });
});

test('direct SQLite contact writers cannot bypass the supersession guard', async (t) => {
  const cases = [
    {
      name: 'updateSubmission',
      invoke: (storage) => storage.updateSubmission('loser', { notes: 'blocked' }),
    },
    {
      name: 'updateSubmissionIfCurrent',
      invoke: (storage) => storage.updateSubmissionIfCurrent('loser', timestamp, { notes: 'blocked' }),
    },
    {
      name: 'deleteSubmission',
      invoke: (storage) => storage.deleteSubmission('loser'),
    },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async (subtest) => {
      const { storage, sqlitePath } = await seededStorage(subtest);
      const before = guardedStateHash(sqlitePath);
      await assert.rejects(testCase.invoke(storage), assertSupersededError);
      assert.equal(guardedStateHash(sqlitePath), before);
    });
  }
});

test('submission-mutating CRM activity transactions cannot bypass the supersession guard', async (t) => {
  const cases = [
    ['update_submission', { id: 'loser', expectedUpdatedAt: timestamp, values: { notes: 'blocked' } }],
    ['archive_submission', {
      id: 'loser', expectedUpdatedAt: timestamp,
      values: { updated_at: '2026-09-17T18:00:01.000Z', archive_reason: 'duplicate' },
    }],
    ['dismiss_deal_hunter_opportunity', {
      submissionId: 'loser', expectedUpdatedAt: timestamp,
      values: { updated_at: '2026-09-17T18:00:01.000Z', archive_reason: 'duplicate' },
      disposition: { id: 'blocked-disposition', deal_key: 'blocked', disposition: 'dismissed' },
    }],
  ];
  for (const [operation, payload] of cases) {
    await t.test(operation, async (subtest) => {
      const { storage, sqlitePath } = await seededStorage(subtest);
      const before = guardedStateHash(sqlitePath);
      await assert.rejects(storage.mutateWithCrmActivity({
        operation,
        payload,
        activity: {
          id: `activity-${operation}`,
          submission_id: 'loser',
          opportunity_id: 'opportunity',
          created_at: '2026-09-17T18:00:01.000Z',
          actor: 'test',
          role: 'admin',
          event_type: 'submission.updated',
          summary: 'This activity must not be written.',
          metadata: {},
        },
      }), assertSupersededError);
      assert.equal(guardedStateHash(sqlitePath), before);
    });
  }
});

test('all Supabase supersession methods fail closed before touching the client', async () => {
  let calls = 0;
  const client = new Proxy({}, {
    get() {
      calls += 1;
      throw new Error('Supabase client must not be invoked.');
    },
  });
  const storage = createSupabaseStorage({ storage: {} }, { client });
  const invocations = [
    () => storage.getCrmSubmissionSupersessionContext('loser'),
    () => storage.listActiveCrmSubmissionSupersessions({ submissionIds: ['loser'] }),
    () => storage.assertCrmSubmissionWritable('loser'),
    () => storage.auditCrmSubmissionSupersessions(),
  ];
  for (const invoke of invocations) {
    await assert.rejects(invoke, (error) => {
      assert.equal(error instanceof CrmSupersessionUnavailableError, true);
      assert.equal(error.code, CRM_SUPERSESSION_UNAVAILABLE);
      assert.equal(error.status, 503);
      return true;
    });
  }
  assert.equal(calls, 0);
  assert.deepEqual(projectCrmSupersessionHttpError(new CrmSupersessionUnavailableError()), {
    status: 503,
    body: {
      success: false,
      code: CRM_SUPERSESSION_UNAVAILABLE,
      error: 'CRM supersession authority is unavailable for this storage provider.',
    },
  });
});

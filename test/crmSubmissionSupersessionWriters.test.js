import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { recordCrmActivity, commitCrmActivityMutation } from '../server/services/activity.js';
import { assignUnassignedCommunication, createManualCommunication } from '../server/services/communications.js';
import { revokeSecureUploadRequest } from '../server/services/documentVault.js';
import {
  previewCrmFollowUpEmail,
  processCrmEmailOutbox,
  sendCrmFollowUpEmail,
} from '../server/services/followUpEmail.js';
import { dismissCrmFollowUpRecommendation } from '../server/services/followUpWorkspace.js';
import { createAdminEmailSuppression, liftAdminEmailSuppression } from '../server/services/followUpWorkspace.js';
import { generateCrmFollowUpRecommendation } from '../server/services/followUpRecommendations.js';
import { updateAcquisitionCommandCenterRecord } from '../server/services/acquisitionCommandCenter.js';
import { startDealHunterManualFollowUps } from '../server/services/dealHunterManualFollowUps.js';
import {
  executeDealHunterCimFollowUpRequest,
  repairDealHunterCrmSourceFields,
  retryDealHunterCimRequestWithCorrectedRecipient,
} from '../server/services/dealHunter.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const timestamp = '2026-09-17T18:00:00.000Z';
const digest = '6'.repeat(64);

function submission(id, overrides = {}) {
  return {
    id, created_at: timestamp, updated_at: timestamp, status: 'review', spam_score: 0,
    spam_reasons: [], delivery_provider: 'manual', delivery_status: 'not-applicable',
    delivery_error: null, crm_status: 'not-applicable', crm_error: null, source: 'writer-matrix',
    ip_hash: '', user_agent: '', name: id, email: `${id}@example.test`, phone: '', company: `${id} company`,
    role: 'Broker', message: 'fixture', status_updated_at: timestamp, listing_url: '', business_website: '',
    prospectus_url: '', asking_price: '', ttm_revenue: '', ttm_ebitda: '', ebitda_multiple: '',
    net_margin: '', business_age: '', sba_eligible: 'unknown', broker_name: '', broker_email: '',
    broker_phone: '', seller_name: '', seller_email: '', seller_phone: '', lead_type: 'broker',
    priority: 'normal', tags: [], assigned_to: '', notes: '', follow_up_state: 'needs-response',
    next_action_at: null, last_contacted_at: null, deal_hunter_opportunity_id: null, metadata: {},
    ...overrides,
  };
}

function rawBusinessState(sqlitePath) {
  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const excluded = new Set(['sqlite_sequence']);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => name).filter((name) => !excluded.has(name));
    const snapshot = Object.fromEntries(tables.map((name) => [
      name,
      database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]));
    return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  } finally {
    database.close();
  }
}

function recommendation(submissionId) {
  return {
    id: `${submissionId}-recommendation`, submission_id: submissionId, cim_request_id: null,
    triggering_communication_id: null, input_fingerprint: 'fixture', engine_version: 'fixture',
    rules_version: 'fixture', model_provider: null, model_id: null, status: 'current',
    conversation_state: 'no_outreach', intent: 'none', action_type: 'review', priority_score: 1,
    confidence: 0.25, recommended_next_action_at: null, thread_parent_communication_id: null,
    rationale: 'fixture', evidence_json: [], signals_json: [], commitments_json: [], questions_json: [],
    blockers_json: [], safety_flags_json: [], draft_subject: '', draft_body_text: '', created_at: timestamp,
    expires_at: '2026-09-18T18:00:00.000Z', acted_on_at: null, superseded_at: null,
    acted_on_by: null, outcome: null, metadata: {},
  };
}

function activateRelation(sqlitePath) {
  const database = new Database(sqlitePath);
  try {
    database.prepare(`
      INSERT INTO crm_submission_supersessions (
        id, created_at, updated_at, status, survivor_submission_id, superseded_submission_id,
        opportunity_id, reason_code, reason_text, approved_by, approved_at, actor,
        repair_version, repair_manifest_id, repair_digest, metadata
      ) VALUES (
        'writer-relation', ?, ?, 'active', 'survivor', 'loser', 'opportunity',
        'confirmed-duplicate', 'Reviewed duplicate.', 'owner@example.test', ?, 'test',
        'writer-matrix-v1', 'writer-receipt', ?, '{}'
      )
    `).run(timestamp, timestamp, timestamp, digest);
  } finally {
    database.close();
  }
}

async function fixture(t, { withRecommendation = false, activateSupersession = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-writer-matrix-'));
  const sqlitePath = path.join(directory, 'crm.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await storage.insertSubmission(submission('survivor', { deal_hunter_opportunity_id: 'opportunity' }));
  await storage.insertSubmission(submission('loser', {
    source: 'deal-hunter',
    metadata: { dealHunter: { managed: true, opportunityId: 'opportunity', dealKey: 'writer-matrix-deal' } },
  }));
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'opportunity', created_at: timestamp, updated_at: timestamp,
    canonical_name: 'Canonical', canonical_recipient: null, canonical_location: null,
    primary_submission_id: 'survivor', identity_version: 'writer-matrix-v1', status: 'active', metadata: {},
  });
  await storage.upsertDealHunterCimRepairManifest({
    id: 'writer-receipt', created_at: timestamp, updated_at: timestamp, mode: 'crm-duplicate-consolidation',
    status: 'applied', actor: 'test', backup_reference: 'fixture', checksum: digest,
    manifest: { version: 1 }, metadata: {},
  });
  await storage.upsertDealHunterCimRequest({
    id: 'loser-cim-request', created_at: timestamp, updated_at: timestamp,
    deal_key: 'writer-matrix-deal', opportunity_id: 'opportunity', recipient_email: 'broker@example.test', submission_id: 'loser',
    status: 'delivery_issue', requested_by: 'test', deal_name: 'Canonical', source_name: 'writer-matrix',
    listing_url: '', score: 95, request_state: 'failed', delivery_state: 'bounced',
    delivery_state_at: timestamp, metadata: {},
  });
  if (withRecommendation) await storage.insertCrmFollowUpRecommendation(recommendation('loser'));
  const database = new Database(sqlitePath);
  database.prepare(`
    INSERT INTO crm_communications (
      id, submission_id, direction, channel, source, body_text, occurred_at,
      created_at, updated_at, created_by, updated_by
    ) VALUES (?, ?, 'outbound', 'email', 'writer-matrix', 'fixture', ?, ?, ?, 'test', 'test')
  `).run('loser-communication', 'loser', timestamp, timestamp, timestamp);
  database.prepare(`
    INSERT INTO crm_communications (
      id, submission_id, direction, channel, source, body_text, occurred_at,
      created_at, updated_at, created_by, updated_by
    ) VALUES (?, NULL, 'inbound', 'email', 'writer-matrix', 'fixture', ?, ?, ?, 'test', 'test')
  `).run('unassigned-communication', timestamp, timestamp, timestamp);
  database.prepare(`
    INSERT INTO crm_email_outbox (
      id, communication_id, submission_id, idempotency_key, client_request_key,
      state, expected_submission_version, actor, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 'test', ?, ?)
  `).run(
    'loser-outbox', 'loser-communication', 'loser', 'loser-outbox-key',
    'loser-outbox-client-key', timestamp, timestamp, timestamp,
  );
  database.prepare(`
    INSERT INTO secure_upload_requests (
      id, submission_id, created_at, updated_at, email, contact_name, requested_by,
      status, expires_at, requested_documents
    ) VALUES (?, ?, ?, ?, ?, ?, 'test', 'open', ?, '[]')
  `).run(
    'loser-upload', 'loser', timestamp, timestamp, 'loser@example.test', 'loser',
    '2026-09-18T18:00:00.000Z',
  );
  database.prepare(`
    INSERT INTO secure_documents (
      id, request_id, submission_id, created_at, document_type, file_name,
      original_name, mime_type, size_bytes, storage_path
    ) VALUES (?, ?, ?, ?, 'other', 'fixture.pdf', 'fixture.pdf', 'application/pdf', 1, ?)
  `).run('loser-document', 'loser-upload', 'loser', timestamp, path.join(directory, 'fixture.pdf'));
  database.close();
  if (activateSupersession) activateRelation(sqlitePath);
  return { storage, sqlitePath };
}

async function assertLoserRefusal({ sqlitePath, providerCalls = [], invoke }) {
  const before = rawBusinessState(sqlitePath);
  await assert.rejects(invoke, { code: 'CRM_SUBMISSION_SUPERSEDED', submissionId: 'loser' });
  assert.equal(rawBusinessState(sqlitePath), before, 'loser refusal must leave every business table byte-logically unchanged');
  assert.equal(providerCalls.length, 0, 'loser refusal must occur before a provider boundary');
}

test('real SQLite writer matrix refuses activity and atomic activity mutations for an active loser', async (t) => {
  const { storage, sqlitePath } = await fixture(t);
  await assertLoserRefusal({
    sqlitePath,
    invoke: () => recordCrmActivity({
      storage, submissionId: 'loser', eventType: 'writer.test', summary: 'must refuse',
    }),
  });
  await assertLoserRefusal({
    sqlitePath,
    invoke: () => commitCrmActivityMutation({
      storage,
      operation: 'insert_secure_upload_request',
      payload: { request: {
        id: 'loser-upload', submission_id: 'loser', created_at: timestamp, updated_at: timestamp,
        email: 'loser@example.test', contact_name: 'loser', requested_by: 'test', status: 'open',
        expires_at: '2026-09-18T18:00:00.000Z', nda_required: true, nda_accepted_at: null,
        last_uploaded_at: null, note: '', requested_documents: [], revoked_at: null, closed_at: null,
        upload_batch_count: 0,
      } },
      activity: { submissionId: 'loser', eventType: 'documents.requested', summary: 'must refuse' },
    }),
  });
});

test('real SQLite service writers refuse manual communication and Command Center changes for an active loser', async (t) => {
  const { storage, sqlitePath } = await fixture(t);
  await assertLoserRefusal({
    sqlitePath,
    invoke: () => createManualCommunication({
      submissionId: 'loser', actor: 'test', storage,
      input: { channel: 'note', direction: 'outbound', occurredAt: timestamp, bodyText: 'must refuse' },
    }),
  });
  await assertLoserRefusal({
    sqlitePath,
    invoke: () => updateAcquisitionCommandCenterRecord({
      submissionId: 'loser', pipelineStage: 'diligence', updatedBy: 'test', storage,
    }),
  });
  await assertLoserRefusal({
    sqlitePath,
    invoke: () => assignUnassignedCommunication({
      communicationId: 'unassigned-communication', submissionId: 'loser', actor: 'test', storage,
    }),
  });
});

test('real SQLite email entry points and outbox claim refuse an active loser before provider work', async (t) => {
  const { storage, sqlitePath } = await fixture(t);
  const providerCalls = [];
  await assertLoserRefusal({
    sqlitePath,
    invoke: () => previewCrmFollowUpEmail({ submissionId: 'loser', actor: 'test', storage }),
  });
  await assertLoserRefusal({
    sqlitePath,
    providerCalls,
    invoke: () => sendCrmFollowUpEmail({
      submissionId: 'loser', actor: 'test', input: { clientRequestToken: 'writer-matrix-token' }, storage,
    }),
  });
  await assertLoserRefusal({
    sqlitePath,
    providerCalls,
    invoke: () => processCrmEmailOutbox({
      outboxId: 'loser-outbox', storage,
      sender: async () => { providerCalls.push('called'); return { status: 'sent' }; },
    }),
  });
  await assertLoserRefusal({
    sqlitePath,
    invoke: () => storage.claimCrmEmailOutbox({
      id: 'loser-outbox', claimToken: 'claim', claimedAt: timestamp,
      claimExpiresAt: '2026-09-17T18:05:00.000Z',
    }),
  });
});

test('real SQLite upload, document, communication, and CIM storage boundaries refuse an active loser', async (t) => {
  const { storage, sqlitePath } = await fixture(t);
  const cases = [
    () => revokeSecureUploadRequest({ requestId: 'loser-upload', revokedBy: 'test', storage }),
    () => storage.updateSecureUploadRequest('loser-upload', { updated_at: timestamp, status: 'revoked' }),
    () => storage.resetSecureUploadRequestIfUploading('loser-upload', { updated_at: timestamp, status: 'open' }),
    () => storage.claimSecureUploadRequest('loser-upload', { updated_at: timestamp, status: 'uploading' }),
    () => storage.insertSecureDocument({
      id: 'new-loser-document', request_id: 'loser-upload', submission_id: 'loser', created_at: timestamp,
      document_type: 'other', file_name: 'new.pdf', original_name: 'new.pdf', mime_type: 'application/pdf',
      size_bytes: 1, storage_path: '/tmp/new.pdf', uploaded_by_email: null, note: null, nda_accepted_at: null,
    }),
    () => storage.deleteSecureDocument('loser-document'),
    () => storage.insertCrmCommunication({
      id: 'new-loser-communication', submission_id: 'loser', direction: 'outbound', channel: 'note',
      source: 'writer-matrix', body_text: 'fixture', occurred_at: timestamp, created_at: timestamp,
      updated_at: timestamp, created_by: 'test', updated_by: 'test',
    }),
    () => storage.updateCrmCommunication('unassigned-communication', { submission_id: 'loser' }),
    () => storage.updateCrmCommunication('loser-communication', { submission_id: 'survivor' }),
    () => storage.updateCrmCommunication('loser-communication', { submission_id: null }),
    () => storage.upsertDealHunterCimRequest({
      id: 'loser-cim-request', created_at: timestamp, updated_at: timestamp,
      deal_key: 'writer-matrix-deal', recipient_email: 'broker@example.test', submission_id: 'loser',
      status: 'pending', requested_by: 'test', deal_name: 'Canonical', source_name: 'writer-matrix',
      listing_url: '', score: 95, metadata: {},
    }),
  ];
  for (const invoke of cases) await assertLoserRefusal({ sqlitePath, invoke });
});

test('real SQLite recommendation writers refuse dismiss and generation for an active loser', async (t) => {
  const { storage, sqlitePath } = await fixture(t, { withRecommendation: true });
  const before = rawBusinessState(sqlitePath);
  await assert.rejects(() => dismissCrmFollowUpRecommendation({
    submissionId: 'loser', recommendationId: 'loser-recommendation',
    expectedSubmissionVersion: timestamp, actor: 'test', storage,
  }), { code: 'CRM_SUBMISSION_SUPERSEDED' });
  assert.equal(rawBusinessState(sqlitePath), before);
  await assertLoserRefusal({
    sqlitePath,
    providerCalls: [],
    invoke: () => generateCrmFollowUpRecommendation({
      submissionId: 'loser', storage,
      config: { followUp: { aiEnabled: false, timezone: 'America/Los_Angeles' } },
      now: new Date(timestamp),
    }),
  });
});

test('real SQLite follow-up suppression, legacy CIM execution, and corrected-recipient retry refuse the loser with zero side effects', async (t) => {
  const { storage, sqlitePath } = await fixture(t, { withRecommendation: true });
  const providerCalls = [];
  const cases = [
    () => createAdminEmailSuppression({
      submissionId: 'loser', email: 'loser@example.test', reason: 'must refuse', confirmed: true,
      actor: 'test', storage,
    }),
    () => liftAdminEmailSuppression({
      submissionId: 'loser', email: 'loser@example.test', liftReason: 'must refuse', confirmed: true,
      actor: 'test', storage,
    }),
    () => executeDealHunterCimFollowUpRequest({
      storage,
      request: {
        id: 'loser-cim-request', submission_id: 'loser', deal_key: 'writer-matrix-deal',
        recipient_email: 'broker@example.test', metadata: {},
      },
      now: new Date(timestamp),
      dependencies: { sendPreparedMessage: async () => { providerCalls.push('called'); } },
    }),
    () => retryDealHunterCimRequestWithCorrectedRecipient({
      requestId: 'loser-cim-request', newRecipientEmail: 'corrected@example.test', confirmed: true,
      overrideReason: 'Reviewed correction', requestedBy: 'test', storage,
    }),
  ];
  for (const invoke of cases) await assertLoserRefusal({ sqlitePath, providerCalls, invoke });
});

test('real SQLite manual CIM start entry point refuses loser-owned request authority', async (t) => {
  const { storage, sqlitePath } = await fixture(t);
  const session = { principal_id: 'admin-1', role: 'admin', username: 'test-admin' };
  await assertLoserRefusal({
    sqlitePath,
    invoke: () => startDealHunterManualFollowUps({
      opportunityId: 'opportunity', requestId: 'loser-cim-request', input: {}, session, storage,
      now: new Date(timestamp),
    }),
  });
});

test('second-connection supersession after an earlier service check is revalidated by every direct Task 6 SQLite writer', async (t) => {
  const { storage, sqlitePath } = await fixture(t, {
    withRecommendation: true,
    activateSupersession: false,
  });
  await storage.assertCrmSubmissionWritable('loser');
  activateRelation(sqlitePath);

  const cases = [
    () => storage.insertCrmActivityEvent({
      id: 'race-activity', submission_id: 'loser', opportunity_id: null, created_at: timestamp,
      actor: 'test', role: 'admin', event_type: 'race.test', summary: 'must refuse', metadata: {},
    }),
    () => storage.insertSecureUploadRequest({
      id: 'race-upload', submission_id: 'loser', created_at: timestamp, updated_at: timestamp,
      email: 'loser@example.test', contact_name: 'loser', requested_by: 'test', status: 'open',
      expires_at: '2026-09-18T18:00:00.000Z', requested_documents: [],
    }),
    () => storage.updateSecureUploadRequest('loser-upload', { updated_at: timestamp, status: 'revoked' }),
    () => storage.resetSecureUploadRequestIfUploading('loser-upload', { updated_at: timestamp, status: 'open' }),
    () => storage.claimSecureUploadRequest('loser-upload', { updated_at: timestamp, status: 'uploading' }),
    () => storage.insertSecureDocument({
      id: 'race-document', request_id: 'loser-upload', submission_id: 'loser', created_at: timestamp,
      document_type: 'other', file_name: 'race.pdf', original_name: 'race.pdf', mime_type: 'application/pdf',
      size_bytes: 1, storage_path: '/tmp/race.pdf', uploaded_by_email: null, note: null, nda_accepted_at: null,
    }),
    () => storage.deleteSecureDocument('loser-document'),
    () => storage.insertCrmCommunication({
      id: 'race-communication', submission_id: 'loser', direction: 'outbound', channel: 'note',
      source: 'writer-matrix', body_text: 'must refuse', occurred_at: timestamp, created_at: timestamp,
      updated_at: timestamp, created_by: 'test', updated_by: 'test',
    }),
    () => storage.updateCrmCommunication('loser-communication', { submission_id: null }),
    () => storage.claimCrmEmailOutbox({
      id: 'loser-outbox', claimToken: 'race-claim', claimedAt: timestamp,
      claimExpiresAt: '2026-09-17T18:05:00.000Z',
    }),
    () => storage.insertCrmFollowUpRecommendation({
      ...recommendation('loser'), id: 'race-recommendation', input_fingerprint: 'race',
    }),
    () => storage.supersedeCrmFollowUpRecommendations('loser', timestamp),
    () => storage.updateCrmFollowUpRecommendation('loser-recommendation', { status: 'dismissed' }),
    () => storage.upsertDealHunterCimRequest({
      id: 'race-cim-request', created_at: timestamp, updated_at: timestamp,
      deal_key: 'writer-matrix-race', recipient_email: 'race@example.test', submission_id: 'loser',
      status: 'pending', requested_by: 'test', deal_name: 'Canonical', source_name: 'writer-matrix',
      listing_url: '', score: 95, metadata: {},
    }),
  ];
  for (const invoke of cases) await assertLoserRefusal({ sqlitePath, invoke });
});

test('real SQLite CRM import claims refuse stale and failed cached loser ownership before bookkeeping changes', async (t) => {
  for (const status of ['failed', 'pending']) {
    const { storage, sqlitePath } = await fixture(t, { activateSupersession: false });
    const database = new Database(sqlitePath);
    const importId = `cached-loser-${status}`;
    const staleAt = status === 'pending' ? '2026-09-17T16:00:00.000Z' : timestamp;
    database.prepare(`
      INSERT INTO deal_hunter_crm_imports (
        id, created_at, updated_at, opportunity_id, deal_key, listing_identity,
        listing_url, submission_id, status, source_name, metadata
      ) VALUES (?, ?, ?, 'opportunity', ?, ?, ?, 'loser', ?, 'writer-matrix', ?)
    `).run(
      importId,
      staleAt,
      staleAt,
      `cached-loser-${status}-deal`,
      `writer-matrix:${status}`,
      `https://example.test/${status}`,
      status,
      JSON.stringify({ marker: 'unchanged' }),
    );
    database.close();
    activateRelation(sqlitePath);

    const before = rawBusinessState(sqlitePath);
    await assert.rejects(
      () => storage.claimDealHunterCrmImport({
        id: importId,
        created_at: timestamp,
        updated_at: '2026-09-17T19:00:00.000Z',
        opportunity_id: 'opportunity',
        deal_key: `cached-loser-${status}-deal`,
        listing_identity: `writer-matrix:${status}`,
        listing_url: `https://example.test/${status}`,
        submission_id: null,
        status: 'pending',
        source_name: 'writer-matrix-refresh',
        metadata: { marker: 'must-not-replace' },
      }, { pendingCutoff: '2026-09-17T17:00:00.000Z' }),
      { code: 'CRM_SUBMISSION_SUPERSEDED', submissionId: 'loser' },
    );
    assert.equal(rawBusinessState(sqlitePath), before, `${status} loser claim must not mutate any application table`);
  }
});

test('ordinary real SQLite CRM import updates protect source and distinct target ownership without reparenting losers', async (t) => {
  const { storage, sqlitePath } = await fixture(t, { activateSupersession: false });
  const database = new Database(sqlitePath);
  const insert = database.prepare(`
    INSERT INTO deal_hunter_crm_imports (
      id, created_at, updated_at, opportunity_id, deal_key, listing_identity,
      listing_url, submission_id, status, source_name, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'linked', 'writer-matrix', '{}')
  `);
  insert.run('loser-import', timestamp, timestamp, 'opportunity', 'loser-import-deal', 'writer-matrix:loser', 'https://example.test/loser', 'loser');
  insert.run('survivor-import', timestamp, timestamp, null, 'survivor-import-deal', 'writer-matrix:survivor', 'https://example.test/survivor', 'survivor');
  database.close();
  activateRelation(sqlitePath);

  for (const values of [
    { updated_at: '2026-09-17T19:00:00.000Z', metadata: { changed: true } },
    { updated_at: '2026-09-17T19:00:00.000Z', submission_id: 'survivor', status: 'linked' },
    { updated_at: '2026-09-17T19:00:00.000Z', submission_id: null, status: 'failed' },
  ]) {
    await assertLoserRefusal({
      sqlitePath,
      invoke: () => storage.updateDealHunterCrmImport('loser-import', values),
    });
  }

  await assertLoserRefusal({
    sqlitePath,
    invoke: () => storage.updateDealHunterCrmImport('survivor-import', {
      updated_at: '2026-09-17T19:00:00.000Z',
      submission_id: 'loser',
      status: 'linked',
    }),
  });

  const survivorUpdated = await storage.updateDealHunterCrmImport('survivor-import', {
    updated_at: '2026-09-17T19:00:00.000Z',
    metadata: { survivorControl: true },
  });
  assert.equal(survivorUpdated.submission_id, 'survivor');
  assert.deepEqual(survivorUpdated.metadata, { survivorControl: true });
});

test('source-field repair rejects the loser contact boundary without touching source or opportunity state', async (t) => {
  const { storage, sqlitePath } = await fixture(t);
  await assertLoserRefusal({
    sqlitePath,
    invoke: () => repairDealHunterCrmSourceFields({
      submissionId: 'loser', apply: true, actor: 'test', backupVerified: true,
      backupReference: 'writer-matrix-backup', storage,
      sourceResults: [{ source: { fetched: true }, deals: [] }],
    }),
  });
});

test('active enumeration omits the loser while retaining the eligible survivor', async (t) => {
  const { storage } = await fixture(t);
  const active = await storage.listSubmissions({ limit: 25, page: 1, status: 'all' });
  assert.deepEqual(active.rows.map((row) => row.id), ['survivor']);
  assert.equal(active.total, 1);

  const followUps = await storage.listFollowUpSubmissions({
    page: 1, pageSize: 25, view: 'all', now: timestamp,
    todayStart: timestamp, todayEnd: '2026-09-18T18:00:00.000Z',
  });
  assert.deepEqual(followUps.rows.map((row) => row.id), ['survivor']);
  assert.equal(followUps.total, 1);
  assert.equal((await storage.getSubmissionStrict('loser')).id, 'loser', 'historical strict reads remain available');
});

test('valid survivors retain writer behavior', async (t) => {
  const { storage } = await fixture(t);
  const activity = await recordCrmActivity({
    storage, submissionId: 'survivor', eventType: 'writer.control', summary: 'survivor remains writable',
  });
  assert.equal(activity.submission_id, 'survivor');
  const command = await updateAcquisitionCommandCenterRecord({
    submissionId: 'survivor', pipelineStage: 'diligence', updatedBy: 'test', storage,
  });
  assert.equal(command.ok, true);
  assert.equal(command.submission.id, 'survivor');
});

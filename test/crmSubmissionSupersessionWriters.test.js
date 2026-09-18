import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';

import { recordCrmActivity, commitCrmActivityMutation } from '../server/services/activity.js';
import { assignUnassignedCommunication, createManualCommunication } from '../server/services/communications.js';
import {
  createSecureUploadRequest,
  deleteSecureDocument,
  revokeSecureUploadRequest,
} from '../server/services/documentVault.js';
import {
  previewCrmFollowUpEmail,
  processCrmEmailOutbox,
  sendCrmFollowUpEmail,
} from '../server/services/followUpEmail.js';
import { dismissCrmFollowUpRecommendation } from '../server/services/followUpWorkspace.js';
import { createAdminEmailSuppression, liftAdminEmailSuppression } from '../server/services/followUpWorkspace.js';
import { generateCrmFollowUpRecommendation } from '../server/services/followUpRecommendations.js';
import { updateAcquisitionCommandCenterRecord } from '../server/services/acquisitionCommandCenter.js';
import {
  approveDealHunterBrokerMaterials,
  loadBrokerMaterialsAuthority,
  prepareDealHunterBrokerMaterials,
} from '../server/services/dealHunterBrokerMaterials.js';
import {
  MANUAL_FOLLOW_UP_PREPARATION_TYPE,
  approveDealHunterManualFollowUp,
  loadDealHunterManualFollowUpAuthority,
  prepareDealHunterManualFollowUp,
  startDealHunterManualFollowUps,
  stopDealHunterManualFollowUps,
} from '../server/services/dealHunterManualFollowUps.js';
import { buildManualFollowUpCommunicationId } from '../server/services/dealHunterManualFollowUpPolicy.js';
import {
  buildDealHunterCimRequestId,
  executeApprovedDealHunterCimRequest,
  executeDealHunterCimFollowUpRequest,
  executeDealOsCrmReconciliation,
  importDealOsExport,
  previewDealOsCrmReconciliation,
  repairDealHunterCrmSourceFields,
  reviewDailyDeals,
  retryDealHunterCimRequestWithCorrectedRecipient,
  sendDealHunterCimRequest,
  syncDealHunterHighFitsToCrm,
} from '../server/services/dealHunter.js';
import {
  authorizeCimStage2SendBoundary,
  buildCimStage2DecisionRecord,
  cimStage2SnapshotDigest,
  getCimStage2Policy,
} from '../server/services/cimAutomation.js';
import { getConfig } from '../server/config.js';
import { CRM_SUBMISSION_SUPERSEDED } from '../server/services/crmSubmissionSupersession.js';
import { createManualSubmission } from '../server/services/submissions.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { sha256, signPayload, stableCanonicalJson } from '../server/utils/security.js';

const matrixHttpDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-writer-http-matrix-'));
process.env.ADMIN_SESSION_SECRET = 'crm-writer-matrix-session-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'crm-writer-matrix-document-secret';
process.env.SQLITE_PATH = path.join(matrixHttpDirectory, 'http.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(matrixHttpDirectory, 'secure-documents');
process.env.DEAL_HUNTER_SHEET_CSV_URLS = 'https://example.test/writer-matrix.csv';
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_DEAL_OS_EXPORT_MAX_AGE_HOURS = '72';
process.env.DELIVERY_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 'writer-matrix-resend-key';
process.env.RESEND_FROM_EMAIL = 'Mathew Uckele <outreach@example.test>';
process.env.RESEND_REPLY_TO = 'reply@inbound.example.test';
process.env.RESEND_INBOUND_DOMAIN = 'inbound.example.test';
process.env.EMAIL_WEBHOOK_SECRET = 'writer-matrix-webhook-secret';
process.env.DEAL_HUNTER_CIM_OUTREACH_PAUSED = 'false';

const matrixSourceCsv = [
  'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Broker Name,Broker Email,Listing URL,Description',
  `"Commercial HVAC Maintenance Co","Commercial HVAC maintenance","CA","${new Date().toISOString().slice(0, 10)}","$450,000","$1,800,000","$1,400,000","Erin Broker","erin@example.test","https://broker.example.test/hvac-maintenance","Recurring maintenance contracts service agreements scheduled maintenance field technicians repair compliance trained staff management in place SBA eligible seller financing."`,
].join('\n');
let activeMatrixSourceCsv = matrixSourceCsv;
const originalFetch = globalThis.fetch;
const matrixProviderCalls = [];
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target === process.env.DEAL_HUNTER_SHEET_CSV_URLS) {
    return new Response(activeMatrixSourceCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
  }
  if (target.includes('api.airtable.com')) return Response.json({ records: [] });
  if (target === 'https://api.resend.com/emails') {
    matrixProviderCalls.push({ url: target, options });
    return Response.json({ id: `matrix-provider-${matrixProviderCalls.length}` });
  }
  return originalFetch(url, options);
};
after(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(matrixHttpDirectory, { recursive: true, force: true });
});

const { createApp } = await import('../server/app.js');
const { getStorage } = await import('../server/storage/index.js');

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

function rawBusinessSnapshot(sqlitePath) {
  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => name);
    return Object.fromEntries(tables.map((name) => [
      name,
      database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]));
  } finally {
    database.close();
  }
}

function filesystemSnapshot(root) {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        entries.push(['directory', relative, fs.statSync(entryPath).mode & 0o777]);
        visit(entryPath);
      } else {
        entries.push(['file', relative, fs.statSync(entryPath).mode & 0o777, fs.readFileSync(entryPath).toString('base64')]);
      }
    }
  };
  visit(root);
  return entries;
}

async function withHttpServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postRawJson(url, token, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Secure-Upload-Token': token },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.write(body);
    request.end();
  });
}

function singleListingCsv() {
  return [
    'Listing ID,Business Name,State,Earnings,Revenue,Asking Price,Years Established,Industry,Description,View Listing URL',
    'DOS-WRITER-1,Commercial HVAC Maintenance Co,CA,$450000,$1800000,$1400000,12,Commercial HVAC,"Recurring maintenance contracts service agreements scheduled maintenance field technicians compliance repair management in place SBA eligible seller financing",https://dealos.example/listing/DOS-WRITER-1',
  ].join('\n');
}

function stage2Config() {
  return {
    server: { origin: 'https://example.test' },
    admin: { email: 'owner@example.test' },
    delivery: {
      provider: 'resend', resendApiKey: 'configured', resendFromEmail: 'Owner <owner@example.test>',
      resendReplyTo: 'replies@example.test', resendInboundDomain: 'inbound.example.test',
      emailWebhookSecret: 'configured', fallbackRecipient: 'owner@example.test',
    },
    followUp: { emailEnabled: false, aiEnabled: false, dailyCap: 25 },
    dealHunter: {
      recipient: 'owner@example.test', sheetCsvUrls: ['https://example.test/writer-matrix.csv'], airtableEnabled: false,
      cimFollowUp: { enabled: false }, cimOutreach: { paused: false, recipientCap24Hours: 1, recipientCap30Days: 4 },
      cimAutomation: {
        stage: 2, paused: false, ruleVersion: 'cim-stage2-trusted-rules-v2',
        sourcePolicyVersion: 'cim-stage2-smb-sheet-only-v1', allowedSourceIds: ['sheet-0'],
        stage2MinimumReviews: 25, stage2MinimumEligibleCohort: 10, stage2MinimumUnchangedApprovalRate: 0.95,
        stage3MinimumReviews: 50, stage3MinimumApprovalRate: 0.9, minimumScore: 90,
        maximumProfitMultiple: 4, canaryDailyInitialCap: 1, activeDailyInitialCap: 3,
        timezone: 'America/Los_Angeles', sendWindowStart: '08:00', sendWindowEnd: '17:00', weekdaysOnly: true,
        maximumSourceAgeHours: 24, shadowFreshnessHours: 24, activationMaxAgeHours: 168,
        physicalPostalAddress: '100 Main St, Los Angeles, CA 90001',
      },
    },
  };
}

function followUpConfig() {
  return {
    admin: { sessionSecret: 'writer-matrix-follow-up-secret-at-least-32-characters' },
    brand: { companyName: 'Uckele Group' },
    delivery: {
      provider: 'resend', resendApiKey: 'configured', resendFromEmail: 'outreach@example.test',
      resendReplyTo: 'reply@inbound.example.test', resendInboundDomain: 'inbound.example.test',
      emailWebhookSecret: 'configured',
    },
    followUp: {
      emailEnabled: true, aiEnabled: false, timezone: 'America/Los_Angeles',
      sendWindowStart: '08:00', sendWindowEnd: '17:00', weekdaysOnly: true,
      dailyCap: 25, recipientRollingCap: 4, maxTouches: 3, cadenceHours: [48, 72, 96],
      senderName: 'Mathew Uckele', senderEmail: 'outreach@example.test',
      replyTo: 'reply@inbound.example.test', requireSignedPreview: false,
      physicalPostalAddress: '123 Main Street, San Diego, CA 92101',
      optOutBaseUrl: '', replyOptOutEnabled: true,
    },
  };
}

function stage2Deal(opportunityId = 'opportunity') {
  return {
    id: 'writer-stage2', opportunityId, identityStatus: 'resolved', dealKey: 'writer-matrix-deal',
    sourceId: 'sheet-0', sourceName: 'Required sheet', sourceRecords: [{ sourceId: 'sheet-0', externalId: 'writer-stage2', stableExternalId: true }],
    stableExternalId: true, name: 'Canonical', description: 'Recurring maintenance service agreements.',
    industry: 'Commercial HVAC', location: 'CA', listingUrl: 'https://example.test/canonical',
    brokerName: 'Broker', brokerEmail: 'broker@example.test', score: 95, fitScore: 95,
    annualProfit: 450000, annualRevenue: 1800000, askingPrice: 1400000, profitMultiple: 3.1,
    shouldRemove: false, actionEligibility: { highFit: true }, scoreStatus: 'high-fit',
    sourceAuthority: { healthy: true, sourceIds: ['sheet-0'] },
  };
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

async function fixture(t, { withRecommendation = false, activateSupersession = true, includeCimRequest = true } = {}) {
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
  await storage.writeDealHunterOpportunityScore({
    opportunity_id: 'opportunity', scored_at: timestamp, deal_key: 'writer-matrix-deal',
    name: 'Canonical', state: 'CA', listing_url: 'https://example.test/canonical',
    fit_score: 95, score_status: 'high-fit', confidence: 'high', completeness_score: 100,
    contradiction_count: 0, missing_evidence_count: 0, should_remove: false, high_fit: true, gate_count: 0,
    score_fingerprint: 'writer-matrix-score', semantic_digest: 'writer-matrix-semantic',
    engine_version: 'writer-matrix', rules_version: 'writer-matrix', profile_version: 'writer-matrix',
    completeness_policy_version: 'writer-matrix', dimensions: [], gates: [], applied_caps: [],
    missing_evidence: [], confidence_reasons: [], summary: {},
  }, []);
  await storage.reconcileDealHunterCurrentScoreEligibility(['opportunity']);
  await storage.upsertDealHunterCimRepairManifest({
    id: 'writer-receipt', created_at: timestamp, updated_at: timestamp, mode: 'crm-duplicate-consolidation',
    status: 'applied', actor: 'test', backup_reference: 'fixture', checksum: digest,
    manifest: { version: 1 }, metadata: {},
  });
  if (includeCimRequest) {
    await storage.upsertDealHunterCimRequest({
      id: 'loser-cim-request', created_at: timestamp, updated_at: timestamp,
      deal_key: 'writer-matrix-deal', opportunity_id: 'opportunity', recipient_email: 'broker@example.test', submission_id: 'loser',
      status: 'delivery_issue', requested_by: 'test', deal_name: 'Canonical', source_name: 'writer-matrix',
      listing_url: '', score: 95, request_state: 'failed', delivery_state: 'bounced',
      delivery_state_at: timestamp, follow_up_state: 'scheduled', next_follow_up_at: timestamp,
      metadata: { manualFollowUp: {
        version: 'deal-hunter-manual-follow-up-v1', mode: 'operator-approved', maximumFollowUps: 5,
        cadencePolicy: 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1', enrolledAt: timestamp, enrolledBy: 'test',
      } },
    });
  }
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

function forceLoserPrimary(sqlitePath) {
  const database = new Database(sqlitePath);
  try {
    database.exec('DROP TRIGGER trg_crm_submission_supersessions_guard_opportunity_update');
    database.exec('DROP TRIGGER trg_deal_hunter_opportunities_reject_superseded_primary_update');
    database.prepare(`
      UPDATE deal_hunter_opportunities SET primary_submission_id = 'loser', updated_at = ?
      WHERE opportunity_id = 'opportunity'
    `).run(timestamp);
  } finally {
    database.close();
  }
}

function signedBrokerApproval() {
  const approvalBoundPayload = { canonicalOpportunityId: 'opportunity' };
  const proposalDigest = sha256(stableCanonicalJson(approvalBoundPayload));
  const claims = {
    typ: 'deal-hunter-broker-materials-preparation', version: 1, intent: 'manual_stage_1',
    requestType: 'cim_request', administratorPrincipalId: 'admin-1', canonicalOpportunityId: 'opportunity',
    approvalBoundPayload, proposalDigest, nonce: 'writer-matrix', preparedAt: timestamp, exp: Date.now() + 60_000,
  };
  return {
    preparationToken: signPayload(claims, getConfig().admin.sessionSecret),
    approvedProposalDigest: proposalDigest,
  };
}

function signedManualFollowUpApproval() {
  const proposal = { canonicalOpportunityId: 'opportunity', requestId: 'loser-cim-request' };
  const proposalDigest = sha256(stableCanonicalJson(proposal));
  const claims = {
    typ: MANUAL_FOLLOW_UP_PREPARATION_TYPE, version: 1, administratorPrincipalId: 'admin-1',
    canonicalOpportunityId: 'opportunity', requestId: 'loser-cim-request', proposal,
    proposalDigest, nonce: 'writer-matrix', preparedAt: timestamp, exp: Date.now() + 60_000,
  };
  return {
    preparationToken: signPayload(claims, getConfig().admin.sessionSecret),
    approvedProposalDigest: proposalDigest,
  };
}

async function assertLoserRefusal({ sqlitePath, providerCalls = [], invoke }) {
  const before = rawBusinessState(sqlitePath);
  const externalProviderCount = matrixProviderCalls.length;
  await assert.rejects(invoke, { code: 'CRM_SUBMISSION_SUPERSEDED', submissionId: 'loser' });
  assert.equal(rawBusinessState(sqlitePath), before, 'loser refusal must leave every business table byte-logically unchanged');
  assert.equal(providerCalls.length, 0, 'loser refusal must occur before a provider boundary');
  assert.equal(matrixProviderCalls.length, externalProviderCount, 'loser refusal must not reach the configured external provider boundary');
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
  const filesBefore = filesystemSnapshot(process.env.SECURE_DOCUMENTS_STORAGE_DIR);
  const cases = [
    () => revokeSecureUploadRequest({ requestId: 'loser-upload', revokedBy: 'test', storage }),
    () => deleteSecureDocument({ documentId: 'loser-document', deletedBy: 'test', storage }),
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
  assert.deepEqual(filesystemSnapshot(process.env.SECURE_DOCUMENTS_STORAGE_DIR), filesBefore);
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

test('real HTTP secure upload refuses a stale loser before recovery and recovers a stale survivor only after authority validation', async () => {
  const storage = getStorage();
  const suffix = randomUUID();
  const now = new Date().toISOString();
  const survivor = createManualSubmission({
    company: `HTTP matrix survivor ${suffix}`,
    seller_name: 'Survivor',
    seller_email: `http-matrix-survivor-${suffix}@example.test`,
  }, 'writer-matrix', { storage });
  const loser = createManualSubmission({
    company: `HTTP matrix loser ${suffix}`,
    seller_name: 'Loser',
    seller_email: `http-matrix-loser-${suffix}@example.test`,
  }, 'writer-matrix', { storage });
  const [survivorResult, loserResult] = await Promise.all([survivor, loser]);
  assert.equal(survivorResult.ok, true);
  assert.equal(loserResult.ok, true);
  const opportunityId = `http-matrix-opportunity-${suffix}`;
  await storage.updateSubmission(survivorResult.submission.id, {
    updated_at: now,
    deal_hunter_opportunity_id: opportunityId,
  });
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId, created_at: now, updated_at: now,
    canonical_name: survivorResult.submission.company, canonical_recipient: survivorResult.submission.email,
    canonical_location: null, primary_submission_id: survivorResult.submission.id,
    identity_version: 'http-writer-matrix-v1', status: 'active', metadata: {},
  });
  const requestShape = { headers: { host: 'localhost' }, ip: '192.0.2.201', socket: {} };
  const loserUpload = await createSecureUploadRequest({
    submissionId: loserResult.submission.id, requestedBy: 'writer-matrix', sendEmail: false, request: requestShape,
  });
  const survivorUpload = await createSecureUploadRequest({
    submissionId: survivorResult.submission.id, requestedBy: 'writer-matrix', sendEmail: false, request: requestShape,
  });
  const loserToken = new URL(loserUpload.uploadUrl).searchParams.get('token');
  const survivorToken = new URL(survivorUpload.uploadUrl).searchParams.get('token');
  const receiptId = `http-matrix-receipt-${suffix}`;
  await storage.upsertDealHunterCimRepairManifest({
    id: receiptId, created_at: now, updated_at: now, mode: 'crm-duplicate-consolidation',
    status: 'applied', actor: 'writer-matrix', backup_reference: 'fixture', checksum: digest,
    manifest: { version: 1 }, metadata: {},
  });
  const database = new Database(process.env.SQLITE_PATH);
  const staleUploadingAt = '2026-09-17T12:00:00.000Z';
  database.prepare(`
    UPDATE secure_upload_requests
    SET status = 'uploading', updated_at = ?
    WHERE id IN (?, ?)
  `).run(staleUploadingAt, loserUpload.request.id, survivorUpload.request.id);
  database.prepare(`
    INSERT INTO crm_submission_supersessions (
      id, created_at, updated_at, status, survivor_submission_id, superseded_submission_id,
      opportunity_id, reason_code, reason_text, approved_by, approved_at, actor,
      repair_version, repair_manifest_id, repair_digest, metadata
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, 'confirmed-duplicate', 'Reviewed duplicate.',
      'owner@example.test', ?, 'writer-matrix', 'http-writer-matrix-v1', ?, ?, '{}')
  `).run(
    `http-matrix-relation-${suffix}`, now, now, survivorResult.submission.id, loserResult.submission.id,
    opportunityId, now, receiptId, digest,
  );
  database.close();

  const createBefore = rawBusinessState(process.env.SQLITE_PATH);
  const createFilesBefore = filesystemSnapshot(process.env.SECURE_DOCUMENTS_STORAGE_DIR);
  const createProviderCountBefore = matrixProviderCalls.length;
  await assert.rejects(() => createSecureUploadRequest({
    submissionId: loserResult.submission.id,
    requestedBy: 'writer-matrix',
    sendEmail: false,
    request: requestShape,
  }), {
    code: CRM_SUBMISSION_SUPERSEDED,
    submissionId: loserResult.submission.id,
  });
  assert.equal(rawBusinessState(process.env.SQLITE_PATH), createBefore);
  assert.deepEqual(filesystemSnapshot(process.env.SECURE_DOCUMENTS_STORAGE_DIR), createFilesBefore);
  assert.equal(matrixProviderCalls.length, createProviderCountBefore);

  const beforeTables = rawBusinessSnapshot(process.env.SQLITE_PATH);
  const beforeFiles = filesystemSnapshot(process.env.SECURE_DOCUMENTS_STORAGE_DIR);
  const providerCountBefore = matrixProviderCalls.length;
  await withHttpServer(async (origin) => {
    const response = await postRawJson(
      `${origin}/api/secure-documents/upload`,
      loserToken,
      '{this body must never be parsed',
    );
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(response.body), {
      success: false,
      code: CRM_SUBMISSION_SUPERSEDED,
      error: 'This CRM record is historical and cannot be changed.',
      submissionId: loserResult.submission.id,
      survivorSubmissionId: survivorResult.submission.id,
      opportunityId,
    });
  });
  assert.deepEqual(rawBusinessSnapshot(process.env.SQLITE_PATH), beforeTables);
  assert.deepEqual(filesystemSnapshot(process.env.SECURE_DOCUMENTS_STORAGE_DIR), beforeFiles);
  assert.equal(matrixProviderCalls.length, providerCountBefore);

  const survivorRequest = await createSecureUploadRequest({
    submissionId: survivorResult.submission.id,
    requestedBy: 'writer-matrix',
    sendEmail: false,
    request: requestShape,
  });
  assert.equal(survivorRequest.ok, true, JSON.stringify(survivorRequest));
  const survivorRevoked = await revokeSecureUploadRequest({
    requestId: survivorRequest.request.id,
    revokedBy: 'writer-matrix',
    storage,
  });
  assert.equal(survivorRevoked.ok, true, JSON.stringify(survivorRevoked));

  await withHttpServer(async (origin) => {
    const response = await postRawJson(
      `${origin}/api/secure-documents/upload`,
      survivorToken,
      JSON.stringify({
        ndaAccepted: true,
        documents: [{
          name: 'survivor-control.txt', mimeType: 'text/plain',
          contentBase64: Buffer.from('survivor control').toString('base64'),
        }],
      }),
    );
    assert.equal(response.status, 200, response.body);
    assert.equal(JSON.parse(response.body).submission.id, survivorResult.submission.id);
  });
});

test('real SQLite manual follow-up terminal replay returns exact stopped and finalized durable results for an active loser without mutation', async (t) => {
  const session = { principal_id: 'admin-1', role: 'admin', username: 'test-admin' };
  const dependencies = {
    getPause: async () => ({ paused: false }),
    getReadiness: async () => ({ outboundConfigured: true, issues: [] }),
    evaluateRecipientPolicy: async () => ({ allowed: true }),
    evaluateWindow: () => ({ allowed: true }),
  };

  {
    const { storage, sqlitePath } = await fixture(t, { activateSupersession: false });
    let database = new Database(sqlitePath);
    database.prepare(`
      UPDATE deal_hunter_cim_requests
      SET status = 'sent', request_state = 'provider_accepted', delivery_state = 'accepted'
      WHERE id = 'loser-cim-request'
    `).run();
    database.close();
    forceLoserPrimary(sqlitePath);
    const input = {
      opportunityId: 'opportunity', requestId: 'loser-cim-request', reason: 'Reviewed stop',
      session, storage, now: new Date(timestamp), dependencies,
    };
    const stopped = await stopDealHunterManualFollowUps(input);
    assert.equal(stopped.success, true, JSON.stringify(stopped));
    assert.equal(stopped.followUps.state, 'stopped');
    const durableStopped = await stopDealHunterManualFollowUps(input);
    assert.equal(durableStopped.success, true, JSON.stringify(durableStopped));
    assert.equal(durableStopped.followUps.terminalReason, 'manual_follow_up_stopped');
    database = new Database(sqlitePath);
    database.prepare("UPDATE deal_hunter_opportunities SET primary_submission_id = 'survivor' WHERE opportunity_id = 'opportunity'").run();
    database.close();
    activateRelation(sqlitePath);
    database = new Database(sqlitePath);
    database.prepare("UPDATE deal_hunter_opportunities SET primary_submission_id = 'loser' WHERE opportunity_id = 'opportunity'").run();
    database.close();
    const before = rawBusinessState(sqlitePath);
    const replay = await stopDealHunterManualFollowUps(input);
    assert.deepEqual(replay, durableStopped, 'already-stopped replay must return the exact durable response');
    assert.equal(rawBusinessState(sqlitePath), before);

    database = new Database(sqlitePath);
    database.prepare("UPDATE deal_hunter_cim_requests SET opportunity_id = 'reparented-opportunity' WHERE id = 'loser-cim-request'").run();
    database.close();
    const reparentedBefore = rawBusinessState(sqlitePath);
    const reparentedProviderCountBefore = matrixProviderCalls.length;
    const wrongRouteReplay = await stopDealHunterManualFollowUps(input);
    assert.deepEqual(wrongRouteReplay, {
      success: false,
      status: 404,
      code: 'request_not_found',
      error: 'The canonical CIM request does not belong to this opportunity.',
    });
    assert.equal(rawBusinessState(sqlitePath), reparentedBefore);
    assert.equal(matrixProviderCalls.length, reparentedProviderCountBefore);
  }

  {
    const { storage, sqlitePath } = await fixture(t, { activateSupersession: false });
    forceLoserPrimary(sqlitePath);
    const communicationId = buildManualFollowUpCommunicationId({
      requestId: 'loser-cim-request',
      followUpNumber: 1,
    });
    let database = new Database(sqlitePath);
    const current = database.prepare('SELECT metadata FROM deal_hunter_cim_requests WHERE id = ?').get('loser-cim-request');
    const metadata = JSON.parse(current.metadata);
    metadata.manualFollowUp = {
      ...metadata.manualFollowUp,
      currentAttempt: {
        followUpNumber: 1,
        communicationId,
        outcome: 'accepted',
        originalDueAt: timestamp,
        updatedAt: timestamp,
      },
      acceptedTouches: [{ followUpNumber: 1, communicationId, acceptedAt: timestamp }],
    };
    metadata.followUps = [{
      number: 1, attemptedAt: timestamp, acceptedAt: timestamp, status: 'accepted',
      communicationId, providerMessageId: 'provider-accepted-1', error: '',
    }];
    database.prepare(`
      UPDATE deal_hunter_cim_requests
      SET status = 'sent', request_state = 'provider_accepted', delivery_state = 'accepted',
          follow_up_count = 1, last_follow_up_at = ?, next_follow_up_at = ?,
          follow_up_state = 'scheduled', last_activity_at = ?, metadata = ?
      WHERE id = 'loser-cim-request'
    `).run(timestamp, '2026-09-21T16:00:00.000Z', timestamp, JSON.stringify(metadata));
    database.prepare(`
      INSERT INTO crm_communications (
        id, submission_id, cim_request_id, direction, channel, kind, source,
        from_address, to_addresses, reply_to_address, subject, body_text,
        body_html_sanitized, provider, provider_message_id, delivery_state,
        delivery_state_at, idempotency_key, occurred_at, created_at, updated_at,
        created_by, updated_by, metadata
      ) VALUES (?, 'loser', 'loser-cim-request', 'outbound', 'email',
        'deal-hunter-cim-follow-up', 'deal-hunter', 'owner@example.test', ?, '',
        'Follow-up', 'Durable accepted follow-up', '<p>Durable accepted follow-up</p>',
        'resend', 'provider-accepted-1', 'accepted', ?, ?, ?, ?, ?, 'test', 'test', ?)
    `).run(
      communicationId,
      JSON.stringify(['broker@example.test']),
      timestamp,
      'deal-hunter-cim-loser-cim-request-follow-up-1',
      timestamp,
      timestamp,
      timestamp,
      JSON.stringify({
        followUpNumber: 1,
        manualFollowUp: { firstProviderAcceptedAt: timestamp },
      }),
    );
    database.close();
    const providerCalls = [];
    const input = {
      opportunityId: 'opportunity', requestId: 'loser-cim-request', ...signedManualFollowUpApproval(),
      session, storage, now: new Date(timestamp), dependencies,
      executeApprovedFollowUp: async () => { providerCalls.push('called'); },
    };
    database = new Database(sqlitePath);
    database.prepare("UPDATE deal_hunter_cim_requests SET opportunity_id = 'reparented-opportunity' WHERE id = 'loser-cim-request'").run();
    database.close();
    const reparentedBefore = rawBusinessState(sqlitePath);
    const reparentedProviderCountBefore = matrixProviderCalls.length;
    const wrongRouteReconciliation = await approveDealHunterManualFollowUp(input);
    assert.deepEqual(wrongRouteReconciliation, {
      success: false,
      status: 404,
      code: 'request_not_found',
      error: 'The canonical CIM request does not belong to this opportunity.',
    });
    assert.equal(rawBusinessState(sqlitePath), reparentedBefore, 'wrong-route accepted authority must refuse before reconciliation writes');
    assert.deepEqual(providerCalls, []);
    assert.equal(matrixProviderCalls.length, reparentedProviderCountBefore);
    database = new Database(sqlitePath);
    database.prepare("UPDATE deal_hunter_cim_requests SET opportunity_id = 'opportunity' WHERE id = 'loser-cim-request'").run();
    database.close();
    const finalized = await approveDealHunterManualFollowUp(input);
    assert.equal(finalized.success, true, JSON.stringify(finalized));
    assert.equal(finalized.durableResult.followUps.followUpCount, 1);
    database = new Database(sqlitePath);
    database.prepare("UPDATE deal_hunter_opportunities SET primary_submission_id = 'survivor' WHERE opportunity_id = 'opportunity'").run();
    database.close();
    activateRelation(sqlitePath);
    database = new Database(sqlitePath);
    database.prepare("UPDATE deal_hunter_opportunities SET primary_submission_id = 'loser' WHERE opportunity_id = 'opportunity'").run();
    database.close();
    const before = rawBusinessState(sqlitePath);
    const replay = await approveDealHunterManualFollowUp(input);
    assert.deepEqual(replay, finalized, 'already-finalized replay must return the exact durable response');
    assert.equal(rawBusinessState(sqlitePath), before);
    assert.deepEqual(providerCalls, []);
  }
});

test('real SQLite Broker Materials prepare and approve refuse a drifted loser primary before execution', async (t) => {
  const session = { principal_id: 'admin-1', role: 'admin', username: 'test-admin' };
  for (const operation of ['prepare', 'approve']) {
    const { storage, sqlitePath } = await fixture(t, { includeCimRequest: false });
    forceLoserPrimary(sqlitePath);
    const authority = await loadBrokerMaterialsAuthority({ opportunityId: 'opportunity', storage, now: new Date(timestamp) });
    assert.equal(authority.submission?.id, 'loser', JSON.stringify(authority));
    const providerCalls = [];
    await assertLoserRefusal({
      sqlitePath,
      providerCalls,
      invoke: () => operation === 'prepare'
        ? prepareDealHunterBrokerMaterials({ opportunityId: 'opportunity', session, storage, now: new Date(timestamp) })
        : approveDealHunterBrokerMaterials({
          opportunityId: 'opportunity', ...signedBrokerApproval(), session, storage, now: new Date(timestamp),
        }),
    });
  }
});

test('real SQLite Broker Materials prepare and approve retain a survivor execution control', async (t) => {
  const { storage, sqlitePath } = await fixture(t, { includeCimRequest: false });
  const database = new Database(sqlitePath);
  database.prepare(`
    UPDATE deal_hunter_opportunity_scores
    SET operator_priority = 'high', reviewed_at = ?,
        reviewed_fingerprint = score_fingerprint,
        reviewed_semantic_digest = semantic_digest
    WHERE opportunity_id = 'opportunity'
  `).run(timestamp);
  database.close();
  for (const [field, value] of [
    ['broker_name', 'Survivor Broker'],
    ['broker_email', 'survivor-broker@example.test'],
    ['annual_profit', '450000'],
    ['listing_url', 'https://example.test/canonical'],
  ]) {
    await storage.upsertDealHunterOpportunitySourceObservation({
      id: `writer-matrix:${field}`,
      opportunity_id: 'opportunity',
      source_id: 'sheet-0',
      source_name: 'Required Sheet',
      source_record_id: 'writer-matrix-row',
      field,
      value,
      observed_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  for (const [id, aliasType, aliasValue, aliasKey] of [
    ['writer-matrix-deal-key-alias', 'deal-key', 'writer-matrix-deal', 'deal-key:writer-matrix-deal'],
    ['writer-matrix-listing-alias', 'listing-url', 'https://example.test/canonical', 'listing-url:https://example.test/canonical'],
  ]) {
    await storage.upsertDealHunterOpportunityAlias({
      id,
      opportunity_id: 'opportunity',
      alias_type: aliasType,
      alias_value: aliasValue,
      alias_key: aliasKey,
      source: 'writer-matrix',
      first_observed_at: timestamp,
      last_observed_at: timestamp,
      evidence_version: 'writer-matrix-v1',
      resolution_method: 'fixture',
      confidence_state: 'exact',
      resolved_by: 'writer-matrix',
      metadata: {},
    });
  }
  const session = { principal_id: 'admin-1', role: 'admin', username: 'test-admin' };
  const controlNow = new Date();
  const prepared = await prepareDealHunterBrokerMaterials({
    opportunityId: 'opportunity', session, storage, now: controlNow,
  });
  assert.equal(prepared.success, true, JSON.stringify(prepared));
  let executions = 0;
  const approved = await approveDealHunterBrokerMaterials({
    opportunityId: 'opportunity',
    preparationToken: prepared.preparationToken,
    approvedProposalDigest: prepared.proposalDigest,
    session,
    storage,
    now: controlNow,
    executeApprovedCimRequest: async (input) => {
      executions += 1;
      return executeApprovedDealHunterCimRequest(input);
    },
  });
  assert.equal(approved.success, true, JSON.stringify({ approved, score: await storage.getCurrentDealHunterOpportunityScore('opportunity') }));
  assert.equal(executions, 1);
  const storedRequest = await storage.getDealHunterCimRequestById(approved.durableResult.cimRequest.id);
  assert.equal(storedRequest.submission_id, 'survivor');

  const dependencies = {
    getPause: async () => ({ paused: false }),
    getReadiness: async () => ({ outboundConfigured: true, provider: 'resend', issues: [] }),
    evaluateRecipientPolicy: async () => ({ allowed: true }),
    evaluateWindow: () => ({ allowed: true }),
  };
  const started = await startDealHunterManualFollowUps({
    opportunityId: 'opportunity', requestId: storedRequest.id, input: {}, session, storage,
    now: controlNow, dependencies,
  });
  assert.equal(started.success, true, JSON.stringify(started));
  const followUpNow = new Date(controlNow.getTime() + 10 * 24 * 60 * 60 * 1000);
  const followUpPrepared = await prepareDealHunterManualFollowUp({
    opportunityId: 'opportunity', requestId: storedRequest.id, session, storage,
    now: followUpNow, dependencies,
  });
  assert.equal(followUpPrepared.success, true, JSON.stringify(followUpPrepared));
  const followUpApproved = await approveDealHunterManualFollowUp({
    opportunityId: 'opportunity', requestId: storedRequest.id,
    preparationToken: followUpPrepared.preparationToken,
    approvedProposalDigest: followUpPrepared.proposalDigest,
    session, storage, now: followUpNow, dependencies,
  });
  assert.equal(followUpApproved.success, true, JSON.stringify(followUpApproved));
  const stopped = await stopDealHunterManualFollowUps({
    opportunityId: 'opportunity', requestId: storedRequest.id,
    reason: 'Writer matrix survivor stop control.', session, storage,
    now: followUpNow, dependencies,
  });
  assert.equal(stopped.success, true, JSON.stringify(stopped));
});

test('real SQLite approved initial CIM execution refuses a drifted loser primary before provider or request work', async (t) => {
  const { storage, sqlitePath } = await fixture(t, { includeCimRequest: false });
  forceLoserPrimary(sqlitePath);
  const providerCalls = [];
  await assertLoserRefusal({
    sqlitePath,
    providerCalls,
    invoke: () => executeApprovedDealHunterCimRequest({
      approvedProposal: {
        canonicalOpportunityId: 'opportunity',
        recipientEmail: 'broker@example.test',
        prospectiveRequestId: buildDealHunterCimRequestId('opportunity', 'broker@example.test'),
        intent: 'manual_stage_1',
        requestType: 'cim_request',
      },
      requestedBy: 'test-admin',
      administratorPrincipalId: 'admin-1',
      storage,
    }),
  });
});

test('real SQLite manual follow-up prepare, approve, stop, and approved execution authority refuse the loser', async (t) => {
  const session = { principal_id: 'admin-1', role: 'admin', username: 'test-admin' };
  const dependencies = {
    getPause: async () => ({ paused: false }),
    getReadiness: async () => ({ outboundConfigured: true, issues: [] }),
    evaluateRecipientPolicy: async () => ({ allowed: true }),
    evaluateWindow: () => ({ allowed: true }),
  };
  const cases = [
    ['prepare', ({ storage }) => prepareDealHunterManualFollowUp({
      opportunityId: 'opportunity', requestId: 'loser-cim-request', session, storage,
      now: new Date(timestamp), dependencies,
    })],
    ['approve and approved execute boundary', ({ storage }) => approveDealHunterManualFollowUp({
      opportunityId: 'opportunity', requestId: 'loser-cim-request', ...signedManualFollowUpApproval(),
      session, storage, now: new Date(timestamp), dependencies,
    })],
    ['stop', ({ storage }) => stopDealHunterManualFollowUps({
      opportunityId: 'opportunity', requestId: 'loser-cim-request', reason: 'Reviewed stop',
      session, storage, now: new Date(timestamp), dependencies,
    })],
  ];
  for (const [name, invoke] of cases) {
    const { storage, sqlitePath } = await fixture(t);
    const providerCalls = [];
    const authority = await loadDealHunterManualFollowUpAuthority({
      opportunityId: 'opportunity', requestId: 'loser-cim-request', storage,
      now: new Date(timestamp), dependencies,
    });
    assert.equal(authority.submission?.id, 'loser');
    try {
      await assertLoserRefusal({
        sqlitePath,
        providerCalls,
        invoke: () => invoke({ storage, providerCalls }),
      });
    } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
  }
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

test('real SQLite reconciliation preview/apply refuses a cached loser before creating a run or item and retains a survivor apply control', async (t) => {
  activeMatrixSourceCsv = 'Name\nHealthy required source control';
  t.after(() => { activeMatrixSourceCsv = matrixSourceCsv; });
  for (const claimStatus of ['failed', 'pending']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `ug-writer-reconciliation-${claimStatus}-`));
    const sqlitePath = path.join(directory, 'crm.sqlite');
    const storage = createSqliteStorage({ storage: { sqlitePath } });
    t.after(() => {
      storage.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const now = new Date();
    const imported = await importDealOsExport({
      fileBuffer: Buffer.from(singleListingCsv()),
      fileName: `writer-reconciliation-${claimStatus}.csv`,
      exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      scope: 'saved-search', coverageLabel: `Writer ${claimStatus}`,
      expectedRowCount: 1, importedBy: 'admin@example.test', storage, now,
    });
    const initialPreview = await previewDealOsCrmReconciliation({
      importId: imported.import.id, requestedBy: 'admin@example.test', storage,
    });
    assert.equal(initialPreview.ok, true, JSON.stringify(initialPreview));
    const [deal] = [...initialPreview.dealsByOpportunity.values()];
    assert.ok(deal?.opportunityId);
    const survivor = await createManualSubmission({
      company: deal.name, seller_name: 'Writer Reconciliation Broker',
      seller_email: `writer-reconciliation-${claimStatus}@example.test`, listing_url: deal.listingUrl,
      asking_price: `$${Number(deal.askingPrice).toLocaleString('en-US')}`,
      ttm_revenue: `$${Number(deal.annualRevenue).toLocaleString('en-US')}`,
      ttm_ebitda: `$${Number(deal.annualProfit).toLocaleString('en-US')}`,
      status: 'review',
      metadata: { dealHunter: { managed: true, opportunityId: deal.opportunityId, dealKey: deal.dealKey } },
    }, 'writer-matrix', { storage });
    const loser = await createManualSubmission({
      company: `Unrelated writer reconciliation ${claimStatus}`,
      seller_email: `writer-reconciliation-loser-${claimStatus}@example.test`,
      listing_url: `https://example.test/writer-reconciliation-loser-${claimStatus}`,
      status: 'review', metadata: {},
    }, 'writer-matrix', { storage });
    assert.equal(survivor.ok, true);
    assert.equal(loser.ok, true);
    await storage.updateSubmission(survivor.submission.id, {
      updated_at: new Date().toISOString(), deal_hunter_opportunity_id: deal.opportunityId,
    });
    const opportunity = await storage.getDealHunterOpportunity(deal.opportunityId);
    await storage.upsertDealHunterOpportunity({
      ...opportunity, updated_at: new Date().toISOString(), primary_submission_id: survivor.submission.id,
    });
    const receiptDigest = createHash('sha256').update(`writer-reconciliation-${claimStatus}`).digest('hex');
    await storage.upsertDealHunterCimRepairManifest({
      id: `writer-reconciliation-${claimStatus}-receipt`, created_at: timestamp, updated_at: timestamp,
      mode: 'crm-duplicate-consolidation', status: 'applied', actor: 'writer-matrix', backup_reference: 'fixture',
      checksum: receiptDigest, manifest: { version: 1 }, metadata: {},
    });
    const staleAt = claimStatus === 'pending'
      ? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      : new Date().toISOString();
    let database = new Database(sqlitePath);
    database.prepare(`
      INSERT INTO deal_hunter_crm_imports (
        id, created_at, updated_at, opportunity_id, deal_key, listing_identity,
        listing_url, submission_id, status, source_name, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'deal-os', '{}')
    `).run(
      `writer-reconciliation-${claimStatus}-import`, staleAt, staleAt, deal.opportunityId, deal.dealKey,
      `writer-reconciliation:${claimStatus}`, deal.listingUrl, survivor.submission.id, claimStatus,
    );
    database.close();

    const preview = await previewDealOsCrmReconciliation({
      importId: imported.import.id, requestedBy: 'admin@example.test', storage,
    });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.items.length, 1);
    assert.equal(preview.items[0].submissionId, survivor.submission.id);
    const realAssertWritable = storage.assertCrmSubmissionWritable.bind(storage);
    let boundaryDigest = '';
    let writableChecks = 0;
    storage.assertCrmSubmissionWritable = async (...args) => {
      writableChecks += 1;
      if (writableChecks === 1) {
        database = new Database(sqlitePath);
        database.prepare(`
          UPDATE deal_hunter_crm_imports SET submission_id = ?, status = ?, updated_at = ?
          WHERE opportunity_id = ?
        `).run(loser.submission.id, claimStatus, staleAt, deal.opportunityId);
        database.prepare(`
          INSERT INTO crm_submission_supersessions (
            id, created_at, updated_at, status, survivor_submission_id, superseded_submission_id,
            opportunity_id, reason_code, reason_text, approved_by, approved_at, actor,
            repair_version, repair_manifest_id, repair_digest, metadata
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, 'confirmed-duplicate', 'Reviewed duplicate.',
            'owner@example.test', ?, 'writer-matrix', 'writer-reconciliation-v1', ?, ?, '{}')
        `).run(
          `writer-reconciliation-${claimStatus}-relation`, timestamp, timestamp,
          survivor.submission.id, loser.submission.id, deal.opportunityId, timestamp,
          `writer-reconciliation-${claimStatus}-receipt`, receiptDigest,
        );
        database.close();
        boundaryDigest = rawBusinessState(sqlitePath);
      }
      return realAssertWritable(...args);
    };
    const providerCountBefore = matrixProviderCalls.length;
    await assert.rejects(() => executeDealOsCrmReconciliation({
      importId: imported.import.id, planDigest: preview.planDigest,
      previewGeneratedAt: preview.generatedAt, expectedOpportunityIds: preview.expectedOpportunityIds,
      confirmation: preview.confirmationRequired, requestedBy: 'admin@example.test', storage,
    }), { code: CRM_SUBMISSION_SUPERSEDED, submissionId: loser.submission.id });
    assert.ok(writableChecks > 0);
    assert.equal(rawBusinessState(sqlitePath), boundaryDigest);
    assert.equal(matrixProviderCalls.length, providerCountBefore);
    database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_crm_reconciliation_runs').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_crm_reconciliation_items').get().count, 0);
    database.close();
    const activePairPreview = await previewDealOsCrmReconciliation({
      importId: imported.import.id,
      requestedBy: 'admin@example.test',
      storage,
    });
    assert.equal(activePairPreview.ok, true, JSON.stringify(activePairPreview));
    assert.deepEqual(
      activePairPreview.items.map((item) => item.submissionId),
      [survivor.submission.id],
      'active-pair reconciliation enumeration canonicalizes loser evidence to the survivor',
    );
  }

  const survivorDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-writer-reconciliation-survivor-'));
  const survivorPath = path.join(survivorDirectory, 'crm.sqlite');
  const survivorStorage = createSqliteStorage({ storage: { sqlitePath: survivorPath } });
  t.after(() => {
    survivorStorage.close();
    fs.rmSync(survivorDirectory, { recursive: true, force: true });
  });
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(singleListingCsv()), fileName: 'writer-reconciliation-survivor.csv',
    exportedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), scope: 'saved-search',
    coverageLabel: 'Writer survivor', expectedRowCount: 1, importedBy: 'admin@example.test',
    storage: survivorStorage,
  });
  const preview = await previewDealOsCrmReconciliation({
    importId: imported.import.id, requestedBy: 'admin@example.test', storage: survivorStorage,
  });
  assert.equal(preview.ok, true);
  const applied = await executeDealOsCrmReconciliation({
    importId: imported.import.id, planDigest: preview.planDigest,
    previewGeneratedAt: preview.generatedAt, expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired, requestedBy: 'admin@example.test', storage: survivorStorage,
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.resultCounts.failed, 0);
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

test('real SQLite high-fit sync refuses a cached loser claim with no business/provider effects and retains a survivor apply control', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-writer-high-fit-'));
  const sqlitePath = path.join(directory, 'crm.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const reviewed = await reviewDailyDeals({ storage });
  const deal = reviewed.qualified.find((candidate) => candidate.opportunityId);
  assert.ok(deal?.opportunityId, JSON.stringify(reviewed));
  const survivor = await createManualSubmission({
    company: deal.name, seller_name: 'High Fit Broker', seller_email: 'writer-high-fit@example.test',
    listing_url: deal.listingUrl, asking_price: `$${Number(deal.askingPrice).toLocaleString('en-US')}`,
    ttm_revenue: `$${Number(deal.annualRevenue).toLocaleString('en-US')}`,
    ttm_ebitda: `$${Number(deal.annualProfit).toLocaleString('en-US')}`, status: 'review',
    metadata: { dealHunter: { managed: true, opportunityId: deal.opportunityId, dealKey: deal.dealKey } },
  }, 'writer-matrix', { storage });
  const loser = await createManualSubmission({
    company: 'Unrelated high-fit history', seller_email: 'writer-high-fit-loser@example.test',
    listing_url: 'https://example.test/writer-high-fit-loser', status: 'review', metadata: {},
  }, 'writer-matrix', { storage });
  assert.equal(survivor.ok, true);
  assert.equal(loser.ok, true);
  await storage.updateSubmission(survivor.submission.id, {
    updated_at: new Date().toISOString(), deal_hunter_opportunity_id: deal.opportunityId,
  });
  await storage.upsertDealHunterOpportunity({
    opportunity_id: deal.opportunityId, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    canonical_name: deal.name, canonical_recipient: deal.brokerEmail || null, canonical_location: deal.location || null,
    primary_submission_id: survivor.submission.id, identity_version: 'writer-high-fit-v1', status: 'active', metadata: {},
  });
  const receiptDigest = createHash('sha256').update('writer-high-fit').digest('hex');
  await storage.upsertDealHunterCimRepairManifest({
    id: 'writer-high-fit-receipt', created_at: timestamp, updated_at: timestamp,
    mode: 'crm-duplicate-consolidation', status: 'applied', actor: 'writer-matrix', backup_reference: 'fixture',
    checksum: receiptDigest, manifest: { version: 1 }, metadata: {},
  });
  const staleAt = new Date().toISOString();
  let database = new Database(sqlitePath);
  database.prepare(`
    INSERT INTO deal_hunter_crm_imports (
      id, created_at, updated_at, opportunity_id, deal_key, listing_identity,
      listing_url, submission_id, status, source_name, metadata
    ) VALUES ('writer-high-fit-import', ?, ?, ?, ?, 'writer-high-fit', ?, ?, 'failed', 'required-sheet', '{}')
  `).run(staleAt, staleAt, deal.opportunityId, deal.dealKey, deal.listingUrl, survivor.submission.id);
  database.close();

  const survivorControl = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys: reviewed.qualified.map((candidate) => candidate.dealKey),
    requestedBy: 'writer-matrix', storage,
  });
  assert.equal(survivorControl.ok, true, JSON.stringify(survivorControl));
  assert.equal(
    survivorControl.crmSync.created + survivorControl.crmSync.enriched + survivorControl.crmSync.updated,
    1,
  );
  database = new Database(sqlitePath);
  database.prepare(`
    UPDATE deal_hunter_crm_imports SET submission_id = ?, status = 'failed', updated_at = ?
    WHERE opportunity_id = ?
  `).run(survivor.submission.id, staleAt, deal.opportunityId);
  database.close();

  const providerCountBefore = matrixProviderCalls.length;
  const realClaim = storage.claimDealHunterCrmImport.bind(storage);
  let boundaryDigest = '';
  let claimCalls = 0;
  storage.claimDealHunterCrmImport = async (...args) => {
    claimCalls += 1;
    database = new Database(sqlitePath);
    database.prepare(`
      UPDATE deal_hunter_crm_imports SET submission_id = ?, status = 'failed', updated_at = ?
      WHERE opportunity_id = ?
    `).run(loser.submission.id, staleAt, deal.opportunityId);
    database.prepare(`
      INSERT INTO crm_submission_supersessions (
        id, created_at, updated_at, status, survivor_submission_id, superseded_submission_id,
        opportunity_id, reason_code, reason_text, approved_by, approved_at, actor,
        repair_version, repair_manifest_id, repair_digest, metadata
      ) VALUES ('writer-high-fit-relation', ?, ?, 'active', ?, ?, ?, 'confirmed-duplicate',
        'Reviewed duplicate.', 'owner@example.test', ?, 'writer-matrix', 'writer-high-fit-v1',
        'writer-high-fit-receipt', ?, '{}')
    `).run(timestamp, timestamp, survivor.submission.id, loser.submission.id, deal.opportunityId, timestamp, receiptDigest);
    database.close();
    boundaryDigest = rawBusinessState(sqlitePath);
    return realClaim(...args);
  };
  const refused = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys: reviewed.qualified.map((candidate) => candidate.dealKey),
    requestedBy: 'writer-matrix', storage,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.crmSync.created, 0);
  assert.equal(refused.crmSync.enriched, 0);
  assert.equal(refused.crmSync.updated, 0);
  assert.equal(refused.crmSync.failed, 1);
  assert.equal(claimCalls, 1);
  assert.equal(rawBusinessState(sqlitePath), boundaryDigest);
  assert.equal(matrixProviderCalls.length, providerCountBefore);
  const activePairReview = await reviewDailyDeals({ storage });
  assert.equal(
    activePairReview.qualified.filter((candidate) => candidate.dealKey === deal.dealKey).length,
    1,
    'active-pair high-fit enumeration retains the canonical deal exactly once',
  );

  const directDeal = reviewed.qualified.find((candidate) => candidate.dealKey === deal.dealKey);
  assert.ok(directDeal?.cimRequest?.snapshotToken, JSON.stringify(directDeal));
  forceLoserPrimary(sqlitePath);
  database = new Database(sqlitePath);
  database.prepare(`
    UPDATE deal_hunter_opportunities SET primary_submission_id = ?, updated_at = ?
    WHERE opportunity_id = ?
  `).run(loser.submission.id, new Date().toISOString(), deal.opportunityId);
  database.close();
  const driftedBefore = rawBusinessSnapshot(sqlitePath);
  const driftedDigestBefore = rawBusinessState(sqlitePath);
  const driftedProviderCountBefore = matrixProviderCalls.length;
  const drifted = await sendDealHunterCimRequest({
    dealKey: directDeal.dealKey,
    snapshotToken: directDeal.cimRequest.snapshotToken,
    requestedBy: 'writer-matrix',
    storage,
  });
  assert.equal(drifted.ok, false, JSON.stringify(drifted));
  assert.equal(drifted.status, 409, JSON.stringify(drifted));
  assert.equal(drifted.code, CRM_SUBMISSION_SUPERSEDED, JSON.stringify(drifted));
  assert.deepEqual(drifted.candidateIds, []);
  assert.deepEqual(drifted.evidenceCategories, []);
  assert.equal(rawBusinessState(sqlitePath), driftedDigestBefore);
  assert.deepEqual(rawBusinessSnapshot(sqlitePath), driftedBefore);
  assert.equal(matrixProviderCalls.length, driftedProviderCountBefore);
  database = new Database(sqlitePath);
  database.prepare(`
    UPDATE deal_hunter_opportunities SET primary_submission_id = ?, updated_at = ?
    WHERE opportunity_id = ?
  `).run(survivor.submission.id, new Date().toISOString(), deal.opportunityId);
  database.close();

  const directSurvivor = await sendDealHunterCimRequest({
    dealKey: directDeal.dealKey,
    snapshotToken: directDeal.cimRequest.snapshotToken,
    requestedBy: 'writer-matrix',
    storage,
  });
  assert.equal(directSurvivor.request?.submission_id, survivor.submission.id, JSON.stringify(directSurvivor));
  database = new Database(sqlitePath);
  database.prepare(`
    UPDATE deal_hunter_cim_requests
    SET status = 'delivery_issue', request_state = 'failed', delivery_state = 'bounced',
        delivery_error = 'Reviewed invalid recipient', updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), directSurvivor.request.id);
  database.close();
  const corrected = await retryDealHunterCimRequestWithCorrectedRecipient({
    requestId: directSurvivor.request.id,
    newRecipientEmail: 'corrected-survivor@example.test',
    confirmed: true,
    overrideReason: 'Writer matrix survivor correction.',
    requestedBy: 'writer-matrix',
    storage,
  });
  assert.equal(corrected.request?.submission_id, survivor.submission.id, JSON.stringify(corrected));

  const repaired = await repairDealHunterCrmSourceFields({
    submissionId: survivor.submission.id,
    apply: true,
    actor: 'writer-matrix',
    backupVerified: true,
    backupReference: 'disposable-writer-matrix-backup',
    storage,
    sourceResults: [{
      source: { id: deal.sourceId || 'sheet-0', fetched: true },
      deals: [deal],
    }],
  });
  assert.equal(repaired.applied, true, JSON.stringify(repaired));
});

test('real SQLite Stage 2 final send authorization refuses a drifted loser primary and retains a survivor authorization control', async (t) => {
  const { storage, sqlitePath } = await fixture(t, { includeCimRequest: false, activateSupersession: false });
  const config = stage2Config();
  const policy = getCimStage2Policy(config);
  const deal = stage2Deal();
  const activationId = 'writer-stage2-activation';
  const runId = 'writer-stage2-run';
  const claimToken = 'writer-stage2-claim';
  await storage.createCimStage2Activation({
    id: activationId, created_at: timestamp, updated_at: timestamp, mode: 'canary', actor: 'release-owner',
    reason: 'Writer matrix final Stage 2 authorization fixture.', confirmation_phrase: 'ACTIVATE CIM STAGE 2 CANARY',
    policy_hash: policy.policyHash, rule_version: policy.rules.version,
    source_policy_version: policy.sourcePolicy.version, source_policy_hash: policy.sourcePolicyHash,
    evidence_checksum: '1'.repeat(64), evidence_generated_at: timestamp,
    backup_reference: 'writer-matrix-backup', backup_checksum: '2'.repeat(64),
    identity_audit_reference: 'writer-matrix-identity', identity_audit_checksum: '3'.repeat(64),
    compliance_reference: 'writer-matrix-compliance', sender_auth_reference: 'writer-matrix-sender',
    timezone: policy.window.timezone, window_start: policy.window.start, window_end: policy.window.end,
    weekdays_only: true, canary_daily_cap: 1, active_daily_cap: 3,
    recipient_cap_24_hours: 1, recipient_cap_30_days: 4,
    expires_at: '2026-07-20T16:00:00.000Z', metadata: { automaticTransmissionAuthorized: true },
  });
  const run = (await storage.claimCimStage2Run({
    id: runId, run_key: 'writer-stage2-run-key', created_at: timestamp,
    pacific_business_date: '2026-07-13', mode: 'canary', status: 'running', triggered_by: 'writer-matrix',
    policy_hash: policy.policyHash, rule_version: policy.rules.version,
    source_policy_hash: policy.sourcePolicyHash, activation_id: activationId, metadata: {},
  })).run;
  const decisionRecord = buildCimStage2DecisionRecord({
    run, deal, evaluation: { reasonCodes: [] }, activationId, policy,
  });
  await storage.insertCimStage2Decisions([decisionRecord]);
  const claimed = await storage.claimCimStage2Decision({
    id: decisionRecord.id, claimToken, claimedAt: timestamp, activationId,
  });
  assert.equal(claimed.claimed, true);
  assert.equal((await storage.transitionCimStage2Decision({
    id: decisionRecord.id, expectedStates: ['claimed'], state: 'attempting', updates: { updated_at: timestamp },
  })).applied, true);
  const statusCheck = async () => ({
    configuredStage: 2, evidenceStage: 2, effectiveStage: 2, activationMode: 'canary',
    automaticTransmissionAllowed: true, blockerCodes: [], capacity: { used: 0, limit: 1, remaining: 1 },
  });
  const authorize = () => authorizeCimStage2SendBoundary({
    decisionId: decisionRecord.id, runId, activationId, claimToken, deal,
    snapshotDigest: cimStage2SnapshotDigest(deal), storage, config,
    now: new Date(timestamp), statusCheck,
  });
  assert.equal((await authorize()).ok, true, 'unchanged survivor primary reaches the final send authorization boundary');

  activateRelation(sqlitePath);
  forceLoserPrimary(sqlitePath);
  const providerCountBefore = matrixProviderCalls.length;
  const before = rawBusinessState(sqlitePath);
  const refused = await authorize();
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'opportunity_primary_superseded');
  assert.equal(rawBusinessState(sqlitePath), before);
  assert.equal(matrixProviderCalls.length, providerCountBefore);
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

test('recommendation, Broker/CIM, reconciliation, high-fit, and Stage 2 candidate enumerations omit the loser and retain the survivor', async (t) => {
  const { storage } = await fixture(t, { withRecommendation: true });
  await storage.insertCrmFollowUpRecommendation(recommendation('survivor'));
  const active = await storage.listSubmissions({ limit: 25, page: 1, status: 'all' });
  assert.deepEqual(active.rows.map((row) => row.id), ['survivor']);
  assert.equal(active.total, 1);

  const followUps = await storage.listFollowUpSubmissions({
    page: 1, pageSize: 25, view: 'all', now: timestamp,
    todayStart: timestamp, todayEnd: '2026-09-18T18:00:00.000Z',
  });
  assert.deepEqual(followUps.rows.map((row) => row.id), ['survivor']);
  assert.equal(followUps.total, 1);
  assert.equal(followUps.rows[0].follow_up_recommendation_action, 'review');

  const brokerAuthority = await loadBrokerMaterialsAuthority({
    opportunityId: 'opportunity', storage, now: new Date(timestamp),
  });
  assert.equal(brokerAuthority.submission.id, 'survivor', 'Broker/CIM authority retains the valid survivor');
  const stage2Authority = await storage.getCimStage2SubmissionAuthority('opportunity');
  assert.equal(stage2Authority.opportunity.opportunity_id, 'opportunity');
  assert.equal(stage2Authority.primarySubmissionWritable, true, 'Stage 2 candidate keeps the survivor primary eligible');
  assert.equal((await storage.getSubmissionStrict('loser')).id, 'loser', 'historical strict reads remain available');
});

test('valid survivors retain activity, Command Center, communication, follow-up, recommendation, and secure-document writer behavior', async (t) => {
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

  const communication = await createManualCommunication({
    submissionId: 'survivor', actor: 'writer-matrix', storage,
    input: { channel: 'note', direction: 'outbound', occurredAt: timestamp, bodyText: 'Survivor control.' },
  });
  assert.equal(communication.ok, true, JSON.stringify(communication));
  const assigned = await assignUnassignedCommunication({
    communicationId: 'unassigned-communication', submissionId: 'survivor', actor: 'writer-matrix', storage,
  });
  assert.equal(assigned.ok, true, JSON.stringify(assigned));

  const config = followUpConfig();
  const emailInput = {
    clientRequestToken: 'writer-matrix-survivor-token',
    expectedSubmissionVersion: (await storage.getSubmission('survivor')).updated_at,
    recipient: 'survivor@example.test',
    subject: 'Survivor control next step',
    bodyText: 'Thank you. Could we review the opportunity next week?',
    nextFollowUpState: 'waiting-on-owner',
    nextActionAt: '2026-09-21T18:00:00.000Z',
  };
  const preview = await previewCrmFollowUpEmail({
    submissionId: 'survivor', actor: 'writer-matrix', input: emailInput,
    storage, config, now: new Date(timestamp),
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const emailProviderCalls = [];
  const queued = await sendCrmFollowUpEmail({
    submissionId: 'survivor', actor: 'writer-matrix', input: emailInput,
    storage, config, now: new Date(timestamp), processImmediately: false,
  });
  assert.equal(queued.ok, true, JSON.stringify(queued));
  const sent = await processCrmEmailOutbox({
    outboxId: queued.outbox.id, storage, config, now: new Date(timestamp),
    sender: async () => {
      emailProviderCalls.push('called');
      return { status: 'sent', providerMessageId: 'writer-matrix-survivor-provider', error: '' };
    },
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.deepEqual(emailProviderCalls, ['called']);

  const generated = await generateCrmFollowUpRecommendation({
    submissionId: 'survivor', storage,
    config: { followUp: { aiEnabled: false, timezone: 'America/Los_Angeles' } },
    now: new Date(timestamp),
  });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  const currentSurvivor = await storage.getSubmission('survivor');
  const dismissed = await dismissCrmFollowUpRecommendation({
    submissionId: 'survivor', recommendationId: generated.recommendation.id,
    expectedSubmissionVersion: currentSurvivor.updated_at, actor: 'writer-matrix', storage,
  });
  assert.equal(dismissed.ok, true, JSON.stringify(dismissed));

  const secureRoot = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const survivorDocumentDirectory = path.join(secureRoot, `writer-matrix-${randomUUID()}`);
  const survivorDocumentPath = path.join(survivorDocumentDirectory, 'survivor-document.txt');
  fs.mkdirSync(survivorDocumentDirectory, { recursive: true });
  fs.writeFileSync(survivorDocumentPath, 'survivor document');
  t.after(() => fs.rmSync(survivorDocumentDirectory, { recursive: true, force: true }));
  await storage.insertSecureUploadRequest({
    id: 'survivor-delete-upload', submission_id: 'survivor', created_at: timestamp, updated_at: timestamp,
    email: 'survivor@example.test', contact_name: 'survivor', requested_by: 'writer-matrix',
    status: 'open', expires_at: '2026-09-18T18:00:00.000Z', nda_required: true,
    nda_accepted_at: null, last_uploaded_at: null, note: '', requested_documents: [],
    revoked_at: null, closed_at: null, upload_batch_count: 0,
  });
  await storage.insertSecureDocument({
    id: 'survivor-delete-document', request_id: 'survivor-delete-upload', submission_id: 'survivor',
    created_at: timestamp, document_type: 'other', file_name: 'survivor-document.txt',
    original_name: 'survivor-document.txt', mime_type: 'text/plain', size_bytes: 17,
    storage_path: survivorDocumentPath, uploaded_by_email: null, note: null, nda_accepted_at: null,
  });
  const deleted = await deleteSecureDocument({
    documentId: 'survivor-delete-document', deletedBy: 'writer-matrix', storage,
  });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(fs.existsSync(survivorDocumentPath), false);
});

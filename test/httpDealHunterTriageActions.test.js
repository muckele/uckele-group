import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-triage-actions-'));
process.env.ADMIN_SESSION_SECRET = 'http-triage-actions-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'http-triage-actions-document-secret';
process.env.ADMIN_VIEWER_USERNAME = 'triage-viewer';
process.env.ADMIN_VIEWER_PASSWORD = 'triage-viewer-password';
process.env.SQLITE_PATH = path.join(tempDir, 'triage-actions.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'daily-digest-source-health.json');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const sourceCheckedAt = new Date().toISOString();
fs.writeFileSync(process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH, JSON.stringify({
  generatedAt: sourceCheckedAt,
  issues: [],
  totals: { reviewedDeals: 1 },
  sources: {
    'sheet-0': {
      rowCount: 1,
      name: 'SMB Deal Hunter Google Sheet',
      mode: 'csv',
      required: true,
      sourceRole: 'required-primary',
      checkedAt: sourceCheckedAt,
    },
    'deal-os-export': {
      rowCount: 1,
      name: 'SMB Deal OS export',
      mode: 'manual-export',
      required: false,
      sourceRole: 'optional-supplemental',
      checkedAt: sourceCheckedAt,
      exportedAt: sourceCheckedAt,
      maxAgeHours: 72,
    },
  },
}));

const { createApp } = await import('../server/app.js');
const { getConfig } = await import('../server/config.js');
const { getStorage } = await import('../server/storage/index.js');
const { createManualSubmission } = await import('../server/services/submissions.js');
const { sha256, verifySignedPayload } = await import('../server/utils/security.js');
let loginSequence = 0;
const authenticatedCookies = new Map();

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function seedCurrentOpportunity(
  opportunityId = 'opp-http-triage-actions',
  primarySubmissionId = null,
  dealKey = `deal-${opportunityId}`,
) {
  const storage = getStorage();
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId, created_at: '2026-08-30T09:00:00.000Z', updated_at: '2026-08-30T09:00:00.000Z',
    canonical_name: 'HTTP Action Opportunity', canonical_recipient: null, canonical_location: 'Dallas, TX',
    primary_submission_id: primarySubmissionId, identity_version: 'http-triage-actions', status: 'active', metadata: {},
  });
  await storage.writeDealHunterOpportunityScore({
    opportunity_id: opportunityId, scored_at: '2026-08-30T10:00:00.000Z', deal_key: dealKey,
    name: 'HTTP Action Opportunity', state: 'TX', listing_url: 'https://broker.example/http-triage-actions',
    fit_score: 72, score_status: 'watchlist', confidence: 'medium', completeness_score: 70,
    contradiction_count: 0, missing_evidence_count: 1, should_remove: false, high_fit: false, gate_count: 0,
    score_fingerprint: 'http-action-fingerprint', semantic_digest: 'http-action-digest', engine_version: 'http-test',
    rules_version: 'http-test', profile_version: 'http-test', completeness_policy_version: 'http-test',
    dimensions: [], gates: [], applied_caps: [], missing_evidence: [], confidence_reasons: [], summary: {},
  }, []);
  await storage.reconcileDealHunterCurrentScoreEligibility([opportunityId]);
  return { storage, opportunityId };
}

function ownerActionPayload(action, extra = {}) {
  return { action, idempotencyKey: randomUUID(), expectedDiscoveryRevision: 0,
    expectedMaterialRevision: 0, ...extra };
}

function seedP8aReleaseCampaign(opportunityId) {
  const database = new Database(process.env.SQLITE_PATH);
  const at = '2026-10-01T15:00:00.000Z';
  const ids = {
    decisionId: `decision-${opportunityId}`,
    enrollmentId: `enrollment-${opportunityId}`,
    conversationId: `conversation-${opportunityId}`,
    campaignId: `campaign-${opportunityId}`,
    touchId: `touch-${opportunityId}`,
  };
  try {
    database.prepare(`INSERT INTO deal_hunter_owner_decision_events (
      id, idempotency_key, request_digest, opportunity_id, action, actor,
      expected_discovery_revision, expected_material_revision,
      observed_discovery_revision, observed_material_revision, policy_version, created_at
    ) VALUES (?, ?, ?, ?, 'pursue', 'release-owner', 0, 0, 0, 0, 'owner-decision-v1', ?)`)
      .run(ids.decisionId, `key-${opportunityId}`, '1'.repeat(64), opportunityId, at);
    database.prepare(`INSERT INTO deal_hunter_pursuit_enrollments (
      id, decision_event_id, opportunity_id, state, authority_digest, created_at, updated_at
    ) VALUES (?, ?, ?, 'campaign-created', ?, ?, ?)`)
      .run(ids.enrollmentId, ids.decisionId, opportunityId, '2'.repeat(64), at, at);
    database.prepare(`INSERT INTO deal_hunter_opportunity_timezone_revisions (
      opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
      evidence_digest, resolver_version, dataset_digest, actor, created_at
    ) VALUES (?, 1, 'verified', 'America/Chicago', 'operator-verified',
      'p8a-http-timezone', ?, 'explicit-v1', ?, 'release-owner', ?)`)
      .run(opportunityId, '3'.repeat(64), '4'.repeat(64), at);
    database.prepare(`INSERT INTO deal_hunter_broker_conversations (
      id, recipient_authority_id, recipient_fingerprint, recipient_address,
      sender_policy_version, reply_policy_version, reply_alias_token_digest,
      rfc_thread_key, state, batching_policy_version, created_at, updated_at
    ) VALUES (?, 'recipient-p8a-http', ?, 'broker@example.test',
      'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', ?, ?,
      'open', 'batching-off-v1', ?, ?)`)
      .run(ids.conversationId, '5'.repeat(64), '6'.repeat(64),
        `thread-${opportunityId}`, at, at);
    database.prepare(`INSERT INTO deal_hunter_cim_campaigns (
      id, opportunity_id, generation, enrollment_id, decision_event_id,
      policy_version, template_version, template_digest, permission_version,
      permission_digest, permission_revision, permission_scope, canonical_revision,
      crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
      freshness_authority_digest, discovery_revision, material_revision,
      timezone_revision, conversation_id, state, reason_code, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, 'deal-hunter-cim-autopilot-v1',
      'deal-hunter-cim-autopilot-v1', ?, 'activation-p8a-http', ?, 1,
      'cohort-p8a-http', 0, 0, 'recipient-p8a-http', ?, ?, 0, 0, 1, ?,
      'initial-pending', 'awaiting_window', ?, ?)`)
      .run(ids.campaignId, opportunityId, ids.enrollmentId, ids.decisionId,
        '7'.repeat(64), '8'.repeat(64), '5'.repeat(64), '9'.repeat(64),
        ids.conversationId, at, at);
    database.prepare(`INSERT INTO deal_hunter_cim_campaign_touches (
      id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at,
      due_local, timezone_revision, state, created_at, updated_at
    ) VALUES (?, ?, ?, 'initial', 'initial', 0, ?,
      '2026-10-01T10:00:00-05:00', 1, 'scheduled', ?, ?)`)
      .run(ids.touchId, ids.campaignId, opportunityId, at, at, at);
  } finally { database.close(); }
  return ids;
}

async function linkCanonicalDealKey(storage, { opportunityId, dealKey }) {
  const observedAt = '2026-08-30T09:30:00.000Z';
  return storage.upsertDealHunterOpportunityAlias({
    id: `alias-${opportunityId}`,
    opportunity_id: opportunityId,
    alias_type: 'deal-key',
    alias_value: dealKey,
    alias_key: `deal-key:${dealKey}`,
    source: 'http-triage-actions-test',
    first_observed_at: observedAt,
    last_observed_at: observedAt,
    evidence_version: 'http-triage-actions-v1',
    resolution_method: 'exact-deal-key',
    confidence_state: 'exact',
    resolved_by: 'test',
    metadata: {},
  });
}

async function supersedeOpportunity(storage, opportunityId) {
  const current = await storage.getDealHunterOpportunity(opportunityId);
  await storage.upsertDealHunterOpportunity({
    ...current,
    status: 'superseded',
    updated_at: '2026-08-30T11:00:00.000Z',
  });
  await storage.reconcileDealHunterCurrentScoreEligibility([opportunityId]);
}

async function seedCimAuthority(storage, {
  id,
  dealKey,
  opportunityId,
  submissionId = null,
  recipientEmail,
  updatedAt = '2026-08-30T10:30:00.000Z',
}) {
  return storage.upsertDealHunterCimRequest({
    id,
    created_at: updatedAt,
    updated_at: updatedAt,
    opportunity_id: opportunityId,
    submission_id: submissionId,
    deal_key: dealKey,
    recipient_email: recipientEmail,
    requested_by: 'triage-admin',
    status: 'sent',
    provider_message_id: `${id}-provider-message`,
    subject: `CIM / NDA request for ${dealKey}`,
    deal_name: 'HTTP Authority Opportunity',
    source_name: 'test',
    listing_url: 'https://broker.example/http-authority',
    score: 72,
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'not-scheduled',
    first_requested_at: updatedAt,
    follow_up_count: 0,
    metadata: {},
  });
}

async function login(origin, username, password) {
  if (authenticatedCookies.has(username)) return authenticatedCookies.get(username);
  loginSequence += 1;
  const response = await fetch(`${origin}/api/admin/session`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json',
      'X-Real-IP': `198.51.100.${20 + loginSequence}`,
    }, body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  authenticatedCookies.set(username, cookie);
  return cookie;
}

test.after(() => {
  getStorage().close?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Pass rejects non-primitive action and every invalid reason or note before either dismissal or review', async () => {
  const { storage, opportunityId } = await seedCurrentOpportunity('opp-http-triage-invalid-pass');
  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const actionPath = `${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/action`;
    const invalid = [
      { action: { value: 'pass' } }, { action: ['pass'] }, { action: true },
      { action: 'pass', reason: {} }, { action: 'pass', reason: [] }, { action: 'pass', reason: true },
      { action: 'pass', reason: '   ' }, { action: 'pass', reason: 'x'.repeat(81) }, { action: 'pass' },
      { action: 'pass', reason: 'not-a-fit', note: {} }, { action: 'pass', reason: 'not-a-fit', note: [] },
      { action: 'pass', reason: 'not-a-fit', note: true }, { action: 'pass', reason: 'not-a-fit', note: 'x'.repeat(2001) },
    ];
    for (const body of invalid) {
      const response = await fetch(actionPath, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify(body) });
      assert.equal(response.status, 400, JSON.stringify(body));
      const score = await storage.getDealHunterOpportunityScore(opportunityId);
      assert.equal(score.reviewed_at, null, JSON.stringify(body));
      assert.equal(score.reviewed_by, null, JSON.stringify(body));
      assert.equal(score.reviewed_fingerprint, null, JSON.stringify(body));
      assert.equal(score.reviewed_semantic_digest, null, JSON.stringify(body));
      assert.equal((await storage.listDealHunterDispositions({ dealKeys: [`deal-${opportunityId}`], limit: 20 })).length, 0, JSON.stringify(body));
    }
  });
});

test('P3 protected timezone revision API is idempotent, revision-bound, and never exposes resolver authority', async () => {
  const { opportunityId } = await seedCurrentOpportunity('opp-http-p3-timezone');
  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const viewerCookie = await login(origin, 'triage-viewer', 'triage-viewer-password');
    const url = `${origin}/api/admin/deal-hunter/triage/${opportunityId}/timezone`;
    const payload = { ianaTimezone: 'America/Phoenix', evidenceId: 'owner-checked-location',
      expectedPriorRevision: 0, idempotencyKey: 'ad953b1f-e128-408f-8265-2e49a16ba43c' };
    const post = (body, cookie = adminCookie, headers = {}) => fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: JSON.stringify(body) });
    assert.equal((await post(payload, viewerCookie)).status, 401);
    assert.equal((await post(payload, adminCookie, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ ...payload, state: 'derived' })).status, 400);
    const first = await post(payload);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.timezone.revision, 1);
    assert.equal(firstBody.timezone.ianaTimezone, 'America/Phoenix');
    assert.equal(JSON.stringify(firstBody).includes('evidenceDigest'), false);
    const replay = await post(payload);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replay, true);
    assert.equal((await post({ ...payload, idempotencyKey: 'ab0c5d65-fce1-4555-a4a6-032e0439fdcc' })).status, 409);
    const corrected = await post({ ...payload, ianaTimezone: 'America/New_York',
      expectedPriorRevision: 1, idempotencyKey: 'ff532d60-3c18-43c9-a52b-30e2da084a0b' });
    assert.equal(corrected.status, 200);
    assert.equal((await corrected.json()).timezone.revision, 2);
    const supersessionDatabase = new Database(process.env.SQLITE_PATH);
    supersessionDatabase.prepare("UPDATE deal_hunter_opportunities SET status = 'superseded' WHERE opportunity_id = ?")
      .run(opportunityId);
    supersessionDatabase.close();
    assert.equal((await post({ ...payload, ianaTimezone: 'America/New_York',
      expectedPriorRevision: 1, idempotencyKey: 'ff532d60-3c18-43c9-a52b-30e2da084a0b' })).status, 200);
    assert.equal((await post({ ...payload, expectedPriorRevision: 2,
      idempotencyKey: '41d8923e-4baf-46f4-9e02-992ca8bdf95a' })).status, 409);
    const database = new Database(process.env.SQLITE_PATH);
    try {
      const revisions = database.prepare(`SELECT revision, iana_timezone, evidence_digest FROM
        deal_hunter_opportunity_timezone_revisions WHERE opportunity_id = ? ORDER BY revision`).all(opportunityId);
      assert.deepEqual(revisions.map(({ revision, iana_timezone: zone }) => [revision, zone]),
        [[1, 'America/Phoenix'], [2, 'America/New_York']]);
      assert.notEqual(revisions[0].evidence_digest, revisions[1].evidence_digest);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns WHERE opportunity_id = ?')
        .get(opportunityId).count, 0);
    } finally { database.close(); }
  });
});

test('Pass rejects an array action with a valid reason without disposition or review side effects', async () => {
  // Break caught: String(action) turns ["pass"] into a valid Pass command.
  const { storage, opportunityId } = await seedCurrentOpportunity('opp-http-triage-array-pass');
  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const response = await fetch(`${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ action: ['pass'], reason: 'not-a-fit' }),
    });
    assert.equal(response.status, 400);
    const score = await storage.getDealHunterOpportunityScore(opportunityId);
    assert.equal((await storage.listDealHunterDispositions({ dealKeys: [`deal-${opportunityId}`], limit: 20 })).length, 0);
    assert.deepEqual({ reviewed_at: score.reviewed_at, reviewed_by: score.reviewed_by, reviewed_fingerprint: score.reviewed_fingerprint, reviewed_semantic_digest: score.reviewed_semantic_digest }, { reviewed_at: null, reviewed_by: null, reviewed_fingerprint: null, reviewed_semantic_digest: null });
  });
});

test('P4A acquisition actions require client retry identity and both current revisions', async () => {
  const { storage, opportunityId } = await seedCurrentOpportunity('opp-http-p4a-required-command');
  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const url = `${origin}/api/admin/deal-hunter/triage/${opportunityId}/action`;
    for (const action of ['pursue', 'watch', 'pass']) {
      for (const body of [
        { action, reason: 'not-a-fit' },
        { action, reason: 'not-a-fit', idempotencyKey: 'p4a-required-key' },
        { action, reason: 'not-a-fit', idempotencyKey: 'p4a-required-key', expectedDiscoveryRevision: 0 },
      ]) {
        const response = await fetch(url, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
        assert.equal(response.status, 400, JSON.stringify(body));
      }
    }
    for (const idempotencyKey of ['', '  a953b1f1-e128-408f-8265-2e49a16ba43c',
      'malformed', 'a'.repeat(241), ['a953b1f1-e128-408f-8265-2e49a16ba43c'],
      { key: 'a953b1f1-e128-408f-8265-2e49a16ba43c' }]) {
      const response = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ action: 'pursue', idempotencyKey,
          expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 }),
      });
      assert.equal(response.status, 400);
    }
    for (const [discovery, material] of [[1, 0], [0, 1]]) {
      const response = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(ownerActionPayload('pursue', {
          expectedDiscoveryRevision: discovery, expectedMaterialRevision: material })),
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'stale_freshness_review');
    }
    assert.equal((await storage.getDealHunterOpportunityScore(opportunityId)).reviewed_at, null);
    assert.equal((await storage.readPursueCimProjection({ opportunityId })).decision, null);
    const database = new Database(process.env.SQLITE_PATH, { readonly: true });
    try {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_pursuit_enrollments
        WHERE opportunity_id = ?`).get(opportunityId).count, 0);
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events
        WHERE opportunity_id = ?`).get(opportunityId).count, 0);
    } finally { database.close(); }
  });
});

test('P4A generic triage edits never grant Pursue or Watch authority', async () => {
  const { storage, opportunityId } = await seedCurrentOpportunity('opp-http-p4a-generic-boundary');
  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const url = `${origin}/api/admin/deal-hunter/triage/${opportunityId}/decision`;
    for (const priority of ['high', 'watch']) {
      const response = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ priority, markReviewed: true }),
      });
      assert.equal(response.status, 200);
      assert.equal((await storage.readPursueCimProjection({ opportunityId })).decision, null);
    }
    const database = new Database(process.env.SQLITE_PATH, { readonly: true });
    try {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_pursuit_enrollments
        WHERE opportunity_id = ?`).get(opportunityId).count, 0);
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns
        WHERE opportunity_id = ?`).get(opportunityId).count, 0);
    } finally { database.close(); }
    const response = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ note: 'Ordinary triage note', markReviewed: true }),
    });
    assert.equal(response.status, 200);
  });
});

test('P4A owner command applies Pursue once, replays, conflicts, and never allocates outreach', async () => {
  const { storage, opportunityId } = await seedCurrentOpportunity('opp-http-p4a-pursue');
  const command = { action: 'pursue', idempotencyKey: 'a953b1f1-e128-408f-8265-2e49a16ba43c',
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 };
  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const url = `${origin}/api/admin/deal-hunter/triage/${opportunityId}/action`;
    const post = (body) => fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const first = await post(command);
    assert.equal(first.status, 200);
    assert.deepEqual({ action: (await first.json()).action,
      priority: (await storage.getDealHunterOpportunityScore(opportunityId)).operator_priority },
    { action: 'pursue', priority: 'high' });
    assert.equal((await post(command)).status, 200);
    assert.equal((await (await post(command)).json()).replay, true);
    assert.equal((await post({ ...command, action: 'watch' })).status, 409);
    const database = new Database(process.env.SQLITE_PATH, { readonly: true });
    try {
      for (const [table, expected] of [
        ['deal_hunter_owner_decision_events', 1], ['deal_hunter_pursuit_enrollments', 1],
        ['deal_hunter_cim_campaigns', 0], ['deal_hunter_cim_campaign_touches', 0],
      ]) assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE opportunity_id = ?`)
        .get(opportunityId).count, expected, table);
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_transmissions tr
        JOIN deal_hunter_cim_transmission_touches m ON m.transmission_id = tr.id
        WHERE m.opportunity_id = ?`).get(opportunityId).count, 0);
    } finally { database.close(); }
  });
});

test('P4B Pursue binds the exact opaque contact reference into immutable idempotency', async () => {
  const { opportunityId } = await seedCurrentOpportunity('opp-http-p4b-contact-selection');
  const command = { action: 'pursue', idempotencyKey: randomUUID(),
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
    recipientContactRef: 'opaque-selected-contact-v1' };
  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const url = `${origin}/api/admin/deal-hunter/triage/${opportunityId}/action`;
    const post = (body) => fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    assert.equal((await post(command)).status, 200);
    const database = new Database(process.env.SQLITE_PATH, { readonly: true });
    try {
      const decision = database.prepare(`SELECT selected_contact_reference_digest AS digest
        FROM deal_hunter_owner_decision_events WHERE opportunity_id = ?`).get(opportunityId);
      assert.equal(decision.digest, sha256(command.recipientContactRef));
    } finally { database.close(); }
    assert.equal((await post(command)).status, 200);
    assert.equal((await post({ ...command, recipientContactRef: 'opaque-selected-contact-v2' })).status, 409);
  });
});

test('P4B missing recipient keeps the Pursue decision and marks enrollment action-required', async () => {
  const { storage, opportunityId } = await seedCurrentOpportunity('opp-http-p4b-no-recipient');
  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const response = await fetch(`${origin}/api/admin/deal-hunter/triage/${opportunityId}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(ownerActionPayload('pursue')),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).enrollment.state, 'action-required');
    const projection = await storage.readPursueCimProjection({ opportunityId });
    assert.equal(projection.decision.action, 'pursue');
    assert.equal(projection.enrollment.reason_code, 'recipient_missing');
    assert.equal(projection.campaign, null);
  });
});

test('P8A release report is admin-only and explicit stop terminalizes the exact revision without sending', async () => {
  const { opportunityId } = await seedCurrentOpportunity('opp-http-p8a-release');
  const ids = seedP8aReleaseCampaign(opportunityId);
  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const viewerCookie = await login(origin, 'triage-viewer', 'triage-viewer-password');
    const url = `${origin}/api/admin/deal-hunter/triage/${opportunityId}/cim-release`;
    assert.equal((await fetch(url, { headers: { Cookie: viewerCookie } })).status, 401);
    const read = await fetch(url, { headers: { Cookie: adminCookie } });
    assert.equal(read.status, 200);
    const report = await read.json();
    assert.equal(report.campaign.id, ids.campaignId);
    assert.equal(report.recipientAuthority.address, 'broker@example.test');
    assert.equal(report.status.code, 'initial_pending');
    assert.equal(report.actions.canStop, true);
    assert.equal(JSON.stringify(report).includes('boundary_nonce_digest'), false);
    const stop = await fetch(`${url}/stop`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ campaignId: ids.campaignId,
        expectedRowVersion: report.actions.expectedRowVersion,
        expectedTerminalRevision: report.actions.expectedTerminalRevision,
        idempotencyKey: '7145375d-9055-4ad0-85cf-da3475e9a720',
        reason: 'Owner stopped the canary.' }) });
    assert.equal(stop.status, 200);
    const stopped = await stop.json();
    assert.equal(stopped.report.campaign.state, 'stopped');
    assert.equal(stopped.report.actions.canStop, false);
    assert.equal(stopped.report.transmission, null);
    const database = new Database(process.env.SQLITE_PATH, { readonly: true });
    try {
      assert.deepEqual(database.prepare(`SELECT state, terminal_reason FROM
        deal_hunter_cim_campaign_touches WHERE id = ?`).get(ids.touchId),
      { state: 'cancelled-before-provider', terminal_reason: 'campaign_stopped' });
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_transmissions`)
        .get().count, 0);
    } finally { database.close(); }
  });
});

test('Pass rolls back disposition when review persistence fails, retries once, and rejects every action until restore', async () => {
  // Break caught: the HTTP route commits disposition before it attempts the
  // review write, so an exception at the review boundary leaves a durable Pass
  // behind a failed response. The trigger injects that exact provider failure
  // without replacing either storage method with a mock.
  const { storage, opportunityId } = await seedCurrentOpportunity('opp-http-triage-atomic-pass');
  const dealKey = `deal-${opportunityId}`;
  const database = new Database(process.env.SQLITE_PATH);
  database.exec(`
    CREATE TRIGGER fail_atomic_pass_review
    BEFORE UPDATE OF reviewed_at ON deal_hunter_opportunity_scores
    WHEN NEW.opportunity_id = '${opportunityId}' AND NEW.reviewed_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'injected review persistence failure');
    END;
  `);
  try {
    await withServer(async (origin) => {
      const cookie = await login(origin, 'admin', 'change-me-now');
      const actionPath = `${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/action`;
      const request = (body) => fetch(actionPath, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ idempotencyKey: body.action === 'pass'
          ? 'ed532d60-3c18-43c9-a52b-30e2da084a0b'
          : `fd532d60-3c18-43c9-a52b-30e2da084a0${body.action === 'watch' ? '1' : '2'}`,
        expectedDiscoveryRevision: 0, expectedMaterialRevision: 0, ...body }),
      });

      const failed = await request({ action: 'pass', reason: 'valuation', note: 'Atomic failure injection.' });
      assert.equal(failed.status, 500);
      assert.equal((await storage.listDealHunterDispositions({ dealKeys: [dealKey], limit: 20 })).length, 0,
        'a failed Pass must not leave a durable dismissal');
      assert.equal((await storage.readPursueCimProjection({ opportunityId })).decision, null,
        'a failed Pass must not leave an immutable owner decision');
      const failedScore = await storage.getDealHunterOpportunityScore(opportunityId);
      assert.equal(failedScore.reviewed_at, null);
      assert.equal(failedScore.reviewed_semantic_digest, null);

      database.exec('DROP TRIGGER fail_atomic_pass_review');
      const retry = await request({ action: 'pass', reason: 'valuation', note: 'Atomic failure injection.' });
      assert.equal(retry.status, 200);
      const retryBody = await retry.json();
      assert.equal(retryBody.success, true);
      assert.equal(retryBody.opportunity.dismissed, true, 'API success must report the durable Passed state');
      assert.equal(retryBody.opportunity.reviewed, true, 'API success must report the durable review acknowledgement');
      assert.deepEqual(Object.keys(retryBody.disposition).sort(), ['dismissedAt', 'dismissedBy', 'disposition', 'id', 'note', 'reason']);
      assert.equal(Object.hasOwn(retryBody, 'submission'), false, 'the API must not expose raw provider submission state');
      const dispositions = await storage.listDealHunterDispositions({ dealKeys: [dealKey], limit: 20 });
      assert.equal(dispositions.length, 1);
      const passedAt = dispositions[0].updated_at;
      const reviewedAt = (await storage.getDealHunterOpportunityScore(opportunityId)).reviewed_at;

      for (const action of ['pursue', 'watch']) {
        const rejected = await request({ action });
        assert.equal(rejected.status, 409, `${action} must reject a durably Passed opportunity`);
      }
      const duplicate = await request({ action: 'pass', reason: 'valuation', note: 'Atomic failure injection.' });
      assert.equal(duplicate.status, 200);
      assert.equal((await duplicate.json()).replay, true);
      assert.equal((await request({ action: 'pass', reason: 'not-a-fit',
        note: 'Atomic failure injection.' })).status, 409,
      'the same Pass key cannot change its disposition reason');
      assert.equal((await storage.listDealHunterDispositions({ dealKeys: [dealKey], limit: 20 })).length, 1);
      assert.equal((await storage.getDealHunterDisposition({ dealKey })).updated_at, passedAt,
        'an identical repeat must not rewrite disposition time');
      assert.equal((await storage.getDealHunterOpportunityScore(opportunityId)).reviewed_at, reviewedAt,
        'an identical repeat must not rewrite review time');

      const restored = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ action: 'restore', dealKey }),
      });
      assert.equal(restored.status, 200);
      assert.equal((await request({ action: 'watch' })).status, 200,
        'an explicit restore must make operator decisions actionable again');
    });
  } finally {
    database.exec('DROP TRIGGER IF EXISTS fail_atomic_pass_review');
    database.close();
  }
});

test('linked-CRM Pass rolls archive, CIM stop, disposition, review, and audit back together', async () => {
  const storage = getStorage();
  const opportunityId = 'opp-http-triage-linked-atomic-pass';
  const dealKey = `deal-${opportunityId}`;
  const leadResult = await createManualSubmission({
    company: 'Linked Atomic Pass Services',
    lead_type: 'broker',
    broker_name: 'Jordan Broker',
    broker_email: 'jordan-linked@example.com',
    listing_url: 'https://broker.example/http-triage-actions',
    status: 'review',
    follow_up_state: 'scheduled',
    metadata: { dealHunter: { dealKey } },
  }, 'triage-admin', { storage });
  assert.equal(leadResult.ok, true);
  const submissionId = leadResult.submission.id;
  await seedCurrentOpportunity(opportunityId, submissionId);
  const cimRequestId = 'linked-atomic-pass-cim-request';
  const requestedAt = '2026-08-30T08:00:00.000Z';
  await storage.upsertDealHunterCimRequest({
    id: cimRequestId,
    created_at: requestedAt,
    updated_at: requestedAt,
    submission_id: submissionId,
    deal_key: dealKey,
    recipient_email: 'jordan-linked@example.com',
    requested_by: 'triage-admin',
    status: 'sent',
    delivery_error: '',
    provider_message_id: 'linked-atomic-pass-provider-message',
    subject: 'CIM / NDA request for Linked Atomic Pass Services',
    deal_name: 'Linked Atomic Pass Services',
    source_name: 'test',
    listing_url: 'https://broker.example/http-triage-actions',
    score: 72,
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'scheduled',
    first_requested_at: requestedAt,
    next_follow_up_at: '2026-09-01T08:00:00.000Z',
    follow_up_count: 0,
    last_follow_up_at: null,
    responded_at: null,
    metadata: {},
  });
  const beforeActivities = await storage.listCrmActivityEvents({ submissionId, limit: 100 });
  const database = new Database(process.env.SQLITE_PATH);
  database.exec(`
    CREATE TRIGGER fail_linked_atomic_pass_review
    BEFORE UPDATE OF reviewed_at ON deal_hunter_opportunity_scores
    WHEN NEW.opportunity_id = '${opportunityId}' AND NEW.reviewed_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'injected linked review persistence failure');
    END;
  `);
  try {
    await withServer(async (origin) => {
      const cookie = await login(origin, 'admin', 'change-me-now');
      const actionPath = `${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/action`;
      const request = () => fetch(actionPath, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(ownerActionPayload('pass', { idempotencyKey: '6b0dd595-2b3f-4d95-bdfc-2e9d303db35f',
          reason: 'valuation', note: 'Linked rollback.' })),
      });

      assert.equal((await request()).status, 500);
      assert.equal((await storage.getSubmission(submissionId)).status, 'review');
      assert.equal((await storage.listDealHunterDispositions({ dealKeys: [dealKey], limit: 20 })).length, 0);
      assert.equal((await storage.getDealHunterOpportunityScore(opportunityId)).reviewed_at, null);
      const rolledBackCimRequest = await storage.getDealHunterCimRequestById(cimRequestId);
      assert.equal(rolledBackCimRequest.request_state, 'provider_accepted');
      assert.equal(rolledBackCimRequest.follow_up_state, 'scheduled');
      assert.equal(rolledBackCimRequest.next_follow_up_at, '2026-09-01T08:00:00.000Z');
      assert.equal((await storage.listCrmActivityEvents({ submissionId, limit: 100 })).length, beforeActivities.length,
        'rollback must not retain archive or triage audit rows');

      database.exec('DROP TRIGGER fail_linked_atomic_pass_review');
      assert.equal((await request()).status, 200);
      const submission = await storage.getSubmission(submissionId);
      assert.equal(submission.status, 'archived');
      assert.equal(submission.follow_up_state, 'completed');
      assert.equal(submission.metadata.acquisitionCommand.pipelineStage, 'passed');
      const stoppedCimRequest = await storage.getDealHunterCimRequestById(cimRequestId);
      assert.equal(stoppedCimRequest.request_state, 'stopped');
      assert.equal(stoppedCimRequest.follow_up_state, 'stopped');
      assert.equal(stoppedCimRequest.next_follow_up_at, null);
      const activities = await storage.listCrmActivityEvents({ submissionId, limit: 100 });
      assert.equal(activities.length, beforeActivities.length + 2);
      assert.equal(activities.filter((event) => event.event_type === 'submission.archived').length, 1);
      assert.equal(activities.filter((event) => event.event_type === 'opportunity.triaged').length, 1);
      const disposition = await storage.getDealHunterDisposition({ dealKey });
      const duplicate = await request();
      assert.equal(duplicate.status, 200);
      const duplicateBody = await duplicate.json();
      assert.equal(duplicateBody.replay, true);
      assert.equal(duplicateBody.archived, true);
      assert.equal((await storage.getDealHunterDisposition({ dealKey })).updated_at, disposition.updated_at);
      assert.equal((await storage.listCrmActivityEvents({ submissionId, limit: 100 })).length, activities.length);
    });
  } finally {
    database.exec('DROP TRIGGER IF EXISTS fail_linked_atomic_pass_review');
    database.close();
  }
});

test('legacy disposition HTTP route delegates a current canonical Inbox target to the atomic Pass command', async () => {
  // Break caught: Dashboard uses this older route. It archived CRM and wrote the
  // disposition without touching the canonical score review, so the atomic
  // command could be bypassed even after the Inbox action route was corrected.
  const storage = getStorage();
  const opportunityId = 'opp-http-legacy-route-atomic-pass';
  const dealKey = 'source:http-legacy-route:observed-alias';
  const canonicalDealKey = 'source:http-legacy-route:canonical-primary';
  const leadResult = await createManualSubmission({
    company: 'Legacy Route Atomic Pass Services',
    lead_type: 'broker',
    broker_name: 'Legacy Route Broker',
    broker_email: 'legacy-route@example.com',
    listing_url: 'https://broker.example/http-legacy-route-atomic-pass',
    status: 'review',
    follow_up_state: 'scheduled',
    metadata: { dealHunter: { dealKey } },
  }, 'triage-admin', { storage });
  assert.equal(leadResult.ok, true);
  const submissionId = leadResult.submission.id;
  await seedCurrentOpportunity(opportunityId, submissionId, canonicalDealKey);
  await linkCanonicalDealKey(storage, { opportunityId, dealKey });
  const beforeActivities = await storage.listCrmActivityEvents({ submissionId, limit: 100 });
  const database = new Database(process.env.SQLITE_PATH);
  database.exec(`
    CREATE TRIGGER fail_legacy_route_atomic_pass_review
    BEFORE UPDATE OF reviewed_at ON deal_hunter_opportunity_scores
    WHEN NEW.opportunity_id = '${opportunityId}' AND NEW.reviewed_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'injected legacy-route review persistence failure');
    END;
  `);
  try {
    await withServer(async (origin) => {
      const cookie = await login(origin, 'admin', 'change-me-now');
      const request = () => fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          dealKey,
          listingUrl: 'https://broker.example/http-legacy-route-atomic-pass',
          dealName: 'Legacy Route Atomic Pass Services',
          reason: 'valuation',
          note: 'The legacy Dashboard route must use atomic Pass.',
          // This legacy compatibility field must not be trusted as canonical
          // Pass authority. The server-owned alias owns that resolution.
          submissionId,
        }),
      });

      const failed = await request();
      const failedSubmission = await storage.getSubmission(submissionId);
      const failedDispositions = await storage.listDealHunterDispositions({ dealKeys: [dealKey, canonicalDealKey], limit: 20 });
      const failedScore = await storage.getDealHunterOpportunityScore(opportunityId);
      const failedActivities = await storage.listCrmActivityEvents({ submissionId, limit: 100 });
      assert.deepEqual({
        status: failed.status,
        submissionStatus: failedSubmission.status,
        dispositionCount: failedDispositions.length,
        reviewedAt: failedScore.reviewed_at,
        activityCount: failedActivities.length,
      }, {
        status: 500,
        submissionStatus: 'review',
        dispositionCount: 0,
        reviewedAt: null,
        activityCount: beforeActivities.length,
      }, 'a review-boundary failure must not leave the legacy route partially Passed');

      database.exec('DROP TRIGGER fail_legacy_route_atomic_pass_review');
      const retry = await request();
      assert.equal(retry.status, 200);
      const retryBody = await retry.json();
      assert.equal(retryBody.success, true);
      assert.equal(retryBody.opportunity.dismissed, true);
      assert.equal(retryBody.opportunity.reviewed, true);
      assert.equal(retryBody.archived, true);
      assert.equal(Object.hasOwn(retryBody, 'submission'), false,
        'the canonical Pass response must not expose raw provider submission state');
      assert.equal((await storage.getSubmission(submissionId)).status, 'archived');
      const passedDisposition = await storage.getDealHunterDisposition({ dealKey: canonicalDealKey });
      const passedScore = await storage.getDealHunterOpportunityScore(opportunityId);
      const passedActivities = await storage.listCrmActivityEvents({ submissionId, limit: 100 });
      assert.equal(passedActivities.length, beforeActivities.length + 2);

      await new Promise((resolve) => setTimeout(resolve, 5));
      const repeated = await request();
      assert.equal(repeated.status, 409);
      assert.equal((await storage.getDealHunterDisposition({ dealKey: canonicalDealKey })).updated_at, passedDisposition.updated_at,
        'repeating legacy dismissal must not rewrite the canonical Pass timestamp');
      assert.equal((await storage.getDealHunterOpportunityScore(opportunityId)).reviewed_at, passedScore.reviewed_at,
        'repeating legacy dismissal must not rewrite the review timestamp');
      assert.equal((await storage.listCrmActivityEvents({ submissionId, limit: 100 })).length, passedActivities.length,
        'repeating legacy dismissal must not duplicate archive or triage history');
    });
  } finally {
    database.exec('DROP TRIGGER IF EXISTS fail_legacy_route_atomic_pass_review');
    database.close();
  }
});

test('legacy disposition HTTP route cannot rewrite a repeated source-only canonical Pass', async () => {
  // Break caught: the legacy source-only path upserted the dismissal on every
  // request. A repeat therefore returned success and replaced its timestamps
  // without ever acknowledging the current canonical review.
  const opportunityId = 'opp-http-legacy-route-source-only-repeat';
  const dealKey = 'source:http-legacy-route:source-only-repeat';
  const { storage } = await seedCurrentOpportunity(opportunityId, null, dealKey);

  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const request = () => fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dealKey, reason: 'timing', note: 'Canonical source-only repeat.' }),
    });

    const first = await request();
    const firstDisposition = await storage.getDealHunterDisposition({ dealKey });
    const firstScore = await storage.getDealHunterOpportunityScore(opportunityId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const repeated = await request();
    const repeatedDisposition = await storage.getDealHunterDisposition({ dealKey });
    const repeatedScore = await storage.getDealHunterOpportunityScore(opportunityId);

    assert.deepEqual({
      firstStatus: first.status,
      repeatedStatus: repeated.status,
      dispositionTimePreserved: repeatedDisposition.updated_at === firstDisposition.updated_at,
      reviewTimePreserved: repeatedScore.reviewed_at === firstScore.reviewed_at,
      reviewed: Boolean(repeatedScore.reviewed_at),
    }, {
      firstStatus: 200,
      repeatedStatus: 409,
      dispositionTimePreserved: true,
      reviewTimePreserved: true,
      reviewed: true,
    });
  });
});

test('legacy disposition HTTP route fails closed when its CRM-import authority points to a stale canonical opportunity', async () => {
  // Break caught: the dispatcher discarded a durable import owner after the
  // current-only reread returned null, then treated the same import as legacy
  // authority and archived its CRM submission outside atomic Pass.
  const storage = getStorage();
  const opportunityId = 'opp-http-stale-import-authority';
  const dealKey = 'source:http-stale-import-authority';
  const leadResult = await createManualSubmission({
    company: 'Stale Import Authority Services',
    lead_type: 'broker',
    broker_name: 'Stale Import Broker',
    broker_email: 'stale-import@example.com',
    listing_url: 'https://broker.example/stale-import-authority',
    status: 'review',
    follow_up_state: 'scheduled',
    metadata: {},
  }, 'triage-admin', { storage });
  assert.equal(leadResult.ok, true);
  const submissionId = leadResult.submission.id;
  await seedCurrentOpportunity(opportunityId, submissionId, dealKey);
  await storage.claimDealHunterCrmImport({
    id: 'import-http-stale-authority',
    created_at: '2026-08-30T09:00:00.000Z',
    updated_at: '2026-08-30T10:00:00.000Z',
    opportunity_id: opportunityId,
    deal_key: dealKey,
    listing_identity: 'listing-http-stale-import-authority',
    listing_url: 'https://broker.example/stale-import-authority',
    submission_id: submissionId,
    status: 'completed',
    source_name: 'http-authority-test',
    metadata: {},
  });
  await supersedeOpportunity(storage, opportunityId);
  const beforeActivities = await storage.listCrmActivityEvents({ submissionId, limit: 100 });

  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const response = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dealKey, reason: 'valuation', note: 'Stale import must fail closed.' }),
    });
    const submission = await storage.getSubmission(submissionId);
    const score = await storage.getDealHunterOpportunityScore(opportunityId);
    const dispositions = await storage.listDealHunterDispositions({ dealKeys: [dealKey], limit: 20 });
    const activities = await storage.listCrmActivityEvents({ submissionId, limit: 100 });
    assert.deepEqual({
      status: response.status,
      submissionStatus: submission.status,
      dispositionCount: dispositions.length,
      reviewedAt: score.reviewed_at,
      activityCount: activities.length,
    }, {
      status: 409,
      submissionStatus: 'review',
      dispositionCount: 0,
      reviewedAt: null,
      activityCount: beforeActivities.length,
    });
  });
});

test('legacy disposition HTTP route fails closed when its CIM authority points to a stale canonical opportunity', async () => {
  // Break caught: a stale CIM owner was filtered away before fallback, while
  // the generic route reused that CIM row to authorize and archive CRM.
  const storage = getStorage();
  const opportunityId = 'opp-http-stale-cim-authority';
  const dealKey = 'source:http-stale-cim-authority';
  const leadResult = await createManualSubmission({
    company: 'Stale CIM Authority Services',
    lead_type: 'broker',
    broker_name: 'Stale CIM Broker',
    broker_email: 'stale-cim@example.com',
    listing_url: 'https://broker.example/stale-cim-authority',
    status: 'review',
    follow_up_state: 'scheduled',
    metadata: {},
  }, 'triage-admin', { storage });
  assert.equal(leadResult.ok, true);
  const submissionId = leadResult.submission.id;
  await seedCurrentOpportunity(opportunityId, submissionId, dealKey);
  await seedCimAuthority(storage, {
    id: 'cim-http-stale-authority',
    dealKey,
    opportunityId,
    submissionId,
    recipientEmail: 'stale-cim@example.com',
  });
  await supersedeOpportunity(storage, opportunityId);
  const beforeActivities = await storage.listCrmActivityEvents({ submissionId, limit: 100 });
  const beforeCim = await storage.getDealHunterCimRequestById('cim-http-stale-authority');

  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const response = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        dealKey,
        reason: 'valuation',
        note: 'Stale CIM must fail closed.',
        submissionId,
      }),
    });
    const submission = await storage.getSubmission(submissionId);
    const score = await storage.getDealHunterOpportunityScore(opportunityId);
    const dispositions = await storage.listDealHunterDispositions({ dealKeys: [dealKey], limit: 20 });
    const activities = await storage.listCrmActivityEvents({ submissionId, limit: 100 });
    const cim = await storage.getDealHunterCimRequestById('cim-http-stale-authority');
    assert.deepEqual({
      status: response.status,
      submissionStatus: submission.status,
      dispositionCount: dispositions.length,
      reviewedAt: score.reviewed_at,
      activityCount: activities.length,
      cimStatePreserved: cim.request_state === beforeCim.request_state
        && cim.follow_up_state === beforeCim.follow_up_state,
    }, {
      status: 409,
      submissionStatus: 'review',
      dispositionCount: 0,
      reviewedAt: null,
      activityCount: beforeActivities.length,
      cimStatePreserved: true,
    });
  });
});

test('legacy disposition HTTP route detects an older conflicting CIM authority beyond the newest 100 records', async () => {
  // Break caught: a limit of 100 made canonical authority depend on recency.
  // The older conflicting current owner was omitted and the newer owner passed.
  const storage = getStorage();
  const opportunityId = 'opp-http-cim-window-primary';
  const conflictingOpportunityId = 'opp-http-cim-window-conflict';
  const dealKey = 'source:http-cim-window-conflict';
  await seedCurrentOpportunity(opportunityId, null, dealKey);
  await seedCurrentOpportunity(conflictingOpportunityId, null, 'source:http-cim-window-other-score');
  await storage.reconcileDealHunterCurrentScoreEligibility([opportunityId, conflictingOpportunityId]);
  await seedCimAuthority(storage, {
    id: 'cim-http-window-older-conflict',
    dealKey,
    opportunityId: conflictingOpportunityId,
    recipientEmail: 'older-conflict@example.com',
    updatedAt: '2026-08-29T10:00:00.000Z',
  });
  for (let index = 0; index < 100; index += 1) {
    await seedCimAuthority(storage, {
      id: `cim-http-window-newer-${index}`,
      dealKey,
      opportunityId,
      recipientEmail: `newer-${index}@example.com`,
      updatedAt: new Date(Date.UTC(2026, 7, 30, 10, 0, index)).toISOString(),
    });
  }
  const newestHundred = await storage.listDealHunterCimRequests({ dealKeys: [dealKey], limit: 100 });
  const completeAuthority = await storage.listDealHunterCimRequests({ dealKeys: [dealKey], limit: 100000 });
  assert.equal(newestHundred.length, 100);
  assert.equal(newestHundred.some((request) => request.id === 'cim-http-window-older-conflict'), false,
    'the conflicting authority must actually sit outside the former 100-row window');
  assert.equal(completeAuthority.length, 101);

  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const response = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dealKey, reason: 'valuation', note: 'All CIM authority must be considered.' }),
    });
    const responseBody = await response.json();
    const score = await storage.getDealHunterOpportunityScore(opportunityId);
    const dispositions = await storage.listDealHunterDispositions({ dealKeys: [dealKey], limit: 20 });
    assert.deepEqual({
      status: response.status,
      error: responseBody.error,
      dispositionCount: dispositions.length,
      reviewedAt: score.reviewed_at,
    }, {
      status: 409,
      error: 'This Deal Hunter key has conflicting current canonical links.',
      dispositionCount: 0,
      reviewedAt: null,
    });
  });
});

test('legacy alias restore resolves the canonical Inbox disposition and makes operator actions actionable again', async () => {
  // Break caught: Pass canonicalized this durable alias to the score deal key,
  // but restore exact-looked up the alias and returned 404.
  const opportunityId = 'opp-http-alias-restore';
  const aliasDealKey = 'source:http-alias-restore-observed';
  const canonicalDealKey = 'source:http-alias-restore-canonical';
  const { storage } = await seedCurrentOpportunity(opportunityId, null, canonicalDealKey);
  await linkCanonicalDealKey(storage, { opportunityId, dealKey: aliasDealKey });

  await withServer(async (origin) => {
    const cookie = await login(origin, 'admin', 'change-me-now');
    const dispositionPath = `${origin}/api/admin/deal-hunter/dispositions`;
    const pass = await fetch(dispositionPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dealKey: aliasDealKey, reason: 'timing', note: 'Restore this persisted alias.' }),
    });
    assert.equal(pass.status, 200);
    const passedDisposition = await storage.getDealHunterDisposition({ dealKey: canonicalDealKey });
    assert.equal(passedDisposition.disposition, 'dismissed');
    assert.equal(await storage.getDealHunterDisposition({ dealKey: aliasDealKey }), null);

    const restore = await fetch(dispositionPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'restore', dealKey: aliasDealKey }),
    });
    const canonicalDisposition = await storage.getDealHunterDisposition({ dealKey: canonicalDealKey });
    const dispositions = await storage.listDealHunterDispositions({ dealKeys: [aliasDealKey, canonicalDealKey], limit: 20 });
    assert.deepEqual({
      status: restore.status,
      disposition: canonicalDisposition.disposition,
      dispositionCount: dispositions.length,
      dispositionIdentityPreserved: canonicalDisposition.id === passedDisposition.id,
      aliasDispositionExists: Boolean(await storage.getDealHunterDisposition({ dealKey: aliasDealKey })),
    }, {
      status: 200,
      disposition: 'restored',
      dispositionCount: 1,
      dispositionIdentityPreserved: true,
      aliasDispositionExists: false,
    });

    const actionPath = `${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/action`;
    for (const action of ['watch', 'pursue']) {
      const response = await fetch(actionPath, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(ownerActionPayload(action)),
      });
      assert.equal(response.status, 200, `${action} must be actionable after alias restore`);
    }
  });
});

test('triage detail remains readable while only administrators may enrich facts or run bounded Pursue, Watch, and Pass actions', async () => {
  const { storage, opportunityId } = await seedCurrentOpportunity();
  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const viewerCookie = await login(origin, 'triage-viewer', 'triage-viewer-password');
    const detailPath = `/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}`;
    const factPath = `/api/admin/deal-hunter/opportunities/${encodeURIComponent(opportunityId)}/facts/seller_name`;
    const actionPath = `/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/action`;

    const viewerDetail = await fetch(detailPath.replace(/^/, origin), { headers: { Cookie: viewerCookie } });
    assert.equal(viewerDetail.status, 200);
    const viewerDetailPayload = await viewerDetail.json();
    assert.deepEqual(Object.keys(viewerDetailPayload).sort(), [
      'brokerMaterials', 'cimSummary', 'crmSummary', 'effectiveFacts', 'history', 'listingUrls', 'missingCriticalFields',
      'operatorFacts', 'opportunity', 'pursueCimReleaseAvailable', 'score', 'sourceObservations',
    ]);
    assert.equal((await fetch(factPath.replace(/^/, origin), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ value: 'Viewer Seller', verified: true }),
    })).status, 401);
    assert.equal((await fetch(actionPath.replace(/^/, origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: viewerCookie }, body: JSON.stringify({ action: 'watch' }),
    })).status, 401);
    const savedFact = await fetch(factPath.replace(/^/, origin), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ value: 'Verified Seller', verified: true, note: 'Called seller.', expectedRevision: viewerDetailPayload.opportunity.factEditRevision }),
    });
    assert.equal(savedFact.status, 200);
    const detailAfterFact = await (await fetch(detailPath.replace(/^/, origin), { headers: { Cookie: adminCookie } })).json();
    assert.equal(detailAfterFact.effectiveFacts.seller_name.value, 'Verified Seller');
    assert.equal(detailAfterFact.history.operatorFacts[0].note, 'Called seller.');
    const staleFact = await fetch(factPath.replace(/^/, origin), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ value: 'Stale Seller', verified: true, expectedRevision: viewerDetailPayload.opportunity.factEditRevision }),
    });
    assert.equal(staleFact.status, 409);
    assert.equal((await staleFact.json()).code, 'fact_edit_conflict');
    assert.equal((await storage.listDealHunterOpportunityFacts(opportunityId)).length, 1);
    const malformedVerification = await fetch(factPath.replace(/^/, origin), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ value: 'x', verified: 'yes' }),
    });
    assert.equal(malformedVerification.status, 400);
    const missingRevision = await fetch(factPath.replace(/^/, origin), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ value: 'No authority', verified: true }),
    });
    assert.equal(missingRevision.status, 400);
    assert.match((await missingRevision.json()).error, /expected revision is invalid/i);
    assert.equal((await storage.listDealHunterOpportunityFacts(opportunityId)).length, 1);
    const malformedField = await fetch(`${origin}/api/admin/deal-hunter/opportunities/${encodeURIComponent(opportunityId)}/facts/not_allowed`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ value: 'x', verified: false }),
    });
    assert.equal(malformedField.status, 400);
    const before = await storage.getDealHunterOpportunityScore(opportunityId);
    let forbiddenCalls = 0;
    const originalWrite = storage.writeDealHunterOpportunityScore.bind(storage);
    storage.writeDealHunterOpportunityScore = async (...args) => { forbiddenCalls += 1; return originalWrite(...args); };
    try {
      const malformedAction = await fetch(actionPath.replace(/^/, origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ action: 'activate-stage-2' }),
      });
      assert.equal(malformedAction.status, 400);
      const watch = await fetch(actionPath.replace(/^/, origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify(ownerActionPayload('watch')),
      });
      assert.equal(watch.status, 200);
      const afterWatch = await storage.getDealHunterOpportunityScore(opportunityId);
      assert.equal(afterWatch.operator_priority, 'watch');
      const failedPass = await fetch(actionPath.replace(/^/, origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ action: 'pass' }),
      });
      assert.equal(failedPass.status, 400);
      assert.equal((await storage.getDealHunterOpportunityScore(opportunityId)).reviewed_at, afterWatch.reviewed_at, 'failed dismissal must not alter the existing review acknowledgement');
      const pursue = await fetch(actionPath.replace(/^/, origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify(ownerActionPayload('pursue')),
      });
      assert.equal(pursue.status, 200);
      const pass = await fetch(actionPath.replace(/^/, origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify(ownerActionPayload('pass', { reason: 'not-a-fit', note: 'Does not match the acquisition focus.' })),
      });
      assert.equal(pass.status, 200);
      assert.equal((await pass.json()).disposition.disposition, 'dismissed');
    } finally {
      storage.writeDealHunterOpportunityScore = originalWrite;
    }
    const after = await storage.getDealHunterOpportunityScore(opportunityId);
    assert.equal(after.fit_score, before.fit_score);
    assert.equal(after.operator_priority, 'high');
    assert.ok(after.reviewed_at);
    assert.equal(forbiddenCalls, 0, 'triage actions do not refresh or alter machine scoring');
  });
});

test('prepare Broker Materials enforces auth and the strict canonical input while remaining side-effect free', async () => {
  // Break caught: the canonical prepare route and viewer-safe principal-bound
  // contract do not yet exist.
  const { storage, opportunityId } = await seedCurrentOpportunity('opp-http-broker-materials');
  const observedAt = '2026-08-30T10:15:00.000Z';
  for (const [id, field, value] of [
    ['source-name', 'name', 'HTTP Broker Materials Co'],
    ['source-email', 'broker_email', 'broker-http@example.test'],
  ]) await storage.upsertDealHunterOpportunitySourceObservation({
    id: `${id}-${opportunityId}`, opportunity_id: opportunityId, source_id: 'sheet', source_name: 'Deal Hunter Sheet',
    source_record_id: 'row-http-broker-materials', field, value, observed_at: observedAt, created_at: observedAt, updated_at: observedAt,
  });

  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const viewerCookie = await login(origin, 'triage-viewer', 'triage-viewer-password');
    const actionPath = `${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/action`;
    const preparePath = `${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/broker-materials/prepare`;
    assert.equal((await fetch(actionPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify(ownerActionPayload('pursue')),
    })).status, 200);

    const before = {
      score: await storage.getDealHunterOpportunityScore(opportunityId),
      opportunity: await storage.getDealHunterOpportunity(opportunityId),
      requests: await storage.listDealHunterCimRequests({ opportunityIds: [opportunityId], detailAuthority: true, limit: 100 }),
      facts: await storage.listDealHunterOpportunityFacts(opportunityId),
      sources: await storage.listDealHunterOpportunitySourceObservations(opportunityId),
      activities: await storage.listCrmActivityEvents({ submissionId: 'missing', limit: 100 }),
    };
    assert.equal((await fetch(preparePath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    for (const body of [
      { recipientEmail: 'raw@example.test' }, { subject: 'override' }, { body: 'override' }, { sender: 'override' },
      { dealKey: 'client-key' }, { score: 99 }, { annualProfit: 1 }, { policy: 'manual_stage_1' },
      { pauseOverride: true }, { followUp: true },
    ]) {
      const response = await fetch(preparePath, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
    }

    const adminResponse = await fetch(preparePath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ greeting: '  Hello,  ' }),
    });
    assert.equal(adminResponse.status, 200);
    const admin = await adminResponse.json();
    assert.equal(admin.success, true);
    assert.equal(admin.previewOnly, false);
    const claims = verifySignedPayload(admin.preparationToken, getConfig().admin.sessionSecret);
    assert.equal(claims.canonicalOpportunityId, opportunityId);
    assert.ok(claims.administratorPrincipalId);
    assert.equal(claims.approvalBoundPayload.greeting, 'Hello,');

    const viewerResponse = await fetch(preparePath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: viewerCookie }, body: '{}',
    });
    assert.equal(viewerResponse.status, 200);
    const viewer = await viewerResponse.json();
    assert.equal(viewer.previewOnly, true);
    for (const key of ['preparationToken', 'proposalDigest', 'nonce']) assert.equal(Object.hasOwn(viewer, key), false);

    const after = {
      score: await storage.getDealHunterOpportunityScore(opportunityId),
      opportunity: await storage.getDealHunterOpportunity(opportunityId),
      requests: await storage.listDealHunterCimRequests({ opportunityIds: [opportunityId], detailAuthority: true, limit: 100 }),
      facts: await storage.listDealHunterOpportunityFacts(opportunityId),
      sources: await storage.listDealHunterOpportunitySourceObservations(opportunityId),
      activities: await storage.listCrmActivityEvents({ submissionId: 'missing', limit: 100 }),
    };
    assert.deepEqual(after, before);
  });
});

test('approve Broker Materials requires admin, accepts only token plus digest, and returns the durable owner envelope', async () => {
  // Break caught: Task 2 has no administrator-only approval route and a durable
  // owner could otherwise be flattened into a retry-encouraging HTTP failure.
  const dealKey = 'deal-http-broker-materials-approve';
  const { storage, opportunityId } = await seedCurrentOpportunity('opp-http-broker-materials-approve', null, dealKey);
  await linkCanonicalDealKey(storage, { opportunityId, dealKey });
  const observedAt = '2026-08-30T10:15:00.000Z';
  for (const [id, field, value] of [
    ['source-name', 'name', 'HTTP Broker Approval Co'],
    ['source-email', 'broker_email', 'broker-approval@example.test'],
  ]) await storage.upsertDealHunterOpportunitySourceObservation({
    id: `${id}-${opportunityId}`, opportunity_id: opportunityId, source_id: 'sheet', source_name: 'Deal Hunter Sheet',
    source_record_id: 'row-http-broker-materials-approve', field, value, observed_at: observedAt, created_at: observedAt, updated_at: observedAt,
  });

  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const viewerCookie = await login(origin, 'triage-viewer', 'triage-viewer-password');
    const actionPath = `${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/action`;
    const preparePath = `${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/broker-materials/prepare`;
    const approvePath = `${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/broker-materials/approve`;
    assert.equal((await fetch(actionPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify(ownerActionPayload('pursue')),
    })).status, 200);
    const preparationResponse = await fetch(preparePath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: '{}',
    });
    assert.equal(preparationResponse.status, 200);
    const preparation = await preparationResponse.json();

    assert.equal((await fetch(approvePath, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preparationToken: preparation.preparationToken, approvedProposalDigest: preparation.proposalDigest }),
    })).status, 401);
    assert.equal((await fetch(approvePath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: viewerCookie }, body: JSON.stringify({ preparationToken: preparation.preparationToken, approvedProposalDigest: preparation.proposalDigest }),
    })).status, 401);

    for (const extra of [
      { recipient: 'raw@example.test' }, { recipientEmail: 'raw@example.test' }, { recipientContactRef: 'client-ref' },
      { greeting: 'Hello,' }, { subject: 'override' }, { body: 'override' }, { html: '<p>override</p>' },
      { sender: 'override' }, { replyTo: 'override@example.test' }, { dealKey: 'client-key' },
      { policy: 'manual_stage_1' }, { pauseOverride: true }, { cadenceOverride: true },
      { suppressionOverride: true }, { readinessOverride: true }, { followUp: true },
      { scheduledAt: new Date().toISOString() }, { pipelineState: 'contacted' },
    ]) {
      const response = await fetch(approvePath, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ preparationToken: preparation.preparationToken, approvedProposalDigest: preparation.proposalDigest, ...extra }),
      });
      assert.equal(response.status, 400, JSON.stringify(extra));
    }

    await seedCimAuthority(storage, {
      id: 'http-broker-materials-existing-owner',
      dealKey,
      opportunityId,
      recipientEmail: 'broker-approval@example.test',
    });
    const approvedResponse = await fetch(approvePath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ preparationToken: preparation.preparationToken, approvedProposalDigest: preparation.proposalDigest }),
    });
    assert.equal(approvedResponse.status, 200);
    const approved = await approvedResponse.json();
    assert.equal(approved.success, true);
    assert.equal(approved.canonicalOpportunityId, opportunityId);
    assert.equal(approved.durableResult.cimRequest.id, 'http-broker-materials-existing-owner');
    assert.equal(approved.durableResult.cimRequest.status, 'sent');
  });
});

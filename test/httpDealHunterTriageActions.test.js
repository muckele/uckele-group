import assert from 'node:assert/strict';
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
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const { createApp } = await import('../server/app.js');
const { getStorage } = await import('../server/storage/index.js');
const { createManualSubmission } = await import('../server/services/submissions.js');

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function seedCurrentOpportunity(opportunityId = 'opp-http-triage-actions', primarySubmissionId = null) {
  const storage = getStorage();
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId, created_at: '2026-08-30T09:00:00.000Z', updated_at: '2026-08-30T09:00:00.000Z',
    canonical_name: 'HTTP Action Opportunity', canonical_recipient: null, canonical_location: 'Dallas, TX',
    primary_submission_id: primarySubmissionId, identity_version: 'http-triage-actions', status: 'active', metadata: {},
  });
  await storage.writeDealHunterOpportunityScore({
    opportunity_id: opportunityId, scored_at: '2026-08-30T10:00:00.000Z', deal_key: `deal-${opportunityId}`,
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

async function login(origin, username, password) {
  const response = await fetch(`${origin}/api/admin/session`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json',
      'X-Real-IP': username === 'triage-viewer' ? '198.51.100.22' : '198.51.100.21',
    }, body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
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
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
      });

      const failed = await request({ action: 'pass', reason: 'valuation', note: 'Atomic failure injection.' });
      assert.equal(failed.status, 500);
      assert.equal((await storage.listDealHunterDispositions({ dealKeys: [dealKey], limit: 20 })).length, 0,
        'a failed Pass must not leave a durable dismissal');
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
      assert.equal(duplicate.status, 409);
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
        body: JSON.stringify({ action: 'pass', reason: 'valuation', note: 'Linked rollback.' }),
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
      assert.equal(duplicate.status, 409);
      assert.equal((await storage.getDealHunterDisposition({ dealKey })).updated_at, disposition.updated_at);
      assert.equal((await storage.listCrmActivityEvents({ submissionId, limit: 100 })).length, activities.length);
    });
  } finally {
    database.exec('DROP TRIGGER IF EXISTS fail_linked_atomic_pass_review');
    database.close();
  }
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
    assert.deepEqual(Object.keys(await viewerDetail.json()).sort(), [
      'cimSummary', 'crmSummary', 'effectiveFacts', 'history', 'listingUrls', 'missingCriticalFields',
      'operatorFacts', 'opportunity', 'score', 'sourceObservations',
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
      body: JSON.stringify({ value: 'Verified Seller', verified: true, note: 'Called seller.' }),
    });
    assert.equal(savedFact.status, 200);
    const detailAfterFact = await (await fetch(detailPath.replace(/^/, origin), { headers: { Cookie: adminCookie } })).json();
    assert.equal(detailAfterFact.effectiveFacts.seller_name.value, 'Verified Seller');
    assert.equal(detailAfterFact.history.operatorFacts[0].note, 'Called seller.');
    const malformedVerification = await fetch(factPath.replace(/^/, origin), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ value: 'x', verified: 'yes' }),
    });
    assert.equal(malformedVerification.status, 400);
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
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ action: 'watch' }),
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
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ action: 'pursue' }),
      });
      assert.equal(pursue.status, 200);
      const pass = await fetch(actionPath.replace(/^/, origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ action: 'pass', reason: 'not-a-fit', note: 'Does not match the acquisition focus.' }),
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function seedCurrentOpportunity(opportunityId = 'opp-http-triage-actions') {
  const storage = getStorage();
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId, created_at: '2026-08-30T09:00:00.000Z', updated_at: '2026-08-30T09:00:00.000Z',
    canonical_name: 'HTTP Action Opportunity', canonical_recipient: null, canonical_location: 'Dallas, TX',
    primary_submission_id: null, identity_version: 'http-triage-actions', status: 'active', metadata: {},
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
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

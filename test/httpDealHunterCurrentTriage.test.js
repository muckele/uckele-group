import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-current-triage-'));
const sheetUrl = 'https://example.invalid/http-authoritative-full-backfill.csv';
process.env.ADMIN_SESSION_SECRET = 'http-current-triage-session-secret-for-tests';
process.env.ADMIN_SESSION_MAX_AGE_MS = String(7 * 24 * 60 * 60 * 1000);
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'http-current-triage-document-secret-for-tests';
process.env.SQLITE_PATH = path.join(tempDir, 'http-current-triage.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = sheetUrl;
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const { createApp } = await import('../server/app.js');
const { getStorage } = await import('../server/storage/index.js');

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test.after(() => {
  getStorage().close?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('operator full-backfill reconciles a stale supplemental score out of current triage while preserving history', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const baseNow = originalNow();
  let requiredSheetProfit = 450000;
  let requiredSheetFetchCount = 0;
  let requiredSheetFailureAt = 0;
  Date.now = () => baseNow;
  globalThis.fetch = async (input, init) => {
    if (String(input) === sheetUrl) {
      requiredSheetFetchCount += 1;
      if (requiredSheetFetchCount === requiredSheetFailureAt) {
        return new Response('required Sheet temporarily unavailable', { status: 503 });
      }
      return new Response([
        'Business Name,State,Earnings,Revenue,Asking Price,Date Added,View Listing URL,Description',
        `HTTP Required Sheet Co,CA,$${requiredSheetProfit},$1800000,$1250000,2026-08-25,https://listings.example.invalid/http-current-sheet,Recurring commercial inspection contracts`,
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/csv' } });
    }
    return originalFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  });

  await withServer(async (origin) => {
    const loginResponse = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Fly-Client-Ip': '203.0.113.144' },
      body: JSON.stringify({ username: 'admin', password: 'change-me-now' }),
    });
    assert.equal(loginResponse.status, 200);
    const adminCookie = loginResponse.headers.get('set-cookie').split(';')[0];

    const importResponse = await fetch(`${origin}/api/admin/deal-hunter/deal-os-import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/csv',
        Cookie: adminCookie,
        'X-Deal-OS-File-Name': encodeURIComponent('http-fresh-deal-os.csv'),
        'X-Deal-OS-Exported-At': new Date(baseNow - (60 * 60 * 1000)).toISOString(),
        'X-Deal-OS-Scope': 'saved-search',
        'X-Deal-OS-Coverage-Label': encodeURIComponent('HTTP complete saved search'),
        'X-Deal-OS-Expected-Row-Count': '1',
      },
      body: [
        'Listing ID,Business Name,State,Earnings,Revenue,Asking Price,Date Added,View Listing URL,Description',
        'HTTP-FRESH-001,HTTP Supplemental Deal OS Co,TX,$700000,$2800000,$1900000,2026-08-20,https://dealos.example.invalid/http-fresh-001,Recurring service contracts',
      ].join('\n'),
    });
    const imported = await importResponse.json();
    assert.equal(importResponse.status, 201, JSON.stringify(imported));
    assert.equal(imported.review.scoringDeferred, false);

    const firstBackfill = await fetch(`${origin}/api/admin/deal-hunter/backfill-review`, {
      method: 'POST', headers: { Cookie: adminCookie },
    });
    const firstBackfillResult = await firstBackfill.json();
    assert.equal(firstBackfill.status, 200, JSON.stringify(firstBackfillResult));
    assert.equal(firstBackfillResult.review.reviewMode, 'full-backfill');
    assert.equal(firstBackfillResult.review.scoringDeferred, false);
    assert.equal(firstBackfillResult.scoreRefresh.ok, true);

    const beforeResponse = await fetch(`${origin}/api/admin/deal-hunter/triage?view=all&pageSize=100`, {
      headers: { Cookie: adminCookie },
    });
    const before = await beforeResponse.json();
    assert.equal(beforeResponse.status, 200);
    assert.equal(before.rows.some((row) => row.name === 'HTTP Required Sheet Co'), true);
    const supplemental = before.rows.find((row) => row.name === 'HTTP Supplemental Deal OS Co');
    assert.ok(supplemental?.opportunityId, JSON.stringify(before));
    const historicalScore = await getStorage().getDealHunterOpportunityScore(supplemental.opportunityId);
    const historicalEvidence = await getStorage().listDealHunterScoreEvidence(supplemental.opportunityId);
    assert.ok(historicalScore);
    assert.ok(historicalEvidence.length > 0);

    const currentIdsBeforeFailure = before.rows.map((row) => row.opportunityId).sort();
    const scoreHistoryBeforeFailure = await getStorage().listDealHunterOpportunityScores({
      view: 'all', page: 1, pageSize: 100,
    });
    const evidenceBeforeFailure = await Promise.all(scoreHistoryBeforeFailure.rows.map(async (score) => ({
      opportunityId: score.opportunity_id,
      evidence: await getStorage().listDealHunterScoreEvidence(score.opportunity_id),
    })));
    const rescoreEventsBeforeFailure = (await getStorage().listCrmActivityEvents({ limit: 500 }))
      .filter((event) => event.event_type === 'opportunity.rescored');

    requiredSheetFailureAt = requiredSheetFetchCount + 2;
    const deferredBackfill = await fetch(`${origin}/api/admin/deal-hunter/backfill-review`, {
      method: 'POST', headers: { Cookie: adminCookie },
    });
    const deferredBackfillResult = await deferredBackfill.json();
    requiredSheetFailureAt = 0;
    assert.equal(deferredBackfill.status, 200, JSON.stringify(deferredBackfillResult));
    assert.equal(deferredBackfillResult.success, true);
    assert.equal(deferredBackfillResult.review.scoringDeferred, true);
    assert.equal(deferredBackfillResult.scoreRefresh, null);
    assert.match(deferredBackfillResult.reviewWarning, /scoring is deferred.*existing persisted scores were left unchanged/i);

    const realScoreWrite = getStorage().writeDealHunterOpportunityScore.bind(getStorage());
    let failedScoreWriteBackfill;
    let failedScoreWriteResult;
    requiredSheetProfit = 460000;
    try {
      getStorage().writeDealHunterOpportunityScore = async () => {
        throw new Error('injected failure at /private/score-store.sqlite with token=do-not-expose');
      };
      failedScoreWriteBackfill = await fetch(`${origin}/api/admin/deal-hunter/backfill-review`, {
        method: 'POST', headers: { Cookie: adminCookie },
      });
      failedScoreWriteResult = await failedScoreWriteBackfill.json();
    } finally {
      getStorage().writeDealHunterOpportunityScore = realScoreWrite;
      requiredSheetProfit = 450000;
    }

    assert.equal(failedScoreWriteBackfill.status, 500, JSON.stringify(failedScoreWriteResult));
    assert.equal(failedScoreWriteResult.success, false);
    assert.equal(failedScoreWriteResult.scoreRefresh.ok, false);
    assert.equal(failedScoreWriteResult.scoreRefresh.status, 207, 'the nested envelope preserves the service status');
    assert.equal(failedScoreWriteResult.scoreRefresh.counts.failed, 1);
    assert.equal(failedScoreWriteResult.review, undefined, 'failure responses must omit the raw source review');
    assert.equal(failedScoreWriteResult.summary, undefined, 'failure responses must omit the raw source summary');
    assert.match(failedScoreWriteResult.error, /full-backfill scoring could not be completed/i);
    assert.ok(failedScoreWriteResult.error.length <= 500, 'the fallback operator-facing error must be bounded');
    assert.doesNotMatch(JSON.stringify(failedScoreWriteResult), /score-store\.sqlite|do-not-expose|\/private\//i);

    const realReconcile = getStorage().reconcileDealHunterCurrentScoreEligibility.bind(getStorage());
    let failedBackfill;
    let failedBackfillResult;
    try {
      getStorage().reconcileDealHunterCurrentScoreEligibility = async () => {
        throw new Error('injected failure at /private/operator.sqlite with token=do-not-expose');
      };
      failedBackfill = await fetch(`${origin}/api/admin/deal-hunter/backfill-review`, {
        method: 'POST', headers: { Cookie: adminCookie },
      });
      failedBackfillResult = await failedBackfill.json();
    } finally {
      getStorage().reconcileDealHunterCurrentScoreEligibility = realReconcile;
    }

    assert.equal(failedBackfill.status, 503, JSON.stringify(failedBackfillResult));
    assert.equal(failedBackfillResult.success, false);
    assert.equal(failedBackfillResult.scoreRefresh.ok, false);
    assert.equal(failedBackfillResult.scoreRefresh.status, 503);
    assert.equal(failedBackfillResult.review, undefined, 'failure responses must omit the raw source review');
    assert.equal(failedBackfillResult.summary, undefined, 'failure responses must omit the raw source summary');
    assert.match(failedBackfillResult.error, /current-triage eligibility could not be reconciled/i);
    assert.ok(failedBackfillResult.error.length <= 500, 'the operator-facing error must be bounded');
    assert.doesNotMatch(JSON.stringify(failedBackfillResult), /operator\.sqlite|do-not-expose|\/private\//i);

    const currentAfterFailureResponse = await fetch(`${origin}/api/admin/deal-hunter/triage?view=all&pageSize=100`, {
      headers: { Cookie: adminCookie },
    });
    const currentAfterFailure = await currentAfterFailureResponse.json();
    assert.equal(currentAfterFailureResponse.status, 200);
    assert.deepEqual(
      currentAfterFailure.rows.map((row) => row.opportunityId).sort(),
      currentIdsBeforeFailure,
      'failed reconciliation preserves the last-known-good current-triage set',
    );
    assert.deepEqual(
      await getStorage().listDealHunterOpportunityScores({ view: 'all', page: 1, pageSize: 100 }),
      scoreHistoryBeforeFailure,
      'failed reconciliation preserves historical scores',
    );
    for (const snapshot of evidenceBeforeFailure) {
      assert.deepEqual(
        await getStorage().listDealHunterScoreEvidence(snapshot.opportunityId),
        snapshot.evidence,
        `failed reconciliation preserves evidence for ${snapshot.opportunityId}`,
      );
    }
    assert.deepEqual(
      (await getStorage().listCrmActivityEvents({ limit: 500 }))
        .filter((event) => event.event_type === 'opportunity.rescored'),
      rescoreEventsBeforeFailure,
      'failed reconciliation must not fabricate a rescore activity event',
    );

    Date.now = () => baseNow + (80 * 60 * 60 * 1000);
    const staleBackfill = await fetch(`${origin}/api/admin/deal-hunter/backfill-review`, {
      method: 'POST', headers: { Cookie: adminCookie },
    });
    const staleBackfillResult = await staleBackfill.json();
    assert.equal(staleBackfill.status, 200, JSON.stringify(staleBackfillResult));
    assert.equal(staleBackfillResult.review.reviewMode, 'full-backfill');
    assert.equal(staleBackfillResult.review.scoringDeferred, false, 'the required Sheet remains healthy');
    assert.equal(staleBackfillResult.scoreRefresh.ok, true);

    const afterResponse = await fetch(`${origin}/api/admin/deal-hunter/triage?view=all&pageSize=100`, {
      headers: { Cookie: adminCookie },
    });
    const after = await afterResponse.json();
    assert.equal(after.rows.some((row) => row.opportunityId === supplemental.opportunityId), false);
    assert.equal(after.rows.some((row) => row.name === 'HTTP Required Sheet Co'), true);
    const inactiveDetail = await fetch(
      `${origin}/api/admin/deal-hunter/triage/${encodeURIComponent(supplemental.opportunityId)}`,
      { headers: { Cookie: adminCookie } },
    );
    assert.equal(inactiveDetail.status, 404);
    assert.equal(
      (await getStorage().getDealHunterOpportunityScore(supplemental.opportunityId)).score_fingerprint,
      historicalScore.score_fingerprint,
    );
    assert.equal(
      (await getStorage().listDealHunterScoreEvidence(supplemental.opportunityId)).length,
      historicalEvidence.length,
    );
  });
});

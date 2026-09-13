import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-review-read-only-'));
const sqlitePath = path.join(tempDir, 'review-read-only.sqlite');
const sheetUrl = 'https://example.invalid/review-read-only.csv';

process.env.ADMIN_SESSION_SECRET = 'review-read-only-session-secret-for-tests';
process.env.SQLITE_PATH = sqlitePath;
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.DEAL_HUNTER_SHEET_CSV_URL = sheetUrl;
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
process.env.DEAL_HUNTER_CIM_OUTREACH_PAUSED = 'true';
process.env.DEAL_HUNTER_CIM_AUTOMATION_PAUSED = 'true';
process.env.DEAL_HUNTER_CIM_AUTOMATION_STAGE = '1';
process.env.DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED = 'false';
process.env.DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED = 'false';

const originalFetch = globalThis.fetch;
let sourceCsv = [
  'Business Name,State,Earnings,Revenue,Asking Price,Date Added,View Listing URL,Description,Broker Email',
  `Read-Only Review Fire Safety,NY,$450000,$1200000,$900000,${new Date().toISOString().slice(0, 10)},https://listings.example.invalid/review-read-only,Recurring commercial fire inspection and monitoring contracts with trained technicians and stable customers.,broker@example.test`,
].join('\n');

globalThis.fetch = async (input, init) => {
  if (String(input) === sheetUrl) {
    return new Response(sourceCsv, { status: 200, headers: { 'content-type': 'text/csv' } });
  }
  return originalFetch(input, init);
};

const { createApp } = await import('../server/app.js');
const { reviewDailyDeals } = await import('../server/services/dealHunter.js');
const { getStorage } = await import('../server/storage/index.js');
const { signPayload } = await import('../server/utils/security.js');

const businessTables = [
  'contact_submissions',
  'crm_communications',
  'deal_hunter_cim_requests',
  'deal_hunter_crm_imports',
  'deal_hunter_crm_reconciliation_items',
  'deal_hunter_crm_reconciliation_runs',
  'deal_hunter_dispositions',
  'deal_hunter_identity_exceptions',
  'deal_hunter_opportunities',
  'deal_hunter_opportunity_aliases',
  'deal_hunter_opportunity_scores',
  'deal_hunter_opportunity_source_observations',
  'deal_hunter_seen_deals',
  'email_events',
  'scheduled_job_runs',
];

const consumedReviewFields = [
  'generatedAt',
  'reviewMode',
  'lookbackDays',
  'selection',
  'profile',
  'sources',
  'disabledSources',
  'coverageWarnings',
  'scoringDeferred',
  'cimOutreachPause',
  'dealOsImportPolicy',
  'crmSyncPreview',
  'totals',
  'criteriaRecommendations',
  'newlySeenMatches',
  'qualified',
  'watchlist',
  'removalCandidates',
  'identityExceptions',
  'importSummary',
  'cimAutomation',
  'dailyEmailJob',
  'emailReadiness',
];

function tableFingerprint(table) {
  assert.match(table, /^[a-z_]+$/);
  const output = execFileSync(
    '/usr/bin/sqlite3',
    ['-readonly', '-json', sqlitePath, `SELECT * FROM "${table}" ORDER BY rowid`],
    { encoding: 'utf8' },
  );
  const rows = JSON.parse(output || '[]');
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}

function databaseState(tables) {
  return Object.fromEntries(tables.map((table) => [table, tableFingerprint(table)]));
}

function findReviewDeal(review, name) {
  return [
    ...(review.newlySeenMatches || []),
    ...(review.qualified || []),
    ...(review.watchlist || []),
    ...(review.removalCandidates || []),
  ].find((deal) => deal.name === name);
}

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

async function adminCookie(storage) {
  const now = new Date();
  const session = {
    id: randomUUID(),
    role: 'admin',
    username: 'admin',
    principal_id: 'admin:primary',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    last_seen_at: now.toISOString(),
    revoked_at: null,
    created_ip_hash: null,
    user_agent: 'review-read-only-test',
    metadata: { auth_method: 'test-fixture' },
  };
  await storage.insertAdminSession(session);
  const token = signPayload({
    sid: session.id,
    role: session.role,
    username: session.username,
    exp: Date.parse(session.expires_at),
  }, process.env.ADMIN_SESSION_SECRET);
  return `ug_admin_session=${token}`;
}

test.after(() => {
  globalThis.fetch = originalFetch;
  getStorage().close?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('authenticated review stays read-only and materializes fresh ambiguity only at the explicit backfill boundary', async () => {
  const storage = getStorage();

  // Seed through the real persist-capable workflow so the GET encounters an
  // existing canonical alias match—the production case where allowCreate=false
  // alone would still upsert the matched opportunity.
  const seededReview = await reviewDailyDeals({ storage });
  assert.equal(seededReview.totals.reviewedDeals, 1);
  const [opportunity] = await storage.listCurrentDealHunterOpportunities({ limit: 10 });
  assert.ok(opportunity?.opportunity_id);
  await storage.upsertDealHunterOpportunity({
    ...opportunity,
    updated_at: '2026-09-12T00:00:00.000Z',
  });

  const cookie = await adminCookie(storage);
  const before = databaseState(businessTables);
  const snapshotsBefore = databaseState(['source_health_snapshots']).source_health_snapshots;

  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/admin/deal-hunter/review`, {
      headers: { Cookie: cookie },
    });
    const payload = await response.json();

    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.success, true);
    for (const field of consumedReviewFields) {
      assert.equal(Object.hasOwn(payload.review, field), true, `missing Operations review field: ${field}`);
    }
    assert.equal(payload.review.totals.reviewedDeals, 1);
    assert.equal(payload.review.sources.some((source) => source.id === 'sheet-0' && source.fetched), true);
  });

  const snapshotsAfter = databaseState(['source_health_snapshots']).source_health_snapshots;
  assert.equal(snapshotsAfter.count, snapshotsBefore.count + 1, 'the bounded admin source-health snapshot remains');
  assert.deepEqual(
    databaseState(businessTables),
    before,
    'an observational review must not alter canonical identity, CRM, score, scheduling, CIM, or outbound state',
  );

  // A new listing can be strongly corroborated against the existing canonical
  // opportunity while supplying a different recipient and durable listing URL.
  // That is ambiguous rather than an automatic identity match.
  sourceCsv = [
    'Business Name,State,Earnings,Revenue,Asking Price,Date Added,View Listing URL,Description,Broker Email',
    `Read-Only Review Fire Safety,NY,$450000,$1200000,$900000,${new Date().toISOString().slice(0, 10)},https://listings.example.invalid/review-read-only-new,Recurring commercial fire inspection and monitoring contracts with trained technicians and stable customers.,new-broker@example.test`,
  ].join('\n');

  assert.equal((await storage.listDealHunterIdentityExceptions({ statuses: ['open'] })).length, 0);
  const ambiguousBefore = databaseState(businessTables);
  let observedExceptionId = '';
  let candidateOpportunityId = '';

  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/admin/deal-hunter/review`, {
      headers: { Cookie: cookie },
    });
    const payload = await response.json();

    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.success, true);
    assert.deepEqual(payload.review.identityExceptions, [], 'GET exposes no unpersisted item as directly resolvable');
    const observed = findReviewDeal(payload.review, 'Read-Only Review Fire Safety');
    assert.ok(observed, 'the newly ambiguous listing remains visible in the Operations review');
    assert.equal(observed.identityStatus, 'ambiguous');
    assert.match(observed.identityExceptionId, /^[a-f0-9]{64}$/);
    assert.equal(observed.cimRequest.canRequest, false);
    assert.match(observed.cimRequest.reason, /identity is ambiguous.*resolve it before outreach/i);
    assert.equal(
      payload.review.cimAutomation.run.exceptions.some((item) => item.dealKey === observed.dealKey),
      false,
      'an ambiguous listing is excluded from the automation candidate preview rather than presented as sendable',
    );
    observedExceptionId = observed.identityExceptionId;

    const listed = await fetch(`${origin}/api/admin/deal-hunter/identity-exceptions`, {
      headers: { Cookie: cookie },
    });
    const listedPayload = await listed.json();
    assert.equal(listed.status, 200);
    assert.deepEqual(listedPayload.exceptions, []);
  });

  assert.deepEqual(
    databaseState(businessTables),
    ambiguousBefore,
    'detecting a fresh ambiguity through GET must not persist the exception or alter business state',
  );

  await withServer(async (origin) => {
    const backfill = await fetch(`${origin}/api/admin/deal-hunter/backfill-review`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    const backfillPayload = await backfill.json();

    assert.equal(backfill.status, 200, JSON.stringify(backfillPayload));
    assert.equal(backfillPayload.success, true);
    assert.equal(backfillPayload.review.scoringDeferred, true);
    assert.match(backfillPayload.review.scoringDeferredReason, /canonical identity exception.*resolved/i);
    assert.match(backfillPayload.reviewWarning, /identity exception.*resolved.*scores were left unchanged/i);
    assert.equal(backfillPayload.scoreRefresh, null);
    const persisted = backfillPayload.review.identityExceptions.find((item) => item.id === observedExceptionId);
    assert.ok(persisted, 'the explicit full-backfill action materializes the observed exception');
    assert.equal(persisted.reason, 'ambiguous-similarity');
    assert.equal(persisted.candidateOpportunityIds.length, 1);
    [candidateOpportunityId] = persisted.candidateOpportunityIds;
    assert.equal(candidateOpportunityId, opportunity.opportunity_id);

    const listed = await fetch(`${origin}/api/admin/deal-hunter/identity-exceptions`, {
      headers: { Cookie: cookie },
    });
    const listedPayload = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listedPayload.exceptions.some((item) => item.id === observedExceptionId && item.status === 'open'), true);

    const resolved = await fetch(`${origin}/api/admin/deal-hunter/identity-exceptions/${observedExceptionId}/resolve`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'link',
        opportunityId: candidateOpportunityId,
        confirmed: true,
        reason: 'Fresh listing is the existing canonical opportunity.',
      }),
    });
    const resolvedPayload = await resolved.json();
    assert.equal(resolved.status, 200, JSON.stringify(resolvedPayload));
    assert.equal(resolvedPayload.success, true);
    assert.equal(resolvedPayload.identityException.status, 'resolved');

    const refreshed = await fetch(`${origin}/api/admin/deal-hunter/review`, {
      headers: { Cookie: cookie },
    });
    const refreshedPayload = await refreshed.json();
    assert.equal(refreshed.status, 200, JSON.stringify(refreshedPayload));
    assert.deepEqual(refreshedPayload.review.identityExceptions, []);
    const linked = findReviewDeal(refreshedPayload.review, 'Read-Only Review Fire Safety');
    assert.equal(linked.identityStatus, 'resolved');
    assert.equal(linked.opportunityId, candidateOpportunityId);
  });

  const [resolvedException] = await storage.listDealHunterIdentityExceptions({ statuses: ['resolved'] });
  assert.equal(resolvedException.id, observedExceptionId);
  assert.equal((await storage.listDealHunterCimRequests({ limit: 100 })).length, 0);
  assert.equal((await storage.listEmailEvents({ limit: 100 })).length, 0);
});

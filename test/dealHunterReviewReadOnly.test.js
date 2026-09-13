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
const sourceCsv = [
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

test('authenticated Deal Hunter review preserves business rows and only records source health', async () => {
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
});

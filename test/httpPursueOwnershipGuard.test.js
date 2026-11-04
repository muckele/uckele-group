import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-pursue-ownership-'));
process.env.ADMIN_SESSION_SECRET = 'http-pursue-ownership-secret';
process.env.SQLITE_PATH = path.join(tempDir, 'pursue-ownership.sqlite');
process.env.DELIVERY_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 're_test_local_only';
process.env.RESEND_FROM_EMAIL = 'buyer@example.test';
process.env.RESEND_REPLY_TO = 'replies@example.test';
process.env.LEAD_NOTIFICATION_EMAIL = 'admin@example.test';
process.env.DEAL_HUNTER_SHEET_CSV_URLS = 'https://example.test/http-pursue-ownership.csv';
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_LOOKBACK_DAYS = '30';
process.env.DEAL_HUNTER_CIM_RECIPIENT_24_HOUR_CAP = '100';
process.env.DEAL_HUNTER_CIM_RECIPIENT_30_DAY_TOUCH_CAP = '100';

const today = new Date().toISOString().slice(0, 10);
const sourceCsv = [
  'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Profit Multiple,Broker Name,Broker Email,Contact Name 2,Contact Email 2,Listing URL,Description',
  `"Commercial Safety Services","Fire safety inspection maintenance","CA","${today}","$450,000","$1,800,000","$1,400,000","3.1","Erin Broker","erin@example.com","Alex Contact","alex@example.com","https://broker.example.test/listing-42","Recurring commercial inspection, maintenance contracts, compliance work, trained field technicians, management in place, SBA eligible."`,
].join('\n');

const originalFetch = globalThis.fetch;
let providerCalls = 0;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.startsWith('http://127.0.0.1:')) return originalFetch(url, options);
  if (target === 'https://example.test/http-pursue-ownership.csv') {
    return new Response(sourceCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
  }
  if (target.startsWith('https://api.resend.com/')) {
    providerCalls += 1;
    return Response.json({ id: `resend-message-${providerCalls}` });
  }
  return new Response('not found', { status: 404 });
};

const { createApp } = await import('../server/app.js');
const { getStorage } = await import('../server/storage/index.js');
const { reviewDailyDeals } = await import('../server/services/dealHunter.js');

test.after(() => {
  globalThis.fetch = originalFetch;
  getStorage().close?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function login(origin) {
  const response = await fetch(`${origin}/api/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.71' },
    body: JSON.stringify({ username: 'admin', password: 'change-me-now' }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('POST /api/admin/deal-hunter/cim-request returns 409 pursue_owns_opportunity with the drawer copy', async () => {
  const storage = getStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);
  assert.ok(deal, 'fixture should produce a CIM-ready opportunity');
  const database = new Database(process.env.SQLITE_PATH);
  try {
    database.prepare(`
      INSERT INTO deal_hunter_owner_decision_events (
        id, idempotency_key, request_digest, opportunity_id, action, actor,
        expected_discovery_revision, expected_material_revision,
        observed_discovery_revision, observed_material_revision, policy_version, created_at
      ) VALUES ('http-guard-decision', 'http-guard-decision', ?, ?, 'pursue', 'http-guard-owner',
        0, 0, 0, 0, 'owner-decision-v1', ?)
    `).run(createHash('sha256').update('http-guard').digest('hex'), deal.opportunityId, new Date().toISOString());
  } finally {
    database.close();
  }

  await withServer(async (origin) => {
    const cookie = await login(origin);
    const response = await fetch(`${origin}/api/admin/deal-hunter/cim-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dealKey: deal.dealKey, snapshotToken: deal.cimRequest.snapshotToken }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.success, false);
    assert.equal(body.code, 'pursue_owns_opportunity');
    assert.equal(body.error, 'This deal is in a SIM request campaign — manage it from the drawer.');
  });
  assert.equal(providerCalls, 0);
  assert.equal((await storage.listDealHunterCimRequests({ dealKeys: [deal.dealKey], limit: 100 })).length, 0);
});

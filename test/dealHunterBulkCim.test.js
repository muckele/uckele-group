import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.DELIVERY_PROVIDER = 'resend';
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM_EMAIL;
process.env.DEAL_HUNTER_SHEET_CSV_URLS = 'https://example.test/deals.csv';
process.env.DEAL_HUNTER_AIRTABLE_SHARED_VIEW_URL = 'https://example.test/appEGxhjno0HTpEco/shrUhtbnzZTPaR4Lk';
process.env.DEAL_HUNTER_LOOKBACK_DAYS = '30';
process.env.ADMIN_SESSION_SECRET = 'deal-hunter-bulk-cim-session-secret';

const originalFetch = globalThis.fetch;
const originalConsoleWarn = console.warn;
const today = new Date().toISOString().slice(0, 10);
const sourceCsv = [
  'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Broker Email,Description',
  `"Commercial HVAC Maintenance Co","Commercial HVAC maintenance","CA","${today}","$450,000","$1,800,000","$1,400,000","broker@example.com","Recurring maintenance contracts, service agreements, scheduled maintenance, field technicians, repair, replacement, compliance work, trained staff, management in place, SBA eligible, seller financing available."`,
].join('\n');

before(() => {
  console.warn = () => {};
  globalThis.fetch = async (url) => {
    if (String(url).includes('/deals.csv')) {
      return new Response(sourceCsv, {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      });
    }

    return new Response('not found', { status: 404 });
  };
});

after(() => {
  console.warn = originalConsoleWarn;
  globalThis.fetch = originalFetch;
});

function createCimStorage() {
  const requests = new Map();

  return {
    requests,
    async listDealHunterSeenDeals() {
      return [];
    },
    async listDealHunterCimRequests() {
      return Array.from(requests.values());
    },
    async getDealHunterCimRequest({ dealKey, recipientEmail }) {
      return requests.get(`${dealKey}|${recipientEmail}`) || null;
    },
    async upsertDealHunterCimRequest(request) {
      requests.set(`${request.deal_key}|${request.recipient_email}`, request);
      return request;
    },
  };
}

test('bulk CIM send fails when every selected email fails', async () => {
  const { sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    limit: 1,
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.match(result.error, /No CIM request emails were sent/);
});

test('bulk CIM send fails closed when confirmed recipient no longer matches source review', async () => {
  const { reviewDailyDeals, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);

  assert.ok(deal, 'expected one CIM-ready deal in fixture review');

  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [
      {
        dealKey: deal.dealKey,
        recipientEmail: 'changed-broker@example.com',
      },
    ],
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(storage.requests.size, 0);
  assert.match(result.error, /list changed/i);
});

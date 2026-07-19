import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

process.env.DELIVERY_PROVIDER = 'resend';
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM_EMAIL;
process.env.DEAL_HUNTER_SHEET_CSV_URLS = 'https://example.test/deals.csv';
process.env.DEAL_HUNTER_AIRTABLE_SHARED_VIEW_URL = 'https://example.test/appEGxhjno0HTpEco/shrUhtbnzZTPaR4Lk';
process.env.DEAL_HUNTER_LOOKBACK_DAYS = '30';
process.env.ADMIN_SESSION_SECRET = 'deal-hunter-bulk-cim-session-secret';

const originalFetch = globalThis.fetch;
const originalConsoleWarn = console.warn;
let sourceFetchMode = 'ok';
const today = new Date().toISOString().slice(0, 10);
const sourceCsv = [
  'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Broker Email,Description',
  `"Commercial HVAC Maintenance Co","Commercial HVAC maintenance","CA","${today}","$450,000","$1,800,000","$1,400,000","broker@example.com","Recurring maintenance contracts, service agreements, scheduled maintenance, field technicians, repair, replacement, compliance work, trained staff, management in place, SBA eligible, seller financing available."`,
].join('\n');
const emptySourceCsv = 'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Broker Email,Description';

before(() => {
  console.warn = () => {};
  globalThis.fetch = async (url) => {
    if (String(url).includes('/deals.csv')) {
      if (sourceFetchMode === 'down') {
        return new Response('source unavailable', { status: 503 });
      }

      return new Response(sourceFetchMode === 'empty' ? emptySourceCsv : sourceCsv, {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      });
    }

    return new Response('not found', { status: 404 });
  };
});

beforeEach(() => {
  sourceFetchMode = 'ok';
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

test('bulk CIM send accepts an edited recipient only with the signed reviewed snapshot', async () => {
  const { reviewDailyDeals, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);

  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{
      dealKey: deal.dealKey,
      recipientEmail: 'corrected-broker@example.com',
      snapshotToken: deal.cimRequest.snapshotToken,
    }],
    storage,
  });
  const [request] = Array.from(storage.requests.values());

  assert.equal(result.status, 502);
  assert.equal(result.failed, 1);
  assert.equal(storage.requests.size, 1);
  assert.equal(request.recipient_email, 'corrected-broker@example.com');
});

test('approval evidence is derived from a signed queue snapshot', async () => {
  const { reviewDailyDeals, validateCimReviewDecisions } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);
  const valid = validateCimReviewDecisions([{
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    decision: 'approved',
    finalRecipientEmail: 'corrected-broker@example.com',
    dealName: 'Client-controlled name',
    score: 100,
  }]);

  assert.equal(valid.valid, true);
  assert.equal(valid.decisions[0].dealName, deal.name);
  assert.equal(valid.decisions[0].score, deal.score);
  assert.equal(valid.decisions[0].originalRecipientEmail, deal.brokerEmail);
  assert.equal(valid.decisions[0].finalRecipientEmail, 'corrected-broker@example.com');

  const forged = validateCimReviewDecisions([{
    dealKey: deal.dealKey,
    snapshotToken: 'forged',
    decision: 'approved',
    finalRecipientEmail: 'attacker@example.com',
  }]);
  assert.equal(forged.valid, false);
});

test('bulk CIM send uses confirmed snapshots when a source review is incomplete', async () => {
  const { reviewDailyDeals, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);

  assert.ok(deal, 'expected one CIM-ready deal in fixture review');
  assert.ok(deal.cimRequest.snapshotToken, 'expected a signed CIM snapshot token');

  sourceFetchMode = 'down';

  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [
      {
        dealKey: deal.dealKey,
        recipientEmail: deal.cimRequest.recipientEmail,
        snapshotToken: deal.cimRequest.snapshotToken,
      },
    ],
    storage,
  });
  const [request] = Array.from(storage.requests.values());

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(storage.requests.size, 1);
  assert.equal(request.deal_key, deal.dealKey);
  assert.equal(request.recipient_email, deal.cimRequest.recipientEmail);
  assert.doesNotMatch(result.error, /list changed/i);
});

test('bulk CIM send ignores raw client snapshots without a signed token', async () => {
  const { reviewDailyDeals, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);

  assert.ok(deal, 'expected one CIM-ready deal in fixture review');
  const unsignedDeal = {
    ...deal,
    cimRequest: {
      ...deal.cimRequest,
      snapshotToken: '',
    },
  };

  sourceFetchMode = 'down';

  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [
      {
        dealKey: deal.dealKey,
        recipientEmail: deal.cimRequest.recipientEmail,
        deal: unsignedDeal,
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

test('bulk CIM send does not use stale snapshot when selected source still fetched without the deal', async () => {
  const { reviewDailyDeals, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);

  assert.ok(deal, 'expected one CIM-ready deal in fixture review');

  sourceFetchMode = 'empty';

  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [
      {
        dealKey: deal.dealKey,
        recipientEmail: deal.cimRequest.recipientEmail,
        snapshotToken: deal.cimRequest.snapshotToken,
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

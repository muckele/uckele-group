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
  'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Broker Name,Broker Email,Contact Name 2,Contact Email 2,Description',
  `"Commercial HVAC Maintenance Co","Commercial HVAC maintenance","CA","${today}","$450,000","$1,800,000","$1,400,000","Erin Broker","erin@example.com","Alex Contact","alex@example.com","Recurring maintenance contracts, service agreements, scheduled maintenance, field technicians, repair, replacement, compliance work, trained staff, management in place, SBA eligible, seller financing available."`,
].join('\n');
const emptySourceCsv = 'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Broker Name,Broker Email,Contact Name 2,Contact Email 2,Description';

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
  const { reviewDailyDeals, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);
  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{
      dealKey: deal.dealKey,
      recipientEmail: deal.cimRequest.recipientEmail,
      snapshotToken: deal.cimRequest.snapshotToken,
    }],
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.match(result.error, /No CIM request emails were sent/);
});

test('bulk CIM send rejects a changed recipient without a signed snapshot', async () => {
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
  assert.equal(result.status, 400);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  assert.equal(storage.requests.size, 0);
  assert.match(result.error, /signed approval queue/i);
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

test('bulk CIM send accepts a signed alternate contact and uses that contact in the greeting metadata', async () => {
  const { reviewDailyDeals, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);

  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{
      dealKey: deal.dealKey,
      recipientEmail: 'alex@example.com',
      recipientName: 'Client-controlled wrong name',
      snapshotToken: deal.cimRequest.snapshotToken,
    }],
    storage,
  });
  const [request] = Array.from(storage.requests.values());

  assert.equal(result.status, 502);
  assert.equal(request.recipient_email, 'alex@example.com');
  assert.equal(request.metadata.brokerName, 'Alex Contact');
});

test('source-healthy bulk send rejects an exact recipient without a signed snapshot', async () => {
  const { reviewDailyDeals, sendDealHunterCimRequest, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);

  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{ dealKey: deal.dealKey, recipientEmail: deal.brokerEmail, snapshotToken: '' }],
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(storage.requests.size, 0);
  assert.match(result.error, /signed approval queue/i);

  const directResult = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: '',
    requestedBy: 'test-admin',
    storage,
  });
  assert.equal(directResult.ok, false);
  assert.equal(directResult.status, 400);
  assert.equal(storage.requests.size, 0);
});

test('a completed request to an alternate contact suppresses all further first contact for the deal', async () => {
  const { reviewDailyDeals, sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const initialReview = await reviewDailyDeals({ storage });
  const initialDeal = initialReview.qualified.find((item) => item.cimRequest?.canRequest);
  const sentAt = new Date().toISOString();

  storage.requests.set(`${initialDeal.dealKey}|alex@example.com`, {
    id: 'alternate-request',
    deal_key: initialDeal.dealKey,
    deal_name: initialDeal.name,
    recipient_email: 'alex@example.com',
    status: 'sent',
    created_at: sentAt,
    updated_at: sentAt,
    provider_message_id: 'provider-alternate',
    metadata: {},
  });

  const refreshedReview = await reviewDailyDeals({ storage });
  const refreshedDeal = refreshedReview.qualified.find((item) => item.dealKey === initialDeal.dealKey);
  assert.equal(refreshedDeal.cimRequest.canRequest, false);
  assert.equal(refreshedDeal.cimRequest.status, 'sent');
  assert.equal(refreshedDeal.cimRequest.recipientEmail, 'alex@example.com');

  const retry = await sendDealHunterCimRequest({
    dealKey: refreshedDeal.dealKey,
    snapshotToken: refreshedDeal.cimRequest.snapshotToken,
    requestedBy: 'test-admin',
    storage,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.alreadySent, true);
  assert.equal(retry.request.recipient_email, 'alex@example.com');
  assert.equal(storage.requests.size, 1);
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

  const alternate = validateCimReviewDecisions([{
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    decision: 'approved',
    finalRecipientEmail: 'alex@example.com',
    finalRecipientName: 'Client-controlled wrong name',
  }]);
  assert.equal(alternate.valid, true);
  assert.equal(alternate.decisions[0].finalRecipientName, 'Alex Contact');

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

test('source-outage fallback permits an alternate contact only when it is present in the signed snapshot', async () => {
  const { reviewDailyDeals, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);

  sourceFetchMode = 'down';
  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{
      dealKey: deal.dealKey,
      recipientEmail: 'alex@example.com',
      recipientName: 'Forged name',
      snapshotToken: deal.cimRequest.snapshotToken,
    }],
    storage,
  });
  const [request] = Array.from(storage.requests.values());

  assert.equal(result.status, 502);
  assert.equal(request.recipient_email, 'alex@example.com');
  assert.equal(request.metadata.brokerName, 'Alex Contact');
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
  assert.equal(result.status, 400);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  assert.equal(storage.requests.size, 0);
  assert.match(result.error, /signed approval queue/i);
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

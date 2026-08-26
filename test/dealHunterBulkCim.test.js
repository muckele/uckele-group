import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

process.env.DELIVERY_PROVIDER = 'resend';
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM_EMAIL;
process.env.DEAL_HUNTER_SHEET_CSV_URLS = 'https://example.test/deals.csv';
process.env.DEAL_HUNTER_AIRTABLE_SHARED_VIEW_URL = 'https://example.test/appEGxhjno0HTpEco/shrUhtbnzZTPaR4Lk';
process.env.DEAL_HUNTER_AIRTABLE_TOKEN = 'test-token';
process.env.DEAL_HUNTER_AIRTABLE_BASE_ID = 'appTest';
process.env.DEAL_HUNTER_AIRTABLE_TABLE_ID = 'tblTest';
process.env.DEAL_HUNTER_LOOKBACK_DAYS = '30';
process.env.ADMIN_SESSION_SECRET = 'deal-hunter-bulk-cim-session-secret';

const originalFetch = globalThis.fetch;
const originalConsoleWarn = console.warn;
let sourceFetchMode = 'ok';
const today = new Date().toISOString().slice(0, 10);
const sourceCsv = [
  'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Broker Name,Broker Company,Broker Contact,Broker Email,Contact Name 2,Contact Email 2,Listing URL,Description',
  `"Commercial HVAC Maintenance Co","Commercial HVAC maintenance","CA","${today}","$450,000","$1,800,000","$1,400,000","Erin Broker","West Coast Business Brokers","310-555-0199","erin@example.com","Alex Contact","alex@example.com","https://broker.example.test/hvac-maintenance","Recurring maintenance contracts, service agreements, scheduled maintenance, field technicians, repair, replacement, compliance work, trained staff, management in place, SBA eligible, seller financing available."`,
].join('\n');
const emptySourceCsv = 'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Broker Name,Broker Company,Broker Contact,Broker Email,Contact Name 2,Contact Email 2,Listing URL,Description';
const replacementSourceCsv = [
  emptySourceCsv,
  `"Industrial Fire Safety Inspections","Fire safety inspection","NY","${today}","$525,000","$2,100,000","$1,500,000","River Broker","East Coast Business Brokers","212-555-0135","river@example.com","","","https://broker.example.test/industrial-fire-inspections","Recurring commercial inspection contracts, regulated compliance testing, essential field technicians, trained staff, management in place, SBA eligible, and seller financing available."`,
].join('\n');
let activeSourceCsv = sourceCsv;

before(() => {
  console.warn = () => {};
  globalThis.fetch = async (url) => {
    if (String(url).includes('/deals.csv')) {
      if (sourceFetchMode === 'down') {
        return new Response('source unavailable', { status: 503 });
      }

      return new Response(sourceFetchMode === 'empty' ? emptySourceCsv : activeSourceCsv, {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      });
    }

    if (String(url).includes('api.airtable.com')) {
      return Response.json({ records: [] });
    }

    return new Response('not found', { status: 404 });
  };
});

beforeEach(() => {
  sourceFetchMode = 'ok';
  activeSourceCsv = sourceCsv;
});

after(() => {
  console.warn = originalConsoleWarn;
  globalThis.fetch = originalFetch;
});

function createCimStorage() {
  const requests = new Map();
  const submissions = new Map();
  const communications = new Map();
  const activities = [];
  const opportunities = new Map();
  const opportunityAliases = new Map();
  const identityExceptions = new Map();
  const opportunityClaims = new Map();
  const recipientClaims = new Map();

  function requestKey(request) {
    return `${request.deal_key}|${request.recipient_email}`;
  }

  function saveRequest(request) {
    requests.set(requestKey(request), request);
    return request;
  }

  return {
    requests,
    submissions,
    communications,
    activities,
    opportunities,
    async listDealHunterSeenDeals() {
      return [];
    },
    async listDealHunterCimRequests({ dealKeys = [], opportunityIds = [], recipientEmails = [] } = {}) {
      return Array.from(requests.values()).filter((request) => (
        (dealKeys.length === 0 || dealKeys.includes(request.deal_key))
        && (opportunityIds.length === 0 || opportunityIds.includes(request.opportunity_id))
        && (recipientEmails.length === 0 || recipientEmails.includes(request.recipient_email))
      ));
    },
    async getDealHunterCimRequest({ dealKey, recipientEmail }) {
      return requests.get(`${dealKey}|${recipientEmail}`) || null;
    },
    async getDealHunterCimRequestById(id) {
      return Array.from(requests.values()).find((request) => request.id === id) || null;
    },
    async upsertDealHunterCimRequest(request) {
      return saveRequest(request);
    },
    async getDealHunterOpportunity(opportunityId) {
      return opportunities.get(opportunityId) || null;
    },
    async listDealHunterOpportunities({ opportunityIds = [], recipientEmails = [] } = {}) {
      return Array.from(opportunities.values()).filter((opportunity) => (
        (opportunityIds.length === 0 || opportunityIds.includes(opportunity.opportunity_id))
        && (recipientEmails.length === 0 || recipientEmails.includes(opportunity.canonical_recipient))
      ));
    },
    async findDealHunterOpportunityByAliases(aliasKeys = []) {
      const ids = [...new Set(aliasKeys.map((key) => opportunityAliases.get(key)?.opportunity_id).filter(Boolean))];
      if (ids.length > 1) throw new Error('conflicting aliases');
      return ids[0] ? opportunities.get(ids[0]) : null;
    },
    async upsertDealHunterOpportunity(opportunity) {
      opportunities.set(opportunity.opportunity_id, opportunity);
      return opportunity;
    },
    async listDealHunterOpportunityAliases({ opportunityIds = [] } = {}) {
      return Array.from(opportunityAliases.values()).filter((item) => (
        opportunityIds.length === 0 || opportunityIds.includes(item.opportunity_id)
      ));
    },
    async upsertDealHunterOpportunityAlias(item) {
      const existing = opportunityAliases.get(item.alias_key);
      if (existing && existing.opportunity_id !== item.opportunity_id) return existing;
      opportunityAliases.set(item.alias_key, item);
      return item;
    },
    async upsertDealHunterIdentityException(item) {
      identityExceptions.set(item.id, item);
      return item;
    },
    async getDealHunterCimSafetySettings() {
      return null;
    },
    async claimDealHunterCimOpportunity({ opportunityId, requestId, recipientEmail, allowedRequestIds = [], nowIso, metadata = {} }) {
      const existing = opportunityClaims.get(opportunityId);
      if (existing && ![requestId, ...allowedRequestIds].includes(existing.request_id)) {
        return { claimed: false, reason: 'opportunity-already-claimed', claim: existing };
      }
      const claim = { opportunity_id: opportunityId, request_id: requestId, recipient_email: recipientEmail, claimed_at: nowIso, metadata };
      opportunityClaims.set(opportunityId, claim);
      return { claimed: true, reason: '', claim };
    },
    async claimDealHunterCimRecipient({ recipientEmail, requestId, opportunityId, nowIso, expiresAt, metadata = {} }) {
      const existing = recipientClaims.get(recipientEmail);
      if (existing && existing.request_id !== requestId && Date.parse(existing.expires_at) > Date.parse(nowIso)) {
        return { claimed: false, reason: 'recipient-send-in-progress', claim: existing };
      }
      const claim = { recipient_email: recipientEmail, request_id: requestId, opportunity_id: opportunityId, claimed_at: nowIso, expires_at: expiresAt, metadata };
      recipientClaims.set(recipientEmail, claim);
      return { claimed: true, reason: '', claim };
    },
    async releaseDealHunterCimRecipientClaim({ recipientEmail, requestId }) {
      if (recipientClaims.get(recipientEmail)?.request_id !== requestId) return false;
      recipientClaims.delete(recipientEmail);
      return true;
    },
    async getSubmission(id) {
      return submissions.get(id) || null;
    },
    async listSubmissions({ search = '' } = {}) {
      const normalizedSearch = String(search || '').trim();
      const rows = Array.from(submissions.values()).filter((submission) => (
        !normalizedSearch
        || submission.metadata?.dealHunter?.dealKey === normalizedSearch
        || String(submission.notes || '').includes(normalizedSearch)
      ));
      return { rows, total: rows.length, page: 1, pageSize: rows.length || 1 };
    },
    async getLatestSecureUploadRequestForSubmission() {
      return null;
    },
    async listSecureDocumentsForSubmission() {
      return [];
    },
    async getCrmCommunication(id) {
      return communications.get(id) || null;
    },
    async insertCrmCommunication(communication) {
      assert.ok(submissions.has(communication.submission_id), 'CRM lead must exist before its communication is persisted');
      assert.ok(
        Array.from(requests.values()).some((request) => request.id === communication.cim_request_id),
        'pending CIM request must exist before its exact communication is persisted',
      );
      communications.set(communication.id, communication);
      return communication;
    },
    async updateCrmCommunication(id, values) {
      const existing = communications.get(id);
      assert.ok(existing, 'communication must already be persisted before delivery state is updated');
      const updated = { ...existing, ...values };
      communications.set(id, updated);
      return updated;
    },
    async mutateWithCrmActivity({ operation, payload, activity }) {
      let record;
      if (operation === 'insert_submission') {
        record = payload.submission;
        submissions.set(record.id, record);
      } else if (operation === 'insert_crm_communication') {
        record = await this.insertCrmCommunication(payload.communication);
      } else if (operation === 'upsert_deal_hunter_cim_request') {
        record = saveRequest(payload.request);
      } else {
        throw new Error(`Unsupported CIM test mutation: ${operation}`);
      }
      activities.push(activity);
      return { applied: true, record, activity };
    },
  };
}

function enableCrmImportClaims(storage) {
  const crmImports = new Map();
  storage.claimDealHunterCrmImport = async (record) => {
    const existing = crmImports.get(record.id);
    if (existing) return { claimed: false, importRecord: existing };
    crmImports.set(record.id, record);
    return { claimed: true, importRecord: record };
  };
  storage.updateDealHunterCrmImport = async (id, values) => {
    const updated = { ...crmImports.get(id), ...values };
    crmImports.set(id, updated);
    return updated;
  };
  storage.updateSubmission = async (id, values) => {
    const updated = { ...storage.submissions.get(id), ...values };
    storage.submissions.set(id, updated);
    return updated;
  };
  return crmImports;
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
  assert.equal(storage.submissions.size, 1);
  assert.equal(storage.communications.size, 1);
  assert.equal(request.recipient_email, 'corrected-broker@example.com');
  const [communication] = Array.from(storage.communications.values());
  assert.equal(communication.submission_id, request.submission_id);
  assert.equal(communication.cim_request_id, request.id);
  assert.deepEqual(communication.to_addresses, ['corrected-broker@example.com']);
  assert.ok(communication.body_text);
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
  assert.equal(storage.submissions.size, 1);
  assert.equal(storage.communications.size, 1);
  assert.equal(request.recipient_email, 'alex@example.com');
  assert.equal(request.metadata.brokerName, 'Alex Contact');
  const [submission] = Array.from(storage.submissions.values());
  assert.equal(submission.broker_name, 'Erin Broker');
  assert.equal(submission.broker_email, 'erin@example.com');
  assert.equal(submission.broker_phone, '310-555-0199');
  assert.equal(submission.metadata.dealHunter.brokerName, 'Erin Broker');
  assert.equal(submission.metadata.dealHunter.brokerCompany, 'West Coast Business Brokers');
  assert.equal(submission.metadata.dealHunter.brokerContact, '310-555-0199');
  assert.equal(submission.metadata.dealHunter.brokerEmail, 'erin@example.com');
  const [communication] = Array.from(storage.communications.values());
  assert.deepEqual(communication.to_addresses, ['alex@example.com']);
  assert.match(communication.body_text, /Alex/);
});

test('bulk CIM send preserves the signed approved copy when template fields change in a later healthy source review', async () => {
  const { reviewDailyDeals, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);
  const approvedPreview = deal.cimRequest.preview;

  activeSourceCsv = sourceCsv.replace(
    'Commercial HVAC maintenance',
    'Commercial HVAC maintenance - changed after approval',
  );

  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{
      dealKey: deal.dealKey,
      recipientEmail: deal.cimRequest.recipientEmail,
      snapshotToken: deal.cimRequest.snapshotToken,
    }],
    storage,
  });
  const [request] = Array.from(storage.requests.values());
  const [communication] = Array.from(storage.communications.values());

  assert.equal(result.status, 502);
  assert.equal(result.failed, 1);
  assert.equal(communication.subject, approvedPreview.subject);
  assert.equal(communication.body_text, approvedPreview.text);
  assert.equal(request.subject, approvedPreview.subject);
  assert.equal(request.metadata.industry, deal.industry);
  assert.doesNotMatch(communication.body_text, /changed after approval/i);
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

test('CIM send paths fail closed when a source review is incomplete', async () => {
  const { reviewDailyDeals, sendDealHunterCimRequest, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
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
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  assert.equal(storage.requests.size, 0);
  assert.match(result.error, /source review is incomplete/i);

  const directResult = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'test-admin',
    storage,
  });
  assert.equal(directResult.ok, false);
  assert.equal(directResult.status, 503);
  assert.equal(storage.requests.size, 0);
  assert.match(directResult.error, /source review is incomplete/i);
});

test('healthy required Sheet with no Deal OS import sends the normal digest with a warning', async () => {
  const { sendDailyDealHunterReview } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  let digestCalls = 0;
  let alertCalls = 0;
  let sentReview;

  const result = await sendDailyDealHunterReview({
    idempotencyKey: 'daily-deal-hunter-email:2026-08-25',
    storage,
    sendDigestEmail: async (options) => {
      digestCalls += 1;
      sentReview = options.review;
      return { status: 'sent', error: '', providerMessageId: 'digest-1' };
    },
    sendSourceAlertEmail: async () => {
      alertCalls += 1;
      return { status: 'sent', error: '', providerMessageId: 'unexpected-alert' };
    },
  });

  assert.equal(result.emailResult.status, 'sent');
  assert.equal(result.notificationType, 'normal-digest');
  assert.equal(digestCalls, 1);
  assert.equal(alertCalls, 0);
  assert.equal(sentReview.sources.some((source) => source.id === 'sheet-0' && source.fetched), true);
  assert.match(sentReview.optionalSourceWarnings[0], /Deal OS import absent/i);
  assert.equal(sentReview.disabledSources[0].sourceRole, 'retired');
});

function supplementalDealOsImport({ exportedAt = new Date().toISOString(), name = 'Supplemental Fire Safety' } = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000099',
    created_at: new Date().toISOString(),
    imported_by: 'admin@example.com',
    exported_at: exportedAt,
    file_name: 'deal-os.csv',
    file_type: 'text/csv',
    file_size: 100,
    file_sha256: 'a'.repeat(64),
    scope: 'saved-search',
    coverage_label: 'All active criteria',
    expected_row_count: 1,
    source_row_count: 1,
    accepted_row_count: 1,
    rejected_row_count: 0,
    canonical_record_count: 1,
    row_count: 1,
    duplicate_count: 0,
    stable_id_count: 1,
    listing_url_count: 1,
    coverage_limit_reached: false,
    records: [{
      stableId: 'DOS-SUPPLEMENT-1',
      name,
      listingUrl: 'https://broker.example.test/supplemental-fire-safety',
      dateAdded: today,
      state: 'CA',
      industry: 'Fire protection and inspection services',
      description: 'Recurring revenue from commercial service contracts and scheduled inspections, compliance testing, trained technicians, and management in place.',
      annualProfit: 425000,
      annualRevenue: 1700000,
      askingPrice: 1500000,
      yearsEstablished: 12,
      brokerContacts: [],
    }],
    metadata: {},
  };
}

test('healthy required Sheet plus healthy Deal OS includes both in the normal digest', async () => {
  const { sendDailyDealHunterReview } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  storage.getLatestDealHunterDealOsImport = async () => supplementalDealOsImport();
  let sentReview;

  const result = await sendDailyDealHunterReview({
    storage,
    sendDigestEmail: async (options) => {
      sentReview = options.review;
      return { status: 'sent', error: '', providerMessageId: 'digest-both' };
    },
  });

  assert.equal(result.emailResult.status, 'sent');
  assert.equal(result.notificationType, 'normal-digest');
  assert.equal(sentReview.sources.some((source) => source.id === 'sheet-0' && source.fetched), true);
  assert.equal(sentReview.sources.some((source) => source.id === 'deal-os-export' && source.fetched), true);
  assert.equal(sentReview.totals.sourceRows, 2);
  assert.equal([...sentReview.qualified, ...sentReview.watchlist, ...sentReview.removalCandidates]
    .some((deal) => deal.name === 'Supplemental Fire Safety'), true);
  assert.deepEqual(sentReview.optionalSourceWarnings, []);
});

test('healthy required Sheet plus stale Deal OS sends normally and excludes every stale row', async () => {
  const { sendDailyDealHunterReview } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  storage.getLatestDealHunterDealOsImport = async () => supplementalDealOsImport({
    exportedAt: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(),
    name: 'Stale Deal OS Must Not Appear',
  });
  let sentReview;

  const result = await sendDailyDealHunterReview({
    storage,
    sendDigestEmail: async (options) => {
      sentReview = options.review;
      return { status: 'sent', error: '', providerMessageId: 'digest-stale-warning' };
    },
  });

  assert.equal(result.emailResult.status, 'sent');
  assert.equal(result.notificationType, 'normal-digest');
  assert.equal(sentReview.sources.find((source) => source.id === 'deal-os-export').fetched, false);
  assert.match(sentReview.optionalSourceWarnings[0], /stale.*not used/i);
  assert.equal(sentReview.totals.sourceRows, 1);
  assert.equal(JSON.stringify([
    sentReview.newlySeenMatches,
    sentReview.qualified,
    sentReview.watchlist,
    sentReview.removalCandidates,
  ]).includes('Stale Deal OS Must Not Appear'), false);
});

test('stale optional Deal OS does not block Sheet-backed CRM, single CIM, or bulk CIM actions', async () => {
  const {
    reviewDailyDeals,
    sendDealHunterCimRequest,
    sendDealHunterReadyCimRequests,
    syncDealHunterHighFitsToCrm,
  } = await import('../server/services/dealHunter.js');
  const staleImport = supplementalDealOsImport({
    exportedAt: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(),
    name: 'Stale Supplemental Must Never Be Actionable',
  });

  const crmStorage = createCimStorage();
  crmStorage.getLatestDealHunterDealOsImport = async () => staleImport;
  enableCrmImportClaims(crmStorage);
  const crmReview = await reviewDailyDeals({ storage: crmStorage });
  const expectedDealKeys = crmReview.qualified.map((deal) => deal.dealKey);
  assert.equal(expectedDealKeys.length, 1);
  assert.equal(JSON.stringify(crmReview).includes('Stale Supplemental Must Never Be Actionable'), false);
  const crmResult = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys,
    requestedBy: 'test-admin',
    storage: crmStorage,
  });
  assert.equal(crmResult.ok, true, crmResult.error);
  assert.equal(crmResult.crmSync.created, 1);
  assert.equal(crmStorage.submissions.size, 1);

  const directStorage = createCimStorage();
  directStorage.getLatestDealHunterDealOsImport = async () => staleImport;
  const directReview = await reviewDailyDeals({ storage: directStorage });
  const directDeal = directReview.qualified.find((deal) => deal.cimRequest?.canRequest);
  assert.ok(directDeal);
  const directResult = await sendDealHunterCimRequest({
    dealKey: directDeal.dealKey,
    snapshotToken: directDeal.cimRequest.snapshotToken,
    requestedBy: 'test-admin',
    storage: directStorage,
  });
  assert.equal(directResult.status, 502);
  assert.doesNotMatch(directResult.error, /source review|required Google Sheet/i);
  assert.equal(directStorage.requests.size, 1);

  const bulkStorage = createCimStorage();
  bulkStorage.getLatestDealHunterDealOsImport = async () => staleImport;
  const bulkReview = await reviewDailyDeals({ storage: bulkStorage });
  const bulkDeal = bulkReview.qualified.find((deal) => deal.cimRequest?.canRequest);
  assert.ok(bulkDeal);
  const bulkResult = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{
      dealKey: bulkDeal.dealKey,
      recipientEmail: bulkDeal.cimRequest.recipientEmail,
      snapshotToken: bulkDeal.cimRequest.snapshotToken,
    }],
    storage: bulkStorage,
  });
  assert.equal(bulkResult.status, 502);
  assert.doesNotMatch(bulkResult.error, /source review|required Google Sheet/i);
  assert.equal(bulkStorage.requests.size, 1);
});

test('an older signed Deal OS snapshot cannot survive when that optional import becomes stale', async () => {
  const { reviewDailyDeals, sendDealHunterCimRequest, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  let currentImport = supplementalDealOsImport({ name: 'Deal OS Snapshot That Will Expire' });
  currentImport.records[0].brokerContacts = [{ name: 'Supplemental Broker', email: 'supplemental@example.com' }];
  storage.getLatestDealHunterDealOsImport = async () => currentImport;
  const freshReview = await reviewDailyDeals({ storage });
  const staleCandidate = freshReview.qualified.find((deal) => deal.name === 'Deal OS Snapshot That Will Expire');
  assert.ok(staleCandidate?.cimRequest?.snapshotToken);

  currentImport = {
    ...currentImport,
    exported_at: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(),
  };
  const directResult = await sendDealHunterCimRequest({
    dealKey: staleCandidate.dealKey,
    snapshotToken: staleCandidate.cimRequest.snapshotToken,
    requestedBy: 'test-admin',
    storage,
  });
  const bulkResult = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{
      dealKey: staleCandidate.dealKey,
      recipientEmail: staleCandidate.cimRequest.recipientEmail,
      snapshotToken: staleCandidate.cimRequest.snapshotToken,
    }],
    storage,
  });

  assert.equal(directResult.status, 404);
  assert.match(directResult.error, /not found in the latest/i);
  assert.equal(bulkResult.ok, false);
  assert.equal(bulkResult.sent, 0);
  assert.match(bulkResult.error, /CIM-ready list changed after the preview/i);
  assert.equal(storage.requests.size, 0);
  assert.equal(storage.submissions.size, 0);
});

test('healthy required Sheet tolerates an unavailable optional Deal OS lookup', async () => {
  const { sendDailyDealHunterReview } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  storage.getLatestDealHunterDealOsImport = async () => {
    throw new Error('supplemental import storage temporarily unavailable');
  };
  let sentReview;

  const result = await sendDailyDealHunterReview({
    storage,
    sendDigestEmail: async (options) => {
      sentReview = options.review;
      return { status: 'sent', error: '', providerMessageId: 'digest-optional-unavailable' };
    },
  });

  assert.equal(result.emailResult.status, 'sent');
  assert.equal(result.notificationType, 'normal-digest');
  assert.equal(sentReview.sources.find((source) => source.id === 'deal-os-export').fetched, false);
  assert.match(sentReview.optionalSourceWarnings[0], /unavailable.*not used.*unavailable/i);
  assert.equal(sentReview.totals.sourceRows, 1);
});

test('required source failure sends the operational alert and performs no CRM or broker work', async () => {
  const { sendDailyDealHunterReview } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  storage.getLatestDealHunterDealOsImport = async () => supplementalDealOsImport({ name: 'Optional Deal OS Must Not Substitute' });
  sourceFetchMode = 'down';
  let digestCalls = 0;
  let alertCalls = 0;
  let alertReview;

  const result = await sendDailyDealHunterReview({
    idempotencyKey: 'daily-deal-hunter-email:2026-08-25',
    storage,
    sendDigestEmail: async () => {
      digestCalls += 1;
      return { status: 'sent', error: '', providerMessageId: 'unexpected-digest' };
    },
    sendSourceAlertEmail: async (options) => {
      alertCalls += 1;
      alertReview = options.review;
      return { status: 'sent', error: '', providerMessageId: 'source-alert-1' };
    },
  });

  assert.equal(result.notificationType, 'required-source-alert');
  assert.equal(result.emailResult.status, 'sent');
  assert.equal(digestCalls, 0);
  assert.equal(alertCalls, 1);
  assert.equal(result.crmSync.paused, true);
  assert.equal(result.crmSync.reviewed, 0);
  assert.deepEqual(alertReview.qualified, []);
  assert.deepEqual(alertReview.watchlist, []);
  assert.deepEqual(alertReview.removalCandidates, []);
  assert.equal(alertReview.totals.reviewedDeals, 0);
  assert.equal(alertReview.totals.sourceRows, 0);
  assert.equal(alertReview.sources.find((source) => source.id === 'deal-os-export').fetched, true);
  assert.equal(JSON.stringify([alertReview.qualified, alertReview.watchlist, alertReview.removalCandidates])
    .includes('Optional Deal OS Must Not Substitute'), false);
  assert.equal(storage.requests.size, 0);
  assert.equal(storage.submissions.size, 0);
});

test('an empty required Sheet sends the operational alert instead of an empty digest', async () => {
  const { sendDailyDealHunterReview } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  sourceFetchMode = 'empty';
  let digestCalls = 0;
  let alertCalls = 0;

  const result = await sendDailyDealHunterReview({
    storage,
    sendDigestEmail: async () => {
      digestCalls += 1;
      return { status: 'sent', error: '', providerMessageId: 'unexpected-empty-digest' };
    },
    sendSourceAlertEmail: async () => {
      alertCalls += 1;
      return { status: 'sent', error: '', providerMessageId: 'empty-source-alert' };
    },
  });

  assert.equal(result.notificationType, 'required-source-alert');
  assert.equal(digestCalls, 0);
  assert.equal(alertCalls, 1);
  assert.equal(result.review.totals.reviewedDeals, 0);
});

test('a header-only required Sheet blocks explicit CRM and CIM actions even with healthy supplemental rows', async () => {
  const {
    reviewDailyDeals,
    sendDealHunterCimRequest,
    sendDealHunterReadyCimRequests,
    syncDealHunterHighFitsToCrm,
  } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const imported = supplementalDealOsImport({ name: 'Supplemental Deal Must Stay Inert' });
  imported.records[0].brokerContacts = [{ name: 'Supplemental Broker', email: 'supplemental-broker@example.com' }];
  storage.getLatestDealHunterDealOsImport = async () => imported;
  const healthyReview = await reviewDailyDeals({ storage });
  const supplementalDeal = [
    ...healthyReview.qualified,
    ...healthyReview.watchlist,
    ...healthyReview.removalCandidates,
  ].find((deal) => deal.name === 'Supplemental Deal Must Stay Inert');

  assert.ok(
    supplementalDeal?.cimRequest?.canRequest,
    `expected the supplemental fixture to prove the server-side action gate; score=${supplementalDeal?.score || 'missing'} concerns=${JSON.stringify(supplementalDeal?.concerns || supplementalDeal?.scoreReasons || [])}`,
  );
  sourceFetchMode = 'empty';
  let crmClaimCalls = 0;
  storage.claimDealHunterCrmImport = async () => {
    crmClaimCalls += 1;
    throw new Error('required-source failure must stop before a CRM claim');
  };

  const crmResult = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys: [supplementalDeal.dealKey],
    requestedBy: 'test-admin',
    storage,
  });
  const bulkResult = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{
      dealKey: supplementalDeal.dealKey,
      recipientEmail: supplementalDeal.cimRequest.recipientEmail,
      snapshotToken: supplementalDeal.cimRequest.snapshotToken,
    }],
    storage,
  });
  const directResult = await sendDealHunterCimRequest({
    dealKey: supplementalDeal.dealKey,
    snapshotToken: supplementalDeal.cimRequest.snapshotToken,
    requestedBy: 'test-admin',
    storage,
  });

  assert.equal(crmResult.status, 503);
  assert.equal(crmResult.crmSync.paused, true);
  assert.equal(crmClaimCalls, 0);
  assert.equal(bulkResult.status, 503);
  assert.equal(bulkResult.sent, 0);
  assert.equal(directResult.status, 503);
  assert.equal(storage.requests.size, 0);
  assert.equal(storage.submissions.size, 0);
});

test('daily internal summary never writes high-fit listings to CRM', async () => {
  const { sendDailyDealHunterReview } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  let crmClaimCalls = 0;
  storage.claimDealHunterCrmImport = async () => {
    crmClaimCalls += 1;
    throw new Error('daily email must not enter CRM sync');
  };

  const result = await sendDailyDealHunterReview({ idempotencyKey: 'no-implicit-crm-sync', storage });

  assert.equal(result.crmSync.notRun, true);
  assert.equal(result.crmSync.explicitActionRequired, true);
  assert.equal(crmClaimCalls, 0);
  assert.equal(storage.submissions.size, 0);
});

test('explicit confirmed CRM sync is idempotent across repeated runs', async () => {
  const { reviewDailyDeals, syncDealHunterHighFitsToCrm } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const crmImports = new Map();
  const originalMutation = storage.mutateWithCrmActivity.bind(storage);
  storage.claimDealHunterCrmImport = async (record) => {
    const existing = crmImports.get(record.id);
    if (existing) return { claimed: false, importRecord: existing };
    crmImports.set(record.id, record);
    return { claimed: true, importRecord: record };
  };
  storage.updateDealHunterCrmImport = async (id, values) => {
    const updated = { ...crmImports.get(id), ...values };
    crmImports.set(id, updated);
    return updated;
  };
  storage.updateSubmission = async (id, values) => {
    const updated = { ...storage.submissions.get(id), ...values };
    storage.submissions.set(id, updated);
    return updated;
  };
  storage.mutateWithCrmActivity = async ({ operation, payload, activity }) => {
    if (operation !== 'update_submission') {
      return originalMutation({ operation, payload, activity });
    }
    const existing = storage.submissions.get(payload.id);
    const record = { ...existing, ...payload.values };
    storage.submissions.set(record.id, record);
    storage.activities.push(activity);
    return { applied: true, record, activity };
  };
  const reviewed = await reviewDailyDeals({ storage });
  const expectedDealKeys = reviewed.qualified.map((deal) => deal.dealKey);

  const first = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys,
    requestedBy: 'test-admin',
    storage,
  });
  const second = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys,
    requestedBy: 'test-admin',
    storage,
  });

  assert.equal(first.ok, true);
  assert.equal(first.crmSync.created, 1);
  assert.equal(second.ok, true);
  assert.equal(second.crmSync.created, 0);
  assert.equal(second.crmSync.updated, 1);
  assert.equal(storage.submissions.size, 1);
  assert.equal(crmImports.size, 1);
});

test('explicit CRM sync requires durable import claims before reviewing or writing listings', async () => {
  const { syncDealHunterHighFitsToCrm } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  delete storage.claimDealHunterCrmImport;
  let crmMutationCalls = 0;
  storage.mutateWithCrmActivity = async () => {
    crmMutationCalls += 1;
    throw new Error('CRM mutation must not run without durable claims');
  };

  const result = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys: ['reviewed-deal-key'],
    requestedBy: 'test-admin',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.error, /durable CRM import claims are unavailable/i);
  assert.equal(crmMutationCalls, 0);
  assert.equal(storage.submissions.size, 0);
});

test('explicit CRM sync aborts when the high-fit set changes after review', async () => {
  const { reviewDailyDeals, syncDealHunterHighFitsToCrm } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const reviewed = await reviewDailyDeals({ storage });
  const expectedDealKeys = reviewed.qualified.map((deal) => deal.dealKey);
  let crmClaimCalls = 0;
  storage.claimDealHunterCrmImport = async () => {
    crmClaimCalls += 1;
    throw new Error('a changed review must not reach CRM storage');
  };
  activeSourceCsv = replacementSourceCsv;

  const result = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys,
    requestedBy: 'test-admin',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /high-fit set changed/i);
  assert.equal(crmClaimCalls, 0);
  assert.equal(storage.submissions.size, 0);
});

test('explicit CRM sync fails closed when its durable idempotency claim is unavailable', async () => {
  const { reviewDailyDeals, syncDealHunterHighFitsToCrm } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const reviewed = await reviewDailyDeals({ storage });
  const expectedDealKeys = reviewed.qualified.map((deal) => deal.dealKey);
  let crmMutationCalls = 0;
  storage.claimDealHunterCrmImport = async () => {
    throw new Error('claim database unavailable');
  };
  storage.mutateWithCrmActivity = async () => {
    crmMutationCalls += 1;
    throw new Error('CRM mutation must not run without its durable claim');
  };

  const result = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys,
    requestedBy: 'test-admin',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.crmSync.created, 0);
  assert.equal(result.crmSync.failed, 1);
  assert.match(result.error, /durable idempotency claim/i);
  assert.equal(crmMutationCalls, 0);
  assert.equal(storage.submissions.size, 0);
});

test('explicit CRM sync fails closed when its durable idempotency claim returns an invalid result', async () => {
  const { reviewDailyDeals, syncDealHunterHighFitsToCrm } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  const reviewed = await reviewDailyDeals({ storage });
  const expectedDealKeys = reviewed.qualified.map((deal) => deal.dealKey);
  let crmMutationCalls = 0;
  storage.claimDealHunterCrmImport = async () => null;
  storage.mutateWithCrmActivity = async () => {
    crmMutationCalls += 1;
    throw new Error('CRM mutation must not run after an invalid durable claim result');
  };

  const result = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys,
    requestedBy: 'test-admin',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.crmSync.created, 0);
  assert.equal(result.crmSync.failed, 1);
  assert.match(result.error, /durable idempotency claim/i);
  assert.equal(crmMutationCalls, 0);
  assert.equal(storage.submissions.size, 0);
});

test('source outages block alternate contacts even when they are present in a signed snapshot', async () => {
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
  assert.equal(result.status, 503);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  assert.equal(storage.requests.size, 0);
  assert.match(result.error, /source review is incomplete/i);
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

  activeSourceCsv = replacementSourceCsv;

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

test('a completed fingerprint CIM request blocks the same listing after it gains a BizBuySell URL', async () => {
  const { reviewDailyDeals, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  activeSourceCsv = sourceCsv.replace('https://broker.example.test/hvac-maintenance', '');
  const fingerprintReview = await reviewDailyDeals({ storage });
  const fingerprintDeal = fingerprintReview.qualified.find((item) => item.cimRequest?.canRequest);
  assert.ok(fingerprintDeal?.dealKey.startsWith('fingerprint:'), 'fixture starts without a durable listing URL');
  await storage.upsertDealHunterCimRequest({
    id: 'completed-fingerprint-request',
    created_at: '2026-08-01T16:00:00.000Z',
    updated_at: '2026-08-01T16:00:00.000Z',
    opportunity_id: fingerprintDeal.opportunityId,
    deal_key: fingerprintDeal.dealKey,
    recipient_email: fingerprintDeal.brokerEmail,
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'delivered',
    follow_up_state: 'completed',
    first_requested_at: '2026-08-01T16:00:00.000Z',
    first_provider_accepted_at: '2026-08-01T16:00:00.000Z',
    next_follow_up_at: null,
    deal_name: fingerprintDeal.name,
    source_name: fingerprintDeal.sourceName,
    metadata: {},
  });

  activeSourceCsv = sourceCsv.replace(
    'https://broker.example.test/hvac-maintenance',
    'https://www.bizbuysell.com/business-opportunity/commercial-hvac-maintenance/24681012',
  );
  const urlReview = await reviewDailyDeals({ storage });
  const urlDeal = urlReview.qualified.find((item) => item.name === fingerprintDeal.name);
  assert.ok(urlDeal?.dealKey.startsWith('url:'));
  assert.equal(urlDeal.opportunityId, fingerprintDeal.opportunityId);
  assert.equal(urlDeal.cimRequest.canRequest, false);
  assert.match(urlDeal.cimRequest.reason, /already|sent|contact/i);

  const attempt = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{
      dealKey: urlDeal.dealKey,
      recipientEmail: urlDeal.brokerEmail,
      snapshotToken: urlDeal.cimRequest.snapshotToken,
    }],
    storage,
  });
  assert.equal(attempt.sent, 0);
  assert.equal(storage.communications.size, 0);
  assert.equal(storage.requests.size, 1);
});

test('central CIM outreach pause blocks bulk and direct preparation before provider work', async () => {
  const { reviewDailyDeals, sendDealHunterCimRequest, sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const storage = createCimStorage();
  storage.getDealHunterCimSafetySettings = async () => ({
    id: 'global',
    outreach_paused: true,
    updated_at: '2026-08-12T16:00:00.000Z',
    updated_by: 'test-admin',
    metadata: { pauseReason: 'Synthetic incident containment.' },
  });
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified[0];
  assert.equal(review.cimOutreachPause.paused, true);
  assert.equal(deal.cimRequest.canRequest, false);
  assert.match(deal.cimRequest.reason, /globally paused/i);

  const bulk = await sendDealHunterReadyCimRequests({
    requestedBy: 'test-admin',
    selections: [{ dealKey: deal.dealKey, recipientEmail: deal.brokerEmail, snapshotToken: deal.cimRequest.snapshotToken }],
    storage,
  });
  const direct = await sendDealHunterCimRequest({ dealKey: deal.dealKey, snapshotToken: deal.cimRequest.snapshotToken, requestedBy: 'test-admin', storage });
  assert.equal(bulk.sent, 0);
  assert.equal(direct.ok, false);
  assert.match(direct.error, /globally paused/i);
  assert.equal(storage.communications.size, 0);
  assert.equal(storage.requests.size, 0);
});

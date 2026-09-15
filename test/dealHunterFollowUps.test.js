import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCimFollowUpSendDay,
  nextCimFollowUpAt,
  runDealHunterCimFollowUps,
} from '../server/services/dealHunter.js';

const weekdaySettings = {
  enabled: true,
  checkIntervalMs: 3_600_000,
  firstDelayHours: 48,
  intervalHours: 72,
  maxCount: 3,
  delaySequenceHours: [48, 72, 96],
  weekdaysOnly: true,
  timezone: 'America/Los_Angeles',
};

test('CIM follow-up weekday guard uses the configured timezone', () => {
  assert.equal(
    isCimFollowUpSendDay({ now: new Date('2026-07-18T16:00:00.000Z'), settings: weekdaySettings }),
    false,
  );
  assert.equal(
    isCimFollowUpSendDay({ now: new Date('2026-07-20T06:00:00.000Z'), settings: weekdaySettings }),
    false,
    'Monday in UTC is still Sunday evening in America/Los_Angeles',
  );
  assert.equal(
    isCimFollowUpSendDay({ now: new Date('2026-07-20T16:00:00.000Z'), settings: weekdaySettings }),
    true,
  );
  assert.equal(
    isCimFollowUpSendDay({
      now: new Date('2026-07-18T16:00:00.000Z'),
      settings: { ...weekdaySettings, weekdaysOnly: false },
    }),
    true,
  );
});

test('CIM follow-up cadence advances 48, 72, and 96 hours between touches', () => {
  const initialSentAt = '2026-07-15T02:00:00.000Z';
  const firstFollowUpAt = nextCimFollowUpAt({
    status: 'sent',
    followUpCount: 0,
    lastTouchAt: initialSentAt,
    settings: weekdaySettings,
  });
  const secondFollowUpAt = nextCimFollowUpAt({
    status: 'sent',
    followUpCount: 1,
    lastTouchAt: firstFollowUpAt,
    settings: weekdaySettings,
  });
  const thirdFollowUpAt = nextCimFollowUpAt({
    status: 'sent',
    followUpCount: 2,
    lastTouchAt: secondFollowUpAt,
    settings: weekdaySettings,
  });

  assert.equal(firstFollowUpAt, '2026-07-17T02:00:00.000Z');
  assert.equal(secondFollowUpAt, '2026-07-20T02:00:00.000Z');
  assert.equal(thirdFollowUpAt, '2026-07-24T02:00:00.000Z');
  assert.equal(
    nextCimFollowUpAt({
      status: 'sent',
      followUpCount: 3,
      lastTouchAt: thirdFollowUpAt,
      settings: weekdaySettings,
    }),
    null,
  );
});

test('CIM follow-up run defers weekend work before reading the due queue', async () => {
  let queueRead = false;
  const storage = {
    async listDealHunterCimRequests() {
      queueRead = true;
      return [];
    },
    async upsertDealHunterCimRequest(request) {
      return request;
    },
  };

  const result = await runDealHunterCimFollowUps({
    storage,
    now: new Date('2026-07-18T16:00:00.000Z'),
    settings: weekdaySettings,
  });

  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.equal(result.sent, 0);
  assert.equal(queueRead, false);
  assert.match(result.message, /next weekday/i);
});

test('an out-of-window admin run performs no queue claim and due work remains eligible in the next window', async () => {
  let queueReads = 0;
  let claimed = false;
  const storage = {
    async listDealHunterCimRequests() {
      queueReads += 1;
      return [];
    },
    async claimDealHunterCimFollowUpRequest() {
      claimed = true;
      throw new Error('an empty synthetic queue must not claim');
    },
    async getDealHunterCimSafetySettings() { return null; },
    async upsertDealHunterCimRequest(request) { return request; },
  };
  const settings = { ...weekdaySettings, sendWindowStart: '08:00', sendWindowEnd: '17:00' };
  const beforeWindow = await runDealHunterCimFollowUps({
    storage,
    now: new Date('2026-07-20T14:59:00.000Z'),
    settings,
  });
  assert.equal(beforeWindow.deferred, true);
  assert.equal(beforeWindow.deferralReason, 'outside-send-window');
  assert.equal(queueReads, 0);
  assert.equal(claimed, false);

  const nextWindow = await runDealHunterCimFollowUps({
    storage,
    now: new Date('2026-07-20T15:00:00.000Z'),
    settings,
  });
  assert.equal(nextWindow.deferred, undefined);
  assert.equal(queueReads, 1, 'the unchanged due queue is eligible as soon as the next window opens');
  assert.equal(claimed, false);
});

test('global suppression stops a due CIM follow-up before claim, persistence, or provider work', async () => {
  const request = {
    id: 'suppressed-cim-request',
    submission_id: 'suppressed-submission',
    deal_key: 'suppressed-deal',
    deal_name: 'Suppressed Deal',
    recipient_email: 'suppressed@example.test',
    status: 'sent',
    request_state: 'provider_accepted',
    follow_up_state: 'scheduled',
    follow_up_count: 0,
    next_follow_up_at: '2026-07-20T15:00:00.000Z',
    updated_at: '2026-07-18T16:00:00.000Z',
    metadata: {},
  };
  let claimed = false;
  let stored = request;
  const storage = {
    async listDealHunterCimRequests() { return [stored]; },
    async upsertDealHunterCimRequest(value) { stored = value; return value; },
    async getSubmission() { return { id: request.submission_id, status: 'review' }; },
    async listSubmissions() { return { rows: [], total: 0 }; },
    async getActiveEmailSuppression(email) {
      assert.equal(email, request.recipient_email);
      return { id: 'suppression-1', reason: 'complaint', created_at: '2026-07-19T16:00:00.000Z' };
    },
    async claimDealHunterCimFollowUpRequest() { claimed = true; throw new Error('must not claim'); },
    async mutateWithCrmActivity({ operation, payload, activity }) {
      assert.equal(operation, 'upsert_deal_hunter_cim_request');
      assert.equal(activity.event_type, 'cim.outreach-suppressed');
      stored = payload.request;
      return { applied: true, record: stored, activity };
    },
  };
  const result = await runDealHunterCimFollowUps({
    storage,
    now: new Date('2026-07-20T16:00:00.000Z'),
    settings: weekdaySettings,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stopped, 1);
  assert.equal(result.sent, 0);
  assert.equal(claimed, false);
  assert.equal(stored.request_state, 'stopped');
  assert.equal(stored.follow_up_state, 'stopped');
  assert.equal(stored.next_follow_up_at, null);
});

test('central CIM outreach pause blocks a follow-up run before reading or claiming the queue', async () => {
  let queueRead = false;
  const storage = {
    async listDealHunterCimRequests() { queueRead = true; return []; },
    async upsertDealHunterCimRequest(request) { return request; },
    async getDealHunterCimSafetySettings() {
      return { id: 'global', outreach_paused: true, metadata: { pauseReason: 'Synthetic containment.' } };
    },
  };
  const result = await runDealHunterCimFollowUps({
    storage,
    now: new Date('2026-07-20T16:00:00.000Z'),
    settings: { ...weekdaySettings, sendWindowStart: '08:00', sendWindowEnd: '17:00' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /globally paused/i);
  assert.equal(queueRead, false);
});

function operatorApprovedRunnerFixture(forbidden, overrides = {}) {
  const request = {
    id: 'manual-runner-request',
    opportunity_id: 'manual-runner-opportunity',
    submission_id: 'manual-runner-submission',
    deal_key: 'manual-runner-deal',
    deal_name: 'Manual Runner Deal',
    recipient_email: 'manual-runner@example.test',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'scheduled',
    follow_up_count: 0,
    next_follow_up_at: '2026-09-01T17:00:00.000Z',
    updated_at: '2026-09-01T16:00:00.000Z',
    metadata: {
      manualFollowUp: {
        mode: 'operator-approved',
        // Deliberately malformed beyond mode: the runner boundary is mode-only.
        version: 'future-or-corrupt-version',
      },
      preparationToken: 'must-never-be-read',
      approvedProposalDigest: 'b'.repeat(64),
    },
    ...overrides,
  };
  return {
    request,
    storage: {
      async getDealHunterCimSafetySettings() { return { outreach_paused: false, metadata: {} }; },
      async listDealHunterCimRequests() { return [request]; },
      async upsertDealHunterCimRequest(value) { forbidden.activityWrite += 1; return value; },
      async mutateWithCrmActivity() { forbidden.activityWrite += 1; throw new Error('marked runner wrote activity'); },
      async claimDealHunterCimFollowUpRequest() { forbidden.requestClaim += 1; throw new Error('marked runner claimed request'); },
      async claimDealHunterApprovedFollowUp() { forbidden.requestClaim += 1; throw new Error('marked runner claimed approval'); },
      async claimDealHunterCimRecipient() { forbidden.recipientClaim += 1; throw new Error('marked runner claimed recipient'); },
      async insertCrmCommunication() { forbidden.communicationWrite += 1; throw new Error('marked runner wrote communication'); },
      async upsertCrmCommunication() { forbidden.communicationWrite += 1; throw new Error('marked runner wrote communication'); },
    },
  };
}

test('automatic runner returns approval-required for operator-approved requests before every claim communication activity and provider seam', async () => {
  const forbidden = {
    requestClaim: 0,
    recipientClaim: 0,
    communicationWrite: 0,
    activityWrite: 0,
    providerCall: 0,
    proposalVerify: 0,
  };
  const { storage } = operatorApprovedRunnerFixture(forbidden);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    forbidden.providerCall += 1;
    throw new Error('marked runner called provider');
  };
  try {
    const result = await runDealHunterCimFollowUps({
      storage,
      now: new Date('2026-09-01T18:00:00.000Z'),
      settings: {
        ...weekdaySettings,
        enabled: true,
        maxCount: 99,
        delaysHours: [1],
        maximumFollowUps: 99,
        weekdaysOnly: false,
        sendWindowStart: '00:00',
        sendWindowEnd: '23:59',
      },
    });
    assert.equal(result.results[0].status, 'approval-required');
    assert.deepEqual(forbidden, {
      requestClaim: 0,
      recipientClaim: 0,
      communicationWrite: 0,
      activityWrite: 0,
      providerCall: 0,
      proposalVerify: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('automatic runner hard boundary holds with follow-up flag enabled Operations invocation and changed cadence settings', async () => {
  const forbidden = { requestClaim: 0, recipientClaim: 0, communicationWrite: 0, activityWrite: 0, providerCall: 0, proposalVerify: 0 };
  const { storage } = operatorApprovedRunnerFixture(forbidden, { follow_up_count: 4 });
  const result = await runDealHunterCimFollowUps({
    storage,
    limit: 500,
    now: new Date('2026-09-01T18:00:00.000Z'),
    settings: {
      enabled: true,
      firstDelayHours: 0,
      intervalHours: 0,
      delaySequenceHours: [0, 0, 0, 0, 0, 0],
      maxCount: 999,
      weekdaysOnly: false,
      timezone: 'America/Los_Angeles',
      sendWindowStart: '00:00',
      sendWindowEnd: '23:59',
    },
  });
  assert.equal(result.reviewed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.results[0].status, 'approval-required');
  assert.deepEqual(forbidden, { requestClaim: 0, recipientClaim: 0, communicationWrite: 0, activityWrite: 0, providerCall: 0, proposalVerify: 0 });
});

test('automatic runner has no approval token digest verifier or marked executor input path', () => {
  const source = runDealHunterCimFollowUps.toString();
  assert.doesNotMatch(source, /preparationToken|approvedProposalDigest|verifySignedPayload/);
  assert.doesNotMatch(source, /approvedContext|executeApproved/);
});

test('unmarked legacy runner retains existing delays maximum and executor behavior', async () => {
  assert.equal(nextCimFollowUpAt({
    status: 'sent', followUpCount: 0, lastTouchAt: '2026-09-01T18:00:00.000Z', settings: weekdaySettings,
  }), '2026-09-03T18:00:00.000Z');
  assert.equal(nextCimFollowUpAt({
    status: 'sent', followUpCount: 3, lastTouchAt: '2026-09-01T18:00:00.000Z', settings: weekdaySettings,
  }), null);
  let requestWrites = 0;
  const request = {
    id: 'legacy-runner-request', opportunity_id: 'legacy-opportunity', submission_id: 'legacy-submission',
    deal_key: 'legacy-deal', deal_name: 'Legacy Deal', recipient_email: 'legacy@example.test', status: 'sent',
    request_state: 'provider_accepted', delivery_state: 'accepted', follow_up_state: 'scheduled', follow_up_count: 0,
    next_follow_up_at: '2026-09-01T17:00:00.000Z', updated_at: '2026-09-01T16:00:00.000Z', metadata: {},
  };
  const result = await runDealHunterCimFollowUps({
    storage: {
      async getDealHunterCimSafetySettings() { return { outreach_paused: false, metadata: {} }; },
      async listDealHunterCimRequests() { return [request]; },
      async getActiveEmailSuppression() { return { id: 'legacy-suppression', reason: 'complaint' }; },
      async getSubmission() { return { id: request.submission_id, status: 'review' }; },
      async listSubmissions() { return { rows: [], total: 0 }; },
      async upsertDealHunterCimRequest(value) { requestWrites += 1; return value; },
      async mutateWithCrmActivity({ operation, payload, activity }) {
        assert.equal(operation, 'upsert_deal_hunter_cim_request');
        requestWrites += 1;
        return { applied: true, record: payload.request, activity };
      },
    },
    now: new Date('2026-09-01T18:00:00.000Z'),
    settings: { ...weekdaySettings, weekdaysOnly: false, sendWindowStart: '00:00', sendWindowEnd: '23:59' },
  });
  assert.equal(result.results[0].status, 'stopped');
  assert.equal(requestWrites, 1, 'an unmarked request still enters the legacy single-request executor');
});

test('legacy follow-up runner exposes CRM match ambiguity before request claim or provider work', async () => {
  const request = {
    id: 'legacy-ambiguous-request',
    opportunity_id: 'legacy-ambiguous-opportunity',
    submission_id: 'legacy-ambiguous-a',
    deal_key: 'url:https://example.test/listing/legacy-ambiguous',
    deal_name: 'Legacy Ambiguous Deal',
    listing_url: 'https://example.test/listing/legacy-ambiguous',
    recipient_email: 'legacy-ambiguous@example.test',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'scheduled',
    follow_up_count: 0,
    first_requested_at: '2026-08-01T16:00:00.000Z',
    next_follow_up_at: '2026-09-01T17:00:00.000Z',
    updated_at: '2026-09-01T16:00:00.000Z',
    metadata: {},
  };
  const opportunity = {
    opportunity_id: request.opportunity_id,
    status: 'active',
    primary_submission_id: null,
    canonical_name: request.deal_name,
    listing_url: request.listing_url,
    created_at: '2026-08-01T16:00:00.000Z',
    updated_at: '2026-09-01T16:00:00.000Z',
    raw: {},
    metadata: {},
  };
  const candidates = ['legacy-ambiguous-a', 'legacy-ambiguous-b'].map((id) => ({
    id,
    company: request.deal_name,
    listing_url: request.listing_url,
    status: 'review',
    metadata: { dealHunter: {} },
  }));
  const effects = { requestClaims: 0, communicationWrites: 0, providerCalls: 0 };
  const storage = {
    async getDealHunterCimSafetySettings() { return { outreach_paused: false, metadata: {} }; },
    async listDealHunterCimRequests() { return [request]; },
    async upsertDealHunterCimRequest(value) { return value; },
    async getActiveEmailSuppression() { return null; },
    async findCurrentDealHunterOpportunityByAliases() { return opportunity; },
    async getCurrentDealHunterOpportunity() { return opportunity; },
    async listCurrentDealHunterOpportunities() { return [opportunity]; },
    async upsertDealHunterOpportunity() { return opportunity; },
    async upsertDealHunterOpportunityAlias(alias) { return alias; },
    async upsertDealHunterIdentityException(exception) { return exception; },
    async getDealHunterCrmImport() { return null; },
    async getSubmission(id) { return candidates.find((candidate) => candidate.id === id) || null; },
    async listSubmissions() { return { rows: candidates, total: candidates.length }; },
    async claimDealHunterCimFollowUpRequest() { effects.requestClaims += 1; throw new Error('must not claim'); },
    async insertCrmCommunication() { effects.communicationWrites += 1; throw new Error('must not write'); },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    effects.providerCalls += 1;
    throw new Error('must not call provider');
  };
  try {
    const result = await runDealHunterCimFollowUps({
      storage,
      now: new Date('2026-09-01T18:00:00.000Z'),
      settings: { ...weekdaySettings, weekdaysOnly: false, sendWindowStart: '00:00', sendWindowEnd: '23:59' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].status, 'failed');
    assert.equal(result.results[0].code, 'CRM_MATCH_AMBIGUOUS');
    assert.deepEqual(result.results[0].candidateIds, ['legacy-ambiguous-a', 'legacy-ambiguous-b']);
    assert.deepEqual(result.results[0].evidenceCategories, ['stable-listing-identity']);
    assert.deepEqual(effects, { requestClaims: 0, communicationWrites: 0, providerCalls: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy follow-up marks a new CRM import claim failed when ambiguity appears after the claim', async () => {
  const request = {
    id: 'legacy-post-claim-request',
    opportunity_id: 'legacy-post-claim-opportunity',
    submission_id: null,
    deal_key: 'url:https://example.test/listing/legacy-post-claim',
    deal_name: 'Legacy Post Claim Deal',
    listing_url: 'https://example.test/listing/legacy-post-claim',
    recipient_email: 'legacy-post-claim@example.test',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'scheduled',
    follow_up_count: 0,
    first_requested_at: '2026-08-01T16:00:00.000Z',
    next_follow_up_at: '2026-09-01T17:00:00.000Z',
    updated_at: '2026-09-01T16:00:00.000Z',
    metadata: {},
  };
  const opportunity = {
    opportunity_id: request.opportunity_id,
    status: 'active',
    primary_submission_id: null,
    canonical_name: request.deal_name,
    listing_url: request.listing_url,
    raw: {},
    metadata: {},
  };
  let candidates = [];
  let importRecord = null;
  const effects = { requestClaims: 0, communicationWrites: 0, providerCalls: 0 };
  const storage = {
    async getDealHunterCimSafetySettings() { return { outreach_paused: false, metadata: {} }; },
    async listDealHunterCimRequests() { return [request]; },
    async upsertDealHunterCimRequest(value) { return value; },
    async getActiveEmailSuppression() { return null; },
    async findCurrentDealHunterOpportunityByAliases() { return opportunity; },
    async getCurrentDealHunterOpportunity() { return opportunity; },
    async listCurrentDealHunterOpportunities() { return [opportunity]; },
    async upsertDealHunterOpportunity() { return opportunity; },
    async upsertDealHunterOpportunityAlias(alias) { return alias; },
    async upsertDealHunterIdentityException(exception) { return exception; },
    async getDealHunterCrmImport() { return importRecord; },
    async listSubmissions() { return { rows: candidates, total: candidates.length }; },
    async claimDealHunterCrmImport(record) {
      importRecord = record;
      candidates = ['post-claim-a', 'post-claim-b'].map((id) => ({
        id,
        company: request.deal_name,
        listing_url: request.listing_url,
        status: 'review',
        metadata: { dealHunter: {} },
      }));
      return { claimed: true, importRecord };
    },
    async updateDealHunterCrmImport(id, values) {
      assert.equal(id, importRecord.id);
      importRecord = { ...importRecord, ...values };
      return importRecord;
    },
    async claimDealHunterCimFollowUpRequest() { effects.requestClaims += 1; throw new Error('must not claim'); },
    async insertCrmCommunication() { effects.communicationWrites += 1; throw new Error('must not write'); },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    effects.providerCalls += 1;
    throw new Error('must not call provider');
  };
  try {
    const result = await runDealHunterCimFollowUps({
      storage,
      now: new Date('2026-09-01T18:00:00.000Z'),
      settings: { ...weekdaySettings, weekdaysOnly: false, sendWindowStart: '00:00', sendWindowEnd: '23:59' },
    });
    assert.equal(result.failed, 1, JSON.stringify(result));
    assert.equal(result.results[0].code, 'CRM_MATCH_AMBIGUOUS');
    assert.equal(importRecord.status, 'failed');
    assert.match(importRecord.metadata.error, /multiple CRM records/i);
    assert.deepEqual(effects, { requestClaims: 0, communicationWrites: 0, providerCalls: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

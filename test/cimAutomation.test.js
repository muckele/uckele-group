import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateCimAutomationCandidates,
  getCimAutomationMetrics,
  getCimAutomationStatus,
  recordCimResponseOutcome,
  recordCimReviewDecisions,
} from '../server/services/cimAutomation.js';

function automationConfig(stage = 1) {
  return {
    dealHunter: {
      cimAutomation: {
        stage, paused: false, stage2MinimumReviews: 25, stage3MinimumReviews: 50,
        stage3MinimumApprovalRate: 0.9, minimumScore: 90, maximumDailyInitials: 3,
        maximumBrokerContacts30Days: 3, maximumProfitMultiple: 4,
      },
    },
  };
}

test('CIM learning metrics retain approval, pass-reason, recipient-edit, delivery, and reply rates', async () => {
  const reviews = [
    { deal_key: 'deal-1', decision: 'approved', recipient_edited: true, pass_reason: '', metadata: { source: 'approval-queue' } },
    { deal_key: 'deal-2', decision: 'rejected', recipient_edited: false, pass_reason: 'duplicate', metadata: { source: 'approval-queue' } },
    { deal_key: 'deal-1', decision: 'outcome', recipient_edited: false, pass_reason: '', metadata: { source: 'response-outcome', outcome: 'positive' } },
  ];
  const requests = [{ provider_message_id: 'message-1', status: 'responded', responded_at: '2026-07-19T00:00:00Z', metadata: {} }];
  requests[0].metadata.providerMessageIds = ['message-2'];
  const events = [
    { message_id: 'message-1', event_type: 'delivered', subject: 'CIM / NDA request for Test' },
    { message_id: 'message-2', event_type: 'delivered', subject: 'CIM / NDA request for Test follow-up' },
    { message_id: 'message-1', event_type: 'bounced', subject: 'CIM / NDA request for Test' },
  ];
  const storage = {
    async listDealHunterCimReviews() { return reviews; },
    async listDealHunterCimRequests() { return requests; },
    async listEmailEvents() { return events; },
  };
  const metrics = await getCimAutomationMetrics({ storage });

  assert.equal(metrics.reviewed, 2);
  assert.equal(metrics.approvalRate, 50);
  assert.equal(metrics.passReasons.duplicate, 1);
  assert.equal(metrics.recipientEditRate, 100);
  assert.equal(metrics.deliveryRate, 100);
  assert.equal(metrics.bounceRate, 100);
  assert.equal(metrics.replyRate, 100);
  assert.equal(metrics.positiveResponseRate, 100);
  assert.equal(metrics.duplicateListingRate, 50);
});

test('higher automation stages remain at Stage 1 until their evidence gates pass', async () => {
  const storage = {
    async listDealHunterCimReviews() { return Array.from({ length: 24 }, (_, index) => ({ deal_key: `deal-${index}`, decision: 'approved', metadata: { source: 'approval-queue' } })); },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
    async getDealHunterAutomationSettings() { return null; },
  };
  const status = await getCimAutomationStatus({ storage, config: automationConfig(2) });
  assert.equal(status.configuredStage, 2);
  assert.equal(status.effectiveStage, 1);
  assert.equal(status.stage2Ready, false);
});

test('configured Stage 3 falls back to trusted-rule Stage 2 when only the final gate is unmet', async () => {
  const storage = {
    async listDealHunterCimReviews() { return Array.from({ length: 25 }, (_, index) => ({ deal_key: `deal-${index}`, decision: 'approved', metadata: { source: 'approval-queue' } })); },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
    async getDealHunterAutomationSettings() { return null; },
  };
  const status = await getCimAutomationStatus({ storage, config: automationConfig(3) });
  assert.equal(status.effectiveStage, 2);
  assert.equal(status.stage2Ready, true);
  assert.equal(status.stage3Ready, false);
});

test('Stage 2 automates only high-confidence named-broker deals and retains exceptions', () => {
  const base = {
    score: 95, annualProfit: 500000, profitMultiple: 3, industry: 'Commercial HVAC maintenance',
    location: 'Phoenix, AZ, US', listingUrl: 'https://example.com/deal', cimRequest: { canRequest: true },
  };
  const good = { ...base, dealKey: 'good', name: 'Commercial HVAC Maintenance', brokerEmail: 'jane.broker@example.com' };
  const generic = { ...base, dealKey: 'generic', name: 'Electrical Field Service', brokerEmail: 'info@example.com' };
  const result = evaluateCimAutomationCandidates({
    review: { sources: [{ fetched: true }], profile: { targetStates: ['AZ'] } },
    scoredDeals: [good, generic],
    status: { effectiveStage: 2, policy: automationConfig(2).dealHunter.cimAutomation, metrics: { latestReviews: [] } },
    requests: [], events: [],
  });

  assert.deepEqual(result.eligible.map((deal) => deal.dealKey), ['good']);
  assert.equal(result.exceptions[0].dealKey, 'generic');
  assert.match(result.exceptions[0].reasons.join(' '), /Generic broker mailbox/);
});

test('candidate evaluation retains eligible deals beyond the send cap for exception reporting', () => {
  const deals = Array.from({ length: 4 }, (_, index) => ({
    dealKey: `deal-${index}`, name: `Commercial HVAC Maintenance ${index}`, brokerEmail: `jane${index}@example.com`,
    score: 95, annualProfit: 500000, profitMultiple: 3, industry: 'Commercial HVAC maintenance',
    location: 'Phoenix, AZ', listingUrl: `https://example.com/deal-${index}`, cimRequest: { canRequest: true },
  }));
  const result = evaluateCimAutomationCandidates({
    review: { sources: [{ fetched: true }], profile: { targetStates: ['AZ'], minAnnualProfit: 300000, maxAnnualProfit: 750000 } },
    scoredDeals: deals,
    status: { effectiveStage: 2, policy: automationConfig(2).dealHunter.cimAutomation, metrics: { latestReviews: [] } },
    requests: [], events: [],
  });
  assert.equal(result.eligible.length, 4);
});

test('review decisions normalize pass reasons and record recipient corrections', async () => {
  let inserted = [];
  const storage = { async insertDealHunterCimReviews(items) { inserted = items; return items; } };
  await recordCimReviewDecisions({
    storage, actor: 'admin@example.com', stage: 1,
    source: 'approval-queue',
    decisions: [{ dealKey: 'deal-1', decision: 'approved', source: 'automation', originalRecipientEmail: 'old@example.com', finalRecipientEmail: 'new@example.com' }],
  });
  assert.equal(inserted[0].recipient_edited, true);
  assert.equal(inserted[0].actor, 'admin@example.com');
  assert.equal(inserted[0].metadata.source, 'approval-queue');
});

test('broker reply outcomes are stored separately from approval decisions', async () => {
  let inserted = [];
  const storage = {
    async listDealHunterCimRequests() { return [{ deal_key: 'deal-1', status: 'responded' }]; },
    async insertDealHunterCimReviews(items) { inserted = items; return items; },
  };
  await recordCimResponseOutcome({ storage, dealKey: 'deal-1', outcome: 'positive', actor: 'admin' });
  assert.equal(inserted[0].decision, 'outcome');
  assert.equal(inserted[0].metadata.source, 'response-outcome');
  assert.equal(inserted[0].metadata.outcome, 'positive');
});

test('response outcomes cannot be recorded before a matching broker response', async () => {
  const storage = {
    async listDealHunterCimRequests() { return [{ deal_key: 'deal-1', status: 'sent' }]; },
    async insertDealHunterCimReviews() { throw new Error('must not insert'); },
  };
  await assert.rejects(
    recordCimResponseOutcome({ storage, dealKey: 'deal-1', outcome: 'positive', actor: 'admin' }),
    /response must be recorded/i,
  );
});

test('automation fails closed when a review has no source-health evidence', () => {
  const deal = {
    dealKey: 'deal-1', name: 'Commercial HVAC Maintenance', brokerEmail: 'jane@example.com',
    score: 95, annualProfit: 500000, profitMultiple: 3, industry: 'HVAC maintenance',
    location: 'Phoenix, AZ', listingUrl: 'https://example.com/deal', cimRequest: { canRequest: true },
  };
  const result = evaluateCimAutomationCandidates({
    review: { sources: [], profile: { targetStates: ['AZ'] } }, scoredDeals: [deal],
    status: { effectiveStage: 2, policy: automationConfig(2).dealHunter.cimAutomation, metrics: { latestReviews: [] } },
    requests: [], events: [],
  });
  assert.equal(result.eligible.length, 0);
  assert.match(result.exceptions[0].reasons.join(' '), /Source health warning/);
});

test('manual passes remain suppressive beyond the display-history limit', async () => {
  const reviews = [
    ...Array.from({ length: 100 }, (_, index) => ({ deal_key: `newer-${index}`, decision: 'approved', metadata: { source: 'approval-queue' } })),
    { deal_key: 'passed-deal', decision: 'rejected', pass_reason: 'timing', metadata: { source: 'approval-queue' } },
  ];
  const storage = {
    async listDealHunterCimReviews() { return reviews; },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
  };
  const metrics = await getCimAutomationMetrics({ storage });
  const deal = {
    dealKey: 'passed-deal', name: 'Commercial HVAC Maintenance', brokerEmail: 'jane@example.com',
    score: 95, annualProfit: 500000, profitMultiple: 3, industry: 'HVAC maintenance',
    location: 'Phoenix, AZ', listingUrl: 'https://example.com/deal', cimRequest: { canRequest: true },
  };
  const result = evaluateCimAutomationCandidates({
    review: { sources: [{ fetched: true }], profile: { targetStates: ['AZ'], minAnnualProfit: 300000, maxAnnualProfit: 750000 } },
    scoredDeals: [deal], status: { effectiveStage: 2, policy: automationConfig(2).dealHunter.cimAutomation, metrics },
    requests: [], events: [],
  });
  assert.equal(result.eligible.length, 0);
  assert.match(result.exceptions[0].reasons.join(' '), /Manual pass recorded/);
  assert.equal(Object.hasOwn(metrics, 'latestHumanByDeal'), true);
  assert.equal(JSON.stringify(metrics).includes('latestHumanByDeal'), false);
});

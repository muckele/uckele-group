import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CIM_STAGE2_EVIDENCE_VERSION,
  assessCimStage2StaticCandidate,
  authorizeCimStage2SendBoundary,
  buildCimStage2DecisionRecord,
  cimStage2SnapshotDigest,
  createCimStage2Activation,
  evaluateCimAutomationCandidates,
  evaluateCimStage2Window,
  getCimAutomationMetrics,
  getCimAutomationStatus,
  getCimStage2Policy,
  reconcileCimStage2AmbiguousDecisions,
  recordCimResponseOutcome,
  recordCimReviewDecisions,
} from '../server/services/cimAutomation.js';

function automationConfig(stage = 2) {
  return {
    server: { origin: 'https://example.test' },
    admin: { email: 'owner@example.test' },
    delivery: {
      provider: 'resend', resendApiKey: 'configured', resendFromEmail: 'Owner <owner@example.test>',
      resendReplyTo: 'replies@inbound.example.test', resendInboundDomain: 'inbound.example.test',
      emailWebhookSecret: 'configured', fallbackRecipient: 'owner@example.test',
    },
    followUp: { emailEnabled: false, aiEnabled: false, dailyCap: 25 },
    dealHunter: {
      recipient: 'owner@example.test', sheetCsvUrls: ['https://docs.google.test/sheet.csv'], airtableEnabled: false,
      cimFollowUp: { enabled: false },
      cimOutreach: { paused: false, recipientCap24Hours: 1, recipientCap30Days: 4 },
      cimAutomation: {
        stage,
        paused: false,
        ruleVersion: 'cim-stage2-trusted-rules-v2',
        sourcePolicyVersion: 'cim-stage2-smb-sheet-only-v1',
        allowedSourceIds: ['sheet-0'],
        stage2MinimumReviews: 25,
        stage2MinimumEligibleCohort: 10,
        stage2MinimumUnchangedApprovalRate: 0.95,
        stage3MinimumReviews: 50,
        stage3MinimumApprovalRate: 0.9,
        minimumScore: 90,
        maximumProfitMultiple: 4,
        canaryDailyInitialCap: 1,
        activeDailyInitialCap: 3,
        timezone: 'America/Los_Angeles',
        sendWindowStart: '08:00',
        sendWindowEnd: '17:00',
        weekdaysOnly: true,
        maximumSourceAgeHours: 24,
        shadowFreshnessHours: 24,
        activationMaxAgeHours: 168,
        physicalPostalAddress: '100 Main St, Los Angeles, CA 90001',
        replyOptOutEnabled: true,
        complianceClassificationReference: 'compliance-review-1',
        copyAcceptanceReference: 'copy-review-1',
        senderAuthenticationReference: 'spf-dkim-1',
        dmarcReviewReference: 'dmarc-review-1',
      },
    },
  };
}

function currentPolicyReview() {
  return {
    generatedAt: new Date().toISOString(),
    sources: [{ id: 'sheet-0', fetched: true, rowCount: 10 }],
    stage2CoverageWarnings: [],
    profile: { targetStates: ['AZ'], minAnnualProfit: 300000, maxAnnualProfit: 750000 },
  };
}

function trustedDeal(overrides = {}) {
  const email = overrides.brokerEmail || 'jane.broker@example.test';
  return {
    dealKey: 'deal-1', opportunityId: 'opportunity-1', identityStatus: 'resolved',
    name: 'Commercial HVAC Maintenance', brokerName: 'Jane Broker', brokerEmail: email,
    brokerContacts: [{ name: 'Jane Broker', email, sourceColumn: 'Broker Email' }],
    sourceId: 'sheet-0', sourceRecords: [{ sourceId: 'sheet-0', externalId: 'row-1', stableExternalId: true, listingUrl: 'https://example.test/deal' }],
    score: 95, annualProfit: 500000, profitMultiple: 3, industry: 'Commercial HVAC maintenance',
    location: 'Phoenix, AZ, US', listingUrl: 'https://example.test/deal',
    cimRequest: { canRequest: true, eligible: true },
    ...overrides,
  };
}

function humanReview(index, policy, overrides = {}) {
  return {
    id: `review-${index}`,
    created_at: new Date(Date.now() - index * 1000).toISOString(),
    decision_at: new Date(Date.now() - index * 1000).toISOString(),
    deal_key: `deal-${index}`,
    opportunity_id: `opportunity-${index}`,
    decision: 'approved',
    recipient_edited: false,
    actor: 'reviewer@example.test',
    actor_role: 'admin',
    evidence_version: CIM_STAGE2_EVIDENCE_VERSION,
    rule_version: policy.rules.version,
    source_policy_hash: policy.sourcePolicyHash,
    metadata: { source: 'approval-queue', stage2CohortEligible: index < 10 },
    ...overrides,
  };
}

test('CIM metrics use canonical human evidence and initial communication lifecycle associations', async () => {
  const policy = getCimStage2Policy(automationConfig());
  const reviews = [
    humanReview(1, policy, { recipient_edited: true }),
    humanReview(2, policy, { decision: 'rejected', pass_reason: 'duplicate' }),
    { deal_key: 'deal-1', decision: 'outcome', metadata: { source: 'response-outcome', outcome: 'positive' } },
  ];
  const requests = [
    { id: 'request-1', opportunity_id: 'opportunity-1', status: 'responded', request_state: 'responded', responded_at: '2026-07-19T00:00:00Z', recipient_email: 'jane@example.test', metadata: {} },
  ];
  const communications = [
    { id: 'communication-1', cim_request_id: 'request-1', kind: 'deal-hunter-cim-request', direction: 'outbound', provider: 'resend', provider_message_id: 'message-1', delivery_state: 'delivered' },
    { id: 'communication-2', cim_request_id: 'request-1', kind: 'deal-hunter-cim-follow-up', direction: 'outbound', provider: 'resend', provider_message_id: 'message-2', delivery_state: 'bounced' },
  ];
  const storage = {
    async listDealHunterCimReviews() { return reviews; },
    async listDealHunterCimRequests() { return requests; },
    async listEmailEvents() { return [
      { communication_id: 'communication-1', message_id: 'message-1', provider: 'resend', event_type: 'delivered' },
      { communication_id: 'communication-1', message_id: 'message-1', provider: 'resend', event_type: 'delivered' },
      { communication_id: 'communication-2', message_id: 'message-2', provider: 'resend', event_type: 'bounced' },
    ]; },
    async listCrmCommunications() { return { rows: communications, totalPages: 1 }; },
    async listCimStage2IdentityOpportunities() { return [{ opportunity_id: 'opportunity-1' }, { opportunity_id: 'opportunity-2' }]; },
    async listCimStage2EvidenceAliases() { return []; },
    async getActiveEmailSuppression() { return null; },
  };
  const metrics = await getCimAutomationMetrics({ storage, config: automationConfig() });

  assert.equal(metrics.canonicalHumanReviews, 2);
  assert.equal(metrics.compatibleEvidence, 2);
  assert.equal(metrics.legacyUnversionedEvidence, 0);
  assert.equal(metrics.approvalRate, 50);
  assert.equal(metrics.passReasons.duplicate, 1);
  assert.equal(metrics.recipientEditRate, 100);
  assert.equal(metrics.logicalInitialMessages, 1);
  assert.equal(metrics.rawLifecycleEvents, 2);
  assert.equal(metrics.delivered, 1);
  assert.equal(metrics.bounced, 0, 'a follow-up bounce must not be attributed to the initial message');
  assert.equal(metrics.replies, 1);
});

test('25 mutable deal-key aliases for one canonical opportunity count once and latest decision wins', async () => {
  const policy = getCimStage2Policy(automationConfig());
  const reviews = Array.from({ length: 25 }, (_, index) => humanReview(index, policy, {
    deal_key: `mutable-alias-${index}`,
    opportunity_id: 'one-opportunity',
    decision: index === 0 ? 'rejected' : 'approved',
  }));
  const storage = {
    async listDealHunterCimReviews() { return reviews; },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
    async listCrmCommunications() { return { rows: [], totalPages: 1 }; },
    async listCimStage2IdentityOpportunities() { return [{ opportunity_id: 'one-opportunity' }]; },
    async listCimStage2EvidenceAliases() { return []; },
  };
  const metrics = await getCimAutomationMetrics({ storage, config: automationConfig() });
  assert.equal(metrics.canonicalHumanReviews, 1);
  assert.equal(metrics.rejected, 1);
  assert.equal(metrics.remainingStage2Reviews, 24);
});

test('adverse readiness counts only initial-message states inside the configured release window', async () => {
  const policy = getCimStage2Policy(automationConfig());
  const now = new Date('2026-08-12T18:00:00.000Z');
  const storage = {
    async listDealHunterCimReviews() { return []; },
    async listDealHunterCimRequests() {
      return [
        { id: 'request-old', recipient_email: 'old@example.test', metadata: {} },
        { id: 'request-recent', recipient_email: 'recent@example.test', metadata: {} },
      ];
    },
    async listEmailEvents() { return []; },
    async listCrmCommunications() {
      return {
        totalPages: 1,
        rows: [
          {
            id: 'communication-old', cim_request_id: 'request-old', direction: 'outbound',
            kind: 'deal-hunter-cim-request', delivery_state: 'bounced',
            delivery_state_at: '2026-06-01T18:00:00.000Z',
          },
          {
            id: 'communication-recent', cim_request_id: 'request-recent', direction: 'outbound',
            kind: 'deal-hunter-cim-request', delivery_state: 'failed',
            delivery_state_at: '2026-08-11T18:00:00.000Z',
          },
        ],
      };
    },
    async listCimStage2IdentityOpportunities() { return []; },
    async listCimStage2EvidenceAliases() { return []; },
    async getActiveEmailSuppression() { return null; },
  };
  const metrics = await getCimAutomationMetrics({ storage, config: automationConfig(), now });
  assert.equal(metrics.adverseEventWindowDays, policy.adverseEventWindowDays);
  assert.equal(metrics.adverseInitials, 1);
});

test('automated, ambiguous, unlinked, and incompatible-policy reviews never qualify as human evidence', async () => {
  const policy = getCimStage2Policy(automationConfig());
  const reviews = [
    humanReview(1, policy, { metadata: { source: 'automation' } }),
    humanReview(2, policy, { opportunity_id: null, deal_key: 'unlinked' }),
    humanReview(3, policy, { rule_version: 'old-rule-version' }),
  ];
  const storage = {
    async listDealHunterCimReviews() { return reviews; },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
    async listCrmCommunications() { return { rows: [], totalPages: 1 }; },
    async listCimStage2IdentityOpportunities() { return [{ opportunity_id: 'opportunity-3' }]; },
    async listCimStage2EvidenceAliases() { return []; },
  };
  const metrics = await getCimAutomationMetrics({ storage, config: automationConfig() });
  assert.equal(metrics.canonicalHumanReviews, 0);
  assert.equal(metrics.automatedReviews, 1);
  assert.equal(metrics.unlinkedEvidence, 1);
  assert.equal(metrics.incompatibleEvidence, 1);
});

test('a historical Stage 2 review remains readable but cannot supply current authority for a superseded opportunity', async () => {
  const policy = getCimStage2Policy(automationConfig());
  const historicalReview = humanReview(1, policy, {
    opportunity_id: 'opportunity-superseded',
    deal_key: 'historical-deal-key',
  });
  const storage = {
    async listDealHunterCimReviews() { return [historicalReview]; },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
    async listCrmCommunications() { return { rows: [], totalPages: 1 }; },
    async listCimStage2IdentityOpportunities() { return []; },
    async listCimStage2EvidenceAliases() { return []; },
  };

  const metrics = await getCimAutomationMetrics({ storage, config: automationConfig() });

  assert.equal(metrics.canonicalHumanReviews, 0);
  assert.equal(metrics.unlinkedEvidence, 1);
  assert.equal((await storage.listDealHunterCimReviews())[0], historicalReview);
});

test('an explicit active Stage 2 opportunity ID remains authoritative over deal-key aliases', async () => {
  const policy = getCimStage2Policy(automationConfig());
  const explicitReview = humanReview(1, policy, {
    opportunity_id: 'opportunity-explicit-active',
    deal_key: 'alias-owned-by-another-active-opportunity',
  });
  const storage = {
    async listDealHunterCimReviews() { return [explicitReview]; },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
    async listCrmCommunications() { return { rows: [], totalPages: 1 }; },
    async listCimStage2IdentityOpportunities() {
      return [
        { opportunity_id: 'opportunity-explicit-active', status: 'active' },
        { opportunity_id: 'opportunity-alias-owner', status: 'active' },
      ];
    },
    async listCimStage2EvidenceAliases() {
      return [{
        alias_type: 'deal-key',
        alias_value: explicitReview.deal_key,
        opportunity_id: 'opportunity-alias-owner',
      }];
    },
  };

  const metrics = await getCimAutomationMetrics({ storage, config: automationConfig() });

  assert.equal(metrics.canonicalHumanReviews, 1);
  assert.equal(metrics.stage2EligibleCohort, 1);
  assert.equal(metrics.stage2UnchangedApprovals, 1);
  assert.equal(metrics.unlinkedEvidence, 0);
});

test('a superseded HVAC loser review cannot rebound through an alias moved to the survivor', async () => {
  const policy = getCimStage2Policy(automationConfig());
  const historicalReview = humanReview(1, policy, {
    opportunity_id: 'opp_c92d0c73-6a47-4fed-b528-6f310745e448',
    deal_key: 'url:https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx',
  });
  const before = structuredClone(historicalReview);
  const survivorId = 'opp_cd57a315-feaf-4158-a02e-4bdde97a922e';
  const storage = {
    async listDealHunterCimReviews() { return [historicalReview]; },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
    async listCrmCommunications() { return { rows: [], totalPages: 1 }; },
    async listCimStage2IdentityOpportunities() {
      return [{ opportunity_id: survivorId, status: 'active' }];
    },
    async listCimStage2EvidenceAliases() {
      return [{
        alias_type: 'deal-key',
        alias_value: historicalReview.deal_key,
        opportunity_id: survivorId,
      }];
    },
  };

  const metrics = await getCimAutomationMetrics({ storage, config: automationConfig() });

  assert.equal(metrics.canonicalHumanReviews, 0);
  assert.equal(metrics.stage2EligibleCohort, 0);
  assert.equal(metrics.stage2UnchangedApprovals, 0);
  assert.equal(metrics.unlinkedEvidence, 1);
  assert.deepEqual(historicalReview, before, 'historical audit evidence must remain unchanged');
});

test('an explicit missing Stage 2 opportunity ID cannot use a matching current deal-key alias', async () => {
  const policy = getCimStage2Policy(automationConfig());
  const explicitMissingReview = humanReview(1, policy, {
    opportunity_id: 'opportunity-missing-from-storage',
    deal_key: 'legacy-looking-but-explicit',
  });
  const storage = {
    async listDealHunterCimReviews() { return [explicitMissingReview]; },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
    async listCrmCommunications() { return { rows: [], totalPages: 1 }; },
    async listCimStage2IdentityOpportunities() {
      return [{ opportunity_id: 'opportunity-current-owner', status: 'active' }];
    },
    async listCimStage2EvidenceAliases() {
      return [{
        alias_type: 'deal-key',
        alias_value: explicitMissingReview.deal_key,
        opportunity_id: 'opportunity-current-owner',
      }];
    },
  };

  const metrics = await getCimAutomationMetrics({ storage, config: automationConfig() });

  assert.equal(metrics.canonicalHumanReviews, 0);
  assert.equal(metrics.stage2EligibleCohort, 0);
  assert.equal(metrics.stage2UnchangedApprovals, 0);
  assert.equal(metrics.unlinkedEvidence, 1);
});

test('a metadata-backed explicit Stage 2 opportunity ID cannot be masked by a blank legacy column', async () => {
  const policy = getCimStage2Policy(automationConfig());
  const explicitMetadataReview = humanReview(1, policy, {
    opportunity_id: '   ',
    deal_key: 'metadata-explicit-review-deal-key',
    metadata: {
      source: 'approval-queue',
      stage2CohortEligible: true,
      opportunityId: 'opportunity-missing-from-storage',
    },
  });
  const storage = {
    async listDealHunterCimReviews() { return [explicitMetadataReview]; },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
    async listCrmCommunications() { return { rows: [], totalPages: 1 }; },
    async listCimStage2IdentityOpportunities() {
      return [{ opportunity_id: 'opportunity-current-owner', status: 'active' }];
    },
    async listCimStage2EvidenceAliases() {
      return [{
        alias_type: 'deal-key',
        alias_value: explicitMetadataReview.deal_key,
        opportunity_id: 'opportunity-current-owner',
      }];
    },
  };

  const metrics = await getCimAutomationMetrics({ storage, config: automationConfig() });

  assert.equal(metrics.canonicalHumanReviews, 0);
  assert.equal(metrics.stage2EligibleCohort, 0);
  assert.equal(metrics.stage2UnchangedApprovals, 0);
  assert.equal(metrics.unlinkedEvidence, 1);
});

test('a truly legacy Stage 2 review with no explicit ID can use one current deal-key owner', async () => {
  const policy = getCimStage2Policy(automationConfig());
  const legacyReview = humanReview(1, policy, {
    opportunity_id: null,
    deal_key: 'legacy-review-deal-key',
  });
  const storage = {
    async listDealHunterCimReviews() { return [legacyReview]; },
    async listDealHunterCimRequests() { return []; },
    async listEmailEvents() { return []; },
    async listCrmCommunications() { return { rows: [], totalPages: 1 }; },
    async listCimStage2IdentityOpportunities() {
      return [{ opportunity_id: 'opportunity-legacy-current-owner', status: 'active' }];
    },
    async listCimStage2EvidenceAliases() {
      return [{
        alias_type: 'deal-key',
        alias_value: legacyReview.deal_key,
        opportunity_id: 'opportunity-legacy-current-owner',
      }];
    },
  };

  const metrics = await getCimAutomationMetrics({ storage, config: automationConfig() });

  assert.equal(metrics.canonicalHumanReviews, 1);
  assert.equal(metrics.stage2EligibleCohort, 1);
  assert.equal(metrics.stage2UnchangedApprovals, 1);
  assert.equal(metrics.unlinkedEvidence, 0);
});

test('configured Stage 2 and Stage 3 stay at effective Stage 1 without durable activation and every independent gate', async () => {
  for (const configuredStage of [2, 3]) {
    const storage = {
      async listDealHunterCimReviews() { return []; },
      async listDealHunterCimRequests() { return []; },
      async listEmailEvents() { return []; },
      async listCrmCommunications() { return { rows: [], totalPages: 1 }; },
      async listCimStage2IdentityOpportunities() { return []; },
      async listCimStage2EvidenceAliases() { return []; },
      async getDealHunterAutomationSettings() { return null; },
      async checkCimStage2Storage() { return { ok: true }; },
      async listCimStage2Runs() { return []; },
      async countCimStage2Capacity() { return 0; },
      async listDealHunterIdentityExceptions() { return []; },
      async listDealHunterCimRepairManifests() { return []; },
      async getDealHunterCimSafetySettings() { return null; },
    };
    const status = await getCimAutomationStatus({
      storage,
      config: automationConfig(configuredStage),
      now: new Date('2026-07-15T17:00:00.000Z'),
    });
    assert.equal(status.configuredStage, configuredStage);
    assert.equal(status.effectiveStage, 1);
    assert.equal(status.activationMode, 'off');
    assert.equal(status.automaticTransmissionAllowed, false);
    assert.ok(status.blockerCodes.includes('canonical_human_reviews'));
    assert.ok(status.blockerCodes.includes('activation_record'));
    assert.ok(status.blockerCodes.includes('provider_reconciliation'), 'missing ambiguity storage must fail closed');
    const laterStatus = await getCimAutomationStatus({
      storage,
      config: automationConfig(configuredStage),
      now: new Date('2026-07-15T17:01:00.000Z'),
    });
    assert.notEqual(laterStatus.evidenceGeneratedAt, status.evidenceGeneratedAt);
    assert.equal(laterStatus.evidenceChecksum, status.evidenceChecksum, 'poll time alone must not invalidate reviewed evidence');
  }
});

test('trusted Stage 2 candidate requires score 90, canonical identity, named exact source contact, and Sheet-only provenance', () => {
  const policy = getCimStage2Policy(automationConfig());
  assert.equal(assessCimStage2StaticCandidate(trustedDeal({ score: 89 }), { policy }).eligible, false);
  assert.equal(assessCimStage2StaticCandidate(trustedDeal({ score: 90 }), { policy }).eligible, true);
  assert.equal(assessCimStage2StaticCandidate(trustedDeal({ brokerName: '' }), { policy }).eligible, false);
  assert.equal(assessCimStage2StaticCandidate(trustedDeal({ location: 'Lancaster, PA, US' }), { policy }).eligible, false, 'state codes must match a complete token');
  assert.equal(assessCimStage2StaticCandidate(trustedDeal({ name: 'Carpet Cleaning', industry: 'Carpet cleaning' }), { policy }).eligible, false, 'short industry terms must match a complete token');
  assert.equal(assessCimStage2StaticCandidate(trustedDeal({ brokerEmail: 'info@example.test', brokerContacts: [{ name: 'Jane Broker', email: 'info@example.test', sourceColumn: 'Broker Email' }] }), { policy }).eligible, false);
  assert.equal(assessCimStage2StaticCandidate(trustedDeal({ brokerEmail: 'info+listing@example.test', brokerContacts: [{ name: 'Jane Broker', email: 'info+listing@example.test', sourceColumn: 'Broker Email' }] }), { policy }).eligible, false);
  assert.equal(assessCimStage2StaticCandidate(trustedDeal({ sourceId: 'deal-os-export', sourceRecords: [{ sourceId: 'deal-os-export' }] }), { policy }).eligible, false);
});

test('Stage 2 evaluator blocks widened, warning-bearing, stale, or failed source coverage', () => {
  const policy = getCimStage2Policy(automationConfig());
  const status = { policy, metrics: { latestReviews: [] } };
  const cases = [
    { ...currentPolicyReview(), sources: [{ id: 'sheet-0', fetched: true }, { id: 'deal-os-export', fetched: true }] },
    { ...currentPolicyReview(), stage2CoverageWarnings: ['coverage capped'] },
    { ...currentPolicyReview(), generatedAt: '2020-01-01T00:00:00.000Z' },
    { ...currentPolicyReview(), sources: [{ id: 'sheet-0', fetched: false, error: 'unavailable' }] },
    { ...currentPolicyReview(), sources: [{ id: 'sheet-0', fetched: true, rowCount: 0 }] },
    { ...currentPolicyReview(), sources: [{ id: 'sheet-0', fetched: true, rowCount: 10 }, { id: 'sheet-0', fetched: true, rowCount: 10 }] },
  ];
  for (const review of cases) {
    const result = evaluateCimAutomationCandidates({ review, scoredDeals: [trustedDeal()], status, requests: [], events: [] });
    assert.equal(result.eligible.length, 0);
    assert.equal(result.sourceHealthy, false);
  }
});

test('prior opportunity, prior recipient, suppression, caps, claims, and replies block automation', () => {
  const policy = getCimStage2Policy(automationConfig());
  const deal = trustedDeal();
  const acceptedRequest = {
    id: 'request-1', opportunity_id: deal.opportunityId, deal_key: deal.dealKey,
    recipient_email: deal.brokerEmail, status: 'sent', request_state: 'responded', responded_at: new Date().toISOString(),
    first_provider_accepted_at: new Date().toISOString(), metadata: {},
  };
  const result = evaluateCimAutomationCandidates({
    review: currentPolicyReview(), scoredDeals: [deal], status: { policy, metrics: { latestReviews: [] } },
    requests: [acceptedRequest], events: [],
    suppressions: [{ normalized_email: deal.brokerEmail }],
    recipientClaims: [{ recipient_email: deal.brokerEmail }],
    opportunityClaims: [{ opportunity_id: deal.opportunityId }],
  });
  assert.equal(result.eligible.length, 0);
  const codes = result.exceptions[0].reasonCodes;
  for (const code of ['opportunity_prior_sequence', 'recipient_prior_outreach', 'recipient_24_hour_cap', 'recipient_claim_pending', 'opportunity_claim_pending', 'recipient_suppressed', 'reply_state_ambiguous']) {
    assert.ok(codes.includes(code), `missing blocker ${code}`);
  }
});

test('a canonical human pass blocks automation after the deal key changes', () => {
  const policy = getCimStage2Policy(automationConfig());
  const deal = trustedDeal({ dealKey: 'new-mutable-alias' });
  const latestHumanByOpportunity = new Map([[
    deal.opportunityId,
    { opportunity_id: deal.opportunityId, deal_key: 'old-mutable-alias', decision: 'rejected' },
  ]]);
  const result = evaluateCimAutomationCandidates({
    review: currentPolicyReview(),
    scoredDeals: [deal],
    status: { policy, metrics: { latestHumanByOpportunity, latestHumanByDeal: new Map(), latestReviews: [] } },
    requests: [],
    events: [],
  });
  assert.equal(result.eligible.length, 0);
  assert.ok(result.exceptions[0].reasonCodes.includes('manual_pass_recorded'));
});

test('review decisions retain immutable canonical and policy evidence and normalize recipient corrections', async () => {
  let inserted = [];
  const policy = getCimStage2Policy(automationConfig());
  const storage = { async insertDealHunterCimReviews(items) { inserted = items; return items; } };
  await recordCimReviewDecisions({
    storage, actor: 'admin@example.test', actorRole: 'admin', stage: 1, source: 'approval-queue',
    decisions: [{
      dealKey: 'deal-1', opportunityId: 'opportunity-1', decision: 'approved',
      originalRecipientEmail: 'old@example.test', finalRecipientEmail: 'new@example.test',
      snapshotDigest: 'a'.repeat(64), ruleVersion: policy.rules.version,
      sourcePolicyVersion: policy.sourcePolicy.version, sourcePolicyHash: policy.sourcePolicyHash,
      sourceIds: ['sheet-0'], stage2CohortEligible: true,
    }],
  });
  assert.equal(inserted[0].recipient_edited, true);
  assert.equal(inserted[0].opportunity_id, 'opportunity-1');
  assert.equal(inserted[0].actor_role, 'admin');
  assert.equal(inserted[0].evidence_version, CIM_STAGE2_EVIDENCE_VERSION);
  assert.equal(inserted[0].metadata.stage2CohortEligible, true);
});

test('broker reply outcomes remain separate and require a recorded response', async () => {
  let inserted = [];
  const storage = {
    async listDealHunterCimRequests() { return [{ deal_key: 'deal-1', opportunity_id: 'opportunity-1', status: 'responded' }]; },
    async insertDealHunterCimReviews(items) { inserted = items; return items; },
  };
  await recordCimResponseOutcome({ storage, dealKey: 'deal-1', outcome: 'positive', actor: 'admin' });
  assert.equal(inserted[0].decision, 'outcome');
  assert.equal(inserted[0].metadata.source, 'response-outcome');
  await assert.rejects(recordCimResponseOutcome({
    storage: {
      async listDealHunterCimRequests() { return [{ deal_key: 'deal-1', status: 'sent' }]; },
      async insertDealHunterCimReviews() { throw new Error('must not insert'); },
    },
    dealKey: 'deal-1', outcome: 'positive', actor: 'admin',
  }), /response must be recorded/i);
});

test('final Stage 2 authorization binds run, activation, claim, opportunity, recipient, snapshots, policy, and the reserved last capacity slot', async () => {
  const config = automationConfig(2);
  const policy = getCimStage2Policy(config);
  const deal = trustedDeal();
  const run = {
    id: 'run-1', mode: 'canary', policy_hash: policy.policyHash,
  };
  const activation = {
    id: 'activation-1', mode: 'canary', policy_hash: policy.policyHash,
  };
  const decision = {
    ...buildCimStage2DecisionRecord({ run, deal, evaluation: { reasonCodes: [] }, activationId: activation.id, policy }),
    decision_state: 'attempting',
    claim_token: 'claim-1',
    consumed_at: null,
  };
  const validReservedStatus = {
    configuredStage: 2,
    evidenceStage: 2,
    effectiveStage: 1,
    activationMode: 'canary',
    automaticTransmissionAllowed: false,
    blockerCodes: ['daily_capacity'],
    capacity: { used: 1, limit: 1, remaining: 0 },
  };
  const callBoundary = (overrides = {}) => authorizeCimStage2SendBoundary({
    decisionId: 'decision-1',
    runId: run.id,
    activationId: activation.id,
    claimToken: 'claim-1',
    deal: overrides.deal || deal,
    snapshotDigest: overrides.snapshotDigest || cimStage2SnapshotDigest(deal),
    storage: {
      async getCimStage2Decision() { return { ...decision, ...(overrides.decision || {}) }; },
      async getCimStage2Run() { return { ...run, ...(overrides.run || {}) }; },
      async getCurrentCimStage2Activation() { return { ...activation, ...(overrides.activation || {}) }; },
      async getCurrentDealHunterOpportunity() {
        return overrides.currentOpportunity === false
          ? null
          : { opportunity_id: deal.opportunityId, status: 'active' };
      },
    },
    config,
    now: new Date('2026-07-13T16:00:00.000Z'),
    statusCheck: async () => overrides.status || validReservedStatus,
  });

  assert.equal((await callBoundary()).ok, true, 'the reservation itself may consume the last canary slot');
  const cases = [
    [{ decision: { run_id: 'wrong-run' } }, 'wrong_run'],
    [{ decision: { activation_id: 'wrong-activation' } }, 'wrong_activation'],
    [{ decision: { policy_hash: 'wrong-policy' } }, 'wrong_policy'],
    [{ decision: { opportunity_id: 'wrong-opportunity' } }, 'wrong_opportunity'],
    [{ deal: trustedDeal({ brokerEmail: 'different@example.test', brokerContacts: [{ name: 'Jane Broker', email: 'different@example.test', sourceColumn: 'Broker Email' }] }) }, 'wrong_recipient'],
    [{ snapshotDigest: 'wrong-snapshot' }, 'wrong_snapshot'],
    [{ decision: { claim_token: 'wrong-claim' } }, 'wrong_claim'],
    [{ decision: { consumed_at: '2026-07-13T15:59:00.000Z' } }, 'decision_consumed'],
    [{ currentOpportunity: false }, 'opportunity_not_current'],
    [{ status: { ...validReservedStatus, blockerCodes: ['automation_pause'] } }, 'automatic_transmission_blocked'],
  ];
  for (const [overrides, expectedCode] of cases) {
    const result = await callBoundary(overrides);
    assert.equal(result.ok, false, expectedCode);
    assert.equal(result.code, expectedCode);
  }
});

test('ambiguous Stage 2 decisions reconcile from durable communication state before another live run', async () => {
  const transitions = [];
  const decisions = [
    { id: 'decision-accepted', communication_id: 'communication-accepted' },
    { id: 'decision-failed', communication_id: 'communication-failed' },
    { id: 'decision-unresolved', communication_id: 'communication-unresolved' },
  ];
  const storage = {
    async listCimStage2Decisions() { return decisions; },
    async getCrmCommunication(id) {
      return {
        'communication-accepted': { delivery_state: 'delivered' },
        'communication-failed': { delivery_state: 'bounced' },
        'communication-unresolved': { delivery_state: 'ambiguous' },
      }[id];
    },
    async transitionCimStage2Decision(change) { transitions.push(change); return { applied: true }; },
  };
  const summary = await reconcileCimStage2AmbiguousDecisions({
    storage,
    now: new Date('2026-08-12T18:00:00.000Z'),
  });
  assert.deepEqual(summary, { reviewed: 3, reconciled: 2, accepted: 1, failed: 1 });
  assert.deepEqual(transitions.map((item) => [item.id, item.state]), [
    ['decision-accepted', 'accepted'],
    ['decision-failed', 'failed'],
  ]);
});

test('canary activation requires exact release-owner confirmation, evidence, backup, identity audit, compliance, and sender-auth references', async () => {
  const config = automationConfig(2);
  const evidenceChecksum = 'e'.repeat(64);
  const evidenceGeneratedAt = '2026-07-13T15:55:00.000Z';
  let stored = null;
  const storage = {
    async createCimStage2Activation(record) { stored = record; return record; },
    async insertAdminAuditEvent() {},
  };
  const base = {
    mode: 'canary',
    confirmation: 'ACTIVATE CIM STAGE 2 CANARY',
    actor: 'release-owner',
    reason: 'Accept the exact reviewed canary safety boundary.',
    evidenceChecksum,
    evidenceGeneratedAt,
    backupReference: 'backup-bundle-2026-07-13',
    backupChecksum: 'a'.repeat(64),
    identityAuditReference: 'identity-audit-2026-07-13',
    identityAuditChecksum: 'b'.repeat(64),
    complianceReference: 'compliance-copy-acceptance-2026-07-13',
    senderAuthReference: 'sender-auth-dmarc-review-2026-07-13',
    storage,
    config,
    now: new Date('2026-07-13T16:00:00.000Z'),
    statusCheck: async () => ({ evidenceStage: 2, evidenceChecksum, evidenceGeneratedAt }),
  };
  const invalidCases = [
    [{ confirmation: 'yes' }, /exact confirmation phrase/i],
    [{ actor: '' }, /actor is required/i],
    [{ reason: 'too short' }, /at least 20 characters/i],
    [{ evidenceChecksum: 'wrong' }, /evidence checksum/i],
    [{ evidenceGeneratedAt: '2026-07-13T15:00:00.000Z' }, /last 10 minutes/i],
    [{ evidenceGeneratedAt: '2026-07-13T16:00:01.000Z' }, /last 10 minutes/i],
    [{ backupReference: '' }, /backup reference/i],
    [{ backupChecksum: '' }, /backup reference/i],
    [{ identityAuditReference: '' }, /identity audit reference/i],
    [{ identityAuditChecksum: '' }, /identity audit reference/i],
    [{ complianceReference: '' }, /Compliance\/copy/i],
    [{ senderAuthReference: '' }, /sender-authentication/i],
  ];
  for (const [overrides, pattern] of invalidCases) {
    await assert.rejects(createCimStage2Activation({ ...base, ...overrides }), pattern);
  }
  await assert.rejects(createCimStage2Activation({
    ...base,
    storage: {
      async insertAdminAuditEvent() { throw new Error('audit unavailable'); },
      async createCimStage2Activation() { throw new Error('must not activate'); },
    },
  }), /audit unavailable/i);
  const activation = await createCimStage2Activation(base);
  assert.equal(activation.mode, 'canary');
  assert.equal(activation.actor, 'release-owner');
  assert.equal(activation.evidence_checksum, evidenceChecksum);
  assert.equal(activation.backup_checksum, 'a'.repeat(64));
  assert.equal(activation.identity_audit_checksum, 'b'.repeat(64));
  assert.equal(stored.confirmation_phrase, 'ACTIVATE CIM STAGE 2 CANARY');
  assert.equal(stored.metadata.automaticTransmissionAuthorized, true);
});

test('Pacific operating window is DST-safe, weekday-only, and end-exclusive', () => {
  const policy = getCimStage2Policy(automationConfig());
  assert.equal(evaluateCimStage2Window(new Date('2026-01-12T15:59:00.000Z'), policy).open, false, '07:59 PST');
  assert.equal(evaluateCimStage2Window(new Date('2026-01-12T16:00:00.000Z'), policy).open, true, '08:00 PST');
  assert.equal(evaluateCimStage2Window(new Date('2026-01-13T00:59:00.000Z'), policy).open, true, '16:59 PST');
  assert.equal(evaluateCimStage2Window(new Date('2026-01-13T01:00:00.000Z'), policy).open, false, '17:00 PST');
  assert.equal(evaluateCimStage2Window(new Date('2026-07-13T15:00:00.000Z'), policy).open, true, '08:00 PDT');
  assert.equal(evaluateCimStage2Window(new Date('2026-07-14T00:00:00.000Z'), policy).open, false, '17:00 PDT');
  assert.equal(evaluateCimStage2Window(new Date('2026-07-12T17:00:00.000Z'), policy).open, false, 'Sunday');
  assert.equal(evaluateCimStage2Window(new Date('2026-03-08T17:00:00.000Z'), policy).open, false, 'DST transition Sunday');
});

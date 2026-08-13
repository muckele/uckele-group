import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  CIM_STAGE2_EVIDENCE_VERSION,
  CIM_STAGE2_REVIEW_QUEUE_VERSION,
  cimStage2Digest,
  cimStage2SnapshotDigest,
  getCimStage2Policy,
  recordCimReviewDecisions,
} from '../server/services/cimAutomation.js';
import {
  recordCimStage2HumanReviewDecision,
  validateCimStage2HumanReviewDecision,
} from '../server/services/dealHunter.js';
import { signPayload } from '../server/utils/security.js';

function config() {
  return {
    admin: { sessionSecret: 'stage2-human-review-test-secret' },
    secureDocuments: { tokenSecret: 'fallback-secret' },
    delivery: { provider: 'resend', resendFromEmail: 'Owner <owner@example.test>', resendReplyTo: 'reply@example.test' },
    dealHunter: {
      sheetCsvUrls: ['https://example.test/sheet.csv'],
      airtableEnabled: false,
      cimOutreach: { recipientCap24Hours: 1, recipientCap30Days: 4 },
      cimAutomation: {
        stage: 1,
        ruleVersion: 'cim-stage2-trusted-rules-v2',
        sourcePolicyVersion: 'cim-stage2-smb-sheet-only-v1',
        allowedSourceIds: ['sheet-0'],
        minimumScore: 90,
        maximumProfitMultiple: 4,
        physicalPostalAddress: '',
        replyOptOutEnabled: false,
      },
    },
  };
}

function candidate() {
  return {
    id: 'deal-1',
    opportunityId: 'opportunity-1',
    identityStatus: 'resolved',
    dealKey: 'deal-1',
    sourceId: 'sheet-0',
    sourceName: 'SMB Sheet',
    sourceMode: 'csv',
    listingSource: 'Broker listing',
    name: 'Commercial HVAC Maintenance',
    score: 95,
    industry: 'Commercial HVAC maintenance',
    location: 'Phoenix, AZ',
    annualProfit: 500000,
    annualRevenue: 2000000,
    askingPrice: 1500000,
    profitMultiple: 3,
    brokerName: 'Jane Broker',
    brokerEmail: 'jane.broker@example.test',
    brokerContacts: [{ name: 'Jane Broker', email: 'jane.broker@example.test', role: 'Broker', sourceColumn: 'Broker Email' }],
    listingUrl: 'https://example.test/deal-1',
    sourceRecords: [{ sourceId: 'sheet-0', sourceName: 'SMB Sheet', externalId: 'row-1', stableExternalId: true, listingUrl: 'https://example.test/deal-1' }],
    deduplicationMatches: [],
    strengths: [],
    concerns: [],
    removeReasons: [],
    questions: [],
    shouldRemove: false,
  };
}

function signedReviewToken({ testConfig = config(), snapshot = candidate(), now = new Date('2026-08-12T18:00:00.000Z') } = {}) {
  const policy = getCimStage2Policy(testConfig);
  const policySnapshot = {
    policyHash: policy.policyHash,
    ruleVersion: policy.rules.version,
    rules: policy.rules,
    sourcePolicy: policy.sourcePolicy,
    sourcePolicyHash: policy.sourcePolicyHash,
    evidenceVersion: CIM_STAGE2_EVIDENCE_VERSION,
  };
  const sourceReviewSnapshot = {
    generatedAt: now.toISOString(),
    sources: [{ id: 'sheet-0', fetched: true, rowCount: 25, errorPresent: false }],
    warningCount: 0,
    allowedSourceIds: ['sheet-0'],
    digest: 'b'.repeat(64),
  };
  return signPayload({
    typ: 'cim-stage2-human-review',
    version: 1,
    exp: Date.now() + 60 * 60 * 1000,
    evidenceId: randomUUID(),
    queueVersion: CIM_STAGE2_REVIEW_QUEUE_VERSION,
    queueDigest: 'a'.repeat(64),
    queueRank: cimStage2Digest({
      version: CIM_STAGE2_REVIEW_QUEUE_VERSION,
      ruleVersion: policy.rules.version,
      sourcePolicyHash: policy.sourcePolicyHash,
      opportunityId: snapshot.opportunityId,
    }),
    candidateSnapshot: snapshot,
    candidateSnapshotDigest: cimStage2SnapshotDigest(snapshot),
    policySnapshot,
    sourceReviewSnapshot,
    stage2CohortEligible: true,
  }, testConfig.admin.sessionSecret);
}

test('protected human review validation binds current policy, canonical snapshot, source coverage, and explicit one-opportunity action', () => {
  const testConfig = config();
  const now = new Date('2026-08-12T18:00:00.000Z');
  const reviewToken = signedReviewToken({ testConfig, now });
  const approved = validateCimStage2HumanReviewDecision({
    reviewToken,
    action: 'approve',
    reviewConfirmed: true,
    finalRecipientEmail: 'jane.broker@example.test',
  }, { config: testConfig, now });
  assert.equal(approved.valid, true);
  assert.equal(approved.decision.opportunityId, 'opportunity-1');
  assert.equal(approved.decision.stage2CohortEligible, true);
  assert.equal(approved.decision.policySnapshot.policyHash, getCimStage2Policy(testConfig).policyHash);
  assert.equal(approved.decision.candidateSnapshot.brokerEmail, 'jane.broker@example.test');

  const unconfirmed = validateCimStage2HumanReviewDecision({ reviewToken, action: 'reject', passReason: 'quality' }, { config: testConfig, now });
  assert.equal(unconfirmed.valid, false);
  assert.match(unconfirmed.error, /Confirm the per-opportunity/i);

  const weakEdit = validateCimStage2HumanReviewDecision({
    reviewToken,
    action: 'approve-edit',
    reviewConfirmed: true,
    finalRecipientEmail: 'corrected@example.test',
    recipientEditReason: 'too short',
  }, { config: testConfig, now });
  assert.equal(weakEdit.valid, false);
  assert.match(weakEdit.error, /20 characters/i);

  const changedConfig = config();
  changedConfig.dealHunter.cimAutomation.ruleVersion = 'changed-rules';
  const incompatible = validateCimStage2HumanReviewDecision({ reviewToken, action: 'approve', reviewConfirmed: true }, { config: changedConfig, now });
  assert.equal(incompatible.valid, false);
  assert.equal(incompatible.status, 409);
});

test('Stage 2 decision recording refreshes the full deterministic queue and refuses a changed source snapshot before persistence', async () => {
  const now = new Date('2026-08-12T18:00:00.000Z');
  let evidenceLookups = 0;
  let inserts = 0;
  const result = await recordCimStage2HumanReviewDecision({
    input: {
      reviewToken: signedReviewToken({ now }),
      action: 'approve',
      reviewConfirmed: true,
      finalRecipientEmail: 'jane.broker@example.test',
    },
    actor: 'reviewer@example.test',
    config: config(),
    now,
    storage: {
      async getCimStage2ReviewEvidence() {
        evidenceLookups += 1;
        return null;
      },
      async insertDealHunterCimReviews() {
        inserts += 1;
        return [];
      },
    },
    async queueLoader({ expectedQueueDigest }) {
      return {
        sourceHealthy: true,
        queueChanged: true,
        queueDigest: `${expectedQueueDigest.slice(0, 63)}0`,
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /queue changed/i);
  assert.equal(evidenceLookups, 0);
  assert.equal(inserts, 0);
});

test('Stage 2 human evidence appends immutable candidate, policy, source, edit, and reviewer fields without overwriting prior decisions', async () => {
  const inserted = [];
  const storage = {
    async insertDealHunterCimReviews(rows) {
      inserted.push(...structuredClone(rows));
      return rows;
    },
  };
  const policy = getCimStage2Policy(config());
  const base = {
    dealKey: 'deal-1',
    opportunityId: 'opportunity-1',
    dealName: 'Commercial HVAC Maintenance',
    score: 95,
    originalRecipientEmail: 'jane.broker@example.test',
    originalRecipientName: 'Jane Broker',
    snapshotDigest: 'c'.repeat(64),
    evidenceVersion: CIM_STAGE2_EVIDENCE_VERSION,
    ruleVersion: policy.rules.version,
    sourcePolicyVersion: policy.sourcePolicy.version,
    sourcePolicyHash: policy.sourcePolicyHash,
    sourceIds: ['sheet-0'],
    stage2CohortEligible: true,
    queueVersion: CIM_STAGE2_REVIEW_QUEUE_VERSION,
    queueRank: 'd'.repeat(64),
    reviewChecklistVersion: 'cim-stage2-human-review-checklist-v1',
    candidateSnapshot: candidate(),
    policySnapshot: { policyHash: policy.policyHash, rules: policy.rules, sourcePolicy: policy.sourcePolicy },
    sourceReviewSnapshot: { generatedAt: '2026-08-12T18:00:00.000Z', sources: [{ id: 'sheet-0', fetched: true, rowCount: 25 }] },
  };
  await recordCimReviewDecisions({
    storage,
    actor: 'reviewer@example.test',
    actorRole: 'admin',
    source: 'stage2-review-queue',
    decisions: [{
      ...base,
      evidenceId: randomUUID(),
      decision: 'approved',
      finalRecipientEmail: 'corrected@example.test',
      finalRecipientName: 'Correct Broker',
      recipientEditReason: 'The original listing names this corrected direct broker address.',
    }],
  });
  await recordCimReviewDecisions({
    storage,
    actor: 'reviewer@example.test',
    actorRole: 'admin',
    source: 'stage2-review-queue',
    decisions: [{
      ...base,
      evidenceId: randomUUID(),
      decision: 'rejected',
      passReason: 'quality',
      finalRecipientEmail: 'jane.broker@example.test',
      finalRecipientName: 'Jane Broker',
      decisionNote: 'A later explicit review retained a factual quality concern.',
    }],
  });

  assert.equal(inserted.length, 2);
  assert.notEqual(inserted[0].id, inserted[1].id);
  assert.equal(inserted[0].actor, 'reviewer@example.test');
  assert.equal(inserted[0].recipient_edited, true);
  assert.equal(inserted[0].metadata.recipientEditReason, 'The original listing names this corrected direct broker address.');
  assert.equal(inserted[0].metadata.candidateSnapshot.brokerEmail, 'jane.broker@example.test');
  assert.equal(inserted[0].metadata.policySnapshot.policyHash, policy.policyHash);
  assert.equal(inserted[0].metadata.sourceReviewSnapshot.sources[0].id, 'sheet-0');
  assert.equal(inserted[1].decision, 'rejected');

  await assert.rejects(recordCimReviewDecisions({
    storage,
    actor: 'reviewer@example.test',
    source: 'stage2-review-queue',
    decisions: [{ ...base, evidenceId: randomUUID() }, { ...base, evidenceId: randomUUID() }],
  }), /one opportunity at a time/i);
});

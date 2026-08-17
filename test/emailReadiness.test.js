import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEmailReadiness } from '../server/services/emailReadiness.js';

function config(overrides = {}) {
  return {
    server: { origin: 'https://www.uckelegroup.com' },
    admin: { email: 'mathew@uckelegroup.com' },
    delivery: {
      provider: 'resend',
      resendApiKey: 're_test',
      resendFromEmail: 'Uckele Group <mathew@uckelegroup.com>',
      resendReplyTo: 'deals@replies.uckelegroup.com',
      resendInboundDomain: 'replies.uckelegroup.com',
      fallbackRecipient: 'mathew@uckelegroup.com',
      emailWebhookSecret: 'whsec_test',
      ...overrides.delivery,
    },
    dealHunter: {
      recipient: 'mathew@uckelegroup.com',
      cimFollowUp: { enabled: Boolean(overrides.followUpsEnabled) },
    },
    followUp: {
      emailEnabled: Boolean(overrides.genericFollowUpsEnabled),
      aiEnabled: Boolean(overrides.aiEnabled),
      aiApiKeyConfigured: overrides.aiApiKeyConfigured !== false,
      aiModel: overrides.aiModel || 'gpt-test',
      aiReasoningEffort: 'low',
      aiTimeoutMs: 12_000,
      aiMaxContextChars: 30_000,
      aiMaxOutputTokens: 1_600,
      aiMaxRetries: 0,
      aiRateLimitPerMinute: 10,
      aiDataHandlingApprovalId: 'privacy-review-test',
      aiAcceptedEvalVersion: 'follow-up-eval-v1',
      aiCostRateApprovalId: 'cost-rate-review-test',
      aiSyntheticSmokeId: 'synthetic-smoke-test',
      senderEmail: 'Uckele Group <mathew@uckelegroup.com>',
      replyTo: 'deals@replies.uckelegroup.com',
      physicalPostalAddress: '123 Main Street, Los Angeles, CA 90001',
      replyOptOutEnabled: true,
      optOutBaseUrl: '',
      dailyCap: 25,
      ...overrides.followUp,
    },
  };
}

test('reply-safe readiness requires a verified inbound webhook event', () => {
  const configured = buildEmailReadiness({ config: config() });
  assert.equal(configured.replyTrackingConfigured, true);
  assert.equal(configured.replyTrackingVerified, false);
  assert.equal(configured.followUpsSafe, false);
  assert.equal(configured.aiReady, true);
  assert.equal(configured.aiReadiness.timeoutConfigured, true);
  assert.equal(configured.aiReadiness.contextLimitConfigured, true);

  const verified = buildEmailReadiness({
    config: config({ followUpsEnabled: true }),
    events: [{
      created_at: '2026-07-14T20:00:00.000Z',
      event_type: 'replied',
      source: 'webhook',
      subject: 'Re: [TEST] Uckele Group email delivery verification',
    }],
  });

  assert.equal(verified.replyTrackingVerified, true);
  assert.equal(verified.followUpsSafe, true);
});

test('a reply-to address outside the configured receiving domain remains blocked', () => {
  const readiness = buildEmailReadiness({
    config: config({ delivery: { resendReplyTo: 'mathew@uckelegroup.com' } }),
  });

  assert.equal(readiness.replyAddressMatchesInboundDomain, false);
  assert.equal(readiness.replyTrackingConfigured, false);
  assert.ok(readiness.issues.some((issue) => issue.includes('does not use the configured inbound receiving domain')));
});

test('generic CRM email readiness fails closed on suppression health and reports count-only learning metrics', () => {
  const verifiedReply = [{
    created_at: '2026-08-09T20:00:00.000Z',
    event_type: 'replied',
    source: 'webhook',
    subject: 'Re: [TEST] Uckele Group email delivery verification',
  }];
  const blocked = buildEmailReadiness({
    config: config({ genericFollowUpsEnabled: true }),
    events: verifiedReply,
  });
  assert.equal(blocked.genericFollowUpsSafe, false);
  assert.ok(blocked.issues.some((issue) => issue.includes('suppression store')));

  const ready = buildEmailReadiness({
    config: config({ genericFollowUpsEnabled: true }),
    events: verifiedReply,
    metricsAvailable: true,
    sentLast24Hours: 3,
    operationalMetrics: {
      windowStartedAt: '2026-07-10T20:00:00.000Z',
      outbox: { accepted: 8, ambiguous: 1 },
      delivery: { delivered: 8, bounced: 1, complained: 0, failed: 1, replied: 2 },
      recommendations: { accepted: 4, editedAndAccepted: 2, dismissed: 2, aiUsed: 6, aiFallback: 2 },
      ai: {
        fallbackReasons: { timeout: 1, refusal: 1, 'legacy-unbounded-value': 99 },
        responseStates: { completed: 6, refused: 1, 'provider-error': 1, 'legacy-unbounded-value': 99 },
        latencyMs: { observed: 8, average: 420.5, minimum: 100, maximum: 900, total: 3364 },
        tokens: { observed: 8, inputTotal: 1200, outputTotal: 400, cachedTotal: 100, reasoningTotal: 80 },
      },
      suppressions: { active: 5 },
    },
  });
  assert.equal(ready.genericFollowUpsSafe, true);
  assert.equal(ready.metrics.sentLast24Hours, 3);
  assert.equal(ready.metrics.rates.recommendationAcceptance, 75);
  assert.equal(ready.metrics.rates.recommendationEdit, 33.3);
  assert.equal(ready.metrics.rates.delivery, 80);
  assert.equal(ready.metrics.rates.reply, 25);
  assert.equal(ready.metrics.rates.aiFallback, 25);
  assert.deepEqual(ready.metrics.ai.fallbackReasons, { timeout: 1, refusal: 1 });
  assert.equal(ready.metrics.ai.latencyMs.average, 420.5);
  assert.equal(ready.metrics.ai.tokens.reasoningTotal, 80);
  assert.deepEqual(Object.keys(ready.metrics.suppressions), ['active']);
});

test('optional AI enrichment is visibly degraded when enabled without an API key', () => {
  const readiness = buildEmailReadiness({ config: config({ aiEnabled: true, aiApiKeyConfigured: false }) });
  assert.equal(readiness.aiReady, false);
  assert.equal(readiness.deterministicRecommendationsAvailable, true);
  assert.equal(readiness.metrics.rates.aiFallback, null);
  assert.ok(readiness.aiReadiness.blockers.includes('api-key-not-configured'));
  assert.ok(readiness.issues.some((issue) => issue.includes('configuration, approval, evaluation')));
});

test('AI readiness distinguishes feature state, approval, eval, and synthetic-smoke gates', () => {
  const readiness = buildEmailReadiness({
    config: config({
      aiEnabled: true,
      followUp: {
        aiDataHandlingApprovalId: '',
        aiAcceptedEvalVersion: '',
        aiCostRateApprovalId: '',
        aiSyntheticSmokeId: '',
      },
    }),
  });
  assert.equal(readiness.aiEnabled, true);
  assert.equal(readiness.aiReady, false);
  assert.equal(readiness.aiModelConfigured, true);
  assert.equal(readiness.aiApiKeyConfigured, true);
  assert.equal(readiness.aiReadiness.dataHandlingApproved, false);
  assert.equal(readiness.aiReadiness.evalAccepted, false);
  assert.equal(readiness.aiReadiness.costRateApproved, false);
  assert.equal(readiness.aiReadiness.syntheticSmokeObserved, false);
});

test('AI readiness blocks invalid timeout and context bounds independently', () => {
  const readiness = buildEmailReadiness({
    config: config({
      followUp: { aiTimeoutMs: 999, aiMaxContextChars: 1_999 },
    }),
  });
  assert.equal(readiness.aiReady, false);
  assert.ok(readiness.aiReadiness.blockers.includes('timeout-invalid'));
  assert.ok(readiness.aiReadiness.blockers.includes('context-limit-invalid'));
});

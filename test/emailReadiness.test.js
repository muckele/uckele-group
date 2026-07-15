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
  };
}

test('reply-safe readiness requires a verified inbound webhook event', () => {
  const configured = buildEmailReadiness({ config: config() });
  assert.equal(configured.replyTrackingConfigured, true);
  assert.equal(configured.replyTrackingVerified, false);
  assert.equal(configured.followUpsSafe, false);

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

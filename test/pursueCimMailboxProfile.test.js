import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import * as configModule from '../server/config.js';
import { recordEmailEventsFromWebhook } from '../server/services/emailEvents.js';
import { applyVerifiedPursueCimInbound } from '../server/services/pursueCimInbound.js';

const mailboxProfile = 'controlled-mailbox-v1';

function mailboxEnvironment(overrides = {}) {
  return {
    DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'true',
    DEAL_HUNTER_CIM_PROVIDER_PROFILE: mailboxProfile,
    DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY: 'mailbox-outbound-key',
    DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL: 'Mailbox Sender <mailbox-sender@mailbox.example.test>',
    DEAL_HUNTER_CIM_MAILBOX_REPLY_TO: 'replies@mailbox-inbound.example.test',
    DEAL_HUNTER_CIM_MAILBOX_INBOUND_DOMAIN: 'mailbox-inbound.example.test',
    DEAL_HUNTER_CIM_MAILBOX_WEBHOOK_SECRET: 'mailbox-webhook-secret',
    DEAL_HUNTER_CIM_MAILBOX_RECONCILIATION_API_KEY: 'mailbox-read-key',
    DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS: 'owner-controlled@example.test',
    ...overrides,
  };
}

function mailboxConfig(overrides = {}) {
  const resolve = configModule.resolveCimProviderProfile;
  assert.equal(typeof resolve, 'function');
  return {
    isProduction: false,
    server: { outboundRequestTimeoutMs: 100 },
    delivery: {
      provider: 'resend',
      resendApiKey: 'production-outbound-key',
      resendFromEmail: 'production-sender@production.example.test',
      resendReplyTo: 'production-replies@production.example.test',
      resendInboundDomain: 'production.example.test',
      emailWebhookSecret: 'production-webhook-secret',
    },
    dealHunter: { cimProvider: { ...resolve(mailboxEnvironment()), ...overrides } },
  };
}

test('P10A controlled mailbox resolver ignores every production provider variable', () => {
  const resolve = configModule.resolveCimProviderProfile;
  assert.equal(typeof resolve, 'function');
  const productionValues = [
    'production-api-key', 'production-sender@production.example.test',
    'production-reply@production.example.test', 'production.example.test',
    'production-webhook-secret',
  ];
  const profile = resolve(mailboxEnvironment({
    DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY: '',
    DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL: '',
    DEAL_HUNTER_CIM_MAILBOX_REPLY_TO: '',
    DEAL_HUNTER_CIM_MAILBOX_INBOUND_DOMAIN: '',
    DEAL_HUNTER_CIM_MAILBOX_WEBHOOK_SECRET: '',
    DEAL_HUNTER_CIM_MAILBOX_RECONCILIATION_API_KEY: '',
    RESEND_API_KEY: productionValues[0],
    RESEND_FROM_EMAIL: productionValues[1],
    RESEND_REPLY_TO: productionValues[2],
    RESEND_INBOUND_DOMAIN: productionValues[3],
    EMAIL_WEBHOOK_SECRET: productionValues[4],
  }));

  assert.equal(profile.mode, 'controlled-mailbox');
  assert.equal(profile.profile, mailboxProfile);
  assert.equal(profile.resendApiKey, '');
  assert.equal(profile.resendFromEmail, '');
  assert.equal(profile.resendReplyTo, '');
  assert.equal(profile.resendInboundDomain, '');
  assert.equal(profile.emailWebhookSecret, '');
  assert.equal(profile.reconciliationApiKey, '');
  for (const value of productionValues) assert.equal(JSON.stringify(profile).includes(value), false);
});

test('P10A selected mailbox process erases production delivery credentials from runtime config', () => {
  const script = `import { getConfig } from './server/config.js';
    const config = getConfig();
    process.stdout.write(JSON.stringify({ delivery: config.delivery,
      followUp: { senderEmail: config.followUp.senderEmail, replyTo: config.followUp.replyTo },
      cimProvider: config.dealHunter.cimProvider }));`;
  const output = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      ...mailboxEnvironment(),
      DELIVERY_PROVIDER: 'resend',
      RESEND_API_KEY: 'must-not-resolve-production-key',
      RESEND_FROM_EMAIL: 'must-not-resolve@production.example.test',
      RESEND_REPLY_TO: 'must-not-resolve-reply@production.example.test',
      RESEND_INBOUND_DOMAIN: 'production.example.test',
      EMAIL_WEBHOOK_SECRET: 'must-not-resolve-production-webhook',
      FOLLOW_UP_SENDER_EMAIL: 'must-not-resolve-followup@production.example.test',
      FOLLOW_UP_REPLY_TO: 'must-not-resolve-followup-reply@production.example.test',
    },
  }));
  assert.equal(output.delivery.provider, 'console');
  assert.equal(output.delivery.resendApiKey, '');
  assert.equal(output.delivery.resendFromEmail, '');
  assert.equal(output.delivery.resendReplyTo, '');
  assert.equal(output.delivery.resendInboundDomain, '');
  assert.equal(output.delivery.emailWebhookSecret, '');
  assert.deepEqual(output.followUp, { senderEmail: '', replyTo: '' });
  assert.equal(output.cimProvider.resendApiKey, 'mailbox-outbound-key');
  assert.equal(output.cimProvider.emailWebhookSecret, 'mailbox-webhook-secret');
  assert.equal(JSON.stringify(output).includes('must-not-resolve'), false);
  assert.equal(JSON.stringify(output).includes('production.example.test'), false);
});

test('P10A mailbox binding requires complete isolated configuration and exactly one recipient', () => {
  const validate = configModule.validateCimProviderProfileBinding;
  assert.equal(typeof validate, 'function');
  const binding = {
    providerProfile: mailboxProfile,
    fromAddress: 'Mailbox Sender <mailbox-sender@mailbox.example.test>',
    toAddresses: ['owner-controlled@example.test'], ccAddresses: [], bccAddresses: [],
    replyToAddress: 'cim-conversation@mailbox-inbound.example.test',
  };
  assert.deepEqual(validate(mailboxConfig(), binding), { ok: true, blockers: [] });

  const cases = [
    ['production profile substitution', mailboxConfig({ profile: 'production-resend-v1' }),
      binding, 'profile_mismatch'],
    ['production credential substitution', mailboxConfig({ resendApiKey: '' }),
      binding, 'outbound_credentials_missing'],
    ['second recipient', mailboxConfig({ allowedRecipients: [
      'owner-controlled@example.test', 'other@example.test'] }), binding,
    'mailbox_recipient_allowlist_invalid'],
    ['recipient substitution', mailboxConfig(), { ...binding,
      toAddresses: ['attacker@example.test'] }, 'mailbox_recipient_mismatch'],
    ['compound recipient field', mailboxConfig(), { ...binding,
      toAddresses: ['Owner <owner-controlled@example.test>, Attacker <attacker@example.test>'] },
    'mailbox_recipient_mismatch'],
    ['malformed carbon copy', mailboxConfig(), { ...binding,
      ccAddresses: ['not-an-email'] }, 'mailbox_recipient_mismatch'],
    ['sender substitution', mailboxConfig(), { ...binding,
      fromAddress: 'production-sender@production.example.test' }, 'mailbox_sender_mismatch'],
    ['compound sender field', mailboxConfig(), { ...binding,
      fromAddress: 'Mailbox Sender <mailbox-sender@mailbox.example.test>, attacker@example.test' },
    'mailbox_sender_mismatch'],
    ['domain substitution', mailboxConfig(), { ...binding,
      replyToAddress: 'cim-conversation@production.example.test' }, 'mailbox_reply_domain_mismatch'],
    ['webhook namespace missing', mailboxConfig({ emailWebhookSecret: '' }), binding,
      'signed_webhook_missing'],
    ['reconciliation namespace missing', mailboxConfig({ reconciliationApiKey: '' }), binding,
      'reconciliation_credentials_missing'],
  ];
  for (const [label, config, candidate, blocker] of cases) {
    const result = validate(config, candidate);
    assert.equal(result.ok, false, label);
    assert.ok(result.blockers.includes(blocker), `${label}: ${result.blockers.join(',')}`);
  }
});

test('P10A protected delivery and inbound composition use only the selected profile namespace', () => {
  const deliveryConfig = configModule.getCimProviderDeliveryConfig;
  const webhookAuthority = configModule.getCimWebhookAuthority;
  assert.equal(typeof deliveryConfig, 'function');
  assert.equal(typeof webhookAuthority, 'function');
  const config = mailboxConfig();
  const scoped = deliveryConfig(config);
  assert.equal(scoped.delivery.provider, 'resend');
  assert.equal(scoped.delivery.resendApiKey, 'mailbox-outbound-key');
  assert.equal(scoped.delivery.resendFromEmail,
    'Mailbox Sender <mailbox-sender@mailbox.example.test>');
  assert.equal(scoped.delivery.resendReplyTo, 'replies@mailbox-inbound.example.test');
  assert.equal(scoped.delivery.resendInboundDomain, 'mailbox-inbound.example.test');
  assert.equal(scoped.delivery.emailWebhookSecret, 'mailbox-webhook-secret');
  assert.equal(JSON.stringify(scoped.delivery).includes('production-'), false);
  assert.deepEqual(webhookAuthority(config), {
    providerProfile: mailboxProfile,
    secret: 'mailbox-webhook-secret',
    requireSignedProviderEvent: true,
  });
});

test('P10A controlled mailbox inbound rejects shared or production secrets and accepts only its signed namespace', async () => {
  const config = mailboxConfig();
  const body = [];
  const rawBody = JSON.stringify(body);
  const shared = async (secret) => recordEmailEventsFromWebhook({ body, rawBody,
    headers: { 'x-webhook-secret': secret } }, { configOverride: config });
  assert.equal((await shared('production-webhook-secret')).status, 401);
  assert.equal((await shared('mailbox-webhook-secret')).status, 401);

  const signed = async (secret, id) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
    const signature = createHmac('sha256', key)
      .update(`${id}.${timestamp}.${rawBody}`).digest('base64');
    return recordEmailEventsFromWebhook({ body, rawBody, headers: {
      'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}`,
    } }, { configOverride: config });
  };
  assert.equal((await signed('production-webhook-secret', 'production-secret')).status, 401);
  assert.equal((await signed('mailbox-webhook-secret', 'mailbox-secret')).status, 400);
});

test('P10A controlled inbound requires the durable alias in the selected mailbox domain', async () => {
  const alias = 'cim-conversation@mailbox-inbound.example.test';
  let resolves = 0;
  let terminalCalls = 0;
  const storage = {
    async resolvePursueCimInboundEvidence() {
      resolves += 1;
      return { exact: true, ambiguous: false, method: 'reply-alias',
        conversation: { id: 'conversation-1', state: 'open', terminal_revision: 0, row_version: 1 },
        transmission: { id: 'transmission-1', reply_to_address: alias },
        campaignIds: ['campaign-1'], touchIds: ['touch-1'], candidateConversations: [] };
    },
    async appendCimTerminalEvent(command) {
      terminalCalls += 1;
      assert.equal(command.evidenceType, 'signed-inbound-reply-alias');
      return { applied: true, replay: false, conflict: false, cancelledTouchIds: ['touch-1'] };
    },
  };
  const event = { id: 'event-1', provider_event_id: 'svix-event-1', provider: 'resend',
    event_type: 'replied', created_at: '2026-10-01T12:00:00.000Z',
    metadata: { rawType: 'email.received', to: [alias] } };
  const profileBinding = { providerProfile: mailboxProfile,
    replyDomain: 'mailbox-inbound.example.test', requireExactReplyAlias: true };
  const result = await applyVerifiedPursueCimInbound(event, { storage, profileBinding });
  assert.equal(result.terminalized, true);
  assert.equal(resolves, 1);
  assert.equal(terminalCalls, 1);

  await assert.rejects(applyVerifiedPursueCimInbound({ ...event,
    metadata: { ...event.metadata, to: ['cim-conversation@production.example.test'] },
  }, { storage, profileBinding }), /domain mismatch/i);
  assert.equal(resolves, 1);
  assert.equal(terminalCalls, 1);
});

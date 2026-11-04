// Ruling S: the owner's controlled test (spec §10 step 5) runs through the real sender and reply
// poller under controlled-mailbox-v1 with DEAL_HUNTER_CIM_MAILBOX_PROVIDER=gmail and exactly one
// allowed recipient. Real SQLite under a controlled clock; only the Gmail mailbox is fake.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROLLED_CIM_MAILBOX_PROFILE } from '../server/config.js';
import { runPursueCimReplyPoll } from '../server/services/pursueCimReplyPoller.js';
import { changeEmailSendingControl } from '../server/services/pursueEmailSending.js';
import { BROKER, SENDER, gmailConfig } from './fixtures/pursueCimGmailGateFixture.js';
import { createSenderFixture } from './fixtures/pursueCimSenderFixture.js';

const MONDAY_0800 = '2030-10-28T15:00:00.000Z';
const MONDAY_0805 = '2030-10-28T15:05:00.000Z';
const CIPHERTEXT = 'v1.aXYtYnl0ZXM=.dGFnLWJ5dGVz.Y2lwaGVydGV4dA==';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly'];
const at = (iso, ms = 0) => new Date(Date.parse(iso) + ms).toISOString();

/** The controlled-mailbox-v1 profile sending through Gmail, as resolveCimProviderProfile builds it. */
function controlledGmailConfig(allowedRecipient) {
  const base = gmailConfig();
  return { ...base, dealHunter: { ...base.dealHunter, cimProvider: {
    enabled: true, profile: CONTROLLED_CIM_MAILBOX_PROFILE, mode: 'controlled-mailbox', provider: 'gmail',
    gmailSenderAddress: SENDER, resendApiKey: '', resendFromEmail: '', resendReplyTo: '',
    resendInboundDomain: '', emailWebhookSecret: '', reconciliationApiKey: '',
    allowedRecipients: [allowedRecipient] } } };
}

const currentChain = (fixture) => fixture.database.prepare(`SELECT capability, provider_profile
  FROM deal_hunter_cim_capability_activations WHERE status = 'current' ORDER BY capability`).all();

test('controlled Gmail test: the allowed recipient gets the initial and a threaded follow-up, and a reply stops the campaign', async (t) => {
  const config = controlledGmailConfig(BROKER);
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, config,
    providerProfile: CONTROLLED_CIM_MAILBOX_PROFILE,
    campaigns: [{ suffix: 'a', dueAt: MONDAY_0800, dueLocal: '2030-10-28T08:00:00' }] });
  const { campaignId, conversationId } = fixture.campaigns.a;

  const first = await fixture.run();
  assert.equal(first.sentInitial, 1, JSON.stringify(first));
  const initial = fixture.mailProvider.sent[0];
  assert.deepEqual([initial.to].flat(), [BROKER]);
  assert.equal(fixture.database.prepare(`SELECT provider_profile FROM
    deal_hunter_cim_live_provider_authorizations`).get().provider_profile, CONTROLLED_CIM_MAILBOX_PROFILE);

  const followUp = fixture.touches(campaignId).find((touch) => touch.kind !== 'initial' && touch.state === 'scheduled');
  fixture.clock.set(at(followUp.due_at, 30_000));
  const second = await fixture.run();
  assert.equal(second.sentFollowUps, 1, JSON.stringify(second));
  const sentFollowUp = fixture.mailProvider.sent[1];
  assert.equal(sentFollowUp.threadId, initial.threadId);
  assert.equal(sentFollowUp.inReplyTo, initial.rfcMessageId);
  assert.deepEqual([sentFollowUp.to].flat(), [BROKER]);

  await fixture.storage.saveGmailConnection({ emailAddress: SENDER, refreshTokenCiphertext: CIPHERTEXT,
    grantedScopes: SCOPES, historyCheckpoint: '0', connectedBy: 'owner', now: fixture.clock.peek().toISOString() });
  fixture.clock.advance(60 * 60_000);
  fixture.mailProvider.injectReply(initial.threadId, {
    internalDate: fixture.clock.peek().toISOString(),
    headers: { from: `Jordan Lee <${BROKER}>`, inReplyTo: sentFollowUp.rfcMessageId,
      references: `${initial.rfcMessageId} ${sentFollowUp.rfcMessageId}`, contentType: 'text/plain; charset=UTF-8' },
    bodyPrefix: 'Thanks, NDA attached.' });
  const poll = await runPursueCimReplyPoll({ storage: fixture.storage, mailProvider: fixture.mailProvider,
    now: fixture.clock });
  assert.equal(poll.responded, 1, JSON.stringify(poll));
  assert.equal(fixture.row('deal_hunter_cim_campaigns', campaignId).state, 'responded');
  assert.equal(fixture.row('deal_hunter_broker_conversations', conversationId).state, 'responded');
  const remaining = fixture.touches(campaignId).filter((touch) => touch.state === 'scheduled');
  assert.deepEqual(remaining, []);

  // Nothing more is sent after the reply.
  fixture.clock.advance(7 * 24 * 60 * 60_000);
  const after = await fixture.run();
  assert.equal(after.sentFollowUps, 0, JSON.stringify(after));
  assert.equal(fixture.mailProvider.sent.length, 2);
});

test('controlled Gmail test: a campaign for any other recipient is refused without a terminal event', async (t) => {
  const config = controlledGmailConfig('owner-test-inbox@example.test');
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, config,
    providerProfile: CONTROLLED_CIM_MAILBOX_PROFILE,
    campaigns: [{ suffix: 'a', dueAt: MONDAY_0800, dueLocal: '2030-10-28T08:00:00' }] });
  const { campaignId } = fixture.campaigns.a;
  const before = fixture.count('deal_hunter_cim_terminal_events');

  const summary = await fixture.run();
  assert.equal(summary.sentInitial, 0, JSON.stringify(summary));
  // Preparation checks the profile binding: the one allowed recipient is not this broker.
  assert.equal(summary.skipped.preparation_failed, 1, JSON.stringify(summary));
  assert.equal(fixture.count('deal_hunter_cim_transmissions'), 0);
  assert.equal(fixture.count('deal_hunter_cim_live_provider_authorizations'), 0);
  assert.equal(fixture.mailProvider.attempts.length, 0);
  assert.equal(fixture.mailProvider.sent.length, 0);
  assert.equal(fixture.count('deal_hunter_cim_terminal_events'), before);
  const campaign = fixture.row('deal_hunter_cim_campaigns', campaignId);
  assert.equal(campaign.state, 'initial-pending');
  // A later run, after the claim lapses, refuses the same way.
  fixture.clock.advance(2 * 60 * 60_000);
  const again = await fixture.run();
  assert.equal(again.sentInitial, 0, JSON.stringify(again));
  assert.equal(fixture.mailProvider.attempts.length, 0);
  assert.equal(fixture.count('deal_hunter_cim_terminal_events'), before);
});

test('Live sending records and withdraws the chain under the active Gmail profile', async (t) => {
  const config = controlledGmailConfig(BROKER);
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, config,
    providerProfile: CONTROLLED_CIM_MAILBOX_PROFILE, campaigns: [] });
  // Start from Live sending off with nothing current, then turn it on through the card's service.
  const { liveSending } = await fixture.storage.getPursueSendControls();
  const off = await changeEmailSendingControl({ storage: fixture.storage, config, actor: 'owner', now: at(MONDAY_0805, 60_000),
    command: { controlKey: 'live_sending', enabled: false, expectedRevision: liveSending.revision, reason: '' } });
  assert.equal(off.ok, true);
  assert.deepEqual(currentChain(fixture), []);
  const on = await changeEmailSendingControl({ storage: fixture.storage, config, actor: 'owner', now: at(MONDAY_0805, 120_000),
    command: { controlKey: 'live_sending', enabled: true, expectedRevision: off.control.revision, reason: '' } });
  assert.equal(on.ok, true);
  assert.deepEqual(currentChain(fixture).map((row) => row.provider_profile),
    Array(4).fill(CONTROLLED_CIM_MAILBOX_PROFILE));
  assert.equal(on.control.capabilitiesInSync, true);
  assert.equal(on.control.providerProfile, CONTROLLED_CIM_MAILBOX_PROFILE);
  const offAgain = await changeEmailSendingControl({ storage: fixture.storage, config, actor: 'owner',
    now: at(MONDAY_0805, 180_000), command: { controlKey: 'live_sending', enabled: false,
      expectedRevision: on.control.revision, reason: '' } });
  assert.equal(offAgain.control.capabilitiesInSync, true);
  assert.deepEqual(currentChain(fixture), []);
});

test('a production-gmail-v1 chain does not authorize the controlled test', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, config: controlledGmailConfig(BROKER),
    campaigns: [{ suffix: 'a', dueAt: MONDAY_0800, dueLocal: '2030-10-28T08:00:00' }] });
  const summary = await fixture.run();
  assert.equal(summary.sentInitial, 0, JSON.stringify(summary));
  assert.equal(summary.stoppedFor, 'not_ready');
  assert.equal(summary.skipped.capability_inactive, 1, JSON.stringify(summary));
  assert.equal(fixture.mailProvider.attempts.length, 0);
});

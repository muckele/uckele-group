// Task 9: the Gmail reply poller (spec 2026-11-03 §6). Real SQLite under a controlled clock; only
// the Gmail mailbox is the fake provider. The initial email is sent by the real sender first, so
// the thread, our own Message-ID and the scheduled follow-up are all real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PURSUE_CIM_REPLY_POLLER_JOB_NAME,
  startPursueCimReplyPollerScheduler,
} from '../server/services/pursueCimReplyPollerScheduler.js';
import { runPursueCimReplyPoll } from '../server/services/pursueCimReplyPoller.js';
import {
  createCimGmailReconciliationLookup,
  reconcileCimProviderTransmission,
} from '../server/services/pursueCimProvider.js';
import { cimRfcMessageId } from '../server/services/cimMailProvider.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { MINUTE, createSenderFixture } from './fixtures/pursueCimSenderFixture.js';
import { BROKER, SENDER } from './fixtures/pursueCimGmailGateFixture.js';

// Monday 2030-10-28 08:05 PDT, and Wednesday 08:05 PDT when follow-up-1 is due.
const MONDAY_0800 = '2030-10-28T15:00:00.000Z';
const MONDAY_0805 = '2030-10-28T15:05:00.000Z';
const MONDAY_1000 = '2030-10-28T17:00:00.000Z';
const WEDNESDAY_0805 = '2030-10-30T15:05:00.000Z';
const CIPHERTEXT = 'v1.aXYtYnl0ZXM=.dGFnLWJ5dGVz.Y2lwaGVydGV4dA==';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly'];
const COLLEAGUE = 'assistant@brokerage.test';

async function sentWorld(t, { connect = true } = {}) {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [{ suffix: 'a', dueAt: MONDAY_0800, dueLocal: '2030-10-28T08:00:00' }] });
  const sent = await fixture.run();
  assert.equal(sent.sentInitial, 1, JSON.stringify(sent));
  if (connect) {
    await fixture.storage.saveGmailConnection({ emailAddress: SENDER,
      refreshTokenCiphertext: CIPHERTEXT, grantedScopes: SCOPES, historyCheckpoint: '0',
      connectedBy: 'owner', now: MONDAY_0805 });
  }
  const ids = fixture.campaigns.a;
  fixture.clock.set(MONDAY_1000);
  return {
    ...fixture,
    ids,
    thread: () => fixture.row('deal_hunter_broker_conversations', ids.conversationId).gmail_thread_id,
    campaign: () => fixture.row('deal_hunter_cim_campaigns', ids.campaignId),
    conversation: () => fixture.row('deal_hunter_broker_conversations', ids.conversationId),
    followUp: () => fixture.touches(ids.campaignId).find((touch) => touch.kind !== 'initial'),
    checkpoint: async () => (await fixture.storage.getGmailConnection()).history_checkpoint,
    terminalEvents: () => fixture.count('deal_hunter_cim_terminal_events'),
    replyRows: () => fixture.database.prepare(`SELECT * FROM deal_hunter_gmail_reply_messages
      ORDER BY gmail_message_id`).all(),
    inject(headers = {}, bodyPrefix = 'Thanks for reaching out. NDA attached.', extra = {}) {
      return fixture.mailProvider.injectReply(this.thread(), {
        internalDate: fixture.clock.peek().toISOString(),
        headers: { from: `Jordan Lee <${BROKER}>`,
          inReplyTo: fixture.mailProvider.sent[0].rfcMessageId,
          references: fixture.mailProvider.sent[0].rfcMessageId,
          contentType: 'text/plain; charset=UTF-8', ...headers },
        bodyPrefix, ...extra });
    },
    poll: (overrides = {}) => runPursueCimReplyPoll({ storage: fixture.storage,
      mailProvider: fixture.mailProvider, now: fixture.clock, ...overrides }),
  };
}

/** A store whose named method throws once, as if the process died at that call. */
function crashingOnce(storage, method) {
  let crashed = false;
  return new Proxy(storage, { get(target, name) {
    if (name === method && !crashed) {
      return async () => { crashed = true; throw new Error('synthetic process death'); };
    }
    const value = target[name];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('no Gmail connection skips the poll with gmail_not_connected', async (t) => {
  const world = await sentWorld(t, { connect: false });
  world.inject();
  const summary = await world.poll();
  assert.equal(summary.stoppedFor, 'gmail_not_connected');
  assert.equal(summary.processed, 0);
  assert.equal(world.campaign().state, 'active-follow-up');
  assert.equal(world.replyRows().length, 0);
});

test('reply stops the campaign and cancels scheduled follow-ups', async (t) => {
  const world = await sentWorld(t);
  assert.equal(world.followUp().state, 'scheduled');
  const before = world.terminalEvents();
  // Review Focus 2: the broker's assistant answers from another address. The thread decides.
  const reply = world.inject({ from: `Assistant <${COLLEAGUE}>` });
  const summary = await world.poll();
  assert.deepEqual(summary, { processed: 2, responded: 1, ownerReplied: 0, bounced: 0,
    autoReplies: 0, stopped: 0, pending: 0, failed: 0, checkpointExpired: false,
    checkpointAdvanced: true });
  assert.equal(world.conversation().state, 'responded');
  const campaign = world.campaign();
  assert.equal(campaign.state, 'responded');
  assert.equal(campaign.reason_code, 'reply_received');
  assert.equal(world.followUp().state, 'cancelled-before-provider');
  assert.equal(world.followUp().terminal_reason, 'reply_received');
  assert.equal(world.terminalEvents(), before + 2); // conversation + its campaign
  const event = world.database.prepare(`SELECT * FROM deal_hunter_cim_terminal_events
    WHERE scope = 'conversation'`).get();
  assert.equal(event.evidence_id, `gmail-message:${reply.id}`);
  assert.equal(event.evidence_type, 'gmail-inbound-gmail-thread');
  assert.equal(event.actor, 'pursue-cim-reply-poller');
  // Our own initial email is recorded as ours and ignored.
  assert.deepEqual(world.replyRows().map((row) => [row.gmail_message_id, row.classification,
    row.applied]), [[world.mailProvider.sent[0].messageId, 'ours', 1], [reply.id, 'reply', 1]]);
  assert.equal(await world.checkpoint(), '2');
  // Nothing more to do on the next run; the responded conversation is no longer polled.
  const again = await world.poll();
  assert.equal(again.processed, 0);
  assert.equal(world.terminalEvents(), before + 2);
});

test('owner reply stops with owner_replied', async (t) => {
  const world = await sentWorld(t);
  world.inject({ from: `Mathew Uckele <${SENDER.toUpperCase()}>`, messageId: '<CAowner@mail.gmail.com>' },
    'Jordan, calling you now.', { labelIds: ['SENT'] });
  const summary = await world.poll();
  assert.equal(summary.ownerReplied, 1, JSON.stringify(summary));
  assert.equal(summary.responded, 0);
  assert.equal(world.conversation().state, 'stopped');
  const campaign = world.campaign();
  assert.equal(campaign.state, 'stopped');
  assert.equal(campaign.reason_code, 'owner_replied');
  assert.equal(world.followUp().state, 'cancelled-before-provider');
  assert.equal(world.followUp().terminal_reason, 'owner_replied');
});

test('auto-reply is logged and follow-ups continue', async (t) => {
  const world = await sentWorld(t);
  const before = world.terminalEvents();
  const autoReply = world.inject({ autoSubmitted: 'auto-replied' },
    'I am out of the office. Please stop by next week.');
  const summary = await world.poll();
  assert.equal(summary.autoReplies, 1, JSON.stringify(summary));
  assert.equal(summary.stopped, 0);
  assert.equal(world.terminalEvents(), before);
  assert.equal(world.campaign().state, 'active-follow-up');
  assert.equal(world.conversation().state, 'open');
  assert.equal(world.followUp().state, 'scheduled');
  const row = world.replyRows().find((item) => item.gmail_message_id === autoReply.id);
  assert.equal(row.classification, 'auto-reply');
  assert.equal(row.conversation_id, world.ids.conversationId);
  assert.equal(await world.storage.getActiveEmailSuppression(BROKER), null);
  // The follow-up still goes out on Wednesday, in the same thread.
  world.clock.set(WEDNESDAY_0805);
  const sender = await world.run();
  assert.equal(sender.sentFollowUps, 1, JSON.stringify(sender));
  assert.equal(world.mailProvider.sent[1].threadId, world.thread());
});

test('bounce moves to action-required recipient_bounced', async (t) => {
  const world = await sentWorld(t);
  world.inject({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    contentType: 'multipart/report; report-type=delivery-status; boundary="x"',
    inReplyTo: null, references: null },
  'Address not found. Your message wasn\'t delivered to broker@example.test.');
  const summary = await world.poll();
  assert.equal(summary.bounced, 1, JSON.stringify(summary));
  const campaign = world.campaign();
  assert.equal(campaign.state, 'action-required');
  assert.equal(campaign.reason_code, 'recipient_bounced');
  assert.equal(world.conversation().state, 'reply-review-required');
  assert.equal(world.followUp().state, 'cancelled-before-provider');
  assert.equal(world.followUp().terminal_reason, 'recipient_bounced');
  // The owner can still see a later broker reply on the same thread.
  world.inject();
  const later = await world.poll();
  assert.equal(later.responded, 1, JSON.stringify(later));
  assert.equal(world.campaign().state, 'responded');
});

test('stop suppresses the recipient for future listings', async (t) => {
  const world = await sentWorld(t);
  world.inject({}, 'Please remove me from your list.\n\nOn Mon, Oct 28, 2030 Mathew wrote:\n> just reply "stop".');
  const summary = await world.poll();
  assert.equal(summary.stopped, 1, JSON.stringify(summary));
  assert.equal(summary.responded, 0);
  const campaign = world.campaign();
  assert.equal(campaign.state, 'responded');
  assert.equal(campaign.reason_code, 'reply_received');
  assert.equal(world.followUp().state, 'cancelled-before-provider');
  const suppression = await world.storage.getActiveEmailSuppression(BROKER);
  assert.ok(suppression, 'the recipient is suppressed');
  assert.equal(suppression.reason, 'explicit-opt-out');
  assert.equal(suppression.source, 'gmail-reply');
  assert.equal(suppression.created_by, 'pursue-cim-reply-poller');
});

test('a reply that only quotes our "stop" footer does not suppress', async (t) => {
  const world = await sentWorld(t);
  world.inject({}, 'Happy to share. NDA attached.\n\nOn Mon, Oct 28, 2030 Mathew wrote:\n'
    + '> If you would rather I not reach out about future listings, just reply "stop".');
  const summary = await world.poll();
  assert.equal(summary.responded, 1, JSON.stringify(summary));
  assert.equal(summary.stopped, 0);
  assert.equal(await world.storage.getActiveEmailSuppression(BROKER), null);
});

test('expired checkpoint falls back to per-thread reads and processes no message twice', async (t) => {
  const world = await sentWorld(t);
  world.inject({ xAutoreply: 'yes' }, 'Out of office.');
  const first = await world.poll();
  assert.equal(first.processed, 2, JSON.stringify(first));
  assert.equal(first.autoReplies, 1);
  assert.equal(await world.checkpoint(), '2');
  const before = world.terminalEvents();

  world.clock.advance(60_000);
  const reply = world.inject();
  world.mailProvider.expireCheckpointNext();
  const second = await world.poll();
  // The whole thread came back (ours, the auto-reply and the reply); only the reply is new.
  assert.equal(second.checkpointExpired, true);
  assert.equal(second.processed, 1, JSON.stringify(second));
  assert.equal(second.autoReplies, 0);
  assert.equal(second.responded, 1);
  assert.equal(world.terminalEvents(), before + 2);
  assert.deepEqual(world.replyRows().map((row) => row.classification).sort(),
    ['auto-reply', 'ours', 'reply']);
  assert.equal(world.replyRows().filter((row) => row.gmail_message_id === reply.id).length, 1);
  assert.equal(await world.checkpoint(), '3');
});

/** A store whose recordGmailReplyMessage throws once for the matching command. */
function dyingAtRecord(storage, matches) {
  const state = { died: false };
  const proxy = new Proxy(storage, { get(target, name) {
    const value = target[name];
    if (name === 'recordGmailReplyMessage') {
      return async (command) => {
        if (!state.died && matches(command)) {
          state.died = true;
          throw new Error('synthetic process death');
        }
        return value.call(target, command);
      };
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { proxy, state };
}

test('crash before checkpoint save reprocesses without duplicate terminal events', async (t) => {
  const world = await sentWorld(t);
  world.inject({ from: 'MAILER-DAEMON@googlemail.com' }, 'Delivery failed.');
  const before = world.terminalEvents();

  // The process dies before the bounce is recorded: nothing applied, checkpoint held.
  const unrecorded = dyingAtRecord(world.storage,
    (command) => command.classification === 'bounce' && command.applied === false);
  const lost = await world.poll({ storage: unrecorded.proxy });
  assert.equal(unrecorded.state.died, true);
  assert.equal(lost.failed, 1, JSON.stringify(lost));
  assert.equal(lost.checkpointAdvanced, false);
  assert.equal(world.campaign().state, 'active-follow-up');
  assert.equal(world.terminalEvents(), before);
  assert.equal(await world.checkpoint(), '0', 'the checkpoint never moves past an unrecorded message');

  // The bounce's terminal event is written, then the process dies before its record is settled
  // and again at the checkpoint save.
  world.clock.advance(60_000);
  const unsettled = dyingAtRecord(crashingOnce(world.storage, 'updateGmailHistoryCheckpoint'),
    (command) => command.classification === 'bounce' && command.applied === true);
  await assert.rejects(() => world.poll({ storage: unsettled.proxy }), /synthetic process death/);
  assert.equal(unsettled.state.died, true);
  assert.equal(await world.checkpoint(), '0');
  assert.equal(world.campaign().state, 'action-required');
  assert.equal(world.terminalEvents(), before + 2);
  assert.equal(world.replyRows().find((row) => row.classification === 'bounce').applied, 0);

  world.clock.advance(60_000);
  const recovered = await world.poll();
  assert.equal(recovered.processed, 0, JSON.stringify(recovered));
  assert.equal(recovered.failed, 0);
  assert.equal(recovered.pending, 0);
  assert.equal(recovered.bounced, 1, 'the pending bounce settles once');
  assert.equal(recovered.checkpointAdvanced, true);
  assert.equal(world.terminalEvents(), before + 2);
  assert.equal(world.campaign().state, 'action-required');
  assert.equal(world.campaign().terminal_revision, 1);
  assert.deepEqual(world.replyRows().map((row) => [row.classification, row.applied]).sort(),
    [['bounce', 1], ['ours', 1]]);
  assert.equal(await world.checkpoint(), '2');
});

test('a reply that cannot be applied stays pending and is applied by the next poll', async (t) => {
  const world = await sentWorld(t);
  world.inject();
  const failing = crashingOnce(world.storage, 'appendCimTerminalEvent');
  const failed = await world.poll({ storage: failing });
  assert.equal(failed.pending, 1, JSON.stringify(failed));
  assert.equal(failed.responded, 0, 'an unapplied reply is not counted as responded');
  assert.equal(failed.failed, 0);
  // The reply is recorded, so the checkpoint may move on: the record is what gets retried.
  assert.equal(await world.checkpoint(), '2');
  assert.equal(world.campaign().state, 'active-follow-up');
  const retried = await world.poll();
  assert.equal(retried.responded, 1, JSON.stringify(retried));
  assert.equal(retried.pending, 0);
  assert.equal(retried.processed, 0);
  assert.equal(world.campaign().state, 'responded');
});

test('a stop word is never lost: suppression and terminal survive a crash at either step', async (t) => {
  // The process dies at the suppression write, after the terminal event.
  const world = await sentWorld(t);
  world.inject({}, 'Stop.');
  const suppressionDies = crashingOnce(world.storage, 'upsertEmailSuppression');
  const first = await world.poll({ storage: suppressionDies });
  assert.equal(first.pending, 1, JSON.stringify(first));
  assert.equal(first.stopped, 0);
  assert.equal(world.conversation().state, 'responded');
  assert.equal(await world.storage.getActiveEmailSuppression(BROKER), null);
  // The conversation is terminal and no longer polled, but its pending record is applied again.
  const second = await world.poll();
  assert.equal(second.stopped, 1, JSON.stringify(second));
  assert.equal(second.processed, 0);
  assert.equal((await world.storage.getActiveEmailSuppression(BROKER)).reason, 'explicit-opt-out');
  assert.equal(world.replyRows().find((row) => row.classification === 'stop').applied, 1);
  assert.equal(world.campaign().reason_code, 'reply_received');

  // The process dies after every effect, before the record is settled.
  const other = await sentWorld(t);
  other.inject({}, 'Please unsubscribe me.');
  const settleDies = dyingAtRecord(other.storage,
    (command) => command.classification === 'stop' && command.applied === true);
  const crashed = await other.poll({ storage: settleDies.proxy });
  assert.equal(settleDies.state.died, true);
  assert.equal(crashed.pending, 1, JSON.stringify(crashed));
  assert.ok(await other.storage.getActiveEmailSuppression(BROKER));
  assert.equal(other.campaign().state, 'responded');
  const terminalEvents = other.terminalEvents();
  const settled = await other.poll();
  assert.equal(settled.stopped, 1, JSON.stringify(settled));
  assert.equal(other.terminalEvents(), terminalEvents);
  assert.equal(other.replyRows().find((row) => row.classification === 'stop').applied, 1);
});

test('a stop word suppresses the recipient even while the terminal write keeps failing', async (t) => {
  const world = await sentWorld(t);
  world.inject({}, 'Stop emailing me.');
  // The terminal write throws on every attempt.
  const terminalAlwaysFails = new Proxy(world.storage, { get(target, name) {
    if (name === 'appendCimTerminalEvent') {
      return async () => { throw new Error('synthetic terminal failure'); };
    }
    const value = target[name];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const first = await world.poll({ storage: terminalAlwaysFails });
  assert.deepEqual([first.pending, first.stopped], [1, 0], JSON.stringify(first));
  const suppression = await world.storage.getActiveEmailSuppression(BROKER);
  assert.ok(suppression, 'the opt-out is honored on the first attempt');
  assert.deepEqual([suppression.reason, suppression.source], ['explicit-opt-out', 'gmail-reply']);
  assert.equal(world.replyRows().find((row) => row.classification === 'stop').applied, 0,
    'the record stays pending until the terminal is written too');
  // The suppression alone already stops the campaign, so no follow-up can go out meanwhile.
  assert.deepEqual([world.campaign().state, world.campaign().reason_code], ['stopped', 'recipient_suppressed']);
  assert.equal(world.followUp().state, 'cancelled-before-provider');
  const second = await world.poll({ storage: terminalAlwaysFails });
  assert.equal(second.pending, 1, JSON.stringify(second));
  assert.equal(world.count('email_suppressions'), 1, 'suppression is written once');
  // Once the terminal write works, the record settles and the campaign stops.
  const settled = await world.poll();
  assert.equal(settled.stopped, 1, JSON.stringify(settled));
  assert.equal(world.conversation().state, 'responded');
  assert.equal(world.replyRows().find((row) => row.classification === 'stop').applied, 1);
});

/** World with follow-up-1 sent ambiguous and not found: the conversation is provider-ambiguous. */
async function ambiguousWorld(t) {
  const world = await sentWorld(t);
  world.clock.set(WEDNESDAY_0805);
  world.mailProvider.failNext('ambiguous');
  const sender = await world.run();
  assert.equal(sender.ambiguous, 1, JSON.stringify(sender));
  assert.equal(world.conversation().state, 'provider-ambiguous');
  assert.equal(world.campaign().state, 'provider-ambiguous');
  return world;
}

/** The owner finds follow-up-1 in Gmail after all: reconciled accepted, the conversation reopens. */
async function reconcileFollowUp(world) {
  const transmission = world.database.prepare(`SELECT tr.* FROM deal_hunter_cim_transmissions tr
    WHERE tr.conversation_id = ? AND tr.state = 'ambiguous'`).get(world.ids.conversationId);
  const at = world.clock.peek();
  const reconciled = await reconcileCimProviderTransmission({ storage: world.storage,
    transmission, readProviderEvidence: createCimGmailReconciliationLookup({
      mailProvider: { async findSent() {
        return { found: true, messageId: 'gmail-late-1', threadId: world.thread() };
      } }, clock: () => at }),
    providerProfile: 'production-gmail-v1', actor: 'owner', now: at, configOverride: world.config });
  assert.equal(reconciled.outcome, 'accepted', JSON.stringify(reconciled));
  assert.equal(world.conversation().state, 'open');
  assert.equal(world.campaign().state, 'active-follow-up');
}

test('a reply held while provider-ambiguous is applied once the conversation reopens', async (t) => {
  const world = await ambiguousWorld(t);
  world.clock.advance(60 * MINUTE);
  world.inject({}, 'Yes, still available. NDA attached.');
  const held = await world.poll();
  assert.equal(held.processed, 2, JSON.stringify(held)); // our initial email and the reply
  assert.equal(held.responded, 0, 'an unapplied reply is not counted as responded');
  assert.equal(held.pending, 1);
  assert.equal(world.replyRows().find((row) => row.classification === 'reply').applied, 0);
  // Still provider-ambiguous: the next poll keeps it pending and writes nothing.
  const terminalEvents = world.terminalEvents();
  assert.equal((await world.poll()).pending, 1);
  assert.equal(world.terminalEvents(), terminalEvents);

  await reconcileFollowUp(world);
  const applied = await world.poll();
  assert.equal(applied.responded, 1, JSON.stringify(applied));
  assert.equal(applied.pending, 0);
  assert.equal(world.campaign().state, 'responded');
  assert.equal(world.conversation().state, 'responded');
  assert.ok(world.touches(world.ids.campaignId).filter((touch) => touch.state === 'scheduled')
    .length === 0, 'no follow-up remains scheduled');
});

test('the sender applies a held reply before sending the next follow-up, even if the poller never ran', async (t) => {
  const world = await ambiguousWorld(t);
  world.clock.advance(60 * MINUTE);
  world.inject({}, 'Yes, still available. NDA attached.');
  assert.equal((await world.poll()).pending, 1);
  await reconcileFollowUp(world);
  const next = world.touches(world.ids.campaignId).find((touch) => touch.state === 'scheduled');
  assert.ok(next, 'the reopened campaign scheduled its next follow-up');
  const attempts = world.mailProvider.attempts.length;

  // The next follow-up falls due; only the sender runs.
  world.clock.set(new Date(Date.parse(next.due_at) + 5 * MINUTE).toISOString());
  const sender = await world.run();
  assert.equal(sender.sentFollowUps, 0, JSON.stringify(sender));
  assert.equal(world.mailProvider.attempts.length, attempts, 'nothing was sent to a broker who answered');
  assert.equal(world.campaign().state, 'responded');
  assert.equal(world.row('deal_hunter_cim_campaign_touches', next.id).state,
    'cancelled-before-provider');
  assert.equal(world.replyRows().find((row) => row.classification === 'reply').applied, 1);
});

test('the sender sends nothing to a conversation whose held reply cannot be applied', async (t) => {
  const world = await ambiguousWorld(t);
  world.clock.advance(60 * MINUTE);
  world.inject();
  assert.equal((await world.poll()).pending, 1);
  await reconcileFollowUp(world);
  const next = world.touches(world.ids.campaignId).find((touch) => touch.state === 'scheduled');
  world.clock.set(new Date(Date.parse(next.due_at) + 5 * MINUTE).toISOString());
  const attempts = world.mailProvider.attempts.length;
  const sender = await world.run({ storage: crashingOnce(world.storage, 'appendCimTerminalEvent') });
  assert.equal(sender.skipped.gmail_reply_pending, 1, JSON.stringify(sender));
  assert.equal(world.mailProvider.attempts.length, attempts);
  assert.equal(world.row('deal_hunter_cim_campaign_touches', next.id).state, 'scheduled');
});

test('the sender holds every conversation with a pending reply, beyond the 200-row page', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: ['a', 'b'].map((suffix) => ({ suffix, dueAt: MONDAY_0800,
      dueLocal: '2030-10-28T08:00:00' })) });
  const initials = await fixture.run();
  assert.equal(initials.sentInitial, 2, JSON.stringify(initials));
  const threadOf = (suffix) => fixture.row('deal_hunter_broker_conversations',
    fixture.campaigns[suffix].conversationId).gmail_thread_id;
  // 201 earlier pending replies on b fill the re-apply page; a's pending reply comes after them.
  const base = Date.parse(MONDAY_1000);
  const pending = (suffix, index) => fixture.storage.recordGmailReplyMessage({
    gmailMessageId: `pending-${suffix}-${index}`, gmailThreadId: threadOf(suffix),
    conversationId: fixture.campaigns[suffix].conversationId, classification: 'reply',
    fromFingerprint: null, messageAt: null, applied: false,
    now: new Date(base + index * 1000).toISOString() });
  for (let index = 0; index < 201; index += 1) await pending('b', index);
  await pending('a', 500);
  assert.equal((await fixture.storage.listPendingGmailReplyMessages({ limit: 200 }))
    .some((row) => row.conversationId === fixture.campaigns.a.conversationId), false);

  const followUp = fixture.touches(fixture.campaigns.a.campaignId)
    .find((touch) => touch.kind !== 'initial' && touch.state === 'scheduled');
  fixture.clock.set(new Date(Date.parse(followUp.due_at) + 5 * MINUTE).toISOString());
  const attempts = fixture.mailProvider.attempts.length;
  const sender = await fixture.run();
  assert.equal(sender.sentFollowUps, 0, JSON.stringify(sender));
  assert.ok(sender.skipped.gmail_reply_pending >= 1, JSON.stringify(sender));
  assert.equal(fixture.mailProvider.attempts.length, attempts);
  assert.equal(fixture.row('deal_hunter_cim_campaign_touches', followUp.id).state, 'scheduled');
});

test('our follow-up sent while the history is read is ours, not an owner reply', async (t) => {
  const world = await sentWorld(t);
  const fake = world.mailProvider;
  // The sender's slot fires between the poller's open-conversation read and its history read.
  const racing = { async listThreadChanges(input) {
    world.clock.set(WEDNESDAY_0805);
    const sent = await world.run();
    assert.equal(sent.sentFollowUps, 1, JSON.stringify(sent));
    return fake.listThreadChanges(input);
  } };
  const summary = await world.poll({ mailProvider: racing });
  assert.equal(summary.ownerReplied, 0, JSON.stringify(summary));
  assert.equal(summary.processed, 2);
  assert.equal(world.campaign().state, 'active-follow-up');
  assert.deepEqual(world.replyRows().map((row) => row.classification), ['ours', 'ours']);
  assert.ok(world.replyRows().some((row) => row.gmail_message_id === fake.sent[1].messageId));
});

test('an unsent Gmail draft in the thread is skipped and not recorded', async (t) => {
  const world = await sentWorld(t);
  const draft = world.inject({ from: SENDER, messageId: '<CAdraft@mail.gmail.com>' },
    'Jordan, following up on', { labelIds: ['DRAFT'] });
  const summary = await world.poll();
  assert.equal(summary.ownerReplied, 0, JSON.stringify(summary));
  assert.equal(summary.processed, 1);
  assert.equal(world.campaign().state, 'active-follow-up');
  assert.equal(world.replyRows().some((row) => row.gmail_message_id === draft.id), false);
  assert.equal(summary.checkpointAdvanced, true);
  // Sent later, it arrives as a new message and stops the campaign as the owner's reply.
  world.inject({ from: SENDER, messageId: '<CAsent@mail.gmail.com>' }, 'Jordan, following up on',
    { labelIds: ['SENT'] });
  assert.equal((await world.poll()).ownerReplied, 1);
  assert.equal(world.campaign().reason_code, 'owner_replied');
});

test('no message body is persisted', async (t) => {
  const world = await sentWorld(t);
  const marker = 'BODY-MARKER-7f3a9c';
  world.inject({ from: `Assistant <${COLLEAGUE}>` }, `Here is the teaser. ${marker} Call me anytime.`);
  world.inject({ autoSubmitted: 'auto-replied' }, `Out of office ${marker}-auto`);
  const summary = await world.poll();
  assert.equal(summary.processed, 3, JSON.stringify(summary));
  const tables = world.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all().map(({ name }) => name);
  for (const table of tables) {
    const dump = JSON.stringify(world.database.prepare(`SELECT * FROM "${table}"`).all());
    assert.ok(!dump.includes(marker), `${table} holds a message body`);
    assert.ok(!dump.toLowerCase().includes(COLLEAGUE), `${table} holds a raw From address`);
  }
  const columns = world.database.prepare('PRAGMA table_info(deal_hunter_gmail_reply_messages)')
    .all().map(({ name }) => name).sort();
  assert.deepEqual(columns, ['applied', 'classification', 'conversation_id', 'from_fingerprint',
    'gmail_message_id', 'gmail_thread_id', 'message_at', 'processed_at']);
  const reply = world.replyRows().find((row) => row.classification === 'reply');
  assert.match(reply.from_fingerprint, /^[0-9a-f]{64}$/);
});

function schedulerHarness(t, { enabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursue-reply-poller-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(root, 'poller.sqlite') } });
  let current = new Date('2030-10-28T15:07:00.000Z');
  const logs = [];
  const timers = [];
  const schedulers = [];
  t.after(() => {
    for (const scheduler of schedulers) scheduler.stop();
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    storage, logs, timers,
    set(iso) { current = new Date(iso); },
    start(extra = {}) {
      const scheduler = startPursueCimReplyPollerScheduler({ storage,
        config: { dealHunter: { replyPoller: { enabled, intervalMinutes: 5 } } },
        now: () => current,
        setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
        clearTimer: () => {},
        logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
        ...extra });
      schedulers.push(scheduler);
      return scheduler;
    },
    jobs: () => storage.listScheduledJobs({ limit: 50 }).then((rows) => rows
      .filter((row) => row.job_name === PURSUE_CIM_REPLY_POLLER_JOB_NAME)),
  };
}

test('the reply poller scheduler is off unless enabled', async (t) => {
  const h = schedulerHarness(t, { enabled: false });
  let runs = 0;
  const scheduler = h.start({ run: async () => { runs += 1; return {}; } });
  await scheduler.tick();
  assert.equal(runs, 0);
  assert.equal(h.timers.length, 0);
  assert.ok(h.logs.some((line) => line.includes('disabled')));
});

test('the reply poller runs once per 5-minute slot and records counts only', async (t) => {
  const h = schedulerHarness(t);
  let runs = 0;
  const scheduler = h.start({ run: async () => {
    runs += 1;
    return { processed: 3, responded: 1, ownerReplied: 0, bounced: 1, autoReplies: 1, stopped: 0,
      pending: 2, failed: 0, checkpointExpired: true, checkpointAdvanced: true,
      body: 'never stored' };
  } });
  await Promise.all([scheduler.tick(), scheduler.tick()]);
  await h.start({ run: async () => { runs += 1; return {}; } }).tick();
  assert.equal(runs, 1);
  h.set('2030-10-28T15:11:00.000Z');
  await scheduler.tick();
  assert.equal(runs, 2);
  const jobs = await h.jobs();
  assert.equal(jobs.length, 2);
  const [row] = jobs.filter((job) => job.job_key.endsWith('2030-10-28T15:05:00.000Z'));
  assert.equal(row.status, 'completed');
  assert.equal(row.metadata.processed, 3);
  assert.equal(row.metadata.bounced, 1);
  assert.equal(row.metadata.pending, 2);
  assert.equal(row.metadata.checkpointExpired, true);
  assert.equal(JSON.stringify(row).includes('never stored'), false);
});

test('a not-connected run is recorded as completed with its reason', async (t) => {
  const h = schedulerHarness(t);
  const scheduler = h.start();
  await scheduler.tick();
  const [row] = await h.jobs();
  assert.equal(row.status, 'completed', JSON.stringify(row));
  assert.equal(row.metadata.stoppedFor, 'gmail_not_connected');
  assert.equal(row.metadata.processed, 0);
});

/** A sender world whose Gmail replaces our Message-ID with its own on every accepted send. */
async function rewrittenWorld(t, { failRead = false } = {}) {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [{ suffix: 'a', dueAt: MONDAY_0800, dueLocal: '2030-10-28T08:00:00' }] });
  fixture.mailProvider.rewriteMessageIds();
  if (failRead) fixture.mailProvider.failReadMessageIdNext();
  const sent = await fixture.run();
  assert.equal(sent.sentInitial, 1, JSON.stringify(sent));
  const [initial] = fixture.mailProvider.sent;
  const transmission = fixture.database.prepare(`SELECT * FROM deal_hunter_cim_transmissions
    WHERE id = ?`).get(initial.transmissionId);
  const messageIdOf = (transmissionId) => fixture.database.prepare(`SELECT c.message_id
    FROM deal_hunter_cim_transmissions tr JOIN crm_communications c ON c.id = tr.communication_id
    WHERE tr.id = ?`).get(transmissionId).message_id;
  const sendFollowUp = async () => {
    const touch = fixture.touches(fixture.campaigns.a.campaignId)
      .find((row) => row.kind !== 'initial' && row.state === 'scheduled');
    fixture.clock.set(new Date(Date.parse(touch.due_at) + 30_000).toISOString());
    const summary = await fixture.run();
    assert.equal(summary.sentFollowUps, 1, JSON.stringify(summary));
    return fixture.mailProvider.sent.at(-1);
  };
  return { ...fixture, initial, transmission, ours: cimRfcMessageId(initial.transmissionId, SENDER),
    messageIdOf, sendFollowUp };
}

test('Gmail rewrote our Message-ID: the real one is stored, followed up to, recognized as ours, and found', async (t) => {
  const world = await rewrittenWorld(t);
  const { initial, ours } = world;
  assert.notEqual(initial.rfcMessageId, ours);
  assert.equal(initial.requestedRfcMessageId, ours);
  // The communication keeps the Message-ID Gmail actually sent.
  assert.equal(world.messageIdOf(initial.transmissionId), initial.rfcMessageId);

  // The follow-up threads to the real Message-ID.
  const followUp = await world.sendFollowUp();
  assert.equal(followUp.threadId, initial.threadId);
  assert.equal(followUp.inReplyTo, initial.rfcMessageId);
  assert.deepEqual(followUp.references, [initial.rfcMessageId]);
  assert.equal(world.messageIdOf(followUp.transmissionId), followUp.rfcMessageId);

  // The reply poller reads both sent copies as ours, not as owner replies.
  await world.storage.saveGmailConnection({ emailAddress: SENDER, refreshTokenCiphertext: CIPHERTEXT,
    grantedScopes: SCOPES, historyCheckpoint: '0', connectedBy: 'owner',
    now: world.clock.peek().toISOString() });
  const poll = await runPursueCimReplyPoll({ storage: world.storage, mailProvider: world.mailProvider,
    now: world.clock });
  assert.deepEqual([poll.processed, poll.ownerReplied, poll.responded], [2, 0, 0], JSON.stringify(poll));
  assert.deepEqual(world.database.prepare(`SELECT classification FROM deal_hunter_gmail_reply_messages`)
    .all().map(({ classification }) => classification), ['ours', 'ours']);
  assert.equal(world.row('deal_hunter_cim_campaigns', world.campaigns.a.campaignId).state, 'active-follow-up');

  // findSent searches the stored Message-ID first, so the sent initial is found. (The proof is
  // captured at the lookup: the initial is already accepted, so nothing is reconciled.)
  const lookup = createCimGmailReconciliationLookup({ mailProvider: world.mailProvider,
    storage: world.storage, clock: () => world.clock.peek() });
  let proof;
  await assert.rejects(reconcileCimProviderTransmission({ storage: world.storage,
    transmission: world.transmission, providerProfile: 'production-gmail-v1', actor: 'owner',
    now: world.clock.peek(), configOverride: world.config,
    readProviderEvidence: async (input) => {
      proof = await lookup(input);
      throw new Error('proof captured');
    } }), /proof captured/);
  assert.equal(proof.outcome, 'accepted', JSON.stringify(proof));
  assert.deepEqual(proof.candidates.map(({ providerMessageId }) => providerMessageId),
    [initial.messageId]);
  // Without the stored Message-ID, our own is searched and Gmail has no message with it.
  const oursOnly = createCimGmailReconciliationLookup({ mailProvider: world.mailProvider,
    clock: () => world.clock.peek() });
  await assert.rejects(reconcileCimProviderTransmission({ storage: world.storage,
    transmission: world.transmission, providerProfile: 'production-gmail-v1', actor: 'owner',
    now: world.clock.peek(), configOverride: world.config,
    readProviderEvidence: async (input) => {
      proof = await oursOnly(input);
      throw new Error('proof captured');
    } }), /proof captured/);
  assert.equal(proof.outcome, 'unresolved');
});

test('a failed read of the sent Message-ID keeps ours and changes nothing', async (t) => {
  const world = await rewrittenWorld(t, { failRead: true });
  assert.equal(world.messageIdOf(world.initial.transmissionId), null);
  assert.equal(world.row('deal_hunter_cim_campaigns', world.campaigns.a.campaignId).state, 'active-follow-up');
  const followUp = await world.sendFollowUp();
  assert.equal(followUp.inReplyTo, world.ours);
});

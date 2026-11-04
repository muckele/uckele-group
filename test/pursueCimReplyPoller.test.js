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
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSenderFixture } from './fixtures/pursueCimSenderFixture.js';
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
    autoReplies: 0, stopped: 0, failed: 0, checkpointExpired: false, checkpointAdvanced: true });
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
  assert.deepEqual(world.replyRows().map((row) => [row.gmail_message_id, row.classification]),
    [[world.mailProvider.sent[0].messageId, 'ours'], [reply.id, 'reply']]);
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

test('crash before checkpoint save reprocesses without duplicate terminal events', async (t) => {
  const world = await sentWorld(t);
  world.inject({ from: 'MAILER-DAEMON@googlemail.com' }, 'Delivery failed.');
  const before = world.terminalEvents();

  // The process dies after the bounce's terminal event and before its processed marker.
  let died = false;
  const dying = new Proxy(world.storage, { get(target, name) {
    const value = target[name];
    if (name === 'recordGmailReplyMessage') {
      return async (command) => {
        if (command.classification === 'bounce' && !died) {
          died = true;
          throw new Error('synthetic process death');
        }
        return value.call(target, command);
      };
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const crashed = await world.poll({ storage: dying });
  assert.equal(died, true);
  assert.equal(crashed.failed, 1, JSON.stringify(crashed));
  assert.equal(crashed.checkpointAdvanced, false);
  assert.equal(world.campaign().state, 'action-required');
  assert.equal(world.terminalEvents(), before + 2);
  assert.equal(await world.checkpoint(), '0', 'the checkpoint never moves past an unapplied batch');

  // The process dies at the checkpoint save, after every message was applied.
  world.clock.advance(60_000);
  await assert.rejects(() => world.poll({ storage: crashingOnce(world.storage,
    'updateGmailHistoryCheckpoint') }), /synthetic process death/);
  assert.equal(await world.checkpoint(), '0');
  assert.equal(world.terminalEvents(), before + 2);

  world.clock.advance(60_000);
  const recovered = await world.poll();
  assert.equal(recovered.processed, 0, JSON.stringify(recovered));
  assert.equal(recovered.failed, 0);
  assert.equal(recovered.checkpointAdvanced, true);
  assert.equal(world.terminalEvents(), before + 2);
  assert.equal(world.campaign().state, 'action-required');
  assert.equal(world.campaign().terminal_revision, 1);
  assert.deepEqual(world.replyRows().map((row) => row.classification).sort(), ['bounce', 'ours']);
  assert.equal(await world.checkpoint(), '2');
});

test('a reply that cannot be applied holds the checkpoint and is retried', async (t) => {
  const world = await sentWorld(t);
  world.inject();
  const failing = crashingOnce(world.storage, 'appendCimTerminalEvent');
  const failed = await world.poll({ storage: failing });
  assert.equal(failed.failed, 1, JSON.stringify(failed));
  assert.equal(failed.checkpointAdvanced, false);
  assert.equal(await world.checkpoint(), '0');
  assert.equal(world.campaign().state, 'active-follow-up');
  const retried = await world.poll();
  assert.equal(retried.responded, 1, JSON.stringify(retried));
  assert.equal(world.campaign().state, 'responded');
  assert.equal(await world.checkpoint(), '2');
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
  assert.deepEqual(columns, ['classification', 'conversation_id', 'from_fingerprint',
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
      failed: 0, checkpointExpired: true, checkpointAdvanced: true, body: 'never stored' };
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

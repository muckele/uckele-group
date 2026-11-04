import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCimMailProvider } from '../server/services/cimMailProvider.js';
import { createFakeCimProvider } from '../server/services/fakeCimProvider.js';

const at = '2026-11-03T15:00:00.000Z';

const message = (transmissionId, extra = {}) => ({
  transmissionId,
  to: 'bob@brokerage.com',
  from: { name: 'Matt Uckele', address: 'owner@domain.com' },
  subject: 'Acme Widgets',
  text: 'Hello.',
  ...extra,
});

test('fake provider records sends, honors failNext/quotaNext, and returns injected replies from listThreadChanges', async () => {
  const fake = createFakeCimProvider({ now: () => new Date(at) });
  assert.equal(assertCimMailProvider(fake), fake);
  assert.deepEqual(await fake.readiness(), { ready: true, reasons: [] });

  const first = await fake.send(message('tx-1'));
  assert.equal(first.outcome, 'accepted');
  assert.equal(first.code, 'accepted');
  assert.equal(first.rfcMessageId, '<tx-1@domain.com>');
  assert.ok(first.messageId);
  assert.ok(first.threadId);
  const followUp = await fake.send(message('tx-2', { threadId: first.threadId, inReplyTo: first.rfcMessageId,
    references: [first.rfcMessageId] }));
  assert.equal(followUp.threadId, first.threadId, 'a follow-up stays in the thread');
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].transmissionId, 'tx-2');
  assert.equal(fake.sent[1].rfcMessageId, '<tx-2@domain.com>');
  assert.equal(fake.sent[1].threadId, first.threadId);
  assert.equal(fake.sent[1].inReplyTo, '<tx-1@domain.com>');
  assert.equal(fake.sent[1].sentAt, at);

  fake.failNext('definitive-failure');
  assert.deepEqual(await fake.send(message('tx-3')), { outcome: 'definitive-failure', messageId: null,
    threadId: null, rfcMessageId: '<tx-3@domain.com>', code: 'gmail_400' });
  fake.quotaNext();
  assert.deepEqual(await fake.send(message('tx-4')), { outcome: 'quota', messageId: null, threadId: null,
    rfcMessageId: '<tx-4@domain.com>', code: 'gmail_429' });
  fake.failNext('not-attempted');
  assert.deepEqual(await fake.send(message('tx-5')), { outcome: 'not-attempted', messageId: null,
    threadId: null, rfcMessageId: '<tx-5@domain.com>', code: 'gmail_token_invalid' });
  fake.failNext('ambiguous');
  assert.equal((await fake.send(message('tx-6'))).code, 'gmail_timeout');
  assert.equal(fake.sent.length, 2, 'failed sends never reach the mailbox');
  assert.equal(fake.attempts.length, 6);
  assert.deepEqual(fake.attempts.map((attempt) => attempt.outcome),
    ['accepted', 'accepted', 'definitive-failure', 'quota', 'not-attempted', 'ambiguous']);
  assert.equal((await fake.send(message('tx-7'))).outcome, 'accepted', 'a failure applies once');

  fake.failNext('ambiguous', { delivered: true, code: 'gmail_503' });
  const lost = await fake.send(message('tx-8'));
  assert.deepEqual([lost.outcome, lost.code, lost.messageId], ['ambiguous', 'gmail_503', null]);
  assert.equal(fake.sent.at(-1).transmissionId, 'tx-8', 'a lost response can still have been delivered');

  const found = await fake.findSent({ rfcMessageId: '<tx-8@domain.com>' });
  assert.equal(found.found, true);
  assert.equal(found.messageId, fake.sent.at(-1).messageId);
  assert.equal(found.threadId, fake.sent.at(-1).threadId);
  assert.deepEqual(await fake.findSent({ rfcMessageId: '<tx-6@domain.com>' }), { found: false });
  assert.throws(() => fake.failNext('sometimes'), /unknown outcome/);

  const start = await fake.listThreadChanges({ checkpoint: null, threadIds: [first.threadId] });
  assert.equal(start.checkpointExpired, true, 'no checkpoint reads whole threads');
  assert.deepEqual(start.messages.map((m) => [m.headers.messageId, m.labelIds]),
    [['<tx-1@domain.com>', ['SENT']], ['<tx-2@domain.com>', ['SENT']]], 'our own sends appear in the thread');
  assert.equal(start.messages[0].headers.from, '"Matt Uckele" <owner@domain.com>');
  assert.deepEqual((await fake.listThreadChanges({ checkpoint: start.nextCheckpoint,
    threadIds: [first.threadId] })).messages, []);

  const reply = fake.injectReply(first.threadId, {
    headers: { from: 'Bob <bob@brokerage.com>', inReplyTo: '<tx-2@domain.com>' },
    bodyPrefix: 'Thanks, sending the NDA.',
  });
  fake.injectReply('thread-unrelated', { headers: { from: 'someone@else.com' } });
  assert.equal(reply.threadId, first.threadId);
  assert.ok(reply.id);
  assert.equal(reply.internalDate, at);
  assert.equal(reply.headers.from, 'Bob <bob@brokerage.com>');
  assert.equal(reply.headers.autoSubmitted, null);
  assert.equal(reply.headers.references, null);
  assert.match(reply.headers.messageId, /^<.+@.+>$/);

  const changes = await fake.listThreadChanges({ checkpoint: start.nextCheckpoint, threadIds: [first.threadId] });
  assert.equal(changes.checkpointExpired, false);
  assert.deepEqual(changes.messages.map((m) => m.id), [reply.id]);
  assert.equal(changes.messages[0].bodyPrefix, undefined, 'no body prefix unless asked');
  const withBody = await fake.listThreadChanges({ checkpoint: start.nextCheckpoint, threadIds: [first.threadId],
    withBodyPrefix: true });
  assert.equal(withBody.messages[0].bodyPrefix, 'Thanks, sending the NDA.');
  assert.deepEqual((await fake.listThreadChanges({ checkpoint: changes.nextCheckpoint,
    threadIds: [first.threadId] })).messages, [], 'the checkpoint moves past seen messages');

  fake.expireCheckpointNext();
  const expired = await fake.listThreadChanges({ checkpoint: changes.nextCheckpoint, threadIds: [first.threadId] });
  assert.equal(expired.checkpointExpired, true);
  assert.deepEqual(expired.messages.map((m) => m.id), [first.messageId, followUp.messageId, reply.id],
    'an expired checkpoint returns the whole thread');

  fake.setReadinessReasons(['gmail_token_invalid']);
  assert.deepEqual(await fake.readiness(), { ready: false, reasons: ['gmail_token_invalid'] });
});

test('fake provider can rewrite Message-IDs as Gmail may: findSent and readMessageId see the real header', async () => {
  const fake = createFakeCimProvider({ now: () => new Date(at) });
  fake.rewriteMessageIds();
  const sent = await fake.send(message('tx-9'));
  assert.equal(sent.rfcMessageId, '<tx-9@domain.com>', 'the result names the Message-ID we asked for');
  const actual = fake.sent[0].rfcMessageId;
  assert.match(actual, /^<gmail-rewritten-\d+@mail\.gmail\.com>$/);
  assert.equal(fake.sent[0].requestedRfcMessageId, '<tx-9@domain.com>');
  assert.equal(await fake.readMessageId({ messageId: sent.messageId }), actual);
  assert.deepEqual(await fake.findSent({ rfcMessageId: '<tx-9@domain.com>' }), { found: false });
  assert.equal((await fake.findSent({ rfcMessageId: actual })).messageId, sent.messageId);
  fake.failReadMessageIdNext();
  await assert.rejects(fake.readMessageId({ messageId: sent.messageId }), { code: 'gmail_message_read_failed' });
  await assert.rejects(fake.readMessageId({ messageId: 'unknown' }), { code: 'gmail_message_read_failed' });
});

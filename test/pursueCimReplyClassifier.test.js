// Task 9: classification of a Gmail thread message (spec 2026-11-03 §6, step 4). The order is
// fixed: ours, owner, bounce, auto-reply, stop, reply.
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyPursueCimReply } from '../server/services/pursueCimReplyClassifier.js';

const OWNER = 'owner@uckele.example.test';
const OURS = '<transmission-1@uckele.example.test>';

function message({ id = 'gmail-msg-1', headers = {}, bodyPrefix = 'Thanks, attached is the NDA.',
  labelIds = ['INBOX'] } = {}) {
  return { id, threadId: 'gmail-thread-1', historyId: '7', internalDate: '2030-10-28T16:00:00.000Z',
    labelIds,
    headers: { from: 'Jordan Lee <broker@example.test>', messageId: '<reply-1@example.test>',
      inReplyTo: OURS, references: OURS, autoSubmitted: null, xAutoreply: null,
      xAutorespond: null, precedence: null, contentType: 'text/plain; charset=UTF-8', ...headers },
    bodyPrefix };
}

const classify = (input, extra = {}) => classifyPursueCimReply({ message: input,
  connectedAddress: OWNER, knownMessageIds: [OURS], ...extra });

test('a message whose Message-ID is one of our transmissions is ours', () => {
  assert.equal(classify(message({ labelIds: ['SENT'],
    headers: { from: `Mathew <${OWNER}>`, messageId: OURS } })), 'ours');
  // Ours wins over every later rule, even with a stop word in our own footer.
  assert.equal(classify(message({ headers: { from: OWNER, messageId: OURS },
    bodyPrefix: 'If you would rather I not reach out, just reply "stop".' })), 'ours');
  // A Gmail id we stored for an accepted send is ours too, if Gmail rewrote the Message-ID.
  assert.equal(classify(message({ id: 'gmail-sent-9', headers: { from: OWNER,
    messageId: '<CAGmail-rewritten@mail.gmail.com>' } }), { knownProviderMessageIds: ['gmail-sent-9'] }),
  'ours');
});

test('a message from the connected address that is not a transmission is the owner', () => {
  assert.equal(classify(message({ headers: { from: 'Mathew Uckele <Owner@Uckele.Example.Test>',
    messageId: '<CAowner@mail.gmail.com>' } })), 'owner');
  assert.equal(classify(message({ labelIds: ['SENT'], headers: { from: OWNER,
    messageId: '<CAowner-2@mail.gmail.com>' }, bodyPrefix: 'stop' })), 'owner');
});

test('mailer-daemon or a delivery-status report is a bounce', () => {
  assert.equal(classify(message({ headers: {
    from: 'Mail Delivery Subsystem <MAILER-DAEMON@googlemail.com>' } })), 'bounce');
  assert.equal(classify(message({ headers: { from: 'postmaster@example.test',
    contentType: 'multipart/report; report-type="delivery-status"; boundary="b1"' } })), 'bounce');
  assert.equal(classify(message({ headers: { from: 'postmaster@example.test',
    contentType: 'Multipart/Report; Report-Type=Delivery-Status' } })), 'bounce');
  // A disposition (read receipt) report is not a bounce.
  assert.equal(classify(message({ headers: { from: 'postmaster@example.test',
    contentType: 'multipart/report; report-type=disposition-notification' } })), 'reply');
  // A bounce outranks auto-reply headers.
  assert.equal(classify(message({ headers: { from: 'mailer-daemon@example.test',
    autoSubmitted: 'auto-replied' } })), 'bounce');
});

test('each auto-reply header marks an auto-reply', () => {
  for (const headers of [
    { autoSubmitted: 'auto-replied' },
    { autoSubmitted: 'auto-generated' },
    { xAutoreply: 'yes' },
    { xAutorespond: 'Out of office' },
    { precedence: 'auto_reply' },
    { precedence: 'bulk' },
    { precedence: 'Junk' },
  ]) {
    assert.equal(classify(message({ headers, bodyPrefix: 'I am out. Please stop by later.' })),
      'auto-reply', JSON.stringify(headers));
  }
  for (const headers of [{ autoSubmitted: 'no' }, { autoSubmitted: ' No ' },
    { precedence: 'list' }, { autoSubmitted: '' }]) {
    assert.equal(classify(message({ headers })), 'reply', JSON.stringify(headers));
  }
});

test('stop words match whole words case-insensitively only within 4096 chars', () => {
  for (const body of ['STOP', 'Please stop.', 'please Unsubscribe me', 'Remove   me from this list',
    'remove\nme', 'Do not contact me again', 'DO NOT CONTACT', '"stop"', 'stop!']) {
    assert.equal(classify(message({ bodyPrefix: body })), 'stop', body);
  }
  for (const body of ['We stopped marketing it.', 'unstoppable', 'unsubscribed already?',
    'removes meat', 'do not contacts', 'Removing me', 'stops']) {
    assert.equal(classify(message({ bodyPrefix: body })), 'reply', body);
  }
  assert.equal(classify(message({ bodyPrefix: `${'x'.repeat(4091)} stop` })), 'stop');
  assert.equal(classify(message({ bodyPrefix: `${'x'.repeat(4092)} stop` })), 'reply');
  assert.equal(classify(message({ bodyPrefix: `${'x'.repeat(5000)} stop` })), 'reply');
  assert.equal(classify(message({ bodyPrefix: null })), 'reply');
});

test('"non-stop service" does not count as stop', () => {
  assert.equal(classify(message({ bodyPrefix: 'We offer non-stop service in the region.' })), 'reply');
  assert.equal(classify(message({ bodyPrefix: 'stop-gap pricing' })), 'reply');
  assert.equal(classify(message({ bodyPrefix: 'the bus_stop route' })), 'reply');
});

test('our quoted footer in a reply is not a stop request', () => {
  const quotedGmail = 'Sure, NDA attached.\n\nOn Mon, Oct 28, 2030 at 8:05 AM Mathew <owner@uckele.example.test> wrote:\n'
    + '> If you would rather I not reach out about future listings, just reply "stop".\n';
  assert.equal(classify(message({ bodyPrefix: quotedGmail })), 'reply');
  const quotedPrefix = 'Sure.\n> If you would rather I not reach out about future listings, just reply "stop".';
  assert.equal(classify(message({ bodyPrefix: quotedPrefix })), 'reply');
  const unquotedFooter = 'Sure.\n\nIf you would rather I not reach out about future listings, just reply "stop".';
  assert.equal(classify(message({ bodyPrefix: unquotedFooter })), 'reply');
  const outlook = 'Sure.\n\n-----Original Message-----\nFrom: Mathew\njust reply "stop"';
  assert.equal(classify(message({ bodyPrefix: outlook })), 'reply');
  // A stop above the quote still counts.
  assert.equal(classify(message({ bodyPrefix: `stop\n\n${quotedGmail}` })), 'stop');
});

test('a different sender address in the thread is reply', () => {
  // Review Focus 2: a broker colleague or assistant answers in the thread.
  assert.equal(classify(message({ headers: { from: 'Assistant <assistant@brokerage.test>',
    messageId: '<CAassistant@mail.gmail.com>' } })), 'reply');
  // No From header at all is still someone else's message in our thread.
  assert.equal(classify(message({ headers: { from: null, messageId: null } })), 'reply');
});

test('the precedence order is ours, owner, bounce, auto-reply, stop, reply', () => {
  const everything = { from: OWNER, messageId: OURS, autoSubmitted: 'auto-replied',
    contentType: 'multipart/report; report-type=delivery-status' };
  assert.equal(classify(message({ headers: everything, bodyPrefix: 'stop' })), 'ours');
  assert.equal(classify(message({ headers: { ...everything, messageId: '<x@y>' },
    bodyPrefix: 'stop' })), 'owner');
  assert.equal(classify(message({ headers: { ...everything, messageId: '<x@y>',
    from: 'b@example.test' }, bodyPrefix: 'stop' })), 'bounce');
  assert.equal(classify(message({ headers: { autoSubmitted: 'auto-replied' },
    bodyPrefix: 'stop' })), 'auto-reply');
  assert.equal(classify(message({ bodyPrefix: 'stop' })), 'stop');
  assert.equal(classify(message()), 'reply');
});

test('replies to a footer-less email that ends with the Gmail signature are still classified', () => {
  // Pursue emails now end with "Best," and the owner's Gmail signature: no stop line, no address.
  const ours = 'Hi Jordan,\n\nBumping this up. Still interested in Acme Plumbing, and happy to sign the NDA today.'
    + '\n\nBest,\nPat Example\nPresident\nExample Holdings LLC\n(555) 010-0000\npat@example.com';
  const quoted = `\n\nOn Wed, Oct 30, 2030 at 8:00 AM Pat Example <owner@uckele.example.test> wrote:\n${
    ours.split('\n').map((line) => `> ${line}`).join('\n')}\n`;
  assert.equal(classify(message({ bodyPrefix: `Please stop.${quoted}` })), 'stop');
  assert.equal(classify(message({ bodyPrefix: `Remove me from your list, thanks${quoted}` })), 'stop');
  assert.equal(classify(message({ bodyPrefix: `STOP${quoted}` })), 'stop');
  assert.equal(classify(message({ bodyPrefix: `Sure, NDA attached.${quoted}` })), 'reply');
  assert.equal(classify(message({ bodyPrefix: 'Sure, NDA attached.' })), 'reply');
});

test('our Gmail signature inlined in a reply is not a stop request; the broker\'s own stop still is', () => {
  const signatureText = 'Pat Example\nPresident\nTo unsubscribe from my updates, reply UNSUBSCRIBE\nDo not contact after hours';
  // An inlined original with no quote markers, no "On ... wrote:" and no From: line.
  const inlined = 'Sounds good, NDA attached.\n\nHi Jordan,\nBumping this up.\n\nBest,\nPat Example\nPresident\n'
    + 'To unsubscribe from my updates,   reply UNSUBSCRIBE\ndo not contact after hours';
  assert.equal(classify(message({ bodyPrefix: inlined })), 'stop', 'without the signature text it looks like a stop');
  assert.equal(classify(message({ bodyPrefix: inlined }), { signatureText }), 'reply');
  assert.equal(classify(message({ bodyPrefix: `Please stop.\n${inlined}` }), { signatureText }), 'stop');
  assert.equal(classify(message({ bodyPrefix: 'STOP' }), { signatureText }), 'stop');
  // The old footer is still removed too.
  assert.equal(classify(message({ bodyPrefix: 'Sure.\n\nIf you would rather I not reach out about future listings, just reply "stop".' }),
    { signatureText }), 'reply');
});

test('our signature is removed only as a whole block, never a single line the broker wrote', () => {
  const signatureText = 'Pat Example\nPresident, Example Holdings LLC\n\nReply STOP to opt out';
  // The broker writes, as their own reply, a line identical to one signature line.
  assert.equal(classify(message({ bodyPrefix: 'Reply STOP to opt out' }), { signatureText }), 'stop');
  assert.equal(classify(message({ bodyPrefix: 'Thanks.\nreply   stop to OPT out\nPresident, Example Holdings LLC' }),
    { signatureText }), 'stop');
  // The full signature block, inlined (blank lines and spacing differ), is removed.
  const inlined = 'Sounds good, NDA attached.\n\nBest,\nPat Example\n  President,  Example Holdings LLC\n\n\nreply stop to opt out\n';
  assert.equal(classify(message({ bodyPrefix: inlined }), { signatureText }), 'reply');
  // A stop line of the broker's own next to the full block still counts.
  assert.equal(classify(message({ bodyPrefix: `Please stop.\n${inlined}` }), { signatureText }), 'stop');
  // A one-line signature is never removed.
  assert.equal(classify(message({ bodyPrefix: 'Unsubscribe' }), { signatureText: 'Unsubscribe' }), 'stop');
});

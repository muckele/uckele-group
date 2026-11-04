// Task 8: the scheduled Pursue sender. Real SQLite under a controlled clock; only the Gmail
// mailbox is the fake provider. Times are 2030 America/Los_Angeles (see the fixture).
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPursueFollowUpPayload, loadPursueFollowUpAuthority } from '../server/services/pursueCimFollowUpHooks.js';
import { runCimFollowUpPreparation } from '../server/services/pursueCimFollowUpPreparation.js';
import { runDueCimInitialPreparations } from '../server/services/pursueCimInitialPreparation.js';
import { reevaluateWaitingPursuitEnrollments, sweepExpiredPursueCampaigns } from '../server/services/pursueCimSender.js';
import { startPursueCimSenderScheduler } from '../server/services/pursueCimSenderScheduler.js';
import { syncPursueGmailCapabilities } from '../server/services/pursueGmailCapabilities.js';
import { orchestratePursuitEnrollment } from '../server/services/pursueCimEnrollment.js';
import { runDealHunterSheetSync } from '../server/services/dealHunterSheetSync.js';
import { MINUTE, createSenderFixture } from './fixtures/pursueCimSenderFixture.js';
import { setSendControl } from './fixtures/pursueCimGmailGateFixture.js';
import { seedP4bEligibleFixture } from './fixtures/pursueCimEnrollmentFixture.js';

// Monday 2030-10-28 08:00 PDT, and the instants around it.
const MONDAY_0800 = '2030-10-28T15:00:00.000Z';
const MONDAY_0805 = '2030-10-28T15:05:00.000Z';
const INITIAL_SUBJECT = 'CIM / NDA request for Acme Plumbing';
const at = (iso, ms = 0) => new Date(Date.parse(iso) + ms).toISOString();
const due = (suffix, dueAt = MONDAY_0800, dueLocal = '2030-10-28T08:00:00') =>
  ({ suffix, dueAt, dueLocal });
const fill = (character) => character.repeat(64);

function scheduledFollowUp(fixture, suffix) {
  return fixture.touches(fixture.campaigns[suffix].campaignId)
    .find((touch) => touch.kind !== 'initial' && touch.state === 'scheduled');
}

/** Stores whose named method throws once, as if the process died at that call. */
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

async function sendInitial(fixture, { at: when = MONDAY_0805 } = {}) {
  fixture.clock.set(when);
  const summary = await fixture.run();
  assert.equal(summary.sentInitial, 1, JSON.stringify(summary));
  return summary;
}

test('not ready sends nothing and reports not_ready', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  fixture.mailProvider.setReadinessReasons(['gmail_token_invalid']);
  const summary = await fixture.run();
  assert.equal(summary.stoppedFor, 'not_ready');
  assert.deepEqual(summary.notReadyReasons, ['gmail_token_invalid']);
  assert.equal(summary.sentInitial, 0);
  assert.equal(fixture.mailProvider.attempts.length, 0);
  const touch = fixture.row('deal_hunter_cim_campaign_touches', fixture.campaigns.a.touchId);
  assert.equal(touch.state, 'scheduled');
  assert.equal(touch.row_version, 1);
  assert.equal(fixture.count('deal_hunter_cim_transmissions'), 0);
  assert.equal(fixture.count('deal_hunter_cim_live_provider_authorizations'), 0);
  assert.equal(fixture.row('deal_hunter_cim_campaigns', fixture.campaigns.a.campaignId).state,
    'initial-pending');
});

test('live sending off sends nothing', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  await setSendControl(fixture.storage, 'live_sending', false);
  const summary = await fixture.run();
  assert.equal(summary.stoppedFor, 'not_ready');
  assert.deepEqual(summary.notReadyReasons, ['live_sending_off']);
  assert.equal(fixture.mailProvider.attempts.length, 0);
  assert.equal(fixture.count('deal_hunter_cim_live_provider_authorizations'), 0);
  assert.equal(fixture.row('deal_hunter_cim_campaign_touches', fixture.campaigns.a.touchId).state,
    'scheduled');
});

test('live sending turned off mid-run is read before the next send', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [due('a'), due('b')] });
  const send = fixture.mailProvider.send.bind(fixture.mailProvider);
  fixture.mailProvider.send = async (input) => {
    const result = await send(input);
    await setSendControl(fixture.storage, 'live_sending', false);
    return result;
  };
  const summary = await fixture.run();
  assert.equal(summary.sentInitial, 1, JSON.stringify(summary));
  assert.equal(summary.stoppedFor, 'not_ready');
  assert.equal(summary.skipped.live_sending_off, 1);
  assert.equal(fixture.mailProvider.attempts.length, 1);
  assert.equal(fixture.count('deal_hunter_cim_live_provider_authorizations'), 1);
  const second = fixture.row('deal_hunter_cim_campaign_touches', fixture.campaigns.b.touchId);
  assert.equal(second.state, 'scheduled');
  assert.equal(second.row_version, 1);
});

test('initial outside 08:00-17:00 local or on a weekend waits; inside is sent and follow-up-1 is scheduled +2 business days at 08:00 local', async (t) => {
  // Due on Saturday 2030-10-26 10:00 PDT.
  const fixture = await createSenderFixture(t, { start: '2030-10-26T17:30:00.000Z',
    campaigns: [due('a', '2030-10-26T17:00:00.000Z', '2030-10-26T10:00:00')] });
  const { touchId, campaignId, conversationId } = fixture.campaigns.a;
  const weekend = await fixture.run();
  assert.equal(weekend.sentInitial, 0);
  assert.equal(weekend.skipped.outside_send_window, 1, JSON.stringify(weekend));
  // Monday 07:45 PDT: still before the window.
  fixture.clock.set('2030-10-28T14:45:00.000Z');
  const early = await fixture.run();
  assert.equal(early.skipped.outside_send_window, 1, JSON.stringify(early));
  // Friday-style evening: Monday 17:10 PDT would also wait (checked after the send below).
  assert.equal(fixture.row('deal_hunter_cim_campaign_touches', touchId).row_version, 1);
  assert.equal(fixture.mailProvider.attempts.length, 0);

  await sendInitial(fixture);
  assert.equal(fixture.mailProvider.sent.length, 1);
  assert.equal(fixture.mailProvider.sent[0].subject, INITIAL_SUBJECT);
  assert.equal(fixture.row('deal_hunter_cim_campaign_touches', touchId).state, 'accepted');
  const campaign = fixture.row('deal_hunter_cim_campaigns', campaignId);
  assert.equal(campaign.state, 'active-follow-up');
  assert.equal(fixture.row('deal_hunter_broker_conversations', conversationId).gmail_thread_id,
    fixture.mailProvider.sent[0].threadId);
  const followUp = scheduledFollowUp(fixture, 'a');
  assert.equal(followUp.kind, 'follow-up-1');
  // Monday + 2 business days = Wednesday 08:00 PDT.
  assert.equal(followUp.due_at, '2030-10-30T15:00:00.000Z');
  assert.equal(followUp.due_local, '2030-10-30T08:00:00');
  const authorization = fixture.database.prepare(`SELECT * FROM
    deal_hunter_cim_live_provider_authorizations`).get();
  assert.equal(authorization.actor, 'pursue-cim-sender');
  assert.equal(authorization.provider_profile, 'production-gmail-v1');
  assert.ok(authorization.consumed_at);
});

test('follow-ups run every 2 business days and the last before day 28 uses Final', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  await sendInitial(fixture);
  const initial = fixture.mailProvider.sent[0];
  const dueLocals = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const touch = scheduledFollowUp(fixture, 'a');
    if (!touch) break;
    dueLocals.push(touch.due_local);
    fixture.clock.set(at(touch.due_at, 30_000));
    const summary = await fixture.run();
    assert.equal(summary.sentFollowUps, 1, `${touch.kind} ${JSON.stringify(summary)}`);
  }
  assert.deepEqual(dueLocals, ['2030-10-30', '2030-11-01', '2030-11-05', '2030-11-07',
    '2030-11-11', '2030-11-13', '2030-11-15', '2030-11-19', '2030-11-21', '2030-11-25']
    .map((date) => `${date}T08:00:00`));
  const followUps = fixture.mailProvider.sent.slice(1);
  assert.equal(followUps.length, 10);
  const expected = ['I wanted to follow up', 'Checking in on', 'Following up on', 'Circling back on'];
  followUps.forEach((message, index) => {
    assert.equal(message.subject, `Re: ${INITIAL_SUBJECT}`);
    assert.equal(message.threadId, initial.threadId);
    assert.equal(message.inReplyTo, initial.rfcMessageId);
    const final = index === followUps.length - 1;
    assert.equal(message.text.includes('This is my last note on Acme Plumbing'), final, `#${index + 1}`);
    if (!final) assert.ok(message.text.includes(expected[index % 4]), `#${index + 1}`);
  });
  // Nothing is scheduled after Final; the day-28 sweep then expires the campaign.
  const { campaignId } = fixture.campaigns.a;
  const campaign = fixture.row('deal_hunter_cim_campaigns', campaignId);
  assert.equal(campaign.state, 'active-follow-up');
  fixture.clock.set(at(campaign.local_expiry_at, MINUTE));
  const last = await fixture.run();
  assert.equal(last.expired, 1);
  assert.equal(fixture.row('deal_hunter_cim_campaigns', campaignId).state, 'expired');
});

test('DST: a follow-up straddling the November fallback is sent at 08:00 local wall time', async (t) => {
  // Thursday 2030-10-31 08:00 PDT; DST ends Sunday 2030-11-03.
  const fixture = await createSenderFixture(t, { start: '2030-10-31T15:05:00.000Z',
    campaigns: [due('a', '2030-10-31T15:00:00.000Z', '2030-10-31T08:00:00')] });
  await sendInitial(fixture, { at: '2030-10-31T15:05:00.000Z' });
  const touch = scheduledFollowUp(fixture, 'a');
  // Monday 08:00 PST is 16:00Z, an hour later in UTC than the PDT 08:00 before the change.
  assert.equal(touch.due_at, '2030-11-04T16:00:00.000Z');
  assert.equal(touch.due_local, '2030-11-04T08:00:00');
  fixture.clock.set('2030-11-04T15:30:00.000Z'); // 07:30 PST (08:30 had DST continued)
  assert.equal((await fixture.run()).sentFollowUps, 0);
  assert.equal(fixture.mailProvider.attempts.length, 1);
  fixture.clock.set('2030-11-04T16:00:30.000Z'); // 08:00:30 PST
  assert.equal((await fixture.run()).sentFollowUps, 1);
  const sentAt = fixture.mailProvider.sent[1].sentAt;
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(sentAt)), '08:00');
});

test('a follow-up missed by more than a day goes out the next weekday morning once', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  await sendInitial(fixture);
  // Due Wednesday 08:00 PDT; the sender is down all Wednesday.
  fixture.clock.set('2030-10-31T01:00:00.000Z'); // Wednesday 18:00 PDT
  assert.equal((await fixture.run()).skipped.outside_send_window, 1);
  fixture.clock.set('2030-10-31T14:30:00.000Z'); // Thursday 07:30 PDT
  assert.equal((await fixture.run()).skipped.outside_send_window, 1);
  fixture.clock.set('2030-10-31T15:00:30.000Z'); // Thursday 08:00:30 PDT
  assert.equal((await fixture.run()).sentFollowUps, 1);
  fixture.clock.set('2030-10-31T15:20:00.000Z');
  assert.equal((await fixture.run()).sentFollowUps, 0);
  assert.equal(fixture.mailProvider.sent.length, 2);
  // The next follow-up counts from Thursday's acceptance: Monday 08:00 PST.
  assert.equal(scheduledFollowUp(fixture, 'a').due_local, '2030-11-04T08:00:00');
});

test('a follow-up picked up the day after it was due is held until a weekday 08:00 window, then sent once', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  await sendInitial(fixture);
  // Due Wednesday 2030-10-30 08:00 PDT. On its own day it may go out any time in the window.
  fixture.clock.set('2030-10-30T21:00:00.000Z'); // Wednesday 14:00 PDT
  const sameDay = await fixture.run();
  assert.equal(sameDay.sentFollowUps, 1, JSON.stringify(sameDay));
  // The next one is due Friday 08:00; picked up Monday 14:00 (after the weekend) it is held.
  const next = scheduledFollowUp(fixture, 'a');
  assert.equal(next.due_local, '2030-11-01T08:00:00');
  fixture.clock.set('2030-11-04T22:00:00.000Z'); // Monday 14:00 PST
  const held = await fixture.run();
  assert.equal(held.sentFollowUps, 0);
  assert.equal(held.skipped.outside_send_window, 1, JSON.stringify(held));
  fixture.clock.set('2030-11-04T17:10:00.000Z'); // Monday 09:10 PST: past the 08:00 window
  assert.equal((await fixture.run()).sentFollowUps, 0);
  fixture.clock.set('2030-11-05T16:00:30.000Z'); // Tuesday 08:00:30 PST
  assert.equal((await fixture.run()).sentFollowUps, 1);
  fixture.clock.set('2030-11-05T16:20:00.000Z');
  assert.equal((await fixture.run()).sentFollowUps, 0);
  assert.equal(fixture.mailProvider.sent.length, 3);
  assert.equal(fixture.row('deal_hunter_cim_campaign_touches', next.id).state, 'accepted');
});

test('day-28 expiry sweep expires and cancels scheduled touches', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  await sendInitial(fixture);
  const { campaignId } = fixture.campaigns.a;
  const followUp = scheduledFollowUp(fixture, 'a');
  const expiry = fixture.row('deal_hunter_cim_campaigns', campaignId).local_expiry_at;
  // The expiry is day 28 local: Monday 2030-11-25 at the initial's local time (PST).
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })
    .format(new Date(expiry)), '2030-11-25');
  fixture.clock.set(at(expiry, -MINUTE));
  assert.equal(await sweepExpiredPursueCampaigns({ storage: fixture.storage,
    now: fixture.clock.peek() }), 0);
  fixture.clock.set(at(expiry, MINUTE));
  const [listed] = await fixture.storage.listExpiredCimCampaigns({
    now: fixture.clock.peek().toISOString() });
  assert.deepEqual(Object.keys(listed).sort(), ['conversation_id', 'id', 'local_expiry_at',
    'opportunity_id', 'row_version', 'state', 'terminal_revision']);
  const summary = await fixture.run();
  assert.equal(summary.expired, 1);
  assert.equal(summary.sentFollowUps, 0);
  assert.equal(fixture.row('deal_hunter_cim_campaigns', campaignId).state, 'expired');
  assert.equal(fixture.row('deal_hunter_cim_campaigns', campaignId).reason_code, 'campaign_expired');
  const cancelled = fixture.row('deal_hunter_cim_campaign_touches', followUp.id);
  assert.equal(cancelled.state, 'cancelled-before-provider');
  assert.equal(cancelled.terminal_reason, 'campaign_expired');
  assert.equal(fixture.count('deal_hunter_cim_terminal_events',
    "scope = 'campaign' AND reason_code = 'campaign_expired'"), 1);
  assert.equal(fixture.mailProvider.attempts.length, 1);
  // A replayed sweep changes nothing.
  assert.equal(await sweepExpiredPursueCampaigns({ storage: fixture.storage,
    now: fixture.clock.peek() }), 0);
});

test('quota stops the run, leaves the touch scheduled, skips the rest of the local day, resumes next business day', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [due('a'), due('b')] });
  fixture.mailProvider.quotaNext();
  const first = await fixture.run();
  assert.equal(first.stoppedFor, 'provider_quota', JSON.stringify(first));
  assert.equal(first.sentInitial, 0);
  assert.equal(fixture.mailProvider.attempts.length, 1);
  const a = fixture.row('deal_hunter_cim_campaign_touches', fixture.campaigns.a.touchId);
  assert.equal(a.state, 'scheduled');
  assert.equal(a.transmission_id, null);
  const b = fixture.row('deal_hunter_cim_campaign_touches', fixture.campaigns.b.touchId);
  assert.equal(b.state, 'scheduled');
  assert.equal(b.row_version, 1);
  assert.equal(fixture.row('deal_hunter_cim_campaigns', fixture.campaigns.a.campaignId).state,
    'initial-pending');
  const marker = await fixture.storage.getScheduledJob('pursue-cim-sender:provider-quota:2030-10-28');
  assert.equal(marker?.status, 'completed');

  fixture.clock.set('2030-10-28T23:30:00.000Z'); // Monday 16:30 PDT
  const later = await fixture.run();
  assert.equal(later.skipped.provider_quota_wait, 1, JSON.stringify(later));
  assert.equal(later.sentInitial, 0);
  assert.equal(fixture.mailProvider.attempts.length, 1);

  fixture.clock.set('2030-10-29T15:01:00.000Z'); // Tuesday 08:01 PDT
  const resumed = await fixture.run();
  assert.equal(resumed.sentInitial, 2, JSON.stringify(resumed));
  assert.deepEqual(fixture.database.prepare(`SELECT preparation_generation AS g, state
    FROM deal_hunter_cim_transmissions WHERE id IN (SELECT transmission_id
      FROM deal_hunter_cim_transmission_touches WHERE touch_id = ?) ORDER BY g`)
    .all(fixture.campaigns.a.touchId), [{ g: 1, state: 'cancelled-before-provider' },
    { g: 2, state: 'accepted' }]);
});

test('definitive failure moves the campaign to action-required', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [due('a'), due('b')] });
  fixture.mailProvider.failNext('definitive-failure');
  const summary = await fixture.run();
  assert.equal(summary.failed, 1);
  assert.equal(summary.sentInitial, 1);
  assert.equal(summary.stoppedFor, undefined);
  assert.equal(fixture.row('deal_hunter_cim_campaigns', fixture.campaigns.a.campaignId).state,
    'action-required');
  assert.equal(fixture.row('deal_hunter_cim_campaigns', fixture.campaigns.b.campaignId).state,
    'active-follow-up');
  fixture.clock.set('2030-10-29T15:01:00.000Z');
  await fixture.run();
  assert.equal(fixture.mailProvider.attempts.length, 2);
});

test('ambiguous + findSent found reconciles accepted with no resend; not found moves to provider-ambiguous with no resend', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [due('a'), due('b')] });
  fixture.mailProvider.failNext('ambiguous', { delivered: true });
  fixture.mailProvider.failNext('ambiguous');
  const summary = await fixture.run();
  assert.equal(summary.sentInitial, 1, JSON.stringify(summary));
  assert.equal(summary.ambiguous, 1);
  assert.equal(fixture.mailProvider.sent.length, 1);
  assert.equal(fixture.mailProvider.attempts.length, 2);
  assert.equal(fixture.row('deal_hunter_cim_campaigns', fixture.campaigns.a.campaignId).state,
    'active-follow-up');
  assert.equal(fixture.row('deal_hunter_cim_campaigns', fixture.campaigns.b.campaignId).state,
    'provider-ambiguous');
  // Later runs send a's follow-up and never touch b again.
  fixture.clock.set('2030-10-30T15:00:30.000Z');
  const later = await fixture.run();
  assert.equal(later.sentFollowUps, 1);
  assert.equal(fixture.mailProvider.attempts.length, 3);
  assert.equal(fixture.mailProvider.attempts.filter((attempt) => attempt.transmissionId
    === fixture.row('deal_hunter_cim_campaign_touches', fixture.campaigns.b.touchId)
      .transmission_id).length, 1);
});

test('seam entered then crash: next run reconciles via findSent and does not send again', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [due('a'), due('b')] });
  // a reaches Gmail; b times out and Gmail never delivers it. The process dies before either
  // outcome is recorded.
  const storage = crashingOnce(crashingOnce(fixture.storage, 'finalizeCimTransmission'),
    'finalizeCimTransmission');
  const send = fixture.mailProvider.send.bind(fixture.mailProvider);
  let calls = 0;
  fixture.mailProvider.send = async (input) => {
    calls += 1;
    if (calls === 2) fixture.mailProvider.failNext('ambiguous');
    return send(input);
  };
  const crashed = await fixture.run({ storage });
  assert.equal(crashed.sentInitial, 0, JSON.stringify(crashed));
  assert.equal(fixture.mailProvider.attempts.length, 2);
  for (const suffix of ['a', 'b']) {
    const touch = fixture.row('deal_hunter_cim_campaign_touches', fixture.campaigns[suffix].touchId);
    const transmission = fixture.row('deal_hunter_cim_transmissions', touch.transmission_id);
    assert.equal(transmission.state, 'provider-pending', suffix);
    assert.ok(transmission.provider_seam_entered_at, suffix);
  }
  // Too soon: a send may still be in flight, so nothing is reconciled yet.
  fixture.clock.set(at(MONDAY_0805, 2 * MINUTE));
  assert.equal((await fixture.run()).reconciled ?? 0, 0);
  fixture.clock.set(at(MONDAY_0805, 15 * MINUTE));
  const next = await fixture.run();
  assert.equal(next.reconciled, 1, JSON.stringify(next));
  assert.equal(next.ambiguous, 1);
  assert.equal(fixture.mailProvider.attempts.length, 2);
  const deliveredTo = fixture.mailProvider.sent.map((message) => message.transmissionId);
  const touchA = fixture.row('deal_hunter_cim_campaign_touches', fixture.campaigns.a.touchId);
  const touchB = fixture.row('deal_hunter_cim_campaign_touches', fixture.campaigns.b.touchId);
  const [accepted, ambiguous] = deliveredTo.includes(touchA.transmission_id)
    ? [touchA, touchB] : [touchB, touchA];
  assert.equal(fixture.row('deal_hunter_cim_transmissions', accepted.transmission_id).state, 'accepted');
  assert.equal(fixture.row('deal_hunter_cim_transmissions', ambiguous.transmission_id).state, 'ambiguous');
  assert.equal(fixture.row('deal_hunter_cim_campaigns', accepted.campaign_id).state, 'active-follow-up');
  assert.equal(fixture.row('deal_hunter_cim_campaigns', ambiguous.campaign_id).state, 'provider-ambiguous');
  assert.equal(fixture.row('deal_hunter_broker_conversations',
    fixture.row('deal_hunter_cim_campaigns', accepted.campaign_id).conversation_id).gmail_thread_id,
  fixture.mailProvider.sent[0].threadId);
  // Nothing is ever sent for either transmission again.
  fixture.clock.set('2030-10-29T15:01:00.000Z');
  const after = await fixture.run();
  assert.equal(after.sentInitial, 0);
  assert.equal(fixture.mailProvider.attempts.length, 2);
});

test('a lapsed claim with no transmission is listed again and sent once', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  await sendInitial(fixture);
  const touch = scheduledFollowUp(fixture, 'a');
  fixture.clock.set(at(touch.due_at, 30_000));
  const claimAt = fixture.clock.peek().toISOString();
  const campaign = fixture.row('deal_hunter_cim_campaigns', touch.campaign_id);
  const claim = await fixture.storage.claimDueCimTouch({ touchId: touch.id,
    expectedRowVersion: touch.row_version,
    expectedCampaignTerminalRevision: campaign.terminal_revision,
    expectedConversationTerminalRevision: fixture.row('deal_hunter_broker_conversations',
      campaign.conversation_id).terminal_revision, claimTokenDigest: fill('7'),
    claimOwner: 'crashed-worker', claimExpiresAt: at(claimAt, 5 * MINUTE), now: claimAt });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  // While the claim is live the touch belongs to its worker.
  assert.equal((await fixture.run()).sentFollowUps, 0);
  fixture.clock.set(at(claimAt, 6 * MINUTE));
  const summary = await fixture.run();
  assert.equal(summary.sentFollowUps, 1, JSON.stringify(summary));
  assert.equal(fixture.mailProvider.sent.length, 2);
});

test('a lapsed initial claim with a prepared transmission is renewed and that transmission is sent once', async (t) => {
  const fixture = await createSenderFixture(t, { start: '2030-10-28T15:01:00.000Z',
    campaigns: [due('a')] });
  const [prepared] = await runDueCimInitialPreparations({ storage: fixture.storage,
    clock: fixture.clock, loadAuthority: fixture.loadInitialAuthority,
    configOverride: fixture.config });
  assert.equal(prepared.prepared, true, JSON.stringify(prepared));
  // Before the lease lapses nothing else may touch it.
  fixture.clock.set('2030-10-28T15:03:00.000Z');
  assert.equal((await fixture.run()).sentInitial, 0);
  fixture.clock.set('2030-10-28T15:08:00.000Z');
  const [lapsed] = await fixture.storage.listLapsedCimPreparedTouches({
    now: fixture.clock.peek().toISOString() });
  // The same row shape as the PostgreSQL adapter.
  assert.deepEqual(Object.keys(lapsed).sort(), ['campaign_id', 'campaign_state',
    'claim_expires_at', 'conversation_id', 'due_local', 'kind', 'opportunity_id',
    'preparation_generation',
    'recipient_fingerprint', 'row_version', 'touch_id', 'transmission_id']);
  assert.equal(lapsed.transmission_id, prepared.transmissionId);
  const summary = await fixture.run();
  assert.equal(summary.sentInitial, 1, JSON.stringify(summary));
  assert.equal(fixture.count('deal_hunter_cim_transmissions'), 1);
  assert.equal(fixture.count('deal_hunter_cim_audit_events', "event_type = 'touch-claim-renewed'"), 1);
  assert.equal(fixture.mailProvider.sent[0].transmissionId, prepared.transmissionId);
  assert.equal(fixture.row('deal_hunter_cim_transmissions', prepared.transmissionId).state, 'accepted');
});

test('a lapsed follow-up with a prepared transmission is renewed through its reservation and sent once', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  await sendInitial(fixture);
  const touch = scheduledFollowUp(fixture, 'a');
  fixture.clock.set(at(touch.due_at, 30_000));
  const [candidate] = await fixture.storage.listDueCimFollowUpTouches({
    now: fixture.clock.peek().toISOString() });
  const prepared = await runCimFollowUpPreparation({ storage: fixture.storage, candidate,
    clock: fixture.clock, actor: 'crashed-worker', claimTokenDigest: fill('8'),
    loadAuthority: (input) => loadPursueFollowUpAuthority({ ...input, config: fixture.config,
      loadMemberAuthority: fixture.loadMemberAuthority }),
    buildPayload: (input) => buildPursueFollowUpPayload({ ...input, config: fixture.config }) });
  assert.equal(prepared.prepared, true, JSON.stringify(prepared.blockedReason));
  fixture.clock.advance(6 * MINUTE);
  const summary = await fixture.run();
  assert.equal(summary.sentFollowUps, 1, JSON.stringify(summary));
  assert.equal(fixture.mailProvider.sent[1].transmissionId, prepared.transmission.id);
  assert.equal(fixture.count('deal_hunter_cim_transmission_touches', 'touch_id = ?', touch.id), 1);
  assert.deepEqual(fixture.database.prepare(`SELECT state FROM
    deal_hunter_cim_capacity_reservations WHERE transmission_id = ? ORDER BY reserved_at`)
    .all(prepared.transmission.id).map(({ state }) => state), ['expired', 'consumed']);
});

test('a gate refusal after the authorization is issued recovers once its claim and authorization lapse', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  fixture.database.prepare('UPDATE deal_hunter_cim_safety_settings SET outreach_paused = 1').run();
  const paused = await fixture.run();
  assert.equal(paused.stoppedFor, 'not_ready');
  assert.equal(paused.skipped.central_pause, 1, JSON.stringify(paused));
  assert.equal(fixture.mailProvider.attempts.length, 0);
  fixture.database.prepare('UPDATE deal_hunter_cim_safety_settings SET outreach_paused = 0').run();
  fixture.clock.set(at(MONDAY_0805, 15 * MINUTE));
  const resumed = await fixture.run();
  assert.equal(resumed.sentInitial, 1, JSON.stringify(resumed));
  assert.equal(fixture.count('deal_hunter_cim_transmissions'), 1);
  const authorizations = fixture.database.prepare(`SELECT consumed_at, withdrawn_at
    FROM deal_hunter_cim_live_provider_authorizations ORDER BY issued_at`).all();
  assert.equal(authorizations.length, 2);
  assert.ok(authorizations[0].withdrawn_at && !authorizations[0].consumed_at);
  assert.ok(authorizations[1].consumed_at && !authorizations[1].withdrawn_at);
  assert.equal(fixture.count('deal_hunter_cim_audit_events', "event_type = 'authorization-expired'"), 1);
});

test('a coded error preparing one follow-up is recorded and the run continues', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [due('a'), due('b')] });
  fixture.clock.set(MONDAY_0805);
  assert.equal((await fixture.run()).sentInitial, 2);
  const failing = scheduledFollowUp(fixture, 'a');
  fixture.clock.set(at(failing.due_at, 30_000));
  const summary = await fixture.run({ buildFollowUpPayload: async (input) => {
    if (input.candidate.touch_id === failing.id) throw new Error('pursue_follow_up_initial_unavailable');
    return buildPursueFollowUpPayload(input);
  } });
  assert.equal(summary.sentFollowUps, 1, JSON.stringify(summary));
  assert.equal(summary.skipped.pursue_follow_up_initial_unavailable, 1);
  assert.equal(fixture.row('deal_hunter_cim_campaign_touches', failing.id).state, 'claimed');
  // The lapsed claim is recovered by a later run.
  fixture.clock.advance(6 * MINUTE);
  assert.equal((await fixture.run()).sentFollowUps, 1);
  assert.equal(fixture.mailProvider.sent.length, 4);
});

test('waiting enrollment becomes enrolled after the rule is turned on and a sync completes', async (t) => {
  const fixture = await seedP4bEligibleFixture(t, { brokerEmail: 'jordan.lee@brokerfirm.test',
    enrollmentActivation: false });
  const { storage, db, now, opportunityId, decision } = fixture;
  const healthy = async () => ({ healthy: true, issues: [] });
  const waiting = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner', now,
    readSourceHealth: healthy });
  assert.equal(waiting.enrollment.state, 'waiting-on-eligibility');
  assert.equal(waiting.enrollment.reason_code, 'contact_permission_missing');
  // Rule still off: re-evaluation leaves it waiting.
  assert.deepEqual(await reevaluateWaitingPursuitEnrollments({ storage, now,
    readSourceHealth: healthy }), { enrolled: 0, stillWaiting: 1, actionRequired: 0 });
  const { contactRule } = await storage.getPursueSendControls();
  await storage.setPursueSendControl({ controlKey: 'contact_rule', enabled: true,
    policyVersion: 'listing-broker-inquiry-v1', expectedRevision: contactRule.revision,
    actor: 'fixture-owner', reason: 'synthetic', now });
  const sync = await runDealHunterSheetSync({ storage, now: new Date(now),
    refresh: async () => ({ ok: true, review: { sources: [{ sourceId: 'sheet-0',
      required: true, sourceRole: 'required-primary', rowCount: 1 }] },
    currentFingerprints: {} }),
    autoPursue: async () => ({ status: 'completed', commands: 0 }),
    reevaluate: (input) => reevaluateWaitingPursuitEnrollments({ ...input,
      readSourceHealth: healthy }) });
  assert.equal(sync.ok, true);
  assert.deepEqual(sync.waitingEnrollments, { enrolled: 1, stillWaiting: 0, actionRequired: 0 });
  const enrollment = db.prepare('SELECT * FROM deal_hunter_pursuit_enrollments').get();
  assert.equal(enrollment.state, 'campaign-created');
  assert.equal(db.prepare('SELECT permission_version FROM deal_hunter_cim_campaigns').get()
    .permission_version, 'listing-broker-inquiry-v1');
});

test('a sync that fails does not re-evaluate waiting enrollments', async () => {
  let called = 0;
  const sync = await runDealHunterSheetSync({ storage: {}, now: new Date(MONDAY_0800),
    refresh: async () => ({ ok: false, review: { sources: [] } }),
    autoPursue: async () => ({}),
    reevaluate: async () => { called += 1; return { enrolled: 0, stillWaiting: 0 }; } });
  assert.equal(sync.ok, false);
  assert.equal(called, 0);
});

test('the scheduler runs the sender on a live clock: each gate attempt has its own instant', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [due('a'), due('b')] });
  const scheduler = startPursueCimSenderScheduler({ storage: fixture.storage,
    config: { dealHunter: { pursueSender: { enabled: true, intervalMinutes: 15 } } },
    now: fixture.clock, setTimer: () => ({ unref() {} }), clearTimer: () => {},
    logger: { log() {}, error() {} },
    // The run gets only what the scheduler passes: no clock means a frozen tick instant.
    run: ({ storage, now, clock }) => fixture.run({ storage, now, clock }) });
  t.after(() => scheduler.stop());
  await scheduler.tick();
  assert.equal(fixture.mailProvider.sent.length, 2);
  const times = (sql) => fixture.database.prepare(sql).all().map((row) => row.at);
  const issued = times(`SELECT issued_at AS at FROM deal_hunter_cim_live_provider_authorizations`);
  const seams = times(`SELECT provider_seam_entered_at AS at FROM deal_hunter_cim_transmissions`);
  const gates = times(`SELECT occurred_at AS at FROM deal_hunter_cim_audit_events
    WHERE event_type = 'provider-pending'`);
  for (const values of [issued, seams]) {
    assert.equal(values.length, 2);
    assert.equal(new Set(values).size, 2, JSON.stringify(values));
  }
  assert.equal(new Set([...issued, ...seams, ...gates]).size, issued.length + seams.length
    + gates.length);
  const [job] = (await fixture.storage.listScheduledJobs({ limit: 10 }))
    .filter((row) => row.job_name === 'pursue-cim-sender');
  assert.equal(job.metadata.sentInitial, 2);
});

/** Storage whose `method` always throws for calls that match `when`. */
function throwingFor(storage, method, when) {
  return new Proxy(storage, { get(target, name) {
    const value = target[name];
    if (name === method) {
      return async (command) => {
        if (when(command)) throw new Error('synthetic storage failure');
        return value.call(target, command);
      };
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('a touch that always throws never blocks the rest of the list', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [due('a'), due('b'), due('c')] });
  const { touchId } = fixture.campaigns.a;
  const storage = throwingFor(fixture.storage, 'readCimFollowUpAuthority',
    (command) => command.touchId === touchId);
  const first = await fixture.run({ storage });
  assert.equal(first.sentInitial, 2, JSON.stringify(first));
  assert.equal(first.skipped.initial_failed, 1);
  fixture.clock.advance(15 * MINUTE);
  const again = await fixture.run({ storage });
  assert.equal(again.skipped.initial_failed, 1);
  assert.equal(fixture.row('deal_hunter_cim_campaign_touches', touchId).state, 'scheduled');
  // Failures after preparation are isolated too, and recovered once the claim lapses.
  const failing = throwingFor(fixture.storage, 'issueCimLiveProviderAuthorization', () => true);
  const thrown = await fixture.run({ storage: failing });
  assert.equal(thrown.skipped.initial_failed, 1, JSON.stringify(thrown));
  assert.equal(fixture.row('deal_hunter_cim_campaign_touches', touchId).state, 'claimed');
  fixture.clock.advance(6 * MINUTE);
  assert.equal((await fixture.run()).sentInitial, 1);
  assert.equal(fixture.mailProvider.sent.length, 3);
});

test('a send whose provider seam was never entered is released after ten minutes and sent once', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  const { touchId } = fixture.campaigns.a;
  // The process dies between the final gate and the provider seam.
  const crashed = await fixture.run({ storage: throwingFor(fixture.storage,
    'enterCimProviderSeam', () => true) });
  assert.equal(crashed.sentInitial, 0, JSON.stringify(crashed));
  assert.equal(fixture.mailProvider.attempts.length, 0);
  const stuck = fixture.row('deal_hunter_cim_transmissions',
    fixture.row('deal_hunter_cim_campaign_touches', touchId).transmission_id);
  assert.equal(stuck.state, 'provider-pending');
  assert.equal(stuck.provider_seam_entered_at, null);
  // Not before ten minutes from its authorization.
  fixture.clock.set(at(MONDAY_0805, 5 * MINUTE));
  const early = await fixture.run();
  assert.equal(early.released, 0);
  assert.equal(fixture.row('deal_hunter_cim_transmissions', stuck.id).state, 'provider-pending');
  fixture.clock.set(at(MONDAY_0805, 15 * MINUTE));
  const released = await fixture.run();
  assert.equal(released.released, 1, JSON.stringify(released));
  assert.equal(released.sentInitial, 1);
  const cancelled = fixture.row('deal_hunter_cim_transmissions', stuck.id);
  assert.equal(cancelled.state, 'cancelled-before-provider');
  assert.equal(cancelled.provider_result_code, 'provider_seam_not_entered');
  assert.equal(fixture.mailProvider.attempts.length, 1);
  assert.equal(fixture.row('deal_hunter_cim_campaigns', fixture.campaigns.a.campaignId).state,
    'active-follow-up');
  assert.equal(fixture.count('deal_hunter_cim_terminal_events'), 0);
});

test('the seam-never-entered release refuses an entered seam and anything before its grace', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805,
    campaigns: [due('a'), due('b')] });
  const entered = crashingOnce(fixture.storage, 'finalizeCimTransmission');
  await fixture.run({ storage: throwingFor(entered, 'enterCimProviderSeam',
    (command) => command.transmissionId === fixture.database.prepare(`SELECT transmission_id
      FROM deal_hunter_cim_campaign_touches WHERE id = ?`).get(fixture.campaigns.b.touchId)
      .transmission_id) });
  const transmissionOf = (suffix) => fixture.row('deal_hunter_cim_transmissions',
    fixture.row('deal_hunter_cim_campaign_touches', fixture.campaigns[suffix].touchId)
      .transmission_id);
  const seamEntered = transmissionOf('a');
  const unentered = transmissionOf('b');
  assert.ok(seamEntered.provider_seam_entered_at);
  assert.equal(unentered.provider_seam_entered_at, null);
  const release = (transmission, now) => fixture.storage.releaseCimProviderPendingUnsent({
    transmissionId: transmission.id, payloadDigest: transmission.payload_digest,
    expectedRowVersion: transmission.row_version, provider: 'gmail',
    providerResultCode: 'provider_seam_not_entered', actor: 'test', now });
  assert.equal((await release(seamEntered, at(MONDAY_0805, 30 * MINUTE))).conflict, true);
  assert.equal((await release(unentered, at(MONDAY_0805, 5 * MINUTE))).conflict, true);
  assert.equal((await release(unentered, at(MONDAY_0805, 30 * MINUTE))).applied, true);
  assert.equal(transmissionOf('a').state, 'provider-pending');
});

test('Live sending off and on again: a prepared follow-up is prepared again and sent exactly once', async (t) => {
  const fixture = await createSenderFixture(t, { start: MONDAY_0805, campaigns: [due('a')] });
  await sendInitial(fixture);
  const touch = scheduledFollowUp(fixture, 'a');
  fixture.clock.set(at(touch.due_at, 30_000));
  const [candidate] = await fixture.storage.listDueCimFollowUpTouches({
    now: fixture.clock.peek().toISOString() });
  const prepared = await runCimFollowUpPreparation({ storage: fixture.storage, candidate,
    clock: fixture.clock, actor: 'crashed-worker', claimTokenDigest: fill('9'),
    loadAuthority: (input) => loadPursueFollowUpAuthority({ ...input, config: fixture.config,
      loadMemberAuthority: fixture.loadMemberAuthority }),
    buildPayload: (input) => buildPursueFollowUpPayload({ ...input, config: fixture.config }) });
  assert.equal(prepared.prepared, true);
  const toggle = async (enabled) => {
    await setSendControl(fixture.storage, 'live_sending', enabled);
    return syncPursueGmailCapabilities({ storage: fixture.storage, enabled, actor: 'owner',
      now: fixture.clock().toISOString() });
  };
  const off = await toggle(false);
  assert.equal(off.released, 1);
  assert.equal(fixture.row('deal_hunter_cim_transmissions', prepared.transmission.id).state,
    'cancelled-before-provider');
  assert.equal(fixture.row('deal_hunter_cim_campaign_touches', touch.id).state, 'scheduled');
  assert.deepEqual(fixture.database.prepare(`SELECT state FROM
    deal_hunter_cim_capacity_reservations WHERE transmission_id = ?`)
    .all(prepared.transmission.id).map(({ state }) => state), ['released']);
  await toggle(true);
  fixture.clock.advance(MINUTE);
  const summary = await fixture.run();
  assert.equal(summary.sentFollowUps, 1, JSON.stringify(summary));
  assert.equal(fixture.mailProvider.sent.length, 2);
  assert.deepEqual(fixture.database.prepare(`SELECT tr.preparation_generation AS g, tr.state
    FROM deal_hunter_cim_transmission_touches m JOIN deal_hunter_cim_transmissions tr
      ON tr.id = m.transmission_id WHERE m.touch_id = ? ORDER BY g`).all(touch.id),
  [{ g: 1, state: 'cancelled-before-provider' }, { g: 2, state: 'accepted' }]);
  fixture.clock.advance(15 * MINUTE);
  assert.equal((await fixture.run()).sentFollowUps, 0);
  assert.equal(fixture.mailProvider.sent.length, 2);
});

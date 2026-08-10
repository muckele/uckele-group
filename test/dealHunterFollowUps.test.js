import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCimFollowUpSendDay,
  nextCimFollowUpAt,
  runDealHunterCimFollowUps,
} from '../server/services/dealHunter.js';

const weekdaySettings = {
  enabled: true,
  checkIntervalMs: 3_600_000,
  firstDelayHours: 48,
  intervalHours: 72,
  maxCount: 3,
  delaySequenceHours: [48, 72, 96],
  weekdaysOnly: true,
  timezone: 'America/Los_Angeles',
};

test('CIM follow-up weekday guard uses the configured timezone', () => {
  assert.equal(
    isCimFollowUpSendDay({ now: new Date('2026-07-18T16:00:00.000Z'), settings: weekdaySettings }),
    false,
  );
  assert.equal(
    isCimFollowUpSendDay({ now: new Date('2026-07-20T06:00:00.000Z'), settings: weekdaySettings }),
    false,
    'Monday in UTC is still Sunday evening in America/Los_Angeles',
  );
  assert.equal(
    isCimFollowUpSendDay({ now: new Date('2026-07-20T16:00:00.000Z'), settings: weekdaySettings }),
    true,
  );
  assert.equal(
    isCimFollowUpSendDay({
      now: new Date('2026-07-18T16:00:00.000Z'),
      settings: { ...weekdaySettings, weekdaysOnly: false },
    }),
    true,
  );
});

test('CIM follow-up cadence advances 48, 72, and 96 hours between touches', () => {
  const initialSentAt = '2026-07-15T02:00:00.000Z';
  const firstFollowUpAt = nextCimFollowUpAt({
    status: 'sent',
    followUpCount: 0,
    lastTouchAt: initialSentAt,
    settings: weekdaySettings,
  });
  const secondFollowUpAt = nextCimFollowUpAt({
    status: 'sent',
    followUpCount: 1,
    lastTouchAt: firstFollowUpAt,
    settings: weekdaySettings,
  });
  const thirdFollowUpAt = nextCimFollowUpAt({
    status: 'sent',
    followUpCount: 2,
    lastTouchAt: secondFollowUpAt,
    settings: weekdaySettings,
  });

  assert.equal(firstFollowUpAt, '2026-07-17T02:00:00.000Z');
  assert.equal(secondFollowUpAt, '2026-07-20T02:00:00.000Z');
  assert.equal(thirdFollowUpAt, '2026-07-24T02:00:00.000Z');
  assert.equal(
    nextCimFollowUpAt({
      status: 'sent',
      followUpCount: 3,
      lastTouchAt: thirdFollowUpAt,
      settings: weekdaySettings,
    }),
    null,
  );
});

test('CIM follow-up run defers weekend work before reading the due queue', async () => {
  let queueRead = false;
  const storage = {
    async listDealHunterCimRequests() {
      queueRead = true;
      return [];
    },
    async upsertDealHunterCimRequest(request) {
      return request;
    },
  };

  const result = await runDealHunterCimFollowUps({
    storage,
    now: new Date('2026-07-18T16:00:00.000Z'),
    settings: weekdaySettings,
  });

  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.equal(result.sent, 0);
  assert.equal(queueRead, false);
  assert.match(result.message, /next weekday/i);
});

test('global suppression stops a due CIM follow-up before claim, persistence, or provider work', async () => {
  const request = {
    id: 'suppressed-cim-request',
    submission_id: 'suppressed-submission',
    deal_key: 'suppressed-deal',
    deal_name: 'Suppressed Deal',
    recipient_email: 'suppressed@example.test',
    status: 'sent',
    request_state: 'provider_accepted',
    follow_up_state: 'scheduled',
    follow_up_count: 0,
    next_follow_up_at: '2026-07-20T15:00:00.000Z',
    updated_at: '2026-07-18T16:00:00.000Z',
    metadata: {},
  };
  let claimed = false;
  let stored = request;
  const storage = {
    async listDealHunterCimRequests() { return [stored]; },
    async upsertDealHunterCimRequest(value) { stored = value; return value; },
    async getSubmission() { return { id: request.submission_id, status: 'review' }; },
    async getActiveEmailSuppression(email) {
      assert.equal(email, request.recipient_email);
      return { id: 'suppression-1', reason: 'complaint', created_at: '2026-07-19T16:00:00.000Z' };
    },
    async claimDealHunterCimFollowUpRequest() { claimed = true; throw new Error('must not claim'); },
    async mutateWithCrmActivity({ operation, payload, activity }) {
      assert.equal(operation, 'upsert_deal_hunter_cim_request');
      assert.equal(activity.event_type, 'cim.outreach-suppressed');
      stored = payload.request;
      return { applied: true, record: stored, activity };
    },
  };
  const result = await runDealHunterCimFollowUps({
    storage,
    now: new Date('2026-07-20T16:00:00.000Z'),
    settings: weekdaySettings,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stopped, 1);
  assert.equal(result.sent, 0);
  assert.equal(claimed, false);
  assert.equal(stored.request_state, 'stopped');
  assert.equal(stored.follow_up_state, 'stopped');
  assert.equal(stored.next_follow_up_at, null);
});

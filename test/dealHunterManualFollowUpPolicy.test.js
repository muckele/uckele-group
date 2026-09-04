import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MANUAL_FOLLOW_UP_CADENCE,
  MANUAL_FOLLOW_UP_MAXIMUM,
  MANUAL_FOLLOW_UP_MODE,
  MANUAL_FOLLOW_UP_VERSION,
  buildManualFollowUpCommunicationId,
  buildManualFollowUpMarker,
  getManualFollowUpNumber,
  isOperatorApprovedFollowUpRequest,
  nextManualFollowUpAt,
  projectManualFollowUpState,
} from '../server/services/dealHunterManualFollowUpPolicy.js';

function markedRequest(overrides = {}) {
  return {
    id: 'request-1',
    follow_up_count: 0,
    follow_up_state: 'scheduled',
    next_follow_up_at: '2026-09-02T16:00:00.000Z',
    metadata: {
      manualApproval: { version: 'phase-2-audit' },
      manualFollowUp: buildManualFollowUpMarker({
        enrolledAt: '2026-09-01T16:00:00.000Z',
        enrolledBy: 'admin@example.com',
      }),
    },
    ...overrides,
  };
}

test('manual follow-up marker is fixed to operator-approved version cadence and maximum five', () => {
  assert.equal(MANUAL_FOLLOW_UP_VERSION, 'deal-hunter-manual-follow-up-v1');
  assert.equal(MANUAL_FOLLOW_UP_MODE, 'operator-approved');
  assert.equal(MANUAL_FOLLOW_UP_MAXIMUM, 5);
  assert.equal(MANUAL_FOLLOW_UP_CADENCE, 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1');
  assert.deepEqual(buildManualFollowUpMarker({
    enrolledAt: '2026-09-01T16:00:00.000Z',
    enrolledBy: 'admin@example.com',
  }), {
    version: 'deal-hunter-manual-follow-up-v1',
    mode: 'operator-approved',
    maximumFollowUps: 5,
    cadencePolicy: 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1',
    enrolledAt: '2026-09-01T16:00:00.000Z',
    enrolledBy: 'admin@example.com',
  });
  assert.equal(isOperatorApprovedFollowUpRequest(markedRequest()), true);
  assert.equal(isOperatorApprovedFollowUpRequest({ metadata: {} }), false);
});

test('manual follow-up detection rejects mode-only wrong-version wrong-maximum wrong-cadence string-maximum and malformed markers', () => {
  const validMarker = markedRequest().metadata.manualFollowUp;
  const invalidMarkers = [
    { mode: MANUAL_FOLLOW_UP_MODE },
    { version: MANUAL_FOLLOW_UP_VERSION },
    { ...validMarker, version: 'deal-hunter-manual-follow-up-v2' },
    { ...validMarker, maximumFollowUps: 4 },
    { ...validMarker, maximumFollowUps: '5' },
    { ...validMarker, cadencePolicy: 'accepted-plus-48-hours' },
    [],
    'operator-approved',
    5,
    null,
  ];

  assert.equal(isOperatorApprovedFollowUpRequest(markedRequest()), true);
  for (const manualFollowUp of invalidMarkers) {
    assert.equal(
      isOperatorApprovedFollowUpRequest({ metadata: { manualFollowUp } }),
      false,
      JSON.stringify(manualFollowUp),
    );
  }
});

test('manual follow-up cadence uses Pacific calendar dates across PST PDT and weekend rollover', () => {
  assert.equal(nextManualFollowUpAt('2026-01-05T18:30:00.000Z'), '2026-01-07T17:00:00.000Z');
  assert.equal(nextManualFollowUpAt('2026-07-06T17:30:00.000Z'), '2026-07-08T16:00:00.000Z');
  assert.equal(nextManualFollowUpAt('2026-03-06T20:00:00.000Z'), '2026-03-09T16:00:00.000Z');
  assert.equal(nextManualFollowUpAt('2026-10-30T20:00:00.000Z'), '2026-11-02T17:00:00.000Z');
  assert.equal(nextManualFollowUpAt('not-an-instant'), '');
});

test('manual follow-up cadence maps Monday through Friday acceptance to Wednesday Thursday Friday Monday Monday at 09:00 Pacific', () => {
  const cases = [
    ['2026-08-31T23:37:00.000Z', '2026-09-02T16:00:00.000Z'],
    ['2026-09-01T23:37:00.000Z', '2026-09-03T16:00:00.000Z'],
    ['2026-09-02T23:37:00.000Z', '2026-09-04T16:00:00.000Z'],
    ['2026-09-03T23:37:00.000Z', '2026-09-07T16:00:00.000Z'],
    ['2026-09-04T23:37:00.000Z', '2026-09-07T16:00:00.000Z'],
  ];

  for (const [acceptedAt, expectedDueAt] of cases) {
    assert.equal(nextManualFollowUpAt(acceptedAt), expectedDueAt);
  }
});

test('manual follow-up cadence handles defensive Saturday and Sunday acceptance deterministically', () => {
  assert.equal(nextManualFollowUpAt('2026-09-05T23:37:00.000Z'), '2026-09-07T16:00:00.000Z');
  assert.equal(nextManualFollowUpAt('2026-09-06T23:37:00.000Z'), '2026-09-08T16:00:00.000Z');
});

test('manual follow-up numbering accepts only one through five and never projects six', () => {
  for (const followUpCount of [0, 1, 2, 3, 4]) {
    assert.equal(getManualFollowUpNumber(markedRequest({ follow_up_count: followUpCount })), followUpCount + 1);
  }
  assert.equal(getManualFollowUpNumber(markedRequest({ follow_up_count: 5 })), null);
  assert.equal(getManualFollowUpNumber(markedRequest({ follow_up_count: 6 })), null);
  assert.equal(getManualFollowUpNumber({ follow_up_count: 0, metadata: {} }), null);
});

test('manual follow-up communication identity is deterministic and distinct for one through five', () => {
  const expected = [
    'eea754853cc378c9b1fd44b9d24eb16bfd03f57f058dfff9b14fe82dc074e627',
    '193d82863cc23b7f648984f4b96ca65855a294e6b48020553a4bf8327de621b2',
    'b63f5f0d63f44baaba4fbe6b6f450300bd0e4823aa174117ef5ef7deacecb320',
    'c3471afc0b72928250ea50d1b8fedc929bc6d4aca76389c238296dd7010a1f60',
    '83b36331c0ffeeb6bb4eba4c2cd5e58b297294a09cb813693adf5f5f2f7e570a',
  ];
  const actual = [1, 2, 3, 4, 5].map((followUpNumber) => (
    buildManualFollowUpCommunicationId({ requestId: 'request-1', followUpNumber })
  ));
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, 5);
  assert.equal(buildManualFollowUpCommunicationId({ requestId: 'request-1', followUpNumber: 6 }), '');
  assert.equal(buildManualFollowUpCommunicationId({ requestId: '', followUpNumber: 1 }), '');
});

test('manual follow-up projection distinguishes not-enrolled scheduled due overdue retry ambiguous completed stopped and closed', () => {
  const now = new Date('2026-09-02T17:00:00.000Z');
  const scenarios = [
    ['not-enrolled', { request: { id: 'request-1', metadata: {}, follow_up_count: 0 } }],
    ['scheduled', { request: markedRequest({ next_follow_up_at: '2026-09-03T16:00:00.000Z' }) }],
    ['due', { request: markedRequest({ next_follow_up_at: '2026-09-02T16:00:00.000Z' }) }],
    ['overdue', { request: markedRequest({ next_follow_up_at: '2026-09-01T16:00:00.000Z' }) }],
    ['retry', {
      request: markedRequest({ follow_up_state: 'failed' }),
      communications: [{ follow_up_number: 1, status: 'failed', delivery_state: 'failed' }],
    }],
    ['ambiguous', {
      request: markedRequest({ follow_up_state: 'ambiguous' }),
      communications: [{ follow_up_number: 1, status: 'ambiguous', delivery_state: 'unknown' }],
    }],
    ['completed', { request: markedRequest({ follow_up_count: 5, follow_up_state: 'completed', next_follow_up_at: null }) }],
    ['stopped', {
      request: markedRequest({
        follow_up_state: 'stopped',
        next_follow_up_at: null,
        metadata: {
          ...markedRequest().metadata,
          manualFollowUp: { ...markedRequest().metadata.manualFollowUp, stoppedAt: '2026-09-02T16:30:00.000Z' },
        },
      }),
    }],
    ['closed', {
      request: markedRequest(),
      authority: { terminalReason: 'materials-received' },
    }],
  ];

  for (const [expectedState, input] of scenarios) {
    const projection = projectManualFollowUpState({ ...input, now });
    assert.equal(projection.state, expectedState);
    assert.equal(projection.currentFollowUpNumber === 6, false);
  }
});

test('manual follow-up projection separates preparation blockers from current send blockers', () => {
  const projection = projectManualFollowUpState({
    request: markedRequest(),
    communications: [],
    authority: {
      preparationBlockers: [{ code: 'not-due', message: 'The next follow-up is not due.' }],
      sendBlockers: [
        { code: 'cim-outreach-paused', message: 'CIM outreach is paused.' },
        { code: 'recipient-cadence', message: 'Recipient cadence is blocked.' },
      ],
      privateDigest: 'must-not-leak',
    },
    now: new Date('2026-09-01T17:00:00.000Z'),
  });

  assert.deepEqual(projection.preparationBlockers, [
    { code: 'not-due', message: 'The next follow-up is not due.' },
  ]);
  assert.deepEqual(projection.sendBlockers, [
    { code: 'cim-outreach-paused', message: 'CIM outreach is paused.' },
    { code: 'recipient-cadence', message: 'Recipient cadence is blocked.' },
  ]);
  assert.equal(JSON.stringify(projection).includes('must-not-leak'), false);
});

test('manual follow-up projection fails closed for negative fractional NaN nonnumeric and above-maximum durable counts', () => {
  for (const followUpCount of [-1, 1.5, Number.NaN, 'not-a-number', 6]) {
    const projection = projectManualFollowUpState({
      request: markedRequest({ follow_up_count: followUpCount, follow_up_state: 'failed' }),
      communications: [{ follow_up_number: 1, status: 'failed', delivery_state: 'failed' }],
      now: new Date('2026-09-02T17:00:00.000Z'),
    });

    assert.equal(projection.state, 'closed', String(followUpCount));
    assert.equal(projection.followUpCount, null, String(followUpCount));
    assert.equal(projection.currentFollowUpNumber, null, String(followUpCount));
    assert.equal(projection.retryEligible, false, String(followUpCount));
    assert.deepEqual(projection.preparationBlockers, [{
      code: 'manual-follow-up-authority-invalid',
      message: 'Manual follow-up count authority is invalid.',
    }]);
  }

  const absentInitialCount = markedRequest();
  delete absentInitialCount.follow_up_count;
  const initialProjection = projectManualFollowUpState({ request: absentInitialCount });
  assert.equal(initialProjection.followUpCount, 0);
  assert.equal(initialProjection.currentFollowUpNumber, 1);

  const completeProjection = projectManualFollowUpState({
    request: markedRequest({ follow_up_count: 5 }),
  });
  assert.equal(completeProjection.state, 'completed');
  assert.equal(completeProjection.currentFollowUpNumber, null);
});

test('operator stop outranks failed ambiguous and stale-due state and never exposes retry', () => {
  const stoppedMarker = {
    ...markedRequest().metadata.manualFollowUp,
    stoppedAt: '2026-09-02T16:30:00.000Z',
  };
  const scenarios = [
    {
      follow_up_state: 'failed',
      next_follow_up_at: '2026-09-01T16:00:00.000Z',
      communications: [{ follow_up_number: 1, status: 'failed', delivery_state: 'failed' }],
    },
    {
      follow_up_state: 'ambiguous',
      next_follow_up_at: '2026-09-01T16:00:00.000Z',
      communications: [{ follow_up_number: 1, status: 'ambiguous', delivery_state: 'unknown' }],
    },
    { follow_up_state: 'scheduled', next_follow_up_at: '2026-09-01T16:00:00.000Z' },
    { follow_up_state: 'scheduled', next_follow_up_at: '2026-09-03T16:00:00.000Z' },
  ];

  for (const { communications = [], ...requestOverrides } of scenarios) {
    const projection = projectManualFollowUpState({
      request: markedRequest({
        ...requestOverrides,
        metadata: { ...markedRequest().metadata, manualFollowUp: stoppedMarker },
      }),
      communications,
      now: new Date('2026-09-02T17:00:00.000Z'),
    });

    assert.equal(projection.state, 'stopped');
    assert.equal(projection.retryEligible, false);
    assert.equal(projection.currentFollowUpNumber, null);
    assert.equal(projection.nextFollowUpAt, '');
  }
});

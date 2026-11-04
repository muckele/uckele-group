import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAcceptedCimCadence } from '../server/services/pursueCimCadence.js';

const acceptedAt = '2026-09-25T19:00:07.000Z';

function expiryDerivation(expiresAt = '2026-10-23T19:00:07.000Z') {
  return JSON.stringify({ policyVersion: 'deal-hunter-cim-autopilot-v1',
    cadencePolicyVersion: 'deal-hunter-cim-cadence-v2', sourceAcceptedAt: acceptedAt,
    sendTime: '08:00', expiresAt });
}

function context({ kind = 'initial', logicalSlot = kind,
  ordinal = kind === 'initial' ? 0 : 1, campaign = {} } = {}) {
  return {
    transmission: { id: 'transmission-1', campaign_terminal_revision: 0 },
    members: [{
      membership: { transmission_id: 'transmission-1', touch_id: 'touch-1',
        campaign_id: 'campaign-1', cancelled_at: null },
      touch: { id: 'touch-1', campaign_id: 'campaign-1', opportunity_id: 'opp-1',
        logical_slot: logicalSlot, kind, ordinal, timezone_revision: 1,
        row_version: 4 },
      campaign: { id: 'campaign-1', opportunity_id: 'opp-1',
        policy_version: 'deal-hunter-cim-autopilot-v1', timezone_revision: 1,
        state: kind === 'initial' ? 'initial-pending' : 'active-follow-up',
        terminal_revision: 0, row_version: 8, initial_accepted_at: null,
        local_expiry_at: null, expiry_derivation: '{}', ...campaign },
      timezone: { opportunity_id: 'opp-1', revision: 1,
        iana_timezone: 'America/New_York' },
    }],
  };
}

test('P6D scenarios 30/35/43: initial acceptance anchors expiry and one deterministic follow-up-1', () => {
  const projection = deriveAcceptedCimCadence(context(), acceptedAt);
  const replay = deriveAcceptedCimCadence(context(), acceptedAt);
  assert.equal(projection.acceptedAt, acceptedAt);
  assert.equal(projection.initialAcceptedAt, acceptedAt);
  assert.equal(projection.localExpiryAt, '2026-10-23T19:00:07.000Z');
  assert.equal(projection.expiryDerivation.localExpiry, '2026-10-23T15:00:07');
  assert.deepEqual({ logicalSlot: projection.nextTouch.logicalSlot,
    kind: projection.nextTouch.kind, ordinal: projection.nextTouch.ordinal,
    dueAt: projection.nextTouch.dueAt, dueLocal: projection.nextTouch.dueLocal }, {
    logicalSlot: 'follow-up-1', kind: 'follow-up-1', ordinal: 1,
    dueAt: '2026-09-29T12:00:00.000Z', dueLocal: '2026-09-29T08:00:00',
  });
  assert.match(projection.nextTouch.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(replay, projection, 'same accepted outcome derives the same slot identity');
});

test('P6D binds the configured local send time once and reuses it for later touches', () => {
  const initial = deriveAcceptedCimCadence(context(), acceptedAt, { sendTime: '09:15' });
  assert.equal(initial.expiryDerivation.sendTime, '09:15');
  assert.equal(initial.nextTouch.dueLocal, '2026-09-29T09:15:00');
  const campaign = { initial_accepted_at: acceptedAt,
    local_expiry_at: '2026-10-23T19:00:07.000Z',
    expiry_derivation: JSON.stringify(initial.expiryDerivation) };
  const later = deriveAcceptedCimCadence(context({ kind: 'follow-up-1', ordinal: 1,
    campaign }), '2026-09-29T13:15:00.000Z', { sendTime: '08:00' });
  assert.equal(later.nextTouch.dueLocal, '2026-10-01T09:15:00');
});

test('P6D later acceptance retains the initial four-week expiry without resetting it', () => {
  const campaign = { initial_accepted_at: acceptedAt,
    local_expiry_at: '2026-10-23T19:00:07.000Z', expiry_derivation: expiryDerivation() };
  const projection = deriveAcceptedCimCadence(context({ kind: 'follow-up-1', ordinal: 1,
    campaign }), '2026-09-29T12:00:00.000Z');
  assert.equal(projection.initialAcceptedAt, acceptedAt);
  assert.equal(projection.localExpiryAt, '2026-10-23T19:00:07.000Z');
  assert.equal(projection.expiryDerivation.sourceAcceptedAt, acceptedAt);
});

test('P6D scenarios 31-33: every accepted touch derives only its next exact chain identity', () => {
  const campaign = { initial_accepted_at: acceptedAt,
    local_expiry_at: '2026-10-23T19:00:07.000Z',
    expiry_derivation: expiryDerivation() };
  const cases = [
    ['follow-up-1', 1, '2026-09-29T12:00:00.000Z', 'follow-up-2', 2,
      '2026-10-01T12:00:00.000Z'],
    ['follow-up-2', 2, '2026-10-01T12:00:00.000Z', 'follow-up-3', 3,
      '2026-10-03T12:00:00.000Z'],
    ['follow-up-3', 3, '2026-10-03T12:00:00.000Z', 'weekday-follow-up', 4,
      '2026-10-05T12:00:00.000Z'],
    ['weekday-follow-up', 4, '2026-10-05T12:00:00.000Z', 'weekday-follow-up', 5,
      '2026-10-07T12:00:00.000Z'],
  ];
  for (const [kind, ordinal, observedAt, nextKind, nextOrdinal, dueAt] of cases) {
    const logicalSlot = kind === 'weekday-follow-up' ? 'calendar:2026-10-05' : kind;
    const projection = deriveAcceptedCimCadence(
      context({ kind, logicalSlot, ordinal, campaign }), observedAt);
    assert.equal(projection.nextTouch.kind, nextKind);
    assert.equal(projection.nextTouch.ordinal, nextOrdinal);
    assert.equal(projection.nextTouch.dueAt, dueAt);
    if (nextKind === 'weekday-follow-up') {
      assert.match(projection.nextTouch.logicalSlot, /^calendar:\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('P6D scenarios 34-36: expiry suppresses the next slot and unknown/stale authority fails closed', () => {
  const expiring = context({ kind: 'follow-up-3', ordinal: 3,
    campaign: { initial_accepted_at: acceptedAt,
      local_expiry_at: '2026-10-06T12:00:00.000Z',
      expiry_derivation: expiryDerivation('2026-10-06T12:00:00.000Z') } });
  assert.equal(deriveAcceptedCimCadence(expiring,
    '2026-10-05T12:00:00.000Z').nextTouch, null);
  assert.throws(() => deriveAcceptedCimCadence(context({ campaign: {
    policy_version: 'unknown-policy' } }), acceptedAt), /policy/i);
  assert.throws(() => deriveAcceptedCimCadence(context({ campaign: {
    timezone_revision: 2 } }), acceptedAt), /timezone/i);
  for (const expiryDerivation of ['[]', '"scalar"', 'null']) {
    assert.throws(() => deriveAcceptedCimCadence(context({ campaign: {
      local_expiry_at: '2026-10-23T19:00:07.000Z', expiry_derivation: expiryDerivation,
    } }), acceptedAt), /expiry derivation/i,
    `non-object expiry derivation ${expiryDerivation} must fail closed`);
  }
  assert.throws(() => deriveAcceptedCimCadence(context({ kind: 'follow-up-1', ordinal: 1,
    campaign: { initial_accepted_at: acceptedAt,
      local_expiry_at: '2026-10-23T19:00:07.000Z',
      expiry_derivation: JSON.stringify({ policyVersion: 'deal-hunter-cim-autopilot-v1',
        cadencePolicyVersion: 'deal-hunter-cim-cadence-v2', sourceAcceptedAt: acceptedAt,
        expiresAt: '2026-10-23T19:00:07.000Z' }) } }),
  '2026-09-29T12:00:00.000Z'), /expiry authority/i);
  assert.throws(() => deriveAcceptedCimCadence(context({ campaign: {
    initial_accepted_at: '2026-09-25T19:00:06.000Z',
    local_expiry_at: '2026-10-23T19:00:07.000Z', expiry_derivation: expiryDerivation(),
  } }), acceptedAt), /expiry authority/i);
  const terminal = context();
  terminal.members[0].campaign.terminal_revision = 1;
  assert.equal(deriveAcceptedCimCadence(terminal, acceptedAt), null);
});

function stampedDerivation(cadencePolicyVersion, expiresAt = '2026-11-30T17:00:00.000Z') {
  return JSON.stringify({ policyVersion: 'deal-hunter-cim-autopilot-v1', cadencePolicyVersion,
    sourceAcceptedAt: '2026-11-02T17:00:00.000Z', sendTime: '08:00', expiresAt });
}

function stampedContext(cadencePolicyVersion, touch) {
  const value = context({ ...touch, campaign: {
    initial_accepted_at: '2026-11-02T17:00:00.000Z',
    local_expiry_at: '2026-11-30T17:00:00.000Z',
    expiry_derivation: stampedDerivation(cadencePolicyVersion) } });
  value.members[0].timezone.iana_timezone = 'America/Los_Angeles';
  return value;
}

test('new acceptance stamps deal-hunter-cim-cadence-v3', () => {
  const projection = deriveAcceptedCimCadence(context(), acceptedAt);
  assert.equal(projection.expiryDerivation.cadencePolicyVersion, 'deal-hunter-cim-cadence-v3');
  assert.equal(projection.nextTouch.cadencePolicyVersion, 'deal-hunter-cim-cadence-v3');
  // Monday 2026-11-02 09:00 Los Angeles: follow-up-1 is due Wednesday 08:00.
  const monday = context();
  monday.members[0].timezone.iana_timezone = 'America/Los_Angeles';
  const fresh = deriveAcceptedCimCadence(monday, '2026-11-02T17:00:00.000Z');
  assert.equal(fresh.expiryDerivation.cadencePolicyVersion, 'deal-hunter-cim-cadence-v3');
  assert.equal(fresh.localExpiryAt, '2026-11-30T17:00:00.000Z');
  assert.equal(fresh.nextTouch.dueLocal, '2026-11-04T08:00:00');
  assert.equal(fresh.nextTouch.dueAt, '2026-11-04T16:00:00.000Z');
});

test('derivation dispatches on the campaign expiry_derivation cadence version', () => {
  // follow-up-1 accepted Thursday 2026-11-05 10:00 Los Angeles.
  const thursday = '2026-11-05T18:00:00.000Z';
  const v3 = deriveAcceptedCimCadence(stampedContext('deal-hunter-cim-cadence-v3',
    { kind: 'follow-up-1', ordinal: 1 }), thursday);
  assert.equal(v3.nextTouch.kind, 'follow-up-2');
  assert.equal(v3.nextTouch.dueLocal, '2026-11-09T08:00:00');
  assert.equal(v3.nextTouch.dueAt, '2026-11-09T16:00:00.000Z');
  assert.equal(v3.nextTouch.cadencePolicyVersion, 'deal-hunter-cim-cadence-v3');
  assert.equal(v3.expiryDerivation.cadencePolicyVersion, 'deal-hunter-cim-cadence-v3');
  const v2 = deriveAcceptedCimCadence(stampedContext('deal-hunter-cim-cadence-v2',
    { kind: 'follow-up-1', ordinal: 1 }), thursday);
  assert.equal(v2.nextTouch.dueLocal, '2026-11-07T08:00:00');
  assert.equal(v2.nextTouch.dueAt, '2026-11-07T16:00:00.000Z');
  assert.equal(v2.nextTouch.cadencePolicyVersion, 'deal-hunter-cim-cadence-v2');

  // The repeating slot key follows the stamped version, and so does the touch id.
  const friday = '2026-11-06T17:00:00.000Z';
  const v3Repeat = deriveAcceptedCimCadence(stampedContext('deal-hunter-cim-cadence-v3',
    { kind: 'weekday-follow-up', logicalSlot: 'business:2026-11-06', ordinal: 4 }), friday);
  assert.equal(v3Repeat.nextTouch.logicalSlot, 'business:2026-11-10');
  assert.equal(v3Repeat.nextTouch.dueLocal, '2026-11-10T08:00:00');
  assert.equal(v3Repeat.nextTouch.ordinal, 5);
  const v2Repeat = deriveAcceptedCimCadence(stampedContext('deal-hunter-cim-cadence-v2',
    { kind: 'weekday-follow-up', logicalSlot: 'calendar:2026-11-06', ordinal: 4 }), friday);
  assert.equal(v2Repeat.nextTouch.logicalSlot, 'calendar:2026-11-08');
  assert.equal(v2Repeat.nextTouch.dueLocal, '2026-11-08T08:00:00');
  assert.notEqual(v3Repeat.nextTouch.id, v2Repeat.nextTouch.id);

  // A repeating touch whose slot key belongs to the other version fails closed.
  assert.throws(() => deriveAcceptedCimCadence(stampedContext('deal-hunter-cim-cadence-v3',
    { kind: 'weekday-follow-up', logicalSlot: 'calendar:2026-11-06', ordinal: 4 }), friday),
  /Invalid current CIM cadence touch/);
  assert.throws(() => deriveAcceptedCimCadence(stampedContext('deal-hunter-cim-cadence-v2',
    { kind: 'weekday-follow-up', logicalSlot: 'business:2026-11-06', ordinal: 4 }), friday),
  /Invalid current CIM cadence touch/);
  // An unknown or missing stamped version never defaults.
  for (const version of ['deal-hunter-cim-cadence-v1', 'deal-hunter-cim-cadence-v4', undefined]) {
    assert.throws(() => deriveAcceptedCimCadence(stampedContext(version,
      { kind: 'follow-up-1', ordinal: 1 }), thursday), /expiry authority/i);
  }
});

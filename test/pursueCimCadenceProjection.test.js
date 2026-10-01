import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAcceptedCimCadence } from '../server/services/pursueCimCadence.js';

const acceptedAt = '2026-09-25T19:00:07.000Z';

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
  assert.equal(projection.acceptedAt, acceptedAt);
  assert.equal(projection.initialAcceptedAt, acceptedAt);
  assert.equal(projection.localExpiryAt, '2026-10-16T19:00:07.000Z');
  assert.equal(projection.expiryDerivation.localExpiry, '2026-10-16T15:00:07');
  assert.deepEqual({ logicalSlot: projection.nextTouch.logicalSlot,
    kind: projection.nextTouch.kind, ordinal: projection.nextTouch.ordinal,
    dueAt: projection.nextTouch.dueAt, dueLocal: projection.nextTouch.dueLocal }, {
    logicalSlot: 'follow-up-1', kind: 'follow-up-1', ordinal: 1,
    dueAt: '2026-09-28T12:00:00.000Z', dueLocal: '2026-09-28T08:00:00',
  });
  assert.match(projection.nextTouch.id, /^[0-9a-f]{64}$/);
});

test('P6D scenarios 31-33: every accepted touch derives only its next exact chain identity', () => {
  const campaign = { initial_accepted_at: acceptedAt,
    local_expiry_at: '2026-10-16T19:00:07.000Z',
    expiry_derivation: JSON.stringify({ policyVersion: 'deal-hunter-cim-autopilot-v1' }) };
  const cases = [
    ['follow-up-1', 1, '2026-09-28T12:00:00.000Z', 'follow-up-2', 2,
      '2026-10-01T12:00:00.000Z'],
    ['follow-up-2', 2, '2026-10-01T12:00:00.000Z', 'follow-up-3', 3,
      '2026-10-05T12:00:00.000Z'],
    ['follow-up-3', 3, '2026-10-05T12:00:00.000Z', 'weekday-follow-up', 4,
      '2026-10-06T12:00:00.000Z'],
    ['weekday-follow-up', 4, '2026-10-06T12:00:00.000Z', 'weekday-follow-up', 5,
      '2026-10-07T12:00:00.000Z'],
  ];
  for (const [kind, ordinal, observedAt, nextKind, nextOrdinal, dueAt] of cases) {
    const logicalSlot = kind === 'weekday-follow-up' ? 'weekday:2026-10-06' : kind;
    const projection = deriveAcceptedCimCadence(
      context({ kind, logicalSlot, ordinal, campaign }), observedAt);
    assert.equal(projection.nextTouch.kind, nextKind);
    assert.equal(projection.nextTouch.ordinal, nextOrdinal);
    assert.equal(projection.nextTouch.dueAt, dueAt);
    if (nextKind === 'weekday-follow-up') {
      assert.match(projection.nextTouch.logicalSlot, /^weekday:\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('P6D scenarios 34-36: expiry suppresses the next slot and unknown/stale authority fails closed', () => {
  const expiring = context({ kind: 'follow-up-3', ordinal: 3,
    campaign: { initial_accepted_at: acceptedAt,
      local_expiry_at: '2026-10-06T12:00:00.000Z', expiry_derivation: '{}' } });
  assert.equal(deriveAcceptedCimCadence(expiring,
    '2026-10-05T12:00:00.000Z').nextTouch, null);
  assert.throws(() => deriveAcceptedCimCadence(context({ campaign: {
    policy_version: 'unknown-policy' } }), acceptedAt), /policy/i);
  assert.throws(() => deriveAcceptedCimCadence(context({ campaign: {
    timezone_revision: 2 } }), acceptedAt), /timezone/i);
  for (const expiryDerivation of ['[]', '"scalar"', 'null']) {
    assert.throws(() => deriveAcceptedCimCadence(context({ campaign: {
      local_expiry_at: '2026-10-16T19:00:07.000Z', expiry_derivation: expiryDerivation,
    } }), acceptedAt), /expiry derivation/i,
    `non-object expiry derivation ${expiryDerivation} must fail closed`);
  }
  const terminal = context();
  terminal.members[0].campaign.terminal_revision = 1;
  assert.equal(deriveAcceptedCimCadence(terminal, acceptedAt), null);
});

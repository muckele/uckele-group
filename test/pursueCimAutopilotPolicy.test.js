import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeterministicClock,
  createDeterministicNonceSource,
} from './fixtures/pursueCimHarness.js';
import { createHash } from 'node:crypto';
import {
  validateIanaTimezone,
  resolveLocationTimezone,
  resolveOpportunityTimezone,
  TARGET_STATE_TIMEZONES,
  TIMEZONE_DATASET_DIGEST,
  TIMEZONE_EXCEPTIONS,
  TIMEZONE_RESOLVER_VERSION,
  selectCampaignTimezoneAuthority,
  evaluateCampaignTimezoneChange,
} from '../server/services/opportunityTimezone.js';
import {
  CIM_CAMPAIGN_POLICY_VERSION,
  CIM_CADENCE_POLICY_VERSION,
  CIM_CADENCE_POLICY_VERSION_V2,
  CIM_CADENCE_POLICY_VERSION_V3,
  SUPPORTED_CIM_CADENCE_POLICY_VERSIONS,
  resolveLocalInstant,
  rollToEligibleWindow,
  calculateCampaignExpiry,
  calculateNextCimSlot,
} from '../server/services/cimCampaignPolicy.js';

test('P0 harness: injected clock advances only when the test advances it', () => {
  const clock = createDeterministicClock('2026-08-12T15:00:00.000Z');
  assert.equal(clock.now().toISOString(), '2026-08-12T15:00:00.000Z');
  assert.equal(clock.now().toISOString(), '2026-08-12T15:00:00.000Z');
  assert.equal(clock.advance(60_000).toISOString(), '2026-08-12T15:01:00.000Z');
  assert.equal(clock.set('2026-11-02T16:00:00.000Z').toISOString(), '2026-11-02T16:00:00.000Z');
});
test('P0 harness: fake nonce source is deterministic and collision-free in sequence', () => {
  const nonce = createDeterministicNonceSource('boundary');
  assert.deepEqual([nonce(), nonce(), nonce()], [
    'boundary-0001',
    'boundary-0002',
    'boundary-0003',
  ]);
});

test('P3 scenario 26/27: IANA authority uses evidence precedence and never guesses from state', () => {
  assert.equal(validateIanaTimezone('America/Los_Angeles'), 'America/Los_Angeles');
  assert.equal(validateIanaTimezone('America/New_York'), 'America/New_York');
  assert.equal(validateIanaTimezone('America/Phoenix'), 'America/Phoenix');
  assert.equal(validateIanaTimezone('UTC'), 'UTC');
  assert.equal(validateIanaTimezone('PST'), null);
  const operator = { opportunityId: 'opp-1', ianaTimezone: 'America/Phoenix', evidenceId: 'operator-1',
    evidenceDigest: 'a'.repeat(64), revision: 3, verified: true };
  const source = { opportunityId: 'opp-1', ianaTimezone: 'America/New_York', evidenceId: 'source-1',
    evidenceDigest: 'b'.repeat(64), sourceSystem: 'deal-os-export', sourceRecordId: 'row-1',
    sourceVersion: 'v1' };
  const result = resolveOpportunityTimezone({ opportunityId: 'opp-1', operator, source,
    location: { state: 'CA' } });
  assert.equal(result.ianaTimezone, 'America/Phoenix');
  assert.equal(result.evidenceType, 'operator-verified');
  assert.equal(result.revision, 3);
  assert.equal(resolveOpportunityTimezone({ opportunityId: 'opp-1', source }).ianaTimezone, 'America/New_York');
  assert.equal(resolveOpportunityTimezone({ opportunityId: 'opp-1', source }).resolverVersion,
    'structured-source-v1');
  assert.equal(resolveOpportunityTimezone({ opportunityId: 'opp-1', source: { ...source,
    sourceSystem: null } }).reasonCode, 'timezone_ambiguous');
  assert.equal(resolveOpportunityTimezone({ opportunityId: 'opp-1', operator: { ...operator, verified: false }, source }).ianaTimezone,
    'America/New_York');
  assert.equal(resolveOpportunityTimezone({ opportunityId: 'opp-2', operator, source }).reasonCode,
    'timezone_missing');
  assert.deepEqual(resolveOpportunityTimezone({ opportunityId: 'opp-1', location: { state: 'CA' } }),
    { eligible: true, ianaTimezone: 'America/Los_Angeles', state: 'CA',
      resolverVersion: 'target-state-v1' });
  assert.equal(resolveOpportunityTimezone({ opportunityId: 'opp-1' }).reasonCode, 'timezone_missing');
  assert.equal(resolveOpportunityTimezone({ opportunityId: 'opp-1', location: {} }).reasonCode,
    'timezone_missing');
  assert.equal(resolveOpportunityTimezone({ opportunityId: 'opp-1', source: { ...source,
    ianaTimezone: 'Bogus/Zone' } }).reasonCode,
    'timezone_ambiguous');
  assert.equal(selectCampaignTimezoneAuthority(result).timezoneRevision, 3);
  assert.equal(evaluateCampaignTimezoneChange({ selectedRevision: 3, currentRevision: 4,
    initialAcceptedAt: null }).action, 'recompute');
  assert.equal(evaluateCampaignTimezoneChange({ selectedRevision: 3, currentRevision: 4,
    initialAcceptedAt: '2026-01-01T00:00:00.000Z' }).reasonCode, 'timezone_changed');
});

test('P3 scenario 26: Phoenix stays UTC-7 across the spring change while LA and NY change', () => {
  const friday = '2026-03-06T14:00:00.000Z';
  const monday = '2026-03-09T14:00:00.000Z';
  assert.equal(rollToEligibleWindow(friday, 'America/Phoenix').dueAt, '2026-03-06T15:00:00.000Z');
  assert.equal(rollToEligibleWindow(monday, 'America/Phoenix').dueAt, '2026-03-09T15:00:00.000Z');
  assert.equal(rollToEligibleWindow(friday, 'America/Los_Angeles').dueAt, '2026-03-06T16:00:00.000Z');
  assert.equal(rollToEligibleWindow(monday, 'America/Los_Angeles').dueAt, '2026-03-09T15:00:00.000Z');
  assert.equal(rollToEligibleWindow(friday, 'America/New_York').dueAt, friday);
  assert.equal(rollToEligibleWindow(monday, 'America/New_York').dueAt, monday);
});

test('P3 scenario 28/29: eligible local window rolls before, after, and across weekends', () => {
  const zone = 'America/Los_Angeles';
  assert.equal(rollToEligibleWindow('2026-01-05T15:30:00.000Z', zone).dueAt,
    '2026-01-05T16:00:00.000Z');
  assert.equal(rollToEligibleWindow('2026-01-05T16:00:00.000Z', zone).dueAt,
    '2026-01-05T16:00:00.000Z');
  assert.equal(rollToEligibleWindow('2026-01-06T01:00:00.000Z', zone).dueAt,
    '2026-01-06T16:00:00.000Z');
  assert.equal(rollToEligibleWindow('2026-01-10T18:00:00.000Z', zone).dueAt,
    '2026-01-12T16:00:00.000Z');
});

test('P3 scenario 34: gap chooses first valid instant and repeat chooses earlier occurrence', () => {
  assert.deepEqual(resolveLocalInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
    'America/New_York'), { instant: '2026-03-08T07:00:00.000Z', disambiguation: 'gap-forward' });
  assert.deepEqual(resolveLocalInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30,
    second: 30 }, 'America/New_York'),
  { instant: '2026-03-08T07:00:00.000Z', disambiguation: 'gap-forward' });
  assert.deepEqual(resolveLocalInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
    'America/New_York'), { instant: '2026-11-01T05:30:00.000Z', disambiguation: 'earlier-repeat' });
  assert.deepEqual(resolveLocalInstant({ year: 2011, month: 12, day: 30, hour: 12 },
    'Pacific/Apia'), { instant: '2011-12-30T10:00:00.000Z', disambiguation: 'gap-forward' });
});

test('P3 scenario 35: four-week expiry preserves local wall time across DST', () => {
  const expiry = calculateCampaignExpiry('2026-02-20T14:30:00.000Z', 'America/New_York');
  assert.equal(expiry.expiresAt, '2026-03-20T13:30:00.000Z');
  assert.equal(expiry.localAccepted, '2026-02-20T09:30:00');
  assert.equal(expiry.localExpiry, '2026-03-20T09:30:00');
  assert.equal(expiry.policyVersion, CIM_CAMPAIGN_POLICY_VERSION);
  assert.equal(expiry.cadencePolicyVersion, CIM_CADENCE_POLICY_VERSION);
  assert.equal(expiry.sendTime, '08:00');
  const gap = calculateCampaignExpiry('2026-02-08T07:30:00.000Z', 'America/New_York');
  assert.equal(gap.localExpiry, '2026-03-08T02:30:00');
  assert.equal(gap.expiresAt, '2026-03-08T07:00:00.000Z');
  assert.equal(gap.disambiguation, 'gap-forward');
  const repeat = calculateCampaignExpiry('2026-10-04T05:30:00.000Z', 'America/New_York');
  assert.equal(repeat.localExpiry, '2026-11-01T01:30:00');
  assert.equal(repeat.expiresAt, '2026-11-01T05:30:00.000Z');
  assert.equal(repeat.disambiguation, 'earlier-repeat');
});

test('P3 scenario 30–33/36: first follow-up uses two business days then accepted touches use two calendar days', () => {
  const base = { timezone: 'America/Phoenix', policyVersion: CIM_CAMPAIGN_POLICY_VERSION,
    cadencePolicyVersion: CIM_CADENCE_POLICY_VERSION_V2,
    expiryAt: '2026-02-01T00:00:00.000Z', sendTime: '09:00' };
  const initial = calculateNextCimSlot({ ...base, kind: 'initial',
    readyAt: '2026-01-05T14:00:00.000Z' });
  assert.equal(initial.dueAt, '2026-01-05T15:00:00.000Z');
  const one = calculateNextCimSlot({ ...base, kind: 'follow-up-1',
    priorAcceptedAt: '2026-01-05T18:00:00.000Z' });
  assert.equal(one.rawDueAt, '2026-01-07T16:00:00.000Z');
  const two = calculateNextCimSlot({ ...base, kind: 'follow-up-2',
    priorAcceptedAt: '2026-01-07T18:00:00.000Z' });
  assert.equal(two.rawDueAt, '2026-01-09T16:00:00.000Z');
  assert.equal(two.dueAt, '2026-01-09T16:00:00.000Z');
  const three = calculateNextCimSlot({ ...base, kind: 'follow-up-3',
    priorAcceptedAt: '2026-01-09T18:00:00.000Z' });
  assert.equal(three.rawDueAt, '2026-01-11T16:00:00.000Z');
  assert.equal(three.dueLocal, '2026-01-11T09:00:00');
  const later = calculateNextCimSlot({ ...base, kind: 'weekday-follow-up',
    priorAcceptedAt: '2026-01-11T18:00:00.000Z' });
  assert.equal(later.dueAt, '2026-01-13T16:00:00.000Z');
  assert.equal(later.slotKey, 'calendar:2026-01-13');
  assert.equal(calculateNextCimSlot({ ...base, kind: 'follow-up-1',
    priorOutcome: 'ambiguous', priorAcceptedAt: null }), null);
  assert.equal(calculateNextCimSlot({ ...base, kind: 'initial',
    readyAt: '2026-02-01T00:00:00.000Z' }), null);
  assert.throws(() => calculateNextCimSlot({ policyVersion: CIM_CAMPAIGN_POLICY_VERSION,
    cadencePolicyVersion: CIM_CADENCE_POLICY_VERSION_V2,
    timezone: 'America/Phoenix', kind: 'follow-up-1',
    priorAcceptedAt: '2026-01-05T18:00:00.000Z' }), /expiry/i);
  assert.throws(() => calculateNextCimSlot({ ...base, policyVersion: 'legacy-auto',
    kind: 'initial', readyAt: '2026-01-05T14:00:00.000Z' }));
});

test('P3 approved cadence crosses weekends and DST without weekday rolling after follow-up one', () => {
  const base = { timezone: 'America/New_York', policyVersion: CIM_CAMPAIGN_POLICY_VERSION,
    cadencePolicyVersion: CIM_CADENCE_POLICY_VERSION_V2, expiryAt: '2026-11-20T13:00:00.000Z', sendTime: '08:00' };
  const first = calculateNextCimSlot({ ...base, kind: 'follow-up-1',
    priorAcceptedAt: '2026-10-30T19:00:00.000Z' });
  assert.equal(first.dueLocal, '2026-11-03T08:00:00');
  assert.equal(first.dueAt, '2026-11-03T13:00:00.000Z');
  const weekend = calculateNextCimSlot({ ...base, kind: 'follow-up-3',
    priorAcceptedAt: '2026-10-30T12:00:00.000Z' });
  assert.equal(weekend.dueLocal, '2026-11-01T08:00:00');
  assert.equal(weekend.dueAt, '2026-11-01T13:00:00.000Z');
});

const v3Base = { policyVersion: CIM_CAMPAIGN_POLICY_VERSION,
  cadencePolicyVersion: CIM_CADENCE_POLICY_VERSION_V3, timezone: 'America/Los_Angeles',
  expiryAt: '2027-06-01T00:00:00.000Z', sendTime: '08:00' };

function localWeekday(dueLocal) {
  return new Date(`${dueLocal.slice(0, 10)}T00:00:00.000Z`).getUTCDay();
}

test('cadence versions: v3 is stamped on new acceptances and v2 stays supported', () => {
  assert.equal(CIM_CADENCE_POLICY_VERSION_V2, 'deal-hunter-cim-cadence-v2');
  assert.equal(CIM_CADENCE_POLICY_VERSION_V3, 'deal-hunter-cim-cadence-v3');
  assert.equal(CIM_CADENCE_POLICY_VERSION, CIM_CADENCE_POLICY_VERSION_V3);
  assert.deepEqual([...SUPPORTED_CIM_CADENCE_POLICY_VERSIONS],
    ['deal-hunter-cim-cadence-v2', 'deal-hunter-cim-cadence-v3']);
  assert.equal(Object.isFrozen(SUPPORTED_CIM_CADENCE_POLICY_VERSIONS), true);
});

test('v3 follow-up-2 accepted Thursday 2026-11-05 10:00 is due Monday 2026-11-09 08:00', () => {
  const slot = calculateNextCimSlot({ ...v3Base, kind: 'follow-up-2',
    priorAcceptedAt: '2026-11-05T18:00:00.000Z' });
  assert.equal(slot.dueLocal, '2026-11-09T08:00:00');
  assert.equal(slot.dueAt, '2026-11-09T16:00:00.000Z');
  assert.equal(slot.rawDueAt, '2026-11-09T16:00:00.000Z');
  assert.equal(slot.slotKey, 'follow-up-2');
  assert.equal(slot.cadencePolicyVersion, CIM_CADENCE_POLICY_VERSION_V3);
  const three = calculateNextCimSlot({ ...v3Base, kind: 'follow-up-3',
    priorAcceptedAt: '2026-11-05T18:00:00.000Z' });
  assert.equal(three.dueLocal, '2026-11-09T08:00:00');
  assert.equal(three.slotKey, 'follow-up-3');
});

test('v3 weekday-follow-up accepted Friday 2026-11-06 09:00 is due Tuesday 2026-11-10 08:00 with slot key business:2026-11-10', () => {
  const slot = calculateNextCimSlot({ ...v3Base, kind: 'weekday-follow-up',
    priorAcceptedAt: '2026-11-06T17:00:00.000Z' });
  assert.equal(slot.dueLocal, '2026-11-10T08:00:00');
  assert.equal(slot.dueAt, '2026-11-10T16:00:00.000Z');
  assert.equal(slot.slotKey, 'business:2026-11-10');
  assert.equal(slot.cadencePolicyVersion, CIM_CADENCE_POLICY_VERSION_V3);
});

test('v3 uses local date for late-Friday acceptance (2026-11-06T23:30 local) → Tuesday 2026-11-10 08:00', () => {
  // 23:30 Friday in Los Angeles is already Saturday 07:30 in UTC.
  const slot = calculateNextCimSlot({ ...v3Base, kind: 'follow-up-1',
    priorAcceptedAt: '2026-11-07T07:30:00.000Z' });
  assert.equal(slot.dueLocal, '2026-11-10T08:00:00');
  assert.equal(slot.dueAt, '2026-11-10T16:00:00.000Z');
});

test('v3 never schedules Saturday or Sunday across a full 28-day sequence', () => {
  const initialAcceptedAt = '2026-11-02T17:00:00.000Z'; // Monday 09:00 America/Los_Angeles
  const expiry = calculateCampaignExpiry(initialAcceptedAt, 'America/Los_Angeles');
  assert.equal(expiry.cadencePolicyVersion, CIM_CADENCE_POLICY_VERSION_V3);
  assert.equal(expiry.localExpiry, '2026-11-30T09:00:00');
  assert.equal(expiry.expiresAt, '2026-11-30T17:00:00.000Z');
  const next = { initial: 'follow-up-1', 'follow-up-1': 'follow-up-2',
    'follow-up-2': 'follow-up-3', 'follow-up-3': 'weekday-follow-up',
    'weekday-follow-up': 'weekday-follow-up' };
  const sequence = [];
  let kind = 'initial';
  let acceptedAt = initialAcceptedAt;
  for (;;) {
    kind = next[kind];
    const slot = calculateNextCimSlot({ ...v3Base, cadencePolicyVersion: expiry.cadencePolicyVersion,
      kind, priorAcceptedAt: acceptedAt, expiryAt: expiry.expiresAt });
    if (!slot) break;
    sequence.push(slot);
    acceptedAt = slot.dueAt;
    assert.ok(sequence.length <= 20, 'sequence must terminate at expiry');
  }
  for (const slot of sequence) {
    const day = localWeekday(slot.dueLocal);
    assert.ok(day >= 1 && day <= 5, `${slot.dueLocal} must be Monday to Friday`);
    assert.equal(slot.dueLocal.slice(11), '08:00:00');
  }
  assert.deepEqual(sequence.map((slot) => slot.dueLocal.slice(0, 10)), [
    '2026-11-04', '2026-11-06', '2026-11-10', '2026-11-12', '2026-11-16',
    '2026-11-18', '2026-11-20', '2026-11-24', '2026-11-26', '2026-11-30',
  ]);
  assert.deepEqual(sequence.map((slot) => slot.slotKey), [
    'follow-up-1', 'follow-up-2', 'follow-up-3', 'business:2026-11-12', 'business:2026-11-16',
    'business:2026-11-18', 'business:2026-11-20', 'business:2026-11-24', 'business:2026-11-26',
    'business:2026-11-30',
  ]);
  assert.equal(sequence.at(-1).dueAt, '2026-11-30T16:00:00.000Z');
});

test('v3 spring-forward in America/New_York keeps 08:00 local', () => {
  // Thursday 2027-03-11 10:00 EST; clocks spring forward Sunday 2027-03-14.
  const slot = calculateNextCimSlot({ ...v3Base, timezone: 'America/New_York',
    kind: 'weekday-follow-up', priorAcceptedAt: '2027-03-11T15:00:00.000Z' });
  assert.equal(slot.dueLocal, '2027-03-15T08:00:00');
  assert.equal(slot.dueAt, '2027-03-15T12:00:00.000Z');
  assert.equal(slot.slotKey, 'business:2027-03-15');
});

test('v3 DST transitions in America/Los_Angeles keep 08:00 local', () => {
  const spring = calculateNextCimSlot({ ...v3Base, kind: 'follow-up-2',
    priorAcceptedAt: '2027-03-11T18:00:00.000Z' }); // Thursday 10:00 PST
  assert.equal(spring.dueLocal, '2027-03-15T08:00:00');
  assert.equal(spring.dueAt, '2027-03-15T15:00:00.000Z');
  const fall = calculateNextCimSlot({ ...v3Base, kind: 'follow-up-2',
    priorAcceptedAt: '2026-10-30T17:00:00.000Z' }); // Friday 10:00 PDT, fall back Sunday 11-01
  assert.equal(fall.dueLocal, '2026-11-03T08:00:00');
  assert.equal(fall.dueAt, '2026-11-03T16:00:00.000Z');
});

test('v3 in America/Phoenix has no DST shift', () => {
  const phoenix = { ...v3Base, timezone: 'America/Phoenix' };
  const march = calculateNextCimSlot({ ...phoenix, kind: 'follow-up-2',
    priorAcceptedAt: '2027-03-11T17:00:00.000Z' }); // Thursday 10:00 MST
  assert.equal(march.dueLocal, '2027-03-15T08:00:00');
  assert.equal(march.dueAt, '2027-03-15T15:00:00.000Z');
  const november = calculateNextCimSlot({ ...phoenix, kind: 'follow-up-2',
    priorAcceptedAt: '2026-11-05T17:00:00.000Z' }); // Thursday 10:00 MST
  assert.equal(november.dueLocal, '2026-11-09T08:00:00');
  assert.equal(november.dueAt, '2026-11-09T15:00:00.000Z');
});

test('v3 returns null at or after expiry', () => {
  const args = { ...v3Base, kind: 'follow-up-2', priorAcceptedAt: '2026-11-05T18:00:00.000Z' };
  assert.equal(calculateNextCimSlot({ ...args, expiryAt: '2026-11-09T16:00:00.000Z' }), null);
  assert.equal(calculateNextCimSlot({ ...args, expiryAt: '2026-11-09T15:59:59.999Z' }), null);
  assert.equal(calculateNextCimSlot({ ...args, expiryAt: '2026-11-09T16:00:00.001Z' }).dueAt,
    '2026-11-09T16:00:00.000Z');
});

test('v2-stamped campaign keeps v2 calendar-day dates and calendar: slot keys', () => {
  const v2 = { ...v3Base, cadencePolicyVersion: CIM_CADENCE_POLICY_VERSION_V2 };
  const one = calculateNextCimSlot({ ...v2, kind: 'follow-up-1',
    priorAcceptedAt: '2026-11-05T18:00:00.000Z' });
  assert.equal(one.dueLocal, '2026-11-09T08:00:00', 'v2 follow-up-1 already used business days');
  const two = calculateNextCimSlot({ ...v2, kind: 'follow-up-2',
    priorAcceptedAt: '2026-11-05T18:00:00.000Z' });
  assert.equal(two.dueLocal, '2026-11-07T08:00:00');
  assert.equal(two.dueAt, '2026-11-07T16:00:00.000Z');
  assert.equal(two.cadencePolicyVersion, CIM_CADENCE_POLICY_VERSION_V2);
  const repeating = calculateNextCimSlot({ ...v2, kind: 'weekday-follow-up',
    priorAcceptedAt: '2026-11-06T17:00:00.000Z' });
  assert.equal(repeating.dueLocal, '2026-11-08T08:00:00');
  assert.equal(repeating.slotKey, 'calendar:2026-11-08');
  assert.equal(repeating.cadencePolicyVersion, CIM_CADENCE_POLICY_VERSION_V2);
});

test('unknown cadencePolicyVersion throws', () => {
  for (const cadencePolicyVersion of ['deal-hunter-cim-cadence-v1', 'deal-hunter-cim-cadence-v4',
    'DEAL-HUNTER-CIM-CADENCE-V3', '', null, 3]) {
    for (const kind of ['initial', 'follow-up-1', 'weekday-follow-up']) {
      assert.throws(() => calculateNextCimSlot({ ...v3Base, cadencePolicyVersion, kind,
        readyAt: '2026-11-05T18:00:00.000Z', priorAcceptedAt: '2026-11-05T18:00:00.000Z' }),
      /^Error: Unknown CIM cadence policy\.$/, `${kind} with ${String(cadencePolicyVersion)}`);
    }
  }
});

test('missing cadencePolicyVersion for a follow-up throws', () => {
  const { cadencePolicyVersion: _omitted, ...withoutVersion } = v3Base;
  for (const kind of ['follow-up-1', 'follow-up-2', 'follow-up-3', 'weekday-follow-up']) {
    assert.throws(() => calculateNextCimSlot({ ...withoutVersion, kind,
      priorAcceptedAt: '2026-11-05T18:00:00.000Z' }), /^Error: Unknown CIM cadence policy\.$/);
    assert.throws(() => calculateNextCimSlot({ ...withoutVersion, kind,
      priorOutcome: 'ambiguous', priorAcceptedAt: null }), /^Error: Unknown CIM cadence policy\.$/,
    'the version is checked before the outcome short-circuit');
  }
  const initial = calculateNextCimSlot({ ...withoutVersion, kind: 'initial',
    readyAt: '2026-11-05T18:00:00.000Z' });
  assert.equal(initial.dueAt, '2026-11-05T18:00:00.000Z');
  assert.equal(initial.cadencePolicyVersion, CIM_CADENCE_POLICY_VERSION);
});

const derived = (ianaTimezone, state) => ({ eligible: true, ianaTimezone, state,
  resolverVersion: 'target-state-v1' });
const ineligible = (reasonCode) => ({ eligible: false, reasonCode,
  resolverVersion: 'target-state-v1' });

test('target-state resolver maps each of the six states by code', () => {
  const zones = { NY: 'America/New_York', NJ: 'America/New_York', CT: 'America/New_York',
    CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', AZ: 'America/Phoenix' };
  for (const [code, zone] of Object.entries(zones)) {
    assert.deepEqual(resolveLocationTimezone({ state: code }), derived(zone, code));
    assert.deepEqual(resolveLocationTimezone({ state: code.toLowerCase() }), derived(zone, code));
  }
  assert.equal(TIMEZONE_RESOLVER_VERSION, 'target-state-v1');
  assert.deepEqual(TARGET_STATE_TIMEZONES, zones);
  assert.equal(Object.isFrozen(TARGET_STATE_TIMEZONES), true);
  assert.equal(Object.isFrozen(TIMEZONE_EXCEPTIONS), true);
});

test('target-state resolver maps each of the six states by full name', () => {
  const names = { 'New York': ['NY', 'America/New_York'], 'New Jersey': ['NJ', 'America/New_York'],
    Connecticut: ['CT', 'America/New_York'], California: ['CA', 'America/Los_Angeles'],
    Nevada: ['NV', 'America/Los_Angeles'], Arizona: ['AZ', 'America/Phoenix'] };
  for (const [name, [code, zone]] of Object.entries(names)) {
    assert.deepEqual(resolveLocationTimezone({ state: name }), derived(zone, code));
  }
  assert.deepEqual(resolveLocationTimezone({ state: '  new   york ' }),
    derived('America/New_York', 'NY'));
});

test('target-state resolver reads a state named only in the location text', () => {
  assert.deepEqual(resolveLocationTimezone({ location: 'Scottsdale, Arizona' }),
    derived('America/Phoenix', 'AZ'));
  assert.deepEqual(resolveLocationTimezone({ state: '', location: 'Albany, NY' }),
    derived('America/New_York', 'NY'));
  assert.deepEqual(resolveLocationTimezone({ state: 'NY', location: 'Albany, New York' }),
    derived('America/New_York', 'NY'));
});

test('target-state resolver treats disagreeing inputs as ambiguous even when zones match', () => {
  assert.deepEqual(resolveLocationTimezone({ state: 'CA', location: 'Reno, NV' }),
    ineligible('timezone_ambiguous'));
  assert.deepEqual(resolveLocationTimezone({ state: 'TX', location: 'Reno, NV' }),
    ineligible('timezone_ambiguous'));
  assert.deepEqual(resolveLocationTimezone({ state: 'NY/NJ' }), ineligible('timezone_ambiguous'));
});

test('target-state resolver refuses the exception towns', () => {
  for (const location of ['West Wendover, NV', 'JACKPOT, Nevada', 'Window Rock, AZ',
    'Tuba City, AZ', 'Kayenta, AZ', 'Chinle, AZ', 'Navajo County, AZ']) {
    assert.deepEqual(resolveLocationTimezone({ location }), ineligible('timezone_ambiguous'),
      location);
  }
  assert.deepEqual(resolveLocationTimezone({ state: 'NV', location: 'West  Wendover' }),
    ineligible('timezone_ambiguous'));
});

test('target-state resolver reports missing for out-of-scope or empty inputs', () => {
  assert.deepEqual(resolveLocationTimezone({ state: 'TX' }), ineligible('timezone_missing'));
  assert.deepEqual(resolveLocationTimezone({ state: 'TX', location: 'Austin, TX' }),
    ineligible('timezone_missing'));
  assert.deepEqual(resolveLocationTimezone({}), ineligible('timezone_missing'));
  assert.deepEqual(resolveLocationTimezone({ state: '  ', location: null }),
    ineligible('timezone_missing'));
  assert.deepEqual(resolveLocationTimezone(), ineligible('timezone_missing'));
});

test('timezone dataset digest is the sha256 of the canonical mapping', () => {
  assert.equal(TIMEZONE_DATASET_DIGEST, createHash('sha256').update(JSON.stringify({
    zones: TARGET_STATE_TIMEZONES, exceptions: TIMEZONE_EXCEPTIONS })).digest('hex'));
  assert.notEqual(TIMEZONE_DATASET_DIGEST, '0'.repeat(64));
  assert.deepEqual(TIMEZONE_EXCEPTIONS, {
    NV: ['west wendover', 'jackpot'],
    AZ: ['navajo', 'window rock', 'tuba city', 'kayenta', 'chinle'],
  });
});

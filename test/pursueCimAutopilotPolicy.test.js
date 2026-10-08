import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeterministicClock,
  createDeterministicNonceSource,
} from './fixtures/pursueCimHarness.js';
import {
  validateIanaTimezone,
  resolveOpportunityTimezone,
  selectCampaignTimezoneAuthority,
  evaluateCampaignTimezoneChange,
} from '../server/services/opportunityTimezone.js';
import {
  CIM_CAMPAIGN_POLICY_VERSION,
  CIM_CADENCE_POLICY_VERSION,
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
  assert.equal(resolveOpportunityTimezone({ opportunityId: 'opp-1', location: { state: 'CA' } }).reasonCode,
    'timezone_ambiguous');
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
    timezone: 'America/Phoenix', kind: 'follow-up-1',
    priorAcceptedAt: '2026-01-05T18:00:00.000Z' }), /expiry/i);
  assert.throws(() => calculateNextCimSlot({ ...base, policyVersion: 'legacy-auto',
    kind: 'initial', readyAt: '2026-01-05T14:00:00.000Z' }));
});

test('P3 approved cadence crosses weekends and DST without weekday rolling after follow-up one', () => {
  const base = { timezone: 'America/New_York', policyVersion: CIM_CAMPAIGN_POLICY_VERSION,
    expiryAt: '2026-11-20T13:00:00.000Z', sendTime: '08:00' };
  const first = calculateNextCimSlot({ ...base, kind: 'follow-up-1',
    priorAcceptedAt: '2026-10-30T19:00:00.000Z' });
  assert.equal(first.dueLocal, '2026-11-03T08:00:00');
  assert.equal(first.dueAt, '2026-11-03T13:00:00.000Z');
  const weekend = calculateNextCimSlot({ ...base, kind: 'follow-up-3',
    priorAcceptedAt: '2026-10-30T12:00:00.000Z' });
  assert.equal(weekend.dueLocal, '2026-11-01T08:00:00');
  assert.equal(weekend.dueAt, '2026-11-01T13:00:00.000Z');
});

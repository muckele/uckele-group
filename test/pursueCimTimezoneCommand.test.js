import assert from 'node:assert/strict';
import test from 'node:test';
import { appendDerivedOpportunityTimezoneRevision, appendExplicitOpportunityTimezoneRevision,
  appendStructuredSourceTimezoneRevision } from '../server/services/opportunityTimezoneRevision.js';

import { TIMEZONE_DATASET_DIGEST, derivedTimezoneEvidenceDigest, timezoneEvidenceDigest }
  from '../server/services/opportunityTimezone.js';

const key = 'a5bf9b63-495b-40f4-865f-942767d851b5';

test('P3 explicit timezone command owns digest, actor, timestamp and storage transition', async () => {
  const commands = [];
  const storage = {
    getCurrentDealHunterOpportunity: async () => ({ opportunity_id: 'opp-1', status: 'active' }),
    appendOpportunityTimezoneRevision: async (command) => {
      commands.push(command);
      return { applied: true, replay: false, staleRevision: false,
        timezoneRevision: { revision: 1, state: 'verified', iana_timezone: command.ianaTimezone } };
    },
  };
  const result = await appendExplicitOpportunityTimezoneRevision({ storage, opportunityId: 'opp-1',
    input: { ianaTimezone: 'America/New_York', evidenceId: 'owner-review-1',
      expectedPriorRevision: 0, idempotencyKey: key, note: 'Reviewed location.' },
    actor: 'admin', now: '2026-09-29T03:00:00.000Z' });
  assert.deepEqual(result, { ok: true, status: 200, applied: true, replay: false,
    timezone: { revision: 1, state: 'verified', ianaTimezone: 'America/New_York' } });
  assert.equal(commands[0].evidenceType, 'operator-verified');
  assert.match(commands[0].evidenceDigest, /^[0-9a-f]{64}$/);
  assert.match(commands[0].datasetDigest, /^[0-9a-f]{64}$/);
  assert.equal(commands[0].actor, 'admin');
  assert.equal(commands[0].now, '2026-09-29T03:00:00.000Z');
});

test('P3 explicit command rejects derived claims, invalid zones, and stale revisions', async () => {
  let writes = 0;
  const storage = {
    getCurrentDealHunterOpportunity: async () => ({ opportunity_id: 'opp-1', status: 'active' }),
    appendOpportunityTimezoneRevision: async () => {
      writes += 1;
      return { applied: false, replay: false, staleRevision: true,
        timezoneRevision: { revision: 2 } };
    },
  };
  const base = { ianaTimezone: 'America/Phoenix', evidenceId: 'owner-review-2',
    expectedPriorRevision: 1, idempotencyKey: key };
  for (const input of [{ ...base, state: 'derived' }, { ...base, resolverVersion: 'fake' },
    { ...base, evidenceType: 'operator-documented' },
    { ...base, ianaTimezone: 'PST' }]) {
    const result = await appendExplicitOpportunityTimezoneRevision({ storage, opportunityId: 'opp-1',
      input, actor: 'admin', now: '2026-09-29T03:00:00.000Z' });
    assert.equal(result.status, 400);
  }
  assert.equal(writes, 0);
  const stale = await appendExplicitOpportunityTimezoneRevision({ storage, opportunityId: 'opp-1',
    input: base, actor: 'admin', now: '2026-09-29T03:00:00.000Z' });
  assert.deepEqual(stale, { ok: false, status: 409, reasonCode: 'stale_timezone_revision',
    currentRevision: 2 });
});

test('P3 structured source writer creates a source-marked selectable revision without client authority', async () => {
  let written;
  const storage = { getDealHunterOpportunity: async () => ({ opportunity_id: 'opp-1' }),
    appendOpportunityTimezoneRevision: async (command) => {
      written = command;
      return { applied: true, replay: false, staleRevision: false,
        timezoneRevision: { revision: 1, state: 'verified', iana_timezone: command.ianaTimezone } };
    } };
  const result = await appendStructuredSourceTimezoneRevision({ storage, opportunityId: 'opp-1',
    source: { opportunityId: 'opp-1', ianaTimezone: 'America/New_York',
      sourceSystem: 'deal-os-export', sourceRecordId: 'row-1', sourceVersion: 'v1',
      evidenceId: 'row-1', evidenceDigest: 'a'.repeat(64) },
    expectedPriorRevision: 0, now: '2026-09-29T03:00:00.000Z' });
  assert.equal(result.timezone.revision, 1);
  assert.equal(written.evidenceType, 'structured-source');
  assert.equal(written.resolverVersion, 'structured-source-v1');
  assert.equal(written.actor, 'structured-source-timezone');
  assert.match(written.evidenceDigest, /^[0-9a-f]{64}$/);
});

function derivedStorage({ latest = null, reads, append } = {}) {
  const state = { reads: 0, commands: [] };
  const sequence = reads || [latest];
  return { state, storage: {
    readPursuitEnrollmentAuthority: async () => {
      const timezone = sequence[Math.min(state.reads, sequence.length - 1)];
      state.reads += 1;
      return { timezone, activation: null, globalAuthorityRevision: 1 };
    },
    appendOpportunityTimezoneRevision: async (command) => {
      state.commands.push(command);
      return append ? append(command) : { applied: true, replay: false, staleRevision: false,
        timezoneRevision: { revision: command.expectedPriorRevision + 1, state: command.state,
          iana_timezone: command.ianaTimezone } };
    },
  } };
}
const derivedInput = { opportunityId: 'opp-1', state: 'AZ', location: 'Scottsdale, AZ',
  now: '2026-11-02T15:00:00.000Z' };

test('derived timezone writer appends a derived target-state revision with exact fields', async () => {
  const { storage, state } = derivedStorage({ latest: null });
  const result = await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput });
  assert.deepEqual(result, { written: true, reason: 'written' });
  assert.equal(state.commands.length, 1);
  const [command] = state.commands;
  assert.equal(command.opportunityId, 'opp-1');
  assert.equal(command.expectedPriorRevision, 0);
  assert.equal(command.state, 'derived');
  assert.equal(command.ianaTimezone, 'America/Phoenix');
  assert.equal(command.evidenceType, 'target-state');
  assert.equal(command.evidenceId, 'target-state:AZ');
  assert.equal(command.evidenceDigest, derivedTimezoneEvidenceDigest({ opportunityId: 'opp-1',
    state: 'AZ', location: 'Scottsdale, AZ' }));
  assert.notEqual(command.evidenceDigest, timezoneEvidenceDigest({ opportunityId: 'opp-1',
    ianaTimezone: 'America/Phoenix', evidenceType: 'target-state', evidenceId: 'target-state:AZ' }),
  'the digest covers the inputs, not the derived result');
  assert.equal(command.resolverVersion, 'target-state-v1');
  assert.equal(command.datasetDigest, TIMEZONE_DATASET_DIGEST);
  assert.equal(command.actor, 'system-timezone-resolver');
  assert.equal(command.now, '2026-11-02T15:00:00.000Z');
  assert.match(command.idempotencyKey, /^[0-9a-f]{64}$/);
});

test('derived timezone writer builds on the latest missing or ambiguous revision', async () => {
  const { storage, state } = derivedStorage({ latest: { revision: 2, state: 'ambiguous',
    iana_timezone: null, evidence_digest: 'f'.repeat(64) } });
  assert.equal((await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput })).written, true);
  assert.equal(state.commands[0].expectedPriorRevision, 2);
});

test('derived timezone writer is a no-op when latest revision is verified', async () => {
  const { storage, state } = derivedStorage({ latest: { revision: 1, state: 'verified',
    iana_timezone: 'America/Denver', evidence_digest: 'a'.repeat(64) } });
  const result = await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput });
  assert.deepEqual(result, { written: false, reason: 'timezone_already_set' });
  assert.equal(state.commands.length, 0);
});

test('derived timezone writer is a no-op when latest is derived', async () => {
  const { storage, state } = derivedStorage({ latest: { revision: 1, state: 'derived',
    iana_timezone: 'America/Phoenix', evidence_digest: 'a'.repeat(64) } });
  const result = await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput });
  assert.deepEqual(result, { written: false, reason: 'timezone_already_set' });
  assert.equal(state.commands.length, 0);
});

test('derived timezone evidence digest covers the normalized inputs and the resolver version', () => {
  const digest = (state, location, opportunityId = 'opp-1') =>
    derivedTimezoneEvidenceDigest({ opportunityId, state, location });
  assert.match(digest('AZ', 'Scottsdale, AZ'), /^[0-9a-f]{64}$/);
  // Whitespace and case do not change the normalized inputs; a full state name normalizes to its code.
  assert.equal(digest(' az ', '  scottsdale,   AZ '), digest('AZ', 'Scottsdale, AZ'));
  assert.equal(digest('Arizona', 'Scottsdale, AZ'), digest('AZ', 'Scottsdale, AZ'));
  // Different inputs that derive the same zone are different evidence.
  assert.notEqual(digest('AZ', 'Tucson, AZ'), digest('AZ', 'Scottsdale, AZ'));
  assert.notEqual(digest('', 'Scottsdale, AZ'), digest('AZ', 'Scottsdale, AZ'));
  assert.notEqual(digest('AZ', 'Scottsdale, AZ', 'opp-2'), digest('AZ', 'Scottsdale, AZ'));
});

/** A stateful revision log so two calls see each other's writes. */
function persistentDerivedStorage({ conflictOnce = null } = {}) {
  const log = [];
  const state = { reads: 0, commands: [] };
  const latest = () => log.at(-1) || null;
  return { log, state, storage: {
    readPursuitEnrollmentAuthority: async () => { state.reads += 1; return { timezone: latest() }; },
    appendOpportunityTimezoneRevision: async (command) => {
      state.commands.push(command);
      if (conflictOnce) {
        // Another writer lands a non-sendable revision first.
        log.push(conflictOnce); conflictOnce = null;
        return { applied: false, replay: false, staleRevision: true, timezoneRevision: latest() };
      }
      if (Number(latest()?.revision ?? 0) !== command.expectedPriorRevision) {
        return { applied: false, replay: false, staleRevision: true, timezoneRevision: latest() };
      }
      log.push({ revision: command.expectedPriorRevision + 1, state: command.state,
        iana_timezone: command.ianaTimezone, evidence_digest: command.evidenceDigest });
      return { applied: true, replay: false, staleRevision: false, timezoneRevision: latest() };
    },
  } };
}

test('two derived calls with identical inputs: the second sees the derived revision and writes nothing', async () => {
  const { storage, state, log } = persistentDerivedStorage();
  assert.deepEqual(await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput }),
    { written: true, reason: 'written' });
  assert.deepEqual(await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput }),
    { written: false, reason: 'timezone_already_set' });
  assert.equal(state.commands.length, 1);
  assert.equal(log.length, 1);
  assert.equal(log[0].evidence_digest, derivedTimezoneEvidenceDigest(derivedInput));
});

test('two derived calls with identical inputs: after a stale conflict the second builds on the latest revision', async () => {
  const { storage, state, log } = persistentDerivedStorage({ conflictOnce: { revision: 1, state: 'missing',
    iana_timezone: null, evidence_digest: 'c'.repeat(64) } });
  assert.deepEqual(await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput }),
    { written: false, reason: 'stale_timezone_revision' });
  assert.deepEqual(await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput }),
    { written: true, reason: 'written' });
  assert.equal(state.commands.length, 2);
  assert.equal(state.commands[1].expectedPriorRevision, 1);
  assert.equal(state.commands[0].evidenceDigest, state.commands[1].evidenceDigest, 'same inputs, same evidence');
  assert.equal(log.at(-1).state, 'derived');
  assert.equal(log.at(-1).revision, 2);
});

test('derived timezone writer is a no-op on an identical evidence digest', async () => {
  const evidenceDigest = derivedTimezoneEvidenceDigest({ opportunityId: 'opp-1', state: 'AZ',
    location: 'Scottsdale, AZ' });
  const { storage, state } = derivedStorage({ latest: { revision: 3, state: 'ambiguous',
    iana_timezone: null, evidence_digest: evidenceDigest } });
  const result = await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput });
  assert.deepEqual(result, { written: false, reason: 'same_evidence' });
  assert.equal(state.commands.length, 0);
});

test('derived timezone writer writes nothing when the resolver is not eligible', async () => {
  for (const [input, reason] of [[{ state: 'TX', location: 'Austin, TX' }, 'timezone_missing'],
    [{ state: 'NV', location: 'West Wendover, NV' }, 'timezone_ambiguous']]) {
    const { storage, state } = derivedStorage({ latest: null });
    const result = await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput, ...input });
    assert.deepEqual(result, { written: false, reason });
    assert.equal(state.commands.length, 0);
  }
});

test('derived timezone writer on a stale revision conflict re-reads once then returns written:false', async () => {
  const { storage, state } = derivedStorage({
    reads: [null, { revision: 1, state: 'missing', iana_timezone: null, evidence_digest: 'c'.repeat(64) }],
    append: async () => ({ applied: false, replay: false, staleRevision: true,
      timezoneRevision: { revision: 1 } }),
  });
  const result = await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput });
  assert.deepEqual(result, { written: false, reason: 'stale_timezone_revision' });
  assert.equal(state.reads, 2);
  assert.equal(state.commands.length, 1);
});

test('derived timezone writer yields to an owner revision that landed during the conflict', async () => {
  const { storage, state } = derivedStorage({
    reads: [null, { revision: 1, state: 'verified', iana_timezone: 'America/Denver',
      evidence_digest: 'c'.repeat(64) }],
    append: async () => ({ applied: false, replay: false, staleRevision: true,
      timezoneRevision: { revision: 1 } }),
  });
  const result = await appendDerivedOpportunityTimezoneRevision({ storage, ...derivedInput });
  assert.deepEqual(result, { written: false, reason: 'timezone_already_set' });
  assert.equal(state.reads, 2);
  assert.equal(state.commands.length, 1);
});

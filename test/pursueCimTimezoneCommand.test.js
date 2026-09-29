import assert from 'node:assert/strict';
import test from 'node:test';
import { appendExplicitOpportunityTimezoneRevision,
  appendStructuredSourceTimezoneRevision } from '../server/services/opportunityTimezoneRevision.js';

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

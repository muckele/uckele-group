import assert from 'node:assert/strict';
import test from 'node:test';
import { runDealHunterSheetSync } from '../server/services/dealHunterSheetSync.js';

const now = new Date('2026-11-03T15:30:00.000Z');

function healthyReview(overrides = {}) {
  return {
    sources: [
      { id: 'sheet-0', name: 'Sheet', fetched: true, required: true, sourceRole: 'required-primary', rowCount: 40 },
      { id: 'sheet-1', name: 'Sheet 2', fetched: true, required: true, sourceRole: 'required-primary', rowCount: 12 },
    ],
    ...overrides,
  };
}

function healthyRefresh(extra = {}) {
  return async () => ({
    ok: true,
    status: 200,
    review: healthyReview(),
    counts: { considered: 3, scored: 1, skipped: 2, failed: 0 },
    currentFingerprints: { 'opp-1': 'fp-1', 'opp-2': 'fp-2', 'opp-3': 'fp-3' },
    ...extra,
  });
}

function storageWithGroups(groups) {
  return {
    async listDealHunterOpportunityScoreFingerprints(ids) {
      return ids.map((id) => ({ opportunity_id: id, criteria_group: groups[id] ?? null }));
    },
  };
}

test('healthy sync calls autoPursue once with currentFingerprints and triggeredBy sheet-sync', async () => {
  const calls = [];
  const storage = storageWithGroups({ 'opp-1': 'auto', 'opp-2': 'auto', 'opp-3': 'review' });
  let tick = 1000;
  const result = await runDealHunterSheetSync({
    storage,
    now,
    triggeredBy: 'scheduler',
    clock: () => (tick += 250),
    refresh: healthyRefresh(),
    autoPursue: async (input) => {
      calls.push(input);
      return { ok: true, status: 200, mode: 'shadow', runKey: 'auto-pursue:2026-11-03:shadow:0', commands: 0,
        reason: 'warmup_not_ready', duplicateInvocation: false, skipped: [{ opportunityId: 'opp-1' }] };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].triggeredBy, 'sheet-sync');
  assert.equal(calls[0].storage, storage);
  assert.equal(calls[0].now, now);
  assert.deepEqual(calls[0].currentFingerprints, { 'opp-1': 'fp-1', 'opp-2': 'fp-2', 'opp-3': 'fp-3' });
  assert.equal(result.ok, true);
  assert.equal(result.requiredSourcesHealthy, true);
  assert.equal(result.scoredCount, 3);
  assert.deepEqual(result.groupCounts, { auto: 2, review: 1 });
  assert.deepEqual(result.sheets, [
    { sourceId: 'sheet-0', fetched: true, rowCount: 40, error: null },
    { sourceId: 'sheet-1', fetched: true, rowCount: 12, error: null },
  ]);
  assert.equal(result.durationMs, 250);
  assert.deepEqual(result.autoPursue, { runKey: 'auto-pursue:2026-11-03:shadow:0', status: 200, mode: 'shadow',
    commands: 0, reason: 'warmup_not_ready' });
});

test('sync records a duplicate invocation and the decisions count from automatic Pursue', async () => {
  const result = await runDealHunterSheetSync({
    storage: storageWithGroups({ 'opp-1': 'auto' }), now, refresh: healthyRefresh(),
    autoPursue: async () => ({ ok: true, status: 200, mode: 'canary', runKey: 'k', commands: 2,
      duplicateInvocation: true, reason: 'run_in_progress' }),
  });
  assert.deepEqual(result.autoPursue, { runKey: 'k', status: 200, mode: 'canary', commands: 2,
    reason: 'run_in_progress', duplicateInvocation: true });
});

test('unhealthy required sheet records autoPursue skipped required_source_failed and ok false', async () => {
  let pursued = 0;
  const result = await runDealHunterSheetSync({
    storage: storageWithGroups({}),
    now,
    refresh: async () => ({
      ok: true,
      status: 200,
      review: healthyReview({
        sources: [
          { id: 'sheet-0', fetched: true, required: true, sourceRole: 'required-primary', rowCount: 40 },
          { id: 'sheet-1', fetched: false, required: true, sourceRole: 'required-primary', rowCount: 0, error: 'HTTP 500' },
        ],
      }),
      currentFingerprints: { 'opp-1': 'fp-1' },
    }),
    autoPursue: async () => { pursued += 1; return {}; },
  });
  assert.equal(pursued, 0);
  assert.equal(result.ok, false);
  assert.equal(result.requiredSourcesHealthy, false);
  assert.deepEqual(result.autoPursue, { skipped: 'required_source_failed' });
  assert.deepEqual(result.sheets[1], { sourceId: 'sheet-1', fetched: false, rowCount: 0, error: 'HTTP 500' });
});

test('scoringDeferred refresh records ok false', async () => {
  let pursued = 0;
  const result = await runDealHunterSheetSync({
    storage: storageWithGroups({}),
    now,
    refresh: async () => ({
      ok: false,
      status: 503,
      scoringDeferred: true,
      review: healthyReview(),
      currentFingerprints: {},
    }),
    autoPursue: async () => { pursued += 1; return {}; },
  });
  assert.equal(pursued, 0);
  assert.equal(result.ok, false);
  assert.equal(result.requiredSourcesHealthy, true);
  assert.equal(result.scoredCount, 0);
  assert.deepEqual(result.autoPursue, { skipped: 'scoring_deferred' });
});

test('a refresh that throws records ok false without throwing', async () => {
  let pursued = 0;
  const result = await runDealHunterSheetSync({
    storage: storageWithGroups({}),
    now,
    refresh: async () => { throw new Error('database is locked'); },
    autoPursue: async () => { pursued += 1; return {}; },
  });
  assert.equal(pursued, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'database is locked');
  assert.deepEqual(result.autoPursue, { skipped: 'refresh_failed' });
});

test('autoPursue throw is recorded and sync stays ok', async () => {
  const result = await runDealHunterSheetSync({
    storage: storageWithGroups({}),
    now,
    refresh: healthyRefresh(),
    autoPursue: async () => { throw new Error('runner exploded'); },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.autoPursue, { error: 'runner exploded' });
});

test('sheet error text is capped at 300 chars', async () => {
  const result = await runDealHunterSheetSync({
    storage: storageWithGroups({}),
    now,
    refresh: async () => ({
      ok: true,
      status: 200,
      review: { sources: [{ id: 'sheet-0', fetched: false, required: true, sourceRole: 'required-primary', rowCount: 0, error: `boom ${'x'.repeat(900)}` }] },
      currentFingerprints: {},
    }),
    autoPursue: async () => ({}),
  });
  assert.equal(result.sheets[0].error.length, 300);
  assert.ok(result.sheets[0].error.startsWith('boom xxx'));
});

test('a sheet with no rows is unhealthy, matching the existing required-source rule', async () => {
  const result = await runDealHunterSheetSync({
    storage: storageWithGroups({}),
    now,
    refresh: async () => ({
      ok: true,
      status: 200,
      review: { sources: [{ id: 'sheet-0', fetched: true, required: true, sourceRole: 'required-primary', rowCount: 0 }] },
      currentFingerprints: {},
    }),
    autoPursue: async () => ({}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.requiredSourcesHealthy, false);
});

test('a source that names itself sourceId is read as well as id', async () => {
  const result = await runDealHunterSheetSync({
    storage: storageWithGroups({}),
    now,
    refresh: async () => ({
      ok: true,
      status: 200,
      review: { sources: [{ sourceId: 'sheet-0', fetched: true, required: true, sourceRole: 'required-primary', rowCount: 5, durationMs: 90 }] },
      currentFingerprints: {},
    }),
    autoPursue: async () => ({ status: 200 }),
  });
  assert.deepEqual(result.sheets, [{ sourceId: 'sheet-0', fetched: true, rowCount: 5, error: null, durationMs: 90 }]);
});

test('a failing optional sheet does not block automatic Pursue when the required sheet is healthy', async () => {
  const calls = [];
  const result = await runDealHunterSheetSync({
    storage: storageWithGroups({}),
    now,
    refresh: async () => ({
      ok: true,
      status: 200,
      review: {
        sources: [
          { id: 'sheet-0', fetched: true, required: true, sourceRole: 'required-primary', rowCount: 40 },
          { id: 'sheet-1', fetched: false, required: false, sourceRole: 'optional', rowCount: 0, error: 'HTTP 404' },
        ],
      },
      currentFingerprints: { 'opp-1': 'fp-1' },
    }),
    autoPursue: async (input) => { calls.push(input); return { ok: true, status: 200, mode: 'shadow', runKey: 'k' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.requiredSourcesHealthy, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.sheets[1], { sourceId: 'sheet-1', fetched: false, rowCount: 0, error: 'HTTP 404' });
});

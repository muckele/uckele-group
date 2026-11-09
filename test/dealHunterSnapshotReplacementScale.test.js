import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createSqliteStorage } from '../server/storage/sqlite.js';
import { sourceSafetyRunId } from '../server/services/cimSafetyIdentity.js';
import { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } from '../server/services/dealHunterSourceSnapshotAdmission.js';

// Fixtures follow test/dealHunterOpportunityFacts.test.js: the complete Sheet
// snapshot goes through the collector-owned admission into SQLite storage.
const sourceId = 'sheet-0';
const sourceName = 'SMB Deal Hunter Google Sheet';
const observedAt = '2026-11-01T12:00:00.000Z';

function withStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-snapshot-scale-'));
  const sqlitePath = path.join(directory, 'snapshot.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  storage.testSqlitePath = sqlitePath;
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

async function seedOpportunity(storage, opportunityId) {
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: '2026-11-01T11:00:00.000Z',
    updated_at: '2026-11-01T11:00:00.000Z',
    canonical_name: `Scale Test ${opportunityId}`,
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: null,
    identity_version: 'snapshot-scale-test-v1',
    status: 'active',
    metadata: {},
  });
}

function observation(opportunityId, sourceRecordId, field, value) {
  return {
    id: `${opportunityId}:${sourceRecordId}:${field}`,
    opportunity_id: opportunityId,
    source_id: sourceId,
    source_name: sourceName,
    source_record_id: sourceRecordId,
    field,
    value,
    observed_at: observedAt,
    created_at: observedAt,
    updated_at: observedAt,
  };
}

function sheetRecord(opportunityId, sourceRecordId, fields, freshnessEvidence = undefined) {
  return {
    opportunity_id: opportunityId,
    source_id: sourceId,
    source_name: sourceName,
    source_record_id: sourceRecordId,
    observations: fields.map(([field, value]) => observation(opportunityId, sourceRecordId, field, value)),
    ...(freshnessEvidence === undefined ? {} : { freshness_evidence: freshnessEvidence }),
  };
}

function sourceResult(records) {
  return {
    source: {
      id: sourceId,
      required: true,
      sourceRole: 'required-primary',
      fetched: true,
      error: null,
      coverageLimitReached: false,
      sourceRowCount: records.length,
      rowCount: records.length,
    },
    deals: records.map((record) => ({
      id: `raw-${record.source_record_id}`,
      sourceId,
      sourceName,
      idFromSourceRowPosition: true,
      sourceRowId: record.source_record_id.slice('sheet-row:'.length),
    })),
  };
}

async function replaceSnapshot(storage, runId, records, collector = storage) {
  const run = await storage.allocateDealHunterSourceGeneration({ sourceId, runId });
  const result = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
    storage: collector,
    reviewMode: 'full-backfill',
    sourceResult: sourceResult(records),
    records,
    run,
  });
  assert.equal(result.reconciled, true);
  return result;
}

const safetyCountSql = /SELECT COUNT\(\*\) AS n FROM deal_hunter_cim_safety_events/;

function profitClaim(value) {
  return { rawHeader: 'Annual Profit', rawValue: String(value), metric: 'sde', currency: 'USD', period: 'annual' };
}

function scaleRecord(index, profit) {
  return sheetRecord(`scale-opp-${index}`, `sheet-row:${index}`, [
    ['business_name', `Scale Business ${index}`],
    ['annual_profit', String(profit)],
    ['asking_price', String(profit * 3)],
  ], { annualProfit: profitClaim(profit) });
}

test('a 3,000-record complete Sheet replaced again with one changed record does per-run, not per-record, setup', async (t) => {
  // Break caught: the save re-scans every current observation for each
  // record, counts the whole safety run before each event, and compiles its
  // statements again for every record, so an unchanged daily Sheet costs
  // quadratic work and stalls the event loop.
  const recordCount = 3000;
  const storage = withStorage(t);
  for (let index = 1; index <= recordCount; index += 1) await seedOpportunity(storage, `scale-opp-${index}`);
  const first = Array.from({ length: recordCount }, (_, offset) => scaleRecord(offset + 1, 100000 + offset));
  await replaceSnapshot(storage, 'scale-run-1', first);

  const second = first.slice();
  second[1499] = scaleRecord(1500, 777777);
  // Measure only the storage save, not the collector's checks around it: its
  // wall time, every SQL statement it compiles, every safety-run COUNT(*) it
  // executes, and every Map#values() iteration it starts.
  let elapsedMs = null;
  const compiled = [];
  let safetyCountRuns = 0;
  let mapValueScans = 0;
  const probe = new Database(':memory:');
  const statementPrototype = Object.getPrototypeOf(probe.prepare('SELECT 1'));
  probe.close();
  const timedStorage = {
    ...storage,
    async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) {
      const originalPrepare = Database.prototype.prepare;
      const originalGet = statementPrototype.get;
      const originalValues = Map.prototype.values;
      Database.prototype.prepare = function countedPrepare(sql) {
        compiled.push(sql);
        return originalPrepare.call(this, sql);
      };
      statementPrototype.get = function countedGet(...parameters) {
        if (safetyCountSql.test(this.source)) safetyCountRuns += 1;
        return originalGet.apply(this, parameters);
      };
      Map.prototype.values = function countedValues() {
        mapValueScans += 1;
        return originalValues.call(this);
      };
      const started = performance.now();
      try {
        return await storage.replaceAdmittedCompleteGoogleSheetSourceSnapshot(value);
      } finally {
        elapsedMs = performance.now() - started;
        Map.prototype.values = originalValues;
        statementPrototype.get = originalGet;
        Database.prototype.prepare = originalPrepare;
      }
    },
  };
  const result = await replaceSnapshot(storage, 'scale-run-2', second, timedStorage);
  t.diagnostic(`second replacement of ${recordCount} records: ${elapsedMs.toFixed(0)} ms, `
    + `${compiled.length} statements compiled, ${safetyCountRuns} safety COUNT(*) runs, `
    + `${mapValueScans} Map#values() scans`);

  assert.equal(result.safetyEventsEmitted, recordCount);
  const db = new Database(storage.testSqlitePath, { readonly: true });
  t.after(() => db.close());
  const changed = db.prepare(`SELECT source_record_id FROM deal_hunter_freshness_evidence
    WHERE run_id = 'scale-run-2' AND event_type = 'accepted_source_record' AND field_key = ''`).all();
  assert.deepEqual(changed.map((row) => row.source_record_id), ['sheet-row:1500']);
  const material = db.prepare(`SELECT source_record_id, classification, before_value, after_value
    FROM deal_hunter_freshness_evidence WHERE run_id = 'scale-run-2' AND event_type = 'material_change'`).all();
  assert.deepEqual(material, [{
    source_record_id: 'sheet-row:1500', classification: 'comparable_change',
    before_value: 101499, after_value: 777777,
  }]);
  // Wall time alone cannot separate the two: measured locally (Node 22, Apple
  // silicon) the old save took about 1,300 ms alone and the fixed one about
  // 700 ms alone but 1,330 ms under the parallel `npm test` load. These counts
  // are exact under any load. The old save compiled 18,017 statements (the fix:
  // 23), ran the safety-run COUNT(*) once per event (3,000 times), and started a
  // Map#values() scan of every current observation once per record. The time
  // bound is only a coarse guard.
  assert.equal(safetyCountRuns, 1, 'the safety cap counts the run once per transaction');
  assert.ok(compiled.length < 100, `the save compiled ${compiled.length} statements`);
  assert.ok(mapValueScans < 100, `the save started ${mapValueScans} Map#values() scans`);
  assert.ok(elapsedMs < 5000, `second replacement took ${elapsedMs.toFixed(0)} ms`);
});

test('a source record observed under two opportunities keeps the first current key\'s latest row', async (t) => {
  // Break caught: the per-record lookup must return what the old
  // `[...currentByRecord.values()].find(...)` returned. Map order is the
  // first insertion of each record-and-field key, and its value is the last
  // row stored under that key. Here that is opportunity B's unaccepted
  // annual_profit row, so the unchanged Sheet row still counts as changed.
  // Taking the first or last raw row, or the last key, would read one of
  // A's accepted rows and wrongly skip the record as unchanged.
  const storage = withStorage(t);
  await seedOpportunity(storage, 'two-opp-a');
  await seedOpportunity(storage, 'two-opp-b');
  const records = [sheetRecord('two-opp-a', 'sheet-row:1', [
    ['annual_profit', '450000'],
    ['business_name', 'Two Owner Services'],
  ])];
  await replaceSnapshot(storage, 'two-opp-run-1', records);

  await storage.upsertDealHunterOpportunitySourceObservation(observation('two-opp-b', 'sheet-row:1', 'annual_profit', '450000'));
  const db = new Database(storage.testSqlitePath);
  t.after(() => db.close());
  const accepted = db.prepare(`SELECT accepted_evidence_id FROM deal_hunter_opportunity_source_observations
    WHERE opportunity_id = 'two-opp-a' AND field = 'annual_profit'`).get().accepted_evidence_id;
  assert.ok(accepted);
  // The storage API cannot write an accepted row directly; this one stands in
  // for an accepted A row stored after B's row.
  db.prepare(`INSERT INTO deal_hunter_opportunity_source_observations (
      id, opportunity_id, source_id, source_name, source_record_id, field, value,
      observed_at, created_at, updated_at, accepted_at, accepted_run_id, accepted_evidence_id
    ) VALUES ('two-opp-a:sheet-row:1:seller_name', 'two-opp-a', ?, ?, 'sheet-row:1', 'seller_name', 'Seller',
      ?, ?, ?, ?, 'two-opp-run-1', ?)`).run(sourceId, sourceName, observedAt, observedAt, observedAt, observedAt, accepted);
  // Same statement the storage reads its current rows with, so same order.
  assert.deepEqual(db.prepare(`SELECT * FROM deal_hunter_opportunity_source_observations
    WHERE source_id = ?`).all(sourceId).map(({ opportunity_id, field }) => ({ opportunity_id, field })), [
    { opportunity_id: 'two-opp-a', field: 'annual_profit' },
    { opportunity_id: 'two-opp-a', field: 'business_name' },
    { opportunity_id: 'two-opp-b', field: 'annual_profit' },
    { opportunity_id: 'two-opp-a', field: 'seller_name' },
  ], 'the fixture needs this current-row order');

  await replaceSnapshot(storage, 'two-opp-run-2', records);
  assert.deepEqual(db.prepare(`SELECT source_record_id, current_canonical_id FROM deal_hunter_freshness_evidence
    WHERE run_id = 'two-opp-run-2' AND event_type = 'accepted_source_record' AND field_key = ''`).all(),
  [{ source_record_id: 'sheet-row:1', current_canonical_id: 'two-opp-a' }]);
  assert.deepEqual(db.prepare(`SELECT opportunity_id, substr(event_type, 1, instr(event_type, '#') - 1) AS kind
    FROM deal_hunter_cim_safety_events WHERE safety_run_id = ? ORDER BY opportunity_id`)
    .all(sourceSafetyRunId(sourceId, 'two-opp-run-2')), [
    { opportunity_id: 'two-opp-a', kind: 'source-record-changed' },
    { opportunity_id: 'two-opp-b', kind: 'source-record-removed' },
  ]);
  assert.deepEqual(db.prepare(`SELECT opportunity_id, field, accepted_run_id FROM deal_hunter_opportunity_source_observations
    WHERE source_id = ? ORDER BY opportunity_id, field`).all(sourceId), [
    { opportunity_id: 'two-opp-a', field: 'annual_profit', accepted_run_id: 'two-opp-run-2' },
    { opportunity_id: 'two-opp-a', field: 'business_name', accepted_run_id: 'two-opp-run-2' },
  ]);
});

function capRecords(indexes) {
  return indexes.map((index) => sheetRecord(`cap-opp-${index}`, `sheet-row:${index}`, [
    ['business_name', `Cap Business ${index}`],
  ]));
}

// Stores `preseeded` extra rows under `runId`'s safety run, as rows from an
// earlier attempt would be, and returns a counter for that safety run.
function preseedSafetyEvents(t, storage, runId, preseeded) {
  const safetyRunId = sourceSafetyRunId(sourceId, runId);
  const db = new Database(storage.testSqlitePath);
  t.after(() => db.close());
  const insert = db.prepare(`INSERT INTO deal_hunter_cim_safety_events (
      id, safety_run_id, opportunity_id, source_type, source_run_id, canonical_revision,
      identity_exception_revision, event_type, evidence_id, status, created_at, updated_at
    ) VALUES (?, ?, 'cap-opp-1', 'sheet-import', ?, 0, 0, ?, ?, 'pending', ?, ?)`);
  db.transaction(() => {
    for (let index = 0; index < preseeded; index += 1) {
      insert.run(`cap-preseeded-${index}`, safetyRunId, runId, `earlier-attempt-${index}`, `evidence-${index}`,
        observedAt, observedAt);
    }
  })();
  return () => db.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_safety_events WHERE safety_run_id = ?')
    .get(safetyRunId).n;
}

async function safetyCapFixture(t, preseeded) {
  // Run 2 writes two unchanged-record events and then one removed-record
  // event, on top of `preseeded` rows already stored under its safety run.
  const storage = withStorage(t);
  for (const index of [1, 2, 3]) await seedOpportunity(storage, `cap-opp-${index}`);
  const records = capRecords([1, 2, 3]);
  await replaceSnapshot(storage, 'cap-run-1', records);
  const count = preseedSafetyEvents(t, storage, 'cap-run-2', preseeded);
  return { storage, records: records.slice(0, 2), count };
}

test('the admitted safety cap allows exactly 10,000 events in one run, counting earlier rows', async (t) => {
  const { storage, records, count } = await safetyCapFixture(t, 9997);
  const result = await replaceSnapshot(storage, 'cap-run-2', records);
  assert.equal(count(), 10000);
  assert.equal(result.safetyEventsEmitted, 10000);
});

test('the admitted safety cap throws when the removal event would be event 10,001', async (t) => {
  // Break caught: a counter that is not advanced after each insert, or a cap
  // compared with `>` instead of `>=`, lets the removal event through as the
  // 10,001st after the two record events written earlier in this transaction.
  const { storage, records, count } = await safetyCapFixture(t, 9998);
  await assert.rejects(replaceSnapshot(storage, 'cap-run-2', records),
    /^Error: Admitted safety run exceeds its bounded reader\.$/);
  assert.equal(count(), 9998);
});

test('the admitted safety cap throws when a record event would be event 10,001', async (t) => {
  const { storage, records, count } = await safetyCapFixture(t, 9999);
  await assert.rejects(replaceSnapshot(storage, 'cap-run-2', records),
    /^Error: Admitted safety run exceeds its bounded reader\.$/);
  assert.equal(count(), 9999);
});

async function rerunCapFixture(t) {
  // Run 1 is accepted, then run 2, then run 1's ID is used again on a new
  // generation. Its three unchanged records find their events from the first
  // attempt and return early as `prior`, writing nothing. With 9,996 earlier
  // rows plus those three, the safety run holds 9,999 events before the rerun.
  const storage = withStorage(t);
  for (const index of [1, 2, 3, 4, 5]) await seedOpportunity(storage, `cap-opp-${index}`);
  await replaceSnapshot(storage, 'cap-run-1', capRecords([1, 2, 3]));
  await replaceSnapshot(storage, 'cap-run-2', capRecords([1, 2, 3]));
  const count = preseedSafetyEvents(t, storage, 'cap-run-1', 9996);
  assert.equal(count(), 9999);
  return { storage, count };
}

test('safety events found from an earlier attempt of the run do not advance the cap', async (t) => {
  // Break caught: counting a `prior` hit as a write would put the rerun at
  // 10,002 before its one new record, and refuse a run that stays at 10,000.
  const { storage, count } = await rerunCapFixture(t);
  const result = await replaceSnapshot(storage, 'cap-run-1', capRecords([1, 2, 3, 4]));
  assert.equal(count(), 10000);
  assert.equal(result.safetyEventsEmitted, 10000);
});

test('a rerun with earlier-attempt events still throws at event 10,001', async (t) => {
  const { storage, count } = await rerunCapFixture(t);
  await assert.rejects(replaceSnapshot(storage, 'cap-run-1', capRecords([1, 2, 3, 4, 5])),
    /^Error: Admitted safety run exceeds its bounded reader\.$/);
  assert.equal(count(), 9999);
});

// The 07:30 Sheet sync must keep returning to the event loop.
//
// Most SQLite storage methods are async but never wait, so `await storage.x()` does not let
// anything else run. Before the fix, everything after the Sheet download ran as one block: at
// 5,000 rows a 16-second freeze locally, ~10 s on Fly. These tests run the real sync against a
// stubbed Sheet with the slice length at 0, so the job yields at every point it can, and
// measure the largest piece of work done between two event-loop turns.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';

process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/slices/gviz/tq?tqx=out:csv&gid=7';
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { runDealHunterSheetSync } = await import('../server/services/dealHunterSheetSync.js');
const { refreshOpportunityScores } = await import('../server/services/dealHunterScoreStore.js');
const { setEventLoopSliceMs } = await import('../server/utils/eventLoopSlices.js');

const originalFetch = globalThis.fetch;
let sheet = { csv: '', workbook: zipSync({}) };
globalThis.fetch = async (url) => {
  const value = String(url);
  // A real download finishes on a later turn.
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (value.includes('/gviz/tq')) return new Response(sheet.csv, { status: 200 });
  if (value.includes('/export?')) return new Response(sheet.workbook, { status: 200 });
  return new Response('not found', { status: 404 });
};
after(() => {
  globalThis.fetch = originalFetch;
});

const states = ['TX', 'FL', 'CA', 'OH', 'GA', 'NC', 'AZ', 'CO'];
const trades = ['Plumbing', 'HVAC', 'Roofing', 'Landscaping', 'Electrical', 'Janitorial', 'Pool Service', 'Pest Control'];

/** `count` distinct listings in the production Sheet's shape: a View Listing label in the CSV
 * and the link itself only as a HYPERLINK formula in the workbook. */
function buildSheet(count, { changedProfitEvery = 0 } = {}) {
  const rows = Array.from({ length: count }, (_, index) => {
    const changed = changedProfitEvery > 0 && index % changedProfitEvery === 0;
    return {
      name: `${trades[index % trades.length]} Services ${index + 1}`,
      url: `https://broker.example/listings/${index + 1}`,
      state: states[index % states.length],
      profit: 150000 + (index % 40) * 10000 + (changed ? 5000 : 0),
      revenue: 900000 + (index % 25) * 50000,
      price: 600000 + (index % 30) * 25000,
      description: `Established ${trades[index % trades.length].toLowerCase()} company with recurring commercial `
        + `contracts and trained staff and a transferable lease for listing ${index + 1}.`,
    };
  });
  const header = 'Business Name,View Listing,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description';
  const csv = [header, ...rows.map((row) => [row.name, 'View Listing', row.state, '2026-11-02', row.profit,
    row.revenue, row.price, row.description].join(','))].join('\n');
  const cells = rows.map((row, index) => {
    const at = index + 2;
    return `<row r="${at}"><c r="A${at}" t="inlineStr"><is><t>${row.name}</t></is></c>`
      + `<c r="B${at}" t="str"><f>HYPERLINK(&quot;${row.url}&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c></row>`;
  }).join('');
  const workbook = zipSync({ 'xl/worksheets/sheet1.xml': strToU8([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>View Listing</t></is></c></row>',
    cells, '</sheetData></worksheet>',
  ].join('')) });
  return { csv, workbook };
}

function createWorld(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-sync-event-loop-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'storage.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

// Counts SQLite statements and commits as the job runs. A write outside a transaction is its
// own commit; so is an outermost better-sqlite3 transaction or an explicit COMMIT.
function installSqliteCounters(t) {
  const counters = { statements: 0, commits: 0 };
  const probe = new Database(':memory:');
  const statementPrototype = Object.getPrototypeOf(probe.prepare('SELECT 1'));
  probe.close();
  const originals = {
    run: statementPrototype.run,
    get: statementPrototype.get,
    all: statementPrototype.all,
    exec: Database.prototype.exec,
    transaction: Database.prototype.transaction,
  };
  statementPrototype.run = function countedRun(...values) {
    counters.statements += 1;
    if (!this.database.inTransaction && !this.reader) counters.commits += 1;
    return originals.run.apply(this, values);
  };
  for (const name of ['get', 'all']) {
    statementPrototype[name] = function counted(...values) {
      counters.statements += 1;
      return originals[name].apply(this, values);
    };
  }
  Database.prototype.exec = function countedExec(source) {
    if (/^\s*COMMIT\b/i.test(source)) counters.commits += 1;
    return originals.exec.call(this, source);
  };
  Database.prototype.transaction = function countedTransaction(fn) {
    const database = this;
    const transaction = originals.transaction.call(this, fn);
    const wrap = (call) => function countedCall(...values) {
      const outermost = !database.inTransaction;
      const result = call.apply(this, values);
      if (outermost) counters.commits += 1;
      return result;
    };
    const counted = wrap(transaction);
    for (const variant of ['deferred', 'immediate', 'exclusive']) counted[variant] = wrap(transaction[variant]);
    return counted;
  };
  t.after(() => {
    Object.assign(statementPrototype, { run: originals.run, get: originals.get, all: originals.all });
    Database.prototype.exec = originals.exec;
    Database.prototype.transaction = originals.transaction;
  });
  return counters;
}

const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

// Runs `job` while a setImmediate ticker records the work done between consecutive turns.
async function measureTurns(counters, job) {
  const turns = [];
  let running = true;
  const snapshot = () => ({ at: performance.now(), cpu: cpuMs(), statements: counters.statements, commits: counters.commits });
  let last = snapshot();
  const startedCpu = last.cpu;
  const record = () => {
    const now = snapshot();
    turns.push({ ms: now.at - last.at, cpuMs: now.cpu - last.cpu, statements: now.statements - last.statements,
      commits: now.commits - last.commits });
    last = now;
  };
  const tick = () => {
    if (!running) return;
    record();
    setImmediate(tick);
  };
  setImmediate(tick);
  const startedAt = performance.now();
  try {
    const result = await job();
    // The work since the last tick counts too: a job that never yields is a single turn.
    record();
    return { result, turns, wallMs: performance.now() - startedAt, cpuMs: cpuMs() - startedCpu };
  } finally {
    running = false;
  }
}

const max = (turns, key) => Math.max(...turns.map((turn) => turn[key]));

test('the daily Sheet sync returns to the event loop between small pieces of work, first run and steady state', async (t) => {
  // Break caught: a phase that loops over listings, records or observations without a yield
  // (or a storage method that runs all of them in one synchronous transaction) shows up here
  // as one turn with thousands of statements or most of the job's time. Before the fix the
  // whole sync below was one turn.
  const restoreSliceMs = setEventLoopSliceMs(0);
  t.after(restoreSliceMs);
  const storage = createWorld(t);
  const counters = installSqliteCounters(t);
  const rows = 1200;

  for (const [label, options] of [['first run', {}], ['steady state', { changedProfitEvery: 50 }]]) {
    sheet = buildSheet(rows, options);
    const job = await measureTurns(counters, () => runDealHunterSheetSync({ storage }));
    const { result, turns } = job;
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.error)}`);
    assert.ok(result.scoredCount > rows * 0.95, `${label}: scored ${result.scoredCount}`);
    const longestCpu = max(turns, 'cpuMs');
    t.diagnostic(`${label}: ${rows} rows, ${Math.round(job.wallMs)} ms (${Math.round(job.cpuMs)} ms CPU) over `
      + `${turns.length} turns; largest turn ${Math.round(max(turns, 'ms'))} ms wall, ${Math.round(longestCpu)} ms CPU `
      + `(${(100 * longestCpu / job.cpuMs).toFixed(1)}% of the job's CPU), ${max(turns, 'statements')} statements, `
      + `${max(turns, 'commits')} commits`);
    // Statement and commit counts are exact under any load. CPU time, unlike wall time, does
    // not grow when a busy machine takes the process off the CPU, and the whole job's CPU
    // scales with the same machine speed. Every unsliced phase of the old sync was over 6%.
    assert.ok(max(turns, 'statements') <= 100, `${label}: one turn ran ${max(turns, 'statements')} statements`);
    assert.ok(max(turns, 'commits') <= 10, `${label}: one turn made ${max(turns, 'commits')} commits`);
    assert.ok(longestCpu < job.cpuMs * 0.06,
      `${label}: one turn used ${Math.round(longestCpu)} of ${Math.round(job.cpuMs)} ms CPU`);
  }
});

// The admission digests exactly as they were computed before the fix: one token string and
// one JSON.stringify, each hashed once. PostgreSQL recomputes the token for the Supabase
// adapter, so the bytes must not change.
function originalSnapshotDigest(snapshot) {
  const text = (value) => Buffer.from(String(value), 'utf8').toString('hex');
  const parts = ['complete-google-sheet-source-snapshot-v1', text(snapshot.source_id), text(snapshot.source_name),
    String(Number(snapshot.source_id.slice('sheet-'.length))), String(snapshot.records.length),
    String(snapshot.records.reduce((count, record) => count + record.observations.length, 0))];
  for (const record of snapshot.records) {
    parts.push('r', text(record.opportunity_id), text(record.source_id), text(record.source_name),
      text(record.source_record_id), String(record.observations.length));
    for (const observation of record.observations) {
      parts.push('o', text(observation.id), text(observation.opportunity_id), text(observation.source_id),
        text(observation.source_name), text(observation.source_record_id), text(observation.field),
        text(observation.value), text(observation.observed_at), text(observation.created_at), text(observation.updated_at));
    }
  }
  for (const item of snapshot.unresolved || []) {
    parts.push('u', text(item.source_record_id), text(item.identity_exception_id), text(JSON.stringify(item.freshness_evidence)));
  }
  return createHash('md5').update(parts.join('|')).digest('hex');
}

function originalFreshnessDigest(snapshot) {
  const hash = createHash('md5').update(JSON.stringify(snapshot.unresolved?.length
    ? { records: snapshot.records, unresolved: snapshot.unresolved } : snapshot.records)).digest('hex');
  return hash + createHash('md5').update(`${hash}${snapshot.run.runId}${snapshot.run.generation}`).digest('hex');
}

test('hashing the admission a record at a time gives the digests the single-pass code gave', async (t) => {
  const storage = createWorld(t);
  const replace = storage.replaceAdmittedCompleteGoogleSheetSourceSnapshot;
  const admitted = [];
  storage.replaceAdmittedCompleteGoogleSheetSourceSnapshot = function capture(value) {
    admitted.push(value);
    return replace.call(this, value);
  };
  sheet = buildSheet(40);
  const result = await runDealHunterSheetSync({ storage });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(admitted.length, 1);
  const [value] = admitted;
  assert.equal(value.records.length, 40);
  assert.equal(value.admission.snapshot_digest, originalSnapshotDigest(value));
  assert.equal(value.admission.freshness_digest, originalFreshnessDigest(value));
});

test('two score refreshes started together run one after the other', async (t) => {
  // Break caught: once the refresh yields, the scheduler, the external cron and an admin
  // request could interleave two refreshes' identity writes and snapshot admissions, which a
  // single synchronous block never allowed.
  const storage = createWorld(t);
  sheet = buildSheet(30);
  const calls = [];
  for (const name of ['allocateDealHunterSourceGeneration', 'reconcileDealHunterCurrentScoreEligibility']) {
    const original = storage[name];
    storage[name] = function recorded(...values) {
      calls.push(name);
      return original.apply(this, values);
    };
  }
  const results = await Promise.all([
    refreshOpportunityScores({ storage, reviewMode: 'full-backfill' }),
    refreshOpportunityScores({ storage, reviewMode: 'full-backfill' }),
  ]);
  assert.deepEqual(results.map((result) => result.ok), [true, true]);
  assert.deepEqual(calls, [
    'allocateDealHunterSourceGeneration', 'reconcileDealHunterCurrentScoreEligibility',
    'allocateDealHunterSourceGeneration', 'reconcileDealHunterCurrentScoreEligibility',
  ]);
});

test('a storage call made while the snapshot transaction is open waits for COMMIT; a health check does not', async (t) => {
  // Break caught: without the exclusive section, a request's storage call at one of the
  // transaction's yields would run inside the open transaction on the shared connection.
  const restoreSliceMs = setEventLoopSliceMs(0);
  t.after(restoreSliceMs);
  const storage = createWorld(t);
  sheet = buildSheet(60);
  const events = [];
  const replace = storage.replaceAdmittedCompleteGoogleSheetSourceSnapshot;
  storage.replaceAdmittedCompleteGoogleSheetSourceSnapshot = function observed(value) {
    return replace.call(this, value).then((rows) => {
      events.push('snapshot committed');
      return rows;
    });
  };
  // BEGIN IMMEDIATE runs only inside the section; the probe calls go out at its next yield.
  const originalExec = Database.prototype.exec;
  let probed = false;
  Database.prototype.exec = function probedExec(source) {
    if (!probed && source === 'BEGIN IMMEDIATE') {
      probed = true;
      setImmediate(() => {
        storage.checkHealth().then(() => events.push('health check answered'));
        storage.readCimOutreachCounters().then(() => events.push('other storage call answered'));
      });
    }
    return originalExec.call(this, source);
  };
  t.after(() => {
    Database.prototype.exec = originalExec;
  });
  const result = await runDealHunterSheetSync({ storage });
  assert.equal(result.ok, true);
  assert.equal(probed, true);
  assert.deepEqual(events, ['health check answered', 'snapshot committed', 'other storage call answered']);
});

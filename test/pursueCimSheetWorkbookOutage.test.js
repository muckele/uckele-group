// A day the Sheet's workbook cannot be read defers the Sheet; it never re-keys it.
//
// Production shape: the Sheet's CSV export shows only the label "View Listing"; each listing's
// URL exists only as a hyperlink in the xlsx export. A Sheet row is keyed by its listing link, so
// on a day the workbook fails, admitting the Sheet would re-key every row to its position, and
// back the next day: every record changed and removed twice, every Pursue campaign held. The
// Sheet is deferred for the day instead, like a failed CSV, and the deferral shows in the sync
// result and source health. Real SQLite, the real daily sync (`runDealHunterSheetSync` ->
// `refreshOpportunityScores` full-backfill) with stubbed Google exports, and the fake Gmail mailbox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursue-workbook-outage-'));
process.env.ADMIN_SESSION_SECRET = 'pursue-workbook-outage-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'pursue-workbook-outage-document-secret';
process.env.SQLITE_PATH = path.join(tempDir, 'default.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'source-health.json');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/outage/gviz/tq?tqx=out:csv&gid=0';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
delete process.env.DEAL_HUNTER_AUTO_PURSUE_ACTIVE_DAILY_CAP;
process.on('exit', () => fs.rmSync(tempDir, { recursive: true, force: true }));

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { runDealHunterSheetSync } = await import('../server/services/dealHunterSheetSync.js');
const { buildAcquisitionSourceHealth } = await import('../server/services/acquisitionCommandCenter.js');
const { refreshOpportunityScores } = await import('../server/services/dealHunterScoreStore.js');
const {
  BROKER_EMAIL, HEALTHY_SOURCE_SNAPSHOT, createWorld, ownerRequestsSim, ownerTurnsSendingOn, pacific, sendAt,
} = await import('./fixtures/pursueCimEndToEndFixture.js');

fs.writeFileSync(process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH, JSON.stringify(HEALTHY_SOURCE_SNAPSHOT));

const SATURDAY = '2030-01-05';
const SUNDAY = '2030-01-06';
const MONDAY = '2030-01-07';
const DESCRIPTION = 'Established operator with trained staff and documented processes and a diversified customer '
  + 'base and steady repeat demand across the region.';
const LISTINGS = [
  { name: 'Acme Plumbing', url: 'https://broker.example/listings/acme-plumbing', industry: 'Plumbing',
    broker: 'Jordan Lee', email: BROKER_EMAIL, profit: 450000, revenue: 1200000, price: 900000 },
  { name: 'Harbor Roofing', url: 'https://broker.example/listings/harbor-roofing', industry: 'Roofing',
    broker: 'Pat Doe', email: 'pat.doe@otherbroker.test', profit: 300000, revenue: 1000000, price: 700000 },
];

/** The CSV export: the listing column holds only the "View Listing" label. */
function sheetCsv() {
  return ['Name,View Listing,Industry,City,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description,Broker Name,Broker Email',
    ...LISTINGS.map((item) => [item.name, 'View Listing', item.industry, 'Sacramento', 'CA', '2030-01-04',
      item.profit, item.revenue, item.price, `${item.industry} company. ${DESCRIPTION}`, item.broker,
      item.email].join(','))].join('\n');
}

/** The xlsx export: the only place each listing's URL exists, as a hyperlink. */
function sheetWorkbook() {
  const rows = LISTINGS.map((item, index) => {
    const at = index + 2;
    return `<row r="${at}"><c r="A${at}" t="inlineStr"><is><t>${item.name}</t></is></c>`
      + `<c r="B${at}" t="str"><f>HYPERLINK(&quot;${item.url}&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c></row>`;
  }).join('');
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>View Listing</t></is></c></row>',
    rows, '</sheetData></worksheet>',
  ].join('')) });
}

function stubGoogleExports(t) {
  const originalFetch = globalThis.fetch;
  const exports = { workbookStatus: 200 };
  globalThis.fetch = async (url, ...rest) => {
    const value = String(url);
    if (value.includes('/gviz/tq')) return new Response(sheetCsv(), { status: 200 });
    if (value.includes('/export?')) {
      return exports.workbookStatus === 200 ? new Response(sheetWorkbook(), { status: 200 })
        : new Response('Internal error', { status: exports.workbookStatus });
    }
    return originalFetch(url, ...rest);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return exports;
}

function createSqliteBackend(t) {
  const directory = fs.mkdtempSync(path.join(tempDir, 'world-'));
  const sqlitePath = path.join(directory, 'storage.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  return {
    storage,
    all: async (sql, ...params) => database.prepare(sql).all(...params),
    run: async (sql, ...params) => { database.prepare(sql).run(...params); },
  };
}

const IMMUTABLE_ACCEPTANCE_TRIGGERS = ['deal_hunter_freshness_evidence_no_payload_update',
  'trg_deal_hunter_cim_safety_events_payload_immutable'];

/**
 * Re-stamps one sync's acceptance at the controlled instant, as production writes it (SQLite
 * stamps acceptance with its own wall clock; this world runs in 2030). Same as #103's test.
 */
async function stampAcceptance(world, runId, at) {
  const placeholders = IMMUTABLE_ACCEPTANCE_TRIGGERS.map(() => '?').join(', ');
  const triggers = await world.all(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
    AND name IN (${placeholders})`, ...IMMUTABLE_ACCEPTANCE_TRIGGERS);
  assert.equal(triggers.length, IMMUTABLE_ACCEPTANCE_TRIGGERS.length);
  try {
    for (const { name } of triggers) await world.run(`DROP TRIGGER ${name}`);
    await world.run(`UPDATE deal_hunter_opportunity_source_observations SET accepted_at = ?
      WHERE accepted_run_id = ?`, at, runId);
    await world.run(`UPDATE deal_hunter_source_freshness_state SET accepted_at = ?
      WHERE accepted_run_id = ?`, at, runId);
    await world.run('UPDATE deal_hunter_freshness_evidence SET accepted_at = ? WHERE run_id = ?', at, runId);
    await world.run(`UPDATE deal_hunter_cim_safety_events SET created_at = ?, updated_at = ?
      WHERE source_run_id = ?`, at, at, runId);
  } finally {
    const present = new Set((await world.all(`SELECT name FROM sqlite_master WHERE type = 'trigger'
      AND name IN (${placeholders})`, ...IMMUTABLE_ACCEPTANCE_TRIGGERS)).map((row) => row.name));
    for (const { name, sql } of triggers) if (!present.has(name)) await world.run(sql);
  }
}

const acceptedRun = async (world) => (await world.all(`SELECT accepted_run_id, projection_state
  FROM deal_hunter_source_freshness_state WHERE source_id = 'sheet-0'`))[0];

/** One daily Sheet sync at the world's clock: the scheduler's entry point, auto Pursue left off. */
async function dailySync(world) {
  const at = world.clock.peek().toISOString();
  let review = null;
  const before = await acceptedRun(world);
  const sync = await runDealHunterSheetSync({ storage: world.storage, now: world.clock.peek(),
    refresh: async (input) => {
      const result = await refreshOpportunityScores(input);
      review = result.review;
      return result;
    },
    autoPursue: async () => ({ ok: true, status: 200, mode: 'off', commands: 0 }),
    reevaluate: async () => ({ enrolled: 0, stillWaiting: 0, actionRequired: 0 }) });
  const after = await acceptedRun(world);
  if (after?.accepted_run_id && after.accepted_run_id !== before?.accepted_run_id) {
    await stampAcceptance(world, after.accepted_run_id, at);
  }
  return { sync, review, runId: after?.accepted_run_id === before?.accepted_run_id ? null : after?.accepted_run_id };
}

const sheetRows = (world) => world.all(`SELECT id, opportunity_id, source_record_id, field, value, accepted_run_id,
  accepted_evidence_id FROM deal_hunter_opportunity_source_observations WHERE source_id = 'sheet-0'
  ORDER BY id`);
const counts = async (world) => ({
  evidence: (await world.all('SELECT COUNT(*) AS n FROM deal_hunter_freshness_evidence'))[0].n,
  safety: (await world.all('SELECT COUNT(*) AS n FROM deal_hunter_cim_safety_events'))[0].n,
});

test('a day the Sheet workbook fails defers the Sheet: no change, no removal, no re-keying, and the campaign still sends', async (t) => {
  const exports = stubGoogleExports(t);
  const world = await createWorld(t, createSqliteBackend, { start: pacific(SATURDAY, '06:30') });
  world.mailProvider.rewriteMessageIds();
  await ownerTurnsSendingOn(world);

  // Day 1: the workbook is up; every row is keyed by its hyperlink.
  world.clock.set(pacific(SATURDAY, '08:00'));
  const day1 = await dailySync(world);
  assert.equal(day1.sync.ok, true, JSON.stringify(day1.sync));
  assert.ok(day1.runId);
  const rowsDay1 = await sheetRows(world);
  assert.equal(rowsDay1.filter((row) => row.field === 'listing_url').length, LISTINGS.length);
  assert.ok(rowsDay1.every((row) => row.source_record_id.startsWith('listing:')), JSON.stringify(rowsDay1));
  const opportunityId = rowsDay1.find((row) => row.field === 'listing_url' && row.value === LISTINGS[0].url)
    .opportunity_id;

  world.clock.set(pacific(SATURDAY, '20:26'));
  const command = await ownerRequestsSim(world, opportunityId);
  assert.equal(command.enrollment.state, 'campaign-created', JSON.stringify(command.enrollment));
  const campaign = await world.campaignFor(opportunityId);
  assert.deepEqual(await world.scheduled(campaign), [['initial', pacific(MONDAY, '08:00')]]);
  const beforeOutage = await counts(world);

  // Day 2: the workbook export answers 500. The Sheet is deferred, visibly; nothing is written.
  exports.workbookStatus = 500;
  world.clock.set(pacific(SUNDAY, '08:00'));
  const day2 = await dailySync(world);
  assert.equal(day2.sync.ok, false);
  assert.equal(day2.runId, null, 'no Sheet run was accepted');
  const [sheet] = day2.sync.sheets;
  assert.match(sheet.error, /workbook could not be read.*deferred/);
  const source = day2.review.sources.find((item) => item.id === 'sheet-0');
  assert.equal(source.listingUrlSourceUnavailable, true);
  const health = buildAcquisitionSourceHealth({ review: day2.review, now: world.clock.peek() });
  assert.equal(health.healthy, false);
  assert.ok(health.issues.some((issue) => issue.sourceId === 'sheet-0' && issue.affectsHealth
    && issue.sourceUnavailable && /deferred/.test(issue.message)), JSON.stringify(health.issues));
  assert.deepEqual(await sheetRows(world), rowsDay1, 'no change, no removal, no re-keying');
  assert.deepEqual(await counts(world), beforeOutage, 'no evidence and no safety event');

  // Day 3: the workbook is back. Nothing changed, and the campaign's initial goes out.
  exports.workbookStatus = 200;
  world.clock.set(pacific(MONDAY, '08:00'));
  const day3 = await dailySync(world);
  assert.equal(day3.sync.ok, true, JSON.stringify(day3.sync));
  assert.ok(day3.runId);
  assert.deepEqual((await sheetRows(world)).map(({ id, source_record_id: recordId, field, value }) => [id, recordId,
    field, value]), rowsDay1.map(({ id, source_record_id: recordId, field, value }) => [id, recordId, field, value]));
  assert.deepEqual(await world.all(`SELECT source_record_id FROM deal_hunter_freshness_evidence
    WHERE run_id = ? AND event_type = 'accepted_source_record' AND field_key = ''`, day3.runId), [],
  'zero changed records');
  assert.deepEqual((await world.all(`SELECT event_type FROM deal_hunter_cim_safety_events WHERE source_run_id = ?`,
    day3.runId)).map((row) => row.event_type.split('#')[0]), LISTINGS.map(() => 'source-record-unchanged'));

  const run = await sendAt(world, pacific(MONDAY, '08:05'));
  assert.equal(run.sentInitial, 1, JSON.stringify(run));
  assert.deepEqual(run.skipped, {}, JSON.stringify(run));
  assert.equal(world.mailProvider.sent[0].to, BROKER_EMAIL);
  const [touch] = await world.touches(campaign.id);
  assert.deepEqual([touch.kind, touch.state], ['initial', 'accepted']);
});

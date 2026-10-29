import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const sheetUrl = 'https://example.test/required-sheet.csv';
process.env.DEAL_HUNTER_SHEET_CSV_URL = sheetUrl;
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
const { importDealOsExport, parseSheetCsvDeals } = await import('../server/services/dealHunter.js');
const { refreshOpportunityScores } = await import('../server/services/dealHunterScoreStore.js');

test('Sheet CSV rejects unfinished quoted cells even beyond the selected row cap', () => {
  for (const csv of [
    '"Name,Description',
    'Name,Description\nAlpha,"Unfinished',
    'Name,Description\nAlpha,Complete\nBeta,"Unfinished\nGamma,Swallowed',
    'Name,Description\nAlpha,"Escaped quote at the end""',
  ]) {
    assert.throws(() => parseSheetCsvDeals(csv, 0, 1), /unterminated quoted field/i);
  }
});

test('Sheet CSV preserves complete multiline quoted cells, escaped quotes and following listings', () => {
  const csv = 'Name,Description\r\n"Alpha, HVAC","Recurring\r\nmaintenance with ""priority"" support"\r\nBeta,Complete';
  const { deals } = parseSheetCsvDeals(csv);
  assert.deepEqual(deals.map(({ name, description }) => ({ name, description })), [
    { name: 'Alpha, HVAC', description: 'Recurring maintenance with "priority" support' },
    { name: 'Beta', description: 'Complete' },
  ]);
});

test('an unfinished quoted Sheet cell cannot replace the last complete source snapshot or scores', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-incomplete-sheet-csv-'));
  const sqlitePath = path.join(directory, 'observations.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const currentDate = new Date().toISOString().slice(0, 10);
  let sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Date Added,Annual Profit,Description',
    `COMPLETE-1,Alpha HVAC,https://broker.example/complete-alpha,CA,${currentDate},450000,Recurring maintenance`,
    `COMPLETE-2,Beta Plumbing,https://broker.example/complete-beta,CA,${currentDate},475000,Recurring maintenance`,
    `COMPLETE-3,Gamma Electric,https://broker.example/complete-gamma,CA,${currentDate},500000,Recurring maintenance`,
  ].join('\n');
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url) => {
    assert.equal(String(url), sheetUrl, 'only the synthetic Sheet may be fetched');
    return new Response(sourceCsv, { status: 200 });
  };
  const refresh = () => refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'incomplete-csv-test' });
  const initial = await refresh();
  assert.equal(initial.ok, true, initial.error);
  const database = new Database(sqlitePath, { readonly: true });
  t.after(() => database.close());
  const snapshot = () => ({
    observations: database.prepare('SELECT * FROM deal_hunter_opportunity_source_observations ORDER BY id').all(),
    scores: database.prepare('SELECT * FROM deal_hunter_opportunity_scores ORDER BY opportunity_id').all(),
    // A failed fetch may allocate a generation, but must not accept one.
    freshness: database.prepare(`SELECT source_id, accepted_generation, accepted_run_id,
      accepted_digest, accepted_at, projection_state FROM deal_hunter_source_freshness_state ORDER BY source_id`).all(),
  });
  const before = snapshot();
  assert.equal(new Set(before.observations.map((row) => row.opportunity_id)).size, 3);
  const outreachBefore = await storage.readCimOutreachCounters();

  // A missing closing quote absorbs Gamma into Beta's description. The
  // lenient parser reports two rows as a complete source and removes Gamma.
  sourceCsv = sourceCsv.replace(',475000,Recurring maintenance', ',475000,"Unfinished maintenance');
  const failed = await refresh();
  assert.equal(new Set(snapshot().observations.map((row) => row.opportunity_id)).size, 3,
    'the malformed refresh must not remove Gamma from the retained source snapshot');
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 503);
  const sheet = failed.review.sources.find(({ id }) => id === 'sheet-0');
  assert.equal(sheet.fetched, false);
  assert.match(sheet.error, /unterminated quoted field/i);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(await storage.readCimOutreachCounters(), outreachBefore);
});

test('Deal OS rejects an unfinished quoted CSV before storing an import', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-incomplete-deal-os-csv-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'imports.sqlite') } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const result = await importDealOsExport({
    fileBuffer: Buffer.from('Listing ID,Business Name,Description\nDOS-1,Alpha,Complete\nDOS-2,Beta,"Unfinished\nDOS-3,Gamma,Swallowed'),
    fileName: 'incomplete.csv', exportedAt: new Date().toISOString(),
    scope: 'saved-search', coverageLabel: 'Synthetic completeness regression',
    importedBy: 'incomplete-csv-test', storage,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.match(result.error, /unterminated quoted field/i);
  assert.equal(await storage.getLatestDealHunterDealOsImport(), null);
});

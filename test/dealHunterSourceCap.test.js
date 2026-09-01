import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { buildOpportunitySourceObservationSnapshot } from '../server/services/dealHunterOpportunityFacts.js';
import { refreshOpportunityScores } from '../server/services/dealHunterScoreStore.js';

process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/capped-test/gviz/tq?tqx=out:csv&gid=123';
process.env.DEAL_HUNTER_MAX_SOURCE_RECORDS = '1';
process.env.DEAL_HUNTER_AIRTABLE_TOKEN = 'test-token';
process.env.DEAL_HUNTER_AIRTABLE_BASE_ID = 'appTest';
process.env.DEAL_HUNTER_AIRTABLE_TABLE_ID = 'tblTest';

const originalFetch = globalThis.fetch;
let sourceCsv = [
  'Name,View Listing',
  'Duplicate Deal,View Listing',
  'Duplicate Deal,View Listing',
].join('\n');
const worksheet = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  '<row r="1"><c r="B1" t="inlineStr"><is><t>Name</t></is></c><c r="V1" t="inlineStr"><is><t>View Listing</t></is></c></row>',
  '<row r="2"><c r="B2" t="inlineStr"><is><t>Duplicate Deal</t></is></c><c r="V2" t="str"><f>HYPERLINK(&quot;https://broker.example/first&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c></row>',
  '<row r="3"><c r="B3" t="inlineStr"><is><t>Duplicate Deal</t></is></c><c r="V3" t="str"><f>HYPERLINK(&quot;https://broker.example/second&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c></row>',
  '</sheetData></worksheet>',
].join('');
const sourceWorkbook = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(worksheet) });

globalThis.fetch = async (url) => {
  const value = String(url);
  if (value.includes('/gviz/tq')) return new Response(sourceCsv, { status: 200 });
  if (value.includes('/export?')) return new Response(sourceWorkbook, { status: 200 });
  if (value.includes('api.airtable.com')) return Response.json({ records: [] });
  return new Response('not found', { status: 404 });
};

const { parseSheetCsvDeals, reviewDailyDeals } = await import('../server/services/dealHunter.js');

after(() => {
  globalThis.fetch = originalFetch;
});

test('workbook alignment keeps duplicate context beyond the imported record cap', async () => {
  const review = await reviewDailyDeals({ storage: {} });
  const source = review.sources.find((item) => item.id === 'sheet-0');

  assert.equal(source.rowCount, 1);
  assert.equal(source.sourceRowCount, 2, 'the collector retains the authoritative pre-cap row count');
  assert.equal(source.coverageLimitReached, true, 'a capped source is explicitly marked incomplete for snapshot reconciliation');
  assert.equal(source.listingUrlCount, 1);
  assert.equal(source.listingUrlExpectedCount, 1);
  assert.equal(source.listingUrlUnresolvedCount, 0);
  assert.equal(source.listingUrlWarning, '');
});

test('a capped full Sheet collection leaves a prior source snapshot untouched rather than reconciling its selected row', async (t) => {
  // Break caught: the source cap exposes only one selected deal, but a complete
  // snapshot writer treats it as every authoritative Sheet row and updates or
  // deletes last-known-good source evidence outside that partial collection.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-capped-sheet-snapshot-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'capped.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const firstRefresh = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'capped-sheet-test' });
  assert.equal(firstRefresh.ok, true);
  const firstListingUrl = 'https://broker.example/first';
  const [opportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((row) => row.metadata?.identitySnapshot?.listingUrl === firstListingUrl);
  assert.ok(opportunity);
  const [sourceDeal] = parseSheetCsvDeals(sourceCsv).deals;
  await storage.replaceDealHunterOpportunitySourceObservationSnapshot(
    buildOpportunitySourceObservationSnapshot({
      opportunityId: opportunity.opportunity_id,
      deal: { ...sourceDeal, listingUrl: firstListingUrl },
      now: '2026-08-31T12:00:00.000Z',
    }),
  );
  const before = await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id);

  const secondRefresh = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'capped-sheet-test' });
  assert.equal(secondRefresh.ok, true);
  assert.deepEqual(
    await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id),
    before,
    'without every raw Sheet row, full-backfill fails closed instead of replacing a partial source scope',
  );
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  buildOpportunitySourceObservationSnapshot,
  setOperatorOpportunityFact,
} from '../server/services/dealHunterOpportunityFacts.js';

process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/test/gviz/tq?tqx=out:csv&gid=123';
process.env.DEAL_HUNTER_AIRTABLE_TOKEN = 'test-token';
process.env.DEAL_HUNTER_AIRTABLE_BASE_ID = 'appTest';
process.env.DEAL_HUNTER_AIRTABLE_TABLE_ID = 'tblTest';
process.env.DEAL_HUNTER_AIRTABLE_VIEW_ID = 'viwTest';

const originalFetch = globalThis.fetch;
const { parseSheetCsvDeals, reviewDailyDeals } = await import('../server/services/dealHunter.js');
let sourceCsv;
let sourceWorkbook;
let airtableFetchCount;
let sheetFetchStatus;
let dealOsImport;

function buildWorkbook(rows) {
  const worksheetRows = rows.map(({ name, row, url }) => [
    `<row r="${row}">`,
    `<c r="B${row}" t="inlineStr"><is><t>${name}</t></is></c>`,
    `<c r="U${row}"/>`,
    `<c r="V${row}" t="str"><f>HYPERLINK(&quot;${url}&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c>`,
    '</row>',
  ].join('')).join('');
  const worksheet = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    '<row r="1"><c r="B1" t="inlineStr"><is><t>Name</t></is></c><c r="V1" t="inlineStr"><is><t>View Listing</t></is></c></row>',
    worksheetRows,
    '</sheetData></worksheet>',
  ].join('');
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8(worksheet) });
}

function sourceStorage() {
  return {
    async getLatestDealHunterDealOsImport() {
      return dealOsImport;
    },
  };
}

function freshDealOsImport() {
  const now = new Date().toISOString();
  return {
    id: 'source-health-fresh-import',
    created_at: now,
    imported_by: 'admin',
    exported_at: now,
    file_name: 'fresh-deal-os.csv',
    file_type: 'text/csv',
    file_size: 100,
    file_sha256: 'a'.repeat(64),
    scope: 'saved-search',
    coverage_label: 'Source-health regression fixture',
    expected_row_count: 1,
    source_row_count: 1,
    accepted_row_count: 1,
    rejected_row_count: 0,
    canonical_record_count: 1,
    parser_version: 'deal-os-export-v2',
    row_accounting: [],
    row_count: 1,
    duplicate_count: 0,
    stable_id_count: 1,
    listing_url_count: 1,
    coverage_limit_reached: false,
    records: [{
      stableId: 'DEAL-OS-ONLY-1',
      name: 'Deal OS Must Stay Supplemental',
      listingUrl: 'https://broker.example/deal-os-only',
      annualProfit: 425000,
      state: 'CA',
      brokerContacts: [],
    }],
    metadata: {},
  };
}

function assertFailClosedReview(reviewed) {
  assert.deepEqual(reviewed.scoredDeals, []);
  assert.equal(reviewed.review.scoringDeferred, true);
  assert.deepEqual(reviewed.review.qualified, []);
  assert.deepEqual(reviewed.review.watchlist, []);
  assert.deepEqual(reviewed.review.removalCandidates, []);
  assert.deepEqual(reviewed.review.newlySeenMatches, []);
  assert.deepEqual(reviewed.review.criteriaRecommendations, []);
  assert.deepEqual(reviewed.review.crmSyncPreview, { count: 0, dealKeys: [] });
  assert.equal(reviewed.review.totals.cimReady, 0);
}

beforeEach(() => {
  sourceCsv = [
    'Name,View Listing',
    'Alpha HVAC,View Listing',
    'Beta Plumbing,View Listing',
  ].join('\n');
  sourceWorkbook = buildWorkbook([
    { row: 2, name: 'Alpha HVAC', url: 'https://broker.example/alpha' },
    { row: 3, name: 'Workbook Only', url: 'https://broker.example/workbook-only' },
    { row: 4, name: 'Beta Plumbing', url: 'https://broker.example/beta' },
  ]);
  airtableFetchCount = 0;
  sheetFetchStatus = 200;
  dealOsImport = null;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/gviz/tq')) return new Response(sourceCsv, { status: sheetFetchStatus });
    if (value.includes('/export?')) return new Response(sourceWorkbook, { status: 200 });
    if (value.includes('airtable.com')) {
      airtableFetchCount += 1;
      return Response.json({ records: [] });
    }
    return new Response('not found', { status: 404 });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

test('Google Sheet source health ignores workbook-only links when every imported row is linked', async () => {
  const review = await reviewDailyDeals({ storage: sourceStorage() });
  const source = review.sources.find((item) => item.id === 'sheet-0');

  assert.equal(source.rowCount, 2);
  assert.equal(source.listingUrlCount, 2);
  assert.equal(source.listingUrlExpectedCount, 2);
  assert.equal(source.listingUrlUnresolvedCount, 0);
  assert.equal(source.unmatchedWorkbookListingUrlCount, 1);
  assert.equal(source.listingUrlWarning, '');
});

test('legacy Airtable configuration cannot reactivate the retired source', async () => {
  const review = await reviewDailyDeals({ storage: sourceStorage() });

  assert.equal(airtableFetchCount, 0);
  assert.equal(review.sources.some((source) => /airtable/i.test(source.id || source.name)), false);
  assert.equal(review.disabledSources[0].sourceRole, 'retired');
  assert.equal(review.disabledSources[0].retired, true);
});

test('Google Sheet source health reports imported rows that genuinely lack a safe link', async () => {
  sourceCsv = `${sourceCsv}\nGamma Electric,View Listing`;
  const review = await reviewDailyDeals({ storage: sourceStorage() });
  const source = review.sources.find((item) => item.id === 'sheet-0');

  assert.equal(source.rowCount, 3);
  assert.equal(source.listingUrlCount, 2);
  assert.equal(source.listingUrlExpectedCount, 3);
  assert.equal(source.listingUrlUnresolvedCount, 1);
  assert.match(source.listingUrlWarning, /1 imported CSV row displays a View Listing label/);
});

test('an unexpected workbook link cannot mask a missing expected listing link', async () => {
  sourceCsv = [
    'Name,View Listing',
    'Alpha HVAC,View Listing',
    'Beta Plumbing,',
  ].join('\n');
  sourceWorkbook = buildWorkbook([
    { row: 2, name: 'Beta Plumbing', url: 'https://broker.example/beta' },
  ]);
  const review = await reviewDailyDeals({ storage: sourceStorage() });
  const source = review.sources.find((item) => item.id === 'sheet-0');

  assert.equal(source.listingUrlCount, 0);
  assert.equal(source.listingUrlExpectedCount, 1);
  assert.equal(source.listingUrlUnresolvedCount, 1);
  assert.match(source.listingUrlWarning, /1 imported CSV row displays a View Listing label/);
});

test('a failed required Sheet suppresses every scored output even when Deal OS is fresh', async () => {
  dealOsImport = freshDealOsImport();
  sheetFetchStatus = 503;

  const reviewed = await reviewDailyDeals({ storage: sourceStorage(), withScoredDeals: true });

  assert.equal(reviewed.review.sources.find((source) => source.id === 'deal-os-export').fetched, true);
  assert.equal(reviewed.review.sources.find((source) => source.id === 'sheet-0').fetched, false);
  assertFailClosedReview(reviewed);
  assert.equal(JSON.stringify(reviewed).includes('Deal OS Must Stay Supplemental'), false);
});

test('a header-only required Sheet suppresses every scored output even when Deal OS is fresh', async () => {
  dealOsImport = freshDealOsImport();
  sourceCsv = 'Name,View Listing';
  sourceWorkbook = buildWorkbook([]);

  const reviewed = await reviewDailyDeals({ storage: sourceStorage(), withScoredDeals: true });

  const sheet = reviewed.review.sources.find((source) => source.id === 'sheet-0');
  assert.equal(sheet.fetched, true);
  assert.equal(sheet.rowCount, 0);
  assertFailClosedReview(reviewed);
  assert.equal(JSON.stringify(reviewed).includes('Deal OS Must Stay Supplemental'), false);
});

test('canonical ingestion retains separate bounded Sheet and Deal OS observations, refreshes the Sheet record, and leaves operator facts untouched', async (t) => {
  // Break caught: canonical ingestion drops source-specific values, grows
  // duplicate observations across refreshes, or rewrites operator facts.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-observations-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const description = 'Commercial HVAC maintenance company with recurring service agreements, trained field technicians, and diversified B2B customers.';
  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Broker Name,Broker Email,Description,Unbounded Workbook Blob',
    `SHEET-42,Observation HVAC Services,https://broker.example/sheet-observation,CA,${new Date().toISOString().slice(0, 10)},450000,1200000,900000,Sheet Broker,sheet@example.test,${description},RAW_WORKBOOK_CONTENT_MUST_NOT_PERSIST`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  dealOsImport = {
    ...freshDealOsImport(),
    id: 'observation-deal-os-import',
    records: [{
      stableId: 'DEAL-OS-42',
      name: 'Observation HVAC Services',
      listingUrl: 'https://broker.example/sheet-observation',
      state: 'CA',
      annualProfit: 455000,
      annualRevenue: 1200000,
      askingPrice: 900000,
      brokerName: 'Deal OS Broker',
      brokerEmail: 'deal-os@example.test',
      description,
      brokerContacts: [],
    }],
  };
  await storage.insertDealHunterDealOsImport(dealOsImport);

  const first = await reviewDailyDeals({ storage, withScoredDeals: true });
  assert.equal(first.review.sources.find((source) => source.id === 'deal-os-export').fetched, true);
  assert.equal(first.scoredDeals.length, 1);
  assert.equal(Object.hasOwn(first.scoredDeals[0], 'sourceObservationDeals'), false);
  assert.deepEqual(new Set(first.scoredDeals[0].sourceRecords.map((record) => record.sourceId)), new Set(['sheet-0', 'deal-os-export']));
  const opportunityId = first.scoredDeals[0].opportunityId;
  assert.ok(opportunityId);
  await setOperatorOpportunityFact({
    opportunityId,
    field: 'seller_name',
    value: 'Operator-verified seller',
    actor: 'acquisition-admin',
    verified: true,
    storage,
  });
  const operatorFactsBeforeRefresh = await storage.listDealHunterOpportunityFacts(opportunityId);

  const firstObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const firstSheetProfit = firstObservations.find((observation) => (
    observation.source_id === 'sheet-0' && observation.field === 'annual_profit'
  ));
  assert.ok(firstSheetProfit);
  assert.doesNotMatch(JSON.stringify(firstObservations), /RAW_WORKBOOK_CONTENT_MUST_NOT_PERSIST/);
  assert.deepEqual(
    firstObservations
      .filter((observation) => observation.field === 'annual_profit')
      .map((observation) => [observation.source_id, observation.value])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ['deal-os-export', '455000'],
      ['sheet-0', '450000'],
    ],
  );

  sourceCsv = sourceCsv.replace(',450000,', ',475000,').replace(',sheet@example.test,', ',,');
  await reviewDailyDeals({ storage, withScoredDeals: true });

  const refreshedObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const refreshedSheetProfit = refreshedObservations.find((observation) => (
    observation.source_id === 'sheet-0' && observation.field === 'annual_profit'
  ));
  assert.equal(refreshedObservations.length, firstObservations.length - 1);
  assert.equal(refreshedSheetProfit.id, firstSheetProfit.id);
  assert.equal(refreshedSheetProfit.created_at, firstSheetProfit.created_at);
  assert.deepEqual(
    refreshedObservations
      .filter((observation) => observation.field === 'annual_profit')
      .map((observation) => [observation.source_id, observation.value])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ['deal-os-export', '455000'],
      ['sheet-0', '475000'],
    ],
  );
  assert.equal(refreshedObservations.some((observation) => (
    observation.source_id === 'sheet-0' && observation.field === 'broker_email'
  )), false);
  assert.deepEqual(await storage.listDealHunterOpportunityFacts(opportunityId), operatorFactsBeforeRefresh);
});

test('a no-explicit-ID Sheet row keeps one source observation snapshot when its listing URL is corrected', async (t) => {
  // Break caught: the supported positional Sheet record shape uses a mutable
  // listing URL as its observation identity and forks observations after the
  // existing canonical resolver has identified the same opportunity.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-sheet-url-correction-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const firstCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Broker Name,Broker Email,Description',
    `No-ID URL Correction HVAC,https://broker.example/no-id-original,CA,${new Date().toISOString().slice(0, 10)},450000,1200000,900000,Sheet Broker,sheet@example.test,Commercial HVAC maintenance company`,
  ].join('\n');
  const correctedCsv = firstCsv.replace('https://broker.example/no-id-original', 'https://broker.example/no-id-corrected');
  const [firstDeal] = parseSheetCsvDeals(firstCsv).deals;
  const [correctedDeal] = parseSheetCsvDeals(correctedCsv).deals;
  const opportunityId = 'opp-no-id-sheet-url-correction';
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: '2026-08-30T12:00:00.000Z',
    updated_at: '2026-08-30T12:00:00.000Z',
    canonical_name: 'No-ID URL Correction HVAC',
    canonical_recipient: null,
    canonical_location: 'CA',
    primary_submission_id: null,
    identity_version: 'test',
    status: 'active',
    metadata: {},
  });
  await storage.replaceDealHunterOpportunitySourceObservationSnapshot(
    buildOpportunitySourceObservationSnapshot({ opportunityId, deal: firstDeal, now: '2026-08-30T12:30:00.000Z' }),
  );
  const firstObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const firstListing = firstObservations.find((observation) => observation.field === 'listing_url');
  assert.equal(firstListing.source_record_id, 'sheet-row:1');

  await storage.replaceDealHunterOpportunitySourceObservationSnapshot(
    buildOpportunitySourceObservationSnapshot({ opportunityId, deal: correctedDeal, now: '2026-08-30T13:30:00.000Z' }),
  );
  const refreshedObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const refreshedListing = refreshedObservations.find((observation) => observation.field === 'listing_url');
  assert.equal(refreshedListing.source_record_id, 'sheet-row:1');
  assert.equal(refreshedListing.id, firstListing.id);
  assert.equal(refreshedListing.value, 'https://broker.example/no-id-corrected');
  assert.equal(refreshedObservations.length, firstObservations.length);
});

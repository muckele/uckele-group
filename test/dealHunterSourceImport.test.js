import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';

process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/test/gviz/tq?tqx=out:csv&gid=123';
process.env.DEAL_HUNTER_AIRTABLE_TOKEN = 'test-token';
process.env.DEAL_HUNTER_AIRTABLE_BASE_ID = 'appTest';
process.env.DEAL_HUNTER_AIRTABLE_TABLE_ID = 'tblTest';
process.env.DEAL_HUNTER_AIRTABLE_VIEW_ID = 'viwTest';

const originalFetch = globalThis.fetch;
const { reviewDailyDeals } = await import('../server/services/dealHunter.js');
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

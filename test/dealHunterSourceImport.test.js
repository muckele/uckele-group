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
  return {};
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
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/gviz/tq')) return new Response(sourceCsv, { status: 200 });
    if (value.includes('/export?')) return new Response(sourceWorkbook, { status: 200 });
    if (value.includes('api.airtable.com')) return Response.json({ records: [] });
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

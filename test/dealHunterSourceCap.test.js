import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';

process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/capped-test/gviz/tq?tqx=out:csv&gid=123';
process.env.DEAL_HUNTER_MAX_SOURCE_RECORDS = '1';
process.env.DEAL_HUNTER_AIRTABLE_TOKEN = 'test-token';
process.env.DEAL_HUNTER_AIRTABLE_BASE_ID = 'appTest';
process.env.DEAL_HUNTER_AIRTABLE_TABLE_ID = 'tblTest';

const originalFetch = globalThis.fetch;
const sourceCsv = [
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

const { reviewDailyDeals } = await import('../server/services/dealHunter.js');

after(() => {
  globalThis.fetch = originalFetch;
});

test('workbook alignment keeps duplicate context beyond the imported record cap', async () => {
  const review = await reviewDailyDeals({ storage: {} });
  const source = review.sources.find((item) => item.id === 'sheet-0');

  assert.equal(source.rowCount, 1);
  assert.equal(source.listingUrlCount, 1);
  assert.equal(source.listingUrlExpectedCount, 1);
  assert.equal(source.listingUrlUnresolvedCount, 0);
  assert.equal(source.listingUrlWarning, '');
});

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
import { refreshOpportunityScores } from '../server/services/dealHunterScoreStore.js';
import { getTriageOpportunityDetail } from '../server/services/dealHunterTriage.js';

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

test('a complete Sheet refresh removes the stale positional observation when a listing moves to a new row', async (t) => {
  // Break caught: a complete Sheet refresh treats a position-derived source
  // record as independently current after the same listing moves rows, so the
  // old value remains authoritative and conflicts with the refreshed value.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-sheet-row-movement-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const observedDate = new Date().toISOString().slice(0, 10);
  const moverListingUrl = 'https://broker.example/listings/moving-hvac';
  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Moving HVAC Services,${moverListingUrl},CA,${observedDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  dealOsImport = {
    ...freshDealOsImport(),
    id: 'row-movement-deal-os-import',
    records: [{
      stableId: 'DEAL-OS-MOVING-HVAC',
      name: 'Moving HVAC Services',
      listingUrl: moverListingUrl,
      state: 'CA',
      annualProfit: 455000,
      annualRevenue: 1200000,
      askingPrice: 900000,
      description: 'Commercial HVAC maintenance with recurring service agreements.',
      brokerContacts: [],
    }],
  };
  await storage.insertDealHunterDealOsImport(dealOsImport);

  const firstRefresh = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'sheet-row-movement-test' });
  assert.equal(firstRefresh.ok, true);
  const [firstOpportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((opportunity) => opportunity.metadata?.identitySnapshot?.listingUrl === moverListingUrl);
  assert.ok(firstOpportunity, 'the first full refresh resolves a canonical opportunity by listing identity');
  const opportunityId = firstOpportunity.opportunity_id;
  const aliases = await storage.listDealHunterOpportunityAliases({ opportunityIds: [opportunityId], limit: 20 });
  assert.equal(
    aliases.some((alias) => alias.alias_type === 'listing-url' && alias.alias_value === moverListingUrl),
    true,
    'the reproduction is anchored by the durable listing identity, not business name or location matching',
  );
  const firstObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  assert.deepEqual(
    firstObservations.filter((observation) => observation.source_id === 'sheet-0' && observation.field === 'annual_profit')
      .map((observation) => [observation.source_record_id, observation.value]),
    [['sheet-row:1', '450000']],
  );

  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Inserted Roofing,https://broker.example/listings/inserted-roofing,TX,${observedDate},300000,1000000,700000,Commercial roofing repair company with contracted work.`,
    `Moving HVAC Services,${moverListingUrl},CA,${observedDate},475000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  const secondRefresh = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'sheet-row-movement-test' });
  assert.equal(secondRefresh.ok, true);

  const [refreshedOpportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((opportunity) => opportunity.metadata?.identitySnapshot?.listingUrl === moverListingUrl);
  assert.equal(refreshedOpportunity.opportunity_id, opportunityId, 'the listing remains the same canonical opportunity after row movement');
  const refreshedObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  assert.deepEqual(
    refreshedObservations.filter((observation) => observation.source_id === 'sheet-0' && observation.field === 'annual_profit')
      .map((observation) => [observation.source_record_id, observation.value]),
    [['sheet-row:2', '475000']],
    'only the moved Sheet row contributes the refreshed profit',
  );
  assert.equal(refreshedObservations.length, firstObservations.length, 'the complete refresh does not grow durable current observations');
  assert.equal(
    refreshedObservations.some((observation) => observation.source_id === 'deal-os-export' && observation.field === 'annual_profit' && observation.value === '455000'),
    true,
    'the unrelated Deal OS observation remains current',
  );

  const detail = await getTriageOpportunityDetail({ opportunityId, storage });
  assert.equal(detail.ok, true);
  const sheetGroups = detail.sourceObservations.filter((source) => source.sourceId === 'sheet-0');
  assert.equal(sheetGroups.length, 1, 'only one current Sheet source record remains in the authoritative detail projection');
  assert.equal(sheetGroups[0].sourceRecordId, 'sheet-row:2');
  const profitConflict = sheetGroups[0].conflicts.find((conflict) => conflict.field === 'annual_profit');
  assert.ok(profitConflict, 'the current Sheet and Deal OS values remain visibly attributable as a real cross-source conflict');
  assert.equal(
    profitConflict.observations.some((observation) => observation.value === '450000'),
    false,
    'the stale pre-move Sheet value no longer participates in current conflict authority',
  );
});

test('a complete Sheet refresh removes observations for a business absent from the authoritative source while preserving Deal OS', async (t) => {
  // Break caught: reconciling only canonical opportunities still represented
  // by the new Sheet leaves a fully removed business's old Sheet source rows
  // current forever. A proven complete source snapshot must remove every stale
  // `(opportunity, source-record, field)` triple for that source ID.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-sheet-removed-business-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const currentDate = new Date().toISOString().slice(0, 10);
  const retainedListingUrl = 'https://broker.example/listings/retained-hvac';
  const removedListingUrl = 'https://broker.example/listings/removed-plumbing';
  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Retained HVAC Services,${retainedListingUrl},CA,${currentDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
    `Removed Plumbing Services,${removedListingUrl},TX,${currentDate},500000,1500000,1000000,Commercial plumbing maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  dealOsImport = {
    ...freshDealOsImport(),
    id: 'removed-sheet-business-deal-os-import',
    records: [{
      stableId: 'DEAL-OS-REMOVED-PLUMBING',
      name: 'Removed Plumbing Services',
      listingUrl: removedListingUrl,
      state: 'TX',
      annualProfit: 505000,
      annualRevenue: 1500000,
      askingPrice: 1000000,
      description: 'Commercial plumbing maintenance with recurring service agreements.',
      brokerContacts: [],
    }],
  };
  await storage.insertDealHunterDealOsImport(dealOsImport);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'removed-sheet-business-test' })).ok, true);

  const [removedOpportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((opportunity) => opportunity.metadata?.identitySnapshot?.listingUrl === removedListingUrl);
  assert.ok(removedOpportunity, 'the first complete source run resolves the later-removed business by durable listing identity');
  const before = await storage.listDealHunterOpportunitySourceObservations(removedOpportunity.opportunity_id);
  assert.equal(before.some((observation) => observation.source_id === 'sheet-0'), true);
  assert.equal(before.some((observation) => observation.source_id === 'deal-os-export' && observation.value === '505000'), true);

  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Retained HVAC Services,${retainedListingUrl},CA,${currentDate},475000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  const refreshed = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'removed-sheet-business-test' });
  assert.equal(refreshed.ok, true);

  const after = await storage.listDealHunterOpportunitySourceObservations(removedOpportunity.opportunity_id);
  assert.equal(
    after.some((observation) => observation.source_id === 'sheet-0'),
    false,
    'the complete current Sheet snapshot removes source evidence for an absent business',
  );
  assert.equal(
    after.some((observation) => observation.source_id === 'deal-os-export' && observation.value === '505000'),
    true,
    'the source-wide deletion boundary excludes the unrelated Deal OS source ID',
  );
});

test('an incremental Sheet review preserves observations outside its partial candidate set', async (t) => {
  // Break caught: source-wide reconciliation runs for a partial/incremental
  // review and deletes a valid Sheet observation the run did not represent.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-incremental-sheet-observations-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const currentDate = new Date().toISOString().slice(0, 10);
  const olderListingUrl = 'https://broker.example/listings/older-preserved';
  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Fresh HVAC Services,https://broker.example/listings/fresh-hvac,CA,${currentDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
    `Older Plumbing Services,${olderListingUrl},CA,2020-01-01,500000,1500000,1000000,Commercial plumbing maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'partial-sheet-test' })).ok, true);
  const [olderOpportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((opportunity) => opportunity.metadata?.identitySnapshot?.listingUrl === olderListingUrl);
  assert.ok(olderOpportunity);
  const before = await storage.listDealHunterOpportunitySourceObservations(olderOpportunity.opportunity_id);
  assert.ok(before.length > 0);

  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Fresh HVAC Services,https://broker.example/listings/fresh-hvac,CA,${currentDate},475000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  const incremental = await refreshOpportunityScores({ storage, reviewMode: 'daily', actor: 'partial-sheet-test' });
  assert.equal(incremental.ok, true);
  assert.deepEqual(
    await storage.listDealHunterOpportunitySourceObservations(olderOpportunity.opportunity_id),
    before,
    'a non-complete review does not erase the valid older Sheet source record it did not carry',
  );
});

test('a full Sheet refresh with an unresolved row leaves its prior Sheet observation snapshot intact', async (t) => {
  // Break caught: a source-wide delete proceeds when one authoritative Sheet
  // row lacks durable identity evidence, discarding valid prior observations;
  // record-by-record writes would also leave a hybrid snapshot behind.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-partial-identity-sheet-observations-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const currentDate = new Date().toISOString().slice(0, 10);
  const moverListingUrl = 'https://broker.example/listings/identity-gated-hvac';
  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Identity Gated HVAC,${moverListingUrl},CA,${currentDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'partial-identity-test' })).ok, true);
  const [moverOpportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((opportunity) => opportunity.metadata?.identitySnapshot?.listingUrl === moverListingUrl);
  assert.ok(moverOpportunity);
  const before = await storage.listDealHunterOpportunitySourceObservations(moverOpportunity.opportunity_id);

  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Identity Missing Listing,,TX,${currentDate},300000,1000000,700000,Short description.`,
    `Identity Gated HVAC,${moverListingUrl},CA,${currentDate},475000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  const partialIdentity = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'partial-identity-test' });
  assert.equal(partialIdentity.ok, false);
  assert.equal(partialIdentity.status, 409);
  assert.deepEqual(
    await storage.listDealHunterOpportunitySourceObservations(moverOpportunity.opportunity_id),
    before,
    'an unresolved authoritative Sheet row prevents both stale deletion and a hybrid replacement for that source',
  );
});

test('a complete Sheet payload with duplicate stable source-record identities fails closed before any Sheet observation write', async (t) => {
  // Break caught: duplicate stable Listing IDs make the raw source identity
  // set ambiguous. A full backfill must defer/fail rather than write one row
  // while deleting or updating the last-known-good snapshot for another.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-duplicate-stable-sheet-observations-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const currentDate = new Date().toISOString().slice(0, 10);
  const listingUrl = 'https://broker.example/listings/duplicate-stable-sheet-hvac';
  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `SHEET-STABLE-42,Duplicate Stable HVAC,${listingUrl},CA,${currentDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  const initial = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'duplicate-stable-sheet-test' });
  assert.equal(initial.ok, true);
  const [opportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((item) => item.metadata?.identitySnapshot?.listingUrl === listingUrl);
  assert.ok(opportunity);
  const before = await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id);
  assert.ok(before.some((observation) => observation.source_id === 'sheet-0'));

  sourceCsv = [
    'Listing ID,Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `SHEET-STABLE-42,Duplicate Stable HVAC,${listingUrl},CA,${currentDate},475000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
    `SHEET-STABLE-42,Duplicate Stable Plumbing,https://broker.example/listings/duplicate-stable-sheet-plumbing,TX,${currentDate},500000,1500000,1000000,Commercial plumbing maintenance with recurring service agreements.`,
  ].join('\n');
  const duplicate = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'duplicate-stable-sheet-test' });

  assert.equal(duplicate.ok, false, 'a successfully fetched but duplicate-identity Sheet cannot authorize a complete snapshot');
  assert.equal(duplicate.status, 503, 'the admission proof fails closed before a full-backfill score write');
  assert.equal(duplicate.scoringDeferred, true);
  assert.deepEqual(duplicate.review.sourceSnapshotAdmissionDeferredSources, ['sheet-0']);
  assert.equal(
    duplicate.review.sources.find((source) => source.id === 'sheet-0')?.fetched,
    true,
    'the rejection is an identity/admission failure, not a source collection failure',
  );
  assert.deepEqual(
    await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id),
    before,
    'the last-known-good Sheet observations remain byte-for-byte unchanged with no partial source write',
  );
});

test('a failed complete Sheet collection leaves current source observations untouched', async (t) => {
  // Break caught: a failed collection is interpreted as an empty complete
  // source snapshot and deletes the last known-good source observations.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-hunter-failed-sheet-observations-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'observations.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const currentDate = new Date().toISOString().slice(0, 10);
  const listingUrl = 'https://broker.example/listings/failed-collection-hvac';
  sourceCsv = [
    'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description',
    `Failed Collection HVAC,${listingUrl},CA,${currentDate},450000,1200000,900000,Commercial HVAC maintenance with recurring service agreements.`,
  ].join('\n');
  sourceWorkbook = buildWorkbook([]);
  assert.equal((await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'failed-sheet-test' })).ok, true);
  const [opportunity] = (await storage.listCurrentDealHunterOpportunities({ limit: 20 }))
    .filter((item) => item.metadata?.identitySnapshot?.listingUrl === listingUrl);
  const before = await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id);

  sheetFetchStatus = 503;
  const failed = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'failed-sheet-test' });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 503);
  assert.deepEqual(await storage.listDealHunterOpportunitySourceObservations(opportunity.opportunity_id), before);
});

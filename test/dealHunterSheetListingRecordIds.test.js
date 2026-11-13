// A Sheet row without an ID column is keyed by its listing link, not by its position.
//
// The main Google Sheet has no ID column, and listings are added and removed above each other
// every day. Keyed by position (`sheet-row:<n>`), every shifted row read as a changed record plus
// a removal of the old association, so each daily refresh churned freshness evidence and CIM
// safety events and held every Pursue campaign whose row moved. A row is now keyed by its
// normalized listing URL (`listing:<digest>`); a second row with the same URL in one collection
// is `listing:<digest>#2` (sheet order); a row with no URL keeps its position.
//
// Real SQLite and the real daily path: `refreshOpportunityScores` in full-backfill mode, which the
// daily Sheet sync calls, with the Sheet CSV and workbook served by a stubbed fetch.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';

process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/test/gviz/tq?tqx=out:csv&gid=123';
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { refreshOpportunityScores } = await import('../server/services/dealHunterScoreStore.js');
const { parseSheetCsvDeals } = await import('../server/services/dealHunter.js');
const { buildOpportunitySourceObservationSnapshot, getOpportunitySourceObservationRecordId } = await import(
  '../server/services/dealHunterOpportunityFacts.js');
const { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } = await import(
  '../server/services/dealHunterSourceSnapshotAdmission.js');

const originalFetch = globalThis.fetch;
let sourceCsv = '';
let sourceWorkbook = null;
let sourceWorkbookStatus = 200;

beforeEach(() => {
  sourceCsv = '';
  sourceWorkbook = zipSync({});
  sourceWorkbookStatus = 200;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/gviz/tq')) return new Response(sourceCsv, { status: 200 });
    if (value.includes('/export?')) {
      return sourceWorkbookStatus === 200 ? new Response(sourceWorkbook, { status: 200 })
        : new Response('Internal error', { status: sourceWorkbookStatus });
    }
    return new Response('not found', { status: 404 });
  };
});
after(() => { globalThis.fetch = originalFetch; });

const TODAY = new Date().toISOString().slice(0, 10);
const HEADER = 'Business Name,Listing URL,State,Date Added,Annual Profit,Annual Revenue,Asking Price,Description';

/** Distinct businesses, so canonical dedupe never folds two of them together. */
const LISTINGS = Object.freeze({
  hvac: { name: 'Harbor HVAC Services', url: 'https://broker.example/listings/harbor-hvac', state: 'CA',
    profit: 450000, revenue: 1200000, price: 900000,
    description: 'Commercial HVAC maintenance with recurring service agreements.' },
  roofing: { name: 'Summit Roofing Company', url: 'https://broker.example/listings/summit-roofing', state: 'TX',
    profit: 300000, revenue: 1000000, price: 700000,
    description: 'Commercial roofing repair company with contracted work.' },
  plumbing: { name: 'Delta Plumbing Group', url: 'https://broker.example/listings/delta-plumbing', state: 'AZ',
    profit: 520000, revenue: 1500000, price: 1100000,
    description: 'Residential plumbing service and repair with a dispatch team.' },
  landscaping: { name: 'Evergreen Landscaping', url: 'https://broker.example/listings/evergreen-landscaping', state: 'OR',
    profit: 210000, revenue: 800000, price: 500000,
    description: 'Commercial landscaping maintenance under annual contracts.' },
});

function row(listing, overrides = {}) {
  const item = { ...listing, ...overrides };
  return [item.name, item.url, item.state, TODAY, item.profit, item.revenue, item.price, item.description].join(',');
}

const sheet = (...rows) => [HEADER, ...rows].join('\n');
const listingRecordId = (url) => `listing:${createHash('sha256')
  .update(url.replace(/^https:\/\//, '')).digest('hex').slice(0, 40)}`;

/** An xlsx export whose column B holds each row's "View Listing" hyperlink. */
function viewListingWorkbook(rows) {
  const cells = rows.map(({ name, url }, index) => {
    const at = index + 2;
    return `<row r="${at}"><c r="A${at}" t="inlineStr"><is><t>${name}</t></is></c>`
      + `<c r="B${at}" t="str"><f>HYPERLINK(&quot;${url}&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c></row>`;
  }).join('');
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>View Listing</t></is></c></row>',
    cells, '</sheetData></worksheet>',
  ].join('')) });
}

function createWorld(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-sheet-listing-ids-'));
  const sqlitePath = path.join(directory, 'storage.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  const db = new Database(sqlitePath);
  t.after(() => {
    db.close();
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { storage, db };
}

/** One daily Sheet sync over `csv`; returns the source run it accepted. */
async function dailySync({ storage, db }, csv) {
  sourceCsv = csv;
  const result = await refreshOpportunityScores({ storage, reviewMode: 'full-backfill', actor: 'sheet-listing-ids-test' });
  assert.equal(result.ok, true, JSON.stringify(result.error || result.review?.sources));
  const state = db.prepare(`SELECT accepted_run_id, projection_state FROM deal_hunter_source_freshness_state
    WHERE source_id = 'sheet-0'`).get();
  assert.equal(state.projection_state, 'accepted', 'the complete Sheet was admitted');
  return state.accepted_run_id;
}

/** Each current Sheet record: listing URL -> record id and opportunity. */
function sheetRecords(db) {
  return Object.fromEntries(db.prepare(`SELECT opportunity_id, source_record_id, value
    FROM deal_hunter_opportunity_source_observations
    WHERE source_id = 'sheet-0' AND field = 'listing_url' ORDER BY source_record_id`).all()
    .map((item) => [item.value, { recordId: item.source_record_id, opportunityId: item.opportunity_id }]));
}

/** The records a run wrote new core evidence for, i.e. saw as changed. */
function changedRecords(db, runId) {
  return db.prepare(`SELECT source_record_id FROM deal_hunter_freshness_evidence
    WHERE run_id = ? AND event_type = 'accepted_source_record' AND field_key = ''
    ORDER BY source_record_id`).all(runId).map((item) => item.source_record_id);
}

/** The run's safety events per classification, as [opportunity, classification]. */
function safetyEvents(db, runId) {
  return db.prepare(`SELECT opportunity_id, event_type FROM deal_hunter_cim_safety_events
    WHERE source_run_id = ? ORDER BY opportunity_id, event_type`).all(runId)
    .map((item) => [item.opportunity_id, item.event_type.split('#')[0]]);
}

function countOf(events, classification) {
  return events.filter(([, type]) => type === classification).length;
}

test('a listing inserted above an unchanged listing keeps its record id, evidence and safety', async (t) => {
  const world = createWorld(t);
  await dailySync(world, sheet(row(LISTINGS.hvac), row(LISTINGS.roofing)));
  const before = sheetRecords(world.db);
  assert.equal(before[LISTINGS.hvac.url].recordId, listingRecordId(LISTINGS.hvac.url));

  const runId = await dailySync(world, sheet(row(LISTINGS.plumbing), row(LISTINGS.hvac), row(LISTINGS.roofing)));
  const afterInsert = sheetRecords(world.db);
  assert.deepEqual(afterInsert[LISTINGS.hvac.url], before[LISTINGS.hvac.url]);
  assert.deepEqual(afterInsert[LISTINGS.roofing.url], before[LISTINGS.roofing.url]);
  assert.deepEqual(changedRecords(world.db, runId), [listingRecordId(LISTINGS.plumbing.url)],
    'only the inserted listing is new core evidence');
  const events = safetyEvents(world.db, runId);
  assert.equal(countOf(events, 'source-record-removed'), 0, JSON.stringify(events));
  assert.equal(countOf(events, 'source-record-changed'), 1, JSON.stringify(events));
  assert.equal(countOf(events, 'source-record-unchanged'), 2, JSON.stringify(events));
  for (const listing of [LISTINGS.hvac, LISTINGS.roofing]) {
    assert.deepEqual(events.filter(([opportunityId]) => opportunityId === before[listing.url].opportunityId),
      [[before[listing.url].opportunityId, 'source-record-unchanged']]);
  }
});

test('re-ordered Sheet rows keep their record ids, evidence and safety', async (t) => {
  const world = createWorld(t);
  await dailySync(world, sheet(row(LISTINGS.hvac), row(LISTINGS.roofing), row(LISTINGS.plumbing)));
  const before = sheetRecords(world.db);

  const runId = await dailySync(world, sheet(row(LISTINGS.plumbing), row(LISTINGS.hvac), row(LISTINGS.roofing)));
  assert.deepEqual(sheetRecords(world.db), before);
  assert.deepEqual(changedRecords(world.db, runId), []);
  const events = safetyEvents(world.db, runId);
  assert.deepEqual([countOf(events, 'source-record-removed'), countOf(events, 'source-record-changed'),
    countOf(events, 'source-record-unchanged')], [0, 0, 3], JSON.stringify(events));
});

test('two rows sharing a listing URL get distinct ids that stay put when a third row moves', async (t) => {
  const world = createWorld(t);
  const shared = LISTINGS.hvac.url;
  // The same listing posted twice, with a different asking price on the repost.
  const first = row(LISTINGS.hvac);
  const repost = row(LISTINGS.hvac, { price: 950000 });
  await dailySync(world, sheet(first, row(LISTINGS.roofing), repost, row(LISTINGS.plumbing)));
  const ids = () => world.db.prepare(`SELECT source_record_id, value FROM deal_hunter_opportunity_source_observations
    WHERE source_id = 'sheet-0' AND field = 'asking_price' AND source_record_id LIKE ? ORDER BY source_record_id`)
    .all(`${listingRecordId(shared)}%`).map((item) => [item.source_record_id, item.value]);
  assert.deepEqual(ids(), [[listingRecordId(shared), '900000'], [`${listingRecordId(shared)}#2`, '950000']],
    'the first row in sheet order keeps the plain id; the repost is #2');

  const runId = await dailySync(world, sheet(row(LISTINGS.plumbing), first, row(LISTINGS.roofing), repost));
  assert.deepEqual(ids(), [[listingRecordId(shared), '900000'], [`${listingRecordId(shared)}#2`, '950000']]);
  assert.deepEqual(changedRecords(world.db, runId), []);
  assert.equal(countOf(safetyEvents(world.db, runId), 'source-record-removed'), 0);
});

test('a Sheet record id ignores cosmetic URL drift but never merges different listings', () => {
  // Keyed by the listing identity the canonical aliases use: `www.`, host and path case, a
  // trailing slash and tracking parameters never rename a record.
  const base = 'https://broker.example/listings/harbor-hvac';
  const idOf = (url) => getOpportunitySourceObservationRecordId(
    parseSheetCsvDeals(sheet(row(LISTINGS.hvac, { url }))).deals[0]);
  for (const variant of [
    'https://www.broker.example/listings/harbor-hvac',
    'https://Broker.Example/listings/harbor-hvac/',
    'http://broker.example/listings/harbor-hvac',
    'https://broker.example/listings/harbor-hvac?utm_source=sheet&fbclid=abc',
  ]) assert.equal(idOf(variant), listingRecordId(base), variant);
  assert.notEqual(idOf('https://broker.example/listings/harbor-hvac-2'), listingRecordId(base));
  assert.notEqual(idOf('https://broker.example/listings/harbor-hvac?id=2'), listingRecordId(base));
  assert.notEqual(idOf('https://other-broker.example/listings/harbor-hvac'), listingRecordId(base));

  // Two cosmetic variants of one link in one collection are one listing posted twice: distinct ids.
  const deals = parseSheetCsvDeals(sheet(row(LISTINGS.hvac), row(LISTINGS.roofing),
    row(LISTINGS.hvac, { url: 'https://www.broker.example/listings/harbor-hvac/?utm_medium=email' }))).deals;
  assert.deepEqual(deals.map(getOpportunitySourceObservationRecordId), [listingRecordId(base),
    listingRecordId(LISTINGS.roofing.url), `${listingRecordId(base)}#2`]);
});

test('a View Listing hyperlink recovered from the workbook keys the record', async (t) => {
  const world = createWorld(t);
  const alpha = { name: 'Alpha HVAC', url: 'https://broker.example/alpha' };
  const beta = { name: 'Beta Plumbing', url: 'https://broker.example/beta' };
  sourceWorkbook = viewListingWorkbook([alpha]);
  await dailySync(world, ['Name,View Listing', 'Alpha HVAC,View Listing'].join('\n'));
  const before = sheetRecords(world.db);
  assert.equal(before[alpha.url].recordId, listingRecordId(alpha.url));

  sourceWorkbook = viewListingWorkbook([beta, alpha]);
  const runId = await dailySync(world, ['Name,View Listing', 'Beta Plumbing,View Listing', 'Alpha HVAC,View Listing'].join('\n'));
  assert.deepEqual(sheetRecords(world.db)[alpha.url], before[alpha.url]);
  assert.deepEqual(changedRecords(world.db, runId), [listingRecordId(beta.url)]);
  assert.equal(countOf(safetyEvents(world.db, runId), 'source-record-removed'), 0);
});

const RICH = 'Established operator with trained staff and documented processes and a diversified customer '
  + 'base and steady repeat demand across the region.';
const viewListingSheet = (...names) => ['Name,View Listing,City,State,Annual Profit,Annual Revenue,Asking Price,Description,Broker Name,Broker Email',
  ...names.map((name, index) => [name, 'View Listing', 'Sacramento', 'CA', 400000 + index * 1000, 1200000, 900000,
    `${name} company. ${RICH}`, `Broker ${index}`, `broker${index}@brokerage${index}.test`].join(','))].join('\n');

test('a workbook outage defers a Sheet whose links exist only as workbook hyperlinks', async (t) => {
  const world = createWorld(t);
  const alpha = { name: 'Alpha HVAC', url: 'https://broker.example/alpha' };
  sourceWorkbook = viewListingWorkbook([alpha]);
  const runId = await dailySync(world, viewListingSheet(alpha.name));
  const before = sheetRecords(world.db);

  sourceWorkbookStatus = 500;
  sourceCsv = viewListingSheet(alpha.name);
  const result = await refreshOpportunityScores({ storage: world.storage, reviewMode: 'full-backfill', actor: 'outage' });
  assert.equal(result.ok, false);
  const source = result.review.sources.find((item) => item.id === 'sheet-0');
  assert.deepEqual([source.fetched, source.listingUrlSourceUnavailable, source.listingUrlExpectedCount,
    source.listingUrlCount], [true, true, 1, 0]);
  assert.match(source.error, /workbook could not be read, so 1 listing link could not be recovered; the Sheet is deferred/);
  assert.deepEqual(sheetRecords(world.db), before);
  assert.equal(world.db.prepare(`SELECT accepted_run_id FROM deal_hunter_source_freshness_state
    WHERE source_id = 'sheet-0'`).get().accepted_run_id, runId);
});

test('a workbook outage does not defer a Sheet whose rows carry their links in the CSV', async (t) => {
  const world = createWorld(t);
  sourceWorkbookStatus = 500;
  sourceCsv = sheet(row(LISTINGS.hvac), row(LISTINGS.roofing));
  const result = await refreshOpportunityScores({ storage: world.storage, reviewMode: 'full-backfill', actor: 'outage' });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const source = result.review.sources.find((item) => item.id === 'sheet-0');
  assert.deepEqual([source.listingUrlSourceUnavailable, Boolean(source.error), Boolean(source.listingUrlWarning)],
    [false, false, true]);
  assert.equal(sheetRecords(world.db)[LISTINGS.hvac.url].recordId, listingRecordId(LISTINGS.hvac.url));
});

test('a row whose hyperlink cannot be aligned keeps its position while the workbook loaded', async (t) => {
  // The workbook loaded but holds no hyperlink for Beta: an isolated row, not an outage. It keeps
  // the positional fallback and the Sheet is admitted.
  const world = createWorld(t);
  const alpha = { name: 'Alpha HVAC', url: 'https://broker.example/alpha' };
  sourceWorkbook = viewListingWorkbook([alpha]);
  sourceCsv = viewListingSheet(alpha.name, 'Beta Plumbing');
  const result = await refreshOpportunityScores({ storage: world.storage, reviewMode: 'full-backfill', actor: 'align' });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const source = result.review.sources.find((item) => item.id === 'sheet-0');
  assert.deepEqual([source.listingUrlSourceUnavailable, Boolean(source.error), source.listingUrlUnresolvedCount],
    [false, false, 1]);
  assert.match(source.listingUrlWarning, /1 imported CSV row displays a View Listing label/);
  assert.deepEqual(world.db.prepare(`SELECT DISTINCT source_record_id FROM deal_hunter_opportunity_source_observations
    WHERE source_id = 'sheet-0' ORDER BY source_record_id`).all().map((item) => item.source_record_id),
  [listingRecordId(alpha.url), 'sheet-row:2']);
});

// ---------------------------------------------------------------------------------------------
// The one-time switch from `sheet-row:<n>` to `listing:<digest>` on the first refresh after deploy.
//
// The data under the old scheme is written through the same storage admission, with records
// keyed exactly as origin/main keyed them: `sheet-row:<position>` for every row without an ID
// column. The admission's identity check reads only the collected rows' source and position, so
// rows that carry no URL to it reproduce origin/main's identity view of the same Sheet.
// ---------------------------------------------------------------------------------------------

const OPPORTUNITY_FOR = Object.freeze({
  [LISTINGS.hvac.url]: 'opp-switch-hvac',
  [LISTINGS.roofing.url]: 'opp-switch-roofing',
  [LISTINGS.plumbing.url]: 'opp-switch-plumbing',
  [LISTINGS.landscaping.url]: 'opp-switch-landscaping',
});

function oldSchemeSnapshot(snapshot, deal) {
  const recordId = `sheet-row:${deal.sourceRowId}`;
  return {
    ...snapshot,
    source_record_id: recordId,
    observations: snapshot.observations.map((observation) => ({
      ...observation,
      id: `source-observation:${createHash('sha256').update([observation.opportunity_id, observation.source_id,
        recordId, observation.field].join('\u0000')).digest('hex')}`,
      source_record_id: recordId,
    })),
  };
}

async function seedOpportunities({ storage }, createdAt) {
  for (const [url, opportunityId] of Object.entries(OPPORTUNITY_FOR)) {
    await storage.upsertDealHunterOpportunity({ opportunity_id: opportunityId, created_at: createdAt,
      updated_at: createdAt, canonical_name: url, identity_version: 'test', status: 'active', metadata: {} });
    await storage.markDealHunterOpportunityDiscoveryPending({ opportunityId, createdAt });
  }
}

/**
 * One complete Sheet sync through the storage admission the daily sync uses once identities
 * resolve; `scheme: 'old'` keys each record as origin/main did. `deferred` holds one listing on
 * an open identity exception, as a Sheet with an ambiguous row is admitted.
 */
async function admittedSync({ storage }, csv, { runId, scheme = 'new', at, deferred = null,
  opportunityFor = (deal) => OPPORTUNITY_FOR[deal.listingUrl] } = {}) {
  const deals = parseSheetCsvDeals(csv).deals;
  const records = [];
  const unresolved = [];
  for (const deal of deals) {
    if (deferred && deal.listingUrl === deferred.url) {
      unresolved.push({ source_record_id: scheme === 'old' ? `sheet-row:${deal.sourceRowId}`
        : getOpportunitySourceObservationRecordId(deal), identity_exception_id: deferred.exceptionId,
      freshness_evidence: deal.freshnessEvidence });
      continue;
    }
    const snapshot = buildOpportunitySourceObservationSnapshot({ opportunityId: opportunityFor(deal),
      deal, now: at });
    records.push(scheme === 'old' ? oldSchemeSnapshot(snapshot, deal) : snapshot);
  }
  const identityDeals = scheme === 'old'
    ? deals.map((deal) => ({ sourceId: deal.sourceId, sourceName: deal.sourceName,
      idFromSourceRowPosition: deal.idFromSourceRowPosition, sourceRowId: deal.sourceRowId }))
    : deals;
  const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId });
  const result = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({ storage, reviewMode: 'full-backfill',
    sourceResult: { source: { id: 'sheet-0', required: true, fetched: true, sourceRowCount: deals.length,
      rowCount: deals.length, coverageLimitReached: false }, deals: identityDeals },
    records, unresolved, run });
  assert.equal(result.reconciled, true, JSON.stringify(result));
  return result;
}

test('a Sheet row without a listing URL falls back to its sheet position', async (t) => {
  // Whether the full review resolves a row with no link depends on its content (a full
  // fingerprint resolves; this short row does not, and the review holds the run, as on
  // origin/main), so the record is admitted as the daily sync admits it once its identity
  // resolves.
  const world = createWorld(t);
  const csv = sheet(row(LISTINGS.hvac), row(LISTINGS.roofing, { url: '' }));
  const [linked, unlinked] = parseSheetCsvDeals(csv).deals;
  assert.equal(getOpportunitySourceObservationRecordId(linked), listingRecordId(LISTINGS.hvac.url));
  assert.equal(getOpportunitySourceObservationRecordId(unlinked), 'sheet-row:2');
  assert.equal(unlinked.sourceListingOccurrence, undefined);

  const at = '2030-01-05T16:00:00.000Z';
  await seedOpportunities(world, at);
  await admittedSync(world, csv, { runId: 'unlinked', at,
    opportunityFor: (deal) => (deal.listingUrl ? OPPORTUNITY_FOR[deal.listingUrl] : OPPORTUNITY_FOR[LISTINGS.roofing.url]) });
  assert.deepEqual(world.db.prepare(`SELECT DISTINCT source_record_id FROM deal_hunter_opportunity_source_observations
    WHERE source_id = 'sheet-0' ORDER BY source_record_id`).all().map((item) => item.source_record_id),
  [listingRecordId(LISTINGS.hvac.url), 'sheet-row:2']);
});

function discovery(db) {
  return db.prepare(`SELECT opportunity_id, first_accepted_at, discovery_state, discovery_revision,
    first_discovery_evidence_id, material_revision FROM deal_hunter_opportunities ORDER BY opportunity_id`).all();
}

test('the first refresh after deploy switches every Sheet record to its listing id once, then settles', async (t) => {
  const world = createWorld(t);
  const { storage, db } = world;
  const at = '2030-01-05T16:00:00.000Z';
  await seedOpportunities(world, at);
  const oldOrder = sheet(row(LISTINGS.hvac), row(LISTINGS.roofing), row(LISTINGS.plumbing));
  await admittedSync(world, oldOrder, { runId: 'old-scheme-1', scheme: 'old', at });
  // Listings shift under the old scheme: positions now point at different deals.
  await admittedSync(world, sheet(row(LISTINGS.roofing), row(LISTINGS.hvac), row(LISTINGS.plumbing)),
    { runId: 'old-scheme-2', scheme: 'old', at });
  assert.deepEqual(Object.values(sheetRecords(db)).map((item) => item.recordId).sort(),
    ['sheet-row:1', 'sheet-row:2', 'sheet-row:3']);
  const discoveryBefore = discovery(db);
  assert.ok(discoveryBefore.every((item) => item.discovery_state === 'known_prospective' && item.first_accepted_at
    || item.opportunity_id === OPPORTUNITY_FOR[LISTINGS.landscaping.url]), JSON.stringify(discoveryBefore));

  // (a) The switch succeeds through every bound: complete admission, safety cap, bounded reads.
  const switched = await admittedSync(world, sheet(row(LISTINGS.roofing), row(LISTINGS.hvac), row(LISTINGS.plumbing)),
    { runId: 'switch', at });
  const records = sheetRecords(db);
  for (const listing of [LISTINGS.hvac, LISTINGS.roofing, LISTINGS.plumbing]) {
    assert.deepEqual(records[listing.url], { recordId: listingRecordId(listing.url),
      opportunityId: OPPORTUNITY_FOR[listing.url] });
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM deal_hunter_opportunity_source_observations
    WHERE source_id = 'sheet-0' AND source_record_id LIKE 'sheet-row:%'`).get().n, 0, 'no old-scheme row survives');
  const switchEvents = safetyEvents(db, 'switch');
  assert.deepEqual([countOf(switchEvents, 'source-record-changed'), countOf(switchEvents, 'source-record-removed'),
    countOf(switchEvents, 'source-record-unchanged')], [3, 3, 0], JSON.stringify(switchEvents));
  assert.equal(switched.safetyEventsEmitted, 6, 'one change and one removal per record, far below the 10,000 cap');
  for (const opportunityId of Object.values(OPPORTUNITY_FOR).slice(0, 3)) {
    const rows = await storage.listDealHunterOpportunitySourceObservations(opportunityId, { limit: 500 });
    assert.ok(rows.length > 0 && rows.length < 500, `${opportunityId} reads within the 500-row bound`);
    assert.ok(rows.every((item) => item.source_record_id.startsWith('listing:')));
  }

  // (b) Discovery dates survive: an already-accepted opportunity keeps its first acceptance.
  assert.deepEqual(discovery(db), discoveryBefore);

  // (c) The next refresh of the same content, re-ordered and with a listing inserted at the top,
  // sees no changed record and no removal for any switched listing.
  const settled = await admittedSync(world, sheet(row(LISTINGS.landscaping), row(LISTINGS.plumbing),
    row(LISTINGS.hvac), row(LISTINGS.roofing)), { runId: 'after-switch', at });
  assert.deepEqual(changedRecords(db, 'after-switch'), [listingRecordId(LISTINGS.landscaping.url)]);
  const settledEvents = safetyEvents(db, 'after-switch');
  assert.deepEqual([countOf(settledEvents, 'source-record-changed'), countOf(settledEvents, 'source-record-removed'),
    countOf(settledEvents, 'source-record-unchanged')], [1, 0, 3], JSON.stringify(settledEvents));
  assert.equal(settled.safetyEventsEmitted, 4);
  assert.deepEqual(discovery(db).filter((item) => item.opportunity_id !== OPPORTUNITY_FOR[LISTINGS.landscaping.url]),
    discoveryBefore.filter((item) => item.opportunity_id !== OPPORTUNITY_FOR[LISTINGS.landscaping.url]));
});

test('the switch recovers a pending opportunity\'s first date from its old-scheme evidence', async (t) => {
  // The last old-scheme run was deferred by an open identity exception, so it wrote evidence for
  // the resolved listings but no discovery date. The switch run finds that evidence by canonical
  // opportunity, not by record id, and recovers its date instead of stamping a new one.
  const world = createWorld(t);
  const { storage, db } = world;
  const at = '2030-01-05T16:00:00.000Z';
  await seedOpportunities(world, at);
  await storage.upsertDealHunterIdentityException({ id: 'switch-exception', created_at: at, updated_at: at,
    status: 'open', reason: 'ambiguous', evidence_version: 'test', candidate_opportunity_ids: [], metadata: {} });
  const csv = sheet(row(LISTINGS.hvac), row(LISTINGS.roofing));
  await admittedSync(world, csv, { runId: 'old-scheme-deferred', scheme: 'old', at,
    deferred: { url: LISTINGS.roofing.url, exceptionId: 'switch-exception' } });
  const oldEvidence = db.prepare(`SELECT id, accepted_at, source_record_id FROM deal_hunter_freshness_evidence
    WHERE run_id = 'old-scheme-deferred' AND current_canonical_id = ? AND event_type = 'accepted_source_record'
      AND field_key = ''`).get(OPPORTUNITY_FOR[LISTINGS.hvac.url]);
  assert.equal(oldEvidence.source_record_id, 'sheet-row:1');
  const pending = await storage.getDealHunterOpportunity(OPPORTUNITY_FOR[LISTINGS.hvac.url]);
  assert.deepEqual([pending.discovery_state, pending.first_accepted_at], ['pending', null]);

  await storage.upsertDealHunterIdentityException({ id: 'switch-exception', created_at: at, updated_at: at,
    status: 'resolved', reason: 'ambiguous', evidence_version: 'test', resolved_at: at,
    resolved_by: 'synthetic-test', resolution_reason: 'proved listing identity', candidate_opportunity_ids: [],
    metadata: { resolvedOpportunityId: OPPORTUNITY_FOR[LISTINGS.roofing.url] } });
  await admittedSync(world, csv, { runId: 'switch', at });
  const recovered = await storage.getDealHunterOpportunity(OPPORTUNITY_FOR[LISTINGS.hvac.url]);
  assert.deepEqual([recovered.discovery_state, recovered.first_accepted_at, recovered.first_discovery_evidence_id],
    ['known_recovered', oldEvidence.accepted_at, oldEvidence.id]);
  const deferredListing = await storage.getDealHunterOpportunity(OPPORTUNITY_FOR[LISTINGS.roofing.url]);
  assert.equal(deferredListing.discovery_state, 'known_recovered');
});

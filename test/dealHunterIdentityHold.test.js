import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://example.invalid/daily-deal-hunter.csv';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const {
  identityHeldReviewWarning,
  refreshOpportunityScores,
} = await import('../server/services/dealHunterScoreStore.js');
const { listTriageQueue } = await import('../server/services/dealHunterTriage.js');

const header = 'Business Name,State,Earnings,Revenue,Asking Price,Date Added,View Listing URL,Description';
const carbonDescription = 'Founded in 1955 family controlled precision carbon and graphite manufacturer with owned facility';
const bizBuySellUrl = 'https://www.bizbuysell.com/business-opportunity/precision-carbon/2561135/';
const dealStreamUrl = 'https://www.dealstream.com/d/biz-sale/manufacturing/epyg2g';
const plumbingRow = 'Steady Plumbing Co,CA,$450000,$1800000,$1250000,2026-08-25,https://www.bizbuysell.com/business-opportunity/steady-plumbing/1111/,Recurring residential service contracts';

// Two listings first become two separate canonical deals. The Sheet then
// presents them as one cross-listed business, so the observation carries
// aliases owned by both deals and the resolver opens a
// conflicting-canonical-aliases identity exception (the production shape).
const separateRows = [
  plumbingRow,
  `Precision Carbon Maker,CA,$500000,$2700000,$1500000,2026-08-25,${bizBuySellUrl},${carbonDescription}`,
  `Hayward Graphite Works,CA,$900000,$5000000,$3000000,2026-08-25,${dealStreamUrl},Totally different machine shop business`,
];
const crossListedRows = [
  plumbingRow,
  `Precision Carbon Maker,CA,$500000,$2700000,$1500000,2026-08-25,${bizBuySellUrl},${carbonDescription}`,
  `Precision Carbon Maker,CA,$500000,$2700000,$1500000,2026-08-25,${dealStreamUrl},${carbonDescription}`,
];

function withSheetStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-identity-hold-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'hold.sqlite') } });
  const sheet = { header, rows: separateRows };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), process.env.DEAL_HUNTER_SHEET_CSV_URL);
    return new Response([sheet.header, ...sheet.rows].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { storage, sheet };
}

async function currentNames(storage) {
  const queue = await listTriageQueue({ view: 'all', pageSize: 100, storage });
  return queue.rows.map((row) => row.name).sort();
}

test('a listing held for an open identity exception is set aside while every other listing is scored', async (t) => {
  const { storage, sheet } = withSheetStorage(t);
  const first = await refreshOpportunityScores({ storage, recordActivity: false });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.identityHeld, []);
  assert.deepEqual(await currentNames(storage), ['Hayward Graphite Works', 'Precision Carbon Maker', 'Steady Plumbing Co']);
  const before = await listTriageQueue({ view: 'all', pageSize: 100, storage });
  const carbonIds = before.rows.filter((row) => row.name !== 'Steady Plumbing Co').map((row) => row.opportunityId);
  assert.equal(carbonIds.length, 2);

  sheet.rows = crossListedRows;
  const held = await refreshOpportunityScores({ storage, recordActivity: false });

  assert.equal(held.ok, true, JSON.stringify(held));
  assert.equal(held.review.scoringDeferred, false);
  assert.equal(held.identityHeld.length, 1);
  assert.equal(held.identityHeld[0].name, 'Precision Carbon Maker');
  const [openException] = await storage.listDealHunterIdentityExceptions({ statuses: ['open'], limit: 10 });
  assert.equal(openException.reason, 'conflicting-canonical-aliases');
  assert.equal(held.identityHeld[0].exceptionId, openException.id);
  assert.deepEqual(await currentNames(storage), ['Steady Plumbing Co']);
  for (const opportunityId of carbonIds) {
    assert.equal(await storage.getCurrentDealHunterOpportunityScore(opportunityId), null);
    assert.ok(await storage.getDealHunterOpportunityScore(opportunityId), 'held deals keep their stored score');
  }

  const repeat = await refreshOpportunityScores({ storage, recordActivity: false });
  assert.equal(repeat.ok, true, JSON.stringify(repeat));
  assert.deepEqual(repeat.identityHeld.map((item) => item.exceptionId), [openException.id]);
  assert.deepEqual(await currentNames(storage), ['Steady Plumbing Co']);
});

test('an unresolved identity without an open identity exception still blocks the whole refresh', async (t) => {
  const { storage, sheet } = withSheetStorage(t);
  assert.equal((await refreshOpportunityScores({ storage, recordActivity: false })).ok, true);
  sheet.rows = crossListedRows;
  assert.equal((await refreshOpportunityScores({ storage, recordActivity: false })).ok, true);

  // The review's open-exception list no longer accounts for the unresolved
  // listing, so it is an unexplained identity gap and must fail closed.
  const listExceptions = storage.listDealHunterIdentityExceptions.bind(storage);
  storage.listDealHunterIdentityExceptions = async (options = {}) => (
    Array.isArray(options.statuses) && options.statuses.includes('open') ? [] : listExceptions(options)
  );
  const blocked = await refreshOpportunityScores({ storage, recordActivity: false });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.authorityProblems, ['the canonical candidate set contains an unresolved identity']);
  assert.equal(blocked.identityHeld, undefined);
  assert.deepEqual(await currentNames(storage), ['Steady Plumbing Co'], 'a blocked refresh leaves the last-good current set');
});

test('identityHeldReviewWarning names the held count only when listings are held', () => {
  assert.equal(identityHeldReviewWarning(null), '');
  assert.equal(identityHeldReviewWarning({ identityHeld: [] }), '');
  assert.equal(
    identityHeldReviewWarning({ identityHeld: [{ exceptionId: 'a', name: 'One' }] }),
    '1 listing is held for an identity decision and was left out of scoring. Every other listing was scored.',
  );
  assert.equal(
    identityHeldReviewWarning({ identityHeld: [{ exceptionId: 'a', name: 'One' }, { exceptionId: 'b', name: 'Two' }] }),
    '2 listings are held for an identity decision and were left out of scoring. Every other listing was scored.',
  );
});

test('a raw source-record identity defect still defers scoring even when another listing is only held', async (t) => {
  const { storage, sheet } = withSheetStorage(t);
  // A stable Listing ID column makes record identity come from the Sheet, so
  // a repeated id is a raw source-identity defect rather than a new row.
  sheet.header = `Listing ID,${header}`;
  // Only the unrelated listing carries a stable id; the cross-listed carbon
  // rows keep URL identity so they collapse into one conflicting observation.
  const withIds = (rows) => rows.map((row, index) => `${index === 0 ? 'ROW-1' : ''},${row}`);
  sheet.rows = withIds(separateRows);
  assert.equal((await refreshOpportunityScores({ storage, recordActivity: false })).ok, true);
  sheet.rows = withIds(crossListedRows);
  const held = await refreshOpportunityScores({ storage, recordActivity: false });
  assert.equal(held.ok, true, JSON.stringify(held));
  assert.equal(held.identityHeld.length, 1);
  assert.deepEqual(await currentNames(storage), ['Steady Plumbing Co']);

  sheet.rows = [
    ...sheet.rows,
    'DUP-9,Duplicate Id Services,TX,$500000,$1500000,$1000000,2026-08-25,https://listings.example.invalid/dup-a,Commercial plumbing maintenance with recurring service agreements',
    'DUP-9,Duplicate Id Cleaning,TX,$520000,$1600000,$1100000,2026-08-25,https://listings.example.invalid/dup-b,Commercial cleaning with recurring service agreements',
  ];
  const deferred = await refreshOpportunityScores({ storage, recordActivity: false });

  assert.equal(deferred.ok, false);
  assert.equal(deferred.status, 503);
  assert.equal(deferred.scoringDeferred, true);
  assert.equal(
    deferred.error,
    'Scoring and scored-opportunity actions are deferred until every required Google Sheet has a complete, uniquely identified source snapshot.',
  );
  assert.equal(deferred.identityHeld, undefined);
  assert.deepEqual(await currentNames(storage), ['Steady Plumbing Co'], 'deferral leaves the last-good current set');
});

// A Pursue campaign must still send after the daily Sheet refresh rewrites its source rows.
//
// The complete Sheet refresh rewrites `updated_at`, `accepted_at` and `accepted_run_id` on every
// observation row, and the source's `accepted_at`, on every run, even when the Sheet is
// unchanged. Neither the campaign's stored recipient fingerprint nor the final gate's
// source-change check may depend on those, or every send after a refresh is skipped (the
// 2026-11-08 production incident: `authority_changed` at preparation, and behind it
// `source_authority_unavailable` at the final gate). A real change must still stop the send:
// a changed broker email, a changed record, a removed record. Real SQLite, the real
// complete-Sheet admission path, and the fake Gmail mailbox.
//
// Production timing: SQLite stamps a sync's acceptance with its own wall clock, while this world
// runs in 2030 on a controlled clock. Each sync's acceptance (rows, source state, freshness
// evidence and safety events) is re-stamped at the controlled instant, as production would
// have written it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursue-refresh-'));
process.env.ADMIN_SESSION_SECRET = 'pursue-refresh-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'pursue-refresh-document-secret';
process.env.SQLITE_PATH = path.join(tempDir, 'default.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'source-health.json');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
delete process.env.DEAL_HUNTER_AUTO_PURSUE_ACTIVE_DAILY_CAP;
process.on('exit', () => fs.rmSync(tempDir, { recursive: true, force: true }));

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { buildOpportunitySourceObservationSnapshot } = await import(
  '../server/services/dealHunterOpportunityFacts.js');
const { parseSheetCsvDeals } = await import('../server/services/dealHunter.js');
const { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } = await import(
  '../server/services/dealHunterSourceSnapshotAdmission.js');
const {
  BROKER_EMAIL, HEALTHY_SOURCE_SNAPSHOT, createWorld, ownerRequestsSim, ownerTurnsSendingOn,
  pacific, seedDeal, sendAt,
} = await import('./fixtures/pursueCimEndToEndFixture.js');

fs.writeFileSync(process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH, JSON.stringify(HEALTHY_SOURCE_SNAPSHOT));

const SATURDAY = '2030-01-05';
const SUNDAY = '2030-01-06';
const MONDAY = '2030-01-07';
const TUESDAY = '2030-01-08';
const WEDNESDAY = '2030-01-09';
const OPPORTUNITY = 'opp-refresh';
const NAME = 'Acme Plumbing';
const NEW_BROKER_EMAIL = 'casey.new@brokerfirm.test';
const OTHER_OPPORTUNITY = 'opp-other';
const OTHER_NAME = 'Harbor Roofing';
const OTHER_BROKER_EMAIL = 'pat.doe@otherbroker.test';

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
 * Re-stamps one sync's acceptance at the controlled instant: what production writes, because
 * there SQLite's clock is the real clock. The evidence and safety-event payload triggers are
 * lifted for the update and restored exactly as they were.
 */
async function stampAcceptance(world, runId, at) {
  const triggers = await world.all(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
    AND name IN (${IMMUTABLE_ACCEPTANCE_TRIGGERS.map(() => '?').join(', ')})`,
  ...IMMUTABLE_ACCEPTANCE_TRIGGERS);
  assert.equal(triggers.length, IMMUTABLE_ACCEPTANCE_TRIGGERS.length);
  try {
    for (const { name } of triggers) await world.run(`DROP TRIGGER ${name}`);
    await world.run(`UPDATE deal_hunter_opportunity_source_observations SET accepted_at = ?
      WHERE accepted_run_id = ?`, at, runId);
    await world.run(`UPDATE deal_hunter_source_freshness_state SET accepted_at = ?
      WHERE accepted_run_id = ?`, at, runId);
    await world.run('UPDATE deal_hunter_freshness_evidence SET accepted_at = ? WHERE run_id = ?',
      at, runId);
    await world.run(`UPDATE deal_hunter_cim_safety_events SET created_at = ?, updated_at = ?
      WHERE source_run_id = ?`, at, at, runId);
  } finally {
    // Restore whichever triggers are missing, so a failure can never leave one dropped.
    const present = new Set((await world.all(`SELECT name FROM sqlite_master WHERE type = 'trigger'
      AND name IN (${IMMUTABLE_ACCEPTANCE_TRIGGERS.map(() => '?').join(', ')})`,
    ...IMMUTABLE_ACCEPTANCE_TRIGGERS)).map((row) => row.name));
    for (const { name, sql } of triggers) if (!present.has(name)) await world.run(sql);
  }
}

/** The Sheet's rows, each with the canonical opportunity it resolves to. */
function sheetDeals({ brokerEmail = BROKER_EMAIL, industry = 'Plumbing', withSecondRow = true,
  withOther = true, otherIndustry = 'Roofing' } = {}) {
  const common = { sourceId: 'sheet-0', sourceName: 'SMB Deal Hunter Google Sheet',
    stableExternalId: true, name: NAME, location: 'Sacramento, CA', state: 'CA' };
  return [
    { opportunityId: OPPORTUNITY, deal: { ...common, id: `listing-${OPPORTUNITY}`,
      listingUrl: `https://broker.example/${OPPORTUNITY}`, industry, brokerName: 'Jordan Lee',
      brokerEmail } },
    // The same business listed a second time on the Sheet, without a broker contact.
    ...(withSecondRow ? [{ opportunityId: OPPORTUNITY, deal: { ...common,
      id: `listing-${OPPORTUNITY}-repost`, listingUrl: `https://broker.example/${OPPORTUNITY}-repost`,
      industry } }] : []),
    // Another deal on the same Sheet, with its own broker; no campaign.
    ...(withOther ? [{ opportunityId: OTHER_OPPORTUNITY, deal: { ...common, name: OTHER_NAME,
      id: `listing-${OTHER_OPPORTUNITY}`, listingUrl: `https://broker.example/${OTHER_OPPORTUNITY}`,
      industry: otherIndustry, brokerName: 'Pat Doe', brokerEmail: OTHER_BROKER_EMAIL } }] : []),
  ];
}

/**
 * One complete daily Sheet sync, through the storage admission the daily sync uses once
 * identities resolve (`attachCanonicalOpportunityIdentities` in dealHunter.js): a new freshness
 * generation, each record's observation snapshot stamped at the sync's instant, and
 * `reconcileVerifiedCompleteGoogleSheetSourceSnapshot`; then the production-time stamp.
 */
async function dailySheetSync(world, { runId, ...sheet }) {
  const { storage } = world;
  const at = world.clock.peek().toISOString();
  const rows = sheetDeals(sheet);
  const deals = rows.map(({ deal }) => deal);
  const records = rows.map(({ opportunityId, deal }) => buildOpportunitySourceObservationSnapshot({
    opportunityId, deal, now: at }));
  const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId });
  const result = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({ storage,
    reviewMode: 'full-backfill',
    sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
      sourceRowCount: deals.length, rowCount: deals.length, coverageLimitReached: false }, deals },
    records, run });
  assert.equal(result.reconciled, true, JSON.stringify(result));
  await stampAcceptance(world, runId, at);
  return result;
}

const sourceRows = (world) => world.all(`SELECT id, field, value, updated_at, accepted_at,
  accepted_run_id FROM deal_hunter_opportunity_source_observations
  WHERE opportunity_id = ? ORDER BY id`, OPPORTUNITY);

/**
 * The production timeline: the deal arrives with Saturday's Sheet sync, the owner clicks Request
 * SIM on Saturday evening (the initial is due Monday 08:00 in California), and the daily sync
 * runs again on Sunday and on Monday at 08:00, before the send.
 */
async function campaignThenDailySyncs(t, { monday = {} } = {}) {
  const world = await createWorld(t, createSqliteBackend, { start: pacific(SATURDAY, '06:30') });
  world.mailProvider.rewriteMessageIds();
  await ownerTurnsSendingOn(world);
  await seedDeal(world, { opportunityId: OPPORTUNITY, name: NAME, fitScore: 82, criteriaGroup: 'review' });
  await seedDeal(world, { opportunityId: OTHER_OPPORTUNITY, name: OTHER_NAME, fitScore: 60,
    criteriaGroup: 'review', brokerEmail: OTHER_BROKER_EMAIL });
  world.clock.set(pacific(SATURDAY, '08:00'));
  await dailySheetSync(world, { runId: 'sheet-sync-saturday' });

  world.clock.set(pacific(SATURDAY, '20:26'));
  const command = await ownerRequestsSim(world, OPPORTUNITY);
  assert.equal(command.enrollment.state, 'campaign-created', JSON.stringify(command.enrollment));
  const campaign = await world.campaignFor(OPPORTUNITY);
  assert.equal(campaign.state, 'initial-pending');
  assert.deepEqual(await world.scheduled(campaign), [['initial', pacific(MONDAY, '08:00')]]);
  const atCreation = await sourceRows(world);

  world.clock.set(pacific(SUNDAY, '08:00'));
  await dailySheetSync(world, { runId: 'sheet-sync-sunday' });
  world.clock.set(pacific(MONDAY, '08:00'));
  await dailySheetSync(world, { runId: 'sheet-sync-monday', ...monday });
  return { world, campaign, atCreation };
}

test('an unchanged daily Sheet sync after Request SIM leaves the campaign sendable: the initial goes out in the window', async (t) => {
  const { world, campaign, atCreation } = await campaignThenDailySyncs(t);

  // The syncs rewrote every row's timestamps and run, and nothing else.
  const afterSyncs = await sourceRows(world);
  assert.deepEqual(afterSyncs.map(({ id, field, value }) => [id, field, value]),
    atCreation.map(({ id, field, value }) => [id, field, value]));
  for (const [index, row] of afterSyncs.entries()) {
    assert.notEqual(row.updated_at, atCreation[index].updated_at, `${row.field} updated_at`);
    assert.notEqual(row.accepted_at, atCreation[index].accepted_at, `${row.field} accepted_at`);
    assert.equal(row.accepted_run_id, 'sheet-sync-monday');
  }

  const run = await sendAt(world, pacific(MONDAY, '08:05'));
  assert.equal(run.sentInitial, 1, JSON.stringify(run));
  assert.deepEqual(run.skipped, {}, JSON.stringify(run));
  const [initial] = world.mailProvider.sent;
  assert.equal(initial.to, BROKER_EMAIL);
  const [touch] = await world.touches(campaign.id);
  assert.deepEqual([touch.kind, touch.state], ['initial', 'accepted']);
  assert.equal((await world.campaignFor(OPPORTUNITY)).state, 'active-follow-up');
});

test('a daily Sheet sync that changes the broker email stops the initial: nothing goes to the old address', async (t) => {
  const { world, campaign } = await campaignThenDailySyncs(t, { monday: { brokerEmail: NEW_BROKER_EMAIL } });
  assert.deepEqual((await sourceRows(world)).filter((row) => row.field === 'broker_email')
    .map((row) => row.value), [NEW_BROKER_EMAIL]);

  for (const at of [pacific(MONDAY, '08:05'), pacific(MONDAY, '08:20'), pacific(TUESDAY, '09:00')]) {
    const run = await sendAt(world, at);
    assert.deepEqual([run.sentInitial, run.sentFollowUps], [0, 0], JSON.stringify(run));
    assert.deepEqual(run.skipped, { authority_changed: 1 }, JSON.stringify(run));
  }
  assert.deepEqual(world.mailProvider.attempts, []);
  assert.deepEqual(world.mailProvider.sent, []);
  assert.equal(await world.count('deal_hunter_cim_transmissions'), 0);
  const [touch] = await world.touches(campaign.id);
  assert.notEqual(touch.state, 'accepted');
});

test('a follow-up still goes out after daily Sheet syncs on the days between it and the initial', async (t) => {
  const { world, campaign } = await campaignThenDailySyncs(t);
  const initialRun = await sendAt(world, pacific(MONDAY, '08:05'));
  assert.equal(initialRun.sentInitial, 1, JSON.stringify(initialRun));
  assert.deepEqual(await world.scheduled(campaign), [['follow-up-1', pacific(WEDNESDAY, '08:00')]]);

  world.clock.set(pacific(TUESDAY, '08:00'));
  await dailySheetSync(world, { runId: 'sheet-sync-tuesday' });
  world.clock.set(pacific(WEDNESDAY, '07:55'));
  await dailySheetSync(world, { runId: 'sheet-sync-wednesday' });

  const run = await sendAt(world, pacific(WEDNESDAY, '08:05'));
  assert.equal(run.sentFollowUps, 1, JSON.stringify(run));
  assert.deepEqual(run.skipped, {}, JSON.stringify(run));
  const [initial, followUp] = world.mailProvider.sent;
  assert.deepEqual([followUp.to, followUp.threadId, followUp.inReplyTo],
    [BROKER_EMAIL, initial.threadId, initial.rfcMessageId]);
});

test('a campaign stored under an earlier recipient fingerprint keeps skipping as authority_changed without failing the run', async (t) => {
  const { world, campaign } = await campaignThenDailySyncs(t);
  // A campaign created before the fingerprint stopped hashing row timestamps holds a value the
  // current derivation never produces. It stays stuck, by design; the run must not throw.
  const legacy = 'e'.repeat(64);
  await world.run('UPDATE deal_hunter_cim_campaigns SET recipient_fingerprint = ? WHERE id = ?',
    legacy, campaign.id);
  await world.run('UPDATE deal_hunter_broker_conversations SET recipient_fingerprint = ? WHERE id = ?',
    legacy, campaign.conversation_id);
  for (const at of [pacific(MONDAY, '08:05'), pacific(MONDAY, '08:20')]) {
    const run = await sendAt(world, at);
    assert.deepEqual([run.sentInitial, run.failed, run.ambiguous], [0, 0, 0], JSON.stringify(run));
    assert.deepEqual(run.skipped, { authority_changed: 1 }, JSON.stringify(run));
  }
  assert.deepEqual(world.mailProvider.attempts, []);
  assert.equal((await world.campaignFor(OPPORTUNITY)).state, 'initial-pending');
});

test('a daily Sheet sync that changes the record after Request SIM stops the initial at the final gate', async (t) => {
  const { world, campaign } = await campaignThenDailySyncs(t, { monday: { industry: 'Plumbing and HVAC' } });
  for (const at of [pacific(MONDAY, '08:05'), pacific(MONDAY, '08:20')]) {
    const run = await sendAt(world, at);
    assert.deepEqual([run.sentInitial, run.sentFollowUps], [0, 0], JSON.stringify(run));
    assert.deepEqual(run.skipped, { source_authority_unavailable: 1 }, JSON.stringify(run));
  }
  assert.deepEqual(world.mailProvider.attempts, []);
  const [touch] = await world.touches(campaign.id);
  assert.notEqual(touch.state, 'accepted');
});

test('a daily Sheet sync that removes one of the deal\'s Sheet records stops the initial at the final gate', async (t) => {
  // The remaining record still names the same broker, so the recipient is unchanged and only
  // the admitted source-record-removed event says the source changed.
  const { world, campaign } = await campaignThenDailySyncs(t, { monday: { withSecondRow: false } });
  assert.deepEqual([...new Set((await world.all(`SELECT source_record_id
    FROM deal_hunter_opportunity_source_observations WHERE opportunity_id = ?`, OPPORTUNITY))
    .map((row) => row.source_record_id))], [`external:listing-${OPPORTUNITY}`]);
  for (const at of [pacific(MONDAY, '08:05'), pacific(MONDAY, '08:20')]) {
    const run = await sendAt(world, at);
    assert.deepEqual([run.sentInitial, run.sentFollowUps], [0, 0], JSON.stringify(run));
    assert.deepEqual(run.skipped, { source_authority_unavailable: 1 }, JSON.stringify(run));
  }
  assert.deepEqual(world.mailProvider.attempts, []);
  const [touch] = await world.touches(campaign.id);
  assert.notEqual(touch.state, 'accepted');
});

for (const [label, monday] of [
  ['removes another deal\'s Sheet record', { withOther: false }],
  ['changes another deal\'s Sheet record', { otherIndustry: 'Roofing and Siding' }],
]) {
  test(`a daily Sheet sync that ${label} after Request SIM leaves this campaign sendable`, async (t) => {
    const { world, campaign } = await campaignThenDailySyncs(t, { monday });
    const run = await sendAt(world, pacific(MONDAY, '08:05'));
    assert.equal(run.sentInitial, 1, JSON.stringify(run));
    assert.deepEqual(run.skipped, {}, JSON.stringify(run));
    assert.equal(world.mailProvider.sent[0].to, BROKER_EMAIL);
    const [touch] = await world.touches(campaign.id);
    assert.equal(touch.state, 'accepted');
  });
}

// ---------------------------------------------------------------------------------------------
// The main Sheet has no ID column, so its rows are parsed with positional row ids, and listings
// are added above each other every day. A row is keyed by its listing link, so a listing
// inserted above the campaign's listing neither changes nor removes the campaign's record.
// ---------------------------------------------------------------------------------------------

const INSERTED_OPPORTUNITY = 'opp-inserted';
const POSITIONAL_LISTINGS = Object.freeze({
  [OPPORTUNITY]: [NAME, 'Plumbing', 'Jordan Lee', BROKER_EMAIL],
  [OTHER_OPPORTUNITY]: [OTHER_NAME, 'Roofing', 'Pat Doe', OTHER_BROKER_EMAIL],
  [INSERTED_OPPORTUNITY]: ['Cedar Landscaping', 'Landscaping', 'Sam Roe', 'sam.roe@thirdbroker.test'],
});

/** The Sheet as the collector parses it: no ID column, one row per listing in `order`. */
function positionalSheet(order) {
  const csv = ['Business Name,Listing URL,City,State,Industry,Broker Name,Broker Email',
    ...order.map((opportunityId) => {
      const [name, industry, brokerName, brokerEmail] = POSITIONAL_LISTINGS[opportunityId];
      return [name, `https://broker.example/${opportunityId}`, 'Sacramento', 'CA', industry, brokerName,
        brokerEmail].join(',');
    })].join('\n');
  return parseSheetCsvDeals(csv).deals.map((deal, index) => ({ opportunityId: order[index], deal }));
}

/** A record keyed as origin/main keyed a row without an ID column: by its position. */
function positionalRecord(snapshot, deal) {
  const recordId = `sheet-row:${deal.sourceRowId}`;
  return { ...snapshot, source_record_id: recordId, observations: snapshot.observations.map((observation) => ({
    ...observation, source_record_id: recordId,
    id: `source-observation:${createHash('sha256').update([observation.opportunity_id, observation.source_id,
      recordId, observation.field].join('\u0000')).digest('hex')}`,
  })) };
}

/** `dailySheetSync` over the positional Sheet; `scheme: 'old'` writes origin/main's record ids. */
async function positionalSheetSync(world, { runId, order, scheme = 'new' }) {
  const { storage } = world;
  const at = world.clock.peek().toISOString();
  const rows = positionalSheet(order);
  const records = rows.map(({ opportunityId, deal }) => {
    const snapshot = buildOpportunitySourceObservationSnapshot({ opportunityId, deal, now: at });
    return scheme === 'old' ? positionalRecord(snapshot, deal) : snapshot;
  });
  // The admission checks the collected rows' identities; without a URL a row resolves to its
  // position, which is exactly origin/main's identity for every row of this Sheet.
  const deals = rows.map(({ deal }) => (scheme === 'old' ? { ...deal, listingUrl: '' } : deal));
  const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId });
  const result = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({ storage,
    reviewMode: 'full-backfill',
    sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
      sourceRowCount: deals.length, rowCount: deals.length, coverageLimitReached: false }, deals },
    records, run });
  assert.equal(result.reconciled, true, JSON.stringify(result));
  await stampAcceptance(world, runId, at);
  return result;
}

const removalsFor = (world, runId, opportunityId) => world.all(`SELECT event_type
  FROM deal_hunter_cim_safety_events WHERE source_run_id = ? AND opportunity_id = ?
    AND event_type LIKE 'source-record-removed#%'`, runId, opportunityId);

async function positionalCampaign(t, { scheme = 'new' } = {}) {
  const world = await createWorld(t, createSqliteBackend, { start: pacific(SATURDAY, '06:30') });
  world.mailProvider.rewriteMessageIds();
  await ownerTurnsSendingOn(world);
  await seedDeal(world, { opportunityId: OPPORTUNITY, name: NAME, fitScore: 82, criteriaGroup: 'review' });
  await seedDeal(world, { opportunityId: OTHER_OPPORTUNITY, name: OTHER_NAME, fitScore: 60,
    criteriaGroup: 'review', brokerEmail: OTHER_BROKER_EMAIL });
  await seedDeal(world, { opportunityId: INSERTED_OPPORTUNITY, name: 'Cedar Landscaping', fitScore: 55,
    criteriaGroup: 'review', brokerEmail: 'sam.roe@thirdbroker.test' });
  world.clock.set(pacific(SATURDAY, '08:00'));
  await positionalSheetSync(world, { runId: 'sheet-sync-saturday', order: [OPPORTUNITY, OTHER_OPPORTUNITY],
    scheme });

  world.clock.set(pacific(SATURDAY, '20:26'));
  const command = await ownerRequestsSim(world, OPPORTUNITY);
  assert.equal(command.enrollment.state, 'campaign-created', JSON.stringify(command.enrollment));
  const campaign = await world.campaignFor(OPPORTUNITY);
  assert.deepEqual(await world.scheduled(campaign), [['initial', pacific(MONDAY, '08:00')]]);
  return { world, campaign };
}

test('a listing inserted above the campaign\'s listing on a Sheet without IDs leaves the campaign sendable', async (t) => {
  const { world, campaign } = await positionalCampaign(t);
  const atCreation = await sourceRows(world);

  // Sunday a new listing lands at the top; Monday the Sheet is re-ordered as well.
  world.clock.set(pacific(SUNDAY, '08:00'));
  await positionalSheetSync(world, { runId: 'sheet-sync-sunday',
    order: [INSERTED_OPPORTUNITY, OPPORTUNITY, OTHER_OPPORTUNITY] });
  world.clock.set(pacific(MONDAY, '08:00'));
  await positionalSheetSync(world, { runId: 'sheet-sync-monday',
    order: [OTHER_OPPORTUNITY, INSERTED_OPPORTUNITY, OPPORTUNITY] });

  const afterSyncs = await sourceRows(world);
  assert.deepEqual(afterSyncs.map(({ id, field, value }) => [id, field, value]),
    atCreation.map(({ id, field, value }) => [id, field, value]), 'the same record, rows and values');
  for (const runId of ['sheet-sync-sunday', 'sheet-sync-monday']) {
    assert.deepEqual(await removalsFor(world, runId, OPPORTUNITY), [], runId);
  }

  const run = await sendAt(world, pacific(MONDAY, '08:05'));
  assert.equal(run.sentInitial, 1, JSON.stringify(run));
  assert.deepEqual(run.skipped, {}, JSON.stringify(run));
  assert.equal(world.mailProvider.sent[0].to, BROKER_EMAIL);
  const [touch] = await world.touches(campaign.id);
  assert.deepEqual([touch.kind, touch.state], ['initial', 'accepted']);
});

test('the one-time switch from positional Sheet record ids holds a campaign created before it, once', async (t) => {
  // Expected and accepted at deploy: the first refresh renames every positional record to its
  // listing id. That removes the old association, and the campaign's recipient fingerprint, which
  // hashes each source row's id and record id, no longer matches, so the send is held.
  const { world } = await positionalCampaign(t, { scheme: 'old' });
  assert.deepEqual([...new Set((await world.all(`SELECT source_record_id
    FROM deal_hunter_opportunity_source_observations WHERE opportunity_id = ?`, OPPORTUNITY))
    .map((row) => row.source_record_id))], ['sheet-row:1']);

  world.clock.set(pacific(SUNDAY, '08:00'));
  await positionalSheetSync(world, { runId: 'sheet-sync-switch', order: [OPPORTUNITY, OTHER_OPPORTUNITY] });
  assert.equal((await removalsFor(world, 'sheet-sync-switch', OPPORTUNITY)).length, 1);
  world.clock.set(pacific(MONDAY, '08:00'));
  await positionalSheetSync(world, { runId: 'sheet-sync-monday',
    order: [INSERTED_OPPORTUNITY, OTHER_OPPORTUNITY, OPPORTUNITY] });
  assert.deepEqual(await removalsFor(world, 'sheet-sync-monday', OPPORTUNITY), [],
    'after the switch, moving rows removes nothing');

  const run = await sendAt(world, pacific(MONDAY, '08:05'));
  assert.deepEqual([run.sentInitial, run.sentFollowUps], [0, 0], JSON.stringify(run));
  assert.deepEqual(run.skipped, { authority_changed: 1 }, JSON.stringify(run));
  assert.deepEqual(world.mailProvider.attempts, []);
});

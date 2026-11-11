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
  for (const { name } of triggers) await world.run(`DROP TRIGGER ${name}`);
  try {
    await world.run(`UPDATE deal_hunter_opportunity_source_observations SET accepted_at = ?
      WHERE accepted_run_id = ?`, at, runId);
    await world.run(`UPDATE deal_hunter_source_freshness_state SET accepted_at = ?
      WHERE accepted_run_id = ?`, at, runId);
    await world.run('UPDATE deal_hunter_freshness_evidence SET accepted_at = ? WHERE run_id = ?',
      at, runId);
    await world.run(`UPDATE deal_hunter_cim_safety_events SET created_at = ?, updated_at = ?
      WHERE source_run_id = ?`, at, at, runId);
  } finally {
    for (const { sql } of triggers) await world.run(sql);
  }
}

function sheetDeals({ brokerEmail = BROKER_EMAIL, industry = 'Plumbing', withSecondRow = true } = {}) {
  const common = { sourceId: 'sheet-0', sourceName: 'SMB Deal Hunter Google Sheet',
    stableExternalId: true, name: NAME, location: 'Sacramento, CA', state: 'CA' };
  return [
    { ...common, id: `listing-${OPPORTUNITY}`, listingUrl: `https://broker.example/${OPPORTUNITY}`,
      industry, brokerName: 'Jordan Lee', brokerEmail },
    // The same business listed a second time on the Sheet, without a broker contact.
    ...(withSecondRow ? [{ ...common, id: `listing-${OPPORTUNITY}-repost`,
      listingUrl: `https://broker.example/${OPPORTUNITY}-repost`, industry }] : []),
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
  const deals = sheetDeals(sheet);
  const records = deals.map((deal) => buildOpportunitySourceObservationSnapshot({
    opportunityId: OPPORTUNITY, deal, now: at }));
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

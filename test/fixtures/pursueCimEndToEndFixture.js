// Task 11: the whole owner loop for Gmail Pursue CIM campaigns (spec 2026-11-03 §10–§11), run
// end to end on real storage with only the Gmail mailbox faked. The scenarios are written once
// and run on SQLite (test/pursueCimGmailEndToEnd.test.js) and on gated Postgres through the
// Supabase adapter (test/pursueCimGmailEndToEndPostgres.test.js).
//
// - Every campaign is created by an owner-facing entry point: automatic Pursue in `active`
//   mode, or the owner's Request SIM command (the triage action route's service).
// - Every control is changed through the Operations card's service (changeEmailSendingControl),
//   which also records and withdraws the Gmail capability chain.
// - The scheduled sender and the reply poller are driven tick by tick under a controlled clock.
//   Every sender tick is preceded by a reply poller scheduler tick (its 5-minute slot), as in
//   production, so follow-ups see a recently completed reply check (Ruling U).
//
// The controlled clock is the process clock too: `Date` reads it, so the owner command and the
// enrollment it runs see the same instants as the sender, and each read of the sender's clock
// moves it one second, so every gate attempt has its own instant. The scenarios run in 2030,
// ahead of the wall clock: SQLite's follow-up capacity trigger compares expiries with its own
// clock, and on Postgres the database clock is set to the controlled clock for every statement.
//
// Test files set the process environment (source health snapshot, temporary SQLite path) before
// importing this module.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getSourceHealth } from '../../server/services/acquisitionCommandCenter.js';
import { AUTO_PURSUE_CONFIRMATIONS, runAutoPursue, setAutoPursueMode } from '../../server/services/autoPursue.js';
import { setCimOutreachPaused } from '../../server/services/cimOpportunityIdentity.js';
import { recordAcquisitionOwnerCommand } from '../../server/services/dealHunterTriage.js';
import { createFakeCimProvider } from '../../server/services/fakeCimProvider.js';
import { buildGmailConnectUrl, completeGmailConnect, disconnectGmail } from '../../server/services/gmailConnection.js';
import { runPursueCimReplyPoll } from '../../server/services/pursueCimReplyPoller.js';
import { startPursueCimReplyPollerScheduler } from '../../server/services/pursueCimReplyPollerScheduler.js';
import { readPursueCimProviderReadiness } from '../../server/services/pursueCimReadiness.js';
import { runPursueCimSender } from '../../server/services/pursueCimSender.js';
import { renderPursueCimEmail } from '../../server/services/pursueCimTemplates.js';
import { changeEmailSendingControl } from '../../server/services/pursueEmailSending.js';
import { SENDER, SENDER_SETTINGS, gmailConfig } from './pursueCimGmailGateFixture.js';

const RealDate = globalThis.Date;
const OWNER = 'owner@uckele.test';
const BROKER_EMAIL = 'jordan.lee@brokerfirm.test';
const CIPHERTEXT = 'v1.aXYtYnl0ZXM=.dGFnLWJ5dGVz.Y2lwaGVydGV4dA==';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly'];
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The source-health snapshot the test files write: the Sheet, healthy at its last check. */
export const HEALTHY_SOURCE_SNAPSHOT = Object.freeze({
  generatedAt: '2030-01-01T00:00:00.000Z', issues: [], totals: { reviewedDeals: 3 },
  sources: { 'sheet-0': { rowCount: 3, name: 'SMB Deal Hunter Google Sheet', mode: 'csv',
    required: true, sourceRole: 'required-primary', checkedAt: '2030-01-01T00:00:00.000Z' } },
});

/**
 * The controlled clock, installed as the process `Date` for the test. `clock()` returns the
 * current instant and moves one second on (the sender's live clock); `new Date()` and
 * `Date.now()` read the current instant.
 */
function installClock(t, startIso) {
  let current = RealDate.parse(startIso);
  class ControlledDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(current);
      else super(...args);
    }

    static now() { return current; }

    static [Symbol.hasInstance](value) { return value instanceof RealDate; }
  }
  globalThis.Date = ControlledDate;
  t.after(() => { globalThis.Date = RealDate; });
  const clock = () => {
    const at = new RealDate(current);
    current += 1000;
    return at;
  };
  clock.peek = () => new RealDate(current);
  clock.set = (iso) => {
    const next = RealDate.parse(iso);
    assert.ok(next >= current, `the clock only moves forward (${iso})`);
    current = next;
  };
  return clock;
}

/** Pacific wall time `HH:MM` on `date` (YYYY-MM-DD) in January, as an ISO instant (PST, UTC-8). */
function pacific(date, time) {
  const [hour, minute] = time.split(':').map(Number);
  const [year, month, day] = date.split('-').map(Number);
  return new RealDate(RealDate.UTC(year, month - 1, day, hour + 8, minute)).toISOString();
}

/** YYYY-MM-DD for `date` plus `days` calendar days. */
function addDays(date, days) {
  return new RealDate(RealDate.parse(`${date}T12:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

/** Either adapter's timestamp as a `Z` ISO instant. */
const iso = (value) => (value === null || value === undefined ? value : new RealDate(value).toISOString());

/**
 * A world on one backend. `createBackend(t)` returns `{ storage, all(sql, ...params),
 * run(sql, ...params) }` with `?` placeholders; it is created after the clock is installed.
 */
async function createWorld(t, createBackend, { start }) {
  const clock = installClock(t, start);
  const backend = await createBackend(t);
  const { storage } = backend;
  let config = gmailConfig();
  const mailProvider = createFakeCimProvider({ now: () => clock.peek(), senderAddress: SENDER });
  const one = async (sql, ...params) => (await backend.all(sql, ...params))[0];
  const world = {
    storage, clock, mailProvider,
    seeded: [],
    get config() { return config; },
    setConfig(next) { config = next; },
    async control(controlKey, enabled) {
      const controls = await storage.getPursueSendControls();
      const name = { live_sending: 'liveSending', contact_rule: 'contactRule',
        wording_approval: 'wordingApproval' }[controlKey];
      const result = await changeEmailSendingControl({ storage, config, actor: OWNER, now: clock.peek(),
        command: { controlKey, enabled, expectedRevision: controls[name].revision, reason: 'end-to-end' } });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.control;
    },
    readiness: () => readPursueCimProviderReadiness({ storage, providerProfile: 'production-gmail-v1',
      now: clock.peek(), mailProvider, config }),
    async send() {
      await startPursueCimReplyPollerScheduler({ storage, config, now: () => clock.peek(),
        setTimer: () => null, clearTimer: () => {}, logger: { log() {}, error() {} },
        run: (input) => runPursueCimReplyPoll({ ...input, mailProvider }) }).tick();
      return runPursueCimSender({ storage, mailProvider, clock, config });
    },
    poll: () => runPursueCimReplyPoll({ storage, mailProvider, now: clock, config }),
    run: backend.run,
    one,
    count: async (table, where = '1 = 1', ...params) => Number((await one(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)).n),
    campaignFor: (opportunityId) => one('SELECT * FROM deal_hunter_cim_campaigns WHERE opportunity_id = ?',
      opportunityId),
    enrollmentFor: (opportunityId) => one('SELECT * FROM deal_hunter_pursuit_enrollments WHERE opportunity_id = ?',
      opportunityId),
    conversation: (id) => one('SELECT * FROM deal_hunter_broker_conversations WHERE id = ?', id),
    decisionFor: (opportunityId) => one(`SELECT actor, policy_version FROM deal_hunter_owner_decision_events
      WHERE opportunity_id = ?`, opportunityId),
    touches: (campaignId) => backend.all(`SELECT * FROM deal_hunter_cim_campaign_touches
      WHERE campaign_id = ? ORDER BY ordinal, id`, campaignId),
    async scheduled(campaign) {
      return (await world.touches(campaign.id)).filter((touch) => touch.state === 'scheduled')
        .map((touch) => [touch.kind, iso(touch.due_at)]);
    },
    suppressions: async () => (await backend.all(`SELECT normalized_email, source, lifted_at
      FROM email_suppressions ORDER BY normalized_email`)).map((row) => ({ ...row })),
  };
  return world;
}

/** The owner's one-time setup (spec §10 steps 3, 4 and 6), through the Operations card's service. */
async function ownerTurnsSendingOn(world) {
  const { storage, clock } = world;
  await setCimOutreachPaused({ paused: false, actor: OWNER, reason: 'end-to-end', storage });
  // Connect Gmail: the OAuth callback stores this row. The mailbox itself is the fake provider.
  await storage.saveGmailConnection({ emailAddress: SENDER, refreshTokenCiphertext: CIPHERTEXT,
    grantedScopes: SCOPES, historyCheckpoint: '0', connectedBy: OWNER, now: clock.peek().toISOString() });
  await world.control('wording_approval', true);
  await world.control('contact_rule', true);
  const live = await world.control('live_sending', true);
  assert.equal(live.capabilitiesInSync, true);
  const readiness = await world.readiness();
  assert.deepEqual([readiness.ready, readiness.reasons], [true, []]);
}

/**
 * Automatic Pursue in `active` mode. Its warm-up gate needs 25 earlier owner decisions on
 * auto-group deals; that is history, so the past deals, decisions and evidence are seeded.
 */
async function ownerActivatesAutoPursue(world) {
  const { storage } = world;
  for (let index = 0; index < 25; index += 1) {
    const opportunityId = `warmup-opp-${index}`;
    const at = new Date(Date.now() - (60 - index) * DAY).toISOString();
    await storage.upsertDealHunterOpportunity({ opportunity_id: opportunityId, created_at: at, updated_at: at,
      canonical_name: `Earlier deal ${index}`, canonical_recipient: null, canonical_location: 'Fresno, CA',
      primary_submission_id: null, identity_version: 'pursue-e2e', status: 'archived', metadata: {} });
    await world.run(`INSERT INTO deal_hunter_owner_decision_events (id, idempotency_key, request_digest,
      opportunity_id, action, actor, expected_discovery_revision, expected_material_revision,
      observed_discovery_revision, observed_material_revision, policy_version, created_at)
      VALUES (?, ?, ?, ?, 'pursue', ?, 0, 0, 0, 0, 'owner-decision-v1', ?)`,
    `warmup-event-${index}`, `warmup-key-${index}`, 'd'.repeat(64), opportunityId, OWNER, at);
    await storage.insertAutoPursueDecisionEvidence({
      decision_event_id: `warmup-event-${index}`, opportunity_id: opportunityId, action: 'pursue',
      policy_version: 'owner-decision-v1', criteria_group: 'auto',
      criteria_profile_version: 'uckele-criteria-v1', recipient_unchanged: true, created_at: at,
    });
  }
  const result = await setAutoPursueMode({ mode: 'active', dailyCap: 3,
    confirmation: AUTO_PURSUE_CONFIRMATIONS.active, actor: OWNER, reason: 'end-to-end', storage });
  assert.equal(result.status, 200, JSON.stringify(result));
}

/**
 * A deal as the daily Sheet sync leaves it: the canonical opportunity, its current score and
 * criteria group, its Sheet facts (one named listing broker), accepted with the Sheet's
 * accepted generation. Ingestion is upstream of this feature, so the acceptance is seeded.
 */
async function seedDeal(world, { opportunityId, name, fitScore, criteriaGroup, brokerEmail = BROKER_EMAIL }) {
  const { storage } = world;
  const at = new Date(Date.now() - 2 * HOUR).toISOString();
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId, created_at: at, updated_at: at, canonical_name: name,
    canonical_recipient: null, canonical_location: 'Sacramento, CA', primary_submission_id: null,
    identity_version: 'pursue-e2e', status: 'active', metadata: {},
  });
  await storage.writeDealHunterOpportunityScore({
    opportunity_id: opportunityId, scored_at: at, deal_key: `deal-${opportunityId}`,
    name, state: 'CA', listing_url: `https://broker.example/${opportunityId}`,
    fit_score: fitScore, score_status: fitScore >= 90 ? 'high-fit' : 'watchlist', confidence: 'high',
    completeness_score: 90, contradiction_count: 0, missing_evidence_count: 0, should_remove: false,
    high_fit: fitScore >= 90, gate_count: 0, score_fingerprint: `fp-${opportunityId}`,
    semantic_digest: `sd-${opportunityId}`, engine_version: 'test', rules_version: 'test',
    profile_version: 'test', completeness_policy_version: 'test', dimensions: [], gates: [],
    applied_caps: [], missing_evidence: [], confidence_reasons: [], summary: {},
    criteria_profile_version: 'uckele-criteria-v1', criteria_group: criteriaGroup,
    criteria_result: { mustHaves: [], failed: [], unknown: [] },
  });
  world.seeded.push(opportunityId);
  await storage.reconcileDealHunterCurrentScoreEligibility(world.seeded);
  for (const [field, value] of [['name', name], ['listing_url', `https://broker.example/${opportunityId}`],
    ['broker_name', 'Jordan Lee'], ['broker_email', brokerEmail]]) {
    await storage.upsertDealHunterOpportunitySourceObservation({
      id: `${opportunityId}-${field}`, opportunity_id: opportunityId, source_id: 'sheet-0',
      source_name: 'SMB Deal Hunter Google Sheet', source_record_id: `row-${opportunityId}`, field, value,
      observed_at: at, created_at: at, updated_at: at,
    });
  }
  await world.run(`UPDATE deal_hunter_opportunity_source_observations SET accepted_at = ?,
    accepted_run_id = 'sheet-run-1' WHERE opportunity_id = ?`, at, opportunityId);
  await world.run(`INSERT INTO deal_hunter_source_freshness_state (source_id, next_generation,
    accepted_generation, accepted_run_id, accepted_digest, accepted_at, projection_state)
    VALUES ('sheet-0', 2, 1, 'sheet-run-1', ?, ?, 'accepted') ON CONFLICT (source_id) DO NOTHING`,
  'c'.repeat(64), at);
  return opportunityId;
}

/** The owner clicks Request SIM on a deal (POST /api/admin/deal-hunter/triage/:id/action). */
async function ownerRequestsSim(world, opportunityId) {
  const opportunity = await world.storage.getCurrentDealHunterOpportunity(opportunityId);
  const result = await recordAcquisitionOwnerCommand({ opportunityId, action: 'pursue',
    idempotencyKey: randomUUID(), expectedDiscoveryRevision: Number(opportunity.discovery_revision),
    expectedMaterialRevision: Number(opportunity.material_revision), actor: OWNER,
    storage: world.storage, getCachedSourceHealth: getSourceHealth });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

/** The daily automatic Pursue run, after a Sheet refresh that found every score current. */
function autoPursueRuns(world) {
  const fingerprints = Object.fromEntries(world.seeded.map((id) => [id, `fp-${id}`]));
  return runAutoPursue({ storage: world.storage, now: world.clock.peek(), clock: () => world.clock.peek(),
    triggeredBy: 'sheet-sync', currentFingerprints: fingerprints });
}

async function sendAt(world, at) {
  world.clock.set(at);
  return world.send();
}

async function pollAt(world, at) {
  world.clock.set(at);
  return world.poll();
}

/** The broker answers in the campaign's Gmail thread, to our latest email. */
async function brokerReplies(world, campaign, { body, from = `Jordan Lee <${BROKER_EMAIL}>` }) {
  const { gmail_thread_id: threadId } = await world.conversation(campaign.conversation_id);
  const ours = world.mailProvider.sent.filter((message) => message.threadId === threadId);
  return world.mailProvider.injectReply(threadId, {
    internalDate: world.clock.peek().toISOString(),
    headers: { from, inReplyTo: ours.at(-1).rfcMessageId,
      references: ours.map((message) => message.rfcMessageId).join(' '),
      contentType: 'text/plain; charset=UTF-8' },
    bodyPrefix: body });
}

/** The exact copy the owner approved, for one email of a campaign. */
function expectedEmail(world, { kind, followUpNumber, isFinal = false, name }) {
  return renderPursueCimEmail({ kind, followUpNumber, isFinal, deal: { name, brokerName: 'Jordan Lee' },
    sender: world.config.dealHunter.sender, initialSubject: `CIM / NDA request for ${name}` });
}

/** Sets up sending, automatic Pursue picks a 90+ deal, and its initial goes out Monday 08:05. */
async function autoPursuedAndSent(world, { opportunityId = 'opp-auto', name = 'Acme Plumbing' } = {}) {
  await ownerTurnsSendingOn(world);
  await ownerActivatesAutoPursue(world);
  await seedDeal(world, { opportunityId, name, fitScore: 93, criteriaGroup: 'auto' });
  const run = await autoPursueRuns(world);
  assert.equal(run.commands, 1, JSON.stringify(run));
  const initial = await sendAt(world, pacific('2030-01-07', '08:05'));
  assert.equal(initial.sentInitial, 1, JSON.stringify(initial));
  return world.campaignFor(opportunityId);
}

const START = pacific('2030-01-07', '06:30');

/** 90+ deal → auto-Pursue active → initial in window → 2 follow-ups → broker reply → responded. */
async function autoPursueReplyStops(t, createBackend) {
  const world = await createWorld(t, createBackend, { start: START });
  // Gmail gives every sent message its own Message-ID; the loop must follow the real one.
  world.mailProvider.rewriteMessageIds();
  await ownerTurnsSendingOn(world);
  await ownerActivatesAutoPursue(world);
  const id = await seedDeal(world, { opportunityId: 'opp-auto', name: 'Acme Plumbing', fitScore: 93,
    criteriaGroup: 'auto' });

  // Automatic Pursue (active) records the decision and the standing contact rule enrolls the
  // listing broker: a campaign whose initial touch is due at the 08:00 window.
  const run = await autoPursueRuns(world);
  assert.deepEqual([run.ok, run.mode, run.commands], [true, 'active', 1], JSON.stringify(run));
  assert.deepEqual({ ...await world.decisionFor(id) },
    { actor: 'automation-auto-pursue', policy_version: 'auto-pursue-v1' });
  assert.equal((await world.enrollmentFor(id)).state, 'campaign-created');
  let campaign = await world.campaignFor(id);
  assert.deepEqual([campaign.state, campaign.permission_version], ['initial-pending', 'listing-broker-inquiry-v1']);
  assert.deepEqual(await world.scheduled(campaign), [['initial', pacific('2030-01-07', '08:00')]]);

  // Before its 08:00 window nothing is sent.
  const early = await sendAt(world, pacific('2030-01-07', '07:30'));
  assert.equal(early.sentInitial, 0, JSON.stringify(early));

  // In the window the initial goes out from the owner's mailbox to the listing broker.
  const first = await sendAt(world, pacific('2030-01-07', '08:05'));
  assert.equal(first.sentInitial, 1, JSON.stringify(first));
  const [initial] = world.mailProvider.sent;
  const initialCopy = expectedEmail(world, { kind: 'initial', name: 'Acme Plumbing' });
  assert.deepEqual([initial.from, initial.to, initial.subject, initial.text],
    [{ name: SENDER_SETTINGS.name, address: SENDER }, BROKER_EMAIL, initialCopy.subject, initialCopy.text]);
  campaign = await world.campaignFor(id);
  assert.equal(campaign.state, 'active-follow-up');
  assert.equal((await world.conversation(campaign.conversation_id)).gmail_thread_id, initial.threadId);
  // The communication keeps the Message-ID Gmail actually gave the initial, never overwritten.
  assert.notEqual(initial.rfcMessageId, initial.requestedRfcMessageId);
  const communicationMessageId = async (transmissionId) => (await world.one(`SELECT c.message_id
    FROM deal_hunter_cim_transmissions tr JOIN crm_communications c ON c.id = tr.communication_id
    WHERE tr.id = ?`, transmissionId)).message_id;
  assert.equal(await communicationMessageId(initial.transmissionId), initial.rfcMessageId);
  const at = world.clock.peek().toISOString();
  assert.deepEqual(await world.storage.setCimCommunicationMessageId({ transmissionId: initial.transmissionId,
    messageId: initial.rfcMessageId, now: at }), { applied: false, replay: true, conflict: false });
  assert.deepEqual(await world.storage.setCimCommunicationMessageId({ transmissionId: initial.transmissionId,
    messageId: '<other@mail.gmail.com>', now: at }), { applied: false, replay: false, conflict: true });
  assert.equal(await communicationMessageId(initial.transmissionId), initial.rfcMessageId);
  assert.deepEqual(await world.scheduled(campaign), [['follow-up-1', pacific('2030-01-09', '08:00')]]);

  // A run the next day sends nothing; follow-up 1 goes out two business days later at 08:00.
  const tuesday = await sendAt(world, pacific('2030-01-08', '10:00'));
  assert.deepEqual([tuesday.sentInitial, tuesday.sentFollowUps], [0, 0], JSON.stringify(tuesday));
  const wednesday = await sendAt(world, pacific('2030-01-09', '08:00'));
  assert.equal(wednesday.sentFollowUps, 1, JSON.stringify(wednesday));
  // The poller sees our own sends in the thread and ignores them.
  const quiet = await pollAt(world, pacific('2030-01-09', '12:00'));
  assert.deepEqual([quiet.responded, quiet.stopped, quiet.ownerReplied], [0, 0, 0], JSON.stringify(quiet));
  const friday = await sendAt(world, pacific('2030-01-11', '08:00'));
  assert.equal(friday.sentFollowUps, 1, JSON.stringify(friday));
  const [, followUp1, followUp2] = world.mailProvider.sent;
  for (const [message, number] of [[followUp1, 1], [followUp2, 2]]) {
    const copy = expectedEmail(world, { kind: 'follow-up', followUpNumber: number, name: 'Acme Plumbing' });
    assert.deepEqual([message.to, message.subject, message.text, message.threadId, message.inReplyTo],
      [BROKER_EMAIL, copy.subject, copy.text, initial.threadId, initial.rfcMessageId]);
  }
  assert.equal((await world.campaignFor(id)).state, 'active-follow-up');
  // Follow-up 3 waits over the weekend for Tuesday.
  assert.deepEqual(await world.scheduled(campaign), [['follow-up-3', pacific('2030-01-15', '08:00')]]);

  // The broker replies: the poller stops the campaign and cancels the next follow-up.
  world.clock.set(pacific('2030-01-11', '14:00'));
  await brokerReplies(world, campaign, { body: 'Thanks for reaching out. NDA attached, please sign.' });
  const poll = await pollAt(world, pacific('2030-01-11', '14:05'));
  assert.equal(poll.responded, 1, JSON.stringify(poll));
  campaign = await world.campaignFor(id);
  assert.deepEqual([campaign.state, campaign.reason_code], ['responded', 'reply_received']);
  assert.equal((await world.conversation(campaign.conversation_id)).state, 'responded');
  assert.deepEqual(await world.scheduled(campaign), []);
  assert.deepEqual(await world.suppressions(), []);

  // No more sends, on the day the next follow-up was due or later.
  for (const at of [pacific('2030-01-15', '08:00'), pacific('2030-01-17', '08:00'), pacific('2030-02-05', '09:00')]) {
    const later = await sendAt(world, at);
    assert.deepEqual([later.sentInitial, later.sentFollowUps], [0, 0], JSON.stringify(later));
  }
  assert.equal(world.mailProvider.sent.length, 3);
  assert.equal(world.mailProvider.attempts.length, 3);
}

/** 75-89 deal → owner Request SIM → the loop to day-28 expiry, ten follow-ups, Final last. */
async function requestSimToExpiry(t, createBackend) {
  const world = await createWorld(t, createBackend, { start: START });
  await ownerTurnsSendingOn(world);
  await ownerActivatesAutoPursue(world);
  const id = await seedDeal(world, { opportunityId: 'opp-review', name: 'Bayside HVAC', fitScore: 82,
    criteriaGroup: 'review' });

  // Automatic Pursue never acts below 90; the deal waits for the owner.
  const run = await autoPursueRuns(world);
  assert.equal(run.commands, 0, JSON.stringify(run));
  assert.equal(await world.campaignFor(id), undefined);

  world.clock.set(pacific('2030-01-07', '11:40'));
  const command = await ownerRequestsSim(world, id);
  assert.equal(command.enrollment.state, 'campaign-created', JSON.stringify(command.enrollment));
  assert.deepEqual({ ...await world.decisionFor(id) }, { actor: OWNER, policy_version: 'owner-decision-v1' });
  let campaign = await world.campaignFor(id);
  assert.deepEqual([campaign.state, campaign.permission_version], ['initial-pending', 'listing-broker-inquiry-v1']);

  // The scheduler's ticks for four weeks: three on each weekday, one on each weekend day.
  const sendsByDate = new Map();
  const expiredAt = [];
  for (let day = 0; day <= 30; day += 1) {
    const date = addDays('2030-01-07', day);
    const weekend = [0, 6].includes(new RealDate(`${date}T12:00:00.000Z`).getUTCDay());
    for (const time of weekend ? ['10:00'] : ['08:00', '12:00', '16:30']) {
      if (RealDate.parse(pacific(date, time)) < world.clock.peek().getTime()) continue;
      const before = world.mailProvider.sent.length;
      const summary = await sendAt(world, pacific(date, time));
      assert.equal(summary.failed + summary.ambiguous, 0, JSON.stringify(summary));
      assert.equal(summary.stoppedFor, undefined, JSON.stringify(summary));
      if (summary.expired) expiredAt.push(`${date} ${time}`);
      const sent = world.mailProvider.sent.length - before;
      if (sent) sendsByDate.set(date, [...(sendsByDate.get(date) || []), `${time}x${sent}`]);
      if (weekend) assert.equal(sent, 0, `nothing goes out on ${date}`);
    }
  }

  // Cadence v3 from an initial accepted Monday 2030-01-07 12:00 PST: each follow-up two
  // business days after the prior acceptance at 08:00 local, skipping weekends, while it is
  // due before the day-28 expiry (Monday 2030-02-04 12:00).
  const followUpDates = ['2030-01-09', '2030-01-11', '2030-01-15', '2030-01-17', '2030-01-21',
    '2030-01-23', '2030-01-25', '2030-01-29', '2030-01-31', '2030-02-04'];
  assert.deepEqual([...sendsByDate.entries()],
    [['2030-01-07', ['12:00x1']], ...followUpDates.map((date) => [date, ['08:00x1']])]);
  const [initial, ...followUps] = world.mailProvider.sent;
  assert.equal(followUps.length, 10);
  campaign = await world.campaignFor(id);
  assert.equal(iso(campaign.initial_accepted_at).slice(0, 16), pacific('2030-01-07', '12:00').slice(0, 16));
  assert.equal(iso(campaign.local_expiry_at),
    new RealDate(RealDate.parse(campaign.initial_accepted_at) + 28 * DAY).toISOString());
  const variants = followUps.map((message, index) => {
    const isFinal = index === followUps.length - 1;
    const copy = expectedEmail(world, { kind: 'follow-up', followUpNumber: index + 1, isFinal, name: 'Bayside HVAC' });
    assert.deepEqual([message.subject, message.text, message.threadId, message.inReplyTo],
      [copy.subject, copy.text, initial.threadId, initial.rfcMessageId], `follow-up ${index + 1}`);
    return copy.variant;
  });
  assert.deepEqual(variants, ['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D', 'A', 'Final']);
  assert.match(followUps.at(-1).text, /This is my last note on Bayside HVAC\./);

  // The day-28 sweep expired the campaign on the first run after its expiry; nothing is left.
  assert.deepEqual(expiredAt, ['2030-02-04 16:30']);
  assert.deepEqual([campaign.state, campaign.reason_code], ['expired', 'campaign_expired']);
  assert.deepEqual(await world.scheduled(campaign), []);
  assert.equal(world.mailProvider.attempts.length, 11);
}

/** A stop reply suppresses the broker; their next listing is refused recipient_suppressed. */
async function stopSuppressesBroker(t, createBackend) {
  const world = await createWorld(t, createBackend, { start: START });
  const campaign = await autoPursuedAndSent(world);

  // The broker answers above the quoted email: "stop".
  world.clock.set(pacific('2030-01-07', '11:00'));
  await brokerReplies(world, campaign, { body: 'Stop. Please remove me from your list.\n\n'
    + 'On Mon, Jan 7, 2030 at 8:05 AM <owner@uckele.example.test> wrote:\n> I am reaching out regarding Acme Plumbing.' });
  const poll = await pollAt(world, pacific('2030-01-07', '11:05'));
  assert.deepEqual([poll.stopped, poll.responded], [1, 0], JSON.stringify(poll));
  const stopped = await world.campaignFor('opp-auto');
  assert.deepEqual([stopped.state, stopped.reason_code], ['responded', 'reply_received']);
  assert.deepEqual(await world.scheduled(stopped), []);
  assert.deepEqual(await world.suppressions(),
    [{ normalized_email: BROKER_EMAIL, source: 'gmail-reply', lifted_at: null }]);

  // The same broker lists another business; the owner clicks Request SIM on it.
  world.clock.set(pacific('2030-01-08', '09:00'));
  const second = await seedDeal(world, { opportunityId: 'opp-second', name: 'Harbor Electric', fitScore: 85,
    criteriaGroup: 'review', brokerEmail: 'Jordan.Lee@brokerfirm.test' });
  const command = await ownerRequestsSim(world, second);
  assert.equal(command.enrollment.state, 'action-required', JSON.stringify(command.enrollment));
  const enrollment = await world.enrollmentFor(second);
  assert.deepEqual([enrollment.state, enrollment.reason_code], ['action-required', 'recipient_suppressed']);
  assert.equal(await world.campaignFor(second), undefined);

  // Nothing is ever sent to the broker again, by either listing.
  for (const at of [pacific('2030-01-08', '09:15'), pacific('2030-01-09', '08:00'), pacific('2030-01-10', '08:00')]) {
    const run = await sendAt(world, at);
    assert.deepEqual([run.sentInitial, run.sentFollowUps], [0, 0], JSON.stringify(run));
  }
  assert.equal(world.mailProvider.sent.length, 1);
  assert.equal(world.mailProvider.attempts.length, 1);
}

/** Changing the wording after approval pauses sending until the owner approves it again. */
async function wordingChangePauses(t, createBackend) {
  const world = await createWorld(t, createBackend, { start: START });
  const campaign = await autoPursuedAndSent(world);

  // The owner's title changes in settings after the wording was approved.
  world.clock.set(pacific('2030-01-08', '12:00'));
  const base = gmailConfig();
  world.setConfig({ ...base, dealHunter: { ...base.dealHunter,
    sender: { ...SENDER_SETTINGS, title: 'Managing Partner' } } });
  assert.deepEqual((await world.readiness()).reasons, ['wording_not_approved']);

  // Follow-up 1 is due Wednesday 08:00: the sender stops before touching it.
  for (const at of [pacific('2030-01-09', '08:00'), pacific('2030-01-09', '08:15')]) {
    const paused = await sendAt(world, at);
    assert.equal(paused.stoppedFor, 'not_ready', JSON.stringify(paused));
    assert.deepEqual(paused.notReadyReasons, ['wording_not_approved']);
    assert.equal(paused.sentFollowUps, 0);
  }
  assert.equal(world.mailProvider.attempts.length, 1);
  assert.equal(await world.count('deal_hunter_cim_transmissions'), 1);
  assert.equal((await world.campaignFor('opp-auto')).state, 'active-follow-up');
  assert.deepEqual(await world.scheduled(campaign), [['follow-up-1', pacific('2030-01-09', '08:00')]]);

  // The owner approves the new wording; the next run sends follow-up 1 with it, the same day.
  world.clock.set(pacific('2030-01-09', '09:00'));
  await world.control('wording_approval', true);
  const resumed = await sendAt(world, pacific('2030-01-09', '09:15'));
  assert.equal(resumed.sentFollowUps, 1, JSON.stringify(resumed));
  const [initial, followUp] = world.mailProvider.sent;
  const copy = expectedEmail(world, { kind: 'follow-up', followUpNumber: 1, name: 'Acme Plumbing' });
  assert.deepEqual([followUp.text, followUp.threadId], [copy.text, initial.threadId]);
  assert.match(followUp.text, /Managing Partner, Uckele Group/);
}

/** Live sending off mid-campaign holds the next follow-up; on again sends it. */
async function liveSendingOffAndOn(t, createBackend) {
  const world = await createWorld(t, createBackend, { start: START });
  const campaign = await autoPursuedAndSent(world);
  const first = await sendAt(world, pacific('2030-01-09', '08:00'));
  assert.equal(first.sentFollowUps, 1, JSON.stringify(first));

  // The owner turns Live sending off in Operations; the capability chain is withdrawn.
  world.clock.set(pacific('2030-01-10', '10:00'));
  const off = await world.control('live_sending', false);
  assert.deepEqual([off.enabled, off.capabilitiesInSync], [false, true]);
  assert.equal(await world.count('deal_hunter_cim_capability_activations', "status = 'current'"), 0);

  // Follow-up 2 is due Friday 08:00 and does not go out.
  for (const at of [pacific('2030-01-11', '08:00'), pacific('2030-01-11', '08:15')]) {
    const run = await sendAt(world, at);
    assert.equal(run.stoppedFor, 'not_ready', JSON.stringify(run));
    assert.deepEqual(run.notReadyReasons, ['live_sending_off']);
    assert.equal(run.sentFollowUps, 0);
  }
  assert.equal(world.mailProvider.attempts.length, 2);
  assert.equal((await world.campaignFor('opp-auto')).state, 'active-follow-up');
  assert.deepEqual(await world.scheduled(campaign), [['follow-up-2', pacific('2030-01-11', '08:00')]]);

  // On again: the next run sends follow-up 2 in the same thread.
  world.clock.set(pacific('2030-01-11', '09:00'));
  const on = await world.control('live_sending', true);
  assert.deepEqual([on.enabled, on.capabilitiesInSync], [true, true]);
  const resumed = await sendAt(world, pacific('2030-01-11', '09:15'));
  assert.equal(resumed.sentFollowUps, 1, JSON.stringify(resumed));
  const [initial, , followUp2] = world.mailProvider.sent;
  const copy = expectedEmail(world, { kind: 'follow-up', followUpNumber: 2, name: 'Acme Plumbing' });
  assert.deepEqual([followUp2.text, followUp2.threadId, followUp2.inReplyTo],
    [copy.text, initial.threadId, initial.rfcMessageId]);
  assert.deepEqual(await world.scheduled(campaign), [['follow-up-3', pacific('2030-01-15', '08:00')]]);
}

/**
 * Google's OAuth endpoints for the owner's Connect Gmail and Disconnect clicks: the token
 * exchange grants both scopes and the profile reports the fake mailbox's current historyId,
 * as Google's profile does.
 */
function fakeGoogle(world) {
  return async (url) => {
    let body = {};
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      body = { access_token: 'e2e-access', refresh_token: 'e2e-refresh', scope: SCOPES.join(' ') };
    } else if (url.endsWith('/users/me/profile')) {
      const { nextCheckpoint } = await world.mailProvider.listThreadChanges({ checkpoint: '0', threadIds: [] });
      body = { emailAddress: SENDER, historyId: nextCheckpoint };
    }
    return { ok: true, json: async () => body };
  };
}

function connectConfig(world) {
  const config = world.config;
  return { ...config, dealHunter: { ...config.dealHunter,
    gmail: { ...config.dealHunter.gmail, tokenKey: Buffer.alloc(32, 7).toString('base64') } } };
}

/** A broker reply that arrives while Gmail is disconnected is applied after the owner reconnects. */
async function reconnectKeepsReplies(t, createBackend) {
  const world = await createWorld(t, createBackend, { start: START });
  const campaign = await autoPursuedAndSent(world);
  const config = connectConfig(world);
  const fetcher = fakeGoogle(world);

  // The owner clicks Disconnect; the mailbox reads as not connected until they reconnect.
  world.clock.set(pacific('2030-01-07', '10:00'));
  await disconnectGmail({ storage: world.storage, config, actor: OWNER, now: world.clock.peek(), fetcher });
  world.mailProvider.setReadinessReasons(['gmail_not_connected']);

  // The broker replies during the gap; the poller cannot read the mailbox.
  world.clock.set(pacific('2030-01-07', '11:00'));
  await brokerReplies(world, campaign, { body: 'Happy to help. NDA attached.' });
  const gap = await pollAt(world, pacific('2030-01-07', '11:05'));
  assert.equal(gap.stoppedFor, 'gmail_not_connected', JSON.stringify(gap));

  // Follow-up 1 falls due while disconnected: nothing is sent.
  const due = await sendAt(world, pacific('2030-01-09', '08:00'));
  assert.equal(due.stoppedFor, 'not_ready', JSON.stringify(due));
  assert.equal(world.mailProvider.sent.length, 1);

  // The owner reconnects the same mailbox. Google's current historyId is already past the reply.
  world.clock.set(pacific('2030-01-09', '09:00'));
  const { state } = buildGmailConnectUrl({ config, actor: OWNER, now: world.clock.peek() });
  await completeGmailConnect({ storage: world.storage, config, code: 'e2e-code', state, actor: OWNER,
    now: world.clock.peek(), fetcher });
  world.mailProvider.setReadinessReasons([]);
  assert.deepEqual((await world.readiness()).reasons, []);

  // The next poll still reads the reply and stops the campaign before any follow-up.
  const poll = await pollAt(world, pacific('2030-01-09', '09:05'));
  assert.equal(poll.responded, 1, JSON.stringify(poll));
  const stopped = await world.campaignFor('opp-auto');
  assert.deepEqual([stopped.state, stopped.reason_code], ['responded', 'reply_received']);
  assert.deepEqual(await world.scheduled(stopped), []);
  for (const at of [pacific('2030-01-09', '09:10'), pacific('2030-01-11', '08:00')]) {
    const later = await sendAt(world, at);
    assert.deepEqual([later.sentInitial, later.sentFollowUps], [0, 0], JSON.stringify(later));
  }
  assert.equal(world.mailProvider.sent.length, 1);
  assert.equal(world.mailProvider.attempts.length, 1);
}

/** The scenarios by their spec test names, each `(t, createBackend) => Promise`. */
export const END_TO_END_SCENARIOS = Object.freeze([
  ['90+ deal → auto-Pursue active → initial sent in window → 2 follow-ups → broker reply → campaign responded, no more sends',
    autoPursueReplyStops],
  ['75-89 deal → owner Request SIM → same loop to expiry at day 28 with ≤10 follow-ups and Final last',
    requestSimToExpiry],
  ['stop reply suppresses broker; a second listing from the same broker is refused recipient_suppressed',
    stopSuppressesBroker],
  ['wording change after approval pauses sending until re-approved', wordingChangePauses],
  ['Live sending off mid-campaign stops the next follow-up; on again resumes it', liveSendingOffAndOn],
  ['a reply that arrives while Gmail is disconnected stops the campaign after reconnect, with no follow-up sent',
    reconnectKeepsReplies],
]);

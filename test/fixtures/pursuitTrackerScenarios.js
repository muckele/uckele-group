// Task 1 of the Pursued deals tracker (spec 2026-11-04 §4.3-§4.4): the immutable owner event
// table and its serialized predecessor chain, written once and run on SQLite
// (test/pursuitTrackerStorage.test.js) and on gated Postgres through the Supabase adapter
// (test/pursuitTrackerStoragePostgres.test.js). Every scenario runs on a real campaign: automatic
// Pursue picks a deal and its initial goes out, as in test/fixtures/pursueCimEndToEndFixture.js.
//
// Test files set the process environment (source health snapshot, temporary SQLite path) before
// importing this module.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getSourceHealth } from '../../server/services/acquisitionCommandCenter.js';
import { recordAcquisitionOwnerCommand } from '../../server/services/dealHunterTriage.js';
import { pursuitStageRequestDigest } from '../../server/storage/pursuitTrackerStorageContract.js';
import { START, autoPursuedAndSent, brokerReplies, createWorld, pacific, pollAt }
  from './pursueCimEndToEndFixture.js';

const OWNER = 'owner@uckele.test';
const OPPORTUNITY_ID = 'opp-auto';
const EVENT_TABLE = 'deal_hunter_pursuit_stage_events';
const EVENT_COLUMNS = ['id', 'idempotency_key', 'request_digest', 'opportunity_id', 'previous_event_id', 'kind',
  'reply_type', 'from_stage', 'stage', 'acknowledged_reply_id', 'acknowledged_processed_at',
  'secure_document_id', 'actor', 'policy_version', 'created_at'];

/** A world whose deal was auto-pursued and whose initial went out Monday 08:05. */
async function pursuedWorld(t, createBackend) {
  const world = await createWorld(t, createBackend, { start: START });
  const campaign = await autoPursuedAndSent(world, { opportunityId: OPPORTUNITY_ID });
  return { world, campaign };
}

/** A full owner event command for the world's deal, with its own key and request digest. */
function command(world, overrides = {}) {
  const base = {
    id: randomUUID(), idempotencyKey: randomUUID(), opportunityId: OPPORTUNITY_ID,
    expectedPreviousEventId: null, kind: 'stage-move', replyType: null, fromStage: 'cim-requested',
    stage: 'cim-requested', acknowledgedReplyId: null, actor: OWNER, now: world.clock.peek().toISOString(),
    ...overrides,
  };
  return { ...base, requestDigest: overrides.requestDigest ?? pursuitStageRequestDigest(base) };
}

async function record(world, overrides) {
  return world.storage.recordPursuitStageEvent(command(world, overrides));
}

const eventCount = (world) => world.count(EVENT_TABLE, 'opportunity_id = ?', OPPORTUNITY_ID);

/** The broker answers in the campaign's thread and the poller records it; returns its stored row. */
async function brokerReplyRecorded(world, campaign) {
  world.clock.set(pacific('2030-01-07', '14:00'));
  await brokerReplies(world, campaign, { body: 'Happy to share. Please sign the attached NDA.' });
  const poll = await pollAt(world, pacific('2030-01-07', '14:05'));
  assert.equal(poll.responded, 1, JSON.stringify(poll));
  const row = await world.one(`SELECT gmail_message_id FROM deal_hunter_gmail_reply_messages
    WHERE conversation_id = ? AND classification = 'reply'`, campaign.conversation_id);
  const [stored] = await world.storage.listGmailReplyMessages({ gmailMessageIds: [row.gmail_message_id] });
  return stored;
}

/** The owner clicks Watch (POST /api/admin/deal-hunter/triage/:id/action). */
async function ownerWatches(world, opportunityId) {
  const opportunity = await world.storage.getCurrentDealHunterOpportunity(opportunityId);
  const result = await recordAcquisitionOwnerCommand({ opportunityId, action: 'watch',
    idempotencyKey: randomUUID(), expectedDiscoveryRevision: Number(opportunity.discovery_revision),
    expectedMaterialRevision: Number(opportunity.material_revision), actor: OWNER,
    storage: world.storage, getCachedSourceHealth: getSourceHealth });
  assert.equal(result.ok, true, JSON.stringify(result));
}

async function stageMoveReplays(t, createBackend) {
  const { world } = await pursuedWorld(t, createBackend);
  const sameCommand = command(world, { kind: 'stage-move', stage: 'nda-sent', expectedPreviousEventId: 'genesis' });
  const first = await world.storage.recordPursuitStageEvent(sameCommand);
  assert.deepEqual([first.applied, first.replay, first.conflict, first.event.previousEventId],
    [true, false, null, 'genesis']);
  assert.deepEqual({ ...first.event, createdAt: undefined }, {
    id: sameCommand.id, idempotencyKey: sameCommand.idempotencyKey, opportunityId: OPPORTUNITY_ID,
    previousEventId: 'genesis', kind: 'stage-move', replyType: null, fromStage: 'cim-requested',
    stage: 'nda-sent', acknowledgedReplyId: null, acknowledgedProcessedAt: null, secureDocumentId: null,
    actor: OWNER, policyVersion: 'pursuit-tracker-v1', createdAt: undefined,
  });
  assert.equal(first.event.createdAt, sameCommand.now);
  assert.deepEqual(await world.storage.getPursuitStageEventByIdempotencyKey(sameCommand.idempotencyKey),
    first.event);
  assert.equal(await world.storage.getPursuitStageEventByIdempotencyKey(randomUUID()), null);

  const again = await world.storage.recordPursuitStageEvent(sameCommand);
  assert.deepEqual([again.applied, again.replay, again.conflict, again.event.id],
    [false, true, null, first.event.id]);
  const otherDigest = pursuitStageRequestDigest({ ...sameCommand, stage: 'passed' });
  const conflict = await world.storage.recordPursuitStageEvent({ ...sameCommand, stage: 'passed',
    requestDigest: otherDigest });
  assert.deepEqual([conflict.applied, conflict.replay, conflict.conflict, conflict.event],
    [false, false, 'idempotency_conflict', null]);
  assert.equal(await eventCount(world), 1);
}

async function stalePredecessorRefused(t, createBackend) {
  const { world } = await pursuedWorld(t, createBackend);
  const first = await record(world, { stage: 'nda-sent', expectedPreviousEventId: 'genesis' });
  assert.equal(first.applied, true);
  // A second tab that still saw no events.
  const stale = await record(world, { stage: 'passed', expectedPreviousEventId: 'genesis' });
  assert.deepEqual([stale.applied, stale.replay, stale.conflict, stale.event],
    [false, false, 'pursuit_stage_changed', null]);
  const unknown = await record(world, { stage: 'passed', expectedPreviousEventId: randomUUID() });
  assert.equal(unknown.conflict, 'pursuit_stage_changed');
  assert.equal(await eventCount(world), 1);
  // The tab that saw the first event appends after it.
  const fresh = await record(world, { fromStage: 'nda-sent', stage: 'passed',
    expectedPreviousEventId: first.event.id });
  assert.deepEqual([fresh.applied, fresh.event.previousEventId], [true, first.event.id]);
}

async function appendFollowsLatest(t, createBackend) {
  const { world } = await pursuedWorld(t, createBackend);
  const first = await record(world, { stage: 'nda-sent', expectedPreviousEventId: null });
  assert.deepEqual([first.applied, first.event.previousEventId], [true, 'genesis']);
  const second = await record(world, { fromStage: 'nda-sent', stage: 'cim-received',
    expectedPreviousEventId: null });
  assert.deepEqual([second.applied, second.conflict, second.event.previousEventId], [true, null, first.event.id]);
  const third = await record(world, { fromStage: 'cim-received', stage: 'financial-review',
    expectedPreviousEventId: null });
  assert.equal(third.event.previousEventId, second.event.id);
  assert.equal(await eventCount(world), 3);
}

async function foreignReplyUnknown(t, createBackend) {
  const { world, campaign } = await pursuedWorld(t, createBackend);
  // A Gmail message the poller recorded on some other conversation.
  await world.storage.recordGmailReplyMessage({ gmailMessageId: 'foreignMessage1', gmailThreadId: 'foreignThread1',
    conversationId: `${campaign.conversation_id}-other`, classification: 'reply', fromFingerprint: null,
    messageAt: null, applied: true, now: world.clock.peek().toISOString() });
  for (const acknowledgedReplyId of ['foreignMessage1', 'neverRecorded1']) {
    const result = await record(world, { kind: 'acknowledge', acknowledgedReplyId });
    assert.deepEqual([result.applied, result.replay, result.conflict, result.event],
      [false, false, 'unknown_reply', null], acknowledgedReplyId);
  }
  assert.equal(await eventCount(world), 0);
}

async function acknowledgedReplyCopiesProcessedAt(t, createBackend) {
  const { world, campaign } = await pursuedWorld(t, createBackend);
  const reply = await brokerReplyRecorded(world, campaign);
  assert.equal(reply.conversationId, campaign.conversation_id);
  world.clock.set(pacific('2030-01-07', '15:00'));
  const result = await record(world, { kind: 'acknowledge', acknowledgedReplyId: reply.gmailMessageId });
  assert.deepEqual([result.applied, result.conflict, result.event.acknowledgedReplyId],
    [true, null, reply.gmailMessageId]);
  assert.equal(result.event.acknowledgedProcessedAt, reply.processedAt);
  assert.notEqual(result.event.acknowledgedProcessedAt, result.event.createdAt);
  // A reply-type click on the same reply also carries the copy.
  const typed = await record(world, { kind: 'reply-type', replyType: 'nda-requested', stage: 'nda-sent',
    acknowledgedReplyId: reply.gmailMessageId, expectedPreviousEventId: result.event.id });
  assert.deepEqual([typed.applied, typed.event.replyType, typed.event.acknowledgedProcessedAt],
    [true, 'nda-requested', reply.processedAt]);
}

async function watchedOrMergedRefused(t, createBackend) {
  const { world } = await pursuedWorld(t, createBackend);
  await ownerWatches(world, OPPORTUNITY_ID);
  const watched = await record(world, { stage: 'nda-sent', expectedPreviousEventId: 'genesis' });
  assert.deepEqual([watched.applied, watched.conflict, watched.event], [false, 'not_pursued', null]);
  await world.run('UPDATE deal_hunter_opportunities SET status = ? WHERE opportunity_id = ?', 'merged',
    OPPORTUNITY_ID);
  const merged = await record(world, { stage: 'nda-sent', expectedPreviousEventId: 'genesis' });
  assert.deepEqual([merged.applied, merged.conflict, merged.event], [false, 'opportunity_not_active', null]);
  const missing = await record(world, { opportunityId: 'opp-never-seen', stage: 'nda-sent' });
  assert.equal(missing.conflict, 'not_pursued');
  assert.equal(await world.count(EVENT_TABLE), 0);
}

async function stageEvidenceImmutable(t, createBackend) {
  const { world } = await pursuedWorld(t, createBackend);
  const { event } = await record(world, { stage: 'nda-sent', expectedPreviousEventId: 'genesis' });
  await assert.rejects(world.run(`UPDATE ${EVENT_TABLE} SET stage = 'passed' WHERE id = ?`, event.id),
    /pursuit stage evidence is immutable/);
  await assert.rejects(world.run(`DELETE FROM ${EVENT_TABLE} WHERE id = ?`, event.id),
    /pursuit stage evidence is immutable/);
  await assert.rejects(world.run(`INSERT INTO ${EVENT_TABLE} SELECT * FROM ${EVENT_TABLE} WHERE id = ?`, event.id));
  assert.deepEqual(await world.storage.getPursuitStageEventByIdempotencyKey(event.idempotencyKey), event);
}

async function noBodyColumn(t, createBackend) {
  const { world } = await pursuedWorld(t, createBackend);
  await record(world, { stage: 'nda-sent' });
  const row = await world.one(`SELECT * FROM ${EVENT_TABLE}`);
  assert.deepEqual(Object.keys(row).sort(), [...EVENT_COLUMNS].sort());
  for (const column of Object.keys(row)) assert.doesNotMatch(column, /subject|body|snippet|note|text/);
}

async function replyTypeLeavesCampaign(t, createBackend) {
  const { world, campaign } = await pursuedWorld(t, createBackend);
  const reply = await brokerReplyRecorded(world, campaign);
  const before = await world.campaignFor(OPPORTUNITY_ID);
  const terminalEvents = await world.count('deal_hunter_cim_terminal_events', 'campaign_id = ?', campaign.id);
  world.clock.set(pacific('2030-01-07', '15:00'));
  for (const [replyType, stage] of [['nda-requested', 'nda-sent'], ['not-available', 'passed']]) {
    const result = await record(world, { kind: 'reply-type', replyType, stage,
      acknowledgedReplyId: reply.gmailMessageId });
    assert.equal(result.applied, true, JSON.stringify(result));
  }
  const after = await world.campaignFor(OPPORTUNITY_ID);
  assert.deepEqual([after.state, Number(after.row_version), Number(after.terminal_revision), after.updated_at],
    [before.state, Number(before.row_version), Number(before.terminal_revision), before.updated_at]);
  assert.equal(await world.count('deal_hunter_cim_terminal_events', 'campaign_id = ?', campaign.id),
    terminalEvents);
}

export const PURSUIT_TRACKER_SCENARIOS = Object.freeze([
  ['a stage-move appends after genesis and replays its own key', stageMoveReplays],
  ['a stale predecessor is refused with pursuit_stage_changed and writes nothing', stalePredecessorRefused],
  ['an append without a predecessor follows the latest event', appendFollowsLatest],
  ['a reply id outside the deal conversation is unknown_reply', foreignReplyUnknown],
  ['an acknowledged reply copies processed_at from the stored Gmail row', acknowledgedReplyCopiesProcessedAt],
  ['writes on a watched or merged opportunity are refused', watchedOrMergedRefused],
  ['stage evidence is immutable', stageEvidenceImmutable],
  ['no tracker column can hold a body', noBodyColumn],
  ['a reply-type write leaves the campaign row_version and terminal_revision unchanged', replyTypeLeavesCampaign],
]);

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

// Task 2 (spec §4.4): the pursuit bundle, the evidence a deal's row is folded from. The world's
// automatic Pursue warm-up leaves 25 earlier archived deals with a pursue decision each; they are
// members too, so scenarios read the deal they mean by id.
const bundlesFor = (world, ...ids) => world.storage.listPursuitBundles({
  opportunityIds: ids.length ? ids : [OPPORTUNITY_ID] });

/** A second CRM submission, copied from the campaign's, that no campaign points at. */
async function otherSubmission(world, campaign) {
  const row = await world.one('SELECT * FROM contact_submissions WHERE id = ?', campaign.crm_submission_id);
  const copy = { ...row, id: randomUUID(), deal_hunter_opportunity_id: null, metadata: '{}' };
  const columns = Object.keys(copy);
  await world.run(`INSERT INTO contact_submissions (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map((column) => (
    copy[column] !== null && typeof copy[column] === 'object' ? JSON.stringify(copy[column]) : copy[column])));
  return copy.id;
}

/** A document row on a submission, with the upload request it belongs to. */
async function addDocument(world, submissionId, { documentType, originalName, sizeBytes, createdAt }) {
  const at = createdAt;
  const request = await world.one('SELECT id FROM secure_upload_requests WHERE submission_id = ?', submissionId);
  const requestId = request?.id ?? randomUUID();
  if (!request) {
    await world.run(`INSERT INTO secure_upload_requests (id, submission_id, created_at, updated_at, email, status,
      expires_at) VALUES (?, ?, ?, ?, 'broker@example.test', 'open', ?)`, requestId, submissionId, at, at,
    new Date(Date.parse(createdAt) + 86_400_000).toISOString());
  }
  const id = randomUUID();
  await world.run(`INSERT INTO secure_documents (id, request_id, submission_id, created_at, document_type, file_name,
    original_name, mime_type, size_bytes, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?)`,
  id, requestId, submissionId, at, documentType, `${id}.pdf`, originalName, sizeBytes, `documents/${id}.pdf`);
  return id;
}

async function bundleCarriesEvidence(t, createBackend) {
  const { world, campaign } = await pursuedWorld(t, createBackend);
  const reply = await brokerReplyRecorded(world, campaign);
  const conversation = await world.conversation(campaign.conversation_id);
  const current = await world.campaignFor(OPPORTUNITY_ID);
  const elsewhere = await otherSubmission(world, campaign);
  const cimId = await addDocument(world, campaign.crm_submission_id, { documentType: 'cim',
    originalName: 'Acme CIM.pdf', sizeBytes: 1234, createdAt: pacific('2030-01-07', '16:00') });
  await addDocument(world, campaign.crm_submission_id, { documentType: 'financials',
    originalName: 'Acme financials.pdf', sizeBytes: 99, createdAt: pacific('2030-01-07', '16:01') });
  await addDocument(world, elsewhere, { documentType: 'cim', originalName: 'Other CIM.pdf', sizeBytes: 7,
    createdAt: pacific('2030-01-07', '16:02') });

  const [bundle] = await bundlesFor(world);
  assert.deepEqual([bundle.opportunityId, bundle.name, bundle.opportunityStatus],
    [OPPORTUNITY_ID, 'Acme Plumbing', 'active']);
  assert.deepEqual(bundle.documents.map((d) => d.documentType), ['cim']);
  assert.deepEqual(bundle.documents[0], { id: cimId, documentType: 'cim', originalName: 'Acme CIM.pdf',
    sizeBytes: 1234, createdAt: pacific('2030-01-07', '16:00') });
  // Every Gmail row of the conversation is evidence, ours included: the initial email we sent comes first.
  assert.deepEqual(bundle.replies.map((r) => r.classification), ['ours', 'reply']);
  const [replied] = bundle.replies.filter((r) => r.classification === 'reply');
  assert.deepEqual(replied, { gmailMessageId: reply.gmailMessageId, classification: 'reply',
    processedAt: reply.processedAt, messageAt: reply.messageAt });
  assert.equal(bundle.campaign.gmailThreadId, conversation.gmail_thread_id);
  assert.equal(reply.gmailThreadId, conversation.gmail_thread_id);
  assert.deepEqual([bundle.campaign.id, bundle.campaign.state, bundle.campaign.reasonCode,
    bundle.campaign.crmSubmissionId, bundle.campaign.conversationId],
  [current.id, current.state, current.reason_code, current.crm_submission_id, current.conversation_id]);
  assert.deepEqual(bundle.decisions.map((d) => d.action), ['pursue']);
  assert.deepEqual(bundle.events, []);
  assert.deepEqual(bundle.crm, { diligenceStage: null, diligenceUpdatedAt: null, pipelineStage: null,
    pipelineUpdatedAt: null });
}

async function crmFieldsComeFromTheCampaignSubmission(t, createBackend) {
  const { world, campaign } = await pursuedWorld(t, createBackend);
  const metadata = { diligence: { stage: 'financial-review', updated_at: '2030-01-07T20:00:00.000Z' },
    acquisitionCommand: { pipelineStage: 'diligence', updatedAt: '2030-01-07T21:00:00.000Z' } };
  await world.run('UPDATE contact_submissions SET metadata = ? WHERE id = ?', JSON.stringify(metadata),
    campaign.crm_submission_id);
  const [bundle] = await bundlesFor(world);
  assert.deepEqual(bundle.crm, { diligenceStage: 'financial-review', diligenceUpdatedAt: '2030-01-07T20:00:00.000Z',
    pipelineStage: 'diligence', pipelineUpdatedAt: '2030-01-07T21:00:00.000Z' });
  // A non-string value is not a stage.
  await world.run('UPDATE contact_submissions SET metadata = ? WHERE id = ?',
    JSON.stringify({ diligence: { stage: 7, updated_at: 'not a date' }, acquisitionCommand: 'x' }),
    campaign.crm_submission_id);
  assert.deepEqual((await bundlesFor(world))[0].crm, { diligenceStage: null,
    diligenceUpdatedAt: null, pipelineStage: null, pipelineUpdatedAt: null });
}

async function pendingGmailRowIncluded(t, createBackend) {
  const { world, campaign } = await pursuedWorld(t, createBackend);
  const conversation = await world.conversation(campaign.conversation_id);
  const recorded = await world.storage.recordGmailReplyMessage({ gmailMessageId: 'pending-message-1',
    gmailThreadId: conversation.gmail_thread_id, conversationId: campaign.conversation_id,
    classification: 'reply', fromFingerprint: null, messageAt: pacific('2030-01-07', '14:00'),
    applied: false, now: pacific('2030-01-07', '14:05') });
  assert.equal(recorded.applied, true);
  const row = await world.one('SELECT applied FROM deal_hunter_gmail_reply_messages WHERE gmail_message_id = ?',
    'pending-message-1');
  assert.ok(row.applied === 0 || row.applied === false, 'the row is pending');
  const [bundle] = await bundlesFor(world);
  assert.deepEqual(bundle.replies.filter((r) => r.classification === 'reply').map((r) => r.gmailMessageId),
    ['pending-message-1']);
}

async function noCampaignNoEvidence(t, createBackend) {
  const world = await createWorld(t, createBackend, { start: START });
  await world.storage.upsertDealHunterOpportunity({ opportunity_id: 'opp-manual', created_at: START,
    updated_at: START, canonical_name: 'Manual Pursuit', canonical_recipient: null,
    canonical_location: null, primary_submission_id: null, identity_version: 'tracker-test', status: 'active',
    metadata: {} });
  await world.run(`INSERT INTO deal_hunter_owner_decision_events (id, idempotency_key, request_digest,
    opportunity_id, action, actor, expected_discovery_revision, expected_material_revision,
    observed_discovery_revision, observed_material_revision, selected_contact_reference_digest, policy_version,
    created_at) VALUES ('decision-manual', 'key-manual', ?, 'opp-manual', 'pursue', ?, 0, 0, 0, 0, NULL,
    'owner-decision-v1', ?)`, 'a'.repeat(64), OWNER, START);
  const bundles = await bundlesFor(world, 'opp-manual');
  assert.equal(bundles.length, 1);
  assert.deepEqual({ ...bundles[0], decisions: undefined }, { opportunityId: 'opp-manual', name: 'Manual Pursuit',
    opportunityStatus: 'active', decisions: undefined, campaign: null, replies: [], documents: [], crm: null,
    events: [] });
  assert.deepEqual(bundles[0].decisions, [{ id: 'decision-manual', action: 'pursue',
    createdAt: START }]);
}

async function idsNarrowTheList(t, createBackend) {
  const { world } = await pursuedWorld(t, createBackend);
  assert.deepEqual((await world.storage.listPursuitBundles({ opportunityIds: [OPPORTUNITY_ID, OPPORTUNITY_ID] }))
    .map((b) => b.opportunityId), [OPPORTUNITY_ID]);
  assert.deepEqual((await world.storage.listPursuitBundles({ opportunityIds: ['warmup-opp-3', OPPORTUNITY_ID] }))
    .map((b) => b.opportunityId), ['opp-auto', 'warmup-opp-3']);
  assert.deepEqual(await world.storage.listPursuitBundles({ opportunityIds: ['opp-other'] }), []);
  assert.deepEqual(await world.storage.listPursuitBundles({ opportunityIds: [] }), []);
  // No ids lists every pursued deal: the 25 earlier (archived) ones and this one.
  for (const all of [await world.storage.listPursuitBundles({}), await world.storage.listPursuitBundles()]) {
    assert.equal(all.length, 26);
    assert.equal(all.filter((b) => b.opportunityStatus === 'archived').length, 25);
  }
  await assert.rejects(world.storage.listPursuitBundles({ opportunityIds: ['bad id!'] }), /Invalid opportunityIds/);
  await assert.rejects(world.storage.listPursuitBundles({
    opportunityIds: Array.from({ length: 201 }, (_, index) => `opp-${index}`) }), /Invalid opportunityIds/);
  assert.equal((await world.storage.listPursuitBundles({
    opportunityIds: Array.from({ length: 200 }, (_, index) => `opp-${index}`) })).length, 0);
}

async function neverPursuedHasNoBundle(t, createBackend) {
  const { world } = await pursuedWorld(t, createBackend);
  // A watched-only deal: it has an owner decision, but never a pursue.
  await world.storage.upsertDealHunterOpportunity({ opportunity_id: 'opp-watched', created_at: START,
    updated_at: START, canonical_name: 'Watched Only', canonical_recipient: null,
    canonical_location: null, primary_submission_id: null, identity_version: 'tracker-test', status: 'active',
    metadata: {} });
  await world.run(`INSERT INTO deal_hunter_owner_decision_events (id, idempotency_key, request_digest,
    opportunity_id, action, actor, expected_discovery_revision, expected_material_revision,
    observed_discovery_revision, observed_material_revision, selected_contact_reference_digest, policy_version,
    created_at) VALUES ('decision-watch', 'key-watch', ?, 'opp-watched', 'watch', ?, 0, 0, 0, 0, NULL,
    'owner-decision-v1', ?)`, 'b'.repeat(64), OWNER, START);
  assert.deepEqual(await world.storage.listPursuitBundles({ opportunityIds: ['opp-watched'] }), []);
  assert.equal((await world.storage.listPursuitBundles()).some((b) => b.opportunityId === 'opp-watched'), false);
  // A deal that was pursued and then passed keeps its bundle: the decisions say so, oldest first.
  await world.run(`INSERT INTO deal_hunter_owner_decision_events (id, idempotency_key, request_digest,
    opportunity_id, action, actor, expected_discovery_revision, expected_material_revision,
    observed_discovery_revision, observed_material_revision, selected_contact_reference_digest, policy_version,
    created_at) VALUES ('decision-pass', 'key-pass', ?, ?, 'pass', ?, 0, 0, 0, 0, NULL,
    'owner-decision-v1', '2030-02-01T00:00:00.000Z')`, 'c'.repeat(64), OPPORTUNITY_ID, OWNER);
  const [bundle] = await bundlesFor(world);
  assert.deepEqual(bundle.decisions.map((d) => d.action), ['pursue', 'pass']);
}

async function mergedStaysAMember(t, createBackend) {
  const { world } = await pursuedWorld(t, createBackend);
  await world.run('UPDATE deal_hunter_opportunities SET status = ? WHERE opportunity_id = ?', 'merged',
    OPPORTUNITY_ID);
  const [bundle] = await bundlesFor(world);
  assert.deepEqual([bundle.opportunityId, bundle.opportunityStatus], [OPPORTUNITY_ID, 'merged']);
}

async function eventsAndDecisionsOldestFirst(t, createBackend) {
  const { world } = await pursuedWorld(t, createBackend);
  const first = await record(world, { stage: 'nda-sent', expectedPreviousEventId: 'genesis' });
  world.clock.set(pacific('2030-01-07', '10:00'));
  const second = await record(world, { fromStage: 'nda-sent', stage: 'cim-received',
    expectedPreviousEventId: first.event.id });
  const [bundle] = await bundlesFor(world);
  assert.deepEqual(bundle.events, [first.event, second.event]);
}

// What both adapters return for the same world, ids stripped and instants as ISO. A stored
// literal, so a drift on either adapter fails against the same expectation.
const ID_KEYS = new Set(['id', 'conversationId', 'crmSubmissionId', 'gmailThreadId', 'gmailMessageId',
  'previousEventId', 'idempotencyKey']);
function withoutIds(value) {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key,
      ID_KEYS.has(key) && typeof inner === 'string' ? '<id>' : withoutIds(inner)]));
  }
  return value;
}

async function bundlesMatchAcrossAdapters(t, createBackend) {
  const { world, campaign } = await pursuedWorld(t, createBackend);
  await brokerReplyRecorded(world, campaign);
  await addDocument(world, campaign.crm_submission_id, { documentType: 'cim', originalName: 'Acme CIM.pdf',
    sizeBytes: 1234, createdAt: pacific('2030-01-07', '16:00') });
  await world.run('UPDATE contact_submissions SET metadata = ? WHERE id = ?', JSON.stringify({
    diligence: { stage: 'cim-received', updated_at: '2030-01-07T20:00:00Z' },
    acquisitionCommand: { pipelineStage: 'docs-received', updatedAt: '2030-01-07T21:00:00.500Z' } }),
  campaign.crm_submission_id);
  world.clock.set(pacific('2030-01-07', '15:00'));
  await record(world, { stage: 'nda-sent', expectedPreviousEventId: 'genesis' });
  const bundles = withoutIds(await bundlesFor(world));
  assert.deepEqual(bundles, EXPECTED_BUNDLES);
}

const EXPECTED_BUNDLES = [{
  opportunityId: 'opp-auto',
  name: 'Acme Plumbing',
  opportunityStatus: 'active',
  decisions: [{ id: '<id>', action: 'pursue', createdAt: '2030-01-07T14:30:00.000Z' }],
  campaign: { id: '<id>', state: 'responded', reasonCode: 'reply_received', crmSubmissionId: '<id>',
    conversationId: '<id>', gmailThreadId: '<id>' },
  replies: [
    { gmailMessageId: '<id>', classification: 'ours', processedAt: '2030-01-07T22:05:00.000Z',
      messageAt: '2030-01-07T16:05:16.000Z' },
    { gmailMessageId: '<id>', classification: 'reply', processedAt: '2030-01-07T22:05:01.000Z',
      messageAt: '2030-01-07T22:00:00.000Z' },
  ],
  documents: [{ id: '<id>', documentType: 'cim', originalName: 'Acme CIM.pdf', sizeBytes: 1234,
    createdAt: '2030-01-08T00:00:00.000Z' }],
  crm: { diligenceStage: 'cim-received', diligenceUpdatedAt: '2030-01-07T20:00:00.000Z',
    pipelineStage: 'docs-received', pipelineUpdatedAt: '2030-01-07T21:00:00.500Z' },
  events: [{ id: '<id>', idempotencyKey: '<id>', opportunityId: 'opp-auto', previousEventId: '<id>',
    kind: 'stage-move', replyType: null, fromStage: 'cim-requested', stage: 'nda-sent',
    acknowledgedReplyId: null, acknowledgedProcessedAt: null, secureDocumentId: null, actor: OWNER,
    policyVersion: 'pursuit-tracker-v1', createdAt: '2030-01-07T23:00:00.000Z' }],
}];


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
  ["a pursued deal's bundle carries its campaign, thread, Gmail rows and only CIM-type documents on the campaign submission",
    bundleCarriesEvidence],
  ['CRM stage fields come from the campaign submission and only when they are strings', crmFieldsComeFromTheCampaignSubmission],
  ['a pending (applied = 0) Gmail row is still in the bundle', pendingGmailRowIncluded],
  ['a pursued deal with no campaign has no documents and no CRM fields', noCampaignNoEvidence],
  ['opportunityIds narrows the list', idsNarrowTheList],
  ['a deal never pursued has no bundle', neverPursuedHasNoBundle],
  ['a merged opportunity that was pursued is still a member', mergedStaysAMember],
  ['events come back oldest first, as the event normalizer shapes them', eventsAndDecisionsOldestFirst],
  ['both adapters return deep-equal bundles for the same world', bundlesMatchAcrossAdapters],
]);

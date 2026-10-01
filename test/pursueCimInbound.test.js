import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { applyVerifiedPursueCimInbound } from '../server/services/pursueCimInbound.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';
import { createPursueCimProviderFake } from './fixtures/pursueCimHarness.js';

const observedAt = '2026-10-01T16:00:00.000Z';

function repliedEvent(overrides = {}) {
  return {
    id: 'email-event-exact-1',
    provider: 'resend',
    provider_event_id: 'signed-provider-event-1',
    event_type: 'replied',
    created_at: observedAt,
    recipient_email: 'broker@example.test',
    metadata: {
      rawType: 'email.received',
      to: ['cim-conversation-token@inbound.example.test'],
      tags: [
        { name: 'cim_conversation_id', value: 'conversation-1' },
        { name: 'cim_touch_id', value: 'touch-1' },
      ],
      ...overrides.metadata,
    },
    ...overrides,
  };
}

function exactResolution(overrides = {}) {
  return {
    exact: true,
    ambiguous: false,
    method: 'reply-alias',
    conversation: {
      id: 'conversation-1', state: 'open', terminal_revision: 2, row_version: 4,
    },
    transmission: { id: 'transmission-1' },
    campaignIds: ['campaign-1'],
    touchIds: ['touch-1'],
    ...overrides,
  };
}

function seedInboundConversation(database) {
  const at = observedAt;
  database.prepare(`INSERT INTO deal_hunter_opportunities
    (opportunity_id, created_at, updated_at, canonical_name, identity_version)
    VALUES ('opportunity-p7a', ?, ?, 'P7A fixture', 'cim-identity-v1')`).run(at, at);
  database.prepare(`INSERT INTO deal_hunter_owner_decision_events
    (id, idempotency_key, request_digest, opportunity_id, action, actor,
     expected_discovery_revision, expected_material_revision, observed_discovery_revision,
     observed_material_revision, policy_version, created_at)
    VALUES ('decision-p7a', 'idempotency-p7a', ?, 'opportunity-p7a', 'pursue', 'fixture',
      0, 0, 0, 0, 'deal-hunter-cim-autopilot-v1', ?)`).run('1'.repeat(64), at);
  database.prepare(`INSERT INTO deal_hunter_pursuit_enrollments
    (id, decision_event_id, opportunity_id, state, authority_digest, created_at, updated_at)
    VALUES ('enrollment-p7a', 'decision-p7a', 'opportunity-p7a', 'campaign-created',
      ?, ?, ?)`).run('2'.repeat(64), at, at);
  database.prepare(`INSERT INTO deal_hunter_opportunity_timezone_revisions
    (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
     evidence_digest, resolver_version, dataset_digest, actor, created_at)
    VALUES ('opportunity-p7a', 1, 'verified', 'America/Los_Angeles', 'fixture',
      'timezone-p7a', ?, 'explicit-v1', ?, 'fixture', ?)`).run('3'.repeat(64), '4'.repeat(64), at);
  database.prepare(`INSERT INTO deal_hunter_broker_conversations
    (id, recipient_authority_id, recipient_fingerprint, recipient_address,
     sender_policy_version, reply_policy_version, reply_alias_token_digest,
     rfc_thread_key, state, batching_policy_version, created_at, updated_at)
    VALUES ('conversation-p7a', 'recipient-p7a', ?, 'broker@example.test',
      'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', ?,
      'thread-p7a', 'open', 'batching-off-v1', ?, ?)`).run('5'.repeat(64), '6'.repeat(64), at, at);
  database.prepare(`INSERT INTO deal_hunter_cim_campaigns
    (id, opportunity_id, generation, enrollment_id, decision_event_id, policy_version,
     template_version, template_digest, permission_version, permission_digest,
     permission_revision, permission_scope, canonical_revision, crm_ownership_revision,
     recipient_authority_id, recipient_fingerprint, freshness_authority_digest,
     discovery_revision, material_revision, timezone_revision, conversation_id,
     state, reason_code, created_at, updated_at)
    VALUES ('campaign-p7a', 'opportunity-p7a', 1, 'enrollment-p7a', 'decision-p7a',
      'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', ?,
      'permission-p7a', ?, 1, 'cohort-p7a', 0, 0, 'recipient-p7a', ?, ?,
      0, 0, 1, 'conversation-p7a', 'initial-pending', 'awaiting-window', ?, ?)`)
    .run('7'.repeat(64), '8'.repeat(64), '5'.repeat(64), '9'.repeat(64), at, at);
  database.prepare(`INSERT INTO deal_hunter_cim_campaign_touches
    (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at, due_local,
     timezone_revision, state, created_at, updated_at)
    VALUES ('touch-p7a', 'campaign-p7a', 'opportunity-p7a', 'initial', 'initial', 0,
      ?, '2026-10-01T09:00:00-07:00', 1, 'scheduled', ?, ?)`).run(at, at, at);
  database.prepare(`INSERT INTO contact_submissions
    (id, created_at, updated_at, status, delivery_provider, delivery_status,
     crm_status, source, ip_hash, name, email, message, deal_hunter_opportunity_id)
    VALUES ('fixture-submission-p7a', ?, ?, 'open', 'none', 'not-attempted',
      'active', 'synthetic', 'fixture-ip', 'P7A Broker', 'broker@example.test',
      'P7A fixture', 'opportunity-p7a')`).run(at, at);
  database.prepare(`INSERT INTO crm_communications
    (id, opportunity_id, direction, channel, source, kind, provider, provider_message_id,
     message_id, thread_key, reply_to_address, from_address, to_addresses, subject,
     body_text, body_html_sanitized, occurred_at, created_at, updated_at, delivery_state,
     metadata)
    VALUES ('communication-p7a', 'opportunity-p7a', 'outbound', 'email',
      'pursue-cim-autopilot', 'cim-initial', 'resend', 'provider-message-p7a',
      '<rfc-parent-p7a@example.test>', 'thread-p7a', 'cim-p7a@inbound.example.test',
      'buyer@example.test', '["broker@example.test"]', 'P7A fixture', 'body', '<p>body</p>',
      ?, ?, ?, 'accepted', ?)`).run(at, at, at, JSON.stringify({
        conversationId: 'conversation-p7a', transmissionId: 'transmission-p7a',
        campaignIds: ['campaign-p7a'], touchIds: ['touch-p7a'],
      }));
  database.prepare(`INSERT INTO crm_email_outbox
    (id, communication_id, submission_id, idempotency_key, client_request_key, state,
     attempt_count, expected_submission_version, actor, created_at, updated_at, metadata)
    VALUES ('outbox-p7a', 'communication-p7a', 'fixture-submission-p7a', 'outbox-idem-p7a',
      'outbox-client-p7a', 'accepted', 1, ?, 'fixture', ?, ?, '{}')`).run(at, at, at);
  database.prepare(`INSERT INTO deal_hunter_cim_transmissions
    (id, conversation_id, member_digest, preparation_generation, payload_version,
     payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
     reply_to_address, subject, provider_idempotency_key, communication_id, outbox_id,
     state, release_state, provider, provider_message_id, created_at, updated_at)
    VALUES ('transmission-p7a', 'conversation-p7a', ?, 1, 'payload-v1', ?,
      'buyer@example.test', '["broker@example.test"]', '[]', '[]',
      'cim-p7a@inbound.example.test', 'P7A fixture', 'provider-key-p7a',
      'communication-p7a', 'outbox-p7a', 'accepted', 'ordinary', 'resend',
      'provider-message-p7a', ?, ?)`).run('a'.repeat(64), 'b'.repeat(64), at, at);
  database.prepare(`INSERT INTO deal_hunter_cim_transmission_touches
    (transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at)
    VALUES ('transmission-p7a', 'touch-p7a', 'opportunity-p7a', 'campaign-p7a', 1, ?)`)
    .run(at);
}

test('P7A scenario 54: exact signed reply evidence atomically stops the conversation', async () => {
  const calls = [];
  const storage = {
    async resolvePursueCimInboundEvidence(command) {
      calls.push(['resolve', structuredClone(command)]);
      return exactResolution();
    },
    async appendCimTerminalEvent(command) {
      calls.push(['terminal', structuredClone(command)]);
      return { applied: true, replay: false, conflict: false,
        campaignRevision: null, conversationRevision: 3, cancelledTouchIds: ['touch-1'] };
    },
  };

  const outcome = await applyVerifiedPursueCimInbound(repliedEvent(), {
    storage, now: observedAt,
  });

  assert.equal(outcome.exact, true);
  assert.equal(outcome.terminalized, true);
  assert.equal(outcome.reviewRequired, false);
  assert.deepEqual(outcome.cancelledTouchIds, ['touch-1']);
  assert.deepEqual(calls.map(([name]) => name), ['resolve', 'terminal']);
  assert.deepEqual(calls[0][1].replyToAddresses,
    ['cim-conversation-token@inbound.example.test']);
  assert.equal(calls[0][1].taggedConversationId, 'conversation-1');
  assert.deepEqual(calls[0][1].taggedTouchIds, ['touch-1']);
  assert.equal(calls[1][1].scope, 'conversation');
  assert.equal(calls[1][1].scopeId, 'conversation-1');
  assert.equal(calls[1][1].expectedRevision, 2);
  assert.equal(calls[1][1].expectedRowVersion, 4);
  assert.equal(calls[1][1].nextState, 'responded');
  assert.equal(calls[1][1].reasonCode, 'reply_received');
  assert.equal(calls[1][1].evidenceId, 'signed-provider-event-1');
});

test('P7A scenario 44: signed replay and older evidence cannot duplicate or reopen terminal state', async () => {
  let appendCalls = 0;
  const storage = {
    async resolvePursueCimInboundEvidence() {
      return exactResolution({ conversation: {
        id: 'conversation-1', state: 'responded', terminal_revision: 3, row_version: 5,
      } });
    },
    async appendCimTerminalEvent() {
      appendCalls += 1;
      throw new Error('terminal replay must be a read-through');
    },
  };

  const outcome = await applyVerifiedPursueCimInbound(repliedEvent({
    id: 'older-email-event', created_at: '2026-09-30T16:00:00.000Z',
  }), { storage, now: observedAt });

  assert.equal(outcome.exact, true);
  assert.equal(outcome.alreadyTerminal, true);
  assert.equal(outcome.terminalized, false);
  assert.equal(appendCalls, 0);
});

test('P7A terminal CAS conflict reads through to the durable terminal conversation', async () => {
  const resolutions = [
    exactResolution(),
    exactResolution({ conversation: {
      id: 'conversation-1', state: 'responded', terminal_revision: 3, row_version: 5,
    } }),
  ];
  const calls = [];
  const storage = {
    async resolvePursueCimInboundEvidence(command) {
      calls.push(['resolve', structuredClone(command)]);
      return resolutions.shift();
    },
    async appendCimTerminalEvent(command) {
      calls.push(['terminal', structuredClone(command)]);
      return { applied: false, replay: false, conflict: true, cancelledTouchIds: [] };
    },
  };

  const outcome = await applyVerifiedPursueCimInbound(repliedEvent(), {
    storage, now: observedAt,
  });

  assert.deepEqual(calls.map(([name]) => name), ['resolve', 'terminal', 'resolve']);
  assert.equal(outcome.exact, true);
  assert.equal(outcome.terminalized, false);
  assert.equal(outcome.alreadyTerminal, true);
  assert.equal(outcome.conflict, true);
});

test('P7A terminal CAS conflict fails closed when durable state is still open', async () => {
  let resolveCalls = 0;
  const storage = {
    async resolvePursueCimInboundEvidence() {
      resolveCalls += 1;
      return exactResolution();
    },
    async appendCimTerminalEvent() {
      return { applied: false, replay: false, conflict: true, cancelledTouchIds: [] };
    },
  };

  await assert.rejects(
    applyVerifiedPursueCimInbound(repliedEvent(), { storage, now: observedAt }),
    /terminalization conflict did not resolve durably/i,
  );
  assert.equal(resolveCalls, 2);
});

test('P7A scenarios 55-56: sender-only remains unassigned while conflicting exact evidence is contained', async () => {
  const resolutions = [
    { exact: false, ambiguous: false, method: 'none', conversation: null,
      transmission: null, campaignIds: [], touchIds: [], candidateConversations: [] },
    { exact: false, ambiguous: true, method: 'conflicting-exact-evidence', conversation: null,
      transmission: null, campaignIds: [], touchIds: [], candidateConversations: [{
        id: 'conversation-1', state: 'open', terminal_revision: 2, row_version: 4,
      }, {
        id: 'conversation-2', state: 'open', terminal_revision: 5, row_version: 7,
      }] },
  ];
  const terminalCommands = [];
  const commands = [];
  const storage = {
    async resolvePursueCimInboundEvidence(command) {
      commands.push(structuredClone(command));
      return resolutions.shift();
    },
    async appendCimTerminalEvent() {
      throw new Error('ambiguous candidates must use the atomic batch transition');
    },
    async appendCimAmbiguousReplyReview(commands) {
      terminalCommands.push(...structuredClone(commands));
      return { applied: true, replay: false, conflict: false,
        conversationIds: commands.map(({ scopeId }) => scopeId),
        cancelledTouchIds: ['touch-1'] };
    },
  };
  const senderOnly = repliedEvent({ metadata: {
    rawType: 'email.received', to: ['deals@inbound.example.test'], tags: [],
  } });

  const unmatched = await applyVerifiedPursueCimInbound(senderOnly, { storage, now: observedAt });
  const ambiguous = await applyVerifiedPursueCimInbound(repliedEvent(), { storage, now: observedAt });

  assert.equal(unmatched.exact, false);
  assert.equal(unmatched.reviewRequired, true);
  assert.equal(ambiguous.exact, false);
  assert.equal(ambiguous.reviewRequired, true);
  assert.deepEqual(ambiguous.containedConversationIds, ['conversation-1', 'conversation-2']);
  assert.equal(terminalCommands.length, 2);
  assert.equal(terminalCommands[0].scopeId, 'conversation-1');
  assert.equal(terminalCommands[1].scopeId, 'conversation-2');
  assert.equal(terminalCommands[0].nextState, 'reply-review-required');
  assert.equal(terminalCommands[0].reasonCode, 'ambiguous_reply_evidence');
  assert.equal('senderEmail' in commands[0], false,
    'sender identity must never enter the exact CIM resolver contract');
});

test('P7A ambiguous batch conflict reads through only when every candidate is durably contained', async () => {
  const openCandidates = ['conversation-1', 'conversation-2'].map((id, index) => ({
    id, state: 'open', terminal_revision: index, row_version: index + 1,
  }));
  let resolveCalls = 0;
  const storage = {
    async resolvePursueCimInboundEvidence() {
      resolveCalls += 1;
      return {
        exact: false, ambiguous: true, method: 'conflicting-exact-evidence',
        conversation: null, transmission: null, campaignIds: [], touchIds: [],
        candidateConversations: resolveCalls === 1
          ? openCandidates
          : openCandidates.map((conversation) => ({
              ...conversation, state: 'reply-review-required',
              terminal_revision: conversation.terminal_revision + 1,
              row_version: conversation.row_version + 1,
            })),
      };
    },
    async appendCimTerminalEvent() {
      throw new Error('single transition must not run for ambiguity');
    },
    async appendCimAmbiguousReplyReview() {
      return { applied: false, replay: false, conflict: true,
        conversationIds: ['conversation-1', 'conversation-2'], cancelledTouchIds: [] };
    },
  };

  const outcome = await applyVerifiedPursueCimInbound(repliedEvent(), { storage, now: observedAt });

  assert.equal(resolveCalls, 2);
  assert.equal(outcome.conflict, true);
  assert.deepEqual(outcome.containedConversationIds, ['conversation-1', 'conversation-2']);
});

test('P7A non-reply lifecycle evidence does not enter inbound terminal resolution', async () => {
  let resolveCalls = 0;
  const outcome = await applyVerifiedPursueCimInbound(repliedEvent({ event_type: 'delivered' }), {
    storage: { async resolvePursueCimInboundEvidence() { resolveCalls += 1; } },
    now: observedAt,
  });
  assert.deepEqual(outcome, { handled: false });
  assert.equal(resolveCalls, 0);
});

test('P7A SQLite exact-evidence resolver exposes a bounded no-match result without sender fallback', async (t) => {
  const directory = fs.mkdtempSync(path.join('/tmp', 'ug-p7a-inbound-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(directory, 'inbound.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => storage.close());

  const result = await storage.resolvePursueCimInboundEvidence({
    replyToAddresses: ['nobody@inbound.example.test'],
    provider: 'resend',
    providerMessageIds: [],
    rfcMessageIds: [],
    taggedConversationId: '',
    taggedTransmissionId: '',
    taggedTouchIds: [],
  });

  assert.deepEqual(result, {
    exact: false,
    ambiguous: false,
    method: 'none',
    conversation: null,
    transmission: null,
    campaignIds: [],
    touchIds: [],
    candidateConversations: [],
  });
  await assert.rejects(storage.resolvePursueCimInboundEvidence({
    replyToAddresses: [], provider: 'other-provider', providerMessageIds: [],
    rfcMessageIds: [], taggedConversationId: '', taggedTransmissionId: '', taggedTouchIds: [],
  }), /approved Resend adapter/i);
});

test('P7A SQLite conflicting protected evidence exposes and contains the known candidate', async (t) => {
  const directory = fs.mkdtempSync(path.join('/tmp', 'ug-p7a-conflict-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, 'inbound.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedInboundConversation(database);

  const event = repliedEvent({
    id: 'sqlite-conflicting-event-p7a',
    metadata: {
      rawType: 'email.received',
      to: ['cim-p7a@inbound.example.test'],
      tags: [{ name: 'cim_conversation_id', value: 'missing-protected-conversation' }],
    },
  });
  const resolution = await storage.resolvePursueCimInboundEvidence({
    replyToAddresses: ['cim-p7a@inbound.example.test'], provider: 'resend',
    providerMessageIds: [], rfcMessageIds: [],
    taggedConversationId: 'missing-protected-conversation', taggedTransmissionId: '',
    taggedTouchIds: [],
  });

  assert.equal(resolution.ambiguous, true);
  assert.deepEqual(resolution.candidateConversations.map(({ id }) => id), ['conversation-p7a']);
  const outcome = await applyVerifiedPursueCimInbound(event, { storage, now: observedAt });
  assert.deepEqual(outcome.containedConversationIds, ['conversation-p7a']);
  assert.equal(database.prepare(`SELECT state FROM deal_hunter_broker_conversations
    WHERE id = 'conversation-p7a'`).get().state, 'reply-review-required');
  assert.equal(database.prepare(`SELECT state FROM deal_hunter_cim_campaigns
    WHERE id = 'campaign-p7a'`).get().state, 'action-required');
  assert.equal(database.prepare(`SELECT state FROM deal_hunter_cim_campaign_touches
    WHERE id = 'touch-p7a'`).get().state, 'cancelled-before-provider');
});

test('P7A SQLite atomically contains every ambiguous candidate or none of them', async (t) => {
  const directory = fs.mkdtempSync(path.join('/tmp', 'ug-p7a-atomic-conflict-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, 'inbound.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedInboundConversation(database);
  database.prepare(`INSERT INTO deal_hunter_broker_conversations
    (id, recipient_authority_id, recipient_fingerprint, recipient_address,
     sender_policy_version, reply_policy_version, reply_alias_token_digest,
     rfc_thread_key, state, batching_policy_version, created_at, updated_at)
    VALUES ('conversation-p7a-b', 'recipient-p7a-b', ?, 'broker-b@example.test',
      'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', ?,
      'thread-p7a-b', 'open', 'batching-off-v1', ?, ?)`).run(
    'c'.repeat(64), 'd'.repeat(64), observedAt, observedAt);
  const conversations = database.prepare(`SELECT id, terminal_revision, row_version
    FROM deal_hunter_broker_conversations
    WHERE id IN ('conversation-p7a', 'conversation-p7a-b') ORDER BY id`).all();
  const commands = conversations.map((conversation) => ({
    eventId: `atomic-review-${conversation.id}`,
    scope: 'conversation', scopeId: conversation.id,
    expectedRevision: conversation.terminal_revision,
    expectedRowVersion: conversation.row_version,
    nextState: 'reply-review-required', reasonCode: 'ambiguous_reply_evidence',
    evidenceType: 'signed-inbound-conflicting-exact-evidence',
    evidenceId: 'signed-atomic-review-event', observedAt,
    actor: 'signed-email-webhook', source: 'pursue-cim-inbound',
    metadataDigest: 'e'.repeat(64), now: observedAt,
  }));

  const conflicted = storage.appendCimAmbiguousReplyReview([
    commands[0], { ...commands[1], expectedRevision: commands[1].expectedRevision + 1 },
  ]);
  assert.equal(conflicted.conflict, true);
  assert.deepEqual(database.prepare(`SELECT state FROM deal_hunter_broker_conversations
    WHERE id IN ('conversation-p7a', 'conversation-p7a-b') ORDER BY id`).all()
    .map(({ state }) => state), ['open', 'open']);

  const applied = storage.appendCimAmbiguousReplyReview(commands);
  assert.equal(applied.applied, true);
  assert.equal(applied.conflict, false);
  assert.deepEqual(applied.conversationIds, ['conversation-p7a', 'conversation-p7a-b']);
  assert.deepEqual(database.prepare(`SELECT state FROM deal_hunter_broker_conversations
    WHERE id IN ('conversation-p7a', 'conversation-p7a-b') ORDER BY id`).all()
    .map(({ state }) => state), ['reply-review-required', 'reply-review-required']);
});

test('P7A SQLite resolves alias/provider/RFC/tag evidence to one conversation and terminalizes once', async (t) => {
  const directory = fs.mkdtempSync(path.join('/tmp', 'ug-p7a-exact-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, 'inbound.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedInboundConversation(database);

  const base = {
    replyToAddresses: [], provider: 'resend', providerMessageIds: [], rfcMessageIds: [],
    taggedConversationId: '', taggedTransmissionId: '', taggedTouchIds: [],
  };
  const alias = await storage.resolvePursueCimInboundEvidence({
    ...base, replyToAddresses: ['cim-p7a@inbound.example.test'],
  });
  const provider = await storage.resolvePursueCimInboundEvidence({
    ...base, providerMessageIds: ['provider-message-p7a'],
  });
  const rfc = await storage.resolvePursueCimInboundEvidence({
    ...base, rfcMessageIds: ['<rfc-parent-p7a@example.test>'],
  });
  const tagged = await storage.resolvePursueCimInboundEvidence({
    ...base, taggedConversationId: 'conversation-p7a', taggedTransmissionId: 'transmission-p7a',
    taggedTouchIds: ['touch-p7a'],
  });

  assert.deepEqual([alias.method, provider.method, rfc.method, tagged.method],
    ['reply-alias', 'provider-message', 'rfc-thread', 'protected-tag']);
  for (const result of [alias, provider, rfc, tagged]) {
    assert.equal(result.exact, true);
    assert.equal(result.ambiguous, false);
    assert.equal(result.conversation.id, 'conversation-p7a');
    assert.deepEqual(result.campaignIds, ['campaign-p7a']);
    assert.deepEqual(result.touchIds, ['touch-p7a']);
  }

  const first = await applyVerifiedPursueCimInbound(repliedEvent({
    id: 'sqlite-email-event-p7a',
    metadata: { rawType: 'email.received', to: ['cim-p7a@inbound.example.test'], tags: [] },
  }), { storage, now: observedAt });
  const replay = await applyVerifiedPursueCimInbound(repliedEvent({
    id: 'sqlite-email-event-p7a',
    metadata: { rawType: 'email.received', to: ['cim-p7a@inbound.example.test'], tags: [] },
  }), { storage, now: observedAt });

  assert.equal(first.terminalized, true);
  assert.deepEqual(first.cancelledTouchIds, ['touch-p7a']);
  assert.equal(replay.alreadyTerminal, true);
  assert.equal(database.prepare(`SELECT state FROM deal_hunter_broker_conversations
    WHERE id = 'conversation-p7a'`).get().state, 'responded');
  assert.equal(database.prepare(`SELECT state FROM deal_hunter_cim_campaigns
    WHERE id = 'campaign-p7a'`).get().state, 'responded');
  assert.equal(database.prepare(`SELECT state FROM deal_hunter_cim_campaign_touches
    WHERE id = 'touch-p7a'`).get().state, 'cancelled-before-provider');
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_terminal_events
    WHERE conversation_id = 'conversation-p7a'`).get().count, 1);
});

test('P7A Supabase resolver uses the service-role read RPC and validates its bounded result', async () => {
  let call = null;
  const storage = createSupabaseStorage({ storage: {} }, { client: {
    async rpc(name, args) {
      call = { name, args: structuredClone(args) };
      if (name === 'pursue_cim_append_ambiguous_reply_review_v1') {
        return { data: { applied: true, replay: false, conflict: false,
          conversationIds: ['conversation-a', 'conversation-b'],
          cancelledTouchIds: ['touch-a'] }, error: null };
      }
      return { data: { exact: false, ambiguous: false, method: 'none',
        conversation: null, transmission: null, campaignIds: [], touchIds: [],
        candidateConversations: [] }, error: null };
    },
  } });
  const command = {
    replyToAddresses: [], provider: 'resend', providerMessageIds: [], rfcMessageIds: [],
    taggedConversationId: '', taggedTransmissionId: '', taggedTouchIds: [],
  };

  assert.deepEqual(await storage.resolvePursueCimInboundEvidence(command), {
    exact: false, ambiguous: false, method: 'none', conversation: null,
    transmission: null, campaignIds: [], touchIds: [], candidateConversations: [],
  });
  assert.deepEqual(call, {
    name: 'pursue_cim_resolve_inbound_v1', args: { p_command: command },
  });
  const batchCommands = [{ scopeId: 'conversation-a' }, { scopeId: 'conversation-b' }];
  assert.deepEqual(await storage.appendCimAmbiguousReplyReview(batchCommands), {
    applied: true, replay: false, conflict: false,
    conversationIds: ['conversation-a', 'conversation-b'], cancelledTouchIds: ['touch-a'],
  });
  assert.deepEqual(call, {
    name: 'pursue_cim_append_ambiguous_reply_review_v1',
    args: { p_commands: batchCommands },
  });
});

test('P7A Supabase atomic conflict reaches the service durable read-through contract', async () => {
  const calls = [];
  let resolveCalls = 0;
  const openCandidates = ['conversation-a', 'conversation-b'].map((id, index) => ({
    id, state: 'open', terminal_revision: index, row_version: index + 1,
  }));
  const storage = createSupabaseStorage({ storage: {} }, { client: {
    async rpc(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'pursue_cim_resolve_inbound_v1') {
        resolveCalls += 1;
        return { data: {
          exact: false, ambiguous: true, method: 'conflicting-exact-evidence',
          conversation: null, transmission: null, campaignIds: [], touchIds: [],
          candidateConversations: resolveCalls === 1
            ? openCandidates
            : openCandidates.map((conversation) => ({
                ...conversation, state: 'reply-review-required',
                terminal_revision: conversation.terminal_revision + 1,
                row_version: conversation.row_version + 1,
              })),
        }, error: null };
      }
      if (name === 'pursue_cim_append_ambiguous_reply_review_v1') {
        return { data: {
          applied: false, replay: false, conflict: true,
          conversationIds: ['conversation-a', 'conversation-b'], cancelledTouchIds: [],
        }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  } });

  const outcome = await applyVerifiedPursueCimInbound(repliedEvent(), {
    storage, now: observedAt,
  });

  assert.equal(outcome.conflict, true);
  assert.deepEqual(outcome.containedConversationIds, ['conversation-a', 'conversation-b']);
  assert.deepEqual(calls.map(({ name }) => name), [
    'pursue_cim_resolve_inbound_v1',
    'pursue_cim_append_ambiguous_reply_review_v1',
    'pursue_cim_resolve_inbound_v1',
  ]);
});

test('P0 scenario 54 harness: inbound evidence cannot increment outbound seam or provider counters', () => {
  const provider = createPursueCimProviderFake();
  provider.recordInbound({ eventId: 'signed-inbound-1', conversationId: 'conversation-1' });
  assert.deepEqual(provider.inboundEvents, [
    { eventId: 'signed-inbound-1', conversationId: 'conversation-1' },
  ]);
  assert.equal(provider.seamEntries.length, 0);
  assert.equal(provider.providerCalls.length, 0);
});

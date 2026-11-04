import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createSqliteStorage } from '../server/storage/sqlite.js';

const at = '2026-11-03T15:00:00.000Z';
const later = '2026-11-03T16:00:00.000Z';
const ciphertext = 'v1.aXYtYnl0ZXM=.dGFnLWJ5dGVz.Y2lwaGVydGV4dA==';
const scopes = ['https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly'];

function hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function openStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-gmail-send-storage-'));
  const sqlitePath = path.join(directory, 'gmail.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 } });
  const database = new Database(sqlitePath);
  t.after(() => {
    database.close();
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { storage, database };
}

function connection(overrides = {}) {
  return { emailAddress: 'owner@uckele.test', refreshTokenCiphertext: ciphertext,
    grantedScopes: scopes, historyCheckpoint: '1000', connectedBy: 'owner', now: at, ...overrides };
}

function seedConversation(database, suffix, { conversationState = 'open', campaignState = 'active-follow-up' } = {}) {
  const opportunityId = `opportunity-${suffix}`;
  database.prepare(`INSERT INTO deal_hunter_opportunities
    (opportunity_id, created_at, updated_at, canonical_name, identity_version)
    VALUES (?, ?, ?, ?, 'cim-identity-v1')`).run(opportunityId, at, at, `Fixture ${suffix}`);
  database.prepare(`INSERT INTO deal_hunter_owner_decision_events
    (id, idempotency_key, request_digest, opportunity_id, action, actor,
     expected_discovery_revision, expected_material_revision, observed_discovery_revision,
     observed_material_revision, policy_version, created_at)
    VALUES (?, ?, ?, ?, 'pursue', 'owner', 0, 0, 0, 0, 'owner-decision-v1', ?)`)
    .run(`decision-${suffix}`, `idempotency-${suffix}`, hex(`decision-${suffix}`), opportunityId, at);
  database.prepare(`INSERT INTO deal_hunter_pursuit_enrollments
    (id, decision_event_id, opportunity_id, state, authority_digest, created_at, updated_at)
    VALUES (?, ?, ?, 'campaign-created', ?, ?, ?)`)
    .run(`enrollment-${suffix}`, `decision-${suffix}`, opportunityId, hex(`enrollment-${suffix}`), at, at);
  database.prepare(`INSERT INTO deal_hunter_opportunity_timezone_revisions
    (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
     evidence_digest, resolver_version, dataset_digest, actor, created_at)
    VALUES (?, 1, 'verified', 'America/Los_Angeles', 'fixture', ?, ?, 'explicit-v1', ?, 'fixture', ?)`)
    .run(opportunityId, `timezone-${suffix}`, hex(`tz-${suffix}`), hex('dataset'), at);
  database.prepare(`INSERT INTO deal_hunter_broker_conversations
    (id, recipient_authority_id, recipient_fingerprint, recipient_address,
     sender_policy_version, reply_policy_version, reply_alias_token_digest,
     rfc_thread_key, state, batching_policy_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', ?, ?, ?,
      'batching-off-v1', ?, ?)`)
    .run(`conversation-${suffix}`, `recipient-${suffix}`, hex(`recipient-${suffix}`),
      `broker-${suffix}@example.test`, hex(`alias-${suffix}`), `thread-${suffix}`,
      conversationState, at, at);
  database.prepare(`INSERT INTO deal_hunter_cim_campaigns
    (id, opportunity_id, generation, enrollment_id, decision_event_id, policy_version,
     template_version, template_digest, permission_version, permission_digest,
     permission_revision, permission_scope, canonical_revision, crm_ownership_revision,
     recipient_authority_id, recipient_fingerprint, freshness_authority_digest,
     discovery_revision, material_revision, timezone_revision, conversation_id,
     state, reason_code, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, 'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', ?,
      'permission-fixture', ?, 1, 'cohort-fixture', 0, 0, ?, ?, ?, 0, 0, 1, ?, ?, NULL, ?, ?)`)
    .run(`campaign-${suffix}`, opportunityId, `enrollment-${suffix}`, `decision-${suffix}`,
      hex('template'), hex('permission'), `recipient-${suffix}`, hex(`recipient-${suffix}`),
      hex('freshness'), `conversation-${suffix}`, campaignState, at, at);
}

test('gmail connection save replaces the prior active row', async (t) => {
  const { storage, database } = openStorage(t);
  assert.equal(await storage.getGmailConnection(), null);

  const first = await storage.saveGmailConnection(connection());
  assert.equal(first.email_address, 'owner@uckele.test');
  assert.equal(first.refresh_token_ciphertext, ciphertext);
  assert.deepEqual(first.granted_scopes, scopes);
  assert.equal(first.history_checkpoint, '1000');
  assert.equal(first.connected_at, at);
  assert.equal(first.connected_by, 'owner');
  assert.equal(first.revoked_at, null);
  assert.equal(first.last_token_ok_at, null);
  assert.equal(first.last_error_code, null);

  const second = await storage.saveGmailConnection(connection({ historyCheckpoint: '2000',
    connectedBy: 'owner-again', now: later }));
  assert.notEqual(second.id, first.id);
  assert.deepEqual(await storage.getGmailConnection(), second);
  const rows = database.prepare(`SELECT id, revoked_at, revoked_by FROM deal_hunter_gmail_connections
    ORDER BY connected_at`).all();
  assert.deepEqual(rows, [
    { id: first.id, revoked_at: later, revoked_by: 'owner-again' },
    { id: second.id, revoked_at: null, revoked_by: null },
  ]);

  // Plaintext tokens, bad scopes and bad checkpoints never reach storage.
  await assert.rejects(storage.saveGmailConnection(connection({ refreshTokenCiphertext: '1//plain-refresh-token' })),
    (error) => /refreshTokenCiphertext/.test(error.message) && !error.message.includes('plain-refresh-token'));
  await assert.rejects(storage.saveGmailConnection(connection({ grantedScopes: 'gmail.send' })), /grantedScopes/);
  await assert.rejects(storage.saveGmailConnection(connection({ historyCheckpoint: 'abc' })), /historyCheckpoint/);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_gmail_connections').get().n, 2);
});

test('revoke clears the active connection', async (t) => {
  const { storage } = openStorage(t);
  assert.equal(await storage.revokeGmailConnection({ revokedBy: 'owner', now: later }), null);
  const saved = await storage.saveGmailConnection(connection());

  const okCheck = await storage.recordGmailTokenCheck({ ok: true, errorCode: 'ignored_when_ok', now: later });
  assert.equal(okCheck.last_token_ok_at, later);
  assert.equal(okCheck.last_error_code, null);
  const failedCheck = await storage.recordGmailTokenCheck({ ok: false, errorCode: 'gmail_token_invalid',
    now: '2026-11-03T17:00:00.000Z' });
  assert.equal(failedCheck.last_token_ok_at, later, 'a failed check keeps the last good instant');
  assert.equal(failedCheck.last_error_code, 'gmail_token_invalid');
  await assert.rejects(storage.recordGmailTokenCheck({ ok: false, errorCode: 'Bearer ya29.secret', now: later }),
    /errorCode/);

  const revoked = await storage.revokeGmailConnection({ revokedBy: 'owner', now: later });
  assert.equal(revoked.id, saved.id);
  assert.equal(revoked.revoked_at, later);
  assert.equal(revoked.revoked_by, 'owner');
  assert.equal(await storage.getGmailConnection(), null);
  assert.equal(await storage.revokeGmailConnection({ revokedBy: 'owner', now: later }), null);
  assert.equal(await storage.recordGmailTokenCheck({ ok: true, now: later }), null);
});

test('checkpoint compare-and-set rejects a stale expected value', async (t) => {
  const { storage } = openStorage(t);
  assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: null, next: '5', now: at }), false,
    'no connection, nothing to advance');
  await storage.saveGmailConnection(connection({ historyCheckpoint: '1000' }));
  assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: '999', next: '1500', now: later }), false);
  assert.equal((await storage.getGmailConnection()).history_checkpoint, '1000');
  assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: '1000', next: '1500', now: later }), true);
  assert.equal((await storage.getGmailConnection()).history_checkpoint, '1500');
  assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: '1000', next: '1600', now: later }), false);
  assert.equal((await storage.getGmailConnection()).history_checkpoint, '1500');
  await assert.rejects(storage.updateGmailHistoryCheckpoint({ expected: '1500', next: 'x', now: later }),
    /historyCheckpoint/);

  // A different mailbox starts from its own checkpoint (here none).
  await storage.saveGmailConnection(connection({ emailAddress: 'other@uckele.test', historyCheckpoint: null,
    now: later }));
  assert.equal((await storage.getGmailConnection()).history_checkpoint, null);
  assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: null, next: '42', now: later }), true);
  assert.equal((await storage.getGmailConnection()).history_checkpoint, '42');
});

test('reconnecting the same mailbox carries the previous checkpoint forward (Ruling U)', async (t) => {
  const { storage } = openStorage(t);
  const t1 = '2026-11-03T17:00:00.000Z';
  const t2 = '2026-11-03T18:00:00.000Z';
  const t3 = '2026-11-03T19:00:00.000Z';
  const t4 = '2026-11-03T20:00:00.000Z';
  await storage.saveGmailConnection(connection({ historyCheckpoint: '1000' }));
  assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: '1000', next: '1500', now: later }), true);

  // Reconnect while connected: the same address (any case) keeps the poller's checkpoint, not
  // Google's current historyId, so nothing that arrived since the last poll is skipped.
  const again = await storage.saveGmailConnection(connection({ emailAddress: 'Owner@Uckele.TEST',
    historyCheckpoint: '9000', now: later }));
  assert.equal(again.history_checkpoint, '1500');
  assert.equal(again.email_address, 'Owner@Uckele.TEST');

  // Disconnect, then reconnect the same mailbox: the revoked row's checkpoint carries forward.
  await storage.revokeGmailConnection({ revokedBy: 'owner', now: t1 });
  const back = await storage.saveGmailConnection(connection({ historyCheckpoint: '9100', now: t1 }));
  assert.equal(back.history_checkpoint, '1500');

  // A different mailbox starts from its own checkpoint, and so does the next switch back.
  const other = await storage.saveGmailConnection(connection({ emailAddress: 'other@uckele.test',
    historyCheckpoint: '9200', now: t2 }));
  assert.equal(other.history_checkpoint, '9200');
  const switched = await storage.saveGmailConnection(connection({ historyCheckpoint: '9300', now: t3 }));
  assert.equal(switched.history_checkpoint, '9300');

  // A previous checkpoint of none carries forward as none (the poller then reads whole threads).
  assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: '9300', next: '9400', now: t3 }), true);
  await storage.saveGmailConnection(connection({ emailAddress: 'other@uckele.test', historyCheckpoint: null,
    now: t3 }));
  const none = await storage.saveGmailConnection(connection({ emailAddress: 'other@uckele.test',
    historyCheckpoint: '9500', now: t4 }));
  assert.equal(none.history_checkpoint, null);
});

test('send control set is revisioned, audited, and rejects a stale revision with send_control_conflict', async (t) => {
  const { storage, database } = openStorage(t);
  const off = { enabled: false, valueDigest: null, policyVersion: null, changedAt: null,
    changedBy: null, revision: 0 };
  assert.deepEqual(await storage.getPursueSendControls(),
    { liveSending: off, contactRule: off, wordingApproval: off });

  const wordingDigest = hex('wording');
  const approved = await storage.setPursueSendControl({ controlKey: 'wording_approval', enabled: true,
    valueDigest: wordingDigest, policyVersion: 'pursue-cim-initial-v1', expectedRevision: 0,
    actor: 'owner', reason: 'approved copy', now: at });
  assert.deepEqual(approved, { enabled: true, valueDigest: wordingDigest,
    policyVersion: 'pursue-cim-initial-v1', changedAt: at, changedBy: 'owner', revision: 1 });

  const ruleOn = await storage.setPursueSendControl({ controlKey: 'contact_rule', enabled: true,
    valueDigest: hex('policy'), policyVersion: 'listing-broker-inquiry-v1', expectedRevision: 0,
    actor: 'owner', reason: 'standing rule', now: at });
  assert.equal(ruleOn.revision, 1);
  const ruleOff = await storage.setPursueSendControl({ controlKey: 'contact_rule', enabled: false,
    valueDigest: null, policyVersion: 'listing-broker-inquiry-v1', expectedRevision: 1,
    actor: 'owner', reason: 'pause', now: later });
  assert.equal(ruleOff.revision, 2);
  assert.equal(ruleOff.enabled, false);

  await assert.rejects(storage.setPursueSendControl({ controlKey: 'contact_rule', enabled: true,
    valueDigest: null, policyVersion: 'listing-broker-inquiry-v1', expectedRevision: 1,
    actor: 'owner', reason: 'stale', now: later }), (error) => error.code === 'send_control_conflict'
    && error.message === 'send_control_conflict');
  await assert.rejects(storage.setPursueSendControl({ controlKey: 'live_sending', enabled: true,
    expectedRevision: 3, actor: 'owner', reason: 'stale first write', now: later }),
  (error) => error.code === 'send_control_conflict');
  await assert.rejects(storage.setPursueSendControl({ controlKey: 'outbound_everything', enabled: true,
    expectedRevision: 0, actor: 'owner', reason: '', now: later }), /controlKey/);
  await assert.rejects(storage.setPursueSendControl({ controlKey: 'wording_approval', enabled: true,
    valueDigest: null, expectedRevision: 1, actor: 'owner', reason: '', now: later }), /valueDigest/);

  const controls = await storage.getPursueSendControls();
  assert.deepEqual(controls.liveSending, off);
  assert.deepEqual(controls.wordingApproval, approved);
  assert.deepEqual(controls.contactRule, ruleOff);

  const audit = database.prepare(`SELECT id, event_type, prior_state, next_state, reason_code,
    authority_digest, actor, source, occurred_at, metadata
    FROM deal_hunter_cim_audit_events WHERE event_type = 'send-control-changed'
    ORDER BY occurred_at, id`).all()
    .map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }));
  assert.deepEqual(audit, [
    { id: 'send-control:contact_rule:1', event_type: 'send-control-changed', prior_state: 'off',
      next_state: 'on', reason_code: 'contact_rule', authority_digest: hex('policy'), actor: 'owner',
      source: 'pursue-send-controls', occurred_at: at,
      metadata: { controlKey: 'contact_rule', revision: 1, policyVersion: 'listing-broker-inquiry-v1',
        valueDigest: hex('policy'), reason: 'standing rule' } },
    { id: 'send-control:wording_approval:1', event_type: 'send-control-changed', prior_state: 'off',
      next_state: 'on', reason_code: 'wording_approval', authority_digest: wordingDigest, actor: 'owner',
      source: 'pursue-send-controls', occurred_at: at,
      metadata: { controlKey: 'wording_approval', revision: 1, policyVersion: 'pursue-cim-initial-v1',
        valueDigest: wordingDigest, reason: 'approved copy' } },
    { id: 'send-control:contact_rule:2', event_type: 'send-control-changed', prior_state: 'on',
      next_state: 'off', reason_code: 'contact_rule', authority_digest: null, actor: 'owner',
      source: 'pursue-send-controls', occurred_at: later,
      metadata: { controlKey: 'contact_rule', revision: 2, policyVersion: 'listing-broker-inquiry-v1',
        valueDigest: null, reason: 'pause' } },
  ]);
});

test('provider outcome accepts gmail and still rejects unknown providers', async (t) => {
  const { storage } = openStorage(t);
  const finalize = (provider) => storage.finalizeCimTransmission({ transmissionId: 'missing-transmission',
    payloadDigest: hex('payload'), expectedRowVersion: 1, outcome: 'accepted', provider,
    providerMessageId: '18c2f0a1b2c3d4e5', providerResultCode: 'accepted', actor: 'pursue-cim-sender',
    now: at });
  // An ambiguity between two provider identities exercises the per-identity provider check too.
  const reconcile = (provider, identityProvider = provider) => storage.reconcileCimTransmission({
    transmissionId: 'missing-transmission', payloadDigest: hex('payload'), expectedRowVersion: 1,
    outcome: 'ambiguous', provider, providerResultCode: 'multiple-sent',
    evidenceType: 'gmail-find-sent', evidenceId: 'evidence-1', evidenceDigest: hex('evidence'),
    actor: 'pursue-cim-sender', now: at,
    providerIdentities: ['18c2f0a1b2c3d4e5', '18c2f0a1b2c3d4e6'].map((providerMessageId, index) => ({
      provider: identityProvider, providerMessageId, evidenceId: `evidence-${index}`,
      evidenceDigest: hex(`evidence-${index}`) })) });
  const resolve = (provider) => storage.resolvePursueCimInboundEvidence({ replyToAddresses: [], provider,
    providerMessageIds: [], rfcMessageIds: [], taggedConversationId: '', taggedTransmissionId: '',
    taggedTouchIds: [] });

  for (const provider of ['resend', 'gmail']) {
    const finalized = await finalize(provider);
    assert.equal(finalized.conflict, true, `${provider} finalize passes validation`);
    assert.equal(finalized.applied, false);
    const reconciled = await reconcile(provider);
    assert.equal(reconciled.conflict, true, `${provider} reconcile passes validation`);
    assert.equal((await resolve(provider)).exact, false);
  }
  for (const provider of ['sendgrid', 'Gmail', '', undefined]) {
    await assert.rejects(finalize(provider), /approved Resend adapter or the approved Gmail adapter/);
    await assert.rejects(reconcile(provider), /approved Resend adapter or the approved Gmail adapter/);
    await assert.rejects(resolve(provider), /approved Resend adapter or the approved Gmail adapter/);
  }
  await assert.rejects(reconcile('gmail', 'sendgrid'), /Invalid provider identity conflict evidence/);
  await assert.rejects(reconcile('gmail', null), /Invalid provider identity conflict evidence/);
});

test('open gmail conversations list excludes terminal conversations', async (t) => {
  const { storage, database } = openStorage(t);
  seedConversation(database, 'open');
  seedConversation(database, 'ambiguous', { conversationState: 'provider-ambiguous',
    campaignState: 'provider-ambiguous' });
  seedConversation(database, 'no-thread');
  seedConversation(database, 'responded', { conversationState: 'responded', campaignState: 'responded' });
  seedConversation(database, 'stopped', { conversationState: 'stopped', campaignState: 'stopped' });
  seedConversation(database, 'closed', { conversationState: 'closed', campaignState: 'expired' });
  assert.equal(database.prepare(`SELECT gmail_thread_id FROM deal_hunter_broker_conversations
    WHERE id = 'conversation-open'`).get().gmail_thread_id, null);

  for (const suffix of ['open', 'ambiguous', 'responded', 'stopped', 'closed']) {
    const result = await storage.setCimConversationGmailThread({ conversationId: `conversation-${suffix}`,
      gmailThreadId: `thread${suffix}`, now: later });
    assert.deepEqual(result, { applied: true, replay: false, conflict: false });
  }
  assert.deepEqual(await storage.setCimConversationGmailThread({ conversationId: 'conversation-open',
    gmailThreadId: 'threadopen', now: later }), { applied: false, replay: true, conflict: false });
  assert.deepEqual(await storage.setCimConversationGmailThread({ conversationId: 'conversation-open',
    gmailThreadId: 'threadother', now: later }), { applied: false, replay: false, conflict: true });
  await assert.rejects(storage.setCimConversationGmailThread({ conversationId: 'conversation-missing',
    gmailThreadId: 'threadx', now: later }), /Unknown Pursue CIM conversation/);
  await assert.rejects(storage.setCimConversationGmailThread({ conversationId: 'conversation-no-thread',
    gmailThreadId: 'bad thread id', now: later }), /gmailThreadId/);
  const stored = database.prepare(`SELECT gmail_thread_id, updated_at, row_version
    FROM deal_hunter_broker_conversations WHERE id = 'conversation-open'`).get();
  assert.deepEqual(stored, { gmail_thread_id: 'threadopen', updated_at: later, row_version: 1 },
    'the thread write leaves the terminal-writer row version alone');

  assert.deepEqual(await storage.listOpenGmailConversations(), [
    { conversationId: 'conversation-ambiguous', gmailThreadId: 'threadambiguous',
      campaignId: 'campaign-ambiguous', recipientFingerprint: hex('recipient-ambiguous') },
    { conversationId: 'conversation-open', gmailThreadId: 'threadopen',
      campaignId: 'campaign-open', recipientFingerprint: hex('recipient-open') },
  ]);
});

test('gmail-thread evidence resolves the conversation that owns the thread, ahead of other methods', async (t) => {
  const { storage, database } = openStorage(t);
  seedConversation(database, 'a');
  seedConversation(database, 'b');
  await storage.setCimConversationGmailThread({ conversationId: 'conversation-a',
    gmailThreadId: 'gmail-thread-a', now: at });
  const resolve = (extra = {}) => storage.resolvePursueCimInboundEvidence({ replyToAddresses: [],
    provider: 'gmail', providerMessageIds: [], rfcMessageIds: [], taggedConversationId: '',
    taggedTransmissionId: '', taggedTouchIds: [], ...extra });
  const exact = await resolve({ gmailThreadIds: ['gmail-thread-a'] });
  assert.equal(exact.exact, true);
  assert.equal(exact.method, 'gmail-thread');
  assert.equal(exact.conversation.id, 'conversation-a');
  assert.deepEqual(exact.campaignIds, ['campaign-a']);
  // Gmail-thread comes first even when a protected tag names the same conversation.
  assert.equal((await resolve({ gmailThreadIds: ['gmail-thread-a'],
    taggedConversationId: 'conversation-a' })).method, 'gmail-thread');
  // Evidence for two conversations is ambiguous.
  const conflicting = await resolve({ gmailThreadIds: ['gmail-thread-a'],
    taggedConversationId: 'conversation-b' });
  assert.equal(conflicting.ambiguous, true);
  assert.deepEqual(conflicting.candidateConversations.map(({ id }) => id),
    ['conversation-a', 'conversation-b']);
  assert.equal((await resolve({ gmailThreadIds: ['unknown-thread'] })).method, 'none');
  // Commands without the key (webhook evidence) are unchanged.
  assert.equal((await resolve()).method, 'none');
  await assert.rejects(resolve({ gmailThreadIds: ['x', 'x'] }), /must not contain duplicates/);
  await assert.rejects(resolve({ gmailThreadIds: 'gmail-thread-a' }), /bounded array/);
});

test('gmail reply messages are recorded once with classification, ids and a fingerprint only', async (t) => {
  const { storage, database } = openStorage(t);
  seedConversation(database, 'a');
  const row = { gmailMessageId: '18c2f0a1b2c3d4e5', gmailThreadId: 'gmail-thread-a',
    conversationId: 'conversation-a', classification: 'reply', fromFingerprint: hex('broker'),
    messageAt: at, applied: false, now: later };
  // Recorded pending before its effect, then settled; a settled row never returns to pending.
  assert.deepEqual(await storage.recordGmailReplyMessage(row), { applied: true, replay: false });
  assert.deepEqual(await storage.recordGmailReplyMessage(row), { applied: false, replay: true });
  assert.deepEqual((await storage.listPendingGmailReplyMessages({ limit: 10 }))
    .map(({ gmailMessageId, applied }) => [gmailMessageId, applied]), [['18c2f0a1b2c3d4e5', false]]);
  assert.deepEqual(await storage.recordGmailReplyMessage({ ...row, applied: true,
    classification: 'stop' }), { applied: true, replay: false });
  assert.deepEqual(await storage.recordGmailReplyMessage({ ...row, applied: true }),
    { applied: false, replay: true });
  assert.deepEqual(await storage.recordGmailReplyMessage(row), { applied: false, replay: true });
  assert.deepEqual(await storage.listPendingGmailReplyMessages(), []);
  assert.deepEqual(await storage.listGmailReplyMessages({
    gmailMessageIds: ['18c2f0a1b2c3d4e5', 'unknown'] }), [{ gmailMessageId: '18c2f0a1b2c3d4e5',
    gmailThreadId: 'gmail-thread-a', conversationId: 'conversation-a', classification: 'reply',
    fromFingerprint: hex('broker'), messageAt: at, processedAt: later, applied: true }]);
  assert.deepEqual(await storage.listGmailReplyMessages({ gmailMessageIds: [] }), []);
  await assert.rejects(storage.recordGmailReplyMessage({ ...row, gmailMessageId: 'x',
    classification: 'body' }), /Invalid classification/);
  await assert.rejects(storage.recordGmailReplyMessage({ ...row, gmailMessageId: 'y',
    fromFingerprint: 'broker@example.test' }), /Invalid fromFingerprint/);
  await assert.rejects(storage.recordGmailReplyMessage({ ...row, gmailMessageId: 'bad id' }),
    /Invalid gmailMessageId/);
  await assert.rejects(storage.listGmailReplyMessages({ gmailMessageIds: ['a', 'a'] }),
    /Invalid gmailMessageIds/);
  await assert.rejects(storage.recordGmailReplyMessage({ ...row, gmailMessageId: 'z',
    applied: 'yes' }), /Invalid applied/);
  await assert.rejects(storage.listPendingGmailReplyMessages({ limit: 0 }), /Invalid limit/);
  assert.deepEqual(await storage.listGmailConversationSentIdentities({
    conversationIds: ['conversation-a'] }), []);
  await assert.rejects(storage.listGmailConversationSentIdentities({ conversationIds: 'x' }),
    /Invalid conversationIds/);
});

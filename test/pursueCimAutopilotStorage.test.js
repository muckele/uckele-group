import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { readCimCurrentAuthority, runCimCampaignSafety } from '../server/services/cimCampaignSafety.js';
import { createCimProviderBoundaryAuthorization } from '../server/services/cimProviderBoundary.js';
import { sendPreparedMessage } from '../server/services/delivery.js';
import {
  finalizeAuthorizedCimTransmission,
  reconcileCimProviderTransmission,
  sendAuthorizedCimTransmission,
} from '../server/services/pursueCimProvider.js';
import { authorizePreparedCimTransmission } from '../server/services/pursueCimFinalGate.js';
import { deriveAcceptedCimCadence } from '../server/services/pursueCimCadence.js';
import { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } from '../server/services/dealHunterSourceSnapshotAdmission.js';
import { processCrmEmailOutbox } from '../server/services/followUpEmail.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { createPursueCimProviderFake } from './fixtures/pursueCimHarness.js';

const expectedTables = [
  'deal_hunter_broker_conversations',
  'deal_hunter_cim_audit_events',
  'deal_hunter_cim_campaign_touches',
  'deal_hunter_cim_campaigns',
  'deal_hunter_cim_capability_activations',
  'deal_hunter_cim_live_provider_authorizations',
  'deal_hunter_cim_safety_events',
  'deal_hunter_cim_terminal_events',
  'deal_hunter_cim_transmission_touches',
  'deal_hunter_cim_transmissions',
  'deal_hunter_opportunity_timezone_revisions',
  'deal_hunter_owner_decision_events',
  'deal_hunter_pursuit_enrollments',
];

const singleIdTables = expectedTables.filter((table) => ![
  'deal_hunter_cim_transmission_touches',
  'deal_hunter_opportunity_timezone_revisions',
].includes(table));

const tableDropOrder = [
  'deal_hunter_cim_audit_events',
  'deal_hunter_cim_live_provider_authorizations',
  'deal_hunter_cim_capability_activations',
  'deal_hunter_cim_safety_events',
  'deal_hunter_cim_terminal_events',
  'deal_hunter_cim_transmission_touches',
  'deal_hunter_cim_transmissions',
  'deal_hunter_cim_campaign_touches',
  'deal_hunter_cim_campaigns',
  'deal_hunter_broker_conversations',
  'deal_hunter_opportunity_timezone_revisions',
  'deal_hunter_pursuit_enrollments',
  'deal_hunter_owner_decision_events',
];

const at = '2026-09-25T19:00:00.000Z';
const digest = (character) => character.repeat(64);

async function acceptedCadence(storage, transmissionId, observedAt) {
  return deriveAcceptedCimCadence(
    await storage.readCimCadenceContext({ transmissionId }), observedAt);
}

function insertFixtureRow(database, table, row) {
  const columns = Object.keys(row);
  database.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (
    ${columns.map(() => '?').join(',')})`).run(...columns.map((column) => row[column]));
}

function primeDormantTouchForOutcome(database, sourceTransmissionId, touchId, sequence, now) {
  const source = database.prepare('SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(sourceTransmissionId);
  const communication = database.prepare('SELECT * FROM crm_communications WHERE id = ?')
    .get(source.communication_id);
  const outbox = database.prepare('SELECT * FROM crm_email_outbox WHERE id = ?')
    .get(source.outbox_id);
  const communicationId = `p6d-chain-communication-${sequence}`;
  const outboxId = `p6d-chain-outbox-${sequence}`;
  const transmissionId = `p6d-chain-transmission-${sequence}`;
  insertFixtureRow(database, 'crm_communications', { ...communication,
    id: communicationId, provider: null, provider_message_id: null,
    idempotency_key: `p6d-chain-communication-${sequence}`,
    outbox_id: outboxId, delivery_state: 'provider-pending',
    delivery_state_at: now, occurred_at: now, created_at: now, updated_at: now });
  insertFixtureRow(database, 'crm_email_outbox', { ...outbox,
    id: outboxId, communication_id: communicationId,
    idempotency_key: `p6d-chain-outbox-${sequence}`,
    client_request_key: `p6d-chain-client-${sequence}`,
    state: 'provider-pending', provider: null, provider_message_id: null,
    attempt_count: 0, created_at: now, updated_at: now });
  insertFixtureRow(database, 'deal_hunter_cim_transmissions', { ...source,
    id: transmissionId, member_digest: sha256(`p6d-chain-member-${sequence}`),
    preparation_generation: source.preparation_generation + sequence,
    payload_digest: sha256(`p6d-chain-payload-${sequence}`),
    provider_idempotency_key: `p6d-chain-provider-${sequence}`,
    communication_id: communicationId, outbox_id: outboxId,
    state: 'provider-pending', invocation_authority_count: 1,
    provider_invocation_authorized_at: now,
    boundary_nonce_digest: sha256(`p6d-chain-boundary-${sequence}`),
    provider_seam_entered_at: now, provider: null, provider_message_id: null,
    provider_result_code: null, row_version: 3, created_at: now, updated_at: now });
  const touch = database.prepare(`UPDATE deal_hunter_cim_campaign_touches
    SET state='provider-pending', transmission_id=?, row_version=row_version+1, updated_at=?
    WHERE id=? AND state='scheduled' RETURNING *`).get(transmissionId, now, touchId);
  insertFixtureRow(database, 'deal_hunter_cim_transmission_touches', {
    transmission_id: transmissionId, touch_id: touch.id,
    opportunity_id: touch.opportunity_id, campaign_id: touch.campaign_id,
    display_ordinal: 1, cancelled_at: null, cancellation_reason: null, created_at: now,
  });
  return database.prepare('SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(transmissionId);
}

function reconciliationBinding(transmission) {
  const addresses = (value) => Array.isArray(value) ? value : JSON.parse(value);
  return { transmissionId: transmission.id, payloadDigest: transmission.payload_digest,
    providerIdempotencyKey: transmission.provider_idempotency_key,
    fromAddress: transmission.from_address, toAddresses: addresses(transmission.to_addresses),
    ccAddresses: addresses(transmission.cc_addresses),
    bccAddresses: addresses(transmission.bcc_addresses),
    replyToAddress: transmission.reply_to_address, subject: transmission.subject };
}

function temporaryPath(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `ug-${prefix}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'storage.sqlite');
}

function initialize(sqlitePath) {
  const storage = createSqliteStorage({
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  });
  storage.close();
}

function tableNames(database) {
  return database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'deal_hunter_%'
    ORDER BY name
  `).all().map(({ name }) => name);
}

function fingerprintRows(database, table, orderBy) {
  return JSON.stringify(database.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all());
}

function replaceAuthorityRow(database, table, where, whereParameters, overrides) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
  const overrideValues = [];
  const select = columns.map((column) => {
    if (!Object.hasOwn(overrides, column)) return `"${column}"`;
    overrideValues.push(overrides[column]);
    return `? AS "${column}"`;
  }).join(', ');
  const quotedColumns = columns.map((column) => `"${column}"`).join(', ');
  return database.prepare(`
    INSERT OR REPLACE INTO ${table} (${quotedColumns})
    SELECT ${select} FROM ${table} WHERE ${where}
  `).run(...overrideValues, ...whereParameters);
}

function seedOpportunity(database, id = 'opp-p1a') {
  database.prepare(`
    INSERT INTO deal_hunter_opportunities (
      opportunity_id, created_at, updated_at, canonical_name, identity_version, metadata
    ) VALUES (?, ?, ?, ?, 'cim-identity-v1', '{}')
  `).run(id, at, at, `Synthetic ${id}`);
}

function seedCrmOwner(database, opportunityId, submissionId) {
  database.prepare(`
    INSERT INTO contact_submissions (
      id, created_at, updated_at, status, delivery_provider, delivery_status,
      crm_status, source, ip_hash, name, email, message, deal_hunter_opportunity_id
    ) VALUES (?, ?, ?, 'open', 'none', 'not-attempted', 'active', 'synthetic',
      'synthetic-ip', 'Synthetic broker', 'broker@example.test', 'Synthetic CRM owner', ?)
  `).run(submissionId, at, at, opportunityId);
  database.prepare('UPDATE deal_hunter_opportunities SET primary_submission_id = ? WHERE opportunity_id = ?')
    .run(submissionId, opportunityId);
  database.prepare(`
    UPDATE deal_hunter_cim_campaigns SET crm_submission_id = ?, crm_ownership_revision = 1
    WHERE opportunity_id = ?
  `).run(submissionId, opportunityId);
}

function seedTriageScore(database, opportunityId) {
  database.prepare(`INSERT INTO deal_hunter_opportunity_scores (
    opportunity_id, created_at, scored_at, deal_key, name, score_fingerprint,
    engine_version, rules_version, profile_version, completeness_policy_version,
    current_triage_eligible
  ) VALUES (?, ?, ?, ?, ?, ?, 'engine-v1', 'rules-v1', 'profile-v1', 'complete-v1', 1)`)
    .run(opportunityId, at, at, `deal:${opportunityId}`, opportunityId, `fingerprint:${opportunityId}`);
}

function seedLegacyEvidence(database) {
  seedOpportunity(database, 'opp-legacy');
  database.prepare(`
    INSERT INTO deal_hunter_opportunity_aliases (
      id, opportunity_id, alias_type, alias_value, alias_key, source,
      first_observed_at, last_observed_at, evidence_version, resolution_method,
      confidence_state, resolved_by, metadata
    ) VALUES (
      'alias-legacy', 'opp-legacy', 'fingerprint-v1', 'legacy-fingerprint',
      'fingerprint-v1:legacy-fingerprint', 'fixture', ?, ?, 'cim-identity-evidence-v1',
      'new-opportunity', 'exact', 'fixture', '{"retained":true}'
    )
  `).run(at, at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_requests (
      id, created_at, updated_at, deal_key, recipient_email, status,
      provider_message_id, request_state, delivery_state, metadata, opportunity_id
    ) VALUES (
      'legacy-request', ?, ?, 'fingerprint:legacy', 'legacy@example.test', 'sent',
      'provider-legacy-1', 'provider_accepted', 'accepted', '{"retained":true}', 'opp-legacy'
    )
  `).run(at, at);
  database.prepare(`
    INSERT INTO crm_communications (
      id, opportunity_id, cim_request_id, direction, channel, source, kind, provider,
      provider_message_id, idempotency_key, to_addresses, cc_addresses, bcc_addresses,
      subject, body_text, body_html_sanitized, occurred_at, created_at, updated_at,
      metadata
    ) VALUES (
      'legacy-communication', 'opp-legacy', 'legacy-request', 'outbound', 'email',
      'legacy-cim', 'cim-initial', 'resend', 'provider-legacy-1', 'legacy-idempotency',
      '["legacy@example.test"]', '[]', '[]', 'Legacy subject', 'Legacy body',
      '<p>Legacy body</p>', ?, ?, ?, '{"retained":true}'
    )
  `).run(at, at, at);
  database.prepare(`
    INSERT INTO email_events (
      id, created_at, provider, event_type, message_id, provider_event_id, event_key,
      recipient_email, communication_id, opportunity_id, source, metadata
    ) VALUES (
      'legacy-event', ?, 'resend', 'email.delivered', 'provider-legacy-1',
      'provider-event-legacy-1', 'resend:provider-event-legacy-1', 'legacy@example.test',
      'legacy-communication', 'opp-legacy', 'signed-webhook', '{"retained":true}'
    )
  `).run(at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_repair_manifests (
      id, created_at, updated_at, mode, status, actor, backup_reference,
      checksum, manifest, metadata
    ) VALUES (
      'legacy-repair-receipt', ?, ?, 'apply', 'completed', 'incident-owner',
      'verified-backup', ?, '{"retained":true}', '{"retained":true}'
    )
  `).run(at, at, digest('f'));
  database.prepare(`
    INSERT INTO deal_hunter_cim_safety_settings (
      id, updated_at, outreach_paused, updated_by, metadata
    ) VALUES ('global', ?, 1, 'release-owner', '{"retained":true}')
  `).run(at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_reviews (
      id, created_at, deal_key, decision, recipient_edited, automation_stage,
      opportunity_id, actor, decision_at, metadata
    ) VALUES (
      'historical-pursue', ?, 'fingerprint:legacy', 'approved', 0, 1,
      'opp-legacy', 'historical-admin', ?, '{"historicalPursue":true}'
    )
  `).run(at, at);
}

function legacyFingerprints(database) {
  return Object.fromEntries([
    ['aliases', fingerprintRows(database, 'deal_hunter_opportunity_aliases', 'id')],
    ['requests', fingerprintRows(database, 'deal_hunter_cim_requests', 'id')],
    ['communications', fingerprintRows(database, 'crm_communications', 'id')],
    ['providerEvents', fingerprintRows(database, 'email_events', 'id')],
    ['repairReceipts', fingerprintRows(database, 'deal_hunter_cim_repair_manifests', 'id')],
    ['pause', fingerprintRows(database, 'deal_hunter_cim_safety_settings', 'id')],
    ['historicalPursue', fingerprintRows(database, 'deal_hunter_cim_reviews', 'id')],
  ]);
}

function probeFromWorker(sqlitePath) {
  return new Promise((resolve, reject) => {
    const worker = fork(new URL('./fixtures/pursueCimSqliteWorker.js', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    worker.once('error', reject);
    worker.once('message', (message) => {
      worker.disconnect();
      if (message.ok) resolve(message.tables);
      else reject(new Error(message.error));
    });
    worker.send({ sqlitePath });
  });
}

function ownerCommandFromWorker(sqlitePath, command) {
  return transitionFromWorker(sqlitePath, 'owner-command', command);
}

function transitionFromWorker(sqlitePath, mode, command) {
  return new Promise((resolve, reject) => {
    const worker = fork(new URL('./fixtures/pursueCimSqliteWorker.js', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    worker.once('error', reject);
    worker.once('message', (message) => {
      worker.disconnect();
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error));
    });
    worker.send({ sqlitePath, mode, command });
  });
}

function insertBaseAuthority(database, suffix = '', recipientFingerprint = digest('e')) {
  const opportunityId = `opp-p1a${suffix}`;
  const decisionId = `decision${suffix}`;
  const enrollmentId = `enrollment${suffix}`;
  const conversationId = `conversation${suffix}`;
  const campaignId = `campaign${suffix}`;
  const touchId = `touch${suffix}`;
  seedOpportunity(database, opportunityId);
  database.prepare(`
    INSERT INTO deal_hunter_owner_decision_events (
      id, idempotency_key, request_digest, opportunity_id, action, actor,
      expected_discovery_revision, expected_material_revision,
      observed_discovery_revision, observed_material_revision, policy_version, created_at
    ) VALUES (?, ?, ?, ?, 'pursue', 'fixture-owner', 0, 0, 0, 0, 'owner-decision-v1', ?)
  `).run(decisionId, `idem${suffix}`, digest('a'), opportunityId, at);
  database.prepare(`
    INSERT INTO deal_hunter_pursuit_enrollments (
      id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
      created_at, updated_at, row_version
    ) VALUES (?, ?, ?, 'queued', 'awaiting-orchestration', ?, ?, ?, 1)
  `).run(enrollmentId, decisionId, opportunityId, digest('b'), at, at);
  database.prepare(`
    INSERT INTO deal_hunter_opportunity_timezone_revisions (
      opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
      evidence_digest, resolver_version, dataset_digest, actor, created_at
    ) VALUES (?, 1, 'verified', 'America/Los_Angeles', 'operator-verified',
      'timezone-evidence', ?, 'explicit-v1', ?, 'fixture-owner', ?)
  `).run(opportunityId, digest('c'), digest('d'), at);
  database.prepare(`
    INSERT INTO deal_hunter_broker_conversations (
      id, recipient_authority_id, recipient_fingerprint, recipient_address,
      sender_policy_version, reply_policy_version, reply_alias_token_digest,
      rfc_thread_key, state, terminal_revision, batching_policy_version,
      created_at, updated_at, row_version
    ) VALUES (?, 'recipient-authority', ?, 'broker@example.test',
      'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1',
      ?, ?, 'open', 0, 'batching-off-v1', ?, ?, 1)
  `).run(conversationId, recipientFingerprint, suffix
    ? createHash('sha256').update(`reply-alias:${suffix}`).digest('hex') : digest('f'),
  `thread${suffix}`, at, at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_campaigns (
      id, opportunity_id, generation, enrollment_id, decision_event_id,
      policy_version, template_version, template_digest, permission_version,
      permission_digest, permission_revision, permission_scope,
      canonical_revision, crm_ownership_revision, recipient_authority_id,
      recipient_fingerprint, freshness_authority_digest, discovery_revision,
      material_revision, timezone_revision, conversation_id, state, reason_code,
      terminal_revision, row_version, created_at, updated_at
    ) VALUES (
      ?, ?, 1, ?, ?, 'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', ?,
      'permission-v1', ?, 1, 'synthetic-cohort', 1, 1, 'recipient-authority',
      ?, ?, 0, 0, 1, ?, 'initial-pending', 'awaiting-window', 0, 1, ?, ?
    )
  `).run(
    campaignId, opportunityId, enrollmentId, decisionId, digest('1'), digest('2'),
    recipientFingerprint, digest('3'), conversationId, at, at,
  );
  database.prepare(`
    INSERT INTO deal_hunter_cim_campaign_touches (
      id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
      due_at, due_local, timezone_revision, state, row_version, created_at, updated_at
    ) VALUES (?, ?, ?, 'initial', 'initial', 0, ?, '2026-09-25T12:00:00-07:00',
      1, 'scheduled', 1, ?, ?)
  `).run(touchId, campaignId, opportunityId, at, at, at);
  return { opportunityId, decisionId, enrollmentId, conversationId, campaignId, touchId };
}

async function seedSyntheticActivationChain(storage, through = 'fl04b-initial') {
  const capabilities = ['fl04a-safety', 'fl04b-enrollment', 'fl04b-initial',
    'fl04c-followup', 'fl04c-batch'];
  let parentId = null;
  for (const capability of capabilities) {
    const id = `synthetic-${capability}`;
    await storage.recordCimCapabilityActivation({
      id, capability, mode: 'active', policyHash: digest('a'), configHash: digest('b'),
      actor: 'fixture-owner', reason: 'disposable test authority', confirmation: 'fixture-confirmation',
      providerProfile: 'synthetic-provider', now: at,
      ...(parentId ? { prerequisiteActivationId: parentId,
        prerequisiteEvidenceId: `evidence-${capability}`, prerequisiteEvidenceHash: digest('c') } : {}),
    });
    if (capability === through) break;
    parentId = id;
  }
}

function insertPreparedTransmission(database, authority, suffix = '') {
  const communicationId = `communication${suffix}`;
  const outboxId = `outbox${suffix}`;
  const transmissionId = `transmission${suffix}`;
  database.prepare(`
    INSERT INTO crm_communications (
      id, opportunity_id, direction, channel, source, kind, idempotency_key,
      from_address, to_addresses, cc_addresses, bcc_addresses, reply_to_address,
      subject, body_text, body_html_sanitized, occurred_at, created_at, updated_at,
      metadata
    ) VALUES (?, ?, 'outbound', 'email', 'pursue-cim-autopilot', 'cim-initial', ?,
      'sender@example.test', '["broker@example.test"]', '[]', '[]',
      'reply@example.test', 'Synthetic subject', 'Synthetic body', '<p>Synthetic body</p>',
      ?, ?, ?, '{}')
  `).run(communicationId, authority.opportunityId, `communication-idem${suffix}`, at, at, at);
  database.prepare(`
    INSERT INTO crm_email_outbox (
      id, communication_id, submission_id, idempotency_key, client_request_key,
      state, attempt_count, expected_submission_version, actor, created_at, updated_at,
      metadata
    ) VALUES (?, ?, ?, ?, ?, 'prepared', 0, 'synthetic-v1', 'fixture-owner', ?, ?, '{}')
  `).run(
    outboxId, communicationId, `submission${suffix}`, `outbox-idem${suffix}`,
    `client-request${suffix}`, at, at,
  );
  database.prepare(`
    INSERT INTO deal_hunter_cim_transmissions (
      id, conversation_id, member_digest, preparation_generation, payload_version,
      payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
      reply_to_address, subject, provider_idempotency_key, communication_id, outbox_id,
      state, release_state, invocation_authority_count, row_version, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 'payload-v1', ?, 'sender@example.test',
      '["broker@example.test"]', '[]', '[]', 'reply@example.test', 'Synthetic subject',
      ?, ?, ?, 'prepared', 'ordinary', 0, 1, ?, ?)
  `).run(
    transmissionId, authority.conversationId, digest(suffix ? '5' : '4'),
    digest(suffix ? '7' : '6'), `provider-key${suffix}`, communicationId, outboxId, at, at,
  );
  return { transmissionId, communicationId, outboxId };
}

test('P1A SQLite fresh and upgrade databases expose every inert authority and preserve legacy evidence', async (t) => {
  const freshPath = temporaryPath(t, 'pursue-cim-fresh');
  initialize(freshPath);
  const fresh = new Database(freshPath, { readonly: true });
  assert.deepEqual(expectedTables.filter((name) => !tableNames(fresh).includes(name)), []);
  for (const table of singleIdTables) {
    const id = fresh.prepare(`PRAGMA table_info(${table})`).all().find((column) => column.name === 'id');
    assert.equal(id?.notnull, 1, `${table}.id must be explicitly NOT NULL`);
    assert.equal(id?.pk, 1, `${table}.id must be the primary key`);
  }
  assert.equal(fresh.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_capability_activations').get().count, 0);
  assert.equal(fresh.prepare('SELECT COUNT(*) AS count FROM deal_hunter_pursuit_enrollments').get().count, 0);
  assert.equal(fresh.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count, 0);
  assert.equal(fresh.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 0);
  assert.equal(fresh.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_transmissions').get().count, 0);
  fresh.close();
  const workerTables = await probeFromWorker(freshPath);
  assert.deepEqual(expectedTables.filter((name) => !workerTables.includes(name)), []);

  const upgradePath = temporaryPath(t, 'pursue-cim-upgrade');
  initialize(upgradePath);
  let legacy = new Database(upgradePath);
  seedLegacyEvidence(legacy);
  legacy.close();
  initialize(upgradePath);
  legacy = new Database(upgradePath);
  legacy.pragma('foreign_keys = OFF');
  for (const table of tableDropOrder) legacy.exec(`DROP TABLE IF EXISTS ${table}`);
  legacy.pragma('foreign_keys = ON');
  const before = legacyFingerprints(legacy);
  legacy.close();

  initialize(upgradePath);
  const upgraded = new Database(upgradePath, { readonly: true });
  assert.deepEqual(expectedTables.filter((name) => !tableNames(upgraded).includes(name)), []);
  assert.deepEqual(legacyFingerprints(upgraded), before);
  for (const table of [
    'deal_hunter_owner_decision_events',
    'deal_hunter_pursuit_enrollments',
    'deal_hunter_cim_campaigns',
    'deal_hunter_cim_campaign_touches',
    'deal_hunter_cim_transmissions',
    'deal_hunter_cim_capability_activations',
  ]) {
    assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
  assert.equal(
    upgraded.prepare("SELECT outreach_paused FROM deal_hunter_cim_safety_settings WHERE id = 'global'").get().outreach_paused,
    1,
  );
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_requests WHERE id = 'legacy-request'").get().count, 1);
  upgraded.close();
});

test('P1A SQLite rejects null authority identities', (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-null-identities');
  initialize(sqlitePath);
  const database = new Database(sqlitePath);
  database.pragma('foreign_keys = ON');
  seedOpportunity(database);
  assert.throws(() => database.prepare(`
    INSERT INTO deal_hunter_owner_decision_events (
      id, idempotency_key, request_digest, opportunity_id, action, actor,
      expected_discovery_revision, expected_material_revision,
      observed_discovery_revision, observed_material_revision, policy_version, created_at
    ) VALUES (NULL, 'null-id', ?, 'opp-p1a', 'pursue', 'fixture-owner',
      0, 0, 0, 0, 'owner-decision-v1', ?)
  `).run(digest('a'), at), /NOT NULL constraint/i);
  database.close();
});

test('P1A SQLite terminal evidence must reference the exact scoped authority', (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-terminal-scope');
  initialize(sqlitePath);
  const database = new Database(sqlitePath);
  database.pragma('foreign_keys = ON');
  const authority = insertBaseAuthority(database);
  const terminalInsert = database.prepare(`
    INSERT INTO deal_hunter_cim_terminal_events (
      id, scope, scope_id, campaign_id, conversation_id, revision, reason_code,
      evidence_type, evidence_id, observed_at, actor, source, metadata_digest, created_at
    ) VALUES (?, 'campaign', ?, ?, NULL, 1, 'watch_selected', 'owner-decision',
      ?, ?, 'fixture-owner', 'test', ?, ?)
  `);
  assert.throws(() => terminalInsert.run(
    'terminal-missing', authority.campaignId, null, authority.decisionId, at, digest('8'), at,
  ), /CHECK constraint/i);
  assert.throws(() => terminalInsert.run(
    'terminal-mismatch', authority.campaignId, 'campaign-other', authority.decisionId,
    at, digest('8'), at,
  ), /CHECK constraint/i);
  assert.throws(() => terminalInsert.run(
    'terminal-nonexistent', 'campaign-missing', 'campaign-missing', authority.decisionId,
    at, digest('8'), at,
  ), /FOREIGN KEY constraint/i);
  terminalInsert.run(
    'terminal-valid', authority.campaignId, authority.campaignId, authority.decisionId,
    at, digest('8'), at,
  );
  database.close();
});
test('P1A SQLite accepts a valid authority graph and enforces foreign keys', (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-valid');
  initialize(sqlitePath);
  const database = new Database(sqlitePath);
  database.pragma('foreign_keys = ON');
  const authority = insertBaseAuthority(database);
  const transmission = insertPreparedTransmission(database, authority);
  database.prepare(`
    INSERT INTO deal_hunter_cim_transmission_touches (
      transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at
    ) VALUES (?, ?, ?, ?, 1, ?)
  `).run(transmission.transmissionId, authority.touchId, authority.opportunityId, authority.campaignId, at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_terminal_events (
      id, scope, scope_id, campaign_id, revision, reason_code, evidence_type,
      evidence_id, observed_at, actor, source, metadata_digest, created_at
    ) VALUES (
      'terminal-1', 'campaign', ?, ?, 1, 'watch_selected', 'owner-decision',
      ?, ?, 'fixture-owner', 'test', ?, ?)
  `).run(authority.campaignId, authority.campaignId, authority.decisionId, at, digest('8'), at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_safety_events (
      id, safety_run_id, opportunity_id, source_type, source_run_id,
      canonical_revision, identity_exception_revision, event_type, evidence_id,
      status, created_at, updated_at
    ) VALUES (
      'safety-1', 'run-1', ?, 'sheet', 'source-run-1', 1, 0,
      'identity-enriched', 'evidence-1', 'pending', ?, ?)
  `).run(authority.opportunityId, at, at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_audit_events (
      id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
      transmission_id, prior_state, next_state, reason_code, authority_digest,
      payload_digest, actor, source, occurred_at, metadata
    ) VALUES (
      'audit-1', 'transmission-prepared', ?, ?, ?, ?, ?, NULL, 'prepared',
      'prepared', ?, ?, 'fixture-owner', 'test', ?, '{}')
  `).run(
    authority.opportunityId, authority.campaignId, authority.conversationId,
    authority.touchId, transmission.transmissionId, digest('9'), digest('6'), at,
  );
  database.prepare(`
    INSERT INTO deal_hunter_cim_capability_activations (
      id, capability, mode, status, policy_hash, config_hash, cohort_digest,
      permission_basis_digest, permission_revision, actor, reason, confirmation,
      provider_profile, created_at, updated_at
    ) VALUES (
      'activation-1', 'fl04a-safety', 'off', 'current', ?, ?, ?, ?, 1,
      'fixture-owner', 'schema-test', 'CONFIRM-SCHEMA-ONLY', 'production', ?, ?)
  `).run(digest('a'), digest('b'), digest('c'), digest('d'), at, at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_live_provider_authorizations (
      id, activation_id, capability, writer_path, transmission_id, payload_digest,
      recipient_authority_digest, provider_profile, maximum_calls, issued_at,
      expires_at, actor, reason
    ) VALUES (
      'authorization-1', 'activation-1', 'fl04a-safety', 'synthetic-writer', ?, ?, ?,
      'production', 1, ?, '2026-09-25T20:00:00.000Z', 'fixture-owner', 'schema-test')
  `).run(transmission.transmissionId, digest('6'), digest('e'), at);

  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events').get().count, 1);
  seedOpportunity(database, 'opp-orphan');
  assert.throws(() => database.prepare(`
    INSERT INTO deal_hunter_pursuit_enrollments (
      id, decision_event_id, opportunity_id, state, authority_digest, created_at, updated_at
    ) VALUES ('orphan', 'missing-decision', ?, 'queued', ?, ?, ?)
  `).run('opp-orphan', digest('f'), at, at), /FOREIGN KEY/i);
  database.close();
});

test('P1A SQLite rejects illegal states, duplicate identities, and unsafe invocation counts', (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-constraints');
  initialize(sqlitePath);
  const database = new Database(sqlitePath);
  database.pragma('foreign_keys = ON');
  const first = insertBaseAuthority(database);
  const firstTransmission = insertPreparedTransmission(database, first);
  database.prepare(`
    INSERT INTO deal_hunter_cim_transmission_touches (
      transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at
    ) VALUES (?, ?, ?, ?, 1, ?)
  `).run(firstTransmission.transmissionId, first.touchId, first.opportunityId, first.campaignId, at);

  assert.throws(() => database.prepare(`
    INSERT INTO deal_hunter_owner_decision_events (
      id, idempotency_key, request_digest, opportunity_id, action, actor,
      expected_discovery_revision, expected_material_revision,
      observed_discovery_revision, observed_material_revision, policy_version, created_at
    ) VALUES ('bad-action', 'bad-action', ?, ?, 'send', 'fixture', 0, 0, 0, 0, 'v1', ?)
  `).run(digest('1'), first.opportunityId, at), /CHECK constraint/i);
  assert.throws(() => database.prepare(`
    INSERT INTO deal_hunter_cim_campaigns (
      id, opportunity_id, generation, enrollment_id, decision_event_id,
      policy_version, template_version, template_digest, permission_version,
      permission_digest, permission_revision, permission_scope, canonical_revision,
      crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
      freshness_authority_digest, discovery_revision, material_revision,
      timezone_revision, conversation_id, state, terminal_revision, row_version,
      created_at, updated_at
    ) SELECT 'campaign-active-2', opportunity_id, 2, enrollment_id, decision_event_id,
      policy_version, template_version, template_digest, permission_version,
      permission_digest, permission_revision, permission_scope, canonical_revision,
      crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
      freshness_authority_digest, discovery_revision, material_revision,
      timezone_revision, conversation_id, 'queued', 0, 1, ?, ?
      FROM deal_hunter_cim_campaigns WHERE id = ?
  `).run(at, at, first.campaignId), /UNIQUE constraint/i);
  database.prepare("UPDATE deal_hunter_cim_campaigns SET state = 'responded' WHERE id = ?").run(first.campaignId);
  database.prepare(`
    INSERT INTO deal_hunter_cim_campaigns (
      id, opportunity_id, generation, enrollment_id, decision_event_id,
      policy_version, template_version, template_digest, permission_version,
      permission_digest, permission_revision, permission_scope, canonical_revision,
      crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
      freshness_authority_digest, discovery_revision, material_revision,
      timezone_revision, conversation_id, state, terminal_revision, row_version,
      created_at, updated_at
    ) SELECT 'campaign-history-2', opportunity_id, 2, enrollment_id, decision_event_id,
      policy_version, template_version, template_digest, permission_version,
      permission_digest, permission_revision, permission_scope, canonical_revision,
      crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
      freshness_authority_digest, discovery_revision, material_revision,
      timezone_revision, conversation_id, 'stopped', 0, 1, ?, ?
      FROM deal_hunter_cim_campaigns WHERE id = ?
  `).run(at, at, first.campaignId);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns WHERE opportunity_id = ?").get(first.opportunityId).count, 2);

  assert.throws(() => database.prepare(`
    INSERT INTO deal_hunter_cim_campaign_touches (
      id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at,
      due_local, timezone_revision, state, row_version, created_at, updated_at
    ) VALUES ('touch-duplicate', ?, ?, 'initial', 'initial', 0, ?,
      '2026-09-25T12:00:00-07:00', 1, 'scheduled', 1, ?, ?)
  `).run(first.campaignId, first.opportunityId, at, at, at), /UNIQUE constraint/i);
  assert.throws(() => database.prepare(`
    INSERT INTO deal_hunter_cim_transmissions (
      id, conversation_id, member_digest, preparation_generation, payload_version,
      payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
      reply_to_address, subject, provider_idempotency_key, communication_id, outbox_id,
      state, release_state, invocation_authority_count, row_version, created_at, updated_at
    ) SELECT 'transmission-duplicate-provider', conversation_id, ?, 2, payload_version,
      ?, from_address, to_addresses, cc_addresses, bcc_addresses, reply_to_address,
      subject, provider_idempotency_key, 'unused-communication', 'unused-outbox',
      'prepared', 'ordinary', 0, 1, ?, ? FROM deal_hunter_cim_transmissions WHERE id = ?
  `).run(
    digest('2'), digest('3'), at, at, firstTransmission.transmissionId,
  ), /UNIQUE constraint|immutable/i);

  const second = insertBaseAuthority(database, '-second');
  const secondTransmission = insertPreparedTransmission(database, second, '-second');
  assert.throws(() => database.prepare(`
    INSERT INTO deal_hunter_cim_transmission_touches (
      transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at
    ) VALUES (?, ?, ?, ?, 1, ?)
  `).run(
    secondTransmission.transmissionId, first.touchId, first.opportunityId, first.campaignId, at,
  ), /UNIQUE constraint|immutable/i);
  database.prepare(`
    UPDATE deal_hunter_cim_transmission_touches
    SET cancelled_at = ?, cancellation_reason = 'pre-provider-rebuild'
    WHERE transmission_id = ? AND touch_id = ?
  `).run(at, firstTransmission.transmissionId, first.touchId);
  database.prepare(`
    INSERT INTO deal_hunter_cim_transmission_touches (
      transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at
    ) VALUES (?, ?, ?, ?, 1, ?)
  `).run(secondTransmission.transmissionId, first.touchId, first.opportunityId, first.campaignId, at);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_transmission_touches WHERE touch_id = ? AND cancelled_at IS NULL').get(first.touchId).count, 1);
  assert.throws(() => database.prepare('UPDATE deal_hunter_cim_transmissions SET invocation_authority_count = 2 WHERE id = ?').run(secondTransmission.transmissionId), /CHECK constraint/i);
  assert.throws(() => database.prepare(`
    INSERT INTO deal_hunter_cim_capability_activations (
      id, capability, mode, status, policy_hash, config_hash, actor, reason,
      confirmation, provider_profile, created_at, updated_at
    ) VALUES ('bad-capability', 'fl04b-send-everything', 'off', 'current', ?, ?,
      'fixture', 'invalid', 'INVALID', 'production', ?, ?)
  `).run(digest('a'), digest('b'), at, at), /CHECK constraint/i);
  database.close();
});

test('P1A SQLite retained evidence and prepared payload identity are immutable', (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-immutable');
  initialize(sqlitePath);
  const database = new Database(sqlitePath);
  database.pragma('foreign_keys = ON');
  const authority = insertBaseAuthority(database);
  const transmission = insertPreparedTransmission(database, authority);
  database.prepare(`
    INSERT INTO deal_hunter_cim_transmission_touches (
      transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at
    ) VALUES (?, ?, ?, ?, 1, ?)
  `).run(transmission.transmissionId, authority.touchId, authority.opportunityId, authority.campaignId, at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_terminal_events (
      id, scope, scope_id, campaign_id, revision, reason_code, evidence_type,
      evidence_id, observed_at, actor, source, metadata_digest, created_at
    ) VALUES ('terminal-immutable', 'campaign', ?, ?, 1, 'watch_selected',
      'owner-decision', ?, ?, 'fixture', 'test', ?, ?)
  `).run(authority.campaignId, authority.campaignId, authority.decisionId, at, digest('c'), at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_audit_events (
      id, event_type, opportunity_id, campaign_id, actor, source, occurred_at, metadata
    ) VALUES ('audit-immutable', 'campaign-created', ?, ?, 'fixture', 'test', ?, '{}')
  `).run(authority.opportunityId, authority.campaignId, at);
  for (const [sql, parameters] of [
    ["UPDATE deal_hunter_owner_decision_events SET actor = 'tampered' WHERE id = ?", [authority.decisionId]],
    ["DELETE FROM deal_hunter_opportunity_timezone_revisions WHERE opportunity_id = ?", [authority.opportunityId]],
    ["UPDATE deal_hunter_cim_terminal_events SET reason_code = 'tampered' WHERE id = 'terminal-immutable'", []],
    ["DELETE FROM deal_hunter_cim_audit_events WHERE id = 'audit-immutable'", []],
    ["UPDATE deal_hunter_cim_transmissions SET payload_digest = ? WHERE id = ?", [digest('f'), transmission.transmissionId]],
    ["UPDATE deal_hunter_cim_transmission_touches SET campaign_id = ? WHERE transmission_id = ? AND touch_id = ?", ['campaign-other', transmission.transmissionId, authority.touchId]],
  ]) {
    assert.throws(() => database.prepare(sql).run(...parameters), /immutable|retained/i, sql);
  }
  database.close();
});

test('P1A SQLite replacement writes cannot bypass retained authority guards', (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-no-replace');
  initialize(sqlitePath);
  const database = new Database(sqlitePath);
  database.pragma('foreign_keys = ON');
  assert.equal(database.pragma('recursive_triggers', { simple: true }), 0);
  seedOpportunity(database, 'opp-replace-owner');
  database.prepare(`
    INSERT INTO deal_hunter_owner_decision_events (
      id, idempotency_key, request_digest, opportunity_id, action, actor,
      expected_discovery_revision, expected_material_revision,
      observed_discovery_revision, observed_material_revision, policy_version, created_at
    ) VALUES ('decision-replace', 'idem-replace', ?, 'opp-replace-owner', 'pursue',
      'fixture-owner', 0, 0, 0, 0, 'owner-decision-v1', ?)
  `).run(digest('a'), at);
  assert.throws(
    () => replaceAuthorityRow(
      database, 'deal_hunter_owner_decision_events', 'id = ?', ['decision-replace'],
      { actor: 'tampered' },
    ),
    /immutable|retained/i,
  );
  seedOpportunity(database, 'opp-replace-timezone');
  database.prepare(`
    INSERT INTO deal_hunter_opportunity_timezone_revisions (
      opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
      evidence_digest, resolver_version, dataset_digest, actor, created_at
    ) VALUES ('opp-replace-timezone', 1, 'verified', 'America/Los_Angeles',
      'operator-verified', 'timezone-evidence', ?, 'explicit-v1', ?, 'fixture-owner', ?)
  `).run(digest('c'), digest('d'), at);
  assert.throws(
    () => replaceAuthorityRow(
      database, 'deal_hunter_opportunity_timezone_revisions',
      'opportunity_id = ? AND revision = 1', ['opp-replace-timezone'], { actor: 'tampered' },
    ),
    /immutable|retained/i,
  );
  const authority = insertBaseAuthority(database);
  const transmission = insertPreparedTransmission(database, authority);
  database.prepare(`
    INSERT INTO deal_hunter_cim_terminal_events (
      id, scope, scope_id, campaign_id, revision, reason_code, evidence_type,
      evidence_id, observed_at, actor, source, metadata_digest, created_at
    ) VALUES ('terminal-replace', 'campaign', ?, ?, 1, 'watch_selected',
      'owner-decision', ?, ?, 'fixture', 'test', ?, ?)
  `).run(authority.campaignId, authority.campaignId, authority.decisionId, at, digest('c'), at);
  database.prepare(`
    INSERT INTO deal_hunter_cim_audit_events (
      id, event_type, opportunity_id, campaign_id, actor, source, occurred_at, metadata
    ) VALUES ('audit-replace', 'campaign-created', ?, ?, 'fixture', 'test', ?, '{}')
  `).run(authority.opportunityId, authority.campaignId, at);

  for (const [table, where, parameters, overrides] of [
    ['deal_hunter_cim_terminal_events', 'id = ?', ['terminal-replace'], { reason_code: 'tampered' }],
    ['deal_hunter_cim_audit_events', 'id = ?', ['audit-replace'], { actor: 'tampered' }],
    ['deal_hunter_cim_transmissions', 'id = ?', [transmission.transmissionId], { payload_digest: digest('f') }],
  ]) {
    assert.throws(
      () => replaceAuthorityRow(database, table, where, parameters, overrides),
      /immutable|retained/i,
      table,
    );
  }
  database.prepare(`
    INSERT INTO deal_hunter_cim_transmission_touches (
      transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at
    ) VALUES (?, ?, ?, ?, 1, ?)
  `).run(transmission.transmissionId, authority.touchId, authority.opportunityId, authority.campaignId, at);
  assert.throws(
    () => replaceAuthorityRow(
      database, 'deal_hunter_cim_transmission_touches',
      'transmission_id = ? AND touch_id = ?', [transmission.transmissionId, authority.touchId],
      { display_ordinal: 2 },
    ),
    /immutable|retained/i,
  );
  database.close();
});

test('P1B owner decision applies once, replays the same request, and rejects digest drift', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-decision');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-decision');
  const command = {
    opportunityId: 'opp-decision', action: 'pursue', idempotencyKey: 'decision-key-1',
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
    actor: 'fixture-owner', policyVersion: 'owner-decision-v1', now: at,
  };
  const first = await storage.recordOwnerDecision(command);
  assert.equal(first.applied, true);
  assert.equal(first.enrollment?.state, 'queued');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events').get().count, 1);
  const replay = await storage.recordOwnerDecision(command);
  assert.equal(replay.replay, true);
  assert.equal(replay.decision.id, first.decision.id);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_pursuit_enrollments').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events').get().count, 1);
  const conflict = await storage.recordOwnerDecision({ ...command, action: 'watch' });
  assert.equal(conflict.conflict, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_owner_decision_events').get().count, 1);
});

test('P4A two SQLite processes converge duplicate Pursue on one event and enrollment', async (t) => {
  const sqlitePath = temporaryPath(t, 'p4a-owner-race');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-owner-race');
  seedTriageScore(database, 'opp-owner-race');
  const command = { opportunityId: 'opp-owner-race', action: 'pursue',
    idempotencyKey: 'p4a-race-key', expectedDiscoveryRevision: 0,
    expectedMaterialRevision: 0, actor: 'fixture-owner', policyVersion: 'owner-decision-v1', now: at };
  const outcomes = await Promise.all([
    ownerCommandFromWorker(sqlitePath, command), ownerCommandFromWorker(sqlitePath, command),
  ]);
  assert.deepEqual(outcomes.map((item) => [item.applied, item.replay]).sort(),
    [[false, true], [true, false]]);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_owner_decision_events
    WHERE opportunity_id = ?`).get(command.opportunityId).count, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_pursuit_enrollments
    WHERE opportunity_id = ?`).get(command.opportunityId).count, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns
    WHERE opportunity_id = ?`).get(command.opportunityId).count, 0);
});

test('P1B timezone revisions append once and reject stale or changed replay', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-timezone');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-timezone');
  const command = {
    opportunityId: 'opp-timezone', expectedPriorRevision: 0, idempotencyKey: 'timezone-key-1',
    state: 'verified', ianaTimezone: 'America/Los_Angeles', evidenceType: 'operator-verified',
    evidenceId: 'evidence-1', evidenceDigest: digest('a'), resolverVersion: 'explicit-v1',
    datasetDigest: digest('b'), actor: 'fixture-owner', now: at,
  };
  const first = await storage.appendOpportunityTimezoneRevision(command);
  assert.equal(first.applied, true);
  assert.equal(first.timezoneRevision.revision, 1);
  assert.equal((await storage.appendOpportunityTimezoneRevision(command)).replay, true);
  assert.equal((await storage.appendOpportunityTimezoneRevision({ ...command, ianaTimezone: 'America/New_York' })).replay, false);
  assert.equal((await storage.appendOpportunityTimezoneRevision({ ...command, idempotencyKey: 'timezone-key-2' })).staleRevision, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_opportunity_timezone_revisions').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events').get().count, 1);
  database.prepare("UPDATE deal_hunter_opportunities SET status = 'superseded' WHERE opportunity_id = ?")
    .run('opp-timezone');
  assert.equal((await storage.appendOpportunityTimezoneRevision(command)).replay, true);
  const afterSupersession = await storage.appendOpportunityTimezoneRevision({ ...command,
    idempotencyKey: 'timezone-key-after-supersession', expectedPriorRevision: 1 });
  assert.equal(afterSupersession.applied, false);
  assert.equal(afterSupersession.staleRevision, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_opportunity_timezone_revisions').get().count, 1);
});

test('P1B enrollment transition CAS accepts legal edges and rejects stale or illegal edges', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-enrollment');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-enrollment');
  const decision = await storage.recordOwnerDecision({
    opportunityId: 'opp-enrollment', action: 'pursue', idempotencyKey: 'enrollment-decision',
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
    actor: 'fixture-owner', policyVersion: 'owner-decision-v1', now: at,
  });
  const command = { enrollmentId: decision.enrollment.id, expectedRowVersion: 1,
    nextState: 'waiting-on-eligibility', reasonCode: 'timezone_missing', actor: 'fixture-owner', now: at };
  const moved = await storage.transitionPursuitEnrollment(command);
  assert.equal(moved.applied, true);
  assert.equal(moved.enrollment.row_version, 2);
  assert.equal((await storage.transitionPursuitEnrollment(command)).applied, false);
  assert.equal((await storage.transitionPursuitEnrollment({ ...command, expectedRowVersion: 2,
    nextState: 'queued' })).applied, true);
  assert.equal((await storage.transitionPursuitEnrollment({ ...command, expectedRowVersion: 3,
    nextState: 'campaign-created' })).applied, true);
  assert.equal((await storage.transitionPursuitEnrollment({ ...command, expectedRowVersion: 4,
    nextState: 'queued' })).conflict, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events').get().count, 4);
});

test('P1B campaign allocation is atomic and admits one active generation', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-campaign');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-campaign');
  seedTriageScore(database, 'opp-campaign');
  const decision = await storage.recordOwnerDecision({
    opportunityId: 'opp-campaign', action: 'pursue', idempotencyKey: 'campaign-decision',
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
    actor: 'fixture-owner', policyVersion: 'owner-decision-v1', now: at,
  });
  await storage.appendOpportunityTimezoneRevision({
    opportunityId: 'opp-campaign', expectedPriorRevision: 0, idempotencyKey: 'campaign-timezone',
    state: 'verified', ianaTimezone: 'America/Los_Angeles', evidenceType: 'operator-verified',
    evidenceId: 'campaign-evidence', evidenceDigest: digest('a'), resolverVersion: 'explicit-v1',
    datasetDigest: digest('b'), actor: 'fixture-owner', now: at,
  });
  const command = {
    opportunityId: 'opp-campaign', enrollmentId: decision.enrollment.id,
    expectedEnrollmentRowVersion: 1, generation: 1,
    policyVersion: 'campaign-v1', templateVersion: 'template-v1', templateDigest: digest('c'),
    permissionVersion: 'campaign-enrollment-activation', permissionDigest: digest('d'),
    permissionRevision: 1, permissionScope: digest('e'), policyHash: digest('a'), canonicalRevision: 1,
    crmOwnershipRevision: 0, recipientAuthorityId: 'recipient-1',
    campaignAuthorityRevision: 1,
    globalAuthorityRevision: 1,
    recipientFingerprint: digest('e'), recipientAddress: 'broker@example.test',
    senderPolicyVersion: 'sender-v1', replyPolicyVersion: 'reply-v1',
    replyAliasTokenDigest: digest('f'), rfcThreadKey: 'thread-1',
    batchingPolicyVersion: 'batching-off-v1', freshnessAuthorityDigest: digest('1'),
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0, timezoneRevision: 1,
    cadencePolicyVersion: 'cadence-v1', dueAt: at, dueLocal: '2026-09-25T12:00:00-07:00',
    actor: 'fixture-owner', now: at,
  };
  assert.equal((await storage.materializePursuitCampaign(command)).actionRequired, true);
  const activation = { mode: 'active', policyHash: digest('a'), configHash: digest('b'),
    actor: 'fixture-owner', reason: 'synthetic verification', confirmation: 'fixture-confirmation',
    providerProfile: 'synthetic-provider', now: at };
  await storage.recordCimCapabilityActivation({ ...activation,
    id: 'campaign-safety-activation', capability: 'fl04a-safety' });
  await storage.recordCimCapabilityActivation({ ...activation,
    id: 'campaign-enrollment-activation', capability: 'fl04b-enrollment',
    cohortDigest: digest('e'), permissionBasisDigest: digest('d'), permissionRevision: 1,
    prerequisiteActivationId: 'campaign-safety-activation', prerequisiteEvidenceId: 'synthetic-evidence',
    prerequisiteEvidenceHash: digest('c') });
  assert.equal((await storage.materializePursuitCampaign(command)).actionRequired, true);
  seedCrmOwner(database, 'opp-campaign', 'submission-campaign');
  const ownershipRevision = database.prepare(`SELECT revision
    FROM deal_hunter_crm_ownership_revisions WHERE opportunity_id = 'opp-campaign'
    ORDER BY revision DESC LIMIT 1`).get().revision;
  const ownedCommand = { ...command, crmSubmissionId: 'submission-campaign',
    crmBrokerEmail: null,
    crmMatchAuthorityFingerprint: (await storage.readPursuitCrmMatchAuthorityFingerprint()),
    crmOwnershipRevision: ownershipRevision,
    campaignAuthorityRevision: database.prepare(`SELECT campaign_authority_revision AS revision
      FROM deal_hunter_opportunities WHERE opportunity_id = 'opp-campaign'`).get().revision };
  assert.equal((await storage.materializePursuitCampaign({ ...ownedCommand,
    permissionDigest: digest('b') })).actionRequired, true);
  assert.equal((await storage.materializePursuitCampaign({ ...ownedCommand,
    crmOwnershipRevision: ownershipRevision - 1 })).actionRequired, true);
  database.prepare(`INSERT INTO deal_hunter_opportunity_source_observations
    (id, opportunity_id, source_id, source_name, source_record_id, field, value,
     observed_at, created_at, updated_at)
    VALUES ('source-drift', 'opp-campaign', 'sheet-0', 'Synthetic', 'row-1',
      'broker_email', 'changed@example.test', ?, ?, ?)`)
    .run(at, at, at);
  assert.equal((await storage.materializePursuitCampaign(ownedCommand)).actionRequired, true,
    'a recipient provenance write after the service snapshot must reject allocation');
  database.prepare(`INSERT INTO deal_hunter_source_freshness_state
    (source_id, projection_state) VALUES ('sheet-drift', 'pending')`).run();
  assert.equal((await storage.materializePursuitCampaign({ ...ownedCommand,
    campaignAuthorityRevision: database.prepare(`SELECT campaign_authority_revision AS revision
      FROM deal_hunter_opportunities WHERE opportunity_id = 'opp-campaign'`).get().revision
  })).actionRequired, true, 'a source-state write after the snapshot must reject allocation');
  database.prepare(`UPDATE deal_hunter_source_freshness_state SET projection_state = 'accepted'
    WHERE source_id = 'sheet-drift'`).run();
  const currentCommand = { ...ownedCommand,
    campaignAuthorityRevision: database.prepare(`SELECT campaign_authority_revision AS revision
      FROM deal_hunter_opportunities WHERE opportunity_id = 'opp-campaign'`).get().revision,
    globalAuthorityRevision: database.prepare(`SELECT revision FROM deal_hunter_cim_global_authority
      WHERE id = 'global'`).get().revision };
  database.prepare(`INSERT INTO deal_hunter_opportunity_facts
    (id, opportunity_id, field, value, source, verified, actor, created_at, updated_at)
    VALUES ('fact-drift', 'opp-campaign', 'broker_email', 'fact@example.test',
      'operator', 1, 'fixture-owner', ?, ?)`).run(at, at);
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).actionRequired, true,
    'verified contact provenance must invalidate the earlier allocation snapshot');
  database.prepare(`DELETE FROM deal_hunter_opportunity_facts WHERE id = 'fact-drift'`).run();
  currentCommand.campaignAuthorityRevision = database.prepare(`SELECT campaign_authority_revision AS revision
    FROM deal_hunter_opportunities WHERE opportunity_id = 'opp-campaign'`).get().revision;
  database.prepare(`UPDATE contact_submissions SET broker_email = 'changed@example.test'
    WHERE id = 'submission-campaign'`).run();
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).actionRequired, true,
    'linked CRM recipient changes must invalidate the allocation snapshot');
  currentCommand.crmBrokerEmail = 'changed@example.test';
  currentCommand.crmMatchAuthorityFingerprint = await storage.readPursuitCrmMatchAuthorityFingerprint();
  currentCommand.campaignAuthorityRevision = database.prepare(`SELECT campaign_authority_revision AS revision
    FROM deal_hunter_opportunities WHERE opportunity_id = 'opp-campaign'`).get().revision;
  database.prepare(`INSERT INTO email_suppressions
    (id, normalized_email, reason, source, created_at, created_by)
    VALUES ('suppression-drift', 'broker@example.test', 'admin-block',
      'fixture', ?, 'fixture-owner')`).run(at);
  assert.ok(database.prepare(`SELECT revision FROM deal_hunter_cim_global_authority
    WHERE id = 'global'`).get().revision > currentCommand.globalAuthorityRevision,
  'a suppression write must invalidate an already-read campaign authority');
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).actionRequired, true);
  database.prepare(`DELETE FROM email_suppressions WHERE id = 'suppression-drift'`).run();
  currentCommand.globalAuthorityRevision = database.prepare(`SELECT revision
    FROM deal_hunter_cim_global_authority WHERE id = 'global'`).get().revision;
  database.prepare(`INSERT INTO deal_hunter_cim_requests
    (id, created_at, updated_at, deal_key, recipient_email, status,
     request_state, delivery_state, metadata, opportunity_id)
    VALUES ('uncertain-request', ?, ?, 'deal:opp-campaign', 'broker@example.test',
      'ambiguous', 'provider_unknown', 'unknown', '{}', 'opp-campaign')`).run(at, at);
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).actionRequired, true,
    'new ambiguous provider authority must block ordinary allocation');
  database.prepare(`DELETE FROM deal_hunter_cim_requests WHERE id = 'uncertain-request'`).run();
  currentCommand.globalAuthorityRevision = database.prepare(`SELECT revision
    FROM deal_hunter_cim_global_authority WHERE id = 'global'`).get().revision;
  const staleOwnershipRevision = currentCommand.crmOwnershipRevision;
  database.prepare(`UPDATE deal_hunter_opportunities SET primary_submission_id = NULL
    WHERE opportunity_id = 'opp-campaign'`).run();
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).actionRequired, true,
    'a changed canonical primary must reject the stale ownership revision');
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns`).get().count, 0);
  database.prepare(`UPDATE deal_hunter_opportunities SET primary_submission_id = 'submission-campaign'
    WHERE opportunity_id = 'opp-campaign'`).run();
  currentCommand.crmOwnershipRevision = database.prepare(`SELECT revision
    FROM deal_hunter_crm_ownership_revisions WHERE opportunity_id = 'opp-campaign'
    ORDER BY revision DESC LIMIT 1`).get().revision;
  currentCommand.campaignAuthorityRevision = database.prepare(`SELECT campaign_authority_revision
    FROM deal_hunter_opportunities WHERE opportunity_id = 'opp-campaign'`).get().campaign_authority_revision;
  assert.ok(currentCommand.crmOwnershipRevision > staleOwnershipRevision);
  database.prepare(`INSERT INTO contact_submissions
    (id, created_at, updated_at, status, delivery_provider, delivery_status,
     crm_status, source, ip_hash, name, email, message)
    VALUES ('new-crm-candidate', ?, ?, 'open', 'none', 'not-attempted',
      'active', 'synthetic', 'synthetic-ip', 'Other CRM candidate',
      'other@example.test', 'Authority race')`).run(at, at);
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).actionRequired, true,
    'a new CRM candidate after the match snapshot must reject allocation');
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns`).get().count, 0);
  database.prepare(`DELETE FROM contact_submissions WHERE id = 'new-crm-candidate'`).run();
  currentCommand.crmMatchAuthorityFingerprint = await storage.readPursuitCrmMatchAuthorityFingerprint();
  database.prepare(`UPDATE deal_hunter_opportunity_scores SET operator_priority = 'normal'
    WHERE opportunity_id = 'opp-campaign'`).run();
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).actionRequired, true,
    'an owner score changed after the final Broker Materials read must reject allocation');
  database.prepare(`UPDATE deal_hunter_opportunity_scores SET operator_priority = 'high'
    WHERE opportunity_id = 'opp-campaign'`).run();
  for (const [name, table, condition] of [
    ['conversation', 'deal_hunter_broker_conversations', '1 = 1'],
    ['campaign', 'deal_hunter_cim_campaigns', '1 = 1'],
    ['touch', 'deal_hunter_cim_campaign_touches', '1 = 1'],
    ['audit', 'deal_hunter_cim_audit_events', "NEW.event_type = 'touch-created'"],
  ]) {
    database.exec(`CREATE TRIGGER p4b_abort_${name} BEFORE INSERT ON ${table}
      WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'injected ${name} failure'); END;`);
    await assert.rejects(storage.materializePursuitCampaign(currentCommand), /injected/);
    for (const affected of ['deal_hunter_broker_conversations', 'deal_hunter_cim_campaigns',
      'deal_hunter_cim_campaign_touches']) assert.equal(database.prepare(`SELECT COUNT(*) AS count
        FROM ${affected}`).get().count, 0, `${name} rollback left ${affected}`);
    assert.equal(database.prepare(`SELECT state FROM deal_hunter_pursuit_enrollments WHERE id = ?`)
      .get(decision.enrollment.id).state, 'queued');
    database.exec(`DROP TRIGGER p4b_abort_${name}`);
  }
  const concurrent = await Promise.all([
    transitionFromWorker(sqlitePath, 'campaign-allocation', currentCommand),
    transitionFromWorker(sqlitePath, 'campaign-allocation', currentCommand),
  ]);
  assert.deepEqual(concurrent.map((result) => result.applied).sort(), [false, true]);
  assert.equal(concurrent.filter((result) => result.existing).length, 1);
  const first = await storage.materializePursuitCampaign(currentCommand);
  assert.equal(first.existing, true);
  assert.equal(first.campaign.state, 'initial-pending');
  assert.equal(first.initialTouch.state, 'scheduled');
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).existing, true);
  assert.equal((await storage.materializePursuitCampaign({ ...currentCommand, generation: 2 })).actionRequired, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 1);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_pursuit_enrollments WHERE id = ?').get(decision.enrollment.id).state,
    'campaign-created');
  database.prepare(`INSERT INTO email_suppressions
    (id, normalized_email, reason, source, created_at, created_by)
    VALUES ('replay-suppression', 'broker@example.test', 'admin-block',
      'fixture', ?, 'fixture-owner')`).run(at);
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).actionRequired, true,
    'an existing campaign replay must revalidate non-CRM suppression authority');
  database.prepare(`DELETE FROM email_suppressions WHERE id = 'replay-suppression'`).run();
  currentCommand.globalAuthorityRevision = database.prepare(`SELECT revision
    FROM deal_hunter_cim_global_authority WHERE id = 'global'`).get().revision;
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).existing, true);
  database.prepare(`UPDATE contact_submissions SET status = 'archived'
    WHERE id = 'submission-campaign'`).run();
  assert.equal((await storage.materializePursuitCampaign(currentCommand)).actionRequired, true,
    'an existing campaign replay cannot claim current CRM authority after archival');
});

test('P4B a new Pursue choice supersedes action-required enrollment with immutable selected digest', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-recipient-retry');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-recipient-retry');
  seedTriageScore(database, 'opp-recipient-retry');
  const first = await storage.recordOwnerDecision({ opportunityId: 'opp-recipient-retry',
    action: 'pursue', idempotencyKey: 'recipient-retry-first', actor: 'fixture-owner',
    policyVersion: 'owner-v1', now: at, expectedDiscoveryRevision: 0,
    expectedMaterialRevision: 0 });
  const stopped = await storage.transitionPursuitEnrollment({ enrollmentId: first.enrollment.id,
    expectedRowVersion: first.enrollment.row_version, nextState: 'action-required',
    reasonCode: 'recipient_ambiguous', actor: 'fixture-owner', now: at });
  assert.equal(stopped.applied, true);
  const retry = await storage.recordOwnerDecision({ opportunityId: 'opp-recipient-retry',
    action: 'pursue', idempotencyKey: 'recipient-retry-choice', actor: 'fixture-owner',
    policyVersion: 'owner-v1', now: at, expectedDiscoveryRevision: 0,
    expectedMaterialRevision: 0, selectedContactReferenceDigest: digest('a') });
  assert.equal(retry.applied, true);
  assert.notEqual(retry.decision.id, first.decision.id);
  assert.equal(retry.decision.selected_contact_reference_digest, digest('a'));
  assert.equal(retry.enrollment.state, 'queued');
  assert.equal(database.prepare(`SELECT state FROM deal_hunter_pursuit_enrollments WHERE id = ?`)
    .get(first.enrollment.id).state, 'superseded');
});

test('P4B a queued Pursue choice creates a new bound decision before orchestration', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-queued-choice');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-queued-choice');
  seedTriageScore(database, 'opp-queued-choice');
  const first = await storage.recordOwnerDecision({ opportunityId: 'opp-queued-choice',
    action: 'pursue', idempotencyKey: 'queued-choice-first', actor: 'fixture-owner',
    policyVersion: 'owner-v1', now: at, expectedDiscoveryRevision: 0,
    expectedMaterialRevision: 0 });
  const chosen = await storage.recordOwnerDecision({ opportunityId: 'opp-queued-choice',
    action: 'pursue', idempotencyKey: 'queued-choice-selected', actor: 'fixture-owner',
    policyVersion: 'owner-v1', now: at, expectedDiscoveryRevision: 0,
    expectedMaterialRevision: 0, selectedContactReferenceDigest: digest('a') });
  assert.equal(chosen.applied, true);
  assert.equal(chosen.decision.selected_contact_reference_digest, digest('a'));
  assert.equal(chosen.enrollment.state, 'queued');
  assert.equal(database.prepare(`SELECT state FROM deal_hunter_pursuit_enrollments
    WHERE id = ?`).get(first.enrollment.id).state, 'superseded');
});

test('P4B CRM ownership revisions track only canonical primary selection', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-crm-ownership');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-crm-ownership');
  const readHistory = () => database.prepare(`SELECT revision, submission_id
    FROM deal_hunter_crm_ownership_revisions WHERE opportunity_id = 'opp-crm-ownership'
    ORDER BY revision`).all();
  assert.deepEqual(readHistory(), [{ revision: 1, submission_id: null }]);
  seedCrmOwner(database, 'opp-crm-ownership', 'submission-ownership');
  assert.deepEqual(readHistory(), [{ revision: 1, submission_id: null },
    { revision: 2, submission_id: 'submission-ownership' }]);
  database.prepare(`UPDATE contact_submissions SET deal_hunter_opportunity_id = NULL
    WHERE id = 'submission-ownership'`).run();
  assert.equal(readHistory().length, 2, 'backlink drift does not select a new primary');
  database.prepare(`UPDATE contact_submissions SET deal_hunter_opportunity_id = 'opp-crm-ownership',
    metadata = '{"dealHunter":{"opportunityId":"wrong-opportunity"}}'
    WHERE id = 'submission-ownership'`).run();
  assert.equal(readHistory().length, 2, 'metadata drift does not select a new primary');
  database.prepare(`UPDATE contact_submissions SET metadata =
    '{"dealHunter":{"opportunityId":"opp-crm-ownership"}}'
    WHERE id = 'submission-ownership'`).run();
  assert.equal(readHistory().length, 2, 'metadata correction does not select a new primary');
  database.prepare(`UPDATE contact_submissions SET status = 'archived'
    WHERE id = 'submission-ownership'`).run();
  assert.equal(readHistory().length, 2);
  database.prepare(`UPDATE deal_hunter_opportunities SET primary_submission_id = primary_submission_id
    WHERE opportunity_id = 'opp-crm-ownership'`).run();
  assert.equal(readHistory().length, 2);
  database.prepare(`UPDATE deal_hunter_opportunities SET primary_submission_id = NULL
    WHERE opportunity_id = 'opp-crm-ownership'`).run();
  assert.deepEqual(readHistory().at(-1), { revision: 3, submission_id: null });
  database.prepare(`UPDATE contact_submissions SET deal_hunter_opportunity_id = NULL
    WHERE id = 'submission-ownership'`).run();
  assert.equal(readHistory().length, 3);
  seedCrmOwner(database, 'opp-crm-ownership', 'submission-replacement');
  assert.deepEqual(readHistory().at(-1),
    { revision: 4, submission_id: 'submission-replacement' });
  database.prepare(`UPDATE deal_hunter_opportunities SET primary_submission_id = 'submission-ownership'
    WHERE opportunity_id = 'opp-crm-ownership'`).run();
  assert.deepEqual(readHistory().at(-1),
    { revision: 5, submission_id: 'submission-ownership' });
});

test('P1B capability activation requires the current prerequisite chain and audits once', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-activation');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const base = { mode: 'shadow', policyHash: digest('a'), configHash: digest('b'),
    actor: 'fixture-owner', reason: 'synthetic verification', confirmation: 'fixture-confirmation',
    providerProfile: 'synthetic-provider', now: at };
  const child = { ...base, id: 'activation-enrollment', capability: 'fl04b-enrollment',
    prerequisiteActivationId: 'activation-safety', prerequisiteEvidenceId: 'synthetic-evidence',
    prerequisiteEvidenceHash: digest('c') };
  assert.equal((await storage.recordCimCapabilityActivation(child)).blockedReason, 'prerequisite_missing');
  const root = await storage.recordCimCapabilityActivation({ ...base,
    id: 'activation-safety', capability: 'fl04a-safety' });
  assert.equal(root.applied, true);
  assert.equal((await storage.recordCimCapabilityActivation(child)).applied, true);
  assert.equal((await storage.recordCimCapabilityActivation(child)).replay, true);
  assert.equal((await storage.recordCimCapabilityActivation({ ...child, policyHash: digest('d') })).conflict, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_capability_activations').get().count, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events').get().count, 2);
});

test('P1B due touch claim has one winner and rejects stale terminal authority', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-claim');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-claim');
  await seedSyntheticActivationChain(storage);
  const command = { touchId: authority.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest: digest('a'), claimOwner: 'worker-1',
    claimExpiresAt: '2026-09-25T19:10:00.000Z', now: at };
  const first = await storage.claimDueCimTouch(command);
  assert.equal(first.claimed, true);
  assert.equal(first.touch.state, 'claimed');
  assert.equal((await storage.claimDueCimTouch(command)).alreadyOwned, true);
  assert.equal((await storage.claimDueCimTouch({ ...command, claimTokenDigest: digest('b'),
    claimOwner: 'worker-2' })).conflict, true);
  database.prepare('UPDATE deal_hunter_cim_campaigns SET terminal_revision = 1 WHERE id = ?')
    .run(authority.campaignId);
  assert.equal((await storage.claimDueCimTouch({ ...command, expectedRowVersion: 2,
    now: '2026-09-25T19:11:00.000Z' })).staleAuthority, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'touch-claimed'").get().count, 1);
});

test('P5 due selector returns only bounded current generation-one initial touches', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p5-due');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const first = insertBaseAuthority(database, '-p5-due-a');
  const second = insertBaseAuthority(database, '-p5-due-b');
  const future = insertBaseAuthority(database, '-p5-due-future');
  database.prepare('UPDATE deal_hunter_cim_campaign_touches SET due_at = ? WHERE id = ?')
    .run('2026-09-25T20:00:00.000Z', future.touchId);
  assert.deepEqual(await storage.listDueCimInitialTouches({ now: at, limit: 1 }), []);
  await seedSyntheticActivationChain(storage);
  const due = await storage.listDueCimInitialTouches({ now: at, limit: 1 });
  assert.deepEqual(due.map((row) => row.touch_id), [first.touchId]);
  assert.equal(due[0].campaign_id, first.campaignId);
  assert.equal(due[0].kind, 'initial');
  assert.equal(due[0].row_version, 1);
  assert.deepEqual((await storage.listDueCimInitialTouches({ now: at, limit: 10 }))
    .map((row) => row.touch_id), [first.touchId, second.touchId]);
  assert.deepEqual((await storage.listDueCimInitialTouches({
    now: '2026-09-25T12:00:00-07:00', limit: 10,
  })).map((row) => row.touch_id), [first.touchId, second.touchId]);
  database.prepare("UPDATE deal_hunter_cim_campaign_touches SET kind = 'follow-up-1' WHERE id = ?")
    .run(second.touchId);
  assert.deepEqual((await storage.listDueCimInitialTouches({ now: at, limit: 10 }))
    .map((row) => row.touch_id), [first.touchId]);
  assert.equal((await storage.claimDueCimTouch({ touchId: first.touchId,
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: digest('a'),
    claimOwner: 'selector-worker', claimExpiresAt: '2026-09-25T19:01:00.000Z',
    now: at })).claimed, true);
  assert.deepEqual((await storage.listDueCimInitialTouches({
    now: '2026-09-25T19:02:00.000Z', limit: 10,
  })).map((row) => row.touch_id), [first.touchId]);
  await storage.withdrawCimCapabilityActivation({ id: 'synthetic-fl04b-enrollment',
    actor: 'fixture-owner', reason: 'synthetic prerequisite withdrawal', now: at });
  assert.deepEqual(await storage.listDueCimInitialTouches({
    now: '2026-09-25T19:02:00.000Z', limit: 10,
  }), []);
});

test('P5 expired claim reclaims the same touch and excludes the prior owner from preparation', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p5-reclaim');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-p5-reclaim');
  seedCrmOwner(database, authority.opportunityId, 'submission-p5-reclaim');
  await seedSyntheticActivationChain(storage);
  const claim = { touchId: authority.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest: digest('a'), claimOwner: 'worker-a',
    claimExpiresAt: '2026-09-25T19:01:00.000Z', now: at };
  assert.equal((await storage.claimDueCimTouch(claim)).claimed, true);
  const later = '2026-09-25T19:02:00.000Z';
  const reclaimed = await storage.claimDueCimTouch({ ...claim, expectedRowVersion: 2,
    claimTokenDigest: digest('b'), claimOwner: 'worker-b',
    claimExpiresAt: '2026-09-25T19:07:00.000Z', now: later });
  assert.equal(reclaimed.claimed, true);
  assert.equal(reclaimed.touch.id, authority.touchId);
  const prepare = { touchIds: [authority.touchId], claimTokenDigest: digest('a'),
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    preparationGeneration: 1, payloadVersion: 'deal-hunter-cim-manual-stage1-v1',
    fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
    ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
    subject: 'Synthetic subject', bodyText: 'Synthetic body',
    bodyHtmlSanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
    actor: 'fixture-owner', now: later };
  assert.equal((await storage.prepareCimTransmission(prepare)).terminal, true);
  const winner = await storage.prepareCimTransmission({ ...prepare, claimTokenDigest: digest('b') });
  assert.equal(winner.prepared, true);
  assert.equal((await storage.claimDueCimTouch({ ...claim, expectedRowVersion: 4,
    claimTokenDigest: digest('b'), claimOwner: 'worker-b',
    now: '2026-09-25T19:03:00.000Z' })).conflict, true);
  assert.equal((await storage.claimDueCimTouch({ ...claim, expectedRowVersion: 4,
    now: '2026-09-25T19:08:00.000Z' })).conflict, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_transmissions').get().count, 1);
});

test('P5 expired claim token cannot prepare before a replacement owner arrives', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p5-expired-prepare');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-p5-expired-prepare');
  seedCrmOwner(database, authority.opportunityId, 'submission-p5-expired-prepare');
  await seedSyntheticActivationChain(storage);
  const claimTokenDigest = digest('a');
  assert.equal((await storage.claimDueCimTouch({ touchId: authority.touchId,
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest,
    claimOwner: 'worker-a', claimExpiresAt: '2026-09-25T19:01:00.000Z',
    now: at })).claimed, true);
  const result = await storage.prepareCimTransmission({
    touchIds: [authority.touchId], claimTokenDigest,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    preparationGeneration: 1, payloadVersion: 'payload-v1',
    fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
    ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
    subject: 'Synthetic subject', bodyText: 'Synthetic body',
    bodyHtmlSanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
    actor: 'fixture-owner', now: '2026-09-25T19:02:00.000Z',
  });
  assert.equal(result.terminal, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 0);
});

test('P5 rejects a touch whose opportunity differs from its campaign', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p5-member-owner');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-p5-member-owner-a');
  const other = insertBaseAuthority(database, '-p5-member-owner-b');
  seedCrmOwner(database, authority.opportunityId, 'submission-p5-member-owner');
  await seedSyntheticActivationChain(storage);
  const claimTokenDigest = digest('a');
  assert.equal((await storage.claimDueCimTouch({ touchId: authority.touchId,
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest,
    claimOwner: 'worker-a', claimExpiresAt: '2026-09-25T19:05:00.000Z',
    now: at })).claimed, true);
  database.prepare('UPDATE deal_hunter_cim_campaign_touches SET opportunity_id = ? WHERE id = ?')
    .run(other.opportunityId, authority.touchId);
  const result = await storage.prepareCimTransmission({
    touchIds: [authority.touchId], claimTokenDigest,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    preparationGeneration: 1, payloadVersion: 'payload-v1',
    fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
    ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
    subject: 'Synthetic subject', bodyText: 'Synthetic body',
    bodyHtmlSanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
    actor: 'fixture-owner', now: at,
  });
  assert.equal(result.terminal, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 0);
});

test('P5 runner prepares one initial touch from server authority without provider work', async (t) => {
  const { runDueCimInitialPreparations } = await import('../server/services/pursueCimInitialPreparation.js');
  const sqlitePath = temporaryPath(t, 'pursue-cim-p5-runner');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const opportunityId = 'opp-p1a-p5-runner';
  const recipient = { email: 'broker@example.test', displayName: 'Broker',
    firstName: 'Avery', provenance: 'operator_verified',
    provenanceFingerprint: digest('d'), contactAuthorityRevision: digest('c') };
  const fingerprint = sha256(stableCanonicalJson({ opportunityId,
    emailHash: sha256(recipient.email),
    provenanceFingerprint: recipient.provenanceFingerprint,
    contactAuthorityRevision: recipient.contactAuthorityRevision }));
  const authority = insertBaseAuthority(database, '-p5-runner', fingerprint);
  seedCrmOwner(database, authority.opportunityId, 'submission-p5-runner');
  await seedSyntheticActivationChain(storage);
  const before = await storage.readCimOutreachCounters();
  const fakeProvider = createPursueCimProviderFake();
  const result = await runDueCimInitialPreparations({ storage, now: at, limit: 5,
    loadAuthority: async ({ opportunityId }) => ({
      opportunityId, opportunity: { canonical_name: 'Synthetic Service Co',
        canonical_location: 'California' },
      score: { deal_key: 'synthetic-service', fit_score: 85 },
      sourceRows: [], preparationBlockers: [],
      submission: { id: 'submission-p5-runner' },
      recipientOptions: [recipient],
    }) });
  assert.equal(result.length, 1);
  assert.equal(result[0].prepared, true);
  const after = await storage.readCimOutreachCounters();
  assert.deepEqual(Object.fromEntries(['campaigns', 'touches', 'transmissions',
    'memberships', 'crmOutbound', 'outbox', 'providerAuthorizations', 'providerPending',
    'providerSeamEntries'].map((key) => [key, after[key] - before[key]])), {
    campaigns: 0, touches: 0, transmissions: 1, memberships: 1,
    crmOutbound: 1, outbox: 1, providerAuthorizations: 0,
    providerPending: 0, providerSeamEntries: 0,
  });
  assert.equal(fakeProvider.seamEntries.length, 0);
  assert.equal(fakeProvider.providerCalls.length, 0);
  const transmission = database.prepare('SELECT * FROM deal_hunter_cim_transmissions').get();
  assert.equal(transmission.state, 'prepared');
  assert.equal(transmission.invocation_authority_count, 0);
  assert.equal(database.prepare('SELECT display_ordinal FROM deal_hunter_cim_transmission_touches')
    .get().display_ordinal, 1);
});

test('P5 two SQLite processes claim one due touch and prepare one immutable transmission', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p5-race');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-p5-race');
  seedCrmOwner(database, authority.opportunityId, 'submission-p5-race');
  await seedSyntheticActivationChain(storage);
  const base = { touchId: authority.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimExpiresAt: '2026-09-25T19:05:00.000Z', now: at };
  const contenders = [digest('a'), digest('b')].map((claimTokenDigest, index) => ({
    ...base, claimTokenDigest, claimOwner: `worker-${index}`,
  }));
  const outcomes = await Promise.all(contenders.map((payload) =>
    transitionFromWorker(sqlitePath, 'pre-provider-transition', {
      method: 'claimDueCimTouch', payload,
    })));
  assert.deepEqual(outcomes.map((row) => row.claimed).sort(), [false, true]);
  assert.equal(outcomes.filter((row) => row.staleAuthority || row.conflict).length, 1);
  const winner = contenders[outcomes.findIndex((row) => row.claimed)];
  const preparePayload = {
      touchIds: [authority.touchId], claimTokenDigest: winner.claimTokenDigest,
      expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
      preparationGeneration: 1, payloadVersion: 'payload-v1',
      fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
      ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
      subject: 'Synthetic subject', bodyText: 'Synthetic body',
      bodyHtmlSanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
      actor: 'fixture-owner', now: at,
  };
  const preparations = await Promise.all([0, 1].map(() =>
    transitionFromWorker(sqlitePath, 'pre-provider-transition', {
      method: 'prepareCimTransmission', payload: preparePayload,
    })));
  assert.deepEqual(preparations.map((row) => row.prepared).sort(), [false, true]);
  assert.equal(preparations.filter((row) => row.existing).length, 1);
  const counters = await storage.readCimOutreachCounters();
  assert.equal(counters.campaigns, 1);
  assert.equal(counters.touches, 1);
  assert.equal(counters.transmissions, 1);
  assert.equal(counters.memberships, 1);
  assert.equal(counters.crmOutbound, 1);
  assert.equal(counters.outbox, 1);
  assert.equal(counters.providerAuthorizations, 0);
  assert.equal(counters.providerSeamEntries, 0);
});

test('P5 scenario 47 legacy request claim cannot authorize initial preparation', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p5-legacy-claim');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-p5-legacy-claim');
  seedCrmOwner(database, authority.opportunityId, 'submission-p5-legacy-claim');
  await seedSyntheticActivationChain(storage);
  database.prepare(`INSERT INTO deal_hunter_cim_requests
    (id, created_at, updated_at, deal_key, recipient_email, status,
      request_state, delivery_state, metadata, opportunity_id)
    VALUES (?, ?, ?, 'synthetic-legacy', 'broker@example.test', 'pending',
      'claimed', 'not-attempted', ?, ?)`)
    .run('legacy-claim-p5', at, at,
      JSON.stringify({ claimTokenDigest: digest('a'), claimOwner: 'legacy-worker' }),
      authority.opportunityId);
  const result = await storage.prepareCimTransmission({
    touchIds: [authority.touchId], claimTokenDigest: digest('a'),
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    preparationGeneration: 1, payloadVersion: 'payload-v1',
    fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
    ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
    subject: 'Synthetic subject', bodyText: 'Synthetic body',
    bodyHtmlSanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
    actor: 'fixture-owner', now: at,
  });
  assert.equal(result.terminal, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 0);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'scheduled');
});

test('P1B terminal event increments authority and cancels pre-provider touch atomically', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-terminal');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-terminal');
  const command = { eventId: 'terminal-event-1', scope: 'campaign', scopeId: authority.campaignId,
    expectedRevision: 0, expectedRowVersion: 1, nextState: 'stopped',
    reasonCode: 'owner_stop', evidenceType: 'owner-action', evidenceId: 'owner-action-1',
    metadataDigest: digest('a'), actor: 'fixture-owner', source: 'synthetic-test',
    observedAt: at, now: at };
  const first = await storage.appendCimTerminalEvent(command);
  assert.equal(first.applied, true);
  assert.equal(first.campaignRevision, 1);
  assert.deepEqual(first.cancelledTouchIds, [authority.touchId]);
  assert.equal((await storage.appendCimTerminalEvent(command)).replay, true);
  assert.equal((await storage.appendCimTerminalEvent({ ...command, eventId: 'terminal-event-2' })).conflict, true);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?').get(authority.touchId).state,
    'cancelled-before-provider');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_terminal_events').get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'terminal-transition'").get().count, 1);
});

test('P7B SQLite domain writers converge through terminal authority with retained evidence', async (t) => {
  const cases = [
    ['archive', 'crm_archived', 'crm-archive', async ({ storage, authority }) => {
      await storage.mutateWithCrmActivity({
        operation: 'archive_submission',
        payload: { id: `submission-${authority.campaignId}`, expectedUpdatedAt: at,
          values: { updated_at: at, archived_at: at, archived_by: 'fixture-owner',
            archive_reason: 'not-a-fit' } },
        activity: { id: `activity-${authority.campaignId}`,
          submission_id: `submission-${authority.campaignId}`, created_at: at,
          actor: 'fixture-owner', role: 'admin', event_type: 'submission.archived',
          summary: 'Synthetic archive.', metadata: {} },
      });
    }],
    ['advanced diligence', 'advanced_beyond_broker_outreach', 'diligence',
      async ({ storage, authority }) => {
        await storage.mutateWithCrmActivity({
          operation: 'update_submission',
          payload: { id: `submission-${authority.campaignId}`, expectedUpdatedAt: at,
            values: { updated_at: '2026-09-25T19:00:01.000Z',
              metadata: { diligence: { stage: 'loi-candidate', decision: 'advance' } } } },
          activity: { id: `activity-${authority.campaignId}`,
            submission_id: `submission-${authority.campaignId}`, created_at: at,
            actor: 'fixture-owner', role: 'admin', event_type: 'diligence.updated',
            summary: 'Synthetic diligence.', metadata: {} },
        });
      }],
    ['materials', 'materials_received', 'materials', async ({ storage, database, authority }) => {
      database.prepare(`INSERT INTO secure_upload_requests (
        id, submission_id, created_at, updated_at, email, status, expires_at,
        requested_documents
      ) VALUES (?, ?, ?, ?, 'broker@example.test', 'open', ?, '[]')`)
        .run(`request-${authority.campaignId}`, `submission-${authority.campaignId}`,
          at, at, '2026-09-26T19:00:00.000Z');
      await storage.insertSecureDocument({ id: `unrelated-document-${authority.campaignId}`,
        request_id: `request-${authority.campaignId}`,
        submission_id: `submission-${authority.campaignId}`, created_at: at,
        document_type: 'nda', file_name: 'nda.pdf', original_name: 'Signed NDA.pdf',
        mime_type: 'application/pdf', size_bytes: 100, storage_path: '/synthetic/nda.pdf',
        uploaded_by_email: null, note: null, nda_accepted_at: null });
      assert.deepEqual(database.prepare(`SELECT state, terminal_revision AS revision
        FROM deal_hunter_cim_campaigns WHERE id = ?`).get(authority.campaignId),
      { state: 'initial-pending', revision: 0 },
      'an unrelated document must not become materials authority');
      await storage.insertSecureDocument({ id: `document-${authority.campaignId}`,
        request_id: `request-${authority.campaignId}`,
        submission_id: `submission-${authority.campaignId}`, created_at: at,
        document_type: 'cim', file_name: 'cim.pdf', original_name: 'CIM.pdf',
        mime_type: 'application/pdf', size_bytes: 100, storage_path: '/synthetic/cim.pdf',
        uploaded_by_email: null, note: null, nda_accepted_at: null });
    }],
    ['suppression', 'recipient_suppressed', 'email-suppression', async ({ storage, authority }) => {
      await storage.upsertEmailSuppression({ id: `suppression-${authority.campaignId}`,
        normalized_email: 'broker@example.test', reason: 'explicit-opt-out',
        source: 'synthetic-test', source_event_id: `event-${authority.campaignId}`,
        created_at: at, created_by: 'fixture-owner', metadata: {} });
    }],
    ['identity ambiguity', 'identity_ambiguous', 'identity-exception', async ({ storage, authority }) => {
      await storage.upsertDealHunterIdentityException({ id: `identity-${authority.campaignId}`,
        created_at: at, updated_at: at, status: 'open',
        candidate_opportunity_ids: [authority.opportunityId], reason: 'synthetic conflict',
        evidence_version: 'test-v1', metadata: {} });
    }],
  ];

  for (const [label, reasonCode, evidenceType, invoke] of cases) {
    await t.test(label, async (st) => {
      const sqlitePath = temporaryPath(st, `p7b-${label.replaceAll(' ', '-')}`);
      const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
      st.after(() => storage.close());
      const database = new Database(sqlitePath);
      st.after(() => database.close());
      const authority = insertBaseAuthority(database, `-p7b-${label.replaceAll(' ', '-')}`);
      seedCrmOwner(database, authority.opportunityId, `submission-${authority.campaignId}`);

      await invoke({ storage, database, authority });

      const campaign = database.prepare('SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?')
        .get(authority.campaignId);
      const event = database.prepare(`SELECT * FROM deal_hunter_cim_terminal_events
        WHERE campaign_id = ? ORDER BY revision DESC LIMIT 1`).get(authority.campaignId);
      assert.equal(campaign.terminal_revision, 1, label);
      assert.equal(campaign.state,
        ['materials_received', 'advanced_beyond_broker_outreach'].includes(reasonCode) ? 'materials-received'
          : reasonCode === 'identity_ambiguous' ? 'action-required' : 'stopped', label);
      assert.equal(campaign.reason_code, reasonCode, label);
      assert.equal(event?.evidence_type, evidenceType, label);
      assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
        .get(authority.touchId).state, 'cancelled-before-provider', label);
    });
  }
});

test('P7B SQLite terminal writer after provider-pending records the in-flight race and stops later work', async (t) => {
  const { storage, database, authority, pending } = await createProviderPendingFixture(t, 'p7b-in-flight');
  await storage.upsertEmailSuppression({ id: 'p7b-in-flight-suppression',
    normalized_email: 'broker@example.test', reason: 'hard-bounce', source: 'provider-lifecycle',
    source_event_id: 'p7b-in-flight-event', created_at: at, created_by: 'email-webhook',
    metadata: {} });

  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaigns WHERE id = ?')
    .get(authority.campaignId).state, 'stopped');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'provider-pending');
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events
    WHERE event_type = 'terminal-in-flight-race' AND transmission_id = ?`)
    .get(pending.id).count, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches
    WHERE campaign_id = ? AND ordinal > 0 AND state IN ('scheduled','claimed')`)
    .get(authority.campaignId).count, 0);
});

test('P7B direct SQLite submission and upload writers use canonical terminal authority', async (t) => {
  await t.test('atomic activity upload request category edit', async (st) => {
    const sqlitePath = temporaryPath(st, 'p7b-activity-upload');
    const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
    st.after(() => storage.close());
    const database = new Database(sqlitePath);
    st.after(() => database.close());
    const authority = insertBaseAuthority(database, '-p7b-activity-upload');
    const submissionId = `submission-${authority.campaignId}`;
    seedCrmOwner(database, authority.opportunityId, submissionId);
    await storage.mutateWithCrmActivity({
      operation: 'insert_secure_upload_request',
      payload: { request: { id: 'p7b-activity-upload-request', submission_id: submissionId,
        created_at: at, updated_at: at, email: 'broker@example.test', contact_name: null,
        requested_by: 'fixture-owner', status: 'documents-received',
        expires_at: '2026-09-26T19:00:00.000Z', nda_required: false,
        nda_accepted_at: null, last_uploaded_at: at, note: null, requested_documents: [],
        revoked_at: null, closed_at: null, upload_batch_count: 1 } },
      activity: { id: 'p7b-activity-upload-insert', submission_id: submissionId,
        created_at: at, actor: 'fixture-owner', role: 'admin',
        event_type: 'secure-upload.created', summary: 'Synthetic upload request.', metadata: {} },
    });
    assert.equal(database.prepare(`SELECT terminal_revision FROM deal_hunter_cim_campaigns
      WHERE id = ?`).get(authority.campaignId).terminal_revision, 0);
    await storage.mutateWithCrmActivity({
      operation: 'update_secure_upload_request',
      payload: { id: 'p7b-activity-upload-request', expectedStatuses: ['documents-received'],
        values: { updated_at: '2026-09-25T19:00:01.000Z', requested_documents: ['cim'] } },
      activity: { id: 'p7b-activity-upload-update', submission_id: submissionId,
        created_at: '2026-09-25T19:00:01.000Z', actor: 'fixture-owner', role: 'admin',
        event_type: 'secure-upload.updated', summary: 'Synthetic upload categories.', metadata: {} },
    });
    assert.deepEqual(database.prepare(`SELECT state, reason_code FROM deal_hunter_cim_campaigns
      WHERE id = ?`).get(authority.campaignId),
    { state: 'materials-received', reason_code: 'materials_received' });
  });

  await t.test('completed latest relevant upload', async (st) => {
    const sqlitePath = temporaryPath(st, 'p7b-direct-upload');
    const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
    st.after(() => storage.close());
    const database = new Database(sqlitePath);
    st.after(() => database.close());
    const authority = insertBaseAuthority(database, '-p7b-direct-upload');
    const submissionId = `submission-${authority.campaignId}`;
    seedCrmOwner(database, authority.opportunityId, submissionId);
    await storage.insertSecureUploadRequest({ id: 'p7b-direct-upload-request',
      submission_id: submissionId, created_at: at, updated_at: at,
      email: 'broker@example.test', contact_name: null, requested_by: 'fixture-owner',
      status: 'open', expires_at: '2026-09-26T19:00:00.000Z', nda_required: false,
      nda_accepted_at: null, last_uploaded_at: null, note: null,
      requested_documents: ['cim'], revoked_at: null, closed_at: null,
      upload_batch_count: 0 });
    assert.equal(database.prepare('SELECT terminal_revision FROM deal_hunter_cim_campaigns WHERE id = ?')
      .get(authority.campaignId).terminal_revision, 0);
    await storage.updateSecureUploadRequest('p7b-direct-upload-request', {
      updated_at: '2026-09-25T19:00:01.000Z', status: 'documents-received',
      requested_documents: ['cim'] });
    assert.deepEqual(database.prepare(`SELECT state, reason_code FROM deal_hunter_cim_campaigns
      WHERE id = ?`).get(authority.campaignId),
    { state: 'materials-received', reason_code: 'materials_received' });
  });

  await t.test('direct advanced-diligence update', async (st) => {
    const sqlitePath = temporaryPath(st, 'p7b-direct-submission');
    const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
    st.after(() => storage.close());
    const database = new Database(sqlitePath);
    st.after(() => database.close());
    const authority = insertBaseAuthority(database, '-p7b-direct-submission');
    const submissionId = `submission-${authority.campaignId}`;
    seedCrmOwner(database, authority.opportunityId, submissionId);
    await storage.updateSubmission(submissionId, { updated_at: '2026-09-25T19:00:01.000Z',
      metadata: { diligence: { stage: 'loi-candidate', decision: 'advance' } } });
    assert.deepEqual(database.prepare(`SELECT state, reason_code FROM deal_hunter_cim_campaigns
      WHERE id = ?`).get(authority.campaignId),
    { state: 'materials-received', reason_code: 'advanced_beyond_broker_outreach' });
  });
});

test('P7B repeated identity evidence increments terminal authority without leaving containment', async (t) => {
  const sqlitePath = temporaryPath(t, 'p7b-repeat-identity');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-p7b-repeat-identity');
  for (const index of [1, 2]) {
    await storage.upsertDealHunterIdentityException({ id: `p7b-identity-${index}`,
      created_at: at, updated_at: `2026-09-25T19:00:0${index}.000Z`, status: 'open',
      candidate_opportunity_ids: [authority.opportunityId], reason: `conflict-${index}`,
      evidence_version: 'test-v1', metadata: {} });
  }
  assert.deepEqual(database.prepare(`SELECT state, terminal_revision AS revision
    FROM deal_hunter_cim_campaigns WHERE id = ?`).get(authority.campaignId),
  { state: 'action-required', revision: 2 });
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_terminal_events
    WHERE campaign_id = ? AND reason_code = 'identity_ambiguous'`)
    .get(authority.campaignId).count, 2);
});

test('P7B common terminal primitive audits explicit-stop races exactly once', async (t) => {
  const { storage, database, authority, pending } = await createProviderPendingFixture(t, 'p7b-explicit-stop');
  const campaign = database.prepare('SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?')
    .get(authority.campaignId);
  const command = { eventId: 'p7b-explicit-stop-event', scope: 'campaign',
    scopeId: authority.campaignId, expectedRevision: campaign.terminal_revision,
    expectedRowVersion: campaign.row_version, nextState: 'stopped', reasonCode: 'operator-stop',
    evidenceType: 'operator-stop', evidenceId: 'p7b-stop', metadataDigest: sha256('p7b-stop'),
    actor: 'fixture-owner', source: 'operator-command', observedAt: at, now: at };
  assert.equal((await storage.appendCimTerminalEvent(command)).applied, true);
  assert.equal((await storage.appendCimTerminalEvent(command)).replay, true);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events
    WHERE event_type = 'terminal-in-flight-race' AND transmission_id = ?`)
    .get(pending.id).count, 1);
});

test('P7B unsafe delivery and post-ambiguity evidence retain terminal dominance', async (t) => {
  await t.test('unsafe communication lifecycle is atomic', async (st) => {
    const { storage, database, authority, pending } = await createProviderPendingFixture(st, 'p7b-unsafe-delivery');
    await storage.updateCrmCommunication(pending.communication_id, {
      delivery_state: 'failed', delivery_state_at: '2026-09-25T19:00:02.000Z',
      source_event_id: 'p7b-delivery-failed', updated_at: '2026-09-25T19:00:02.000Z',
      updated_by: 'email-webhook' });
    assert.deepEqual(database.prepare(`SELECT state, reason_code FROM deal_hunter_cim_campaigns
      WHERE id = ?`).get(authority.campaignId),
    { state: 'stopped', reason_code: 'unsafe_delivery' });
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_terminal_events
      WHERE campaign_id = ? AND evidence_type = 'delivery-lifecycle'`)
      .get(authority.campaignId).count, 1);
  });

  await t.test('accepted reconciliation cannot revive terminal provider ambiguity', async (st) => {
    const { storage, database, authority, pending } = await createProviderPendingFixture(st, 'p7b-ambiguous-terminal');
    const ambiguous = await storage.reconcileCimTransmission({ transmissionId: pending.id,
      payloadDigest: pending.payload_digest, expectedRowVersion: 2, outcome: 'ambiguous',
      provider: 'resend', providerResultCode: 'multiple-provider-identities',
      evidenceType: 'provider-read', evidenceId: 'p7b-provider-read-ambiguous',
      evidenceDigest: sha256('p7b-ambiguous'), observedAt: at, actor: 'fixture-owner', now: at,
      providerIdentities: [
        { provider: 'resend', providerMessageId: 'p7b-provider-a', evidenceId: 'candidate-a',
          evidenceDigest: sha256('p7b-candidate-a') },
        { provider: 'resend', providerMessageId: 'p7b-provider-b', evidenceId: 'candidate-b',
          evidenceDigest: sha256('p7b-candidate-b') },
      ] });
    assert.equal(ambiguous.applied, true);
    await storage.upsertEmailSuppression({ id: 'p7b-ambiguous-suppression',
      normalized_email: 'broker@example.test', reason: 'hard-bounce', source: 'provider-lifecycle',
      source_event_id: 'p7b-ambiguous-suppression-event', created_at: at,
      created_by: 'email-webhook', metadata: {} });
    const accepted = await storage.reconcileCimTransmission({ transmissionId: pending.id,
      payloadDigest: pending.payload_digest, expectedRowVersion: 3, outcome: 'accepted',
      provider: 'resend', providerMessageId: 'p7b-provider-a',
      providerResultCode: 'signed-webhook-accepted', evidenceType: 'signed-webhook',
      evidenceId: 'p7b-webhook-accepted', evidenceDigest: sha256('p7b-accepted'),
      observedAt: '2026-09-25T19:00:03.000Z', actor: 'fixture-owner', now: at,
      cadence: null });
    assert.equal(accepted.applied, true);
    assert.equal(accepted.nextTouch, null);
    assert.deepEqual(database.prepare(`SELECT state, reason_code, terminal_revision AS revision
      FROM deal_hunter_cim_campaigns WHERE id = ?`).get(authority.campaignId),
    { state: 'stopped', reason_code: 'recipient_suppressed', revision: 1 });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches')
      .get().count, 1);
  });
});

test('P1B safety emission and no-op consumption are idempotent and audited', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-safety');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-safety');
  const run = { safetyRunId: 'safety-run-1', sourceType: 'synthetic-import',
    sourceRunId: 'source-run-1', now: at,
    events: [{ opportunityId: 'opp-safety', canonicalRevision: 0,
      identityExceptionRevision: 0, eventType: 'identity-change', evidenceId: 'evidence-1' }] };
  assert.equal((await storage.appendCimSafetyEvents(run)).emitted, 1);
  assert.equal((await storage.appendCimSafetyEvents(run)).emitted, 0);
  const first = await storage.consumeCimSafetyEvents({ safetyRunId: 'safety-run-1', limit: 10,
    actor: 'fixture-owner', now: at });
  assert.deepEqual(first, { stopped: 0, reviewRequired: 0, noOp: 1, pending: 0 });
  assert.deepEqual(await storage.consumeCimSafetyEvents({ safetyRunId: 'safety-run-1', limit: 10,
    actor: 'fixture-owner', now: at }), first);
  assert.equal(database.prepare('SELECT status FROM deal_hunter_cim_safety_events').get().status, 'no-op');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'safety-consumed'").get().count, 1);
});

test('P2 unchanged source evidence is a no-op for an existing active campaign', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p2-unchanged');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-p2-unchanged');
  await storage.appendCimSafetyEvents({ safetyRunId: 'p2-unchanged-run', sourceType: 'synthetic-import',
    sourceRunId: 'p2-unchanged-source', now: at, events: [{ opportunityId: authority.opportunityId,
      canonicalRevision: 1, identityExceptionRevision: 0, eventType: 'source-record-unchanged',
      evidenceId: 'p2-unchanged-evidence' }] });
  const shadow = await runCimCampaignSafety({ storage, safetyRunId: 'p2-unchanged-run', mode: 'shadow', now: at });
  assert.equal(shadow.pending, 1);
  assert.equal(shadow.proposed.noOp, 1);
  const consumed = await runCimCampaignSafety({ storage, safetyRunId: 'p2-unchanged-run', mode: 'active', now: at });
  assert.deepEqual(consumed, { safetyRunId: 'p2-unchanged-run', safetyEventsEmitted: 1,
    stopped: 0, reviewRequired: 0, noOp: 1, pending: 0,
    sourceProjectionPending: false, complete: true });
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaigns WHERE id = ?')
    .get(authority.campaignId).state, 'initial-pending');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'scheduled');
});

test('P2 admitted import is evidence-only for an active campaign until safety activation', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p2-active-import');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-p2-import');
  const before = await storage.readCimOutreachCounters();
  const campaignBefore = fingerprintRows(database, 'deal_hunter_cim_campaigns', 'id');
  const touchBefore = fingerprintRows(database, 'deal_hunter_cim_campaign_touches', 'id');
  const sourceId = 'sheet-0';
  const sourceRecordId = 'external:P2-CAMPAIGN';
  const run = await storage.allocateDealHunterSourceGeneration({ sourceId, runId: 'p2-active-import-run' });
  const accepted = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({ storage,
    reviewMode: 'full-backfill', run,
    sourceResult: { source: { id: sourceId, required: true, fetched: true,
      sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
    deals: [{ sourceId, sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'P2-CAMPAIGN' }] },
    records: [{ opportunity_id: authority.opportunityId, source_id: sourceId,
      source_name: 'Synthetic Sheet', source_record_id: sourceRecordId,
      observations: [{ id: 'p2-campaign-observation', opportunity_id: authority.opportunityId,
        source_id: sourceId, source_name: 'Synthetic Sheet', source_record_id: sourceRecordId,
        field: 'name', value: 'Campaign Shop', observed_at: at, created_at: at, updated_at: at }],
      freshness_evidence: null }],
  });
  assert.equal(accepted.reconciled, true);
  assert.equal(accepted.safetyEventsEmitted, 1);
  assert.deepEqual(await storage.readCimOutreachCounters(), before);
  assert.equal(fingerprintRows(database, 'deal_hunter_cim_campaigns', 'id'), campaignBefore);
  assert.equal(fingerprintRows(database, 'deal_hunter_cim_campaign_touches', 'id'), touchBefore);
  const current = await readCimCurrentAuthority({ storage,
    opportunityId: authority.opportunityId,
    readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(current.blocked, true);
  assert.ok(current.blockers.includes('campaign-source-authority-changed'));
  const shadow = await runCimCampaignSafety({ storage, safetyRunId: accepted.safetyRunId, mode: 'shadow', now: at });
  assert.deepEqual([shadow.pending, shadow.proposed.reviewRequired], [1, 1]);
  const withoutActivation = await runCimCampaignSafety({ storage,
    safetyRunId: accepted.safetyRunId, mode: 'active', now: at });
  assert.equal(withoutActivation.pending, 1);
  assert.equal(fingerprintRows(database, 'deal_hunter_cim_campaigns', 'id'), campaignBefore);
  await seedSyntheticActivationChain(storage, 'fl04a-safety');
  const consumed = await runCimCampaignSafety({ storage,
    safetyRunId: accepted.safetyRunId, mode: 'active', now: at });
  assert.deepEqual([consumed.reviewRequired, consumed.pending], [1, 0]);
  assert.deepEqual(await runCimCampaignSafety({ storage,
    safetyRunId: accepted.safetyRunId, mode: 'active', now: at }), consumed);
  assert.equal((await storage.readCimOutreachCounters()).campaigns, before.campaigns);
});

test('P2 arbitrary safety append cannot impersonate an admitted source commit', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p2-source-impersonation');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'op-p2-impersonation');
  await assert.rejects(storage.appendCimSafetyEvents({ safetyRunId: 'fake-import-run',
    sourceType: 'sheet-import', sourceRunId: 'fake-run', now: at,
    events: [{ opportunityId: 'op-p2-impersonation', canonicalRevision: 0,
      identityExceptionRevision: 0, eventType: 'source-record-changed', evidenceId: 'fake-evidence' }] }),
  /source commit/);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_safety_events').get().n, 0);
});

test('P1B safety stop stays pending without activation then terminalizes once', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-safety-stop');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-safety-stop');
  await storage.appendCimSafetyEvents({ safetyRunId: 'safety-run-stop', sourceType: 'synthetic-import',
    sourceRunId: 'source-run-stop', now: at, events: [{ opportunityId: authority.opportunityId,
      canonicalRevision: 1, identityExceptionRevision: 0, eventType: 'identity-unsafe',
      evidenceId: 'evidence-stop' }] });
  const eventId = database.prepare('SELECT id FROM deal_hunter_cim_safety_events').get().id;
  const command = { safetyRunId: 'safety-run-stop', limit: 10, actor: 'fixture-owner', now: at,
    outcomes: { [eventId]: 'stopped' } };
  assert.equal((await storage.consumeCimSafetyEvents(command)).pending, 1);
  await seedSyntheticActivationChain(storage, 'fl04a-safety');
  assert.equal((await storage.consumeCimSafetyEvents(command)).stopped, 1);
  assert.equal((await storage.consumeCimSafetyEvents(command)).stopped, 1);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaigns WHERE id = ?').get(authority.campaignId).state,
    'stopped');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?').get(authority.touchId).state,
    'cancelled-before-provider');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'safety-consumed'").get().count, 1);
});

test('P1B transmission preparation binds immutable copy, CRM rows, and one active membership', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-prepare');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-prepare');
  seedCrmOwner(database, authority.opportunityId, 'submission-prepare');
  await seedSyntheticActivationChain(storage);
  const claimTokenDigest = digest('a');
  assert.equal((await storage.claimDueCimTouch({ touchId: authority.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest, claimOwner: 'worker-1', claimExpiresAt: '2026-09-25T19:10:00.000Z',
    now: at })).claimed, true);
  const command = { touchIds: [authority.touchId], claimTokenDigest,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    preparationGeneration: 1, payloadVersion: 'payload-v1',
    fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
    ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
    subject: 'Synthetic subject', bodyText: 'Synthetic body',
    bodyHtmlSanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
    actor: 'fixture-owner', now: at };
  const first = await storage.prepareCimTransmission(command);
  assert.equal(first.prepared, true);
  assert.equal(first.transmission.state, 'prepared');
  assert.equal((await storage.prepareCimTransmission(command)).existing, true);
  assert.equal((await storage.prepareCimTransmission({ ...command, bodyText: 'Changed body' })).payloadConflict, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_transmissions').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_transmission_touches WHERE cancelled_at IS NULL').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM crm_communications').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM crm_email_outbox').get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'transmission-prepared'").get().count, 1);
});

test('P5 CIM-owned outbox cannot enter the generic email claim path', async (t) => {
  const { storage, database, prepared } = await createPreparedFixture(t, 'p5-outbox');
  const outbox = database.prepare('SELECT * FROM crm_email_outbox WHERE id = ?').get(prepared.outbox_id);
  assert.equal(outbox.state, 'prepared');
  assert.equal(JSON.parse(outbox.metadata).retryPolicy, 'reconcile-only-after-provider-pending');
  database.prepare("UPDATE crm_email_outbox SET state = 'queued' WHERE id = ?")
    .run(outbox.id);
  const claim = await storage.claimCrmEmailOutbox({ id: outbox.id,
    claimToken: 'generic-worker-token', claimedAt: at,
    claimExpiresAt: '2026-09-25T19:10:00.000Z' });
  assert.equal(claim.claimed, false);
  assert.equal(database.prepare('SELECT state FROM crm_email_outbox WHERE id = ?')
    .get(outbox.id).state, 'queued');
});

test('P5 preparation rejects a CRM primary submission changed after claim', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p5-crm-current');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-p5-crm-current');
  seedCrmOwner(database, authority.opportunityId, 'submission-p5-crm-current');
  await seedSyntheticActivationChain(storage);
  const claimTokenDigest = digest('a');
  assert.equal((await storage.claimDueCimTouch({ touchId: authority.touchId,
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest,
    claimOwner: 'worker', claimExpiresAt: '2026-09-25T19:10:00.000Z', now: at })).claimed, true);
  database.prepare('UPDATE deal_hunter_opportunities SET primary_submission_id = NULL WHERE opportunity_id = ?')
    .run(authority.opportunityId);
  const result = await storage.prepareCimTransmission({
    touchIds: [authority.touchId], claimTokenDigest,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    preparationGeneration: 1, payloadVersion: 'payload-v1',
    fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
    ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
    subject: 'Synthetic subject', bodyText: 'Synthetic body',
    bodyHtmlSanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
    actor: 'fixture-owner', now: at,
  });
  assert.equal(result.terminal, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM crm_communications').get().n, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM crm_email_outbox').get().n, 0);
});

async function createPreparedFixture(t, suffix, recipientFingerprint = digest('e')) {
  const sqlitePath = temporaryPath(t, `pursue-cim-${suffix}`);
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, `-${suffix}`, recipientFingerprint);
  seedCrmOwner(database, authority.opportunityId, `submission-${suffix}`);
  await seedSyntheticActivationChain(storage);
  const claimTokenDigest = digest('a');
  assert.equal((await storage.claimDueCimTouch({ touchId: authority.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest, claimOwner: 'worker-1', claimExpiresAt: '2026-09-25T19:10:00.000Z',
    now: at })).claimed, true);
  const prepareCommand = { touchIds: [authority.touchId], claimTokenDigest,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    preparationGeneration: 1, payloadVersion: 'deal-hunter-cim-manual-stage1-v1',
    fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
    ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
    subject: 'Synthetic subject', bodyText: 'Synthetic body',
    bodyHtmlSanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
    actor: 'fixture-owner', now: at };
  const prepared = await storage.prepareCimTransmission(prepareCommand);
  assert.equal(prepared.prepared, true);
  return { storage, database, authority, prepared: prepared.transmission, prepareCommand };
}

async function createFinalGateFixture(t, suffix) {
  const recipient = { email: 'broker@example.test', provenanceFingerprint: digest('9'),
    permissionProvenanceFingerprint: digest('a'), contactAuthorityRevision: digest('b') };
  const opportunityId = `opp-p1a-${suffix}`;
  const recipientFingerprint = sha256(stableCanonicalJson({ opportunityId,
    emailHash: sha256(recipient.email),
    provenanceFingerprint: recipient.provenanceFingerprint,
    contactAuthorityRevision: recipient.contactAuthorityRevision }));
  const fixture = await createPreparedFixture(t, suffix, recipientFingerprint);
  const { storage, database, authority, prepared } = fixture;
  database.prepare(`UPDATE deal_hunter_pursuit_enrollments
    SET state = 'campaign-created', reason_code = NULL, row_version = 2, updated_at = ?
    WHERE id = ?`).run(at, authority.enrollmentId);
  database.prepare(`UPDATE deal_hunter_opportunities
    SET discovery_state = 'known_prospective', updated_at = ? WHERE opportunity_id = ?`)
    .run(at, authority.opportunityId);
  const crmOwnershipRevision = database.prepare(`SELECT MAX(revision) AS revision
    FROM deal_hunter_crm_ownership_revisions WHERE opportunity_id = ?`)
    .get(authority.opportunityId).revision;
  database.prepare(`UPDATE deal_hunter_cim_campaigns SET crm_ownership_revision = ? WHERE id = ?`)
    .run(crmOwnershipRevision, authority.campaignId);
  database.prepare(`INSERT INTO deal_hunter_source_freshness_state
    (source_id, next_generation, accepted_generation, accepted_run_id, accepted_digest,
      accepted_at, projection_state)
    VALUES ('sheet-0', 1, 1, ?, ?, ?, 'accepted')`)
    .run(`source-run-${suffix}`, digest('c'), at);
  database.prepare(`INSERT INTO deal_hunter_opportunity_source_observations
    (id, opportunity_id, source_id, source_name, source_record_id, field, value,
      observed_at, accepted_at, accepted_run_id, created_at, updated_at)
    VALUES (?, ?, 'sheet-0', 'Synthetic Sheet', ?, 'broker_email',
      'broker@example.test', ?, ?, ?, ?, ?)`)
    .run(`source-row-${suffix}`, authority.opportunityId, `source-record-${suffix}`,
      at, at, `source-run-${suffix}`, at, at);
  database.prepare(`UPDATE deal_hunter_cim_campaigns SET
    permission_version = 'synthetic-fl04b-enrollment', permission_digest = ?,
    permission_revision = 1, permission_scope = ? WHERE id = ?`)
    .run(digest('2'), digest('f'), authority.campaignId);
  database.prepare(`UPDATE deal_hunter_cim_capability_activations SET
    permission_basis_digest = ?, permission_revision = 1, cohort_digest = ?
    WHERE id = 'synthetic-fl04b-initial'`).run(digest('2'), digest('f'));
  database.prepare(`INSERT INTO deal_hunter_cim_safety_settings
    (id, updated_at, outreach_paused, updated_by, metadata)
    VALUES ('global', ?, 0, 'fixture-owner', '{}')`).run(at);
  const issued = await storage.issueCimLiveProviderAuthorization({
    id: `authorization-${suffix}`, activationId: 'synthetic-fl04b-initial',
    capability: 'fl04b-initial', writerPath: 'pursue-cim-initial',
    transmissionId: prepared.id, payloadDigest: prepared.payload_digest,
    recipientAuthorityDigest: recipientFingerprint, providerProfile: 'synthetic-provider',
    expiresAt: '2026-09-25T20:00:00.000Z', actor: 'fixture-owner',
    reason: 'synthetic final-gate envelope', now: at,
  });
  assert.equal(issued.issued, true);
  const loadMemberAuthority = async () => ({ opportunityId: authority.opportunityId,
    recipientOptions: [recipient],
    materialsState: { materialsReceived: false, advancedBeyondBrokerOutreach: false,
      evidenceCodes: [] }, preparationBlockers: [], suppression: null,
    terminalReason: '', existingRequest: null, opportunityClaim: null,
    currentDispositionState: 'pursued', pursued: true });
  const current = database.prepare(`SELECT * FROM deal_hunter_opportunities
    WHERE opportunity_id = ?`).get(authority.opportunityId);
  const readCurrentAuthority = async () => ({ opportunityId: authority.opportunityId,
    blocked: false, blockers: [], opportunity: current,
    sourceRows: database.prepare(`SELECT * FROM deal_hunter_opportunity_source_observations
      WHERE opportunity_id = ? ORDER BY id`).all(authority.opportunityId),
    sourceStates: database.prepare(`SELECT * FROM deal_hunter_source_freshness_state
      ORDER BY source_id`).all(), sourceHealth: { healthy: true, issues: [],
      requiredSources: ['sheet-0'] }, identityExceptions: [],
    campaign: database.prepare('SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?')
      .get(authority.campaignId) });
  const readProviderReadiness = async () => ({
    version: 'cim-provider-readiness-v1', provider: 'resend',
    providerProfile: 'synthetic-provider', outboundConfigured: true,
    senderConfigured: true, senderAuthenticationAttested: true, webhookConfigured: true,
    requestReplyRoutingVerified: true, replyTrackingVerified: true,
    suppressionOperational: true, reconciliationOperational: true,
    evidenceRevision: `synthetic-readiness-${suffix}`, generatedAt: at,
    expiresAt: '2026-09-25T19:05:00.000Z',
  });
  const gate = (overrides = {}) => authorizePreparedCimTransmission({ storage,
    transmissionId: prepared.id, authorizationId: issued.authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner', now: at, loadMemberAuthority,
    readCurrentAuthority, readProviderReadiness, ...overrides });
  return { ...fixture, authorization: issued.authorization, recipient,
    recipientFingerprint, loadMemberAuthority, readCurrentAuthority,
    readProviderReadiness, gate };
}

test('P6A SQLite final gate consumes one authority, keeps the raw nonce ephemeral, and process restart adds zero calls', async (t) => {
  const { storage, database, authority, prepared, authorization, gate, recipient,
    loadMemberAuthority, readCurrentAuthority, readProviderReadiness } =
    await createFinalGateFixture(t, 'p6a-success');
  const before = await storage.readCimOutreachCounters();
  const first = await gate();
  assert.equal(first.authorized, true, JSON.stringify(first));
  assert.match(first.boundaryNonce, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(first.transmission.boundary_nonce_digest, sha256(first.boundaryNonce));
  assert.equal(first.transmission.provider_seam_entered_at, null);
  assert.equal(first.transmission.invocation_authority_count, 1);
  const durable = database.prepare('SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id);
  assert.equal(durable.boundary_nonce_digest, sha256(first.boundaryNonce));
  assert.equal(JSON.stringify(durable).includes(first.boundaryNonce), false);
  assert.equal(database.prepare(`SELECT consumed_at FROM deal_hunter_cim_live_provider_authorizations
    WHERE id = ?`).get(authorization.id).consumed_at, at);
  assert.equal(database.prepare(`SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?`)
    .get(authority.touchId).state, 'provider-pending');
  assert.equal(database.prepare(`SELECT delivery_state FROM crm_communications
    WHERE id = ?`).get(prepared.communication_id).delivery_state, 'provider-pending');
  assert.equal(database.prepare(`SELECT state FROM crm_email_outbox WHERE id = ?`)
    .get(prepared.outbox_id).state, 'provider-pending');
  assert.equal(JSON.stringify(database.prepare(`SELECT * FROM deal_hunter_cim_audit_events
    ORDER BY occurred_at, id`).all()).includes(first.boundaryNonce), false);
  const after = await storage.readCimOutreachCounters();
  assert.deepEqual({ campaigns: after.campaigns - before.campaigns,
    touches: after.touches - before.touches,
    transmissions: after.transmissions - before.transmissions,
    memberships: after.memberships - before.memberships,
    crmOutbound: after.crmOutbound - before.crmOutbound,
    outbox: after.outbox - before.outbox,
    providerPending: after.providerPending - before.providerPending,
    providerSeamEntries: after.providerSeamEntries - before.providerSeamEntries },
  { campaigns: 0, touches: 0, transmissions: 0, memberships: 0,
    crmOutbound: 0, outbox: 0, providerPending: 1, providerSeamEntries: 0 });

  const recovered = await transitionFromWorker(database.name, 'final-gate-service', {
    args: { transmissionId: prepared.id, authorizationId: authorization.id,
      writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
      actor: 'fixture-owner', now: at },
    memberAuthority: await loadMemberAuthority({ opportunityId: authority.opportunityId }),
    currentAuthority: await readCurrentAuthority({ opportunityId: authority.opportunityId }),
    providerReadiness: await readProviderReadiness(),
    recipient,
  });
  assert.equal(recovered.authorized, false);
  assert.equal(recovered.blockedReason, 'already_provider_pending');
  assert.equal(recovered.reconciliationOnly, true);
  assert.equal(recovered.hasBoundaryNonce, false);
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM deal_hunter_cim_live_provider_authorizations
    WHERE consumed_at IS NOT NULL`).get().n, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions
    WHERE provider_seam_entered_at IS NOT NULL`).get().n, 0);
});

test('P6B SQLite same-process final gate enters the common provider seam exactly once', async (t) => {
  const { storage, database, authorization, gate } =
    await createFinalGateFixture(t, 'p6b-same-process');
  const finalGate = await gate();
  assert.equal(finalGate.authorized, true, JSON.stringify(finalGate));
  let providerCalls = 0;
  const send = () => sendAuthorizedCimTransmission({
    storage, finalGateResult: finalGate, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner',
    now: new Date(at),
    configOverride: {
      isProduction: false,
      server: { outboundRequestTimeoutMs: 100 },
      delivery: {
        provider: 'resend',
        resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test',
      },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } },
    },
    fetcher: async () => {
      providerCalls += 1;
      return Response.json({ id: 'synthetic-resend-id' });
    },
  });

  const first = await send();
  const replay = await send();
  assert.equal(first.status, 'sent');
  assert.equal(replay.errorCategory, 'cim-provider-seam-already-entered');
  assert.equal(replay.reconciliationOnly, true);
  assert.equal(providerCalls, 1);
  assert.equal((await storage.readCimOutreachCounters()).providerSeamEntries, 1);
  const operations = await storage.readPursueCimOperationsSnapshot({ now: at, limit: 100 });
  assert.deepEqual(operations.boundary, { accepts: 1, rejects: 1,
    byWriterPath: { 'accepted:pursue-cim-initial': 1,
      'rejected:pursue-cim-initial': 1 } });
  assert.equal(database.prepare(`SELECT reason_code FROM deal_hunter_cim_audit_events
    WHERE event_type='provider-boundary-rejected'`).get().reason_code,
  'cim-provider-seam-already-entered');
});

test('P6C accepted provider result atomically finalizes the real P5→P6A→P6B pipeline once', async (t) => {
  const { storage, database, authority, authorization, gate } =
    await createFinalGateFixture(t, 'p6c-accepted-pipeline');
  const finalGateResult = await gate();
  let providerCalls = 0;
  const common = {
    storage, finalGateResult, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner', now: new Date(at),
    configOverride: {
      isProduction: false,
      server: { outboundRequestTimeoutMs: 100 },
      delivery: { provider: 'resend', resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test' },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } },
    },
    fetcher: async () => {
      providerCalls += 1;
      return Response.json({ id: 'p6c-accepted-provider-id' });
    },
  };
  const first = await finalizeAuthorizedCimTransmission(common);
  assert.equal(first.outcome.category, 'accepted');
  assert.equal(first.durableResult.applied, true);
  assert.equal(providerCalls, 1);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions')
    .get().state, 'accepted');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'accepted');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 2);
  assert.equal(first.durableResult.nextTouch.kind, 'follow-up-1');
  const campaign = database.prepare('SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?')
    .get(authority.campaignId);
  assert.equal((await storage.claimDueCimTouch({ touchId: first.durableResult.nextTouch.id,
    expectedRowVersion: 1, expectedCampaignTerminalRevision: campaign.terminal_revision,
    expectedConversationTerminalRevision: 0, claimTokenDigest: digest('7'),
    claimOwner: 'follow-up-worker', claimExpiresAt: '2026-09-29T13:00:00.000Z',
    now: first.durableResult.nextTouch.due_at })).staleAuthority, true);

  const restart = await finalizeAuthorizedCimTransmission(common);
  assert.equal(restart.outcome.category, 'accepted');
  assert.equal(restart.durableResult.existing, true);
  assert.equal(providerCalls, 1);
});

test('P6C crash after durable seam entry adds zero provider calls on recovery', async (t) => {
  const { storage, database, authorization, gate } =
    await createFinalGateFixture(t, 'p6c-crash-after-seam');
  const finalGateResult = await gate();
  let providerCalls = 0;
  const common = {
    storage, finalGateResult, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner', now: new Date(at),
    configOverride: { isProduction: false, server: { outboundRequestTimeoutMs: 100 },
      delivery: { provider: 'resend', resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test' },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } } },
    fetcher: async () => { providerCalls += 1; return Response.json({ id: 'must-not-send' }); },
  };
  await assert.rejects(finalizeAuthorizedCimTransmission({ ...common,
    testHooks: { async afterProviderSeam() { throw new Error('synthetic seam crash'); } },
  }), /synthetic seam crash/);
  assert.equal(providerCalls, 0);
  assert.deepEqual(database.prepare(`SELECT state, invocation_authority_count,
    provider_seam_entered_at IS NOT NULL AS seam_entered
    FROM deal_hunter_cim_transmissions`).get(), {
    state: 'provider-pending', invocation_authority_count: 1, seam_entered: 1,
  });
  const recovered = await finalizeAuthorizedCimTransmission(common);
  assert.equal(recovered.outcome.category, 'pending');
  assert.equal(recovered.durableResult, null);
  assert.equal(providerCalls, 0);
});

test('P6C crash after accepted response reconciles the same transmission with zero recovery calls', async (t) => {
  const { storage, database, authorization, gate } =
    await createFinalGateFixture(t, 'p6c-crash-after-response');
  const finalGateResult = await gate();
  let providerCalls = 0;
  const common = {
    storage, finalGateResult, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner', now: new Date(at),
    configOverride: { isProduction: false, server: { outboundRequestTimeoutMs: 100 },
      delivery: { provider: 'resend', resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test' },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } } },
    fetcher: async () => {
      providerCalls += 1;
      return Response.json({ id: 'accepted-before-crash' });
    },
  };
  await assert.rejects(finalizeAuthorizedCimTransmission({ ...common,
    testHooks: { async afterProviderResult() { throw new Error('synthetic response crash'); } },
  }), /synthetic response crash/);
  assert.equal(providerCalls, 1);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions').get().state,
    'provider-pending');
  const restart = await finalizeAuthorizedCimTransmission(common);
  assert.equal(restart.outcome.category, 'pending');
  assert.equal(providerCalls, 1);
  const durableTransmission = database.prepare('SELECT * FROM deal_hunter_cim_transmissions').get();
  const reconciled = await reconcileCimProviderTransmission({ storage,
    transmission: durableTransmission, actor: 'fixture-owner', now: at,
    readProviderEvidence: async () => ({ type: 'persisted-provider-result',
      id: 'accepted-response-1', provider: 'resend', outcome: 'accepted', observedAt: at,
      binding: reconciliationBinding(durableTransmission),
      candidates: [{ provider: 'resend', providerMessageId: 'accepted-before-crash',
        evidenceId: 'accepted-response-provider-id' }] }),
  });
  assert.equal(reconciled.durableResult.applied, true);
  assert.equal(reconciled.durableResult.transmission.state, 'accepted');
  assert.equal(providerCalls, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches')
    .get().count, 2);
});

test('P6C crash after definitive rejection reconciles the same transmission without retransmission', async (t) => {
  const { storage, database, authorization, gate } =
    await createFinalGateFixture(t, 'p6c-crash-after-rejection');
  const finalGateResult = await gate();
  let providerCalls = 0;
  const common = {
    storage, finalGateResult, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner', now: new Date(at),
    configOverride: { isProduction: false, server: { outboundRequestTimeoutMs: 100 },
      delivery: { provider: 'resend', resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test' },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } } },
    fetcher: async () => { providerCalls += 1;
      return new Response('recipient rejected', { status: 422 }); },
  };
  await assert.rejects(finalizeAuthorizedCimTransmission({ ...common,
    testHooks: { async afterProviderResult() { throw new Error('rejection response crash'); } },
  }), /rejection response crash/);
  assert.equal(providerCalls, 1);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions').get().state,
    'provider-pending');
  assert.equal((await finalizeAuthorizedCimTransmission(common)).outcome.category, 'pending');
  assert.equal(providerCalls, 1);
  const durableTransmission = database.prepare('SELECT * FROM deal_hunter_cim_transmissions').get();
  const reconciled = await reconcileCimProviderTransmission({ storage,
    transmission: durableTransmission, actor: 'fixture-owner', now: at,
    readProviderEvidence: async () => ({ type: 'persisted-provider-result',
      id: 'rejected-response-1', provider: 'resend', outcome: 'definitive-failure',
      observedAt: at, binding: reconciliationBinding(durableTransmission), candidates: [] }),
  });
  assert.equal(reconciled.durableResult.transmission.state, 'definitive-failure');
  assert.equal(providerCalls, 1);
});

test('P6C crash after an ambiguous transport result reconciles ambiguity without retransmission', async (t) => {
  const { storage, database, authorization, gate } =
    await createFinalGateFixture(t, 'p6c-crash-after-ambiguous');
  const finalGateResult = await gate();
  let providerCalls = 0;
  const common = {
    storage, finalGateResult, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner', now: new Date(at),
    configOverride: { isProduction: false, server: { outboundRequestTimeoutMs: 100 },
      delivery: { provider: 'resend', resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test' },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } } },
    fetcher: async () => { providerCalls += 1; throw new Error('socket reset'); },
  };
  await assert.rejects(finalizeAuthorizedCimTransmission({ ...common,
    testHooks: { async afterProviderResult() { throw new Error('ambiguous response crash'); } },
  }), /ambiguous response crash/);
  assert.equal(providerCalls, 1);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions').get().state,
    'provider-pending');
  assert.equal((await finalizeAuthorizedCimTransmission(common)).outcome.category, 'pending');
  assert.equal(providerCalls, 1);
  const durableTransmission = database.prepare('SELECT * FROM deal_hunter_cim_transmissions').get();
  const reconciled = await reconcileCimProviderTransmission({ storage,
    transmission: durableTransmission, actor: 'fixture-owner', now: at,
    readProviderEvidence: async () => ({ type: 'persisted-provider-result',
      id: 'ambiguous-response-1', provider: 'resend', outcome: 'ambiguous', observedAt: at,
      binding: reconciliationBinding(durableTransmission), candidates: [] }),
  });
  assert.equal(reconciled.durableResult.transmission.state, 'ambiguous');
  assert.equal(providerCalls, 1);
});

test('P6C finalization transaction rolls back atomically and retries evidence without another call', async (t) => {
  const { storage, database, authorization, gate } =
    await createFinalGateFixture(t, 'p6c-finalization-rollback');
  const finalGateResult = await gate();
  let providerCalls = 0;
  let finalizationCommand;
  database.exec(`CREATE TRIGGER p6c_fail_finalization_audit
    BEFORE INSERT ON deal_hunter_cim_audit_events
    WHEN NEW.event_type = 'transmission-finalized'
    BEGIN SELECT RAISE(ABORT, 'synthetic finalization commit loss'); END`);
  await assert.rejects(finalizeAuthorizedCimTransmission({
    storage, finalGateResult, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner', now: new Date(at),
    configOverride: { isProduction: false, server: { outboundRequestTimeoutMs: 100 },
      delivery: { provider: 'resend', resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test' },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } } },
    fetcher: async () => { providerCalls += 1;
      return Response.json({ id: 'accepted-before-rollback' }); },
    testHooks: { async beforeFinalization({ command }) { finalizationCommand = command; } },
  }), /synthetic finalization commit loss/);
  assert.equal(providerCalls, 1);
  assert.deepEqual({
    transmission: database.prepare('SELECT state FROM deal_hunter_cim_transmissions').get().state,
    touch: database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches').get().state,
    campaign: database.prepare('SELECT state FROM deal_hunter_cim_campaigns').get().state,
    communication: database.prepare('SELECT delivery_state FROM crm_communications').get().delivery_state,
    outbox: database.prepare('SELECT state FROM crm_email_outbox').get().state,
  }, { transmission: 'provider-pending', touch: 'provider-pending',
    campaign: 'initial-pending', communication: 'provider-pending',
    outbox: 'provider-pending' });
  database.exec('DROP TRIGGER p6c_fail_finalization_audit');
  const retried = await storage.finalizeCimTransmission(finalizationCommand);
  assert.equal(retried.applied, true);
  assert.equal(retried.transmission.state, 'accepted');
  assert.equal(providerCalls, 1);
});

test('P6C crash after finalization commit observes terminal replay with zero recovery calls', async (t) => {
  const { storage, database, authorization, gate } =
    await createFinalGateFixture(t, 'p6c-crash-after-commit');
  const finalGateResult = await gate();
  let providerCalls = 0;
  const common = {
    storage, finalGateResult, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner', now: new Date(at),
    configOverride: { isProduction: false, server: { outboundRequestTimeoutMs: 100 },
      delivery: { provider: 'resend', resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test' },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } } },
    fetcher: async () => { providerCalls += 1;
      return Response.json({ id: 'accepted-before-post-commit-crash' }); },
  };
  await assert.rejects(finalizeAuthorizedCimTransmission({ ...common,
    testHooks: { async afterFinalization() { throw new Error('synthetic post-commit crash'); } },
  }), /synthetic post-commit crash/);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions').get().state,
    'accepted');
  assert.equal(providerCalls, 1);
  const restart = await finalizeAuthorizedCimTransmission(common);
  assert.equal(restart.outcome.category, 'accepted');
  assert.equal(restart.durableResult.existing, true);
  assert.equal(providerCalls, 1);
});

test('P6C transport uncertainty finalizes ambiguity and never retries on restart', async (t) => {
  const { storage, database, authority, authorization, gate } =
    await createFinalGateFixture(t, 'p6c-network-ambiguous');
  const finalGateResult = await gate();
  let providerCalls = 0;
  const common = {
    storage, finalGateResult, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner', now: new Date(at),
    configOverride: { isProduction: false, server: { outboundRequestTimeoutMs: 100 },
      delivery: { provider: 'resend', resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test' },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } } },
    fetcher: async () => { providerCalls += 1; throw new Error('socket reset'); },
  };
  const first = await finalizeAuthorizedCimTransmission(common);
  assert.equal(first.outcome.category, 'ambiguous');
  assert.equal(first.durableResult.applied, true);
  assert.equal(providerCalls, 1);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions').get().state,
    'ambiguous');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_broker_conversations WHERE id = ?')
    .get(authority.conversationId).state, 'provider-ambiguous');
  const restart = await finalizeAuthorizedCimTransmission(common);
  assert.equal(restart.outcome.category, 'ambiguous');
  assert.equal(restart.durableResult.existing, true);
  assert.equal(providerCalls, 1);
});

test('P6C explicit Resend rejection finalizes the real pipeline as definitive without retry', async (t) => {
  const { storage, database, authority, authorization, gate } =
    await createFinalGateFixture(t, 'p6c-provider-rejection');
  const finalGateResult = await gate();
  let providerCalls = 0;
  const common = {
    storage, finalGateResult, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'fixture-owner', now: new Date(at),
    configOverride: { isProduction: false, server: { outboundRequestTimeoutMs: 100 },
      delivery: { provider: 'resend', resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test' },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } } },
    fetcher: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ message: 'recipient rejected' }), {
        status: 422, headers: { 'content-type': 'application/json' },
      });
    },
  };
  const first = await finalizeAuthorizedCimTransmission(common);
  assert.equal(first.outcome.category, 'definitive-failure');
  assert.equal(first.durableResult.applied, true);
  assert.equal(providerCalls, 1);
  assert.deepEqual(database.prepare(`SELECT state, provider_result_code
    FROM deal_hunter_cim_transmissions`).get(), {
    state: 'definitive-failure', provider_result_code: 'provider-nonacceptance',
  });
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'definitive-failure');
  assert.deepEqual(database.prepare(`SELECT state, reason_code FROM deal_hunter_cim_campaigns
    WHERE id = ?`).get(authority.campaignId), {
    state: 'action-required', reason_code: 'provider_definitive_failure',
  });
  const restart = await finalizeAuthorizedCimTransmission(common);
  assert.equal(restart.outcome.category, 'definitive-failure');
  assert.equal(restart.durableResult.existing, true);
  assert.equal(providerCalls, 1);
});

test('P6B SQLite pause flip after final gate denies seam entry with consumed authority intact', async (t) => {
  const { storage, database, prepared, authorization, gate } =
    await createFinalGateFixture(t, 'p6b-pause-race');
  const finalGate = await gate();
  assert.equal(finalGate.authorized, true, JSON.stringify(finalGate));
  database.prepare(`UPDATE deal_hunter_cim_safety_settings
    SET outreach_paused = 1, updated_at = ? WHERE id = 'global'`).run(at);
  const durable = await storage.readCimFinalGateContext({
    transmissionId: prepared.id,
    authorizationId: authorization.id,
  });
  const boundaryAuthorization = createCimProviderBoundaryAuthorization({
    finalGateResult: finalGate,
    authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider',
    actor: 'fixture-owner',
  });
  let providerCalls = 0;
  const result = await sendPreparedMessage({
    kind: 'cim-initial',
    transmissionId: durable.transmission.id,
    communicationId: durable.communication.id,
    idempotencyKey: durable.transmission.provider_idempotency_key,
    from: durable.communication.from_address,
    to: durable.communication.to_addresses,
    cc: durable.communication.cc_addresses,
    bcc: durable.communication.bcc_addresses,
    replyTo: durable.communication.reply_to_address,
    subject: durable.communication.subject,
    text: durable.communication.body_text,
    html: durable.communication.body_html_sanitized,
    tags: durable.communication.tags,
  }, {
    storage,
    cimProviderAuthorization: boundaryAuthorization,
    now: new Date(at),
    configOverride: {
      isProduction: false,
      server: { outboundRequestTimeoutMs: 100 },
      delivery: {
        provider: 'resend',
        resendApiKey: 'synthetic-key',
        resendFromEmail: 'sender@example.test',
      },
      dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } },
    },
    fetcher: async () => {
      providerCalls += 1;
      return Response.json({ id: 'must-not-send' });
    },
  });

  assert.equal(result.errorCategory, 'cim-provider-seam-unauthorized');
  assert.equal(providerCalls, 0);
  assert.equal(database.prepare(`SELECT provider_seam_entered_at
    FROM deal_hunter_cim_transmissions WHERE id = ?`).get(prepared.id).provider_seam_entered_at, null);
  assert.equal(database.prepare(`SELECT consumed_at
    FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?`)
    .get(authorization.id).consumed_at, at);
});

test('P6C scenario 78 unknown policy becomes action-required and provider-inert', async (t) => {
  const { database, authority, authorization, gate } =
    await createFinalGateFixture(t, 'p6c-unknown-policy');
  database.prepare(`UPDATE deal_hunter_cim_campaigns SET policy_version = ? WHERE id = ?`)
    .run('unknown-future-policy', authority.campaignId);
  let readinessCalls = 0;
  const outcome = await gate({ readProviderReadiness: async () => {
    readinessCalls += 1;
    throw new Error('readiness must not be consulted for unknown policy');
  } });
  assert.equal(outcome.authorized, false);
  assert.equal(outcome.blockedReason, 'unknown_policy_version');
  assert.equal(readinessCalls, 0);
  assert.deepEqual(database.prepare(`SELECT state, reason_code
    FROM deal_hunter_cim_campaigns WHERE id = ?`).get(authority.campaignId), {
    state: 'action-required', reason_code: 'unknown_policy_version',
  });
  assert.equal(database.prepare('SELECT invocation_authority_count FROM deal_hunter_cim_transmissions')
    .get().invocation_authority_count, 0);
  assert.notEqual(database.prepare(`SELECT withdrawn_at
    FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?`)
    .get(authorization.id).withdrawn_at, null);
});

test('P6C unsupported permission and batching versions durably fail closed before readiness', async (t) => {
  for (const [name, mutate] of [
    ['permission', ({ database, authority }) => database.prepare(`UPDATE
      deal_hunter_cim_campaigns SET permission_version = ? WHERE id = ?`)
      .run('future-activation-v2', authority.campaignId)],
    ['batching', ({ database, authority }) => database.prepare(`UPDATE
      deal_hunter_broker_conversations SET batching_policy_version = ? WHERE id = ?`)
      .run('future-batching-v2', authority.conversationId)],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createFinalGateFixture(subtest, `p6c-unknown-${name}`);
      const { database, authority, authorization, gate } = fixture;
      mutate(fixture);
      let readinessCalls = 0;
      const outcome = await gate({ readProviderReadiness: async () => {
        readinessCalls += 1;
        throw new Error('readiness must not be consulted for an unsupported policy tuple');
      } });
      assert.equal(outcome.authorized, false);
      assert.equal(outcome.blockedReason, 'unknown_policy_version');
      assert.equal(readinessCalls, 0);
      assert.deepEqual(database.prepare(`SELECT state, reason_code
        FROM deal_hunter_cim_campaigns WHERE id = ?`).get(authority.campaignId), {
        state: 'action-required', reason_code: 'unknown_policy_version',
      });
      assert.equal(database.prepare(`SELECT invocation_authority_count
        FROM deal_hunter_cim_transmissions`).get().invocation_authority_count, 0);
      assert.notEqual(database.prepare(`SELECT withdrawn_at
        FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?`)
        .get(authorization.id).withdrawn_at, null);
    });
  }
});

test('P6C SQLite CAS rejects permission and batching changes after the service snapshot', async (t) => {
  for (const [name, mutate] of [
    ['permission', ({ database, authority }) => database.prepare(`UPDATE
      deal_hunter_cim_campaigns SET permission_version = ? WHERE id = ?`)
      .run('future-activation-v2', authority.campaignId)],
    ['batching', ({ database, authority }) => database.prepare(`UPDATE
      deal_hunter_broker_conversations SET batching_policy_version = ? WHERE id = ?`)
      .run('future-batching-v2', authority.conversationId)],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createFinalGateFixture(subtest, `p6c-cas-${name}`);
      let mutationApplied = false;
      const racingStorage = new Proxy(fixture.storage, {
        get(target, property, receiver) {
          if (property !== 'authorizeCimProviderPending') {
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (command) => {
            mutate(fixture);
            mutationApplied = true;
            return target.authorizeCimProviderPending(command);
          };
        },
      });
      const outcome = await fixture.gate({ storage: racingStorage });
      assert.equal(mutationApplied, true);
      assert.equal(outcome.authorized, false);
      assert.equal(outcome.blockedReason, 'unknown_policy_version');
      assert.equal(fixture.database.prepare(`SELECT invocation_authority_count
        FROM deal_hunter_cim_transmissions`).get().invocation_authority_count, 0);
      assert.equal(fixture.database.prepare(`SELECT state FROM deal_hunter_cim_transmissions`)
        .get().state, 'prepared');
      assert.equal(fixture.database.prepare(`SELECT consumed_at
        FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?`)
        .get(fixture.authorization.id).consumed_at, null);
    });
  }
});

test('P6A SQLite final gate blocks every mutable authority without consuming call authority', async (t) => {
  const cases = [
    ['central-pause', 'central_pause', ({ database }) => database.prepare(`UPDATE
      deal_hunter_cim_safety_settings SET outreach_paused = 1 WHERE id = 'global'`).run()],
    ['watch', 'owner_intent_changed', ({ database, authority }) => database.prepare(`INSERT INTO
      deal_hunter_owner_decision_events (id, idempotency_key, request_digest, opportunity_id,
        action, actor, expected_discovery_revision, expected_material_revision,
        observed_discovery_revision, observed_material_revision, policy_version, created_at)
      VALUES (?, ?, ?, ?, 'watch', 'fixture-owner', 0, 0, 0, 0, 'owner-decision-v1', ?)`)
      .run(`decision-watch-${authority.touchId}`, `idem-watch-${authority.touchId}`, digest('4'),
        authority.opportunityId, '2026-09-25T19:00:01.000Z')],
    ['archive', 'crm_owner_changed', ({ database, authority }) => database.prepare(`UPDATE
      contact_submissions SET archived_at = ?, archived_by = 'fixture-owner',
      archive_reason = 'test' WHERE deal_hunter_opportunity_id = ?`).run(at, authority.opportunityId)],
    ['suppression', 'recipient_suppressed', ({ database }) => database.prepare(`INSERT INTO
      email_suppressions (id, normalized_email, reason, source, created_at, created_by)
      VALUES ('p6a-suppression', 'broker@example.test', 'admin-block', 'fixture', ?, 'fixture-owner')`).run(at)],
    ['identity', 'identity_authority_changed', ({ database, authority }) => database.prepare(`INSERT INTO
      deal_hunter_identity_exceptions (id, created_at, updated_at, status,
        candidate_opportunity_ids, reason, evidence_version)
      VALUES (?, ?, ?, 'open', ?, 'synthetic ambiguity', 'identity-v1')`)
      .run(`identity-${authority.touchId}`, at, at, JSON.stringify([authority.opportunityId]))],
    ['recipient', 'recipient_authority_changed', ({ database, authority }) => database.prepare(`UPDATE
      deal_hunter_cim_campaigns SET recipient_fingerprint = ? WHERE id = ?`)
      .run(digest('7'), authority.campaignId)],
    ['timezone', 'timezone_changed', ({ database, authority }) => database.prepare(`INSERT INTO
      deal_hunter_opportunity_timezone_revisions (opportunity_id, revision, state, iana_timezone,
        evidence_type, evidence_id, evidence_digest, resolver_version, dataset_digest, actor, created_at)
      VALUES (?, 2, 'verified', 'America/New_York', 'operator-verified', ?, ?,
        'explicit-v1', ?, 'fixture-owner', ?)`)
      .run(authority.opportunityId, `timezone-2-${authority.touchId}`, digest('5'), digest('6'), at)],
    ['source-absence', 'source_authority_unavailable', ({ database, authority }) => database.prepare(`DELETE
      FROM deal_hunter_opportunity_source_observations WHERE opportunity_id = ?`)
      .run(authority.opportunityId)],
    ['discovery-pending', 'freshness_changed', ({ database, authority }) => database.prepare(`UPDATE
      deal_hunter_opportunities SET discovery_state = 'pending' WHERE opportunity_id = ?`)
      .run(authority.opportunityId)],
    ['material-revision', 'freshness_changed', ({ database, authority }) => database.prepare(`UPDATE
      deal_hunter_opportunities SET material_revision = material_revision + 1 WHERE opportunity_id = ?`)
      .run(authority.opportunityId)],
    ['permission', 'permission_changed', ({ database, authority }) => database.prepare(`UPDATE
      deal_hunter_cim_campaigns SET permission_revision = permission_revision + 1 WHERE id = ?`)
      .run(authority.campaignId)],
    ['materials', 'materials_received', ({ database, authority }) => database.prepare(`UPDATE
      contact_submissions SET prospectus_url = 'https://example.test/prospectus'
      WHERE deal_hunter_opportunity_id = ?`).run(authority.opportunityId)],
    ['materials-metadata', 'materials_received', ({ database, authority }) => database.prepare(`UPDATE
      contact_submissions SET metadata = ? WHERE deal_hunter_opportunity_id = ?`)
      .run(JSON.stringify({ diligence: { stage: 'financial-review', checklist: { cim: true } } }),
        authority.opportunityId)],
    ['materials-upload-request', 'materials_received', ({ database, authority }) => database.prepare(`INSERT INTO
      secure_upload_requests (id, submission_id, created_at, updated_at, email, status,
        expires_at, requested_documents)
      VALUES (?, ?, ?, ?, 'broker@example.test', 'documents-received', ?, ?)`)
      .run(`gate-upload-${authority.touchId}`, `submission-${authority.touchId.slice(6)}`,
        at, at, '2026-09-26T19:00:00.000Z', JSON.stringify(['cim']))],
    ['prior-request', 'lifecycle_conflict', ({ database, authority }) => database.prepare(`INSERT INTO
      deal_hunter_cim_requests (id, created_at, updated_at, deal_key, recipient_email,
        status, opportunity_id, metadata)
      VALUES (?, ?, ?, ?, 'broker@example.test', 'pending', ?, '{}')`)
      .run(`prior-request-${authority.touchId}`, at, at, `deal:${authority.opportunityId}`,
        authority.opportunityId)],
    ['reply', 'reply_received', ({ database, authority }) => database.prepare(`INSERT INTO
      crm_communications (id, submission_id, opportunity_id, direction, channel, source,
        thread_key, occurred_at, created_at, updated_at)
      VALUES (?, ?, ?, 'inbound', 'email', 'synthetic-reply', ?, ?, ?, ?)`)
      .run(`reply-${authority.touchId}`, `submission-${authority.touchId.slice(6)}`,
        authority.opportunityId, `thread-${authority.touchId.slice(6)}`, at, at, at)],
    ['communication-body', 'payload_changed', ({ database, prepared }) => database.prepare(`UPDATE
      crm_communications SET body_text = 'tampered' WHERE id = ?`).run(prepared.communication_id)],
    ['outbox-attempt', 'outbox_changed', ({ database, prepared }) => database.prepare(`UPDATE
      crm_email_outbox SET attempt_count = 1 WHERE id = ?`).run(prepared.outbox_id)],
    ['membership', 'membership_changed', ({ database, prepared }) => database.prepare(`UPDATE
      deal_hunter_cim_transmission_touches SET cancelled_at = ?, cancellation_reason = 'test'
      WHERE transmission_id = ?`).run(at, prepared.id)],
  ];
  for (const [name, reason, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createFinalGateFixture(subtest, `p6a-${name}`);
      mutate(fixture);
      const result = await fixture.gate();
      assert.equal(result.authorized, false, JSON.stringify(result));
      assert.equal(result.blockedReason, reason);
      assert.equal(Object.hasOwn(result, 'boundaryNonce'), false);
      const transmission = fixture.database.prepare(`SELECT * FROM deal_hunter_cim_transmissions
        WHERE id = ?`).get(fixture.prepared.id);
      assert.equal(transmission.state, 'prepared');
      assert.equal(transmission.invocation_authority_count, 0);
      assert.equal(transmission.provider_seam_entered_at, null);
      assert.equal(fixture.database.prepare(`SELECT consumed_at FROM
        deal_hunter_cim_live_provider_authorizations WHERE id = ?`)
        .get(fixture.authorization.id).consumed_at, null);
      const audit = fixture.database.prepare(`SELECT reason_code, authority_digest, metadata
        FROM deal_hunter_cim_audit_events WHERE event_type = 'final-gate-blocked'
        ORDER BY occurred_at DESC LIMIT 1`).get();
      assert.equal(audit.reason_code, reason);
      assert.match(audit.authority_digest, /^[0-9a-f]{64}$/);
      assert.equal(audit.metadata, '{}');
    });
  }
});

test('P6A final gate enforces fresh Broker Materials preparation blockers', async (t) => {
  for (const [name, authorityPatch, reason] of [
    ['bounded-authority', { preparationBlockers: [{ code: 'broker_materials_authority_unavailable' }] },
      'source_authority_unavailable'],
    ['noncurrent-pursue', { pursued: false, currentDispositionState: 'dismissed',
      preparationBlockers: [{ code: 'opportunity_passed' }] }, 'owner_intent_changed'],
    ['prior-request-evidence', { existingRequest: { id: 'legacy-request' },
      preparationBlockers: [{ code: 'existing_request' }] }, 'lifecycle_conflict'],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createFinalGateFixture(subtest, `p6a-loader-${name}`);
      const result = await fixture.gate({ loadMemberAuthority: async () => ({
        opportunityId: fixture.authority.opportunityId,
        recipientOptions: [fixture.recipient],
        materialsState: { materialsReceived: false, advancedBeyondBrokerOutreach: false,
          evidenceCodes: [] }, preparationBlockers: [], suppression: null,
        terminalReason: '', existingRequest: null, opportunityClaim: null,
        currentDispositionState: 'pursued', pursued: true,
        ...authorityPatch,
      }) });
      assert.equal(result.authorized, false, JSON.stringify(result));
      assert.equal(result.blockedReason, reason);
      assert.equal(result.reconciliationOnly, false);
      assert.equal(Object.hasOwn(result, 'boundaryNonce'), false);
    });
  }
});

test('P5 process restart replays exact payload and conflicts on material send fields', async (t) => {
  const { storage, database, authority, prepared, prepareCommand } =
    await createPreparedFixture(t, 'p5-replay');
  const other = insertBaseAuthority(database, '-p5-replay-z');
  const replay = await transitionFromWorker(database.name, 'pre-provider-transition', {
    method: 'prepareCimTransmission', payload: prepareCommand,
  });
  assert.equal(replay.existing, true);
  for (const changed of [
    { bodyText: 'Changed body' },
    { toAddresses: ['other@example.test'] },
    { replyToAddress: 'other-reply@example.test' },
    { tags: ['changed=cim'] },
    { touchIds: [authority.touchId, other.touchId] },
  ]) {
    const outcome = await storage.prepareCimTransmission({ ...prepareCommand, ...changed });
    assert.equal(outcome.payloadConflict, true, JSON.stringify(changed));
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmission_touches WHERE cancelled_at IS NULL').get().n, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM crm_communications').get().n, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM crm_email_outbox').get().n, 1);
  assert.equal(database.prepare('SELECT payload_digest FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id).payload_digest, prepared.payload_digest);
});

test('P5 claim lease cannot reclaim a touch with retained immutable history', async (t) => {
  const { storage, database, authority, prepared } =
    await createPreparedFixture(t, 'p5-history');
  database.prepare(`UPDATE deal_hunter_cim_transmission_touches
    SET cancelled_at = ?, cancellation_reason = 'synthetic-pre-provider-cancel'
    WHERE transmission_id = ?`).run(at, prepared.id);
  database.prepare(`UPDATE deal_hunter_cim_transmissions
    SET state = 'cancelled-before-provider' WHERE id = ?`).run(prepared.id);
  database.prepare(`UPDATE deal_hunter_cim_campaign_touches
    SET transmission_id = NULL, claim_expires_at = ?, row_version = row_version + 1
    WHERE id = ?`).run('2026-09-25T19:01:00.000Z', authority.touchId);
  const result = await storage.claimDueCimTouch({ touchId: authority.touchId,
    expectedRowVersion: 3, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: digest('b'),
    claimOwner: 'reclaimer', claimExpiresAt: '2026-09-25T19:10:00.000Z',
    now: '2026-09-25T19:02:00.000Z' });
  assert.equal(result.conflict, true);
  assert.equal(database.prepare('SELECT claim_token_digest FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).claim_token_digest, digest('a'));
});

test('P5 crash before claim commit leaves no durable claim', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-p5-claim-rollback');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-p5-claim-rollback');
  await seedSyntheticActivationChain(storage);
  database.exec(`CREATE TRIGGER p5_fail_claim_audit
    BEFORE INSERT ON deal_hunter_cim_audit_events
    WHEN NEW.event_type = 'touch-claimed'
    BEGIN SELECT RAISE(ABORT, 'synthetic claim commit loss'); END`);
  await assert.rejects(storage.claimDueCimTouch({ touchId: authority.touchId,
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: digest('a'),
    claimOwner: 'worker', claimExpiresAt: '2026-09-25T19:05:00.000Z', now: at }),
  /synthetic claim commit loss/);
  const touch = database.prepare('SELECT * FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId);
  assert.equal(touch.state, 'scheduled');
  assert.equal(touch.claim_token_digest, null);
  assert.equal(touch.row_version, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM deal_hunter_cim_audit_events WHERE event_type='touch-claimed'").get().n, 0);
});

test('P5 payload construction crash leaves a reclaimable claim and no preparation', async (t) => {
  const { runDueCimInitialPreparations } = await import('../server/services/pursueCimInitialPreparation.js');
  const sqlitePath = temporaryPath(t, 'pursue-cim-p5-build-crash');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const opportunityId = 'opp-p1a-p5-build-crash';
  const recipient = { email: 'broker@example.test', displayName: 'Broker',
    firstName: 'Avery', provenance: 'operator_verified',
    provenanceFingerprint: digest('d'), contactAuthorityRevision: digest('c') };
  const fingerprint = sha256(stableCanonicalJson({ opportunityId,
    emailHash: sha256(recipient.email),
    provenanceFingerprint: recipient.provenanceFingerprint,
    contactAuthorityRevision: recipient.contactAuthorityRevision }));
  const authority = insertBaseAuthority(database, '-p5-build-crash', fingerprint);
  seedCrmOwner(database, authority.opportunityId, 'submission-p5-build-crash');
  await seedSyntheticActivationChain(storage);
  const crashed = await runDueCimInitialPreparations({ storage, now: at,
    loadAuthority: async () => { throw new Error('synthetic payload construction crash'); } });
  assert.equal(crashed[0].constructionFailed, true);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'claimed');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 0);
  const recovered = await runDueCimInitialPreparations({ storage,
    now: '2026-09-25T19:06:00.000Z',
    loadAuthority: async () => ({ opportunityId,
      opportunity: { canonical_name: 'Synthetic Service Co', canonical_location: 'California' },
      score: { deal_key: 'synthetic-service', fit_score: 85 },
      sourceRows: [], preparationBlockers: [],
      submission: { id: 'submission-p5-build-crash' }, recipientOptions: [recipient],
    }) });
  assert.equal(recovered[0].prepared, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 1);
});

test('P5 runner rejects a non-initial selector result before claim', async () => {
  const { runDueCimInitialPreparations } = await import('../server/services/pursueCimInitialPreparation.js');
  let claimCalls = 0;
  await assert.rejects(runDueCimInitialPreparations({ storage: {
    async listDueCimInitialTouches() { return [{ kind: 'follow-up-1', touch_id: 'synthetic-followup' }]; },
    async claimDueCimTouch() { claimCalls += 1; },
    async prepareCimTransmission() { throw new Error('unreachable'); },
  }, now: at }), /Non-initial CIM touch/);
  assert.equal(claimCalls, 0);
});

test('P5 failure inside preparation rolls back communication, outbox, membership, and binding', async (t) => {
  const { storage, database, authority, prepared, prepareCommand } =
    await createPreparedFixture(t, 'p5-rollback');
  database.exec(`CREATE TRIGGER p5_fail_new_transmission
    BEFORE INSERT ON deal_hunter_cim_transmissions
    WHEN NEW.preparation_generation = 2
    BEGIN SELECT RAISE(ABORT, 'synthetic P5 preparation failure'); END`);
  await assert.rejects(storage.prepareCimTransmission({ ...prepareCommand,
    preparationGeneration: 2, bodyText: 'Changed body' }),
  /synthetic P5 preparation failure/);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM crm_communications').get().n, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM crm_email_outbox').get().n, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmission_touches WHERE cancelled_at IS NULL').get().n, 1);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id).state, 'prepared');
  assert.equal(database.prepare('SELECT transmission_id FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).transmission_id, prepared.id);
  database.exec('DROP TRIGGER p5_fail_new_transmission');
});

test('P5 stale claim cannot cancel a prepared transmission during generation rebuild', async (t) => {
  const { storage, database, authority, prepared, prepareCommand } =
    await createPreparedFixture(t, 'p5-stale-rebuild');
  const attempt = await storage.prepareCimTransmission({ ...prepareCommand,
    claimTokenDigest: digest('b'), preparationGeneration: 2,
    bodyText: 'Unapproved replacement' });
  assert.equal(attempt.prepared, false);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id).state, 'prepared');
  assert.equal(database.prepare('SELECT cancelled_at FROM deal_hunter_cim_transmission_touches WHERE transmission_id = ?')
    .get(prepared.id).cancelled_at, null);
  assert.equal(database.prepare('SELECT transmission_id FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).transmission_id, prepared.id);
  assert.equal(database.prepare('SELECT state FROM crm_email_outbox WHERE id = ?')
    .get(prepared.outbox_id).state, 'prepared');
});

test('P5 preparation identity is touch-specific across campaigns', async (t) => {
  const first = await createPreparedFixture(t, 'p5-identity-a');
  const second = await createPreparedFixture(t, 'p5-identity-b');
  for (const field of ['id', 'provider_idempotency_key', 'communication_id', 'outbox_id']) {
    assert.notEqual(first.prepared[field], second.prepared[field], field);
  }
  assert.equal(first.prepared.payload_digest === second.prepared.payload_digest, false,
    'membership is part of each immutable payload digest');
  assert.equal(first.database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmission_touches').get().n, 1);
  assert.equal(second.database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmission_touches').get().n, 1);
});

test('P1B live authorization binds one exact persisted transmission and rejects duplicates', async (t) => {
  const { storage, database, prepared } = await createPreparedFixture(t, 'authorization');
  const command = { id: 'live-authorization-1', activationId: 'synthetic-fl04b-initial',
    capability: 'fl04b-initial', writerPath: 'pursue-cim-initial',
    transmissionId: prepared.id, payloadDigest: prepared.payload_digest,
    recipientAuthorityDigest: digest('e'), providerProfile: 'synthetic-provider',
    expiresAt: '2026-09-25T20:00:00.000Z', actor: 'fixture-owner',
    reason: 'synthetic test envelope', now: at };
  const first = await storage.issueCimLiveProviderAuthorization(command);
  assert.equal(first.issued, true);
  assert.equal(first.authorization.maximum_calls, 1);
  assert.equal((await storage.issueCimLiveProviderAuthorization(command)).replay, true);
  assert.equal((await storage.issueCimLiveProviderAuthorization({ ...command, payloadDigest: digest('f') })).conflict, true);
  assert.equal((await storage.issueCimLiveProviderAuthorization({ ...command, id: 'live-authorization-2' })).blockedReason,
    'authorization_exists');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_live_provider_authorizations').get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'live-authorization-issued'").get().count, 1);
});

test('P1B provider-pending consumes one authorization and is never retryable', async (t) => {
  const { database, authority, authorization, gate } =
    await createFinalGateFixture(t, 'provider-pending');
  const first = await gate();
  assert.equal(first.authorized, true);
  assert.equal(first.transmission.state, 'provider-pending');
  assert.equal(first.transmission.invocation_authority_count, 1);
  assert.equal(Object.hasOwn(first, 'ephemeralBoundaryToken'), false);
  assert.equal((await gate()).authorized, false);
  assert.equal(database.prepare('SELECT consumed_at FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?')
    .get(authorization.id).consumed_at, at);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?').get(authority.touchId).state,
    'provider-pending');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'provider-pending'").get().count, 1);
});

test('P1B provider seam admits one CAS winner and rechecks durable pause', async (t) => {
  const { storage, database, prepared, authorization, gate } =
    await createFinalGateFixture(t, 'seam');
  const pending = await gate();
  assert.equal(pending.authorized, true);
  const nonceDigest = sha256(pending.boundaryNonce);
  const command = { transmissionId: prepared.id, authorizationId: authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    capability: 'fl04b-initial', payloadDigest: prepared.payload_digest,
    boundaryNonceDigest: nonceDigest, expectedRowVersion: 2, actor: 'fixture-owner', now: at };
  database.prepare("UPDATE deal_hunter_cim_safety_settings SET outreach_paused = 1 WHERE id = 'global'").run();
  assert.equal((await storage.enterCimProviderSeam(command)).unauthorized, true);
  database.prepare("UPDATE deal_hunter_cim_safety_settings SET outreach_paused = 0 WHERE id = 'global'").run();
  assert.equal((await storage.enterCimProviderSeam({ ...command, payloadDigest: digest('f') })).unauthorized, true);
  assert.equal((await storage.enterCimProviderSeam(command)).entered, true);
  assert.equal((await storage.enterCimProviderSeam(command)).alreadyEntered, true);
  assert.equal((await storage.enterCimProviderSeam({ ...command, boundaryNonceDigest: digest('c') })).unauthorized, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'provider-seam-entered'").get().count, 1);
});

async function createProviderPendingFixture(t, suffix) {
  const fixture = await createFinalGateFixture(t, suffix);
  const pending = await fixture.gate();
  assert.equal(pending.authorized, true);
  return { ...fixture, pending: pending.transmission,
    boundaryNonceDigest: sha256(pending.boundaryNonce) };
}

test('P6D scenario 43 accepted finalization anchors and creates one dormant next slot', async (t) => {
  const { storage, database, authority, authorization, pending, boundaryNonceDigest } =
    await createProviderPendingFixture(t, 'finalize');
  assert.equal((await storage.enterCimProviderSeam({ transmissionId: pending.id,
    authorizationId: authorization.id, writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', capability: 'fl04b-initial',
    payloadDigest: pending.payload_digest, boundaryNonceDigest,
    expectedRowVersion: 2, actor: 'fixture-owner', now: at })).entered, true);
  const observedAt = '2026-09-25T19:00:07.000Z';
  const command = { transmissionId: pending.id, payloadDigest: pending.payload_digest,
    expectedRowVersion: 3,
    outcome: 'accepted', provider: 'resend', providerMessageId: 'provider-message-1',
    providerResultCode: 'accepted', observedAt,
    actor: 'fixture-owner', now: at,
    cadence: await acceptedCadence(storage, pending.id, observedAt) };
  await assert.rejects(storage.finalizeCimTransmission({ ...command,
    cadence: { ...command.cadence, nextTouch: { ...command.cadence.nextTouch,
      dueAt: '2026-09-28T12:00:01.000Z' } } }), /cadence/i);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(pending.id).state, 'provider-pending');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches')
    .get().count, 1);
  const first = await storage.finalizeCimTransmission(command);
  assert.equal(first.applied, true);
  assert.equal(first.transmission.state, 'accepted');
  assert.equal(first.nextTouch.kind, 'follow-up-1');
  const replay = await storage.finalizeCimTransmission(command);
  assert.equal(replay.existing, true);
  assert.equal(replay.nextTouch.id, first.nextTouch.id);
  assert.equal((await storage.finalizeCimTransmission({ ...command,
    providerMessageId: 'provider-message-2' })).conflict, true);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'accepted');
  const campaign = database.prepare(`SELECT state, initial_accepted_at, local_expiry_at
    FROM deal_hunter_cim_campaigns WHERE id = ?`).get(authority.campaignId);
  assert.equal(campaign.state, 'active-follow-up');
  assert.equal(campaign.initial_accepted_at, '2026-09-25T19:00:07.000Z');
  assert.equal(campaign.local_expiry_at, '2026-10-16T19:00:07.000Z');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 2);
  database.prepare('UPDATE deal_hunter_cim_campaigns SET local_expiry_at = ? WHERE id = ?')
    .run(first.nextTouch.due_at, authority.campaignId);
  assert.equal((await storage.claimDueCimTouch({ touchId: first.nextTouch.id,
    expectedRowVersion: first.nextTouch.row_version,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest: digest('6'), claimOwner: 'expiry-proof',
    claimExpiresAt: '2026-09-28T13:00:00.000Z', now: first.nextTouch.due_at })).terminal, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'transmission-finalized'").get().count, 1);
});

test('P6D SQLite persists follow-up-1/2/3 and weekday progression without activation', async (t) => {
  const { storage, database, authority, authorization, pending, boundaryNonceDigest } =
    await createProviderPendingFixture(t, 'durable-chain');
  assert.equal((await storage.enterCimProviderSeam({ transmissionId: pending.id,
    authorizationId: authorization.id, writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', capability: 'fl04b-initial',
    payloadDigest: pending.payload_digest, boundaryNonceDigest,
    expectedRowVersion: 2, actor: 'fixture-owner', now: at })).entered, true);
  const initialObservedAt = '2026-09-25T19:00:07.000Z';
  const initial = await storage.finalizeCimTransmission({ transmissionId: pending.id,
    payloadDigest: pending.payload_digest, expectedRowVersion: 3, outcome: 'accepted',
    provider: 'resend', providerMessageId: 'p6d-chain-provider-initial',
    providerResultCode: 'accepted', observedAt: initialObservedAt,
    actor: 'fixture-owner', now: at,
    cadence: await acceptedCadence(storage, pending.id, initialObservedAt) });
  const expectedKinds = ['follow-up-1', 'follow-up-2', 'follow-up-3',
    'weekday-follow-up'];
  const observedAt = [initial.nextTouch.due_at, '2026-10-01T15:00:07.000Z',
    '2026-10-05T15:00:07.000Z', '2026-10-16T18:59:00.000Z'];
  let current = initial.nextTouch;
  for (const [index, expectedKind] of expectedKinds.entries()) {
    assert.equal(current.kind, expectedKind);
    assert.equal(current.state, 'scheduled', 'P6D leaves every derived slot dormant');
    const transmission = primeDormantTouchForOutcome(database, pending.id,
      current.id, index + 1, observedAt[index]);
    const cadence = await acceptedCadence(storage, transmission.id, observedAt[index]);
    const outcome = await storage.finalizeCimTransmission({ transmissionId: transmission.id,
      payloadDigest: transmission.payload_digest, expectedRowVersion: 3,
      outcome: 'accepted', provider: 'resend',
      providerMessageId: `p6d-chain-provider-${index + 1}`,
      providerResultCode: 'accepted', observedAt: observedAt[index],
      actor: 'fixture-owner', now: observedAt[index], cadence });
    assert.equal(outcome.applied, true);
    current = outcome.nextTouch;
  }
  assert.equal(current, null, 'the next weekday slot cannot cross the local expiry');
  assert.deepEqual(database.prepare(`SELECT kind FROM deal_hunter_cim_campaign_touches
    WHERE campaign_id=? ORDER BY ordinal`).all(authority.campaignId).map(({ kind }) => kind),
  ['initial', 'follow-up-1', 'follow-up-2', 'follow-up-3', 'weekday-follow-up']);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events
    WHERE campaign_id=? AND event_type='touch-created'`).get(authority.campaignId).count, 4);
  assert.equal(database.prepare(`SELECT local_expiry_at FROM deal_hunter_cim_campaigns
    WHERE id=?`).get(authority.campaignId).local_expiry_at, '2026-10-16T19:00:07.000Z');
});

test('P6D exact reconciliation resolves ambiguity and creates one dormant next slot', async (t) => {
  const { storage, database, authority, authorization, pending, boundaryNonceDigest } =
    await createProviderPendingFixture(t, 'reconcile');
  assert.equal((await storage.enterCimProviderSeam({ transmissionId: pending.id,
    authorizationId: authorization.id, writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', capability: 'fl04b-initial',
    payloadDigest: pending.payload_digest, boundaryNonceDigest,
    expectedRowVersion: 2, actor: 'fixture-owner', now: at })).entered, true);
  const ambiguous = await storage.finalizeCimTransmission({ transmissionId: pending.id,
    payloadDigest: pending.payload_digest,
    expectedRowVersion: 3, outcome: 'ambiguous', provider: 'resend',
    providerResultCode: 'response-lost', actor: 'fixture-owner', now: at });
  assert.equal(ambiguous.applied, true);
  const containedConversation = database.prepare(`SELECT state, terminal_revision
    FROM deal_hunter_broker_conversations WHERE id = ?`).get(authority.conversationId);
  assert.equal(containedConversation.state, 'provider-ambiguous');
  assert.equal(containedConversation.terminal_revision, 1);
  const command = { transmissionId: pending.id, payloadDigest: pending.payload_digest,
    expectedRowVersion: 4,
    outcome: 'accepted', provider: 'resend', providerMessageId: 'reconciled-provider-message',
    providerResultCode: 'signed-webhook-accepted', evidenceType: 'signed-webhook',
    evidenceId: 'webhook-1', evidenceDigest: digest('f'), actor: 'fixture-owner', now: at,
    cadence: await acceptedCadence(storage, pending.id, at) };
  const first = await storage.reconcileCimTransmission(command);
  assert.equal(first.applied, true);
  assert.equal(first.transmission.state, 'accepted');
  assert.equal((await storage.reconcileCimTransmission(command)).unchanged, true);
  assert.equal((await storage.reconcileCimTransmission({ ...command,
    providerMessageId: 'different-message' })).conflict, true);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaigns WHERE id = ?').get(authority.campaignId).state,
    'active-follow-up');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_broker_conversations WHERE id = ?')
    .get(authority.conversationId).state, 'open');
  assert.equal(first.nextTouch.kind, 'follow-up-1');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 2);
  assert.equal(database.prepare('SELECT invocation_authority_count FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(pending.id).invocation_authority_count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'transmission-reconciled'").get().count, 1);
});

test('P6C reconciliation evidence identity replays exactly and conflicts on digest drift', async (t) => {
  const { storage, database, authority, pending } =
    await createProviderPendingFixture(t, 'reconciliation-evidence');
  const command = { transmissionId: pending.id, payloadDigest: pending.payload_digest,
    expectedRowVersion: 2,
    outcome: 'ambiguous', provider: 'resend', providerResultCode: 'multiple-provider-identities',
    evidenceType: 'provider-read', evidenceId: 'provider-read-1', evidenceDigest: digest('1'),
    observedAt: '2026-09-25T19:01:00.000Z', actor: 'fixture-owner', now: at,
    providerIdentities: [
      { provider: 'resend', providerMessageId: 'provider-a', evidenceId: 'candidate-a',
        evidenceDigest: digest('2') },
      { provider: 'resend', providerMessageId: 'provider-b', evidenceId: 'candidate-b',
        evidenceDigest: digest('3') },
    ] };
  const first = await storage.reconcileCimTransmission(command);
  assert.equal(first.applied, true);
  assert.equal(first.transmission.state, 'ambiguous');
  assert.equal((await storage.reconcileCimTransmission(command)).unchanged, true);
  assert.equal((await storage.reconcileCimTransmission({ ...command,
    observedAt: '2026-09-25T19:02:00.000Z' })).conflict, true);
  assert.equal((await storage.reconcileCimTransmission({ ...command,
    providerIdentities: command.providerIdentities.map((identity, index) => index === 0
      ? { ...identity, evidenceId: 'changed-candidate' } : identity) })).conflict, true);
  assert.equal((await storage.reconcileCimTransmission({ ...command,
    evidenceDigest: digest('4') })).conflict, true);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_broker_conversations WHERE id = ?')
    .get(authority.conversationId).state, 'provider-ambiguous');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'transmission-reconciled'")
    .get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'provider-identity-conflict'")
    .get().count, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches')
    .get().count, 1);
});

test('P6C direct acceptance rejects a non-Resend provider and invalid provider identity', async (t) => {
  const { storage, database, authorization, pending, boundaryNonceDigest } =
    await createProviderPendingFixture(t, 'accepted-identity-validation');
  assert.equal((await storage.enterCimProviderSeam({ transmissionId: pending.id,
    authorizationId: authorization.id, writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', capability: 'fl04b-initial',
    payloadDigest: pending.payload_digest, boundaryNonceDigest,
    expectedRowVersion: 2, actor: 'fixture-owner', now: at })).entered, true);
  const base = { transmissionId: pending.id, payloadDigest: pending.payload_digest,
    expectedRowVersion: 3,
    outcome: 'accepted', provider: 'resend', providerMessageId: 'valid-provider-id',
    providerResultCode: 'accepted', actor: 'fixture-owner', now: at };
  for (const command of [
    { ...base, provider: 'smtp' },
    { ...base, providerMessageId: '   ' },
    { ...base, providerMessageId: 42 },
    { ...base, providerMessageId: 'x'.repeat(241) },
  ]) {
    await assert.rejects(storage.finalizeCimTransmission(command));
  }
  assert.equal((await storage.finalizeCimTransmission({ ...base,
    payloadDigest: digest('9') })).conflict, true);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(pending.id).state, 'provider-pending');
});

test('P6C scenario 48 definitive rejection terminalizes the slot without retry authority', async (t) => {
  const { storage, database, authority, authorization, pending, boundaryNonceDigest } =
    await createProviderPendingFixture(t, 'definitive-failure');
  assert.equal((await storage.enterCimProviderSeam({ transmissionId: pending.id,
    authorizationId: authorization.id, writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', capability: 'fl04b-initial',
    payloadDigest: pending.payload_digest, boundaryNonceDigest,
    expectedRowVersion: 2, actor: 'fixture-owner', now: at })).entered, true);

  const command = { transmissionId: pending.id, payloadDigest: pending.payload_digest,
    expectedRowVersion: 3,
    outcome: 'definitive-failure', provider: 'resend', providerResultCode: 'provider-rejected',
    actor: 'fixture-owner', now: at };
  const first = await storage.finalizeCimTransmission(command);
  assert.equal(first.applied, true);
  assert.equal(first.nextTouch, null);
  assert.equal((await storage.finalizeCimTransmission(command)).existing, true);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'definitive-failure');
  assert.deepEqual(database.prepare(`SELECT state, reason_code FROM deal_hunter_cim_campaigns
    WHERE id = ?`).get(authority.campaignId), {
    state: 'action-required', reason_code: 'provider_definitive_failure',
  });
  assert.equal(database.prepare('SELECT attempt_count FROM crm_email_outbox WHERE id = ?')
    .get(pending.outbox_id).attempt_count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 1);
  assert.equal(database.prepare('SELECT invocation_authority_count FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(pending.id).invocation_authority_count, 1);
});

test('P6C later exact evidence confirms an already accepted identity despite a different result code', async (t) => {
  const { storage, database, authorization, pending, boundaryNonceDigest } =
    await createProviderPendingFixture(t, 'accepted-later-evidence');
  assert.equal((await storage.enterCimProviderSeam({ transmissionId: pending.id,
    authorizationId: authorization.id, writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', capability: 'fl04b-initial',
    payloadDigest: pending.payload_digest, boundaryNonceDigest,
    expectedRowVersion: 2, actor: 'fixture-owner', now: at })).entered, true);
  assert.equal((await storage.finalizeCimTransmission({ transmissionId: pending.id,
    payloadDigest: pending.payload_digest, expectedRowVersion: 3, outcome: 'accepted',
    provider: 'resend', providerMessageId: 'accepted-provider-id',
    providerResultCode: 'accepted', observedAt: at, actor: 'fixture-owner', now: at,
    cadence: await acceptedCadence(storage, pending.id, at) })).applied, true);
  const confirmation = await storage.reconcileCimTransmission({ transmissionId: pending.id,
    payloadDigest: pending.payload_digest, expectedRowVersion: 4, outcome: 'accepted',
    provider: 'resend', providerMessageId: 'accepted-provider-id',
    providerResultCode: 'reconciled-accepted', evidenceType: 'provider-read',
    evidenceId: 'later-confirmation', evidenceDigest: digest('8'),
    observedAt: '2026-09-25T19:03:00.000Z', actor: 'fixture-owner', now: at });
  assert.equal(confirmation.unchanged, true);
  assert.equal(confirmation.conflict, false);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events
    WHERE event_type = 'transmission-reconciled' AND transmission_id = ?`).get(pending.id).count, 1);
});

test('P1B projection reads current authority without mutating storage', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-projection');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, '-projection');
  const before = database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events').get().count;
  const projection = await storage.readPursueCimProjection({ opportunityId: authority.opportunityId });
  assert.equal(projection.decision.id, authority.decisionId);
  assert.equal(projection.enrollment.id, authority.enrollmentId);
  assert.equal(projection.campaign.id, authority.campaignId);
  assert.equal(projection.initialTouch.id, authority.touchId);
  assert.equal(projection.transmission, null);
  assert.deepEqual(projection.actions, []);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events').get().count, before);
});

test('P1B audit insertion failure rolls back owner authority and claim state', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-audit-rollback');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-rollback');
  database.exec(`CREATE TRIGGER reject_owner_audit BEFORE INSERT ON deal_hunter_cim_audit_events
    WHEN NEW.event_type = 'owner-decision' BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`);
  await assert.rejects(storage.recordOwnerDecision({ opportunityId: 'opp-rollback', action: 'pursue',
    idempotencyKey: 'rollback-key', expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
    actor: 'fixture-owner', policyVersion: 'owner-decision-v1', now: at }), /injected audit failure/);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_owner_decision_events').get().n, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_pursuit_enrollments').get().n, 0);
  database.exec('DROP TRIGGER reject_owner_audit');
  const authority = insertBaseAuthority(database, '-rollback');
  await seedSyntheticActivationChain(storage);
  database.exec(`CREATE TRIGGER reject_claim_audit BEFORE INSERT ON deal_hunter_cim_audit_events
    WHEN NEW.event_type = 'touch-claimed' BEGIN SELECT RAISE(ABORT, 'injected claim audit failure'); END`);
  await assert.rejects(storage.claimDueCimTouch({ touchId: authority.touchId,
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: digest('a'),
    claimOwner: 'worker-1', claimExpiresAt: '2026-09-25T19:10:00.000Z', now: at }),
  /injected claim audit failure/);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'scheduled');
});

test('P1B capability and live authorization withdrawal are terminal and audited', async (t) => {
  const { storage, database, prepared } = await createPreparedFixture(t, 'withdraw');
  const issued = await storage.issueCimLiveProviderAuthorization({ id: 'withdraw-auth',
    activationId: 'synthetic-fl04b-initial', capability: 'fl04b-initial',
    writerPath: 'synthetic-writer', transmissionId: prepared.id,
    payloadDigest: prepared.payload_digest, recipientAuthorityDigest: digest('e'),
    providerProfile: 'synthetic-provider', expiresAt: '2026-09-25T20:00:00.000Z',
    actor: 'fixture-owner', reason: 'synthetic hold', now: at });
  assert.equal(issued.issued, true);
  const withdrawn = await storage.withdrawCimLiveProviderAuthorization({
    id: 'withdraw-auth', actor: 'fixture-owner', reason: 'synthetic withdrawal', now: at });
  assert.equal(withdrawn.applied, true);
  assert.equal((await storage.withdrawCimLiveProviderAuthorization({
    id: 'withdraw-auth', actor: 'fixture-owner', reason: 'synthetic withdrawal', now: at })).replay, true);
  assert.equal(database.prepare('SELECT withdrawn_at FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?')
    .get('withdraw-auth').withdrawn_at, at);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id).state, 'cancelled-before-provider');
  const activation = await storage.withdrawCimCapabilityActivation({
    id: 'synthetic-fl04b-initial', actor: 'fixture-owner', reason: 'synthetic withdrawal', now: at });
  assert.equal(activation.applied, true);
  assert.equal((await storage.withdrawCimCapabilityActivation({
    id: 'synthetic-fl04b-initial', actor: 'fixture-owner', reason: 'synthetic withdrawal', now: at })).replay, true);
  assert.equal(database.prepare('SELECT status FROM deal_hunter_cim_capability_activations WHERE id = ?')
    .get('synthetic-fl04b-initial').status, 'withdrawn');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM deal_hunter_cim_audit_events WHERE event_type IN ('authorization-withdrawn', 'capability-withdrawn')")
    .get().n, 2);
});

test('P1B changed prepared copy cancels retained identity and allocates the next generation', async (t) => {
  const { storage, database, authority, prepared, prepareCommand } =
    await createPreparedFixture(t, 'reprepare');
  const next = await storage.prepareCimTransmission({ ...prepareCommand,
    preparationGeneration: 2, bodyText: 'Corrected synthetic body' });
  assert.equal(next.prepared, true);
  assert.notEqual(next.transmission.id, prepared.id);
  assert.equal(next.transmission.preparation_generation, 2);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id).state, 'cancelled-before-provider');
  assert.equal(database.prepare('SELECT cancelled_at FROM deal_hunter_cim_transmission_touches WHERE transmission_id = ?')
    .get(prepared.id).cancelled_at, at);
  assert.equal(database.prepare('SELECT transmission_id FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).transmission_id, next.transmission.id);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 2);
  assert.equal((await storage.prepareCimTransmission({ ...prepareCommand,
    preparationGeneration: 3, bodyText: 'Corrected synthetic body' })).payloadConflict, true);
});

test('P1B terminal event cancels an already prepared transmission and membership', async (t) => {
  const { storage, database, authority, prepared } = await createPreparedFixture(t, 'terminal-prepared');
  const campaign = database.prepare('SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?')
    .get(authority.campaignId);
  const terminal = await storage.appendCimTerminalEvent({ eventId: 'prepared-terminal',
    scope: 'campaign', scopeId: authority.campaignId, expectedRevision: 0,
    expectedRowVersion: campaign.row_version, nextState: 'stopped', reasonCode: 'owner_stop',
    evidenceType: 'owner-action', evidenceId: 'prepared-stop', metadataDigest: digest('a'),
    actor: 'fixture-owner', source: 'synthetic-test', observedAt: at, now: at });
  assert.equal(terminal.applied, true);
  assert.deepEqual(terminal.cancelledTouchIds, [authority.touchId]);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id).state, 'cancelled-before-provider');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'cancelled-before-provider');
});

test('P1B Watch supersedes pursuit and terminates prepared campaign atomically', async (t) => {
  const { storage, database, authority, prepared } = await createPreparedFixture(t, 'watch');
  seedTriageScore(database, authority.opportunityId);
  const command = { opportunityId: authority.opportunityId, action: 'watch',
    idempotencyKey: 'watch-command', expectedDiscoveryRevision: 0,
    expectedMaterialRevision: 0, actor: 'fixture-owner', policyVersion: 'owner-decision-v1', now: at };
  const first = await storage.recordOwnerDecision(command);
  assert.equal(first.applied, true);
  assert.equal(first.enrollment, null);
  assert.equal((await storage.recordOwnerDecision(command)).replay, true);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_pursuit_enrollments WHERE id = ?')
    .get(authority.enrollmentId).state, 'superseded');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaigns WHERE id = ?')
    .get(authority.campaignId).state, 'stopped');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id).state, 'cancelled-before-provider');
  assert.equal(database.prepare('SELECT operator_priority FROM deal_hunter_opportunity_scores WHERE opportunity_id = ?')
    .get(authority.opportunityId).operator_priority, 'watch');
});

for (const action of ['watch', 'pass']) {
  for (const stage of ['scheduled', 'claimed', 'prepared', 'authorized']) {
    test(`P4A ${action} fences ${stage} SQLite work before provider-pending`, async (t) => {
      let fixture;
      if (['prepared', 'authorized'].includes(stage)) {
        fixture = await createPreparedFixture(t, `p4a-${action}-${stage}`);
      } else {
        const sqlitePath = temporaryPath(t, `p4a-${action}-${stage}`);
        const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
        t.after(() => storage.close());
        const database = new Database(sqlitePath);
        t.after(() => database.close());
        fixture = { storage, database,
          authority: insertBaseAuthority(database, `-p4a-${action}-${stage}`) };
        if (stage === 'claimed') {
          await seedSyntheticActivationChain(storage);
          assert.equal((await storage.claimDueCimTouch({ touchId: fixture.authority.touchId,
            expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
            expectedConversationTerminalRevision: 0, claimTokenDigest: digest('a'),
            claimOwner: 'worker-1', claimExpiresAt: '2026-09-25T19:10:00.000Z',
            now: at })).claimed, true);
        }
      }
      const { storage, database, authority, prepared } = fixture;
      seedTriageScore(database, authority.opportunityId);
      let authorization = null;
      if (stage === 'authorized') {
        const issued = await storage.issueCimLiveProviderAuthorization({
          id: `p4a-${action}-authorization`, activationId: 'synthetic-fl04b-initial',
          capability: 'fl04b-initial', writerPath: 'pursue-cim-initial',
          transmissionId: prepared.id, payloadDigest: prepared.payload_digest,
          recipientAuthorityDigest: digest('e'), providerProfile: 'synthetic-provider',
          expiresAt: '2026-09-25T20:00:00.000Z', actor: 'fixture-owner',
          reason: 'synthetic hold', now: at });
        assert.equal(issued.issued, true);
        authorization = issued.authorization;
      }
      const command = { opportunityId: authority.opportunityId, action,
        idempotencyKey: `p4a-${action}-${stage}`, expectedDiscoveryRevision: 0,
        expectedMaterialRevision: 0, actor: 'fixture-owner', policyVersion: 'owner-decision-v1',
        ...(action === 'pass' ? { reason: 'not-a-fit', note: 'Owner declined.' } : {}), now: at };
      assert.equal((await storage.recordOwnerDecision(command)).applied, true);
      assert.equal((await storage.recordOwnerDecision(command)).replay, true);
      assert.equal(database.prepare('SELECT terminal_revision FROM deal_hunter_cim_campaigns WHERE id = ?')
        .get(authority.campaignId).terminal_revision, 1);
      assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
        .get(authority.touchId).state, 'cancelled-before-provider');
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_terminal_events
        WHERE campaign_id = ?`).get(authority.campaignId).count, 1);
      if (prepared) assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions WHERE id = ?')
        .get(prepared.id).state, 'cancelled-before-provider');
      if (authorization) {
        assert.ok(database.prepare(`SELECT withdrawn_at FROM deal_hunter_cim_live_provider_authorizations
          WHERE id = ?`).get(authorization.id).withdrawn_at);
        assert.equal((await storage.authorizeCimProviderPending({ transmissionId: prepared.id,
          authorizationId: authorization.id, writerPath: 'pursue-cim-initial',
          providerProfile: 'synthetic-provider', expectedRowVersion: 1,
          expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
          expectedGlobalAuthorityRevision: 0, authoritySnapshot: {},
          claimTokenDigest: digest('a'), finalGateAuthorityDigest: digest('f'),
          boundaryNonceDigest: digest('b'), actor: 'fixture-owner', now: at })).authorized, false);
      }
    });
  }
}

for (const action of ['watch', 'pass']) {
  for (const stage of ['scheduled', 'claimed', 'prepared', 'authorized']) {
    test(`P4A ${action} races ${stage} SQLite work on independent connections`, async (t) => {
      const sqlitePath = temporaryPath(t, `p4a-race-${action}-${stage}`);
      const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
      t.after(() => storage.close());
      const database = new Database(sqlitePath);
      t.after(() => database.close());
      const authority = insertBaseAuthority(database, `-race-${action}-${stage}`);
      seedTriageScore(database, authority.opportunityId);
      seedCrmOwner(database, authority.opportunityId, `submission-race-${action}-${stage}`);
      await seedSyntheticActivationChain(storage);
      const claim = { touchId: authority.touchId, expectedRowVersion: 1,
        expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
        claimTokenDigest: digest('a'), claimOwner: 'race-worker',
        claimExpiresAt: '2026-09-25T19:10:00.000Z', now: at };
      const prepare = { touchIds: [authority.touchId], claimTokenDigest: digest('a'),
        expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
        preparationGeneration: 1, payloadVersion: 'payload-v1',
        fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
        ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
        subject: 'Synthetic subject', bodyText: 'Synthetic body',
        bodyHtmlSanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
        actor: 'fixture-owner', now: at };
      let prepared = null;
      if (stage !== 'scheduled') assert.equal((await storage.claimDueCimTouch(claim)).claimed, true);
      if (['prepared', 'authorized'].includes(stage)) {
        const result = await storage.prepareCimTransmission(prepare);
        assert.equal(result.prepared, true);
        prepared = result.transmission;
      }
      const issue = prepared && { id: `race-${action}-${stage}-authorization`,
        activationId: 'synthetic-fl04b-initial', capability: 'fl04b-initial',
        writerPath: 'pursue-cim-initial', transmissionId: prepared.id,
        payloadDigest: prepared.payload_digest, recipientAuthorityDigest: digest('e'),
        providerProfile: 'synthetic-provider', expiresAt: '2026-09-25T20:00:00.000Z',
        actor: 'fixture-owner', reason: 'synthetic race', now: at };
      if (stage === 'authorized') {
        assert.equal((await storage.issueCimLiveProviderAuthorization(issue)).issued, true);
        database.prepare(`INSERT INTO deal_hunter_cim_safety_settings
          (id, updated_at, outreach_paused, updated_by, metadata)
          VALUES ('global', ?, 0, 'fixture-owner', '{}')`).run(at);
      }
      const transition = stage === 'scheduled'
        ? { method: 'claimDueCimTouch', payload: claim }
        : stage === 'claimed'
          ? { method: 'prepareCimTransmission', payload: prepare }
          : stage === 'prepared'
            ? { method: 'issueCimLiveProviderAuthorization', payload: issue }
            : { method: 'authorizeCimProviderPending', payload: {
              transmissionId: prepared.id, authorizationId: issue.id,
              writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
              expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
              expectedConversationTerminalRevision: 0, expectedGlobalAuthorityRevision: 0,
              authoritySnapshot: {}, claimTokenDigest: digest('a'),
              finalGateAuthorityDigest: digest('f'), boundaryNonceDigest: digest('b'),
              actor: 'fixture-owner', now: at } };
      const owner = { opportunityId: authority.opportunityId, action,
        idempotencyKey: `p4a-race-${action}-${stage}`, expectedDiscoveryRevision: 0,
        expectedMaterialRevision: 0, actor: 'fixture-owner', policyVersion: 'owner-decision-v1',
        ...(action === 'pass' ? { reason: 'not-a-fit', note: 'Owner declined.' } : {}), now: at };
      const [ownerResult, transitionResult] = await Promise.all([
        ownerCommandFromWorker(sqlitePath, owner),
        transitionFromWorker(sqlitePath, 'pre-provider-transition', transition),
      ]);
      assert.equal(ownerResult.applied, true);
      assert.equal(database.prepare(`SELECT terminal_revision FROM deal_hunter_cim_campaigns
        WHERE id = ?`).get(authority.campaignId).terminal_revision, 1);
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_terminal_events
        WHERE campaign_id = ?`).get(authority.campaignId).count, 1);
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events
        WHERE event_type = 'owner-decision' AND opportunity_id = ?`)
        .get(authority.opportunityId).count, 1);
      const touch = database.prepare(`SELECT state FROM deal_hunter_cim_campaign_touches
        WHERE id = ?`).get(authority.touchId);
      const transmission = prepared && database.prepare(`SELECT state FROM deal_hunter_cim_transmissions
        WHERE id = ?`).get(prepared.id);
      if (stage === 'authorized' && transitionResult.authorized) {
        assert.equal(transmission.state, 'provider-pending');
        assert.equal(touch.state, 'provider-pending');
      } else {
        assert.equal(touch.state, 'cancelled-before-provider');
        if (transmission) assert.equal(transmission.state, 'cancelled-before-provider');
      }
    });
  }
}

test('P6A valid service-generated gate and owner stop have one serialized SQLite winner', async (t) => {
  await t.test('control command is independently authorizable', async (subtest) => {
    const control = await createFinalGateFixture(subtest, 'p6a-owner-race-control');
    assert.equal((await control.gate()).authorized, true);
  });
  await t.test('concurrent owner stop cannot leave stale provider authority', async (subtest) => {
    const fixture = await createFinalGateFixture(subtest, 'p6a-owner-race-valid');
    seedTriageScore(fixture.database, fixture.authority.opportunityId);
    const gateCommand = {
      args: { transmissionId: fixture.prepared.id,
        authorizationId: fixture.authorization.id, writerPath: 'pursue-cim-initial',
        providerProfile: 'synthetic-provider', actor: 'fixture-owner', now: at },
      memberAuthority: await fixture.loadMemberAuthority({
        opportunityId: fixture.authority.opportunityId }),
      currentAuthority: await fixture.readCurrentAuthority({
        opportunityId: fixture.authority.opportunityId }),
      providerReadiness: await fixture.readProviderReadiness(),
    };
    const ownerCommand = { opportunityId: fixture.authority.opportunityId, action: 'watch',
      idempotencyKey: 'p6a-valid-owner-race', expectedDiscoveryRevision: 0,
      expectedMaterialRevision: 0, actor: 'fixture-owner', policyVersion: 'owner-decision-v1',
      now: at };
    const [owner, gate] = await Promise.all([
      ownerCommandFromWorker(fixture.database.name, ownerCommand),
      transitionFromWorker(fixture.database.name, 'final-gate-service', gateCommand),
    ]);
    assert.equal(owner.applied, true);
    const transmission = fixture.database.prepare(`SELECT state, invocation_authority_count
      FROM deal_hunter_cim_transmissions WHERE id = ?`).get(fixture.prepared.id);
    const authorization = fixture.database.prepare(`SELECT consumed_at, withdrawn_at
      FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?`)
      .get(fixture.authorization.id);
    if (gate.authorized) {
      assert.equal(transmission.state, 'provider-pending');
      assert.equal(transmission.invocation_authority_count, 1);
      assert.equal(authorization.consumed_at, at);
    } else {
      assert.equal(transmission.state, 'cancelled-before-provider');
      assert.equal(transmission.invocation_authority_count, 0);
      assert.equal(authorization.consumed_at, null);
      assert.ok(authorization.withdrawn_at);
    }
  });
});

test('P1B Pass records durable disposition and does not create enrollment', async (t) => {
  const sqlitePath = temporaryPath(t, 'pursue-cim-pass');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  seedOpportunity(database, 'opp-pass');
  seedTriageScore(database, 'opp-pass');
  const command = { opportunityId: 'opp-pass', action: 'pass',
    idempotencyKey: 'pass-command', expectedDiscoveryRevision: 0,
    expectedMaterialRevision: 0, actor: 'fixture-owner', policyVersion: 'owner-decision-v1',
    reason: 'not-a-fit', now: at };
  assert.equal((await storage.recordOwnerDecision(command)).applied, true);
  assert.equal(database.prepare('SELECT disposition FROM deal_hunter_dispositions WHERE deal_key = ?')
    .get('deal:opp-pass').disposition, 'dismissed');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_pursuit_enrollments').get().n, 0);
});

test('P1B final gate rejects expired claim lease and out-of-window authorization', async (t) => {
  const { database, prepared, authorization, gate } =
    await createFinalGateFixture(t, 'late-gate');
  const expiredClaim = await gate({ now: '2026-09-25T19:11:00.000Z',
    readProviderReadiness: async () => ({ provider: 'resend',
      providerProfile: 'synthetic-provider', outboundConfigured: true, senderConfigured: true,
      senderAuthenticationAttested: true, webhookConfigured: true,
      requestReplyRoutingVerified: true, replyTrackingVerified: true,
      suppressionOperational: true, reconciliationOperational: true,
      evidenceRevision: 'claim-readiness', generatedAt: at,
      expiresAt: '2026-09-25T20:00:00.000Z' }) });
  assert.equal(expiredClaim.authorized, false);
  assert.equal(expiredClaim.blockedReason, 'lifecycle_conflict');
  database.prepare(`UPDATE deal_hunter_cim_campaign_touches SET claim_expires_at = ?
    WHERE id IN (SELECT touch_id FROM deal_hunter_cim_transmission_touches WHERE transmission_id = ?)`)
    .run('2026-09-26T20:00:00.000Z', prepared.id);
  database.prepare(`UPDATE deal_hunter_cim_live_provider_authorizations SET expires_at = ?
    WHERE id = ?`).run('2026-09-26T20:00:00.000Z', authorization.id);
  assert.equal((await gate({ now: '2026-09-26T03:00:00.000Z',
    readProviderReadiness: async () => ({ provider: 'resend',
      providerProfile: 'synthetic-provider', outboundConfigured: true, senderConfigured: true,
      senderAuthenticationAttested: true, webhookConfigured: true,
      requestReplyRoutingVerified: true, replyTrackingVerified: true,
      suppressionOperational: true, reconciliationOperational: true,
      evidenceRevision: 'late-readiness', generatedAt: at,
      expiresAt: '2026-09-26T20:00:00.000Z' }) })).authorized, false);
  assert.equal(database.prepare('SELECT invocation_authority_count FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id).invocation_authority_count, 0);
  assert.equal(database.prepare('SELECT consumed_at FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?')
    .get(authorization.id).consumed_at, null);
});

test('P1B conversation reply fences campaigns before in-flight finalization', async (t) => {
  const { storage, database, authority, authorization, pending, boundaryNonceDigest } =
    await createProviderPendingFixture(t, 'reply-race');
  const conversation = database.prepare('SELECT * FROM deal_hunter_broker_conversations WHERE id = ?')
    .get(authority.conversationId);
  assert.equal((await storage.appendCimTerminalEvent({ eventId: 'reply-race-event',
    scope: 'conversation', scopeId: authority.conversationId,
    expectedRevision: 0, expectedRowVersion: conversation.row_version,
    nextState: 'responded', reasonCode: 'broker_reply', evidenceType: 'inbound-reply',
    evidenceId: 'reply-race-proof', metadataDigest: digest('d'),
    actor: 'fixture-owner', source: 'synthetic-inbound', observedAt: at, now: at })).applied, true);
  const campaign = database.prepare('SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?')
    .get(authority.campaignId);
  assert.equal(campaign.state, 'responded');
  assert.equal(campaign.terminal_revision, 1);
  assert.equal((await storage.enterCimProviderSeam({ transmissionId: pending.id,
    authorizationId: authorization.id, writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', capability: 'fl04b-initial',
    payloadDigest: pending.payload_digest, boundaryNonceDigest,
    expectedRowVersion: 2, actor: 'fixture-owner', now: at })).entered, true);
  const finalized = await storage.finalizeCimTransmission({ transmissionId: pending.id,
    payloadDigest: pending.payload_digest,
    expectedRowVersion: 3, outcome: 'accepted', provider: 'resend',
    providerMessageId: 'reply-race-message', providerResultCode: 'accepted',
    actor: 'fixture-owner', now: at });
  assert.equal(finalized.applied, true);
  assert.equal(finalized.nextTouch, null);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaigns WHERE id = ?')
    .get(authority.campaignId).state, 'responded');
});

test('P1B safety stop atomically cancels prepared work and issued authorization', async (t) => {
  const { storage, database, authority, prepared } = await createPreparedFixture(t, 'safety-prepared');
  await storage.issueCimLiveProviderAuthorization({ id: 'safety-held-auth',
    activationId: 'synthetic-fl04b-initial', capability: 'fl04b-initial',
    writerPath: 'pursue-cim-initial', transmissionId: prepared.id,
    payloadDigest: prepared.payload_digest, recipientAuthorityDigest: digest('e'),
    providerProfile: 'synthetic-provider', expiresAt: '2026-09-25T20:00:00.000Z',
    actor: 'fixture-owner', reason: 'synthetic hold', now: at });
  await storage.appendCimSafetyEvents({ safetyRunId: 'prepared-safety-run',
    sourceType: 'synthetic-import', sourceRunId: 'source-prepared', now: at,
    events: [{ opportunityId: authority.opportunityId, canonicalRevision: 1,
      identityExceptionRevision: 0, eventType: 'identity-unsafe', evidenceId: 'prepared-proof' }] });
  const eventId = database.prepare('SELECT id FROM deal_hunter_cim_safety_events').get().id;
  assert.equal((await storage.consumeCimSafetyEvents({ safetyRunId: 'prepared-safety-run',
    limit: 10, actor: 'fixture-owner', now: at,
    outcomes: { [eventId]: 'stopped' } })).stopped, 1);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id).state, 'cancelled-before-provider');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'cancelled-before-provider');
  assert.equal(database.prepare('SELECT withdrawn_at FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?')
    .get('safety-held-auth').withdrawn_at, at);
});

test('P9 SQLite operations snapshot is bounded, read-only, and classifies shadow candidates', async (t) => {
  const { storage, database, authority, prepared } = await createPreparedFixture(t, 'p9-operations');
  seedLegacyEvidence(database);
  database.prepare(`UPDATE deal_hunter_cim_requests SET last_attempt_at = ?
    WHERE id = 'legacy-request'`).run('2026-09-24T19:00:00.000Z');
  database.prepare(`INSERT INTO deal_hunter_cim_audit_events
    (id,event_type,reason_code,actor,source,occurred_at,metadata)
    VALUES ('p9-capability-block','final-gate-blocked','capability_inactive',
      'fixture','test',?,'{}'),
      ('p9-readiness-block','final-gate-blocked','provider_readiness_unavailable',
      'fixture','test',?,'{}')`).run(at, at);
  const before = Object.fromEntries([
    'deal_hunter_pursuit_enrollments', 'deal_hunter_cim_campaigns',
    'deal_hunter_cim_campaign_touches', 'deal_hunter_cim_transmissions',
    'deal_hunter_cim_live_provider_authorizations', 'deal_hunter_cim_audit_events',
  ].map((table) => [table, fingerprintRows(database, table, 'rowid')]));

  const snapshot = await storage.readPursueCimOperationsSnapshot({ now: at, limit: 100 });
  const after = Object.fromEntries(Object.keys(before)
    .map((table) => [table, fingerprintRows(database, table, 'rowid')]));

  assert.deepEqual(after, before);
  assert.equal(snapshot.counts.campaigns, 1);
  assert.equal(snapshot.counts.transmissions, 1);
  assert.equal(snapshot.stateCounts.campaigns['initial-pending'], 1);
  assert.equal(snapshot.stateCounts.transmissions.prepared, 1);
  assert.equal(snapshot.pause.paused, true);
  assert.ok(snapshot.shadowCandidates.some((candidate) =>
    candidate.kind === 'would-enroll' && candidate.subjectId === authority.enrollmentId));
  assert.ok(snapshot.shadowCandidates.some((candidate) =>
    candidate.kind === 'would-send' && candidate.subjectId === prepared.id));
  assert.equal(snapshot.invariants.shadowProviderCalls, 0);
  assert.equal(snapshot.invariants.expiredActivationAttempts, 1);
  assert.equal(snapshot.invariants.readinessLoss, 1);
  assert.equal(snapshot.legacy.writerInvocations, 1);
  assert.equal(snapshot.invariants.unexpectedLegacyInvocations, 0,
    'historical legacy attempts are inventory, not unexpected invocation findings');
  database.prepare(`UPDATE deal_hunter_cim_requests SET last_attempt_at = ?
    WHERE id = 'legacy-request'`).run(at);
  const afterLegacyInvocation = await storage.readPursueCimOperationsSnapshot({ now: at, limit: 100 });
  assert.equal(afterLegacyInvocation.invariants.unexpectedLegacyInvocations, 1);
  database.prepare(`UPDATE deal_hunter_cim_safety_settings SET outreach_paused = 0
    WHERE id = 'global'`).run();
  const unpaused = await storage.readPursueCimOperationsSnapshot({ now: at, limit: 100 });
  assert.ok(unpaused.shadowCandidates.some((candidate) => candidate.kind === 'would-send'
    && candidate.subjectId === prepared.id && candidate.eligible === false
    && candidate.reason === 'exact_live_authorization_missing'));
  assert.ok(snapshot.shadowCandidates.length <= 100);
});

test('P9 SQLite shadow send remains blocked when live final-gate readiness is not proven', async (t) => {
  const { storage, prepared } = await createFinalGateFixture(t, 'p9-shadow-readiness');

  const snapshot = await storage.readPursueCimOperationsSnapshot({ now: at, limit: 100 });

  assert.ok(snapshot.shadowCandidates.some((candidate) => candidate.kind === 'would-send'
    && candidate.subjectId === prepared.id && candidate.eligible === false
    && candidate.reason === 'final_gate_readiness_unproven'));
});

test('P9 terminal-before-provider alert excludes the allowed post-gate pre-seam race', async (t) => {
  const { storage, database, authority, prepared, gate } =
    await createFinalGateFixture(t, 'p9-terminal-cutoff');
  assert.equal((await gate()).authorized, true);
  database.prepare(`UPDATE deal_hunter_cim_transmissions
    SET provider_seam_entered_at=? WHERE id=?`)
    .run('2026-09-25T19:02:00.000Z', prepared.id);
  database.prepare(`INSERT INTO deal_hunter_cim_terminal_events
    (id,scope,scope_id,campaign_id,revision,reason_code,evidence_type,evidence_id,
      observed_at,actor,source,metadata_digest,created_at)
    VALUES ('p9-terminal-race','campaign',?,?,1,'reply_received','signed-event',?,
      ?,'fixture-owner','synthetic-test',?,?)`).run(authority.campaignId,
    authority.campaignId, 'p9-terminal-race-evidence', '2026-09-25T19:01:00.000Z',
    digest('a'), '2026-09-25T19:01:00.000Z');

  const afterGate = await storage.readPursueCimOperationsSnapshot({ now: at, limit: 100 });
  assert.equal(afterGate.invariants.replyOrMaterialsBeforeGateProviderCalls, 0);

  database.prepare(`INSERT INTO deal_hunter_cim_terminal_events
    (id,scope,scope_id,conversation_id,revision,reason_code,evidence_type,evidence_id,
      observed_at,actor,source,metadata_digest,created_at)
    VALUES ('p9-terminal-before-gate','conversation',?,?,1,'materials_received',
      'signed-event',?,?,'fixture-owner','synthetic-test',?,?)`).run(
    authority.conversationId, authority.conversationId, 'p9-terminal-before-evidence',
    '2026-09-25T18:59:00.000Z', digest('b'), '2026-09-25T18:59:00.000Z');
  const beforeGate = await storage.readPursueCimOperationsSnapshot({ now: at, limit: 100 });
  assert.equal(beforeGate.invariants.replyOrMaterialsBeforeGateProviderCalls, 1);
});

test('P9 SQLite automatic containment atomically pauses and withdraws live authority with replay safety', async (t) => {
  const { storage, database, authorization } = await createFinalGateFixture(t, 'p9-containment');
  await assert.rejects(storage.applyPursueCimAutomaticContainment({
    findingId: '6'.repeat(64), evidenceDigest: '5'.repeat(64),
    findingCodes: ['operator_supplied_boolean'], actor: 'p9-shadow-containment',
    now: '2026-09-25T19:00:00.000Z',
  }), /Invalid Pursue CIM containment findings/);
  const command = { findingId: '7'.repeat(64), evidenceDigest: '8'.repeat(64),
    findingCodes: ['duplicate_provider_identity', 'missing_live_envelope'],
    actor: 'p9-shadow-containment', now: '2026-09-25T19:01:00.000Z' };
  const first = await storage.applyPursueCimAutomaticContainment(command);
  const replay = await storage.applyPursueCimAutomaticContainment(command);
  database.prepare(`UPDATE deal_hunter_cim_safety_settings SET outreach_paused=0
    WHERE id='global'`).run();
  const reasserted = await storage.applyPursueCimAutomaticContainment(command);

  assert.deepEqual(first, { applied: true, replay: false, paused: true,
    withdrawnActivations: 3, withdrawnAuthorizations: 1 });
  assert.deepEqual(replay, { applied: false, replay: true, paused: true,
    withdrawnActivations: 0, withdrawnAuthorizations: 0 });
  assert.deepEqual(reasserted, { applied: false, replay: true, paused: true,
    withdrawnActivations: 0, withdrawnAuthorizations: 0 });
  assert.equal(database.prepare(`SELECT outreach_paused FROM deal_hunter_cim_safety_settings
    WHERE id='global'`).get().outreach_paused, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_capability_activations
    WHERE status='current'`).get().count, 0);
  assert.equal(database.prepare(`SELECT withdrawn_at FROM deal_hunter_cim_live_provider_authorizations
    WHERE id=?`).get(authorization.id).withdrawn_at, command.now);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events
    WHERE event_type='automatic-containment'`).get().count, 1);
});

test('P9 SQLite containment rolls back pause and withdrawals when immutable audit persistence fails', async (t) => {
  const { storage, database, authorization } = await createFinalGateFixture(t, 'p9-containment-rollback');
  database.exec(`CREATE TRIGGER reject_p9_containment_audit
    BEFORE INSERT ON deal_hunter_cim_audit_events
    WHEN NEW.event_type = 'automatic-containment'
    BEGIN SELECT RAISE(ABORT, 'synthetic P9 audit failure'); END;`);
  await assert.rejects(storage.applyPursueCimAutomaticContainment({
    findingId: '9'.repeat(64), evidenceDigest: 'a'.repeat(64),
    findingCodes: ['shadow_provider_call'], actor: 'p9-shadow-containment',
    now: '2026-09-25T19:01:00.000Z',
  }), /synthetic P9 audit failure/);
  assert.equal(database.prepare(`SELECT outreach_paused FROM deal_hunter_cim_safety_settings
    WHERE id='global'`).get().outreach_paused, 0);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_capability_activations
    WHERE status='current'`).get().count, 3);
  assert.equal(database.prepare(`SELECT withdrawn_at FROM deal_hunter_cim_live_provider_authorizations
    WHERE id=?`).get(authorization.id).withdrawn_at, null);
});

test('P1B prepared and provider-pending outbox rows cannot reach the legacy sender', async (t) => {
  const provider = createPursueCimProviderFake();
  const sender = (request) => provider.execute(request);
  const prepared = await createPreparedFixture(t, 'outbox-inert-prepared');
  const preparedResult = await processCrmEmailOutbox({
    outboxId: prepared.prepared.outbox_id, storage: prepared.storage, sender,
    config: {}, now: new Date(at),
  });
  assert.equal(preparedResult.ok, false);
  assert.equal(preparedResult.code, 'outbox-in-progress');
  assert.equal(prepared.database.prepare('SELECT state FROM crm_email_outbox WHERE id = ?')
    .get(prepared.prepared.outbox_id).state, 'prepared');

  const pending = await createProviderPendingFixture(t, 'outbox-inert-pending');
  const pendingResult = await processCrmEmailOutbox({
    outboxId: pending.pending.outbox_id, storage: pending.storage, sender,
    config: {}, now: new Date(at),
  });
  assert.equal(pendingResult.ok, false);
  assert.equal(pendingResult.code, 'outbox-in-progress');
  assert.equal(pending.database.prepare('SELECT state FROM crm_email_outbox WHERE id = ?')
    .get(pending.pending.outbox_id).state, 'provider-pending');
  assert.equal(provider.seamEntries.length, 0);
  assert.equal(provider.providerCalls.length, 0);
});

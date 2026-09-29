import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { readCimCurrentAuthority, runCimCampaignSafety } from '../server/services/cimCampaignSafety.js';
import { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } from '../server/services/dealHunterSourceSnapshotAdmission.js';
import { processCrmEmailOutbox } from '../server/services/followUpEmail.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
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

function insertBaseAuthority(database, suffix = '') {
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
    ) VALUES (?, 'recipient-authority', ?, 'broker@example.test', 'sender-v1',
      'reply-v1', ?, ?, 'open', 0, 'batching-off-v1', ?, ?, 1)
  `).run(conversationId, digest('e'), digest(suffix ? '0' : 'f'), `thread${suffix}`, at, at);
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
      ?, ?, 1, ?, ?, 'deal-hunter-cim-autopilot-v1', 'template-v1', ?,
      'permission-v1', ?, 1, 'synthetic-cohort', 1, 1, 'recipient-authority',
      ?, ?, 0, 0, 1, ?, 'initial-pending', 'awaiting-window', 0, 1, ?, ?
    )
  `).run(
    campaignId, opportunityId, enrollmentId, decisionId, digest('1'), digest('2'),
    digest('e'), digest('3'), conversationId, at, at,
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
    permissionVersion: 'permission-v1', permissionDigest: digest('d'),
    permissionRevision: 1, permissionScope: 'synthetic-cohort', canonicalRevision: 1,
    crmOwnershipRevision: 0, recipientAuthorityId: 'recipient-1',
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
    prerequisiteActivationId: 'campaign-safety-activation', prerequisiteEvidenceId: 'synthetic-evidence',
    prerequisiteEvidenceHash: digest('c') });
  assert.equal((await storage.materializePursuitCampaign(command)).actionRequired, true);
  seedCrmOwner(database, 'opp-campaign', 'submission-campaign');
  const ownedCommand = { ...command, crmSubmissionId: 'submission-campaign', crmOwnershipRevision: 1 };
  const first = await storage.materializePursuitCampaign(ownedCommand);
  assert.equal(first.applied, true);
  assert.equal(first.campaign.state, 'initial-pending');
  assert.equal(first.initialTouch.state, 'scheduled');
  assert.equal((await storage.materializePursuitCampaign(ownedCommand)).existing, true);
  assert.equal((await storage.materializePursuitCampaign({ ...ownedCommand, generation: 2 })).actionRequired, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 1);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_pursuit_enrollments WHERE id = ?').get(decision.enrollment.id).state,
    'campaign-created');
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

async function createPreparedFixture(t, suffix) {
  const sqlitePath = temporaryPath(t, `pursue-cim-${suffix}`);
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const authority = insertBaseAuthority(database, `-${suffix}`);
  seedCrmOwner(database, authority.opportunityId, `submission-${suffix}`);
  await seedSyntheticActivationChain(storage);
  const claimTokenDigest = digest('a');
  assert.equal((await storage.claimDueCimTouch({ touchId: authority.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest, claimOwner: 'worker-1', claimExpiresAt: '2026-09-25T19:10:00.000Z',
    now: at })).claimed, true);
  const prepareCommand = { touchIds: [authority.touchId], claimTokenDigest,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    preparationGeneration: 1, payloadVersion: 'payload-v1',
    fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
    ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
    subject: 'Synthetic subject', bodyText: 'Synthetic body',
    bodyHtmlSanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
    actor: 'fixture-owner', now: at };
  const prepared = await storage.prepareCimTransmission(prepareCommand);
  assert.equal(prepared.prepared, true);
  return { storage, database, authority, prepared: prepared.transmission, prepareCommand };
}

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
  const { storage, database, authority, prepared } = await createPreparedFixture(t, 'provider-pending');
  database.prepare(`
    INSERT INTO deal_hunter_cim_safety_settings (id, updated_at, outreach_paused, updated_by, metadata)
    VALUES ('global', ?, 0, 'fixture-owner', '{}')
  `).run(at);
  const issued = await storage.issueCimLiveProviderAuthorization({
    id: 'authorization-provider-pending', activationId: 'synthetic-fl04b-initial',
    capability: 'fl04b-initial', writerPath: 'pursue-cim-initial',
    transmissionId: prepared.id, payloadDigest: prepared.payload_digest,
    recipientAuthorityDigest: digest('e'), providerProfile: 'synthetic-provider',
    expiresAt: '2026-09-25T20:00:00.000Z', actor: 'fixture-owner',
    reason: 'synthetic envelope', now: at,
  });
  assert.equal(issued.issued, true);
  const command = { transmissionId: prepared.id, authorizationId: issued.authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: digest('a'),
    finalGateAuthorityDigest: digest('f'), boundaryNonceDigest: digest('b'),
    actor: 'fixture-owner', now: at };
  const first = await storage.authorizeCimProviderPending(command);
  assert.equal(first.authorized, true);
  assert.equal(first.transmission.state, 'provider-pending');
  assert.equal(first.transmission.invocation_authority_count, 1);
  assert.equal(Object.hasOwn(first, 'ephemeralBoundaryToken'), false);
  assert.equal((await storage.authorizeCimProviderPending(command)).authorized, false);
  assert.equal(database.prepare('SELECT consumed_at FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?')
    .get(issued.authorization.id).consumed_at, at);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?').get(authority.touchId).state,
    'provider-pending');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'provider-pending'").get().count, 1);
});

test('P1B provider seam admits one CAS winner and rechecks durable pause', async (t) => {
  const { storage, database, prepared } = await createPreparedFixture(t, 'seam');
  database.prepare(`
    INSERT INTO deal_hunter_cim_safety_settings (id, updated_at, outreach_paused, updated_by, metadata)
    VALUES ('global', ?, 0, 'fixture-owner', '{}')
  `).run(at);
  const issued = await storage.issueCimLiveProviderAuthorization({
    id: 'authorization-seam', activationId: 'synthetic-fl04b-initial',
    capability: 'fl04b-initial', writerPath: 'pursue-cim-initial',
    transmissionId: prepared.id, payloadDigest: prepared.payload_digest,
    recipientAuthorityDigest: digest('e'), providerProfile: 'synthetic-provider',
    expiresAt: '2026-09-25T20:00:00.000Z', actor: 'fixture-owner',
    reason: 'synthetic envelope', now: at,
  });
  assert.equal((await storage.authorizeCimProviderPending({
    transmissionId: prepared.id, authorizationId: issued.authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: digest('a'),
    finalGateAuthorityDigest: digest('f'), boundaryNonceDigest: digest('b'),
    actor: 'fixture-owner', now: at,
  })).authorized, true);
  const command = { transmissionId: prepared.id, authorizationId: issued.authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    boundaryNonceDigest: digest('b'), expectedRowVersion: 2, actor: 'fixture-owner', now: at };
  database.prepare("UPDATE deal_hunter_cim_safety_settings SET outreach_paused = 1 WHERE id = 'global'").run();
  assert.equal((await storage.enterCimProviderSeam(command)).unauthorized, true);
  database.prepare("UPDATE deal_hunter_cim_safety_settings SET outreach_paused = 0 WHERE id = 'global'").run();
  assert.equal((await storage.enterCimProviderSeam(command)).entered, true);
  assert.equal((await storage.enterCimProviderSeam(command)).alreadyEntered, true);
  assert.equal((await storage.enterCimProviderSeam({ ...command, boundaryNonceDigest: digest('c') })).unauthorized, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'provider-seam-entered'").get().count, 1);
});

async function createProviderPendingFixture(t, suffix) {
  const fixture = await createPreparedFixture(t, suffix);
  const { storage, database, prepared } = fixture;
  database.prepare(`
    INSERT INTO deal_hunter_cim_safety_settings (id, updated_at, outreach_paused, updated_by, metadata)
    VALUES ('global', ?, 0, 'fixture-owner', '{}')
  `).run(at);
  const issued = await storage.issueCimLiveProviderAuthorization({
    id: `authorization-${suffix}`, activationId: 'synthetic-fl04b-initial',
    capability: 'fl04b-initial', writerPath: 'pursue-cim-initial',
    transmissionId: prepared.id, payloadDigest: prepared.payload_digest,
    recipientAuthorityDigest: digest('e'), providerProfile: 'synthetic-provider',
    expiresAt: '2026-09-25T20:00:00.000Z', actor: 'fixture-owner',
    reason: 'synthetic envelope', now: at,
  });
  assert.equal(issued.issued, true);
  const pending = await storage.authorizeCimProviderPending({
    transmissionId: prepared.id, authorizationId: issued.authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: digest('a'),
    finalGateAuthorityDigest: digest('f'), boundaryNonceDigest: digest('b'),
    actor: 'fixture-owner', now: at,
  });
  assert.equal(pending.authorized, true);
  return { ...fixture, authorization: issued.authorization, pending: pending.transmission };
}

test('P1B accepted finalization updates one identity and creates one dormant next slot', async (t) => {
  const { storage, database, authority, authorization, pending } = await createProviderPendingFixture(t, 'finalize');
  assert.equal((await storage.enterCimProviderSeam({ transmissionId: pending.id,
    authorizationId: authorization.id, writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', boundaryNonceDigest: digest('b'),
    expectedRowVersion: 2, actor: 'fixture-owner', now: at })).entered, true);
  const command = { transmissionId: pending.id, expectedRowVersion: 3,
    outcome: 'accepted', provider: 'synthetic-provider', providerMessageId: 'provider-message-1',
    providerResultCode: 'accepted', actor: 'fixture-owner', now: at,
    localExpiryAt: '2026-10-16T19:00:00.000Z', expiryDerivation: { policy: 'synthetic-v1' },
    nextTouch: { logicalSlot: 'follow-up-1', kind: 'follow-up-1', ordinal: 1,
      dueAt: '2026-09-28T19:00:00.000Z', dueLocal: '2026-09-28T12:00:00-07:00',
      cadencePolicyVersion: 'cadence-v1' } };
  const first = await storage.finalizeCimTransmission(command);
  assert.equal(first.applied, true);
  assert.equal(first.transmission.state, 'accepted');
  assert.equal(first.nextTouch.state, 'scheduled');
  assert.equal((await storage.finalizeCimTransmission(command)).existing, true);
  assert.equal((await storage.finalizeCimTransmission({ ...command,
    providerMessageId: 'provider-message-2' })).conflict, true);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaign_touches WHERE id = ?')
    .get(authority.touchId).state, 'accepted');
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaigns WHERE id = ?')
    .get(authority.campaignId).state, 'active-follow-up');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'transmission-finalized'").get().count, 1);
});

test('P1B exact reconciliation resolves ambiguity without another provider authority', async (t) => {
  const { storage, database, authority, authorization, pending } = await createProviderPendingFixture(t, 'reconcile');
  assert.equal((await storage.enterCimProviderSeam({ transmissionId: pending.id,
    authorizationId: authorization.id, writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', boundaryNonceDigest: digest('b'),
    expectedRowVersion: 2, actor: 'fixture-owner', now: at })).entered, true);
  assert.equal((await storage.finalizeCimTransmission({ transmissionId: pending.id,
    expectedRowVersion: 3, outcome: 'ambiguous', provider: 'synthetic-provider',
    providerResultCode: 'response-lost', actor: 'fixture-owner', now: at })).applied, true);
  const command = { transmissionId: pending.id, expectedRowVersion: 4,
    outcome: 'accepted', provider: 'synthetic-provider', providerMessageId: 'reconciled-provider-message',
    providerResultCode: 'signed-webhook-accepted', evidenceType: 'signed-webhook',
    evidenceId: 'webhook-1', evidenceDigest: digest('f'), actor: 'fixture-owner', now: at,
    localExpiryAt: '2026-10-16T19:00:00.000Z', expiryDerivation: { policy: 'synthetic-v1' },
    nextTouch: { logicalSlot: 'follow-up-1', kind: 'follow-up-1', ordinal: 1,
      dueAt: '2026-09-28T19:00:00.000Z', dueLocal: '2026-09-28T12:00:00-07:00',
      cadencePolicyVersion: 'cadence-v1' } };
  const first = await storage.reconcileCimTransmission(command);
  assert.equal(first.applied, true);
  assert.equal(first.transmission.state, 'accepted');
  assert.equal((await storage.reconcileCimTransmission(command)).unchanged, true);
  assert.equal((await storage.reconcileCimTransmission({ ...command,
    providerMessageId: 'different-message' })).conflict, true);
  assert.equal(database.prepare('SELECT state FROM deal_hunter_cim_campaigns WHERE id = ?').get(authority.campaignId).state,
    'active-follow-up');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 2);
  assert.equal(database.prepare('SELECT invocation_authority_count FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(pending.id).invocation_authority_count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events WHERE event_type = 'transmission-reconciled'").get().count, 1);
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
  const { storage, database, prepared } = await createPreparedFixture(t, 'late-gate');
  database.prepare(`INSERT INTO deal_hunter_cim_safety_settings
    (id, updated_at, outreach_paused, updated_by, metadata)
    VALUES ('global', ?, 0, 'fixture-owner', '{}')`).run(at);
  const issued = await storage.issueCimLiveProviderAuthorization({ id: 'late-auth',
    activationId: 'synthetic-fl04b-initial', capability: 'fl04b-initial',
    writerPath: 'pursue-cim-initial', transmissionId: prepared.id,
    payloadDigest: prepared.payload_digest, recipientAuthorityDigest: digest('e'),
    providerProfile: 'synthetic-provider', expiresAt: '2026-09-26T20:00:00.000Z',
    actor: 'fixture-owner', reason: 'synthetic hold', now: at });
  const command = { transmissionId: prepared.id, authorizationId: issued.authorization.id,
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: digest('a'),
    finalGateAuthorityDigest: digest('f'), boundaryNonceDigest: digest('b'),
    actor: 'fixture-owner' };
  assert.equal((await storage.authorizeCimProviderPending({ ...command,
    now: '2026-09-25T19:11:00.000Z' })).authorized, false);
  database.prepare(`UPDATE deal_hunter_cim_campaign_touches SET claim_expires_at = ?
    WHERE id IN (SELECT touch_id FROM deal_hunter_cim_transmission_touches WHERE transmission_id = ?)`)
    .run('2026-09-26T20:00:00.000Z', prepared.id);
  assert.equal((await storage.authorizeCimProviderPending({ ...command,
    now: '2026-09-26T03:00:00.000Z' })).authorized, false);
  assert.equal(database.prepare('SELECT invocation_authority_count FROM deal_hunter_cim_transmissions WHERE id = ?')
    .get(prepared.id).invocation_authority_count, 0);
  assert.equal(database.prepare('SELECT consumed_at FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?')
    .get(issued.authorization.id).consumed_at, null);
});

test('P1B conversation reply fences campaigns before in-flight finalization', async (t) => {
  const { storage, database, authority, authorization, pending } =
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
    providerProfile: 'synthetic-provider', boundaryNonceDigest: digest('b'),
    expectedRowVersion: 2, actor: 'fixture-owner', now: at })).entered, true);
  const finalized = await storage.finalizeCimTransmission({ transmissionId: pending.id,
    expectedRowVersion: 3, outcome: 'accepted', provider: 'synthetic-provider',
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

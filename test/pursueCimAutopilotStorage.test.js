import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';

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

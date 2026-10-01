import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSupabaseStorage } from '../server/storage/supabase.js';
import { deriveAcceptedCimCadence } from '../server/services/pursueCimCadence.js';
import { calculateCampaignExpiry } from '../server/services/cimCampaignPolicy.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';
const baseSha = '0361a178dbaa36847ca6235fc300df9e209687ef';
const migrationPath = path.join(root, 'supabase/migrations/20260925120000_pursue_cim_autopilot.sql');
const ownerCommandMigrationPath = path.join(root,
  'supabase/migrations/20260930120000_pursue_cim_owner_commands.sql');
const safetyMigrationPath = path.join(root, 'supabase/migrations/20260928120000_pursue_cim_intake_safety.sql');
const timezoneGuardMigrationPath = path.join(root,
  'supabase/migrations/20260929120000_pursue_cim_timezone_current_guard.sql');
const crmAuthorityMigrationPath = path.join(root,
  'supabase/migrations/20261001120000_postgres_crm_authority_parity.sql');
const p4bMigrationPath = path.join(root,
  'supabase/migrations/20261001130000_pursue_cim_p4b_authority.sql');
const p5MigrationPath = path.join(root,
  'supabase/migrations/20261002120000_pursue_cim_initial_preparation.sql');
const p6aMigrationPath = path.join(root,
  'supabase/migrations/20261003120000_pursue_cim_final_gate.sql');
const p6bMigrationPath = path.join(root,
  'supabase/migrations/20261004120000_pursue_cim_provider_boundary.sql');
const p6cMigrationPath = path.join(root,
  'supabase/migrations/20261005120000_pursue_cim_provider_outcomes.sql');
const p6cPolicyTupleMigrationPath = path.join(root,
  'supabase/migrations/20261005130000_pursue_cim_policy_tuple_guard.sql');
const p6dMigrationPath = path.join(root,
  'supabase/migrations/20261006120000_pursue_cim_dormant_followup_slots.sql');
const p7aMigrationPath = path.join(root,
  'supabase/migrations/20261007120000_pursue_cim_conversation_first_inbound.sql');
const p7bMigrationPath = path.join(root,
  'supabase/migrations/20261008120000_pursue_cim_terminal_writer_convergence.sql');
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
const expectedP1cFunctions = [
  'pursue_cim_append_ambiguous_reply_review_v1',
  'pursue_cim_append_crm_ownership_revision_v1',
  'pursue_cim_append_safety_events_v1',
  'pursue_cim_append_terminal_event_v1',
  'pursue_cim_append_timezone_revision_v1',
  'pursue_cim_apply_accepted_cadence_v1',
  'pursue_cim_assert_types_v1',
  'pursue_cim_authorize_provider_pending_p5_v1',
  'pursue_cim_authorize_provider_pending_v1',
  'pursue_cim_bump_campaign_authority_revision_v1',
  'pursue_cim_bump_global_authority_revision_v1',
  'pursue_cim_cancel_prepared_transmission_v1',
  'pursue_cim_canonical_json_v1',
  'pursue_cim_claim_due_touch_v1',
  'pursue_cim_consume_safety_events_v1',
  'pursue_cim_converge_terminal_authority_v1',
  'pursue_cim_crm_match_fingerprint_v1',
  'pursue_cim_current_activation_v1',
  'pursue_cim_digest_v1',
  'pursue_cim_emit_admitted_import_safety_v1',
  'pursue_cim_enter_provider_seam_v1',
  'pursue_cim_expected_initial_expiry_v1',
  'pursue_cim_finalize_transmission_v1',
  'pursue_cim_finalize_with_cadence_v1',
  'pursue_cim_issue_live_authorization_v1',
  'pursue_cim_json_stringify_v1',
  'pursue_cim_list_due_initial_touches_v1',
  'pursue_cim_materialize_campaign_v1',
  'pursue_cim_prepare_transmission_v1',
  'pursue_cim_read_cadence_context_v1',
  'pursue_cim_read_final_gate_context_v1',
  'pursue_cim_read_import_outreach_counters_v1',
  'pursue_cim_read_projection_v1',
  'pursue_cim_reconcile_transmission_v1',
  'pursue_cim_reconcile_with_cadence_v1',
  'pursue_cim_record_capability_activation_v1',
  'pursue_cim_record_owner_decision_v1',
  'pursue_cim_refresh_inbound_binding_v1',
  'pursue_cim_required_instant_v1',
  'pursue_cim_required_revision_v1',
  'pursue_cim_required_text_v1',
  'pursue_cim_resolve_inbound_v1',
  'pursue_cim_resolve_local_instant_v1',
  'pursue_cim_transition_enrollment_v1',
  'pursue_cim_validate_accepted_cadence_v1',
  'pursue_cim_withdraw_capability_activation_v1',
  'pursue_cim_withdraw_live_authorization_v1',
];

test('P5 PostgreSQL preparation locks conversation and campaign before touch', () => {
  const migration = fs.readFileSync(p5MigrationPath, 'utf8');
  const prepare = migration.slice(migration.indexOf(
    'create or replace function public.pursue_cim_prepare_transmission_v1'));
  const lockedTables = [...prepare.matchAll(/(?:select|perform)[^;]*?\bfrom public\.(deal_hunter_broker_conversations|deal_hunter_cim_campaigns|deal_hunter_cim_campaign_touches)[^;]*?\bfor update\b/gi)]
    .map((match) => match[1]);
  assert.deepEqual(lockedTables.slice(0, 3), [
    'deal_hunter_broker_conversations', 'deal_hunter_cim_campaigns',
    'deal_hunter_cim_campaign_touches',
  ]);
});

test('P6A PostgreSQL migration is mirrored and documents deterministic final-gate locking', () => {
  const migration = fs.readFileSync(p6aMigrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  assert.ok(schema.includes(migration), 'canonical schema must contain the exact additive P6A block');
  const gate = migration.slice(migration.indexOf(
    'create or replace function public.pursue_cim_authorize_provider_pending_v1'));
  const positions = [
    'from public.deal_hunter_cim_transmissions',
    'from public.deal_hunter_cim_live_provider_authorizations',
    'from public.deal_hunter_broker_conversations',
    'from public.deal_hunter_cim_campaigns c',
    'from public.deal_hunter_cim_transmission_touches m',
    'from public.deal_hunter_cim_capability_activations',
    "from public.deal_hunter_cim_global_authority\n      where id = 'global' for update",
    'from public.deal_hunter_cim_safety_settings',
    'from public.crm_communications',
    'from public.crm_email_outbox',
  ].map((fragment) => gate.indexOf(fragment));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.match(gate, /security definer\s+set search_path = ''/i);
  assert.match(gate, /v_activation\.permission_basis_digest is distinct from v_member\.permission_digest/);
  assert.match(gate, /v_expected_member #>> '\{campaign,permission_scope\}'[\s\S]*v_member\.permission_scope/);
  assert.match(gate, /v_result := public\.pursue_cim_authorize_provider_pending_p5_v1[\s\S]*final-gate-blocked/);
  assert.match(migration, /revoke all on function public\.pursue_cim_read_final_gate_context_v1\(jsonb\)[\s\S]*grant execute[\s\S]*to service_role/i);
});

test('P6B PostgreSQL seam requires exact payload capability work and service-role security', () => {
  const migration = fs.readFileSync(p6bMigrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  assert.ok(schema.includes(migration), 'canonical schema must contain the exact additive P6B block');
  assert.match(migration, /security definer\s+set search_path = ''/i);
  assert.match(migration, /v_authorization\.payload_digest is distinct from v_payload_digest/);
  assert.match(migration, /v_transmission\.payload_digest is distinct from v_payload_digest/);
  assert.match(migration, /v_authorization\.capability is distinct from v_capability/);
  assert.match(migration, /v_authorization\.maximum_calls is distinct from 1/);
  assert.match(migration, /v_authorization\.expires_at <= v_now/);
  assert.match(migration, /v_communication\.delivery_state is distinct from 'provider-pending'/);
  assert.match(migration, /v_outbox\.state is distinct from 'provider-pending'/);
  assert.match(migration, /revoke all on function public\.pursue_cim_enter_provider_seam_v1\(jsonb\)[\s\S]*grant execute[\s\S]*to service_role/i);
});

test('P6C PostgreSQL outcomes are mirrored, service-role-only, and create no cadence slot', () => {
  const migration = fs.readFileSync(p6cMigrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  assert.ok(schema.includes(migration), 'canonical schema must contain the exact additive P6C block');
  assert.match(migration, /security definer set search_path = ''/i);
  assert.match(migration, /v_provider <> 'resend'/);
  assert.match(migration, /provider_seam_entered_at is null/);
  assert.match(migration, /conversation-provider-ambiguous/);
  assert.match(migration, /conversation-provider-reconciled/);
  assert.match(migration, /provider-identity-conflict/);
  assert.match(migration, /value - array\['provider','providerMessageId','evidenceId','evidenceDigest'\]/);
  assert.match(migration, /value->>'provider' is distinct from 'resend'/);
  assert.match(migration, /jsonb_array_length\(p_command->'providerIdentities'\) > 20/);
  assert.match(migration, /v_evidence_payload_digest[\s\S]*pg_catalog\.to_jsonb\(v_observed\)[\s\S]*providerIdentities/);
  assert.match(migration, /delivery_state=v_delivery_state,delivery_state_at=v_observed/);
  assert.doesNotMatch(migration, /insert into public\.deal_hunter_cim_campaign_touches/);
  assert.match(migration, /revoke all on function public\.pursue_cim_finalize_transmission_v1\(jsonb\)[\s\S]*grant execute[\s\S]*to service_role/i);
  assert.match(migration, /revoke all on function public\.pursue_cim_reconcile_transmission_v1\(jsonb\)[\s\S]*grant execute[\s\S]*to service_role/i);
});

test('P6C policy tuple correction is additive, mirrored, and enforced by the durable gate', () => {
  assert.equal(fs.existsSync(p6cPolicyTupleMigrationPath), true,
    'policy tuple correction must use a new additive migration');
  const migration = fs.readFileSync(p6cPolicyTupleMigrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  assert.ok(schema.includes(migration),
    'canonical schema must contain the exact additive P6C policy tuple block');
  assert.match(migration,
    /create or replace function public\.pursue_cim_authorize_provider_pending_v1\(p_command jsonb\)/i);
  assert.match(migration, /security definer\s+set search_path = ''/i);
  assert.match(migration,
    /v_conversation\.batching_policy_version\s+is distinct from\s+'batching-off-v1'/i);
  assert.match(migration,
    /v_member\.permission_version\s+is distinct from\s+v_activation\.prerequisite_activation_id/i);
  assert.match(migration,
    /\{conversation,batchingPolicyVersion\}[\s\S]*v_conversation\.batching_policy_version/i);
  assert.match(migration,
    /\{campaign,permission_version\}[\s\S]*v_member\.permission_version/i);
  assert.match(migration,
    /revoke all on function public\.pursue_cim_authorize_provider_pending_v1\(jsonb\)[\s\S]*grant execute[\s\S]*to service_role/i);
});

test('P6D PostgreSQL cadence wrappers are additive, mirrored, and service-role constrained', () => {
  assert.equal(fs.existsSync(p6dMigrationPath), true);
  const migration = fs.readFileSync(p6dMigrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  assert.ok(schema.includes(migration), 'canonical schema must contain the exact additive P6D block');
  assert.match(migration, /security definer set search_path = ''/i);
  assert.match(migration, /pursue_cim_validate_accepted_cadence_v1/);
  assert.match(migration, /v_local_accepted\+interval '21 days'/);
  assert.match(migration, /v_cadence->'expiryDerivation'<>v_expected_expiry->'expiryDerivation'/);
  assert.match(migration, /v_campaign\.policy_version<>'deal-hunter-cim-autopilot-v1'/);
  assert.match(migration,
    /v_membership\.opportunity_id=v_campaign\.opportunity_id[\s\S]*v_touch\.opportunity_id=v_campaign\.opportunity_id/);
  assert.match(migration,
    /v_touch\.kind='weekday-follow-up'[\s\S]*v_touch\.ordinal>=4[\s\S]*\^weekday:/);
  assert.match(migration, /v_due>=v_expiry/);
  assert.match(migration, /insert into public\.deal_hunter_cim_campaign_touches/);
  assert.match(migration, /revoke all on function public\.pursue_cim_finalize_transmission_v1\(jsonb\) from service_role/);
  assert.match(migration, /grant execute on function public\.pursue_cim_finalize_with_cadence_v1\(jsonb\) to service_role/);
});

test('P7A PostgreSQL inbound resolver is additive, mirrored, read-only, and service-role constrained', () => {
  assert.equal(fs.existsSync(p7aMigrationPath), true);
  const migration = fs.readFileSync(p7aMigrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  assert.ok(schema.includes(migration), 'canonical schema must contain the exact additive P7A block');
  assert.match(migration, /create or replace function public\.pursue_cim_resolve_inbound_v1/);
  assert.match(migration, /language plpgsql\s+stable\s+security definer\s+set search_path = ''/i);
  assert.match(migration, /conflicting-exact-evidence/);
  assert.match(migration, /replyToAddresses/);
  assert.match(migration, /providerMessageIds/);
  assert.match(migration, /rfcMessageIds/);
  assert.match(migration, /taggedTouchIds/);
  assert.match(migration, /candidateConversations/);
  assert.match(migration,
    /pursue_cim_append_ambiguous_reply_review_v1[\s\S]*jsonb_array_length\(p_commands\) not between 1 and 50[\s\S]*pursue_cim_append_terminal_event_v1/);
  assert.match(migration,
    /new\.metadata - array\['conversationId','campaignIds','touchIds','memberDigest'\]\s*=\s*old\.metadata - array\['conversationId','campaignIds','touchIds','memberDigest'\]/);
  assert.match(migration, /after insert on public\.deal_hunter_cim_transmission_touches/);
  assert.match(migration, /grant execute on function public\.pursue_cim_resolve_inbound_v1\(jsonb\) to service_role/);
});

test('P7B PostgreSQL terminal convergence is additive, mirrored, and uses the common terminal RPC', () => {
  assert.equal(fs.existsSync(p7bMigrationPath), true);
  const migration = fs.readFileSync(p7bMigrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  assert.ok(schema.includes(migration), 'canonical schema must contain the exact additive P7B block');
  assert.match(migration, /create or replace function public\.pursue_cim_converge_terminal_authority_v1/);
  assert.match(migration, /pursue_cim_append_terminal_event_v1/);
  assert.match(migration, /terminal-in-flight-race/);
  for (const table of ['contact_submissions', 'secure_documents', 'secure_upload_requests',
    'crm_communications', 'email_suppressions', 'deal_hunter_identity_exceptions',
    'crm_submission_supersessions', 'deal_hunter_owner_decision_events']) {
    assert.match(migration, new RegExp(`on public\\.${table}`));
  }
  assert.match(migration,
    /revoke all on function public\.pursue_cim_converge_terminal_authority_v1\(jsonb\)[\s\S]*grant execute[\s\S]*to service_role/i);
  assert.match(migration, /pg_advisory_xact_lock\(17499,48146\)/);
  assert.match(migration, /order by candidate\.created_at desc, candidate\.id desc limit 1/);
  assert.match(migration, /pursue_cim_append_terminal_event_p7a/);
  assert.match(migration, /pursue_cim_record_owner_decision_p7a/);
  assert.match(migration, /pursue_cim_prepare_transmission_p7a/);
  assert.match(migration, /pursue_cim_finalize_with_cadence_p7a/);
  assert.match(migration, /pursue_cim_reconcile_with_cadence_p7a/);
  assert.match(migration, /pursue_cim_material_filename_kind_p7b/);
  assert.match(migration, /update of status, last_uploaded_at, requested_documents/);
});

test('P1C fresh-schema RPC block exactly matches the upgrade migration', () => {
  const marker = '-- Package 1C: versioned Pursue CIM transition RPCs.';
  const nextMarker = '-- Package 2: admitted source commits append inert campaign-safety evidence.';
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.equal(schema.slice(schema.indexOf(marker), schema.indexOf(nextMarker)).trim(),
    migration.slice(migration.indexOf(marker)).trim());
  const safetyMigration = fs.readFileSync(safetyMigrationPath, 'utf8');
  const p3Marker = '-- Package 3: current canonical timezone revision guard.';
  assert.equal(schema.slice(schema.indexOf(nextMarker), schema.indexOf(p3Marker)).trim(), safetyMigration.trim());
  const p3Migration = fs.readFileSync(timezoneGuardMigrationPath, 'utf8');
  const crmAuthorityMarker = '-- Canonical CRM supersession authority.';
  assert.equal(schema.slice(schema.indexOf(p3Marker), schema.indexOf(crmAuthorityMarker)).trim(),
    p3Migration.trim());
  assert.match(p3Migration, /v_opportunity_status <> 'active'/);
});

test('P1C Supabase adapter rejects contradictory transition authority', async () => {
  const cases = [
    ['transitionPursuitEnrollment', ['applied', 'staleRevision', 'conflict']],
    ['appendOpportunityTimezoneRevision', ['applied', 'replay', 'staleRevision']],
    ['recordCimCapabilityActivation', ['applied', 'replay', 'conflict']],
    ['withdrawCimCapabilityActivation', ['applied', 'replay', 'conflict']],
    ['claimDueCimTouch', ['claimed', 'alreadyOwned', 'staleAuthority', 'terminal', 'conflict']],
    ['recordOwnerDecision', ['applied', 'replay', 'conflict']],
    ['materializePursuitCampaign', ['applied', 'existing', 'actionRequired']],
    ['prepareCimTransmission', ['prepared', 'existing', 'payloadConflict', 'terminal']],
    ['issueCimLiveProviderAuthorization', ['issued', 'replay', 'conflict']],
    ['enterCimProviderSeam', ['entered', 'alreadyEntered', 'unauthorized']],
    ['finalizeCimTransmission', ['applied', 'existing', 'conflict']],
    ['reconcileCimTransmission', ['applied', 'unchanged', 'conflict']],
    ['withdrawCimLiveProviderAuthorization', ['applied', 'replay', 'conflict']],
    ['appendCimTerminalEvent', ['applied', 'replay', 'conflict']],
  ];
  for (const [method, flags] of cases) {
    const result = Object.fromEntries(flags.map((flag) => [flag, true]));
    Object.assign(result, { blockedReason: null, cancelledTouchIds: [],
      campaignRevision: null, conversationRevision: null });
    const storage = createSupabaseStorage({ storage: {} }, { client: {
      async rpc() { return { data: result, error: null }; },
    } });
    await assert.rejects(storage[method]({ boundaryNonceDigest: 'nonce' }),
      /Malformed Pursue CIM/, method);
  }
});

test('P1C Supabase adapter rejects missing success rows and unexpected authority fields', async () => {
  const cases = [
    ['transitionPursuitEnrollment', { applied: true, staleRevision: false,
      conflict: false, enrollment: null }],
    ['appendOpportunityTimezoneRevision', { applied: true, replay: false,
      staleRevision: false, timezoneRevision: null }],
    ['recordCimCapabilityActivation', { applied: true, replay: false,
      conflict: false, blockedReason: null, activation: null }],
    ['claimDueCimTouch', { claimed: true, alreadyOwned: false,
      staleAuthority: false, terminal: false, conflict: false, touch: null }],
    ['prepareCimTransmission', { prepared: true, existing: false,
      payloadConflict: false, terminal: false, transmission: null }],
    ['issueCimLiveProviderAuthorization', { issued: true, replay: false,
      conflict: false, blockedReason: null, authorization: null }],
    ['finalizeCimTransmission', { applied: true, existing: false,
      conflict: false, transmission: null, nextTouch: null }],
    ['reconcileCimTransmission', { applied: true, unchanged: false,
      conflict: false, transmission: null }],
  ];
  for (const [method, data] of cases) {
    const storage = createSupabaseStorage({ storage: {} }, { client: {
      async rpc() { return { data, error: null }; },
    } });
    await assert.rejects(storage[method]({}), /Malformed Pursue CIM/, method);
  }
  const storage = createSupabaseStorage({ storage: {} }, { client: {
    async rpc() { return { data: { entered: true, alreadyEntered: false,
      unauthorized: false, providerCallAuthorized: true }, error: null }; },
  } });
  await assert.rejects(storage.enterCimProviderSeam({}), /Malformed Pursue CIM/);
});

function run(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function psql(container, database, sql) {
  return run(dockerCommand, [
    'exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', database,
  ], sql).trim();
}

function psqlIndependent(container, database, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], { cwd: root });
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim())
      : reject(new Error(error || output)));
    child.stdin.end(sql);
  });
}

function rejectedSql(container, database, sql) {
  return spawnSync(dockerCommand, [
    'exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', database,
  ], { cwd: root, encoding: 'utf8', input: sql });
}

function legacyFingerprint(container, database) {
  return JSON.parse(psql(container, database, `
    select jsonb_build_object(
      'aliases', (select jsonb_agg(to_jsonb(value) order by value.id)
        from public.deal_hunter_opportunity_aliases as value),
      'requests', (select jsonb_agg(to_jsonb(value) order by value.id)
        from public.deal_hunter_cim_requests as value),
      'communications', (select jsonb_agg(to_jsonb(value) order by value.id)
        from public.crm_communications as value),
      'providerEvents', (select jsonb_agg(to_jsonb(value) order by value.id)
        from public.email_events as value),
      'repairReceipts', (select jsonb_agg(to_jsonb(value) order by value.id)
        from public.deal_hunter_cim_repair_manifests as value),
      'pause', (select jsonb_agg(to_jsonb(value) order by value.id)
        from public.deal_hunter_cim_safety_settings as value),
      'historicalPursue', (select jsonb_agg(to_jsonb(value) order by value.id)
        from public.deal_hunter_cim_reviews as value)
    );
  `));
}

test('P1A PostgreSQL fresh and upgrade schemas enforce the inert catalog and security contract', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-pursue-cim-p1a-${process.pid}`;
  let started = false;
  t.after(() => {
    if (started) run(dockerCommand, ['rm', '-f', container]);
  });
  run(dockerCommand, [
    'run', '--rm', '--pull=never', '--network=none', '--tmpfs', '/var/lib/postgresql/data',
    '--name', container, '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16',
  ]);
  started = true;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = spawnSync(dockerCommand, ['logs', container], { encoding: 'utf8' });
    const readyEvents = `${logs.stdout}\n${logs.stderr}`
      .match(/database system is ready to accept connections/g)?.length || 0;
    const ready = spawnSync(dockerCommand, ['exec', container, 'pg_isready', '-U', 'postgres'], {
      encoding: 'utf8',
    });
    if (readyEvents >= 2 && ready.status === 0) break;
    if (attempt === 99) throw new Error('Disposable PostgreSQL did not become ready.');
    Atomics.wait(signal, 0, 0, 100);
  }
  psql(container, 'postgres', `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create database pursue_cim_fresh;
    create database pursue_cim_upgrade;
  `);

  const currentSchema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const baseSchema = execFileSync('git', ['show', `${baseSha}:supabase/schema.sql`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';
  psql(container, 'pursue_cim_fresh', currentSchema);
  psql(container, 'pursue_cim_upgrade', baseSchema);
  psql(container, 'pursue_cim_upgrade', `
    insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
    values ('opp-legacy', now(), now(), 'Legacy opportunity', 'cim-identity-v1');
    insert into public.deal_hunter_opportunity_aliases
      (id, opportunity_id, alias_type, alias_value, alias_key, first_observed_at,
       last_observed_at, evidence_version, resolution_method, confidence_state,
       resolved_by, metadata)
    values ('alias-legacy', 'opp-legacy', 'fingerprint-v1', 'legacy-fingerprint',
      'fingerprint-v1:legacy-fingerprint', now(), now(), 'cim-identity-evidence-v1',
      'new-opportunity', 'exact', 'fixture', '{"retained":true}'::jsonb);
    insert into public.deal_hunter_cim_requests
      (id, created_at, updated_at, deal_key, recipient_email, status,
       provider_message_id, request_state, delivery_state, metadata)
    values ('legacy-request', now(), now(), 'fingerprint:legacy',
      'legacy@example.test', 'sent', 'provider-legacy-1', 'provider_accepted',
      'accepted', '{"retained":true}'::jsonb);
    insert into public.crm_communications
      (id, deal_key, cim_request_id, direction, channel, source, kind, provider,
       provider_message_id, idempotency_key, to_addresses, subject, body_text,
       body_html_sanitized, occurred_at, created_at, updated_at, metadata)
    values ('legacy-communication', 'fingerprint:legacy', 'legacy-request',
      'outbound', 'email', 'deal-hunter', 'cim-initial', 'resend',
      'provider-legacy-1', 'legacy-idempotency', '["legacy@example.test"]'::jsonb,
      'Legacy subject', 'Legacy body', '<p>Legacy body</p>', now(), now(), now(),
      '{"retained":true}'::jsonb);
    insert into public.email_events
      (id, created_at, provider, event_type, message_id, provider_event_id, event_key,
       recipient_email, communication_id, source, metadata)
    values ('10000000-0000-4000-8000-000000000001', now(), 'resend',
      'email.delivered', 'provider-legacy-1', 'provider-event-legacy-1',
      'resend:provider-event-legacy-1', 'legacy@example.test', 'legacy-communication',
      'resend-webhook', '{"retained":true}'::jsonb);
    insert into public.deal_hunter_cim_repair_manifests
      (id, created_at, updated_at, mode, status, actor, backup_reference,
       checksum, manifest, metadata)
    values ('legacy-repair-receipt', now(), now(), 'apply', 'completed',
      'incident-owner', 'verified-backup', repeat('f', 64),
      '{"retained":true}'::jsonb, '{"retained":true}'::jsonb);
    insert into public.deal_hunter_cim_safety_settings
      (id, updated_at, outreach_paused, updated_by, metadata)
    values ('global', now(), true, 'release-owner', '{"retained":true}'::jsonb);
    insert into public.deal_hunter_cim_reviews
      (id, created_at, deal_key, decision, opportunity_id, actor, decision_at, metadata)
    values ('20000000-0000-4000-8000-000000000002', now(), 'fingerprint:legacy',
      'approved', 'opp-legacy', 'historical-admin', now(),
      '{"historicalPursue":true}'::jsonb);
  `);
  psql(container, 'pursue_cim_upgrade', `
    insert into public.contact_submissions
      (id, created_at, updated_at, status, delivery_provider, delivery_status,
       crm_status, source, ip_hash, name, email, message, deal_hunter_opportunity_id)
    values ('33333333-3333-4333-8333-333333333333', now(), now(), 'open',
      'none', 'not-attempted', 'active', 'synthetic', 'synthetic-ip',
      'Cutover owner', 'cutover@example.test', 'Cutover owner', 'opp-legacy');
    update public.deal_hunter_opportunities set primary_submission_id =
      '33333333-3333-4333-8333-333333333333' where opportunity_id = 'opp-legacy';
  `);
  const before = legacyFingerprint(container, 'pursue_cim_upgrade');
  psql(container, 'pursue_cim_upgrade', migration);
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(safetyMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(timezoneGuardMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(ownerCommandMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(crmAuthorityMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p4bMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p5MigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p6aMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p6bMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p6cMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p6cPolicyTupleMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p6dMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p7aMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p7bMigrationPath, 'utf8'));
  assert.deepEqual(JSON.parse(psql(container, 'pursue_cim_upgrade', `select coalesce(jsonb_agg(
    jsonb_build_object('revision',revision,'submission_id',submission_id)
    order by revision), '[]'::jsonb) from public.deal_hunter_crm_ownership_revisions
    where opportunity_id='opp-legacy';`)), [
    { revision: 1, submission_id: '33333333-3333-4333-8333-333333333333' },
  ], 'existing canonical primary gets one cutover baseline');

  for (const database of ['pursue_cim_fresh', 'pursue_cim_upgrade']) {
    const catalog = JSON.parse(psql(container, database, `
      select jsonb_build_object(
        'tables', (select jsonb_agg(c.relname order by c.relname)
          from pg_class as c join pg_namespace as n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and c.relname = any(array[${expectedTables.map((name) => `'${name}'`).join(',')}])) ,
        'rls', (select bool_and(c.relrowsecurity)
          from pg_class as c join pg_namespace as n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname = any(array[${expectedTables.map((name) => `'${name}'`).join(',')}])) ,
        'anon', (select bool_or(has_table_privilege('anon', format('public.%I', name), 'SELECT'))
          from unnest(array[${expectedTables.map((name) => `'${name}'`).join(',')}]) as name),
        'authenticated', (select bool_or(has_table_privilege('authenticated', format('public.%I', name), 'INSERT'))
          from unnest(array[${expectedTables.map((name) => `'${name}'`).join(',')}]) as name),
        'service', (select bool_and(has_table_privilege('service_role', format('public.%I', name), 'SELECT'))
          from unnest(array[${expectedTables.map((name) => `'${name}'`).join(',')}]) as name),
        'serviceWrite', (select bool_and(
            has_table_privilege('service_role', format('public.%I', name), 'INSERT')
            and has_table_privilege('service_role', format('public.%I', name), 'UPDATE')
            and has_table_privilege('service_role', format('public.%I', name), 'DELETE')
          ) from unnest(array[${expectedTables.map((name) => `'${name}'`).join(',')}]) as name),
        'serviceTruncate', (select bool_or(
            has_table_privilege('service_role', format('public.%I', name), 'TRUNCATE')
          ) from unnest(array[${expectedTables.map((name) => `'${name}'`).join(',')}]) as name),
        'idsNotNull', (select bool_and(a.attnotnull)
          from pg_attribute as a
          join pg_class as c on c.oid = a.attrelid
          join pg_namespace as n on n.oid = c.relnamespace
          where n.nspname = 'public' and a.attname = 'id' and not a.attisdropped
            and c.relname = any(array[${singleIdTables.map((name) => `'${name}'`).join(',')}])),
        'activeIndex', to_regclass('public.uq_deal_hunter_cim_campaigns_active_opportunity') is not null,
        'membershipIndex', to_regclass('public.uq_deal_hunter_cim_transmission_touches_active_touch') is not null
      );
    `));
    assert.deepEqual(catalog.tables, expectedTables);
    assert.equal(catalog.rls, true);
    assert.equal(catalog.anon, false);
    assert.equal(catalog.authenticated, false);
    assert.equal(catalog.service, true);
    assert.equal(catalog.serviceWrite, true);
    assert.equal(catalog.serviceTruncate, false);
    assert.equal(catalog.idsNotNull, true);
    assert.equal(catalog.activeIndex, true);
    assert.equal(catalog.membershipIndex, true);
    for (const table of [
      'deal_hunter_owner_decision_events',
      'deal_hunter_pursuit_enrollments',
      'deal_hunter_cim_campaigns',
      'deal_hunter_cim_campaign_touches',
      'deal_hunter_cim_transmissions',
      'deal_hunter_cim_capability_activations',
    ]) {
      assert.equal(Number(psql(container, database, `select count(*) from public.${table};`)), 0, table);
    }
  }
  assert.deepEqual(legacyFingerprint(container, 'pursue_cim_upgrade'), before);

  assert.notEqual(rejectedSql(container, 'pursue_cim_upgrade', `
    set role service_role;
    truncate table public.deal_hunter_cim_audit_events;
  `).status, 0);

  psql(container, 'pursue_cim_upgrade', `
    insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
    values ('opp-p1a', now(), now(), 'P1A opportunity', 'cim-identity-v1');
    insert into public.deal_hunter_owner_decision_events
      (id, idempotency_key, request_digest, opportunity_id, action, actor,
       expected_discovery_revision, expected_material_revision,
       observed_discovery_revision, observed_material_revision, policy_version, created_at)
    values ('decision-1', 'idem-1', repeat('a', 64), 'opp-p1a', 'pursue',
      'fixture-owner', 0, 0, 0, 0, 'owner-decision-v1', now());
    insert into public.deal_hunter_pursuit_enrollments
      (id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
       created_at, updated_at, row_version)
    values ('enrollment-1', 'decision-1', 'opp-p1a', 'queued',
      'awaiting-orchestration', repeat('b', 64), now(), now(), 1);
    insert into public.deal_hunter_opportunity_timezone_revisions
      (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
       evidence_digest, resolver_version, dataset_digest, actor, created_at)
    values ('opp-p1a', 1, 'verified', 'America/Los_Angeles', 'operator-verified',
      'timezone-evidence', repeat('c', 64), 'explicit-v1', repeat('d', 64),
      'fixture-owner', now());
    insert into public.deal_hunter_broker_conversations
      (id, recipient_authority_id, recipient_fingerprint, recipient_address,
       sender_policy_version, reply_policy_version, reply_alias_token_digest,
       rfc_thread_key, state, terminal_revision, batching_policy_version,
       created_at, updated_at, row_version)
    values ('conversation-1', 'recipient-authority', repeat('e', 64),
      'broker@example.test', 'sender-v1', 'reply-v1', repeat('f', 64),
      'thread-1', 'open', 0, 'batching-off-v1', now(), now(), 1);
    insert into public.deal_hunter_cim_campaigns
      (id, opportunity_id, generation, enrollment_id, decision_event_id,
       policy_version, template_version, template_digest, permission_version,
       permission_digest, permission_revision, permission_scope, canonical_revision,
       crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
       freshness_authority_digest, discovery_revision, material_revision,
       timezone_revision, conversation_id, state, reason_code, terminal_revision,
       row_version, created_at, updated_at)
    values ('campaign-1', 'opp-p1a', 1, 'enrollment-1', 'decision-1',
      'deal-hunter-cim-autopilot-v1', 'template-v1', repeat('1',64),
      'permission-v1', repeat('2',64), 1, 'synthetic-cohort', 1, 1,
      'recipient-authority', repeat('e',64), repeat('3',64), 0, 0, 1,
      'conversation-1', 'initial-pending', 'awaiting-window', 0, 1, now(), now());
  `);
  assert.notEqual(rejectedSql(container, 'pursue_cim_upgrade', `
    insert into public.deal_hunter_owner_decision_events
      (id,idempotency_key,request_digest,opportunity_id,action,actor,
       expected_discovery_revision,expected_material_revision,
       observed_discovery_revision,observed_material_revision,policy_version,created_at)
    values (null,'null-id',repeat('a',64),'opp-p1a','pursue','fixture',
      0,0,0,0,'v1',now());
  `).status, 0);
  for (const [label, campaignId, scopeId] of [
    ['missing', 'null', "'campaign-1'"],
    ['mismatch', "'campaign-2'", "'campaign-1'"],
    ['nonexistent', "'campaign-missing'", "'campaign-missing'"],
  ]) {
    assert.notEqual(rejectedSql(container, 'pursue_cim_upgrade', `
      insert into public.deal_hunter_cim_terminal_events
        (id,scope,scope_id,campaign_id,revision,reason_code,evidence_type,evidence_id,
         observed_at,actor,source,metadata_digest,created_at)
      values ('terminal-${label}','campaign',${scopeId},${campaignId},1,'watch_selected',
        'owner-decision','decision-1',now(),'fixture','test',repeat('8',64),now());
    `).status, 0, label);
  }
  psql(container, 'pursue_cim_upgrade', `
    insert into public.deal_hunter_cim_terminal_events
      (id,scope,scope_id,campaign_id,revision,reason_code,evidence_type,evidence_id,
       observed_at,actor,source,metadata_digest,created_at)
    values ('terminal-valid','campaign','campaign-1','campaign-1',1,'watch_selected',
      'owner-decision','decision-1',now(),'fixture','test',repeat('8',64),now());
  `);
  const duplicateActive = rejectedSql(container, 'pursue_cim_upgrade', `
    insert into public.deal_hunter_cim_campaigns
      (id, opportunity_id, generation, enrollment_id, decision_event_id,
       policy_version, template_version, template_digest, permission_version,
       permission_digest, permission_revision, permission_scope, canonical_revision,
       crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
       freshness_authority_digest, discovery_revision, material_revision,
       timezone_revision, conversation_id, state, terminal_revision, row_version,
       created_at, updated_at)
    select 'campaign-2', opportunity_id, 2, enrollment_id, decision_event_id,
      policy_version, template_version, template_digest, permission_version,
      permission_digest, permission_revision, permission_scope, canonical_revision,
      crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
      freshness_authority_digest, discovery_revision, material_revision,
      timezone_revision, conversation_id, 'queued', 0, 1, now(), now()
    from public.deal_hunter_cim_campaigns where id='campaign-1';
  `);
  assert.notEqual(duplicateActive.status, 0);
  psql(container, 'pursue_cim_upgrade', `
    update public.deal_hunter_cim_campaigns set state='responded' where id='campaign-1';
    insert into public.deal_hunter_cim_campaigns
      (id, opportunity_id, generation, enrollment_id, decision_event_id,
       policy_version, template_version, template_digest, permission_version,
       permission_digest, permission_revision, permission_scope, canonical_revision,
       crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
       freshness_authority_digest, discovery_revision, material_revision,
       timezone_revision, conversation_id, state, terminal_revision, row_version,
       created_at, updated_at)
    select 'campaign-2', opportunity_id, 2, enrollment_id, decision_event_id,
      policy_version, template_version, template_digest, permission_version,
      permission_digest, permission_revision, permission_scope, canonical_revision,
      crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
      freshness_authority_digest, discovery_revision, material_revision,
      timezone_revision, conversation_id, 'stopped', 0, 1, now(), now()
    from public.deal_hunter_cim_campaigns where id='campaign-1';
  `);
  assert.equal(Number(psql(container, 'pursue_cim_upgrade', `
    select count(*) from public.deal_hunter_cim_campaigns where opportunity_id='opp-p1a';
  `)), 2);
  assert.notEqual(rejectedSql(container, 'pursue_cim_upgrade', `
    update public.deal_hunter_owner_decision_events set actor='tampered' where id='decision-1';
  `).status, 0);
  assert.notEqual(rejectedSql(container, 'pursue_cim_upgrade', `
    insert into public.deal_hunter_owner_decision_events
      (id,idempotency_key,request_digest,opportunity_id,action,actor,
       expected_discovery_revision,expected_material_revision,
       observed_discovery_revision,observed_material_revision,policy_version,created_at)
    values ('bad-action','bad-action',repeat('a',64),'opp-p1a','send','fixture',
      0,0,0,0,'v1',now());
  `).status, 0);
  psql(container, 'pursue_cim_upgrade', `
    insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
    values ('opp-ownership-history', now(), now(), 'Ownership history', 'cim-identity-v1');
    insert into public.contact_submissions
      (id, created_at, updated_at, status, delivery_provider, delivery_status,
       crm_status, source, ip_hash, name, email, message)
    values ('44444444-4444-4444-8444-444444444444', now(), now(), 'open',
      'none', 'not-attempted', 'active', 'synthetic', 'synthetic-ip',
      'Owner A', 'owner-a@example.test', 'Owner A'),
      ('55555555-5555-4555-8555-555555555555', now(), now(), 'open',
      'none', 'not-attempted', 'active', 'synthetic', 'synthetic-ip',
      'Owner B', 'owner-b@example.test', 'Owner B');
  `);
  const ownershipHistory = () => JSON.parse(psql(container, 'pursue_cim_upgrade', `
    select coalesce(jsonb_agg(jsonb_build_object('revision',revision,
      'submission_id',submission_id) order by revision), '[]'::jsonb)
    from public.deal_hunter_crm_ownership_revisions
    where opportunity_id='opp-ownership-history';`));
  assert.deepEqual(ownershipHistory(), [{ revision: 1, submission_id: null }]);
  psql(container, 'pursue_cim_upgrade', `update public.deal_hunter_opportunities
    set primary_submission_id='44444444-4444-4444-8444-444444444444'
    where opportunity_id='opp-ownership-history';`);
  assert.deepEqual(ownershipHistory().at(-1),
    { revision: 2, submission_id: '44444444-4444-4444-8444-444444444444' });
  psql(container, 'pursue_cim_upgrade', `
    update public.contact_submissions set deal_hunter_opportunity_id='opp-ownership-history',
      metadata='{"dealHunter":{"opportunityId":"opp-ownership-history"}}'::jsonb,
      status='archived' where id='44444444-4444-4444-8444-444444444444';
    update public.deal_hunter_opportunities set primary_submission_id=primary_submission_id
      where opportunity_id='opp-ownership-history';`);
  assert.equal(ownershipHistory().length, 2,
    'backlink, metadata, archive, and same-value writes do not change primary selection');
  psql(container, 'pursue_cim_upgrade', `update public.deal_hunter_opportunities
    set primary_submission_id='55555555-5555-4555-8555-555555555555'
    where opportunity_id='opp-ownership-history';`);
  assert.deepEqual(ownershipHistory().at(-1),
    { revision: 3, submission_id: '55555555-5555-4555-8555-555555555555' });
  psql(container, 'pursue_cim_upgrade', `update public.deal_hunter_opportunities
    set primary_submission_id=null where opportunity_id='opp-ownership-history';`);
  assert.deepEqual(ownershipHistory().at(-1), { revision: 4, submission_id: null });
});

test('P1C enrollment RPC matches SQLite legal, stale, and illegal transition outcomes in fresh and upgrade databases', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, async (t) => {
  const container = `uckele-pursue-cim-p1c-${process.pid}`;
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  run(dockerCommand, [
    'run', '--rm', '--pull=never', '--network=none', '--tmpfs', '/var/lib/postgresql/data',
    '--name', container, '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16',
  ]);
  t.after(() => run(dockerCommand, ['rm', '-f', container]));
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = spawnSync(dockerCommand, ['logs', container], { encoding: 'utf8' });
    const readyEvents = `${logs.stdout}\n${logs.stderr}`
      .match(/database system is ready to accept connections/g)?.length || 0;
    const ready = spawnSync(dockerCommand, ['exec', container, 'pg_isready', '-U', 'postgres'], {
      encoding: 'utf8',
    });
    if (readyEvents >= 2 && ready.status === 0) break;
    if (attempt === 99) throw new Error('Disposable PostgreSQL did not become ready.');
    Atomics.wait(signal, 0, 0, 100);
  }
  psql(container, 'postgres', `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create database pursue_cim_fresh;
    create database pursue_cim_upgrade;
  `);
  const currentSchema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const baseSchema = execFileSync('git', ['show', `${baseSha}:supabase/schema.sql`], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const migration = fs.readFileSync(migrationPath, 'utf8');
  psql(container, 'pursue_cim_fresh', currentSchema);
  psql(container, 'pursue_cim_upgrade', baseSchema);
  psql(container, 'pursue_cim_upgrade', migration);
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(safetyMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(timezoneGuardMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(ownerCommandMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(crmAuthorityMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p4bMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p5MigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p6aMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p6bMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p6cMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p6cPolicyTupleMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p6dMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p7aMigrationPath, 'utf8'));
  psql(container, 'pursue_cim_upgrade', fs.readFileSync(p7bMigrationPath, 'utf8'));

  const now = '2026-09-25T19:00:00.000Z';
  const parityRecipient = { email: 'broker2@example.test',
    provenanceFingerprint: 'd'.repeat(64),
    permissionProvenanceFingerprint: 'e'.repeat(64),
    contactAuthorityRevision: 'c'.repeat(64) };
  const parityRecipientFingerprint = sha256(stableCanonicalJson({ opportunityId: 'opp-decision',
    emailHash: sha256(parityRecipient.email),
    provenanceFingerprint: parityRecipient.provenanceFingerprint,
    contactAuthorityRevision: parityRecipient.contactAuthorityRevision }));
  const commands = [
    { enrollmentId: 'enrollment-parity', expectedRowVersion: 1, nextState: 'waiting-on-eligibility', actor: 'fixture', now },
    { enrollmentId: 'enrollment-parity', expectedRowVersion: 1, nextState: 'action-required', actor: 'fixture', now },
    { enrollmentId: 'enrollment-parity', expectedRowVersion: 2, nextState: 'responded', actor: 'fixture', now },
  ];
  const timezoneCommands = [
    { opportunityId: 'opp-parity', idempotencyKey: 'timezone-parity', expectedPriorRevision: 0,
      state: 'verified', ianaTimezone: 'America/Los_Angeles', evidenceType: 'operator-verified',
      evidenceId: 'timezone-evidence', evidenceDigest: 'c'.repeat(64),
      resolverVersion: 'explicit-v1', datasetDigest: 'd'.repeat(64), actor: 'fixture', now },
    { opportunityId: 'opp-parity', idempotencyKey: 'timezone-parity', expectedPriorRevision: 0,
      state: 'verified', ianaTimezone: 'America/Los_Angeles', evidenceType: 'operator-verified',
      evidenceId: 'timezone-evidence', evidenceDigest: 'c'.repeat(64),
      resolverVersion: 'explicit-v1', datasetDigest: 'd'.repeat(64), actor: 'fixture', now },
    { opportunityId: 'opp-parity', idempotencyKey: 'timezone-parity', expectedPriorRevision: 0,
      state: 'derived', ianaTimezone: 'America/Los_Angeles', evidenceType: 'operator-verified',
      evidenceId: 'timezone-evidence', evidenceDigest: 'c'.repeat(64),
      resolverVersion: 'explicit-v1', datasetDigest: 'd'.repeat(64), actor: 'fixture', now },
  ];
  const activationCommands = [
    { id: 'activation-safety', capability: 'fl04a-safety', mode: 'active',
      policyHash: 'a'.repeat(64), configHash: 'b'.repeat(64), actor: 'fixture',
      reason: 'disposable parity', confirmation: 'fixture-confirmation',
      providerProfile: 'synthetic-provider', now },
    { id: 'activation-safety', capability: 'fl04a-safety', mode: 'active',
      policyHash: 'a'.repeat(64), configHash: 'b'.repeat(64), actor: 'fixture',
      reason: 'disposable parity', confirmation: 'fixture-confirmation',
      providerProfile: 'synthetic-provider', now },
    { id: 'activation-enrollment', capability: 'fl04b-enrollment', mode: 'active',
      prerequisiteActivationId: 'missing-activation', prerequisiteEvidenceId: 'evidence-1',
      prerequisiteEvidenceHash: 'c'.repeat(64), policyHash: 'a'.repeat(64),
      cohortDigest: '4'.repeat(64), permissionBasisDigest: '2'.repeat(64), permissionRevision: 1,
      configHash: 'b'.repeat(64), actor: 'fixture', reason: 'disposable parity',
      confirmation: 'fixture-confirmation', providerProfile: 'synthetic-provider', now },
    { id: 'activation-enrollment', capability: 'fl04b-enrollment', mode: 'active',
      prerequisiteActivationId: 'activation-safety', prerequisiteEvidenceId: 'evidence-1',
      prerequisiteEvidenceHash: 'c'.repeat(64), policyHash: 'a'.repeat(64),
      cohortDigest: '4'.repeat(64), permissionBasisDigest: '2'.repeat(64), permissionRevision: 1,
      configHash: 'b'.repeat(64), actor: 'fixture', reason: 'disposable parity',
      confirmation: 'fixture-confirmation', providerProfile: 'synthetic-provider', now },
    { id: 'activation-initial', capability: 'fl04b-initial', mode: 'active',
      prerequisiteActivationId: 'activation-enrollment', prerequisiteEvidenceId: 'evidence-2',
      prerequisiteEvidenceHash: 'c'.repeat(64), policyHash: 'a'.repeat(64),
      cohortDigest: '4'.repeat(64), permissionBasisDigest: '2'.repeat(64),
      permissionRevision: 1,
      configHash: 'b'.repeat(64), actor: 'fixture', reason: 'disposable parity',
      confirmation: 'fixture-confirmation', providerProfile: 'synthetic-provider', now },
  ];
  const claimCommands = [
    { touchId: 'touch-parity', expectedRowVersion: 1,
      expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
      claimTokenDigest: '4'.repeat(64), claimOwner: 'fixture-owner',
      claimExpiresAt: '2026-09-25T20:00:00.000Z', now },
    { touchId: 'touch-parity', expectedRowVersion: 1,
      expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
      claimTokenDigest: '4'.repeat(64), claimOwner: 'fixture-owner',
      claimExpiresAt: '2026-09-25T20:00:00.000Z', now },
    { touchId: 'touch-parity', expectedRowVersion: 1,
      expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
      claimTokenDigest: '5'.repeat(64), claimOwner: 'other-owner',
      claimExpiresAt: '2026-09-25T20:00:00.000Z', now },
    { touchId: 'touch-parity', expectedRowVersion: 1,
      expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
      claimTokenDigest: '5'.repeat(64), claimOwner: 'other-owner',
      claimExpiresAt: '2026-09-25T22:00:00.000Z', now: '2026-09-25T21:00:00.000Z' },
    { touchId: 'touch-parity', expectedRowVersion: 2,
      expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
      claimTokenDigest: '5'.repeat(64), claimOwner: 'other-owner',
      claimExpiresAt: '2026-09-25T22:00:00.000Z', now: '2026-09-25T21:00:00.000Z' },
  ];
  const safetyRuns = [
    { safetyRunId: 'safety-run-parity', sourceType: 'synthetic-sheet',
      sourceRunId: 'source-run-parity', now,
      events: [{ opportunityId: 'opp-parity', canonicalRevision: 1,
        identityExceptionRevision: 0, eventType: 'source-stale', evidenceId: 'evidence-parity' }] },
    { safetyRunId: 'safety-run-parity', sourceType: 'synthetic-sheet',
      sourceRunId: 'source-run-parity', now,
      events: [{ opportunityId: 'opp-parity', canonicalRevision: 1,
        identityExceptionRevision: 0, eventType: 'source-stale', evidenceId: 'evidence-parity' }] },
    { safetyRunId: 'safety-run-parity', sourceType: 'synthetic-sheet',
      sourceRunId: 'source-run-parity', now,
      events: [{ opportunityId: 'opp-parity', canonicalRevision: 2,
        identityExceptionRevision: 0, eventType: 'source-stale', evidenceId: 'evidence-parity' }] },
  ];
  const ownerCommands = [
    { opportunityId: 'opp-decision', action: 'pursue', idempotencyKey: 'owner-decision-1',
      actor: 'fixture-owner', policyVersion: 'owner-v1', now,
      expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 },
    { opportunityId: 'opp-decision', action: 'pursue', idempotencyKey: 'owner-decision-1',
      actor: 'fixture-owner', policyVersion: 'owner-v1', now,
      expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 },
    { opportunityId: 'opp-decision', action: 'watch', idempotencyKey: 'owner-decision-1',
      actor: 'fixture-owner', policyVersion: 'owner-v1', now,
      expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 },
    { opportunityId: 'opp-decision', action: 'pursue', idempotencyKey: 'owner-decision-2',
      actor: 'fixture-owner', policyVersion: 'owner-v1', now,
      expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 },
    { opportunityId: 'opp-decision', action: 'pursue', idempotencyKey: 'owner-decision-3',
      actor: 'fixture-owner', policyVersion: 'owner-v1', now,
      expectedDiscoveryRevision: 1, expectedMaterialRevision: 0 },
  ];
  const ownerStopCommands = [
    { opportunityId: 'opp-parity', action: 'watch', idempotencyKey: 'owner-watch-parity',
      actor: 'fixture-owner', policyVersion: 'owner-v1', now,
      expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 },
    { opportunityId: 'opp-parity', action: 'pass', idempotencyKey: 'owner-pass-parity',
      actor: 'fixture-owner', policyVersion: 'owner-v1', reason: 'not a fit', now,
      expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 },
  ];
  const campaignCommand = { opportunityId: 'opp-decision', expectedEnrollmentRowVersion: 1,
    generation: 1, policyVersion: 'deal-hunter-cim-autopilot-v1',
    templateVersion: 'deal-hunter-cim-autopilot-v1',
    templateDigest: '1'.repeat(64), permissionVersion: 'activation-enrollment',
    permissionDigest: '2'.repeat(64), permissionRevision: 1,
    permissionScope: '4'.repeat(64), policyHash: 'a'.repeat(64), canonicalRevision: 1,
    crmSubmissionId: '11111111-1111-4111-8111-111111111111', crmOwnershipRevision: 2,
    crmBrokerEmail: null,
    campaignAuthorityRevision: 1,
    globalAuthorityRevision: 1,
    recipientAuthorityId: 'recipient-materialize', recipientFingerprint: parityRecipientFingerprint,
    recipientAddress: 'broker2@example.test',
    senderPolicyVersion: 'deal-hunter-cim-autopilot-v1',
    replyPolicyVersion: 'deal-hunter-cim-autopilot-v1', replyAliasTokenDigest: '9'.repeat(64),
    rfcThreadKey: 'thread-materialize', batchingPolicyVersion: 'batching-off-v1',
    freshnessAuthorityDigest: '3'.repeat(64), expectedDiscoveryRevision: 0,
    expectedMaterialRevision: 0, timezoneRevision: 1,
    cadencePolicyVersion: 'cadence-v1', dueAt: now,
    dueLocal: '2026-09-25T12:00:00-07:00', actor: 'fixture', now };
  const campaignCommands = [campaignCommand, { ...campaignCommand },
    { ...campaignCommand, templateDigest: '4'.repeat(64) }];
  const withdrawalCommand = { id: 'activation-safety', actor: 'fixture',
    reason: 'fixture withdrawal', now };
  const reference = JSON.parse(run(process.execPath,
    ['--expose-gc', 'test/fixtures/pursueCimParitySqlite.js'],
    JSON.stringify({ now, commands, timezoneCommands, activationCommands,
      claimCommands, safetyRuns, ownerCommands, ownerStopCommands,
      campaignCommands, withdrawalCommand, parityRecipient })));
  const { expected, expectedTimezone, expectedActivations, expectedClaims,
    expectedProjection, expectedSafetyEmissions, expectedOwnerDecisions,
    expectedOwnerStops, expectedCampaigns, expectedWithdrawals } = reference;
  for (const database of ['pursue_cim_fresh', 'pursue_cim_upgrade']) {
    const runCommittedOwnerRace = async ({ stage, opportunityId, campaignId, touchId,
      transitionName, transitionCommand, transmissionId = null, authorizationId = null }) => {
      for (const action of ['watch', 'pass']) {
        const raceDatabase = `p4a_${database.endsWith('fresh') ? 'f' : 'u'}_${stage}_${action}`;
        run(dockerCommand, ['exec', container, 'createdb', '-U', 'postgres',
          '-T', database, raceDatabase]);
        if (stage === 'authorized') psql(container, raceDatabase, `insert into
          public.deal_hunter_cim_safety_settings
          (id, updated_at, outreach_paused, updated_by, metadata)
          values ('global', '${now}', false, 'fixture', '{}'::jsonb);`);
        const ownerAuditsBefore = Number(psql(container, raceDatabase, `select count(*)
          from public.deal_hunter_cim_audit_events
          where event_type='owner-decision' and opportunity_id='${opportunityId}';`));
        const ownerCommand = { opportunityId, action,
          idempotencyKey: `p4a-race-${database}-${stage}-${action}`, actor: 'fixture-owner',
          policyVersion: 'owner-v1', now, expectedDiscoveryRevision: 0,
          expectedMaterialRevision: 0,
          ...(action === 'pass' ? { reason: 'not a fit', note: 'Owner declined.' } : {}) };
        const committedRpc = (name, command) => new Promise((resolve, reject) => {
          const payload = JSON.stringify(command).replaceAll("'", "''");
          const child = spawn(dockerCommand, ['exec', '-i', container, 'psql',
            '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', raceDatabase,
            '-c', `set role service_role;
              select public.${name}('${payload}'::jsonb);`],
          { stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => { stdout += chunk; });
          child.stderr.on('data', (chunk) => { stderr += chunk; });
          child.once('error', reject);
          child.once('exit', (code) => code === 0 ? resolve(JSON.parse(stdout.trim()))
            : reject(new Error(`${raceDatabase}:${name}: ${stderr}`)));
        });
        const [owner, transition] = await Promise.all([
          committedRpc('pursue_cim_record_owner_decision_v1', ownerCommand),
          committedRpc(transitionName, transitionCommand),
        ]);
        assert.equal(owner.applied, true, raceDatabase);
        const state = JSON.parse(psql(container, raceDatabase, `select jsonb_build_object(
          'revision', (select terminal_revision from public.deal_hunter_cim_campaigns
            where id='${campaignId}'),
          'terminalEvents', (select count(*) from public.deal_hunter_cim_terminal_events
            where campaign_id='${campaignId}'),
          'ownerAudits', (select count(*) from public.deal_hunter_cim_audit_events
            where event_type='owner-decision' and opportunity_id='${opportunityId}'),
          'touch', (select state from public.deal_hunter_cim_campaign_touches
            where id='${touchId}'),
          'transmission', (select state from public.deal_hunter_cim_transmissions
            where id='${transmissionId || ''}'),
          'inFlightRaces', (select count(*) from public.deal_hunter_cim_audit_events
            where event_type='terminal-in-flight-race' and transmission_id='${transmissionId || ''}'),
          'authorizationWithdrawn', (select withdrawn_at is not null
            from public.deal_hunter_cim_live_provider_authorizations
            where id='${authorizationId || ''}'));`));
        assert.equal(state.revision, 1, raceDatabase);
        assert.equal(state.terminalEvents, 1, raceDatabase);
        assert.equal(state.ownerAudits, ownerAuditsBefore + 1, raceDatabase);
        if (stage === 'authorized' && transition.authorized) {
          assert.equal(state.touch, 'provider-pending',
            `${raceDatabase}: ${JSON.stringify({ transition, state })}`);
          assert.equal(state.transmission, 'provider-pending',
            `${raceDatabase}: ${JSON.stringify({ transition, state })}`);
          assert.equal(state.inFlightRaces, 1, raceDatabase);
        } else {
          assert.equal(state.touch, 'cancelled-before-provider', raceDatabase);
          if (transmissionId) assert.equal(state.transmission, 'cancelled-before-provider', raceDatabase);
          if (authorizationId) assert.equal(state.authorizationWithdrawn, true, raceDatabase);
        }
      }
    };
    const assertOwnerFencesStage = ({ stage, opportunityId, campaignId, touchId,
      transmissionId = null, authorizationId = null }) => {
      for (const action of ['watch', 'pass']) {
        const command = { opportunityId, action,
          idempotencyKey: `p4a-${database}-${stage}-${action}`, actor: 'fixture-owner',
          policyVersion: 'owner-v1', now, expectedDiscoveryRevision: 0,
          expectedMaterialRevision: 0,
          ...(action === 'pass' ? { reason: 'not a fit', note: 'Owner declined.' } : {}) };
        const payload = JSON.stringify(command).replaceAll("'", "''");
        const output = psql(container, database, `begin; set local role service_role;
          select public.pursue_cim_record_owner_decision_v1('${payload}'::jsonb);
          reset role;
          select jsonb_build_object(
            'campaignState', (select state from public.deal_hunter_cim_campaigns where id='${campaignId}'),
            'terminalRevision', (select terminal_revision from public.deal_hunter_cim_campaigns where id='${campaignId}'),
            'touchState', (select state from public.deal_hunter_cim_campaign_touches where id='${touchId}'),
            'transmissionState', (select state from public.deal_hunter_cim_transmissions where id='${transmissionId || ''}'),
            'authorizationWithdrawn', (select withdrawn_at is not null from public.deal_hunter_cim_live_provider_authorizations where id='${authorizationId || ''}'));
          rollback;`);
        const [result, state] = output.split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
        assert.equal(result.applied, true, `${database}:${stage}:${action}`);
        assert.equal(state.campaignState, 'stopped');
        assert.equal(state.terminalRevision, 1);
        assert.equal(state.touchState, 'cancelled-before-provider');
        if (transmissionId) assert.equal(state.transmissionState, 'cancelled-before-provider');
        if (authorizationId) assert.equal(state.authorizationWithdrawn, true);
      }
    };
    psql(container, database, `
      insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('opp-parity', '${now}', '${now}', 'Synthetic parity', 'cim-identity-v1');
      insert into public.deal_hunter_owner_decision_events
        (id, idempotency_key, request_digest, opportunity_id, action, actor,
         expected_discovery_revision, expected_material_revision, observed_discovery_revision,
         observed_material_revision, policy_version, created_at)
      values ('decision-parity', 'idem-parity', repeat('a',64), 'opp-parity', 'pursue',
        'fixture', 0, 0, 0, 0, 'v1', '${now}');
      insert into public.deal_hunter_pursuit_enrollments
        (id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
         created_at, updated_at, row_version)
      values ('enrollment-parity', 'decision-parity', 'opp-parity', 'queued',
        'awaiting-orchestration', repeat('b',64), '${now}', '${now}', 1);
    `);
    const privileges = JSON.parse(psql(container, database, `select jsonb_build_object(
      'public', has_function_privilege('public', 'public.pursue_cim_transition_enrollment_v1(jsonb)', 'EXECUTE'),
      'anon', has_function_privilege('anon', 'public.pursue_cim_transition_enrollment_v1(jsonb)', 'EXECUTE'),
      'authenticated', has_function_privilege('authenticated', 'public.pursue_cim_transition_enrollment_v1(jsonb)', 'EXECUTE'),
      'service', has_function_privilege('service_role', 'public.pursue_cim_transition_enrollment_v1(jsonb)', 'EXECUTE')
    );`));
    assert.deepEqual(privileges, { public: false, anon: false, authenticated: false, service: true });
    const rpcPrivileges = JSON.parse(psql(container, database, `select jsonb_agg(
      jsonb_build_object('name', p.proname,
        'public', has_function_privilege('public', p.oid, 'EXECUTE'),
        'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
        'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
        'service', has_function_privilege('service_role', p.oid, 'EXECUTE'),
        'fixedSearchPath', exists (select 1 from pg_catalog.unnest(p.proconfig) as setting
          where setting like 'search_path=%'
            and pg_catalog.replace(pg_catalog.split_part(setting, '=', 2), '"', '') = ''),
        'securityDefiner', p.prosecdef) order by p.proname)
      from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'pursue_cim_%_v1';`));
    assert.deepEqual(rpcPrivileges.map((row) => row.name), expectedP1cFunctions, database);
    for (const rpc of rpcPrivileges) {
      assert.deepEqual({ public: rpc.public, anon: rpc.anon,
        authenticated: rpc.authenticated, service: rpc.service,
        fixedSearchPath: rpc.fixedSearchPath },
      { public: false, anon: false, authenticated: false,
        service: !['pursue_cim_apply_accepted_cadence_v1',
          'pursue_cim_cancel_prepared_transmission_v1',
          'pursue_cim_emit_admitted_import_safety_v1',
          'pursue_cim_authorize_provider_pending_p5_v1',
          'pursue_cim_expected_initial_expiry_v1',
          'pursue_cim_finalize_transmission_v1',
          'pursue_cim_reconcile_transmission_v1',
          'pursue_cim_resolve_local_instant_v1',
          'pursue_cim_validate_accepted_cadence_v1'].includes(rpc.name),
        fixedSearchPath: true }, `${database}:${rpc.name}`);
      if (!['pursue_cim_assert_types_v1', 'pursue_cim_canonical_json_v1',
        'pursue_cim_current_activation_v1', 'pursue_cim_digest_v1',
        'pursue_cim_json_stringify_v1', 'pursue_cim_required_revision_v1',
        'pursue_cim_required_text_v1', 'pursue_cim_required_instant_v1'].includes(rpc.name)) {
        assert.equal(rpc.securityDefiner, true, `${database}:${rpc.name}`);
      }
    }
    const terminalWriterDatabase = `p7b_writers_${database.endsWith('fresh') ? 'f' : 'u'}`;
    run(dockerCommand, ['exec', container, 'createdb', '-U', 'postgres',
      '-T', database, terminalWriterDatabase]);
    const seedTerminalWriter = ({ suffix, submissionId, recipient }) => {
      psql(container, terminalWriterDatabase, `
        insert into public.deal_hunter_opportunities
          (opportunity_id, created_at, updated_at, canonical_name, identity_version)
        values ('opp-p7b-${suffix}', '${now}', '${now}', 'P7B ${suffix}', 'cim-identity-v1');
        insert into public.contact_submissions
          (id, created_at, updated_at, status, delivery_provider, delivery_status,
           crm_status, source, ip_hash, name, email, message, deal_hunter_opportunity_id)
        values ('${submissionId}', '${now}', '${now}', 'open', 'none', 'not-attempted',
          'active', 'synthetic', 'synthetic-ip', 'P7B broker', '${recipient}',
          'P7B fixture', 'opp-p7b-${suffix}');
        update public.deal_hunter_opportunities set primary_submission_id='${submissionId}'
          where opportunity_id='opp-p7b-${suffix}';
        insert into public.deal_hunter_owner_decision_events
          (id, idempotency_key, request_digest, opportunity_id, action, actor,
           expected_discovery_revision, expected_material_revision,
           observed_discovery_revision, observed_material_revision, policy_version, created_at)
        values ('decision-p7b-${suffix}', 'idem-p7b-${suffix}', repeat('a',64),
          'opp-p7b-${suffix}', 'pursue', 'fixture', 0, 0, 0, 0, 'v1', '${now}');
        insert into public.deal_hunter_pursuit_enrollments
          (id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
           created_at, updated_at)
        values ('enrollment-p7b-${suffix}', 'decision-p7b-${suffix}',
          'opp-p7b-${suffix}', 'campaign-created', 'fixture', repeat('b',64), '${now}', '${now}');
        insert into public.deal_hunter_opportunity_timezone_revisions
          (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
           evidence_digest, resolver_version, dataset_digest, actor, created_at)
        values ('opp-p7b-${suffix}', 1, 'verified', 'America/Los_Angeles',
          'operator-verified', 'timezone-p7b-${suffix}', repeat('c',64), 'explicit-v1',
          repeat('d',64), 'fixture', '${now}');
        insert into public.deal_hunter_broker_conversations
          (id, recipient_authority_id, recipient_fingerprint, recipient_address,
           sender_policy_version, reply_policy_version, reply_alias_token_digest,
           rfc_thread_key, state, batching_policy_version, created_at, updated_at)
        values ('conversation-p7b-${suffix}', 'recipient-p7b-${suffix}', repeat('e',64),
          '${recipient}', 'sender-v1', 'reply-v1', public.pursue_cim_digest_v1(
            to_jsonb('reply-p7b'::text), to_jsonb('${suffix}'::text)), 'thread-p7b-${suffix}',
          'open', 'batching-off-v1', '${now}', '${now}');
        insert into public.deal_hunter_cim_campaigns
          (id, opportunity_id, generation, enrollment_id, decision_event_id,
           policy_version, template_version, template_digest, permission_version,
           permission_digest, permission_revision, permission_scope, canonical_revision,
           crm_ownership_revision, crm_submission_id, recipient_authority_id,
           recipient_fingerprint, freshness_authority_digest, discovery_revision,
           material_revision, timezone_revision, conversation_id, state, reason_code,
           created_at, updated_at)
        values ('campaign-p7b-${suffix}', 'opp-p7b-${suffix}', 1,
          'enrollment-p7b-${suffix}', 'decision-p7b-${suffix}', 'policy-v1',
          'template-v1', repeat('1',64), 'permission-v1', repeat('2',64), 1,
          'synthetic-cohort', 1, 1, '${submissionId}', 'recipient-p7b-${suffix}',
          repeat('e',64), repeat('3',64), 0, 0, 1, 'conversation-p7b-${suffix}',
          'initial-pending', 'awaiting-window', '${now}', '${now}');
        insert into public.deal_hunter_cim_campaign_touches
          (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at,
           due_local, timezone_revision, state, created_at, updated_at)
        values ('touch-p7b-${suffix}', 'campaign-p7b-${suffix}', 'opp-p7b-${suffix}',
          'initial', 'initial', 0, '${now}', '2026-09-25T12:00:00-07:00', 1,
          'scheduled', '${now}', '${now}');
      `);
    };
    const writerCases = [
      { suffix: 'archive', submissionId: '70000000-0000-4000-8000-000000000001',
        recipient: 'p7b-archive@example.test', reason: 'crm_archived', evidence: 'crm-archive',
        mutate: `update public.contact_submissions set status='archived', archived_at='${now}',
          archived_by='fixture', updated_at='${now}'
          where id='70000000-0000-4000-8000-000000000001'` },
      { suffix: 'diligence', submissionId: '70000000-0000-4000-8000-000000000002',
        recipient: 'p7b-diligence@example.test', reason: 'advanced_beyond_broker_outreach',
        evidence: 'diligence',
        mutate: `update public.contact_submissions set metadata=
          '{"diligence":{"stage":" financial review ","decision":"advance"}}'::jsonb,
          updated_at='${now}' where id='70000000-0000-4000-8000-000000000002'` },
      { suffix: 'materials', submissionId: '70000000-0000-4000-8000-000000000005',
        recipient: 'p7b-materials@example.test', reason: 'materials_received',
        evidence: 'materials',
        preMutate: `insert into public.secure_upload_requests
            (id, submission_id, created_at, updated_at, email, status, expires_at,
             requested_documents)
          values ('71000000-0000-4000-8000-000000000005',
            '70000000-0000-4000-8000-000000000005', '${now}', '${now}',
            'p7b-materials@example.test', 'open', '2026-09-26T19:00:00.000Z', '[]'::jsonb);
          insert into public.secure_documents
            (id, request_id, submission_id, created_at, document_type, file_name,
             original_name, mime_type, size_bytes, storage_path)
          values ('72000000-0000-4000-8000-000000000005',
            '71000000-0000-4000-8000-000000000005',
            '70000000-0000-4000-8000-000000000005', '${now}', 'nda', 'nda.pdf',
            'Signed NDA.pdf', 'application/pdf', 100, '/synthetic/nda.pdf');
          insert into public.secure_documents
            (id, request_id, submission_id, created_at, document_type, file_name,
             original_name, mime_type, size_bytes, storage_path)
          values ('72000000-0000-4000-8000-000000000007',
            '71000000-0000-4000-8000-000000000005',
            '70000000-0000-4000-8000-000000000005', '${now}', 'nda', 'losses.pdf',
            'Profit and losses.pdf', 'application/pdf', 100, '/synthetic/losses.pdf')`,
        mutate: `insert into public.secure_documents
            (id, request_id, submission_id, created_at, document_type, file_name,
             original_name, mime_type, size_bytes, storage_path)
          values ('72000000-0000-4000-8000-000000000006',
            '71000000-0000-4000-8000-000000000005',
            '70000000-0000-4000-8000-000000000005', '${now}', 'cim', 'cim.pdf',
            'CIM.pdf', 'application/pdf', 100, '/synthetic/cim.pdf')` },
      { suffix: 'suppression', submissionId: '70000000-0000-4000-8000-000000000003',
        recipient: 'p7b-suppression@example.test', reason: 'recipient_suppressed',
        evidence: 'email-suppression',
        mutate: `insert into public.email_suppressions
          (id, normalized_email, reason, source, created_at, created_by, metadata)
          values ('suppression-p7b', 'p7b-suppression@example.test', 'hard-bounce',
            'synthetic', '${now}', 'fixture', '{}'::jsonb)` },
      { suffix: 'identity', submissionId: '70000000-0000-4000-8000-000000000004',
        recipient: 'p7b-identity@example.test', reason: 'identity_ambiguous',
        evidence: 'identity-exception',
        mutate: `insert into public.deal_hunter_identity_exceptions
          (id, created_at, updated_at, status, candidate_opportunity_ids, reason,
           evidence_version, metadata)
          values ('identity-p7b', '${now}', '${now}', 'open',
            '["opp-p7b-identity"]'::jsonb, 'synthetic conflict', 'test-v1', '{}'::jsonb)` },
    ];
    for (const writer of writerCases) {
      seedTerminalWriter(writer);
      if (writer.preMutate) {
        psql(container, terminalWriterDatabase, writer.preMutate);
        const evidenceState = JSON.parse(psql(container, terminalWriterDatabase,
          `select jsonb_build_object(
            'prospectus', nullif(btrim(submission.prospectus_url), '') is not null,
            'document', exists (select 1 from public.secure_documents document
              where document.submission_id = submission.id and (
                public.pursue_cim_material_token_p7b(document.document_type) in
                  ('cim','teaser','prospectus','offering_memorandum','offering_materials',
                    'data_room','broker_materials','financials','financial_package',
                    'financial_statements','p_and_l','tax_returns','balance_sheet')
                or public.pursue_cim_material_filename_kind_p7b(
                  coalesce(document.original_name, document.file_name, '')) <> '')),
            'metadata', submission.metadata)
          from public.contact_submissions submission where submission.id='${writer.submissionId}';`));
        assert.deepEqual(evidenceState, { prospectus: false, document: false, metadata: {} },
          `${terminalWriterDatabase}:${writer.suffix}: unrelated evidence predicate`);
        const preState = JSON.parse(psql(container, terminalWriterDatabase,
          `select jsonb_build_object(
            'campaignState', (select state from public.deal_hunter_cim_campaigns
              where id='campaign-p7b-${writer.suffix}'),
            'revision', (select terminal_revision from public.deal_hunter_cim_campaigns
              where id='campaign-p7b-${writer.suffix}'),
            'touchState', (select state from public.deal_hunter_cim_campaign_touches
              where id='touch-p7b-${writer.suffix}'),
            'eventEvidenceId', (select evidence_id from public.deal_hunter_cim_terminal_events
              where campaign_id='campaign-p7b-${writer.suffix}' order by revision desc limit 1));`));
        assert.deepEqual(preState, { campaignState: 'initial-pending', revision: 0,
          touchState: 'scheduled', eventEvidenceId: null },
        `${terminalWriterDatabase}:${writer.suffix}: unrelated evidence must not terminalize`);
      }
      psql(container, terminalWriterDatabase, writer.mutate);
      const state = JSON.parse(psql(container, terminalWriterDatabase, `select jsonb_build_object(
        'campaignState', (select state from public.deal_hunter_cim_campaigns
          where id='campaign-p7b-${writer.suffix}'),
        'reason', (select reason_code from public.deal_hunter_cim_campaigns
          where id='campaign-p7b-${writer.suffix}'),
        'revision', (select terminal_revision from public.deal_hunter_cim_campaigns
          where id='campaign-p7b-${writer.suffix}'),
        'touchState', (select state from public.deal_hunter_cim_campaign_touches
          where id='touch-p7b-${writer.suffix}'),
        'evidenceType', (select evidence_type from public.deal_hunter_cim_terminal_events
          where campaign_id='campaign-p7b-${writer.suffix}' order by revision desc limit 1));`));
      assert.deepEqual(state, {
        campaignState: ['materials_received', 'advanced_beyond_broker_outreach']
          .includes(writer.reason) ? 'materials-received' : writer.reason === 'identity_ambiguous'
            ? 'action-required' : 'stopped',
        reason: writer.reason, revision: 1,
        touchState: 'cancelled-before-provider', evidenceType: writer.evidence,
      }, `${terminalWriterDatabase}:${writer.suffix}`);
    }
    seedTerminalWriter({ suffix: 'upload-edit',
      submissionId: '70000000-0000-4000-8000-000000000007',
      recipient: 'p7b-upload-edit@example.test' });
    psql(container, terminalWriterDatabase, `insert into public.secure_upload_requests
      (id, submission_id, created_at, updated_at, email, status, expires_at,
       requested_documents)
      values ('71000000-0000-4000-8000-000000000007',
        '70000000-0000-4000-8000-000000000007', '${now}', '${now}',
        'p7b-upload-edit@example.test', 'documents-received',
        '2026-09-26T19:00:00.000Z', '[]'::jsonb);`);
    assert.equal(Number(psql(container, terminalWriterDatabase, `select terminal_revision
      from public.deal_hunter_cim_campaigns where id='campaign-p7b-upload-edit';`)), 0);
    psql(container, terminalWriterDatabase, `update public.secure_upload_requests
      set requested_documents='["cim"]'::jsonb, updated_at='${now}'
      where id='71000000-0000-4000-8000-000000000007';`);
    assert.deepEqual(JSON.parse(psql(container, terminalWriterDatabase, `select jsonb_build_object(
      'state', state, 'reason', reason_code, 'revision', terminal_revision)
      from public.deal_hunter_cim_campaigns where id='campaign-p7b-upload-edit';`)),
    { state: 'materials-received', reason: 'materials_received', revision: 1 },
    `${terminalWriterDatabase}: requested-document edits must trigger convergence`);
    psql(container, terminalWriterDatabase, `insert into public.deal_hunter_identity_exceptions
      (id, created_at, updated_at, status, candidate_opportunity_ids, reason,
       evidence_version, metadata)
      values ('identity-p7b-repeat', '${now}', '${now}', 'open',
        '["opp-p7b-identity"]'::jsonb, 'second synthetic conflict', 'test-v1', '{}'::jsonb)`);
    assert.deepEqual(JSON.parse(psql(container, terminalWriterDatabase, `select jsonb_build_object(
      'state', state, 'reason', reason_code, 'revision', terminal_revision,
      'events', (select count(*) from public.deal_hunter_cim_terminal_events
        where campaign_id='campaign-p7b-identity'))
      from public.deal_hunter_cim_campaigns where id='campaign-p7b-identity';`)),
    { state: 'action-required', reason: 'identity_ambiguous', revision: 2, events: 2 },
    `${terminalWriterDatabase}: repeated identity evidence must remain append-only`);
    seedTerminalWriter({ suffix: 'ambiguous',
      submissionId: '70000000-0000-4000-8000-000000000006',
      recipient: 'p7b-ambiguous@example.test' });
    psql(container, terminalWriterDatabase, `
      update public.deal_hunter_cim_campaigns
        set state='provider-ambiguous', reason_code='provider_result_ambiguous',
          row_version=row_version+1, updated_at='${now}'
        where id='campaign-p7b-ambiguous';
      insert into public.email_suppressions
        (id, normalized_email, reason, source, created_at, created_by, metadata)
      values ('suppression-p7b-ambiguous', 'p7b-ambiguous@example.test', 'hard-bounce',
        'synthetic', '${now}', 'fixture', '{}'::jsonb);
    `);
    assert.deepEqual(JSON.parse(psql(container, terminalWriterDatabase, `select jsonb_build_object(
      'state', state, 'reason', reason_code, 'revision', terminal_revision,
      'events', (select count(*) from public.deal_hunter_cim_terminal_events
        where campaign_id='campaign-p7b-ambiguous'),
      'touch', (select state from public.deal_hunter_cim_campaign_touches
        where id='touch-p7b-ambiguous'))
      from public.deal_hunter_cim_campaigns where id='campaign-p7b-ambiguous';`)),
    { state: 'stopped', reason: 'recipient_suppressed', revision: 1, events: 1,
      touch: 'cancelled-before-provider' },
    `${terminalWriterDatabase}: terminal evidence must dominate provider ambiguity`);
    for (const acceptedAt of ['2026-02-15T10:30:00.000Z',
      '2026-10-11T08:30:00.000Z']) {
      const expectedExpiry = calculateCampaignExpiry(acceptedAt, 'America/Los_Angeles');
      const postgresExpiry = JSON.parse(psql(container, database, `
        select public.pursue_cim_expected_initial_expiry_v1(
          '${acceptedAt}'::timestamptz,'America/Los_Angeles');`));
      assert.deepEqual(postgresExpiry, { localExpiryAt: expectedExpiry.expiresAt,
        expiryDerivation: expectedExpiry },
      `${database}: PostgreSQL expiry must match gap-forward/earlier-repeat service semantics`);
    }
    const supabase = createSupabaseStorage({ storage: {} }, { client: {
      async rpc(name, payload) {
        assert.ok(['pursue_cim_transition_enrollment_v1',
          'pursue_cim_append_timezone_revision_v1',
          'pursue_cim_record_capability_activation_v1',
          'pursue_cim_withdraw_capability_activation_v1',
          'pursue_cim_claim_due_touch_v1',
          'pursue_cim_list_due_initial_touches_v1',
          'pursue_cim_resolve_inbound_v1',
          'pursue_cim_append_ambiguous_reply_review_v1',
          'pursue_cim_read_projection_v1',
          'pursue_cim_append_safety_events_v1',
          'pursue_cim_record_owner_decision_v1',
          'pursue_cim_materialize_campaign_v1',
          'pursue_cim_materialize_campaign_v2',
          'pursue_cim_prepare_transmission_v1',
          'pursue_cim_issue_live_authorization_v1',
          'pursue_cim_authorize_provider_pending_v1',
          'pursue_cim_enter_provider_seam_v1',
          'pursue_cim_finalize_with_cadence_v1',
          'pursue_cim_reconcile_with_cadence_v1',
          'pursue_cim_read_cadence_context_v1',
          'pursue_cim_withdraw_live_authorization_v1',
          'pursue_cim_append_terminal_event_v1',
          'pursue_cim_consume_safety_events_v1',
          'pursue_cim_read_import_outreach_counters_v1'].includes(name), name);
        if (name === 'pursue_cim_read_import_outreach_counters_v1') {
          return { data: JSON.parse(psql(container, database, `set role service_role;
            select public.pursue_cim_read_import_outreach_counters_v1();`)), error: null };
        }
        if (name === 'pursue_cim_list_due_initial_touches_v1') {
          return { data: JSON.parse(psql(container, database, `set role service_role;
            select public.pursue_cim_list_due_initial_touches_v1(
              '${payload.p_now}'::timestamptz, ${payload.p_limit});`)), error: null };
        }
        const argument = JSON.stringify(
          payload.p_command ?? payload.p_run ?? payload.p_commands).replaceAll("'", "''");
        const data = JSON.parse(psql(container, database, `
          set role service_role;
          select public.${name}('${argument}'::jsonb);
        `));
        return { data, error: null };
      },
    } });
    const outreach = await supabase.readCimOutreachCounters();
    assert.equal(outreach.ownerDecisions, Number(psql(container, database,
      'select count(*) from public.deal_hunter_owner_decision_events;')));
    assert.equal(outreach.campaigns, Number(psql(container, database,
      'select count(*) from public.deal_hunter_cim_campaigns;')));
    assert.equal(outreach.providerSeamEntries, Number(psql(container, database,
      `select count(*) from public.deal_hunter_cim_transmissions
        where provider_seam_entered_at is not null;`)));
    const rejectAuditTransition = (eventType, name, command) => {
      psql(container, database, `
        create function public.p1c_reject_transition_audit() returns trigger
        language plpgsql set search_path = '' as $$
        begin
          if new.event_type = '${eventType}' then
            raise exception 'synthetic transition audit failure';
          end if;
          return new;
        end;
        $$;
        create trigger p1c_reject_transition_audit
          before insert on public.deal_hunter_cim_audit_events
          for each row execute function public.p1c_reject_transition_audit();
      `);
      const payload = JSON.stringify(command).replaceAll("'", "''");
      const rejected = rejectedSql(container, database, `set role service_role;
        select public.${name}('${payload}'::jsonb);`);
      psql(container, database, `drop trigger p1c_reject_transition_audit
        on public.deal_hunter_cim_audit_events;
        drop function public.p1c_reject_transition_audit();`);
      assert.notEqual(rejected.status, 0, `${database}:${eventType} must roll back`);
      assert.match(rejected.stderr, /synthetic transition audit failure/);
    };
    const concurrentRolledBackRpc = (name, command) => new Promise((resolve, reject) => {
      const payload = JSON.stringify(command).replaceAll("'", "''");
      const child = spawn(dockerCommand, ['exec', '-i', container, 'psql',
        '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
        '-c', `begin; set local deadlock_timeout='100ms';
          set local statement_timeout='5s'; set role service_role;
          select public.${name}('${payload}'::jsonb); rollback;`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error(`${name} concurrent transaction failed: ${stderr}`));
        else resolve(JSON.parse(stdout.trim()));
      });
    });
    const concurrentRolledBackSql = (sql) => new Promise((resolve, reject) => {
      const child = spawn(dockerCommand, ['exec', '-i', container, 'psql',
        '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
        '-c', `begin; set local deadlock_timeout='100ms';
          set local statement_timeout='5s'; ${sql}; select pg_sleep(0.2); rollback;`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error(`concurrent SQL transaction failed: ${stderr}`));
        else resolve(stdout.split('\n').filter((line) => line.startsWith('{')).map(JSON.parse).at(-1));
      });
    });
    if (database === 'pursue_cim_fresh') {
      const holder = spawn(dockerCommand, ['exec', '-i', container, 'psql',
        '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
        '-c', `begin; select pg_advisory_xact_lock(17499,48146);
          select pg_sleep(2); commit;`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
      let held = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        held = Number(psql(container, database, `select count(*) from pg_locks
          where locktype='advisory' and classid=17499 and objid=48146
            and granted;`)) === 1;
        if (held) break;
      }
      assert.equal(held, true, 'test session must hold the P1C transaction lock');
      const missingCommand = JSON.stringify({ ...commands[0],
        enrollmentId: 'missing-lock-proof' }).replaceAll("'", "''");
      const startedAt = Date.now();
      psql(container, database, `set role service_role;
        select public.pursue_cim_transition_enrollment_v1('${missingCommand}'::jsonb);`);
      assert.ok(Date.now() - startedAt >= 1000,
        'P1C transition must wait for the transaction-scoped serialization lock');
      await new Promise((resolve, reject) => {
        holder.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`)));
        holder.once('error', reject);
      });
    }
    const malformedCommands = [
      ['pursue_cim_transition_enrollment_v1', { ...commands[0], enrollmentId: 42 }],
      ['pursue_cim_transition_enrollment_v1', { ...commands[0], expectedRowVersion: '1' }],
      ['pursue_cim_append_timezone_revision_v1', { ...timezoneCommands[0], actor: 42 }],
      ['pursue_cim_record_capability_activation_v1', { ...activationCommands[0], id: 42 }],
      ['pursue_cim_claim_due_touch_v1', { ...claimCommands[0], expectedRowVersion: '1' }],
      ['pursue_cim_read_projection_v1', { opportunityId: 42 }],
      ['pursue_cim_append_safety_events_v1', { ...safetyRuns[0], sourceRunId: 42 }],
      ['pursue_cim_record_owner_decision_v1', { ...ownerCommands[0], actor: 42 }],
      ['pursue_cim_prepare_transmission_v1',
        { ...reference.prepareCommands[0], touchIds: [42] }],
      ['pursue_cim_finalize_with_cadence_v1',
        { ...reference.finalizeCommands[0], providerMessageId: 42 }],
      ['pursue_cim_reconcile_with_cadence_v1',
        { ...reference.reconcileCommands[0], providerMessageId: 42 }],
      ['pursue_cim_append_terminal_event_v1',
        { ...reference.terminalCommands[0], preProviderResolution: 'true' }],
      ['pursue_cim_resolve_inbound_v1', {
        replyToAddresses: [42], provider: 'resend', providerMessageIds: [],
        rfcMessageIds: [], taggedConversationId: '', taggedTransmissionId: '',
        taggedTouchIds: [],
      }],
    ];
    for (const [name, command] of malformedCommands) {
      const payload = JSON.stringify(command).replaceAll("'", "''");
      assert.notEqual(rejectedSql(container, database, `set role service_role;
        select public.${name}('${payload}'::jsonb);`).status, 0,
      `${database}:${name} must reject malformed JSON types`);
    }
    for (const [index, command] of commands.entries()) {
      const outcome = await supabase.transitionPursuitEnrollment(command);
      assert.deepEqual({ applied: outcome.applied, staleRevision: outcome.staleRevision,
        conflict: outcome.conflict, state: outcome.enrollment?.state ?? null,
        rowVersion: outcome.enrollment?.row_version ?? null }, expected[index], database);
    }
    assert.equal(Number(psql(container, database, `
      select count(*) from public.deal_hunter_cim_audit_events
      where event_type = 'enrollment-transition' and opportunity_id = 'opp-parity';
    `)), 1);
    for (const [index, command] of timezoneCommands.entries()) {
      const outcome = await supabase.appendOpportunityTimezoneRevision(command);
      assert.deepEqual({ applied: outcome.applied, replay: outcome.replay,
        staleRevision: outcome.staleRevision,
        revision: outcome.timezoneRevision?.revision ?? null,
        state: outcome.timezoneRevision?.state ?? null }, expectedTimezone[index], database);
    }
    assert.equal(psql(container, database, `select id from public.deal_hunter_cim_audit_events
      where event_type = 'timezone-revision';`), reference.timezoneAudit.id);
    assert.equal(psql(container, database, `select authority_digest from public.deal_hunter_cim_audit_events
      where event_type = 'timezone-revision';`), reference.timezoneAudit.authority_digest);
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('opp-timezone-supersession', now(), now(), 'Timezone supersession', 'cim-identity-v1');`);
    const supersessionCommand = { ...timezoneCommands[0],
      opportunityId: 'opp-timezone-supersession', idempotencyKey: 'timezone-supersession' };
    assert.equal((await supabase.appendOpportunityTimezoneRevision(supersessionCommand)).applied, true);
    psql(container, database, `update public.deal_hunter_opportunities set status = 'superseded'
      where opportunity_id = 'opp-timezone-supersession';`);
    assert.equal((await supabase.appendOpportunityTimezoneRevision(supersessionCommand)).replay, true);
    const blocked = await supabase.appendOpportunityTimezoneRevision({ ...supersessionCommand,
      idempotencyKey: 'timezone-supersession-new', expectedPriorRevision: 1 });
    assert.equal(blocked.applied, false);
    assert.equal(blocked.staleRevision, true);
    for (const [index, command] of activationCommands.entries()) {
      const outcome = await supabase.recordCimCapabilityActivation(command);
      assert.deepEqual({ applied: outcome.applied, replay: outcome.replay,
        conflict: outcome.conflict, blockedReason: outcome.blockedReason,
        id: outcome.activation?.id ?? null, status: outcome.activation?.status ?? null },
      expectedActivations[index], database);
    }
    psql(container, database, `
      insert into public.deal_hunter_broker_conversations
        (id, recipient_authority_id, recipient_fingerprint, recipient_address,
         sender_policy_version, reply_policy_version, reply_alias_token_digest,
         rfc_thread_key, state, batching_policy_version, created_at, updated_at)
      values ('conversation-parity', 'recipient-authority', repeat('e',64),
        'broker@example.test', 'sender-v1', 'reply-v1', repeat('f',64),
        'thread-parity', 'open', 'batching-off-v1', '${now}', '${now}');
      insert into public.deal_hunter_cim_campaigns
        (id, opportunity_id, generation, enrollment_id, decision_event_id,
         policy_version, template_version, template_digest, permission_version,
         permission_digest, permission_revision, permission_scope, canonical_revision,
         crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
         freshness_authority_digest, discovery_revision, material_revision,
         timezone_revision, conversation_id, state, reason_code, created_at, updated_at)
      values ('campaign-parity', 'opp-parity', 1, 'enrollment-parity', 'decision-parity',
        'policy-v1', 'template-v1', repeat('1',64), 'permission-v1', repeat('2',64),
        1, 'synthetic-cohort', 1, 1, 'recipient-authority', repeat('e',64),
        repeat('3',64), 0, 0, 1, 'conversation-parity', 'initial-pending',
        'awaiting-window', '${now}', '${now}');
      insert into public.deal_hunter_cim_campaign_touches
        (id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
         due_at, due_local, timezone_revision, state, created_at, updated_at)
      values ('touch-parity', 'campaign-parity', 'opp-parity', 'initial', 'initial', 0,
        '${now}', '2026-09-25T12:00:00-07:00', 1, 'scheduled', '${now}', '${now}');
      insert into public.deal_hunter_opportunity_scores
        (opportunity_id, created_at, scored_at, deal_key, name, score_fingerprint,
         engine_version, rules_version, profile_version, completeness_policy_version,
         current_triage_eligible)
      values ('opp-parity', '${now}', '${now}', 'deal:opp-parity', 'Synthetic parity',
        'fingerprint:opp-parity', 'engine-v1', 'rules-v1', 'profile-v1', 'complete-v1', true);
    `);
    assertOwnerFencesStage({ stage: 'scheduled', opportunityId: 'opp-parity',
      campaignId: 'campaign-parity', touchId: 'touch-parity' });
    await runCommittedOwnerRace({ stage: 'scheduled', opportunityId: 'opp-parity',
      campaignId: 'campaign-parity', touchId: 'touch-parity',
      transitionName: 'pursue_cim_claim_due_touch_v1', transitionCommand: claimCommands[0] });
    for (const [index, command] of claimCommands.entries()) {
      const outcome = await supabase.claimDueCimTouch(command);
      assert.deepEqual({ claimed: outcome.claimed, alreadyOwned: outcome.alreadyOwned,
        staleAuthority: outcome.staleAuthority, terminal: outcome.terminal,
        conflict: outcome.conflict, state: outcome.touch?.state ?? null,
        rowVersion: outcome.touch?.row_version ?? null }, expectedClaims[index], database);
    }
    assertOwnerFencesStage({ stage: 'claimed', opportunityId: 'opp-parity',
      campaignId: 'campaign-parity', touchId: 'touch-parity' });
    await runCommittedOwnerRace({ stage: 'claimed', opportunityId: 'opp-parity',
      campaignId: 'campaign-parity', touchId: 'touch-parity',
      transitionName: 'pursue_cim_claim_due_touch_v1', transitionCommand: claimCommands[3] });
    psql(container, database, `insert into public.deal_hunter_cim_requests
      (id, created_at, updated_at, deal_key, recipient_email, status,
       provider_message_id, request_state, delivery_state, metadata, opportunity_id)
      values ('legacy-parity', '${now}', '${now}', 'fingerprint:parity',
        'broker@example.test', 'sent', 'provider-legacy-parity', 'provider_accepted',
        'accepted', '{}'::jsonb, 'opp-parity');`);
    const projection = await supabase.readPursueCimProjection({ opportunityId: 'opp-parity' });
    assert.deepEqual({ decisionId: projection.decision?.id ?? null,
      enrollmentState: projection.enrollment?.state ?? null,
      campaignState: projection.campaign?.state ?? null,
      initialTouchState: projection.initialTouch?.state ?? null,
      transmissionId: projection.transmission?.id ?? null,
      legacySummary: projection.legacySummary, actions: projection.actions },
    expectedProjection, database);
    for (const [index, run] of safetyRuns.entries()) {
      const outcome = await supabase.appendCimSafetyEvents(run);
      assert.deepEqual(outcome, expectedSafetyEmissions[index], database);
    }
    assert.equal(psql(container, database, `select id from public.deal_hunter_cim_safety_events
      where safety_run_id = 'safety-run-parity';`), reference.safetyEventId);
    assert.equal(Number(psql(container, database, `select count(*) from public.deal_hunter_cim_audit_events
      where event_type = 'safety-emitted';`)), 1);
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('opp-decision', '${now}', '${now}', 'Synthetic decision', 'cim-identity-v1');`);
    psql(container, database, `insert into public.deal_hunter_opportunity_scores
      (opportunity_id, created_at, scored_at, deal_key, name, score_fingerprint,
       engine_version, rules_version, profile_version, completeness_policy_version,
       current_triage_eligible)
      values ('opp-decision', '${now}', '${now}', 'deal:opp-decision', 'Synthetic decision',
        'fingerprint:opp-decision', 'engine-v1', 'rules-v1', 'profile-v1', 'complete-v1', true);`);
    for (const [index, command] of ownerCommands.entries()) {
      const outcome = await supabase.recordOwnerDecision(command);
      assert.deepEqual({ applied: outcome.applied, replay: outcome.replay,
        conflict: outcome.conflict, decisionId: outcome.decision?.id ?? null,
        enrollmentId: outcome.enrollment?.id ?? null,
        enrollmentState: outcome.enrollment?.state ?? null,
        scorePriority: psql(container, database, `select operator_priority from
          public.deal_hunter_opportunity_scores where opportunity_id='opp-decision';`) },
      expectedOwnerDecisions[index], database);
    }
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('opp-owner-race', '${now}', '${now}', 'Synthetic owner race', 'cim-identity-v1');`);
    const concurrentOwnerCommand = { opportunityId: 'opp-owner-race', action: 'pursue',
      idempotencyKey: 'p4a-postgres-owner-race', actor: 'fixture-owner', policyVersion: 'owner-v1',
      now, expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 };
    const runConcurrentOwner = () => new Promise((resolve, reject) => {
      const payload = JSON.stringify(concurrentOwnerCommand).replaceAll("'", "''");
      const child = spawn(dockerCommand, ['exec', '-i', container, 'psql',
        '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
        '-c', `set role service_role;
          select public.pursue_cim_record_owner_decision_v1('${payload}'::jsonb);`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(JSON.parse(stdout.trim()))
        : reject(new Error(`Concurrent owner RPC failed: ${stderr}`)));
    });
    const concurrentOwners = await Promise.all([runConcurrentOwner(), runConcurrentOwner()]);
    assert.deepEqual(concurrentOwners.map(({ applied, replay }) => [applied, replay]).sort(),
      [[false, true], [true, false]], database);
    assert.equal(Number(psql(container, database, `select count(*) from
      public.deal_hunter_owner_decision_events where opportunity_id='opp-owner-race';`)), 1);
    assert.equal(Number(psql(container, database, `select count(*) from
      public.deal_hunter_pursuit_enrollments where opportunity_id='opp-owner-race';`)), 1);
    const firstOwner = concurrentOwners.find((result) => result.applied);
    const actionRequiredCommand = { enrollmentId: firstOwner.enrollment.id,
      expectedRowVersion: firstOwner.enrollment.row_version, nextState: 'action-required',
      reasonCode: 'recipient_ambiguous', actor: 'fixture-owner', now };
    const transitioned = JSON.parse(psql(container, database, `set role service_role;
      select public.pursue_cim_transition_enrollment_v1(
        '${JSON.stringify(actionRequiredCommand)}'::jsonb);`));
    assert.equal(transitioned.applied, true, database);
    const chosenOwnerCommand = { ...concurrentOwnerCommand,
      idempotencyKey: 'p4b-postgres-owner-choice',
      selectedContactReferenceDigest: 'a'.repeat(64) };
    const chosen = JSON.parse(psql(container, database, `set role service_role;
      select public.pursue_cim_record_owner_decision_v1(
        '${JSON.stringify(chosenOwnerCommand)}'::jsonb);`));
    assert.equal(chosen.applied, true, database);
    assert.equal(chosen.enrollment.state, 'queued', database);
    assert.equal(chosen.decision.selected_contact_reference_digest, 'a'.repeat(64));
    assert.equal(psql(container, database, `select state from public.deal_hunter_pursuit_enrollments
      where id='${firstOwner.enrollment.id}';`), 'superseded');
    const chosenReplay = JSON.parse(psql(container, database, `set role service_role;
      select public.pursue_cim_record_owner_decision_v1(
        '${JSON.stringify(chosenOwnerCommand)}'::jsonb);`));
    assert.equal(chosenReplay.replay, true, database);
    const changedChoiceCommand = { ...chosenOwnerCommand,
      idempotencyKey: 'p4b-postgres-owner-choice-changed',
      selectedContactReferenceDigest: 'b'.repeat(64) };
    const changedChoice = JSON.parse(psql(container, database, `set role service_role;
      select public.pursue_cim_record_owner_decision_v1(
        '${JSON.stringify(changedChoiceCommand)}'::jsonb);`));
    assert.equal(changedChoice.applied, true, database);
    assert.equal(changedChoice.decision.selected_contact_reference_digest, 'b'.repeat(64));
    assert.equal(psql(container, database, `select state from public.deal_hunter_pursuit_enrollments
      where id='${chosen.enrollment.id}';`), 'superseded');
    assert.equal(Number(psql(container, database, `select count(*) from
      public.deal_hunter_owner_decision_events where opportunity_id='opp-owner-race';`)), 3);
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('opp-pass-rollback', '${now}', '${now}', 'Synthetic rollback', 'cim-identity-v1');
      insert into public.deal_hunter_opportunity_scores
      (opportunity_id, created_at, scored_at, deal_key, name, score_fingerprint,
       engine_version, rules_version, profile_version, completeness_policy_version,
       current_triage_eligible)
      values ('opp-pass-rollback', '${now}', '${now}', 'deal:opp-pass-rollback',
        'Synthetic rollback', 'fingerprint:opp-pass-rollback', 'engine-v1',
        'rules-v1', 'profile-v1', 'complete-v1', true);
      create function public.p4a_fail_pass_review() returns trigger language plpgsql as $$
      begin raise exception 'synthetic Pass review persistence failure'; end $$;
      create trigger p4a_fail_pass_review before update of reviewed_at
        on public.deal_hunter_opportunity_scores for each row
        when (new.opportunity_id = 'opp-pass-rollback' and new.reviewed_at is not null)
        execute function public.p4a_fail_pass_review();`);
    const rollbackPass = { opportunityId: 'opp-pass-rollback', action: 'pass',
      idempotencyKey: 'p4a-pass-rollback', actor: 'fixture-owner', policyVersion: 'owner-v1',
      expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
      reason: 'not a fit', now };
    const rejectedPass = rejectedSql(container, database, `set role service_role;
      select public.pursue_cim_record_owner_decision_v1(
        '${JSON.stringify(rollbackPass).replaceAll("'", "''")}'::jsonb);`);
    assert.notEqual(rejectedPass.status, 0);
    assert.match(rejectedPass.stderr, /synthetic Pass review persistence failure/);
    const rolledBackPass = JSON.parse(psql(container, database, `select jsonb_build_object(
      'events', (select count(*) from public.deal_hunter_owner_decision_events
        where opportunity_id='opp-pass-rollback'),
      'dispositions', (select count(*) from public.deal_hunter_dispositions
        where deal_key='deal:opp-pass-rollback'),
      'audits', (select count(*) from public.deal_hunter_cim_audit_events
        where opportunity_id='opp-pass-rollback'),
      'reviewed', (select reviewed_at is not null from public.deal_hunter_opportunity_scores
        where opportunity_id='opp-pass-rollback'));`));
    assert.deepEqual(rolledBackPass,
      { events: 0, dispositions: 0, audits: 0, reviewed: false }, database);
    psql(container, database, `drop trigger p4a_fail_pass_review
      on public.deal_hunter_opportunity_scores;
      drop function public.p4a_fail_pass_review();`);
    assert.equal((await supabase.recordOwnerDecision(rollbackPass)).applied, true);
    assert.equal((await supabase.recordOwnerDecision(rollbackPass)).replay, true);
    assert.equal(Number(psql(container, database, `select count(*)
      from public.deal_hunter_owner_decision_events
      where opportunity_id='opp-pass-rollback';`)), 1);
    for (const [index, command] of ownerStopCommands.entries()) {
      const outcome = await supabase.recordOwnerDecision(command);
      const state = JSON.parse(psql(container, database, `select jsonb_build_object(
        'campaignState', (select state from public.deal_hunter_cim_campaigns where id='campaign-parity'),
        'touchState', (select state from public.deal_hunter_cim_campaign_touches where id='touch-parity'),
        'enrollmentState', (select state from public.deal_hunter_pursuit_enrollments where id='enrollment-parity'),
        'scorePriority', (select operator_priority from public.deal_hunter_opportunity_scores where opportunity_id='opp-parity'),
        'disposition', (select disposition from public.deal_hunter_dispositions where deal_key='deal:opp-parity')
      );`));
      assert.deepEqual({ applied: outcome.applied, replay: outcome.replay,
        conflict: outcome.conflict, decisionAction: outcome.decision?.action ?? null,
        enrollmentId: outcome.enrollment?.id ?? null, ...state }, expectedOwnerStops[index], database);
    }
    psql(container, database, `
      insert into public.deal_hunter_opportunity_timezone_revisions
        (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
         evidence_digest, resolver_version, dataset_digest, actor, created_at)
      values ('opp-decision', 1, 'verified', 'America/Los_Angeles', 'operator-verified',
        'timezone-decision', repeat('c',64), 'explicit-v1', repeat('d',64), 'fixture', '${now}');
      insert into public.contact_submissions
        (id, created_at, updated_at, status, delivery_provider, delivery_status,
         crm_status, source, ip_hash, name, email, message, deal_hunter_opportunity_id)
      values ('11111111-1111-4111-8111-111111111111', '${now}', '${now}', 'open',
        'none', 'not-attempted', 'active', 'synthetic', 'synthetic-ip',
        'Synthetic broker', 'broker2@example.test', 'Synthetic owner', 'opp-decision');
      update public.deal_hunter_opportunities set primary_submission_id =
        '11111111-1111-4111-8111-111111111111' where opportunity_id = 'opp-decision';
    `);
    const pgCrmMatchFingerprint = psql(container, database,
      `select public.pursue_cim_crm_match_fingerprint_v1();`);
    const postgresCampaignCommands = reference.resolvedCampaignCommands.map((command) => ({
      ...command, crmMatchAuthorityFingerprint: pgCrmMatchFingerprint,
    }));
    const raceCommand = JSON.stringify(postgresCampaignCommands[0]).replaceAll("'", "''");
    const driftCases = [
      ['crm-primary-revision', `update public.deal_hunter_opportunities
        set primary_submission_id = null where opportunity_id='opp-decision';`],
      ['crm-match-candidate', `insert into public.contact_submissions
        (id, created_at, updated_at, status, delivery_provider, delivery_status,
         crm_status, source, ip_hash, name, email, message)
        values ('22222222-2222-4222-8222-222222222222', '${now}', '${now}', 'open',
          'none', 'not-attempted', 'active', 'synthetic', 'synthetic-ip',
          'Other CRM candidate', 'other@example.test', 'Authority race');`],
      ['score-owner-priority', `update public.deal_hunter_opportunity_scores
        set operator_priority = 'normal' where opportunity_id='opp-decision';`],
      ['discovery', `update public.deal_hunter_opportunities
        set discovery_revision = discovery_revision + 1 where opportunity_id='opp-decision';`],
      ['material', `update public.deal_hunter_opportunities
        set material_revision = material_revision + 1 where opportunity_id='opp-decision';`],
      ['timezone', `insert into public.deal_hunter_opportunity_timezone_revisions
        (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
         evidence_digest, resolver_version, dataset_digest, actor, created_at)
        values ('opp-decision', 2, 'verified', 'America/New_York', 'operator-verified',
          'timezone-drift', repeat('c',64), 'explicit-v1', repeat('d',64), 'fixture', '${now}');`],
      ['crm-archive', `update public.contact_submissions set status='archived', archived_at='${now}'
        where id='11111111-1111-4111-8111-111111111111';`],
      ['recipient-provenance', `update public.contact_submissions
        set broker_email='changed@example.test'
        where id='11111111-1111-4111-8111-111111111111';`],
      ['source-provenance', `insert into public.deal_hunter_opportunity_source_observations
        (id, opportunity_id, source_id, source_name, source_record_id, field, value,
         observed_at, created_at, updated_at)
        values ('p4b-drift-row', 'opp-decision', 'sheet-0', 'Synthetic', 'row-1',
          'broker_email', 'changed@example.test', '${now}', '${now}', '${now}');`],
      ['source-projection', `insert into public.deal_hunter_source_freshness_state
        (source_id, projection_state) values ('p4b-drift-source', 'pending');`],
      ['identity-exception', `insert into public.deal_hunter_identity_exceptions
        (id, created_at, updated_at, status, candidate_opportunity_ids, reason,
         evidence_version)
        values ('p4b-drift-exception', '${now}', '${now}', 'open',
          '["opp-decision"]'::jsonb, 'synthetic conflict', 'test-v1');`],
      ['permission-withdrawal', `select public.pursue_cim_withdraw_capability_activation_v1(
        '{"id":"activation-enrollment","actor":"fixture","reason":"synthetic drift","now":"${now}"}'::jsonb);`],
      ['prior-accepted', `insert into public.deal_hunter_cim_requests
        (id, created_at, updated_at, deal_key, recipient_email, status,
         request_state, delivery_state, metadata, opportunity_id)
        values ('p4b-drift-request', '${now}', '${now}', 'deal:opp-decision',
          'broker2@example.test', 'sent', 'provider_accepted', 'accepted', '{}'::jsonb,
          'opp-decision');`],
    ];
    for (const [label, mutation] of driftCases) {
      const output = psql(container, database, `begin; ${mutation}
        select public.pursue_cim_materialize_campaign_v2('${raceCommand}'::jsonb);
        select jsonb_build_object(
          'conversations', (select count(*) from public.deal_hunter_broker_conversations
            where recipient_address='broker2@example.test'),
          'campaigns', (select count(*) from public.deal_hunter_cim_campaigns
            where opportunity_id='opp-decision'),
          'touches', (select count(*) from public.deal_hunter_cim_campaign_touches
            where opportunity_id='opp-decision'),
          'enrollment', (select state from public.deal_hunter_pursuit_enrollments
            where opportunity_id='opp-decision'));
        rollback;`).split('\n').filter((line) => line.startsWith('{'));
      assert.equal(JSON.parse(output.at(-2)).actionRequired, true, `${database}: ${label}`);
      assert.deepEqual(JSON.parse(output.at(-1)), { conversations: 0, campaigns: 0,
        touches: 0, enrollment: 'queued' }, `${database}: ${label}`);
    }
    const raceDatabase = `p4b_race_${database.endsWith('fresh') ? 'f' : 'u'}`;
    run(dockerCommand, ['exec', container, 'createdb', '-U', 'postgres',
      '-T', database, raceDatabase]);
    psql(container, raceDatabase, `create function public.p4b_abort_allocation()
      returns trigger language plpgsql as $$begin
        raise exception 'injected post-touch allocation failure';
      end$$;
      create trigger p4b_abort_allocation before insert on public.deal_hunter_cim_audit_events
      for each row when (new.event_type = 'touch-created')
      execute function public.p4b_abort_allocation();`);
    const aborted = rejectedSql(container, raceDatabase,
      `select public.pursue_cim_materialize_campaign_v2('${raceCommand}'::jsonb);`);
    assert.notEqual(aborted.status, 0, database);
    assert.match(aborted.stderr, /injected post-touch allocation failure/);
    assert.deepEqual(JSON.parse(psql(container, raceDatabase, `select jsonb_build_object(
      'campaigns', (select count(*) from public.deal_hunter_cim_campaigns where opportunity_id='opp-decision'),
      'touches', (select count(*) from public.deal_hunter_cim_campaign_touches where opportunity_id='opp-decision'),
      'enrollment', (select state from public.deal_hunter_pursuit_enrollments
        where opportunity_id='opp-decision' order by created_at desc limit 1));`)),
      { campaigns: 0, touches: 0, enrollment: 'queued' }, database);
    psql(container, raceDatabase, `drop trigger p4b_abort_allocation
      on public.deal_hunter_cim_audit_events;
      drop function public.p4b_abort_allocation();`);
    const scoreRaceDatabase = `p4b_score_race_${database.endsWith('fresh') ? 'f' : 'u'}`;
    run(dockerCommand, ['exec', container, 'createdb', '-U', 'postgres',
      '-T', raceDatabase, scoreRaceDatabase]);
    psql(container, scoreRaceDatabase, `create function public.p4b_pause_before_campaign()
      returns trigger language plpgsql as $$begin
        perform pg_sleep(2); return new;
      end$$;
      create trigger p4b_pause_before_campaign before insert on public.deal_hunter_cim_campaigns
      for each row execute function public.p4b_pause_before_campaign();`);
    const allocating = psqlIndependent(container, scoreRaceDatabase,
      `select public.pursue_cim_materialize_campaign_v2('${raceCommand}'::jsonb);`);
    let allocatorPaused = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      allocatorPaused = psql(container, scoreRaceDatabase, `select exists(select 1
        from pg_stat_activity where datname='${scoreRaceDatabase}'
          and pid <> pg_backend_pid() and wait_event='PgSleep');`) === 't';
      if (allocatorPaused) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(allocatorPaused, true, `${database}: allocator did not reach the campaign insert`);
    const changingScore = psqlIndependent(container, scoreRaceDatabase,
      `update public.deal_hunter_opportunity_scores set operator_priority='normal'
        where opportunity_id='opp-decision';`);
    let scoreWriterBlocked = false;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      scoreWriterBlocked = psql(container, scoreRaceDatabase, `select exists(select 1
        from pg_stat_activity where datname='${scoreRaceDatabase}'
          and pid <> pg_backend_pid() and wait_event_type='Lock'
          and query like '%operator_priority%normal%');`) === 't';
      if (scoreWriterBlocked) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const [scoreRaceAllocation] = await Promise.all([allocating, changingScore]);
    assert.equal(scoreWriterBlocked, true,
      `${database}: score writer must wait for the allocator's score row lock`);
    assert.equal(JSON.parse(scoreRaceAllocation).applied, true, database);
    assert.equal(psql(container, scoreRaceDatabase, `select operator_priority
      from public.deal_hunter_opportunity_scores where opportunity_id='opp-decision';`), 'normal');
    const raceSql = `begin; select pg_sleep(0.1);
      select public.pursue_cim_materialize_campaign_v2('${raceCommand}'::jsonb);
      commit;`;
    const raced = await Promise.all([
      psqlIndependent(container, raceDatabase, raceSql),
      psqlIndependent(container, raceDatabase, raceSql),
    ]);
    const racedResults = raced.map((output) => JSON.parse(output.split('\n').find((line) => line.startsWith('{'))));
    assert.deepEqual(racedResults.map((result) => result.applied).sort(), [false, true], database);
    assert.equal(racedResults.filter((result) => result.existing).length, 1, database);
    assert.deepEqual(JSON.parse(psql(container, raceDatabase, `select jsonb_build_object(
      'campaigns', (select count(*) from public.deal_hunter_cim_campaigns where opportunity_id='opp-decision'),
      'touches', (select count(*) from public.deal_hunter_cim_campaign_touches where opportunity_id='opp-decision'),
      'conversations', (select count(distinct conversation_id) from public.deal_hunter_cim_campaigns
        where opportunity_id='opp-decision'));`)),
      { campaigns: 1, touches: 1, conversations: 1 }, database);
    const claimContenders = ['6'.repeat(64), '7'.repeat(64)].map((claimTokenDigest, index) => ({
      ...reference.materializedClaimCommand, claimTokenDigest, claimOwner: `p5-racer-${index}`,
    }));
    const racedClaims = await Promise.all(claimContenders.map((command) =>
      psqlIndependent(container, raceDatabase, `begin; select pg_sleep(0.1);
        select public.pursue_cim_claim_due_touch_v1('${JSON.stringify(command)}'::jsonb);
        commit;`)));
    const claimResults = racedClaims.map((output) => JSON.parse(output.split('\n')
      .find((line) => line.startsWith('{'))));
    assert.deepEqual(claimResults.map((row) => row.claimed).sort(), [false, true], database);
    assert.equal(claimResults.filter((row) => row.staleAuthority || row.conflict).length, 1,
      `${database}: loser must receive a normalized claim result`);
    const winningClaim = claimContenders[claimResults.findIndex((row) => row.claimed)];
    const racePrepareCommand = JSON.stringify({ ...reference.prepareCommands[0],
      claimTokenDigest: winningClaim.claimTokenDigest });
    const racedPreparations = await Promise.all([0, 1].map(() =>
      psqlIndependent(container, raceDatabase, `begin; select pg_sleep(0.1);
        select public.pursue_cim_prepare_transmission_v1('${racePrepareCommand}'::jsonb);
        commit;`)));
    const preparationResults = racedPreparations.map((output) => JSON.parse(output.split('\n')
      .find((line) => line.startsWith('{'))));
    assert.deepEqual(preparationResults.map((row) => row.prepared).sort(),
      [false, true], database);
    assert.equal(preparationResults.filter((row) => row.existing).length, 1, database);
    const raceCounts = JSON.parse(psql(container, raceDatabase, `select jsonb_build_object(
      'transmissions', (select count(*) from public.deal_hunter_cim_transmissions),
      'memberships', (select count(*) from public.deal_hunter_cim_transmission_touches
        where cancelled_at is null),
      'communications', (select count(*) from public.crm_communications),
      'outbox', (select count(*) from public.crm_email_outbox));`));
    assert.deepEqual(raceCounts,
      { transmissions: 1, memberships: 1, communications: 1, outbox: 1 }, database);
    const overlappingClaimCommand = { ...reference.materializedClaimCommand,
      claimTokenDigest: '8'.repeat(64), claimOwner: 'p5-overlap' };
    const campaignBlocker = psqlIndependent(container, raceDatabase, `begin;
      select id from public.deal_hunter_cim_campaigns
        where opportunity_id='opp-decision' for update;
      select pg_sleep(12); commit;`);
    let blockerReady = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      blockerReady = psql(container, raceDatabase, `select exists(select 1
        from pg_stat_activity where datname='${raceDatabase}'
          and pid <> pg_backend_pid() and wait_event='PgSleep');`) === 't';
      if (blockerReady) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(blockerReady, true, `${database}: campaign blocker did not start`);
    const overlappingClaim = psqlIndependent(container, raceDatabase, `begin;
      set local deadlock_timeout='100ms';
      /* p5_claim_overlap */ select public.pursue_cim_claim_due_touch_v1(
        '${JSON.stringify(overlappingClaimCommand)}'::jsonb); commit;`)
      .then((value) => ({ value }), (error) => ({ error }));
    let claimBlocked = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      claimBlocked = psql(container, raceDatabase, `select exists(select 1
        from pg_stat_activity where datname='${raceDatabase}'
          and query like '%p5_claim_overlap%' and wait_event_type='Lock');`) === 't';
      if (claimBlocked) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(claimBlocked, true, `${database}: claim did not reach the campaign lock`);
    const overlappingPrepare = psqlIndependent(container, raceDatabase, `begin;
      set local deadlock_timeout='100ms';
      /* p5_prepare_overlap */ select public.pursue_cim_prepare_transmission_v1(
        '${racePrepareCommand}'::jsonb); commit;`)
      .then((value) => ({ value }), (error) => ({ error }));
    let prepareBlocked = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      prepareBlocked = psql(container, raceDatabase, `select exists(select 1
        from pg_stat_activity where datname='${raceDatabase}'
          and query like '%p5_prepare_overlap%' and wait_event_type='Lock');`) === 't';
      if (prepareBlocked) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(prepareBlocked, true, `${database}: prepare did not reach its next lock`);
    const blockerStillActive = psql(container, raceDatabase, `select exists(select 1
      from pg_stat_activity where datname='${raceDatabase}'
        and pid <> pg_backend_pid() and wait_event='PgSleep');`) === 't';
    const touchLockProbe = rejectedSql(container, raceDatabase, `begin;
      select id from public.deal_hunter_cim_campaign_touches
        where id='${reference.expectedCampaigns[0].touchId}' for update nowait;
      rollback;`);
    const [claimOverlap, prepareOverlap] = await Promise.all([overlappingClaim,
      overlappingPrepare, campaignBlocker]);
    assert.equal(blockerStillActive, true,
      `${database}: campaign blocker released before touch-lock probe`);
    assert.equal(touchLockProbe.status, 0,
      `${database}: preparation must wait for conversation/campaign before locking touch`);
    assert.equal(touchLockProbe.stdout.trim(), reference.expectedCampaigns[0].touchId,
      `${database}: touch lock probe must address the raced touch`);
    assert.equal(claimOverlap.error, undefined,
      `${database}: claim/prepare overlap should normalize: ${claimOverlap.error}`);
    assert.equal(prepareOverlap.error, undefined,
      `${database}: claim/prepare overlap should normalize: ${prepareOverlap.error}`);
    assert.equal(JSON.parse(claimOverlap.value.split('\n').find((line) => line.startsWith('{'))).conflict,
      true, database);
    assert.equal(JSON.parse(prepareOverlap.value.split('\n').find((line) => line.startsWith('{'))).existing,
      true, database);
    const rollbackPreparation = rejectedSql(container, raceDatabase, `begin;
      create function public.p5_abort_preparation() returns trigger language plpgsql
        as $$begin raise exception 'synthetic P5 preparation failure'; end$$;
      create trigger p5_abort_preparation before insert on public.deal_hunter_cim_transmissions
        for each row when (new.preparation_generation = 2)
        execute function public.p5_abort_preparation();
      select public.pursue_cim_prepare_transmission_v1(
        '${JSON.stringify({ ...reference.prepareCommands.at(-1),
          claimTokenDigest: winningClaim.claimTokenDigest })}'::jsonb);
      commit;`);
    assert.notEqual(rollbackPreparation.status, 0, database);
    assert.match(rollbackPreparation.stderr, /synthetic P5 preparation failure/);
    assert.deepEqual(JSON.parse(psql(container, raceDatabase, `select jsonb_build_object(
      'transmissions', (select count(*) from public.deal_hunter_cim_transmissions),
      'memberships', (select count(*) from public.deal_hunter_cim_transmission_touches
        where cancelled_at is null),
      'communications', (select count(*) from public.crm_communications),
      'outbox', (select count(*) from public.crm_email_outbox));`)), raceCounts,
    `${database}: aborted generation rebuild must retain the prior prepared identity`);
    for (const [index, command] of postgresCampaignCommands.entries()) {
      const outcome = await supabase.materializePursuitCampaign(command);
      assert.deepEqual({ applied: outcome.applied, existing: outcome.existing,
        actionRequired: outcome.actionRequired, campaignId: outcome.campaign?.id ?? null,
        campaignState: outcome.campaign?.state ?? null,
        expiryDerivation: outcome.campaign?.expiry_derivation ?? null,
        touchId: outcome.initialTouch?.id ?? null,
        touchState: outcome.initialTouch?.state ?? null }, expectedCampaigns[index], database);
    }
    const replaySuppression = psql(container, database, `begin;
      insert into public.email_suppressions
        (id, normalized_email, reason, source, created_at, created_by)
      values ('p4b-replay-suppression', 'broker2@example.test', 'admin-block',
        'fixture', '${now}', 'fixture');
      select public.pursue_cim_materialize_campaign_v2('${raceCommand}'::jsonb);
      rollback;`).split('\n').find((line) => line.startsWith('{'));
    assert.equal(JSON.parse(replaySuppression).actionRequired, true,
      `${database}: existing campaign replay must revalidate suppression authority`);
    const dueInitial = await supabase.listDueCimInitialTouches({ now, limit: 10 });
    assert.deepEqual(dueInitial.map((row) => row.touch_id),
      [reference.expectedCampaigns[0].touchId], database);
    const offsetDueInitial = await supabase.listDueCimInitialTouches({
      now: '2026-09-25T12:00:00-07:00', limit: 10 });
    assert.deepEqual(offsetDueInitial.map((row) => row.touch_id),
      [reference.expectedCampaigns[0].touchId], database);
    const staleCrmPreparation = psql(container, database, `begin;
      select public.pursue_cim_claim_due_touch_v1(
        '${JSON.stringify(reference.materializedClaimCommand)}'::jsonb);
      update public.deal_hunter_opportunities set primary_submission_id=null
        where opportunity_id='opp-decision';
      select public.pursue_cim_prepare_transmission_v1(
        '${JSON.stringify(reference.prepareCommands[0])}'::jsonb);
      rollback;`).split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.equal(staleCrmPreparation[0].claimed, true, database);
    assert.equal(staleCrmPreparation[1].terminal, true,
      `${database}: preparation must recheck the current CRM primary`);
    const staleInitialState = psql(container, database, `begin;
      select public.pursue_cim_claim_due_touch_v1(
        '${JSON.stringify(reference.materializedClaimCommand)}'::jsonb);
      update public.deal_hunter_cim_campaigns set state='active-follow-up'
        where opportunity_id='opp-decision';
      select public.pursue_cim_prepare_transmission_v1(
        '${JSON.stringify(reference.prepareCommands[0])}'::jsonb);
      rollback;`).split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.equal(staleInitialState[0].claimed, true, database);
    assert.equal(staleInitialState[1].terminal, true,
      `${database}: initial preparation must recheck initial-pending state`);
    const mismatchedMembership = psql(container, database, `begin;
      select public.pursue_cim_claim_due_touch_v1(
        '${JSON.stringify(reference.materializedClaimCommand)}'::jsonb);
      update public.deal_hunter_cim_campaign_touches set opportunity_id='opp-parity'
        where opportunity_id='opp-decision';
      select public.pursue_cim_prepare_transmission_v1(
        '${JSON.stringify(reference.prepareCommands[0])}'::jsonb);
      rollback;`).split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.equal(mismatchedMembership[0].claimed, true, database);
    assert.equal(mismatchedMembership[1].terminal, true,
      `${database}: mismatched touch opportunity cannot become a membership`);
    const expiredPreparation = psql(container, database, `begin;
      select public.pursue_cim_claim_due_touch_v1(
        '${JSON.stringify({ ...reference.materializedClaimCommand,
          claimExpiresAt: '2026-09-25T19:01:00.000Z' })}'::jsonb);
      select public.pursue_cim_prepare_transmission_v1(
        '${JSON.stringify({ ...reference.prepareCommands[0],
          now: '2026-09-25T19:02:00.000Z' })}'::jsonb);
      rollback;`).split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.equal(expiredPreparation[0].claimed, true, database);
    assert.equal(expiredPreparation[1].terminal, true,
      `${database}: expired owner cannot persist an immutable transmission`);
    const materializedClaim = await supabase.claimDueCimTouch(reference.materializedClaimCommand);
    assert.deepEqual({ claimed: materializedClaim.claimed,
      state: materializedClaim.touch?.state ?? null }, reference.expectedMaterializedClaim);
    for (const [index, command] of reference.prepareCommands.entries()) {
      const outcome = await supabase.prepareCimTransmission(command);
      assert.deepEqual({ prepared: outcome.prepared, existing: outcome.existing,
        payloadConflict: outcome.payloadConflict, terminal: outcome.terminal,
        transmissionId: outcome.transmission?.id ?? null,
        transmissionState: outcome.transmission?.state ?? null,
        toAddresses: outcome.transmission?.to_addresses ?? null,
        generation: outcome.transmission?.preparation_generation ?? null },
      reference.expectedPreparations[index], database);
    }
    const activePreparedId = reference.expectedPreparations.at(-1).transmissionId;
    const activeReplyTo = psql(container, database, `select reply_to_address
      from public.deal_hunter_cim_transmissions where id='${activePreparedId}';`);
    const activeConversationId = psql(container, database, `select conversation_id
      from public.deal_hunter_cim_transmissions where id='${activePreparedId}';`);
    const exactInbound = await supabase.resolvePursueCimInboundEvidence({
      replyToAddresses: [activeReplyTo], provider: 'resend', providerMessageIds: [],
      rfcMessageIds: [], taggedConversationId: '', taggedTransmissionId: '',
      taggedTouchIds: [],
    });
    assert.deepEqual({ exact: exactInbound.exact, ambiguous: exactInbound.ambiguous,
      method: exactInbound.method, conversationId: exactInbound.conversation?.id }, {
      exact: true, ambiguous: false, method: 'reply-alias',
      conversationId: activeConversationId,
    }, `${database}: P7A exact alias resolves the durable conversation before content fetch`);
    assert.equal(psql(container, database, `select conversation_id
      from public.deal_hunter_cim_transmissions where id='${exactInbound.transmission?.id}';`),
    activeConversationId, `${database}: alias-selected transmission must remain conversation-bound`);
    const conflictingInbound = await supabase.resolvePursueCimInboundEvidence({
      replyToAddresses: [activeReplyTo], provider: 'resend', providerMessageIds: [],
      rfcMessageIds: [], taggedConversationId: 'missing-protected-conversation',
      taggedTransmissionId: '', taggedTouchIds: [],
    });
    assert.deepEqual({ exact: conflictingInbound.exact,
      ambiguous: conflictingInbound.ambiguous, method: conflictingInbound.method,
      candidateConversationIds: conflictingInbound.candidateConversations.map(({ id }) => id) }, {
      exact: false, ambiguous: true, method: 'conflicting-exact-evidence',
      candidateConversationIds: [activeConversationId],
    }, `${database}: conflicting protected evidence must fail closed`);
    const atomicReviewCommands = ['conversation-atomic-a', 'conversation-atomic-b']
      .map((scopeId, index) => ({
        eventId: `atomic-review-${scopeId}`, scope: 'conversation', scopeId,
        expectedRevision: 0, expectedRowVersion: 1,
        nextState: 'reply-review-required', reasonCode: 'ambiguous_reply_evidence',
        evidenceType: 'signed-inbound-conflicting-exact-evidence',
        evidenceId: 'signed-atomic-review-event', observedAt: now,
        actor: 'signed-email-webhook', source: 'pursue-cim-inbound',
        metadataDigest: String(index + 5).repeat(64), now,
      }));
    const staleAtomicReviewCommands = atomicReviewCommands.map((command, index) =>
      index === 1 ? { ...command, expectedRevision: 1 } : command);
    const atomicReviewEvidence = psql(container, database, `begin;
      insert into public.deal_hunter_broker_conversations
        (id, recipient_authority_id, recipient_fingerprint, recipient_address,
         sender_policy_version, reply_policy_version, reply_alias_token_digest,
         rfc_thread_key, state, batching_policy_version, created_at, updated_at)
      values
        ('conversation-atomic-a', 'recipient-atomic-a', repeat('a',64),
          'atomic-a@example.test', 'deal-hunter-cim-autopilot-v1',
          'deal-hunter-cim-autopilot-v1', repeat('b',64), 'thread-atomic-a',
          'open', 'batching-off-v1', '${now}', '${now}'),
        ('conversation-atomic-b', 'recipient-atomic-b', repeat('c',64),
          'atomic-b@example.test', 'deal-hunter-cim-autopilot-v1',
          'deal-hunter-cim-autopilot-v1', repeat('d',64), 'thread-atomic-b',
          'open', 'batching-off-v1', '${now}', '${now}');
      select public.pursue_cim_append_ambiguous_reply_review_v1(
        '${JSON.stringify(staleAtomicReviewCommands)}'::jsonb);
      select jsonb_build_object('afterConflict', jsonb_agg(state order by id))
        from public.deal_hunter_broker_conversations
        where id in ('conversation-atomic-a','conversation-atomic-b');
      select public.pursue_cim_append_ambiguous_reply_review_v1(
        '${JSON.stringify(atomicReviewCommands)}'::jsonb);
      select jsonb_build_object('afterApply', jsonb_agg(state order by id))
        from public.deal_hunter_broker_conversations
        where id in ('conversation-atomic-a','conversation-atomic-b');
      rollback;`).split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.deepEqual(atomicReviewEvidence[0], {
      applied: false, replay: false, conflict: true,
      conversationIds: ['conversation-atomic-a', 'conversation-atomic-b'],
      cancelledTouchIds: [],
    }, `${database}: an atomic conflict must be a normal read-through result`);
    assert.deepEqual(atomicReviewEvidence[1], { afterConflict: ['open', 'open'] },
      `${database}: a conflict must roll back every candidate transition`);
    assert.equal(atomicReviewEvidence[2].applied, true, database);
    assert.deepEqual(atomicReviewEvidence[2].conversationIds,
      ['conversation-atomic-a', 'conversation-atomic-b'], database);
    assert.deepEqual(atomicReviewEvidence[3], {
      afterApply: ['reply-review-required', 'reply-review-required'],
    }, `${database}: one transaction must contain every ambiguous candidate`);
    const bindingMetadata = JSON.parse(psql(container, database, `select jsonb_build_object(
      'communication', communication.metadata, 'outbox', outbox.metadata)
      from public.deal_hunter_cim_transmissions transmission
      join public.crm_communications communication on communication.id=transmission.communication_id
      join public.crm_email_outbox outbox on outbox.id=transmission.outbox_id
      where transmission.id='${activePreparedId}';`));
    for (const metadata of [bindingMetadata.communication, bindingMetadata.outbox]) {
      assert.equal(metadata.transmissionId, activePreparedId, database);
      assert.equal(metadata.conversationId, activeConversationId, database);
      assert.deepEqual(metadata.touchIds, [reference.expectedCampaigns[0].touchId], database);
      assert.match(metadata.memberDigest, /^[0-9a-f]{64}$/, database);
    }
    const multiMemberBinding = JSON.parse(psql(container, database, `begin;
      insert into public.deal_hunter_cim_campaign_touches
        (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at, due_local,
         timezone_revision, state, transmission_id, created_at, updated_at)
      select 'touch-p7a-second-member', campaign_id, opportunity_id, 'p7a-second-member',
        'follow-up-1', 1, due_at, due_local, timezone_revision, 'scheduled',
        '${activePreparedId}', created_at, updated_at
      from public.deal_hunter_cim_campaign_touches
      where id='${reference.expectedCampaigns[0].touchId}';
      select pg_catalog.set_config('p7a.binding_revision', revision::text, true)
        from public.deal_hunter_cim_global_authority where id='global';
      insert into public.deal_hunter_cim_transmission_touches
        (transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at)
      values ('${activePreparedId}', 'touch-p7a-second-member', 'opp-decision',
        '${reference.expectedCampaigns[0].campaignId}', 2, '${now}');
      select jsonb_build_object(
        'revisionDelta', (select revision from public.deal_hunter_cim_global_authority
          where id='global') - pg_catalog.current_setting('p7a.binding_revision')::bigint,
        'touchIds', (select metadata->'touchIds' from public.crm_communications
          where id=(select communication_id from public.deal_hunter_cim_transmissions
            where id='${activePreparedId}')));
      rollback;`).split('\n').filter((line) => line.startsWith('{')).at(-1));
    assert.equal(multiMemberBinding.revisionDelta, 0,
      `${database}: every internal membership binding refresh must remain revision-neutral`);
    assert.deepEqual(multiMemberBinding.touchIds.sort(),
      [reference.expectedCampaigns[0].touchId, 'touch-p7a-second-member'].sort(), database);
    const staleRebuild = await supabase.prepareCimTransmission({
      ...reference.prepareCommands.at(-1), preparationGeneration: 3,
      claimTokenDigest: '7'.repeat(64), bodyText: 'Unapproved replacement',
    });
    assert.equal(staleRebuild.prepared, false, database);
    assert.equal(psql(container, database, `select state from public.deal_hunter_cim_transmissions
      where id='${activePreparedId}';`), 'prepared',
    `${database}: stale claim must not cancel the active immutable preparation`);
    const boundVersion = Number(psql(container, database, `select row_version
      from public.deal_hunter_cim_campaign_touches
      where id='${reference.expectedCampaigns[0].touchId}';`));
    const boundClaim = await supabase.claimDueCimTouch({
      ...reference.materializedClaimCommand, expectedRowVersion: boundVersion,
    });
    assert.equal(boundClaim.conflict, true, `${database}: bound touch is no longer claimable`);
    const historyClaim = JSON.parse(psql(container, database, `begin;
      select public.pursue_cim_cancel_prepared_transmission_v1(
        '${reference.expectedPreparations.at(-1).transmissionId}',
        '${now}'::timestamptz, 'synthetic-pre-provider-cancel', 'fixture', true);
      update public.deal_hunter_cim_campaign_touches
        set claim_expires_at='2026-09-25T18:59:00.000Z'::timestamptz
        where id='${reference.expectedCampaigns[0].touchId}';
      select public.pursue_cim_claim_due_touch_v1(
        '${JSON.stringify({ ...reference.materializedClaimCommand,
          expectedRowVersion: boundVersion + 1, claimTokenDigest: '7'.repeat(64),
          claimOwner: 'stale-history-worker' })}'::jsonb);
      rollback;`).split('\n').find((line) => line.startsWith('{')));
    assert.equal(historyClaim.conflict, true,
      `${database}: retained immutable history must block lease reclaim`);
    const preparedOutboxId = psql(container, database, `select outbox_id
      from public.deal_hunter_cim_transmissions
      where id='${reference.expectedPreparations.at(-1).transmissionId}';`);
    const genericClaim = JSON.parse(psql(container, database, `begin;
      update public.crm_email_outbox set state='queued' where id='${preparedOutboxId}';
      select public.claim_crm_email_outbox('${preparedOutboxId}', 'generic-worker',
        '${now}'::timestamptz, '2026-09-25T19:10:00.000Z'::timestamptz);
      rollback;`).split('\n').find((line) => line.startsWith('{')));
    assert.equal(genericClaim.claimed, false, `${database}: generic outbox claim must exclude CIM`);
    assertOwnerFencesStage({ stage: 'prepared', opportunityId: 'opp-decision',
      campaignId: reference.expectedCampaigns[0].campaignId,
      touchId: reference.expectedCampaigns[0].touchId,
      transmissionId: reference.expectedPreparations.at(-1).transmissionId });
    await runCommittedOwnerRace({ stage: 'prepared', opportunityId: 'opp-decision',
      campaignId: reference.expectedCampaigns[0].campaignId,
      touchId: reference.expectedCampaigns[0].touchId,
      transmissionId: reference.expectedPreparations.at(-1).transmissionId,
      transitionName: 'pursue_cim_issue_live_authorization_v1',
      transitionCommand: reference.issueCommands[0] });
    assert.equal(Number(psql(container, database, `select count(*)
      from public.deal_hunter_cim_transmission_touches where cancelled_at is null;`)), 1);
    const infiniteAuthorization = rejectedSql(container, database, `
      set role service_role;
      select public.pursue_cim_issue_live_authorization_v1(
        '${JSON.stringify({ ...reference.issueCommands[0],
          id: 'authorization-infinite', writerPath: 'infinite-writer',
          expiresAt: 'infinity' }).replaceAll("'", "''")}'::jsonb);
    `);
    assert.notEqual(infiniteAuthorization.status, 0,
      `${database}: PostgreSQL must reject a non-finite authorization expiry before mutation`);
    assert.equal(Number(psql(container, database, `select count(*)
      from public.deal_hunter_cim_live_provider_authorizations
      where id='authorization-infinite';`)), 0);
    for (const [index, command] of reference.issueCommands.entries()) {
      const outcome = await supabase.issueCimLiveProviderAuthorization(command);
      assert.deepEqual({ issued: outcome.issued, replay: outcome.replay,
        conflict: outcome.conflict, blockedReason: outcome.blockedReason,
        authorizationId: outcome.authorization?.id ?? null },
      reference.expectedIssues[index], database);
    }
    psql(container, database, `
      update public.deal_hunter_opportunities set discovery_state = 'known_prospective'
        where opportunity_id = 'opp-decision';
      insert into public.deal_hunter_source_freshness_state
        (source_id, next_generation, accepted_generation, accepted_run_id,
         accepted_digest, accepted_at, projection_state)
      values ('sheet-0', 1, 1, 'parity-run', repeat('5', 64), '${now}', 'accepted');
      insert into public.deal_hunter_opportunity_source_observations
        (id, opportunity_id, source_id, source_name, source_record_id, field, value,
         observed_at, accepted_at, accepted_run_id, created_at, updated_at)
      values ('parity-source-row', 'opp-decision', 'sheet-0', 'Synthetic Sheet',
        'parity-record', 'broker_email', 'broker2@example.test', '${now}', '${now}',
        'parity-run', '${now}', '${now}');
    `);
    assertOwnerFencesStage({ stage: 'authorized', opportunityId: 'opp-decision',
      campaignId: reference.expectedCampaigns[0].campaignId,
      touchId: reference.expectedCampaigns[0].touchId,
      transmissionId: reference.expectedPreparations.at(-1).transmissionId,
      authorizationId: reference.expectedIssues[0].authorizationId });
    await runCommittedOwnerRace({ stage: 'authorized', opportunityId: 'opp-decision',
      campaignId: reference.expectedCampaigns[0].campaignId,
      touchId: reference.expectedCampaigns[0].touchId,
      transmissionId: reference.expectedPreparations.at(-1).transmissionId,
      authorizationId: reference.expectedIssues[0].authorizationId,
      transitionName: 'pursue_cim_authorize_provider_pending_v1',
      transitionCommand: reference.providerPendingCommands[2] });
    for (const [index, command] of reference.providerPendingCommands.entries()) {
      const postgresCanonical = psql(container, database,
        `select public.pursue_cim_canonical_json_v1(
          '${JSON.stringify(command.authoritySnapshot).replaceAll("'", "''")}'::jsonb);`);
      const javascriptCanonical = stableCanonicalJson(command.authoritySnapshot);
      if (postgresCanonical !== javascriptCanonical) {
        const mismatch = [...javascriptCanonical].findIndex((value, offset) =>
          value !== postgresCanonical[offset]);
        assert.fail(`${database}: canonical mismatch at ${mismatch}; JS=${javascriptCanonical.slice(
          Math.max(0, mismatch - 80), mismatch + 120)}; PG=${postgresCanonical.slice(
          Math.max(0, mismatch - 80), mismatch + 120)}`);
      }
      const postgresGateDigest = sha256(postgresCanonical);
      assert.equal(postgresGateDigest, command.finalGateAuthorityDigest,
        `${database}: canonical final-gate digest parity`);
      if (index === 2) assert.equal(reference.expectedProviderPending[index].authorized, true,
        'SQLite reference must authorize synthetic provider-pending storage transition');
      if (index === 2) psql(container, database, `insert into public.deal_hunter_cim_safety_settings
        (id, updated_at, outreach_paused, updated_by, metadata)
        values ('global', '${now}', false, 'fixture', '{}'::jsonb);`);
      if (index === 2) {
        const unrelatedDocumentGate = JSON.parse(psql(container, database, `begin;
          insert into public.secure_upload_requests
            (id, submission_id, created_at, updated_at, email, status, expires_at,
             requested_documents)
          values ('73000000-0000-4000-8000-000000000001',
            '11111111-1111-4111-8111-111111111111', '${now}', '${now}',
            'broker2@example.test', 'open', '2026-09-26T19:00:00.000Z', '[]'::jsonb);
          insert into public.secure_documents
            (id, request_id, submission_id, created_at, document_type, file_name,
             original_name, mime_type, size_bytes, storage_path)
          values ('74000000-0000-4000-8000-000000000001',
            '73000000-0000-4000-8000-000000000001',
            '11111111-1111-4111-8111-111111111111', '${now}', 'nda', 'nda.pdf',
            'Signed NDA.pdf', 'application/pdf', 100, '/synthetic/nda-final-gate.pdf');
          insert into public.secure_documents
            (id, request_id, submission_id, created_at, document_type, file_name,
             original_name, mime_type, size_bytes, storage_path)
          values ('74000000-0000-4000-8000-000000000002',
            '73000000-0000-4000-8000-000000000001',
            '11111111-1111-4111-8111-111111111111', '${now}', 'nda', 'losses.pdf',
            'Profit and losses.pdf', 'application/pdf', 100,
            '/synthetic/losses-final-gate.pdf');
          update public.deal_hunter_cim_global_authority
            set revision=${command.expectedGlobalAuthorityRevision} where id='global';
          set role service_role;
          select public.pursue_cim_authorize_provider_pending_v1(
            '${JSON.stringify(command).replaceAll("'", "''")}'::jsonb);
          rollback;`).split('\n').find((line) => line.startsWith('{')));
        assert.deepEqual({ authorized: unrelatedDocumentGate.authorized,
          blockedReason: unrelatedDocumentGate.blockedReason },
        { authorized: true, blockedReason: null },
        `${database}: unrelated NDA evidence must not block the final gate`);
        const communicationLifecycle = JSON.parse(psql(container, database, `begin;
          update public.crm_communications
            set delivery_state='failed', delivery_state_at='${now}', updated_at='${now}',
              updated_by='email-webhook', source_event_id='webhook-p7b-unsafe'
            where id=(select communication_id from public.deal_hunter_cim_transmissions
              where id='${command.transmissionId}');
          select jsonb_build_object(
            'state', (select state from public.deal_hunter_cim_campaigns
              where id='${reference.expectedCampaigns[0].campaignId}'),
            'reason', (select reason_code from public.deal_hunter_cim_campaigns
              where id='${reference.expectedCampaigns[0].campaignId}'),
            'revision', (select terminal_revision from public.deal_hunter_cim_campaigns
              where id='${reference.expectedCampaigns[0].campaignId}'),
            'evidenceType', (select evidence_type from public.deal_hunter_cim_terminal_events
              where campaign_id='${reference.expectedCampaigns[0].campaignId}'
              order by revision desc limit 1));
          rollback;`).split('\n').find((line) => line.startsWith('{')));
        assert.deepEqual(communicationLifecycle, { state: 'stopped', reason: 'unsafe_delivery',
          revision: 1, evidenceType: 'delivery-lifecycle' },
        `${database}: unsafe webhook lifecycle must converge in the communication transaction`);
        if (database === 'pursue_cim_fresh') {
          const [gateRace, suppressionRace] = await Promise.all([
            concurrentRolledBackRpc('pursue_cim_authorize_provider_pending_v1', command),
            concurrentRolledBackSql(`insert into public.email_suppressions
              (id, normalized_email, reason, source, created_at, created_by, metadata)
              values ('suppression-p7b-lock-race', 'broker2@example.test', 'hard-bounce',
                'synthetic', '${now}', 'fixture', '{}'::jsonb);
              select jsonb_build_object('state', state, 'revision', terminal_revision)
                from public.deal_hunter_cim_campaigns
                where id='${reference.expectedCampaigns[0].campaignId}'`),
          ]);
          assert.equal(gateRace.authorized, true,
            `${database}: final gate must serialize with a direct domain writer`);
          assert.deepEqual(suppressionRace, { state: 'stopped', revision: 1 },
            `${database}: direct domain writer must complete without a lock-order deadlock`);
        }
        const materialsRace = JSON.parse(psql(container, database, `begin;
          update public.contact_submissions
            set prospectus_url = 'https://example.test/prospectus'
            where id = '11111111-1111-4111-8111-111111111111';
          set role service_role;
          select public.pursue_cim_authorize_provider_pending_v1(
            '${JSON.stringify(command).replaceAll("'", "''")}'::jsonb);
          rollback;`).split('\n').find((line) => line.startsWith('{')));
        assert.deepEqual({ authorized: materialsRace.authorized,
          blockedReason: materialsRace.blockedReason },
        { authorized: false, blockedReason: 'materials_received' },
        `${database}: persisted materials must beat the final gate`);
        const metadataMaterialsRace = JSON.parse(psql(container, database, `begin;
          update public.contact_submissions set metadata =
            '{"diligence":{"stage":"financial-review","checklist":{"cim":true}}}'::jsonb
            where id = '11111111-1111-4111-8111-111111111111';
          set role service_role;
          select public.pursue_cim_authorize_provider_pending_v1(
            '${JSON.stringify(command).replaceAll("'", "''")}'::jsonb);
          rollback;`).split('\n').find((line) => line.startsWith('{')));
        assert.deepEqual({ authorized: metadataMaterialsRace.authorized,
          blockedReason: metadataMaterialsRace.blockedReason },
        { authorized: false, blockedReason: 'materials_received' },
        `${database}: CRM diligence metadata must beat the final gate`);
        const permissionRace = JSON.parse(psql(container, database, `begin;
          update public.deal_hunter_cim_campaigns set permission_revision = permission_revision + 1
            where id='${reference.expectedCampaigns[0].campaignId}';
          set role service_role;
          select public.pursue_cim_authorize_provider_pending_v1(
            '${JSON.stringify(command).replaceAll("'", "''")}'::jsonb);
          rollback;`).split('\n').find((line) => line.startsWith('{')));
        assert.deepEqual({ authorized: permissionRace.authorized,
          blockedReason: permissionRace.blockedReason },
        { authorized: false, blockedReason: 'permission_changed' },
        `${database}: current campaign permission must beat snapshot permission`);
        const unsupportedPermissionVersion = JSON.parse(psql(container, database, `begin;
          update public.deal_hunter_cim_campaigns set permission_version = 'future-activation-v2'
            where id='${reference.expectedCampaigns[0].campaignId}';
          set role service_role;
          select public.pursue_cim_authorize_provider_pending_v1(
            '${JSON.stringify(command).replaceAll("'", "''")}'::jsonb);
          rollback;`).split('\n').find((line) => line.startsWith('{')));
        assert.deepEqual({ authorized: unsupportedPermissionVersion.authorized,
          blockedReason: unsupportedPermissionVersion.blockedReason },
        { authorized: false, blockedReason: 'unknown_policy_version' },
        `${database}: unsupported permission version must fail closed at the durable gate`);
        const unsupportedBatchingVersion = JSON.parse(psql(container, database, `begin;
          update public.deal_hunter_broker_conversations
            set batching_policy_version = 'future-batching-v2'
            where id='${command.authoritySnapshot.conversation.id}';
          set role service_role;
          select public.pursue_cim_authorize_provider_pending_v1(
            '${JSON.stringify(command).replaceAll("'", "''")}'::jsonb);
          rollback;`).split('\n').find((line) => line.startsWith('{')));
        assert.deepEqual({ authorized: unsupportedBatchingVersion.authorized,
          blockedReason: unsupportedBatchingVersion.blockedReason },
        { authorized: false, blockedReason: 'unknown_policy_version' },
        `${database}: unsupported batching version must fail closed at the durable gate`);
        const delegatedBlockLines = psql(container, database, `begin;
          update public.deal_hunter_cim_live_provider_authorizations
            set expires_at='2026-09-25T18:59:00.000Z'::timestamptz
            where id='${command.authorizationId}';
          set role service_role;
          select public.pursue_cim_authorize_provider_pending_v1(
            '${JSON.stringify(command).replaceAll("'", "''")}'::jsonb);
          reset role;
          select count(*) from public.deal_hunter_cim_audit_events
            where event_type='final-gate-blocked'
              and transmission_id='${command.transmissionId}'
              and reason_code='live_authorization_invalid';
          rollback;`).split('\n').filter(Boolean);
        const delegatedBlock = JSON.parse(delegatedBlockLines[0]);
        assert.equal(delegatedBlock.authorized, false, database);
        assert.equal(delegatedBlock.blockedReason, 'live_authorization_invalid', database);
        assert.equal(Number(delegatedBlockLines[1]), 1,
          `${database}: retained P5 blockers require a transactional final-gate audit`);
        rejectAuditTransition('final-gate-authorized',
          'pursue_cim_authorize_provider_pending_v1', command);
        assert.deepEqual(JSON.parse(psql(container, database, `select jsonb_build_object(
          'transmission', (select state from public.deal_hunter_cim_transmissions
            where id='${command.transmissionId}'),
          'authorizationConsumed', (select consumed_at is not null
            from public.deal_hunter_cim_live_provider_authorizations
            where id='${command.authorizationId}'))`)),
        { transmission: 'prepared', authorizationConsumed: false }, database);
        if (database === 'pursue_cim_fresh') {
          const parallelGates = await Promise.all([
            concurrentRolledBackRpc('pursue_cim_authorize_provider_pending_v1', command),
            concurrentRolledBackRpc('pursue_cim_authorize_provider_pending_v1', command),
          ]);
          assert.equal(parallelGates.every((result) => result.authorized), true,
            `${database}: write-strength global locking must serialize successful gates`);
          const campaignVersion = JSON.parse(psql(container, database,
            `select jsonb_build_object('rowVersion',row_version,'revision',terminal_revision)
              from public.deal_hunter_cim_campaigns
              where id='${reference.expectedCampaigns[0].campaignId}';`));
          const terminalRace = { ...reference.terminalCommands[0],
            eventId: 'terminal-provider-race', scope: 'campaign',
            scopeId: reference.expectedCampaigns[0].campaignId,
            expectedRevision: campaignVersion.revision,
            expectedRowVersion: campaignVersion.rowVersion,
            nextState: 'stopped', reasonCode: 'operator-stop',
            evidenceId: 'provider-race-proof' };
          const [pendingRace, terminalRaceResult] = await Promise.all([
            concurrentRolledBackRpc('pursue_cim_authorize_provider_pending_v1', command),
            concurrentRolledBackRpc('pursue_cim_append_terminal_event_v1', terminalRace),
          ]);
          assert.equal(pendingRace.authorized, true);
          assert.equal(terminalRaceResult.applied, true);
        }
      }
      const outcome = await supabase.authorizeCimProviderPending(command);
      assert.deepEqual({ authorized: outcome.authorized,
        blockedReason: outcome.blockedReason,
        transmissionState: outcome.transmission?.state ?? null,
        rowVersion: outcome.transmission?.row_version ?? null,
        boundaryNonceDigest: outcome.boundaryNonceDigest },
      reference.expectedProviderPending[index], database);
    }
    assert.equal(reference.expectedSeam[2].entered, true);
    for (const [index, command] of reference.seamCommands.entries()) {
      if (index === 2) {
        rejectAuditTransition('provider-seam-entered',
          'pursue_cim_enter_provider_seam_v1', command);
        assert.equal(psql(container, database, `select provider_seam_entered_at is null
          from public.deal_hunter_cim_transmissions where id='${command.transmissionId}'`),
        't', database);
      }
      const outcome = await supabase.enterCimProviderSeam(command);
      assert.deepEqual(outcome, reference.expectedSeam[index], database);
    }
    const rolledBackRpc = (name, command) => JSON.parse(psql(container, database, `
      begin;
      set role service_role;
      select public.${name}('${JSON.stringify(command).replaceAll("'", "''")}'::jsonb);
      rollback;
    `));
    const acceptedObservedAt = reference.finalizeCommands[0].observedAt
      ?? reference.finalizeCommands[0].now;
    const cadence = deriveAcceptedCimCadence(
      await supabase.readCimCadenceContext({
        transmissionId: reference.finalizeCommands[0].transmissionId,
      }), acceptedObservedAt);
    const acceptedFinalizationCommand = {
      ...reference.finalizeCommands[0], outcome: 'accepted',
      providerMessageId: 'accepted-proof', providerResultCode: 'accepted', cadence,
    };
    const acceptedFinalizationPayload = JSON.stringify(acceptedFinalizationCommand)
      .replaceAll("'", "''");
    const acceptedFinalizations = psql(container, database, `
      begin;
      set role service_role;
      select public.pursue_cim_finalize_with_cadence_v1(
        '${acceptedFinalizationPayload}'::jsonb);
      select public.pursue_cim_finalize_with_cadence_v1(
        '${acceptedFinalizationPayload}'::jsonb);
      reset role;
      select jsonb_build_object(
        'slotCount', (select count(*) from public.deal_hunter_cim_campaign_touches
          where campaign_id=(select campaign_id
            from public.deal_hunter_cim_transmission_touches
            where transmission_id='${acceptedFinalizationCommand.transmissionId}')
            and ordinal=1),
        'campaignRowVersion', (select row_version from public.deal_hunter_cim_campaigns
          where id=(select campaign_id from public.deal_hunter_cim_transmission_touches
            where transmission_id='${acceptedFinalizationCommand.transmissionId}')));
      rollback;
    `).split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.equal(acceptedFinalizations[0].applied, true, database);
    assert.equal(acceptedFinalizations[0].transmission.state, 'accepted', database);
    assert.equal(acceptedFinalizations[0].nextTouch.kind, 'follow-up-1', database);
    assert.equal(acceptedFinalizations[1].existing, true,
      `${database}: exact accepted finalization must replay`);
    assert.equal(acceptedFinalizations[1].nextTouch.id,
      acceptedFinalizations[0].nextTouch.id, database);
    assert.deepEqual(acceptedFinalizations[2], { slotCount: 1, campaignRowVersion: 2 },
      `${database}: replay must not duplicate the slot or bump campaign authority`);
    const forgedExpiryCadence = { ...cadence,
      localExpiryAt: '2027-09-25T19:00:07.000Z',
      expiryDerivation: { ...cadence.expiryDerivation,
        localExpiry: '2027-09-25T12:00:07',
        expiresAt: '2027-09-25T19:00:07.000Z' } };
    assert.notEqual(rejectedSql(container, database, `
      begin;
      set role service_role;
      select public.pursue_cim_finalize_with_cadence_v1(
        '${JSON.stringify({ ...acceptedFinalizationCommand,
          cadence: forgedExpiryCadence }).replaceAll("'", "''")}'::jsonb);
      rollback;
    `).status, 0, `${database}: caller cannot forge the 21-local-day expiry`);
    const failedFinalization = rolledBackRpc('pursue_cim_finalize_with_cadence_v1', {
      ...reference.finalizeCommands[0], outcome: 'definitive-failure',
      providerResultCode: 'provider-rejected',
    });
    assert.equal(failedFinalization.applied, true, database);
    assert.equal(failedFinalization.transmission.state, 'definitive-failure', database);
    assert.equal(failedFinalization.nextTouch, null, database);
    const acceptedReconciliationCommand = {
      ...reference.reconcileCommands[0], expectedRowVersion: 3,
      outcome: 'accepted', providerMessageId: 'reconciled-proof',
      evidenceId: 'direct-accepted-proof', cadence,
    };
    const acceptedReconciliationPayload = JSON.stringify(acceptedReconciliationCommand)
      .replaceAll("'", "''");
    const acceptedReconciliations = psql(container, database, `
      begin;
      set role service_role;
      select public.pursue_cim_reconcile_with_cadence_v1(
        '${acceptedReconciliationPayload}'::jsonb);
      select public.pursue_cim_reconcile_with_cadence_v1(
        '${acceptedReconciliationPayload}'::jsonb);
      reset role;
      select count(*) from public.deal_hunter_cim_campaign_touches
        where campaign_id=(select campaign_id
          from public.deal_hunter_cim_transmission_touches
          where transmission_id='${acceptedReconciliationCommand.transmissionId}')
          and ordinal=1;
      rollback;
    `).split('\n').filter(Boolean);
    const acceptedReconciliation = acceptedReconciliations.slice(0, 2).map(JSON.parse);
    assert.equal(acceptedReconciliation[0].applied, true, database);
    assert.equal(acceptedReconciliation[0].transmission.state, 'accepted', database);
    assert.equal(acceptedReconciliation[1].unchanged, true,
      `${database}: exact accepted reconciliation must replay`);
    assert.equal(acceptedReconciliation[1].nextTouch.id,
      acceptedReconciliation[0].nextTouch.id, database);
    assert.equal(Number(acceptedReconciliations[2]), 1,
      `${database}: reconciliation replay must not duplicate the slot`);
    const chainDatabase = `p6d_chain_${database.endsWith('fresh') ? 'f' : 'u'}_${process.pid}`;
    run(dockerCommand, ['exec', container, 'createdb', '-U', 'postgres',
      '-T', database, chainDatabase]);
    const committedCadenceRpc = (name, command) => JSON.parse(psql(container,
      chainDatabase, `set role service_role;
        select public.${name}(
          '${JSON.stringify(command).replaceAll("'", "''")}'::jsonb);`));
    let chain = committedCadenceRpc('pursue_cim_finalize_with_cadence_v1',
      acceptedFinalizationCommand);
    const chainKinds = ['follow-up-1', 'follow-up-2', 'follow-up-3',
      'weekday-follow-up'];
    const chainObservedAt = [chain.nextTouch.due_at, '2026-10-01T15:00:07.000Z',
      '2026-10-05T15:00:07.000Z', '2026-10-16T18:59:00.000Z'];
    for (const [index, expectedKind] of chainKinds.entries()) {
      assert.equal(chain.nextTouch.kind, expectedKind, `${chainDatabase}:${expectedKind}`);
      const stageTransmissionId = `p6d-chain-transmission-${index + 1}`;
      const stageCommunicationId = `p6d-chain-communication-${index + 1}`;
      const stageOutboxId = `p6d-chain-outbox-${index + 1}`;
      const primed = JSON.parse(psql(container, chainDatabase, `
        insert into public.crm_communications select
          (pg_catalog.jsonb_populate_record(null::public.crm_communications,
            pg_catalog.to_jsonb(src)||pg_catalog.jsonb_build_object(
              'id','${stageCommunicationId}','outbox_id','${stageOutboxId}',
              'provider',null,'provider_message_id',null,
              'idempotency_key','p6d-chain-communication-${index + 1}',
              'delivery_state','provider-pending','delivery_state_at','${chainObservedAt[index]}',
              'occurred_at','${chainObservedAt[index]}','created_at','${chainObservedAt[index]}',
              'updated_at','${chainObservedAt[index]}'))).* from public.crm_communications src
          where id=(select communication_id from public.deal_hunter_cim_transmissions
            where id='${acceptedFinalizationCommand.transmissionId}');
        insert into public.crm_email_outbox select
          (pg_catalog.jsonb_populate_record(null::public.crm_email_outbox,
            pg_catalog.to_jsonb(src)||pg_catalog.jsonb_build_object(
              'id','${stageOutboxId}','communication_id','${stageCommunicationId}',
              'idempotency_key','p6d-chain-outbox-${index + 1}',
              'client_request_key','p6d-chain-client-${index + 1}',
              'state','provider-pending','provider',null,'provider_message_id',null,
              'attempt_count',0,'created_at','${chainObservedAt[index]}',
              'updated_at','${chainObservedAt[index]}'))).* from public.crm_email_outbox src
          where id=(select outbox_id from public.deal_hunter_cim_transmissions
            where id='${acceptedFinalizationCommand.transmissionId}');
        insert into public.deal_hunter_cim_transmissions select
          (pg_catalog.jsonb_populate_record(null::public.deal_hunter_cim_transmissions,
            pg_catalog.to_jsonb(src)||pg_catalog.jsonb_build_object(
              'id','${stageTransmissionId}',
              'member_digest',public.pursue_cim_digest_v1(
                pg_catalog.to_jsonb('p6d-chain-member-${index + 1}'::text)),
              'preparation_generation',src.preparation_generation+${index + 1},
              'payload_digest',public.pursue_cim_digest_v1(
                pg_catalog.to_jsonb('p6d-chain-payload-${index + 1}'::text)),
              'provider_idempotency_key','p6d-chain-provider-${index + 1}',
              'communication_id','${stageCommunicationId}','outbox_id','${stageOutboxId}',
              'state','provider-pending','invocation_authority_count',1,
              'provider_invocation_authorized_at','${chainObservedAt[index]}',
              'boundary_nonce_digest',repeat('${index + 1}',64),
              'provider_seam_entered_at','${chainObservedAt[index]}',
              'provider',null,'provider_message_id',null,'provider_result_code',null,
              'row_version',3,'created_at','${chainObservedAt[index]}',
              'updated_at','${chainObservedAt[index]}'))).*
          from public.deal_hunter_cim_transmissions src
          where id='${acceptedFinalizationCommand.transmissionId}';
        update public.deal_hunter_cim_campaign_touches set state='provider-pending',
          transmission_id='${stageTransmissionId}',
          row_version=row_version+1,updated_at='${chainObservedAt[index]}'
          where id='${chain.nextTouch.id}';
        insert into public.deal_hunter_cim_transmission_touches
          (transmission_id,touch_id,opportunity_id,campaign_id,display_ordinal,created_at)
        select '${stageTransmissionId}',id,opportunity_id,campaign_id,1,'${chainObservedAt[index]}'
          from public.deal_hunter_cim_campaign_touches where id='${chain.nextTouch.id}';
        select jsonb_build_object('transmissionId',id,
          'rowVersion',row_version,'payloadDigest',payload_digest)
          from public.deal_hunter_cim_transmissions
          where id='${stageTransmissionId}';`));
      const context = JSON.parse(psql(container, chainDatabase, `set role service_role;
        select public.pursue_cim_read_cadence_context_v1(
          '{"transmissionId":"${stageTransmissionId}"}'::jsonb);`));
      const stageCadence = deriveAcceptedCimCadence(context, chainObservedAt[index]);
      const stageCommand = {
        ...acceptedFinalizationCommand, transmissionId: primed.transmissionId,
        expectedRowVersion: primed.rowVersion,
        payloadDigest: primed.payloadDigest,
        providerMessageId: `p6d-chain-provider-${index + 1}`,
        observedAt: chainObservedAt[index], now: chainObservedAt[index],
        cadence: stageCadence,
      };
      if (index === 0) {
        const fixedIdentityRejection = rejectedSql(container, chainDatabase, `begin;
          update public.deal_hunter_cim_campaign_touches
            set logical_slot='tampered-follow-up'
            where id='${chain.nextTouch.id}';
          set role service_role;
          select public.pursue_cim_finalize_with_cadence_v1(
            '${JSON.stringify(stageCommand).replaceAll("'", "''")}'::jsonb);
          rollback;`);
        assert.notEqual(fixedIdentityRejection.status, 0,
        `${chainDatabase}: malformed durable follow-up identity must fail closed`);
        assert.match(fixedIdentityRejection.stderr,
          /Invalid current Pursue CIM cadence touch/);
        const bindingRejection = rejectedSql(container, chainDatabase, `begin;
          update public.deal_hunter_cim_campaign_touches touch
            set opportunity_id=other.opportunity_id
            from public.deal_hunter_opportunities other
            where touch.id='${chain.nextTouch.id}'
              and other.opportunity_id<>touch.opportunity_id;
          set role service_role;
          select public.pursue_cim_finalize_with_cadence_v1(
            '${JSON.stringify(stageCommand).replaceAll("'", "''")}'::jsonb);
          rollback;`);
        assert.notEqual(bindingRejection.status, 0,
        `${chainDatabase}: mismatched durable membership binding must fail closed`);
        assert.match(bindingRejection.stderr,
          /Ineligible Pursue CIM outcome cannot advance cadence/);
      }
      if (index === 3) {
        const weekdayIdentityRejection = rejectedSql(container, chainDatabase, `begin;
          update public.deal_hunter_cim_campaign_touches set ordinal=3
            where id='${chain.nextTouch.id}';
          set role service_role;
          select public.pursue_cim_finalize_with_cadence_v1(
            '${JSON.stringify(stageCommand).replaceAll("'", "''")}'::jsonb);
          rollback;`);
        assert.notEqual(weekdayIdentityRejection.status, 0,
        `${chainDatabase}: malformed durable weekday identity must fail closed`);
        assert.match(weekdayIdentityRejection.stderr,
          /Invalid current Pursue CIM cadence touch/);
      }
      chain = committedCadenceRpc('pursue_cim_finalize_with_cadence_v1', stageCommand);
      assert.equal(chain.applied, true, chainDatabase);
    }
    assert.equal(chain.nextTouch, null,
      `${chainDatabase}: weekday progression must stop at local expiry`);
    assert.deepEqual(JSON.parse(psql(container, chainDatabase, `select jsonb_build_object(
      'kinds',(select jsonb_agg(kind order by ordinal)
        from public.deal_hunter_cim_campaign_touches
        where campaign_id=(select campaign_id
          from public.deal_hunter_cim_transmission_touches
          where transmission_id='${acceptedFinalizationCommand.transmissionId}')),
      'expiry',(select local_expiry_at from public.deal_hunter_cim_campaigns
        where id=(select campaign_id from public.deal_hunter_cim_transmission_touches
          where transmission_id='${acceptedFinalizationCommand.transmissionId}')));`)), {
      kinds: ['initial', 'follow-up-1', 'follow-up-2', 'follow-up-3', 'weekday-follow-up'],
      expiry: '2026-10-16T19:00:00+00:00',
    }, `${chainDatabase}: durable PostgreSQL cadence must match SQLite`);
    const directPendingReconciliation = { ...reference.reconcileCommands[0],
      expectedRowVersion: 3, evidenceId: 'direct-provider-pending' };
    const directPayload = JSON.stringify(directPendingReconciliation).replaceAll("'", "''");
    const directPriorState = psql(container, database, `
      begin;
      set role service_role;
      select public.pursue_cim_reconcile_with_cadence_v1('${directPayload}'::jsonb);
      reset role;
      select prior_state from public.deal_hunter_cim_audit_events
        where event_type='transmission-reconciled' and source='operator-check'
          and metadata='{}'::jsonb;
      rollback;
    `).split('\n').at(-1);
    assert.equal(directPriorState, 'provider-pending',
      `${database}: direct provider-pending reconciliation audit must retain actual prior state`);
    const multipleIdentityCommand = {
      ...reference.reconcileCommands[0],
      expectedRowVersion: 3,
      outcome: 'ambiguous',
      providerMessageId: null,
      providerResultCode: 'multiple-provider-ids',
      evidenceId: 'multiple-provider-ids',
      observedAt: '2026-09-25T19:00:07.000Z',
      providerIdentities: [
        { provider: 'resend', providerMessageId: 'provider-a', evidenceId: 'candidate-a',
          evidenceDigest: 'b'.repeat(64) },
        { provider: 'resend', providerMessageId: 'provider-b', evidenceId: 'candidate-b',
          evidenceDigest: 'c'.repeat(64) },
      ],
    };
    const changedEvidenceCommand = { ...multipleIdentityCommand,
      observedAt: '2026-09-25T19:00:08.000Z' };
    const evidenceReplay = psql(container, database, `begin;
      set role service_role;
      select public.pursue_cim_reconcile_with_cadence_v1(
        '${JSON.stringify(multipleIdentityCommand).replaceAll("'", "''")}'::jsonb);
      select public.pursue_cim_reconcile_with_cadence_v1(
        '${JSON.stringify(multipleIdentityCommand).replaceAll("'", "''")}'::jsonb);
      select public.pursue_cim_reconcile_with_cadence_v1(
        '${JSON.stringify(changedEvidenceCommand).replaceAll("'", "''")}'::jsonb);
      rollback;`).split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.deepEqual(evidenceReplay.map(({ applied, unchanged, conflict }) =>
      ({ applied, unchanged, conflict })), [
      { applied: true, unchanged: false, conflict: false },
      { applied: false, unchanged: true, conflict: false },
      { applied: false, unchanged: false, conflict: true },
    ], `${database}: multiple-ID evidence must be bounded, replayable, and drift-sensitive`);
    const invalidIdentity = rejectedSql(container, database, `begin;
      set role service_role;
      select public.pursue_cim_reconcile_with_cadence_v1(
        '${JSON.stringify({ ...multipleIdentityCommand,
          providerIdentities: [{ provider: 'resend', providerMessageId: 'bad id',
            evidenceId: 'candidate-a', evidenceDigest: 'b'.repeat(64) },
          multipleIdentityCommand.providerIdentities[1]] }).replaceAll("'", "''")}'::jsonb);
      rollback;`);
    assert.notEqual(invalidIdentity.status, 0,
      `${database}: malformed provider identities must fail before mutation`);
    assert.equal(reference.expectedFinalizations[0].applied, true);
    for (const [index, command] of reference.finalizeCommands.entries()) {
      if (index === 0) {
        rejectAuditTransition('transmission-finalized',
          'pursue_cim_finalize_with_cadence_v1', command);
        assert.deepEqual(JSON.parse(psql(container, database, `select jsonb_build_object(
          'transmission', (select state from public.deal_hunter_cim_transmissions
            where id='${command.transmissionId}'),
          'touch', (select state from public.deal_hunter_cim_campaign_touches
            where id='${reference.materializedClaimCommand.touchId}'))`)),
        { transmission: 'provider-pending', touch: 'provider-pending' }, database);
      }
      const outcome = await supabase.finalizeCimTransmission(command);
      assert.deepEqual({ applied: outcome.applied, existing: outcome.existing,
        conflict: outcome.conflict, transmissionState: outcome.transmission?.state ?? null,
        rowVersion: outcome.transmission?.row_version ?? null,
        nextTouchId: outcome.nextTouch?.id ?? null },
      reference.expectedFinalizations[index], database);
    }
    assert.equal(reference.expectedReconciliations[0].applied, true);
    for (const [index, command] of reference.reconcileCommands.entries()) {
      const outcome = await supabase.reconcileCimTransmission(command);
      assert.deepEqual({ applied: outcome.applied, unchanged: outcome.unchanged,
        conflict: outcome.conflict, transmissionState: outcome.transmission?.state ?? null,
        rowVersion: outcome.transmission?.row_version ?? null },
      reference.expectedReconciliations[index], database);
    }
    const sourceTransmissionId = reference.expectedPreparations.at(-1).transmissionId;
    psql(container, database, `
      insert into public.crm_communications
        (id, submission_id, opportunity_id, direction, channel, source, kind,
         idempotency_key, outbox_id, thread_key, from_address, to_addresses,
         cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
         body_html_sanitized, occurred_at, created_at, updated_at, metadata)
      select 'comm-withdraw', submission_id, opportunity_id, direction, channel, source,
        kind, 'comm-withdraw', 'outbox-withdraw', thread_key, from_address, to_addresses,
        cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
        body_html_sanitized, occurred_at, created_at, updated_at, metadata
      from public.crm_communications where id =
        (select communication_id from public.deal_hunter_cim_transmissions where id='${sourceTransmissionId}');
      insert into public.crm_email_outbox
        (id, communication_id, submission_id, idempotency_key, client_request_key,
         state, attempt_count, expected_submission_version, actor, created_at, updated_at, metadata)
      select 'outbox-withdraw', 'comm-withdraw', submission_id, 'outbox-withdraw',
        'request-withdraw', 'prepared', 0, expected_submission_version, actor,
        created_at, updated_at, metadata from public.crm_email_outbox where id =
        (select outbox_id from public.deal_hunter_cim_transmissions where id='${sourceTransmissionId}');
      insert into public.deal_hunter_cim_transmissions
        (id, conversation_id, member_digest, preparation_generation, payload_version,
         payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
         reply_to_address, subject, provider_idempotency_key, communication_id,
         outbox_id, state, release_state, created_at, updated_at)
      select 'trans-withdraw', conversation_id, repeat('f',64), 3, payload_version,
        payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
        reply_to_address, subject, 'provider-key-withdraw', 'comm-withdraw',
        'outbox-withdraw', 'prepared', 'ordinary', created_at, updated_at
      from public.deal_hunter_cim_transmissions where id='${sourceTransmissionId}';
      insert into public.deal_hunter_cim_campaign_touches
        (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at,
         due_local, timezone_revision, state, claim_token_digest, claim_owner,
         claimed_at, claim_expires_at, transmission_id, created_at, updated_at)
      values ('touch-withdraw', '${reference.expectedCampaigns[0].campaignId}', 'opp-decision',
        'withdraw-slot', 'follow-up-1', 1, '${now}', '2026-09-25T12:00:00-07:00',
        1, 'claimed', repeat('6',64), 'fixture', '${now}',
        '2026-09-25T20:00:00.000Z', 'trans-withdraw', '${now}', '${now}');
      insert into public.deal_hunter_cim_transmission_touches
        (transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at)
      values ('trans-withdraw', 'touch-withdraw', 'opp-decision',
        '${reference.expectedCampaigns[0].campaignId}', 1, '${now}');
      insert into public.deal_hunter_cim_live_provider_authorizations
        (id, activation_id, capability, writer_path, transmission_id, payload_digest,
         recipient_authority_digest, provider_profile, maximum_calls, issued_at,
         expires_at, actor, reason)
      select 'authorization-withdraw', 'activation-initial', 'fl04b-initial',
        'withdraw-writer', 'trans-withdraw', payload_digest, repeat('8',64),
        'synthetic-provider', 1, '${now}', '2026-09-25T20:00:00.000Z',
        'fixture', 'synthetic withdrawal'
      from public.deal_hunter_cim_transmissions where id='trans-withdraw';
    `);
    assert.equal(reference.expectedLiveWithdrawals[0].applied, true);
    for (const [index, command] of reference.liveWithdrawalCommands.entries()) {
      const outcome = await supabase.withdrawCimLiveProviderAuthorization(command);
      assert.deepEqual({ applied: outcome.applied, replay: outcome.replay,
        conflict: outcome.conflict, authorizationId: outcome.authorization?.id ?? null,
        withdrawnAt: outcome.authorization?.withdrawn_at ?? null },
      reference.expectedLiveWithdrawals[index], database);
    }
    const withdrawalState = JSON.parse(psql(container, database, `select jsonb_build_object(
      'transmission', (select state from public.deal_hunter_cim_transmissions where id='trans-withdraw'),
      'touch', (select state from public.deal_hunter_cim_campaign_touches where id='touch-withdraw'),
      'membershipCancelled', (select cancelled_at is not null from public.deal_hunter_cim_transmission_touches where transmission_id='trans-withdraw'),
      'outbox', (select state from public.crm_email_outbox where id='outbox-withdraw'))`));
    assert.deepEqual(withdrawalState, reference.expectedWithdrawalState, database);
    psql(container, database, `insert into public.deal_hunter_cim_campaign_touches
      (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at,
       due_local, timezone_revision, state, created_at, updated_at)
      values ('touch-fence', '${reference.expectedCampaigns[0].campaignId}', 'opp-decision',
        'fence-slot', 'follow-up-1', 1, '${now}', '2026-09-25T12:00:00-07:00',
        1, 'scheduled', '${now}', '${now}');`);
    const campaignIdentity = JSON.parse(psql(container, database, `select jsonb_build_object(
      'rowVersion', row_version, 'revision', terminal_revision) from public.deal_hunter_cim_campaigns
      where id='${reference.expectedCampaigns[0].campaignId}';`));
    const campaignTerminal = rolledBackRpc('pursue_cim_append_terminal_event_v1', {
      ...reference.terminalCommands[0], eventId: 'terminal-campaign-proof',
      scope: 'campaign', scopeId: reference.expectedCampaigns[0].campaignId,
      expectedRevision: campaignIdentity.revision,
      expectedRowVersion: campaignIdentity.rowVersion,
      nextState: 'stopped', reasonCode: 'operator-stop',
      evidenceId: 'campaign-stop-proof',
    });
    assert.equal(campaignTerminal.applied, true,
      `${database}:${JSON.stringify({ campaignTerminal, campaignIdentity,
        campaignState: psql(container, database, `select state || ':' || coalesce(reason_code, '') from public.deal_hunter_cim_campaigns
          where id='${reference.expectedCampaigns[0].campaignId}'`) })}`);
    assert.ok(campaignTerminal.cancelledTouchIds.includes('touch-fence'), database);
    assert.equal(reference.expectedTerminals[0].applied, true);
    for (const [index, command] of reference.terminalCommands.entries()) {
      const outcome = await supabase.appendCimTerminalEvent(command);
      assert.deepEqual({ applied: outcome.applied, replay: outcome.replay,
        conflict: outcome.conflict, campaignRevision: outcome.campaignRevision,
        conversationRevision: outcome.conversationRevision,
        cancelledTouchIds: outcome.cancelledTouchIds },
      reference.expectedTerminals[index], database);
    }
    const terminalState = JSON.parse(psql(container, database, `select jsonb_build_object(
      'campaign', (select state from public.deal_hunter_cim_campaigns where id='${reference.expectedCampaigns[0].campaignId}'),
      'touch', (select state from public.deal_hunter_cim_campaign_touches where id='touch-fence'))`));
    assert.deepEqual(terminalState, reference.expectedTerminalState, database);
    psql(container, database, `
      insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('opp-safety', '${now}', '${now}', 'Synthetic safety', 'cim-identity-v1');
      insert into public.deal_hunter_owner_decision_events
        (id, idempotency_key, request_digest, opportunity_id, action, actor,
         expected_discovery_revision, expected_material_revision, observed_discovery_revision,
         observed_material_revision, policy_version, created_at)
      values ('decision-safety', 'key-safety', repeat('a',64), 'opp-safety', 'pursue',
        'fixture', 0, 0, 0, 0, 'policy-v1', '${now}');
      insert into public.deal_hunter_pursuit_enrollments
        (id, decision_event_id, opportunity_id, state, authority_digest, created_at, updated_at)
      values ('enrollment-safety', 'decision-safety', 'opp-safety',
        'campaign-created', repeat('b',64), '${now}', '${now}');
      insert into public.deal_hunter_opportunity_timezone_revisions
        (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
         evidence_digest, resolver_version, dataset_digest, actor, created_at)
      values ('opp-safety', 1, 'verified', 'America/Los_Angeles',
        'operator-verified', 'timezone-safety', repeat('c',64), 'explicit-v1',
        repeat('d',64), 'fixture', '${now}');
      insert into public.deal_hunter_broker_conversations
        (id, recipient_authority_id, recipient_fingerprint, recipient_address,
         sender_policy_version, reply_policy_version, reply_alias_token_digest,
         rfc_thread_key, state, batching_policy_version, created_at, updated_at)
      values ('conversation-safety', 'recipient-safety', repeat('8',64),
        'safety@example.test', 'sender-v1', 'reply-v1', repeat('0',64),
        'thread-safety', 'open', 'batching-off-v1', '${now}', '${now}');
      insert into public.deal_hunter_cim_campaigns
        (id, opportunity_id, generation, enrollment_id, decision_event_id,
         policy_version, template_version, template_digest, permission_version,
         permission_digest, permission_revision, permission_scope, canonical_revision,
         crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
         freshness_authority_digest, discovery_revision, material_revision,
         timezone_revision, conversation_id, state, reason_code, created_at, updated_at)
      values ('campaign-safety', 'opp-safety', 1, 'enrollment-safety', 'decision-safety',
        'policy-v1', 'template-v1', repeat('1',64), 'permission-v1', repeat('2',64),
        1, 'synthetic-cohort', 1, 1, 'recipient-safety', repeat('8',64), repeat('3',64),
        0, 0, 1, 'conversation-safety', 'initial-pending', 'awaiting-window', '${now}', '${now}');
      insert into public.crm_communications
        (id, submission_id, opportunity_id, direction, channel, source, kind,
         idempotency_key, outbox_id, thread_key, from_address, to_addresses,
         cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
         body_html_sanitized, occurred_at, created_at, updated_at, metadata)
      select 'comm-safety', submission_id, 'opp-safety', direction, channel, source,
        kind, 'comm-safety', 'outbox-safety', 'thread-safety', from_address, to_addresses,
        cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
        body_html_sanitized, occurred_at, created_at, updated_at, metadata
      from public.crm_communications where id =
        (select communication_id from public.deal_hunter_cim_transmissions where id='${sourceTransmissionId}');
      insert into public.crm_email_outbox
        (id, communication_id, submission_id, idempotency_key, client_request_key,
         state, attempt_count, expected_submission_version, actor, created_at, updated_at, metadata)
      select 'outbox-safety', 'comm-safety', submission_id, 'outbox-safety',
        'request-safety', 'prepared', 0, expected_submission_version, actor,
        created_at, updated_at, metadata from public.crm_email_outbox where id =
        (select outbox_id from public.deal_hunter_cim_transmissions where id='${sourceTransmissionId}');
      insert into public.deal_hunter_cim_transmissions
        (id, conversation_id, member_digest, preparation_generation, payload_version,
         payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
         reply_to_address, subject, provider_idempotency_key, communication_id,
         outbox_id, state, release_state, created_at, updated_at)
      select 'trans-safety', 'conversation-safety', repeat('a',64), 1, payload_version,
        payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
        reply_to_address, subject, 'provider-key-safety', 'comm-safety', 'outbox-safety',
        'prepared', 'ordinary', created_at, updated_at
      from public.deal_hunter_cim_transmissions where id='${sourceTransmissionId}';
      insert into public.deal_hunter_cim_campaign_touches
        (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at,
         due_local, timezone_revision, state, claim_token_digest, claim_owner,
         claimed_at, claim_expires_at, transmission_id, created_at, updated_at)
      values ('touch-safety', 'campaign-safety', 'opp-safety', 'initial', 'initial', 0,
        '${now}', '2026-09-25T12:00:00-07:00', 1, 'claimed', repeat('6',64),
        'fixture', '${now}', '2026-09-25T20:00:00.000Z', 'trans-safety', '${now}', '${now}');
      insert into public.deal_hunter_cim_transmission_touches
        (transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at)
      values ('trans-safety', 'touch-safety', 'opp-safety', 'campaign-safety', 1, '${now}');
      insert into public.deal_hunter_cim_live_provider_authorizations
        (id, activation_id, capability, writer_path, transmission_id, payload_digest,
         recipient_authority_digest, provider_profile, maximum_calls, issued_at,
         expires_at, actor, reason)
      select 'authorization-safety', 'activation-initial', 'fl04b-initial',
        'safety-writer', 'trans-safety', payload_digest, repeat('8',64),
        'synthetic-provider', 1, '${now}', '2026-09-25T20:00:00.000Z',
        'fixture', 'synthetic safety'
      from public.deal_hunter_cim_transmissions where id='trans-safety';
    `);
    psql(container, database, `insert into public.deal_hunter_cim_safety_events
      (id, safety_run_id, opportunity_id, source_type, source_run_id,
       canonical_revision, identity_exception_revision, event_type, evidence_id,
       status, created_at, updated_at)
      values
      ('p2-limit-changed', 'p2-limit-run', 'opp-safety', 'synthetic-test',
       'p2-limit-source', 0, 0, 'source-record-changed', 'p2-evidence-changed',
       'pending', '${now}', '${now}'),
      ('p2-limit-unchanged', 'p2-limit-run', 'opp-safety', 'synthetic-test',
       'p2-limit-source', 0, 0, 'source-record-unchanged', 'p2-evidence-unchanged',
       'pending', '${now}'::timestamptz + interval '1 second',
       '${now}'::timestamptz + interval '1 second');`);
    const limitResult = rolledBackRpc('pursue_cim_consume_safety_events_v1', {
      safetyRunId: 'p2-limit-run', limit: 1, actor: 'fixture', now,
      outcomes: { 'p2-limit-changed': 'review-required',
        'p2-limit-unchanged': 'no-op' },
    });
    assert.deepEqual({ reviewRequired: limitResult.reviewRequired, noOp: limitResult.noOp,
      pending: limitResult.pending }, { reviewRequired: 1, noOp: 0, pending: 1 }, database);
    await supabase.appendCimSafetyEvents(reference.safetyStopRun);
    assert.equal(psql(container, database, `select id from public.deal_hunter_cim_safety_events
      where safety_run_id='safety-run-stop'`), reference.safetyStopEventId);
    psql(container, database, `
      create function public.p1c_reject_safety_audit() returns trigger
      language plpgsql set search_path = '' as $$
      begin
        if new.event_type = 'safety-consumed' then
          raise exception 'synthetic audit failure';
        end if;
        return new;
      end;
      $$;
      create trigger p1c_reject_safety_audit
        before insert on public.deal_hunter_cim_audit_events
        for each row execute function public.p1c_reject_safety_audit();
    `);
    const rollbackCommand = JSON.stringify(reference.safetyConsumeCommands[0]).replaceAll("'", "''");
    const rejected = rejectedSql(container, database, `set role service_role;
      select public.pursue_cim_consume_safety_events_v1('${rollbackCommand}'::jsonb);`);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /synthetic audit failure/);
    assert.deepEqual(JSON.parse(psql(container, database, `select jsonb_build_object(
      'event', (select status from public.deal_hunter_cim_safety_events where id='${reference.safetyStopEventId}'),
      'campaign', (select state from public.deal_hunter_cim_campaigns where id='campaign-safety'),
      'transmission', (select state from public.deal_hunter_cim_transmissions where id='trans-safety'),
      'auditCount', (select count(*) from public.deal_hunter_cim_audit_events
        where event_type='safety-consumed' and opportunity_id='opp-safety'))`)),
    { event: 'pending', campaign: 'initial-pending', transmission: 'prepared', auditCount: 0 }, database);
    psql(container, database, `drop trigger p1c_reject_safety_audit
      on public.deal_hunter_cim_audit_events;
      drop function public.p1c_reject_safety_audit();`);
    assert.equal(reference.expectedSafetyConsumptions[0].stopped, 1);
    for (const [index, command] of reference.safetyConsumeCommands.entries()) {
      const outcome = await supabase.consumeCimSafetyEvents(command);
      assert.deepEqual(outcome, reference.expectedSafetyConsumptions[index], database);
    }
    const safetyStopState = JSON.parse(psql(container, database, `select jsonb_build_object(
      'campaign', (select state from public.deal_hunter_cim_campaigns where id='campaign-safety'),
      'touch', (select state from public.deal_hunter_cim_campaign_touches where id='touch-safety'),
      'transmission', (select state from public.deal_hunter_cim_transmissions where id='trans-safety'),
      'authorizationWithdrawn', (select withdrawn_at is not null from public.deal_hunter_cim_live_provider_authorizations where id='authorization-safety'),
      'outbox', (select state from public.crm_email_outbox where id='outbox-safety'))`));
    assert.deepEqual(safetyStopState, reference.expectedSafetyStopState, database);
    for (const [index] of expectedWithdrawals.entries()) {
      const outcome = await supabase.withdrawCimCapabilityActivation(withdrawalCommand);
      assert.deepEqual({ applied: outcome.applied, replay: outcome.replay,
        conflict: outcome.conflict, status: outcome.activation?.status ?? null },
      expectedWithdrawals[index], database);
    }
    assert.equal(Number(psql(container, database, `select count(*) from public.deal_hunter_cim_audit_events
      where event_type in ('capability-activation', 'capability-withdrawn');`)), 4);
  }
});

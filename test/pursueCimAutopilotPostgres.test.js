import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSupabaseStorage } from '../server/storage/supabase.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';
const baseSha = '0361a178dbaa36847ca6235fc300df9e209687ef';
const migrationPath = path.join(root, 'supabase/migrations/20260925120000_pursue_cim_autopilot.sql');
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
  'pursue_cim_append_safety_events_v1',
  'pursue_cim_append_terminal_event_v1',
  'pursue_cim_append_timezone_revision_v1',
  'pursue_cim_assert_types_v1',
  'pursue_cim_authorize_provider_pending_v1',
  'pursue_cim_cancel_prepared_transmission_v1',
  'pursue_cim_claim_due_touch_v1',
  'pursue_cim_consume_safety_events_v1',
  'pursue_cim_current_activation_v1',
  'pursue_cim_digest_v1',
  'pursue_cim_enter_provider_seam_v1',
  'pursue_cim_finalize_transmission_v1',
  'pursue_cim_issue_live_authorization_v1',
  'pursue_cim_json_stringify_v1',
  'pursue_cim_materialize_campaign_v1',
  'pursue_cim_prepare_transmission_v1',
  'pursue_cim_read_projection_v1',
  'pursue_cim_reconcile_transmission_v1',
  'pursue_cim_record_capability_activation_v1',
  'pursue_cim_record_owner_decision_v1',
  'pursue_cim_required_instant_v1',
  'pursue_cim_required_revision_v1',
  'pursue_cim_required_text_v1',
  'pursue_cim_transition_enrollment_v1',
  'pursue_cim_withdraw_capability_activation_v1',
  'pursue_cim_withdraw_live_authorization_v1',
];

test('P1C fresh-schema RPC block exactly matches the upgrade migration', () => {
  const marker = '-- Package 1C: versioned Pursue CIM transition RPCs.';
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.equal(schema.slice(schema.indexOf(marker)), migration.slice(migration.indexOf(marker)));
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
  const before = legacyFingerprint(container, 'pursue_cim_upgrade');
  psql(container, 'pursue_cim_upgrade', migration);

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

  const now = '2026-09-25T19:00:00.000Z';
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
      configHash: 'b'.repeat(64), actor: 'fixture', reason: 'disposable parity',
      confirmation: 'fixture-confirmation', providerProfile: 'synthetic-provider', now },
    { id: 'activation-enrollment', capability: 'fl04b-enrollment', mode: 'active',
      prerequisiteActivationId: 'activation-safety', prerequisiteEvidenceId: 'evidence-1',
      prerequisiteEvidenceHash: 'c'.repeat(64), policyHash: 'a'.repeat(64),
      configHash: 'b'.repeat(64), actor: 'fixture', reason: 'disposable parity',
      confirmation: 'fixture-confirmation', providerProfile: 'synthetic-provider', now },
    { id: 'activation-initial', capability: 'fl04b-initial', mode: 'active',
      prerequisiteActivationId: 'activation-enrollment', prerequisiteEvidenceId: 'evidence-2',
      prerequisiteEvidenceHash: 'c'.repeat(64), policyHash: 'a'.repeat(64),
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
    generation: 1, policyVersion: 'policy-v1', templateVersion: 'template-v1',
    templateDigest: '1'.repeat(64), permissionVersion: 'permission-v1',
    permissionDigest: '2'.repeat(64), permissionRevision: 1,
    permissionScope: 'synthetic-cohort', canonicalRevision: 1,
    crmSubmissionId: '11111111-1111-4111-8111-111111111111', crmOwnershipRevision: 1,
    recipientAuthorityId: 'recipient-materialize', recipientFingerprint: '8'.repeat(64),
    recipientAddress: 'broker2@example.test', senderPolicyVersion: 'sender-v1',
    replyPolicyVersion: 'reply-v1', replyAliasTokenDigest: '9'.repeat(64),
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
      campaignCommands, withdrawalCommand })));
  const { expected, expectedTimezone, expectedActivations, expectedClaims,
    expectedProjection, expectedSafetyEmissions, expectedOwnerDecisions,
    expectedOwnerStops, expectedCampaigns, expectedWithdrawals } = reference;
  for (const database of ['pursue_cim_fresh', 'pursue_cim_upgrade']) {
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
        service: rpc.name !== 'pursue_cim_cancel_prepared_transmission_v1',
        fixedSearchPath: true }, `${database}:${rpc.name}`);
      if (!['pursue_cim_assert_types_v1', 'pursue_cim_current_activation_v1', 'pursue_cim_digest_v1',
        'pursue_cim_json_stringify_v1', 'pursue_cim_required_revision_v1',
        'pursue_cim_required_text_v1', 'pursue_cim_required_instant_v1'].includes(rpc.name)) {
        assert.equal(rpc.securityDefiner, true, `${database}:${rpc.name}`);
      }
    }
    const supabase = createSupabaseStorage({ storage: {} }, { client: {
      async rpc(name, payload) {
        assert.ok(['pursue_cim_transition_enrollment_v1',
          'pursue_cim_append_timezone_revision_v1',
          'pursue_cim_record_capability_activation_v1',
          'pursue_cim_withdraw_capability_activation_v1',
          'pursue_cim_claim_due_touch_v1',
          'pursue_cim_read_projection_v1',
          'pursue_cim_append_safety_events_v1',
          'pursue_cim_record_owner_decision_v1',
          'pursue_cim_materialize_campaign_v1',
          'pursue_cim_prepare_transmission_v1',
          'pursue_cim_issue_live_authorization_v1',
          'pursue_cim_authorize_provider_pending_v1',
          'pursue_cim_enter_provider_seam_v1',
          'pursue_cim_finalize_transmission_v1',
          'pursue_cim_reconcile_transmission_v1',
          'pursue_cim_withdraw_live_authorization_v1',
          'pursue_cim_append_terminal_event_v1',
          'pursue_cim_consume_safety_events_v1'].includes(name), name);
        const argument = JSON.stringify(payload.p_command ?? payload.p_run).replaceAll("'", "''");
        const data = JSON.parse(psql(container, database, `
          set role service_role;
          select public.${name}('${argument}'::jsonb);
        `));
        return { data, error: null };
      },
    } });
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
      ['pursue_cim_finalize_transmission_v1',
        { ...reference.finalizeCommands[0], providerMessageId: 42 }],
      ['pursue_cim_reconcile_transmission_v1',
        { ...reference.reconcileCommands[0], providerMessageId: 42 }],
      ['pursue_cim_append_terminal_event_v1',
        { ...reference.terminalCommands[0], preProviderResolution: 'true' }],
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
    `);
    for (const [index, command] of claimCommands.entries()) {
      const outcome = await supabase.claimDueCimTouch(command);
      assert.deepEqual({ claimed: outcome.claimed, alreadyOwned: outcome.alreadyOwned,
        staleAuthority: outcome.staleAuthority, terminal: outcome.terminal,
        conflict: outcome.conflict, state: outcome.touch?.state ?? null,
        rowVersion: outcome.touch?.row_version ?? null }, expectedClaims[index], database);
    }
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
    for (const [index, command] of ownerCommands.entries()) {
      const outcome = await supabase.recordOwnerDecision(command);
      assert.deepEqual({ applied: outcome.applied, replay: outcome.replay,
        conflict: outcome.conflict, decisionId: outcome.decision?.id ?? null,
        enrollmentId: outcome.enrollment?.id ?? null,
        enrollmentState: outcome.enrollment?.state ?? null },
      expectedOwnerDecisions[index], database);
    }
    psql(container, database, `insert into public.deal_hunter_opportunity_scores
      (opportunity_id, created_at, scored_at, deal_key, name, score_fingerprint,
       engine_version, rules_version, profile_version, completeness_policy_version,
       current_triage_eligible)
      values ('opp-parity', '${now}', '${now}', 'deal:opp-parity', 'Synthetic parity',
        'fingerprint:opp-parity', 'engine-v1', 'rules-v1', 'profile-v1', 'complete-v1', true);`);
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
    for (const [index, command] of reference.resolvedCampaignCommands.entries()) {
      const outcome = await supabase.materializePursuitCampaign(command);
      assert.deepEqual({ applied: outcome.applied, existing: outcome.existing,
        actionRequired: outcome.actionRequired, campaignId: outcome.campaign?.id ?? null,
        campaignState: outcome.campaign?.state ?? null,
        expiryDerivation: outcome.campaign?.expiry_derivation ?? null,
        touchId: outcome.initialTouch?.id ?? null,
        touchState: outcome.initialTouch?.state ?? null }, expectedCampaigns[index], database);
    }
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
    for (const [index, command] of reference.providerPendingCommands.entries()) {
      if (index === 2) assert.equal(reference.expectedProviderPending[index].authorized, true,
        'SQLite reference must authorize synthetic provider-pending storage transition');
      if (index === 2) psql(container, database, `insert into public.deal_hunter_cim_safety_settings
        (id, updated_at, outreach_paused, updated_by, metadata)
        values ('global', '${now}', false, 'fixture', '{}'::jsonb);`);
      if (index === 2) {
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
    assert.equal(reference.expectedSeam[1].entered, true);
    for (const [index, command] of reference.seamCommands.entries()) {
      if (index === 1) {
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
    const acceptedSlot = {
      localExpiryAt: '2026-10-16T19:00:00.000Z',
      expiryDerivation: { policy: 'synthetic-v1' },
      nextTouch: { logicalSlot: 'follow-up-1', kind: 'follow-up-1', ordinal: 1,
        dueAt: '2026-09-28T19:00:00.000Z', dueLocal: '2026-09-28T12:00:00-07:00',
        cadencePolicyVersion: 'cadence-v1' },
    };
    const acceptedFinalization = rolledBackRpc('pursue_cim_finalize_transmission_v1', {
      ...reference.finalizeCommands[0], ...acceptedSlot, outcome: 'accepted',
      providerMessageId: 'accepted-proof', providerResultCode: 'accepted',
    });
    assert.equal(acceptedFinalization.applied, true, database);
    assert.equal(acceptedFinalization.transmission.state, 'accepted', database);
    assert.equal(acceptedFinalization.nextTouch?.state, 'scheduled', database);
    const failedFinalization = rolledBackRpc('pursue_cim_finalize_transmission_v1', {
      ...reference.finalizeCommands[0], outcome: 'definitive-failure',
      providerResultCode: 'provider-rejected',
    });
    assert.equal(failedFinalization.applied, true, database);
    assert.equal(failedFinalization.transmission.state, 'definitive-failure', database);
    assert.equal(failedFinalization.nextTouch, null, database);
    const acceptedReconciliation = rolledBackRpc('pursue_cim_reconcile_transmission_v1', {
      ...reference.reconcileCommands[0], ...acceptedSlot, expectedRowVersion: 3,
      outcome: 'accepted', providerMessageId: 'reconciled-proof',
      evidenceId: 'direct-accepted-proof',
    });
    assert.equal(acceptedReconciliation.applied, true, database);
    assert.equal(acceptedReconciliation.transmission.state, 'accepted', database);
    const directPendingReconciliation = { ...reference.reconcileCommands[0],
      expectedRowVersion: 3, evidenceId: 'direct-provider-pending' };
    const directPayload = JSON.stringify(directPendingReconciliation).replaceAll("'", "''");
    const directPriorState = psql(container, database, `
      begin;
      set role service_role;
      select public.pursue_cim_reconcile_transmission_v1('${directPayload}'::jsonb);
      reset role;
      select prior_state from public.deal_hunter_cim_audit_events
        where event_type='transmission-reconciled' and source='operator-check'
          and metadata='{}'::jsonb;
      rollback;
    `).split('\n').at(-1);
    assert.equal(directPriorState, 'provider-pending',
      `${database}: direct provider-pending reconciliation audit must retain actual prior state`);
    assert.equal(reference.expectedFinalizations[0].applied, true);
    for (const [index, command] of reference.finalizeCommands.entries()) {
      if (index === 0) {
        rejectAuditTransition('transmission-finalized',
          'pursue_cim_finalize_transmission_v1', command);
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
    assert.equal(campaignTerminal.applied, true, database);
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

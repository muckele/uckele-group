import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
        'activeIndex', to_regclass('public.uq_deal_hunter_cim_campaigns_active_opportunity') is not null,
        'membershipIndex', to_regclass('public.uq_deal_hunter_cim_transmission_touches_active_touch') is not null
      );
    `));
    assert.deepEqual(catalog.tables, expectedTables);
    assert.equal(catalog.rls, true);
    assert.equal(catalog.anon, false);
    assert.equal(catalog.authenticated, false);
    assert.equal(catalog.service, true);
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

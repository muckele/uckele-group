import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { contactPolicyDigest } from '../server/services/pursueCimContactPolicy.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';
// The schema as it stood before the Gmail send runner work began.
const schemaBeforeGmail = '62a3b526820977ed6462ac6743f0af4b588a88e0';
const migrationPath = path.join(root, 'supabase/migrations/20261103120000_gmail_send_runners.sql');
const newTables = ['deal_hunter_gmail_connections', 'deal_hunter_pursue_send_controls'];
const at = '2026-11-03T15:00:00.000Z';
const later = '2026-11-03T16:00:00.000Z';
const ciphertext = 'v1.aXYtYnl0ZXM=.dGFnLWJ5dGVz.Y2lwaGVydGV4dA==';
const scopes = ['https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly'];

function hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function psql(container, database, sql) {
  return run(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', database], sql).trim();
}

function psqlFails(container, database, sql, pattern) {
  assert.throws(() => psql(container, database, sql), pattern);
}

function migrationFunctionNames(sql) {
  return [...new Set([...sql.matchAll(/create or replace function public\.([a-z0-9_]+)\(/g)]
    .map((match) => match[1]))].sort();
}

/** A Supabase client stand-in that runs the adapter's RPCs and reads as service_role. */
function serviceRoleClient(container, database) {
  const sql = (statement) => psql(container, database, `set role service_role; ${statement}`);
  const literal = (value) => `$json$${JSON.stringify(value)}$json$::jsonb`;
  return {
    async rpc(name, args) {
      try {
        const call = args === undefined ? `public.${name}()` : `public.${name}(${literal(args.p_command)})`;
        const output = sql(`select coalesce(to_jsonb(${call})::text, 'null');`);
        return { data: JSON.parse(output), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
    from(table) {
      const filters = [];
      const select = async (single) => {
        const where = filters.length ? `where ${filters.join(' and ')}` : '';
        const rows = JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text
          from public.${table} t ${where};`));
        if (!single) return { data: rows, error: null };
        if (rows.length > 1) return { data: null, error: new Error('multiple rows') };
        return { data: rows[0] ?? null, error: null };
      };
      const builder = {
        select() { return builder; },
        is(column, value) {
          assert.equal(value, null);
          filters.push(`t.${column} is null`);
          return builder;
        },
        maybeSingle() { return select(true); },
        then(resolve, reject) { return select(false).then(resolve, reject); },
      };
      return builder;
    },
  };
}

function seedConversation(container, database, suffix, { conversationState = 'open',
  campaignState = 'active-follow-up' } = {}) {
  const opportunityId = `opportunity-${suffix}`;
  psql(container, database, `
    insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('${opportunityId}', '${at}', '${at}', 'Fixture ${suffix}', 'cim-identity-v1');
    insert into public.deal_hunter_owner_decision_events
      (id, idempotency_key, request_digest, opportunity_id, action, actor, expected_discovery_revision,
        expected_material_revision, observed_discovery_revision, observed_material_revision,
        policy_version, created_at)
      values ('decision-${suffix}', 'idempotency-${suffix}', '${hex(`decision-${suffix}`)}', '${opportunityId}',
        'pursue', 'owner', 0, 0, 0, 0, 'owner-decision-v1', '${at}');
    insert into public.deal_hunter_pursuit_enrollments
      (id, decision_event_id, opportunity_id, state, authority_digest, created_at, updated_at)
      values ('enrollment-${suffix}', 'decision-${suffix}', '${opportunityId}', 'campaign-created',
        '${hex(`enrollment-${suffix}`)}', '${at}', '${at}');
    insert into public.deal_hunter_opportunity_timezone_revisions
      (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id, evidence_digest,
        resolver_version, dataset_digest, actor, created_at)
      values ('${opportunityId}', 1, 'verified', 'America/Los_Angeles', 'fixture', 'timezone-${suffix}',
        '${hex(`tz-${suffix}`)}', 'explicit-v1', '${hex('dataset')}', 'fixture', '${at}');
    insert into public.deal_hunter_broker_conversations
      (id, recipient_authority_id, recipient_fingerprint, recipient_address, sender_policy_version,
        reply_policy_version, reply_alias_token_digest, rfc_thread_key, state, batching_policy_version,
        created_at, updated_at)
      values ('conversation-${suffix}', 'recipient-${suffix}', '${hex(`recipient-${suffix}`)}',
        'broker-${suffix}@example.test', 'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1',
        '${hex(`alias-${suffix}`)}', 'thread-${suffix}', '${conversationState}', 'batching-off-v1',
        '${at}', '${at}');
    insert into public.deal_hunter_cim_campaigns
      (id, opportunity_id, generation, enrollment_id, decision_event_id, policy_version, template_version,
        template_digest, permission_version, permission_digest, permission_revision, permission_scope,
        canonical_revision, crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
        freshness_authority_digest, discovery_revision, material_revision, timezone_revision,
        conversation_id, state, reason_code, created_at, updated_at)
      values ('campaign-${suffix}', '${opportunityId}', 1, 'enrollment-${suffix}', 'decision-${suffix}',
        'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', '${hex('template')}',
        'permission-fixture', '${hex('permission')}', 1, 'cohort-fixture', 0, 0, 'recipient-${suffix}',
        '${hex(`recipient-${suffix}`)}', '${hex('freshness')}', 0, 0, 1, 'conversation-${suffix}',
        '${campaignState}', null, '${at}', '${at}');
  `);
}

test('the Gmail send runner migration is mirrored exactly at the end of the fresh schema', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const start = schema.indexOf(migration);
  assert.ok(start >= 0, 'canonical schema must contain the exact Gmail send runner block');
  const end = start + migration.length;
  const names = migrationFunctionNames(migration);
  assert.deepEqual(names, [
    'deal_hunter_gmail_list_open_conversations_v1',
    'deal_hunter_gmail_record_token_check_v1',
    'deal_hunter_gmail_revoke_connection_v1',
    'deal_hunter_gmail_save_connection_v1',
    'deal_hunter_gmail_set_conversation_thread_v1',
    'deal_hunter_gmail_update_checkpoint_v1',
    'deal_hunter_pursue_contact_rule_basis_v1',
    'deal_hunter_pursue_set_send_control_v1',
    'pursue_cim_finalize_transmission_p7a',
    'pursue_cim_materialize_campaign_v1',
    'pursue_cim_materialize_campaign_v2',
    'pursue_cim_reconcile_transmission_p7a',
    'pursue_cim_resolve_inbound_v1',
  ]);
  for (const name of names) {
    const last = schema.lastIndexOf(`create or replace function public.${name}(`);
    assert.ok(last > start && last < end, `no later fresh-schema block may redefine ${name}`);
  }
  // Every provider pin now accepts gmail, and no resend-only pin remains in the block.
  assert.equal([...migration.matchAll(/not in \('resend','gmail'\)/g)].length, 4);
  assert.doesNotMatch(migration, /<> 'resend'|is distinct from 'resend'/);
  for (const table of newTables) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.match(migration,
      new RegExp(`revoke all on table public\\.${table}\\s+from public, anon, authenticated, service_role;`));
    assert.match(migration, new RegExp(`grant select on table public\\.${table} to service_role;`));
  }
  assert.doesNotMatch(migration, /create\s+policy/i);
});

test('PostgreSQL Gmail connection, send controls, threads and gmail provider outcomes on fresh and upgraded schemas', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, async (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-gmail-send-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  t.after(() => {
    if (started) run(dockerCommand, ['rm', '-f', container]);
  });
  run(dockerCommand, ['run', '--rm', '--pull=never', '--network=none', '--tmpfs', '/var/lib/postgresql/data',
    '--name', container, '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16']);
  started = true;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = spawnSync(dockerCommand, ['logs', container], { encoding: 'utf8' });
    const readyEvents = `${logs.stdout}\n${logs.stderr}`.match(/database system is ready to accept connections/g)?.length || 0;
    const ready = spawnSync(dockerCommand, ['exec', container, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
    if (readyEvents >= 2 && ready.status === 0) break;
    if (attempt === 99) throw new Error('Disposable PostgreSQL did not become ready.');
    Atomics.wait(signal, 0, 0, 100);
  }
  psql(container, 'postgres', `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls; -- as in Supabase
    create database gmail_fresh;
    create database gmail_upgrade;
  `);
  const migration = fs.readFileSync(migrationPath, 'utf8');
  psql(container, 'gmail_fresh', fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  psql(container, 'gmail_upgrade', execFileSync('git', ['show', `${schemaBeforeGmail}:supabase/schema.sql`],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  psql(container, 'gmail_upgrade', migration);
  psql(container, 'gmail_upgrade', migration); // forward-only and re-runnable

  // The fresh schema and the upgrade define identical functions and table shapes.
  const functionNames = migrationFunctionNames(migration);
  const definitions = (database) => JSON.parse(psql(container, database, `
    select jsonb_object_agg(p.proname, jsonb_build_object('definition', pg_get_functiondef(p.oid),
      'acl', coalesce(p.proacl::text, '')))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[${functionNames.map((name) => `'${name}'`).join(',')}]);`));
  const freshDefinitions = definitions('gmail_fresh');
  assert.deepEqual(Object.keys(freshDefinitions).sort(), functionNames);
  assert.deepEqual(definitions('gmail_upgrade'), freshDefinitions);
  const columns = (database) => psql(container, database, `
    select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable, ','
      order by table_name, column_name)
    from information_schema.columns where table_schema = 'public'
      and (table_name = any(array['deal_hunter_gmail_connections', 'deal_hunter_pursue_send_controls'])
        or (table_name = 'deal_hunter_broker_conversations' and column_name = 'gmail_thread_id'));`);
  assert.equal(columns('gmail_upgrade'), columns('gmail_fresh'));
  const constraints = (database) => psql(container, database, `
    select string_agg(conrelid::regclass || ':' || pg_get_constraintdef(oid), E'\\n' order by conrelid::regclass::text,
      pg_get_constraintdef(oid))
    from pg_constraint where conrelid = any(array['public.deal_hunter_gmail_connections'::regclass,
      'public.deal_hunter_pursue_send_controls'::regclass]);`);
  assert.equal(constraints('gmail_upgrade'), constraints('gmail_fresh'));

  for (const database of ['gmail_fresh', 'gmail_upgrade']) {
    // Service-role only: RLS on, anon/authenticated cannot read, service_role writes only through RPCs.
    for (const table of newTables) {
      assert.equal(psql(container, database, `select relrowsecurity from pg_class
        where oid = 'public.${table}'::regclass;`), 't', `${database} ${table} RLS`);
      for (const role of ['anon', 'authenticated']) {
        psqlFails(container, database, `set role ${role}; select * from public.${table};`, /permission denied/);
      }
      psqlFails(container, database, `set role service_role; delete from public.${table};`, /permission denied/);
    }
    for (const name of functionNames) {
      assert.equal(psql(container, database, `select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = '${name}';`), 'f', `${database} ${name} grants`);
    }

    const storage = createSupabaseStorage({ storage: {} }, { client: serviceRoleClient(container, database) });

    // gmail connection save replaces the prior active row
    assert.equal(await storage.getGmailConnection(), null);
    const connection = (overrides = {}) => ({ emailAddress: 'owner@uckele.test',
      refreshTokenCiphertext: ciphertext, grantedScopes: scopes, historyCheckpoint: '1000',
      connectedBy: 'owner', now: at, ...overrides });
    const first = await storage.saveGmailConnection(connection());
    assert.equal(first.email_address, 'owner@uckele.test');
    assert.equal(first.refresh_token_ciphertext, ciphertext);
    assert.deepEqual(first.granted_scopes, scopes);
    assert.equal(first.history_checkpoint, '1000');
    assert.equal(first.connected_at, at);
    assert.equal(first.revoked_at, null);
    const second = await storage.saveGmailConnection(connection({ historyCheckpoint: '2000',
      connectedBy: 'owner-again', now: later }));
    assert.notEqual(second.id, first.id);
    assert.deepEqual(await storage.getGmailConnection(), second);
    assert.equal(psql(container, database, `select string_agg(id || ':' || coalesce(revoked_by, '-'), ','
      order by connected_at) from public.deal_hunter_gmail_connections;`),
    `${first.id}:owner-again,${second.id}:-`);
    // The RPC itself refuses a plaintext token and a second active row.
    psqlFails(container, database, `set role service_role; select public.deal_hunter_gmail_save_connection_v1(
      '${JSON.stringify({ ...connection(), id: 'plain', refreshTokenCiphertext: '1//plain-token' })}'::jsonb);`,
    /Invalid Gmail connection/);
    psqlFails(container, database, `insert into public.deal_hunter_gmail_connections
      (id, email_address, refresh_token_ciphertext, connected_at, connected_by)
      values ('second-active', 'owner@uckele.test', '${ciphertext}', now(), 'owner');`,
    /uq_deal_hunter_gmail_connections_active/);

    // checkpoint compare-and-set rejects a stale expected value
    assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: '1999', next: '2500', now: later }), false);
    assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: '2000', next: '2500', now: later }), true);
    assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: '2000', next: '2600', now: later }), false);
    assert.equal((await storage.getGmailConnection()).history_checkpoint, '2500');

    // revoke clears the active connection
    const okCheck = await storage.recordGmailTokenCheck({ ok: true, now: later });
    assert.equal(okCheck.last_token_ok_at, later);
    const failedCheck = await storage.recordGmailTokenCheck({ ok: false, errorCode: 'gmail_token_invalid',
      now: '2026-11-03T17:00:00.000Z' });
    assert.equal(failedCheck.last_token_ok_at, later);
    assert.equal(failedCheck.last_error_code, 'gmail_token_invalid');
    const revoked = await storage.revokeGmailConnection({ revokedBy: 'owner', now: later });
    assert.equal(revoked.id, second.id);
    assert.equal(revoked.revoked_at, later);
    assert.equal(await storage.getGmailConnection(), null);
    assert.equal(await storage.revokeGmailConnection({ revokedBy: 'owner', now: later }), null);
    assert.equal(await storage.recordGmailTokenCheck({ ok: true, now: later }), null);
    assert.equal(await storage.updateGmailHistoryCheckpoint({ expected: '2500', next: '2700', now: later }), false);

    // send control set is revisioned, audited, and rejects a stale revision with send_control_conflict
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
    await storage.setPursueSendControl({ controlKey: 'contact_rule', enabled: true, valueDigest: hex('policy'),
      policyVersion: 'listing-broker-inquiry-v1', expectedRevision: 0, actor: 'owner',
      reason: 'standing rule', now: at });
    const ruleOff = await storage.setPursueSendControl({ controlKey: 'contact_rule', enabled: false,
      valueDigest: null, policyVersion: 'listing-broker-inquiry-v1', expectedRevision: 1, actor: 'owner',
      reason: 'pause', now: later });
    assert.equal(ruleOff.revision, 2);
    await assert.rejects(storage.setPursueSendControl({ controlKey: 'contact_rule', enabled: true,
      policyVersion: 'listing-broker-inquiry-v1', expectedRevision: 1, actor: 'owner', reason: 'stale',
      now: later }), (error) => error.code === 'send_control_conflict');
    await assert.rejects(storage.setPursueSendControl({ controlKey: 'live_sending', enabled: true,
      expectedRevision: 3, actor: 'owner', reason: 'stale first write', now: later }),
    (error) => error.code === 'send_control_conflict');
    psqlFails(container, database, `set role service_role; select public.deal_hunter_pursue_set_send_control_v1(
      '${JSON.stringify({ controlKey: 'wording_approval', enabled: true, valueDigest: null, policyVersion: null,
    expectedRevision: 1, actor: 'owner', reason: '', now: later })}'::jsonb);`,
    /deal_hunter_pursue_send_controls_wording_digest/);
    const controls = await storage.getPursueSendControls();
    assert.deepEqual(controls, { liveSending: off, contactRule: ruleOff, wordingApproval: approved });
    const audit = JSON.parse(psql(container, database, `select jsonb_agg(jsonb_build_object('id', id,
        'prior', prior_state, 'next', next_state, 'reason', reason_code, 'digest', authority_digest,
        'source', source, 'metadata', metadata) order by occurred_at, id)
      from public.deal_hunter_cim_audit_events where event_type = 'send-control-changed';`));
    assert.deepEqual(audit, [
      { id: 'send-control:contact_rule:1', prior: 'off', next: 'on', reason: 'contact_rule',
        digest: hex('policy'), source: 'pursue-send-controls',
        metadata: { controlKey: 'contact_rule', revision: 1, policyVersion: 'listing-broker-inquiry-v1',
          valueDigest: hex('policy'), reason: 'standing rule' } },
      { id: 'send-control:wording_approval:1', prior: 'off', next: 'on', reason: 'wording_approval',
        digest: wordingDigest, source: 'pursue-send-controls',
        metadata: { controlKey: 'wording_approval', revision: 1, policyVersion: 'pursue-cim-initial-v1',
          valueDigest: wordingDigest, reason: 'approved copy' } },
      { id: 'send-control:contact_rule:2', prior: 'on', next: 'off', reason: 'contact_rule', digest: null,
        source: 'pursue-send-controls',
        metadata: { controlKey: 'contact_rule', revision: 2, policyVersion: 'listing-broker-inquiry-v1',
          valueDigest: null, reason: 'pause' } },
    ]);

    // The standing contact rule is a campaign permission basis only while it is on under the
    // same policy version, with that version's digest as the service computes it. The control
    // revision is not compared: off pauses rule-based campaigns and on again resumes them.
    const ruleBasis = (overrides = {}) => psql(container, database, `set role service_role;
      select public.deal_hunter_pursue_contact_rule_basis_v1($json$${JSON.stringify({
    permissionVersion: 'listing-broker-inquiry-v1', permissionRevision: 1,
    permissionDigest: contactPolicyDigest(), policyHash: contactPolicyDigest(),
    ...overrides })}$json$::jsonb);`);
    let ruleRevision = 2;
    const setRule = async (enabled, policyVersion = 'listing-broker-inquiry-v1') => {
      const control = await storage.setPursueSendControl({ controlKey: 'contact_rule', enabled,
        policyVersion, expectedRevision: ruleRevision, actor: 'owner', reason: 'rule basis', now: later });
      ruleRevision = control.revision;
    };
    assert.equal(ruleBasis(), 'f', `${database} rule off`);
    await setRule(true);
    assert.equal(ruleRevision, 3);
    assert.equal(ruleBasis(), 't', `${database} rule on`);
    assert.equal(ruleBasis({ permissionRevision: 3 }), 't', `${database} any recorded revision`);
    assert.equal(ruleBasis({ permissionDigest: hex('other') }), 'f', `${database} digest`);
    assert.equal(ruleBasis({ policyHash: hex('other') }), 'f', `${database} policy hash`);
    assert.equal(ruleBasis({ permissionVersion: 'activation-enrollment' }), 'f',
      `${database} activation basis`);
    await setRule(false);
    assert.equal(ruleBasis(), 'f', `${database} rule off pauses`);
    await setRule(true);
    assert.equal(ruleBasis(), 't', `${database} rule on again resumes`);
    await setRule(true, null);
    assert.equal(ruleBasis(), 'f', `${database} rule on without a policy version`);
    await setRule(true, 'listing-broker-inquiry-v2');
    assert.equal(ruleBasis(), 'f', `${database} rule on under another policy version`);
    await setRule(false);
    assert.equal(ruleBasis(), 'f', `${database} rule off again`);

    // provider outcome accepts gmail and still rejects unknown providers
    const finalize = (provider) => `select public.pursue_cim_finalize_transmission_v1('${JSON.stringify({
      transmissionId: 'missing-transmission', payloadDigest: hex('payload'), expectedRowVersion: 1,
      outcome: 'accepted', provider, providerMessageId: '18c2f0a1b2c3d4e5', providerResultCode: 'accepted',
      actor: 'pursue-cim-sender', now: at })}'::jsonb)->>'conflict';`;
    const reconcile = (provider, identityProvider = provider) => `select
      public.pursue_cim_reconcile_transmission_v1('${JSON.stringify({
    transmissionId: 'missing-transmission', payloadDigest: hex('payload'), expectedRowVersion: 1,
    outcome: 'ambiguous', provider, providerResultCode: 'multiple-sent', evidenceType: 'gmail-find-sent',
    evidenceId: 'evidence-1', evidenceDigest: hex('evidence'), actor: 'pursue-cim-sender', now: at,
    providerIdentities: ['18c2f0a1b2c3d4e5', '18c2f0a1b2c3d4e6'].map((providerMessageId, index) => ({
      provider: identityProvider, providerMessageId, evidenceId: `evidence-${index}`,
      evidenceDigest: hex(`evidence-${index}`) })) })}'::jsonb)->>'conflict';`;
    const resolve = (provider) => `select public.pursue_cim_resolve_inbound_v1('${JSON.stringify({
      replyToAddresses: [], provider, providerMessageIds: [], rfcMessageIds: [],
      taggedConversationId: '', taggedTransmissionId: '', taggedTouchIds: [] })}'::jsonb)->>'exact';`;
    for (const provider of ['resend', 'gmail']) {
      assert.equal(psql(container, database, finalize(provider)), 'true', `${database} ${provider} finalize`);
      assert.equal(psql(container, database, reconcile(provider)), 'true', `${database} ${provider} reconcile`);
      assert.equal(psql(container, database, resolve(provider)), 'false', `${database} ${provider} resolve`);
    }
    for (const provider of ['sendgrid', 'Gmail', undefined]) {
      psqlFails(container, database, finalize(provider), /Invalid Pursue CIM finalization command|Invalid Pursue CIM text input/);
      psqlFails(container, database, reconcile(provider), /Invalid Pursue CIM reconciliation command|Invalid Pursue CIM text input/);
      psqlFails(container, database, resolve(provider), /Invalid Pursue CIM inbound evidence/);
    }
    psqlFails(container, database, reconcile('gmail', 'sendgrid'), /Invalid provider identity conflict evidence/);
    psqlFails(container, database, reconcile('gmail', null), /Invalid provider identity conflict evidence/);

    // open gmail conversations list excludes terminal conversations
    seedConversation(container, database, 'open');
    seedConversation(container, database, 'ambiguous', { conversationState: 'provider-ambiguous',
      campaignState: 'provider-ambiguous' });
    seedConversation(container, database, 'no-thread');
    seedConversation(container, database, 'responded', { conversationState: 'responded', campaignState: 'responded' });
    seedConversation(container, database, 'stopped', { conversationState: 'stopped', campaignState: 'stopped' });
    seedConversation(container, database, 'closed', { conversationState: 'closed', campaignState: 'expired' });
    for (const suffix of ['open', 'ambiguous', 'responded', 'stopped', 'closed']) {
      assert.deepEqual(await storage.setCimConversationGmailThread({ conversationId: `conversation-${suffix}`,
        gmailThreadId: `thread${suffix}`, now: later }), { applied: true, replay: false, conflict: false });
    }
    assert.deepEqual(await storage.setCimConversationGmailThread({ conversationId: 'conversation-open',
      gmailThreadId: 'threadopen', now: later }), { applied: false, replay: true, conflict: false });
    assert.deepEqual(await storage.setCimConversationGmailThread({ conversationId: 'conversation-open',
      gmailThreadId: 'threadother', now: later }), { applied: false, replay: false, conflict: true });
    await assert.rejects(storage.setCimConversationGmailThread({ conversationId: 'conversation-missing',
      gmailThreadId: 'threadx', now: later }), /Unknown Pursue CIM conversation/);
    assert.equal(psql(container, database, `select gmail_thread_id || '|' || row_version || '|'
      || (updated_at = '${later}'::timestamptz) from public.deal_hunter_broker_conversations
      where id = 'conversation-open';`), 'threadopen|1|true');
    assert.deepEqual(await storage.listOpenGmailConversations(), [
      { conversationId: 'conversation-ambiguous', gmailThreadId: 'threadambiguous',
        campaignId: 'campaign-ambiguous', recipientFingerprint: hex('recipient-ambiguous') },
      { conversationId: 'conversation-open', gmailThreadId: 'threadopen',
        campaignId: 'campaign-open', recipientFingerprint: hex('recipient-open') },
    ]);
  }
});

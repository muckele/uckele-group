import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';
// The schema as it stood before queue rows carried campaign state.
const schemaBeforeCampaignState = 'd83f1021f90e9dfe3672b9c9fb11316543dc2ce5';
const at = '2026-11-03T15:00:00.000Z';
const hex = (value) => createHash('sha256').update(value).digest('hex');

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function psql(container, database, sql) {
  return run(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], sql).trim();
}

function seedListing(container, database, id) {
  psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('${id}', '${at}', '${at}', 'Listing ${id}', 'test');
    insert into public.deal_hunter_opportunity_scores
      (opportunity_id, scored_at, deal_key, name, fit_score, confidence, score_fingerprint,
        engine_version, rules_version, profile_version, completeness_policy_version,
        current_triage_eligible, should_remove, criteria_group, criteria_profile_version)
      values ('${id}', '${at}', '${id}', 'Listing ${id}', 90, 'high', 'fp-${id}', 'test', 'test',
        'test', 'test', true, false, 'review', 'uckele-criteria-v1');`);
}

function seedCampaign(container, database, id, { generation, state, reasonCode, localExpiryAt = null }) {
  const suffix = `${id}-${generation}`;
  psql(container, database, `
    insert into public.deal_hunter_owner_decision_events
      (id, idempotency_key, request_digest, opportunity_id, action, actor, expected_discovery_revision,
        expected_material_revision, observed_discovery_revision, observed_material_revision,
        policy_version, created_at)
      values ('decision-${suffix}', 'idempotency-${suffix}', '${hex(`decision-${suffix}`)}', '${id}',
        'pursue', 'owner', 0, 0, 0, 0, 'owner-decision-v1', '${at}');
    insert into public.deal_hunter_pursuit_enrollments
      (id, decision_event_id, opportunity_id, state, authority_digest, created_at, updated_at)
      values ('enrollment-${suffix}', 'decision-${suffix}', '${id}', 'superseded',
        '${hex(`enrollment-${suffix}`)}', '${at}', '${at}');
    insert into public.deal_hunter_opportunity_timezone_revisions
      (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id, evidence_digest,
        resolver_version, dataset_digest, actor, created_at)
      values ('${id}', ${generation}, 'verified', 'America/Los_Angeles', 'fixture', 'timezone-${suffix}',
        '${hex(`tz-${suffix}`)}', 'explicit-v1', '${hex('dataset')}', 'fixture', '${at}');
    insert into public.deal_hunter_broker_conversations
      (id, recipient_authority_id, recipient_fingerprint, recipient_address, sender_policy_version,
        reply_policy_version, reply_alias_token_digest, rfc_thread_key, state, batching_policy_version,
        created_at, updated_at)
      values ('conversation-${suffix}', 'recipient-${suffix}', '${hex(`recipient-${suffix}`)}',
        'broker-${suffix}@example.test', 'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1',
        '${hex(`alias-${suffix}`)}', 'thread-${suffix}', 'open', 'batching-off-v1', '${at}', '${at}');
    insert into public.deal_hunter_cim_campaigns
      (id, opportunity_id, generation, enrollment_id, decision_event_id, policy_version, template_version,
        template_digest, permission_version, permission_digest, permission_revision, permission_scope,
        canonical_revision, crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
        freshness_authority_digest, discovery_revision, material_revision, timezone_revision,
        conversation_id, state, reason_code, local_expiry_at, created_at, updated_at)
      values ('campaign-${suffix}', '${id}', ${generation}, 'enrollment-${suffix}', 'decision-${suffix}',
        'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', '${hex('template')}',
        'permission-fixture', '${hex('permission')}', 1, 'cohort-fixture', 0, 0, 'recipient-${suffix}',
        '${hex(`recipient-${suffix}`)}', '${hex('freshness')}', 0, 0, ${generation}, 'conversation-${suffix}',
        '${state}', ${reasonCode ? `'${reasonCode}'` : 'null'},
        ${localExpiryAt ? `'${localExpiryAt}'` : 'null'}, '${at}', '${at}');`);
}

test('PostgreSQL queue rows carry the latest campaign on fresh and upgraded schemas', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, async (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-queue-campaign-${process.pid}-${randomUUID().slice(0, 8)}`;
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
    create role service_role nologin;
    create database queue_fresh;
    create database queue_upgrade;
  `);
  const migration = fs.readFileSync(path.join(root,
    'supabase/migrations/20261115120000_queue_campaign_state.sql'), 'utf8');
  psql(container, 'queue_fresh', fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  psql(container, 'queue_upgrade', execFileSync('git', ['show', `${schemaBeforeCampaignState}:supabase/schema.sql`],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  psql(container, 'queue_upgrade', migration);
  psql(container, 'queue_upgrade', migration); // forward-only and re-runnable

  for (const database of ['queue_fresh', 'queue_upgrade']) {
    const id = (name) => `${name}-${database}`;
    for (const name of ['none', 'stopped', 'restarted', 'lapsed']) seedListing(container, database, id(name));
    seedCampaign(container, database, id('stopped'), { generation: 1, state: 'stopped', reasonCode: 'campaign_stopped' });
    // The latest generation wins over an earlier one.
    seedCampaign(container, database, id('restarted'), { generation: 1, state: 'stopped', reasonCode: 'campaign_stopped' });
    seedCampaign(container, database, id('restarted'), { generation: 2, state: 'initial-pending', reasonCode: 'awaiting-window' });
    seedCampaign(container, database, id('lapsed'), { generation: 1, state: 'active-follow-up',
      reasonCode: 'awaiting-window', localExpiryAt: '2026-11-01T00:00:00.000Z' });

    const inbox = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('all-active', 0, 100);")).areas[0];
    const scores = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_opportunity_scores('all', 1, 100, '', 'fit-score', 'desc', null, '', '', '');"));
    for (const rows of [inbox.rows, scores.rows]) {
      const row = (name) => rows.find((item) => item.opportunity_id === id(name));
      assert.equal('campaign_state' in row('none'), false, `${database}: no campaign, no fields`);
      assert.equal(row('stopped').campaign_state, 'stopped');
      assert.equal(row('stopped').campaign_reason_code, 'campaign_stopped');
      assert.equal(row('restarted').campaign_state, 'initial-pending');
      assert.equal(row('lapsed').campaign_state, 'active-follow-up');
      assert.ok(Date.parse(row('lapsed').campaign_local_expiry_at) < Date.parse(at),
        'the expiry reaches the server, which projects it');
    }

    // Campaign state is display only: it does not move the area revision older cursors bind to.
    const revision = inbox.revision;
    psql(container, database, `update public.deal_hunter_cim_campaigns set state = 'expired'
      where opportunity_id = '${id('lapsed')}';`);
    assert.equal(JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('all-active', 0, 100);")).areas[0].revision, revision);

    // The helper is callable only by the server role.
    assert.equal(psql(container, database, `select
      has_function_privilege('anon', 'public.deal_hunter_latest_campaign_fields_v1(text)', 'EXECUTE'),
      has_function_privilege('authenticated', 'public.deal_hunter_latest_campaign_fields_v1(text)', 'EXECUTE'),
      has_function_privilege('service_role', 'public.deal_hunter_latest_campaign_fields_v1(text)', 'EXECUTE');`),
    'f|f|t');
  }
});

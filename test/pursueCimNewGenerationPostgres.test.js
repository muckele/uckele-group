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
// The schema before queue campaign state and Start a new campaign.
const schemaBefore = 'd83f1021f90e9dfe3672b9c9fb11316543dc2ce5';
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

function seedTouch(container, database, id, generation, state) {
  psql(container, database, `insert into public.deal_hunter_cim_campaign_touches
      (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at, due_local,
        timezone_revision, state, created_at, updated_at)
      values ('touch-${id}-${generation}', 'campaign-${id}-${generation}', '${id}', 'initial', 'initial', 0,
        '${at}', '2026-11-03T08:00:00-08:00', ${generation}, '${state}', '${at}', '${at}');`);
}

const start = (container, database, id, extra = {}) => JSON.parse(psql(container, database,
  `select public.deal_hunter_pursue_start_new_campaign_v1('${JSON.stringify({ opportunityId: id,
    campaignId: `campaign-${id}-1`, expectedRowVersion: 1, idempotencyKey: randomUUID(),
    actor: 'fixture-owner', policyVersion: 'owner-decision-v1', now: '2026-11-04T15:00:00.000Z',
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0, ...extra })}'::jsonb);`));
const maySend = (container, database, campaignId) => psql(container, database,
  `select public.deal_hunter_pursue_generation_may_send_v1('${campaignId}');`);

test('PostgreSQL Start a new campaign and the generation rule on fresh and upgraded schemas', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, async (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-new-generation-${process.pid}-${randomUUID().slice(0, 8)}`;
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
    create database generation_fresh;
    create database generation_upgrade;
  `);
  const migrations = ['20261115120000_queue_campaign_state.sql', '20261115130000_pursue_cim_new_generation.sql']
    .map((name) => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8'));
  psql(container, 'generation_fresh', fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  psql(container, 'generation_upgrade', execFileSync('git', ['show', `${schemaBefore}:supabase/schema.sql`],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  for (const migration of [...migrations, ...migrations]) psql(container, 'generation_upgrade', migration);

  for (const database of ['generation_fresh', 'generation_upgrade']) {
    const id = (name) => `${name}-${database}`;
    for (const name of ['restart', 'emailed', 'system', 'running']) {
      seedListing(container, database, id(name));
      seedCampaign(container, database, id(name), { generation: 1,
        state: name === 'running' ? 'initial-pending' : 'stopped',
        reasonCode: name === 'system' ? 'recipient_suppressed' : name === 'running' ? 'awaiting-window' : 'campaign_stopped' });
      seedTouch(container, database, id(name), 1, name === 'emailed' ? 'accepted' : name === 'running' ? 'scheduled'
        : 'cancelled-before-provider');
    }

    assert.equal(start(container, database, id('emailed')).reason, 'campaign_emailed');
    assert.equal(start(container, database, id('system')).reason, 'campaign_not_restartable');
    assert.equal(start(container, database, id('running')).reason, 'campaign_not_restartable');
    assert.equal(start(container, database, id('restart'), { expectedRowVersion: 2 }).reason, 'campaign_changed');

    const key = randomUUID();
    const restarted = start(container, database, id('restart'), { idempotencyKey: key });
    assert.equal(restarted.applied, true, JSON.stringify(restarted));
    assert.equal(restarted.enrollment.state, 'queued');
    assert.equal(restarted.enrollment.restart_of_campaign_id, `campaign-${id('restart')}-1`);
    assert.equal(restarted.decision.action, 'pursue');
    assert.equal(start(container, database, id('restart'), { idempotencyKey: key }).replay, true);
    assert.equal(psql(container, database, `select count(*) from public.deal_hunter_pursuit_enrollments
      where opportunity_id = '${id('restart')}' and state <> 'superseded';`), '1');

    // The send path: generation 2 may carry email only while generation 1 never reached Google.
    seedCampaign(container, database, id('restart'), { generation: 2, state: 'initial-pending',
      reasonCode: 'awaiting-window' });
    assert.equal(maySend(container, database, `campaign-${id('restart')}-1`), 't');
    assert.equal(maySend(container, database, `campaign-${id('restart')}-2`), 't');
    psql(container, database, `update public.deal_hunter_cim_campaign_touches set state = 'accepted'
      where id = 'touch-${id('restart')}-1';`);
    assert.equal(maySend(container, database, `campaign-${id('restart')}-2`), 'f');
    assert.equal(maySend(container, database, 'campaign-missing'), 'f');

    // Only the server role reaches the command; the rule helpers are internal.
    assert.equal(psql(container, database, `select
      has_function_privilege('anon', 'public.deal_hunter_pursue_start_new_campaign_v1(jsonb)', 'EXECUTE'),
      has_function_privilege('service_role', 'public.deal_hunter_pursue_start_new_campaign_v1(jsonb)', 'EXECUTE'),
      has_function_privilege('service_role', 'public.deal_hunter_pursue_generation_may_send_v1(text)', 'EXECUTE');`),
    'f|t|f');
  }
});

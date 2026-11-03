import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';
// The schema as it stood before the best-first deal list work began.
const schemaBeforeBestFirst = 'dcaa79276bc6474278be0c0c7f8ae8fc7860996a';

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

test('PostgreSQL automatic Pursue activation, runs, and blocker writer on fresh and upgraded schemas', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, async (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-auto-pursue-${process.pid}-${randomUUID().slice(0, 8)}`;
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
    create database pursue_fresh;
    create database pursue_upgrade;
    create database pursue_guard_refuses;
  `);
  const currentSchema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const previousSchema = execFileSync('git', ['show', `${schemaBeforeBestFirst}:supabase/schema.sql`],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const migration = fs.readFileSync(path.join(root,
    'supabase/migrations/20261102120000_best_first_deal_list.sql'), 'utf8');
  psql(container, 'pursue_fresh', currentSchema);
  psql(container, 'pursue_upgrade', previousSchema);
  psql(container, 'pursue_upgrade', migration);
  psql(container, 'pursue_upgrade', migration); // forward-only and re-runnable
  const guardMigration = fs.readFileSync(path.join(root,
    'supabase/migrations/20261102130000_mvp_send_readiness_guards.sql'), 'utf8');
  psql(container, 'pursue_upgrade', guardMigration);
  psql(container, 'pursue_upgrade', guardMigration); // re-runnable too

  // The guard migration refuses to run over a row that already violates the policy guard.
  psql(container, 'pursue_guard_refuses', previousSchema);
  psql(container, 'pursue_guard_refuses', migration);
  psql(container, 'pursue_guard_refuses', `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('guard-bad', now(), now(), 'Guard bad', 'test');
    insert into public.deal_hunter_owner_decision_events
      (id, idempotency_key, request_digest, opportunity_id, action, actor, expected_discovery_revision,
        expected_material_revision, observed_discovery_revision, observed_material_revision,
        policy_version, created_at)
      values ('guard-bad', 'guard-bad', repeat('a', 64), 'guard-bad', 'pursue', 'owner', 0, 0, 0, 0,
        'auto-pursue-v1', now());`);
  psqlFails(container, 'pursue_guard_refuses', guardMigration,
    /owner_decision_events has rows violating policy guard/);

  for (const database of ['pursue_fresh', 'pursue_upgrade']) {
    const activation = (id, mode, cap, confirmation) => `select public.create_deal_hunter_auto_pursue_activation_v1(
      jsonb_build_object('id', '${id}', 'mode', '${mode}', 'daily_cap', ${cap}, 'actor', 'owner',
        'reason', 'test', 'confirmation', '${confirmation}', 'created_at', now()::text));`;
    // Grants: service_role reads activations and calls the RPC; it cannot write the table directly.
    psql(container, database, `set role service_role; ${activation('a1', 'shadow', 0, 'ACTIVATE AUTO PURSUE SHADOW')}`);
    psqlFails(container, database, `set role service_role; insert into public.deal_hunter_auto_pursue_activations
      (id, mode, daily_cap, actor, confirmation, status, created_at)
      values ('x', 'active', 10, 'owner', 'ACTIVATE AUTO PURSUE ACTIVE', 'current', now());`, /permission denied/);
    psqlFails(container, database, `set role anon; ${activation('a-anon', 'off', 0, 'SET AUTO PURSUE OFF')}`,
      /permission denied/);
    psqlFails(container, database, 'set role anon; select * from public.deal_hunter_auto_pursue_runs;', /permission denied/);
    psql(container, database, `set role service_role; ${activation('a2', 'canary', 1, 'ACTIVATE AUTO PURSUE CANARY')}`);
    const activations = JSON.parse(psql(container, database, `set role service_role;
      select json_agg(json_build_object('id', id, 'status', status, 'superseded', superseded_at is not null)
        order by id) from public.deal_hunter_auto_pursue_activations;`));
    assert.deepEqual(activations, [
      { id: 'a1', status: 'superseded', superseded: true },
      { id: 'a2', status: 'current', superseded: false },
    ]);
    // Wrong confirmation, a canary cap other than 1, and an active cap over 10 are refused.
    psqlFails(container, database, activation('a3', 'canary', 1, 'ACTIVATE AUTO PURSUE ACTIVE'), /confirmation/);
    psqlFails(container, database, activation('a4', 'canary', 3, 'ACTIVATE AUTO PURSUE CANARY'), /mode_cap|check/);
    psqlFails(container, database, activation('a5', 'active', 11, 'ACTIVATE AUTO PURSUE ACTIVE'), /check/);
    assert.equal(psql(container, database, `select count(*) from public.deal_hunter_auto_pursue_activations
      where status = 'current';`), '1');
    assert.equal(psql(container, database, `select id from public.deal_hunter_auto_pursue_activations
      where status = 'current';`), 'a2');

    // Runs: a run key can be claimed once.
    const claim = (id) => `set role service_role; insert into public.deal_hunter_auto_pursue_runs
      (id, run_key, business_date, mode, status, triggered_by, commands, items, created_at)
      values ('${id}', 'auto-pursue:2026-11-02:canary:0', '2026-11-02', 'canary', 'running', 'cron', 0,
        '[]'::jsonb, now());`;
    psql(container, database, claim('r1'));
    psqlFails(container, database, claim('r2'), /duplicate key/);
    psql(container, database, `set role service_role; update public.deal_hunter_auto_pursue_runs
      set status = 'completed', commands = 1, items = '[{"opportunityId":"o1","outcome":"pursued"}]'::jsonb,
        completed_at = now() where id = 'r1' and completed_at is null;`);
    assert.equal(psql(container, database, `select commands || ':' || status from public.deal_hunter_auto_pursue_runs
      where id = 'r1';`), '1:completed');

    // Blocker writer: only changed rows are updated; malformed codes are refused.
    for (const id of ['blk-a', 'blk-b']) {
      psql(container, database, `insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version)
        values ('${id}', now(), now(), 'Blocker ${id}', 'test');
        insert into public.deal_hunter_opportunity_scores
        (opportunity_id, scored_at, deal_key, name, fit_score, confidence, score_fingerprint, engine_version,
          rules_version, profile_version, completeness_policy_version, current_triage_eligible, should_remove,
          criteria_group, criteria_profile_version)
        values ('${id}', now(), '${id}', 'Blocker ${id}', 95, 'high', 'fp-${id}', 'test', 'test', 'test', 'test',
          true, false, 'auto', 'uckele-criteria-v1');`);
    }
    const setBlockers = (entries) => psql(container, database, `set role service_role;
      select public.set_deal_hunter_auto_pursue_blockers_v1('${JSON.stringify(entries)}'::jsonb);`);
    const checkedAt = '2026-11-02T18:00:00.000Z';
    assert.equal(setBlockers([{ opportunity_id: 'blk-a', blocker: 'generic_mailbox', checked_at: checkedAt },
      { opportunity_id: 'blk-b', blocker: null, checked_at: checkedAt }]), '1');
    assert.equal(setBlockers([{ opportunity_id: 'blk-a', blocker: 'generic_mailbox', checked_at: '2026-11-03T00:00:00Z' }]), '0');
    assert.equal(psql(container, database, `select auto_pursue_blocker || '|' || auto_pursue_checked_at
      from public.deal_hunter_opportunity_scores where opportunity_id = 'blk-a';`), `generic_mailbox|${checkedAt}`);
    assert.equal(psql(container, database, `select coalesce(auto_pursue_blocker, 'null')
      from public.deal_hunter_opportunity_scores where opportunity_id = 'blk-b';`), 'null');
    assert.equal(setBlockers([{ opportunity_id: 'blk-a', blocker: null, checked_at: checkedAt }]), '1');
    assert.equal(psql(container, database, `select coalesce(auto_pursue_blocker, 'null')
      from public.deal_hunter_opportunity_scores where opportunity_id = 'blk-a';`), 'null');
    assert.throws(() => setBlockers([{ opportunity_id: 'blk-a', blocker: 'Bad Code', checked_at: checkedAt }]),
      /Invalid automatic Pursue blocker entries/);
    psqlFails(container, database, `set role anon;
      select public.set_deal_hunter_auto_pursue_blockers_v1('[]'::jsonb);`, /permission denied/);

    // Decision-event guards: only the two known policies, and an automatic event must be an
    // automatic Pursue by the automation actor.
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('guard-opp', now(), now(), 'Guard opp', 'test');`);
    const insertEvent = (id, policy, actor, action) => `insert into public.deal_hunter_owner_decision_events
      (id, idempotency_key, request_digest, opportunity_id, action, actor, expected_discovery_revision,
        expected_material_revision, observed_discovery_revision, observed_material_revision,
        policy_version, created_at)
      values ('${id}', '${id}', repeat('a', 64), 'guard-opp', '${action}', '${actor}', 0, 0, 0, 0,
        '${policy}', now());`;
    // rejects auto-pursue-v1 decision event with a non-automation actor
    psqlFails(container, database, insertEvent('guard-actor', 'auto-pursue-v1', 'owner', 'pursue'),
      /auto_pursue_actor_check/);
    psqlFails(container, database, insertEvent('guard-action', 'auto-pursue-v1', 'automation-auto-pursue', 'watch'),
      /auto_pursue_actor_check/);
    psqlFails(container, database, insertEvent('guard-policy', 'owner-v1', 'owner', 'pursue'),
      /policy_version_check/);
    // (A valid automatic event is covered by the locked writer below; adding one here would use the cap.)
    psql(container, database, insertEvent('guard-ok-owner', 'owner-decision-v1', 'owner', 'watch'));
    assert.equal(psql(container, database, `select count(*) from pg_indexes
      where indexname = 'idx_deal_hunter_owner_decision_events_opportunity_created';`), '1');

    // Locked automatic writer: owner decisions win, the cap and business day hold, replays pass.
    for (const id of ['lock-watch', 'lock-a', 'lock-b', 'lock-date']) {
      psql(container, database, `insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version)
        values ('${id}', now(), now(), 'Lock ${id}', 'test');
        insert into public.deal_hunter_opportunity_scores
        (opportunity_id, scored_at, deal_key, name, fit_score, confidence, score_fingerprint, engine_version,
          rules_version, profile_version, completeness_policy_version, current_triage_eligible, should_remove,
          criteria_group, criteria_profile_version)
        values ('${id}', now(), '${id}', 'Lock ${id}', 95, 'high', 'fp-${id}', 'test', 'test', 'test', 'test',
          true, false, 'auto', 'uckele-criteria-v1');`);
    }
    const nowText = new Date().toISOString();
    const command = (id, extra = {}) => JSON.stringify({ opportunityId: id, action: 'pursue',
      idempotencyKey: `auto-${id}`, actor: 'automation-auto-pursue', policyVersion: 'auto-pursue-v1',
      now: nowText, expectedDiscoveryRevision: 0, expectedMaterialRevision: 0, ...extra });
    const guard = (extra = {}) => JSON.stringify({ since: new Date(Date.now() - 3_600_000).toISOString(),
      until: new Date(Date.now() + 3_600_000).toISOString(), dailyCap: 1, ...extra });
    const autoDecision = (id, commandExtra = {}, guardExtra = {}) => JSON.parse(psql(container, database,
      `set role service_role; select public.pursue_cim_record_auto_pursue_decision_v1(
        '${command(id, commandExtra)}'::jsonb, '${guard(guardExtra)}'::jsonb);`));
    const decisionCount = (id) => psql(container, database,
      `select count(*) from public.deal_hunter_owner_decision_events where opportunity_id = '${id}';`);
    psql(container, database, `set role service_role; select public.pursue_cim_record_owner_decision_v1(
      '${JSON.stringify({ opportunityId: 'lock-watch', action: 'watch', idempotencyKey: 'owner-watch',
    actor: 'owner', policyVersion: 'owner-decision-v1', now: nowText, expectedDiscoveryRevision: 0,
    expectedMaterialRevision: 0 })}'::jsonb);`);
    assert.equal(decisionCount('lock-watch'), '1');
    const overWatch = autoDecision('lock-watch');
    assert.equal(overWatch.conflict, true);
    assert.equal(overWatch.reason, 'auto_pursue_owner_decision_exists');
    assert.equal(decisionCount('lock-watch'), '1');
    const first = autoDecision('lock-a');
    assert.equal(first.applied, true, JSON.stringify(first));
    assert.equal(first.decision.policy_version, 'auto-pursue-v1');
    assert.equal(autoDecision('lock-a').replay, true);
    assert.equal(decisionCount('lock-a'), '1');
    assert.equal(autoDecision('lock-b').reason, 'auto_pursue_daily_cap_reached');
    assert.equal(decisionCount('lock-b'), '0');
    assert.equal(autoDecision('lock-date', {}, { dailyCap: 5,
      since: new Date(Date.now() + 3_600_000).toISOString(),
      until: new Date(Date.now() + 7_200_000).toISOString() }).reason, 'auto_pursue_business_date_changed');
    assert.equal(decisionCount('lock-date'), '0');
    assert.throws(() => autoDecision('lock-date', { actor: 'owner' }), /Invalid automatic Pursue decision command/);
    assert.throws(() => autoDecision('lock-date', { policyVersion: 'owner-decision-v1' }),
      /Invalid automatic Pursue decision command/);
    assert.throws(() => autoDecision('lock-date', {}, { dailyCap: 11 }), /Invalid automatic Pursue guard/);
    psqlFails(container, database, `set role anon; select public.pursue_cim_record_auto_pursue_decision_v1(
      '${command('lock-date')}'::jsonb, '${guard()}'::jsonb);`, /permission denied/);
    // The Supabase adapter's prior-conversation check sends an escaped ILIKE pattern: it
    // must match a mixed-case stored address and treat LIKE metacharacters literally.
    const escapeLike = (value) => value.replace(/[\\%_]/g, (character) => `\\${character}`);
    const matches = (stored, address) => psql(container, database,
      `select '${stored}' ilike '${escapeLike(address.trim().toLowerCase())}';`);
    assert.equal(matches('Pat.Broker@BrokerFirm.test', ' pat.broker@BROKERFIRM.test '), 't');
    assert.equal(matches('o%k_x\\y@Broker.test', 'O%K_X\\Y@broker.test'), 't');
    assert.equal(matches('oZk_x\\y@broker.test', 'o%k_x\\y@broker.test'), 'f');
    assert.equal(matches('o%kZx\\y@broker.test', 'o%k_x\\y@broker.test'), 'f');
    assert.equal(matches('other.pat.broker@brokerfirm.test', 'pat.broker@brokerfirm.test'), 'f');
  }
});

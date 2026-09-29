import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const docker = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';
const base = 'c1f2637a08e5ed698a0f799251cc25ad32094041';
const migration = path.join(root, 'supabase/migrations/20261001120000_postgres_crm_authority_parity.sql');

function run(args, input = '', allowFailure = false) {
  const result = spawnSync(docker, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!allowFailure) assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result;
}

function sql(container, database, statement, allowFailure = false) {
  return run(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', database], statement, allowFailure);
}

function sqlAsync(container, database, statement) {
  return new Promise((resolve) => {
    const child = spawn(docker, ['exec', '-i', container, 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(statement);
  });
}

function read(container, database, limit = 5000, supersessionLimit = 5000) {
  return JSON.parse(sql(container, database,
    `select public.read_deal_hunter_crm_match_authority_v2(${limit}, ${supersessionLimit})::text;`).stdout.trim());
}

test('PostgreSQL CRM authority on fresh and upgraded disposable schemas', {
  skip: enabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1', timeout: 240_000,
}, async (t) => {
  run(['image', 'inspect', 'postgres:16']);
  const container = `uckele-crm-authority-${process.pid}`;
  let started = false;
  t.after(() => { if (started) run(['rm', '-f', container]); });
  run(['run', '--rm', '--pull=never', '--network=none', '--tmpfs', '/var/lib/postgresql/data',
    '--name', container, '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16']);
  started = true;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = run(['logs', container], '', true);
    const readyEvents = `${logs.stdout}\n${logs.stderr}`
      .match(/database system is ready to accept connections/g)?.length || 0;
    if (readyEvents >= 2 && run(['exec', container, 'pg_isready', '-U', 'postgres'], '', true).status === 0) break;
    if (attempt === 99) assert.fail('PostgreSQL did not become ready');
    Atomics.wait(wait, 0, 0, 100);
  }
  sql(container, 'postgres', 'create role anon nologin; create role authenticated nologin; create role service_role nologin; create database crm_authority_fresh; create database crm_authority_upgrade; create database crm_authority_bound;');
  const current = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const previous = execFileSync('git', ['show', `${base}:supabase/schema.sql`], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  sql(container, 'crm_authority_fresh', current);
  sql(container, 'crm_authority_upgrade', previous);
  sql(container, 'crm_authority_upgrade', fs.readFileSync(migration, 'utf8'));
  sql(container, 'crm_authority_bound', current);

  for (const database of ['crm_authority_fresh', 'crm_authority_upgrade']) {
    await t.test(`${database}: complete snapshot and stale conditional link`, () => {
      const empty = read(container, database);
      assert.equal(empty.complete, true);
      assert.equal(empty.submissionCount, 0);
      assert.equal(empty.supersessionCount, 0);
      assert.match(empty.revision, /^[0-9a-f]{64}$/);
      assert.equal(empty.revisionVersion, 'deal-hunter-crm-match-authority-v2');
      assert.equal(read(container, database).revision, empty.revision);
      const id = '00000000-0000-4000-8000-000000000001';
      sql(container, database, `insert into public.contact_submissions (
        id, created_at, updated_at, status, delivery_provider, delivery_status,
        crm_status, source, ip_hash, name, email, message, metadata)
        values ('${id}', now(), now(), 'review', 'none', 'not-applicable',
          'pending', 'postgres-test', '', 'Fixture', 'fixture@example.test',
          'Fixture', '{"dealHunter":{"opportunityId":"opp-1"}}');
        insert into public.deal_hunter_opportunities
          (opportunity_id, created_at, updated_at, canonical_name, identity_version, status)
        values ('opp-1', now(), now(), 'Fixture', 'test-v1', 'active');`);
      const authority = read(container, database);
      assert.equal(authority.submissionCount, 1);
      assert.equal(authority.rows[0].id, id);
      assert.notEqual(authority.revision, empty.revision);
      assert.equal(read(container, database).revision, authority.revision);
      sql(container, database, `update public.contact_submissions set company = 'Changed' where id = '${id}';`);
      assert.notEqual(read(container, database).revision, authority.revision);
      const rejected = sql(container, database, `select public.link_deal_hunter_crm_submission_if_authority_current_v2(
        'opp-1', '${id}'::uuid, '${authority.revision}', now());`, true);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /CRM_MATCH_AUTHORITY_STALE/);
      const noPartialLink = sql(container, database, `select primary_submission_id is null from public.deal_hunter_opportunities where opportunity_id = 'opp-1';`).stdout.trim();
      assert.equal(noPartialLink, 't');
      const missingToken = sql(container, database, `select public.link_deal_hunter_crm_submission_if_authority_current_v2(
        'opp-1', '${id}'::uuid, null, now());`, true);
      assert.notEqual(missingToken.status, 0, 'NULL expected authority must never authorize linkage');
      assert.equal(sql(container, database, `select primary_submission_id is null
        from public.deal_hunter_opportunities where opportunity_id = 'opp-1';`).stdout.trim(), 't');
      const fresh = read(container, database);
      const linked = JSON.parse(sql(container, database, `begin; set local role service_role;
        select to_jsonb(public.link_deal_hunter_crm_submission_if_authority_current_v2(
          'opp-1', '${id}'::uuid, '${fresh.revision}', now()))::text; commit;`).stdout.trim());
      assert.equal(linked.primary_submission_id, id);
    });
    await t.test(`${database}: supersession evidence, loser guard, survivor control, and parent invariants`, () => {
      const survivor = '00000000-0000-4000-8000-000000000001';
      const loser = '00000000-0000-4000-8000-000000000002';
      sql(container, database, `insert into public.contact_submissions (
        id, created_at, updated_at, status, delivery_provider, delivery_status,
        crm_status, source, ip_hash, name, email, message, metadata)
        values ('${loser}', now(), now(), 'review', 'none', 'not-applicable',
          'pending', 'postgres-test', '', 'Loser', 'loser@example.test',
          'Fixture', '{"dealHunter":{"opportunityId":"opp-1"}}');
        insert into public.deal_hunter_cim_repair_manifests
          (id, created_at, updated_at, mode, status, actor, backup_reference, checksum, manifest)
        values ('receipt-1', now(), now(), 'crm-duplicate-consolidation', 'applied',
          'reviewer', 'disposable-db', '${'a'.repeat(64)}', '{"schema":"crm-duplicate-consolidation-plan-v1"}');`);
      const relation = (id, survivorId, loserId, receipt = 'receipt-1') => `insert into public.crm_submission_supersessions
        (id, created_at, updated_at, status, survivor_submission_id, superseded_submission_id,
          opportunity_id, reason_code, reason_text, approved_by, approved_at, actor,
          repair_version, repair_manifest_id, repair_digest)
        values ('${id}', now(), now(), 'active', '${survivorId}', '${loserId}', 'opp-1',
          'confirmed-duplicate', 'Reviewed fixture', 'owner@example.test', now(),
          'reviewer', 'crm-duplicate-consolidation-v1', '${receipt}', '${'a'.repeat(64)}');`;
      for (const invalid of [
        relation('same', survivor, survivor),
        relation('missing-survivor', '00000000-0000-4000-8000-000000000099', loser),
        relation('missing-loser', survivor, '00000000-0000-4000-8000-000000000099'),
        relation('bad-receipt', survivor, loser, 'missing-receipt'),
        relation('missing-opportunity', survivor, loser).replace("'opp-1'", "'missing-opportunity'"),
      ]) assert.notEqual(sql(container, database, invalid, true).status, 0);
      sql(container, database, `insert into public.contact_submissions (
        id, created_at, updated_at, status, delivery_provider, delivery_status,
        crm_status, source, ip_hash, name, email, message, metadata)
        values
        ('00000000-0000-4000-8000-000000000015', now(), now(), 'review', 'none',
          'not-applicable', 'pending', 'postgres-test', '', 'Survivor', 's15@example.test',
          'Fixture', '{"dealHunter":{"opportunityId":"opp-null-primary"}}'),
        ('00000000-0000-4000-8000-000000000016', now(), now(), 'review', 'none',
          'not-applicable', 'pending', 'postgres-test', '', 'Loser', 's16@example.test',
          'Fixture', '{"dealHunter":{"opportunityId":"opp-null-primary"}}');
        insert into public.deal_hunter_opportunities
          (opportunity_id, created_at, updated_at, canonical_name, identity_version, status)
          values ('opp-null-primary', now(), now(), 'Null primary', 'test-v1', 'active');`);
      const nullPrimary = sql(container, database, relation('null-primary',
        '00000000-0000-4000-8000-000000000015',
        '00000000-0000-4000-8000-000000000016')
        .replace("'opp-1'", "'opp-null-primary'"), true);
      assert.notEqual(nullPrimary.status, 0, 'active relation requires survivor canonical primary');
      sql(container, database, `insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version,
          status, primary_submission_id)
        values ('opp-disabled', now(), now(), 'Disabled', 'test-v1', 'superseded', '${survivor}'),
          ('opp-loser-primary', now(), now(), 'Loser primary', 'test-v1', 'active', '${loser}');`);
      assert.notEqual(sql(container, database, relation('inactive-opportunity', survivor, loser)
        .replace("'opp-1'", "'opp-disabled'"), true).status, 0);
      assert.notEqual(sql(container, database, relation('loser-primary', survivor, loser), true).status, 0);
      sql(container, database, `update public.deal_hunter_opportunities
        set primary_submission_id = null where opportunity_id = 'opp-loser-primary';`);
      const before = read(container, database);
      sql(container, database, relation('relation-1', survivor, loser));
      const after = read(container, database);
      assert.equal(after.supersessionCount, 1);
      assert.notEqual(after.revision, before.revision);
      assert.notEqual(sql(container, database, relation('duplicate-loser', survivor, loser), true).status, 0);
      assert.notEqual(sql(container, database,
        `update public.crm_submission_supersessions set approved_by = 'changed' where id = 'relation-1';`, true).status, 0);
      assert.notEqual(sql(container, database,
        `delete from public.crm_submission_supersessions where id = 'relation-1';`, true).status, 0);
      assert.notEqual(sql(container, database,
        `update public.deal_hunter_opportunities set status = 'superseded' where opportunity_id = 'opp-1';`, true).status, 0);
      assert.notEqual(sql(container, database,
        `update public.contact_submissions set deal_hunter_opportunity_id = null,
          metadata = '{}' where id = '${survivor}';`, true).status, 0);
      assert.notEqual(sql(container, database,
        `update public.contact_submissions set company = 'Changed loser' where id = '${loser}';`, true).status, 0);
      assert.notEqual(sql(container, database,
        `update public.deal_hunter_cim_repair_manifests set checksum = '${'b'.repeat(64)}' where id = 'receipt-1';`, true).status, 0);
      sql(container, database, `insert into public.deal_hunter_cim_repair_manifests
        (id, created_at, updated_at, mode, status, actor, backup_reference, checksum, manifest)
        values ('invalid-reversal', now(), now(), 'crm-duplicate-consolidation', 'applied',
          'reviewer', 'disposable-db', '${'a'.repeat(64)}', '{}');`);
      const invalidReversal = sql(container, database, `update public.crm_submission_supersessions
        set status = 'reversed', updated_at = now(), reversed_at = now(),
          reversed_by = 'reviewer', reversal_reason = 'Missing evidence',
          reversal_manifest_id = 'invalid-reversal' where id = 'relation-1';`, true);
      assert.notEqual(invalidReversal.status, 0, 'missing reversal evidence must not reverse authority');
      const loserResult = sql(container, database, `select public.link_deal_hunter_crm_submission_if_authority_current_v2(
        'opp-1', '${loser}', '${after.revision}', now());`, true);
      assert.notEqual(loserResult.status, 0);
      assert.match(loserResult.stderr, new RegExp(`CRM_SUBMISSION_SUPERSEDED:${survivor}`));
      const linked = JSON.parse(sql(container, database, `select to_jsonb(public.link_deal_hunter_crm_submission_if_authority_current_v2(
        'opp-1', '${survivor}', '${after.revision}', now()))::text;`).stdout.trim());
      assert.equal(linked.primary_submission_id, survivor);
      sql(container, database, `insert into public.deal_hunter_cim_repair_manifests
        (id, created_at, updated_at, mode, status, actor, backup_reference, checksum, manifest)
        values ('reversal-1', now(), now(), 'crm-duplicate-consolidation', 'applied',
          'reviewer', 'disposable-db', '${'a'.repeat(64)}',
          jsonb_build_object('schema', 'crm-duplicate-consolidation-reversal-manifest-v1',
            'operation', 'reverse', 'relationId', 'relation-1', 'applyManifestId', 'receipt-1',
            'repairDigest', '${'a'.repeat(64)}', 'survivorSubmissionId', '${survivor}',
            'supersededSubmissionId', '${loser}', 'opportunityId', 'opp-1'));
        update public.crm_submission_supersessions set status = 'reversed', updated_at = now(),
          reversed_at = now(), reversed_by = 'reviewer', reversal_reason = 'Reviewed reversal',
          reversal_manifest_id = 'reversal-1' where id = 'relation-1';`);
      const reversed = read(container, database);
      assert.equal(reversed.supersessionCount, 0);
      assert.notEqual(reversed.revision, after.revision);
    });
    await t.test(`${database}: concurrent conditional links select one current owner`, async () => {
      sql(container, database, `insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version, status)
        values ('opp-race', now(), now(), 'Race', 'test-v1', 'active');
        insert into public.contact_submissions (
          id, created_at, updated_at, status, delivery_provider, delivery_status,
          crm_status, source, ip_hash, name, email, message)
        values
          ('00000000-0000-4000-8000-000000000003', now(), now(), 'review', 'none', 'not-applicable',
            'pending', 'postgres-test', '', 'A', 'a@example.test', 'Fixture'),
          ('00000000-0000-4000-8000-000000000004', now(), now(), 'review', 'none', 'not-applicable',
            'pending', 'postgres-test', '', 'B', 'b@example.test', 'Fixture');`);
      const revision = read(container, database).revision;
      const attempts = await Promise.all([3, 4].map((number) => sqlAsync(container, database,
        `select public.link_deal_hunter_crm_submission_if_authority_current_v2(
          'opp-race', '00000000-0000-4000-8000-00000000000${number}', '${revision}', now());`)));
      assert.equal(attempts.filter((attempt) => attempt.status === 0).length, 1);
      assert.equal(attempts.filter((attempt) => attempt.status !== 0).length, 1);
      assert.match(attempts.find((attempt) => attempt.status !== 0).stderr, /CRM_MATCH_AUTHORITY_STALE/);
      assert.equal(sql(container, database, `select count(*) from public.contact_submissions
        where deal_hunter_opportunity_id = 'opp-race';`).stdout.trim(), '1');
    });
    await t.test(`${database}: ownership, lifecycle, and late failure leave no partial link`, () => {
      const insertContact = (n, metadataOwner = '', directOwner = null, status = 'review') => `
        insert into public.contact_submissions (
          id, created_at, updated_at, status, delivery_provider, delivery_status,
          crm_status, source, ip_hash, name, email, message, metadata, deal_hunter_opportunity_id)
        values ('00000000-0000-4000-8000-${String(n).padStart(12, '0')}', now(), now(),
          '${status}', 'none', 'not-applicable', 'pending', 'postgres-test', '',
          'Fixture', 'fixture-${n}@example.test', 'Fixture',
          '{"dealHunter":{"opportunityId":"${metadataOwner}"}}',
          ${directOwner ? `'${directOwner}'` : 'null'});`;
      const insertOpportunity = (id, primary = null) => `insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version, status, primary_submission_id)
        values ('${id}', now(), now(), 'Fixture', 'test-v1', 'active',
          ${primary ? `'00000000-0000-4000-8000-${String(primary).padStart(12, '0')}'` : 'null'});`;
      const attempt = (id, n, revision) => sql(container, database,
        `select public.link_deal_hunter_crm_submission_if_authority_current_v2(
          '${id}', '00000000-0000-4000-8000-${String(n).padStart(12, '0')}', '${revision}', now());`, true);
      const unlinked = (id, n) => {
        assert.equal(sql(container, database, `select primary_submission_id is null
          from public.deal_hunter_opportunities where opportunity_id = '${id}';`).stdout.trim(), 't');
        assert.equal(sql(container, database, `select deal_hunter_opportunity_id is null
          from public.contact_submissions where id = '00000000-0000-4000-8000-${String(n).padStart(12, '0')}';`).stdout.trim(), 't');
      };

      sql(container, database, `${insertOpportunity('opp-owner')}${insertOpportunity('opp-other')}
        ${insertContact(5, 'opp-other', 'opp-owner')}`);
      assert.match(attempt('opp-owner', 5, read(container, database).revision).stderr,
        /CRM_MATCH_AUTHORITY_STALE/);
      // The direct claim predates this attempt, but the primary remains untouched.
      assert.equal(sql(container, database, `select primary_submission_id is null from public.deal_hunter_opportunities
        where opportunity_id = 'opp-owner';`).stdout.trim(), 't');

      sql(container, database, `${insertOpportunity('opp-inactive')}${insertContact(6, 'opp-inactive')}`);
      const beforeInactive = read(container, database).revision;
      sql(container, database, `update public.contact_submissions set status = 'archived'
        where id = '00000000-0000-4000-8000-000000000006';`);
      assert.match(attempt('opp-inactive', 6, beforeInactive).stderr,
        /CRM_MATCH_AUTHORITY_STALE/);
      unlinked('opp-inactive', 6);
      assert.match(attempt('opp-inactive', 6, read(container, database).revision).stderr,
        /CRM_MATCH_AUTHORITY_STALE/);

      sql(container, database, `${insertOpportunity('opp-candidate')}${insertContact(7, 'opp-candidate')}`);
      const beforeCandidate = read(container, database).revision;
      sql(container, database, insertContact(8, 'opp-candidate'));
      assert.match(attempt('opp-candidate', 7, beforeCandidate).stderr, /CRM_MATCH_AUTHORITY_STALE/);
      unlinked('opp-candidate', 7);

      sql(container, database, `${insertOpportunity('opp-no-longer-current')}${insertContact(9, 'opp-no-longer-current')}`);
      const beforeStatus = read(container, database).revision;
      sql(container, database, `update public.deal_hunter_opportunities set status = 'superseded'
        where opportunity_id = 'opp-no-longer-current';`);
      assert.match(attempt('opp-no-longer-current', 9, beforeStatus).stderr, /CRM_MATCH_AUTHORITY_STALE/);
      unlinked('opp-no-longer-current', 9);

      sql(container, database, `${insertContact(10, 'opp-primary')}${insertContact(11, 'opp-primary')}
        ${insertOpportunity('opp-primary')}`);
      const beforePrimary = read(container, database).revision;
      sql(container, database, `update public.deal_hunter_opportunities
        set primary_submission_id = '00000000-0000-4000-8000-000000000011'
        where opportunity_id = 'opp-primary';`);
      assert.equal(read(container, database).revision, beforePrimary);
      assert.match(attempt('opp-primary', 10, beforePrimary).stderr,
        /CRM_MATCH_AUTHORITY_STALE/);
      assert.equal(sql(container, database, `select primary_submission_id from public.deal_hunter_opportunities
        where opportunity_id = 'opp-primary';`).stdout.trim(), '00000000-0000-4000-8000-000000000011');

      sql(container, database, `${insertOpportunity('opp-conflict')}${insertContact(13, 'opp-conflict')}`);
      const beforeConflict = read(container, database).revision;
      sql(container, database, insertContact(14, 'opp-conflict', 'opp-conflict'));
      assert.match(attempt('opp-conflict', 13, beforeConflict).stderr, /CRM_MATCH_AUTHORITY_STALE/);
      unlinked('opp-conflict', 13);

      sql(container, database, `${insertOpportunity('opp-rollback')}${insertContact(12, 'opp-rollback')}`);
      sql(container, database, `create function public.crm_test_reject_opportunity_update()
        returns trigger language plpgsql as $$ begin
          if new.opportunity_id = 'opp-rollback' then raise exception 'injected late failure'; end if;
          return new;
        end; $$;
        create trigger crm_test_reject_opportunity_update before update
          on public.deal_hunter_opportunities for each row
          execute function public.crm_test_reject_opportunity_update();`);
      assert.match(attempt('opp-rollback', 12, read(container, database).revision).stderr,
        /injected late failure/);
      unlinked('opp-rollback', 12);
      sql(container, database, `drop trigger crm_test_reject_opportunity_update
        on public.deal_hunter_opportunities; drop function public.crm_test_reject_opportunity_update();`);
    });
    await t.test(`${database}: dependent CRM activity cannot write an active loser`, async () => {
      const survivor = '00000000-0000-4000-8000-000000000030';
      const loser = '00000000-0000-4000-8000-000000000031';
      sql(container, database, `insert into public.contact_submissions (
        id, created_at, updated_at, status, delivery_provider, delivery_status,
        crm_status, source, ip_hash, name, email, message, metadata)
        values ('${survivor}', now(), now(), 'review', 'none', 'not-applicable',
          'pending', 'postgres-test', '', 'Survivor', 'a30@example.test', 'Fixture',
          '{"dealHunter":{"opportunityId":"opp-activity"}}'),
          ('${loser}', now(), now(), 'review', 'none', 'not-applicable',
          'pending', 'postgres-test', '', 'Loser', 'a31@example.test', 'Fixture',
          '{"dealHunter":{"opportunityId":"opp-activity"}}');
        insert into public.deal_hunter_opportunities
          (opportunity_id, created_at, updated_at, canonical_name, identity_version,
            status, primary_submission_id)
          values ('opp-activity', now(), now(), 'Activity', 'test-v1', 'active', '${survivor}');
        insert into public.deal_hunter_cim_repair_manifests
          (id, created_at, updated_at, mode, status, actor, checksum)
          values ('activity-receipt', now(), now(), 'crm-duplicate-consolidation',
            'applied', 'reviewer', '${'a'.repeat(64)}');
        insert into public.crm_submission_supersessions
          (id, created_at, updated_at, status, survivor_submission_id,
            superseded_submission_id, opportunity_id, reason_code, reason_text,
            approved_by, approved_at, actor, repair_version, repair_manifest_id, repair_digest)
          values ('activity-relation', now(), now(), 'active', '${survivor}', '${loser}',
            'opp-activity', 'confirmed-duplicate', 'Fixture', 'owner@example.test',
            now(), 'reviewer', 'v1', 'activity-receipt', '${'a'.repeat(64)}');`);
      const activity = sql(container, database, `insert into public.crm_activity_events
        (id, submission_id, created_at, actor, role, event_type, summary)
        values ('00000000-0000-4000-8000-000000000032', '${loser}', now(),
          'test', 'admin', 'submission.updated', 'Unsafe loser activity');`, true);
      assert.notEqual(activity.status, 0);
      assert.equal(sql(container, database, `select count(*) from public.crm_activity_events
        where submission_id = '${loser}';`).stdout.trim(), '0');
      const raceSurvivor = '00000000-0000-4000-8000-000000000034';
      const raceLoser = '00000000-0000-4000-8000-000000000035';
      sql(container, database, `insert into public.contact_submissions (
        id, created_at, updated_at, status, delivery_provider, delivery_status,
        crm_status, source, ip_hash, name, email, message, metadata)
        values ('${raceSurvivor}', now(), now(), 'review', 'none', 'not-applicable',
          'pending', 'postgres-test', '', 'Survivor', 'a34@example.test', 'Fixture',
          '{"dealHunter":{"opportunityId":"opp-activity-race"}}'),
          ('${raceLoser}', now(), now(), 'review', 'none', 'not-applicable',
          'pending', 'postgres-test', '', 'Loser', 'a35@example.test', 'Fixture',
          '{"dealHunter":{"opportunityId":"opp-activity-race"}}');
        insert into public.deal_hunter_opportunities
          (opportunity_id, created_at, updated_at, canonical_name, identity_version,
            status, primary_submission_id)
          values ('opp-activity-race', now(), now(), 'Activity race', 'test-v1',
            'active', '${raceSurvivor}');`);
      const pendingRelation = sqlAsync(container, database, `begin;
        insert into public.crm_submission_supersessions
          (id, created_at, updated_at, status, survivor_submission_id,
            superseded_submission_id, opportunity_id, reason_code, reason_text,
            approved_by, approved_at, actor, repair_version, repair_manifest_id, repair_digest)
          values ('activity-race-relation', now(), now(), 'active', '${raceSurvivor}',
            '${raceLoser}', 'opp-activity-race', 'confirmed-duplicate', 'Fixture',
            'owner@example.test', now(), 'reviewer', 'v1', 'activity-receipt',
            '${'a'.repeat(64)}');
        select pg_sleep(0.5); commit;`);
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 150);
      const pendingActivity = sqlAsync(container, database, `insert into public.crm_activity_events
        (id, submission_id, created_at, actor, role, event_type, summary)
        values ('00000000-0000-4000-8000-000000000036', '${raceLoser}', now(),
          'test', 'admin', 'submission.updated', 'Racing loser activity');`);
      const [relationResult, activityResult] = await Promise.all([pendingRelation, pendingActivity]);
      assert.equal(relationResult.status, 0, relationResult.stderr);
      assert.notEqual(activityResult.status, 0);
      assert.equal(sql(container, database, `select count(*) from public.crm_activity_events
        where submission_id = '${raceLoser}';`).stdout.trim(), '0');
    });
    await t.test(`${database}: relation and RPC privileges are service role only`, () => {
      const privileges = JSON.parse(sql(container, database, `select jsonb_build_object(
        'rls', relrowsecurity,
        'anonTable', has_table_privilege('anon', 'public.crm_submission_supersessions', 'select'),
        'authenticatedTable', has_table_privilege('authenticated', 'public.crm_submission_supersessions', 'select'),
        'serviceTruncate', has_table_privilege('service_role', 'public.crm_submission_supersessions', 'truncate'),
        'serviceDelete', has_table_privilege('service_role', 'public.crm_submission_supersessions', 'delete'),
        'anonReadRpc', has_function_privilege('anon', 'public.read_deal_hunter_crm_match_authority_v2(integer,integer)', 'execute'),
        'anonLinkRpc', has_function_privilege('anon', 'public.link_deal_hunter_crm_submission_if_authority_current_v2(text,uuid,text,timestamptz)', 'execute'),
        'serviceReadRpc', has_function_privilege('service_role', 'public.read_deal_hunter_crm_match_authority_v2(integer,integer)', 'execute'),
        'serviceLinkRpc', has_function_privilege('service_role', 'public.link_deal_hunter_crm_submission_if_authority_current_v2(text,uuid,text,timestamptz)', 'execute'))
        from pg_class where oid = 'public.crm_submission_supersessions'::regclass;`).stdout.trim());
      assert.deepEqual(privileges, {
        rls: true, anonTable: false, authenticatedTable: false,
        serviceTruncate: false, serviceDelete: false,
        anonReadRpc: false, anonLinkRpc: false, serviceReadRpc: true, serviceLinkRpc: true,
      });
    });
  }
  await t.test('independent exact and over bounds never hash an incomplete authority', () => {
    const database = 'crm_authority_bound';
    sql(container, database, `insert into public.contact_submissions (
      id, created_at, updated_at, status, delivery_provider, delivery_status,
      crm_status, source, ip_hash, name, email, message)
      select ('00000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
        now(), now(), 'review', 'none', 'not-applicable', 'pending', 'bound', '',
        'Bound', 'bound@example.test', 'Fixture' from generate_series(1, 5000) value;`);
    const exact = read(container, database);
    assert.equal(exact.complete, true);
    assert.equal(exact.submissionCount, 5000);
    assert.match(exact.revision, /^[0-9a-f]{64}$/);
    sql(container, database, `insert into public.contact_submissions (
      id, created_at, updated_at, status, delivery_provider, delivery_status,
      crm_status, source, ip_hash, name, email, message)
      values ('00000000-0000-4000-8000-000000005001', now(), now(), 'review',
        'none', 'not-applicable', 'pending', 'bound', '', 'Bound', 'bound@example.test', 'Fixture');`);
    const over = read(container, database);
    assert.equal(over.complete, false);
    assert.equal(over.revision, null);
    assert.equal(over.submissionCount, null);
    assert.deepEqual(over.rows, []);
    assert.deepEqual(over.supersessions, []);
    sql(container, database, 'truncate public.contact_submissions cascade;');
    // Superuser bypasses FKs and validation solely to isolate the supersession bound,
    // as the SQLite boundary fixture does; production writes keep all guards enabled.
    sql(container, database, `set session_replication_role = replica;
      insert into public.crm_submission_supersessions (
        id, created_at, updated_at, status, survivor_submission_id,
        superseded_submission_id, opportunity_id, reason_code, reason_text,
        approved_by, approved_at, actor, repair_version, repair_manifest_id, repair_digest)
      select 'bound-' || value, now(), now(), 'active',
        ('00000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
        ('10000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
        'opp-' || value, 'confirmed-duplicate', 'Boundary fixture',
        'owner@example.test', now(), 'test', 'v1', 'receipt-' || value,
        '${'a'.repeat(64)}' from generate_series(1, 5000) value;
      set session_replication_role = origin;`);
    const exactSupersessions = read(container, database);
    assert.equal(exactSupersessions.complete, true);
    assert.equal(exactSupersessions.supersessionCount, 5000);
    assert.equal(exactSupersessions.submissionCount, 0);
    sql(container, database, `set session_replication_role = replica;
      insert into public.crm_submission_supersessions (
        id, created_at, updated_at, status, survivor_submission_id,
        superseded_submission_id, opportunity_id, reason_code, reason_text,
        approved_by, approved_at, actor, repair_version, repair_manifest_id, repair_digest)
      values ('bound-5001', now(), now(), 'active',
        '00000000-0000-4000-8000-000000005001',
        '10000000-0000-4000-8000-000000005001', 'opp-5001',
        'confirmed-duplicate', 'Boundary fixture', 'owner@example.test',
        now(), 'test', 'v1', 'receipt-5001', '${'a'.repeat(64)}');
      set session_replication_role = origin;`);
    const overSupersessions = read(container, database);
    assert.equal(overSupersessions.complete, false);
    assert.equal(overSupersessions.revision, null);
    assert.equal(overSupersessions.supersessionCount, null);
    sql(container, database, 'truncate public.crm_submission_supersessions;');
    sql(container, database, `insert into public.contact_submissions (
      id, created_at, updated_at, status, delivery_provider, delivery_status,
      crm_status, source, ip_hash, name, email, message, metadata)
      select ('00000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
        now(), now(), 'review', 'none', 'not-applicable', 'pending', 'chain', '',
        'Chain', 'chain@example.test', 'Fixture',
        '{"dealHunter":{"opportunityId":"opp-a"}}'::jsonb
      from generate_series(1, 3) value;
      insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version,
          status, primary_submission_id)
        values ('opp-a', now(), now(), 'A', 'test-v1', 'active',
          '00000000-0000-4000-8000-000000000001');
      insert into public.deal_hunter_cim_repair_manifests
        (id, created_at, updated_at, mode, status, actor, checksum)
        values ('chain-receipt', now(), now(), 'crm-duplicate-consolidation',
          'applied', 'reviewer', '${'a'.repeat(64)}');
      insert into public.crm_submission_supersessions
        (id, created_at, updated_at, status, survivor_submission_id,
          superseded_submission_id, opportunity_id, reason_code, reason_text,
          approved_by, approved_at, actor, repair_version, repair_manifest_id, repair_digest)
        values ('a-to-b', now(), now(), 'active',
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002', 'opp-a',
          'confirmed-duplicate', 'Fixture', 'owner@example.test', now(),
          'reviewer', 'v1', 'chain-receipt', '${'a'.repeat(64)}');`);
    // Build a corrupted intermediate authority solely to exercise the chain guard;
    // normal triggers prevent making the active loser another opportunity primary.
    sql(container, database, `set session_replication_role = replica;
      update public.contact_submissions
        set metadata = '{"dealHunter":{"opportunityId":"opp-b"}}'
        where id in ('00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003');
      insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version,
          status, primary_submission_id)
        values ('opp-b', now(), now(), 'B', 'test-v1', 'active',
          '00000000-0000-4000-8000-000000000002');
      set session_replication_role = origin;`);
    const chain = sql(container, database, `insert into public.crm_submission_supersessions
      (id, created_at, updated_at, status, survivor_submission_id,
        superseded_submission_id, opportunity_id, reason_code, reason_text,
        approved_by, approved_at, actor, repair_version, repair_manifest_id, repair_digest)
      values ('b-to-c', now(), now(), 'active',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003', 'opp-b',
        'confirmed-duplicate', 'Fixture', 'owner@example.test', now(),
        'reviewer', 'v1', 'chain-receipt', '${'a'.repeat(64)}');`, true);
    assert.notEqual(chain.status, 0);
    assert.match(chain.stderr, /active role would create a chain/);
  });
});

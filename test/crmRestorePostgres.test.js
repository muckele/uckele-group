import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { restoreProtectedTables, stoppedRestoreAuthoritySql } from './fixtures/crmRestoreStoppedAuthority.js';

const enabled = process.env.CRM_RESTORE_POSTGRES_INTEGRATION === '1';
const docker = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';
const root = path.resolve(import.meta.dirname, '..');
const submissionId = '11111111-1111-4111-8111-111111111111';
const passId = '11111111-2222-4222-8222-111111111111';
const at = '2026-10-18T10:00:00.000Z';
const payload = { id: submissionId, expectedUpdatedAt: at, status: 'review' };
const activity = { id: '11111111-5555-4555-8555-111111111111', submission_id: submissionId,
  event_type: 'submission.restored', actor: 'fixture-owner', role: 'admin', created_at: '2026-10-18T11:00:00.000Z',
  summary: 'Synthetic restore; outreach remains stopped', metadata: { outreachRestarted: false } };
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const rpc = (input = payload, event = activity) => `public.restore_archived_submission_with_crm_activity(
  ${literal(JSON.stringify(input))}::jsonb, ${literal(JSON.stringify(event))}::jsonb)`;

function run(args, input, allowFailure = false) {
  const result = spawnSync(docker, args, { cwd: root, input, encoding: 'utf8',
    timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result;
}

function psql(container, database, sql, allowFailure = false) {
  return run(['exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=10000 -c lock_timeout=5000',
    container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], sql, allowFailure);
}

function asyncPsql(container, database, sql, expectMarker = false) {
  const child = spawn(docker, ['exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=10000 -c lock_timeout=8000',
    container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], { cwd: root });
  let stdout = '', stderr = '', mark;
  const marker = new Promise((resolve) => { mark = resolve; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('fl02-writer-locked')) mark();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); if (code === 0) resolve(stdout); else reject(new Error(stderr || `psql exited ${code}`)); });
  });
  completed.catch(() => {});
  child.stdin.end(sql);
  return { completed, marker: expectMarker
    ? Promise.race([marker, completed.then(() => { throw new Error('Writer exited before lock marker'); })])
    : null };
}

const seed = `
  INSERT INTO public.contact_submissions
    (id,created_at,updated_at,status,delivery_provider,delivery_status,crm_status,source,ip_hash,
     name,email,message,archived_at,archive_reason,archive_note,follow_up_state,metadata)
    VALUES ('${submissionId}','${at}','${at}','archived','console','not-sent','not-synced',
      'fl02-synthetic','synthetic','Synthetic lead','broker@example.test','Synthetic','${at}',
      'Original owner reason','Retained exact decision note','completed',
      '{"acquisitionCommand":{"pipelineStage":"passed","passReason":"Original owner reason","fitFeedback":"false-positive","updatedAt":"${at}"},"keep":"unrelated"}');
  INSERT INTO public.deal_hunter_opportunities
    (opportunity_id,created_at,updated_at,canonical_name,primary_submission_id,identity_version,status)
    VALUES ('canonical-restore','${at}','${at}','Synthetic lead','${submissionId}','synthetic','active');
  INSERT INTO public.deal_hunter_opportunity_aliases
    (id,opportunity_id,alias_type,alias_value,alias_key,source,first_observed_at,last_observed_at,
     evidence_version,resolution_method,confidence_state,resolved_by,metadata)
    VALUES ('restore-alias','canonical-restore','deal-key','restore-deal','deal-key:restore-deal',
      'synthetic','${at}','${at}','synthetic','exact-deal-key','exact','fixture','{}');
  INSERT INTO public.deal_hunter_dispositions
    (id,deal_key,submission_id,deal_name,created_at,updated_at,disposition,reason,note,dismissed_at,
     dismissed_by,created_by,updated_by)
    VALUES ('${passId}','restore-deal','${submissionId}','Synthetic lead','${at}','${at}',
      'dismissed','Original owner reason','Retained exact decision note','${at}','owner','owner','owner');
`;

const snapshot = `jsonb_build_object(
  'submission',(select to_jsonb(s) from public.contact_submissions s where id='${submissionId}'),
  'dispositions',(select coalesce(jsonb_agg(to_jsonb(d) order by id),'[]') from public.deal_hunter_dispositions d),
  'events',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.crm_activity_events e),
  'protected',jsonb_build_object(${restoreProtectedTables.map((table) => `${literal(table)},
    (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.${table} x)`).join(',')}))`;

test('FL02 PostgreSQL fresh/upgrade restore is atomic, authorized and retains stopped authority', {
  skip: enabled ? false : 'set CRM_RESTORE_POSTGRES_INTEGRATION=1 for isolated PostgreSQL parity',
  timeout: 180_000,
}, async (t) => {
  const disk = fs.statfsSync(os.tmpdir());
  assert.ok(disk.bavail * disk.bsize >= 11 * 1024 ** 3, '11 GiB disk floor');
  run(['image', 'inspect', 'postgres:16']); // Never pulls/contacts a provider.
  const container = `ug-fl02-restore-${process.pid}-${randomUUID().slice(0, 8)}`;
  // Even an uncertain docker-run timeout must retire only this generated name.
  t.after(() => {
    const cleanup = run(['rm', '-f', container], undefined, true);
    if ((cleanup.error || cleanup.status !== 0) && !/No such container/i.test(cleanup.stderr || '')) {
      throw new Error(cleanup.error?.message || cleanup.stderr || 'Disposable PostgreSQL cleanup failed');
    }
  });
  run(['run', '--rm', '--pull=never', '--network=none', '--tmpfs', '/var/lib/postgresql/data',
    '--name', container, '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16']);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = run(['logs', container]).stdout;
    const ready = run(['exec', container, 'pg_isready', '-U', 'postgres'], undefined, true);
    // A full init/restart (not the temporary bootstrap server) must be ready.
    const allLogs = run(['logs', container]);
    if (`${logs}${allLogs.stderr}`.match(/database system is ready to accept connections/g)?.length >= 2 && ready.status === 0) break;
    if (attempt === 99) throw new Error('Disposable PostgreSQL readiness timed out');
    Atomics.wait(wait, 0, 0, 100);
  }
  psql(container, 'postgres', `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE DATABASE restore_fresh; CREATE DATABASE restore_upgrade;`);
  const previous = execFileSync('git', ['show', '6d28a05a258f46dbee72c1ce8b155e56d6fcd125:supabase/schema.sql'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  psql(container, 'restore_fresh', fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  psql(container, 'restore_upgrade', previous);
  psql(container, 'restore_upgrade', fs.readFileSync(path.join(root, 'supabase/migrations/20261018120000_atomic_crm_restore.sql'), 'utf8'));
  for (const database of ['restore_fresh', 'restore_upgrade']) {
    const rows = psql(container, database, `BEGIN; ${seed}
      ${stoppedRestoreAuthoritySql(submissionId, 'canonical-restore')}
      SELECT ${snapshot}; SET LOCAL ROLE service_role; SELECT ${rpc()}; SELECT ${rpc()};
      RESET ROLE; SELECT ${snapshot}; ROLLBACK;`).stdout.trim().split('\n').map(JSON.parse);
    assert.equal(rows[1].applied, true, database);
    assert.equal(rows[2].applied, false, 'Repeated restore must not write');
    const before = rows[0], after = rows[3];
    assert.equal(after.submission.status, 'review');
    assert.equal(after.submission.follow_up_state, 'completed');
    assert.equal(after.submission.next_action_at, null);
    assert.equal(after.submission.metadata.acquisitionCommand.pipelineStage, undefined);
    assert.equal(after.submission.archive_reason, before.submission.archive_reason);
    assert.equal(after.dispositions[0].disposition, 'restored');
    for (const field of ['id','reason','note','dismissed_at','dismissed_by']) assert.equal(after.dispositions[0][field], before.dispositions[0][field]);
    assert.equal(after.events.length, 1);
    assert.deepEqual(after.protected, before.protected, 'No permission, suppression, cap or campaign change');
    for (const mutation of [
      `UPDATE public.contact_submissions SET metadata=metadata || '{"dealHunter":{"opportunityId":"missing-canonical"}}'::jsonb;`,
      `UPDATE public.contact_submissions SET metadata=metadata || '{"dealHunter":{"dealKey":"unknown"}}'::jsonb;`,
      `UPDATE public.contact_submissions SET metadata=metadata || '{"dealHunter":{"dealKey":17}}'::jsonb;`,
      `INSERT INTO public.deal_hunter_opportunities
        (opportunity_id,created_at,updated_at,canonical_name,identity_version,status)
        VALUES ('foreign','${at}','${at}','Different business','synthetic','active');
        INSERT INTO public.deal_hunter_opportunity_aliases
          SELECT 'foreign-key','foreign',alias_type,'foreign-key','deal-key:foreign-key',source,
            first_observed_at,last_observed_at,evidence_version,resolution_method,confidence_state,resolved_by,metadata
          FROM public.deal_hunter_opportunity_aliases WHERE id='restore-alias';
        UPDATE public.contact_submissions SET metadata=metadata || '{"dealHunter":{"dealKey":"foreign-key"}}'::jsonb;`,
      "DELETE FROM public.deal_hunter_opportunity_aliases;",
      "UPDATE public.deal_hunter_opportunities SET primary_submission_id=NULL;",
      `INSERT INTO public.deal_hunter_opportunities
        (opportunity_id,created_at,updated_at,canonical_name,primary_submission_id,identity_version,status)
        VALUES ('second-primary','${at}','${at}','Different lead','${submissionId}','synthetic','active');`,
    ]) {
      const result = psql(container, database, `BEGIN; ${seed} ${mutation}
        SET LOCAL ROLE service_role; SELECT ${rpc()}; RESET ROLE; SELECT ${snapshot}; ROLLBACK;`)
        .stdout.trim().split('\n').map(JSON.parse);
      assert.equal(result[0].applied, false);
      assert.equal(result[1].submission.status, 'archived');
      assert.equal(result[1].dispositions[0].disposition, 'dismissed');
      assert.equal(result[1].events.length, 0);
    }
    const standalone = JSON.parse(psql(container, database, `BEGIN; ${seed}
      DELETE FROM public.deal_hunter_dispositions; DELETE FROM public.deal_hunter_opportunity_aliases;
      UPDATE public.deal_hunter_opportunities SET primary_submission_id=NULL;
      UPDATE public.contact_submissions SET metadata='{}'; SET LOCAL ROLE service_role;
      SELECT ${rpc()}; ROLLBACK;`).stdout.trim());
    assert.equal(standalone.applied, true);
    assert.equal(standalone.activity.opportunity_id, null);
    const exactMetadataKey = JSON.parse(psql(container, database, `BEGIN; ${seed}
      UPDATE public.contact_submissions SET metadata=metadata || '{"dealHunter":{"dealKey":"restore-deal"}}'::jsonb;
      SET LOCAL ROLE service_role; SELECT ${rpc()}; ROLLBACK;`).stdout.trim());
    assert.equal(exactMetadataKey.applied, true);
    for (const [commandAt, dismissedAt, cleared] of [
      [null, null, false], ['unrelated-date', at, false], ['infinity', 'infinity', false],
      ['2026-10-18T10:00:00.123001Z', '2026-10-18T10:00:00.123999Z', false],
      ['2026-02-30T10:00:00.000Z', at, false],
      ['2026-10-18T24:00:00.000Z', '2026-10-19T00:00:00.000Z', false],
      ['2026-10-18T05:00:00.000-05:00', at, true],
    ]) {
      const projection = JSON.parse(psql(container, database, `BEGIN; ${seed}
        UPDATE public.contact_submissions SET metadata=jsonb_set(metadata,
          '{acquisitionCommand,updatedAt}', ${literal(JSON.stringify(commandAt))}::jsonb);
        UPDATE public.deal_hunter_dispositions SET dismissed_at=${dismissedAt === null ? 'NULL' : literal(dismissedAt)};
        SET LOCAL ROLE service_role; SELECT ${rpc()}; ROLLBACK;`).stdout.trim());
      assert.equal(projection.applied, true);
      assert.equal(projection.record.metadata.acquisitionCommand.pipelineStage, cleared ? undefined : 'passed');
    }
    const historical = psql(container, database, `BEGIN; ${seed}
      INSERT INTO public.deal_hunter_opportunity_scores
        (opportunity_id,scored_at,deal_key,name,state,fit_score,score_status,confidence,
         completeness_score,contradiction_count,missing_evidence_count,should_remove,high_fit,
         gate_count,score_fingerprint,engine_version,rules_version,profile_version,
         completeness_policy_version,current_triage_eligible)
        VALUES ('canonical-restore','${at}','score-only-key','Historical source','TX',80,'high-fit',
          'high',70,0,0,false,true,0,'synthetic','synthetic','synthetic','synthetic','synthetic',false);
      INSERT INTO public.deal_hunter_dispositions
        (id,deal_key,created_at,updated_at,disposition,reason,dismissed_at,created_by,updated_by)
        VALUES ('11111111-2222-4222-8222-111111111112','score-only-key','${at}','${at}',
          'dismissed','Retained historical reason','${at}','owner','owner');
      SET LOCAL ROLE service_role; SELECT ${rpc()}; RESET ROLE; SELECT ${snapshot}; ROLLBACK;`)
      .stdout.trim().split('\n').map(JSON.parse);
    assert.equal(historical[0].applied, true);
    assert.equal(historical[0].activity.metadata.restoredDispositionIds.length, 2);
    assert.ok(historical[1].dispositions.every((row) => row.disposition === 'restored'));
    const auditFailure = psql(container, database, `BEGIN; ${seed}
      CREATE FUNCTION public.synthetic_restore_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN RAISE EXCEPTION 'synthetic restore audit failure'; END; $f$;
      CREATE TRIGGER synthetic_restore_audit_failure BEFORE INSERT ON public.crm_activity_events
        FOR EACH ROW EXECUTE FUNCTION public.synthetic_restore_audit_failure();
      DO $do$ BEGIN
        BEGIN PERFORM ${rpc()}; RAISE EXCEPTION 'Expected audit failure was not raised';
        EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'synthetic restore audit failure' THEN RAISE; END IF; END;
      END $do$; SELECT ${snapshot}; ROLLBACK;`).stdout.trim();
    const rolledBack = JSON.parse(auditFailure);
    assert.equal(rolledBack.submission.status, 'archived');
    assert.equal(rolledBack.dispositions[0].disposition, 'dismissed');
    assert.equal(rolledBack.events.length, 0);
    for (const role of ['anon','authenticated']) {
      const denied = psql(container, database, `BEGIN; ${seed} SET LOCAL ROLE ${role}; SELECT ${rpc()};`, true);
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /permission denied for function/);
    }
    // Actual concurrent writer: hold alias ownership uncommitted, then prove
    // Restore waits for that writer and rejects its newly committed foreign key.
    const writer = asyncPsql(container, database, `BEGIN; ${seed}
      INSERT INTO public.deal_hunter_opportunities
        (opportunity_id,created_at,updated_at,canonical_name,identity_version,status)
        VALUES ('foreign','${at}','${at}','Different business','synthetic','active');
      UPDATE public.deal_hunter_opportunity_aliases SET opportunity_id='foreign';
      SELECT 'fl02-writer-locked'; SELECT pg_sleep(5); COMMIT;`, true);
    await writer.marker;
    const restoring = asyncPsql(container, database, `SET application_name='fl02-restore-race';
      SET ROLE service_role; SELECT ${rpc()};`);
    let observedWait = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const blocked = psql(container, database, `SELECT count(*) FROM pg_stat_activity
        WHERE application_name='fl02-restore-race' AND wait_event_type='Lock';`).stdout.trim();
      if (Number(blocked) > 0) { observedWait = true; break; }
      await delay(25);
    }
    assert.equal(observedWait, true, 'Restore must wait for concurrent identity writers');
    await writer.completed;
    assert.equal(JSON.parse((await restoring.completed).trim()).applied, false);
    const raced = JSON.parse(psql(container, database, `SELECT ${snapshot};`).stdout.trim());
    assert.equal(raced.submission.status, 'archived');
    assert.equal(raced.dispositions[0].disposition, 'dismissed');
    assert.equal(raced.events.length, 0);
    psql(container, database, "UPDATE public.deal_hunter_opportunity_aliases SET opportunity_id='canonical-restore';");
    const staleSnapshot = asyncPsql(container, database, `BEGIN ISOLATION LEVEL REPEATABLE READ;
      SELECT count(*) FROM public.deal_hunter_opportunity_aliases;
      SELECT 'fl02-writer-locked'; SELECT pg_sleep(3);
      SET LOCAL ROLE service_role; SELECT ${rpc()}; COMMIT;`, true);
    await staleSnapshot.marker;
    psql(container, database, "UPDATE public.deal_hunter_opportunity_aliases SET opportunity_id='foreign';");
    await assert.rejects(staleSnapshot.completed, /requires read committed isolation/);
    const rejectedSnapshot = JSON.parse(psql(container, database, `SELECT ${snapshot};`).stdout.trim());
    assert.equal(rejectedSnapshot.submission.status, 'archived');
    assert.equal(rejectedSnapshot.dispositions[0].disposition, 'dismissed');
    assert.equal(rejectedSnapshot.events.length, 0);
    t.diagnostic(`${database}: coherent restore, repeat conflict, standalone, historical score,
      rollback, anonymous denial, preserved stopped authority, concurrent alias race and stale snapshot denial passed`);
  }
});

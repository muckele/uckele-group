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

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function psql(container, database, sql) {
  return run(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], sql).trim();
}

test('fresh and upgraded PostgreSQL preserve bounded freshness evidence and service-only access', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-fl01-schema-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  t.after(() => {
    if (started) run(dockerCommand, ['rm', '-f', container]);
  });
  run(dockerCommand, ['run', '--pull=never', '--network=none', '--name', container,
    '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16']);
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
    create database fl01_fresh;
    create database fl01_upgrade;
  `);
  const currentSchema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const previousSchema = execFileSync('git', ['show', '18a8645845be5c77c7422e0d20a49fa6003bef1b:supabase/schema.sql'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260923120000_deal_hunter_freshness_provenance.sql'), 'utf8');
  psql(container, 'fl01_fresh', currentSchema);
  psql(container, 'fl01_upgrade', previousSchema);
  psql(container, 'fl01_upgrade', migration);
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const catalog = psql(container, database, `
      select jsonb_build_object(
        'state', to_regclass('public.deal_hunter_source_freshness_state') is not null,
        'evidence', to_regclass('public.deal_hunter_freshness_evidence') is not null,
        'legacy', (select column_default from information_schema.columns where table_name='deal_hunter_opportunities' and column_name='discovery_state'),
        'rls', (select bool_and(relrowsecurity) from pg_class where oid in ('public.deal_hunter_source_freshness_state'::regclass, 'public.deal_hunter_freshness_evidence'::regclass)),
        'anon', has_table_privilege('anon', 'public.deal_hunter_freshness_evidence', 'SELECT'),
        'service', has_table_privilege('service_role', 'public.deal_hunter_freshness_evidence', 'SELECT')
      );
    `);
    const result = JSON.parse(catalog);
    assert.equal(result.state, true);
    assert.equal(result.evidence, true);
    assert.match(result.legacy, /untracked_legacy/);
    assert.equal(result.rls, true);
    assert.equal(result.anon, false);
    assert.equal(result.service, true);
    const legacy = JSON.parse(psql(container, database, `
      insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values ('legacy-fl01', now(), now(), 'Synthetic legacy', 'test')
      returning jsonb_build_object('state', discovery_state, 'first', first_accepted_at,
        'discoveryRevision', discovery_revision, 'materialRevision', material_revision);
    `));
    assert.deepEqual(legacy, { state: 'untracked_legacy', first: null, discoveryRevision: 0, materialRevision: 0 });
    psql(container, database, `
      insert into public.deal_hunter_freshness_evidence
        (id, source_id, source_name, source_record_id, run_id, generation, event_type)
      values ('e1','sheet-0','Sheet','row-1','run-1',1,'accepted_source_record');
    `);
    const duplicate = spawnSync(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], {
      cwd: root, encoding: 'utf8', input: `insert into public.deal_hunter_freshness_evidence (id,source_id,source_name,source_record_id,run_id,generation,event_type) values ('e2','sheet-0','Sheet','row-1','run-1',1,'accepted_source_record');`,
    });
    assert.notEqual(duplicate.status, 0, 'nullable canonical and field evidence must not bypass duplicate detection');
    const tamper = spawnSync(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], {
      cwd: root, encoding: 'utf8', input: `update public.deal_hunter_freshness_evidence set raw_value='tampered' where id='e1';`,
    });
    assert.notEqual(tamper.status, 0, 'accepted evidence must be immutable');
  }
});

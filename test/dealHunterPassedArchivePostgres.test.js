import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preSliceRevision = 'f863fe51eb40fb7a61b9b30ec4a8d45ef76a4844';
const integrationEnabled = process.env.DEAL_HUNTER_PASSED_ARCHIVE_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';

function run(command, args, input = undefined) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function psql(container, database, sql) {
  return run(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], sql).trim();
}

function archiveQuery(container, database, { view = 'dismissed', page = 1, pageSize = 25,
  search = '' } = {}) {
  const escapedSearch = search.replaceAll("'", "''");
  return JSON.parse(psql(container, database, `select public.list_deal_hunter_opportunity_scores(
    '${view}', ${page}, ${pageSize}, '${escapedSearch}', 'fit-score', 'desc',
    null::integer, '', '', '');`));
}

test('fresh and upgraded PostgreSQL keep ineligible owner Passes searchable from retained snapshots', {
  skip: integrationEnabled ? false
    : 'set DEAL_HUNTER_PASSED_ARCHIVE_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-fl02-archive-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  t.after(() => {
    if (started) run(dockerCommand, ['rm', '-f', container]);
  });
  run(dockerCommand, ['run', '--rm', '--pull=never', '--network=none',
    '--tmpfs', '/var/lib/postgresql/data', '--name', container,
    '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16']);
  started = true;

  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = spawnSync(dockerCommand, ['logs', container], { encoding: 'utf8' });
    const readyEvents = `${logs.stdout}\n${logs.stderr}`
      .match(/database system is ready to accept connections/g)?.length || 0;
    const ready = spawnSync(dockerCommand, ['exec', container, 'pg_isready', '-U', 'postgres'],
      { encoding: 'utf8' });
    if (readyEvents >= 2 && ready.status === 0) break;
    if (attempt === 99) throw new Error('Disposable PostgreSQL did not become ready.');
    Atomics.wait(signal, 0, 0, 100);
  }

  psql(container, 'postgres', `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create database fl02_archive_fresh;
    create database fl02_archive_upgrade;
  `);
  const currentSchema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const previousSchema = execFileSync('git', ['show', `${preSliceRevision}:supabase/schema.sql`], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const migration = fs.readFileSync(path.join(root,
    'supabase/migrations/20261012120000_deal_hunter_passed_archive.sql'), 'utf8');
  psql(container, 'fl02_archive_fresh', currentSchema);
  psql(container, 'fl02_archive_upgrade', previousSchema);
  psql(container, 'fl02_archive_upgrade', migration);

  for (const database of ['fl02_archive_fresh', 'fl02_archive_upgrade']) {
    psql(container, database, `
      insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version, status)
      values
        ('archive-main', now(), now(), 'Current renamed business', 'test', 'active'),
        ('archive-filler-a', now(), now(), 'Archive filler A', 'test', 'active'),
        ('archive-filler-b', now(), now(), 'Archive filler B', 'test', 'active'),
        ('inactive-undisposed', now(), now(), 'Inactive undisposed lead', 'test', 'active'),
        ('active-current', now(), now(), 'Current working lead', 'test', 'active');

      insert into public.deal_hunter_opportunity_scores
        (opportunity_id, scored_at, deal_key, name, state, listing_url, fit_score,
         score_status, confidence, completeness_score, contradiction_count,
         missing_evidence_count, should_remove, high_fit, gate_count, score_fingerprint,
         engine_version, rules_version, profile_version, completeness_policy_version,
         current_triage_eligible)
      values
        ('archive-main', now(), 'archive-main-key', 'Current renamed business', 'CA',
         'https://current.example/reimported', 90, 'high-fit', 'high', 90, 0, 0,
         false, true, 0, 'archive-main-fingerprint', 'test', 'test', 'test', 'test', false),
        ('archive-filler-a', now(), 'archive-filler-a-key', 'Archive filler A', 'WA',
         'https://current.example/filler-a', 80, 'watchlist', 'medium', 80, 0, 0,
         false, false, 0, 'archive-filler-a-fingerprint', 'test', 'test', 'test', 'test', false),
        ('archive-filler-b', now(), 'archive-filler-b-key', 'Archive filler B', 'OR',
         'https://current.example/filler-b', 70, 'watchlist', 'medium', 70, 0, 0,
         false, false, 0, 'archive-filler-b-fingerprint', 'test', 'test', 'test', 'test', false),
        ('inactive-undisposed', now(), 'inactive-undisposed-key', 'Inactive undisposed lead', 'NV',
         'https://current.example/inactive-undisposed', 95, 'high-fit', 'high', 95, 0, 0,
         false, true, 0, 'inactive-undisposed-fingerprint', 'test', 'test', 'test', 'test', false),
        ('active-current', now(), 'active-current-key', 'Current working lead', 'CA',
         'https://current.example/working', 60, 'watchlist', 'medium', 60, 0, 0,
         false, false, 0, 'active-current-fingerprint', 'test', 'test', 'test', 'test', true);

      insert into public.deal_hunter_dispositions
        (id, deal_key, listing_url, deal_name, created_at, updated_at, disposition,
         reason, note, dismissed_at, dismissed_by, created_by, updated_by)
      values
        ('00000000-0000-4000-8000-000000000001', 'archive-main-key',
         'https://archive.example/original-listing', 'Archived Original Services',
         now(), now(), 'dismissed', 'valuation', 'Price exceeded approved range.',
         '2026-08-16T11:00:00Z', 'owner@example.test', 'owner@example.test', 'owner@example.test'),
        ('00000000-0000-4000-8000-000000000002', 'archive-filler-a-key',
         'https://archive.example/filler-a', 'Archive filler A', now(), now(),
         'dismissed', 'geography', 'Outside geography.', '2026-08-15T11:00:00Z',
         'owner@example.test', 'owner@example.test', 'owner@example.test'),
        ('00000000-0000-4000-8000-000000000003', 'archive-filler-b-key',
         'https://archive.example/filler-b', 'Archive filler B', now(), now(),
         'dismissed', 'timing', 'Review later.', '2026-08-14T11:00:00Z',
         'owner@example.test', 'owner@example.test', 'owner@example.test');
    `);

    for (const search of ['Archived Original Services', 'Current renamed business',
      'archive-main-key', 'archive.example/original-listing', 'current.example/reimported',
      'valuation', 'exceeded approved']) {
      const result = archiveQuery(container, database, { search });
      assert.equal(result.total, 1, `${database} search ${search}`);
      assert.equal(result.rows[0].opportunity_id, 'archive-main');
      assert.equal(result.rows[0].name, 'Archived Original Services');
      assert.equal(result.rows[0].listing_url, 'https://archive.example/original-listing');
      assert.equal(Object.hasOwn(result.rows[0], 'score_name'), false);
      assert.equal(Object.hasOwn(result.rows[0], 'score_listing_url'), false);
    }

    const firstPage = archiveQuery(container, database, { pageSize: 1 });
    const secondPage = archiveQuery(container, database, { page: 2, pageSize: 1 });
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.rows.length, 1);
    assert.equal(secondPage.rows.length, 1);
    assert.notEqual(firstPage.rows[0].opportunity_id, secondPage.rows[0].opportunity_id);

    const active = archiveQuery(container, database, { view: 'all' });
    assert.equal(active.total, 1);
    assert.deepEqual(active.rows.map((row) => row.opportunity_id), ['active-current']);
    assert.equal(active.summary.currentOpportunities, 1);
    assert.equal(active.summary.needsReview, 1);

    const privileges = JSON.parse(psql(container, database, `select jsonb_build_object(
      'anon', has_function_privilege('anon',
        'public.list_deal_hunter_opportunity_scores(text,integer,integer,text,text,text,integer,text,text,text)', 'EXECUTE'),
      'authenticated', has_function_privilege('authenticated',
        'public.list_deal_hunter_opportunity_scores(text,integer,integer,text,text,text,integer,text,text,text)', 'EXECUTE'),
      'service', has_function_privilege('service_role',
        'public.list_deal_hunter_opportunity_scores(text,integer,integer,text,text,text,integer,text,text,text)', 'EXECUTE')
    );`));
    assert.deepEqual(privileges, { anon: false, authenticated: false, service: true });
  }
});

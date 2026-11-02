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
  return run(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], sql).trim();
}

test('PostgreSQL inbox places 75+ rows into criteria areas on fresh and upgraded schemas', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, async (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-criteria-areas-${process.pid}-${randomUUID().slice(0, 8)}`;
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
    create database criteria_fresh;
    create database criteria_upgrade;
  `);
  const currentSchema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const previousSchema = execFileSync('git', ['show', `${schemaBeforeBestFirst}:supabase/schema.sql`],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const migration = fs.readFileSync(path.join(root,
    'supabase/migrations/20261102120000_best_first_deal_list.sql'), 'utf8');
  psql(container, 'criteria_fresh', currentSchema);
  psql(container, 'criteria_upgrade', previousSchema);
  psql(container, 'criteria_upgrade', migration);
  psql(container, 'criteria_upgrade', migration); // forward-only and re-runnable
  for (const database of ['criteria_fresh', 'criteria_upgrade']) {
    // Criteria areas: placement, exclusions, ordering, paging, and runner-owned blockers.
    const cases = [
      ['auto', 90, 'auto', 'uckele-criteria-v1', null, true],
      ['blocked', 91, 'auto', 'uckele-criteria-v1', 'generic_mailbox', true],
      ['stale', 92, 'auto', 'uckele-criteria-v0', null, true],
      ['unscored', 93, null, null, null, true],
      ['review-hi', 88, 'review', 'uckele-criteria-v1', null, true],
      ['review-lo', 80, 'review', 'uckele-criteria-v1', null, true],
      ['info', 85, 'needs-info', 'uckele-criteria-v1', null, true],
      ['miss', 86, 'near-miss', 'uckele-criteria-v1', null, true],
      ['below', 70, 'below-review', 'uckele-criteria-v1', null, true],
      ['stale-low', 70, 'review', 'uckele-criteria-v0', null, true],
      ['removed', 95, 'review', 'uckele-criteria-v1', null, true],
      ['dismissed', 96, 'review', 'uckele-criteria-v1', null, true],
      ['ineligible', 97, 'review', 'uckele-criteria-v1', null, false],
      // Enough extra review rows that your-review spans more than one page.
      ...Array.from({ length: 8 }, (_, index) => [`fill-${index}`, 76, 'review',
        'uckele-criteria-v1', null, true]),
    ];
    const criteriaId = (name) => `crit-${name}-${database}`;
    for (const [name, fit, group, version, blocker, eligible] of cases) {
      const id = criteriaId(name);
      const sqlText = (value) => (value === null ? 'null' : `'${value}'`);
      psql(container, database, `insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version)
        values ('${id}', now(), now(), 'Criteria ${name}', 'test');
        insert into public.deal_hunter_opportunity_scores
        (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
          score_fingerprint, engine_version, rules_version, profile_version,
          completeness_policy_version, current_triage_eligible, should_remove,
          criteria_group, criteria_profile_version, auto_pursue_blocker)
        values ('${id}', now(), '${id}', 'Criteria ${name}', ${fit}, 'high',
          'criteria-${name}', 'test', 'test', 'test', 'test', ${eligible},
          ${name === 'removed'}, ${sqlText(group)}, ${sqlText(version)}, ${sqlText(blocker)});`);
    }
    psql(container, database, `insert into public.deal_hunter_dispositions
      (id, deal_key, created_at, updated_at, disposition)
      values ('${randomUUID()}'::uuid, '${criteriaId('dismissed')}', now(), now(), 'dismissed');`);
    const areaRows = (area, offset = 0, limit = 100) => JSON.parse(psql(container, database,
      `select public.list_deal_hunter_fresh_inbox_v1('${area}', ${offset}, ${limit});`)).areas[0];
    const ours = (area) => areaRows(area).rows.map((row) => row.opportunity_id)
      .filter((id) => id.startsWith('crit-') && !id.startsWith('crit-fill-')).map((id) => id.replace(/^crit-|-criteria_(fresh|upgrade)$/g, ''));
    assert.deepEqual(ours('auto-pursue'), ['auto']);
    // 'your-review' also holds every older 75+ row with no criteria version.
    assert.deepEqual(ours('your-review'), ['unscored', 'stale', 'blocked', 'review-hi', 'review-lo']);
    assert.deepEqual(ours('needs-info'), ['info']);
    assert.deepEqual(ours('near-miss'), ['miss']);
    assert.deepEqual(['auto-pursue', 'your-review', 'needs-info', 'near-miss'].flatMap(ours)
      .filter((name) => ['below', 'stale-low', 'removed', 'dismissed', 'ineligible'].includes(name)), []);
    const defaultInbox = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('inbox');"));
    assert.deepEqual(defaultInbox.areas.map((area) => area.id),
      ['action-preview', 'auto-pursue', 'your-review', 'needs-info', 'near-miss']);
    assert.deepEqual(defaultInbox.areas.find((area) => area.id === 'auto-pursue').rows
      .map((row) => row.opportunity_id), [criteriaId('auto')]);
    assert.ok(defaultInbox.areas.find((area) => area.id === 'your-review').rows.length <= 10);
    const criteriaRow = areaRows('auto-pursue').rows[0];
    assert.equal(criteriaRow.criteria_group, 'auto');
    assert.equal(criteriaRow.criteria_profile_version, 'uckele-criteria-v1');
    assert.ok('auto_pursue_blocker' in criteriaRow && 'criteria_result' in criteriaRow);
    const firstReview = areaRows('your-review', 0, 5);
    const secondReview = areaRows('your-review', 5, 5);
    assert.equal(secondReview.anchorId, firstReview.lastId);
    assert.equal(new Set([...firstReview.rows, ...secondReview.rows]
      .map((row) => row.opportunity_id)).size, 10);
    const reviewRevision = areaRows('your-review').revision;
    psql(container, database, `update public.deal_hunter_opportunity_scores
      set auto_pursue_blocker = 'generic_mailbox' where opportunity_id = '${criteriaId('auto')}';`);
    assert.deepEqual(ours('auto-pursue'), []);
    assert.ok(ours('your-review').includes('auto'));
    assert.notEqual(areaRows('your-review').revision, reviewRevision,
      'a blocker change moves the revision so older cursors are refused');
    // The machine score write names its columns, so a rescore keeps runner-owned state.
    psql(container, database, `update public.deal_hunter_opportunity_scores
      set auto_pursue_checked_at = '2026-11-02T10:00:00Z' where opportunity_id = '${criteriaId('auto')}';
      select public.write_deal_hunter_opportunity_score(jsonb_build_object(
        'opportunity_id', '${criteriaId('auto')}', 'deal_key', '${criteriaId('auto')}',
        'fit_score', 91, 'confidence', 'high', 'score_fingerprint', 'criteria-auto-rescored',
        'engine_version', 'test', 'rules_version', 'test', 'profile_version', 'test',
        'completeness_policy_version', 'test', 'criteria_group', 'auto',
        'criteria_profile_version', 'uckele-criteria-v1'), '[]'::jsonb);`);
    assert.deepEqual(JSON.parse(psql(container, database, `select to_jsonb(scores) - 'summary'
      from public.deal_hunter_opportunity_scores as scores
      where opportunity_id = '${criteriaId('auto')}';`)).auto_pursue_blocker, 'generic_mailbox');
    assert.equal(psql(container, database, `select auto_pursue_checked_at from
      public.deal_hunter_opportunity_scores where opportunity_id = '${criteriaId('auto')}';`),
    '2026-11-02T10:00:00Z');
  }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(repositoryRoot, 'supabase/schema.sql');
const historicalMigrationPath = path.join(
  repositoryRoot,
  'supabase/migrations/20260814120000_deal_os_crm_reconciliation.sql',
);
const repairMigrationPath = path.join(
  repositoryRoot,
  'supabase/migrations/20260912120000_deal_os_crm_reconciliation_concurrency_idempotency.sql',
);
const parentCommit = '882fc552ced58dc4f6a5abb9d0516178a7f81b8f';
const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';
const fixtureAt = '2026-08-14T19:00:00.000Z';

function run(command, args, { input = undefined, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function docker(args, options = {}) {
  return run(dockerCommand, args, options);
}

function waitForPostgres(containerName) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = docker(['logs', containerName], { allowFailure: true });
    const readyEvents = `${logs.stdout}\n${logs.stderr}`
      .match(/database system is ready to accept connections/g)?.length || 0;
    const ready = docker(
      ['exec', containerName, 'pg_isready', '-U', 'postgres'],
      { allowFailure: true },
    );
    if (readyEvents >= 2 && ready.status === 0) return;
    Atomics.wait(signal, 0, 0, 100);
  }
  throw new Error('Disposable PostgreSQL did not become ready.');
}

function psql(containerName, database, sql, { allowFailure = false } = {}) {
  return docker([
    'exec', '-i', containerName,
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
  ], { input: sql, allowFailure });
}

function psqlAsync(containerName, database, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(dockerCommand, [
      'exec', '-i', containerName,
      'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
    ], { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, pid: child.pid }));
    child.stdin.end(sql);
  });
}

function quote(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function json(value) {
  return `${quote(JSON.stringify(value))}::jsonb`;
}

function parseJsonResult(result) {
  const output = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  return output ? JSON.parse(output) : null;
}

function postgresJson(containerName, database, sql) {
  return parseJsonResult(psql(containerName, database, sql));
}

function fixturePrefix(database, label) {
  return `${database.replaceAll('_', '-')}-${label}-${randomUUID().slice(0, 8)}`;
}

function seedOpportunity(containerName, database, label) {
  const opportunityId = fixturePrefix(database, `opportunity-${label}`);
  psql(containerName, database, `
    insert into public.deal_hunter_opportunities (
      opportunity_id, created_at, updated_at, canonical_name, canonical_recipient,
      canonical_location, primary_submission_id, identity_version, status, metadata
    ) values (
      ${quote(opportunityId)}, ${quote(fixtureAt)}::timestamptz,
      ${quote(fixtureAt)}::timestamptz, ${quote(`Synthetic ${label}`)},
      ${quote(`${label}@example.test`)}, 'Test City, CA', null,
      'deal-hunter-identity-v1', 'active', '{"fixture":true}'::jsonb
    );
  `);
  return opportunityId;
}

function seedSubmission(containerName, database, label) {
  const submissionId = randomUUID();
  psql(containerName, database, `
    insert into public.contact_submissions (
      id, created_at, updated_at, status, delivery_provider, delivery_status,
      crm_status, source, ip_hash, name, email, message, lead_type, metadata
    ) values (
      ${quote(submissionId)}::uuid, ${quote(fixtureAt)}::timestamptz,
      ${quote(fixtureAt)}::timestamptz, 'review', 'manual', 'not-applicable',
      'not-applicable', 'deal-hunter-reconciliation-postgres-test', '',
      ${quote(`Synthetic Contact ${label}`)}, ${quote(`${label}@example.test`)},
      'Synthetic reconciliation ownership fixture.', 'broker', '{"fixture":true}'::jsonb
    );
  `);
  return submissionId;
}

function seedDealOsImport(containerName, database, label) {
  const importId = randomUUID();
  psql(containerName, database, `
    insert into public.deal_hunter_deal_os_imports (
      id, created_at, imported_by, exported_at, file_name, file_type, file_size,
      file_sha256, scope, coverage_label, expected_row_count, row_count,
      duplicate_count, stable_id_count, listing_url_count, coverage_limit_reached,
      records, metadata, source_row_count, accepted_row_count, rejected_row_count,
      canonical_record_count, parser_version, row_accounting
    ) values (
      ${quote(importId)}::uuid, ${quote(fixtureAt)}::timestamptz,
      'postgres-integration-test', ${quote(fixtureAt)}::timestamptz,
      ${quote(`${label}.csv`)}, 'text/csv', 128, ${quote('a'.repeat(64))},
      'all-deals', 'synthetic-exact-import', 1, 1, 0, 1, 1, false,
      '[]'::jsonb, '{"fixture":true}'::jsonb, 1, 1, 0, 1,
      'deal-os-export-v1', '[{"sourceRowNumber":2,"status":"accepted"}]'::jsonb
    );
  `);
  return importId;
}

function insertCrmImport(containerName, database, {
  id,
  opportunityId,
  dealKey,
  listingIdentity,
}) {
  return psql(containerName, database, `
    insert into public.deal_hunter_crm_imports (
      id, created_at, updated_at, deal_key, listing_identity, listing_url,
      submission_id, status, source_name, metadata, opportunity_id
    ) values (
      ${quote(id)}, ${quote(fixtureAt)}::timestamptz, ${quote(fixtureAt)}::timestamptz,
      ${quote(dealKey)}, ${quote(listingIdentity)},
      ${quote(`https://example.test/${listingIdentity}`)}, null, 'completed',
      'deal-os-postgres-test', '{"fixture":true}'::jsonb, ${quote(opportunityId)}
    );
  `);
}

function reconciliationFixture(containerName, database, label) {
  const importId = seedDealOsImport(containerName, database, label);
  const opportunityId = seedOpportunity(containerName, database, label);
  const token = fixturePrefix(database, label);
  const run = {
    id: `run-${token}`,
    created_at: fixtureAt,
    updated_at: fixtureAt,
    completed_at: null,
    import_id: importId,
    mode: 'exact-import',
    plan_digest: `plan-${token}`,
    idempotency_key: `deal-os-crm-reconciliation:${importId}:plan-${token}`,
    status: 'running',
    requested_by: 'postgres-integration-test',
    counts: {
      canonicalRecords: 1,
      create: 1,
      update: 0,
      unchanged: 0,
      ambiguous: 0,
    },
    plan: {
      confirmationRequired: 'RECONCILE 1 CANONICAL',
      expectedOpportunityIds: [opportunityId],
    },
    results: {},
    last_error: null,
    metadata: {
      scoringRuleVersion: 'deal-hunter-fit-v2',
      fixture: true,
    },
  };
  const item = {
    id: `item-${token}`,
    run_id: run.id,
    opportunity_id: opportunityId,
    deal_key: `deal-${token}`,
    action: 'create',
    status: 'pending',
    submission_id: null,
    source_row_numbers: [2],
    planned_changes: { changedFields: ['name'], actionable: true },
    error: null,
    created_at: fixtureAt,
    updated_at: fixtureAt,
    metadata: { fixture: true },
  };
  return { importId, opportunityId, run, item };
}

function startStatement({ run, item, items = undefined }, { pause = false } = {}) {
  const submittedItems = items ?? [item];
  return `
    begin;
    set role service_role;
    ${pause ? 'select pg_sleep(0.2);' : ''}
    select to_jsonb(public.start_deal_hunter_crm_reconciliation(
      ${json(run)}, ${json(submittedItems)}
    ));
    commit;
  `;
}

function assertAuthorityConflict(containerName, database, fixture, label) {
  const rejected = psql(
    containerName,
    database,
    `\\set VERBOSITY verbose\n${startStatement(fixture)}`,
    { allowFailure: true },
  );
  assert.notEqual(rejected.status, 0, `${database}:${label}`);
  assert.match(
    rejected.stderr,
    /ERROR:\s+22023:\s+reconciliation authority conflict:/i,
    `${database}:${label}\n${rejected.stderr}`,
  );
}

function linkStatement(opportunityId, submissionId, { pause = false } = {}) {
  return `
    begin;
    set role service_role;
    ${pause ? 'select pg_sleep(0.2);' : ''}
    select to_jsonb(public.link_deal_hunter_crm_submission(
      ${quote(opportunityId)}, ${quote(submissionId)}::uuid,
      ${quote('2026-08-14T19:05:00.000Z')}::timestamptz
    ));
    commit;
  `;
}

function assertCatalogAndPrivileges(containerName, database) {
  const catalog = postgresJson(containerName, database, `
    select jsonb_build_object(
      'importColumns', (
        select jsonb_agg(column_name order by column_name)
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'deal_hunter_deal_os_imports'
          and column_name = any(array[
            'source_row_count', 'accepted_row_count', 'rejected_row_count',
            'canonical_record_count', 'parser_version', 'row_accounting'
          ]::text[])
      ),
      'contactOpportunityColumn', exists(
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'contact_submissions'
          and column_name = 'deal_hunter_opportunity_id'
      ),
      'runsTable', to_regclass('public.deal_hunter_crm_reconciliation_runs') is not null,
      'itemsTable', to_regclass('public.deal_hunter_crm_reconciliation_items') is not null,
      'startFunction', to_regprocedure(
        'public.start_deal_hunter_crm_reconciliation(jsonb,jsonb)'
      ) is not null,
      'linkFunction', to_regprocedure(
        'public.link_deal_hunter_crm_submission(text,uuid,timestamp with time zone)'
      ) is not null
    );
  `);
  assert.deepEqual(catalog.importColumns, [
    'accepted_row_count',
    'canonical_record_count',
    'parser_version',
    'rejected_row_count',
    'row_accounting',
    'source_row_count',
  ], database);
  assert.equal(catalog.contactOpportunityColumn, true, database);
  assert.equal(catalog.runsTable, true, database);
  assert.equal(catalog.itemsTable, true, database);
  assert.equal(catalog.startFunction, true, database);
  assert.equal(catalog.linkFunction, true, database);

  const indexes = postgresJson(containerName, database, `
    select jsonb_object_agg(indexname, indexdef)
    from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'idx_deal_hunter_crm_imports_unique_opportunity',
        'idx_contact_submissions_deal_hunter_opportunity'
      );
  `);
  assert.deepEqual(Object.keys(indexes).sort(), [
    'idx_contact_submissions_deal_hunter_opportunity',
    'idx_deal_hunter_crm_imports_unique_opportunity',
  ], database);
  assert.match(
    indexes.idx_deal_hunter_crm_imports_unique_opportunity,
    /create unique index[^]+\(opportunity_id\)[^]+where[^]+opportunity_id is not null[^]+opportunity_id <> ''/i,
    database,
  );
  assert.match(
    indexes.idx_contact_submissions_deal_hunter_opportunity,
    /create unique index[^]+\(deal_hunter_opportunity_id\)[^]+where[^]+deal_hunter_opportunity_id is not null[^]+deal_hunter_opportunity_id <> ''/i,
    database,
  );

  const rls = postgresJson(containerName, database, `
    select jsonb_object_agg(relname, relrowsecurity)
    from pg_class
    where oid in (
      'public.deal_hunter_crm_reconciliation_runs'::regclass,
      'public.deal_hunter_crm_reconciliation_items'::regclass
    );
  `);
  assert.deepEqual(rls, {
    deal_hunter_crm_reconciliation_items: true,
    deal_hunter_crm_reconciliation_runs: true,
  }, database);

  const expected = {
    anon: { canStart: false, canLink: false, runs: false, items: false },
    authenticated: { canStart: false, canLink: false, runs: false, items: false },
    service_role: { canStart: true, canLink: true, runs: true, items: true },
  };
  for (const [role, privileges] of Object.entries(expected)) {
    const actual = postgresJson(containerName, database, `
      select jsonb_build_object(
        'canStart', has_function_privilege(
          ${quote(role)},
          'public.start_deal_hunter_crm_reconciliation(jsonb,jsonb)',
          'EXECUTE'
        ),
        'canLink', has_function_privilege(
          ${quote(role)},
          'public.link_deal_hunter_crm_submission(text,uuid,timestamp with time zone)',
          'EXECUTE'
        ),
        'runs',
          has_table_privilege(${quote(role)}, 'public.deal_hunter_crm_reconciliation_runs', 'SELECT')
          and has_table_privilege(${quote(role)}, 'public.deal_hunter_crm_reconciliation_runs', 'INSERT')
          and has_table_privilege(${quote(role)}, 'public.deal_hunter_crm_reconciliation_runs', 'UPDATE')
          and has_table_privilege(${quote(role)}, 'public.deal_hunter_crm_reconciliation_runs', 'DELETE'),
        'items',
          has_table_privilege(${quote(role)}, 'public.deal_hunter_crm_reconciliation_items', 'SELECT')
          and has_table_privilege(${quote(role)}, 'public.deal_hunter_crm_reconciliation_items', 'INSERT')
          and has_table_privilege(${quote(role)}, 'public.deal_hunter_crm_reconciliation_items', 'UPDATE')
          and has_table_privilege(${quote(role)}, 'public.deal_hunter_crm_reconciliation_items', 'DELETE')
      );
    `);
    assert.deepEqual(actual, privileges, `${database}:${role}`);
  }
}

test('real PostgreSQL enforces Deal OS CRM reconciliation ownership and idempotency', {
  skip: integrationEnabled
    ? false
    : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for the required disposable PostgreSQL release gate',
  timeout: 180_000,
}, async (t) => {
  const dockerInfo = docker(['info'], { allowFailure: true });
  assert.equal(dockerInfo.status, 0, `Docker is required for this release gate.\n${dockerInfo.stderr}`);
  const localImage = docker(['image', 'inspect', 'postgres:16'], { allowFailure: true });
  assert.equal(
    localImage.status,
    0,
    `The already-local postgres:16 image is required; this test never pulls.\n${localImage.stderr}`,
  );

  const containerName = `uckele-p5-reconciliation-${process.pid}-${randomUUID().slice(0, 8)}`;
  let containerStarted = false;
  t.after(() => {
    if (containerStarted) {
      const removed = docker(['rm', '-f', containerName], { allowFailure: true });
      assert.equal(removed.status, 0, `Failed to remove ${containerName}.\n${removed.stderr}`);
    }
    const remaining = docker([
      'ps', '-a', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}',
    ], { allowFailure: true });
    assert.equal(remaining.status, 0, remaining.stderr);
    assert.equal(remaining.stdout.trim(), '', `${containerName} remains after cleanup.`);
  });

  docker([
    'run', '--pull=never', '--network=none', '--name', containerName,
    '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16',
  ]);
  containerStarted = true;
  waitForPostgres(containerName);

  const schema = fs.readFileSync(schemaPath, 'utf8');
  const historicalMigration = fs.readFileSync(historicalMigrationPath, 'utf8');
  const repairMigration = fs.readFileSync(repairMigrationPath, 'utf8');
  const parentSchema = execFileSync('git', ['show', `${parentCommit}:supabase/schema.sql`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  psql(containerName, 'postgres', `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create database p5_reconciliation_fresh;
    create database p5_reconciliation_upgrade;
    create database p5_reconciliation_collision;
  `);
  const parityDatabases = ['p5_reconciliation_fresh', 'p5_reconciliation_upgrade'];

  await t.test('fresh and upgrade schemas expose the reconciliation catalog and privilege contract', () => {
    psql(containerName, 'p5_reconciliation_fresh', schema);
    psql(containerName, 'p5_reconciliation_upgrade', parentSchema);
    psql(containerName, 'p5_reconciliation_upgrade', historicalMigration);
    psql(containerName, 'p5_reconciliation_upgrade', repairMigration);
    for (const database of parityDatabases) {
      assertCatalogAndPrivileges(containerName, database);
    }
  });

  await t.test('fresh and upgrade schemas enforce one CRM import owner per canonical opportunity', () => {
    for (const database of parityDatabases) {
      const opportunityA = seedOpportunity(containerName, database, 'unique-a');
      const opportunityB = seedOpportunity(containerName, database, 'unique-b');
      const token = fixturePrefix(database, 'unique-import');
      insertCrmImport(containerName, database, {
        id: `${token}-a1`,
        opportunityId: opportunityA,
        dealKey: `${token}-deal-a1`,
        listingIdentity: `${token}-listing-a1`,
      });
      const duplicate = psql(containerName, database, `
        insert into public.deal_hunter_crm_imports (
          id, created_at, updated_at, deal_key, listing_identity, listing_url,
          submission_id, status, source_name, metadata, opportunity_id
        ) values (
          ${quote(`${token}-a2`)}, ${quote(fixtureAt)}::timestamptz,
          ${quote(fixtureAt)}::timestamptz, ${quote(`${token}-deal-a2`)},
          ${quote(`${token}-listing-a2`)}, ${quote(`https://example.test/${token}-a2`)},
          null, 'completed', 'deal-os-postgres-test', '{"fixture":true}'::jsonb,
          ${quote(opportunityA)}
        );
      `, { allowFailure: true });
      assert.notEqual(duplicate.status, 0, database);
      assert.match(duplicate.stderr, /idx_deal_hunter_crm_imports_unique_opportunity/i, database);
      assert.equal(Number(psql(containerName, database, `
        select count(*) from public.deal_hunter_crm_imports
        where opportunity_id = ${quote(opportunityA)};
      `).stdout.trim()), 1, database);
      insertCrmImport(containerName, database, {
        id: `${token}-b1`,
        opportunityId: opportunityB,
        dealKey: `${token}-deal-b1`,
        listingIdentity: `${token}-listing-b1`,
      });
      assert.equal(Number(psql(containerName, database, `
        select count(*) from public.deal_hunter_crm_imports
        where opportunity_id in (${quote(opportunityA)}, ${quote(opportunityB)});
      `).stdout.trim()), 2, database);
    }
  });

  await t.test('fresh and upgrade schemas durably start and replay reconciliation plans', async () => {
    for (const database of parityDatabases) {
      const fixture = reconciliationFixture(containerName, database, 'durable');
      const started = parseJsonResult(psql(containerName, database, startStatement(fixture)));
      assert.equal(started.id, fixture.run.id, database);
      assert.equal(started.import_id, fixture.importId, database);
      assert.equal(started.idempotency_key, fixture.run.idempotency_key, database);
      assert.equal(started.status, 'running', database);

      const replayed = parseJsonResult(psql(containerName, database, startStatement(fixture)));
      assert.equal(replayed.id, fixture.run.id, database);
      const durableCounts = postgresJson(containerName, database, `
        select jsonb_build_object(
          'runs', (
            select count(*) from public.deal_hunter_crm_reconciliation_runs
            where idempotency_key = ${quote(fixture.run.idempotency_key)}
          ),
          'items', (
            select count(*) from public.deal_hunter_crm_reconciliation_items
            where run_id = ${quote(fixture.run.id)}
              and opportunity_id = ${quote(fixture.opportunityId)}
          )
        );
      `);
      assert.deepEqual(durableCounts, { runs: 1, items: 1 }, database);

      const concurrentFixture = reconciliationFixture(containerName, database, 'concurrent-start');
      const concurrent = await Promise.all([
        psqlAsync(containerName, database, startStatement(concurrentFixture, { pause: true })),
        psqlAsync(containerName, database, startStatement(concurrentFixture, { pause: true })),
      ]);
      assert.equal(new Set(concurrent.map(({ pid }) => pid)).size, 2, database);
      assert.deepEqual(concurrent.map(({ status }) => status), [0, 0], database);
      const results = concurrent.map(parseJsonResult);
      assert.deepEqual(results.map(({ id }) => id), [
        concurrentFixture.run.id,
        concurrentFixture.run.id,
      ], database);
      const concurrentCounts = postgresJson(containerName, database, `
        select jsonb_build_object(
          'runs', (
            select count(*) from public.deal_hunter_crm_reconciliation_runs
            where idempotency_key = ${quote(concurrentFixture.run.idempotency_key)}
          ),
          'items', (
            select count(*) from public.deal_hunter_crm_reconciliation_items
            where run_id = ${quote(concurrentFixture.run.id)}
          )
        );
      `);
      assert.deepEqual(concurrentCounts, { runs: 1, items: 1 }, database);

      const progressedSubmissionId = seedSubmission(containerName, database, 'progressed-replay');
      psql(containerName, database, `
        update public.deal_hunter_crm_reconciliation_runs
        set status = 'completed-with-errors',
            results = '{"preserved":true}'::jsonb,
            last_error = 'preserved lifecycle error',
            updated_at = '2026-08-14T20:00:00.000Z'::timestamptz,
            completed_at = '2026-08-14T20:00:00.000Z'::timestamptz,
            counts = counts || '{"results":{"failed":1}}'::jsonb,
            requested_by = 'progressed-owner',
            metadata = metadata || '{"progressed":true}'::jsonb
        where id = ${quote(fixture.run.id)};
        update public.deal_hunter_crm_reconciliation_items
        set status = 'failed',
            submission_id = ${quote(progressedSubmissionId)}::uuid,
            error = 'preserved item error',
            updated_at = '2026-08-14T20:00:00.000Z'::timestamptz
        where id = ${quote(fixture.item.id)};
      `);
      const progressedReplay = parseJsonResult(psql(
        containerName,
        database,
        startStatement({
          ...fixture,
          run: {
            ...fixture.run,
            status: 'running',
            results: {},
            last_error: null,
            updated_at: '2026-08-14T21:00:00.000Z',
            completed_at: null,
            requested_by: 'replay-owner',
            metadata: { scoringRuleVersion: 'different-deployment-version' },
          },
          item: {
            ...fixture.item,
            status: 'pending',
            submission_id: null,
            error: null,
            updated_at: '2026-08-14T21:00:00.000Z',
          },
        }),
      ));
      assert.equal(progressedReplay.status, 'completed-with-errors', database);
      assert.deepEqual(progressedReplay.results, { preserved: true }, database);
      assert.equal(progressedReplay.last_error, 'preserved lifecycle error', database);
      assert.equal(progressedReplay.requested_by, 'progressed-owner', database);
      assert.equal(progressedReplay.metadata.progressed, true, database);
      const progressedItem = postgresJson(containerName, database, `
        select to_jsonb(item_row)
        from public.deal_hunter_crm_reconciliation_items as item_row
        where id = ${quote(fixture.item.id)};
      `);
      assert.equal(progressedItem.status, 'failed', database);
      assert.equal(progressedItem.submission_id, progressedSubmissionId, database);
      assert.equal(progressedItem.error, 'preserved item error', database);

      assertAuthorityConflict(containerName, database, {
        ...fixture,
        run: { ...fixture.run, idempotency_key: `${fixture.run.idempotency_key}:different` },
      }, 'same run ID with different idempotency key');
      assertAuthorityConflict(containerName, database, {
        ...fixture,
        run: { ...fixture.run, id: `${fixture.run.id}:different` },
        item: {
          ...fixture.item,
          id: `${fixture.item.id}:different`,
          run_id: `${fixture.run.id}:different`,
        },
      }, 'same idempotency key with different run ID');

      const differentImportId = seedDealOsImport(containerName, database, 'authority-import');
      for (const [label, runPatch] of [
        ['different import ID', { import_id: differentImportId }],
        ['different plan digest', { plan_digest: `${fixture.run.plan_digest}:different` }],
        ['different mode', { mode: 'different-mode' }],
        ['different plan', { plan: { ...fixture.run.plan, confirmationRequired: 'DIFFERENT' } }],
      ]) {
        assertAuthorityConflict(containerName, database, {
          ...fixture,
          run: { ...fixture.run, ...runPatch },
        }, label);
      }
      assertAuthorityConflict(containerName, database, {
        ...fixture,
        item: { ...fixture.item, action: 'update' },
      }, 'different immutable item authority');
      assertAuthorityConflict(containerName, database, {
        ...fixture,
        items: [],
      }, 'missing immutable item');
      assertAuthorityConflict(containerName, database, {
        ...fixture,
        items: [fixture.item, fixture.item],
      }, 'duplicate submitted item ID and opportunity ID');
      assertAuthorityConflict(containerName, database, {
        ...fixture,
        item: { ...fixture.item, run_id: `${fixture.run.id}:different` },
      }, 'submitted item run ID mismatch');

      const collidingItemFixture = reconciliationFixture(
        containerName,
        database,
        'item-identifier-collision',
      );
      assertAuthorityConflict(containerName, database, {
        ...collidingItemFixture,
        item: {
          ...collidingItemFixture.item,
          id: fixture.item.id,
        },
      }, 'item ID already belongs to another reconciliation run');
    }
  });

  await t.test('fresh and upgrade schemas enforce link idempotency and cross-owner rejection', () => {
    for (const database of parityDatabases) {
      const opportunityA = seedOpportunity(containerName, database, 'link-a');
      const opportunityB = seedOpportunity(containerName, database, 'link-b');
      const submission1 = seedSubmission(containerName, database, 'link-s1');
      const submission2 = seedSubmission(containerName, database, 'link-s2');

      const linked = parseJsonResult(psql(
        containerName,
        database,
        linkStatement(opportunityA, submission1),
      ));
      assert.equal(linked.opportunity_id, opportunityA, database);
      assert.equal(linked.primary_submission_id, submission1, database);
      const replayed = parseJsonResult(psql(
        containerName,
        database,
        linkStatement(opportunityA, submission1),
      ));
      assert.equal(replayed.primary_submission_id, submission1, database);

      const crossOwner = psql(
        containerName,
        database,
        linkStatement(opportunityB, submission1),
        { allowFailure: true },
      );
      assert.notEqual(crossOwner.status, 0, database);
      assert.match(
        crossOwner.stderr,
        /CRM submission already belongs to another canonical opportunity/i,
        database,
      );

      const secondSubmission = psql(
        containerName,
        database,
        linkStatement(opportunityA, submission2),
        { allowFailure: true },
      );
      assert.notEqual(secondSubmission.status, 0, database);
      assert.match(
        secondSubmission.stderr,
        /canonical opportunity (already owns another CRM submission|primary CRM ownership conflict)/i,
        database,
      );

      const ownership = postgresJson(containerName, database, `
        select jsonb_build_object(
          'aPrimary', (
            select primary_submission_id from public.deal_hunter_opportunities
            where opportunity_id = ${quote(opportunityA)}
          ),
          'bPrimary', (
            select primary_submission_id from public.deal_hunter_opportunities
            where opportunity_id = ${quote(opportunityB)}
          ),
          's1Owner', (
            select deal_hunter_opportunity_id from public.contact_submissions
            where id = ${quote(submission1)}::uuid
          ),
          's2Owner', (
            select deal_hunter_opportunity_id from public.contact_submissions
            where id = ${quote(submission2)}::uuid
          )
        );
      `);
      assert.deepEqual(ownership, {
        aPrimary: submission1,
        bPrimary: null,
        s1Owner: opportunityA,
        s2Owner: null,
      }, database);
    }
  });

  await t.test('fresh and upgrade schemas serialize concurrent canonical ownership', async () => {
    for (const database of parityDatabases) {
      const opportunity = seedOpportunity(containerName, database, 'concurrent-link');
      const submission3 = seedSubmission(containerName, database, 'concurrent-s3');
      const submission4 = seedSubmission(containerName, database, 'concurrent-s4');
      const concurrent = await Promise.all([
        psqlAsync(containerName, database, linkStatement(opportunity, submission3, { pause: true })),
        psqlAsync(containerName, database, linkStatement(opportunity, submission4, { pause: true })),
      ]);
      assert.equal(new Set(concurrent.map(({ pid }) => pid)).size, 2, database);
      assert.equal(concurrent.filter(({ status }) => status === 0).length, 1, database);
      assert.equal(concurrent.filter(({ status }) => status !== 0).length, 1, database);
      assert.match(
        concurrent.find(({ status }) => status !== 0).stderr,
        /canonical opportunity (already owns another CRM submission|primary CRM ownership conflict)/i,
        database,
      );

      const ownership = postgresJson(containerName, database, `
        select jsonb_build_object(
          'primarySubmissionId', (
            select primary_submission_id from public.deal_hunter_opportunities
            where opportunity_id = ${quote(opportunity)}
          ),
          'linkedSubmissionIds', coalesce((
            select jsonb_agg(id order by id)
            from public.contact_submissions
            where deal_hunter_opportunity_id = ${quote(opportunity)}
          ), '[]'::jsonb),
          'unownedSubmissionIds', coalesce((
            select jsonb_agg(id order by id)
            from public.contact_submissions
            where id in (${quote(submission3)}::uuid, ${quote(submission4)}::uuid)
              and deal_hunter_opportunity_id is null
          ), '[]'::jsonb)
        );
      `);
      assert.equal(ownership.linkedSubmissionIds.length, 1, database);
      assert.equal(ownership.unownedSubmissionIds.length, 1, database);
      assert.equal(ownership.primarySubmissionId, ownership.linkedSubmissionIds[0], database);
      assert.deepEqual(
        [...ownership.linkedSubmissionIds, ...ownership.unownedSubmissionIds].sort(),
        [submission3, submission4].sort(),
        database,
      );
    }
  });

  await t.test('the upgrade migration rejects ambiguous legacy CRM import ownership', () => {
    const database = 'p5_reconciliation_collision';
    psql(containerName, database, parentSchema);
    const opportunity = seedOpportunity(containerName, database, 'collision');
    const token = fixturePrefix(database, 'collision-import');
    insertCrmImport(containerName, database, {
      id: `${token}-one`,
      opportunityId: opportunity,
      dealKey: `${token}-deal-one`,
      listingIdentity: `${token}-listing-one`,
    });
    insertCrmImport(containerName, database, {
      id: `${token}-two`,
      opportunityId: opportunity,
      dealKey: `${token}-deal-two`,
      listingIdentity: `${token}-listing-two`,
    });
    assert.equal(Number(psql(containerName, database, `
      select count(*) from public.deal_hunter_crm_imports
      where opportunity_id = ${quote(opportunity)};
    `).stdout.trim()), 2);

    const failedMigration = psql(
      containerName,
      database,
      historicalMigration,
      { allowFailure: true },
    );
    assert.notEqual(failedMigration.status, 0);
    assert.match(
      failedMigration.stderr,
      /Duplicate deal_hunter_crm_imports opportunity ownership exists/i,
    );
    const postFailure = postgresJson(containerName, database, `
      select jsonb_build_object(
        'records', (
          select count(*) from public.deal_hunter_crm_imports
          where opportunity_id = ${quote(opportunity)}
        ),
        'uniqueIndexInstalled', to_regclass(
          'public.idx_deal_hunter_crm_imports_unique_opportunity'
        ) is not null
      );
    `);
    assert.deepEqual(postFailure, { records: 2, uniqueIndexInstalled: false });
  });
});

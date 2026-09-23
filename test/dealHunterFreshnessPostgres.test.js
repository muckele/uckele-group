import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } from '../server/services/dealHunterSourceSnapshotAdmission.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

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

function psqlConcurrent(container, database, sql) {
  return new Promise((resolve) => {
    const child = spawn(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(sql);
  });
}

test('fresh and upgraded PostgreSQL preserve bounded freshness evidence and service-only access', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, async (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-fl01-schema-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  t.after(() => {
    if (started) run(dockerCommand, ['rm', '-f', container]);
  });
  run(dockerCommand, ['run', '--rm', '--pull=never', '--network=none', '--tmpfs', '/var/lib/postgresql/data', '--name', container,
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
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const importedAt = '2026-09-23T12:00:00.000Z';
    const importIds = [];
    const sourceRows = (price) => [{ sourceRecordId: 'external:PG-FL01-1', eventOrdinal: 0,
      freshnessEvidence: { dateAdded: { rawHeader: 'Posted Date', rawValue: '2026-09-22', precision: 'date', offset: null, meaning: 'unknown' },
        annualProfit: null, annualRevenue: null, askingPrice: { rawHeader: 'Asking Price',
          rawValue: String(price), metric: 'asking_price', currency: 'USD', period: 'total' } } }];
    for (let generation = 1; generation <= 2; generation += 1) {
      const importId = randomUUID();
      importIds.push(importId);
      const record = {
        id: importId, created_at: importedAt, imported_by: 'synthetic-test', exported_at: importedAt,
        file_name: 'fl01.csv', file_type: 'text/csv', file_size: 100, file_sha256: 'a'.repeat(64),
        scope: 'saved-search', coverage_label: 'Synthetic', expected_row_count: 1,
        row_count: 1, source_row_count: 1, accepted_row_count: 1, rejected_row_count: 0,
        canonical_record_count: 1, parser_version: 'deal-os-export-v2', row_accounting: [{ sourceRowNumber: 2, status: 'accepted',
          listingIdentity: 'https://example.test/fl01' }],
        duplicate_count: 0, stable_id_count: 1, listing_url_count: 1, coverage_limit_reached: false,
        records: [{ stableId: 'PG-FL01-1', name: 'Synthetic', listingUrl: 'https://example.test/fl01' }], metadata: {},
      };
      const sqlQuote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
      const allocated = JSON.parse(psql(container, database, `select public.allocate_deal_hunter_source_generation('deal-os-export', '${importId}');`));
      assert.equal(allocated.generation, generation);
      const accepted = JSON.parse(psql(container, database, `select public.insert_deal_hunter_deal_os_import_freshness_v1(${sqlQuote(record)}, ${sqlQuote(sourceRows(generation === 1 ? 100 : 120))}, ${generation});`));
      assert.equal(accepted.freshness_projection_state, 'pending');
      const replay = JSON.parse(psql(container, database, `select public.insert_deal_hunter_deal_os_import_freshness_v1(${sqlQuote(record)}, ${sqlQuote(sourceRows(generation === 1 ? 100 : 120))}, ${generation});`));
      assert.equal(replay.id, accepted.id);
    }
    assert.equal(Number(psql(container, database, "select count(*) from public.deal_hunter_freshness_evidence where source_id='deal-os-export' and event_type='accepted_source_record' and field_key='';")), 2);
    const opportunityId = `pg-dos-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version, discovery_state)
      values ('${opportunityId}', now(), now(), 'Synthetic Deal OS', 'test', 'pending');`);
    const snapshot = (value, price) => ({
      opportunity_id: opportunityId, source_id: 'deal-os-export', source_name: 'SMB Deal OS export',
      source_record_id: 'external:PG-FL01-1', observations: [{
        id: `source-observation:${database}`, opportunity_id: opportunityId, source_id: 'deal-os-export',
        source_name: 'SMB Deal OS export', source_record_id: 'external:PG-FL01-1',
        field: 'name', value, observed_at: importedAt, created_at: importedAt, updated_at: importedAt,
      }, {
        id: `source-observation-price:${database}`, opportunity_id: opportunityId, source_id: 'deal-os-export',
        source_name: 'SMB Deal OS export', source_record_id: 'external:PG-FL01-1',
        field: 'asking_price', value: String(price), observed_at: importedAt, created_at: importedAt, updated_at: importedAt,
      }], freshness_evidence: sourceRows(price)[0].freshnessEvidence,
    });
    const quoteJson = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
    const historicalAcceptedAt = '2026-09-14T12:00:00.000Z';
    // Synthetic chronology only; the real acceptance trigger remains immutable.
    psql(container, database, `alter table public.deal_hunter_freshness_evidence
      disable trigger guard_deal_hunter_freshness_evidence;
      update public.deal_hunter_freshness_evidence set accepted_at='${historicalAcceptedAt}'
      where run_id='${importIds[0]}';
      alter table public.deal_hunter_freshness_evidence
      enable trigger guard_deal_hunter_freshness_evidence;`);
    const latest = JSON.parse(psql(container, database, `select public.bind_accepted_deal_hunter_freshness_v1(
      '${importIds[1]}'::uuid, '${opportunityId}', 'external:PG-FL01-1', 2,
      ${quoteJson(snapshot('Latest', 120))});`));
    assert.equal(latest.projectionState, 'accepted');
    const intermediate = JSON.parse(psql(container, database, `select jsonb_build_object(
      'first', first_accepted_at, 'state', discovery_state, 'revision', discovery_revision)
      from public.deal_hunter_opportunities where opportunity_id='${opportunityId}';`));
    assert.equal(new Date(intermediate.first).toISOString(), historicalAcceptedAt);
    assert.equal(intermediate.state, 'known_recovered');
    assert.equal(intermediate.revision, 1);
    psql(container, database, `insert into public.deal_hunter_opportunity_scores
      (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
        score_fingerprint, engine_version, rules_version, profile_version,
        completeness_policy_version, current_triage_eligible)
      values ('${opportunityId}', now(), '${opportunityId}', 'Synthetic Deal OS', 86, 'high',
        'bind-intermediate', 'test', 'test', 'test', 'test', true);`);
    const intermediateReader = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('all-active');"));
    assert.equal(intermediateReader.areas[0].rows.find((row) => row.opportunity_id === opportunityId).new_to_ug,
      false, 'the older accepted discovery is outside the seven-day window before A binds');
    const retrySql = `select public.bind_accepted_deal_hunter_freshness_v1(
      '${importIds[1]}'::uuid, '${opportunityId}', 'external:PG-FL01-1', 2,
      ${quoteJson(snapshot('Latest', 120))});`;
    const retries = await Promise.all([0, 1].map(() => psqlConcurrent(container, database, retrySql)));
    assert.ok(retries.every((result) => result.status === 0), JSON.stringify(retries));
    assert.equal(Number(psql(container, database, `select discovery_revision from public.deal_hunter_opportunities
      where opportunity_id='${opportunityId}';`)), 1);
    const older = JSON.parse(psql(container, database, `select public.bind_accepted_deal_hunter_freshness_v1(
      '${importIds[0]}'::uuid, '${opportunityId}', 'external:PG-FL01-1', 1,
      ${quoteJson(snapshot('Old', 100))});`));
    assert.equal(older.projectionState, 'superseded');
    assert.equal(psql(container, database, `select value from public.deal_hunter_opportunity_source_observations
      where opportunity_id='${opportunityId}' and source_id='deal-os-export' and field='name';`), 'Latest');
    assert.equal(psql(container, database, `select freshness_projection_state from public.deal_hunter_deal_os_imports
      where id='${importIds[0]}'::uuid;`), 'superseded');
    assert.equal(psql(container, database, `select discovery_state from public.deal_hunter_opportunities
      where opportunity_id='${opportunityId}';`), 'known_recovered');
    assert.deepEqual(JSON.parse(psql(container, database, `select jsonb_build_object('field', field_key,
      'value', after_value, 'metric', metric, 'currency', currency, 'period', period)
      from public.deal_hunter_freshness_evidence where run_id='${importIds[1]}'
      and event_type='accepted_source_record' and field_key='asking_price';`)),
    { field: 'asking_price', value: 120, metric: 'asking_price', currency: 'USD', period: 'total' });
    const failedId = randomUUID();
    const failedRun = JSON.parse(psql(container, database,
      `select public.allocate_deal_hunter_source_generation('deal-os-export', '${failedId}');`));
    const failedImport = {
      id: failedId, created_at: importedAt, imported_by: 'synthetic-test', exported_at: importedAt,
      file_name: 'rollback.csv', file_type: 'text/csv', file_size: 100, file_sha256: 'b'.repeat(64),
      scope: 'saved-search', coverage_label: 'Synthetic', expected_row_count: 2,
      row_count: 2, source_row_count: 2, accepted_row_count: 2, rejected_row_count: 0,
      canonical_record_count: 2, parser_version: 'deal-os-export-v2',
      row_accounting: [{ sourceRowNumber: 2, status: 'accepted' }, { sourceRowNumber: 3, status: 'accepted' }],
      duplicate_count: 0, stable_id_count: 2, listing_url_count: 2, coverage_limit_reached: false,
      records: [{ stableId: 'PG-ROLLBACK-1', name: 'Synthetic', listingUrl: 'https://example.test/rollback-1' },
        { stableId: 'PG-ROLLBACK-2', name: 'Synthetic', listingUrl: 'https://example.test/rollback-2' }], metadata: {},
    };
    const badRows = [{ sourceRecordId: 'external:PG-ROLLBACK-1', eventOrdinal: 0,
      freshnessEvidence: { dateAdded: null, annualProfit: null, annualRevenue: null, askingPrice: null } },
    { sourceRecordId: `external:${'X'.repeat(201)}`, eventOrdinal: 1,
      freshnessEvidence: { dateAdded: null, annualProfit: null, annualRevenue: null, askingPrice: null } }];
    const failedQuoteJson = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
    const failed = spawnSync(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], {
      cwd: root, encoding: 'utf8', input: `select public.insert_deal_hunter_deal_os_import_freshness_v1(
        ${failedQuoteJson(failedImport)}, ${failedQuoteJson(badRows)}, ${failedRun.generation});`,
    });
    assert.notEqual(failed.status, 0);
    assert.equal(Number(psql(container, database, `select count(*) from public.deal_hunter_deal_os_imports where id='${failedId}'::uuid;`)), 0);
    assert.equal(Number(psql(container, database, `select count(*) from public.deal_hunter_freshness_evidence where run_id='${failedId}';`)), 0);
    assert.equal(Number(psql(container, database, "select accepted_generation from public.deal_hunter_source_freshness_state where source_id='deal-os-export';")), 2);
    for (const [index, price] of [100, 120, 100].entries()) {
      const importId = randomUUID();
      const generation = index + 4;
      const record = { ...failedImport, id: importId, file_sha256: String(index + 1).repeat(64),
        expected_row_count: 1, row_count: 1, source_row_count: 1, accepted_row_count: 1,
        canonical_record_count: 1, row_accounting: [{ sourceRowNumber: 2, status: 'accepted' }],
        stable_id_count: 1, listing_url_count: 1,
        records: [{ stableId: 'PG-FL01-1', name: 'Synthetic', listingUrl: 'https://example.test/fl01' }] };
      const allocated = JSON.parse(psql(container, database,
        `select public.allocate_deal_hunter_source_generation('deal-os-export', '${importId}');`));
      assert.equal(allocated.generation, generation);
      psql(container, database, `select public.insert_deal_hunter_deal_os_import_freshness_v1(
        ${quoteJson(record)}, ${quoteJson(sourceRows(price))}, ${generation});`);
      const bound = JSON.parse(psql(container, database, `select public.bind_accepted_deal_hunter_freshness_v1(
        '${importId}'::uuid, '${opportunityId}', 'external:PG-FL01-1', ${generation},
        ${quoteJson(snapshot('Latest', price))});`));
      assert.equal(bound.projectionState, 'accepted');
      const transition = JSON.parse(psql(container, database, `select jsonb_build_object(
        'type', event_type, 'before', before_value, 'after', after_value,
        'revision', material_revision, 'beforeId', before_evidence_id is not null,
        'afterId', after_evidence_id is not null)
        from public.deal_hunter_freshness_evidence where run_id='${importId}'
        and field_key='asking_price' and event_type='material_change';`));
      assert.deepEqual(transition, { type: 'material_change', before: index % 2 === 0 ? 120 : 100,
        after: price, revision: index + 1, beforeId: true, afterId: true });
    }
    assert.equal(Number(psql(container, database, `select material_revision from public.deal_hunter_opportunities
      where opportunity_id='${opportunityId}';`)), 3);
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const opportunityId = `pg-ambiguous-${database}`;
    const sourceRecordId = 'external:PG-AMBIG';
    const importedAt = '2026-09-23T12:00:00.000Z';
    const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version, discovery_state)
      values ('${opportunityId}', now(), now(), 'Ambiguous listing', 'test', 'pending');`);
    const imports = [];
    for (const [index, listingUrl] of ['https://example.test/ambiguous-a',
      'https://example.test/ambiguous-b'].entries()) {
      const id = randomUUID();
      const run = JSON.parse(psql(container, database,
        `select public.allocate_deal_hunter_source_generation('deal-os-export', '${id}');`));
      const record = { id, created_at: importedAt, imported_by: 'synthetic-test',
        exported_at: importedAt, file_name: 'ambiguous.csv', file_type: 'text/csv',
        file_size: 100, file_sha256: String(index + 7).repeat(64), scope: 'saved-search',
        coverage_label: 'Synthetic', expected_row_count: 1, row_count: 1, source_row_count: 1,
        accepted_row_count: 1, rejected_row_count: 0, canonical_record_count: 1,
        parser_version: 'deal-os-export-v2', row_accounting: [{ sourceRowNumber: 2,
          status: 'accepted', listingIdentity: listingUrl }], duplicate_count: 0,
        stable_id_count: 1, listing_url_count: 1, coverage_limit_reached: false,
        records: [{ stableId: 'PG-AMBIG', name: 'Ambiguous listing', listingUrl }], metadata: {} };
      psql(container, database, `select public.insert_deal_hunter_deal_os_import_freshness_v1(
        ${quote(record)}, ${quote([{ sourceRecordId, eventOrdinal: 0,
          freshnessEvidence: {} }])}, ${run.generation});`);
      imports.push({ id, run });
    }
    psql(container, database, `alter table public.deal_hunter_freshness_evidence
      disable trigger guard_deal_hunter_freshness_evidence;
      update public.deal_hunter_freshness_evidence set accepted_at='2026-09-14T12:00:00.000Z'
      where run_id='${imports[0].id}';
      alter table public.deal_hunter_freshness_evidence
      enable trigger guard_deal_hunter_freshness_evidence;`);
    const snapshot = { opportunity_id: opportunityId, source_id: 'deal-os-export',
      source_name: 'SMB Deal OS export', source_record_id: sourceRecordId,
      observations: [{ id: `pg-ambiguous-observation-${database}`,
        opportunity_id: opportunityId, source_id: 'deal-os-export',
        source_name: 'SMB Deal OS export', source_record_id: sourceRecordId,
        field: 'name', value: 'Ambiguous listing', observed_at: importedAt,
        created_at: importedAt, updated_at: importedAt }] };
    psql(container, database, `select public.bind_accepted_deal_hunter_freshness_v1(
      '${imports[1].id}'::uuid, '${opportunityId}', '${sourceRecordId}',
      ${imports[1].run.generation}, ${quote(snapshot)});`);
    const uncertain = JSON.parse(psql(container, database, `select jsonb_build_object(
      'state', discovery_state, 'first', first_accepted_at) from public.deal_hunter_opportunities
      where opportunity_id='${opportunityId}';`));
    assert.deepEqual(uncertain, { state: 'pending', first: null });
    assert.equal(psql(container, database, `select coalesce(current_canonical_id, 'unbound')
      from public.deal_hunter_freshness_evidence where run_id='${imports[0].id}'
        and event_type='accepted_source_record' and field_key='';`), 'unbound');
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const opportunityId = `pg-sheet-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version, discovery_state)
      values ('${opportunityId}', now(), now(), 'Synthetic Sheet', 'test', 'pending');`);
    const runId = randomUUID();
    const run = JSON.parse(psql(container, database,
      `select public.allocate_deal_hunter_source_generation('sheet-0', '${runId}');`));
    const at = '2026-09-23T12:00:00.000Z';
    const sourceRecordId = 'external:SHEET-PG-1';
    const record = {
      opportunity_id: opportunityId, source_id: 'sheet-0', source_name: 'SMB Deal Hunter Google Sheet',
      source_record_id: sourceRecordId,
      observations: [{ id: `sheet-source-observation:${database}`, opportunity_id: opportunityId,
        source_id: 'sheet-0', source_name: 'SMB Deal Hunter Google Sheet', source_record_id: sourceRecordId,
        field: 'name', value: 'Synthetic Sheet', observed_at: at, created_at: at, updated_at: at }],
      freshness_evidence: { dateAdded: { rawHeader: 'Posted Date', rawValue: '2026-09-22',
        precision: 'date', offset: null, meaning: 'unknown' }, annualProfit: null, annualRevenue: null, askingPrice: null },
    };
    let captured;
    const result = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) { captured = value; } },
      reviewMode: 'full-backfill',
      sourceResult: { source: { id: 'sheet-0', required: true, fetched: true, sourceRowCount: 1,
        rowCount: 1, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-0', sourceName: 'SMB Deal Hunter Google Sheet',
        stableExternalId: true, id: 'SHEET-PG-1' }] },
      records: [record], run,
    });
    assert.equal(result.reconciled, true);
    const quoteText = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const accepted = JSON.parse(psql(container, database, `select public.accept_admitted_complete_google_sheet_freshness_v1(
      ${quoteText(JSON.stringify(captured.admission))}::jsonb,
      ${quoteText(JSON.stringify(captured.records))}
    );`));
    assert.equal(accepted.projectionState, 'accepted');
    const discovered = JSON.parse(psql(container, database, `select jsonb_build_object(
      'state', discovery_state, 'revision', discovery_revision, 'first', first_accepted_at,
      'evidenceId', first_discovery_evidence_id) from public.deal_hunter_opportunities
      where opportunity_id = '${opportunityId}';`));
    assert.equal(discovered.state, 'known_prospective');
    assert.equal(discovered.revision, 1);
    assert.ok(discovered.first && discovered.evidenceId);
    const currentEvidence = JSON.parse(psql(container, database, `select jsonb_build_object(
      'current', accepted_evidence_id, 'digest', evidence.record_digest,
      'field', observation.field) from public.deal_hunter_opportunity_source_observations as observation
      left join public.deal_hunter_freshness_evidence as evidence on evidence.id=observation.accepted_evidence_id
      where observation.source_id='sheet-0' limit 1;`));
    assert.ok(currentEvidence.current && currentEvidence.digest, JSON.stringify(currentEvidence));
    const secondRunId = randomUUID();
    const secondRun = JSON.parse(psql(container, database,
      `select public.allocate_deal_hunter_source_generation('sheet-0', '${secondRunId}');`));
    let secondCaptured;
    await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) { secondCaptured = value; } },
      reviewMode: 'full-backfill',
      sourceResult: { source: { id: 'sheet-0', required: true, fetched: true, sourceRowCount: 1,
        rowCount: 1, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-0', sourceName: 'SMB Deal Hunter Google Sheet',
        stableExternalId: true, id: 'SHEET-PG-1' }] },
      records: [{ ...record, observations: record.observations.map((observation) => ({
        ...observation, observed_at: '2026-09-23T13:00:00.000Z',
        updated_at: '2026-09-23T13:00:00.000Z',
      })) }], run: secondRun,
    });
    const noOp = JSON.parse(psql(container, database, `select public.accept_admitted_complete_google_sheet_freshness_v1(
      ${quoteText(JSON.stringify(secondCaptured.admission))}::jsonb,
      ${quoteText(JSON.stringify(secondCaptured.records))}
    );`));
    assert.equal(noOp.projectionState, 'accepted');
    const retained = JSON.parse(psql(container, database, `select jsonb_build_object(
      'first', first_accepted_at, 'evidenceId', first_discovery_evidence_id,
      'revision', discovery_revision) from public.deal_hunter_opportunities where opportunity_id='${opportunityId}';`));
    assert.deepEqual(retained, { first: discovered.first, evidenceId: discovered.evidenceId, revision: 1 });
    const sheetEvents = JSON.parse(psql(container, database, `select jsonb_agg(jsonb_build_object(
      'id', id, 'digest', record_digest, 'generation', generation) order by generation)
      from public.deal_hunter_freshness_evidence
      where source_id='sheet-0' and source_record_id='external:SHEET-PG-1'
        and event_type='accepted_source_record' and field_key='';`));
    assert.equal(sheetEvents.length, 1, JSON.stringify({ currentEvidence, sheetEvents }));
    const stale = spawnSync(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], {
      cwd: root, encoding: 'utf8', input: `select public.accept_admitted_complete_google_sheet_freshness_v1(
        ${quoteText(JSON.stringify(captured.admission))}::jsonb,
        ${quoteText(JSON.stringify(captured.records))});`,
    });
    assert.notEqual(stale.status, 0, 'an older once-accepted Sheet run is stale after a later acceptance');
    for (const [rawValue, expectedState] of [
      ['2026-09-22', 'valid'], ['2026-02-30', 'invalid'], ['2099-01-01', 'future'],
    ]) {
      const publicationRunId = randomUUID();
      const publicationRun = JSON.parse(psql(container, database,
        `select public.allocate_deal_hunter_source_generation('sheet-0', '${publicationRunId}');`));
      const publicationRecord = { ...record, freshness_evidence: {
        ...record.freshness_evidence, dateAdded: { rawHeader: 'Posted Date', rawValue,
          precision: 'date', offset: null, meaning: 'listing_publication' },
      } };
      let publicationCapture;
      await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
        storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) { publicationCapture = value; } },
        reviewMode: 'full-backfill', run: publicationRun,
        sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
          sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
        deals: [{ sourceId: 'sheet-0', sourceName: 'SMB Deal Hunter Google Sheet',
          stableExternalId: true, id: 'SHEET-PG-1' }] },
        records: [record],
      });
      // Direct service-role provider fixture: the runtime parser intentionally
      // emits unknown meaning until a real source contract is proven.
      const publicationText = JSON.stringify([publicationRecord]);
      const firstDigest = createHash('md5').update(publicationText).digest('hex');
      const syntheticAdmission = { ...publicationCapture.admission,
        freshness_digest: firstDigest + createHash('md5')
          .update(`${firstDigest}${publicationRun.runId}${publicationRun.generation}`).digest('hex') };
      psql(container, database, `select public.accept_admitted_complete_google_sheet_freshness_v1(
        ${quoteText(JSON.stringify(syntheticAdmission))}::jsonb,
        ${quoteText(publicationText)});`);
      const publication = JSON.parse(psql(container, database, `select jsonb_build_object(
        'state', publication_state, 'precision', publication_precision,
        'date', publication_date, 'meaning', publication_meaning)
        from public.deal_hunter_freshness_evidence where run_id='${publicationRunId}'
          and event_type='publication_evidence';`));
      assert.equal(publication.state, expectedState);
      assert.equal(publication.precision, 'date');
      assert.equal(publication.meaning, 'listing_publication');
      if (expectedState === 'valid') assert.equal(publication.date, '2026-09-22');
    }
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const opportunityId = `pg-mixed-r1-${database}`;
    const sourceId = 'sheet-8';
    const sourceName = 'Synthetic Sheet';
    const sourceRecordId = 'external:R1-PG';
    const at = '2026-09-23T12:00:00.000Z';
    const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    const observation = (value) => ({ id: `pg-r1-profit-${database}`,
      opportunity_id: opportunityId, source_id: sourceId, source_name: sourceName,
      source_record_id: sourceRecordId, field: 'annual_profit', value: String(value),
      observed_at: at, created_at: at, updated_at: at });
    const dateObservation = (value) => ({ id: `pg-r1-date-${database}`,
      opportunity_id: opportunityId, source_id: sourceId, source_name: sourceName,
      source_record_id: sourceRecordId, field: 'date_added', value,
      observed_at: at, created_at: at, updated_at: at });
    const record = (value, posted) => ({ opportunity_id: opportunityId, source_id: sourceId,
      source_name: sourceName, source_record_id: sourceRecordId,
      observations: [observation(value), dateObservation(posted)], freshness_evidence: {
        dateAdded: { rawHeader: 'Posted Date', rawValue: posted,
          precision: 'date', meaning: 'unknown' },
        annualProfit: { rawHeader: 'SDE', rawValue: String(value),
          metric: 'sde', currency: 'USD', period: 'annual' },
      } });
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version, discovery_state)
      values ('${opportunityId}', now(), now(), 'Mixed Sheet', 'test', 'pending');`);
    const adapter = createSupabaseStorage({ storage: { supabaseUrl: 'https://synthetic.invalid',
      supabaseServiceRoleKey: 'synthetic' } }, { client: { async rpc(name, args) {
      if (name === 'replace_deal_hunter_opportunity_source_observation_snapshot') {
        const data = JSON.parse(psql(container, database, `select coalesce(jsonb_agg(to_jsonb(value)),
          '[]'::jsonb) from public.replace_deal_hunter_opportunity_source_observation_snapshot(
          '${args.p_opportunity_id}', '${args.p_source_id}', '${args.p_source_name}',
          '${args.p_source_record_id}', ${quote(args.p_observations)}::jsonb) as value;`));
        return { data, error: null };
      }
      if (name === 'upsert_deal_hunter_opportunity_source_observation') {
        const data = JSON.parse(psql(container, database, `select to_jsonb(value)
          from public.upsert_deal_hunter_opportunity_source_observation(
          '${args.p_id}', '${args.p_opportunity_id}', '${args.p_source_id}',
          '${args.p_source_name}', '${args.p_source_record_id}', '${args.p_field}',
          '${args.p_value}', '${args.p_observed_at}'::timestamptz,
          '${args.p_created_at}'::timestamptz, '${args.p_updated_at}'::timestamptz) as value;`));
        return { data, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    } } });
    const accept = async (value, posted) => {
      const runId = randomUUID();
      const run = JSON.parse(psql(container, database,
        `select public.allocate_deal_hunter_source_generation('${sourceId}', '${runId}');`));
      let captured;
      await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
        storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(item) { captured = item; } },
        reviewMode: 'full-backfill', run,
        sourceResult: { source: { id: sourceId, required: true, fetched: true,
          sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
        deals: [{ sourceId, sourceName, stableExternalId: true, id: 'R1-PG' }] },
        records: [record(value, posted)],
      });
      return JSON.parse(psql(container, database, `select public.accept_admitted_complete_google_sheet_freshness_v1(
        ${quote(captured.admission)}::jsonb, ${quote(captured.records)});`));
    };
    await adapter.replaceDealHunterOpportunitySourceObservationSnapshot(record(100, '2026-09-22'));
    const pending = JSON.parse(psql(container, database, `select jsonb_build_object(
      'state', discovery_state, 'first', first_accepted_at) from public.deal_hunter_opportunities
      where opportunity_id='${opportunityId}';`));
    assert.deepEqual(pending, { state: 'pending', first: null });
    assert.equal((await accept(100, '2026-09-22')).projectionState, 'accepted');
    assert.equal(psql(container, database, `select discovery_state from public.deal_hunter_opportunities
      where opportunity_id='${opportunityId}';`), 'known_recovered');
    psql(container, database, `insert into public.deal_hunter_opportunity_scores
      (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
        score_fingerprint, engine_version, rules_version, profile_version,
        completeness_policy_version, current_triage_eligible)
      values ('${opportunityId}', now(), '${opportunityId}', 'Mixed Sheet', 82, 'high',
        'mixed-r1', 'test', 'test', 'test', 'test', true);`);
    const readerRow = () => JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('all-active');"))
      .areas[0].rows.find((row) => row.opportunity_id === opportunityId);
    assert.deepEqual(readerRow().annual_profit_evidence,
      { metric: 'sde', currency: 'USD', period: 'annual' });
    const current = () => JSON.parse(psql(container, database, `select jsonb_build_object(
      'value', value, 'accepted', accepted_evidence_id) from public.deal_hunter_opportunity_source_observations
      where opportunity_id='${opportunityId}' and field='annual_profit';`));
    assert.ok(current().accepted);
    await adapter.upsertDealHunterOpportunitySourceObservation(observation(110));
    assert.deepEqual(current(), { value: '110', accepted: null });
    await adapter.replaceDealHunterOpportunitySourceObservationSnapshot(record(120, '2026-09-23'));
    assert.deepEqual(current(), { value: '120', accepted: null });
    const publication = () => JSON.parse(psql(container, database, `select jsonb_build_object(
      'accepted', accepted_evidence_id, 'header', publication_raw_header)
      from public.deal_hunter_opportunity_source_observations
      where opportunity_id='${opportunityId}' and field='date_added';`));
    assert.deepEqual(publication(), { accepted: null, header: null });
    assert.equal(readerRow().annual_profit_evidence, null);
    assert.equal((await accept(120, '2026-09-23')).projectionState, 'accepted');
    assert.ok(current().accepted);
    assert.ok(publication().accepted);
    assert.equal(publication().header, 'Posted Date');
    assert.deepEqual(readerRow().annual_profit_evidence,
      { metric: 'sde', currency: 'USD', period: 'annual' });
    const transitions = () => JSON.parse(psql(container, database, `select coalesce(jsonb_agg(
      jsonb_build_array(before_value, after_value) order by accepted_at), '[]'::jsonb)
      from public.deal_hunter_freshness_evidence where source_id='${sourceId}'
        and field_key='annual_profit' and event_type='material_change';`));
    assert.deepEqual(transitions(), [[100, 120]]);
    const acceptedEvidenceId = current().accepted;
    await adapter.replaceDealHunterOpportunitySourceObservationSnapshot(record(120, '2026-09-23'));
    assert.equal(current().accepted, acceptedEvidenceId);
    assert.equal((await accept(120, '2026-09-23')).projectionState, 'accepted');
    assert.deepEqual(transitions(), [[100, 120]]);
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const resolvedDeferredId = `fl01-deferred-resolved-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version, discovery_state)
      values ('${resolvedDeferredId}', now(), now(), 'Already resolved', 'test', 'pending');`);
    psql(container, database, `insert into public.deal_hunter_identity_exceptions
      (id, created_at, updated_at, status, reason, evidence_version)
      values ('fl01-deferred-${database}', now(), now(), 'open', 'ambiguous', 'test');`);
    const runId = randomUUID();
    const allocated = JSON.parse(psql(container, database,
      `select public.allocate_deal_hunter_source_generation('sheet-1', '${runId}');`));
    const resolvedDeferredRecord = { opportunity_id: resolvedDeferredId, source_id: 'sheet-1',
      source_name: 'Synthetic Sheet', source_record_id: 'sheet-row:2',
      observations: [{ id: `fl01-deferred-resolved-observation-${database}`,
        opportunity_id: resolvedDeferredId, source_id: 'sheet-1', source_name: 'Synthetic Sheet',
        source_record_id: 'sheet-row:2', field: 'name', value: 'Already resolved',
        observed_at: '2026-09-23T12:00:00.000Z', created_at: '2026-09-23T12:00:00.000Z',
        updated_at: '2026-09-23T12:00:00.000Z' }], freshness_evidence: null };
    let captured;
    const admitted = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) { captured = value; } },
      reviewMode: 'full-backfill', run: allocated,
      sourceResult: { source: { id: 'sheet-1', required: true, fetched: true,
        sourceRowCount: 2, rowCount: 2, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-1', sourceName: 'Synthetic Sheet', stableExternalId: false,
        idFromSourceRowPosition: true, sourceRowId: '2' },
        { sourceId: 'sheet-1', sourceName: 'Synthetic Sheet', stableExternalId: false,
          idFromSourceRowPosition: true, sourceRowId: '3' }] },
      records: [resolvedDeferredRecord], unresolved: [{ source_record_id: 'sheet-row:3',
        identity_exception_id: `fl01-deferred-${database}`, freshness_evidence: {
          askingPrice: { rawHeader: 'Asking Price', rawValue: '100', metric: 'asking_price',
            currency: 'USD', period: 'total' },
        } }],
    });
    assert.equal(admitted.reconciled, true);
    const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    const result = JSON.parse(psql(container, database,
      `select public.accept_admitted_complete_google_sheet_freshness_v1(
        ${quote(captured.admission)}::jsonb,
        ${quote({ records: captured.records, unresolved: captured.unresolved })});`));
    assert.equal(result.projectionState, 'deferred');
    assert.equal(Number(psql(container, database, `select count(*) from public.deal_hunter_freshness_evidence
      where source_id='sheet-1' and run_id='${runId}' and identity_exception_id='fl01-deferred-${database}';`)), 2);
    assert.deepEqual(JSON.parse(psql(container, database, `select jsonb_build_object('field',field_key,
      'value',after_value,'metric',metric,'currency',currency,'period',period)
      from public.deal_hunter_freshness_evidence where run_id='${runId}' and field_key='asking_price';`)),
    { field: 'asking_price', value: 100, metric: 'asking_price', currency: 'USD', period: 'total' });
    assert.equal(Number(psql(container, database, "select count(*) from public.deal_hunter_opportunity_source_observations where source_id='sheet-1';")), 0);
    const resolvedDeferredProof = JSON.parse(psql(container, database, `select jsonb_build_object('id', id,
      'at', accepted_at) from public.deal_hunter_freshness_evidence
      where source_id='sheet-1' and run_id='${runId}' and source_record_id='sheet-row:2'
        and event_type='accepted_source_record' and field_key='';`));
    const proof = JSON.parse(psql(container, database, `select jsonb_build_object('id', id,
      'at', accepted_at) from public.deal_hunter_freshness_evidence
      where source_id='sheet-1' and run_id='${runId}' and source_record_id='sheet-row:3'
        and event_type='accepted_source_record' and field_key='';`));
    const opportunityId = `fl01-recovered-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version, discovery_state)
      values ('${opportunityId}', now(), now(), 'Resolved later', 'test', 'pending');
      update public.deal_hunter_identity_exceptions set status='resolved',
        metadata=jsonb_build_object('resolvedOpportunityId','${opportunityId}')
        where id='fl01-deferred-${database}';`);
    const resolvedRunId = randomUUID();
    const resolvedRun = JSON.parse(psql(container, database,
      `select public.allocate_deal_hunter_source_generation('sheet-1', '${resolvedRunId}');`));
    const at = '2026-09-23T12:00:00.000Z';
    const record = { opportunity_id: opportunityId, source_id: 'sheet-1', source_name: 'Synthetic Sheet',
      source_record_id: 'sheet-row:6', observations: [{
        id: `fl01-recovered-observation-${database}`, opportunity_id: opportunityId,
        source_id: 'sheet-1', source_name: 'Synthetic Sheet', source_record_id: 'sheet-row:6',
        field: 'name', value: 'Resolved later', observed_at: at, created_at: at, updated_at: at,
      }], freshness_evidence: null };
    let resolvedCapture;
    await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) { resolvedCapture = value; } },
      reviewMode: 'full-backfill', run: resolvedRun,
      sourceResult: { source: { id: 'sheet-1', required: true, fetched: true,
        sourceRowCount: 2, rowCount: 2, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-1', sourceName: 'Synthetic Sheet', stableExternalId: false,
        idFromSourceRowPosition: true, sourceRowId: '5' },
        { sourceId: 'sheet-1', sourceName: 'Synthetic Sheet', stableExternalId: false,
          idFromSourceRowPosition: true, sourceRowId: '6' }] },
      records: [{ ...resolvedDeferredRecord, source_record_id: 'sheet-row:5',
        observations: resolvedDeferredRecord.observations.map((observation) => ({ ...observation,
          source_record_id: 'sheet-row:5' })) }, record],
    });
    const resolvedResult = JSON.parse(psql(container, database,
      `select public.accept_admitted_complete_google_sheet_freshness_v1(
        ${quote(resolvedCapture.admission)}::jsonb, ${quote(resolvedCapture.records)});`));
    assert.equal(resolvedResult.projectionState, 'accepted');
    const recovered = JSON.parse(psql(container, database, `select jsonb_build_object(
      'first', first_accepted_at, 'evidenceId', first_discovery_evidence_id,
      'revision', discovery_revision, 'state', discovery_state) from public.deal_hunter_opportunities
      where opportunity_id='${opportunityId}';`));
    assert.equal(recovered.evidenceId, proof.id);
    assert.equal(recovered.first, proof.at);
    assert.equal(recovered.revision, 1);
    assert.equal(recovered.state, 'known_recovered');
    const alreadyResolved = JSON.parse(psql(container, database, `select jsonb_build_object(
      'first', first_accepted_at, 'evidenceId', first_discovery_evidence_id,
      'state', discovery_state) from public.deal_hunter_opportunities
      where opportunity_id='${resolvedDeferredId}';`));
    assert.deepEqual(alreadyResolved, { first: resolvedDeferredProof.at,
      evidenceId: resolvedDeferredProof.id, state: 'known_recovered' });
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const opportunityId = `fl01-price-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version, discovery_state)
      values ('${opportunityId}', now(), now(), 'Price transition', 'test', 'pending');`);
    const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    const at = '2026-09-23T12:00:00.000Z';
    for (const [index, value] of [100, 120, 100, 120].entries()) {
      const runId = randomUUID();
      const allocated = JSON.parse(psql(container, database,
        `select public.allocate_deal_hunter_source_generation('sheet-2', '${runId}');`));
      const record = { opportunity_id: opportunityId, source_id: 'sheet-2', source_name: 'Synthetic Sheet',
        source_record_id: 'external:PRICE-PG', observations: [{
          id: `fl01-price-observation-${database}`, opportunity_id: opportunityId,
          source_id: 'sheet-2', source_name: 'Synthetic Sheet', source_record_id: 'external:PRICE-PG',
          field: 'asking_price', value: String(value), observed_at: at, created_at: at, updated_at: at,
        }], freshness_evidence: { askingPrice: { rawHeader: 'Asking Price', rawValue: String(value),
          metric: 'asking_price', currency: 'USD', period: 'total' } } };
      let captured;
      await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
        storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(item) { captured = item; } },
        reviewMode: 'full-backfill', run: allocated,
        sourceResult: { source: { id: 'sheet-2', required: true, fetched: true,
          sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
        deals: [{ sourceId: 'sheet-2', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'PRICE-PG' }] },
        records: [record],
      });
      const accepted = JSON.parse(psql(container, database,
        `select public.accept_admitted_complete_google_sheet_freshness_v1(
          ${quote(captured.admission)}::jsonb, ${quote(captured.records)});`));
      assert.equal(accepted.projectionState, 'accepted', String(index));
    }
    const transitions = JSON.parse(psql(container, database, `select jsonb_agg(jsonb_build_object(
      'before', before_value, 'after', after_value, 'revision', material_revision,
      'beforeId', before_evidence_id, 'afterId', after_evidence_id) order by generation)
      from public.deal_hunter_freshness_evidence where source_id='sheet-2' and event_type='material_change';`));
    assert.deepEqual(transitions.map((event) => [Number(event.before), Number(event.after)]),
      [[100, 120], [120, 100], [100, 120]]);
    assert.deepEqual(transitions.map((event) => event.revision), [1, 2, 3]);
    assert.equal(transitions.every((event) => event.beforeId && event.afterId), true);
    psql(container, database, `insert into public.deal_hunter_opportunity_scores
      (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
        score_fingerprint, engine_version, rules_version, profile_version,
        completeness_policy_version, current_triage_eligible)
      values ('${opportunityId}', now(), '${opportunityId}', 'Price transition', 86, 'high',
        'price-evidence', 'test', 'test', 'test', 'test', true);`);
    const updatedPage = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('updated');"));
    const updatedRow = updatedPage.areas[0].rows.find((row) => row.opportunity_id === opportunityId);
    assert.deepEqual([Number(updatedRow.material_before_value), Number(updatedRow.material_after_value),
      updatedRow.material_field, updatedRow.material_currency], [100, 120, 'asking_price', 'USD']);
    assert.ok(updatedRow.latest_accepted_observation_at);
    assert.notEqual(updatedRow.latest_accepted_observation_at, at,
      'accepted time remains distinct from source observation time');
    const removalRunId = randomUUID();
    const removalRun = JSON.parse(psql(container, database,
      `select public.allocate_deal_hunter_source_generation('sheet-2', '${removalRunId}');`));
    const replacement = { opportunity_id: opportunityId, source_id: 'sheet-2', source_name: 'Synthetic Sheet',
      source_record_id: 'external:OTHER', observations: [{
        id: `fl01-other-observation-${database}`, opportunity_id: opportunityId,
        source_id: 'sheet-2', source_name: 'Synthetic Sheet', source_record_id: 'external:OTHER',
        field: 'name', value: 'Price transition', observed_at: at, created_at: at, updated_at: at,
      }], freshness_evidence: null };
    let removalCapture;
    await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(item) { removalCapture = item; } },
      reviewMode: 'full-backfill', run: removalRun,
      sourceResult: { source: { id: 'sheet-2', required: true, fetched: true,
        sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-2', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'OTHER' }] },
      records: [replacement],
    });
    psql(container, database, `select public.accept_admitted_complete_google_sheet_freshness_v1(
      ${quote(removalCapture.admission)}::jsonb, ${quote(removalCapture.records)});`);
    assert.equal(Number(psql(container, database, "select count(*) from public.deal_hunter_opportunity_source_observations where source_id='sheet-2' and field='asking_price';")), 0);
    assert.equal(Number(psql(container, database, "select count(*) from public.deal_hunter_freshness_evidence where source_id='sheet-2' and event_type='evidence_state_change' and classification='disappearance';")), 1);
    assert.equal(Number(psql(container, database, "select count(*) from public.deal_hunter_freshness_evidence where source_id='sheet-2' and event_type='material_change';")), 3);
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const opportunityId = `fl01-concurrent-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version, discovery_state)
      values ('${opportunityId}', now(), now(), 'Concurrent Sheet', 'test', 'pending');`);
    const at = '2026-09-23T12:00:00.000Z';
    const record = { opportunity_id: opportunityId, source_id: 'sheet-4', source_name: 'Synthetic Sheet',
      source_record_id: 'external:CONCURRENT', observations: [{
        id: `fl01-concurrent-observation-${database}`, opportunity_id: opportunityId,
        source_id: 'sheet-4', source_name: 'Synthetic Sheet', source_record_id: 'external:CONCURRENT',
        field: 'name', value: 'Concurrent Sheet', observed_at: at, created_at: at, updated_at: at,
      }], freshness_evidence: null };
    const captures = [];
    for (let index = 0; index < 2; index += 1) {
      const runId = randomUUID();
      const allocated = JSON.parse(psql(container, database,
        `select public.allocate_deal_hunter_source_generation('sheet-4', '${runId}');`));
      let capture;
      await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
        storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) { capture = value; } },
        reviewMode: 'full-backfill', run: allocated,
        sourceResult: { source: { id: 'sheet-4', required: true, fetched: true,
          sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
        deals: [{ sourceId: 'sheet-4', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'CONCURRENT' }] },
        records: [record],
      });
      captures.push(capture);
    }
    const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    const outcomes = await Promise.all(captures.map((capture) => psqlConcurrent(container, database,
      `select public.accept_admitted_complete_google_sheet_freshness_v1(
        ${quote(capture.admission)}::jsonb, ${quote(capture.records)});`)));
    assert.equal(outcomes.some((outcome) => outcome.status === 0), true, JSON.stringify(outcomes));
    assert.equal(Number(psql(container, database, "select accepted_generation from public.deal_hunter_source_freshness_state where source_id='sheet-4';")), 2);
    assert.equal(Number(psql(container, database, "select count(*) from public.deal_hunter_freshness_evidence where source_id='sheet-4' and event_type='accepted_source_record' and field_key='';")), 1);
    assert.equal(Number(psql(container, database, `select discovery_revision from public.deal_hunter_opportunities where opportunity_id='${opportunityId}';`)), 1);
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const runId = randomUUID();
    const run = JSON.parse(psql(container, database,
      `select public.allocate_deal_hunter_source_generation('sheet-5', '${runId}');`));
    const at = '2026-09-23T12:00:00.000Z';
    const record = { opportunity_id: 'legacy-fl01', source_id: 'sheet-5', source_name: 'Synthetic Sheet',
      source_record_id: 'external:LEGACY', observations: [{
        id: `fl01-legacy-observation-${database}`, opportunity_id: 'legacy-fl01',
        source_id: 'sheet-5', source_name: 'Synthetic Sheet', source_record_id: 'external:LEGACY',
        field: 'name', value: 'Synthetic legacy', observed_at: at, created_at: at, updated_at: at,
      }], freshness_evidence: null };
    let capture;
    await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) { capture = value; } },
      reviewMode: 'full-backfill', run,
      sourceResult: { source: { id: 'sheet-5', required: true, fetched: true,
        sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-5', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'LEGACY' }] },
      records: [record],
    });
    const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    psql(container, database, `select public.accept_admitted_complete_google_sheet_freshness_v1(
      ${quote(capture.admission)}::jsonb, ${quote(capture.records)});`);
    const legacy = JSON.parse(psql(container, database, `select jsonb_build_object(
      'state', discovery_state, 'first', first_accepted_at, 'revision', discovery_revision)
      from public.deal_hunter_opportunities where opportunity_id='legacy-fl01';`));
    assert.deepEqual(legacy, { state: 'untracked_legacy', first: null, revision: 0 });
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const freshId = `pg-sheet-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunity_scores
      (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
        score_fingerprint, engine_version, rules_version, profile_version,
        completeness_policy_version, current_triage_eligible)
      values ('${freshId}', now(), '${freshId}', 'Fresh unlinked', 86, 'high',
        'fresh-reader-fingerprint', 'test', 'test', 'test', 'test', true);`);
    for (let index = 0; index < 15; index += 1) {
      const id = `old-priority-${database}-${index}`;
      psql(container, database, `insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version)
        values ('${id}', now(), now(), 'Old priority', 'test');
        insert into public.deal_hunter_opportunity_scores
        (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
          score_fingerprint, engine_version, rules_version, profile_version,
          completeness_policy_version, current_triage_eligible, operator_priority)
        values ('${id}', now(), '${id}', 'Old priority', 90, 'high',
          'old-reader-fingerprint', 'test', 'test', 'test', 'test', true, 'high');`);
    }
    const inbox = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('inbox');"));
    assert.deepEqual(inbox.areas.map((area) => area.id), ['action-preview', 'new-important']);
    assert.equal(inbox.areas[0].counts.ownerPriority, 15);
    assert.equal(inbox.areas[0].rows.length, 3);
    assert.ok(inbox.areas[1].rows.some((row) => row.opportunity_id === freshId));
    const sorted = (sort, offset = 0, limit = 25) => JSON.parse(psql(container, database,
      `select public.list_deal_hunter_fresh_inbox_v1('all-active', ${offset}, ${limit},
        '', '', '', '', now(), '${sort}');`)).areas[0];
    const newest = sorted('newest-discovery');
    const highestFit = sorted('highest-fit');
    assert.ok(newest.rows.findIndex((row) => row.opportunity_id === freshId)
      < newest.rows.findIndex((row) => row.opportunity_id === `old-priority-${database}-0`));
    assert.equal(highestFit.rows[0].fit_score, 90);
    const firstFitPage = sorted('highest-fit', 0, 5);
    const secondFitPage = sorted('highest-fit', 5, 5);
    assert.equal(secondFitPage.anchorId, firstFitPage.lastId);
    assert.equal(new Set([...firstFitPage.rows, ...secondFitPage.rows]
      .map((row) => row.opportunity_id)).size, 10);
    assert.equal(inbox.areas[1].rows.find((row) => row.opportunity_id === freshId).primary_submission_id, null);
    const allPriorities = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('owner-priorities', 0, 10);"));
    assert.equal(allPriorities.areas[0].total, 15);
    assert.equal(allPriorities.areas[0].rows.length, 10);
    assert.equal(allPriorities.areas[0].nextOffset, 10);
    const morePriorities = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('owner-priorities', 10, 10);"));
    assert.equal(morePriorities.areas[0].anchorId, allPriorities.areas[0].lastId);
    assert.equal(morePriorities.areas[0].rows.length, 5);
    const priorityFreshId = `pg-priority-fresh-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version,
        discovery_state, first_accepted_at, discovery_revision)
      values ('${priorityFreshId}', now(), now(), 'Priority fresh', 'test',
        'known_prospective', now() - interval '1 day', 1);
      insert into public.deal_hunter_opportunity_scores
      (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
        score_fingerprint, engine_version, rules_version, profile_version,
        completeness_policy_version, current_triage_eligible, operator_priority)
      values ('${priorityFreshId}', now(), '${priorityFreshId}', 'Priority fresh',
        76, 'high', 'priority-fresh-reader-fingerprint', 'test', 'test', 'test',
        'test', true, 'high');`);
    const reordered = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('new-important');"));
    const newIds = reordered.areas[0].rows.map((row) => row.opportunity_id);
    assert.equal(newIds[0], priorityFreshId, 'owner priority wins within the same discovery group');
    assert.ok(newIds.includes(freshId), 'the unlinked fresh opportunity remains visible');
    for (let index = 0; index < 5; index += 1) {
      const id = `old-priority-${database}-${index}`;
      const submissionId = randomUUID();
      const marker = JSON.stringify({ manualFollowUp: { mode: 'operator-approved',
        version: 'deal-hunter-manual-follow-up-v1', maximumFollowUps: 5,
        cadencePolicy: 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1' } });
      psql(container, database, `insert into public.contact_submissions
        (id, created_at, updated_at, status, delivery_provider, delivery_status,
          crm_status, source, ip_hash, name, email, message)
        values ('${submissionId}'::uuid, now(), now(), 'active', 'synthetic', 'delivered',
          'not-synced', 'synthetic', 'hash', '${id}', 'broker@example.test', 'Synthetic');
        update public.deal_hunter_opportunities set primary_submission_id='${submissionId}'::uuid
          where opportunity_id='${id}';
        insert into public.deal_hunter_cim_requests
        (id, created_at, updated_at, opportunity_id, deal_key, recipient_email,
          status, next_follow_up_at, submission_id, request_state, delivery_state,
          follow_up_state, metadata)
        values ('due-${id}', now(), now(), '${id}', '${id}', 'broker@example.test',
          'sent', now() - interval '1 day' + interval '${index} minutes',
          '${submissionId}'::uuid, 'provider_accepted', 'accepted', 'scheduled',
          '${marker}'::jsonb);`);
    }
    const withDue = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('inbox');"));
    assert.equal(withDue.areas[0].counts.due, 5);
    assert.equal(withDue.areas[0].rows.length, 3);
    assert.equal(new Set(withDue.areas[0].rows.map((row) => row.opportunity_id)).size, 3);
    assert.deepEqual(withDue.areas[1].rows.map((row) => row.opportunity_id), newIds);
    const allDue = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('due-actions');"));
    assert.equal(allDue.areas[0].total, 5);
    const actionSubmissions = {};
    for (const kind of ['reply', 'materials', 'nda']) {
      const id = `pg-action-${kind}-${database}`;
      const submissionId = randomUUID();
      actionSubmissions[kind] = submissionId;
      psql(container, database, `insert into public.contact_submissions
        (id, created_at, updated_at, status, delivery_provider, delivery_status,
          crm_status, source, ip_hash, name, email, message)
        values ('${submissionId}'::uuid, now(), now(), 'active', 'synthetic', 'delivered',
          'not-synced', 'synthetic', 'hash', '${id}', 'broker@example.test', 'Synthetic');
        insert into public.deal_hunter_opportunities
        (opportunity_id, created_at, updated_at, canonical_name, identity_version,
          primary_submission_id) values ('${id}', now(), now(), '${id}', 'test', '${submissionId}'::uuid);
        insert into public.deal_hunter_opportunity_scores
        (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
          score_fingerprint, engine_version, rules_version, profile_version,
          completeness_policy_version, current_triage_eligible)
        values ('${id}', now(), '${id}', '${id}', 85, 'high',
          'action-test', 'test', 'test', 'test', 'test', true);`);
    }
    psql(container, database, `insert into public.crm_communications
      (id, submission_id, direction, channel, source, kind, occurred_at, created_at,
        updated_at, delivery_state) values ('pg-verified-reply-${database}',
        '${actionSubmissions.reply}'::uuid, 'inbound', 'email', 'resend-webhook',
        'broker-reply', now() - interval '3 days', now() - interval '3 days',
        now() - interval '3 days', 'replied');`);
    for (const [kind, requested] of [['materials', 'financials'], ['nda', 'nda']]) {
      const requestId = randomUUID();
      psql(container, database, `insert into public.secure_upload_requests
        (id, submission_id, created_at, updated_at, email, status, expires_at,
          last_uploaded_at, requested_documents) values ('${requestId}'::uuid,
          '${actionSubmissions[kind]}'::uuid, now() - interval '3 days',
          now() - interval '3 days', 'broker@example.test', 'completed',
          now() + interval '7 days', now() - interval '3 days',
          '[{"category":"${requested}"}]'::jsonb);`);
    }
    const historicalSubmission = randomUUID();
    const historicalId = `pg-action-nda-${database}`;
    const historicalMarker = JSON.stringify({ manualFollowUp: { mode: 'operator-approved',
      version: 'deal-hunter-manual-follow-up-v1', maximumFollowUps: 5,
      cadencePolicy: 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1' } });
    psql(container, database, `insert into public.contact_submissions
      (id, created_at, updated_at, status, delivery_provider, delivery_status,
        crm_status, source, ip_hash, name, email, message)
      values ('${historicalSubmission}'::uuid, now(), now(), 'active', 'synthetic', 'delivered',
        'not-synced', 'synthetic', 'hash', 'Historical', 'broker@example.test', 'Synthetic');
      insert into public.deal_hunter_cim_requests
      (id, created_at, updated_at, opportunity_id, deal_key, recipient_email,
        status, next_follow_up_at, submission_id, request_state, delivery_state,
        follow_up_state, metadata)
      values ('historical-${database}', now(), now(), '${historicalId}', '${historicalId}',
        'broker@example.test', 'sent', now() - interval '1 day',
        '${historicalSubmission}'::uuid, 'provider_accepted', 'accepted', 'scheduled',
        '${historicalMarker}'::jsonb);`);
    const actionPage = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('inbox');"));
    assert.deepEqual([actionPage.areas[0].counts.due, actionPage.areas[0].counts.overdue], [7, 5]);
    const actionList = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('due-actions');"));
    assert.equal(actionList.areas[0].total, 7);
    assert.deepEqual(actionList.areas[0].rows.filter((row) => row.action_reason !== 'due_follow_up')
      .map((row) => row.action_reason).sort(), ['broker_reply', 'materials_ready']);
    psql(container, database, `insert into public.crm_communications
      (id, submission_id, direction, channel, source, kind, occurred_at, created_at,
        updated_at, delivery_state) values ('pg-later-outbound-${database}',
        '${actionSubmissions.reply}'::uuid, 'outbound', 'email', 'manual', 'follow-up',
        now(), now(), now(), 'accepted');
      update public.contact_submissions set follow_up_state='completed'
        where id='${actionSubmissions.materials}'::uuid;`);
    const resolvedActions = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('due-actions');"));
    assert.equal(resolvedActions.areas[0].total, 5);
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const opportunityId = `pg-publication-${database}`;
    const at = '2026-09-23T12:00:00.000Z';
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version,
        discovery_state)
      values ('${opportunityId}', '${at}', '${at}', 'Supported publication',
        'synthetic-test', 'pending');
      insert into public.deal_hunter_opportunity_scores
      (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
        score_fingerprint, engine_version, rules_version, profile_version,
        completeness_policy_version, current_triage_eligible)
      values ('${opportunityId}', '${at}', '${opportunityId}', 'Supported publication',
        90, 'high', 'publication-score', 'test', 'test', 'test', 'test', true);`);
    const runId = randomUUID();
    const run = JSON.parse(psql(container, database,
      `select public.allocate_deal_hunter_source_generation('sheet-7', '${runId}');`));
    const record = { opportunity_id: opportunityId, source_id: 'sheet-7',
      source_name: 'Synthetic Sheet', source_record_id: 'external:PUB',
      observations: [{ id: `publication-observation-${database}`,
        opportunity_id: opportunityId, source_id: 'sheet-7', source_name: 'Synthetic Sheet',
        source_record_id: 'external:PUB', field: 'date_added', value: '2026-09-22',
        observed_at: at, created_at: at, updated_at: at }],
      freshness_evidence: { dateAdded: { rawHeader: 'Posted Date',
        rawValue: '2026-09-22', precision: 'date', offset: null,
        meaning: 'listing_publication' } } };
    let captured;
    await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) { captured = value; } },
      reviewMode: 'full-backfill', run,
      sourceResult: { source: { id: 'sheet-7', required: true, fetched: true,
        sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-7', sourceName: 'Synthetic Sheet',
        stableExternalId: true, id: 'PUB' }] }, records: [record],
    });
    const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    psql(container, database, `select public.accept_admitted_complete_google_sheet_freshness_v1(
      ${quote(captured.admission)}::jsonb, ${quote(captured.records)});`);
    const supported = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('new-important');"));
    const row = supported.areas[0].rows.find((item) => item.opportunity_id === opportunityId);
    assert.equal(row.discovery_group, 1);
    assert.equal(row.recently_listed, true);
    assert.equal(row.publication_precision, 'date');
    psql(container, database, `update public.deal_hunter_opportunities
      set first_accepted_at = '2026-09-23T18:00:00.000Z'
      where opportunity_id = '${opportunityId}';`);
    const boundaryRow = (area, asOf) => JSON.parse(psql(container, database,
      `select public.list_deal_hunter_fresh_inbox_v1('${area}', 0, 25,
        '', '', '', '', '${asOf}'::timestamptz);`)).areas[0].rows
      .find((item) => item.opportunity_id === opportunityId);
    assert.equal(boundaryRow('new-important', '2026-09-30T18:00:00.000Z')?.discovery_group, 1,
      'seven Pacific calendar days remains fresh');
    assert.equal(boundaryRow('new-important', '2026-10-01T18:00:00.000Z'), undefined,
      'eight Pacific calendar days is no longer New to UG');
    assert.equal(boundaryRow('all-active', '2026-10-22T18:00:00.000Z')?.recently_listed, true,
      'thirty Pacific calendar days remains Recently listed');
    assert.equal(boundaryRow('all-active', '2026-10-23T18:00:00.000Z')?.recently_listed, false,
      'thirty-one Pacific calendar days is no longer Recently listed');
    psql(container, database, `update public.deal_hunter_opportunity_scores
      set reviewed_discovery_revision=1 where opportunity_id='${opportunityId}';`);
    const reviewedRow = boundaryRow('all-active', '2026-09-23T18:00:00.000Z');
    assert.equal(reviewedRow.new_to_ug, false);
    assert.equal(reviewedRow.recently_listed, true);
    assert.equal(boundaryRow('new-important', '2026-09-23T18:00:00.000Z'), undefined);
    psql(container, database, `update public.deal_hunter_opportunity_scores
      set reviewed_discovery_revision=0 where opportunity_id='${opportunityId}';`);
    psql(container, database, `insert into public.deal_hunter_freshness_evidence
      (id, source_id, source_name, source_record_id, run_id, generation,
        event_type, current_canonical_id)
      values ('peer-core-${database}', 'synthetic-peer', 'Synthetic peer',
        'external:PEER', 'peer-run-${database}', 1, 'accepted_source_record',
        '${opportunityId}');
      insert into public.deal_hunter_freshness_evidence
      (id, source_id, source_name, source_record_id, run_id, generation,
        event_type, field_key, current_canonical_id, publication_meaning,
        publication_date, publication_precision, publication_state)
      values ('peer-date-${database}', 'synthetic-peer', 'Synthetic peer',
        'external:PEER', 'peer-run-${database}', 1, 'publication_evidence',
        'date_added', '${opportunityId}', 'listing_publication', '2026-09-20',
        'date', 'valid');
      insert into public.deal_hunter_opportunity_source_observations
      (id, opportunity_id, source_id, source_name, source_record_id, field,
        value, observed_at, created_at, updated_at, accepted_evidence_id)
      values ('peer-observation-${database}', '${opportunityId}', 'synthetic-peer',
        'Synthetic peer', 'external:PEER', 'date_added', '2026-09-20',
        '${at}', '${at}', '${at}', 'peer-core-${database}');`);
    const conflicted = JSON.parse(psql(container, database,
      "select public.list_deal_hunter_fresh_inbox_v1('new-important');"));
    const conflictRow = conflicted.areas[0].rows.find((item) => item.opportunity_id === opportunityId);
    assert.equal(conflictRow.discovery_group, 2);
    assert.equal(conflictRow.recently_listed, false);
    assert.equal(conflictRow.publication_distinct_count, 2);
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const opportunityId = `fl01-review-${database}`;
    const dealKey = `fl01-review-deal-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version,
        discovery_state, discovery_revision, material_revision)
      values ('${opportunityId}', now(), now(), 'Review CAS', 'test', 'known_prospective', 1, 0);
      insert into public.deal_hunter_opportunity_scores
      (opportunity_id, scored_at, deal_key, name, fit_score, score_fingerprint,
        engine_version, rules_version, profile_version, completeness_policy_version,
        current_triage_eligible)
      values ('${opportunityId}', now(), '${dealKey}', 'Review CAS', 90,
        'fl01-review-fingerprint', 'test', 'test', 'test', 'test', true);`);
    const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    const decision = { reviewed_at: '2026-09-23T12:00:00.000Z', reviewed_by: 'synthetic-test',
      reviewed_fingerprint: 'fl01-review-fingerprint', operator_updated_at: '2026-09-23T12:00:00.000Z' };
    const staleDecision = spawnSync(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], {
      cwd: root, encoding: 'utf8', input: `select public.set_deal_hunter_operator_decision_freshness_v1(
        '${opportunityId}', ${quote(decision)}::jsonb, 0, 0);`,
    });
    assert.notEqual(staleDecision.status, 0);
    assert.match(staleDecision.stderr, /FL01_STALE_REVIEW/);
    const reviewed = JSON.parse(psql(container, database, `select to_jsonb(
      public.set_deal_hunter_operator_decision_freshness_v1(
        '${opportunityId}', ${quote(decision)}::jsonb, 1, 0));`));
    assert.deepEqual([reviewed.reviewed_discovery_revision, reviewed.reviewed_material_revision], [1, 0]);
    psql(container, database, `update public.deal_hunter_opportunities set material_revision=1 where opportunity_id='${opportunityId}';`);
    const passCommand = { opportunity_id: opportunityId, reason: 'not-a-fit', actor: 'synthetic-test',
      occurred_at: '2026-09-23T12:00:00.000Z', disposition_id: randomUUID(),
      archive_activity_id: randomUUID(), triage_activity_id: randomUUID() };
    const stalePass = spawnSync(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], {
      cwd: root, encoding: 'utf8', input: `select public.pass_deal_hunter_opportunity_freshness_v1(
        ${quote(passCommand)}::jsonb, 1, 0);`,
    });
    assert.notEqual(stalePass.status, 0);
    assert.match(stalePass.stderr, /FL01_STALE_REVIEW/);
    assert.equal(Number(psql(container, database, `select count(*) from public.deal_hunter_dispositions where deal_key='${dealKey}';`)), 0);
    const passed = JSON.parse(psql(container, database, `select public.pass_deal_hunter_opportunity_freshness_v1(
      ${quote(passCommand)}::jsonb, 1, 1);`));
    assert.equal(passed.applied, true);
    const pair = JSON.parse(psql(container, database, `select jsonb_build_array(
      reviewed_discovery_revision, reviewed_material_revision)
      from public.deal_hunter_opportunity_scores where opportunity_id='${opportunityId}';`));
    assert.deepEqual(pair, [1, 1]);
  }
  for (const database of ['fl01_fresh', 'fl01_upgrade']) {
    const opportunityId = `fl01-conflict-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version, discovery_state)
      values ('${opportunityId}', now(), now(), 'Conflicting price', 'test', 'pending');`);
    const at = '2026-09-23T12:00:00.000Z';
    const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    const accept = async (value) => {
      const runId = randomUUID();
      const run = JSON.parse(psql(container, database,
        `select public.allocate_deal_hunter_source_generation('sheet-6', '${runId}');`));
      const record = { opportunity_id: opportunityId, source_id: 'sheet-6', source_name: 'Synthetic Sheet',
        source_record_id: 'external:CONFLICT', observations: [{
          id: `fl01-conflict-observation-${database}`, opportunity_id: opportunityId,
          source_id: 'sheet-6', source_name: 'Synthetic Sheet', source_record_id: 'external:CONFLICT',
          field: 'asking_price', value: String(value), observed_at: at, created_at: at, updated_at: at,
        }], freshness_evidence: { askingPrice: { rawHeader: 'Asking Price', rawValue: String(value),
          metric: 'asking_price', currency: 'USD', period: 'total' } } };
      let capture;
      await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
        storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(item) { capture = item; } },
        reviewMode: 'full-backfill', run,
        sourceResult: { source: { id: 'sheet-6', required: true, fetched: true,
          sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
        deals: [{ sourceId: 'sheet-6', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'CONFLICT' }] },
        records: [record],
      });
      psql(container, database, `select public.accept_admitted_complete_google_sheet_freshness_v1(
        ${quote(capture.admission)}::jsonb, ${quote(capture.records)});`);
      return runId;
    };
    await accept(100);
    psql(container, database, `insert into public.deal_hunter_opportunity_source_observations
      (id, opportunity_id, source_id, source_name, source_record_id, field, value,
        observed_at, created_at, updated_at)
      values ('competing-price-${database}', '${opportunityId}', 'deal-os-export',
        'Synthetic Deal OS', 'external:OTHER', 'asking_price', '90',
        '${at}', '${at}', '${at}');`);
    const secondRunId = await accept(120);
    assert.equal(Number(psql(container, database, `select count(*) from public.deal_hunter_freshness_evidence
      where source_id='sheet-6' and event_type='material_change';`)), 0);
    assert.equal(psql(container, database, `select classification from public.deal_hunter_freshness_evidence
      where run_id='${secondRunId}' and event_type='evidence_state_change';`), 'conflict');
    assert.equal(Number(psql(container, database, `select material_revision from public.deal_hunter_opportunities where opportunity_id='${opportunityId}';`)), 0);
  }
  {
    const database = 'fl01_fresh';
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      select 'perf-' || lpad(number::text, 5, '0'), now(), now(),
        'Synthetic perf ' || number, 'synthetic-perf'
      from generate_series(1, 10000) as number;
      insert into public.deal_hunter_opportunity_scores
      (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
        score_fingerprint, engine_version, rules_version, profile_version,
        completeness_policy_version, current_triage_eligible, operator_priority)
      select opportunity_id, now(), opportunity_id, canonical_name, 80, 'high',
        'synthetic-perf', 'test', 'test', 'test', 'test', true,
        case when right(opportunity_id, 1) = '0' then 'high' else 'normal' end
      from public.deal_hunter_opportunities where opportunity_id like 'perf-%';
      insert into public.deal_hunter_opportunity_source_observations
      (id, opportunity_id, source_id, source_name, source_record_id,
        field, value, observed_at, created_at, updated_at)
      select opportunity_id || ':' || fields.field, opportunity_id, 'synthetic-perf',
        'Synthetic perf', opportunity_id, fields.field, fields.value, now(), now(), now()
      from public.deal_hunter_opportunities
      cross join (values ('industry', 'Synthetic'), ('annual_profit', '100000'),
        ('asking_price', '500000')) as fields(field, value)
      where opportunity_id like 'perf-%';`);
    assert.equal(Number(psql(container, database,
      "select count(*) from public.deal_hunter_opportunity_source_observations where source_id='synthetic-perf';")), 30000);
    const plan = JSON.parse(psql(container, database,
      "explain (analyze, buffers, format json) select public.list_deal_hunter_fresh_inbox_v1('inbox');"));
    const baselineDurations = [];
    const durations = [];
    for (let index = 0; index < 10; index += 1) {
      let started = performance.now();
      psql(container, database, `select public.list_deal_hunter_opportunity_scores(
        'all', 1, 25, '', 'fit-score', 'desc', null, '', '', '');`);
      baselineDurations.push(performance.now() - started);
      started = performance.now();
      const response = JSON.parse(psql(container, database,
        "select public.list_deal_hunter_fresh_inbox_v1('inbox');"));
      durations.push(performance.now() - started);
      assert.ok(response.areas[1].rows.length >= 3 && response.areas[1].rows.length <= 10);
    }
    const sorted = durations.sort((left, right) => left - right);
    const baselineSorted = baselineDurations.sort((left, right) => left - right);
    process.stdout.write(`FL01_POSTGRES_PERF ${JSON.stringify({
      dataset: { scores: 10000, currentObservations: 30000 },
      explain: plan[0], baselineP50Ms: baselineSorted[4], baselineP95Ms: baselineSorted[9],
      p50Ms: sorted[4], p95Ms: sorted[9],
      dockerMemory: run(dockerCommand, ['stats', '--no-stream', '--format', '{{.MemUsage}}', container]).trim(),
    })}\n`);
  }
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } from '../server/services/dealHunterSourceSnapshotAdmission.js';

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
    const sourceRows = [{ sourceRecordId: 'external:PG-FL01-1', eventOrdinal: 0,
      freshnessEvidence: { dateAdded: { rawHeader: 'Posted Date', rawValue: '2026-09-22', precision: 'date', offset: null, meaning: 'unknown' },
        annualProfit: null, annualRevenue: null, askingPrice: null } }];
    for (let generation = 1; generation <= 2; generation += 1) {
      const importId = randomUUID();
      importIds.push(importId);
      const record = {
        id: importId, created_at: importedAt, imported_by: 'synthetic-test', exported_at: importedAt,
        file_name: 'fl01.csv', file_type: 'text/csv', file_size: 100, file_sha256: 'a'.repeat(64),
        scope: 'saved-search', coverage_label: 'Synthetic', expected_row_count: 1,
        row_count: 1, source_row_count: 1, accepted_row_count: 1, rejected_row_count: 0,
        canonical_record_count: 1, parser_version: 'deal-os-export-v2', row_accounting: [{ sourceRowNumber: 2, status: 'accepted' }],
        duplicate_count: 0, stable_id_count: 1, listing_url_count: 1, coverage_limit_reached: false,
        records: [{ stableId: 'PG-FL01-1', name: 'Synthetic', listingUrl: 'https://example.test/fl01' }], metadata: {},
      };
      const sqlQuote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
      const allocated = JSON.parse(psql(container, database, `select public.allocate_deal_hunter_source_generation('deal-os-export', '${importId}');`));
      assert.equal(allocated.generation, generation);
      const accepted = JSON.parse(psql(container, database, `select public.insert_deal_hunter_deal_os_import_freshness_v1(${sqlQuote(record)}, ${sqlQuote(sourceRows)}, ${generation});`));
      assert.equal(accepted.freshness_projection_state, 'pending');
      const replay = JSON.parse(psql(container, database, `select public.insert_deal_hunter_deal_os_import_freshness_v1(${sqlQuote(record)}, ${sqlQuote(sourceRows)}, ${generation});`));
      assert.equal(replay.id, accepted.id);
    }
    assert.equal(Number(psql(container, database, "select count(*) from public.deal_hunter_freshness_evidence where source_id='deal-os-export' and event_type='accepted_source_record' and field_key='';")), 2);
    const opportunityId = `pg-dos-${database}`;
    psql(container, database, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version, discovery_state)
      values ('${opportunityId}', now(), now(), 'Synthetic Deal OS', 'test', 'pending');`);
    const snapshot = (value) => ({
      opportunity_id: opportunityId, source_id: 'deal-os-export', source_name: 'SMB Deal OS export',
      source_record_id: 'external:PG-FL01-1', observations: [{
        id: `source-observation:${database}`, opportunity_id: opportunityId, source_id: 'deal-os-export',
        source_name: 'SMB Deal OS export', source_record_id: 'external:PG-FL01-1',
        field: 'name', value, observed_at: importedAt, created_at: importedAt, updated_at: importedAt,
      }], freshness_evidence: null,
    });
    const quoteJson = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
    const latest = JSON.parse(psql(container, database, `select public.bind_accepted_deal_hunter_freshness_v1(
      '${importIds[1]}'::uuid, '${opportunityId}', 'external:PG-FL01-1', 2,
      ${quoteJson(snapshot('Latest'))});`));
    assert.equal(latest.projectionState, 'accepted');
    const older = JSON.parse(psql(container, database, `select public.bind_accepted_deal_hunter_freshness_v1(
      '${importIds[0]}'::uuid, '${opportunityId}', 'external:PG-FL01-1', 1,
      ${quoteJson(snapshot('Old'))});`));
    assert.equal(older.projectionState, 'superseded');
    assert.equal(psql(container, database, `select value from public.deal_hunter_opportunity_source_observations
      where opportunity_id='${opportunityId}' and source_id='deal-os-export' and field='name';`), 'Latest');
    assert.equal(psql(container, database, `select freshness_projection_state from public.deal_hunter_deal_os_imports
      where id='${importIds[0]}'::uuid;`), 'superseded');
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
    psql(container, database, `insert into public.deal_hunter_identity_exceptions
      (id, created_at, updated_at, status, reason, evidence_version)
      values ('fl01-deferred-${database}', now(), now(), 'open', 'ambiguous', 'test');`);
    const runId = randomUUID();
    const allocated = JSON.parse(psql(container, database,
      `select public.allocate_deal_hunter_source_generation('sheet-1', '${runId}');`));
    let captured;
    const admitted = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) { captured = value; } },
      reviewMode: 'full-backfill', run: allocated,
      sourceResult: { source: { id: 'sheet-1', required: true, fetched: true,
        sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-1', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'UNRESOLVED' }] },
      records: [], unresolved: [{ source_record_id: 'external:UNRESOLVED',
        identity_exception_id: `fl01-deferred-${database}`, freshness_evidence: null }],
    });
    assert.equal(admitted.reconciled, true);
    const quote = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    const result = JSON.parse(psql(container, database,
      `select public.accept_admitted_complete_google_sheet_freshness_v1(
        ${quote(captured.admission)}::jsonb,
        ${quote({ records: captured.records, unresolved: captured.unresolved })});`));
    assert.equal(result.projectionState, 'deferred');
    assert.equal(Number(psql(container, database, `select count(*) from public.deal_hunter_freshness_evidence
      where source_id='sheet-1' and run_id='${runId}' and identity_exception_id='fl01-deferred-${database}';`)), 1);
    assert.equal(Number(psql(container, database, "select count(*) from public.deal_hunter_opportunity_source_observations where source_id='sheet-1';")), 0);
    const proof = JSON.parse(psql(container, database, `select jsonb_build_object('id', id,
      'at', accepted_at) from public.deal_hunter_freshness_evidence
      where source_id='sheet-1' and run_id='${runId}' and event_type='accepted_source_record';`));
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
      source_record_id: 'external:UNRESOLVED', observations: [{
        id: `fl01-recovered-observation-${database}`, opportunity_id: opportunityId,
        source_id: 'sheet-1', source_name: 'Synthetic Sheet', source_record_id: 'external:UNRESOLVED',
        field: 'name', value: 'Resolved later', observed_at: at, created_at: at, updated_at: at,
      }], freshness_evidence: null };
    let resolvedCapture;
    await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
      storage: { async replaceAdmittedCompleteGoogleSheetSourceSnapshot(value) { resolvedCapture = value; } },
      reviewMode: 'full-backfill', run: resolvedRun,
      sourceResult: { source: { id: 'sheet-1', required: true, fetched: true,
        sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
      deals: [{ sourceId: 'sheet-1', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'UNRESOLVED' }] },
      records: [record],
    });
    const resolvedResult = JSON.parse(psql(container, database,
      `select public.accept_admitted_complete_google_sheet_freshness_v1(
        ${quote(resolvedCapture.admission)}::jsonb, ${quote(resolvedCapture.records)});`));
    assert.equal(resolvedResult.projectionState, 'accepted');
    const recovered = JSON.parse(psql(container, database, `select jsonb_build_object(
      'first', first_accepted_at, 'evidenceId', first_discovery_evidence_id,
      'revision', discovery_revision) from public.deal_hunter_opportunities
      where opportunity_id='${opportunityId}';`));
    assert.equal(recovered.evidenceId, proof.id);
    assert.equal(recovered.first, proof.at);
    assert.equal(recovered.revision, 1);
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
});

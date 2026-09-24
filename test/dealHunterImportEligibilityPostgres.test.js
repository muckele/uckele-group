import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://example.invalid/eligibility-postgres-sheet.csv';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { collectScoredOpportunities, importDealOsExport } = await import('../server/services/dealHunter.js');
const { refreshOpportunityScores } = await import('../server/services/dealHunterScoreStore.js');

const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';

function docker(args, input) {
  const result = spawnSync(dockerCommand, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${dockerCommand} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function psql(container, sql, database = 'eligibility_test') {
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', database], sql);
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function pgEligibility(container) {
  return JSON.parse(psql(container, `select coalesce(jsonb_object_agg(opportunity_id,
    jsonb_build_object('eligible', current_triage_eligible, 'priority', operator_priority,
      'note', operator_note)), '{}'::jsonb)
    from public.deal_hunter_opportunity_scores;`));
}

test('caller-supplied builder review reconciles SQLite and disposable PostgreSQL equally', {
  skip: process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1' ? false
    : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 120_000,
}, async (t) => {
  docker(['image', 'inspect', 'postgres:16']);
  const container = `uckele-fl01-eligibility-${process.pid}-${randomUUID().slice(0, 8)}`;
  docker(['run', '--rm', '--pull=never', '--network=none', '--tmpfs', '/var/lib/postgresql/data',
    '--name', container, '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16']);
  t.after(() => docker(['rm', '-f', container]));
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = spawnSync(dockerCommand, ['logs', container], { encoding: 'utf8' });
    const readyEvents = `${logs.stdout}\n${logs.stderr}`.match(/database system is ready to accept connections/g)?.length || 0;
    const ready = spawnSync(dockerCommand, ['exec', container, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
    if (readyEvents >= 2 && ready.status === 0) break;
    if (attempt === 99) throw new Error('Disposable PostgreSQL did not become ready.');
    Atomics.wait(signal, 0, 0, 100);
  }
  psql(container, 'create role anon nologin; create role authenticated nologin; create role service_role nologin; create database eligibility_test;', 'postgres');
  const schema = fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  psql(container, schema);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-eligibility-pg-'));
  const sqlite = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'scores.sqlite') } });
  t.after(() => { sqlite.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) === process.env.DEAL_HUNTER_SHEET_CSV_URL) {
      return new Response([
        'Business Name,State,Earnings,Revenue,Asking Price,Date Added,View Listing URL,Description',
        'Postgres Required Sheet Co,CA,$450000,$1800000,$1250000,2026-09-23,https://listings.example.invalid/pg-sheet,Recurring commercial inspection contracts',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/csv' } });
    }
    return originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const oldId = 'previously-current';
  await sqlite.upsertDealHunterOpportunity({ opportunity_id: oldId,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    canonical_name: 'Previously Current', identity_version: 'test', status: 'active', metadata: {} });
  const oldDeal = { id: 'old', opportunityId: oldId, identityStatus: 'resolved', dealKey: oldId,
    name: 'Previously Current', state: 'NY', sourceId: 'deal-os-export',
    description: 'Recurring commercial inspection contracts', annualProfit: 450000,
    askingPrice: 1250000, listingUrl: 'https://listings.example.invalid/pg-old' };
  assert.equal((await refreshOpportunityScores({ deals: [oldDeal], storage: sqlite, recordActivity: false })).ok, true);
  await sqlite.reconcileDealHunterCurrentScoreEligibility([oldId]);
  psql(container, `insert into public.deal_hunter_opportunities
    (opportunity_id, created_at, updated_at, canonical_name, identity_version)
    values (${quote(oldId)}, now(), now(), 'Previously Current', 'test');
    insert into public.deal_hunter_opportunity_scores
    (opportunity_id, scored_at, deal_key, name, fit_score, confidence, score_fingerprint,
      engine_version, rules_version, profile_version, completeness_policy_version,
      current_triage_eligible, operator_priority, operator_note)
    values (${quote(oldId)}, now(), ${quote(oldId)}, 'Previously Current', 80, 'high',
      'old-score', 'test', 'test', 'test', 'test', true, 'urgent', 'Owner note');`);

  const imported = await importDealOsExport({
    fileName: 'pg-fresh.csv', fileBuffer: Buffer.from([
      'Listing ID,Business Name,State,Earnings,Revenue,Asking Price,Date Added,View Listing URL,Description',
      'PG-FRESH-1,Postgres Fresh Deal OS Co,TX,$700000,$2800000,$1400000,2026-09-23,https://dealos.example.invalid/pg-fresh,Recurring revenue from service contracts for commercial fire safety inspection with management in place',
    ].join('\n')),
    exportedAt: new Date().toISOString(), scope: 'saved-search',
    coverageLabel: 'Disposable PostgreSQL fixture', importedBy: 'test', storage: sqlite,
  });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const reviewed = await collectScoredOpportunities({ reviewMode: 'full-backfill', storage: sqlite });
  assert.equal(reviewed.review.scoringDeferred, false);
  assert.equal(reviewed.scoredDeals.length, 2);
  for (const deal of reviewed.scoredDeals) {
    psql(container, `insert into public.deal_hunter_opportunities
      (opportunity_id, created_at, updated_at, canonical_name, identity_version)
      values (${quote(deal.opportunityId)}, now(), now(), ${quote(deal.name)}, 'test');`);
  }

  let reconciliations = 0;
  let failWrite = false;
  const storage = Object.create(sqlite);
  storage.writeDealHunterOpportunityScore = async (row, evidence) => {
    if (failWrite && row.opportunity_id === reviewed.scoredDeals[1].opportunityId) {
      throw new Error('injected PostgreSQL contract write failure');
    }
    const written = await sqlite.writeDealHunterOpportunityScore(row, evidence);
    psql(container, `insert into public.deal_hunter_opportunity_scores
      (opportunity_id, scored_at, deal_key, name, fit_score, confidence,
        score_fingerprint, engine_version, rules_version, profile_version,
        completeness_policy_version)
      values (${quote(row.opportunity_id)}, now(), ${quote(row.deal_key)}, ${quote(row.name)},
        ${Number(row.fit_score)}, ${quote(row.confidence)}, ${quote(row.score_fingerprint)},
        ${quote(row.engine_version)}, ${quote(row.rules_version)}, ${quote(row.profile_version)},
        ${quote(row.completeness_policy_version)})
      on conflict (opportunity_id) do update set score_fingerprint=excluded.score_fingerprint,
        scored_at=excluded.scored_at;`);
    return written;
  };
  storage.reconcileDealHunterCurrentScoreEligibility = async (ids) => {
    reconciliations += 1;
    const sqliteResult = await sqlite.reconcileDealHunterCurrentScoreEligibility(ids);
    const pgResult = JSON.parse(psql(container, `select row_to_json(result) from
      public.reconcile_deal_hunter_current_score_eligibility(array[${ids.map(quote).join(',')}]::text[]) result;`));
    assert.deepEqual(pgResult, sqliteResult);
    return sqliteResult;
  };

  const refreshed = await refreshOpportunityScores({ deals: reviewed.scoredDeals,
    authoritativeReview: reviewed.review, reviewMode: 'full-backfill', storage, recordActivity: false });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  assert.equal(reconciliations, 1);
  const pgAfter = pgEligibility(container);
  assert.deepEqual(pgAfter[oldId], { eligible: false, priority: 'urgent', note: 'Owner note' });
  for (const deal of reviewed.scoredDeals) {
    assert.equal(pgAfter[deal.opportunityId].eligible, true);
    assert.ok(await sqlite.getCurrentDealHunterOpportunityScore(deal.opportunityId));
  }

  const shortened = await refreshOpportunityScores({ deals: reviewed.scoredDeals.slice(0, 1),
    authoritativeReview: reviewed.review, reviewMode: 'full-backfill',
    storage, recordActivity: false });
  assert.equal(shortened.ok, true);
  assert.equal(reconciliations, 1);
  assert.deepEqual(pgEligibility(container), pgAfter);

  await sqlite.reconcileDealHunterCurrentScoreEligibility([oldId,
    ...reviewed.scoredDeals.map((deal) => deal.opportunityId)]);
  psql(container, `select * from public.reconcile_deal_hunter_current_score_eligibility(
    array[${[oldId, ...reviewed.scoredDeals.map((deal) => deal.opportunityId)].map(quote).join(',')}]::text[]);`);
  const lastGood = pgEligibility(container);
  failWrite = true;
  const failed = await refreshOpportunityScores({ deals: reviewed.scoredDeals,
    authoritativeReview: reviewed.review, reviewMode: 'full-backfill',
    force: true, storage, recordActivity: false });
  assert.equal(failed.ok, false);
  assert.equal(failed.counts.failed, 1);
  assert.equal(reconciliations, 1);
  assert.deepEqual(pgEligibility(container), lastGood);
  assert.ok(await sqlite.getCurrentDealHunterOpportunityScore(oldId));
});

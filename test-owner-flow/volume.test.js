import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { request } from '@playwright/test';
import { startFixture } from './fixture.js';

const activeCount = 1000, archiveCount = 5000, samples = 30;
const protectedTables = ['contact_submissions', 'deal_hunter_opportunities',
  'deal_hunter_opportunity_scores', 'deal_hunter_freshness_evidence', 'deal_hunter_dispositions',
  'deal_hunter_opportunity_aliases', 'deal_hunter_opportunity_source_observations',
  'crm_activity_events', 'email_suppressions', 'deal_hunter_pursuit_enrollments',
  'deal_hunter_owner_decision_events', 'deal_hunter_broker_conversations', 'deal_hunter_cim_requests',
  'deal_hunter_cim_live_provider_authorizations',
  'deal_hunter_cim_campaigns', 'deal_hunter_cim_capacity_reservations',
  'deal_hunter_cim_capability_activations', 'deal_hunter_cim_transmissions', 'crm_email_outbox'];

function fingerprint(db, tables = protectedTables) {
  const hash = createHash('sha256');
  for (const table of tables) {
    hash.update(table);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

function seedGrowth(db) {
  const template = Object.fromEntries(['deal_hunter_opportunities', 'deal_hunter_opportunity_scores',
    'deal_hunter_opportunity_aliases'].map((table) => [table,
    db.prepare(`SELECT * FROM ${table} WHERE opportunity_id='older' LIMIT 1`).get()]));
  const insert = Object.fromEntries(Object.entries(template).map(([table, row]) => [table,
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(',')})`)]));
  const pass = db.prepare(`INSERT INTO deal_hunter_dispositions
    (id,deal_key,deal_name,created_at,updated_at,disposition,reason,note,dismissed_at,created_by,updated_by)
    VALUES (@id,@key,@name,@at,@at,'dismissed','volume-retained-reason','Volume archive retained note',@at,'fixture','fixture')`);
  db.transaction(() => {
    for (const [kind, count] of [['active', activeCount], ['archive', archiveCount]]) {
      for (let index = 0; index < count; index += 1) {
        const id = `volume-${kind}-${String(index).padStart(5, '0')}`;
        const name = `Synthetic Volume ${kind} ${index}`;
        const opportunity = { ...template.deal_hunter_opportunities, opportunity_id: id,
          canonical_name: name, primary_submission_id: null };
        insert.deal_hunter_opportunities.run(opportunity);
        insert.deal_hunter_opportunity_scores.run({ ...template.deal_hunter_opportunity_scores,
          opportunity_id: id, deal_key: id, name, current_triage_eligible: kind === 'active' ? 1 : 0 });
        insert.deal_hunter_opportunity_aliases.run({ ...template.deal_hunter_opportunity_aliases,
          id: `alias-${id}`, opportunity_id: id, alias_value: id, alias_key: `deal-key:${id}` });
        if (kind === 'archive') pass.run({ id: `pass-${id}`, key: id, name, at: opportunity.updated_at });
      }
    }
  })();
}

test('FL05 representative volume: full CSV, bounded reads, archive pagination and unchanged authority', { timeout: 120_000 }, async (t) => {
  const fixture = await startFixture(t);
  const api = await request.newContext({ baseURL: fixture.origin, extraHTTPHeaders: { Origin: fixture.origin }, timeout: 10_000 });
  t.after(() => api.dispose());
  const measurements = [], rss = [process.memoryUsage().rss];
  let passed = false;
  const read = async (url) => {
    assert.ok(url.startsWith('/api/admin/'), 'Only owned local admin routes');
    const started = performance.now();
    const response = await api.get(url);
    assert.equal(response.status(), 200, url);
    const body = await response.body();
    const elapsedMs = performance.now() - started;
    const json = JSON.parse(body);
    await response.dispose();
    assert.ok(body.length < 512 * 1024, 'A read must not download the complete archive');
    if (json.rows) assert.ok(json.rows.length <= 100);
    if (json.areas) assert.ok(json.areas.every((area) => area.rows.length <= 25));
    rss.push(process.memoryUsage().rss);
    return { json, elapsedMs, bytes: body.length };
  };
  const measure = async (stage, name, url) => {
    const rssBeforeBytes = process.memoryUsage().rss, rssStart = rss.length;
    const first = await read(url), times = [], bytes = [first.bytes];
    const rssAfterFirstBytes = rss.at(-1);
    for (let index = 0; index < samples; index += 1) {
      const result = await read(url);
      times.push(result.elapsedMs); bytes.push(result.bytes);
    }
    times.sort((a, b) => a - b);
    measurements.push({ stage, name, samples, firstRequestMs: first.elapsedMs,
      medianMs: times[Math.ceil(samples * 0.5) - 1], p95Ms: times[Math.ceil(samples * 0.95) - 1],
      maxResponseBytes: Math.max(...bytes), responseRowCount: first.json.rows?.length ?? null,
      matchingRows: first.json.areas?.find((area) => area.id === 'all-active')?.total ?? first.json.total ?? null,
      sourceHealth: first.json.sourceHealth ? { healthy: first.json.sourceHealth.healthy,
        actionsAllowed: first.json.dailyDigest?.actionsAllowed ?? null } : null,
      rssBeforeBytes, rssAfterFirstBytes, rssAfterSamplesBytes: rss.at(-1),
      minSampledRssBytes: Math.min(...rss.slice(rssStart)), maxSampledRssBytes: Math.max(...rss.slice(rssStart)) });
  };
  try {
    const login = await api.post('/api/admin/session', { data: { username: 'fl05-owner', password: 'synthetic-owner-password' } });
    assert.equal(login.status(), 200); await login.dispose();
    const paths = [
      ['queue', '/api/admin/deal-hunter/triage?view=inbox&area=all-active&pageSize=25'],
      ['archive', '/api/admin/deal-hunter/triage?view=dismissed&pageSize=25&search=archive'],
      ['detail', '/api/admin/deal-hunter/triage/older'],
    ];
    for (const [name, url] of paths) await measure('baseline-eight', name, url);
    const at = new Date().toISOString();
    fixture.db.prepare(`INSERT INTO email_suppressions
      (id,normalized_email,reason,source,created_at,created_by,metadata)
      VALUES ('volume-opt-out','broker@example.test','explicit-opt-out','synthetic',?,'fixture','{}')`).run(at);
    const outreachTables = protectedTables.filter((table) => /suppressions|pursuit|owner_decision|conversations|cim_|outbox/.test(table));
    const outreachBefore = fingerprint(fixture.db, outreachTables);
    const csv = ['Listing ID,Business Name,Listing URL,Date Added',
      ...Array.from({ length: 1000 }, (_, index) => `VOL-${index},Synthetic CSV ${index},https://listings.example.invalid/volume-${index},${at.slice(0, 10)}`)].join('\n');
    const upload = await api.post('/api/admin/deal-hunter/deal-os-import', { data: Buffer.from(csv), headers: {
      'Content-Type': 'text/csv', 'X-Deal-OS-File-Name': 'synthetic-volume.csv',
      'X-Deal-OS-Exported-At': at, 'X-Deal-OS-Scope': 'saved-search',
      'X-Deal-OS-Coverage-Label': 'Synthetic complete supported batch', 'X-Deal-OS-Expected-Row-Count': '1000',
    } });
    const imported = await upload.json();
    assert.equal(upload.status(), 201, JSON.stringify(imported)); await upload.dispose();
    assert.equal(imported.summary.importedRows, 1000);
    assert.equal((await fixture.storage.getLatestDealHunterDealOsImport()).records.length, 1000);
    const importCount = fixture.db.prepare('SELECT count(*) AS n FROM deal_hunter_deal_os_imports').get().n;
    const overflow = await api.post('/api/admin/deal-hunter/deal-os-import', { data: Buffer.from(`${csv}\nVOL-overflow,Synthetic overflow,https://listings.example.invalid/overflow,${at.slice(0, 10)}`), headers: {
      'Content-Type': 'text/csv', 'X-Deal-OS-File-Name': 'synthetic-overflow.csv',
      'X-Deal-OS-Exported-At': at, 'X-Deal-OS-Scope': 'saved-search',
      'X-Deal-OS-Coverage-Label': 'Synthetic over-limit batch', 'X-Deal-OS-Expected-Row-Count': '1001',
    } });
    assert.equal(overflow.status(), 422);
    assert.match((await overflow.json()).error, /supported maximum is 1000/); await overflow.dispose();
    assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM deal_hunter_deal_os_imports').get().n, importCount);
    assert.equal(fingerprint(fixture.db, outreachTables), outreachBefore, 'Import never changes outreach authority');
    const preGrowthQueue = (await read(paths[0][1])).json.areas.find((area) => area.id === 'all-active');
    assert.ok(preGrowthQueue);
    seedGrowth(fixture.db);
    const beforeReads = fingerprint(fixture.db);
    for (const [name, url] of paths) await measure('growth', name, url);
    const grownQueue = (await read(paths[0][1])).json.areas.find((area) => area.id === 'all-active');
    assert.ok(grownQueue);
    assert.equal(grownQueue.total, preGrowthQueue.total + activeCount);
    assert.ok(grownQueue.rows.some((row) => row.opportunityId.startsWith('volume-active-')));
    const archiveUrl = '/api/admin/deal-hunter/triage?view=dismissed&sort=fit-score&pageSize=25&search=Volume%20archive%20retained';
    const first = (await read(archiveUrl)).json, second = (await read(`${archiveUrl}&page=2`)).json;
    const last = (await read(`${archiveUrl}&page=200`)).json;
    assert.equal(first.total, archiveCount); assert.equal(last.totalPages, 200);
    assert.equal(first.rows[0].opportunityId, 'volume-archive-00000');
    assert.equal(last.rows.at(-1).opportunityId, 'volume-archive-04999');
    assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.opportunityId)).size, 50);
    assert.deepEqual((await read(archiveUrl)).json.rows, first.rows, 'Fixed-snapshot ties stay stable');
    const bounded = (await read(archiveUrl.replace('pageSize=25', 'pageSize=100000'))).json;
    assert.equal(bounded.rows.length, 100); assert.equal(bounded.total, archiveCount);
    assert.equal(fingerprint(fixture.db), beforeReads, 'List/detail/search never mutate retained business state');
    assert.deepEqual(fixture.blockedNetwork, []);
    const observations = {
      environment: { node: process.version, platform: process.platform, arch: process.arch,
        cpuModel: os.cpus()[0]?.model, totalSystemMemoryBytes: os.totalmem() },
      dataset: { base: 8, supportedCsvRows: 1000, seededCurrentRows: activeCount, seededHistoricalArchives: archiveCount,
        currentAreaBeforeGrowth: preGrowthQueue.total, currentAreaAfterGrowth: grownQueue.total,
        canonicalRows: fixture.db.prepare('SELECT count(*) AS n FROM deal_hunter_opportunities').get().n },
      import: { importedRows: imported.summary.importedRows, overflowRejectedWithoutPersistence: true,
        reviewWarning: imported.reviewWarning || '', scoringDeferred: imported.review?.scoringDeferred ?? null },
      measurements, maxSampledRssBytes: Math.max(...rss), processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      memoryScope: 'Whole child process including module load, fixture construction, import, fingerprints and reads; per-path samples are observations, not a leak/production memory bound.',
      representativeArchiveCorePlan: fixture.db.prepare(`EXPLAIN QUERY PLAN SELECT scores.opportunity_id
        FROM deal_hunter_opportunity_scores scores JOIN deal_hunter_opportunities opportunity
          ON opportunity.opportunity_id=scores.opportunity_id AND opportunity.status='active'
        JOIN deal_hunter_dispositions disposition ON disposition.deal_key=scores.deal_key
        WHERE disposition.disposition='dismissed' AND lower(disposition.note) LIKE ?
        ORDER BY scores.fit_score DESC,scores.opportunity_id ASC LIMIT 25`).all('%volume archive retained%'),
      protectedStateUnchanged: true, externalAttempts: fixture.blockedNetwork,
      pilotTargets: { queueP95Ms: 1000, archiveP95Ms: 2000,
        queueObservedWithinTarget: measurements.find((item) => item.stage === 'growth' && item.name === 'queue').p95Ms <= 1000,
        archiveObservedWithinTarget: measurements.find((item) => item.stage === 'growth' && item.name === 'archive').p95Ms <= 2000 },
      limits: 'Synthetic SQLite HTTP measurements, one process, warm filesystem; firstRequest is not a cold process. Core query plan omits full OR-search, counts, summary and correlated projections. Not owner timing, production p95, PostgreSQL volume parity or full importer/reimport acceptance.',
    };
    fs.writeFileSync(path.join(fixture.root, 'volume-observations.json'), JSON.stringify(observations, null, 2));
    // Aggregate synthetic evidence survives the hosted runner's retirement.
    t.diagnostic(`FL05_VOLUME_OBSERVATIONS ${JSON.stringify({ environment: observations.environment,
      dataset: observations.dataset, import: observations.import, measurements,
      processPeakRssBytes: observations.processPeakRssBytes, protectedStateUnchanged: true,
      externalAttempts: fixture.blockedNetwork, limits: observations.limits, memoryScope: observations.memoryScope })}`);
    passed = true;
  } finally {
    // Partial timings survive assertion failures as well as successful runs.
    fs.writeFileSync(path.join(fixture.root, 'volume-partial-measurements.json'), JSON.stringify({ status: passed ? 'passed' : 'failed', measurements,
      maxSampledRssBytes: Math.max(...rss), externalAttempts: fixture.blockedNetwork }, null, 2));
    fs.writeFileSync(path.join(fixture.root, 'volume-requests.json'), JSON.stringify(fixture.requests, null, 2));
  }
});

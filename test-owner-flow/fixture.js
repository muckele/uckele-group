import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { fixtureEnvironment } from '../scripts/fl05-fixture-environment.js';
import { installLoopbackGuard } from './network-guard.js';

export const cases = [
  { id: 'fresh', name: 'Synthetic Fresh High Fit', score: 88, days: 1, published: true },
  { id: 'older', name: 'Synthetic Older High Fit', score: 96, days: 60, published: true },
  { id: 'low', name: 'Synthetic New Low Fit', score: 30, days: 1, linked: true },
  { id: 'unknown', name: 'Synthetic Unknown Age', score: 82, days: null },
  { id: 'updated', name: 'Synthetic Material Update', score: 85, days: 60, updated: true },
  { id: 'archived', name: 'Synthetic Archived Reimport', score: 90, days: 60, linked: true },
  { id: 'reply', name: 'Synthetic Broker Reply', score: 80, days: 60, linked: true },
  { id: 'materials', name: 'Synthetic Broker Materials', score: 80, days: 60, linked: true },
];

export async function startFixture(t) {
  // Check the runner's exact allowlist before importing any application module.
  const root = process.env.FL05_FIXTURE_ROOT;
  assert.ok(root && path.isAbsolute(root), 'Use npm run test:owner-flow');
  assert.equal(fs.readFileSync(path.join(root, '.fl05-owned-fixture'), 'utf8'), 'synthetic-local-only');
  const expected = fixtureEnvironment(root, process.env.FL05_BROWSER_EXECUTABLE);
  for (const [key, value] of Object.entries(expected)) assert.equal(process.env[key], value, key);
  // Node's test runner and macOS add these runtime bookkeeping keys themselves.
  assert.deepEqual(Object.keys(process.env).filter((key) => !['NODE_TEST_CONTEXT', '__CF_USER_TEXT_ENCODING'].includes(key)).sort(),
    Object.keys(expected).sort(), 'No inherited environment configuration is permitted');
  assert.equal(fs.existsSync(expected.SQLITE_PATH), false, 'Only a fresh fixture database is permitted');
  const blockedNetwork = [];
  const restoreNetwork = installLoopbackGuard(blockedNetwork);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { blockedNetwork.push('fetch'); throw new Error('FL05 provider fetch denied'); };

  const server = http.createServer();
  let storage, db;
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    db?.close(); storage?.close();
    restoreNetwork(); globalThis.fetch = originalFetch;
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_SITE_URL = origin;
  const { getConfig } = await import('../server/config.js');
  const { getStorage } = await import('../server/storage/index.js');
  const { createApp } = await import('../server/app.js');
  const config = getConfig();
  assert.equal(config.delivery.provider, 'console');
  assert.equal(config.dealHunter.cimAutomation.paused, true);
  assert.equal(config.dealHunter.cimAutomation.schedulerEnabled, false);
  assert.equal(config.dealHunter.cimOutreach.paused, true);
  storage = getStorage();
  db = new Database(expected.SQLITE_PATH);
  const requests = [];
  const app = createApp(); // No server/index.js, scheduler, startup maintenance or dotenv.
  const dist = path.resolve('dist');
  // Offline fonts only: remove external font stylesheet/preconnect hints from
  // the fixture HTML before the browser can issue even speculative requests.
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
    .replace(/<link\b[^>]*https:\/\/fonts\.[^>]*>/g, '');
  app.get(['/', '/admin', '/admin/*'], (_request, response) => response.type('html').send(html));
  app.use(express.static(dist));
  server.on('request', (request, response) => {
    response.once('finish', () => requests.push({ method: request.method,
      path: request.url, status: response.statusCode }));
    app(request, response);
  });
  const at = new Date().toISOString();
  fs.writeFileSync(expected.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH, JSON.stringify({
    generatedAt: at, issues: [], totals: { reviewedDeals: cases.length }, sources: {
      'sheet-0': { rowCount: cases.length, name: 'Synthetic local source', mode: 'csv',
        required: true, sourceRole: 'required-primary', checkedAt: at },
    },
  }));
  for (const item of cases) {
    const accepted = item.days === null ? null : new Date(Date.now() - item.days * 86_400_000).toISOString();
    await storage.upsertDealHunterOpportunity({
      opportunity_id: item.id, created_at: accepted || at, updated_at: at,
      canonical_name: item.name, canonical_location: 'Synthetic City, TX', canonical_recipient: null,
      primary_submission_id: null, identity_version: 'fl05-synthetic-v1', status: 'active', metadata: {},
    });
    await storage.writeDealHunterOpportunityScore({
      opportunity_id: item.id, scored_at: at, deal_key: `fl05-${item.id}`, name: item.name,
      state: 'TX', listing_url: `https://listings.example.invalid/${item.id}`, fit_score: item.score,
      score_status: item.score >= 75 ? 'high-priority' : 'watchlist', confidence: 'high',
      completeness_score: 70, contradiction_count: 0, missing_evidence_count: 1,
      should_remove: false, high_fit: item.score >= 75, gate_count: 0,
      score_fingerprint: `fl05-${item.id}`, semantic_digest: `fl05-${item.id}`,
      engine_version: 'synthetic', rules_version: 'synthetic', profile_version: 'synthetic',
      completeness_policy_version: 'synthetic', dimensions: [], gates: [], applied_caps: [],
      missing_evidence: [], confidence_reasons: [], summary: {},
    }, []);
    await storage.upsertDealHunterOpportunityAlias({
      id: `alias-${item.id}`, opportunity_id: item.id, alias_type: 'deal-key', alias_value: `fl05-${item.id}`,
      alias_key: `deal-key:fl05-${item.id}`, source: 'fl05-synthetic', first_observed_at: at,
      last_observed_at: at, evidence_version: 'fl05-synthetic-v1', resolution_method: 'exact-deal-key',
      confidence_state: 'exact', resolved_by: 'fixture', metadata: {},
    });
    db.prepare(`UPDATE deal_hunter_opportunities SET discovery_state = ?, first_accepted_at = ?,
      discovery_revision = ?, material_revision = ?, last_material_change_at = ? WHERE opportunity_id = ?`)
      .run(accepted ? 'known_prospective' : 'untracked_legacy', accepted, accepted ? 1 : 0,
        item.updated ? 1 : 0, item.updated ? at : null, item.id);
    await storage.upsertDealHunterOpportunitySourceObservation({
      id: `name-${item.id}`, opportunity_id: item.id, source_id: 'sheet-0', source_name: 'Synthetic local source',
      source_record_id: `record-${item.id}`, field: 'name', value: item.name,
      observed_at: at, created_at: at, updated_at: at,
    });
    if (item.published) {
      db.prepare(`INSERT INTO deal_hunter_freshness_evidence
        (id, source_id, source_name, source_record_id, run_id, generation, event_type, current_canonical_id)
        VALUES (?, 'sheet-0', 'Synthetic local source', ?, 'fl05-run', 1, 'accepted_source_record', ?)`)
        .run(`core-${item.id}`, `record-${item.id}`, item.id);
      db.prepare(`INSERT INTO deal_hunter_opportunity_source_observations
        (id, opportunity_id, source_id, source_name, source_record_id, field, value,
         observed_at, created_at, updated_at, accepted_evidence_id)
        VALUES (?, ?, 'sheet-0', 'Synthetic local source', ?, 'date_added', ?, ?, ?, ?, ?)`)
        .run(`date-${item.id}`, item.id, `record-${item.id}`, accepted.slice(0, 10), at, at, at, `core-${item.id}`);
      db.prepare(`INSERT INTO deal_hunter_freshness_evidence
      (id, source_id, source_name, source_record_id, run_id, generation, event_type, field_key,
       current_canonical_id, publication_meaning, publication_date, publication_precision, publication_state)
      VALUES (?, 'sheet-0', 'Synthetic local source', ?, 'fl05-run', 1, 'publication_evidence',
       'date_added', ?, 'listing_publication', ?, 'date', 'valid')`)
        .run(`publication-${item.id}`, `record-${item.id}`, item.id, accepted.slice(0, 10));
    }
    if (item.linked) {
      db.prepare(`INSERT INTO contact_submissions
        (id, created_at, updated_at, status, delivery_provider, delivery_status, crm_status,
         source, ip_hash, name, company, email, message)
        VALUES (?, ?, ?, 'review', 'console', 'not-sent', 'not-synced', 'fl05-synthetic',
         'synthetic', ?, ?, 'broker@example.test', 'Synthetic local fixture; no email sent')`)
        .run(`crm-${item.id}`, at, at, item.name, item.name);
      db.prepare('UPDATE deal_hunter_opportunities SET primary_submission_id = ? WHERE opportunity_id = ?')
        .run(`crm-${item.id}`, item.id);
    }
  }
  await storage.reconcileDealHunterCurrentScoreEligibility(cases.map((item) => item.id));
  db.prepare(`INSERT INTO deal_hunter_freshness_evidence
    (id, source_id, source_name, source_record_id, run_id, generation, event_type,
     field_key, current_canonical_id, before_value, after_value, metric, currency, period,
     classification, material_revision) VALUES ('material-update', 'sheet-0', 'Synthetic local source',
     'record-updated', 'fl05-run', 1, 'material_change', 'asking_price', 'updated',
     1500000, 1250000, 'asking_price', 'USD', 'current', 'comparable_change', 1)`).run();
  const archiveResult = await storage.passDealHunterOpportunity({ opportunityId: 'archived', reason: 'not-a-fit',
    note: 'Synthetic preserved archive note', actor: 'fl05-owner', occurredAt: at,
    dispositionId: 'fixture-archived', archiveActivityId: 'fixture-archive-activity',
    triageActivityId: 'fixture-triage-activity', expectedDiscoveryRevision: 1, expectedMaterialRevision: 0 });
  assert.equal(archiveResult.applied, true);
  const archiveBefore = await storage.getDealHunterOpportunity('archived');
  // Re-observation of the same source identity must retain Pass and first discovery.
  await storage.upsertDealHunterOpportunitySourceObservation({
    id: 'name-archived', opportunity_id: 'archived', source_id: 'sheet-0', source_name: 'Synthetic local source',
    source_record_id: 'record-archived', field: 'name', value: 'Synthetic Archived Reimport',
    observed_at: at, created_at: at, updated_at: at,
  });
  const archiveAfter = await storage.getDealHunterOpportunity('archived');
  assert.equal(archiveAfter.first_accepted_at, archiveBefore.first_accepted_at);
  assert.equal(archiveAfter.discovery_revision, archiveBefore.discovery_revision);
  db.prepare(`INSERT INTO crm_communications
    (id, submission_id, direction, channel, source, kind, occurred_at, created_at, updated_at, delivery_state)
    VALUES ('fixture-reply', 'crm-reply', 'inbound', 'email', 'resend-webhook', 'broker-reply', ?, ?, ?, 'replied')`)
    .run(at, at, at);
  db.prepare(`INSERT INTO secure_upload_requests
    (id, submission_id, created_at, updated_at, email, status, expires_at, last_uploaded_at, requested_documents)
    VALUES ('fixture-materials', 'crm-materials', ?, ?, 'broker@example.test', 'completed', ?, ?, ?)`)
    .run(at, at, at, at, JSON.stringify([{ category: 'financials' }]));
  return { root, origin, storage, db, requests, blockedNetwork };
}

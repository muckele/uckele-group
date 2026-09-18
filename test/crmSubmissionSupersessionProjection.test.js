import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';

import { getAcquisitionCommandCenter } from '../server/services/acquisitionCommandCenter.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const timestamp = '2026-09-17T18:00:00.000Z';
const dueAt = '2026-09-17T17:00:00.000Z';
const digest = 'a'.repeat(64);

function submission(id, overrides = {}) {
  return {
    id,
    created_at: timestamp,
    updated_at: timestamp,
    status: 'review',
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: null,
    crm_status: 'not-applicable',
    crm_error: null,
    source: 'projection-test',
    ip_hash: '',
    user_agent: '',
    name: `Projection ${id}`,
    email: `${id}@example.test`,
    phone: '',
    company: `Projection Company ${id}`,
    role: 'Broker',
    message: 'projection-key',
    status_updated_at: timestamp,
    listing_url: `https://example.test/listings/${id}`,
    business_website: '',
    prospectus_url: '',
    asking_price: '$1,000,000',
    ttm_revenue: '',
    ttm_ebitda: '$300,000',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: '',
    broker_email: `${id}-broker@example.test`,
    broker_phone: '',
    seller_name: '',
    seller_email: '',
    seller_phone: '',
    lead_type: 'broker',
    priority: 'normal',
    tags: [],
    assigned_to: '',
    notes: '',
    follow_up_state: 'needs-response',
    next_action_at: dueAt,
    last_contacted_at: null,
    deal_hunter_opportunity_id: null,
    metadata: { dealHunter: { score: 80, dealKey: `projection:${id}` } },
    ...overrides,
  };
}

function withRawDatabase(sqlitePath, callback, options) {
  const database = new Database(sqlitePath, options);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

async function projectionFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-supersession-projection-'));
  const sqlitePath = path.join(directory, 'projection.sqlite');
  const storage = createSqliteStorage({
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await storage.insertSubmission(submission('survivor', {
    deal_hunter_opportunity_id: 'opportunity',
  }));
  await storage.insertSubmission(submission('loser'));
  await storage.insertSubmission(submission('historical-looking', {
    source: 'legacy-historical-import',
    notes: 'Retained historical-looking row without a supersession relation.',
  }));
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'opportunity',
    created_at: timestamp,
    updated_at: timestamp,
    canonical_name: 'Projection opportunity',
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: 'survivor',
    identity_version: 'projection-test-v1',
    status: 'active',
    metadata: {},
  });
  await storage.upsertDealHunterCimRepairManifest({
    id: 'apply-receipt',
    created_at: timestamp,
    updated_at: timestamp,
    mode: 'crm-duplicate-consolidation',
    status: 'applied',
    actor: 'projection-test',
    backup_reference: 'fixture-backup',
    checksum: digest,
    manifest: { version: 1 },
    metadata: {},
  });
  withRawDatabase(sqlitePath, (database) => database.prepare(`
    INSERT INTO crm_submission_supersessions (
      id, created_at, updated_at, status, survivor_submission_id, superseded_submission_id,
      opportunity_id, reason_code, reason_text, approved_by, approved_at, actor,
      repair_version, repair_manifest_id, repair_digest, metadata
    ) VALUES (
      'relation', ?, ?, 'active', 'survivor', 'loser', 'opportunity',
      'confirmed-duplicate', 'Reviewed duplicate.', 'owner@example.test', ?,
      'projection-test', 'v1', 'apply-receipt', ?, '{}'
    )
  `).run(timestamp, timestamp, timestamp, digest));

  return { directory, sqlitePath, storage };
}

function ids(rows) {
  return rows.map((row) => row.id);
}

function dashboardProjectionsInIsolatedProcess(sqlitePath) {
  const submissionsModuleUrl = pathToFileURL(path.resolve('server/services/submissions.js')).href;
  const storageModuleUrl = pathToFileURL(path.resolve('server/storage/index.js')).href;
  const script = `
    const { listDashboardFollowUps, listDashboardSubmissions } = await import(${JSON.stringify(submissionsModuleUrl)});
    const { getStorage } = await import(${JSON.stringify(storageModuleUrl)});
    const result = await listDashboardSubmissions({
      page: 1,
      pageSize: 25,
      search: 'projection-key',
      status: 'all',
      created: 'all',
      sort: 'created_at',
      direction: 'desc',
    });
    const followUps = await listDashboardFollowUps({
      page: 1,
      pageSize: 25,
      search: 'projection',
      view: 'overdue',
      sort: 'urgency',
      direction: 'desc',
    });
    console.log(JSON.stringify({
      ids: result.submissions.map((submission) => submission.id),
      total: result.total,
      summary: result.summary,
      followUpIds: followUps.items.map((submission) => submission.id),
      followUpTotal: followUps.total,
    }));
    getStorage().close();
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      SQLITE_PATH: sqlitePath,
      ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH: path.join(path.dirname(sqlitePath), 'missing-health.json'),
    },
  });
  return JSON.parse(output.trim());
}

test('active CRM projections exclude only the active loser and preserve direct history', async (t) => {
  const { sqlitePath, storage } = await projectionFixture(t);

  const list = await storage.listSubmissions({ limit: 25, page: 1, status: 'all' });
  assert.deepEqual(ids(list.rows).sort(), ['historical-looking', 'survivor']);
  assert.equal(list.total, 2);

  const search = await storage.listSubmissions({
    limit: 25,
    page: 1,
    search: 'projection',
    status: 'all',
  });
  assert.deepEqual(ids(search.rows).sort(), ['historical-looking', 'survivor']);
  assert.equal(search.total, 2);

  const firstPage = await storage.listSubmissions({ limit: 1, page: 1, status: 'all' });
  const secondPage = await storage.listSubmissions({ limit: 1, page: 2, status: 'all' });
  assert.equal(firstPage.total, 2);
  assert.equal(secondPage.total, 2);
  assert.deepEqual([...ids(firstPage.rows), ...ids(secondPage.rows)].sort(), ['historical-looking', 'survivor']);

  const followUps = await storage.listFollowUpSubmissions({
    page: 1,
    pageSize: 25,
    search: 'projection',
    view: 'overdue',
    now: timestamp,
    todayStart: timestamp,
    todayEnd: '2026-09-18T18:00:00.000Z',
  });
  assert.equal(followUps.total, 2);
  assert.deepEqual(ids(followUps.rows).sort(), ['historical-looking', 'survivor']);

  const summary = await storage.getSummary();
  assert.deepEqual({ total: summary.total, review: summary.review, dueToday: summary.dueToday }, {
    total: 2,
    review: 2,
    dueToday: 2,
  });

  assert.equal((await storage.getSubmission('loser')).id, 'loser');
  assert.equal((await storage.getSubmissionStrict('loser')).id, 'loser');
  assert.equal((await storage.getSubmissionStrict('historical-looking')).id, 'historical-looking');

  const dashboard = dashboardProjectionsInIsolatedProcess(sqlitePath);
  assert.deepEqual(dashboard.ids.sort(), ['historical-looking', 'survivor']);
  assert.equal(dashboard.total, 2);
  assert.deepEqual(dashboard.followUpIds.sort(), ['historical-looking', 'survivor']);
  assert.equal(dashboard.followUpTotal, 2);

  const commandCenter = await getAcquisitionCommandCenter({
    storage,
    persistSourceHealth: false,
    refreshSourceHealth: false,
  });
  assert.deepEqual(ids(commandCenter.records).sort(), ['historical-looking', 'survivor']);
  assert.equal(commandCenter.summary.totalRecords, 2);
});

test('a separately receipted reversal returns the former loser to active projections', async (t) => {
  const { sqlitePath, storage } = await projectionFixture(t);
  assert.equal((await storage.listSubmissions({ limit: 25 })).rows.some((row) => row.id === 'loser'), false);

  await storage.upsertDealHunterCimRepairManifest({
    id: 'reversal-receipt',
    created_at: timestamp,
    updated_at: timestamp,
    mode: 'crm-duplicate-consolidation',
    status: 'applied',
    actor: 'reviewer',
    backup_reference: 'reversal-backup',
    checksum: 'e'.repeat(64),
    manifest: {
      schema: 'crm-duplicate-consolidation-reversal-manifest-v1',
      operation: 'reverse',
      relationId: 'relation',
      applyManifestId: 'apply-receipt',
      repairDigest: digest,
      survivorSubmissionId: 'survivor',
      supersededSubmissionId: 'loser',
      opportunityId: 'opportunity',
    },
    metadata: {},
  });
  withRawDatabase(sqlitePath, (database) => database.prepare(`
    UPDATE crm_submission_supersessions
    SET status = 'reversed', updated_at = ?, reversed_at = ?, reversed_by = ?,
      reversal_reason = ?, reversal_manifest_id = ?
    WHERE id = 'relation'
  `).run(
    '2026-09-17T20:00:00.000Z',
    '2026-09-17T20:00:00.000Z',
    'reviewer',
    'Reviewed reversal.',
    'reversal-receipt',
  ));

  const list = await storage.listSubmissions({ limit: 25, search: 'projection-key' });
  assert.deepEqual(ids(list.rows).sort(), ['historical-looking', 'loser', 'survivor']);
  assert.equal(list.total, 3);
});

test('the active-loser anti-join uses the partial unique loser index', async (t) => {
  const { sqlitePath } = await projectionFixture(t);
  const plan = withRawDatabase(sqlitePath, (database) => database.prepare(`
    EXPLAIN QUERY PLAN
    SELECT submissions.id
    FROM contact_submissions AS submissions
    WHERE NOT EXISTS (
      SELECT 1
      FROM crm_submission_supersessions AS active_supersession
      WHERE active_supersession.superseded_submission_id = submissions.id
        AND active_supersession.status = 'active'
    )
    ORDER BY submissions.created_at DESC, submissions.id ASC
  `).all(), { readonly: true });
  assert.match(
    plan.map((step) => step.detail).join('\n'),
    /uq_crm_submission_supersessions_active_loser/,
  );
});

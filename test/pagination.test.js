import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

function submission(index) {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
  return {
    id: `page-record-${String(index).padStart(3, '0')}`,
    created_at: createdAt,
    updated_at: createdAt,
    status: index % 2 === 0 ? 'review' : 'new',
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: '',
    crm_status: 'not-applicable',
    crm_error: '',
    source: 'pagination-test',
    ip_hash: '',
    user_agent: '',
    name: `Seller ${index}`,
    email: `seller-${index}@example.com`,
    phone: '',
    company: `Company ${String(100 - index).padStart(3, '0')}`,
    role: 'Seller',
    message: 'Pagination test record',
    status_updated_at: createdAt,
    listing_url: '',
    business_website: '',
    prospectus_url: '',
    asking_price: '',
    ttm_revenue: '',
    ttm_ebitda: '',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: '',
    broker_email: '',
    broker_phone: '',
    seller_name: `Seller ${index}`,
    seller_email: `seller-${index}@example.com`,
    seller_phone: '',
    lead_type: 'seller',
    priority: index % 10 === 0 ? 'urgent' : 'normal',
    tags: [],
    assigned_to: '',
    notes: '',
    follow_up_state: 'needs-response',
    next_action_at: null,
    last_contacted_at: null,
    metadata: {},
  };
}

test('SQLite CRM pagination returns stable pages, totals, filters, and sorting', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pagination-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });

  for (let index = 1; index <= 63; index += 1) {
    await storage.insertSubmission(submission(index));
  }

  const first = await storage.listSubmissions({ limit: 25, page: 1, sort: 'created_at', direction: 'desc' });
  const third = await storage.listSubmissions({ limit: 25, page: 3, sort: 'created_at', direction: 'desc' });
  const filtered = await storage.listSubmissions({ limit: 10, page: 2, status: 'review', sort: 'company', direction: 'asc' });
  const recentlyCreated = await storage.listSubmissions({
    limit: 50,
    page: 1,
    createdAfter: '2026-01-01T00:30:00.000Z',
    sort: 'created_at',
    direction: 'asc',
  });

  assert.equal(first.total, 63);
  assert.equal(first.rows.length, 25);
  assert.equal(first.rows[0].id, 'page-record-063');
  assert.equal(third.rows.length, 13);
  assert.equal(third.rows[0].id, 'page-record-013');
  assert.equal(filtered.total, 31);
  assert.equal(filtered.rows.length, 10);
  assert.ok(filtered.rows.every((record) => record.status === 'review'));
  assert.ok(filtered.rows[0].company.localeCompare(filtered.rows.at(-1).company) <= 0);
  assert.equal(recentlyCreated.total, 34);
  assert.equal(recentlyCreated.rows[0].id, 'page-record-030');
});

test('SQLite priority pages use business rank and id ASC for exact ties', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-priority-order-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  const tiedAt = '2026-01-01T00:00:00.000Z';
  const records = [
    ['tie-normal', 'normal'],
    ['tie-high-b', 'high'],
    ['tie-low', 'low'],
    ['tie-urgent', 'urgent'],
    ['tie-high-a', 'high'],
  ];

  for (const [id, priority] of records) {
    await storage.insertSubmission({ ...submission(1), id, priority, created_at: tiedAt, updated_at: tiedAt });
  }

  const result = await storage.listSubmissions({ limit: 10, page: 1, sort: 'priority', direction: 'desc' });

  assert.deepEqual(result.rows.map((record) => record.id), [
    'tie-urgent',
    'tie-high-a',
    'tie-high-b',
    'tie-normal',
    'tie-low',
  ]);
});

test('SQLite CRM pages sort Deal Hunter businesses by score and listing date with unknown values last', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-business-sort-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  const records = [
    ['sort-high', 91, '2026-01-01T00:00:00.000Z', ''],
    ['sort-low', 62, '2026-01-03T00:00:00.000Z', ''],
    ['sort-fallback', 78, '', '2026-01-02T00:00:00.000Z'],
    ['sort-unknown', null, '', ''],
  ];

  for (const [id, score, dateAdded, firstSeenAt] of records) {
    await storage.insertSubmission({
      ...submission(1),
      id,
      metadata: score === null ? {} : { dealHunter: { score, dateAdded, firstSeenAt } },
    });
  }

  const scoreDescending = await storage.listSubmissions({ limit: 10, sort: 'deal_score', direction: 'desc' });
  const scoreAscending = await storage.listSubmissions({ limit: 10, sort: 'deal_score', direction: 'asc' });
  const newestListed = await storage.listSubmissions({ limit: 10, sort: 'listing_date', direction: 'desc' });
  const oldestListed = await storage.listSubmissions({ limit: 10, sort: 'listing_date', direction: 'asc' });

  assert.deepEqual(scoreDescending.rows.map((record) => record.id), ['sort-high', 'sort-fallback', 'sort-low', 'sort-unknown']);
  assert.deepEqual(scoreAscending.rows.map((record) => record.id), ['sort-low', 'sort-fallback', 'sort-high', 'sort-unknown']);
  assert.deepEqual(newestListed.rows.map((record) => record.id), ['sort-low', 'sort-fallback', 'sort-high', 'sort-unknown']);
  assert.deepEqual(oldestListed.rows.map((record) => record.id), ['sort-high', 'sort-fallback', 'sort-low', 'sort-unknown']);
});

test('CRM search treats SQL wildcard characters as literal text', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-literal-search-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });

  await storage.insertSubmission({ ...submission(1), id: 'literal-percent', company: '100% HVAC' });
  await storage.insertSubmission({ ...submission(2), id: 'no-percent', company: 'HVAC Services' });

  const result = await storage.listSubmissions({ limit: 10, page: 1, search: '%' });

  assert.equal(result.total, 1);
  assert.equal(result.rows[0].id, 'literal-percent');
});

test('storage providers normalize fractional and non-finite page input before querying', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-page-normalization-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const sqlite = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  await sqlite.insertSubmission(submission(1));

  const fractional = await sqlite.listSubmissions({ limit: 10.8, page: 1.5 });
  const nonFinite = await sqlite.listSubmissions({ limit: Number.POSITIVE_INFINITY, page: Number.POSITIVE_INFINITY });

  assert.equal(fractional.rows.length, 1);
  assert.equal(nonFinite.rows.length, 1);

  const calls = [];
  const supabase = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    { client: { async rpc(name, parameters) { calls.push({ name, parameters }); return { data: { rows: [], total: 0 }, error: null }; } } },
  );
  await supabase.listSubmissions({ limit: 10.8, page: 1.5 });
  await supabase.listSubmissions({ limit: Number.POSITIVE_INFINITY, page: Number.POSITIVE_INFINITY });

  assert.equal(calls[0].parameters.p_limit, 10);
  assert.equal(calls[0].parameters.p_page, 1);
  assert.equal(calls[1].parameters.p_limit, 50);
  assert.equal(calls[1].parameters.p_page, 1);
});

test('Supabase CRM pagination delegates business priority and deterministic page ordering to the database RPC', async () => {
  const calls = [];
  const client = {
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      return {
        data: {
          rows: [
            { ...submission(2), id: 'priority-a', priority: 'urgent' },
            { ...submission(1), id: 'priority-b', priority: 'high' },
          ],
          total: 12,
        },
        error: null,
      };
    },
  };
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    { client },
  );

  const result = await storage.listSubmissions({
    limit: 2,
    page: 3,
    search: 'HVAC',
    status: 'review',
    createdAfter: '2026-01-15T00:00:00.000Z',
    sort: 'priority',
    direction: 'desc',
  });

  assert.deepEqual(calls, [{
    name: 'list_submissions_page',
    parameters: {
      p_limit: 2,
      p_page: 3,
      p_search: 'HVAC',
      p_status: 'review',
      p_created_after: '2026-01-15T00:00:00.000Z',
      p_sort: 'priority',
      p_direction: 'desc',
    },
  }]);
  assert.equal(result.total, 12);
  assert.deepEqual(result.rows.map((row) => [row.id, row.priority]), [
    ['priority-a', 'urgent'],
    ['priority-b', 'high'],
  ]);

  await storage.listSubmissions({ sort: 'deal_score', direction: 'desc' });
  await storage.listSubmissions({ sort: 'listing_date', direction: 'asc' });
  assert.equal(calls[1].parameters.p_sort, 'deal_score');
  assert.equal(calls[1].parameters.p_direction, 'desc');
  assert.equal(calls[2].parameters.p_sort, 'listing_date');
  assert.equal(calls[2].parameters.p_direction, 'asc');
});

test('Supabase pagination migration supports an exact created-after filter', () => {
  const migration = fs.readFileSync(
    new URL('../supabase/migrations/20260714100000_crm_created_filter.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /p_created_after text default ''/);
  assert.match(migration, /created_at >= \$3::timestamptz/);
  assert.match(migration, /limit \$4 offset \$5/);
});

test('Supabase pagination migration supports score and source-listing-date sorts', () => {
  const migration = fs.readFileSync(
    new URL('../supabase/migrations/20260714110000_crm_score_listing_sort.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /when 'deal_score'/);
  assert.match(migration, /metadata #>> ''\{dealHunter,score\}''/);
  assert.match(migration, /when 'listing_date'/);
  assert.match(migration, /metadata #>> ''\{dealHunter,dateAdded\}''/);
  assert.match(migration, /metadata #>> ''\{dealHunter,firstSeenAt\}''/);
  assert.equal((migration.match(/nulls last/g) || []).length, 2);
});

test('Supabase pagination function encodes the shared business priority rank and stable id tie-breaker', () => {
  const migration = fs.readFileSync(
    new URL('../supabase/migrations/20260713103000_atomic_crm_activity.sql', import.meta.url),
    'utf8',
  );

  assert.match(
    migration,
    /case priority when ''urgent'' then 5 when ''high'' then 4 when ''medium'' then 3 when ''normal'' then 2 when ''low'' then 1 else 0 end/,
  );
  assert.equal((migration.match(/created_at desc, id asc/g) || []).length, 2);
  assert.match(migration, /position\(lower\(\$2\) in lower\(concat_ws/);
  assert.doesNotMatch(migration, /like '%%'/i);
  assert.match(migration, /v_offset bigint/);
});

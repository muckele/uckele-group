import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

function submission(id, updatedAt) {
  return {
    id,
    created_at: updatedAt,
    updated_at: updatedAt,
    status: 'review',
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: '',
    crm_status: 'not-applicable',
    crm_error: '',
    source: 'test',
    ip_hash: '',
    user_agent: '',
    name: 'Concurrency Seller',
    email: 'concurrency@example.com',
    phone: '',
    company: 'Concurrency Services',
    role: 'Seller',
    message: 'Concurrency test',
    status_updated_at: updatedAt,
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
    seller_name: 'Concurrency Seller',
    seller_email: 'concurrency@example.com',
    seller_phone: '',
    lead_type: 'seller',
    priority: 'normal',
    tags: [],
    assigned_to: '',
    notes: '',
    follow_up_state: 'needs-response',
    next_action_at: null,
    last_contacted_at: null,
    metadata: {},
  };
}

test('SQLite compare-and-set permits exactly one write for a shared CRM version', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-cas-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  const initialVersion = '2026-07-12T10:00:00.000Z';
  await storage.insertSubmission(submission('cas-record', initialVersion));

  const results = await Promise.all([
    storage.updateSubmissionIfCurrent('cas-record', initialVersion, { notes: 'editor one', updated_at: '2026-07-12T10:01:00.000Z' }),
    storage.updateSubmissionIfCurrent('cas-record', initialVersion, { notes: 'editor two', updated_at: '2026-07-12T10:02:00.000Z' }),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  const current = await storage.getSubmission('cas-record');
  assert.ok(['editor one', 'editor two'].includes(current.notes));
});

test('Supabase compare-and-set predicates the write on id and updated_at', async () => {
  const predicates = [];
  const query = {
    update() {
      return this;
    },
    eq(field, value) {
      predicates.push([field, value]);
      return this;
    },
    select() {
      return this;
    },
    async maybeSingle() {
      return {
        data: { ...submission('supabase-cas', '2026-07-12T10:01:00.000Z'), notes: 'updated' },
        error: null,
      };
    },
  };
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    { client: { from: () => query } },
  );
  const expected = '2026-07-12T10:00:00.000Z';
  const result = await storage.updateSubmissionIfCurrent('supabase-cas', expected, { notes: 'updated' });

  assert.equal(result.notes, 'updated');
  assert.deepEqual(predicates, [['id', 'supabase-cas'], ['updated_at', expected]]);
});

test('SQLite strict submission lookup distinguishes confirmed absence from query failure', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-strict-submission-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  const record = submission('strict-sqlite', '2026-07-12T11:00:00.000Z');

  try {
    await storage.insertSubmission(record);
    assert.equal((await storage.getSubmissionStrict(record.id)).id, record.id);
    assert.equal(await storage.getSubmissionStrict('confirmed-missing'), null);

    storage.close();
    await assert.rejects(
      () => storage.getSubmissionStrict(record.id),
      /database.*(?:open|closed)|connection.*(?:open|closed)/i,
    );
  } finally {
    try {
      storage.close();
    } catch {
      // The failure assertion intentionally closes the database first.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Supabase strict submission lookup returns null only for a confirmed empty result', async () => {
  const expected = submission('strict-supabase', '2026-07-12T11:00:00.000Z');
  const results = [
    { data: expected, error: null },
    { data: null, error: null },
    { data: null, error: new Error('simulated Supabase transport failure') },
  ];
  const predicates = [];
  const query = {
    select() {
      return this;
    },
    eq(field, value) {
      predicates.push([field, value]);
      return this;
    },
    async maybeSingle() {
      return results.shift();
    },
  };
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    { client: { from: () => query } },
  );

  assert.equal((await storage.getSubmissionStrict(expected.id)).id, expected.id);
  assert.equal(await storage.getSubmissionStrict('confirmed-missing'), null);
  await assert.rejects(
    () => storage.getSubmissionStrict('lookup-error'),
    /simulated Supabase transport failure/,
  );
  assert.deepEqual(predicates, [
    ['id', expected.id],
    ['id', 'confirmed-missing'],
    ['id', 'lookup-error'],
  ]);
});

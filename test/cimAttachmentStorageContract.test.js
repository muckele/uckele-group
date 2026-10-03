import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const migrationPath = path.resolve('supabase/migrations/20261011120000_secure_cim_attachment_foundation.sql');
const schemaPath = path.resolve('supabase/schema.sql');

test('SQLite creates the one approved secure attachment ingestion table with replay and publication uniqueness', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-attachment-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sqlitePath = path.join(root, 'application.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  storage.close();
  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  t.after(() => database.close());
  const tables = database.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE '%attachment%' ORDER BY name`).all().map((row) => row.name);
  assert.deepEqual(tables, ['secure_attachment_ingestions']);
  const indexes = database.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'secure_attachment_ingestions' AND sql IS NOT NULL`).all().map((row) => row.sql).join('\n');
  const tableSql = database.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'secure_attachment_ingestions'`).get().sql;
  assert.match(tableSql, /unique\s*\(provider\s*,\s*provider_message_id\s*,\s*provider_attachment_id\)/i);
  assert.match(indexes, /vault_document_id/i);
  assert.match(tableSql, /retention_status[^,]+default 'hold'/i);
  assert.match(tableSql, /scan_attempt_count[^,]+<= 3/i);
  assert.match(tableSql, /lifecycle_status[\s\S]+quarantining/i);
  assert.match(tableSql, /sha256[^,]+not glob/i);
  assert.match(tableSql, /duplicate_of_id[^,]+references secure_attachment_ingestions/i);
  assert.match(tableSql, /approved_submission_id[^,]+references contact_submissions/i);
  assert.match(tableSql, /hold_reason/i);
});

test('Supabase migration is additive, service-role-only, and publishes through one atomic RPC', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.equal((migration.match(/create table if not exists public\.secure_attachment_ingestions/gi) || []).length, 1);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all privileges on table public\.secure_attachment_ingestions from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update on table public\.secure_attachment_ingestions to service_role/i);
  assert.match(migration, /security definer[\s\S]+set search_path = ''/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /insert into public\.secure_upload_requests[\s\S]+insert into public\.secure_documents[\s\S]+lifecycle_status = 'published'/i);
  assert.match(migration, /crm_submission_supersessions[\s\S]+superseded_submission_id = v_intake\.approved_submission_id[\s\S]+status = 'active'/i);
  assert.match(migration, /v_intake\.approved_submission_id\s+is distinct from\s+\(v_request ->> 'submission_id'\)::uuid/i);
  assert.match(migration, /\(v_communication ->> 'submission_id'\)::uuid\s+is distinct from\s+v_intake\.approved_submission_id/i);
  assert.match(migration, /revoke all on function public\.publish_cim_attachment_to_vault_v1\(jsonb\)[\s\S]+public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.publish_cim_attachment_to_vault_v1\(jsonb\) to service_role/i);
  assert.equal(/delete from public\.secure_attachment_ingestions|drop table public\.secure_attachment_ingestions/i.test(migration), false);

  const schema = fs.readFileSync(schemaPath, 'utf8');
  assert.match(schema, /create table if not exists public\.secure_attachment_ingestions/i);
  assert.match(schema, /create or replace function public\.publish_cim_attachment_to_vault_v1/i);
});

test('quarantine has no HTTP route or default live scanner implementation', () => {
  const app = fs.readFileSync(path.resolve('server/app.js'), 'utf8');
  const intakeService = fs.readFileSync(path.resolve('server/services/cimAttachmentIntake.js'), 'utf8');
  const testScanner = fs.readFileSync(path.resolve('test/support/cimAttachmentScanner.js'), 'utf8');
  assert.equal(/cim[-_/]attachment.*download/i.test(app), false);
  assert.equal(/fetch\s*\(|resend|clamav|clamd|scanner.*url/i.test(intakeService), false);
  assert.doesNotMatch(intakeService, /createDeterministicFakeScanner|deterministic-fake/);
  assert.match(testScanner, /createDeterministicFakeScanner/);
});

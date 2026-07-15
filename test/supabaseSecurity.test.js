import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const schemaUrl = new URL('../supabase/schema.sql', import.meta.url);
const migrationUrl = new URL(
  '../supabase/migrations/20260713104500_supabase_service_role_isolation.sql',
  import.meta.url,
);

function currentAppTables(schema) {
  return Array.from(
    schema.matchAll(/^create table if not exists public\.([a-z0-9_]+)\s*\(/gim),
    (match) => match[1],
  ).sort();
}

function rowLevelSecurityTables(sql) {
  return Array.from(
    sql.matchAll(/^alter table public\.([a-z0-9_]+) enable row level security;/gim),
    (match) => match[1],
  ).sort();
}

function assertServerOnlyPrivileges(sql, sourceLabel) {
  assert.match(
    sql,
    /grant usage on schema public to service_role;/i,
    `${sourceLabel} must preserve service-role schema access`,
  );
  assert.match(
    sql,
    /revoke all privileges on all tables in schema public from public, anon, authenticated;/i,
    `${sourceLabel} must revoke direct public table access`,
  );
  assert.match(
    sql,
    /revoke all privileges on all sequences in schema public from public, anon, authenticated;/i,
    `${sourceLabel} must revoke direct public sequence access`,
  );
  assert.match(
    sql,
    /grant all privileges on all tables in schema public to service_role;/i,
    `${sourceLabel} must preserve service-role table access`,
  );
  assert.match(
    sql,
    /grant all privileges on all sequences in schema public to service_role;/i,
    `${sourceLabel} must preserve service-role sequence access`,
  );
  assert.match(
    sql,
    /alter default privileges in schema public\s+revoke all privileges on tables from public, anon, authenticated;/i,
    `${sourceLabel} must secure future table grants`,
  );
  assert.match(
    sql,
    /alter default privileges in schema public\s+revoke all privileges on sequences from public, anon, authenticated;/i,
    `${sourceLabel} must secure future sequence grants`,
  );
  assert.match(
    sql,
    /alter default privileges in schema public\s+revoke all privileges on functions from public, anon, authenticated;/i,
    `${sourceLabel} must secure future function grants`,
  );
  assert.match(
    sql,
    /alter default privileges in schema public\s+grant all privileges on tables to service_role;/i,
    `${sourceLabel} must preserve future service-role table access`,
  );
  assert.match(
    sql,
    /alter default privileges in schema public\s+grant all privileges on sequences to service_role;/i,
    `${sourceLabel} must preserve future service-role sequence access`,
  );
  assert.match(
    sql,
    /alter default privileges in schema public\s+grant execute on functions to service_role;/i,
    `${sourceLabel} must preserve future service-role function access`,
  );
}

test('Supabase migration and fresh schema isolate every current app table to the server role', () => {
  const schema = fs.readFileSync(schemaUrl, 'utf8');
  const migration = fs.readFileSync(migrationUrl, 'utf8');
  const appTables = currentAppTables(schema);

  assert.ok(appTables.length > 0, 'fresh schema must declare application tables');
  assert.deepEqual(rowLevelSecurityTables(migration), appTables);
  assert.deepEqual(rowLevelSecurityTables(schema), appTables);
  assert.doesNotMatch(migration, /create\s+policy/i, 'server-only tables must not add public RLS policies');
  assertServerOnlyPrivileges(migration, 'forward migration');
  assertServerOnlyPrivileges(schema, 'fresh schema');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const schemaUrl = new URL('../supabase/schema.sql', import.meta.url);
const migrationUrl = new URL(
  '../supabase/migrations/20260713104500_supabase_service_role_isolation.sql',
  import.meta.url,
);
const analyticsMigrationUrl = new URL(
  '../supabase/migrations/20260714193000_privacy_conscious_analytics.sql',
  import.meta.url,
);
const cimAutomationMigrationUrl = new URL(
  '../supabase/migrations/20260719160000_cim_automation_learning.sql',
  import.meta.url,
);
const communicationsLifecycleMigrationUrl = new URL(
  '../supabase/migrations/20260806120000_crm_communications_lifecycle.sql',
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

function assertServiceRoleOnlyFunction(sql, sourceLabel, functionName) {
  assert.match(
    sql,
    new RegExp(
      `revoke all on function public\\.${functionName}\\([^;]*\\)\\s*from public, anon, authenticated;`,
      'i',
    ),
    `${sourceLabel} must revoke public execution of ${functionName}`,
  );
  assert.match(
    sql,
    new RegExp(`grant execute on function public\\.${functionName}\\([^;]*\\)\\s*to service_role;`, 'i'),
    `${sourceLabel} must grant service-role execution of ${functionName}`,
  );
}

test('Supabase migration and fresh schema isolate every current app table to the server role', () => {
  const schema = fs.readFileSync(schemaUrl, 'utf8');
  const migration = fs.readFileSync(migrationUrl, 'utf8');
  const analyticsMigration = fs.readFileSync(analyticsMigrationUrl, 'utf8');
  const cimAutomationMigration = fs.readFileSync(cimAutomationMigrationUrl, 'utf8');
  const communicationsLifecycleMigration = fs.readFileSync(communicationsLifecycleMigrationUrl, 'utf8');
  const forwardMigrations = `${migration}\n${analyticsMigration}\n${cimAutomationMigration}\n${communicationsLifecycleMigration}`;
  const appTables = currentAppTables(schema);

  assert.ok(appTables.length > 0, 'fresh schema must declare application tables');
  assert.deepEqual(rowLevelSecurityTables(forwardMigrations), appTables);
  assert.deepEqual(rowLevelSecurityTables(schema), appTables);
  assert.doesNotMatch(migration, /create\s+policy/i, 'server-only tables must not add public RLS policies');
  assert.doesNotMatch(analyticsMigration, /create\s+policy/i, 'analytics table must not add public RLS policies');
  assert.doesNotMatch(communicationsLifecycleMigration, /create\s+policy/i, 'communications tables must not add public RLS policies');
  assertServerOnlyPrivileges(migration, 'forward migration');
  assert.match(analyticsMigration, /revoke all privileges on table public\.analytics_events from public, anon, authenticated;/i);
  assert.match(analyticsMigration, /grant all privileges on table public\.analytics_events to service_role;/i);
  for (const tableName of ['crm_communications', 'deal_hunter_dispositions']) {
    assert.match(
      communicationsLifecycleMigration,
      new RegExp(`revoke all privileges on table public\\.${tableName} from public, anon, authenticated;`, 'i'),
    );
    assert.match(
      communicationsLifecycleMigration,
      new RegExp(`grant all privileges on table public\\.${tableName} to service_role;`, 'i'),
    );
  }
  const serviceRoleFunctions = [
    'canonical_listing_identity',
    'delete_crm_submission_lifecycle',
    'claim_crm_communications_pending_ingestion',
    'claim_deal_hunter_cim_request',
    'claim_deal_hunter_cim_follow_up_request',
    'renew_deal_hunter_cim_request_claim',
    'list_submissions_by_contact_email',
    'mutate_communications_with_crm_activity',
    'list_deal_hunter_cim_request_history',
  ];
  for (const functionName of serviceRoleFunctions) {
    assertServiceRoleOnlyFunction(
      communicationsLifecycleMigration,
      'communications lifecycle migration',
      functionName,
    );
    assertServiceRoleOnlyFunction(schema, 'fresh schema', functionName);
  }
  const renewalCasGuard = /p_expected_updated_at is null[\s\S]*nullif\(btrim\(p_expected_status\), ''\) is null[\s\S]*p_renewed_at is null[\s\S]*v_current\.updated_at is distinct from p_expected_updated_at[\s\S]*v_current\.status is distinct from p_expected_status/i;
  assert.match(schema, renewalCasGuard, 'fresh schema renewal CAS must reject null or mismatched expectations');
  assert.match(
    communicationsLifecycleMigration,
    renewalCasGuard,
    'forward migration renewal CAS must reject null or mismatched expectations',
  );
  for (const [sourceLabel, sql] of [
    ['fresh schema', schema],
    ['communications lifecycle migration', communicationsLifecycleMigration],
  ]) {
    assert.equal(
      (sql.match(/'reason', 'missing-expected-version'/gi) || []).length,
      2,
      `${sourceLabel} must reject versionless archive and dismissal mutations`,
    );
    assert.equal(
      (sql.match(/and submission\.updated_at = \(p_payload ->> 'expectedUpdatedAt'\)::timestamptz/gi) || []).length,
      2,
      `${sourceLabel} must apply exact lifecycle compare-and-swap predicates`,
    );
    assert.match(
      sql,
      /deal_key = coalesce\(nullif\(p_payload ->> 'dealKey', ''\), communication\.deal_key\)[\s\S]*cim_request_id = coalesce\(nullif\(p_payload ->> 'cimRequestId', ''\), communication\.cim_request_id\)[\s\S]*metadata = case when p_payload \? 'metadata'/i,
      `${sourceLabel} must link inbound CIM assignment fields in the atomic mutation`,
    );
  }
  assertServerOnlyPrivileges(schema, 'fresh schema');
});

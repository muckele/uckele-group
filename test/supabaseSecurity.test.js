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
const followUpWorkspaceMigrationUrl = new URL(
  '../supabase/migrations/20260809120000_crm_follow_up_workspace.sql',
  import.meta.url,
);
const followUpQueueMigrationUrl = new URL(
  '../supabase/migrations/20260809123000_follow_up_queue_pagination.sql',
  import.meta.url,
);
const dealOsMigrationUrl = new URL(
  '../supabase/migrations/20260810130000_deal_os_exports.sql',
  import.meta.url,
);
const adminOnboardingMigrationUrl = new URL(
  '../supabase/migrations/20260810143000_admin_onboarding_progress.sql',
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
  const followUpWorkspaceMigration = fs.readFileSync(followUpWorkspaceMigrationUrl, 'utf8');
  const followUpQueueMigration = fs.readFileSync(followUpQueueMigrationUrl, 'utf8');
  const dealOsMigration = fs.readFileSync(dealOsMigrationUrl, 'utf8');
  const adminOnboardingMigration = fs.readFileSync(adminOnboardingMigrationUrl, 'utf8');
  const forwardMigrations = `${migration}\n${analyticsMigration}\n${cimAutomationMigration}\n${communicationsLifecycleMigration}\n${followUpWorkspaceMigration}\n${followUpQueueMigration}\n${dealOsMigration}\n${adminOnboardingMigration}`;
  const appTables = currentAppTables(schema);

  assert.ok(appTables.length > 0, 'fresh schema must declare application tables');
  assert.deepEqual(rowLevelSecurityTables(forwardMigrations), appTables);
  assert.deepEqual(rowLevelSecurityTables(schema), appTables);
  assert.doesNotMatch(migration, /create\s+policy/i, 'server-only tables must not add public RLS policies');
  assert.doesNotMatch(analyticsMigration, /create\s+policy/i, 'analytics table must not add public RLS policies');
  assert.doesNotMatch(communicationsLifecycleMigration, /create\s+policy/i, 'communications tables must not add public RLS policies');
  assert.doesNotMatch(followUpWorkspaceMigration, /create\s+policy/i, 'follow-up tables must not add public RLS policies');
  assert.doesNotMatch(dealOsMigration, /create\s+policy/i, 'Deal OS import table must not add public RLS policies');
  assert.doesNotMatch(adminOnboardingMigration, /create\s+policy/i, 'onboarding preference table must not add public RLS policies');
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
  for (const tableName of ['crm_email_outbox', 'crm_follow_up_recommendations', 'email_suppressions']) {
    assert.match(
      followUpWorkspaceMigration,
      new RegExp(`revoke all privileges on table public\\.${tableName} from public, anon, authenticated;`, 'i'),
    );
    assert.match(
      followUpWorkspaceMigration,
      new RegExp(`grant all privileges on table public\\.${tableName} to service_role;`, 'i'),
    );
  }
  assert.match(dealOsMigration, /revoke all privileges on table public\.deal_hunter_deal_os_imports from public, anon, authenticated;/i);
  assert.match(dealOsMigration, /grant all privileges on table public\.deal_hunter_deal_os_imports to service_role;/i);
  assert.match(adminOnboardingMigration, /revoke all privileges on table public\.admin_onboarding_progress from public, anon, authenticated;/i);
  assert.match(adminOnboardingMigration, /grant all privileges on table public\.admin_onboarding_progress to service_role;/i);
  assert.match(adminOnboardingMigration, /p_step_ids\s+text\[\]/i);
  assert.match(adminOnboardingMigration, /array_position\(p_step_ids,\s*excluded\.last_completed_step_id\)/i);
  assertServiceRoleOnlyFunction(adminOnboardingMigration, 'admin onboarding migration', 'upsert_admin_onboarding_progress');
  assertServiceRoleOnlyFunction(schema, 'fresh schema', 'upsert_admin_onboarding_progress');
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
    'create_crm_email_command',
    'supersede_crm_follow_up_recommendations_from_related_change',
    'claim_crm_email_outbox',
    'finish_crm_email_outbox_claim',
    'count_crm_follow_up_sends',
    'get_crm_follow_up_operational_metrics',
    'list_follow_up_submissions_page',
  ];
  for (const functionName of serviceRoleFunctions) {
    const sourceSql = [
      'count_crm_follow_up_sends',
      'get_crm_follow_up_operational_metrics',
      'list_follow_up_submissions_page',
    ].includes(functionName)
      ? followUpQueueMigration
      : [
          'create_crm_email_command',
          'supersede_crm_follow_up_recommendations_from_related_change',
          'claim_crm_email_outbox',
          'finish_crm_email_outbox_claim',
        ].includes(functionName)
        ? followUpWorkspaceMigration
        : communicationsLifecycleMigration;
    const sourceLabel = sourceSql === followUpQueueMigration
      ? 'follow-up queue migration'
      : sourceSql === followUpWorkspaceMigration
        ? 'follow-up workspace migration'
        : 'communications lifecycle migration';
    assertServiceRoleOnlyFunction(
      sourceSql,
      sourceLabel,
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

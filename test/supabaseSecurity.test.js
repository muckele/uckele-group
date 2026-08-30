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
const cimIdentityMigrationUrl = new URL(
  '../supabase/migrations/20260812130000_cim_canonical_identity_safety.sql',
  import.meta.url,
);
const cimStage2MigrationUrl = new URL(
  '../supabase/migrations/20260813120000_cim_stage2_guarded_rollout.sql',
  import.meta.url,
);
const crmReconciliationMigrationUrl = new URL(
  '../supabase/migrations/20260814120000_deal_os_crm_reconciliation.sql',
  import.meta.url,
);
const opportunityScoringMigrationUrl = new URL(
  '../supabase/migrations/20260816120000_deal_hunter_opportunity_scoring.sql',
  import.meta.url,
);
const semanticScoringMigrationUrl = new URL(
  '../supabase/migrations/20260817090000_deal_hunter_semantic_scoring.sql',
  import.meta.url,
);
const currentTriageEligibilityMigrationUrl = new URL(
  '../supabase/migrations/20260826120000_deal_hunter_current_triage_eligibility.sql',
  import.meta.url,
);
const opportunityFactsMigrationUrl = new URL(
  '../supabase/migrations/20260830120000_deal_hunter_opportunity_facts.sql',
  import.meta.url,
);
const opportunityFactWriteBoundaryMigrationUrl = new URL(
  '../supabase/migrations/20260830130000_deal_hunter_opportunity_fact_write_boundary.sql',
  import.meta.url,
);
const acquisitionInboxQueueMigrationUrl = new URL(
  '../supabase/migrations/20260830150000_acquisition_inbox_queue.sql',
  import.meta.url,
);
const canonicalCurrentSemanticsMigrationUrl = new URL(
  '../supabase/migrations/20260827120000_canonical_opportunity_current_semantics.sql',
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
      `revoke all(?: privileges)? on function public\\.${functionName}\\([^;]*\\)\\s*from public, anon, authenticated;`,
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

function sqlFunctionDefinitions(sql) {
  const starts = [...sql.matchAll(/^create or replace function public\.([a-z0-9_]+)\b/gim)];
  return starts.map((match, index) => ({
    name: match[1],
    sql: sql.slice(match.index, starts[index + 1]?.index ?? sql.length),
  }));
}

function canonicalOpportunityRowLockIndex(functionSql) {
  const match = /from\s+public\.deal_hunter_opportunities\b[\s\S]*?for\s+update\b/i.exec(functionSql);
  return match?.index ?? -1;
}

function mutatesCanonicalOpportunityAliases(functionSql) {
  return /(?:insert\s+into|update|delete\s+from)\s+public\.deal_hunter_opportunity_aliases\b/i
    .test(functionSql);
}

test('Acquisition Inbox queue SQL keeps filtering, ordering, summary, and lightweight projection in the database', () => {
  const migration = fs.readFileSync(acquisitionInboxQueueMigrationUrl, 'utf8');
  const schema = fs.readFileSync(schemaUrl, 'utf8');
  for (const [sourceLabel, sql] of [
    ['Acquisition Inbox migration', migration],
    ['fresh schema', schema],
  ]) {
    const functionSql = sqlFunctionDefinitions(sql).find(({ name }) => name === 'list_deal_hunter_opportunity_scores')?.sql || '';
    assertServiceRoleOnlyFunction(sql, sourceLabel, 'list_deal_hunter_opportunity_scores');
    assert.match(functionSql, /security definer[\s\S]*?set search_path = public/i);
    assert.match(functionSql, /current_triage_eligible = true[\s\S]*?limit least[\s\S]*?offset greatest/i);
    assert.match(functionSql, /needsReview[\s\S]*?highPriority[\s\S]*?watchlist[\s\S]*?lowConfidence[\s\S]*?currentOpportunities/i);
    assert.match(functionSql, /operator_priority in \('urgent', 'high'\)[\s\S]*?high_fit[\s\S]*?fit_score[\s\S]*?confidence[\s\S]*?observation_freshness[\s\S]*?opportunity_id asc/i);
    assert.match(functionSql, /source\.field = 'annual_profit'[\s\S]*?source\.field = 'profit_multiple'/i);
    assert.doesNotMatch(functionSql, /scores\.\*|scores\.(?:dimensions|gates|missing_evidence|confidence_reasons)\b/i,
      `${sourceLabel} queue RPC must not return full score/evidence JSON`);
    assert.match(sql, /idx_deal_hunter_scores_acquisition_priority/i);
    assert.match(sql, /idx_deal_hunter_source_observations_queue_projection/i);
  }
});

test('every canonical alias lock participant acquires the complete sorted alias lock set before opportunity rows', () => {
  const migration = fs.readFileSync(canonicalCurrentSemanticsMigrationUrl, 'utf8');
  const schema = fs.readFileSync(schemaUrl, 'utf8');

  for (const [sourceLabel, sql, expectedAliasMutators] of [
    [
      'canonical current semantics migration',
      migration,
      [
        'create_deal_hunter_opportunity_with_aliases',
        'link_deal_hunter_opportunity_aliases',
      ],
    ],
    [
      'fresh schema',
      schema,
      [
        'apply_deal_hunter_cim_identity_repair',
        'create_deal_hunter_opportunity_with_aliases',
        'link_deal_hunter_opportunity_aliases',
      ],
    ],
  ]) {
    const definitions = sqlFunctionDefinitions(sql);
    const aliasMutators = definitions
      .filter(({ sql: functionSql }) => mutatesCanonicalOpportunityAliases(functionSql))
      .map(({ name }) => name)
      .sort();
    assert.deepEqual(
      aliasMutators,
      expectedAliasMutators,
      `${sourceLabel} canonical alias-writer audit must remain complete`,
    );

    const participants = definitions.filter(({ sql: functionSql }) => (
      functionSql.includes('deal-hunter-opportunity-alias:')
      && canonicalOpportunityRowLockIndex(functionSql) >= 0
    ));
    assert.deepEqual(
      participants.map(({ name }) => name).sort(),
      [
        'create_deal_hunter_opportunity_with_aliases',
        'link_deal_hunter_opportunity_aliases',
      ],
      `${sourceLabel} canonical alias/opportunity cross-resource lock matrix must remain complete`,
    );

    for (const { name, sql: functionSql } of participants) {
      const aliasLockIndex = functionSql.indexOf('deal-hunter-opportunity-alias:');
      const opportunityRowLockIndex = canonicalOpportunityRowLockIndex(functionSql);
      assert.ok(
        aliasLockIndex < opportunityRowLockIndex,
        `${sourceLabel} ${name} must acquire canonical alias advisory locks before canonical opportunity row locks`,
      );
      assert.match(
        functionSql,
        /for\s+v_alias_key\s+in\s+select\s+distinct\s+item\.value->>'alias_key'\s+as\s+alias_key\s+from\s+jsonb_array_elements\(p_aliases\)\s+as\s+item\(value\)\s+order\s+by\s+alias_key\s+loop\s+perform\s+pg_catalog\.pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\s*\(\s*'deal-hunter-opportunity-alias:'\s*\|\|\s*v_alias_key\s*,\s*0\s*\)\s*\)/i,
        `${sourceLabel} ${name} must lock every distinct input alias in order with the canonical advisory namespace, hash, and seed`,
      );
    }
  }
});

test('canonical current semantics migration is function-only and guards every atomic Supabase authority boundary', () => {
  const migration = fs.readFileSync(canonicalCurrentSemanticsMigrationUrl, 'utf8');
  const schema = fs.readFileSync(schemaUrl, 'utf8');

  assert.doesNotMatch(migration, /\b(?:create|alter|drop)\s+table\b/i);
  assert.doesNotMatch(migration, /\b(?:add|drop)\s+column\b/i);
  assert.doesNotMatch(migration, /\b(?:create|alter)\s+type\b/i);
  for (const [sourceLabel, sql] of [
    ['canonical current semantics migration', migration],
    ['fresh schema', schema],
  ]) {
    assertServiceRoleOnlyFunction(
      sql,
      sourceLabel,
      'create_deal_hunter_opportunity_with_aliases',
    );
    assert.match(
      sql,
      /create_deal_hunter_opportunity_with_aliases[\s\S]*?for\s+v_alias_key\s+in[\s\S]*?order\s+by\s+alias_key[\s\S]*?pg_advisory_xact_lock[\s\S]*?deal-hunter-opportunity-alias:/i,
      `${sourceLabel} must acquire deterministic alias locks before choosing an owner`,
    );
    assert.match(
      sql,
      /create_deal_hunter_opportunity_with_aliases[\s\S]*?insert\s+into\s+public\.deal_hunter_opportunities[\s\S]*?insert\s+into\s+public\.deal_hunter_opportunity_aliases[\s\S]*?update\s+public\.deal_hunter_identity_exceptions/i,
      `${sourceLabel} must keep creation, alias acquisition, and optional exception resolution in one function`,
    );
  }

  const preservedSignatures = [
    ['claim_deal_hunter_cim_opportunity', /\(\s*p_opportunity_id\s+text,\s*p_request_id\s+text,\s*p_recipient_email\s+text,\s*p_allowed_request_ids\s+text\[\],\s*p_claimed_at\s+timestamptz,\s*p_metadata\s+jsonb\s+default\s+'\{\}'::jsonb\s*\)/i],
    ['claim_deal_hunter_cim_recipient', /\(\s*p_recipient_email\s+text,\s*p_request_id\s+text,\s*p_opportunity_id\s+text,\s*p_claimed_at\s+timestamptz,\s*p_expires_at\s+timestamptz,\s*p_metadata\s+jsonb\s+default\s+'\{\}'::jsonb\s*\)/i],
    ['link_deal_hunter_opportunity_aliases', /\(p_aliases\s+jsonb\)/i],
    ['link_deal_hunter_crm_submission', /\(\s*p_opportunity_id\s+text,\s*p_submission_id\s+uuid,\s*p_updated_at\s+timestamptz\s*\)/i],
    ['write_deal_hunter_opportunity_score', /\(p_score\s+jsonb,\s*p_evidence\s+jsonb\)/i],
    ['reconcile_deal_hunter_current_score_eligibility', /\(p_opportunity_ids\s+text\[\]\)/i],
    ['list_deal_hunter_opportunity_scores', /\(\s*p_view\s+text,\s*p_page\s+integer,\s*p_page_size\s+integer,\s*p_search\s+text,\s*p_sort\s+text,\s*p_direction\s+text,\s*p_min_score\s+integer,\s*p_confidence\s+text,\s*p_priority\s+text,\s*p_state\s+text\s*\)/i],
  ];
  for (const [functionName, signature] of preservedSignatures) {
    assert.match(migration, new RegExp(`create or replace function public\\.${functionName}${signature.source}`, 'i'));
    assertServiceRoleOnlyFunction(migration, 'canonical current semantics migration', functionName);
    assertServiceRoleOnlyFunction(schema, 'fresh schema', functionName);
  }

  for (const functionName of [
    'insert_submission_with_crm_activity',
    'upsert_deal_hunter_opportunity',
    'upsert_deal_hunter_cim_recipient_override',
    'set_deal_hunter_opportunity_operator_decision',
  ]) {
    assertServiceRoleOnlyFunction(migration, 'canonical current semantics migration', functionName);
    assertServiceRoleOnlyFunction(schema, 'fresh schema', functionName);
  }

  for (const [sourceLabel, sql] of [
    ['canonical current semantics migration', migration],
    ['fresh schema', schema],
  ]) {
    assert.match(sql, /deal_hunter_opportunities[\s\S]{0,400}status\s*=\s*'active'[\s\S]{0,200}for update/i,
      `${sourceLabel} must lock and validate active canonical authority inside mutation functions`);
    assert.match(sql, /create or replace function public\.insert_submission_with_crm_activity[\s\S]*?from public\.deal_hunter_opportunities[\s\S]*?status\s*=\s*'active'[\s\S]*?for update[\s\S]*?insert into public\.contact_submissions/i,
      `${sourceLabel} must validate and lock active canonical authority inside the CRM insert transaction`);
    assert.match(sql, /upsert_deal_hunter_opportunity[\s\S]*?on conflict\s*\(opportunity_id\)[\s\S]*?where\s+public\.deal_hunter_opportunities\.status\s*=\s*'active'/i,
      `${sourceLabel} must never update a superseded opportunity through the ordinary observation upsert`);
    assert.match(sql, /claim_deal_hunter_cim_opportunity[\s\S]*?opportunity-not-current/i);
    assert.match(sql, /claim_deal_hunter_cim_recipient[\s\S]*?opportunity-not-current/i);
    assert.match(sql, /link_deal_hunter_crm_submission[\s\S]*?status\s*=\s*'active'/i);
    assert.match(sql, /reconcile_deal_hunter_current_score_eligibility[\s\S]*?join\s+public\.deal_hunter_opportunities[\s\S]*?status\s*=\s*'active'/i);
    assert.match(sql, /list_deal_hunter_opportunity_scores[\s\S]*?with\s+candidates[\s\S]*?join\s+public\.deal_hunter_opportunities[\s\S]*?status\s*=\s*'active'[\s\S]*?limit\s+least/i,
      `${sourceLabel} must filter active opportunities in the database before triage pagination`);
    assert.match(sql, /upsert_deal_hunter_cim_recipient_override[\s\S]*?select\s+opportunity_id\s+into\s+v_existing_opportunity_id[\s\S]*?v_existing_opportunity_id\s*<>\s*v_opportunity_id/i,
      `${sourceLabel} must reject recipient-override ID collisions across canonical owners`);
    assert.match(sql, /upsert_deal_hunter_cim_recipient_override[\s\S]*?on conflict\s*\(id\)\s*do update[\s\S]*?where\s+public\.deal_hunter_cim_recipient_overrides\.opportunity_id\s*=\s*excluded\.opportunity_id/i,
      `${sourceLabel} must make the recipient-override conflict update owner-preserving`);
  }
});

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
  const cimIdentityMigration = fs.readFileSync(cimIdentityMigrationUrl, 'utf8');
  const cimStage2Migration = fs.readFileSync(cimStage2MigrationUrl, 'utf8');
  const crmReconciliationMigration = fs.readFileSync(crmReconciliationMigrationUrl, 'utf8');
  const opportunityScoringMigration = fs.readFileSync(opportunityScoringMigrationUrl, 'utf8');
  const semanticScoringMigration = fs.readFileSync(semanticScoringMigrationUrl, 'utf8');
  const currentTriageEligibilityMigration = fs.readFileSync(currentTriageEligibilityMigrationUrl, 'utf8');
  const opportunityFactsMigration = fs.readFileSync(opportunityFactsMigrationUrl, 'utf8');
  const opportunityFactWriteBoundaryMigration = fs.readFileSync(opportunityFactWriteBoundaryMigrationUrl, 'utf8');
  const forwardMigrations = `${migration}\n${analyticsMigration}\n${cimAutomationMigration}\n${communicationsLifecycleMigration}\n${followUpWorkspaceMigration}\n${followUpQueueMigration}\n${dealOsMigration}\n${adminOnboardingMigration}\n${cimIdentityMigration}\n${cimStage2Migration}\n${crmReconciliationMigration}\n${opportunityScoringMigration}\n${semanticScoringMigration}\n${currentTriageEligibilityMigration}\n${opportunityFactsMigration}\n${opportunityFactWriteBoundaryMigration}`;
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
  assert.doesNotMatch(cimIdentityMigration, /create\s+policy/i, 'canonical CIM identity tables must not add public RLS policies');
  assert.doesNotMatch(cimStage2Migration, /create\s+policy/i, 'Stage 2 authorization tables must not add public RLS policies');
  assert.doesNotMatch(crmReconciliationMigration, /create\s+policy/i, 'CRM reconciliation tables must not add public RLS policies');
  assert.doesNotMatch(opportunityFactsMigration, /create\s+policy/i, 'opportunity fact tables must not add public RLS policies');
  assert.doesNotMatch(opportunityFactWriteBoundaryMigration, /create\s+policy/i, 'opportunity fact write boundary must not add public RLS policies');
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
  for (const tableName of ['deal_hunter_opportunity_facts', 'deal_hunter_opportunity_source_observations']) {
    assert.match(
      opportunityFactsMigration,
      new RegExp(`revoke all privileges on table public\\.${tableName} from public, anon, authenticated;`, 'i'),
    );
    assert.match(
      opportunityFactsMigration,
      new RegExp(`grant all privileges on table public\\.${tableName} to service_role;`, 'i'),
    );
  }
  for (const [sourceLabel, sql] of [
    ['opportunity fact write-boundary migration', opportunityFactWriteBoundaryMigration],
    ['fresh schema', schema],
  ]) {
    assertServiceRoleOnlyFunction(sql, sourceLabel, 'upsert_deal_hunter_opportunity_fact');
    assertServiceRoleOnlyFunction(sql, sourceLabel, 'upsert_deal_hunter_opportunity_source_observation');
  }
  assert.match(opportunityFactWriteBoundaryMigration, /deal_hunter_opportunity_source_observations_bounded_check/i);
  assert.match(
    opportunityFactWriteBoundaryMigration,
    /add constraint deal_hunter_opportunity_source_observations_bounded_check[\s\S]*?\) not valid;/i,
  );
  assert.doesNotMatch(
    opportunityFactWriteBoundaryMigration,
    /validate constraint deal_hunter_opportunity_source_observations_bounded_check/i,
  );
  assert.match(schema, /deal_hunter_opportunity_source_observations_bounded_check/i);
  assert.match(adminOnboardingMigration, /array_position\(p_step_ids,\s*excluded\.last_completed_step_id\)/i);
  assertServiceRoleOnlyFunction(adminOnboardingMigration, 'admin onboarding migration', 'upsert_admin_onboarding_progress');
  assertServiceRoleOnlyFunction(schema, 'fresh schema', 'upsert_admin_onboarding_progress');
  for (const tableName of ['deal_hunter_crm_reconciliation_runs', 'deal_hunter_crm_reconciliation_items']) {
    assert.match(crmReconciliationMigration, new RegExp(`revoke all privileges on table public\\.${tableName} from public, anon, authenticated;`, 'i'));
    assert.match(crmReconciliationMigration, new RegExp(`grant all privileges on table public\\.${tableName} to service_role;`, 'i'));
  }
  assertServiceRoleOnlyFunction(crmReconciliationMigration, 'CRM reconciliation migration', 'start_deal_hunter_crm_reconciliation');
  assertServiceRoleOnlyFunction(crmReconciliationMigration, 'CRM reconciliation migration', 'link_deal_hunter_crm_submission');
  assert.match(crmReconciliationMigration, /select deal_hunter_opportunity_id[\s\S]*for update/i);
  assert.match(crmReconciliationMigration, /CRM submission already belongs to another canonical opportunity/i);
  assertServiceRoleOnlyFunction(schema, 'fresh schema', 'start_deal_hunter_crm_reconciliation');
  assertServiceRoleOnlyFunction(schema, 'fresh schema', 'link_deal_hunter_crm_submission');
  assertServiceRoleOnlyFunction(
    currentTriageEligibilityMigration,
    'current triage eligibility migration',
    'reconcile_deal_hunter_current_score_eligibility',
  );
  assertServiceRoleOnlyFunction(schema, 'fresh schema', 'reconcile_deal_hunter_current_score_eligibility');
  for (const [sourceLabel, sql] of [
    ['current triage eligibility migration', currentTriageEligibilityMigration],
    ['fresh schema', schema],
  ]) {
    assert.match(
      sql,
      /current_triage_eligible\s+boolean/i,
      `${sourceLabel} must define a current-triage eligibility marker`,
    );
    assert.match(
      sql,
      /current_triage_eligible\s+boolean\s+not null\s+default\s+false|alter column current_triage_eligible set not null/i,
      `${sourceLabel} must make current-triage eligibility non-null`,
    );
    assert.match(
      sql,
      /where\s+scores\.current_triage_eligible\s*=\s*true/i,
      `${sourceLabel} must filter triage rows before count, filters, sorting, and pagination`,
    );
    assert.match(
      sql,
      /update\s+public\.deal_hunter_opportunity_scores[\s\S]*current_triage_eligible\s*=\s*case[\s\S]*opportunity_id\s*=\s*any\s*\(/i,
      `${sourceLabel} must reconcile the complete current set in one database statement`,
    );
  }
  assert.match(
    currentTriageEligibilityMigration,
    /add column if not exists current_triage_eligible boolean/i,
    'the forward migration must safely add the marker to existing installations',
  );
  assert.match(
    currentTriageEligibilityMigration,
    /set current_triage_eligible = true\s+where current_triage_eligible is null/i,
    'existing score rows must retain their last-good current visibility during migration',
  );
  assert.match(
    currentTriageEligibilityMigration,
    /alter column current_triage_eligible set default false[\s\S]*alter column current_triage_eligible set not null/i,
    'new score rows must be inactive until an authoritative reconciliation',
  );
  for (const tableName of [
    'deal_hunter_opportunities',
    'deal_hunter_opportunity_aliases',
    'deal_hunter_identity_exceptions',
    'deal_hunter_cim_opportunity_claims',
    'deal_hunter_cim_recipient_overrides',
    'deal_hunter_cim_recipient_claims',
    'deal_hunter_cim_safety_settings',
    'deal_hunter_cim_repair_manifests',
  ]) {
    assert.match(
      cimIdentityMigration,
      new RegExp(`revoke all privileges on table public\\.${tableName} from public, anon, authenticated;`, 'i'),
    );
    assert.match(
      cimIdentityMigration,
      new RegExp(`grant all privileges on table public\\.${tableName} to service_role;`, 'i'),
    );
  }
  for (const functionName of [
    'claim_deal_hunter_cim_opportunity',
    'claim_deal_hunter_cim_recipient',
    'apply_deal_hunter_cim_identity_repair',
  ]) {
    assertServiceRoleOnlyFunction(cimIdentityMigration, 'canonical CIM identity migration', functionName);
    assertServiceRoleOnlyFunction(schema, 'fresh schema', functionName);
  }
  for (const [sourceLabel, sql] of [
    ['canonical CIM identity migration', cimIdentityMigration],
    ['fresh schema', schema],
  ]) {
    assert.match(sql, /pg_advisory_xact_lock[\s\S]*deal-hunter-cim-opportunity:/i, `${sourceLabel} must serialize canonical opportunity claims`);
    assert.match(sql, /pg_advisory_xact_lock[\s\S]*deal-hunter-cim-recipient:/i, `${sourceLabel} must serialize recipient claims`);
    assert.equal(
      (sql.match(/expected_updated_at/gi) || []).length >= 3,
      true,
      `${sourceLabel} must compare audited repair versions before mutable relationship updates`,
    );
  }
  for (const tableName of [
    'deal_hunter_cim_stage2_activations',
    'deal_hunter_cim_stage2_runs',
    'deal_hunter_cim_stage2_decisions',
  ]) {
    assert.match(cimStage2Migration, new RegExp(`revoke all privileges on table public\\.${tableName} from public, anon, authenticated;`, 'i'));
    assert.match(cimStage2Migration, new RegExp(`grant all privileges on table public\\.${tableName} to service_role;`, 'i'));
  }
  for (const functionName of ['create_cim_stage2_activation', 'claim_cim_stage2_decision']) {
    assertServiceRoleOnlyFunction(cimStage2Migration, 'Stage 2 guarded rollout migration', functionName);
    assertServiceRoleOnlyFunction(schema, 'fresh schema', functionName);
  }
  assert.match(cimStage2Migration, /pg_advisory_xact_lock[\s\S]*deal-hunter-cim-stage2-activation/i);
  assert.match(cimStage2Migration, /pg_advisory_xact_lock[\s\S]*deal-hunter-cim-stage2-decision:/i);
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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSupabaseStorage } from '../server/storage/supabase.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  CRM_SUBMISSION_SUPERSEDED,
  CRM_SUPERSESSION_UNAVAILABLE,
} from '../server/services/crmSubmissionSupersession.js';
import { passTriageOpportunity } from '../server/services/dealHunterTriage.js';

const migrationUrl = new URL('../supabase/migrations/20260830200000_atomic_acquisition_inbox_pass.sql', import.meta.url);
const schemaUrl = new URL('../supabase/schema.sql', import.meta.url);

function functionDefinition(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  const end = sql.indexOf('\n$$;', start);
  return start >= 0 && end >= start ? sql.slice(start, end + 4) : '';
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function passSubmission(id, opportunityId = null) {
  const now = '2026-09-17T19:00:00.000Z';
  return {
    id, created_at: now, updated_at: now, status: 'review', spam_score: 0, spam_reasons: [],
    delivery_provider: 'manual', delivery_status: 'not-applicable', delivery_error: null,
    crm_status: 'not-applicable', crm_error: null, source: 'atomic-pass-guard', ip_hash: '',
    user_agent: '', name: id, email: `${id}@example.test`, phone: '', company: id, role: '',
    message: 'fixture', status_updated_at: now, listing_url: '', business_website: '', prospectus_url: '',
    asking_price: '', ttm_revenue: '', ttm_ebitda: '', ebitda_multiple: '', net_margin: '',
    business_age: '', sba_eligible: 'unknown', broker_name: '', broker_email: '', broker_phone: '',
    seller_name: '', seller_email: '', seller_phone: '', lead_type: 'broker', priority: 'normal', tags: [],
    assigned_to: '', notes: '', follow_up_state: 'needs-response', next_action_at: null,
    last_contacted_at: null, deal_hunter_opportunity_id: opportunityId, metadata: {},
  };
}

function passGuardHash(sqlitePath) {
  const database = new Database(sqlitePath, { readonly: true });
  const rows = {
    contacts: database.prepare('SELECT * FROM contact_submissions ORDER BY id').all(),
    dispositions: database.prepare('SELECT * FROM deal_hunter_dispositions ORDER BY id').all(),
    activity: database.prepare('SELECT * FROM crm_activity_events ORDER BY id').all(),
    cleanupJobs: database.prepare('SELECT * FROM secure_document_cleanup_jobs ORDER BY id').all(),
    opportunityPrimary: database.prepare('SELECT opportunity_id, primary_submission_id FROM deal_hunter_opportunities ORDER BY opportunity_id').all(),
  };
  database.close();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

test('SQLite atomic Pass rejects an explicitly linked superseded submission before any mutation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-atomic-pass-guard-'));
  const sqlitePath = path.join(directory, 'storage.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = '2026-09-17T19:00:00.000Z';
  const digest = 'b'.repeat(64);
  await storage.insertSubmission(passSubmission('survivor', 'pass-opportunity'));
  await storage.insertSubmission(passSubmission('loser'));
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'pass-opportunity', created_at: now, updated_at: now,
    canonical_name: 'Atomic Pass Guard', canonical_recipient: null, canonical_location: null,
    primary_submission_id: 'survivor', identity_version: 'atomic-pass-guard-v1', status: 'active', metadata: {},
  });
  await storage.writeDealHunterOpportunityScore({
    opportunity_id: 'pass-opportunity', scored_at: now, deal_key: 'atomic-pass-guard-deal',
    name: 'Atomic Pass Guard', state: 'CA', listing_url: 'https://example.test/atomic-pass-guard',
    fit_score: 80, score_status: 'high-fit', confidence: 'high', completeness_score: 90,
    contradiction_count: 0, missing_evidence_count: 0, should_remove: false, high_fit: true, gate_count: 0,
    score_fingerprint: 'atomic-pass-guard-fingerprint', semantic_digest: 'atomic-pass-guard-digest',
    engine_version: 'test', rules_version: 'test', profile_version: 'test', completeness_policy_version: 'test',
    dimensions: [], gates: [], applied_caps: [], missing_evidence: [], confidence_reasons: [], summary: {},
  }, []);
  await storage.reconcileDealHunterCurrentScoreEligibility(['pass-opportunity']);
  await storage.upsertDealHunterCimRepairManifest({
    id: 'pass-receipt', created_at: now, updated_at: now, mode: 'crm-duplicate-consolidation',
    status: 'applied', actor: 'test', backup_reference: 'backup', checksum: digest,
    manifest: { version: 1 }, metadata: {},
  });
  const database = new Database(sqlitePath);
  database.prepare(`
    INSERT INTO crm_submission_supersessions (
      id, created_at, updated_at, status, survivor_submission_id, superseded_submission_id,
      opportunity_id, reason_code, reason_text, approved_by, approved_at, actor,
      repair_version, repair_manifest_id, repair_digest, metadata
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, 'confirmed-duplicate', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'pass-relation', now, now, 'survivor', 'loser', 'pass-opportunity', 'Reviewed duplicate.',
    'owner@example.test', now, 'test', 'v1', 'pass-receipt', digest, '{}',
  );
  database.close();

  const before = passGuardHash(sqlitePath);
  await assert.rejects(storage.passDealHunterOpportunity({
    opportunityId: 'pass-opportunity',
    submissionId: 'loser',
    reason: 'not-a-fit',
    note: 'Must not mutate.',
    actor: 'test',
    occurredAt: '2026-09-17T19:00:01.000Z',
    dispositionId: 'blocked-pass-disposition',
    archiveActivityId: 'blocked-pass-archive-activity',
    triageActivityId: 'blocked-pass-triage-activity',
  }), (error) => {
    assert.deepEqual({
      code: error.code,
      submissionId: error.submissionId,
      survivorSubmissionId: error.survivorSubmissionId,
      opportunityId: error.opportunityId,
    }, {
      code: CRM_SUBMISSION_SUPERSEDED,
      submissionId: 'loser',
      survivorSubmissionId: 'survivor',
      opportunityId: 'pass-opportunity',
    });
    return true;
  });
  assert.equal(passGuardHash(sqlitePath), before);
});

test('Supabase Pass uses one bounded RPC and normalizes its durable outcome', async () => {
  // Break caught: adding a client-side dismissal/review sequence or returning
  // provider metadata instead of the single RPC result violates the boundary.
  const calls = [];
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: { async rpc(name, payload) {
      calls.push({ name, payload });
      return {
        data: {
          applied: true,
          reason: '',
          archived: false,
          disposition: {
            id: '00000000-0000-4000-8000-000000000001', deal_key: 'deal-atomic', disposition: 'dismissed',
            reason: 'valuation', note: 'Too expensive.', dismissed_at: '2026-08-30T20:00:00.000Z',
            dismissed_by: 'owner@example.com', created_at: '2026-08-30T20:00:00.000Z',
            updated_at: '2026-08-30T20:00:00.000Z', metadata: { providerSecret: true },
          },
          score: {
            opportunity_id: 'opp-atomic', deal_key: 'deal-atomic', reviewed_at: '2026-08-30T20:00:00.000Z',
            reviewed_by: 'owner@example.com', reviewed_fingerprint: 'fingerprint', reviewed_semantic_digest: 'digest',
            score_fingerprint: 'fingerprint', semantic_digest: 'digest', current_triage_eligible: true,
            dimensions: [], gates: [], applied_caps: [], missing_evidence: [], confidence_reasons: [], summary: {},
          },
          submission: null,
        },
        error: null,
      };
    } } },
  );
  const command = {
    opportunityId: 'opp-atomic', reason: 'valuation', note: 'Too expensive.', actor: 'owner@example.com',
    occurredAt: '2026-08-30T20:00:00.000Z',
    dispositionId: '00000000-0000-4000-8000-000000000001',
    archiveActivityId: '00000000-0000-4000-8000-000000000002',
    triageActivityId: '00000000-0000-4000-8000-000000000003',
  };

  const result = await storage.passDealHunterOpportunity(command);

  assert.equal(result.applied, true);
  assert.equal(result.disposition.disposition, 'dismissed');
  assert.equal(result.score.reviewed, true);
  assert.deepEqual(calls, [{
    name: 'pass_deal_hunter_opportunity',
    payload: { p_command: {
      opportunity_id: command.opportunityId,
      reason: command.reason,
      note: command.note,
      actor: command.actor,
      occurred_at: command.occurredAt,
      disposition_id: command.dispositionId,
      archive_activity_id: command.archiveActivityId,
      triage_activity_id: command.triageActivityId,
    } },
  }]);
});

test('Supabase Pass refuses an explicit submission before its RPC through the real triage service', async () => {
  let rpcCalls = 0;
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: { async rpc() {
      rpcCalls += 1;
      throw new Error('RPC must not run when explicit CRM supersession authority is unavailable.');
    } } },
  );

  await assert.rejects(passTriageOpportunity({
    opportunityId: 'opp-explicit-supabase-pass',
    submissionId: 'submission-requiring-supersession-authority',
    reason: 'not-a-fit',
    note: 'Must fail closed before provider mutation.',
    actor: 'owner@example.com',
    storage,
    getCachedSourceHealth: null,
  }), (error) => {
    assert.equal(error.code, CRM_SUPERSESSION_UNAVAILABLE);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(rpcCalls, 0);
});

test('forward migration and fresh schema carry the identical atomic Pass RPC and hardened decision guard', () => {
  // Break caught: fresh installs or upgraded installs can otherwise differ on
  // transaction contents, dismissal authority, RLS execution, or search path.
  const migration = fs.readFileSync(migrationUrl, 'utf8');
  const schema = fs.readFileSync(schemaUrl, 'utf8');
  const passMigration = functionDefinition(migration, 'pass_deal_hunter_opportunity');
  const passSchema = functionDefinition(schema, 'pass_deal_hunter_opportunity');
  const decisionMigration = functionDefinition(migration, 'set_deal_hunter_opportunity_operator_decision');
  const decisionSchema = functionDefinition(schema, 'set_deal_hunter_opportunity_operator_decision');

  assert.equal(normalizeSql(passMigration), normalizeSql(passSchema));
  assert.equal(normalizeSql(decisionMigration), normalizeSql(decisionSchema));
  for (const [label, sql, passDefinition, decisionDefinition] of [
    ['forward migration', migration, passMigration, decisionMigration],
    ['fresh schema', schema, passSchema, decisionSchema],
  ]) {
    assert.match(passDefinition, /security definer[\s\S]*set search_path = public/i, `${label} must harden Pass execution`);
    assert.match(passDefinition, /from public\.deal_hunter_opportunities[\s\S]*for update[\s\S]*current_triage_eligible = true[\s\S]*should_remove/i);
    assert.match(passDefinition, /deal_hunter_dispositions[\s\S]*disposition = 'dismissed'[\s\S]*already-passed/i);
    assert.match(passDefinition, /contact_submissions[\s\S]*deal_hunter_cim_requests[\s\S]*insert into public\.deal_hunter_dispositions[\s\S]*update public\.deal_hunter_opportunity_scores[\s\S]*crm_activity_events/i);
    assert.match(decisionDefinition, /from public\.deal_hunter_opportunity_scores[\s\S]*for update[\s\S]*deal_hunter_dispositions[\s\S]*durably dismissed/i,
      `${label} must lock score before disposition so decisions serialize with Pass`);
    assert.match(sql, /revoke all privileges on function public\.pass_deal_hunter_opportunity\(jsonb\) from public, anon, authenticated;/i);
    assert.match(sql, /grant execute on function public\.pass_deal_hunter_opportunity\(jsonb\) to service_role;/i);
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createSupabaseStorage } from '../server/storage/supabase.js';

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

import assert from 'node:assert/strict';
import { restoreProtectedTables, stoppedRestoreAuthoritySql } from './crmRestoreStoppedAuthority.js';

const at = '2026-10-19T00:00:00.000Z';
const id = '11111111-6666-4666-8666-111111111111';
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
export const financialRestoreSeed = `
  INSERT INTO public.deal_hunter_opportunities(opportunity_id,created_at,updated_at,canonical_name,identity_version,status)
    VALUES ('financial-unlinked','${at}','${at}','Synthetic unlinked','fixture','active');
  INSERT INTO public.deal_hunter_opportunity_scores(opportunity_id,scored_at,deal_key,score_fingerprint,
    engine_version,rules_version,profile_version,completeness_policy_version,current_triage_eligible)
    VALUES ('financial-unlinked','${at}','financial-key','synthetic','synthetic','synthetic','synthetic','synthetic',true);
  INSERT INTO public.deal_hunter_dispositions(id,deal_key,created_at,updated_at,disposition,reason,note,dismissed_at,dismissed_by,created_by,updated_by)
    VALUES ('${id}','financial-key','${at}','${at}','dismissed','Original reason','Retained exact note','${at}','owner','owner','owner');
`;

export function financialAndUnlinkedRestoreChecks({ query, diagnostic }) {
  const value = { version: 1, amount: '-125.55', currency: 'CAD', metric: 'ebitda', period: 'annual', evidenceSource: 'Synthetic statement' };
  const fact = { id: 'financial-fact', opportunity_id: 'financial-unlinked', field: 'annual_profit', value: JSON.stringify(value),
    source: 'operator', verified: false, actor: 'fixture-owner', note: null, created_at: at, updated_at: at };
  const financialRpc = (input = fact, key = 'a'.repeat(64), digest = 'b'.repeat(64)) => `public.insert_current_deal_hunter_opportunity_fact(${literal(JSON.stringify(input))}::jsonb,
    (SELECT campaign_authority_revision FROM public.deal_hunter_opportunities WHERE opportunity_id='financial-unlinked'),null,null,'${key}','${digest}')`;
  const rawInsert = (input, suffix = '') => `INSERT INTO public.deal_hunter_opportunity_facts
    (id,opportunity_id,field,value,source,verified,actor,created_at,updated_at${suffix ? ',idempotency_key_digest,request_digest' : ''})
    VALUES ('raw','financial-unlinked','annual_profit',${literal(input)},'operator',false,'fixture-owner','${at}','${at}'${suffix});`;
  const run = (sql, failure = false) => query(sql, failure);
  const first = run(`BEGIN; ${financialRestoreSeed} SET LOCAL ROLE service_role;
    SELECT to_jsonb(${financialRpc()}); SELECT to_jsonb(${financialRpc()}); ROLLBACK;`).stdout.trim().split('\n').map(JSON.parse);
  assert.equal(first[0].id, first[1].id);
  assert.deepEqual(JSON.parse(first[0].value), value);
  for (const invalid of ['123', '{}', JSON.stringify({ ...value, amount: '01.00' }), JSON.stringify({ ...value, metric: 'revenue' }),
    JSON.stringify({ ...value, currency: 'XXX' }), JSON.stringify({ ...value, evidenceSource: '' }),
    JSON.stringify({ ...value, hidden: 'unexpected' })]) {
    const result = run(`BEGIN; ${financialRestoreSeed} SET LOCAL ROLE service_role; ${rawInsert(invalid)} COMMIT;`, true);
    assert.notEqual(result.status, 0, invalid);
  }
  for (const suffix of [",null,'" + 'b'.repeat(64) + "'", ",'" + 'a'.repeat(64) + "',null", ",'invalid','invalid'"]) {
    assert.notEqual(run(`BEGIN; ${financialRestoreSeed} SET LOCAL ROLE service_role; ${rawInsert(JSON.stringify(value), suffix)} COMMIT;`, true).status, 0);
  }
  assert.notEqual(run(`BEGIN; ${financialRestoreSeed} SET LOCAL ROLE service_role;
    ${rawInsert(JSON.stringify(value))} UPDATE public.deal_hunter_opportunity_facts SET value='{}' WHERE id='raw'; COMMIT;`, true).status, 0);
  const legacy = run(`BEGIN; ${financialRestoreSeed} SET LOCAL ROLE service_role;
    SELECT to_jsonb(public.upsert_deal_hunter_opportunity_fact(${literal(JSON.stringify(fact))}::jsonb)); ROLLBACK;`).stdout.trim();
  assert.equal(JSON.parse(legacy).field, 'annual_profit');
  const conflict = run(`BEGIN; ${financialRestoreSeed} SET LOCAL ROLE service_role; SELECT ${financialRpc()};
    SELECT ${financialRpc({ ...fact, value: JSON.stringify({ ...value, currency: 'USD' }) }, 'a'.repeat(64), 'c'.repeat(64))}; COMMIT;`, true);
  assert.notEqual(conflict.status, 0, 'changed replay must fail');
  const currentRevision = `(select campaign_authority_revision from public.deal_hunter_opportunities where opportunity_id='financial-unlinked')`;
  const authority = `jsonb_build_object('opportunityId','financial-unlinked','expectedCampaignAuthorityRevision',${currentRevision},
    'passId','${id}','passUpdatedAt','${at}','actor','fixture-owner','at','2026-10-19T01:00:00.000Z')`;
  const restore = (input = authority) => `public.restore_current_unlinked_opportunity(${input})`;
  const protectedSnapshot = `jsonb_build_object(${restoreProtectedTables.map((table) => `${literal(table)},(SELECT coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') FROM public.${table} x)`).join(',')})`;
  const restored = run(`BEGIN; ${financialRestoreSeed}
    ${stoppedRestoreAuthoritySql('11111111-1111-4111-8111-111111111111', 'canonical-restore')}
    SELECT ${protectedSnapshot}; SET LOCAL ROLE service_role;
    SELECT ${restore()}; SELECT ${restore()}; RESET ROLE;
    SELECT to_jsonb(d) FROM public.deal_hunter_dispositions d WHERE id='${id}';
    SELECT ${protectedSnapshot}; ROLLBACK;`).stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(restored[4], restored[0], 'Opt-outs and retained terminal authority remain unchanged');
  restored.shift();
  assert.equal(restored[0].applied, true); assert.equal(restored[1].applied, false);
  assert.equal(restored[2].reason, 'Original reason'); assert.equal(restored[2].note, 'Retained exact note');
  assert.equal(restored[2].restored_by, 'fixture-owner');
  assert.equal(restored[2].submission_id, null);
  const fixedClock = run(`BEGIN; ${financialRestoreSeed}
    CREATE TEMP TABLE fl03_reviewed ON COMMIT DROP AS SELECT ${authority} AS payload;
    GRANT SELECT ON fl03_reviewed TO service_role;
    SET LOCAL ROLE service_role; SELECT ${restore('(SELECT payload FROM fl03_reviewed)')}; RESET ROLE;
    UPDATE public.deal_hunter_dispositions SET disposition='dismissed',updated_at='${at}' WHERE id='${id}';
    SET LOCAL ROLE service_role; SELECT ${restore('(SELECT payload FROM fl03_reviewed)')}; ROLLBACK;`).stdout.trim().split('\n').map(JSON.parse);
  assert.equal(fixedClock[0].applied, true); assert.equal(fixedClock[1].applied, false, 'Fixed-clock re-Pass invalidates earlier confirmation');
  assert.notEqual(run(`BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE service_role; SELECT ${restore()}; COMMIT;`, true).status, 0);
  const mutations = [
    `UPDATE public.deal_hunter_dispositions SET submission_id='11111111-1111-4111-8111-111111111111' WHERE id='${id}';`,
    `UPDATE public.deal_hunter_dispositions SET updated_at='2026-10-19T00:01:00Z' WHERE id='${id}';`,
    `UPDATE public.deal_hunter_opportunities SET primary_submission_id='11111111-1111-4111-8111-111111111111' WHERE opportunity_id='financial-unlinked';`,
    `UPDATE public.contact_submissions SET deal_hunter_opportunity_id='financial-unlinked' WHERE id='11111111-1111-4111-8111-111111111111';`,
    `UPDATE public.contact_submissions SET metadata=metadata || '{"dealHunter":{"opportunityId":"financial-unlinked"}}'::jsonb WHERE id='11111111-1111-4111-8111-111111111111';`,
    `UPDATE public.contact_submissions SET metadata=metadata || '{"dealHunter":{"dealKey":"financial-key"}}'::jsonb WHERE id='11111111-1111-4111-8111-111111111111';`,
    `UPDATE public.deal_hunter_opportunity_scores SET current_triage_eligible=false WHERE opportunity_id='financial-unlinked';`,
  ];
  for (const mutation of mutations) {
    const result = run(`BEGIN; ${financialRestoreSeed} ${mutation} SET LOCAL ROLE service_role; SELECT ${restore()}; ROLLBACK;`).stdout.trim();
    assert.equal(JSON.parse(result).applied, false, mutation);
  }
  for (const role of ['anon', 'authenticated']) assert.notEqual(run(`BEGIN; SET LOCAL ROLE ${role}; SELECT ${restore()}; ROLLBACK;`, true).status, 0);
  for (const timestamp of ['infinity', '-infinity', 'invalid']) assert.notEqual(run(`BEGIN; ${financialRestoreSeed} SET LOCAL ROLE service_role;
    SELECT ${restore(`(${authority}) || jsonb_build_object('at',${literal(timestamp)})`)}; COMMIT;`, true).status, 0);
  diagnostic('Financial/current Restore: typed persistence, exact replay, raw rejection, paired digests, finite time, role denial, exact Pass/identity/reverse CRM checks passed');
}

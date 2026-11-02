-- Best-first deal list.
--
-- Forward-only and additive. Each section below names the task that added it.

-- Task 2: store the owner-criteria group at score time.
--
-- criteria_profile_version / criteria_group / criteria_result are machine-owned:
-- they are written only by write_deal_hunter_opportunity_score and are absent
-- from every operator-owned and eligibility-owned writer. criteria_result holds
-- { mustHaves, failed, unknown } as jsonb, typed like the other machine JSON
-- columns on this table. All three are nullable so rows scored before this
-- migration read as "not yet evaluated" until the next refresh rewrites them
-- (the refresh treats a missing or stale criteria_profile_version as out of date).
alter table public.deal_hunter_opportunity_scores
  add column if not exists criteria_profile_version text,
  add column if not exists criteria_group text,
  add column if not exists criteria_result jsonb;

create or replace function public.write_deal_hunter_opportunity_score(p_score jsonb, p_evidence jsonb)
returns public.deal_hunter_opportunity_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_score public.deal_hunter_opportunity_scores;
  v_item jsonb;
  v_index integer := 0;
  v_opportunity_id text := p_score->>'opportunity_id';
  v_fingerprint text := p_score->>'score_fingerprint';
  v_scored_at timestamptz := coalesce((p_score->>'scored_at')::timestamptz, now());
begin
  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = v_opportunity_id and status = 'active'
  for update;
  if not found then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;

  insert into public.deal_hunter_opportunity_scores (
    opportunity_id, created_at, scored_at, deal_key, name, state, listing_url, fit_score, score_status,
    confidence, completeness_score, contradiction_count, missing_evidence_count, should_remove, high_fit,
    gate_count, score_fingerprint, semantic_digest, engine_version, rules_version, profile_version,
    completeness_policy_version, dimensions, gates, applied_caps, missing_evidence, confidence_reasons, summary,
    criteria_profile_version, criteria_group, criteria_result
  ) values (
    v_opportunity_id, v_scored_at, v_scored_at, nullif(p_score->>'deal_key', ''), nullif(p_score->>'name', ''),
    nullif(p_score->>'state', ''), nullif(p_score->>'listing_url', ''),
    coalesce((p_score->>'fit_score')::integer, 0), coalesce(p_score->>'score_status', 'provisional'),
    coalesce(p_score->>'confidence', 'low'), coalesce((p_score->>'completeness_score')::integer, 0),
    coalesce((p_score->>'contradiction_count')::integer, 0), coalesce((p_score->>'missing_evidence_count')::integer, 0),
    coalesce((p_score->>'should_remove')::boolean, false), coalesce((p_score->>'high_fit')::boolean, false),
    coalesce((p_score->>'gate_count')::integer, 0), v_fingerprint,
    nullif(p_score->>'semantic_digest', ''), p_score->>'engine_version',
    p_score->>'rules_version', p_score->>'profile_version', p_score->>'completeness_policy_version',
    coalesce(p_score->'dimensions', '[]'::jsonb), coalesce(p_score->'gates', '[]'::jsonb),
    coalesce(p_score->'applied_caps', '[]'::jsonb), coalesce(p_score->'missing_evidence', '[]'::jsonb),
    coalesce(p_score->'confidence_reasons', '[]'::jsonb), coalesce(p_score->'summary', '{}'::jsonb),
    nullif(p_score->>'criteria_profile_version', ''), nullif(p_score->>'criteria_group', ''),
    nullif(p_score->'criteria_result', 'null'::jsonb)
  )
  on conflict (opportunity_id) do update set
    scored_at = excluded.scored_at,
    deal_key = excluded.deal_key,
    name = excluded.name,
    state = excluded.state,
    listing_url = excluded.listing_url,
    fit_score = excluded.fit_score,
    score_status = excluded.score_status,
    confidence = excluded.confidence,
    completeness_score = excluded.completeness_score,
    contradiction_count = excluded.contradiction_count,
    missing_evidence_count = excluded.missing_evidence_count,
    should_remove = excluded.should_remove,
    high_fit = excluded.high_fit,
    gate_count = excluded.gate_count,
    score_fingerprint = excluded.score_fingerprint,
    semantic_digest = excluded.semantic_digest,
    engine_version = excluded.engine_version,
    rules_version = excluded.rules_version,
    profile_version = excluded.profile_version,
    completeness_policy_version = excluded.completeness_policy_version,
    dimensions = excluded.dimensions,
    gates = excluded.gates,
    applied_caps = excluded.applied_caps,
    missing_evidence = excluded.missing_evidence,
    confidence_reasons = excluded.confidence_reasons,
    summary = excluded.summary,
    criteria_profile_version = excluded.criteria_profile_version,
    criteria_group = excluded.criteria_group,
    criteria_result = excluded.criteria_result
  returning * into v_score;

  delete from public.deal_hunter_score_evidence where opportunity_id = v_opportunity_id;
  for v_item in select value from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) loop
    insert into public.deal_hunter_score_evidence (
      id, opportunity_id, score_fingerprint, created_at, dimension, rule_id, rule_label,
      evidence_class, field, value, observed_value, terms, source_id, source_name,
      source_record_id, listing_url, observed_at
    ) values (
      v_opportunity_id || ':' || v_fingerprint || ':' || v_index, v_opportunity_id, v_fingerprint, v_scored_at,
      nullif(v_item->>'dimension', ''), coalesce(v_item->>'ruleId', ''), coalesce(v_item->>'ruleLabel', ''),
      coalesce(v_item->>'evidenceClass', ''), nullif(v_item->>'field', ''), v_item->>'value',
      v_item->>'observedValue', coalesce(v_item->'terms', '[]'::jsonb), nullif(v_item->>'sourceId', ''),
      nullif(v_item->>'sourceName', ''), nullif(v_item->>'sourceRecordId', ''),
      nullif(v_item->>'listingUrl', ''), nullif(v_item->>'observedAt', '')
    );
    v_index := v_index + 1;
  end loop;
  return v_score;
end;
$$;

-- Grants are re-stated for the replaced function so this migration is
-- self-describing; CREATE OR REPLACE FUNCTION preserves the existing ACL.
revoke all privileges on function public.write_deal_hunter_opportunity_score(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.write_deal_hunter_opportunity_score(jsonb, jsonb) to service_role;

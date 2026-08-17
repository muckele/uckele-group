-- Deal Hunter opportunity scoring and operator triage (Phase 3A).
--
-- Adds persistent, explainable scoring with source evidence, plus the minimal
-- operator-owned columns triage needs. Machine scoring and operator decisions
-- live in one row for cheap "changed since reviewed" derivation but are written
-- by separate operations that cannot reach each other's columns.
--
-- This migration is additive: no existing table, column, or function changes.

-- Machine-computed scoring columns and operator-owned columns share a row so the
-- triage queue can derive "changed since reviewed" without a join. They are never
-- written by the same operation: write_deal_hunter_opportunity_score touches only
-- machine columns and the application rejects operator keys before calling it.
create table if not exists public.deal_hunter_opportunity_scores (
  opportunity_id text primary key references public.deal_hunter_opportunities(opportunity_id) on delete cascade,
  created_at timestamptz not null default now(),
  scored_at timestamptz not null,
  deal_key text,
  name text,
  state text,
  listing_url text,
  fit_score integer not null default 0,
  score_status text not null default 'provisional',
  confidence text not null default 'low',
  completeness_score integer not null default 0,
  contradiction_count integer not null default 0,
  missing_evidence_count integer not null default 0,
  should_remove boolean not null default false,
  high_fit boolean not null default false,
  gate_count integer not null default 0,
  score_fingerprint text not null,
  engine_version text not null,
  rules_version text not null,
  profile_version text not null,
  completeness_policy_version text not null,
  dimensions jsonb not null default '[]'::jsonb,
  gates jsonb not null default '[]'::jsonb,
  applied_caps jsonb not null default '[]'::jsonb,
  missing_evidence jsonb not null default '[]'::jsonb,
  confidence_reasons jsonb not null default '[]'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  operator_priority text not null default 'normal',
  operator_note text,
  reviewed_at timestamptz,
  reviewed_by text,
  reviewed_fingerprint text,
  operator_updated_at timestamptz
);

create table if not exists public.deal_hunter_score_evidence (
  id text primary key,
  opportunity_id text not null references public.deal_hunter_opportunity_scores(opportunity_id) on delete cascade,
  score_fingerprint text not null,
  created_at timestamptz not null,
  dimension text,
  rule_id text not null,
  rule_label text not null,
  evidence_class text not null,
  field text,
  value text,
  observed_value text,
  terms jsonb not null default '[]'::jsonb,
  source_id text,
  source_name text,
  source_record_id text,
  listing_url text,
  observed_at text
);

create index if not exists idx_deal_hunter_scores_queue
  on public.deal_hunter_opportunity_scores(should_remove, fit_score desc, confidence, opportunity_id);
create index if not exists idx_deal_hunter_scores_priority
  on public.deal_hunter_opportunity_scores(operator_priority, fit_score desc, opportunity_id);
create index if not exists idx_deal_hunter_scores_fingerprint
  on public.deal_hunter_opportunity_scores(score_fingerprint);
create index if not exists idx_deal_hunter_score_evidence_opportunity
  on public.deal_hunter_score_evidence(opportunity_id, dimension, evidence_class);

-- Replaces a machine score and the evidence describing it in one transaction, so
-- evidence can never describe a superseded fingerprint. Operator columns are
-- absent from both the insert and the update list.
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
  insert into public.deal_hunter_opportunity_scores (
    opportunity_id, created_at, scored_at, deal_key, name, state, listing_url, fit_score, score_status,
    confidence, completeness_score, contradiction_count, missing_evidence_count, should_remove, high_fit,
    gate_count, score_fingerprint, engine_version, rules_version, profile_version,
    completeness_policy_version, dimensions, gates, applied_caps, missing_evidence, confidence_reasons, summary
  ) values (
    v_opportunity_id, v_scored_at, v_scored_at, nullif(p_score->>'deal_key', ''), nullif(p_score->>'name', ''),
    nullif(p_score->>'state', ''), nullif(p_score->>'listing_url', ''),
    coalesce((p_score->>'fit_score')::integer, 0), coalesce(p_score->>'score_status', 'provisional'),
    coalesce(p_score->>'confidence', 'low'), coalesce((p_score->>'completeness_score')::integer, 0),
    coalesce((p_score->>'contradiction_count')::integer, 0), coalesce((p_score->>'missing_evidence_count')::integer, 0),
    coalesce((p_score->>'should_remove')::boolean, false), coalesce((p_score->>'high_fit')::boolean, false),
    coalesce((p_score->>'gate_count')::integer, 0), v_fingerprint, p_score->>'engine_version',
    p_score->>'rules_version', p_score->>'profile_version', p_score->>'completeness_policy_version',
    coalesce(p_score->'dimensions', '[]'::jsonb), coalesce(p_score->'gates', '[]'::jsonb),
    coalesce(p_score->'applied_caps', '[]'::jsonb), coalesce(p_score->'missing_evidence', '[]'::jsonb),
    coalesce(p_score->'confidence_reasons', '[]'::jsonb), coalesce(p_score->'summary', '{}'::jsonb)
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
    engine_version = excluded.engine_version,
    rules_version = excluded.rules_version,
    profile_version = excluded.profile_version,
    completeness_policy_version = excluded.completeness_policy_version,
    dimensions = excluded.dimensions,
    gates = excluded.gates,
    applied_caps = excluded.applied_caps,
    missing_evidence = excluded.missing_evidence,
    confidence_reasons = excluded.confidence_reasons,
    summary = excluded.summary
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

create or replace function public.list_deal_hunter_opportunity_scores(
  p_view text, p_page integer, p_page_size integer, p_search text, p_sort text, p_direction text,
  p_min_score integer, p_confidence text, p_priority text, p_state text
) returns jsonb
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select scores.*, disposition.deal_key as dismissed_deal_key,
           disposition.reason as dismissed_reason, disposition.dismissed_at as dismissed_at
    from public.deal_hunter_opportunity_scores as scores
    left join public.deal_hunter_dispositions as disposition
      on disposition.deal_key = scores.deal_key and disposition.disposition = 'dismissed'
  ), filtered as (
    select * from candidates
    where (case
        when p_view = 'dismissed' then dismissed_deal_key is not null
        when p_view = 'needs-review' then dismissed_deal_key is null and should_remove = false
          and (reviewed_at is null or reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint)
        when p_view = 'high-priority' then dismissed_deal_key is null and should_remove = false
          and (high_fit or operator_priority in ('urgent', 'high'))
        when p_view = 'watchlist' then dismissed_deal_key is null and should_remove = false
          and ((fit_score >= 60 and fit_score < 75) or operator_priority = 'watch')
        when p_view = 'low-confidence' then dismissed_deal_key is null and should_remove = false
          and (confidence = 'low' or contradiction_count > 0)
        else dismissed_deal_key is null
      end)
      and (coalesce(p_search, '') = ''
        or lower(coalesce(name, '')) like '%' || lower(p_search) || '%'
        or lower(coalesce(deal_key, '')) like '%' || lower(p_search) || '%')
      and (p_min_score is null or fit_score >= p_min_score)
      and (coalesce(p_confidence, '') = '' or confidence = p_confidence)
      and (coalesce(p_priority, '') = '' or operator_priority = p_priority)
      and (coalesce(p_state, '') = '' or upper(coalesce(state, '')) = upper(p_state))
  ), ordered as (
    select * from filtered
    order by
      -- One sort key per direction; opportunity_id is always the final key so
      -- pagination stays stable when rows tie.
      case when lower(coalesce(p_direction, 'desc')) = 'asc' then
        case coalesce(p_sort, 'fit-score')
          when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric
          when 'completeness' then completeness_score::numeric
          when 'changed' then (case when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric
          else fit_score::numeric
        end
      end asc nulls last,
      case when lower(coalesce(p_direction, 'desc')) <> 'asc' then
        case coalesce(p_sort, 'fit-score')
          when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric
          when 'completeness' then completeness_score::numeric
          when 'changed' then (case when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric
          else fit_score::numeric
        end
      end desc nulls last,
      case confidence when 'high' then 3 when 'medium' then 2 else 1 end desc,
      opportunity_id asc
    limit greatest(coalesce(p_page_size, 25), 1)
    offset greatest(0, (greatest(coalesce(p_page, 1), 1) - 1) * greatest(coalesce(p_page_size, 25), 1))
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(to_jsonb(ordered)) from ordered), '[]'::jsonb)
  );
$$;

alter table public.deal_hunter_opportunity_scores enable row level security;
alter table public.deal_hunter_score_evidence enable row level security;
revoke all privileges on table public.deal_hunter_opportunity_scores from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_score_evidence from public, anon, authenticated;
revoke all privileges on function public.write_deal_hunter_opportunity_score(jsonb, jsonb) from public, anon, authenticated;
revoke all privileges on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) from public, anon, authenticated;
grant all privileges on table public.deal_hunter_opportunity_scores to service_role;
grant all privileges on table public.deal_hunter_score_evidence to service_role;
grant execute on function public.write_deal_hunter_opportunity_score(jsonb, jsonb) to service_role;
grant execute on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) to service_role;

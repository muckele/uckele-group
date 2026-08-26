-- Current Deal Hunter triage eligibility.
--
-- Existing score rows remain visible as the last-known-good current set during
-- rollout. New score rows default inactive, and only the complete-set
-- reconciliation function can replace current eligibility. Scores, evidence,
-- operator decisions, and CRM audit history are never deleted by this migration.

alter table public.deal_hunter_opportunity_scores
  add column if not exists current_triage_eligible boolean;

update public.deal_hunter_opportunity_scores
set current_triage_eligible = true
where current_triage_eligible is null;

alter table public.deal_hunter_opportunity_scores
  alter column current_triage_eligible set default false,
  alter column current_triage_eligible set not null;

create index if not exists idx_deal_hunter_scores_current_queue
  on public.deal_hunter_opportunity_scores(current_triage_eligible, should_remove, fit_score desc, opportunity_id);

create or replace function public.reconcile_deal_hunter_current_score_eligibility(p_opportunity_ids text[])
returns table (activated bigint, deactivated bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids text[];
  v_activated bigint;
  v_deactivated bigint;
begin
  select coalesce(array_agg(distinct btrim(value)), array[]::text[])
  into v_ids
  from unnest(coalesce(p_opportunity_ids, array[]::text[])) as supplied(value)
  where nullif(btrim(value), '') is not null;

  select count(*) into v_activated
  from public.deal_hunter_opportunity_scores as scores
  where scores.current_triage_eligible = false
    and scores.opportunity_id = any(v_ids);

  select count(*) into v_deactivated
  from public.deal_hunter_opportunity_scores as scores
  where scores.current_triage_eligible = true
    and not (scores.opportunity_id = any(v_ids));

  update public.deal_hunter_opportunity_scores
  set current_triage_eligible = case
    when opportunity_id = any(v_ids) then true
    else false
  end
  where current_triage_eligible is distinct from case
    when opportunity_id = any(v_ids) then true
    else false
  end;

  return query select v_activated, v_deactivated;
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
    where scores.current_triage_eligible = true
  ), filtered as (
    select * from candidates
    where (case
        when p_view = 'dismissed' then dismissed_deal_key is not null
        when p_view = 'needs-review' then dismissed_deal_key is null and should_remove = false
          and (reviewed_at is null or (case
            when reviewed_semantic_digest is not null then reviewed_semantic_digest <> coalesce(semantic_digest, '')
            else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint
          end))
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
      case when lower(coalesce(p_direction, 'desc')) = 'asc' then
        case coalesce(p_sort, 'fit-score')
          when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric
          when 'completeness' then completeness_score::numeric
          when 'changed' then (case when reviewed_at is null then 1
            when reviewed_semantic_digest is not null then (case when reviewed_semantic_digest <> coalesce(semantic_digest, '') then 1 else 0 end)
            when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric
          else fit_score::numeric
        end
      end asc nulls last,
      case when lower(coalesce(p_direction, 'desc')) <> 'asc' then
        case coalesce(p_sort, 'fit-score')
          when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric
          when 'completeness' then completeness_score::numeric
          when 'changed' then (case when reviewed_at is null then 1
            when reviewed_semantic_digest is not null then (case when reviewed_semantic_digest <> coalesce(semantic_digest, '') then 1 else 0 end)
            when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric
          else fit_score::numeric
        end
      end desc nulls last,
      case confidence when 'high' then 3 when 'medium' then 2 else 1 end desc,
      opportunity_id asc
    limit least(greatest(coalesce(p_page_size, 25), 1), 100)
    offset greatest(0, (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 25), 1), 100))
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(to_jsonb(ordered)) from ordered), '[]'::jsonb)
  );
$$;

revoke all privileges on function public.reconcile_deal_hunter_current_score_eligibility(text[]) from public, anon, authenticated;
revoke all privileges on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.reconcile_deal_hunter_current_score_eligibility(text[]) to service_role;
grant execute on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) to service_role;

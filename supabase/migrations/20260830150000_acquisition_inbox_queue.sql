-- Acquisition Inbox queue projections remain server-only and database-owned.
create index if not exists idx_deal_hunter_scores_acquisition_priority
  on public.deal_hunter_opportunity_scores(
    current_triage_eligible, should_remove, operator_priority, high_fit,
    fit_score desc, confidence, scored_at desc, opportunity_id
  );
create index if not exists idx_deal_hunter_source_observations_queue_projection
  on public.deal_hunter_opportunity_source_observations(opportunity_id, field, observed_at desc, id);

create or replace function public.list_deal_hunter_opportunity_scores(
  p_view text, p_page integer, p_page_size integer, p_search text, p_sort text, p_direction text,
  p_min_score integer, p_confidence text, p_priority text, p_state text
) returns jsonb
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select
           scores.opportunity_id, scores.deal_key, scores.name, scores.state, scores.listing_url,
           scores.fit_score, scores.score_status, scores.confidence, scores.completeness_score,
           scores.contradiction_count, scores.missing_evidence_count, scores.should_remove,
           scores.high_fit, scores.score_fingerprint, scores.semantic_digest, scores.scored_at,
           scores.rules_version, scores.operator_priority, scores.reviewed_at,
           scores.reviewed_by, scores.reviewed_fingerprint, scores.reviewed_semantic_digest,
           disposition.deal_key as dismissed_deal_key,
           disposition.reason as dismissed_reason, disposition.dismissed_at as dismissed_at,
           scores.summary->'strengths'->>0 as top_strength,
           scores.summary->'concerns'->>0 as top_concern,
           (select value from public.deal_hunter_opportunity_source_observations as source where source.opportunity_id = scores.opportunity_id and source.field = 'industry' order by source.observed_at desc, source.id asc limit 1) as industry,
           (select value from public.deal_hunter_opportunity_source_observations as source where source.opportunity_id = scores.opportunity_id and source.field = 'location' order by source.observed_at desc, source.id asc limit 1) as location,
           (select value from public.deal_hunter_opportunity_source_observations as source where source.opportunity_id = scores.opportunity_id and source.field = 'annual_profit' order by source.observed_at desc, source.id asc limit 1) as annual_profit,
           (select value from public.deal_hunter_opportunity_source_observations as source where source.opportunity_id = scores.opportunity_id and source.field = 'annual_revenue' order by source.observed_at desc, source.id asc limit 1) as annual_revenue,
           (select value from public.deal_hunter_opportunity_source_observations as source where source.opportunity_id = scores.opportunity_id and source.field = 'asking_price' order by source.observed_at desc, source.id asc limit 1) as asking_price,
           (select value from public.deal_hunter_opportunity_source_observations as source where source.opportunity_id = scores.opportunity_id and source.field = 'profit_multiple' order by source.observed_at desc, source.id asc limit 1) as profit_multiple,
           coalesce((select max(observed_at) from public.deal_hunter_opportunity_source_observations as source where source.opportunity_id = scores.opportunity_id), scores.scored_at) as observation_freshness,
           coalesce((select submission.status from public.contact_submissions as submission where submission.id = opportunity.primary_submission_id limit 1), 'not-started') as crm_status,
           coalesce((select cim.status from public.deal_hunter_cim_requests as cim where cim.opportunity_id = scores.opportunity_id order by cim.updated_at desc, cim.id desc limit 1), 'not-requested') as cim_status
    from public.deal_hunter_opportunity_scores as scores
    join public.deal_hunter_opportunities as opportunity on opportunity.opportunity_id = scores.opportunity_id and opportunity.status = 'active'
    left join public.deal_hunter_dispositions as disposition on disposition.deal_key = scores.deal_key and disposition.disposition = 'dismissed'
    where scores.current_triage_eligible = true
  ), filtered as (
    select * from candidates
    where (case
        when p_view = 'dismissed' then dismissed_deal_key is not null
        when p_view = 'needs-review' then dismissed_deal_key is null and should_remove = false and (reviewed_at is null or (case when reviewed_semantic_digest is not null then reviewed_semantic_digest <> coalesce(semantic_digest, '') else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint end))
        when p_view = 'high-priority' then dismissed_deal_key is null and should_remove = false and (high_fit or operator_priority in ('urgent', 'high'))
        when p_view = 'watchlist' then dismissed_deal_key is null and should_remove = false and ((fit_score >= 60 and fit_score < 75) or operator_priority = 'watch')
        when p_view = 'low-confidence' then dismissed_deal_key is null and should_remove = false and (confidence = 'low' or contradiction_count > 0)
        else dismissed_deal_key is null
      end)
      and (coalesce(p_search, '') = '' or lower(coalesce(name, '')) like '%' || lower(p_search) || '%' or lower(coalesce(deal_key, '')) like '%' || lower(p_search) || '%')
      and (p_min_score is null or fit_score >= p_min_score)
      and (coalesce(p_confidence, '') = '' or confidence = p_confidence)
      and (coalesce(p_priority, '') = '' or operator_priority = p_priority)
      and (coalesce(p_state, '') = '' or upper(coalesce(state, '')) = upper(p_state))
  ), ranked as (
    select filtered.*, row_number() over (order by
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority' then case when operator_priority in ('urgent', 'high') then 1 else 0 end end desc,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority' then case when high_fit and (reviewed_at is null or (case when reviewed_semantic_digest is not null then reviewed_semantic_digest <> coalesce(semantic_digest, '') else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint end)) then 1 else 0 end end desc,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority' then fit_score end desc nulls last,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority' then case confidence when 'high' then 3 when 'medium' then 2 else 1 end end desc nulls last,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority' then observation_freshness end desc nulls last,
      case when lower(coalesce(p_direction, 'desc')) = 'asc' then case coalesce(p_sort, 'fit-score') when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric when 'completeness' then completeness_score::numeric when 'fit-score' then fit_score::numeric when 'changed' then (case when reviewed_at is null then 1 when reviewed_semantic_digest is not null then (case when reviewed_semantic_digest <> coalesce(semantic_digest, '') then 1 else 0 end) when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric end end asc nulls last,
      case when lower(coalesce(p_direction, 'desc')) <> 'asc' then case coalesce(p_sort, 'fit-score') when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric when 'completeness' then completeness_score::numeric when 'fit-score' then fit_score::numeric when 'changed' then (case when reviewed_at is null then 1 when reviewed_semantic_digest is not null then (case when reviewed_semantic_digest <> coalesce(semantic_digest, '') then 1 else 0 end) when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric end end desc nulls last,
      case when lower(coalesce(p_direction, 'desc')) = 'asc' then case coalesce(p_sort, 'fit-score') when 'scored-at' then scored_at end end asc nulls last,
      case when lower(coalesce(p_direction, 'desc')) <> 'asc' then case coalesce(p_sort, 'fit-score') when 'scored-at' then scored_at end end desc nulls last,
      case when lower(coalesce(p_direction, 'desc')) = 'asc' then case coalesce(p_sort, 'fit-score') when 'name' then lower(coalesce(name, '')) end end asc nulls last,
      case when lower(coalesce(p_direction, 'desc')) <> 'asc' then case coalesce(p_sort, 'fit-score') when 'name' then lower(coalesce(name, '')) end end desc nulls last,
      case when coalesce(p_sort, 'fit-score') <> 'acquisition-priority' then case confidence when 'high' then 3 when 'medium' then 2 else 1 end end desc,
      opportunity_id asc
    ) as ordinal
    from filtered
  ), ordered as (
    select * from ranked
    where ordinal > greatest(0, (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 25), 1), 100))
      and ordinal <= greatest(0, (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 25), 1), 100)) + least(greatest(coalesce(p_page_size, 25), 1), 100)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'summary', (select jsonb_build_object(
      'needsReview', count(*) filter (where dismissed_deal_key is null and should_remove = false and (reviewed_at is null or (case when reviewed_semantic_digest is not null then reviewed_semantic_digest <> coalesce(semantic_digest, '') else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint end))),
      'highPriority', count(*) filter (where dismissed_deal_key is null and should_remove = false and (high_fit or operator_priority in ('urgent', 'high'))),
      'watchlist', count(*) filter (where dismissed_deal_key is null and should_remove = false and ((fit_score >= 60 and fit_score < 75) or operator_priority = 'watch')),
      'lowConfidence', count(*) filter (where dismissed_deal_key is null and should_remove = false and (confidence = 'low' or contradiction_count > 0)),
      'currentOpportunities', count(*) filter (where dismissed_deal_key is null)
    ) from candidates),
    'rows', coalesce((select jsonb_agg((to_jsonb(ordered) - 'ordinal') order by ordinal) from ordered), '[]'::jsonb)
  );
$$;

revoke all privileges on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) to service_role;

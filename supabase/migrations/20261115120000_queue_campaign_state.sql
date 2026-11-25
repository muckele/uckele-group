-- Queue rows carry the latest Pursue campaign generation's state, so the inbox can hide
-- Request SIM and show the campaign instead of the legacy "CIM: Not Requested" label.
-- Forward-only and re-runnable: one helper plus create-or-replace of both queue readers.

-- The latest Pursue campaign generation for one queue row. One probe of the
-- (opportunity_id, generation) unique index; called only for rows being displayed.
create or replace function public.deal_hunter_latest_campaign_fields_v1(p_opportunity_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select pg_catalog.jsonb_build_object(
      'campaign_state', campaign.state,
      'campaign_reason_code', campaign.reason_code,
      'campaign_local_expiry_at', campaign.local_expiry_at)
    from public.deal_hunter_cim_campaigns as campaign
    where campaign.opportunity_id = p_opportunity_id
    order by campaign.generation desc limit 1), '{}'::jsonb);
$$;
revoke all on function public.deal_hunter_latest_campaign_fields_v1(text) from public, anon, authenticated;
grant execute on function public.deal_hunter_latest_campaign_fields_v1(text) to service_role;

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
           scores.opportunity_id, scores.deal_key,
           coalesce(nullif(disposition.deal_name, ''), scores.name) as name,
           scores.name as score_name, scores.state,
           coalesce(nullif(disposition.listing_url, ''), scores.listing_url) as listing_url,
           scores.listing_url as score_listing_url,
           scores.fit_score, scores.score_status, scores.confidence, scores.completeness_score,
           scores.contradiction_count, scores.missing_evidence_count, scores.should_remove,
           scores.high_fit, scores.score_fingerprint, scores.semantic_digest, scores.scored_at,
           scores.rules_version, scores.current_triage_eligible,
           scores.operator_priority, scores.reviewed_at,
           scores.reviewed_by, scores.reviewed_fingerprint, scores.reviewed_semantic_digest,
           disposition.deal_key as dismissed_deal_key,
           disposition.reason as dismissed_reason, disposition.note as dismissed_note,
           disposition.dismissed_at as dismissed_at, disposition.dismissed_by as dismissed_by,
           scores.summary->'strengths'->>0 as top_strength,
           scores.summary->'concerns'->>0 as top_concern,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'industry'
             order by source.observed_at desc, source.id asc limit 1) as industry,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'location'
             order by source.observed_at desc, source.id asc limit 1) as location,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'annual_profit'
             order by source.observed_at desc, source.id asc limit 1) as annual_profit,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'annual_revenue'
             order by source.observed_at desc, source.id asc limit 1) as annual_revenue,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'asking_price'
             order by source.observed_at desc, source.id asc limit 1) as asking_price,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'profit_multiple'
             order by source.observed_at desc, source.id asc limit 1) as profit_multiple,
           coalesce((select max(observed_at) from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id), scores.scored_at) as observation_freshness,
           coalesce((select submission.status from public.contact_submissions as submission
             where submission.id = opportunity.primary_submission_id limit 1), 'not-started') as crm_status,
           coalesce((select cim.status from public.deal_hunter_cim_requests as cim
             where cim.opportunity_id = scores.opportunity_id order by cim.updated_at desc, cim.id desc limit 1), 'not-requested') as cim_status
    from public.deal_hunter_opportunity_scores as scores
    join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = scores.opportunity_id
     and opportunity.status = 'active'
    left join public.deal_hunter_dispositions as disposition
      on disposition.deal_key = scores.deal_key and disposition.disposition = 'dismissed'
  ), filtered as (
    select * from candidates
    where (case
        when p_view = 'dismissed' then dismissed_deal_key is not null
        when p_view = 'needs-review' then current_triage_eligible = true
          and dismissed_deal_key is null and should_remove = false
          and (reviewed_at is null or (case
            when reviewed_semantic_digest is not null then reviewed_semantic_digest <> coalesce(semantic_digest, '')
            else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint
          end))
        when p_view = 'high-priority' then current_triage_eligible = true
          and dismissed_deal_key is null and should_remove = false
          and (high_fit or operator_priority in ('urgent', 'high'))
        when p_view = 'watchlist' then current_triage_eligible = true
          and dismissed_deal_key is null and should_remove = false
          and ((fit_score >= 60 and fit_score < 75) or operator_priority = 'watch')
        when p_view = 'low-confidence' then current_triage_eligible = true
          and dismissed_deal_key is null and should_remove = false
          and (confidence = 'low' or contradiction_count > 0)
        else current_triage_eligible = true and dismissed_deal_key is null
      end)
      and (coalesce(p_search, '') = ''
        or lower(coalesce(name, '')) like '%' || lower(p_search) || '%'
        or lower(coalesce(score_name, '')) like '%' || lower(p_search) || '%'
        or lower(coalesce(deal_key, '')) like '%' || lower(p_search) || '%'
        or (p_view = 'dismissed' and (
          lower(coalesce(listing_url, '')) like '%' || lower(p_search) || '%'
          or lower(coalesce(score_listing_url, '')) like '%' || lower(p_search) || '%'
          or lower(coalesce(dismissed_reason, '')) like '%' || lower(p_search) || '%'
          or lower(coalesce(dismissed_note, '')) like '%' || lower(p_search) || '%'
        )))
      and (p_min_score is null or fit_score >= p_min_score)
      and (coalesce(p_confidence, '') = '' or confidence = p_confidence)
      and (coalesce(p_priority, '') = '' or operator_priority = p_priority)
      and (coalesce(p_state, '') = '' or upper(coalesce(state, '')) = upper(p_state))
  ), ranked as (
    select filtered.*, row_number() over (order by
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority'
        then case when operator_priority in ('urgent', 'high') then 1 else 0 end end desc,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority'
        then case when high_fit and (reviewed_at is null or (case
          when reviewed_semantic_digest is not null then reviewed_semantic_digest <> coalesce(semantic_digest, '')
          else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint
        end)) then 1 else 0 end end desc,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority' then fit_score end desc nulls last,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority'
        then case confidence when 'high' then 3 when 'medium' then 2 else 1 end end desc nulls last,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority' then observation_freshness end desc nulls last,
      case when lower(coalesce(p_direction, 'desc')) = 'asc' then
        case coalesce(p_sort, 'fit-score')
          when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric
          when 'completeness' then completeness_score::numeric
          when 'fit-score' then fit_score::numeric
          when 'changed' then (case when reviewed_at is null then 1
            when reviewed_semantic_digest is not null then (case when reviewed_semantic_digest <> coalesce(semantic_digest, '') then 1 else 0 end)
            when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric
        end
      end asc nulls last,
      case when lower(coalesce(p_direction, 'desc')) <> 'asc' then
        case coalesce(p_sort, 'fit-score')
          when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric
          when 'completeness' then completeness_score::numeric
          when 'fit-score' then fit_score::numeric
          when 'changed' then (case when reviewed_at is null then 1
            when reviewed_semantic_digest is not null then (case when reviewed_semantic_digest <> coalesce(semantic_digest, '') then 1 else 0 end)
            when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric
        end
      end desc nulls last,
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
      and ordinal <= greatest(0, (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 25), 1), 100))
        + least(greatest(coalesce(p_page_size, 25), 1), 100)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'summary', (select jsonb_build_object(
      'needsReview', count(*) filter (where current_triage_eligible = true
        and dismissed_deal_key is null and should_remove = false
        and (reviewed_at is null or (case when reviewed_semantic_digest is not null
          then reviewed_semantic_digest <> coalesce(semantic_digest, '')
          else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint end))),
      'highPriority', count(*) filter (where current_triage_eligible = true
        and dismissed_deal_key is null and should_remove = false
        and (high_fit or operator_priority in ('urgent', 'high'))),
      'watchlist', count(*) filter (where current_triage_eligible = true
        and dismissed_deal_key is null and should_remove = false
        and ((fit_score >= 60 and fit_score < 75) or operator_priority = 'watch')),
      'lowConfidence', count(*) filter (where current_triage_eligible = true
        and dismissed_deal_key is null and should_remove = false
        and (confidence = 'low' or contradiction_count > 0)),
      'currentOpportunities', count(*) filter (where current_triage_eligible = true and dismissed_deal_key is null)
    ) from candidates),
    'rows', coalesce((select jsonb_agg(
      (to_jsonb(ordered) - 'ordinal' - 'score_name' - 'score_listing_url')
        || public.deal_hunter_latest_campaign_fields_v1(ordered.opportunity_id) order by ordinal
    ) from ordered), '[]'::jsonb)
  );
$$;
revoke all privileges on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) to service_role;

create or replace function public.list_deal_hunter_fresh_inbox_v1(
  p_area text default 'inbox', p_offset integer default 0, p_limit integer default 25,
  p_search text default '', p_confidence text default '', p_priority text default '',
  p_state text default '', p_as_of timestamptz default now(),
  p_sort text default 'acquisition-priority'
) returns jsonb language sql stable security definer set search_path = public as $$
  with parameters as (
    select (p_as_of at time zone 'America/Los_Angeles')::date as business_date,
      greatest(0, least(coalesce(p_offset, 0), 100000)) as page_offset,
      greatest(1, least(coalesce(p_limit, 25), 100)) as page_limit
  ), due_actions as materialized (
    select request.opportunity_id, min(request.next_follow_up_at) as due_at
    from public.deal_hunter_cim_requests as request
    join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = request.opportunity_id
        and opportunity.primary_submission_id = request.submission_id
        and opportunity.status = 'active'
    join public.contact_submissions as submission on submission.id = request.submission_id
    where request.follow_up_state = 'scheduled'
      and request.request_state = 'provider_accepted'
      and request.delivery_state = 'accepted'
      and request.responded_at is null and request.follow_up_count < 5
      and request.next_follow_up_at <= p_as_of and submission.status not in ('archived', 'spam')
      and request.metadata #>> '{manualFollowUp,mode}' = 'operator-approved'
      and request.metadata #>> '{manualFollowUp,version}' = 'deal-hunter-manual-follow-up-v1'
      and request.metadata #>> '{manualFollowUp,maximumFollowUps}' = '5'
      and request.metadata #>> '{manualFollowUp,cadencePolicy}' =
        'accepted-local-date-plus-2-weekend-forward-0900-pt-v1'
      and request.metadata #>> '{manualFollowUp,stoppedAt}' is null
    group by request.opportunity_id
  ), action_evidence as materialized (
    select opportunity.opportunity_id,
      case when latest.direction = 'inbound' and latest.source = 'resend-webhook'
        and latest.kind = 'broker-reply' and latest.delivery_state = 'replied'
        then latest.occurred_at else null end as reply_at,
      case when coalesce(submission.metadata #>> '{diligence,stage}', '')
          not in ('financial-review','lender-review','loi-candidate')
        and coalesce(submission.metadata #>> '{acquisitionCommand,pipelineStage}', '')
          not in ('diligence','loi-candidate')
        then greatest(document.action_at, upload.action_at) else null end as materials_at
    from public.deal_hunter_opportunities as opportunity
    join public.contact_submissions as submission on submission.id = opportunity.primary_submission_id
    left join lateral (select direction, source, kind, delivery_state, occurred_at
      from public.crm_communications as communication
      where communication.submission_id = submission.id
      order by occurred_at desc, id desc limit 1) as latest on true
    left join lateral (select max(created_at) as action_at
      from public.secure_documents as document
      where document.submission_id = submission.id
        and document.document_type in ('cim','teaser','prospectus','offering_memorandum',
          'offering_materials','data_room','broker_materials','financials','financial_package',
          'financial_statements','p_and_l','tax_returns','balance_sheet')) as document on true
    left join lateral (select max(coalesce(last_uploaded_at, updated_at)) as action_at
      from public.secure_upload_requests as request
      where request.submission_id = submission.id
        and request.status in ('completed','documents-received')
        and exists (select 1 from pg_catalog.jsonb_array_elements(request.requested_documents) as requested(value)
          where case when pg_catalog.jsonb_typeof(requested.value) = 'string'
            then trim(both '"' from requested.value::text)
            else coalesce(requested.value ->> 'category', requested.value ->> 'id') end
            in ('cim','teaser','prospectus','offering_memorandum','offering_materials',
              'data_room','broker_materials','financials','financial_package',
              'financial_statements','p_and_l','tax_returns','balance_sheet'))
    ) as upload on true
    where opportunity.status = 'active' and submission.status not in ('archived','spam')
      and submission.follow_up_state <> 'completed'
  ), base as materialized (
    select scores.opportunity_id, scores.fit_score, scores.confidence,
      scores.contradiction_count, scores.score_fingerprint, scores.semantic_digest,
      (select max(source.updated_at)
        from public.deal_hunter_opportunity_source_observations as source
        where source.opportunity_id = scores.opportunity_id) as source_snapshot_updated_at,
      scores.operator_priority, scores.reviewed_at,
      scores.reviewed_discovery_revision, scores.reviewed_material_revision,
      scores.criteria_profile_version, scores.criteria_group, scores.auto_pursue_blocker,
      (select decision.action from public.deal_hunter_owner_decision_events as decision
        where decision.opportunity_id = scores.opportunity_id
        order by decision.created_at desc, decision.id desc limit 1) as latest_owner_action,
      opportunity.first_accepted_at, opportunity.discovery_state,
      opportunity.discovery_revision, opportunity.material_revision,
      opportunity.last_material_change_at,
      coalesce(action.reply_at, action.materials_at, due.due_at) as due_at,
      case when action.reply_at is not null then 'broker_reply'
        when action.materials_at is not null then 'materials_ready'
        when due.due_at is not null then 'due_follow_up' else null end as action_reason,
      publication_latest.publication_date,
      publication_latest.publication_instant, publication_latest.publication_state,
      publication_latest.source_name as publication_source,
      publication_latest.publication_precision,
      publication_stats.publication_distinct_count,
      publication_stats.publication_unsupported_count,
      case when p_area = 'research' then (select count(*) from (select source.field
        from public.deal_hunter_opportunity_source_observations as source
        where source.opportunity_id = scores.opportunity_id
          and source.field in ('annual_profit', 'annual_revenue', 'asking_price')
        group by source.field having count(distinct source.value) > 1) as conflict_fields)
        else 0 end
        as source_conflict_count,
      null::text as material_field
    from public.deal_hunter_opportunity_scores as scores
    join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = scores.opportunity_id and opportunity.status = 'active'
    left join public.deal_hunter_dispositions as disposition
      on disposition.deal_key = scores.deal_key and disposition.disposition = 'dismissed'
    left join due_actions as due on due.opportunity_id = scores.opportunity_id
    left join action_evidence as action on action.opportunity_id = scores.opportunity_id
    left join lateral (
      select evidence.publication_date, evidence.publication_instant,
        evidence.publication_state, evidence.source_name, evidence.publication_precision
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = scores.opportunity_id
        and opportunity.first_accepted_at is not null
        and opportunity.discovery_revision > scores.reviewed_discovery_revision
        and observation.field = 'date_added'
        and evidence.current_canonical_id = scores.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
      order by evidence.accepted_at desc, evidence.id limit 1
    ) as publication_latest on true
    left join lateral (
      select count(distinct coalesce(evidence.publication_date::text,
          evidence.publication_instant::text)) filter
          (where evidence.publication_state = 'valid') as publication_distinct_count,
        count(*) filter (where evidence.publication_state <> 'valid')
          as publication_unsupported_count
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = scores.opportunity_id
        and opportunity.first_accepted_at is not null
        and opportunity.discovery_revision > scores.reviewed_discovery_revision
        and observation.field = 'date_added'
        and evidence.current_canonical_id = scores.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
    ) as publication_stats on true
    where scores.current_triage_eligible = true and scores.should_remove = false
      and disposition.deal_key is null
      and (coalesce(p_search, '') = '' or lower(coalesce(scores.name, '')) like
        '%' || lower(p_search) || '%' or lower(coalesce(scores.deal_key, '')) like
        '%' || lower(p_search) || '%')
      and (coalesce(p_confidence, '') = '' or scores.confidence = p_confidence)
      and (coalesce(p_priority, '') = '' or scores.operator_priority = p_priority)
      and (coalesce(p_state, '') = '' or upper(coalesce(scores.state, '')) = upper(p_state))
  ), classified as materialized (
    select base.*,
      (base.discovery_state = 'known_prospective'
        or (base.discovery_state = 'known_recovered' and base.reviewed_at is null))
        and base.first_accepted_at is not null
        and base.discovery_revision > base.reviewed_discovery_revision
        and parameters.business_date - (base.first_accepted_at at time zone 'America/Los_Angeles')::date
          between 0 and 7 as new_to_ug,
      base.publication_state = 'valid' and base.publication_distinct_count = 1
        and base.publication_unsupported_count = 0
        and parameters.business_date - coalesce(base.publication_date,
          (base.publication_instant at time zone 'America/Los_Angeles')::date)
          between 0 and 30 as recently_listed,
      base.material_revision > base.reviewed_material_revision
        and base.last_material_change_at is not null as updated_since_review,
      base.due_at is not null as due_action,
      base.operator_priority in ('urgent', 'high') as owner_priority
    from base cross join parameters
  ), eligible as materialized (
    select classified.*,
      case when new_to_ug and fit_score >= 75 and confidence <> 'low'
        and discovery_revision > reviewed_discovery_revision then
          case when recently_listed then 1 else 2 end else 6 end as discovery_group,
      case when fit_score < 75 then null
        when latest_owner_action in ('watch', 'pursue') then null
        when criteria_profile_version is distinct from 'uckele-criteria-v1' then 'your-review'
        when criteria_group = 'auto' then
          case when nullif(auto_pursue_blocker, '') is not null then 'your-review'
            else 'auto-pursue' end
        when criteria_group = 'review' then 'your-review'
        when criteria_group = 'needs-info' then 'needs-info'
        when criteria_group = 'near-miss' then 'near-miss' end as criteria_area
    from classified
  ), ordered as materialized (
    select eligible.*,
      row_number() over (order by due_at asc nulls last, opportunity_id) as due_ordinal,
      row_number() over (order by case operator_priority when 'urgent' then 0
        when 'high' then 1 else 2 end, fit_score desc, opportunity_id) as priority_ordinal
    from eligible
  ), preview_candidates as (
    select ordered.*,
      min(priority_ordinal) filter (where owner_priority
        and (not due_action or due_ordinal > 2)) over () as first_remaining_priority
    from ordered
  ), memberships as (
    select 'due-actions'::text as area_id, ordered.*, null::bigint as first_remaining_priority
      from ordered where p_area = 'due-actions' and due_action
    union all select 'owner-priorities', ordered.*, null::bigint from ordered
      where p_area = 'owner-priorities' and owner_priority
    union all select 'new-important', ordered.*, null::bigint from ordered
      where p_area = 'new-important' and discovery_group <= 2
    union all select ordered.criteria_area, ordered.*, null::bigint from ordered
      where criteria_area is not null and p_area in ('inbox', criteria_area)
    union all select 'updated', ordered.*, null::bigint from ordered
      where p_area = 'updated' and updated_since_review
    union all select 'research', ordered.*, null::bigint from ordered
      where p_area = 'research'
        and (confidence = 'low' or contradiction_count > 0 or source_conflict_count > 0)
    union all select 'all-active', ordered.*, null::bigint from ordered
      where p_area = 'all-active'
    union all select 'action-preview', preview_candidates.* from preview_candidates
      where p_area in ('inbox', 'action-preview') and (due_action or owner_priority)
  ), numbered as (
    select memberships.*,
      row_number() over (partition by area_id order by
        case when area_id = 'all-active' and p_sort = 'newest-discovery'
          then first_accepted_at end desc nulls last,
        case when area_id = 'all-active' and p_sort = 'highest-fit' then fit_score end desc,
        case when area_id in ('new-important', 'auto-pursue', 'your-review', 'needs-info',
          'near-miss') then discovery_group end,
        case when area_id = 'new-important' and p_area <> 'inbox'
          and p_sort = 'newest-discovery' then first_accepted_at end desc nulls last,
        case when area_id = 'new-important' and p_area <> 'inbox'
          and p_sort = 'highest-fit' then fit_score end desc,
        case when area_id in ('all-active', 'new-important') and p_area <> 'inbox'
          and p_sort in ('newest-discovery', 'highest-fit') then opportunity_id end,
        case when area_id = 'action-preview' then
          case when due_action and due_ordinal <= 2 then 0
            when owner_priority and priority_ordinal = first_remaining_priority then 1
            when due_action then 2 else 3 end end,
        case when area_id in ('action-preview', 'due-actions') then due_at end asc nulls last,
        case when area_id = 'due-actions' then opportunity_id end,
        case when area_id = 'action-preview' and due_action and due_ordinal <= 2
          then due_ordinal end,
        case when area_id = 'action-preview' and owner_priority
          and priority_ordinal = first_remaining_priority then priority_ordinal end,
        case when area_id in ('action-preview', 'owner-priorities', 'new-important', 'auto-pursue',
          'your-review', 'needs-info', 'near-miss') then
          case operator_priority when 'urgent' then 0 when 'high' then 1 else 2 end end,
        case when area_id in ('new-important', 'auto-pursue', 'your-review', 'needs-info',
          'near-miss') then due_at end asc nulls last,
        case when area_id in ('new-important', 'auto-pursue', 'your-review', 'needs-info',
          'near-miss') then fit_score end desc,
        case when area_id in ('new-important', 'auto-pursue', 'your-review', 'needs-info',
          'near-miss') then
          case confidence when 'high' then 0 when 'medium' then 1 else 2 end end,
        case when area_id in ('new-important', 'auto-pursue', 'your-review', 'needs-info',
          'near-miss', 'research', 'all-active')
          then first_accepted_at end desc nulls last,
        case when area_id = 'updated' then last_material_change_at end desc nulls last,
        fit_score desc, opportunity_id
      ) as ordinal
    from memberships
  ), selected as materialized (
    select * from numbered where (p_area = 'inbox' and area_id in
      ('action-preview', 'auto-pursue', 'your-review', 'needs-info', 'near-miss'))
      or area_id = p_area
  ), totals as (
    select area_id, count(*)::integer as total,
      public.deal_hunter_fresh_inbox_hash_v1(
        opportunity_id || ':' || discovery_group || ':' || fit_score || ':' || confidence
        || ':' || operator_priority || ':' || coalesce(due_at::text, '')
        || ':' || coalesce(action_reason, '')
        || ':' || coalesce(first_accepted_at::text, '') || ':' || discovery_revision
        || ':' || material_revision || ':' || reviewed_discovery_revision
        || ':' || reviewed_material_revision || ':' || score_fingerprint
        || ':' || coalesce(semantic_digest, '') || ':' || coalesce(publication_state, '')
        || ':' || coalesce(publication_date::text, '')
        || ':' || source_conflict_count || ':' || coalesce(material_field, '')
        || ':' || coalesce(source_snapshot_updated_at::text, '')
        || ':' || coalesce(criteria_profile_version, '') || ':' || coalesce(criteria_group, '')
        || ':' || coalesce(auto_pursue_blocker, '') || ':' || coalesce(latest_owner_action, '')
        order by ordinal) as revision
    from selected where area_id <> 'action-preview' or ordinal <= 3
    group by area_id
  ), pages as (
    select area_id, jsonb_agg((to_jsonb(display_score) - 'operator_note')
      || (to_jsonb(numbered) - 'ordinal' - 'area_id'
        - 'due_ordinal' - 'priority_ordinal' - 'first_remaining_priority')
      || jsonb_build_object(
        'primary_submission_id', display_opp.primary_submission_id,
        'publication_date', display_publication.publication_date,
        'publication_instant', display_publication.publication_instant,
        'publication_state', display_publication.publication_state,
        'publication_source', display_publication.source_name,
        'publication_precision', display_publication.publication_precision,
        'publication_distinct_count', display_publication_stats.distinct_count,
        'publication_unsupported_count', display_publication_stats.unsupported_count,
        'recently_listed', display_publication.publication_state = 'valid'
          and display_publication_stats.distinct_count = 1
          and display_publication_stats.unsupported_count = 0
          and parameters.business_date - coalesce(display_publication.publication_date,
            (display_publication.publication_instant at time zone 'America/Los_Angeles')::date)
            between 0 and 30,
        'top_strength', display_score.summary->'strengths'->>0,
        'top_concern', display_score.summary->'concerns'->>0,
        'crm_status', coalesce((select submission.status
          from public.contact_submissions as submission
          where submission.id = display_opp.primary_submission_id), 'not-started'),
        'cim_status', coalesce((select cim.status
          from public.deal_hunter_cim_requests as cim
          where cim.opportunity_id = numbered.opportunity_id
          order by cim.updated_at desc, cim.id desc limit 1), 'not-requested'),
        'industry', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'industry'
          order by source.observed_at desc, source.id limit 1),
        'location', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'location'
          order by source.observed_at desc, source.id limit 1),
        'annual_profit', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'annual_profit'
          order by source.observed_at desc, source.id limit 1),
        'annual_profit_evidence', (select pg_catalog.jsonb_build_object(
            'metric', evidence.metric, 'period', evidence.period, 'currency', evidence.currency)
          from public.deal_hunter_opportunity_source_observations as source
          join public.deal_hunter_freshness_evidence as core on core.id = source.accepted_evidence_id
          join public.deal_hunter_freshness_evidence as evidence on evidence.run_id = core.run_id
            and evidence.source_id = core.source_id and evidence.source_record_id = core.source_record_id
            and evidence.event_type = 'accepted_source_record' and evidence.field_key = 'annual_profit'
            and evidence.current_canonical_id = numbered.opportunity_id
          where source.id = (select chosen.id from public.deal_hunter_opportunity_source_observations as chosen
            where chosen.opportunity_id = numbered.opportunity_id and chosen.field = 'annual_profit'
            order by chosen.observed_at desc, chosen.id limit 1)
            and source.value = evidence.after_value::text
          limit 1),
        'annual_revenue', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'annual_revenue'
          order by source.observed_at desc, source.id limit 1),
        'asking_price', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'asking_price'
          order by source.observed_at desc, source.id limit 1),
        'profit_multiple', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'profit_multiple'
          order by source.observed_at desc, source.id limit 1),
        'observation_freshness', coalesce((select max(source.observed_at)
          from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id), display_score.scored_at),
        'latest_accepted_observation_at', (select max(source.accepted_at)
          from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id),
        'material_field', (select event.field_key from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'material_before_value', (select event.before_value from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'material_after_value', (select event.after_value from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'material_currency', (select event.currency from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'source_conflict_count', (select count(*) from (select source.field
          from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id
            and source.field in ('annual_profit', 'annual_revenue', 'asking_price')
          group by source.field having count(distinct source.value) > 1) as conflict_fields)
      ) || public.deal_hunter_latest_campaign_fields_v1(numbered.opportunity_id)
      order by ordinal) as rows,
      max(ordinal)::integer as last_ordinal,
      (array_agg(numbered.opportunity_id order by ordinal desc))[1] as last_id
    from numbered
    join public.deal_hunter_opportunity_scores as display_score
      on display_score.opportunity_id = numbered.opportunity_id
    join public.deal_hunter_opportunities as display_opp
      on display_opp.opportunity_id = numbered.opportunity_id
    left join lateral (
      select evidence.publication_date, evidence.publication_instant,
        evidence.publication_state, evidence.source_name, evidence.publication_precision
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = numbered.opportunity_id
        and observation.field = 'date_added'
        and evidence.current_canonical_id = numbered.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
      order by evidence.accepted_at desc, evidence.id limit 1
    ) as display_publication on true
    left join lateral (
      select count(distinct coalesce(evidence.publication_date::text,
          evidence.publication_instant::text)) filter
          (where evidence.publication_state = 'valid') as distinct_count,
        count(*) filter (where evidence.publication_state <> 'valid') as unsupported_count
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = numbered.opportunity_id
        and observation.field = 'date_added'
        and evidence.current_canonical_id = numbered.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
    ) as display_publication_stats on true
    cross join parameters
    where ((p_area = 'inbox' and area_id in ('action-preview', 'auto-pursue', 'your-review',
      'needs-info', 'near-miss'))
      or area_id = p_area)
      and ordinal > case when p_area = 'inbox' then 0 else parameters.page_offset end
      and ordinal <= case when area_id = 'action-preview' then 3
        when p_area = 'inbox' then 10
        else parameters.page_offset + parameters.page_limit end
    group by area_id
  ), requested as (
    select id from (values ('action-preview'), ('auto-pursue'), ('your-review'), ('needs-info'),
      ('near-miss'), ('new-important'), ('due-actions'),
      ('owner-priorities'), ('updated'), ('research'), ('all-active')) as ids(id)
    where (p_area = 'inbox' and id in ('action-preview', 'auto-pursue', 'your-review',
      'needs-info', 'near-miss')) or id = p_area
  )
  select jsonb_build_object('asOf', p_as_of, 'businessDate', parameters.business_date,
    'areas', coalesce((select jsonb_agg(jsonb_build_object(
      'id', requested.id, 'rows', coalesce(pages.rows, '[]'::jsonb),
      'total', coalesce(totals.total, 0),
      'revision', coalesce(totals.revision, md5('')),
      'anchorId', (select anchor.opportunity_id from selected as anchor
        where anchor.area_id = requested.id and anchor.ordinal = parameters.page_offset),
      'nextOffset', case when pages.last_ordinal < totals.total then pages.last_ordinal else null end,
      'lastId', case when pages.last_ordinal < totals.total then pages.last_id else null end,
      'counts', case when requested.id = 'action-preview' then jsonb_build_object(
        'due', (select count(*) from ordered where due_action),
        'overdue', (select count(*) from ordered where due_action and action_reason = 'due_follow_up'
          and (due_at at time zone 'America/Los_Angeles')::date < parameters.business_date),
        'ownerPriority', (select count(*) from ordered where owner_priority),
        'urgent', (select count(*) from ordered where operator_priority = 'urgent'))
        else '{}'::jsonb end
    ) order by case requested.id when 'action-preview' then 0 when 'auto-pursue' then 1
      when 'your-review' then 2 when 'needs-info' then 3 when 'near-miss' then 4 else 5 end)
      from requested left join totals on totals.area_id = requested.id
      left join pages on pages.area_id = requested.id), '[]'::jsonb),
    'counts', jsonb_build_object(
      'due', (select count(*) from ordered where due_action),
      'ownerPriority', (select count(*) from ordered where owner_priority),
      'newImportant', (select count(*) from ordered where discovery_group <= 2)))
  from parameters;
$$;
revoke all on function public.list_deal_hunter_fresh_inbox_v1(
  text, integer, integer, text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.list_deal_hunter_fresh_inbox_v1(
  text, integer, integer, text, text, text, text, timestamptz, text) to service_role;

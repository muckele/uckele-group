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

-- Task 3: criteria areas in the fresh inbox.
--
-- auto_pursue_blocker / auto_pursue_checked_at are runner-owned: only the
-- automatic-Pursue runner (a later task) writes them. They are deliberately
-- absent from write_deal_hunter_opportunity_score (whose upsert names its
-- columns, so a machine rescore leaves them untouched) and from every
-- operator-owned writer. Both are nullable text; null means "not blocked" and
-- "never checked".
alter table public.deal_hunter_opportunity_scores
  add column if not exists auto_pursue_blocker text,
  add column if not exists auto_pursue_checked_at text;

-- list_deal_hunter_fresh_inbox_v1 gains four criteria areas (auto-pursue,
-- your-review, needs-info, near-miss). The default 'inbox' request now returns
-- action-preview plus those four, in that order; 'new-important' stays
-- selectable as its own area but is no longer part of the default list.
-- Placement mirrors server/services/dealHunterFreshInboxPolicy.js: a row is
-- considered only at fit_score >= 75, and a criteria_profile_version other than
-- the current 'uckele-criteria-v1' always lands in your-review, as does an
-- auto row carrying a blocker. Candidates still come from the base CTE, so
-- every existing exclusion (not current-eligible, should_remove, dismissed,
-- non-active opportunity, filters) applies unchanged. Signature and ACL are
-- unchanged; the function body is identical to supabase/schema.sql.
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
        || ':' || coalesce(auto_pursue_blocker, '')
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
      )
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

-- Task 4: decision policy version and warm-up evidence.
--
-- pursue_cim_record_owner_decision_v1 already stores p_command->>'policyVersion'
-- (any trimmed 1-120 character string) and includes it in the request digest, so
-- the automatic-Pursue policy 'auto-pursue-v1' needs no function change. The HTTP
-- owner route never forwards a policy version, so owner clicks stay
-- 'owner-decision-v1'.
--
-- One evidence row per newly recorded pursue/pass decision, written by the
-- application after the decision commits and idempotent on decision_event_id.
-- Warm-up counts (owner decisions, auto-group decisions, pursue-unchanged rate)
-- are computed from it. The row copies criteria_group / criteria_profile_version
-- from the score at decision time; recipient_unchanged records that no recipient
-- override was made. Additive; no existing object changes.
create table if not exists public.deal_hunter_auto_pursue_decision_evidence (
  decision_event_id text primary key
    references public.deal_hunter_owner_decision_events(id) on delete restrict,
  opportunity_id text not null,
  action text not null check (action in ('pursue', 'pass')),
  policy_version text not null
    check (policy_version = btrim(policy_version) and char_length(policy_version) between 1 and 120),
  criteria_group text,
  criteria_profile_version text,
  recipient_unchanged boolean not null,
  created_at timestamptz not null
);
create index if not exists idx_auto_pursue_evidence_policy
  on public.deal_hunter_auto_pursue_decision_evidence (policy_version, created_at);

alter table public.deal_hunter_auto_pursue_decision_evidence enable row level security;
revoke all on table public.deal_hunter_auto_pursue_decision_evidence
  from public, anon, authenticated, service_role;
grant select, insert on table public.deal_hunter_auto_pursue_decision_evidence to service_role;

-- Task 5: automatic Pursue activation, runs, and runner-owned blockers.
--
-- The activation ladder (off | shadow | canary | active) ships off: with no row
-- the runner treats the capability as off. Each run claims a unique run_key
-- (auto-pursue:<owner business date>:<mode>:<completed runs that day>). The daily
-- cap is enforced from deal_hunter_owner_decision_events (policy auto-pursue-v1),
-- not from these rows. Additive; no existing object changes.
create table if not exists public.deal_hunter_auto_pursue_activations (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 120),
  mode text not null check (mode in ('off', 'shadow', 'canary', 'active')),
  daily_cap integer not null check (daily_cap between 0 and 10),
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 160),
  reason text not null default '' check (char_length(reason) <= 500),
  confirmation text not null,
  status text not null check (status in ('current', 'superseded')),
  created_at timestamptz not null,
  superseded_at timestamptz,
  constraint deal_hunter_auto_pursue_activations_mode_cap check (
    (mode in ('off', 'shadow') and daily_cap = 0)
    or (mode = 'canary' and daily_cap = 1)
    or (mode = 'active' and daily_cap between 1 and 10)),
  constraint deal_hunter_auto_pursue_activations_confirmation check (confirmation = case mode
    when 'off' then 'SET AUTO PURSUE OFF'
    when 'shadow' then 'ACTIVATE AUTO PURSUE SHADOW'
    when 'canary' then 'ACTIVATE AUTO PURSUE CANARY'
    when 'active' then 'ACTIVATE AUTO PURSUE ACTIVE' end)
);
create unique index if not exists idx_auto_pursue_activations_current
  on public.deal_hunter_auto_pursue_activations (status) where status = 'current';

create table if not exists public.deal_hunter_auto_pursue_runs (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 120),
  run_key text not null unique check (char_length(run_key) between 1 and 200),
  business_date text not null check (business_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  mode text not null check (mode in ('off', 'shadow', 'canary', 'active')),
  status text not null check (status in ('running', 'completed', 'failed')),
  triggered_by text not null default '' check (char_length(triggered_by) <= 120),
  commands integer not null default 0 check (commands between 0 and 10),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  reason text check (reason is null or char_length(reason) <= 120),
  created_at timestamptz not null,
  completed_at timestamptz
);
create index if not exists idx_auto_pursue_runs_business_date
  on public.deal_hunter_auto_pursue_runs (business_date, created_at);

alter table public.deal_hunter_auto_pursue_activations enable row level security;
alter table public.deal_hunter_auto_pursue_runs enable row level security;
revoke all on table public.deal_hunter_auto_pursue_activations
  from public, anon, authenticated, service_role;
revoke all on table public.deal_hunter_auto_pursue_runs
  from public, anon, authenticated, service_role;
grant select on table public.deal_hunter_auto_pursue_activations to service_role;
grant select, insert, update on table public.deal_hunter_auto_pursue_runs to service_role;

-- The only activation writer: supersedes the current row and inserts the new one
-- in one transaction, serialized so two concurrent mode changes cannot both win.
create or replace function public.create_deal_hunter_auto_pursue_activation_v1(p_activation jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.deal_hunter_auto_pursue_activations%rowtype;
  v_created_at timestamptz;
begin
  if p_activation is null or pg_catalog.jsonb_typeof(p_activation) <> 'object'
    or pg_catalog.jsonb_typeof(p_activation -> 'daily_cap') <> 'number'
    or p_activation ->> 'created_at' is null
  then
    raise exception 'Invalid automatic Pursue activation';
  end if;
  v_created_at := (p_activation ->> 'created_at')::timestamptz;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('deal_hunter_auto_pursue_activation'));
  update public.deal_hunter_auto_pursue_activations
    set status = 'superseded', superseded_at = v_created_at
    where status = 'current';
  insert into public.deal_hunter_auto_pursue_activations
    (id, mode, daily_cap, actor, reason, confirmation, status, created_at, superseded_at)
  values (p_activation ->> 'id', p_activation ->> 'mode', (p_activation ->> 'daily_cap')::integer,
    p_activation ->> 'actor', coalesce(p_activation ->> 'reason', ''), p_activation ->> 'confirmation',
    'current', v_created_at, null)
  returning * into v_row;
  return pg_catalog.to_jsonb(v_row);
end;
$$;
revoke all on function public.create_deal_hunter_auto_pursue_activation_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.create_deal_hunter_auto_pursue_activation_v1(jsonb) to service_role;

-- The only writer of the runner-owned score columns. Rows whose blocker is
-- unchanged are left alone: the blocker is part of the inbox cursor revision.
create or replace function public.set_deal_hunter_auto_pursue_blockers_v1(p_entries jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
begin
  if p_entries is null or pg_catalog.jsonb_typeof(p_entries) <> 'array'
    or pg_catalog.jsonb_array_length(p_entries) > 10000
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_entries) as entry
      where pg_catalog.jsonb_typeof(entry) <> 'object'
        or coalesce(entry ->> 'opportunity_id', '') = ''
        or pg_catalog.jsonb_typeof(entry -> 'blocker') not in ('string', 'null')
        or (entry ->> 'blocker' is not null and entry ->> 'blocker' !~ '^[a-z_]{1,80}$')
        or coalesce(entry ->> 'checked_at', '') = '')
  then
    raise exception 'Invalid automatic Pursue blocker entries';
  end if;
  update public.deal_hunter_opportunity_scores as scores
    set auto_pursue_blocker = entry.blocker, auto_pursue_checked_at = entry.checked_at
    from (
      select distinct on (value ->> 'opportunity_id')
        value ->> 'opportunity_id' as opportunity_id,
        value ->> 'blocker' as blocker,
        value ->> 'checked_at' as checked_at
      from pg_catalog.jsonb_array_elements(p_entries)
    ) as entry
    where scores.opportunity_id = entry.opportunity_id
      and scores.auto_pursue_blocker is distinct from entry.blocker;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;
revoke all on function public.set_deal_hunter_auto_pursue_blockers_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.set_deal_hunter_auto_pursue_blockers_v1(jsonb) to service_role;

-- Automatic Pursue (auto-pursue-v1) goes through the owner-decision writer under the
-- same advisory lock (re-entrant), after refusing when any owner decision exists for the
-- opportunity (so an owner Watch, Pass, or Pursue always wins), when the command instant
-- is outside the guarded owner business day, or when that day's cap is reached. A replay
-- of the same idempotency key is delegated unchanged. The locked writer itself is unchanged.
create or replace function public.pursue_cim_record_auto_pursue_decision_v1(p_command jsonb, p_guard jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_key text := p_command ->> 'idempotencyKey';
  v_now timestamptz;
  v_since timestamptz;
  v_until timestamptz;
  v_cap integer;
  v_recorded bigint;
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or p_guard is null or pg_catalog.jsonb_typeof(p_guard) <> 'object'
    or p_command ->> 'action' is distinct from 'pursue'
    or p_command ->> 'policyVersion' is distinct from 'auto-pursue-v1'
    or p_command ->> 'actor' is distinct from 'automation-auto-pursue'
    or v_opportunity_id is null or v_key is null or p_command ->> 'now' is null
    or pg_catalog.jsonb_typeof(p_guard -> 'dailyCap') <> 'number'
    or p_guard ->> 'since' is null or p_guard ->> 'until' is null
  then
    raise exception 'Invalid automatic Pursue decision command';
  end if;
  v_cap := (p_guard ->> 'dailyCap')::integer;
  v_now := (p_command ->> 'now')::timestamptz;
  v_since := (p_guard ->> 'since')::timestamptz;
  v_until := (p_guard ->> 'until')::timestamptz;
  if v_cap is null or v_cap not between 1 and 10 or v_since >= v_until then
    raise exception 'Invalid automatic Pursue guard';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  if exists (select 1 from public.deal_hunter_owner_decision_events where idempotency_key = v_key) then
    return public.pursue_cim_record_owner_decision_v1(p_command);
  end if;
  if exists (select 1 from public.deal_hunter_owner_decision_events
    where opportunity_id = v_opportunity_id) then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'reason', 'auto_pursue_owner_decision_exists', 'decision', null, 'enrollment', null);
  end if;
  if v_now < v_since or v_now >= v_until then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'reason', 'auto_pursue_business_date_changed', 'decision', null, 'enrollment', null);
  end if;
  select pg_catalog.count(*) into v_recorded from public.deal_hunter_owner_decision_events
    where policy_version = 'auto-pursue-v1' and created_at >= v_since and created_at < v_until;
  if v_recorded >= v_cap then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'reason', 'auto_pursue_daily_cap_reached', 'decision', null, 'enrollment', null);
  end if;
  return public.pursue_cim_record_owner_decision_v1(p_command);
end;
$$;
revoke all on function public.pursue_cim_record_auto_pursue_decision_v1(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_record_auto_pursue_decision_v1(jsonb, jsonb) to service_role;

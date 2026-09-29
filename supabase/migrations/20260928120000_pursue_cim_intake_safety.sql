-- Package 2: admitted source commits append inert campaign-safety evidence.
-- This helper is callable only by the owner of the admitted writer functions.
create or replace function public.pursue_cim_emit_admitted_import_safety_v1(
  p_source_id text, p_run_id text, p_opportunity_id text, p_source_record_id text,
  p_event_type text, p_evidence_digest text, p_accepted_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_source_type text;
  v_safety_run_id text;
  v_evidence_id text;
  v_id text;
  v_record_key text;
  v_event_type text;
  v_revision bigint;
  v_prior public.deal_hunter_cim_safety_events%rowtype;
begin
  if p_source_id is null or p_run_id is null or p_opportunity_id is null
    or p_source_record_id is null or p_event_type is null or p_evidence_digest is null
    or p_accepted_at is null or pg_catalog.length(p_run_id) not between 1 and 200
    or pg_catalog.length(p_source_record_id) not between 1 and 200 then
    raise exception 'Invalid admitted import safety identity';
  end if;
  v_source_type := case when p_source_id = 'deal-os-export' then 'deal-os-import'
    when p_source_id ~ '^sheet-(0|[1-9][0-9]*)$' then 'sheet-import'
    else null end;
  if v_source_type is null then raise exception 'Unsupported admitted import safety source'; end if;
  select material_revision into v_revision from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id
      and (status = 'active' or (status = 'superseded' and p_event_type = 'source-record-removed'))
    for update;
  if not found then raise exception 'Admitted safety evidence lacks a current canonical opportunity'; end if;
  v_safety_run_id := 'cim-source:' || public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb(p_source_id), pg_catalog.to_jsonb(p_run_id));
  v_record_key := pg_catalog.left(public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-source-record:v1'::text),
    pg_catalog.to_jsonb(p_source_id), pg_catalog.to_jsonb(p_source_record_id)), 32);
  v_event_type := p_event_type || '#' || v_record_key;
  v_evidence_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-source-evidence:v1'::text),
    pg_catalog.to_jsonb(p_source_id), pg_catalog.to_jsonb(p_run_id),
    pg_catalog.to_jsonb(p_source_record_id), pg_catalog.to_jsonb(v_event_type),
    pg_catalog.to_jsonb(p_evidence_digest));
  v_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-safety:v1'::text), pg_catalog.to_jsonb(v_safety_run_id),
    pg_catalog.to_jsonb(p_opportunity_id), pg_catalog.to_jsonb(v_event_type),
    pg_catalog.to_jsonb(v_evidence_id));
  select * into v_prior from public.deal_hunter_cim_safety_events
    where safety_run_id = v_safety_run_id and opportunity_id = p_opportunity_id
      and pg_catalog.right(event_type, 33) = '#' || v_record_key for update;
  if found then
    if v_prior.safety_run_id <> v_safety_run_id or v_prior.opportunity_id <> p_opportunity_id
      or v_prior.source_type <> v_source_type or v_prior.source_run_id <> p_run_id
      or v_prior.evidence_id <> public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-source-evidence:v1'::text),
        pg_catalog.to_jsonb(p_source_id), pg_catalog.to_jsonb(p_run_id),
        pg_catalog.to_jsonb(p_source_record_id), pg_catalog.to_jsonb(v_prior.event_type),
        pg_catalog.to_jsonb(p_evidence_digest)) then
      raise exception 'Conflicting admitted source safety event';
    end if;
    return;
  end if;
  if (select pg_catalog.count(*) from public.deal_hunter_cim_safety_events
    where safety_run_id = v_safety_run_id) >= 10000 then
    raise exception 'Admitted safety run exceeds its bounded reader';
  end if;
  insert into public.deal_hunter_cim_safety_events
    (id, safety_run_id, opportunity_id, source_type, source_run_id,
     canonical_revision, identity_exception_revision, event_type, evidence_id,
     status, created_at, updated_at)
  values (v_id, v_safety_run_id, p_opportunity_id, v_source_type, p_run_id,
    v_revision, 0, v_event_type, v_evidence_id, 'pending', p_accepted_at, p_accepted_at);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('safety-emitted'::text), pg_catalog.to_jsonb(v_id)),
    'safety-emitted', p_opportunity_id, 'pending', v_source_type, p_run_id,
    p_accepted_at, '{}'::jsonb);
end;
$$;
revoke all on function public.pursue_cim_emit_admitted_import_safety_v1(
  text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;

-- The original complete admission remains the sole writer. This wrapper adds
-- safety evidence within its transaction, including deferred and disappeared rows.
alter function public.accept_admitted_complete_google_sheet_freshness_v1(jsonb, text)
  rename to accept_admitted_complete_google_sheet_freshness_p1c;
revoke all on function public.accept_admitted_complete_google_sheet_freshness_p1c(jsonb, text)
  from public, anon, authenticated, service_role;
create or replace function public.accept_admitted_complete_google_sheet_freshness_v1(
  p_admission jsonb, p_records_text text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_source_id text := p_admission ->> 'source_id';
  v_run_id text := p_admission -> 'run' ->> 'runId';
  v_payload jsonb := p_records_text::jsonb;
  v_records jsonb;
  v_unresolved jsonb;
  v_prior jsonb;
  v_result jsonb;
  v_record jsonb;
  v_old jsonb;
  v_item jsonb;
  v_candidate text;
  v_core_id text;
  v_event_type text;
  v_accepted_at timestamptz;
begin
  v_records := case when pg_catalog.jsonb_typeof(v_payload) = 'array' then v_payload
    else v_payload -> 'records' end;
  v_unresolved := case when pg_catalog.jsonb_typeof(v_payload) = 'array' then '[]'::jsonb
    else coalesce(v_payload -> 'unresolved', '[]'::jsonb) end;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'opportunityId', prior.opportunity_id, 'sourceRecordId', prior.source_record_id,
    'evidenceId', prior.accepted_evidence_id)), '[]'::jsonb) into v_prior
    from (select distinct on (opportunity_id, source_record_id)
      opportunity_id, source_record_id, accepted_evidence_id
      from public.deal_hunter_opportunity_source_observations
      where source_id = v_source_id
      order by opportunity_id, source_record_id, accepted_evidence_id nulls last) as prior;
  v_result := public.accept_admitted_complete_google_sheet_freshness_p1c(
    p_admission, p_records_text);
  select accepted_at into v_accepted_at from public.deal_hunter_source_freshness_state
    where source_id = v_source_id and accepted_run_id = v_run_id;
  if v_accepted_at is null then raise exception 'Admitted Sheet run was not accepted'; end if;
  for v_record in select value from pg_catalog.jsonb_array_elements(v_records) loop
    select id into v_core_id from public.deal_hunter_freshness_evidence
      where source_id = v_source_id and run_id = v_run_id
        and source_record_id = v_record ->> 'source_record_id'
        and event_type = 'accepted_source_record' and field_key = '' limit 1;
    v_event_type := case when found or v_result ->> 'projectionState' = 'deferred'
      then 'source-record-changed' else 'source-record-unchanged' end;
    if v_core_id is null then
      select accepted_evidence_id into v_core_id
        from public.deal_hunter_opportunity_source_observations
        where source_id = v_source_id and source_record_id = v_record ->> 'source_record_id'
          and opportunity_id = v_record ->> 'opportunity_id'
        limit 1;
    end if;
    perform public.pursue_cim_emit_admitted_import_safety_v1(v_source_id, v_run_id,
      v_record ->> 'opportunity_id', v_record ->> 'source_record_id', v_event_type,
      coalesce(v_core_id, ''), v_accepted_at);
  end loop;
  for v_item in select value from pg_catalog.jsonb_array_elements(v_unresolved) loop
    for v_candidate in select candidate.value from public.deal_hunter_identity_exceptions as exception,
      lateral pg_catalog.jsonb_array_elements_text(exception.candidate_opportunity_ids) as candidate(value)
      where exception.id = v_item ->> 'identity_exception_id' and exception.status = 'open'
    loop
      if exists (select 1 from public.deal_hunter_opportunities
        where opportunity_id = v_candidate and status = 'active') then
        perform public.pursue_cim_emit_admitted_import_safety_v1(v_source_id, v_run_id,
          v_candidate, v_item ->> 'source_record_id', 'identity-exception',
          v_item ->> 'identity_exception_id', v_accepted_at);
      end if;
    end loop;
  end loop;
  if v_result ->> 'projectionState' <> 'deferred' then
    for v_old in select value from pg_catalog.jsonb_array_elements(v_prior) loop
      if not exists (select 1 from public.deal_hunter_opportunity_source_observations
        where source_id = v_source_id and opportunity_id = v_old ->> 'opportunityId'
          and source_record_id = v_old ->> 'sourceRecordId') then
        perform public.pursue_cim_emit_admitted_import_safety_v1(v_source_id, v_run_id,
          v_old ->> 'opportunityId', v_old ->> 'sourceRecordId', 'source-record-removed',
          coalesce(v_old ->> 'evidenceId', ''), v_accepted_at);
      end if;
    end loop;
  end if;
  return v_result;
end;
$$;
revoke all on function public.accept_admitted_complete_google_sheet_freshness_v1(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.accept_admitted_complete_google_sheet_freshness_v1(jsonb, text)
  to service_role;

alter function public.bind_accepted_deal_hunter_freshness_v1(uuid, text, text, bigint, jsonb)
  rename to bind_accepted_deal_hunter_freshness_p1c;
revoke all on function public.bind_accepted_deal_hunter_freshness_p1c(uuid, text, text, bigint, jsonb)
  from public, anon, authenticated, service_role;
create or replace function public.bind_accepted_deal_hunter_freshness_v1(
  p_import_id uuid, p_opportunity_id text, p_source_record_id text,
  p_expected_generation bigint, p_snapshot jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_event public.deal_hunter_freshness_evidence%rowtype;
  v_result jsonb;
  v_type text;
begin
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'field', field, 'value', value) order by field), '[]'::jsonb) into v_before
    from public.deal_hunter_opportunity_source_observations
    where source_id = 'deal-os-export' and opportunity_id = p_opportunity_id
      and source_record_id = p_source_record_id;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'field', observation.value ->> 'field', 'value', observation.value ->> 'value')
    order by observation.value ->> 'field'), '[]'::jsonb) into v_after
    from pg_catalog.jsonb_array_elements(p_snapshot -> 'observations') as observation(value);
  select * into v_event from public.deal_hunter_freshness_evidence
    where source_id = 'deal-os-export' and run_id = p_import_id::text
      and source_record_id = p_source_record_id
      and event_type = 'accepted_source_record' and field_key = ''
    order by event_ordinal limit 1;
  v_result := public.bind_accepted_deal_hunter_freshness_p1c(p_import_id,
    p_opportunity_id, p_source_record_id, p_expected_generation, p_snapshot);
  if v_event.id is null then raise exception 'Accepted Deal OS core evidence is missing'; end if;
  v_type := case when v_result ->> 'projectionState' = 'superseded'
    then 'source-record-superseded'
    when v_before = v_after then 'source-record-unchanged'
    else 'source-record-changed' end;
  perform public.pursue_cim_emit_admitted_import_safety_v1('deal-os-export', p_import_id::text,
    p_opportunity_id, p_source_record_id, v_type,
    public.pursue_cim_digest_v1(pg_catalog.to_jsonb(v_event.id), v_after), v_event.accepted_at);
  return v_result;
end;
$$;
revoke all on function public.bind_accepted_deal_hunter_freshness_v1(uuid, text, text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.bind_accepted_deal_hunter_freshness_v1(uuid, text, text, bigint, jsonb)
  to service_role;

-- A public storage primitive may still create synthetic safety evidence, but
-- it cannot claim to be an admitted Sheet or Deal OS import.
alter function public.pursue_cim_append_safety_events_v1(jsonb)
  rename to pursue_cim_append_safety_events_p1c;
revoke all on function public.pursue_cim_append_safety_events_p1c(jsonb)
  from public, anon, authenticated, service_role;
create or replace function public.pursue_cim_append_safety_events_v1(p_run jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_run ->> 'sourceType' in ('sheet-import', 'deal-os-import') then
    raise exception 'Admitted import safety events require their source commit';
  end if;
  return public.pursue_cim_append_safety_events_p1c(p_run);
end;
$$;
revoke all on function public.pursue_cim_append_safety_events_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_safety_events_v1(jsonb) to service_role;

-- The P1C transition owns all stop/review fencing. Only a known unchanged
-- import can terminally no-op while an existing campaign remains active.
alter function public.pursue_cim_consume_safety_events_v1(jsonb)
  rename to pursue_cim_consume_safety_events_p1c;
revoke all on function public.pursue_cim_consume_safety_events_p1c(jsonb)
  from public, anon, authenticated, service_role;
create or replace function public.pursue_cim_consume_safety_events_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.deal_hunter_cim_safety_events%rowtype;
  v_actor text;
  v_now timestamptz;
  v_run_id text;
  v_batch_ids text[];
  v_counts record;
begin
  v_run_id := p_command ->> 'safetyRunId';
  v_actor := p_command ->> 'actor';
  v_now := (p_command ->> 'now')::timestamptz;
  select coalesce(pg_catalog.array_agg(id), array[]::text[]) into v_batch_ids
    from (select id from public.deal_hunter_cim_safety_events
      where safety_run_id = v_run_id and status = 'pending'
      order by created_at, id limit (p_command ->> 'limit')::integer for update) as batch;
  perform public.pursue_cim_consume_safety_events_p1c(p_command);
  for v_event in select * from public.deal_hunter_cim_safety_events
    where safety_run_id = v_run_id and status = 'pending'
      and id = any(v_batch_ids)
      and pg_catalog.split_part(event_type, '#', 1)
        in ('source-record-unchanged', 'source-record-superseded')
      and p_command -> 'outcomes' ->> id = 'no-op'
    order by created_at, id for update
  loop
    if exists (select 1 from public.deal_hunter_cim_campaigns
      where opportunity_id = v_event.opportunity_id
        and state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')) then
      update public.deal_hunter_cim_safety_events set status = 'no-op',
        outcome_evidence_id = v_event.id, consumed_at = v_now, updated_at = v_now
        where id = v_event.id and status = 'pending';
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, prior_state, next_state, actor, source,
         occurred_at, metadata)
      values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('safety-consumed'::text), pg_catalog.to_jsonb(v_event.id)),
        'safety-consumed', v_event.opportunity_id, 'pending', 'no-op', v_actor,
        'postgres-transition', v_now, '{}'::jsonb);
    end if;
  end loop;
  select pg_catalog.count(*) filter (where status = 'stopped') as stopped,
    pg_catalog.count(*) filter (where status = 'review-required') as review_required,
    pg_catalog.count(*) filter (where status = 'no-op') as no_op,
    pg_catalog.count(*) filter (where status = 'pending') as pending
    into v_counts from public.deal_hunter_cim_safety_events where safety_run_id = v_run_id;
  return pg_catalog.jsonb_build_object('stopped', v_counts.stopped,
    'reviewRequired', v_counts.review_required, 'noOp', v_counts.no_op,
    'pending', v_counts.pending);
end;
$$;
revoke all on function public.pursue_cim_consume_safety_events_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_consume_safety_events_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_read_import_outreach_counters_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'ownerDecisions', (select pg_catalog.count(*) from public.deal_hunter_owner_decision_events),
    'enrollments', (select pg_catalog.count(*) from public.deal_hunter_pursuit_enrollments),
    'campaigns', (select pg_catalog.count(*) from public.deal_hunter_cim_campaigns),
    'touches', (select pg_catalog.count(*) from public.deal_hunter_cim_campaign_touches),
    'transmissions', (select pg_catalog.count(*) from public.deal_hunter_cim_transmissions),
    'memberships', (select pg_catalog.count(*) from public.deal_hunter_cim_transmission_touches),
    'crmOutbound', (select pg_catalog.count(*) from public.crm_communications where direction = 'outbound'),
    'outbox', (select pg_catalog.count(*) from public.crm_email_outbox),
    'providerAuthorizations', (select pg_catalog.count(*) from public.deal_hunter_cim_live_provider_authorizations),
    'providerPending', (select pg_catalog.count(*) from public.deal_hunter_cim_transmissions
      where state = 'provider-pending'),
    'providerSeamEntries', (select pg_catalog.count(*) from public.deal_hunter_cim_transmissions
      where provider_seam_entered_at is not null));
$$;
revoke all on function public.pursue_cim_read_import_outreach_counters_v1()
  from public, anon, authenticated;
grant execute on function public.pursue_cim_read_import_outreach_counters_v1()
  to service_role;

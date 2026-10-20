-- FL02 restore-for-review only. No permission, suppression, capacity, campaign,
-- enrollment or scheduling authority is created, removed or reopened.
create or replace function public.restore_archived_submission_with_crm_activity(
  p_payload jsonb, p_activity jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_submission public.contact_submissions;
  v_opportunity public.deal_hunter_opportunities;
  v_disposition public.deal_hunter_dispositions;
  v_submission_id uuid;
  v_now timestamptz;
  v_candidates text[] := array[]::text[];
  v_owners text[];
  v_keys text[];
  v_opportunity_id text;
  v_key text;
  v_metadata jsonb;
  v_previous_command jsonb;
  v_command jsonb;
  v_command_time timestamptz;
  v_disposition_ids uuid[] := array[]::uuid[];
  v_clear_projection boolean := false;
  v_record jsonb;
  v_activity jsonb;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Atomic CRM restore requires read committed isolation';
  end if;
  if p_activity ->> 'submission_id' is distinct from p_payload ->> 'id'
    or p_activity ->> 'event_type' is distinct from 'submission.restored'
    or p_activity ->> 'role' is distinct from 'admin'
    or coalesce(p_payload ->> 'status', '') <> all(array['sourced','new','review','contacted'])
    or nullif(p_payload ->> 'expectedUpdatedAt', '') is null
    or nullif(p_activity ->> 'created_at', '') is null
    or exists (select 1 from jsonb_object_keys(p_payload) as key
      where key <> all(array['id','status','expectedUpdatedAt'])) then
    raise exception 'Invalid atomic CRM restore authority';
  end if;
  v_submission_id := (p_payload ->> 'id')::uuid;
  v_now := (p_activity ->> 'created_at')::timestamptz;
  if not isfinite(v_now) then raise exception 'Invalid atomic CRM restore time'; end if;
  -- Reuse the current terminal gate and complete-set CRM authority convention.
  -- Table locks also stabilize a second primary/new alias/disposition (phantoms),
  -- not just the rows that happened to match before lock acquisition.
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  lock table public.contact_submissions, public.crm_submission_supersessions,
    public.deal_hunter_opportunities, public.deal_hunter_opportunity_aliases,
    public.deal_hunter_opportunity_scores, public.deal_hunter_dispositions
    in share row exclusive mode;
  select * into v_submission from public.contact_submissions where id = v_submission_id;
  if v_submission.id is null or v_submission.status <> 'archived'
    or v_submission.updated_at is distinct from (p_payload ->> 'expectedUpdatedAt')::timestamptz then
    return jsonb_build_object('applied', false, 'reason', 'restore-version-conflict', 'record', null, 'activity', null);
  end if;
  if exists (select 1 from public.crm_submission_supersessions
    where superseded_submission_id = v_submission_id and status = 'active') then
    return jsonb_build_object('applied', false, 'reason', 'restore-identity-conflict', 'record', null, 'activity', null);
  end if;
  v_metadata := v_submission.metadata;
  v_previous_command := v_metadata -> 'acquisitionCommand';
  if jsonb_typeof(v_previous_command -> 'updatedAt') = 'string'
    and v_previous_command ->> 'updatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])$'
    and pg_input_is_valid(v_previous_command ->> 'updatedAt', 'timestamp with time zone') then
    v_command_time := (v_previous_command ->> 'updatedAt')::timestamptz;
    if not isfinite(v_command_time) then v_command_time := null; end if;
  end if;
  if jsonb_typeof(v_metadata) is distinct from 'object'
    or (v_metadata -> 'dealHunter' is not null and jsonb_typeof(v_metadata -> 'dealHunter') not in ('object','null'))
    or (v_metadata #> '{dealHunter,opportunityId}' is not null
      and jsonb_typeof(v_metadata #> '{dealHunter,opportunityId}') not in ('string','null'))
    or (v_metadata #> '{dealHunter,dealKey}' is not null
      and jsonb_typeof(v_metadata #> '{dealHunter,dealKey}') not in ('string','null')) then
    return jsonb_build_object('applied', false, 'reason', 'restore-identity-conflict', 'record', null, 'activity', null);
  end if;
  select coalesce(array_agg(distinct candidate), array[]::text[]) into v_candidates from (
    select nullif(v_submission.deal_hunter_opportunity_id, '') as candidate
    union select nullif(v_metadata #>> '{dealHunter,opportunityId}', '')
    union select opportunity_id from public.deal_hunter_opportunities where primary_submission_id = v_submission_id
  ) as claims where candidate is not null;
  if nullif(v_metadata #>> '{dealHunter,dealKey}', '') is not null then
    select array_agg(distinct opportunity_id) into v_owners from (
      select opportunity_id from public.deal_hunter_opportunity_aliases
        where alias_type = 'deal-key' and alias_value = v_metadata #>> '{dealHunter,dealKey}'
      union select opportunity_id from public.deal_hunter_opportunity_scores
        where deal_key = v_metadata #>> '{dealHunter,dealKey}'
    ) as owners;
    if coalesce(cardinality(v_owners), 0) <> 1 then
      return jsonb_build_object('applied', false, 'reason', 'restore-identity-conflict', 'record', null, 'activity', null);
    end if;
    v_candidates := v_candidates || v_owners;
  end if;
  for v_disposition in select * from public.deal_hunter_dispositions
    where submission_id = v_submission_id and disposition = 'dismissed' order by id
  loop
    select array_agg(distinct opportunity_id) into v_owners from (
      select opportunity_id from public.deal_hunter_opportunity_aliases
        where alias_type = 'deal-key' and alias_value = v_disposition.deal_key
      union select opportunity_id from public.deal_hunter_opportunity_scores where deal_key = v_disposition.deal_key
    ) as owners;
    if coalesce(cardinality(v_owners), 0) <> 1 then
      return jsonb_build_object('applied', false, 'reason', 'restore-identity-conflict', 'record', null, 'activity', null);
    end if;
    v_candidates := v_candidates || v_owners;
  end loop;
  select coalesce(array_agg(distinct value), array[]::text[]) into v_candidates from unnest(v_candidates) as value;
  if cardinality(v_candidates) > 1 then
    return jsonb_build_object('applied', false, 'reason', 'restore-identity-conflict', 'record', null, 'activity', null);
  end if;
  v_opportunity_id := v_candidates[1];
  if v_opportunity_id is not null then
    select * into v_opportunity from public.deal_hunter_opportunities where opportunity_id = v_opportunity_id;
    if v_opportunity.opportunity_id is null or v_opportunity.status <> 'active'
      or v_opportunity.primary_submission_id is distinct from v_submission_id then
      return jsonb_build_object('applied', false, 'reason', 'restore-identity-conflict', 'record', null, 'activity', null);
    end if;
    select array_agg(distinct deal_key) into v_keys from (
      select alias_value as deal_key from public.deal_hunter_opportunity_aliases
        where opportunity_id = v_opportunity_id and alias_type = 'deal-key'
      union select deal_key from public.deal_hunter_opportunity_scores where opportunity_id = v_opportunity_id
    ) as keys where nullif(deal_key, '') is not null;
    foreach v_key in array coalesce(v_keys, array[]::text[]) loop
      if exists (select 1 from public.deal_hunter_opportunity_aliases
          where alias_type = 'deal-key' and alias_value = v_key and opportunity_id <> v_opportunity_id)
        or exists (select 1 from public.deal_hunter_opportunity_scores
          where deal_key = v_key and opportunity_id <> v_opportunity_id) then
        return jsonb_build_object('applied', false, 'reason', 'restore-identity-conflict', 'record', null, 'activity', null);
      end if;
      select * into v_disposition from public.deal_hunter_dispositions where deal_key = v_key;
      if v_disposition.disposition = 'dismissed' then
        if v_disposition.submission_id is not null and v_disposition.submission_id <> v_submission_id then
          return jsonb_build_object('applied', false, 'reason', 'restore-identity-conflict', 'record', null, 'activity', null);
        end if;
        v_disposition_ids := array_append(v_disposition_ids, v_disposition.id);
        if v_previous_command ->> 'pipelineStage' = 'passed'
          and v_previous_command ->> 'passReason' = v_disposition.reason
          and v_command_time = v_disposition.dismissed_at then
          v_clear_projection := true;
        end if;
      end if;
    end loop;
  end if;
  if v_clear_projection then
    v_command := v_previous_command - 'pipelineStage' - 'passReason';
    if v_command ->> 'fitFeedback' = 'false-positive' then v_command := v_command - 'fitFeedback'; end if;
    v_metadata := jsonb_set(v_metadata, '{acquisitionCommand}', v_command);
  end if;
  select coalesce(array_agg(value order by value), array[]::uuid[])
    into v_disposition_ids from unnest(v_disposition_ids) as value;
  update public.deal_hunter_dispositions set disposition = 'restored', updated_at = v_now,
    updated_by = p_activity ->> 'actor', restored_at = v_now, restored_by = p_activity ->> 'actor'
    where id = any(v_disposition_ids) and disposition = 'dismissed';
  update public.contact_submissions set status = p_payload ->> 'status', updated_at = v_now,
    status_updated_at = v_now, restored_at = v_now, restored_by = p_activity ->> 'actor',
    follow_up_state = 'completed', next_action_at = null, metadata = v_metadata
    where id = v_submission_id returning to_jsonb(contact_submissions) into v_record;
  p_activity := p_activity || jsonb_build_object('opportunity_id', v_opportunity_id,
    'metadata', coalesce(p_activity -> 'metadata', '{}'::jsonb) || jsonb_build_object(
      'restoredCanonicalOpportunityId', v_opportunity_id, 'restoredDispositionIds', to_jsonb(v_disposition_ids),
      'previousAcquisitionCommand', v_previous_command, 'outreachRestarted', false, 'permissionChanged', false));
  insert into public.crm_activity_events select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
    returning to_jsonb(crm_activity_events) into v_activity;
  return jsonb_build_object('applied', true, 'record', v_record, 'activity', v_activity);
end;
$$;
revoke all on function public.restore_archived_submission_with_crm_activity(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.restore_archived_submission_with_crm_activity(jsonb, jsonb) to service_role;

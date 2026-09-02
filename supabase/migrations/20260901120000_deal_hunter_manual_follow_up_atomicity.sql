create or replace function public.start_deal_hunter_manual_follow_ups(
  p_request_id text,
  p_expected_request_updated_at timestamptz,
  p_expected_submission_id uuid,
  p_expected_submission_updated_at timestamptz,
  p_marker jsonb,
  p_next_follow_up_at timestamptz,
  p_activity jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_marker jsonb;
  v_enrolled_at timestamptz;
  v_enrolled_by text;
  v_activity jsonb;
begin
  select * into v_submission
  from public.contact_submissions as submission
  where submission.id = p_expected_submission_id
  for update;

  select * into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;

  if v_current.id is null then
    return jsonb_build_object('applied', false, 'reason', 'request-missing', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_submission.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object('applied', false, 'reason', 'submission-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_current.updated_at is distinct from p_expected_request_updated_at
    or v_submission.updated_at is distinct from p_expected_submission_updated_at then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  if jsonb_typeof(p_marker) is distinct from 'object' then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  if (select count(*) from jsonb_object_keys(p_marker)) <> 6
    or p_marker -> 'version' is distinct from to_jsonb('deal-hunter-manual-follow-up-v1'::text)
    or p_marker -> 'mode' is distinct from to_jsonb('operator-approved'::text)
    or p_marker -> 'maximumFollowUps' is distinct from '5'::jsonb
    or p_marker -> 'cadencePolicy' is distinct from to_jsonb('accepted-local-date-plus-2-weekend-forward-0900-pt-v1'::text)
    or jsonb_typeof(p_marker -> 'enrolledAt') is distinct from 'string'
    or jsonb_typeof(p_marker -> 'enrolledBy') is distinct from 'string'
    or nullif(p_marker ->> 'enrolledAt', '') is null
    or nullif(btrim(p_marker ->> 'enrolledBy'), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  begin
    v_enrolled_at := (p_marker ->> 'enrolledAt')::timestamptz;
  exception when others then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end;
  v_enrolled_by := left(regexp_replace(btrim(p_marker ->> 'enrolledBy'), '\s+', ' ', 'g'), 300);
  if v_enrolled_at is null or v_enrolled_by = '' then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  v_marker := jsonb_build_object(
    'version', 'deal-hunter-manual-follow-up-v1',
    'mode', 'operator-approved',
    'maximumFollowUps', 5,
    'cadencePolicy', 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1',
    'enrolledAt', to_char(v_enrolled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'enrolledBy', v_enrolled_by
  );
  if v_submission.status = 'archived'
    or v_current.status <> 'sent'
    or v_current.request_state is distinct from 'provider_accepted'
    or coalesce(v_current.delivery_state, '') not in ('accepted', 'delivered')
    or v_current.responded_at is not null
    or v_current.follow_up_count not between 0 and 4
    or v_current.next_follow_up_at is not null
    or coalesce(v_current.follow_up_state, '') not in ('', 'not-scheduled')
    or coalesce(v_current.metadata, '{}'::jsonb) ? 'manualFollowUp'
    or p_next_follow_up_at is null
    or p_activity #>> '{submission_id}' is distinct from p_expected_submission_id::text then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  update public.deal_hunter_cim_requests as request
  set
    updated_at = v_enrolled_at,
    follow_up_state = 'scheduled',
    next_follow_up_at = p_next_follow_up_at,
    metadata = coalesce(request.metadata, '{}'::jsonb) || jsonb_build_object('manualFollowUp', v_marker)
  where request.id = p_request_id
    and request.updated_at = p_expected_request_updated_at
    and request.submission_id = p_expected_submission_id
  returning request.* into v_current;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;

  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;

  return jsonb_build_object('applied', true, 'reason', '', 'request', to_jsonb(v_current), 'activity', v_activity, 'alreadyFinalized', false);
end;
$$;

create or replace function public.stop_deal_hunter_manual_follow_ups(
  p_request_id text,
  p_expected_request_updated_at timestamptz,
  p_expected_submission_id uuid,
  p_expected_submission_updated_at timestamptz,
  p_stopped_at timestamptz,
  p_stopped_by text,
  p_reason text,
  p_activity jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_marker jsonb;
  v_enrolled_at timestamptz;
  v_activity jsonb;
  v_stopped_in_flight boolean;
begin
  select * into v_submission
  from public.contact_submissions as submission
  where submission.id = p_expected_submission_id
  for update;

  select * into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;

  if v_current.id is null then
    return jsonb_build_object('applied', false, 'reason', 'request-missing', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_submission.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object('applied', false, 'reason', 'submission-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_current.updated_at is distinct from p_expected_request_updated_at
    or v_submission.updated_at is distinct from p_expected_submission_updated_at then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  v_marker := coalesce(v_current.metadata -> 'manualFollowUp', '{}'::jsonb);
  v_stopped_in_flight := v_current.status = 'follow_up_pending';
  if jsonb_typeof(v_marker) is distinct from 'object'
    or v_marker -> 'version' is distinct from to_jsonb('deal-hunter-manual-follow-up-v1'::text)
    or v_marker -> 'mode' is distinct from to_jsonb('operator-approved'::text)
    or v_marker -> 'maximumFollowUps' is distinct from '5'::jsonb
    or v_marker -> 'cadencePolicy' is distinct from to_jsonb('accepted-local-date-plus-2-weekend-forward-0900-pt-v1'::text)
    or jsonb_typeof(v_marker -> 'enrolledAt') is distinct from 'string'
    or jsonb_typeof(v_marker -> 'enrolledBy') is distinct from 'string'
    or nullif(btrim(v_marker ->> 'enrolledBy'), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  begin
    v_enrolled_at := (v_marker ->> 'enrolledAt')::timestamptz;
  exception when others then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end;
  if v_enrolled_at is null
    or v_submission.status = 'archived'
    or v_current.responded_at is not null
    or v_current.request_state = 'responded'
    or v_current.status in ('responded', 'delivery_issue')
    or v_current.follow_up_count >= 5
    or v_current.follow_up_state in ('stopped', 'completed')
    or v_marker ? 'stoppedAt'
    or p_stopped_at is null
    or nullif(btrim(p_stopped_by), '') is null
    or p_activity #>> '{submission_id}' is distinct from p_expected_submission_id::text then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  v_marker := v_marker || jsonb_build_object(
    'stoppedAt', p_stopped_at,
    'stoppedBy', left(regexp_replace(btrim(p_stopped_by), '\s+', ' ', 'g'), 300),
    'stopReason', left(regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g'), 240)
  );
  update public.deal_hunter_cim_requests as request
  set
    updated_at = p_stopped_at,
    follow_up_state = 'stopped',
    next_follow_up_at = null,
    metadata = coalesce(request.metadata, '{}'::jsonb) || jsonb_build_object('manualFollowUp', v_marker)
  where request.id = p_request_id
    and request.updated_at = p_expected_request_updated_at
    and request.submission_id = p_expected_submission_id
  returning request.* into v_current;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;

  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;
  return jsonb_build_object('applied', true, 'reason', case when v_stopped_in_flight then 'stopped-in-flight' else '' end, 'request', to_jsonb(v_current), 'activity', v_activity, 'alreadyFinalized', false);
end;
$$;

create or replace function public.claim_deal_hunter_approved_follow_up(
  p_request_id text,
  p_expected_request_updated_at timestamptz,
  p_expected_submission_id uuid,
  p_expected_submission_updated_at timestamptz,
  p_expected_follow_up_count integer,
  p_expected_follow_up_number integer,
  p_expected_next_follow_up_at timestamptz,
  p_claimed_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_marker jsonb;
  v_enrolled_at timestamptz;
begin
  select * into v_submission
  from public.contact_submissions as submission
  where submission.id = p_expected_submission_id
  for update;

  select * into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;

  if v_current.id is null then
    return jsonb_build_object('applied', false, 'reason', 'request-missing', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_submission.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object('applied', false, 'reason', 'submission-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  v_marker := coalesce(v_current.metadata -> 'manualFollowUp', '{}'::jsonb);
  if jsonb_typeof(v_marker) is distinct from 'object'
    or v_marker -> 'version' is distinct from to_jsonb('deal-hunter-manual-follow-up-v1'::text)
    or v_marker -> 'mode' is distinct from to_jsonb('operator-approved'::text)
    or v_marker -> 'maximumFollowUps' is distinct from '5'::jsonb
    or v_marker -> 'cadencePolicy' is distinct from to_jsonb('accepted-local-date-plus-2-weekend-forward-0900-pt-v1'::text)
    or jsonb_typeof(v_marker -> 'enrolledAt') is distinct from 'string'
    or jsonb_typeof(v_marker -> 'enrolledBy') is distinct from 'string'
    or nullif(btrim(v_marker ->> 'enrolledBy'), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'claim-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  begin
    v_enrolled_at := (v_marker ->> 'enrolledAt')::timestamptz;
  exception when others then
    return jsonb_build_object('applied', false, 'reason', 'claim-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end;
  if v_enrolled_at is null
    or v_current.updated_at is distinct from p_expected_request_updated_at
    or v_submission.updated_at is distinct from p_expected_submission_updated_at
    or v_submission.status = 'archived'
    or v_marker ? 'stoppedAt'
    or v_current.responded_at is not null
    or v_current.request_state = 'responded'
    or v_current.status in ('responded', 'delivery_issue')
    or coalesce(v_current.follow_up_state, '') not in ('scheduled', 'failed')
    or v_current.status not in ('sent', 'failed', 'follow_up_failed')
    or v_current.request_state is distinct from 'provider_accepted'
    or v_current.follow_up_count <> p_expected_follow_up_count
    or p_expected_follow_up_number <> v_current.follow_up_count + 1
    or p_expected_follow_up_number not between 1 and 5
    or v_current.next_follow_up_at is distinct from p_expected_next_follow_up_at
    or v_current.next_follow_up_at is null
    or p_claimed_at < v_current.next_follow_up_at then
    return jsonb_build_object('applied', false, 'reason', 'claim-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  update public.deal_hunter_cim_requests as request
  set status = 'follow_up_pending', delivery_error = '', updated_at = p_claimed_at
  where request.id = p_request_id
    and request.updated_at = p_expected_request_updated_at
    and request.submission_id = p_expected_submission_id
  returning request.* into v_current;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  return jsonb_build_object('applied', true, 'reason', '', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
end;
$$;

create or replace function public.finalize_deal_hunter_approved_follow_up(
  p_request_id text,
  p_expected_request_updated_at timestamptz,
  p_expected_submission_id uuid,
  p_expected_follow_up_number integer,
  p_expected_communication_id text,
  p_outcome text,
  p_accepted_at timestamptz,
  p_next_follow_up_at timestamptz,
  p_activity jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_communication public.crm_communications%rowtype;
  v_outbox public.crm_email_outbox%rowtype;
  v_expected_communication_id text;
  v_marker jsonb;
  v_enrolled_at timestamptz;
  v_touches jsonb;
  v_follow_ups jsonb;
  v_activity jsonb;
  v_terminal boolean;
  v_mutation_at timestamptz;
  v_follow_up_state text;
  v_status text;
  v_request_state text;
  v_delivery_state text;
  v_provider_accepted_at timestamptz;
  v_due_date date;
  v_derived_next_follow_up_at timestamptz;
begin
  select * into v_submission
  from public.contact_submissions as submission
  where submission.id = p_expected_submission_id
  for update;

  select * into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;

  if v_current.id is null then
    return jsonb_build_object('applied', false, 'reason', 'request-missing', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_submission.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object('applied', false, 'reason', 'submission-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  v_expected_communication_id := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'crm-communication:' || p_request_id || ':follow-up:' || p_expected_follow_up_number::text,
      'UTF8'
    )),
    'hex'
  );
  if p_expected_communication_id is distinct from v_expected_communication_id then
    return jsonb_build_object('applied', false, 'reason', 'finalize-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  select * into v_communication
  from public.crm_communications as communication
  where communication.id = p_expected_communication_id
  for update;

  select * into v_outbox
  from public.crm_email_outbox as outbox
  where outbox.communication_id = p_expected_communication_id
  for update;

  v_marker := coalesce(v_current.metadata -> 'manualFollowUp', '{}'::jsonb);
  v_touches := case when jsonb_typeof(v_marker -> 'acceptedTouches') = 'array'
    then v_marker -> 'acceptedTouches' else '[]'::jsonb end;
  v_follow_ups := case when jsonb_typeof(v_current.metadata -> 'followUps') = 'array'
    then v_current.metadata -> 'followUps' else '[]'::jsonb end;
  if exists (
    select 1 from jsonb_array_elements(v_touches) as touch(value)
    where touch.value ->> 'followUpNumber' = p_expected_follow_up_number::text
      and touch.value ->> 'communicationId' = p_expected_communication_id
  ) then
    return jsonb_build_object('applied', false, 'reason', 'already-finalized', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', true);
  end if;
  if p_outcome <> 'accepted'
    and v_marker #>> '{currentAttempt,followUpNumber}' = p_expected_follow_up_number::text
    and v_marker #>> '{currentAttempt,communicationId}' = p_expected_communication_id
    and v_marker #>> '{currentAttempt,outcome}' = p_outcome
    and v_current.updated_at is distinct from p_expected_request_updated_at then
    return jsonb_build_object('applied', false, 'reason', 'already-finalized', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', true);
  end if;

  if jsonb_typeof(v_marker) is distinct from 'object'
    or v_marker -> 'version' is distinct from to_jsonb('deal-hunter-manual-follow-up-v1'::text)
    or v_marker -> 'mode' is distinct from to_jsonb('operator-approved'::text)
    or v_marker -> 'maximumFollowUps' is distinct from '5'::jsonb
    or v_marker -> 'cadencePolicy' is distinct from to_jsonb('accepted-local-date-plus-2-weekend-forward-0900-pt-v1'::text)
    or jsonb_typeof(v_marker -> 'enrolledAt') is distinct from 'string'
    or jsonb_typeof(v_marker -> 'enrolledBy') is distinct from 'string'
    or nullif(btrim(v_marker ->> 'enrolledBy'), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'finalize-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  begin
    v_enrolled_at := (v_marker ->> 'enrolledAt')::timestamptz;
  exception when others then
    return jsonb_build_object('applied', false, 'reason', 'finalize-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end;
  if v_enrolled_at is null
    or p_outcome not in ('accepted', 'definitive-failure', 'ambiguous')
    or p_expected_follow_up_number not between 1 and 5
    or v_current.follow_up_count <> p_expected_follow_up_number - 1
    or v_communication.id is null
    or v_communication.cim_request_id is distinct from p_request_id
    or v_communication.submission_id is distinct from p_expected_submission_id
    or coalesce(v_communication.metadata ->> 'followUpNumber', v_communication.metadata ->> 'follow_up_number', '') <> p_expected_follow_up_number::text
    or p_activity #>> '{submission_id}' is distinct from p_expected_submission_id::text then
    return jsonb_build_object('applied', false, 'reason', 'finalize-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  v_terminal := v_submission.status = 'archived'
    or v_current.responded_at is not null
    or v_current.request_state = 'responded'
    or v_current.status in ('responded', 'delivery_issue')
    or v_current.follow_up_state in ('stopped', 'completed')
    or v_marker ? 'stoppedAt';

  if p_outcome = 'accepted' then
    begin
      v_provider_accepted_at := case
        when nullif(v_communication.metadata #>> '{manualFollowUp,firstProviderAcceptedAt}', '') is not null
          then (v_communication.metadata #>> '{manualFollowUp,firstProviderAcceptedAt}')::timestamptz
        when v_communication.delivery_state = 'accepted' then v_communication.delivery_state_at
        else null
      end;
    exception when others then
      v_provider_accepted_at := null;
    end;
    if v_communication.delivery_state not in ('accepted', 'delivered', 'delayed', 'bounced', 'complained', 'suppressed', 'replied')
      or nullif(btrim(v_communication.provider_message_id), '') is null
      or p_accepted_at is null
      or v_provider_accepted_at is distinct from p_accepted_at then
      return jsonb_build_object('applied', false, 'reason', 'accepted-proof-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
    end if;
    if p_expected_follow_up_number < 5 then
      v_due_date := (p_accepted_at at time zone 'America/Los_Angeles')::date + 2;
      if extract(isodow from v_due_date) = 6 then
        v_due_date := v_due_date + 2;
      elsif extract(isodow from v_due_date) = 7 then
        v_due_date := v_due_date + 1;
      end if;
      v_derived_next_follow_up_at := (v_due_date + time '09:00') at time zone 'America/Los_Angeles';
      if p_next_follow_up_at is distinct from v_derived_next_follow_up_at then
        return jsonb_build_object('applied', false, 'reason', 'accepted-proof-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
      end if;
    else
      v_derived_next_follow_up_at := null;
    end if;
  else
    if v_current.updated_at is distinct from p_expected_request_updated_at
      or v_current.status <> 'follow_up_pending'
      or v_terminal then
      return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
    end if;
    if v_marker #>> '{currentAttempt,outcome}' = 'ambiguous' then
      return jsonb_build_object('applied', false, 'reason', 'reconciliation-required', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
    end if;
    if p_outcome = 'definitive-failure' and v_communication.delivery_state not in ('failed', 'bounced', 'complained', 'suppressed') then
      return jsonb_build_object('applied', false, 'reason', 'definitive-proof-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
    end if;
    if p_outcome = 'ambiguous' and (
      v_outbox.id is null
      or v_outbox.state is distinct from 'ambiguous'
      or v_outbox.communication_id is distinct from p_expected_communication_id
      or v_outbox.cim_request_id is distinct from p_request_id
      or v_outbox.submission_id is distinct from p_expected_submission_id
      or v_outbox.ambiguous_at is null
    ) then
      return jsonb_build_object('applied', false, 'reason', 'ambiguous-proof-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
    end if;
  end if;

  v_mutation_at := greatest(
    v_current.updated_at,
    coalesce(nullif(p_activity ->> 'created_at', '')::timestamptz, '-infinity'::timestamptz),
    coalesce(p_accepted_at, '-infinity'::timestamptz)
  );
  v_marker := v_marker || jsonb_build_object(
    'currentAttempt', jsonb_build_object(
      'followUpNumber', p_expected_follow_up_number,
      'communicationId', p_expected_communication_id,
      'outcome', p_outcome,
      'originalDueAt', coalesce(v_marker #> '{currentAttempt,originalDueAt}', to_jsonb(v_current.next_follow_up_at)),
      'updatedAt', v_mutation_at
    )
  );

  if p_outcome = 'accepted' then
    v_follow_ups := v_follow_ups || jsonb_build_array(jsonb_build_object(
      'number', p_expected_follow_up_number,
      'attemptedAt', p_accepted_at,
      'acceptedAt', p_accepted_at,
      'status', 'accepted',
      'communicationId', p_expected_communication_id,
      'providerMessageId', coalesce(v_communication.provider_message_id, ''),
      'error', ''
    ));
    v_marker := v_marker || jsonb_build_object(
      'acceptedTouches', v_touches || jsonb_build_array(jsonb_build_object(
        'followUpNumber', p_expected_follow_up_number,
        'communicationId', p_expected_communication_id,
        'acceptedAt', p_accepted_at
      ))
    );
    if p_expected_follow_up_number = 5 then
      v_marker := v_marker || jsonb_build_object('completedAt', p_accepted_at);
    end if;
    v_follow_up_state := case
      when v_terminal and v_current.follow_up_state = 'completed' then 'completed'
      when v_terminal then 'stopped'
      when p_expected_follow_up_number = 5 then 'completed'
      else 'scheduled'
    end;
    v_status := case when v_current.status in ('responded', 'delivery_issue') then v_current.status else 'sent' end;
    v_request_state := case when v_current.request_state = 'responded' then 'responded' else 'provider_accepted' end;
    v_delivery_state := case when v_current.delivery_state in ('bounced', 'complained', 'suppressed') then v_current.delivery_state else 'accepted' end;
    update public.deal_hunter_cim_requests as request
    set
      updated_at = v_mutation_at,
      status = v_status,
      request_state = v_request_state,
      delivery_state = v_delivery_state,
      follow_up_count = request.follow_up_count + 1,
      last_follow_up_at = p_accepted_at,
      next_follow_up_at = case
        when v_terminal then null
        when p_expected_follow_up_number = 5 then null
        else v_derived_next_follow_up_at
      end,
      follow_up_state = v_follow_up_state,
      last_activity_at = v_mutation_at,
      metadata = coalesce(request.metadata, '{}'::jsonb) || jsonb_build_object(
        'followUps', v_follow_ups,
        'manualFollowUp', v_marker
      )
    where request.id = p_request_id and request.submission_id = p_expected_submission_id
    returning request.* into v_current;
  else
    update public.deal_hunter_cim_requests as request
    set
      updated_at = v_mutation_at,
      status = 'follow_up_failed',
      follow_up_state = case when p_outcome = 'ambiguous' then 'ambiguous' else 'failed' end,
      next_follow_up_at = case when p_outcome = 'ambiguous' then null else request.next_follow_up_at end,
      last_activity_at = v_mutation_at,
      metadata = coalesce(request.metadata, '{}'::jsonb) || jsonb_build_object('manualFollowUp', v_marker)
    where request.id = p_request_id
      and request.updated_at = p_expected_request_updated_at
      and request.submission_id = p_expected_submission_id
    returning request.* into v_current;
  end if;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;
  return jsonb_build_object('applied', true, 'reason', '', 'request', to_jsonb(v_current), 'activity', v_activity, 'alreadyFinalized', false);
end;
$$;

create or replace function public.claim_deal_hunter_cim_follow_up_request(
  p_request_id text,
  p_due_before timestamptz,
  p_stale_before timestamptz,
  p_claimed_at timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_probe public.deal_hunter_cim_requests%rowtype;
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
begin
  select * into v_probe
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id;

  if v_probe.id is null then
    return jsonb_build_object('claimed', false, 'reason', 'request-missing', 'request', null);
  end if;
  if v_probe.metadata #>> '{manualFollowUp,mode}' = 'operator-approved' then
    return jsonb_build_object('claimed', false, 'reason', 'approval-required', 'request', to_jsonb(v_probe));
  end if;
  if v_probe.submission_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'submission-missing', 'request', to_jsonb(v_probe));
  end if;

  select * into v_submission
  from public.contact_submissions as submission
  where submission.id = v_probe.submission_id
  for update;
  if v_submission.id is null then
    return jsonb_build_object('claimed', false, 'reason', 'submission-missing', 'request', to_jsonb(v_probe));
  end if;
  if v_submission.status = 'archived' then
    return jsonb_build_object('claimed', false, 'reason', 'submission-archived', 'request', to_jsonb(v_probe));
  end if;

  select * into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;
  if v_current.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object('claimed', false, 'reason', 'claim-ineligible', 'request', case when v_current.id is null then null else to_jsonb(v_current) end);
  end if;
  if v_current.metadata #>> '{manualFollowUp,mode}' = 'operator-approved' then
    return jsonb_build_object('claimed', false, 'reason', 'approval-required', 'request', to_jsonb(v_current));
  end if;

  update public.deal_hunter_cim_requests as request
  set status = 'follow_up_pending', delivery_error = '', updated_at = p_claimed_at
  where request.id = p_request_id
    and request.next_follow_up_at is not null
    and request.next_follow_up_at <= p_due_before
    and (
      request.status in ('sent', 'logged', 'failed', 'follow_up_failed')
      or (request.status = 'follow_up_pending' and p_stale_before is not null and request.updated_at <= p_stale_before)
    )
  returning request.* into v_current;
  if found then
    return jsonb_build_object('claimed', true, 'reason', '', 'request', to_jsonb(v_current));
  end if;
  select * into v_current from public.deal_hunter_cim_requests as request where request.id = p_request_id;
  return jsonb_build_object('claimed', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current));
end;
$$;

revoke all on function public.start_deal_hunter_manual_follow_ups(text, timestamptz, uuid, timestamptz, jsonb, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.start_deal_hunter_manual_follow_ups(text, timestamptz, uuid, timestamptz, jsonb, timestamptz, jsonb)
  to service_role;
revoke all on function public.stop_deal_hunter_manual_follow_ups(text, timestamptz, uuid, timestamptz, timestamptz, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.stop_deal_hunter_manual_follow_ups(text, timestamptz, uuid, timestamptz, timestamptz, text, text, jsonb)
  to service_role;
revoke all on function public.claim_deal_hunter_approved_follow_up(text, timestamptz, uuid, timestamptz, integer, integer, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_deal_hunter_approved_follow_up(text, timestamptz, uuid, timestamptz, integer, integer, timestamptz, timestamptz)
  to service_role;
revoke all on function public.finalize_deal_hunter_approved_follow_up(text, timestamptz, uuid, integer, text, text, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_deal_hunter_approved_follow_up(text, timestamptz, uuid, integer, text, text, timestamptz, timestamptz, jsonb)
  to service_role;
revoke all on function public.claim_deal_hunter_cim_follow_up_request(text, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_deal_hunter_cim_follow_up_request(text, timestamptz, timestamptz, timestamptz)
  to service_role;

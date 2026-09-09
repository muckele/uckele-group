create or replace function public.claim_scheduled_job(
  p_job_key text,
  p_job_name text,
  p_triggered_by text,
  p_claim_token text,
  p_now timestamptz,
  p_stale_before timestamptz,
  p_retry_due_at timestamptz,
  p_legacy_mode boolean,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.scheduled_job_runs%rowtype;
  v_metadata jsonb;
  v_immutable_field text;
  v_next_retry_at timestamptz;
  v_next_retry_text text;
  v_reason text;
begin
  if p_job_key is null or btrim(p_job_key) = '' or length(p_job_key) > 240
    or p_job_name is null or btrim(p_job_name) = '' or length(p_job_name) > 120
    or p_claim_token is null or p_claim_token !~ '^[A-Za-z0-9_-]{16,200}$'
    or p_now is null
    or p_legacy_mode is null
    or (p_legacy_mode and p_retry_due_at is not null)
    or p_metadata is null or jsonb_typeof(p_metadata) is distinct from 'object'
    or octet_length(p_metadata::text) > 524288
    or length(coalesce(p_triggered_by, '')) > 200
  then
    return jsonb_build_object('applied', false, 'reason', 'missing', 'run', null);
  end if;

  v_metadata := p_metadata || jsonb_build_object(
    'claimToken', p_claim_token,
    'claimedAt', p_now
  );
  if octet_length(v_metadata::text) > 524288 then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', null);
  end if;

  insert into public.scheduled_job_runs (
    job_key,
    job_name,
    created_at,
    updated_at,
    started_at,
    completed_at,
    status,
    triggered_by,
    attempt_count,
    provider_message_id,
    last_error,
    metadata
  ) values (
    p_job_key,
    p_job_name,
    p_now,
    p_now,
    p_now,
    null,
    'pending',
    nullif(p_triggered_by, ''),
    1,
    null,
    null,
    v_metadata
  )
  on conflict (job_key) do nothing
  returning * into v_current;

  if found then
    return jsonb_build_object('applied', true, 'reason', 'claimed', 'run', to_jsonb(v_current));
  end if;

  select *
  into v_current
  from public.scheduled_job_runs
  where job_key = p_job_key
  for update;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'missing', 'run', null);
  end if;
  if v_current.job_name is distinct from p_job_name then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;
  if v_current.status = 'completed' then
    return jsonb_build_object('applied', false, 'reason', 'completed', 'run', to_jsonb(v_current));
  end if;
  if v_current.status in ('transmitting', 'ambiguous') then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  if v_current.status = 'pending' then
    if p_stale_before is null or v_current.updated_at > p_stale_before then
      return jsonb_build_object('applied', false, 'reason', 'active', 'run', to_jsonb(v_current));
    end if;
  elsif v_current.status = 'failed' then
    v_next_retry_text := v_current.metadata ->> 'nextRetryAt';
    if v_next_retry_text is null or v_next_retry_text = '' then
      if not p_legacy_mode then
        return jsonb_build_object('applied', false, 'reason', 'retry-not-due', 'run', to_jsonb(v_current));
      end if;
    else
      begin
        v_next_retry_at := v_next_retry_text::timestamptz;
      exception when others then
        return jsonb_build_object('applied', false, 'reason', 'retry-not-due', 'run', to_jsonb(v_current));
      end;
      if p_retry_due_at is null or v_next_retry_at > p_retry_due_at then
        return jsonb_build_object('applied', false, 'reason', 'retry-not-due', 'run', to_jsonb(v_current));
      end if;
    end if;
  else
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;
  if coalesce(v_current.metadata ->> 'claimToken', '') = p_claim_token then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  v_metadata := coalesce(v_current.metadata, '{}'::jsonb) || p_metadata;
  foreach v_immutable_field in array array[
    'preparedEnvelope',
    'payloadDigest',
    'firstPreparedAt',
    'preparedAt',
    'businessDate',
    'pacificDate',
    'dateKey',
    'timezone',
    'notificationType'
  ] loop
    if coalesce(v_current.metadata, '{}'::jsonb) ? v_immutable_field then
      v_metadata := jsonb_set(
        v_metadata,
        array[v_immutable_field],
        v_current.metadata -> v_immutable_field,
        true
      );
    end if;
  end loop;
  v_metadata := v_metadata || jsonb_build_object(
    'claimToken', p_claim_token,
    'claimedAt', p_now
  );
  if octet_length(v_metadata::text) > 524288 then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  update public.scheduled_job_runs
  set updated_at = p_now,
      started_at = p_now,
      completed_at = null,
      status = 'pending',
      triggered_by = nullif(p_triggered_by, ''),
      attempt_count = attempt_count + 1,
      provider_message_id = null,
      last_error = null,
      metadata = v_metadata
  where job_key = p_job_key
    and job_name = p_job_name
    and status = v_current.status
    and updated_at = v_current.updated_at
  returning * into v_current;

  if not found then
    select * into v_current from public.scheduled_job_runs where job_key = p_job_key;
    if v_current.status = 'completed' then
      v_reason := 'completed';
    elsif v_current.status = 'pending' then
      v_reason := 'active';
    elsif v_current.status = 'failed' then
      v_reason := 'retry-not-due';
    else
      v_reason := 'wrong-state';
    end if;
    return jsonb_build_object('applied', false, 'reason', v_reason, 'run', to_jsonb(v_current));
  end if;

  return jsonb_build_object('applied', true, 'reason', 'claimed', 'run', to_jsonb(v_current));
end;
$$;

create or replace function public.transition_scheduled_job(
  p_job_key text,
  p_claim_token text,
  p_expected_statuses text[],
  p_status text,
  p_now timestamptz,
  p_provider_message_id text,
  p_last_error text,
  p_metadata_patch jsonb,
  p_completed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.scheduled_job_runs%rowtype;
  v_metadata jsonb;
  v_immutable_field text;
  v_allowed boolean := false;
begin
  if p_job_key is null or btrim(p_job_key) = '' or length(p_job_key) > 240
    or p_claim_token is null or p_claim_token !~ '^[A-Za-z0-9_-]{16,200}$'
    or p_expected_statuses is null or cardinality(p_expected_statuses) = 0
    or p_status is null
    or p_status not in ('pending', 'transmitting', 'failed', 'ambiguous', 'completed')
    or exists (
      select 1 from unnest(p_expected_statuses) as expected(status)
      where expected.status is null
        or expected.status not in ('pending', 'transmitting', 'failed', 'ambiguous', 'completed')
    )
    or p_now is null
    or p_metadata_patch is null or jsonb_typeof(p_metadata_patch) is distinct from 'object'
    or octet_length(p_metadata_patch::text) > 524288
    or length(coalesce(p_provider_message_id, '')) > 500
    or length(coalesce(p_last_error, '')) > 1000
  then
    return jsonb_build_object('applied', false, 'reason', 'missing', 'run', null);
  end if;

  select *
  into v_current
  from public.scheduled_job_runs
  where job_key = p_job_key
  for update;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'missing', 'run', null);
  end if;
  if v_current.status = 'completed' then
    return jsonb_build_object('applied', false, 'reason', 'completed', 'run', to_jsonb(v_current));
  end if;
  if coalesce(v_current.metadata ->> 'claimToken', '') is distinct from p_claim_token then
    return jsonb_build_object('applied', false, 'reason', 'not-owner', 'run', to_jsonb(v_current));
  end if;
  if not (v_current.status = any(p_expected_statuses)) then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  v_allowed := case v_current.status
    when 'pending' then p_status in ('pending', 'transmitting', 'failed', 'ambiguous', 'completed')
    when 'transmitting' then p_status in ('failed', 'ambiguous', 'completed')
    when 'ambiguous' then p_status = 'completed'
    else false
  end;
  if not v_allowed then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  v_metadata := coalesce(v_current.metadata, '{}'::jsonb) || p_metadata_patch;
  foreach v_immutable_field in array array[
    'preparedEnvelope',
    'payloadDigest',
    'firstPreparedAt',
    'preparedAt',
    'businessDate',
    'pacificDate',
    'dateKey',
    'timezone',
    'notificationType'
  ] loop
    if coalesce(v_current.metadata, '{}'::jsonb) ? v_immutable_field then
      v_metadata := jsonb_set(
        v_metadata,
        array[v_immutable_field],
        v_current.metadata -> v_immutable_field,
        true
      );
    end if;
  end loop;
  v_metadata := v_metadata || jsonb_build_object(
    'claimToken', v_current.metadata -> 'claimToken',
    'claimedAt', v_current.metadata -> 'claimedAt'
  );
  if p_status = 'failed' then
    v_metadata := jsonb_set(v_metadata, '{failedAt}', to_jsonb(p_now), true);
    v_metadata := jsonb_set(v_metadata, '{nextRetryAt}', to_jsonb(p_now + interval '30 minutes'), true);
  end if;
  if octet_length(v_metadata::text) > 524288 then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  update public.scheduled_job_runs
  set updated_at = p_now,
      completed_at = case
        when p_status = 'completed' then coalesce(p_completed_at, p_now)
        else completed_at
      end,
      status = p_status,
      provider_message_id = coalesce(nullif(p_provider_message_id, ''), provider_message_id),
      last_error = nullif(p_last_error, ''),
      metadata = v_metadata
  where job_key = p_job_key
    and status = any(p_expected_statuses)
    and metadata ->> 'claimToken' = p_claim_token
  returning * into v_current;

  if not found then
    select * into v_current from public.scheduled_job_runs where job_key = p_job_key;
    if v_current is null then
      return jsonb_build_object('applied', false, 'reason', 'missing', 'run', null);
    elsif v_current.status = 'completed' then
      return jsonb_build_object('applied', false, 'reason', 'completed', 'run', to_jsonb(v_current));
    elsif coalesce(v_current.metadata ->> 'claimToken', '') is distinct from p_claim_token then
      return jsonb_build_object('applied', false, 'reason', 'not-owner', 'run', to_jsonb(v_current));
    end if;
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  return jsonb_build_object('applied', true, 'reason', 'claimed', 'run', to_jsonb(v_current));
end;
$$;

revoke all on function public.claim_scheduled_job(text, text, text, text, timestamptz, timestamptz, timestamptz, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_scheduled_job(text, text, text, text, timestamptz, timestamptz, timestamptz, boolean, jsonb)
  to service_role;

revoke all on function public.transition_scheduled_job(text, text, text[], text, timestamptz, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.transition_scheduled_job(text, text, text[], text, timestamptz, text, text, jsonb, timestamptz)
  to service_role;

create or replace function public.renew_secure_document_cleanup_job_lease(
  p_id uuid,
  p_lease_token text,
  p_lease_duration_ms bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job jsonb;
  v_renewed_at timestamptz := clock_timestamp();
begin
  if p_lease_duration_ms is null or p_lease_duration_ms <= 0 or p_lease_duration_ms > 86400000 then
    raise exception 'Cleanup-job lease duration must be between 1 millisecond and 24 hours.';
  end if;
  if p_lease_token is null or p_lease_token !~ '^[A-Za-z0-9_-]{16,200}$' then
    raise exception 'Cleanup-job lease token is invalid.';
  end if;

  update public.secure_document_cleanup_jobs as cleanup_job
  set
    updated_at = v_renewed_at,
    lease_expires_at = v_renewed_at + (p_lease_duration_ms * interval '1 millisecond')
  where cleanup_job.id = p_id
    and cleanup_job.lease_token = p_lease_token
    and cleanup_job.lease_expires_at > v_renewed_at
  returning to_jsonb(cleanup_job) into v_job;

  return v_job;
end;
$$;

revoke all on function public.renew_secure_document_cleanup_job_lease(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.renew_secure_document_cleanup_job_lease(uuid, text, bigint)
  to service_role;

create or replace function public.update_secure_document_cleanup_job_if_leased(
  p_id uuid,
  p_lease_token text,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job jsonb;
  v_unsupported_field text;
  v_checked_at timestamptz := clock_timestamp();
begin
  if p_lease_token is null or p_lease_token !~ '^[A-Za-z0-9_-]{16,200}$' then
    raise exception 'Cleanup-job lease token is invalid.';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' or p_values = '{}'::jsonb then
    raise exception 'Cleanup-job lease update values must be a non-empty object.';
  end if;

  select field
  into v_unsupported_field
  from jsonb_object_keys(p_values) as field
  where field not in (
    'updated_at', 'completed_at', 'status', 'trash_directory', 'files',
    'attempt_count', 'last_error', 'metadata', 'lease_claimed_at',
    'lease_expires_at', 'lease_token'
  )
  limit 1;
  if v_unsupported_field is not null then
    raise exception 'Unsupported cleanup-job lease update field: %', v_unsupported_field;
  end if;
  if p_values ? 'lease_token' and p_values -> 'lease_token' <> 'null'::jsonb then
    raise exception 'A cleanup-job lease update may only clear its lease token.';
  end if;

  if p_values ? 'lease_token' then
    p_values := p_values || jsonb_build_object(
      'lease_claimed_at', null,
      'lease_expires_at', null,
      'lease_token', null
    );
  end if;

  update public.secure_document_cleanup_jobs as cleanup_job
  set
    updated_at = case when p_values ? 'updated_at' then (p_values ->> 'updated_at')::timestamptz else updated_at end,
    completed_at = case when p_values ? 'completed_at' then (p_values ->> 'completed_at')::timestamptz else completed_at end,
    status = case when p_values ? 'status' then p_values ->> 'status' else status end,
    trash_directory = case when p_values ? 'trash_directory' then p_values ->> 'trash_directory' else trash_directory end,
    files = case when p_values ? 'files' then p_values -> 'files' else files end,
    attempt_count = case when p_values ? 'attempt_count' then (p_values ->> 'attempt_count')::integer else attempt_count end,
    last_error = case when p_values ? 'last_error' then p_values ->> 'last_error' else last_error end,
    metadata = case when p_values ? 'metadata' then p_values -> 'metadata' else metadata end,
    lease_claimed_at = case when p_values ? 'lease_claimed_at' then (p_values ->> 'lease_claimed_at')::timestamptz else lease_claimed_at end,
    lease_expires_at = case when p_values ? 'lease_expires_at' then (p_values ->> 'lease_expires_at')::timestamptz else lease_expires_at end,
    lease_token = case when p_values ? 'lease_token' then p_values ->> 'lease_token' else lease_token end
  where cleanup_job.id = p_id
    and cleanup_job.lease_token = p_lease_token
    and cleanup_job.lease_expires_at > v_checked_at
  returning to_jsonb(cleanup_job) into v_job;

  return v_job;
end;
$$;

revoke all on function public.update_secure_document_cleanup_job_if_leased(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_secure_document_cleanup_job_if_leased(uuid, text, jsonb)
  to service_role;

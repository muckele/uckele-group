alter table public.secure_document_cleanup_jobs
  add column if not exists lease_claimed_at timestamptz,
  add column if not exists lease_expires_at timestamptz;

create index if not exists idx_secure_document_cleanup_jobs_lease
  on public.secure_document_cleanup_jobs (status, lease_expires_at);

create or replace function public.claim_secure_document_cleanup_job(
  p_id uuid,
  p_claimed_at timestamptz,
  p_lease_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job jsonb;
begin
  if p_claimed_at is null or p_lease_expires_at is null or p_lease_expires_at <= p_claimed_at then
    raise exception 'Cleanup-job lease expiry must be later than its claim time.';
  end if;

  update public.secure_document_cleanup_jobs as cleanup_job
  set
    updated_at = p_claimed_at,
    lease_claimed_at = p_claimed_at,
    lease_expires_at = p_lease_expires_at
  where cleanup_job.id = p_id
    and cleanup_job.status in (
      'staging',
      'pending-purge',
      'cleanup-pending',
      'reconciliation-pending',
      'cleanup-failed',
      'restore-failed'
    )
    and (
      cleanup_job.lease_expires_at is null
      or cleanup_job.lease_expires_at <= p_claimed_at
    )
  returning to_jsonb(cleanup_job) into v_job;

  return v_job;
end;
$$;

revoke all on function public.claim_secure_document_cleanup_job(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_secure_document_cleanup_job(uuid, timestamptz, timestamptz)
  to service_role;

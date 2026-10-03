-- UNAPPLIED P8-03 PROPOSAL. REVIEW FIXTURE ONLY.
-- Do not run this file against production. Owner approval, backup/rollback evidence,
-- exact deployed-schema review, and a production migration are separate later gates.

begin;

alter table public.secure_attachment_ingestions
  add column if not exists scan_request_id uuid,
  add column if not exists scan_job_owner text,
  add column if not exists scan_requested_at timestamptz,
  add column if not exists scan_lease_expires_at timestamptz,
  add column if not exists scan_completed_at timestamptz,
  add column if not exists scan_request_digest text,
  add column if not exists scan_signature_version text,
  add column if not exists scan_signature_updated_at timestamptz,
  add column if not exists scan_verdict_expires_at timestamptz;

alter table public.secure_attachment_ingestions
  drop constraint if exists secure_attachment_ingestions_lifecycle_status_check;
alter table public.secure_attachment_ingestions
  add constraint secure_attachment_ingestions_lifecycle_status_check check (lifecycle_status in (
    'quarantining', 'scan-pending', 'scanning', 'scan-unavailable', 'unsafe',
    'awaiting-owner-approval', 'publishing', 'published'
  ));

create unique index if not exists idx_secure_attachment_ingestions_single_scanning
  on public.secure_attachment_ingestions ((1)) where lifecycle_status = 'scanning';

create or replace function public.expire_cim_attachment_scan_lease_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_row public.secure_attachment_ingestions%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_attempt integer := (p_command ->> 'attempt')::integer;
begin
  update public.secure_attachment_ingestions set
    lifecycle_status = 'scan-unavailable',
    scan_status = 'unavailable',
    scan_last_error = 'scan_lease_expired',
    hold_reason = case when v_attempt >= 3 then 'retry_exhausted' else 'scan_lease_expired' end,
    next_scan_at = case when v_attempt >= 3 then null
      when v_attempt = 1 then v_now + interval '15 minutes'
      else v_now + interval '2 hours' end,
    scan_completed_at = v_now,
    updated_at = v_now
  where id = (p_command ->> 'intakeId')::uuid
    and lifecycle_status = 'scanning'
    and scan_request_id = (p_command ->> 'requestId')::uuid
    and scan_job_owner = p_command ->> 'jobOwner'
    and scan_attempt_count = v_attempt
    and scan_lease_expires_at <= v_now
  returning * into v_row;
  if not found then return null; end if;
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.claim_cim_attachment_scan_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_row public.secure_attachment_ingestions%rowtype;
  v_active public.secure_attachment_ingestions%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_lease timestamptz := (p_command ->> 'leaseExpiresAt')::timestamptz;
  v_request_id uuid := (p_command ->> 'requestId')::uuid;
  v_job_owner text := p_command ->> 'jobOwner';
begin
  if v_request_id is null or v_job_owner is null
    or pg_catalog.length(v_job_owner) not between 1 and 120
    or v_job_owner ~ '[[:cntrl:]]'
  then
    raise exception 'Scan ownership identity is invalid.';
  end if;
  if v_lease is null or v_lease <= v_now or v_lease > v_now + interval '4 minutes' then
    raise exception 'Scan lease is outside the bounded window.';
  end if;

  select * into v_active from public.secure_attachment_ingestions
    where lifecycle_status = 'scanning' for update;
  if found then
    if v_active.scan_lease_expires_at > v_now then return null; end if;
    update public.secure_attachment_ingestions set
      lifecycle_status = 'scan-unavailable', scan_status = 'unavailable',
      scan_last_error = 'scan_lease_expired',
      hold_reason = case when v_active.scan_attempt_count >= 3 then 'retry_exhausted' else 'scan_lease_expired' end,
      next_scan_at = case when v_active.scan_attempt_count >= 3 then null
        when v_active.scan_attempt_count = 1 then v_now + interval '15 minutes'
        else v_now + interval '2 hours' end,
      scan_completed_at = v_now, updated_at = v_now
    where id = v_active.id and lifecycle_status = 'scanning'
      and scan_request_id = v_active.scan_request_id
      and scan_attempt_count = v_active.scan_attempt_count;
  end if;

  select * into v_row from public.secure_attachment_ingestions
    where id = (p_command ->> 'intakeId')::uuid for update;
  if not found then return null; end if;
  if v_row.lifecycle_status = 'awaiting-owner-approval'
    and v_row.scan_status = 'clean'
    and (v_row.scan_verdict_expires_at is null or v_row.scan_verdict_expires_at <= v_now)
  then
    update public.secure_attachment_ingestions set
      lifecycle_status = 'scan-unavailable', scan_status = 'unavailable',
      scan_last_error = 'scan_verdict_expired',
      hold_reason = case when scan_attempt_count >= 3 then 'retry_exhausted' else 'scan_verdict_expired' end,
      next_scan_at = case when scan_attempt_count >= 3 then null else v_now end,
      updated_at = v_now where id = v_row.id returning * into v_row;
  end if;
  if v_row.lifecycle_status not in ('scan-pending', 'scan-unavailable')
    or v_row.scan_attempt_count >= 3 or (v_row.next_scan_at is not null and v_row.next_scan_at > v_now)
  then return null; end if;

  update public.secure_attachment_ingestions set
    lifecycle_status = 'scanning', scan_status = 'pending',
    scan_attempt_count = v_row.scan_attempt_count + 1,
    scan_request_id = v_request_id,
    scan_job_owner = v_job_owner, scan_requested_at = v_now,
    scan_lease_expires_at = v_lease, scan_completed_at = null,
    scan_request_digest = null, scan_last_error = null, next_scan_at = null,
    hold_reason = null, updated_at = v_now
  where id = v_row.id and lifecycle_status = v_row.lifecycle_status
    and scan_attempt_count = v_row.scan_attempt_count
  returning * into v_row;
  if not found then return null; end if;
  return pg_catalog.to_jsonb(v_row);
exception when unique_violation then
  return null;
end;
$$;

create or replace function public.complete_cim_attachment_scan_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_row public.secure_attachment_ingestions%rowtype;
  v_result jsonb := p_command -> 'result';
  v_completed timestamptz := pg_catalog.clock_timestamp();
  v_attempt integer := (p_command ->> 'attempt')::integer;
  v_outcome text := v_result ->> 'outcome';
  v_engine_version text := v_result ->> 'engineVersion';
  v_signature_version text := v_result ->> 'signatureVersion';
  v_signature_updated_at timestamptz;
  v_request_digest text := v_result ->> 'requestDigest';
  v_reason_code text := v_result ->> 'reasonCode';
begin
  if v_outcome not in ('clean', 'unsafe', 'unavailable', 'ambiguous') then
    raise exception 'Invalid scan outcome.';
  end if;
  if v_reason_code is null or v_reason_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'Invalid scan reason code.';
  end if;
  if v_outcome in ('clean', 'unsafe') then
    if v_engine_version is null or pg_catalog.length(v_engine_version) not between 1 and 120
      or v_engine_version ~ '[[:cntrl:]]'
      or v_signature_version is null or pg_catalog.length(v_signature_version) not between 1 and 120
      or v_signature_version ~ '[[:cntrl:]]'
      or v_request_digest is null or v_request_digest !~ '^[0-9a-f]{64}$'
      or nullif(v_result ->> 'signatureUpdatedAt', '') is null
    then
      raise exception 'Scan result evidence is incomplete.';
    end if;
    v_signature_updated_at := (v_result ->> 'signatureUpdatedAt')::timestamptz;
    if v_signature_updated_at > v_completed
      or v_signature_updated_at < v_completed - interval '24 hours'
    then
      raise exception 'Scan signature evidence is outside the freshness window.';
    end if;
  end if;
  update public.secure_attachment_ingestions set
    lifecycle_status = case when v_outcome = 'clean' then 'awaiting-owner-approval'
      when v_outcome = 'unsafe' then 'unsafe' else 'scan-unavailable' end,
    scan_status = case when v_outcome = 'clean' then 'clean'
      when v_outcome = 'unsafe' then 'unsafe' else 'unavailable' end,
    scanner_name = nullif(v_result ->> 'engineVersion', ''),
    scanner_version = nullif(v_result ->> 'engineVersion', ''),
    scan_signature_version = nullif(v_result ->> 'signatureVersion', ''),
    scan_signature_updated_at = nullif(v_result ->> 'signatureUpdatedAt', '')::timestamptz,
    scan_completed_at = v_completed,
    scan_verdict_expires_at = case when v_outcome = 'clean'
      then v_completed + interval '24 hours' else null end,
    scan_request_digest = nullif(v_result ->> 'requestDigest', ''),
    scan_last_error = case when v_outcome in ('clean', 'unsafe') then null else v_result ->> 'reasonCode' end,
    hold_reason = case when v_outcome = 'clean' then null when v_outcome = 'unsafe' then 'unsafe'
      when v_attempt >= 3 then 'retry_exhausted' when v_outcome = 'ambiguous' then 'scan_ambiguous'
      else v_result ->> 'reasonCode' end,
    next_scan_at = case when v_outcome in ('clean', 'unsafe') or v_attempt >= 3 then null
      when v_attempt = 1 then v_completed + interval '15 minutes' else v_completed + interval '2 hours' end,
    updated_at = v_completed
  where id = (p_command ->> 'intakeId')::uuid and lifecycle_status = 'scanning'
    and scan_request_id = (p_command ->> 'requestId')::uuid
    and scan_job_owner = p_command ->> 'jobOwner' and scan_attempt_count = v_attempt
    and scan_lease_expires_at > v_completed
  returning * into v_row;
  if not found then return null; end if;
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.claim_cim_attachment_publication_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_row public.secure_attachment_ingestions%rowtype;
  v_approved_at timestamptz := pg_catalog.clock_timestamp();
begin
  update public.secure_attachment_ingestions set
    lifecycle_status = 'publishing', owner_approved_at = v_approved_at,
    owner_approved_by = p_command ->> 'ownerApprovedBy',
    approved_submission_id = (p_command ->> 'approvedSubmissionId')::uuid,
    approved_document_type = p_command ->> 'approvedDocumentType',
    vault_request_id = (p_command ->> 'vaultRequestId')::uuid,
    vault_document_id = (p_command ->> 'vaultDocumentId')::uuid,
    vault_relative_path = p_command ->> 'vaultRelativePath',
    hold_reason = null, updated_at = v_approved_at
  where id = (p_command ->> 'intakeId')::uuid
    and lifecycle_status = 'awaiting-owner-approval' and scan_status = 'clean'
    and scan_verdict_expires_at is not null and scan_verdict_expires_at > v_approved_at
  returning * into v_row;
  if not found then return null; end if;
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.guard_cim_attachment_scan_verdict_publication_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
begin
  if new.lifecycle_status = 'published' and old.lifecycle_status is distinct from 'published'
    and (new.scan_status <> 'clean' or new.owner_approved_at is null
      or new.scan_verdict_expires_at is null
      or new.owner_approved_at >= new.scan_verdict_expires_at)
  then
    raise exception 'Attachment publication does not have a fresh frozen scan verdict.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_cim_attachment_scan_verdict_publication_v1
  on public.secure_attachment_ingestions;
create trigger guard_cim_attachment_scan_verdict_publication_v1
before update of lifecycle_status on public.secure_attachment_ingestions
for each row execute function public.guard_cim_attachment_scan_verdict_publication_v1();

revoke all on function public.claim_cim_attachment_scan_v1(jsonb) from public, anon, authenticated;
revoke all on function public.complete_cim_attachment_scan_v1(jsonb) from public, anon, authenticated;
revoke all on function public.expire_cim_attachment_scan_lease_v1(jsonb) from public, anon, authenticated;
revoke all on function public.claim_cim_attachment_publication_v1(jsonb) from public, anon, authenticated;
grant execute on function public.claim_cim_attachment_scan_v1(jsonb) to service_role;
grant execute on function public.complete_cim_attachment_scan_v1(jsonb) to service_role;
grant execute on function public.expire_cim_attachment_scan_lease_v1(jsonb) to service_role;
grant execute on function public.claim_cim_attachment_publication_v1(jsonb) to service_role;

-- Deliberately rolled back: this checked-in file is an offline contract fixture.
rollback;

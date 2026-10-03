-- P8-02: provider-free secure CIM attachment lifecycle and atomic vault publication.
create table if not exists public.secure_attachment_ingestions (
  id uuid primary key,
  communication_id text not null,
  provider text not null,
  provider_message_id text not null,
  provider_attachment_id text not null,
  original_file_name text not null,
  declared_mime_type text not null,
  detected_mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  quarantine_path text not null,
  duplicate_of_id uuid references public.secure_attachment_ingestions(id) on delete restrict,
  lifecycle_status text not null check (lifecycle_status in (
    'quarantining', 'scan-pending', 'scan-unavailable', 'unsafe',
    'awaiting-owner-approval', 'publishing', 'published'
  )),
  scan_status text not null check (scan_status in ('pending', 'clean', 'unsafe', 'unavailable')),
  scan_attempt_count integer not null default 0 check (scan_attempt_count between 0 and 3),
  scanner_name text,
  scanner_version text,
  scan_last_error text,
  next_scan_at timestamptz,
  hold_reason text,
  owner_approved_at timestamptz,
  owner_approved_by text,
  approved_submission_id uuid references public.contact_submissions(id) on delete restrict,
  approved_document_type text,
  vault_request_id uuid,
  vault_document_id uuid,
  vault_relative_path text,
  published_at timestamptz,
  retention_status text not null default 'hold' check (retention_status = 'hold'),
  retention_review_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider, provider_message_id, provider_attachment_id)
);

create index if not exists idx_secure_attachment_ingestions_sha256
  on public.secure_attachment_ingestions (sha256, created_at);
create index if not exists idx_secure_attachment_ingestions_communication
  on public.secure_attachment_ingestions (communication_id, created_at desc);
create unique index if not exists idx_secure_attachment_ingestions_vault_document
  on public.secure_attachment_ingestions (vault_document_id) where vault_document_id is not null;

alter table public.secure_attachment_ingestions enable row level security;
revoke all privileges on table public.secure_attachment_ingestions from public, anon, authenticated;
grant select, insert, update on table public.secure_attachment_ingestions to service_role;

create or replace function public.publish_cim_attachment_to_vault_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_intake public.secure_attachment_ingestions%rowtype;
  v_communication jsonb;
  v_submission public.contact_submissions%rowtype;
  v_request jsonb := p_command -> 'request';
  v_document jsonb := p_command -> 'document';
  v_published_at timestamptz := (p_command ->> 'publishedAt')::timestamptz;
begin
  select * into v_intake from public.secure_attachment_ingestions
    where id = (p_command ->> 'intakeId')::uuid for update;
  if not found then return null; end if;
  if v_intake.lifecycle_status <> 'publishing'
    or coalesce(p_command ->> 'expectedStatus', '') <> 'publishing'
  then return null; end if;

  if v_intake.scan_status <> 'clean'
    or v_intake.owner_approved_at is null
    or v_intake.owner_approved_by is null
    or v_intake.approved_submission_id is null
    or v_intake.approved_document_type is null
    or v_intake.vault_request_id is null
    or v_intake.vault_document_id is null
    or v_intake.vault_relative_path is null
    or v_intake.approved_submission_id is distinct from (v_request ->> 'submission_id')::uuid
    or v_intake.approved_document_type is distinct from v_document ->> 'document_type'
    or v_intake.vault_request_id is distinct from (v_request ->> 'id')::uuid
    or v_intake.vault_document_id is distinct from (v_document ->> 'id')::uuid
    or (v_document ->> 'request_id')::uuid is distinct from (v_request ->> 'id')::uuid
    or (v_document ->> 'submission_id')::uuid is distinct from (v_request ->> 'submission_id')::uuid
    or v_document ->> 'original_name' is distinct from v_intake.original_file_name
    or v_document ->> 'mime_type' is distinct from v_intake.detected_mime_type
    or (v_document ->> 'size_bytes')::bigint is distinct from v_intake.size_bytes
    or v_document ->> 'uploaded_by_email' is distinct from v_intake.owner_approved_by
  then raise exception 'Attachment publication authority changed before commit.'; end if;

  select pg_catalog.to_jsonb(c) into v_communication from public.crm_communications c
    where id = v_intake.communication_id for share;
  if not found or v_communication ->> 'direction' is distinct from 'inbound'
    or (v_communication ->> 'submission_id')::uuid is distinct from v_intake.approved_submission_id
  then raise exception 'Attachment communication assignment changed before commit.'; end if;

  select * into v_submission from public.contact_submissions
    where id = v_intake.approved_submission_id for share;
  if not found then raise exception 'Approved attachment business was not found.'; end if;
  perform 1 from public.crm_submission_supersessions
    where superseded_submission_id = v_intake.approved_submission_id and status = 'active'
    for share;
  if found then raise exception 'Approved attachment business is actively superseded.'; end if;

  insert into public.secure_upload_requests (
    id, submission_id, created_at, updated_at, email, contact_name, requested_by, status,
    expires_at, nda_required, nda_accepted_at, last_uploaded_at, note, requested_documents,
    revoked_at, closed_at, upload_batch_count
  ) values (
    (v_request ->> 'id')::uuid, (v_request ->> 'submission_id')::uuid,
    (v_request ->> 'created_at')::timestamptz, (v_request ->> 'updated_at')::timestamptz,
    v_request ->> 'email', v_request ->> 'contact_name', v_request ->> 'requested_by',
    v_request ->> 'status', (v_request ->> 'expires_at')::timestamptz,
    coalesce((v_request ->> 'nda_required')::boolean, false),
    nullif(v_request ->> 'nda_accepted_at', '')::timestamptz,
    nullif(v_request ->> 'last_uploaded_at', '')::timestamptz,
    v_request ->> 'note', coalesce(v_request -> 'requested_documents', '[]'::jsonb),
    nullif(v_request ->> 'revoked_at', '')::timestamptz,
    nullif(v_request ->> 'closed_at', '')::timestamptz,
    coalesce((v_request ->> 'upload_batch_count')::integer, 1)
  );

  insert into public.secure_documents (
    id, request_id, submission_id, created_at, document_type, file_name, original_name,
    mime_type, size_bytes, storage_path, uploaded_by_email, note, nda_accepted_at
  ) values (
    (v_document ->> 'id')::uuid, (v_document ->> 'request_id')::uuid,
    (v_document ->> 'submission_id')::uuid, (v_document ->> 'created_at')::timestamptz,
    v_document ->> 'document_type', v_document ->> 'file_name', v_document ->> 'original_name',
    v_document ->> 'mime_type', (v_document ->> 'size_bytes')::bigint,
    v_document ->> 'storage_path', v_document ->> 'uploaded_by_email',
    v_document ->> 'note', nullif(v_document ->> 'nda_accepted_at', '')::timestamptz
  );

  update public.secure_attachment_ingestions set
    lifecycle_status = 'published', published_at = v_published_at, hold_reason = null, updated_at = v_published_at
    where id = v_intake.id
    returning * into v_intake;
  return pg_catalog.to_jsonb(v_intake);
end;
$$;

revoke all on function public.publish_cim_attachment_to_vault_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_cim_attachment_to_vault_v1(jsonb) to service_role;

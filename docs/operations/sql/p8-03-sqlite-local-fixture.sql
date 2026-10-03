-- P8-03 DISPOSABLE SQLITE FIXTURE UPGRADE PROPOSAL ONLY.
-- Tests may execute this only against a temporary database created from the exact
-- PR55 table shape. There is no runtime caller and it must not target deployed data.

pragma foreign_keys = off;
begin immediate;

alter table secure_attachment_ingestions rename to secure_attachment_ingestions_p802;

create table secure_attachment_ingestions (
  id text primary key,
  communication_id text not null,
  provider text not null,
  provider_message_id text not null,
  provider_attachment_id text not null,
  original_file_name text not null,
  declared_mime_type text not null,
  detected_mime_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  sha256 text not null check (length(sha256) = 64 and sha256 not glob '*[^0-9a-f]*'),
  quarantine_path text not null,
  duplicate_of_id text references secure_attachment_ingestions(id) on delete restrict,
  lifecycle_status text not null check (lifecycle_status in (
    'quarantining', 'scan-pending', 'scanning', 'scan-unavailable', 'unsafe',
    'awaiting-owner-approval', 'publishing', 'published'
  )),
  scan_status text not null check (scan_status in ('pending', 'clean', 'unsafe', 'unavailable')),
  scan_attempt_count integer not null default 0 check (scan_attempt_count between 0 and 3),
  scanner_name text,
  scanner_version text,
  scan_last_error text,
  next_scan_at text,
  scan_request_id text,
  scan_job_owner text,
  scan_requested_at text,
  scan_lease_expires_at text,
  scan_completed_at text,
  scan_request_digest text,
  scan_signature_version text,
  scan_signature_updated_at text,
  scan_verdict_expires_at text,
  hold_reason text,
  owner_approved_at text,
  owner_approved_by text,
  approved_submission_id text references contact_submissions(id) on delete restrict,
  approved_document_type text,
  vault_request_id text,
  vault_document_id text,
  vault_relative_path text,
  published_at text,
  retention_status text not null default 'hold' check (retention_status = 'hold'),
  retention_review_at text not null,
  created_at text not null,
  updated_at text not null,
  unique (provider, provider_message_id, provider_attachment_id)
);

insert into secure_attachment_ingestions (
  id, communication_id, provider, provider_message_id, provider_attachment_id,
  original_file_name, declared_mime_type, detected_mime_type, size_bytes, sha256,
  quarantine_path, duplicate_of_id, lifecycle_status, scan_status, scan_attempt_count,
  scanner_name, scanner_version, scan_last_error, next_scan_at, hold_reason,
  owner_approved_at, owner_approved_by, approved_submission_id, approved_document_type,
  vault_request_id, vault_document_id, vault_relative_path, published_at,
  retention_status, retention_review_at, created_at, updated_at
)
select
  id, communication_id, provider, provider_message_id, provider_attachment_id,
  original_file_name, declared_mime_type, detected_mime_type, size_bytes, sha256,
  quarantine_path, duplicate_of_id, lifecycle_status, scan_status, scan_attempt_count,
  scanner_name, scanner_version, scan_last_error, next_scan_at, hold_reason,
  owner_approved_at, owner_approved_by, approved_submission_id, approved_document_type,
  vault_request_id, vault_document_id, vault_relative_path, published_at,
  retention_status, retention_review_at, created_at, updated_at
from secure_attachment_ingestions_p802;

drop table secure_attachment_ingestions_p802;

create index idx_secure_attachment_ingestions_sha256
  on secure_attachment_ingestions (sha256, created_at);
create index idx_secure_attachment_ingestions_communication
  on secure_attachment_ingestions (communication_id, created_at);
create unique index idx_secure_attachment_ingestions_vault_document
  on secure_attachment_ingestions (vault_document_id) where vault_document_id is not null;
create unique index idx_secure_attachment_ingestions_single_scanning
  on secure_attachment_ingestions ((1)) where lifecycle_status = 'scanning';

commit;
pragma foreign_keys = on;

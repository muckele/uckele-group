alter table public.secure_upload_requests
  add column if not exists requested_documents jsonb not null default '[]'::jsonb,
  add column if not exists revoked_at timestamptz,
  add column if not exists closed_at timestamptz,
  add column if not exists upload_batch_count integer not null default 0;

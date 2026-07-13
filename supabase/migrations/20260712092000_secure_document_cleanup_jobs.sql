create table if not exists public.secure_document_cleanup_jobs (
  id uuid primary key,
  submission_id uuid not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  status text not null,
  trash_directory text,
  files jsonb not null default '[]'::jsonb,
  attempt_count integer not null default 0,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_secure_document_cleanup_jobs_status
  on public.secure_document_cleanup_jobs (status, updated_at);

create table if not exists public.scheduled_job_runs (
  job_key text primary key,
  job_name text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  status text not null,
  triggered_by text,
  attempt_count integer not null default 1,
  provider_message_id text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_scheduled_job_runs_name_updated_at
  on public.scheduled_job_runs (job_name, updated_at desc);

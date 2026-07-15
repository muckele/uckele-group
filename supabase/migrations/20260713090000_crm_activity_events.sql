create table if not exists public.crm_activity_events (
  id uuid primary key,
  submission_id uuid not null references public.contact_submissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  actor text not null,
  role text not null,
  event_type text not null,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_crm_activity_submission_created
  on public.crm_activity_events (submission_id, created_at desc);
create index if not exists idx_crm_activity_type_created
  on public.crm_activity_events (event_type, created_at desc);

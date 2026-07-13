create table if not exists public.admin_audit_events (
  id uuid primary key,
  created_at timestamptz not null,
  request_id text,
  actor text not null,
  role text not null,
  method text not null,
  path text not null,
  status_code integer not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_admin_audit_events_created_at
  on public.admin_audit_events (created_at desc);

create table if not exists public.analytics_events (
  id uuid primary key,
  created_at timestamptz not null,
  event_name text not null,
  path text not null,
  referrer_host text not null default '',
  utm_source text not null default '',
  utm_medium text not null default '',
  utm_campaign text not null default '',
  placement text not null default ''
);

create index if not exists idx_analytics_events_created_at on public.analytics_events (created_at desc);
create index if not exists idx_analytics_events_name_created on public.analytics_events (event_name, created_at desc);
create index if not exists idx_analytics_events_path_created on public.analytics_events (path, created_at desc);

alter table public.analytics_events enable row level security;
revoke all privileges on table public.analytics_events from public, anon, authenticated;
grant all privileges on table public.analytics_events to service_role;

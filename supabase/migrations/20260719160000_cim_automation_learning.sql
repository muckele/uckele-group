create table if not exists public.deal_hunter_cim_reviews (
  id uuid primary key,
  created_at timestamptz not null default now(),
  deal_key text not null,
  decision text not null,
  pass_reason text,
  original_recipient_email text,
  final_recipient_email text,
  recipient_edited boolean not null default false,
  score integer,
  actor text,
  automation_stage integer not null default 1,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_deal_hunter_cim_reviews_created on public.deal_hunter_cim_reviews (created_at desc);
create index if not exists idx_deal_hunter_cim_reviews_deal on public.deal_hunter_cim_reviews (deal_key, created_at desc);

create table if not exists public.deal_hunter_automation_settings (
  id text primary key,
  updated_at timestamptz not null default now(),
  paused boolean not null default false,
  updated_by text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.deal_hunter_cim_reviews enable row level security;
alter table public.deal_hunter_automation_settings enable row level security;

revoke all privileges on table public.deal_hunter_cim_reviews from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_automation_settings from public, anon, authenticated;
grant all privileges on table public.deal_hunter_cim_reviews to service_role;
grant all privileges on table public.deal_hunter_automation_settings to service_role;

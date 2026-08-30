-- Durable operator-entered facts and retained source observations for the
-- Acquisition Inbox. Facts are append-only revisions; source observations are
-- atomically refreshed by their bounded source-record identity. No arbitrary
-- raw source payload is stored in either projection.

create table if not exists public.deal_hunter_opportunity_facts (
  id text primary key,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete cascade,
  field text not null,
  value text not null,
  source text not null default 'operator',
  verified boolean not null default false,
  actor text not null,
  note text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.deal_hunter_opportunity_source_observations (
  id text primary key,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete cascade,
  source_id text not null,
  source_name text not null,
  source_record_id text not null,
  field text not null,
  value text not null,
  observed_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(opportunity_id, source_id, source_record_id, field)
);

create index if not exists idx_deal_hunter_opportunity_facts_history
  on public.deal_hunter_opportunity_facts(opportunity_id, created_at desc, id desc);
create index if not exists idx_deal_hunter_source_observations_history
  on public.deal_hunter_opportunity_source_observations(opportunity_id, observed_at desc, id);

alter table public.deal_hunter_opportunity_facts enable row level security;
alter table public.deal_hunter_opportunity_source_observations enable row level security;
revoke all privileges on table public.deal_hunter_opportunity_facts from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_opportunity_source_observations from public, anon, authenticated;
grant all privileges on table public.deal_hunter_opportunity_facts to service_role;
grant all privileges on table public.deal_hunter_opportunity_source_observations to service_role;

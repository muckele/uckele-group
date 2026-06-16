create table if not exists public.prospect_discovery_runs (
  id uuid primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  status text not null,
  provider text not null,
  query text not null,
  requested_by text,
  max_results integer not null default 0,
  imported_count integer not null default 0,
  skipped_count integer not null default 0,
  error text,
  source_data jsonb not null default '{}'::jsonb
);

create index if not exists idx_prospect_discovery_runs_created_at on public.prospect_discovery_runs (created_at desc);

create table if not exists public.prospect_discoveries (
  id uuid primary key,
  run_id uuid references public.prospect_discovery_runs(id) on delete set null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  provider text not null,
  source_id text,
  business_name text not null,
  website_url text,
  phone text,
  address text,
  category text,
  rating numeric,
  review_count integer not null default 0,
  search_query text,
  status text not null,
  lead_tier text not null default 'unclassified',
  business_quality_score integer not null default 0,
  presence_gap_score integer not null default 0,
  recommended_action text,
  outreach_angle text,
  score integer not null default 0,
  reasons jsonb not null default '[]'::jsonb,
  submission_id uuid references public.contact_submissions(id) on delete set null,
  source_data jsonb not null default '{}'::jsonb
);

create index if not exists idx_prospect_discoveries_run_id on public.prospect_discoveries (run_id, created_at desc);
create index if not exists idx_prospect_discoveries_status on public.prospect_discoveries (status, created_at desc);
create index if not exists idx_prospect_discoveries_lead_tier on public.prospect_discoveries (lead_tier, score desc);
create unique index if not exists idx_prospect_discoveries_source on public.prospect_discoveries (provider, source_id) where source_id is not null and source_id <> '';

create table if not exists public.deal_hunter_deal_os_imports (
  id uuid primary key,
  created_at timestamptz not null,
  imported_by text not null,
  exported_at timestamptz not null,
  file_name text not null,
  file_type text not null,
  file_size integer not null,
  file_sha256 text not null,
  scope text not null,
  coverage_label text not null,
  expected_row_count integer,
  row_count integer not null,
  duplicate_count integer not null default 0,
  stable_id_count integer not null default 0,
  listing_url_count integer not null default 0,
  coverage_limit_reached boolean not null default false,
  records jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_deal_hunter_deal_os_imports_created_at
  on public.deal_hunter_deal_os_imports (created_at desc);
create index if not exists idx_deal_hunter_deal_os_imports_exported_at
  on public.deal_hunter_deal_os_imports (exported_at desc);

alter table public.deal_hunter_deal_os_imports enable row level security;

revoke all privileges on table public.deal_hunter_deal_os_imports from public, anon, authenticated;
grant all privileges on table public.deal_hunter_deal_os_imports to service_role;

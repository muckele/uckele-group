create table if not exists public.deal_hunter_crm_imports (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deal_key text not null,
  listing_identity text,
  listing_url text,
  submission_id uuid references public.contact_submissions(id) on delete set null,
  status text not null,
  source_name text,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists idx_deal_hunter_crm_imports_deal_key
  on public.deal_hunter_crm_imports (deal_key);

create unique index if not exists idx_deal_hunter_crm_imports_listing_identity
  on public.deal_hunter_crm_imports (listing_identity)
  where listing_identity is not null and listing_identity <> '';

create index if not exists idx_deal_hunter_crm_imports_submission_id
  on public.deal_hunter_crm_imports (submission_id);

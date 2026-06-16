create table if not exists public.deal_hunter_cim_requests (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deal_key text not null,
  recipient_email text not null,
  requested_by text,
  status text not null,
  delivery_error text,
  provider_message_id text,
  subject text,
  deal_name text,
  source_name text,
  listing_url text,
  score integer,
  follow_up_count integer not null default 0,
  last_follow_up_at timestamptz,
  next_follow_up_at timestamptz,
  responded_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.deal_hunter_cim_requests
  add column if not exists follow_up_count integer not null default 0;

alter table public.deal_hunter_cim_requests
  add column if not exists last_follow_up_at timestamptz;

alter table public.deal_hunter_cim_requests
  add column if not exists next_follow_up_at timestamptz;

alter table public.deal_hunter_cim_requests
  add column if not exists responded_at timestamptz;

create unique index if not exists idx_deal_hunter_cim_requests_deal_recipient
  on public.deal_hunter_cim_requests (deal_key, recipient_email);

create index if not exists idx_deal_hunter_cim_requests_deal_key
  on public.deal_hunter_cim_requests (deal_key, updated_at desc);

create table if not exists public.contact_submissions (
  id uuid primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  status text not null,
  spam_score integer not null default 0,
  spam_reasons jsonb not null default '[]'::jsonb,
  delivery_provider text not null,
  delivery_status text not null,
  delivery_error text,
  crm_status text not null,
  crm_error text,
  source text not null,
  ip_hash text not null,
  user_agent text,
  name text not null,
  email text not null,
  phone text,
  company text,
  role text,
  message text not null,
  status_updated_at timestamptz,
  listing_url text,
  business_website text,
  prospectus_url text,
  asking_price text,
  ttm_revenue text,
  ttm_ebitda text,
  ebitda_multiple text,
  net_margin text,
  business_age text,
  sba_eligible text not null default 'unknown',
  broker_name text,
  broker_email text,
  broker_phone text,
  seller_name text,
  seller_email text,
  seller_phone text,
  lead_type text not null default 'owner',
  priority text not null default 'normal',
  tags jsonb not null default '[]'::jsonb,
  assigned_to text,
  notes text,
  follow_up_state text not null default 'needs-response',
  next_action_at timestamptz,
  last_contacted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.contact_submissions add column if not exists status_updated_at timestamptz;
alter table public.contact_submissions add column if not exists listing_url text;
alter table public.contact_submissions add column if not exists business_website text;
alter table public.contact_submissions add column if not exists prospectus_url text;
alter table public.contact_submissions add column if not exists asking_price text;
alter table public.contact_submissions add column if not exists ttm_revenue text;
alter table public.contact_submissions add column if not exists ttm_ebitda text;
alter table public.contact_submissions add column if not exists ebitda_multiple text;
alter table public.contact_submissions add column if not exists net_margin text;
alter table public.contact_submissions add column if not exists business_age text;
alter table public.contact_submissions add column if not exists sba_eligible text not null default 'unknown';
alter table public.contact_submissions add column if not exists broker_name text;
alter table public.contact_submissions add column if not exists broker_email text;
alter table public.contact_submissions add column if not exists broker_phone text;
alter table public.contact_submissions add column if not exists seller_name text;
alter table public.contact_submissions add column if not exists seller_email text;
alter table public.contact_submissions add column if not exists seller_phone text;

create index if not exists idx_contact_submissions_created_at on public.contact_submissions (created_at desc);
create index if not exists idx_contact_submissions_status on public.contact_submissions (status);
create index if not exists idx_contact_submissions_email on public.contact_submissions (email);
create index if not exists idx_contact_submissions_ip_hash on public.contact_submissions (ip_hash);
create index if not exists idx_contact_submissions_next_action_at on public.contact_submissions (next_action_at);

create table if not exists public.contact_rate_limit_events (
  id bigint generated always as identity primary key,
  bucket text not null,
  created_at timestamptz not null
);

create index if not exists idx_contact_rate_limit_events_bucket on public.contact_rate_limit_events (bucket, created_at desc);

create table if not exists public.secure_upload_requests (
  id uuid primary key,
  submission_id uuid not null references public.contact_submissions(id) on delete cascade,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  email text not null,
  contact_name text,
  requested_by text,
  status text not null,
  expires_at timestamptz not null,
  nda_required boolean not null default true,
  nda_accepted_at timestamptz,
  last_uploaded_at timestamptz,
  note text
);

create index if not exists idx_secure_upload_requests_submission_id on public.secure_upload_requests (submission_id, created_at desc);

create table if not exists public.secure_documents (
  id uuid primary key,
  request_id uuid not null references public.secure_upload_requests(id) on delete cascade,
  submission_id uuid not null references public.contact_submissions(id) on delete cascade,
  created_at timestamptz not null,
  document_type text not null,
  file_name text not null,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  storage_path text not null,
  uploaded_by_email text,
  note text,
  nda_accepted_at timestamptz
);

create index if not exists idx_secure_documents_request_id on public.secure_documents (request_id, created_at desc);
create index if not exists idx_secure_documents_submission_id on public.secure_documents (submission_id, created_at desc);

create table if not exists public.deal_hunter_criteria (
  id text primary key,
  updated_at timestamptz not null,
  updated_by text,
  criteria jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_runs (
  id uuid primary key,
  created_at timestamptz not null,
  source text not null,
  subject text,
  raw_text text,
  criteria_snapshot jsonb not null default '{}'::jsonb,
  qualified_count integer not null default 0,
  watch_count integer not null default 0,
  rejected_count integer not null default 0,
  recommendation_count integer not null default 0,
  digest_status text not null,
  digest_error text,
  recommendations jsonb not null default '[]'::jsonb,
  requested_by text
);

create index if not exists idx_deal_hunter_runs_created_at on public.deal_hunter_runs (created_at desc);

create table if not exists public.deal_hunter_candidates (
  id uuid primary key,
  run_id uuid not null references public.deal_hunter_runs(id) on delete cascade,
  created_at timestamptz not null,
  company text not null,
  location text,
  industry text,
  description text,
  asking_price bigint,
  annual_profit bigint,
  annual_revenue bigint,
  years_in_business integer,
  source_url text,
  broker text,
  raw_text text,
  score integer not null,
  recession_score integer not null,
  ai_resistance_score integer not null,
  criteria_score integer not null,
  status text not null,
  reasons jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  matched_keywords jsonb not null default '[]'::jsonb,
  excluded_reasons jsonb not null default '[]'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  broker_questions jsonb not null default '[]'::jsonb,
  owner_questions jsonb not null default '[]'::jsonb
);

alter table public.deal_hunter_candidates add column if not exists notes jsonb not null default '[]'::jsonb;
alter table public.deal_hunter_candidates add column if not exists broker_questions jsonb not null default '[]'::jsonb;
alter table public.deal_hunter_candidates add column if not exists owner_questions jsonb not null default '[]'::jsonb;

create index if not exists idx_deal_hunter_candidates_run_id on public.deal_hunter_candidates (run_id, score desc);
create index if not exists idx_deal_hunter_candidates_status on public.deal_hunter_candidates (status, score desc);

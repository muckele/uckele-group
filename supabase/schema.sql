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
  lead_type text not null default 'prospect',
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
alter table public.contact_submissions add column if not exists lead_type text not null default 'prospect';
alter table public.contact_submissions add column if not exists priority text not null default 'normal';
alter table public.contact_submissions add column if not exists tags jsonb not null default '[]'::jsonb;
alter table public.contact_submissions add column if not exists assigned_to text;
alter table public.contact_submissions add column if not exists notes text;
alter table public.contact_submissions add column if not exists follow_up_state text not null default 'needs-response';
alter table public.contact_submissions add column if not exists next_action_at timestamptz;
alter table public.contact_submissions add column if not exists last_contacted_at timestamptz;

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

create table if not exists public.email_events (
  id uuid primary key,
  created_at timestamptz not null,
  provider text not null,
  event_type text not null,
  message_id text,
  provider_event_id text,
  event_key text,
  recipient_email text,
  subject text,
  submission_id uuid references public.contact_submissions(id) on delete set null,
  source text not null,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.email_events add column if not exists provider_event_id text;
alter table public.email_events add column if not exists event_key text;

create index if not exists idx_email_events_submission_id on public.email_events (submission_id, created_at desc);
create index if not exists idx_email_events_recipient_email on public.email_events (recipient_email, created_at desc);
create index if not exists idx_email_events_message_id on public.email_events (message_id);
create index if not exists idx_email_events_event_type on public.email_events (event_type, created_at desc);
create unique index if not exists idx_email_events_event_key on public.email_events (event_key);

create table if not exists public.research_runs (
  id uuid primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  submission_id uuid references public.contact_submissions(id) on delete cascade,
  run_type text not null,
  status text not null,
  requested_by text,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  source_url text,
  score integer not null default 0,
  tier text,
  summary text,
  source_data jsonb not null default '{}'::jsonb
);

create index if not exists idx_research_runs_submission_id on public.research_runs (submission_id, created_at desc);

create table if not exists public.prospect_audits (
  id uuid primary key,
  run_id uuid not null references public.research_runs(id) on delete cascade,
  submission_id uuid references public.contact_submissions(id) on delete cascade,
  created_at timestamptz not null,
  website_url text,
  uptime_status text,
  http_status integer,
  ssl_status text,
  page_title text,
  meta_description text,
  has_contact_form boolean not null default false,
  has_phone_link boolean not null default false,
  has_booking_link boolean not null default false,
  has_mobile_viewport boolean not null default false,
  cta_count integer not null default 0,
  broken_link_count integer not null default 0,
  page_size_bytes bigint not null default 0,
  load_time_ms integer not null default 0,
  findings jsonb not null default '[]'::jsonb,
  source_links jsonb not null default '[]'::jsonb,
  raw_snapshot jsonb not null default '{}'::jsonb
);

create index if not exists idx_prospect_audits_submission_id on public.prospect_audits (submission_id, created_at desc);

create table if not exists public.generated_reports (
  id uuid primary key,
  run_id uuid references public.research_runs(id) on delete set null,
  submission_id uuid references public.contact_submissions(id) on delete cascade,
  created_at timestamptz not null,
  report_type text not null,
  status text not null,
  title text not null,
  summary text,
  content_markdown text,
  personalization jsonb not null default '{}'::jsonb,
  recommended_email_subject text,
  recommended_email_body text
);

create index if not exists idx_generated_reports_submission_id on public.generated_reports (submission_id, created_at desc);

create table if not exists public.outreach_messages (
  id uuid primary key,
  submission_id uuid references public.contact_submissions(id) on delete cascade,
  report_id uuid references public.generated_reports(id) on delete set null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  cadence_name text not null,
  cadence_step integer not null,
  status text not null,
  scheduled_at timestamptz,
  sent_at timestamptz,
  recipient_email text,
  subject text not null,
  body_text text not null,
  body_html text,
  provider_message_id text,
  error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_outreach_messages_submission_id on public.outreach_messages (submission_id, scheduled_at desc);
create index if not exists idx_outreach_messages_status_due on public.outreach_messages (status, scheduled_at);

create table if not exists public.website_visits (
  id uuid primary key,
  created_at timestamptz not null,
  submission_id uuid references public.contact_submissions(id) on delete set null,
  session_id text,
  page_path text not null,
  full_url text,
  referrer text,
  source text,
  ip_hash text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_website_visits_submission_id on public.website_visits (submission_id, created_at desc);

create table if not exists public.email_suppressions (
  id uuid primary key,
  created_at timestamptz not null,
  email text not null,
  reason text not null,
  source text,
  submission_id uuid references public.contact_submissions(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_email_suppressions_email on public.email_suppressions (email);

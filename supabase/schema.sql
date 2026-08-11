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
  archived_at timestamptz,
  archived_by text,
  archive_reason text,
  archive_note text,
  archive_communication_id text,
  restored_at timestamptz,
  restored_by text,
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
alter table public.contact_submissions add column if not exists lead_type text not null default 'owner';
alter table public.contact_submissions add column if not exists priority text not null default 'normal';
alter table public.contact_submissions add column if not exists tags jsonb not null default '[]'::jsonb;
alter table public.contact_submissions add column if not exists assigned_to text;
alter table public.contact_submissions add column if not exists notes text;
alter table public.contact_submissions add column if not exists follow_up_state text not null default 'needs-response';
alter table public.contact_submissions add column if not exists next_action_at timestamptz;
alter table public.contact_submissions add column if not exists last_contacted_at timestamptz;
alter table public.contact_submissions add column if not exists archived_at timestamptz;
alter table public.contact_submissions add column if not exists archived_by text;
alter table public.contact_submissions add column if not exists archive_reason text;
alter table public.contact_submissions add column if not exists archive_note text;
alter table public.contact_submissions add column if not exists archive_communication_id text;
alter table public.contact_submissions add column if not exists restored_at timestamptz;
alter table public.contact_submissions add column if not exists restored_by text;

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
  note text,
  requested_documents jsonb not null default '[]'::jsonb,
  revoked_at timestamptz,
  closed_at timestamptz,
  upload_batch_count integer not null default 0
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
  communication_id text,
  source text not null,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.email_events add column if not exists provider_event_id text;
alter table public.email_events add column if not exists event_key text;
alter table public.email_events add column if not exists communication_id text;

create index if not exists idx_email_events_submission_id on public.email_events (submission_id, created_at desc);
create index if not exists idx_email_events_recipient_email on public.email_events (recipient_email, created_at desc);
create index if not exists idx_email_events_message_id on public.email_events (message_id);
create index if not exists idx_email_events_event_type on public.email_events (event_type, created_at desc);
create index if not exists idx_email_events_communication_id on public.email_events (communication_id, created_at desc);

create table if not exists public.crm_activity_events (
  id uuid primary key,
  submission_id uuid not null references public.contact_submissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  actor text not null,
  role text not null,
  event_type text not null,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_crm_activity_submission_created
  on public.crm_activity_events (submission_id, created_at desc);
create index if not exists idx_crm_activity_type_created
  on public.crm_activity_events (event_type, created_at desc);
create unique index if not exists idx_email_events_event_key on public.email_events (event_key);

create table if not exists public.deal_hunter_seen_deals (
  id text primary key,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  source_id text,
  source_name text,
  source_mode text,
  external_id text,
  listing_url text,
  name text not null,
  industry text,
  location text,
  annual_profit numeric,
  annual_revenue numeric,
  asking_price numeric,
  score integer,
  should_remove boolean not null default false,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_deal_hunter_seen_deals_last_seen_at on public.deal_hunter_seen_deals (last_seen_at desc);
create index if not exists idx_deal_hunter_seen_deals_source_id on public.deal_hunter_seen_deals (source_id, last_seen_at desc);

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
  submission_id uuid references public.contact_submissions(id) on delete set null,
  request_state text,
  delivery_state text,
  delivery_state_at timestamptz,
  follow_up_state text,
  first_requested_at timestamptz,
  first_provider_accepted_at timestamptz,
  delivered_at timestamptz,
  last_attempt_at timestamptz,
  last_delivery_event_at timestamptz,
  reply_to_address text,
  retry_of_request_id text references public.deal_hunter_cim_requests(id) on delete set null,
  attempt_count integer,
  last_activity_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.deal_hunter_cim_requests add column if not exists submission_id uuid;
alter table public.deal_hunter_cim_requests add column if not exists request_state text;
alter table public.deal_hunter_cim_requests add column if not exists delivery_state text;
alter table public.deal_hunter_cim_requests add column if not exists delivery_state_at timestamptz;
alter table public.deal_hunter_cim_requests add column if not exists follow_up_state text;
alter table public.deal_hunter_cim_requests add column if not exists first_requested_at timestamptz;
alter table public.deal_hunter_cim_requests add column if not exists first_provider_accepted_at timestamptz;
alter table public.deal_hunter_cim_requests add column if not exists delivered_at timestamptz;
alter table public.deal_hunter_cim_requests add column if not exists last_attempt_at timestamptz;
alter table public.deal_hunter_cim_requests add column if not exists last_delivery_event_at timestamptz;
alter table public.deal_hunter_cim_requests add column if not exists reply_to_address text;
alter table public.deal_hunter_cim_requests add column if not exists retry_of_request_id text;
alter table public.deal_hunter_cim_requests add column if not exists attempt_count integer;
alter table public.deal_hunter_cim_requests add column if not exists last_activity_at timestamptz;

update public.deal_hunter_cim_requests
set
  first_requested_at = coalesce(first_requested_at, created_at),
  request_state = coalesce(nullif(request_state, ''), case
    when status = 'pending' then 'pending'
    when status = 'responded' then 'responded'
    when status = 'delivery_issue' then 'stopped'
    when status = 'failed' then 'ready'
    else 'provider_accepted'
  end),
  delivery_state = coalesce(nullif(delivery_state, ''), case
    when status = 'logged' then 'development-only'
    when status = 'failed' then 'failed'
    when status = 'delivery_issue' then coalesce(nullif(metadata ->> 'deliveryIssueType', ''), 'failed')
    when status = 'pending' then 'not-attempted'
    else 'accepted'
  end),
  follow_up_state = coalesce(nullif(follow_up_state, ''), case
    when responded_at is not null or status = 'responded' then 'completed'
    when next_follow_up_at is not null then 'scheduled'
    when status in ('failed', 'delivery_issue') then 'stopped'
    when follow_up_count > 0 then 'completed'
    else 'not-scheduled'
  end),
  reply_to_address = coalesce(nullif(reply_to_address, ''), nullif(metadata ->> 'replyToAddress', '')),
  attempt_count = coalesce(attempt_count, case when status = 'pending' then 0 else 1 end),
  last_activity_at = coalesce(last_activity_at, updated_at, created_at);

create unique index if not exists idx_deal_hunter_cim_requests_deal_recipient on public.deal_hunter_cim_requests (deal_key, recipient_email);
create index if not exists idx_deal_hunter_cim_requests_deal_key on public.deal_hunter_cim_requests (deal_key, updated_at desc);
create index if not exists idx_deal_hunter_cim_requests_submission on public.deal_hunter_cim_requests (submission_id, last_activity_at desc);
create index if not exists idx_deal_hunter_cim_requests_request_state on public.deal_hunter_cim_requests (request_state, first_requested_at desc);
create index if not exists idx_deal_hunter_cim_requests_delivery_state on public.deal_hunter_cim_requests (delivery_state, last_delivery_event_at desc);
create index if not exists idx_deal_hunter_cim_requests_follow_up_state on public.deal_hunter_cim_requests (follow_up_state, next_follow_up_at);
create unique index if not exists idx_deal_hunter_cim_requests_reply_to
  on public.deal_hunter_cim_requests (lower(reply_to_address))
  where reply_to_address is not null and reply_to_address <> '';

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

create or replace function public.canonical_listing_identity(p_value text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_value text := lower(btrim(coalesce(p_value, '')));
  v_base text;
  v_query text;
  v_host text;
  v_path text;
  v_normalized_query text;
begin
  if v_value = '' then return ''; end if;
  v_value := regexp_replace(v_value, '^[a-z][a-z0-9+.-]*://', '', 'i');
  v_value := split_part(v_value, '#', 1);
  v_base := split_part(v_value, '?', 1);
  v_query := case when strpos(v_value, '?') > 0 then substring(v_value from strpos(v_value, '?') + 1) else '' end;
  v_host := split_part(v_base, '/', 1);
  v_host := regexp_replace(v_host, '^.*@', '');
  v_host := regexp_replace(v_host, ':\d+$', '');
  v_host := regexp_replace(v_host, '^www\.', '');
  v_path := substring(v_base from length(split_part(v_base, '/', 1)) + 1);
  v_path := regexp_replace(v_path, '/+$', '');
  if v_path = '' then v_path := '/'; end if;
  select string_agg(parameter, '&' order by split_part(parameter, '=', 1), parameter)
  into v_normalized_query
  from unnest(string_to_array(v_query, '&')) as parameter
  where parameter <> ''
    and lower(split_part(parameter, '=', 1)) !~ '^utm_'
    and lower(split_part(parameter, '=', 1)) not in ('fbclid', 'gclid', 'mc_cid', 'mc_eid');
  return v_host || v_path || case when coalesce(v_normalized_query, '') <> '' then '?' || v_normalized_query else '' end;
end;
$$;

with candidate_links as (
  select request.id as request_id, import_record.submission_id
  from public.deal_hunter_cim_requests as request
  join public.deal_hunter_crm_imports as import_record on import_record.deal_key = request.deal_key
  where request.submission_id is null and import_record.submission_id is not null
  union
  select request.id, submission.id
  from public.deal_hunter_cim_requests as request
  join public.contact_submissions as submission
    on public.canonical_listing_identity(submission.listing_url) = public.canonical_listing_identity(request.listing_url)
  where request.submission_id is null and public.canonical_listing_identity(request.listing_url) <> ''
  union
  select request.id, submission.id
  from public.deal_hunter_cim_requests as request
  join public.contact_submissions as submission
    on nullif(btrim(submission.metadata #>> '{dealHunter,dealKey}'), '') = request.deal_key
  where request.submission_id is null
), safe_links as (
  select request_id, min(submission_id::text)::uuid as submission_id
  from candidate_links
  group by request_id
  having count(distinct submission_id) = 1
)
update public.deal_hunter_cim_requests as request
set submission_id = safe_links.submission_id
from safe_links
where request.id = safe_links.request_id and request.submission_id is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deal_hunter_cim_requests_submission_id_fkey') then
    alter table public.deal_hunter_cim_requests
      add constraint deal_hunter_cim_requests_submission_id_fkey
      foreign key (submission_id) references public.contact_submissions(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deal_hunter_cim_requests_retry_of_request_id_fkey') then
    alter table public.deal_hunter_cim_requests
      add constraint deal_hunter_cim_requests_retry_of_request_id_fkey
      foreign key (retry_of_request_id) references public.deal_hunter_cim_requests(id) on delete set null;
  end if;
end
$$;

create table if not exists public.crm_communications (
  id text primary key,
  submission_id uuid references public.contact_submissions(id) on delete cascade,
  deal_key text,
  cim_request_id text references public.deal_hunter_cim_requests(id) on delete set null,
  direction text not null check (direction in ('inbound', 'outbound')),
  channel text not null check (channel in ('email', 'phone', 'meeting', 'text', 'note')),
  source text not null check (source in ('deal-hunter', 'resend-webhook', 'manual', 'secure-documents', 'system')),
  kind text,
  provider text,
  provider_message_id text,
  source_event_id text,
  idempotency_key text,
  message_id text,
  in_reply_to text,
  references_json jsonb not null default '[]'::jsonb,
  parent_communication_id text,
  thread_key text,
  legacy_content_unavailable boolean not null default false,
  content_redaction_state text not null default 'none',
  recommendation_id text,
  outbox_id text,
  headers_json jsonb not null default '{}'::jsonb,
  reply_to_address text,
  from_address text,
  to_addresses jsonb not null default '[]'::jsonb,
  cc_addresses jsonb not null default '[]'::jsonb,
  bcc_addresses jsonb not null default '[]'::jsonb,
  subject text,
  body_text text not null default '',
  body_html_sanitized text not null default '',
  occurred_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  delivery_state text not null default 'not-attempted'
    check (delivery_state in ('not-attempted', 'accepted', 'delivered', 'delayed', 'bounced', 'failed', 'complained', 'suppressed', 'development-only', 'replied')),
  delivery_state_at timestamptz,
  content_state text not null default 'not-applicable'
    check (content_state in ('not-applicable', 'pending', 'complete', 'failed', 'legacy-unavailable')),
  content_attempt_count integer not null default 0 check (content_attempt_count >= 0),
  content_last_error text,
  content_next_attempt_at timestamptz,
  attachment_metadata jsonb not null default '[]'::jsonb,
  assigned_at timestamptz,
  assigned_by text,
  created_by text not null default 'system',
  updated_by text not null default 'system',
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_crm_communications_submission_occurred
  on public.crm_communications (submission_id, occurred_at desc, id desc);
create index if not exists idx_crm_communications_cim_occurred
  on public.crm_communications (cim_request_id, occurred_at desc, id desc);
create index if not exists idx_crm_communications_deal_occurred
  on public.crm_communications (deal_key, occurred_at desc, id desc);
create index if not exists idx_crm_communications_unassigned
  on public.crm_communications (occurred_at desc, id desc)
  where submission_id is null and direction = 'inbound';
create index if not exists idx_crm_communications_content_retry
  on public.crm_communications (content_state, content_next_attempt_at)
  where content_state in ('pending', 'failed');
create unique index if not exists idx_crm_communications_provider_message
  on public.crm_communications (provider, provider_message_id, direction)
  where provider is not null and provider_message_id is not null and provider_message_id <> '';
create unique index if not exists idx_crm_communications_source_event
  on public.crm_communications (provider, source_event_id)
  where provider is not null and source_event_id is not null and source_event_id <> '';
create unique index if not exists idx_crm_communications_idempotency
  on public.crm_communications (idempotency_key)
  where idempotency_key is not null and idempotency_key <> '';
create unique index if not exists idx_crm_communications_message_id
  on public.crm_communications (message_id)
  where message_id is not null and message_id <> '';
create index if not exists idx_crm_communications_parent
  on public.crm_communications (parent_communication_id);
create index if not exists idx_crm_communications_thread_occurred
  on public.crm_communications (thread_key, occurred_at desc, id desc);

create table if not exists public.crm_email_outbox (
  id text primary key,
  communication_id text not null unique references public.crm_communications(id) on delete cascade,
  submission_id uuid not null references public.contact_submissions(id) on delete cascade,
  cim_request_id text references public.deal_hunter_cim_requests(id) on delete set null,
  idempotency_key text not null unique,
  client_request_key text not null unique,
  state text not null check (state in (
    'queued', 'sending', 'accepted', 'ambiguous', 'retryable_failed', 'permanent_failed', 'cancelled'
  )),
  provider text,
  provider_message_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  claim_token text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  accepted_at timestamptz,
  failed_at timestamptz,
  ambiguous_at timestamptz,
  last_error_category text,
  last_error_message text,
  expected_submission_version timestamptz not null,
  actor text not null,
  intended_follow_up_state text,
  intended_next_action_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_crm_email_outbox_submission_created
  on public.crm_email_outbox (submission_id, created_at desc);
create index if not exists idx_crm_email_outbox_claimable
  on public.crm_email_outbox (state, next_attempt_at, claim_expires_at);
create index if not exists idx_crm_email_outbox_provider_message
  on public.crm_email_outbox (provider_message_id);

create table if not exists public.crm_follow_up_recommendations (
  id text primary key,
  submission_id uuid not null references public.contact_submissions(id) on delete cascade,
  cim_request_id text references public.deal_hunter_cim_requests(id) on delete set null,
  triggering_communication_id text references public.crm_communications(id) on delete set null,
  input_fingerprint text not null,
  engine_version text not null,
  rules_version text not null,
  model_provider text,
  model_id text,
  status text not null check (status in (
    'current', 'superseded', 'accepted', 'edited_and_accepted', 'dismissed', 'failed'
  )),
  conversation_state text not null,
  intent text not null,
  action_type text not null,
  priority_score integer not null default 0 check (priority_score between 0 and 100),
  confidence numeric not null default 0 check (confidence between 0 and 1),
  recommended_next_action_at timestamptz,
  thread_parent_communication_id text references public.crm_communications(id) on delete set null,
  rationale text not null default '',
  evidence_json jsonb not null default '[]'::jsonb,
  signals_json jsonb not null default '[]'::jsonb,
  commitments_json jsonb not null default '[]'::jsonb,
  questions_json jsonb not null default '[]'::jsonb,
  blockers_json jsonb not null default '[]'::jsonb,
  safety_flags_json jsonb not null default '[]'::jsonb,
  draft_subject text not null default '',
  draft_body_text text not null default '',
  created_at timestamptz not null,
  expires_at timestamptz,
  acted_on_at timestamptz,
  superseded_at timestamptz,
  acted_on_by text,
  outcome text,
  metadata jsonb not null default '{}'::jsonb,
  unique (submission_id, input_fingerprint, engine_version)
);
create index if not exists idx_crm_follow_up_recommendations_submission_created
  on public.crm_follow_up_recommendations (submission_id, created_at desc);
create unique index if not exists idx_crm_follow_up_recommendations_one_current
  on public.crm_follow_up_recommendations (submission_id)
  where status = 'current';

create table if not exists public.email_suppressions (
  id text primary key,
  normalized_email text not null unique,
  reason text not null check (reason in (
    'explicit-opt-out', 'complaint', 'hard-bounce', 'admin-block', 'provider-suppression'
  )),
  source text not null,
  source_event_id text,
  source_communication_id text references public.crm_communications(id) on delete set null,
  created_at timestamptz not null,
  created_by text not null,
  lifted_at timestamptz,
  lifted_by text,
  lift_reason text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_email_suppressions_active
  on public.email_suppressions (normalized_email)
  where lifted_at is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'email_events_communication_id_fkey') then
    alter table public.email_events
      add constraint email_events_communication_id_fkey
      foreign key (communication_id) references public.crm_communications(id) on delete set null;
  end if;
end
$$;

create table if not exists public.deal_hunter_dispositions (
  id uuid primary key,
  deal_key text not null unique,
  submission_id uuid references public.contact_submissions(id) on delete set null,
  communication_id text references public.crm_communications(id) on delete set null,
  listing_url text,
  deal_name text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  disposition text not null check (disposition in ('dismissed', 'restored')),
  reason text,
  note text,
  dismissed_at timestamptz,
  dismissed_by text,
  restored_at timestamptz,
  restored_by text,
  created_by text not null default 'system',
  updated_by text not null default 'system',
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_deal_hunter_dispositions_updated
  on public.deal_hunter_dispositions (updated_at desc, id desc);
create index if not exists idx_deal_hunter_dispositions_submission
  on public.deal_hunter_dispositions (submission_id, updated_at desc);

create index if not exists idx_contact_submissions_broker_email_lower
  on public.contact_submissions (lower(broker_email));
create index if not exists idx_contact_submissions_seller_email_lower
  on public.contact_submissions (lower(seller_email));

create table if not exists public.scheduled_job_runs (
  job_key text primary key,
  job_name text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  status text not null,
  triggered_by text,
  attempt_count integer not null default 1,
  provider_message_id text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_scheduled_job_runs_name_updated_at
  on public.scheduled_job_runs (job_name, updated_at desc);

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

create table if not exists public.secure_document_cleanup_jobs (
  id uuid primary key,
  submission_id uuid not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  status text not null,
  trash_directory text,
  files jsonb not null default '[]'::jsonb,
  attempt_count integer not null default 0,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  lease_claimed_at timestamptz,
  lease_expires_at timestamptz,
  lease_token text
);

create index if not exists idx_secure_document_cleanup_jobs_status
  on public.secure_document_cleanup_jobs (status, updated_at);

create index if not exists idx_secure_document_cleanup_jobs_lease
  on public.secure_document_cleanup_jobs (status, lease_expires_at);

create table if not exists public.source_health_snapshots (
  id uuid primary key,
  created_at timestamptz not null,
  healthy boolean not null default false,
  source_count integer not null default 0,
  issue_count integer not null default 0,
  snapshot jsonb not null default '{}'::jsonb
);

create index if not exists idx_source_health_snapshots_created_at
  on public.source_health_snapshots (created_at desc);

create table if not exists public.admin_magic_links (
  token_hash text primary key,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  email text not null,
  role text not null,
  requested_ip_hash text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_admin_magic_links_expires_at on public.admin_magic_links (expires_at);

create table if not exists public.admin_sessions (
  id uuid primary key,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null,
  revoked_at timestamptz,
  username text not null,
  principal_id text not null,
  role text not null,
  created_ip_hash text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb
);
alter table public.admin_sessions add column if not exists principal_id text;
update public.admin_sessions
set principal_id = case
  when role = 'admin' then 'admin:primary'
  else 'viewer:identity:' || lower(btrim(username))
end
where principal_id is null or btrim(principal_id) = '';
alter table public.admin_sessions alter column principal_id set not null;
create index if not exists idx_admin_sessions_username on public.admin_sessions (username, created_at desc);
create index if not exists idx_admin_sessions_principal on public.admin_sessions (principal_id, created_at desc);
create index if not exists idx_admin_sessions_expires_at on public.admin_sessions (expires_at);

create table if not exists public.admin_onboarding_progress (
  principal_id text not null,
  tour_key text not null,
  tour_version integer not null check (tour_version > 0),
  status text not null check (status in ('in_progress', 'completed', 'skipped')),
  last_completed_step_id text,
  started_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  skipped_at timestamptz,
  primary key (principal_id, tour_key, tour_version),
  check (
    (status = 'in_progress' and completed_at is null and skipped_at is null)
    or (status = 'completed' and completed_at is not null and skipped_at is null)
    or (status = 'skipped' and completed_at is null and skipped_at is not null)
  )
);
create index if not exists idx_admin_onboarding_progress_principal_updated
  on public.admin_onboarding_progress (principal_id, updated_at desc);

create or replace function public.upsert_admin_onboarding_progress(
  p_principal_id text,
  p_tour_key text,
  p_tour_version integer,
  p_status text,
  p_last_completed_step_id text,
  p_step_ids text[],
  p_started_at timestamptz,
  p_updated_at timestamptz,
  p_completed_at timestamptz,
  p_skipped_at timestamptz
)
returns public.admin_onboarding_progress
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_progress public.admin_onboarding_progress;
begin
  insert into public.admin_onboarding_progress (
    principal_id, tour_key, tour_version, status, last_completed_step_id,
    started_at, updated_at, completed_at, skipped_at
  ) values (
    p_principal_id, p_tour_key, p_tour_version, p_status, p_last_completed_step_id,
    p_started_at, p_updated_at, p_completed_at, p_skipped_at
  )
  on conflict (principal_id, tour_key, tour_version) do update set
    status = case
      when admin_onboarding_progress.status = 'completed' then admin_onboarding_progress.status
      when admin_onboarding_progress.status = 'skipped' and excluded.status <> 'completed' then admin_onboarding_progress.status
      else excluded.status
    end,
    last_completed_step_id = case
      when admin_onboarding_progress.status = 'completed' then admin_onboarding_progress.last_completed_step_id
      when admin_onboarding_progress.status = 'skipped' and excluded.status <> 'completed' then admin_onboarding_progress.last_completed_step_id
      when coalesce(array_position(p_step_ids, excluded.last_completed_step_id), 0)
        < coalesce(array_position(p_step_ids, admin_onboarding_progress.last_completed_step_id), 0)
        then admin_onboarding_progress.last_completed_step_id
      else excluded.last_completed_step_id
    end,
    updated_at = case
      when admin_onboarding_progress.status = 'completed' then admin_onboarding_progress.updated_at
      when admin_onboarding_progress.status = 'skipped' and excluded.status <> 'completed' then admin_onboarding_progress.updated_at
      when admin_onboarding_progress.status = 'in_progress'
        and excluded.status = 'in_progress'
        and coalesce(array_position(p_step_ids, excluded.last_completed_step_id), 0)
          <= coalesce(array_position(p_step_ids, admin_onboarding_progress.last_completed_step_id), 0)
        then admin_onboarding_progress.updated_at
      else excluded.updated_at
    end,
    completed_at = case
      when admin_onboarding_progress.status = 'completed' then admin_onboarding_progress.completed_at
      when excluded.status = 'completed' then excluded.completed_at
      else null
    end,
    skipped_at = case
      when admin_onboarding_progress.status = 'completed' then null
      when admin_onboarding_progress.status = 'skipped' and excluded.status <> 'completed' then admin_onboarding_progress.skipped_at
      when excluded.status = 'skipped' then excluded.skipped_at
      else null
    end
  returning * into v_progress;

  return v_progress;
end;
$$;

revoke all on function public.upsert_admin_onboarding_progress(
  text, text, integer, text, text, text[], timestamptz, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.upsert_admin_onboarding_progress(
  text, text, integer, text, text, text[], timestamptz, timestamptz, timestamptz, timestamptz
) to service_role;

create or replace function public.mutate_with_crm_activity(
  p_operation text,
  p_payload jsonb,
  p_activity jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_record jsonb;
  v_activity jsonb;
  v_updates jsonb;
  v_set_clause text := '';
  v_key text;
  v_value_expression text;
  v_applied boolean := false;
begin
  if p_activity is null then
    raise exception 'CRM activity is required';
  end if;

  if p_operation = 'insert_submission' then
    insert into public.contact_submissions
    select * from jsonb_populate_record(null::public.contact_submissions, p_payload -> 'submission')
    returning to_jsonb(contact_submissions) into v_record;
    v_applied := true;

  elsif p_operation = 'update_submission' then
    v_updates := coalesce(p_payload -> 'values', '{}'::jsonb);

    for v_key in select jsonb_object_keys(v_updates)
    loop
      if not v_key = any(array[
        'updated_at', 'status', 'spam_score', 'spam_reasons', 'delivery_provider',
        'delivery_status', 'delivery_error', 'crm_status', 'crm_error', 'name',
        'email', 'phone', 'company', 'role', 'message', 'status_updated_at',
        'listing_url', 'business_website', 'prospectus_url', 'asking_price',
        'ttm_revenue', 'ttm_ebitda', 'ebitda_multiple', 'net_margin', 'business_age',
        'sba_eligible', 'broker_name', 'broker_email', 'broker_phone', 'seller_name',
        'seller_email', 'seller_phone', 'metadata', 'lead_type', 'priority', 'tags',
        'assigned_to', 'notes', 'follow_up_state', 'next_action_at', 'last_contacted_at'
      ]) then
        raise exception 'Unsupported submission update field: %', v_key;
      end if;

      v_value_expression := case
        when v_key in ('spam_reasons', 'metadata', 'tags')
          then format('$1 -> %L', v_key)
        when v_key = 'spam_score'
          then format('nullif($1 ->> %L, '''')::integer', v_key)
        when v_key in ('updated_at', 'status_updated_at', 'next_action_at', 'last_contacted_at')
          then format('nullif($1 ->> %L, '''')::timestamptz', v_key)
        else format('$1 ->> %L', v_key)
      end;
      v_set_clause := concat_ws(', ', nullif(v_set_clause, ''), format('%I = %s', v_key, v_value_expression));
    end loop;

    if v_set_clause = '' then
      raise exception 'Submission update did not include supported fields';
    end if;

    execute format(
      'update public.contact_submissions as submission set %s where id = $2 and ($3 = '''' or updated_at = $3::timestamptz) returning to_jsonb(submission)',
      v_set_clause
    )
    into v_record
    using v_updates, (p_payload ->> 'id')::uuid, coalesce(p_payload ->> 'expectedUpdatedAt', '');
    v_applied := v_record is not null;

  elsif p_operation = 'insert_secure_upload_request' then
    insert into public.secure_upload_requests
    select * from jsonb_populate_record(null::public.secure_upload_requests, p_payload -> 'request')
    returning to_jsonb(secure_upload_requests) into v_record;
    v_applied := true;

  elsif p_operation = 'finalize_secure_document_upload' then
    v_updates := coalesce(p_payload -> 'values', '{}'::jsonb);
    update public.secure_upload_requests as upload_request
    set
      updated_at = case when v_updates ? 'updated_at' then (v_updates ->> 'updated_at')::timestamptz else updated_at end,
      status = case when v_updates ? 'status' then v_updates ->> 'status' else status end,
      nda_accepted_at = case when v_updates ? 'nda_accepted_at' then nullif(v_updates ->> 'nda_accepted_at', '')::timestamptz else nda_accepted_at end,
      last_uploaded_at = case when v_updates ? 'last_uploaded_at' then nullif(v_updates ->> 'last_uploaded_at', '')::timestamptz else last_uploaded_at end,
      closed_at = case when v_updates ? 'closed_at' then nullif(v_updates ->> 'closed_at', '')::timestamptz else closed_at end,
      upload_batch_count = case when v_updates ? 'upload_batch_count' then (v_updates ->> 'upload_batch_count')::integer else upload_batch_count end
    where id = (p_payload ->> 'requestId')::uuid
      and status = 'uploading'
    returning to_jsonb(upload_request) into v_record;

    if v_record is null then
      select to_jsonb(upload_request)
      into v_record
      from public.secure_upload_requests as upload_request
      where id = (p_payload ->> 'requestId')::uuid;

      return jsonb_build_object('applied', false, 'record', v_record, 'activity', null);
    end if;

    insert into public.secure_documents
    select *
    from jsonb_populate_recordset(
      null::public.secure_documents,
      coalesce(p_payload -> 'documents', '[]'::jsonb)
    );
    v_applied := true;

  elsif p_operation = 'update_secure_upload_request' then
    v_updates := coalesce(p_payload -> 'values', '{}'::jsonb);
    update public.secure_upload_requests as upload_request
    set
      updated_at = case when v_updates ? 'updated_at' then (v_updates ->> 'updated_at')::timestamptz else updated_at end,
      status = case when v_updates ? 'status' then v_updates ->> 'status' else status end,
      expires_at = case when v_updates ? 'expires_at' then (v_updates ->> 'expires_at')::timestamptz else expires_at end,
      nda_required = case when v_updates ? 'nda_required' then (v_updates ->> 'nda_required')::boolean else nda_required end,
      nda_accepted_at = case when v_updates ? 'nda_accepted_at' then nullif(v_updates ->> 'nda_accepted_at', '')::timestamptz else nda_accepted_at end,
      last_uploaded_at = case when v_updates ? 'last_uploaded_at' then nullif(v_updates ->> 'last_uploaded_at', '')::timestamptz else last_uploaded_at end,
      note = case when v_updates ? 'note' then v_updates ->> 'note' else note end,
      requested_documents = case when v_updates ? 'requested_documents' then v_updates -> 'requested_documents' else requested_documents end,
      revoked_at = case when v_updates ? 'revoked_at' then nullif(v_updates ->> 'revoked_at', '')::timestamptz else revoked_at end,
      closed_at = case when v_updates ? 'closed_at' then nullif(v_updates ->> 'closed_at', '')::timestamptz else closed_at end,
      upload_batch_count = case when v_updates ? 'upload_batch_count' then (v_updates ->> 'upload_batch_count')::integer else upload_batch_count end
    where id = (p_payload ->> 'id')::uuid
      and (
        jsonb_array_length(coalesce(p_payload -> 'expectedStatuses', '[]'::jsonb)) = 0
        or status in (select jsonb_array_elements_text(p_payload -> 'expectedStatuses'))
      )
    returning to_jsonb(upload_request) into v_record;
    v_applied := v_record is not null;

  elsif p_operation = 'delete_secure_document' then
    delete from public.secure_documents as document
    where id = (p_payload ->> 'id')::uuid
    returning to_jsonb(document) into v_record;
    v_applied := v_record is not null;

  elsif p_operation = 'insert_email_event' then
    insert into public.email_events
    select * from jsonb_populate_record(null::public.email_events, p_payload -> 'event')
    on conflict (event_key) do nothing
    returning to_jsonb(email_events) into v_record;

    if v_record is null then
      select to_jsonb(email_event)
      into v_record
      from public.email_events as email_event
      where email_event.event_key = p_payload #>> '{event,event_key}'
      limit 1;

      return jsonb_build_object('applied', false, 'record', v_record, 'activity', null);
    end if;
    v_applied := true;

  elsif p_operation = 'upsert_deal_hunter_cim_request' then
    insert into public.deal_hunter_cim_requests
    select * from jsonb_populate_record(null::public.deal_hunter_cim_requests, p_payload -> 'request')
    on conflict (deal_key, recipient_email) do update set
      id = excluded.id,
      updated_at = excluded.updated_at,
      requested_by = excluded.requested_by,
      status = excluded.status,
      delivery_error = excluded.delivery_error,
      provider_message_id = excluded.provider_message_id,
      subject = excluded.subject,
      deal_name = excluded.deal_name,
      source_name = excluded.source_name,
      listing_url = excluded.listing_url,
      score = excluded.score,
      follow_up_count = excluded.follow_up_count,
      last_follow_up_at = excluded.last_follow_up_at,
      next_follow_up_at = excluded.next_follow_up_at,
      responded_at = excluded.responded_at,
      metadata = excluded.metadata
    returning to_jsonb(deal_hunter_cim_requests) into v_record;
    v_applied := true;

  else
    raise exception 'Unsupported atomic CRM activity operation: %', coalesce(p_operation, 'unknown');
  end if;

  if not v_applied then
    return jsonb_build_object('applied', false, 'record', v_record, 'activity', null);
  end if;

  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;

  return jsonb_build_object('applied', true, 'record', v_record, 'activity', v_activity);
end;
$$;

revoke all on function public.mutate_with_crm_activity(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.mutate_with_crm_activity(text, jsonb, jsonb) to service_role;

create or replace function public.list_submissions_by_contact_email(
  p_email text,
  p_limit integer default 25,
  p_open_only boolean default false
)
returns setof public.contact_submissions
language sql
stable
security invoker
set search_path = ''
as $$
  select submission.*
  from public.contact_submissions as submission
  where nullif(btrim(p_email), '') is not null
    and (
      lower(btrim(submission.email)) = lower(btrim(p_email))
      or lower(btrim(coalesce(submission.broker_email, ''))) = lower(btrim(p_email))
      or lower(btrim(coalesce(submission.seller_email, ''))) = lower(btrim(p_email))
    )
    and (
      not p_open_only
      or lower(coalesce(submission.status, '')) not in ('archived', 'spam')
    )
  order by submission.created_at desc, submission.id desc
  limit greatest(1, least(coalesce(p_limit, 25), 250));
$$;

revoke all on function public.list_submissions_by_contact_email(text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.list_submissions_by_contact_email(text, integer, boolean)
  to service_role;

create or replace function public.delete_crm_submission_lifecycle(
  p_submission_id uuid,
  p_deleted_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_record jsonb;
  v_deleted_at timestamptz := coalesce(p_deleted_at, now());
begin
  select to_jsonb(submission)
  into v_record
  from public.contact_submissions as submission
  where submission.id = p_submission_id
  for update;

  if v_record is null then
    return null;
  end if;

  if exists (
    select 1
    from public.deal_hunter_cim_requests as request
    where request.submission_id = p_submission_id
      and (
        (request.status = 'pending' and request.updated_at > v_deleted_at - interval '10 minutes')
        or (request.status = 'follow_up_pending' and request.updated_at > v_deleted_at - interval '30 minutes')
      )
  ) then
    raise exception 'CIM transmission is in progress; CRM deletion is blocked until its claim lease expires.'
      using errcode = 'P0001';
  end if;

  delete from public.email_events where submission_id = p_submission_id;
  delete from public.crm_communications where submission_id = p_submission_id;
  delete from public.crm_activity_events where submission_id = p_submission_id;

  update public.deal_hunter_crm_imports
  set submission_id = null, status = 'crm-deleted', updated_at = v_deleted_at
  where submission_id = p_submission_id;

  update public.deal_hunter_cim_requests
  set
    submission_id = null,
    request_state = case when request_state = 'responded' then request_state else 'stopped' end,
    follow_up_state = case when request_state = 'responded' then 'completed' else 'stopped' end,
    next_follow_up_at = null,
    updated_at = v_deleted_at,
    last_activity_at = v_deleted_at
  where submission_id = p_submission_id;

  update public.deal_hunter_dispositions
  set submission_id = null, updated_at = v_deleted_at
  where submission_id = p_submission_id;

  delete from public.contact_submissions where id = p_submission_id;
  return v_record;
end;
$$;

create or replace function public.claim_crm_communications_pending_ingestion(
  p_due_before timestamptz,
  p_lease_until timestamptz,
  p_limit integer,
  p_claimed_by text
)
returns setof public.crm_communications
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_due_before is null or p_lease_until is null or p_lease_until <= p_due_before then
    raise exception 'Communication ingestion lease expiry must be later than its due time';
  end if;

  return query
  with candidates as materialized (
    select communication.id, communication.content_next_attempt_at, communication.created_at
    from public.crm_communications as communication
    where communication.content_state in ('pending', 'failed')
      and communication.content_next_attempt_at is not null
      and communication.content_next_attempt_at <= p_due_before
    order by communication.content_next_attempt_at, communication.created_at, communication.id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 250))
  ), claimed as (
    update public.crm_communications as communication
    set
      content_next_attempt_at = p_lease_until,
      updated_at = now(),
      updated_by = coalesce(nullif(btrim(p_claimed_by), ''), 'communications-ingestion')
    from candidates
    where communication.id = candidates.id
    returning communication.*
  )
  select claimed.*
  from claimed
  join candidates on candidates.id = claimed.id
  order by candidates.content_next_attempt_at, candidates.created_at, candidates.id;
end;
$$;

create or replace function public.claim_deal_hunter_cim_request(
  p_request jsonb,
  p_pending_cutoff timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_new public.deal_hunter_cim_requests%rowtype;
  v_current public.deal_hunter_cim_requests%rowtype;
  v_parent public.deal_hunter_cim_requests%rowtype;
  v_blocking public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
begin
  select *
  into v_new
  from jsonb_populate_record(null::public.deal_hunter_cim_requests, coalesce(p_request, '{}'::jsonb));
  v_new.deal_key := btrim(coalesce(v_new.deal_key, ''));
  v_new.recipient_email := lower(btrim(coalesce(v_new.recipient_email, '')));

  if v_new.id is null or v_new.id = '' or v_new.deal_key = '' or v_new.recipient_email = '' then
    raise exception 'CIM request id, deal key, and recipient email are required';
  end if;

  if v_new.submission_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'submission-missing', 'request', null);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_new.deal_key, 0));

  select *
  into v_submission
  from public.contact_submissions as submission
  where submission.id = v_new.submission_id
  for update;

  if v_submission.id is null then
    return jsonb_build_object('claimed', false, 'reason', 'submission-missing', 'request', null);
  end if;

  if v_submission.status = 'archived' then
    return jsonb_build_object('claimed', false, 'reason', 'submission-archived', 'request', null);
  end if;

  select *
  into v_current
  from public.deal_hunter_cim_requests as request
  where request.deal_key = v_new.deal_key
    and lower(request.recipient_email) = v_new.recipient_email
  limit 1
  for update;

  if v_new.retry_of_request_id is not null then
    select *
    into v_parent
    from public.deal_hunter_cim_requests as request
    where request.id = v_new.retry_of_request_id
      and request.deal_key = v_new.deal_key
    limit 1
    for update;

    if v_parent.id is null
      or v_parent.status <> 'delivery_issue'
      or v_parent.delivery_state not in ('bounced', 'failed', 'complained', 'suppressed') then
      return jsonb_build_object(
        'claimed', false,
        'request', case when v_current.id is not null then to_jsonb(v_current) else null end
      );
    end if;
  end if;

  if v_current.id is not null then
    update public.deal_hunter_cim_requests as request
    set
      id = v_new.id,
      updated_at = v_new.updated_at,
      requested_by = v_new.requested_by,
      status = v_new.status,
      delivery_error = v_new.delivery_error,
      provider_message_id = v_new.provider_message_id,
      subject = v_new.subject,
      deal_name = v_new.deal_name,
      source_name = v_new.source_name,
      listing_url = v_new.listing_url,
      score = v_new.score,
      follow_up_count = v_new.follow_up_count,
      last_follow_up_at = v_new.last_follow_up_at,
      next_follow_up_at = v_new.next_follow_up_at,
      responded_at = v_new.responded_at,
      submission_id = coalesce(v_new.submission_id, request.submission_id),
      request_state = coalesce(v_new.request_state, request.request_state),
      delivery_state = coalesce(v_new.delivery_state, request.delivery_state),
      delivery_state_at = coalesce(v_new.delivery_state_at, request.delivery_state_at),
      follow_up_state = coalesce(v_new.follow_up_state, request.follow_up_state),
      first_requested_at = coalesce(request.first_requested_at, v_new.first_requested_at, request.created_at),
      first_provider_accepted_at = coalesce(request.first_provider_accepted_at, v_new.first_provider_accepted_at),
      delivered_at = coalesce(v_new.delivered_at, request.delivered_at),
      last_attempt_at = coalesce(v_new.last_attempt_at, request.last_attempt_at),
      last_delivery_event_at = coalesce(v_new.last_delivery_event_at, request.last_delivery_event_at),
      reply_to_address = coalesce(v_new.reply_to_address, request.reply_to_address),
      retry_of_request_id = coalesce(v_new.retry_of_request_id, request.retry_of_request_id),
      attempt_count = coalesce(v_new.attempt_count, request.attempt_count, 0),
      last_activity_at = coalesce(v_new.last_activity_at, v_new.updated_at, request.last_activity_at),
      metadata = coalesce(v_new.metadata, '{}'::jsonb)
    where request.deal_key = v_new.deal_key
      and lower(request.recipient_email) = v_new.recipient_email
      and (
        request.status = 'failed'
        or (
          request.status = 'pending'
          and p_pending_cutoff is not null
          and request.updated_at <= p_pending_cutoff
        )
      )
    returning request.* into v_current;

    if found then
      return jsonb_build_object('claimed', true, 'request', to_jsonb(v_current));
    end if;

    select *
    into v_current
    from public.deal_hunter_cim_requests as request
    where request.deal_key = v_new.deal_key
      and lower(request.recipient_email) = v_new.recipient_email
    limit 1;
    return jsonb_build_object('claimed', false, 'request', to_jsonb(v_current));
  end if;

  select *
  into v_blocking
  from public.deal_hunter_cim_requests as request
  where request.deal_key = v_new.deal_key
    and (v_new.retry_of_request_id is null or request.id <> v_new.retry_of_request_id)
    and (
      request.status in ('pending', 'sent', 'logged', 'responded', 'delivery_issue', 'follow_up_pending', 'follow_up_failed')
      or request.request_state in ('pending', 'provider_accepted', 'development_only', 'responded')
      or request.delivery_state in ('accepted', 'delivered', 'delayed', 'replied', 'development-only', 'bounced', 'complained', 'suppressed')
    )
  order by coalesce(request.first_requested_at, request.created_at), request.id
  limit 1;

  if v_blocking.id is not null then
    return jsonb_build_object('claimed', false, 'request', to_jsonb(v_blocking));
  end if;

  begin
    insert into public.deal_hunter_cim_requests
    select (v_new).*
    returning * into v_current;
  exception when unique_violation then
    select *
    into v_current
    from public.deal_hunter_cim_requests as request
    where request.deal_key = v_new.deal_key
      and lower(request.recipient_email) = v_new.recipient_email
    limit 1;
    return jsonb_build_object('claimed', false, 'request', case when v_current.id is not null then to_jsonb(v_current) else null end);
  end;

  return jsonb_build_object('claimed', true, 'request', to_jsonb(v_current));
end;
$$;

create or replace function public.claim_deal_hunter_cim_follow_up_request(
  p_request_id text,
  p_due_before timestamptz,
  p_stale_before timestamptz,
  p_claimed_at timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_probe public.deal_hunter_cim_requests%rowtype;
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
begin
  select *
  into v_probe
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id;

  if v_probe.id is null then
    return jsonb_build_object('claimed', false, 'reason', 'request-missing', 'request', null);
  end if;

  if v_probe.submission_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'submission-missing', 'request', to_jsonb(v_probe));
  end if;

  select *
  into v_submission
  from public.contact_submissions as submission
  where submission.id = v_probe.submission_id
  for update;

  if v_submission.id is null then
    return jsonb_build_object('claimed', false, 'reason', 'submission-missing', 'request', to_jsonb(v_probe));
  end if;

  if v_submission.status = 'archived' then
    return jsonb_build_object('claimed', false, 'reason', 'submission-archived', 'request', to_jsonb(v_probe));
  end if;

  select *
  into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;

  if v_current.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'claim-ineligible',
      'request', case when v_current.id is null then null else to_jsonb(v_current) end
    );
  end if;

  update public.deal_hunter_cim_requests as request
  set
    status = 'follow_up_pending',
    delivery_error = '',
    updated_at = p_claimed_at
  where request.id = p_request_id
    and request.next_follow_up_at is not null
    and request.next_follow_up_at <= p_due_before
    and (
      request.status in ('sent', 'logged', 'failed', 'follow_up_failed')
      or (
        request.status = 'follow_up_pending'
        and p_stale_before is not null
        and request.updated_at <= p_stale_before
      )
    )
  returning request.* into v_current;

  if found then
    return jsonb_build_object('claimed', true, 'reason', '', 'request', to_jsonb(v_current));
  end if;

  select *
  into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id;
  return jsonb_build_object('claimed', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current));
end;
$$;

create or replace function public.renew_deal_hunter_cim_request_claim(
  p_request_id text,
  p_expected_updated_at timestamptz,
  p_expected_status text,
  p_renewed_at timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_probe public.deal_hunter_cim_requests%rowtype;
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
begin
  select *
  into v_probe
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id;

  if v_probe.id is null then
    return jsonb_build_object('renewed', false, 'reason', 'request-missing', 'request', null);
  end if;

  if v_probe.submission_id is null then
    return jsonb_build_object('renewed', false, 'reason', 'submission-missing', 'request', to_jsonb(v_probe));
  end if;

  select *
  into v_submission
  from public.contact_submissions as submission
  where submission.id = v_probe.submission_id
  for update;

  if v_submission.id is null then
    return jsonb_build_object('renewed', false, 'reason', 'submission-missing', 'request', to_jsonb(v_probe));
  end if;

  if v_submission.status = 'archived' then
    return jsonb_build_object('renewed', false, 'reason', 'submission-archived', 'request', to_jsonb(v_probe));
  end if;

  select *
  into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;

  if v_current.id is null
    or v_current.submission_id is distinct from v_submission.id
    or p_expected_updated_at is null
    or nullif(btrim(p_expected_status), '') is null
    or p_renewed_at is null
    or v_current.updated_at is distinct from p_expected_updated_at
    or v_current.status is distinct from p_expected_status then
    return jsonb_build_object(
      'renewed', false,
      'reason', 'claim-ineligible',
      'request', case when v_current.id is null then null else to_jsonb(v_current) end
    );
  end if;

  update public.deal_hunter_cim_requests as request
  set
    updated_at = p_renewed_at
  where request.id = p_request_id
  returning request.* into v_current;

  return jsonb_build_object('renewed', true, 'reason', '', 'request', to_jsonb(v_current));
end;
$$;

create or replace function public.mutate_communications_with_crm_activity(
  p_operation text,
  p_payload jsonb,
  p_activity jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_record jsonb;
  v_disposition jsonb;
  v_activity jsonb;
  v_updates jsonb := coalesce(p_payload -> 'values', '{}'::jsonb);
  v_submission_id uuid;
  v_updated_at timestamptz;
  v_submission public.contact_submissions%rowtype;
  v_request public.deal_hunter_cim_requests%rowtype;
  v_current_request public.deal_hunter_cim_requests%rowtype;
begin
  if p_activity is null then
    raise exception 'CRM activity is required';
  end if;

  if p_operation = 'insert_crm_communication' then
    insert into public.crm_communications
    select * from jsonb_populate_record(null::public.crm_communications, p_payload -> 'communication')
    on conflict do nothing
    returning to_jsonb(crm_communications) into v_record;

    if v_record is null then
      select to_jsonb(communication)
      into v_record
      from public.crm_communications as communication
      where communication.id = p_payload #>> '{communication,id}'
        or (
          nullif(p_payload #>> '{communication,idempotency_key}', '') is not null
          and communication.idempotency_key = p_payload #>> '{communication,idempotency_key}'
        )
        or (
          nullif(p_payload #>> '{communication,provider}', '') is not null
          and nullif(p_payload #>> '{communication,source_event_id}', '') is not null
          and communication.provider = p_payload #>> '{communication,provider}'
          and communication.source_event_id = p_payload #>> '{communication,source_event_id}'
        )
        or (
          nullif(p_payload #>> '{communication,provider}', '') is not null
          and nullif(p_payload #>> '{communication,provider_message_id}', '') is not null
          and communication.provider = p_payload #>> '{communication,provider}'
          and communication.provider_message_id = p_payload #>> '{communication,provider_message_id}'
          and communication.direction = p_payload #>> '{communication,direction}'
        )
      order by communication.created_at, communication.id
      limit 1;
      return jsonb_build_object('applied', false, 'record', v_record, 'activity', null);
    end if;

    if nullif(v_record ->> 'submission_id', '') is not null then
      update public.email_events
      set
        submission_id = (v_record ->> 'submission_id')::uuid,
        communication_id = v_record ->> 'id'
      where communication_id = v_record ->> 'id'
        or (
          nullif(v_record ->> 'provider_message_id', '') is not null
          and provider = v_record ->> 'provider'
          and message_id = v_record ->> 'provider_message_id'
        );
    end if;

  elsif p_operation = 'assign_crm_communication' then
    v_submission_id := (p_payload ->> 'submissionId')::uuid;
    v_updated_at := coalesce(nullif(p_payload ->> 'updatedAt', '')::timestamptz, now());
    update public.crm_communications as communication
    set
      submission_id = v_submission_id,
      deal_key = coalesce(nullif(p_payload ->> 'dealKey', ''), communication.deal_key),
      cim_request_id = coalesce(nullif(p_payload ->> 'cimRequestId', ''), communication.cim_request_id),
      assigned_at = v_updated_at,
      assigned_by = coalesce(nullif(p_payload ->> 'assignedBy', ''), 'system'),
      updated_at = v_updated_at,
      updated_by = coalesce(nullif(p_payload ->> 'assignedBy', ''), 'system'),
      metadata = case when p_payload ? 'metadata' then coalesce(p_payload -> 'metadata', '{}'::jsonb) else communication.metadata end
    where communication.id = p_payload ->> 'id'
      and communication.submission_id is null
    returning to_jsonb(communication) into v_record;

    if v_record is null then
      select to_jsonb(communication)
      into v_record
      from public.crm_communications as communication
      where communication.id = p_payload ->> 'id';
      return jsonb_build_object('applied', false, 'record', v_record, 'activity', null);
    end if;

    update public.email_events
    set submission_id = v_submission_id, communication_id = p_payload ->> 'id'
    where communication_id = p_payload ->> 'id'
      or (
        nullif(v_record ->> 'provider_message_id', '') is not null
        and provider = v_record ->> 'provider'
        and message_id = v_record ->> 'provider_message_id'
      );

  elsif p_operation = 'archive_submission' then
    v_submission_id := coalesce(nullif(p_payload ->> 'id', ''), nullif(p_payload ->> 'submissionId', ''))::uuid;
    v_updated_at := coalesce(nullif(v_updates ->> 'updated_at', '')::timestamptz, now());
  select *
  into v_submission
  from public.contact_submissions as submission
  where submission.id = v_submission_id
  for update;

  if v_submission.id is null then
    return jsonb_build_object('applied', false, 'reason', 'submission-missing', 'record', null, 'activity', null);
  end if;

  if nullif(p_payload ->> 'expectedUpdatedAt', '') is null then
    return jsonb_build_object(
      'applied', false,
      'reason', 'missing-expected-version',
      'record', to_jsonb(v_submission),
      'activity', null
    );
  end if;

  if exists (
    select 1
    from public.deal_hunter_cim_requests as request
    where request.submission_id = v_submission_id
      and (
        (request.status = 'pending' and request.updated_at > v_updated_at - interval '10 minutes')
        or (request.status = 'follow_up_pending' and request.updated_at > v_updated_at - interval '30 minutes')
      )
  ) then
    return jsonb_build_object(
      'applied', false,
      'reason', 'cim-send-in-progress',
      'record', to_jsonb(v_submission),
      'activity', null
    );
  end if;

    update public.contact_submissions as submission
    set
      updated_at = v_updated_at,
      status = 'archived',
      status_updated_at = coalesce(nullif(v_updates ->> 'status_updated_at', '')::timestamptz, v_updated_at),
      follow_up_state = 'completed',
      next_action_at = null,
      archived_at = coalesce(nullif(v_updates ->> 'archived_at', '')::timestamptz, v_updated_at),
      archived_by = coalesce(nullif(v_updates ->> 'archived_by', ''), 'admin'),
      archive_reason = nullif(v_updates ->> 'archive_reason', ''),
      archive_note = nullif(v_updates ->> 'archive_note', ''),
      archive_communication_id = nullif(v_updates ->> 'archive_communication_id', ''),
      metadata = case when v_updates ? 'metadata' then v_updates -> 'metadata' else submission.metadata end
    where submission.id = v_submission_id
      and submission.updated_at = (p_payload ->> 'expectedUpdatedAt')::timestamptz
    returning to_jsonb(submission) into v_record;

    if v_record is null then
      select to_jsonb(submission)
      into v_record
      from public.contact_submissions as submission
      where submission.id = v_submission_id;
      return jsonb_build_object('applied', false, 'record', v_record, 'activity', null);
    end if;

    update public.deal_hunter_cim_requests
    set
      request_state = case when request_state = 'responded' then request_state else 'stopped' end,
      follow_up_state = case when request_state = 'responded' then 'completed' else 'stopped' end,
      next_follow_up_at = null,
      updated_at = v_updated_at,
      last_activity_at = v_updated_at
    where submission_id = v_submission_id;

  elsif p_operation = 'dismiss_deal_hunter_opportunity' then
    v_submission_id := (p_payload ->> 'submissionId')::uuid;
    v_updated_at := coalesce(nullif(v_updates ->> 'updated_at', '')::timestamptz, now());
  select *
  into v_submission
  from public.contact_submissions as submission
  where submission.id = v_submission_id
  for update;

  if v_submission.id is null then
    return jsonb_build_object(
      'applied', false,
      'reason', 'submission-missing',
      'record', jsonb_build_object('submission', null, 'disposition', null),
      'activity', null
    );
  end if;

  if nullif(p_payload ->> 'expectedUpdatedAt', '') is null then
    return jsonb_build_object(
      'applied', false,
      'reason', 'missing-expected-version',
      'record', jsonb_build_object('submission', to_jsonb(v_submission), 'disposition', null),
      'activity', null
    );
  end if;

  if exists (
    select 1
    from public.deal_hunter_cim_requests as request
    where request.submission_id = v_submission_id
      and (
        (request.status = 'pending' and request.updated_at > v_updated_at - interval '10 minutes')
        or (request.status = 'follow_up_pending' and request.updated_at > v_updated_at - interval '30 minutes')
      )
  ) then
    return jsonb_build_object(
      'applied', false,
      'reason', 'cim-send-in-progress',
      'record', jsonb_build_object('submission', to_jsonb(v_submission), 'disposition', null),
      'activity', null
    );
  end if;

    update public.contact_submissions as submission
    set
      updated_at = v_updated_at,
      status = 'archived',
      status_updated_at = coalesce(nullif(v_updates ->> 'status_updated_at', '')::timestamptz, v_updated_at),
      follow_up_state = 'completed',
      next_action_at = null,
      archived_at = coalesce(nullif(v_updates ->> 'archived_at', '')::timestamptz, v_updated_at),
      archived_by = coalesce(nullif(v_updates ->> 'archived_by', ''), 'admin'),
      archive_reason = nullif(v_updates ->> 'archive_reason', ''),
      archive_note = nullif(v_updates ->> 'archive_note', ''),
      archive_communication_id = nullif(v_updates ->> 'archive_communication_id', ''),
      metadata = case when v_updates ? 'metadata' then v_updates -> 'metadata' else submission.metadata end
    where submission.id = v_submission_id
      and submission.updated_at = (p_payload ->> 'expectedUpdatedAt')::timestamptz
    returning to_jsonb(submission) into v_record;

    if v_record is null then
      select jsonb_build_object('submission', to_jsonb(submission), 'disposition', null)
      into v_record
      from public.contact_submissions as submission
      where submission.id = v_submission_id;
      return jsonb_build_object('applied', false, 'record', v_record, 'activity', null);
    end if;

    update public.deal_hunter_cim_requests
    set
      request_state = case when request_state = 'responded' then request_state else 'stopped' end,
      follow_up_state = case when request_state = 'responded' then 'completed' else 'stopped' end,
      next_follow_up_at = null,
      updated_at = v_updated_at,
      last_activity_at = v_updated_at
    where submission_id = v_submission_id;

    insert into public.deal_hunter_dispositions as disposition
    select *
    from jsonb_populate_record(
      null::public.deal_hunter_dispositions,
      coalesce(p_payload -> 'disposition', '{}'::jsonb) || jsonb_build_object('submission_id', v_submission_id)
    )
    on conflict (deal_key) do update set
      submission_id = excluded.submission_id,
      communication_id = excluded.communication_id,
      listing_url = coalesce(excluded.listing_url, disposition.listing_url),
      deal_name = coalesce(excluded.deal_name, disposition.deal_name),
      updated_at = excluded.updated_at,
      disposition = excluded.disposition,
      reason = excluded.reason,
      note = excluded.note,
      dismissed_at = coalesce(excluded.dismissed_at, disposition.dismissed_at),
      dismissed_by = coalesce(excluded.dismissed_by, disposition.dismissed_by),
      restored_at = excluded.restored_at,
      restored_by = excluded.restored_by,
      updated_by = excluded.updated_by,
      metadata = excluded.metadata
    returning to_jsonb(disposition) into v_disposition;

    v_record := jsonb_build_object('submission', v_record, 'disposition', v_disposition);

  elsif p_operation = 'update_submission' then
    if exists (
      select 1
      from jsonb_object_keys(v_updates) as update_key(key)
      where update_key.key <> all(array[
        'updated_at', 'status', 'status_updated_at', 'follow_up_state', 'next_action_at',
        'archived_at', 'archived_by', 'archive_reason', 'archive_note',
        'archive_communication_id', 'restored_at', 'restored_by'
      ])
    ) then
      raise exception 'Unsupported lifecycle submission update field';
    end if;

    v_submission_id := (p_payload ->> 'id')::uuid;
    update public.contact_submissions as submission
    set
      updated_at = case when v_updates ? 'updated_at' then (v_updates ->> 'updated_at')::timestamptz else submission.updated_at end,
      status = case when v_updates ? 'status' then v_updates ->> 'status' else submission.status end,
      status_updated_at = case when v_updates ? 'status_updated_at' then nullif(v_updates ->> 'status_updated_at', '')::timestamptz else submission.status_updated_at end,
      follow_up_state = case when v_updates ? 'follow_up_state' then v_updates ->> 'follow_up_state' else submission.follow_up_state end,
      next_action_at = case when v_updates ? 'next_action_at' then nullif(v_updates ->> 'next_action_at', '')::timestamptz else submission.next_action_at end,
      archived_at = case when v_updates ? 'archived_at' then nullif(v_updates ->> 'archived_at', '')::timestamptz else submission.archived_at end,
      archived_by = case when v_updates ? 'archived_by' then nullif(v_updates ->> 'archived_by', '') else submission.archived_by end,
      archive_reason = case when v_updates ? 'archive_reason' then nullif(v_updates ->> 'archive_reason', '') else submission.archive_reason end,
      archive_note = case when v_updates ? 'archive_note' then nullif(v_updates ->> 'archive_note', '') else submission.archive_note end,
      archive_communication_id = case when v_updates ? 'archive_communication_id' then nullif(v_updates ->> 'archive_communication_id', '') else submission.archive_communication_id end,
      restored_at = case when v_updates ? 'restored_at' then nullif(v_updates ->> 'restored_at', '')::timestamptz else submission.restored_at end,
      restored_by = case when v_updates ? 'restored_by' then nullif(v_updates ->> 'restored_by', '') else submission.restored_by end
    where submission.id = v_submission_id
      and (
        nullif(p_payload ->> 'expectedUpdatedAt', '') is null
        or submission.updated_at = (p_payload ->> 'expectedUpdatedAt')::timestamptz
      )
    returning to_jsonb(submission) into v_record;

    if v_record is null then
      select to_jsonb(submission)
      into v_record
      from public.contact_submissions as submission
      where submission.id = v_submission_id;
      return jsonb_build_object('applied', false, 'record', v_record, 'activity', null);
    end if;

  elsif p_operation in ('upsert_deal_hunter_cim_request', 'finalize_deal_hunter_cim_request_claim') then
    select *
    into v_request
    from jsonb_populate_record(null::public.deal_hunter_cim_requests, p_payload -> 'request');
    v_submission_id := v_request.submission_id;

    if v_submission_id is null and p_operation = 'finalize_deal_hunter_cim_request_claim' then
      return jsonb_build_object(
        'applied', false,
        'reason', 'submission-missing',
        'record', null,
        'activity', null
      );
    end if;

    if v_submission_id is not null then
      select *
      into v_submission
      from public.contact_submissions as submission
      where submission.id = v_submission_id
      for update;

      if p_operation = 'upsert_deal_hunter_cim_request'
        and p_payload ->> 'preserveStoppedOutreach' = 'true' then
        select *
        into v_current_request
        from public.deal_hunter_cim_requests as request
        where request.id = v_request.id
        for update;

        if v_current_request.id is not null and v_current_request.request_state = 'responded' then
          v_request.status := 'responded';
          v_request.request_state := 'responded';
          v_request.follow_up_state := case
            when v_current_request.follow_up_state in ('stopped', 'completed')
              then v_current_request.follow_up_state
            else 'completed'
          end;
          v_request.next_follow_up_at := null;
        elsif v_current_request.id is not null and (
          v_submission.status = 'archived'
          or v_current_request.request_state = 'stopped'
          or v_current_request.follow_up_state = 'stopped'
        ) then
          v_request.status := v_current_request.status;
          v_request.request_state := 'stopped';
          v_request.follow_up_state := 'stopped';
          v_request.next_follow_up_at := null;
        end if;
      end if;

      if v_submission.id is null or (
        v_submission.status = 'archived'
        and not (
          p_operation = 'upsert_deal_hunter_cim_request'
          and (
            (v_request.status = 'responded' and v_request.request_state = 'responded')
            or (
              p_payload ->> 'preserveStoppedOutreach' = 'true'
              and v_request.request_state = 'stopped'
            )
          )
          and v_request.follow_up_state in ('stopped', 'completed')
          and v_request.next_follow_up_at is null
        )
      ) then
        return jsonb_build_object(
          'applied', false,
          'reason', case when v_submission.id is null then 'submission-missing' else 'submission-archived' end,
          'record', null,
          'activity', null
        );
      end if;
    end if;

    if p_operation = 'finalize_deal_hunter_cim_request_claim' then
      select *
      into v_current_request
      from public.deal_hunter_cim_requests as request
      where request.id = v_request.id
      for update;

      if v_current_request.id is null
        or nullif(p_payload ->> 'expectedUpdatedAt', '') is null
        or v_current_request.updated_at is distinct from (p_payload ->> 'expectedUpdatedAt')::timestamptz
        or v_current_request.submission_id is distinct from v_submission_id
        or v_current_request.deal_key is distinct from v_request.deal_key
        or lower(v_current_request.recipient_email) is distinct from lower(v_request.recipient_email)
        or not exists (
          select 1
          from jsonb_array_elements_text(coalesce(p_payload -> 'expectedStatuses', '[]'::jsonb)) as expected(status)
          where expected.status = v_current_request.status
        ) then
        return jsonb_build_object(
          'applied', false,
          'reason', 'claim-ineligible',
          'record', case when v_current_request.id is null then null else to_jsonb(v_current_request) end,
          'activity', null
        );
      end if;
    end if;

    insert into public.deal_hunter_cim_requests
    select (v_request).*
    on conflict (deal_key, recipient_email) do update set
      updated_at = excluded.updated_at,
      requested_by = excluded.requested_by,
      status = excluded.status,
      delivery_error = excluded.delivery_error,
      provider_message_id = excluded.provider_message_id,
      subject = excluded.subject,
      deal_name = excluded.deal_name,
      source_name = excluded.source_name,
      listing_url = excluded.listing_url,
      score = excluded.score,
      follow_up_count = excluded.follow_up_count,
      last_follow_up_at = excluded.last_follow_up_at,
      next_follow_up_at = excluded.next_follow_up_at,
      responded_at = excluded.responded_at,
      submission_id = coalesce(excluded.submission_id, deal_hunter_cim_requests.submission_id),
      request_state = coalesce(excluded.request_state, deal_hunter_cim_requests.request_state),
      delivery_state = coalesce(excluded.delivery_state, deal_hunter_cim_requests.delivery_state),
      delivery_state_at = coalesce(excluded.delivery_state_at, deal_hunter_cim_requests.delivery_state_at),
      follow_up_state = coalesce(excluded.follow_up_state, deal_hunter_cim_requests.follow_up_state),
      first_requested_at = coalesce(deal_hunter_cim_requests.first_requested_at, excluded.first_requested_at, excluded.created_at),
      first_provider_accepted_at = coalesce(deal_hunter_cim_requests.first_provider_accepted_at, excluded.first_provider_accepted_at),
      delivered_at = coalesce(excluded.delivered_at, deal_hunter_cim_requests.delivered_at),
      last_attempt_at = coalesce(excluded.last_attempt_at, deal_hunter_cim_requests.last_attempt_at),
      last_delivery_event_at = coalesce(excluded.last_delivery_event_at, deal_hunter_cim_requests.last_delivery_event_at),
      reply_to_address = coalesce(excluded.reply_to_address, deal_hunter_cim_requests.reply_to_address),
      retry_of_request_id = coalesce(excluded.retry_of_request_id, deal_hunter_cim_requests.retry_of_request_id),
      attempt_count = coalesce(excluded.attempt_count, deal_hunter_cim_requests.attempt_count, 0),
      last_activity_at = coalesce(excluded.last_activity_at, excluded.updated_at, deal_hunter_cim_requests.last_activity_at),
      metadata = excluded.metadata
    returning to_jsonb(deal_hunter_cim_requests) into v_record;

  else
    raise exception 'Unsupported atomic communications operation: %', coalesce(p_operation, 'unknown');
  end if;

  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;

  return jsonb_build_object('applied', true, 'record', v_record, 'activity', v_activity);
end;
$$;

revoke all on function public.mutate_communications_with_crm_activity(text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.mutate_communications_with_crm_activity(text, jsonb, jsonb)
  to service_role;

create or replace function public.list_deal_hunter_cim_request_history(
  p_page integer default 1,
  p_page_size integer default 25,
  p_search text default '',
  p_request_states text[] default '{}'::text[],
  p_delivery_states text[] default '{}'::text[],
  p_statuses text[] default '{}'::text[],
  p_reply_state text default '',
  p_follow_up_state text default '',
  p_sort text default 'last-activity',
  p_direction text default 'desc'
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select request.*
    from public.deal_hunter_cim_requests as request
    where nullif(btrim(p_search), '') is null
      or request.deal_name ilike '%' || btrim(p_search) || '%'
      or request.recipient_email ilike '%' || btrim(p_search) || '%'
      or request.subject ilike '%' || btrim(p_search) || '%'
      or request.listing_url ilike '%' || btrim(p_search) || '%'
      or request.deal_key ilike '%' || btrim(p_search) || '%'
  ),
  filtered as (
    select request.*
    from base as request
    where (coalesce(array_length(p_request_states, 1), 0) = 0 or request.request_state = any(p_request_states))
      and (coalesce(array_length(p_delivery_states, 1), 0) = 0 or request.delivery_state = any(p_delivery_states))
      and (coalesce(array_length(p_statuses, 1), 0) = 0 or request.status = any(p_statuses))
      and (
        nullif(p_reply_state, '') is null
        or (p_reply_state = 'replied' and (request.request_state = 'responded' or request.responded_at is not null))
        or (p_reply_state = 'awaiting' and coalesce(request.request_state, '') <> 'responded' and request.responded_at is null)
      )
      and (nullif(p_follow_up_state, '') is null or request.follow_up_state = p_follow_up_state)
  ),
  ordered as (
    select
      request.*,
      row_number() over (
        order by
          case when p_sort = 'failure' and request.delivery_state in ('delayed', 'bounced', 'failed', 'complained', 'suppressed') then 0
               when p_sort = 'failure' then 1 end asc nulls last,
          case when p_sort = 'first-request' and p_direction = 'asc' then coalesce(request.first_requested_at, request.created_at) end asc,
          case when p_sort = 'first-request' and p_direction <> 'asc' then coalesce(request.first_requested_at, request.created_at) end desc,
          case when p_sort = 'last-activity' and p_direction = 'asc' then coalesce(request.last_activity_at, request.updated_at, request.created_at) end asc,
          case when p_sort = 'last-activity' and p_direction <> 'asc' then coalesce(request.last_activity_at, request.updated_at, request.created_at) end desc,
          case when p_sort = 'failure' and p_direction = 'asc' then coalesce(request.last_delivery_event_at, request.updated_at) end asc,
          case when p_sort = 'failure' and p_direction <> 'asc' then coalesce(request.last_delivery_event_at, request.updated_at) end desc,
          case when p_direction = 'asc' then request.id end asc,
          case when p_direction <> 'asc' then request.id end desc
      ) as ordinal
    from filtered as request
  ),
  paged as (
    select *
    from ordered
    where ordinal > (least(greatest(coalesce(p_page, 1), 1), 10000) - 1) * greatest(1, least(coalesce(p_page_size, 25), 100))
      and ordinal <= least(greatest(coalesce(p_page, 1), 1), 10000) * greatest(1, least(coalesce(p_page_size, 25), 100))
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(paged) - 'ordinal' order by ordinal) from paged), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'page', least(greatest(coalesce(p_page, 1), 1), 10000),
    'pageSize', greatest(1, least(coalesce(p_page_size, 25), 100)),
    'counts', jsonb_build_object(
      'ready', (select count(*) from base where request_state = 'ready'),
      'pending', (select count(*) from base where request_state = 'pending'),
      'accepted', (select count(*) from base where request_state = 'provider_accepted'),
      'delivered', (select count(*) from base where delivery_state = 'delivered'),
      'deliveryIssue', (select count(*) from base where delivery_state in ('delayed', 'bounced', 'failed', 'complained', 'suppressed')),
      'replied', (select count(*) from base where request_state = 'responded' or responded_at is not null)
    )
  );
$$;

revoke all on function public.list_deal_hunter_cim_request_history(integer, integer, text, text[], text[], text[], text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.list_deal_hunter_cim_request_history(integer, integer, text, text[], text[], text[], text, text, text, text)
  to service_role;
revoke all on function public.canonical_listing_identity(text)
  from public, anon, authenticated;
grant execute on function public.canonical_listing_identity(text)
  to service_role;
revoke all on function public.delete_crm_submission_lifecycle(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.delete_crm_submission_lifecycle(uuid, timestamptz)
  to service_role;
revoke all on function public.claim_crm_communications_pending_ingestion(timestamptz, timestamptz, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_crm_communications_pending_ingestion(timestamptz, timestamptz, integer, text)
  to service_role;
revoke all on function public.claim_deal_hunter_cim_request(jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_deal_hunter_cim_request(jsonb, timestamptz)
  to service_role;
revoke all on function public.claim_deal_hunter_cim_follow_up_request(text, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_deal_hunter_cim_follow_up_request(text, timestamptz, timestamptz, timestamptz)
  to service_role;
revoke all on function public.renew_deal_hunter_cim_request_claim(text, timestamptz, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.renew_deal_hunter_cim_request_claim(text, timestamptz, text, timestamptz)
  to service_role;

create or replace function public.list_submissions_page(
  p_limit integer default 50,
  p_page integer default 1,
  p_search text default '',
  p_status text default '',
  p_created_after text default '',
  p_sort text default 'created_at',
  p_direction text default 'desc'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 5000));
  v_offset bigint := greatest(0, coalesce(p_page, 1) - 1)::bigint
    * greatest(1, least(coalesce(p_limit, 50), 5000))::bigint;
  v_direction text := case when lower(p_direction) = 'asc' then 'asc' else 'desc' end;
  v_order text;
  v_result jsonb;
begin
  v_order := case p_sort
    when 'updated_at' then format('updated_at %s', v_direction)
    when 'company' then format('lower(coalesce(company, name, '''')) %s', v_direction)
    when 'next_action_at' then format('case when next_action_at is null then 1 else 0 end asc, next_action_at %s', v_direction)
    when 'priority' then format(
      'case priority when ''urgent'' then 5 when ''high'' then 4 when ''medium'' then 3 when ''normal'' then 2 when ''low'' then 1 else 0 end %s',
      v_direction
    )
    when 'deal_score' then format(
      'case when metadata #>> ''{dealHunter,score}'' ~ ''^[0-9]+([.][0-9]+)?$'' then (metadata #>> ''{dealHunter,score}'')::numeric end %s nulls last',
      v_direction
    )
    when 'listing_date' then format(
      'coalesce(nullif(metadata #>> ''{dealHunter,dateAdded}'', ''''), nullif(metadata #>> ''{dealHunter,firstSeenAt}'', '''')) %s nulls last',
      v_direction
    )
    when 'status' then format('status %s', v_direction)
    else format('created_at %s', v_direction)
  end;

  execute format($query$
    with filtered as (
      select *
      from public.contact_submissions
      where ($1 = '' or status = $1)
        and (
          $2 = ''
          or position(lower($2) in lower(concat_ws(' ',
            name, email, company, message, notes, listing_url, business_website,
            prospectus_url, broker_name, broker_email, seller_name, seller_email
          ))) > 0
        )
        and ($3 = '' or created_at >= $3::timestamptz)
    ),
    paged as (
      select filtered.*, row_number() over (order by %s, created_at desc, id asc) as page_position
      from filtered
      order by %s, created_at desc, id asc
      limit $4 offset $5
    )
    select jsonb_build_object(
      'rows', coalesce(
        (select jsonb_agg(to_jsonb(paged) - 'page_position' order by page_position) from paged),
        '[]'::jsonb
      ),
      'total', (select count(*) from filtered)
    )
  $query$, v_order, v_order)
  into v_result
  using coalesce(p_status, ''), trim(coalesce(p_search, '')), trim(coalesce(p_created_after, '')), v_limit, v_offset;

  return v_result;
end;
$$;

revoke all on function public.list_submissions_page(integer, integer, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.list_submissions_page(integer, integer, text, text, text, text, text) to service_role;

create or replace function public.claim_secure_document_cleanup_job(
  p_id uuid,
  p_lease_duration_ms bigint,
  p_lease_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job jsonb;
  v_claimed_at timestamptz := clock_timestamp();
begin
  if p_lease_duration_ms is null or p_lease_duration_ms <= 0 or p_lease_duration_ms > 86400000 then
    raise exception 'Cleanup-job lease duration must be between 1 millisecond and 24 hours.';
  end if;
  if p_lease_token is null or p_lease_token !~ '^[A-Za-z0-9_-]{16,200}$' then
    raise exception 'Cleanup-job lease token is invalid.';
  end if;

  update public.secure_document_cleanup_jobs as cleanup_job
  set
    updated_at = v_claimed_at,
    lease_claimed_at = v_claimed_at,
    lease_expires_at = v_claimed_at + (p_lease_duration_ms * interval '1 millisecond'),
    lease_token = p_lease_token
  where cleanup_job.id = p_id
    and cleanup_job.status in (
      'staging',
      'pending-purge',
      'cleanup-pending',
      'reconciliation-pending',
      'cleanup-failed',
      'restore-failed'
    )
    and (
      cleanup_job.lease_expires_at is null
      or cleanup_job.lease_expires_at <= v_claimed_at
    )
  returning to_jsonb(cleanup_job) into v_job;

  return v_job;
end;
$$;

revoke all on function public.claim_secure_document_cleanup_job(uuid, bigint, text)
  from public, anon, authenticated;
grant execute on function public.claim_secure_document_cleanup_job(uuid, bigint, text)
  to service_role;

create or replace function public.renew_secure_document_cleanup_job_lease(
  p_id uuid,
  p_lease_token text,
  p_lease_duration_ms bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job jsonb;
  v_renewed_at timestamptz := clock_timestamp();
begin
  if p_lease_duration_ms is null or p_lease_duration_ms <= 0 or p_lease_duration_ms > 86400000 then
    raise exception 'Cleanup-job lease duration must be between 1 millisecond and 24 hours.';
  end if;
  if p_lease_token is null or p_lease_token !~ '^[A-Za-z0-9_-]{16,200}$' then
    raise exception 'Cleanup-job lease token is invalid.';
  end if;

  update public.secure_document_cleanup_jobs as cleanup_job
  set
    updated_at = v_renewed_at,
    lease_expires_at = v_renewed_at + (p_lease_duration_ms * interval '1 millisecond')
  where cleanup_job.id = p_id
    and cleanup_job.lease_token = p_lease_token
    and cleanup_job.lease_expires_at > v_renewed_at
  returning to_jsonb(cleanup_job) into v_job;

  return v_job;
end;
$$;

revoke all on function public.renew_secure_document_cleanup_job_lease(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.renew_secure_document_cleanup_job_lease(uuid, text, bigint)
  to service_role;

create or replace function public.update_secure_document_cleanup_job_if_leased(
  p_id uuid,
  p_lease_token text,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job jsonb;
  v_unsupported_field text;
  v_checked_at timestamptz := clock_timestamp();
begin
  if p_lease_token is null or p_lease_token !~ '^[A-Za-z0-9_-]{16,200}$' then
    raise exception 'Cleanup-job lease token is invalid.';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' or p_values = '{}'::jsonb then
    raise exception 'Cleanup-job lease update values must be a non-empty object.';
  end if;

  select field
  into v_unsupported_field
  from jsonb_object_keys(p_values) as field
  where field not in (
    'updated_at', 'completed_at', 'status', 'trash_directory', 'files',
    'attempt_count', 'last_error', 'metadata', 'lease_claimed_at',
    'lease_expires_at', 'lease_token'
  )
  limit 1;
  if v_unsupported_field is not null then
    raise exception 'Unsupported cleanup-job lease update field: %', v_unsupported_field;
  end if;
  if p_values ? 'lease_token' and p_values -> 'lease_token' <> 'null'::jsonb then
    raise exception 'A cleanup-job lease update may only clear its lease token.';
  end if;

  if p_values ? 'lease_token' then
    p_values := p_values || jsonb_build_object(
      'lease_claimed_at', null,
      'lease_expires_at', null,
      'lease_token', null
    );
  end if;

  update public.secure_document_cleanup_jobs as cleanup_job
  set
    updated_at = case when p_values ? 'updated_at' then (p_values ->> 'updated_at')::timestamptz else updated_at end,
    completed_at = case when p_values ? 'completed_at' then (p_values ->> 'completed_at')::timestamptz else completed_at end,
    status = case when p_values ? 'status' then p_values ->> 'status' else status end,
    trash_directory = case when p_values ? 'trash_directory' then p_values ->> 'trash_directory' else trash_directory end,
    files = case when p_values ? 'files' then p_values -> 'files' else files end,
    attempt_count = case when p_values ? 'attempt_count' then (p_values ->> 'attempt_count')::integer else attempt_count end,
    last_error = case when p_values ? 'last_error' then p_values ->> 'last_error' else last_error end,
    metadata = case when p_values ? 'metadata' then p_values -> 'metadata' else metadata end,
    lease_claimed_at = case when p_values ? 'lease_claimed_at' then (p_values ->> 'lease_claimed_at')::timestamptz else lease_claimed_at end,
    lease_expires_at = case when p_values ? 'lease_expires_at' then (p_values ->> 'lease_expires_at')::timestamptz else lease_expires_at end,
    lease_token = case when p_values ? 'lease_token' then p_values ->> 'lease_token' else lease_token end
  where cleanup_job.id = p_id
    and cleanup_job.lease_token = p_lease_token
    and cleanup_job.lease_expires_at > v_checked_at
  returning to_jsonb(cleanup_job) into v_job;

  return v_job;
end;
$$;

revoke all on function public.update_secure_document_cleanup_job_if_leased(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_secure_document_cleanup_job_if_leased(uuid, text, jsonb)
  to service_role;

-- Supabase exposes the public schema through its Data API. This application
-- accesses these tables only from the server with the service-role credential,
-- so direct anon/authenticated table access is intentionally disabled.
alter table public.contact_submissions enable row level security;
alter table public.contact_rate_limit_events enable row level security;
alter table public.analytics_events enable row level security;
alter table public.secure_upload_requests enable row level security;
alter table public.secure_documents enable row level security;
alter table public.email_events enable row level security;
alter table public.crm_activity_events enable row level security;
alter table public.crm_communications enable row level security;
alter table public.crm_email_outbox enable row level security;
alter table public.crm_follow_up_recommendations enable row level security;
alter table public.email_suppressions enable row level security;
alter table public.deal_hunter_seen_deals enable row level security;
alter table public.deal_hunter_deal_os_imports enable row level security;
alter table public.deal_hunter_cim_requests enable row level security;
alter table public.deal_hunter_cim_reviews enable row level security;
alter table public.deal_hunter_automation_settings enable row level security;
alter table public.deal_hunter_crm_imports enable row level security;
alter table public.deal_hunter_dispositions enable row level security;
alter table public.scheduled_job_runs enable row level security;
alter table public.admin_audit_events enable row level security;
alter table public.secure_document_cleanup_jobs enable row level security;
alter table public.source_health_snapshots enable row level security;
alter table public.admin_magic_links enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.admin_onboarding_progress enable row level security;

revoke all privileges on all tables in schema public from public, anon, authenticated;
revoke all privileges on all sequences in schema public from public, anon, authenticated;

grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

alter default privileges in schema public
  revoke all privileges on tables from public, anon, authenticated;
alter default privileges in schema public
  revoke all privileges on sequences from public, anon, authenticated;
alter default privileges in schema public
  revoke all privileges on functions from public, anon, authenticated;
alter default privileges in schema public
  grant all privileges on tables to service_role;
alter default privileges in schema public
  grant all privileges on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;

create or replace function public.supersede_crm_follow_up_recommendations_from_related_change()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_record jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_submission_id uuid := case
    when tg_table_name = 'contact_submissions' then nullif(v_record ->> 'id', '')::uuid
    else nullif(v_record ->> 'submission_id', '')::uuid
  end;
  v_changed_at timestamptz := coalesce(
    nullif(v_record ->> 'updated_at', '')::timestamptz,
    nullif(v_record ->> 'created_at', '')::timestamptz,
    now()
  );
begin
  if v_submission_id is not null then
    update public.crm_follow_up_recommendations
    set status = 'superseded', superseded_at = v_changed_at
    where submission_id = v_submission_id and status = 'current';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_deal_hunter_cim_supersede_follow_up_recommendation on public.deal_hunter_cim_requests;
create trigger trg_deal_hunter_cim_supersede_follow_up_recommendation
after insert or update or delete on public.deal_hunter_cim_requests
for each row execute function public.supersede_crm_follow_up_recommendations_from_related_change();

drop trigger if exists trg_crm_communication_supersede_follow_up_recommendation on public.crm_communications;
create trigger trg_crm_communication_supersede_follow_up_recommendation
after insert or update or delete on public.crm_communications
for each row execute function public.supersede_crm_follow_up_recommendations_from_related_change();

drop trigger if exists trg_contact_submission_supersede_follow_up_recommendation on public.contact_submissions;
create trigger trg_contact_submission_supersede_follow_up_recommendation
after update on public.contact_submissions
for each row execute function public.supersede_crm_follow_up_recommendations_from_related_change();

drop trigger if exists trg_secure_document_supersede_follow_up_recommendation on public.secure_documents;
create trigger trg_secure_document_supersede_follow_up_recommendation
after insert or update or delete on public.secure_documents
for each row execute function public.supersede_crm_follow_up_recommendations_from_related_change();

revoke all on function public.supersede_crm_follow_up_recommendations_from_related_change() from public, anon, authenticated;
grant execute on function public.supersede_crm_follow_up_recommendations_from_related_change() to service_role;

create or replace function public.create_crm_email_command(
  p_communication jsonb,
  p_outbox jsonb,
  p_activity jsonb,
  p_expected_submission_version timestamptz,
  p_manual_takeover_cim_request_id text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_submission public.contact_submissions%rowtype;
  v_communication public.crm_communications%rowtype;
  v_outbox public.crm_email_outbox%rowtype;
  v_existing public.crm_email_outbox%rowtype;
  v_cim_request public.deal_hunter_cim_requests%rowtype;
begin
  select * into v_existing from public.crm_email_outbox
  where client_request_key = p_outbox ->> 'client_request_key' limit 1;
  if found then
    select * into v_communication from public.crm_communications where id = v_existing.communication_id;
    select * into v_submission from public.contact_submissions where id = v_existing.submission_id;
    return jsonb_build_object(
      'applied', false, 'reason', 'duplicate-client-request',
      'communication', to_jsonb(v_communication), 'outbox', to_jsonb(v_existing),
      'submission', to_jsonb(v_submission)
    );
  end if;

  select * into v_submission from public.contact_submissions
  where id = (p_outbox ->> 'submission_id')::uuid for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'submission-not-found'); end if;
  if p_expected_submission_version is null or v_submission.updated_at is distinct from p_expected_submission_version then
    return jsonb_build_object('applied', false, 'reason', 'stale-submission', 'submission', to_jsonb(v_submission));
  end if;
  if lower(coalesce(v_submission.status, '')) in ('archived', 'spam') then
    return jsonb_build_object(
      'applied', false, 'reason', 'submission-' || lower(v_submission.status),
      'submission', to_jsonb(v_submission)
    );
  end if;

  if nullif(btrim(coalesce(p_manual_takeover_cim_request_id, '')), '') is not null then
    select * into v_cim_request from public.deal_hunter_cim_requests
    where id = p_manual_takeover_cim_request_id and submission_id = v_submission.id for update;
    if not found then
      return jsonb_build_object('applied', false, 'reason', 'cim-request-not-found', 'submission', to_jsonb(v_submission));
    end if;
    if v_cim_request.status in ('pending', 'follow_up_pending') then
      return jsonb_build_object('applied', false, 'reason', 'cim-send-in-progress', 'submission', to_jsonb(v_submission));
    end if;
  end if;

  -- Record the reviewed recommendation decision before a manual takeover
  -- mutates the linked CIM row and its invalidation trigger runs.
  update public.crm_follow_up_recommendations
  set
    status = case
      when p_outbox #>> '{metadata,recommendationDecision}' = 'accepted' then 'accepted'
      when p_outbox #>> '{metadata,recommendationDecision}' = 'edited_and_accepted' then 'edited_and_accepted'
      when coalesce(draft_subject, '') = coalesce(p_communication ->> 'subject', '')
        and coalesce(draft_body_text, '') = coalesce(p_communication ->> 'body_text', '')
      then 'accepted'
      else 'edited_and_accepted'
    end,
    acted_on_at = (p_outbox ->> 'created_at')::timestamptz,
    acted_on_by = p_outbox ->> 'actor',
    outcome = 'email-command-created'
  where id = nullif(p_communication ->> 'recommendation_id', '')
    and submission_id = (p_outbox ->> 'submission_id')::uuid
    and status = 'current';

  if nullif(btrim(coalesce(p_manual_takeover_cim_request_id, '')), '') is not null then
    update public.deal_hunter_cim_requests set
      request_state = 'manual_takeover', follow_up_state = 'stopped', next_follow_up_at = null,
      follow_up_count = follow_up_count + 1, updated_at = (p_outbox ->> 'created_at')::timestamptz,
      last_activity_at = (p_outbox ->> 'created_at')::timestamptz,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'manualTakeoverAt', p_outbox ->> 'created_at', 'manualTakeoverBy', p_outbox ->> 'actor'
      )
    where id = v_cim_request.id;
  end if;

  insert into public.crm_communications
  select * from jsonb_populate_record(null::public.crm_communications, p_communication)
  returning * into v_communication;
  insert into public.crm_email_outbox
  select * from jsonb_populate_record(null::public.crm_email_outbox, p_outbox)
  returning * into v_outbox;

  update public.crm_follow_up_recommendations
  set status = 'superseded', superseded_at = (p_outbox ->> 'created_at')::timestamptz
  where submission_id = (p_outbox ->> 'submission_id')::uuid
    and status = 'current';

  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity);

  update public.contact_submissions set updated_at = (p_outbox ->> 'created_at')::timestamptz
  where id = v_submission.id and updated_at = p_expected_submission_version returning * into v_submission;
  if not found then
    raise exception 'The CRM record changed while the email command was being created.' using errcode = '40001';
  end if;
  return jsonb_build_object(
    'applied', true, 'reason', '', 'communication', to_jsonb(v_communication),
    'outbox', to_jsonb(v_outbox), 'submission', to_jsonb(v_submission)
  );
end;
$$;

create or replace function public.claim_crm_email_outbox(
  p_id text,
  p_claim_token text,
  p_claimed_at timestamptz,
  p_claim_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare v_outbox public.crm_email_outbox%rowtype;
begin
  if nullif(btrim(coalesce(p_claim_token, '')), '') is null
     or p_claimed_at is null or p_claim_expires_at is null or p_claim_expires_at <= p_claimed_at then
    raise exception 'A valid outbox claim token and future lease expiry are required.';
  end if;
  update public.crm_email_outbox set
    state = 'sending', attempt_count = attempt_count + 1, claim_token = p_claim_token,
    claimed_at = p_claimed_at, claim_expires_at = p_claim_expires_at, updated_at = p_claimed_at
  where id = p_id and (
    state = 'queued'
    or (state = 'retryable_failed' and (next_attempt_at is null or next_attempt_at <= p_claimed_at))
    or (state = 'sending' and claim_expires_at is not null and claim_expires_at <= p_claimed_at)
  ) returning * into v_outbox;
  if found then return jsonb_build_object('claimed', true, 'outbox', to_jsonb(v_outbox)); end if;
  select * into v_outbox from public.crm_email_outbox where id = p_id;
  return jsonb_build_object('claimed', false, 'outbox', to_jsonb(v_outbox));
end;
$$;

create or replace function public.finish_crm_email_outbox_claim(
  p_id text,
  p_claim_token text,
  p_values jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_outbox public.crm_email_outbox%rowtype;
  v_state text := p_values ->> 'state';
begin
  if v_state not in ('accepted', 'ambiguous', 'retryable_failed', 'permanent_failed', 'cancelled') then
    raise exception 'Invalid final outbox state.';
  end if;
  update public.crm_email_outbox set
    state = v_state,
    provider = case when p_values ? 'provider' then nullif(p_values ->> 'provider', '') else provider end,
    provider_message_id = case when p_values ? 'provider_message_id' then nullif(p_values ->> 'provider_message_id', '') else provider_message_id end,
    next_attempt_at = case when p_values ? 'next_attempt_at' then nullif(p_values ->> 'next_attempt_at', '')::timestamptz else next_attempt_at end,
    accepted_at = case when p_values ? 'accepted_at' then nullif(p_values ->> 'accepted_at', '')::timestamptz else accepted_at end,
    failed_at = case when p_values ? 'failed_at' then nullif(p_values ->> 'failed_at', '')::timestamptz else failed_at end,
    ambiguous_at = case when p_values ? 'ambiguous_at' then nullif(p_values ->> 'ambiguous_at', '')::timestamptz else ambiguous_at end,
    last_error_category = case when p_values ? 'last_error_category' then nullif(p_values ->> 'last_error_category', '') else last_error_category end,
    last_error_message = case when p_values ? 'last_error_message' then nullif(p_values ->> 'last_error_message', '') else last_error_message end,
    updated_at = coalesce(nullif(p_values ->> 'updated_at', '')::timestamptz, now()),
    metadata = case when p_values ? 'metadata' then coalesce(p_values -> 'metadata', '{}'::jsonb) else metadata end,
    claim_token = null, claimed_at = null, claim_expires_at = null
  where id = p_id and claim_token = p_claim_token and state = 'sending'
  returning * into v_outbox;
  return to_jsonb(v_outbox);
end;
$$;

revoke all on function public.create_crm_email_command(jsonb, jsonb, jsonb, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.create_crm_email_command(jsonb, jsonb, jsonb, timestamptz, text)
  to service_role;
revoke all on function public.claim_crm_email_outbox(text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_crm_email_outbox(text, text, timestamptz, timestamptz)
  to service_role;
revoke all on function public.finish_crm_email_outbox_claim(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.finish_crm_email_outbox_claim(text, text, jsonb)
  to service_role;

create index if not exists idx_contact_submissions_follow_up_queue
  on public.contact_submissions (status, follow_up_state, next_action_at, updated_at desc);

create or replace function public.count_crm_follow_up_sends(
  p_recipient text default '',
  p_since timestamptz default null
)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::bigint
  from public.crm_email_outbox as outbox
  join public.crm_communications as communication on communication.id = outbox.communication_id
  where communication.kind = 'crm-follow-up'
    and outbox.state not in ('permanent_failed', 'cancelled')
    and (p_since is null or outbox.created_at >= p_since)
    and (
      btrim(coalesce(p_recipient, '')) = ''
      or exists (
        select 1
        from jsonb_array_elements_text(coalesce(communication.to_addresses, '[]'::jsonb)) as recipient(value)
        where lower(recipient.value) = lower(btrim(p_recipient))
      )
    );
$$;

revoke all on function public.count_crm_follow_up_sends(text, timestamptz) from public, anon, authenticated;
grant execute on function public.count_crm_follow_up_sends(text, timestamptz) to service_role;

create or replace function public.get_crm_follow_up_operational_metrics(
  p_since timestamptz default '1970-01-01T00:00:00Z'::timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'windowStartedAt', p_since,
    'outbox', jsonb_build_object(
      'queued', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'queued'),
      'sending', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'sending'),
      'accepted', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'accepted'),
      'ambiguous', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'ambiguous'),
      'retryableFailed', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'retryable_failed'),
      'permanentFailed', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'permanent_failed'),
      'cancelled', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'cancelled')
    ),
    'delivery', jsonb_build_object(
      'delivered', (select count(*) from public.crm_communications where occurred_at >= p_since and kind = 'crm-follow-up' and direction = 'outbound' and delivery_state = 'delivered'),
      'delayed', (select count(*) from public.crm_communications where occurred_at >= p_since and kind = 'crm-follow-up' and direction = 'outbound' and delivery_state = 'delayed'),
      'bounced', (select count(*) from public.crm_communications where occurred_at >= p_since and kind = 'crm-follow-up' and direction = 'outbound' and delivery_state = 'bounced'),
      'complained', (select count(*) from public.crm_communications where occurred_at >= p_since and kind = 'crm-follow-up' and direction = 'outbound' and delivery_state = 'complained'),
      'failed', (select count(*) from public.crm_communications where occurred_at >= p_since and kind = 'crm-follow-up' and direction = 'outbound' and delivery_state = 'failed'),
      'replied', (
        select count(*) from public.crm_communications as outbound
        where outbound.occurred_at >= p_since and outbound.kind = 'crm-follow-up' and outbound.direction = 'outbound'
          and exists (
            select 1 from public.crm_communications as inbound
            where inbound.direction = 'inbound'
              and inbound.submission_id = outbound.submission_id
              and inbound.occurred_at >= outbound.occurred_at
              and (
                inbound.parent_communication_id = outbound.id
                or (outbound.message_id is not null and inbound.in_reply_to = outbound.message_id)
                or (outbound.thread_key is not null and inbound.thread_key = outbound.thread_key)
              )
          )
      )
    ),
    'recommendations', jsonb_build_object(
      'current', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'current'),
      'accepted', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'accepted'),
      'editedAndAccepted', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'edited_and_accepted'),
      'dismissed', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'dismissed'),
      'superseded', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'superseded'),
      'failed', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'failed'),
      'aiUsed', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and model_provider is not null),
      'aiFallback', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and metadata ->> 'aiRequested' = 'true' and metadata ->> 'aiUsed' = 'false')
    ),
    'ai', jsonb_build_object(
      'fallbackReasons', (
        select coalesce(jsonb_object_agg(reason, total), '{}'::jsonb)
        from (
          select metadata ->> 'aiFallbackReason' as reason, count(*) as total
          from public.crm_follow_up_recommendations
          where created_at >= p_since
            and metadata ->> 'aiRequested' = 'true'
            and nullif(metadata ->> 'aiFallbackReason', '') is not null
          group by metadata ->> 'aiFallbackReason'
        ) as reasons
      ),
      'responseStates', (
        select coalesce(jsonb_object_agg(response_state, total), '{}'::jsonb)
        from (
          select metadata ->> 'aiResponseState' as response_state, count(*) as total
          from public.crm_follow_up_recommendations
          where created_at >= p_since
            and metadata ->> 'aiRequested' = 'true'
            and nullif(metadata ->> 'aiResponseState', '') is not null
          group by metadata ->> 'aiResponseState'
        ) as states
      ),
      'latencyMs', (
        select jsonb_build_object(
          'observed', count(value),
          'average', case when count(value) > 0 then round(avg(value), 1) else null end,
          'minimum', min(value),
          'maximum', max(value),
          'total', sum(value)
        )
        from (
          select case
            when metadata ->> 'aiLatencyMs' ~ '^[0-9]+$' then (metadata ->> 'aiLatencyMs')::numeric
            else null
          end as value
          from public.crm_follow_up_recommendations
          where created_at >= p_since and metadata ->> 'aiRequested' = 'true'
        ) as latency
      ),
      'tokens', (
        select jsonb_build_object(
          'observed', count(*) filter (where input_tokens is not null or output_tokens is not null),
          'inputTotal', sum(input_tokens),
          'outputTotal', sum(output_tokens),
          'cachedTotal', sum(cached_tokens),
          'reasoningTotal', sum(reasoning_tokens)
        )
        from (
          select
            case when metadata ->> 'aiInputTokens' ~ '^[0-9]+$' then (metadata ->> 'aiInputTokens')::bigint else null end as input_tokens,
            case when metadata ->> 'aiOutputTokens' ~ '^[0-9]+$' then (metadata ->> 'aiOutputTokens')::bigint else null end as output_tokens,
            case when metadata ->> 'aiCachedTokens' ~ '^[0-9]+$' then (metadata ->> 'aiCachedTokens')::bigint else null end as cached_tokens,
            case when metadata ->> 'aiReasoningTokens' ~ '^[0-9]+$' then (metadata ->> 'aiReasoningTokens')::bigint else null end as reasoning_tokens
          from public.crm_follow_up_recommendations
          where created_at >= p_since and metadata ->> 'aiRequested' = 'true'
        ) as usage
      )
    ),
    'suppressions', jsonb_build_object(
      'active', (select count(*) from public.email_suppressions where lifted_at is null)
    )
  );
$$;

revoke all on function public.get_crm_follow_up_operational_metrics(timestamptz) from public, anon, authenticated;
grant execute on function public.get_crm_follow_up_operational_metrics(timestamptz) to service_role;

create or replace function public.list_follow_up_submissions_page(
  p_limit integer default 25,
  p_page integer default 1,
  p_search text default '',
  p_view text default 'crm-actions',
  p_sort text default 'urgency',
  p_direction text default 'desc',
  p_now timestamptz default now(),
  p_today_start timestamptz default now(),
  p_today_end timestamptz default now()
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with parameters as (
    select
      greatest(1, least(coalesce(p_limit, 25), 100)) as page_limit,
      greatest(0, coalesce(p_page, 1) - 1)::bigint
        * greatest(1, least(coalesce(p_limit, 25), 100))::bigint as page_offset,
      lower(trim(coalesce(p_search, ''))) as search_text,
      lower(trim(coalesce(p_view, 'crm-actions'))) as selected_view,
      lower(trim(coalesce(p_sort, 'urgency'))) as selected_sort,
      case when lower(p_direction) = 'asc' then 'asc' else 'desc' end as selected_direction
  ),
  base as (
    select
      submission.*,
      latest_communication.subject as follow_up_latest_subject,
      latest_communication.direction as follow_up_latest_direction,
      latest_outbound.delivery_state as follow_up_latest_delivery_state,
      latest_communication.occurred_at as follow_up_latest_communication_at,
      latest_deal.deal_key as follow_up_deal_key,
      current_recommendation.id as follow_up_recommendation_id,
      current_recommendation.action_type as follow_up_recommendation_action,
      current_recommendation.conversation_state as follow_up_conversation_state,
      current_recommendation.priority_score as follow_up_priority_score,
      current_recommendation.confidence as follow_up_confidence
    from public.contact_submissions as submission
    left join lateral (
      select communication.subject, communication.direction, communication.occurred_at
      from public.crm_communications as communication
      where communication.submission_id = submission.id
      order by communication.occurred_at desc, communication.id desc
      limit 1
    ) as latest_communication on true
    left join lateral (
      select communication.delivery_state
      from public.crm_communications as communication
      where communication.submission_id = submission.id
        and communication.direction = 'outbound'
      order by communication.occurred_at desc, communication.id desc
      limit 1
    ) as latest_outbound on true
    left join lateral (
      select communication.deal_key
      from public.crm_communications as communication
      where communication.submission_id = submission.id
        and communication.deal_key is not null
      order by communication.occurred_at desc, communication.id desc
      limit 1
    ) as latest_deal on true
    left join lateral (
      select recommendation.id, recommendation.action_type, recommendation.conversation_state,
        recommendation.priority_score, recommendation.confidence
      from public.crm_follow_up_recommendations as recommendation
      where recommendation.submission_id = submission.id
        and recommendation.status = 'current'
        and (recommendation.expires_at is null or recommendation.expires_at > p_now)
      order by recommendation.created_at desc, recommendation.id desc
      limit 1
    ) as current_recommendation on true
  ),
  filtered as (
    select base.*
    from base cross join parameters
    where base.status not in ('archived', 'spam')
      and case parameters.selected_view
        when 'completed' then base.follow_up_state = 'completed'
        when 'due-today' then base.follow_up_state <> 'completed'
          and base.next_action_at >= p_today_start and base.next_action_at < p_today_end
        when 'overdue' then base.follow_up_state <> 'completed'
          and base.next_action_at is not null and base.next_action_at < p_today_start
        when 'awaiting-reply' then base.follow_up_state <> 'completed'
          and (base.follow_up_state = 'waiting-on-owner' or base.follow_up_latest_direction = 'outbound')
        when 'inbound-reply' then base.follow_up_state <> 'completed'
          and base.follow_up_latest_direction = 'inbound'
        when 'delivery-problem' then base.follow_up_state <> 'completed'
          and base.follow_up_latest_delivery_state in ('delayed', 'bounced', 'failed', 'complained', 'suppressed')
        when 'manual-review' then base.follow_up_state <> 'completed'
          and base.follow_up_recommendation_action = 'manual_review'
        when 'email-triage' then base.follow_up_state <> 'completed'
          and (
            base.follow_up_latest_direction = 'inbound'
            or base.follow_up_latest_delivery_state in ('delayed', 'bounced', 'failed', 'complained', 'suppressed')
          )
        when 'all' then true
        else base.follow_up_state <> 'completed'
      end
      and (
        parameters.search_text = ''
        or position(parameters.search_text in lower(concat_ws(' ',
          base.company, base.name, base.email, base.broker_name, base.broker_email,
          base.seller_name, base.seller_email, base.listing_url,
          base.follow_up_latest_subject, base.follow_up_deal_key
        ))) > 0
        or exists (
          select 1
          from public.crm_communications as search_communication
          where search_communication.submission_id = base.id
            and position(parameters.search_text in lower(concat_ws(' ',
              search_communication.subject, search_communication.deal_key
            ))) > 0
        )
      )
  ),
  ordered as (
    select
      filtered.*,
      row_number() over (
        order by
          case when parameters.selected_sort = 'urgency' then
            case
              when filtered.follow_up_latest_delivery_state in ('bounced', 'failed', 'complained', 'suppressed') then 4
              when filtered.follow_up_latest_direction = 'inbound' then 3
              when filtered.next_action_at is not null and filtered.next_action_at < p_now then 2
              else 1
            end
          end desc nulls last,
          case when parameters.selected_sort = 'urgency' then coalesce(filtered.follow_up_priority_score, 0) end desc nulls last,
          case when parameters.selected_sort = 'next_action_at' and parameters.selected_direction = 'asc' then filtered.next_action_at end asc nulls last,
          case when parameters.selected_sort = 'next_action_at' and parameters.selected_direction = 'desc' then filtered.next_action_at end desc nulls last,
          case when parameters.selected_sort = 'updated_at' and parameters.selected_direction = 'asc' then filtered.updated_at end asc,
          case when parameters.selected_sort = 'updated_at' and parameters.selected_direction = 'desc' then filtered.updated_at end desc,
          case when parameters.selected_sort = 'company' and parameters.selected_direction = 'asc' then lower(coalesce(filtered.company, filtered.name, '')) end asc,
          case when parameters.selected_sort = 'company' and parameters.selected_direction = 'desc' then lower(coalesce(filtered.company, filtered.name, '')) end desc,
          case when parameters.selected_sort = 'priority' and parameters.selected_direction = 'asc' then
            case filtered.priority when 'urgent' then 5 when 'high' then 4 when 'medium' then 3 when 'normal' then 2 when 'low' then 1 else 0 end
          end asc,
          case when parameters.selected_sort = 'priority' and parameters.selected_direction = 'desc' then
            case filtered.priority when 'urgent' then 5 when 'high' then 4 when 'medium' then 3 when 'normal' then 2 when 'low' then 1 else 0 end
          end desc,
          case when parameters.selected_sort = 'created_at' and parameters.selected_direction = 'asc' then filtered.created_at end asc,
          case when parameters.selected_sort = 'created_at' and parameters.selected_direction = 'desc' then filtered.created_at end desc,
          filtered.next_action_at asc nulls last,
          filtered.updated_at desc,
          filtered.id asc
      ) as page_position
    from filtered cross join parameters
  ),
  paged as (
    select ordered.*
    from ordered cross join parameters
    order by ordered.page_position
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    offset greatest(0, coalesce(p_page, 1) - 1)::bigint
      * greatest(1, least(coalesce(p_limit, 25), 100))::bigint
  )
  select jsonb_build_object(
    'rows', coalesce(
      (select jsonb_agg(to_jsonb(paged) - 'page_position' order by page_position) from paged),
      '[]'::jsonb
    ),
    'total', (select count(*) from filtered)
  );
$$;

revoke all on function public.list_follow_up_submissions_page(
  integer, integer, text, text, text, text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.list_follow_up_submissions_page(
  integer, integer, text, text, text, text, timestamptz, timestamptz, timestamptz
) to service_role;

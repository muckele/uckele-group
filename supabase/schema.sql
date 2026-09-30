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

alter table public.deal_hunter_cim_reviews add column if not exists opportunity_id text;
alter table public.deal_hunter_cim_reviews add column if not exists snapshot_digest text;
alter table public.deal_hunter_cim_reviews add column if not exists evidence_version text;
alter table public.deal_hunter_cim_reviews add column if not exists rule_version text;
alter table public.deal_hunter_cim_reviews add column if not exists source_policy_version text;
alter table public.deal_hunter_cim_reviews add column if not exists source_policy_hash text;
alter table public.deal_hunter_cim_reviews add column if not exists source_ids jsonb not null default '[]'::jsonb;
alter table public.deal_hunter_cim_reviews add column if not exists actor_role text;
alter table public.deal_hunter_cim_reviews add column if not exists decision_at timestamptz;

create index if not exists idx_deal_hunter_cim_reviews_created on public.deal_hunter_cim_reviews (created_at desc);
create index if not exists idx_deal_hunter_cim_reviews_deal on public.deal_hunter_cim_reviews (deal_key, created_at desc);
create index if not exists idx_deal_hunter_cim_reviews_opportunity on public.deal_hunter_cim_reviews (opportunity_id, decision_at desc, created_at desc);
create index if not exists idx_deal_hunter_cim_reviews_policy on public.deal_hunter_cim_reviews (rule_version, source_policy_hash, created_at desc);

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

create or replace function public.claim_scheduled_job(
  p_job_key text,
  p_job_name text,
  p_triggered_by text,
  p_claim_token text,
  p_now timestamptz,
  p_stale_before timestamptz,
  p_retry_due_at timestamptz,
  p_legacy_mode boolean,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.scheduled_job_runs%rowtype;
  v_metadata jsonb;
  v_immutable_field text;
  v_next_retry_at timestamptz;
  v_next_retry_text text;
  v_reason text;
begin
  if p_job_key is null or btrim(p_job_key) = '' or length(p_job_key) > 240
    or p_job_name is null or btrim(p_job_name) = '' or length(p_job_name) > 120
    or p_claim_token is null or p_claim_token !~ '^[A-Za-z0-9_-]{16,200}$'
    or p_now is null
    or p_legacy_mode is null
    or (p_legacy_mode and p_retry_due_at is not null)
    or p_metadata is null or jsonb_typeof(p_metadata) is distinct from 'object'
    or octet_length(p_metadata::text) > 524288
    or length(coalesce(p_triggered_by, '')) > 200
  then
    return jsonb_build_object('applied', false, 'reason', 'missing', 'run', null);
  end if;

  v_metadata := p_metadata || jsonb_build_object(
    'claimToken', p_claim_token,
    'claimedAt', p_now
  );
  if octet_length(v_metadata::text) > 524288 then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', null);
  end if;

  insert into public.scheduled_job_runs (
    job_key,
    job_name,
    created_at,
    updated_at,
    started_at,
    completed_at,
    status,
    triggered_by,
    attempt_count,
    provider_message_id,
    last_error,
    metadata
  ) values (
    p_job_key,
    p_job_name,
    p_now,
    p_now,
    p_now,
    null,
    'pending',
    nullif(p_triggered_by, ''),
    1,
    null,
    null,
    v_metadata
  )
  on conflict (job_key) do nothing
  returning * into v_current;

  if found then
    return jsonb_build_object('applied', true, 'reason', 'claimed', 'run', to_jsonb(v_current));
  end if;

  select *
  into v_current
  from public.scheduled_job_runs
  where job_key = p_job_key
  for update;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'missing', 'run', null);
  end if;
  if v_current.job_name is distinct from p_job_name then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;
  if v_current.status = 'completed' then
    return jsonb_build_object('applied', false, 'reason', 'completed', 'run', to_jsonb(v_current));
  end if;
  if v_current.status in ('transmitting', 'ambiguous') then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  if v_current.status = 'pending' then
    if p_stale_before is null or v_current.updated_at > p_stale_before then
      return jsonb_build_object('applied', false, 'reason', 'active', 'run', to_jsonb(v_current));
    end if;
  elsif v_current.status = 'failed' then
    v_next_retry_text := v_current.metadata ->> 'nextRetryAt';
    if v_next_retry_text is null or v_next_retry_text = '' then
      if not p_legacy_mode then
        return jsonb_build_object('applied', false, 'reason', 'retry-not-due', 'run', to_jsonb(v_current));
      end if;
    else
      begin
        v_next_retry_at := v_next_retry_text::timestamptz;
      exception when others then
        return jsonb_build_object('applied', false, 'reason', 'retry-not-due', 'run', to_jsonb(v_current));
      end;
      if p_retry_due_at is null or v_next_retry_at > p_retry_due_at then
        return jsonb_build_object('applied', false, 'reason', 'retry-not-due', 'run', to_jsonb(v_current));
      end if;
    end if;
  else
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;
  if coalesce(v_current.metadata ->> 'claimToken', '') = p_claim_token then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  v_metadata := coalesce(v_current.metadata, '{}'::jsonb) || p_metadata;
  foreach v_immutable_field in array array[
    'preparedEnvelope',
    'payloadDigest',
    'firstPreparedAt',
    'preparedAt',
    'businessDate',
    'pacificDate',
    'dateKey',
    'timezone',
    'notificationType'
  ] loop
    if coalesce(v_current.metadata, '{}'::jsonb) ? v_immutable_field then
      v_metadata := jsonb_set(
        v_metadata,
        array[v_immutable_field],
        v_current.metadata -> v_immutable_field,
        true
      );
    end if;
  end loop;
  v_metadata := v_metadata || jsonb_build_object(
    'claimToken', p_claim_token,
    'claimedAt', p_now
  );
  if octet_length(v_metadata::text) > 524288 then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  update public.scheduled_job_runs
  set updated_at = p_now,
      started_at = p_now,
      completed_at = null,
      status = 'pending',
      triggered_by = nullif(p_triggered_by, ''),
      attempt_count = attempt_count + 1,
      provider_message_id = null,
      last_error = null,
      metadata = v_metadata
  where job_key = p_job_key
    and job_name = p_job_name
    and status = v_current.status
    and updated_at = v_current.updated_at
  returning * into v_current;

  if not found then
    select * into v_current from public.scheduled_job_runs where job_key = p_job_key;
    if v_current.status = 'completed' then
      v_reason := 'completed';
    elsif v_current.status = 'pending' then
      v_reason := 'active';
    elsif v_current.status = 'failed' then
      v_reason := 'retry-not-due';
    else
      v_reason := 'wrong-state';
    end if;
    return jsonb_build_object('applied', false, 'reason', v_reason, 'run', to_jsonb(v_current));
  end if;

  return jsonb_build_object('applied', true, 'reason', 'claimed', 'run', to_jsonb(v_current));
end;
$$;

create or replace function public.transition_scheduled_job(
  p_job_key text,
  p_claim_token text,
  p_expected_statuses text[],
  p_status text,
  p_now timestamptz,
  p_provider_message_id text,
  p_last_error text,
  p_metadata_patch jsonb,
  p_completed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.scheduled_job_runs%rowtype;
  v_metadata jsonb;
  v_immutable_field text;
  v_allowed boolean := false;
begin
  if p_job_key is null or btrim(p_job_key) = '' or length(p_job_key) > 240
    or p_claim_token is null or p_claim_token !~ '^[A-Za-z0-9_-]{16,200}$'
    or p_expected_statuses is null or cardinality(p_expected_statuses) = 0
    or p_status is null
    or p_status not in ('pending', 'transmitting', 'failed', 'ambiguous', 'completed')
    or exists (
      select 1 from unnest(p_expected_statuses) as expected(status)
      where expected.status is null
        or expected.status not in ('pending', 'transmitting', 'failed', 'ambiguous', 'completed')
    )
    or p_now is null
    or p_metadata_patch is null or jsonb_typeof(p_metadata_patch) is distinct from 'object'
    or octet_length(p_metadata_patch::text) > 524288
    or length(coalesce(p_provider_message_id, '')) > 500
    or length(coalesce(p_last_error, '')) > 1000
  then
    return jsonb_build_object('applied', false, 'reason', 'missing', 'run', null);
  end if;

  select *
  into v_current
  from public.scheduled_job_runs
  where job_key = p_job_key
  for update;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'missing', 'run', null);
  end if;
  if v_current.status = 'completed' then
    return jsonb_build_object('applied', false, 'reason', 'completed', 'run', to_jsonb(v_current));
  end if;
  if coalesce(v_current.metadata ->> 'claimToken', '') is distinct from p_claim_token then
    return jsonb_build_object('applied', false, 'reason', 'not-owner', 'run', to_jsonb(v_current));
  end if;
  if not (v_current.status = any(p_expected_statuses)) then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  v_allowed := case v_current.status
    when 'pending' then p_status in ('pending', 'transmitting', 'failed', 'ambiguous', 'completed')
    when 'transmitting' then p_status in ('failed', 'ambiguous', 'completed')
    when 'ambiguous' then p_status = 'completed'
    else false
  end;
  if not v_allowed then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  v_metadata := coalesce(v_current.metadata, '{}'::jsonb) || p_metadata_patch;
  foreach v_immutable_field in array array[
    'preparedEnvelope',
    'payloadDigest',
    'firstPreparedAt',
    'preparedAt',
    'businessDate',
    'pacificDate',
    'dateKey',
    'timezone',
    'notificationType'
  ] loop
    if coalesce(v_current.metadata, '{}'::jsonb) ? v_immutable_field then
      v_metadata := jsonb_set(
        v_metadata,
        array[v_immutable_field],
        v_current.metadata -> v_immutable_field,
        true
      );
    end if;
  end loop;
  v_metadata := v_metadata || jsonb_build_object(
    'claimToken', v_current.metadata -> 'claimToken',
    'claimedAt', v_current.metadata -> 'claimedAt'
  );
  if p_status = 'failed' then
    v_metadata := jsonb_set(v_metadata, '{failedAt}', to_jsonb(p_now), true);
    v_metadata := jsonb_set(v_metadata, '{nextRetryAt}', to_jsonb(p_now + interval '30 minutes'), true);
  end if;
  if octet_length(v_metadata::text) > 524288 then
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  update public.scheduled_job_runs
  set updated_at = p_now,
      completed_at = case
        when p_status = 'completed' then coalesce(p_completed_at, p_now)
        else completed_at
      end,
      status = p_status,
      provider_message_id = coalesce(nullif(p_provider_message_id, ''), provider_message_id),
      last_error = nullif(p_last_error, ''),
      metadata = v_metadata
  where job_key = p_job_key
    and status = any(p_expected_statuses)
    and metadata ->> 'claimToken' = p_claim_token
  returning * into v_current;

  if not found then
    select * into v_current from public.scheduled_job_runs where job_key = p_job_key;
    if v_current is null then
      return jsonb_build_object('applied', false, 'reason', 'missing', 'run', null);
    elsif v_current.status = 'completed' then
      return jsonb_build_object('applied', false, 'reason', 'completed', 'run', to_jsonb(v_current));
    elsif coalesce(v_current.metadata ->> 'claimToken', '') is distinct from p_claim_token then
      return jsonb_build_object('applied', false, 'reason', 'not-owner', 'run', to_jsonb(v_current));
    end if;
    return jsonb_build_object('applied', false, 'reason', 'wrong-state', 'run', to_jsonb(v_current));
  end if;

  return jsonb_build_object('applied', true, 'reason', 'claimed', 'run', to_jsonb(v_current));
end;
$$;

revoke all on function public.claim_scheduled_job(text, text, text, text, timestamptz, timestamptz, timestamptz, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_scheduled_job(text, text, text, text, timestamptz, timestamptz, timestamptz, boolean, jsonb)
  to service_role;

revoke all on function public.transition_scheduled_job(text, text, text[], text, timestamptz, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.transition_scheduled_job(text, text, text[], text, timestamptz, text, text, jsonb, timestamptz)
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

-- Canonical Deal Hunter opportunity identity, recipient safety controls, and
-- reversible audit/repair manifests. All tables remain server/service-role only.

create table if not exists public.deal_hunter_opportunities (
  opportunity_id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  canonical_name text not null,
  canonical_recipient text,
  canonical_location text,
  primary_submission_id uuid references public.contact_submissions(id) on delete set null,
  identity_version text not null,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb
);

-- Operator fact revisions retain historical corrections. Structured source
-- observations are refreshed by a bounded source-record identity; neither
-- table accepts arbitrary raw source blobs.
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
  updated_at timestamptz not null,
  constraint deal_hunter_opportunity_facts_operator_boundary_check check (
    id = btrim(id) and char_length(id) between 1 and 240
    and opportunity_id = btrim(opportunity_id) and char_length(opportunity_id) between 1 and 200
    and field in (
      'seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone',
      'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration',
      'operator_contact_notes'
    )
    and value = btrim(value) and char_length(value) between 1 and 4000
    and source = 'operator'
    and actor = btrim(actor) and char_length(actor) between 1 and 200
    and (note is null or (note = btrim(note) and char_length(note) between 1 and 4000))
  )
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
  unique(opportunity_id, source_id, source_record_id, field),
  constraint deal_hunter_opportunity_source_observations_bounded_check check (
    id = btrim(id) and char_length(id) between 1 and 240
    and opportunity_id = btrim(opportunity_id) and char_length(opportunity_id) between 1 and 200
    and source_id = btrim(source_id) and char_length(source_id) between 1 and 160
    and source_name = btrim(source_name) and char_length(source_name) between 1 and 220
    and source_record_id = btrim(source_record_id) and char_length(source_record_id) between 1 and 200
    and field in (
      'name', 'business_name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
      'annual_profit', 'annual_revenue', 'asking_price', 'profit_multiple', 'net_margin', 'years_established',
      'remote_flag', 'franchise_flag', 'five_years_flag', 'broker_name', 'broker_company', 'broker_contact', 'broker_email',
      'broker_phone', 'company', 'role', 'seller_name', 'seller_email', 'seller_phone', 'reason_for_sale', 'real_estate_included',
      'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes', 'listing_url',
      'listing_source', 'listing_id', 'deal_key', 'source_identity', 'date_added', 'last_updated',
      'business_website', 'prospectus_url', 'ttm_revenue', 'ttm_ebitda', 'ebitda_multiple', 'business_age',
      'sba_eligible', 'lead_type'
    )
    and value = btrim(value) and char_length(value) between 1 and 5000
  )
);

create table if not exists public.deal_hunter_opportunity_aliases (
  id text primary key,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  alias_type text not null,
  alias_value text not null,
  alias_key text not null unique,
  source text,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  evidence_version text not null,
  resolution_method text not null,
  confidence_state text not null,
  resolved_by text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_identity_exceptions (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  status text not null,
  observed_deal_key text,
  observed_name text,
  observed_recipient text,
  candidate_opportunity_ids jsonb not null default '[]'::jsonb,
  reason text not null,
  evidence_version text not null,
  resolved_at timestamptz,
  resolved_by text,
  resolution_reason text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_opportunity_claims (
  opportunity_id text primary key references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  request_id text not null unique,
  recipient_email text not null,
  state text not null,
  claimed_at timestamptz not null,
  updated_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_recipient_overrides (
  id text primary key,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  recipient_email text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_by text not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_recipient_claims (
  recipient_email text primary key,
  request_id text not null,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  claimed_at timestamptz not null,
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_safety_settings (
  id text primary key,
  updated_at timestamptz not null,
  outreach_paused boolean not null default false,
  updated_by text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_repair_manifests (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  mode text not null,
  status text not null,
  actor text not null,
  backup_reference text,
  checksum text not null,
  manifest jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_stage2_activations (
  id uuid primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  status text not null check (status in ('current', 'superseded', 'withdrawn')),
  mode text not null check (mode in ('off', 'shadow', 'canary', 'active')),
  actor text not null,
  reason text not null,
  confirmation_phrase text not null,
  policy_hash text not null,
  rule_version text not null,
  source_policy_version text not null,
  source_policy_hash text not null,
  evidence_checksum text not null,
  evidence_generated_at timestamptz not null,
  backup_reference text not null,
  backup_checksum text not null,
  identity_audit_reference text not null,
  identity_audit_checksum text not null,
  compliance_reference text not null,
  sender_auth_reference text not null,
  timezone text not null,
  window_start text not null,
  window_end text not null,
  weekdays_only boolean not null default true,
  canary_daily_cap integer not null check (canary_daily_cap = 1),
  active_daily_cap integer not null check (active_daily_cap between 1 and 10),
  recipient_cap_24_hours integer not null check (recipient_cap_24_hours = 1),
  recipient_cap_30_days integer not null check (recipient_cap_30_days = 4),
  expires_at timestamptz not null,
  superseded_at timestamptz,
  superseded_by text,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists idx_cim_stage2_one_current_activation
  on public.deal_hunter_cim_stage2_activations (status) where status = 'current';
create index if not exists idx_cim_stage2_activations_created
  on public.deal_hunter_cim_stage2_activations (created_at desc);

create table if not exists public.deal_hunter_cim_stage2_runs (
  id uuid primary key,
  run_key text not null unique,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  pacific_business_date text not null,
  mode text not null check (mode in ('shadow', 'canary', 'active')),
  status text not null check (status in ('running', 'completed', 'blocked', 'failed')),
  triggered_by text not null,
  policy_hash text not null,
  rule_version text not null,
  source_policy_hash text not null,
  activation_id uuid,
  considered_count integer not null default 0,
  eligible_count integer not null default 0,
  would_send_count integer not null default 0,
  attempted_count integer not null default 0,
  accepted_count integer not null default 0,
  failed_count integer not null default 0,
  ambiguous_count integer not null default 0,
  deferred_count integer not null default 0,
  blocked_counts jsonb not null default '{}'::jsonb,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_cim_stage2_runs_date_mode
  on public.deal_hunter_cim_stage2_runs (pacific_business_date desc, mode, status);
create index if not exists idx_cim_stage2_runs_policy
  on public.deal_hunter_cim_stage2_runs (policy_hash, created_at desc);

create table if not exists public.deal_hunter_cim_stage2_decisions (
  id uuid primary key,
  run_id uuid not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  opportunity_id text not null,
  deal_key text not null,
  decision_state text not null check (decision_state in ('blocked', 'eligible', 'deferred', 'claimed', 'attempting', 'accepted', 'failed', 'ambiguous')),
  policy_hash text not null,
  rule_version text not null,
  source_policy_hash text not null,
  activation_id uuid,
  snapshot_digest text not null,
  recipient_hash text not null,
  source_snapshot_digest text not null,
  reasons jsonb not null default '[]'::jsonb,
  claim_token text,
  claimed_at timestamptz,
  consumed_at timestamptz,
  cim_request_id text,
  communication_id text,
  provider_state text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  unique (run_id, opportunity_id, policy_hash)
);

create index if not exists idx_cim_stage2_decisions_run
  on public.deal_hunter_cim_stage2_decisions (run_id, decision_state);
create index if not exists idx_cim_stage2_decisions_opportunity
  on public.deal_hunter_cim_stage2_decisions (opportunity_id, created_at desc);
create index if not exists idx_cim_stage2_decisions_evidence
  on public.deal_hunter_cim_stage2_decisions (policy_hash, source_policy_hash, decision_state);
create unique index if not exists idx_cim_stage2_active_opportunity_claim
  on public.deal_hunter_cim_stage2_decisions (opportunity_id)
  where decision_state in ('claimed', 'attempting', 'ambiguous');

alter table public.deal_hunter_cim_requests add column if not exists opportunity_id text;
alter table public.deal_hunter_crm_imports add column if not exists opportunity_id text;
alter table public.crm_communications add column if not exists opportunity_id text;
alter table public.email_events add column if not exists opportunity_id text;
alter table public.crm_activity_events add column if not exists opportunity_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deal_hunter_cim_requests_opportunity_id_fkey') then
    alter table public.deal_hunter_cim_requests
      add constraint deal_hunter_cim_requests_opportunity_id_fkey
      foreign key (opportunity_id) references public.deal_hunter_opportunities(opportunity_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deal_hunter_crm_imports_opportunity_id_fkey') then
    alter table public.deal_hunter_crm_imports
      add constraint deal_hunter_crm_imports_opportunity_id_fkey
      foreign key (opportunity_id) references public.deal_hunter_opportunities(opportunity_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_communications_opportunity_id_fkey') then
    alter table public.crm_communications
      add constraint crm_communications_opportunity_id_fkey
      foreign key (opportunity_id) references public.deal_hunter_opportunities(opportunity_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_events_opportunity_id_fkey') then
    alter table public.email_events
      add constraint email_events_opportunity_id_fkey
      foreign key (opportunity_id) references public.deal_hunter_opportunities(opportunity_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_activity_events_opportunity_id_fkey') then
    alter table public.crm_activity_events
      add constraint crm_activity_events_opportunity_id_fkey
      foreign key (opportunity_id) references public.deal_hunter_opportunities(opportunity_id) on delete set null;
  end if;
end
$$;

create index if not exists idx_deal_hunter_opportunities_updated
  on public.deal_hunter_opportunities(updated_at desc, opportunity_id);
create index if not exists idx_deal_hunter_opportunities_recipient
  on public.deal_hunter_opportunities(canonical_recipient, updated_at desc);
create index if not exists idx_deal_hunter_opportunity_facts_history
  on public.deal_hunter_opportunity_facts(opportunity_id, created_at desc, id desc);
create index if not exists idx_deal_hunter_source_observations_history
  on public.deal_hunter_opportunity_source_observations(opportunity_id, observed_at desc, id);
create index if not exists idx_deal_hunter_source_observations_queue_projection
  on public.deal_hunter_opportunity_source_observations(opportunity_id, field, observed_at desc, id);
create index if not exists idx_deal_hunter_opportunity_aliases_opportunity
  on public.deal_hunter_opportunity_aliases(opportunity_id, alias_type);
create index if not exists idx_deal_hunter_identity_exceptions_status
  on public.deal_hunter_identity_exceptions(status, updated_at desc);
create index if not exists idx_deal_hunter_cim_requests_opportunity
  on public.deal_hunter_cim_requests(opportunity_id, updated_at desc);
create index if not exists idx_deal_hunter_crm_imports_opportunity
  on public.deal_hunter_crm_imports(opportunity_id, updated_at desc);
create index if not exists idx_crm_communications_opportunity
  on public.crm_communications(opportunity_id, occurred_at desc);
create index if not exists idx_email_events_opportunity
  on public.email_events(opportunity_id, created_at desc);
create index if not exists idx_crm_activity_opportunity
  on public.crm_activity_events(opportunity_id, created_at desc);
create index if not exists idx_deal_hunter_cim_overrides_lookup
  on public.deal_hunter_cim_recipient_overrides(opportunity_id, recipient_email, expires_at desc);
create index if not exists idx_deal_hunter_repair_manifests_created
  on public.deal_hunter_cim_repair_manifests(created_at desc);

create or replace function public.upsert_deal_hunter_opportunity(p_record jsonb)
returns public.deal_hunter_opportunities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opportunity public.deal_hunter_opportunities;
  v_opportunity_id text := p_record->>'opportunity_id';
begin
  if nullif(btrim(v_opportunity_id), '') is null then
    raise exception 'canonical opportunity id is required';
  end if;

  insert into public.deal_hunter_opportunities (
    opportunity_id, created_at, updated_at, canonical_name, canonical_recipient,
    canonical_location, primary_submission_id, identity_version, status, metadata
  ) values (
    v_opportunity_id,
    (p_record->>'created_at')::timestamptz,
    (p_record->>'updated_at')::timestamptz,
    p_record->>'canonical_name',
    nullif(p_record->>'canonical_recipient', ''),
    nullif(p_record->>'canonical_location', ''),
    nullif(p_record->>'primary_submission_id', '')::uuid,
    p_record->>'identity_version',
    coalesce(nullif(p_record->>'status', ''), 'active'),
    coalesce(p_record->'metadata', '{}'::jsonb)
  )
  on conflict (opportunity_id) do update set
    updated_at = excluded.updated_at,
    canonical_name = excluded.canonical_name,
    canonical_recipient = coalesce(excluded.canonical_recipient, public.deal_hunter_opportunities.canonical_recipient),
    canonical_location = coalesce(excluded.canonical_location, public.deal_hunter_opportunities.canonical_location),
    primary_submission_id = coalesce(excluded.primary_submission_id, public.deal_hunter_opportunities.primary_submission_id),
    identity_version = excluded.identity_version,
    status = excluded.status,
    metadata = excluded.metadata
  where public.deal_hunter_opportunities.status = 'active'
  returning * into v_opportunity;

  if v_opportunity.opportunity_id is null then
    select * into v_opportunity
    from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id;
  end if;
  return v_opportunity;
end;
$$;

create or replace function public.create_deal_hunter_opportunity_with_aliases(
  p_opportunity jsonb,
  p_aliases jsonb,
  p_existing_owner_mode text default 'return-current',
  p_identity_exception jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_proposed_opportunity_id text := nullif(btrim(p_opportunity->>'opportunity_id'), '');
  v_existing_owner_mode text := coalesce(nullif(btrim(p_existing_owner_mode), ''), 'return-current');
  v_alias_key text;
  v_item jsonb;
  v_owner_ids text[] := array[]::text[];
  v_target_opportunity_id text;
  v_created boolean := false;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_identity_exception public.deal_hunter_identity_exceptions%rowtype;
  v_resolved_identity_exception public.deal_hunter_identity_exceptions%rowtype;
  v_linked_aliases jsonb := '[]'::jsonb;
begin
  if v_proposed_opportunity_id is null or p_opportunity->>'status' <> 'active' then
    raise exception 'atomic canonical opportunity creation requires one active opportunity';
  end if;
  if v_existing_owner_mode not in ('return-current', 'conflict') then
    raise exception 'unsupported canonical opportunity existing-owner mode';
  end if;
  if jsonb_typeof(coalesce(p_aliases, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_aliases, '[]'::jsonb)) = 0 then
    raise exception 'atomic canonical opportunity creation requires at least one alias';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_aliases) as item(value)
    where nullif(btrim(item.value->>'alias_key'), '') is null
      or item.value->>'opportunity_id' is distinct from v_proposed_opportunity_id
  ) then
    raise exception 'atomic canonical opportunity aliases must target the proposed opportunity';
  end if;

  if p_identity_exception is not null then
    if nullif(btrim(p_identity_exception->>'id'), '') is null
      or p_identity_exception->>'status' <> 'resolved'
      or nullif(btrim(p_identity_exception->>'resolved_at'), '') is null
      or nullif(btrim(p_identity_exception->>'resolved_by'), '') is null
      or nullif(btrim(p_identity_exception->>'resolution_reason'), '') is null then
      raise exception 'atomic identity exception resolution is incomplete';
    end if;
    select * into v_identity_exception
    from public.deal_hunter_identity_exceptions
    where id = p_identity_exception->>'id'
    for update;
    if not found then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object('reason', 'identity-exception-not-open'),
        'opportunity', null, 'aliases', '[]'::jsonb, 'identityException', null
      );
    end if;
    if v_identity_exception.status <> 'open'
      or v_identity_exception.resolved_at is not null
      or v_identity_exception.resolved_by is not null
      or v_identity_exception.resolution_reason is not null then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object('reason', 'identity-exception-not-open'),
        'opportunity', null, 'aliases', '[]'::jsonb,
        'identityException', to_jsonb(v_identity_exception)
      );
    end if;
  end if;

  -- Canonical alias/opportunity lock order: complete distinct alias keys in
  -- sorted order, alias advisory locks, owner discovery, sorted opportunity
  -- row locks, revalidation, then mutation.
  for v_alias_key in
    select distinct item.value->>'alias_key' as alias_key
    from jsonb_array_elements(p_aliases) as item(value)
    order by alias_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('deal-hunter-opportunity-alias:' || v_alias_key, 0)
    );
  end loop;

  select coalesce(
    array_agg(distinct alias.opportunity_id order by alias.opportunity_id),
    array[]::text[]
  ) into v_owner_ids
  from public.deal_hunter_opportunity_aliases as alias
  join jsonb_array_elements(p_aliases) as item(value)
    on item.value->>'alias_key' = alias.alias_key;

  if cardinality(v_owner_ids) > 1 then
    return jsonb_build_object(
      'created', false, 'linked', false,
      'conflict', jsonb_build_object(
        'reason', 'conflicting-alias-owners',
        'opportunity_id', v_owner_ids[1],
        'opportunity_ids', to_jsonb(v_owner_ids),
        'alias_key', ''
      ),
      'opportunity', null, 'aliases', '[]'::jsonb,
      'identityException', case when p_identity_exception is null then null else to_jsonb(v_identity_exception) end
    );
  end if;

  if cardinality(v_owner_ids) = 1 then
    v_target_opportunity_id := v_owner_ids[1];
    select * into v_opportunity
    from public.deal_hunter_opportunities
    where opportunity_id = v_target_opportunity_id
    for update;
    if not found then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object(
          'reason', 'alias-owner-missing',
          'opportunity_id', v_target_opportunity_id,
          'opportunity_ids', to_jsonb(v_owner_ids),
          'alias_key', ''
        ),
        'opportunity', null, 'aliases', '[]'::jsonb,
        'identityException', case when p_identity_exception is null then null else to_jsonb(v_identity_exception) end
      );
    end if;
    if v_opportunity.status <> 'active' then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object(
          'reason', 'alias-owner-not-current',
          'opportunity_id', v_target_opportunity_id,
          'alias_key', ''
        ),
        'opportunity', to_jsonb(v_opportunity), 'aliases', '[]'::jsonb,
        'identityException', case when p_identity_exception is null then null else to_jsonb(v_identity_exception) end
      );
    end if;
    if v_existing_owner_mode = 'conflict' then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object(
          'reason', 'alias-owner-exists',
          'opportunity_id', v_target_opportunity_id,
          'alias_key', ''
        ),
        'opportunity', to_jsonb(v_opportunity), 'aliases', '[]'::jsonb,
        'identityException', case when p_identity_exception is null then null else to_jsonb(v_identity_exception) end
      );
    end if;
  else
    perform 1
    from public.deal_hunter_opportunities
    where opportunity_id = v_proposed_opportunity_id
    for update;
    if found then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object(
          'reason', 'proposed-opportunity-id-exists',
          'opportunity_id', v_proposed_opportunity_id,
          'alias_key', ''
        ),
        'opportunity', null, 'aliases', '[]'::jsonb,
        'identityException', case when p_identity_exception is null then null else to_jsonb(v_identity_exception) end
      );
    end if;
    insert into public.deal_hunter_opportunities (
      opportunity_id, created_at, updated_at, canonical_name, canonical_recipient,
      canonical_location, primary_submission_id, identity_version, status, metadata
    ) values (
      v_proposed_opportunity_id,
      (p_opportunity->>'created_at')::timestamptz,
      (p_opportunity->>'updated_at')::timestamptz,
      p_opportunity->>'canonical_name',
      nullif(p_opportunity->>'canonical_recipient', ''),
      nullif(p_opportunity->>'canonical_location', ''),
      nullif(p_opportunity->>'primary_submission_id', '')::uuid,
      p_opportunity->>'identity_version',
      'active',
      coalesce(p_opportunity->'metadata', '{}'::jsonb)
    ) returning * into v_opportunity;
    v_target_opportunity_id := v_proposed_opportunity_id;
    v_created := true;
  end if;

  for v_item in
    select item.value
    from jsonb_array_elements(p_aliases) as item(value)
    order by item.value->>'alias_key'
  loop
    insert into public.deal_hunter_opportunity_aliases (
      id, opportunity_id, alias_type, alias_value, alias_key, source,
      first_observed_at, last_observed_at, evidence_version, resolution_method,
      confidence_state, resolved_by, metadata
    ) values (
      v_item->>'id',
      v_target_opportunity_id,
      v_item->>'alias_type',
      v_item->>'alias_value',
      v_item->>'alias_key',
      nullif(v_item->>'source', ''),
      (v_item->>'first_observed_at')::timestamptz,
      (v_item->>'last_observed_at')::timestamptz,
      v_item->>'evidence_version',
      v_item->>'resolution_method',
      v_item->>'confidence_state',
      nullif(v_item->>'resolved_by', ''),
      coalesce(v_item->'metadata', '{}'::jsonb)
    ) on conflict (alias_key) do update set
      last_observed_at = excluded.last_observed_at,
      source = coalesce(excluded.source, public.deal_hunter_opportunity_aliases.source),
      metadata = excluded.metadata
    where public.deal_hunter_opportunity_aliases.opportunity_id = excluded.opportunity_id;
  end loop;

  if exists (
    select 1
    from public.deal_hunter_opportunity_aliases as alias
    join jsonb_array_elements(p_aliases) as item(value)
      on item.value->>'alias_key' = alias.alias_key
    where alias.opportunity_id <> v_target_opportunity_id
  ) then
    raise exception 'atomic canonical opportunity alias acquisition failed its owner postcondition';
  end if;

  select coalesce(jsonb_agg(to_jsonb(alias) order by alias.alias_key), '[]'::jsonb)
  into v_linked_aliases
  from public.deal_hunter_opportunity_aliases as alias
  where alias.alias_key in (
    select distinct item.value->>'alias_key'
    from jsonb_array_elements(p_aliases) as item(value)
  );

  if p_identity_exception is not null then
    update public.deal_hunter_identity_exceptions
    set updated_at = (p_identity_exception->>'updated_at')::timestamptz,
        status = 'resolved',
        resolved_at = (p_identity_exception->>'resolved_at')::timestamptz,
        resolved_by = p_identity_exception->>'resolved_by',
        resolution_reason = p_identity_exception->>'resolution_reason',
        metadata = coalesce(p_identity_exception->'metadata', '{}'::jsonb)
    where id = p_identity_exception->>'id'
      and status = 'open'
      and resolved_at is null
      and resolved_by is null
      and resolution_reason is null
    returning * into v_resolved_identity_exception;
    if not found then
      raise exception 'atomic canonical opportunity creation could not resolve the expected open identity exception';
    end if;
  end if;

  return jsonb_build_object(
    'created', v_created,
    'linked', true,
    'conflict', null,
    'opportunity', to_jsonb(v_opportunity),
    'aliases', v_linked_aliases,
    'identityException', case
      when p_identity_exception is null then null
      else to_jsonb(v_resolved_identity_exception)
    end
  );
end;
$$;

create or replace function public.claim_deal_hunter_cim_opportunity(
  p_opportunity_id text,
  p_request_id text,
  p_recipient_email text,
  p_allowed_request_ids text[],
  p_claimed_at timestamptz,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.deal_hunter_cim_opportunity_claims%rowtype;
  v_claim public.deal_hunter_cim_opportunity_claims%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('deal-hunter-cim-opportunity:' || p_opportunity_id, 0));
  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = p_opportunity_id and status = 'active'
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'opportunity-not-current', 'claim', null);
  end if;
  select * into v_existing
  from public.deal_hunter_cim_opportunity_claims
  where opportunity_id = p_opportunity_id
  for update;

  if found and not (v_existing.request_id = p_request_id or v_existing.request_id = any(coalesce(p_allowed_request_ids, array[]::text[]))) then
    return jsonb_build_object('claimed', false, 'reason', 'opportunity-already-claimed', 'claim', to_jsonb(v_existing));
  end if;

  insert into public.deal_hunter_cim_opportunity_claims (
    opportunity_id, request_id, recipient_email, state, claimed_at, updated_at, metadata
  ) values (
    p_opportunity_id, p_request_id, lower(p_recipient_email), 'active', p_claimed_at, p_claimed_at, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (opportunity_id) do update set
    request_id = excluded.request_id,
    recipient_email = excluded.recipient_email,
    state = 'active',
    updated_at = excluded.updated_at,
    metadata = excluded.metadata
  returning * into v_claim;

  return jsonb_build_object('claimed', true, 'reason', '', 'claim', to_jsonb(v_claim));
end;
$$;

create or replace function public.claim_deal_hunter_cim_recipient(
  p_recipient_email text,
  p_request_id text,
  p_opportunity_id text,
  p_claimed_at timestamptz,
  p_expires_at timestamptz,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_recipient text := lower(btrim(p_recipient_email));
  v_existing public.deal_hunter_cim_recipient_claims%rowtype;
  v_claim public.deal_hunter_cim_recipient_claims%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('deal-hunter-cim-recipient:' || v_recipient, 0));
  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = p_opportunity_id and status = 'active'
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'opportunity-not-current', 'claim', null);
  end if;
  select * into v_existing from public.deal_hunter_cim_recipient_claims
  where recipient_email = v_recipient for update;
  if found and v_existing.request_id <> p_request_id and v_existing.expires_at > p_claimed_at then
    return jsonb_build_object('claimed', false, 'reason', 'recipient-send-in-progress', 'claim', to_jsonb(v_existing));
  end if;
  insert into public.deal_hunter_cim_recipient_claims (
    recipient_email, request_id, opportunity_id, claimed_at, expires_at, metadata
  ) values (
    v_recipient, p_request_id, p_opportunity_id, p_claimed_at, p_expires_at, coalesce(p_metadata, '{}'::jsonb)
  ) on conflict (recipient_email) do update set
    request_id = excluded.request_id,
    opportunity_id = excluded.opportunity_id,
    claimed_at = excluded.claimed_at,
    expires_at = excluded.expires_at,
    metadata = excluded.metadata
  returning * into v_claim;
  return jsonb_build_object('claimed', true, 'reason', '', 'claim', to_jsonb(v_claim));
end;
$$;

create or replace function public.link_deal_hunter_opportunity_aliases(p_aliases jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_alias_key text;
  v_item jsonb;
  v_owner_ids text[] := array[]::text[];
  v_revalidated_owner_ids text[] := array[]::text[];
  v_opportunity_ids text[] := array[]::text[];
  v_locked_opportunity_count integer := 0;
  v_target_opportunity_id text;
  v_conflict_alias_key text;
  v_conflict_opportunity_id text;
  v_linked_aliases jsonb;
begin
  if jsonb_typeof(coalesce(p_aliases, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_aliases, '[]'::jsonb)) = 0 then
    return jsonb_build_object('linked', true, 'aliases', '[]'::jsonb);
  end if;
  if (
    select count(distinct value->>'opportunity_id')
    from jsonb_array_elements(p_aliases)
  ) <> 1 or exists (
    select 1
    from jsonb_array_elements(p_aliases)
    where nullif(btrim(value->>'opportunity_id'), '') is null
  ) then
    raise exception 'canonical alias batch must target exactly one opportunity';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_aliases)
    where nullif(btrim(value->>'alias_key'), '') is null
  ) then
    raise exception 'canonical alias key is required';
  end if;

  select value->>'opportunity_id'
  into v_target_opportunity_id
  from jsonb_array_elements(p_aliases)
  limit 1;

  -- Canonical alias/opportunity lock order: complete distinct alias keys in
  -- sorted order, alias advisory locks, owner discovery, sorted opportunity
  -- row locks, revalidation, then mutation.
  for v_alias_key in
    select distinct item.value->>'alias_key' as alias_key
    from jsonb_array_elements(p_aliases) as item(value)
    order by alias_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('deal-hunter-opportunity-alias:' || v_alias_key, 0)
    );
  end loop;

  select coalesce(
    array_agg(distinct alias.opportunity_id order by alias.opportunity_id),
    array[]::text[]
  ) into v_owner_ids
  from public.deal_hunter_opportunity_aliases as alias
  join jsonb_array_elements(p_aliases) as item(value)
    on item.value->>'alias_key' = alias.alias_key;

  select coalesce(
    array_agg(distinct candidate.opportunity_id order by candidate.opportunity_id),
    array[]::text[]
  ) into v_opportunity_ids
  from unnest(array_append(v_owner_ids, v_target_opportunity_id)) as candidate(opportunity_id);

  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = any(v_opportunity_ids)
  order by opportunity_id
  for update;
  get diagnostics v_locked_opportunity_count = row_count;

  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = v_target_opportunity_id and status = 'active';
  if not found then
    raise exception 'canonical alias target is superseded or otherwise not current';
  end if;

  if v_locked_opportunity_count <> cardinality(v_opportunity_ids) then
    select alias.alias_key, alias.opportunity_id
    into v_conflict_alias_key, v_conflict_opportunity_id
    from public.deal_hunter_opportunity_aliases as alias
    join jsonb_array_elements(p_aliases) as item(value)
      on item.value->>'alias_key' = alias.alias_key
    left join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = alias.opportunity_id
    where opportunity.opportunity_id is null
    order by alias.alias_key
    limit 1;
    if found then
      return jsonb_build_object(
        'linked', false,
        'conflictAliasKey', v_conflict_alias_key,
        'conflictOpportunityId', v_conflict_opportunity_id,
        'aliases', '[]'::jsonb
      );
    end if;
    raise exception 'canonical alias owner set changed while locking opportunities';
  end if;

  select coalesce(
    array_agg(distinct alias.opportunity_id order by alias.opportunity_id),
    array[]::text[]
  ) into v_revalidated_owner_ids
  from public.deal_hunter_opportunity_aliases as alias
  join jsonb_array_elements(p_aliases) as item(value)
    on item.value->>'alias_key' = alias.alias_key;
  if v_revalidated_owner_ids is distinct from v_owner_ids then
    raise exception 'canonical alias owner set changed while locking opportunities';
  end if;

  select alias.alias_key, alias.opportunity_id
  into v_conflict_alias_key, v_conflict_opportunity_id
  from public.deal_hunter_opportunity_aliases as alias
  join jsonb_array_elements(p_aliases) as item(value)
    on item.value->>'alias_key' = alias.alias_key
  where alias.opportunity_id <> item.value->>'opportunity_id'
  order by alias.alias_key
  limit 1;

  if found then
    return jsonb_build_object(
      'linked', false,
      'conflictAliasKey', v_conflict_alias_key,
      'conflictOpportunityId', v_conflict_opportunity_id,
      'aliases', '[]'::jsonb
    );
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_aliases)
    order by value->>'alias_key'
  loop
    insert into public.deal_hunter_opportunity_aliases (
      id, opportunity_id, alias_type, alias_value, alias_key, source,
      first_observed_at, last_observed_at, evidence_version, resolution_method,
      confidence_state, resolved_by, metadata
    ) values (
      v_item->>'id',
      v_item->>'opportunity_id',
      v_item->>'alias_type',
      v_item->>'alias_value',
      v_item->>'alias_key',
      nullif(v_item->>'source', ''),
      (v_item->>'first_observed_at')::timestamptz,
      (v_item->>'last_observed_at')::timestamptz,
      v_item->>'evidence_version',
      v_item->>'resolution_method',
      v_item->>'confidence_state',
      nullif(v_item->>'resolved_by', ''),
      coalesce(v_item->'metadata', '{}'::jsonb)
    ) on conflict (alias_key) do update set
      last_observed_at = excluded.last_observed_at,
      source = coalesce(excluded.source, public.deal_hunter_opportunity_aliases.source),
      metadata = excluded.metadata
    where public.deal_hunter_opportunity_aliases.opportunity_id = excluded.opportunity_id;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(alias) order by alias.alias_key), '[]'::jsonb)
  into v_linked_aliases
  from public.deal_hunter_opportunity_aliases as alias
  join jsonb_array_elements(p_aliases) as item(value)
    on item.value->>'alias_key' = alias.alias_key;

  return jsonb_build_object('linked', true, 'aliases', v_linked_aliases);
end;
$$;

create or replace function public.apply_deal_hunter_cim_identity_repair(repair_batch jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_manifest jsonb := coalesce(repair_batch->'manifest', '{}'::jsonb);
  v_manifest_id text := v_manifest->>'id';
  v_changed integer := 0;
  v_opportunities integer := 0;
  v_aliases integer := 0;
  v_requests integer := 0;
  v_imports integer := 0;
  v_communications integer := 0;
  v_email_events integer := 0;
  v_activities integer := 0;
  v_stopped integer := 0;
  v_repair_activities integer := 0;
begin
  if v_manifest_id is null or v_manifest_id = '' then
    raise exception 'repair manifest id is required';
  end if;
  if not coalesce((
    select outreach_paused
    from public.deal_hunter_cim_safety_settings
    where id = 'global'
    limit 1
  ), false) then
    raise exception 'CIM identity repair refused: persistently pause all Deal Hunter CIM outreach first';
  end if;
  if exists (select 1 from public.deal_hunter_cim_repair_manifests where id = v_manifest_id) then
    return jsonb_build_object('alreadyApplied', true, 'manifestId', v_manifest_id);
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'opportunityRecords', '[]'::jsonb)) loop
    insert into public.deal_hunter_opportunities (
      opportunity_id, created_at, updated_at, canonical_name, canonical_recipient,
      canonical_location, primary_submission_id, identity_version, status, metadata
    ) values (
      v_item->>'opportunity_id',
      (v_item->>'created_at')::timestamptz,
      (v_item->>'updated_at')::timestamptz,
      v_item->>'canonical_name',
      nullif(v_item->>'canonical_recipient', ''),
      nullif(v_item->>'canonical_location', ''),
      nullif(v_item->>'primary_submission_id', '')::uuid,
      v_item->>'identity_version',
      coalesce(nullif(v_item->>'status', ''), 'active'),
      coalesce(v_item->'metadata', '{}'::jsonb)
    ) on conflict (opportunity_id) do update set
      updated_at = excluded.updated_at,
      canonical_name = excluded.canonical_name,
      canonical_recipient = coalesce(excluded.canonical_recipient, public.deal_hunter_opportunities.canonical_recipient),
      canonical_location = coalesce(excluded.canonical_location, public.deal_hunter_opportunities.canonical_location),
      primary_submission_id = coalesce(excluded.primary_submission_id, public.deal_hunter_opportunities.primary_submission_id),
      metadata = excluded.metadata;
    get diagnostics v_changed = row_count;
    v_opportunities := v_opportunities + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'aliasRecords', '[]'::jsonb)) loop
    insert into public.deal_hunter_opportunity_aliases (
      id, opportunity_id, alias_type, alias_value, alias_key, source,
      first_observed_at, last_observed_at, evidence_version, resolution_method,
      confidence_state, resolved_by, metadata
    ) values (
      v_item->>'id',
      v_item->>'opportunity_id',
      v_item->>'alias_type',
      v_item->>'alias_value',
      v_item->>'alias_key',
      nullif(v_item->>'source', ''),
      (v_item->>'first_observed_at')::timestamptz,
      (v_item->>'last_observed_at')::timestamptz,
      v_item->>'evidence_version',
      v_item->>'resolution_method',
      v_item->>'confidence_state',
      nullif(v_item->>'resolved_by', ''),
      coalesce(v_item->'metadata', '{}'::jsonb)
    ) on conflict (alias_key) do update set
      last_observed_at = excluded.last_observed_at,
      metadata = excluded.metadata
    where public.deal_hunter_opportunity_aliases.opportunity_id = excluded.opportunity_id;
    get diagnostics v_changed = row_count;
    if v_changed = 0 and exists (
      select 1 from public.deal_hunter_opportunity_aliases
      where alias_key = v_item->>'alias_key' and opportunity_id <> v_item->>'opportunity_id'
    ) then
      raise exception 'canonical alias conflict for %', v_item->>'alias_key';
    end if;
    v_aliases := v_aliases + v_changed;
  end loop;

  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'requestLinks', '[]'::jsonb)) loop
    update public.deal_hunter_cim_requests set
      opportunity_id = v_item->>'opportunity_id',
      submission_id = coalesce(nullif(v_item->>'submission_id', '')::uuid, submission_id),
      updated_at = coalesce(nullif(v_item->>'updated_at', '')::timestamptz, updated_at)
    where id = v_item->>'id'
      and updated_at is not distinct from nullif(v_item->>'expected_updated_at', '')::timestamptz;
    get diagnostics v_changed = row_count;
    if v_changed = 0 and not exists (
      select 1 from public.deal_hunter_cim_requests
      where id = v_item->>'id'
        and opportunity_id = v_item->>'opportunity_id'
        and (nullif(v_item->>'submission_id', '') is null or submission_id = (v_item->>'submission_id')::uuid)
    ) then
      raise exception 'CIM identity repair request conflict for %', v_item->>'id';
    end if;
    v_requests := v_requests + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'importLinks', '[]'::jsonb)) loop
    update public.deal_hunter_crm_imports set
      opportunity_id = v_item->>'opportunity_id',
      submission_id = coalesce(nullif(v_item->>'submission_id', '')::uuid, submission_id),
      updated_at = coalesce(nullif(v_item->>'updated_at', '')::timestamptz, updated_at)
    where id = v_item->>'id'
      and updated_at is not distinct from nullif(v_item->>'expected_updated_at', '')::timestamptz;
    get diagnostics v_changed = row_count;
    if v_changed = 0 and not exists (
      select 1 from public.deal_hunter_crm_imports
      where id = v_item->>'id'
        and opportunity_id = v_item->>'opportunity_id'
        and (nullif(v_item->>'submission_id', '') is null or submission_id = (v_item->>'submission_id')::uuid)
    ) then
      raise exception 'CIM identity repair import conflict for %', v_item->>'id';
    end if;
    v_imports := v_imports + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'communicationLinks', '[]'::jsonb)) loop
    update public.crm_communications set
      opportunity_id = v_item->>'opportunity_id',
      submission_id = coalesce(nullif(v_item->>'submission_id', '')::uuid, submission_id),
      updated_at = coalesce(nullif(v_item->>'updated_at', '')::timestamptz, updated_at)
    where id = v_item->>'id'
      and updated_at is not distinct from nullif(v_item->>'expected_updated_at', '')::timestamptz;
    get diagnostics v_changed = row_count;
    if v_changed = 0 and not exists (
      select 1 from public.crm_communications
      where id = v_item->>'id'
        and opportunity_id = v_item->>'opportunity_id'
        and (nullif(v_item->>'submission_id', '') is null or submission_id = (v_item->>'submission_id')::uuid)
    ) then
      raise exception 'CIM identity repair communication conflict for %', v_item->>'id';
    end if;
    v_communications := v_communications + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'emailEventLinks', '[]'::jsonb)) loop
    update public.email_events set
      opportunity_id = v_item->>'opportunity_id',
      submission_id = coalesce(nullif(v_item->>'submission_id', '')::uuid, submission_id)
    where id = (v_item->>'id')::uuid;
    get diagnostics v_changed = row_count;
    v_email_events := v_email_events + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'activityLinks', '[]'::jsonb)) loop
    update public.crm_activity_events set
      opportunity_id = v_item->>'opportunity_id',
      submission_id = coalesce(nullif(v_item->>'submission_id', '')::uuid, submission_id)
    where id = (v_item->>'id')::uuid;
    get diagnostics v_changed = row_count;
    v_activities := v_activities + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'stopRequests', '[]'::jsonb)) loop
    update public.deal_hunter_cim_requests set
      request_state = 'stopped', follow_up_state = 'stopped', next_follow_up_at = null,
      updated_at = (v_item->>'updated_at')::timestamptz,
      last_activity_at = (v_item->>'updated_at')::timestamptz,
      metadata = coalesce(v_item->'metadata', '{}'::jsonb)
    where id = v_item->>'id'
      and (next_follow_up_at is not null or follow_up_state not in ('stopped', 'completed'));
    get diagnostics v_changed = row_count;
    v_stopped := v_stopped + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'repairActivities', '[]'::jsonb)) loop
    insert into public.crm_activity_events (
      id, submission_id, opportunity_id, created_at, actor, role, event_type, summary, metadata
    ) values (
      (v_item->>'id')::uuid,
      (v_item->>'submission_id')::uuid,
      nullif(v_item->>'opportunity_id', ''),
      (v_item->>'created_at')::timestamptz,
      v_item->>'actor',
      v_item->>'role',
      v_item->>'event_type',
      v_item->>'summary',
      coalesce(v_item->'metadata', '{}'::jsonb)
    ) on conflict (id) do nothing;
    get diagnostics v_changed = row_count;
    v_repair_activities := v_repair_activities + v_changed;
  end loop;

  insert into public.deal_hunter_cim_repair_manifests (
    id, created_at, updated_at, mode, status, actor, backup_reference, checksum, manifest, metadata
  ) values (
    v_manifest_id,
    (v_manifest->>'created_at')::timestamptz,
    (v_manifest->>'updated_at')::timestamptz,
    v_manifest->>'mode',
    v_manifest->>'status',
    v_manifest->>'actor',
    nullif(v_manifest->>'backup_reference', ''),
    v_manifest->>'checksum',
    coalesce(v_manifest->'manifest', '{}'::jsonb),
    coalesce(v_manifest->'metadata', '{}'::jsonb)
  );

  return jsonb_build_object(
    'alreadyApplied', false,
    'manifestId', v_manifest_id,
    'opportunities', v_opportunities,
    'aliases', v_aliases,
    'requests', v_requests,
    'imports', v_imports,
    'communications', v_communications,
    'emailEvents', v_email_events,
    'activities', v_activities,
    'stoppedSequences', v_stopped,
    'repairActivities', v_repair_activities
  );
end;
$$;

create or replace function public.create_cim_stage2_activation(p_activation jsonb)
returns public.deal_hunter_cim_stage2_activations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created_at timestamptz := (p_activation ->> 'created_at')::timestamptz;
  v_actor text := p_activation ->> 'actor';
  v_row public.deal_hunter_cim_stage2_activations%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('deal-hunter-cim-stage2-activation', 0));
  update public.deal_hunter_cim_stage2_activations
  set status = 'superseded', updated_at = v_created_at,
      superseded_at = v_created_at, superseded_by = v_actor
  where status = 'current';
  insert into public.deal_hunter_cim_stage2_activations
  select * from jsonb_populate_record(null::public.deal_hunter_cim_stage2_activations, p_activation || '{"status":"current"}'::jsonb)
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.claim_cim_stage2_decision(
  p_id uuid,
  p_claim_token text,
  p_claimed_at timestamptz,
  p_activation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opportunity_id text;
  v_row public.deal_hunter_cim_stage2_decisions%rowtype;
begin
  select opportunity_id into v_opportunity_id
  from public.deal_hunter_cim_stage2_decisions where id = p_id;
  if v_opportunity_id is null then return jsonb_build_object('claimed', false, 'decision', null); end if;
  perform pg_advisory_xact_lock(hashtextextended('deal-hunter-cim-stage2-decision:' || v_opportunity_id, 0));
  update public.deal_hunter_cim_stage2_decisions
  set decision_state = 'claimed', claim_token = p_claim_token, claimed_at = p_claimed_at,
      updated_at = p_claimed_at, activation_id = p_activation_id
  where id = p_id and decision_state = 'eligible' and claim_token is null
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.deal_hunter_cim_stage2_decisions where id = p_id;
    return jsonb_build_object('claimed', false, 'decision', to_jsonb(v_row));
  end if;
  return jsonb_build_object('claimed', true, 'decision', to_jsonb(v_row));
end;
$$;

create or replace function public.upsert_deal_hunter_opportunity_fact(p_fact jsonb)
returns public.deal_hunter_opportunity_facts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fact public.deal_hunter_opportunity_facts;
  v_created_at timestamptz;
  v_updated_at timestamptz;
begin
  if not (jsonb_typeof(p_fact) = 'object')
    or not (p_fact ?& array['id', 'opportunity_id', 'field', 'value', 'source', 'verified', 'actor', 'note', 'created_at', 'updated_at'])
    or p_fact - array['id', 'opportunity_id', 'field', 'value', 'source', 'verified', 'actor', 'note', 'created_at', 'updated_at'] <> '{}'::jsonb
    or jsonb_typeof(p_fact -> 'id') <> 'string'
    or jsonb_typeof(p_fact -> 'opportunity_id') <> 'string'
    or jsonb_typeof(p_fact -> 'field') <> 'string'
    or jsonb_typeof(p_fact -> 'value') <> 'string'
    or jsonb_typeof(p_fact -> 'source') <> 'string'
    or not (jsonb_typeof(p_fact -> 'verified') = 'boolean')
    or jsonb_typeof(p_fact -> 'actor') <> 'string'
    or jsonb_typeof(p_fact -> 'note') not in ('string', 'null')
    or jsonb_typeof(p_fact -> 'created_at') <> 'string'
    or jsonb_typeof(p_fact -> 'updated_at') <> 'string' then
    raise exception 'invalid operator fact payload' using errcode = '22023';
  end if;
  if (p_fact ->> 'id') <> btrim(p_fact ->> 'id') or char_length(p_fact ->> 'id') not between 1 and 240
    or (p_fact ->> 'opportunity_id') <> btrim(p_fact ->> 'opportunity_id') or char_length(p_fact ->> 'opportunity_id') not between 1 and 200
    or (p_fact ->> 'field') not in ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes')
    or (p_fact ->> 'value') <> btrim(p_fact ->> 'value') or char_length(p_fact ->> 'value') not between 1 and 4000
    or (p_fact ->> 'source') <> 'operator'
    or (p_fact ->> 'actor') <> btrim(p_fact ->> 'actor') or char_length(p_fact ->> 'actor') not between 1 and 200
    or ((p_fact ->> 'note') is not null and ((p_fact ->> 'note') <> btrim(p_fact ->> 'note') or char_length(p_fact ->> 'note') not between 1 and 4000))
    or (p_fact ->> 'created_at') <> btrim(p_fact ->> 'created_at') or char_length(p_fact ->> 'created_at') not between 1 and 80
    or (p_fact ->> 'updated_at') <> btrim(p_fact ->> 'updated_at') or char_length(p_fact ->> 'updated_at') not between 1 and 80 then
    raise exception 'operator fact payload is outside the allowed contract' using errcode = '22023';
  end if;
  begin
    v_created_at := (p_fact ->> 'created_at')::timestamptz;
    v_updated_at := (p_fact ->> 'updated_at')::timestamptz;
  exception when others then
    raise exception 'operator fact timestamps must be valid' using errcode = '22023';
  end;
  insert into public.deal_hunter_opportunity_facts (
    id, opportunity_id, field, value, source, verified, actor, note, created_at, updated_at
  ) values (
    p_fact ->> 'id', p_fact ->> 'opportunity_id', p_fact ->> 'field', p_fact ->> 'value', p_fact ->> 'source', (p_fact ->> 'verified')::boolean, p_fact ->> 'actor', p_fact ->> 'note', v_created_at, v_updated_at
  )
  on conflict (id) do update set
    field = excluded.field, value = excluded.value, source = excluded.source,
    verified = excluded.verified, actor = excluded.actor, note = excluded.note,
    updated_at = excluded.updated_at
  returning * into v_fact;
  return v_fact;
end;
$$;

create or replace function public.insert_current_deal_hunter_opportunity_fact(p_fact jsonb)
returns public.deal_hunter_opportunity_facts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fact public.deal_hunter_opportunity_facts;
  v_created_at timestamptz;
  v_updated_at timestamptz;
begin
  if not (jsonb_typeof(p_fact) = 'object')
    or not (p_fact ?& array['id', 'opportunity_id', 'field', 'value', 'source', 'verified', 'actor', 'note', 'created_at', 'updated_at'])
    or p_fact - array['id', 'opportunity_id', 'field', 'value', 'source', 'verified', 'actor', 'note', 'created_at', 'updated_at'] <> '{}'::jsonb
    or jsonb_typeof(p_fact -> 'id') <> 'string'
    or jsonb_typeof(p_fact -> 'opportunity_id') <> 'string'
    or jsonb_typeof(p_fact -> 'field') <> 'string'
    or jsonb_typeof(p_fact -> 'value') <> 'string'
    or jsonb_typeof(p_fact -> 'source') <> 'string'
    or not (jsonb_typeof(p_fact -> 'verified') = 'boolean')
    or jsonb_typeof(p_fact -> 'actor') <> 'string'
    or jsonb_typeof(p_fact -> 'note') not in ('string', 'null')
    or jsonb_typeof(p_fact -> 'created_at') <> 'string'
    or jsonb_typeof(p_fact -> 'updated_at') <> 'string' then
    raise exception 'invalid operator fact payload' using errcode = '22023';
  end if;
  if (p_fact ->> 'id') <> btrim(p_fact ->> 'id') or char_length(p_fact ->> 'id') not between 1 and 240
    or (p_fact ->> 'opportunity_id') <> btrim(p_fact ->> 'opportunity_id') or char_length(p_fact ->> 'opportunity_id') not between 1 and 200
    or (p_fact ->> 'field') not in ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes')
    or (p_fact ->> 'value') <> btrim(p_fact ->> 'value') or char_length(p_fact ->> 'value') not between 1 and 4000
    or (p_fact ->> 'source') <> 'operator'
    or (p_fact ->> 'actor') <> btrim(p_fact ->> 'actor') or char_length(p_fact ->> 'actor') not between 1 and 200
    or ((p_fact ->> 'note') is not null and ((p_fact ->> 'note') <> btrim(p_fact ->> 'note') or char_length(p_fact ->> 'note') not between 1 and 4000))
    or (p_fact ->> 'created_at') <> btrim(p_fact ->> 'created_at') or char_length(p_fact ->> 'created_at') not between 1 and 80
    or (p_fact ->> 'updated_at') <> btrim(p_fact ->> 'updated_at') or char_length(p_fact ->> 'updated_at') not between 1 and 80 then
    raise exception 'operator fact payload is outside the allowed contract' using errcode = '22023';
  end if;
  begin
    v_created_at := (p_fact ->> 'created_at')::timestamptz;
    v_updated_at := (p_fact ->> 'updated_at')::timestamptz;
  exception when others then
    raise exception 'operator fact timestamps must be valid' using errcode = '22023';
  end;
  perform 1 from public.deal_hunter_opportunities where opportunity_id = p_fact ->> 'opportunity_id' and status = 'active' for update;
  if not found then raise exception 'current canonical opportunity is unavailable' using errcode = 'P0002'; end if;
  insert into public.deal_hunter_opportunity_facts (id, opportunity_id, field, value, source, verified, actor, note, created_at, updated_at)
  values (p_fact ->> 'id', p_fact ->> 'opportunity_id', p_fact ->> 'field', p_fact ->> 'value', p_fact ->> 'source', (p_fact ->> 'verified')::boolean, p_fact ->> 'actor', p_fact ->> 'note', v_created_at, v_updated_at)
  returning * into v_fact;
  return v_fact;
end;
$$;

revoke all privileges on function public.insert_current_deal_hunter_opportunity_fact(jsonb) from public, anon, authenticated;
grant execute on function public.insert_current_deal_hunter_opportunity_fact(jsonb) to service_role;

revoke all privileges on function public.upsert_deal_hunter_opportunity_fact(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_deal_hunter_opportunity_fact(jsonb) to service_role;

create or replace function public.upsert_deal_hunter_opportunity_source_observation(
  p_id text, p_opportunity_id text, p_source_id text, p_source_name text, p_source_record_id text,
  p_field text, p_value text, p_observed_at timestamptz, p_created_at timestamptz, p_updated_at timestamptz
)
returns public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_observation public.deal_hunter_opportunity_source_observations;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_source_id)::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_opportunity_id, p_source_id)::text,
      0
    )
  );
  insert into public.deal_hunter_opportunity_source_observations (
    id, opportunity_id, source_id, source_name, source_record_id, field, value,
    observed_at, created_at, updated_at
  ) values (
    p_id, p_opportunity_id, p_source_id, p_source_name, p_source_record_id, p_field, p_value,
    p_observed_at, p_created_at, p_updated_at
  )
  on conflict (opportunity_id, source_id, source_record_id, field) do update set
    source_name = excluded.source_name, value = excluded.value, observed_at = excluded.observed_at,
    updated_at = excluded.updated_at,
    accepted_at = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_at end,
    accepted_run_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_run_id end,
    accepted_evidence_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_evidence_id end,
    publication_raw_header = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_header end,
    publication_raw_value = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_value end,
    publication_precision = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_precision end,
    publication_offset = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_offset end,
    publication_meaning = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_meaning end
  returning * into v_observation;
  return v_observation;
end;
$$;

revoke all privileges on function public.upsert_deal_hunter_opportunity_source_observation(
  text, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.upsert_deal_hunter_opportunity_source_observation(
  text, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz
) to service_role;

create or replace function public.replace_deal_hunter_opportunity_source_observation_snapshot(
  p_opportunity_id text,
  p_source_id text,
  p_source_name text,
  p_source_record_id text,
  p_observations jsonb
)
returns setof public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_observations) <> 'array' then
    raise exception 'source observation snapshot must be a JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_observations) as incoming(
      id text, opportunity_id text, source_id text, source_name text, source_record_id text,
      field text, value text, observed_at timestamptz, created_at timestamptz, updated_at timestamptz
    )
    where incoming.opportunity_id is distinct from p_opportunity_id
      or incoming.source_id is distinct from p_source_id
      or incoming.source_name is distinct from p_source_name
      or incoming.source_record_id is distinct from p_source_record_id
  ) then
    raise exception 'source observation snapshot rows must share one source record identity';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_source_id)::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_opportunity_id, p_source_id)::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_opportunity_id, p_source_id, p_source_record_id)::text,
      0
    )
  );

  delete from public.deal_hunter_opportunity_source_observations as stored
  where stored.opportunity_id = p_opportunity_id
    and stored.source_id = p_source_id
    and stored.source_record_id = p_source_record_id
    and not exists (
      select 1
      from jsonb_to_recordset(p_observations) as incoming(field text)
      where incoming.field = stored.field
    );

  insert into public.deal_hunter_opportunity_source_observations (
    id, opportunity_id, source_id, source_name, source_record_id, field, value,
    observed_at, created_at, updated_at
  )
  select
    incoming.id, incoming.opportunity_id, incoming.source_id, incoming.source_name, incoming.source_record_id,
    incoming.field, incoming.value, incoming.observed_at, incoming.created_at, incoming.updated_at
  from jsonb_to_recordset(p_observations) as incoming(
    id text, opportunity_id text, source_id text, source_name text, source_record_id text,
    field text, value text, observed_at timestamptz, created_at timestamptz, updated_at timestamptz
  )
  on conflict (opportunity_id, source_id, source_record_id, field) do update set
    source_name = excluded.source_name,
    value = excluded.value,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at,
    accepted_at = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_at end,
    accepted_run_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_run_id end,
    accepted_evidence_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_evidence_id end,
    publication_raw_header = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_header end,
    publication_raw_value = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_value end,
    publication_precision = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_precision end,
    publication_offset = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_offset end,
    publication_meaning = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_meaning end;

  return query
  select *
  from public.deal_hunter_opportunity_source_observations
  where opportunity_id = p_opportunity_id
    and source_id = p_source_id
    and source_record_id = p_source_record_id
  order by observed_at desc, id asc;
end;
$$;

-- Package 1A: additive, inert Pursue -> CIM Autopilot authorities.
-- This migration creates no activation, enrollment, campaign, touch, transmission,
-- CRM, or provider row and does not alter legacy CIM lifecycle data.

create table if not exists public.deal_hunter_owner_decision_events (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  idempotency_key text not null unique
    check (idempotency_key = btrim(idempotency_key) and char_length(idempotency_key) between 1 and 240),
  request_digest text not null check (char_length(request_digest) = 64),
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  action text not null check (action in ('pursue', 'watch', 'pass')),
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  expected_discovery_revision bigint not null check (expected_discovery_revision >= 0),
  expected_material_revision bigint not null check (expected_material_revision >= 0),
  observed_discovery_revision bigint not null check (observed_discovery_revision >= 0),
  observed_material_revision bigint not null check (observed_material_revision >= 0),
  selected_contact_reference_digest text
    check (selected_contact_reference_digest is null or char_length(selected_contact_reference_digest) = 64),
  policy_version text not null
    check (policy_version = btrim(policy_version) and char_length(policy_version) between 1 and 120),
  created_at timestamptz not null
);

create table if not exists public.deal_hunter_pursuit_enrollments (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  decision_event_id text not null unique
    references public.deal_hunter_owner_decision_events(id) on delete restrict,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  state text not null check (state in (
    'queued', 'waiting-on-eligibility', 'campaign-created', 'action-required', 'superseded'
  )),
  reason_code text check (reason_code is null or char_length(reason_code) between 1 and 160),
  authority_digest text not null check (char_length(authority_digest) = 64),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  row_version bigint not null default 1 check (row_version >= 1)
);

create unique index if not exists uq_deal_hunter_pursuit_enrollments_current_opportunity
  on public.deal_hunter_pursuit_enrollments(opportunity_id) where state <> 'superseded';

create table if not exists public.deal_hunter_opportunity_timezone_revisions (
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  revision bigint not null check (revision > 0),
  state text not null check (state in ('verified', 'derived', 'missing', 'ambiguous')),
  iana_timezone text check (
    iana_timezone is null or (iana_timezone = btrim(iana_timezone) and char_length(iana_timezone) between 1 and 120)
  ),
  evidence_type text not null
    check (evidence_type = btrim(evidence_type) and char_length(evidence_type) between 1 and 120),
  evidence_id text not null
    check (evidence_id = btrim(evidence_id) and char_length(evidence_id) between 1 and 240),
  evidence_digest text not null check (char_length(evidence_digest) = 64),
  resolver_version text not null
    check (resolver_version = btrim(resolver_version) and char_length(resolver_version) between 1 and 120),
  dataset_digest text not null check (char_length(dataset_digest) = 64),
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  created_at timestamptz not null,
  primary key(opportunity_id, revision),
  check (
    (state in ('verified', 'derived') and iana_timezone is not null)
    or (state in ('missing', 'ambiguous') and iana_timezone is null)
  )
);

create table if not exists public.deal_hunter_broker_conversations (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  recipient_authority_id text not null
    check (recipient_authority_id = btrim(recipient_authority_id)
      and char_length(recipient_authority_id) between 1 and 240),
  recipient_fingerprint text not null check (char_length(recipient_fingerprint) = 64),
  recipient_address text not null
    check (recipient_address = btrim(recipient_address) and char_length(recipient_address) between 3 and 320),
  sender_policy_version text not null
    check (sender_policy_version = btrim(sender_policy_version)
      and char_length(sender_policy_version) between 1 and 120),
  reply_policy_version text not null
    check (reply_policy_version = btrim(reply_policy_version)
      and char_length(reply_policy_version) between 1 and 120),
  reply_alias_token_digest text not null unique check (char_length(reply_alias_token_digest) = 64),
  rfc_thread_key text not null unique
    check (rfc_thread_key = btrim(rfc_thread_key) and char_length(rfc_thread_key) between 1 and 500),
  state text not null check (state in (
    'open', 'reply-review-required', 'responded', 'stopped', 'provider-ambiguous', 'closed'
  )),
  terminal_revision bigint not null default 0 check (terminal_revision >= 0),
  batching_policy_version text not null
    check (batching_policy_version = btrim(batching_policy_version)
      and char_length(batching_policy_version) between 1 and 120),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  row_version bigint not null default 1 check (row_version >= 1)
);

create table if not exists public.deal_hunter_cim_campaigns (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  generation bigint not null check (generation > 0),
  enrollment_id text not null references public.deal_hunter_pursuit_enrollments(id) on delete restrict,
  decision_event_id text not null references public.deal_hunter_owner_decision_events(id) on delete restrict,
  policy_version text not null
    check (policy_version = btrim(policy_version) and char_length(policy_version) between 1 and 120),
  template_version text not null
    check (template_version = btrim(template_version) and char_length(template_version) between 1 and 120),
  template_digest text not null check (char_length(template_digest) = 64),
  permission_version text not null
    check (permission_version = btrim(permission_version) and char_length(permission_version) between 1 and 120),
  permission_digest text not null check (char_length(permission_digest) = 64),
  permission_revision bigint not null check (permission_revision >= 0),
  permission_scope text not null
    check (permission_scope = btrim(permission_scope) and char_length(permission_scope) between 1 and 240),
  canonical_revision bigint not null check (canonical_revision >= 0),
  crm_submission_id uuid references public.contact_submissions(id) on delete restrict,
  crm_ownership_revision bigint not null check (crm_ownership_revision >= 0),
  recipient_authority_id text not null
    check (recipient_authority_id = btrim(recipient_authority_id)
      and char_length(recipient_authority_id) between 1 and 240),
  recipient_fingerprint text not null check (char_length(recipient_fingerprint) = 64),
  freshness_authority_digest text not null check (char_length(freshness_authority_digest) = 64),
  discovery_revision bigint not null check (discovery_revision >= 0),
  material_revision bigint not null check (material_revision >= 0),
  timezone_revision bigint not null check (timezone_revision > 0),
  conversation_id text not null references public.deal_hunter_broker_conversations(id) on delete restrict,
  state text not null check (state in (
    'queued', 'waiting-on-eligibility', 'initial-pending', 'active-follow-up',
    'action-required', 'responded', 'materials-received', 'stopped', 'expired',
    'provider-ambiguous'
  )),
  reason_code text check (reason_code is null or char_length(reason_code) between 1 and 160),
  initial_accepted_at timestamptz,
  local_expiry_at timestamptz,
  expiry_derivation jsonb not null default '{}'::jsonb,
  terminal_revision bigint not null default 0 check (terminal_revision >= 0),
  row_version bigint not null default 1 check (row_version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(opportunity_id, generation),
  foreign key(opportunity_id, timezone_revision)
    references public.deal_hunter_opportunity_timezone_revisions(opportunity_id, revision) on delete restrict
);

create unique index if not exists uq_deal_hunter_cim_campaigns_active_opportunity
  on public.deal_hunter_cim_campaigns(opportunity_id)
  where state in (
    'queued', 'waiting-on-eligibility', 'initial-pending', 'active-follow-up',
    'action-required', 'provider-ambiguous'
  );
create index if not exists idx_deal_hunter_cim_campaigns_conversation_state
  on public.deal_hunter_cim_campaigns(conversation_id, state, updated_at desc);

create table if not exists public.deal_hunter_cim_campaign_touches (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  campaign_id text not null references public.deal_hunter_cim_campaigns(id) on delete restrict,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  logical_slot text not null
    check (logical_slot = btrim(logical_slot) and char_length(logical_slot) between 1 and 160),
  kind text not null check (kind in (
    'initial', 'follow-up-1', 'follow-up-2', 'follow-up-3', 'weekday-follow-up'
  )),
  ordinal integer not null check (ordinal >= 0),
  due_at timestamptz not null,
  due_local text not null check (due_local = btrim(due_local) and char_length(due_local) between 1 and 120),
  timezone_revision bigint not null check (timezone_revision > 0),
  state text not null check (state in (
    'scheduled', 'claimed', 'provider-pending', 'accepted', 'definitive-failure',
    'ambiguous', 'cancelled-before-provider'
  )),
  claim_token_digest text check (claim_token_digest is null or char_length(claim_token_digest) = 64),
  claim_owner text check (claim_owner is null or char_length(claim_owner) between 1 and 200),
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  transmission_id text,
  outcome_code text check (outcome_code is null or char_length(outcome_code) between 1 and 160),
  terminal_reason text check (terminal_reason is null or char_length(terminal_reason) between 1 and 160),
  row_version bigint not null default 1 check (row_version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(campaign_id, logical_slot),
  foreign key(opportunity_id, timezone_revision)
    references public.deal_hunter_opportunity_timezone_revisions(opportunity_id, revision) on delete restrict
);

create index if not exists idx_deal_hunter_cim_campaign_touches_due
  on public.deal_hunter_cim_campaign_touches(state, due_at, id);

create table if not exists public.deal_hunter_cim_transmissions (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  conversation_id text not null references public.deal_hunter_broker_conversations(id) on delete restrict,
  member_digest text not null check (char_length(member_digest) = 64),
  preparation_generation bigint not null check (preparation_generation > 0),
  payload_version text not null
    check (payload_version = btrim(payload_version) and char_length(payload_version) between 1 and 120),
  payload_digest text not null check (char_length(payload_digest) = 64),
  from_address text not null check (char_length(from_address) between 3 and 320),
  to_addresses jsonb not null,
  cc_addresses jsonb not null default '[]'::jsonb,
  bcc_addresses jsonb not null default '[]'::jsonb,
  reply_to_address text not null check (char_length(reply_to_address) between 3 and 320),
  subject text not null check (char_length(subject) between 1 and 998),
  provider_idempotency_key text not null unique
    check (provider_idempotency_key = btrim(provider_idempotency_key)
      and char_length(provider_idempotency_key) between 1 and 240),
  communication_id text not null unique references public.crm_communications(id) on delete restrict,
  outbox_id text not null unique references public.crm_email_outbox(id) on delete restrict,
  state text not null check (state in (
    'prepared', 'final-gate-blocked', 'provider-pending', 'accepted',
    'definitive-failure', 'ambiguous', 'cancelled-before-provider'
  )),
  release_state text not null check (release_state in (
    'ordinary', 'awaiting-live-authorization', 'authorized'
  )),
  final_gate_authority_digest text
    check (final_gate_authority_digest is null or char_length(final_gate_authority_digest) = 64),
  campaign_terminal_revision bigint check (campaign_terminal_revision is null or campaign_terminal_revision >= 0),
  conversation_terminal_revision bigint
    check (conversation_terminal_revision is null or conversation_terminal_revision >= 0),
  invocation_authority_count integer not null default 0 check (invocation_authority_count in (0, 1)),
  provider_invocation_authorized_at timestamptz,
  boundary_nonce_digest text check (boundary_nonce_digest is null or char_length(boundary_nonce_digest) = 64),
  provider_seam_entered_at timestamptz,
  provider text check (provider is null or char_length(provider) between 1 and 80),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) between 1 and 240),
  provider_result_code text check (provider_result_code is null or char_length(provider_result_code) between 1 and 160),
  row_version bigint not null default 1 check (row_version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(conversation_id, member_digest, preparation_generation)
);

create unique index if not exists uq_deal_hunter_cim_transmission_provider_message
  on public.deal_hunter_cim_transmissions(provider, provider_message_id)
  where provider is not null and provider_message_id is not null;

alter table public.deal_hunter_cim_campaign_touches
  add constraint deal_hunter_cim_campaign_touches_transmission_fk
  foreign key(transmission_id) references public.deal_hunter_cim_transmissions(id) on delete restrict;

create table if not exists public.deal_hunter_cim_transmission_touches (
  transmission_id text not null references public.deal_hunter_cim_transmissions(id) on delete restrict,
  touch_id text not null references public.deal_hunter_cim_campaign_touches(id) on delete restrict,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  campaign_id text not null references public.deal_hunter_cim_campaigns(id) on delete restrict,
  display_ordinal integer not null check (display_ordinal > 0),
  cancelled_at timestamptz,
  cancellation_reason text
    check (cancellation_reason is null or char_length(cancellation_reason) between 1 and 160),
  created_at timestamptz not null,
  primary key(transmission_id, touch_id),
  check (
    (cancelled_at is null and cancellation_reason is null)
    or (cancelled_at is not null and cancellation_reason is not null)
  )
);

create unique index if not exists uq_deal_hunter_cim_transmission_touches_active_touch
  on public.deal_hunter_cim_transmission_touches(touch_id) where cancelled_at is null;

create table if not exists public.deal_hunter_cim_terminal_events (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  scope text not null check (scope in ('campaign', 'conversation')),
  scope_id text not null check (scope_id = btrim(scope_id) and char_length(scope_id) between 1 and 240),
  campaign_id text references public.deal_hunter_cim_campaigns(id) on delete restrict,
  conversation_id text references public.deal_hunter_broker_conversations(id) on delete restrict,
  revision bigint not null check (revision > 0),
  reason_code text not null
    check (reason_code = btrim(reason_code) and char_length(reason_code) between 1 and 160),
  evidence_type text not null
    check (evidence_type = btrim(evidence_type) and char_length(evidence_type) between 1 and 120),
  evidence_id text not null
    check (evidence_id = btrim(evidence_id) and char_length(evidence_id) between 1 and 240),
  observed_at timestamptz not null,
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  source text not null check (source = btrim(source) and char_length(source) between 1 and 120),
  metadata_digest text not null check (char_length(metadata_digest) = 64),
  created_at timestamptz not null,
  unique(scope, scope_id, revision),
  check (
    (scope = 'campaign' and campaign_id is not null
      and campaign_id = scope_id and conversation_id is null)
    or (scope = 'conversation' and conversation_id is not null
      and conversation_id = scope_id and campaign_id is null)
  )
);

create index if not exists idx_deal_hunter_cim_terminal_events_scope
  on public.deal_hunter_cim_terminal_events(scope, scope_id, revision desc);

create table if not exists public.deal_hunter_cim_safety_events (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  safety_run_id text not null
    check (safety_run_id = btrim(safety_run_id) and char_length(safety_run_id) between 1 and 240),
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  source_type text not null
    check (source_type = btrim(source_type) and char_length(source_type) between 1 and 120),
  source_run_id text not null
    check (source_run_id = btrim(source_run_id) and char_length(source_run_id) between 1 and 240),
  canonical_revision bigint not null check (canonical_revision >= 0),
  identity_exception_revision bigint not null check (identity_exception_revision >= 0),
  event_type text not null
    check (event_type = btrim(event_type) and char_length(event_type) between 1 and 160),
  evidence_id text not null
    check (evidence_id = btrim(evidence_id) and char_length(evidence_id) between 1 and 240),
  status text not null check (status in ('pending', 'stopped', 'review-required', 'no-op')),
  outcome_evidence_id text
    check (outcome_evidence_id is null or char_length(outcome_evidence_id) between 1 and 240),
  outcome_revision bigint check (outcome_revision is null or outcome_revision >= 0),
  created_at timestamptz not null,
  consumed_at timestamptz,
  updated_at timestamptz not null,
  unique(safety_run_id, opportunity_id, event_type, evidence_id)
);

create index if not exists idx_deal_hunter_cim_safety_events_run_status
  on public.deal_hunter_cim_safety_events(safety_run_id, status, created_at);

create table if not exists public.deal_hunter_cim_capability_activations (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  capability text not null check (capability in (
    'fl04a-safety', 'fl04b-enrollment', 'fl04b-initial', 'fl04c-followup', 'fl04c-batch'
  )),
  mode text not null check (mode in ('off', 'shadow', 'mailbox', 'canary', 'active')),
  status text not null check (status in ('current', 'superseded', 'withdrawn')),
  prerequisite_activation_id text
    references public.deal_hunter_cim_capability_activations(id) on delete restrict,
  prerequisite_evidence_id text
    check (prerequisite_evidence_id is null or char_length(prerequisite_evidence_id) between 1 and 240),
  prerequisite_evidence_hash text
    check (prerequisite_evidence_hash is null or char_length(prerequisite_evidence_hash) = 64),
  policy_hash text not null check (char_length(policy_hash) = 64),
  config_hash text not null check (char_length(config_hash) = 64),
  cohort_digest text check (cohort_digest is null or char_length(cohort_digest) = 64),
  permission_basis_digest text
    check (permission_basis_digest is null or char_length(permission_basis_digest) = 64),
  permission_revision bigint check (permission_revision is null or permission_revision >= 0),
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  reason text not null check (reason = btrim(reason) and char_length(reason) between 1 and 1000),
  confirmation text not null
    check (confirmation = btrim(confirmation) and char_length(confirmation) between 1 and 240),
  expires_at timestamptz,
  daily_cap integer check (daily_cap is null or daily_cap >= 0),
  recipient_cap integer check (recipient_cap is null or recipient_cap >= 0),
  provider_profile text not null
    check (provider_profile = btrim(provider_profile) and char_length(provider_profile) between 1 and 120),
  superseded_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create unique index if not exists uq_deal_hunter_cim_capability_activations_current
  on public.deal_hunter_cim_capability_activations(capability) where status = 'current';

create table if not exists public.deal_hunter_cim_live_provider_authorizations (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  activation_id text not null
    references public.deal_hunter_cim_capability_activations(id) on delete restrict,
  capability text not null check (capability in (
    'fl04a-safety', 'fl04b-enrollment', 'fl04b-initial', 'fl04c-followup', 'fl04c-batch'
  )),
  writer_path text not null
    check (writer_path = btrim(writer_path) and char_length(writer_path) between 1 and 240),
  transmission_id text not null references public.deal_hunter_cim_transmissions(id) on delete restrict,
  payload_digest text not null check (char_length(payload_digest) = 64),
  recipient_authority_digest text not null check (char_length(recipient_authority_digest) = 64),
  provider_profile text not null
    check (provider_profile = btrim(provider_profile) and char_length(provider_profile) between 1 and 120),
  maximum_calls integer not null check (maximum_calls = 1),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  withdrawn_at timestamptz,
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  reason text not null check (reason = btrim(reason) and char_length(reason) between 1 and 1000)
);

create unique index if not exists uq_deal_hunter_cim_live_authorizations_current
  on public.deal_hunter_cim_live_provider_authorizations(transmission_id, writer_path)
  where consumed_at is null and withdrawn_at is null;

create table if not exists public.deal_hunter_cim_audit_events (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  event_type text not null
    check (event_type = btrim(event_type) and char_length(event_type) between 1 and 160),
  opportunity_id text references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  campaign_id text references public.deal_hunter_cim_campaigns(id) on delete restrict,
  conversation_id text references public.deal_hunter_broker_conversations(id) on delete restrict,
  touch_id text references public.deal_hunter_cim_campaign_touches(id) on delete restrict,
  transmission_id text references public.deal_hunter_cim_transmissions(id) on delete restrict,
  activation_id text references public.deal_hunter_cim_capability_activations(id) on delete restrict,
  authorization_id text references public.deal_hunter_cim_live_provider_authorizations(id) on delete restrict,
  prior_state text check (prior_state is null or char_length(prior_state) between 1 and 120),
  next_state text check (next_state is null or char_length(next_state) between 1 and 120),
  reason_code text check (reason_code is null or char_length(reason_code) between 1 and 160),
  authority_digest text check (authority_digest is null or char_length(authority_digest) = 64),
  payload_digest text check (payload_digest is null or char_length(payload_digest) = 64),
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  source text not null check (source = btrim(source) and char_length(source) between 1 and 120),
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_deal_hunter_cim_audit_events_opportunity_time
  on public.deal_hunter_cim_audit_events(opportunity_id, occurred_at desc, id);

create or replace function public.reject_pursue_cim_immutable_row()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Pursue CIM retained evidence is immutable';
end;
$$;

create or replace function public.guard_pursue_cim_safety_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Pursue CIM safety evidence is retained';
  end if;
  if (to_jsonb(new) - 'status' - 'outcome_evidence_id' - 'outcome_revision' - 'consumed_at' - 'updated_at')
      is distinct from
     (to_jsonb(old) - 'status' - 'outcome_evidence_id' - 'outcome_revision' - 'consumed_at' - 'updated_at') then
    raise exception 'Pursue CIM safety evidence payload is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.guard_pursue_cim_transmission_payload()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Pursue CIM transmission evidence is retained';
  end if;
  if (to_jsonb(new) - 'state' - 'release_state' - 'final_gate_authority_digest'
      - 'campaign_terminal_revision' - 'conversation_terminal_revision'
      - 'invocation_authority_count' - 'provider_invocation_authorized_at'
      - 'boundary_nonce_digest' - 'provider_seam_entered_at' - 'provider'
      - 'provider_message_id' - 'provider_result_code' - 'row_version' - 'updated_at')
      is distinct from
     (to_jsonb(old) - 'state' - 'release_state' - 'final_gate_authority_digest'
      - 'campaign_terminal_revision' - 'conversation_terminal_revision'
      - 'invocation_authority_count' - 'provider_invocation_authorized_at'
      - 'boundary_nonce_digest' - 'provider_seam_entered_at' - 'provider'
      - 'provider_message_id' - 'provider_result_code' - 'row_version' - 'updated_at') then
    raise exception 'Prepared Pursue CIM transmission payload is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.guard_pursue_cim_transmission_membership()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Pursue CIM transmission membership is retained';
  end if;
  if (to_jsonb(new) - 'cancelled_at' - 'cancellation_reason')
      is distinct from (to_jsonb(old) - 'cancelled_at' - 'cancellation_reason') then
    raise exception 'Pursue CIM transmission membership identity is immutable';
  end if;
  return new;
end;
$$;

create trigger guard_deal_hunter_owner_decision_events
  before update or delete on public.deal_hunter_owner_decision_events
  for each row execute function public.reject_pursue_cim_immutable_row();
create trigger guard_deal_hunter_timezone_revisions
  before update or delete on public.deal_hunter_opportunity_timezone_revisions
  for each row execute function public.reject_pursue_cim_immutable_row();
create trigger guard_deal_hunter_cim_terminal_events
  before update or delete on public.deal_hunter_cim_terminal_events
  for each row execute function public.reject_pursue_cim_immutable_row();
create trigger guard_deal_hunter_cim_audit_events
  before update or delete on public.deal_hunter_cim_audit_events
  for each row execute function public.reject_pursue_cim_immutable_row();
create trigger guard_deal_hunter_cim_safety_events
  before update or delete on public.deal_hunter_cim_safety_events
  for each row execute function public.guard_pursue_cim_safety_event();
create trigger guard_deal_hunter_cim_transmissions
  before update or delete on public.deal_hunter_cim_transmissions
  for each row execute function public.guard_pursue_cim_transmission_payload();
create trigger guard_deal_hunter_cim_transmission_touches
  before update or delete on public.deal_hunter_cim_transmission_touches
  for each row execute function public.guard_pursue_cim_transmission_membership();

alter table public.deal_hunter_owner_decision_events enable row level security;
alter table public.deal_hunter_pursuit_enrollments enable row level security;
alter table public.deal_hunter_opportunity_timezone_revisions enable row level security;
alter table public.deal_hunter_broker_conversations enable row level security;
alter table public.deal_hunter_cim_campaigns enable row level security;
alter table public.deal_hunter_cim_campaign_touches enable row level security;
alter table public.deal_hunter_cim_transmissions enable row level security;
alter table public.deal_hunter_cim_transmission_touches enable row level security;
alter table public.deal_hunter_cim_terminal_events enable row level security;
alter table public.deal_hunter_cim_safety_events enable row level security;
alter table public.deal_hunter_cim_capability_activations enable row level security;
alter table public.deal_hunter_cim_live_provider_authorizations enable row level security;
alter table public.deal_hunter_cim_audit_events enable row level security;

revoke all privileges on table
  public.deal_hunter_owner_decision_events,
  public.deal_hunter_pursuit_enrollments,
  public.deal_hunter_opportunity_timezone_revisions,
  public.deal_hunter_broker_conversations,
  public.deal_hunter_cim_campaigns,
  public.deal_hunter_cim_campaign_touches,
  public.deal_hunter_cim_transmissions,
  public.deal_hunter_cim_transmission_touches,
  public.deal_hunter_cim_terminal_events,
  public.deal_hunter_cim_safety_events,
  public.deal_hunter_cim_capability_activations,
  public.deal_hunter_cim_live_provider_authorizations,
  public.deal_hunter_cim_audit_events
from public, anon, authenticated;

revoke all privileges on table
  public.deal_hunter_owner_decision_events,
  public.deal_hunter_pursuit_enrollments,
  public.deal_hunter_opportunity_timezone_revisions,
  public.deal_hunter_broker_conversations,
  public.deal_hunter_cim_campaigns,
  public.deal_hunter_cim_campaign_touches,
  public.deal_hunter_cim_transmissions,
  public.deal_hunter_cim_transmission_touches,
  public.deal_hunter_cim_terminal_events,
  public.deal_hunter_cim_safety_events,
  public.deal_hunter_cim_capability_activations,
  public.deal_hunter_cim_live_provider_authorizations,
  public.deal_hunter_cim_audit_events
from service_role;

grant select, insert, update, delete on table
  public.deal_hunter_owner_decision_events,
  public.deal_hunter_pursuit_enrollments,
  public.deal_hunter_opportunity_timezone_revisions,
  public.deal_hunter_broker_conversations,
  public.deal_hunter_cim_campaigns,
  public.deal_hunter_cim_campaign_touches,
  public.deal_hunter_cim_transmissions,
  public.deal_hunter_cim_transmission_touches,
  public.deal_hunter_cim_terminal_events,
  public.deal_hunter_cim_safety_events,
  public.deal_hunter_cim_capability_activations,
  public.deal_hunter_cim_live_provider_authorizations,
  public.deal_hunter_cim_audit_events
to service_role;

revoke all on function public.reject_pursue_cim_immutable_row() from public, anon, authenticated;
revoke all on function public.guard_pursue_cim_safety_event() from public, anon, authenticated;
revoke all on function public.guard_pursue_cim_transmission_payload() from public, anon, authenticated;
revoke all on function public.guard_pursue_cim_transmission_membership() from public, anon, authenticated;
grant execute on function public.reject_pursue_cim_immutable_row() to service_role;
grant execute on function public.guard_pursue_cim_safety_event() to service_role;
grant execute on function public.guard_pursue_cim_transmission_payload() to service_role;
grant execute on function public.guard_pursue_cim_transmission_membership() to service_role;

revoke all privileges on function public.replace_deal_hunter_opportunity_source_observation_snapshot(
  text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_deal_hunter_opportunity_source_observation_snapshot(
  text, text, text, text, jsonb
) to service_role;


create or replace function public.replace_deal_hunter_source_snapshot_internal(
  p_source_id text,
  p_source_name text,
  p_records jsonb
)
returns setof public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record_count integer;
begin
  if p_source_id is null or p_source_id <> btrim(p_source_id) or char_length(p_source_id) not between 1 and 160
    or p_source_name is null or p_source_name <> btrim(p_source_name) or char_length(p_source_name) not between 1 and 220 then
    raise exception 'complete source snapshot identity is outside the allowed contract' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_records) <> 'array' then
    raise exception 'complete source snapshot records must be a JSON array' using errcode = '22023';
  end if;
  v_record_count := pg_catalog.jsonb_array_length(p_records);
  if v_record_count not between 1 and 10000 then
    raise exception 'complete source snapshot must contain between 1 and 10000 records' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    where pg_catalog.jsonb_typeof(record.value) <> 'object'
      or not (record.value ?& array['opportunity_id', 'source_id', 'source_name', 'source_record_id', 'observations'])
      or record.value - array['opportunity_id', 'source_id', 'source_name', 'source_record_id', 'observations'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(record.value -> 'opportunity_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_name') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_record_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'observations') <> 'array'
      or (record.value ->> 'opportunity_id') <> btrim(record.value ->> 'opportunity_id')
      or char_length(record.value ->> 'opportunity_id') not between 1 and 200
      or (record.value ->> 'source_id') is distinct from p_source_id
      or (record.value ->> 'source_name') is distinct from p_source_name
      or (record.value ->> 'source_record_id') <> btrim(record.value ->> 'source_record_id')
      or char_length(record.value ->> 'source_record_id') not between 1 and 200
      or pg_catalog.jsonb_array_length(record.value -> 'observations') > 51
  ) then
    raise exception 'complete source snapshot records are outside the allowed contract' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    group by record.value ->> 'source_record_id'
    having count(*) > 1
  ) then
    raise exception 'complete source snapshot record identities must be unique within the source' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
    where pg_catalog.jsonb_typeof(observation.value) <> 'object'
      or not (observation.value ?& array['id', 'opportunity_id', 'source_id', 'source_name', 'source_record_id', 'field', 'value', 'observed_at', 'created_at', 'updated_at'])
      or observation.value - array['id', 'opportunity_id', 'source_id', 'source_name', 'source_record_id', 'field', 'value', 'observed_at', 'created_at', 'updated_at'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(observation.value -> 'id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'opportunity_id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'source_id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'source_name') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'source_record_id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'field') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'value') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'observed_at') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'created_at') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'updated_at') <> 'string'
      or (observation.value ->> 'opportunity_id') is distinct from (record.value ->> 'opportunity_id')
      or (observation.value ->> 'source_id') is distinct from p_source_id
      or (observation.value ->> 'source_name') is distinct from p_source_name
      or (observation.value ->> 'source_record_id') is distinct from (record.value ->> 'source_record_id')
      or (observation.value ->> 'id') <> btrim(observation.value ->> 'id')
      or char_length(observation.value ->> 'id') not between 1 and 240
      or (observation.value ->> 'field') not in (
        'name', 'business_name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
        'annual_profit', 'annual_revenue', 'asking_price', 'profit_multiple', 'net_margin', 'years_established',
        'remote_flag', 'franchise_flag', 'five_years_flag', 'broker_name', 'broker_company', 'broker_contact', 'broker_email',
        'broker_phone', 'company', 'role', 'seller_name', 'seller_email', 'seller_phone', 'reason_for_sale', 'real_estate_included',
        'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes', 'listing_url',
        'listing_source', 'listing_id', 'deal_key', 'source_identity', 'date_added', 'last_updated',
        'business_website', 'prospectus_url', 'ttm_revenue', 'ttm_ebitda', 'ebitda_multiple', 'business_age',
        'sba_eligible', 'lead_type'
      )
      or (observation.value ->> 'value') <> btrim(observation.value ->> 'value')
      or char_length(observation.value ->> 'value') not between 1 and 5000
      or (observation.value ->> 'observed_at') <> btrim(observation.value ->> 'observed_at')
      or char_length(observation.value ->> 'observed_at') not between 1 and 80
      or (observation.value ->> 'created_at') <> btrim(observation.value ->> 'created_at')
      or char_length(observation.value ->> 'created_at') not between 1 and 80
      or (observation.value ->> 'updated_at') <> btrim(observation.value ->> 'updated_at')
      or char_length(observation.value ->> 'updated_at') not between 1 and 80
  ) then
    raise exception 'complete source snapshot observations are outside the allowed contract' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
    group by record.value ->> 'source_record_id', observation.value ->> 'field'
    having count(*) > 1
  ) then
    raise exception 'complete source snapshot observation fields must be unique per source record' using errcode = '22023';
  end if;
  begin
    perform
      (observation.value ->> 'observed_at')::timestamptz,
      (observation.value ->> 'created_at')::timestamptz,
      (observation.value ->> 'updated_at')::timestamptz
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value);
  exception when others then
    raise exception 'complete source snapshot timestamps must be valid' using errcode = '22023';
  end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_source_id)::text,
      0
    )
  );

  with incoming as materialized (
    select
      record.value ->> 'opportunity_id' as opportunity_id,
      record.value ->> 'source_record_id' as source_record_id,
      observation.value ->> 'field' as field
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
  )
  delete from public.deal_hunter_opportunity_source_observations as stored
  where stored.source_id = p_source_id
    and not exists (
      select 1
      from incoming
      where incoming.opportunity_id = stored.opportunity_id
        and incoming.source_record_id = stored.source_record_id
        and incoming.field = stored.field
    );

  insert into public.deal_hunter_opportunity_source_observations (
    id, opportunity_id, source_id, source_name, source_record_id, field, value,
    observed_at, created_at, updated_at
  )
  select
    observation.value ->> 'id',
    record.value ->> 'opportunity_id',
    p_source_id,
    p_source_name,
    record.value ->> 'source_record_id',
    observation.value ->> 'field',
    observation.value ->> 'value',
    (observation.value ->> 'observed_at')::timestamptz,
    (observation.value ->> 'created_at')::timestamptz,
    (observation.value ->> 'updated_at')::timestamptz
  from pg_catalog.jsonb_array_elements(p_records) as record(value)
  cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
  on conflict (opportunity_id, source_id, source_record_id, field) do update set
    source_name = excluded.source_name,
    value = excluded.value,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at;

  return query
  select *
  from public.deal_hunter_opportunity_source_observations
  where source_id = p_source_id
  order by observed_at desc, id asc;
end;
$$;

revoke all privileges on function public.replace_deal_hunter_source_snapshot_internal(
  text, text, jsonb
) from public, anon, authenticated, service_role;

-- The RPC validates the serializable Sheet policy and exact payload
-- self-consistency; it cannot itself attest a remote fetch was complete.
-- The collector establishes that fact before minting its in-process one-shot
-- admission capability. Durable external attestation would require an
-- ingestion ledger or provider-owned fetch outside this Phase 1 boundary.
create or replace function public.replace_admitted_complete_google_sheet_source_snapshot(
  p_admission jsonb,
  p_records jsonb
)
returns setof public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_id text;
  v_source_name text;
  v_source_slot integer;
  v_record_count integer;
  v_observation_count integer;
  v_actual_observation_count integer;
  v_snapshot_digest text;
  v_record_digest text;
  v_actual_digest text;
begin
  if pg_catalog.jsonb_typeof(p_admission) <> 'object'
    or p_admission - array[
      'policy', 'source_id', 'source_name', 'source_slot', 'record_count',
      'observation_count', 'source_record_ids', 'snapshot_digest'
    ] <> '{}'::jsonb
    or not (p_admission ?& array[
      'policy', 'source_id', 'source_name', 'source_slot', 'record_count',
      'observation_count', 'source_record_ids', 'snapshot_digest'
    ])
    or pg_catalog.jsonb_typeof(p_admission -> 'policy') <> 'string'
    or pg_catalog.jsonb_typeof(p_admission -> 'source_id') <> 'string'
    or pg_catalog.jsonb_typeof(p_admission -> 'source_name') <> 'string'
    or pg_catalog.jsonb_typeof(p_admission -> 'source_slot') <> 'number'
    or pg_catalog.jsonb_typeof(p_admission -> 'record_count') <> 'number'
    or pg_catalog.jsonb_typeof(p_admission -> 'observation_count') <> 'number'
    or pg_catalog.jsonb_typeof(p_admission -> 'source_record_ids') <> 'array'
    or pg_catalog.jsonb_typeof(p_admission -> 'snapshot_digest') <> 'string'
  then
    raise exception 'complete Google Sheet source snapshot admission is outside the allowed contract' using errcode = '22023';
  end if;
  if p_admission ->> 'policy' <> 'complete-google-sheet-source-snapshot-v1'
    or p_admission ->> 'source_slot' !~ '^(0|[1-9][0-9]{0,3})$'
    or p_admission ->> 'record_count' !~ '^[1-9][0-9]*$'
    or p_admission ->> 'observation_count' !~ '^[1-9][0-9]*$'
    or p_admission ->> 'snapshot_digest' !~ '^[a-f0-9]{32}$'
  then
    raise exception 'complete Google Sheet source snapshot admission is malformed' using errcode = '22023';
  end if;

  v_source_id := p_admission ->> 'source_id';
  v_source_name := p_admission ->> 'source_name';
  v_source_slot := (p_admission ->> 'source_slot')::integer;
  v_record_count := (p_admission ->> 'record_count')::integer;
  v_observation_count := (p_admission ->> 'observation_count')::integer;
  v_snapshot_digest := p_admission ->> 'snapshot_digest';
  if v_source_id <> btrim(v_source_id) or char_length(v_source_id) not between 1 and 160
    or v_source_name <> btrim(v_source_name) or char_length(v_source_name) not between 1 and 220
    or v_source_slot not between 0 and 9999
    or v_source_id !~ '^sheet-[0-9]+$'
    or v_source_id <> ('sheet-' || v_source_slot::text)
    or v_record_count not between 1 and 10000
    or v_observation_count not between 1 and 510000
    or pg_catalog.jsonb_array_length(p_admission -> 'source_record_ids') <> v_record_count
  then
    raise exception 'complete Google Sheet source snapshot admission is not an admitted Sheet scope' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_admission -> 'source_record_ids') as identity(value)
    where pg_catalog.jsonb_typeof(identity.value) <> 'string'
      or (identity.value #>> '{}') <> btrim(identity.value #>> '{}')
      or char_length(identity.value #>> '{}') not between 1 and 200
  )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_admission -> 'source_record_ids') as identity(value)
      group by identity.value #>> '{}'
      having count(*) > 1
    )
  then
    raise exception 'complete Google Sheet source snapshot admission identities are outside the allowed contract' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_records) <> 'array'
    or pg_catalog.jsonb_array_length(p_records) <> v_record_count
  then
    raise exception 'complete Google Sheet source snapshot records do not match the admission' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    where pg_catalog.jsonb_typeof(record.value) <> 'object'
      or not (record.value ?& array['opportunity_id', 'source_id', 'source_name', 'source_record_id', 'observations'])
      or record.value - array['opportunity_id', 'source_id', 'source_name', 'source_record_id', 'observations'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(record.value -> 'opportunity_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_name') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_record_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'observations') <> 'array'
      or (record.value ->> 'opportunity_id') <> btrim(record.value ->> 'opportunity_id')
      or char_length(record.value ->> 'opportunity_id') not between 1 and 200
      or (record.value ->> 'source_id') is distinct from v_source_id
      or (record.value ->> 'source_name') is distinct from v_source_name
      or (record.value ->> 'source_record_id') <> btrim(record.value ->> 'source_record_id')
      or char_length(record.value ->> 'source_record_id') not between 1 and 200
      or pg_catalog.jsonb_array_length(record.value -> 'observations') not between 1 and 51
  ) then
    raise exception 'complete Google Sheet source snapshot records are outside the allowed contract' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    group by record.value ->> 'source_record_id'
    having count(*) > 1
  )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_records) as record(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_admission -> 'source_record_ids') as identity(value)
        where identity.value #>> '{}' = record.value ->> 'source_record_id'
      )
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_admission -> 'source_record_ids') as identity(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_records) as record(value)
        where record.value ->> 'source_record_id' = identity.value #>> '{}'
      )
    )
  then
    raise exception 'complete Google Sheet source snapshot records do not match the admitted identity set' using errcode = '22023';
  end if;
  select count(*)
  into v_actual_observation_count
  from pg_catalog.jsonb_array_elements(p_records) as record(value)
  cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value);
  if v_actual_observation_count <> v_observation_count then
    raise exception 'complete Google Sheet source snapshot observation count does not match the admission' using errcode = '22023';
  end if;

  select coalesce(
    pg_catalog.string_agg(
      pg_catalog.concat_ws(
        '|',
        'r',
        pg_catalog.encode(pg_catalog.convert_to(record.value ->> 'opportunity_id', 'UTF8'), 'hex'),
        pg_catalog.encode(pg_catalog.convert_to(record.value ->> 'source_id', 'UTF8'), 'hex'),
        pg_catalog.encode(pg_catalog.convert_to(record.value ->> 'source_name', 'UTF8'), 'hex'),
        pg_catalog.encode(pg_catalog.convert_to(record.value ->> 'source_record_id', 'UTF8'), 'hex'),
        pg_catalog.jsonb_array_length(record.value -> 'observations')::text,
        (
          select pg_catalog.string_agg(
            pg_catalog.concat_ws(
              '|',
              'o',
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'id', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'opportunity_id', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'source_id', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'source_name', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'source_record_id', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'field', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'value', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'observed_at', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'created_at', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'updated_at', 'UTF8'), 'hex')
            ),
            '|' order by observation.ordinality
          )
          from pg_catalog.jsonb_array_elements(record.value -> 'observations') with ordinality as observation(value, ordinality)
        )
      ),
      '|' order by record.ordinality
    ),
    ''
  )
  into v_record_digest
  from pg_catalog.jsonb_array_elements(p_records) with ordinality as record(value, ordinality);
  v_actual_digest := pg_catalog.md5(pg_catalog.concat_ws(
    '|',
    'complete-google-sheet-source-snapshot-v1',
    pg_catalog.encode(pg_catalog.convert_to(v_source_id, 'UTF8'), 'hex'),
    pg_catalog.encode(pg_catalog.convert_to(v_source_name, 'UTF8'), 'hex'),
    v_source_slot::text,
    v_record_count::text,
    v_observation_count::text,
    v_record_digest
  ));
  if v_actual_digest <> v_snapshot_digest then
    raise exception 'complete Google Sheet source snapshot digest does not match the admission' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(v_source_id)::text,
      0
    )
  );
  return query
  select *
  from public.replace_deal_hunter_source_snapshot_internal(v_source_id, v_source_name, p_records);
end;
$$;

revoke all privileges on function public.replace_admitted_complete_google_sheet_source_snapshot(
  jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_admitted_complete_google_sheet_source_snapshot(
  jsonb, jsonb
) to service_role;

alter table public.deal_hunter_opportunities enable row level security;
alter table public.deal_hunter_opportunity_facts enable row level security;
alter table public.deal_hunter_opportunity_source_observations enable row level security;
alter table public.deal_hunter_opportunity_aliases enable row level security;
alter table public.deal_hunter_identity_exceptions enable row level security;
alter table public.deal_hunter_cim_opportunity_claims enable row level security;
alter table public.deal_hunter_cim_recipient_overrides enable row level security;
alter table public.deal_hunter_cim_recipient_claims enable row level security;
alter table public.deal_hunter_cim_safety_settings enable row level security;
alter table public.deal_hunter_cim_repair_manifests enable row level security;
alter table public.deal_hunter_cim_stage2_activations enable row level security;
alter table public.deal_hunter_cim_stage2_runs enable row level security;
alter table public.deal_hunter_cim_stage2_decisions enable row level security;

revoke all privileges on table public.deal_hunter_opportunities from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_opportunity_facts from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_opportunity_source_observations from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_opportunity_aliases from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_identity_exceptions from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_opportunity_claims from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_recipient_overrides from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_recipient_claims from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_safety_settings from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_repair_manifests from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_stage2_activations from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_stage2_runs from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_stage2_decisions from public, anon, authenticated;
revoke all privileges on function public.upsert_deal_hunter_opportunity(jsonb) from public, anon, authenticated;
revoke all privileges on function public.create_deal_hunter_opportunity_with_aliases(jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all privileges on function public.claim_deal_hunter_cim_opportunity(text, text, text, text[], timestamptz, jsonb) from public, anon, authenticated;
revoke all privileges on function public.claim_deal_hunter_cim_recipient(text, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
revoke all privileges on function public.link_deal_hunter_opportunity_aliases(jsonb) from public, anon, authenticated;
revoke all privileges on function public.apply_deal_hunter_cim_identity_repair(jsonb) from public, anon, authenticated;
revoke all privileges on function public.create_cim_stage2_activation(jsonb) from public, anon, authenticated;
revoke all privileges on function public.claim_cim_stage2_decision(uuid, text, timestamptz, uuid) from public, anon, authenticated;

grant all privileges on table public.deal_hunter_opportunities to service_role;
grant all privileges on table public.deal_hunter_opportunity_facts to service_role;
grant all privileges on table public.deal_hunter_opportunity_source_observations to service_role;
grant all privileges on table public.deal_hunter_opportunity_aliases to service_role;
grant all privileges on table public.deal_hunter_identity_exceptions to service_role;
grant all privileges on table public.deal_hunter_cim_opportunity_claims to service_role;
grant all privileges on table public.deal_hunter_cim_recipient_overrides to service_role;
grant all privileges on table public.deal_hunter_cim_recipient_claims to service_role;
grant all privileges on table public.deal_hunter_cim_safety_settings to service_role;
grant all privileges on table public.deal_hunter_cim_repair_manifests to service_role;
grant all privileges on table public.deal_hunter_cim_stage2_activations to service_role;
grant all privileges on table public.deal_hunter_cim_stage2_runs to service_role;
grant all privileges on table public.deal_hunter_cim_stage2_decisions to service_role;
grant execute on function public.upsert_deal_hunter_opportunity(jsonb) to service_role;
grant execute on function public.create_deal_hunter_opportunity_with_aliases(jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.claim_deal_hunter_cim_opportunity(text, text, text, text[], timestamptz, jsonb) to service_role;
grant execute on function public.claim_deal_hunter_cim_recipient(text, text, text, timestamptz, timestamptz, jsonb) to service_role;
grant execute on function public.link_deal_hunter_opportunity_aliases(jsonb) to service_role;
grant execute on function public.apply_deal_hunter_cim_identity_repair(jsonb) to service_role;
grant execute on function public.create_cim_stage2_activation(jsonb) to service_role;
grant execute on function public.claim_cim_stage2_decision(uuid, text, timestamptz, uuid) to service_role;

alter table public.deal_hunter_deal_os_imports
  add column if not exists source_row_count integer not null default 0,
  add column if not exists accepted_row_count integer not null default 0,
  add column if not exists rejected_row_count integer not null default 0,
  add column if not exists canonical_record_count integer not null default 0,
  add column if not exists parser_version text not null default 'deal-os-export-v1',
  add column if not exists row_accounting jsonb not null default '[]'::jsonb;

alter table public.contact_submissions
  add column if not exists deal_hunter_opportunity_id text
  references public.deal_hunter_opportunities(opportunity_id) on delete restrict;

create unique index if not exists idx_deal_hunter_crm_imports_unique_opportunity
  on public.deal_hunter_crm_imports(opportunity_id)
  where opportunity_id is not null and opportunity_id <> '';
create unique index if not exists idx_contact_submissions_deal_hunter_opportunity
  on public.contact_submissions(deal_hunter_opportunity_id)
  where deal_hunter_opportunity_id is not null and deal_hunter_opportunity_id <> '';

create table if not exists public.deal_hunter_crm_reconciliation_runs (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  import_id uuid not null references public.deal_hunter_deal_os_imports(id) on delete restrict,
  mode text not null,
  plan_digest text not null,
  idempotency_key text not null unique,
  status text not null,
  requested_by text,
  counts jsonb not null default '{}'::jsonb,
  plan jsonb not null default '{}'::jsonb,
  results jsonb not null default '{}'::jsonb,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_crm_reconciliation_items (
  id text primary key,
  run_id text not null references public.deal_hunter_crm_reconciliation_runs(id) on delete cascade,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  deal_key text,
  action text not null,
  status text not null,
  submission_id uuid references public.contact_submissions(id) on delete set null,
  source_row_numbers jsonb not null default '[]'::jsonb,
  planned_changes jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  unique(run_id, opportunity_id)
);

create index if not exists idx_deal_hunter_crm_reconciliation_runs_import
  on public.deal_hunter_crm_reconciliation_runs(import_id, created_at desc);
create index if not exists idx_deal_hunter_crm_reconciliation_items_run
  on public.deal_hunter_crm_reconciliation_items(run_id, status, opportunity_id);

create or replace function public.start_deal_hunter_crm_reconciliation(p_run jsonb, p_items jsonb)
returns public.deal_hunter_crm_reconciliation_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id text;
  v_idempotency_key text;
  v_import_id uuid;
  v_plan_digest text;
  v_mode text;
  v_plan jsonb;
  v_run_lock bigint;
  v_idempotency_lock bigint;
  v_existing_by_id public.deal_hunter_crm_reconciliation_runs%rowtype;
  v_existing_by_key public.deal_hunter_crm_reconciliation_runs%rowtype;
  v_run public.deal_hunter_crm_reconciliation_runs;
  v_item jsonb;
  v_submitted_count integer;
  v_stored_count bigint;
  v_items_differ boolean;
begin
  if p_run is null
    or pg_catalog.jsonb_typeof(p_run) is distinct from 'object'
    or p_items is null
    or pg_catalog.jsonb_typeof(p_items) is distinct from 'array'
  then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: run and items must be JSON objects and arrays';
  end if;

  v_run_id := nullif(pg_catalog.btrim(p_run->>'id'), '');
  v_idempotency_key := nullif(pg_catalog.btrim(p_run->>'idempotency_key'), '');
  v_plan_digest := nullif(pg_catalog.btrim(p_run->>'plan_digest'), '');
  v_mode := nullif(pg_catalog.btrim(p_run->>'mode'), '');
  v_plan := coalesce(p_run->'plan', '{}'::jsonb);

  if v_run_id is null
    or v_idempotency_key is null
    or v_plan_digest is null
    or v_mode is null
    or nullif(pg_catalog.btrim(p_run->>'import_id'), '') is null
    or nullif(pg_catalog.btrim(p_run->>'status'), '') is null
    or nullif(pg_catalog.btrim(p_run->>'created_at'), '') is null
    or nullif(pg_catalog.btrim(p_run->>'updated_at'), '') is null
  then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: required run authority is missing';
  end if;

  begin
    v_import_id := (p_run->>'import_id')::uuid;
  exception when invalid_text_representation then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: import ID is invalid';
  end;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as submitted_item(value)
    where pg_catalog.jsonb_typeof(submitted_item.value) is distinct from 'object'
      or nullif(pg_catalog.btrim(submitted_item.value->>'id'), '') is null
      or nullif(pg_catalog.btrim(submitted_item.value->>'opportunity_id'), '') is null
      or nullif(pg_catalog.btrim(submitted_item.value->>'action'), '') is null
      or nullif(pg_catalog.btrim(submitted_item.value->>'status'), '') is null
      or nullif(pg_catalog.btrim(submitted_item.value->>'created_at'), '') is null
      or nullif(pg_catalog.btrim(submitted_item.value->>'updated_at'), '') is null
  ) then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: submitted item authority is invalid';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as submitted_item(value)
    where submitted_item.value->>'run_id' is distinct from v_run_id
  ) then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: submitted item run ID differs';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as submitted_item(value)
    group by submitted_item.value->>'id'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: duplicate submitted item ID';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as submitted_item(value)
    group by submitted_item.value->>'opportunity_id'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: duplicate submitted opportunity ID';
  end if;

  v_run_lock := pg_catalog.hashtextextended(
    'deal-hunter-crm-reconciliation/run-id/' || v_run_id,
    0
  );
  v_idempotency_lock := pg_catalog.hashtextextended(
    'deal-hunter-crm-reconciliation/idempotency-key/' || v_idempotency_key,
    0
  );
  perform pg_catalog.pg_advisory_xact_lock(
    least(v_run_lock, v_idempotency_lock)
  );
  if v_run_lock <> v_idempotency_lock then
    perform pg_catalog.pg_advisory_xact_lock(
      greatest(v_run_lock, v_idempotency_lock)
    );
  end if;

  select * into v_existing_by_id
  from public.deal_hunter_crm_reconciliation_runs
  where id = v_run_id;

  select * into v_existing_by_key
  from public.deal_hunter_crm_reconciliation_runs
  where idempotency_key = v_idempotency_key;

  if v_existing_by_id.id is not null or v_existing_by_key.id is not null then
    if v_existing_by_id.id is null
      or v_existing_by_key.id is null
      or v_existing_by_id.id is distinct from v_existing_by_key.id
      or v_existing_by_id.idempotency_key is distinct from v_idempotency_key
    then
      raise exception using
        errcode = '22023',
        message = 'reconciliation authority conflict: identifier binding differs';
    end if;

    if v_existing_by_id.import_id is distinct from v_import_id
      or v_existing_by_id.plan_digest is distinct from v_plan_digest
      or v_existing_by_id.mode is distinct from v_mode
      or v_existing_by_id.plan is distinct from v_plan
    then
      raise exception using
        errcode = '22023',
        message = 'reconciliation authority conflict: immutable run authority differs';
    end if;

    v_submitted_count := pg_catalog.jsonb_array_length(p_items);
    select pg_catalog.count(*) into v_stored_count
    from public.deal_hunter_crm_reconciliation_items
    where run_id = v_run_id;
    if v_stored_count is distinct from v_submitted_count::bigint then
      raise exception using
        errcode = '22023',
        message = 'reconciliation authority conflict: immutable item count differs';
    end if;

    with submitted as (
      select pg_catalog.jsonb_build_object(
        'id', submitted_item.value->>'id',
        'run_id', submitted_item.value->>'run_id',
        'opportunity_id', submitted_item.value->>'opportunity_id',
        'deal_key', nullif(submitted_item.value->>'deal_key', ''),
        'action', submitted_item.value->>'action',
        'source_row_numbers', coalesce(submitted_item.value->'source_row_numbers', '[]'::jsonb),
        'planned_changes', coalesce(submitted_item.value->'planned_changes', '{}'::jsonb),
        'metadata', coalesce(submitted_item.value->'metadata', '{}'::jsonb)
      ) as authority
      from pg_catalog.jsonb_array_elements(p_items) as submitted_item(value)
    ), stored as (
      select pg_catalog.jsonb_build_object(
        'id', stored_item.id,
        'run_id', stored_item.run_id,
        'opportunity_id', stored_item.opportunity_id,
        'deal_key', stored_item.deal_key,
        'action', stored_item.action,
        'source_row_numbers', coalesce(stored_item.source_row_numbers, '[]'::jsonb),
        'planned_changes', coalesce(stored_item.planned_changes, '{}'::jsonb),
        'metadata', coalesce(stored_item.metadata, '{}'::jsonb)
      ) as authority
      from public.deal_hunter_crm_reconciliation_items as stored_item
      where stored_item.run_id = v_run_id
    )
    select exists (
      select 1
      from (
        (select authority from submitted except select authority from stored)
        union all
        (select authority from stored except select authority from submitted)
      ) as differences
    ) into v_items_differ;
    if v_items_differ then
      raise exception using
        errcode = '22023',
        message = 'reconciliation authority conflict: immutable item set differs';
    end if;

    return v_existing_by_id;
  end if;

  insert into public.deal_hunter_crm_reconciliation_runs (
    id, created_at, updated_at, completed_at, import_id, mode, plan_digest,
    idempotency_key, status, requested_by, counts, plan, results, last_error, metadata
  ) values (
    v_run_id, (p_run->>'created_at')::timestamptz, (p_run->>'updated_at')::timestamptz,
    nullif(p_run->>'completed_at', '')::timestamptz, v_import_id,
    v_mode, v_plan_digest, v_idempotency_key, p_run->>'status',
    nullif(p_run->>'requested_by', ''), coalesce(p_run->'counts', '{}'::jsonb),
    v_plan, coalesce(p_run->'results', '{}'::jsonb),
    nullif(p_run->>'last_error', ''), coalesce(p_run->'metadata', '{}'::jsonb)
  ) returning * into v_run;

  begin
    for v_item in select value from pg_catalog.jsonb_array_elements(p_items) loop
      insert into public.deal_hunter_crm_reconciliation_items (
        id, run_id, opportunity_id, deal_key, action, status, submission_id,
        source_row_numbers, planned_changes, error, created_at, updated_at, metadata
      ) values (
        v_item->>'id', v_item->>'run_id', v_item->>'opportunity_id', nullif(v_item->>'deal_key', ''),
        v_item->>'action', v_item->>'status', nullif(v_item->>'submission_id', '')::uuid,
        coalesce(v_item->'source_row_numbers', '[]'::jsonb),
        coalesce(v_item->'planned_changes', '{}'::jsonb),
        nullif(v_item->>'error', ''), (v_item->>'created_at')::timestamptz,
        (v_item->>'updated_at')::timestamptz, coalesce(v_item->'metadata', '{}'::jsonb)
      );
    end loop;
  exception when unique_violation then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: item identifier binding differs';
  end;
  return v_run;
end;
$$;

create or replace function public.link_deal_hunter_crm_submission(
  p_opportunity_id text,
  p_submission_id uuid,
  p_updated_at timestamptz
) returns public.deal_hunter_opportunities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opportunity public.deal_hunter_opportunities;
  v_submission_opportunity_id text;
begin
  perform pg_advisory_xact_lock(hashtextextended('deal-hunter-crm:' || p_opportunity_id, 0));
  select * into v_opportunity
  from public.deal_hunter_opportunities
  where opportunity_id = p_opportunity_id and status = 'active'
  for update;
  if not found then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;
  select deal_hunter_opportunity_id into v_submission_opportunity_id
  from public.contact_submissions
  where id = p_submission_id
  for update;
  if not found then raise exception 'CRM submission not found'; end if;
  if v_submission_opportunity_id is not null
    and v_submission_opportunity_id <> ''
    and v_submission_opportunity_id <> p_opportunity_id then
    raise exception 'CRM submission already belongs to another canonical opportunity';
  end if;
  if exists (
    select 1 from public.contact_submissions
    where deal_hunter_opportunity_id = p_opportunity_id and id <> p_submission_id
  ) then
    raise exception 'canonical opportunity already owns another CRM submission';
  end if;
  if v_opportunity.primary_submission_id is not null
    and v_opportunity.primary_submission_id <> p_submission_id then
    raise exception 'canonical opportunity primary CRM ownership conflict';
  end if;
  update public.contact_submissions
    set deal_hunter_opportunity_id = p_opportunity_id, updated_at = greatest(updated_at, p_updated_at)
    where id = p_submission_id;
  update public.deal_hunter_opportunities
    set primary_submission_id = p_submission_id, updated_at = greatest(updated_at, p_updated_at)
    where opportunity_id = p_opportunity_id and status = 'active'
    returning * into v_opportunity;
  if v_opportunity.opportunity_id is null then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;
  return v_opportunity;
end;
$$;

alter table public.deal_hunter_crm_reconciliation_runs enable row level security;
alter table public.deal_hunter_crm_reconciliation_items enable row level security;
revoke all privileges on table public.deal_hunter_crm_reconciliation_runs from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_crm_reconciliation_items from public, anon, authenticated;
revoke all privileges on function public.start_deal_hunter_crm_reconciliation(jsonb, jsonb) from public, anon, authenticated;
revoke all privileges on function public.link_deal_hunter_crm_submission(text, uuid, timestamptz) from public, anon, authenticated;
grant all privileges on table public.deal_hunter_crm_reconciliation_runs to service_role;
grant all privileges on table public.deal_hunter_crm_reconciliation_items to service_role;
grant execute on function public.start_deal_hunter_crm_reconciliation(jsonb, jsonb) to service_role;
grant execute on function public.link_deal_hunter_crm_submission(text, uuid, timestamptz) to service_role;

-- Deal Hunter opportunity scoring and operator triage (Phase 3A).
-- Machine-computed scoring columns and operator-owned columns share a row so the
-- triage queue can derive "changed since reviewed" without a join. They are never
-- written by the same operation: write_deal_hunter_opportunity_score touches only
-- machine columns and the application rejects operator keys before calling it.
create table if not exists public.deal_hunter_opportunity_scores (
  opportunity_id text primary key references public.deal_hunter_opportunities(opportunity_id) on delete cascade,
  created_at timestamptz not null default now(),
  scored_at timestamptz not null,
  deal_key text,
  name text,
  state text,
  listing_url text,
  fit_score integer not null default 0,
  score_status text not null default 'provisional',
  confidence text not null default 'low',
  completeness_score integer not null default 0,
  contradiction_count integer not null default 0,
  missing_evidence_count integer not null default 0,
  should_remove boolean not null default false,
  high_fit boolean not null default false,
  gate_count integer not null default 0,
  score_fingerprint text not null,
  semantic_digest text,
  engine_version text not null,
  rules_version text not null,
  profile_version text not null,
  completeness_policy_version text not null,
  dimensions jsonb not null default '[]'::jsonb,
  gates jsonb not null default '[]'::jsonb,
  applied_caps jsonb not null default '[]'::jsonb,
  missing_evidence jsonb not null default '[]'::jsonb,
  confidence_reasons jsonb not null default '[]'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  current_triage_eligible boolean not null default false,
  operator_priority text not null default 'normal',
  operator_note text,
  reviewed_at timestamptz,
  reviewed_by text,
  reviewed_fingerprint text,
  reviewed_semantic_digest text,
  operator_updated_at timestamptz
);

create table if not exists public.deal_hunter_score_evidence (
  id text primary key,
  opportunity_id text not null references public.deal_hunter_opportunity_scores(opportunity_id) on delete cascade,
  score_fingerprint text not null,
  created_at timestamptz not null,
  dimension text,
  rule_id text not null,
  rule_label text not null,
  evidence_class text not null,
  field text,
  value text,
  observed_value text,
  terms jsonb not null default '[]'::jsonb,
  source_id text,
  source_name text,
  source_record_id text,
  listing_url text,
  observed_at text
);

create index if not exists idx_deal_hunter_scores_queue
  on public.deal_hunter_opportunity_scores(should_remove, fit_score desc, confidence, opportunity_id);
create index if not exists idx_deal_hunter_scores_current_queue
  on public.deal_hunter_opportunity_scores(current_triage_eligible, should_remove, fit_score desc, opportunity_id);
create index if not exists idx_deal_hunter_scores_priority
  on public.deal_hunter_opportunity_scores(operator_priority, fit_score desc, opportunity_id);
create index if not exists idx_deal_hunter_scores_acquisition_priority
  on public.deal_hunter_opportunity_scores(
    current_triage_eligible, should_remove, operator_priority, high_fit,
    fit_score desc, confidence, scored_at desc, opportunity_id
  );
create index if not exists idx_deal_hunter_scores_fingerprint
  on public.deal_hunter_opportunity_scores(score_fingerprint);
create index if not exists idx_deal_hunter_score_evidence_opportunity
  on public.deal_hunter_score_evidence(opportunity_id, dimension, evidence_class);

-- Replaces a machine score and the evidence describing it in one transaction, so
-- evidence can never describe a superseded fingerprint. Operator columns are
-- absent from both the insert and the update list.
create or replace function public.write_deal_hunter_opportunity_score(p_score jsonb, p_evidence jsonb)
returns public.deal_hunter_opportunity_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_score public.deal_hunter_opportunity_scores;
  v_item jsonb;
  v_index integer := 0;
  v_opportunity_id text := p_score->>'opportunity_id';
  v_fingerprint text := p_score->>'score_fingerprint';
  v_scored_at timestamptz := coalesce((p_score->>'scored_at')::timestamptz, now());
begin
  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = v_opportunity_id and status = 'active'
  for update;
  if not found then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;

  insert into public.deal_hunter_opportunity_scores (
    opportunity_id, created_at, scored_at, deal_key, name, state, listing_url, fit_score, score_status,
    confidence, completeness_score, contradiction_count, missing_evidence_count, should_remove, high_fit,
    gate_count, score_fingerprint, semantic_digest, engine_version, rules_version, profile_version,
    completeness_policy_version, dimensions, gates, applied_caps, missing_evidence, confidence_reasons, summary
  ) values (
    v_opportunity_id, v_scored_at, v_scored_at, nullif(p_score->>'deal_key', ''), nullif(p_score->>'name', ''),
    nullif(p_score->>'state', ''), nullif(p_score->>'listing_url', ''),
    coalesce((p_score->>'fit_score')::integer, 0), coalesce(p_score->>'score_status', 'provisional'),
    coalesce(p_score->>'confidence', 'low'), coalesce((p_score->>'completeness_score')::integer, 0),
    coalesce((p_score->>'contradiction_count')::integer, 0), coalesce((p_score->>'missing_evidence_count')::integer, 0),
    coalesce((p_score->>'should_remove')::boolean, false), coalesce((p_score->>'high_fit')::boolean, false),
    coalesce((p_score->>'gate_count')::integer, 0), v_fingerprint,
    nullif(p_score->>'semantic_digest', ''), p_score->>'engine_version',
    p_score->>'rules_version', p_score->>'profile_version', p_score->>'completeness_policy_version',
    coalesce(p_score->'dimensions', '[]'::jsonb), coalesce(p_score->'gates', '[]'::jsonb),
    coalesce(p_score->'applied_caps', '[]'::jsonb), coalesce(p_score->'missing_evidence', '[]'::jsonb),
    coalesce(p_score->'confidence_reasons', '[]'::jsonb), coalesce(p_score->'summary', '{}'::jsonb)
  )
  on conflict (opportunity_id) do update set
    scored_at = excluded.scored_at,
    deal_key = excluded.deal_key,
    name = excluded.name,
    state = excluded.state,
    listing_url = excluded.listing_url,
    fit_score = excluded.fit_score,
    score_status = excluded.score_status,
    confidence = excluded.confidence,
    completeness_score = excluded.completeness_score,
    contradiction_count = excluded.contradiction_count,
    missing_evidence_count = excluded.missing_evidence_count,
    should_remove = excluded.should_remove,
    high_fit = excluded.high_fit,
    gate_count = excluded.gate_count,
    score_fingerprint = excluded.score_fingerprint,
    semantic_digest = excluded.semantic_digest,
    engine_version = excluded.engine_version,
    rules_version = excluded.rules_version,
    profile_version = excluded.profile_version,
    completeness_policy_version = excluded.completeness_policy_version,
    dimensions = excluded.dimensions,
    gates = excluded.gates,
    applied_caps = excluded.applied_caps,
    missing_evidence = excluded.missing_evidence,
    confidence_reasons = excluded.confidence_reasons,
    summary = excluded.summary
  returning * into v_score;

  delete from public.deal_hunter_score_evidence where opportunity_id = v_opportunity_id;
  for v_item in select value from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) loop
    insert into public.deal_hunter_score_evidence (
      id, opportunity_id, score_fingerprint, created_at, dimension, rule_id, rule_label,
      evidence_class, field, value, observed_value, terms, source_id, source_name,
      source_record_id, listing_url, observed_at
    ) values (
      v_opportunity_id || ':' || v_fingerprint || ':' || v_index, v_opportunity_id, v_fingerprint, v_scored_at,
      nullif(v_item->>'dimension', ''), coalesce(v_item->>'ruleId', ''), coalesce(v_item->>'ruleLabel', ''),
      coalesce(v_item->>'evidenceClass', ''), nullif(v_item->>'field', ''), v_item->>'value',
      v_item->>'observedValue', coalesce(v_item->'terms', '[]'::jsonb), nullif(v_item->>'sourceId', ''),
      nullif(v_item->>'sourceName', ''), nullif(v_item->>'sourceRecordId', ''),
      nullif(v_item->>'listingUrl', ''), nullif(v_item->>'observedAt', '')
    );
    v_index := v_index + 1;
  end loop;
  return v_score;
end;
$$;

-- Replaces the complete current-triage set atomically. This is intentionally a
-- dedicated service-role operation rather than a field accepted by score writes.
create or replace function public.reconcile_deal_hunter_current_score_eligibility(p_opportunity_ids text[])
returns table (activated bigint, deactivated bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supplied_ids text[];
  v_ids text[];
  v_activated bigint;
  v_deactivated bigint;
begin
  select coalesce(array_agg(distinct btrim(value)), array[]::text[])
  into v_supplied_ids
  from unnest(coalesce(p_opportunity_ids, array[]::text[])) as supplied(value)
  where nullif(btrim(value), '') is not null;

  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = any(v_supplied_ids) and status = 'active'
  order by opportunity_id
  for update;

  select coalesce(array_agg(opportunity.opportunity_id order by opportunity.opportunity_id), array[]::text[])
  into v_ids
  from public.deal_hunter_opportunities as opportunity
  join unnest(v_supplied_ids) as supplied(opportunity_id)
    on supplied.opportunity_id = opportunity.opportunity_id
  where opportunity.status = 'active';

  select count(*) into v_activated
  from public.deal_hunter_opportunity_scores as scores
  where scores.current_triage_eligible = false
    and scores.opportunity_id = any(v_ids);

  select count(*) into v_deactivated
  from public.deal_hunter_opportunity_scores as scores
  where scores.current_triage_eligible = true
    and not (scores.opportunity_id = any(v_ids));

  update public.deal_hunter_opportunity_scores
  set current_triage_eligible = case
    when opportunity_id = any(v_ids) then true
    else false
  end
  where current_triage_eligible is distinct from case
    when opportunity_id = any(v_ids) then true
    else false
  end;

  return query select v_activated, v_deactivated;
end;
$$;

create or replace function public.list_deal_hunter_opportunity_scores(
  p_view text, p_page integer, p_page_size integer, p_search text, p_sort text, p_direction text,
  p_min_score integer, p_confidence text, p_priority text, p_state text
) returns jsonb
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select
           scores.opportunity_id, scores.deal_key, scores.name, scores.state, scores.listing_url,
           scores.fit_score, scores.score_status, scores.confidence, scores.completeness_score,
           scores.contradiction_count, scores.missing_evidence_count, scores.should_remove,
           scores.high_fit, scores.score_fingerprint, scores.semantic_digest, scores.scored_at,
           scores.rules_version, scores.operator_priority, scores.reviewed_at,
           scores.reviewed_by, scores.reviewed_fingerprint, scores.reviewed_semantic_digest,
           disposition.deal_key as dismissed_deal_key,
           disposition.reason as dismissed_reason, disposition.dismissed_at as dismissed_at,
           scores.summary->'strengths'->>0 as top_strength,
           scores.summary->'concerns'->>0 as top_concern,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'industry'
             order by source.observed_at desc, source.id asc limit 1) as industry,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'location'
             order by source.observed_at desc, source.id asc limit 1) as location,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'annual_profit'
             order by source.observed_at desc, source.id asc limit 1) as annual_profit,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'annual_revenue'
             order by source.observed_at desc, source.id asc limit 1) as annual_revenue,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'asking_price'
             order by source.observed_at desc, source.id asc limit 1) as asking_price,
           (select value from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id and source.field = 'profit_multiple'
             order by source.observed_at desc, source.id asc limit 1) as profit_multiple,
           coalesce((select max(observed_at) from public.deal_hunter_opportunity_source_observations as source
             where source.opportunity_id = scores.opportunity_id), scores.scored_at) as observation_freshness,
           coalesce((select submission.status from public.contact_submissions as submission
             where submission.id = opportunity.primary_submission_id limit 1), 'not-started') as crm_status,
           coalesce((select cim.status from public.deal_hunter_cim_requests as cim
             where cim.opportunity_id = scores.opportunity_id order by cim.updated_at desc, cim.id desc limit 1), 'not-requested') as cim_status
    from public.deal_hunter_opportunity_scores as scores
    join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = scores.opportunity_id
     and opportunity.status = 'active'
    left join public.deal_hunter_dispositions as disposition
      on disposition.deal_key = scores.deal_key and disposition.disposition = 'dismissed'
    where scores.current_triage_eligible = true
  ), filtered as (
    select * from candidates
    where (case
        when p_view = 'dismissed' then dismissed_deal_key is not null
        when p_view = 'needs-review' then dismissed_deal_key is null and should_remove = false
          and (reviewed_at is null or (case
            when reviewed_semantic_digest is not null then reviewed_semantic_digest <> coalesce(semantic_digest, '')
            else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint
          end))
        when p_view = 'high-priority' then dismissed_deal_key is null and should_remove = false
          and (high_fit or operator_priority in ('urgent', 'high'))
        when p_view = 'watchlist' then dismissed_deal_key is null and should_remove = false
          and ((fit_score >= 60 and fit_score < 75) or operator_priority = 'watch')
        when p_view = 'low-confidence' then dismissed_deal_key is null and should_remove = false
          and (confidence = 'low' or contradiction_count > 0)
        else dismissed_deal_key is null
      end)
      and (coalesce(p_search, '') = ''
        or lower(coalesce(name, '')) like '%' || lower(p_search) || '%'
        or lower(coalesce(deal_key, '')) like '%' || lower(p_search) || '%')
      and (p_min_score is null or fit_score >= p_min_score)
      and (coalesce(p_confidence, '') = '' or confidence = p_confidence)
      and (coalesce(p_priority, '') = '' or operator_priority = p_priority)
      and (coalesce(p_state, '') = '' or upper(coalesce(state, '')) = upper(p_state))
  ), ranked as (
    select filtered.*, row_number() over (order by
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority'
        then case when operator_priority in ('urgent', 'high') then 1 else 0 end end desc,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority'
        then case when high_fit and (reviewed_at is null or (case
          when reviewed_semantic_digest is not null then reviewed_semantic_digest <> coalesce(semantic_digest, '')
          else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint
        end)) then 1 else 0 end end desc,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority' then fit_score end desc nulls last,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority'
        then case confidence when 'high' then 3 when 'medium' then 2 else 1 end end desc nulls last,
      case when coalesce(p_sort, 'acquisition-priority') = 'acquisition-priority' then observation_freshness end desc nulls last,
      case when lower(coalesce(p_direction, 'desc')) = 'asc' then
        case coalesce(p_sort, 'fit-score')
          when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric
          when 'completeness' then completeness_score::numeric
          when 'fit-score' then fit_score::numeric
          when 'changed' then (case when reviewed_at is null then 1
            when reviewed_semantic_digest is not null then (case when reviewed_semantic_digest <> coalesce(semantic_digest, '') then 1 else 0 end)
            when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric
        end
      end asc nulls last,
      case when lower(coalesce(p_direction, 'desc')) <> 'asc' then
        case coalesce(p_sort, 'fit-score')
          when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric
          when 'completeness' then completeness_score::numeric
          when 'fit-score' then fit_score::numeric
          when 'changed' then (case when reviewed_at is null then 1
            when reviewed_semantic_digest is not null then (case when reviewed_semantic_digest <> coalesce(semantic_digest, '') then 1 else 0 end)
            when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric
        end
      end desc nulls last,
      case when lower(coalesce(p_direction, 'desc')) = 'asc' then case coalesce(p_sort, 'fit-score') when 'scored-at' then scored_at end end asc nulls last,
      case when lower(coalesce(p_direction, 'desc')) <> 'asc' then case coalesce(p_sort, 'fit-score') when 'scored-at' then scored_at end end desc nulls last,
      case when lower(coalesce(p_direction, 'desc')) = 'asc' then case coalesce(p_sort, 'fit-score') when 'name' then lower(coalesce(name, '')) end end asc nulls last,
      case when lower(coalesce(p_direction, 'desc')) <> 'asc' then case coalesce(p_sort, 'fit-score') when 'name' then lower(coalesce(name, '')) end end desc nulls last,
      case when coalesce(p_sort, 'fit-score') <> 'acquisition-priority' then case confidence when 'high' then 3 when 'medium' then 2 else 1 end end desc,
      opportunity_id asc
    ) as ordinal
    from filtered
  ), ordered as (
    select * from ranked
    where ordinal > greatest(0, (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 25), 1), 100))
      and ordinal <= greatest(0, (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 25), 1), 100))
        + least(greatest(coalesce(p_page_size, 25), 1), 100)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'summary', (select jsonb_build_object(
      'needsReview', count(*) filter (where dismissed_deal_key is null and should_remove = false
        and (reviewed_at is null or (case when reviewed_semantic_digest is not null
          then reviewed_semantic_digest <> coalesce(semantic_digest, '')
          else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint end))),
      'highPriority', count(*) filter (where dismissed_deal_key is null and should_remove = false
        and (high_fit or operator_priority in ('urgent', 'high'))),
      'watchlist', count(*) filter (where dismissed_deal_key is null and should_remove = false
        and ((fit_score >= 60 and fit_score < 75) or operator_priority = 'watch')),
      'lowConfidence', count(*) filter (where dismissed_deal_key is null and should_remove = false
        and (confidence = 'low' or contradiction_count > 0)),
      'currentOpportunities', count(*) filter (where dismissed_deal_key is null)
    ) from candidates),
    'rows', coalesce((select jsonb_agg((to_jsonb(ordered) - 'ordinal') order by ordinal) from ordered), '[]'::jsonb)
  );
$$;

create or replace function public.insert_submission_with_crm_activity(
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
  v_opportunity_id text := nullif(btrim(p_payload #>> '{submission,deal_hunter_opportunity_id}'), '');
begin
  if p_activity is null then
    raise exception 'CRM activity is required';
  end if;

  if v_opportunity_id is not null then
    perform 1
    from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id and status = 'active'
    for update;
    if not found then
      raise exception 'canonical opportunity is superseded or otherwise not current';
    end if;
  end if;

  insert into public.contact_submissions
  select * from jsonb_populate_record(null::public.contact_submissions, p_payload -> 'submission')
  returning to_jsonb(contact_submissions) into v_record;

  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;

  return jsonb_build_object('applied', true, 'record', v_record, 'activity', v_activity);
end;
$$;

create or replace function public.upsert_deal_hunter_cim_recipient_override(p_record jsonb)
returns public.deal_hunter_cim_recipient_overrides
language plpgsql
security definer
set search_path = public
as $$
declare
  v_override public.deal_hunter_cim_recipient_overrides;
  v_opportunity_id text := p_record->>'opportunity_id';
  v_existing_opportunity_id text;
begin
  select opportunity_id into v_existing_opportunity_id
  from public.deal_hunter_cim_recipient_overrides
  where id = p_record->>'id';
  if found and v_existing_opportunity_id <> v_opportunity_id then
    raise exception 'CIM recipient override ID already belongs to another canonical opportunity';
  end if;

  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = v_opportunity_id and status = 'active'
  for update;
  if not found then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;

  insert into public.deal_hunter_cim_recipient_overrides (
    id, opportunity_id, recipient_email, created_at, expires_at, consumed_at, created_by, reason, metadata
  ) values (
    p_record->>'id', v_opportunity_id, lower(p_record->>'recipient_email'),
    (p_record->>'created_at')::timestamptz, (p_record->>'expires_at')::timestamptz,
    nullif(p_record->>'consumed_at', '')::timestamptz, nullif(p_record->>'created_by', ''),
    p_record->>'reason', coalesce(p_record->'metadata', '{}'::jsonb)
  )
  on conflict (id) do update set
    expires_at = excluded.expires_at,
    consumed_at = excluded.consumed_at,
    reason = excluded.reason,
    metadata = excluded.metadata
  where public.deal_hunter_cim_recipient_overrides.opportunity_id = excluded.opportunity_id
  returning * into v_override;
  if v_override.id is null then
    raise exception 'CIM recipient override ID collision';
  end if;
  return v_override;
end;
$$;

create or replace function public.pass_deal_hunter_opportunity(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opportunity public.deal_hunter_opportunities;
  v_score public.deal_hunter_opportunity_scores;
  v_disposition public.deal_hunter_dispositions;
  v_submission public.contact_submissions;
  v_now timestamptz := coalesce(nullif(p_command->>'occurred_at', '')::timestamptz, now());
  v_actor text := coalesce(nullif(p_command->>'actor', ''), 'admin');
  v_reason text := nullif(p_command->>'reason', '');
  v_note text := nullif(p_command->>'note', '');
  v_archived boolean := false;
  v_archive_submission boolean := false;
begin
  if nullif(p_command->>'opportunity_id', '') is null
    or v_reason is null
    or nullif(p_command->>'disposition_id', '') is null
    or nullif(p_command->>'archive_activity_id', '') is null
    or nullif(p_command->>'triage_activity_id', '') is null then
    raise exception 'Atomic opportunity Pass command is incomplete';
  end if;

  select * into v_opportunity
  from public.deal_hunter_opportunities
  where opportunity_id = p_command->>'opportunity_id'
  for update;
  if not found or v_opportunity.status <> 'active' then
    return jsonb_build_object('applied', false, 'reason', 'not-current');
  end if;

  select * into v_score
  from public.deal_hunter_opportunity_scores
  where opportunity_id = v_opportunity.opportunity_id
    and current_triage_eligible = true
  for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'not-current');
  end if;
  if v_score.should_remove then
    return jsonb_build_object('applied', false, 'reason', 'not-actionable');
  end if;

  select * into v_disposition
  from public.deal_hunter_dispositions
  where deal_key = v_score.deal_key
  for update;
  if found and v_disposition.disposition = 'dismissed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already-passed',
      'disposition', to_jsonb(v_disposition),
      'score', to_jsonb(v_score)
    );
  end if;

  if v_opportunity.primary_submission_id is not null then
    select * into v_submission
    from public.contact_submissions
    where id = v_opportunity.primary_submission_id
    for update;
    if not found then
      return jsonb_build_object('applied', false, 'reason', 'linked-submission-missing');
    end if;
    v_archive_submission := v_submission.status <> 'archived';
    v_archived := true;
  end if;

  if v_archive_submission and exists (
    select 1
    from public.deal_hunter_cim_requests as request
    where request.submission_id = v_submission.id
      and (
        (request.status = 'pending' and request.updated_at > v_now - interval '10 minutes')
        or (request.status = 'follow_up_pending' and request.updated_at > v_now - interval '30 minutes')
      )
  ) then
    return jsonb_build_object('applied', false, 'reason', 'cim-send-in-progress');
  end if;

  if v_archive_submission then
    update public.contact_submissions
    set
      updated_at = v_now,
      status = 'archived',
      status_updated_at = v_now,
      follow_up_state = 'completed',
      next_action_at = null,
      archived_at = v_now,
      archived_by = v_actor,
      archive_reason = v_reason,
      archive_note = v_note,
      archive_communication_id = null,
      metadata = coalesce(v_submission.metadata, '{}'::jsonb) || jsonb_build_object(
        'acquisitionCommand', coalesce(v_submission.metadata->'acquisitionCommand', '{}'::jsonb) || jsonb_build_object(
          'pipelineStage', 'passed',
          'passReason', v_reason,
          'fitFeedback', 'false-positive',
          'updatedAt', v_now,
          'updatedBy', v_actor
        ),
        'leadArchive', jsonb_build_object(
          'previousStatus', v_submission.status,
          'archivedAt', v_now,
          'archivedBy', v_actor,
          'reason', v_reason,
          'communicationId', ''
        )
      )
    where id = v_submission.id
    returning * into v_submission;

    update public.deal_hunter_cim_requests
    set
      request_state = case when request_state = 'responded' then request_state else 'stopped' end,
      follow_up_state = case when request_state = 'responded' then 'completed' else 'stopped' end,
      next_follow_up_at = null,
      updated_at = v_now,
      last_activity_at = v_now
    where submission_id = v_submission.id;
  end if;

  insert into public.deal_hunter_dispositions as disposition (
    id, deal_key, submission_id, communication_id, listing_url, deal_name,
    created_at, updated_at, disposition, reason, note, dismissed_at,
    dismissed_by, restored_at, restored_by, created_by, updated_by, metadata
  ) values (
    (p_command->>'disposition_id')::uuid,
    v_score.deal_key,
    v_opportunity.primary_submission_id,
    null,
    nullif(v_score.listing_url, ''),
    coalesce(nullif(v_score.name, ''), nullif(v_opportunity.canonical_name, '')),
    v_now, v_now, 'dismissed', v_reason, v_note, v_now,
    v_actor, null, null, v_actor, v_actor, '{}'::jsonb
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
  returning * into v_disposition;

  update public.deal_hunter_opportunity_scores
  set
    reviewed_at = v_now,
    reviewed_by = v_actor,
    reviewed_fingerprint = score_fingerprint,
    reviewed_semantic_digest = semantic_digest,
    operator_updated_at = v_now
  where opportunity_id = v_opportunity.opportunity_id
    and current_triage_eligible = true
  returning * into v_score;
  if not found then
    raise exception 'Current opportunity score changed during Pass';
  end if;

  if v_opportunity.primary_submission_id is not null then
    if v_archive_submission then
      insert into public.crm_activity_events (
        id, submission_id, opportunity_id, created_at, actor, role, event_type, summary, metadata
      ) values (
        (p_command->>'archive_activity_id')::uuid,
        v_submission.id,
        v_opportunity.opportunity_id,
        v_now,
        v_actor,
        'admin',
        'submission.archived',
        'Lead archived: ' || replace(v_reason, '-', ' ') || '.',
        jsonb_build_object(
          'archiveReason', v_reason,
          'communicationId', '',
          'previousStatus', coalesce(v_submission.metadata->'leadArchive'->>'previousStatus', ''),
          'dealKey', v_score.deal_key,
          'dispositionId', v_disposition.id
        )
      );
    end if;
    insert into public.crm_activity_events (
      id, submission_id, opportunity_id, created_at, actor, role, event_type, summary, metadata
    ) values (
      (p_command->>'triage_activity_id')::uuid,
      v_submission.id,
      v_opportunity.opportunity_id,
      v_now,
      v_actor,
      'admin',
      'opportunity.triaged',
      'Operator triage: marked reviewed, passed.',
      jsonb_build_object(
        'markedReviewed', true,
        'reviewedFingerprint', v_score.reviewed_fingerprint,
        'fitScoreAtDecision', v_score.fit_score,
        'dispositionId', v_disposition.id
      )
    );
  end if;

  return jsonb_build_object(
    'applied', true,
    'reason', '',
    'disposition', to_jsonb(v_disposition),
    'score', to_jsonb(v_score),
    'submission', case when v_opportunity.primary_submission_id is null then null else to_jsonb(v_submission) end,
    'archived', v_archived
  );
end;
$$;

create or replace function public.set_deal_hunter_opportunity_operator_decision(
  p_opportunity_id text,
  p_decision jsonb
)
returns public.deal_hunter_opportunity_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_score public.deal_hunter_opportunity_scores;
  v_opportunity_status text;
begin
  select status into v_opportunity_status
  from public.deal_hunter_opportunities
  where opportunity_id = p_opportunity_id
  for update;
  if not found then
    return null;
  end if;
  if v_opportunity_status <> 'active' then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;

  select * into v_score
  from public.deal_hunter_opportunity_scores
  where opportunity_id = p_opportunity_id
  for update;
  if not found then
    return null;
  end if;

  perform 1
  from public.deal_hunter_dispositions as disposition
  where disposition.deal_key = v_score.deal_key
    and disposition.disposition = 'dismissed'
  for update;
  if found then
    raise exception 'This opportunity has already been passed and is durably dismissed';
  end if;

  update public.deal_hunter_opportunity_scores
  set operator_priority = case when p_decision ? 'operator_priority' then p_decision->>'operator_priority' else operator_priority end,
      operator_note = case when p_decision ? 'operator_note' then p_decision->>'operator_note' else operator_note end,
      reviewed_at = case when p_decision ? 'reviewed_at' then (p_decision->>'reviewed_at')::timestamptz else reviewed_at end,
      reviewed_by = case when p_decision ? 'reviewed_by' then p_decision->>'reviewed_by' else reviewed_by end,
      reviewed_fingerprint = case when p_decision ? 'reviewed_fingerprint' then p_decision->>'reviewed_fingerprint' else reviewed_fingerprint end,
      reviewed_semantic_digest = case when p_decision ? 'reviewed_semantic_digest' then p_decision->>'reviewed_semantic_digest' else reviewed_semantic_digest end,
      operator_updated_at = coalesce((p_decision->>'operator_updated_at')::timestamptz, now())
  where opportunity_id = p_opportunity_id
  returning * into v_score;
  return v_score;
end;
$$;

alter table public.deal_hunter_opportunity_scores enable row level security;
alter table public.deal_hunter_score_evidence enable row level security;
revoke all privileges on table public.deal_hunter_opportunity_scores from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_score_evidence from public, anon, authenticated;
revoke all privileges on function public.insert_submission_with_crm_activity(jsonb, jsonb) from public, anon, authenticated;
revoke all privileges on function public.write_deal_hunter_opportunity_score(jsonb, jsonb) from public, anon, authenticated;
revoke all privileges on function public.reconcile_deal_hunter_current_score_eligibility(text[]) from public, anon, authenticated;
revoke all privileges on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) from public, anon, authenticated;
revoke all privileges on function public.upsert_deal_hunter_cim_recipient_override(jsonb) from public, anon, authenticated;
revoke all privileges on function public.set_deal_hunter_opportunity_operator_decision(text, jsonb) from public, anon, authenticated;
revoke all privileges on function public.pass_deal_hunter_opportunity(jsonb) from public, anon, authenticated;
grant all privileges on table public.deal_hunter_opportunity_scores to service_role;
grant all privileges on table public.deal_hunter_score_evidence to service_role;
grant execute on function public.insert_submission_with_crm_activity(jsonb, jsonb) to service_role;
grant execute on function public.write_deal_hunter_opportunity_score(jsonb, jsonb) to service_role;
grant execute on function public.reconcile_deal_hunter_current_score_eligibility(text[]) to service_role;
grant execute on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) to service_role;
grant execute on function public.upsert_deal_hunter_cim_recipient_override(jsonb) to service_role;
grant execute on function public.set_deal_hunter_opportunity_operator_decision(text, jsonb) to service_role;
grant execute on function public.pass_deal_hunter_opportunity(jsonb) to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'deal_hunter_cim_requests_canonical_id_check'
      and conrelid = 'public.deal_hunter_cim_requests'::regclass
  ) then
    alter table public.deal_hunter_cim_requests
      add constraint deal_hunter_cim_requests_canonical_id_check
      check ((id collate "C") ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$') not valid;
  end if;
end
$$;

create or replace function public.list_deal_hunter_cim_detail_authority(
  p_opportunity_ids text[],
  p_limit integer default 100
)
returns setof public.deal_hunter_cim_requests
language sql
stable
security invoker
set search_path = public
as $$
  select request.*
  from public.deal_hunter_cim_requests as request
  where request.opportunity_id = any(p_opportunity_ids)
    and (request.id collate "C") ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  order by
    request.updated_at desc nulls last,
    request.id collate "C" asc
  limit greatest(1, least(coalesce(p_limit, 100), 100000));
$$;

revoke all on function public.list_deal_hunter_cim_detail_authority(text[], integer)
  from public, anon, authenticated;
grant execute on function public.list_deal_hunter_cim_detail_authority(text[], integer)
  to service_role;

create or replace function public.start_deal_hunter_manual_follow_ups(
  p_request_id text,
  p_expected_request_updated_at timestamptz,
  p_expected_submission_id uuid,
  p_expected_submission_updated_at timestamptz,
  p_marker jsonb,
  p_next_follow_up_at timestamptz,
  p_activity jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_marker jsonb;
  v_enrolled_at timestamptz;
  v_enrolled_by text;
  v_activity jsonb;
begin
  select * into v_submission
  from public.contact_submissions as submission
  where submission.id = p_expected_submission_id
  for update;

  select * into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;

  if v_current.id is null then
    return jsonb_build_object('applied', false, 'reason', 'request-missing', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_submission.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object('applied', false, 'reason', 'submission-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_current.updated_at is distinct from p_expected_request_updated_at
    or v_submission.updated_at is distinct from p_expected_submission_updated_at then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  if jsonb_typeof(p_marker) is distinct from 'object' then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  if (select count(*) from jsonb_object_keys(p_marker)) <> 6
    or p_marker -> 'version' is distinct from to_jsonb('deal-hunter-manual-follow-up-v1'::text)
    or p_marker -> 'mode' is distinct from to_jsonb('operator-approved'::text)
    or p_marker -> 'maximumFollowUps' is distinct from '5'::jsonb
    or p_marker -> 'cadencePolicy' is distinct from to_jsonb('accepted-local-date-plus-2-weekend-forward-0900-pt-v1'::text)
    or jsonb_typeof(p_marker -> 'enrolledAt') is distinct from 'string'
    or jsonb_typeof(p_marker -> 'enrolledBy') is distinct from 'string'
    or nullif(p_marker ->> 'enrolledAt', '') is null
    or nullif(btrim(p_marker ->> 'enrolledBy'), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  begin
    v_enrolled_at := (p_marker ->> 'enrolledAt')::timestamptz;
  exception when others then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end;
  v_enrolled_by := left(regexp_replace(btrim(p_marker ->> 'enrolledBy'), '\s+', ' ', 'g'), 300);
  if v_enrolled_at is null or v_enrolled_by = '' then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  v_marker := jsonb_build_object(
    'version', 'deal-hunter-manual-follow-up-v1',
    'mode', 'operator-approved',
    'maximumFollowUps', 5,
    'cadencePolicy', 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1',
    'enrolledAt', to_char(v_enrolled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'enrolledBy', v_enrolled_by
  );
  if v_submission.status = 'archived'
    or v_current.status <> 'sent'
    or v_current.request_state is distinct from 'provider_accepted'
    or coalesce(v_current.delivery_state, '') not in ('accepted', 'delivered')
    or v_current.responded_at is not null
    or v_current.follow_up_count not between 0 and 4
    or v_current.next_follow_up_at is not null
    or coalesce(v_current.follow_up_state, '') not in ('', 'not-scheduled')
    or coalesce(v_current.metadata, '{}'::jsonb) ? 'manualFollowUp'
    or p_next_follow_up_at is null
    or p_activity #>> '{submission_id}' is distinct from p_expected_submission_id::text then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  update public.deal_hunter_cim_requests as request
  set
    updated_at = v_enrolled_at,
    follow_up_state = 'scheduled',
    next_follow_up_at = p_next_follow_up_at,
    metadata = coalesce(request.metadata, '{}'::jsonb) || jsonb_build_object('manualFollowUp', v_marker)
  where request.id = p_request_id
    and request.updated_at = p_expected_request_updated_at
    and request.submission_id = p_expected_submission_id
  returning request.* into v_current;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;

  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;

  return jsonb_build_object('applied', true, 'reason', '', 'request', to_jsonb(v_current), 'activity', v_activity, 'alreadyFinalized', false);
end;
$$;

create or replace function public.stop_deal_hunter_manual_follow_ups(
  p_request_id text,
  p_expected_request_updated_at timestamptz,
  p_expected_submission_id uuid,
  p_expected_submission_updated_at timestamptz,
  p_stopped_at timestamptz,
  p_stopped_by text,
  p_reason text,
  p_activity jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_marker jsonb;
  v_enrolled_at timestamptz;
  v_activity jsonb;
  v_stopped_in_flight boolean;
begin
  select * into v_submission
  from public.contact_submissions as submission
  where submission.id = p_expected_submission_id
  for update;

  select * into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;

  if v_current.id is null then
    return jsonb_build_object('applied', false, 'reason', 'request-missing', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_submission.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object('applied', false, 'reason', 'submission-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_current.updated_at is distinct from p_expected_request_updated_at
    or v_submission.updated_at is distinct from p_expected_submission_updated_at then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  v_marker := coalesce(v_current.metadata -> 'manualFollowUp', '{}'::jsonb);
  v_stopped_in_flight := v_current.status = 'follow_up_pending';
  if jsonb_typeof(v_marker) is distinct from 'object'
    or v_marker -> 'version' is distinct from to_jsonb('deal-hunter-manual-follow-up-v1'::text)
    or v_marker -> 'mode' is distinct from to_jsonb('operator-approved'::text)
    or v_marker -> 'maximumFollowUps' is distinct from '5'::jsonb
    or v_marker -> 'cadencePolicy' is distinct from to_jsonb('accepted-local-date-plus-2-weekend-forward-0900-pt-v1'::text)
    or jsonb_typeof(v_marker -> 'enrolledAt') is distinct from 'string'
    or jsonb_typeof(v_marker -> 'enrolledBy') is distinct from 'string'
    or nullif(btrim(v_marker ->> 'enrolledBy'), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  begin
    v_enrolled_at := (v_marker ->> 'enrolledAt')::timestamptz;
  exception when others then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end;
  if v_enrolled_at is null
    or v_submission.status = 'archived'
    or v_current.responded_at is not null
    or v_current.request_state = 'responded'
    or v_current.status in ('responded', 'delivery_issue')
    or v_current.follow_up_count >= 5
    or v_current.follow_up_state in ('stopped', 'completed')
    or v_marker ? 'stoppedAt'
    or p_stopped_at is null
    or nullif(btrim(p_stopped_by), '') is null
    or p_activity #>> '{submission_id}' is distinct from p_expected_submission_id::text then
    return jsonb_build_object('applied', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  v_marker := v_marker || jsonb_build_object(
    'stoppedAt', p_stopped_at,
    'stoppedBy', left(regexp_replace(btrim(p_stopped_by), '\s+', ' ', 'g'), 300),
    'stopReason', left(regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g'), 240)
  );
  update public.deal_hunter_cim_requests as request
  set
    updated_at = p_stopped_at,
    follow_up_state = 'stopped',
    next_follow_up_at = null,
    metadata = coalesce(request.metadata, '{}'::jsonb) || jsonb_build_object('manualFollowUp', v_marker)
  where request.id = p_request_id
    and request.updated_at = p_expected_request_updated_at
    and request.submission_id = p_expected_submission_id
  returning request.* into v_current;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;

  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;
  return jsonb_build_object('applied', true, 'reason', case when v_stopped_in_flight then 'stopped-in-flight' else '' end, 'request', to_jsonb(v_current), 'activity', v_activity, 'alreadyFinalized', false);
end;
$$;

create or replace function public.claim_deal_hunter_approved_follow_up(
  p_request_id text,
  p_expected_request_updated_at timestamptz,
  p_expected_submission_id uuid,
  p_expected_submission_updated_at timestamptz,
  p_expected_follow_up_count integer,
  p_expected_follow_up_number integer,
  p_expected_next_follow_up_at timestamptz,
  p_claimed_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_marker jsonb;
  v_enrolled_at timestamptz;
begin
  select * into v_submission
  from public.contact_submissions as submission
  where submission.id = p_expected_submission_id
  for update;

  select * into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;

  if v_current.id is null then
    return jsonb_build_object('applied', false, 'reason', 'request-missing', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_submission.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object('applied', false, 'reason', 'submission-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  v_marker := coalesce(v_current.metadata -> 'manualFollowUp', '{}'::jsonb);
  if jsonb_typeof(v_marker) is distinct from 'object'
    or v_marker -> 'version' is distinct from to_jsonb('deal-hunter-manual-follow-up-v1'::text)
    or v_marker -> 'mode' is distinct from to_jsonb('operator-approved'::text)
    or v_marker -> 'maximumFollowUps' is distinct from '5'::jsonb
    or v_marker -> 'cadencePolicy' is distinct from to_jsonb('accepted-local-date-plus-2-weekend-forward-0900-pt-v1'::text)
    or jsonb_typeof(v_marker -> 'enrolledAt') is distinct from 'string'
    or jsonb_typeof(v_marker -> 'enrolledBy') is distinct from 'string'
    or nullif(btrim(v_marker ->> 'enrolledBy'), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'claim-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  begin
    v_enrolled_at := (v_marker ->> 'enrolledAt')::timestamptz;
  exception when others then
    return jsonb_build_object('applied', false, 'reason', 'claim-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end;
  if v_enrolled_at is null
    or v_current.updated_at is distinct from p_expected_request_updated_at
    or v_submission.updated_at is distinct from p_expected_submission_updated_at
    or v_submission.status = 'archived'
    or v_marker ? 'stoppedAt'
    or v_current.responded_at is not null
    or v_current.request_state = 'responded'
    or v_current.status in ('responded', 'delivery_issue')
    or coalesce(v_current.follow_up_state, '') not in ('scheduled', 'failed')
    or v_current.status not in ('sent', 'failed', 'follow_up_failed')
    or v_current.request_state is distinct from 'provider_accepted'
    or v_current.follow_up_count <> p_expected_follow_up_count
    or p_expected_follow_up_number <> v_current.follow_up_count + 1
    or p_expected_follow_up_number not between 1 and 5
    or v_current.next_follow_up_at is distinct from p_expected_next_follow_up_at
    or v_current.next_follow_up_at is null
    or p_claimed_at < v_current.next_follow_up_at then
    return jsonb_build_object('applied', false, 'reason', 'claim-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  update public.deal_hunter_cim_requests as request
  set status = 'follow_up_pending', delivery_error = '', updated_at = p_claimed_at
  where request.id = p_request_id
    and request.updated_at = p_expected_request_updated_at
    and request.submission_id = p_expected_submission_id
  returning request.* into v_current;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  return jsonb_build_object('applied', true, 'reason', '', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
end;
$$;

create or replace function public.finalize_deal_hunter_approved_follow_up(
  p_request_id text,
  p_expected_request_updated_at timestamptz,
  p_expected_submission_id uuid,
  p_expected_follow_up_number integer,
  p_expected_communication_id text,
  p_outcome text,
  p_accepted_at timestamptz,
  p_next_follow_up_at timestamptz,
  p_activity jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_communication public.crm_communications%rowtype;
  v_outbox public.crm_email_outbox%rowtype;
  v_expected_communication_id text;
  v_marker jsonb;
  v_enrolled_at timestamptz;
  v_touches jsonb;
  v_follow_ups jsonb;
  v_activity jsonb;
  v_terminal boolean;
  v_mutation_at timestamptz;
  v_follow_up_state text;
  v_status text;
  v_request_state text;
  v_delivery_state text;
  v_provider_accepted_at timestamptz;
  v_due_date date;
  v_derived_next_follow_up_at timestamptz;
begin
  select * into v_submission
  from public.contact_submissions as submission
  where submission.id = p_expected_submission_id
  for update;

  select * into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;

  if v_current.id is null then
    return jsonb_build_object('applied', false, 'reason', 'request-missing', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  if v_submission.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object('applied', false, 'reason', 'submission-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  v_expected_communication_id := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'crm-communication:' || p_request_id || ':follow-up:' || p_expected_follow_up_number::text,
      'UTF8'
    )),
    'hex'
  );
  if p_expected_communication_id is distinct from v_expected_communication_id then
    return jsonb_build_object('applied', false, 'reason', 'finalize-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  select * into v_communication
  from public.crm_communications as communication
  where communication.id = p_expected_communication_id
  for update;

  select * into v_outbox
  from public.crm_email_outbox as outbox
  where outbox.communication_id = p_expected_communication_id
  for update;

  v_marker := coalesce(v_current.metadata -> 'manualFollowUp', '{}'::jsonb);
  v_touches := case when jsonb_typeof(v_marker -> 'acceptedTouches') = 'array'
    then v_marker -> 'acceptedTouches' else '[]'::jsonb end;
  v_follow_ups := case when jsonb_typeof(v_current.metadata -> 'followUps') = 'array'
    then v_current.metadata -> 'followUps' else '[]'::jsonb end;
  if exists (
    select 1 from jsonb_array_elements(v_touches) as touch(value)
    where touch.value ->> 'followUpNumber' = p_expected_follow_up_number::text
      and touch.value ->> 'communicationId' = p_expected_communication_id
  ) then
    return jsonb_build_object('applied', false, 'reason', 'already-finalized', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', true);
  end if;
  if p_outcome <> 'accepted'
    and v_marker #>> '{currentAttempt,followUpNumber}' = p_expected_follow_up_number::text
    and v_marker #>> '{currentAttempt,communicationId}' = p_expected_communication_id
    and v_marker #>> '{currentAttempt,outcome}' = p_outcome
    and v_current.updated_at is distinct from p_expected_request_updated_at then
    return jsonb_build_object('applied', false, 'reason', 'already-finalized', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', true);
  end if;

  if jsonb_typeof(v_marker) is distinct from 'object'
    or v_marker -> 'version' is distinct from to_jsonb('deal-hunter-manual-follow-up-v1'::text)
    or v_marker -> 'mode' is distinct from to_jsonb('operator-approved'::text)
    or v_marker -> 'maximumFollowUps' is distinct from '5'::jsonb
    or v_marker -> 'cadencePolicy' is distinct from to_jsonb('accepted-local-date-plus-2-weekend-forward-0900-pt-v1'::text)
    or jsonb_typeof(v_marker -> 'enrolledAt') is distinct from 'string'
    or jsonb_typeof(v_marker -> 'enrolledBy') is distinct from 'string'
    or nullif(btrim(v_marker ->> 'enrolledBy'), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'finalize-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;
  begin
    v_enrolled_at := (v_marker ->> 'enrolledAt')::timestamptz;
  exception when others then
    return jsonb_build_object('applied', false, 'reason', 'finalize-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end;
  if v_enrolled_at is null
    or p_outcome not in ('accepted', 'definitive-failure', 'ambiguous')
    or p_expected_follow_up_number not between 1 and 5
    or v_current.follow_up_count <> p_expected_follow_up_number - 1
    or v_communication.id is null
    or v_communication.cim_request_id is distinct from p_request_id
    or v_communication.submission_id is distinct from p_expected_submission_id
    or coalesce(v_communication.metadata ->> 'followUpNumber', v_communication.metadata ->> 'follow_up_number', '') <> p_expected_follow_up_number::text
    or p_activity #>> '{submission_id}' is distinct from p_expected_submission_id::text then
    return jsonb_build_object('applied', false, 'reason', 'finalize-ineligible', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  v_terminal := v_submission.status = 'archived'
    or v_current.responded_at is not null
    or v_current.request_state = 'responded'
    or v_current.status in ('responded', 'delivery_issue')
    or v_current.follow_up_state in ('stopped', 'completed')
    or v_marker ? 'stoppedAt';

  if p_outcome = 'accepted' then
    begin
      v_provider_accepted_at := case
        when nullif(v_communication.metadata #>> '{manualFollowUp,firstProviderAcceptedAt}', '') is not null
          then (v_communication.metadata #>> '{manualFollowUp,firstProviderAcceptedAt}')::timestamptz
        when v_communication.delivery_state = 'accepted' then v_communication.delivery_state_at
        else null
      end;
    exception when others then
      v_provider_accepted_at := null;
    end;
    if v_communication.delivery_state not in ('accepted', 'delivered', 'delayed', 'bounced', 'complained', 'suppressed', 'replied')
      or nullif(btrim(v_communication.provider_message_id), '') is null
      or p_accepted_at is null
      or v_provider_accepted_at is distinct from p_accepted_at then
      return jsonb_build_object('applied', false, 'reason', 'accepted-proof-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
    end if;
    if p_expected_follow_up_number < 5 then
      v_due_date := (p_accepted_at at time zone 'America/Los_Angeles')::date + 2;
      if extract(isodow from v_due_date) = 6 then
        v_due_date := v_due_date + 2;
      elsif extract(isodow from v_due_date) = 7 then
        v_due_date := v_due_date + 1;
      end if;
      v_derived_next_follow_up_at := (v_due_date + time '09:00') at time zone 'America/Los_Angeles';
      if p_next_follow_up_at is distinct from v_derived_next_follow_up_at then
        return jsonb_build_object('applied', false, 'reason', 'accepted-proof-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
      end if;
    else
      v_derived_next_follow_up_at := null;
    end if;
  else
    if v_current.updated_at is distinct from p_expected_request_updated_at
      or v_current.status <> 'follow_up_pending'
      or v_terminal then
      return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
    end if;
    if v_marker #>> '{currentAttempt,outcome}' = 'ambiguous' then
      return jsonb_build_object('applied', false, 'reason', 'reconciliation-required', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
    end if;
    if p_outcome = 'definitive-failure' and v_communication.delivery_state not in ('failed', 'bounced', 'complained', 'suppressed') then
      return jsonb_build_object('applied', false, 'reason', 'definitive-proof-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
    end if;
    if p_outcome = 'ambiguous' and (
      v_outbox.id is null
      or v_outbox.state is distinct from 'ambiguous'
      or v_outbox.communication_id is distinct from p_expected_communication_id
      or v_outbox.cim_request_id is distinct from p_request_id
      or v_outbox.submission_id is distinct from p_expected_submission_id
      or v_outbox.ambiguous_at is null
    ) then
      return jsonb_build_object('applied', false, 'reason', 'ambiguous-proof-missing', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
    end if;
  end if;

  v_mutation_at := greatest(
    v_current.updated_at,
    coalesce(nullif(p_activity ->> 'created_at', '')::timestamptz, '-infinity'::timestamptz),
    coalesce(p_accepted_at, '-infinity'::timestamptz)
  );
  v_marker := v_marker || jsonb_build_object(
    'currentAttempt', jsonb_build_object(
      'followUpNumber', p_expected_follow_up_number,
      'communicationId', p_expected_communication_id,
      'outcome', p_outcome,
      'originalDueAt', coalesce(v_marker #> '{currentAttempt,originalDueAt}', to_jsonb(v_current.next_follow_up_at)),
      'updatedAt', v_mutation_at
    )
  );

  if p_outcome = 'accepted' then
    v_follow_ups := v_follow_ups || jsonb_build_array(jsonb_build_object(
      'number', p_expected_follow_up_number,
      'attemptedAt', p_accepted_at,
      'acceptedAt', p_accepted_at,
      'status', 'accepted',
      'communicationId', p_expected_communication_id,
      'providerMessageId', coalesce(v_communication.provider_message_id, ''),
      'error', ''
    ));
    v_marker := v_marker || jsonb_build_object(
      'acceptedTouches', v_touches || jsonb_build_array(jsonb_build_object(
        'followUpNumber', p_expected_follow_up_number,
        'communicationId', p_expected_communication_id,
        'acceptedAt', p_accepted_at
      ))
    );
    if p_expected_follow_up_number = 5 then
      v_marker := v_marker || jsonb_build_object('completedAt', p_accepted_at);
    end if;
    v_follow_up_state := case
      when v_terminal and v_current.follow_up_state = 'completed' then 'completed'
      when v_terminal then 'stopped'
      when p_expected_follow_up_number = 5 then 'completed'
      else 'scheduled'
    end;
    v_status := case when v_current.status in ('responded', 'delivery_issue') then v_current.status else 'sent' end;
    v_request_state := case when v_current.request_state = 'responded' then 'responded' else 'provider_accepted' end;
    v_delivery_state := case when v_current.delivery_state in ('bounced', 'complained', 'suppressed') then v_current.delivery_state else 'accepted' end;
    update public.deal_hunter_cim_requests as request
    set
      updated_at = v_mutation_at,
      status = v_status,
      request_state = v_request_state,
      delivery_state = v_delivery_state,
      follow_up_count = request.follow_up_count + 1,
      last_follow_up_at = p_accepted_at,
      next_follow_up_at = case
        when v_terminal then null
        when p_expected_follow_up_number = 5 then null
        else v_derived_next_follow_up_at
      end,
      follow_up_state = v_follow_up_state,
      last_activity_at = v_mutation_at,
      metadata = coalesce(request.metadata, '{}'::jsonb) || jsonb_build_object(
        'followUps', v_follow_ups,
        'manualFollowUp', v_marker
      )
    where request.id = p_request_id and request.submission_id = p_expected_submission_id
    returning request.* into v_current;
  else
    update public.deal_hunter_cim_requests as request
    set
      updated_at = v_mutation_at,
      status = 'follow_up_failed',
      follow_up_state = case when p_outcome = 'ambiguous' then 'ambiguous' else 'failed' end,
      next_follow_up_at = case when p_outcome = 'ambiguous' then null else request.next_follow_up_at end,
      last_activity_at = v_mutation_at,
      metadata = coalesce(request.metadata, '{}'::jsonb) || jsonb_build_object('manualFollowUp', v_marker)
    where request.id = p_request_id
      and request.updated_at = p_expected_request_updated_at
      and request.submission_id = p_expected_submission_id
    returning request.* into v_current;
  end if;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'authority-changed', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;
  return jsonb_build_object('applied', true, 'reason', '', 'request', to_jsonb(v_current), 'activity', v_activity, 'alreadyFinalized', false);
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
  select * into v_probe
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id;

  if v_probe.id is null then
    return jsonb_build_object('claimed', false, 'reason', 'request-missing', 'request', null);
  end if;
  if v_probe.metadata #>> '{manualFollowUp,mode}' = 'operator-approved' then
    return jsonb_build_object('claimed', false, 'reason', 'approval-required', 'request', to_jsonb(v_probe));
  end if;
  if v_probe.submission_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'submission-missing', 'request', to_jsonb(v_probe));
  end if;

  select * into v_submission
  from public.contact_submissions as submission
  where submission.id = v_probe.submission_id
  for update;
  if v_submission.id is null then
    return jsonb_build_object('claimed', false, 'reason', 'submission-missing', 'request', to_jsonb(v_probe));
  end if;
  if v_submission.status = 'archived' then
    return jsonb_build_object('claimed', false, 'reason', 'submission-archived', 'request', to_jsonb(v_probe));
  end if;

  select * into v_current
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id
  for update;
  if v_current.id is null or v_current.submission_id is distinct from v_submission.id then
    return jsonb_build_object('claimed', false, 'reason', 'claim-ineligible', 'request', case when v_current.id is null then null else to_jsonb(v_current) end);
  end if;
  if v_current.metadata #>> '{manualFollowUp,mode}' = 'operator-approved' then
    return jsonb_build_object('claimed', false, 'reason', 'approval-required', 'request', to_jsonb(v_current));
  end if;

  update public.deal_hunter_cim_requests as request
  set status = 'follow_up_pending', delivery_error = '', updated_at = p_claimed_at
  where request.id = p_request_id
    and request.next_follow_up_at is not null
    and request.next_follow_up_at <= p_due_before
    and (
      request.status in ('sent', 'logged', 'failed', 'follow_up_failed')
      or (request.status = 'follow_up_pending' and p_stale_before is not null and request.updated_at <= p_stale_before)
    )
  returning request.* into v_current;
  if found then
    return jsonb_build_object('claimed', true, 'reason', '', 'request', to_jsonb(v_current));
  end if;
  select * into v_current from public.deal_hunter_cim_requests as request where request.id = p_request_id;
  return jsonb_build_object('claimed', false, 'reason', 'not-eligible', 'request', to_jsonb(v_current));
end;
$$;

revoke all on function public.start_deal_hunter_manual_follow_ups(text, timestamptz, uuid, timestamptz, jsonb, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.start_deal_hunter_manual_follow_ups(text, timestamptz, uuid, timestamptz, jsonb, timestamptz, jsonb)
  to service_role;
revoke all on function public.stop_deal_hunter_manual_follow_ups(text, timestamptz, uuid, timestamptz, timestamptz, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.stop_deal_hunter_manual_follow_ups(text, timestamptz, uuid, timestamptz, timestamptz, text, text, jsonb)
  to service_role;
revoke all on function public.claim_deal_hunter_approved_follow_up(text, timestamptz, uuid, timestamptz, integer, integer, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_deal_hunter_approved_follow_up(text, timestamptz, uuid, timestamptz, integer, integer, timestamptz, timestamptz)
  to service_role;
revoke all on function public.finalize_deal_hunter_approved_follow_up(text, timestamptz, uuid, integer, text, text, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_deal_hunter_approved_follow_up(text, timestamptz, uuid, integer, text, text, timestamptz, timestamptz, jsonb)
  to service_role;
revoke all on function public.claim_deal_hunter_cim_follow_up_request(text, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_deal_hunter_cim_follow_up_request(text, timestamptz, timestamptz, timestamptz)
  to service_role;
-- FL-01 additive provenance contract. This migration is schema-only: legacy
-- writers do not infer a first discovery from their pre-cutover data.
create table if not exists public.deal_hunter_source_freshness_state (
  source_id text primary key check (source_id = btrim(source_id) and char_length(source_id) between 1 and 160),
  next_generation bigint not null default 0 check (next_generation >= 0),
  accepted_generation bigint not null default 0 check (accepted_generation >= 0),
  accepted_run_id text check (accepted_run_id is null or (accepted_run_id = btrim(accepted_run_id) and char_length(accepted_run_id) between 1 and 200)),
  accepted_digest text check (accepted_digest is null or accepted_digest ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz,
  projection_state text not null default 'idle' check (projection_state in ('idle', 'pending', 'accepted', 'deferred', 'superseded')),
  check (accepted_generation <= next_generation),
  check ((accepted_generation = 0 and accepted_run_id is null and accepted_digest is null and accepted_at is null)
    or (accepted_generation > 0 and accepted_run_id is not null and accepted_digest is not null and accepted_at is not null))
);

create table if not exists public.deal_hunter_freshness_evidence (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  source_id text not null check (source_id = btrim(source_id) and char_length(source_id) between 1 and 160),
  source_name text not null check (source_name = btrim(source_name) and char_length(source_name) between 1 and 220),
  source_record_id text not null check (source_record_id = btrim(source_record_id) and char_length(source_record_id) between 1 and 200),
  run_id text not null check (run_id = btrim(run_id) and char_length(run_id) between 1 and 200),
  record_digest text check (record_digest is null or record_digest ~ '^[a-f0-9]{64}$'),
  generation bigint not null check (generation > 0),
  event_type text not null check (event_type in ('accepted_source_record', 'publication_evidence', 'material_change', 'evidence_state_change')),
  field_key text not null default '' check (char_length(field_key) <= 80 and field_key = btrim(field_key)),
  event_ordinal integer not null default 0 check (event_ordinal >= 0 and event_ordinal <= 10000),
  accepted_at timestamptz not null default clock_timestamp(),
  original_canonical_id text check (original_canonical_id is null or char_length(original_canonical_id) between 1 and 200),
  current_canonical_id text check (current_canonical_id is null or char_length(current_canonical_id) between 1 and 200),
  identity_exception_id text check (identity_exception_id is null or char_length(identity_exception_id) between 1 and 240),
  binding_audit_id text check (binding_audit_id is null or char_length(binding_audit_id) between 1 and 240),
  provenance_version text not null default 'fl-01-v1' check (provenance_version = btrim(provenance_version) and char_length(provenance_version) between 1 and 80),
  raw_header text check (raw_header is null or char_length(raw_header) <= 100),
  raw_value text check (raw_value is null or char_length(raw_value) <= 200),
  publication_meaning text not null default 'unknown' check (publication_meaning in ('unknown', 'listing_publication')),
  publication_date date,
  publication_instant timestamptz,
  publication_precision text not null default 'unknown' check (publication_precision in ('unknown', 'date', 'instant')),
  publication_offset text check (publication_offset is null or char_length(publication_offset) <= 16),
  publication_state text not null default 'unknown' check (publication_state in ('unknown', 'valid', 'invalid', 'future', 'conflict')),
  before_value numeric,
  after_value numeric,
  before_evidence_id text check (before_evidence_id is null or char_length(before_evidence_id) between 1 and 240),
  after_evidence_id text check (after_evidence_id is null or char_length(after_evidence_id) between 1 and 240),
  metric text not null default 'unknown' check (metric = btrim(metric) and char_length(metric) between 1 and 80),
  currency text not null default 'unknown' check (currency = btrim(currency) and char_length(currency) between 1 and 16),
  period text not null default 'unknown' check (period = btrim(period) and char_length(period) between 1 and 80),
  classification text check (classification is null or classification in ('new_evidence', 'conflict', 'selected_source_swap', 'disappearance', 'comparable_change')),
  material_revision bigint check (material_revision is null or material_revision >= 0),
  unique (run_id, source_id, source_record_id, event_type, field_key, event_ordinal)
);

create index if not exists idx_deal_hunter_freshness_evidence_canonical_time
  on public.deal_hunter_freshness_evidence (current_canonical_id, accepted_at desc, id);
create index if not exists idx_deal_hunter_freshness_evidence_source_record_time
  on public.deal_hunter_freshness_evidence (source_id, source_record_id, accepted_at desc);
create index if not exists idx_deal_hunter_freshness_evidence_run_source_record
  on public.deal_hunter_freshness_evidence (run_id, source_id, source_record_id);

alter table public.deal_hunter_opportunities
  add column if not exists first_accepted_at timestamptz,
  add column if not exists first_discovery_evidence_id text,
  add column if not exists discovery_state text not null default 'untracked_legacy',
  add column if not exists discovery_revision bigint not null default 0,
  add column if not exists material_revision bigint not null default 0,
  add column if not exists last_material_change_at timestamptz;
alter table public.deal_hunter_opportunities
  add constraint deal_hunter_opportunities_freshness_state_check
  check (discovery_state in ('untracked_legacy', 'pending', 'known_prospective', 'known_recovered')
    and discovery_revision >= 0 and material_revision >= 0);
alter table public.deal_hunter_opportunities
  add constraint deal_hunter_opportunities_first_evidence_fk
  foreign key (first_discovery_evidence_id) references public.deal_hunter_freshness_evidence(id) on delete restrict;

alter table public.deal_hunter_opportunity_source_observations
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_run_id text,
  add column if not exists accepted_evidence_id text,
  add column if not exists publication_raw_header text,
  add column if not exists publication_raw_value text,
  add column if not exists publication_precision text,
  add column if not exists publication_offset text,
  add column if not exists publication_meaning text;
alter table public.deal_hunter_opportunity_source_observations
  add constraint deal_hunter_source_observations_freshness_bounds_check
  check ((accepted_run_id is null or char_length(accepted_run_id) between 1 and 200)
    and (accepted_evidence_id is null or char_length(accepted_evidence_id) between 1 and 240)
    and (publication_raw_header is null or char_length(publication_raw_header) <= 100)
    and (publication_raw_value is null or char_length(publication_raw_value) <= 200)
    and (publication_precision is null or publication_precision in ('unknown', 'date', 'instant'))
    and (publication_offset is null or char_length(publication_offset) <= 16)
    and (publication_meaning is null or publication_meaning in ('unknown', 'listing_publication')));
alter table public.deal_hunter_opportunity_source_observations
  add constraint deal_hunter_source_observations_evidence_fk
  foreign key (accepted_evidence_id) references public.deal_hunter_freshness_evidence(id) on delete restrict;

alter table public.deal_hunter_opportunity_scores
  add column if not exists reviewed_discovery_revision bigint not null default 0,
  add column if not exists reviewed_material_revision bigint not null default 0;
alter table public.deal_hunter_opportunity_scores
  add constraint deal_hunter_score_freshness_review_check
  check (reviewed_discovery_revision >= 0 and reviewed_material_revision >= 0);

alter table public.deal_hunter_deal_os_imports
  add column if not exists freshness_generation bigint,
  add column if not exists freshness_projection_state text;
alter table public.deal_hunter_deal_os_imports
  add constraint deal_hunter_import_freshness_check
  check ((freshness_generation is null or freshness_generation > 0)
    and (freshness_projection_state is null or freshness_projection_state in ('pending', 'accepted', 'deferred', 'superseded')));

create or replace function public.guard_deal_hunter_freshness_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'freshness evidence is retained';
  end if;
  if (to_jsonb(new) - 'current_canonical_id' - 'binding_audit_id')
      is distinct from (to_jsonb(old) - 'current_canonical_id' - 'binding_audit_id')
    or new.current_canonical_id is not distinct from old.current_canonical_id
    or new.binding_audit_id is null
    or new.binding_audit_id is not distinct from old.binding_audit_id then
    raise exception 'freshness evidence payload is immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_deal_hunter_freshness_evidence on public.deal_hunter_freshness_evidence;
create trigger guard_deal_hunter_freshness_evidence before update or delete
  on public.deal_hunter_freshness_evidence for each row execute function public.guard_deal_hunter_freshness_evidence();

alter table public.deal_hunter_source_freshness_state enable row level security;
alter table public.deal_hunter_freshness_evidence enable row level security;
revoke all privileges on table public.deal_hunter_source_freshness_state, public.deal_hunter_freshness_evidence from public, anon, authenticated;
grant all privileges on table public.deal_hunter_source_freshness_state, public.deal_hunter_freshness_evidence to service_role;
revoke all on function public.guard_deal_hunter_freshness_evidence() from public, anon, authenticated;

create or replace function public.allocate_deal_hunter_source_generation(p_source_id text, p_run_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state public.deal_hunter_source_freshness_state%rowtype;
  v_generation bigint;
begin
  if p_source_id is null or p_source_id <> btrim(p_source_id) or char_length(p_source_id) not between 1 and 160
    or p_run_id is null or p_run_id <> btrim(p_run_id) or char_length(p_run_id) not between 1 and 200 then
    raise exception 'freshness source and run identities must be bounded' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_source_id, 91901));
  insert into public.deal_hunter_source_freshness_state(source_id) values (p_source_id)
    on conflict(source_id) do nothing;
  select * into strict v_state from public.deal_hunter_source_freshness_state
    where source_id = p_source_id for update;
  if v_state.accepted_run_id = p_run_id then
    return pg_catalog.jsonb_build_object('sourceId', p_source_id, 'runId', p_run_id, 'generation', v_state.accepted_generation);
  end if;
  v_generation := v_state.next_generation + 1;
  update public.deal_hunter_source_freshness_state set next_generation = v_generation where source_id = p_source_id;
  return pg_catalog.jsonb_build_object('sourceId', p_source_id, 'runId', p_run_id, 'generation', v_generation);
end;
$$;
revoke all on function public.allocate_deal_hunter_source_generation(text, text) from public, anon, authenticated;
grant execute on function public.allocate_deal_hunter_source_generation(text, text) to service_role;

create or replace function public.mark_deal_hunter_opportunity_discovery_pending(
  p_opportunity_id text, p_created_at timestamptz
) returns public.deal_hunter_opportunities
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.deal_hunter_opportunities%rowtype;
begin
  select * into v_row from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id for update;
  if not found or v_row.created_at is distinct from p_created_at or v_row.status <> 'active'
    or v_row.first_accepted_at is not null or v_row.discovery_revision <> 0
    or v_row.discovery_state not in ('untracked_legacy', 'pending') then
    raise exception 'freshness pending state requires a newly created active canonical identity' using errcode = '22023';
  end if;
  if v_row.discovery_state = 'untracked_legacy' then
    update public.deal_hunter_opportunities set discovery_state = 'pending'
      where opportunity_id = p_opportunity_id returning * into v_row;
  end if;
  return v_row;
end;
$$;
revoke all on function public.mark_deal_hunter_opportunity_discovery_pending(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.mark_deal_hunter_opportunity_discovery_pending(text, timestamptz)
  to service_role;

create or replace function public.classify_deal_hunter_publication_v1(
  p_claim jsonb, p_accepted_at timestamptz
) returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_raw text := p_claim ->> 'rawValue';
  v_date date;
  v_instant timestamptz;
begin
  if p_claim ->> 'meaning' is distinct from 'listing_publication' then
    return pg_catalog.jsonb_build_object('state', 'unknown');
  end if;
  if p_claim ->> 'precision' = 'date' and v_raw ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    and pg_catalog.pg_input_is_valid(v_raw, 'date') then
    v_date := v_raw::date;
    return pg_catalog.jsonb_build_object('state',
      case when v_date > (p_accepted_at at time zone 'America/Los_Angeles')::date
        then 'future' else 'valid' end, 'date', v_date);
  end if;
  if p_claim ->> 'precision' = 'datetime'
    and v_raw ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
    and pg_catalog.pg_input_is_valid(v_raw, 'timestamptz') then
    v_instant := v_raw::timestamptz;
    return pg_catalog.jsonb_build_object('state',
      case when v_instant > p_accepted_at then 'future' else 'valid' end,
      'instant', v_instant);
  end if;
  return pg_catalog.jsonb_build_object('state', 'invalid');
end;
$$;
revoke all on function public.classify_deal_hunter_publication_v1(jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.classify_deal_hunter_publication_v1(jsonb, timestamptz)
  to service_role;

create or replace function public.insert_deal_hunter_deal_os_import_freshness_v1(
  p_import jsonb, p_rows jsonb, p_generation bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state public.deal_hunter_source_freshness_state%rowtype;
  v_import_id uuid;
  v_digest text;
  v_accepted_at timestamptz;
  v_row jsonb;
  v_claim jsonb;
  v_publication jsonb;
  v_source_record_id text;
  v_ordinal integer;
  v_field text;
  v_field_key text;
  v_after_value numeric;
  v_stored public.deal_hunter_deal_os_imports%rowtype;
begin
  if pg_catalog.jsonb_typeof(p_import) <> 'object' or pg_catalog.jsonb_typeof(p_rows) <> 'array'
    or p_import ->> 'file_sha256' !~ '^[a-f0-9]{64}$'
    or p_generation is null or p_generation < 1 then
    raise exception 'Deal OS freshness import is malformed' using errcode = '22023';
  end if;
  v_import_id := (p_import ->> 'id')::uuid;
  if pg_catalog.jsonb_array_length(p_rows) <> (p_import ->> 'accepted_row_count')::integer
    or pg_catalog.jsonb_array_length(p_rows) not between 1 and 10000 then
    raise exception 'Deal OS accepted row scope is incomplete' using errcode = '22023';
  end if;
  v_digest := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_import ->> 'file_sha256', p_import -> 'row_accounting', p_import -> 'records', p_import ->> 'scope', p_rows
  )::text) || pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_import ->> 'file_sha256', p_import -> 'row_accounting', p_import -> 'records', p_import ->> 'scope', p_rows, 'fl-01-v1'
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('deal-os-export', 91901));
  select * into strict v_state from public.deal_hunter_source_freshness_state
    where source_id = 'deal-os-export' for update;
  if p_generation > v_state.next_generation then
    raise exception 'Deal OS generation was not allocated' using errcode = '22023';
  end if;
  if p_generation <= v_state.accepted_generation then
    if p_generation <> v_state.accepted_generation or v_state.accepted_run_id <> v_import_id::text
      or v_state.accepted_digest <> v_digest then
      raise exception 'stale or conflicting Deal OS freshness run' using errcode = '40001';
    end if;
    select * into v_stored from public.deal_hunter_deal_os_imports where id = v_import_id;
    if not found or v_stored.file_sha256 <> p_import ->> 'file_sha256' then
      raise exception 'conflicting Deal OS import replay' using errcode = '22023';
    end if;
    return to_jsonb(v_stored);
  end if;
  v_accepted_at := pg_catalog.clock_timestamp();
  insert into public.deal_hunter_deal_os_imports (
    id, created_at, imported_by, exported_at, file_name, file_type, file_size, file_sha256,
    scope, coverage_label, expected_row_count, row_count, source_row_count, accepted_row_count,
    rejected_row_count, canonical_record_count, parser_version, row_accounting,
    duplicate_count, stable_id_count, listing_url_count, coverage_limit_reached, records, metadata,
    freshness_generation, freshness_projection_state
  ) values (
    v_import_id, (p_import ->> 'created_at')::timestamptz, p_import ->> 'imported_by',
    (p_import ->> 'exported_at')::timestamptz, p_import ->> 'file_name', p_import ->> 'file_type',
    (p_import ->> 'file_size')::integer, p_import ->> 'file_sha256', p_import ->> 'scope',
    p_import ->> 'coverage_label', (p_import ->> 'expected_row_count')::integer,
    (p_import ->> 'row_count')::integer, (p_import ->> 'source_row_count')::integer,
    (p_import ->> 'accepted_row_count')::integer, (p_import ->> 'rejected_row_count')::integer,
    (p_import ->> 'canonical_record_count')::integer, p_import ->> 'parser_version',
    coalesce(p_import -> 'row_accounting', '[]'::jsonb),
    (p_import ->> 'duplicate_count')::integer, (p_import ->> 'stable_id_count')::integer,
    (p_import ->> 'listing_url_count')::integer, (p_import ->> 'coverage_limit_reached')::boolean,
    coalesce(p_import -> 'records', '[]'::jsonb), coalesce(p_import -> 'metadata', '{}'::jsonb),
    p_generation, 'pending'
  );
  for v_row in select value from pg_catalog.jsonb_array_elements(p_rows) as rows(value) loop
    v_source_record_id := v_row ->> 'sourceRecordId';
    v_ordinal := (v_row ->> 'eventOrdinal')::integer;
    if v_source_record_id is null or v_source_record_id <> btrim(v_source_record_id)
      or char_length(v_source_record_id) not between 1 and 200 or v_ordinal not between 0 and 10000
      or pg_catalog.jsonb_typeof(v_row -> 'freshnessEvidence') <> 'object' then
      raise exception 'Deal OS source row evidence is unbounded' using errcode = '22023';
    end if;
    insert into public.deal_hunter_freshness_evidence (
      id, source_id, source_name, source_record_id, run_id, generation,
      event_type, field_key, event_ordinal, accepted_at
    ) values (
      'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_import_id::text, v_source_record_id, 'accepted_source_record', '', v_ordinal::text)),
      'deal-os-export', 'SMB Deal OS export', v_source_record_id, v_import_id::text, p_generation,
      'accepted_source_record', '', v_ordinal, v_accepted_at
    );
    v_claim := v_row -> 'freshnessEvidence' -> 'dateAdded';
    if pg_catalog.jsonb_typeof(v_claim) = 'object' then
      v_publication := public.classify_deal_hunter_publication_v1(v_claim, v_accepted_at);
      if char_length(v_claim ->> 'rawHeader') > 100 or char_length(v_claim ->> 'rawValue') > 200 then
        raise exception 'Deal OS publication evidence is unbounded' using errcode = '22023';
      end if;
      insert into public.deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation,
        event_type, field_key, event_ordinal, accepted_at, raw_header, raw_value,
        publication_meaning, publication_precision, publication_date,
        publication_instant, publication_state, publication_offset
      ) values (
        'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_import_id::text, v_source_record_id, 'publication_evidence', 'date_added', v_ordinal::text)),
        'deal-os-export', 'SMB Deal OS export', v_source_record_id, v_import_id::text, p_generation,
        'publication_evidence', 'date_added', v_ordinal, v_accepted_at,
        v_claim ->> 'rawHeader', v_claim ->> 'rawValue',
        coalesce(v_claim ->> 'meaning', 'unknown'),
        case when v_claim ->> 'precision' = 'datetime' then 'instant'
          when v_claim ->> 'precision' = 'date' then 'date' else 'unknown' end,
        (v_publication ->> 'date')::date, (v_publication ->> 'instant')::timestamptz,
        v_publication ->> 'state', v_claim ->> 'offset'
      );
    end if;
    foreach v_field in array array['annualProfit', 'annualRevenue', 'askingPrice'] loop
      v_claim := v_row -> 'freshnessEvidence' -> v_field;
      if pg_catalog.jsonb_typeof(v_claim) is distinct from 'object' then continue; end if;
      if char_length(v_claim ->> 'rawHeader') > 100 or char_length(v_claim ->> 'rawValue') > 200 then
        raise exception 'Deal OS financial evidence is unbounded' using errcode = '22023';
      end if;
      v_field_key := case v_field when 'annualProfit' then 'annual_profit'
        when 'annualRevenue' then 'annual_revenue' else 'asking_price' end;
      v_after_value := null;
      if v_claim ->> 'rawValue' ~ '^\$?[0-9][0-9,]*(\.[0-9]+)?$' then
        v_after_value := pg_catalog.regexp_replace(v_claim ->> 'rawValue', '[$,]', '', 'g')::numeric;
      end if;
      insert into public.deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation,
        event_type, field_key, event_ordinal, accepted_at, raw_header, raw_value,
        after_value, metric, currency, period
      ) values (
        'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_import_id::text, v_source_record_id, 'accepted_source_record', v_field_key, v_ordinal::text)),
        'deal-os-export', 'SMB Deal OS export', v_source_record_id, v_import_id::text, p_generation,
        'accepted_source_record', v_field_key, v_ordinal, v_accepted_at,
        v_claim ->> 'rawHeader', v_claim ->> 'rawValue', v_after_value,
        coalesce(v_claim ->> 'metric', 'unknown'), coalesce(v_claim ->> 'currency', 'unknown'),
        coalesce(v_claim ->> 'period', 'unknown')
      );
    end loop;
  end loop;
  update public.deal_hunter_deal_os_imports set freshness_projection_state = 'superseded'
    where id <> v_import_id and freshness_projection_state = 'pending';
  update public.deal_hunter_source_freshness_state set
    accepted_generation = p_generation, accepted_run_id = v_import_id::text,
    accepted_digest = v_digest, accepted_at = v_accepted_at, projection_state = 'pending'
    where source_id = 'deal-os-export';
  select * into strict v_stored from public.deal_hunter_deal_os_imports where id = v_import_id;
  return to_jsonb(v_stored);
end;
$$;
revoke all on function public.insert_deal_hunter_deal_os_import_freshness_v1(jsonb, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.insert_deal_hunter_deal_os_import_freshness_v1(jsonb, jsonb, bigint)
  to service_role;

create or replace function public.accept_admitted_complete_google_sheet_freshness_v1(
  p_admission jsonb, p_records_text text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_source_id text;
  v_source_name text;
  v_run_id text;
  v_generation bigint;
  v_digest text;
  v_state public.deal_hunter_source_freshness_state%rowtype;
  v_records jsonb;
  v_unresolved jsonb := '[]'::jsonb;
  v_legacy_records jsonb;
  v_record jsonb;
  v_claim jsonb;
  v_publication jsonb;
  v_field text;
  v_core_id text;
  v_prior_id text;
  v_prior_digest text;
  v_recovered_id text;
  v_recovered_at timestamptz;
  v_recovered_run text;
  v_recovered_source_record_id text;
  v_recovered_exception_id text;
  v_before public.deal_hunter_freshness_evidence%rowtype;
  v_before_observation public.deal_hunter_opportunity_source_observations%rowtype;
  v_old_observation public.deal_hunter_opportunity_source_observations%rowtype;
  v_after_value numeric;
  v_field_key text;
  v_after_id text;
  v_competing boolean;
  v_comparable boolean;
  v_revision bigint;
  v_record_digest text;
  v_event_ids jsonb := '{}'::jsonb;
  v_accepted_at timestamptz;
begin
  if pg_catalog.jsonb_typeof(p_admission) <> 'object'
    or pg_catalog.jsonb_typeof(p_admission -> 'run') <> 'object'
    or p_records_text is null or pg_catalog.octet_length(p_records_text) not between 1 and 67108864
    or p_admission ->> 'freshness_digest' !~ '^[a-f0-9]{64}$' then
    raise exception 'complete Sheet freshness admission is malformed' using errcode = '22023';
  end if;
  v_source_id := p_admission ->> 'source_id';
  v_source_name := p_admission ->> 'source_name';
  v_run_id := p_admission -> 'run' ->> 'runId';
  v_generation := (p_admission -> 'run' ->> 'generation')::bigint;
  v_digest := pg_catalog.md5(p_records_text)
    || pg_catalog.md5(pg_catalog.md5(p_records_text) || v_run_id || v_generation::text);
  if p_admission -> 'run' ->> 'sourceId' is distinct from v_source_id
    or v_source_id !~ '^sheet-(0|[1-9][0-9]{0,3})$'
    or v_run_id is null or char_length(v_run_id) not between 1 and 200
    or v_generation < 1 or v_digest <> p_admission ->> 'freshness_digest' then
    raise exception 'complete Sheet freshness digest or run is invalid' using errcode = '22023';
  end if;
  v_records := p_records_text::jsonb;
  if pg_catalog.jsonb_typeof(v_records) = 'object' then
    v_unresolved := v_records -> 'unresolved';
    v_records := v_records -> 'records';
  end if;
  if pg_catalog.jsonb_typeof(v_records) <> 'array'
    or pg_catalog.jsonb_typeof(v_unresolved) <> 'array'
    or pg_catalog.jsonb_array_length(v_records) + pg_catalog.jsonb_array_length(v_unresolved)
      <> (p_admission ->> 'record_count')::integer
    or pg_catalog.jsonb_array_length(v_records) + pg_catalog.jsonb_array_length(v_unresolved)
      not between 1 and 10000
    or pg_catalog.jsonb_array_length(v_unresolved) <> coalesce((p_admission ->> 'deferred_count')::integer, 0)
    or pg_catalog.jsonb_array_length(v_records) <> coalesce((p_admission ->> 'resolved_count')::integer,
      pg_catalog.jsonb_array_length(v_records)) then
    raise exception 'complete Sheet freshness records are not the admitted scope' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(v_records) as record(value)
    where pg_catalog.jsonb_typeof(record.value -> 'freshness_evidence') not in ('object', 'null')
      or record.value ->> 'source_id' is distinct from v_source_id
      or record.value ->> 'source_name' is distinct from v_source_name
      or char_length(record.value ->> 'source_record_id') not between 1 and 200
      or char_length(record.value ->> 'opportunity_id') not between 1 and 200
  ) then
    raise exception 'complete Sheet freshness source records are malformed' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(v_unresolved) as item(value)
    where char_length(item.value ->> 'source_record_id') not between 1 and 200
      or char_length(item.value ->> 'identity_exception_id') not between 1 and 240
      or pg_catalog.jsonb_typeof(item.value -> 'freshness_evidence') not in ('object', 'null')
  ) or (
    select count(distinct source_record_id) from (
      select record.value ->> 'source_record_id' as source_record_id
        from pg_catalog.jsonb_array_elements(v_records) as record(value)
      union all
      select item.value ->> 'source_record_id'
        from pg_catalog.jsonb_array_elements(v_unresolved) as item(value)
    ) as all_records
  ) <> (p_admission ->> 'record_count')::integer then
    raise exception 'complete Sheet deferred records are malformed or duplicated' using errcode = '22023';
  end if;
  select pg_catalog.jsonb_agg(record.value - 'freshness_evidence' order by record.ordinality)
    into v_legacy_records
    from pg_catalog.jsonb_array_elements(v_records) with ordinality as record(value, ordinality);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(v_source_id)::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_source_id, 91901));
  select * into strict v_state from public.deal_hunter_source_freshness_state
    where source_id = v_source_id for update;
  if v_generation > v_state.next_generation then
    raise exception 'complete Sheet freshness generation was not allocated' using errcode = '22023';
  end if;
  if v_generation <= v_state.accepted_generation then
    if v_generation <> v_state.accepted_generation or v_state.accepted_run_id <> v_run_id
      or v_state.accepted_digest <> v_digest then
      raise exception 'stale or conflicting complete Sheet freshness run' using errcode = '40001';
    end if;
    return pg_catalog.jsonb_build_object('acceptedAt', v_state.accepted_at,
      'projectionState', v_state.projection_state, 'replayed', true);
  end if;
  v_accepted_at := pg_catalog.clock_timestamp();
  if pg_catalog.jsonb_array_length(v_unresolved) > 0 then
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(v_unresolved) as item(value)
      left join public.deal_hunter_identity_exceptions as exception
        on exception.id = item.value ->> 'identity_exception_id' and exception.status = 'open'
      where exception.id is null
    ) then
      raise exception 'deferred Sheet evidence lacks an open identity exception' using errcode = '22023';
    end if;
    for v_record in select value from (
      select value from pg_catalog.jsonb_array_elements(v_records) as resolved(value)
      union all
      select value from pg_catalog.jsonb_array_elements(v_unresolved) as pending(value)
    ) as all_records loop
      v_record_digest := pg_catalog.md5(v_record::text) || pg_catalog.md5(v_record::text || 'fl-01-v1');
      insert into public.deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation, record_digest,
        event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
        identity_exception_id
      ) values (
        'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
          v_record ->> 'source_record_id', 'accepted_source_record', '')),
        v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id, v_generation,
        v_record_digest, 'accepted_source_record', '', v_accepted_at,
        v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
        v_record ->> 'identity_exception_id'
      );
      v_claim := v_record -> 'freshness_evidence' -> 'dateAdded';
      if pg_catalog.jsonb_typeof(v_claim) = 'object' then
        v_publication := public.classify_deal_hunter_publication_v1(v_claim, v_accepted_at);
        insert into public.deal_hunter_freshness_evidence (
          id, source_id, source_name, source_record_id, run_id, generation, record_digest,
          event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
          identity_exception_id, raw_header, raw_value, publication_meaning,
          publication_precision, publication_offset, publication_date,
          publication_instant, publication_state
        ) values (
          'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
            v_record ->> 'source_record_id', 'publication_evidence', 'date_added')),
          v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
          v_generation, v_record_digest, 'publication_evidence', 'date_added', v_accepted_at,
          v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
          v_record ->> 'identity_exception_id', v_claim ->> 'rawHeader', v_claim ->> 'rawValue',
          coalesce(v_claim ->> 'meaning', 'unknown'),
          case when v_claim ->> 'precision' = 'datetime' then 'instant'
            when v_claim ->> 'precision' = 'date' then 'date' else 'unknown' end,
          v_claim ->> 'offset', (v_publication ->> 'date')::date,
          (v_publication ->> 'instant')::timestamptz, v_publication ->> 'state'
        );
      end if;
      foreach v_field in array array['annualProfit', 'annualRevenue', 'askingPrice'] loop
        v_claim := v_record -> 'freshness_evidence' -> v_field;
        if pg_catalog.jsonb_typeof(v_claim) is distinct from 'object' then continue; end if;
        if char_length(v_claim ->> 'rawHeader') > 100 or char_length(v_claim ->> 'rawValue') > 200 then
          raise exception 'deferred Sheet financial evidence is unbounded' using errcode = '22023';
        end if;
        v_field_key := case v_field when 'annualProfit' then 'annual_profit'
          when 'annualRevenue' then 'annual_revenue' else 'asking_price' end;
        v_after_value := null;
        if v_claim ->> 'rawValue' ~ '^\$?[0-9][0-9,]*(\.[0-9]+)?$' then
          v_after_value := pg_catalog.regexp_replace(v_claim ->> 'rawValue', '[$,]', '', 'g')::numeric;
        end if;
        insert into public.deal_hunter_freshness_evidence (
          id, source_id, source_name, source_record_id, run_id, generation, record_digest,
          event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
          identity_exception_id, raw_header, raw_value, after_value, metric, currency, period
        ) values (
          'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
            v_record ->> 'source_record_id', 'accepted_source_record', v_field_key)),
          v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
          v_generation, v_record_digest, 'accepted_source_record', v_field_key, v_accepted_at,
          v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
          v_record ->> 'identity_exception_id', v_claim ->> 'rawHeader', v_claim ->> 'rawValue',
          v_after_value, coalesce(v_claim ->> 'metric', 'unknown'),
          coalesce(v_claim ->> 'currency', 'unknown'), coalesce(v_claim ->> 'period', 'unknown')
        );
      end loop;
    end loop;
    update public.deal_hunter_source_freshness_state set
      accepted_generation = v_generation, accepted_run_id = v_run_id,
      accepted_digest = v_digest, accepted_at = v_accepted_at, projection_state = 'deferred'
      where source_id = v_source_id;
    return pg_catalog.jsonb_build_object('acceptedAt', v_accepted_at,
      'projectionState', 'deferred', 'replayed', false);
  end if;
  for v_record in select value from pg_catalog.jsonb_array_elements(v_records) as records(value) loop
    v_record_digest := pg_catalog.md5(pg_catalog.jsonb_build_object(
      'sourceRecordId', v_record ->> 'source_record_id',
      'fields', coalesce((select pg_catalog.jsonb_object_agg(field.value ->> 'field',
        field.value ->> 'value') from pg_catalog.jsonb_array_elements(
        v_record -> 'observations') as field(value)), '{}'::jsonb),
      'freshnessEvidence', v_record -> 'freshness_evidence')::text)
      || pg_catalog.md5('fl-01-v1' || pg_catalog.jsonb_build_object(
      'sourceRecordId', v_record ->> 'source_record_id',
      'fields', coalesce((select pg_catalog.jsonb_object_agg(field.value ->> 'field',
        field.value ->> 'value') from pg_catalog.jsonb_array_elements(
        v_record -> 'observations') as field(value)), '{}'::jsonb),
      'freshnessEvidence', v_record -> 'freshness_evidence')::text);
    select observation.accepted_evidence_id into v_prior_id
      from public.deal_hunter_opportunity_source_observations as observation
      where observation.source_id = v_source_id
        and observation.source_record_id = v_record ->> 'source_record_id'
        and observation.opportunity_id = v_record ->> 'opportunity_id'
      order by observation.id limit 1;
    select evidence.record_digest into v_prior_digest from public.deal_hunter_freshness_evidence as evidence
      where evidence.id = v_prior_id;
    if v_prior_digest = v_record_digest then
      v_core_id := v_prior_id;
    else
      v_core_id := 'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id,
        v_source_id, v_record ->> 'source_record_id', 'accepted_source_record', ''));
      insert into public.deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation, record_digest,
        event_type, field_key, accepted_at, original_canonical_id, current_canonical_id
      ) values (
        v_core_id, v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
        v_generation, v_record_digest, 'accepted_source_record', '', v_accepted_at,
        v_record ->> 'opportunity_id', v_record ->> 'opportunity_id'
      );
      v_claim := v_record -> 'freshness_evidence' -> 'dateAdded';
      if pg_catalog.jsonb_typeof(v_claim) = 'object' then
        v_publication := public.classify_deal_hunter_publication_v1(v_claim, v_accepted_at);
        if char_length(v_claim ->> 'rawHeader') > 100 or char_length(v_claim ->> 'rawValue') > 200 then
          raise exception 'complete Sheet publication evidence is unbounded' using errcode = '22023';
        end if;
        insert into public.deal_hunter_freshness_evidence (
          id, source_id, source_name, source_record_id, run_id, generation, record_digest,
          event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
          raw_header, raw_value, publication_meaning, publication_precision, publication_offset,
          publication_date, publication_instant, publication_state
        ) values (
          'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
            v_record ->> 'source_record_id', 'publication_evidence', 'date_added')),
          v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
          v_generation, v_record_digest, 'publication_evidence', 'date_added', v_accepted_at,
          v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
          v_claim ->> 'rawHeader', v_claim ->> 'rawValue',
          coalesce(v_claim ->> 'meaning', 'unknown'),
          case when v_claim ->> 'precision' = 'datetime' then 'instant'
            when v_claim ->> 'precision' = 'date' then 'date' else 'unknown' end,
          v_claim ->> 'offset', (v_publication ->> 'date')::date,
          (v_publication ->> 'instant')::timestamptz, v_publication ->> 'state'
        );
      end if;
      foreach v_field in array array['annualProfit', 'annualRevenue', 'askingPrice'] loop
        v_claim := v_record -> 'freshness_evidence' -> v_field;
        if pg_catalog.jsonb_typeof(v_claim) is distinct from 'object' then continue; end if;
        if char_length(v_claim ->> 'rawHeader') > 100 or char_length(v_claim ->> 'rawValue') > 200 then
          raise exception 'complete Sheet financial evidence is unbounded' using errcode = '22023';
        end if;
        v_field_key := case v_field when 'annualProfit' then 'annual_profit'
          when 'annualRevenue' then 'annual_revenue' else 'asking_price' end;
        v_after_id := 'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
          v_record ->> 'source_record_id', 'accepted_source_record', v_field_key));
        v_after_value := null;
        if pg_catalog.regexp_replace(v_claim ->> 'rawValue', '[$,]', '', 'g') ~ '^-?[0-9]+(\.[0-9]+)?$' then
          v_after_value := pg_catalog.regexp_replace(v_claim ->> 'rawValue', '[$,]', '', 'g')::numeric;
        end if;
        insert into public.deal_hunter_freshness_evidence (
          id, source_id, source_name, source_record_id, run_id, generation, record_digest,
          event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
          raw_header, raw_value, after_value, metric, currency, period
        ) values (
          v_after_id,
          v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
          v_generation, v_record_digest, 'accepted_source_record', v_field_key, v_accepted_at,
          v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
          v_claim ->> 'rawHeader', v_claim ->> 'rawValue', v_after_value,
          coalesce(v_claim ->> 'metric', 'unknown'), coalesce(v_claim ->> 'currency', 'unknown'),
          coalesce(v_claim ->> 'period', 'unknown')
        );
        select * into v_before_observation from public.deal_hunter_opportunity_source_observations
          where source_id = v_source_id and source_record_id = v_record ->> 'source_record_id'
            and field = v_field_key limit 1;
        select previous_field.* into v_before
          from public.deal_hunter_freshness_evidence as previous_core
          join public.deal_hunter_freshness_evidence as previous_field
            on previous_field.run_id = previous_core.run_id
            and previous_field.source_id = previous_core.source_id
            and previous_field.source_record_id = previous_core.source_record_id
            and previous_field.event_type = 'accepted_source_record'
            and previous_field.field_key = v_field_key
          where previous_core.id = v_before_observation.accepted_evidence_id;
        if v_before.id is null then
          select * into v_before from public.deal_hunter_freshness_evidence
            where source_id = v_source_id
              and source_record_id = v_record ->> 'source_record_id'
              and field_key = v_field_key and event_type = 'accepted_source_record'
              and run_id <> v_run_id
              and current_canonical_id = v_record ->> 'opportunity_id'
            order by accepted_at desc, id desc limit 1;
        end if;
        if v_before_observation.opportunity_id is distinct from v_record ->> 'opportunity_id'
          or v_before.after_value is not distinct from v_after_value then continue; end if;
        select exists (select 1 from public.deal_hunter_opportunity_source_observations
          where opportunity_id = v_record ->> 'opportunity_id'
            and source_id <> v_source_id and field = v_field_key
            and value is distinct from v_after_value::text) into v_competing;
        v_comparable := v_before.id is not null and not v_competing
          and v_before.after_value is not null and v_after_value is not null
          and v_claim ->> 'metric' is not null and v_claim ->> 'metric' <> 'unknown'
          and v_claim ->> 'currency' is not null and v_claim ->> 'currency' <> 'unknown'
          and v_claim ->> 'period' is not null and v_claim ->> 'period' <> 'unknown'
          and v_before.metric = v_claim ->> 'metric'
          and v_before.currency = v_claim ->> 'currency'
          and v_before.period = v_claim ->> 'period'
          and v_before.current_canonical_id = v_record ->> 'opportunity_id';
        if v_comparable then
          update public.deal_hunter_opportunities set material_revision = material_revision + 1,
            last_material_change_at = v_accepted_at
            where opportunity_id = v_record ->> 'opportunity_id'
            returning material_revision into v_revision;
        else
          v_revision := null;
        end if;
        insert into public.deal_hunter_freshness_evidence (
          id, source_id, source_name, source_record_id, run_id, generation, record_digest,
          event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
          before_value, after_value, before_evidence_id, after_evidence_id,
          metric, currency, period, classification, material_revision
        ) values (
          'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
            v_record ->> 'source_record_id',
            case when v_comparable then 'material_change' else 'evidence_state_change' end, v_field_key)),
          v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
          v_generation, v_record_digest,
          case when v_comparable then 'material_change' else 'evidence_state_change' end,
          v_field_key, v_accepted_at, v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
          v_before.after_value, v_after_value, v_before.id, v_after_id,
          coalesce(v_claim ->> 'metric', 'unknown'), coalesce(v_claim ->> 'currency', 'unknown'),
          coalesce(v_claim ->> 'period', 'unknown'),
          case when v_comparable then 'comparable_change' when v_competing then 'conflict'
            else 'new_evidence' end, v_revision
        );
      end loop;
      select evidence.id, evidence.accepted_at, evidence.run_id,
          evidence.source_record_id, evidence.identity_exception_id
        into v_recovered_id, v_recovered_at, v_recovered_run,
          v_recovered_source_record_id, v_recovered_exception_id
        from public.deal_hunter_freshness_evidence as evidence
        left join public.deal_hunter_identity_exceptions as exception
          on exception.id = evidence.identity_exception_id
        where evidence.source_id = v_source_id
          and evidence.run_id <> v_run_id
          and evidence.event_type = 'accepted_source_record' and evidence.field_key = ''
          and (evidence.current_canonical_id = v_record ->> 'opportunity_id'
            or (evidence.current_canonical_id is null and exception.status = 'resolved'
              and exception.metadata ->> 'resolvedOpportunityId' = v_record ->> 'opportunity_id'))
        order by evidence.accepted_at, evidence.id limit 1;
      if v_recovered_exception_id is not null then
        update public.deal_hunter_freshness_evidence set
          current_canonical_id = v_record ->> 'opportunity_id', binding_audit_id = v_run_id
          where source_id = v_source_id and source_record_id = v_recovered_source_record_id
            and run_id = v_recovered_run and current_canonical_id is null
            and identity_exception_id = v_recovered_exception_id;
      end if;
      -- A prior daily observation with no accepted proof leaves early history
      -- durably unknown. A later complete refresh must not invent a first date.
      if v_recovered_id is null and exists (
        select 1 from public.deal_hunter_opportunity_source_observations as prior
        where prior.opportunity_id = v_record ->> 'opportunity_id'
          and prior.source_id = v_source_id
          and prior.source_record_id = v_record ->> 'source_record_id'
          and prior.accepted_evidence_id is null
      ) then
        update public.deal_hunter_opportunities set discovery_state = 'untracked_legacy'
          where opportunity_id = v_record ->> 'opportunity_id'
            and discovery_state = 'pending' and first_accepted_at is null;
      else
      update public.deal_hunter_opportunities set
        first_accepted_at = coalesce(v_recovered_at, v_accepted_at),
        first_discovery_evidence_id = coalesce(v_recovered_id, v_core_id),
        discovery_state = case when v_recovered_id is not null then 'known_recovered'
          else 'known_prospective' end, discovery_revision = discovery_revision + 1
        where opportunity_id = v_record ->> 'opportunity_id'
          and discovery_state = 'pending' and first_accepted_at is null;
      end if;
    end if;
    v_event_ids := v_event_ids || pg_catalog.jsonb_build_object(v_record ->> 'source_record_id', v_core_id);
  end loop;

  for v_old_observation in select observation.*
    from public.deal_hunter_opportunity_source_observations as observation
    where observation.source_id = v_source_id
      and observation.field in ('asking_price', 'annual_profit', 'annual_revenue')
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(v_records) as record(value)
        cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as field(value)
        where record.value ->> 'opportunity_id' = observation.opportunity_id
          and record.value ->> 'source_record_id' = observation.source_record_id
          and field.value ->> 'field' = observation.field
      )
  loop
    select prior_field.* into v_before
      from public.deal_hunter_freshness_evidence as prior_core
      join public.deal_hunter_freshness_evidence as prior_field
        on prior_field.run_id = prior_core.run_id and prior_field.source_id = prior_core.source_id
        and prior_field.source_record_id = prior_core.source_record_id
        and prior_field.event_type = 'accepted_source_record'
        and prior_field.field_key = v_old_observation.field
      where prior_core.id = v_old_observation.accepted_evidence_id;
    if v_before.id is not null then
      insert into public.deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation,
        event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
        before_value, before_evidence_id, metric, currency, period, classification
      ) values (
        'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
          v_old_observation.source_record_id, 'evidence_state_change', v_old_observation.field)),
        v_source_id, v_source_name, v_old_observation.source_record_id, v_run_id, v_generation,
        'evidence_state_change', v_old_observation.field, v_accepted_at,
        v_old_observation.opportunity_id, v_old_observation.opportunity_id,
        v_before.after_value, v_before.id, v_before.metric, v_before.currency,
        v_before.period, 'disappearance'
      );
    end if;
  end loop;
  perform 1 from public.replace_admitted_complete_google_sheet_source_snapshot(
    p_admission - 'run' - 'freshness_digest' - 'resolved_count' - 'deferred_count', v_legacy_records);
  for v_record in select value from pg_catalog.jsonb_array_elements(v_records) as records(value) loop
    v_claim := v_record -> 'freshness_evidence' -> 'dateAdded';
    update public.deal_hunter_opportunity_source_observations as observation set
      accepted_at = v_accepted_at, accepted_run_id = v_run_id,
      accepted_evidence_id = v_event_ids ->> (v_record ->> 'source_record_id'),
      publication_raw_header = case when observation.field = 'date_added' then v_claim ->> 'rawHeader' else null end,
      publication_raw_value = case when observation.field = 'date_added' then v_claim ->> 'rawValue' else null end,
      publication_precision = case when observation.field = 'date_added' then
        case when v_claim ->> 'precision' = 'datetime' then 'instant' else v_claim ->> 'precision' end else null end,
      publication_offset = case when observation.field = 'date_added' then v_claim ->> 'offset' else null end,
      publication_meaning = case when observation.field = 'date_added' then v_claim ->> 'meaning' else null end
      where observation.source_id = v_source_id
        and observation.source_record_id = v_record ->> 'source_record_id'
        and observation.opportunity_id = v_record ->> 'opportunity_id';
  end loop;
  update public.deal_hunter_source_freshness_state set
    accepted_generation = v_generation, accepted_run_id = v_run_id,
    accepted_digest = v_digest, accepted_at = v_accepted_at, projection_state = 'accepted'
    where source_id = v_source_id;
  return pg_catalog.jsonb_build_object('acceptedAt', v_accepted_at,
    'projectionState', 'accepted', 'replayed', false);
end;
$$;
revoke all on function public.accept_admitted_complete_google_sheet_freshness_v1(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.accept_admitted_complete_google_sheet_freshness_v1(jsonb, text)
  to service_role;

create or replace function public.bind_accepted_deal_hunter_freshness_v1(
  p_import_id uuid, p_opportunity_id text, p_source_record_id text,
  p_expected_generation bigint, p_snapshot jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_import public.deal_hunter_deal_os_imports%rowtype;
  v_state public.deal_hunter_source_freshness_state%rowtype;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_event public.deal_hunter_freshness_evidence%rowtype;
  v_prior_event public.deal_hunter_freshness_evidence%rowtype;
  v_current_listing text;
  v_prior_listing text;
  v_proven_earlier boolean;
  v_observation jsonb;
  v_publication jsonb;
  v_unbound integer;
  v_projection_state text;
  v_field text;
  v_field_key text;
  v_after public.deal_hunter_freshness_evidence%rowtype;
  v_before public.deal_hunter_freshness_evidence%rowtype;
  v_prior_observation public.deal_hunter_opportunity_source_observations%rowtype;
  v_competing boolean;
  v_comparable boolean;
  v_revision bigint;
  v_transition_type text;
begin
  if p_import_id is null or p_opportunity_id is null or p_source_record_id is null
    or char_length(p_opportunity_id) not between 1 and 200
    or char_length(p_source_record_id) not between 1 and 200
    or p_expected_generation is null or p_expected_generation < 1
    or pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
    or p_snapshot ->> 'opportunity_id' is distinct from p_opportunity_id
    or p_snapshot ->> 'source_id' is distinct from 'deal-os-export'
    or p_snapshot ->> 'source_record_id' is distinct from p_source_record_id
    or pg_catalog.jsonb_typeof(p_snapshot -> 'observations') <> 'array'
    or pg_catalog.jsonb_array_length(p_snapshot -> 'observations') not between 1 and 51 then
    raise exception 'Deal OS accepted binding snapshot is malformed' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('deal-os-export', 91901));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_opportunity_id, 91902));
  select * into v_import from public.deal_hunter_deal_os_imports
    where id = p_import_id for update;
  select * into v_state from public.deal_hunter_source_freshness_state
    where source_id = 'deal-os-export' for update;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id for update;
  select * into v_event from public.deal_hunter_freshness_evidence
    where run_id = p_import_id::text and source_id = 'deal-os-export'
      and source_record_id = p_source_record_id
      and event_type = 'accepted_source_record' and field_key = ''
    order by event_ordinal limit 1;
  if v_import.id is null or v_import.freshness_generation is distinct from p_expected_generation
    or v_event.id is null or v_event.generation <> p_expected_generation
    or v_opportunity.opportunity_id is null or v_opportunity.status <> 'active' then
    raise exception 'Deal OS accepted binding lacks an import, event, or current canonical identity' using errcode = '22023';
  end if;
  if exists (select 1 from public.deal_hunter_freshness_evidence
    where run_id = p_import_id::text and source_id = 'deal-os-export'
      and source_record_id = p_source_record_id
      and current_canonical_id is not null and current_canonical_id <> p_opportunity_id) then
    raise exception 'Deal OS accepted evidence is bound to another canonical identity' using errcode = '23505';
  end if;
  update public.deal_hunter_freshness_evidence set
    current_canonical_id = p_opportunity_id, binding_audit_id = p_import_id::text
    where run_id = p_import_id::text and source_id = 'deal-os-export'
      and source_record_id = p_source_record_id and current_canonical_id is null;
  select earlier.* into v_prior_event
    from public.deal_hunter_freshness_evidence as earlier
    where earlier.source_id = 'deal-os-export' and earlier.source_record_id = p_source_record_id
      and earlier.event_type = 'accepted_source_record' and earlier.field_key = ''
      and earlier.accepted_at < v_event.accepted_at
    order by earlier.accepted_at, earlier.id limit 1;
  select prior_import.row_accounting -> v_prior_event.event_ordinal::integer ->> 'listingIdentity'
    into v_prior_listing from public.deal_hunter_deal_os_imports as prior_import
    where prior_import.id::text = v_prior_event.run_id;
  v_current_listing := v_import.row_accounting -> v_event.event_ordinal::integer ->> 'listingIdentity';
  v_proven_earlier := v_prior_event.id is not null and nullif(v_current_listing, '') is not null
    and v_prior_listing = v_current_listing;
  if v_proven_earlier and v_prior_event.current_canonical_id is not null
    and v_prior_event.current_canonical_id <> p_opportunity_id then
    raise exception 'Earlier accepted Deal OS listing is bound to another canonical identity' using errcode = '23505';
  end if;
  if v_proven_earlier and v_prior_event.current_canonical_id is null then
    update public.deal_hunter_freshness_evidence set
      current_canonical_id = p_opportunity_id, binding_audit_id = p_import_id::text
      where run_id = v_prior_event.run_id and source_id = 'deal-os-export'
        and source_record_id = p_source_record_id and current_canonical_id is null;
  end if;
  if v_opportunity.discovery_state = 'pending' and v_opportunity.first_accepted_at is null then
    if v_prior_event.id is null or v_proven_earlier then
      update public.deal_hunter_opportunities set
      first_accepted_at = case when v_proven_earlier then v_prior_event.accepted_at else v_event.accepted_at end,
      first_discovery_evidence_id = case when v_proven_earlier then v_prior_event.id else v_event.id end,
      discovery_state = case when not v_proven_earlier and v_state.accepted_generation = p_expected_generation
        and v_state.accepted_run_id = p_import_id::text then 'known_prospective'
        else 'known_recovered' end, discovery_revision = discovery_revision + 1
      where opportunity_id = p_opportunity_id;
    end if;
  elsif v_opportunity.discovery_state in ('known_prospective', 'known_recovered')
    and v_opportunity.first_accepted_at is not null
    and v_event.accepted_at < v_opportunity.first_accepted_at then
    update public.deal_hunter_opportunities set
      first_accepted_at = v_event.accepted_at, first_discovery_evidence_id = v_event.id,
      discovery_state = 'known_recovered', discovery_revision = discovery_revision + 1
      where opportunity_id = p_opportunity_id;
  end if;
  if v_state.accepted_generation <> p_expected_generation
    or v_state.accepted_run_id <> p_import_id::text then
    update public.deal_hunter_deal_os_imports set freshness_projection_state = 'superseded'
      where id = p_import_id;
    return pg_catalog.jsonb_build_object('bound', true, 'projectionState', 'superseded');
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_snapshot -> 'observations') as observation(value)
    where observation.value ->> 'opportunity_id' is distinct from p_opportunity_id
      or observation.value ->> 'source_id' is distinct from 'deal-os-export'
      or observation.value ->> 'source_record_id' is distinct from p_source_record_id
      or observation.value ->> 'source_name' is distinct from p_snapshot ->> 'source_name'
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_snapshot -> 'observations') as observation(value)
      group by observation.value ->> 'field' having count(*) > 1
  ) then
    raise exception 'Deal OS accepted binding observations do not share one source record' using errcode = '22023';
  end if;
  foreach v_field in array array['annualProfit', 'annualRevenue', 'askingPrice'] loop
    if pg_catalog.jsonb_typeof(p_snapshot -> 'freshness_evidence' -> v_field) is distinct from 'object' then
      continue;
    end if;
    v_field_key := case v_field when 'annualProfit' then 'annual_profit'
      when 'annualRevenue' then 'annual_revenue' else 'asking_price' end;
    select * into v_after from public.deal_hunter_freshness_evidence
      where run_id = p_import_id::text and source_id = 'deal-os-export'
        and source_record_id = p_source_record_id and event_type = 'accepted_source_record'
        and field_key = v_field_key and event_ordinal = v_event.event_ordinal;
    if v_after.id is null then
      raise exception 'Deal OS financial projection lacks its accepted field evidence' using errcode = '22023';
    end if;
    select * into v_prior_observation from public.deal_hunter_opportunity_source_observations
      where opportunity_id = p_opportunity_id and source_id = 'deal-os-export'
        and source_record_id = p_source_record_id and field = v_field_key limit 1;
    if v_prior_observation.id is null then continue; end if;
    select previous_field.* into v_before
      from public.deal_hunter_freshness_evidence as previous_core
      join public.deal_hunter_freshness_evidence as previous_field
        on previous_field.run_id = previous_core.run_id
        and previous_field.source_id = previous_core.source_id
        and previous_field.source_record_id = previous_core.source_record_id
        and previous_field.event_type = 'accepted_source_record'
        and previous_field.field_key = v_field_key
        and previous_field.event_ordinal = previous_core.event_ordinal
      where previous_core.id = v_prior_observation.accepted_evidence_id;
    if v_before.after_value is not distinct from v_after.after_value
      or v_prior_observation.value = v_after.after_value::text then continue; end if;
    select exists (select 1 from public.deal_hunter_opportunity_source_observations
      where opportunity_id = p_opportunity_id and source_id <> 'deal-os-export'
        and field = v_field_key and value is distinct from v_after.after_value::text)
      into v_competing;
    v_comparable := v_before.id is not null and not v_competing
      and v_before.after_value is not null and v_after.after_value is not null
      and v_after.metric <> 'unknown' and v_after.currency <> 'unknown'
      and v_after.period <> 'unknown' and v_before.metric = v_after.metric
      and v_before.currency = v_after.currency and v_before.period = v_after.period
      and v_before.current_canonical_id = p_opportunity_id;
    if v_comparable then
      update public.deal_hunter_opportunities set material_revision = material_revision + 1,
        last_material_change_at = v_event.accepted_at where opportunity_id = p_opportunity_id
        returning material_revision into v_revision;
    else
      v_revision := null;
    end if;
    v_transition_type := case when v_comparable then 'material_change' else 'evidence_state_change' end;
    insert into public.deal_hunter_freshness_evidence
      (id, source_id, source_name, source_record_id, run_id, generation,
        event_type, field_key, event_ordinal, accepted_at, original_canonical_id,
        current_canonical_id, before_value, after_value, before_evidence_id,
        after_evidence_id, metric, currency, period, classification, material_revision)
    values ('fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', p_import_id::text,
        p_source_record_id, v_transition_type, v_field_key, v_event.event_ordinal::text)),
      'deal-os-export', v_after.source_name, p_source_record_id, p_import_id::text,
      p_expected_generation, v_transition_type, v_field_key, v_event.event_ordinal,
      v_event.accepted_at, p_opportunity_id, p_opportunity_id,
      v_before.after_value, v_after.after_value, v_before.id, v_after.id,
      v_after.metric, v_after.currency, v_after.period,
      case when v_comparable then 'comparable_change' when v_competing then 'conflict'
        else 'new_evidence' end, v_revision);
  end loop;
  v_publication := p_snapshot -> 'freshness_evidence' -> 'dateAdded';
  for v_observation in select value from pg_catalog.jsonb_array_elements(p_snapshot -> 'observations') as observations(value) loop
    insert into public.deal_hunter_opportunity_source_observations (
      id, opportunity_id, source_id, source_name, source_record_id,
      field, value, observed_at, created_at, updated_at,
      accepted_at, accepted_run_id, accepted_evidence_id,
      publication_raw_header, publication_raw_value, publication_precision,
      publication_offset, publication_meaning
    ) values (
      v_observation ->> 'id', p_opportunity_id, 'deal-os-export', p_snapshot ->> 'source_name',
      p_source_record_id, v_observation ->> 'field', v_observation ->> 'value',
      (v_observation ->> 'observed_at')::timestamptz,
      (v_observation ->> 'created_at')::timestamptz,
      (v_observation ->> 'updated_at')::timestamptz,
      v_event.accepted_at, p_import_id::text, v_event.id,
      case when v_observation ->> 'field' = 'date_added' then v_publication ->> 'rawHeader' else null end,
      case when v_observation ->> 'field' = 'date_added' then v_publication ->> 'rawValue' else null end,
      case when v_observation ->> 'field' = 'date_added' then
        case when v_publication ->> 'precision' = 'datetime' then 'instant'
          else v_publication ->> 'precision' end else null end,
      case when v_observation ->> 'field' = 'date_added' then v_publication ->> 'offset' else null end,
      case when v_observation ->> 'field' = 'date_added' then v_publication ->> 'meaning' else null end
    ) on conflict (opportunity_id, source_id, source_record_id, field) do update set
      source_name = excluded.source_name, value = excluded.value,
      observed_at = excluded.observed_at, updated_at = excluded.updated_at,
      accepted_at = excluded.accepted_at, accepted_run_id = excluded.accepted_run_id,
      accepted_evidence_id = excluded.accepted_evidence_id,
      publication_raw_header = excluded.publication_raw_header,
      publication_raw_value = excluded.publication_raw_value,
      publication_precision = excluded.publication_precision,
      publication_offset = excluded.publication_offset,
      publication_meaning = excluded.publication_meaning;
  end loop;
  delete from public.deal_hunter_opportunity_source_observations as observation
    where observation.opportunity_id = p_opportunity_id
      and observation.source_id = 'deal-os-export'
      and observation.source_record_id = p_source_record_id
      and not exists (select 1 from pg_catalog.jsonb_array_elements(p_snapshot -> 'observations') as proposed(value)
        where proposed.value ->> 'field' = observation.field);
  select count(*) into v_unbound from public.deal_hunter_freshness_evidence
    where run_id = p_import_id::text and source_id = 'deal-os-export'
      and event_type = 'accepted_source_record' and field_key = ''
      and current_canonical_id is null;
  v_projection_state := case when v_unbound = 0 then 'accepted' else 'pending' end;
  update public.deal_hunter_deal_os_imports set freshness_projection_state = v_projection_state
    where id = p_import_id;
  update public.deal_hunter_source_freshness_state set projection_state = v_projection_state
    where source_id = 'deal-os-export';
  return pg_catalog.jsonb_build_object('bound', true, 'projectionState', v_projection_state);
end;
$$;
revoke all on function public.bind_accepted_deal_hunter_freshness_v1(uuid, text, text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.bind_accepted_deal_hunter_freshness_v1(uuid, text, text, bigint, jsonb)
  to service_role;

create or replace function public.set_deal_hunter_operator_decision_freshness_v1(
  p_opportunity_id text, p_decision jsonb,
  p_expected_discovery_revision bigint, p_expected_material_revision bigint
) returns public.deal_hunter_opportunity_scores
language plpgsql security definer set search_path = '' as $$
declare
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
begin
  if p_expected_discovery_revision is null or p_expected_material_revision is null
    or p_expected_discovery_revision < 0 or p_expected_material_revision < 0 then
    raise exception 'freshness review requires two nonnegative revisions' using errcode = '22023';
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id for update;
  if v_opportunity.opportunity_id is null then return null; end if;
  if v_opportunity.discovery_revision <> p_expected_discovery_revision
    or v_opportunity.material_revision <> p_expected_material_revision then
    raise exception 'FL01_STALE_REVIEW' using errcode = 'P0001';
  end if;
  v_score := public.set_deal_hunter_opportunity_operator_decision(p_opportunity_id, p_decision);
  if v_score.opportunity_id is null then return null; end if;
  if p_decision ? 'reviewed_at' then
    update public.deal_hunter_opportunity_scores set
      reviewed_discovery_revision = p_expected_discovery_revision,
      reviewed_material_revision = p_expected_material_revision
      where opportunity_id = p_opportunity_id returning * into v_score;
  end if;
  return v_score;
end;
$$;
revoke all on function public.set_deal_hunter_operator_decision_freshness_v1(text, jsonb, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.set_deal_hunter_operator_decision_freshness_v1(text, jsonb, bigint, bigint)
  to service_role;

create or replace function public.pass_deal_hunter_opportunity_freshness_v1(
  p_command jsonb, p_expected_discovery_revision bigint, p_expected_material_revision bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_result jsonb;
  v_score public.deal_hunter_opportunity_scores%rowtype;
begin
  if p_expected_discovery_revision is null or p_expected_material_revision is null
    or p_expected_discovery_revision < 0 or p_expected_material_revision < 0 then
    raise exception 'freshness review requires two nonnegative revisions' using errcode = '22023';
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_command ->> 'opportunity_id' for update;
  if v_opportunity.opportunity_id is not null and (
    v_opportunity.discovery_revision <> p_expected_discovery_revision
    or v_opportunity.material_revision <> p_expected_material_revision) then
    raise exception 'FL01_STALE_REVIEW' using errcode = 'P0001';
  end if;
  v_result := public.pass_deal_hunter_opportunity(p_command);
  if v_result ->> 'applied' = 'true' then
    update public.deal_hunter_opportunity_scores set
      reviewed_discovery_revision = p_expected_discovery_revision,
      reviewed_material_revision = p_expected_material_revision
      where opportunity_id = p_command ->> 'opportunity_id' returning * into v_score;
    v_result := pg_catalog.jsonb_set(v_result, '{score}', to_jsonb(v_score), true);
  end if;
  return v_result;
end;
$$;
revoke all on function public.pass_deal_hunter_opportunity_freshness_v1(jsonb, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.pass_deal_hunter_opportunity_freshness_v1(jsonb, bigint, bigint)
  to service_role;

-- Reader-only fixed-size revision state. The input is a compact tuple, never
-- the full score or retained evidence payload.
create or replace function public.deal_hunter_fresh_inbox_hash_step_v1(
  p_state text, p_tuple text
) returns text language sql immutable set search_path = public as $$
  select md5(coalesce(p_state, '') || octet_length(coalesce(p_tuple, ''))::text
    || ':' || coalesce(p_tuple, ''));
$$;
drop aggregate if exists public.deal_hunter_fresh_inbox_hash_v1(text);
create aggregate public.deal_hunter_fresh_inbox_hash_v1(text) (
  sfunc = public.deal_hunter_fresh_inbox_hash_step_v1,
  stype = text,
  initcond = ''
);
revoke all on function public.deal_hunter_fresh_inbox_hash_step_v1(text, text) from public, anon, authenticated;
revoke all on function public.deal_hunter_fresh_inbox_hash_step_v1(text, text) from public;
grant execute on function public.deal_hunter_fresh_inbox_hash_step_v1(text, text) to service_role;
revoke all on function public.deal_hunter_fresh_inbox_hash_v1(text) from public, anon, authenticated;
grant execute on function public.deal_hunter_fresh_inbox_hash_v1(text) to service_role;

drop function if exists public.list_deal_hunter_fresh_inbox_v1(
  text, integer, integer, text, text, text, text, timestamptz);
create or replace function public.list_deal_hunter_fresh_inbox_v1(
  p_area text default 'inbox', p_offset integer default 0, p_limit integer default 25,
  p_search text default '', p_confidence text default '', p_priority text default '',
  p_state text default '', p_as_of timestamptz default now(),
  p_sort text default 'acquisition-priority'
) returns jsonb language sql stable security definer set search_path = public as $$
  with parameters as (
    select (p_as_of at time zone 'America/Los_Angeles')::date as business_date,
      greatest(0, least(coalesce(p_offset, 0), 100000)) as page_offset,
      greatest(1, least(coalesce(p_limit, 25), 100)) as page_limit
  ), due_actions as materialized (
    select request.opportunity_id, min(request.next_follow_up_at) as due_at
    from public.deal_hunter_cim_requests as request
    join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = request.opportunity_id
        and opportunity.primary_submission_id = request.submission_id
        and opportunity.status = 'active'
    join public.contact_submissions as submission on submission.id = request.submission_id
    where request.follow_up_state = 'scheduled'
      and request.request_state = 'provider_accepted'
      and request.delivery_state = 'accepted'
      and request.responded_at is null and request.follow_up_count < 5
      and request.next_follow_up_at <= p_as_of and submission.status not in ('archived', 'spam')
      and request.metadata #>> '{manualFollowUp,mode}' = 'operator-approved'
      and request.metadata #>> '{manualFollowUp,version}' = 'deal-hunter-manual-follow-up-v1'
      and request.metadata #>> '{manualFollowUp,maximumFollowUps}' = '5'
      and request.metadata #>> '{manualFollowUp,cadencePolicy}' =
        'accepted-local-date-plus-2-weekend-forward-0900-pt-v1'
      and request.metadata #>> '{manualFollowUp,stoppedAt}' is null
    group by request.opportunity_id
  ), action_evidence as materialized (
    select opportunity.opportunity_id,
      case when latest.direction = 'inbound' and latest.source = 'resend-webhook'
        and latest.kind = 'broker-reply' and latest.delivery_state = 'replied'
        then latest.occurred_at else null end as reply_at,
      case when coalesce(submission.metadata #>> '{diligence,stage}', '')
          not in ('financial-review','lender-review','loi-candidate')
        and coalesce(submission.metadata #>> '{acquisitionCommand,pipelineStage}', '')
          not in ('diligence','loi-candidate')
        then greatest(document.action_at, upload.action_at) else null end as materials_at
    from public.deal_hunter_opportunities as opportunity
    join public.contact_submissions as submission on submission.id = opportunity.primary_submission_id
    left join lateral (select direction, source, kind, delivery_state, occurred_at
      from public.crm_communications as communication
      where communication.submission_id = submission.id
      order by occurred_at desc, id desc limit 1) as latest on true
    left join lateral (select max(created_at) as action_at
      from public.secure_documents as document
      where document.submission_id = submission.id
        and document.document_type in ('cim','teaser','prospectus','offering_memorandum',
          'offering_materials','data_room','broker_materials','financials','financial_package',
          'financial_statements','p_and_l','tax_returns','balance_sheet')) as document on true
    left join lateral (select max(coalesce(last_uploaded_at, updated_at)) as action_at
      from public.secure_upload_requests as request
      where request.submission_id = submission.id
        and request.status in ('completed','documents-received')
        and exists (select 1 from pg_catalog.jsonb_array_elements(request.requested_documents) as requested(value)
          where case when pg_catalog.jsonb_typeof(requested.value) = 'string'
            then trim(both '"' from requested.value::text)
            else coalesce(requested.value ->> 'category', requested.value ->> 'id') end
            in ('cim','teaser','prospectus','offering_memorandum','offering_materials',
              'data_room','broker_materials','financials','financial_package',
              'financial_statements','p_and_l','tax_returns','balance_sheet'))
    ) as upload on true
    where opportunity.status = 'active' and submission.status not in ('archived','spam')
      and submission.follow_up_state <> 'completed'
  ), base as materialized (
    select scores.opportunity_id, scores.fit_score, scores.confidence,
      scores.contradiction_count, scores.score_fingerprint, scores.semantic_digest,
      (select max(source.updated_at)
        from public.deal_hunter_opportunity_source_observations as source
        where source.opportunity_id = scores.opportunity_id) as source_snapshot_updated_at,
      scores.operator_priority, scores.reviewed_at,
      scores.reviewed_discovery_revision, scores.reviewed_material_revision,
      opportunity.first_accepted_at, opportunity.discovery_state,
      opportunity.discovery_revision, opportunity.material_revision,
      opportunity.last_material_change_at,
      coalesce(action.reply_at, action.materials_at, due.due_at) as due_at,
      case when action.reply_at is not null then 'broker_reply'
        when action.materials_at is not null then 'materials_ready'
        when due.due_at is not null then 'due_follow_up' else null end as action_reason,
      publication_latest.publication_date,
      publication_latest.publication_instant, publication_latest.publication_state,
      publication_latest.source_name as publication_source,
      publication_latest.publication_precision,
      publication_stats.publication_distinct_count,
      publication_stats.publication_unsupported_count,
      case when p_area = 'research' then (select count(*) from (select source.field
        from public.deal_hunter_opportunity_source_observations as source
        where source.opportunity_id = scores.opportunity_id
          and source.field in ('annual_profit', 'annual_revenue', 'asking_price')
        group by source.field having count(distinct source.value) > 1) as conflict_fields)
        else 0 end
        as source_conflict_count,
      null::text as material_field
    from public.deal_hunter_opportunity_scores as scores
    join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = scores.opportunity_id and opportunity.status = 'active'
    left join public.deal_hunter_dispositions as disposition
      on disposition.deal_key = scores.deal_key and disposition.disposition = 'dismissed'
    left join due_actions as due on due.opportunity_id = scores.opportunity_id
    left join action_evidence as action on action.opportunity_id = scores.opportunity_id
    left join lateral (
      select evidence.publication_date, evidence.publication_instant,
        evidence.publication_state, evidence.source_name, evidence.publication_precision
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = scores.opportunity_id
        and opportunity.first_accepted_at is not null
        and opportunity.discovery_revision > scores.reviewed_discovery_revision
        and observation.field = 'date_added'
        and evidence.current_canonical_id = scores.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
      order by evidence.accepted_at desc, evidence.id limit 1
    ) as publication_latest on true
    left join lateral (
      select count(distinct coalesce(evidence.publication_date::text,
          evidence.publication_instant::text)) filter
          (where evidence.publication_state = 'valid') as publication_distinct_count,
        count(*) filter (where evidence.publication_state <> 'valid')
          as publication_unsupported_count
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = scores.opportunity_id
        and opportunity.first_accepted_at is not null
        and opportunity.discovery_revision > scores.reviewed_discovery_revision
        and observation.field = 'date_added'
        and evidence.current_canonical_id = scores.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
    ) as publication_stats on true
    where scores.current_triage_eligible = true and scores.should_remove = false
      and disposition.deal_key is null
      and (coalesce(p_search, '') = '' or lower(coalesce(scores.name, '')) like
        '%' || lower(p_search) || '%' or lower(coalesce(scores.deal_key, '')) like
        '%' || lower(p_search) || '%')
      and (coalesce(p_confidence, '') = '' or scores.confidence = p_confidence)
      and (coalesce(p_priority, '') = '' or scores.operator_priority = p_priority)
      and (coalesce(p_state, '') = '' or upper(coalesce(scores.state, '')) = upper(p_state))
  ), classified as materialized (
    select base.*,
      (base.discovery_state = 'known_prospective'
        or (base.discovery_state = 'known_recovered' and base.reviewed_at is null))
        and base.first_accepted_at is not null
        and base.discovery_revision > base.reviewed_discovery_revision
        and parameters.business_date - (base.first_accepted_at at time zone 'America/Los_Angeles')::date
          between 0 and 7 as new_to_ug,
      base.publication_state = 'valid' and base.publication_distinct_count = 1
        and base.publication_unsupported_count = 0
        and parameters.business_date - coalesce(base.publication_date,
          (base.publication_instant at time zone 'America/Los_Angeles')::date)
          between 0 and 30 as recently_listed,
      base.material_revision > base.reviewed_material_revision
        and base.last_material_change_at is not null as updated_since_review,
      base.due_at is not null as due_action,
      base.operator_priority in ('urgent', 'high') as owner_priority
    from base cross join parameters
  ), eligible as materialized (
    select classified.*,
      case when new_to_ug and fit_score >= 75 and confidence <> 'low'
        and discovery_revision > reviewed_discovery_revision then
          case when recently_listed then 1 else 2 end else 6 end as discovery_group
    from classified
  ), ordered as materialized (
    select eligible.*,
      row_number() over (order by due_at asc nulls last, opportunity_id) as due_ordinal,
      row_number() over (order by case operator_priority when 'urgent' then 0
        when 'high' then 1 else 2 end, fit_score desc, opportunity_id) as priority_ordinal
    from eligible
  ), preview_candidates as (
    select ordered.*,
      min(priority_ordinal) filter (where owner_priority
        and (not due_action or due_ordinal > 2)) over () as first_remaining_priority
    from ordered
  ), memberships as (
    select 'due-actions'::text as area_id, ordered.*, null::bigint as first_remaining_priority
      from ordered where p_area = 'due-actions' and due_action
    union all select 'owner-priorities', ordered.*, null::bigint from ordered
      where p_area = 'owner-priorities' and owner_priority
    union all select 'new-important', ordered.*, null::bigint from ordered
      where p_area in ('inbox', 'new-important') and discovery_group <= 2
    union all select 'updated', ordered.*, null::bigint from ordered
      where p_area = 'updated' and updated_since_review
    union all select 'research', ordered.*, null::bigint from ordered
      where p_area = 'research'
        and (confidence = 'low' or contradiction_count > 0 or source_conflict_count > 0)
    union all select 'all-active', ordered.*, null::bigint from ordered
      where p_area = 'all-active'
    union all select 'action-preview', preview_candidates.* from preview_candidates
      where p_area in ('inbox', 'action-preview') and (due_action or owner_priority)
  ), numbered as (
    select memberships.*,
      row_number() over (partition by area_id order by
        case when area_id = 'all-active' and p_sort = 'newest-discovery'
          then first_accepted_at end desc nulls last,
        case when area_id = 'all-active' and p_sort = 'highest-fit' then fit_score end desc,
        case when area_id = 'new-important' then discovery_group end,
        case when area_id = 'new-important' and p_area <> 'inbox'
          and p_sort = 'newest-discovery' then first_accepted_at end desc nulls last,
        case when area_id = 'new-important' and p_area <> 'inbox'
          and p_sort = 'highest-fit' then fit_score end desc,
        case when area_id in ('all-active', 'new-important') and p_area <> 'inbox'
          and p_sort in ('newest-discovery', 'highest-fit') then opportunity_id end,
        case when area_id = 'action-preview' then
          case when due_action and due_ordinal <= 2 then 0
            when owner_priority and priority_ordinal = first_remaining_priority then 1
            when due_action then 2 else 3 end end,
        case when area_id in ('action-preview', 'due-actions') then due_at end asc nulls last,
        case when area_id = 'due-actions' then opportunity_id end,
        case when area_id = 'action-preview' and due_action and due_ordinal <= 2
          then due_ordinal end,
        case when area_id = 'action-preview' and owner_priority
          and priority_ordinal = first_remaining_priority then priority_ordinal end,
        case when area_id in ('action-preview', 'owner-priorities', 'new-important') then
          case operator_priority when 'urgent' then 0 when 'high' then 1 else 2 end end,
        case when area_id = 'new-important' then due_at end asc nulls last,
        case when area_id = 'new-important' then fit_score end desc,
        case when area_id = 'new-important' then
          case confidence when 'high' then 0 when 'medium' then 1 else 2 end end,
        case when area_id in ('new-important', 'research', 'all-active')
          then first_accepted_at end desc nulls last,
        case when area_id = 'updated' then last_material_change_at end desc nulls last,
        fit_score desc, opportunity_id
      ) as ordinal
    from memberships
  ), selected as materialized (
    select * from numbered where (p_area = 'inbox' and area_id in
      ('action-preview', 'new-important')) or area_id = p_area
  ), totals as (
    select area_id, count(*)::integer as total,
      public.deal_hunter_fresh_inbox_hash_v1(
        opportunity_id || ':' || discovery_group || ':' || fit_score || ':' || confidence
        || ':' || operator_priority || ':' || coalesce(due_at::text, '')
        || ':' || coalesce(action_reason, '')
        || ':' || coalesce(first_accepted_at::text, '') || ':' || discovery_revision
        || ':' || material_revision || ':' || reviewed_discovery_revision
        || ':' || reviewed_material_revision || ':' || score_fingerprint
        || ':' || coalesce(semantic_digest, '') || ':' || coalesce(publication_state, '')
        || ':' || coalesce(publication_date::text, '')
        || ':' || source_conflict_count || ':' || coalesce(material_field, '')
        || ':' || coalesce(source_snapshot_updated_at::text, '')
        order by ordinal) as revision
    from selected where area_id <> 'action-preview' or ordinal <= 3
    group by area_id
  ), pages as (
    select area_id, jsonb_agg((to_jsonb(display_score) - 'operator_note')
      || (to_jsonb(numbered) - 'ordinal' - 'area_id'
        - 'due_ordinal' - 'priority_ordinal' - 'first_remaining_priority')
      || jsonb_build_object(
        'primary_submission_id', display_opp.primary_submission_id,
        'publication_date', display_publication.publication_date,
        'publication_instant', display_publication.publication_instant,
        'publication_state', display_publication.publication_state,
        'publication_source', display_publication.source_name,
        'publication_precision', display_publication.publication_precision,
        'publication_distinct_count', display_publication_stats.distinct_count,
        'publication_unsupported_count', display_publication_stats.unsupported_count,
        'recently_listed', display_publication.publication_state = 'valid'
          and display_publication_stats.distinct_count = 1
          and display_publication_stats.unsupported_count = 0
          and parameters.business_date - coalesce(display_publication.publication_date,
            (display_publication.publication_instant at time zone 'America/Los_Angeles')::date)
            between 0 and 30,
        'top_strength', display_score.summary->'strengths'->>0,
        'top_concern', display_score.summary->'concerns'->>0,
        'crm_status', coalesce((select submission.status
          from public.contact_submissions as submission
          where submission.id = display_opp.primary_submission_id), 'not-started'),
        'cim_status', coalesce((select cim.status
          from public.deal_hunter_cim_requests as cim
          where cim.opportunity_id = numbered.opportunity_id
          order by cim.updated_at desc, cim.id desc limit 1), 'not-requested'),
        'industry', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'industry'
          order by source.observed_at desc, source.id limit 1),
        'location', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'location'
          order by source.observed_at desc, source.id limit 1),
        'annual_profit', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'annual_profit'
          order by source.observed_at desc, source.id limit 1),
        'annual_profit_evidence', (select pg_catalog.jsonb_build_object(
            'metric', evidence.metric, 'period', evidence.period, 'currency', evidence.currency)
          from public.deal_hunter_opportunity_source_observations as source
          join public.deal_hunter_freshness_evidence as core on core.id = source.accepted_evidence_id
          join public.deal_hunter_freshness_evidence as evidence on evidence.run_id = core.run_id
            and evidence.source_id = core.source_id and evidence.source_record_id = core.source_record_id
            and evidence.event_type = 'accepted_source_record' and evidence.field_key = 'annual_profit'
            and evidence.current_canonical_id = numbered.opportunity_id
          where source.id = (select chosen.id from public.deal_hunter_opportunity_source_observations as chosen
            where chosen.opportunity_id = numbered.opportunity_id and chosen.field = 'annual_profit'
            order by chosen.observed_at desc, chosen.id limit 1)
            and source.value = evidence.after_value::text
          limit 1),
        'annual_revenue', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'annual_revenue'
          order by source.observed_at desc, source.id limit 1),
        'asking_price', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'asking_price'
          order by source.observed_at desc, source.id limit 1),
        'profit_multiple', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'profit_multiple'
          order by source.observed_at desc, source.id limit 1),
        'observation_freshness', coalesce((select max(source.observed_at)
          from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id), display_score.scored_at),
        'latest_accepted_observation_at', (select max(source.accepted_at)
          from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id),
        'material_field', (select event.field_key from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'material_before_value', (select event.before_value from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'material_after_value', (select event.after_value from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'material_currency', (select event.currency from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'source_conflict_count', (select count(*) from (select source.field
          from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id
            and source.field in ('annual_profit', 'annual_revenue', 'asking_price')
          group by source.field having count(distinct source.value) > 1) as conflict_fields)
      )
      order by ordinal) as rows,
      max(ordinal)::integer as last_ordinal,
      (array_agg(numbered.opportunity_id order by ordinal desc))[1] as last_id
    from numbered
    join public.deal_hunter_opportunity_scores as display_score
      on display_score.opportunity_id = numbered.opportunity_id
    join public.deal_hunter_opportunities as display_opp
      on display_opp.opportunity_id = numbered.opportunity_id
    left join lateral (
      select evidence.publication_date, evidence.publication_instant,
        evidence.publication_state, evidence.source_name, evidence.publication_precision
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = numbered.opportunity_id
        and observation.field = 'date_added'
        and evidence.current_canonical_id = numbered.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
      order by evidence.accepted_at desc, evidence.id limit 1
    ) as display_publication on true
    left join lateral (
      select count(distinct coalesce(evidence.publication_date::text,
          evidence.publication_instant::text)) filter
          (where evidence.publication_state = 'valid') as distinct_count,
        count(*) filter (where evidence.publication_state <> 'valid') as unsupported_count
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = numbered.opportunity_id
        and observation.field = 'date_added'
        and evidence.current_canonical_id = numbered.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
    ) as display_publication_stats on true
    cross join parameters
    where ((p_area = 'inbox' and area_id in ('action-preview', 'new-important'))
      or area_id = p_area)
      and ordinal > case when p_area = 'inbox' then 0 else parameters.page_offset end
      and ordinal <= case when area_id = 'action-preview' then 3
        when p_area = 'inbox' then 10
        else parameters.page_offset + parameters.page_limit end
    group by area_id
  ), requested as (
    select id from (values ('action-preview'), ('new-important'), ('due-actions'),
      ('owner-priorities'), ('updated'), ('research'), ('all-active')) as ids(id)
    where (p_area = 'inbox' and id in ('action-preview', 'new-important')) or id = p_area
  )
  select jsonb_build_object('asOf', p_as_of, 'businessDate', parameters.business_date,
    'areas', coalesce((select jsonb_agg(jsonb_build_object(
      'id', requested.id, 'rows', coalesce(pages.rows, '[]'::jsonb),
      'total', coalesce(totals.total, 0),
      'revision', coalesce(totals.revision, md5('')),
      'anchorId', (select anchor.opportunity_id from selected as anchor
        where anchor.area_id = requested.id and anchor.ordinal = parameters.page_offset),
      'nextOffset', case when pages.last_ordinal < totals.total then pages.last_ordinal else null end,
      'lastId', case when pages.last_ordinal < totals.total then pages.last_id else null end,
      'counts', case when requested.id = 'action-preview' then jsonb_build_object(
        'due', (select count(*) from ordered where due_action),
        'overdue', (select count(*) from ordered where due_action and action_reason = 'due_follow_up'
          and (due_at at time zone 'America/Los_Angeles')::date < parameters.business_date),
        'ownerPriority', (select count(*) from ordered where owner_priority),
        'urgent', (select count(*) from ordered where operator_priority = 'urgent'))
        else '{}'::jsonb end
    ) order by case requested.id when 'action-preview' then 0 else 1 end)
      from requested left join totals on totals.area_id = requested.id
      left join pages on pages.area_id = requested.id), '[]'::jsonb),
    'counts', jsonb_build_object(
      'due', (select count(*) from ordered where due_action),
      'ownerPriority', (select count(*) from ordered where owner_priority),
      'newImportant', (select count(*) from ordered where discovery_group <= 2)))
  from parameters;
$$;
revoke all on function public.list_deal_hunter_fresh_inbox_v1(
  text, integer, integer, text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.list_deal_hunter_fresh_inbox_v1(
  text, integer, integer, text, text, text, text, timestamptz, text) to service_role;

-- Keep legacy per-record daily writers from retaining acceptance on changed values.
create or replace function public.upsert_deal_hunter_opportunity_source_observation(
  p_id text, p_opportunity_id text, p_source_id text, p_source_name text, p_source_record_id text,
  p_field text, p_value text, p_observed_at timestamptz, p_created_at timestamptz, p_updated_at timestamptz
)
returns public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_observation public.deal_hunter_opportunity_source_observations;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_source_id)::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_opportunity_id, p_source_id)::text,
      0
    )
  );
  insert into public.deal_hunter_opportunity_source_observations (
    id, opportunity_id, source_id, source_name, source_record_id, field, value,
    observed_at, created_at, updated_at
  ) values (
    p_id, p_opportunity_id, p_source_id, p_source_name, p_source_record_id, p_field, p_value,
    p_observed_at, p_created_at, p_updated_at
  )
  on conflict (opportunity_id, source_id, source_record_id, field) do update set
    source_name = excluded.source_name, value = excluded.value, observed_at = excluded.observed_at,
    updated_at = excluded.updated_at,
    accepted_at = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_at end,
    accepted_run_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_run_id end,
    accepted_evidence_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_evidence_id end,
    publication_raw_header = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_header end,
    publication_raw_value = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_value end,
    publication_precision = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_precision end,
    publication_offset = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_offset end,
    publication_meaning = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_meaning end
  returning * into v_observation;
  return v_observation;
end;
$$;

create or replace function public.replace_deal_hunter_opportunity_source_observation_snapshot(
  p_opportunity_id text,
  p_source_id text,
  p_source_name text,
  p_source_record_id text,
  p_observations jsonb
)
returns setof public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_observations) <> 'array' then
    raise exception 'source observation snapshot must be a JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_observations) as incoming(
      id text, opportunity_id text, source_id text, source_name text, source_record_id text,
      field text, value text, observed_at timestamptz, created_at timestamptz, updated_at timestamptz
    )
    where incoming.opportunity_id is distinct from p_opportunity_id
      or incoming.source_id is distinct from p_source_id
      or incoming.source_name is distinct from p_source_name
      or incoming.source_record_id is distinct from p_source_record_id
  ) then
    raise exception 'source observation snapshot rows must share one source record identity';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_source_id)::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_opportunity_id, p_source_id)::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_opportunity_id, p_source_id, p_source_record_id)::text,
      0
    )
  );

  delete from public.deal_hunter_opportunity_source_observations as stored
  where stored.opportunity_id = p_opportunity_id
    and stored.source_id = p_source_id
    and stored.source_record_id = p_source_record_id
    and not exists (
      select 1
      from jsonb_to_recordset(p_observations) as incoming(field text)
      where incoming.field = stored.field
    );

  insert into public.deal_hunter_opportunity_source_observations (
    id, opportunity_id, source_id, source_name, source_record_id, field, value,
    observed_at, created_at, updated_at
  )
  select
    incoming.id, incoming.opportunity_id, incoming.source_id, incoming.source_name, incoming.source_record_id,
    incoming.field, incoming.value, incoming.observed_at, incoming.created_at, incoming.updated_at
  from jsonb_to_recordset(p_observations) as incoming(
    id text, opportunity_id text, source_id text, source_name text, source_record_id text,
    field text, value text, observed_at timestamptz, created_at timestamptz, updated_at timestamptz
  )
  on conflict (opportunity_id, source_id, source_record_id, field) do update set
    source_name = excluded.source_name,
    value = excluded.value,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at,
    accepted_at = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_at end,
    accepted_run_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_run_id end,
    accepted_evidence_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_evidence_id end,
    publication_raw_header = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_header end,
    publication_raw_value = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_value end,
    publication_precision = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_precision end,
    publication_offset = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_offset end,
    publication_meaning = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_meaning end;

  return query
  select *
  from public.deal_hunter_opportunity_source_observations
  where opportunity_id = p_opportunity_id
    and source_id = p_source_id
    and source_record_id = p_source_record_id
  order by observed_at desc, id asc;
end;
$$;

-- Package 1C: versioned Pursue CIM transition RPCs.
-- CIM rows remain inert to the legacy sender: it only claims queued/retryable rows.
-- These states are required by the Package 1B prepared/provider-pending contract.
alter table public.crm_communications
  drop constraint if exists crm_communications_source_check;
alter table public.crm_communications
  add constraint crm_communications_source_check check (source in (
    'deal-hunter', 'resend-webhook', 'manual', 'secure-documents', 'system',
    'pursue-cim-autopilot'
  ));
alter table public.crm_communications
  drop constraint if exists crm_communications_delivery_state_check;
alter table public.crm_communications
  add constraint crm_communications_delivery_state_check check (delivery_state in (
    'not-attempted', 'provider-pending', 'accepted', 'ambiguous', 'delivered', 'delayed',
    'bounced', 'failed', 'complained', 'suppressed', 'development-only', 'replied'
  ));
alter table public.crm_email_outbox
  drop constraint if exists crm_email_outbox_state_check;
alter table public.crm_email_outbox
  add constraint crm_email_outbox_state_check check (state in (
    'queued', 'sending', 'prepared', 'final-gate-blocked', 'provider-pending',
    'accepted', 'ambiguous', 'failed', 'retryable_failed', 'permanent_failed', 'cancelled'
  ));

create or replace function public.pursue_cim_json_stringify_v1(p_value jsonb)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_type text;
  v_item jsonb;
  v_key text;
  v_parts text[] := array[]::text[];
begin
  v_type := pg_catalog.jsonb_typeof(p_value);
  if v_type = 'array' then
    for v_item in select value from pg_catalog.jsonb_array_elements(p_value) loop
      v_parts := pg_catalog.array_append(v_parts, public.pursue_cim_json_stringify_v1(v_item));
    end loop;
    return '[' || pg_catalog.array_to_string(v_parts, ',') || ']';
  elsif v_type = 'object' then
    for v_key in select key from pg_catalog.jsonb_object_keys(p_value) as key order by key loop
      v_parts := pg_catalog.array_append(v_parts,
        pg_catalog.to_jsonb(v_key)::text || ':' ||
        public.pursue_cim_json_stringify_v1(p_value -> v_key));
    end loop;
    return '{' || pg_catalog.array_to_string(v_parts, ',') || '}';
  end if;
  return p_value::text;
end;
$$;

create or replace function public.pursue_cim_digest_v1(variadic p_parts jsonb[])
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_part jsonb;
  v_serialized text;
  v_frames text[] := array[]::text[];
begin
  foreach v_part in array p_parts loop
    v_serialized := case when v_part is null then 'null'
      else public.pursue_cim_json_stringify_v1(v_part) end;
    v_frames := pg_catalog.array_append(v_frames,
      '[' || pg_catalog.octet_length(v_serialized)::text || ',' ||
      pg_catalog.to_jsonb(v_serialized)::text || ']');
  end loop;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    '[' || pg_catalog.array_to_string(v_frames, ',') || ']', 'UTF8')), 'hex');
end;
$$;

create or replace function public.pursue_cim_required_instant_v1(
  p_command jsonb, p_field text)
returns timestamptz
language plpgsql volatile
set search_path = ''
as $$
declare
  v_text text;
  v_instant timestamptz;
begin
  -- All mutating P1C RPCs validate an instant before taking row locks. This
  -- database-wide transaction lock mirrors SQLite's single-writer boundary and
  -- prevents inverse row-lock orders from deadlocking terminal/provider races.
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  if pg_catalog.jsonb_typeof(p_command -> p_field) <> 'string' then
    raise exception 'Invalid Pursue CIM instant: %', p_field;
  end if;
  v_text := p_command ->> p_field;
  if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    raise exception 'Invalid Pursue CIM instant: %', p_field;
  end if;
  begin
    v_instant := v_text::timestamptz;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'Invalid Pursue CIM instant: %', p_field;
  end;
  if not pg_catalog.isfinite(v_instant)
    or pg_catalog.abs(extract(epoch from v_instant)) > 8640000000000
  then
    raise exception 'Invalid Pursue CIM instant: %', p_field;
  end if;
  return v_instant;
end;
$$;

create or replace function public.pursue_cim_assert_types_v1(
  p_value jsonb, p_text text[], p_number text[],
  p_optional_text text[] default array[]::text[],
  p_optional_number text[] default array[]::text[])
returns void
language plpgsql immutable
set search_path = ''
as $$
declare
  v_key text;
begin
  if pg_catalog.jsonb_typeof(p_value) <> 'object' then
    raise exception 'Invalid Pursue CIM command object';
  end if;
  foreach v_key in array p_text loop
    if pg_catalog.jsonb_typeof(p_value -> v_key) <> 'string' then
      raise exception 'Invalid Pursue CIM text: %', v_key;
    end if;
  end loop;
  foreach v_key in array p_number loop
    if pg_catalog.jsonb_typeof(p_value -> v_key) <> 'number' then
      raise exception 'Invalid Pursue CIM number: %', v_key;
    end if;
  end loop;
  foreach v_key in array p_optional_text loop
    if p_value ? v_key
      and pg_catalog.jsonb_typeof(p_value -> v_key) not in ('string','null') then
      raise exception 'Invalid Pursue CIM text: %', v_key;
    end if;
  end loop;
  foreach v_key in array p_optional_number loop
    if p_value ? v_key
      and pg_catalog.jsonb_typeof(p_value -> v_key) not in ('number','null') then
      raise exception 'Invalid Pursue CIM number: %', v_key;
    end if;
  end loop;
end;
$$;

create or replace function public.pursue_cim_transition_enrollment_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := p_command ->> 'enrollmentId';
  v_next text := p_command ->> 'nextState';
  v_reason text := p_command ->> 'reasonCode';
  v_actor text := p_command ->> 'actor';
  v_now timestamptz;
  v_expected bigint;
  v_current public.deal_hunter_pursuit_enrollments%rowtype;
  v_prior_state text;
  v_legal boolean;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['enrollmentId','nextState','actor','now'], array['expectedRowVersion'],
    array['reasonCode','terminalAuthorityId']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_id is null or pg_catalog.length(v_id) < 1 or pg_catalog.length(v_id) > 240
    or pg_catalog.btrim(v_id) <> v_id
    or v_next is null or pg_catalog.length(v_next) < 1 or pg_catalog.length(v_next) > 40
    or pg_catalog.btrim(v_next) <> v_next
    or v_reason is not null and (pg_catalog.length(v_reason) < 1
      or pg_catalog.length(v_reason) > 160 or pg_catalog.btrim(v_reason) <> v_reason)
    or v_actor is null or pg_catalog.length(v_actor) < 1 or pg_catalog.length(v_actor) > 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or p_command ->> 'expectedRowVersion' !~ '^(0|[1-9][0-9]*)$'
    or (p_command ->> 'expectedRowVersion')::numeric > 9007199254740991
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM enrollment command';
  end if;
  v_expected := (p_command ->> 'expectedRowVersion')::bigint;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_current
    from public.deal_hunter_pursuit_enrollments
    where id = v_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'staleRevision', false,
      'conflict', true, 'enrollment', null);
  end if;
  if v_current.row_version <> v_expected then
    return pg_catalog.jsonb_build_object('applied', false, 'staleRevision', true,
      'conflict', false, 'enrollment', pg_catalog.to_jsonb(v_current));
  end if;
  v_legal := case v_current.state
    when 'queued' then v_next = any(array['waiting-on-eligibility','campaign-created','action-required','superseded'])
    when 'waiting-on-eligibility' then v_next = any(array['queued','campaign-created','action-required','superseded'])
    when 'campaign-created' then v_next = 'superseded'
    when 'action-required' then v_next = 'superseded'
    else false end;
  if not v_legal or (v_next = 'superseded' and
    (p_command ->> 'terminalAuthorityId' is null
      or pg_catalog.length(p_command ->> 'terminalAuthorityId') < 1
      or pg_catalog.length(p_command ->> 'terminalAuthorityId') > 240))
  then
    return pg_catalog.jsonb_build_object('applied', false, 'staleRevision', false,
      'conflict', true, 'enrollment', pg_catalog.to_jsonb(v_current));
  end if;
  v_prior_state := v_current.state;
  update public.deal_hunter_pursuit_enrollments
    set state = v_next, reason_code = v_reason, updated_at = v_now,
      row_version = row_version + 1
    where id = v_id and row_version = v_expected and state = v_current.state
    returning * into v_current;
  if not found then
    raise exception 'Concurrent Pursue CIM enrollment update';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, prior_state, next_state, reason_code,
     actor, source, occurred_at, metadata)
  values (
    public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('enrollment-transition'::text),
      pg_catalog.to_jsonb(v_id || ':' || (v_expected + 1)::text)),
    'enrollment-transition', v_current.opportunity_id,
    v_prior_state, v_next, v_reason, v_actor, 'sqlite-transition', v_now, '{}'::jsonb
  );
  return pg_catalog.jsonb_build_object('applied', true, 'staleRevision', false,
    'conflict', false, 'enrollment', pg_catalog.to_jsonb(v_current));
end;
$$;

revoke all on function public.pursue_cim_json_stringify_v1(jsonb)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_digest_v1(variadic jsonb[])
  from public, anon, authenticated;
revoke all on function public.pursue_cim_required_instant_v1(jsonb,text)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_assert_types_v1(jsonb,text[],text[],text[],text[])
  from public, anon, authenticated;
revoke all on function public.pursue_cim_transition_enrollment_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_json_stringify_v1(jsonb) to service_role;
grant execute on function public.pursue_cim_digest_v1(variadic jsonb[]) to service_role;
grant execute on function public.pursue_cim_required_instant_v1(jsonb,text) to service_role;
grant execute on function public.pursue_cim_assert_types_v1(jsonb,text[],text[],text[],text[])
  to service_role;
grant execute on function public.pursue_cim_transition_enrollment_v1(jsonb) to service_role;

create or replace function public.pursue_cim_append_timezone_revision_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_key text := p_command ->> 'idempotencyKey';
  v_state text := p_command ->> 'state';
  v_zone text := p_command ->> 'ianaTimezone';
  v_evidence_type text := p_command ->> 'evidenceType';
  v_evidence_id text := p_command ->> 'evidenceId';
  v_evidence_digest text := p_command ->> 'evidenceDigest';
  v_resolver text := p_command ->> 'resolverVersion';
  v_dataset_digest text := p_command ->> 'datasetDigest';
  v_actor text := p_command ->> 'actor';
  v_now timestamptz;
  v_expected bigint;
  v_current bigint;
  v_audit_id text;
  v_request_digest text;
  v_prior public.deal_hunter_cim_audit_events%rowtype;
  v_revision public.deal_hunter_opportunity_timezone_revisions%rowtype;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['opportunityId','idempotencyKey','state','evidenceType','evidenceId',
      'evidenceDigest','resolverVersion','datasetDigest','actor','now'],
    array['expectedPriorRevision'], array['ianaTimezone']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
    or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
    or v_key is null or pg_catalog.length(v_key) not between 1 and 240
    or pg_catalog.btrim(v_key) <> v_key
    or p_command ->> 'expectedPriorRevision' !~ '^(0|[1-9][0-9]*)$'
    or (p_command ->> 'expectedPriorRevision')::numeric > 9007199254740991
    or v_state not in ('verified','derived','missing','ambiguous')
    or v_evidence_type is null or pg_catalog.length(v_evidence_type) not between 1 and 120
    or pg_catalog.btrim(v_evidence_type) <> v_evidence_type
    or v_evidence_id is null or pg_catalog.length(v_evidence_id) not between 1 and 240
    or pg_catalog.btrim(v_evidence_id) <> v_evidence_id
    or v_evidence_digest !~ '^[0-9a-f]{64}$'
    or v_resolver is null or pg_catalog.length(v_resolver) not between 1 and 120
    or pg_catalog.btrim(v_resolver) <> v_resolver
    or v_dataset_digest !~ '^[0-9a-f]{64}$'
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM timezone revision command';
  end if;
  if v_state in ('verified','derived') then
    if v_zone is null or pg_catalog.length(v_zone) not between 1 and 120
      or not exists (select 1 from pg_catalog.pg_timezone_names where name = v_zone)
    then
      raise exception 'Invalid IANA timezone';
    end if;
  elsif v_zone is not null then
    raise exception 'Missing or ambiguous timezone cannot have an IANA timezone';
  end if;
  v_expected := (p_command ->> 'expectedPriorRevision')::bigint;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_request_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('timezone-request:v1'::text),
    pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_expected),
    pg_catalog.to_jsonb(v_state),
    coalesce(pg_catalog.to_jsonb(v_zone), 'null'::jsonb),
    pg_catalog.to_jsonb(v_evidence_type),
    pg_catalog.to_jsonb(v_evidence_id),
    pg_catalog.to_jsonb(v_evidence_digest),
    pg_catalog.to_jsonb(v_resolver),
    pg_catalog.to_jsonb(v_dataset_digest),
    pg_catalog.to_jsonb(v_key));
  v_audit_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-audit:v1'::text),
    pg_catalog.to_jsonb('timezone-revision'::text),
    pg_catalog.to_jsonb(v_key));
  perform 1 from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  if not found then
    raise exception 'Unknown Pursue CIM opportunity';
  end if;
  select * into v_prior from public.deal_hunter_cim_audit_events
    where id = v_audit_id;
  if found then
    select * into v_revision from public.deal_hunter_opportunity_timezone_revisions
      where opportunity_id = v_opportunity_id and revision = v_expected + 1;
    return pg_catalog.jsonb_build_object('applied', false,
      'replay', v_prior.authority_digest = v_request_digest,
      'staleRevision', v_prior.authority_digest <> v_request_digest,
      'timezoneRevision', case when found then pg_catalog.to_jsonb(v_revision) else null end);
  end if;
  select coalesce(pg_catalog.max(revision), 0) into v_current
    from public.deal_hunter_opportunity_timezone_revisions
    where opportunity_id = v_opportunity_id;
  if v_current <> v_expected then
    select * into v_revision from public.deal_hunter_opportunity_timezone_revisions
      where opportunity_id = v_opportunity_id and revision = v_current;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'staleRevision', true,
      'timezoneRevision', case when found then pg_catalog.to_jsonb(v_revision) else null end);
  end if;
  insert into public.deal_hunter_opportunity_timezone_revisions
    (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
     evidence_digest, resolver_version, dataset_digest, actor, created_at)
  values (v_opportunity_id, v_current + 1, v_state, v_zone, v_evidence_type, v_evidence_id,
    v_evidence_digest, v_resolver, v_dataset_digest, v_actor, v_now)
  returning * into v_revision;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, next_state, authority_digest,
     actor, source, occurred_at, metadata)
  values (v_audit_id, 'timezone-revision', v_opportunity_id, v_state,
    v_request_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'staleRevision', false, 'timezoneRevision', pg_catalog.to_jsonb(v_revision));
end;
$$;

revoke all on function public.pursue_cim_append_timezone_revision_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_timezone_revision_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_record_capability_activation_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := p_command ->> 'id';
  v_capability text := p_command ->> 'capability';
  v_mode text := p_command ->> 'mode';
  v_predecessor text;
  v_prerequisite_id text := p_command ->> 'prerequisiteActivationId';
  v_evidence_id text := p_command ->> 'prerequisiteEvidenceId';
  v_evidence_hash text := p_command ->> 'prerequisiteEvidenceHash';
  v_policy_hash text := p_command ->> 'policyHash';
  v_config_hash text := p_command ->> 'configHash';
  v_cohort_digest text := p_command ->> 'cohortDigest';
  v_permission_digest text := p_command ->> 'permissionBasisDigest';
  v_permission_revision bigint;
  v_actor text := p_command ->> 'actor';
  v_reason text := p_command ->> 'reason';
  v_confirmation text := p_command ->> 'confirmation';
  v_profile text := p_command ->> 'providerProfile';
  v_expires timestamptz;
  v_daily_cap integer;
  v_recipient_cap integer;
  v_now timestamptz;
  v_existing public.deal_hunter_cim_capability_activations%rowtype;
  v_prerequisite public.deal_hunter_cim_capability_activations%rowtype;
  v_current public.deal_hunter_cim_capability_activations%rowtype;
  v_replay boolean;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['id','capability','mode','policyHash','configHash','actor','reason',
      'confirmation','providerProfile','now'], array[]::text[],
    array['prerequisiteActivationId','prerequisiteEvidenceId','prerequisiteEvidenceHash',
      'cohortDigest','permissionBasisDigest','expiresAt'],
    array['permissionRevision','dailyCap','recipientCap']);
  v_predecessor := case v_capability
    when 'fl04a-safety' then null
    when 'fl04b-enrollment' then 'fl04a-safety'
    when 'fl04b-initial' then 'fl04b-enrollment'
    when 'fl04c-followup' then 'fl04b-initial'
    when 'fl04c-batch' then 'fl04c-followup'
    else 'invalid' end;
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_id is null or pg_catalog.length(v_id) not between 1 and 240
    or pg_catalog.btrim(v_id) <> v_id
    or v_predecessor = 'invalid'
    or v_mode not in ('off','shadow','mailbox','canary','active')
    or v_policy_hash !~ '^[0-9a-f]{64}$'
    or v_config_hash !~ '^[0-9a-f]{64}$'
    or (v_cohort_digest is not null and v_cohort_digest !~ '^[0-9a-f]{64}$')
    or (v_permission_digest is not null and v_permission_digest !~ '^[0-9a-f]{64}$')
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or v_reason is null or pg_catalog.length(v_reason) not between 1 and 1000
    or pg_catalog.btrim(v_reason) <> v_reason
    or v_confirmation is null or pg_catalog.length(v_confirmation) not between 1 and 240
    or pg_catalog.btrim(v_confirmation) <> v_confirmation
    or v_profile is null or pg_catalog.length(v_profile) not between 1 and 120
    or pg_catalog.btrim(v_profile) <> v_profile
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM capability activation command';
  end if;
  if v_predecessor is null then
    if v_prerequisite_id is not null or v_evidence_id is not null
      or v_evidence_hash is not null then
      raise exception 'Root activation cannot name a prerequisite';
    end if;
  elsif v_prerequisite_id is null or pg_catalog.length(v_prerequisite_id) not between 1 and 240
    or v_evidence_id is null or pg_catalog.length(v_evidence_id) not between 1 and 240
    or v_evidence_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Invalid Pursue CIM activation prerequisite';
  end if;
  if p_command ->> 'permissionRevision' is not null then
    if p_command ->> 'permissionRevision' !~ '^(0|[1-9][0-9]*)$'
      or (p_command ->> 'permissionRevision')::numeric > 9007199254740991 then
      raise exception 'Invalid permission revision';
    end if;
    v_permission_revision := (p_command ->> 'permissionRevision')::bigint;
  end if;
  if p_command ->> 'dailyCap' is not null then
    if p_command ->> 'dailyCap' !~ '^(0|[1-9][0-9]*)$'
      or (p_command ->> 'dailyCap')::numeric > 2147483647 then
      raise exception 'Invalid daily cap';
    end if;
    v_daily_cap := (p_command ->> 'dailyCap')::integer;
  end if;
  if p_command ->> 'recipientCap' is not null then
    if p_command ->> 'recipientCap' !~ '^(0|[1-9][0-9]*)$'
      or (p_command ->> 'recipientCap')::numeric > 2147483647 then
      raise exception 'Invalid recipient cap';
    end if;
    v_recipient_cap := (p_command ->> 'recipientCap')::integer;
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  if p_command ->> 'expiresAt' is not null then
    v_expires := public.pursue_cim_required_instant_v1(p_command, 'expiresAt');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:activation:' || v_capability, 0));
  select * into v_existing from public.deal_hunter_cim_capability_activations
    where id = v_id for update;
  if found then
    v_replay := v_existing.capability = v_capability
      and v_existing.mode = v_mode
      and v_existing.prerequisite_activation_id is not distinct from v_prerequisite_id
      and v_existing.prerequisite_evidence_id is not distinct from v_evidence_id
      and v_existing.prerequisite_evidence_hash is not distinct from v_evidence_hash
      and v_existing.policy_hash = v_policy_hash and v_existing.config_hash = v_config_hash
      and v_existing.cohort_digest is not distinct from v_cohort_digest
      and v_existing.permission_basis_digest is not distinct from v_permission_digest
      and v_existing.permission_revision is not distinct from v_permission_revision
      and v_existing.actor = v_actor and v_existing.reason = v_reason
      and v_existing.confirmation = v_confirmation
      and v_existing.expires_at is not distinct from v_expires
      and v_existing.daily_cap is not distinct from v_daily_cap
      and v_existing.recipient_cap is not distinct from v_recipient_cap
      and v_existing.provider_profile = v_profile and v_existing.created_at = v_now;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', v_replay,
      'conflict', not v_replay, 'blockedReason', null,
      'activation', pg_catalog.to_jsonb(v_existing));
  end if;
  if v_predecessor is not null then
    select * into v_prerequisite from public.deal_hunter_cim_capability_activations
      where id = v_prerequisite_id for update;
    if not found or v_prerequisite.capability <> v_predecessor
      or v_prerequisite.status <> 'current' or v_prerequisite.mode = 'off'
      or (v_prerequisite.expires_at is not null and v_prerequisite.expires_at <= v_now)
    then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', false, 'blockedReason', 'prerequisite_missing', 'activation', null);
    end if;
  end if;
  select * into v_current from public.deal_hunter_cim_capability_activations
    where capability = v_capability and status = 'current' for update;
  if found then
    update public.deal_hunter_cim_capability_activations
      set status = 'superseded', superseded_at = v_now, updated_at = v_now
      where id = v_current.id and status = 'current';
  end if;
  insert into public.deal_hunter_cim_capability_activations
    (id, capability, mode, status, prerequisite_activation_id,
     prerequisite_evidence_id, prerequisite_evidence_hash, policy_hash, config_hash,
     cohort_digest, permission_basis_digest, permission_revision, actor, reason,
     confirmation, expires_at, daily_cap, recipient_cap, provider_profile, created_at, updated_at)
  values (v_id, v_capability, v_mode, 'current', v_prerequisite_id,
    v_evidence_id, v_evidence_hash, v_policy_hash, v_config_hash,
    v_cohort_digest, v_permission_digest, v_permission_revision, v_actor, v_reason,
    v_confirmation, v_expires, v_daily_cap, v_recipient_cap, v_profile, v_now, v_now)
  returning * into v_existing;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, activation_id, prior_state, next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('capability-activation'::text),
      pg_catalog.to_jsonb(v_id)),
    'capability-activation', v_id, v_current.status, 'current',
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'blockedReason', null,
    'activation', pg_catalog.to_jsonb(v_existing));
end;
$$;

create or replace function public.pursue_cim_withdraw_capability_activation_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := p_command ->> 'id';
  v_actor text := p_command ->> 'actor';
  v_reason text := p_command ->> 'reason';
  v_now timestamptz;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['id','actor','reason','now'], array[]::text[]);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_id is null or pg_catalog.length(v_id) not between 1 and 240
    or pg_catalog.btrim(v_id) <> v_id
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or v_reason is null or pg_catalog.length(v_reason) not between 1 and 160
    or pg_catalog.btrim(v_reason) <> v_reason
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM activation withdrawal command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where id = v_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'activation', null);
  end if;
  if v_activation.status = 'withdrawn' then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', true,
      'conflict', false, 'activation', pg_catalog.to_jsonb(v_activation));
  end if;
  if v_activation.status <> 'current' then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'activation', pg_catalog.to_jsonb(v_activation));
  end if;
  update public.deal_hunter_cim_capability_activations
    set status = 'withdrawn', withdrawn_at = v_now, updated_at = v_now
    where id = v_id and status = 'current'
    returning * into v_activation;
  if not found then
    raise exception 'Concurrent Pursue CIM activation withdrawal';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, activation_id, prior_state, next_state, reason_code,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('capability-withdrawn'::text),
      pg_catalog.to_jsonb(v_id)),
    'capability-withdrawn', v_id, 'current', 'withdrawn', v_reason,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'activation', pg_catalog.to_jsonb(v_activation));
end;
$$;

revoke all on function public.pursue_cim_record_capability_activation_v1(jsonb)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_withdraw_capability_activation_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_record_capability_activation_v1(jsonb) to service_role;
grant execute on function public.pursue_cim_withdraw_capability_activation_v1(jsonb) to service_role;

create or replace function public.pursue_cim_current_activation_v1(
  p_capability text, p_now timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_predecessor text;
  v_parent_id text;
begin
  v_predecessor := case p_capability
    when 'fl04a-safety' then null
    when 'fl04b-enrollment' then 'fl04a-safety'
    when 'fl04b-initial' then 'fl04b-enrollment'
    when 'fl04c-followup' then 'fl04b-initial'
    when 'fl04c-batch' then 'fl04c-followup'
    else 'invalid' end;
  if v_predecessor = 'invalid' then
    return null;
  end if;
  if v_predecessor is not null then
    v_parent_id := public.pursue_cim_current_activation_v1(v_predecessor, p_now);
  end if;
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where capability = p_capability and status = 'current' for share;
  if not found or v_activation.mode in ('off','shadow')
    or (v_activation.expires_at is not null and v_activation.expires_at <= p_now)
  then
    return null;
  end if;
  if v_predecessor is null then
    return v_activation.id;
  end if;
  if v_parent_id = v_activation.prerequisite_activation_id
    and v_activation.prerequisite_evidence_id is not null
    and v_activation.prerequisite_evidence_hash is not null
  then
    return v_activation.id;
  end if;
  return null;
end;
$$;

create or replace function public.pursue_cim_claim_due_touch_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touch_id text := p_command ->> 'touchId';
  v_claim_digest text := p_command ->> 'claimTokenDigest';
  v_owner text := p_command ->> 'claimOwner';
  v_now timestamptz;
  v_expires timestamptz;
  v_expected bigint;
  v_campaign_terminal bigint;
  v_conversation_terminal bigint;
  v_campaign_id text;
  v_conversation_id text;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_capability text;
  v_prior_state text;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['touchId','claimTokenDigest','claimOwner','claimExpiresAt','now'],
    array['expectedRowVersion','expectedCampaignTerminalRevision',
      'expectedConversationTerminalRevision']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_touch_id is null or pg_catalog.length(v_touch_id) not between 1 and 240
    or pg_catalog.btrim(v_touch_id) <> v_touch_id
    or v_claim_digest !~ '^[0-9a-f]{64}$'
    or v_owner is null or pg_catalog.length(v_owner) not between 1 and 200
    or pg_catalog.btrim(v_owner) <> v_owner
    or p_command ->> 'expectedRowVersion' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'expectedCampaignTerminalRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'expectedConversationTerminalRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'now' is null or p_command ->> 'claimExpiresAt' is null
  then
    raise exception 'Invalid Pursue CIM touch claim command';
  end if;
  v_expected := (p_command ->> 'expectedRowVersion')::bigint;
  v_campaign_terminal := (p_command ->> 'expectedCampaignTerminalRevision')::bigint;
  v_conversation_terminal := (p_command ->> 'expectedConversationTerminalRevision')::bigint;
  if v_expected > 9007199254740991 or v_campaign_terminal > 9007199254740991
    or v_conversation_terminal > 9007199254740991 then
    raise exception 'Unsafe Pursue CIM revision';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_expires := public.pursue_cim_required_instant_v1(p_command, 'claimExpiresAt');
  select campaign_id into v_campaign_id from public.deal_hunter_cim_campaign_touches
    where id = v_touch_id;
  if not found then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true, 'touch', null);
  end if;
  select conversation_id into v_conversation_id from public.deal_hunter_cim_campaigns
    where id = v_campaign_id;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_conversation_id for update;
  select * into v_campaign from public.deal_hunter_cim_campaigns
    where id = v_campaign_id for update;
  select * into v_touch from public.deal_hunter_cim_campaign_touches
    where id = v_touch_id for update;
  if v_campaign.terminal_revision <> v_campaign_terminal
    or v_conversation.terminal_revision <> v_conversation_terminal
    or v_touch.timezone_revision <> v_campaign.timezone_revision
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', true, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_campaign.state not in ('initial-pending','active-follow-up')
    or v_conversation.state <> 'open'
    or (v_campaign.local_expiry_at is not null and v_campaign.local_expiry_at <= v_now)
    or v_touch.state in ('provider-pending','accepted','definitive-failure',
      'ambiguous','cancelled-before-provider')
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', true, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  v_capability := case when v_touch.kind = 'initial' then 'fl04b-initial'
    else 'fl04c-followup' end;
  if public.pursue_cim_current_activation_v1(v_capability, v_now) is null then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', true, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.state = 'claimed' and v_touch.claim_token_digest = v_claim_digest
    and v_touch.claim_owner = v_owner
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', true,
      'staleAuthority', false, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.state = 'claimed'
    and (v_touch.claim_expires_at is null or v_touch.claim_expires_at > v_now)
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.row_version <> v_expected then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', true, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.due_at > v_now or v_expires <= v_now or v_touch.transmission_id is not null then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  v_prior_state := v_touch.state;
  update public.deal_hunter_cim_campaign_touches
    set state = 'claimed', claim_token_digest = v_claim_digest, claim_owner = v_owner,
      claimed_at = v_now, claim_expires_at = v_expires, updated_at = v_now,
      row_version = row_version + 1
    where id = v_touch_id and row_version = v_expected and state in ('scheduled','claimed')
    returning * into v_touch;
  if not found then
    raise exception 'Concurrent Pursue CIM touch claim';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
     prior_state, next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('touch-claimed'::text),
      pg_catalog.to_jsonb(v_touch_id || ':' || (v_expected + 1)::text)),
    'touch-claimed', v_touch.opportunity_id, v_campaign.id, v_conversation.id,
    v_touch_id, v_prior_state,
    'claimed', v_owner, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('claimed', true, 'alreadyOwned', false,
    'staleAuthority', false, 'terminal', false, 'conflict', false,
    'touch', pg_catalog.to_jsonb(v_touch));
end;
$$;

revoke all on function public.pursue_cim_current_activation_v1(text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_claim_due_touch_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_current_activation_v1(text, timestamptz)
  to service_role;
grant execute on function public.pursue_cim_claim_due_touch_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_read_projection_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_count bigint;
  v_accepted bigint;
  v_ambiguous bigint;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['opportunityId'], array[]::text[]);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
    or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
  then
    raise exception 'Invalid Pursue CIM projection command';
  end if;
  select * into v_decision from public.deal_hunter_owner_decision_events
    where opportunity_id = v_opportunity_id order by created_at desc, id desc limit 1;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where opportunity_id = v_opportunity_id and state <> 'superseded'
    order by created_at desc, id desc limit 1;
  select * into v_campaign from public.deal_hunter_cim_campaigns
    where opportunity_id = v_opportunity_id order by generation desc limit 1;
  if v_campaign.id is not null then
    select * into v_touch from public.deal_hunter_cim_campaign_touches
      where campaign_id = v_campaign.id and logical_slot = 'initial';
    select tr.* into v_transmission from public.deal_hunter_cim_transmissions as tr
      join public.deal_hunter_cim_transmission_touches as m on m.transmission_id = tr.id
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      where t.campaign_id = v_campaign.id
      order by tr.created_at desc, tr.id desc limit 1;
  end if;
  select pg_catalog.count(*),
    pg_catalog.count(*) filter (where delivery_state = 'accepted'),
    pg_catalog.count(*) filter (where delivery_state = 'ambiguous')
    into v_count, v_accepted, v_ambiguous
    from public.deal_hunter_cim_requests where opportunity_id = v_opportunity_id;
  return pg_catalog.jsonb_build_object(
    'decision', case when v_decision.id is null then null else pg_catalog.to_jsonb(v_decision) end,
    'enrollment', case when v_enrollment.id is null then null else pg_catalog.to_jsonb(v_enrollment) end,
    'campaign', case when v_campaign.id is null then null else pg_catalog.to_jsonb(v_campaign) end,
    'initialTouch', case when v_touch.id is null then null else pg_catalog.to_jsonb(v_touch) end,
    'transmission', case when v_transmission.id is null then null else pg_catalog.to_jsonb(v_transmission) end,
    'legacySummary', pg_catalog.jsonb_build_object(
      'count', v_count, 'accepted', v_accepted, 'ambiguous', v_ambiguous),
    'actions', '[]'::jsonb);
end;
$$;

revoke all on function public.pursue_cim_read_projection_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_read_projection_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_append_safety_events_v1(p_run jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id text := p_run ->> 'safetyRunId';
  v_source_type text := p_run ->> 'sourceType';
  v_source_run_id text := p_run ->> 'sourceRunId';
  v_now timestamptz;
  v_events jsonb := p_run -> 'events';
  v_event jsonb;
  v_opportunity_id text;
  v_event_type text;
  v_evidence_id text;
  v_canonical bigint;
  v_exception bigint;
  v_id text;
  v_prior public.deal_hunter_cim_safety_events%rowtype;
  v_emitted integer := 0;
  v_existing integer := 0;
begin
  perform public.pursue_cim_assert_types_v1(p_run,
    array['safetyRunId','sourceType','sourceRunId','now'], array[]::text[]);
  if p_run is null or pg_catalog.jsonb_typeof(p_run) <> 'object'
    or v_run_id is null or pg_catalog.length(v_run_id) not between 1 and 240
    or pg_catalog.btrim(v_run_id) <> v_run_id
    or v_source_type is null or pg_catalog.length(v_source_type) not between 1 and 120
    or pg_catalog.btrim(v_source_type) <> v_source_type
    or v_source_run_id is null or pg_catalog.length(v_source_run_id) not between 1 and 240
    or pg_catalog.btrim(v_source_run_id) <> v_source_run_id
    or p_run ->> 'now' is null
    or pg_catalog.jsonb_typeof(v_events) <> 'array'
    or pg_catalog.jsonb_array_length(v_events) > 10000
  then
    raise exception 'Invalid Pursue CIM safety event run';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_run, 'now');
  for v_event in select value from pg_catalog.jsonb_array_elements(v_events) loop
    perform public.pursue_cim_assert_types_v1(v_event,
      array['opportunityId','eventType','evidenceId'],
      array['canonicalRevision','identityExceptionRevision']);
    v_opportunity_id := v_event ->> 'opportunityId';
    v_event_type := v_event ->> 'eventType';
    v_evidence_id := v_event ->> 'evidenceId';
    if pg_catalog.jsonb_typeof(v_event) <> 'object'
      or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
      or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
      or v_event_type is null or pg_catalog.length(v_event_type) not between 1 and 160
      or pg_catalog.btrim(v_event_type) <> v_event_type
      or v_evidence_id is null or pg_catalog.length(v_evidence_id) not between 1 and 240
      or pg_catalog.btrim(v_evidence_id) <> v_evidence_id
      or v_event ->> 'canonicalRevision' !~ '^(0|[1-9][0-9]*)$'
      or v_event ->> 'identityExceptionRevision' !~ '^(0|[1-9][0-9]*)$'
    then
      raise exception 'Invalid Pursue CIM safety event';
    end if;
    v_canonical := (v_event ->> 'canonicalRevision')::bigint;
    v_exception := (v_event ->> 'identityExceptionRevision')::bigint;
    if v_canonical > 9007199254740991 or v_exception > 9007199254740991 then
      raise exception 'Unsafe Pursue CIM safety revision';
    end if;
    v_id := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-safety:v1'::text), pg_catalog.to_jsonb(v_run_id),
      pg_catalog.to_jsonb(v_opportunity_id), pg_catalog.to_jsonb(v_event_type),
      pg_catalog.to_jsonb(v_evidence_id));
    perform 1 from public.deal_hunter_opportunities
      where opportunity_id = v_opportunity_id for update;
    select * into v_prior from public.deal_hunter_cim_safety_events
      where id = v_id for update;
    if found then
      if v_prior.source_type <> v_source_type or v_prior.source_run_id <> v_source_run_id
        or v_prior.canonical_revision <> v_canonical
        or v_prior.identity_exception_revision <> v_exception
      then
        return pg_catalog.jsonb_build_object('emitted', 0, 'existing', v_existing,
          'conflict', true);
      end if;
      v_existing := v_existing + 1;
      continue;
    end if;
    insert into public.deal_hunter_cim_safety_events
      (id, safety_run_id, opportunity_id, source_type, source_run_id,
       canonical_revision, identity_exception_revision, event_type, evidence_id,
       status, created_at, updated_at)
    values (v_id, v_run_id, v_opportunity_id, v_source_type, v_source_run_id,
      v_canonical, v_exception, v_event_type, v_evidence_id, 'pending', v_now, v_now);
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, next_state, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('safety-emitted'::text), pg_catalog.to_jsonb(v_id)),
      'safety-emitted', v_opportunity_id, 'pending', v_source_type, v_source_run_id,
      v_now, '{}'::jsonb);
    v_emitted := v_emitted + 1;
  end loop;
  return pg_catalog.jsonb_build_object('emitted', v_emitted,
    'existing', v_existing, 'conflict', false);
end;
$$;

revoke all on function public.pursue_cim_append_safety_events_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_safety_events_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_record_owner_decision_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_action text := p_command ->> 'action';
  v_key text := p_command ->> 'idempotencyKey';
  v_actor text := p_command ->> 'actor';
  v_policy text := p_command ->> 'policyVersion';
  v_contact_digest text := p_command ->> 'selectedContactReferenceDigest';
  v_reason text := p_command ->> 'reason';
  v_note text := coalesce(p_command ->> 'note', '');
  v_submission_id text := coalesce(p_command ->> 'submissionId', '');
  v_now timestamptz;
  v_discovery bigint;
  v_material bigint;
  v_request_digest text;
  v_decision_id text;
  v_enrollment_id text;
  v_existing public.deal_hunter_owner_decision_events%rowtype;
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_terminal_id text;
  v_disposition_hash text;
  v_disposition_id uuid;
  v_archive_id uuid;
  v_triage_id uuid;
  v_pass_result jsonb;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['opportunityId','action','idempotencyKey','actor','policyVersion','now'],
    array['expectedDiscoveryRevision','expectedMaterialRevision'],
    array['selectedContactReferenceDigest','reason','note','submissionId']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
    or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
    or v_action not in ('pursue','watch','pass')
    or v_key is null or pg_catalog.length(v_key) not between 1 and 240
    or pg_catalog.btrim(v_key) <> v_key
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or v_policy is null or pg_catalog.length(v_policy) not between 1 and 120
    or pg_catalog.btrim(v_policy) <> v_policy
    or (v_contact_digest is not null and v_contact_digest !~ '^[0-9a-f]{64}$')
    or (v_action = 'pass' and (v_reason is null
      or pg_catalog.length(v_reason) not between 1 and 160
      or pg_catalog.btrim(v_reason) <> v_reason))
    or pg_catalog.length(v_note) > 2000
    or pg_catalog.length(v_submission_id) > 120
    or pg_catalog.btrim(v_submission_id) <> v_submission_id
    or p_command ->> 'expectedDiscoveryRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'expectedMaterialRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM owner decision command';
  end if;
  v_discovery := (p_command ->> 'expectedDiscoveryRevision')::bigint;
  v_material := (p_command ->> 'expectedMaterialRevision')::bigint;
  if v_discovery > 9007199254740991 or v_material > 9007199254740991 then
    raise exception 'Unsafe Pursue CIM owner revision';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  if v_action <> 'pass' then
    v_reason := null;
    v_note := '';
    v_submission_id := '';
  end if;
  v_request_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision-request:v1'::text),
    pg_catalog.to_jsonb(v_action), pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_discovery), pg_catalog.to_jsonb(v_material),
    coalesce(pg_catalog.to_jsonb(v_contact_digest), 'null'::jsonb),
    pg_catalog.to_jsonb(v_actor), pg_catalog.to_jsonb(v_policy),
    coalesce(pg_catalog.to_jsonb(v_reason), 'null'::jsonb),
    pg_catalog.to_jsonb(v_note), pg_catalog.to_jsonb(v_submission_id),
    pg_catalog.to_jsonb(v_key));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:owner-key:' || v_key, 0));
  select * into v_existing from public.deal_hunter_owner_decision_events
    where idempotency_key = v_key;
  if found then
    select * into v_enrollment from public.deal_hunter_pursuit_enrollments
      where decision_event_id = v_existing.id;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'replay', v_existing.request_digest = v_request_digest,
      'conflict', v_existing.request_digest <> v_request_digest,
      'decision', pg_catalog.to_jsonb(v_existing),
      'enrollment', case when found then pg_catalog.to_jsonb(v_enrollment) else null end);
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  if not found or v_opportunity.status <> 'active'
    or v_opportunity.discovery_revision <> v_discovery
    or v_opportunity.material_revision <> v_material
  then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'reason', 'stale_revision', 'decision', null, 'enrollment', null);
  end if;
  select * into v_score from public.deal_hunter_opportunity_scores
    where opportunity_id = v_opportunity_id and current_triage_eligible = true
      and should_remove = false for update;
  if v_action <> 'pursue' then
    if v_score.opportunity_id is null or (v_action = 'pass' and v_score.deal_key is null) then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'decision', null, 'enrollment', null);
    end if;
  end if;
  if v_score.deal_key is not null and exists (
    select 1 from public.deal_hunter_dispositions
    where deal_key = v_score.deal_key and disposition = 'dismissed'
  ) then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'reason', 'already-passed', 'decision', null, 'enrollment', null);
  end if;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where opportunity_id = v_opportunity_id and state <> 'superseded' for update;
  if found and v_action = 'pursue' then
    select * into v_decision from public.deal_hunter_owner_decision_events
      where id = v_enrollment.decision_event_id;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
      'enrollment', pg_catalog.to_jsonb(v_enrollment));
  end if;
  v_decision_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision:v1'::text), pg_catalog.to_jsonb(v_key));
  v_enrollment_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('pursuit-enrollment:v1'::text), pg_catalog.to_jsonb(v_decision_id));
  if v_action = 'pass' then
    if v_submission_id <> '' then
      raise exception 'Explicit Pass submission context requires verified supersession authority';
    end if;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-disposition:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_disposition_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-archive:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_archive_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-triage:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_triage_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_pass_result := public.pass_deal_hunter_opportunity_freshness_v1(
      pg_catalog.jsonb_build_object('opportunity_id', v_opportunity_id,
        'reason', v_reason, 'note', v_note, 'actor', v_actor, 'occurred_at', v_now,
        'disposition_id', v_disposition_id, 'archive_activity_id', v_archive_id,
        'triage_activity_id', v_triage_id), v_discovery, v_material);
    if v_pass_result ->> 'applied' <> 'true' then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'reason', v_pass_result ->> 'reason',
        'decision', null, 'enrollment', null);
    end if;
  end if;
  insert into public.deal_hunter_owner_decision_events
    (id, idempotency_key, request_digest, opportunity_id, action, actor,
     expected_discovery_revision, expected_material_revision,
     observed_discovery_revision, observed_material_revision,
     selected_contact_reference_digest, policy_version, created_at)
  values (v_decision_id, v_key, v_request_digest, v_opportunity_id, v_action, v_actor,
    v_discovery, v_material, v_opportunity.discovery_revision,
    v_opportunity.material_revision, v_contact_digest, v_policy, v_now)
  returning * into v_decision;

  if v_action <> 'pursue' then
    if v_enrollment.id is not null then
      update public.deal_hunter_pursuit_enrollments
        set state = 'superseded', reason_code = v_action || '-selected',
          row_version = row_version + 1, updated_at = v_now
        where id = v_enrollment.id and state <> 'superseded';
    end if;
    for v_campaign in
      select * from public.deal_hunter_cim_campaigns
      where opportunity_id = v_opportunity_id
        and state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')
      order by id for update
    loop
      for v_transmission in
        select tr.* from public.deal_hunter_cim_transmissions as tr
        where tr.id in (
          select m.transmission_id from public.deal_hunter_cim_transmission_touches as m
          where m.campaign_id = v_campaign.id and m.cancelled_at is null)
          and tr.state in ('prepared','final-gate-blocked')
        order by tr.id for update
      loop
        perform public.pursue_cim_cancel_prepared_transmission_v1(
          v_transmission.id, v_now, v_action || '-selected', v_actor, false);
      end loop;
      for v_touch in
        select * from public.deal_hunter_cim_campaign_touches
        where campaign_id = v_campaign.id and state in ('scheduled','claimed')
          and transmission_id is null order by id for update
      loop
        update public.deal_hunter_cim_campaign_touches
          set state = 'cancelled-before-provider', terminal_reason = v_action || '-selected',
            row_version = row_version + 1, updated_at = v_now
          where id = v_touch.id and row_version = v_touch.row_version;
        insert into public.deal_hunter_cim_audit_events
          (id, event_type, opportunity_id, campaign_id, touch_id, prior_state,
           next_state, reason_code, actor, source, occurred_at, metadata)
        values (public.pursue_cim_digest_v1(
            pg_catalog.to_jsonb('cim-audit:v1'::text),
            pg_catalog.to_jsonb('touch-cancelled'::text),
            pg_catalog.to_jsonb(v_touch.id || ':' || (v_touch.row_version + 1)::text)),
          'touch-cancelled', v_opportunity_id, v_campaign.id, v_touch.id, v_touch.state,
          'cancelled-before-provider', v_action || '-selected', v_actor,
          'sqlite-transition', v_now, '{}'::jsonb);
      end loop;
      update public.deal_hunter_cim_campaigns
        set state = 'stopped', reason_code = v_action || '-selected',
          terminal_revision = terminal_revision + 1, row_version = row_version + 1,
          updated_at = v_now
        where id = v_campaign.id and row_version = v_campaign.row_version;
      v_terminal_id := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('owner-terminal:v1'::text),
        pg_catalog.to_jsonb(v_decision_id), pg_catalog.to_jsonb(v_campaign.id));
      insert into public.deal_hunter_cim_terminal_events
        (id, scope, scope_id, campaign_id, revision, reason_code,
         evidence_type, evidence_id, observed_at, actor, source, metadata_digest, created_at)
      values (v_terminal_id, 'campaign', v_campaign.id, v_campaign.id,
        v_campaign.terminal_revision + 1, v_action || '-selected',
        'owner-decision', v_decision_id, v_now, v_actor, 'sqlite-transition',
        v_request_digest, v_now);
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
         reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('terminal-transition'::text),
          pg_catalog.to_jsonb(v_terminal_id)),
        'terminal-transition', v_opportunity_id, v_campaign.id, v_campaign.state,
        'stopped', v_action || '-selected', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    end loop;
    if v_action = 'watch' then
    update public.deal_hunter_opportunity_scores
      set operator_priority = case when v_action = 'watch' then 'watch' else operator_priority end,
        reviewed_at = v_now, reviewed_by = v_actor,
        reviewed_fingerprint = score_fingerprint,
        reviewed_semantic_digest = semantic_digest,
        reviewed_discovery_revision = v_discovery,
        reviewed_material_revision = v_material, operator_updated_at = v_now
      where opportunity_id = v_opportunity_id;
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, next_state, authority_digest,
       actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('owner-decision'::text),
        pg_catalog.to_jsonb(v_decision_id)),
      'owner-decision', v_opportunity_id, v_action, v_request_digest,
      v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
      'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
      'enrollment', null, 'passResult', v_pass_result);
  end if;

  insert into public.deal_hunter_pursuit_enrollments
    (id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
     created_at, updated_at)
  values (v_enrollment_id, v_decision_id, v_opportunity_id, 'queued',
    'awaiting-orchestration', public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('enrollment-authority:v1'::text),
      pg_catalog.to_jsonb(v_decision_id),
      pg_catalog.to_jsonb(v_opportunity.discovery_revision),
      pg_catalog.to_jsonb(v_opportunity.material_revision)), v_now, v_now)
  returning * into v_enrollment;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, next_state, authority_digest,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('owner-decision'::text),
      pg_catalog.to_jsonb(v_decision_id)),
    'owner-decision', v_opportunity_id, v_action, v_request_digest,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  if v_score.opportunity_id is not null then
    update public.deal_hunter_opportunity_scores set operator_priority = 'high',
      reviewed_at = v_now, reviewed_by = v_actor,
      reviewed_fingerprint = score_fingerprint,
      reviewed_semantic_digest = semantic_digest,
      reviewed_discovery_revision = v_discovery,
      reviewed_material_revision = v_material, operator_updated_at = v_now
      where opportunity_id = v_opportunity_id;
  end if;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
    'enrollment', pg_catalog.to_jsonb(v_enrollment));
end;
$$;

revoke all on function public.pursue_cim_record_owner_decision_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_record_owner_decision_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_required_text_v1(
  p_command jsonb, p_key text, p_maximum integer)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_value text := p_command ->> p_key;
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or pg_catalog.jsonb_typeof(p_command -> p_key) <> 'string'
    or v_value is null or pg_catalog.length(v_value) not between 1 and p_maximum
    or pg_catalog.btrim(v_value) <> v_value
  then
    raise exception 'Invalid Pursue CIM text input: %', p_key;
  end if;
  return v_value;
end;
$$;

create or replace function public.pursue_cim_required_revision_v1(
  p_command jsonb, p_key text)
returns bigint
language plpgsql immutable
set search_path = ''
as $$
declare
  v_value text := p_command ->> p_key;
begin
  if pg_catalog.jsonb_typeof(p_command -> p_key) <> 'number'
    or v_value !~ '^(0|[1-9][0-9]*)$'
    or v_value::numeric > 9007199254740991
  then
    raise exception 'Invalid Pursue CIM revision: %', p_key;
  end if;
  return v_value::bigint;
end;
$$;

create or replace function public.pursue_cim_materialize_campaign_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text;
  v_enrollment_id text;
  v_policy text;
  v_template text;
  v_permission text;
  v_permission_scope text;
  v_recipient_authority text;
  v_address text;
  v_sender_policy text;
  v_reply_policy text;
  v_thread_key text;
  v_batching_policy text;
  v_cadence_policy text;
  v_due_local text;
  v_actor text;
  v_template_digest text := p_command ->> 'templateDigest';
  v_permission_digest text := p_command ->> 'permissionDigest';
  v_recipient_fingerprint text := p_command ->> 'recipientFingerprint';
  v_reply_alias_digest text := p_command ->> 'replyAliasTokenDigest';
  v_freshness_digest text := p_command ->> 'freshnessAuthorityDigest';
  v_crm_text text := p_command ->> 'crmSubmissionId';
  v_crm_id uuid;
  v_enrollment_expected bigint;
  v_generation bigint;
  v_permission_revision bigint;
  v_canonical_revision bigint;
  v_crm_revision bigint;
  v_discovery bigint;
  v_material bigint;
  v_timezone_revision bigint;
  v_now timestamptz;
  v_due timestamptz;
  v_campaign_id text;
  v_conversation_id text;
  v_touch_id text;
  v_current public.deal_hunter_cim_campaigns%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_timezone public.deal_hunter_opportunity_timezone_revisions%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_crm public.contact_submissions%rowtype;
  v_same boolean;
begin
  v_opportunity_id := public.pursue_cim_required_text_v1(p_command,'opportunityId',200);
  v_enrollment_id := public.pursue_cim_required_text_v1(p_command,'enrollmentId',240);
  v_policy := public.pursue_cim_required_text_v1(p_command,'policyVersion',120);
  v_template := public.pursue_cim_required_text_v1(p_command,'templateVersion',120);
  v_permission := public.pursue_cim_required_text_v1(p_command,'permissionVersion',120);
  v_permission_scope := public.pursue_cim_required_text_v1(p_command,'permissionScope',240);
  v_recipient_authority := public.pursue_cim_required_text_v1(p_command,'recipientAuthorityId',240);
  v_address := public.pursue_cim_required_text_v1(p_command,'recipientAddress',320);
  v_sender_policy := public.pursue_cim_required_text_v1(p_command,'senderPolicyVersion',120);
  v_reply_policy := public.pursue_cim_required_text_v1(p_command,'replyPolicyVersion',120);
  v_thread_key := public.pursue_cim_required_text_v1(p_command,'rfcThreadKey',500);
  v_batching_policy := public.pursue_cim_required_text_v1(p_command,'batchingPolicyVersion',120);
  v_cadence_policy := public.pursue_cim_required_text_v1(p_command,'cadencePolicyVersion',120);
  v_due_local := public.pursue_cim_required_text_v1(p_command,'dueLocal',120);
  v_actor := public.pursue_cim_required_text_v1(p_command,'actor',200);
  v_enrollment_expected := public.pursue_cim_required_revision_v1(p_command,'expectedEnrollmentRowVersion');
  v_generation := public.pursue_cim_required_revision_v1(p_command,'generation');
  v_permission_revision := public.pursue_cim_required_revision_v1(p_command,'permissionRevision');
  v_canonical_revision := public.pursue_cim_required_revision_v1(p_command,'canonicalRevision');
  v_crm_revision := public.pursue_cim_required_revision_v1(p_command,'crmOwnershipRevision');
  v_discovery := public.pursue_cim_required_revision_v1(p_command,'expectedDiscoveryRevision');
  v_material := public.pursue_cim_required_revision_v1(p_command,'expectedMaterialRevision');
  v_timezone_revision := public.pursue_cim_required_revision_v1(p_command,'timezoneRevision');
  if v_template_digest !~ '^[0-9a-f]{64}$'
    or v_permission_digest !~ '^[0-9a-f]{64}$'
    or v_recipient_fingerprint !~ '^[0-9a-f]{64}$'
    or v_reply_alias_digest !~ '^[0-9a-f]{64}$'
    or v_freshness_digest !~ '^[0-9a-f]{64}$'
    or pg_catalog.jsonb_typeof(p_command -> 'dueAt') <> 'string'
    or pg_catalog.jsonb_typeof(p_command -> 'now') <> 'string'
  then
    raise exception 'Invalid Pursue CIM campaign authority input';
  end if;
  v_due := public.pursue_cim_required_instant_v1(p_command, 'dueAt');
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_campaign_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-campaign:v1'::text), pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_generation), pg_catalog.to_jsonb(v_policy));
  v_conversation_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-conversation:v1'::text),
    pg_catalog.to_jsonb(v_recipient_fingerprint), pg_catalog.to_jsonb(v_sender_policy));
  v_touch_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-touch:v1'::text), pg_catalog.to_jsonb(v_campaign_id),
    pg_catalog.to_jsonb('initial'::text), pg_catalog.to_jsonb(v_cadence_policy));
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  select * into v_current from public.deal_hunter_cim_campaigns
    where opportunity_id = v_opportunity_id order by generation desc limit 1 for update;
  if found then
    v_same := v_current.id = v_campaign_id and v_current.enrollment_id = v_enrollment_id
      and v_current.template_digest = v_template_digest
      and v_current.permission_digest = v_permission_digest
      and v_current.recipient_fingerprint = v_recipient_fingerprint
      and v_current.timezone_revision = v_timezone_revision;
    select * into v_touch from public.deal_hunter_cim_campaign_touches
      where campaign_id = v_current.id and logical_slot = 'initial';
    return pg_catalog.jsonb_build_object('applied', false, 'existing', v_same,
      'actionRequired', not v_same, 'campaign', pg_catalog.to_jsonb(v_current),
      'initialTouch', case when found then pg_catalog.to_jsonb(v_touch) else null end);
  end if;
  if v_generation <> 1 then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where id = v_enrollment_id for update;
  if v_enrollment.id is not null then
    select * into v_decision from public.deal_hunter_owner_decision_events
      where id = v_enrollment.decision_event_id;
  end if;
  select * into v_timezone from public.deal_hunter_opportunity_timezone_revisions
    where opportunity_id = v_opportunity_id order by revision desc limit 1 for share;
  if v_crm_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_crm_id := v_crm_text::uuid;
    select * into v_crm from public.contact_submissions where id = v_crm_id for share;
  end if;
  if public.pursue_cim_current_activation_v1('fl04b-enrollment',v_now) is null
    or v_enrollment.id is null or v_enrollment.opportunity_id <> v_opportunity_id
    or v_enrollment.state not in ('queued','waiting-on-eligibility')
    or v_enrollment.row_version <> v_enrollment_expected
    or v_decision.id is null or v_decision.action <> 'pursue'
    or v_opportunity.opportunity_id is null or v_opportunity.status <> 'active'
    or v_opportunity.discovery_revision <> v_discovery
    or v_opportunity.material_revision <> v_material
    or v_timezone.revision is null or v_timezone.revision <> v_timezone_revision
    or v_timezone.state not in ('verified','derived')
    or v_crm.id is null or v_crm.deal_hunter_opportunity_id <> v_opportunity_id
    or v_crm.archived_at is not null or v_opportunity.primary_submission_id <> v_crm.id
    or exists (select 1 from public.deal_hunter_cim_requests
      where opportunity_id = v_opportunity_id and
        (delivery_state in ('accepted','ambiguous') or
         request_state in ('provider_pending','provider_accepted')))
  then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_conversation_id for update;
  if found and (v_conversation.recipient_authority_id <> v_recipient_authority
    or v_conversation.recipient_address <> v_address
    or v_conversation.recipient_fingerprint <> v_recipient_fingerprint
    or v_conversation.state <> 'open')
  then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  if v_conversation.id is null then
    insert into public.deal_hunter_broker_conversations
      (id, recipient_authority_id, recipient_fingerprint, recipient_address,
       sender_policy_version, reply_policy_version, reply_alias_token_digest,
       rfc_thread_key, state, batching_policy_version, created_at, updated_at)
    values (v_conversation_id, v_recipient_authority, v_recipient_fingerprint, v_address,
      v_sender_policy, v_reply_policy, v_reply_alias_digest, v_thread_key,
      'open', v_batching_policy, v_now, v_now);
  end if;
  insert into public.deal_hunter_cim_campaigns
    (id, opportunity_id, generation, enrollment_id, decision_event_id, policy_version,
     template_version, template_digest, permission_version, permission_digest,
     permission_revision, permission_scope, canonical_revision, crm_submission_id,
     crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
     freshness_authority_digest, discovery_revision, material_revision,
     timezone_revision, conversation_id, state, reason_code, created_at, updated_at)
  values (v_campaign_id, v_opportunity_id, v_generation, v_enrollment_id, v_decision.id,
    v_policy, v_template, v_template_digest, v_permission, v_permission_digest,
    v_permission_revision, v_permission_scope, v_canonical_revision, v_crm.id,
    v_crm_revision, v_recipient_authority, v_recipient_fingerprint,
    v_freshness_digest, v_discovery, v_material, v_timezone_revision,
    v_conversation_id, 'initial-pending', 'awaiting-window', v_now, v_now)
  returning * into v_campaign;
  insert into public.deal_hunter_cim_campaign_touches
    (id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
     due_at, due_local, timezone_revision, state, created_at, updated_at)
  values (v_touch_id, v_campaign_id, v_opportunity_id, 'initial', 'initial', 0,
    v_due, v_due_local, v_timezone_revision, 'scheduled', v_now, v_now)
  returning * into v_touch;
  update public.deal_hunter_pursuit_enrollments
    set state = 'campaign-created', reason_code = null,
      updated_at = v_now, row_version = row_version + 1
    where id = v_enrollment_id and row_version = v_enrollment_expected;
  if not found then
    raise exception 'Concurrent Pursue CIM enrollment allocation';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id,
     next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('campaign-allocated'::text),
      pg_catalog.to_jsonb(v_campaign_id)),
    'campaign-allocated', v_opportunity_id, v_campaign_id, v_conversation_id,
    'initial-pending', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
     next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('touch-created'::text), pg_catalog.to_jsonb(v_touch_id)),
    'touch-created', v_opportunity_id, v_campaign_id, v_conversation_id, v_touch_id,
    'scheduled', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, prior_state, next_state,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('enrollment-transition'::text),
      pg_catalog.to_jsonb(v_enrollment_id || ':' || (v_enrollment_expected + 1)::text)),
    'enrollment-transition', v_opportunity_id, v_enrollment.state, 'campaign-created',
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'existing', false,
    'actionRequired', false, 'campaign', pg_catalog.to_jsonb(v_campaign),
    'initialTouch', pg_catalog.to_jsonb(v_touch));
end;
$$;

revoke all on function public.pursue_cim_required_text_v1(jsonb,text,integer)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_required_revision_v1(jsonb,text)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_materialize_campaign_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_required_text_v1(jsonb,text,integer) to service_role;
grant execute on function public.pursue_cim_required_revision_v1(jsonb,text) to service_role;
grant execute on function public.pursue_cim_materialize_campaign_v1(jsonb) to service_role;

create or replace function public.pursue_cim_cancel_prepared_transmission_v1(
  p_transmission_id text, p_now timestamptz, p_reason text, p_actor text,
  p_preserve_claim boolean default false)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
begin
  if p_transmission_id is null or p_now is null
    or p_reason is null or pg_catalog.length(p_reason) not between 1 and 160
    or p_actor is null or pg_catalog.length(p_actor) not between 1 and 200
    or pg_catalog.btrim(p_reason) <> p_reason
    or pg_catalog.btrim(p_actor) <> p_actor
  then
    raise exception 'Invalid prepared transmission cancellation';
  end if;
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = p_transmission_id for update;
  if not found or v_transmission.state not in ('prepared','final-gate-blocked')
    or v_transmission.invocation_authority_count <> 0 then
    return false;
  end if;
  for v_member in
    select m.touch_id, m.campaign_id, m.opportunity_id, t.row_version
      from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      where m.transmission_id = p_transmission_id and m.cancelled_at is null
      order by m.touch_id for update of m, t
  loop
    update public.deal_hunter_cim_transmission_touches
      set cancelled_at = p_now, cancellation_reason = p_reason
      where transmission_id = p_transmission_id and touch_id = v_member.touch_id
        and cancelled_at is null;
    update public.deal_hunter_cim_campaign_touches
      set transmission_id = null,
        state = case when p_preserve_claim then 'claimed' else 'cancelled-before-provider' end,
        terminal_reason = case when p_preserve_claim then null else p_reason end,
        row_version = row_version + 1, updated_at = p_now
      where id = v_member.touch_id and transmission_id = p_transmission_id
        and row_version = v_member.row_version;
    if not found then
      raise exception 'Concurrent Pursue CIM membership cancellation';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, touch_id, transmission_id,
       prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('transmission-membership-cancelled'::text),
        pg_catalog.to_jsonb(p_transmission_id || ':' || v_member.touch_id)),
      'transmission-membership-cancelled', v_member.opportunity_id,
      v_member.campaign_id, v_member.touch_id, p_transmission_id,
      'active', 'cancelled', p_reason, p_actor, 'sqlite-transition', p_now, '{}'::jsonb);
  end loop;
  update public.deal_hunter_cim_transmissions
    set state = 'cancelled-before-provider', row_version = row_version + 1, updated_at = p_now
    where id = p_transmission_id and state in ('prepared','final-gate-blocked')
      and invocation_authority_count = 0;
  if not found then
    raise exception 'Concurrent Pursue CIM transmission cancellation';
  end if;
  update public.crm_email_outbox set state = 'cancelled', updated_at = p_now
    where id = v_transmission.outbox_id and state in ('prepared','final-gate-blocked');
  for v_authorization in
    select * from public.deal_hunter_cim_live_provider_authorizations
      where transmission_id = p_transmission_id
        and consumed_at is null and withdrawn_at is null
      order by id for update
  loop
    update public.deal_hunter_cim_live_provider_authorizations
      set withdrawn_at = p_now where id = v_authorization.id
        and consumed_at is null and withdrawn_at is null;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, transmission_id, authorization_id, prior_state,
       next_state, reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('authorization-withdrawn'::text),
        pg_catalog.to_jsonb(v_authorization.id)),
      'authorization-withdrawn', p_transmission_id, v_authorization.id,
      'issued', 'withdrawn', p_reason, p_actor, 'sqlite-transition', p_now, '{}'::jsonb);
  end loop;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, prior_state, next_state,
     reason_code, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-cancelled'::text),
      pg_catalog.to_jsonb(p_transmission_id)),
    'transmission-cancelled', p_transmission_id, v_transmission.state,
    'cancelled-before-provider', p_reason, p_actor, 'sqlite-transition', p_now, '{}'::jsonb);
  return true;
end;
$$;

create or replace function public.pursue_cim_prepare_transmission_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touch_ids text[];
  v_touch_id text;
  v_touches public.deal_hunter_cim_campaign_touches[] := array[]::public.deal_hunter_cim_campaign_touches[];
  v_campaigns public.deal_hunter_cim_campaigns[] := array[]::public.deal_hunter_cim_campaigns[];
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_crm_owner public.contact_submissions%rowtype;
  v_current public.deal_hunter_cim_transmissions%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_current_members text[];
  v_claim_digest text;
  v_expected_campaign bigint;
  v_expected_conversation bigint;
  v_generation bigint;
  v_payload_version text;
  v_from text;
  v_reply_to text;
  v_subject text;
  v_body_text text;
  v_body_html text;
  v_actor text;
  v_now timestamptz;
  v_to jsonb := p_command -> 'toAddresses';
  v_cc jsonb := p_command -> 'ccAddresses';
  v_bcc jsonb := p_command -> 'bccAddresses';
  v_tags jsonb := p_command -> 'tags';
  v_array jsonb;
  v_item jsonb;
  v_templates text[] := array[]::text[];
  v_campaign_ids text[] := array[]::text[];
  v_payload_digest text;
  v_member_digest text;
  v_transmission_id text;
  v_communication_id text;
  v_outbox_id text;
  v_provider_key text;
  v_metadata jsonb;
  v_capability text;
  v_index integer;
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or pg_catalog.jsonb_typeof(p_command -> 'touchIds') <> 'array'
    or pg_catalog.jsonb_array_length(p_command -> 'touchIds') not between 1 and 50
    or pg_catalog.jsonb_typeof(v_to) <> 'array'
    or pg_catalog.jsonb_array_length(v_to) <> 1
    or pg_catalog.jsonb_typeof(v_cc) <> 'array'
    or pg_catalog.jsonb_array_length(v_cc) > 20
    or pg_catalog.jsonb_typeof(v_bcc) <> 'array'
    or pg_catalog.jsonb_array_length(v_bcc) > 20
    or pg_catalog.jsonb_typeof(v_tags) <> 'array'
    or pg_catalog.jsonb_array_length(v_tags) > 30
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM transmission membership or addresses';
  end if;
  select pg_catalog.array_agg(value order by value) into v_touch_ids
    from pg_catalog.jsonb_array_elements_text(p_command -> 'touchIds') as value;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_command -> 'touchIds') as item
      where pg_catalog.jsonb_typeof(item.value) <> 'string') then
    raise exception 'Invalid Pursue CIM transmission member type';
  end if;
  if (select count(distinct value) from pg_catalog.unnest(v_touch_ids) as value)
       <> pg_catalog.array_length(v_touch_ids, 1)
  then
    raise exception 'Duplicate Pursue CIM transmission member';
  end if;
  foreach v_touch_id in array v_touch_ids loop
    if pg_catalog.length(v_touch_id) not between 1 and 240
      or pg_catalog.btrim(v_touch_id) <> v_touch_id then
      raise exception 'Invalid Pursue CIM transmission member';
    end if;
  end loop;
  foreach v_array in array array[v_to,v_cc,v_bcc] loop
    for v_item in select value from pg_catalog.jsonb_array_elements(v_array) loop
      if pg_catalog.jsonb_typeof(v_item) <> 'string'
        or pg_catalog.length(v_item #>> '{}') not between 1 and 320
        or pg_catalog.btrim(v_item #>> '{}') <> v_item #>> '{}' then
        raise exception 'Invalid Pursue CIM transmission address';
      end if;
    end loop;
  end loop;
  for v_item in select value from pg_catalog.jsonb_array_elements(v_tags) loop
    if pg_catalog.jsonb_typeof(v_item) <> 'string'
      or pg_catalog.length(v_item #>> '{}') not between 1 and 120 then
      raise exception 'Invalid Pursue CIM transmission tag';
    end if;
  end loop;
  v_claim_digest := public.pursue_cim_required_text_v1(p_command, 'claimTokenDigest', 64);
  if v_claim_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Pursue CIM transmission claim digest';
  end if;
  v_expected_campaign := public.pursue_cim_required_revision_v1(
    p_command, 'expectedCampaignTerminalRevision');
  v_expected_conversation := public.pursue_cim_required_revision_v1(
    p_command, 'expectedConversationTerminalRevision');
  v_generation := public.pursue_cim_required_revision_v1(p_command, 'preparationGeneration');
  if v_generation < 1 then
    raise exception 'Invalid Pursue CIM preparation generation';
  end if;
  v_payload_version := public.pursue_cim_required_text_v1(p_command, 'payloadVersion', 120);
  v_from := public.pursue_cim_required_text_v1(p_command, 'fromAddress', 320);
  v_reply_to := public.pursue_cim_required_text_v1(p_command, 'replyToAddress', 320);
  v_subject := public.pursue_cim_required_text_v1(p_command, 'subject', 998);
  v_body_text := public.pursue_cim_required_text_v1(p_command, 'bodyText', 100000);
  v_body_html := public.pursue_cim_required_text_v1(p_command, 'bodyHtmlSanitized', 100000);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  for v_index in 1..pg_catalog.array_length(v_touch_ids, 1) loop
    select * into v_touch from public.deal_hunter_cim_campaign_touches
      where id = v_touch_ids[v_index] for update;
    if not found then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true, 'transmission', null);
    end if;
    v_touches := pg_catalog.array_append(v_touches, v_touch);
    select * into v_campaign from public.deal_hunter_cim_campaigns
      where id = v_touch.campaign_id for update;
    v_campaigns := pg_catalog.array_append(v_campaigns, v_campaign);
    v_templates := pg_catalog.array_append(v_templates, v_campaign.template_version);
    v_campaign_ids := pg_catalog.array_append(v_campaign_ids, v_campaign.id);
  end loop;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_campaigns[1].conversation_id for update;
  v_payload_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-payload:v1'::text), pg_catalog.to_jsonb(v_from),
    v_to, v_cc, v_bcc, pg_catalog.to_jsonb(v_reply_to),
    pg_catalog.to_jsonb(v_subject), pg_catalog.to_jsonb(v_body_text),
    pg_catalog.to_jsonb(v_body_html), v_tags, pg_catalog.to_jsonb(v_touch_ids),
    pg_catalog.to_jsonb(v_templates), pg_catalog.to_jsonb(v_payload_version));
  select tr.* into v_current from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_transmissions as tr on tr.id = m.transmission_id
    where m.touch_id = v_touch_ids[1] and m.cancelled_at is null for update of tr;
  if found then
    select pg_catalog.array_agg(touch_id order by touch_id) into v_current_members
      from public.deal_hunter_cim_transmission_touches
      where transmission_id = v_current.id and cancelled_at is null;
    if v_current_members is distinct from v_touch_ids then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', true, 'terminal', false,
        'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    if v_current.payload_digest = v_payload_digest then
      return pg_catalog.jsonb_build_object('prepared', false,
        'existing', v_generation = v_current.preparation_generation,
        'payloadConflict', v_generation <> v_current.preparation_generation,
        'terminal', false, 'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    if v_generation <> v_current.preparation_generation + 1
      or not public.pursue_cim_cancel_prepared_transmission_v1(
        v_current.id, v_now, 'prepared-payload-changed', v_actor, true)
    then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', true, 'terminal', false,
        'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    for v_index in 1..pg_catalog.array_length(v_touches, 1) loop
      v_touches[v_index].transmission_id := null;
    end loop;
  end if;
  v_capability := case when pg_catalog.array_length(v_touch_ids, 1) > 1
    then 'fl04c-batch' when v_touches[1].kind = 'initial'
    then 'fl04b-initial' else 'fl04c-followup' end;
  if public.pursue_cim_current_activation_v1(v_capability, v_now) is null
    or v_conversation.id is null or v_conversation.state <> 'open'
    or v_conversation.terminal_revision <> v_expected_conversation
    or v_conversation.recipient_address <> v_to ->> 0
  then
    return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
      'payloadConflict', false, 'terminal', true, 'transmission', null);
  end if;
  for v_index in 1..pg_catalog.array_length(v_touches, 1) loop
    v_touch := v_touches[v_index];
    v_campaign := v_campaigns[v_index];
    if v_campaign.conversation_id <> v_conversation.id
      or v_campaign.terminal_revision <> v_expected_campaign
      or v_campaign.state not in ('initial-pending','active-follow-up')
      or v_campaign.crm_submission_id is null
      or (v_campaign.local_expiry_at is not null and v_campaign.local_expiry_at <= v_now)
      or v_touch.state <> 'claimed'
      or v_touch.claim_token_digest <> v_claim_digest
      or v_touch.transmission_id is not null
    then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true, 'transmission', null);
    end if;
  end loop;
  select * into v_crm_owner from public.contact_submissions
    where id = v_campaigns[1].crm_submission_id for update;
  if not found or v_crm_owner.deal_hunter_opportunity_id <> v_campaigns[1].opportunity_id
    or v_crm_owner.archived_at is not null
  then
    return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
      'payloadConflict', false, 'terminal', true, 'transmission', null);
  end if;
  v_member_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-members:v1'::text), pg_catalog.to_jsonb(v_touch_ids));
  v_transmission_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-transmission:v1'::text),
    pg_catalog.to_jsonb(v_campaigns[1].policy_version),
    pg_catalog.to_jsonb(v_conversation.recipient_fingerprint),
    pg_catalog.to_jsonb(v_touch_ids), pg_catalog.to_jsonb(v_generation),
    pg_catalog.to_jsonb(v_payload_version), pg_catalog.to_jsonb(v_payload_digest));
  v_communication_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('crm-communication:cim-autopilot:v1'::text),
    pg_catalog.to_jsonb(v_transmission_id));
  v_outbox_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('crm-outbox:cim-autopilot:v1'::text),
    pg_catalog.to_jsonb(v_transmission_id));
  v_provider_key := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-provider:v1'::text),
    pg_catalog.to_jsonb(v_transmission_id), pg_catalog.to_jsonb(v_payload_digest));
  v_metadata := pg_catalog.jsonb_build_object('transmissionId', v_transmission_id,
    'campaignIds', pg_catalog.to_jsonb(v_campaign_ids), 'tags', v_tags,
    'retryPolicy', 'reconcile-only-after-provider-pending');
  insert into public.crm_communications
    (id, submission_id, opportunity_id, direction, channel, source, kind,
     idempotency_key, outbox_id, thread_key, from_address, to_addresses,
     cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
     body_html_sanitized, occurred_at, created_at, updated_at, metadata)
  values (v_communication_id, v_crm_owner.id, v_campaigns[1].opportunity_id,
    'outbound', 'email', 'pursue-cim-autopilot',
    case when v_touches[1].kind = 'initial' then 'cim-initial' else 'cim-follow-up' end,
    v_communication_id, v_outbox_id, v_conversation.rfc_thread_key,
    v_from, v_to, v_cc, v_bcc, v_reply_to, v_subject, v_body_text,
    v_body_html, v_now, v_now, v_now, v_metadata);
  insert into public.crm_email_outbox
    (id, communication_id, submission_id, idempotency_key, client_request_key,
     state, attempt_count, expected_submission_version, actor, created_at, updated_at, metadata)
  values (v_outbox_id, v_communication_id, v_crm_owner.id, v_outbox_id,
    public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-client-request:v1'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'prepared', 0, v_crm_owner.updated_at, v_actor, v_now, v_now, v_metadata);
  insert into public.deal_hunter_cim_transmissions
    (id, conversation_id, member_digest, preparation_generation, payload_version,
     payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
     reply_to_address, subject, provider_idempotency_key, communication_id,
     outbox_id, state, release_state, created_at, updated_at)
  values (v_transmission_id, v_conversation.id, v_member_digest, v_generation,
    v_payload_version, v_payload_digest, v_from, v_to, v_cc, v_bcc, v_reply_to,
    v_subject, v_provider_key, v_communication_id, v_outbox_id,
    'prepared', 'ordinary', v_now, v_now)
  returning * into v_transmission;
  for v_index in 1..pg_catalog.array_length(v_touches, 1) loop
    v_touch := v_touches[v_index];
    v_campaign := v_campaigns[v_index];
    insert into public.deal_hunter_cim_transmission_touches
      (transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at)
    values (v_transmission_id, v_touch.id, v_touch.opportunity_id,
      v_touch.campaign_id, v_index, v_now);
    update public.deal_hunter_cim_campaign_touches
      set transmission_id = v_transmission_id, row_version = row_version + 1,
        updated_at = v_now
      where id = v_touch.id and state = 'claimed'
        and claim_token_digest = v_claim_digest and transmission_id is null;
    if not found then
      raise exception 'Concurrent Pursue CIM transmission membership';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
       transmission_id, next_state, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('transmission-membership'::text),
        pg_catalog.to_jsonb(v_transmission_id || ':' || v_touch.id)),
      'transmission-membership', v_touch.opportunity_id, v_campaign.id,
      v_conversation.id, v_touch.id, v_transmission_id,
      'active', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  end loop;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, conversation_id, transmission_id,
     next_state, payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-prepared'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'transmission-prepared', v_campaigns[1].opportunity_id, v_conversation.id,
    v_transmission_id, 'prepared', v_payload_digest,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('prepared', true, 'existing', false,
    'payloadConflict', false, 'terminal', false,
    'transmission', pg_catalog.to_jsonb(v_transmission));
end;
$$;

revoke all on function public.pursue_cim_cancel_prepared_transmission_v1(
  text,timestamptz,text,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.pursue_cim_prepare_transmission_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_prepare_transmission_v1(jsonb) to service_role;

create or replace function public.pursue_cim_issue_live_authorization_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_activation_id text;
  v_capability text;
  v_writer_path text;
  v_transmission_id text;
  v_payload_digest text;
  v_recipient_digest text;
  v_provider_profile text;
  v_actor text;
  v_reason text;
  v_now timestamptz;
  v_expires timestamptz;
  v_existing public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_current public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_count integer := 0;
  v_replay boolean;
begin
  v_id := public.pursue_cim_required_text_v1(p_command, 'id', 240);
  v_activation_id := public.pursue_cim_required_text_v1(p_command, 'activationId', 240);
  v_capability := public.pursue_cim_required_text_v1(p_command, 'capability', 40);
  v_writer_path := public.pursue_cim_required_text_v1(p_command, 'writerPath', 240);
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_payload_digest := public.pursue_cim_required_text_v1(p_command, 'payloadDigest', 64);
  v_recipient_digest := public.pursue_cim_required_text_v1(
    p_command, 'recipientAuthorityDigest', 64);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_reason := public.pursue_cim_required_text_v1(p_command, 'reason', 1000);
  if v_payload_digest !~ '^[0-9a-f]{64}$'
    or v_recipient_digest !~ '^[0-9a-f]{64}$'
    or p_command ->> 'now' is null or p_command ->> 'expiresAt' is null
  then
    raise exception 'Invalid Pursue CIM live authorization command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_expires := public.pursue_cim_required_instant_v1(p_command, 'expiresAt');
  if v_expires <= v_now then
    raise exception 'Pursue CIM authorization already expired';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:authorization-id:' || v_id, 0));
  select * into v_existing from public.deal_hunter_cim_live_provider_authorizations
    where id = v_id for update;
  if found then
    v_replay := v_existing.activation_id = v_activation_id
      and v_existing.capability = v_capability
      and v_existing.writer_path = v_writer_path
      and v_existing.transmission_id = v_transmission_id
      and v_existing.payload_digest = v_payload_digest
      and v_existing.recipient_authority_digest = v_recipient_digest
      and v_existing.provider_profile = v_provider_profile
      and v_existing.expires_at = v_expires;
    return pg_catalog.jsonb_build_object('issued', false, 'replay', v_replay,
      'conflict', not v_replay, 'blockedReason', null,
      'authorization', pg_catalog.to_jsonb(v_existing));
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pursue-cim:authorization-current:' || v_transmission_id || ':' || v_writer_path, 0));
  select * into v_current from public.deal_hunter_cim_live_provider_authorizations
    where transmission_id = v_transmission_id and writer_path = v_writer_path
      and consumed_at is null and withdrawn_at is null for update;
  if found then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'authorization_exists',
      'authorization', pg_catalog.to_jsonb(v_current));
  end if;
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where id = v_activation_id for share;
  if public.pursue_cim_current_activation_v1(v_capability, v_now) is distinct from v_activation_id
    or v_activation.provider_profile is distinct from v_provider_profile
  then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'capability_inactive', 'authorization', null);
  end if;
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_transmission_id for update;
  if not found or v_transmission.state <> 'prepared'
    or v_transmission.payload_digest <> v_payload_digest
  then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'transmission_invalid', 'authorization', null);
  end if;
  for v_member in
    select c.recipient_fingerprint, t.kind
    from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
    join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
    where m.transmission_id = v_transmission_id and m.cancelled_at is null
    order by m.touch_id for share of m,c,t
  loop
    v_count := v_count + 1;
    if v_member.recipient_fingerprint <> v_recipient_digest
      or (v_member.kind = 'initial' and v_capability <> 'fl04b-initial')
      or (v_member.kind <> 'initial' and v_capability = 'fl04b-initial')
    then
      return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
        'conflict', false, 'blockedReason', 'recipient_authority_changed',
        'authorization', null);
    end if;
  end loop;
  if v_count = 0 then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'recipient_authority_changed',
      'authorization', null);
  end if;
  insert into public.deal_hunter_cim_live_provider_authorizations
    (id, activation_id, capability, writer_path, transmission_id,
     payload_digest, recipient_authority_digest, provider_profile,
     maximum_calls, issued_at, expires_at, actor, reason)
  values (v_id, v_activation_id, v_capability, v_writer_path, v_transmission_id,
    v_payload_digest, v_recipient_digest, v_provider_profile, 1,
    v_now, v_expires, v_actor, v_reason)
  returning * into v_existing;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, activation_id, authorization_id,
     next_state, payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('live-authorization-issued'::text),
      pg_catalog.to_jsonb(v_id)),
    'live-authorization-issued', v_transmission_id, v_activation_id,
    v_id, 'issued', v_payload_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('issued', true, 'replay', false,
    'conflict', false, 'blockedReason', null, 'authorization', pg_catalog.to_jsonb(v_existing));
end;
$$;

revoke all on function public.pursue_cim_issue_live_authorization_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_issue_live_authorization_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_authorize_provider_pending_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_authorization_id text;
  v_writer_path text;
  v_provider_profile text;
  v_expected_row bigint;
  v_expected_campaign bigint;
  v_expected_conversation bigint;
  v_claim_digest text;
  v_gate_digest text;
  v_nonce_digest text;
  v_actor text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_communication public.crm_communications%rowtype;
  v_outbox public.crm_email_outbox%rowtype;
  v_member record;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_timezone public.deal_hunter_opportunity_timezone_revisions%rowtype;
  v_owner public.contact_submissions%rowtype;
  v_count integer := 0;
  v_member_ids text[] := array[]::text[];
  v_templates text[] := array[]::text[];
  v_payload_digest text;
  v_pause boolean;
  v_reason text := null;
  v_local timestamp;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_authorization_id := public.pursue_cim_required_text_v1(p_command, 'authorizationId', 240);
  v_writer_path := public.pursue_cim_required_text_v1(p_command, 'writerPath', 240);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_expected_row := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_expected_campaign := public.pursue_cim_required_revision_v1(
    p_command, 'expectedCampaignTerminalRevision');
  v_expected_conversation := public.pursue_cim_required_revision_v1(
    p_command, 'expectedConversationTerminalRevision');
  v_claim_digest := public.pursue_cim_required_text_v1(p_command, 'claimTokenDigest', 64);
  v_gate_digest := public.pursue_cim_required_text_v1(p_command, 'finalGateAuthorityDigest', 64);
  v_nonce_digest := public.pursue_cim_required_text_v1(p_command, 'boundaryNonceDigest', 64);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if v_claim_digest !~ '^[0-9a-f]{64}$' or v_gate_digest !~ '^[0-9a-f]{64}$'
    or v_nonce_digest !~ '^[0-9a-f]{64}$' or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM provider-pending command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  <<gate>>
  begin
    select * into v_transmission from public.deal_hunter_cim_transmissions
      where id = v_transmission_id for update;
    if not found then
      v_reason := 'lifecycle_conflict'; exit gate;
    end if;
    if v_transmission.state <> 'prepared'
      or v_transmission.invocation_authority_count <> 0 then
      v_reason := 'already_provider_pending'; exit gate;
    end if;
    if v_transmission.row_version <> v_expected_row then
      v_reason := 'stale_authority'; exit gate;
    end if;
    select outreach_paused into v_pause from public.deal_hunter_cim_safety_settings
      where id = 'global' for share;
    if not found or v_pause is distinct from false then
      v_reason := 'central_pause'; exit gate;
    end if;
    select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
      where id = v_authorization_id for update;
    if not found or v_authorization.transmission_id <> v_transmission_id
      or v_authorization.writer_path <> v_writer_path
      or v_authorization.provider_profile <> v_provider_profile
      or v_authorization.payload_digest <> v_transmission.payload_digest
      or v_authorization.consumed_at is not null
      or v_authorization.withdrawn_at is not null
      or v_authorization.maximum_calls <> 1
      or v_authorization.expires_at <= v_now
    then
      v_reason := 'live_authorization_invalid'; exit gate;
    end if;
    select * into v_activation from public.deal_hunter_cim_capability_activations
      where id = v_authorization.activation_id for share;
    if public.pursue_cim_current_activation_v1(v_authorization.capability, v_now)
         is distinct from v_authorization.activation_id
      or v_activation.provider_profile is distinct from v_provider_profile
    then
      v_reason := 'capability_inactive'; exit gate;
    end if;
    select * into v_conversation from public.deal_hunter_broker_conversations
      where id = v_transmission.conversation_id for update;
    if not found or v_conversation.state <> 'open'
      or v_conversation.terminal_revision <> v_expected_conversation
    then
      v_reason := 'terminal_authority_changed'; exit gate;
    end if;
    for v_member in
      select t.*, c.state as campaign_state,
        c.terminal_revision as campaign_terminal_revision,
        c.timezone_revision as campaign_timezone_revision,
        c.discovery_revision as campaign_discovery_revision,
        c.material_revision as campaign_material_revision,
        c.recipient_fingerprint, c.crm_submission_id, c.template_version,
        c.local_expiry_at
      from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
      where m.transmission_id = v_transmission_id and m.cancelled_at is null
      order by t.id for update of m,t,c
    loop
      v_count := v_count + 1;
      v_member_ids := pg_catalog.array_append(v_member_ids, v_member.id);
      v_templates := pg_catalog.array_append(v_templates, v_member.template_version);
      if v_member.campaign_state not in ('initial-pending','active-follow-up')
        or v_member.campaign_terminal_revision <> v_expected_campaign then
        v_reason := 'terminal_authority_changed'; exit gate;
      end if;
      if v_member.state <> 'claimed'
        or v_member.claim_token_digest <> v_claim_digest
        or v_member.transmission_id <> v_transmission_id
        or v_member.claim_expires_at is null or v_member.claim_expires_at <= v_now
        or v_member.due_at > v_now then
        v_reason := 'lifecycle_conflict'; exit gate;
      end if;
      if v_member.recipient_fingerprint <> v_authorization.recipient_authority_digest
        or v_conversation.recipient_fingerprint <> v_authorization.recipient_authority_digest
      then
        v_reason := 'recipient_authority_changed'; exit gate;
      end if;
      select * into v_opportunity from public.deal_hunter_opportunities
        where opportunity_id = v_member.opportunity_id for share;
      if not found or v_opportunity.status <> 'active'
        or v_opportunity.discovery_revision <> v_member.campaign_discovery_revision
        or v_opportunity.material_revision <> v_member.campaign_material_revision then
        v_reason := 'freshness_changed'; exit gate;
      end if;
      select * into v_timezone from public.deal_hunter_opportunity_timezone_revisions
        where opportunity_id = v_member.opportunity_id order by revision desc limit 1 for share;
      if not found or v_timezone.revision <> v_member.campaign_timezone_revision
        or v_timezone.state not in ('verified','derived') then
        v_reason := 'timezone_changed'; exit gate;
      end if;
      if v_timezone.iana_timezone is null then
        v_reason := 'outside_send_window'; exit gate;
      end if;
      begin
        v_local := v_now at time zone v_timezone.iana_timezone;
      exception when invalid_parameter_value then
        v_reason := 'outside_send_window'; exit gate;
      end;
      if extract(isodow from v_local) in (6,7)
        or v_local::time < time '08:00'
        or v_local::time >= time '17:00' then
        v_reason := 'outside_send_window'; exit gate;
      end if;
      select * into v_owner from public.contact_submissions
        where id = v_member.crm_submission_id for share;
      if not found or v_owner.archived_at is not null
        or v_owner.deal_hunter_opportunity_id <> v_member.opportunity_id then
        v_reason := 'crm_owner_changed'; exit gate;
      end if;
      if v_member.local_expiry_at is not null and v_member.local_expiry_at <= v_now then
        v_reason := 'expired'; exit gate;
      end if;
    end loop;
    if v_count = 0 then
      v_reason := 'terminal_authority_changed'; exit gate;
    end if;
    if exists (select 1 from public.email_suppressions
      where normalized_email = pg_catalog.lower(v_conversation.recipient_address)
        and lifted_at is null) then
      v_reason := 'recipient_suppressed'; exit gate;
    end if;
    select * into v_communication from public.crm_communications
      where id = v_transmission.communication_id for update;
    if not found or v_communication.outbox_id <> v_transmission.outbox_id
      or v_communication.delivery_state <> 'not-attempted' then
      v_reason := 'communication_changed'; exit gate;
    end if;
    select * into v_outbox from public.crm_email_outbox
      where id = v_transmission.outbox_id for update;
    if not found or v_outbox.communication_id <> v_transmission.communication_id
      or v_outbox.state <> 'prepared' or v_outbox.attempt_count <> 0 then
      v_reason := 'outbox_changed'; exit gate;
    end if;
    v_payload_digest := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-payload:v1'::text),
      pg_catalog.to_jsonb(v_communication.from_address),
      v_communication.to_addresses, v_communication.cc_addresses,
      v_communication.bcc_addresses,
      pg_catalog.to_jsonb(v_communication.reply_to_address),
      pg_catalog.to_jsonb(v_communication.subject),
      pg_catalog.to_jsonb(v_communication.body_text),
      pg_catalog.to_jsonb(v_communication.body_html_sanitized),
      v_communication.metadata -> 'tags',
      pg_catalog.to_jsonb(v_member_ids), pg_catalog.to_jsonb(v_templates),
      pg_catalog.to_jsonb(v_transmission.payload_version));
    if v_payload_digest <> v_transmission.payload_digest then
      v_reason := 'payload_changed'; exit gate;
    end if;
  end gate;
  if v_reason is not null then
    return pg_catalog.jsonb_build_object('authorized', false,
      'blockedReason', v_reason, 'transmission',
      case when v_transmission.id is null then null else pg_catalog.to_jsonb(v_transmission) end,
      'boundaryNonceDigest', null);
  end if;
  update public.deal_hunter_cim_transmissions
    set state = 'provider-pending', release_state = 'authorized',
      final_gate_authority_digest = v_gate_digest,
      campaign_terminal_revision = v_expected_campaign,
      conversation_terminal_revision = v_expected_conversation,
      invocation_authority_count = 1,
      provider_invocation_authorized_at = v_now,
      boundary_nonce_digest = v_nonce_digest,
      row_version = row_version + 1, updated_at = v_now
    where id = v_transmission_id and state = 'prepared'
      and invocation_authority_count = 0 and row_version = v_expected_row
    returning * into v_transmission;
  if not found then
    raise exception 'Concurrent Pursue CIM provider-pending transition';
  end if;
  update public.deal_hunter_cim_campaign_touches
    set state = 'provider-pending', row_version = row_version + 1, updated_at = v_now
    where id = any(v_member_ids) and state = 'claimed'
      and transmission_id = v_transmission_id;
  if not found then
    raise exception 'Concurrent Pursue CIM member transition';
  end if;
  update public.deal_hunter_cim_live_provider_authorizations
    set consumed_at = v_now where id = v_authorization_id
      and consumed_at is null and withdrawn_at is null;
  if not found then
    raise exception 'Concurrent Pursue CIM authorization consumption';
  end if;
  update public.crm_communications
    set delivery_state = 'provider-pending', delivery_state_at = v_now,
      updated_at = v_now where id = v_transmission.communication_id;
  update public.crm_email_outbox
    set state = 'provider-pending', updated_at = v_now
    where id = v_transmission.outbox_id;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, conversation_id, transmission_id, authority_digest,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('final-gate-authorized'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'final-gate-authorized', v_transmission.conversation_id,
    v_transmission_id, v_gate_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, conversation_id, transmission_id, prior_state, next_state,
     authority_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('provider-pending'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'provider-pending', v_transmission.conversation_id, v_transmission_id,
    'prepared', 'provider-pending', v_gate_digest, v_actor,
    'sqlite-transition', v_now, '{}'::jsonb);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, authorization_id, prior_state, next_state,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('live-authorization-consumed'::text),
      pg_catalog.to_jsonb(v_authorization_id)),
    'live-authorization-consumed', v_transmission_id, v_authorization_id,
    'issued', 'consumed', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('authorized', true, 'blockedReason', null,
    'transmission', pg_catalog.to_jsonb(v_transmission),
    'boundaryNonceDigest', v_nonce_digest);
end;
$$;

revoke all on function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_enter_provider_seam_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_authorization_id text;
  v_writer_path text;
  v_provider_profile text;
  v_nonce_digest text;
  v_expected bigint;
  v_actor text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_pause boolean;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_authorization_id := public.pursue_cim_required_text_v1(p_command, 'authorizationId', 240);
  v_writer_path := public.pursue_cim_required_text_v1(p_command, 'writerPath', 240);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_nonce_digest := public.pursue_cim_required_text_v1(p_command, 'boundaryNonceDigest', 64);
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if v_nonce_digest !~ '^[0-9a-f]{64}$' or p_command ->> 'now' is null then
    raise exception 'Invalid Pursue CIM provider seam command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_transmission_id for update;
  select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
    where id = v_authorization_id for share;
  if v_transmission.state is distinct from 'provider-pending'
    or v_transmission.invocation_authority_count is distinct from 1
    or v_transmission.boundary_nonce_digest is distinct from v_nonce_digest
    or v_authorization.transmission_id is distinct from v_transmission_id
    or v_authorization.writer_path is distinct from v_writer_path
    or v_authorization.provider_profile is distinct from v_provider_profile
    or v_authorization.consumed_at is null
    or v_authorization.withdrawn_at is not null
    or public.pursue_cim_current_activation_v1(v_authorization.capability, v_now)
      is distinct from v_authorization.activation_id
  then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;
  if v_transmission.provider_seam_entered_at is not null then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', true, 'unauthorized', false);
  end if;
  select outreach_paused into v_pause from public.deal_hunter_cim_safety_settings
    where id = 'global' for share;
  if not found or v_pause is distinct from false
    or v_transmission.row_version <> v_expected then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;
  update public.deal_hunter_cim_transmissions
    set provider_seam_entered_at = v_now, updated_at = v_now,
      row_version = row_version + 1
    where id = v_transmission_id and state = 'provider-pending'
      and provider_seam_entered_at is null
      and boundary_nonce_digest = v_nonce_digest and row_version = v_expected;
  if not found then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, authorization_id, next_state,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('provider-seam-entered'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'provider-seam-entered', v_transmission_id, v_authorization_id,
    'entered', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('entered', true,
    'alreadyEntered', false, 'unauthorized', false);
end;
$$;

revoke all on function public.pursue_cim_enter_provider_seam_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_enter_provider_seam_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_finalize_transmission_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_expected bigint;
  v_outcome text;
  v_provider text;
  v_message_id text := p_command ->> 'providerMessageId';
  v_result_code text;
  v_actor text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_next_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_member record;
  v_member_count integer;
  v_advance_state text;
  v_delivery_state text;
  v_next jsonb := p_command -> 'nextTouch';
  v_next_id text;
  v_expiry timestamptz;
  v_expiry_derivation jsonb;
  v_existing boolean;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array[]::text[], array[]::text[], array['providerMessageId']);
  v_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_outcome := public.pursue_cim_required_text_v1(p_command, 'outcome', 40);
  v_provider := public.pursue_cim_required_text_v1(p_command, 'provider', 80);
  v_result_code := public.pursue_cim_required_text_v1(p_command, 'providerResultCode', 160);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if v_outcome not in ('accepted','definitive-failure','ambiguous')
    or (v_outcome = 'accepted' and
      (v_message_id is null or pg_catalog.length(v_message_id) not between 1 and 240
        or pg_catalog.btrim(v_message_id) <> v_message_id))
    or (v_message_id is not null and
      (pg_catalog.length(v_message_id) not between 1 and 240
        or pg_catalog.btrim(v_message_id) <> v_message_id))
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM finalization command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'conflict', true, 'transmission', null, 'nextTouch', null);
  end if;
  if v_transmission.state in ('accepted','definitive-failure','ambiguous') then
    v_existing := v_transmission.state = v_outcome
      and v_transmission.provider = v_provider
      and v_transmission.provider_message_id is not distinct from v_message_id
      and v_transmission.provider_result_code = v_result_code;
    if v_existing then
      select t.* into v_next_touch from public.deal_hunter_cim_campaign_touches as t
        where t.campaign_id in (
          select campaign_id from public.deal_hunter_cim_transmission_touches
            where transmission_id = v_id
        ) and t.ordinal = 1 order by t.id limit 1;
    end if;
    return pg_catalog.jsonb_build_object('applied', false, 'existing', v_existing,
      'conflict', not v_existing, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'nextTouch', case when v_next_touch.id is null then null
        else pg_catalog.to_jsonb(v_next_touch) end);
  end if;
  if v_transmission.state <> 'provider-pending'
    or v_transmission.row_version <> v_expected
    or v_transmission.invocation_authority_count <> 1
    or v_transmission.provider_seam_entered_at is null
  then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'conflict', true, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'nextTouch', null);
  end if;
  select count(*) into v_member_count from public.deal_hunter_cim_transmission_touches
    where transmission_id = v_id and cancelled_at is null;
  if v_member_count = 0 or exists (
    select 1 from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      where m.transmission_id = v_id and m.cancelled_at is null
        and t.state <> 'provider-pending')
  then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'conflict', true, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'nextTouch', null);
  end if;
  if v_outcome = 'accepted' and v_member_count = 1 and exists (
    select 1 from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
    join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
    where m.transmission_id = v_id and m.cancelled_at is null
      and c.state = 'initial-pending'
      and c.terminal_revision = v_transmission.campaign_terminal_revision
  ) then
    if v_next is null or pg_catalog.jsonb_typeof(v_next) <> 'object'
      or public.pursue_cim_required_text_v1(v_next, 'logicalSlot', 160) <> 'follow-up-1'
      or public.pursue_cim_required_text_v1(v_next, 'kind', 40) <> 'follow-up-1'
      or public.pursue_cim_required_revision_v1(v_next, 'ordinal') <> 1
      or v_next ->> 'dueAt' is null
      or p_command ->> 'localExpiryAt' is null
      or p_command -> 'expiryDerivation' is null
      or pg_catalog.length(public.pursue_cim_json_stringify_v1(
        p_command -> 'expiryDerivation')) > 1000
    then
      raise exception 'Accepted Pursue CIM initial finalization requires next slot';
    end if;
    perform public.pursue_cim_required_text_v1(v_next, 'dueLocal', 120);
    perform public.pursue_cim_required_text_v1(v_next, 'cadencePolicyVersion', 120);
    v_expiry := public.pursue_cim_required_instant_v1(p_command, 'localExpiryAt');
    v_expiry_derivation := p_command -> 'expiryDerivation';
  end if;
  update public.deal_hunter_cim_transmissions
    set state = v_outcome, provider = v_provider,
      provider_message_id = v_message_id, provider_result_code = v_result_code,
      row_version = row_version + 1, updated_at = v_now
    where id = v_id and state = 'provider-pending' and row_version = v_expected
    returning * into v_transmission;
  if not found then
    raise exception 'Concurrent Pursue CIM transmission finalization';
  end if;
  v_advance_state := case v_outcome
    when 'accepted' then 'active-follow-up'
    when 'definitive-failure' then 'action-required'
    else 'provider-ambiguous' end;
  for v_member in
    select t.*, c.state as campaign_state,
      c.terminal_revision as campaign_terminal_revision,
      c.row_version as campaign_row_version,
      c.timezone_revision as campaign_timezone_revision,
      c.conversation_id as campaign_conversation_id
    from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
    join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
    where m.transmission_id = v_id and m.cancelled_at is null
    order by t.id for update of m,t,c
  loop
    update public.deal_hunter_cim_campaign_touches
      set state = v_outcome, outcome_code = v_result_code,
        row_version = row_version + 1, updated_at = v_now
      where id = v_member.id and state = 'provider-pending'
        and row_version = v_member.row_version;
    if not found then
      raise exception 'Concurrent Pursue CIM touch finalization';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
       transmission_id, prior_state, next_state, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('touch-finalized'::text),
        pg_catalog.to_jsonb(v_member.id || ':' || (v_member.row_version + 1)::text)),
      'touch-finalized', v_member.opportunity_id, v_member.campaign_id,
      v_member.campaign_conversation_id, v_member.id, v_id,
      'provider-pending', v_outcome, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    if v_member.campaign_terminal_revision <> v_transmission.campaign_terminal_revision
      or v_member.campaign_state not in ('initial-pending','active-follow-up') then
      continue;
    end if;
    update public.deal_hunter_cim_campaigns
      set state = v_advance_state,
        reason_code = case v_outcome
          when 'definitive-failure' then 'provider_definitive_failure'
          when 'ambiguous' then 'provider_ambiguous' else null end,
        initial_accepted_at = coalesce(initial_accepted_at,
          case when v_outcome = 'accepted' then v_now else null end),
        local_expiry_at = coalesce(local_expiry_at,
          case when v_outcome = 'accepted' then v_expiry else null end),
        expiry_derivation = case when initial_accepted_at is null and v_outcome = 'accepted'
          then coalesce(v_expiry_derivation, '{}'::jsonb) else expiry_derivation end,
        row_version = row_version + 1, updated_at = v_now
      where id = v_member.campaign_id and row_version = v_member.campaign_row_version
        and terminal_revision = v_member.campaign_terminal_revision;
    if not found then
      raise exception 'Concurrent Pursue CIM campaign finalization';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
       actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('campaign-transition'::text),
        pg_catalog.to_jsonb(v_member.campaign_id || ':' ||
          (v_member.campaign_row_version + 1)::text)),
      'campaign-transition', v_member.opportunity_id, v_member.campaign_id,
      v_member.campaign_state, v_advance_state,
      v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    if v_outcome = 'accepted' and v_member.kind = 'initial' then
      v_next_id := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-touch:v1'::text),
        pg_catalog.to_jsonb(v_member.campaign_id),
        pg_catalog.to_jsonb(v_next ->> 'logicalSlot'),
        pg_catalog.to_jsonb(v_next ->> 'cadencePolicyVersion'));
      insert into public.deal_hunter_cim_campaign_touches
        (id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
         due_at, due_local, timezone_revision, state, created_at, updated_at)
      values (v_next_id, v_member.campaign_id, v_member.opportunity_id,
        v_next ->> 'logicalSlot', v_next ->> 'kind',
        1, public.pursue_cim_required_instant_v1(v_next, 'dueAt'), v_next ->> 'dueLocal',
        v_member.campaign_timezone_revision, 'scheduled', v_now, v_now)
      returning * into v_next_touch;
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, touch_id, next_state,
         actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('touch-created'::text), pg_catalog.to_jsonb(v_next_id)),
        'touch-created', v_member.opportunity_id, v_member.campaign_id,
        v_next_id, 'scheduled', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    end if;
  end loop;
  v_delivery_state := case when v_outcome = 'definitive-failure'
    then 'failed' else v_outcome end;
  update public.crm_communications
    set provider = v_provider, provider_message_id = v_message_id,
      delivery_state = v_delivery_state, delivery_state_at = v_now,
      updated_at = v_now where id = v_transmission.communication_id;
  update public.crm_email_outbox
    set provider = v_provider, provider_message_id = v_message_id,
      state = v_delivery_state, attempt_count = 1, updated_at = v_now
    where id = v_transmission.outbox_id;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, conversation_id, transmission_id, prior_state,
     next_state, payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-finalized'::text), pg_catalog.to_jsonb(v_id)),
    'transmission-finalized', v_transmission.conversation_id, v_id,
    'provider-pending', v_outcome, v_transmission.payload_digest,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'existing', false,
    'conflict', false, 'transmission', pg_catalog.to_jsonb(v_transmission),
    'nextTouch', case when v_next_touch.id is null then null
      else pg_catalog.to_jsonb(v_next_touch) end);
end;
$$;

revoke all on function public.pursue_cim_finalize_transmission_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_finalize_transmission_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_reconcile_transmission_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_expected bigint;
  v_outcome text;
  v_provider text;
  v_message_id text := p_command ->> 'providerMessageId';
  v_result_code text;
  v_evidence_type text;
  v_evidence_id text;
  v_evidence_digest text;
  v_actor text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_member_count integer;
  v_should_advance boolean;
  v_next jsonb := p_command -> 'nextTouch';
  v_expiry timestamptz;
  v_expiry_derivation jsonb;
  v_next_id text;
  v_unchanged boolean;
  v_delivery_state text;
  v_prior_state text;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array[]::text[], array[]::text[], array['providerMessageId']);
  v_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_outcome := public.pursue_cim_required_text_v1(p_command, 'outcome', 40);
  v_provider := public.pursue_cim_required_text_v1(p_command, 'provider', 80);
  v_result_code := public.pursue_cim_required_text_v1(p_command, 'providerResultCode', 160);
  v_evidence_type := public.pursue_cim_required_text_v1(p_command, 'evidenceType', 120);
  v_evidence_id := public.pursue_cim_required_text_v1(p_command, 'evidenceId', 240);
  v_evidence_digest := public.pursue_cim_required_text_v1(p_command, 'evidenceDigest', 64);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if v_outcome not in ('accepted','definitive-failure')
    or v_evidence_digest !~ '^[0-9a-f]{64}$'
    or (v_outcome = 'accepted' and
      (v_message_id is null or pg_catalog.length(v_message_id) not between 1 and 240
        or pg_catalog.btrim(v_message_id) <> v_message_id))
    or p_command ->> 'now' is null then
    raise exception 'Invalid Pursue CIM reconciliation command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'unchanged', false,
      'conflict', true, 'transmission', null);
  end if;
  if v_transmission.state in ('accepted','definitive-failure') then
    v_unchanged := v_transmission.state = v_outcome
      and v_transmission.provider = v_provider
      and v_transmission.provider_message_id is not distinct from v_message_id
      and v_transmission.provider_result_code = v_result_code;
    return pg_catalog.jsonb_build_object('applied', false, 'unchanged', v_unchanged,
      'conflict', not v_unchanged, 'transmission', pg_catalog.to_jsonb(v_transmission));
  end if;
  if v_transmission.state not in ('provider-pending','ambiguous')
    or v_transmission.row_version <> v_expected
    or v_transmission.invocation_authority_count <> 1
    or (v_transmission.provider is not null and v_transmission.provider <> v_provider)
  then
    return pg_catalog.jsonb_build_object('applied', false, 'unchanged', false,
      'conflict', true, 'transmission', pg_catalog.to_jsonb(v_transmission));
  end if;
  v_prior_state := v_transmission.state;
  select count(*) into v_member_count from public.deal_hunter_cim_transmission_touches
    where transmission_id = v_id and cancelled_at is null;
  if v_member_count = 0 or exists (
    select 1 from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      where m.transmission_id = v_id and m.cancelled_at is null
        and t.state not in ('provider-pending','ambiguous'))
  then
    return pg_catalog.jsonb_build_object('applied', false, 'unchanged', false,
      'conflict', true, 'transmission', pg_catalog.to_jsonb(v_transmission));
  end if;
  select v_member_count = 1 and exists (
    select 1 from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
      where m.transmission_id = v_id and m.cancelled_at is null
        and c.terminal_revision = v_transmission.campaign_terminal_revision
        and c.state in ('provider-ambiguous','initial-pending','active-follow-up')
  ) into v_should_advance;
  if v_should_advance and v_outcome = 'accepted' and exists (
    select 1 from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      where m.transmission_id = v_id and m.cancelled_at is null and t.kind = 'initial'
  ) then
    if v_next is null or pg_catalog.jsonb_typeof(v_next) <> 'object'
      or public.pursue_cim_required_text_v1(v_next, 'logicalSlot', 160) <> 'follow-up-1'
      or public.pursue_cim_required_text_v1(v_next, 'kind', 40) <> 'follow-up-1'
      or public.pursue_cim_required_revision_v1(v_next, 'ordinal') <> 1
      or v_next ->> 'dueAt' is null
      or p_command ->> 'localExpiryAt' is null
      or p_command -> 'expiryDerivation' is null
      or pg_catalog.length(public.pursue_cim_json_stringify_v1(
        p_command -> 'expiryDerivation')) > 1000
    then
      raise exception 'Accepted Pursue CIM reconciliation requires next slot';
    end if;
    perform public.pursue_cim_required_text_v1(v_next, 'dueLocal', 120);
    perform public.pursue_cim_required_text_v1(v_next, 'cadencePolicyVersion', 120);
    v_expiry := public.pursue_cim_required_instant_v1(p_command, 'localExpiryAt');
    v_expiry_derivation := p_command -> 'expiryDerivation';
  end if;
  update public.deal_hunter_cim_transmissions
    set state = v_outcome, provider = v_provider,
      provider_message_id = v_message_id, provider_result_code = v_result_code,
      updated_at = v_now, row_version = row_version + 1
    where id = v_id and row_version = v_expected
      and state in ('provider-pending','ambiguous')
    returning * into v_transmission;
  if not found then
    raise exception 'Concurrent Pursue CIM transmission reconciliation';
  end if;
  for v_member in
    select t.*, c.state as campaign_state,
      c.terminal_revision as campaign_terminal_revision,
      c.row_version as campaign_row_version,
      c.timezone_revision as campaign_timezone_revision
    from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
    join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
    where m.transmission_id = v_id and m.cancelled_at is null
    order by t.id for update of m,t,c
  loop
    update public.deal_hunter_cim_campaign_touches
      set state = v_outcome, outcome_code = v_result_code,
        updated_at = v_now, row_version = row_version + 1
      where id = v_member.id and row_version = v_member.row_version
        and state in ('provider-pending','ambiguous');
    if not found then
      raise exception 'Concurrent Pursue CIM touch reconciliation';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, touch_id, transmission_id,
       prior_state, next_state, authority_digest, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('touch-reconciled'::text),
        pg_catalog.to_jsonb(v_member.id || ':' || (v_member.row_version + 1)::text)),
      'touch-reconciled', v_member.opportunity_id, v_member.campaign_id,
      v_member.id, v_id, v_member.state, v_outcome, v_evidence_digest,
      v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    if v_should_advance then
      update public.deal_hunter_cim_campaigns
        set state = case when v_outcome = 'accepted' then 'active-follow-up'
          else 'action-required' end,
          reason_code = case when v_outcome = 'definitive-failure'
            then 'provider_definitive_failure' else null end,
          initial_accepted_at = coalesce(initial_accepted_at,
            case when v_outcome = 'accepted' then v_now else null end),
          local_expiry_at = coalesce(local_expiry_at,
            case when v_outcome = 'accepted' then v_expiry else null end),
          expiry_derivation = case when initial_accepted_at is null and v_outcome = 'accepted'
            then coalesce(v_expiry_derivation, '{}'::jsonb) else expiry_derivation end,
          updated_at = v_now, row_version = row_version + 1
        where id = v_member.campaign_id and row_version = v_member.campaign_row_version
          and terminal_revision = v_member.campaign_terminal_revision;
      if not found then
        raise exception 'Concurrent Pursue CIM campaign reconciliation';
      end if;
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
         authority_digest, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('campaign-transition'::text),
          pg_catalog.to_jsonb(v_member.campaign_id || ':' ||
            (v_member.campaign_row_version + 1)::text)),
        'campaign-transition', v_member.opportunity_id, v_member.campaign_id,
        v_member.campaign_state,
        case when v_outcome = 'accepted' then 'active-follow-up' else 'action-required' end,
        v_evidence_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
      if v_outcome = 'accepted' and v_member.kind = 'initial' then
        v_next_id := public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-touch:v1'::text),
          pg_catalog.to_jsonb(v_member.campaign_id),
          pg_catalog.to_jsonb(v_next ->> 'logicalSlot'),
          pg_catalog.to_jsonb(v_next ->> 'cadencePolicyVersion'));
        insert into public.deal_hunter_cim_campaign_touches
          (id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
           due_at, due_local, timezone_revision, state, created_at, updated_at)
        values (v_next_id, v_member.campaign_id, v_member.opportunity_id,
          v_next ->> 'logicalSlot', v_next ->> 'kind',
          1, public.pursue_cim_required_instant_v1(v_next, 'dueAt'), v_next ->> 'dueLocal',
          v_member.campaign_timezone_revision, 'scheduled', v_now, v_now);
        insert into public.deal_hunter_cim_audit_events
          (id, event_type, opportunity_id, campaign_id, touch_id, next_state,
           actor, source, occurred_at, metadata)
        values (public.pursue_cim_digest_v1(
            pg_catalog.to_jsonb('cim-audit:v1'::text),
            pg_catalog.to_jsonb('touch-created'::text), pg_catalog.to_jsonb(v_next_id)),
          'touch-created', v_member.opportunity_id, v_member.campaign_id,
          v_next_id, 'scheduled', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
      end if;
    end if;
  end loop;
  v_delivery_state := case when v_outcome = 'definitive-failure'
    then 'failed' else 'accepted' end;
  update public.crm_communications
    set provider = v_provider, provider_message_id = v_message_id,
      delivery_state = v_delivery_state, delivery_state_at = v_now,
      updated_at = v_now where id = v_transmission.communication_id;
  update public.crm_email_outbox
    set provider = v_provider, provider_message_id = v_message_id,
      state = v_delivery_state, attempt_count = 1, updated_at = v_now
    where id = v_transmission.outbox_id;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, conversation_id, transmission_id, prior_state, next_state,
     authority_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-reconciled'::text),
      pg_catalog.to_jsonb(v_id || ':' || v_evidence_type || ':' || v_evidence_id)),
    'transmission-reconciled', v_transmission.conversation_id, v_id,
    v_prior_state, v_outcome, v_evidence_digest, v_actor, v_evidence_type,
    v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'unchanged', false,
    'conflict', false, 'transmission', pg_catalog.to_jsonb(v_transmission));
end;
$$;

revoke all on function public.pursue_cim_reconcile_transmission_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_reconcile_transmission_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_withdraw_live_authorization_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_actor text;
  v_reason text;
  v_now timestamptz;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
begin
  v_id := public.pursue_cim_required_text_v1(p_command, 'id', 240);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_reason := public.pursue_cim_required_text_v1(p_command, 'reason', 160);
  if p_command ->> 'now' is null then
    raise exception 'Invalid Pursue CIM authorization withdrawal';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
    where id = v_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'authorization', null);
  end if;
  if v_authorization.withdrawn_at is not null then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', true,
      'conflict', false, 'authorization', pg_catalog.to_jsonb(v_authorization));
  end if;
  if v_authorization.consumed_at is not null or v_authorization.expires_at <= v_now
    or not public.pursue_cim_cancel_prepared_transmission_v1(
      v_authorization.transmission_id, v_now, v_reason, v_actor, false)
  then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'authorization', pg_catalog.to_jsonb(v_authorization));
  end if;
  select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
    where id = v_id;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'authorization', pg_catalog.to_jsonb(v_authorization));
end;
$$;

revoke all on function public.pursue_cim_withdraw_live_authorization_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_withdraw_live_authorization_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_append_terminal_event_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id text;
  v_scope text;
  v_scope_id text;
  v_expected_revision bigint;
  v_expected_row bigint;
  v_next_state text;
  v_reason text;
  v_evidence_type text;
  v_evidence_id text;
  v_metadata_digest text;
  v_actor text;
  v_source text;
  v_observed timestamptz;
  v_now timestamptz;
  v_existing public.deal_hunter_cim_terminal_events%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_current_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_member record;
  v_campaign_id text;
  v_campaign_ids text[];
  v_cancelled text[] := array[]::text[];
  v_campaign_event_id text;
  v_campaign_next text;
  v_legal boolean := false;
  v_replay boolean;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array[]::text[], array[]::text[], array['reconciliationEvidenceId']);
  if p_command ? 'preProviderResolution'
    and pg_catalog.jsonb_typeof(p_command -> 'preProviderResolution')
      not in ('boolean','null') then
    raise exception 'Invalid Pursue CIM pre-provider resolution flag';
  end if;
  v_event_id := public.pursue_cim_required_text_v1(p_command, 'eventId', 240);
  v_scope := public.pursue_cim_required_text_v1(p_command, 'scope', 20);
  v_scope_id := public.pursue_cim_required_text_v1(p_command, 'scopeId', 240);
  v_expected_revision := public.pursue_cim_required_revision_v1(p_command, 'expectedRevision');
  v_expected_row := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_next_state := public.pursue_cim_required_text_v1(p_command, 'nextState', 120);
  v_reason := public.pursue_cim_required_text_v1(p_command, 'reasonCode', 160);
  v_evidence_type := public.pursue_cim_required_text_v1(p_command, 'evidenceType', 120);
  v_evidence_id := public.pursue_cim_required_text_v1(p_command, 'evidenceId', 240);
  v_metadata_digest := public.pursue_cim_required_text_v1(p_command, 'metadataDigest', 64);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_source := public.pursue_cim_required_text_v1(p_command, 'source', 120);
  if v_scope not in ('campaign','conversation')
    or v_metadata_digest !~ '^[0-9a-f]{64}$'
    or p_command ->> 'observedAt' is null or p_command ->> 'now' is null then
    raise exception 'Invalid Pursue CIM terminal command';
  end if;
  v_observed := public.pursue_cim_required_instant_v1(p_command, 'observedAt');
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:terminal-id:' || v_event_id, 0));
  select * into v_existing from public.deal_hunter_cim_terminal_events
    where id = v_event_id;
  if found then
    v_replay := v_existing.scope = v_scope and v_existing.scope_id = v_scope_id
      and v_existing.reason_code = v_reason
      and v_existing.evidence_type = v_evidence_type
      and v_existing.evidence_id = v_evidence_id
      and v_existing.metadata_digest = v_metadata_digest;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', v_replay,
      'conflict', not v_replay,
      'campaignRevision', case when v_scope = 'campaign' then v_existing.revision else null end,
      'conversationRevision', case when v_scope = 'conversation' then v_existing.revision else null end,
      'cancelledTouchIds', '[]'::jsonb);
  end if;
  if v_scope = 'campaign' then
    select * into v_current_campaign from public.deal_hunter_cim_campaigns
      where id = v_scope_id for update;
    v_legal := case v_current_campaign.state
      when 'queued' then v_next_state in
        ('waiting-on-eligibility','initial-pending','action-required','stopped')
      when 'waiting-on-eligibility' then v_next_state in
        ('queued','initial-pending','action-required','stopped')
      when 'initial-pending' then v_next_state in
        ('active-follow-up','action-required','responded','materials-received',
         'stopped','provider-ambiguous')
      when 'active-follow-up' then v_next_state in
        ('active-follow-up','action-required','responded','materials-received',
         'stopped','expired','provider-ambiguous')
      when 'action-required' then v_next_state in
        ('queued','waiting-on-eligibility','initial-pending','responded',
         'materials-received','stopped')
      else false end;
    if v_current_campaign.id is null
      or v_current_campaign.terminal_revision <> v_expected_revision
      or v_current_campaign.row_version <> v_expected_row
      or not coalesce(v_legal,false)
      or (v_current_campaign.state = 'provider-ambiguous'
        and p_command ->> 'reconciliationEvidenceId' is null)
      or (v_current_campaign.state = 'action-required'
        and v_next_state in ('queued','waiting-on-eligibility','initial-pending')
        and coalesce((p_command ->> 'preProviderResolution')::boolean,false) = false)
    then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true,
        'campaignRevision', v_current_campaign.terminal_revision,
        'conversationRevision', null, 'cancelledTouchIds', '[]'::jsonb);
    end if;
    v_campaign_ids := array[v_scope_id];
  else
    select * into v_conversation from public.deal_hunter_broker_conversations
      where id = v_scope_id for update;
    v_legal := case v_conversation.state
      when 'open' then v_next_state in
        ('reply-review-required','responded','stopped','provider-ambiguous','closed')
      when 'reply-review-required' then v_next_state in ('responded','stopped','open')
      else false end;
    if v_conversation.id is null
      or v_conversation.terminal_revision <> v_expected_revision
      or v_conversation.row_version <> v_expected_row
      or not coalesce(v_legal,false)
      or (v_conversation.state = 'provider-ambiguous'
        and p_command ->> 'reconciliationEvidenceId' is null)
    then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'campaignRevision', null,
        'conversationRevision', v_conversation.terminal_revision,
        'cancelledTouchIds', '[]'::jsonb);
    end if;
    select coalesce(pg_catalog.array_agg(id order by id), array[]::text[])
      into v_campaign_ids from public.deal_hunter_cim_campaigns
      where conversation_id = v_scope_id
        and state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous');
  end if;
  foreach v_campaign_id in array v_campaign_ids loop
    select * into v_campaign from public.deal_hunter_cim_campaigns
      where id = v_campaign_id for update;
    for v_transmission in
      select tr.* from public.deal_hunter_cim_transmissions as tr
      where tr.id in (
        select m.transmission_id from public.deal_hunter_cim_transmission_touches as m
        where m.campaign_id = v_campaign_id and m.cancelled_at is null)
        and tr.state in ('prepared','final-gate-blocked')
      order by tr.id for update
    loop
      if public.pursue_cim_cancel_prepared_transmission_v1(
        v_transmission.id, v_now, v_reason, v_actor, false) then
        for v_member in
          select touch_id from public.deal_hunter_cim_transmission_touches
            where transmission_id = v_transmission.id and cancelled_at = v_now
            order by touch_id
        loop
          v_cancelled := pg_catalog.array_append(v_cancelled, v_member.touch_id);
        end loop;
      end if;
    end loop;
    for v_touch in
      select * from public.deal_hunter_cim_campaign_touches
      where campaign_id = v_campaign_id and state in ('scheduled','claimed')
        and transmission_id is null order by id for update
    loop
      update public.deal_hunter_cim_campaign_touches
        set state = 'cancelled-before-provider', terminal_reason = v_reason,
          updated_at = v_now, row_version = row_version + 1
        where id = v_touch.id and row_version = v_touch.row_version;
      if not found then raise exception 'Concurrent Pursue CIM touch terminalization'; end if;
      v_cancelled := pg_catalog.array_append(v_cancelled, v_touch.id);
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, touch_id, prior_state,
         next_state, reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('touch-cancelled'::text),
          pg_catalog.to_jsonb(v_touch.id || ':' || (v_touch.row_version + 1)::text)),
        'touch-cancelled', v_touch.opportunity_id, v_campaign_id, v_touch.id,
        v_touch.state, 'cancelled-before-provider', v_reason, v_actor,
        v_source, v_now, '{}'::jsonb);
    end loop;
    if v_scope = 'conversation' then
      v_campaign_next := case v_next_state
        when 'responded' then 'responded'
        when 'reply-review-required' then 'action-required'
        when 'provider-ambiguous' then 'provider-ambiguous'
        else 'stopped' end;
      v_legal := case v_campaign.state
        when 'queued' then v_campaign_next in
          ('waiting-on-eligibility','initial-pending','action-required','stopped')
        when 'waiting-on-eligibility' then v_campaign_next in
          ('queued','initial-pending','action-required','stopped')
        when 'initial-pending' then v_campaign_next in
          ('active-follow-up','action-required','responded','materials-received',
           'stopped','provider-ambiguous')
        when 'active-follow-up' then v_campaign_next in
          ('active-follow-up','action-required','responded','materials-received',
           'stopped','expired','provider-ambiguous')
        when 'action-required' then v_campaign_next in
          ('queued','waiting-on-eligibility','initial-pending','responded',
           'materials-received','stopped')
        else false end;
      if not coalesce(v_legal,false) then
        v_campaign_next := case v_campaign.state
          when 'queued' then 'action-required'
          when 'waiting-on-eligibility' then 'action-required'
          when 'initial-pending' then 'action-required'
          when 'active-follow-up' then 'action-required'
          else v_campaign.state end;
      end if;
      update public.deal_hunter_cim_campaigns
        set state = v_campaign_next, reason_code = v_reason,
          terminal_revision = terminal_revision + 1, row_version = row_version + 1,
          updated_at = v_now
        where id = v_campaign_id and row_version = v_campaign.row_version
          and terminal_revision = v_campaign.terminal_revision;
      if not found then raise exception 'Concurrent Pursue CIM campaign terminalization'; end if;
      v_campaign_event_id := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('conversation-campaign-terminal:v1'::text),
        pg_catalog.to_jsonb(v_event_id), pg_catalog.to_jsonb(v_campaign_id));
      insert into public.deal_hunter_cim_terminal_events
        (id, scope, scope_id, campaign_id, revision, reason_code,
         evidence_type, evidence_id, observed_at, actor, source,
         metadata_digest, created_at)
      values (v_campaign_event_id, 'campaign', v_campaign_id, v_campaign_id,
        v_campaign.terminal_revision + 1, v_reason, v_evidence_type,
        v_evidence_id, v_observed, v_actor, v_source, v_metadata_digest, v_now);
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, conversation_id,
         prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('terminal-transition'::text),
          pg_catalog.to_jsonb(v_campaign_event_id)),
        'terminal-transition', v_campaign.opportunity_id, v_campaign_id,
        v_scope_id, v_campaign.state, v_campaign_next, v_reason, v_actor,
        v_source, v_now, '{}'::jsonb);
    end if;
  end loop;
  if v_scope = 'campaign' then
    update public.deal_hunter_cim_campaigns
      set state = v_next_state, reason_code = v_reason,
        terminal_revision = terminal_revision + 1, row_version = row_version + 1,
        updated_at = v_now
      where id = v_scope_id and terminal_revision = v_expected_revision
        and row_version = v_expected_row;
    if not found then raise exception 'Concurrent Pursue CIM campaign terminalization'; end if;
  else
    update public.deal_hunter_broker_conversations
      set state = v_next_state, terminal_revision = terminal_revision + 1,
        row_version = row_version + 1, updated_at = v_now
      where id = v_scope_id and terminal_revision = v_expected_revision
        and row_version = v_expected_row;
    if not found then raise exception 'Concurrent Pursue CIM conversation terminalization'; end if;
  end if;
  insert into public.deal_hunter_cim_terminal_events
    (id, scope, scope_id, campaign_id, conversation_id, revision, reason_code,
     evidence_type, evidence_id, observed_at, actor, source, metadata_digest, created_at)
  values (v_event_id, v_scope, v_scope_id,
    case when v_scope = 'campaign' then v_scope_id else null end,
    case when v_scope = 'conversation' then v_scope_id else null end,
    v_expected_revision + 1, v_reason, v_evidence_type, v_evidence_id,
    v_observed, v_actor, v_source, v_metadata_digest, v_now);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id,
     prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('terminal-transition'::text),
      pg_catalog.to_jsonb(v_event_id)),
    'terminal-transition',
    case when v_scope = 'campaign' then v_current_campaign.opportunity_id else null end,
    case when v_scope = 'campaign' then v_scope_id else null end,
    case when v_scope = 'conversation' then v_scope_id else null end,
    case when v_scope = 'campaign' then v_current_campaign.state else v_conversation.state end,
    v_next_state, v_reason, v_actor, v_source, v_now, '{}'::jsonb);
  select coalesce(pg_catalog.array_agg(value order by value), array[]::text[])
    into v_cancelled from pg_catalog.unnest(v_cancelled) as value;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false,
    'campaignRevision', case when v_scope = 'campaign' then v_expected_revision + 1 else null end,
    'conversationRevision', case when v_scope = 'conversation' then v_expected_revision + 1 else null end,
    'cancelledTouchIds', pg_catalog.to_jsonb(v_cancelled));
end;
$$;

revoke all on function public.pursue_cim_append_terminal_event_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_terminal_event_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_consume_safety_events_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id text;
  v_limit integer;
  v_actor text;
  v_now timestamptz;
  v_event public.deal_hunter_cim_safety_events%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_disposition text;
  v_next_state text;
  v_terminal_id text;
  v_counts record;
begin
  v_run_id := public.pursue_cim_required_text_v1(p_command, 'safetyRunId', 240);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if p_command ->> 'limit' !~ '^[0-9]+$'
    or (p_command ->> 'limit')::numeric not between 1 and 1000
    or p_command ->> 'now' is null then
    raise exception 'Invalid Pursue CIM safety consumption command';
  end if;
  v_limit := (p_command ->> 'limit')::integer;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  for v_event in
    select * from public.deal_hunter_cim_safety_events
      where safety_run_id = v_run_id and status = 'pending'
      order by created_at, id limit v_limit for update
  loop
    select * into v_campaign from public.deal_hunter_cim_campaigns
      where opportunity_id = v_event.opportunity_id
        and state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')
      for update;
    if found then
      v_disposition := p_command -> 'outcomes' ->> v_event.id;
      if v_disposition not in ('stopped','review-required')
        or public.pursue_cim_current_activation_v1('fl04a-safety', v_now) is null then
        continue;
      end if;
      v_next_state := case when v_disposition = 'stopped'
        then 'stopped' else 'action-required' end;
      if not (case v_campaign.state
        when 'queued' then v_next_state in ('waiting-on-eligibility','initial-pending',
          'action-required','stopped')
        when 'waiting-on-eligibility' then v_next_state in ('queued','initial-pending',
          'action-required','stopped')
        when 'initial-pending' then v_next_state in ('active-follow-up','action-required',
          'responded','materials-received','stopped','provider-ambiguous')
        when 'active-follow-up' then v_next_state in ('active-follow-up','action-required',
          'responded','materials-received','stopped','expired','provider-ambiguous')
        when 'action-required' then v_next_state in ('queued','waiting-on-eligibility',
          'initial-pending','responded','materials-received','stopped')
        else false end) then
        continue;
      end if;
      v_terminal_id := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-terminal:safety:v1'::text),
        pg_catalog.to_jsonb(v_event.id), pg_catalog.to_jsonb(v_campaign.id));
      for v_transmission in
        select tr.* from public.deal_hunter_cim_transmissions as tr
        where tr.id in (
          select m.transmission_id from public.deal_hunter_cim_transmission_touches as m
            where m.campaign_id = v_campaign.id and m.cancelled_at is null)
          and tr.state in ('prepared','final-gate-blocked')
        order by tr.id for update
      loop
        perform public.pursue_cim_cancel_prepared_transmission_v1(
          v_transmission.id, v_now, v_event.event_type, v_actor, false);
      end loop;
      for v_touch in
        select * from public.deal_hunter_cim_campaign_touches
          where campaign_id = v_campaign.id and state in ('scheduled','claimed')
            and transmission_id is null order by id for update
      loop
        update public.deal_hunter_cim_campaign_touches
          set state = 'cancelled-before-provider',
            terminal_reason = v_event.event_type, updated_at = v_now,
            row_version = row_version + 1
          where id = v_touch.id and row_version = v_touch.row_version;
        if not found then
          raise exception 'Concurrent Pursue CIM safety touch cancellation';
        end if;
        insert into public.deal_hunter_cim_audit_events
          (id, event_type, opportunity_id, campaign_id, touch_id,
           prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
        values (public.pursue_cim_digest_v1(
            pg_catalog.to_jsonb('cim-audit:v1'::text),
            pg_catalog.to_jsonb('touch-cancelled'::text),
            pg_catalog.to_jsonb(v_touch.id || ':' || (v_touch.row_version + 1)::text)),
          'touch-cancelled', v_event.opportunity_id, v_campaign.id, v_touch.id,
          v_touch.state, 'cancelled-before-provider', v_event.event_type,
          v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
      end loop;
      update public.deal_hunter_cim_campaigns
        set state = v_next_state, reason_code = v_event.event_type,
          terminal_revision = terminal_revision + 1, row_version = row_version + 1,
          updated_at = v_now
        where id = v_campaign.id and row_version = v_campaign.row_version
          and terminal_revision = v_campaign.terminal_revision;
      if not found then raise exception 'Concurrent Pursue CIM safety campaign transition'; end if;
      insert into public.deal_hunter_cim_terminal_events
        (id, scope, scope_id, campaign_id, revision, reason_code,
         evidence_type, evidence_id, observed_at, actor, source,
         metadata_digest, created_at)
      values (v_terminal_id, 'campaign', v_campaign.id, v_campaign.id,
        v_campaign.terminal_revision + 1, v_event.event_type,
        'safety-event', v_event.id, v_now, v_actor, 'safety-consumer',
        public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('safety-terminal:v1'::text),
          pg_catalog.to_jsonb(v_event.id)), v_now);
      update public.deal_hunter_cim_safety_events
        set status = v_disposition, outcome_evidence_id = v_terminal_id,
          outcome_revision = v_campaign.terminal_revision + 1,
          consumed_at = v_now, updated_at = v_now
        where id = v_event.id and status = 'pending';
      if not found then raise exception 'Concurrent Pursue CIM safety consumption'; end if;
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
         reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('terminal-transition'::text),
          pg_catalog.to_jsonb(v_terminal_id)),
        'terminal-transition', v_event.opportunity_id, v_campaign.id,
        v_campaign.state, v_next_state, v_event.event_type,
        v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
         actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('safety-consumed'::text),
          pg_catalog.to_jsonb(v_event.id)),
        'safety-consumed', v_event.opportunity_id, v_campaign.id,
        'pending', v_disposition, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
      continue;
    end if;
    update public.deal_hunter_cim_safety_events
      set status = 'no-op', outcome_evidence_id = v_event.id,
        consumed_at = v_now, updated_at = v_now
      where id = v_event.id and status = 'pending';
    if not found then raise exception 'Concurrent Pursue CIM safety no-op'; end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, prior_state, next_state,
       actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('safety-consumed'::text),
        pg_catalog.to_jsonb(v_event.id)),
      'safety-consumed', v_event.opportunity_id, 'pending', 'no-op',
      v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  end loop;
  select count(*) filter (where status = 'stopped') as stopped,
    count(*) filter (where status = 'review-required') as review_required,
    count(*) filter (where status = 'no-op') as no_op,
    count(*) filter (where status = 'pending') as pending
    into v_counts from public.deal_hunter_cim_safety_events
    where safety_run_id = v_run_id;
  return pg_catalog.jsonb_build_object('stopped', v_counts.stopped,
    'reviewRequired', v_counts.review_required, 'noOp', v_counts.no_op,
    'pending', v_counts.pending);
end;
$$;

revoke all on function public.pursue_cim_consume_safety_events_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_consume_safety_events_v1(jsonb)
  to service_role;
-- Package 2: admitted source commits append inert campaign-safety evidence.
-- This helper is callable only by the owner of the admitted writer functions.
create or replace function public.pursue_cim_emit_admitted_import_safety_v1(
  p_source_id text, p_run_id text, p_opportunity_id text, p_source_record_id text,
  p_event_type text, p_evidence_digest text, p_accepted_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_source_type text;
  v_safety_run_id text;
  v_evidence_id text;
  v_id text;
  v_record_key text;
  v_event_type text;
  v_revision bigint;
  v_prior public.deal_hunter_cim_safety_events%rowtype;
begin
  if p_source_id is null or p_run_id is null or p_opportunity_id is null
    or p_source_record_id is null or p_event_type is null or p_evidence_digest is null
    or p_accepted_at is null or pg_catalog.length(p_run_id) not between 1 and 200
    or pg_catalog.length(p_source_record_id) not between 1 and 200 then
    raise exception 'Invalid admitted import safety identity';
  end if;
  v_source_type := case when p_source_id = 'deal-os-export' then 'deal-os-import'
    when p_source_id ~ '^sheet-(0|[1-9][0-9]*)$' then 'sheet-import'
    else null end;
  if v_source_type is null then raise exception 'Unsupported admitted import safety source'; end if;
  select material_revision into v_revision from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id
      and (status = 'active' or (status = 'superseded' and p_event_type = 'source-record-removed'))
    for update;
  if not found then raise exception 'Admitted safety evidence lacks a current canonical opportunity'; end if;
  v_safety_run_id := 'cim-source:' || public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb(p_source_id), pg_catalog.to_jsonb(p_run_id));
  v_record_key := pg_catalog.left(public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-source-record:v1'::text),
    pg_catalog.to_jsonb(p_source_id), pg_catalog.to_jsonb(p_source_record_id)), 32);
  v_event_type := p_event_type || '#' || v_record_key;
  v_evidence_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-source-evidence:v1'::text),
    pg_catalog.to_jsonb(p_source_id), pg_catalog.to_jsonb(p_run_id),
    pg_catalog.to_jsonb(p_source_record_id), pg_catalog.to_jsonb(v_event_type),
    pg_catalog.to_jsonb(p_evidence_digest));
  v_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-safety:v1'::text), pg_catalog.to_jsonb(v_safety_run_id),
    pg_catalog.to_jsonb(p_opportunity_id), pg_catalog.to_jsonb(v_event_type),
    pg_catalog.to_jsonb(v_evidence_id));
  select * into v_prior from public.deal_hunter_cim_safety_events
    where safety_run_id = v_safety_run_id and opportunity_id = p_opportunity_id
      and pg_catalog.right(event_type, 33) = '#' || v_record_key for update;
  if found then
    if v_prior.safety_run_id <> v_safety_run_id or v_prior.opportunity_id <> p_opportunity_id
      or v_prior.source_type <> v_source_type or v_prior.source_run_id <> p_run_id
      or v_prior.evidence_id <> public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-source-evidence:v1'::text),
        pg_catalog.to_jsonb(p_source_id), pg_catalog.to_jsonb(p_run_id),
        pg_catalog.to_jsonb(p_source_record_id), pg_catalog.to_jsonb(v_prior.event_type),
        pg_catalog.to_jsonb(p_evidence_digest)) then
      raise exception 'Conflicting admitted source safety event';
    end if;
    return;
  end if;
  if (select pg_catalog.count(*) from public.deal_hunter_cim_safety_events
    where safety_run_id = v_safety_run_id) >= 10000 then
    raise exception 'Admitted safety run exceeds its bounded reader';
  end if;
  insert into public.deal_hunter_cim_safety_events
    (id, safety_run_id, opportunity_id, source_type, source_run_id,
     canonical_revision, identity_exception_revision, event_type, evidence_id,
     status, created_at, updated_at)
  values (v_id, v_safety_run_id, p_opportunity_id, v_source_type, p_run_id,
    v_revision, 0, v_event_type, v_evidence_id, 'pending', p_accepted_at, p_accepted_at);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('safety-emitted'::text), pg_catalog.to_jsonb(v_id)),
    'safety-emitted', p_opportunity_id, 'pending', v_source_type, p_run_id,
    p_accepted_at, '{}'::jsonb);
end;
$$;
revoke all on function public.pursue_cim_emit_admitted_import_safety_v1(
  text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;

-- The original complete admission remains the sole writer. This wrapper adds
-- safety evidence within its transaction, including deferred and disappeared rows.
alter function public.accept_admitted_complete_google_sheet_freshness_v1(jsonb, text)
  rename to accept_admitted_complete_google_sheet_freshness_p1c;
revoke all on function public.accept_admitted_complete_google_sheet_freshness_p1c(jsonb, text)
  from public, anon, authenticated, service_role;
create or replace function public.accept_admitted_complete_google_sheet_freshness_v1(
  p_admission jsonb, p_records_text text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_source_id text := p_admission ->> 'source_id';
  v_run_id text := p_admission -> 'run' ->> 'runId';
  v_payload jsonb := p_records_text::jsonb;
  v_records jsonb;
  v_unresolved jsonb;
  v_prior jsonb;
  v_result jsonb;
  v_record jsonb;
  v_old jsonb;
  v_item jsonb;
  v_candidate text;
  v_core_id text;
  v_event_type text;
  v_accepted_at timestamptz;
begin
  v_records := case when pg_catalog.jsonb_typeof(v_payload) = 'array' then v_payload
    else v_payload -> 'records' end;
  v_unresolved := case when pg_catalog.jsonb_typeof(v_payload) = 'array' then '[]'::jsonb
    else coalesce(v_payload -> 'unresolved', '[]'::jsonb) end;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'opportunityId', prior.opportunity_id, 'sourceRecordId', prior.source_record_id,
    'evidenceId', prior.accepted_evidence_id)), '[]'::jsonb) into v_prior
    from (select distinct on (opportunity_id, source_record_id)
      opportunity_id, source_record_id, accepted_evidence_id
      from public.deal_hunter_opportunity_source_observations
      where source_id = v_source_id
      order by opportunity_id, source_record_id, accepted_evidence_id nulls last) as prior;
  v_result := public.accept_admitted_complete_google_sheet_freshness_p1c(
    p_admission, p_records_text);
  select accepted_at into v_accepted_at from public.deal_hunter_source_freshness_state
    where source_id = v_source_id and accepted_run_id = v_run_id;
  if v_accepted_at is null then raise exception 'Admitted Sheet run was not accepted'; end if;
  for v_record in select value from pg_catalog.jsonb_array_elements(v_records) loop
    select id into v_core_id from public.deal_hunter_freshness_evidence
      where source_id = v_source_id and run_id = v_run_id
        and source_record_id = v_record ->> 'source_record_id'
        and event_type = 'accepted_source_record' and field_key = '' limit 1;
    v_event_type := case when found or v_result ->> 'projectionState' = 'deferred'
      then 'source-record-changed' else 'source-record-unchanged' end;
    if v_core_id is null then
      select accepted_evidence_id into v_core_id
        from public.deal_hunter_opportunity_source_observations
        where source_id = v_source_id and source_record_id = v_record ->> 'source_record_id'
          and opportunity_id = v_record ->> 'opportunity_id'
        limit 1;
    end if;
    perform public.pursue_cim_emit_admitted_import_safety_v1(v_source_id, v_run_id,
      v_record ->> 'opportunity_id', v_record ->> 'source_record_id', v_event_type,
      coalesce(v_core_id, ''), v_accepted_at);
  end loop;
  for v_item in select value from pg_catalog.jsonb_array_elements(v_unresolved) loop
    for v_candidate in select candidate.value from public.deal_hunter_identity_exceptions as exception,
      lateral pg_catalog.jsonb_array_elements_text(exception.candidate_opportunity_ids) as candidate(value)
      where exception.id = v_item ->> 'identity_exception_id' and exception.status = 'open'
    loop
      if exists (select 1 from public.deal_hunter_opportunities
        where opportunity_id = v_candidate and status = 'active') then
        perform public.pursue_cim_emit_admitted_import_safety_v1(v_source_id, v_run_id,
          v_candidate, v_item ->> 'source_record_id', 'identity-exception',
          v_item ->> 'identity_exception_id', v_accepted_at);
      end if;
    end loop;
  end loop;
  if v_result ->> 'projectionState' <> 'deferred' then
    for v_old in select value from pg_catalog.jsonb_array_elements(v_prior) loop
      if not exists (select 1 from public.deal_hunter_opportunity_source_observations
        where source_id = v_source_id and opportunity_id = v_old ->> 'opportunityId'
          and source_record_id = v_old ->> 'sourceRecordId') then
        perform public.pursue_cim_emit_admitted_import_safety_v1(v_source_id, v_run_id,
          v_old ->> 'opportunityId', v_old ->> 'sourceRecordId', 'source-record-removed',
          coalesce(v_old ->> 'evidenceId', ''), v_accepted_at);
      end if;
    end loop;
  end if;
  return v_result;
end;
$$;
revoke all on function public.accept_admitted_complete_google_sheet_freshness_v1(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.accept_admitted_complete_google_sheet_freshness_v1(jsonb, text)
  to service_role;

alter function public.bind_accepted_deal_hunter_freshness_v1(uuid, text, text, bigint, jsonb)
  rename to bind_accepted_deal_hunter_freshness_p1c;
revoke all on function public.bind_accepted_deal_hunter_freshness_p1c(uuid, text, text, bigint, jsonb)
  from public, anon, authenticated, service_role;
create or replace function public.bind_accepted_deal_hunter_freshness_v1(
  p_import_id uuid, p_opportunity_id text, p_source_record_id text,
  p_expected_generation bigint, p_snapshot jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_event public.deal_hunter_freshness_evidence%rowtype;
  v_result jsonb;
  v_type text;
begin
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'field', field, 'value', value) order by field), '[]'::jsonb) into v_before
    from public.deal_hunter_opportunity_source_observations
    where source_id = 'deal-os-export' and opportunity_id = p_opportunity_id
      and source_record_id = p_source_record_id;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'field', observation.value ->> 'field', 'value', observation.value ->> 'value')
    order by observation.value ->> 'field'), '[]'::jsonb) into v_after
    from pg_catalog.jsonb_array_elements(p_snapshot -> 'observations') as observation(value);
  select * into v_event from public.deal_hunter_freshness_evidence
    where source_id = 'deal-os-export' and run_id = p_import_id::text
      and source_record_id = p_source_record_id
      and event_type = 'accepted_source_record' and field_key = ''
    order by event_ordinal limit 1;
  v_result := public.bind_accepted_deal_hunter_freshness_p1c(p_import_id,
    p_opportunity_id, p_source_record_id, p_expected_generation, p_snapshot);
  if v_event.id is null then raise exception 'Accepted Deal OS core evidence is missing'; end if;
  v_type := case when v_result ->> 'projectionState' = 'superseded'
    then 'source-record-superseded'
    when v_before = v_after then 'source-record-unchanged'
    else 'source-record-changed' end;
  perform public.pursue_cim_emit_admitted_import_safety_v1('deal-os-export', p_import_id::text,
    p_opportunity_id, p_source_record_id, v_type,
    public.pursue_cim_digest_v1(pg_catalog.to_jsonb(v_event.id), v_after), v_event.accepted_at);
  return v_result;
end;
$$;
revoke all on function public.bind_accepted_deal_hunter_freshness_v1(uuid, text, text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.bind_accepted_deal_hunter_freshness_v1(uuid, text, text, bigint, jsonb)
  to service_role;

-- A public storage primitive may still create synthetic safety evidence, but
-- it cannot claim to be an admitted Sheet or Deal OS import.
alter function public.pursue_cim_append_safety_events_v1(jsonb)
  rename to pursue_cim_append_safety_events_p1c;
revoke all on function public.pursue_cim_append_safety_events_p1c(jsonb)
  from public, anon, authenticated, service_role;
create or replace function public.pursue_cim_append_safety_events_v1(p_run jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_run ->> 'sourceType' in ('sheet-import', 'deal-os-import') then
    raise exception 'Admitted import safety events require their source commit';
  end if;
  return public.pursue_cim_append_safety_events_p1c(p_run);
end;
$$;
revoke all on function public.pursue_cim_append_safety_events_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_safety_events_v1(jsonb) to service_role;

-- The P1C transition owns all stop/review fencing. Only a known unchanged
-- import can terminally no-op while an existing campaign remains active.
alter function public.pursue_cim_consume_safety_events_v1(jsonb)
  rename to pursue_cim_consume_safety_events_p1c;
revoke all on function public.pursue_cim_consume_safety_events_p1c(jsonb)
  from public, anon, authenticated, service_role;
create or replace function public.pursue_cim_consume_safety_events_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.deal_hunter_cim_safety_events%rowtype;
  v_actor text;
  v_now timestamptz;
  v_run_id text;
  v_batch_ids text[];
  v_counts record;
begin
  v_run_id := p_command ->> 'safetyRunId';
  v_actor := p_command ->> 'actor';
  v_now := (p_command ->> 'now')::timestamptz;
  select coalesce(pg_catalog.array_agg(id), array[]::text[]) into v_batch_ids
    from (select id from public.deal_hunter_cim_safety_events
      where safety_run_id = v_run_id and status = 'pending'
      order by created_at, id limit (p_command ->> 'limit')::integer for update) as batch;
  perform public.pursue_cim_consume_safety_events_p1c(p_command);
  for v_event in select * from public.deal_hunter_cim_safety_events
    where safety_run_id = v_run_id and status = 'pending'
      and id = any(v_batch_ids)
      and pg_catalog.split_part(event_type, '#', 1)
        in ('source-record-unchanged', 'source-record-superseded')
      and p_command -> 'outcomes' ->> id = 'no-op'
    order by created_at, id for update
  loop
    if exists (select 1 from public.deal_hunter_cim_campaigns
      where opportunity_id = v_event.opportunity_id
        and state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')) then
      update public.deal_hunter_cim_safety_events set status = 'no-op',
        outcome_evidence_id = v_event.id, consumed_at = v_now, updated_at = v_now
        where id = v_event.id and status = 'pending';
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, prior_state, next_state, actor, source,
         occurred_at, metadata)
      values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('safety-consumed'::text), pg_catalog.to_jsonb(v_event.id)),
        'safety-consumed', v_event.opportunity_id, 'pending', 'no-op', v_actor,
        'postgres-transition', v_now, '{}'::jsonb);
    end if;
  end loop;
  select pg_catalog.count(*) filter (where status = 'stopped') as stopped,
    pg_catalog.count(*) filter (where status = 'review-required') as review_required,
    pg_catalog.count(*) filter (where status = 'no-op') as no_op,
    pg_catalog.count(*) filter (where status = 'pending') as pending
    into v_counts from public.deal_hunter_cim_safety_events where safety_run_id = v_run_id;
  return pg_catalog.jsonb_build_object('stopped', v_counts.stopped,
    'reviewRequired', v_counts.review_required, 'noOp', v_counts.no_op,
    'pending', v_counts.pending);
end;
$$;
revoke all on function public.pursue_cim_consume_safety_events_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_consume_safety_events_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_read_import_outreach_counters_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'ownerDecisions', (select pg_catalog.count(*) from public.deal_hunter_owner_decision_events),
    'enrollments', (select pg_catalog.count(*) from public.deal_hunter_pursuit_enrollments),
    'campaigns', (select pg_catalog.count(*) from public.deal_hunter_cim_campaigns),
    'touches', (select pg_catalog.count(*) from public.deal_hunter_cim_campaign_touches),
    'transmissions', (select pg_catalog.count(*) from public.deal_hunter_cim_transmissions),
    'memberships', (select pg_catalog.count(*) from public.deal_hunter_cim_transmission_touches),
    'crmOutbound', (select pg_catalog.count(*) from public.crm_communications where direction = 'outbound'),
    'outbox', (select pg_catalog.count(*) from public.crm_email_outbox),
    'providerAuthorizations', (select pg_catalog.count(*) from public.deal_hunter_cim_live_provider_authorizations),
    'providerPending', (select pg_catalog.count(*) from public.deal_hunter_cim_transmissions
      where state = 'provider-pending'),
    'providerSeamEntries', (select pg_catalog.count(*) from public.deal_hunter_cim_transmissions
      where provider_seam_entered_at is not null));
$$;
revoke all on function public.pursue_cim_read_import_outreach_counters_v1()
  from public, anon, authenticated;
grant execute on function public.pursue_cim_read_import_outreach_counters_v1()
  to service_role;

-- Package 3: current canonical timezone revision guard.

create or replace function public.pursue_cim_append_timezone_revision_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_key text := p_command ->> 'idempotencyKey';
  v_state text := p_command ->> 'state';
  v_zone text := p_command ->> 'ianaTimezone';
  v_evidence_type text := p_command ->> 'evidenceType';
  v_evidence_id text := p_command ->> 'evidenceId';
  v_evidence_digest text := p_command ->> 'evidenceDigest';
  v_resolver text := p_command ->> 'resolverVersion';
  v_dataset_digest text := p_command ->> 'datasetDigest';
  v_actor text := p_command ->> 'actor';
  v_now timestamptz;
  v_expected bigint;
  v_current bigint;
  v_opportunity_status text;
  v_audit_id text;
  v_request_digest text;
  v_prior public.deal_hunter_cim_audit_events%rowtype;
  v_revision public.deal_hunter_opportunity_timezone_revisions%rowtype;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['opportunityId','idempotencyKey','state','evidenceType','evidenceId',
      'evidenceDigest','resolverVersion','datasetDigest','actor','now'],
    array['expectedPriorRevision'], array['ianaTimezone']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
    or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
    or v_key is null or pg_catalog.length(v_key) not between 1 and 240
    or pg_catalog.btrim(v_key) <> v_key
    or p_command ->> 'expectedPriorRevision' !~ '^(0|[1-9][0-9]*)$'
    or (p_command ->> 'expectedPriorRevision')::numeric > 9007199254740991
    or v_state not in ('verified','derived','missing','ambiguous')
    or v_evidence_type is null or pg_catalog.length(v_evidence_type) not between 1 and 120
    or pg_catalog.btrim(v_evidence_type) <> v_evidence_type
    or v_evidence_id is null or pg_catalog.length(v_evidence_id) not between 1 and 240
    or pg_catalog.btrim(v_evidence_id) <> v_evidence_id
    or v_evidence_digest !~ '^[0-9a-f]{64}$'
    or v_resolver is null or pg_catalog.length(v_resolver) not between 1 and 120
    or pg_catalog.btrim(v_resolver) <> v_resolver
    or v_dataset_digest !~ '^[0-9a-f]{64}$'
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM timezone revision command';
  end if;
  if v_state in ('verified','derived') then
    if v_zone is null or pg_catalog.length(v_zone) not between 1 and 120
      or not exists (select 1 from pg_catalog.pg_timezone_names where name = v_zone)
    then
      raise exception 'Invalid IANA timezone';
    end if;
  elsif v_zone is not null then
    raise exception 'Missing or ambiguous timezone cannot have an IANA timezone';
  end if;
  v_expected := (p_command ->> 'expectedPriorRevision')::bigint;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_request_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('timezone-request:v1'::text),
    pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_expected),
    pg_catalog.to_jsonb(v_state),
    coalesce(pg_catalog.to_jsonb(v_zone), 'null'::jsonb),
    pg_catalog.to_jsonb(v_evidence_type),
    pg_catalog.to_jsonb(v_evidence_id),
    pg_catalog.to_jsonb(v_evidence_digest),
    pg_catalog.to_jsonb(v_resolver),
    pg_catalog.to_jsonb(v_dataset_digest),
    pg_catalog.to_jsonb(v_key));
  v_audit_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-audit:v1'::text),
    pg_catalog.to_jsonb('timezone-revision'::text),
    pg_catalog.to_jsonb(v_key));
  select status into v_opportunity_status from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  if not found then
    raise exception 'Unknown Pursue CIM opportunity';
  end if;
  select * into v_prior from public.deal_hunter_cim_audit_events
    where id = v_audit_id;
  if found then
    select * into v_revision from public.deal_hunter_opportunity_timezone_revisions
      where opportunity_id = v_opportunity_id and revision = v_expected + 1;
    return pg_catalog.jsonb_build_object('applied', false,
      'replay', v_prior.authority_digest = v_request_digest,
      'staleRevision', v_prior.authority_digest <> v_request_digest,
      'timezoneRevision', case when found then pg_catalog.to_jsonb(v_revision) else null end);
  end if;
  if v_opportunity_status <> 'active' then
    select * into v_revision from public.deal_hunter_opportunity_timezone_revisions
      where opportunity_id = v_opportunity_id order by revision desc limit 1;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'staleRevision', true,
      'timezoneRevision', case when found then pg_catalog.to_jsonb(v_revision) else null end);
  end if;
  select coalesce(pg_catalog.max(revision), 0) into v_current
    from public.deal_hunter_opportunity_timezone_revisions
    where opportunity_id = v_opportunity_id;
  if v_current <> v_expected then
    select * into v_revision from public.deal_hunter_opportunity_timezone_revisions
      where opportunity_id = v_opportunity_id and revision = v_current;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'staleRevision', true,
      'timezoneRevision', case when found then pg_catalog.to_jsonb(v_revision) else null end);
  end if;
  insert into public.deal_hunter_opportunity_timezone_revisions
    (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
     evidence_digest, resolver_version, dataset_digest, actor, created_at)
  values (v_opportunity_id, v_current + 1, v_state, v_zone, v_evidence_type, v_evidence_id,
    v_evidence_digest, v_resolver, v_dataset_digest, v_actor, v_now)
  returning * into v_revision;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, next_state, authority_digest,
     actor, source, occurred_at, metadata)
  values (v_audit_id, 'timezone-revision', v_opportunity_id, v_state,
    v_request_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'staleRevision', false, 'timezoneRevision', pg_catalog.to_jsonb(v_revision));
end;
$$;

revoke all on function public.pursue_cim_append_timezone_revision_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_timezone_revision_v1(jsonb)
  to service_role;
-- Canonical CRM supersession authority. This block is also appended verbatim to schema.sql.
create table if not exists public.crm_submission_supersessions (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  status text not null check (status in ('active', 'reversed')),
  survivor_submission_id uuid not null references public.contact_submissions(id) on delete restrict,
  superseded_submission_id uuid not null references public.contact_submissions(id) on delete restrict,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  reason_code text not null check (reason_code = 'confirmed-duplicate'),
  reason_text text not null,
  approved_by text not null,
  approved_at timestamptz not null,
  actor text not null,
  repair_version text not null,
  repair_manifest_id text not null references public.deal_hunter_cim_repair_manifests(id) on delete restrict,
  repair_digest text not null check (repair_digest ~ '^[0-9a-f]{64}$'),
  reversed_at timestamptz,
  reversed_by text,
  reversal_reason text,
  reversal_manifest_id text references public.deal_hunter_cim_repair_manifests(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb,
  constraint crm_supersession_distinct check (survivor_submission_id <> superseded_submission_id),
  constraint crm_supersession_reversal_shape check (
    (status = 'active' and reversed_at is null and reversed_by is null
      and reversal_reason is null and reversal_manifest_id is null)
    or (status = 'reversed' and reversed_at is not null and reversed_by is not null
      and reversal_reason is not null and reversal_manifest_id is not null)
  )
);

create unique index if not exists uq_crm_submission_supersessions_active_loser
  on public.crm_submission_supersessions(superseded_submission_id) where status = 'active';
create index if not exists idx_crm_submission_supersessions_survivor
  on public.crm_submission_supersessions(survivor_submission_id, status);
create index if not exists idx_crm_submission_supersessions_opportunity
  on public.crm_submission_supersessions(opportunity_id, status);

create or replace function public.crm_supersession_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_survivor public.contact_submissions;
  v_loser public.contact_submissions;
  v_opportunity public.deal_hunter_opportunities;
  v_receipt public.deal_hunter_cim_repair_manifests;
begin
  if tg_op = 'DELETE' then
    raise exception 'CRM supersession physical delete is forbidden';
  end if;
  if tg_op = 'UPDATE' then
    if (pg_catalog.to_jsonb(new) - array['updated_at','status','reversed_at','reversed_by',
      'reversal_reason','reversal_manifest_id'])
      is distinct from (pg_catalog.to_jsonb(old) - array['updated_at','status','reversed_at',
        'reversed_by','reversal_reason','reversal_manifest_id']) then
      raise exception 'CRM supersession core fields are immutable';
    end if;
    if old.status <> 'active' or new.status <> 'reversed'
      or new.updated_at < old.updated_at
      or pg_catalog.btrim(new.reversed_by) = '' or pg_catalog.btrim(new.reversal_reason) = ''
      or new.reversal_manifest_id = new.repair_manifest_id then
      raise exception 'CRM supersession permits only reviewed active to reversed transition';
    end if;
    select * into v_receipt from public.deal_hunter_cim_repair_manifests
      where id = new.reversal_manifest_id;
    if not found or v_receipt.mode <> 'crm-duplicate-consolidation'
      or v_receipt.status <> 'applied'
      or v_receipt.manifest ->> 'schema' is distinct from 'crm-duplicate-consolidation-reversal-manifest-v1'
      or v_receipt.manifest ->> 'operation' is distinct from 'reverse'
      or v_receipt.manifest ->> 'relationId' is distinct from new.id
      or v_receipt.manifest ->> 'applyManifestId' is distinct from new.repair_manifest_id
      or v_receipt.manifest ->> 'repairDigest' is distinct from new.repair_digest
      or v_receipt.manifest ->> 'survivorSubmissionId' is distinct from new.survivor_submission_id::text
      or v_receipt.manifest ->> 'supersededSubmissionId' is distinct from new.superseded_submission_id::text
      or v_receipt.manifest ->> 'opportunityId' is distinct from new.opportunity_id then
      raise exception 'CRM supersession reversal evidence is invalid';
    end if;
    return new;
  end if;
  if new.status <> 'active' then
    raise exception 'CRM supersession must begin active';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crm-supersession-authority-v1', 0));
  select * into v_survivor from public.contact_submissions
    where id = new.survivor_submission_id for update;
  select * into v_loser from public.contact_submissions
    where id = new.superseded_submission_id for update;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = new.opportunity_id for update;
  select * into v_receipt from public.deal_hunter_cim_repair_manifests
    where id = new.repair_manifest_id for update;
  if v_survivor.id is null or v_loser.id is null then
    raise exception 'CRM supersession referenced submission is missing';
  end if;
  if v_opportunity.opportunity_id is null or v_opportunity.status <> 'active'
    or v_opportunity.primary_submission_id is distinct from new.survivor_submission_id then
    raise exception 'CRM supersession requires active opportunity with survivor primary';
  end if;
  if nullif(pg_catalog.btrim(v_survivor.deal_hunter_opportunity_id), '')
      is distinct from null and pg_catalog.btrim(v_survivor.deal_hunter_opportunity_id) <> new.opportunity_id
    or nullif(pg_catalog.btrim(v_survivor.metadata #>> '{dealHunter,opportunityId}'), '')
      is distinct from null and pg_catalog.btrim(v_survivor.metadata #>> '{dealHunter,opportunityId}') <> new.opportunity_id
    or (nullif(pg_catalog.btrim(v_survivor.deal_hunter_opportunity_id), '') is null
      and nullif(pg_catalog.btrim(v_survivor.metadata #>> '{dealHunter,opportunityId}'), '') is null) then
    raise exception 'CRM supersession survivor owner is incompatible';
  end if;
  if (nullif(pg_catalog.btrim(v_loser.deal_hunter_opportunity_id), '') is not null
      and pg_catalog.btrim(v_loser.deal_hunter_opportunity_id) <> new.opportunity_id)
    or (nullif(pg_catalog.btrim(v_loser.metadata #>> '{dealHunter,opportunityId}'), '') is not null
      and pg_catalog.btrim(v_loser.metadata #>> '{dealHunter,opportunityId}') <> new.opportunity_id) then
    raise exception 'CRM supersession loser owner is incompatible';
  end if;
  if exists (select 1 from public.deal_hunter_opportunities
      where primary_submission_id = new.superseded_submission_id) then
    raise exception 'CRM supersession loser cannot be an opportunity primary';
  end if;
  if exists (select 1 from public.crm_submission_supersessions
      where status = 'active' and (superseded_submission_id = new.survivor_submission_id
        or survivor_submission_id = new.superseded_submission_id)) then
    raise exception 'CRM supersession active role would create a chain';
  end if;
  if v_receipt.id is null or v_receipt.mode <> 'crm-duplicate-consolidation'
    or v_receipt.status <> 'applied' or v_receipt.checksum <> new.repair_digest then
    raise exception 'CRM supersession receipt or digest is invalid';
  end if;
  return new;
end;
$$;

create trigger crm_supersession_guard
before insert or update or delete on public.crm_submission_supersessions
for each row execute function public.crm_supersession_guard_v1();

create or replace function public.crm_supersession_parent_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'deal_hunter_cim_repair_manifests' then
    if old.mode = 'crm-duplicate-consolidation' then
      raise exception 'CRM duplicate consolidation receipt is append-only and immutable';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'deal_hunter_opportunities' then
    if tg_op = 'DELETE' then
      if exists (select 1 from public.crm_submission_supersessions
        where opportunity_id = old.opportunity_id) then
        raise exception 'CRM supersession referenced opportunity delete is forbidden';
      end if;
      return old;
    end if;
    if new.primary_submission_id is not null and exists (
      select 1 from public.crm_submission_supersessions
      where status = 'active' and superseded_submission_id = new.primary_submission_id) then
      raise exception 'CRM superseded primary is forbidden';
    end if;
    if exists (select 1 from public.crm_submission_supersessions
      where status = 'active' and opportunity_id = old.opportunity_id
        and (new.opportunity_id <> old.opportunity_id or new.status <> 'active'
          or new.primary_submission_id is distinct from survivor_submission_id)) then
      raise exception 'CRM supersession opportunity authority cannot be invalidated';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from public.crm_submission_supersessions
      where survivor_submission_id = old.id or superseded_submission_id = old.id) then
      raise exception 'CRM supersession referenced contact delete is forbidden';
    end if;
    return old;
  end if;
  if exists (select 1 from public.crm_submission_supersessions
    where status = 'active' and superseded_submission_id = old.id) then
    raise exception 'CRM_SUBMISSION_SUPERSEDED: historical loser is not writable';
  end if;
  if exists (select 1 from public.crm_submission_supersessions as relation
    where relation.status = 'active' and relation.survivor_submission_id = old.id
      and (new.id <> old.id
        or (nullif(pg_catalog.btrim(new.deal_hunter_opportunity_id), '') is not null
          and pg_catalog.btrim(new.deal_hunter_opportunity_id) <> relation.opportunity_id)
        or (nullif(pg_catalog.btrim(new.metadata #>> '{dealHunter,opportunityId}'), '') is not null
          and pg_catalog.btrim(new.metadata #>> '{dealHunter,opportunityId}') <> relation.opportunity_id)
        or (nullif(pg_catalog.btrim(new.deal_hunter_opportunity_id), '') is null
          and nullif(pg_catalog.btrim(new.metadata #>> '{dealHunter,opportunityId}'), '') is null))) then
    raise exception 'CRM supersession survivor owner cannot be invalidated';
  end if;
  if exists (select 1 from public.crm_submission_supersessions as relation
    where relation.status = 'active' and relation.superseded_submission_id = old.id
      and (new.id <> old.id
        or (nullif(pg_catalog.btrim(new.deal_hunter_opportunity_id), '') is not null
          and pg_catalog.btrim(new.deal_hunter_opportunity_id) <> relation.opportunity_id)
        or (nullif(pg_catalog.btrim(new.metadata #>> '{dealHunter,opportunityId}'), '') is not null
          and pg_catalog.btrim(new.metadata #>> '{dealHunter,opportunityId}') <> relation.opportunity_id))) then
    raise exception 'CRM supersession loser owner cannot be invalidated';
  end if;
  return new;
end;
$$;

create trigger crm_supersession_contact_guard
before update or delete on public.contact_submissions
for each row execute function public.crm_supersession_parent_guard_v1();
create trigger crm_supersession_opportunity_guard
before insert or update of opportunity_id, status, primary_submission_id or delete
on public.deal_hunter_opportunities
for each row execute function public.crm_supersession_parent_guard_v1();
create trigger crm_supersession_receipt_guard
before update or delete on public.deal_hunter_cim_repair_manifests
for each row execute function public.crm_supersession_parent_guard_v1();

create or replace function public.crm_supersession_activity_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- The relation insert takes the same contact row lock. A concurrent loser
  -- transition therefore commits before this write is admitted or waits for it.
  perform 1 from public.contact_submissions
    where id = new.submission_id for update;
  if exists (select 1 from public.crm_submission_supersessions
    where status = 'active' and superseded_submission_id = new.submission_id) then
    raise exception 'CRM_SUBMISSION_SUPERSEDED: historical loser activity is forbidden';
  end if;
  return new;
end;
$$;

create trigger crm_supersession_activity_guard
before insert or update on public.crm_activity_events
for each row execute function public.crm_supersession_activity_guard_v1();

create or replace function public.read_deal_hunter_crm_match_authority_v2(
  p_limit integer default 5000, p_supersession_limit integer default 5000)
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 5000), 5000));
  v_supersession_limit integer := greatest(1, least(coalesce(p_supersession_limit, 5000), 5000));
  v_submissions jsonb;
  v_supersessions jsonb;
  v_revision text;
  v_version constant text := 'deal-hunter-crm-match-authority-v2';
begin
  -- One SQL statement gives both bounded sets the same MVCC snapshot.
  with submissions as materialized (
    select * from public.contact_submissions order by id limit v_limit + 1
  ), supersessions as materialized (
    select * from public.crm_submission_supersessions
    where status = 'active' order by id limit v_supersession_limit + 1
  )
  select
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) order by s.id), '[]'::jsonb) from submissions s),
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.id), '[]'::jsonb) from supersessions r)
  into v_submissions, v_supersessions;
  if pg_catalog.jsonb_array_length(v_submissions) > v_limit
    or pg_catalog.jsonb_array_length(v_supersessions) > v_supersession_limit then
    return pg_catalog.jsonb_build_object('rows', '[]'::jsonb, 'supersessions', '[]'::jsonb,
      'count', null, 'submissionCount', null, 'supersessionCount', null,
      'complete', false, 'revision', null, 'revisionVersion', v_version);
  end if;
  v_revision := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object('version', v_version, 'submissions', v_submissions,
      'activeSupersessions', v_supersessions)::text, 'UTF8')), 'hex');
  return pg_catalog.jsonb_build_object('rows', v_submissions, 'supersessions', v_supersessions,
    'count', pg_catalog.jsonb_array_length(v_submissions),
    'submissionCount', pg_catalog.jsonb_array_length(v_submissions),
    'supersessionCount', pg_catalog.jsonb_array_length(v_supersessions),
    'complete', true, 'revision', v_revision, 'revisionVersion', v_version);
end;
$$;

create or replace function public.link_deal_hunter_crm_submission_if_authority_current_v2(
  p_opportunity_id text, p_submission_id uuid, p_expected_authority_revision text,
  p_updated_at timestamptz)
returns public.deal_hunter_opportunities language plpgsql security definer
set search_path = '' set timezone = 'UTC' as $$
declare
  v_authority jsonb;
  v_opportunity public.deal_hunter_opportunities;
  v_submission public.contact_submissions;
  v_direct text;
  v_metadata text;
  v_survivor uuid;
  v_survivor_opportunity text;
begin
  if nullif(pg_catalog.btrim(p_opportunity_id), '') is null or p_submission_id is null
    or p_expected_authority_revision is null
    or p_expected_authority_revision !~ '^[0-9a-f]{64}$' or p_updated_at is null then
    raise exception 'CRM_MATCH_AUTHORITY_STALE: invalid conditional link input';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'CRM_MATCH_AUTHORITY_STALE: read committed isolation required';
  end if;
  -- Serializes authority writers before the complete-set CAS and both updates.
  lock table public.contact_submissions, public.crm_submission_supersessions,
    public.deal_hunter_opportunities in share row exclusive mode;
  v_authority := public.read_deal_hunter_crm_match_authority_v2(5000, 5000);
  if not (v_authority ->> 'complete')::boolean
    or v_authority ->> 'revision' is distinct from p_expected_authority_revision then
    raise exception 'CRM_MATCH_AUTHORITY_STALE: complete authority changed';
  end if;
  select survivor_submission_id, opportunity_id into v_survivor, v_survivor_opportunity
    from public.crm_submission_supersessions
    where status = 'active' and superseded_submission_id = p_submission_id;
  if v_survivor is not null then
    raise exception 'CRM_SUBMISSION_SUPERSEDED:%:%', v_survivor, v_survivor_opportunity;
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id and status = 'active';
  select * into v_submission from public.contact_submissions where id = p_submission_id;
  if v_opportunity.opportunity_id is null or v_submission.id is null
    or pg_catalog.lower(pg_catalog.btrim(v_submission.status)) in ('archived', 'spam')
    or (v_opportunity.primary_submission_id is not null
      and v_opportunity.primary_submission_id <> p_submission_id) then
    raise exception 'CRM_MATCH_AUTHORITY_STALE: canonical opportunity or submission changed';
  end if;
  v_direct := pg_catalog.btrim(coalesce(v_submission.deal_hunter_opportunity_id, ''));
  v_metadata := pg_catalog.btrim(coalesce(v_submission.metadata #>> '{dealHunter,opportunityId}', ''));
  if (v_direct <> '' and v_direct <> p_opportunity_id)
    or (v_metadata <> '' and v_metadata <> p_opportunity_id)
    or (v_direct <> '' and v_metadata <> '' and v_direct <> v_metadata)
    or exists (select 1 from public.contact_submissions
      where id <> p_submission_id and pg_catalog.btrim(coalesce(deal_hunter_opportunity_id, '')) = p_opportunity_id) then
    raise exception 'CRM_MATCH_AUTHORITY_STALE: CRM ownership conflict';
  end if;
  update public.contact_submissions set deal_hunter_opportunity_id = p_opportunity_id,
    updated_at = p_updated_at where id = p_submission_id;
  update public.deal_hunter_opportunities set primary_submission_id = p_submission_id,
    updated_at = p_updated_at where opportunity_id = p_opportunity_id
    returning * into v_opportunity;
  return v_opportunity;
end;
$$;

alter table public.crm_submission_supersessions enable row level security;
revoke all privileges on table public.crm_submission_supersessions from public, anon, authenticated;
revoke all privileges on table public.crm_submission_supersessions from service_role;
grant select, insert, update on table public.crm_submission_supersessions to service_role;
revoke all on function public.crm_supersession_guard_v1() from public, anon, authenticated;
revoke all on function public.crm_supersession_parent_guard_v1() from public, anon, authenticated;
revoke all on function public.crm_supersession_activity_guard_v1() from public, anon, authenticated;
revoke all on function public.read_deal_hunter_crm_match_authority_v2(integer, integer) from public, anon, authenticated;
revoke all on function public.link_deal_hunter_crm_submission_if_authority_current_v2(text, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.read_deal_hunter_crm_match_authority_v2(integer, integer) to service_role;
grant execute on function public.link_deal_hunter_crm_submission_if_authority_current_v2(text, uuid, text, timestamptz) to service_role;
-- Package 4B: canonical primary CRM ownership revisions.
alter table public.deal_hunter_opportunities
  add column if not exists campaign_authority_revision bigint not null default 1
    check (campaign_authority_revision > 0);

create table if not exists public.deal_hunter_crm_ownership_revisions (
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete cascade,
  revision bigint not null check (revision > 0),
  submission_id text,
  created_at timestamptz not null default now(),
  primary key (opportunity_id, revision)
);
insert into public.deal_hunter_crm_ownership_revisions
  (opportunity_id, revision, submission_id)
select opportunity_id, 1, primary_submission_id
from public.deal_hunter_opportunities as opportunity
where not exists (select 1 from public.deal_hunter_crm_ownership_revisions as revision
  where revision.opportunity_id = opportunity.opportunity_id);
alter table public.deal_hunter_crm_ownership_revisions enable row level security;
revoke all on table public.deal_hunter_crm_ownership_revisions from public, anon, authenticated;
grant select on table public.deal_hunter_crm_ownership_revisions to service_role;

create or replace function public.pursue_cim_append_crm_ownership_revision_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision bigint;
begin
  if TG_OP = 'INSERT' then
    v_revision := 1;
  elsif old.primary_submission_id is distinct from new.primary_submission_id then
    select coalesce(pg_catalog.max(revision), 0) + 1 into v_revision
    from public.deal_hunter_crm_ownership_revisions
    where opportunity_id = new.opportunity_id;
  else
    return new;
  end if;
  insert into public.deal_hunter_crm_ownership_revisions
    (opportunity_id, revision, submission_id)
  values (new.opportunity_id, v_revision, new.primary_submission_id);
  return new;
end;
$$;
create trigger trg_cim_crm_revision_opportunity_insert
  after insert on public.deal_hunter_opportunities
  for each row execute function public.pursue_cim_append_crm_ownership_revision_v1();
create trigger trg_cim_crm_revision_opportunity_update
  after update of primary_submission_id on public.deal_hunter_opportunities
  for each row execute function public.pursue_cim_append_crm_ownership_revision_v1();
revoke all on function public.pursue_cim_append_crm_ownership_revision_v1()
  from public, anon, authenticated;

create or replace function public.pursue_cim_bump_campaign_authority_revision_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
  v_new text;
begin
  if TG_OP <> 'INSERT' then v_old := old.opportunity_id; end if;
  if TG_OP <> 'DELETE' then v_new := new.opportunity_id; end if;
  if TG_OP = 'UPDATE' then
    if TG_TABLE_NAME = 'deal_hunter_opportunity_source_observations' then
      if old.opportunity_id is not distinct from new.opportunity_id
        and old.source_id is not distinct from new.source_id
        and old.source_record_id is not distinct from new.source_record_id
        and old.field is not distinct from new.field
        and old.value is not distinct from new.value
        and old.accepted_at is not distinct from new.accepted_at
        and old.accepted_run_id is not distinct from new.accepted_run_id then return new; end if;
    end if;
  end if;
  update public.deal_hunter_opportunities
    set campaign_authority_revision = campaign_authority_revision + 1
    where opportunity_id in (v_old, v_new);
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_cim_campaign_revision_source on public.deal_hunter_opportunity_source_observations;
create trigger trg_cim_campaign_revision_source
after insert or update or delete on public.deal_hunter_opportunity_source_observations
for each row execute function public.pursue_cim_bump_campaign_authority_revision_v1();
drop trigger if exists trg_cim_campaign_revision_fact on public.deal_hunter_opportunity_facts;
create trigger trg_cim_campaign_revision_fact
after insert or update or delete on public.deal_hunter_opportunity_facts
for each row execute function public.pursue_cim_bump_campaign_authority_revision_v1();
drop trigger if exists trg_cim_campaign_revision_alias on public.deal_hunter_opportunity_aliases;
create trigger trg_cim_campaign_revision_alias
after insert or update or delete on public.deal_hunter_opportunity_aliases
for each row execute function public.pursue_cim_bump_campaign_authority_revision_v1();
revoke all on function public.pursue_cim_bump_campaign_authority_revision_v1()
  from public, anon, authenticated;

create table if not exists public.deal_hunter_cim_global_authority (
  id text primary key check (id = 'global'),
  revision bigint not null check (revision > 0)
);
insert into public.deal_hunter_cim_global_authority (id, revision)
values ('global', 1) on conflict (id) do nothing;
alter table public.deal_hunter_cim_global_authority enable row level security;
revoke all on table public.deal_hunter_cim_global_authority from public, anon, authenticated;
grant select on table public.deal_hunter_cim_global_authority to service_role;

create or replace function public.pursue_cim_bump_global_authority_revision_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'UPDATE' then
    if TG_TABLE_NAME = 'deal_hunter_source_freshness_state' then
      if old.accepted_generation is not distinct from new.accepted_generation
        and old.accepted_run_id is not distinct from new.accepted_run_id
        and old.accepted_digest is not distinct from new.accepted_digest
        and old.projection_state is not distinct from new.projection_state then return new; end if;
    end if;
    if TG_TABLE_NAME = 'deal_hunter_identity_exceptions' then
      if old.status is not distinct from new.status
        and old.candidate_opportunity_ids is not distinct from new.candidate_opportunity_ids then return new; end if;
    end if;
  end if;
  update public.deal_hunter_cim_global_authority
    set revision = revision + 1 where id = 'global';
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_cim_global_revision_source on public.deal_hunter_source_freshness_state;
create trigger trg_cim_global_revision_source
after insert or update or delete on public.deal_hunter_source_freshness_state
for each row execute function public.pursue_cim_bump_global_authority_revision_v1();
drop trigger if exists trg_cim_global_revision_identity on public.deal_hunter_identity_exceptions;
create trigger trg_cim_global_revision_identity
after insert or update or delete on public.deal_hunter_identity_exceptions
for each row execute function public.pursue_cim_bump_global_authority_revision_v1();
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'email_suppressions', 'secure_documents', 'secure_upload_requests',
    'crm_communications', 'deal_hunter_cim_requests', 'deal_hunter_cim_opportunity_claims'
  ] loop
    execute pg_catalog.format('drop trigger if exists %I on public.%I',
      'trg_cim_global_revision_' || v_table, v_table);
    execute pg_catalog.format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.pursue_cim_bump_global_authority_revision_v1()',
      'trg_cim_global_revision_' || v_table, v_table);
  end loop;
end;
$$;
revoke all on function public.pursue_cim_bump_global_authority_revision_v1()
  from public, anon, authenticated;

-- The wrapper holds the same opportunity row lock as the v1 allocator while
-- comparing the server-owned revision before any conversation or campaign write.
create or replace function public.pursue_cim_crm_match_fingerprint_v1()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submissions jsonb;
  v_supersessions jsonb;
begin
  if (select count(*) from public.contact_submissions) > 5000
    or (select count(*) from public.crm_submission_supersessions where status = 'active') > 5000 then
    return null;
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(contact) order by contact.id), '[]'::jsonb)
    into v_submissions from public.contact_submissions as contact;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(relation) order by relation.id), '[]'::jsonb)
    into v_supersessions from public.crm_submission_supersessions as relation
    where relation.status = 'active';
  return pg_catalog.md5(v_submissions::text || ':' || v_supersessions::text);
end;
$$;
revoke all on function public.pursue_cim_crm_match_fingerprint_v1()
  from public, anon, authenticated;
grant execute on function public.pursue_cim_crm_match_fingerprint_v1()
  to service_role;

create or replace function public.pursue_cim_materialize_campaign_v2(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_activation_id text;
  v_expected bigint;
  v_campaign_expected bigint;
  v_global_expected bigint;
  v_global bigint;
  v_ownership public.deal_hunter_crm_ownership_revisions%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
  v_crm_match_fingerprint text;
begin
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'crmOwnershipRevision');
  v_campaign_expected := public.pursue_cim_required_revision_v1(p_command, 'campaignAuthorityRevision');
  v_global_expected := public.pursue_cim_required_revision_v1(p_command, 'globalAuthorityRevision');
  lock table public.contact_submissions, public.crm_submission_supersessions in share mode;
  v_crm_match_fingerprint := public.pursue_cim_crm_match_fingerprint_v1();
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_command ->> 'opportunityId' for update;
  select * into v_ownership from public.deal_hunter_crm_ownership_revisions
    where opportunity_id = v_opportunity.opportunity_id
    order by revision desc limit 1;
  select * into v_score from public.deal_hunter_opportunity_scores
    where opportunity_id = v_opportunity.opportunity_id for share;
  select revision into v_global from public.deal_hunter_cim_global_authority
    where id = 'global' for share;
  v_activation_id := public.pursue_cim_current_activation_v1('fl04b-enrollment',
    public.pursue_cim_required_instant_v1(p_command, 'now'));
  if v_activation_id is not null then
    select * into v_activation from public.deal_hunter_cim_capability_activations
      where id = v_activation_id for share;
  end if;
  if v_opportunity.opportunity_id is null
    or v_expected is distinct from v_ownership.revision
    or v_ownership.submission_id is distinct from (p_command ->> 'crmSubmissionId')
    or v_score.opportunity_id is null
    or v_score.operator_priority <> 'high'
    or v_score.reviewed_at is null
    or v_score.current_triage_eligible is distinct from true
    or v_score.should_remove is distinct from false
    or (case when coalesce(v_score.reviewed_semantic_digest, '') <> ''
      then v_score.reviewed_semantic_digest is distinct from v_score.semantic_digest
      else coalesce(v_score.reviewed_fingerprint, '') <> ''
        and v_score.reviewed_fingerprint is distinct from v_score.score_fingerprint end)
    or v_crm_match_fingerprint is null
    or v_crm_match_fingerprint is distinct from (p_command ->> 'crmMatchAuthorityFingerprint')
    or not (p_command ? 'crmBrokerEmail')
    or not exists (select 1 from public.contact_submissions as contact
      where contact.id = v_opportunity.primary_submission_id
        and contact.status not in ('archived', 'spam')
        and contact.archived_at is null
        and contact.deal_hunter_opportunity_id = v_opportunity.opportunity_id
        and contact.broker_email is not distinct from (p_command ->> 'crmBrokerEmail')
        and (contact.metadata -> 'dealHunter' ->> 'opportunityId' is null
          or contact.metadata -> 'dealHunter' ->> 'opportunityId' = v_opportunity.opportunity_id))
    or exists (select 1 from public.crm_submission_supersessions as relation
      where relation.superseded_submission_id = v_opportunity.primary_submission_id
        and relation.status = 'active')
    or v_campaign_expected <> v_opportunity.campaign_authority_revision
    or v_global is distinct from v_global_expected
    or exists (select 1 from public.deal_hunter_source_freshness_state
      where projection_state in ('pending', 'deferred', 'superseded'))
    or exists (select 1 from public.deal_hunter_identity_exceptions
      where status = 'open')
    or exists (select 1 from public.deal_hunter_cim_requests as request
      where request.opportunity_id = v_opportunity.opportunity_id
        or request.deal_key in (select score.deal_key
          from public.deal_hunter_opportunity_scores as score
          where score.opportunity_id = v_opportunity.opportunity_id))
    or exists (select 1 from public.deal_hunter_cim_opportunity_claims
      where opportunity_id = v_opportunity.opportunity_id)
    or exists (select 1 from public.email_suppressions
      where normalized_email = pg_catalog.lower(p_command ->> 'recipientAddress')
        and lifted_at is null)
    or exists (select 1 from public.contact_submissions
      where id = v_opportunity.primary_submission_id and prospectus_url is not null
        and pg_catalog.btrim(prospectus_url) <> '')
    or exists (select 1 from public.secure_documents
      where submission_id = v_opportunity.primary_submission_id)
    or exists (select 1 from public.secure_upload_requests
      where submission_id = v_opportunity.primary_submission_id
        and status in ('completed', 'documents-received'))
    or exists (select 1 from public.crm_communications
      where submission_id = v_opportunity.primary_submission_id and direction = 'inbound')
    or v_activation.id is null
    or v_activation.id <> (p_command ->> 'permissionVersion')
    or v_activation.permission_basis_digest is distinct from (p_command ->> 'permissionDigest')
    or v_activation.permission_revision is distinct from
      public.pursue_cim_required_revision_v1(p_command, 'permissionRevision')
    or v_activation.cohort_digest is distinct from (p_command ->> 'permissionScope')
    or v_activation.policy_hash is distinct from (p_command ->> 'policyHash') then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  return public.pursue_cim_materialize_campaign_v1(p_command);
end;
$$;
revoke all on function public.pursue_cim_materialize_campaign_v2(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_materialize_campaign_v2(jsonb)
  to service_role;

-- Package 4B: retry an action-required Pursue with a new immutable choice.
create or replace function public.pursue_cim_record_owner_decision_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_action text := p_command ->> 'action';
  v_key text := p_command ->> 'idempotencyKey';
  v_actor text := p_command ->> 'actor';
  v_policy text := p_command ->> 'policyVersion';
  v_contact_digest text := p_command ->> 'selectedContactReferenceDigest';
  v_reason text := p_command ->> 'reason';
  v_note text := coalesce(p_command ->> 'note', '');
  v_submission_id text := coalesce(p_command ->> 'submissionId', '');
  v_now timestamptz;
  v_discovery bigint;
  v_material bigint;
  v_request_digest text;
  v_decision_id text;
  v_enrollment_id text;
  v_existing public.deal_hunter_owner_decision_events%rowtype;
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_retry_choice boolean := false;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_terminal_id text;
  v_disposition_hash text;
  v_disposition_id uuid;
  v_archive_id uuid;
  v_triage_id uuid;
  v_pass_result jsonb;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['opportunityId','action','idempotencyKey','actor','policyVersion','now'],
    array['expectedDiscoveryRevision','expectedMaterialRevision'],
    array['selectedContactReferenceDigest','reason','note','submissionId']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
    or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
    or v_action not in ('pursue','watch','pass')
    or v_key is null or pg_catalog.length(v_key) not between 1 and 240
    or pg_catalog.btrim(v_key) <> v_key
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or v_policy is null or pg_catalog.length(v_policy) not between 1 and 120
    or pg_catalog.btrim(v_policy) <> v_policy
    or (v_contact_digest is not null and v_contact_digest !~ '^[0-9a-f]{64}$')
    or (v_action = 'pass' and (v_reason is null
      or pg_catalog.length(v_reason) not between 1 and 160
      or pg_catalog.btrim(v_reason) <> v_reason))
    or pg_catalog.length(v_note) > 2000
    or pg_catalog.length(v_submission_id) > 120
    or pg_catalog.btrim(v_submission_id) <> v_submission_id
    or p_command ->> 'expectedDiscoveryRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'expectedMaterialRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM owner decision command';
  end if;
  v_discovery := (p_command ->> 'expectedDiscoveryRevision')::bigint;
  v_material := (p_command ->> 'expectedMaterialRevision')::bigint;
  if v_discovery > 9007199254740991 or v_material > 9007199254740991 then
    raise exception 'Unsafe Pursue CIM owner revision';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  if v_action <> 'pass' then
    v_reason := null;
    v_note := '';
    v_submission_id := '';
  end if;
  v_request_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision-request:v1'::text),
    pg_catalog.to_jsonb(v_action), pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_discovery), pg_catalog.to_jsonb(v_material),
    coalesce(pg_catalog.to_jsonb(v_contact_digest), 'null'::jsonb),
    pg_catalog.to_jsonb(v_actor), pg_catalog.to_jsonb(v_policy),
    coalesce(pg_catalog.to_jsonb(v_reason), 'null'::jsonb),
    pg_catalog.to_jsonb(v_note), pg_catalog.to_jsonb(v_submission_id),
    pg_catalog.to_jsonb(v_key));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:owner-key:' || v_key, 0));
  select * into v_existing from public.deal_hunter_owner_decision_events
    where idempotency_key = v_key;
  if found then
    select * into v_enrollment from public.deal_hunter_pursuit_enrollments
      where decision_event_id = v_existing.id;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'replay', v_existing.request_digest = v_request_digest,
      'conflict', v_existing.request_digest <> v_request_digest,
      'decision', pg_catalog.to_jsonb(v_existing),
      'enrollment', case when found then pg_catalog.to_jsonb(v_enrollment) else null end);
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  if not found or v_opportunity.status <> 'active'
    or v_opportunity.discovery_revision <> v_discovery
    or v_opportunity.material_revision <> v_material
  then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'reason', 'stale_revision', 'decision', null, 'enrollment', null);
  end if;
  select * into v_score from public.deal_hunter_opportunity_scores
    where opportunity_id = v_opportunity_id and current_triage_eligible = true
      and should_remove = false for update;
  if v_action <> 'pursue' then
    if v_score.opportunity_id is null or (v_action = 'pass' and v_score.deal_key is null) then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'decision', null, 'enrollment', null);
    end if;
  end if;
  if v_score.deal_key is not null and exists (
    select 1 from public.deal_hunter_dispositions
    where deal_key = v_score.deal_key and disposition = 'dismissed'
  ) then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'reason', 'already-passed', 'decision', null, 'enrollment', null);
  end if;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where opportunity_id = v_opportunity_id and state <> 'superseded' for update;
  if v_enrollment.id is not null and v_action = 'pursue' then
    select * into v_decision from public.deal_hunter_owner_decision_events
      where id = v_enrollment.decision_event_id;
    v_retry_choice := v_enrollment.state = 'action-required'
      or (v_enrollment.state in ('queued', 'waiting-on-eligibility')
        and v_contact_digest is not null
        and v_contact_digest is distinct from v_decision.selected_contact_reference_digest);
    if not v_retry_choice then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
        'enrollment', pg_catalog.to_jsonb(v_enrollment));
    end if;
  end if;
  v_decision_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision:v1'::text), pg_catalog.to_jsonb(v_key));
  v_enrollment_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('pursuit-enrollment:v1'::text), pg_catalog.to_jsonb(v_decision_id));
  if v_retry_choice then
    update public.deal_hunter_pursuit_enrollments
      set state = 'superseded', reason_code = 'pursue-retried',
        row_version = row_version + 1, updated_at = v_now
      where id = v_enrollment.id and state = v_enrollment.state;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, prior_state, next_state,
       reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('enrollment-transition'::text),
        pg_catalog.to_jsonb(v_enrollment.id || ':' || (v_enrollment.row_version + 1)::text)),
      'enrollment-transition', v_opportunity_id, v_enrollment.state, 'superseded',
      'pursue-retried', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  end if;
  if v_action = 'pass' then
    if v_submission_id <> '' then
      raise exception 'Explicit Pass submission context requires verified supersession authority';
    end if;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-disposition:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_disposition_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-archive:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_archive_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-triage:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_triage_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_pass_result := public.pass_deal_hunter_opportunity_freshness_v1(
      pg_catalog.jsonb_build_object('opportunity_id', v_opportunity_id,
        'reason', v_reason, 'note', v_note, 'actor', v_actor, 'occurred_at', v_now,
        'disposition_id', v_disposition_id, 'archive_activity_id', v_archive_id,
        'triage_activity_id', v_triage_id), v_discovery, v_material);
    if v_pass_result ->> 'applied' <> 'true' then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'reason', v_pass_result ->> 'reason',
        'decision', null, 'enrollment', null);
    end if;
  end if;
  insert into public.deal_hunter_owner_decision_events
    (id, idempotency_key, request_digest, opportunity_id, action, actor,
     expected_discovery_revision, expected_material_revision,
     observed_discovery_revision, observed_material_revision,
     selected_contact_reference_digest, policy_version, created_at)
  values (v_decision_id, v_key, v_request_digest, v_opportunity_id, v_action, v_actor,
    v_discovery, v_material, v_opportunity.discovery_revision,
    v_opportunity.material_revision, v_contact_digest, v_policy, v_now)
  returning * into v_decision;

  if v_action <> 'pursue' then
    if v_enrollment.id is not null then
      update public.deal_hunter_pursuit_enrollments
        set state = 'superseded', reason_code = v_action || '-selected',
          row_version = row_version + 1, updated_at = v_now
        where id = v_enrollment.id and state <> 'superseded';
    end if;
    for v_campaign in
      select * from public.deal_hunter_cim_campaigns
      where opportunity_id = v_opportunity_id
        and state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')
      order by id for update
    loop
      for v_transmission in
        select tr.* from public.deal_hunter_cim_transmissions as tr
        where tr.id in (
          select m.transmission_id from public.deal_hunter_cim_transmission_touches as m
          where m.campaign_id = v_campaign.id and m.cancelled_at is null)
          and tr.state in ('prepared','final-gate-blocked')
        order by tr.id for update
      loop
        perform public.pursue_cim_cancel_prepared_transmission_v1(
          v_transmission.id, v_now, v_action || '-selected', v_actor, false);
      end loop;
      for v_touch in
        select * from public.deal_hunter_cim_campaign_touches
        where campaign_id = v_campaign.id and state in ('scheduled','claimed')
          and transmission_id is null order by id for update
      loop
        update public.deal_hunter_cim_campaign_touches
          set state = 'cancelled-before-provider', terminal_reason = v_action || '-selected',
            row_version = row_version + 1, updated_at = v_now
          where id = v_touch.id and row_version = v_touch.row_version;
        insert into public.deal_hunter_cim_audit_events
          (id, event_type, opportunity_id, campaign_id, touch_id, prior_state,
           next_state, reason_code, actor, source, occurred_at, metadata)
        values (public.pursue_cim_digest_v1(
            pg_catalog.to_jsonb('cim-audit:v1'::text),
            pg_catalog.to_jsonb('touch-cancelled'::text),
            pg_catalog.to_jsonb(v_touch.id || ':' || (v_touch.row_version + 1)::text)),
          'touch-cancelled', v_opportunity_id, v_campaign.id, v_touch.id, v_touch.state,
          'cancelled-before-provider', v_action || '-selected', v_actor,
          'sqlite-transition', v_now, '{}'::jsonb);
      end loop;
      update public.deal_hunter_cim_campaigns
        set state = 'stopped', reason_code = v_action || '-selected',
          terminal_revision = terminal_revision + 1, row_version = row_version + 1,
          updated_at = v_now
        where id = v_campaign.id and row_version = v_campaign.row_version;
      v_terminal_id := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('owner-terminal:v1'::text),
        pg_catalog.to_jsonb(v_decision_id), pg_catalog.to_jsonb(v_campaign.id));
      insert into public.deal_hunter_cim_terminal_events
        (id, scope, scope_id, campaign_id, revision, reason_code,
         evidence_type, evidence_id, observed_at, actor, source, metadata_digest, created_at)
      values (v_terminal_id, 'campaign', v_campaign.id, v_campaign.id,
        v_campaign.terminal_revision + 1, v_action || '-selected',
        'owner-decision', v_decision_id, v_now, v_actor, 'sqlite-transition',
        v_request_digest, v_now);
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
         reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('terminal-transition'::text),
          pg_catalog.to_jsonb(v_terminal_id)),
        'terminal-transition', v_opportunity_id, v_campaign.id, v_campaign.state,
        'stopped', v_action || '-selected', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    end loop;
    if v_action = 'watch' then
    update public.deal_hunter_opportunity_scores
      set operator_priority = case when v_action = 'watch' then 'watch' else operator_priority end,
        reviewed_at = v_now, reviewed_by = v_actor,
        reviewed_fingerprint = score_fingerprint,
        reviewed_semantic_digest = semantic_digest,
        reviewed_discovery_revision = v_discovery,
        reviewed_material_revision = v_material, operator_updated_at = v_now
      where opportunity_id = v_opportunity_id;
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, next_state, authority_digest,
       actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('owner-decision'::text),
        pg_catalog.to_jsonb(v_decision_id)),
      'owner-decision', v_opportunity_id, v_action, v_request_digest,
      v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
      'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
      'enrollment', null, 'passResult', v_pass_result);
  end if;

  insert into public.deal_hunter_pursuit_enrollments
    (id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
     created_at, updated_at)
  values (v_enrollment_id, v_decision_id, v_opportunity_id, 'queued',
    'awaiting-orchestration', public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('enrollment-authority:v1'::text),
      pg_catalog.to_jsonb(v_decision_id),
      pg_catalog.to_jsonb(v_opportunity.discovery_revision),
      pg_catalog.to_jsonb(v_opportunity.material_revision)), v_now, v_now)
  returning * into v_enrollment;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, next_state, authority_digest,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('owner-decision'::text),
      pg_catalog.to_jsonb(v_decision_id)),
    'owner-decision', v_opportunity_id, v_action, v_request_digest,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  if v_score.opportunity_id is not null then
    update public.deal_hunter_opportunity_scores set operator_priority = 'high',
      reviewed_at = v_now, reviewed_by = v_actor,
      reviewed_fingerprint = score_fingerprint,
      reviewed_semantic_digest = semantic_digest,
      reviewed_discovery_revision = v_discovery,
      reviewed_material_revision = v_material, operator_updated_at = v_now
      where opportunity_id = v_opportunity_id;
  end if;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
    'enrollment', pg_catalog.to_jsonb(v_enrollment));
end;
$$;
-- Package 6A: fresh final gate and consumed provider-pending authority.
-- Canonical PostgreSQL lock order:
-- transmission; live authorization; conversation; campaigns; memberships/touches;
-- owner decision/enrollment/opportunity; CRM ownership/submission; activation;
-- communication; outbox; global pause/source revision.  The retained P5 body
-- reacquires a subset of these locks only after this function owns the full set.

alter function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  rename to pursue_cim_authorize_provider_pending_p5_v1;
revoke all on function public.pursue_cim_authorize_provider_pending_p5_v1(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.pursue_cim_canonical_json_v1(p_value jsonb)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_type text;
  v_item jsonb;
  v_key text;
  v_parts text[] := array[]::text[];
begin
  v_type := pg_catalog.jsonb_typeof(p_value);
  if v_type = 'array' then
    for v_item in select value from pg_catalog.jsonb_array_elements(p_value) loop
      v_parts := pg_catalog.array_append(v_parts,
        public.pursue_cim_canonical_json_v1(v_item));
    end loop;
    return '[' || pg_catalog.array_to_string(v_parts, ',') || ']';
  elsif v_type = 'object' then
    for v_key in select key from pg_catalog.jsonb_object_keys(p_value) as key
      order by key collate pg_catalog."C"
    loop
      v_parts := pg_catalog.array_append(v_parts,
        pg_catalog.to_jsonb(v_key)::text || ':' ||
        public.pursue_cim_canonical_json_v1(p_value -> v_key));
    end loop;
    return '{' || pg_catalog.array_to_string(v_parts, ',') || '}';
  end if;
  return p_value::text;
end;
$$;

revoke all on function public.pursue_cim_canonical_json_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_canonical_json_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_read_final_gate_context_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_authorization_id text;
  v_result jsonb;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_authorization_id := public.pursue_cim_required_text_v1(p_command, 'authorizationId', 240);
  select pg_catalog.jsonb_build_object(
    'transmission', pg_catalog.to_jsonb(t),
    'conversation', pg_catalog.to_jsonb(c),
    'authorization', pg_catalog.to_jsonb(a),
    'activation', pg_catalog.to_jsonb(act),
    'safety', pg_catalog.to_jsonb(s),
    'globalAuthorityRevision', g.revision,
    'communication', pg_catalog.to_jsonb(comm) || pg_catalog.jsonb_build_object(
      'tags', coalesce(comm.metadata -> 'tags', '[]'::jsonb),
      'body_text_digest', pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(coalesce(comm.body_text, ''), 'UTF8')), 'hex'),
      'body_html_digest', pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(coalesce(comm.body_html_sanitized, ''), 'UTF8')), 'hex')),
    'outbox', pg_catalog.to_jsonb(o) || pg_catalog.jsonb_build_object(
      'retry_policy', o.metadata ->> 'retryPolicy'),
    'members', coalesce((select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'membership', pg_catalog.to_jsonb(m),
        'touch', pg_catalog.to_jsonb(mt),
        'campaign', pg_catalog.to_jsonb(mc),
        'decision', pg_catalog.to_jsonb(d),
        'enrollment', pg_catalog.to_jsonb(e),
        'opportunity', pg_catalog.to_jsonb(op),
        'timezone', pg_catalog.to_jsonb(tz),
        'crmOwnership', pg_catalog.to_jsonb(cr),
        'crmSubmission', pg_catalog.to_jsonb(cs)) order by m.touch_id)
      from public.deal_hunter_cim_transmission_touches m
      left join public.deal_hunter_cim_campaign_touches mt on mt.id = m.touch_id
      left join public.deal_hunter_cim_campaigns mc on mc.id = m.campaign_id
      left join public.deal_hunter_owner_decision_events d on d.id = mc.decision_event_id
      left join public.deal_hunter_pursuit_enrollments e on e.id = mc.enrollment_id
      left join public.deal_hunter_opportunities op on op.opportunity_id = m.opportunity_id
      left join lateral (select x.* from public.deal_hunter_opportunity_timezone_revisions x
        where x.opportunity_id = m.opportunity_id order by x.revision desc limit 1) tz on true
      left join lateral (select x.revision, x.submission_id
        from public.deal_hunter_crm_ownership_revisions x
        where x.opportunity_id = m.opportunity_id order by x.revision desc limit 1) cr on true
      left join public.contact_submissions cs on cs.id = mc.crm_submission_id
      where m.transmission_id = t.id), '[]'::jsonb)) into v_result
  from public.deal_hunter_cim_transmissions t
  left join public.deal_hunter_broker_conversations c on c.id = t.conversation_id
  left join public.deal_hunter_cim_live_provider_authorizations a
    on a.id = v_authorization_id and a.transmission_id = t.id
  left join public.deal_hunter_cim_capability_activations act on act.id = a.activation_id
  left join public.deal_hunter_cim_safety_settings s on s.id = 'global'
  left join public.deal_hunter_cim_global_authority g on g.id = 'global'
  left join public.crm_communications comm on comm.id = t.communication_id
  left join public.crm_email_outbox o on o.id = t.outbox_id
  where t.id = v_transmission_id;
  return v_result;
end;
$$;

revoke all on function public.pursue_cim_read_final_gate_context_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_read_final_gate_context_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_authorize_provider_pending_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_authorization_id text;
  v_provider_profile text;
  v_gate_digest text;
  v_actor text;
  v_now timestamptz;
  v_expected_global bigint;
  v_expected_row bigint;
  v_snapshot jsonb;
  v_readiness jsonb;
  v_members jsonb;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_communication public.crm_communications%rowtype;
  v_outbox public.crm_email_outbox%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_pause boolean;
  v_global bigint;
  v_member record;
  v_expected_member jsonb;
  v_member_ids text[] := array[]::text[];
  v_reason text;
  v_result jsonb;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_authorization_id := public.pursue_cim_required_text_v1(p_command, 'authorizationId', 240);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_gate_digest := public.pursue_cim_required_text_v1(p_command, 'finalGateAuthorityDigest', 64);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_expected_global := public.pursue_cim_required_revision_v1(
    p_command, 'expectedGlobalAuthorityRevision');
  v_expected_row := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_snapshot := p_command -> 'authoritySnapshot';
  v_readiness := v_snapshot -> 'readiness';
  v_members := v_snapshot -> 'members';

  <<gate>>
  begin
    select * into v_transmission from public.deal_hunter_cim_transmissions
      where id = v_transmission_id for update;
    if not found then v_reason := 'lifecycle_conflict'; exit gate; end if;
    if v_transmission.state <> 'prepared' or v_transmission.invocation_authority_count <> 0 then
      v_reason := 'already_provider_pending'; exit gate;
    end if;
    if v_transmission.row_version <> v_expected_row then
      v_reason := 'stale_authority'; exit gate;
    end if;
    if pg_catalog.jsonb_typeof(v_snapshot) is distinct from 'object'
      or v_snapshot ->> 'version' <> 'cim-final-gate-authority-v1'
      or v_snapshot ->> 'gateInstant' <> (p_command ->> 'now')
      or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        public.pursue_cim_canonical_json_v1(v_snapshot), 'UTF8')), 'hex') <> v_gate_digest
      or pg_catalog.jsonb_typeof(v_members) is distinct from 'array'
      or pg_catalog.jsonb_array_length(v_members) < 1
    then v_reason := 'lifecycle_conflict'; exit gate; end if;
    if v_snapshot #>> '{transmission,id}' is distinct from v_transmission.id
      or (v_snapshot #>> '{transmission,rowVersion}')::bigint <> v_transmission.row_version
      or v_snapshot #>> '{transmission,payloadDigest}' is distinct from v_transmission.payload_digest
      or v_snapshot #>> '{transmission,memberDigest}' is distinct from v_transmission.member_digest
    then v_reason := 'lifecycle_conflict'; exit gate; end if;

    select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
      where id = v_authorization_id for update;
    if not found or v_snapshot #>> '{authorization,id}' is distinct from v_authorization.id
      or v_snapshot #>> '{authorization,activation_id}' is distinct from v_authorization.activation_id
    then v_reason := 'live_authorization_invalid'; exit gate; end if;
    select * into v_conversation from public.deal_hunter_broker_conversations
      where id = v_transmission.conversation_id for update;
    if not found or v_snapshot #>> '{conversation,id}' is distinct from v_conversation.id
      or v_snapshot #>> '{conversation,recipientFingerprint}'
        is distinct from v_conversation.recipient_fingerprint
    then v_reason := 'recipient_authority_changed'; exit gate; end if;

    -- Campaigns precede memberships/touches so terminal writers share this order.
    perform 1 from public.deal_hunter_cim_campaigns c
      join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
      where m.transmission_id = v_transmission_id order by c.id for update of c;
    perform 1 from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
      where m.transmission_id = v_transmission_id order by m.touch_id for update of m,t;
    perform 1 from public.deal_hunter_owner_decision_events d
      join public.deal_hunter_cim_campaigns c on c.decision_event_id = d.id
      join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
      where m.transmission_id = v_transmission_id order by d.id for update of d;
    perform 1 from public.deal_hunter_pursuit_enrollments e
      join public.deal_hunter_cim_campaigns c on c.enrollment_id = e.id
      join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
      where m.transmission_id = v_transmission_id order by e.id for update of e;
    perform 1 from public.deal_hunter_opportunities o
      join public.deal_hunter_cim_transmission_touches m
        on m.opportunity_id = o.opportunity_id
      where m.transmission_id = v_transmission_id order by o.opportunity_id for update of o;
    perform 1 from public.deal_hunter_opportunity_timezone_revisions tz
      join public.deal_hunter_cim_transmission_touches m
        on m.opportunity_id = tz.opportunity_id
      where m.transmission_id = v_transmission_id
      order by tz.opportunity_id, tz.revision for update of tz;
    perform 1 from public.deal_hunter_crm_ownership_revisions cr
      join public.deal_hunter_cim_transmission_touches m
        on m.opportunity_id = cr.opportunity_id
      where m.transmission_id = v_transmission_id
      order by cr.opportunity_id, cr.revision for update of cr;
    perform 1 from public.contact_submissions cs
      join public.deal_hunter_cim_campaigns c on c.crm_submission_id = cs.id
      join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
      where m.transmission_id = v_transmission_id order by cs.id for update of cs;
    select * into v_activation from public.deal_hunter_cim_capability_activations
      where id = v_authorization.activation_id for share;
    if not found then v_reason := 'permission_changed'; exit gate; end if;
    -- This row is later updated by communication/global-authority triggers. Take the
    -- write-strength lock once, after member authority rows, so concurrent gates serialize
    -- without a shared-to-exclusive lock upgrade deadlock.
    select revision into v_global from public.deal_hunter_cim_global_authority
      where id = 'global' for update;
    select outreach_paused into v_pause from public.deal_hunter_cim_safety_settings
      where id = 'global' for share;
    if v_pause is distinct from false then v_reason := 'central_pause'; exit gate; end if;
    if v_global is distinct from v_expected_global
      or (v_snapshot ->> 'globalAuthorityRevision')::bigint is distinct from v_global
    then v_reason := 'freshness_changed'; exit gate; end if;
    for v_member in
      select m.*, t.state as touch_state, t.row_version as touch_row_version,
        t.claim_token_digest, t.claim_expires_at, t.due_at, t.transmission_id as touch_transmission_id,
        t.kind, t.logical_slot, t.ordinal, t.timezone_revision as touch_timezone_revision,
        c.generation, c.policy_version, c.state as campaign_state,
        c.terminal_revision, c.row_version as campaign_row_version, c.conversation_id,
        c.crm_submission_id, c.crm_ownership_revision, c.recipient_fingerprint,
        c.discovery_revision, c.material_revision, c.timezone_revision,
        c.local_expiry_at, c.decision_event_id, c.enrollment_id,
        c.permission_digest, c.permission_revision, c.permission_scope,
        o.status as opportunity_status, o.primary_submission_id,
        o.discovery_state, o.discovery_revision as current_discovery_revision,
        o.material_revision as current_material_revision,
        o.campaign_authority_revision, d.action as owner_action,
        e.state as enrollment_state, e.row_version as enrollment_row_version,
        cr.revision as current_crm_revision, cr.submission_id as current_crm_submission,
        cs.archived_at, cs.deal_hunter_opportunity_id, cs.metadata as submission_metadata
      from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
      join public.deal_hunter_cim_campaigns c on c.id = m.campaign_id
      join public.deal_hunter_opportunities o on o.opportunity_id = m.opportunity_id
      join public.deal_hunter_owner_decision_events d on d.id = c.decision_event_id
      join public.deal_hunter_pursuit_enrollments e on e.id = c.enrollment_id
      left join lateral (select x.revision, x.submission_id
        from public.deal_hunter_crm_ownership_revisions x
        where x.opportunity_id = m.opportunity_id order by x.revision desc limit 1) cr on true
      left join public.contact_submissions cs on cs.id = c.crm_submission_id
      where m.transmission_id = v_transmission_id and m.cancelled_at is null
      order by m.touch_id
    loop
      v_member_ids := pg_catalog.array_append(v_member_ids, v_member.touch_id);
      select value into v_expected_member from pg_catalog.jsonb_array_elements(v_members)
        where value #>> '{touch,id}' = v_member.touch_id limit 1;
      if v_expected_member is null then v_reason := 'membership_changed'; exit gate; end if;
      if v_member.kind <> 'initial' or v_member.logical_slot <> 'initial' or v_member.ordinal <> 0
        or v_member.generation <> 1
        or v_member.policy_version <> 'deal-hunter-cim-autopilot-v1'
        or v_member.campaign_state <> 'initial-pending'
        or v_member.touch_timezone_revision <> v_member.timezone_revision
      then v_reason := 'lifecycle_conflict'; exit gate; end if;
      if (v_expected_member #>> '{campaign,row_version}')::bigint
          is distinct from v_member.campaign_row_version
        or v_expected_member #>> '{campaign,permission_digest}'
          is distinct from v_member.permission_digest
        or (v_expected_member #>> '{campaign,permission_revision}')::bigint
          is distinct from v_member.permission_revision
        or v_expected_member #>> '{campaign,permission_scope}'
          is distinct from v_member.permission_scope
        or v_activation.permission_basis_digest is distinct from v_member.permission_digest
        or v_activation.permission_revision is distinct from v_member.permission_revision
        or v_activation.cohort_digest is distinct from v_member.permission_scope
      then v_reason := 'permission_changed'; exit gate; end if;
      if v_member.owner_action <> 'pursue' or v_member.enrollment_state <> 'campaign-created'
        or v_expected_member #>> '{decision,id}' is distinct from v_member.decision_event_id
        or v_expected_member #>> '{enrollment,id}' is distinct from v_member.enrollment_id
        or (v_expected_member #>> '{enrollment,row_version}')::bigint
          <> v_member.enrollment_row_version
      then v_reason := 'owner_intent_changed'; exit gate; end if;
      if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          public.pursue_cim_canonical_json_v1(
            (v_expected_member -> 'recipientAuthority') - 'authorityDigest'), 'UTF8')), 'hex')
          is distinct from v_expected_member #>> '{recipientAuthority,authorityDigest}'
        or coalesce((v_expected_member #>> '{recipientAuthority,present}')::boolean, false)
          is distinct from true
        or v_expected_member #>> '{recipientAuthority,derivedRecipientFingerprint}'
          is distinct from v_member.recipient_fingerprint
        or v_member.recipient_fingerprint is distinct from
          v_authorization.recipient_authority_digest
      then v_reason := 'recipient_authority_changed'; exit gate; end if;
      if exists (select 1 from public.deal_hunter_owner_decision_events x
        where x.opportunity_id = v_member.opportunity_id
          and (x.created_at, x.id) > ((select created_at
            from public.deal_hunter_owner_decision_events where id = v_member.decision_event_id),
            v_member.decision_event_id))
      then v_reason := 'owner_intent_changed'; exit gate; end if;
      if v_member.opportunity_status <> 'active' then
        v_reason := 'identity_authority_changed'; exit gate;
      end if;
      if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          public.pursue_cim_canonical_json_v1(
            (v_expected_member -> 'sourceAuthority') - 'authorityDigest'), 'UTF8')), 'hex')
          is distinct from v_expected_member #>> '{sourceAuthority,authorityDigest}'
        or coalesce((v_expected_member #>> '{sourceAuthority,ready}')::boolean, false) is distinct from true
        or (v_expected_member #>> '{sourceAuthority,globalAuthorityRevision}')::bigint
          <> v_expected_global
        or (v_expected_member #>> '{sourceAuthority,opportunity,campaignAuthorityRevision}')::bigint
          <> v_member.campaign_authority_revision
        or not exists (select 1 from public.deal_hunter_opportunity_source_observations x
          where x.opportunity_id = v_member.opportunity_id and x.accepted_at is not null)
        or exists (select 1 from public.deal_hunter_source_freshness_state x
          where x.projection_state <> 'accepted')
      then v_reason := 'source_authority_unavailable'; exit gate; end if;
      if v_member.discovery_state = 'pending'
        or v_member.current_discovery_revision <> v_member.discovery_revision
        or v_member.current_material_revision <> v_member.material_revision
      then v_reason := 'freshness_changed'; exit gate; end if;
      if exists (select 1 from public.deal_hunter_identity_exceptions x
        where x.status = 'open' and x.candidate_opportunity_ids ? v_member.opportunity_id)
      then v_reason := 'identity_authority_changed'; exit gate; end if;
      if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          public.pursue_cim_canonical_json_v1(
            (v_expected_member -> 'materialsAuthority') - 'authorityDigest'), 'UTF8')), 'hex')
          is distinct from v_expected_member #>> '{materialsAuthority,authorityDigest}'
      then v_reason := 'source_authority_unavailable'; exit gate; end if;
      if coalesce((v_expected_member #>> '{materialsAuthority,priorRequestPresent}')::boolean, false)
        or exists (select 1 from public.deal_hunter_cim_requests x
          where x.opportunity_id = v_member.opportunity_id
            or x.deal_key in (select s.deal_key from public.deal_hunter_opportunity_scores s
              where s.opportunity_id = v_member.opportunity_id))
        or exists (select 1 from public.deal_hunter_cim_opportunity_claims x
          where x.opportunity_id = v_member.opportunity_id)
      then v_reason := 'lifecycle_conflict'; exit gate; end if;
      if coalesce((v_expected_member #>> '{materialsAuthority,pursued}')::boolean, false)
          is distinct from true
        or v_expected_member #>> '{materialsAuthority,disposition}' = 'dismissed'
      then v_reason := 'owner_intent_changed'; exit gate; end if;
      if coalesce((v_expected_member #>> '{materialsAuthority,suppressionPresent}')::boolean, false)
      then v_reason := 'recipient_suppressed'; exit gate; end if;
      if coalesce(v_expected_member #>> '{materialsAuthority,terminalReason}', '') <> ''
      then v_reason := 'terminal_authority_changed'; exit gate; end if;
      if pg_catalog.jsonb_array_length(coalesce(
          v_expected_member #> '{materialsAuthority,preparationBlockerCodes}', '[]'::jsonb)) > 0
      then v_reason := 'source_authority_unavailable'; exit gate; end if;
      if coalesce((v_expected_member #>> '{materialsAuthority,materialsReceived}')::boolean, false)
        or coalesce((v_expected_member #>> '{materialsAuthority,advancedBeyondBrokerOutreach}')::boolean, false)
        or exists (select 1 from public.secure_documents x
          where x.submission_id = v_member.crm_submission_id)
        or exists (select 1 from public.secure_upload_requests x
          where x.submission_id = v_member.crm_submission_id
            and (x.last_uploaded_at is not null or x.status in ('completed','closed')))
        or exists (select 1 from public.contact_submissions x where x.id = v_member.crm_submission_id
          and nullif(pg_catalog.btrim(x.prospectus_url), '') is not null)
        or pg_catalog.replace(pg_catalog.lower(coalesce(
          v_member.submission_metadata #>> '{diligence,stage}', '')), '_', '-')
          in ('cim-received', 'financial-review', 'lender-review', 'loi-candidate')
        or pg_catalog.replace(pg_catalog.lower(coalesce(
          v_member.submission_metadata #>> '{acquisitionCommand,pipelineStage}', '')), '_', '-')
          in ('docs-received', 'diligence', 'loi-candidate')
        or v_member.submission_metadata #> '{diligence,checklist,cim}' = 'true'::jsonb
        or v_member.submission_metadata #> '{diligence,checklist,p_and_l}' = 'true'::jsonb
        or v_member.submission_metadata #> '{diligence,checklist,tax_returns}' = 'true'::jsonb
        or v_member.submission_metadata #> '{diligence,checklist,balance_sheet}' = 'true'::jsonb
      then v_reason := 'materials_received'; exit gate; end if;
      if v_member.archived_at is not null
        or v_member.deal_hunter_opportunity_id <> v_member.opportunity_id
        or v_member.primary_submission_id::text <> v_member.crm_submission_id::text
        or v_member.current_crm_submission::text <> v_member.crm_submission_id::text
        or v_member.current_crm_revision <> v_member.crm_ownership_revision
        or exists (select 1 from public.crm_submission_supersessions x
          where x.superseded_submission_id::text = v_member.crm_submission_id::text
            and x.status = 'active')
      then v_reason := 'crm_owner_changed'; exit gate; end if;
    end loop;
    if pg_catalog.cardinality(v_member_ids) <> pg_catalog.jsonb_array_length(v_members)
      or v_transmission.member_digest <> public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-members:v1'::text), pg_catalog.to_jsonb(v_member_ids))
    then v_reason := 'membership_changed'; exit gate; end if;

    select * into v_communication from public.crm_communications
      where id = v_transmission.communication_id for update;
    select * into v_outbox from public.crm_email_outbox
      where id = v_transmission.outbox_id for update;
    if not found then v_reason := 'outbox_changed'; exit gate; end if;
    if pg_catalog.jsonb_typeof(v_readiness) is distinct from 'object'
      or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        public.pursue_cim_canonical_json_v1(v_readiness - 'authorityDigest'), 'UTF8')), 'hex')
        is distinct from v_readiness ->> 'authorityDigest'
      or coalesce((v_readiness ->> 'ready')::boolean, false) is distinct from true
      or v_readiness ->> 'version' <> 'cim-provider-readiness-v1'
      or v_readiness ->> 'providerProfile' <> v_provider_profile
      or (v_readiness ->> 'expiresAt')::timestamptz <= v_now
    then v_reason := 'provider_readiness_unavailable'; exit gate; end if;
    if exists (select 1 from public.crm_communications x where x.direction = 'inbound'
      and (x.thread_key = v_conversation.rfc_thread_key
        or x.submission_id = any(array(select c.crm_submission_id
          from public.deal_hunter_cim_campaigns c
          join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
          where m.transmission_id = v_transmission_id))))
    then v_reason := 'reply_received'; exit gate; end if;
    if v_communication.direction <> 'outbound' or v_communication.channel <> 'email'
      or v_communication.source <> 'pursue-cim-autopilot'
      or v_communication.kind <> 'cim-initial'
      or v_communication.thread_key <> v_conversation.rfc_thread_key
      or v_communication.from_address <> v_transmission.from_address
      or v_communication.to_addresses <> v_transmission.to_addresses
      or v_communication.cc_addresses <> v_transmission.cc_addresses
      or v_communication.bcc_addresses <> v_transmission.bcc_addresses
      or v_communication.reply_to_address <> v_transmission.reply_to_address
      or v_communication.subject <> v_transmission.subject
    then v_reason := 'communication_changed'; exit gate; end if;
    if v_outbox.state <> 'prepared' or v_outbox.attempt_count <> 0
      or v_outbox.claim_token is not null or v_outbox.provider is not null
      or v_outbox.provider_message_id is not null or v_outbox.next_attempt_at is not null
      or v_outbox.metadata ->> 'retryPolicy' <> 'reconcile-only-after-provider-pending'
    then v_reason := 'outbox_changed'; exit gate; end if;
  end gate;

  if v_reason is not null then
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, conversation_id, transmission_id, prior_state, next_state,
       reason_code, authority_digest, payload_digest, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-final-gate-block:v1'::text),
        pg_catalog.to_jsonb(v_transmission_id), pg_catalog.to_jsonb(v_transmission.row_version),
        pg_catalog.to_jsonb(v_reason), pg_catalog.to_jsonb(v_gate_digest)),
      'final-gate-blocked', v_transmission.conversation_id, v_transmission_id,
      v_transmission.state, v_transmission.state, v_reason, v_gate_digest,
      v_transmission.payload_digest, v_actor, 'postgres-transition', v_now, '{}'::jsonb)
    on conflict (id) do nothing;
    return pg_catalog.jsonb_build_object('authorized', false, 'blockedReason', v_reason,
      'transmission', pg_catalog.to_jsonb(v_transmission), 'boundaryNonceDigest', null);
  end if;
  v_result := public.pursue_cim_authorize_provider_pending_p5_v1(p_command);
  if coalesce((v_result ->> 'authorized')::boolean, false) is distinct from true then
    v_reason := coalesce(v_result ->> 'blockedReason', 'lifecycle_conflict');
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, conversation_id, transmission_id, prior_state, next_state,
       reason_code, authority_digest, payload_digest, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-final-gate-block:v1'::text),
        pg_catalog.to_jsonb(v_transmission_id), pg_catalog.to_jsonb(v_transmission.row_version),
        pg_catalog.to_jsonb(v_reason), pg_catalog.to_jsonb(v_gate_digest)),
      'final-gate-blocked', v_transmission.conversation_id, v_transmission_id,
      v_transmission.state, v_transmission.state, v_reason, v_gate_digest,
      v_transmission.payload_digest, v_actor, 'postgres-transition', v_now, '{}'::jsonb)
    on conflict (id) do nothing;
  end if;
  return v_result;
end;
$$;

revoke all on function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  to service_role;
-- Package 5: bounded initial-touch discovery and pre-provider isolation.

create or replace function public.pursue_cim_list_due_initial_touches_v1(
  p_now timestamptz, p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_now is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid Pursue CIM due selection';
  end if;
  if public.pursue_cim_current_activation_v1('fl04b-initial', p_now) is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(due) order by due.due_at, due.touch_id)
    from (
      select t.id as touch_id, t.campaign_id, t.opportunity_id, t.kind,
        t.state, t.due_at, t.row_version, t.claim_expires_at,
        c.terminal_revision as campaign_terminal_revision,
        v.terminal_revision as conversation_terminal_revision,
        c.crm_submission_id, c.recipient_fingerprint as campaign_recipient_fingerprint,
        v.recipient_fingerprint as conversation_recipient_fingerprint,
        v.recipient_address
      from public.deal_hunter_cim_campaign_touches as t
      join public.deal_hunter_cim_campaigns as c on c.id = t.campaign_id
      join public.deal_hunter_broker_conversations as v on v.id = c.conversation_id
      where t.kind = 'initial' and t.logical_slot = 'initial' and t.ordinal = 0
        and c.generation = 1 and c.policy_version = 'deal-hunter-cim-autopilot-v1'
        and c.state = 'initial-pending' and v.state = 'open'
        and t.opportunity_id = c.opportunity_id
        and t.due_at <= p_now
        and (c.local_expiry_at is null or c.local_expiry_at > p_now)
        and t.transmission_id is null
        and (t.state = 'scheduled' or (t.state = 'claimed'
          and t.claim_expires_at is not null and t.claim_expires_at <= p_now))
        and t.timezone_revision = c.timezone_revision
      order by t.due_at, t.id
      limit p_limit
    ) as due
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pursue_cim_list_due_initial_touches_v1(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_list_due_initial_touches_v1(timestamptz, integer)
  to service_role;


-- Harden existing claim authorities without changing unrelated outbox behavior.

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
  where id = p_id
    and not exists (select 1 from public.crm_communications as communication
      where communication.id = public.crm_email_outbox.communication_id
        and communication.source = 'pursue-cim-autopilot')
    and (
    state = 'queued'
    or (state = 'retryable_failed' and (next_attempt_at is null or next_attempt_at <= p_claimed_at))
    or (state = 'sending' and claim_expires_at is not null and claim_expires_at <= p_claimed_at)
  ) returning * into v_outbox;
  if found then return jsonb_build_object('claimed', true, 'outbox', to_jsonb(v_outbox)); end if;
  select * into v_outbox from public.crm_email_outbox where id = p_id;
  return jsonb_build_object('claimed', false, 'outbox', to_jsonb(v_outbox));
end;
$$;

create or replace function public.pursue_cim_claim_due_touch_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touch_id text := p_command ->> 'touchId';
  v_claim_digest text := p_command ->> 'claimTokenDigest';
  v_owner text := p_command ->> 'claimOwner';
  v_now timestamptz;
  v_expires timestamptz;
  v_expected bigint;
  v_campaign_terminal bigint;
  v_conversation_terminal bigint;
  v_campaign_id text;
  v_conversation_id text;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_capability text;
  v_prior_state text;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['touchId','claimTokenDigest','claimOwner','claimExpiresAt','now'],
    array['expectedRowVersion','expectedCampaignTerminalRevision',
      'expectedConversationTerminalRevision']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_touch_id is null or pg_catalog.length(v_touch_id) not between 1 and 240
    or pg_catalog.btrim(v_touch_id) <> v_touch_id
    or v_claim_digest !~ '^[0-9a-f]{64}$'
    or v_owner is null or pg_catalog.length(v_owner) not between 1 and 200
    or pg_catalog.btrim(v_owner) <> v_owner
    or p_command ->> 'expectedRowVersion' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'expectedCampaignTerminalRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'expectedConversationTerminalRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'now' is null or p_command ->> 'claimExpiresAt' is null
  then
    raise exception 'Invalid Pursue CIM touch claim command';
  end if;
  v_expected := (p_command ->> 'expectedRowVersion')::bigint;
  v_campaign_terminal := (p_command ->> 'expectedCampaignTerminalRevision')::bigint;
  v_conversation_terminal := (p_command ->> 'expectedConversationTerminalRevision')::bigint;
  if v_expected > 9007199254740991 or v_campaign_terminal > 9007199254740991
    or v_conversation_terminal > 9007199254740991 then
    raise exception 'Unsafe Pursue CIM revision';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_expires := public.pursue_cim_required_instant_v1(p_command, 'claimExpiresAt');
  select campaign_id into v_campaign_id from public.deal_hunter_cim_campaign_touches
    where id = v_touch_id;
  if not found then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true, 'touch', null);
  end if;
  select conversation_id into v_conversation_id from public.deal_hunter_cim_campaigns
    where id = v_campaign_id;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_conversation_id for update;
  select * into v_campaign from public.deal_hunter_cim_campaigns
    where id = v_campaign_id for update;
  select * into v_touch from public.deal_hunter_cim_campaign_touches
    where id = v_touch_id for update;
  if v_campaign.terminal_revision <> v_campaign_terminal
    or v_conversation.terminal_revision <> v_conversation_terminal
    or v_touch.timezone_revision <> v_campaign.timezone_revision
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', true, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.opportunity_id <> v_campaign.opportunity_id then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', true, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_campaign.state not in ('initial-pending','active-follow-up')
    or (v_touch.kind = 'initial' and (v_campaign.state <> 'initial-pending'
      or v_campaign.generation <> 1
      or v_campaign.policy_version <> 'deal-hunter-cim-autopilot-v1'
      or v_touch.logical_slot <> 'initial' or v_touch.ordinal <> 0))
    or v_conversation.state <> 'open'
    or (v_campaign.local_expiry_at is not null and v_campaign.local_expiry_at <= v_now)
    or v_touch.state in ('provider-pending','accepted','definitive-failure',
      'ambiguous','cancelled-before-provider')
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', true, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  v_capability := case when v_touch.kind = 'initial' then 'fl04b-initial'
    else 'fl04c-followup' end;
  if public.pursue_cim_current_activation_v1(v_capability, v_now) is null then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', true, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.transmission_id is not null then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if exists (select 1 from public.deal_hunter_cim_transmission_touches
      where touch_id = v_touch_id) then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.state = 'claimed' and v_touch.claim_token_digest = v_claim_digest
    and v_touch.claim_owner = v_owner
  then
    return pg_catalog.jsonb_build_object('claimed', false,
      'alreadyOwned', v_touch.claim_expires_at is not null and v_touch.claim_expires_at > v_now,
      'staleAuthority', false, 'terminal', false,
      'conflict', v_touch.claim_expires_at is null or v_touch.claim_expires_at <= v_now,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.state = 'claimed'
    and (v_touch.claim_expires_at is null or v_touch.claim_expires_at > v_now)
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.row_version <> v_expected then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', true, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.due_at > v_now or v_expires <= v_now then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  v_prior_state := v_touch.state;
  update public.deal_hunter_cim_campaign_touches
    set state = 'claimed', claim_token_digest = v_claim_digest, claim_owner = v_owner,
      claimed_at = v_now, claim_expires_at = v_expires, updated_at = v_now,
      row_version = row_version + 1
    where id = v_touch_id and row_version = v_expected and state in ('scheduled','claimed')
    returning * into v_touch;
  if not found then
    raise exception 'Concurrent Pursue CIM touch claim';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
     prior_state, next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('touch-claimed'::text),
      pg_catalog.to_jsonb(v_touch_id || ':' || (v_expected + 1)::text)),
    'touch-claimed', v_touch.opportunity_id, v_campaign.id, v_conversation.id,
    v_touch_id, v_prior_state,
    'claimed', v_owner, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('claimed', true, 'alreadyOwned', false,
    'staleAuthority', false, 'terminal', false, 'conflict', false,
    'touch', pg_catalog.to_jsonb(v_touch));
end;
$$;


-- Recheck locked current CRM primary at immutable preparation.

create or replace function public.pursue_cim_prepare_transmission_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touch_ids text[];
  v_touch_id text;
  v_touches public.deal_hunter_cim_campaign_touches[] := array[]::public.deal_hunter_cim_campaign_touches[];
  v_campaigns public.deal_hunter_cim_campaigns[] := array[]::public.deal_hunter_cim_campaigns[];
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_crm_owner public.contact_submissions%rowtype;
  v_primary_submission public.deal_hunter_opportunities.primary_submission_id%type;
  v_current public.deal_hunter_cim_transmissions%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_current_members text[];
  v_claim_digest text;
  v_expected_campaign bigint;
  v_expected_conversation bigint;
  v_generation bigint;
  v_payload_version text;
  v_from text;
  v_reply_to text;
  v_subject text;
  v_body_text text;
  v_body_html text;
  v_actor text;
  v_now timestamptz;
  v_to jsonb := p_command -> 'toAddresses';
  v_cc jsonb := p_command -> 'ccAddresses';
  v_bcc jsonb := p_command -> 'bccAddresses';
  v_tags jsonb := p_command -> 'tags';
  v_array jsonb;
  v_item jsonb;
  v_templates text[] := array[]::text[];
  v_campaign_ids text[] := array[]::text[];
  v_conversation_ids text[] := array[]::text[];
  v_campaign_id text;
  v_conversation_id text;
  v_lock_id text;
  v_payload_digest text;
  v_member_digest text;
  v_transmission_id text;
  v_communication_id text;
  v_outbox_id text;
  v_provider_key text;
  v_metadata jsonb;
  v_capability text;
  v_index integer;
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or pg_catalog.jsonb_typeof(p_command -> 'touchIds') <> 'array'
    or pg_catalog.jsonb_array_length(p_command -> 'touchIds') not between 1 and 50
    or pg_catalog.jsonb_typeof(v_to) <> 'array'
    or pg_catalog.jsonb_array_length(v_to) <> 1
    or pg_catalog.jsonb_typeof(v_cc) <> 'array'
    or pg_catalog.jsonb_array_length(v_cc) > 20
    or pg_catalog.jsonb_typeof(v_bcc) <> 'array'
    or pg_catalog.jsonb_array_length(v_bcc) > 20
    or pg_catalog.jsonb_typeof(v_tags) <> 'array'
    or pg_catalog.jsonb_array_length(v_tags) > 30
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM transmission membership or addresses';
  end if;
  select pg_catalog.array_agg(value order by value) into v_touch_ids
    from pg_catalog.jsonb_array_elements_text(p_command -> 'touchIds') as value;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_command -> 'touchIds') as item
      where pg_catalog.jsonb_typeof(item.value) <> 'string') then
    raise exception 'Invalid Pursue CIM transmission member type';
  end if;
  if (select count(distinct value) from pg_catalog.unnest(v_touch_ids) as value)
       <> pg_catalog.array_length(v_touch_ids, 1)
  then
    raise exception 'Duplicate Pursue CIM transmission member';
  end if;
  foreach v_touch_id in array v_touch_ids loop
    if pg_catalog.length(v_touch_id) not between 1 and 240
      or pg_catalog.btrim(v_touch_id) <> v_touch_id then
      raise exception 'Invalid Pursue CIM transmission member';
    end if;
  end loop;
  foreach v_array in array array[v_to,v_cc,v_bcc] loop
    for v_item in select value from pg_catalog.jsonb_array_elements(v_array) loop
      if pg_catalog.jsonb_typeof(v_item) <> 'string'
        or pg_catalog.length(v_item #>> '{}') not between 1 and 320
        or pg_catalog.btrim(v_item #>> '{}') <> v_item #>> '{}' then
        raise exception 'Invalid Pursue CIM transmission address';
      end if;
    end loop;
  end loop;
  for v_item in select value from pg_catalog.jsonb_array_elements(v_tags) loop
    if pg_catalog.jsonb_typeof(v_item) <> 'string'
      or pg_catalog.length(v_item #>> '{}') not between 1 and 120 then
      raise exception 'Invalid Pursue CIM transmission tag';
    end if;
  end loop;
  v_claim_digest := public.pursue_cim_required_text_v1(p_command, 'claimTokenDigest', 64);
  if v_claim_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Pursue CIM transmission claim digest';
  end if;
  v_expected_campaign := public.pursue_cim_required_revision_v1(
    p_command, 'expectedCampaignTerminalRevision');
  v_expected_conversation := public.pursue_cim_required_revision_v1(
    p_command, 'expectedConversationTerminalRevision');
  v_generation := public.pursue_cim_required_revision_v1(p_command, 'preparationGeneration');
  if v_generation < 1 then
    raise exception 'Invalid Pursue CIM preparation generation';
  end if;
  v_payload_version := public.pursue_cim_required_text_v1(p_command, 'payloadVersion', 120);
  v_from := public.pursue_cim_required_text_v1(p_command, 'fromAddress', 320);
  v_reply_to := public.pursue_cim_required_text_v1(p_command, 'replyToAddress', 320);
  v_subject := public.pursue_cim_required_text_v1(p_command, 'subject', 998);
  v_body_text := public.pursue_cim_required_text_v1(p_command, 'bodyText', 100000);
  v_body_html := public.pursue_cim_required_text_v1(p_command, 'bodyHtmlSanitized', 100000);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  -- Follow the claim and terminal-transition lock order. Read immutable IDs first,
  -- then lock all conversations, campaigns, and touches in deterministic order.
  for v_index in 1..pg_catalog.array_length(v_touch_ids, 1) loop
    select t.campaign_id, c.conversation_id into v_campaign_id, v_conversation_id
      from public.deal_hunter_cim_campaign_touches as t
      join public.deal_hunter_cim_campaigns as c on c.id = t.campaign_id
      where t.id = v_touch_ids[v_index];
    if not found then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true, 'transmission', null);
    end if;
    v_campaign_ids := pg_catalog.array_append(v_campaign_ids, v_campaign_id);
    v_conversation_ids := pg_catalog.array_append(v_conversation_ids, v_conversation_id);
  end loop;
  for v_lock_id in select distinct id from pg_catalog.unnest(v_conversation_ids) as id
    order by id loop
    perform 1 from public.deal_hunter_broker_conversations
      where id = v_lock_id for update;
    if not found then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true, 'transmission', null);
    end if;
  end loop;
  for v_lock_id in select distinct id from pg_catalog.unnest(v_campaign_ids) as id
    order by id loop
    perform 1 from public.deal_hunter_cim_campaigns
      where id = v_lock_id for update;
    if not found then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true, 'transmission', null);
    end if;
  end loop;
  for v_index in 1..pg_catalog.array_length(v_touch_ids, 1) loop
    select * into v_touch from public.deal_hunter_cim_campaign_touches
      where id = v_touch_ids[v_index] for update;
    if not found then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true, 'transmission', null);
    end if;
    v_touches := pg_catalog.array_append(v_touches, v_touch);
    select * into v_campaign from public.deal_hunter_cim_campaigns
      where id = v_campaign_ids[v_index];
    if not found or v_touch.campaign_id <> v_campaign.id
      or v_touch.opportunity_id <> v_campaign.opportunity_id then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true, 'transmission', null);
    end if;
    v_campaigns := pg_catalog.array_append(v_campaigns, v_campaign);
    v_templates := pg_catalog.array_append(v_templates, v_campaign.template_version);
  end loop;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_conversation_ids[1];
  v_payload_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-payload:v1'::text), pg_catalog.to_jsonb(v_from),
    v_to, v_cc, v_bcc, pg_catalog.to_jsonb(v_reply_to),
    pg_catalog.to_jsonb(v_subject), pg_catalog.to_jsonb(v_body_text),
    pg_catalog.to_jsonb(v_body_html), v_tags, pg_catalog.to_jsonb(v_touch_ids),
    pg_catalog.to_jsonb(v_templates), pg_catalog.to_jsonb(v_payload_version));
  v_capability := case when pg_catalog.array_length(v_touch_ids, 1) > 1
    then 'fl04c-batch' when v_touches[1].kind = 'initial'
    then 'fl04b-initial' else 'fl04c-followup' end;
  select tr.* into v_current from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_transmissions as tr on tr.id = m.transmission_id
    where m.touch_id = v_touch_ids[1] and m.cancelled_at is null for update of tr;
  if found then
    select pg_catalog.array_agg(touch_id order by touch_id) into v_current_members
      from public.deal_hunter_cim_transmission_touches
      where transmission_id = v_current.id and cancelled_at is null;
    if v_current_members is distinct from v_touch_ids then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', true, 'terminal', false,
        'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    if v_current.payload_digest = v_payload_digest then
      return pg_catalog.jsonb_build_object('prepared', false,
        'existing', v_generation = v_current.preparation_generation,
        'payloadConflict', v_generation <> v_current.preparation_generation,
        'terminal', false, 'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    if v_generation <> v_current.preparation_generation + 1 then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', true, 'terminal', false,
        'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    if public.pursue_cim_current_activation_v1(v_capability, v_now) is null
      or v_conversation.id is null or v_conversation.state <> 'open'
      or v_conversation.terminal_revision <> v_expected_conversation
      or v_conversation.recipient_address <> v_to ->> 0
    then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true,
        'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    for v_index in 1..pg_catalog.array_length(v_touches, 1) loop
      v_touch := v_touches[v_index];
      v_campaign := v_campaigns[v_index];
      if v_campaign.conversation_id <> v_conversation.id
        or v_campaign.terminal_revision <> v_expected_campaign
        or v_campaign.state not in ('initial-pending','active-follow-up')
        or (v_touch.kind = 'initial' and (v_campaign.state <> 'initial-pending'
          or v_campaign.generation <> 1
          or v_campaign.policy_version <> 'deal-hunter-cim-autopilot-v1'
          or v_touch.logical_slot <> 'initial' or v_touch.ordinal <> 0))
        or v_campaign.crm_submission_id is null
        or (v_campaign.local_expiry_at is not null and v_campaign.local_expiry_at <= v_now)
        or v_touch.state <> 'claimed'
        or v_touch.claim_token_digest <> v_claim_digest
        or v_touch.claim_expires_at is null or v_touch.claim_expires_at <= v_now
        or v_touch.transmission_id is distinct from v_current.id
      then
        return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
          'payloadConflict', false, 'terminal', true,
          'transmission', pg_catalog.to_jsonb(v_current));
      end if;
    end loop;
    select primary_submission_id into v_primary_submission
      from public.deal_hunter_opportunities
      where opportunity_id = v_campaigns[1].opportunity_id for update;
    select * into v_crm_owner from public.contact_submissions
      where id = v_campaigns[1].crm_submission_id for update;
    if not found or v_crm_owner.deal_hunter_opportunity_id <> v_campaigns[1].opportunity_id
      or v_crm_owner.archived_at is not null
      or v_primary_submission is distinct from v_crm_owner.id
    then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true,
        'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    if not public.pursue_cim_cancel_prepared_transmission_v1(
      v_current.id, v_now, 'prepared-payload-changed', v_actor, true)
    then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', true, 'terminal', false,
        'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    for v_index in 1..pg_catalog.array_length(v_touches, 1) loop
      v_touches[v_index].transmission_id := null;
    end loop;
  end if;
  if public.pursue_cim_current_activation_v1(v_capability, v_now) is null
    or v_conversation.id is null or v_conversation.state <> 'open'
    or v_conversation.terminal_revision <> v_expected_conversation
    or v_conversation.recipient_address <> v_to ->> 0
  then
    return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
      'payloadConflict', false, 'terminal', true, 'transmission', null);
  end if;
  for v_index in 1..pg_catalog.array_length(v_touches, 1) loop
    v_touch := v_touches[v_index];
    v_campaign := v_campaigns[v_index];
    if v_campaign.conversation_id <> v_conversation.id
      or v_campaign.terminal_revision <> v_expected_campaign
      or v_campaign.state not in ('initial-pending','active-follow-up')
      or (v_touch.kind = 'initial' and (v_campaign.state <> 'initial-pending'
        or v_campaign.generation <> 1
        or v_campaign.policy_version <> 'deal-hunter-cim-autopilot-v1'
        or v_touch.logical_slot <> 'initial' or v_touch.ordinal <> 0))
      or v_campaign.crm_submission_id is null
      or (v_campaign.local_expiry_at is not null and v_campaign.local_expiry_at <= v_now)
      or v_touch.state <> 'claimed'
      or v_touch.claim_token_digest <> v_claim_digest
      or v_touch.transmission_id is not null
      or v_touch.claim_expires_at is null or v_touch.claim_expires_at <= v_now
    then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true, 'transmission', null);
    end if;
  end loop;
  select primary_submission_id into v_primary_submission
    from public.deal_hunter_opportunities
    where opportunity_id = v_campaigns[1].opportunity_id for update;
  select * into v_crm_owner from public.contact_submissions
    where id = v_campaigns[1].crm_submission_id for update;
  if not found or v_crm_owner.deal_hunter_opportunity_id <> v_campaigns[1].opportunity_id
    or v_crm_owner.archived_at is not null
    or v_primary_submission is distinct from v_crm_owner.id
  then
    return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
      'payloadConflict', false, 'terminal', true, 'transmission', null);
  end if;
  v_member_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-members:v1'::text), pg_catalog.to_jsonb(v_touch_ids));
  v_transmission_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-transmission:v1'::text),
    pg_catalog.to_jsonb(v_campaigns[1].policy_version),
    pg_catalog.to_jsonb(v_conversation.recipient_fingerprint),
    pg_catalog.to_jsonb(v_touch_ids), pg_catalog.to_jsonb(v_generation),
    pg_catalog.to_jsonb(v_payload_version), pg_catalog.to_jsonb(v_payload_digest));
  v_communication_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('crm-communication:cim-autopilot:v1'::text),
    pg_catalog.to_jsonb(v_transmission_id));
  v_outbox_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('crm-outbox:cim-autopilot:v1'::text),
    pg_catalog.to_jsonb(v_transmission_id));
  v_provider_key := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-provider:v1'::text),
    pg_catalog.to_jsonb(v_transmission_id), pg_catalog.to_jsonb(v_payload_digest));
  v_metadata := pg_catalog.jsonb_build_object('transmissionId', v_transmission_id,
    'campaignIds', pg_catalog.to_jsonb(v_campaign_ids), 'tags', v_tags,
    'retryPolicy', 'reconcile-only-after-provider-pending');
  insert into public.crm_communications
    (id, submission_id, opportunity_id, direction, channel, source, kind,
     idempotency_key, outbox_id, thread_key, from_address, to_addresses,
     cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
     body_html_sanitized, occurred_at, created_at, updated_at, metadata)
  values (v_communication_id, v_crm_owner.id, v_campaigns[1].opportunity_id,
    'outbound', 'email', 'pursue-cim-autopilot',
    case when v_touches[1].kind = 'initial' then 'cim-initial' else 'cim-follow-up' end,
    v_communication_id, v_outbox_id, v_conversation.rfc_thread_key,
    v_from, v_to, v_cc, v_bcc, v_reply_to, v_subject, v_body_text,
    v_body_html, v_now, v_now, v_now, v_metadata);
  insert into public.crm_email_outbox
    (id, communication_id, submission_id, idempotency_key, client_request_key,
     state, attempt_count, expected_submission_version, actor, created_at, updated_at, metadata)
  values (v_outbox_id, v_communication_id, v_crm_owner.id, v_outbox_id,
    public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-client-request:v1'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'prepared', 0, v_crm_owner.updated_at, v_actor, v_now, v_now, v_metadata);
  insert into public.deal_hunter_cim_transmissions
    (id, conversation_id, member_digest, preparation_generation, payload_version,
     payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
     reply_to_address, subject, provider_idempotency_key, communication_id,
     outbox_id, state, release_state, created_at, updated_at)
  values (v_transmission_id, v_conversation.id, v_member_digest, v_generation,
    v_payload_version, v_payload_digest, v_from, v_to, v_cc, v_bcc, v_reply_to,
    v_subject, v_provider_key, v_communication_id, v_outbox_id,
    'prepared', 'ordinary', v_now, v_now)
  returning * into v_transmission;
  for v_index in 1..pg_catalog.array_length(v_touches, 1) loop
    v_touch := v_touches[v_index];
    v_campaign := v_campaigns[v_index];
    insert into public.deal_hunter_cim_transmission_touches
      (transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at)
    values (v_transmission_id, v_touch.id, v_touch.opportunity_id,
      v_touch.campaign_id, v_index, v_now);
    update public.deal_hunter_cim_campaign_touches
      set transmission_id = v_transmission_id, row_version = row_version + 1,
        updated_at = v_now
      where id = v_touch.id and state = 'claimed'
        and claim_token_digest = v_claim_digest and transmission_id is null;
    if not found then
      raise exception 'Concurrent Pursue CIM transmission membership';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
       transmission_id, next_state, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('transmission-membership'::text),
        pg_catalog.to_jsonb(v_transmission_id || ':' || v_touch.id)),
      'transmission-membership', v_touch.opportunity_id, v_campaign.id,
      v_conversation.id, v_touch.id, v_transmission_id,
      'active', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  end loop;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, conversation_id, transmission_id,
     next_state, payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-prepared'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'transmission-prepared', v_campaigns[1].opportunity_id, v_conversation.id,
    v_transmission_id, 'prepared', v_payload_digest,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('prepared', true, 'existing', false,
    'payloadConflict', false, 'terminal', false,
    'transmission', pg_catalog.to_jsonb(v_transmission));
end;
$$;

-- Package 6B: exact default-deny provider seam predicates.

create or replace function public.pursue_cim_enter_provider_seam_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_authorization_id text;
  v_writer_path text;
  v_provider_profile text;
  v_capability text;
  v_payload_digest text;
  v_nonce_digest text;
  v_expected bigint;
  v_actor text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_communication public.crm_communications%rowtype;
  v_outbox public.crm_email_outbox%rowtype;
  v_pause boolean;
  v_member_count bigint;
  v_initial_count bigint;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_authorization_id := public.pursue_cim_required_text_v1(p_command, 'authorizationId', 240);
  v_writer_path := public.pursue_cim_required_text_v1(p_command, 'writerPath', 240);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_capability := public.pursue_cim_required_text_v1(p_command, 'capability', 40);
  v_payload_digest := public.pursue_cim_required_text_v1(p_command, 'payloadDigest', 64);
  v_nonce_digest := public.pursue_cim_required_text_v1(p_command, 'boundaryNonceDigest', 64);
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if v_payload_digest !~ '^[0-9a-f]{64}$'
    or v_nonce_digest !~ '^[0-9a-f]{64}$'
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM provider seam command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');

  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_transmission_id for update;
  select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
    where id = v_authorization_id for share;
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where id = v_authorization.activation_id for share;
  select * into v_communication from public.crm_communications
    where id = v_transmission.communication_id for share;
  select * into v_outbox from public.crm_email_outbox
    where id = v_transmission.outbox_id for share;
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where t.kind = 'initial')
    into v_member_count, v_initial_count
    from public.deal_hunter_cim_transmission_touches m
    join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
    where m.transmission_id = v_transmission_id and m.cancelled_at is null;
  select outreach_paused into v_pause from public.deal_hunter_cim_safety_settings
    where id = 'global' for share;

  if v_transmission.state is distinct from 'provider-pending'
    or v_transmission.invocation_authority_count is distinct from 1
    or v_transmission.payload_digest is distinct from v_payload_digest
    or v_transmission.boundary_nonce_digest is distinct from v_nonce_digest
    or v_authorization.transmission_id is distinct from v_transmission_id
    or v_authorization.writer_path is distinct from v_writer_path
    or v_authorization.provider_profile is distinct from v_provider_profile
    or v_authorization.capability is distinct from v_capability
    or v_authorization.payload_digest is distinct from v_payload_digest
    or v_authorization.maximum_calls is distinct from 1
    or v_authorization.consumed_at is null
    or v_authorization.withdrawn_at is not null
    or v_authorization.expires_at <= v_now
    or v_activation.id is distinct from v_authorization.activation_id
    or v_activation.provider_profile is distinct from v_provider_profile
    or public.pursue_cim_current_activation_v1(v_capability, v_now)
      is distinct from v_authorization.activation_id
    or not (
      (v_writer_path in ('pursue-cim-initial', 'pursue-cim-autopilot-initial')
        and v_capability = 'fl04b-initial')
      or (v_writer_path in ('pursue-cim-follow-up', 'pursue-cim-autopilot-follow-up')
        and v_capability = 'fl04c-followup')
      or (v_writer_path in ('pursue-cim-batch', 'pursue-cim-autopilot-batch')
        and v_capability = 'fl04c-batch')
    )
    or v_member_count < 1
    or (v_capability = 'fl04b-initial' and not (v_member_count = 1 and v_initial_count = 1))
    or (v_capability = 'fl04c-followup' and not (v_member_count = 1 and v_initial_count = 0))
    or (v_capability = 'fl04c-batch' and v_member_count <= 1)
    or v_communication.id is distinct from v_transmission.communication_id
    or v_communication.delivery_state is distinct from 'provider-pending'
    or v_outbox.id is distinct from v_transmission.outbox_id
    or v_outbox.communication_id is distinct from v_communication.id
    or v_outbox.state is distinct from 'provider-pending'
    or v_pause is distinct from false
  then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;
  if v_transmission.provider_seam_entered_at is not null then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', true, 'unauthorized', false);
  end if;
  if v_transmission.row_version is distinct from v_expected then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;

  update public.deal_hunter_cim_transmissions
    set provider_seam_entered_at = v_now, updated_at = v_now,
      row_version = row_version + 1
    where id = v_transmission_id and state = 'provider-pending'
      and invocation_authority_count = 1
      and provider_seam_entered_at is null
      and payload_digest = v_payload_digest
      and boundary_nonce_digest = v_nonce_digest and row_version = v_expected;
  if not found then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, authorization_id, next_state,
     payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('provider-seam-entered'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'provider-seam-entered', v_transmission_id, v_authorization_id,
    'entered', v_payload_digest, v_actor, 'postgres-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('entered', true,
    'alreadyEntered', false, 'unauthorized', false);
end;
$$;

revoke all on function public.pursue_cim_enter_provider_seam_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_enter_provider_seam_v1(jsonb)
  to service_role;

-- First-class CRM communications, durable CIM lifecycle/history, and lead dispositions.

alter table public.contact_submissions add column if not exists archived_at timestamptz;
alter table public.contact_submissions add column if not exists archived_by text;
alter table public.contact_submissions add column if not exists archive_reason text;
alter table public.contact_submissions add column if not exists archive_note text;
alter table public.contact_submissions add column if not exists archive_communication_id text;
alter table public.contact_submissions add column if not exists restored_at timestamptz;
alter table public.contact_submissions add column if not exists restored_by text;

alter table public.email_events add column if not exists communication_id text;

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
  in_reply_to text,
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

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'email_events_communication_id_fkey') then
    alter table public.email_events
      add constraint email_events_communication_id_fkey
      foreign key (communication_id) references public.crm_communications(id) on delete set null;
  end if;
end
$$;

create index if not exists idx_email_events_communication_id
  on public.email_events (communication_id, created_at desc);
create index if not exists idx_contact_submissions_broker_email_lower
  on public.contact_submissions (lower(broker_email));
create index if not exists idx_contact_submissions_seller_email_lower
  on public.contact_submissions (lower(seller_email));
create index if not exists idx_deal_hunter_cim_requests_submission
  on public.deal_hunter_cim_requests (submission_id, last_activity_at desc);
create index if not exists idx_deal_hunter_cim_requests_request_state
  on public.deal_hunter_cim_requests (request_state, first_requested_at desc);
create index if not exists idx_deal_hunter_cim_requests_delivery_state
  on public.deal_hunter_cim_requests (delivery_state, last_delivery_event_at desc);
create index if not exists idx_deal_hunter_cim_requests_follow_up_state
  on public.deal_hunter_cim_requests (follow_up_state, next_follow_up_at);
create unique index if not exists idx_deal_hunter_cim_requests_reply_to
  on public.deal_hunter_cim_requests (lower(reply_to_address))
  where reply_to_address is not null and reply_to_address <> '';
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
create index if not exists idx_deal_hunter_dispositions_updated
  on public.deal_hunter_dispositions (updated_at desc, id desc);
create index if not exists idx_deal_hunter_dispositions_submission
  on public.deal_hunter_dispositions (submission_id, updated_at desc);

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

alter table public.crm_communications enable row level security;
alter table public.deal_hunter_dispositions enable row level security;

revoke all privileges on table public.crm_communications from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_dispositions from public, anon, authenticated;
grant all privileges on table public.crm_communications to service_role;
grant all privileges on table public.deal_hunter_dispositions to service_role;

revoke all on function public.list_submissions_by_contact_email(text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.list_submissions_by_contact_email(text, integer, boolean)
  to service_role;
revoke all on function public.mutate_communications_with_crm_activity(text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.mutate_communications_with_crm_activity(text, jsonb, jsonb)
  to service_role;
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

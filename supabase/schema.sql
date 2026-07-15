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
alter table public.contact_submissions add column if not exists lead_type text not null default 'owner';
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
  source text not null,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.email_events add column if not exists provider_event_id text;
alter table public.email_events add column if not exists event_key text;

create index if not exists idx_email_events_submission_id on public.email_events (submission_id, created_at desc);
create index if not exists idx_email_events_recipient_email on public.email_events (recipient_email, created_at desc);
create index if not exists idx_email_events_message_id on public.email_events (message_id);
create index if not exists idx_email_events_event_type on public.email_events (event_type, created_at desc);

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

create unique index if not exists idx_deal_hunter_cim_requests_deal_recipient on public.deal_hunter_cim_requests (deal_key, recipient_email);
create index if not exists idx_deal_hunter_cim_requests_deal_key on public.deal_hunter_cim_requests (deal_key, updated_at desc);

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
alter table public.secure_upload_requests enable row level security;
alter table public.secure_documents enable row level security;
alter table public.email_events enable row level security;
alter table public.crm_activity_events enable row level security;
alter table public.deal_hunter_seen_deals enable row level security;
alter table public.deal_hunter_cim_requests enable row level security;
alter table public.deal_hunter_crm_imports enable row level security;
alter table public.scheduled_job_runs enable row level security;
alter table public.admin_audit_events enable row level security;
alter table public.secure_document_cleanup_jobs enable row level security;
alter table public.source_health_snapshots enable row level security;
alter table public.admin_magic_links enable row level security;
alter table public.admin_sessions enable row level security;

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

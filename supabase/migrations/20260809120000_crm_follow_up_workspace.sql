-- Production-safe CRM follow-up workspace primitives. All tables remain server-role only.

alter table public.crm_communications add column if not exists message_id text;
alter table public.crm_communications add column if not exists references_json jsonb not null default '[]'::jsonb;
alter table public.crm_communications add column if not exists parent_communication_id text;
alter table public.crm_communications add column if not exists thread_key text;
alter table public.crm_communications add column if not exists legacy_content_unavailable boolean not null default false;
alter table public.crm_communications add column if not exists content_redaction_state text not null default 'none';
alter table public.crm_communications add column if not exists recommendation_id text;
alter table public.crm_communications add column if not exists outbox_id text;
alter table public.crm_communications add column if not exists headers_json jsonb not null default '{}'::jsonb;

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
  select * into v_existing
  from public.crm_email_outbox
  where client_request_key = p_outbox ->> 'client_request_key'
  limit 1;

  if found then
    select * into v_communication from public.crm_communications where id = v_existing.communication_id;
    select * into v_submission from public.contact_submissions where id = v_existing.submission_id;
    return jsonb_build_object(
      'applied', false,
      'reason', 'duplicate-client-request',
      'communication', to_jsonb(v_communication),
      'outbox', to_jsonb(v_existing),
      'submission', to_jsonb(v_submission)
    );
  end if;

  select * into v_submission
  from public.contact_submissions
  where id = (p_outbox ->> 'submission_id')::uuid
  for update;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'submission-not-found');
  end if;
  if p_expected_submission_version is null or v_submission.updated_at is distinct from p_expected_submission_version then
    return jsonb_build_object('applied', false, 'reason', 'stale-submission', 'submission', to_jsonb(v_submission));
  end if;
  if lower(coalesce(v_submission.status, '')) in ('archived', 'spam') then
    return jsonb_build_object(
      'applied', false,
      'reason', 'submission-' || lower(v_submission.status),
      'submission', to_jsonb(v_submission)
    );
  end if;

  if nullif(btrim(coalesce(p_manual_takeover_cim_request_id, '')), '') is not null then
    select * into v_cim_request
    from public.deal_hunter_cim_requests
    where id = p_manual_takeover_cim_request_id
      and submission_id = v_submission.id
    for update;
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
    update public.deal_hunter_cim_requests
    set
      request_state = 'manual_takeover',
      follow_up_state = 'stopped',
      next_follow_up_at = null,
      follow_up_count = follow_up_count + 1,
      updated_at = (p_outbox ->> 'created_at')::timestamptz,
      last_activity_at = (p_outbox ->> 'created_at')::timestamptz,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'manualTakeoverAt', p_outbox ->> 'created_at',
        'manualTakeoverBy', p_outbox ->> 'actor'
      )
    where id = v_cim_request.id;
  end if;

  insert into public.crm_communications (
    id, submission_id, deal_key, cim_request_id, direction, channel, source, kind,
    provider, provider_message_id, source_event_id, idempotency_key, message_id, in_reply_to,
    references_json, parent_communication_id, thread_key, legacy_content_unavailable,
    content_redaction_state, recommendation_id, outbox_id, headers_json, reply_to_address,
    from_address, to_addresses, cc_addresses, bcc_addresses, subject, body_text,
    body_html_sanitized, occurred_at, created_at, updated_at, delivery_state,
    delivery_state_at, content_state, content_attempt_count, content_last_error,
    content_next_attempt_at, attachment_metadata, assigned_at, assigned_by, created_by,
    updated_by, metadata
  ) values (
    p_communication ->> 'id', (p_communication ->> 'submission_id')::uuid,
    nullif(p_communication ->> 'deal_key', ''), nullif(p_communication ->> 'cim_request_id', ''),
    p_communication ->> 'direction', p_communication ->> 'channel', p_communication ->> 'source',
    nullif(p_communication ->> 'kind', ''), nullif(p_communication ->> 'provider', ''),
    nullif(p_communication ->> 'provider_message_id', ''), nullif(p_communication ->> 'source_event_id', ''),
    nullif(p_communication ->> 'idempotency_key', ''), nullif(p_communication ->> 'message_id', ''),
    nullif(p_communication ->> 'in_reply_to', ''), coalesce(p_communication -> 'references_json', '[]'::jsonb),
    nullif(p_communication ->> 'parent_communication_id', ''), nullif(p_communication ->> 'thread_key', ''),
    coalesce((p_communication ->> 'legacy_content_unavailable')::boolean, false),
    coalesce(nullif(p_communication ->> 'content_redaction_state', ''), 'none'),
    nullif(p_communication ->> 'recommendation_id', ''), nullif(p_communication ->> 'outbox_id', ''),
    coalesce(p_communication -> 'headers_json', '{}'::jsonb), nullif(p_communication ->> 'reply_to_address', ''),
    nullif(p_communication ->> 'from_address', ''), coalesce(p_communication -> 'to_addresses', '[]'::jsonb),
    coalesce(p_communication -> 'cc_addresses', '[]'::jsonb), coalesce(p_communication -> 'bcc_addresses', '[]'::jsonb),
    nullif(p_communication ->> 'subject', ''), coalesce(p_communication ->> 'body_text', ''),
    coalesce(p_communication ->> 'body_html_sanitized', ''), (p_communication ->> 'occurred_at')::timestamptz,
    (p_communication ->> 'created_at')::timestamptz, (p_communication ->> 'updated_at')::timestamptz,
    coalesce(nullif(p_communication ->> 'delivery_state', ''), 'not-attempted'),
    nullif(p_communication ->> 'delivery_state_at', '')::timestamptz,
    coalesce(nullif(p_communication ->> 'content_state', ''), 'not-applicable'),
    coalesce((p_communication ->> 'content_attempt_count')::integer, 0),
    nullif(p_communication ->> 'content_last_error', ''), nullif(p_communication ->> 'content_next_attempt_at', '')::timestamptz,
    coalesce(p_communication -> 'attachment_metadata', '[]'::jsonb), nullif(p_communication ->> 'assigned_at', '')::timestamptz,
    nullif(p_communication ->> 'assigned_by', ''), coalesce(nullif(p_communication ->> 'created_by', ''), 'system'),
    coalesce(nullif(p_communication ->> 'updated_by', ''), 'system'), coalesce(p_communication -> 'metadata', '{}'::jsonb)
  ) returning * into v_communication;

  insert into public.crm_email_outbox (
    id, communication_id, submission_id, cim_request_id, idempotency_key, client_request_key,
    state, provider, provider_message_id, attempt_count, next_attempt_at, claim_token,
    claimed_at, claim_expires_at, accepted_at, failed_at, ambiguous_at, last_error_category,
    last_error_message, expected_submission_version, actor, intended_follow_up_state,
    intended_next_action_at, created_at, updated_at, metadata
  ) values (
    p_outbox ->> 'id', p_outbox ->> 'communication_id', (p_outbox ->> 'submission_id')::uuid,
    nullif(p_outbox ->> 'cim_request_id', ''), p_outbox ->> 'idempotency_key',
    p_outbox ->> 'client_request_key', p_outbox ->> 'state', nullif(p_outbox ->> 'provider', ''),
    nullif(p_outbox ->> 'provider_message_id', ''), coalesce((p_outbox ->> 'attempt_count')::integer, 0),
    nullif(p_outbox ->> 'next_attempt_at', '')::timestamptz, nullif(p_outbox ->> 'claim_token', ''),
    nullif(p_outbox ->> 'claimed_at', '')::timestamptz, nullif(p_outbox ->> 'claim_expires_at', '')::timestamptz,
    nullif(p_outbox ->> 'accepted_at', '')::timestamptz, nullif(p_outbox ->> 'failed_at', '')::timestamptz,
    nullif(p_outbox ->> 'ambiguous_at', '')::timestamptz, nullif(p_outbox ->> 'last_error_category', ''),
    nullif(p_outbox ->> 'last_error_message', ''), (p_outbox ->> 'expected_submission_version')::timestamptz,
    p_outbox ->> 'actor', nullif(p_outbox ->> 'intended_follow_up_state', ''),
    nullif(p_outbox ->> 'intended_next_action_at', '')::timestamptz,
    (p_outbox ->> 'created_at')::timestamptz, (p_outbox ->> 'updated_at')::timestamptz,
    coalesce(p_outbox -> 'metadata', '{}'::jsonb)
  ) returning * into v_outbox;

  update public.crm_follow_up_recommendations
  set status = 'superseded', superseded_at = (p_outbox ->> 'created_at')::timestamptz
  where submission_id = (p_outbox ->> 'submission_id')::uuid
    and status = 'current';

  insert into public.crm_activity_events (
    id, submission_id, created_at, actor, role, event_type, summary, metadata
  ) values (
    (p_activity ->> 'id')::uuid, (p_activity ->> 'submission_id')::uuid,
    (p_activity ->> 'created_at')::timestamptz, p_activity ->> 'actor', p_activity ->> 'role',
    p_activity ->> 'event_type', p_activity ->> 'summary', coalesce(p_activity -> 'metadata', '{}'::jsonb)
  );

  update public.contact_submissions
  set updated_at = (p_outbox ->> 'created_at')::timestamptz
  where id = v_submission.id and updated_at = p_expected_submission_version
  returning * into v_submission;
  if not found then
    raise exception 'The CRM record changed while the email command was being created.' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'applied', true,
    'reason', '',
    'communication', to_jsonb(v_communication),
    'outbox', to_jsonb(v_outbox),
    'submission', to_jsonb(v_submission)
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
declare
  v_outbox public.crm_email_outbox%rowtype;
begin
  if nullif(btrim(coalesce(p_claim_token, '')), '') is null
     or p_claimed_at is null
     or p_claim_expires_at is null
     or p_claim_expires_at <= p_claimed_at then
    raise exception 'A valid outbox claim token and future lease expiry are required.';
  end if;
  update public.crm_email_outbox
  set
    state = 'sending',
    attempt_count = attempt_count + 1,
    claim_token = p_claim_token,
    claimed_at = p_claimed_at,
    claim_expires_at = p_claim_expires_at,
    updated_at = p_claimed_at
  where id = p_id
    and (
      state = 'queued'
      or (state = 'retryable_failed' and (next_attempt_at is null or next_attempt_at <= p_claimed_at))
      or (state = 'sending' and claim_expires_at is not null and claim_expires_at <= p_claimed_at)
    )
  returning * into v_outbox;
  if found then
    return jsonb_build_object('claimed', true, 'outbox', to_jsonb(v_outbox));
  end if;
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
  update public.crm_email_outbox
  set
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
    claim_token = null,
    claimed_at = null,
    claim_expires_at = null
  where id = p_id and claim_token = p_claim_token and state = 'sending'
  returning * into v_outbox;
  return to_jsonb(v_outbox);
end;
$$;

alter table public.crm_email_outbox enable row level security;
alter table public.crm_follow_up_recommendations enable row level security;
alter table public.email_suppressions enable row level security;

revoke all privileges on table public.crm_email_outbox from public, anon, authenticated;
revoke all privileges on table public.crm_follow_up_recommendations from public, anon, authenticated;
revoke all privileges on table public.email_suppressions from public, anon, authenticated;
grant all privileges on table public.crm_email_outbox to service_role;
grant all privileges on table public.crm_follow_up_recommendations to service_role;
grant all privileges on table public.email_suppressions to service_role;

revoke all on function public.create_crm_email_command(jsonb, jsonb, jsonb, timestamptz, text) from public, anon, authenticated;
grant execute on function public.create_crm_email_command(jsonb, jsonb, jsonb, timestamptz, text) to service_role;
revoke all on function public.claim_crm_email_outbox(text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_crm_email_outbox(text, text, timestamptz, timestamptz) to service_role;
revoke all on function public.finish_crm_email_outbox_claim(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.finish_crm_email_outbox_claim(text, text, jsonb) to service_role;

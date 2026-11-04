-- Pursued deals tracker: the owner's stage events.
--
-- Forward-only and re-runnable. An append-only chain of owner events per opportunity
-- (reply type, stage move, SIM intake, acknowledge). The non-null 'genesis' sentinel makes
-- unique (opportunity_id, previous_event_id) serialize appends, and the RPC locks the
-- opportunity row before it reads the latest event. The table has no free-text column, is
-- service-role only, and is written only through the RPC below.

create table if not exists public.deal_hunter_pursuit_stage_events (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,240}$'),
  idempotency_key text not null unique check (idempotency_key ~ '^[A-Za-z0-9_-]{1,240}$'),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  opportunity_id text not null
    references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  previous_event_id text not null
    check (previous_event_id ~ '^[A-Za-z0-9_-]{1,240}$' and previous_event_id <> id),
  kind text not null check (kind in ('reply-type', 'stage-move', 'sim-intake', 'acknowledge')),
  reply_type text check (reply_type is null
    or reply_type in ('nda-requested', 'sim-received', 'not-available', 'question', 'other')),
  from_stage text not null check (from_stage in ('cim-requested', 'broker-replied', 'nda-sent',
    'cim-received', 'financial-review', 'loi-candidate', 'passed')),
  stage text not null check (stage in ('cim-requested', 'broker-replied', 'nda-sent',
    'cim-received', 'financial-review', 'loi-candidate', 'passed')),
  acknowledged_reply_id text
    check (acknowledged_reply_id is null or acknowledged_reply_id ~ '^[A-Za-z0-9_-]{1,240}$'),
  acknowledged_processed_at timestamptz,
  secure_document_id text
    check (secure_document_id is null or secure_document_id ~ '^[A-Za-z0-9_-]{1,240}$'),
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  policy_version text not null check (policy_version = 'pursuit-tracker-v1'),
  created_at timestamptz not null,
  constraint deal_hunter_pursuit_stage_events_reply_type
    check ((kind = 'reply-type') = (reply_type is not null)),
  constraint deal_hunter_pursuit_stage_events_acknowledge
    check (kind <> 'acknowledge' or (acknowledged_reply_id is not null and stage = from_stage)),
  constraint deal_hunter_pursuit_stage_events_acknowledged_pair
    check ((acknowledged_reply_id is null) = (acknowledged_processed_at is null)),
  constraint deal_hunter_pursuit_stage_events_sim_intake_document
    check ((kind = 'sim-intake') = (secure_document_id is not null)),
  constraint deal_hunter_pursuit_stage_events_predecessor unique (opportunity_id, previous_event_id)
);
create index if not exists idx_deal_hunter_pursuit_stage_events_opportunity_created
  on public.deal_hunter_pursuit_stage_events (opportunity_id, created_at desc);

alter table public.deal_hunter_pursuit_stage_events enable row level security;
revoke all on table public.deal_hunter_pursuit_stage_events
  from public, anon, authenticated, service_role;
grant select on table public.deal_hunter_pursuit_stage_events to service_role;

-- Stage evidence is never updated, deleted or truncated.
create or replace function public.pursuit_tracker_reject_event_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'pursuit stage evidence is immutable';
end;
$$;
revoke all on function public.pursuit_tracker_reject_event_mutation_v1()
  from public, anon, authenticated;

drop trigger if exists trg_deal_hunter_pursuit_stage_events_immutable
  on public.deal_hunter_pursuit_stage_events;
create trigger trg_deal_hunter_pursuit_stage_events_immutable
  before update or delete on public.deal_hunter_pursuit_stage_events
  for each row execute function public.pursuit_tracker_reject_event_mutation_v1();
drop trigger if exists trg_deal_hunter_pursuit_stage_events_no_truncate
  on public.deal_hunter_pursuit_stage_events;
create trigger trg_deal_hunter_pursuit_stage_events_no_truncate
  before truncate on public.deal_hunter_pursuit_stage_events
  for each statement execute function public.pursuit_tracker_reject_event_mutation_v1();

-- Appends one owner event (not a SIM intake). Under the opportunity row lock, in order: the
-- idempotency key (replay or conflict), an active opportunity, a latest owner decision of
-- pursue, the predecessor (null appends after the latest event), and the acknowledged reply,
-- whose processed_at is copied from the latest campaign's conversation.
create or replace function public.pursuit_tracker_record_event_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text := p_command ->> 'id';
  v_key text := p_command ->> 'idempotencyKey';
  v_digest text := p_command ->> 'requestDigest';
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_expected text := p_command ->> 'expectedPreviousEventId';
  v_kind text := p_command ->> 'kind';
  v_reply_type text := p_command ->> 'replyType';
  v_from_stage text := p_command ->> 'fromStage';
  v_stage text := p_command ->> 'stage';
  v_reply_id text := p_command ->> 'acknowledgedReplyId';
  v_actor text := p_command ->> 'actor';
  v_now timestamptz;
  v_existing public.deal_hunter_pursuit_stage_events%rowtype;
  v_status text;
  v_action text;
  v_latest text;
  v_processed_at timestamptz;
  v_row public.deal_hunter_pursuit_stage_events%rowtype;
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_id is null or v_id !~ '^[A-Za-z0-9_-]{1,240}$'
    or v_key is null or v_key !~ '^[A-Za-z0-9_-]{1,240}$'
    or v_digest is null or v_digest !~ '^[0-9a-f]{64}$'
    or v_opportunity_id is null or v_opportunity_id !~ '^[A-Za-z0-9_-]{1,240}$'
    or (v_expected is not null and v_expected !~ '^[A-Za-z0-9_-]{1,240}$')
    or v_kind is null or v_kind not in ('reply-type', 'stage-move', 'acknowledge')
    or (v_kind = 'reply-type') <> (v_reply_type is not null)
    or (v_reply_id is not null and v_reply_id !~ '^[A-Za-z0-9_-]{1,240}$')
    or v_actor is null or v_actor <> pg_catalog.btrim(v_actor) or pg_catalog.char_length(v_actor) not between 1 and 200
    or pg_catalog.jsonb_typeof(p_command -> 'now') is distinct from 'string'
    or (p_command ->> 'now') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or (p_command ->> 'secureDocumentId') is not null
  then
    raise exception 'Invalid pursuit stage event';
  end if;
  v_now := (p_command ->> 'now')::timestamptz;

  perform 1 from public.deal_hunter_opportunities where opportunity_id = v_opportunity_id for update;

  select * into v_existing from public.deal_hunter_pursuit_stage_events where idempotency_key = v_key;
  if found then
    if v_existing.request_digest = v_digest then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', true, 'conflict', null,
        'event', pg_catalog.to_jsonb(v_existing));
    end if;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', 'idempotency_conflict', 'event', null);
  end if;

  select status into v_status from public.deal_hunter_opportunities where opportunity_id = v_opportunity_id;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', 'not_pursued', 'event', null);
  end if;
  if v_status is distinct from 'active' then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', 'opportunity_not_active', 'event', null);
  end if;

  select action into v_action from public.deal_hunter_owner_decision_events
    where opportunity_id = v_opportunity_id order by created_at desc, id desc limit 1;
  if v_action is distinct from 'pursue' then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', 'not_pursued', 'event', null);
  end if;

  select e.id into v_latest from public.deal_hunter_pursuit_stage_events e
    where e.opportunity_id = v_opportunity_id and not exists (
      select 1 from public.deal_hunter_pursuit_stage_events n
      where n.opportunity_id = e.opportunity_id and n.previous_event_id = e.id)
    order by e.created_at desc, e.id desc limit 1;
  v_latest := coalesce(v_latest, 'genesis');
  if v_expected is not null and v_expected <> v_latest then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', 'pursuit_stage_changed', 'event', null);
  end if;

  if v_reply_id is not null then
    select r.processed_at into v_processed_at from public.deal_hunter_gmail_reply_messages r
      where r.gmail_message_id = v_reply_id and r.conversation_id = (
        select c.conversation_id from public.deal_hunter_cim_campaigns c
        where c.opportunity_id = v_opportunity_id order by c.generation desc limit 1);
    if not found then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', 'unknown_reply', 'event', null);
    end if;
  end if;

  insert into public.deal_hunter_pursuit_stage_events (id, idempotency_key, request_digest, opportunity_id,
    previous_event_id, kind, reply_type, from_stage, stage, acknowledged_reply_id, acknowledged_processed_at,
    secure_document_id, actor, policy_version, created_at)
  values (v_id, v_key, v_digest, v_opportunity_id, v_latest, v_kind, v_reply_type, v_from_stage, v_stage,
    v_reply_id, v_processed_at, null, v_actor, 'pursuit-tracker-v1', v_now)
  returning * into v_row;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false, 'conflict', null,
    'event', pg_catalog.to_jsonb(v_row));
end;
$$;
revoke all on function public.pursuit_tracker_record_event_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursuit_tracker_record_event_v1(jsonb) to service_role;

-- Reads the evidence each pursued deal's tracker row is folded from. Members are every
-- opportunity with at least one pursue decision, whatever its status now; `opportunityIds`
-- (at most 200) narrows the list. The bundle holds every owner decision, the latest campaign
-- generation with its conversation's Gmail thread, that conversation's Gmail rows (pending ones
-- too), the CIM-type secure documents and the diligence / pipeline stage fields of the
-- campaign's crm_submission_id (never primary_submission_id), and the owner events, oldest first.
create or replace function public.pursuit_tracker_list_v1(p_command jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ids text[];
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object' then
    raise exception 'Invalid pursuit bundle list';
  end if;
  if p_command -> 'opportunityIds' is not null and pg_catalog.jsonb_typeof(p_command -> 'opportunityIds') <> 'null' then
    if pg_catalog.jsonb_typeof(p_command -> 'opportunityIds') <> 'array'
      or pg_catalog.jsonb_array_length(p_command -> 'opportunityIds') > 200
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_command -> 'opportunityIds') as item(value)
        where pg_catalog.jsonb_typeof(item.value) <> 'string' or (item.value #>> '{}') !~ '^[A-Za-z0-9_-]{1,240}$')
    then
      raise exception 'Invalid pursuit bundle list';
    end if;
    select coalesce(pg_catalog.array_agg(item.value #>> '{}'), '{}'::text[]) into v_ids
      from pg_catalog.jsonb_array_elements(p_command -> 'opportunityIds') as item(value);
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(bundle.value order by bundle.opportunity_id)
    from (
      select o.opportunity_id,
        pg_catalog.jsonb_build_object(
          'opportunity_id', o.opportunity_id,
          'name', o.canonical_name,
          'opportunity_status', o.status,
          'decisions', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', d.id, 'action', d.action,
              'created_at', d.created_at) order by d.created_at, d.id)
            from public.deal_hunter_owner_decision_events d where d.opportunity_id = o.opportunity_id),
            '[]'::jsonb),
          'campaign', (
            select pg_catalog.jsonb_build_object('id', c.id, 'state', c.state, 'reason_code', c.reason_code,
              'crm_submission_id', c.crm_submission_id, 'conversation_id', c.conversation_id,
              'gmail_thread_id', conversation.gmail_thread_id)
            from public.deal_hunter_cim_campaigns c
            left join public.deal_hunter_broker_conversations conversation on conversation.id = c.conversation_id
            where c.opportunity_id = o.opportunity_id order by c.generation desc limit 1),
          'replies', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('gmail_message_id', r.gmail_message_id,
              'classification', r.classification, 'processed_at', r.processed_at, 'message_at', r.message_at)
              order by r.processed_at, r.gmail_message_id)
            from public.deal_hunter_gmail_reply_messages r
            where r.conversation_id = (
              select c.conversation_id from public.deal_hunter_cim_campaigns c
              where c.opportunity_id = o.opportunity_id order by c.generation desc limit 1)), '[]'::jsonb),
          'documents', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', doc.id,
              'document_type', doc.document_type, 'original_name', doc.original_name,
              'size_bytes', doc.size_bytes, 'created_at', doc.created_at) order by doc.created_at, doc.id)
            from public.secure_documents doc
            where doc.submission_id = (
              select c.crm_submission_id from public.deal_hunter_cim_campaigns c
              where c.opportunity_id = o.opportunity_id order by c.generation desc limit 1)
              and doc.document_type in ('cim', 'teaser', 'prospectus', 'offering_memorandum',
                'offering_materials', 'data_room', 'broker_materials')), '[]'::jsonb),
          'crm', (
            select pg_catalog.jsonb_build_object(
              'diligence_stage', case when pg_catalog.jsonb_typeof(s.metadata #> '{diligence,stage}') = 'string'
                then s.metadata #>> '{diligence,stage}' end,
              'diligence_updated_at', case when pg_catalog.jsonb_typeof(s.metadata #> '{diligence,updated_at}') = 'string'
                then s.metadata #>> '{diligence,updated_at}' end,
              'pipeline_stage', case when pg_catalog.jsonb_typeof(s.metadata #> '{acquisitionCommand,pipelineStage}') = 'string'
                then s.metadata #>> '{acquisitionCommand,pipelineStage}' end,
              'pipeline_updated_at', case when pg_catalog.jsonb_typeof(s.metadata #> '{acquisitionCommand,updatedAt}') = 'string'
                then s.metadata #>> '{acquisitionCommand,updatedAt}' end)
            from public.contact_submissions s
            where s.id = (
              select c.crm_submission_id from public.deal_hunter_cim_campaigns c
              where c.opportunity_id = o.opportunity_id order by c.generation desc limit 1)),
          'events', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) - 'request_digest' order by e.created_at, e.id)
            from public.deal_hunter_pursuit_stage_events e where e.opportunity_id = o.opportunity_id),
            '[]'::jsonb)
        ) as value
      from public.deal_hunter_opportunities o
      where (v_ids is null or o.opportunity_id = any(v_ids))
        and exists (select 1 from public.deal_hunter_owner_decision_events d
          where d.opportunity_id = o.opportunity_id and d.action = 'pursue')
    ) as bundle
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.pursuit_tracker_list_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursuit_tracker_list_v1(jsonb) to service_role;

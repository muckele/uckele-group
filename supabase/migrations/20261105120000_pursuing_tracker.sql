-- Pursued deals tracker: the owner's stage events.
--
-- Forward-only and re-runnable. An append-only chain of owner events per opportunity
-- (reply type, stage move, SIM intake, acknowledge). The non-null 'genesis' sentinel makes
-- unique (opportunity_id, previous_event_id) serialize appends, and the RPCs lock the
-- opportunity row before they read the latest event. The table has no free-text column, is
-- service-role only, and is written only through the RPCs below.

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

-- Whether an owner event command has the shape every writer requires: ids, key and digest
-- formats, a known kind, a reply type exactly for reply-type, a document exactly for
-- sim-intake, a trimmed actor and an ISO instant. Each writer adds the kinds it accepts.
create or replace function public.pursuit_tracker_event_command_valid_v1(p_event jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = public
as $$
begin
  return p_event is not null and pg_catalog.jsonb_typeof(p_event) = 'object' and not coalesce(
    (p_event ->> 'id') is null or (p_event ->> 'id') !~ '^[A-Za-z0-9_-]{1,240}$'
    or (p_event ->> 'idempotencyKey') is null or (p_event ->> 'idempotencyKey') !~ '^[A-Za-z0-9_-]{1,240}$'
    or (p_event ->> 'requestDigest') is null or (p_event ->> 'requestDigest') !~ '^[0-9a-f]{64}$'
    or (p_event ->> 'opportunityId') is null or (p_event ->> 'opportunityId') !~ '^[A-Za-z0-9_-]{1,240}$'
    or ((p_event ->> 'expectedPreviousEventId') is not null
      and (p_event ->> 'expectedPreviousEventId') !~ '^[A-Za-z0-9_-]{1,240}$')
    or (p_event ->> 'kind') is null
    or (p_event ->> 'kind') not in ('reply-type', 'stage-move', 'sim-intake', 'acknowledge')
    or ((p_event ->> 'kind') = 'reply-type') <> ((p_event ->> 'replyType') is not null)
    or ((p_event ->> 'acknowledgedReplyId') is not null
      and (p_event ->> 'acknowledgedReplyId') !~ '^[A-Za-z0-9_-]{1,240}$')
    or ((p_event ->> 'secureDocumentId') is not null
      and (p_event ->> 'secureDocumentId') !~ '^[A-Za-z0-9_-]{1,240}$')
    or ((p_event ->> 'kind') = 'sim-intake') <> ((p_event ->> 'secureDocumentId') is not null)
    or (p_event ->> 'actor') is null or (p_event ->> 'actor') <> pg_catalog.btrim(p_event ->> 'actor')
    or pg_catalog.char_length(p_event ->> 'actor') not between 1 and 200
    or pg_catalog.jsonb_typeof(p_event -> 'now') is distinct from 'string'
    or (p_event ->> 'now') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$',
    true);
end;
$$;
revoke all on function public.pursuit_tracker_event_command_valid_v1(jsonb)
  from public, anon, authenticated, service_role;

-- The checks every owner event write makes under the opportunity row lock, in order: the
-- idempotency key (replay or conflict), an active opportunity, a latest owner decision of
-- pursue, the predecessor (null appends after the chain tip), and the acknowledged reply, whose
-- processed_at is copied from the latest campaign's conversation. Returns {"result": answer}
-- when the write stops here, otherwise {"previousEventId", "acknowledgedProcessedAt"}.
create or replace function public.pursuit_tracker_event_preflight_v1(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opportunity_id text := p_event ->> 'opportunityId';
  v_expected text := p_event ->> 'expectedPreviousEventId';
  v_reply_id text := p_event ->> 'acknowledgedReplyId';
  v_existing public.deal_hunter_pursuit_stage_events%rowtype;
  v_status text;
  v_action text;
  v_latest text;
  v_processed_at timestamptz;
begin
  select * into v_existing from public.deal_hunter_pursuit_stage_events
    where idempotency_key = p_event ->> 'idempotencyKey';
  if found then
    if v_existing.request_digest = p_event ->> 'requestDigest' then
      return pg_catalog.jsonb_build_object('result', pg_catalog.jsonb_build_object('applied', false,
        'replay', true, 'conflict', null, 'event', pg_catalog.to_jsonb(v_existing)));
    end if;
    return pg_catalog.jsonb_build_object('result', pg_catalog.jsonb_build_object('applied', false,
      'replay', false, 'conflict', 'idempotency_conflict', 'event', null));
  end if;

  select status into v_status from public.deal_hunter_opportunities where opportunity_id = v_opportunity_id;
  if not found then
    return pg_catalog.jsonb_build_object('result', pg_catalog.jsonb_build_object('applied', false,
      'replay', false, 'conflict', 'not_pursued', 'event', null));
  end if;
  if v_status is distinct from 'active' then
    return pg_catalog.jsonb_build_object('result', pg_catalog.jsonb_build_object('applied', false,
      'replay', false, 'conflict', 'opportunity_not_active', 'event', null));
  end if;

  select action into v_action from public.deal_hunter_owner_decision_events
    where opportunity_id = v_opportunity_id order by created_at desc, id desc limit 1;
  if v_action is distinct from 'pursue' then
    return pg_catalog.jsonb_build_object('result', pg_catalog.jsonb_build_object('applied', false,
      'replay', false, 'conflict', 'not_pursued', 'event', null));
  end if;

  select e.id into v_latest from public.deal_hunter_pursuit_stage_events e
    where e.opportunity_id = v_opportunity_id and not exists (
      select 1 from public.deal_hunter_pursuit_stage_events n
      where n.opportunity_id = e.opportunity_id and n.previous_event_id = e.id)
    order by e.created_at desc, e.id desc limit 1;
  v_latest := coalesce(v_latest, 'genesis');
  if v_expected is not null and v_expected <> v_latest then
    return pg_catalog.jsonb_build_object('result', pg_catalog.jsonb_build_object('applied', false,
      'replay', false, 'conflict', 'pursuit_stage_changed', 'event', null));
  end if;

  if v_reply_id is not null then
    select r.processed_at into v_processed_at from public.deal_hunter_gmail_reply_messages r
      where r.gmail_message_id = v_reply_id and r.conversation_id = (
        select c.conversation_id from public.deal_hunter_cim_campaigns c
        where c.opportunity_id = v_opportunity_id order by c.generation desc limit 1);
    if not found then
      return pg_catalog.jsonb_build_object('result', pg_catalog.jsonb_build_object('applied', false,
        'replay', false, 'conflict', 'unknown_reply', 'event', null));
    end if;
  end if;

  return pg_catalog.jsonb_build_object('previousEventId', v_latest, 'acknowledgedProcessedAt', v_processed_at);
end;
$$;
revoke all on function public.pursuit_tracker_event_preflight_v1(jsonb)
  from public, anon, authenticated, service_role;

-- Inserts a checked owner event after the predecessor its preflight found; returns the row.
create or replace function public.pursuit_tracker_append_event_v1(p_event jsonb, p_checked jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.deal_hunter_pursuit_stage_events%rowtype;
begin
  insert into public.deal_hunter_pursuit_stage_events (id, idempotency_key, request_digest, opportunity_id,
    previous_event_id, kind, reply_type, from_stage, stage, acknowledged_reply_id, acknowledged_processed_at,
    secure_document_id, actor, policy_version, created_at)
  values (p_event ->> 'id', p_event ->> 'idempotencyKey', p_event ->> 'requestDigest',
    p_event ->> 'opportunityId', p_checked ->> 'previousEventId', p_event ->> 'kind', p_event ->> 'replyType',
    p_event ->> 'fromStage', p_event ->> 'stage', p_event ->> 'acknowledgedReplyId',
    (p_checked ->> 'acknowledgedProcessedAt')::timestamptz, p_event ->> 'secureDocumentId',
    p_event ->> 'actor', 'pursuit-tracker-v1', (p_event ->> 'now')::timestamptz)
  returning * into v_row;
  return pg_catalog.to_jsonb(v_row);
end;
$$;
revoke all on function public.pursuit_tracker_append_event_v1(jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- Appends one owner event (not a SIM intake). It locks the opportunity row, then runs the
-- preflight above and inserts.
create or replace function public.pursuit_tracker_record_event_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_checked jsonb;
begin
  if not public.pursuit_tracker_event_command_valid_v1(p_command) or (p_command ->> 'kind') = 'sim-intake' then
    raise exception 'Invalid pursuit stage event';
  end if;

  perform 1 from public.deal_hunter_opportunities where opportunity_id = p_command ->> 'opportunityId' for update;

  v_checked := public.pursuit_tracker_event_preflight_v1(p_command);
  if v_checked ? 'result' then
    return v_checked -> 'result';
  end if;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false, 'conflict', null,
    'event', public.pursuit_tracker_append_event_v1(p_command, v_checked));
end;
$$;
revoke all on function public.pursuit_tracker_record_event_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursuit_tracker_record_event_v1(jsonb) to service_role;

-- Records a SIM the owner uploaded (spec 2026-11-04 §8.4). Lock order is the CIM writers' own:
-- the CIM terminal advisory lock first (the convergence triggers on secure_upload_requests and
-- secure_documents take it, and CIM RPCs hold it before they touch an opportunity), then the
-- opportunity row. After the owner event preflight, the document's submission must be the
-- latest campaign's crm_submission_id (no_crm_record) and not superseded (crm_superseded). Then
-- the synthetic completed upload request, the CIM document, the documents.uploaded activity and
-- the sim-intake event. The existing triggers converge materials and supersede follow-up
-- recommendations in the same transaction.
create or replace function public.pursuit_tracker_record_sim_intake_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event jsonb := p_command -> 'event';
  v_request jsonb := p_command -> 'request';
  v_document jsonb := p_command -> 'document';
  v_activity jsonb := p_command -> 'activity';
  v_submission_id text := p_command #>> '{request,submission_id}';
  v_checked jsonb;
  v_campaign_submission_id text;
  v_document_row public.secure_documents%rowtype;
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or not public.pursuit_tracker_event_command_valid_v1(v_event)
    or (v_event ->> 'kind') <> 'sim-intake'
    or (v_event ->> 'expectedPreviousEventId') is not null
    or pg_catalog.jsonb_typeof(v_request) is distinct from 'object'
    or pg_catalog.jsonb_typeof(v_document) is distinct from 'object'
    or pg_catalog.jsonb_typeof(v_activity) is distinct from 'object'
    or v_submission_id is null
    or (v_request ->> 'status') is distinct from 'completed'
    or (v_request -> 'nda_required') is distinct from 'false'::jsonb
    or (v_request -> 'upload_batch_count') is distinct from '1'::jsonb
    or (v_request -> 'requested_documents')
      is distinct from '[{"category": "cim", "label": "CIM", "required": true}]'::jsonb
    or (v_request ->> 'expires_at')::timestamptz is distinct from (v_event ->> 'now')::timestamptz
    or (v_request ->> 'closed_at')::timestamptz is distinct from (v_event ->> 'now')::timestamptz
    or (v_request ->> 'last_uploaded_at')::timestamptz is distinct from (v_event ->> 'now')::timestamptz
    or (v_document ->> 'id') is distinct from (v_event ->> 'secureDocumentId')
    or (v_document ->> 'request_id') is distinct from (v_request ->> 'id')
    or (v_document ->> 'submission_id') is distinct from v_submission_id
    or (v_document ->> 'document_type') is distinct from 'cim'
    or (v_activity ->> 'submission_id') is distinct from v_submission_id
    or (v_activity ->> 'event_type') is distinct from 'documents.uploaded'
    or (v_activity ->> 'role') is distinct from 'admin'
  then
    raise exception 'Invalid pursuit SIM intake';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  perform 1 from public.deal_hunter_opportunities where opportunity_id = v_event ->> 'opportunityId' for update;

  v_checked := public.pursuit_tracker_event_preflight_v1(v_event);
  if v_checked ? 'result' then
    return (v_checked -> 'result') || pg_catalog.jsonb_build_object('document', (
      select pg_catalog.to_jsonb(d) from public.secure_documents d
      where (v_checked #>> '{result,replay}')::boolean
        and d.id::text = v_checked #>> '{result,event,secure_document_id}'));
  end if;

  select c.crm_submission_id::text into v_campaign_submission_id from public.deal_hunter_cim_campaigns c
    where c.opportunity_id = v_event ->> 'opportunityId' order by c.generation desc limit 1;
  if v_campaign_submission_id is null or v_campaign_submission_id <> v_submission_id then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', 'no_crm_record',
      'event', null, 'document', null);
  end if;
  if exists (select 1 from public.crm_submission_supersessions s
    where s.status = 'active' and s.superseded_submission_id::text = v_submission_id)
  then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', 'crm_superseded',
      'event', null, 'document', null);
  end if;

  insert into public.secure_upload_requests
    select * from pg_catalog.jsonb_populate_record(null::public.secure_upload_requests, v_request);
  insert into public.secure_documents
    select * from pg_catalog.jsonb_populate_record(null::public.secure_documents, v_document)
    returning * into v_document_row;
  insert into public.crm_activity_events
    select * from pg_catalog.jsonb_populate_record(null::public.crm_activity_events, v_activity);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false, 'conflict', null,
    'event', public.pursuit_tracker_append_event_v1(v_event, v_checked),
    'document', pg_catalog.to_jsonb(v_document_row));
end;
$$;
revoke all on function public.pursuit_tracker_record_sim_intake_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursuit_tracker_record_sim_intake_v1(jsonb) to service_role;

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

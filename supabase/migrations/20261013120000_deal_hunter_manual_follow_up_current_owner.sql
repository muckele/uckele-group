-- Serialize every application CIM-request owner writer with provider-accepted
-- manual follow-up reconciliation, and keep canonical owner ordering bytewise.

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
  v_request_opportunity_id text;
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
    v_request_opportunity_id := nullif(btrim(p_payload #>> '{request,opportunity_id}'), '');
    if v_request_opportunity_id is null then
      raise exception 'CIM request opportunity id is required';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('deal-hunter-cim-opportunity:' || v_request_opportunity_id, 0)
    );
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
    where deal_hunter_cim_requests.opportunity_id is not distinct from excluded.opportunity_id
    returning to_jsonb(deal_hunter_cim_requests) into v_record;
    if v_record is null then
      raise exception 'CIM request opportunity ownership cannot change during upsert';
    end if;
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

create or replace function public.upsert_deal_hunter_cim_request(
  p_request jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_request public.deal_hunter_cim_requests%rowtype;
  v_stored public.deal_hunter_cim_requests%rowtype;
begin
  select * into v_request
  from jsonb_populate_record(null::public.deal_hunter_cim_requests, coalesce(p_request, '{}'::jsonb));

  if v_request.id is null or v_request.id = ''
    or v_request.opportunity_id is null or v_request.opportunity_id = ''
    or v_request.deal_key is null or btrim(v_request.deal_key) = ''
    or v_request.recipient_email is null or btrim(v_request.recipient_email) = '' then
    raise exception 'CIM request id, opportunity id, deal key, and recipient email are required';
  end if;
  v_request.deal_key := btrim(v_request.deal_key);
  v_request.recipient_email := lower(btrim(v_request.recipient_email));

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('deal-hunter-cim-opportunity:' || v_request.opportunity_id, 0)
  );

  insert into public.deal_hunter_cim_requests
  select (v_request).*
  on conflict (deal_key, recipient_email) do update set
    id = excluded.id,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    opportunity_id = excluded.opportunity_id,
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
    submission_id = excluded.submission_id,
    request_state = excluded.request_state,
    delivery_state = excluded.delivery_state,
    delivery_state_at = excluded.delivery_state_at,
    follow_up_state = excluded.follow_up_state,
    first_requested_at = excluded.first_requested_at,
    first_provider_accepted_at = excluded.first_provider_accepted_at,
    delivered_at = excluded.delivered_at,
    last_attempt_at = excluded.last_attempt_at,
    last_delivery_event_at = excluded.last_delivery_event_at,
    reply_to_address = excluded.reply_to_address,
    retry_of_request_id = excluded.retry_of_request_id,
    attempt_count = excluded.attempt_count,
    last_activity_at = excluded.last_activity_at,
    metadata = excluded.metadata
  where deal_hunter_cim_requests.opportunity_id is not distinct from excluded.opportunity_id
  returning * into v_stored;

  if v_stored.id is null then
    raise exception 'CIM request opportunity ownership cannot change during upsert';
  end if;
  return to_jsonb(v_stored);
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

  if v_new.id is null or v_new.id = '' or v_new.opportunity_id is null or v_new.opportunity_id = ''
    or v_new.deal_key = '' or v_new.recipient_email = '' then
    raise exception 'CIM request id, opportunity id, deal key, and recipient email are required';
  end if;

  if v_new.submission_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'submission-missing', 'request', null);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('deal-hunter-cim-opportunity:' || v_new.opportunity_id, 0)
  );
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
    if v_current.opportunity_id is distinct from v_new.opportunity_id then
      return jsonb_build_object('claimed', false, 'reason', 'opportunity-owner-mismatch', 'request', to_jsonb(v_current));
    end if;
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
    if v_request.opportunity_id is null or v_request.opportunity_id = '' then
      return jsonb_build_object(
        'applied', false,
        'reason', 'opportunity-missing',
        'record', null,
        'activity', null
      );
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('deal-hunter-cim-opportunity:' || v_request.opportunity_id, 0)
    );
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
    where deal_hunter_cim_requests.opportunity_id is not distinct from excluded.opportunity_id
    returning to_jsonb(deal_hunter_cim_requests) into v_record;

    if v_record is null then
      return jsonb_build_object(
        'applied', false,
        'reason', 'opportunity-owner-mismatch',
        'record', null,
        'activity', null
      );
    end if;

  else
    raise exception 'Unsupported atomic communications operation: %', coalesce(p_operation, 'unknown');
  end if;

  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;

  return jsonb_build_object('applied', true, 'record', v_record, 'activity', v_activity);
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
  v_opportunity_id text;
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

  -- Identity repair is the only application writer permitted to move an
  -- existing request between opportunities. Serialize repair batches before
  -- discovering their source opportunities, then lock the complete source and
  -- destination set in deterministic binary order before any repair mutation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('deal-hunter-cim-identity-repair', 0)
  );
  for v_opportunity_id in
    with request_link as (
      select item.value
      from jsonb_array_elements(coalesce(repair_batch->'requestLinks', '[]'::jsonb)) as item(value)
    ), request_reference as (
      select request_link.value->>'id' as request_id
      from request_link
      union
      select item.value->>'id'
      from jsonb_array_elements(coalesce(repair_batch->'stopRequests', '[]'::jsonb)) as item(value)
    ), opportunity_lock as (
      select nullif(btrim(request_link.value->>'opportunity_id'), '') as opportunity_id
      from request_link
      union
      select request.opportunity_id
      from public.deal_hunter_cim_requests as request
      join request_reference on request.id = request_reference.request_id
    )
    select opportunity_id
    from opportunity_lock
    where opportunity_id is not null
    order by opportunity_id collate "C"
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('deal-hunter-cim-opportunity:' || v_opportunity_id, 0)
    );
  end loop;

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
  v_probe_opportunity_id text;
  v_current public.deal_hunter_cim_requests%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_current_owner_id text;
  v_claim_owner_id text;
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
  select request.opportunity_id into v_probe_opportunity_id
  from public.deal_hunter_cim_requests as request
  where request.id = p_request_id;

  if v_probe_opportunity_id is null then
    return jsonb_build_object('applied', false, 'reason', 'request-missing', 'request', null, 'activity', null, 'alreadyFinalized', false);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('deal-hunter-cim-opportunity:' || v_probe_opportunity_id, 0)
  );

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
  if v_current.opportunity_id is distinct from v_probe_opportunity_id then
    return jsonb_build_object('applied', false, 'reason', 'canonical-owner-changed', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
  end if;

  select claim.request_id into v_claim_owner_id
  from public.deal_hunter_cim_opportunity_claims as claim
  where claim.opportunity_id = v_probe_opportunity_id
  for update;

  select request.id into v_current_owner_id
  from public.deal_hunter_cim_requests as request
  where request.opportunity_id = v_probe_opportunity_id
  order by coalesce(request.first_requested_at, request.created_at) desc, request.id collate "C" asc
  limit 1;

  if v_current_owner_id is distinct from p_request_id
    or (v_claim_owner_id is not null and v_claim_owner_id is distinct from p_request_id) then
    return jsonb_build_object('applied', false, 'reason', 'canonical-owner-changed', 'request', to_jsonb(v_current), 'activity', null, 'alreadyFinalized', false);
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

revoke all on function public.mutate_with_crm_activity(text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.mutate_with_crm_activity(text, jsonb, jsonb)
  to service_role;

revoke all on function public.upsert_deal_hunter_cim_request(jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_deal_hunter_cim_request(jsonb)
  to service_role;

revoke all on function public.claim_deal_hunter_cim_request(jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_deal_hunter_cim_request(jsonb, timestamptz)
  to service_role;

revoke all on function public.mutate_communications_with_crm_activity(text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.mutate_communications_with_crm_activity(text, jsonb, jsonb)
  to service_role;

revoke all on function public.apply_deal_hunter_cim_identity_repair(jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_deal_hunter_cim_identity_repair(jsonb)
  to service_role;

revoke all on function public.finalize_deal_hunter_approved_follow_up(text, timestamptz, uuid, integer, text, text, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_deal_hunter_approved_follow_up(text, timestamptz, uuid, integer, text, text, timestamptz, timestamptz, jsonb)
  to service_role;

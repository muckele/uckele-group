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
    ),
    paged as (
      select filtered.*, row_number() over (order by %s, created_at desc, id asc) as page_position
      from filtered
      order by %s, created_at desc, id asc
      limit $3 offset $4
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
  using coalesce(p_status, ''), trim(coalesce(p_search, '')), v_limit, v_offset;

  return v_result;
end;
$$;

revoke all on function public.list_submissions_page(integer, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.list_submissions_page(integer, integer, text, text, text, text) to service_role;

-- Package 7A: conversation-first signed inbound resolution and durable bindings.

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
        c.conversation_id, c.terminal_revision as campaign_terminal_revision,
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

-- Completing immutable P7A binding metadata inside the preparation transaction is
-- part of the original outbound communication insert, not a second authority event.
create or replace function public.pursue_cim_bump_global_authority_revision_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'UPDATE' then
    if TG_TABLE_NAME = 'crm_communications'
      and old.source = 'pursue-cim-autopilot'
      and new.source = 'pursue-cim-autopilot'
      and pg_catalog.to_jsonb(old) - 'metadata' = pg_catalog.to_jsonb(new) - 'metadata'
      and old.metadata ? 'transmissionId'
      and new.metadata - array['conversationId','campaignIds','touchIds','memberDigest']
        = old.metadata - array['conversationId','campaignIds','touchIds','memberDigest']
      and pg_catalog.jsonb_typeof(new.metadata -> 'conversationId') = 'string'
      and pg_catalog.jsonb_typeof(new.metadata -> 'campaignIds') = 'array'
      and pg_catalog.jsonb_array_length(new.metadata -> 'campaignIds') between 1 and 50
      and pg_catalog.jsonb_typeof(new.metadata -> 'touchIds') = 'array'
      and pg_catalog.jsonb_array_length(new.metadata -> 'touchIds') between 1 and 50
      and new.metadata ->> 'memberDigest' ~ '^[0-9a-f]{64}$'
    then
      return new;
    end if;
    if TG_TABLE_NAME = 'deal_hunter_source_freshness_state' then
      if old.accepted_generation is not distinct from new.accepted_generation
        and old.accepted_run_id is not distinct from new.accepted_run_id
        and old.accepted_digest is not distinct from new.accepted_digest
        and old.projection_state is not distinct from new.projection_state then return new; end if;
    end if;
    if TG_TABLE_NAME = 'deal_hunter_identity_exceptions' then
      if old.status is not distinct from new.status
        and old.candidate_opportunity_ids is not distinct from new.candidate_opportunity_ids
      then return new; end if;
    end if;
  end if;
  update public.deal_hunter_cim_global_authority
    set revision = revision + 1 where id = 'global';
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.pursue_cim_bump_global_authority_revision_v1()
  from public, anon, authenticated;

create or replace function public.pursue_cim_resolve_inbound_v1(p_command jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_provider text := p_command ->> 'provider';
  v_tagged_conversation text := coalesce(p_command ->> 'taggedConversationId', '');
  v_tagged_transmission text := coalesce(p_command ->> 'taggedTransmissionId', '');
  v_conversation_ids text[] := array[]::text[];
  v_campaign_ids text[] := array[]::text[];
  v_touch_ids text[] := array[]::text[];
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_candidate_conversations jsonb := '[]'::jsonb;
  v_method text := 'none';
  v_invalid_protected boolean := false;
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or pg_catalog.jsonb_typeof(p_command -> 'replyToAddresses') <> 'array'
    or pg_catalog.jsonb_typeof(p_command -> 'providerMessageIds') <> 'array'
    or pg_catalog.jsonb_typeof(p_command -> 'rfcMessageIds') <> 'array'
    or pg_catalog.jsonb_typeof(p_command -> 'taggedTouchIds') <> 'array'
    or pg_catalog.jsonb_array_length(p_command -> 'replyToAddresses') > 20
    or pg_catalog.jsonb_array_length(p_command -> 'providerMessageIds') > 20
    or pg_catalog.jsonb_array_length(p_command -> 'rfcMessageIds') > 50
    or pg_catalog.jsonb_array_length(p_command -> 'taggedTouchIds') > 50
    or v_provider <> 'resend'
    or pg_catalog.length(v_tagged_conversation) > 240
    or pg_catalog.length(v_tagged_transmission) > 240
  then
    raise exception 'Invalid Pursue CIM inbound evidence';
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_command -> 'replyToAddresses') as item
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
        or pg_catalog.length(item.value #>> '{}') not between 1 and 320)
    or exists (select 1 from pg_catalog.jsonb_array_elements(p_command -> 'providerMessageIds') as item
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
        or pg_catalog.length(item.value #>> '{}') not between 1 and 240)
    or exists (select 1 from pg_catalog.jsonb_array_elements(p_command -> 'rfcMessageIds') as item
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
        or pg_catalog.length(item.value #>> '{}') not between 1 and 500)
    or exists (select 1 from pg_catalog.jsonb_array_elements(p_command -> 'taggedTouchIds') as item
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
        or pg_catalog.length(item.value #>> '{}') not between 1 and 240)
    or (select count(*) from pg_catalog.jsonb_array_elements_text(p_command -> 'replyToAddresses'))
       <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(p_command -> 'replyToAddresses'))
    or (select count(*) from pg_catalog.jsonb_array_elements_text(p_command -> 'providerMessageIds'))
       <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(p_command -> 'providerMessageIds'))
    or (select count(*) from pg_catalog.jsonb_array_elements_text(p_command -> 'rfcMessageIds'))
       <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(p_command -> 'rfcMessageIds'))
    or (select count(*) from pg_catalog.jsonb_array_elements_text(p_command -> 'taggedTouchIds'))
       <> (select count(distinct value) from pg_catalog.jsonb_array_elements_text(p_command -> 'taggedTouchIds'))
  then
    raise exception 'Invalid Pursue CIM inbound evidence item';
  end if;

  if v_tagged_conversation <> '' and not exists (
      select 1 from public.deal_hunter_broker_conversations where id = v_tagged_conversation) then
    v_invalid_protected := true;
  end if;
  if v_tagged_transmission <> '' and not exists (
      select 1 from public.deal_hunter_cim_transmissions where id = v_tagged_transmission) then
    v_invalid_protected := true;
  end if;
  if (select count(*) from public.deal_hunter_cim_campaign_touches
      where id in (select value from pg_catalog.jsonb_array_elements_text(
        p_command -> 'taggedTouchIds')))
      <> pg_catalog.jsonb_array_length(p_command -> 'taggedTouchIds') then
    v_invalid_protected := true;
  end if;

  with candidates as (
    select tr.conversation_id from public.deal_hunter_cim_transmissions as tr
      join pg_catalog.jsonb_array_elements_text(p_command -> 'replyToAddresses') as alias
        on pg_catalog.lower(tr.reply_to_address) = pg_catalog.lower(alias.value)
    union all
    select tr.conversation_id from public.deal_hunter_cim_transmissions as tr
      join pg_catalog.jsonb_array_elements_text(p_command -> 'providerMessageIds') as provider_id
        on tr.provider = v_provider and tr.provider_message_id = provider_id.value
    union all
    select tr.conversation_id from public.crm_communications as communication
      join public.deal_hunter_cim_transmissions as tr on tr.communication_id = communication.id
      join pg_catalog.jsonb_array_elements_text(p_command -> 'rfcMessageIds') as rfc_id
        on communication.message_id = rfc_id.value
    union all
    select tr.conversation_id from public.deal_hunter_cim_transmissions as tr
      where v_tagged_transmission <> '' and tr.id = v_tagged_transmission
    union all
    select conversation.id from public.deal_hunter_broker_conversations as conversation
      where v_tagged_conversation <> '' and conversation.id = v_tagged_conversation
    union all
    select campaign.conversation_id from public.deal_hunter_cim_campaign_touches as touch
      join public.deal_hunter_cim_campaigns as campaign on campaign.id = touch.campaign_id
      join pg_catalog.jsonb_array_elements_text(p_command -> 'taggedTouchIds') as tagged_touch
        on touch.id = tagged_touch.value
  )
  select coalesce(pg_catalog.array_agg(distinct conversation_id order by conversation_id),
    array[]::text[]) into v_conversation_ids from candidates;

  if pg_catalog.cardinality(v_conversation_ids) > 50 then
    raise exception 'Pursue CIM inbound evidence exceeds the bounded candidate set';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(conversation)
      order by conversation.id), '[]'::jsonb)
    into v_candidate_conversations
    from public.deal_hunter_broker_conversations as conversation
    where conversation.id = any(v_conversation_ids);

  if v_invalid_protected or pg_catalog.cardinality(v_conversation_ids) > 1 then
    return pg_catalog.jsonb_build_object('exact', false, 'ambiguous', true,
      'method', 'conflicting-exact-evidence', 'conversation', null,
      'transmission', null, 'campaignIds', '[]'::jsonb, 'touchIds', '[]'::jsonb,
      'candidateConversations', v_candidate_conversations);
  end if;
  if pg_catalog.cardinality(v_conversation_ids) = 0 then
    return pg_catalog.jsonb_build_object('exact', false, 'ambiguous', false,
      'method', 'none', 'conversation', null, 'transmission', null,
      'campaignIds', '[]'::jsonb, 'touchIds', '[]'::jsonb,
      'candidateConversations', '[]'::jsonb);
  end if;

  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_conversation_ids[1];
  if v_conversation.id is null then
    return pg_catalog.jsonb_build_object('exact', false, 'ambiguous', true,
      'method', 'conflicting-exact-evidence', 'conversation', null,
      'transmission', null, 'campaignIds', '[]'::jsonb, 'touchIds', '[]'::jsonb,
      'candidateConversations', v_candidate_conversations);
  end if;
  if exists (select 1 from public.deal_hunter_cim_transmissions as tr
      join pg_catalog.jsonb_array_elements_text(p_command -> 'replyToAddresses') as alias
        on pg_catalog.lower(tr.reply_to_address) = pg_catalog.lower(alias.value)
      where tr.conversation_id = v_conversation.id) then
    v_method := 'reply-alias';
  elsif exists (select 1 from public.deal_hunter_cim_transmissions as tr
      join pg_catalog.jsonb_array_elements_text(p_command -> 'providerMessageIds') as provider_id
        on tr.provider = v_provider and tr.provider_message_id = provider_id.value
      where tr.conversation_id = v_conversation.id) then
    v_method := 'provider-message';
  elsif exists (select 1 from public.crm_communications as communication
      join public.deal_hunter_cim_transmissions as tr on tr.communication_id = communication.id
      join pg_catalog.jsonb_array_elements_text(p_command -> 'rfcMessageIds') as rfc_id
        on communication.message_id = rfc_id.value
      where tr.conversation_id = v_conversation.id) then
    v_method := 'rfc-thread';
  else
    v_method := 'protected-tag';
  end if;

  select tr.* into v_transmission from public.deal_hunter_cim_transmissions as tr
    where tr.conversation_id = v_conversation.id
      and (tr.id = nullif(v_tagged_transmission, '')
        or pg_catalog.lower(tr.reply_to_address) in (select pg_catalog.lower(value)
          from pg_catalog.jsonb_array_elements_text(p_command -> 'replyToAddresses'))
        or (tr.provider = v_provider and tr.provider_message_id in (select value
          from pg_catalog.jsonb_array_elements_text(p_command -> 'providerMessageIds')))
        or tr.communication_id in (select communication.id
          from public.crm_communications as communication
          where communication.message_id in (select value
            from pg_catalog.jsonb_array_elements_text(p_command -> 'rfcMessageIds'))))
    order by case when tr.id = nullif(v_tagged_transmission, '') then 0 else 1 end,
      tr.updated_at desc, tr.id desc limit 1;
  select coalesce(pg_catalog.array_agg(id order by id), array[]::text[])
    into v_campaign_ids from public.deal_hunter_cim_campaigns
    where conversation_id = v_conversation.id;
  select coalesce(pg_catalog.array_agg(touch.id order by touch.id), array[]::text[])
    into v_touch_ids from public.deal_hunter_cim_campaign_touches as touch
    join public.deal_hunter_cim_campaigns as campaign on campaign.id = touch.campaign_id
    where campaign.conversation_id = v_conversation.id;
  return pg_catalog.jsonb_build_object('exact', true, 'ambiguous', false,
    'method', v_method, 'conversation', pg_catalog.to_jsonb(v_conversation),
    'transmission', case when v_transmission.id is null then null
      else pg_catalog.to_jsonb(v_transmission) end,
    'campaignIds', pg_catalog.to_jsonb(v_campaign_ids),
    'touchIds', pg_catalog.to_jsonb(v_touch_ids),
    'candidateConversations', '[]'::jsonb);
end;
$$;

revoke all on function public.pursue_cim_resolve_inbound_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_resolve_inbound_v1(jsonb) to service_role;

create or replace function public.pursue_cim_append_ambiguous_reply_review_v1(p_commands jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_result jsonb;
  v_scope_id text;
  v_prior_scope_id text := null;
  v_applied boolean := false;
  v_replay boolean := true;
  v_conversation_ids text[] := array[]::text[];
  v_cancelled text[] := array[]::text[];
begin
  if p_commands is null or pg_catalog.jsonb_typeof(p_commands) <> 'array'
    or pg_catalog.jsonb_array_length(p_commands) not between 1 and 50 then
    raise exception 'Ambiguous reply containment requires a bounded command array';
  end if;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_commands) with ordinality
      as command(value, ordinal) order by command.ordinal
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
      or v_item ->> 'scope' is distinct from 'conversation'
      or v_item ->> 'nextState' is distinct from 'reply-review-required'
      or v_item ->> 'reasonCode' is distinct from 'ambiguous_reply_evidence' then
      raise exception 'Invalid ambiguous reply containment command';
    end if;
    v_scope_id := public.pursue_cim_required_text_v1(v_item, 'scopeId', 240);
    if v_prior_scope_id is not null and v_prior_scope_id >= v_scope_id then
      raise exception 'Ambiguous reply containment commands must be unique and sorted';
    end if;
    v_prior_scope_id := v_scope_id;
    v_conversation_ids := pg_catalog.array_append(v_conversation_ids, v_scope_id);
  end loop;
  begin
    for v_item in select value from pg_catalog.jsonb_array_elements(p_commands) with ordinality
        as command(value, ordinal) order by command.ordinal
    loop
      v_result := public.pursue_cim_append_terminal_event_v1(v_item);
      if coalesce((v_result ->> 'conflict')::boolean, true) then
        raise exception 'Atomic ambiguous reply containment conflict';
      end if;
      v_applied := v_applied or coalesce((v_result ->> 'applied')::boolean, false);
      v_replay := v_replay and coalesce((v_result ->> 'replay')::boolean, false);
      v_cancelled := v_cancelled || coalesce(array(select value
        from pg_catalog.jsonb_array_elements_text(v_result -> 'cancelledTouchIds')),
        array[]::text[]);
    end loop;
  exception when raise_exception then
    if SQLERRM <> 'Atomic ambiguous reply containment conflict' then
      raise;
    end if;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'conversationIds', pg_catalog.to_jsonb(v_conversation_ids),
      'cancelledTouchIds', '[]'::jsonb);
  end;
  select coalesce(pg_catalog.array_agg(distinct value order by value), array[]::text[])
    into v_cancelled from pg_catalog.unnest(v_cancelled) as value;
  return pg_catalog.jsonb_build_object('applied', v_applied, 'replay', v_replay,
    'conflict', false, 'conversationIds', pg_catalog.to_jsonb(v_conversation_ids),
    'cancelledTouchIds', pg_catalog.to_jsonb(v_cancelled));
end;
$$;

revoke all on function public.pursue_cim_append_ambiguous_reply_review_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_ambiguous_reply_review_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_refresh_inbound_binding_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_campaign_ids text[];
  v_touch_ids text[];
  v_binding jsonb;
begin
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = new.transmission_id;
  select coalesce(pg_catalog.array_agg(distinct campaign_id order by campaign_id),
      array[]::text[]),
    coalesce(pg_catalog.array_agg(touch_id order by touch_id), array[]::text[])
    into v_campaign_ids, v_touch_ids
    from public.deal_hunter_cim_transmission_touches
    where transmission_id = new.transmission_id;
  v_binding := pg_catalog.jsonb_build_object(
    'transmissionId', v_transmission.id,
    'conversationId', v_transmission.conversation_id,
    'campaignIds', pg_catalog.to_jsonb(v_campaign_ids),
    'touchIds', pg_catalog.to_jsonb(v_touch_ids),
    'memberDigest', v_transmission.member_digest);
  update public.crm_communications
    set metadata = metadata || v_binding
    where id = v_transmission.communication_id
      and source = 'pursue-cim-autopilot';
  update public.crm_email_outbox
    set metadata = metadata || v_binding
    where id = v_transmission.outbox_id;
  return new;
end;
$$;

drop trigger if exists refresh_pursue_cim_inbound_binding
  on public.deal_hunter_cim_transmission_touches;
create trigger refresh_pursue_cim_inbound_binding
after insert on public.deal_hunter_cim_transmission_touches
for each row execute function public.pursue_cim_refresh_inbound_binding_v1();

revoke all on function public.pursue_cim_refresh_inbound_binding_v1()
  from public, anon, authenticated;
grant execute on function public.pursue_cim_refresh_inbound_binding_v1() to service_role;

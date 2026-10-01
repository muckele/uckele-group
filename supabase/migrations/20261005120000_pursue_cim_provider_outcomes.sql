-- Package 6C: one-shot provider outcome finalization and exact reconciliation.
-- Package 6D exclusively owns accepted-at cadence and follow-up slot derivation.

create or replace function public.pursue_cim_finalize_transmission_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id text := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_payload_digest text := public.pursue_cim_required_text_v1(p_command, 'payloadDigest', 64);
  v_expected bigint := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_outcome text := public.pursue_cim_required_text_v1(p_command, 'outcome', 40);
  v_provider text := public.pursue_cim_required_text_v1(p_command, 'provider', 80);
  v_message_id text := p_command ->> 'providerMessageId';
  v_result_code text := public.pursue_cim_required_text_v1(p_command, 'providerResultCode', 160);
  v_actor text := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_observed timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_existing boolean;
  v_next_state text;
  v_delivery_state text;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array[]::text[], array[]::text[], array['providerMessageId','observedAt']);
  v_observed := public.pursue_cim_required_instant_v1(
    pg_catalog.jsonb_build_object('observedAt',coalesce(p_command->>'observedAt',p_command->>'now')),
    'observedAt');
  if v_outcome not in ('accepted','definitive-failure','ambiguous')
    or v_provider <> 'resend'
    or v_payload_digest !~ '^[0-9a-f]{64}$'
    or (v_outcome = 'accepted' and (v_message_id is null
      or pg_catalog.length(v_message_id) not between 1 and 240
      or pg_catalog.btrim(v_message_id) <> v_message_id
      or v_message_id !~ '^[A-Za-z0-9_.:@-]+$'))
    or (v_message_id is not null and (pg_catalog.length(v_message_id) not between 1 and 240
      or pg_catalog.btrim(v_message_id) <> v_message_id
      or v_message_id !~ '^[A-Za-z0-9_.:@-]+$')) then
    raise exception 'Invalid Pursue CIM finalization command';
  end if;
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_id for update;
  if not found then return pg_catalog.jsonb_build_object('applied', false,
    'existing', false, 'conflict', true, 'transmission', null, 'nextTouch', null); end if;
  if v_transmission.payload_digest <> v_payload_digest then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'conflict', true, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'nextTouch', null);
  end if;
  if v_transmission.state in ('accepted','definitive-failure','ambiguous') then
    v_existing := v_transmission.state = v_outcome
      and v_transmission.provider = v_provider
      and v_transmission.provider_message_id is not distinct from v_message_id
      and v_transmission.provider_result_code = v_result_code;
    return pg_catalog.jsonb_build_object('applied', false, 'existing', v_existing,
      'conflict', not v_existing, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'nextTouch', null);
  end if;
  if v_transmission.state <> 'provider-pending'
    or v_transmission.row_version <> v_expected
    or v_transmission.invocation_authority_count <> 1
    or v_transmission.provider_seam_entered_at is null
    or not exists (select 1 from public.deal_hunter_cim_transmission_touches
      where transmission_id = v_id and cancelled_at is null)
    or exists (select 1 from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
      where m.transmission_id = v_id and m.cancelled_at is null
        and t.state <> 'provider-pending') then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'conflict', true, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'nextTouch', null);
  end if;
  update public.deal_hunter_cim_transmissions set state = v_outcome,
    provider = v_provider, provider_message_id = v_message_id,
    provider_result_code = v_result_code, row_version = row_version + 1,
    updated_at = v_now where id = v_id and state = 'provider-pending'
      and row_version = v_expected returning * into v_transmission;
  if not found then raise exception 'Concurrent Pursue CIM transmission finalization'; end if;
  v_next_state := case v_outcome when 'accepted' then 'active-follow-up'
    when 'definitive-failure' then 'action-required' else 'provider-ambiguous' end;
  for v_member in select t.*, c.state campaign_state,
      c.terminal_revision campaign_terminal_revision, c.row_version campaign_row_version,
      c.conversation_id campaign_conversation_id
    from public.deal_hunter_cim_transmission_touches m
    join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
    join public.deal_hunter_cim_campaigns c on c.id = m.campaign_id
    where m.transmission_id = v_id and m.cancelled_at is null
    order by t.id for update of m,t,c
  loop
    update public.deal_hunter_cim_campaign_touches set state = v_outcome,
      outcome_code = v_result_code, row_version = row_version + 1, updated_at = v_now
      where id = v_member.id and state = 'provider-pending'
        and row_version = v_member.row_version;
    if not found then raise exception 'Concurrent Pursue CIM touch finalization'; end if;
    insert into public.deal_hunter_cim_audit_events
      (id,event_type,opportunity_id,campaign_id,conversation_id,touch_id,transmission_id,
       prior_state,next_state,actor,source,occurred_at,metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('touch-finalized'::text),
      pg_catalog.to_jsonb(v_member.id || ':' || (v_member.row_version + 1)::text)),
      'touch-finalized',v_member.opportunity_id,v_member.campaign_id,
      v_member.campaign_conversation_id,v_member.id,v_id,'provider-pending',v_outcome,
      v_actor,'postgres-transition',v_now,'{}'::jsonb);
    if v_member.campaign_terminal_revision = v_transmission.campaign_terminal_revision
      and v_member.campaign_state in ('initial-pending','active-follow-up') then
      update public.deal_hunter_cim_campaigns set state = v_next_state,
        reason_code = case v_outcome when 'definitive-failure' then 'provider_definitive_failure'
          when 'ambiguous' then 'provider_ambiguous' else null end,
        initial_accepted_at = coalesce(initial_accepted_at,
          case when v_outcome = 'accepted' then v_observed else null end),
        row_version = row_version + 1, updated_at = v_now
        where id = v_member.campaign_id and row_version = v_member.campaign_row_version
          and terminal_revision = v_member.campaign_terminal_revision;
      if not found then raise exception 'Concurrent Pursue CIM campaign finalization'; end if;
      insert into public.deal_hunter_cim_audit_events
        (id,event_type,opportunity_id,campaign_id,prior_state,next_state,
         actor,source,occurred_at,metadata)
      values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('campaign-transition'::text),
        pg_catalog.to_jsonb(v_member.campaign_id || ':' ||
          (v_member.campaign_row_version + 1)::text)),
        'campaign-transition',v_member.opportunity_id,v_member.campaign_id,
        v_member.campaign_state,v_next_state,v_actor,'postgres-transition',v_now,'{}'::jsonb);
    end if;
  end loop;
  if v_outcome = 'ambiguous' then
    select * into v_conversation from public.deal_hunter_broker_conversations
      where id = v_transmission.conversation_id for update;
    if v_conversation.state = 'open' then
      update public.deal_hunter_broker_conversations set state = 'provider-ambiguous',
        terminal_revision = terminal_revision + 1, row_version = row_version + 1,
        updated_at = v_now where id = v_conversation.id and state = 'open'
          and row_version = v_conversation.row_version;
      insert into public.deal_hunter_cim_audit_events
        (id,event_type,conversation_id,transmission_id,prior_state,next_state,reason_code,
         payload_digest,actor,source,occurred_at,metadata)
      values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('conversation-provider-ambiguous'::text),
        pg_catalog.to_jsonb(v_conversation.id || ':' ||
          (v_conversation.terminal_revision + 1)::text)),
        'conversation-provider-ambiguous',v_conversation.id,v_id,'open','provider-ambiguous',
        'provider_ambiguous',v_transmission.payload_digest,v_actor,'postgres-transition',v_now,
        '{}'::jsonb);
    end if;
  end if;
  v_delivery_state := case when v_outcome = 'definitive-failure' then 'failed'
    else v_outcome end;
  update public.crm_communications set provider = v_provider,
    provider_message_id = v_message_id, delivery_state = v_delivery_state,
    delivery_state_at = v_observed, updated_at = v_now where id = v_transmission.communication_id;
  update public.crm_email_outbox set provider = v_provider,
    provider_message_id = v_message_id, state = v_delivery_state,
    attempt_count = 1, updated_at = v_now where id = v_transmission.outbox_id;
  insert into public.deal_hunter_cim_audit_events
    (id,event_type,conversation_id,transmission_id,prior_state,next_state,payload_digest,
     actor,source,occurred_at,metadata)
  values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
    pg_catalog.to_jsonb('transmission-finalized'::text),pg_catalog.to_jsonb(v_id)),
    'transmission-finalized',v_transmission.conversation_id,v_id,'provider-pending',v_outcome,
    v_transmission.payload_digest,v_actor,'postgres-transition',v_observed,'{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'existing', false,
    'conflict', false, 'transmission', pg_catalog.to_jsonb(v_transmission), 'nextTouch', null);
end;
$$;

revoke all on function public.pursue_cim_finalize_transmission_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_finalize_transmission_v1(jsonb) to service_role;

create or replace function public.pursue_cim_reconcile_transmission_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id text := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_payload_digest text := public.pursue_cim_required_text_v1(p_command, 'payloadDigest', 64);
  v_expected bigint := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_outcome text := public.pursue_cim_required_text_v1(p_command, 'outcome', 40);
  v_provider text := public.pursue_cim_required_text_v1(p_command, 'provider', 80);
  v_message_id text := p_command ->> 'providerMessageId';
  v_result_code text := public.pursue_cim_required_text_v1(p_command, 'providerResultCode', 160);
  v_evidence_type text := public.pursue_cim_required_text_v1(p_command, 'evidenceType', 120);
  v_evidence_id text := public.pursue_cim_required_text_v1(p_command, 'evidenceId', 240);
  v_evidence_digest text := public.pursue_cim_required_text_v1(p_command, 'evidenceDigest', 64);
  v_actor text := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_observed timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_prior public.deal_hunter_cim_audit_events%rowtype;
  v_member record;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_evidence_authority text;
  v_audit_id text;
  v_message_digest text;
  v_prior_state text;
  v_next_state text;
  v_delivery_state text;
  v_unchanged boolean;
  v_unresolved bigint;
  v_identity jsonb;
  v_identity_count bigint;
  v_evidence_payload_digest text;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array[]::text[], array[]::text[], array['providerMessageId','observedAt']);
  v_observed := public.pursue_cim_required_instant_v1(
    pg_catalog.jsonb_build_object('observedAt',coalesce(p_command->>'observedAt',p_command->>'now')),
    'observedAt');
  if v_outcome not in ('accepted','definitive-failure','ambiguous')
    or v_provider <> 'resend' or v_payload_digest !~ '^[0-9a-f]{64}$'
    or v_evidence_digest !~ '^[0-9a-f]{64}$'
    or (v_outcome = 'accepted' and (v_message_id is null
      or pg_catalog.length(v_message_id) not between 1 and 240
      or pg_catalog.btrim(v_message_id) <> v_message_id
      or v_message_id !~ '^[A-Za-z0-9_.:@-]+$'))
    or (v_outcome = 'ambiguous' and v_message_id is not null)
    or (v_message_id is not null and (pg_catalog.length(v_message_id) not between 1 and 240
      or pg_catalog.btrim(v_message_id) <> v_message_id
      or v_message_id !~ '^[A-Za-z0-9_.:@-]+$')) then
    raise exception 'Invalid Pursue CIM reconciliation command';
  end if;
  if p_command ? 'providerIdentities' then
    if pg_catalog.jsonb_typeof(p_command->'providerIdentities') <> 'array'
      or pg_catalog.jsonb_array_length(p_command->'providerIdentities') > 20 then
      raise exception 'Invalid provider identity conflict evidence';
    end if;
    if pg_catalog.jsonb_array_length(p_command->'providerIdentities') > 0 then
      if exists (select 1 from pg_catalog.jsonb_array_elements(
        p_command->'providerIdentities') as item(value)
        where pg_catalog.jsonb_typeof(value) <> 'object'
          or value - array['provider','providerMessageId','evidenceId','evidenceDigest'] <> '{}'::jsonb
          or value->>'provider' is distinct from 'resend'
          or value->>'providerMessageId' is null or value->>'evidenceId' is null
          or value->>'evidenceDigest' is null
          or pg_catalog.length(value->>'providerMessageId') not between 1 and 240
          or pg_catalog.btrim(value->>'providerMessageId') <> value->>'providerMessageId'
          or value->>'providerMessageId' !~ '^[A-Za-z0-9_.:@-]+$'
          or pg_catalog.length(value->>'evidenceId') not between 1 and 240
          or pg_catalog.btrim(value->>'evidenceId') <> value->>'evidenceId'
          or value->>'evidenceDigest' !~ '^[0-9a-f]{64}$') then
        raise exception 'Invalid provider identity conflict evidence';
      end if;
      select pg_catalog.count(distinct value->>'providerMessageId') into v_identity_count
        from pg_catalog.jsonb_array_elements(p_command->'providerIdentities');
      if v_outcome <> 'ambiguous'
        or pg_catalog.jsonb_array_length(p_command->'providerIdentities') < 2
        or v_identity_count < 2 then
        raise exception 'Provider identity evidence requires a multiple-ID ambiguity';
      end if;
    end if;
  end if;
  v_evidence_authority := v_id || ':' || v_evidence_type || ':' || v_evidence_id;
  v_audit_id := public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
    pg_catalog.to_jsonb('transmission-reconciled'::text),
    pg_catalog.to_jsonb(v_evidence_authority));
  v_message_digest := case when v_message_id is null then null
    else public.pursue_cim_digest_v1(pg_catalog.to_jsonb(v_message_id)) end;
  v_evidence_payload_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-provider-reconciliation-replay:v1'::text),
    pg_catalog.to_jsonb(v_message_id), pg_catalog.to_jsonb(v_observed),
    coalesce(p_command->'providerIdentities','[]'::jsonb));
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_id for update;
  if not found then return pg_catalog.jsonb_build_object('applied',false,'unchanged',false,
    'conflict',true,'transmission',null); end if;
  if v_transmission.payload_digest <> v_payload_digest then
    return pg_catalog.jsonb_build_object('applied',false,'unchanged',false,
      'conflict',true,'transmission',pg_catalog.to_jsonb(v_transmission));
  end if;
  select * into v_prior from public.deal_hunter_cim_audit_events where id = v_audit_id;
  if found then
    v_unchanged := v_prior.transmission_id = v_id
      and v_prior.authority_digest = v_evidence_digest
      and v_prior.source = v_evidence_type and v_prior.next_state = v_outcome
      and v_prior.reason_code = v_result_code
      and v_prior.payload_digest = v_evidence_payload_digest;
    return pg_catalog.jsonb_build_object('applied',false,'unchanged',v_unchanged,
      'conflict',not v_unchanged,'transmission',pg_catalog.to_jsonb(v_transmission));
  end if;
  if v_transmission.state in ('accepted','definitive-failure') then
    v_unchanged := v_transmission.state = v_outcome and v_transmission.provider = v_provider
      and v_transmission.provider_message_id is not distinct from v_message_id;
    if v_unchanged then
      insert into public.deal_hunter_cim_audit_events
        (id,event_type,conversation_id,transmission_id,prior_state,next_state,reason_code,
         authority_digest,payload_digest,actor,source,occurred_at,metadata)
      values (v_audit_id,'transmission-reconciled',v_transmission.conversation_id,v_id,
        v_transmission.state,v_transmission.state,v_result_code,v_evidence_digest,
        v_evidence_payload_digest,v_actor,v_evidence_type,v_observed,'{}'::jsonb);
    end if;
    return pg_catalog.jsonb_build_object('applied',false,'unchanged',v_unchanged,
      'conflict',not v_unchanged,'transmission',pg_catalog.to_jsonb(v_transmission));
  end if;
  if v_transmission.state = 'ambiguous' and v_outcome = 'ambiguous'
    and v_transmission.provider = v_provider and v_transmission.provider_message_id is null then
    insert into public.deal_hunter_cim_audit_events
      (id,event_type,conversation_id,transmission_id,prior_state,next_state,reason_code,
       authority_digest,payload_digest,actor,source,occurred_at,metadata)
    values (v_audit_id,'transmission-reconciled',v_transmission.conversation_id,v_id,
      'ambiguous','ambiguous',v_result_code,v_evidence_digest,v_evidence_payload_digest,
      v_actor,v_evidence_type,
      v_observed,'{}'::jsonb);
    return pg_catalog.jsonb_build_object('applied',false,'unchanged',true,
      'conflict',false,'transmission',pg_catalog.to_jsonb(v_transmission));
  end if;
  if v_transmission.state not in ('provider-pending','ambiguous')
    or v_transmission.row_version <> v_expected
    or v_transmission.invocation_authority_count <> 1
    or (v_transmission.provider is not null and v_transmission.provider <> v_provider)
    or not exists (select 1 from public.deal_hunter_cim_transmission_touches
      where transmission_id = v_id and cancelled_at is null)
    or exists (select 1 from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
      where m.transmission_id = v_id and m.cancelled_at is null
        and t.state not in ('provider-pending','ambiguous')) then
    return pg_catalog.jsonb_build_object('applied',false,'unchanged',false,
      'conflict',true,'transmission',pg_catalog.to_jsonb(v_transmission));
  end if;
  v_prior_state := v_transmission.state;
  update public.deal_hunter_cim_transmissions set state = v_outcome, provider = v_provider,
    provider_message_id = v_message_id, provider_result_code = v_result_code,
    row_version = row_version + 1, updated_at = v_now
    where id = v_id and state in ('provider-pending','ambiguous')
      and row_version = v_expected returning * into v_transmission;
  if not found then raise exception 'Concurrent Pursue CIM transmission reconciliation'; end if;
  v_next_state := case v_outcome when 'accepted' then 'active-follow-up'
    when 'definitive-failure' then 'action-required' else 'provider-ambiguous' end;
  for v_member in select t.*,c.state campaign_state,
      c.terminal_revision campaign_terminal_revision,c.row_version campaign_row_version,
      c.conversation_id campaign_conversation_id
    from public.deal_hunter_cim_transmission_touches m
    join public.deal_hunter_cim_campaign_touches t on t.id=m.touch_id
    join public.deal_hunter_cim_campaigns c on c.id=m.campaign_id
    where m.transmission_id=v_id and m.cancelled_at is null
    order by t.id for update of m,t,c
  loop
    update public.deal_hunter_cim_campaign_touches set state=v_outcome,
      outcome_code=v_result_code,row_version=row_version+1,updated_at=v_now
      where id=v_member.id and row_version=v_member.row_version
        and state in ('provider-pending','ambiguous');
    if not found then raise exception 'Concurrent Pursue CIM touch reconciliation'; end if;
    insert into public.deal_hunter_cim_audit_events
      (id,event_type,opportunity_id,campaign_id,touch_id,transmission_id,prior_state,next_state,
       authority_digest,actor,source,occurred_at,metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('touch-reconciled'::text),
      pg_catalog.to_jsonb(v_member.id||':'||(v_member.row_version+1)::text)),
      'touch-reconciled',v_member.opportunity_id,v_member.campaign_id,v_member.id,v_id,
      v_member.state,v_outcome,v_evidence_digest,v_actor,v_evidence_type,v_observed,'{}'::jsonb);
    if v_member.campaign_terminal_revision = v_transmission.campaign_terminal_revision
      and v_member.campaign_state in ('provider-ambiguous','initial-pending','active-follow-up') then
      update public.deal_hunter_cim_campaigns set state=v_next_state,
        reason_code=case v_outcome when 'definitive-failure' then 'provider_definitive_failure'
          when 'ambiguous' then 'provider_ambiguous' else null end,
        initial_accepted_at=coalesce(initial_accepted_at,
          case when v_outcome='accepted' then v_observed else null end),
        row_version=row_version+1,updated_at=v_now
        where id=v_member.campaign_id and row_version=v_member.campaign_row_version
          and terminal_revision=v_member.campaign_terminal_revision;
      if not found then raise exception 'Concurrent Pursue CIM campaign reconciliation'; end if;
      insert into public.deal_hunter_cim_audit_events
        (id,event_type,opportunity_id,campaign_id,prior_state,next_state,authority_digest,
         actor,source,occurred_at,metadata)
      values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('campaign-transition'::text),
        pg_catalog.to_jsonb(v_member.campaign_id||':'||(v_member.campaign_row_version+1)::text)),
        'campaign-transition',v_member.opportunity_id,v_member.campaign_id,
        v_member.campaign_state,v_next_state,v_evidence_digest,v_actor,v_evidence_type,
        v_observed,'{}'::jsonb);
    end if;
  end loop;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id=v_transmission.conversation_id for update;
  if v_outcome='ambiguous' and v_conversation.state='open' then
    update public.deal_hunter_broker_conversations set state='provider-ambiguous',
      terminal_revision=terminal_revision+1,row_version=row_version+1,updated_at=v_now
      where id=v_conversation.id and row_version=v_conversation.row_version and state='open';
    insert into public.deal_hunter_cim_audit_events
      (id,event_type,conversation_id,transmission_id,prior_state,next_state,reason_code,
       authority_digest,actor,source,occurred_at,metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('conversation-provider-ambiguous'::text),
      pg_catalog.to_jsonb(v_conversation.id||':'||(v_conversation.terminal_revision+1)::text)),
      'conversation-provider-ambiguous',v_conversation.id,v_id,'open','provider-ambiguous',
      'provider_ambiguous',v_evidence_digest,v_actor,v_evidence_type,v_observed,'{}'::jsonb);
  elsif v_outcome<>'ambiguous' and v_conversation.state='provider-ambiguous' then
    select pg_catalog.count(*) into v_unresolved
      from public.deal_hunter_cim_transmissions where conversation_id=v_conversation.id
        and id<>v_id and state in ('provider-pending','ambiguous');
    if v_unresolved=0 then
      update public.deal_hunter_broker_conversations set state='open',
        terminal_revision=terminal_revision+1,row_version=row_version+1,updated_at=v_now
        where id=v_conversation.id and row_version=v_conversation.row_version
          and state='provider-ambiguous';
      insert into public.deal_hunter_cim_audit_events
        (id,event_type,conversation_id,transmission_id,prior_state,next_state,authority_digest,
         actor,source,occurred_at,metadata)
      values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('conversation-provider-reconciled'::text),
        pg_catalog.to_jsonb(v_conversation.id||':'||(v_conversation.terminal_revision+1)::text)),
        'conversation-provider-reconciled',v_conversation.id,v_id,'provider-ambiguous','open',
        v_evidence_digest,v_actor,v_evidence_type,v_observed,'{}'::jsonb);
    end if;
  end if;
  v_delivery_state := case when v_outcome='definitive-failure' then 'failed' else v_outcome end;
  update public.crm_communications set provider=v_provider,provider_message_id=v_message_id,
    delivery_state=v_delivery_state,delivery_state_at=v_observed,updated_at=v_now
    where id=v_transmission.communication_id;
  update public.crm_email_outbox set provider=v_provider,provider_message_id=v_message_id,
    state=v_delivery_state,attempt_count=1,updated_at=v_now where id=v_transmission.outbox_id;
  insert into public.deal_hunter_cim_audit_events
    (id,event_type,conversation_id,transmission_id,prior_state,next_state,reason_code,
     authority_digest,payload_digest,actor,source,occurred_at,metadata)
  values (v_audit_id,'transmission-reconciled',v_transmission.conversation_id,v_id,
    v_prior_state,v_outcome,v_result_code,v_evidence_digest,v_evidence_payload_digest,
    v_actor,v_evidence_type,v_observed,'{}'::jsonb);
  if v_outcome='ambiguous' and pg_catalog.jsonb_typeof(p_command->'providerIdentities')='array' then
    for v_identity in select value from pg_catalog.jsonb_array_elements(p_command->'providerIdentities') loop
      if v_identity->>'providerMessageId' is null or v_identity->>'evidenceId' is null
        or v_identity->>'evidenceDigest' !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid provider identity conflict evidence';
      end if;
      insert into public.deal_hunter_cim_audit_events
        (id,event_type,conversation_id,transmission_id,prior_state,next_state,reason_code,
         authority_digest,payload_digest,actor,source,occurred_at,metadata)
      values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('provider-identity-conflict'::text),
        pg_catalog.to_jsonb(v_evidence_authority||':'||(v_identity->>'evidenceId'))),
        'provider-identity-conflict',v_transmission.conversation_id,v_id,v_prior_state,'ambiguous',
        'multiple_provider_ids',v_identity->>'evidenceDigest',
        public.pursue_cim_digest_v1(pg_catalog.to_jsonb(v_identity->>'providerMessageId')),
        v_actor,v_evidence_type,v_observed,'{}'::jsonb);
    end loop;
  end if;
  return pg_catalog.jsonb_build_object('applied',true,'unchanged',false,'conflict',false,
    'transmission',pg_catalog.to_jsonb(v_transmission));
end;
$$;

revoke all on function public.pursue_cim_reconcile_transmission_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_reconcile_transmission_v1(jsonb) to service_role;

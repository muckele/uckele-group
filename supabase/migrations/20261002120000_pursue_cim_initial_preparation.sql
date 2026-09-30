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

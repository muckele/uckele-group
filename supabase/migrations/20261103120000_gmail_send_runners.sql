-- Gmail send runners: storage foundations.
--
-- Forward-only and re-runnable. Adds the owner's Gmail connection, the revisioned
-- Pursue send controls, the conversation's Gmail thread, and lets the provider
-- outcome RPCs accept the gmail adapter alongside resend. New tables are
-- service-role only and written only through the RPCs below.

create table if not exists public.deal_hunter_gmail_connections (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 120),
  email_address text not null
    check (email_address = btrim(email_address) and char_length(email_address) between 3 and 320),
  refresh_token_ciphertext text not null
    check (refresh_token_ciphertext ~ '^v1\.[A-Za-z0-9+/_=-]+\.[A-Za-z0-9+/_=-]+\.[A-Za-z0-9+/_=-]+$'
      and char_length(refresh_token_ciphertext) <= 8192),
  granted_scopes jsonb not null default '[]'::jsonb check (jsonb_typeof(granted_scopes) = 'array'),
  connected_at timestamptz not null,
  connected_by text not null
    check (connected_by = btrim(connected_by) and char_length(connected_by) between 1 and 200),
  revoked_at timestamptz,
  revoked_by text check (revoked_by is null
    or (revoked_by = btrim(revoked_by) and char_length(revoked_by) between 1 and 200)),
  history_checkpoint text check (history_checkpoint is null or history_checkpoint ~ '^[0-9]{1,30}$'),
  last_token_ok_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'),
  constraint deal_hunter_gmail_connections_revocation check ((revoked_at is null) = (revoked_by is null))
);
create unique index if not exists uq_deal_hunter_gmail_connections_active
  on public.deal_hunter_gmail_connections ((true)) where revoked_at is null;

create table if not exists public.deal_hunter_pursue_send_controls (
  control_key text primary key
    check (control_key in ('live_sending', 'contact_rule', 'wording_approval')),
  enabled boolean not null,
  value_digest text check (value_digest is null or value_digest ~ '^[0-9a-f]{64}$'),
  policy_version text check (policy_version is null
    or (policy_version = btrim(policy_version) and char_length(policy_version) between 1 and 120)),
  changed_at timestamptz not null,
  changed_by text not null
    check (changed_by = btrim(changed_by) and char_length(changed_by) between 1 and 200),
  revision bigint not null check (revision >= 1),
  constraint deal_hunter_pursue_send_controls_wording_digest
    check (control_key <> 'wording_approval' or not enabled or value_digest is not null)
);

alter table public.deal_hunter_gmail_connections enable row level security;
alter table public.deal_hunter_pursue_send_controls enable row level security;
revoke all on table public.deal_hunter_gmail_connections
  from public, anon, authenticated, service_role;
revoke all on table public.deal_hunter_pursue_send_controls
  from public, anon, authenticated, service_role;
grant select on table public.deal_hunter_gmail_connections to service_role;
grant select on table public.deal_hunter_pursue_send_controls to service_role;

alter table public.deal_hunter_broker_conversations
  add column if not exists gmail_thread_id text
    constraint deal_hunter_broker_conversations_gmail_thread_id_check
    check (gmail_thread_id is null or gmail_thread_id ~ '^[A-Za-z0-9_-]{1,240}$');
create index if not exists idx_deal_hunter_broker_conversations_gmail_thread
  on public.deal_hunter_broker_conversations (gmail_thread_id) where gmail_thread_id is not null;

-- Stores a new active connection and revokes any prior active row in one transaction.
-- The instant check takes the CIM writer lock, so connection writes are serialized.
create or replace function public.deal_hunter_gmail_save_connection_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_id text := public.pursue_cim_required_text_v1(p_command, 'id', 120);
  v_email text := public.pursue_cim_required_text_v1(p_command, 'emailAddress', 320);
  v_ciphertext text := public.pursue_cim_required_text_v1(p_command, 'refreshTokenCiphertext', 8192);
  v_connected_by text := public.pursue_cim_required_text_v1(p_command, 'connectedBy', 200);
  v_checkpoint text := p_command ->> 'historyCheckpoint';
  v_row public.deal_hunter_gmail_connections%rowtype;
begin
  if pg_catalog.jsonb_typeof(p_command -> 'grantedScopes') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_command -> 'grantedScopes') > 20
    or exists (select 1 from pg_catalog.jsonb_array_elements(p_command -> 'grantedScopes') as scope
      where pg_catalog.jsonb_typeof(scope) <> 'string'
        or (scope #>> '{}') !~ '^[^[:space:]]{1,200}$')
    or v_ciphertext !~ '^v1\.[A-Za-z0-9+/_=-]+\.[A-Za-z0-9+/_=-]+\.[A-Za-z0-9+/_=-]+$'
    or pg_catalog.char_length(v_email) < 3
    or pg_catalog.jsonb_typeof(p_command -> 'historyCheckpoint') not in ('string', 'null')
    or (v_checkpoint is not null and v_checkpoint !~ '^[0-9]{1,30}$')
  then
    raise exception 'Invalid Gmail connection';
  end if;
  update public.deal_hunter_gmail_connections
    set revoked_at = v_now, revoked_by = v_connected_by
    where revoked_at is null;
  insert into public.deal_hunter_gmail_connections
    (id, email_address, refresh_token_ciphertext, granted_scopes, connected_at, connected_by,
      history_checkpoint)
  values (v_id, v_email, v_ciphertext, p_command -> 'grantedScopes', v_now, v_connected_by, v_checkpoint)
  returning * into v_row;
  return pg_catalog.to_jsonb(v_row);
end;
$$;
revoke all on function public.deal_hunter_gmail_save_connection_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_gmail_save_connection_v1(jsonb) to service_role;

-- Revokes the active connection; returns it, or null when none is active.
create or replace function public.deal_hunter_gmail_revoke_connection_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_revoked_by text := public.pursue_cim_required_text_v1(p_command, 'revokedBy', 200);
  v_row public.deal_hunter_gmail_connections%rowtype;
begin
  update public.deal_hunter_gmail_connections
    set revoked_at = v_now, revoked_by = v_revoked_by
    where revoked_at is null
    returning * into v_row;
  if not found then return null; end if;
  return pg_catalog.to_jsonb(v_row);
end;
$$;
revoke all on function public.deal_hunter_gmail_revoke_connection_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_gmail_revoke_connection_v1(jsonb) to service_role;

-- A successful token check clears the error code; a failed one keeps the last good instant.
create or replace function public.deal_hunter_gmail_record_token_check_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_error_code text := p_command ->> 'errorCode';
  v_row public.deal_hunter_gmail_connections%rowtype;
begin
  if pg_catalog.jsonb_typeof(p_command -> 'ok') is distinct from 'boolean'
    or (not (p_command ->> 'ok')::boolean
      and (v_error_code is null or v_error_code !~ '^[a-z0-9_]{1,80}$')) then
    raise exception 'Invalid Gmail token check';
  end if;
  if (p_command ->> 'ok')::boolean then
    update public.deal_hunter_gmail_connections
      set last_token_ok_at = v_now, last_error_code = null
      where revoked_at is null returning * into v_row;
  else
    update public.deal_hunter_gmail_connections
      set last_error_code = v_error_code
      where revoked_at is null returning * into v_row;
  end if;
  if not found then return null; end if;
  return pg_catalog.to_jsonb(v_row);
end;
$$;
revoke all on function public.deal_hunter_gmail_record_token_check_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_gmail_record_token_check_v1(jsonb) to service_role;

-- Compare-and-set of the active connection's reply checkpoint; true when it advanced.
create or replace function public.deal_hunter_gmail_update_checkpoint_v1(p_command jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_expected text := p_command ->> 'expected';
  v_next text := p_command ->> 'next';
begin
  if pg_catalog.jsonb_typeof(p_command -> 'expected') not in ('string', 'null')
    or (v_expected is not null and v_expected !~ '^[0-9]{1,30}$')
    or pg_catalog.jsonb_typeof(p_command -> 'next') is distinct from 'string'
    or v_next !~ '^[0-9]{1,30}$' then
    raise exception 'Invalid Gmail history checkpoint';
  end if;
  update public.deal_hunter_gmail_connections
    set history_checkpoint = v_next
    where revoked_at is null and history_checkpoint is not distinct from v_expected;
  return found;
end;
$$;
revoke all on function public.deal_hunter_gmail_update_checkpoint_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_gmail_update_checkpoint_v1(jsonb) to service_role;

-- Revisioned write of one send control. A stale expected revision returns conflict and
-- writes nothing; an applied change appends one immutable CIM audit event.
create or replace function public.deal_hunter_pursue_set_send_control_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_key text := p_command ->> 'controlKey';
  v_expected bigint := public.pursue_cim_required_revision_v1(p_command, 'expectedRevision');
  v_actor text := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_digest text := p_command ->> 'valueDigest';
  v_policy text := p_command ->> 'policyVersion';
  v_reason text := coalesce(p_command ->> 'reason', '');
  v_enabled boolean;
  v_current public.deal_hunter_pursue_send_controls%rowtype;
  v_row public.deal_hunter_pursue_send_controls%rowtype;
  v_revision bigint;
begin
  if v_key is null or v_key not in ('live_sending', 'contact_rule', 'wording_approval')
    or pg_catalog.jsonb_typeof(p_command -> 'enabled') is distinct from 'boolean'
    or pg_catalog.jsonb_typeof(p_command -> 'valueDigest') not in ('string', 'null')
    or (v_digest is not null and v_digest !~ '^[0-9a-f]{64}$')
    or pg_catalog.jsonb_typeof(p_command -> 'policyVersion') not in ('string', 'null')
    or (v_policy is not null and (pg_catalog.char_length(v_policy) not between 1 and 120
      or pg_catalog.btrim(v_policy) <> v_policy))
    or pg_catalog.jsonb_typeof(p_command -> 'reason') not in ('string', 'null')
    or pg_catalog.char_length(v_reason) > 500 then
    raise exception 'Invalid Pursue send control';
  end if;
  v_enabled := (p_command ->> 'enabled')::boolean;
  select * into v_current from public.deal_hunter_pursue_send_controls
    where control_key = v_key for update;
  if coalesce(v_current.revision, 0) <> v_expected then
    return pg_catalog.jsonb_build_object('applied', false, 'conflict', true,
      'control', case when v_current.control_key is null then null
        else pg_catalog.to_jsonb(v_current) end);
  end if;
  v_revision := v_expected + 1;
  insert into public.deal_hunter_pursue_send_controls
    (control_key, enabled, value_digest, policy_version, changed_at, changed_by, revision)
  values (v_key, v_enabled, v_digest, v_policy, v_now, v_actor, v_revision)
  on conflict (control_key) do update set enabled = excluded.enabled,
    value_digest = excluded.value_digest, policy_version = excluded.policy_version,
    changed_at = excluded.changed_at, changed_by = excluded.changed_by, revision = excluded.revision
  returning * into v_row;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, prior_state, next_state, reason_code, authority_digest, actor, source,
      occurred_at, metadata)
  values ('send-control:' || v_key || ':' || v_revision, 'send-control-changed',
    case when coalesce(v_current.enabled, false) then 'on' else 'off' end,
    case when v_enabled then 'on' else 'off' end, v_key, v_digest, v_actor, 'pursue-send-controls',
    v_now, pg_catalog.jsonb_build_object('controlKey', v_key, 'revision', v_revision,
      'policyVersion', v_policy, 'valueDigest', v_digest, 'reason', v_reason));
  return pg_catalog.jsonb_build_object('applied', true, 'conflict', false,
    'control', pg_catalog.to_jsonb(v_row));
end;
$$;
revoke all on function public.deal_hunter_pursue_set_send_control_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_pursue_set_send_control_v1(jsonb) to service_role;

-- Records a conversation's Gmail thread once: the same thread again is a replay and a
-- different one a conflict. The terminal writers' row_version is left alone.
create or replace function public.deal_hunter_gmail_set_conversation_thread_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_conversation_id text := public.pursue_cim_required_text_v1(p_command, 'conversationId', 240);
  v_thread text := p_command ->> 'gmailThreadId';
  v_current text;
begin
  if pg_catalog.jsonb_typeof(p_command -> 'gmailThreadId') is distinct from 'string'
    or v_thread !~ '^[A-Za-z0-9_-]{1,240}$' then
    raise exception 'Invalid gmailThreadId';
  end if;
  select gmail_thread_id into v_current from public.deal_hunter_broker_conversations
    where id = v_conversation_id for update;
  if not found then raise exception 'Unknown Pursue CIM conversation'; end if;
  if v_current = v_thread then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', true, 'conflict', false);
  end if;
  if v_current is not null then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true);
  end if;
  update public.deal_hunter_broker_conversations
    set gmail_thread_id = v_thread, updated_at = v_now
    where id = v_conversation_id;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false, 'conflict', false);
end;
$$;
revoke all on function public.deal_hunter_gmail_set_conversation_thread_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_gmail_set_conversation_thread_v1(jsonb) to service_role;

-- Non-terminal conversations with a Gmail thread, each with its most recent non-terminal
-- campaign (or its most recent campaign when all are terminal).
create or replace function public.deal_hunter_gmail_list_open_conversations_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'conversation_id', v.id, 'gmail_thread_id', v.gmail_thread_id,
      'recipient_fingerprint', v.recipient_fingerprint,
      'campaign_id', (select c.id from public.deal_hunter_cim_campaigns c
        where c.conversation_id = v.id
        order by c.state in ('responded', 'materials-received', 'stopped', 'expired'),
          c.created_at desc, c.id desc limit 1))
    order by v.id), '[]'::jsonb)
  from public.deal_hunter_broker_conversations v
  where v.gmail_thread_id is not null
    and v.state in ('open', 'reply-review-required', 'provider-ambiguous');
$$;
revoke all on function public.deal_hunter_gmail_list_open_conversations_v1()
  from public, anon, authenticated;
grant execute on function public.deal_hunter_gmail_list_open_conversations_v1() to service_role;

-- Provider outcomes accept the gmail adapter alongside resend. These redefine, with only
-- the provider pin changed, the bodies from 20261005120000 (finalize and reconcile, renamed
-- to the _p7a implementations by 20261008120000) and 20261007120000 (inbound resolution).

create or replace function public.pursue_cim_finalize_transmission_p7a(p_command jsonb)
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
    or v_provider not in ('resend','gmail')
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


revoke all on function public.pursue_cim_finalize_transmission_p7a(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.pursue_cim_reconcile_transmission_p7a(p_command jsonb)
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
    or v_provider not in ('resend','gmail') or v_payload_digest !~ '^[0-9a-f]{64}$'
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
          or coalesce(value->>'provider','') not in ('resend','gmail')
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


revoke all on function public.pursue_cim_reconcile_transmission_p7a(jsonb)
  from public, anon, authenticated, service_role;

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
    or coalesce(v_provider,'') not in ('resend','gmail')
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

-- The standing listing-broker contact rule (listing-broker-inquiry-v1) is a campaign
-- permission basis beside the fl04b-enrollment activation. True when the command names the
-- rule, the rule is on, and the command carries its current revision and that revision's
-- policy digest: sha256 of {"policyVersion":"listing-broker-inquiry-v1","revision":N}.
-- Callers hold the CIM writer lock, which the send-control writer also takes.
create or replace function public.deal_hunter_pursue_contact_rule_basis_v1(p_command jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_control public.deal_hunter_pursue_send_controls%rowtype;
  v_digest text;
begin
  if p_command ->> 'permissionVersion' is distinct from 'listing-broker-inquiry-v1'
    or pg_catalog.jsonb_typeof(p_command -> 'permissionRevision') is distinct from 'number' then
    return false;
  end if;
  select * into v_control from public.deal_hunter_pursue_send_controls
    where control_key = 'contact_rule';
  if v_control.control_key is null or not v_control.enabled
    or v_control.revision::text <> p_command ->> 'permissionRevision' then
    return false;
  end if;
  v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    '{"policyVersion":"listing-broker-inquiry-v1","revision":' || v_control.revision::text || '}',
    'UTF8')), 'hex');
  return p_command ->> 'permissionDigest' = v_digest and p_command ->> 'policyHash' = v_digest;
end;
$$;
revoke all on function public.deal_hunter_pursue_contact_rule_basis_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_pursue_contact_rule_basis_v1(jsonb) to service_role;

-- Campaign materialization accepts the contact rule basis. These redefine, with only the
-- permission check changed, the bodies from 20260925120000 (v1) and 20261001130000 (v2).
create or replace function public.pursue_cim_materialize_campaign_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text;
  v_enrollment_id text;
  v_policy text;
  v_template text;
  v_permission text;
  v_permission_scope text;
  v_recipient_authority text;
  v_address text;
  v_sender_policy text;
  v_reply_policy text;
  v_thread_key text;
  v_batching_policy text;
  v_cadence_policy text;
  v_due_local text;
  v_actor text;
  v_template_digest text := p_command ->> 'templateDigest';
  v_permission_digest text := p_command ->> 'permissionDigest';
  v_recipient_fingerprint text := p_command ->> 'recipientFingerprint';
  v_reply_alias_digest text := p_command ->> 'replyAliasTokenDigest';
  v_freshness_digest text := p_command ->> 'freshnessAuthorityDigest';
  v_crm_text text := p_command ->> 'crmSubmissionId';
  v_crm_id uuid;
  v_enrollment_expected bigint;
  v_generation bigint;
  v_permission_revision bigint;
  v_canonical_revision bigint;
  v_crm_revision bigint;
  v_discovery bigint;
  v_material bigint;
  v_timezone_revision bigint;
  v_now timestamptz;
  v_due timestamptz;
  v_campaign_id text;
  v_conversation_id text;
  v_touch_id text;
  v_current public.deal_hunter_cim_campaigns%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_timezone public.deal_hunter_opportunity_timezone_revisions%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_crm public.contact_submissions%rowtype;
  v_same boolean;
begin
  v_opportunity_id := public.pursue_cim_required_text_v1(p_command,'opportunityId',200);
  v_enrollment_id := public.pursue_cim_required_text_v1(p_command,'enrollmentId',240);
  v_policy := public.pursue_cim_required_text_v1(p_command,'policyVersion',120);
  v_template := public.pursue_cim_required_text_v1(p_command,'templateVersion',120);
  v_permission := public.pursue_cim_required_text_v1(p_command,'permissionVersion',120);
  v_permission_scope := public.pursue_cim_required_text_v1(p_command,'permissionScope',240);
  v_recipient_authority := public.pursue_cim_required_text_v1(p_command,'recipientAuthorityId',240);
  v_address := public.pursue_cim_required_text_v1(p_command,'recipientAddress',320);
  v_sender_policy := public.pursue_cim_required_text_v1(p_command,'senderPolicyVersion',120);
  v_reply_policy := public.pursue_cim_required_text_v1(p_command,'replyPolicyVersion',120);
  v_thread_key := public.pursue_cim_required_text_v1(p_command,'rfcThreadKey',500);
  v_batching_policy := public.pursue_cim_required_text_v1(p_command,'batchingPolicyVersion',120);
  v_cadence_policy := public.pursue_cim_required_text_v1(p_command,'cadencePolicyVersion',120);
  v_due_local := public.pursue_cim_required_text_v1(p_command,'dueLocal',120);
  v_actor := public.pursue_cim_required_text_v1(p_command,'actor',200);
  v_enrollment_expected := public.pursue_cim_required_revision_v1(p_command,'expectedEnrollmentRowVersion');
  v_generation := public.pursue_cim_required_revision_v1(p_command,'generation');
  v_permission_revision := public.pursue_cim_required_revision_v1(p_command,'permissionRevision');
  v_canonical_revision := public.pursue_cim_required_revision_v1(p_command,'canonicalRevision');
  v_crm_revision := public.pursue_cim_required_revision_v1(p_command,'crmOwnershipRevision');
  v_discovery := public.pursue_cim_required_revision_v1(p_command,'expectedDiscoveryRevision');
  v_material := public.pursue_cim_required_revision_v1(p_command,'expectedMaterialRevision');
  v_timezone_revision := public.pursue_cim_required_revision_v1(p_command,'timezoneRevision');
  if v_template_digest !~ '^[0-9a-f]{64}$'
    or v_permission_digest !~ '^[0-9a-f]{64}$'
    or v_recipient_fingerprint !~ '^[0-9a-f]{64}$'
    or v_reply_alias_digest !~ '^[0-9a-f]{64}$'
    or v_freshness_digest !~ '^[0-9a-f]{64}$'
    or pg_catalog.jsonb_typeof(p_command -> 'dueAt') <> 'string'
    or pg_catalog.jsonb_typeof(p_command -> 'now') <> 'string'
  then
    raise exception 'Invalid Pursue CIM campaign authority input';
  end if;
  v_due := public.pursue_cim_required_instant_v1(p_command, 'dueAt');
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_campaign_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-campaign:v1'::text), pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_generation), pg_catalog.to_jsonb(v_policy));
  v_conversation_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-conversation:v1'::text),
    pg_catalog.to_jsonb(v_recipient_fingerprint), pg_catalog.to_jsonb(v_sender_policy));
  v_touch_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-touch:v1'::text), pg_catalog.to_jsonb(v_campaign_id),
    pg_catalog.to_jsonb('initial'::text), pg_catalog.to_jsonb(v_cadence_policy));
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  select * into v_current from public.deal_hunter_cim_campaigns
    where opportunity_id = v_opportunity_id order by generation desc limit 1 for update;
  if found then
    v_same := v_current.id = v_campaign_id and v_current.enrollment_id = v_enrollment_id
      and v_current.template_digest = v_template_digest
      and v_current.permission_digest = v_permission_digest
      and v_current.recipient_fingerprint = v_recipient_fingerprint
      and v_current.timezone_revision = v_timezone_revision;
    select * into v_touch from public.deal_hunter_cim_campaign_touches
      where campaign_id = v_current.id and logical_slot = 'initial';
    return pg_catalog.jsonb_build_object('applied', false, 'existing', v_same,
      'actionRequired', not v_same, 'campaign', pg_catalog.to_jsonb(v_current),
      'initialTouch', case when found then pg_catalog.to_jsonb(v_touch) else null end);
  end if;
  if v_generation <> 1 then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where id = v_enrollment_id for update;
  if v_enrollment.id is not null then
    select * into v_decision from public.deal_hunter_owner_decision_events
      where id = v_enrollment.decision_event_id;
  end if;
  select * into v_timezone from public.deal_hunter_opportunity_timezone_revisions
    where opportunity_id = v_opportunity_id order by revision desc limit 1 for share;
  if v_crm_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_crm_id := v_crm_text::uuid;
    select * into v_crm from public.contact_submissions where id = v_crm_id for share;
  end if;
  if (public.pursue_cim_current_activation_v1('fl04b-enrollment',v_now) is null
      and not public.deal_hunter_pursue_contact_rule_basis_v1(p_command))
    or v_enrollment.id is null or v_enrollment.opportunity_id <> v_opportunity_id
    or v_enrollment.state not in ('queued','waiting-on-eligibility')
    or v_enrollment.row_version <> v_enrollment_expected
    or v_decision.id is null or v_decision.action <> 'pursue'
    or v_opportunity.opportunity_id is null or v_opportunity.status <> 'active'
    or v_opportunity.discovery_revision <> v_discovery
    or v_opportunity.material_revision <> v_material
    or v_timezone.revision is null or v_timezone.revision <> v_timezone_revision
    or v_timezone.state not in ('verified','derived')
    or v_crm.id is null or v_crm.deal_hunter_opportunity_id <> v_opportunity_id
    or v_crm.archived_at is not null or v_opportunity.primary_submission_id <> v_crm.id
    or exists (select 1 from public.deal_hunter_cim_requests
      where opportunity_id = v_opportunity_id and
        (delivery_state in ('accepted','ambiguous') or
         request_state in ('provider_pending','provider_accepted')))
  then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_conversation_id for update;
  if found and (v_conversation.recipient_authority_id <> v_recipient_authority
    or v_conversation.recipient_address <> v_address
    or v_conversation.recipient_fingerprint <> v_recipient_fingerprint
    or v_conversation.state <> 'open')
  then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  if v_conversation.id is null then
    insert into public.deal_hunter_broker_conversations
      (id, recipient_authority_id, recipient_fingerprint, recipient_address,
       sender_policy_version, reply_policy_version, reply_alias_token_digest,
       rfc_thread_key, state, batching_policy_version, created_at, updated_at)
    values (v_conversation_id, v_recipient_authority, v_recipient_fingerprint, v_address,
      v_sender_policy, v_reply_policy, v_reply_alias_digest, v_thread_key,
      'open', v_batching_policy, v_now, v_now);
  end if;
  insert into public.deal_hunter_cim_campaigns
    (id, opportunity_id, generation, enrollment_id, decision_event_id, policy_version,
     template_version, template_digest, permission_version, permission_digest,
     permission_revision, permission_scope, canonical_revision, crm_submission_id,
     crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
     freshness_authority_digest, discovery_revision, material_revision,
     timezone_revision, conversation_id, state, reason_code, created_at, updated_at)
  values (v_campaign_id, v_opportunity_id, v_generation, v_enrollment_id, v_decision.id,
    v_policy, v_template, v_template_digest, v_permission, v_permission_digest,
    v_permission_revision, v_permission_scope, v_canonical_revision, v_crm.id,
    v_crm_revision, v_recipient_authority, v_recipient_fingerprint,
    v_freshness_digest, v_discovery, v_material, v_timezone_revision,
    v_conversation_id, 'initial-pending', 'awaiting-window', v_now, v_now)
  returning * into v_campaign;
  insert into public.deal_hunter_cim_campaign_touches
    (id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
     due_at, due_local, timezone_revision, state, created_at, updated_at)
  values (v_touch_id, v_campaign_id, v_opportunity_id, 'initial', 'initial', 0,
    v_due, v_due_local, v_timezone_revision, 'scheduled', v_now, v_now)
  returning * into v_touch;
  update public.deal_hunter_pursuit_enrollments
    set state = 'campaign-created', reason_code = null,
      updated_at = v_now, row_version = row_version + 1
    where id = v_enrollment_id and row_version = v_enrollment_expected;
  if not found then
    raise exception 'Concurrent Pursue CIM enrollment allocation';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id,
     next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('campaign-allocated'::text),
      pg_catalog.to_jsonb(v_campaign_id)),
    'campaign-allocated', v_opportunity_id, v_campaign_id, v_conversation_id,
    'initial-pending', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
     next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('touch-created'::text), pg_catalog.to_jsonb(v_touch_id)),
    'touch-created', v_opportunity_id, v_campaign_id, v_conversation_id, v_touch_id,
    'scheduled', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, prior_state, next_state,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('enrollment-transition'::text),
      pg_catalog.to_jsonb(v_enrollment_id || ':' || (v_enrollment_expected + 1)::text)),
    'enrollment-transition', v_opportunity_id, v_enrollment.state, 'campaign-created',
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'existing', false,
    'actionRequired', false, 'campaign', pg_catalog.to_jsonb(v_campaign),
    'initialTouch', pg_catalog.to_jsonb(v_touch));
end;
$$;
revoke all on function public.pursue_cim_materialize_campaign_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_materialize_campaign_v1(jsonb) to service_role;

create or replace function public.pursue_cim_materialize_campaign_v2(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_activation_id text;
  v_expected bigint;
  v_campaign_expected bigint;
  v_global_expected bigint;
  v_global bigint;
  v_ownership public.deal_hunter_crm_ownership_revisions%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
  v_crm_match_fingerprint text;
begin
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'crmOwnershipRevision');
  v_campaign_expected := public.pursue_cim_required_revision_v1(p_command, 'campaignAuthorityRevision');
  v_global_expected := public.pursue_cim_required_revision_v1(p_command, 'globalAuthorityRevision');
  lock table public.contact_submissions, public.crm_submission_supersessions in share mode;
  v_crm_match_fingerprint := public.pursue_cim_crm_match_fingerprint_v1();
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_command ->> 'opportunityId' for update;
  select * into v_ownership from public.deal_hunter_crm_ownership_revisions
    where opportunity_id = v_opportunity.opportunity_id
    order by revision desc limit 1;
  select * into v_score from public.deal_hunter_opportunity_scores
    where opportunity_id = v_opportunity.opportunity_id for share;
  select revision into v_global from public.deal_hunter_cim_global_authority
    where id = 'global' for share;
  v_activation_id := public.pursue_cim_current_activation_v1('fl04b-enrollment',
    public.pursue_cim_required_instant_v1(p_command, 'now'));
  if v_activation_id is not null then
    select * into v_activation from public.deal_hunter_cim_capability_activations
      where id = v_activation_id for share;
  end if;
  if v_opportunity.opportunity_id is null
    or v_expected is distinct from v_ownership.revision
    or v_ownership.submission_id is distinct from (p_command ->> 'crmSubmissionId')
    or v_score.opportunity_id is null
    or v_score.operator_priority <> 'high'
    or v_score.reviewed_at is null
    or v_score.current_triage_eligible is distinct from true
    or v_score.should_remove is distinct from false
    or (case when coalesce(v_score.reviewed_semantic_digest, '') <> ''
      then v_score.reviewed_semantic_digest is distinct from v_score.semantic_digest
      else coalesce(v_score.reviewed_fingerprint, '') <> ''
        and v_score.reviewed_fingerprint is distinct from v_score.score_fingerprint end)
    or v_crm_match_fingerprint is null
    or v_crm_match_fingerprint is distinct from (p_command ->> 'crmMatchAuthorityFingerprint')
    or not (p_command ? 'crmBrokerEmail')
    or not exists (select 1 from public.contact_submissions as contact
      where contact.id = v_opportunity.primary_submission_id
        and contact.status not in ('archived', 'spam')
        and contact.archived_at is null
        and contact.deal_hunter_opportunity_id = v_opportunity.opportunity_id
        and contact.broker_email is not distinct from (p_command ->> 'crmBrokerEmail')
        and (contact.metadata -> 'dealHunter' ->> 'opportunityId' is null
          or contact.metadata -> 'dealHunter' ->> 'opportunityId' = v_opportunity.opportunity_id))
    or exists (select 1 from public.crm_submission_supersessions as relation
      where relation.superseded_submission_id = v_opportunity.primary_submission_id
        and relation.status = 'active')
    or v_campaign_expected <> v_opportunity.campaign_authority_revision
    or v_global is distinct from v_global_expected
    or exists (select 1 from public.deal_hunter_source_freshness_state
      where projection_state in ('pending', 'deferred', 'superseded'))
    or exists (select 1 from public.deal_hunter_identity_exceptions
      where status = 'open')
    or exists (select 1 from public.deal_hunter_cim_requests as request
      where request.opportunity_id = v_opportunity.opportunity_id
        or request.deal_key in (select score.deal_key
          from public.deal_hunter_opportunity_scores as score
          where score.opportunity_id = v_opportunity.opportunity_id))
    or exists (select 1 from public.deal_hunter_cim_opportunity_claims
      where opportunity_id = v_opportunity.opportunity_id)
    or exists (select 1 from public.email_suppressions
      where normalized_email = pg_catalog.lower(p_command ->> 'recipientAddress')
        and lifted_at is null)
    or exists (select 1 from public.contact_submissions
      where id = v_opportunity.primary_submission_id and prospectus_url is not null
        and pg_catalog.btrim(prospectus_url) <> '')
    or exists (select 1 from public.secure_documents
      where submission_id = v_opportunity.primary_submission_id)
    or exists (select 1 from public.secure_upload_requests
      where submission_id = v_opportunity.primary_submission_id
        and status in ('completed', 'documents-received'))
    or exists (select 1 from public.crm_communications
      where submission_id = v_opportunity.primary_submission_id and direction = 'inbound')
    or (not public.deal_hunter_pursue_contact_rule_basis_v1(p_command) and (
      v_activation.id is null
      or v_activation.id <> (p_command ->> 'permissionVersion')
      or v_activation.permission_basis_digest is distinct from (p_command ->> 'permissionDigest')
      or v_activation.permission_revision is distinct from
        public.pursue_cim_required_revision_v1(p_command, 'permissionRevision')
      or v_activation.cohort_digest is distinct from (p_command ->> 'permissionScope')
      or v_activation.policy_hash is distinct from (p_command ->> 'policyHash'))) then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  return public.pursue_cim_materialize_campaign_v1(p_command);
end;
$$;
revoke all on function public.pursue_cim_materialize_campaign_v2(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_materialize_campaign_v2(jsonb)
  to service_role;

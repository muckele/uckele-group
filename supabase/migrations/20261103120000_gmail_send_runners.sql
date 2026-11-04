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
-- rule, the rule is on under the same policy version, and the command carries that version's
-- policy digest: sha256 of {"policyVersion":"listing-broker-inquiry-v1"}. The control
-- revision is not compared, so off pauses rule-based campaigns and on again resumes them.
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
  v_digest text := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    '{"policyVersion":"listing-broker-inquiry-v1"}', 'UTF8')), 'hex');
begin
  if p_command ->> 'permissionVersion' is distinct from 'listing-broker-inquiry-v1' then
    return false;
  end if;
  select * into v_control from public.deal_hunter_pursue_send_controls
    where control_key = 'contact_rule';
  if v_control.control_key is null or not v_control.enabled
    or v_control.policy_version is distinct from 'listing-broker-inquiry-v1' then
    return false;
  end if;
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

-- Gmail dispatch through the CIM final gate (Task 6).
-- The durable final gate accepts a single-member follow-up under fl04c-followup and a
-- campaign whose permission basis is the standing contact rule (Ruling H, Ruling I). This
-- redefines the p7a body from 20261008120000 with only those checks changed; the initial
-- path under the activation basis is unchanged.
create or replace function public.pursue_cim_authorize_provider_pending_p7a(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_authorization_id text;
  v_provider_profile text;
  v_gate_digest text;
  v_actor text;
  v_now timestamptz;
  v_expected_global bigint;
  v_expected_row bigint;
  v_snapshot jsonb;
  v_readiness jsonb;
  v_members jsonb;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_communication public.crm_communications%rowtype;
  v_outbox public.crm_email_outbox%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_permission_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_follow_up boolean := false;
  v_rule_campaign boolean := false;
  v_rule_on boolean := false;
  v_rule_digest text := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    '{"policyVersion":"listing-broker-inquiry-v1"}', 'UTF8')), 'hex');
  v_pause boolean;
  v_global bigint;
  v_member record;
  v_expected_member jsonb;
  v_member_ids text[] := array[]::text[];
  v_reason text;
  v_result jsonb;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_authorization_id := public.pursue_cim_required_text_v1(p_command, 'authorizationId', 240);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_gate_digest := public.pursue_cim_required_text_v1(p_command, 'finalGateAuthorityDigest', 64);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_expected_global := public.pursue_cim_required_revision_v1(
    p_command, 'expectedGlobalAuthorityRevision');
  v_expected_row := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_snapshot := p_command -> 'authoritySnapshot';
  v_readiness := v_snapshot -> 'readiness';
  v_members := v_snapshot -> 'members';

  <<gate>>
  begin
    select * into v_transmission from public.deal_hunter_cim_transmissions
      where id = v_transmission_id for update;
    if not found then v_reason := 'lifecycle_conflict'; exit gate; end if;
    if v_transmission.state <> 'prepared' or v_transmission.invocation_authority_count <> 0 then
      v_reason := 'already_provider_pending'; exit gate;
    end if;
    if v_transmission.row_version <> v_expected_row then
      v_reason := 'stale_authority'; exit gate;
    end if;
    if pg_catalog.jsonb_typeof(v_snapshot) is distinct from 'object'
      or v_snapshot ->> 'version' <> 'cim-final-gate-authority-v1'
      or v_snapshot ->> 'gateInstant' <> (p_command ->> 'now')
      or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        public.pursue_cim_canonical_json_v1(v_snapshot), 'UTF8')), 'hex') <> v_gate_digest
      or pg_catalog.jsonb_typeof(v_members) is distinct from 'array'
      or pg_catalog.jsonb_array_length(v_members) < 1
    then v_reason := 'lifecycle_conflict'; exit gate; end if;
    if v_snapshot #>> '{transmission,id}' is distinct from v_transmission.id
      or (v_snapshot #>> '{transmission,rowVersion}')::bigint <> v_transmission.row_version
      or v_snapshot #>> '{transmission,payloadDigest}' is distinct from v_transmission.payload_digest
      or v_snapshot #>> '{transmission,memberDigest}' is distinct from v_transmission.member_digest
    then v_reason := 'lifecycle_conflict'; exit gate; end if;

    select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
      where id = v_authorization_id for update;
    if not found or v_snapshot #>> '{authorization,id}' is distinct from v_authorization.id
      or v_snapshot #>> '{authorization,activation_id}' is distinct from v_authorization.activation_id
    then v_reason := 'live_authorization_invalid'; exit gate; end if;
    select * into v_conversation from public.deal_hunter_broker_conversations
      where id = v_transmission.conversation_id for update;
    if not found then v_reason := 'recipient_authority_changed'; exit gate; end if;
    if v_snapshot #>> '{conversation,batchingPolicyVersion}'
        is distinct from v_conversation.batching_policy_version
      or v_conversation.batching_policy_version is distinct from 'batching-off-v1'
    then v_reason := 'unknown_policy_version'; exit gate; end if;
    if v_snapshot #>> '{conversation,id}' is distinct from v_conversation.id
      or v_snapshot #>> '{conversation,recipientFingerprint}'
        is distinct from v_conversation.recipient_fingerprint
    then v_reason := 'recipient_authority_changed'; exit gate; end if;

    -- Campaigns precede memberships/touches so terminal writers share this order.
    perform 1 from public.deal_hunter_cim_campaigns c
      join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
      where m.transmission_id = v_transmission_id order by c.id for update of c;
    perform 1 from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
      where m.transmission_id = v_transmission_id order by m.touch_id for update of m,t;
    perform 1 from public.deal_hunter_owner_decision_events d
      join public.deal_hunter_cim_campaigns c on c.decision_event_id = d.id
      join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
      where m.transmission_id = v_transmission_id order by d.id for update of d;
    perform 1 from public.deal_hunter_pursuit_enrollments e
      join public.deal_hunter_cim_campaigns c on c.enrollment_id = e.id
      join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
      where m.transmission_id = v_transmission_id order by e.id for update of e;
    perform 1 from public.deal_hunter_opportunities o
      join public.deal_hunter_cim_transmission_touches m
        on m.opportunity_id = o.opportunity_id
      where m.transmission_id = v_transmission_id order by o.opportunity_id for update of o;
    perform 1 from public.deal_hunter_opportunity_timezone_revisions tz
      join public.deal_hunter_cim_transmission_touches m
        on m.opportunity_id = tz.opportunity_id
      where m.transmission_id = v_transmission_id
      order by tz.opportunity_id, tz.revision for update of tz;
    perform 1 from public.deal_hunter_crm_ownership_revisions cr
      join public.deal_hunter_cim_transmission_touches m
        on m.opportunity_id = cr.opportunity_id
      where m.transmission_id = v_transmission_id
      order by cr.opportunity_id, cr.revision for update of cr;
    perform 1 from public.contact_submissions cs
      join public.deal_hunter_cim_campaigns c on c.crm_submission_id = cs.id
      join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
      where m.transmission_id = v_transmission_id order by cs.id for update of cs;
    select * into v_activation from public.deal_hunter_cim_capability_activations
      where id = v_authorization.activation_id for share;
    if not found then v_reason := 'permission_changed'; exit gate; end if;
    -- A follow-up is one single-member transmission under fl04c-followup. Its activation-basis
    -- permission is checked against the fl04b-initial activation in its chain, exactly as an
    -- initial's is checked against its own fl04b-initial activation.
    if v_authorization.capability not in ('fl04b-initial','fl04c-followup') then
      v_reason := 'capability_inactive'; exit gate;
    end if;
    v_follow_up := v_authorization.capability = 'fl04c-followup';
    if v_follow_up then
      select * into v_permission_activation from public.deal_hunter_cim_capability_activations
        where id = v_activation.prerequisite_activation_id for share;
      if not found or public.pursue_cim_current_activation_v1('fl04b-initial', v_now)
          is distinct from v_permission_activation.id
      then v_reason := 'capability_inactive'; exit gate; end if;
    else
      v_permission_activation := v_activation;
    end if;
    -- Ruling H: a rule-based campaign sends only while the contact rule is on under its
    -- policy version. The control writer takes the CIM writer lock this gate holds.
    select coalesce(c.enabled, false) and c.policy_version = 'listing-broker-inquiry-v1'
      into v_rule_on from public.deal_hunter_pursue_send_controls c
      where c.control_key = 'contact_rule';
    v_rule_on := coalesce(v_rule_on, false);
    -- This row is later updated by communication/global-authority triggers. Take the
    -- write-strength lock once, after member authority rows, so concurrent gates serialize
    -- without a shared-to-exclusive lock upgrade deadlock.
    select revision into v_global from public.deal_hunter_cim_global_authority
      where id = 'global' for update;
    select outreach_paused into v_pause from public.deal_hunter_cim_safety_settings
      where id = 'global' for share;
    if v_pause is distinct from false then v_reason := 'central_pause'; exit gate; end if;
    if v_global is distinct from v_expected_global
      or (v_snapshot ->> 'globalAuthorityRevision')::bigint is distinct from v_global
    then v_reason := 'freshness_changed'; exit gate; end if;
    for v_member in
      select m.*, t.state as touch_state, t.row_version as touch_row_version,
        t.claim_token_digest, t.claim_expires_at, t.due_at, t.transmission_id as touch_transmission_id,
        t.kind, t.logical_slot, t.ordinal, t.timezone_revision as touch_timezone_revision,
        c.generation, c.policy_version, c.state as campaign_state,
        c.terminal_revision, c.row_version as campaign_row_version, c.conversation_id,
        c.crm_submission_id, c.crm_ownership_revision, c.recipient_fingerprint,
        c.discovery_revision, c.material_revision, c.timezone_revision,
        c.local_expiry_at, c.decision_event_id, c.enrollment_id,
        c.permission_digest, c.permission_revision, c.permission_scope, c.permission_version,
        o.status as opportunity_status, o.primary_submission_id,
        o.discovery_state, o.discovery_revision as current_discovery_revision,
        o.material_revision as current_material_revision,
        o.campaign_authority_revision, d.action as owner_action,
        e.state as enrollment_state, e.row_version as enrollment_row_version,
        cr.revision as current_crm_revision, cr.submission_id as current_crm_submission,
        cs.archived_at, cs.deal_hunter_opportunity_id, cs.metadata as submission_metadata
      from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
      join public.deal_hunter_cim_campaigns c on c.id = m.campaign_id
      join public.deal_hunter_opportunities o on o.opportunity_id = m.opportunity_id
      join public.deal_hunter_owner_decision_events d on d.id = c.decision_event_id
      join public.deal_hunter_pursuit_enrollments e on e.id = c.enrollment_id
      left join lateral (select x.revision, x.submission_id
        from public.deal_hunter_crm_ownership_revisions x
        where x.opportunity_id = m.opportunity_id order by x.revision desc limit 1) cr on true
      left join public.contact_submissions cs on cs.id = c.crm_submission_id
      where m.transmission_id = v_transmission_id and m.cancelled_at is null
      order by m.touch_id
    loop
      v_member_ids := pg_catalog.array_append(v_member_ids, v_member.touch_id);
      select value into v_expected_member from pg_catalog.jsonb_array_elements(v_members)
        where value #>> '{touch,id}' = v_member.touch_id limit 1;
      if v_expected_member is null then v_reason := 'membership_changed'; exit gate; end if;
      v_rule_campaign := coalesce(v_member.permission_version = 'listing-broker-inquiry-v1'
        and v_member.permission_digest = v_rule_digest, false);
      if v_expected_member #>> '{campaign,permission_version}'
          is distinct from v_member.permission_version
        or (not v_rule_campaign and v_member.permission_version
          is distinct from v_permission_activation.prerequisite_activation_id)
      then v_reason := 'unknown_policy_version'; exit gate; end if;
      if (case when v_follow_up
            then v_member.kind = 'initial' or v_member.logical_slot = 'initial'
              or v_member.ordinal < 1
            else v_member.kind <> 'initial' or v_member.logical_slot <> 'initial'
              or v_member.ordinal <> 0 end)
        or v_member.generation <> 1
        or v_member.policy_version <> 'deal-hunter-cim-autopilot-v1'
        or v_member.campaign_state
          <> (case when v_follow_up then 'active-follow-up' else 'initial-pending' end)
        or v_member.touch_timezone_revision <> v_member.timezone_revision
      then v_reason := 'lifecycle_conflict'; exit gate; end if;
      if v_rule_campaign and not v_rule_on then
        v_reason := 'contact_rule_off'; exit gate;
      end if;
      if (v_expected_member #>> '{campaign,row_version}')::bigint
          is distinct from v_member.campaign_row_version
        or v_expected_member #>> '{campaign,permission_digest}'
          is distinct from v_member.permission_digest
        or (v_expected_member #>> '{campaign,permission_revision}')::bigint
          is distinct from v_member.permission_revision
        or v_expected_member #>> '{campaign,permission_scope}'
          is distinct from v_member.permission_scope
        or (not v_rule_campaign and (
          v_permission_activation.permission_basis_digest is distinct from v_member.permission_digest
          or v_permission_activation.permission_revision is distinct from v_member.permission_revision
          or v_permission_activation.cohort_digest is distinct from v_member.permission_scope))
      then v_reason := 'permission_changed'; exit gate; end if;
      if v_member.owner_action <> 'pursue' or v_member.enrollment_state <> 'campaign-created'
        or v_expected_member #>> '{decision,id}' is distinct from v_member.decision_event_id
        or v_expected_member #>> '{enrollment,id}' is distinct from v_member.enrollment_id
        or (v_expected_member #>> '{enrollment,row_version}')::bigint
          <> v_member.enrollment_row_version
      then v_reason := 'owner_intent_changed'; exit gate; end if;
      if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          public.pursue_cim_canonical_json_v1(
            (v_expected_member -> 'recipientAuthority') - 'authorityDigest'), 'UTF8')), 'hex')
          is distinct from v_expected_member #>> '{recipientAuthority,authorityDigest}'
        or coalesce((v_expected_member #>> '{recipientAuthority,present}')::boolean, false)
          is distinct from true
        or v_expected_member #>> '{recipientAuthority,derivedRecipientFingerprint}'
          is distinct from v_member.recipient_fingerprint
        or v_member.recipient_fingerprint is distinct from
          v_authorization.recipient_authority_digest
      then v_reason := 'recipient_authority_changed'; exit gate; end if;
      if exists (select 1 from public.deal_hunter_owner_decision_events x
        where x.opportunity_id = v_member.opportunity_id
          and (x.created_at, x.id) > ((select created_at
            from public.deal_hunter_owner_decision_events where id = v_member.decision_event_id),
            v_member.decision_event_id))
      then v_reason := 'owner_intent_changed'; exit gate; end if;
      if v_member.opportunity_status <> 'active' then
        v_reason := 'identity_authority_changed'; exit gate;
      end if;
      if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          public.pursue_cim_canonical_json_v1(
            (v_expected_member -> 'sourceAuthority') - 'authorityDigest'), 'UTF8')), 'hex')
          is distinct from v_expected_member #>> '{sourceAuthority,authorityDigest}'
        or coalesce((v_expected_member #>> '{sourceAuthority,ready}')::boolean, false) is distinct from true
        or (v_expected_member #>> '{sourceAuthority,globalAuthorityRevision}')::bigint
          <> v_expected_global
        or (v_expected_member #>> '{sourceAuthority,opportunity,campaignAuthorityRevision}')::bigint
          <> v_member.campaign_authority_revision
        or not exists (select 1 from public.deal_hunter_opportunity_source_observations x
          where x.opportunity_id = v_member.opportunity_id and x.accepted_at is not null)
        or exists (select 1 from public.deal_hunter_source_freshness_state x
          where x.projection_state <> 'accepted')
      then v_reason := 'source_authority_unavailable'; exit gate; end if;
      if v_member.discovery_state = 'pending'
        or v_member.current_discovery_revision <> v_member.discovery_revision
        or v_member.current_material_revision <> v_member.material_revision
      then v_reason := 'freshness_changed'; exit gate; end if;
      if exists (select 1 from public.deal_hunter_identity_exceptions x
        where x.status = 'open' and x.candidate_opportunity_ids ? v_member.opportunity_id)
      then v_reason := 'identity_authority_changed'; exit gate; end if;
      if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          public.pursue_cim_canonical_json_v1(
            (v_expected_member -> 'materialsAuthority') - 'authorityDigest'), 'UTF8')), 'hex')
          is distinct from v_expected_member #>> '{materialsAuthority,authorityDigest}'
      then v_reason := 'source_authority_unavailable'; exit gate; end if;
      if coalesce((v_expected_member #>> '{materialsAuthority,priorRequestPresent}')::boolean, false)
        or exists (select 1 from public.deal_hunter_cim_requests x
          where x.opportunity_id = v_member.opportunity_id
            or x.deal_key in (select s.deal_key from public.deal_hunter_opportunity_scores s
              where s.opportunity_id = v_member.opportunity_id))
        or exists (select 1 from public.deal_hunter_cim_opportunity_claims x
          where x.opportunity_id = v_member.opportunity_id)
      then v_reason := 'lifecycle_conflict'; exit gate; end if;
      if coalesce((v_expected_member #>> '{materialsAuthority,pursued}')::boolean, false)
          is distinct from true
        or v_expected_member #>> '{materialsAuthority,disposition}' = 'dismissed'
      then v_reason := 'owner_intent_changed'; exit gate; end if;
      if coalesce((v_expected_member #>> '{materialsAuthority,suppressionPresent}')::boolean, false)
      then v_reason := 'recipient_suppressed'; exit gate; end if;
      if coalesce(v_expected_member #>> '{materialsAuthority,terminalReason}', '') <> ''
      then v_reason := 'terminal_authority_changed'; exit gate; end if;
      if pg_catalog.jsonb_array_length(coalesce(
          v_expected_member #> '{materialsAuthority,preparationBlockerCodes}', '[]'::jsonb)) > 0
      then v_reason := 'source_authority_unavailable'; exit gate; end if;
      if coalesce((
        coalesce((v_expected_member #>> '{materialsAuthority,materialsReceived}')::boolean, false)
        or coalesce((v_expected_member #>> '{materialsAuthority,advancedBeyondBrokerOutreach}')::boolean, false)
        or exists (select 1 from public.secure_documents x
          where x.submission_id = v_member.crm_submission_id and (
            public.pursue_cim_material_token_p7b(x.document_type)
              in ('cim','teaser','prospectus','offering_memorandum','offering_materials',
                'data_room','broker_materials','financials','financial_package',
                'financial_statements','p_and_l','tax_returns','balance_sheet')
            or public.pursue_cim_material_filename_kind_p7b(
              coalesce(x.original_name, x.file_name, '')) <> ''
          ))
        or exists (select 1 from (
            select candidate.* from public.secure_upload_requests candidate
            where candidate.submission_id = v_member.crm_submission_id
            order by candidate.created_at desc, candidate.id desc limit 1
          ) request
          cross join lateral pg_catalog.jsonb_array_elements(
            case when pg_catalog.jsonb_typeof(request.requested_documents) = 'array'
              then request.requested_documents else '[]'::jsonb end) requested(item)
          where pg_catalog.replace(public.pursue_cim_material_token_p7b(request.status), '_', '-')
              in ('completed','documents-received')
            and public.pursue_cim_material_token_p7b(coalesce(
              case when pg_catalog.jsonb_typeof(requested.item) = 'string'
                then requested.item #>> '{}'
                else coalesce(requested.item ->> 'category', requested.item ->> 'id') end,
              ''))
              in ('cim','teaser','prospectus','offering_memorandum','offering_materials',
                'data_room','broker_materials','financials','financial_package',
                'financial_statements','p_and_l','tax_returns','balance_sheet'))
        or exists (select 1 from public.contact_submissions x where x.id = v_member.crm_submission_id
          and nullif(pg_catalog.btrim(x.prospectus_url), '') is not null)
        or pg_catalog.replace(public.pursue_cim_material_token_p7b(
          v_member.submission_metadata #>> '{diligence,stage}'), '_', '-')
          in ('cim-received', 'financial-review', 'lender-review', 'loi-candidate')
        or pg_catalog.replace(public.pursue_cim_material_token_p7b(
          v_member.submission_metadata #>> '{acquisitionCommand,pipelineStage}'), '_', '-')
          in ('docs-received', 'diligence', 'loi-candidate')
        or v_member.submission_metadata #> '{diligence,checklist,cim}' = 'true'::jsonb
        or v_member.submission_metadata #> '{diligence,checklist,p_and_l}' = 'true'::jsonb
        or v_member.submission_metadata #> '{diligence,checklist,tax_returns}' = 'true'::jsonb
        or v_member.submission_metadata #> '{diligence,checklist,balance_sheet}' = 'true'::jsonb
      ), false)
      then v_reason := 'materials_received'; exit gate; end if;
      if v_member.archived_at is not null
        or v_member.deal_hunter_opportunity_id <> v_member.opportunity_id
        or v_member.primary_submission_id::text <> v_member.crm_submission_id::text
        or v_member.current_crm_submission::text <> v_member.crm_submission_id::text
        or v_member.current_crm_revision <> v_member.crm_ownership_revision
        or exists (select 1 from public.crm_submission_supersessions x
          where x.superseded_submission_id::text = v_member.crm_submission_id::text
            and x.status = 'active')
      then v_reason := 'crm_owner_changed'; exit gate; end if;
    end loop;
    if v_follow_up and pg_catalog.cardinality(v_member_ids) <> 1 then
      v_reason := 'lifecycle_conflict'; exit gate;
    end if;
    if pg_catalog.cardinality(v_member_ids) <> pg_catalog.jsonb_array_length(v_members)
      or v_transmission.member_digest <> public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-members:v1'::text), pg_catalog.to_jsonb(v_member_ids))
    then v_reason := 'membership_changed'; exit gate; end if;

    select * into v_communication from public.crm_communications
      where id = v_transmission.communication_id for update;
    select * into v_outbox from public.crm_email_outbox
      where id = v_transmission.outbox_id for update;
    if not found then v_reason := 'outbox_changed'; exit gate; end if;
    if pg_catalog.jsonb_typeof(v_readiness) is distinct from 'object'
      or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        public.pursue_cim_canonical_json_v1(v_readiness - 'authorityDigest'), 'UTF8')), 'hex')
        is distinct from v_readiness ->> 'authorityDigest'
      or coalesce((v_readiness ->> 'ready')::boolean, false) is distinct from true
      or v_readiness ->> 'version' <> 'cim-provider-readiness-v1'
      or v_readiness ->> 'providerProfile' <> v_provider_profile
      or (v_readiness ->> 'expiresAt')::timestamptz <= v_now
    then v_reason := 'provider_readiness_unavailable'; exit gate; end if;
    if exists (select 1 from public.crm_communications x where x.direction = 'inbound'
      and (x.thread_key = v_conversation.rfc_thread_key
        or x.submission_id = any(array(select c.crm_submission_id
          from public.deal_hunter_cim_campaigns c
          join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
          where m.transmission_id = v_transmission_id))))
    then v_reason := 'reply_received'; exit gate; end if;
    if v_communication.direction <> 'outbound' or v_communication.channel <> 'email'
      or v_communication.source <> 'pursue-cim-autopilot'
      or v_communication.kind
        <> (case when v_follow_up then 'cim-follow-up' else 'cim-initial' end)
      or v_communication.thread_key <> v_conversation.rfc_thread_key
      or v_communication.from_address <> v_transmission.from_address
      or v_communication.to_addresses <> v_transmission.to_addresses
      or v_communication.cc_addresses <> v_transmission.cc_addresses
      or v_communication.bcc_addresses <> v_transmission.bcc_addresses
      or v_communication.reply_to_address <> v_transmission.reply_to_address
      or v_communication.subject <> v_transmission.subject
    then v_reason := 'communication_changed'; exit gate; end if;
    if v_outbox.state <> 'prepared' or v_outbox.attempt_count <> 0
      or v_outbox.claim_token is not null or v_outbox.provider is not null
      or v_outbox.provider_message_id is not null or v_outbox.next_attempt_at is not null
      or v_outbox.metadata ->> 'retryPolicy' <> 'reconcile-only-after-provider-pending'
    then v_reason := 'outbox_changed'; exit gate; end if;
    if v_follow_up and not exists (select 1 from public.deal_hunter_cim_capacity_reservations r
        where r.transmission_id = v_transmission_id and r.touch_id = v_member_ids[1]
          and r.state = 'reserved' and r.claim_token_digest = p_command ->> 'claimTokenDigest'
          and r.expires_at > v_now)
    then v_reason := 'capacity_reservation_invalid'; exit gate; end if;
  end gate;

  if v_reason is not null then
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, conversation_id, transmission_id, prior_state, next_state,
       reason_code, authority_digest, payload_digest, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-final-gate-block:v1'::text),
        pg_catalog.to_jsonb(v_transmission_id), pg_catalog.to_jsonb(v_transmission.row_version),
        pg_catalog.to_jsonb(v_reason), pg_catalog.to_jsonb(v_gate_digest)),
      'final-gate-blocked', v_transmission.conversation_id, v_transmission_id,
      v_transmission.state, v_transmission.state, v_reason, v_gate_digest,
      v_transmission.payload_digest, v_actor, 'postgres-transition', v_now, '{}'::jsonb)
    on conflict (id) do nothing;
    return pg_catalog.jsonb_build_object('authorized', false, 'blockedReason', v_reason,
      'transmission', pg_catalog.to_jsonb(v_transmission), 'boundaryNonceDigest', null);
  end if;
  v_result := public.pursue_cim_authorize_provider_pending_p5_v1(p_command);
  if coalesce((v_result ->> 'authorized')::boolean, false) is distinct from true then
    v_reason := coalesce(v_result ->> 'blockedReason', 'lifecycle_conflict');
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, conversation_id, transmission_id, prior_state, next_state,
       reason_code, authority_digest, payload_digest, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-final-gate-block:v1'::text),
        pg_catalog.to_jsonb(v_transmission_id), pg_catalog.to_jsonb(v_transmission.row_version),
        pg_catalog.to_jsonb(v_reason), pg_catalog.to_jsonb(v_gate_digest)),
      'final-gate-blocked', v_transmission.conversation_id, v_transmission_id,
      v_transmission.state, v_transmission.state, v_reason, v_gate_digest,
      v_transmission.payload_digest, v_actor, 'postgres-transition', v_now, '{}'::jsonb)
    on conflict (id) do nothing;
  end if;
  return v_result;
end;
$$;

revoke all on function public.pursue_cim_authorize_provider_pending_p7a(jsonb)
  from public, anon, authenticated, service_role;

-- Gmail refused a provider-pending message before acceptance (quota) or nothing reached
-- Gmail (not-attempted): the touch returns to scheduled with no terminal event and no
-- campaign or conversation change (Ruling D). The transmission is retained as
-- cancelled-before-provider with the provider and code.
create or replace function public.deal_hunter_pursue_release_unsent_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_payload_digest text := public.pursue_cim_required_text_v1(p_command, 'payloadDigest', 64);
  v_expected bigint := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_code text := public.pursue_cim_required_text_v1(p_command, 'providerResultCode', 160);
  v_actor text := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_touch_ids text[] := array[]::text[];
  v_touches jsonb := '[]'::jsonb;
  v_replay boolean;
begin
  if v_payload_digest !~ '^[0-9a-f]{64}$'
    or p_command ->> 'provider' is distinct from 'gmail'
    or v_code not in ('provider_quota','gmail_token_invalid','gmail_token_refresh_failed',
      'gmail_not_connected','gmail_access_denied') then
    raise exception 'Invalid Pursue CIM provider release command';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_id for update;
  if v_transmission.id is null or v_transmission.payload_digest <> v_payload_digest then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'transmission', case when v_transmission.id is null then null
        else pg_catalog.to_jsonb(v_transmission) end, 'touches', '[]'::jsonb);
  end if;
  if v_transmission.state = 'cancelled-before-provider' then
    v_replay := coalesce(v_transmission.provider = 'gmail'
      and v_transmission.provider_result_code = v_code
      and v_transmission.provider_seam_entered_at is not null, false);
    return pg_catalog.jsonb_build_object('applied', false, 'replay', v_replay,
      'conflict', not v_replay, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'touches', '[]'::jsonb);
  end if;
  if v_transmission.state <> 'provider-pending' or v_transmission.row_version <> v_expected
    or v_transmission.invocation_authority_count <> 1
    or v_transmission.provider_seam_entered_at is null
    or v_transmission.provider is not null or v_transmission.provider_message_id is not null
    or v_transmission.provider_result_code is not null then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'transmission', pg_catalog.to_jsonb(v_transmission), 'touches', '[]'::jsonb);
  end if;
  -- Campaigns precede memberships/touches so terminal writers share this order.
  perform 1 from public.deal_hunter_cim_campaigns c
    join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
    where m.transmission_id = v_id order by c.id for update of c;
  for v_member in select t.* from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
      where m.transmission_id = v_id and m.cancelled_at is null
      order by t.id for update of m,t
  loop
    if v_member.state <> 'provider-pending' or v_member.transmission_id <> v_id then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
        'transmission', pg_catalog.to_jsonb(v_transmission), 'touches', '[]'::jsonb);
    end if;
    v_touch_ids := pg_catalog.array_append(v_touch_ids, v_member.id);
  end loop;
  if pg_catalog.cardinality(v_touch_ids) = 0 then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'transmission', pg_catalog.to_jsonb(v_transmission), 'touches', '[]'::jsonb);
  end if;
  update public.deal_hunter_cim_transmissions set state = 'cancelled-before-provider',
    provider = 'gmail', provider_result_code = v_code, row_version = row_version + 1,
    updated_at = v_now
    where id = v_id and state = 'provider-pending' and row_version = v_expected
    returning * into v_transmission;
  if not found then raise exception 'Concurrent Pursue CIM provider release'; end if;
  update public.deal_hunter_cim_transmission_touches
    set cancelled_at = v_now, cancellation_reason = 'provider-unsent-release'
    where transmission_id = v_id and cancelled_at is null;
  for v_member in select * from public.deal_hunter_cim_campaign_touches
      where id = any(v_touch_ids) order by id
  loop
    update public.deal_hunter_cim_campaign_touches set state = 'scheduled',
      transmission_id = null, claim_token_digest = null, claim_owner = null,
      claimed_at = null, claim_expires_at = null, row_version = row_version + 1,
      updated_at = v_now
      where id = v_member.id and state = 'provider-pending' and transmission_id = v_id
        and row_version = v_member.row_version;
    if not found then raise exception 'Concurrent Pursue CIM touch release'; end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, touch_id, transmission_id,
       prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('touch-released'::text),
        pg_catalog.to_jsonb(v_member.id || ':' || (v_member.row_version + 1)::text)),
      'touch-released', v_member.opportunity_id, v_member.campaign_id, v_member.id, v_id,
      'provider-pending', 'scheduled', v_code, v_actor, 'postgres-transition', v_now,
      '{}'::jsonb);
  end loop;
  update public.crm_communications set provider = 'gmail', delivery_state = 'not-attempted',
    delivery_state_at = v_now, updated_at = v_now
    where id = v_transmission.communication_id;
  update public.crm_email_outbox set provider = 'gmail', state = 'cancelled',
    last_error_category = v_code, updated_at = v_now
    where id = v_transmission.outbox_id;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, conversation_id, transmission_id, prior_state, next_state,
     reason_code, payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-released'::text), pg_catalog.to_jsonb(v_id)),
    'transmission-released', v_transmission.conversation_id, v_id, 'provider-pending',
    'cancelled-before-provider', v_code, v_payload_digest, v_actor, 'postgres-transition',
    v_now, '{}'::jsonb);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.id), '[]'::jsonb)
    into v_touches from public.deal_hunter_cim_campaign_touches t where t.id = any(v_touch_ids);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false, 'conflict', false,
    'transmission', pg_catalog.to_jsonb(v_transmission), 'touches', v_touches);
end;
$$;
revoke all on function public.deal_hunter_pursue_release_unsent_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_pursue_release_unsent_v1(jsonb) to service_role;

-- A touch released by deal_hunter_pursue_release_unsent_v1 can be claimed again. This
-- redefines the claim body from 20261001120000 with only the retained-membership check changed.
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
  -- A membership released because Gmail never accepted the message does not block a new
  -- claim; any other retained membership does.
  if exists (select 1 from public.deal_hunter_cim_transmission_touches
      where touch_id = v_touch_id and (cancelled_at is null
        or cancellation_reason is distinct from 'provider-unsent-release')) then
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
revoke all on function public.pursue_cim_claim_due_touch_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_claim_due_touch_v1(jsonb) to service_role;

-- Due initial touches carry the next preparation generation, so a released touch is prepared
-- again as a new transmission. This redefines the body from 20261007120000 with one column added.
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
        v.recipient_address,
        (select coalesce(max(tr.preparation_generation), 0) + 1
          from public.deal_hunter_cim_transmission_touches as m
          join public.deal_hunter_cim_transmissions as tr on tr.id = m.transmission_id
          where m.touch_id = t.id) as preparation_generation
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

-- Due follow-up touches (spec 2026-11-03 §5.2): scheduled, non-initial touches that are due,
-- of open conversations whose campaign is in active-follow-up and not past its expiry, while
-- the fl04c-followup chain is current and active. Claimed touches are never listed. Each row
-- carries the touch's next preparation generation, so a touch Gmail never accepted is
-- prepared again as a new transmission. Mirrors listDueCimFollowUpTouches in SQLite.
create or replace function public.pursue_cim_list_due_followup_touches_v1(
  p_now timestamptz, p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_activation_id text;
begin
  if p_now is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid Pursue CIM due selection';
  end if;
  select a.id into v_activation_id from public.deal_hunter_cim_capability_activations a
    where a.id = public.pursue_cim_current_activation_v1('fl04c-followup', p_now)
      and a.mode = 'active';
  if v_activation_id is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(due) order by due.due_at, due.touch_id)
    from (
      select t.id as touch_id, t.campaign_id, t.opportunity_id, t.kind, t.ordinal,
        t.state, t.due_at, t.due_local as "dueLocal", t.row_version, t.claim_expires_at,
        c.conversation_id, c.terminal_revision as campaign_terminal_revision,
        v.terminal_revision as conversation_terminal_revision,
        c.crm_submission_id, c.recipient_fingerprint,
        c.recipient_fingerprint as campaign_recipient_fingerprint,
        v.recipient_fingerprint as conversation_recipient_fingerprint,
        v.recipient_address, c.local_expiry_at as "campaignExpiryAt",
        v_activation_id as activation_id,
        (select coalesce(max(tr.preparation_generation), 0) + 1
          from public.deal_hunter_cim_transmission_touches as m
          join public.deal_hunter_cim_transmissions as tr on tr.id = m.transmission_id
          where m.touch_id = t.id) as preparation_generation
      from public.deal_hunter_cim_campaign_touches as t
      join public.deal_hunter_cim_campaigns as c on c.id = t.campaign_id
      join public.deal_hunter_broker_conversations as v on v.id = c.conversation_id
      where t.kind <> 'initial' and t.logical_slot <> 'initial' and t.ordinal >= 1
        and c.policy_version = 'deal-hunter-cim-autopilot-v1'
        and c.state = 'active-follow-up' and v.state = 'open'
        and t.opportunity_id = c.opportunity_id
        and t.state = 'scheduled' and t.transmission_id is null
        and t.due_at <= p_now
        and c.local_expiry_at is not null and c.local_expiry_at > p_now
        and t.timezone_revision = c.timezone_revision
      order by t.due_at, t.id
      limit p_limit
    ) as due
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pursue_cim_list_due_followup_touches_v1(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_list_due_followup_touches_v1(timestamptz, integer)
  to service_role;

-- The durable authority a follow-up is prepared under: touch, campaign, conversation,
-- opportunity, CRM owner, timezone, the current fl04c-followup activation, the campaign's
-- accepted initial transmission (what the follow-up replies to) and the stop signals held in
-- durable records. Null when the touch does not exist. Mirrors readCimFollowUpAuthority.
create or replace function public.pursue_cim_read_followup_authority_v1(p_command jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_activation_id text;
  v_address text;
begin
  select * into v_touch from public.deal_hunter_cim_campaign_touches
    where id = public.pursue_cim_required_text_v1(p_command, 'touchId', 240);
  if not found then
    return null;
  end if;
  select * into v_campaign from public.deal_hunter_cim_campaigns where id = v_touch.campaign_id;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_campaign.conversation_id;
  v_activation_id := public.pursue_cim_current_activation_v1('fl04c-followup', v_now);
  v_address := coalesce(v_conversation.recipient_address, '');
  return pg_catalog.jsonb_build_object(
    'touch', pg_catalog.to_jsonb(v_touch),
    'campaign', case when v_campaign.id is null then null else pg_catalog.to_jsonb(v_campaign) end,
    'conversation', case when v_conversation.id is null then null
      else pg_catalog.to_jsonb(v_conversation) end,
    'opportunity', (select pg_catalog.to_jsonb(o) from public.deal_hunter_opportunities o
      where o.opportunity_id = v_touch.opportunity_id),
    'crmOwnership', (select pg_catalog.jsonb_build_object('revision', r.revision,
        'submission_id', r.submission_id)
      from public.deal_hunter_crm_ownership_revisions r
      where r.opportunity_id = v_touch.opportunity_id order by r.revision desc limit 1),
    'crmSubmission', (select pg_catalog.jsonb_build_object('id', s.id,
        'deal_hunter_opportunity_id', s.deal_hunter_opportunity_id, 'archived_at', s.archived_at)
      from public.contact_submissions s where s.id = v_campaign.crm_submission_id),
    'timezone', (select pg_catalog.to_jsonb(z) from public.deal_hunter_opportunity_timezone_revisions z
      where z.opportunity_id = v_touch.opportunity_id and z.revision = v_campaign.timezone_revision),
    'activation', (select pg_catalog.to_jsonb(a) from public.deal_hunter_cim_capability_activations a
      where a.id = v_activation_id),
    'initial', (select pg_catalog.jsonb_build_object('transmissionId', tr.id,
        'fromAddress', tr.from_address, 'subject', comm.subject)
      from public.deal_hunter_cim_campaign_touches it
      join public.deal_hunter_cim_transmission_touches m
        on m.touch_id = it.id and m.cancelled_at is null
      join public.deal_hunter_cim_transmissions tr
        on tr.id = m.transmission_id and tr.state = 'accepted'
      join public.crm_communications comm on comm.id = tr.communication_id
      where it.campaign_id = v_campaign.id and it.kind = 'initial'
      order by tr.preparation_generation desc, tr.id limit 1),
    'signals', pg_catalog.jsonb_build_object(
      'replyReceived', exists(select 1 from public.crm_communications
        where direction = 'inbound' and (thread_key = v_conversation.rfc_thread_key
          or submission_id = v_campaign.crm_submission_id)),
      'suppressed', exists(select 1 from public.email_suppressions
          where normalized_email = pg_catalog.lower(v_address) and lifted_at is null)
        or exists(select 1 from public.email_events
          where pg_catalog.lower(recipient_email) = pg_catalog.lower(v_address)
            and event_type in ('unsubscribe','unsubscribed','opt_out')),
      'unsafeDelivery', exists(select 1 from public.email_events
        where pg_catalog.lower(recipient_email) = pg_catalog.lower(v_address)
          and event_type in ('complained','complaint','bounced','hard_bounce')),
      'providerPending', exists(select 1 from public.deal_hunter_cim_transmissions
        where conversation_id = v_conversation.id and state = 'provider-pending'),
      'providerAmbiguous', coalesce(v_campaign.state = 'provider-ambiguous', false)
        or coalesce(v_conversation.state = 'provider-ambiguous', false)
        or exists(select 1 from public.deal_hunter_cim_transmissions
          where conversation_id = v_conversation.id and state = 'ambiguous')));
end;
$$;

revoke all on function public.pursue_cim_read_followup_authority_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_read_followup_authority_v1(jsonb) to service_role;

-- A follow-up released after Gmail refused it before acceptance is prepared again under the
-- touch's next preparation generation, and its released transmission's consumed reservation
-- no longer holds a daily or per-recipient slot (the transmission never reached the
-- provider). These redefine the bodies from 20261015120000 with only those changes.
create or replace function public.pursue_cim_prepare_reserved_followup_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_reservation public.deal_hunter_cim_capacity_reservations%rowtype;
  v_current public.deal_hunter_cim_transmissions%rowtype;
  v_prepared jsonb;
  v_touch_id text;
  v_activation_id text;
  v_claim_digest text;
  v_claim_owner text;
  v_fingerprint text;
  v_address_digest text;
  v_capacity_date date := (v_now at time zone 'America/Los_Angeles')::date;
  v_next_midnight timestamptz;
  v_expires_at timestamptz;
  v_recipient_expires timestamptz := v_now + interval '24 hours';
  v_count bigint;
  v_id text;
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  if pg_catalog.jsonb_typeof(p_command->'touchIds') <> 'array'
    or pg_catalog.jsonb_array_length(p_command->'touchIds') <> 1 then
    raise exception 'Invalid follow-up reservation membership';
  end if;
  v_touch_id := public.pursue_cim_required_text_v1(
    pg_catalog.jsonb_build_object('value',p_command->'touchIds'->>0),'value',240);
  v_activation_id := public.pursue_cim_required_text_v1(p_command,'activationId',240);
  v_claim_digest := public.pursue_cim_required_text_v1(p_command,'claimTokenDigest',64);
  v_claim_owner := public.pursue_cim_required_text_v1(p_command,'claimOwner',200);
  v_fingerprint := public.pursue_cim_required_text_v1(p_command,'recipientFingerprint',64);
  if v_claim_digest !~ '^[0-9a-f]{64}$' or v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid follow-up reservation digest';
  end if;
  update public.deal_hunter_cim_capacity_reservations set state='expired',
    expired_at=v_now, row_version=row_version+1 where state='reserved' and expires_at <= v_now;
  select * into v_touch from public.deal_hunter_cim_campaign_touches
    where id=v_touch_id for update;
  if not found then return pg_catalog.jsonb_build_object('prepared',false,'existing',false,
    'capacityDeferred',false,'payloadConflict',false,'terminal',true,
    'blockedReason','terminal_authority_changed','transmission',null,'reservation',null); end if;
  select * into v_campaign from public.deal_hunter_cim_campaigns
    where id=v_touch.campaign_id for update;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id=v_campaign.conversation_id for update;
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where id=public.pursue_cim_current_activation_v1('fl04c-followup',v_now) for update;
  if v_activation.id is distinct from v_activation_id or v_activation.mode <> 'active'
    or v_touch.kind='initial' or v_campaign.state <> 'active-follow-up'
    or v_touch.opportunity_id <> v_campaign.opportunity_id
    or v_conversation.state <> 'open'
    or v_campaign.recipient_fingerprint <> v_fingerprint
    or v_conversation.recipient_fingerprint <> v_fingerprint
    or v_conversation.recipient_address <> p_command->'toAddresses'->>0
    or v_campaign.terminal_revision <> (p_command->>'expectedCampaignTerminalRevision')::bigint
    or v_conversation.terminal_revision <> (p_command->>'expectedConversationTerminalRevision')::bigint
    or v_touch.state <> 'claimed' or v_touch.claim_token_digest <> v_claim_digest
    or v_touch.claim_owner <> v_claim_owner or v_touch.claim_expires_at is null
    or v_touch.claim_expires_at <= v_now
    or (v_campaign.local_expiry_at is not null and v_campaign.local_expiry_at <= v_now)
  then return pg_catalog.jsonb_build_object('prepared',false,'existing',false,
    'capacityDeferred',false,'payloadConflict',false,'terminal',true,
    'blockedReason','recipient_authority_changed','transmission',null,'reservation',null); end if;
  if v_touch.claim_expires_at > v_now+interval '5 minutes' then
    return pg_catalog.jsonb_build_object('prepared',false,'existing',false,
      'capacityDeferred',false,'payloadConflict',false,'terminal',true,
      'blockedReason','claim_expiry_invalid','transmission',null,'reservation',null);
  end if;
  if exists(select 1 from public.email_suppressions where normalized_email=pg_catalog.lower(v_conversation.recipient_address)
      and lifted_at is null)
    or exists(select 1 from public.email_events
      where pg_catalog.lower(recipient_email)=pg_catalog.lower(v_conversation.recipient_address)
        and event_type in ('complained','complaint','bounced','hard_bounce',
          'unsubscribe','unsubscribed','opt_out'))
  then return pg_catalog.jsonb_build_object('prepared',false,'existing',false,
    'capacityDeferred',false,'payloadConflict',false,'terminal',true,
    'blockedReason','recipient_suppressed','transmission',null,'reservation',null); end if;
  if exists(select 1 from public.crm_communications where direction='inbound'
      and (thread_key=v_conversation.rfc_thread_key or submission_id=v_campaign.crm_submission_id))
  then return pg_catalog.jsonb_build_object('prepared',false,'existing',false,
    'capacityDeferred',false,'payloadConflict',false,'terminal',true,
    'blockedReason','reply_received','transmission',null,'reservation',null); end if;
  select * into v_reservation from public.deal_hunter_cim_capacity_reservations
    where touch_id=v_touch.id and state='reserved';
  if found then
    select * into v_current from public.deal_hunter_cim_transmissions
      where id=v_reservation.transmission_id for update;
    if public.pursue_cim_required_revision_v1(p_command,'preparationGeneration')
      <> v_current.preparation_generation then
      return pg_catalog.jsonb_build_object('prepared',false,'existing',false,
        'capacityDeferred',false,'payloadConflict',true,'terminal',false,
        'blockedReason','payload_conflict','transmission',pg_catalog.to_jsonb(v_current),
        'reservation',pg_catalog.to_jsonb(v_reservation));
    end if;
    v_prepared := public.pursue_cim_prepare_transmission_v1(
      p_command || pg_catalog.jsonb_build_object('now',pg_catalog.to_char(
        v_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'preparationGeneration',public.pursue_cim_required_revision_v1(
          p_command,'preparationGeneration')));
    return v_prepared || pg_catalog.jsonb_build_object('capacityDeferred',false,
      'blockedReason',case when coalesce((v_prepared->>'existing')::boolean,false)
        then null else 'payload_conflict' end,
      'reservation',pg_catalog.to_jsonb(v_reservation));
  end if;
  select tr.* into v_current from public.deal_hunter_cim_transmission_touches m
    join public.deal_hunter_cim_transmissions tr on tr.id=m.transmission_id
    where m.touch_id=v_touch.id and m.cancelled_at is null for update of tr;
  if found then return pg_catalog.jsonb_build_object('prepared',false,'existing',false,
    'capacityDeferred',false,'payloadConflict',false,'terminal',true,
    'blockedReason','reservation_renewal_required','transmission',pg_catalog.to_jsonb(v_current),
    'reservation',null); end if;
  if public.pursue_cim_required_revision_v1(p_command,'preparationGeneration') <> (
      select coalesce(max(tr.preparation_generation),0)+1
      from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_transmissions tr on tr.id=m.transmission_id
      where m.touch_id=v_touch.id) then
    return pg_catalog.jsonb_build_object('prepared',false,'existing',false,
      'capacityDeferred',false,'payloadConflict',true,'terminal',false,
      'blockedReason','preparation_generation_invalid','transmission',null,'reservation',null);
  end if;
  v_address_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.lower(pg_catalog.btrim(v_conversation.recipient_address)),'UTF8')),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'cim-capacity-daily:'||v_capacity_date::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'cim-capacity-recipient:'||v_address_digest,0));
  select count(*) into v_count from public.deal_hunter_cim_capacity_reservations
    where capacity_date=v_capacity_date and (state='consumed' or (state='reserved' and expires_at>v_now))
      and not exists(select 1 from public.deal_hunter_cim_transmissions held
        where held.id=deal_hunter_cim_capacity_reservations.transmission_id
          and held.state='cancelled-before-provider');
  if v_activation.daily_cap is null or v_activation.daily_cap < 1 or v_count >= v_activation.daily_cap then
    return pg_catalog.jsonb_build_object('prepared',false,'existing',false,'capacityDeferred',true,
      'payloadConflict',false,'terminal',false,'blockedReason','daily_capacity','transmission',null,'reservation',null);
  end if;
  select count(*) into v_count from public.deal_hunter_cim_capacity_reservations
    where recipient_address_digest=v_address_digest and recipient_window_expires_at>v_now
      and state in ('reserved','consumed')
      and not exists(select 1 from public.deal_hunter_cim_transmissions held
        where held.id=deal_hunter_cim_capacity_reservations.transmission_id
          and held.state='cancelled-before-provider');
  if v_activation.recipient_cap is null or v_activation.recipient_cap < 1
    or v_count >= v_activation.recipient_cap then
    return pg_catalog.jsonb_build_object('prepared',false,'existing',false,'capacityDeferred',true,
      'payloadConflict',false,'terminal',false,'blockedReason','recipient_capacity','transmission',null,'reservation',null);
  end if;
  if exists(select 1 from public.deal_hunter_cim_capacity_reservations
      where campaign_id=v_campaign.id and state='reserved') then
    return pg_catalog.jsonb_build_object('prepared',false,'existing',false,'capacityDeferred',true,
      'payloadConflict',false,'terminal',false,'blockedReason','campaign_capacity','transmission',null,'reservation',null);
  end if;
  v_prepared := public.pursue_cim_prepare_transmission_v1(
    p_command || pg_catalog.jsonb_build_object('now',pg_catalog.to_char(
      v_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  if coalesce((v_prepared->>'prepared')::boolean,false) is not true then
    return v_prepared || pg_catalog.jsonb_build_object('capacityDeferred',false,
      'blockedReason',case when coalesce((v_prepared->>'terminal')::boolean,false)
        then 'terminal_authority_changed' else null end,'reservation',null);
  end if;
  v_next_midnight := ((v_capacity_date+1)::timestamp at time zone 'America/Los_Angeles');
  v_expires_at := least(v_touch.claim_expires_at,v_next_midnight);
  v_id := public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-follow-up-capacity:v1'::text),
    v_prepared->'transmission'->'id',pg_catalog.to_jsonb(v_claim_digest),
    pg_catalog.to_jsonb(v_capacity_date::text));
  insert into public.deal_hunter_cim_capacity_reservations(id,activation_id,transmission_id,
    touch_id,campaign_id,conversation_id,recipient_fingerprint,recipient_address_digest,
    capacity_date,claim_token_digest,state,reserved_at,expires_at,recipient_window_expires_at)
  values(v_id,v_activation.id,v_prepared->'transmission'->>'id',v_touch.id,v_campaign.id,
    v_conversation.id,v_fingerprint,v_address_digest,v_capacity_date,v_claim_digest,
    'reserved',v_now,v_expires_at,v_recipient_expires) returning * into v_reservation;
  return v_prepared || pg_catalog.jsonb_build_object('capacityDeferred',false,
    'blockedReason',null,'reservation',pg_catalog.to_jsonb(v_reservation));
end;
$$;

create or replace function public.pursue_cim_renew_reserved_followup_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_prior public.deal_hunter_cim_capacity_reservations%rowtype;
  v_reservation public.deal_hunter_cim_capacity_reservations%rowtype;
  v_capacity_date date := (v_now at time zone 'America/Los_Angeles')::date;
  v_claim_digest text := public.pursue_cim_required_text_v1(p_command,'claimTokenDigest',64);
  v_fingerprint text := public.pursue_cim_required_text_v1(p_command,'recipientFingerprint',64);
  v_claim_expires timestamptz := public.pursue_cim_required_instant_v1(p_command,'claimExpiresAt');
  v_claim_owner text := public.pursue_cim_required_text_v1(p_command,'claimOwner',200);
  v_address_digest text; v_id text; v_count bigint; v_changed bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  if v_claim_digest !~ '^[0-9a-f]{64}$' or v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid follow-up renewal digest';
  end if;
  update public.deal_hunter_cim_capacity_reservations set state='expired',expired_at=v_now,
    row_version=row_version+1 where state='reserved' and expires_at<=v_now;
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id=p_command->>'transmissionId' for update;
  select * into v_touch from public.deal_hunter_cim_campaign_touches
    where id=p_command->>'touchId' for update;
  select * into v_campaign from public.deal_hunter_cim_campaigns where id=v_touch.campaign_id for update;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id=v_campaign.conversation_id for update;
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where id=public.pursue_cim_current_activation_v1('fl04c-followup',v_now) for update;
  v_address_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.lower(pg_catalog.btrim(v_conversation.recipient_address)),'UTF8')),'hex');
  v_id := public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-follow-up-capacity:v1'::text),
    pg_catalog.to_jsonb(v_transmission.id),pg_catalog.to_jsonb(v_claim_digest),
    pg_catalog.to_jsonb(v_capacity_date::text));
  select * into v_reservation from public.deal_hunter_cim_capacity_reservations where id=v_id;
  if found then
    if v_transmission.id is null or v_transmission.state <> 'prepared'
      or v_transmission.invocation_authority_count <> 0 or v_touch.id is null
      or v_touch.transmission_id <> v_transmission.id or v_touch.state <> 'claimed'
      or v_touch.opportunity_id <> v_campaign.opportunity_id
      or v_touch.claim_token_digest <> v_claim_digest or v_touch.claim_owner <> v_claim_owner
      or v_touch.claim_expires_at <> v_claim_expires or v_touch.claim_expires_at <= v_now
      or v_campaign.state <> 'active-follow-up' or v_campaign.local_expiry_at <= v_now
      or v_conversation.state <> 'open' or v_activation.id is distinct from p_command->>'activationId'
      or v_campaign.recipient_fingerprint <> v_fingerprint
      or v_conversation.recipient_fingerprint <> v_fingerprint
      or v_reservation.state <> 'reserved' or v_reservation.expires_at <= v_now
      or v_reservation.activation_id <> v_activation.id
      or v_reservation.transmission_id <> v_transmission.id
      or v_reservation.touch_id <> v_touch.id or v_reservation.campaign_id <> v_campaign.id
      or v_reservation.conversation_id <> v_conversation.id
      or v_reservation.recipient_fingerprint <> v_fingerprint
      or v_reservation.recipient_address_digest <> v_address_digest
      or v_reservation.claim_token_digest <> v_claim_digest
    then return pg_catalog.jsonb_build_object('renewed',false,'existing',false,
      'capacityDeferred',false,'terminal',true,'blockedReason','renewal_authority_changed',
      'transmission',pg_catalog.to_jsonb(v_transmission),
      'reservation',pg_catalog.to_jsonb(v_reservation)); end if;
    return pg_catalog.jsonb_build_object('renewed',false,'existing',true,
      'capacityDeferred',false,'terminal',false,'blockedReason',null,
      'transmission',pg_catalog.to_jsonb(v_transmission),
      'reservation',pg_catalog.to_jsonb(v_reservation));
  end if;
  select * into v_prior from public.deal_hunter_cim_capacity_reservations
    where transmission_id=v_transmission.id order by reserved_at desc,id desc limit 1;
  if v_transmission.id is null or v_transmission.state <> 'prepared'
    or v_transmission.invocation_authority_count <> 0 or v_touch.id is null
    or v_touch.transmission_id <> v_transmission.id or v_touch.row_version <> (p_command->>'expectedRowVersion')::bigint
    or v_touch.opportunity_id <> v_campaign.opportunity_id
    or v_touch.state <> 'claimed' or v_touch.claim_expires_at > v_now
    or v_prior.id is null or v_prior.state <> 'expired'
    or v_activation.id is distinct from p_command->>'activationId'
    or v_campaign.state <> 'active-follow-up' or v_conversation.state <> 'open'
    or v_campaign.local_expiry_at <= v_now
    or v_campaign.recipient_fingerprint <> v_fingerprint
    or v_conversation.recipient_fingerprint <> v_fingerprint
    or v_prior.activation_id <> v_activation.id or v_prior.touch_id <> v_touch.id
    or v_prior.campaign_id <> v_campaign.id or v_prior.conversation_id <> v_conversation.id
    or v_prior.recipient_fingerprint <> v_fingerprint
    or v_prior.recipient_address_digest <> v_address_digest
    or v_claim_expires <= v_now or v_claim_expires > v_now+interval '5 minutes'
  then return pg_catalog.jsonb_build_object('renewed',false,'existing',false,'capacityDeferred',false,
    'terminal',true,'blockedReason','renewal_authority_changed',
    'transmission',pg_catalog.to_jsonb(v_transmission),'reservation',null); end if;
  if v_activation.daily_cap is null or v_activation.daily_cap < 1
    or v_activation.recipient_cap is null or v_activation.recipient_cap < 1
  then return pg_catalog.jsonb_build_object('renewed',false,'existing',false,
    'capacityDeferred',false,'terminal',true,'blockedReason','renewal_authority_changed',
    'transmission',pg_catalog.to_jsonb(v_transmission),'reservation',null); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cim-capacity-daily:'||v_capacity_date::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cim-capacity-recipient:'||v_address_digest,0));
  select count(*) into v_count from public.deal_hunter_cim_capacity_reservations
    where capacity_date=v_capacity_date and (state='consumed' or (state='reserved' and expires_at>v_now))
      and not exists(select 1 from public.deal_hunter_cim_transmissions held
        where held.id=deal_hunter_cim_capacity_reservations.transmission_id
          and held.state='cancelled-before-provider');
  if v_count >= v_activation.daily_cap then return pg_catalog.jsonb_build_object('renewed',false,
    'existing',false,'capacityDeferred',true,'terminal',false,'blockedReason','daily_capacity',
    'transmission',pg_catalog.to_jsonb(v_transmission),'reservation',null); end if;
  select count(*) into v_count from public.deal_hunter_cim_capacity_reservations
    where recipient_address_digest=v_address_digest and recipient_window_expires_at>v_now
      and state in ('reserved','consumed')
      and not exists(select 1 from public.deal_hunter_cim_transmissions held
        where held.id=deal_hunter_cim_capacity_reservations.transmission_id
          and held.state='cancelled-before-provider');
  if v_count >= v_activation.recipient_cap then return pg_catalog.jsonb_build_object('renewed',false,
    'existing',false,'capacityDeferred',true,'terminal',false,'blockedReason','recipient_capacity',
    'transmission',pg_catalog.to_jsonb(v_transmission),'reservation',null); end if;
  if exists(select 1 from public.deal_hunter_cim_capacity_reservations
      where campaign_id=v_campaign.id and state='reserved') then
    return pg_catalog.jsonb_build_object('renewed',false,'existing',false,
      'capacityDeferred',true,'terminal',false,'blockedReason','campaign_capacity',
      'transmission',pg_catalog.to_jsonb(v_transmission),'reservation',null);
  end if;
  update public.deal_hunter_cim_campaign_touches set claim_token_digest=v_claim_digest,
    claim_owner=v_claim_owner,claimed_at=v_now, claim_expires_at=v_claim_expires,
    row_version=row_version+1,updated_at=v_now where id=v_touch.id
      and row_version=(p_command->>'expectedRowVersion')::bigint
      and transmission_id=v_transmission.id and state='claimed';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then raise exception 'Follow-up renewal lost touch authority'; end if;
  insert into public.deal_hunter_cim_capacity_reservations(id,activation_id,transmission_id,touch_id,
    campaign_id,conversation_id,recipient_fingerprint,recipient_address_digest,capacity_date,
    claim_token_digest,state,reserved_at,expires_at,recipient_window_expires_at)
  values(v_id,v_activation.id,v_transmission.id,v_touch.id,v_campaign.id,v_conversation.id,
    v_fingerprint,v_address_digest,v_capacity_date,v_claim_digest,'reserved',v_now,
    least(v_claim_expires,((v_capacity_date+1)::timestamp at time zone 'America/Los_Angeles')),
    v_now+interval '24 hours') returning * into v_reservation;
  return pg_catalog.jsonb_build_object('renewed',true,'existing',false,'capacityDeferred',false,
    'terminal',false,'blockedReason',null,'transmission',pg_catalog.to_jsonb(v_transmission),
    'reservation',pg_catalog.to_jsonb(v_reservation));
end;
$$;

revoke all on function public.pursue_cim_prepare_reserved_followup_v1(jsonb) from public,anon,authenticated;
revoke all on function public.pursue_cim_renew_reserved_followup_v1(jsonb) from public,anon,authenticated;
grant execute on function public.pursue_cim_prepare_reserved_followup_v1(jsonb) to service_role;
grant execute on function public.pursue_cim_renew_reserved_followup_v1(jsonb) to service_role;

-- Task 8: the scheduled Pursue sender (spec 2026-11-03 §5, Ruling L).
--
-- A follow-up touch whose claimer died before preparing it (claimed, claim lapsed, no
-- transmission) is listed again, so claimDueCimTouch can take it over. A lapsed claim that holds
-- a prepared transmission is renewed instead (pursue_cim_renew_reserved_followup_v1). This
-- redefines the body above with only the claim clause and its comment changed.
create or replace function public.pursue_cim_list_due_followup_touches_v1(
  p_now timestamptz, p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_activation_id text;
begin
  if p_now is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid Pursue CIM due selection';
  end if;
  select a.id into v_activation_id from public.deal_hunter_cim_capability_activations a
    where a.id = public.pursue_cim_current_activation_v1('fl04c-followup', p_now)
      and a.mode = 'active';
  if v_activation_id is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(due) order by due.due_at, due.touch_id)
    from (
      select t.id as touch_id, t.campaign_id, t.opportunity_id, t.kind, t.ordinal,
        t.state, t.due_at, t.due_local as "dueLocal", t.row_version, t.claim_expires_at,
        c.conversation_id, c.terminal_revision as campaign_terminal_revision,
        v.terminal_revision as conversation_terminal_revision,
        c.crm_submission_id, c.recipient_fingerprint,
        c.recipient_fingerprint as campaign_recipient_fingerprint,
        v.recipient_fingerprint as conversation_recipient_fingerprint,
        v.recipient_address, c.local_expiry_at as "campaignExpiryAt",
        v_activation_id as activation_id,
        (select coalesce(max(tr.preparation_generation), 0) + 1
          from public.deal_hunter_cim_transmission_touches as m
          join public.deal_hunter_cim_transmissions as tr on tr.id = m.transmission_id
          where m.touch_id = t.id) as preparation_generation
      from public.deal_hunter_cim_campaign_touches as t
      join public.deal_hunter_cim_campaigns as c on c.id = t.campaign_id
      join public.deal_hunter_broker_conversations as v on v.id = c.conversation_id
      where t.kind <> 'initial' and t.logical_slot <> 'initial' and t.ordinal >= 1
        and c.policy_version = 'deal-hunter-cim-autopilot-v1'
        and c.state = 'active-follow-up' and v.state = 'open'
        and t.opportunity_id = c.opportunity_id
        and t.transmission_id is null
        and (t.state = 'scheduled' or (t.state = 'claimed'
          and t.claim_expires_at is not null and t.claim_expires_at <= p_now))
        and t.due_at <= p_now
        and c.local_expiry_at is not null and c.local_expiry_at > p_now
        and t.timezone_revision = c.timezone_revision
      order by t.due_at, t.id
      limit p_limit
    ) as due
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pursue_cim_list_due_followup_touches_v1(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_list_due_followup_touches_v1(timestamptz, integer)
  to service_role;

-- An expired live authorization that was never used can no longer authorize anything, so it
-- no longer blocks a new one for the same transmission: once the new issue is otherwise valid,
-- the expired one is retired (withdrawn_at, audit authorization-expired). A transmission whose
-- gate refused it (central pause, outside the window) can then be authorized again after its
-- claim is renewed. Redefines the body from 20260925120000 with only that change.
create or replace function public.pursue_cim_issue_live_authorization_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_activation_id text;
  v_capability text;
  v_writer_path text;
  v_transmission_id text;
  v_payload_digest text;
  v_recipient_digest text;
  v_provider_profile text;
  v_actor text;
  v_reason text;
  v_now timestamptz;
  v_expires timestamptz;
  v_existing public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_current public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_count integer := 0;
  v_replay boolean;
  v_retire boolean := false;
begin
  v_id := public.pursue_cim_required_text_v1(p_command, 'id', 240);
  v_activation_id := public.pursue_cim_required_text_v1(p_command, 'activationId', 240);
  v_capability := public.pursue_cim_required_text_v1(p_command, 'capability', 40);
  v_writer_path := public.pursue_cim_required_text_v1(p_command, 'writerPath', 240);
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_payload_digest := public.pursue_cim_required_text_v1(p_command, 'payloadDigest', 64);
  v_recipient_digest := public.pursue_cim_required_text_v1(
    p_command, 'recipientAuthorityDigest', 64);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_reason := public.pursue_cim_required_text_v1(p_command, 'reason', 1000);
  if v_payload_digest !~ '^[0-9a-f]{64}$'
    or v_recipient_digest !~ '^[0-9a-f]{64}$'
    or p_command ->> 'now' is null or p_command ->> 'expiresAt' is null
  then
    raise exception 'Invalid Pursue CIM live authorization command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_expires := public.pursue_cim_required_instant_v1(p_command, 'expiresAt');
  if v_expires <= v_now then
    raise exception 'Pursue CIM authorization already expired';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:authorization-id:' || v_id, 0));
  select * into v_existing from public.deal_hunter_cim_live_provider_authorizations
    where id = v_id for update;
  if found then
    v_replay := v_existing.activation_id = v_activation_id
      and v_existing.capability = v_capability
      and v_existing.writer_path = v_writer_path
      and v_existing.transmission_id = v_transmission_id
      and v_existing.payload_digest = v_payload_digest
      and v_existing.recipient_authority_digest = v_recipient_digest
      and v_existing.provider_profile = v_provider_profile
      and v_existing.expires_at = v_expires;
    return pg_catalog.jsonb_build_object('issued', false, 'replay', v_replay,
      'conflict', not v_replay, 'blockedReason', null,
      'authorization', pg_catalog.to_jsonb(v_existing));
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pursue-cim:authorization-current:' || v_transmission_id || ':' || v_writer_path, 0));
  select * into v_current from public.deal_hunter_cim_live_provider_authorizations
    where transmission_id = v_transmission_id and writer_path = v_writer_path
      and consumed_at is null and withdrawn_at is null for update;
  if found then
    if v_current.expires_at > v_now then
      return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
        'conflict', false, 'blockedReason', 'authorization_exists',
        'authorization', pg_catalog.to_jsonb(v_current));
    end if;
    v_retire := true;
  end if;
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where id = v_activation_id for share;
  if public.pursue_cim_current_activation_v1(v_capability, v_now) is distinct from v_activation_id
    or v_activation.provider_profile is distinct from v_provider_profile
  then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'capability_inactive', 'authorization', null);
  end if;
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_transmission_id for update;
  if not found or v_transmission.state <> 'prepared'
    or v_transmission.payload_digest <> v_payload_digest
  then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'transmission_invalid', 'authorization', null);
  end if;
  for v_member in
    select c.recipient_fingerprint, t.kind
    from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
    join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
    where m.transmission_id = v_transmission_id and m.cancelled_at is null
    order by m.touch_id for share of m,c,t
  loop
    v_count := v_count + 1;
    if v_member.recipient_fingerprint <> v_recipient_digest
      or (v_member.kind = 'initial' and v_capability <> 'fl04b-initial')
      or (v_member.kind <> 'initial' and v_capability = 'fl04b-initial')
    then
      return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
        'conflict', false, 'blockedReason', 'recipient_authority_changed',
        'authorization', null);
    end if;
  end loop;
  if v_count = 0 then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'recipient_authority_changed',
      'authorization', null);
  end if;
  if v_retire then
    update public.deal_hunter_cim_live_provider_authorizations set withdrawn_at = v_now
      where id = v_current.id and consumed_at is null and withdrawn_at is null;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, transmission_id, activation_id, authorization_id,
       prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('authorization-expired'::text),
        pg_catalog.to_jsonb(v_current.id)),
      'authorization-expired', v_transmission_id, v_current.activation_id, v_current.id,
      'issued', 'withdrawn', 'authorization_expired', v_actor, 'sqlite-transition', v_now,
      '{}'::jsonb);
  end if;
  insert into public.deal_hunter_cim_live_provider_authorizations
    (id, activation_id, capability, writer_path, transmission_id,
     payload_digest, recipient_authority_digest, provider_profile,
     maximum_calls, issued_at, expires_at, actor, reason)
  values (v_id, v_activation_id, v_capability, v_writer_path, v_transmission_id,
    v_payload_digest, v_recipient_digest, v_provider_profile, 1,
    v_now, v_expires, v_actor, v_reason)
  returning * into v_existing;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, activation_id, authorization_id,
     next_state, payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('live-authorization-issued'::text),
      pg_catalog.to_jsonb(v_id)),
    'live-authorization-issued', v_transmission_id, v_activation_id,
    v_id, 'issued', v_payload_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('issued', true, 'replay', false,
    'conflict', false, 'blockedReason', null, 'authorization', pg_catalog.to_jsonb(v_existing));
end;
$$;

revoke all on function public.pursue_cim_issue_live_authorization_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_issue_live_authorization_v1(jsonb)
  to service_role;

-- Renews the lapsed claim of an initial touch that holds a prepared, never-authorized
-- transmission, keeping that transmission (Ruling L). The new claim is at most five minutes
-- long; replaying the same renewal returns existing. Mirrors renewLapsedCimInitialClaim in
-- SQLite. Named outside the pursue_cim_%_v1 inventory, like the Gmail release helper.
create or replace function public.deal_hunter_pursue_renew_initial_claim_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touch_id text := public.pursue_cim_required_text_v1(p_command, 'touchId', 240);
  v_transmission_id text := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_expected_row bigint := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_claim_digest text := public.pursue_cim_required_text_v1(p_command, 'claimTokenDigest', 64);
  v_claim_owner text := public.pursue_cim_required_text_v1(p_command, 'claimOwner', 200);
  v_claim_expires timestamptz := public.pursue_cim_required_instant_v1(p_command, 'claimExpiresAt');
  v_actor text := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_unchanged boolean;
  v_changed bigint;
begin
  if v_claim_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid claim token digest';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  select * into v_touch from public.deal_hunter_cim_campaign_touches
    where id = v_touch_id for update;
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_transmission_id for update;
  select * into v_campaign from public.deal_hunter_cim_campaigns
    where id = v_touch.campaign_id for update;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_campaign.conversation_id for update;
  v_unchanged := coalesce(v_touch.id is not null and v_transmission.id is not null
    and v_campaign.id is not null and v_conversation.id is not null
    and exists(select 1 from public.deal_hunter_cim_transmission_touches m
      where m.touch_id = v_touch.id and m.transmission_id = v_transmission.id
        and m.cancelled_at is null)
    and v_touch.kind = 'initial' and v_touch.logical_slot = 'initial' and v_touch.ordinal = 0
    and v_touch.state = 'claimed' and v_touch.transmission_id = v_transmission.id
    and v_touch.opportunity_id = v_campaign.opportunity_id
    and v_touch.timezone_revision = v_campaign.timezone_revision
    and v_transmission.state = 'prepared' and v_transmission.invocation_authority_count = 0
    and v_transmission.provider_seam_entered_at is null
    and v_transmission.boundary_nonce_digest is null
    and v_transmission.conversation_id = v_conversation.id
    and v_campaign.state = 'initial-pending' and v_campaign.generation = 1
    and v_campaign.policy_version = 'deal-hunter-cim-autopilot-v1'
    and v_conversation.state = 'open'
    and (v_campaign.local_expiry_at is null or v_campaign.local_expiry_at > v_now)
    and public.pursue_cim_current_activation_v1('fl04b-initial', v_now) is not null, false);
  if v_unchanged and v_touch.claim_token_digest = v_claim_digest
    and v_touch.claim_owner = v_claim_owner and v_touch.claim_expires_at = v_claim_expires
    and v_touch.claim_expires_at > v_now
  then
    return pg_catalog.jsonb_build_object('renewed', false, 'existing', true, 'terminal', false,
      'blockedReason', null, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if not v_unchanged or v_touch.row_version <> v_expected_row
    or v_touch.claim_expires_at is null or v_touch.claim_expires_at > v_now
    or v_claim_expires <= v_now or v_claim_expires > v_now + interval '5 minutes'
  then
    return pg_catalog.jsonb_build_object('renewed', false, 'existing', false, 'terminal', true,
      'blockedReason', 'renewal_authority_changed',
      'transmission', case when v_transmission.id is null then null
        else pg_catalog.to_jsonb(v_transmission) end,
      'touch', case when v_touch.id is null then null else pg_catalog.to_jsonb(v_touch) end);
  end if;
  update public.deal_hunter_cim_campaign_touches set claim_token_digest = v_claim_digest,
    claim_owner = v_claim_owner, claimed_at = v_now, claim_expires_at = v_claim_expires,
    row_version = row_version + 1, updated_at = v_now
    where id = v_touch.id and row_version = v_expected_row
      and transmission_id = v_transmission.id and state = 'claimed';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'Initial claim renewal lost touch authority';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id, transmission_id,
     prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('touch-claim-renewed'::text),
      pg_catalog.to_jsonb(v_touch.id || ':' || (v_expected_row + 1)::text)),
    'touch-claim-renewed', v_touch.opportunity_id, v_campaign.id, v_conversation.id,
    v_touch.id, v_transmission.id, 'claimed', 'claimed', 'lapsed_claim', v_actor,
    'sqlite-transition', v_now, '{}'::jsonb);
  select * into v_touch from public.deal_hunter_cim_campaign_touches where id = v_touch.id;
  return pg_catalog.jsonb_build_object('renewed', true, 'existing', false, 'terminal', false,
    'blockedReason', null, 'transmission', pg_catalog.to_jsonb(v_transmission),
    'touch', pg_catalog.to_jsonb(v_touch));
end;
$$;

revoke all on function public.deal_hunter_pursue_renew_initial_claim_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_pursue_renew_initial_claim_v1(jsonb)
  to service_role;

-- Task 8 fix round 1.
--
-- Ruling M: a provider-pending transmission whose provider seam was never entered cannot have
-- reached the provider (the seam is durable before any provider call). The release accepts it
-- under code provider_seam_not_entered once its authorization was consumed at least ten
-- minutes ago; every other code still requires an entered seam. Redefines the body above with
-- only that change.
create or replace function public.deal_hunter_pursue_release_unsent_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_payload_digest text := public.pursue_cim_required_text_v1(p_command, 'payloadDigest', 64);
  v_expected bigint := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_code text := public.pursue_cim_required_text_v1(p_command, 'providerResultCode', 160);
  v_actor text := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_touch_ids text[] := array[]::text[];
  v_touches jsonb := '[]'::jsonb;
  v_replay boolean;
  v_unentered boolean := false;
  v_authorized timestamptz;
begin
  if v_payload_digest !~ '^[0-9a-f]{64}$'
    or p_command ->> 'provider' is distinct from 'gmail'
    or v_code not in ('provider_quota','gmail_token_invalid','gmail_token_refresh_failed',
      'gmail_not_connected','gmail_access_denied','provider_seam_not_entered') then
    raise exception 'Invalid Pursue CIM provider release command';
  end if;
  v_unentered := v_code = 'provider_seam_not_entered';
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_id for update;
  if v_transmission.id is null or v_transmission.payload_digest <> v_payload_digest then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'transmission', case when v_transmission.id is null then null
        else pg_catalog.to_jsonb(v_transmission) end, 'touches', '[]'::jsonb);
  end if;
  if v_transmission.state = 'cancelled-before-provider' then
    v_replay := coalesce(v_transmission.provider = 'gmail'
      and v_transmission.provider_result_code = v_code
      and (v_transmission.provider_seam_entered_at is null) = v_unentered, false);
    return pg_catalog.jsonb_build_object('applied', false, 'replay', v_replay,
      'conflict', not v_replay, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'touches', '[]'::jsonb);
  end if;
  if v_transmission.state <> 'provider-pending' or v_transmission.row_version <> v_expected
    or v_transmission.invocation_authority_count <> 1
    or (v_transmission.provider_seam_entered_at is null) <> v_unentered
    or v_transmission.provider is not null or v_transmission.provider_message_id is not null
    or v_transmission.provider_result_code is not null then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'transmission', pg_catalog.to_jsonb(v_transmission), 'touches', '[]'::jsonb);
  end if;
  if v_unentered then
    select max(a.consumed_at) into v_authorized
      from public.deal_hunter_cim_live_provider_authorizations a
      where a.transmission_id = v_id and a.consumed_at is not null;
    if v_authorized is null or v_authorized > v_now - interval '10 minutes' then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
        'transmission', pg_catalog.to_jsonb(v_transmission), 'touches', '[]'::jsonb);
    end if;
  end if;
  -- Campaigns precede memberships/touches so terminal writers share this order.
  perform 1 from public.deal_hunter_cim_campaigns c
    join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
    where m.transmission_id = v_id order by c.id for update of c;
  for v_member in select t.* from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
      where m.transmission_id = v_id and m.cancelled_at is null
      order by t.id for update of m,t
  loop
    if v_member.state <> 'provider-pending' or v_member.transmission_id <> v_id then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
        'transmission', pg_catalog.to_jsonb(v_transmission), 'touches', '[]'::jsonb);
    end if;
    v_touch_ids := pg_catalog.array_append(v_touch_ids, v_member.id);
  end loop;
  if pg_catalog.cardinality(v_touch_ids) = 0 then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'transmission', pg_catalog.to_jsonb(v_transmission), 'touches', '[]'::jsonb);
  end if;
  update public.deal_hunter_cim_transmissions set state = 'cancelled-before-provider',
    provider = 'gmail', provider_result_code = v_code, row_version = row_version + 1,
    updated_at = v_now
    where id = v_id and state = 'provider-pending' and row_version = v_expected
    returning * into v_transmission;
  if not found then raise exception 'Concurrent Pursue CIM provider release'; end if;
  update public.deal_hunter_cim_transmission_touches
    set cancelled_at = v_now, cancellation_reason = 'provider-unsent-release'
    where transmission_id = v_id and cancelled_at is null;
  for v_member in select * from public.deal_hunter_cim_campaign_touches
      where id = any(v_touch_ids) order by id
  loop
    update public.deal_hunter_cim_campaign_touches set state = 'scheduled',
      transmission_id = null, claim_token_digest = null, claim_owner = null,
      claimed_at = null, claim_expires_at = null, row_version = row_version + 1,
      updated_at = v_now
      where id = v_member.id and state = 'provider-pending' and transmission_id = v_id
        and row_version = v_member.row_version;
    if not found then raise exception 'Concurrent Pursue CIM touch release'; end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, touch_id, transmission_id,
       prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('touch-released'::text),
        pg_catalog.to_jsonb(v_member.id || ':' || (v_member.row_version + 1)::text)),
      'touch-released', v_member.opportunity_id, v_member.campaign_id, v_member.id, v_id,
      'provider-pending', 'scheduled', v_code, v_actor, 'postgres-transition', v_now,
      '{}'::jsonb);
  end loop;
  update public.crm_communications set provider = 'gmail', delivery_state = 'not-attempted',
    delivery_state_at = v_now, updated_at = v_now
    where id = v_transmission.communication_id;
  update public.crm_email_outbox set provider = 'gmail', state = 'cancelled',
    last_error_category = v_code, updated_at = v_now
    where id = v_transmission.outbox_id;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, conversation_id, transmission_id, prior_state, next_state,
     reason_code, payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-released'::text), pg_catalog.to_jsonb(v_id)),
    'transmission-released', v_transmission.conversation_id, v_id, 'provider-pending',
    'cancelled-before-provider', v_code, v_payload_digest, v_actor, 'postgres-transition',
    v_now, '{}'::jsonb);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.id), '[]'::jsonb)
    into v_touches from public.deal_hunter_cim_campaign_touches t where t.id = any(v_touch_ids);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false, 'conflict', false,
    'transmission', pg_catalog.to_jsonb(v_transmission), 'touches', v_touches);
end;
$$;
revoke all on function public.deal_hunter_pursue_release_unsent_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_pursue_release_unsent_v1(jsonb) to service_role;

-- Ruling N: turning Live sending off withdraws its capability chain, so every prepared,
-- never-authorized transmission is cancelled before the provider and its touches return to
-- scheduled (memberships cancelled as provider-unsent-release, so the touch is claimed again
-- under the next generation). Unused authorizations are withdrawn; a follow-up's reserved
-- capacity is released by the existing transmission trigger. No terminal event, no campaign
-- change. Mirrors releasePreparedCimTransmissions in SQLite.
create or replace function public.deal_hunter_pursue_release_prepared_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := public.pursue_cim_required_text_v1(p_command, 'reasonCode', 160);
  v_actor text := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_authorization record;
  v_skip boolean;
  v_released text[] := array[]::text[];
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  for v_transmission in select * from public.deal_hunter_cim_transmissions
      where state in ('prepared', 'final-gate-blocked') and invocation_authority_count = 0
      order by id for update
  loop
    perform 1 from public.deal_hunter_cim_campaigns c
      join public.deal_hunter_cim_transmission_touches m on m.campaign_id = c.id
      where m.transmission_id = v_transmission.id order by c.id for update of c;
    select coalesce(bool_or(t.state <> 'claimed'
        or t.transmission_id is distinct from v_transmission.id), true) into v_skip
      from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
      where m.transmission_id = v_transmission.id and m.cancelled_at is null;
    continue when v_skip;
    for v_member in select t.* from public.deal_hunter_cim_transmission_touches m
        join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
        where m.transmission_id = v_transmission.id and m.cancelled_at is null
        order by t.id for update of m, t
    loop
      update public.deal_hunter_cim_transmission_touches
        set cancelled_at = v_now, cancellation_reason = 'provider-unsent-release'
        where transmission_id = v_transmission.id and touch_id = v_member.id
          and cancelled_at is null;
      update public.deal_hunter_cim_campaign_touches set state = 'scheduled',
        transmission_id = null, claim_token_digest = null, claim_owner = null,
        claimed_at = null, claim_expires_at = null, row_version = row_version + 1,
        updated_at = v_now
        where id = v_member.id and state = 'claimed' and transmission_id = v_transmission.id
          and row_version = v_member.row_version;
      if not found then raise exception 'Concurrent Pursue CIM prepared release'; end if;
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, touch_id, transmission_id,
         prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('touch-released'::text),
          pg_catalog.to_jsonb(v_member.id || ':' || (v_member.row_version + 1)::text)),
        'touch-released', v_member.opportunity_id, v_member.campaign_id, v_member.id,
        v_transmission.id, 'claimed', 'scheduled', v_reason, v_actor, 'sqlite-transition',
        v_now, '{}'::jsonb);
    end loop;
    update public.deal_hunter_cim_transmissions set state = 'cancelled-before-provider',
      row_version = row_version + 1, updated_at = v_now
      where id = v_transmission.id and state in ('prepared', 'final-gate-blocked')
        and invocation_authority_count = 0;
    update public.crm_email_outbox set state = 'cancelled', updated_at = v_now
      where id = v_transmission.outbox_id and state in ('prepared', 'final-gate-blocked');
    for v_authorization in select id from public.deal_hunter_cim_live_provider_authorizations
        where transmission_id = v_transmission.id and consumed_at is null
          and withdrawn_at is null for update
    loop
      update public.deal_hunter_cim_live_provider_authorizations set withdrawn_at = v_now
        where id = v_authorization.id and consumed_at is null and withdrawn_at is null;
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, transmission_id, authorization_id, prior_state, next_state,
         reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('authorization-withdrawn'::text),
          pg_catalog.to_jsonb(v_authorization.id)),
        'authorization-withdrawn', v_transmission.id, v_authorization.id, 'issued',
        'withdrawn', v_reason, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    end loop;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, conversation_id, transmission_id, prior_state, next_state,
       reason_code, payload_digest, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('transmission-released'::text),
        pg_catalog.to_jsonb(v_transmission.id)),
      'transmission-released', v_transmission.conversation_id, v_transmission.id,
      v_transmission.state, 'cancelled-before-provider', v_reason,
      v_transmission.payload_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    v_released := pg_catalog.array_append(v_released, v_transmission.id);
  end loop;
  return pg_catalog.jsonb_build_object('released', pg_catalog.cardinality(v_released),
    'transmissionIds', pg_catalog.to_jsonb(v_released));
end;
$$;

revoke all on function public.deal_hunter_pursue_release_prepared_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_pursue_release_prepared_v1(jsonb)
  to service_role;

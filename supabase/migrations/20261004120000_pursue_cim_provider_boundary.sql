-- Package 6B: exact default-deny provider seam predicates.

create or replace function public.pursue_cim_enter_provider_seam_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_authorization_id text;
  v_writer_path text;
  v_provider_profile text;
  v_capability text;
  v_payload_digest text;
  v_nonce_digest text;
  v_expected bigint;
  v_actor text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_communication public.crm_communications%rowtype;
  v_outbox public.crm_email_outbox%rowtype;
  v_pause boolean;
  v_member_count bigint;
  v_initial_count bigint;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_authorization_id := public.pursue_cim_required_text_v1(p_command, 'authorizationId', 240);
  v_writer_path := public.pursue_cim_required_text_v1(p_command, 'writerPath', 240);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_capability := public.pursue_cim_required_text_v1(p_command, 'capability', 40);
  v_payload_digest := public.pursue_cim_required_text_v1(p_command, 'payloadDigest', 64);
  v_nonce_digest := public.pursue_cim_required_text_v1(p_command, 'boundaryNonceDigest', 64);
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if v_payload_digest !~ '^[0-9a-f]{64}$'
    or v_nonce_digest !~ '^[0-9a-f]{64}$'
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM provider seam command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');

  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_transmission_id for update;
  select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
    where id = v_authorization_id for share;
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where id = v_authorization.activation_id for share;
  select * into v_communication from public.crm_communications
    where id = v_transmission.communication_id for share;
  select * into v_outbox from public.crm_email_outbox
    where id = v_transmission.outbox_id for share;
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where t.kind = 'initial')
    into v_member_count, v_initial_count
    from public.deal_hunter_cim_transmission_touches m
    join public.deal_hunter_cim_campaign_touches t on t.id = m.touch_id
    where m.transmission_id = v_transmission_id and m.cancelled_at is null;
  select outreach_paused into v_pause from public.deal_hunter_cim_safety_settings
    where id = 'global' for share;

  if v_transmission.state is distinct from 'provider-pending'
    or v_transmission.invocation_authority_count is distinct from 1
    or v_transmission.payload_digest is distinct from v_payload_digest
    or v_transmission.boundary_nonce_digest is distinct from v_nonce_digest
    or v_authorization.transmission_id is distinct from v_transmission_id
    or v_authorization.writer_path is distinct from v_writer_path
    or v_authorization.provider_profile is distinct from v_provider_profile
    or v_authorization.capability is distinct from v_capability
    or v_authorization.payload_digest is distinct from v_payload_digest
    or v_authorization.maximum_calls is distinct from 1
    or v_authorization.consumed_at is null
    or v_authorization.withdrawn_at is not null
    or v_authorization.expires_at <= v_now
    or v_activation.id is distinct from v_authorization.activation_id
    or v_activation.provider_profile is distinct from v_provider_profile
    or public.pursue_cim_current_activation_v1(v_capability, v_now)
      is distinct from v_authorization.activation_id
    or not (
      (v_writer_path in ('pursue-cim-initial', 'pursue-cim-autopilot-initial')
        and v_capability = 'fl04b-initial')
      or (v_writer_path in ('pursue-cim-follow-up', 'pursue-cim-autopilot-follow-up')
        and v_capability = 'fl04c-followup')
      or (v_writer_path in ('pursue-cim-batch', 'pursue-cim-autopilot-batch')
        and v_capability = 'fl04c-batch')
    )
    or v_member_count < 1
    or (v_capability = 'fl04b-initial' and not (v_member_count = 1 and v_initial_count = 1))
    or (v_capability = 'fl04c-followup' and not (v_member_count = 1 and v_initial_count = 0))
    or (v_capability = 'fl04c-batch' and v_member_count <= 1)
    or v_communication.id is distinct from v_transmission.communication_id
    or v_communication.delivery_state is distinct from 'provider-pending'
    or v_outbox.id is distinct from v_transmission.outbox_id
    or v_outbox.communication_id is distinct from v_communication.id
    or v_outbox.state is distinct from 'provider-pending'
    or v_pause is distinct from false
  then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;
  if v_transmission.provider_seam_entered_at is not null then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', true, 'unauthorized', false);
  end if;
  if v_transmission.row_version is distinct from v_expected then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;

  update public.deal_hunter_cim_transmissions
    set provider_seam_entered_at = v_now, updated_at = v_now,
      row_version = row_version + 1
    where id = v_transmission_id and state = 'provider-pending'
      and invocation_authority_count = 1
      and provider_seam_entered_at is null
      and payload_digest = v_payload_digest
      and boundary_nonce_digest = v_nonce_digest and row_version = v_expected;
  if not found then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, authorization_id, next_state,
     payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('provider-seam-entered'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'provider-seam-entered', v_transmission_id, v_authorization_id,
    'entered', v_payload_digest, v_actor, 'postgres-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('entered', true,
    'alreadyEntered', false, 'unauthorized', false);
end;
$$;

revoke all on function public.pursue_cim_enter_provider_seam_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_enter_provider_seam_v1(jsonb)
  to service_role;

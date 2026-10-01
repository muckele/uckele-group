-- Package 7B: converge domain terminal writers on the campaign terminal RPC.
-- Triggers run in the originating domain transaction so evidence and terminal
-- authority cannot be separated by a crash.

alter function public.pursue_cim_append_terminal_event_v1(jsonb)
  rename to pursue_cim_append_terminal_event_p7a;
revoke all on function public.pursue_cim_append_terminal_event_p7a(jsonb)
  from public, anon, authenticated, service_role;

alter function public.pursue_cim_record_owner_decision_v1(jsonb)
  rename to pursue_cim_record_owner_decision_p7a;
revoke all on function public.pursue_cim_record_owner_decision_p7a(jsonb)
  from public, anon, authenticated, service_role;

alter function public.pursue_cim_prepare_transmission_v1(jsonb)
  rename to pursue_cim_prepare_transmission_p7a;
revoke all on function public.pursue_cim_prepare_transmission_p7a(jsonb)
  from public, anon, authenticated, service_role;

alter function public.pursue_cim_finalize_transmission_v1(jsonb)
  rename to pursue_cim_finalize_transmission_p7a;
revoke all on function public.pursue_cim_finalize_transmission_p7a(jsonb)
  from public, anon, authenticated, service_role;

alter function public.pursue_cim_reconcile_transmission_v1(jsonb)
  rename to pursue_cim_reconcile_transmission_p7a;
revoke all on function public.pursue_cim_reconcile_transmission_p7a(jsonb)
  from public, anon, authenticated, service_role;

alter function public.pursue_cim_finalize_with_cadence_v1(jsonb)
  rename to pursue_cim_finalize_with_cadence_p7a;
revoke all on function public.pursue_cim_finalize_with_cadence_p7a(jsonb)
  from public, anon, authenticated, service_role;

alter function public.pursue_cim_reconcile_with_cadence_v1(jsonb)
  rename to pursue_cim_reconcile_with_cadence_p7a;
revoke all on function public.pursue_cim_reconcile_with_cadence_p7a(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.pursue_cim_material_token_p7b(p_value text)
returns text language sql immutable set search_path = '' as $$
  select pg_catalog.left(pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_value, ''))),
    '[-[:space:]]+', '_', 'g'), 120)
$$;

create or replace function public.pursue_cim_material_filename_kind_p7b(p_value text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v_value text := pg_catalog.left(pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(coalesce(p_value, ''))),
      '[_-]+', ' ', 'g'), '[[:space:]]+', ' ', 'g'), 300);
begin
  if v_value ~ '(^|[^[:alnum:]_])((cim|teaser|prospectus)|confidential information memorandum|offering (memorandum|materials?))([^[:alnum:]_]|$)'
  then return 'cim'; end if;
  if v_value ~ '(^|[^[:alnum:]_])(financial (package|statements?)|p[[:space:]]*(&|and)[[:space:]]*l|profit and loss|tax returns?|balance sheet)([^[:alnum:]_]|$)'
  then return 'financial'; end if;
  return '';
end;
$$;

revoke all on function public.pursue_cim_material_token_p7b(text)
  from public, anon, authenticated, service_role;
revoke all on function public.pursue_cim_material_filename_kind_p7b(text)
  from public, anon, authenticated, service_role;

create or replace function public.pursue_cim_bump_global_authority_revision_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'UPDATE' then
    if TG_TABLE_NAME = 'crm_communications' then
      if old.source = 'pursue-cim-autopilot'
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
    end if;
    if TG_TABLE_NAME = 'deal_hunter_source_freshness_state' then
      if old.accepted_generation is not distinct from new.accepted_generation
        and old.accepted_run_id is not distinct from new.accepted_run_id
        and old.accepted_digest is not distinct from new.accepted_digest
        and old.projection_state is not distinct from new.projection_state
      then
        return new;
      end if;
    end if;
    if TG_TABLE_NAME = 'deal_hunter_identity_exceptions' then
      if old.status is not distinct from new.status
        and old.candidate_opportunity_ids is not distinct from new.candidate_opportunity_ids
      then
        return new;
      end if;
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

create or replace function public.pursue_cim_record_owner_decision_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  return public.pursue_cim_record_owner_decision_p7a(p_command);
end;
$$;

create or replace function public.pursue_cim_prepare_transmission_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  return public.pursue_cim_prepare_transmission_p7a(p_command);
end;
$$;

create or replace function public.pursue_cim_finalize_transmission_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  return public.pursue_cim_finalize_transmission_p7a(p_command);
end;
$$;

create or replace function public.pursue_cim_reconcile_transmission_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  return public.pursue_cim_reconcile_transmission_p7a(p_command);
end;
$$;

create or replace function public.pursue_cim_finalize_with_cadence_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  return public.pursue_cim_finalize_with_cadence_p7a(p_command);
end;
$$;

create or replace function public.pursue_cim_reconcile_with_cadence_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  return public.pursue_cim_reconcile_with_cadence_p7a(p_command);
end;
$$;

revoke all on function public.pursue_cim_record_owner_decision_v1(jsonb)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_prepare_transmission_v1(jsonb)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_finalize_transmission_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.pursue_cim_reconcile_transmission_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.pursue_cim_finalize_with_cadence_v1(jsonb)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_reconcile_with_cadence_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_record_owner_decision_v1(jsonb) to service_role;
grant execute on function public.pursue_cim_prepare_transmission_v1(jsonb) to service_role;
grant execute on function public.pursue_cim_finalize_with_cadence_v1(jsonb) to service_role;
grant execute on function public.pursue_cim_reconcile_with_cadence_v1(jsonb) to service_role;


alter function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  rename to pursue_cim_authorize_provider_pending_p7a;
revoke all on function public.pursue_cim_authorize_provider_pending_p7a(jsonb)
  from public, anon, authenticated, service_role;

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
      if v_expected_member #>> '{campaign,permission_version}'
          is distinct from v_member.permission_version
        or v_member.permission_version is distinct from v_activation.prerequisite_activation_id
      then v_reason := 'unknown_policy_version'; exit gate; end if;
      if v_member.kind <> 'initial' or v_member.logical_slot <> 'initial' or v_member.ordinal <> 0
        or v_member.generation <> 1
        or v_member.policy_version <> 'deal-hunter-cim-autopilot-v1'
        or v_member.campaign_state <> 'initial-pending'
        or v_member.touch_timezone_revision <> v_member.timezone_revision
      then v_reason := 'lifecycle_conflict'; exit gate; end if;
      if (v_expected_member #>> '{campaign,row_version}')::bigint
          is distinct from v_member.campaign_row_version
        or v_expected_member #>> '{campaign,permission_digest}'
          is distinct from v_member.permission_digest
        or (v_expected_member #>> '{campaign,permission_revision}')::bigint
          is distinct from v_member.permission_revision
        or v_expected_member #>> '{campaign,permission_scope}'
          is distinct from v_member.permission_scope
        or v_activation.permission_basis_digest is distinct from v_member.permission_digest
        or v_activation.permission_revision is distinct from v_member.permission_revision
        or v_activation.cohort_digest is distinct from v_member.permission_scope
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
      or v_communication.kind <> 'cim-initial'
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

create or replace function public.pursue_cim_authorize_provider_pending_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_actor text;
  v_gate_digest text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_terminal_reason text;
  v_blocked_reason text;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_gate_digest := public.pursue_cim_required_text_v1(
    p_command, 'finalGateAuthorityDigest', 64);
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_transmission_id;
  if v_transmission.state = 'cancelled-before-provider' then
    select event.reason_code into v_terminal_reason
    from public.deal_hunter_cim_terminal_events event
    join public.deal_hunter_cim_transmission_touches member
      on member.campaign_id = event.campaign_id
    where member.transmission_id = v_transmission.id and event.scope = 'campaign'
    order by event.revision desc, event.created_at desc, event.id desc limit 1;
    v_blocked_reason := case
      when v_terminal_reason in ('materials_received','advanced_beyond_broker_outreach')
        then 'materials_received'
      when v_terminal_reason = 'recipient_suppressed' then 'recipient_suppressed'
      when v_terminal_reason = 'identity_ambiguous' then 'identity_authority_changed'
      when v_terminal_reason in ('crm_archived','crm_superseded') then 'crm_owner_changed'
      when v_terminal_reason in ('watch-selected','pass-selected') then 'owner_intent_changed'
      else 'terminal_authority_changed'
    end;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, conversation_id, transmission_id, prior_state, next_state,
       reason_code, authority_digest, payload_digest, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-final-gate-block:v1'::text),
        pg_catalog.to_jsonb(v_transmission.id),
        pg_catalog.to_jsonb(v_transmission.row_version),
        pg_catalog.to_jsonb(v_blocked_reason), pg_catalog.to_jsonb(v_gate_digest)),
      'final-gate-blocked', v_transmission.conversation_id, v_transmission.id,
      v_transmission.state, v_transmission.state, v_blocked_reason, v_gate_digest,
      v_transmission.payload_digest, v_actor, 'postgres-terminal-readthrough',
      v_now, '{}'::jsonb)
    on conflict (id) do nothing;
    return pg_catalog.jsonb_build_object('authorized', false,
      'blockedReason', v_blocked_reason, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'boundaryNonceDigest', null);
  end if;
  return public.pursue_cim_authorize_provider_pending_p7a(p_command);
end;
$$;

revoke all on function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_append_terminal_event_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id text;
  v_scope text;
  v_scope_id text;
  v_next_state text;
  v_expected_revision bigint;
  v_expected_row bigint;
  v_reason text;
  v_evidence_type text;
  v_evidence_id text;
  v_metadata_digest text;
  v_actor text;
  v_source text;
  v_observed timestamptz;
  v_now timestamptz;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_member record;
  v_cancelled text[] := array[]::text[];
  v_special boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  v_event_id := public.pursue_cim_required_text_v1(p_command, 'eventId', 240);
  v_scope := public.pursue_cim_required_text_v1(p_command, 'scope', 20);
  v_scope_id := public.pursue_cim_required_text_v1(p_command, 'scopeId', 240);
  v_next_state := public.pursue_cim_required_text_v1(p_command, 'nextState', 120);
  if exists (select 1 from public.deal_hunter_cim_terminal_events where id = v_event_id)
    or v_scope <> 'campaign'
  then
    return public.pursue_cim_append_terminal_event_p7a(p_command);
  end if;
  select * into v_campaign from public.deal_hunter_cim_campaigns
    where id = v_scope_id for update;
  v_special := (v_campaign.state = 'action-required' and v_next_state = 'action-required')
    or (v_campaign.state = 'provider-ambiguous'
      and v_next_state in ('action-required','responded','materials-received','stopped'));
  if not coalesce(v_special, false) then
    return public.pursue_cim_append_terminal_event_p7a(p_command);
  end if;
  perform public.pursue_cim_assert_types_v1(p_command,
    array[]::text[], array[]::text[], array['reconciliationEvidenceId']);
  v_expected_revision := public.pursue_cim_required_revision_v1(
    p_command, 'expectedRevision');
  v_expected_row := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_reason := public.pursue_cim_required_text_v1(p_command, 'reasonCode', 160);
  v_evidence_type := public.pursue_cim_required_text_v1(p_command, 'evidenceType', 120);
  v_evidence_id := public.pursue_cim_required_text_v1(p_command, 'evidenceId', 240);
  v_metadata_digest := public.pursue_cim_required_text_v1(p_command, 'metadataDigest', 64);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_source := public.pursue_cim_required_text_v1(p_command, 'source', 120);
  if v_metadata_digest !~ '^[0-9a-f]{64}$'
    or p_command ->> 'observedAt' is null or p_command ->> 'now' is null
    or v_campaign.terminal_revision <> v_expected_revision
    or v_campaign.row_version <> v_expected_row
  then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'campaignRevision', v_campaign.terminal_revision,
      'conversationRevision', null, 'cancelledTouchIds', '[]'::jsonb);
  end if;
  v_observed := public.pursue_cim_required_instant_v1(p_command, 'observedAt');
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  for v_transmission in
    select tr.* from public.deal_hunter_cim_transmissions tr
    join public.deal_hunter_cim_transmission_touches member
      on member.transmission_id = tr.id and member.cancelled_at is null
    where member.campaign_id = v_scope_id
      and tr.state in ('prepared','final-gate-blocked')
    order by tr.id for update of tr
  loop
    if public.pursue_cim_cancel_prepared_transmission_v1(
      v_transmission.id, v_now, v_reason, v_actor, false) then
      for v_member in select touch_id from public.deal_hunter_cim_transmission_touches
        where transmission_id = v_transmission.id and cancelled_at = v_now
        order by touch_id
      loop
        v_cancelled := pg_catalog.array_append(v_cancelled, v_member.touch_id);
      end loop;
    end if;
  end loop;
  for v_touch in select * from public.deal_hunter_cim_campaign_touches
    where campaign_id = v_scope_id and state in ('scheduled','claimed')
      and transmission_id is null order by id for update
  loop
    update public.deal_hunter_cim_campaign_touches
      set state = 'cancelled-before-provider', terminal_reason = v_reason,
        updated_at = v_now, row_version = row_version + 1
      where id = v_touch.id and row_version = v_touch.row_version;
    if not found then raise exception 'Concurrent Pursue CIM touch terminalization'; end if;
    v_cancelled := pg_catalog.array_append(v_cancelled, v_touch.id);
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, touch_id, prior_state,
       next_state, reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('touch-cancelled'::text),
        pg_catalog.to_jsonb(v_touch.id || ':' || (v_touch.row_version + 1)::text)),
      'touch-cancelled', v_touch.opportunity_id, v_scope_id, v_touch.id,
      v_touch.state, 'cancelled-before-provider', v_reason, v_actor,
      v_source, v_now, '{}'::jsonb);
  end loop;
  update public.deal_hunter_cim_campaigns set state = v_next_state,
    reason_code = v_reason, terminal_revision = terminal_revision + 1,
    row_version = row_version + 1, updated_at = v_now
    where id = v_scope_id and terminal_revision = v_expected_revision
      and row_version = v_expected_row;
  if not found then raise exception 'Concurrent Pursue CIM campaign terminalization'; end if;
  insert into public.deal_hunter_cim_terminal_events
    (id, scope, scope_id, campaign_id, revision, reason_code, evidence_type,
     evidence_id, observed_at, actor, source, metadata_digest, created_at)
  values (v_event_id, 'campaign', v_scope_id, v_scope_id, v_expected_revision + 1,
    v_reason, v_evidence_type, v_evidence_id, v_observed, v_actor, v_source,
    v_metadata_digest, v_now);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
     reason_code, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('terminal-transition'::text), pg_catalog.to_jsonb(v_event_id)),
    'terminal-transition', v_campaign.opportunity_id, v_scope_id, v_campaign.state,
    v_next_state, v_reason, v_actor, v_source, v_now, '{}'::jsonb);
  select coalesce(pg_catalog.array_agg(value order by value), array[]::text[])
    into v_cancelled from pg_catalog.unnest(v_cancelled) value;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'campaignRevision', v_expected_revision + 1,
    'conversationRevision', null, 'cancelledTouchIds', pg_catalog.to_jsonb(v_cancelled));
end;
$$;

revoke all on function public.pursue_cim_append_terminal_event_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_terminal_event_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_converge_terminal_authority_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_ids text[] := array[]::text[];
  v_submission_id text := coalesce(p_command ->> 'submissionId', '');
  v_recipient_email text := pg_catalog.lower(coalesce(p_command ->> 'recipientEmail', ''));
  v_communication_id text := coalesce(p_command ->> 'communicationId', '');
  v_evaluate_materials boolean := coalesce((p_command ->> 'evaluateMaterialsState')::boolean, false);
  v_reason text := coalesce(p_command ->> 'reasonCode', '');
  v_evidence_type text := p_command ->> 'evidenceType';
  v_evidence_id text := p_command ->> 'evidenceId';
  v_actor text := p_command ->> 'actor';
  v_source text := p_command ->> 'source';
  v_observed timestamptz;
  v_now timestamptz;
  v_selector_count integer;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_next_state text;
  v_event_id text;
  v_metadata_digest text;
  v_result jsonb;
  v_outcomes jsonb := '[]'::jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or (p_command ? 'opportunityIds'
      and pg_catalog.jsonb_typeof(p_command -> 'opportunityIds') <> 'array')
    or (p_command ? 'evaluateMaterialsState'
      and pg_catalog.jsonb_typeof(p_command -> 'evaluateMaterialsState') <> 'boolean')
  then
    raise exception 'Invalid Pursue CIM terminal convergence command';
  end if;
  if p_command ? 'opportunityIds' then
    select coalesce(pg_catalog.array_agg(value order by value), array[]::text[])
      into v_opportunity_ids
      from pg_catalog.jsonb_array_elements_text(p_command -> 'opportunityIds');
  elsif nullif(p_command ->> 'opportunityId', '') is not null then
    v_opportunity_ids := array[p_command ->> 'opportunityId'];
  end if;
  v_selector_count := (case when pg_catalog.cardinality(v_opportunity_ids) > 0 then 1 else 0 end)
    + (case when v_submission_id <> '' then 1 else 0 end)
    + (case when v_recipient_email <> '' then 1 else 0 end)
    + (case when v_communication_id <> '' then 1 else 0 end);
  if v_selector_count <> 1 or pg_catalog.cardinality(v_opportunity_ids) > 50
    or exists (select 1 from pg_catalog.unnest(v_opportunity_ids) value
      where pg_catalog.length(value) not between 1 and 200
        or pg_catalog.btrim(value) <> value)
    or (select count(*) from pg_catalog.unnest(v_opportunity_ids))
      <> (select count(distinct value) from pg_catalog.unnest(v_opportunity_ids) value)
    or pg_catalog.length(v_submission_id) > 120
    or pg_catalog.length(v_recipient_email) > 320
    or pg_catalog.length(v_communication_id) > 120
    or v_evidence_type is null or pg_catalog.length(v_evidence_type) not between 1 and 120
    or pg_catalog.btrim(v_evidence_type) <> v_evidence_type
    or v_evidence_id is null or pg_catalog.length(v_evidence_id) not between 1 and 240
    or pg_catalog.btrim(v_evidence_id) <> v_evidence_id
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or v_source is null or pg_catalog.length(v_source) not between 1 and 120
    or pg_catalog.btrim(v_source) <> v_source
    or (not v_evaluate_materials and (pg_catalog.length(v_reason) not between 1 and 160
      or pg_catalog.btrim(v_reason) <> v_reason))
    or p_command ->> 'observedAt' is null or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM terminal convergence authority';
  end if;
  v_observed := public.pursue_cim_required_instant_v1(p_command, 'observedAt');
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');

  for v_campaign in
    select campaign.*
    from public.deal_hunter_cim_campaigns campaign
    join public.deal_hunter_broker_conversations conversation
      on conversation.id = campaign.conversation_id
    where campaign.state in ('queued','waiting-on-eligibility','initial-pending',
      'active-follow-up','action-required','provider-ambiguous')
      and ((pg_catalog.cardinality(v_opportunity_ids) > 0
          and campaign.opportunity_id = any(v_opportunity_ids))
        or (v_submission_id <> '' and campaign.crm_submission_id::text = v_submission_id)
        or (v_recipient_email <> ''
          and pg_catalog.lower(conversation.recipient_address) = v_recipient_email)
        or (v_communication_id <> '' and exists (
          select 1 from public.deal_hunter_cim_transmission_touches member
          join public.deal_hunter_cim_transmissions transmission
            on transmission.id = member.transmission_id
          where member.campaign_id = campaign.id
            and transmission.communication_id = v_communication_id)))
    order by campaign.id
    for update of campaign
  loop
    if v_evaluate_materials then
      select * into v_submission from public.contact_submissions
        where id::text = v_campaign.crm_submission_id::text;
      if v_submission.id is null then continue; end if;
      if not coalesce((
        nullif(pg_catalog.btrim(v_submission.prospectus_url), '') is not null
        or exists (select 1 from public.secure_documents document
          where document.submission_id::text = v_campaign.crm_submission_id::text
            and (
              public.pursue_cim_material_token_p7b(document.document_type)
                in ('cim','teaser','prospectus','offering_memorandum','offering_materials',
                  'data_room','broker_materials','financials','financial_package',
                  'financial_statements','p_and_l','tax_returns','balance_sheet')
              or public.pursue_cim_material_filename_kind_p7b(
                coalesce(document.original_name, document.file_name, '')) <> ''
            ))
        or exists (select 1 from (
            select candidate.* from public.secure_upload_requests candidate
            where candidate.submission_id::text = v_campaign.crm_submission_id::text
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
        or pg_catalog.replace(public.pursue_cim_material_token_p7b(
          v_submission.metadata #>> '{diligence,stage}'), '_', '-')
          in ('cim-received','financial-review','lender-review','loi-candidate')
        or pg_catalog.replace(public.pursue_cim_material_token_p7b(
          v_submission.metadata #>> '{acquisitionCommand,pipelineStage}'), '_', '-')
          in ('docs-received','diligence','loi-candidate')
        or v_submission.metadata #> '{diligence,checklist,cim}' = 'true'::jsonb
        or v_submission.metadata #> '{diligence,checklist,p_and_l}' = 'true'::jsonb
        or v_submission.metadata #> '{diligence,checklist,tax_returns}' = 'true'::jsonb
        or v_submission.metadata #> '{diligence,checklist,balance_sheet}' = 'true'::jsonb
      ), false) then
        continue;
      end if;
      if pg_catalog.replace(public.pursue_cim_material_token_p7b(
          v_submission.metadata #>> '{diligence,stage}'), '_', '-')
          in ('financial-review','lender-review','loi-candidate')
        or pg_catalog.replace(public.pursue_cim_material_token_p7b(
          v_submission.metadata #>> '{acquisitionCommand,pipelineStage}'), '_', '-')
          in ('diligence','loi-candidate')
      then
        v_reason := 'advanced_beyond_broker_outreach';
      else
        v_reason := 'materials_received';
      end if;
    end if;
    v_next_state := case
      when v_reason = 'identity_ambiguous' then 'action-required'
      when v_reason in ('materials_received','advanced_beyond_broker_outreach')
        and v_campaign.state in ('initial-pending','active-follow-up','action-required',
          'provider-ambiguous')
        then 'materials-received'
      else 'stopped'
    end;
    v_event_id := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('terminal-writer-event:v1'::text),
      pg_catalog.to_jsonb(v_evidence_type), pg_catalog.to_jsonb(v_evidence_id),
      pg_catalog.to_jsonb(v_campaign.id), pg_catalog.to_jsonb(v_reason));
    v_metadata_digest := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('terminal-writer-metadata:v1'::text),
      pg_catalog.to_jsonb(v_evidence_type), pg_catalog.to_jsonb(v_evidence_id),
      pg_catalog.to_jsonb(v_reason), pg_catalog.to_jsonb(v_campaign.id));
    v_result := public.pursue_cim_append_terminal_event_v1(
      pg_catalog.jsonb_build_object('eventId', v_event_id, 'scope', 'campaign',
        'scopeId', v_campaign.id, 'expectedRevision', v_campaign.terminal_revision,
        'expectedRowVersion', v_campaign.row_version, 'nextState', v_next_state,
        'reasonCode', v_reason, 'evidenceType', v_evidence_type,
        'evidenceId', v_evidence_id, 'metadataDigest', v_metadata_digest,
        'actor', v_actor, 'source', v_source, 'observedAt', v_observed, 'now', v_now));
    if coalesce((v_result ->> 'conflict')::boolean, false) then
      raise exception 'Concurrent Pursue CIM terminal convergence';
    end if;
    v_outcomes := v_outcomes || pg_catalog.jsonb_build_array(v_result ||
      pg_catalog.jsonb_build_object('campaignId', v_campaign.id,
        'eventId', v_event_id, 'reasonCode', v_reason));
  end loop;
  return pg_catalog.jsonb_build_object('applied', exists (
    select 1 from pg_catalog.jsonb_array_elements(v_outcomes) item
      where coalesce((item ->> 'applied')::boolean, false)), 'outcomes', v_outcomes);
end;
$$;

revoke all on function public.pursue_cim_converge_terminal_authority_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_converge_terminal_authority_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_terminal_race_audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_race record;
begin
  if new.campaign_id is null then return new; end if;
  for v_race in
    select transmission.id as transmission_id, pg_catalog.min(touch.id) as touch_id,
      campaign.opportunity_id, campaign.conversation_id, campaign.state
    from public.deal_hunter_cim_campaign_touches touch
    join public.deal_hunter_cim_campaigns campaign on campaign.id = touch.campaign_id
    join public.deal_hunter_cim_transmission_touches member
      on member.touch_id = touch.id and member.cancelled_at is null
    join public.deal_hunter_cim_transmissions transmission
      on transmission.id = member.transmission_id
    where touch.campaign_id = new.campaign_id and touch.state = 'provider-pending'
      and transmission.state = 'provider-pending'
    group by transmission.id, campaign.opportunity_id, campaign.conversation_id,
      campaign.state
    order by transmission.id
  loop
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
       transmission_id, prior_state, next_state, reason_code, actor, source,
       occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('terminal-in-flight-race'::text),
        pg_catalog.to_jsonb(new.id || ':' || new.campaign_id || ':' || v_race.transmission_id)),
      'terminal-in-flight-race', v_race.opportunity_id, new.campaign_id,
      v_race.conversation_id, v_race.touch_id, v_race.transmission_id,
      'provider-pending', v_race.state, new.reason_code, new.actor, new.source,
      new.created_at, '{}'::jsonb)
    on conflict (id) do nothing;
  end loop;
  return new;
end;
$$;

revoke all on function public.pursue_cim_terminal_race_audit_trigger()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_pursue_cim_terminal_race_audit
  on public.deal_hunter_cim_terminal_events;
create trigger trg_pursue_cim_terminal_race_audit
after insert on public.deal_hunter_cim_terminal_events
for each row execute function public.pursue_cim_terminal_race_audit_trigger();

create or replace function public.pursue_cim_terminal_gate_lock_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  return null;
end;
$$;

revoke all on function public.pursue_cim_terminal_gate_lock_trigger()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_0000_pursue_cim_terminal_lock on public.contact_submissions;
create trigger trg_0000_pursue_cim_terminal_lock
before update of status, archived_at, prospectus_url, metadata on public.contact_submissions
for each statement execute function public.pursue_cim_terminal_gate_lock_trigger();

drop trigger if exists trg_0000_pursue_cim_terminal_lock on public.secure_documents;
create trigger trg_0000_pursue_cim_terminal_lock
before insert on public.secure_documents
for each statement execute function public.pursue_cim_terminal_gate_lock_trigger();

drop trigger if exists trg_0000_pursue_cim_terminal_lock on public.secure_upload_requests;
create trigger trg_0000_pursue_cim_terminal_lock
before insert or update of status, last_uploaded_at, requested_documents
on public.secure_upload_requests
for each statement execute function public.pursue_cim_terminal_gate_lock_trigger();

drop trigger if exists trg_0000_pursue_cim_terminal_lock on public.crm_communications;
create trigger trg_0000_pursue_cim_terminal_lock
before insert or update of delivery_state, delivery_state_at on public.crm_communications
for each statement execute function public.pursue_cim_terminal_gate_lock_trigger();

drop trigger if exists trg_0000_pursue_cim_terminal_lock on public.email_suppressions;
create trigger trg_0000_pursue_cim_terminal_lock
before insert or update of lifted_at, reason on public.email_suppressions
for each statement execute function public.pursue_cim_terminal_gate_lock_trigger();

drop trigger if exists trg_0000_pursue_cim_terminal_lock on public.deal_hunter_identity_exceptions;
create trigger trg_0000_pursue_cim_terminal_lock
before insert or update of status, candidate_opportunity_ids
on public.deal_hunter_identity_exceptions
for each statement execute function public.pursue_cim_terminal_gate_lock_trigger();

drop trigger if exists trg_0000_pursue_cim_terminal_lock on public.crm_submission_supersessions;
create trigger trg_0000_pursue_cim_terminal_lock
before insert on public.crm_submission_supersessions
for each statement execute function public.pursue_cim_terminal_gate_lock_trigger();

drop trigger if exists trg_0000_pursue_cim_terminal_lock on public.deal_hunter_owner_decision_events;
create trigger trg_0000_pursue_cim_terminal_lock
before insert on public.deal_hunter_owner_decision_events
for each statement execute function public.pursue_cim_terminal_gate_lock_trigger();

create or replace function public.pursue_cim_terminal_writer_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_candidate text;
  v_command jsonb;
begin
  if TG_TABLE_NAME = 'contact_submissions' then
    v_now := coalesce(new.updated_at, new.created_at, pg_catalog.clock_timestamp());
    v_command := pg_catalog.jsonb_build_object('submissionId', new.id::text,
      'evidenceId', new.id::text || ':' || v_now::text, 'actor',
      coalesce(new.archived_by, 'crm-writer'), 'source', 'postgres-terminal-trigger',
      'observedAt', v_now, 'now', v_now);
    if (new.archived_at is not null or pg_catalog.lower(coalesce(new.status, '')) = 'archived')
      and (old.archived_at is null and pg_catalog.lower(coalesce(old.status, '')) <> 'archived')
    then
      perform public.pursue_cim_converge_terminal_authority_v1(v_command ||
        pg_catalog.jsonb_build_object('reasonCode', 'crm_archived',
          'evidenceType', 'crm-archive'));
    else
      perform public.pursue_cim_converge_terminal_authority_v1(v_command ||
        pg_catalog.jsonb_build_object('evaluateMaterialsState', true,
          'evidenceType', 'diligence'));
    end if;
  elsif TG_TABLE_NAME = 'secure_documents' then
    v_now := coalesce(new.created_at, pg_catalog.clock_timestamp());
    perform public.pursue_cim_converge_terminal_authority_v1(
      pg_catalog.jsonb_build_object('submissionId', new.submission_id::text,
        'evaluateMaterialsState', true, 'evidenceType', 'materials',
        'evidenceId', new.id::text, 'actor', 'secure-document-writer',
        'source', 'postgres-terminal-trigger', 'observedAt', v_now, 'now', v_now));
  elsif TG_TABLE_NAME = 'secure_upload_requests' then
    v_now := coalesce(new.updated_at, new.created_at, pg_catalog.clock_timestamp());
    perform public.pursue_cim_converge_terminal_authority_v1(
      pg_catalog.jsonb_build_object('submissionId', new.submission_id::text,
        'evaluateMaterialsState', true, 'evidenceType', 'materials',
        'evidenceId', new.id::text, 'actor', 'secure-upload-writer',
        'source', 'postgres-terminal-trigger', 'observedAt', v_now, 'now', v_now));
  elsif TG_TABLE_NAME = 'crm_communications' then
    v_now := coalesce(new.delivery_state_at, new.updated_at, new.occurred_at,
      pg_catalog.clock_timestamp());
    if new.updated_by = 'email-webhook'
      and new.delivery_state in ('failed','bounced','complained','suppressed')
      and (TG_OP = 'INSERT' or old.delivery_state is distinct from new.delivery_state
        or old.delivery_state_at is distinct from new.delivery_state_at)
    then
      perform public.pursue_cim_converge_terminal_authority_v1(
        pg_catalog.jsonb_build_object('communicationId', new.id,
          'reasonCode', 'unsafe_delivery', 'evidenceType', 'delivery-lifecycle',
          'evidenceId', coalesce(new.source_event_id, new.id || ':' || v_now::text),
          'actor', coalesce(new.updated_by, 'email-webhook'),
          'source', 'postgres-terminal-trigger', 'observedAt', v_now, 'now', v_now));
    end if;
  elsif TG_TABLE_NAME = 'email_suppressions' then
    v_now := coalesce(new.created_at, pg_catalog.clock_timestamp());
    if new.lifted_at is null then
      perform public.pursue_cim_converge_terminal_authority_v1(
        pg_catalog.jsonb_build_object('recipientEmail', new.normalized_email,
          'reasonCode', 'recipient_suppressed', 'evidenceType', 'email-suppression',
          'evidenceId', new.id::text, 'actor', coalesce(new.created_by, 'suppression-writer'),
          'source', 'postgres-terminal-trigger', 'observedAt', v_now, 'now', v_now));
    end if;
  elsif TG_TABLE_NAME = 'deal_hunter_identity_exceptions' then
    v_now := coalesce(new.updated_at, new.created_at, pg_catalog.clock_timestamp());
    if new.status = 'open' then
      for v_candidate in select value from pg_catalog.jsonb_array_elements_text(
        coalesce(new.candidate_opportunity_ids, '[]'::jsonb))
      loop
        perform public.pursue_cim_converge_terminal_authority_v1(
          pg_catalog.jsonb_build_object('opportunityId', v_candidate,
            'reasonCode', 'identity_ambiguous', 'evidenceType', 'identity-exception',
            'evidenceId', new.id::text, 'actor', 'identity-authority',
            'source', 'postgres-terminal-trigger', 'observedAt', v_now, 'now', v_now));
      end loop;
    end if;
  elsif TG_TABLE_NAME = 'crm_submission_supersessions' then
    v_now := coalesce(new.updated_at, new.created_at, pg_catalog.clock_timestamp());
    if new.status = 'active' then
      perform public.pursue_cim_converge_terminal_authority_v1(
        pg_catalog.jsonb_build_object('submissionId', new.superseded_submission_id::text,
          'reasonCode', 'crm_superseded', 'evidenceType', 'crm-supersession',
          'evidenceId', new.id::text, 'actor', coalesce(new.actor, 'crm-supersession'),
          'source', 'postgres-terminal-trigger', 'observedAt', v_now, 'now', v_now));
    end if;
  elsif TG_TABLE_NAME = 'deal_hunter_owner_decision_events' then
    v_now := coalesce(new.created_at, pg_catalog.clock_timestamp());
    if new.action in ('watch','pass') then
      perform public.pursue_cim_converge_terminal_authority_v1(
        pg_catalog.jsonb_build_object('opportunityId', new.opportunity_id,
          'reasonCode', new.action || '-selected', 'evidenceType', 'owner-decision',
          'evidenceId', new.id, 'actor', new.actor, 'source', 'owner-decision-transaction',
          'observedAt', new.created_at, 'now', new.created_at));
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.pursue_cim_terminal_writer_trigger()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_000_pursue_cim_terminal_submission on public.contact_submissions;
create trigger trg_000_pursue_cim_terminal_submission
after update of status, archived_at, prospectus_url, metadata on public.contact_submissions
for each row execute function public.pursue_cim_terminal_writer_trigger();

drop trigger if exists trg_000_pursue_cim_terminal_document on public.secure_documents;
create trigger trg_000_pursue_cim_terminal_document
after insert on public.secure_documents
for each row execute function public.pursue_cim_terminal_writer_trigger();

drop trigger if exists trg_000_pursue_cim_terminal_upload on public.secure_upload_requests;
create trigger trg_000_pursue_cim_terminal_upload
after insert or update of status, last_uploaded_at, requested_documents
on public.secure_upload_requests
for each row execute function public.pursue_cim_terminal_writer_trigger();

drop trigger if exists trg_000_pursue_cim_terminal_communication on public.crm_communications;
create trigger trg_000_pursue_cim_terminal_communication
after insert or update of delivery_state, delivery_state_at on public.crm_communications
for each row execute function public.pursue_cim_terminal_writer_trigger();

drop trigger if exists trg_000_pursue_cim_terminal_suppression on public.email_suppressions;
create trigger trg_000_pursue_cim_terminal_suppression
after insert or update of lifted_at, reason on public.email_suppressions
for each row execute function public.pursue_cim_terminal_writer_trigger();

drop trigger if exists trg_000_pursue_cim_terminal_identity on public.deal_hunter_identity_exceptions;
create trigger trg_000_pursue_cim_terminal_identity
after insert or update of status, candidate_opportunity_ids
on public.deal_hunter_identity_exceptions
for each row execute function public.pursue_cim_terminal_writer_trigger();

drop trigger if exists trg_000_pursue_cim_terminal_supersession on public.crm_submission_supersessions;
create trigger trg_000_pursue_cim_terminal_supersession
after insert on public.crm_submission_supersessions
for each row execute function public.pursue_cim_terminal_writer_trigger();

drop trigger if exists trg_000_pursue_cim_terminal_owner_decision on public.deal_hunter_owner_decision_events;
create trigger trg_000_pursue_cim_terminal_owner_decision
after insert on public.deal_hunter_owner_decision_events
for each row execute function public.pursue_cim_terminal_writer_trigger();

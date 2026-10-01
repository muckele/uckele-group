-- Package 6C correction: close the durable policy-tuple gate for permission and batching versions.
create or replace function public.pursue_cim_authorize_provider_pending_v1(p_command jsonb)
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
      if coalesce((v_expected_member #>> '{materialsAuthority,materialsReceived}')::boolean, false)
        or coalesce((v_expected_member #>> '{materialsAuthority,advancedBeyondBrokerOutreach}')::boolean, false)
        or exists (select 1 from public.secure_documents x
          where x.submission_id = v_member.crm_submission_id)
        or exists (select 1 from public.secure_upload_requests x
          where x.submission_id = v_member.crm_submission_id
            and (x.last_uploaded_at is not null or x.status in ('completed','closed')))
        or exists (select 1 from public.contact_submissions x where x.id = v_member.crm_submission_id
          and nullif(pg_catalog.btrim(x.prospectus_url), '') is not null)
        or pg_catalog.replace(pg_catalog.lower(coalesce(
          v_member.submission_metadata #>> '{diligence,stage}', '')), '_', '-')
          in ('cim-received', 'financial-review', 'lender-review', 'loi-candidate')
        or pg_catalog.replace(pg_catalog.lower(coalesce(
          v_member.submission_metadata #>> '{acquisitionCommand,pipelineStage}', '')), '_', '-')
          in ('docs-received', 'diligence', 'loi-candidate')
        or v_member.submission_metadata #> '{diligence,checklist,cim}' = 'true'::jsonb
        or v_member.submission_metadata #> '{diligence,checklist,p_and_l}' = 'true'::jsonb
        or v_member.submission_metadata #> '{diligence,checklist,tax_returns}' = 'true'::jsonb
        or v_member.submission_metadata #> '{diligence,checklist,balance_sheet}' = 'true'::jsonb
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

revoke all on function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  to service_role;

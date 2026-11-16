-- Start a new campaign after a stop before any email (autopilot spec 7.2.4 and 17.1).
-- A campaign the owner stopped before any of its email reached Google may be followed by a
-- new generation, and only through the explicit command below. The send path stops refusing
-- every generation after 1; instead it refuses any generation whose earlier generations got
-- email as far as Google, keeping one inquiry per listing (contact rule section 7).
-- Forward-only and re-runnable.

alter table public.deal_hunter_pursuit_enrollments
  add column if not exists restart_of_campaign_id text
    check (restart_of_campaign_id is null or char_length(restart_of_campaign_id) between 1 and 240);

-- True when any email of this campaign got as far as Google: a touch past the pre-provider
-- states, or a transmission past preparation or into the provider seam.
create or replace function public.pursue_cim_campaign_reached_provider_v1(p_campaign_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.deal_hunter_cim_campaign_touches as touch
      where touch.campaign_id = p_campaign_id
        and touch.state not in ('scheduled', 'claimed', 'cancelled-before-provider'))
    or exists (select 1 from public.deal_hunter_cim_transmission_touches as member
      join public.deal_hunter_cim_transmissions as transmission
        on transmission.id = member.transmission_id
      where member.campaign_id = p_campaign_id
        and (transmission.state not in ('prepared', 'final-gate-blocked', 'cancelled-before-provider')
          or transmission.provider_seam_entered_at is not null));
$$;

-- True when no campaign of this listing, of any generation, got email as far as Google.
create or replace function public.pursue_cim_any_campaign_reached_provider_v1(p_opportunity_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.deal_hunter_cim_campaigns as listed
    where listed.opportunity_id = p_opportunity_id
      and public.pursue_cim_campaign_reached_provider_v1(listed.id));
$$;

-- True when this campaign's generation may carry email: generation 1, or a later one whose
-- earlier generations of the same listing never got email as far as Google.
create or replace function public.pursue_cim_campaign_generation_may_send_v1(p_campaign_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select campaign.generation >= 1 and not exists (
      select 1 from public.deal_hunter_cim_campaigns as prior
      where prior.opportunity_id = campaign.opportunity_id
        and prior.generation < campaign.generation
        and public.pursue_cim_campaign_reached_provider_v1(prior.id))
    from public.deal_hunter_cim_campaigns as campaign
    where campaign.id = p_campaign_id), false);
$$;

revoke all on function public.pursue_cim_campaign_reached_provider_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function public.pursue_cim_any_campaign_reached_provider_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function public.pursue_cim_campaign_generation_may_send_v1(text)
  from public, anon, authenticated, service_role;

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
  v_restarting boolean := false;
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
    -- A new generation is allocated only for an enrollment the owner's Start a new campaign
    -- command bound to this exact stopped campaign; a plain Pursue never restarts one.
    select * into v_enrollment from public.deal_hunter_pursuit_enrollments
      where id = v_enrollment_id and opportunity_id = v_opportunity_id;
    v_restarting := v_enrollment.restart_of_campaign_id is not null
      and v_enrollment.restart_of_campaign_id = v_current.id
      and v_current.state = 'stopped'
      and v_current.reason_code in ('campaign_stopped', 'watch-selected', 'pass-selected')
      and v_generation = v_current.generation + 1;
  end if;
  if v_current.id is not null and not v_restarting then
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
  if v_generation <> (case when v_restarting then v_current.generation + 1 else 1 end)
    or (v_restarting and public.pursue_cim_any_campaign_reached_provider_v1(v_opportunity_id)) then
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

create or replace function public.pursue_cim_prepare_transmission_p7a(p_command jsonb)
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
          or not public.pursue_cim_campaign_generation_may_send_v1(v_campaign.id)
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
        or not public.pursue_cim_campaign_generation_may_send_v1(v_campaign.id)
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
        or not public.pursue_cim_campaign_generation_may_send_v1(v_member.campaign_id)
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
      or not public.pursue_cim_campaign_generation_may_send_v1(v_campaign.id)
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
        and public.pursue_cim_campaign_generation_may_send_v1(c.id) and c.policy_version = 'deal-hunter-cim-autopilot-v1'
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
    and v_campaign.state = 'initial-pending' and public.pursue_cim_campaign_generation_may_send_v1(v_campaign.id)
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

-- The owner's Start a new campaign command: a new Pursue decision and an enrollment bound to
-- the exact stopped campaign it follows. Refused unless that campaign is the latest, the owner
-- stopped it, and no email of any generation of this listing reached Google.
create or replace function public.pursue_cim_start_new_campaign_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_campaign_id text := p_command ->> 'campaignId';
  v_key text := p_command ->> 'idempotencyKey';
  v_actor text := p_command ->> 'actor';
  v_policy text := p_command ->> 'policyVersion';
  v_row_version bigint;
  v_discovery bigint;
  v_material bigint;
  v_now timestamptz;
  v_request_digest text;
  v_decision_id text;
  v_enrollment_id text;
  v_existing public.deal_hunter_owner_decision_events%rowtype;
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
  v_latest public.deal_hunter_cim_campaigns%rowtype;
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
    or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
    or v_campaign_id is null or pg_catalog.length(v_campaign_id) not between 1 and 240
    or pg_catalog.btrim(v_campaign_id) <> v_campaign_id
    or v_key is null or pg_catalog.length(v_key) not between 1 and 240
    or pg_catalog.btrim(v_key) <> v_key
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or v_policy is null or pg_catalog.length(v_policy) not between 1 and 120
    or pg_catalog.btrim(v_policy) <> v_policy
  then
    raise exception 'Invalid Pursue CIM new campaign command';
  end if;
  v_row_version := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_discovery := public.pursue_cim_required_revision_v1(p_command, 'expectedDiscoveryRevision');
  v_material := public.pursue_cim_required_revision_v1(p_command, 'expectedMaterialRevision');
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_request_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('campaign-restart-request:v1'::text), pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_campaign_id), pg_catalog.to_jsonb(v_row_version),
    pg_catalog.to_jsonb(v_discovery), pg_catalog.to_jsonb(v_material),
    pg_catalog.to_jsonb(v_actor), pg_catalog.to_jsonb(v_policy), pg_catalog.to_jsonb(v_key));
  -- The same lock owner decisions take, so a Watch or Pursue cannot interleave.
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:owner-key:' || v_key, 0));
  select * into v_existing from public.deal_hunter_owner_decision_events
    where idempotency_key = v_key;
  if found then
    select * into v_enrollment from public.deal_hunter_pursuit_enrollments
      where decision_event_id = v_existing.id;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'replay', v_existing.request_digest = v_request_digest,
      'conflict', v_existing.request_digest <> v_request_digest,
      'reason', case when v_existing.request_digest = v_request_digest then null
        else 'idempotency_conflict' end,
      'decision', pg_catalog.to_jsonb(v_existing),
      'enrollment', case when found then pg_catalog.to_jsonb(v_enrollment) else null end);
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  if not found or v_opportunity.status <> 'active'
    or v_opportunity.discovery_revision <> v_discovery
    or v_opportunity.material_revision <> v_material then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'reason', 'stale_revision', 'decision', null, 'enrollment', null);
  end if;
  select * into v_score from public.deal_hunter_opportunity_scores
    where opportunity_id = v_opportunity_id and current_triage_eligible = true
      and should_remove = false for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'reason', 'not-actionable', 'decision', null, 'enrollment', null);
  end if;
  if v_score.deal_key is not null and exists (select 1 from public.deal_hunter_dispositions
      where deal_key = v_score.deal_key and disposition = 'dismissed') then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'reason', 'already-passed', 'decision', null, 'enrollment', null);
  end if;
  select * into v_latest from public.deal_hunter_cim_campaigns
    where opportunity_id = v_opportunity_id order by generation desc limit 1 for update;
  if not found or v_latest.id <> v_campaign_id or v_latest.row_version <> v_row_version then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'reason', 'campaign_changed', 'decision', null, 'enrollment', null);
  end if;
  if v_latest.state <> 'stopped'
    or v_latest.reason_code is null
    or v_latest.reason_code not in ('campaign_stopped', 'watch-selected', 'pass-selected') then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'reason', 'campaign_not_restartable', 'decision', null, 'enrollment', null);
  end if;
  if public.pursue_cim_any_campaign_reached_provider_v1(v_opportunity_id) then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'reason', 'campaign_emailed', 'decision', null, 'enrollment', null);
  end if;
  if exists (select 1 from public.deal_hunter_cim_requests as request
      where request.opportunity_id = v_opportunity_id
        or request.deal_key in (select score.deal_key from public.deal_hunter_opportunity_scores as score
          where score.opportunity_id = v_opportunity_id))
    or exists (select 1 from public.deal_hunter_cim_opportunity_claims
      where opportunity_id = v_opportunity_id) then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false, 'conflict', true,
      'reason', 'prior_outreach', 'decision', null, 'enrollment', null);
  end if;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where opportunity_id = v_opportunity_id and state <> 'superseded' for update;
  if found then
    update public.deal_hunter_pursuit_enrollments
      set state = 'superseded', reason_code = 'campaign-restarted',
        row_version = row_version + 1, updated_at = v_now
      where id = v_enrollment.id and row_version = v_enrollment.row_version;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, prior_state, next_state,
       reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('enrollment-transition'::text),
        pg_catalog.to_jsonb(v_enrollment.id || ':' || (v_enrollment.row_version + 1)::text)),
      'enrollment-transition', v_opportunity_id, v_enrollment.state, 'superseded',
      'campaign-restarted', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  end if;
  v_decision_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision:v1'::text), pg_catalog.to_jsonb(v_key));
  v_enrollment_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('pursuit-enrollment:v1'::text), pg_catalog.to_jsonb(v_decision_id));
  insert into public.deal_hunter_owner_decision_events
    (id, idempotency_key, request_digest, opportunity_id, action, actor,
     expected_discovery_revision, expected_material_revision,
     observed_discovery_revision, observed_material_revision,
     selected_contact_reference_digest, policy_version, created_at)
  values (v_decision_id, v_key, v_request_digest, v_opportunity_id, 'pursue', v_actor,
    v_discovery, v_material, v_opportunity.discovery_revision,
    v_opportunity.material_revision, null, v_policy, v_now)
  returning * into v_decision;
  insert into public.deal_hunter_pursuit_enrollments
    (id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
     restart_of_campaign_id, created_at, updated_at)
  values (v_enrollment_id, v_decision_id, v_opportunity_id, 'queued',
    'awaiting-orchestration', public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('enrollment-authority:v1'::text),
      pg_catalog.to_jsonb(v_decision_id),
      pg_catalog.to_jsonb(v_opportunity.discovery_revision),
      pg_catalog.to_jsonb(v_opportunity.material_revision)), v_campaign_id, v_now, v_now)
  returning * into v_enrollment;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, next_state, reason_code, authority_digest,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('owner-decision'::text),
      pg_catalog.to_jsonb(v_decision_id)),
    'owner-decision', v_opportunity_id, v_campaign_id, 'pursue', 'campaign-restart',
    v_request_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  update public.deal_hunter_opportunity_scores set operator_priority = 'high',
    reviewed_at = v_now, reviewed_by = v_actor,
    reviewed_fingerprint = score_fingerprint,
    reviewed_semantic_digest = semantic_digest,
    reviewed_discovery_revision = v_discovery,
    reviewed_material_revision = v_material, operator_updated_at = v_now
    where opportunity_id = v_opportunity_id;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false, 'conflict', false,
    'reason', null, 'decision', pg_catalog.to_jsonb(v_decision),
    'enrollment', pg_catalog.to_jsonb(v_enrollment));
end;
$$;
revoke all on function public.pursue_cim_start_new_campaign_v1(jsonb) from public, anon, authenticated;
grant execute on function public.pursue_cim_start_new_campaign_v1(jsonb) to service_role;

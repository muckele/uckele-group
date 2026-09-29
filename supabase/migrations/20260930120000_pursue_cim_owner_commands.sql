-- Package 4A upgrades the existing owner-decision RPC atomically.
create or replace function public.pursue_cim_record_owner_decision_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_action text := p_command ->> 'action';
  v_key text := p_command ->> 'idempotencyKey';
  v_actor text := p_command ->> 'actor';
  v_policy text := p_command ->> 'policyVersion';
  v_contact_digest text := p_command ->> 'selectedContactReferenceDigest';
  v_reason text := p_command ->> 'reason';
  v_note text := coalesce(p_command ->> 'note', '');
  v_submission_id text := coalesce(p_command ->> 'submissionId', '');
  v_now timestamptz;
  v_discovery bigint;
  v_material bigint;
  v_request_digest text;
  v_decision_id text;
  v_enrollment_id text;
  v_existing public.deal_hunter_owner_decision_events%rowtype;
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_terminal_id text;
  v_disposition_hash text;
  v_disposition_id uuid;
  v_archive_id uuid;
  v_triage_id uuid;
  v_pass_result jsonb;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['opportunityId','action','idempotencyKey','actor','policyVersion','now'],
    array['expectedDiscoveryRevision','expectedMaterialRevision'],
    array['selectedContactReferenceDigest','reason','note','submissionId']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
    or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
    or v_action not in ('pursue','watch','pass')
    or v_key is null or pg_catalog.length(v_key) not between 1 and 240
    or pg_catalog.btrim(v_key) <> v_key
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or v_policy is null or pg_catalog.length(v_policy) not between 1 and 120
    or pg_catalog.btrim(v_policy) <> v_policy
    or (v_contact_digest is not null and v_contact_digest !~ '^[0-9a-f]{64}$')
    or (v_action = 'pass' and (v_reason is null
      or pg_catalog.length(v_reason) not between 1 and 160
      or pg_catalog.btrim(v_reason) <> v_reason))
    or pg_catalog.length(v_note) > 2000
    or pg_catalog.length(v_submission_id) > 120
    or pg_catalog.btrim(v_submission_id) <> v_submission_id
    or p_command ->> 'expectedDiscoveryRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'expectedMaterialRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM owner decision command';
  end if;
  v_discovery := (p_command ->> 'expectedDiscoveryRevision')::bigint;
  v_material := (p_command ->> 'expectedMaterialRevision')::bigint;
  if v_discovery > 9007199254740991 or v_material > 9007199254740991 then
    raise exception 'Unsafe Pursue CIM owner revision';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  if v_action <> 'pass' then
    v_reason := null;
    v_note := '';
    v_submission_id := '';
  end if;
  v_request_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision-request:v1'::text),
    pg_catalog.to_jsonb(v_action), pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_discovery), pg_catalog.to_jsonb(v_material),
    coalesce(pg_catalog.to_jsonb(v_contact_digest), 'null'::jsonb),
    pg_catalog.to_jsonb(v_actor), pg_catalog.to_jsonb(v_policy),
    coalesce(pg_catalog.to_jsonb(v_reason), 'null'::jsonb),
    pg_catalog.to_jsonb(v_note), pg_catalog.to_jsonb(v_submission_id),
    pg_catalog.to_jsonb(v_key));
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
      'decision', pg_catalog.to_jsonb(v_existing),
      'enrollment', case when found then pg_catalog.to_jsonb(v_enrollment) else null end);
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  if not found or v_opportunity.status <> 'active'
    or v_opportunity.discovery_revision <> v_discovery
    or v_opportunity.material_revision <> v_material
  then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'reason', 'stale_revision', 'decision', null, 'enrollment', null);
  end if;
  select * into v_score from public.deal_hunter_opportunity_scores
    where opportunity_id = v_opportunity_id and current_triage_eligible = true
      and should_remove = false for update;
  if v_action <> 'pursue' then
    if v_score.opportunity_id is null or (v_action = 'pass' and v_score.deal_key is null) then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'decision', null, 'enrollment', null);
    end if;
  end if;
  if v_score.deal_key is not null and exists (
    select 1 from public.deal_hunter_dispositions
    where deal_key = v_score.deal_key and disposition = 'dismissed'
  ) then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'reason', 'already-passed', 'decision', null, 'enrollment', null);
  end if;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where opportunity_id = v_opportunity_id and state <> 'superseded' for update;
  if found and v_action = 'pursue' then
    select * into v_decision from public.deal_hunter_owner_decision_events
      where id = v_enrollment.decision_event_id;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
      'enrollment', pg_catalog.to_jsonb(v_enrollment));
  end if;
  v_decision_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision:v1'::text), pg_catalog.to_jsonb(v_key));
  v_enrollment_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('pursuit-enrollment:v1'::text), pg_catalog.to_jsonb(v_decision_id));
  if v_action = 'pass' then
    if v_submission_id <> '' then
      raise exception 'Explicit Pass submission context requires verified supersession authority';
    end if;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-disposition:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_disposition_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-archive:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_archive_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-triage:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_triage_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_pass_result := public.pass_deal_hunter_opportunity_freshness_v1(
      pg_catalog.jsonb_build_object('opportunity_id', v_opportunity_id,
        'reason', v_reason, 'note', v_note, 'actor', v_actor, 'occurred_at', v_now,
        'disposition_id', v_disposition_id, 'archive_activity_id', v_archive_id,
        'triage_activity_id', v_triage_id), v_discovery, v_material);
    if v_pass_result ->> 'applied' <> 'true' then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'reason', v_pass_result ->> 'reason',
        'decision', null, 'enrollment', null);
    end if;
  end if;
  insert into public.deal_hunter_owner_decision_events
    (id, idempotency_key, request_digest, opportunity_id, action, actor,
     expected_discovery_revision, expected_material_revision,
     observed_discovery_revision, observed_material_revision,
     selected_contact_reference_digest, policy_version, created_at)
  values (v_decision_id, v_key, v_request_digest, v_opportunity_id, v_action, v_actor,
    v_discovery, v_material, v_opportunity.discovery_revision,
    v_opportunity.material_revision, v_contact_digest, v_policy, v_now)
  returning * into v_decision;

  if v_action <> 'pursue' then
    if v_enrollment.id is not null then
      update public.deal_hunter_pursuit_enrollments
        set state = 'superseded', reason_code = v_action || '-selected',
          row_version = row_version + 1, updated_at = v_now
        where id = v_enrollment.id and state <> 'superseded';
    end if;
    for v_campaign in
      select * from public.deal_hunter_cim_campaigns
      where opportunity_id = v_opportunity_id
        and state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')
      order by id for update
    loop
      for v_transmission in
        select tr.* from public.deal_hunter_cim_transmissions as tr
        where tr.id in (
          select m.transmission_id from public.deal_hunter_cim_transmission_touches as m
          where m.campaign_id = v_campaign.id and m.cancelled_at is null)
          and tr.state in ('prepared','final-gate-blocked')
        order by tr.id for update
      loop
        perform public.pursue_cim_cancel_prepared_transmission_v1(
          v_transmission.id, v_now, v_action || '-selected', v_actor, false);
      end loop;
      for v_touch in
        select * from public.deal_hunter_cim_campaign_touches
        where campaign_id = v_campaign.id and state in ('scheduled','claimed')
          and transmission_id is null order by id for update
      loop
        update public.deal_hunter_cim_campaign_touches
          set state = 'cancelled-before-provider', terminal_reason = v_action || '-selected',
            row_version = row_version + 1, updated_at = v_now
          where id = v_touch.id and row_version = v_touch.row_version;
        insert into public.deal_hunter_cim_audit_events
          (id, event_type, opportunity_id, campaign_id, touch_id, prior_state,
           next_state, reason_code, actor, source, occurred_at, metadata)
        values (public.pursue_cim_digest_v1(
            pg_catalog.to_jsonb('cim-audit:v1'::text),
            pg_catalog.to_jsonb('touch-cancelled'::text),
            pg_catalog.to_jsonb(v_touch.id || ':' || (v_touch.row_version + 1)::text)),
          'touch-cancelled', v_opportunity_id, v_campaign.id, v_touch.id, v_touch.state,
          'cancelled-before-provider', v_action || '-selected', v_actor,
          'sqlite-transition', v_now, '{}'::jsonb);
      end loop;
      update public.deal_hunter_cim_campaigns
        set state = 'stopped', reason_code = v_action || '-selected',
          terminal_revision = terminal_revision + 1, row_version = row_version + 1,
          updated_at = v_now
        where id = v_campaign.id and row_version = v_campaign.row_version;
      v_terminal_id := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('owner-terminal:v1'::text),
        pg_catalog.to_jsonb(v_decision_id), pg_catalog.to_jsonb(v_campaign.id));
      insert into public.deal_hunter_cim_terminal_events
        (id, scope, scope_id, campaign_id, revision, reason_code,
         evidence_type, evidence_id, observed_at, actor, source, metadata_digest, created_at)
      values (v_terminal_id, 'campaign', v_campaign.id, v_campaign.id,
        v_campaign.terminal_revision + 1, v_action || '-selected',
        'owner-decision', v_decision_id, v_now, v_actor, 'sqlite-transition',
        v_request_digest, v_now);
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
         reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('terminal-transition'::text),
          pg_catalog.to_jsonb(v_terminal_id)),
        'terminal-transition', v_opportunity_id, v_campaign.id, v_campaign.state,
        'stopped', v_action || '-selected', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    end loop;
    if v_action = 'watch' then
    update public.deal_hunter_opportunity_scores
      set operator_priority = case when v_action = 'watch' then 'watch' else operator_priority end,
        reviewed_at = v_now, reviewed_by = v_actor,
        reviewed_fingerprint = score_fingerprint,
        reviewed_semantic_digest = semantic_digest,
        reviewed_discovery_revision = v_discovery,
        reviewed_material_revision = v_material, operator_updated_at = v_now
      where opportunity_id = v_opportunity_id;
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, next_state, authority_digest,
       actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('owner-decision'::text),
        pg_catalog.to_jsonb(v_decision_id)),
      'owner-decision', v_opportunity_id, v_action, v_request_digest,
      v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
      'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
      'enrollment', null, 'passResult', v_pass_result);
  end if;

  insert into public.deal_hunter_pursuit_enrollments
    (id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
     created_at, updated_at)
  values (v_enrollment_id, v_decision_id, v_opportunity_id, 'queued',
    'awaiting-orchestration', public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('enrollment-authority:v1'::text),
      pg_catalog.to_jsonb(v_decision_id),
      pg_catalog.to_jsonb(v_opportunity.discovery_revision),
      pg_catalog.to_jsonb(v_opportunity.material_revision)), v_now, v_now)
  returning * into v_enrollment;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, next_state, authority_digest,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('owner-decision'::text),
      pg_catalog.to_jsonb(v_decision_id)),
    'owner-decision', v_opportunity_id, v_action, v_request_digest,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  if v_score.opportunity_id is not null then
    update public.deal_hunter_opportunity_scores set operator_priority = 'high',
      reviewed_at = v_now, reviewed_by = v_actor,
      reviewed_fingerprint = score_fingerprint,
      reviewed_semantic_digest = semantic_digest,
      reviewed_discovery_revision = v_discovery,
      reviewed_material_revision = v_material, operator_updated_at = v_now
      where opportunity_id = v_opportunity_id;
  end if;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
    'enrollment', pg_catalog.to_jsonb(v_enrollment));
end;
$$;

revoke all on function public.pursue_cim_record_owner_decision_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_record_owner_decision_v1(jsonb)
  to service_role;

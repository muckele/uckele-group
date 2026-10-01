-- Package 9: bounded shadow operations and atomic automatic containment.
-- Both RPCs are service-role-only. The snapshot is read-only; containment
-- atomically preserves evidence, enables the global pause, and withdraws
-- unconsumed capability/provider authority.

create or replace function public.pursue_cim_read_operations_snapshot_v1(
  p_now timestamptz,
  p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_paused boolean;
  v_pause_source text;
  v_oldest timestamptz;
  v_result jsonb;
begin
  if p_now is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid Pursue CIM operations request';
  end if;
  v_limit := p_limit;

  select coalesce(s.outreach_paused, true),
    case when s.id is null then 'fail-closed-default' else 'operations-control' end
  into v_paused, v_pause_source
  from (select 1) seed
  left join public.deal_hunter_cim_safety_settings s on s.id = 'global';

  select min(updated_at) into v_oldest
  from public.deal_hunter_cim_transmissions
  where state in ('provider-pending','ambiguous');

  with
  counts as (
    select pg_catalog.jsonb_build_object(
      'ownerDecisions', (select count(*) from public.deal_hunter_owner_decision_events),
      'enrollments', (select count(*) from public.deal_hunter_pursuit_enrollments),
      'campaigns', (select count(*) from public.deal_hunter_cim_campaigns),
      'touches', (select count(*) from public.deal_hunter_cim_campaign_touches),
      'transmissions', (select count(*) from public.deal_hunter_cim_transmissions),
      'memberships', (select count(*) from public.deal_hunter_cim_transmission_touches),
      'crmOutbound', (select count(*) from public.crm_communications where direction='outbound'),
      'outbox', (select count(*) from public.crm_email_outbox),
      'providerAuthorizations', (select count(*) from public.deal_hunter_cim_live_provider_authorizations),
      'providerPending', (select count(*) from public.deal_hunter_cim_transmissions
        where state='provider-pending'),
      'providerSeamEntries', (select count(*) from public.deal_hunter_cim_transmissions
        where provider_seam_entered_at is not null)) value
  ),
  enrollment_states as (
    select coalesce(pg_catalog.jsonb_object_agg(state, n), '{}'::jsonb) value from (
      select state, count(*) n from public.deal_hunter_pursuit_enrollments group by state
      order by state limit 100) rows
  ),
  campaign_states as (
    select coalesce(pg_catalog.jsonb_object_agg(state, n), '{}'::jsonb) value from (
      select state, count(*) n from public.deal_hunter_cim_campaigns group by state
      order by state limit 100) rows
  ),
  touch_states as (
    select coalesce(pg_catalog.jsonb_object_agg(state, n), '{}'::jsonb) value from (
      select state, count(*) n from public.deal_hunter_cim_campaign_touches group by state
      order by state limit 100) rows
  ),
  transmission_states as (
    select coalesce(pg_catalog.jsonb_object_agg(state, n), '{}'::jsonb) value from (
      select state, count(*) n from public.deal_hunter_cim_transmissions group by state
      order by state limit 100) rows
  ),
  conversation_states as (
    select coalesce(pg_catalog.jsonb_object_agg(state, n), '{}'::jsonb) value from (
      select state, count(*) n from public.deal_hunter_broker_conversations group by state
      order by state limit 100) rows
  ),
  enrollment_reasons as (
    select coalesce(pg_catalog.jsonb_object_agg(reason, n), '{}'::jsonb) value from (
      select coalesce(reason_code,'unspecified') reason, count(*) n
      from public.deal_hunter_pursuit_enrollments group by coalesce(reason_code,'unspecified')
      order by reason limit 100) rows
  ),
  campaign_reasons as (
    select coalesce(pg_catalog.jsonb_object_agg(reason, n), '{}'::jsonb) value from (
      select coalesce(reason_code,'unspecified') reason, count(*) n
      from public.deal_hunter_cim_campaigns group by coalesce(reason_code,'unspecified')
      order by reason limit 100) rows
  ),
  touch_reasons as (
    select coalesce(pg_catalog.jsonb_object_agg(reason, n), '{}'::jsonb) value from (
      select coalesce(terminal_reason,'unspecified') reason, count(*) n
      from public.deal_hunter_cim_campaign_touches group by coalesce(terminal_reason,'unspecified')
      order by reason limit 100) rows
  ),
  gate_reasons as (
    select coalesce(pg_catalog.jsonb_object_agg(reason, n), '{}'::jsonb) value from (
      select coalesce(reason_code,'unspecified') reason, count(*) n
      from public.deal_hunter_cim_audit_events where event_type='final-gate-blocked'
      group by coalesce(reason_code,'unspecified') order by reason limit 100) rows
  ),
  activation_modes as (
    select coalesce(pg_catalog.jsonb_object_agg(mode, n), '{}'::jsonb) value from (
      select mode, count(*) n from public.deal_hunter_cim_capability_activations
      where status='current' group by mode order by mode limit 100) rows
  ),
  legacy_classes as (
    select coalesce(pg_catalog.jsonb_object_agg(classification, n), '{}'::jsonb) value from (
      select coalesce(delivery_state,'unspecified') classification, count(*) n
      from public.deal_hunter_cim_requests group by coalesce(delivery_state,'unspecified')
      order by classification limit 100) rows
  ),
  writer_paths as (
    select coalesce(pg_catalog.jsonb_object_agg(writer_path, n), '{}'::jsonb) value from (
      select 'accepted:' || a.writer_path writer_path, count(distinct e.id) n
      from public.deal_hunter_cim_audit_events e
      join public.deal_hunter_cim_live_provider_authorizations a
        on a.id=e.authorization_id
      where e.event_type='provider-seam-entered' group by a.writer_path
      union all
      select 'rejected:' || a.writer_path, count(distinct e.id)
      from public.deal_hunter_cim_audit_events e
      join public.deal_hunter_cim_live_provider_authorizations a
        on a.id=e.authorization_id
      where e.event_type='provider-boundary-rejected' group by a.writer_path
      order by writer_path limit 100) rows
  ),
  shadow_candidates as (
    select * from (
      select 'would-enroll'::text kind, id::text subject_id, state,
        reason_code, null::text payload_digest, created_at sort_at
      from public.deal_hunter_pursuit_enrollments
      where state in ('queued','waiting-on-eligibility')
      union all
      select 'would-claim', id, state, terminal_reason, null::text, due_at
      from public.deal_hunter_cim_campaign_touches
      where kind='initial' and state in ('scheduled','claimed') and due_at <= p_now
      union all
      select 'would-send', id, state, null::text, payload_digest, created_at
      from public.deal_hunter_cim_transmissions
      where state='prepared' and provider_seam_entered_at is null
    ) candidates order by sort_at, kind, subject_id limit v_limit
  ),
  shadow_evaluated as (
    select kind, subject_id, case
      when v_paused then 'central_outreach_pause'
      when kind='would-enroll'
        and public.pursue_cim_current_activation_v1('fl04b-enrollment',p_now) is null
        then 'capability_inactive'
      when kind='would-enroll' and state <> 'queued'
        then coalesce(reason_code,'enrollment_waiting')
      when kind in ('would-claim','would-send')
        and public.pursue_cim_current_activation_v1('fl04b-initial',p_now) is null
        then 'capability_inactive'
      when kind='would-claim' and state <> 'scheduled' then 'already_claimed'
      when kind='would-send' and not exists (
        select 1 from public.deal_hunter_cim_live_provider_authorizations a
        where a.transmission_id=subject_id
          and a.activation_id=public.pursue_cim_current_activation_v1('fl04b-initial',p_now)
          and a.capability='fl04b-initial' and a.payload_digest=shadow_candidates.payload_digest
          and a.maximum_calls=1 and a.consumed_at is null and a.withdrawn_at is null
          and a.expires_at > p_now) then 'exact_live_authorization_missing'
      when kind='would-send' then 'final_gate_readiness_unproven'
      else 'ready' end reason
    from shadow_candidates
  ),
  shadow_rows as (
    select kind, subject_id, reason='ready' eligible, reason
    from shadow_evaluated
  ),
  shadow as (
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'kind', kind, 'subjectId', subject_id, 'eligible', eligible, 'reason', reason)
      order by kind, subject_id), '[]'::jsonb) value from shadow_rows
  ),
  invariants as (
    select pg_catalog.jsonb_build_object(
      'duplicateProviderIdentities', (select count(*) from public.deal_hunter_cim_audit_events
        where event_type='provider-identity-conflict'),
      'missingDurableAuthority', (select count(*) from public.deal_hunter_cim_transmissions tr
        left join public.crm_communications c on c.id=tr.communication_id
        left join public.crm_email_outbox o on o.id=tr.outbox_id
        where tr.provider_seam_entered_at is not null and (
          c.id is null or o.id is null or tr.final_gate_authority_digest is null
          or not exists (select 1 from public.deal_hunter_cim_live_provider_authorizations a
            where a.transmission_id=tr.id and a.consumed_at is not null))),
      'multipleActiveCampaigns', (select count(*) from (
        select opportunity_id from public.deal_hunter_cim_campaigns
        where state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')
        group by opportunity_id having count(*) > 1) rows),
      'duplicateAcceptedTouches', (select count(*) from (
        select m.touch_id from public.deal_hunter_cim_transmission_touches m
        join public.deal_hunter_cim_transmissions tr on tr.id=m.transmission_id
        where tr.state='accepted' and m.cancelled_at is null
        group by m.touch_id having count(*) > 1) rows),
      'activeIdentityAmbiguities', (select count(distinct c.id)
        from public.deal_hunter_cim_campaigns c
        join public.deal_hunter_identity_exceptions e on e.status='open'
          and e.candidate_opportunity_ids ? c.opportunity_id
        where c.state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')),
      'unexpectedLegacyInvocations', (select count(*) from public.deal_hunter_cim_requests
        where last_attempt_at is not null and last_attempt_at >= (
          select min(created_at) from public.deal_hunter_cim_capability_activations
          where status='current' and mode not in ('off','shadow'))),
      'replyOrMaterialsBeforeGateProviderCalls', (select count(distinct tr.id)
        from public.deal_hunter_cim_transmissions tr
        join public.deal_hunter_cim_transmission_touches m on m.transmission_id=tr.id
        join public.deal_hunter_cim_audit_events provider_pending
          on provider_pending.transmission_id=tr.id
          and provider_pending.event_type='provider-pending'
        join public.deal_hunter_cim_terminal_events e
          on e.campaign_id=m.campaign_id or e.conversation_id=tr.conversation_id
        where tr.provider_seam_entered_at is not null
          and e.created_at <= provider_pending.occurred_at
          and e.reason_code in ('reply_received','materials_received',
            'advanced_beyond_broker_outreach')),
      'invalidClaimedTimezones', (select count(*) from public.deal_hunter_cim_campaign_touches t
        left join public.deal_hunter_opportunity_timezone_revisions z
          on z.opportunity_id=t.opportunity_id and z.revision=t.timezone_revision
        where t.state='claimed' and (z.opportunity_id is null
          or z.state not in ('verified','derived') or z.iana_timezone is null)),
      'expiredActivationAttempts', (select count(*) from public.deal_hunter_cim_audit_events
        where event_type='final-gate-blocked'
          and reason_code='capability_inactive'),
      'missingEnvelopeAttempts', (select count(*) from public.deal_hunter_cim_audit_events
        where event_type='final-gate-blocked'
          and reason_code in ('live_authorization_missing','live_authorization_invalid',
            'authorization_missing','authorization_expired')),
      'readinessLoss', (select count(*) from public.deal_hunter_cim_audit_events
        where event_type='final-gate-blocked'
          and reason_code='provider_readiness_unavailable'),
      'shadowProviderCalls', (select count(*) from public.deal_hunter_cim_audit_events
        where event_type='shadow-provider-call')) value
  )
  select pg_catalog.jsonb_build_object(
    'counts', counts.value,
    'stateCounts', pg_catalog.jsonb_build_object('enrollments', enrollment_states.value,
      'campaigns', campaign_states.value, 'touches', touch_states.value,
      'transmissions', transmission_states.value, 'conversations', conversation_states.value),
    'reasonCounts', pg_catalog.jsonb_build_object('enrollments', enrollment_reasons.value,
      'campaigns', campaign_reasons.value, 'touches', touch_reasons.value,
      'gateBlocks', gate_reasons.value),
    'providerPending', pg_catalog.jsonb_build_object(
      'count', (select count(*) from public.deal_hunter_cim_transmissions
        where state in ('provider-pending','ambiguous')),
      'oldestAt', coalesce(v_oldest::text,''),
      'oldestAgeSeconds', case when v_oldest is null then 0 else
        greatest(0::numeric,
          pg_catalog.floor(extract(epoch from (p_now-v_oldest))))::bigint end),
    'activations', pg_catalog.jsonb_build_object(
      'current', (select count(*) from public.deal_hunter_cim_capability_activations where status='current'),
      'expired', (select count(*) from public.deal_hunter_cim_capability_activations
        where status='current' and expires_at is not null and expires_at <= p_now),
      'nearestExpiryAt', coalesce((select min(expires_at)::text
        from public.deal_hunter_cim_capability_activations
        where status='current' and expires_at > p_now),''),
      'modes', activation_modes.value),
    'legacy', pg_catalog.jsonb_build_object(
      'total', (select count(*) from public.deal_hunter_cim_requests),
      'active', (select count(*) from public.deal_hunter_cim_requests
        where request_state in ('pending','ready')),
      'ambiguous', (select count(*) from public.deal_hunter_cim_requests
        where delivery_state in ('ambiguous','unknown')),
      'writerInvocations', (select count(*) from public.deal_hunter_cim_requests
        where last_attempt_at is not null),
      'classifications', legacy_classes.value),
    'boundary', pg_catalog.jsonb_build_object(
      'accepts', (select count(*) from public.deal_hunter_cim_audit_events
        where event_type='provider-seam-entered'),
      'rejects', (select count(*) from public.deal_hunter_cim_audit_events
        where event_type='provider-boundary-rejected'),
      'byWriterPath', writer_paths.value),
    'invariants', invariants.value,
    'pause', pg_catalog.jsonb_build_object('paused', v_paused, 'source', v_pause_source),
    'shadowCandidates', shadow.value)
  into v_result
  from counts, enrollment_states, campaign_states, touch_states, transmission_states,
    conversation_states, enrollment_reasons, campaign_reasons, touch_reasons,
    gate_reasons, activation_modes, legacy_classes, writer_paths, shadow, invariants;

  return v_result;
end;
$$;

revoke all on function public.pursue_cim_read_operations_snapshot_v1(timestamptz, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.pursue_cim_read_operations_snapshot_v1(timestamptz, integer)
  to service_role;

create or replace function public.pursue_cim_record_boundary_rejection_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_authorization_id text;
  v_reason text;
  v_actor text;
  v_expected bigint;
  v_now timestamptz;
  v_id text;
  v_rows integer;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command,'transmissionId',240);
  v_authorization_id := public.pursue_cim_required_text_v1(p_command,'authorizationId',240);
  v_reason := public.pursue_cim_required_text_v1(p_command,'reasonCode',160);
  v_actor := public.pursue_cim_required_text_v1(p_command,'actor',200);
  v_expected := public.pursue_cim_required_revision_v1(p_command,'expectedRowVersion');
  v_now := public.pursue_cim_required_instant_v1(p_command,'now');
  if pg_catalog.jsonb_typeof(p_command->'reconciliationOnly') is distinct from 'boolean'
    or v_reason <> all(array['cim-provider-seam-unauthorized','cim-provider-work-mismatch',
      'cim-provider-seam-already-entered','cim-provider-writer-path-mismatch',
      'cim-provider-profile-mismatch','cim-provider-nonce-invalid',
      'cim-provider-payload-mismatch']::text[])
  then raise exception 'Invalid CIM provider boundary rejection'; end if;
  perform 1 from public.deal_hunter_cim_live_provider_authorizations
    where id=v_authorization_id and transmission_id=v_transmission_id for share;
  if not found then raise exception 'Invalid CIM provider boundary rejection authority'; end if;
  v_id := public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-boundary-rejected:v1'::text),
    pg_catalog.to_jsonb(v_transmission_id),pg_catalog.to_jsonb(v_authorization_id),
    pg_catalog.to_jsonb(v_reason),pg_catalog.to_jsonb(v_expected));
  insert into public.deal_hunter_cim_audit_events
    (id,event_type,transmission_id,authorization_id,next_state,reason_code,
      actor,source,occurred_at,metadata)
  values (v_id,'provider-boundary-rejected',v_transmission_id,v_authorization_id,
    'rejected',v_reason,v_actor,'provider-boundary-observer',v_now,
    pg_catalog.jsonb_build_object('reconciliationOnly',
      (p_command->>'reconciliationOnly')::boolean,'expectedRowVersion',v_expected))
  on conflict (id) do nothing;
  get diagnostics v_rows = row_count;
  return pg_catalog.jsonb_build_object('applied',v_rows=1,'replay',v_rows=0);
end;
$$;

revoke all on function public.pursue_cim_record_boundary_rejection_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.pursue_cim_record_boundary_rejection_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_apply_automatic_containment_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_finding_id text;
  v_evidence_digest text;
  v_actor text;
  v_now timestamptz;
  v_codes text[];
  v_audit_id text;
  v_activation record;
  v_authorization record;
  v_activation_count integer := 0;
  v_authorization_count integer := 0;
  v_replay boolean := false;
begin
  v_finding_id := public.pursue_cim_required_text_v1(p_command, 'findingId', 64);
  v_evidence_digest := public.pursue_cim_required_text_v1(p_command, 'evidenceDigest', 64);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  if v_finding_id !~ '^[0-9a-f]{64}$' or v_evidence_digest !~ '^[0-9a-f]{64}$'
    or pg_catalog.jsonb_typeof(p_command -> 'findingCodes') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_command -> 'findingCodes') not between 1 and 20
  then raise exception 'Invalid Pursue CIM containment command'; end if;

  select pg_catalog.array_agg(value order by value) into v_codes
  from pg_catalog.jsonb_array_elements_text(p_command -> 'findingCodes') item(value);
  if pg_catalog.array_length(v_codes,1) is distinct from (
      select count(distinct value) from pg_catalog.jsonb_array_elements_text(
        p_command -> 'findingCodes') item(value))
    or pg_catalog.to_jsonb(v_codes) is distinct from p_command -> 'findingCodes'
    or not v_codes <@ array[
      'duplicate_provider_identity','missing_durable_authority','multiple_active_campaigns',
      'duplicate_accepted_touch','active_identity_ambiguity','unexpected_legacy_invocation',
      'terminal_evidence_before_provider_call','invalid_claimed_timezone',
      'expired_activation_attempt','missing_live_envelope',
      'inbound_or_reconciliation_readiness_loss','shadow_provider_call']::text[]
  then raise exception 'Invalid Pursue CIM containment findings'; end if;

  v_audit_id := 'cim-containment:' || v_finding_id;
  perform 1 from public.deal_hunter_cim_transmissions t
    where exists (select 1 from public.deal_hunter_cim_live_provider_authorizations a
      where a.transmission_id=t.id and a.consumed_at is null and a.withdrawn_at is null)
    order by t.id for update;
  perform 1 from public.deal_hunter_cim_live_provider_authorizations
    where consumed_at is null and withdrawn_at is null order by id for update;
  perform 1 from public.deal_hunter_cim_capability_activations
    where status='current' order by id for update;
  perform 1 from public.deal_hunter_cim_safety_settings where id='global' for update;
  lock table public.deal_hunter_cim_audit_events in share row exclusive mode;
  v_replay := exists (
    select 1 from public.deal_hunter_cim_audit_events where id=v_audit_id);
  if v_replay
    and coalesce((select outreach_paused from public.deal_hunter_cim_safety_settings
      where id='global'), false)
    and not exists (select 1 from public.deal_hunter_cim_capability_activations
      where status='current')
    and not exists (select 1 from public.deal_hunter_cim_live_provider_authorizations
      where consumed_at is null and withdrawn_at is null)
  then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', true,
      'paused', true, 'withdrawnActivations', 0, 'withdrawnAuthorizations', 0);
  end if;

  insert into public.deal_hunter_cim_safety_settings
    (id, updated_at, outreach_paused, updated_by, metadata)
  values ('global', v_now, true, v_actor, pg_catalog.jsonb_build_object(
    'p9Containment', pg_catalog.jsonb_build_object('findingId',v_finding_id,
      'evidenceDigest',v_evidence_digest,'findingCodes',pg_catalog.to_jsonb(v_codes),
      'occurredAt',v_now)))
  on conflict (id) do update set updated_at=excluded.updated_at,
    outreach_paused=true, updated_by=excluded.updated_by,
    metadata=coalesce(public.deal_hunter_cim_safety_settings.metadata,'{}'::jsonb)
      || excluded.metadata;

  for v_activation in
    select id from public.deal_hunter_cim_capability_activations
    where status='current' order by id for update
  loop
    update public.deal_hunter_cim_capability_activations
      set status='withdrawn', withdrawn_at=v_now, updated_at=v_now
      where id=v_activation.id and status='current';
    v_activation_count := v_activation_count + 1;
    insert into public.deal_hunter_cim_audit_events
      (id,event_type,activation_id,prior_state,next_state,reason_code,authority_digest,
       actor,source,occurred_at,metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('p9'::text),
        pg_catalog.to_jsonb(v_finding_id),pg_catalog.to_jsonb(v_activation.id)),
      'capability-withdrawn',v_activation.id,'current','withdrawn',
      'automatic_containment',v_evidence_digest,v_actor,'p9-auto-containment',v_now,'{}'::jsonb);
  end loop;

  for v_authorization in
    select id,transmission_id from public.deal_hunter_cim_live_provider_authorizations
    where consumed_at is null and withdrawn_at is null order by id for update
  loop
    update public.deal_hunter_cim_live_provider_authorizations set withdrawn_at=v_now
      where id=v_authorization.id and consumed_at is null and withdrawn_at is null;
    v_authorization_count := v_authorization_count + 1;
    insert into public.deal_hunter_cim_audit_events
      (id,event_type,transmission_id,authorization_id,prior_state,next_state,
       reason_code,authority_digest,actor,source,occurred_at,metadata)
    values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('p9'::text),
        pg_catalog.to_jsonb(v_finding_id),pg_catalog.to_jsonb(v_authorization.id)),
      'authorization-withdrawn',v_authorization.transmission_id,v_authorization.id,
      'issued','withdrawn','automatic_containment',v_evidence_digest,v_actor,
      'p9-auto-containment',v_now,'{}'::jsonb);
  end loop;

  if v_replay then
    insert into public.deal_hunter_cim_audit_events
      (id,event_type,reason_code,authority_digest,actor,source,occurred_at,metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('p9-containment-reasserted'::text),
        pg_catalog.to_jsonb(v_finding_id),pg_catalog.to_jsonb(v_now)),
      'automatic-containment-reasserted','high_severity_invariant',
      v_evidence_digest,v_actor,'p9-auto-containment',v_now,
      pg_catalog.jsonb_build_object('findingCodes',pg_catalog.to_jsonb(v_codes),
        'withdrawnActivations',v_activation_count,
        'withdrawnAuthorizations',v_authorization_count));
  else
    insert into public.deal_hunter_cim_audit_events
      (id,event_type,reason_code,authority_digest,actor,source,occurred_at,metadata)
    values (v_audit_id,'automatic-containment','high_severity_invariant',
      v_evidence_digest,v_actor,'p9-auto-containment',v_now,
      pg_catalog.jsonb_build_object('findingCodes',pg_catalog.to_jsonb(v_codes),
        'withdrawnActivations',v_activation_count,
        'withdrawnAuthorizations',v_authorization_count));
  end if;

  return pg_catalog.jsonb_build_object('applied', not v_replay, 'replay', v_replay,
    'paused', true, 'withdrawnActivations', v_activation_count,
    'withdrawnAuthorizations', v_authorization_count);
end;
$$;

revoke all on function public.pursue_cim_apply_automatic_containment_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.pursue_cim_apply_automatic_containment_v1(jsonb)
  to service_role;

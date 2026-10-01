-- Package 6D: derive one dormant follow-up slot from each accepted provider instant.

create or replace function public.pursue_cim_read_cadence_context_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id text := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'transmission', pg_catalog.to_jsonb(t),
    'members', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'membership', pg_catalog.to_jsonb(m), 'touch', pg_catalog.to_jsonb(ct),
      'campaign', pg_catalog.to_jsonb(c), 'timezone', pg_catalog.to_jsonb(tz))
      order by m.touch_id)
      from public.deal_hunter_cim_transmission_touches m
      left join public.deal_hunter_cim_campaign_touches ct on ct.id=m.touch_id
      left join public.deal_hunter_cim_campaigns c on c.id=m.campaign_id
      left join public.deal_hunter_opportunity_timezone_revisions tz
        on tz.opportunity_id=c.opportunity_id and tz.revision=c.timezone_revision
      where m.transmission_id=t.id), '[]'::jsonb),
    'nextTouch', case when t.state='accepted' then (select pg_catalog.to_jsonb(n)
      from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches current_touch on current_touch.id=m.touch_id
      join public.deal_hunter_cim_campaign_touches n
        on n.campaign_id=m.campaign_id and n.ordinal=current_touch.ordinal+1
      where m.transmission_id=t.id and m.cancelled_at is null order by n.id limit 1)
      else null end) into v_result
  from public.deal_hunter_cim_transmissions t where t.id=v_id;
  return v_result;
end;
$$;

revoke all on function public.pursue_cim_read_cadence_context_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_read_cadence_context_v1(jsonb) to service_role;

create or replace function public.pursue_cim_resolve_local_instant_v1(
  p_local timestamp without time zone, p_timezone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cursor timestamp without time zone;
  v_wall timestamptz;
  v_candidate timestamptz;
  v_candidates bigint;
  v_step integer;
begin
  if p_timezone is null or pg_catalog.btrim(p_timezone)<>p_timezone
    or not exists (select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then
    raise exception 'Invalid Pursue CIM cadence timezone';
  end if;
  for v_step in 0..2880 loop
    v_cursor := case when v_step=0 then p_local
      else pg_catalog.date_trunc('minute',p_local)+v_step*interval '1 minute' end;
    v_wall := v_cursor at time zone 'UTC';
    select pg_catalog.count(*),pg_catalog.min(candidate)
      into v_candidates,v_candidate
    from (select distinct v_wall-
        (((v_wall+sample.step*interval '6 hours') at time zone p_timezone)
          -((v_wall+sample.step*interval '6 hours') at time zone 'UTC')) as candidate
      from pg_catalog.generate_series(-8,8) as sample(step)) offsets
    where candidate at time zone p_timezone=v_cursor;
    if v_candidates>0 then
      return pg_catalog.jsonb_build_object(
        'instant',pg_catalog.to_char(v_candidate at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'disambiguation',case when v_step>0 then 'gap-forward'
          when v_candidates>1 then 'earlier-repeat' else 'exact' end);
    end if;
  end loop;
  raise exception 'Local Pursue CIM cadence time is unresolved';
end;
$$;

revoke all on function public.pursue_cim_resolve_local_instant_v1(
  timestamp without time zone,text) from public, anon, authenticated, service_role;

create or replace function public.pursue_cim_expected_initial_expiry_v1(
  p_accepted timestamptz, p_timezone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_local_accepted timestamp without time zone := p_accepted at time zone p_timezone;
  v_local_expiry timestamp without time zone := v_local_accepted+interval '21 days';
  v_resolved jsonb := public.pursue_cim_resolve_local_instant_v1(v_local_expiry,p_timezone);
  v_derivation jsonb;
begin
  v_derivation := pg_catalog.jsonb_build_object(
    'sourceAcceptedAt',pg_catalog.to_char(p_accepted at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'timezone',p_timezone,
    'localAccepted',pg_catalog.to_char(v_local_accepted,'YYYY-MM-DD"T"HH24:MI:SS'),
    'localExpiry',pg_catalog.to_char(v_local_expiry,'YYYY-MM-DD"T"HH24:MI:SS'),
    'disambiguation',v_resolved->>'disambiguation',
    'expiresAt',v_resolved->>'instant',
    'policyVersion','deal-hunter-cim-autopilot-v1',
    'resolverVersion','intl-iana-v1');
  return pg_catalog.jsonb_build_object('localExpiryAt',v_resolved->>'instant',
    'expiryDerivation',v_derivation);
end;
$$;

revoke all on function public.pursue_cim_expected_initial_expiry_v1(timestamptz,text)
  from public, anon, authenticated, service_role;

create or replace function public.pursue_cim_validate_accepted_cadence_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id text := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_outcome text := public.pursue_cim_required_text_v1(p_command, 'outcome', 40);
  v_observed timestamptz := public.pursue_cim_required_instant_v1(
    pg_catalog.jsonb_build_object('observedAt',coalesce(p_command->>'observedAt',p_command->>'now')),
    'observedAt');
  v_cadence jsonb := p_command->'cadence';
  v_next jsonb;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_membership public.deal_hunter_cim_transmission_touches%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_timezone public.deal_hunter_opportunity_timezone_revisions%rowtype;
  v_members bigint;
  v_eligible boolean;
  v_kind text;
  v_ordinal bigint;
  v_raw timestamptz;
  v_due timestamptz;
  v_local timestamp;
  v_date date;
  v_slot text;
  v_expiry timestamptz;
  v_expected_expiry jsonb;
  v_expected_id text;
begin
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id=v_id for update;
  if not found then return pg_catalog.jsonb_build_object('eligible',false); end if;
  select count(*) into v_members from public.deal_hunter_cim_transmission_touches
    where transmission_id=v_id and cancelled_at is null;
  if v_members=1 then
    select * into v_membership from public.deal_hunter_cim_transmission_touches
      where transmission_id=v_id and cancelled_at is null for update;
    select * into v_touch from public.deal_hunter_cim_campaign_touches
      where id=v_membership.touch_id for update;
    select * into v_campaign from public.deal_hunter_cim_campaigns
      where id=v_membership.campaign_id for update;
    select tz.* into v_timezone from public.deal_hunter_opportunity_timezone_revisions tz
      where tz.opportunity_id=v_campaign.opportunity_id
        and tz.revision=v_campaign.timezone_revision;
  end if;
  v_eligible := v_members=1
    and v_membership.transmission_id=v_transmission.id
    and v_membership.touch_id=v_touch.id
    and v_membership.campaign_id=v_campaign.id
    and v_membership.opportunity_id=v_campaign.opportunity_id
    and v_touch.campaign_id=v_campaign.id
    and v_touch.opportunity_id=v_campaign.opportunity_id
    and v_timezone.opportunity_id=v_campaign.opportunity_id
    and v_timezone.revision=v_campaign.timezone_revision
    and v_campaign.terminal_revision=v_transmission.campaign_terminal_revision
    and v_campaign.state in ('initial-pending','active-follow-up','provider-ambiguous');
  if v_outcome<>'accepted' or not v_eligible then
    if v_cadence is not null and v_cadence<>'null'::jsonb then
      raise exception 'Ineligible Pursue CIM outcome cannot advance cadence';
    end if;
    return pg_catalog.jsonb_build_object('eligible',false);
  end if;
  if not coalesce(
    (v_touch.kind='initial' and v_touch.ordinal=0 and v_touch.logical_slot='initial')
    or (v_touch.kind='follow-up-1' and v_touch.ordinal=1
      and v_touch.logical_slot='follow-up-1')
    or (v_touch.kind='follow-up-2' and v_touch.ordinal=2
      and v_touch.logical_slot='follow-up-2')
    or (v_touch.kind='follow-up-3' and v_touch.ordinal=3
      and v_touch.logical_slot='follow-up-3')
    or (v_touch.kind='weekday-follow-up' and v_touch.ordinal>=4
      and v_touch.logical_slot~'^weekday:[0-9]{4}-[0-9]{2}-[0-9]{2}$'), false)
  then raise exception 'Invalid current Pursue CIM cadence touch'; end if;
  if pg_catalog.jsonb_typeof(v_cadence)<>'object'
    or v_campaign.policy_version<>'deal-hunter-cim-autopilot-v1'
    or v_touch.timezone_revision<>v_campaign.timezone_revision
    or v_cadence->>'campaignId' is distinct from v_campaign.id
    or v_cadence->>'touchId' is distinct from v_touch.id
    or public.pursue_cim_required_revision_v1(v_cadence,'expectedCampaignRowVersion')<>v_campaign.row_version
    or public.pursue_cim_required_revision_v1(v_cadence,'expectedCampaignTerminalRevision')<>v_campaign.terminal_revision
    or public.pursue_cim_required_revision_v1(v_cadence,'expectedTouchRowVersion')<>v_touch.row_version
    or public.pursue_cim_required_instant_v1(v_cadence,'acceptedAt')<>v_observed
    or pg_catalog.jsonb_typeof(v_cadence->'expiryDerivation')<>'object'
    or pg_catalog.length(public.pursue_cim_json_stringify_v1(v_cadence->'expiryDerivation'))>1000
  then raise exception 'Accepted Pursue CIM cadence authority mismatch'; end if;
  v_expiry := public.pursue_cim_required_instant_v1(v_cadence,'localExpiryAt');
  if v_touch.kind='initial' then
    v_expected_expiry := public.pursue_cim_expected_initial_expiry_v1(
      v_observed,v_timezone.iana_timezone);
    if public.pursue_cim_required_instant_v1(v_cadence,'initialAcceptedAt')<>v_observed
      or v_expiry<>(v_expected_expiry->>'localExpiryAt')::timestamptz
      or v_cadence->'expiryDerivation'<>v_expected_expiry->'expiryDerivation' then
      raise exception 'Invalid initial Pursue CIM cadence anchor';
    end if;
    v_kind := 'follow-up-1'; v_ordinal := 1; v_raw := v_observed+interval '48 hours';
  elsif v_touch.kind='follow-up-1' then
    v_kind := 'follow-up-2'; v_ordinal := 2; v_raw := v_observed+interval '72 hours';
  elsif v_touch.kind='follow-up-2' then
    v_kind := 'follow-up-3'; v_ordinal := 3; v_raw := v_observed+interval '96 hours';
  elsif v_touch.kind in ('follow-up-3','weekday-follow-up') then
    v_kind := 'weekday-follow-up'; v_ordinal := v_touch.ordinal+1;
    v_date := (v_observed at time zone v_timezone.iana_timezone)::date+1;
    while extract(isodow from v_date) in (6,7) loop v_date := v_date+1; end loop;
    v_raw := (v_date+time '08:00') at time zone v_timezone.iana_timezone;
  else raise exception 'Invalid current Pursue CIM cadence touch'; end if;
  if v_touch.kind<>'initial' and (
    v_campaign.initial_accepted_at is null or v_campaign.local_expiry_at is null
    or public.pursue_cim_required_instant_v1(v_cadence,'initialAcceptedAt')<>v_campaign.initial_accepted_at
    or v_expiry<>v_campaign.local_expiry_at
    or v_cadence->'expiryDerivation'<>v_campaign.expiry_derivation) then
    raise exception 'Pursue CIM campaign expiry authority mismatch';
  end if;
  v_local := v_raw at time zone v_timezone.iana_timezone;
  if extract(isodow from v_local) between 1 and 5
    and v_local::time>=time '08:00' and v_local::time<time '17:00' then
    v_due := v_raw;
  else
    v_date := v_local::date;
    if extract(isodow from v_date) in (6,7) or v_local::time>=time '17:00' then
      v_date := v_date+1;
    end if;
    while extract(isodow from v_date) in (6,7) loop v_date := v_date+1; end loop;
    v_due := (v_date+time '08:00') at time zone v_timezone.iana_timezone;
  end if;
  v_slot := case when v_kind='weekday-follow-up'
    then 'weekday:'||pg_catalog.to_char(v_due at time zone v_timezone.iana_timezone,'YYYY-MM-DD')
    else v_kind end;
  v_next := v_cadence->'nextTouch';
  if v_due>=v_expiry then
    if v_next is not null and v_next<>'null'::jsonb then
      raise exception 'Pursue CIM cadence cannot cross campaign expiry';
    end if;
  else
    v_expected_id := public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-touch:v1'::text),
      pg_catalog.to_jsonb(v_campaign.id),pg_catalog.to_jsonb(v_slot),
      pg_catalog.to_jsonb(v_campaign.policy_version));
    if pg_catalog.jsonb_typeof(v_next)<>'object'
      or public.pursue_cim_required_text_v1(v_next,'id',240)<>v_expected_id
      or public.pursue_cim_required_text_v1(v_next,'logicalSlot',160)<>v_slot
      or public.pursue_cim_required_text_v1(v_next,'kind',40)<>v_kind
      or public.pursue_cim_required_revision_v1(v_next,'ordinal')<>v_ordinal
      or public.pursue_cim_required_instant_v1(v_next,'rawDueAt')<>v_raw
      or public.pursue_cim_required_instant_v1(v_next,'dueAt')<>v_due
      or public.pursue_cim_required_text_v1(v_next,'dueLocal',120)
        <>pg_catalog.to_char(v_due at time zone v_timezone.iana_timezone,'YYYY-MM-DD"T"HH24:MI:SS')
      or public.pursue_cim_required_revision_v1(v_next,'timezoneRevision')<>v_campaign.timezone_revision
      or public.pursue_cim_required_text_v1(v_next,'cadencePolicyVersion',120)<>v_campaign.policy_version
    then raise exception 'Pursue CIM next slot does not match accepted cadence'; end if;
  end if;
  return pg_catalog.jsonb_build_object('eligible',true,'campaignId',v_campaign.id,
    'opportunityId',v_campaign.opportunity_id,'campaignRowVersion',v_campaign.row_version,
    'campaignTerminalRevision',v_campaign.terminal_revision,
    'timezoneRevision',v_campaign.timezone_revision,'currentOrdinal',v_touch.ordinal,
    'localExpiryAt',v_expiry,'expiryDerivation',v_cadence->'expiryDerivation',
    'nextTouch',v_next);
end;
$$;

revoke all on function public.pursue_cim_validate_accepted_cadence_v1(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.pursue_cim_apply_accepted_cadence_v1(
  p_projection jsonb, p_actor text, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_next jsonb := p_projection->'nextTouch';
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
begin
  if coalesce((p_projection->>'eligible')::boolean,false) is false then return null; end if;
  update public.deal_hunter_cim_campaigns set
    local_expiry_at=coalesce(local_expiry_at,(p_projection->>'localExpiryAt')::timestamptz),
    expiry_derivation=case when local_expiry_at is null
      then p_projection->'expiryDerivation' else expiry_derivation end,
    updated_at=p_now
    where id=p_projection->>'campaignId'
      and row_version=(p_projection->>'campaignRowVersion')::bigint+1
      and terminal_revision=(p_projection->>'campaignTerminalRevision')::bigint;
  if not found then raise exception 'Concurrent Pursue CIM cadence finalization'; end if;
  if v_next is null or v_next='null'::jsonb then return null; end if;
  insert into public.deal_hunter_cim_campaign_touches
    (id,campaign_id,opportunity_id,logical_slot,kind,ordinal,due_at,due_local,
     timezone_revision,state,created_at,updated_at)
  values (v_next->>'id',p_projection->>'campaignId',p_projection->>'opportunityId',
    v_next->>'logicalSlot',v_next->>'kind',(v_next->>'ordinal')::bigint,
    (v_next->>'dueAt')::timestamptz,v_next->>'dueLocal',
    (v_next->>'timezoneRevision')::bigint,'scheduled',p_now,p_now)
  returning * into v_touch;
  insert into public.deal_hunter_cim_audit_events
    (id,event_type,opportunity_id,campaign_id,touch_id,next_state,actor,source,occurred_at,metadata)
  values (public.pursue_cim_digest_v1(pg_catalog.to_jsonb('cim-audit:v1'::text),
    pg_catalog.to_jsonb('touch-created'::text),pg_catalog.to_jsonb(v_touch.id)),
    'touch-created',v_touch.opportunity_id,v_touch.campaign_id,v_touch.id,'scheduled',
    p_actor,'postgres-transition',p_now,'{}'::jsonb);
  return pg_catalog.to_jsonb(v_touch);
end;
$$;

revoke all on function public.pursue_cim_apply_accepted_cadence_v1(jsonb,text,timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.pursue_cim_finalize_with_cadence_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_projection jsonb;
  v_result jsonb;
  v_next jsonb;
  v_state text;
begin
  select state into v_state from public.deal_hunter_cim_transmissions
    where id=public.pursue_cim_required_text_v1(p_command,'transmissionId',240)
    for update;
  if found and v_state in ('accepted','definitive-failure','ambiguous') then
    v_result := public.pursue_cim_finalize_transmission_v1(p_command);
    if coalesce((v_result->>'existing')::boolean,false)
      and v_result#>>'{transmission,state}'='accepted' then
      select pg_catalog.to_jsonb(n) into v_next
        from public.deal_hunter_cim_transmission_touches m
        join public.deal_hunter_cim_campaign_touches current_touch on current_touch.id=m.touch_id
        join public.deal_hunter_cim_campaign_touches n
          on n.campaign_id=m.campaign_id and n.ordinal=current_touch.ordinal+1
        where m.transmission_id=p_command->>'transmissionId' and m.cancelled_at is null
        order by n.id limit 1;
    end if;
    return v_result||pg_catalog.jsonb_build_object('nextTouch',v_next);
  end if;
  v_projection := public.pursue_cim_validate_accepted_cadence_v1(p_command);
  v_result := public.pursue_cim_finalize_transmission_v1(p_command);
  if coalesce((v_result->>'applied')::boolean,false)
    and p_command->>'outcome'='accepted' then
    v_next := public.pursue_cim_apply_accepted_cadence_v1(v_projection,
      public.pursue_cim_required_text_v1(p_command,'actor',200),
      public.pursue_cim_required_instant_v1(p_command,'now'));
  elsif coalesce((v_result->>'existing')::boolean,false)
    and v_result#>>'{transmission,state}'='accepted' then
    select pg_catalog.to_jsonb(n) into v_next
      from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches current_touch on current_touch.id=m.touch_id
      join public.deal_hunter_cim_campaign_touches n
        on n.campaign_id=m.campaign_id and n.ordinal=current_touch.ordinal+1
      where m.transmission_id=p_command->>'transmissionId' and m.cancelled_at is null
      order by n.id limit 1;
  end if;
  return v_result||pg_catalog.jsonb_build_object('nextTouch',v_next);
end;
$$;

create or replace function public.pursue_cim_reconcile_with_cadence_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_projection jsonb;
  v_result jsonb;
  v_next jsonb;
  v_state text;
begin
  select state into v_state from public.deal_hunter_cim_transmissions
    where id=public.pursue_cim_required_text_v1(p_command,'transmissionId',240)
    for update;
  if found and v_state in ('accepted','definitive-failure') then
    v_result := public.pursue_cim_reconcile_transmission_v1(p_command);
    if coalesce((v_result->>'unchanged')::boolean,false)
      and v_result#>>'{transmission,state}'='accepted' then
      select pg_catalog.to_jsonb(n) into v_next
        from public.deal_hunter_cim_transmission_touches m
        join public.deal_hunter_cim_campaign_touches current_touch on current_touch.id=m.touch_id
        join public.deal_hunter_cim_campaign_touches n
          on n.campaign_id=m.campaign_id and n.ordinal=current_touch.ordinal+1
        where m.transmission_id=p_command->>'transmissionId' and m.cancelled_at is null
        order by n.id limit 1;
    end if;
    return v_result||pg_catalog.jsonb_build_object('nextTouch',v_next);
  end if;
  v_projection := public.pursue_cim_validate_accepted_cadence_v1(p_command);
  v_result := public.pursue_cim_reconcile_transmission_v1(p_command);
  if coalesce((v_result->>'applied')::boolean,false)
    and p_command->>'outcome'='accepted' then
    v_next := public.pursue_cim_apply_accepted_cadence_v1(v_projection,
      public.pursue_cim_required_text_v1(p_command,'actor',200),
      public.pursue_cim_required_instant_v1(p_command,'now'));
  elsif coalesce((v_result->>'unchanged')::boolean,false)
    and v_result#>>'{transmission,state}'='accepted' then
    select pg_catalog.to_jsonb(n) into v_next
      from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches current_touch on current_touch.id=m.touch_id
      join public.deal_hunter_cim_campaign_touches n
        on n.campaign_id=m.campaign_id and n.ordinal=current_touch.ordinal+1
      where m.transmission_id=p_command->>'transmissionId' and m.cancelled_at is null
      order by n.id limit 1;
  end if;
  return v_result||pg_catalog.jsonb_build_object('nextTouch',v_next);
end;
$$;

revoke all on function public.pursue_cim_finalize_transmission_v1(jsonb) from service_role;
revoke all on function public.pursue_cim_reconcile_transmission_v1(jsonb) from service_role;
revoke all on function public.pursue_cim_finalize_with_cadence_v1(jsonb)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_reconcile_with_cadence_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_finalize_with_cadence_v1(jsonb) to service_role;
grant execute on function public.pursue_cim_reconcile_with_cadence_v1(jsonb) to service_role;

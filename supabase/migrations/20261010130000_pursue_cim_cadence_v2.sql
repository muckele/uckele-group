-- Replace the dormant follow-up projection with the owner-approved bounded cadence.
-- This migration does not enable a scheduler, activation, or provider path.

create or replace function public.pursue_cim_expected_initial_expiry_v1(
  p_accepted timestamptz, p_timezone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_local_accepted timestamp without time zone := p_accepted at time zone p_timezone;
  v_local_expiry timestamp without time zone := v_local_accepted+interval '28 days';
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
    'cadencePolicyVersion','deal-hunter-cim-cadence-v2',
    'sendTime','08:00',
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
  v_date date;
  v_remaining integer;
  v_slot text;
  v_expiry timestamptz;
  v_expected_expiry jsonb;
  v_expected_id text;
  v_send_time text;
  v_send_clock time without time zone;
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
      and v_touch.logical_slot~'^calendar:[0-9]{4}-[0-9]{2}-[0-9]{2}$'), false)
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
    or v_cadence#>>'{expiryDerivation,cadencePolicyVersion}'
      is distinct from 'deal-hunter-cim-cadence-v2'
    or pg_catalog.length(public.pursue_cim_json_stringify_v1(v_cadence->'expiryDerivation'))>1000
  then raise exception 'Accepted Pursue CIM cadence authority mismatch'; end if;
  v_send_time := v_cadence#>>'{expiryDerivation,sendTime}';
  if v_send_time is null
    or v_send_time!~'^(0[89]|1[0-6]):[0-5][0-9]$' then
    raise exception 'Invalid Pursue CIM configured send time';
  end if;
  v_send_clock := v_send_time::time;
  v_expiry := public.pursue_cim_required_instant_v1(v_cadence,'localExpiryAt');
  if v_touch.kind='initial' then
    v_expected_expiry := public.pursue_cim_expected_initial_expiry_v1(
      v_observed,v_timezone.iana_timezone);
    v_expected_expiry := pg_catalog.jsonb_set(v_expected_expiry,
      '{expiryDerivation,sendTime}',pg_catalog.to_jsonb(v_send_time),true);
    if public.pursue_cim_required_instant_v1(v_cadence,'initialAcceptedAt')<>v_observed
      or v_expiry<>(v_expected_expiry->>'localExpiryAt')::timestamptz
      or v_cadence->'expiryDerivation'<>v_expected_expiry->'expiryDerivation' then
      raise exception 'Invalid initial Pursue CIM cadence anchor';
    end if;
    v_kind := 'follow-up-1'; v_ordinal := 1;
    v_date := (v_observed at time zone v_timezone.iana_timezone)::date;
    v_remaining := 2;
    while v_remaining>0 loop
      v_date := v_date+1;
      if extract(isodow from v_date) between 1 and 5 then
        v_remaining := v_remaining-1;
      end if;
    end loop;
  elsif v_touch.kind='follow-up-1' then
    v_kind := 'follow-up-2'; v_ordinal := 2;
    v_date := (v_observed at time zone v_timezone.iana_timezone)::date+2;
  elsif v_touch.kind='follow-up-2' then
    v_kind := 'follow-up-3'; v_ordinal := 3;
    v_date := (v_observed at time zone v_timezone.iana_timezone)::date+2;
  elsif v_touch.kind in ('follow-up-3','weekday-follow-up') then
    v_kind := 'weekday-follow-up'; v_ordinal := v_touch.ordinal+1;
    v_date := (v_observed at time zone v_timezone.iana_timezone)::date+2;
  else raise exception 'Invalid current Pursue CIM cadence touch'; end if;
  v_raw := (v_date+v_send_clock) at time zone v_timezone.iana_timezone;
  v_due := v_raw;
  if v_due>=v_expiry then
    v_slot := null;
  else
    v_slot := case when v_kind='weekday-follow-up'
      then 'calendar:'||pg_catalog.to_char(v_due at time zone v_timezone.iana_timezone,'YYYY-MM-DD')
      else v_kind end;
  end if;
  if v_touch.kind<>'initial' and (
    v_campaign.initial_accepted_at is null or v_campaign.local_expiry_at is null
    or public.pursue_cim_required_instant_v1(v_cadence,'initialAcceptedAt')<>v_campaign.initial_accepted_at
    or v_expiry<>v_campaign.local_expiry_at
    or v_cadence->'expiryDerivation'<>v_campaign.expiry_derivation) then
    raise exception 'Pursue CIM campaign expiry authority mismatch';
  end if;
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
      or public.pursue_cim_required_text_v1(v_next,'cadencePolicyVersion',120)
        <>'deal-hunter-cim-cadence-v2'
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

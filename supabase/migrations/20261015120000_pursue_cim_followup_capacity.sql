-- FL04C: dormant atomic follow-up capacity reservation and renewal.

create table if not exists public.deal_hunter_cim_capacity_reservations (
  id text primary key check (id = pg_catalog.btrim(id) and pg_catalog.length(id) between 1 and 240),
  activation_id text not null references public.deal_hunter_cim_capability_activations(id) on delete restrict,
  transmission_id text not null references public.deal_hunter_cim_transmissions(id) on delete restrict,
  touch_id text not null references public.deal_hunter_cim_campaign_touches(id) on delete restrict,
  campaign_id text not null references public.deal_hunter_cim_campaigns(id) on delete restrict,
  conversation_id text not null references public.deal_hunter_broker_conversations(id) on delete restrict,
  recipient_fingerprint text not null check (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  recipient_address_digest text not null check (recipient_address_digest ~ '^[0-9a-f]{64}$'),
  capacity_date date not null,
  claim_token_digest text not null check (claim_token_digest ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('reserved','consumed','released','expired')),
  reserved_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > reserved_at),
  recipient_window_expires_at timestamptz not null,
  consumed_at timestamptz,
  released_at timestamptz,
  release_reason text check (release_reason is null or pg_catalog.length(release_reason) between 1 and 160),
  expired_at timestamptz,
  row_version bigint not null default 1 check (row_version >= 1),
  check ((state = 'reserved' and consumed_at is null and released_at is null and expired_at is null)
    or (state = 'consumed' and consumed_at is not null and released_at is null and expired_at is null)
    or (state = 'released' and consumed_at is null and released_at is not null and expired_at is null)
    or (state = 'expired' and consumed_at is null and released_at is null and expired_at is not null))
);

create unique index if not exists uq_deal_hunter_cim_capacity_active_touch
  on public.deal_hunter_cim_capacity_reservations(touch_id) where state = 'reserved';
create unique index if not exists uq_deal_hunter_cim_capacity_active_campaign
  on public.deal_hunter_cim_capacity_reservations(campaign_id) where state = 'reserved';
create index if not exists idx_deal_hunter_cim_capacity_daily
  on public.deal_hunter_cim_capacity_reservations(capacity_date, state, expires_at);
create index if not exists idx_deal_hunter_cim_capacity_recipient
  on public.deal_hunter_cim_capacity_reservations(
    recipient_address_digest, state, recipient_window_expires_at);

alter table public.deal_hunter_cim_capacity_reservations enable row level security;
revoke all on table public.deal_hunter_cim_capacity_reservations
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.deal_hunter_cim_capacity_reservations to service_role;

create or replace function public.pursue_cim_capacity_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.state <> 'reserved' or new.state not in ('consumed','released','expired')
    or new.activation_id <> old.activation_id or new.transmission_id <> old.transmission_id
    or new.touch_id <> old.touch_id or new.campaign_id <> old.campaign_id
    or new.conversation_id <> old.conversation_id
    or new.recipient_fingerprint <> old.recipient_fingerprint
    or new.recipient_address_digest <> old.recipient_address_digest
    or new.capacity_date <> old.capacity_date
    or new.claim_token_digest <> old.claim_token_digest
    or new.reserved_at <> old.reserved_at or new.expires_at <> old.expires_at
    or (new.recipient_window_expires_at <> old.recipient_window_expires_at
      and (new.state <> 'consumed' or new.recipient_window_expires_at < old.recipient_window_expires_at))
  then raise exception 'capacity reservation is immutable'; end if;
  return new;
end;
$$;

create or replace function public.pursue_cim_capacity_retain_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin raise exception 'capacity reservation evidence is retained'; end;
$$;

create trigger trg_deal_hunter_cim_capacity_lifecycle
  before update on public.deal_hunter_cim_capacity_reservations
  for each row execute function public.pursue_cim_capacity_guard_v1();
create trigger trg_deal_hunter_cim_capacity_no_delete
  before delete on public.deal_hunter_cim_capacity_reservations
  for each row execute function public.pursue_cim_capacity_retain_v1();

create or replace function public.pursue_cim_capacity_transmission_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_changed bigint;
begin
  if old.state in ('prepared','final-gate-blocked') and new.state = 'provider-pending'
    and exists(select 1 from public.deal_hunter_cim_transmission_touches m
      join public.deal_hunter_cim_campaign_touches t on t.id=m.touch_id
      where m.transmission_id=new.id and m.cancelled_at is null and t.kind <> 'initial') then
    update public.deal_hunter_cim_capacity_reservations set state='consumed',
      consumed_at=v_now, recipient_window_expires_at=v_now+interval '24 hours',
      row_version=row_version+1
      where transmission_id=new.id and state='reserved' and expires_at>v_now
        and exists(select 1 from public.deal_hunter_cim_campaign_touches t
          join public.deal_hunter_cim_campaigns c on c.id=t.campaign_id
          join public.deal_hunter_broker_conversations v on v.id=c.conversation_id
          join public.deal_hunter_cim_capability_activations a
            on a.id=deal_hunter_cim_capacity_reservations.activation_id
          where t.id=deal_hunter_cim_capacity_reservations.touch_id
            and t.transmission_id=new.id and t.state='claimed'
            and t.claim_token_digest=deal_hunter_cim_capacity_reservations.claim_token_digest
            and t.claim_expires_at>v_now and c.state='active-follow-up'
            and c.local_expiry_at>v_now
            and c.recipient_fingerprint=deal_hunter_cim_capacity_reservations.recipient_fingerprint
            and v.id=new.conversation_id and v.state='open'
            and v.recipient_fingerprint=deal_hunter_cim_capacity_reservations.recipient_fingerprint
            and v.recipient_address=new.to_addresses->>0
            and a.status='current' and a.mode='active'
            and a.id=public.pursue_cim_current_activation_v1('fl04c-followup',v_now)
            and (a.expires_at is null or a.expires_at>v_now));
    get diagnostics v_changed = row_count;
    if v_changed <> 1 then raise exception 'follow-up capacity authority unavailable'; end if;
  elsif old.state in ('prepared','final-gate-blocked') and new.state='cancelled-before-provider' then
    update public.deal_hunter_cim_capacity_reservations set state='released',
      released_at=v_now, release_reason='cancelled-before-provider',
      row_version=row_version+1 where transmission_id=new.id and state='reserved';
  end if;
  return new;
end;
$$;

create trigger trg_deal_hunter_cim_capacity_transmission
  before update of state on public.deal_hunter_cim_transmissions
  for each row execute function public.pursue_cim_capacity_transmission_v1();

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
  if public.pursue_cim_required_revision_v1(p_command,'preparationGeneration') <> 1 then
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
    where capacity_date=v_capacity_date and (state='consumed' or (state='reserved' and expires_at>v_now));
  if v_activation.daily_cap is null or v_activation.daily_cap < 1 or v_count >= v_activation.daily_cap then
    return pg_catalog.jsonb_build_object('prepared',false,'existing',false,'capacityDeferred',true,
      'payloadConflict',false,'terminal',false,'blockedReason','daily_capacity','transmission',null,'reservation',null);
  end if;
  select count(*) into v_count from public.deal_hunter_cim_capacity_reservations
    where recipient_address_digest=v_address_digest and recipient_window_expires_at>v_now
      and state in ('reserved','consumed');
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
    where capacity_date=v_capacity_date and (state='consumed' or (state='reserved' and expires_at>v_now));
  if v_count >= v_activation.daily_cap then return pg_catalog.jsonb_build_object('renewed',false,
    'existing',false,'capacityDeferred',true,'terminal',false,'blockedReason','daily_capacity',
    'transmission',pg_catalog.to_jsonb(v_transmission),'reservation',null); end if;
  select count(*) into v_count from public.deal_hunter_cim_capacity_reservations
    where recipient_address_digest=v_address_digest and recipient_window_expires_at>v_now
      and state in ('reserved','consumed');
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

revoke all on function public.pursue_cim_capacity_guard_v1() from public,anon,authenticated,service_role;
revoke all on function public.pursue_cim_capacity_retain_v1() from public,anon,authenticated,service_role;
revoke all on function public.pursue_cim_capacity_transmission_v1() from public,anon,authenticated,service_role;
revoke all on function public.pursue_cim_prepare_reserved_followup_v1(jsonb) from public,anon,authenticated;
revoke all on function public.pursue_cim_renew_reserved_followup_v1(jsonb) from public,anon,authenticated;
grant execute on function public.pursue_cim_prepare_reserved_followup_v1(jsonb) to service_role;
grant execute on function public.pursue_cim_renew_reserved_followup_v1(jsonb) to service_role;

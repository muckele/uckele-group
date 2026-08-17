-- Canonical Deal Hunter opportunity identity, recipient safety controls, and
-- reversible audit/repair manifests. All tables remain server/service-role only.

create table if not exists public.deal_hunter_opportunities (
  opportunity_id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  canonical_name text not null,
  canonical_recipient text,
  canonical_location text,
  primary_submission_id uuid references public.contact_submissions(id) on delete set null,
  identity_version text not null,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_opportunity_aliases (
  id text primary key,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  alias_type text not null,
  alias_value text not null,
  alias_key text not null unique,
  source text,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  evidence_version text not null,
  resolution_method text not null,
  confidence_state text not null,
  resolved_by text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_identity_exceptions (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  status text not null,
  observed_deal_key text,
  observed_name text,
  observed_recipient text,
  candidate_opportunity_ids jsonb not null default '[]'::jsonb,
  reason text not null,
  evidence_version text not null,
  resolved_at timestamptz,
  resolved_by text,
  resolution_reason text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_opportunity_claims (
  opportunity_id text primary key references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  request_id text not null unique,
  recipient_email text not null,
  state text not null,
  claimed_at timestamptz not null,
  updated_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_recipient_overrides (
  id text primary key,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  recipient_email text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_by text not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_recipient_claims (
  recipient_email text primary key,
  request_id text not null,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  claimed_at timestamptz not null,
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_safety_settings (
  id text primary key,
  updated_at timestamptz not null,
  outreach_paused boolean not null default false,
  updated_by text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_cim_repair_manifests (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  mode text not null,
  status text not null,
  actor text not null,
  backup_reference text,
  checksum text not null,
  manifest jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.deal_hunter_cim_requests add column if not exists opportunity_id text;
alter table public.deal_hunter_crm_imports add column if not exists opportunity_id text;
alter table public.crm_communications add column if not exists opportunity_id text;
alter table public.email_events add column if not exists opportunity_id text;
alter table public.crm_activity_events add column if not exists opportunity_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deal_hunter_cim_requests_opportunity_id_fkey') then
    alter table public.deal_hunter_cim_requests
      add constraint deal_hunter_cim_requests_opportunity_id_fkey
      foreign key (opportunity_id) references public.deal_hunter_opportunities(opportunity_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deal_hunter_crm_imports_opportunity_id_fkey') then
    alter table public.deal_hunter_crm_imports
      add constraint deal_hunter_crm_imports_opportunity_id_fkey
      foreign key (opportunity_id) references public.deal_hunter_opportunities(opportunity_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_communications_opportunity_id_fkey') then
    alter table public.crm_communications
      add constraint crm_communications_opportunity_id_fkey
      foreign key (opportunity_id) references public.deal_hunter_opportunities(opportunity_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_events_opportunity_id_fkey') then
    alter table public.email_events
      add constraint email_events_opportunity_id_fkey
      foreign key (opportunity_id) references public.deal_hunter_opportunities(opportunity_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_activity_events_opportunity_id_fkey') then
    alter table public.crm_activity_events
      add constraint crm_activity_events_opportunity_id_fkey
      foreign key (opportunity_id) references public.deal_hunter_opportunities(opportunity_id) on delete set null;
  end if;
end
$$;

create index if not exists idx_deal_hunter_opportunities_updated
  on public.deal_hunter_opportunities(updated_at desc, opportunity_id);
create index if not exists idx_deal_hunter_opportunities_recipient
  on public.deal_hunter_opportunities(canonical_recipient, updated_at desc);
create index if not exists idx_deal_hunter_opportunity_aliases_opportunity
  on public.deal_hunter_opportunity_aliases(opportunity_id, alias_type);
create index if not exists idx_deal_hunter_identity_exceptions_status
  on public.deal_hunter_identity_exceptions(status, updated_at desc);
create index if not exists idx_deal_hunter_cim_requests_opportunity
  on public.deal_hunter_cim_requests(opportunity_id, updated_at desc);
create index if not exists idx_deal_hunter_crm_imports_opportunity
  on public.deal_hunter_crm_imports(opportunity_id, updated_at desc);
create index if not exists idx_crm_communications_opportunity
  on public.crm_communications(opportunity_id, occurred_at desc);
create index if not exists idx_email_events_opportunity
  on public.email_events(opportunity_id, created_at desc);
create index if not exists idx_crm_activity_opportunity
  on public.crm_activity_events(opportunity_id, created_at desc);
create index if not exists idx_deal_hunter_cim_overrides_lookup
  on public.deal_hunter_cim_recipient_overrides(opportunity_id, recipient_email, expires_at desc);
create index if not exists idx_deal_hunter_repair_manifests_created
  on public.deal_hunter_cim_repair_manifests(created_at desc);

create or replace function public.claim_deal_hunter_cim_opportunity(
  p_opportunity_id text,
  p_request_id text,
  p_recipient_email text,
  p_allowed_request_ids text[],
  p_claimed_at timestamptz,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.deal_hunter_cim_opportunity_claims%rowtype;
  v_claim public.deal_hunter_cim_opportunity_claims%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('deal-hunter-cim-opportunity:' || p_opportunity_id, 0));
  select * into v_existing
  from public.deal_hunter_cim_opportunity_claims
  where opportunity_id = p_opportunity_id
  for update;

  if found and not (v_existing.request_id = p_request_id or v_existing.request_id = any(coalesce(p_allowed_request_ids, array[]::text[]))) then
    return jsonb_build_object('claimed', false, 'reason', 'opportunity-already-claimed', 'claim', to_jsonb(v_existing));
  end if;

  insert into public.deal_hunter_cim_opportunity_claims (
    opportunity_id, request_id, recipient_email, state, claimed_at, updated_at, metadata
  ) values (
    p_opportunity_id, p_request_id, lower(p_recipient_email), 'active', p_claimed_at, p_claimed_at, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (opportunity_id) do update set
    request_id = excluded.request_id,
    recipient_email = excluded.recipient_email,
    state = 'active',
    updated_at = excluded.updated_at,
    metadata = excluded.metadata
  returning * into v_claim;

  return jsonb_build_object('claimed', true, 'reason', '', 'claim', to_jsonb(v_claim));
end;
$$;

create or replace function public.claim_deal_hunter_cim_recipient(
  p_recipient_email text,
  p_request_id text,
  p_opportunity_id text,
  p_claimed_at timestamptz,
  p_expires_at timestamptz,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_recipient text := lower(btrim(p_recipient_email));
  v_existing public.deal_hunter_cim_recipient_claims%rowtype;
  v_claim public.deal_hunter_cim_recipient_claims%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('deal-hunter-cim-recipient:' || v_recipient, 0));
  select * into v_existing from public.deal_hunter_cim_recipient_claims
  where recipient_email = v_recipient for update;
  if found and v_existing.request_id <> p_request_id and v_existing.expires_at > p_claimed_at then
    return jsonb_build_object('claimed', false, 'reason', 'recipient-send-in-progress', 'claim', to_jsonb(v_existing));
  end if;
  insert into public.deal_hunter_cim_recipient_claims (
    recipient_email, request_id, opportunity_id, claimed_at, expires_at, metadata
  ) values (
    v_recipient, p_request_id, p_opportunity_id, p_claimed_at, p_expires_at, coalesce(p_metadata, '{}'::jsonb)
  ) on conflict (recipient_email) do update set
    request_id = excluded.request_id,
    opportunity_id = excluded.opportunity_id,
    claimed_at = excluded.claimed_at,
    expires_at = excluded.expires_at,
    metadata = excluded.metadata
  returning * into v_claim;
  return jsonb_build_object('claimed', true, 'reason', '', 'claim', to_jsonb(v_claim));
end;
$$;

create or replace function public.link_deal_hunter_opportunity_aliases(p_aliases jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_conflict_alias_key text;
  v_conflict_opportunity_id text;
  v_linked_aliases jsonb;
begin
  if jsonb_typeof(coalesce(p_aliases, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_aliases, '[]'::jsonb)) = 0 then
    return jsonb_build_object('linked', true, 'aliases', '[]'::jsonb);
  end if;
  if (
    select count(distinct value->>'opportunity_id')
    from jsonb_array_elements(p_aliases)
  ) <> 1 then
    raise exception 'canonical alias batch must target exactly one opportunity';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_aliases)
    order by value->>'alias_key'
  loop
    if nullif(v_item->>'alias_key', '') is null then
      raise exception 'canonical alias key is required';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('deal-hunter-opportunity-alias:' || (v_item->>'alias_key'), 0)
    );
  end loop;

  select alias.alias_key, alias.opportunity_id
  into v_conflict_alias_key, v_conflict_opportunity_id
  from public.deal_hunter_opportunity_aliases as alias
  join jsonb_array_elements(p_aliases) as item(value)
    on item.value->>'alias_key' = alias.alias_key
  where alias.opportunity_id <> item.value->>'opportunity_id'
  order by alias.alias_key
  limit 1;

  if found then
    return jsonb_build_object(
      'linked', false,
      'conflictAliasKey', v_conflict_alias_key,
      'conflictOpportunityId', v_conflict_opportunity_id,
      'aliases', '[]'::jsonb
    );
  end if;

  for v_item in select value from jsonb_array_elements(p_aliases) loop
    insert into public.deal_hunter_opportunity_aliases (
      id, opportunity_id, alias_type, alias_value, alias_key, source,
      first_observed_at, last_observed_at, evidence_version, resolution_method,
      confidence_state, resolved_by, metadata
    ) values (
      v_item->>'id',
      v_item->>'opportunity_id',
      v_item->>'alias_type',
      v_item->>'alias_value',
      v_item->>'alias_key',
      nullif(v_item->>'source', ''),
      (v_item->>'first_observed_at')::timestamptz,
      (v_item->>'last_observed_at')::timestamptz,
      v_item->>'evidence_version',
      v_item->>'resolution_method',
      v_item->>'confidence_state',
      nullif(v_item->>'resolved_by', ''),
      coalesce(v_item->'metadata', '{}'::jsonb)
    ) on conflict (alias_key) do update set
      last_observed_at = excluded.last_observed_at,
      source = coalesce(excluded.source, public.deal_hunter_opportunity_aliases.source),
      metadata = excluded.metadata
    where public.deal_hunter_opportunity_aliases.opportunity_id = excluded.opportunity_id;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(alias) order by alias.alias_key), '[]'::jsonb)
  into v_linked_aliases
  from public.deal_hunter_opportunity_aliases as alias
  join jsonb_array_elements(p_aliases) as item(value)
    on item.value->>'alias_key' = alias.alias_key;

  return jsonb_build_object('linked', true, 'aliases', v_linked_aliases);
end;
$$;

create or replace function public.apply_deal_hunter_cim_identity_repair(repair_batch jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_manifest jsonb := coalesce(repair_batch->'manifest', '{}'::jsonb);
  v_manifest_id text := v_manifest->>'id';
  v_changed integer := 0;
  v_opportunities integer := 0;
  v_aliases integer := 0;
  v_requests integer := 0;
  v_imports integer := 0;
  v_communications integer := 0;
  v_email_events integer := 0;
  v_activities integer := 0;
  v_stopped integer := 0;
  v_repair_activities integer := 0;
begin
  if v_manifest_id is null or v_manifest_id = '' then
    raise exception 'repair manifest id is required';
  end if;
  if not coalesce((
    select outreach_paused
    from public.deal_hunter_cim_safety_settings
    where id = 'global'
    limit 1
  ), false) then
    raise exception 'CIM identity repair refused: persistently pause all Deal Hunter CIM outreach first';
  end if;
  if exists (select 1 from public.deal_hunter_cim_repair_manifests where id = v_manifest_id) then
    return jsonb_build_object('alreadyApplied', true, 'manifestId', v_manifest_id);
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'opportunityRecords', '[]'::jsonb)) loop
    insert into public.deal_hunter_opportunities (
      opportunity_id, created_at, updated_at, canonical_name, canonical_recipient,
      canonical_location, primary_submission_id, identity_version, status, metadata
    ) values (
      v_item->>'opportunity_id',
      (v_item->>'created_at')::timestamptz,
      (v_item->>'updated_at')::timestamptz,
      v_item->>'canonical_name',
      nullif(v_item->>'canonical_recipient', ''),
      nullif(v_item->>'canonical_location', ''),
      nullif(v_item->>'primary_submission_id', '')::uuid,
      v_item->>'identity_version',
      coalesce(nullif(v_item->>'status', ''), 'active'),
      coalesce(v_item->'metadata', '{}'::jsonb)
    ) on conflict (opportunity_id) do update set
      updated_at = excluded.updated_at,
      canonical_name = excluded.canonical_name,
      canonical_recipient = coalesce(excluded.canonical_recipient, public.deal_hunter_opportunities.canonical_recipient),
      canonical_location = coalesce(excluded.canonical_location, public.deal_hunter_opportunities.canonical_location),
      primary_submission_id = coalesce(excluded.primary_submission_id, public.deal_hunter_opportunities.primary_submission_id),
      metadata = excluded.metadata;
    get diagnostics v_changed = row_count;
    v_opportunities := v_opportunities + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'aliasRecords', '[]'::jsonb)) loop
    insert into public.deal_hunter_opportunity_aliases (
      id, opportunity_id, alias_type, alias_value, alias_key, source,
      first_observed_at, last_observed_at, evidence_version, resolution_method,
      confidence_state, resolved_by, metadata
    ) values (
      v_item->>'id',
      v_item->>'opportunity_id',
      v_item->>'alias_type',
      v_item->>'alias_value',
      v_item->>'alias_key',
      nullif(v_item->>'source', ''),
      (v_item->>'first_observed_at')::timestamptz,
      (v_item->>'last_observed_at')::timestamptz,
      v_item->>'evidence_version',
      v_item->>'resolution_method',
      v_item->>'confidence_state',
      nullif(v_item->>'resolved_by', ''),
      coalesce(v_item->'metadata', '{}'::jsonb)
    ) on conflict (alias_key) do update set
      last_observed_at = excluded.last_observed_at,
      metadata = excluded.metadata
    where public.deal_hunter_opportunity_aliases.opportunity_id = excluded.opportunity_id;
    get diagnostics v_changed = row_count;
    if v_changed = 0 and exists (
      select 1 from public.deal_hunter_opportunity_aliases
      where alias_key = v_item->>'alias_key' and opportunity_id <> v_item->>'opportunity_id'
    ) then
      raise exception 'canonical alias conflict for %', v_item->>'alias_key';
    end if;
    v_aliases := v_aliases + v_changed;
  end loop;

  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'requestLinks', '[]'::jsonb)) loop
    update public.deal_hunter_cim_requests set
      opportunity_id = v_item->>'opportunity_id',
      submission_id = coalesce(nullif(v_item->>'submission_id', '')::uuid, submission_id),
      updated_at = coalesce(nullif(v_item->>'updated_at', '')::timestamptz, updated_at)
    where id = v_item->>'id'
      and updated_at is not distinct from nullif(v_item->>'expected_updated_at', '')::timestamptz;
    get diagnostics v_changed = row_count;
    if v_changed = 0 and not exists (
      select 1 from public.deal_hunter_cim_requests
      where id = v_item->>'id'
        and opportunity_id = v_item->>'opportunity_id'
        and (nullif(v_item->>'submission_id', '') is null or submission_id = (v_item->>'submission_id')::uuid)
    ) then
      raise exception 'CIM identity repair request conflict for %', v_item->>'id';
    end if;
    v_requests := v_requests + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'importLinks', '[]'::jsonb)) loop
    update public.deal_hunter_crm_imports set
      opportunity_id = v_item->>'opportunity_id',
      submission_id = coalesce(nullif(v_item->>'submission_id', '')::uuid, submission_id),
      updated_at = coalesce(nullif(v_item->>'updated_at', '')::timestamptz, updated_at)
    where id = v_item->>'id'
      and updated_at is not distinct from nullif(v_item->>'expected_updated_at', '')::timestamptz;
    get diagnostics v_changed = row_count;
    if v_changed = 0 and not exists (
      select 1 from public.deal_hunter_crm_imports
      where id = v_item->>'id'
        and opportunity_id = v_item->>'opportunity_id'
        and (nullif(v_item->>'submission_id', '') is null or submission_id = (v_item->>'submission_id')::uuid)
    ) then
      raise exception 'CIM identity repair import conflict for %', v_item->>'id';
    end if;
    v_imports := v_imports + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'communicationLinks', '[]'::jsonb)) loop
    update public.crm_communications set
      opportunity_id = v_item->>'opportunity_id',
      submission_id = coalesce(nullif(v_item->>'submission_id', '')::uuid, submission_id),
      updated_at = coalesce(nullif(v_item->>'updated_at', '')::timestamptz, updated_at)
    where id = v_item->>'id'
      and updated_at is not distinct from nullif(v_item->>'expected_updated_at', '')::timestamptz;
    get diagnostics v_changed = row_count;
    if v_changed = 0 and not exists (
      select 1 from public.crm_communications
      where id = v_item->>'id'
        and opportunity_id = v_item->>'opportunity_id'
        and (nullif(v_item->>'submission_id', '') is null or submission_id = (v_item->>'submission_id')::uuid)
    ) then
      raise exception 'CIM identity repair communication conflict for %', v_item->>'id';
    end if;
    v_communications := v_communications + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'emailEventLinks', '[]'::jsonb)) loop
    update public.email_events set
      opportunity_id = v_item->>'opportunity_id',
      submission_id = coalesce(nullif(v_item->>'submission_id', '')::uuid, submission_id)
    where id = (v_item->>'id')::uuid;
    get diagnostics v_changed = row_count;
    v_email_events := v_email_events + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'activityLinks', '[]'::jsonb)) loop
    update public.crm_activity_events set
      opportunity_id = v_item->>'opportunity_id',
      submission_id = coalesce(nullif(v_item->>'submission_id', '')::uuid, submission_id)
    where id = (v_item->>'id')::uuid;
    get diagnostics v_changed = row_count;
    v_activities := v_activities + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'stopRequests', '[]'::jsonb)) loop
    update public.deal_hunter_cim_requests set
      request_state = 'stopped', follow_up_state = 'stopped', next_follow_up_at = null,
      updated_at = (v_item->>'updated_at')::timestamptz,
      last_activity_at = (v_item->>'updated_at')::timestamptz,
      metadata = coalesce(v_item->'metadata', '{}'::jsonb)
    where id = v_item->>'id'
      and (next_follow_up_at is not null or follow_up_state not in ('stopped', 'completed'));
    get diagnostics v_changed = row_count;
    v_stopped := v_stopped + v_changed;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(repair_batch->'repairActivities', '[]'::jsonb)) loop
    insert into public.crm_activity_events (
      id, submission_id, opportunity_id, created_at, actor, role, event_type, summary, metadata
    ) values (
      (v_item->>'id')::uuid,
      (v_item->>'submission_id')::uuid,
      nullif(v_item->>'opportunity_id', ''),
      (v_item->>'created_at')::timestamptz,
      v_item->>'actor',
      v_item->>'role',
      v_item->>'event_type',
      v_item->>'summary',
      coalesce(v_item->'metadata', '{}'::jsonb)
    ) on conflict (id) do nothing;
    get diagnostics v_changed = row_count;
    v_repair_activities := v_repair_activities + v_changed;
  end loop;

  insert into public.deal_hunter_cim_repair_manifests (
    id, created_at, updated_at, mode, status, actor, backup_reference, checksum, manifest, metadata
  ) values (
    v_manifest_id,
    (v_manifest->>'created_at')::timestamptz,
    (v_manifest->>'updated_at')::timestamptz,
    v_manifest->>'mode',
    v_manifest->>'status',
    v_manifest->>'actor',
    nullif(v_manifest->>'backup_reference', ''),
    v_manifest->>'checksum',
    coalesce(v_manifest->'manifest', '{}'::jsonb),
    coalesce(v_manifest->'metadata', '{}'::jsonb)
  );

  return jsonb_build_object(
    'alreadyApplied', false,
    'manifestId', v_manifest_id,
    'opportunities', v_opportunities,
    'aliases', v_aliases,
    'requests', v_requests,
    'imports', v_imports,
    'communications', v_communications,
    'emailEvents', v_email_events,
    'activities', v_activities,
    'stoppedSequences', v_stopped,
    'repairActivities', v_repair_activities
  );
end;
$$;

alter table public.deal_hunter_opportunities enable row level security;
alter table public.deal_hunter_opportunity_aliases enable row level security;
alter table public.deal_hunter_identity_exceptions enable row level security;
alter table public.deal_hunter_cim_opportunity_claims enable row level security;
alter table public.deal_hunter_cim_recipient_overrides enable row level security;
alter table public.deal_hunter_cim_recipient_claims enable row level security;
alter table public.deal_hunter_cim_safety_settings enable row level security;
alter table public.deal_hunter_cim_repair_manifests enable row level security;

revoke all privileges on table public.deal_hunter_opportunities from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_opportunity_aliases from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_identity_exceptions from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_opportunity_claims from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_recipient_overrides from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_recipient_claims from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_safety_settings from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_repair_manifests from public, anon, authenticated;
revoke all privileges on function public.claim_deal_hunter_cim_opportunity(text, text, text, text[], timestamptz, jsonb) from public, anon, authenticated;
revoke all privileges on function public.claim_deal_hunter_cim_recipient(text, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
revoke all privileges on function public.link_deal_hunter_opportunity_aliases(jsonb) from public, anon, authenticated;
revoke all privileges on function public.apply_deal_hunter_cim_identity_repair(jsonb) from public, anon, authenticated;

grant all privileges on table public.deal_hunter_opportunities to service_role;
grant all privileges on table public.deal_hunter_opportunity_aliases to service_role;
grant all privileges on table public.deal_hunter_identity_exceptions to service_role;
grant all privileges on table public.deal_hunter_cim_opportunity_claims to service_role;
grant all privileges on table public.deal_hunter_cim_recipient_overrides to service_role;
grant all privileges on table public.deal_hunter_cim_recipient_claims to service_role;
grant all privileges on table public.deal_hunter_cim_safety_settings to service_role;
grant all privileges on table public.deal_hunter_cim_repair_manifests to service_role;
grant execute on function public.claim_deal_hunter_cim_opportunity(text, text, text, text[], timestamptz, jsonb) to service_role;
grant execute on function public.claim_deal_hunter_cim_recipient(text, text, text, timestamptz, timestamptz, jsonb) to service_role;
grant execute on function public.link_deal_hunter_opportunity_aliases(jsonb) to service_role;
grant execute on function public.apply_deal_hunter_cim_identity_repair(jsonb) to service_role;

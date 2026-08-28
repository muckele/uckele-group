-- Canonical opportunities remain historically readable after supersession, but
-- every function that grants new operational authority must require the exact
-- current status. This migration intentionally replaces functions only.

create or replace function public.insert_submission_with_crm_activity(
  p_payload jsonb,
  p_activity jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_record jsonb;
  v_activity jsonb;
  v_opportunity_id text := nullif(btrim(p_payload #>> '{submission,deal_hunter_opportunity_id}'), '');
begin
  if p_activity is null then
    raise exception 'CRM activity is required';
  end if;

  if v_opportunity_id is not null then
    perform 1
    from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id and status = 'active'
    for update;
    if not found then
      raise exception 'canonical opportunity is superseded or otherwise not current';
    end if;
  end if;

  insert into public.contact_submissions
  select * from jsonb_populate_record(null::public.contact_submissions, p_payload -> 'submission')
  returning to_jsonb(contact_submissions) into v_record;

  insert into public.crm_activity_events
  select * from jsonb_populate_record(null::public.crm_activity_events, p_activity)
  returning to_jsonb(crm_activity_events) into v_activity;

  return jsonb_build_object('applied', true, 'record', v_record, 'activity', v_activity);
end;
$$;

create or replace function public.upsert_deal_hunter_opportunity(p_record jsonb)
returns public.deal_hunter_opportunities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opportunity public.deal_hunter_opportunities;
  v_opportunity_id text := p_record->>'opportunity_id';
begin
  if nullif(btrim(v_opportunity_id), '') is null then
    raise exception 'canonical opportunity id is required';
  end if;

  insert into public.deal_hunter_opportunities (
    opportunity_id, created_at, updated_at, canonical_name, canonical_recipient,
    canonical_location, primary_submission_id, identity_version, status, metadata
  ) values (
    v_opportunity_id,
    (p_record->>'created_at')::timestamptz,
    (p_record->>'updated_at')::timestamptz,
    p_record->>'canonical_name',
    nullif(p_record->>'canonical_recipient', ''),
    nullif(p_record->>'canonical_location', ''),
    nullif(p_record->>'primary_submission_id', '')::uuid,
    p_record->>'identity_version',
    coalesce(nullif(p_record->>'status', ''), 'active'),
    coalesce(p_record->'metadata', '{}'::jsonb)
  )
  on conflict (opportunity_id) do update set
    updated_at = excluded.updated_at,
    canonical_name = excluded.canonical_name,
    canonical_recipient = coalesce(excluded.canonical_recipient, public.deal_hunter_opportunities.canonical_recipient),
    canonical_location = coalesce(excluded.canonical_location, public.deal_hunter_opportunities.canonical_location),
    primary_submission_id = coalesce(excluded.primary_submission_id, public.deal_hunter_opportunities.primary_submission_id),
    identity_version = excluded.identity_version,
    status = excluded.status,
    metadata = excluded.metadata
  where public.deal_hunter_opportunities.status = 'active'
  returning * into v_opportunity;

  if v_opportunity.opportunity_id is null then
    select * into v_opportunity
    from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id;
  end if;
  return v_opportunity;
end;
$$;

create or replace function public.create_deal_hunter_opportunity_with_aliases(
  p_opportunity jsonb,
  p_aliases jsonb,
  p_existing_owner_mode text default 'return-current',
  p_identity_exception jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_proposed_opportunity_id text := nullif(btrim(p_opportunity->>'opportunity_id'), '');
  v_existing_owner_mode text := coalesce(nullif(btrim(p_existing_owner_mode), ''), 'return-current');
  v_alias_key text;
  v_item jsonb;
  v_owner_ids text[] := array[]::text[];
  v_target_opportunity_id text;
  v_created boolean := false;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_identity_exception public.deal_hunter_identity_exceptions%rowtype;
  v_resolved_identity_exception public.deal_hunter_identity_exceptions%rowtype;
  v_linked_aliases jsonb := '[]'::jsonb;
begin
  if v_proposed_opportunity_id is null or p_opportunity->>'status' <> 'active' then
    raise exception 'atomic canonical opportunity creation requires one active opportunity';
  end if;
  if v_existing_owner_mode not in ('return-current', 'conflict') then
    raise exception 'unsupported canonical opportunity existing-owner mode';
  end if;
  if jsonb_typeof(coalesce(p_aliases, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_aliases, '[]'::jsonb)) = 0 then
    raise exception 'atomic canonical opportunity creation requires at least one alias';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_aliases) as item(value)
    where nullif(btrim(item.value->>'alias_key'), '') is null
      or item.value->>'opportunity_id' is distinct from v_proposed_opportunity_id
  ) then
    raise exception 'atomic canonical opportunity aliases must target the proposed opportunity';
  end if;

  if p_identity_exception is not null then
    if nullif(btrim(p_identity_exception->>'id'), '') is null
      or p_identity_exception->>'status' <> 'resolved'
      or nullif(btrim(p_identity_exception->>'resolved_at'), '') is null
      or nullif(btrim(p_identity_exception->>'resolved_by'), '') is null
      or nullif(btrim(p_identity_exception->>'resolution_reason'), '') is null then
      raise exception 'atomic identity exception resolution is incomplete';
    end if;
    select * into v_identity_exception
    from public.deal_hunter_identity_exceptions
    where id = p_identity_exception->>'id'
    for update;
    if not found then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object('reason', 'identity-exception-not-open'),
        'opportunity', null, 'aliases', '[]'::jsonb, 'identityException', null
      );
    end if;
    if v_identity_exception.status <> 'open'
      or v_identity_exception.resolved_at is not null
      or v_identity_exception.resolved_by is not null
      or v_identity_exception.resolution_reason is not null then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object('reason', 'identity-exception-not-open'),
        'opportunity', null, 'aliases', '[]'::jsonb,
        'identityException', to_jsonb(v_identity_exception)
      );
    end if;
  end if;

  -- Canonical alias/opportunity lock order: complete distinct alias keys in
  -- sorted order, alias advisory locks, owner discovery, sorted opportunity
  -- row locks, revalidation, then mutation.
  for v_alias_key in
    select distinct item.value->>'alias_key' as alias_key
    from jsonb_array_elements(p_aliases) as item(value)
    order by alias_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('deal-hunter-opportunity-alias:' || v_alias_key, 0)
    );
  end loop;

  select coalesce(
    array_agg(distinct alias.opportunity_id order by alias.opportunity_id),
    array[]::text[]
  ) into v_owner_ids
  from public.deal_hunter_opportunity_aliases as alias
  join jsonb_array_elements(p_aliases) as item(value)
    on item.value->>'alias_key' = alias.alias_key;

  if cardinality(v_owner_ids) > 1 then
    return jsonb_build_object(
      'created', false, 'linked', false,
      'conflict', jsonb_build_object(
        'reason', 'conflicting-alias-owners',
        'opportunity_id', v_owner_ids[1],
        'opportunity_ids', to_jsonb(v_owner_ids),
        'alias_key', ''
      ),
      'opportunity', null, 'aliases', '[]'::jsonb,
      'identityException', case when p_identity_exception is null then null else to_jsonb(v_identity_exception) end
    );
  end if;

  if cardinality(v_owner_ids) = 1 then
    v_target_opportunity_id := v_owner_ids[1];
    select * into v_opportunity
    from public.deal_hunter_opportunities
    where opportunity_id = v_target_opportunity_id
    for update;
    if not found then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object(
          'reason', 'alias-owner-missing',
          'opportunity_id', v_target_opportunity_id,
          'opportunity_ids', to_jsonb(v_owner_ids),
          'alias_key', ''
        ),
        'opportunity', null, 'aliases', '[]'::jsonb,
        'identityException', case when p_identity_exception is null then null else to_jsonb(v_identity_exception) end
      );
    end if;
    if v_opportunity.status <> 'active' then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object(
          'reason', 'alias-owner-not-current',
          'opportunity_id', v_target_opportunity_id,
          'alias_key', ''
        ),
        'opportunity', to_jsonb(v_opportunity), 'aliases', '[]'::jsonb,
        'identityException', case when p_identity_exception is null then null else to_jsonb(v_identity_exception) end
      );
    end if;
    if v_existing_owner_mode = 'conflict' then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object(
          'reason', 'alias-owner-exists',
          'opportunity_id', v_target_opportunity_id,
          'alias_key', ''
        ),
        'opportunity', to_jsonb(v_opportunity), 'aliases', '[]'::jsonb,
        'identityException', case when p_identity_exception is null then null else to_jsonb(v_identity_exception) end
      );
    end if;
  else
    perform 1
    from public.deal_hunter_opportunities
    where opportunity_id = v_proposed_opportunity_id
    for update;
    if found then
      return jsonb_build_object(
        'created', false, 'linked', false,
        'conflict', jsonb_build_object(
          'reason', 'proposed-opportunity-id-exists',
          'opportunity_id', v_proposed_opportunity_id,
          'alias_key', ''
        ),
        'opportunity', null, 'aliases', '[]'::jsonb,
        'identityException', case when p_identity_exception is null then null else to_jsonb(v_identity_exception) end
      );
    end if;
    insert into public.deal_hunter_opportunities (
      opportunity_id, created_at, updated_at, canonical_name, canonical_recipient,
      canonical_location, primary_submission_id, identity_version, status, metadata
    ) values (
      v_proposed_opportunity_id,
      (p_opportunity->>'created_at')::timestamptz,
      (p_opportunity->>'updated_at')::timestamptz,
      p_opportunity->>'canonical_name',
      nullif(p_opportunity->>'canonical_recipient', ''),
      nullif(p_opportunity->>'canonical_location', ''),
      nullif(p_opportunity->>'primary_submission_id', '')::uuid,
      p_opportunity->>'identity_version',
      'active',
      coalesce(p_opportunity->'metadata', '{}'::jsonb)
    ) returning * into v_opportunity;
    v_target_opportunity_id := v_proposed_opportunity_id;
    v_created := true;
  end if;

  for v_item in
    select item.value
    from jsonb_array_elements(p_aliases) as item(value)
    order by item.value->>'alias_key'
  loop
    insert into public.deal_hunter_opportunity_aliases (
      id, opportunity_id, alias_type, alias_value, alias_key, source,
      first_observed_at, last_observed_at, evidence_version, resolution_method,
      confidence_state, resolved_by, metadata
    ) values (
      v_item->>'id',
      v_target_opportunity_id,
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

  if exists (
    select 1
    from public.deal_hunter_opportunity_aliases as alias
    join jsonb_array_elements(p_aliases) as item(value)
      on item.value->>'alias_key' = alias.alias_key
    where alias.opportunity_id <> v_target_opportunity_id
  ) then
    raise exception 'atomic canonical opportunity alias acquisition failed its owner postcondition';
  end if;

  select coalesce(jsonb_agg(to_jsonb(alias) order by alias.alias_key), '[]'::jsonb)
  into v_linked_aliases
  from public.deal_hunter_opportunity_aliases as alias
  where alias.alias_key in (
    select distinct item.value->>'alias_key'
    from jsonb_array_elements(p_aliases) as item(value)
  );

  if p_identity_exception is not null then
    update public.deal_hunter_identity_exceptions
    set updated_at = (p_identity_exception->>'updated_at')::timestamptz,
        status = 'resolved',
        resolved_at = (p_identity_exception->>'resolved_at')::timestamptz,
        resolved_by = p_identity_exception->>'resolved_by',
        resolution_reason = p_identity_exception->>'resolution_reason',
        metadata = coalesce(p_identity_exception->'metadata', '{}'::jsonb)
    where id = p_identity_exception->>'id'
      and status = 'open'
      and resolved_at is null
      and resolved_by is null
      and resolution_reason is null
    returning * into v_resolved_identity_exception;
    if not found then
      raise exception 'atomic canonical opportunity creation could not resolve the expected open identity exception';
    end if;
  end if;

  return jsonb_build_object(
    'created', v_created,
    'linked', true,
    'conflict', null,
    'opportunity', to_jsonb(v_opportunity),
    'aliases', v_linked_aliases,
    'identityException', case
      when p_identity_exception is null then null
      else to_jsonb(v_resolved_identity_exception)
    end
  );
end;
$$;

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
  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = p_opportunity_id and status = 'active'
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'opportunity-not-current', 'claim', null);
  end if;

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
  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = p_opportunity_id and status = 'active'
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'opportunity-not-current', 'claim', null);
  end if;

  select * into v_existing
  from public.deal_hunter_cim_recipient_claims
  where recipient_email = v_recipient
  for update;
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
  v_alias_key text;
  v_item jsonb;
  v_owner_ids text[] := array[]::text[];
  v_revalidated_owner_ids text[] := array[]::text[];
  v_opportunity_ids text[] := array[]::text[];
  v_locked_opportunity_count integer := 0;
  v_target_opportunity_id text;
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
  ) <> 1 or exists (
    select 1
    from jsonb_array_elements(p_aliases)
    where nullif(btrim(value->>'opportunity_id'), '') is null
  ) then
    raise exception 'canonical alias batch must target exactly one opportunity';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_aliases)
    where nullif(btrim(value->>'alias_key'), '') is null
  ) then
    raise exception 'canonical alias key is required';
  end if;

  select value->>'opportunity_id'
  into v_target_opportunity_id
  from jsonb_array_elements(p_aliases)
  limit 1;

  -- Canonical alias/opportunity lock order: complete distinct alias keys in
  -- sorted order, alias advisory locks, owner discovery, sorted opportunity
  -- row locks, revalidation, then mutation.
  for v_alias_key in
    select distinct item.value->>'alias_key' as alias_key
    from jsonb_array_elements(p_aliases) as item(value)
    order by alias_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('deal-hunter-opportunity-alias:' || v_alias_key, 0)
    );
  end loop;

  select coalesce(
    array_agg(distinct alias.opportunity_id order by alias.opportunity_id),
    array[]::text[]
  ) into v_owner_ids
  from public.deal_hunter_opportunity_aliases as alias
  join jsonb_array_elements(p_aliases) as item(value)
    on item.value->>'alias_key' = alias.alias_key;

  select coalesce(
    array_agg(distinct candidate.opportunity_id order by candidate.opportunity_id),
    array[]::text[]
  ) into v_opportunity_ids
  from unnest(array_append(v_owner_ids, v_target_opportunity_id)) as candidate(opportunity_id);

  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = any(v_opportunity_ids)
  order by opportunity_id
  for update;
  get diagnostics v_locked_opportunity_count = row_count;

  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = v_target_opportunity_id and status = 'active';
  if not found then
    raise exception 'canonical alias target is superseded or otherwise not current';
  end if;

  if v_locked_opportunity_count <> cardinality(v_opportunity_ids) then
    select alias.alias_key, alias.opportunity_id
    into v_conflict_alias_key, v_conflict_opportunity_id
    from public.deal_hunter_opportunity_aliases as alias
    join jsonb_array_elements(p_aliases) as item(value)
      on item.value->>'alias_key' = alias.alias_key
    left join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = alias.opportunity_id
    where opportunity.opportunity_id is null
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
    raise exception 'canonical alias owner set changed while locking opportunities';
  end if;

  select coalesce(
    array_agg(distinct alias.opportunity_id order by alias.opportunity_id),
    array[]::text[]
  ) into v_revalidated_owner_ids
  from public.deal_hunter_opportunity_aliases as alias
  join jsonb_array_elements(p_aliases) as item(value)
    on item.value->>'alias_key' = alias.alias_key;
  if v_revalidated_owner_ids is distinct from v_owner_ids then
    raise exception 'canonical alias owner set changed while locking opportunities';
  end if;

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

  for v_item in
    select value
    from jsonb_array_elements(p_aliases)
    order by value->>'alias_key'
  loop
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

create or replace function public.link_deal_hunter_crm_submission(
  p_opportunity_id text,
  p_submission_id uuid,
  p_updated_at timestamptz
) returns public.deal_hunter_opportunities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opportunity public.deal_hunter_opportunities;
  v_submission_opportunity_id text;
begin
  perform pg_advisory_xact_lock(hashtextextended('deal-hunter-crm:' || p_opportunity_id, 0));
  select * into v_opportunity
  from public.deal_hunter_opportunities
  where opportunity_id = p_opportunity_id and status = 'active'
  for update;
  if not found then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;

  select deal_hunter_opportunity_id into v_submission_opportunity_id
  from public.contact_submissions
  where id = p_submission_id
  for update;
  if not found then raise exception 'CRM submission not found'; end if;
  if v_submission_opportunity_id is not null
    and v_submission_opportunity_id <> ''
    and v_submission_opportunity_id <> p_opportunity_id then
    raise exception 'CRM submission already belongs to another canonical opportunity';
  end if;
  if exists (
    select 1 from public.contact_submissions
    where deal_hunter_opportunity_id = p_opportunity_id and id <> p_submission_id
  ) then
    raise exception 'canonical opportunity already owns another CRM submission';
  end if;
  if v_opportunity.primary_submission_id is not null
    and v_opportunity.primary_submission_id <> p_submission_id then
    raise exception 'canonical opportunity primary CRM ownership conflict';
  end if;

  update public.contact_submissions
    set deal_hunter_opportunity_id = p_opportunity_id, updated_at = greatest(updated_at, p_updated_at)
    where id = p_submission_id;
  update public.deal_hunter_opportunities
    set primary_submission_id = p_submission_id, updated_at = greatest(updated_at, p_updated_at)
    where opportunity_id = p_opportunity_id and status = 'active'
    returning * into v_opportunity;
  if v_opportunity.opportunity_id is null then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;
  return v_opportunity;
end;
$$;

create or replace function public.write_deal_hunter_opportunity_score(p_score jsonb, p_evidence jsonb)
returns public.deal_hunter_opportunity_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_score public.deal_hunter_opportunity_scores;
  v_item jsonb;
  v_index integer := 0;
  v_opportunity_id text := p_score->>'opportunity_id';
  v_fingerprint text := p_score->>'score_fingerprint';
  v_scored_at timestamptz := coalesce((p_score->>'scored_at')::timestamptz, now());
begin
  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = v_opportunity_id and status = 'active'
  for update;
  if not found then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;

  insert into public.deal_hunter_opportunity_scores (
    opportunity_id, created_at, scored_at, deal_key, name, state, listing_url, fit_score, score_status,
    confidence, completeness_score, contradiction_count, missing_evidence_count, should_remove, high_fit,
    gate_count, score_fingerprint, semantic_digest, engine_version, rules_version, profile_version,
    completeness_policy_version, dimensions, gates, applied_caps, missing_evidence, confidence_reasons, summary
  ) values (
    v_opportunity_id, v_scored_at, v_scored_at, nullif(p_score->>'deal_key', ''), nullif(p_score->>'name', ''),
    nullif(p_score->>'state', ''), nullif(p_score->>'listing_url', ''),
    coalesce((p_score->>'fit_score')::integer, 0), coalesce(p_score->>'score_status', 'provisional'),
    coalesce(p_score->>'confidence', 'low'), coalesce((p_score->>'completeness_score')::integer, 0),
    coalesce((p_score->>'contradiction_count')::integer, 0), coalesce((p_score->>'missing_evidence_count')::integer, 0),
    coalesce((p_score->>'should_remove')::boolean, false), coalesce((p_score->>'high_fit')::boolean, false),
    coalesce((p_score->>'gate_count')::integer, 0), v_fingerprint,
    nullif(p_score->>'semantic_digest', ''), p_score->>'engine_version',
    p_score->>'rules_version', p_score->>'profile_version', p_score->>'completeness_policy_version',
    coalesce(p_score->'dimensions', '[]'::jsonb), coalesce(p_score->'gates', '[]'::jsonb),
    coalesce(p_score->'applied_caps', '[]'::jsonb), coalesce(p_score->'missing_evidence', '[]'::jsonb),
    coalesce(p_score->'confidence_reasons', '[]'::jsonb), coalesce(p_score->'summary', '{}'::jsonb)
  )
  on conflict (opportunity_id) do update set
    scored_at = excluded.scored_at,
    deal_key = excluded.deal_key,
    name = excluded.name,
    state = excluded.state,
    listing_url = excluded.listing_url,
    fit_score = excluded.fit_score,
    score_status = excluded.score_status,
    confidence = excluded.confidence,
    completeness_score = excluded.completeness_score,
    contradiction_count = excluded.contradiction_count,
    missing_evidence_count = excluded.missing_evidence_count,
    should_remove = excluded.should_remove,
    high_fit = excluded.high_fit,
    gate_count = excluded.gate_count,
    score_fingerprint = excluded.score_fingerprint,
    semantic_digest = excluded.semantic_digest,
    engine_version = excluded.engine_version,
    rules_version = excluded.rules_version,
    profile_version = excluded.profile_version,
    completeness_policy_version = excluded.completeness_policy_version,
    dimensions = excluded.dimensions,
    gates = excluded.gates,
    applied_caps = excluded.applied_caps,
    missing_evidence = excluded.missing_evidence,
    confidence_reasons = excluded.confidence_reasons,
    summary = excluded.summary
  returning * into v_score;

  delete from public.deal_hunter_score_evidence where opportunity_id = v_opportunity_id;
  for v_item in select value from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) loop
    insert into public.deal_hunter_score_evidence (
      id, opportunity_id, score_fingerprint, created_at, dimension, rule_id, rule_label,
      evidence_class, field, value, observed_value, terms, source_id, source_name,
      source_record_id, listing_url, observed_at
    ) values (
      v_opportunity_id || ':' || v_fingerprint || ':' || v_index, v_opportunity_id, v_fingerprint, v_scored_at,
      nullif(v_item->>'dimension', ''), coalesce(v_item->>'ruleId', ''), coalesce(v_item->>'ruleLabel', ''),
      coalesce(v_item->>'evidenceClass', ''), nullif(v_item->>'field', ''), v_item->>'value',
      v_item->>'observedValue', coalesce(v_item->'terms', '[]'::jsonb), nullif(v_item->>'sourceId', ''),
      nullif(v_item->>'sourceName', ''), nullif(v_item->>'sourceRecordId', ''),
      nullif(v_item->>'listingUrl', ''), nullif(v_item->>'observedAt', '')
    );
    v_index := v_index + 1;
  end loop;
  return v_score;
end;
$$;

create or replace function public.reconcile_deal_hunter_current_score_eligibility(p_opportunity_ids text[])
returns table (activated bigint, deactivated bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supplied_ids text[];
  v_ids text[];
  v_activated bigint;
  v_deactivated bigint;
begin
  select coalesce(array_agg(distinct btrim(value)), array[]::text[])
  into v_supplied_ids
  from unnest(coalesce(p_opportunity_ids, array[]::text[])) as supplied(value)
  where nullif(btrim(value), '') is not null;

  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = any(v_supplied_ids) and status = 'active'
  order by opportunity_id
  for update;

  select coalesce(array_agg(opportunity.opportunity_id order by opportunity.opportunity_id), array[]::text[])
  into v_ids
  from public.deal_hunter_opportunities as opportunity
  join unnest(v_supplied_ids) as supplied(opportunity_id)
    on supplied.opportunity_id = opportunity.opportunity_id
  where opportunity.status = 'active';

  select count(*) into v_activated
  from public.deal_hunter_opportunity_scores as scores
  where scores.current_triage_eligible = false
    and scores.opportunity_id = any(v_ids);

  select count(*) into v_deactivated
  from public.deal_hunter_opportunity_scores as scores
  where scores.current_triage_eligible = true
    and not (scores.opportunity_id = any(v_ids));

  update public.deal_hunter_opportunity_scores
  set current_triage_eligible = case
    when opportunity_id = any(v_ids) then true
    else false
  end
  where current_triage_eligible is distinct from case
    when opportunity_id = any(v_ids) then true
    else false
  end;

  return query select v_activated, v_deactivated;
end;
$$;

create or replace function public.list_deal_hunter_opportunity_scores(
  p_view text, p_page integer, p_page_size integer, p_search text, p_sort text, p_direction text,
  p_min_score integer, p_confidence text, p_priority text, p_state text
) returns jsonb
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select scores.*, disposition.deal_key as dismissed_deal_key,
           disposition.reason as dismissed_reason, disposition.dismissed_at as dismissed_at
    from public.deal_hunter_opportunity_scores as scores
    join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = scores.opportunity_id
     and opportunity.status = 'active'
    left join public.deal_hunter_dispositions as disposition
      on disposition.deal_key = scores.deal_key and disposition.disposition = 'dismissed'
    where scores.current_triage_eligible = true
  ), filtered as (
    select * from candidates
    where (case
        when p_view = 'dismissed' then dismissed_deal_key is not null
        when p_view = 'needs-review' then dismissed_deal_key is null and should_remove = false
          and (reviewed_at is null or (case
            when reviewed_semantic_digest is not null then reviewed_semantic_digest <> coalesce(semantic_digest, '')
            else reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint
          end))
        when p_view = 'high-priority' then dismissed_deal_key is null and should_remove = false
          and (high_fit or operator_priority in ('urgent', 'high'))
        when p_view = 'watchlist' then dismissed_deal_key is null and should_remove = false
          and ((fit_score >= 60 and fit_score < 75) or operator_priority = 'watch')
        when p_view = 'low-confidence' then dismissed_deal_key is null and should_remove = false
          and (confidence = 'low' or contradiction_count > 0)
        else dismissed_deal_key is null
      end)
      and (coalesce(p_search, '') = ''
        or lower(coalesce(name, '')) like '%' || lower(p_search) || '%'
        or lower(coalesce(deal_key, '')) like '%' || lower(p_search) || '%')
      and (p_min_score is null or fit_score >= p_min_score)
      and (coalesce(p_confidence, '') = '' or confidence = p_confidence)
      and (coalesce(p_priority, '') = '' or operator_priority = p_priority)
      and (coalesce(p_state, '') = '' or upper(coalesce(state, '')) = upper(p_state))
  ), ordered as (
    select * from filtered
    order by
      case when lower(coalesce(p_direction, 'desc')) = 'asc' then
        case coalesce(p_sort, 'fit-score')
          when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric
          when 'completeness' then completeness_score::numeric
          when 'changed' then (case when reviewed_at is null then 1
            when reviewed_semantic_digest is not null then (case when reviewed_semantic_digest <> coalesce(semantic_digest, '') then 1 else 0 end)
            when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric
          else fit_score::numeric
        end
      end asc nulls last,
      case when lower(coalesce(p_direction, 'desc')) <> 'asc' then
        case coalesce(p_sort, 'fit-score')
          when 'confidence' then (case confidence when 'high' then 3 when 'medium' then 2 else 1 end)::numeric
          when 'completeness' then completeness_score::numeric
          when 'changed' then (case when reviewed_at is null then 1
            when reviewed_semantic_digest is not null then (case when reviewed_semantic_digest <> coalesce(semantic_digest, '') then 1 else 0 end)
            when reviewed_fingerprint is null or reviewed_fingerprint <> score_fingerprint then 1 else 0 end)::numeric
          else fit_score::numeric
        end
      end desc nulls last,
      case confidence when 'high' then 3 when 'medium' then 2 else 1 end desc,
      opportunity_id asc
    limit least(greatest(coalesce(p_page_size, 25), 1), 100)
    offset greatest(0, (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 25), 1), 100))
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(to_jsonb(ordered)) from ordered), '[]'::jsonb)
  );
$$;

create or replace function public.upsert_deal_hunter_cim_recipient_override(p_record jsonb)
returns public.deal_hunter_cim_recipient_overrides
language plpgsql
security definer
set search_path = public
as $$
declare
  v_override public.deal_hunter_cim_recipient_overrides;
  v_opportunity_id text := p_record->>'opportunity_id';
  v_existing_opportunity_id text;
begin
  select opportunity_id into v_existing_opportunity_id
  from public.deal_hunter_cim_recipient_overrides
  where id = p_record->>'id';
  if found and v_existing_opportunity_id <> v_opportunity_id then
    raise exception 'CIM recipient override ID already belongs to another canonical opportunity';
  end if;

  perform 1
  from public.deal_hunter_opportunities
  where opportunity_id = v_opportunity_id and status = 'active'
  for update;
  if not found then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;

  insert into public.deal_hunter_cim_recipient_overrides (
    id, opportunity_id, recipient_email, created_at, expires_at, consumed_at, created_by, reason, metadata
  ) values (
    p_record->>'id', v_opportunity_id, lower(p_record->>'recipient_email'),
    (p_record->>'created_at')::timestamptz, (p_record->>'expires_at')::timestamptz,
    nullif(p_record->>'consumed_at', '')::timestamptz, nullif(p_record->>'created_by', ''),
    p_record->>'reason', coalesce(p_record->'metadata', '{}'::jsonb)
  )
  on conflict (id) do update set
    expires_at = excluded.expires_at,
    consumed_at = excluded.consumed_at,
    reason = excluded.reason,
    metadata = excluded.metadata
  where public.deal_hunter_cim_recipient_overrides.opportunity_id = excluded.opportunity_id
  returning * into v_override;
  if v_override.id is null then
    raise exception 'CIM recipient override ID collision';
  end if;
  return v_override;
end;
$$;

create or replace function public.set_deal_hunter_opportunity_operator_decision(
  p_opportunity_id text,
  p_decision jsonb
)
returns public.deal_hunter_opportunity_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_score public.deal_hunter_opportunity_scores;
  v_opportunity_status text;
begin
  select status into v_opportunity_status
  from public.deal_hunter_opportunities
  where opportunity_id = p_opportunity_id
  for update;
  if not found then
    return null;
  end if;
  if v_opportunity_status <> 'active' then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;

  update public.deal_hunter_opportunity_scores
  set operator_priority = case when p_decision ? 'operator_priority' then p_decision->>'operator_priority' else operator_priority end,
      operator_note = case when p_decision ? 'operator_note' then p_decision->>'operator_note' else operator_note end,
      reviewed_at = case when p_decision ? 'reviewed_at' then (p_decision->>'reviewed_at')::timestamptz else reviewed_at end,
      reviewed_by = case when p_decision ? 'reviewed_by' then p_decision->>'reviewed_by' else reviewed_by end,
      reviewed_fingerprint = case when p_decision ? 'reviewed_fingerprint' then p_decision->>'reviewed_fingerprint' else reviewed_fingerprint end,
      reviewed_semantic_digest = case when p_decision ? 'reviewed_semantic_digest' then p_decision->>'reviewed_semantic_digest' else reviewed_semantic_digest end,
      operator_updated_at = coalesce((p_decision->>'operator_updated_at')::timestamptz, now())
  where opportunity_id = p_opportunity_id
  returning * into v_score;
  return v_score;
end;
$$;

revoke all privileges on function public.insert_submission_with_crm_activity(jsonb, jsonb) from public, anon, authenticated;
revoke all privileges on function public.upsert_deal_hunter_opportunity(jsonb) from public, anon, authenticated;
revoke all privileges on function public.create_deal_hunter_opportunity_with_aliases(jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all privileges on function public.claim_deal_hunter_cim_opportunity(text, text, text, text[], timestamptz, jsonb) from public, anon, authenticated;
revoke all privileges on function public.claim_deal_hunter_cim_recipient(text, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
revoke all privileges on function public.link_deal_hunter_opportunity_aliases(jsonb) from public, anon, authenticated;
revoke all privileges on function public.link_deal_hunter_crm_submission(text, uuid, timestamptz) from public, anon, authenticated;
revoke all privileges on function public.write_deal_hunter_opportunity_score(jsonb, jsonb) from public, anon, authenticated;
revoke all privileges on function public.reconcile_deal_hunter_current_score_eligibility(text[]) from public, anon, authenticated;
revoke all privileges on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) from public, anon, authenticated;
revoke all privileges on function public.upsert_deal_hunter_cim_recipient_override(jsonb) from public, anon, authenticated;
revoke all privileges on function public.set_deal_hunter_opportunity_operator_decision(text, jsonb) from public, anon, authenticated;

grant execute on function public.insert_submission_with_crm_activity(jsonb, jsonb) to service_role;
grant execute on function public.upsert_deal_hunter_opportunity(jsonb) to service_role;
grant execute on function public.create_deal_hunter_opportunity_with_aliases(jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.claim_deal_hunter_cim_opportunity(text, text, text, text[], timestamptz, jsonb) to service_role;
grant execute on function public.claim_deal_hunter_cim_recipient(text, text, text, timestamptz, timestamptz, jsonb) to service_role;
grant execute on function public.link_deal_hunter_opportunity_aliases(jsonb) to service_role;
grant execute on function public.link_deal_hunter_crm_submission(text, uuid, timestamptz) to service_role;
grant execute on function public.write_deal_hunter_opportunity_score(jsonb, jsonb) to service_role;
grant execute on function public.reconcile_deal_hunter_current_score_eligibility(text[]) to service_role;
grant execute on function public.list_deal_hunter_opportunity_scores(text, integer, integer, text, text, text, integer, text, text, text) to service_role;
grant execute on function public.upsert_deal_hunter_cim_recipient_override(jsonb) to service_role;
grant execute on function public.set_deal_hunter_opportunity_operator_decision(text, jsonb) to service_role;

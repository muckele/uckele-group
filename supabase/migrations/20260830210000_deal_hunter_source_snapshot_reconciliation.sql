-- Reconcile every current source-record position for one already-resolved
-- canonical opportunity and one complete source. This is intentionally a
-- function-only upgrade: existing observations remain durable until a proven
-- complete source run replaces their canonical-opportunity/source scope.

create or replace function public.upsert_deal_hunter_opportunity_source_observation(
  p_id text,
  p_opportunity_id text,
  p_source_id text,
  p_source_name text,
  p_source_record_id text,
  p_field text,
  p_value text,
  p_observed_at timestamptz,
  p_created_at timestamptz,
  p_updated_at timestamptz
)
returns public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_observation public.deal_hunter_opportunity_source_observations;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_source_id)::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_opportunity_id, p_source_id)::text,
      0
    )
  );
  insert into public.deal_hunter_opportunity_source_observations (
    id, opportunity_id, source_id, source_name, source_record_id, field, value,
    observed_at, created_at, updated_at
  ) values (
    p_id, p_opportunity_id, p_source_id, p_source_name, p_source_record_id, p_field, p_value,
    p_observed_at, p_created_at, p_updated_at
  )
  on conflict (opportunity_id, source_id, source_record_id, field) do update set
    source_name = excluded.source_name,
    value = excluded.value,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at
  returning * into v_observation;
  return v_observation;
end;
$$;

revoke all privileges on function public.upsert_deal_hunter_opportunity_source_observation(
  text, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.upsert_deal_hunter_opportunity_source_observation(
  text, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz
) to service_role;

create or replace function public.replace_deal_hunter_opportunity_source_observation_snapshot(
  p_opportunity_id text,
  p_source_id text,
  p_source_name text,
  p_source_record_id text,
  p_observations jsonb
)
returns setof public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_catalog.jsonb_typeof(p_observations) <> 'array' then
    raise exception 'source observation snapshot must be a JSON array';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_observations) as incoming(
      id text, opportunity_id text, source_id text, source_name text, source_record_id text,
      field text, value text, observed_at timestamptz, created_at timestamptz, updated_at timestamptz
    )
    where incoming.opportunity_id is distinct from p_opportunity_id
      or incoming.source_id is distinct from p_source_id
      or incoming.source_name is distinct from p_source_name
      or incoming.source_record_id is distinct from p_source_record_id
  ) then
    raise exception 'source observation snapshot rows must share one source record identity';
  end if;

  -- The complete canonical-opportunity/source replacement below takes this
  -- same source lock first. Acquiring it here preserves a single lock order
  -- when an incremental writer overlaps either complete reconciliation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_source_id)::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_opportunity_id, p_source_id)::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_opportunity_id, p_source_id, p_source_record_id)::text,
      0
    )
  );

  delete from public.deal_hunter_opportunity_source_observations as stored
  where stored.opportunity_id = p_opportunity_id
    and stored.source_id = p_source_id
    and stored.source_record_id = p_source_record_id
    and not exists (
      select 1
      from pg_catalog.jsonb_to_recordset(p_observations) as incoming(field text)
      where incoming.field = stored.field
    );

  insert into public.deal_hunter_opportunity_source_observations (
    id, opportunity_id, source_id, source_name, source_record_id, field, value,
    observed_at, created_at, updated_at
  )
  select
    incoming.id, incoming.opportunity_id, incoming.source_id, incoming.source_name, incoming.source_record_id,
    incoming.field, incoming.value, incoming.observed_at, incoming.created_at, incoming.updated_at
  from pg_catalog.jsonb_to_recordset(p_observations) as incoming(
    id text, opportunity_id text, source_id text, source_name text, source_record_id text,
    field text, value text, observed_at timestamptz, created_at timestamptz, updated_at timestamptz
  )
  on conflict (opportunity_id, source_id, source_record_id, field) do update set
    source_name = excluded.source_name,
    value = excluded.value,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at;

  return query
  select *
  from public.deal_hunter_opportunity_source_observations
  where opportunity_id = p_opportunity_id
    and source_id = p_source_id
    and source_record_id = p_source_record_id
  order by observed_at desc, id asc;
end;
$$;

revoke all privileges on function public.replace_deal_hunter_opportunity_source_observation_snapshot(
  text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_deal_hunter_opportunity_source_observation_snapshot(
  text, text, text, text, jsonb
) to service_role;

create or replace function public.replace_deal_hunter_opportunity_source_snapshot(
  p_opportunity_id text,
  p_source_id text,
  p_source_name text,
  p_records jsonb
)
returns setof public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record_count integer;
begin
  if p_opportunity_id is null or p_opportunity_id <> btrim(p_opportunity_id) or char_length(p_opportunity_id) not between 1 and 200
    or p_source_id is null or p_source_id <> btrim(p_source_id) or char_length(p_source_id) not between 1 and 160
    or p_source_name is null or p_source_name <> btrim(p_source_name) or char_length(p_source_name) not between 1 and 220 then
    raise exception 'complete source snapshot identity is outside the allowed contract' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_records) <> 'array' then
    raise exception 'complete source snapshot records must be a JSON array' using errcode = '22023';
  end if;
  v_record_count := pg_catalog.jsonb_array_length(p_records);
  if v_record_count not between 1 and 10000 then
    raise exception 'complete source snapshot must contain between 1 and 10000 records' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    where pg_catalog.jsonb_typeof(record.value) <> 'object'
      or not (record.value ?& array['opportunity_id', 'source_id', 'source_name', 'source_record_id', 'observations'])
      or record.value - array['opportunity_id', 'source_id', 'source_name', 'source_record_id', 'observations'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(record.value -> 'opportunity_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_name') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_record_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'observations') <> 'array'
      or (record.value ->> 'opportunity_id') is distinct from p_opportunity_id
      or (record.value ->> 'source_id') is distinct from p_source_id
      or (record.value ->> 'source_name') is distinct from p_source_name
      or (record.value ->> 'source_record_id') <> btrim(record.value ->> 'source_record_id')
      or char_length(record.value ->> 'source_record_id') not between 1 and 200
      or pg_catalog.jsonb_array_length(record.value -> 'observations') > 51
  ) then
    raise exception 'complete source snapshot records are outside the allowed contract' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    group by record.value ->> 'source_record_id'
    having count(*) > 1
  ) then
    raise exception 'complete source snapshot record identities must be unique' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
    where pg_catalog.jsonb_typeof(observation.value) <> 'object'
      or not (observation.value ?& array['id', 'opportunity_id', 'source_id', 'source_name', 'source_record_id', 'field', 'value', 'observed_at', 'created_at', 'updated_at'])
      or observation.value - array['id', 'opportunity_id', 'source_id', 'source_name', 'source_record_id', 'field', 'value', 'observed_at', 'created_at', 'updated_at'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(observation.value -> 'id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'opportunity_id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'source_id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'source_name') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'source_record_id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'field') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'value') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'observed_at') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'created_at') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'updated_at') <> 'string'
      or (observation.value ->> 'opportunity_id') is distinct from p_opportunity_id
      or (observation.value ->> 'source_id') is distinct from p_source_id
      or (observation.value ->> 'source_name') is distinct from p_source_name
      or (observation.value ->> 'source_record_id') is distinct from (record.value ->> 'source_record_id')
      or (observation.value ->> 'id') <> btrim(observation.value ->> 'id')
      or char_length(observation.value ->> 'id') not between 1 and 240
      or (observation.value ->> 'field') not in (
        'name', 'business_name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
        'annual_profit', 'annual_revenue', 'asking_price', 'profit_multiple', 'net_margin', 'years_established',
        'remote_flag', 'franchise_flag', 'five_years_flag', 'broker_name', 'broker_company', 'broker_contact', 'broker_email',
        'broker_phone', 'company', 'role', 'seller_name', 'seller_email', 'seller_phone', 'reason_for_sale', 'real_estate_included',
        'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes', 'listing_url',
        'listing_source', 'listing_id', 'deal_key', 'source_identity', 'date_added', 'last_updated',
        'business_website', 'prospectus_url', 'ttm_revenue', 'ttm_ebitda', 'ebitda_multiple', 'business_age',
        'sba_eligible', 'lead_type'
      )
      or (observation.value ->> 'value') <> btrim(observation.value ->> 'value')
      or char_length(observation.value ->> 'value') not between 1 and 5000
      or (observation.value ->> 'observed_at') <> btrim(observation.value ->> 'observed_at')
      or char_length(observation.value ->> 'observed_at') not between 1 and 80
      or (observation.value ->> 'created_at') <> btrim(observation.value ->> 'created_at')
      or char_length(observation.value ->> 'created_at') not between 1 and 80
      or (observation.value ->> 'updated_at') <> btrim(observation.value ->> 'updated_at')
      or char_length(observation.value ->> 'updated_at') not between 1 and 80
  ) then
    raise exception 'complete source snapshot observations are outside the allowed contract' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
    group by record.value ->> 'source_record_id', observation.value ->> 'field'
    having count(*) > 1
  ) then
    raise exception 'complete source snapshot observation fields must be unique per source record' using errcode = '22023';
  end if;
  begin
    perform
      (observation.value ->> 'observed_at')::timestamptz,
      (observation.value ->> 'created_at')::timestamptz,
      (observation.value ->> 'updated_at')::timestamptz
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value);
  exception when others then
    raise exception 'complete source snapshot timestamps must be valid' using errcode = '22023';
  end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_source_id)::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_opportunity_id, p_source_id)::text,
      0
    )
  );

  delete from public.deal_hunter_opportunity_source_observations as stored
  where stored.opportunity_id = p_opportunity_id
    and stored.source_id = p_source_id
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_records) as record(value)
      cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
      where (record.value ->> 'source_record_id') = stored.source_record_id
        and (observation.value ->> 'field') = stored.field
    );

  insert into public.deal_hunter_opportunity_source_observations (
    id, opportunity_id, source_id, source_name, source_record_id, field, value,
    observed_at, created_at, updated_at
  )
  select
    observation.value ->> 'id',
    p_opportunity_id,
    p_source_id,
    p_source_name,
    record.value ->> 'source_record_id',
    observation.value ->> 'field',
    observation.value ->> 'value',
    (observation.value ->> 'observed_at')::timestamptz,
    (observation.value ->> 'created_at')::timestamptz,
    (observation.value ->> 'updated_at')::timestamptz
  from pg_catalog.jsonb_array_elements(p_records) as record(value)
  cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
  on conflict (opportunity_id, source_id, source_record_id, field) do update set
    source_name = excluded.source_name,
    value = excluded.value,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at;

  return query
  select *
  from public.deal_hunter_opportunity_source_observations
  where opportunity_id = p_opportunity_id
    and source_id = p_source_id
  order by observed_at desc, id asc;
end;
$$;

revoke all privileges on function public.replace_deal_hunter_opportunity_source_snapshot(
  text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_deal_hunter_opportunity_source_snapshot(
  text, text, text, jsonb
) to service_role;

create or replace function public.replace_deal_hunter_source_snapshot(
  p_source_id text,
  p_source_name text,
  p_records jsonb
)
returns setof public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record_count integer;
begin
  if p_source_id is null or p_source_id <> btrim(p_source_id) or char_length(p_source_id) not between 1 and 160
    or p_source_name is null or p_source_name <> btrim(p_source_name) or char_length(p_source_name) not between 1 and 220 then
    raise exception 'complete source snapshot identity is outside the allowed contract' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_records) <> 'array' then
    raise exception 'complete source snapshot records must be a JSON array' using errcode = '22023';
  end if;
  v_record_count := pg_catalog.jsonb_array_length(p_records);
  if v_record_count not between 1 and 10000 then
    raise exception 'complete source snapshot must contain between 1 and 10000 records' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    where pg_catalog.jsonb_typeof(record.value) <> 'object'
      or not (record.value ?& array['opportunity_id', 'source_id', 'source_name', 'source_record_id', 'observations'])
      or record.value - array['opportunity_id', 'source_id', 'source_name', 'source_record_id', 'observations'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(record.value -> 'opportunity_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_name') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'source_record_id') <> 'string'
      or pg_catalog.jsonb_typeof(record.value -> 'observations') <> 'array'
      or (record.value ->> 'opportunity_id') <> btrim(record.value ->> 'opportunity_id')
      or char_length(record.value ->> 'opportunity_id') not between 1 and 200
      or (record.value ->> 'source_id') is distinct from p_source_id
      or (record.value ->> 'source_name') is distinct from p_source_name
      or (record.value ->> 'source_record_id') <> btrim(record.value ->> 'source_record_id')
      or char_length(record.value ->> 'source_record_id') not between 1 and 200
      or pg_catalog.jsonb_array_length(record.value -> 'observations') > 51
  ) then
    raise exception 'complete source snapshot records are outside the allowed contract' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    group by record.value ->> 'source_record_id'
    having count(*) > 1
  ) then
    raise exception 'complete source snapshot record identities must be unique within the source' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
    where pg_catalog.jsonb_typeof(observation.value) <> 'object'
      or not (observation.value ?& array['id', 'opportunity_id', 'source_id', 'source_name', 'source_record_id', 'field', 'value', 'observed_at', 'created_at', 'updated_at'])
      or observation.value - array['id', 'opportunity_id', 'source_id', 'source_name', 'source_record_id', 'field', 'value', 'observed_at', 'created_at', 'updated_at'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(observation.value -> 'id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'opportunity_id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'source_id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'source_name') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'source_record_id') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'field') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'value') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'observed_at') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'created_at') <> 'string'
      or pg_catalog.jsonb_typeof(observation.value -> 'updated_at') <> 'string'
      or (observation.value ->> 'opportunity_id') is distinct from (record.value ->> 'opportunity_id')
      or (observation.value ->> 'source_id') is distinct from p_source_id
      or (observation.value ->> 'source_name') is distinct from p_source_name
      or (observation.value ->> 'source_record_id') is distinct from (record.value ->> 'source_record_id')
      or (observation.value ->> 'id') <> btrim(observation.value ->> 'id')
      or char_length(observation.value ->> 'id') not between 1 and 240
      or (observation.value ->> 'field') not in (
        'name', 'business_name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
        'annual_profit', 'annual_revenue', 'asking_price', 'profit_multiple', 'net_margin', 'years_established',
        'remote_flag', 'franchise_flag', 'five_years_flag', 'broker_name', 'broker_company', 'broker_contact', 'broker_email',
        'broker_phone', 'company', 'role', 'seller_name', 'seller_email', 'seller_phone', 'reason_for_sale', 'real_estate_included',
        'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes', 'listing_url',
        'listing_source', 'listing_id', 'deal_key', 'source_identity', 'date_added', 'last_updated',
        'business_website', 'prospectus_url', 'ttm_revenue', 'ttm_ebitda', 'ebitda_multiple', 'business_age',
        'sba_eligible', 'lead_type'
      )
      or (observation.value ->> 'value') <> btrim(observation.value ->> 'value')
      or char_length(observation.value ->> 'value') not between 1 and 5000
      or (observation.value ->> 'observed_at') <> btrim(observation.value ->> 'observed_at')
      or char_length(observation.value ->> 'observed_at') not between 1 and 80
      or (observation.value ->> 'created_at') <> btrim(observation.value ->> 'created_at')
      or char_length(observation.value ->> 'created_at') not between 1 and 80
      or (observation.value ->> 'updated_at') <> btrim(observation.value ->> 'updated_at')
      or char_length(observation.value ->> 'updated_at') not between 1 and 80
  ) then
    raise exception 'complete source snapshot observations are outside the allowed contract' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
    group by record.value ->> 'source_record_id', observation.value ->> 'field'
    having count(*) > 1
  ) then
    raise exception 'complete source snapshot observation fields must be unique per source record' using errcode = '22023';
  end if;
  begin
    perform
      (observation.value ->> 'observed_at')::timestamptz,
      (observation.value ->> 'created_at')::timestamptz,
      (observation.value ->> 'updated_at')::timestamptz
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value);
  exception when others then
    raise exception 'complete source snapshot timestamps must be valid' using errcode = '22023';
  end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_source_id)::text,
      0
    )
  );

  with incoming as materialized (
    select
      record.value ->> 'opportunity_id' as opportunity_id,
      record.value ->> 'source_record_id' as source_record_id,
      observation.value ->> 'field' as field
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
  )
  delete from public.deal_hunter_opportunity_source_observations as stored
  where stored.source_id = p_source_id
    and not exists (
      select 1
      from incoming
      where incoming.opportunity_id = stored.opportunity_id
        and incoming.source_record_id = stored.source_record_id
        and incoming.field = stored.field
    );

  insert into public.deal_hunter_opportunity_source_observations (
    id, opportunity_id, source_id, source_name, source_record_id, field, value,
    observed_at, created_at, updated_at
  )
  select
    observation.value ->> 'id',
    record.value ->> 'opportunity_id',
    p_source_id,
    p_source_name,
    record.value ->> 'source_record_id',
    observation.value ->> 'field',
    observation.value ->> 'value',
    (observation.value ->> 'observed_at')::timestamptz,
    (observation.value ->> 'created_at')::timestamptz,
    (observation.value ->> 'updated_at')::timestamptz
  from pg_catalog.jsonb_array_elements(p_records) as record(value)
  cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value)
  on conflict (opportunity_id, source_id, source_record_id, field) do update set
    source_name = excluded.source_name,
    value = excluded.value,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at;

  return query
  select *
  from public.deal_hunter_opportunity_source_observations
  where source_id = p_source_id
  order by observed_at desc, id asc;
end;
$$;

revoke all privileges on function public.replace_deal_hunter_source_snapshot(
  text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_deal_hunter_source_snapshot(
  text, text, jsonb
) to service_role;

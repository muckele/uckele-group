-- A source-wide reconciliation can remove every current observation owned by a
-- source. Retire the generic service-role RPC in favor of an explicit,
-- complete-Google-Sheet admission command. The pre-existing reconciliation
-- body remains an uncallable internal helper so upgraded and fresh schemas
-- preserve the same atomic upsert/delete behavior without exposing generic
-- caller-chosen source IDs.
--
-- The RPC validates the serializable Sheet policy and exact payload
-- self-consistency; it cannot itself attest a remote fetch was complete.
-- That proof is intentionally made by the collector before it mints its
-- in-process, one-shot admission capability. Durable external attestation
-- would require an ingestion ledger or provider-owned fetch outside Phase 1.

revoke all privileges on function public.replace_deal_hunter_source_snapshot(
  text, text, jsonb
) from public, anon, authenticated, service_role;
alter function public.replace_deal_hunter_source_snapshot(text, text, jsonb)
  rename to replace_deal_hunter_source_snapshot_internal;
revoke all privileges on function public.replace_deal_hunter_source_snapshot_internal(
  text, text, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.replace_admitted_complete_google_sheet_source_snapshot(
  p_admission jsonb,
  p_records jsonb
)
returns setof public.deal_hunter_opportunity_source_observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_id text;
  v_source_name text;
  v_source_slot integer;
  v_record_count integer;
  v_observation_count integer;
  v_actual_observation_count integer;
  v_snapshot_digest text;
  v_record_digest text;
  v_actual_digest text;
begin
  if pg_catalog.jsonb_typeof(p_admission) <> 'object'
    or p_admission - array[
      'policy', 'source_id', 'source_name', 'source_slot', 'record_count',
      'observation_count', 'source_record_ids', 'snapshot_digest'
    ] <> '{}'::jsonb
    or not (p_admission ?& array[
      'policy', 'source_id', 'source_name', 'source_slot', 'record_count',
      'observation_count', 'source_record_ids', 'snapshot_digest'
    ])
    or pg_catalog.jsonb_typeof(p_admission -> 'policy') <> 'string'
    or pg_catalog.jsonb_typeof(p_admission -> 'source_id') <> 'string'
    or pg_catalog.jsonb_typeof(p_admission -> 'source_name') <> 'string'
    or pg_catalog.jsonb_typeof(p_admission -> 'source_slot') <> 'number'
    or pg_catalog.jsonb_typeof(p_admission -> 'record_count') <> 'number'
    or pg_catalog.jsonb_typeof(p_admission -> 'observation_count') <> 'number'
    or pg_catalog.jsonb_typeof(p_admission -> 'source_record_ids') <> 'array'
    or pg_catalog.jsonb_typeof(p_admission -> 'snapshot_digest') <> 'string'
  then
    raise exception 'complete Google Sheet source snapshot admission is outside the allowed contract' using errcode = '22023';
  end if;
  if p_admission ->> 'policy' <> 'complete-google-sheet-source-snapshot-v1'
    or p_admission ->> 'source_slot' !~ '^(0|[1-9][0-9]{0,3})$'
    or p_admission ->> 'record_count' !~ '^[1-9][0-9]*$'
    or p_admission ->> 'observation_count' !~ '^[1-9][0-9]*$'
    or p_admission ->> 'snapshot_digest' !~ '^[a-f0-9]{32}$'
  then
    raise exception 'complete Google Sheet source snapshot admission is malformed' using errcode = '22023';
  end if;

  v_source_id := p_admission ->> 'source_id';
  v_source_name := p_admission ->> 'source_name';
  v_source_slot := (p_admission ->> 'source_slot')::integer;
  v_record_count := (p_admission ->> 'record_count')::integer;
  v_observation_count := (p_admission ->> 'observation_count')::integer;
  v_snapshot_digest := p_admission ->> 'snapshot_digest';
  if v_source_id <> btrim(v_source_id) or char_length(v_source_id) not between 1 and 160
    or v_source_name <> btrim(v_source_name) or char_length(v_source_name) not between 1 and 220
    or v_source_slot not between 0 and 9999
    or v_source_id !~ '^sheet-[0-9]+$'
    or v_source_id <> ('sheet-' || v_source_slot::text)
    or v_record_count not between 1 and 10000
    or v_observation_count not between 1 and 510000
    or pg_catalog.jsonb_array_length(p_admission -> 'source_record_ids') <> v_record_count
  then
    raise exception 'complete Google Sheet source snapshot admission is not an admitted Sheet scope' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_admission -> 'source_record_ids') as identity(value)
    where pg_catalog.jsonb_typeof(identity.value) <> 'string'
      or (identity.value #>> '{}') <> btrim(identity.value #>> '{}')
      or char_length(identity.value #>> '{}') not between 1 and 200
  )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_admission -> 'source_record_ids') as identity(value)
      group by identity.value #>> '{}'
      having count(*) > 1
    )
  then
    raise exception 'complete Google Sheet source snapshot admission identities are outside the allowed contract' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_records) <> 'array'
    or pg_catalog.jsonb_array_length(p_records) <> v_record_count
  then
    raise exception 'complete Google Sheet source snapshot records do not match the admission' using errcode = '22023';
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
      or (record.value ->> 'source_id') is distinct from v_source_id
      or (record.value ->> 'source_name') is distinct from v_source_name
      or (record.value ->> 'source_record_id') <> btrim(record.value ->> 'source_record_id')
      or char_length(record.value ->> 'source_record_id') not between 1 and 200
      or pg_catalog.jsonb_array_length(record.value -> 'observations') not between 1 and 51
  ) then
    raise exception 'complete Google Sheet source snapshot records are outside the allowed contract' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as record(value)
    group by record.value ->> 'source_record_id'
    having count(*) > 1
  )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_records) as record(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_admission -> 'source_record_ids') as identity(value)
        where identity.value #>> '{}' = record.value ->> 'source_record_id'
      )
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_admission -> 'source_record_ids') as identity(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_records) as record(value)
        where record.value ->> 'source_record_id' = identity.value #>> '{}'
      )
    )
  then
    raise exception 'complete Google Sheet source snapshot records do not match the admitted identity set' using errcode = '22023';
  end if;
  select count(*)
  into v_actual_observation_count
  from pg_catalog.jsonb_array_elements(p_records) as record(value)
  cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as observation(value);
  if v_actual_observation_count <> v_observation_count then
    raise exception 'complete Google Sheet source snapshot observation count does not match the admission' using errcode = '22023';
  end if;

  select coalesce(
    pg_catalog.string_agg(
      pg_catalog.concat_ws(
        '|',
        'r',
        pg_catalog.encode(pg_catalog.convert_to(record.value ->> 'opportunity_id', 'UTF8'), 'hex'),
        pg_catalog.encode(pg_catalog.convert_to(record.value ->> 'source_id', 'UTF8'), 'hex'),
        pg_catalog.encode(pg_catalog.convert_to(record.value ->> 'source_name', 'UTF8'), 'hex'),
        pg_catalog.encode(pg_catalog.convert_to(record.value ->> 'source_record_id', 'UTF8'), 'hex'),
        pg_catalog.jsonb_array_length(record.value -> 'observations')::text,
        (
          select pg_catalog.string_agg(
            pg_catalog.concat_ws(
              '|',
              'o',
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'id', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'opportunity_id', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'source_id', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'source_name', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'source_record_id', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'field', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'value', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'observed_at', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'created_at', 'UTF8'), 'hex'),
              pg_catalog.encode(pg_catalog.convert_to(observation.value ->> 'updated_at', 'UTF8'), 'hex')
            ),
            '|' order by observation.ordinality
          )
          from pg_catalog.jsonb_array_elements(record.value -> 'observations') with ordinality as observation(value, ordinality)
        )
      ),
      '|' order by record.ordinality
    ),
    ''
  )
  into v_record_digest
  from pg_catalog.jsonb_array_elements(p_records) with ordinality as record(value, ordinality);
  v_actual_digest := pg_catalog.md5(pg_catalog.concat_ws(
    '|',
    'complete-google-sheet-source-snapshot-v1',
    pg_catalog.encode(pg_catalog.convert_to(v_source_id, 'UTF8'), 'hex'),
    pg_catalog.encode(pg_catalog.convert_to(v_source_name, 'UTF8'), 'hex'),
    v_source_slot::text,
    v_record_count::text,
    v_observation_count::text,
    v_record_digest
  ));
  if v_actual_digest <> v_snapshot_digest then
    raise exception 'complete Google Sheet source snapshot digest does not match the admission' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(v_source_id)::text,
      0
    )
  );
  return query
  select *
  from public.replace_deal_hunter_source_snapshot_internal(v_source_id, v_source_name, p_records);
end;
$$;

revoke all privileges on function public.replace_admitted_complete_google_sheet_source_snapshot(
  jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_admitted_complete_google_sheet_source_snapshot(
  jsonb, jsonb
) to service_role;

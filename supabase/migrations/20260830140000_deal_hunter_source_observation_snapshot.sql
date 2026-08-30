-- Replace every field for one source record in a single transaction. This is
-- deliberately downstream of canonical identity resolution: it guarantees a
-- source snapshot is never hybrid without changing canonical matching rules.

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
  if jsonb_typeof(p_observations) <> 'array' then
    raise exception 'source observation snapshot must be a JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_observations) as incoming(
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

  delete from public.deal_hunter_opportunity_source_observations as stored
  where stored.opportunity_id = p_opportunity_id
    and stored.source_id = p_source_id
    and stored.source_record_id = p_source_record_id
    and not exists (
      select 1
      from jsonb_to_recordset(p_observations) as incoming(field text)
      where incoming.field = stored.field
    );

  insert into public.deal_hunter_opportunity_source_observations (
    id, opportunity_id, source_id, source_name, source_record_id, field, value,
    observed_at, created_at, updated_at
  )
  select
    incoming.id, incoming.opportunity_id, incoming.source_id, incoming.source_name, incoming.source_record_id,
    incoming.field, incoming.value, incoming.observed_at, incoming.created_at, incoming.updated_at
  from jsonb_to_recordset(p_observations) as incoming(
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

-- The original fact table intentionally had no operator-content constraints so
-- existing provider/legacy revisions remain readable. This NOT VALID CHECK is
-- enforced for every new or updated row while avoiding a rewrite or validation
-- of those historical rows.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'deal_hunter_opportunity_facts_operator_boundary_check'
      and conrelid = 'public.deal_hunter_opportunity_facts'::regclass
  ) then
    alter table public.deal_hunter_opportunity_facts
      add constraint deal_hunter_opportunity_facts_operator_boundary_check
      check (
        id = btrim(id) and char_length(id) between 1 and 240
        and opportunity_id = btrim(opportunity_id) and char_length(opportunity_id) between 1 and 200
        and field in (
          'seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone',
          'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration',
          'operator_contact_notes'
        )
        and value = btrim(value) and char_length(value) between 1 and 4000
        and source = 'operator'
        and actor = btrim(actor) and char_length(actor) between 1 and 200
        and (note is null or (note = btrim(note) and char_length(note) between 1 and 4000))
      ) not valid;
  end if;
end;
$$;

create or replace function public.upsert_deal_hunter_opportunity_fact(
  p_id text,
  p_opportunity_id text,
  p_field text,
  p_value text,
  p_source text,
  p_verified boolean,
  p_actor text,
  p_note text,
  p_created_at timestamptz,
  p_updated_at timestamptz
)
returns public.deal_hunter_opportunity_facts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fact public.deal_hunter_opportunity_facts;
begin
  if p_source is distinct from 'operator' then
    raise exception 'operator fact source must be operator' using errcode = '22023';
  end if;
  insert into public.deal_hunter_opportunity_facts (
    id, opportunity_id, field, value, source, verified, actor, note, created_at, updated_at
  ) values (
    p_id, p_opportunity_id, p_field, p_value, p_source, p_verified, p_actor, p_note, p_created_at, p_updated_at
  )
  on conflict (id) do update set
    field = excluded.field,
    value = excluded.value,
    source = excluded.source,
    verified = excluded.verified,
    actor = excluded.actor,
    note = excluded.note,
    updated_at = excluded.updated_at
  returning * into v_fact;
  return v_fact;
end;
$$;

revoke all privileges on function public.upsert_deal_hunter_opportunity_fact(
  text, text, text, text, text, boolean, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.upsert_deal_hunter_opportunity_fact(
  text, text, text, text, text, boolean, text, text, timestamptz, timestamptz
) to service_role;

-- Current writes must be source=operator even though the historical fact
-- projection continues to retain legacy/provider rows with other sources.
create or replace function public.insert_current_deal_hunter_opportunity_fact(
  p_id text, p_opportunity_id text, p_field text, p_value text, p_source text,
  p_verified boolean, p_actor text, p_note text, p_created_at timestamptz, p_updated_at timestamptz
)
returns public.deal_hunter_opportunity_facts
language plpgsql
security definer
set search_path = public
as $$
declare v_fact public.deal_hunter_opportunity_facts;
begin
  if p_source is distinct from 'operator' then
    raise exception 'operator fact source must be operator' using errcode = '22023';
  end if;
  perform 1 from public.deal_hunter_opportunities where opportunity_id = p_opportunity_id and status = 'active' for update;
  if not found then raise exception 'current canonical opportunity is unavailable' using errcode = 'P0002'; end if;
  insert into public.deal_hunter_opportunity_facts (id, opportunity_id, field, value, source, verified, actor, note, created_at, updated_at)
  values (p_id, p_opportunity_id, p_field, p_value, p_source, p_verified, p_actor, p_note, p_created_at, p_updated_at)
  returning * into v_fact;
  return v_fact;
end;
$$;

revoke all privileges on function public.insert_current_deal_hunter_opportunity_fact(
  text, text, text, text, text, boolean, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.insert_current_deal_hunter_opportunity_fact(
  text, text, text, text, text, boolean, text, text, timestamptz, timestamptz
) to service_role;

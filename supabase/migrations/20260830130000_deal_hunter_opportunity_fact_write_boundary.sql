-- Constrain durable Task 2 writes to the same conflict contract as SQLite.
-- A fact ID owns its original opportunity and created_at. A source-observation
-- composite identity owns its ID and created_at. Refreshes update only the
-- explicitly mutable columns.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'deal_hunter_opportunity_source_observations_bounded_check'
      and conrelid = 'public.deal_hunter_opportunity_source_observations'::regclass
  ) then
    alter table public.deal_hunter_opportunity_source_observations
      add constraint deal_hunter_opportunity_source_observations_bounded_check
      check (
        id = btrim(id) and char_length(id) between 1 and 240
        and opportunity_id = btrim(opportunity_id) and char_length(opportunity_id) between 1 and 200
        and source_id = btrim(source_id) and char_length(source_id) between 1 and 160
        and source_name = btrim(source_name) and char_length(source_name) between 1 and 220
        and source_record_id = btrim(source_record_id) and char_length(source_record_id) between 1 and 200
        and field in (
          'name', 'business_name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
          'annual_profit', 'annual_revenue', 'asking_price', 'profit_multiple', 'net_margin', 'years_established',
          'remote_flag', 'franchise_flag', 'five_years_flag', 'broker_name', 'broker_company', 'broker_email',
          'broker_phone', 'seller_name', 'seller_email', 'seller_phone', 'reason_for_sale', 'real_estate_included',
          'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes', 'listing_url',
          'listing_source', 'listing_id', 'deal_key', 'source_identity', 'date_added', 'last_updated',
          'business_website', 'prospectus_url', 'ttm_revenue', 'ttm_ebitda', 'ebitda_multiple', 'business_age',
          'sba_eligible', 'lead_type'
        )
        and value = btrim(value) and char_length(value) between 1 and 5000
      );
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

revoke all privileges on function public.upsert_deal_hunter_opportunity_fact(
  text, text, text, text, text, boolean, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all privileges on function public.upsert_deal_hunter_opportunity_source_observation(
  text, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.upsert_deal_hunter_opportunity_fact(
  text, text, text, text, text, boolean, text, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.upsert_deal_hunter_opportunity_source_observation(
  text, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz
) to service_role;

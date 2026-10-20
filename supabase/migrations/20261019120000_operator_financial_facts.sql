-- Typed owner financial corrections reuse immutable operator facts and the
-- existing current-canonical/CAS/idempotency authority. Contact snapshots stay13.
create or replace function public.operator_financial_fact_valid_v1(p_field text, p_value text)
returns boolean language plpgsql immutable strict set search_path = pg_catalog as $$
declare v json; amount text; evidence text;
begin
  if p_field not in ('annual_profit','annual_revenue','asking_price') then return false; end if;
  v := p_value::json;
  if json_typeof(v) <> 'object' then return false; end if;
  if (select count(*)<>6 or count(distinct key)<>6 from json_each(v))
    or exists(select 1 from json_each(v) where key not in ('version','amount','currency','metric','period','evidenceSource')) then return false; end if;
  amount := v->>'amount'; evidence := v->>'evidenceSource';
  if json_typeof(v->'version') is distinct from 'number' or v->>'version' is distinct from '1'
    or json_typeof(v->'amount') is distinct from 'string'
    or amount !~ '^-?(0|[1-9][0-9]{0,11})\.[0-9]{2}$' or amount='-0.00'
    or (p_field<>'annual_profit' and amount::numeric<0)
    or json_typeof(v->'currency') is distinct from 'string' or v->>'currency' not in ('USD','CAD','EUR','GBP','AUD','unknown')
    or json_typeof(v->'metric') is distinct from 'string'
    or not ((p_field='annual_profit' and v->>'metric' in ('sde','ebitda','unknown'))
      or (p_field='annual_revenue' and v->>'metric'='revenue') or (p_field='asking_price' and v->>'metric'='asking-price'))
    or json_typeof(v->'period') is distinct from 'string'
    or not ((p_field='asking_price' and v->>'period' in ('current','unknown'))
      or (p_field<>'asking_price' and v->>'period' in ('annual','trailing-twelve-months','unknown')))
    or json_typeof(v->'evidenceSource') is distinct from 'string'
    or char_length(evidence) not between 1 and 500 or evidence<>btrim(evidence) or evidence ~ '[[:cntrl:]]'
  then return false; end if;
  return true;
exception when others then return false;
end;
$$;
revoke all privileges on function public.operator_financial_fact_valid_v1(text,text) from public,anon,authenticated;
grant execute on function public.operator_financial_fact_valid_v1(text,text) to service_role;

alter table public.deal_hunter_opportunity_facts drop constraint if exists deal_hunter_opportunity_facts_operator_boundary_check;
alter table public.deal_hunter_opportunity_facts add constraint deal_hunter_opportunity_facts_operator_boundary_check check (
  id=btrim(id) and char_length(id) between 1 and 240
  and opportunity_id=btrim(opportunity_id) and char_length(opportunity_id) between 1 and 200
  and field in ('seller_name','seller_email','seller_phone','broker_name','broker_company','broker_email','broker_phone',
    'reason_for_sale','real_estate_included','seller_financing','management_structure','customer_concentration','operator_contact_notes',
    'annual_profit','annual_revenue','asking_price')
  and value=btrim(value) and char_length(value) between 1 and 4000 and source='operator'
  and actor=btrim(actor) and char_length(actor) between 1 and 200
  and ((idempotency_key_digest is null and request_digest is null)
    or (idempotency_key_digest is not null and request_digest is not null
      and idempotency_key_digest ~ '^[0-9a-f]{64}$' and request_digest ~ '^[0-9a-f]{64}$'))
  and (note is null or (note=btrim(note) and char_length(note) between 1 and 4000))
  and (field not in ('annual_profit','annual_revenue','asking_price') or public.operator_financial_fact_valid_v1(field,value))
) not valid;

create or replace function public.upsert_deal_hunter_opportunity_fact(p_fact jsonb)
returns public.deal_hunter_opportunity_facts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fact public.deal_hunter_opportunity_facts;
  v_created_at timestamptz;
  v_updated_at timestamptz;
begin
  if not (jsonb_typeof(p_fact) = 'object')
    or not (p_fact ?& array['id', 'opportunity_id', 'field', 'value', 'source', 'verified', 'actor', 'note', 'created_at', 'updated_at'])
    or p_fact - array['id', 'opportunity_id', 'field', 'value', 'source', 'verified', 'actor', 'note', 'created_at', 'updated_at'] <> '{}'::jsonb
    or jsonb_typeof(p_fact -> 'id') <> 'string'
    or jsonb_typeof(p_fact -> 'opportunity_id') <> 'string'
    or jsonb_typeof(p_fact -> 'field') <> 'string'
    or jsonb_typeof(p_fact -> 'value') <> 'string'
    or jsonb_typeof(p_fact -> 'source') <> 'string'
    or not (jsonb_typeof(p_fact -> 'verified') = 'boolean')
    or jsonb_typeof(p_fact -> 'actor') <> 'string'
    or jsonb_typeof(p_fact -> 'note') not in ('string', 'null')
    or jsonb_typeof(p_fact -> 'created_at') <> 'string'
    or jsonb_typeof(p_fact -> 'updated_at') <> 'string' then
    raise exception 'invalid operator fact payload' using errcode = '22023';
  end if;
  if (p_fact ->> 'id') <> btrim(p_fact ->> 'id') or char_length(p_fact ->> 'id') not between 1 and 240
    or (p_fact ->> 'opportunity_id') <> btrim(p_fact ->> 'opportunity_id') or char_length(p_fact ->> 'opportunity_id') not between 1 and 200
    or (p_fact ->> 'field') not in ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes', 'annual_profit', 'annual_revenue', 'asking_price')
    or (p_fact ->> 'value') <> btrim(p_fact ->> 'value') or char_length(p_fact ->> 'value') not between 1 and 4000
    or (p_fact ->> 'source') <> 'operator'
    or (p_fact ->> 'actor') <> btrim(p_fact ->> 'actor') or char_length(p_fact ->> 'actor') not between 1 and 200
    or ((p_fact ->> 'note') is not null and ((p_fact ->> 'note') <> btrim(p_fact ->> 'note') or char_length(p_fact ->> 'note') not between 1 and 4000))
    or (p_fact ->> 'created_at') <> btrim(p_fact ->> 'created_at') or char_length(p_fact ->> 'created_at') not between 1 and 80
    or (p_fact ->> 'updated_at') <> btrim(p_fact ->> 'updated_at') or char_length(p_fact ->> 'updated_at') not between 1 and 80 then
    raise exception 'operator fact payload is outside the allowed contract' using errcode = '22023';
  end if;
  begin
    v_created_at := (p_fact ->> 'created_at')::timestamptz;
    v_updated_at := (p_fact ->> 'updated_at')::timestamptz;
  exception when others then
    raise exception 'operator fact timestamps must be valid' using errcode = '22023';
  end;
  insert into public.deal_hunter_opportunity_facts (
    id, opportunity_id, field, value, source, verified, actor, note, created_at, updated_at
  ) values (
    p_fact ->> 'id', p_fact ->> 'opportunity_id', p_fact ->> 'field', p_fact ->> 'value', p_fact ->> 'source', (p_fact ->> 'verified')::boolean, p_fact ->> 'actor', p_fact ->> 'note', v_created_at, v_updated_at
  )
  on conflict (id) do update set
    field = excluded.field, value = excluded.value, source = excluded.source,
    verified = excluded.verified, actor = excluded.actor, note = excluded.note,
    updated_at = excluded.updated_at
  returning * into v_fact;
  return v_fact;
end;
$$;

create or replace function public.insert_current_deal_hunter_opportunity_fact(
  p_fact jsonb,
  p_expected_campaign_authority_revision bigint,
  p_expected_primary_submission_id uuid,
  p_expected_submission_fact_snapshot jsonb,
  p_idempotency_key_digest text,
  p_request_digest text
)
returns public.deal_hunter_opportunity_facts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fact public.deal_hunter_opportunity_facts;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_submission public.contact_submissions%rowtype;
  v_submission_snapshot jsonb;
  v_created_at timestamptz;
  v_updated_at timestamptz;
begin
  if not (jsonb_typeof(p_fact) = 'object')
    or not (p_fact ?& array['id', 'opportunity_id', 'field', 'value', 'source', 'verified', 'actor', 'note', 'created_at', 'updated_at'])
    or p_fact - array['id', 'opportunity_id', 'field', 'value', 'source', 'verified', 'actor', 'note', 'created_at', 'updated_at'] <> '{}'::jsonb
    or jsonb_typeof(p_fact -> 'id') <> 'string'
    or jsonb_typeof(p_fact -> 'opportunity_id') <> 'string'
    or jsonb_typeof(p_fact -> 'field') <> 'string'
    or jsonb_typeof(p_fact -> 'value') <> 'string'
    or jsonb_typeof(p_fact -> 'source') <> 'string'
    or not (jsonb_typeof(p_fact -> 'verified') = 'boolean')
    or jsonb_typeof(p_fact -> 'actor') <> 'string'
    or jsonb_typeof(p_fact -> 'note') not in ('string', 'null')
    or jsonb_typeof(p_fact -> 'created_at') <> 'string'
    or jsonb_typeof(p_fact -> 'updated_at') <> 'string' then
    raise exception 'invalid operator fact payload' using errcode = '22023';
  end if;
  if (p_fact ->> 'id') <> btrim(p_fact ->> 'id') or char_length(p_fact ->> 'id') not between 1 and 240
    or (p_fact ->> 'opportunity_id') <> btrim(p_fact ->> 'opportunity_id') or char_length(p_fact ->> 'opportunity_id') not between 1 and 200
    or (p_fact ->> 'field') not in ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes', 'annual_profit', 'annual_revenue', 'asking_price')
    or (p_fact ->> 'value') <> btrim(p_fact ->> 'value') or char_length(p_fact ->> 'value') not between 1 and 4000
    or (p_fact ->> 'source') <> 'operator'
    or (p_fact ->> 'actor') <> btrim(p_fact ->> 'actor') or char_length(p_fact ->> 'actor') not between 1 and 200
    or ((p_fact ->> 'note') is not null and ((p_fact ->> 'note') <> btrim(p_fact ->> 'note') or char_length(p_fact ->> 'note') not between 1 and 4000))
    or (p_fact ->> 'created_at') <> btrim(p_fact ->> 'created_at') or char_length(p_fact ->> 'created_at') not between 1 and 80
    or (p_fact ->> 'updated_at') <> btrim(p_fact ->> 'updated_at') or char_length(p_fact ->> 'updated_at') not between 1 and 80
    or p_expected_campaign_authority_revision is null
    or p_expected_campaign_authority_revision < 1
    or p_idempotency_key_digest is null
    or p_idempotency_key_digest !~ '^[0-9a-f]{64}$'
    or p_request_digest is null
    or p_request_digest !~ '^[0-9a-f]{64}$'
    or (p_expected_primary_submission_id is null) <> (p_expected_submission_fact_snapshot is null)
    or (p_expected_submission_fact_snapshot is not null and (
      pg_catalog.jsonb_typeof(p_expected_submission_fact_snapshot) <> 'object'
      or not (p_expected_submission_fact_snapshot ?& array['seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes'])
      or p_expected_submission_fact_snapshot - array['seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes'] <> '{}'::jsonb
      or (case when pg_catalog.jsonb_typeof(p_expected_submission_fact_snapshot) = 'object' then exists (
        select 1 from pg_catalog.jsonb_each(p_expected_submission_fact_snapshot) as entry(key, value)
        where pg_catalog.jsonb_typeof(entry.value) not in ('string', 'null')
          or (pg_catalog.jsonb_typeof(entry.value) = 'string'
            and pg_catalog.char_length(entry.value #>> '{}') > 4000)
      ) else false end)
    )) then
    raise exception 'operator fact payload is outside the allowed contract' using errcode = '22023';
  end if;
  begin
    v_created_at := (p_fact ->> 'created_at')::timestamptz;
    v_updated_at := (p_fact ->> 'updated_at')::timestamptz;
  exception when others then
    raise exception 'operator fact timestamps must be valid' using errcode = '22023';
  end;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'operator-fact-idempotency:' || p_idempotency_key_digest, 0));
  select * into v_fact from public.deal_hunter_opportunity_facts
  where idempotency_key_digest = p_idempotency_key_digest;
  if found then
    if v_fact.request_digest is distinct from p_request_digest then
      raise exception 'Opportunity fact idempotency key conflicts with a different mutation.'
        using errcode = '23505';
    end if;
    return v_fact;
  end if;

  select * into v_opportunity
  from public.deal_hunter_opportunities
  where opportunity_id = p_fact ->> 'opportunity_id'
    and status = 'active'
  for update;
  if not found then
    raise exception 'current canonical opportunity is unavailable' using errcode = 'P0002';
  end if;
  if v_opportunity.campaign_authority_revision <> p_expected_campaign_authority_revision then
    raise exception 'The opportunity changed since this edit was opened. Reload the latest detail before saving again.' using errcode = '40001';
  end if;
  if v_opportunity.primary_submission_id is distinct from p_expected_primary_submission_id then
    raise exception 'The opportunity changed since this edit was opened. Reload the latest detail before saving again.' using errcode = '40001';
  end if;
  if p_expected_primary_submission_id is not null then
    select * into v_submission from public.contact_submissions
    where id = p_expected_primary_submission_id;
    if not found then
      raise exception 'The opportunity changed since this edit was opened. Reload the latest detail before saving again.' using errcode = '40001';
    end if;
    v_submission_snapshot := public.operator_fact_submission_snapshot_v1(v_submission);
    if v_submission_snapshot is distinct from p_expected_submission_fact_snapshot then
      raise exception 'The opportunity changed since this edit was opened. Reload the latest detail before saving again.' using errcode = '40001';
    end if;
  end if;

  insert into public.deal_hunter_opportunity_facts
    (id, idempotency_key_digest, request_digest, opportunity_id, field, value,
     source, verified, actor, note, created_at, updated_at)
  values (p_fact ->> 'id', p_idempotency_key_digest, p_request_digest,
    p_fact ->> 'opportunity_id', p_fact ->> 'field', p_fact ->> 'value',
    p_fact ->> 'source', (p_fact ->> 'verified')::boolean, p_fact ->> 'actor',
    p_fact ->> 'note', v_created_at, v_updated_at)
  returning * into v_fact;
  if p_expected_primary_submission_id is not null then
    select * into v_submission from public.contact_submissions
    where id = p_expected_primary_submission_id;
    if not found or public.operator_fact_submission_snapshot_v1(v_submission)
        is distinct from v_submission_snapshot then
      raise exception 'The opportunity changed since this edit was opened. Reload the latest detail before saving again.' using errcode = '40001';
    end if;
  end if;
  return v_fact;
end;
$$;

revoke all privileges on function public.insert_current_deal_hunter_opportunity_fact(jsonb, bigint, uuid, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.insert_current_deal_hunter_opportunity_fact(jsonb, bigint, uuid, jsonb, text, text)
  to service_role;

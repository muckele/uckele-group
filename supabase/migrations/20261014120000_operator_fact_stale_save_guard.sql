-- Operator fact edits are optimistic-concurrency commands. Lock the canonical
-- opportunity and reject a drawer revision that predates any canonical source,
-- fact, contact, or identity authority change.

drop trigger if exists trg_cim_campaign_revision_opportunity_identity_update
  on public.deal_hunter_opportunities;
create trigger trg_cim_campaign_revision_opportunity_identity_update
after update of canonical_name, canonical_recipient, canonical_location,
  primary_submission_id, identity_version, status, metadata
on public.deal_hunter_opportunities
for each row
when (old.canonical_name is distinct from new.canonical_name
    or old.canonical_recipient is distinct from new.canonical_recipient
    or old.canonical_location is distinct from new.canonical_location
    or old.primary_submission_id is distinct from new.primary_submission_id
    or old.identity_version is distinct from new.identity_version
    or old.status is distinct from new.status
    or ((old.opportunity_id like 'p10b-%'
        or old.identity_version = 'p10b-synthetic-v1'
        or new.identity_version = 'p10b-synthetic-v1'
        or old.metadata @> '{"p10bSynthetic":true}'::jsonb
        or new.metadata @> '{"p10bSynthetic":true}'::jsonb)
      and old.metadata is distinct from new.metadata))
execute function public.pursue_cim_bump_controlled_mailbox_authority_v1();

drop function if exists public.insert_current_deal_hunter_opportunity_fact(jsonb);
drop function if exists public.insert_current_deal_hunter_opportunity_fact(jsonb, bigint);
drop function if exists public.insert_current_deal_hunter_opportunity_fact(jsonb, bigint, uuid, timestamptz);

create or replace function public.normalize_operator_fact_authority_value_v1(p_value jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when pg_catalog.jsonb_typeof(p_value) = 'number'
      and (p_value #>> '{}')::numeric = pg_catalog.trunc((p_value #>> '{}')::numeric)
      and (p_value #>> '{}')::numeric between -9007199254740991 and 9007199254740991
      then ((p_value #>> '{}')::numeric::bigint)::text
    when pg_catalog.jsonb_typeof(p_value) in ('string', 'boolean')
      then nullif(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(
        p_value #>> '{}', E'\\s+', ' ', 'g')), 4000), '')
    else null
  end;
$$;
revoke all on function public.normalize_operator_fact_authority_value_v1(jsonb)
  from public, anon, authenticated;

create or replace function public.operator_fact_submission_snapshot_v1(
  p_submission public.contact_submissions
)
returns jsonb language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'seller_name', coalesce(public.normalize_operator_fact_authority_value_v1(pg_catalog.to_jsonb(p_submission) -> 'seller_name'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'seller_name'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'sellerName')),
    'seller_email', coalesce(public.normalize_operator_fact_authority_value_v1(pg_catalog.to_jsonb(p_submission) -> 'seller_email'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'seller_email'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'sellerEmail')),
    'seller_phone', coalesce(public.normalize_operator_fact_authority_value_v1(pg_catalog.to_jsonb(p_submission) -> 'seller_phone'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'seller_phone'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'sellerPhone')),
    'broker_name', coalesce(public.normalize_operator_fact_authority_value_v1(pg_catalog.to_jsonb(p_submission) -> 'broker_name'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'broker_name'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'brokerName')),
    'broker_company', coalesce(public.normalize_operator_fact_authority_value_v1(pg_catalog.to_jsonb(p_submission) -> 'broker_company'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'broker_company'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'brokerCompany')),
    'broker_email', coalesce(public.normalize_operator_fact_authority_value_v1(pg_catalog.to_jsonb(p_submission) -> 'broker_email'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'broker_email'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'brokerEmail')),
    'broker_phone', coalesce(public.normalize_operator_fact_authority_value_v1(pg_catalog.to_jsonb(p_submission) -> 'broker_phone'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'broker_phone'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'brokerPhone')),
    'reason_for_sale', coalesce(public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'reason_for_sale'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'reasonForSale')),
    'real_estate_included', coalesce(public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'real_estate_included'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'realEstateIncluded')),
    'seller_financing', coalesce(public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'seller_financing'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'sellerFinancing')),
    'management_structure', coalesce(public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'management_structure'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'managementStructure')),
    'customer_concentration', coalesce(public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'customer_concentration'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'customerConcentration')),
    'operator_contact_notes', coalesce(public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'operator_contact_notes'), public.normalize_operator_fact_authority_value_v1(p_submission.metadata -> 'dealHunter' -> 'operatorContactNotes'))
  );
$$;
revoke all on function public.operator_fact_submission_snapshot_v1(public.contact_submissions)
  from public, anon, authenticated;

create or replace function public.insert_current_deal_hunter_opportunity_fact(
  p_fact jsonb,
  p_expected_campaign_authority_revision bigint,
  p_expected_primary_submission_id uuid,
  p_expected_submission_fact_snapshot jsonb
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
    or (p_fact ->> 'field') not in ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes')
    or (p_fact ->> 'value') <> btrim(p_fact ->> 'value') or char_length(p_fact ->> 'value') not between 1 and 4000
    or (p_fact ->> 'source') <> 'operator'
    or (p_fact ->> 'actor') <> btrim(p_fact ->> 'actor') or char_length(p_fact ->> 'actor') not between 1 and 200
    or ((p_fact ->> 'note') is not null and ((p_fact ->> 'note') <> btrim(p_fact ->> 'note') or char_length(p_fact ->> 'note') not between 1 and 4000))
    or (p_fact ->> 'created_at') <> btrim(p_fact ->> 'created_at') or char_length(p_fact ->> 'created_at') not between 1 and 80
    or (p_fact ->> 'updated_at') <> btrim(p_fact ->> 'updated_at') or char_length(p_fact ->> 'updated_at') not between 1 and 80
    or p_expected_campaign_authority_revision is null
    or p_expected_campaign_authority_revision < 1
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

  insert into public.deal_hunter_opportunity_facts (id, opportunity_id, field, value, source, verified, actor, note, created_at, updated_at)
  values (p_fact ->> 'id', p_fact ->> 'opportunity_id', p_fact ->> 'field', p_fact ->> 'value', p_fact ->> 'source', (p_fact ->> 'verified')::boolean, p_fact ->> 'actor', p_fact ->> 'note', v_created_at, v_updated_at)
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

revoke all privileges on function public.insert_current_deal_hunter_opportunity_fact(jsonb, bigint, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.insert_current_deal_hunter_opportunity_fact(jsonb, bigint, uuid, jsonb)
  to service_role;

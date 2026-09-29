-- Canonical CRM supersession authority. This block is also appended verbatim to schema.sql.
create table if not exists public.crm_submission_supersessions (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  status text not null check (status in ('active', 'reversed')),
  survivor_submission_id uuid not null references public.contact_submissions(id) on delete restrict,
  superseded_submission_id uuid not null references public.contact_submissions(id) on delete restrict,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  reason_code text not null check (reason_code = 'confirmed-duplicate'),
  reason_text text not null,
  approved_by text not null,
  approved_at timestamptz not null,
  actor text not null,
  repair_version text not null,
  repair_manifest_id text not null references public.deal_hunter_cim_repair_manifests(id) on delete restrict,
  repair_digest text not null check (repair_digest ~ '^[0-9a-f]{64}$'),
  reversed_at timestamptz,
  reversed_by text,
  reversal_reason text,
  reversal_manifest_id text references public.deal_hunter_cim_repair_manifests(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb,
  constraint crm_supersession_distinct check (survivor_submission_id <> superseded_submission_id),
  constraint crm_supersession_reversal_shape check (
    (status = 'active' and reversed_at is null and reversed_by is null
      and reversal_reason is null and reversal_manifest_id is null)
    or (status = 'reversed' and reversed_at is not null and reversed_by is not null
      and reversal_reason is not null and reversal_manifest_id is not null)
  )
);

create unique index if not exists uq_crm_submission_supersessions_active_loser
  on public.crm_submission_supersessions(superseded_submission_id) where status = 'active';
create index if not exists idx_crm_submission_supersessions_survivor
  on public.crm_submission_supersessions(survivor_submission_id, status);
create index if not exists idx_crm_submission_supersessions_opportunity
  on public.crm_submission_supersessions(opportunity_id, status);

create or replace function public.crm_supersession_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_survivor public.contact_submissions;
  v_loser public.contact_submissions;
  v_opportunity public.deal_hunter_opportunities;
  v_receipt public.deal_hunter_cim_repair_manifests;
begin
  if tg_op = 'DELETE' then
    raise exception 'CRM supersession physical delete is forbidden';
  end if;
  if tg_op = 'UPDATE' then
    if (pg_catalog.to_jsonb(new) - array['updated_at','status','reversed_at','reversed_by',
      'reversal_reason','reversal_manifest_id'])
      is distinct from (pg_catalog.to_jsonb(old) - array['updated_at','status','reversed_at',
        'reversed_by','reversal_reason','reversal_manifest_id']) then
      raise exception 'CRM supersession core fields are immutable';
    end if;
    if old.status <> 'active' or new.status <> 'reversed'
      or new.updated_at < old.updated_at
      or pg_catalog.btrim(new.reversed_by) = '' or pg_catalog.btrim(new.reversal_reason) = ''
      or new.reversal_manifest_id = new.repair_manifest_id then
      raise exception 'CRM supersession permits only reviewed active to reversed transition';
    end if;
    select * into v_receipt from public.deal_hunter_cim_repair_manifests
      where id = new.reversal_manifest_id;
    if not found or v_receipt.mode <> 'crm-duplicate-consolidation'
      or v_receipt.status <> 'applied'
      or v_receipt.manifest ->> 'schema' is distinct from 'crm-duplicate-consolidation-reversal-manifest-v1'
      or v_receipt.manifest ->> 'operation' is distinct from 'reverse'
      or v_receipt.manifest ->> 'relationId' is distinct from new.id
      or v_receipt.manifest ->> 'applyManifestId' is distinct from new.repair_manifest_id
      or v_receipt.manifest ->> 'repairDigest' is distinct from new.repair_digest
      or v_receipt.manifest ->> 'survivorSubmissionId' is distinct from new.survivor_submission_id::text
      or v_receipt.manifest ->> 'supersededSubmissionId' is distinct from new.superseded_submission_id::text
      or v_receipt.manifest ->> 'opportunityId' is distinct from new.opportunity_id then
      raise exception 'CRM supersession reversal evidence is invalid';
    end if;
    return new;
  end if;
  if new.status <> 'active' then
    raise exception 'CRM supersession must begin active';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crm-supersession-authority-v1', 0));
  select * into v_survivor from public.contact_submissions
    where id = new.survivor_submission_id for update;
  select * into v_loser from public.contact_submissions
    where id = new.superseded_submission_id for update;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = new.opportunity_id for update;
  select * into v_receipt from public.deal_hunter_cim_repair_manifests
    where id = new.repair_manifest_id for update;
  if v_survivor.id is null or v_loser.id is null then
    raise exception 'CRM supersession referenced submission is missing';
  end if;
  if v_opportunity.opportunity_id is null or v_opportunity.status <> 'active'
    or v_opportunity.primary_submission_id is distinct from new.survivor_submission_id then
    raise exception 'CRM supersession requires active opportunity with survivor primary';
  end if;
  if nullif(pg_catalog.btrim(v_survivor.deal_hunter_opportunity_id), '')
      is distinct from null and pg_catalog.btrim(v_survivor.deal_hunter_opportunity_id) <> new.opportunity_id
    or nullif(pg_catalog.btrim(v_survivor.metadata #>> '{dealHunter,opportunityId}'), '')
      is distinct from null and pg_catalog.btrim(v_survivor.metadata #>> '{dealHunter,opportunityId}') <> new.opportunity_id
    or (nullif(pg_catalog.btrim(v_survivor.deal_hunter_opportunity_id), '') is null
      and nullif(pg_catalog.btrim(v_survivor.metadata #>> '{dealHunter,opportunityId}'), '') is null) then
    raise exception 'CRM supersession survivor owner is incompatible';
  end if;
  if (nullif(pg_catalog.btrim(v_loser.deal_hunter_opportunity_id), '') is not null
      and pg_catalog.btrim(v_loser.deal_hunter_opportunity_id) <> new.opportunity_id)
    or (nullif(pg_catalog.btrim(v_loser.metadata #>> '{dealHunter,opportunityId}'), '') is not null
      and pg_catalog.btrim(v_loser.metadata #>> '{dealHunter,opportunityId}') <> new.opportunity_id) then
    raise exception 'CRM supersession loser owner is incompatible';
  end if;
  if exists (select 1 from public.deal_hunter_opportunities
      where primary_submission_id = new.superseded_submission_id) then
    raise exception 'CRM supersession loser cannot be an opportunity primary';
  end if;
  if exists (select 1 from public.crm_submission_supersessions
      where status = 'active' and (superseded_submission_id = new.survivor_submission_id
        or survivor_submission_id = new.superseded_submission_id)) then
    raise exception 'CRM supersession active role would create a chain';
  end if;
  if v_receipt.id is null or v_receipt.mode <> 'crm-duplicate-consolidation'
    or v_receipt.status <> 'applied' or v_receipt.checksum <> new.repair_digest then
    raise exception 'CRM supersession receipt or digest is invalid';
  end if;
  return new;
end;
$$;

create trigger crm_supersession_guard
before insert or update or delete on public.crm_submission_supersessions
for each row execute function public.crm_supersession_guard_v1();

create or replace function public.crm_supersession_parent_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'deal_hunter_cim_repair_manifests' then
    if old.mode = 'crm-duplicate-consolidation' then
      raise exception 'CRM duplicate consolidation receipt is append-only and immutable';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'deal_hunter_opportunities' then
    if tg_op = 'DELETE' then
      if exists (select 1 from public.crm_submission_supersessions
        where opportunity_id = old.opportunity_id) then
        raise exception 'CRM supersession referenced opportunity delete is forbidden';
      end if;
      return old;
    end if;
    if new.primary_submission_id is not null and exists (
      select 1 from public.crm_submission_supersessions
      where status = 'active' and superseded_submission_id = new.primary_submission_id) then
      raise exception 'CRM superseded primary is forbidden';
    end if;
    if exists (select 1 from public.crm_submission_supersessions
      where status = 'active' and opportunity_id = old.opportunity_id
        and (new.opportunity_id <> old.opportunity_id or new.status <> 'active'
          or new.primary_submission_id is distinct from survivor_submission_id)) then
      raise exception 'CRM supersession opportunity authority cannot be invalidated';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from public.crm_submission_supersessions
      where survivor_submission_id = old.id or superseded_submission_id = old.id) then
      raise exception 'CRM supersession referenced contact delete is forbidden';
    end if;
    return old;
  end if;
  if exists (select 1 from public.crm_submission_supersessions
    where status = 'active' and superseded_submission_id = old.id) then
    raise exception 'CRM_SUBMISSION_SUPERSEDED: historical loser is not writable';
  end if;
  if exists (select 1 from public.crm_submission_supersessions as relation
    where relation.status = 'active' and relation.survivor_submission_id = old.id
      and (new.id <> old.id
        or (nullif(pg_catalog.btrim(new.deal_hunter_opportunity_id), '') is not null
          and pg_catalog.btrim(new.deal_hunter_opportunity_id) <> relation.opportunity_id)
        or (nullif(pg_catalog.btrim(new.metadata #>> '{dealHunter,opportunityId}'), '') is not null
          and pg_catalog.btrim(new.metadata #>> '{dealHunter,opportunityId}') <> relation.opportunity_id)
        or (nullif(pg_catalog.btrim(new.deal_hunter_opportunity_id), '') is null
          and nullif(pg_catalog.btrim(new.metadata #>> '{dealHunter,opportunityId}'), '') is null))) then
    raise exception 'CRM supersession survivor owner cannot be invalidated';
  end if;
  if exists (select 1 from public.crm_submission_supersessions as relation
    where relation.status = 'active' and relation.superseded_submission_id = old.id
      and (new.id <> old.id
        or (nullif(pg_catalog.btrim(new.deal_hunter_opportunity_id), '') is not null
          and pg_catalog.btrim(new.deal_hunter_opportunity_id) <> relation.opportunity_id)
        or (nullif(pg_catalog.btrim(new.metadata #>> '{dealHunter,opportunityId}'), '') is not null
          and pg_catalog.btrim(new.metadata #>> '{dealHunter,opportunityId}') <> relation.opportunity_id))) then
    raise exception 'CRM supersession loser owner cannot be invalidated';
  end if;
  return new;
end;
$$;

create trigger crm_supersession_contact_guard
before update or delete on public.contact_submissions
for each row execute function public.crm_supersession_parent_guard_v1();
create trigger crm_supersession_opportunity_guard
before insert or update of opportunity_id, status, primary_submission_id or delete
on public.deal_hunter_opportunities
for each row execute function public.crm_supersession_parent_guard_v1();
create trigger crm_supersession_receipt_guard
before update or delete on public.deal_hunter_cim_repair_manifests
for each row execute function public.crm_supersession_parent_guard_v1();

create or replace function public.crm_supersession_activity_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- The relation insert takes the same contact row lock. A concurrent loser
  -- transition therefore commits before this write is admitted or waits for it.
  perform 1 from public.contact_submissions
    where id = new.submission_id for update;
  if exists (select 1 from public.crm_submission_supersessions
    where status = 'active' and superseded_submission_id = new.submission_id) then
    raise exception 'CRM_SUBMISSION_SUPERSEDED: historical loser activity is forbidden';
  end if;
  return new;
end;
$$;

create trigger crm_supersession_activity_guard
before insert or update on public.crm_activity_events
for each row execute function public.crm_supersession_activity_guard_v1();

create or replace function public.read_deal_hunter_crm_match_authority_v2(
  p_limit integer default 5000, p_supersession_limit integer default 5000)
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 5000), 5000));
  v_supersession_limit integer := greatest(1, least(coalesce(p_supersession_limit, 5000), 5000));
  v_submissions jsonb;
  v_supersessions jsonb;
  v_revision text;
  v_version constant text := 'deal-hunter-crm-match-authority-v2';
begin
  -- One SQL statement gives both bounded sets the same MVCC snapshot.
  with submissions as materialized (
    select * from public.contact_submissions order by id limit v_limit + 1
  ), supersessions as materialized (
    select * from public.crm_submission_supersessions
    where status = 'active' order by id limit v_supersession_limit + 1
  )
  select
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) order by s.id), '[]'::jsonb) from submissions s),
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.id), '[]'::jsonb) from supersessions r)
  into v_submissions, v_supersessions;
  if pg_catalog.jsonb_array_length(v_submissions) > v_limit
    or pg_catalog.jsonb_array_length(v_supersessions) > v_supersession_limit then
    return pg_catalog.jsonb_build_object('rows', '[]'::jsonb, 'supersessions', '[]'::jsonb,
      'count', null, 'submissionCount', null, 'supersessionCount', null,
      'complete', false, 'revision', null, 'revisionVersion', v_version);
  end if;
  v_revision := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object('version', v_version, 'submissions', v_submissions,
      'activeSupersessions', v_supersessions)::text, 'UTF8')), 'hex');
  return pg_catalog.jsonb_build_object('rows', v_submissions, 'supersessions', v_supersessions,
    'count', pg_catalog.jsonb_array_length(v_submissions),
    'submissionCount', pg_catalog.jsonb_array_length(v_submissions),
    'supersessionCount', pg_catalog.jsonb_array_length(v_supersessions),
    'complete', true, 'revision', v_revision, 'revisionVersion', v_version);
end;
$$;

create or replace function public.link_deal_hunter_crm_submission_if_authority_current_v2(
  p_opportunity_id text, p_submission_id uuid, p_expected_authority_revision text,
  p_updated_at timestamptz)
returns public.deal_hunter_opportunities language plpgsql security definer
set search_path = '' set timezone = 'UTC' as $$
declare
  v_authority jsonb;
  v_opportunity public.deal_hunter_opportunities;
  v_submission public.contact_submissions;
  v_direct text;
  v_metadata text;
  v_survivor uuid;
  v_survivor_opportunity text;
begin
  if nullif(pg_catalog.btrim(p_opportunity_id), '') is null or p_submission_id is null
    or p_expected_authority_revision is null
    or p_expected_authority_revision !~ '^[0-9a-f]{64}$' or p_updated_at is null then
    raise exception 'CRM_MATCH_AUTHORITY_STALE: invalid conditional link input';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'CRM_MATCH_AUTHORITY_STALE: read committed isolation required';
  end if;
  -- Serializes authority writers before the complete-set CAS and both updates.
  lock table public.contact_submissions, public.crm_submission_supersessions,
    public.deal_hunter_opportunities in share row exclusive mode;
  v_authority := public.read_deal_hunter_crm_match_authority_v2(5000, 5000);
  if not (v_authority ->> 'complete')::boolean
    or v_authority ->> 'revision' is distinct from p_expected_authority_revision then
    raise exception 'CRM_MATCH_AUTHORITY_STALE: complete authority changed';
  end if;
  select survivor_submission_id, opportunity_id into v_survivor, v_survivor_opportunity
    from public.crm_submission_supersessions
    where status = 'active' and superseded_submission_id = p_submission_id;
  if v_survivor is not null then
    raise exception 'CRM_SUBMISSION_SUPERSEDED:%:%', v_survivor, v_survivor_opportunity;
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id and status = 'active';
  select * into v_submission from public.contact_submissions where id = p_submission_id;
  if v_opportunity.opportunity_id is null or v_submission.id is null
    or pg_catalog.lower(pg_catalog.btrim(v_submission.status)) in ('archived', 'spam')
    or (v_opportunity.primary_submission_id is not null
      and v_opportunity.primary_submission_id <> p_submission_id) then
    raise exception 'CRM_MATCH_AUTHORITY_STALE: canonical opportunity or submission changed';
  end if;
  v_direct := pg_catalog.btrim(coalesce(v_submission.deal_hunter_opportunity_id, ''));
  v_metadata := pg_catalog.btrim(coalesce(v_submission.metadata #>> '{dealHunter,opportunityId}', ''));
  if (v_direct <> '' and v_direct <> p_opportunity_id)
    or (v_metadata <> '' and v_metadata <> p_opportunity_id)
    or (v_direct <> '' and v_metadata <> '' and v_direct <> v_metadata)
    or exists (select 1 from public.contact_submissions
      where id <> p_submission_id and pg_catalog.btrim(coalesce(deal_hunter_opportunity_id, '')) = p_opportunity_id) then
    raise exception 'CRM_MATCH_AUTHORITY_STALE: CRM ownership conflict';
  end if;
  update public.contact_submissions set deal_hunter_opportunity_id = p_opportunity_id,
    updated_at = p_updated_at where id = p_submission_id;
  update public.deal_hunter_opportunities set primary_submission_id = p_submission_id,
    updated_at = p_updated_at where opportunity_id = p_opportunity_id
    returning * into v_opportunity;
  return v_opportunity;
end;
$$;

alter table public.crm_submission_supersessions enable row level security;
revoke all privileges on table public.crm_submission_supersessions from public, anon, authenticated;
revoke all privileges on table public.crm_submission_supersessions from service_role;
grant select, insert, update on table public.crm_submission_supersessions to service_role;
revoke all on function public.crm_supersession_guard_v1() from public, anon, authenticated;
revoke all on function public.crm_supersession_parent_guard_v1() from public, anon, authenticated;
revoke all on function public.crm_supersession_activity_guard_v1() from public, anon, authenticated;
revoke all on function public.read_deal_hunter_crm_match_authority_v2(integer, integer) from public, anon, authenticated;
revoke all on function public.link_deal_hunter_crm_submission_if_authority_current_v2(text, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.read_deal_hunter_crm_match_authority_v2(integer, integer) to service_role;
grant execute on function public.link_deal_hunter_crm_submission_if_authority_current_v2(text, uuid, text, timestamptz) to service_role;

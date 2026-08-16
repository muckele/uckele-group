-- Lossless Deal OS import accounting and duplicate-safe CRM reconciliation.
-- This migration intentionally aborts if legacy canonical ownership collisions
-- exist; operators must review those rows instead of choosing a winner silently.

alter table public.deal_hunter_deal_os_imports
  add column if not exists source_row_count integer not null default 0,
  add column if not exists accepted_row_count integer not null default 0,
  add column if not exists rejected_row_count integer not null default 0,
  add column if not exists canonical_record_count integer not null default 0,
  add column if not exists parser_version text not null default 'deal-os-export-v1',
  add column if not exists row_accounting jsonb not null default '[]'::jsonb;

update public.deal_hunter_deal_os_imports
set source_row_count = coalesce(
      nullif(source_row_count, 0),
      case when metadata->>'sourceRowCount' ~ '^[0-9]+$' then (metadata->>'sourceRowCount')::integer end,
      row_count
    ),
    accepted_row_count = coalesce(
      nullif(accepted_row_count, 0),
      case when metadata->>'acceptedRowCount' ~ '^[0-9]+$' then (metadata->>'acceptedRowCount')::integer end,
      case when metadata->>'sourceRowCount' ~ '^[0-9]+$' then (metadata->>'sourceRowCount')::integer end,
      row_count
    ),
    canonical_record_count = coalesce(nullif(canonical_record_count, 0), row_count),
    parser_version = coalesce(nullif(parser_version, ''), metadata->>'parserVersion', 'deal-os-export-v1'),
    row_accounting = case
      when jsonb_typeof(metadata->'rowAccounting') = 'array' then metadata->'rowAccounting'
      else row_accounting
    end;

alter table public.contact_submissions
  add column if not exists deal_hunter_opportunity_id text
  references public.deal_hunter_opportunities(opportunity_id) on delete restrict;

do $$
begin
  if exists (
    select 1 from public.deal_hunter_crm_imports
    where opportunity_id is not null and opportunity_id <> ''
    group by opportunity_id having count(*) > 1
  ) then
    raise exception 'Duplicate deal_hunter_crm_imports opportunity ownership exists; run the CRM integrity audit before applying this migration.';
  end if;
  if exists (
    select 1 from public.contact_submissions
    where deal_hunter_opportunity_id is not null and deal_hunter_opportunity_id <> ''
    group by deal_hunter_opportunity_id having count(*) > 1
  ) then
    raise exception 'Duplicate contact_submissions opportunity ownership exists; run the CRM integrity audit before applying this migration.';
  end if;
end $$;

create unique index if not exists idx_deal_hunter_crm_imports_unique_opportunity
  on public.deal_hunter_crm_imports(opportunity_id)
  where opportunity_id is not null and opportunity_id <> '';
create unique index if not exists idx_contact_submissions_deal_hunter_opportunity
  on public.contact_submissions(deal_hunter_opportunity_id)
  where deal_hunter_opportunity_id is not null and deal_hunter_opportunity_id <> '';

create table if not exists public.deal_hunter_crm_reconciliation_runs (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  import_id uuid not null references public.deal_hunter_deal_os_imports(id) on delete restrict,
  mode text not null,
  plan_digest text not null,
  idempotency_key text not null unique,
  status text not null,
  requested_by text,
  counts jsonb not null default '{}'::jsonb,
  plan jsonb not null default '{}'::jsonb,
  results jsonb not null default '{}'::jsonb,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.deal_hunter_crm_reconciliation_items (
  id text primary key,
  run_id text not null references public.deal_hunter_crm_reconciliation_runs(id) on delete cascade,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  deal_key text,
  action text not null,
  status text not null,
  submission_id uuid references public.contact_submissions(id) on delete set null,
  source_row_numbers jsonb not null default '[]'::jsonb,
  planned_changes jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  unique(run_id, opportunity_id)
);

create index if not exists idx_deal_hunter_crm_reconciliation_runs_import
  on public.deal_hunter_crm_reconciliation_runs(import_id, created_at desc);
create index if not exists idx_deal_hunter_crm_reconciliation_items_run
  on public.deal_hunter_crm_reconciliation_items(run_id, status, opportunity_id);

create or replace function public.start_deal_hunter_crm_reconciliation(p_run jsonb, p_items jsonb)
returns public.deal_hunter_crm_reconciliation_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.deal_hunter_crm_reconciliation_runs;
  v_item jsonb;
begin
  insert into public.deal_hunter_crm_reconciliation_runs (
    id, created_at, updated_at, completed_at, import_id, mode, plan_digest,
    idempotency_key, status, requested_by, counts, plan, results, last_error, metadata
  ) values (
    p_run->>'id', (p_run->>'created_at')::timestamptz, (p_run->>'updated_at')::timestamptz,
    nullif(p_run->>'completed_at', '')::timestamptz, (p_run->>'import_id')::uuid,
    p_run->>'mode', p_run->>'plan_digest', p_run->>'idempotency_key', p_run->>'status',
    nullif(p_run->>'requested_by', ''), coalesce(p_run->'counts', '{}'::jsonb),
    coalesce(p_run->'plan', '{}'::jsonb), coalesce(p_run->'results', '{}'::jsonb),
    nullif(p_run->>'last_error', ''), coalesce(p_run->'metadata', '{}'::jsonb)
  ) on conflict (idempotency_key) do nothing
  returning * into v_run;

  if v_run.id is null then
    select * into v_run from public.deal_hunter_crm_reconciliation_runs
    where idempotency_key = p_run->>'idempotency_key';
    return v_run;
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.deal_hunter_crm_reconciliation_items (
      id, run_id, opportunity_id, deal_key, action, status, submission_id,
      source_row_numbers, planned_changes, error, created_at, updated_at, metadata
    ) values (
      v_item->>'id', v_item->>'run_id', v_item->>'opportunity_id', nullif(v_item->>'deal_key', ''),
      v_item->>'action', v_item->>'status', nullif(v_item->>'submission_id', '')::uuid,
      coalesce(v_item->'source_row_numbers', '[]'::jsonb), coalesce(v_item->'planned_changes', '{}'::jsonb),
      nullif(v_item->>'error', ''), (v_item->>'created_at')::timestamptz,
      (v_item->>'updated_at')::timestamptz, coalesce(v_item->'metadata', '{}'::jsonb)
    );
  end loop;
  return v_run;
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
  update public.contact_submissions
    set deal_hunter_opportunity_id = p_opportunity_id, updated_at = greatest(updated_at, p_updated_at)
    where id = p_submission_id;
  update public.deal_hunter_opportunities
    set primary_submission_id = p_submission_id, updated_at = greatest(updated_at, p_updated_at)
    where opportunity_id = p_opportunity_id
      and (primary_submission_id is null or primary_submission_id = p_submission_id)
    returning * into v_opportunity;
  if v_opportunity.opportunity_id is null then
    raise exception 'canonical opportunity primary CRM ownership conflict';
  end if;
  return v_opportunity;
end;
$$;

alter table public.deal_hunter_crm_reconciliation_runs enable row level security;
alter table public.deal_hunter_crm_reconciliation_items enable row level security;
revoke all privileges on table public.deal_hunter_crm_reconciliation_runs from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_crm_reconciliation_items from public, anon, authenticated;
revoke all privileges on function public.start_deal_hunter_crm_reconciliation(jsonb, jsonb) from public, anon, authenticated;
revoke all privileges on function public.link_deal_hunter_crm_submission(text, uuid, timestamptz) from public, anon, authenticated;
grant all privileges on table public.deal_hunter_crm_reconciliation_runs to service_role;
grant all privileges on table public.deal_hunter_crm_reconciliation_items to service_role;
grant execute on function public.start_deal_hunter_crm_reconciliation(jsonb, jsonb) to service_role;
grant execute on function public.link_deal_hunter_crm_submission(text, uuid, timestamptz) to service_role;

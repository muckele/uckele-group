create or replace function public.start_deal_hunter_crm_reconciliation(p_run jsonb, p_items jsonb)
returns public.deal_hunter_crm_reconciliation_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id text;
  v_idempotency_key text;
  v_import_id uuid;
  v_plan_digest text;
  v_mode text;
  v_plan jsonb;
  v_run_lock bigint;
  v_idempotency_lock bigint;
  v_existing_by_id public.deal_hunter_crm_reconciliation_runs%rowtype;
  v_existing_by_key public.deal_hunter_crm_reconciliation_runs%rowtype;
  v_run public.deal_hunter_crm_reconciliation_runs;
  v_item jsonb;
  v_submitted_count integer;
  v_stored_count bigint;
  v_items_differ boolean;
begin
  if p_run is null
    or pg_catalog.jsonb_typeof(p_run) is distinct from 'object'
    or p_items is null
    or pg_catalog.jsonb_typeof(p_items) is distinct from 'array'
  then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: run and items must be JSON objects and arrays';
  end if;

  v_run_id := nullif(pg_catalog.btrim(p_run->>'id'), '');
  v_idempotency_key := nullif(pg_catalog.btrim(p_run->>'idempotency_key'), '');
  v_plan_digest := nullif(pg_catalog.btrim(p_run->>'plan_digest'), '');
  v_mode := nullif(pg_catalog.btrim(p_run->>'mode'), '');
  v_plan := coalesce(p_run->'plan', '{}'::jsonb);

  if v_run_id is null
    or v_idempotency_key is null
    or v_plan_digest is null
    or v_mode is null
    or nullif(pg_catalog.btrim(p_run->>'import_id'), '') is null
    or nullif(pg_catalog.btrim(p_run->>'status'), '') is null
    or nullif(pg_catalog.btrim(p_run->>'created_at'), '') is null
    or nullif(pg_catalog.btrim(p_run->>'updated_at'), '') is null
  then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: required run authority is missing';
  end if;

  begin
    v_import_id := (p_run->>'import_id')::uuid;
  exception when invalid_text_representation then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: import ID is invalid';
  end;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as submitted_item(value)
    where pg_catalog.jsonb_typeof(submitted_item.value) is distinct from 'object'
      or nullif(pg_catalog.btrim(submitted_item.value->>'id'), '') is null
      or nullif(pg_catalog.btrim(submitted_item.value->>'opportunity_id'), '') is null
      or nullif(pg_catalog.btrim(submitted_item.value->>'action'), '') is null
      or nullif(pg_catalog.btrim(submitted_item.value->>'status'), '') is null
      or nullif(pg_catalog.btrim(submitted_item.value->>'created_at'), '') is null
      or nullif(pg_catalog.btrim(submitted_item.value->>'updated_at'), '') is null
  ) then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: submitted item authority is invalid';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as submitted_item(value)
    where submitted_item.value->>'run_id' is distinct from v_run_id
  ) then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: submitted item run ID differs';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as submitted_item(value)
    group by submitted_item.value->>'id'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: duplicate submitted item ID';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as submitted_item(value)
    group by submitted_item.value->>'opportunity_id'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: duplicate submitted opportunity ID';
  end if;

  v_run_lock := pg_catalog.hashtextextended(
    'deal-hunter-crm-reconciliation/run-id/' || v_run_id,
    0
  );
  v_idempotency_lock := pg_catalog.hashtextextended(
    'deal-hunter-crm-reconciliation/idempotency-key/' || v_idempotency_key,
    0
  );
  perform pg_catalog.pg_advisory_xact_lock(
    least(v_run_lock, v_idempotency_lock)
  );
  if v_run_lock <> v_idempotency_lock then
    perform pg_catalog.pg_advisory_xact_lock(
      greatest(v_run_lock, v_idempotency_lock)
    );
  end if;

  select * into v_existing_by_id
  from public.deal_hunter_crm_reconciliation_runs
  where id = v_run_id;

  select * into v_existing_by_key
  from public.deal_hunter_crm_reconciliation_runs
  where idempotency_key = v_idempotency_key;

  if v_existing_by_id.id is not null or v_existing_by_key.id is not null then
    if v_existing_by_id.id is null
      or v_existing_by_key.id is null
      or v_existing_by_id.id is distinct from v_existing_by_key.id
      or v_existing_by_id.idempotency_key is distinct from v_idempotency_key
    then
      raise exception using
        errcode = '22023',
        message = 'reconciliation authority conflict: identifier binding differs';
    end if;

    if v_existing_by_id.import_id is distinct from v_import_id
      or v_existing_by_id.plan_digest is distinct from v_plan_digest
      or v_existing_by_id.mode is distinct from v_mode
      or v_existing_by_id.plan is distinct from v_plan
    then
      raise exception using
        errcode = '22023',
        message = 'reconciliation authority conflict: immutable run authority differs';
    end if;

    v_submitted_count := pg_catalog.jsonb_array_length(p_items);
    select pg_catalog.count(*) into v_stored_count
    from public.deal_hunter_crm_reconciliation_items
    where run_id = v_run_id;
    if v_stored_count is distinct from v_submitted_count::bigint then
      raise exception using
        errcode = '22023',
        message = 'reconciliation authority conflict: immutable item count differs';
    end if;

    with submitted as (
      select pg_catalog.jsonb_build_object(
        'id', submitted_item.value->>'id',
        'run_id', submitted_item.value->>'run_id',
        'opportunity_id', submitted_item.value->>'opportunity_id',
        'deal_key', nullif(submitted_item.value->>'deal_key', ''),
        'action', submitted_item.value->>'action',
        'source_row_numbers', coalesce(submitted_item.value->'source_row_numbers', '[]'::jsonb),
        'planned_changes', coalesce(submitted_item.value->'planned_changes', '{}'::jsonb),
        'metadata', coalesce(submitted_item.value->'metadata', '{}'::jsonb)
      ) as authority
      from pg_catalog.jsonb_array_elements(p_items) as submitted_item(value)
    ), stored as (
      select pg_catalog.jsonb_build_object(
        'id', stored_item.id,
        'run_id', stored_item.run_id,
        'opportunity_id', stored_item.opportunity_id,
        'deal_key', stored_item.deal_key,
        'action', stored_item.action,
        'source_row_numbers', coalesce(stored_item.source_row_numbers, '[]'::jsonb),
        'planned_changes', coalesce(stored_item.planned_changes, '{}'::jsonb),
        'metadata', coalesce(stored_item.metadata, '{}'::jsonb)
      ) as authority
      from public.deal_hunter_crm_reconciliation_items as stored_item
      where stored_item.run_id = v_run_id
    )
    select exists (
      select 1
      from (
        (select authority from submitted except select authority from stored)
        union all
        (select authority from stored except select authority from submitted)
      ) as differences
    ) into v_items_differ;
    if v_items_differ then
      raise exception using
        errcode = '22023',
        message = 'reconciliation authority conflict: immutable item set differs';
    end if;

    return v_existing_by_id;
  end if;

  insert into public.deal_hunter_crm_reconciliation_runs (
    id, created_at, updated_at, completed_at, import_id, mode, plan_digest,
    idempotency_key, status, requested_by, counts, plan, results, last_error, metadata
  ) values (
    v_run_id, (p_run->>'created_at')::timestamptz, (p_run->>'updated_at')::timestamptz,
    nullif(p_run->>'completed_at', '')::timestamptz, v_import_id,
    v_mode, v_plan_digest, v_idempotency_key, p_run->>'status',
    nullif(p_run->>'requested_by', ''), coalesce(p_run->'counts', '{}'::jsonb),
    v_plan, coalesce(p_run->'results', '{}'::jsonb),
    nullif(p_run->>'last_error', ''), coalesce(p_run->'metadata', '{}'::jsonb)
  ) returning * into v_run;

  begin
    for v_item in select value from pg_catalog.jsonb_array_elements(p_items) loop
      insert into public.deal_hunter_crm_reconciliation_items (
        id, run_id, opportunity_id, deal_key, action, status, submission_id,
        source_row_numbers, planned_changes, error, created_at, updated_at, metadata
      ) values (
        v_item->>'id', v_item->>'run_id', v_item->>'opportunity_id', nullif(v_item->>'deal_key', ''),
        v_item->>'action', v_item->>'status', nullif(v_item->>'submission_id', '')::uuid,
        coalesce(v_item->'source_row_numbers', '[]'::jsonb),
        coalesce(v_item->'planned_changes', '{}'::jsonb),
        nullif(v_item->>'error', ''), (v_item->>'created_at')::timestamptz,
        (v_item->>'updated_at')::timestamptz, coalesce(v_item->'metadata', '{}'::jsonb)
      );
    end loop;
  exception when unique_violation then
    raise exception using
      errcode = '22023',
      message = 'reconciliation authority conflict: item identifier binding differs';
  end;
  return v_run;
end;
$$;

revoke all privileges on function public.start_deal_hunter_crm_reconciliation(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.start_deal_hunter_crm_reconciliation(jsonb, jsonb)
  to service_role;

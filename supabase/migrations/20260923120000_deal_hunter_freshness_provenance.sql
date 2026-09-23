-- FL-01 additive provenance contract. This migration is schema-only: legacy
-- writers do not infer a first discovery from their pre-cutover data.
create table if not exists public.deal_hunter_source_freshness_state (
  source_id text primary key check (source_id = btrim(source_id) and char_length(source_id) between 1 and 160),
  next_generation bigint not null default 0 check (next_generation >= 0),
  accepted_generation bigint not null default 0 check (accepted_generation >= 0),
  accepted_run_id text check (accepted_run_id is null or (accepted_run_id = btrim(accepted_run_id) and char_length(accepted_run_id) between 1 and 200)),
  accepted_digest text check (accepted_digest is null or accepted_digest ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz,
  projection_state text not null default 'idle' check (projection_state in ('idle', 'pending', 'accepted', 'deferred', 'superseded')),
  check (accepted_generation <= next_generation),
  check ((accepted_generation = 0 and accepted_run_id is null and accepted_digest is null and accepted_at is null)
    or (accepted_generation > 0 and accepted_run_id is not null and accepted_digest is not null and accepted_at is not null))
);

create table if not exists public.deal_hunter_freshness_evidence (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  source_id text not null check (source_id = btrim(source_id) and char_length(source_id) between 1 and 160),
  source_name text not null check (source_name = btrim(source_name) and char_length(source_name) between 1 and 220),
  source_record_id text not null check (source_record_id = btrim(source_record_id) and char_length(source_record_id) between 1 and 200),
  run_id text not null check (run_id = btrim(run_id) and char_length(run_id) between 1 and 200),
  record_digest text check (record_digest is null or record_digest ~ '^[a-f0-9]{64}$'),
  generation bigint not null check (generation > 0),
  event_type text not null check (event_type in ('accepted_source_record', 'publication_evidence', 'material_change', 'evidence_state_change')),
  field_key text not null default '' check (char_length(field_key) <= 80 and field_key = btrim(field_key)),
  event_ordinal integer not null default 0 check (event_ordinal >= 0 and event_ordinal <= 10000),
  accepted_at timestamptz not null default clock_timestamp(),
  original_canonical_id text check (original_canonical_id is null or char_length(original_canonical_id) between 1 and 200),
  current_canonical_id text check (current_canonical_id is null or char_length(current_canonical_id) between 1 and 200),
  identity_exception_id text check (identity_exception_id is null or char_length(identity_exception_id) between 1 and 240),
  binding_audit_id text check (binding_audit_id is null or char_length(binding_audit_id) between 1 and 240),
  provenance_version text not null default 'fl-01-v1' check (provenance_version = btrim(provenance_version) and char_length(provenance_version) between 1 and 80),
  raw_header text check (raw_header is null or char_length(raw_header) <= 100),
  raw_value text check (raw_value is null or char_length(raw_value) <= 200),
  publication_meaning text not null default 'unknown' check (publication_meaning in ('unknown', 'listing_publication')),
  publication_date date,
  publication_instant timestamptz,
  publication_precision text not null default 'unknown' check (publication_precision in ('unknown', 'date', 'instant')),
  publication_offset text check (publication_offset is null or char_length(publication_offset) <= 16),
  publication_state text not null default 'unknown' check (publication_state in ('unknown', 'valid', 'invalid', 'future', 'conflict')),
  before_value numeric,
  after_value numeric,
  before_evidence_id text check (before_evidence_id is null or char_length(before_evidence_id) between 1 and 240),
  after_evidence_id text check (after_evidence_id is null or char_length(after_evidence_id) between 1 and 240),
  metric text not null default 'unknown' check (metric = btrim(metric) and char_length(metric) between 1 and 80),
  currency text not null default 'unknown' check (currency = btrim(currency) and char_length(currency) between 1 and 16),
  period text not null default 'unknown' check (period = btrim(period) and char_length(period) between 1 and 80),
  classification text check (classification is null or classification in ('new_evidence', 'conflict', 'selected_source_swap', 'disappearance', 'comparable_change')),
  material_revision bigint check (material_revision is null or material_revision >= 0),
  unique (run_id, source_id, source_record_id, event_type, field_key, event_ordinal)
);

create index if not exists idx_deal_hunter_freshness_evidence_canonical_time
  on public.deal_hunter_freshness_evidence (current_canonical_id, accepted_at desc, id);
create index if not exists idx_deal_hunter_freshness_evidence_source_record_time
  on public.deal_hunter_freshness_evidence (source_id, source_record_id, accepted_at desc);
create index if not exists idx_deal_hunter_freshness_evidence_run_source_record
  on public.deal_hunter_freshness_evidence (run_id, source_id, source_record_id);

alter table public.deal_hunter_opportunities
  add column if not exists first_accepted_at timestamptz,
  add column if not exists first_discovery_evidence_id text,
  add column if not exists discovery_state text not null default 'untracked_legacy',
  add column if not exists discovery_revision bigint not null default 0,
  add column if not exists material_revision bigint not null default 0,
  add column if not exists last_material_change_at timestamptz;
alter table public.deal_hunter_opportunities
  add constraint deal_hunter_opportunities_freshness_state_check
  check (discovery_state in ('untracked_legacy', 'pending', 'known_prospective', 'known_recovered')
    and discovery_revision >= 0 and material_revision >= 0);
alter table public.deal_hunter_opportunities
  add constraint deal_hunter_opportunities_first_evidence_fk
  foreign key (first_discovery_evidence_id) references public.deal_hunter_freshness_evidence(id) on delete restrict;

alter table public.deal_hunter_opportunity_source_observations
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_run_id text,
  add column if not exists accepted_evidence_id text,
  add column if not exists publication_raw_header text,
  add column if not exists publication_raw_value text,
  add column if not exists publication_precision text,
  add column if not exists publication_offset text,
  add column if not exists publication_meaning text;
alter table public.deal_hunter_opportunity_source_observations
  add constraint deal_hunter_source_observations_freshness_bounds_check
  check ((accepted_run_id is null or char_length(accepted_run_id) between 1 and 200)
    and (accepted_evidence_id is null or char_length(accepted_evidence_id) between 1 and 240)
    and (publication_raw_header is null or char_length(publication_raw_header) <= 100)
    and (publication_raw_value is null or char_length(publication_raw_value) <= 200)
    and (publication_precision is null or publication_precision in ('unknown', 'date', 'instant'))
    and (publication_offset is null or char_length(publication_offset) <= 16)
    and (publication_meaning is null or publication_meaning in ('unknown', 'listing_publication')));
alter table public.deal_hunter_opportunity_source_observations
  add constraint deal_hunter_source_observations_evidence_fk
  foreign key (accepted_evidence_id) references public.deal_hunter_freshness_evidence(id) on delete restrict;

alter table public.deal_hunter_opportunity_scores
  add column if not exists reviewed_discovery_revision bigint not null default 0,
  add column if not exists reviewed_material_revision bigint not null default 0;
alter table public.deal_hunter_opportunity_scores
  add constraint deal_hunter_score_freshness_review_check
  check (reviewed_discovery_revision >= 0 and reviewed_material_revision >= 0);

alter table public.deal_hunter_deal_os_imports
  add column if not exists freshness_generation bigint,
  add column if not exists freshness_projection_state text;
alter table public.deal_hunter_deal_os_imports
  add constraint deal_hunter_import_freshness_check
  check ((freshness_generation is null or freshness_generation > 0)
    and (freshness_projection_state is null or freshness_projection_state in ('pending', 'accepted', 'deferred', 'superseded')));

create or replace function public.guard_deal_hunter_freshness_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'freshness evidence is retained';
  end if;
  if (to_jsonb(new) - 'current_canonical_id' - 'binding_audit_id')
      is distinct from (to_jsonb(old) - 'current_canonical_id' - 'binding_audit_id')
    or new.current_canonical_id is not distinct from old.current_canonical_id
    or new.binding_audit_id is null
    or new.binding_audit_id is not distinct from old.binding_audit_id then
    raise exception 'freshness evidence payload is immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_deal_hunter_freshness_evidence on public.deal_hunter_freshness_evidence;
create trigger guard_deal_hunter_freshness_evidence before update or delete
  on public.deal_hunter_freshness_evidence for each row execute function public.guard_deal_hunter_freshness_evidence();

alter table public.deal_hunter_source_freshness_state enable row level security;
alter table public.deal_hunter_freshness_evidence enable row level security;
revoke all privileges on table public.deal_hunter_source_freshness_state, public.deal_hunter_freshness_evidence from public, anon, authenticated;
grant all privileges on table public.deal_hunter_source_freshness_state, public.deal_hunter_freshness_evidence to service_role;
revoke all on function public.guard_deal_hunter_freshness_evidence() from public, anon, authenticated;

create or replace function public.allocate_deal_hunter_source_generation(p_source_id text, p_run_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state public.deal_hunter_source_freshness_state%rowtype;
  v_generation bigint;
begin
  if p_source_id is null or p_source_id <> btrim(p_source_id) or char_length(p_source_id) not between 1 and 160
    or p_run_id is null or p_run_id <> btrim(p_run_id) or char_length(p_run_id) not between 1 and 200 then
    raise exception 'freshness source and run identities must be bounded' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_source_id, 91901));
  insert into public.deal_hunter_source_freshness_state(source_id) values (p_source_id)
    on conflict(source_id) do nothing;
  select * into strict v_state from public.deal_hunter_source_freshness_state
    where source_id = p_source_id for update;
  if v_state.accepted_run_id = p_run_id then
    return pg_catalog.jsonb_build_object('sourceId', p_source_id, 'runId', p_run_id, 'generation', v_state.accepted_generation);
  end if;
  v_generation := v_state.next_generation + 1;
  update public.deal_hunter_source_freshness_state set next_generation = v_generation where source_id = p_source_id;
  return pg_catalog.jsonb_build_object('sourceId', p_source_id, 'runId', p_run_id, 'generation', v_generation);
end;
$$;
revoke all on function public.allocate_deal_hunter_source_generation(text, text) from public, anon, authenticated;
grant execute on function public.allocate_deal_hunter_source_generation(text, text) to service_role;

create or replace function public.mark_deal_hunter_opportunity_discovery_pending(
  p_opportunity_id text, p_created_at timestamptz
) returns public.deal_hunter_opportunities
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.deal_hunter_opportunities%rowtype;
begin
  select * into v_row from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id for update;
  if not found or v_row.created_at is distinct from p_created_at or v_row.status <> 'active'
    or v_row.first_accepted_at is not null or v_row.discovery_revision <> 0
    or v_row.discovery_state not in ('untracked_legacy', 'pending') then
    raise exception 'freshness pending state requires a newly created active canonical identity' using errcode = '22023';
  end if;
  if v_row.discovery_state = 'untracked_legacy' then
    update public.deal_hunter_opportunities set discovery_state = 'pending'
      where opportunity_id = p_opportunity_id returning * into v_row;
  end if;
  return v_row;
end;
$$;
revoke all on function public.mark_deal_hunter_opportunity_discovery_pending(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.mark_deal_hunter_opportunity_discovery_pending(text, timestamptz)
  to service_role;

create or replace function public.classify_deal_hunter_publication_v1(
  p_claim jsonb, p_accepted_at timestamptz
) returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_raw text := p_claim ->> 'rawValue';
  v_date date;
  v_instant timestamptz;
begin
  if p_claim ->> 'meaning' is distinct from 'listing_publication' then
    return pg_catalog.jsonb_build_object('state', 'unknown');
  end if;
  if p_claim ->> 'precision' = 'date' and v_raw ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    and pg_catalog.pg_input_is_valid(v_raw, 'date') then
    v_date := v_raw::date;
    return pg_catalog.jsonb_build_object('state',
      case when v_date > (p_accepted_at at time zone 'America/Los_Angeles')::date
        then 'future' else 'valid' end, 'date', v_date);
  end if;
  if p_claim ->> 'precision' = 'datetime'
    and v_raw ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
    and pg_catalog.pg_input_is_valid(v_raw, 'timestamptz') then
    v_instant := v_raw::timestamptz;
    return pg_catalog.jsonb_build_object('state',
      case when v_instant > p_accepted_at then 'future' else 'valid' end,
      'instant', v_instant);
  end if;
  return pg_catalog.jsonb_build_object('state', 'invalid');
end;
$$;
revoke all on function public.classify_deal_hunter_publication_v1(jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.classify_deal_hunter_publication_v1(jsonb, timestamptz)
  to service_role;

create or replace function public.insert_deal_hunter_deal_os_import_freshness_v1(
  p_import jsonb, p_rows jsonb, p_generation bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state public.deal_hunter_source_freshness_state%rowtype;
  v_import_id uuid;
  v_digest text;
  v_accepted_at timestamptz;
  v_row jsonb;
  v_claim jsonb;
  v_publication jsonb;
  v_source_record_id text;
  v_ordinal integer;
  v_field text;
  v_field_key text;
  v_after_value numeric;
  v_stored public.deal_hunter_deal_os_imports%rowtype;
begin
  if pg_catalog.jsonb_typeof(p_import) <> 'object' or pg_catalog.jsonb_typeof(p_rows) <> 'array'
    or p_import ->> 'file_sha256' !~ '^[a-f0-9]{64}$'
    or p_generation is null or p_generation < 1 then
    raise exception 'Deal OS freshness import is malformed' using errcode = '22023';
  end if;
  v_import_id := (p_import ->> 'id')::uuid;
  if pg_catalog.jsonb_array_length(p_rows) <> (p_import ->> 'accepted_row_count')::integer
    or pg_catalog.jsonb_array_length(p_rows) not between 1 and 10000 then
    raise exception 'Deal OS accepted row scope is incomplete' using errcode = '22023';
  end if;
  v_digest := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_import ->> 'file_sha256', p_import -> 'row_accounting', p_import -> 'records', p_import ->> 'scope', p_rows
  )::text) || pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_import ->> 'file_sha256', p_import -> 'row_accounting', p_import -> 'records', p_import ->> 'scope', p_rows, 'fl-01-v1'
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('deal-os-export', 91901));
  select * into strict v_state from public.deal_hunter_source_freshness_state
    where source_id = 'deal-os-export' for update;
  if p_generation > v_state.next_generation then
    raise exception 'Deal OS generation was not allocated' using errcode = '22023';
  end if;
  if p_generation <= v_state.accepted_generation then
    if p_generation <> v_state.accepted_generation or v_state.accepted_run_id <> v_import_id::text
      or v_state.accepted_digest <> v_digest then
      raise exception 'stale or conflicting Deal OS freshness run' using errcode = '40001';
    end if;
    select * into v_stored from public.deal_hunter_deal_os_imports where id = v_import_id;
    if not found or v_stored.file_sha256 <> p_import ->> 'file_sha256' then
      raise exception 'conflicting Deal OS import replay' using errcode = '22023';
    end if;
    return to_jsonb(v_stored);
  end if;
  v_accepted_at := pg_catalog.clock_timestamp();
  insert into public.deal_hunter_deal_os_imports (
    id, created_at, imported_by, exported_at, file_name, file_type, file_size, file_sha256,
    scope, coverage_label, expected_row_count, row_count, source_row_count, accepted_row_count,
    rejected_row_count, canonical_record_count, parser_version, row_accounting,
    duplicate_count, stable_id_count, listing_url_count, coverage_limit_reached, records, metadata,
    freshness_generation, freshness_projection_state
  ) values (
    v_import_id, (p_import ->> 'created_at')::timestamptz, p_import ->> 'imported_by',
    (p_import ->> 'exported_at')::timestamptz, p_import ->> 'file_name', p_import ->> 'file_type',
    (p_import ->> 'file_size')::integer, p_import ->> 'file_sha256', p_import ->> 'scope',
    p_import ->> 'coverage_label', (p_import ->> 'expected_row_count')::integer,
    (p_import ->> 'row_count')::integer, (p_import ->> 'source_row_count')::integer,
    (p_import ->> 'accepted_row_count')::integer, (p_import ->> 'rejected_row_count')::integer,
    (p_import ->> 'canonical_record_count')::integer, p_import ->> 'parser_version',
    coalesce(p_import -> 'row_accounting', '[]'::jsonb),
    (p_import ->> 'duplicate_count')::integer, (p_import ->> 'stable_id_count')::integer,
    (p_import ->> 'listing_url_count')::integer, (p_import ->> 'coverage_limit_reached')::boolean,
    coalesce(p_import -> 'records', '[]'::jsonb), coalesce(p_import -> 'metadata', '{}'::jsonb),
    p_generation, 'pending'
  );
  for v_row in select value from pg_catalog.jsonb_array_elements(p_rows) as rows(value) loop
    v_source_record_id := v_row ->> 'sourceRecordId';
    v_ordinal := (v_row ->> 'eventOrdinal')::integer;
    if v_source_record_id is null or v_source_record_id <> btrim(v_source_record_id)
      or char_length(v_source_record_id) not between 1 and 200 or v_ordinal not between 0 and 10000
      or pg_catalog.jsonb_typeof(v_row -> 'freshnessEvidence') <> 'object' then
      raise exception 'Deal OS source row evidence is unbounded' using errcode = '22023';
    end if;
    insert into public.deal_hunter_freshness_evidence (
      id, source_id, source_name, source_record_id, run_id, generation,
      event_type, field_key, event_ordinal, accepted_at
    ) values (
      'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_import_id::text, v_source_record_id, 'accepted_source_record', '', v_ordinal::text)),
      'deal-os-export', 'SMB Deal OS export', v_source_record_id, v_import_id::text, p_generation,
      'accepted_source_record', '', v_ordinal, v_accepted_at
    );
    v_claim := v_row -> 'freshnessEvidence' -> 'dateAdded';
    if pg_catalog.jsonb_typeof(v_claim) = 'object' then
      v_publication := public.classify_deal_hunter_publication_v1(v_claim, v_accepted_at);
      if char_length(v_claim ->> 'rawHeader') > 100 or char_length(v_claim ->> 'rawValue') > 200 then
        raise exception 'Deal OS publication evidence is unbounded' using errcode = '22023';
      end if;
      insert into public.deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation,
        event_type, field_key, event_ordinal, accepted_at, raw_header, raw_value,
        publication_meaning, publication_precision, publication_date,
        publication_instant, publication_state, publication_offset
      ) values (
        'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_import_id::text, v_source_record_id, 'publication_evidence', 'date_added', v_ordinal::text)),
        'deal-os-export', 'SMB Deal OS export', v_source_record_id, v_import_id::text, p_generation,
        'publication_evidence', 'date_added', v_ordinal, v_accepted_at,
        v_claim ->> 'rawHeader', v_claim ->> 'rawValue',
        coalesce(v_claim ->> 'meaning', 'unknown'),
        case when v_claim ->> 'precision' = 'datetime' then 'instant'
          when v_claim ->> 'precision' = 'date' then 'date' else 'unknown' end,
        (v_publication ->> 'date')::date, (v_publication ->> 'instant')::timestamptz,
        v_publication ->> 'state', v_claim ->> 'offset'
      );
    end if;
    foreach v_field in array array['annualProfit', 'annualRevenue', 'askingPrice'] loop
      v_claim := v_row -> 'freshnessEvidence' -> v_field;
      if pg_catalog.jsonb_typeof(v_claim) is distinct from 'object' then continue; end if;
      if char_length(v_claim ->> 'rawHeader') > 100 or char_length(v_claim ->> 'rawValue') > 200 then
        raise exception 'Deal OS financial evidence is unbounded' using errcode = '22023';
      end if;
      v_field_key := case v_field when 'annualProfit' then 'annual_profit'
        when 'annualRevenue' then 'annual_revenue' else 'asking_price' end;
      v_after_value := null;
      if v_claim ->> 'rawValue' ~ '^\$?[0-9][0-9,]*(\.[0-9]+)?$' then
        v_after_value := pg_catalog.regexp_replace(v_claim ->> 'rawValue', '[$,]', '', 'g')::numeric;
      end if;
      insert into public.deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation,
        event_type, field_key, event_ordinal, accepted_at, raw_header, raw_value,
        after_value, metric, currency, period
      ) values (
        'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_import_id::text, v_source_record_id, 'accepted_source_record', v_field_key, v_ordinal::text)),
        'deal-os-export', 'SMB Deal OS export', v_source_record_id, v_import_id::text, p_generation,
        'accepted_source_record', v_field_key, v_ordinal, v_accepted_at,
        v_claim ->> 'rawHeader', v_claim ->> 'rawValue', v_after_value,
        coalesce(v_claim ->> 'metric', 'unknown'), coalesce(v_claim ->> 'currency', 'unknown'),
        coalesce(v_claim ->> 'period', 'unknown')
      );
    end loop;
  end loop;
  update public.deal_hunter_deal_os_imports set freshness_projection_state = 'superseded'
    where id <> v_import_id and freshness_projection_state = 'pending';
  update public.deal_hunter_source_freshness_state set
    accepted_generation = p_generation, accepted_run_id = v_import_id::text,
    accepted_digest = v_digest, accepted_at = v_accepted_at, projection_state = 'pending'
    where source_id = 'deal-os-export';
  select * into strict v_stored from public.deal_hunter_deal_os_imports where id = v_import_id;
  return to_jsonb(v_stored);
end;
$$;
revoke all on function public.insert_deal_hunter_deal_os_import_freshness_v1(jsonb, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.insert_deal_hunter_deal_os_import_freshness_v1(jsonb, jsonb, bigint)
  to service_role;

create or replace function public.accept_admitted_complete_google_sheet_freshness_v1(
  p_admission jsonb, p_records_text text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_source_id text;
  v_source_name text;
  v_run_id text;
  v_generation bigint;
  v_digest text;
  v_state public.deal_hunter_source_freshness_state%rowtype;
  v_records jsonb;
  v_unresolved jsonb := '[]'::jsonb;
  v_legacy_records jsonb;
  v_record jsonb;
  v_claim jsonb;
  v_publication jsonb;
  v_field text;
  v_core_id text;
  v_prior_id text;
  v_prior_digest text;
  v_recovered_id text;
  v_recovered_at timestamptz;
  v_recovered_run text;
  v_recovered_source_record_id text;
  v_recovered_exception_id text;
  v_before public.deal_hunter_freshness_evidence%rowtype;
  v_before_observation public.deal_hunter_opportunity_source_observations%rowtype;
  v_old_observation public.deal_hunter_opportunity_source_observations%rowtype;
  v_after_value numeric;
  v_field_key text;
  v_after_id text;
  v_competing boolean;
  v_comparable boolean;
  v_revision bigint;
  v_record_digest text;
  v_event_ids jsonb := '{}'::jsonb;
  v_accepted_at timestamptz;
begin
  if pg_catalog.jsonb_typeof(p_admission) <> 'object'
    or pg_catalog.jsonb_typeof(p_admission -> 'run') <> 'object'
    or p_records_text is null or pg_catalog.octet_length(p_records_text) not between 1 and 67108864
    or p_admission ->> 'freshness_digest' !~ '^[a-f0-9]{64}$' then
    raise exception 'complete Sheet freshness admission is malformed' using errcode = '22023';
  end if;
  v_source_id := p_admission ->> 'source_id';
  v_source_name := p_admission ->> 'source_name';
  v_run_id := p_admission -> 'run' ->> 'runId';
  v_generation := (p_admission -> 'run' ->> 'generation')::bigint;
  v_digest := pg_catalog.md5(p_records_text)
    || pg_catalog.md5(pg_catalog.md5(p_records_text) || v_run_id || v_generation::text);
  if p_admission -> 'run' ->> 'sourceId' is distinct from v_source_id
    or v_source_id !~ '^sheet-(0|[1-9][0-9]{0,3})$'
    or v_run_id is null or char_length(v_run_id) not between 1 and 200
    or v_generation < 1 or v_digest <> p_admission ->> 'freshness_digest' then
    raise exception 'complete Sheet freshness digest or run is invalid' using errcode = '22023';
  end if;
  v_records := p_records_text::jsonb;
  if pg_catalog.jsonb_typeof(v_records) = 'object' then
    v_unresolved := v_records -> 'unresolved';
    v_records := v_records -> 'records';
  end if;
  if pg_catalog.jsonb_typeof(v_records) <> 'array'
    or pg_catalog.jsonb_typeof(v_unresolved) <> 'array'
    or pg_catalog.jsonb_array_length(v_records) + pg_catalog.jsonb_array_length(v_unresolved)
      <> (p_admission ->> 'record_count')::integer
    or pg_catalog.jsonb_array_length(v_records) + pg_catalog.jsonb_array_length(v_unresolved)
      not between 1 and 10000
    or pg_catalog.jsonb_array_length(v_unresolved) <> coalesce((p_admission ->> 'deferred_count')::integer, 0)
    or pg_catalog.jsonb_array_length(v_records) <> coalesce((p_admission ->> 'resolved_count')::integer,
      pg_catalog.jsonb_array_length(v_records)) then
    raise exception 'complete Sheet freshness records are not the admitted scope' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(v_records) as record(value)
    where pg_catalog.jsonb_typeof(record.value -> 'freshness_evidence') not in ('object', 'null')
      or record.value ->> 'source_id' is distinct from v_source_id
      or record.value ->> 'source_name' is distinct from v_source_name
      or char_length(record.value ->> 'source_record_id') not between 1 and 200
      or char_length(record.value ->> 'opportunity_id') not between 1 and 200
  ) then
    raise exception 'complete Sheet freshness source records are malformed' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(v_unresolved) as item(value)
    where char_length(item.value ->> 'source_record_id') not between 1 and 200
      or char_length(item.value ->> 'identity_exception_id') not between 1 and 240
      or pg_catalog.jsonb_typeof(item.value -> 'freshness_evidence') not in ('object', 'null')
  ) or (
    select count(distinct source_record_id) from (
      select record.value ->> 'source_record_id' as source_record_id
        from pg_catalog.jsonb_array_elements(v_records) as record(value)
      union all
      select item.value ->> 'source_record_id'
        from pg_catalog.jsonb_array_elements(v_unresolved) as item(value)
    ) as all_records
  ) <> (p_admission ->> 'record_count')::integer then
    raise exception 'complete Sheet deferred records are malformed or duplicated' using errcode = '22023';
  end if;
  select pg_catalog.jsonb_agg(record.value - 'freshness_evidence' order by record.ordinality)
    into v_legacy_records
    from pg_catalog.jsonb_array_elements(v_records) with ordinality as record(value, ordinality);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(v_source_id)::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_source_id, 91901));
  select * into strict v_state from public.deal_hunter_source_freshness_state
    where source_id = v_source_id for update;
  if v_generation > v_state.next_generation then
    raise exception 'complete Sheet freshness generation was not allocated' using errcode = '22023';
  end if;
  if v_generation <= v_state.accepted_generation then
    if v_generation <> v_state.accepted_generation or v_state.accepted_run_id <> v_run_id
      or v_state.accepted_digest <> v_digest then
      raise exception 'stale or conflicting complete Sheet freshness run' using errcode = '40001';
    end if;
    return pg_catalog.jsonb_build_object('acceptedAt', v_state.accepted_at,
      'projectionState', v_state.projection_state, 'replayed', true);
  end if;
  v_accepted_at := pg_catalog.clock_timestamp();
  if pg_catalog.jsonb_array_length(v_unresolved) > 0 then
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(v_unresolved) as item(value)
      left join public.deal_hunter_identity_exceptions as exception
        on exception.id = item.value ->> 'identity_exception_id' and exception.status = 'open'
      where exception.id is null
    ) then
      raise exception 'deferred Sheet evidence lacks an open identity exception' using errcode = '22023';
    end if;
    for v_record in select value from (
      select value from pg_catalog.jsonb_array_elements(v_records) as resolved(value)
      union all
      select value from pg_catalog.jsonb_array_elements(v_unresolved) as pending(value)
    ) as all_records loop
      v_record_digest := pg_catalog.md5(v_record::text) || pg_catalog.md5(v_record::text || 'fl-01-v1');
      insert into public.deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation, record_digest,
        event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
        identity_exception_id
      ) values (
        'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
          v_record ->> 'source_record_id', 'accepted_source_record', '')),
        v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id, v_generation,
        v_record_digest, 'accepted_source_record', '', v_accepted_at,
        v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
        v_record ->> 'identity_exception_id'
      );
      v_claim := v_record -> 'freshness_evidence' -> 'dateAdded';
      if pg_catalog.jsonb_typeof(v_claim) = 'object' then
        v_publication := public.classify_deal_hunter_publication_v1(v_claim, v_accepted_at);
        insert into public.deal_hunter_freshness_evidence (
          id, source_id, source_name, source_record_id, run_id, generation, record_digest,
          event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
          identity_exception_id, raw_header, raw_value, publication_meaning,
          publication_precision, publication_offset, publication_date,
          publication_instant, publication_state
        ) values (
          'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
            v_record ->> 'source_record_id', 'publication_evidence', 'date_added')),
          v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
          v_generation, v_record_digest, 'publication_evidence', 'date_added', v_accepted_at,
          v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
          v_record ->> 'identity_exception_id', v_claim ->> 'rawHeader', v_claim ->> 'rawValue',
          coalesce(v_claim ->> 'meaning', 'unknown'),
          case when v_claim ->> 'precision' = 'datetime' then 'instant'
            when v_claim ->> 'precision' = 'date' then 'date' else 'unknown' end,
          v_claim ->> 'offset', (v_publication ->> 'date')::date,
          (v_publication ->> 'instant')::timestamptz, v_publication ->> 'state'
        );
      end if;
      foreach v_field in array array['annualProfit', 'annualRevenue', 'askingPrice'] loop
        v_claim := v_record -> 'freshness_evidence' -> v_field;
        if pg_catalog.jsonb_typeof(v_claim) is distinct from 'object' then continue; end if;
        if char_length(v_claim ->> 'rawHeader') > 100 or char_length(v_claim ->> 'rawValue') > 200 then
          raise exception 'deferred Sheet financial evidence is unbounded' using errcode = '22023';
        end if;
        v_field_key := case v_field when 'annualProfit' then 'annual_profit'
          when 'annualRevenue' then 'annual_revenue' else 'asking_price' end;
        v_after_value := null;
        if v_claim ->> 'rawValue' ~ '^\$?[0-9][0-9,]*(\.[0-9]+)?$' then
          v_after_value := pg_catalog.regexp_replace(v_claim ->> 'rawValue', '[$,]', '', 'g')::numeric;
        end if;
        insert into public.deal_hunter_freshness_evidence (
          id, source_id, source_name, source_record_id, run_id, generation, record_digest,
          event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
          identity_exception_id, raw_header, raw_value, after_value, metric, currency, period
        ) values (
          'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
            v_record ->> 'source_record_id', 'accepted_source_record', v_field_key)),
          v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
          v_generation, v_record_digest, 'accepted_source_record', v_field_key, v_accepted_at,
          v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
          v_record ->> 'identity_exception_id', v_claim ->> 'rawHeader', v_claim ->> 'rawValue',
          v_after_value, coalesce(v_claim ->> 'metric', 'unknown'),
          coalesce(v_claim ->> 'currency', 'unknown'), coalesce(v_claim ->> 'period', 'unknown')
        );
      end loop;
    end loop;
    update public.deal_hunter_source_freshness_state set
      accepted_generation = v_generation, accepted_run_id = v_run_id,
      accepted_digest = v_digest, accepted_at = v_accepted_at, projection_state = 'deferred'
      where source_id = v_source_id;
    return pg_catalog.jsonb_build_object('acceptedAt', v_accepted_at,
      'projectionState', 'deferred', 'replayed', false);
  end if;
  for v_record in select value from pg_catalog.jsonb_array_elements(v_records) as records(value) loop
    v_record_digest := pg_catalog.md5(pg_catalog.jsonb_build_object(
      'sourceRecordId', v_record ->> 'source_record_id',
      'fields', coalesce((select pg_catalog.jsonb_object_agg(field.value ->> 'field',
        field.value ->> 'value') from pg_catalog.jsonb_array_elements(
        v_record -> 'observations') as field(value)), '{}'::jsonb),
      'freshnessEvidence', v_record -> 'freshness_evidence')::text)
      || pg_catalog.md5('fl-01-v1' || pg_catalog.jsonb_build_object(
      'sourceRecordId', v_record ->> 'source_record_id',
      'fields', coalesce((select pg_catalog.jsonb_object_agg(field.value ->> 'field',
        field.value ->> 'value') from pg_catalog.jsonb_array_elements(
        v_record -> 'observations') as field(value)), '{}'::jsonb),
      'freshnessEvidence', v_record -> 'freshness_evidence')::text);
    select observation.accepted_evidence_id into v_prior_id
      from public.deal_hunter_opportunity_source_observations as observation
      where observation.source_id = v_source_id
        and observation.source_record_id = v_record ->> 'source_record_id'
        and observation.opportunity_id = v_record ->> 'opportunity_id'
      order by observation.id limit 1;
    select evidence.record_digest into v_prior_digest from public.deal_hunter_freshness_evidence as evidence
      where evidence.id = v_prior_id;
    if v_prior_digest = v_record_digest then
      v_core_id := v_prior_id;
    else
      v_core_id := 'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id,
        v_source_id, v_record ->> 'source_record_id', 'accepted_source_record', ''));
      insert into public.deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation, record_digest,
        event_type, field_key, accepted_at, original_canonical_id, current_canonical_id
      ) values (
        v_core_id, v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
        v_generation, v_record_digest, 'accepted_source_record', '', v_accepted_at,
        v_record ->> 'opportunity_id', v_record ->> 'opportunity_id'
      );
      v_claim := v_record -> 'freshness_evidence' -> 'dateAdded';
      if pg_catalog.jsonb_typeof(v_claim) = 'object' then
        v_publication := public.classify_deal_hunter_publication_v1(v_claim, v_accepted_at);
        if char_length(v_claim ->> 'rawHeader') > 100 or char_length(v_claim ->> 'rawValue') > 200 then
          raise exception 'complete Sheet publication evidence is unbounded' using errcode = '22023';
        end if;
        insert into public.deal_hunter_freshness_evidence (
          id, source_id, source_name, source_record_id, run_id, generation, record_digest,
          event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
          raw_header, raw_value, publication_meaning, publication_precision, publication_offset,
          publication_date, publication_instant, publication_state
        ) values (
          'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
            v_record ->> 'source_record_id', 'publication_evidence', 'date_added')),
          v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
          v_generation, v_record_digest, 'publication_evidence', 'date_added', v_accepted_at,
          v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
          v_claim ->> 'rawHeader', v_claim ->> 'rawValue',
          coalesce(v_claim ->> 'meaning', 'unknown'),
          case when v_claim ->> 'precision' = 'datetime' then 'instant'
            when v_claim ->> 'precision' = 'date' then 'date' else 'unknown' end,
          v_claim ->> 'offset', (v_publication ->> 'date')::date,
          (v_publication ->> 'instant')::timestamptz, v_publication ->> 'state'
        );
      end if;
      foreach v_field in array array['annualProfit', 'annualRevenue', 'askingPrice'] loop
        v_claim := v_record -> 'freshness_evidence' -> v_field;
        if pg_catalog.jsonb_typeof(v_claim) is distinct from 'object' then continue; end if;
        if char_length(v_claim ->> 'rawHeader') > 100 or char_length(v_claim ->> 'rawValue') > 200 then
          raise exception 'complete Sheet financial evidence is unbounded' using errcode = '22023';
        end if;
        v_field_key := case v_field when 'annualProfit' then 'annual_profit'
          when 'annualRevenue' then 'annual_revenue' else 'asking_price' end;
        v_after_id := 'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
          v_record ->> 'source_record_id', 'accepted_source_record', v_field_key));
        v_after_value := null;
        if pg_catalog.regexp_replace(v_claim ->> 'rawValue', '[$,]', '', 'g') ~ '^-?[0-9]+(\.[0-9]+)?$' then
          v_after_value := pg_catalog.regexp_replace(v_claim ->> 'rawValue', '[$,]', '', 'g')::numeric;
        end if;
        insert into public.deal_hunter_freshness_evidence (
          id, source_id, source_name, source_record_id, run_id, generation, record_digest,
          event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
          raw_header, raw_value, after_value, metric, currency, period
        ) values (
          v_after_id,
          v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
          v_generation, v_record_digest, 'accepted_source_record', v_field_key, v_accepted_at,
          v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
          v_claim ->> 'rawHeader', v_claim ->> 'rawValue', v_after_value,
          coalesce(v_claim ->> 'metric', 'unknown'), coalesce(v_claim ->> 'currency', 'unknown'),
          coalesce(v_claim ->> 'period', 'unknown')
        );
        select * into v_before_observation from public.deal_hunter_opportunity_source_observations
          where source_id = v_source_id and source_record_id = v_record ->> 'source_record_id'
            and field = v_field_key limit 1;
        select previous_field.* into v_before
          from public.deal_hunter_freshness_evidence as previous_core
          join public.deal_hunter_freshness_evidence as previous_field
            on previous_field.run_id = previous_core.run_id
            and previous_field.source_id = previous_core.source_id
            and previous_field.source_record_id = previous_core.source_record_id
            and previous_field.event_type = 'accepted_source_record'
            and previous_field.field_key = v_field_key
          where previous_core.id = v_before_observation.accepted_evidence_id;
        if v_before.id is null then
          select * into v_before from public.deal_hunter_freshness_evidence
            where source_id = v_source_id
              and source_record_id = v_record ->> 'source_record_id'
              and field_key = v_field_key and event_type = 'accepted_source_record'
              and run_id <> v_run_id
              and current_canonical_id = v_record ->> 'opportunity_id'
            order by accepted_at desc, id desc limit 1;
        end if;
        if v_before_observation.opportunity_id is distinct from v_record ->> 'opportunity_id'
          or v_before.after_value is not distinct from v_after_value then continue; end if;
        select exists (select 1 from public.deal_hunter_opportunity_source_observations
          where opportunity_id = v_record ->> 'opportunity_id'
            and source_id <> v_source_id and field = v_field_key
            and value is distinct from v_after_value::text) into v_competing;
        v_comparable := v_before.id is not null and not v_competing
          and v_before.after_value is not null and v_after_value is not null
          and v_claim ->> 'metric' is not null and v_claim ->> 'metric' <> 'unknown'
          and v_claim ->> 'currency' is not null and v_claim ->> 'currency' <> 'unknown'
          and v_claim ->> 'period' is not null and v_claim ->> 'period' <> 'unknown'
          and v_before.metric = v_claim ->> 'metric'
          and v_before.currency = v_claim ->> 'currency'
          and v_before.period = v_claim ->> 'period'
          and v_before.current_canonical_id = v_record ->> 'opportunity_id';
        if v_comparable then
          update public.deal_hunter_opportunities set material_revision = material_revision + 1,
            last_material_change_at = v_accepted_at
            where opportunity_id = v_record ->> 'opportunity_id'
            returning material_revision into v_revision;
        else
          v_revision := null;
        end if;
        insert into public.deal_hunter_freshness_evidence (
          id, source_id, source_name, source_record_id, run_id, generation, record_digest,
          event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
          before_value, after_value, before_evidence_id, after_evidence_id,
          metric, currency, period, classification, material_revision
        ) values (
          'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
            v_record ->> 'source_record_id',
            case when v_comparable then 'material_change' else 'evidence_state_change' end, v_field_key)),
          v_source_id, v_source_name, v_record ->> 'source_record_id', v_run_id,
          v_generation, v_record_digest,
          case when v_comparable then 'material_change' else 'evidence_state_change' end,
          v_field_key, v_accepted_at, v_record ->> 'opportunity_id', v_record ->> 'opportunity_id',
          v_before.after_value, v_after_value, v_before.id, v_after_id,
          coalesce(v_claim ->> 'metric', 'unknown'), coalesce(v_claim ->> 'currency', 'unknown'),
          coalesce(v_claim ->> 'period', 'unknown'),
          case when v_comparable then 'comparable_change' when v_competing then 'conflict'
            else 'new_evidence' end, v_revision
        );
      end loop;
      select evidence.id, evidence.accepted_at, evidence.run_id,
          evidence.source_record_id, evidence.identity_exception_id
        into v_recovered_id, v_recovered_at, v_recovered_run,
          v_recovered_source_record_id, v_recovered_exception_id
        from public.deal_hunter_freshness_evidence as evidence
        left join public.deal_hunter_identity_exceptions as exception
          on exception.id = evidence.identity_exception_id
        where evidence.source_id = v_source_id
          and evidence.run_id <> v_run_id
          and evidence.event_type = 'accepted_source_record' and evidence.field_key = ''
          and (evidence.current_canonical_id = v_record ->> 'opportunity_id'
            or (evidence.current_canonical_id is null and exception.status = 'resolved'
              and exception.metadata ->> 'resolvedOpportunityId' = v_record ->> 'opportunity_id'))
        order by evidence.accepted_at, evidence.id limit 1;
      if v_recovered_exception_id is not null then
        update public.deal_hunter_freshness_evidence set
          current_canonical_id = v_record ->> 'opportunity_id', binding_audit_id = v_run_id
          where source_id = v_source_id and source_record_id = v_recovered_source_record_id
            and run_id = v_recovered_run and current_canonical_id is null
            and identity_exception_id = v_recovered_exception_id;
      end if;
      update public.deal_hunter_opportunities set
        first_accepted_at = coalesce(v_recovered_at, v_accepted_at),
        first_discovery_evidence_id = coalesce(v_recovered_id, v_core_id),
        discovery_state = case when v_recovered_id is not null
          or exists (select 1 from public.deal_hunter_opportunity_source_observations as prior
            where prior.opportunity_id = v_record ->> 'opportunity_id'
              and prior.source_id = v_source_id
              and prior.source_record_id = v_record ->> 'source_record_id'
              and prior.accepted_evidence_id is null)
          then 'known_recovered'
          else 'known_prospective' end, discovery_revision = discovery_revision + 1
        where opportunity_id = v_record ->> 'opportunity_id'
          and discovery_state = 'pending' and first_accepted_at is null;
    end if;
    v_event_ids := v_event_ids || pg_catalog.jsonb_build_object(v_record ->> 'source_record_id', v_core_id);
  end loop;

  for v_old_observation in select observation.*
    from public.deal_hunter_opportunity_source_observations as observation
    where observation.source_id = v_source_id
      and observation.field in ('asking_price', 'annual_profit', 'annual_revenue')
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(v_records) as record(value)
        cross join lateral pg_catalog.jsonb_array_elements(record.value -> 'observations') as field(value)
        where record.value ->> 'opportunity_id' = observation.opportunity_id
          and record.value ->> 'source_record_id' = observation.source_record_id
          and field.value ->> 'field' = observation.field
      )
  loop
    select prior_field.* into v_before
      from public.deal_hunter_freshness_evidence as prior_core
      join public.deal_hunter_freshness_evidence as prior_field
        on prior_field.run_id = prior_core.run_id and prior_field.source_id = prior_core.source_id
        and prior_field.source_record_id = prior_core.source_record_id
        and prior_field.event_type = 'accepted_source_record'
        and prior_field.field_key = v_old_observation.field
      where prior_core.id = v_old_observation.accepted_evidence_id;
    if v_before.id is not null then
      insert into public.deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation,
        event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
        before_value, before_evidence_id, metric, currency, period, classification
      ) values (
        'fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', v_run_id, v_source_id,
          v_old_observation.source_record_id, 'evidence_state_change', v_old_observation.field)),
        v_source_id, v_source_name, v_old_observation.source_record_id, v_run_id, v_generation,
        'evidence_state_change', v_old_observation.field, v_accepted_at,
        v_old_observation.opportunity_id, v_old_observation.opportunity_id,
        v_before.after_value, v_before.id, v_before.metric, v_before.currency,
        v_before.period, 'disappearance'
      );
    end if;
  end loop;
  perform 1 from public.replace_admitted_complete_google_sheet_source_snapshot(
    p_admission - 'run' - 'freshness_digest' - 'resolved_count' - 'deferred_count', v_legacy_records);
  for v_record in select value from pg_catalog.jsonb_array_elements(v_records) as records(value) loop
    v_claim := v_record -> 'freshness_evidence' -> 'dateAdded';
    update public.deal_hunter_opportunity_source_observations as observation set
      accepted_at = v_accepted_at, accepted_run_id = v_run_id,
      accepted_evidence_id = v_event_ids ->> (v_record ->> 'source_record_id'),
      publication_raw_header = case when observation.field = 'date_added' then v_claim ->> 'rawHeader' else null end,
      publication_raw_value = case when observation.field = 'date_added' then v_claim ->> 'rawValue' else null end,
      publication_precision = case when observation.field = 'date_added' then
        case when v_claim ->> 'precision' = 'datetime' then 'instant' else v_claim ->> 'precision' end else null end,
      publication_offset = case when observation.field = 'date_added' then v_claim ->> 'offset' else null end,
      publication_meaning = case when observation.field = 'date_added' then v_claim ->> 'meaning' else null end
      where observation.source_id = v_source_id
        and observation.source_record_id = v_record ->> 'source_record_id'
        and observation.opportunity_id = v_record ->> 'opportunity_id';
  end loop;
  update public.deal_hunter_source_freshness_state set
    accepted_generation = v_generation, accepted_run_id = v_run_id,
    accepted_digest = v_digest, accepted_at = v_accepted_at, projection_state = 'accepted'
    where source_id = v_source_id;
  return pg_catalog.jsonb_build_object('acceptedAt', v_accepted_at,
    'projectionState', 'accepted', 'replayed', false);
end;
$$;
revoke all on function public.accept_admitted_complete_google_sheet_freshness_v1(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.accept_admitted_complete_google_sheet_freshness_v1(jsonb, text)
  to service_role;

create or replace function public.bind_accepted_deal_hunter_freshness_v1(
  p_import_id uuid, p_opportunity_id text, p_source_record_id text,
  p_expected_generation bigint, p_snapshot jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_import public.deal_hunter_deal_os_imports%rowtype;
  v_state public.deal_hunter_source_freshness_state%rowtype;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_event public.deal_hunter_freshness_evidence%rowtype;
  v_prior_event public.deal_hunter_freshness_evidence%rowtype;
  v_current_listing text;
  v_prior_listing text;
  v_proven_earlier boolean;
  v_observation jsonb;
  v_publication jsonb;
  v_unbound integer;
  v_projection_state text;
  v_field text;
  v_field_key text;
  v_after public.deal_hunter_freshness_evidence%rowtype;
  v_before public.deal_hunter_freshness_evidence%rowtype;
  v_prior_observation public.deal_hunter_opportunity_source_observations%rowtype;
  v_competing boolean;
  v_comparable boolean;
  v_revision bigint;
  v_transition_type text;
begin
  if p_import_id is null or p_opportunity_id is null or p_source_record_id is null
    or char_length(p_opportunity_id) not between 1 and 200
    or char_length(p_source_record_id) not between 1 and 200
    or p_expected_generation is null or p_expected_generation < 1
    or pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
    or p_snapshot ->> 'opportunity_id' is distinct from p_opportunity_id
    or p_snapshot ->> 'source_id' is distinct from 'deal-os-export'
    or p_snapshot ->> 'source_record_id' is distinct from p_source_record_id
    or pg_catalog.jsonb_typeof(p_snapshot -> 'observations') <> 'array'
    or pg_catalog.jsonb_array_length(p_snapshot -> 'observations') not between 1 and 51 then
    raise exception 'Deal OS accepted binding snapshot is malformed' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('deal-os-export', 91901));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_opportunity_id, 91902));
  select * into v_import from public.deal_hunter_deal_os_imports
    where id = p_import_id for update;
  select * into v_state from public.deal_hunter_source_freshness_state
    where source_id = 'deal-os-export' for update;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id for update;
  select * into v_event from public.deal_hunter_freshness_evidence
    where run_id = p_import_id::text and source_id = 'deal-os-export'
      and source_record_id = p_source_record_id
      and event_type = 'accepted_source_record' and field_key = ''
    order by event_ordinal limit 1;
  if v_import.id is null or v_import.freshness_generation is distinct from p_expected_generation
    or v_event.id is null or v_event.generation <> p_expected_generation
    or v_opportunity.opportunity_id is null or v_opportunity.status <> 'active' then
    raise exception 'Deal OS accepted binding lacks an import, event, or current canonical identity' using errcode = '22023';
  end if;
  if exists (select 1 from public.deal_hunter_freshness_evidence
    where run_id = p_import_id::text and source_id = 'deal-os-export'
      and source_record_id = p_source_record_id
      and current_canonical_id is not null and current_canonical_id <> p_opportunity_id) then
    raise exception 'Deal OS accepted evidence is bound to another canonical identity' using errcode = '23505';
  end if;
  update public.deal_hunter_freshness_evidence set
    current_canonical_id = p_opportunity_id, binding_audit_id = p_import_id::text
    where run_id = p_import_id::text and source_id = 'deal-os-export'
      and source_record_id = p_source_record_id and current_canonical_id is null;
  select earlier.* into v_prior_event
    from public.deal_hunter_freshness_evidence as earlier
    where earlier.source_id = 'deal-os-export' and earlier.source_record_id = p_source_record_id
      and earlier.event_type = 'accepted_source_record' and earlier.field_key = ''
      and earlier.accepted_at < v_event.accepted_at
    order by earlier.accepted_at, earlier.id limit 1;
  select prior_import.row_accounting -> v_prior_event.event_ordinal::integer ->> 'listingIdentity'
    into v_prior_listing from public.deal_hunter_deal_os_imports as prior_import
    where prior_import.id::text = v_prior_event.run_id;
  v_current_listing := v_import.row_accounting -> v_event.event_ordinal::integer ->> 'listingIdentity';
  v_proven_earlier := v_prior_event.id is not null and nullif(v_current_listing, '') is not null
    and v_prior_listing = v_current_listing;
  if v_proven_earlier and v_prior_event.current_canonical_id is not null
    and v_prior_event.current_canonical_id <> p_opportunity_id then
    raise exception 'Earlier accepted Deal OS listing is bound to another canonical identity' using errcode = '23505';
  end if;
  if v_proven_earlier and v_prior_event.current_canonical_id is null then
    update public.deal_hunter_freshness_evidence set
      current_canonical_id = p_opportunity_id, binding_audit_id = p_import_id::text
      where run_id = v_prior_event.run_id and source_id = 'deal-os-export'
        and source_record_id = p_source_record_id and current_canonical_id is null;
  end if;
  if v_opportunity.discovery_state = 'pending' and v_opportunity.first_accepted_at is null then
    if v_prior_event.id is null or v_proven_earlier then
      update public.deal_hunter_opportunities set
      first_accepted_at = case when v_proven_earlier then v_prior_event.accepted_at else v_event.accepted_at end,
      first_discovery_evidence_id = case when v_proven_earlier then v_prior_event.id else v_event.id end,
      discovery_state = case when not v_proven_earlier and v_state.accepted_generation = p_expected_generation
        and v_state.accepted_run_id = p_import_id::text then 'known_prospective'
        else 'known_recovered' end, discovery_revision = discovery_revision + 1
      where opportunity_id = p_opportunity_id;
    end if;
  elsif v_opportunity.discovery_state in ('known_prospective', 'known_recovered')
    and v_opportunity.first_accepted_at is not null
    and v_event.accepted_at < v_opportunity.first_accepted_at then
    update public.deal_hunter_opportunities set
      first_accepted_at = v_event.accepted_at, first_discovery_evidence_id = v_event.id,
      discovery_state = 'known_recovered', discovery_revision = discovery_revision + 1
      where opportunity_id = p_opportunity_id;
  end if;
  if v_state.accepted_generation <> p_expected_generation
    or v_state.accepted_run_id <> p_import_id::text then
    update public.deal_hunter_deal_os_imports set freshness_projection_state = 'superseded'
      where id = p_import_id;
    return pg_catalog.jsonb_build_object('bound', true, 'projectionState', 'superseded');
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_snapshot -> 'observations') as observation(value)
    where observation.value ->> 'opportunity_id' is distinct from p_opportunity_id
      or observation.value ->> 'source_id' is distinct from 'deal-os-export'
      or observation.value ->> 'source_record_id' is distinct from p_source_record_id
      or observation.value ->> 'source_name' is distinct from p_snapshot ->> 'source_name'
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_snapshot -> 'observations') as observation(value)
      group by observation.value ->> 'field' having count(*) > 1
  ) then
    raise exception 'Deal OS accepted binding observations do not share one source record' using errcode = '22023';
  end if;
  foreach v_field in array array['annualProfit', 'annualRevenue', 'askingPrice'] loop
    if pg_catalog.jsonb_typeof(p_snapshot -> 'freshness_evidence' -> v_field) is distinct from 'object' then
      continue;
    end if;
    v_field_key := case v_field when 'annualProfit' then 'annual_profit'
      when 'annualRevenue' then 'annual_revenue' else 'asking_price' end;
    select * into v_after from public.deal_hunter_freshness_evidence
      where run_id = p_import_id::text and source_id = 'deal-os-export'
        and source_record_id = p_source_record_id and event_type = 'accepted_source_record'
        and field_key = v_field_key and event_ordinal = v_event.event_ordinal;
    if v_after.id is null then
      raise exception 'Deal OS financial projection lacks its accepted field evidence' using errcode = '22023';
    end if;
    select * into v_prior_observation from public.deal_hunter_opportunity_source_observations
      where opportunity_id = p_opportunity_id and source_id = 'deal-os-export'
        and source_record_id = p_source_record_id and field = v_field_key limit 1;
    if v_prior_observation.id is null then continue; end if;
    select previous_field.* into v_before
      from public.deal_hunter_freshness_evidence as previous_core
      join public.deal_hunter_freshness_evidence as previous_field
        on previous_field.run_id = previous_core.run_id
        and previous_field.source_id = previous_core.source_id
        and previous_field.source_record_id = previous_core.source_record_id
        and previous_field.event_type = 'accepted_source_record'
        and previous_field.field_key = v_field_key
        and previous_field.event_ordinal = previous_core.event_ordinal
      where previous_core.id = v_prior_observation.accepted_evidence_id;
    if v_before.after_value is not distinct from v_after.after_value
      or v_prior_observation.value = v_after.after_value::text then continue; end if;
    select exists (select 1 from public.deal_hunter_opportunity_source_observations
      where opportunity_id = p_opportunity_id and source_id <> 'deal-os-export'
        and field = v_field_key and value is distinct from v_after.after_value::text)
      into v_competing;
    v_comparable := v_before.id is not null and not v_competing
      and v_before.after_value is not null and v_after.after_value is not null
      and v_after.metric <> 'unknown' and v_after.currency <> 'unknown'
      and v_after.period <> 'unknown' and v_before.metric = v_after.metric
      and v_before.currency = v_after.currency and v_before.period = v_after.period
      and v_before.current_canonical_id = p_opportunity_id;
    if v_comparable then
      update public.deal_hunter_opportunities set material_revision = material_revision + 1,
        last_material_change_at = v_event.accepted_at where opportunity_id = p_opportunity_id
        returning material_revision into v_revision;
    else
      v_revision := null;
    end if;
    v_transition_type := case when v_comparable then 'material_change' else 'evidence_state_change' end;
    insert into public.deal_hunter_freshness_evidence
      (id, source_id, source_name, source_record_id, run_id, generation,
        event_type, field_key, event_ordinal, accepted_at, original_canonical_id,
        current_canonical_id, before_value, after_value, before_evidence_id,
        after_evidence_id, metric, currency, period, classification, material_revision)
    values ('fl01:' || pg_catalog.md5(pg_catalog.concat_ws('|', p_import_id::text,
        p_source_record_id, v_transition_type, v_field_key, v_event.event_ordinal::text)),
      'deal-os-export', v_after.source_name, p_source_record_id, p_import_id::text,
      p_expected_generation, v_transition_type, v_field_key, v_event.event_ordinal,
      v_event.accepted_at, p_opportunity_id, p_opportunity_id,
      v_before.after_value, v_after.after_value, v_before.id, v_after.id,
      v_after.metric, v_after.currency, v_after.period,
      case when v_comparable then 'comparable_change' when v_competing then 'conflict'
        else 'new_evidence' end, v_revision);
  end loop;
  v_publication := p_snapshot -> 'freshness_evidence' -> 'dateAdded';
  for v_observation in select value from pg_catalog.jsonb_array_elements(p_snapshot -> 'observations') as observations(value) loop
    insert into public.deal_hunter_opportunity_source_observations (
      id, opportunity_id, source_id, source_name, source_record_id,
      field, value, observed_at, created_at, updated_at,
      accepted_at, accepted_run_id, accepted_evidence_id,
      publication_raw_header, publication_raw_value, publication_precision,
      publication_offset, publication_meaning
    ) values (
      v_observation ->> 'id', p_opportunity_id, 'deal-os-export', p_snapshot ->> 'source_name',
      p_source_record_id, v_observation ->> 'field', v_observation ->> 'value',
      (v_observation ->> 'observed_at')::timestamptz,
      (v_observation ->> 'created_at')::timestamptz,
      (v_observation ->> 'updated_at')::timestamptz,
      v_event.accepted_at, p_import_id::text, v_event.id,
      case when v_observation ->> 'field' = 'date_added' then v_publication ->> 'rawHeader' else null end,
      case when v_observation ->> 'field' = 'date_added' then v_publication ->> 'rawValue' else null end,
      case when v_observation ->> 'field' = 'date_added' then
        case when v_publication ->> 'precision' = 'datetime' then 'instant'
          else v_publication ->> 'precision' end else null end,
      case when v_observation ->> 'field' = 'date_added' then v_publication ->> 'offset' else null end,
      case when v_observation ->> 'field' = 'date_added' then v_publication ->> 'meaning' else null end
    ) on conflict (opportunity_id, source_id, source_record_id, field) do update set
      source_name = excluded.source_name, value = excluded.value,
      observed_at = excluded.observed_at, updated_at = excluded.updated_at,
      accepted_at = excluded.accepted_at, accepted_run_id = excluded.accepted_run_id,
      accepted_evidence_id = excluded.accepted_evidence_id,
      publication_raw_header = excluded.publication_raw_header,
      publication_raw_value = excluded.publication_raw_value,
      publication_precision = excluded.publication_precision,
      publication_offset = excluded.publication_offset,
      publication_meaning = excluded.publication_meaning;
  end loop;
  delete from public.deal_hunter_opportunity_source_observations as observation
    where observation.opportunity_id = p_opportunity_id
      and observation.source_id = 'deal-os-export'
      and observation.source_record_id = p_source_record_id
      and not exists (select 1 from pg_catalog.jsonb_array_elements(p_snapshot -> 'observations') as proposed(value)
        where proposed.value ->> 'field' = observation.field);
  select count(*) into v_unbound from public.deal_hunter_freshness_evidence
    where run_id = p_import_id::text and source_id = 'deal-os-export'
      and event_type = 'accepted_source_record' and field_key = ''
      and current_canonical_id is null;
  v_projection_state := case when v_unbound = 0 then 'accepted' else 'pending' end;
  update public.deal_hunter_deal_os_imports set freshness_projection_state = v_projection_state
    where id = p_import_id;
  update public.deal_hunter_source_freshness_state set projection_state = v_projection_state
    where source_id = 'deal-os-export';
  return pg_catalog.jsonb_build_object('bound', true, 'projectionState', v_projection_state);
end;
$$;
revoke all on function public.bind_accepted_deal_hunter_freshness_v1(uuid, text, text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.bind_accepted_deal_hunter_freshness_v1(uuid, text, text, bigint, jsonb)
  to service_role;

create or replace function public.set_deal_hunter_operator_decision_freshness_v1(
  p_opportunity_id text, p_decision jsonb,
  p_expected_discovery_revision bigint, p_expected_material_revision bigint
) returns public.deal_hunter_opportunity_scores
language plpgsql security definer set search_path = '' as $$
declare
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
begin
  if p_expected_discovery_revision is null or p_expected_material_revision is null
    or p_expected_discovery_revision < 0 or p_expected_material_revision < 0 then
    raise exception 'freshness review requires two nonnegative revisions' using errcode = '22023';
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id for update;
  if v_opportunity.opportunity_id is null then return null; end if;
  if v_opportunity.discovery_revision <> p_expected_discovery_revision
    or v_opportunity.material_revision <> p_expected_material_revision then
    raise exception 'FL01_STALE_REVIEW' using errcode = 'P0001';
  end if;
  v_score := public.set_deal_hunter_opportunity_operator_decision(p_opportunity_id, p_decision);
  if v_score.opportunity_id is null then return null; end if;
  if p_decision ? 'reviewed_at' then
    update public.deal_hunter_opportunity_scores set
      reviewed_discovery_revision = p_expected_discovery_revision,
      reviewed_material_revision = p_expected_material_revision
      where opportunity_id = p_opportunity_id returning * into v_score;
  end if;
  return v_score;
end;
$$;
revoke all on function public.set_deal_hunter_operator_decision_freshness_v1(text, jsonb, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.set_deal_hunter_operator_decision_freshness_v1(text, jsonb, bigint, bigint)
  to service_role;

create or replace function public.pass_deal_hunter_opportunity_freshness_v1(
  p_command jsonb, p_expected_discovery_revision bigint, p_expected_material_revision bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_result jsonb;
  v_score public.deal_hunter_opportunity_scores%rowtype;
begin
  if p_expected_discovery_revision is null or p_expected_material_revision is null
    or p_expected_discovery_revision < 0 or p_expected_material_revision < 0 then
    raise exception 'freshness review requires two nonnegative revisions' using errcode = '22023';
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_command ->> 'opportunity_id' for update;
  if v_opportunity.opportunity_id is not null and (
    v_opportunity.discovery_revision <> p_expected_discovery_revision
    or v_opportunity.material_revision <> p_expected_material_revision) then
    raise exception 'FL01_STALE_REVIEW' using errcode = 'P0001';
  end if;
  v_result := public.pass_deal_hunter_opportunity(p_command);
  if v_result ->> 'applied' = 'true' then
    update public.deal_hunter_opportunity_scores set
      reviewed_discovery_revision = p_expected_discovery_revision,
      reviewed_material_revision = p_expected_material_revision
      where opportunity_id = p_command ->> 'opportunity_id' returning * into v_score;
    v_result := pg_catalog.jsonb_set(v_result, '{score}', to_jsonb(v_score), true);
  end if;
  return v_result;
end;
$$;
revoke all on function public.pass_deal_hunter_opportunity_freshness_v1(jsonb, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.pass_deal_hunter_opportunity_freshness_v1(jsonb, bigint, bigint)
  to service_role;

-- Reader-only fixed-size revision state. The input is a compact tuple, never
-- the full score or retained evidence payload.
create or replace function public.deal_hunter_fresh_inbox_hash_step_v1(
  p_state text, p_tuple text
) returns text language sql immutable set search_path = public as $$
  select md5(coalesce(p_state, '') || octet_length(coalesce(p_tuple, ''))::text
    || ':' || coalesce(p_tuple, ''));
$$;
drop aggregate if exists public.deal_hunter_fresh_inbox_hash_v1(text);
create aggregate public.deal_hunter_fresh_inbox_hash_v1(text) (
  sfunc = public.deal_hunter_fresh_inbox_hash_step_v1,
  stype = text,
  initcond = ''
);
revoke all on function public.deal_hunter_fresh_inbox_hash_step_v1(text, text) from public, anon, authenticated;
revoke all on function public.deal_hunter_fresh_inbox_hash_step_v1(text, text) from public;
grant execute on function public.deal_hunter_fresh_inbox_hash_step_v1(text, text) to service_role;
revoke all on function public.deal_hunter_fresh_inbox_hash_v1(text) from public, anon, authenticated;
grant execute on function public.deal_hunter_fresh_inbox_hash_v1(text) to service_role;

drop function if exists public.list_deal_hunter_fresh_inbox_v1(
  text, integer, integer, text, text, text, text, timestamptz);
create or replace function public.list_deal_hunter_fresh_inbox_v1(
  p_area text default 'inbox', p_offset integer default 0, p_limit integer default 25,
  p_search text default '', p_confidence text default '', p_priority text default '',
  p_state text default '', p_as_of timestamptz default now(),
  p_sort text default 'acquisition-priority'
) returns jsonb language sql stable security definer set search_path = public as $$
  with parameters as (
    select (p_as_of at time zone 'America/Los_Angeles')::date as business_date,
      greatest(0, least(coalesce(p_offset, 0), 100000)) as page_offset,
      greatest(1, least(coalesce(p_limit, 25), 100)) as page_limit
  ), due_actions as materialized (
    select request.opportunity_id, min(request.next_follow_up_at) as due_at
    from public.deal_hunter_cim_requests as request
    join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = request.opportunity_id
        and opportunity.primary_submission_id = request.submission_id
        and opportunity.status = 'active'
    join public.contact_submissions as submission on submission.id = request.submission_id
    where request.follow_up_state = 'scheduled'
      and request.request_state = 'provider_accepted'
      and request.delivery_state = 'accepted'
      and request.responded_at is null and request.follow_up_count < 5
      and request.next_follow_up_at <= p_as_of and submission.status not in ('archived', 'spam')
      and request.metadata #>> '{manualFollowUp,mode}' = 'operator-approved'
      and request.metadata #>> '{manualFollowUp,version}' = 'deal-hunter-manual-follow-up-v1'
      and request.metadata #>> '{manualFollowUp,maximumFollowUps}' = '5'
      and request.metadata #>> '{manualFollowUp,cadencePolicy}' =
        'accepted-local-date-plus-2-weekend-forward-0900-pt-v1'
      and request.metadata #>> '{manualFollowUp,stoppedAt}' is null
    group by request.opportunity_id
  ), action_evidence as materialized (
    select opportunity.opportunity_id,
      case when latest.direction = 'inbound' and latest.source = 'resend-webhook'
        and latest.kind = 'broker-reply' and latest.delivery_state = 'replied'
        then latest.occurred_at else null end as reply_at,
      case when coalesce(submission.metadata #>> '{diligence,stage}', '')
          not in ('financial-review','lender-review','loi-candidate')
        and coalesce(submission.metadata #>> '{acquisitionCommand,pipelineStage}', '')
          not in ('diligence','loi-candidate')
        then greatest(document.action_at, upload.action_at) else null end as materials_at
    from public.deal_hunter_opportunities as opportunity
    join public.contact_submissions as submission on submission.id = opportunity.primary_submission_id
    left join lateral (select direction, source, kind, delivery_state, occurred_at
      from public.crm_communications as communication
      where communication.submission_id = submission.id
      order by occurred_at desc, id desc limit 1) as latest on true
    left join lateral (select max(created_at) as action_at
      from public.secure_documents as document
      where document.submission_id = submission.id
        and document.document_type in ('cim','teaser','prospectus','offering_memorandum',
          'offering_materials','data_room','broker_materials','financials','financial_package',
          'financial_statements','p_and_l','tax_returns','balance_sheet')) as document on true
    left join lateral (select max(coalesce(last_uploaded_at, updated_at)) as action_at
      from public.secure_upload_requests as request
      where request.submission_id = submission.id
        and request.status in ('completed','documents-received')
        and exists (select 1 from pg_catalog.jsonb_array_elements(request.requested_documents) as requested(value)
          where case when pg_catalog.jsonb_typeof(requested.value) = 'string'
            then trim(both '"' from requested.value::text)
            else coalesce(requested.value ->> 'category', requested.value ->> 'id') end
            in ('cim','teaser','prospectus','offering_memorandum','offering_materials',
              'data_room','broker_materials','financials','financial_package',
              'financial_statements','p_and_l','tax_returns','balance_sheet'))
    ) as upload on true
    where opportunity.status = 'active' and submission.status not in ('archived','spam')
      and submission.follow_up_state <> 'completed'
  ), base as materialized (
    select scores.opportunity_id, scores.fit_score, scores.confidence,
      scores.contradiction_count, scores.score_fingerprint, scores.semantic_digest,
      (select max(source.updated_at)
        from public.deal_hunter_opportunity_source_observations as source
        where source.opportunity_id = scores.opportunity_id) as source_snapshot_updated_at,
      scores.operator_priority, scores.reviewed_at,
      scores.reviewed_discovery_revision, scores.reviewed_material_revision,
      opportunity.first_accepted_at, opportunity.discovery_state,
      opportunity.discovery_revision, opportunity.material_revision,
      opportunity.last_material_change_at,
      coalesce(action.reply_at, action.materials_at, due.due_at) as due_at,
      case when action.reply_at is not null then 'broker_reply'
        when action.materials_at is not null then 'materials_ready'
        when due.due_at is not null then 'due_follow_up' else null end as action_reason,
      publication_latest.publication_date,
      publication_latest.publication_instant, publication_latest.publication_state,
      publication_latest.source_name as publication_source,
      publication_latest.publication_precision,
      publication_stats.publication_distinct_count,
      publication_stats.publication_unsupported_count,
      case when p_area = 'research' then (select count(*) from (select source.field
        from public.deal_hunter_opportunity_source_observations as source
        where source.opportunity_id = scores.opportunity_id
          and source.field in ('annual_profit', 'annual_revenue', 'asking_price')
        group by source.field having count(distinct source.value) > 1) as conflict_fields)
        else 0 end
        as source_conflict_count,
      null::text as material_field
    from public.deal_hunter_opportunity_scores as scores
    join public.deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = scores.opportunity_id and opportunity.status = 'active'
    left join public.deal_hunter_dispositions as disposition
      on disposition.deal_key = scores.deal_key and disposition.disposition = 'dismissed'
    left join due_actions as due on due.opportunity_id = scores.opportunity_id
    left join action_evidence as action on action.opportunity_id = scores.opportunity_id
    left join lateral (
      select evidence.publication_date, evidence.publication_instant,
        evidence.publication_state, evidence.source_name, evidence.publication_precision
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = scores.opportunity_id
        and opportunity.first_accepted_at is not null
        and opportunity.discovery_revision > scores.reviewed_discovery_revision
        and observation.field = 'date_added'
        and evidence.current_canonical_id = scores.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
      order by evidence.accepted_at desc, evidence.id limit 1
    ) as publication_latest on true
    left join lateral (
      select count(distinct coalesce(evidence.publication_date::text,
          evidence.publication_instant::text)) filter
          (where evidence.publication_state = 'valid') as publication_distinct_count,
        count(*) filter (where evidence.publication_state <> 'valid')
          as publication_unsupported_count
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = scores.opportunity_id
        and opportunity.first_accepted_at is not null
        and opportunity.discovery_revision > scores.reviewed_discovery_revision
        and observation.field = 'date_added'
        and evidence.current_canonical_id = scores.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
    ) as publication_stats on true
    where scores.current_triage_eligible = true and scores.should_remove = false
      and disposition.deal_key is null
      and (coalesce(p_search, '') = '' or lower(coalesce(scores.name, '')) like
        '%' || lower(p_search) || '%' or lower(coalesce(scores.deal_key, '')) like
        '%' || lower(p_search) || '%')
      and (coalesce(p_confidence, '') = '' or scores.confidence = p_confidence)
      and (coalesce(p_priority, '') = '' or scores.operator_priority = p_priority)
      and (coalesce(p_state, '') = '' or upper(coalesce(scores.state, '')) = upper(p_state))
  ), classified as materialized (
    select base.*,
      (base.discovery_state = 'known_prospective'
        or (base.discovery_state = 'known_recovered' and base.reviewed_at is null))
        and base.first_accepted_at is not null
        and base.discovery_revision > base.reviewed_discovery_revision
        and parameters.business_date - (base.first_accepted_at at time zone 'America/Los_Angeles')::date
          between 0 and 7 as new_to_ug,
      base.publication_state = 'valid' and base.publication_distinct_count = 1
        and base.publication_unsupported_count = 0
        and parameters.business_date - coalesce(base.publication_date,
          (base.publication_instant at time zone 'America/Los_Angeles')::date)
          between 0 and 30 as recently_listed,
      base.material_revision > base.reviewed_material_revision
        and base.last_material_change_at is not null as updated_since_review,
      base.due_at is not null as due_action,
      base.operator_priority in ('urgent', 'high') as owner_priority
    from base cross join parameters
  ), eligible as materialized (
    select classified.*,
      case when new_to_ug and fit_score >= 75 and confidence <> 'low'
        and discovery_revision > reviewed_discovery_revision then
          case when recently_listed then 1 else 2 end else 6 end as discovery_group
    from classified
  ), ordered as materialized (
    select eligible.*,
      row_number() over (order by due_at asc nulls last, opportunity_id) as due_ordinal,
      row_number() over (order by case operator_priority when 'urgent' then 0
        when 'high' then 1 else 2 end, fit_score desc, opportunity_id) as priority_ordinal
    from eligible
  ), preview_candidates as (
    select ordered.*,
      min(priority_ordinal) filter (where owner_priority
        and (not due_action or due_ordinal > 2)) over () as first_remaining_priority
    from ordered
  ), memberships as (
    select 'due-actions'::text as area_id, ordered.*, null::bigint as first_remaining_priority
      from ordered where p_area = 'due-actions' and due_action
    union all select 'owner-priorities', ordered.*, null::bigint from ordered
      where p_area = 'owner-priorities' and owner_priority
    union all select 'new-important', ordered.*, null::bigint from ordered
      where p_area in ('inbox', 'new-important') and discovery_group <= 2
    union all select 'updated', ordered.*, null::bigint from ordered
      where p_area = 'updated' and updated_since_review
    union all select 'research', ordered.*, null::bigint from ordered
      where p_area = 'research'
        and (confidence = 'low' or contradiction_count > 0 or source_conflict_count > 0)
    union all select 'all-active', ordered.*, null::bigint from ordered
      where p_area = 'all-active'
    union all select 'action-preview', preview_candidates.* from preview_candidates
      where p_area in ('inbox', 'action-preview') and (due_action or owner_priority)
  ), numbered as (
    select memberships.*,
      row_number() over (partition by area_id order by
        case when area_id = 'all-active' and p_sort = 'highest-fit' then fit_score end desc,
        case when area_id = 'new-important' then discovery_group end,
        case when area_id = 'new-important' and p_area <> 'inbox'
          and p_sort = 'newest-discovery' then first_accepted_at end desc nulls last,
        case when area_id = 'new-important' and p_area <> 'inbox'
          and p_sort = 'highest-fit' then fit_score end desc,
        case when area_id = 'action-preview' then
          case when due_action and due_ordinal <= 2 then 0
            when owner_priority and priority_ordinal = first_remaining_priority then 1
            when due_action then 2 else 3 end end,
        case when area_id in ('action-preview', 'due-actions') then due_at end asc nulls last,
        case when area_id = 'due-actions' then opportunity_id end,
        case when area_id = 'action-preview' and due_action and due_ordinal <= 2
          then due_ordinal end,
        case when area_id = 'action-preview' and owner_priority
          and priority_ordinal = first_remaining_priority then priority_ordinal end,
        case when area_id in ('action-preview', 'owner-priorities', 'new-important') then
          case operator_priority when 'urgent' then 0 when 'high' then 1 else 2 end end,
        case when area_id = 'new-important' then due_at end asc nulls last,
        case when area_id = 'new-important' then fit_score end desc,
        case when area_id = 'new-important' then
          case confidence when 'high' then 0 when 'medium' then 1 else 2 end end,
        case when area_id in ('new-important', 'research', 'all-active')
          then first_accepted_at end desc nulls last,
        case when area_id = 'updated' then last_material_change_at end desc nulls last,
        fit_score desc, opportunity_id
      ) as ordinal
    from memberships
  ), selected as materialized (
    select * from numbered where (p_area = 'inbox' and area_id in
      ('action-preview', 'new-important')) or area_id = p_area
  ), totals as (
    select area_id, count(*)::integer as total,
      public.deal_hunter_fresh_inbox_hash_v1(
        opportunity_id || ':' || discovery_group || ':' || fit_score || ':' || confidence
        || ':' || operator_priority || ':' || coalesce(due_at::text, '')
        || ':' || coalesce(action_reason, '')
        || ':' || coalesce(first_accepted_at::text, '') || ':' || discovery_revision
        || ':' || material_revision || ':' || reviewed_discovery_revision
        || ':' || reviewed_material_revision || ':' || score_fingerprint
        || ':' || coalesce(semantic_digest, '') || ':' || coalesce(publication_state, '')
        || ':' || coalesce(publication_date::text, '')
        || ':' || source_conflict_count || ':' || coalesce(material_field, '')
        || ':' || coalesce(source_snapshot_updated_at::text, '')
        order by ordinal) as revision
    from selected where area_id <> 'action-preview' or ordinal <= 3
    group by area_id
  ), pages as (
    select area_id, jsonb_agg((to_jsonb(display_score) - 'operator_note')
      || (to_jsonb(numbered) - 'ordinal' - 'area_id'
        - 'due_ordinal' - 'priority_ordinal' - 'first_remaining_priority')
      || jsonb_build_object(
        'primary_submission_id', display_opp.primary_submission_id,
        'publication_date', display_publication.publication_date,
        'publication_instant', display_publication.publication_instant,
        'publication_state', display_publication.publication_state,
        'publication_source', display_publication.source_name,
        'publication_precision', display_publication.publication_precision,
        'publication_distinct_count', display_publication_stats.distinct_count,
        'publication_unsupported_count', display_publication_stats.unsupported_count,
        'recently_listed', display_publication.publication_state = 'valid'
          and display_publication_stats.distinct_count = 1
          and display_publication_stats.unsupported_count = 0
          and parameters.business_date - coalesce(display_publication.publication_date,
            (display_publication.publication_instant at time zone 'America/Los_Angeles')::date)
            between 0 and 30,
        'top_strength', display_score.summary->'strengths'->>0,
        'top_concern', display_score.summary->'concerns'->>0,
        'crm_status', coalesce((select submission.status
          from public.contact_submissions as submission
          where submission.id = display_opp.primary_submission_id), 'not-started'),
        'cim_status', coalesce((select cim.status
          from public.deal_hunter_cim_requests as cim
          where cim.opportunity_id = numbered.opportunity_id
          order by cim.updated_at desc, cim.id desc limit 1), 'not-requested'),
        'industry', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'industry'
          order by source.observed_at desc, source.id limit 1),
        'location', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'location'
          order by source.observed_at desc, source.id limit 1),
        'annual_profit', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'annual_profit'
          order by source.observed_at desc, source.id limit 1),
        'annual_profit_evidence', (select pg_catalog.jsonb_build_object(
            'metric', evidence.metric, 'period', evidence.period, 'currency', evidence.currency)
          from public.deal_hunter_opportunity_source_observations as source
          join public.deal_hunter_freshness_evidence as core on core.id = source.accepted_evidence_id
          join public.deal_hunter_freshness_evidence as evidence on evidence.run_id = core.run_id
            and evidence.source_id = core.source_id and evidence.source_record_id = core.source_record_id
            and evidence.event_type = 'accepted_source_record' and evidence.field_key = 'annual_profit'
            and evidence.current_canonical_id = numbered.opportunity_id
          where source.id = (select chosen.id from public.deal_hunter_opportunity_source_observations as chosen
            where chosen.opportunity_id = numbered.opportunity_id and chosen.field = 'annual_profit'
            order by chosen.observed_at desc, chosen.id limit 1)
            and source.value = evidence.after_value::text
          limit 1),
        'annual_revenue', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'annual_revenue'
          order by source.observed_at desc, source.id limit 1),
        'asking_price', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'asking_price'
          order by source.observed_at desc, source.id limit 1),
        'profit_multiple', (select source.value from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id and source.field = 'profit_multiple'
          order by source.observed_at desc, source.id limit 1),
        'observation_freshness', coalesce((select max(source.observed_at)
          from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id), display_score.scored_at),
        'latest_accepted_observation_at', (select max(source.accepted_at)
          from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id),
        'material_field', (select event.field_key from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'material_before_value', (select event.before_value from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'material_after_value', (select event.after_value from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'material_currency', (select event.currency from public.deal_hunter_freshness_evidence as event
          where event.current_canonical_id = numbered.opportunity_id
            and event.event_type = 'material_change'
            and event.material_revision = numbered.material_revision
          order by event.accepted_at desc, event.id limit 1),
        'source_conflict_count', (select count(*) from (select source.field
          from public.deal_hunter_opportunity_source_observations as source
          where source.opportunity_id = numbered.opportunity_id
            and source.field in ('annual_profit', 'annual_revenue', 'asking_price')
          group by source.field having count(distinct source.value) > 1) as conflict_fields)
      )
      order by ordinal) as rows,
      max(ordinal)::integer as last_ordinal,
      (array_agg(numbered.opportunity_id order by ordinal desc))[1] as last_id
    from numbered
    join public.deal_hunter_opportunity_scores as display_score
      on display_score.opportunity_id = numbered.opportunity_id
    join public.deal_hunter_opportunities as display_opp
      on display_opp.opportunity_id = numbered.opportunity_id
    left join lateral (
      select evidence.publication_date, evidence.publication_instant,
        evidence.publication_state, evidence.source_name, evidence.publication_precision
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = numbered.opportunity_id
        and observation.field = 'date_added'
        and evidence.current_canonical_id = numbered.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
      order by evidence.accepted_at desc, evidence.id limit 1
    ) as display_publication on true
    left join lateral (
      select count(distinct coalesce(evidence.publication_date::text,
          evidence.publication_instant::text)) filter
          (where evidence.publication_state = 'valid') as distinct_count,
        count(*) filter (where evidence.publication_state <> 'valid') as unsupported_count
      from public.deal_hunter_opportunity_source_observations as observation
      join public.deal_hunter_freshness_evidence as core
        on core.id = observation.accepted_evidence_id
      join public.deal_hunter_freshness_evidence as evidence
        on evidence.run_id = core.run_id and evidence.source_id = core.source_id
        and evidence.source_record_id = core.source_record_id
        and evidence.event_type = 'publication_evidence'
        and evidence.field_key = 'date_added'
      where observation.opportunity_id = numbered.opportunity_id
        and observation.field = 'date_added'
        and evidence.current_canonical_id = numbered.opportunity_id
        and evidence.publication_meaning = 'listing_publication'
    ) as display_publication_stats on true
    cross join parameters
    where ((p_area = 'inbox' and area_id in ('action-preview', 'new-important'))
      or area_id = p_area)
      and ordinal > case when p_area = 'inbox' then 0 else parameters.page_offset end
      and ordinal <= case when area_id = 'action-preview' then 3
        when p_area = 'inbox' then 10
        else parameters.page_offset + parameters.page_limit end
    group by area_id
  ), requested as (
    select id from (values ('action-preview'), ('new-important'), ('due-actions'),
      ('owner-priorities'), ('updated'), ('research'), ('all-active')) as ids(id)
    where (p_area = 'inbox' and id in ('action-preview', 'new-important')) or id = p_area
  )
  select jsonb_build_object('asOf', p_as_of, 'businessDate', parameters.business_date,
    'areas', coalesce((select jsonb_agg(jsonb_build_object(
      'id', requested.id, 'rows', coalesce(pages.rows, '[]'::jsonb),
      'total', coalesce(totals.total, 0),
      'revision', coalesce(totals.revision, md5('')),
      'anchorId', (select anchor.opportunity_id from selected as anchor
        where anchor.area_id = requested.id and anchor.ordinal = parameters.page_offset),
      'nextOffset', case when pages.last_ordinal < totals.total then pages.last_ordinal else null end,
      'lastId', case when pages.last_ordinal < totals.total then pages.last_id else null end,
      'counts', case when requested.id = 'action-preview' then jsonb_build_object(
        'due', (select count(*) from ordered where due_action),
        'overdue', (select count(*) from ordered where due_action and action_reason = 'due_follow_up'
          and (due_at at time zone 'America/Los_Angeles')::date < parameters.business_date),
        'ownerPriority', (select count(*) from ordered where owner_priority),
        'urgent', (select count(*) from ordered where operator_priority = 'urgent'))
        else '{}'::jsonb end
    ) order by case requested.id when 'action-preview' then 0 else 1 end)
      from requested left join totals on totals.area_id = requested.id
      left join pages on pages.area_id = requested.id), '[]'::jsonb),
    'counts', jsonb_build_object(
      'due', (select count(*) from ordered where due_action),
      'ownerPriority', (select count(*) from ordered where owner_priority),
      'newImportant', (select count(*) from ordered where discovery_group <= 2)))
  from parameters;
$$;
revoke all on function public.list_deal_hunter_fresh_inbox_v1(
  text, integer, integer, text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.list_deal_hunter_fresh_inbox_v1(
  text, integer, integer, text, text, text, text, timestamptz, text) to service_role;

-- Keep legacy per-record daily writers from retaining acceptance on changed values.
create or replace function public.upsert_deal_hunter_opportunity_source_observation(
  p_id text, p_opportunity_id text, p_source_id text, p_source_name text, p_source_record_id text,
  p_field text, p_value text, p_observed_at timestamptz, p_created_at timestamptz, p_updated_at timestamptz
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
    source_name = excluded.source_name, value = excluded.value, observed_at = excluded.observed_at,
    updated_at = excluded.updated_at,
    accepted_at = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_at end,
    accepted_run_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_run_id end,
    accepted_evidence_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_evidence_id end,
    publication_raw_header = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_header end,
    publication_raw_value = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_value end,
    publication_precision = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_precision end,
    publication_offset = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_offset end,
    publication_meaning = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_meaning end
  returning * into v_observation;
  return v_observation;
end;
$$;

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
    updated_at = excluded.updated_at,
    accepted_at = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_at end,
    accepted_run_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_run_id end,
    accepted_evidence_id = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.accepted_evidence_id end,
    publication_raw_header = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_header end,
    publication_raw_value = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_raw_value end,
    publication_precision = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_precision end,
    publication_offset = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_offset end,
    publication_meaning = case when excluded.value is distinct from deal_hunter_opportunity_source_observations.value
      then null else deal_hunter_opportunity_source_observations.publication_meaning end;

  return query
  select *
  from public.deal_hunter_opportunity_source_observations
  where opportunity_id = p_opportunity_id
    and source_id = p_source_id
    and source_record_id = p_source_record_id
  order by observed_at desc, id asc;
end;
$$;

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

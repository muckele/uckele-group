alter table public.deal_hunter_cim_reviews add column if not exists opportunity_id text;
alter table public.deal_hunter_cim_reviews add column if not exists snapshot_digest text;
alter table public.deal_hunter_cim_reviews add column if not exists evidence_version text;
alter table public.deal_hunter_cim_reviews add column if not exists rule_version text;
alter table public.deal_hunter_cim_reviews add column if not exists source_policy_version text;
alter table public.deal_hunter_cim_reviews add column if not exists source_policy_hash text;
alter table public.deal_hunter_cim_reviews add column if not exists source_ids jsonb not null default '[]'::jsonb;
alter table public.deal_hunter_cim_reviews add column if not exists actor_role text;
alter table public.deal_hunter_cim_reviews add column if not exists decision_at timestamptz;

create index if not exists idx_deal_hunter_cim_reviews_opportunity
  on public.deal_hunter_cim_reviews (opportunity_id, decision_at desc, created_at desc);
create index if not exists idx_deal_hunter_cim_reviews_policy
  on public.deal_hunter_cim_reviews (rule_version, source_policy_hash, created_at desc);

create table if not exists public.deal_hunter_cim_stage2_activations (
  id uuid primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  status text not null check (status in ('current', 'superseded', 'withdrawn')),
  mode text not null check (mode in ('off', 'shadow', 'canary', 'active')),
  actor text not null,
  reason text not null,
  confirmation_phrase text not null,
  policy_hash text not null,
  rule_version text not null,
  source_policy_version text not null,
  source_policy_hash text not null,
  evidence_checksum text not null,
  evidence_generated_at timestamptz not null,
  backup_reference text not null,
  backup_checksum text not null,
  identity_audit_reference text not null,
  identity_audit_checksum text not null,
  compliance_reference text not null,
  sender_auth_reference text not null,
  timezone text not null,
  window_start text not null,
  window_end text not null,
  weekdays_only boolean not null default true,
  canary_daily_cap integer not null check (canary_daily_cap = 1),
  active_daily_cap integer not null check (active_daily_cap between 1 and 10),
  recipient_cap_24_hours integer not null check (recipient_cap_24_hours = 1),
  recipient_cap_30_days integer not null check (recipient_cap_30_days = 4),
  expires_at timestamptz not null,
  superseded_at timestamptz,
  superseded_by text,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists idx_cim_stage2_one_current_activation
  on public.deal_hunter_cim_stage2_activations (status) where status = 'current';
create index if not exists idx_cim_stage2_activations_created
  on public.deal_hunter_cim_stage2_activations (created_at desc);

create table if not exists public.deal_hunter_cim_stage2_runs (
  id uuid primary key,
  run_key text not null unique,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  pacific_business_date text not null,
  mode text not null check (mode in ('shadow', 'canary', 'active')),
  status text not null check (status in ('running', 'completed', 'blocked', 'failed')),
  triggered_by text not null,
  policy_hash text not null,
  rule_version text not null,
  source_policy_hash text not null,
  activation_id uuid,
  considered_count integer not null default 0,
  eligible_count integer not null default 0,
  would_send_count integer not null default 0,
  attempted_count integer not null default 0,
  accepted_count integer not null default 0,
  failed_count integer not null default 0,
  ambiguous_count integer not null default 0,
  deferred_count integer not null default 0,
  blocked_counts jsonb not null default '{}'::jsonb,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_cim_stage2_runs_date_mode
  on public.deal_hunter_cim_stage2_runs (pacific_business_date desc, mode, status);
create index if not exists idx_cim_stage2_runs_policy
  on public.deal_hunter_cim_stage2_runs (policy_hash, created_at desc);

create table if not exists public.deal_hunter_cim_stage2_decisions (
  id uuid primary key,
  run_id uuid not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  opportunity_id text not null,
  deal_key text not null,
  decision_state text not null check (decision_state in ('blocked', 'eligible', 'deferred', 'claimed', 'attempting', 'accepted', 'failed', 'ambiguous')),
  policy_hash text not null,
  rule_version text not null,
  source_policy_hash text not null,
  activation_id uuid,
  snapshot_digest text not null,
  recipient_hash text not null,
  source_snapshot_digest text not null,
  reasons jsonb not null default '[]'::jsonb,
  claim_token text,
  claimed_at timestamptz,
  consumed_at timestamptz,
  cim_request_id text,
  communication_id text,
  provider_state text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  unique (run_id, opportunity_id, policy_hash)
);

create index if not exists idx_cim_stage2_decisions_run
  on public.deal_hunter_cim_stage2_decisions (run_id, decision_state);
create index if not exists idx_cim_stage2_decisions_opportunity
  on public.deal_hunter_cim_stage2_decisions (opportunity_id, created_at desc);
create index if not exists idx_cim_stage2_decisions_evidence
  on public.deal_hunter_cim_stage2_decisions (policy_hash, source_policy_hash, decision_state);
create unique index if not exists idx_cim_stage2_active_opportunity_claim
  on public.deal_hunter_cim_stage2_decisions (opportunity_id)
  where decision_state in ('claimed', 'attempting', 'ambiguous');

create or replace function public.create_cim_stage2_activation(p_activation jsonb)
returns public.deal_hunter_cim_stage2_activations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created_at timestamptz := (p_activation ->> 'created_at')::timestamptz;
  v_actor text := p_activation ->> 'actor';
  v_row public.deal_hunter_cim_stage2_activations%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('deal-hunter-cim-stage2-activation', 0));
  update public.deal_hunter_cim_stage2_activations
  set status = 'superseded', updated_at = v_created_at,
      superseded_at = v_created_at, superseded_by = v_actor
  where status = 'current';

  insert into public.deal_hunter_cim_stage2_activations
  select * from jsonb_populate_record(null::public.deal_hunter_cim_stage2_activations, p_activation || '{"status":"current"}'::jsonb)
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.claim_cim_stage2_decision(
  p_id uuid,
  p_claim_token text,
  p_claimed_at timestamptz,
  p_activation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opportunity_id text;
  v_row public.deal_hunter_cim_stage2_decisions%rowtype;
begin
  select opportunity_id into v_opportunity_id
  from public.deal_hunter_cim_stage2_decisions where id = p_id;
  if v_opportunity_id is null then return jsonb_build_object('claimed', false, 'decision', null); end if;
  perform pg_advisory_xact_lock(hashtextextended('deal-hunter-cim-stage2-decision:' || v_opportunity_id, 0));
  update public.deal_hunter_cim_stage2_decisions
  set decision_state = 'claimed', claim_token = p_claim_token, claimed_at = p_claimed_at,
      updated_at = p_claimed_at, activation_id = p_activation_id
  where id = p_id and decision_state = 'eligible' and claim_token is null
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.deal_hunter_cim_stage2_decisions where id = p_id;
    return jsonb_build_object('claimed', false, 'decision', to_jsonb(v_row));
  end if;
  return jsonb_build_object('claimed', true, 'decision', to_jsonb(v_row));
end;
$$;

alter table public.deal_hunter_cim_stage2_activations enable row level security;
alter table public.deal_hunter_cim_stage2_runs enable row level security;
alter table public.deal_hunter_cim_stage2_decisions enable row level security;

revoke all privileges on table public.deal_hunter_cim_stage2_activations from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_stage2_runs from public, anon, authenticated;
revoke all privileges on table public.deal_hunter_cim_stage2_decisions from public, anon, authenticated;
revoke all on function public.create_cim_stage2_activation(jsonb) from public, anon, authenticated;
revoke all on function public.claim_cim_stage2_decision(uuid, text, timestamptz, uuid) from public, anon, authenticated;

grant all privileges on table public.deal_hunter_cim_stage2_activations to service_role;
grant all privileges on table public.deal_hunter_cim_stage2_runs to service_role;
grant all privileges on table public.deal_hunter_cim_stage2_decisions to service_role;
grant execute on function public.create_cim_stage2_activation(jsonb) to service_role;
grant execute on function public.claim_cim_stage2_decision(uuid, text, timestamptz, uuid) to service_role;

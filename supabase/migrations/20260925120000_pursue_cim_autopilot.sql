-- Package 1A: additive, inert Pursue -> CIM Autopilot authorities.
-- This migration creates no activation, enrollment, campaign, touch, transmission,
-- CRM, or provider row and does not alter legacy CIM lifecycle data.

create table if not exists public.deal_hunter_owner_decision_events (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  idempotency_key text not null unique
    check (idempotency_key = btrim(idempotency_key) and char_length(idempotency_key) between 1 and 240),
  request_digest text not null check (char_length(request_digest) = 64),
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  action text not null check (action in ('pursue', 'watch', 'pass')),
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  expected_discovery_revision bigint not null check (expected_discovery_revision >= 0),
  expected_material_revision bigint not null check (expected_material_revision >= 0),
  observed_discovery_revision bigint not null check (observed_discovery_revision >= 0),
  observed_material_revision bigint not null check (observed_material_revision >= 0),
  selected_contact_reference_digest text
    check (selected_contact_reference_digest is null or char_length(selected_contact_reference_digest) = 64),
  policy_version text not null
    check (policy_version = btrim(policy_version) and char_length(policy_version) between 1 and 120),
  created_at timestamptz not null
);

create table if not exists public.deal_hunter_pursuit_enrollments (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  decision_event_id text not null unique
    references public.deal_hunter_owner_decision_events(id) on delete restrict,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  state text not null check (state in (
    'queued', 'waiting-on-eligibility', 'campaign-created', 'action-required', 'superseded'
  )),
  reason_code text check (reason_code is null or char_length(reason_code) between 1 and 160),
  authority_digest text not null check (char_length(authority_digest) = 64),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  row_version bigint not null default 1 check (row_version >= 1)
);

create unique index if not exists uq_deal_hunter_pursuit_enrollments_current_opportunity
  on public.deal_hunter_pursuit_enrollments(opportunity_id) where state <> 'superseded';

create table if not exists public.deal_hunter_opportunity_timezone_revisions (
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  revision bigint not null check (revision > 0),
  state text not null check (state in ('verified', 'derived', 'missing', 'ambiguous')),
  iana_timezone text check (
    iana_timezone is null or (iana_timezone = btrim(iana_timezone) and char_length(iana_timezone) between 1 and 120)
  ),
  evidence_type text not null
    check (evidence_type = btrim(evidence_type) and char_length(evidence_type) between 1 and 120),
  evidence_id text not null
    check (evidence_id = btrim(evidence_id) and char_length(evidence_id) between 1 and 240),
  evidence_digest text not null check (char_length(evidence_digest) = 64),
  resolver_version text not null
    check (resolver_version = btrim(resolver_version) and char_length(resolver_version) between 1 and 120),
  dataset_digest text not null check (char_length(dataset_digest) = 64),
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  created_at timestamptz not null,
  primary key(opportunity_id, revision),
  check (
    (state in ('verified', 'derived') and iana_timezone is not null)
    or (state in ('missing', 'ambiguous') and iana_timezone is null)
  )
);

create table if not exists public.deal_hunter_broker_conversations (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  recipient_authority_id text not null
    check (recipient_authority_id = btrim(recipient_authority_id)
      and char_length(recipient_authority_id) between 1 and 240),
  recipient_fingerprint text not null check (char_length(recipient_fingerprint) = 64),
  recipient_address text not null
    check (recipient_address = btrim(recipient_address) and char_length(recipient_address) between 3 and 320),
  sender_policy_version text not null
    check (sender_policy_version = btrim(sender_policy_version)
      and char_length(sender_policy_version) between 1 and 120),
  reply_policy_version text not null
    check (reply_policy_version = btrim(reply_policy_version)
      and char_length(reply_policy_version) between 1 and 120),
  reply_alias_token_digest text not null unique check (char_length(reply_alias_token_digest) = 64),
  rfc_thread_key text not null unique
    check (rfc_thread_key = btrim(rfc_thread_key) and char_length(rfc_thread_key) between 1 and 500),
  state text not null check (state in (
    'open', 'reply-review-required', 'responded', 'stopped', 'provider-ambiguous', 'closed'
  )),
  terminal_revision bigint not null default 0 check (terminal_revision >= 0),
  batching_policy_version text not null
    check (batching_policy_version = btrim(batching_policy_version)
      and char_length(batching_policy_version) between 1 and 120),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  row_version bigint not null default 1 check (row_version >= 1)
);

create table if not exists public.deal_hunter_cim_campaigns (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  generation bigint not null check (generation > 0),
  enrollment_id text not null references public.deal_hunter_pursuit_enrollments(id) on delete restrict,
  decision_event_id text not null references public.deal_hunter_owner_decision_events(id) on delete restrict,
  policy_version text not null
    check (policy_version = btrim(policy_version) and char_length(policy_version) between 1 and 120),
  template_version text not null
    check (template_version = btrim(template_version) and char_length(template_version) between 1 and 120),
  template_digest text not null check (char_length(template_digest) = 64),
  permission_version text not null
    check (permission_version = btrim(permission_version) and char_length(permission_version) between 1 and 120),
  permission_digest text not null check (char_length(permission_digest) = 64),
  permission_revision bigint not null check (permission_revision >= 0),
  permission_scope text not null
    check (permission_scope = btrim(permission_scope) and char_length(permission_scope) between 1 and 240),
  canonical_revision bigint not null check (canonical_revision >= 0),
  crm_submission_id uuid references public.contact_submissions(id) on delete restrict,
  crm_ownership_revision bigint not null check (crm_ownership_revision >= 0),
  recipient_authority_id text not null
    check (recipient_authority_id = btrim(recipient_authority_id)
      and char_length(recipient_authority_id) between 1 and 240),
  recipient_fingerprint text not null check (char_length(recipient_fingerprint) = 64),
  freshness_authority_digest text not null check (char_length(freshness_authority_digest) = 64),
  discovery_revision bigint not null check (discovery_revision >= 0),
  material_revision bigint not null check (material_revision >= 0),
  timezone_revision bigint not null check (timezone_revision > 0),
  conversation_id text not null references public.deal_hunter_broker_conversations(id) on delete restrict,
  state text not null check (state in (
    'queued', 'waiting-on-eligibility', 'initial-pending', 'active-follow-up',
    'action-required', 'responded', 'materials-received', 'stopped', 'expired',
    'provider-ambiguous'
  )),
  reason_code text check (reason_code is null or char_length(reason_code) between 1 and 160),
  initial_accepted_at timestamptz,
  local_expiry_at timestamptz,
  expiry_derivation jsonb not null default '{}'::jsonb,
  terminal_revision bigint not null default 0 check (terminal_revision >= 0),
  row_version bigint not null default 1 check (row_version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(opportunity_id, generation),
  foreign key(opportunity_id, timezone_revision)
    references public.deal_hunter_opportunity_timezone_revisions(opportunity_id, revision) on delete restrict
);

create unique index if not exists uq_deal_hunter_cim_campaigns_active_opportunity
  on public.deal_hunter_cim_campaigns(opportunity_id)
  where state in (
    'queued', 'waiting-on-eligibility', 'initial-pending', 'active-follow-up',
    'action-required', 'provider-ambiguous'
  );
create index if not exists idx_deal_hunter_cim_campaigns_conversation_state
  on public.deal_hunter_cim_campaigns(conversation_id, state, updated_at desc);

create table if not exists public.deal_hunter_cim_campaign_touches (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  campaign_id text not null references public.deal_hunter_cim_campaigns(id) on delete restrict,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  logical_slot text not null
    check (logical_slot = btrim(logical_slot) and char_length(logical_slot) between 1 and 160),
  kind text not null check (kind in (
    'initial', 'follow-up-1', 'follow-up-2', 'follow-up-3', 'weekday-follow-up'
  )),
  ordinal integer not null check (ordinal >= 0),
  due_at timestamptz not null,
  due_local text not null check (due_local = btrim(due_local) and char_length(due_local) between 1 and 120),
  timezone_revision bigint not null check (timezone_revision > 0),
  state text not null check (state in (
    'scheduled', 'claimed', 'provider-pending', 'accepted', 'definitive-failure',
    'ambiguous', 'cancelled-before-provider'
  )),
  claim_token_digest text check (claim_token_digest is null or char_length(claim_token_digest) = 64),
  claim_owner text check (claim_owner is null or char_length(claim_owner) between 1 and 200),
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  transmission_id text,
  outcome_code text check (outcome_code is null or char_length(outcome_code) between 1 and 160),
  terminal_reason text check (terminal_reason is null or char_length(terminal_reason) between 1 and 160),
  row_version bigint not null default 1 check (row_version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(campaign_id, logical_slot),
  foreign key(opportunity_id, timezone_revision)
    references public.deal_hunter_opportunity_timezone_revisions(opportunity_id, revision) on delete restrict
);

create index if not exists idx_deal_hunter_cim_campaign_touches_due
  on public.deal_hunter_cim_campaign_touches(state, due_at, id);

create table if not exists public.deal_hunter_cim_transmissions (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  conversation_id text not null references public.deal_hunter_broker_conversations(id) on delete restrict,
  member_digest text not null check (char_length(member_digest) = 64),
  preparation_generation bigint not null check (preparation_generation > 0),
  payload_version text not null
    check (payload_version = btrim(payload_version) and char_length(payload_version) between 1 and 120),
  payload_digest text not null check (char_length(payload_digest) = 64),
  from_address text not null check (char_length(from_address) between 3 and 320),
  to_addresses jsonb not null,
  cc_addresses jsonb not null default '[]'::jsonb,
  bcc_addresses jsonb not null default '[]'::jsonb,
  reply_to_address text not null check (char_length(reply_to_address) between 3 and 320),
  subject text not null check (char_length(subject) between 1 and 998),
  provider_idempotency_key text not null unique
    check (provider_idempotency_key = btrim(provider_idempotency_key)
      and char_length(provider_idempotency_key) between 1 and 240),
  communication_id text not null unique references public.crm_communications(id) on delete restrict,
  outbox_id text not null unique references public.crm_email_outbox(id) on delete restrict,
  state text not null check (state in (
    'prepared', 'final-gate-blocked', 'provider-pending', 'accepted',
    'definitive-failure', 'ambiguous', 'cancelled-before-provider'
  )),
  release_state text not null check (release_state in (
    'ordinary', 'awaiting-live-authorization', 'authorized'
  )),
  final_gate_authority_digest text
    check (final_gate_authority_digest is null or char_length(final_gate_authority_digest) = 64),
  campaign_terminal_revision bigint check (campaign_terminal_revision is null or campaign_terminal_revision >= 0),
  conversation_terminal_revision bigint
    check (conversation_terminal_revision is null or conversation_terminal_revision >= 0),
  invocation_authority_count integer not null default 0 check (invocation_authority_count in (0, 1)),
  provider_invocation_authorized_at timestamptz,
  boundary_nonce_digest text check (boundary_nonce_digest is null or char_length(boundary_nonce_digest) = 64),
  provider_seam_entered_at timestamptz,
  provider text check (provider is null or char_length(provider) between 1 and 80),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) between 1 and 240),
  provider_result_code text check (provider_result_code is null or char_length(provider_result_code) between 1 and 160),
  row_version bigint not null default 1 check (row_version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(conversation_id, member_digest, preparation_generation)
);

create unique index if not exists uq_deal_hunter_cim_transmission_provider_message
  on public.deal_hunter_cim_transmissions(provider, provider_message_id)
  where provider is not null and provider_message_id is not null;

alter table public.deal_hunter_cim_campaign_touches
  add constraint deal_hunter_cim_campaign_touches_transmission_fk
  foreign key(transmission_id) references public.deal_hunter_cim_transmissions(id) on delete restrict;

create table if not exists public.deal_hunter_cim_transmission_touches (
  transmission_id text not null references public.deal_hunter_cim_transmissions(id) on delete restrict,
  touch_id text not null references public.deal_hunter_cim_campaign_touches(id) on delete restrict,
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  campaign_id text not null references public.deal_hunter_cim_campaigns(id) on delete restrict,
  display_ordinal integer not null check (display_ordinal > 0),
  cancelled_at timestamptz,
  cancellation_reason text
    check (cancellation_reason is null or char_length(cancellation_reason) between 1 and 160),
  created_at timestamptz not null,
  primary key(transmission_id, touch_id),
  check (
    (cancelled_at is null and cancellation_reason is null)
    or (cancelled_at is not null and cancellation_reason is not null)
  )
);

create unique index if not exists uq_deal_hunter_cim_transmission_touches_active_touch
  on public.deal_hunter_cim_transmission_touches(touch_id) where cancelled_at is null;

create table if not exists public.deal_hunter_cim_terminal_events (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  scope text not null check (scope in ('campaign', 'conversation')),
  scope_id text not null check (scope_id = btrim(scope_id) and char_length(scope_id) between 1 and 240),
  campaign_id text references public.deal_hunter_cim_campaigns(id) on delete restrict,
  conversation_id text references public.deal_hunter_broker_conversations(id) on delete restrict,
  revision bigint not null check (revision > 0),
  reason_code text not null
    check (reason_code = btrim(reason_code) and char_length(reason_code) between 1 and 160),
  evidence_type text not null
    check (evidence_type = btrim(evidence_type) and char_length(evidence_type) between 1 and 120),
  evidence_id text not null
    check (evidence_id = btrim(evidence_id) and char_length(evidence_id) between 1 and 240),
  observed_at timestamptz not null,
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  source text not null check (source = btrim(source) and char_length(source) between 1 and 120),
  metadata_digest text not null check (char_length(metadata_digest) = 64),
  created_at timestamptz not null,
  unique(scope, scope_id, revision),
  check (
    (scope = 'campaign' and campaign_id is not null
      and campaign_id = scope_id and conversation_id is null)
    or (scope = 'conversation' and conversation_id is not null
      and conversation_id = scope_id and campaign_id is null)
  )
);

create index if not exists idx_deal_hunter_cim_terminal_events_scope
  on public.deal_hunter_cim_terminal_events(scope, scope_id, revision desc);

create table if not exists public.deal_hunter_cim_safety_events (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  safety_run_id text not null
    check (safety_run_id = btrim(safety_run_id) and char_length(safety_run_id) between 1 and 240),
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  source_type text not null
    check (source_type = btrim(source_type) and char_length(source_type) between 1 and 120),
  source_run_id text not null
    check (source_run_id = btrim(source_run_id) and char_length(source_run_id) between 1 and 240),
  canonical_revision bigint not null check (canonical_revision >= 0),
  identity_exception_revision bigint not null check (identity_exception_revision >= 0),
  event_type text not null
    check (event_type = btrim(event_type) and char_length(event_type) between 1 and 160),
  evidence_id text not null
    check (evidence_id = btrim(evidence_id) and char_length(evidence_id) between 1 and 240),
  status text not null check (status in ('pending', 'stopped', 'review-required', 'no-op')),
  outcome_evidence_id text
    check (outcome_evidence_id is null or char_length(outcome_evidence_id) between 1 and 240),
  outcome_revision bigint check (outcome_revision is null or outcome_revision >= 0),
  created_at timestamptz not null,
  consumed_at timestamptz,
  updated_at timestamptz not null,
  unique(safety_run_id, opportunity_id, event_type, evidence_id)
);

create index if not exists idx_deal_hunter_cim_safety_events_run_status
  on public.deal_hunter_cim_safety_events(safety_run_id, status, created_at);

create table if not exists public.deal_hunter_cim_capability_activations (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  capability text not null check (capability in (
    'fl04a-safety', 'fl04b-enrollment', 'fl04b-initial', 'fl04c-followup', 'fl04c-batch'
  )),
  mode text not null check (mode in ('off', 'shadow', 'mailbox', 'canary', 'active')),
  status text not null check (status in ('current', 'superseded', 'withdrawn')),
  prerequisite_activation_id text
    references public.deal_hunter_cim_capability_activations(id) on delete restrict,
  prerequisite_evidence_id text
    check (prerequisite_evidence_id is null or char_length(prerequisite_evidence_id) between 1 and 240),
  prerequisite_evidence_hash text
    check (prerequisite_evidence_hash is null or char_length(prerequisite_evidence_hash) = 64),
  policy_hash text not null check (char_length(policy_hash) = 64),
  config_hash text not null check (char_length(config_hash) = 64),
  cohort_digest text check (cohort_digest is null or char_length(cohort_digest) = 64),
  permission_basis_digest text
    check (permission_basis_digest is null or char_length(permission_basis_digest) = 64),
  permission_revision bigint check (permission_revision is null or permission_revision >= 0),
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  reason text not null check (reason = btrim(reason) and char_length(reason) between 1 and 1000),
  confirmation text not null
    check (confirmation = btrim(confirmation) and char_length(confirmation) between 1 and 240),
  expires_at timestamptz,
  daily_cap integer check (daily_cap is null or daily_cap >= 0),
  recipient_cap integer check (recipient_cap is null or recipient_cap >= 0),
  provider_profile text not null
    check (provider_profile = btrim(provider_profile) and char_length(provider_profile) between 1 and 120),
  superseded_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create unique index if not exists uq_deal_hunter_cim_capability_activations_current
  on public.deal_hunter_cim_capability_activations(capability) where status = 'current';

create table if not exists public.deal_hunter_cim_live_provider_authorizations (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  activation_id text not null
    references public.deal_hunter_cim_capability_activations(id) on delete restrict,
  capability text not null check (capability in (
    'fl04a-safety', 'fl04b-enrollment', 'fl04b-initial', 'fl04c-followup', 'fl04c-batch'
  )),
  writer_path text not null
    check (writer_path = btrim(writer_path) and char_length(writer_path) between 1 and 240),
  transmission_id text not null references public.deal_hunter_cim_transmissions(id) on delete restrict,
  payload_digest text not null check (char_length(payload_digest) = 64),
  recipient_authority_digest text not null check (char_length(recipient_authority_digest) = 64),
  provider_profile text not null
    check (provider_profile = btrim(provider_profile) and char_length(provider_profile) between 1 and 120),
  maximum_calls integer not null check (maximum_calls = 1),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  withdrawn_at timestamptz,
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  reason text not null check (reason = btrim(reason) and char_length(reason) between 1 and 1000)
);

create unique index if not exists uq_deal_hunter_cim_live_authorizations_current
  on public.deal_hunter_cim_live_provider_authorizations(transmission_id, writer_path)
  where consumed_at is null and withdrawn_at is null;

create table if not exists public.deal_hunter_cim_audit_events (
  id text primary key check (id = btrim(id) and char_length(id) between 1 and 240),
  event_type text not null
    check (event_type = btrim(event_type) and char_length(event_type) between 1 and 160),
  opportunity_id text references public.deal_hunter_opportunities(opportunity_id) on delete restrict,
  campaign_id text references public.deal_hunter_cim_campaigns(id) on delete restrict,
  conversation_id text references public.deal_hunter_broker_conversations(id) on delete restrict,
  touch_id text references public.deal_hunter_cim_campaign_touches(id) on delete restrict,
  transmission_id text references public.deal_hunter_cim_transmissions(id) on delete restrict,
  activation_id text references public.deal_hunter_cim_capability_activations(id) on delete restrict,
  authorization_id text references public.deal_hunter_cim_live_provider_authorizations(id) on delete restrict,
  prior_state text check (prior_state is null or char_length(prior_state) between 1 and 120),
  next_state text check (next_state is null or char_length(next_state) between 1 and 120),
  reason_code text check (reason_code is null or char_length(reason_code) between 1 and 160),
  authority_digest text check (authority_digest is null or char_length(authority_digest) = 64),
  payload_digest text check (payload_digest is null or char_length(payload_digest) = 64),
  actor text not null check (actor = btrim(actor) and char_length(actor) between 1 and 200),
  source text not null check (source = btrim(source) and char_length(source) between 1 and 120),
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_deal_hunter_cim_audit_events_opportunity_time
  on public.deal_hunter_cim_audit_events(opportunity_id, occurred_at desc, id);

create or replace function public.reject_pursue_cim_immutable_row()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Pursue CIM retained evidence is immutable';
end;
$$;

create or replace function public.guard_pursue_cim_safety_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Pursue CIM safety evidence is retained';
  end if;
  if (to_jsonb(new) - 'status' - 'outcome_evidence_id' - 'outcome_revision' - 'consumed_at' - 'updated_at')
      is distinct from
     (to_jsonb(old) - 'status' - 'outcome_evidence_id' - 'outcome_revision' - 'consumed_at' - 'updated_at') then
    raise exception 'Pursue CIM safety evidence payload is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.guard_pursue_cim_transmission_payload()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Pursue CIM transmission evidence is retained';
  end if;
  if (to_jsonb(new) - 'state' - 'release_state' - 'final_gate_authority_digest'
      - 'campaign_terminal_revision' - 'conversation_terminal_revision'
      - 'invocation_authority_count' - 'provider_invocation_authorized_at'
      - 'boundary_nonce_digest' - 'provider_seam_entered_at' - 'provider'
      - 'provider_message_id' - 'provider_result_code' - 'row_version' - 'updated_at')
      is distinct from
     (to_jsonb(old) - 'state' - 'release_state' - 'final_gate_authority_digest'
      - 'campaign_terminal_revision' - 'conversation_terminal_revision'
      - 'invocation_authority_count' - 'provider_invocation_authorized_at'
      - 'boundary_nonce_digest' - 'provider_seam_entered_at' - 'provider'
      - 'provider_message_id' - 'provider_result_code' - 'row_version' - 'updated_at') then
    raise exception 'Prepared Pursue CIM transmission payload is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.guard_pursue_cim_transmission_membership()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Pursue CIM transmission membership is retained';
  end if;
  if (to_jsonb(new) - 'cancelled_at' - 'cancellation_reason')
      is distinct from (to_jsonb(old) - 'cancelled_at' - 'cancellation_reason') then
    raise exception 'Pursue CIM transmission membership identity is immutable';
  end if;
  return new;
end;
$$;

create trigger guard_deal_hunter_owner_decision_events
  before update or delete on public.deal_hunter_owner_decision_events
  for each row execute function public.reject_pursue_cim_immutable_row();
create trigger guard_deal_hunter_timezone_revisions
  before update or delete on public.deal_hunter_opportunity_timezone_revisions
  for each row execute function public.reject_pursue_cim_immutable_row();
create trigger guard_deal_hunter_cim_terminal_events
  before update or delete on public.deal_hunter_cim_terminal_events
  for each row execute function public.reject_pursue_cim_immutable_row();
create trigger guard_deal_hunter_cim_audit_events
  before update or delete on public.deal_hunter_cim_audit_events
  for each row execute function public.reject_pursue_cim_immutable_row();
create trigger guard_deal_hunter_cim_safety_events
  before update or delete on public.deal_hunter_cim_safety_events
  for each row execute function public.guard_pursue_cim_safety_event();
create trigger guard_deal_hunter_cim_transmissions
  before update or delete on public.deal_hunter_cim_transmissions
  for each row execute function public.guard_pursue_cim_transmission_payload();
create trigger guard_deal_hunter_cim_transmission_touches
  before update or delete on public.deal_hunter_cim_transmission_touches
  for each row execute function public.guard_pursue_cim_transmission_membership();

alter table public.deal_hunter_owner_decision_events enable row level security;
alter table public.deal_hunter_pursuit_enrollments enable row level security;
alter table public.deal_hunter_opportunity_timezone_revisions enable row level security;
alter table public.deal_hunter_broker_conversations enable row level security;
alter table public.deal_hunter_cim_campaigns enable row level security;
alter table public.deal_hunter_cim_campaign_touches enable row level security;
alter table public.deal_hunter_cim_transmissions enable row level security;
alter table public.deal_hunter_cim_transmission_touches enable row level security;
alter table public.deal_hunter_cim_terminal_events enable row level security;
alter table public.deal_hunter_cim_safety_events enable row level security;
alter table public.deal_hunter_cim_capability_activations enable row level security;
alter table public.deal_hunter_cim_live_provider_authorizations enable row level security;
alter table public.deal_hunter_cim_audit_events enable row level security;

revoke all privileges on table
  public.deal_hunter_owner_decision_events,
  public.deal_hunter_pursuit_enrollments,
  public.deal_hunter_opportunity_timezone_revisions,
  public.deal_hunter_broker_conversations,
  public.deal_hunter_cim_campaigns,
  public.deal_hunter_cim_campaign_touches,
  public.deal_hunter_cim_transmissions,
  public.deal_hunter_cim_transmission_touches,
  public.deal_hunter_cim_terminal_events,
  public.deal_hunter_cim_safety_events,
  public.deal_hunter_cim_capability_activations,
  public.deal_hunter_cim_live_provider_authorizations,
  public.deal_hunter_cim_audit_events
from public, anon, authenticated;

revoke all privileges on table
  public.deal_hunter_owner_decision_events,
  public.deal_hunter_pursuit_enrollments,
  public.deal_hunter_opportunity_timezone_revisions,
  public.deal_hunter_broker_conversations,
  public.deal_hunter_cim_campaigns,
  public.deal_hunter_cim_campaign_touches,
  public.deal_hunter_cim_transmissions,
  public.deal_hunter_cim_transmission_touches,
  public.deal_hunter_cim_terminal_events,
  public.deal_hunter_cim_safety_events,
  public.deal_hunter_cim_capability_activations,
  public.deal_hunter_cim_live_provider_authorizations,
  public.deal_hunter_cim_audit_events
from service_role;

grant select, insert, update, delete on table
  public.deal_hunter_owner_decision_events,
  public.deal_hunter_pursuit_enrollments,
  public.deal_hunter_opportunity_timezone_revisions,
  public.deal_hunter_broker_conversations,
  public.deal_hunter_cim_campaigns,
  public.deal_hunter_cim_campaign_touches,
  public.deal_hunter_cim_transmissions,
  public.deal_hunter_cim_transmission_touches,
  public.deal_hunter_cim_terminal_events,
  public.deal_hunter_cim_safety_events,
  public.deal_hunter_cim_capability_activations,
  public.deal_hunter_cim_live_provider_authorizations,
  public.deal_hunter_cim_audit_events
to service_role;

revoke all on function public.reject_pursue_cim_immutable_row() from public, anon, authenticated;
revoke all on function public.guard_pursue_cim_safety_event() from public, anon, authenticated;
revoke all on function public.guard_pursue_cim_transmission_payload() from public, anon, authenticated;
revoke all on function public.guard_pursue_cim_transmission_membership() from public, anon, authenticated;
grant execute on function public.reject_pursue_cim_immutable_row() to service_role;
grant execute on function public.guard_pursue_cim_safety_event() to service_role;
grant execute on function public.guard_pursue_cim_transmission_payload() to service_role;
grant execute on function public.guard_pursue_cim_transmission_membership() to service_role;

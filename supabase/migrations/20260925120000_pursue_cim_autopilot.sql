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

-- Package 1C: versioned Pursue CIM transition RPCs.
-- CIM rows remain inert to the legacy sender: it only claims queued/retryable rows.
-- These states are required by the Package 1B prepared/provider-pending contract.
alter table public.crm_communications
  drop constraint if exists crm_communications_source_check;
alter table public.crm_communications
  add constraint crm_communications_source_check check (source in (
    'deal-hunter', 'resend-webhook', 'manual', 'secure-documents', 'system',
    'pursue-cim-autopilot'
  ));
alter table public.crm_communications
  drop constraint if exists crm_communications_delivery_state_check;
alter table public.crm_communications
  add constraint crm_communications_delivery_state_check check (delivery_state in (
    'not-attempted', 'provider-pending', 'accepted', 'ambiguous', 'delivered', 'delayed',
    'bounced', 'failed', 'complained', 'suppressed', 'development-only', 'replied'
  ));
alter table public.crm_email_outbox
  drop constraint if exists crm_email_outbox_state_check;
alter table public.crm_email_outbox
  add constraint crm_email_outbox_state_check check (state in (
    'queued', 'sending', 'prepared', 'final-gate-blocked', 'provider-pending',
    'accepted', 'ambiguous', 'failed', 'retryable_failed', 'permanent_failed', 'cancelled'
  ));

create or replace function public.pursue_cim_json_stringify_v1(p_value jsonb)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_type text;
  v_item jsonb;
  v_key text;
  v_parts text[] := array[]::text[];
begin
  v_type := pg_catalog.jsonb_typeof(p_value);
  if v_type = 'array' then
    for v_item in select value from pg_catalog.jsonb_array_elements(p_value) loop
      v_parts := pg_catalog.array_append(v_parts, public.pursue_cim_json_stringify_v1(v_item));
    end loop;
    return '[' || pg_catalog.array_to_string(v_parts, ',') || ']';
  elsif v_type = 'object' then
    for v_key in select key from pg_catalog.jsonb_object_keys(p_value) as key order by key loop
      v_parts := pg_catalog.array_append(v_parts,
        pg_catalog.to_jsonb(v_key)::text || ':' ||
        public.pursue_cim_json_stringify_v1(p_value -> v_key));
    end loop;
    return '{' || pg_catalog.array_to_string(v_parts, ',') || '}';
  end if;
  return p_value::text;
end;
$$;

create or replace function public.pursue_cim_digest_v1(variadic p_parts jsonb[])
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_part jsonb;
  v_serialized text;
  v_frames text[] := array[]::text[];
begin
  foreach v_part in array p_parts loop
    v_serialized := case when v_part is null then 'null'
      else public.pursue_cim_json_stringify_v1(v_part) end;
    v_frames := pg_catalog.array_append(v_frames,
      '[' || pg_catalog.octet_length(v_serialized)::text || ',' ||
      pg_catalog.to_jsonb(v_serialized)::text || ']');
  end loop;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    '[' || pg_catalog.array_to_string(v_frames, ',') || ']', 'UTF8')), 'hex');
end;
$$;

create or replace function public.pursue_cim_required_instant_v1(
  p_command jsonb, p_field text)
returns timestamptz
language plpgsql volatile
set search_path = ''
as $$
declare
  v_text text;
  v_instant timestamptz;
begin
  -- All mutating P1C RPCs validate an instant before taking row locks. This
  -- database-wide transaction lock mirrors SQLite's single-writer boundary and
  -- prevents inverse row-lock orders from deadlocking terminal/provider races.
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  if pg_catalog.jsonb_typeof(p_command -> p_field) <> 'string' then
    raise exception 'Invalid Pursue CIM instant: %', p_field;
  end if;
  v_text := p_command ->> p_field;
  if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    raise exception 'Invalid Pursue CIM instant: %', p_field;
  end if;
  begin
    v_instant := v_text::timestamptz;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'Invalid Pursue CIM instant: %', p_field;
  end;
  if not pg_catalog.isfinite(v_instant)
    or pg_catalog.abs(extract(epoch from v_instant)) > 8640000000000
  then
    raise exception 'Invalid Pursue CIM instant: %', p_field;
  end if;
  return v_instant;
end;
$$;

create or replace function public.pursue_cim_assert_types_v1(
  p_value jsonb, p_text text[], p_number text[],
  p_optional_text text[] default array[]::text[],
  p_optional_number text[] default array[]::text[])
returns void
language plpgsql immutable
set search_path = ''
as $$
declare
  v_key text;
begin
  if pg_catalog.jsonb_typeof(p_value) <> 'object' then
    raise exception 'Invalid Pursue CIM command object';
  end if;
  foreach v_key in array p_text loop
    if pg_catalog.jsonb_typeof(p_value -> v_key) <> 'string' then
      raise exception 'Invalid Pursue CIM text: %', v_key;
    end if;
  end loop;
  foreach v_key in array p_number loop
    if pg_catalog.jsonb_typeof(p_value -> v_key) <> 'number' then
      raise exception 'Invalid Pursue CIM number: %', v_key;
    end if;
  end loop;
  foreach v_key in array p_optional_text loop
    if p_value ? v_key
      and pg_catalog.jsonb_typeof(p_value -> v_key) not in ('string','null') then
      raise exception 'Invalid Pursue CIM text: %', v_key;
    end if;
  end loop;
  foreach v_key in array p_optional_number loop
    if p_value ? v_key
      and pg_catalog.jsonb_typeof(p_value -> v_key) not in ('number','null') then
      raise exception 'Invalid Pursue CIM number: %', v_key;
    end if;
  end loop;
end;
$$;

create or replace function public.pursue_cim_transition_enrollment_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := p_command ->> 'enrollmentId';
  v_next text := p_command ->> 'nextState';
  v_reason text := p_command ->> 'reasonCode';
  v_actor text := p_command ->> 'actor';
  v_now timestamptz;
  v_expected bigint;
  v_current public.deal_hunter_pursuit_enrollments%rowtype;
  v_prior_state text;
  v_legal boolean;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['enrollmentId','nextState','actor','now'], array['expectedRowVersion'],
    array['reasonCode','terminalAuthorityId']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_id is null or pg_catalog.length(v_id) < 1 or pg_catalog.length(v_id) > 240
    or pg_catalog.btrim(v_id) <> v_id
    or v_next is null or pg_catalog.length(v_next) < 1 or pg_catalog.length(v_next) > 40
    or pg_catalog.btrim(v_next) <> v_next
    or v_reason is not null and (pg_catalog.length(v_reason) < 1
      or pg_catalog.length(v_reason) > 160 or pg_catalog.btrim(v_reason) <> v_reason)
    or v_actor is null or pg_catalog.length(v_actor) < 1 or pg_catalog.length(v_actor) > 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or p_command ->> 'expectedRowVersion' !~ '^(0|[1-9][0-9]*)$'
    or (p_command ->> 'expectedRowVersion')::numeric > 9007199254740991
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM enrollment command';
  end if;
  v_expected := (p_command ->> 'expectedRowVersion')::bigint;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_current
    from public.deal_hunter_pursuit_enrollments
    where id = v_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'staleRevision', false,
      'conflict', true, 'enrollment', null);
  end if;
  if v_current.row_version <> v_expected then
    return pg_catalog.jsonb_build_object('applied', false, 'staleRevision', true,
      'conflict', false, 'enrollment', pg_catalog.to_jsonb(v_current));
  end if;
  v_legal := case v_current.state
    when 'queued' then v_next = any(array['waiting-on-eligibility','campaign-created','action-required','superseded'])
    when 'waiting-on-eligibility' then v_next = any(array['queued','campaign-created','action-required','superseded'])
    when 'campaign-created' then v_next = 'superseded'
    when 'action-required' then v_next = 'superseded'
    else false end;
  if not v_legal or (v_next = 'superseded' and
    (p_command ->> 'terminalAuthorityId' is null
      or pg_catalog.length(p_command ->> 'terminalAuthorityId') < 1
      or pg_catalog.length(p_command ->> 'terminalAuthorityId') > 240))
  then
    return pg_catalog.jsonb_build_object('applied', false, 'staleRevision', false,
      'conflict', true, 'enrollment', pg_catalog.to_jsonb(v_current));
  end if;
  v_prior_state := v_current.state;
  update public.deal_hunter_pursuit_enrollments
    set state = v_next, reason_code = v_reason, updated_at = v_now,
      row_version = row_version + 1
    where id = v_id and row_version = v_expected and state = v_current.state
    returning * into v_current;
  if not found then
    raise exception 'Concurrent Pursue CIM enrollment update';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, prior_state, next_state, reason_code,
     actor, source, occurred_at, metadata)
  values (
    public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('enrollment-transition'::text),
      pg_catalog.to_jsonb(v_id || ':' || (v_expected + 1)::text)),
    'enrollment-transition', v_current.opportunity_id,
    v_prior_state, v_next, v_reason, v_actor, 'sqlite-transition', v_now, '{}'::jsonb
  );
  return pg_catalog.jsonb_build_object('applied', true, 'staleRevision', false,
    'conflict', false, 'enrollment', pg_catalog.to_jsonb(v_current));
end;
$$;

revoke all on function public.pursue_cim_json_stringify_v1(jsonb)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_digest_v1(variadic jsonb[])
  from public, anon, authenticated;
revoke all on function public.pursue_cim_required_instant_v1(jsonb,text)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_assert_types_v1(jsonb,text[],text[],text[],text[])
  from public, anon, authenticated;
revoke all on function public.pursue_cim_transition_enrollment_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_json_stringify_v1(jsonb) to service_role;
grant execute on function public.pursue_cim_digest_v1(variadic jsonb[]) to service_role;
grant execute on function public.pursue_cim_required_instant_v1(jsonb,text) to service_role;
grant execute on function public.pursue_cim_assert_types_v1(jsonb,text[],text[],text[],text[])
  to service_role;
grant execute on function public.pursue_cim_transition_enrollment_v1(jsonb) to service_role;

create or replace function public.pursue_cim_append_timezone_revision_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_key text := p_command ->> 'idempotencyKey';
  v_state text := p_command ->> 'state';
  v_zone text := p_command ->> 'ianaTimezone';
  v_evidence_type text := p_command ->> 'evidenceType';
  v_evidence_id text := p_command ->> 'evidenceId';
  v_evidence_digest text := p_command ->> 'evidenceDigest';
  v_resolver text := p_command ->> 'resolverVersion';
  v_dataset_digest text := p_command ->> 'datasetDigest';
  v_actor text := p_command ->> 'actor';
  v_now timestamptz;
  v_expected bigint;
  v_current bigint;
  v_audit_id text;
  v_request_digest text;
  v_prior public.deal_hunter_cim_audit_events%rowtype;
  v_revision public.deal_hunter_opportunity_timezone_revisions%rowtype;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['opportunityId','idempotencyKey','state','evidenceType','evidenceId',
      'evidenceDigest','resolverVersion','datasetDigest','actor','now'],
    array['expectedPriorRevision'], array['ianaTimezone']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
    or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
    or v_key is null or pg_catalog.length(v_key) not between 1 and 240
    or pg_catalog.btrim(v_key) <> v_key
    or p_command ->> 'expectedPriorRevision' !~ '^(0|[1-9][0-9]*)$'
    or (p_command ->> 'expectedPriorRevision')::numeric > 9007199254740991
    or v_state not in ('verified','derived','missing','ambiguous')
    or v_evidence_type is null or pg_catalog.length(v_evidence_type) not between 1 and 120
    or pg_catalog.btrim(v_evidence_type) <> v_evidence_type
    or v_evidence_id is null or pg_catalog.length(v_evidence_id) not between 1 and 240
    or pg_catalog.btrim(v_evidence_id) <> v_evidence_id
    or v_evidence_digest !~ '^[0-9a-f]{64}$'
    or v_resolver is null or pg_catalog.length(v_resolver) not between 1 and 120
    or pg_catalog.btrim(v_resolver) <> v_resolver
    or v_dataset_digest !~ '^[0-9a-f]{64}$'
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM timezone revision command';
  end if;
  if v_state in ('verified','derived') then
    if v_zone is null or pg_catalog.length(v_zone) not between 1 and 120
      or not exists (select 1 from pg_catalog.pg_timezone_names where name = v_zone)
    then
      raise exception 'Invalid IANA timezone';
    end if;
  elsif v_zone is not null then
    raise exception 'Missing or ambiguous timezone cannot have an IANA timezone';
  end if;
  v_expected := (p_command ->> 'expectedPriorRevision')::bigint;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_request_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('timezone-request:v1'::text),
    pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_expected),
    pg_catalog.to_jsonb(v_state),
    coalesce(pg_catalog.to_jsonb(v_zone), 'null'::jsonb),
    pg_catalog.to_jsonb(v_evidence_type),
    pg_catalog.to_jsonb(v_evidence_id),
    pg_catalog.to_jsonb(v_evidence_digest),
    pg_catalog.to_jsonb(v_resolver),
    pg_catalog.to_jsonb(v_dataset_digest),
    pg_catalog.to_jsonb(v_key));
  v_audit_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-audit:v1'::text),
    pg_catalog.to_jsonb('timezone-revision'::text),
    pg_catalog.to_jsonb(v_key));
  perform 1 from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  if not found then
    raise exception 'Unknown Pursue CIM opportunity';
  end if;
  select * into v_prior from public.deal_hunter_cim_audit_events
    where id = v_audit_id;
  if found then
    select * into v_revision from public.deal_hunter_opportunity_timezone_revisions
      where opportunity_id = v_opportunity_id and revision = v_expected + 1;
    return pg_catalog.jsonb_build_object('applied', false,
      'replay', v_prior.authority_digest = v_request_digest,
      'staleRevision', v_prior.authority_digest <> v_request_digest,
      'timezoneRevision', case when found then pg_catalog.to_jsonb(v_revision) else null end);
  end if;
  select coalesce(pg_catalog.max(revision), 0) into v_current
    from public.deal_hunter_opportunity_timezone_revisions
    where opportunity_id = v_opportunity_id;
  if v_current <> v_expected then
    select * into v_revision from public.deal_hunter_opportunity_timezone_revisions
      where opportunity_id = v_opportunity_id and revision = v_current;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'staleRevision', true,
      'timezoneRevision', case when found then pg_catalog.to_jsonb(v_revision) else null end);
  end if;
  insert into public.deal_hunter_opportunity_timezone_revisions
    (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
     evidence_digest, resolver_version, dataset_digest, actor, created_at)
  values (v_opportunity_id, v_current + 1, v_state, v_zone, v_evidence_type, v_evidence_id,
    v_evidence_digest, v_resolver, v_dataset_digest, v_actor, v_now)
  returning * into v_revision;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, next_state, authority_digest,
     actor, source, occurred_at, metadata)
  values (v_audit_id, 'timezone-revision', v_opportunity_id, v_state,
    v_request_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'staleRevision', false, 'timezoneRevision', pg_catalog.to_jsonb(v_revision));
end;
$$;

revoke all on function public.pursue_cim_append_timezone_revision_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_timezone_revision_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_record_capability_activation_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := p_command ->> 'id';
  v_capability text := p_command ->> 'capability';
  v_mode text := p_command ->> 'mode';
  v_predecessor text;
  v_prerequisite_id text := p_command ->> 'prerequisiteActivationId';
  v_evidence_id text := p_command ->> 'prerequisiteEvidenceId';
  v_evidence_hash text := p_command ->> 'prerequisiteEvidenceHash';
  v_policy_hash text := p_command ->> 'policyHash';
  v_config_hash text := p_command ->> 'configHash';
  v_cohort_digest text := p_command ->> 'cohortDigest';
  v_permission_digest text := p_command ->> 'permissionBasisDigest';
  v_permission_revision bigint;
  v_actor text := p_command ->> 'actor';
  v_reason text := p_command ->> 'reason';
  v_confirmation text := p_command ->> 'confirmation';
  v_profile text := p_command ->> 'providerProfile';
  v_expires timestamptz;
  v_daily_cap integer;
  v_recipient_cap integer;
  v_now timestamptz;
  v_existing public.deal_hunter_cim_capability_activations%rowtype;
  v_prerequisite public.deal_hunter_cim_capability_activations%rowtype;
  v_current public.deal_hunter_cim_capability_activations%rowtype;
  v_replay boolean;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['id','capability','mode','policyHash','configHash','actor','reason',
      'confirmation','providerProfile','now'], array[]::text[],
    array['prerequisiteActivationId','prerequisiteEvidenceId','prerequisiteEvidenceHash',
      'cohortDigest','permissionBasisDigest','expiresAt'],
    array['permissionRevision','dailyCap','recipientCap']);
  v_predecessor := case v_capability
    when 'fl04a-safety' then null
    when 'fl04b-enrollment' then 'fl04a-safety'
    when 'fl04b-initial' then 'fl04b-enrollment'
    when 'fl04c-followup' then 'fl04b-initial'
    when 'fl04c-batch' then 'fl04c-followup'
    else 'invalid' end;
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_id is null or pg_catalog.length(v_id) not between 1 and 240
    or pg_catalog.btrim(v_id) <> v_id
    or v_predecessor = 'invalid'
    or v_mode not in ('off','shadow','mailbox','canary','active')
    or v_policy_hash !~ '^[0-9a-f]{64}$'
    or v_config_hash !~ '^[0-9a-f]{64}$'
    or (v_cohort_digest is not null and v_cohort_digest !~ '^[0-9a-f]{64}$')
    or (v_permission_digest is not null and v_permission_digest !~ '^[0-9a-f]{64}$')
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or v_reason is null or pg_catalog.length(v_reason) not between 1 and 1000
    or pg_catalog.btrim(v_reason) <> v_reason
    or v_confirmation is null or pg_catalog.length(v_confirmation) not between 1 and 240
    or pg_catalog.btrim(v_confirmation) <> v_confirmation
    or v_profile is null or pg_catalog.length(v_profile) not between 1 and 120
    or pg_catalog.btrim(v_profile) <> v_profile
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM capability activation command';
  end if;
  if v_predecessor is null then
    if v_prerequisite_id is not null or v_evidence_id is not null
      or v_evidence_hash is not null then
      raise exception 'Root activation cannot name a prerequisite';
    end if;
  elsif v_prerequisite_id is null or pg_catalog.length(v_prerequisite_id) not between 1 and 240
    or v_evidence_id is null or pg_catalog.length(v_evidence_id) not between 1 and 240
    or v_evidence_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Invalid Pursue CIM activation prerequisite';
  end if;
  if p_command ->> 'permissionRevision' is not null then
    if p_command ->> 'permissionRevision' !~ '^(0|[1-9][0-9]*)$'
      or (p_command ->> 'permissionRevision')::numeric > 9007199254740991 then
      raise exception 'Invalid permission revision';
    end if;
    v_permission_revision := (p_command ->> 'permissionRevision')::bigint;
  end if;
  if p_command ->> 'dailyCap' is not null then
    if p_command ->> 'dailyCap' !~ '^(0|[1-9][0-9]*)$'
      or (p_command ->> 'dailyCap')::numeric > 2147483647 then
      raise exception 'Invalid daily cap';
    end if;
    v_daily_cap := (p_command ->> 'dailyCap')::integer;
  end if;
  if p_command ->> 'recipientCap' is not null then
    if p_command ->> 'recipientCap' !~ '^(0|[1-9][0-9]*)$'
      or (p_command ->> 'recipientCap')::numeric > 2147483647 then
      raise exception 'Invalid recipient cap';
    end if;
    v_recipient_cap := (p_command ->> 'recipientCap')::integer;
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  if p_command ->> 'expiresAt' is not null then
    v_expires := public.pursue_cim_required_instant_v1(p_command, 'expiresAt');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:activation:' || v_capability, 0));
  select * into v_existing from public.deal_hunter_cim_capability_activations
    where id = v_id for update;
  if found then
    v_replay := v_existing.capability = v_capability
      and v_existing.mode = v_mode
      and v_existing.prerequisite_activation_id is not distinct from v_prerequisite_id
      and v_existing.prerequisite_evidence_id is not distinct from v_evidence_id
      and v_existing.prerequisite_evidence_hash is not distinct from v_evidence_hash
      and v_existing.policy_hash = v_policy_hash and v_existing.config_hash = v_config_hash
      and v_existing.cohort_digest is not distinct from v_cohort_digest
      and v_existing.permission_basis_digest is not distinct from v_permission_digest
      and v_existing.permission_revision is not distinct from v_permission_revision
      and v_existing.actor = v_actor and v_existing.reason = v_reason
      and v_existing.confirmation = v_confirmation
      and v_existing.expires_at is not distinct from v_expires
      and v_existing.daily_cap is not distinct from v_daily_cap
      and v_existing.recipient_cap is not distinct from v_recipient_cap
      and v_existing.provider_profile = v_profile and v_existing.created_at = v_now;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', v_replay,
      'conflict', not v_replay, 'blockedReason', null,
      'activation', pg_catalog.to_jsonb(v_existing));
  end if;
  if v_predecessor is not null then
    select * into v_prerequisite from public.deal_hunter_cim_capability_activations
      where id = v_prerequisite_id for update;
    if not found or v_prerequisite.capability <> v_predecessor
      or v_prerequisite.status <> 'current' or v_prerequisite.mode = 'off'
      or (v_prerequisite.expires_at is not null and v_prerequisite.expires_at <= v_now)
    then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', false, 'blockedReason', 'prerequisite_missing', 'activation', null);
    end if;
  end if;
  select * into v_current from public.deal_hunter_cim_capability_activations
    where capability = v_capability and status = 'current' for update;
  if found then
    update public.deal_hunter_cim_capability_activations
      set status = 'superseded', superseded_at = v_now, updated_at = v_now
      where id = v_current.id and status = 'current';
  end if;
  insert into public.deal_hunter_cim_capability_activations
    (id, capability, mode, status, prerequisite_activation_id,
     prerequisite_evidence_id, prerequisite_evidence_hash, policy_hash, config_hash,
     cohort_digest, permission_basis_digest, permission_revision, actor, reason,
     confirmation, expires_at, daily_cap, recipient_cap, provider_profile, created_at, updated_at)
  values (v_id, v_capability, v_mode, 'current', v_prerequisite_id,
    v_evidence_id, v_evidence_hash, v_policy_hash, v_config_hash,
    v_cohort_digest, v_permission_digest, v_permission_revision, v_actor, v_reason,
    v_confirmation, v_expires, v_daily_cap, v_recipient_cap, v_profile, v_now, v_now)
  returning * into v_existing;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, activation_id, prior_state, next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('capability-activation'::text),
      pg_catalog.to_jsonb(v_id)),
    'capability-activation', v_id, v_current.status, 'current',
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'blockedReason', null,
    'activation', pg_catalog.to_jsonb(v_existing));
end;
$$;

create or replace function public.pursue_cim_withdraw_capability_activation_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := p_command ->> 'id';
  v_actor text := p_command ->> 'actor';
  v_reason text := p_command ->> 'reason';
  v_now timestamptz;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['id','actor','reason','now'], array[]::text[]);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_id is null or pg_catalog.length(v_id) not between 1 and 240
    or pg_catalog.btrim(v_id) <> v_id
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or v_reason is null or pg_catalog.length(v_reason) not between 1 and 160
    or pg_catalog.btrim(v_reason) <> v_reason
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM activation withdrawal command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where id = v_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'activation', null);
  end if;
  if v_activation.status = 'withdrawn' then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', true,
      'conflict', false, 'activation', pg_catalog.to_jsonb(v_activation));
  end if;
  if v_activation.status <> 'current' then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'activation', pg_catalog.to_jsonb(v_activation));
  end if;
  update public.deal_hunter_cim_capability_activations
    set status = 'withdrawn', withdrawn_at = v_now, updated_at = v_now
    where id = v_id and status = 'current'
    returning * into v_activation;
  if not found then
    raise exception 'Concurrent Pursue CIM activation withdrawal';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, activation_id, prior_state, next_state, reason_code,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('capability-withdrawn'::text),
      pg_catalog.to_jsonb(v_id)),
    'capability-withdrawn', v_id, 'current', 'withdrawn', v_reason,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'activation', pg_catalog.to_jsonb(v_activation));
end;
$$;

revoke all on function public.pursue_cim_record_capability_activation_v1(jsonb)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_withdraw_capability_activation_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_record_capability_activation_v1(jsonb) to service_role;
grant execute on function public.pursue_cim_withdraw_capability_activation_v1(jsonb) to service_role;

create or replace function public.pursue_cim_current_activation_v1(
  p_capability text, p_now timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_predecessor text;
  v_parent_id text;
begin
  v_predecessor := case p_capability
    when 'fl04a-safety' then null
    when 'fl04b-enrollment' then 'fl04a-safety'
    when 'fl04b-initial' then 'fl04b-enrollment'
    when 'fl04c-followup' then 'fl04b-initial'
    when 'fl04c-batch' then 'fl04c-followup'
    else 'invalid' end;
  if v_predecessor = 'invalid' then
    return null;
  end if;
  if v_predecessor is not null then
    v_parent_id := public.pursue_cim_current_activation_v1(v_predecessor, p_now);
  end if;
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where capability = p_capability and status = 'current' for share;
  if not found or v_activation.mode in ('off','shadow')
    or (v_activation.expires_at is not null and v_activation.expires_at <= p_now)
  then
    return null;
  end if;
  if v_predecessor is null then
    return v_activation.id;
  end if;
  if v_parent_id = v_activation.prerequisite_activation_id
    and v_activation.prerequisite_evidence_id is not null
    and v_activation.prerequisite_evidence_hash is not null
  then
    return v_activation.id;
  end if;
  return null;
end;
$$;

create or replace function public.pursue_cim_claim_due_touch_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touch_id text := p_command ->> 'touchId';
  v_claim_digest text := p_command ->> 'claimTokenDigest';
  v_owner text := p_command ->> 'claimOwner';
  v_now timestamptz;
  v_expires timestamptz;
  v_expected bigint;
  v_campaign_terminal bigint;
  v_conversation_terminal bigint;
  v_campaign_id text;
  v_conversation_id text;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_capability text;
  v_prior_state text;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['touchId','claimTokenDigest','claimOwner','claimExpiresAt','now'],
    array['expectedRowVersion','expectedCampaignTerminalRevision',
      'expectedConversationTerminalRevision']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_touch_id is null or pg_catalog.length(v_touch_id) not between 1 and 240
    or pg_catalog.btrim(v_touch_id) <> v_touch_id
    or v_claim_digest !~ '^[0-9a-f]{64}$'
    or v_owner is null or pg_catalog.length(v_owner) not between 1 and 200
    or pg_catalog.btrim(v_owner) <> v_owner
    or p_command ->> 'expectedRowVersion' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'expectedCampaignTerminalRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'expectedConversationTerminalRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'now' is null or p_command ->> 'claimExpiresAt' is null
  then
    raise exception 'Invalid Pursue CIM touch claim command';
  end if;
  v_expected := (p_command ->> 'expectedRowVersion')::bigint;
  v_campaign_terminal := (p_command ->> 'expectedCampaignTerminalRevision')::bigint;
  v_conversation_terminal := (p_command ->> 'expectedConversationTerminalRevision')::bigint;
  if v_expected > 9007199254740991 or v_campaign_terminal > 9007199254740991
    or v_conversation_terminal > 9007199254740991 then
    raise exception 'Unsafe Pursue CIM revision';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_expires := public.pursue_cim_required_instant_v1(p_command, 'claimExpiresAt');
  select campaign_id into v_campaign_id from public.deal_hunter_cim_campaign_touches
    where id = v_touch_id;
  if not found then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true, 'touch', null);
  end if;
  select conversation_id into v_conversation_id from public.deal_hunter_cim_campaigns
    where id = v_campaign_id;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_conversation_id for update;
  select * into v_campaign from public.deal_hunter_cim_campaigns
    where id = v_campaign_id for update;
  select * into v_touch from public.deal_hunter_cim_campaign_touches
    where id = v_touch_id for update;
  if v_campaign.terminal_revision <> v_campaign_terminal
    or v_conversation.terminal_revision <> v_conversation_terminal
    or v_touch.timezone_revision <> v_campaign.timezone_revision
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', true, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_campaign.state not in ('initial-pending','active-follow-up')
    or v_conversation.state <> 'open'
    or (v_campaign.local_expiry_at is not null and v_campaign.local_expiry_at <= v_now)
    or v_touch.state in ('provider-pending','accepted','definitive-failure',
      'ambiguous','cancelled-before-provider')
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', true, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  v_capability := case when v_touch.kind = 'initial' then 'fl04b-initial'
    else 'fl04c-followup' end;
  if public.pursue_cim_current_activation_v1(v_capability, v_now) is null then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', true, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.state = 'claimed' and v_touch.claim_token_digest = v_claim_digest
    and v_touch.claim_owner = v_owner
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', true,
      'staleAuthority', false, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.state = 'claimed'
    and (v_touch.claim_expires_at is null or v_touch.claim_expires_at > v_now)
  then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.row_version <> v_expected then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', true, 'terminal', false, 'conflict', false,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  if v_touch.due_at > v_now or v_expires <= v_now or v_touch.transmission_id is not null then
    return pg_catalog.jsonb_build_object('claimed', false, 'alreadyOwned', false,
      'staleAuthority', false, 'terminal', false, 'conflict', true,
      'touch', pg_catalog.to_jsonb(v_touch));
  end if;
  v_prior_state := v_touch.state;
  update public.deal_hunter_cim_campaign_touches
    set state = 'claimed', claim_token_digest = v_claim_digest, claim_owner = v_owner,
      claimed_at = v_now, claim_expires_at = v_expires, updated_at = v_now,
      row_version = row_version + 1
    where id = v_touch_id and row_version = v_expected and state in ('scheduled','claimed')
    returning * into v_touch;
  if not found then
    raise exception 'Concurrent Pursue CIM touch claim';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
     prior_state, next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('touch-claimed'::text),
      pg_catalog.to_jsonb(v_touch_id || ':' || (v_expected + 1)::text)),
    'touch-claimed', v_touch.opportunity_id, v_campaign.id, v_conversation.id,
    v_touch_id, v_prior_state,
    'claimed', v_owner, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('claimed', true, 'alreadyOwned', false,
    'staleAuthority', false, 'terminal', false, 'conflict', false,
    'touch', pg_catalog.to_jsonb(v_touch));
end;
$$;

revoke all on function public.pursue_cim_current_activation_v1(text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_claim_due_touch_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_current_activation_v1(text, timestamptz)
  to service_role;
grant execute on function public.pursue_cim_claim_due_touch_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_read_projection_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_count bigint;
  v_accepted bigint;
  v_ambiguous bigint;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['opportunityId'], array[]::text[]);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
    or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
  then
    raise exception 'Invalid Pursue CIM projection command';
  end if;
  select * into v_decision from public.deal_hunter_owner_decision_events
    where opportunity_id = v_opportunity_id order by created_at desc, id desc limit 1;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where opportunity_id = v_opportunity_id and state <> 'superseded'
    order by created_at desc, id desc limit 1;
  select * into v_campaign from public.deal_hunter_cim_campaigns
    where opportunity_id = v_opportunity_id order by generation desc limit 1;
  if v_campaign.id is not null then
    select * into v_touch from public.deal_hunter_cim_campaign_touches
      where campaign_id = v_campaign.id and logical_slot = 'initial';
    select tr.* into v_transmission from public.deal_hunter_cim_transmissions as tr
      join public.deal_hunter_cim_transmission_touches as m on m.transmission_id = tr.id
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      where t.campaign_id = v_campaign.id
      order by tr.created_at desc, tr.id desc limit 1;
  end if;
  select pg_catalog.count(*),
    pg_catalog.count(*) filter (where delivery_state = 'accepted'),
    pg_catalog.count(*) filter (where delivery_state = 'ambiguous')
    into v_count, v_accepted, v_ambiguous
    from public.deal_hunter_cim_requests where opportunity_id = v_opportunity_id;
  return pg_catalog.jsonb_build_object(
    'decision', case when v_decision.id is null then null else pg_catalog.to_jsonb(v_decision) end,
    'enrollment', case when v_enrollment.id is null then null else pg_catalog.to_jsonb(v_enrollment) end,
    'campaign', case when v_campaign.id is null then null else pg_catalog.to_jsonb(v_campaign) end,
    'initialTouch', case when v_touch.id is null then null else pg_catalog.to_jsonb(v_touch) end,
    'transmission', case when v_transmission.id is null then null else pg_catalog.to_jsonb(v_transmission) end,
    'legacySummary', pg_catalog.jsonb_build_object(
      'count', v_count, 'accepted', v_accepted, 'ambiguous', v_ambiguous),
    'actions', '[]'::jsonb);
end;
$$;

revoke all on function public.pursue_cim_read_projection_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_read_projection_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_append_safety_events_v1(p_run jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id text := p_run ->> 'safetyRunId';
  v_source_type text := p_run ->> 'sourceType';
  v_source_run_id text := p_run ->> 'sourceRunId';
  v_now timestamptz;
  v_events jsonb := p_run -> 'events';
  v_event jsonb;
  v_opportunity_id text;
  v_event_type text;
  v_evidence_id text;
  v_canonical bigint;
  v_exception bigint;
  v_id text;
  v_prior public.deal_hunter_cim_safety_events%rowtype;
  v_emitted integer := 0;
  v_existing integer := 0;
begin
  perform public.pursue_cim_assert_types_v1(p_run,
    array['safetyRunId','sourceType','sourceRunId','now'], array[]::text[]);
  if p_run is null or pg_catalog.jsonb_typeof(p_run) <> 'object'
    or v_run_id is null or pg_catalog.length(v_run_id) not between 1 and 240
    or pg_catalog.btrim(v_run_id) <> v_run_id
    or v_source_type is null or pg_catalog.length(v_source_type) not between 1 and 120
    or pg_catalog.btrim(v_source_type) <> v_source_type
    or v_source_run_id is null or pg_catalog.length(v_source_run_id) not between 1 and 240
    or pg_catalog.btrim(v_source_run_id) <> v_source_run_id
    or p_run ->> 'now' is null
    or pg_catalog.jsonb_typeof(v_events) <> 'array'
    or pg_catalog.jsonb_array_length(v_events) > 10000
  then
    raise exception 'Invalid Pursue CIM safety event run';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_run, 'now');
  for v_event in select value from pg_catalog.jsonb_array_elements(v_events) loop
    perform public.pursue_cim_assert_types_v1(v_event,
      array['opportunityId','eventType','evidenceId'],
      array['canonicalRevision','identityExceptionRevision']);
    v_opportunity_id := v_event ->> 'opportunityId';
    v_event_type := v_event ->> 'eventType';
    v_evidence_id := v_event ->> 'evidenceId';
    if pg_catalog.jsonb_typeof(v_event) <> 'object'
      or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
      or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
      or v_event_type is null or pg_catalog.length(v_event_type) not between 1 and 160
      or pg_catalog.btrim(v_event_type) <> v_event_type
      or v_evidence_id is null or pg_catalog.length(v_evidence_id) not between 1 and 240
      or pg_catalog.btrim(v_evidence_id) <> v_evidence_id
      or v_event ->> 'canonicalRevision' !~ '^(0|[1-9][0-9]*)$'
      or v_event ->> 'identityExceptionRevision' !~ '^(0|[1-9][0-9]*)$'
    then
      raise exception 'Invalid Pursue CIM safety event';
    end if;
    v_canonical := (v_event ->> 'canonicalRevision')::bigint;
    v_exception := (v_event ->> 'identityExceptionRevision')::bigint;
    if v_canonical > 9007199254740991 or v_exception > 9007199254740991 then
      raise exception 'Unsafe Pursue CIM safety revision';
    end if;
    v_id := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-safety:v1'::text), pg_catalog.to_jsonb(v_run_id),
      pg_catalog.to_jsonb(v_opportunity_id), pg_catalog.to_jsonb(v_event_type),
      pg_catalog.to_jsonb(v_evidence_id));
    perform 1 from public.deal_hunter_opportunities
      where opportunity_id = v_opportunity_id for update;
    select * into v_prior from public.deal_hunter_cim_safety_events
      where id = v_id for update;
    if found then
      if v_prior.source_type <> v_source_type or v_prior.source_run_id <> v_source_run_id
        or v_prior.canonical_revision <> v_canonical
        or v_prior.identity_exception_revision <> v_exception
      then
        return pg_catalog.jsonb_build_object('emitted', 0, 'existing', v_existing,
          'conflict', true);
      end if;
      v_existing := v_existing + 1;
      continue;
    end if;
    insert into public.deal_hunter_cim_safety_events
      (id, safety_run_id, opportunity_id, source_type, source_run_id,
       canonical_revision, identity_exception_revision, event_type, evidence_id,
       status, created_at, updated_at)
    values (v_id, v_run_id, v_opportunity_id, v_source_type, v_source_run_id,
      v_canonical, v_exception, v_event_type, v_evidence_id, 'pending', v_now, v_now);
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, next_state, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('safety-emitted'::text), pg_catalog.to_jsonb(v_id)),
      'safety-emitted', v_opportunity_id, 'pending', v_source_type, v_source_run_id,
      v_now, '{}'::jsonb);
    v_emitted := v_emitted + 1;
  end loop;
  return pg_catalog.jsonb_build_object('emitted', v_emitted,
    'existing', v_existing, 'conflict', false);
end;
$$;

revoke all on function public.pursue_cim_append_safety_events_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_safety_events_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_record_owner_decision_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text := p_command ->> 'opportunityId';
  v_action text := p_command ->> 'action';
  v_key text := p_command ->> 'idempotencyKey';
  v_actor text := p_command ->> 'actor';
  v_policy text := p_command ->> 'policyVersion';
  v_contact_digest text := p_command ->> 'selectedContactReferenceDigest';
  v_reason text := p_command ->> 'reason';
  v_now timestamptz;
  v_discovery bigint;
  v_material bigint;
  v_request_digest text;
  v_decision_id text;
  v_enrollment_id text;
  v_existing public.deal_hunter_owner_decision_events%rowtype;
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_terminal_id text;
  v_disposition_hash text;
  v_disposition_id uuid;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['opportunityId','action','idempotencyKey','actor','policyVersion','now'],
    array['expectedDiscoveryRevision','expectedMaterialRevision'],
    array['selectedContactReferenceDigest','reason']);
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or v_opportunity_id is null or pg_catalog.length(v_opportunity_id) not between 1 and 200
    or pg_catalog.btrim(v_opportunity_id) <> v_opportunity_id
    or v_action not in ('pursue','watch','pass')
    or v_key is null or pg_catalog.length(v_key) not between 1 and 240
    or pg_catalog.btrim(v_key) <> v_key
    or v_actor is null or pg_catalog.length(v_actor) not between 1 and 200
    or pg_catalog.btrim(v_actor) <> v_actor
    or v_policy is null or pg_catalog.length(v_policy) not between 1 and 120
    or pg_catalog.btrim(v_policy) <> v_policy
    or (v_contact_digest is not null and v_contact_digest !~ '^[0-9a-f]{64}$')
    or (v_action = 'pass' and (v_reason is null
      or pg_catalog.length(v_reason) not between 1 and 160
      or pg_catalog.btrim(v_reason) <> v_reason))
    or p_command ->> 'expectedDiscoveryRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'expectedMaterialRevision' !~ '^(0|[1-9][0-9]*)$'
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM owner decision command';
  end if;
  v_discovery := (p_command ->> 'expectedDiscoveryRevision')::bigint;
  v_material := (p_command ->> 'expectedMaterialRevision')::bigint;
  if v_discovery > 9007199254740991 or v_material > 9007199254740991 then
    raise exception 'Unsafe Pursue CIM owner revision';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_request_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision-request:v1'::text),
    pg_catalog.to_jsonb(v_action), pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_discovery), pg_catalog.to_jsonb(v_material),
    coalesce(pg_catalog.to_jsonb(v_contact_digest), 'null'::jsonb),
    pg_catalog.to_jsonb(v_key));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:owner-key:' || v_key, 0));
  select * into v_existing from public.deal_hunter_owner_decision_events
    where idempotency_key = v_key;
  if found then
    select * into v_enrollment from public.deal_hunter_pursuit_enrollments
      where decision_event_id = v_existing.id;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'replay', v_existing.request_digest = v_request_digest,
      'conflict', v_existing.request_digest <> v_request_digest,
      'decision', pg_catalog.to_jsonb(v_existing),
      'enrollment', case when found then pg_catalog.to_jsonb(v_enrollment) else null end);
  end if;
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  if not found or v_opportunity.status <> 'active'
    or v_opportunity.discovery_revision <> v_discovery
    or v_opportunity.material_revision <> v_material
  then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'decision', null, 'enrollment', null);
  end if;
  if v_action <> 'pursue' then
    select * into v_score from public.deal_hunter_opportunity_scores
      where opportunity_id = v_opportunity_id and current_triage_eligible = true
        and should_remove = false for update;
    if not found or (v_action = 'pass' and v_score.deal_key is null) then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'decision', null, 'enrollment', null);
    end if;
  end if;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where opportunity_id = v_opportunity_id and state <> 'superseded' for update;
  if found and v_action = 'pursue' then
    select * into v_decision from public.deal_hunter_owner_decision_events
      where id = v_enrollment.decision_event_id;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
      'enrollment', pg_catalog.to_jsonb(v_enrollment));
  end if;
  v_decision_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision:v1'::text), pg_catalog.to_jsonb(v_key));
  v_enrollment_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('pursuit-enrollment:v1'::text), pg_catalog.to_jsonb(v_decision_id));
  insert into public.deal_hunter_owner_decision_events
    (id, idempotency_key, request_digest, opportunity_id, action, actor,
     expected_discovery_revision, expected_material_revision,
     observed_discovery_revision, observed_material_revision,
     selected_contact_reference_digest, policy_version, created_at)
  values (v_decision_id, v_key, v_request_digest, v_opportunity_id, v_action, v_actor,
    v_discovery, v_material, v_opportunity.discovery_revision,
    v_opportunity.material_revision, v_contact_digest, v_policy, v_now)
  returning * into v_decision;

  if v_action <> 'pursue' then
    if v_enrollment.id is not null then
      update public.deal_hunter_pursuit_enrollments
        set state = 'superseded', reason_code = v_action || '-selected',
          row_version = row_version + 1, updated_at = v_now
        where id = v_enrollment.id and state <> 'superseded';
    end if;
    for v_campaign in
      select * from public.deal_hunter_cim_campaigns
      where opportunity_id = v_opportunity_id
        and state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')
      order by id for update
    loop
      for v_transmission in
        select tr.* from public.deal_hunter_cim_transmissions as tr
        where tr.id in (
          select m.transmission_id from public.deal_hunter_cim_transmission_touches as m
          where m.campaign_id = v_campaign.id and m.cancelled_at is null)
          and tr.state in ('prepared','final-gate-blocked')
        order by tr.id for update
      loop
        perform public.pursue_cim_cancel_prepared_transmission_v1(
          v_transmission.id, v_now, v_action || '-selected', v_actor, false);
      end loop;
      for v_touch in
        select * from public.deal_hunter_cim_campaign_touches
        where campaign_id = v_campaign.id and state in ('scheduled','claimed')
          and transmission_id is null order by id for update
      loop
        update public.deal_hunter_cim_campaign_touches
          set state = 'cancelled-before-provider', terminal_reason = v_action || '-selected',
            row_version = row_version + 1, updated_at = v_now
          where id = v_touch.id and row_version = v_touch.row_version;
        insert into public.deal_hunter_cim_audit_events
          (id, event_type, opportunity_id, campaign_id, touch_id, prior_state,
           next_state, reason_code, actor, source, occurred_at, metadata)
        values (public.pursue_cim_digest_v1(
            pg_catalog.to_jsonb('cim-audit:v1'::text),
            pg_catalog.to_jsonb('touch-cancelled'::text),
            pg_catalog.to_jsonb(v_touch.id || ':' || (v_touch.row_version + 1)::text)),
          'touch-cancelled', v_opportunity_id, v_campaign.id, v_touch.id, v_touch.state,
          'cancelled-before-provider', v_action || '-selected', v_actor,
          'sqlite-transition', v_now, '{}'::jsonb);
      end loop;
      update public.deal_hunter_cim_campaigns
        set state = 'stopped', reason_code = v_action || '-selected',
          terminal_revision = terminal_revision + 1, row_version = row_version + 1,
          updated_at = v_now
        where id = v_campaign.id and row_version = v_campaign.row_version;
      v_terminal_id := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('owner-terminal:v1'::text),
        pg_catalog.to_jsonb(v_decision_id), pg_catalog.to_jsonb(v_campaign.id));
      insert into public.deal_hunter_cim_terminal_events
        (id, scope, scope_id, campaign_id, revision, reason_code,
         evidence_type, evidence_id, observed_at, actor, source, metadata_digest, created_at)
      values (v_terminal_id, 'campaign', v_campaign.id, v_campaign.id,
        v_campaign.terminal_revision + 1, v_action || '-selected',
        'owner-decision', v_decision_id, v_now, v_actor, 'sqlite-transition',
        v_request_digest, v_now);
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
         reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('terminal-transition'::text),
          pg_catalog.to_jsonb(v_terminal_id)),
        'terminal-transition', v_opportunity_id, v_campaign.id, v_campaign.state,
        'stopped', v_action || '-selected', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    end loop;
    update public.deal_hunter_opportunity_scores
      set operator_priority = case when v_action = 'watch' then 'watch' else operator_priority end,
        reviewed_at = v_now, reviewed_by = v_actor,
        reviewed_fingerprint = score_fingerprint,
        reviewed_semantic_digest = semantic_digest,
        reviewed_discovery_revision = v_discovery,
        reviewed_material_revision = v_material, operator_updated_at = v_now
      where opportunity_id = v_opportunity_id;
    if v_action = 'pass' then
      v_disposition_hash := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('owner-pass-disposition:v1'::text),
        pg_catalog.to_jsonb(v_decision_id));
      v_disposition_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
        pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
        pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
        pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
        pg_catalog.substr(v_disposition_hash,21,12))::uuid;
      insert into public.deal_hunter_dispositions
        (id, deal_key, submission_id, listing_url, deal_name, created_at,
         updated_at, disposition, reason, dismissed_at, dismissed_by,
         created_by, updated_by, metadata)
      values (v_disposition_id, v_score.deal_key, v_opportunity.primary_submission_id,
        v_score.listing_url, coalesce(v_score.name, v_opportunity.canonical_name),
        v_now, v_now, 'dismissed', v_reason, v_now, v_actor, v_actor, v_actor, '{}'::jsonb)
      on conflict (deal_key) do update set disposition = 'dismissed',
        reason = excluded.reason, updated_at = excluded.updated_at,
        dismissed_at = excluded.dismissed_at, dismissed_by = excluded.dismissed_by,
        updated_by = excluded.updated_by;
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, next_state, authority_digest,
       actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('owner-decision'::text),
        pg_catalog.to_jsonb(v_decision_id)),
      'owner-decision', v_opportunity_id, v_action, v_request_digest,
      v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
      'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
      'enrollment', null);
  end if;

  insert into public.deal_hunter_pursuit_enrollments
    (id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
     created_at, updated_at)
  values (v_enrollment_id, v_decision_id, v_opportunity_id, 'queued',
    'awaiting-orchestration', public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('enrollment-authority:v1'::text),
      pg_catalog.to_jsonb(v_decision_id),
      pg_catalog.to_jsonb(v_opportunity.discovery_revision),
      pg_catalog.to_jsonb(v_opportunity.material_revision)), v_now, v_now)
  returning * into v_enrollment;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, next_state, authority_digest,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('owner-decision'::text),
      pg_catalog.to_jsonb(v_decision_id)),
    'owner-decision', v_opportunity_id, v_action, v_request_digest,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
    'enrollment', pg_catalog.to_jsonb(v_enrollment));
end;
$$;

revoke all on function public.pursue_cim_record_owner_decision_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_record_owner_decision_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_required_text_v1(
  p_command jsonb, p_key text, p_maximum integer)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_value text := p_command ->> p_key;
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or pg_catalog.jsonb_typeof(p_command -> p_key) <> 'string'
    or v_value is null or pg_catalog.length(v_value) not between 1 and p_maximum
    or pg_catalog.btrim(v_value) <> v_value
  then
    raise exception 'Invalid Pursue CIM text input: %', p_key;
  end if;
  return v_value;
end;
$$;

create or replace function public.pursue_cim_required_revision_v1(
  p_command jsonb, p_key text)
returns bigint
language plpgsql immutable
set search_path = ''
as $$
declare
  v_value text := p_command ->> p_key;
begin
  if pg_catalog.jsonb_typeof(p_command -> p_key) <> 'number'
    or v_value !~ '^(0|[1-9][0-9]*)$'
    or v_value::numeric > 9007199254740991
  then
    raise exception 'Invalid Pursue CIM revision: %', p_key;
  end if;
  return v_value::bigint;
end;
$$;

create or replace function public.pursue_cim_materialize_campaign_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity_id text;
  v_enrollment_id text;
  v_policy text;
  v_template text;
  v_permission text;
  v_permission_scope text;
  v_recipient_authority text;
  v_address text;
  v_sender_policy text;
  v_reply_policy text;
  v_thread_key text;
  v_batching_policy text;
  v_cadence_policy text;
  v_due_local text;
  v_actor text;
  v_template_digest text := p_command ->> 'templateDigest';
  v_permission_digest text := p_command ->> 'permissionDigest';
  v_recipient_fingerprint text := p_command ->> 'recipientFingerprint';
  v_reply_alias_digest text := p_command ->> 'replyAliasTokenDigest';
  v_freshness_digest text := p_command ->> 'freshnessAuthorityDigest';
  v_crm_text text := p_command ->> 'crmSubmissionId';
  v_crm_id uuid;
  v_enrollment_expected bigint;
  v_generation bigint;
  v_permission_revision bigint;
  v_canonical_revision bigint;
  v_crm_revision bigint;
  v_discovery bigint;
  v_material bigint;
  v_timezone_revision bigint;
  v_now timestamptz;
  v_due timestamptz;
  v_campaign_id text;
  v_conversation_id text;
  v_touch_id text;
  v_current public.deal_hunter_cim_campaigns%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_timezone public.deal_hunter_opportunity_timezone_revisions%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_crm public.contact_submissions%rowtype;
  v_same boolean;
begin
  v_opportunity_id := public.pursue_cim_required_text_v1(p_command,'opportunityId',200);
  v_enrollment_id := public.pursue_cim_required_text_v1(p_command,'enrollmentId',240);
  v_policy := public.pursue_cim_required_text_v1(p_command,'policyVersion',120);
  v_template := public.pursue_cim_required_text_v1(p_command,'templateVersion',120);
  v_permission := public.pursue_cim_required_text_v1(p_command,'permissionVersion',120);
  v_permission_scope := public.pursue_cim_required_text_v1(p_command,'permissionScope',240);
  v_recipient_authority := public.pursue_cim_required_text_v1(p_command,'recipientAuthorityId',240);
  v_address := public.pursue_cim_required_text_v1(p_command,'recipientAddress',320);
  v_sender_policy := public.pursue_cim_required_text_v1(p_command,'senderPolicyVersion',120);
  v_reply_policy := public.pursue_cim_required_text_v1(p_command,'replyPolicyVersion',120);
  v_thread_key := public.pursue_cim_required_text_v1(p_command,'rfcThreadKey',500);
  v_batching_policy := public.pursue_cim_required_text_v1(p_command,'batchingPolicyVersion',120);
  v_cadence_policy := public.pursue_cim_required_text_v1(p_command,'cadencePolicyVersion',120);
  v_due_local := public.pursue_cim_required_text_v1(p_command,'dueLocal',120);
  v_actor := public.pursue_cim_required_text_v1(p_command,'actor',200);
  v_enrollment_expected := public.pursue_cim_required_revision_v1(p_command,'expectedEnrollmentRowVersion');
  v_generation := public.pursue_cim_required_revision_v1(p_command,'generation');
  v_permission_revision := public.pursue_cim_required_revision_v1(p_command,'permissionRevision');
  v_canonical_revision := public.pursue_cim_required_revision_v1(p_command,'canonicalRevision');
  v_crm_revision := public.pursue_cim_required_revision_v1(p_command,'crmOwnershipRevision');
  v_discovery := public.pursue_cim_required_revision_v1(p_command,'expectedDiscoveryRevision');
  v_material := public.pursue_cim_required_revision_v1(p_command,'expectedMaterialRevision');
  v_timezone_revision := public.pursue_cim_required_revision_v1(p_command,'timezoneRevision');
  if v_template_digest !~ '^[0-9a-f]{64}$'
    or v_permission_digest !~ '^[0-9a-f]{64}$'
    or v_recipient_fingerprint !~ '^[0-9a-f]{64}$'
    or v_reply_alias_digest !~ '^[0-9a-f]{64}$'
    or v_freshness_digest !~ '^[0-9a-f]{64}$'
    or pg_catalog.jsonb_typeof(p_command -> 'dueAt') <> 'string'
    or pg_catalog.jsonb_typeof(p_command -> 'now') <> 'string'
  then
    raise exception 'Invalid Pursue CIM campaign authority input';
  end if;
  v_due := public.pursue_cim_required_instant_v1(p_command, 'dueAt');
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_campaign_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-campaign:v1'::text), pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_generation), pg_catalog.to_jsonb(v_policy));
  v_conversation_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-conversation:v1'::text),
    pg_catalog.to_jsonb(v_recipient_fingerprint), pg_catalog.to_jsonb(v_sender_policy));
  v_touch_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-touch:v1'::text), pg_catalog.to_jsonb(v_campaign_id),
    pg_catalog.to_jsonb('initial'::text), pg_catalog.to_jsonb(v_cadence_policy));
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = v_opportunity_id for update;
  select * into v_current from public.deal_hunter_cim_campaigns
    where opportunity_id = v_opportunity_id order by generation desc limit 1 for update;
  if found then
    v_same := v_current.id = v_campaign_id and v_current.enrollment_id = v_enrollment_id
      and v_current.template_digest = v_template_digest
      and v_current.permission_digest = v_permission_digest
      and v_current.recipient_fingerprint = v_recipient_fingerprint
      and v_current.timezone_revision = v_timezone_revision;
    select * into v_touch from public.deal_hunter_cim_campaign_touches
      where campaign_id = v_current.id and logical_slot = 'initial';
    return pg_catalog.jsonb_build_object('applied', false, 'existing', v_same,
      'actionRequired', not v_same, 'campaign', pg_catalog.to_jsonb(v_current),
      'initialTouch', case when found then pg_catalog.to_jsonb(v_touch) else null end);
  end if;
  if v_generation <> 1 then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where id = v_enrollment_id for update;
  if v_enrollment.id is not null then
    select * into v_decision from public.deal_hunter_owner_decision_events
      where id = v_enrollment.decision_event_id;
  end if;
  select * into v_timezone from public.deal_hunter_opportunity_timezone_revisions
    where opportunity_id = v_opportunity_id order by revision desc limit 1 for share;
  if v_crm_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_crm_id := v_crm_text::uuid;
    select * into v_crm from public.contact_submissions where id = v_crm_id for share;
  end if;
  if public.pursue_cim_current_activation_v1('fl04b-enrollment',v_now) is null
    or v_enrollment.id is null or v_enrollment.opportunity_id <> v_opportunity_id
    or v_enrollment.state not in ('queued','waiting-on-eligibility')
    or v_enrollment.row_version <> v_enrollment_expected
    or v_decision.id is null or v_decision.action <> 'pursue'
    or v_opportunity.opportunity_id is null or v_opportunity.status <> 'active'
    or v_opportunity.discovery_revision <> v_discovery
    or v_opportunity.material_revision <> v_material
    or v_timezone.revision is null or v_timezone.revision <> v_timezone_revision
    or v_timezone.state not in ('verified','derived')
    or v_crm.id is null or v_crm.deal_hunter_opportunity_id <> v_opportunity_id
    or v_crm.archived_at is not null or v_opportunity.primary_submission_id <> v_crm.id
    or exists (select 1 from public.deal_hunter_cim_requests
      where opportunity_id = v_opportunity_id and
        (delivery_state in ('accepted','ambiguous') or
         request_state in ('provider_pending','provider_accepted')))
  then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_conversation_id for update;
  if found and (v_conversation.recipient_authority_id <> v_recipient_authority
    or v_conversation.recipient_address <> v_address
    or v_conversation.recipient_fingerprint <> v_recipient_fingerprint
    or v_conversation.state <> 'open')
  then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  if v_conversation.id is null then
    insert into public.deal_hunter_broker_conversations
      (id, recipient_authority_id, recipient_fingerprint, recipient_address,
       sender_policy_version, reply_policy_version, reply_alias_token_digest,
       rfc_thread_key, state, batching_policy_version, created_at, updated_at)
    values (v_conversation_id, v_recipient_authority, v_recipient_fingerprint, v_address,
      v_sender_policy, v_reply_policy, v_reply_alias_digest, v_thread_key,
      'open', v_batching_policy, v_now, v_now);
  end if;
  insert into public.deal_hunter_cim_campaigns
    (id, opportunity_id, generation, enrollment_id, decision_event_id, policy_version,
     template_version, template_digest, permission_version, permission_digest,
     permission_revision, permission_scope, canonical_revision, crm_submission_id,
     crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
     freshness_authority_digest, discovery_revision, material_revision,
     timezone_revision, conversation_id, state, reason_code, created_at, updated_at)
  values (v_campaign_id, v_opportunity_id, v_generation, v_enrollment_id, v_decision.id,
    v_policy, v_template, v_template_digest, v_permission, v_permission_digest,
    v_permission_revision, v_permission_scope, v_canonical_revision, v_crm.id,
    v_crm_revision, v_recipient_authority, v_recipient_fingerprint,
    v_freshness_digest, v_discovery, v_material, v_timezone_revision,
    v_conversation_id, 'initial-pending', 'awaiting-window', v_now, v_now)
  returning * into v_campaign;
  insert into public.deal_hunter_cim_campaign_touches
    (id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
     due_at, due_local, timezone_revision, state, created_at, updated_at)
  values (v_touch_id, v_campaign_id, v_opportunity_id, 'initial', 'initial', 0,
    v_due, v_due_local, v_timezone_revision, 'scheduled', v_now, v_now)
  returning * into v_touch;
  update public.deal_hunter_pursuit_enrollments
    set state = 'campaign-created', reason_code = null,
      updated_at = v_now, row_version = row_version + 1
    where id = v_enrollment_id and row_version = v_enrollment_expected;
  if not found then
    raise exception 'Concurrent Pursue CIM enrollment allocation';
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id,
     next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('campaign-allocated'::text),
      pg_catalog.to_jsonb(v_campaign_id)),
    'campaign-allocated', v_opportunity_id, v_campaign_id, v_conversation_id,
    'initial-pending', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
     next_state, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('touch-created'::text), pg_catalog.to_jsonb(v_touch_id)),
    'touch-created', v_opportunity_id, v_campaign_id, v_conversation_id, v_touch_id,
    'scheduled', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, prior_state, next_state,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('enrollment-transition'::text),
      pg_catalog.to_jsonb(v_enrollment_id || ':' || (v_enrollment_expected + 1)::text)),
    'enrollment-transition', v_opportunity_id, v_enrollment.state, 'campaign-created',
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'existing', false,
    'actionRequired', false, 'campaign', pg_catalog.to_jsonb(v_campaign),
    'initialTouch', pg_catalog.to_jsonb(v_touch));
end;
$$;

revoke all on function public.pursue_cim_required_text_v1(jsonb,text,integer)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_required_revision_v1(jsonb,text)
  from public, anon, authenticated;
revoke all on function public.pursue_cim_materialize_campaign_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_required_text_v1(jsonb,text,integer) to service_role;
grant execute on function public.pursue_cim_required_revision_v1(jsonb,text) to service_role;
grant execute on function public.pursue_cim_materialize_campaign_v1(jsonb) to service_role;

create or replace function public.pursue_cim_cancel_prepared_transmission_v1(
  p_transmission_id text, p_now timestamptz, p_reason text, p_actor text,
  p_preserve_claim boolean default false)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
begin
  if p_transmission_id is null or p_now is null
    or p_reason is null or pg_catalog.length(p_reason) not between 1 and 160
    or p_actor is null or pg_catalog.length(p_actor) not between 1 and 200
    or pg_catalog.btrim(p_reason) <> p_reason
    or pg_catalog.btrim(p_actor) <> p_actor
  then
    raise exception 'Invalid prepared transmission cancellation';
  end if;
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = p_transmission_id for update;
  if not found or v_transmission.state not in ('prepared','final-gate-blocked')
    or v_transmission.invocation_authority_count <> 0 then
    return false;
  end if;
  for v_member in
    select m.touch_id, m.campaign_id, m.opportunity_id, t.row_version
      from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      where m.transmission_id = p_transmission_id and m.cancelled_at is null
      order by m.touch_id for update of m, t
  loop
    update public.deal_hunter_cim_transmission_touches
      set cancelled_at = p_now, cancellation_reason = p_reason
      where transmission_id = p_transmission_id and touch_id = v_member.touch_id
        and cancelled_at is null;
    update public.deal_hunter_cim_campaign_touches
      set transmission_id = null,
        state = case when p_preserve_claim then 'claimed' else 'cancelled-before-provider' end,
        terminal_reason = case when p_preserve_claim then null else p_reason end,
        row_version = row_version + 1, updated_at = p_now
      where id = v_member.touch_id and transmission_id = p_transmission_id
        and row_version = v_member.row_version;
    if not found then
      raise exception 'Concurrent Pursue CIM membership cancellation';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, touch_id, transmission_id,
       prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('transmission-membership-cancelled'::text),
        pg_catalog.to_jsonb(p_transmission_id || ':' || v_member.touch_id)),
      'transmission-membership-cancelled', v_member.opportunity_id,
      v_member.campaign_id, v_member.touch_id, p_transmission_id,
      'active', 'cancelled', p_reason, p_actor, 'sqlite-transition', p_now, '{}'::jsonb);
  end loop;
  update public.deal_hunter_cim_transmissions
    set state = 'cancelled-before-provider', row_version = row_version + 1, updated_at = p_now
    where id = p_transmission_id and state in ('prepared','final-gate-blocked')
      and invocation_authority_count = 0;
  if not found then
    raise exception 'Concurrent Pursue CIM transmission cancellation';
  end if;
  update public.crm_email_outbox set state = 'cancelled', updated_at = p_now
    where id = v_transmission.outbox_id and state in ('prepared','final-gate-blocked');
  for v_authorization in
    select * from public.deal_hunter_cim_live_provider_authorizations
      where transmission_id = p_transmission_id
        and consumed_at is null and withdrawn_at is null
      order by id for update
  loop
    update public.deal_hunter_cim_live_provider_authorizations
      set withdrawn_at = p_now where id = v_authorization.id
        and consumed_at is null and withdrawn_at is null;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, transmission_id, authorization_id, prior_state,
       next_state, reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('authorization-withdrawn'::text),
        pg_catalog.to_jsonb(v_authorization.id)),
      'authorization-withdrawn', p_transmission_id, v_authorization.id,
      'issued', 'withdrawn', p_reason, p_actor, 'sqlite-transition', p_now, '{}'::jsonb);
  end loop;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, prior_state, next_state,
     reason_code, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-cancelled'::text),
      pg_catalog.to_jsonb(p_transmission_id)),
    'transmission-cancelled', p_transmission_id, v_transmission.state,
    'cancelled-before-provider', p_reason, p_actor, 'sqlite-transition', p_now, '{}'::jsonb);
  return true;
end;
$$;

create or replace function public.pursue_cim_prepare_transmission_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touch_ids text[];
  v_touch_id text;
  v_touches public.deal_hunter_cim_campaign_touches[] := array[]::public.deal_hunter_cim_campaign_touches[];
  v_campaigns public.deal_hunter_cim_campaigns[] := array[]::public.deal_hunter_cim_campaigns[];
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_crm_owner public.contact_submissions%rowtype;
  v_current public.deal_hunter_cim_transmissions%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_current_members text[];
  v_claim_digest text;
  v_expected_campaign bigint;
  v_expected_conversation bigint;
  v_generation bigint;
  v_payload_version text;
  v_from text;
  v_reply_to text;
  v_subject text;
  v_body_text text;
  v_body_html text;
  v_actor text;
  v_now timestamptz;
  v_to jsonb := p_command -> 'toAddresses';
  v_cc jsonb := p_command -> 'ccAddresses';
  v_bcc jsonb := p_command -> 'bccAddresses';
  v_tags jsonb := p_command -> 'tags';
  v_array jsonb;
  v_item jsonb;
  v_templates text[] := array[]::text[];
  v_campaign_ids text[] := array[]::text[];
  v_payload_digest text;
  v_member_digest text;
  v_transmission_id text;
  v_communication_id text;
  v_outbox_id text;
  v_provider_key text;
  v_metadata jsonb;
  v_capability text;
  v_index integer;
begin
  if p_command is null or pg_catalog.jsonb_typeof(p_command) <> 'object'
    or pg_catalog.jsonb_typeof(p_command -> 'touchIds') <> 'array'
    or pg_catalog.jsonb_array_length(p_command -> 'touchIds') not between 1 and 50
    or pg_catalog.jsonb_typeof(v_to) <> 'array'
    or pg_catalog.jsonb_array_length(v_to) <> 1
    or pg_catalog.jsonb_typeof(v_cc) <> 'array'
    or pg_catalog.jsonb_array_length(v_cc) > 20
    or pg_catalog.jsonb_typeof(v_bcc) <> 'array'
    or pg_catalog.jsonb_array_length(v_bcc) > 20
    or pg_catalog.jsonb_typeof(v_tags) <> 'array'
    or pg_catalog.jsonb_array_length(v_tags) > 30
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM transmission membership or addresses';
  end if;
  select pg_catalog.array_agg(value order by value) into v_touch_ids
    from pg_catalog.jsonb_array_elements_text(p_command -> 'touchIds') as value;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_command -> 'touchIds') as item
      where pg_catalog.jsonb_typeof(item.value) <> 'string') then
    raise exception 'Invalid Pursue CIM transmission member type';
  end if;
  if (select count(distinct value) from pg_catalog.unnest(v_touch_ids) as value)
       <> pg_catalog.array_length(v_touch_ids, 1)
  then
    raise exception 'Duplicate Pursue CIM transmission member';
  end if;
  foreach v_touch_id in array v_touch_ids loop
    if pg_catalog.length(v_touch_id) not between 1 and 240
      or pg_catalog.btrim(v_touch_id) <> v_touch_id then
      raise exception 'Invalid Pursue CIM transmission member';
    end if;
  end loop;
  foreach v_array in array array[v_to,v_cc,v_bcc] loop
    for v_item in select value from pg_catalog.jsonb_array_elements(v_array) loop
      if pg_catalog.jsonb_typeof(v_item) <> 'string'
        or pg_catalog.length(v_item #>> '{}') not between 1 and 320
        or pg_catalog.btrim(v_item #>> '{}') <> v_item #>> '{}' then
        raise exception 'Invalid Pursue CIM transmission address';
      end if;
    end loop;
  end loop;
  for v_item in select value from pg_catalog.jsonb_array_elements(v_tags) loop
    if pg_catalog.jsonb_typeof(v_item) <> 'string'
      or pg_catalog.length(v_item #>> '{}') not between 1 and 120 then
      raise exception 'Invalid Pursue CIM transmission tag';
    end if;
  end loop;
  v_claim_digest := public.pursue_cim_required_text_v1(p_command, 'claimTokenDigest', 64);
  if v_claim_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Pursue CIM transmission claim digest';
  end if;
  v_expected_campaign := public.pursue_cim_required_revision_v1(
    p_command, 'expectedCampaignTerminalRevision');
  v_expected_conversation := public.pursue_cim_required_revision_v1(
    p_command, 'expectedConversationTerminalRevision');
  v_generation := public.pursue_cim_required_revision_v1(p_command, 'preparationGeneration');
  if v_generation < 1 then
    raise exception 'Invalid Pursue CIM preparation generation';
  end if;
  v_payload_version := public.pursue_cim_required_text_v1(p_command, 'payloadVersion', 120);
  v_from := public.pursue_cim_required_text_v1(p_command, 'fromAddress', 320);
  v_reply_to := public.pursue_cim_required_text_v1(p_command, 'replyToAddress', 320);
  v_subject := public.pursue_cim_required_text_v1(p_command, 'subject', 998);
  v_body_text := public.pursue_cim_required_text_v1(p_command, 'bodyText', 100000);
  v_body_html := public.pursue_cim_required_text_v1(p_command, 'bodyHtmlSanitized', 100000);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  for v_index in 1..pg_catalog.array_length(v_touch_ids, 1) loop
    select * into v_touch from public.deal_hunter_cim_campaign_touches
      where id = v_touch_ids[v_index] for update;
    if not found then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true, 'transmission', null);
    end if;
    v_touches := pg_catalog.array_append(v_touches, v_touch);
    select * into v_campaign from public.deal_hunter_cim_campaigns
      where id = v_touch.campaign_id for update;
    v_campaigns := pg_catalog.array_append(v_campaigns, v_campaign);
    v_templates := pg_catalog.array_append(v_templates, v_campaign.template_version);
    v_campaign_ids := pg_catalog.array_append(v_campaign_ids, v_campaign.id);
  end loop;
  select * into v_conversation from public.deal_hunter_broker_conversations
    where id = v_campaigns[1].conversation_id for update;
  v_payload_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-payload:v1'::text), pg_catalog.to_jsonb(v_from),
    v_to, v_cc, v_bcc, pg_catalog.to_jsonb(v_reply_to),
    pg_catalog.to_jsonb(v_subject), pg_catalog.to_jsonb(v_body_text),
    pg_catalog.to_jsonb(v_body_html), v_tags, pg_catalog.to_jsonb(v_touch_ids),
    pg_catalog.to_jsonb(v_templates), pg_catalog.to_jsonb(v_payload_version));
  select tr.* into v_current from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_transmissions as tr on tr.id = m.transmission_id
    where m.touch_id = v_touch_ids[1] and m.cancelled_at is null for update of tr;
  if found then
    select pg_catalog.array_agg(touch_id order by touch_id) into v_current_members
      from public.deal_hunter_cim_transmission_touches
      where transmission_id = v_current.id and cancelled_at is null;
    if v_current_members is distinct from v_touch_ids then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', true, 'terminal', false,
        'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    if v_current.payload_digest = v_payload_digest then
      return pg_catalog.jsonb_build_object('prepared', false,
        'existing', v_generation = v_current.preparation_generation,
        'payloadConflict', v_generation <> v_current.preparation_generation,
        'terminal', false, 'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    if v_generation <> v_current.preparation_generation + 1
      or not public.pursue_cim_cancel_prepared_transmission_v1(
        v_current.id, v_now, 'prepared-payload-changed', v_actor, true)
    then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', true, 'terminal', false,
        'transmission', pg_catalog.to_jsonb(v_current));
    end if;
    for v_index in 1..pg_catalog.array_length(v_touches, 1) loop
      v_touches[v_index].transmission_id := null;
    end loop;
  end if;
  v_capability := case when pg_catalog.array_length(v_touch_ids, 1) > 1
    then 'fl04c-batch' when v_touches[1].kind = 'initial'
    then 'fl04b-initial' else 'fl04c-followup' end;
  if public.pursue_cim_current_activation_v1(v_capability, v_now) is null
    or v_conversation.id is null or v_conversation.state <> 'open'
    or v_conversation.terminal_revision <> v_expected_conversation
    or v_conversation.recipient_address <> v_to ->> 0
  then
    return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
      'payloadConflict', false, 'terminal', true, 'transmission', null);
  end if;
  for v_index in 1..pg_catalog.array_length(v_touches, 1) loop
    v_touch := v_touches[v_index];
    v_campaign := v_campaigns[v_index];
    if v_campaign.conversation_id <> v_conversation.id
      or v_campaign.terminal_revision <> v_expected_campaign
      or v_campaign.state not in ('initial-pending','active-follow-up')
      or v_campaign.crm_submission_id is null
      or (v_campaign.local_expiry_at is not null and v_campaign.local_expiry_at <= v_now)
      or v_touch.state <> 'claimed'
      or v_touch.claim_token_digest <> v_claim_digest
      or v_touch.transmission_id is not null
    then
      return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
        'payloadConflict', false, 'terminal', true, 'transmission', null);
    end if;
  end loop;
  select * into v_crm_owner from public.contact_submissions
    where id = v_campaigns[1].crm_submission_id for update;
  if not found or v_crm_owner.deal_hunter_opportunity_id <> v_campaigns[1].opportunity_id
    or v_crm_owner.archived_at is not null
  then
    return pg_catalog.jsonb_build_object('prepared', false, 'existing', false,
      'payloadConflict', false, 'terminal', true, 'transmission', null);
  end if;
  v_member_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-members:v1'::text), pg_catalog.to_jsonb(v_touch_ids));
  v_transmission_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-transmission:v1'::text),
    pg_catalog.to_jsonb(v_campaigns[1].policy_version),
    pg_catalog.to_jsonb(v_conversation.recipient_fingerprint),
    pg_catalog.to_jsonb(v_touch_ids), pg_catalog.to_jsonb(v_generation),
    pg_catalog.to_jsonb(v_payload_version), pg_catalog.to_jsonb(v_payload_digest));
  v_communication_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('crm-communication:cim-autopilot:v1'::text),
    pg_catalog.to_jsonb(v_transmission_id));
  v_outbox_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('crm-outbox:cim-autopilot:v1'::text),
    pg_catalog.to_jsonb(v_transmission_id));
  v_provider_key := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('cim-provider:v1'::text),
    pg_catalog.to_jsonb(v_transmission_id), pg_catalog.to_jsonb(v_payload_digest));
  v_metadata := pg_catalog.jsonb_build_object('transmissionId', v_transmission_id,
    'campaignIds', pg_catalog.to_jsonb(v_campaign_ids), 'tags', v_tags,
    'retryPolicy', 'reconcile-only-after-provider-pending');
  insert into public.crm_communications
    (id, submission_id, opportunity_id, direction, channel, source, kind,
     idempotency_key, outbox_id, thread_key, from_address, to_addresses,
     cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
     body_html_sanitized, occurred_at, created_at, updated_at, metadata)
  values (v_communication_id, v_crm_owner.id, v_campaigns[1].opportunity_id,
    'outbound', 'email', 'pursue-cim-autopilot',
    case when v_touches[1].kind = 'initial' then 'cim-initial' else 'cim-follow-up' end,
    v_communication_id, v_outbox_id, v_conversation.rfc_thread_key,
    v_from, v_to, v_cc, v_bcc, v_reply_to, v_subject, v_body_text,
    v_body_html, v_now, v_now, v_now, v_metadata);
  insert into public.crm_email_outbox
    (id, communication_id, submission_id, idempotency_key, client_request_key,
     state, attempt_count, expected_submission_version, actor, created_at, updated_at, metadata)
  values (v_outbox_id, v_communication_id, v_crm_owner.id, v_outbox_id,
    public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-client-request:v1'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'prepared', 0, v_crm_owner.updated_at, v_actor, v_now, v_now, v_metadata);
  insert into public.deal_hunter_cim_transmissions
    (id, conversation_id, member_digest, preparation_generation, payload_version,
     payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
     reply_to_address, subject, provider_idempotency_key, communication_id,
     outbox_id, state, release_state, created_at, updated_at)
  values (v_transmission_id, v_conversation.id, v_member_digest, v_generation,
    v_payload_version, v_payload_digest, v_from, v_to, v_cc, v_bcc, v_reply_to,
    v_subject, v_provider_key, v_communication_id, v_outbox_id,
    'prepared', 'ordinary', v_now, v_now)
  returning * into v_transmission;
  for v_index in 1..pg_catalog.array_length(v_touches, 1) loop
    v_touch := v_touches[v_index];
    v_campaign := v_campaigns[v_index];
    insert into public.deal_hunter_cim_transmission_touches
      (transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at)
    values (v_transmission_id, v_touch.id, v_touch.opportunity_id,
      v_touch.campaign_id, v_index, v_now);
    update public.deal_hunter_cim_campaign_touches
      set transmission_id = v_transmission_id, row_version = row_version + 1,
        updated_at = v_now
      where id = v_touch.id and state = 'claimed'
        and claim_token_digest = v_claim_digest and transmission_id is null;
    if not found then
      raise exception 'Concurrent Pursue CIM transmission membership';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
       transmission_id, next_state, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('transmission-membership'::text),
        pg_catalog.to_jsonb(v_transmission_id || ':' || v_touch.id)),
      'transmission-membership', v_touch.opportunity_id, v_campaign.id,
      v_conversation.id, v_touch.id, v_transmission_id,
      'active', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  end loop;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, conversation_id, transmission_id,
     next_state, payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-prepared'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'transmission-prepared', v_campaigns[1].opportunity_id, v_conversation.id,
    v_transmission_id, 'prepared', v_payload_digest,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('prepared', true, 'existing', false,
    'payloadConflict', false, 'terminal', false,
    'transmission', pg_catalog.to_jsonb(v_transmission));
end;
$$;

revoke all on function public.pursue_cim_cancel_prepared_transmission_v1(
  text,timestamptz,text,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.pursue_cim_prepare_transmission_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_prepare_transmission_v1(jsonb) to service_role;

create or replace function public.pursue_cim_issue_live_authorization_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_activation_id text;
  v_capability text;
  v_writer_path text;
  v_transmission_id text;
  v_payload_digest text;
  v_recipient_digest text;
  v_provider_profile text;
  v_actor text;
  v_reason text;
  v_now timestamptz;
  v_expires timestamptz;
  v_existing public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_current public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_count integer := 0;
  v_replay boolean;
begin
  v_id := public.pursue_cim_required_text_v1(p_command, 'id', 240);
  v_activation_id := public.pursue_cim_required_text_v1(p_command, 'activationId', 240);
  v_capability := public.pursue_cim_required_text_v1(p_command, 'capability', 40);
  v_writer_path := public.pursue_cim_required_text_v1(p_command, 'writerPath', 240);
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_payload_digest := public.pursue_cim_required_text_v1(p_command, 'payloadDigest', 64);
  v_recipient_digest := public.pursue_cim_required_text_v1(
    p_command, 'recipientAuthorityDigest', 64);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_reason := public.pursue_cim_required_text_v1(p_command, 'reason', 1000);
  if v_payload_digest !~ '^[0-9a-f]{64}$'
    or v_recipient_digest !~ '^[0-9a-f]{64}$'
    or p_command ->> 'now' is null or p_command ->> 'expiresAt' is null
  then
    raise exception 'Invalid Pursue CIM live authorization command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_expires := public.pursue_cim_required_instant_v1(p_command, 'expiresAt');
  if v_expires <= v_now then
    raise exception 'Pursue CIM authorization already expired';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:authorization-id:' || v_id, 0));
  select * into v_existing from public.deal_hunter_cim_live_provider_authorizations
    where id = v_id for update;
  if found then
    v_replay := v_existing.activation_id = v_activation_id
      and v_existing.capability = v_capability
      and v_existing.writer_path = v_writer_path
      and v_existing.transmission_id = v_transmission_id
      and v_existing.payload_digest = v_payload_digest
      and v_existing.recipient_authority_digest = v_recipient_digest
      and v_existing.provider_profile = v_provider_profile
      and v_existing.expires_at = v_expires;
    return pg_catalog.jsonb_build_object('issued', false, 'replay', v_replay,
      'conflict', not v_replay, 'blockedReason', null,
      'authorization', pg_catalog.to_jsonb(v_existing));
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pursue-cim:authorization-current:' || v_transmission_id || ':' || v_writer_path, 0));
  select * into v_current from public.deal_hunter_cim_live_provider_authorizations
    where transmission_id = v_transmission_id and writer_path = v_writer_path
      and consumed_at is null and withdrawn_at is null for update;
  if found then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'authorization_exists',
      'authorization', pg_catalog.to_jsonb(v_current));
  end if;
  select * into v_activation from public.deal_hunter_cim_capability_activations
    where id = v_activation_id for share;
  if public.pursue_cim_current_activation_v1(v_capability, v_now) is distinct from v_activation_id
    or v_activation.provider_profile is distinct from v_provider_profile
  then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'capability_inactive', 'authorization', null);
  end if;
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_transmission_id for update;
  if not found or v_transmission.state <> 'prepared'
    or v_transmission.payload_digest <> v_payload_digest
  then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'transmission_invalid', 'authorization', null);
  end if;
  for v_member in
    select c.recipient_fingerprint, t.kind
    from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
    join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
    where m.transmission_id = v_transmission_id and m.cancelled_at is null
    order by m.touch_id for share of m,c,t
  loop
    v_count := v_count + 1;
    if v_member.recipient_fingerprint <> v_recipient_digest
      or (v_member.kind = 'initial' and v_capability <> 'fl04b-initial')
      or (v_member.kind <> 'initial' and v_capability = 'fl04b-initial')
    then
      return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
        'conflict', false, 'blockedReason', 'recipient_authority_changed',
        'authorization', null);
    end if;
  end loop;
  if v_count = 0 then
    return pg_catalog.jsonb_build_object('issued', false, 'replay', false,
      'conflict', false, 'blockedReason', 'recipient_authority_changed',
      'authorization', null);
  end if;
  insert into public.deal_hunter_cim_live_provider_authorizations
    (id, activation_id, capability, writer_path, transmission_id,
     payload_digest, recipient_authority_digest, provider_profile,
     maximum_calls, issued_at, expires_at, actor, reason)
  values (v_id, v_activation_id, v_capability, v_writer_path, v_transmission_id,
    v_payload_digest, v_recipient_digest, v_provider_profile, 1,
    v_now, v_expires, v_actor, v_reason)
  returning * into v_existing;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, activation_id, authorization_id,
     next_state, payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('live-authorization-issued'::text),
      pg_catalog.to_jsonb(v_id)),
    'live-authorization-issued', v_transmission_id, v_activation_id,
    v_id, 'issued', v_payload_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('issued', true, 'replay', false,
    'conflict', false, 'blockedReason', null, 'authorization', pg_catalog.to_jsonb(v_existing));
end;
$$;

revoke all on function public.pursue_cim_issue_live_authorization_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_issue_live_authorization_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_authorize_provider_pending_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_authorization_id text;
  v_writer_path text;
  v_provider_profile text;
  v_expected_row bigint;
  v_expected_campaign bigint;
  v_expected_conversation bigint;
  v_claim_digest text;
  v_gate_digest text;
  v_nonce_digest text;
  v_actor text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_communication public.crm_communications%rowtype;
  v_outbox public.crm_email_outbox%rowtype;
  v_member record;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_timezone public.deal_hunter_opportunity_timezone_revisions%rowtype;
  v_owner public.contact_submissions%rowtype;
  v_count integer := 0;
  v_member_ids text[] := array[]::text[];
  v_templates text[] := array[]::text[];
  v_payload_digest text;
  v_pause boolean;
  v_reason text := null;
  v_local timestamp;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_authorization_id := public.pursue_cim_required_text_v1(p_command, 'authorizationId', 240);
  v_writer_path := public.pursue_cim_required_text_v1(p_command, 'writerPath', 240);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_expected_row := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_expected_campaign := public.pursue_cim_required_revision_v1(
    p_command, 'expectedCampaignTerminalRevision');
  v_expected_conversation := public.pursue_cim_required_revision_v1(
    p_command, 'expectedConversationTerminalRevision');
  v_claim_digest := public.pursue_cim_required_text_v1(p_command, 'claimTokenDigest', 64);
  v_gate_digest := public.pursue_cim_required_text_v1(p_command, 'finalGateAuthorityDigest', 64);
  v_nonce_digest := public.pursue_cim_required_text_v1(p_command, 'boundaryNonceDigest', 64);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if v_claim_digest !~ '^[0-9a-f]{64}$' or v_gate_digest !~ '^[0-9a-f]{64}$'
    or v_nonce_digest !~ '^[0-9a-f]{64}$' or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM provider-pending command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  <<gate>>
  begin
    select * into v_transmission from public.deal_hunter_cim_transmissions
      where id = v_transmission_id for update;
    if not found then
      v_reason := 'lifecycle_conflict'; exit gate;
    end if;
    if v_transmission.state <> 'prepared'
      or v_transmission.invocation_authority_count <> 0 then
      v_reason := 'already_provider_pending'; exit gate;
    end if;
    if v_transmission.row_version <> v_expected_row then
      v_reason := 'stale_authority'; exit gate;
    end if;
    select outreach_paused into v_pause from public.deal_hunter_cim_safety_settings
      where id = 'global' for share;
    if not found or v_pause is distinct from false then
      v_reason := 'central_pause'; exit gate;
    end if;
    select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
      where id = v_authorization_id for update;
    if not found or v_authorization.transmission_id <> v_transmission_id
      or v_authorization.writer_path <> v_writer_path
      or v_authorization.provider_profile <> v_provider_profile
      or v_authorization.payload_digest <> v_transmission.payload_digest
      or v_authorization.consumed_at is not null
      or v_authorization.withdrawn_at is not null
      or v_authorization.maximum_calls <> 1
      or v_authorization.expires_at <= v_now
    then
      v_reason := 'live_authorization_invalid'; exit gate;
    end if;
    select * into v_activation from public.deal_hunter_cim_capability_activations
      where id = v_authorization.activation_id for share;
    if public.pursue_cim_current_activation_v1(v_authorization.capability, v_now)
         is distinct from v_authorization.activation_id
      or v_activation.provider_profile is distinct from v_provider_profile
    then
      v_reason := 'capability_inactive'; exit gate;
    end if;
    select * into v_conversation from public.deal_hunter_broker_conversations
      where id = v_transmission.conversation_id for update;
    if not found or v_conversation.state <> 'open'
      or v_conversation.terminal_revision <> v_expected_conversation
    then
      v_reason := 'terminal_authority_changed'; exit gate;
    end if;
    for v_member in
      select t.*, c.state as campaign_state,
        c.terminal_revision as campaign_terminal_revision,
        c.timezone_revision as campaign_timezone_revision,
        c.discovery_revision as campaign_discovery_revision,
        c.material_revision as campaign_material_revision,
        c.recipient_fingerprint, c.crm_submission_id, c.template_version,
        c.local_expiry_at
      from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
      where m.transmission_id = v_transmission_id and m.cancelled_at is null
      order by t.id for update of m,t,c
    loop
      v_count := v_count + 1;
      v_member_ids := pg_catalog.array_append(v_member_ids, v_member.id);
      v_templates := pg_catalog.array_append(v_templates, v_member.template_version);
      if v_member.campaign_state not in ('initial-pending','active-follow-up')
        or v_member.campaign_terminal_revision <> v_expected_campaign then
        v_reason := 'terminal_authority_changed'; exit gate;
      end if;
      if v_member.state <> 'claimed'
        or v_member.claim_token_digest <> v_claim_digest
        or v_member.transmission_id <> v_transmission_id
        or v_member.claim_expires_at is null or v_member.claim_expires_at <= v_now
        or v_member.due_at > v_now then
        v_reason := 'lifecycle_conflict'; exit gate;
      end if;
      if v_member.recipient_fingerprint <> v_authorization.recipient_authority_digest
        or v_conversation.recipient_fingerprint <> v_authorization.recipient_authority_digest
      then
        v_reason := 'recipient_authority_changed'; exit gate;
      end if;
      select * into v_opportunity from public.deal_hunter_opportunities
        where opportunity_id = v_member.opportunity_id for share;
      if not found or v_opportunity.status <> 'active'
        or v_opportunity.discovery_revision <> v_member.campaign_discovery_revision
        or v_opportunity.material_revision <> v_member.campaign_material_revision then
        v_reason := 'freshness_changed'; exit gate;
      end if;
      select * into v_timezone from public.deal_hunter_opportunity_timezone_revisions
        where opportunity_id = v_member.opportunity_id order by revision desc limit 1 for share;
      if not found or v_timezone.revision <> v_member.campaign_timezone_revision
        or v_timezone.state not in ('verified','derived') then
        v_reason := 'timezone_changed'; exit gate;
      end if;
      if v_timezone.iana_timezone is null then
        v_reason := 'outside_send_window'; exit gate;
      end if;
      begin
        v_local := v_now at time zone v_timezone.iana_timezone;
      exception when invalid_parameter_value then
        v_reason := 'outside_send_window'; exit gate;
      end;
      if extract(isodow from v_local) in (6,7)
        or v_local::time < time '08:00'
        or v_local::time >= time '17:00' then
        v_reason := 'outside_send_window'; exit gate;
      end if;
      select * into v_owner from public.contact_submissions
        where id = v_member.crm_submission_id for share;
      if not found or v_owner.archived_at is not null
        or v_owner.deal_hunter_opportunity_id <> v_member.opportunity_id then
        v_reason := 'crm_owner_changed'; exit gate;
      end if;
      if v_member.local_expiry_at is not null and v_member.local_expiry_at <= v_now then
        v_reason := 'expired'; exit gate;
      end if;
    end loop;
    if v_count = 0 then
      v_reason := 'terminal_authority_changed'; exit gate;
    end if;
    if exists (select 1 from public.email_suppressions
      where normalized_email = pg_catalog.lower(v_conversation.recipient_address)
        and lifted_at is null) then
      v_reason := 'recipient_suppressed'; exit gate;
    end if;
    select * into v_communication from public.crm_communications
      where id = v_transmission.communication_id for update;
    if not found or v_communication.outbox_id <> v_transmission.outbox_id
      or v_communication.delivery_state <> 'not-attempted' then
      v_reason := 'communication_changed'; exit gate;
    end if;
    select * into v_outbox from public.crm_email_outbox
      where id = v_transmission.outbox_id for update;
    if not found or v_outbox.communication_id <> v_transmission.communication_id
      or v_outbox.state <> 'prepared' or v_outbox.attempt_count <> 0 then
      v_reason := 'outbox_changed'; exit gate;
    end if;
    v_payload_digest := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-payload:v1'::text),
      pg_catalog.to_jsonb(v_communication.from_address),
      v_communication.to_addresses, v_communication.cc_addresses,
      v_communication.bcc_addresses,
      pg_catalog.to_jsonb(v_communication.reply_to_address),
      pg_catalog.to_jsonb(v_communication.subject),
      pg_catalog.to_jsonb(v_communication.body_text),
      pg_catalog.to_jsonb(v_communication.body_html_sanitized),
      v_communication.metadata -> 'tags',
      pg_catalog.to_jsonb(v_member_ids), pg_catalog.to_jsonb(v_templates),
      pg_catalog.to_jsonb(v_transmission.payload_version));
    if v_payload_digest <> v_transmission.payload_digest then
      v_reason := 'payload_changed'; exit gate;
    end if;
  end gate;
  if v_reason is not null then
    return pg_catalog.jsonb_build_object('authorized', false,
      'blockedReason', v_reason, 'transmission',
      case when v_transmission.id is null then null else pg_catalog.to_jsonb(v_transmission) end,
      'boundaryNonceDigest', null);
  end if;
  update public.deal_hunter_cim_transmissions
    set state = 'provider-pending', release_state = 'authorized',
      final_gate_authority_digest = v_gate_digest,
      campaign_terminal_revision = v_expected_campaign,
      conversation_terminal_revision = v_expected_conversation,
      invocation_authority_count = 1,
      provider_invocation_authorized_at = v_now,
      boundary_nonce_digest = v_nonce_digest,
      row_version = row_version + 1, updated_at = v_now
    where id = v_transmission_id and state = 'prepared'
      and invocation_authority_count = 0 and row_version = v_expected_row
    returning * into v_transmission;
  if not found then
    raise exception 'Concurrent Pursue CIM provider-pending transition';
  end if;
  update public.deal_hunter_cim_campaign_touches
    set state = 'provider-pending', row_version = row_version + 1, updated_at = v_now
    where id = any(v_member_ids) and state = 'claimed'
      and transmission_id = v_transmission_id;
  if not found then
    raise exception 'Concurrent Pursue CIM member transition';
  end if;
  update public.deal_hunter_cim_live_provider_authorizations
    set consumed_at = v_now where id = v_authorization_id
      and consumed_at is null and withdrawn_at is null;
  if not found then
    raise exception 'Concurrent Pursue CIM authorization consumption';
  end if;
  update public.crm_communications
    set delivery_state = 'provider-pending', delivery_state_at = v_now,
      updated_at = v_now where id = v_transmission.communication_id;
  update public.crm_email_outbox
    set state = 'provider-pending', updated_at = v_now
    where id = v_transmission.outbox_id;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, conversation_id, transmission_id, authority_digest,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('final-gate-authorized'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'final-gate-authorized', v_transmission.conversation_id,
    v_transmission_id, v_gate_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, conversation_id, transmission_id, prior_state, next_state,
     authority_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('provider-pending'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'provider-pending', v_transmission.conversation_id, v_transmission_id,
    'prepared', 'provider-pending', v_gate_digest, v_actor,
    'sqlite-transition', v_now, '{}'::jsonb);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, authorization_id, prior_state, next_state,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('live-authorization-consumed'::text),
      pg_catalog.to_jsonb(v_authorization_id)),
    'live-authorization-consumed', v_transmission_id, v_authorization_id,
    'issued', 'consumed', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('authorized', true, 'blockedReason', null,
    'transmission', pg_catalog.to_jsonb(v_transmission),
    'boundaryNonceDigest', v_nonce_digest);
end;
$$;

revoke all on function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_authorize_provider_pending_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_enter_provider_seam_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transmission_id text;
  v_authorization_id text;
  v_writer_path text;
  v_provider_profile text;
  v_nonce_digest text;
  v_expected bigint;
  v_actor text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
  v_pause boolean;
begin
  v_transmission_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_authorization_id := public.pursue_cim_required_text_v1(p_command, 'authorizationId', 240);
  v_writer_path := public.pursue_cim_required_text_v1(p_command, 'writerPath', 240);
  v_provider_profile := public.pursue_cim_required_text_v1(p_command, 'providerProfile', 120);
  v_nonce_digest := public.pursue_cim_required_text_v1(p_command, 'boundaryNonceDigest', 64);
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if v_nonce_digest !~ '^[0-9a-f]{64}$' or p_command ->> 'now' is null then
    raise exception 'Invalid Pursue CIM provider seam command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_transmission_id for update;
  select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
    where id = v_authorization_id for share;
  if v_transmission.state is distinct from 'provider-pending'
    or v_transmission.invocation_authority_count is distinct from 1
    or v_transmission.boundary_nonce_digest is distinct from v_nonce_digest
    or v_authorization.transmission_id is distinct from v_transmission_id
    or v_authorization.writer_path is distinct from v_writer_path
    or v_authorization.provider_profile is distinct from v_provider_profile
    or v_authorization.consumed_at is null
    or v_authorization.withdrawn_at is not null
    or public.pursue_cim_current_activation_v1(v_authorization.capability, v_now)
      is distinct from v_authorization.activation_id
  then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;
  if v_transmission.provider_seam_entered_at is not null then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', true, 'unauthorized', false);
  end if;
  select outreach_paused into v_pause from public.deal_hunter_cim_safety_settings
    where id = 'global' for share;
  if not found or v_pause is distinct from false
    or v_transmission.row_version <> v_expected then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;
  update public.deal_hunter_cim_transmissions
    set provider_seam_entered_at = v_now, updated_at = v_now,
      row_version = row_version + 1
    where id = v_transmission_id and state = 'provider-pending'
      and provider_seam_entered_at is null
      and boundary_nonce_digest = v_nonce_digest and row_version = v_expected;
  if not found then
    return pg_catalog.jsonb_build_object('entered', false,
      'alreadyEntered', false, 'unauthorized', true);
  end if;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, transmission_id, authorization_id, next_state,
     actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('provider-seam-entered'::text),
      pg_catalog.to_jsonb(v_transmission_id)),
    'provider-seam-entered', v_transmission_id, v_authorization_id,
    'entered', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('entered', true,
    'alreadyEntered', false, 'unauthorized', false);
end;
$$;

revoke all on function public.pursue_cim_enter_provider_seam_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_enter_provider_seam_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_finalize_transmission_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_expected bigint;
  v_outcome text;
  v_provider text;
  v_message_id text := p_command ->> 'providerMessageId';
  v_result_code text;
  v_actor text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_next_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_member record;
  v_member_count integer;
  v_advance_state text;
  v_delivery_state text;
  v_next jsonb := p_command -> 'nextTouch';
  v_next_id text;
  v_expiry timestamptz;
  v_expiry_derivation jsonb;
  v_existing boolean;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array[]::text[], array[]::text[], array['providerMessageId']);
  v_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_outcome := public.pursue_cim_required_text_v1(p_command, 'outcome', 40);
  v_provider := public.pursue_cim_required_text_v1(p_command, 'provider', 80);
  v_result_code := public.pursue_cim_required_text_v1(p_command, 'providerResultCode', 160);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if v_outcome not in ('accepted','definitive-failure','ambiguous')
    or (v_outcome = 'accepted' and
      (v_message_id is null or pg_catalog.length(v_message_id) not between 1 and 240
        or pg_catalog.btrim(v_message_id) <> v_message_id))
    or (v_message_id is not null and
      (pg_catalog.length(v_message_id) not between 1 and 240
        or pg_catalog.btrim(v_message_id) <> v_message_id))
    or p_command ->> 'now' is null
  then
    raise exception 'Invalid Pursue CIM finalization command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'conflict', true, 'transmission', null, 'nextTouch', null);
  end if;
  if v_transmission.state in ('accepted','definitive-failure','ambiguous') then
    v_existing := v_transmission.state = v_outcome
      and v_transmission.provider = v_provider
      and v_transmission.provider_message_id is not distinct from v_message_id
      and v_transmission.provider_result_code = v_result_code;
    if v_existing then
      select t.* into v_next_touch from public.deal_hunter_cim_campaign_touches as t
        where t.campaign_id in (
          select campaign_id from public.deal_hunter_cim_transmission_touches
            where transmission_id = v_id
        ) and t.ordinal = 1 order by t.id limit 1;
    end if;
    return pg_catalog.jsonb_build_object('applied', false, 'existing', v_existing,
      'conflict', not v_existing, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'nextTouch', case when v_next_touch.id is null then null
        else pg_catalog.to_jsonb(v_next_touch) end);
  end if;
  if v_transmission.state <> 'provider-pending'
    or v_transmission.row_version <> v_expected
    or v_transmission.invocation_authority_count <> 1
    or v_transmission.provider_seam_entered_at is null
  then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'conflict', true, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'nextTouch', null);
  end if;
  select count(*) into v_member_count from public.deal_hunter_cim_transmission_touches
    where transmission_id = v_id and cancelled_at is null;
  if v_member_count = 0 or exists (
    select 1 from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      where m.transmission_id = v_id and m.cancelled_at is null
        and t.state <> 'provider-pending')
  then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'conflict', true, 'transmission', pg_catalog.to_jsonb(v_transmission),
      'nextTouch', null);
  end if;
  if v_outcome = 'accepted' and v_member_count = 1 and exists (
    select 1 from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
    join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
    where m.transmission_id = v_id and m.cancelled_at is null
      and c.state = 'initial-pending'
      and c.terminal_revision = v_transmission.campaign_terminal_revision
  ) then
    if v_next is null or pg_catalog.jsonb_typeof(v_next) <> 'object'
      or public.pursue_cim_required_text_v1(v_next, 'logicalSlot', 160) <> 'follow-up-1'
      or public.pursue_cim_required_text_v1(v_next, 'kind', 40) <> 'follow-up-1'
      or public.pursue_cim_required_revision_v1(v_next, 'ordinal') <> 1
      or v_next ->> 'dueAt' is null
      or p_command ->> 'localExpiryAt' is null
      or p_command -> 'expiryDerivation' is null
      or pg_catalog.length(public.pursue_cim_json_stringify_v1(
        p_command -> 'expiryDerivation')) > 1000
    then
      raise exception 'Accepted Pursue CIM initial finalization requires next slot';
    end if;
    perform public.pursue_cim_required_text_v1(v_next, 'dueLocal', 120);
    perform public.pursue_cim_required_text_v1(v_next, 'cadencePolicyVersion', 120);
    v_expiry := public.pursue_cim_required_instant_v1(p_command, 'localExpiryAt');
    v_expiry_derivation := p_command -> 'expiryDerivation';
  end if;
  update public.deal_hunter_cim_transmissions
    set state = v_outcome, provider = v_provider,
      provider_message_id = v_message_id, provider_result_code = v_result_code,
      row_version = row_version + 1, updated_at = v_now
    where id = v_id and state = 'provider-pending' and row_version = v_expected
    returning * into v_transmission;
  if not found then
    raise exception 'Concurrent Pursue CIM transmission finalization';
  end if;
  v_advance_state := case v_outcome
    when 'accepted' then 'active-follow-up'
    when 'definitive-failure' then 'action-required'
    else 'provider-ambiguous' end;
  for v_member in
    select t.*, c.state as campaign_state,
      c.terminal_revision as campaign_terminal_revision,
      c.row_version as campaign_row_version,
      c.timezone_revision as campaign_timezone_revision,
      c.conversation_id as campaign_conversation_id
    from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
    join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
    where m.transmission_id = v_id and m.cancelled_at is null
    order by t.id for update of m,t,c
  loop
    update public.deal_hunter_cim_campaign_touches
      set state = v_outcome, outcome_code = v_result_code,
        row_version = row_version + 1, updated_at = v_now
      where id = v_member.id and state = 'provider-pending'
        and row_version = v_member.row_version;
    if not found then
      raise exception 'Concurrent Pursue CIM touch finalization';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
       transmission_id, prior_state, next_state, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('touch-finalized'::text),
        pg_catalog.to_jsonb(v_member.id || ':' || (v_member.row_version + 1)::text)),
      'touch-finalized', v_member.opportunity_id, v_member.campaign_id,
      v_member.campaign_conversation_id, v_member.id, v_id,
      'provider-pending', v_outcome, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    if v_member.campaign_terminal_revision <> v_transmission.campaign_terminal_revision
      or v_member.campaign_state not in ('initial-pending','active-follow-up') then
      continue;
    end if;
    update public.deal_hunter_cim_campaigns
      set state = v_advance_state,
        reason_code = case v_outcome
          when 'definitive-failure' then 'provider_definitive_failure'
          when 'ambiguous' then 'provider_ambiguous' else null end,
        initial_accepted_at = coalesce(initial_accepted_at,
          case when v_outcome = 'accepted' then v_now else null end),
        local_expiry_at = coalesce(local_expiry_at,
          case when v_outcome = 'accepted' then v_expiry else null end),
        expiry_derivation = case when initial_accepted_at is null and v_outcome = 'accepted'
          then coalesce(v_expiry_derivation, '{}'::jsonb) else expiry_derivation end,
        row_version = row_version + 1, updated_at = v_now
      where id = v_member.campaign_id and row_version = v_member.campaign_row_version
        and terminal_revision = v_member.campaign_terminal_revision;
    if not found then
      raise exception 'Concurrent Pursue CIM campaign finalization';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
       actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('campaign-transition'::text),
        pg_catalog.to_jsonb(v_member.campaign_id || ':' ||
          (v_member.campaign_row_version + 1)::text)),
      'campaign-transition', v_member.opportunity_id, v_member.campaign_id,
      v_member.campaign_state, v_advance_state,
      v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    if v_outcome = 'accepted' and v_member.kind = 'initial' then
      v_next_id := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-touch:v1'::text),
        pg_catalog.to_jsonb(v_member.campaign_id),
        pg_catalog.to_jsonb(v_next ->> 'logicalSlot'),
        pg_catalog.to_jsonb(v_next ->> 'cadencePolicyVersion'));
      insert into public.deal_hunter_cim_campaign_touches
        (id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
         due_at, due_local, timezone_revision, state, created_at, updated_at)
      values (v_next_id, v_member.campaign_id, v_member.opportunity_id,
        v_next ->> 'logicalSlot', v_next ->> 'kind',
        1, public.pursue_cim_required_instant_v1(v_next, 'dueAt'), v_next ->> 'dueLocal',
        v_member.campaign_timezone_revision, 'scheduled', v_now, v_now)
      returning * into v_next_touch;
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, touch_id, next_state,
         actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('touch-created'::text), pg_catalog.to_jsonb(v_next_id)),
        'touch-created', v_member.opportunity_id, v_member.campaign_id,
        v_next_id, 'scheduled', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    end if;
  end loop;
  v_delivery_state := case when v_outcome = 'definitive-failure'
    then 'failed' else v_outcome end;
  update public.crm_communications
    set provider = v_provider, provider_message_id = v_message_id,
      delivery_state = v_delivery_state, delivery_state_at = v_now,
      updated_at = v_now where id = v_transmission.communication_id;
  update public.crm_email_outbox
    set provider = v_provider, provider_message_id = v_message_id,
      state = v_delivery_state, attempt_count = 1, updated_at = v_now
    where id = v_transmission.outbox_id;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, conversation_id, transmission_id, prior_state,
     next_state, payload_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-finalized'::text), pg_catalog.to_jsonb(v_id)),
    'transmission-finalized', v_transmission.conversation_id, v_id,
    'provider-pending', v_outcome, v_transmission.payload_digest,
    v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'existing', false,
    'conflict', false, 'transmission', pg_catalog.to_jsonb(v_transmission),
    'nextTouch', case when v_next_touch.id is null then null
      else pg_catalog.to_jsonb(v_next_touch) end);
end;
$$;

revoke all on function public.pursue_cim_finalize_transmission_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_finalize_transmission_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_reconcile_transmission_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_expected bigint;
  v_outcome text;
  v_provider text;
  v_message_id text := p_command ->> 'providerMessageId';
  v_result_code text;
  v_evidence_type text;
  v_evidence_id text;
  v_evidence_digest text;
  v_actor text;
  v_now timestamptz;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_member record;
  v_member_count integer;
  v_should_advance boolean;
  v_next jsonb := p_command -> 'nextTouch';
  v_expiry timestamptz;
  v_expiry_derivation jsonb;
  v_next_id text;
  v_unchanged boolean;
  v_delivery_state text;
  v_prior_state text;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array[]::text[], array[]::text[], array['providerMessageId']);
  v_id := public.pursue_cim_required_text_v1(p_command, 'transmissionId', 240);
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_outcome := public.pursue_cim_required_text_v1(p_command, 'outcome', 40);
  v_provider := public.pursue_cim_required_text_v1(p_command, 'provider', 80);
  v_result_code := public.pursue_cim_required_text_v1(p_command, 'providerResultCode', 160);
  v_evidence_type := public.pursue_cim_required_text_v1(p_command, 'evidenceType', 120);
  v_evidence_id := public.pursue_cim_required_text_v1(p_command, 'evidenceId', 240);
  v_evidence_digest := public.pursue_cim_required_text_v1(p_command, 'evidenceDigest', 64);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if v_outcome not in ('accepted','definitive-failure')
    or v_evidence_digest !~ '^[0-9a-f]{64}$'
    or (v_outcome = 'accepted' and
      (v_message_id is null or pg_catalog.length(v_message_id) not between 1 and 240
        or pg_catalog.btrim(v_message_id) <> v_message_id))
    or p_command ->> 'now' is null then
    raise exception 'Invalid Pursue CIM reconciliation command';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_transmission from public.deal_hunter_cim_transmissions
    where id = v_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'unchanged', false,
      'conflict', true, 'transmission', null);
  end if;
  if v_transmission.state in ('accepted','definitive-failure') then
    v_unchanged := v_transmission.state = v_outcome
      and v_transmission.provider = v_provider
      and v_transmission.provider_message_id is not distinct from v_message_id
      and v_transmission.provider_result_code = v_result_code;
    return pg_catalog.jsonb_build_object('applied', false, 'unchanged', v_unchanged,
      'conflict', not v_unchanged, 'transmission', pg_catalog.to_jsonb(v_transmission));
  end if;
  if v_transmission.state not in ('provider-pending','ambiguous')
    or v_transmission.row_version <> v_expected
    or v_transmission.invocation_authority_count <> 1
    or (v_transmission.provider is not null and v_transmission.provider <> v_provider)
  then
    return pg_catalog.jsonb_build_object('applied', false, 'unchanged', false,
      'conflict', true, 'transmission', pg_catalog.to_jsonb(v_transmission));
  end if;
  v_prior_state := v_transmission.state;
  select count(*) into v_member_count from public.deal_hunter_cim_transmission_touches
    where transmission_id = v_id and cancelled_at is null;
  if v_member_count = 0 or exists (
    select 1 from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      where m.transmission_id = v_id and m.cancelled_at is null
        and t.state not in ('provider-pending','ambiguous'))
  then
    return pg_catalog.jsonb_build_object('applied', false, 'unchanged', false,
      'conflict', true, 'transmission', pg_catalog.to_jsonb(v_transmission));
  end if;
  select v_member_count = 1 and exists (
    select 1 from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
      where m.transmission_id = v_id and m.cancelled_at is null
        and c.terminal_revision = v_transmission.campaign_terminal_revision
        and c.state in ('provider-ambiguous','initial-pending','active-follow-up')
  ) into v_should_advance;
  if v_should_advance and v_outcome = 'accepted' and exists (
    select 1 from public.deal_hunter_cim_transmission_touches as m
      join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
      where m.transmission_id = v_id and m.cancelled_at is null and t.kind = 'initial'
  ) then
    if v_next is null or pg_catalog.jsonb_typeof(v_next) <> 'object'
      or public.pursue_cim_required_text_v1(v_next, 'logicalSlot', 160) <> 'follow-up-1'
      or public.pursue_cim_required_text_v1(v_next, 'kind', 40) <> 'follow-up-1'
      or public.pursue_cim_required_revision_v1(v_next, 'ordinal') <> 1
      or v_next ->> 'dueAt' is null
      or p_command ->> 'localExpiryAt' is null
      or p_command -> 'expiryDerivation' is null
      or pg_catalog.length(public.pursue_cim_json_stringify_v1(
        p_command -> 'expiryDerivation')) > 1000
    then
      raise exception 'Accepted Pursue CIM reconciliation requires next slot';
    end if;
    perform public.pursue_cim_required_text_v1(v_next, 'dueLocal', 120);
    perform public.pursue_cim_required_text_v1(v_next, 'cadencePolicyVersion', 120);
    v_expiry := public.pursue_cim_required_instant_v1(p_command, 'localExpiryAt');
    v_expiry_derivation := p_command -> 'expiryDerivation';
  end if;
  update public.deal_hunter_cim_transmissions
    set state = v_outcome, provider = v_provider,
      provider_message_id = v_message_id, provider_result_code = v_result_code,
      updated_at = v_now, row_version = row_version + 1
    where id = v_id and row_version = v_expected
      and state in ('provider-pending','ambiguous')
    returning * into v_transmission;
  if not found then
    raise exception 'Concurrent Pursue CIM transmission reconciliation';
  end if;
  for v_member in
    select t.*, c.state as campaign_state,
      c.terminal_revision as campaign_terminal_revision,
      c.row_version as campaign_row_version,
      c.timezone_revision as campaign_timezone_revision
    from public.deal_hunter_cim_transmission_touches as m
    join public.deal_hunter_cim_campaign_touches as t on t.id = m.touch_id
    join public.deal_hunter_cim_campaigns as c on c.id = m.campaign_id
    where m.transmission_id = v_id and m.cancelled_at is null
    order by t.id for update of m,t,c
  loop
    update public.deal_hunter_cim_campaign_touches
      set state = v_outcome, outcome_code = v_result_code,
        updated_at = v_now, row_version = row_version + 1
      where id = v_member.id and row_version = v_member.row_version
        and state in ('provider-pending','ambiguous');
    if not found then
      raise exception 'Concurrent Pursue CIM touch reconciliation';
    end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, campaign_id, touch_id, transmission_id,
       prior_state, next_state, authority_digest, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('touch-reconciled'::text),
        pg_catalog.to_jsonb(v_member.id || ':' || (v_member.row_version + 1)::text)),
      'touch-reconciled', v_member.opportunity_id, v_member.campaign_id,
      v_member.id, v_id, v_member.state, v_outcome, v_evidence_digest,
      v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
    if v_should_advance then
      update public.deal_hunter_cim_campaigns
        set state = case when v_outcome = 'accepted' then 'active-follow-up'
          else 'action-required' end,
          reason_code = case when v_outcome = 'definitive-failure'
            then 'provider_definitive_failure' else null end,
          initial_accepted_at = coalesce(initial_accepted_at,
            case when v_outcome = 'accepted' then v_now else null end),
          local_expiry_at = coalesce(local_expiry_at,
            case when v_outcome = 'accepted' then v_expiry else null end),
          expiry_derivation = case when initial_accepted_at is null and v_outcome = 'accepted'
            then coalesce(v_expiry_derivation, '{}'::jsonb) else expiry_derivation end,
          updated_at = v_now, row_version = row_version + 1
        where id = v_member.campaign_id and row_version = v_member.campaign_row_version
          and terminal_revision = v_member.campaign_terminal_revision;
      if not found then
        raise exception 'Concurrent Pursue CIM campaign reconciliation';
      end if;
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
         authority_digest, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('campaign-transition'::text),
          pg_catalog.to_jsonb(v_member.campaign_id || ':' ||
            (v_member.campaign_row_version + 1)::text)),
        'campaign-transition', v_member.opportunity_id, v_member.campaign_id,
        v_member.campaign_state,
        case when v_outcome = 'accepted' then 'active-follow-up' else 'action-required' end,
        v_evidence_digest, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
      if v_outcome = 'accepted' and v_member.kind = 'initial' then
        v_next_id := public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-touch:v1'::text),
          pg_catalog.to_jsonb(v_member.campaign_id),
          pg_catalog.to_jsonb(v_next ->> 'logicalSlot'),
          pg_catalog.to_jsonb(v_next ->> 'cadencePolicyVersion'));
        insert into public.deal_hunter_cim_campaign_touches
          (id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
           due_at, due_local, timezone_revision, state, created_at, updated_at)
        values (v_next_id, v_member.campaign_id, v_member.opportunity_id,
          v_next ->> 'logicalSlot', v_next ->> 'kind',
          1, public.pursue_cim_required_instant_v1(v_next, 'dueAt'), v_next ->> 'dueLocal',
          v_member.campaign_timezone_revision, 'scheduled', v_now, v_now);
        insert into public.deal_hunter_cim_audit_events
          (id, event_type, opportunity_id, campaign_id, touch_id, next_state,
           actor, source, occurred_at, metadata)
        values (public.pursue_cim_digest_v1(
            pg_catalog.to_jsonb('cim-audit:v1'::text),
            pg_catalog.to_jsonb('touch-created'::text), pg_catalog.to_jsonb(v_next_id)),
          'touch-created', v_member.opportunity_id, v_member.campaign_id,
          v_next_id, 'scheduled', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
      end if;
    end if;
  end loop;
  v_delivery_state := case when v_outcome = 'definitive-failure'
    then 'failed' else 'accepted' end;
  update public.crm_communications
    set provider = v_provider, provider_message_id = v_message_id,
      delivery_state = v_delivery_state, delivery_state_at = v_now,
      updated_at = v_now where id = v_transmission.communication_id;
  update public.crm_email_outbox
    set provider = v_provider, provider_message_id = v_message_id,
      state = v_delivery_state, attempt_count = 1, updated_at = v_now
    where id = v_transmission.outbox_id;
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, conversation_id, transmission_id, prior_state, next_state,
     authority_digest, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('transmission-reconciled'::text),
      pg_catalog.to_jsonb(v_id || ':' || v_evidence_type || ':' || v_evidence_id)),
    'transmission-reconciled', v_transmission.conversation_id, v_id,
    v_prior_state, v_outcome, v_evidence_digest, v_actor, v_evidence_type,
    v_now, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('applied', true, 'unchanged', false,
    'conflict', false, 'transmission', pg_catalog.to_jsonb(v_transmission));
end;
$$;

revoke all on function public.pursue_cim_reconcile_transmission_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_reconcile_transmission_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_withdraw_live_authorization_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_actor text;
  v_reason text;
  v_now timestamptz;
  v_authorization public.deal_hunter_cim_live_provider_authorizations%rowtype;
begin
  v_id := public.pursue_cim_required_text_v1(p_command, 'id', 240);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_reason := public.pursue_cim_required_text_v1(p_command, 'reason', 160);
  if p_command ->> 'now' is null then
    raise exception 'Invalid Pursue CIM authorization withdrawal';
  end if;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
    where id = v_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'authorization', null);
  end if;
  if v_authorization.withdrawn_at is not null then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', true,
      'conflict', false, 'authorization', pg_catalog.to_jsonb(v_authorization));
  end if;
  if v_authorization.consumed_at is not null or v_authorization.expires_at <= v_now
    or not public.pursue_cim_cancel_prepared_transmission_v1(
      v_authorization.transmission_id, v_now, v_reason, v_actor, false)
  then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'authorization', pg_catalog.to_jsonb(v_authorization));
  end if;
  select * into v_authorization from public.deal_hunter_cim_live_provider_authorizations
    where id = v_id;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'authorization', pg_catalog.to_jsonb(v_authorization));
end;
$$;

revoke all on function public.pursue_cim_withdraw_live_authorization_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_withdraw_live_authorization_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_append_terminal_event_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id text;
  v_scope text;
  v_scope_id text;
  v_expected_revision bigint;
  v_expected_row bigint;
  v_next_state text;
  v_reason text;
  v_evidence_type text;
  v_evidence_id text;
  v_metadata_digest text;
  v_actor text;
  v_source text;
  v_observed timestamptz;
  v_now timestamptz;
  v_existing public.deal_hunter_cim_terminal_events%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_current_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_conversation public.deal_hunter_broker_conversations%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_member record;
  v_campaign_id text;
  v_campaign_ids text[];
  v_cancelled text[] := array[]::text[];
  v_campaign_event_id text;
  v_campaign_next text;
  v_legal boolean := false;
  v_replay boolean;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array[]::text[], array[]::text[], array['reconciliationEvidenceId']);
  if p_command ? 'preProviderResolution'
    and pg_catalog.jsonb_typeof(p_command -> 'preProviderResolution')
      not in ('boolean','null') then
    raise exception 'Invalid Pursue CIM pre-provider resolution flag';
  end if;
  v_event_id := public.pursue_cim_required_text_v1(p_command, 'eventId', 240);
  v_scope := public.pursue_cim_required_text_v1(p_command, 'scope', 20);
  v_scope_id := public.pursue_cim_required_text_v1(p_command, 'scopeId', 240);
  v_expected_revision := public.pursue_cim_required_revision_v1(p_command, 'expectedRevision');
  v_expected_row := public.pursue_cim_required_revision_v1(p_command, 'expectedRowVersion');
  v_next_state := public.pursue_cim_required_text_v1(p_command, 'nextState', 120);
  v_reason := public.pursue_cim_required_text_v1(p_command, 'reasonCode', 160);
  v_evidence_type := public.pursue_cim_required_text_v1(p_command, 'evidenceType', 120);
  v_evidence_id := public.pursue_cim_required_text_v1(p_command, 'evidenceId', 240);
  v_metadata_digest := public.pursue_cim_required_text_v1(p_command, 'metadataDigest', 64);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  v_source := public.pursue_cim_required_text_v1(p_command, 'source', 120);
  if v_scope not in ('campaign','conversation')
    or v_metadata_digest !~ '^[0-9a-f]{64}$'
    or p_command ->> 'observedAt' is null or p_command ->> 'now' is null then
    raise exception 'Invalid Pursue CIM terminal command';
  end if;
  v_observed := public.pursue_cim_required_instant_v1(p_command, 'observedAt');
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pursue-cim:terminal-id:' || v_event_id, 0));
  select * into v_existing from public.deal_hunter_cim_terminal_events
    where id = v_event_id;
  if found then
    v_replay := v_existing.scope = v_scope and v_existing.scope_id = v_scope_id
      and v_existing.reason_code = v_reason
      and v_existing.evidence_type = v_evidence_type
      and v_existing.evidence_id = v_evidence_id
      and v_existing.metadata_digest = v_metadata_digest;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', v_replay,
      'conflict', not v_replay,
      'campaignRevision', case when v_scope = 'campaign' then v_existing.revision else null end,
      'conversationRevision', case when v_scope = 'conversation' then v_existing.revision else null end,
      'cancelledTouchIds', '[]'::jsonb);
  end if;
  if v_scope = 'campaign' then
    select * into v_current_campaign from public.deal_hunter_cim_campaigns
      where id = v_scope_id for update;
    v_legal := case v_current_campaign.state
      when 'queued' then v_next_state in
        ('waiting-on-eligibility','initial-pending','action-required','stopped')
      when 'waiting-on-eligibility' then v_next_state in
        ('queued','initial-pending','action-required','stopped')
      when 'initial-pending' then v_next_state in
        ('active-follow-up','action-required','responded','materials-received',
         'stopped','provider-ambiguous')
      when 'active-follow-up' then v_next_state in
        ('active-follow-up','action-required','responded','materials-received',
         'stopped','expired','provider-ambiguous')
      when 'action-required' then v_next_state in
        ('queued','waiting-on-eligibility','initial-pending','responded',
         'materials-received','stopped')
      else false end;
    if v_current_campaign.id is null
      or v_current_campaign.terminal_revision <> v_expected_revision
      or v_current_campaign.row_version <> v_expected_row
      or not coalesce(v_legal,false)
      or (v_current_campaign.state = 'provider-ambiguous'
        and p_command ->> 'reconciliationEvidenceId' is null)
      or (v_current_campaign.state = 'action-required'
        and v_next_state in ('queued','waiting-on-eligibility','initial-pending')
        and coalesce((p_command ->> 'preProviderResolution')::boolean,false) = false)
    then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true,
        'campaignRevision', v_current_campaign.terminal_revision,
        'conversationRevision', null, 'cancelledTouchIds', '[]'::jsonb);
    end if;
    v_campaign_ids := array[v_scope_id];
  else
    select * into v_conversation from public.deal_hunter_broker_conversations
      where id = v_scope_id for update;
    v_legal := case v_conversation.state
      when 'open' then v_next_state in
        ('reply-review-required','responded','stopped','provider-ambiguous','closed')
      when 'reply-review-required' then v_next_state in ('responded','stopped','open')
      else false end;
    if v_conversation.id is null
      or v_conversation.terminal_revision <> v_expected_revision
      or v_conversation.row_version <> v_expected_row
      or not coalesce(v_legal,false)
      or (v_conversation.state = 'provider-ambiguous'
        and p_command ->> 'reconciliationEvidenceId' is null)
    then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'campaignRevision', null,
        'conversationRevision', v_conversation.terminal_revision,
        'cancelledTouchIds', '[]'::jsonb);
    end if;
    select coalesce(pg_catalog.array_agg(id order by id), array[]::text[])
      into v_campaign_ids from public.deal_hunter_cim_campaigns
      where conversation_id = v_scope_id
        and state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous');
  end if;
  foreach v_campaign_id in array v_campaign_ids loop
    select * into v_campaign from public.deal_hunter_cim_campaigns
      where id = v_campaign_id for update;
    for v_transmission in
      select tr.* from public.deal_hunter_cim_transmissions as tr
      where tr.id in (
        select m.transmission_id from public.deal_hunter_cim_transmission_touches as m
        where m.campaign_id = v_campaign_id and m.cancelled_at is null)
        and tr.state in ('prepared','final-gate-blocked')
      order by tr.id for update
    loop
      if public.pursue_cim_cancel_prepared_transmission_v1(
        v_transmission.id, v_now, v_reason, v_actor, false) then
        for v_member in
          select touch_id from public.deal_hunter_cim_transmission_touches
            where transmission_id = v_transmission.id and cancelled_at = v_now
            order by touch_id
        loop
          v_cancelled := pg_catalog.array_append(v_cancelled, v_member.touch_id);
        end loop;
      end if;
    end loop;
    for v_touch in
      select * from public.deal_hunter_cim_campaign_touches
      where campaign_id = v_campaign_id and state in ('scheduled','claimed')
        and transmission_id is null order by id for update
    loop
      update public.deal_hunter_cim_campaign_touches
        set state = 'cancelled-before-provider', terminal_reason = v_reason,
          updated_at = v_now, row_version = row_version + 1
        where id = v_touch.id and row_version = v_touch.row_version;
      if not found then raise exception 'Concurrent Pursue CIM touch terminalization'; end if;
      v_cancelled := pg_catalog.array_append(v_cancelled, v_touch.id);
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, touch_id, prior_state,
         next_state, reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('touch-cancelled'::text),
          pg_catalog.to_jsonb(v_touch.id || ':' || (v_touch.row_version + 1)::text)),
        'touch-cancelled', v_touch.opportunity_id, v_campaign_id, v_touch.id,
        v_touch.state, 'cancelled-before-provider', v_reason, v_actor,
        v_source, v_now, '{}'::jsonb);
    end loop;
    if v_scope = 'conversation' then
      v_campaign_next := case v_next_state
        when 'responded' then 'responded'
        when 'reply-review-required' then 'action-required'
        when 'provider-ambiguous' then 'provider-ambiguous'
        else 'stopped' end;
      v_legal := case v_campaign.state
        when 'queued' then v_campaign_next in
          ('waiting-on-eligibility','initial-pending','action-required','stopped')
        when 'waiting-on-eligibility' then v_campaign_next in
          ('queued','initial-pending','action-required','stopped')
        when 'initial-pending' then v_campaign_next in
          ('active-follow-up','action-required','responded','materials-received',
           'stopped','provider-ambiguous')
        when 'active-follow-up' then v_campaign_next in
          ('active-follow-up','action-required','responded','materials-received',
           'stopped','expired','provider-ambiguous')
        when 'action-required' then v_campaign_next in
          ('queued','waiting-on-eligibility','initial-pending','responded',
           'materials-received','stopped')
        else false end;
      if not coalesce(v_legal,false) then
        v_campaign_next := case v_campaign.state
          when 'queued' then 'action-required'
          when 'waiting-on-eligibility' then 'action-required'
          when 'initial-pending' then 'action-required'
          when 'active-follow-up' then 'action-required'
          else v_campaign.state end;
      end if;
      update public.deal_hunter_cim_campaigns
        set state = v_campaign_next, reason_code = v_reason,
          terminal_revision = terminal_revision + 1, row_version = row_version + 1,
          updated_at = v_now
        where id = v_campaign_id and row_version = v_campaign.row_version
          and terminal_revision = v_campaign.terminal_revision;
      if not found then raise exception 'Concurrent Pursue CIM campaign terminalization'; end if;
      v_campaign_event_id := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('conversation-campaign-terminal:v1'::text),
        pg_catalog.to_jsonb(v_event_id), pg_catalog.to_jsonb(v_campaign_id));
      insert into public.deal_hunter_cim_terminal_events
        (id, scope, scope_id, campaign_id, revision, reason_code,
         evidence_type, evidence_id, observed_at, actor, source,
         metadata_digest, created_at)
      values (v_campaign_event_id, 'campaign', v_campaign_id, v_campaign_id,
        v_campaign.terminal_revision + 1, v_reason, v_evidence_type,
        v_evidence_id, v_observed, v_actor, v_source, v_metadata_digest, v_now);
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, conversation_id,
         prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('terminal-transition'::text),
          pg_catalog.to_jsonb(v_campaign_event_id)),
        'terminal-transition', v_campaign.opportunity_id, v_campaign_id,
        v_scope_id, v_campaign.state, v_campaign_next, v_reason, v_actor,
        v_source, v_now, '{}'::jsonb);
    end if;
  end loop;
  if v_scope = 'campaign' then
    update public.deal_hunter_cim_campaigns
      set state = v_next_state, reason_code = v_reason,
        terminal_revision = terminal_revision + 1, row_version = row_version + 1,
        updated_at = v_now
      where id = v_scope_id and terminal_revision = v_expected_revision
        and row_version = v_expected_row;
    if not found then raise exception 'Concurrent Pursue CIM campaign terminalization'; end if;
  else
    update public.deal_hunter_broker_conversations
      set state = v_next_state, terminal_revision = terminal_revision + 1,
        row_version = row_version + 1, updated_at = v_now
      where id = v_scope_id and terminal_revision = v_expected_revision
        and row_version = v_expected_row;
    if not found then raise exception 'Concurrent Pursue CIM conversation terminalization'; end if;
  end if;
  insert into public.deal_hunter_cim_terminal_events
    (id, scope, scope_id, campaign_id, conversation_id, revision, reason_code,
     evidence_type, evidence_id, observed_at, actor, source, metadata_digest, created_at)
  values (v_event_id, v_scope, v_scope_id,
    case when v_scope = 'campaign' then v_scope_id else null end,
    case when v_scope = 'conversation' then v_scope_id else null end,
    v_expected_revision + 1, v_reason, v_evidence_type, v_evidence_id,
    v_observed, v_actor, v_source, v_metadata_digest, v_now);
  insert into public.deal_hunter_cim_audit_events
    (id, event_type, opportunity_id, campaign_id, conversation_id,
     prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
  values (public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('cim-audit:v1'::text),
      pg_catalog.to_jsonb('terminal-transition'::text),
      pg_catalog.to_jsonb(v_event_id)),
    'terminal-transition',
    case when v_scope = 'campaign' then v_current_campaign.opportunity_id else null end,
    case when v_scope = 'campaign' then v_scope_id else null end,
    case when v_scope = 'conversation' then v_scope_id else null end,
    case when v_scope = 'campaign' then v_current_campaign.state else v_conversation.state end,
    v_next_state, v_reason, v_actor, v_source, v_now, '{}'::jsonb);
  select coalesce(pg_catalog.array_agg(value order by value), array[]::text[])
    into v_cancelled from pg_catalog.unnest(v_cancelled) as value;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false,
    'campaignRevision', case when v_scope = 'campaign' then v_expected_revision + 1 else null end,
    'conversationRevision', case when v_scope = 'conversation' then v_expected_revision + 1 else null end,
    'cancelledTouchIds', pg_catalog.to_jsonb(v_cancelled));
end;
$$;

revoke all on function public.pursue_cim_append_terminal_event_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_append_terminal_event_v1(jsonb)
  to service_role;

create or replace function public.pursue_cim_consume_safety_events_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id text;
  v_limit integer;
  v_actor text;
  v_now timestamptz;
  v_event public.deal_hunter_cim_safety_events%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_disposition text;
  v_next_state text;
  v_terminal_id text;
  v_counts record;
begin
  v_run_id := public.pursue_cim_required_text_v1(p_command, 'safetyRunId', 240);
  v_actor := public.pursue_cim_required_text_v1(p_command, 'actor', 200);
  if p_command ->> 'limit' !~ '^[0-9]+$'
    or (p_command ->> 'limit')::numeric not between 1 and 1000
    or p_command ->> 'now' is null then
    raise exception 'Invalid Pursue CIM safety consumption command';
  end if;
  v_limit := (p_command ->> 'limit')::integer;
  v_now := public.pursue_cim_required_instant_v1(p_command, 'now');
  for v_event in
    select * from public.deal_hunter_cim_safety_events
      where safety_run_id = v_run_id and status = 'pending'
      order by created_at, id limit v_limit for update
  loop
    select * into v_campaign from public.deal_hunter_cim_campaigns
      where opportunity_id = v_event.opportunity_id
        and state in ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')
      for update;
    if found then
      v_disposition := p_command -> 'outcomes' ->> v_event.id;
      if v_disposition not in ('stopped','review-required')
        or public.pursue_cim_current_activation_v1('fl04a-safety', v_now) is null then
        continue;
      end if;
      v_next_state := case when v_disposition = 'stopped'
        then 'stopped' else 'action-required' end;
      if not (case v_campaign.state
        when 'queued' then v_next_state in ('waiting-on-eligibility','initial-pending',
          'action-required','stopped')
        when 'waiting-on-eligibility' then v_next_state in ('queued','initial-pending',
          'action-required','stopped')
        when 'initial-pending' then v_next_state in ('active-follow-up','action-required',
          'responded','materials-received','stopped','provider-ambiguous')
        when 'active-follow-up' then v_next_state in ('active-follow-up','action-required',
          'responded','materials-received','stopped','expired','provider-ambiguous')
        when 'action-required' then v_next_state in ('queued','waiting-on-eligibility',
          'initial-pending','responded','materials-received','stopped')
        else false end) then
        continue;
      end if;
      v_terminal_id := public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-terminal:safety:v1'::text),
        pg_catalog.to_jsonb(v_event.id), pg_catalog.to_jsonb(v_campaign.id));
      for v_transmission in
        select tr.* from public.deal_hunter_cim_transmissions as tr
        where tr.id in (
          select m.transmission_id from public.deal_hunter_cim_transmission_touches as m
            where m.campaign_id = v_campaign.id and m.cancelled_at is null)
          and tr.state in ('prepared','final-gate-blocked')
        order by tr.id for update
      loop
        perform public.pursue_cim_cancel_prepared_transmission_v1(
          v_transmission.id, v_now, v_event.event_type, v_actor, false);
      end loop;
      for v_touch in
        select * from public.deal_hunter_cim_campaign_touches
          where campaign_id = v_campaign.id and state in ('scheduled','claimed')
            and transmission_id is null order by id for update
      loop
        update public.deal_hunter_cim_campaign_touches
          set state = 'cancelled-before-provider',
            terminal_reason = v_event.event_type, updated_at = v_now,
            row_version = row_version + 1
          where id = v_touch.id and row_version = v_touch.row_version;
        if not found then
          raise exception 'Concurrent Pursue CIM safety touch cancellation';
        end if;
        insert into public.deal_hunter_cim_audit_events
          (id, event_type, opportunity_id, campaign_id, touch_id,
           prior_state, next_state, reason_code, actor, source, occurred_at, metadata)
        values (public.pursue_cim_digest_v1(
            pg_catalog.to_jsonb('cim-audit:v1'::text),
            pg_catalog.to_jsonb('touch-cancelled'::text),
            pg_catalog.to_jsonb(v_touch.id || ':' || (v_touch.row_version + 1)::text)),
          'touch-cancelled', v_event.opportunity_id, v_campaign.id, v_touch.id,
          v_touch.state, 'cancelled-before-provider', v_event.event_type,
          v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
      end loop;
      update public.deal_hunter_cim_campaigns
        set state = v_next_state, reason_code = v_event.event_type,
          terminal_revision = terminal_revision + 1, row_version = row_version + 1,
          updated_at = v_now
        where id = v_campaign.id and row_version = v_campaign.row_version
          and terminal_revision = v_campaign.terminal_revision;
      if not found then raise exception 'Concurrent Pursue CIM safety campaign transition'; end if;
      insert into public.deal_hunter_cim_terminal_events
        (id, scope, scope_id, campaign_id, revision, reason_code,
         evidence_type, evidence_id, observed_at, actor, source,
         metadata_digest, created_at)
      values (v_terminal_id, 'campaign', v_campaign.id, v_campaign.id,
        v_campaign.terminal_revision + 1, v_event.event_type,
        'safety-event', v_event.id, v_now, v_actor, 'safety-consumer',
        public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('safety-terminal:v1'::text),
          pg_catalog.to_jsonb(v_event.id)), v_now);
      update public.deal_hunter_cim_safety_events
        set status = v_disposition, outcome_evidence_id = v_terminal_id,
          outcome_revision = v_campaign.terminal_revision + 1,
          consumed_at = v_now, updated_at = v_now
        where id = v_event.id and status = 'pending';
      if not found then raise exception 'Concurrent Pursue CIM safety consumption'; end if;
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
         reason_code, actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('terminal-transition'::text),
          pg_catalog.to_jsonb(v_terminal_id)),
        'terminal-transition', v_event.opportunity_id, v_campaign.id,
        v_campaign.state, v_next_state, v_event.event_type,
        v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
      insert into public.deal_hunter_cim_audit_events
        (id, event_type, opportunity_id, campaign_id, prior_state, next_state,
         actor, source, occurred_at, metadata)
      values (public.pursue_cim_digest_v1(
          pg_catalog.to_jsonb('cim-audit:v1'::text),
          pg_catalog.to_jsonb('safety-consumed'::text),
          pg_catalog.to_jsonb(v_event.id)),
        'safety-consumed', v_event.opportunity_id, v_campaign.id,
        'pending', v_disposition, v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
      continue;
    end if;
    update public.deal_hunter_cim_safety_events
      set status = 'no-op', outcome_evidence_id = v_event.id,
        consumed_at = v_now, updated_at = v_now
      where id = v_event.id and status = 'pending';
    if not found then raise exception 'Concurrent Pursue CIM safety no-op'; end if;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, prior_state, next_state,
       actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('safety-consumed'::text),
        pg_catalog.to_jsonb(v_event.id)),
      'safety-consumed', v_event.opportunity_id, 'pending', 'no-op',
      v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  end loop;
  select count(*) filter (where status = 'stopped') as stopped,
    count(*) filter (where status = 'review-required') as review_required,
    count(*) filter (where status = 'no-op') as no_op,
    count(*) filter (where status = 'pending') as pending
    into v_counts from public.deal_hunter_cim_safety_events
    where safety_run_id = v_run_id;
  return pg_catalog.jsonb_build_object('stopped', v_counts.stopped,
    'reviewRequired', v_counts.review_required, 'noOp', v_counts.no_op,
    'pending', v_counts.pending);
end;
$$;

revoke all on function public.pursue_cim_consume_safety_events_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_consume_safety_events_v1(jsonb)
  to service_role;

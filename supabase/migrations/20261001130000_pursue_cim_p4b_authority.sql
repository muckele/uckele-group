-- Package 4B: canonical primary CRM ownership revisions.
alter table public.deal_hunter_opportunities
  add column if not exists campaign_authority_revision bigint not null default 1
    check (campaign_authority_revision > 0);

create table if not exists public.deal_hunter_crm_ownership_revisions (
  opportunity_id text not null references public.deal_hunter_opportunities(opportunity_id) on delete cascade,
  revision bigint not null check (revision > 0),
  submission_id text,
  created_at timestamptz not null default now(),
  primary key (opportunity_id, revision)
);
insert into public.deal_hunter_crm_ownership_revisions
  (opportunity_id, revision, submission_id)
select opportunity_id, 1, primary_submission_id
from public.deal_hunter_opportunities as opportunity
where not exists (select 1 from public.deal_hunter_crm_ownership_revisions as revision
  where revision.opportunity_id = opportunity.opportunity_id);
alter table public.deal_hunter_crm_ownership_revisions enable row level security;
revoke all on table public.deal_hunter_crm_ownership_revisions from public, anon, authenticated;
grant select on table public.deal_hunter_crm_ownership_revisions to service_role;

create or replace function public.pursue_cim_append_crm_ownership_revision_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision bigint;
begin
  if TG_OP = 'INSERT' then
    v_revision := 1;
  elsif old.primary_submission_id is distinct from new.primary_submission_id then
    select coalesce(pg_catalog.max(revision), 0) + 1 into v_revision
    from public.deal_hunter_crm_ownership_revisions
    where opportunity_id = new.opportunity_id;
  else
    return new;
  end if;
  insert into public.deal_hunter_crm_ownership_revisions
    (opportunity_id, revision, submission_id)
  values (new.opportunity_id, v_revision, new.primary_submission_id);
  return new;
end;
$$;
create trigger trg_cim_crm_revision_opportunity_insert
  after insert on public.deal_hunter_opportunities
  for each row execute function public.pursue_cim_append_crm_ownership_revision_v1();
create trigger trg_cim_crm_revision_opportunity_update
  after update of primary_submission_id on public.deal_hunter_opportunities
  for each row execute function public.pursue_cim_append_crm_ownership_revision_v1();
revoke all on function public.pursue_cim_append_crm_ownership_revision_v1()
  from public, anon, authenticated;

create or replace function public.pursue_cim_bump_campaign_authority_revision_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
  v_new text;
begin
  if TG_OP <> 'INSERT' then v_old := old.opportunity_id; end if;
  if TG_OP <> 'DELETE' then v_new := new.opportunity_id; end if;
  if TG_OP = 'UPDATE' then
    if TG_TABLE_NAME = 'deal_hunter_opportunity_source_observations' then
      if old.opportunity_id is not distinct from new.opportunity_id
        and old.source_id is not distinct from new.source_id
        and old.source_record_id is not distinct from new.source_record_id
        and old.field is not distinct from new.field
        and old.value is not distinct from new.value
        and old.accepted_at is not distinct from new.accepted_at
        and old.accepted_run_id is not distinct from new.accepted_run_id then return new; end if;
    end if;
  end if;
  update public.deal_hunter_opportunities
    set campaign_authority_revision = campaign_authority_revision + 1
    where opportunity_id in (v_old, v_new);
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_cim_campaign_revision_source on public.deal_hunter_opportunity_source_observations;
create trigger trg_cim_campaign_revision_source
after insert or update or delete on public.deal_hunter_opportunity_source_observations
for each row execute function public.pursue_cim_bump_campaign_authority_revision_v1();
drop trigger if exists trg_cim_campaign_revision_fact on public.deal_hunter_opportunity_facts;
create trigger trg_cim_campaign_revision_fact
after insert or update or delete on public.deal_hunter_opportunity_facts
for each row execute function public.pursue_cim_bump_campaign_authority_revision_v1();
drop trigger if exists trg_cim_campaign_revision_alias on public.deal_hunter_opportunity_aliases;
create trigger trg_cim_campaign_revision_alias
after insert or update or delete on public.deal_hunter_opportunity_aliases
for each row execute function public.pursue_cim_bump_campaign_authority_revision_v1();
revoke all on function public.pursue_cim_bump_campaign_authority_revision_v1()
  from public, anon, authenticated;

create table if not exists public.deal_hunter_cim_global_authority (
  id text primary key check (id = 'global'),
  revision bigint not null check (revision > 0)
);
insert into public.deal_hunter_cim_global_authority (id, revision)
values ('global', 1) on conflict (id) do nothing;
alter table public.deal_hunter_cim_global_authority enable row level security;
revoke all on table public.deal_hunter_cim_global_authority from public, anon, authenticated;
grant select on table public.deal_hunter_cim_global_authority to service_role;

create or replace function public.pursue_cim_bump_global_authority_revision_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'UPDATE' then
    if TG_TABLE_NAME = 'deal_hunter_source_freshness_state' then
      if old.accepted_generation is not distinct from new.accepted_generation
        and old.accepted_run_id is not distinct from new.accepted_run_id
        and old.accepted_digest is not distinct from new.accepted_digest
        and old.projection_state is not distinct from new.projection_state then return new; end if;
    end if;
    if TG_TABLE_NAME = 'deal_hunter_identity_exceptions' then
      if old.status is not distinct from new.status
        and old.candidate_opportunity_ids is not distinct from new.candidate_opportunity_ids then return new; end if;
    end if;
  end if;
  update public.deal_hunter_cim_global_authority
    set revision = revision + 1 where id = 'global';
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_cim_global_revision_source on public.deal_hunter_source_freshness_state;
create trigger trg_cim_global_revision_source
after insert or update or delete on public.deal_hunter_source_freshness_state
for each row execute function public.pursue_cim_bump_global_authority_revision_v1();
drop trigger if exists trg_cim_global_revision_identity on public.deal_hunter_identity_exceptions;
create trigger trg_cim_global_revision_identity
after insert or update or delete on public.deal_hunter_identity_exceptions
for each row execute function public.pursue_cim_bump_global_authority_revision_v1();
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'email_suppressions', 'secure_documents', 'secure_upload_requests',
    'crm_communications', 'deal_hunter_cim_requests', 'deal_hunter_cim_opportunity_claims'
  ] loop
    execute pg_catalog.format('drop trigger if exists %I on public.%I',
      'trg_cim_global_revision_' || v_table, v_table);
    execute pg_catalog.format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.pursue_cim_bump_global_authority_revision_v1()',
      'trg_cim_global_revision_' || v_table, v_table);
  end loop;
end;
$$;
revoke all on function public.pursue_cim_bump_global_authority_revision_v1()
  from public, anon, authenticated;

-- The wrapper holds the same opportunity row lock as the v1 allocator while
-- comparing the server-owned revision before any conversation or campaign write.
create or replace function public.pursue_cim_crm_match_fingerprint_v1()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submissions jsonb;
  v_supersessions jsonb;
begin
  if (select count(*) from public.contact_submissions) > 5000
    or (select count(*) from public.crm_submission_supersessions where status = 'active') > 5000 then
    return null;
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(contact) order by contact.id), '[]'::jsonb)
    into v_submissions from public.contact_submissions as contact;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(relation) order by relation.id), '[]'::jsonb)
    into v_supersessions from public.crm_submission_supersessions as relation
    where relation.status = 'active';
  return pg_catalog.md5(v_submissions::text || ':' || v_supersessions::text);
end;
$$;
revoke all on function public.pursue_cim_crm_match_fingerprint_v1()
  from public, anon, authenticated;
grant execute on function public.pursue_cim_crm_match_fingerprint_v1()
  to service_role;

create or replace function public.pursue_cim_materialize_campaign_v2(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_activation public.deal_hunter_cim_capability_activations%rowtype;
  v_activation_id text;
  v_expected bigint;
  v_campaign_expected bigint;
  v_global_expected bigint;
  v_global bigint;
  v_ownership public.deal_hunter_crm_ownership_revisions%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
  v_crm_match_fingerprint text;
begin
  v_expected := public.pursue_cim_required_revision_v1(p_command, 'crmOwnershipRevision');
  v_campaign_expected := public.pursue_cim_required_revision_v1(p_command, 'campaignAuthorityRevision');
  v_global_expected := public.pursue_cim_required_revision_v1(p_command, 'globalAuthorityRevision');
  lock table public.contact_submissions, public.crm_submission_supersessions in share mode;
  v_crm_match_fingerprint := public.pursue_cim_crm_match_fingerprint_v1();
  select * into v_opportunity from public.deal_hunter_opportunities
    where opportunity_id = p_command ->> 'opportunityId' for update;
  select * into v_ownership from public.deal_hunter_crm_ownership_revisions
    where opportunity_id = v_opportunity.opportunity_id
    order by revision desc limit 1;
  select * into v_score from public.deal_hunter_opportunity_scores
    where opportunity_id = v_opportunity.opportunity_id for share;
  select revision into v_global from public.deal_hunter_cim_global_authority
    where id = 'global' for share;
  v_activation_id := public.pursue_cim_current_activation_v1('fl04b-enrollment',
    public.pursue_cim_required_instant_v1(p_command, 'now'));
  if v_activation_id is not null then
    select * into v_activation from public.deal_hunter_cim_capability_activations
      where id = v_activation_id for share;
  end if;
  if v_opportunity.opportunity_id is null
    or v_expected is distinct from v_ownership.revision
    or v_ownership.submission_id is distinct from (p_command ->> 'crmSubmissionId')
    or v_score.opportunity_id is null
    or v_score.operator_priority <> 'high'
    or v_score.reviewed_at is null
    or v_score.current_triage_eligible is distinct from true
    or v_score.should_remove is distinct from false
    or (case when coalesce(v_score.reviewed_semantic_digest, '') <> ''
      then v_score.reviewed_semantic_digest is distinct from v_score.semantic_digest
      else coalesce(v_score.reviewed_fingerprint, '') <> ''
        and v_score.reviewed_fingerprint is distinct from v_score.score_fingerprint end)
    or v_crm_match_fingerprint is null
    or v_crm_match_fingerprint is distinct from (p_command ->> 'crmMatchAuthorityFingerprint')
    or not (p_command ? 'crmBrokerEmail')
    or not exists (select 1 from public.contact_submissions as contact
      where contact.id = v_opportunity.primary_submission_id
        and contact.status not in ('archived', 'spam')
        and contact.archived_at is null
        and contact.deal_hunter_opportunity_id = v_opportunity.opportunity_id
        and contact.broker_email is not distinct from (p_command ->> 'crmBrokerEmail')
        and (contact.metadata -> 'dealHunter' ->> 'opportunityId' is null
          or contact.metadata -> 'dealHunter' ->> 'opportunityId' = v_opportunity.opportunity_id))
    or exists (select 1 from public.crm_submission_supersessions as relation
      where relation.superseded_submission_id = v_opportunity.primary_submission_id
        and relation.status = 'active')
    or v_campaign_expected <> v_opportunity.campaign_authority_revision
    or v_global is distinct from v_global_expected
    or exists (select 1 from public.deal_hunter_source_freshness_state
      where projection_state in ('pending', 'deferred', 'superseded'))
    or exists (select 1 from public.deal_hunter_identity_exceptions
      where status = 'open')
    or exists (select 1 from public.deal_hunter_cim_requests as request
      where request.opportunity_id = v_opportunity.opportunity_id
        or request.deal_key in (select score.deal_key
          from public.deal_hunter_opportunity_scores as score
          where score.opportunity_id = v_opportunity.opportunity_id))
    or exists (select 1 from public.deal_hunter_cim_opportunity_claims
      where opportunity_id = v_opportunity.opportunity_id)
    or exists (select 1 from public.email_suppressions
      where normalized_email = pg_catalog.lower(p_command ->> 'recipientAddress')
        and lifted_at is null)
    or exists (select 1 from public.contact_submissions
      where id = v_opportunity.primary_submission_id and prospectus_url is not null
        and pg_catalog.btrim(prospectus_url) <> '')
    or exists (select 1 from public.secure_documents
      where submission_id = v_opportunity.primary_submission_id)
    or exists (select 1 from public.secure_upload_requests
      where submission_id = v_opportunity.primary_submission_id
        and status in ('completed', 'documents-received'))
    or exists (select 1 from public.crm_communications
      where submission_id = v_opportunity.primary_submission_id and direction = 'inbound')
    or v_activation.id is null
    or v_activation.id <> (p_command ->> 'permissionVersion')
    or v_activation.permission_basis_digest is distinct from (p_command ->> 'permissionDigest')
    or v_activation.permission_revision is distinct from
      public.pursue_cim_required_revision_v1(p_command, 'permissionRevision')
    or v_activation.cohort_digest is distinct from (p_command ->> 'permissionScope')
    or v_activation.policy_hash is distinct from (p_command ->> 'policyHash') then
    return pg_catalog.jsonb_build_object('applied', false, 'existing', false,
      'actionRequired', true, 'campaign', null, 'initialTouch', null);
  end if;
  return public.pursue_cim_materialize_campaign_v1(p_command);
end;
$$;
revoke all on function public.pursue_cim_materialize_campaign_v2(jsonb)
  from public, anon, authenticated;
grant execute on function public.pursue_cim_materialize_campaign_v2(jsonb)
  to service_role;

-- Package 4B: retry an action-required Pursue with a new immutable choice.
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
  v_note text := coalesce(p_command ->> 'note', '');
  v_submission_id text := coalesce(p_command ->> 'submissionId', '');
  v_now timestamptz;
  v_discovery bigint;
  v_material bigint;
  v_request_digest text;
  v_decision_id text;
  v_enrollment_id text;
  v_existing public.deal_hunter_owner_decision_events%rowtype;
  v_decision public.deal_hunter_owner_decision_events%rowtype;
  v_enrollment public.deal_hunter_pursuit_enrollments%rowtype;
  v_retry_choice boolean := false;
  v_opportunity public.deal_hunter_opportunities%rowtype;
  v_score public.deal_hunter_opportunity_scores%rowtype;
  v_campaign public.deal_hunter_cim_campaigns%rowtype;
  v_touch public.deal_hunter_cim_campaign_touches%rowtype;
  v_transmission public.deal_hunter_cim_transmissions%rowtype;
  v_terminal_id text;
  v_disposition_hash text;
  v_disposition_id uuid;
  v_archive_id uuid;
  v_triage_id uuid;
  v_pass_result jsonb;
begin
  perform public.pursue_cim_assert_types_v1(p_command,
    array['opportunityId','action','idempotencyKey','actor','policyVersion','now'],
    array['expectedDiscoveryRevision','expectedMaterialRevision'],
    array['selectedContactReferenceDigest','reason','note','submissionId']);
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
    or pg_catalog.length(v_note) > 2000
    or pg_catalog.length(v_submission_id) > 120
    or pg_catalog.btrim(v_submission_id) <> v_submission_id
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
  if v_action <> 'pass' then
    v_reason := null;
    v_note := '';
    v_submission_id := '';
  end if;
  v_request_digest := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision-request:v1'::text),
    pg_catalog.to_jsonb(v_action), pg_catalog.to_jsonb(v_opportunity_id),
    pg_catalog.to_jsonb(v_discovery), pg_catalog.to_jsonb(v_material),
    coalesce(pg_catalog.to_jsonb(v_contact_digest), 'null'::jsonb),
    pg_catalog.to_jsonb(v_actor), pg_catalog.to_jsonb(v_policy),
    coalesce(pg_catalog.to_jsonb(v_reason), 'null'::jsonb),
    pg_catalog.to_jsonb(v_note), pg_catalog.to_jsonb(v_submission_id),
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
      'conflict', true, 'reason', 'stale_revision', 'decision', null, 'enrollment', null);
  end if;
  select * into v_score from public.deal_hunter_opportunity_scores
    where opportunity_id = v_opportunity_id and current_triage_eligible = true
      and should_remove = false for update;
  if v_action <> 'pursue' then
    if v_score.opportunity_id is null or (v_action = 'pass' and v_score.deal_key is null) then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'decision', null, 'enrollment', null);
    end if;
  end if;
  if v_score.deal_key is not null and exists (
    select 1 from public.deal_hunter_dispositions
    where deal_key = v_score.deal_key and disposition = 'dismissed'
  ) then
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'conflict', true, 'reason', 'already-passed', 'decision', null, 'enrollment', null);
  end if;
  select * into v_enrollment from public.deal_hunter_pursuit_enrollments
    where opportunity_id = v_opportunity_id and state <> 'superseded' for update;
  if v_enrollment.id is not null and v_action = 'pursue' then
    select * into v_decision from public.deal_hunter_owner_decision_events
      where id = v_enrollment.decision_event_id;
    v_retry_choice := v_enrollment.state = 'action-required'
      or (v_enrollment.state in ('queued', 'waiting-on-eligibility')
        and v_contact_digest is not null
        and v_contact_digest is distinct from v_decision.selected_contact_reference_digest);
    if not v_retry_choice then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
        'enrollment', pg_catalog.to_jsonb(v_enrollment));
    end if;
  end if;
  v_decision_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('owner-decision:v1'::text), pg_catalog.to_jsonb(v_key));
  v_enrollment_id := public.pursue_cim_digest_v1(
    pg_catalog.to_jsonb('pursuit-enrollment:v1'::text), pg_catalog.to_jsonb(v_decision_id));
  if v_retry_choice then
    update public.deal_hunter_pursuit_enrollments
      set state = 'superseded', reason_code = 'pursue-retried',
        row_version = row_version + 1, updated_at = v_now
      where id = v_enrollment.id and state = v_enrollment.state;
    insert into public.deal_hunter_cim_audit_events
      (id, event_type, opportunity_id, prior_state, next_state,
       reason_code, actor, source, occurred_at, metadata)
    values (public.pursue_cim_digest_v1(
        pg_catalog.to_jsonb('cim-audit:v1'::text),
        pg_catalog.to_jsonb('enrollment-transition'::text),
        pg_catalog.to_jsonb(v_enrollment.id || ':' || (v_enrollment.row_version + 1)::text)),
      'enrollment-transition', v_opportunity_id, v_enrollment.state, 'superseded',
      'pursue-retried', v_actor, 'sqlite-transition', v_now, '{}'::jsonb);
  end if;
  if v_action = 'pass' then
    if v_submission_id <> '' then
      raise exception 'Explicit Pass submission context requires verified supersession authority';
    end if;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-disposition:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_disposition_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-archive:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_archive_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_disposition_hash := public.pursue_cim_digest_v1(
      pg_catalog.to_jsonb('owner-pass-triage:v1'::text), pg_catalog.to_jsonb(v_decision_id));
    v_triage_id := (pg_catalog.substr(v_disposition_hash,1,8) || '-' ||
      pg_catalog.substr(v_disposition_hash,9,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,13,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,17,4) || '-' ||
      pg_catalog.substr(v_disposition_hash,21,12))::uuid;
    v_pass_result := public.pass_deal_hunter_opportunity_freshness_v1(
      pg_catalog.jsonb_build_object('opportunity_id', v_opportunity_id,
        'reason', v_reason, 'note', v_note, 'actor', v_actor, 'occurred_at', v_now,
        'disposition_id', v_disposition_id, 'archive_activity_id', v_archive_id,
        'triage_activity_id', v_triage_id), v_discovery, v_material);
    if v_pass_result ->> 'applied' <> 'true' then
      return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
        'conflict', true, 'reason', v_pass_result ->> 'reason',
        'decision', null, 'enrollment', null);
    end if;
  end if;
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
    if v_action = 'watch' then
    update public.deal_hunter_opportunity_scores
      set operator_priority = case when v_action = 'watch' then 'watch' else operator_priority end,
        reviewed_at = v_now, reviewed_by = v_actor,
        reviewed_fingerprint = score_fingerprint,
        reviewed_semantic_digest = semantic_digest,
        reviewed_discovery_revision = v_discovery,
        reviewed_material_revision = v_material, operator_updated_at = v_now
      where opportunity_id = v_opportunity_id;
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
      'enrollment', null, 'passResult', v_pass_result);
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
  if v_score.opportunity_id is not null then
    update public.deal_hunter_opportunity_scores set operator_priority = 'high',
      reviewed_at = v_now, reviewed_by = v_actor,
      reviewed_fingerprint = score_fingerprint,
      reviewed_semantic_digest = semantic_digest,
      reviewed_discovery_revision = v_discovery,
      reviewed_material_revision = v_material, operator_updated_at = v_now
      where opportunity_id = v_opportunity_id;
  end if;
  return pg_catalog.jsonb_build_object('applied', true, 'replay', false,
    'conflict', false, 'decision', pg_catalog.to_jsonb(v_decision),
    'enrollment', pg_catalog.to_jsonb(v_enrollment));
end;
$$;

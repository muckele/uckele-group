-- Package 3: current canonical timezone revision guard.

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
  v_opportunity_status text;
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
  select status into v_opportunity_status from public.deal_hunter_opportunities
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
  if v_opportunity_status <> 'active' then
    select * into v_revision from public.deal_hunter_opportunity_timezone_revisions
      where opportunity_id = v_opportunity_id order by revision desc limit 1;
    return pg_catalog.jsonb_build_object('applied', false, 'replay', false,
      'staleRevision', true,
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

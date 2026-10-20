-- Exact reviewed Pass -> review only. No CRM creation or outreach authority.
create or replace function public.restore_current_unlinked_opportunity(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_op public.deal_hunter_opportunities;
  v_score public.deal_hunter_opportunity_scores;
  v_pass public.deal_hunter_dispositions;
  v_id text;
  v_keys text[];
  v_at timestamptz;
  v_pass_at timestamptz;
  v_conflict jsonb := '{"applied":false,"reason":"restore-authority-changed"}'::jsonb;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Current Restore requires read committed isolation' using errcode='25001';
  end if;
  if jsonb_typeof(p_input) is distinct from 'object'
    or not (p_input ?& array['opportunityId','expectedCampaignAuthorityRevision','passId','passUpdatedAt','actor','at'])
    or p_input - array['opportunityId','expectedCampaignAuthorityRevision','passId','passUpdatedAt','actor','at'] <> '{}'::jsonb
    or jsonb_typeof(p_input->'expectedCampaignAuthorityRevision') is distinct from 'number'
    or (p_input->>'expectedCampaignAuthorityRevision') !~ '^[1-9][0-9]{0,15}$'
    or (p_input->>'expectedCampaignAuthorityRevision')::numeric > 9007199254740991
    or exists(select 1 from jsonb_each(p_input) x where key in ('opportunityId','passId','actor')
      and (jsonb_typeof(value) is distinct from 'string' or char_length(value #>> '{}') not between 1 and 200
        or value #>> '{}' <> btrim(value #>> '{}')))
    or exists(select 1 from jsonb_each(p_input) x where key in ('passUpdatedAt','at')
      and (jsonb_typeof(value) is distinct from 'string' or char_length(value #>> '{}') not between 1 and 80)) then
    raise exception 'invalid current Restore payload' using errcode='22023';
  end if;
  begin
    if (p_input->>'passId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid Pass ID'; end if;
    v_at := (p_input->>'at')::timestamptz; v_pass_at := (p_input->>'passUpdatedAt')::timestamptz;
    if not isfinite(v_at) or not isfinite(v_pass_at) then raise exception 'Invalid Restore time'; end if;
  exception when others then raise exception 'invalid current Restore payload' using errcode='22023'; end;
  -- Same lock order/advisory family as existing CRM Restore, also covering the
  -- import/CIM identity evidence and alias-key Pass phantoms checked below.
  perform pg_catalog.pg_advisory_xact_lock(17499,48146);
  lock table public.contact_submissions, public.crm_submission_supersessions,
    public.deal_hunter_opportunities, public.deal_hunter_opportunity_aliases,
    public.deal_hunter_opportunity_scores, public.deal_hunter_dispositions,
    public.deal_hunter_crm_imports, public.deal_hunter_cim_requests in share row exclusive mode;
  v_id := p_input->>'opportunityId';
  select * into v_op from public.deal_hunter_opportunities where opportunity_id=v_id;
  if v_op.opportunity_id is null or v_op.status<>'active' or v_op.primary_submission_id is not null
    or v_op.campaign_authority_revision <> (p_input->>'expectedCampaignAuthorityRevision')::bigint then return v_conflict; end if;
  select * into v_score from public.deal_hunter_opportunity_scores where opportunity_id=v_id and current_triage_eligible;
  if v_score.deal_key is null or v_score.deal_key='' then return v_conflict; end if;
  select * into v_pass from public.deal_hunter_dispositions where id=(p_input->>'passId')::uuid;
  if v_pass.id is null or v_pass.deal_key is distinct from v_score.deal_key or v_pass.submission_id is not null
    or v_pass.disposition<>'dismissed' or v_pass.updated_at is distinct from v_pass_at then return v_conflict; end if;
  select array_agg(distinct deal_key) into v_keys from (select v_score.deal_key as deal_key
    union select alias_value from public.deal_hunter_opportunity_aliases where opportunity_id=v_id and alias_type='deal-key') owned_keys;
  if exists(select 1 from public.contact_submissions where deal_hunter_opportunity_id=v_id
      or metadata #>> '{dealHunter,opportunityId}'=v_id or metadata #>> '{dealHunter,dealKey}'=any(v_keys))
    or exists(select 1 from public.deal_hunter_opportunity_aliases where alias_type='deal-key' and alias_value=any(v_keys) and opportunity_id<>v_id)
    or exists(select 1 from public.deal_hunter_opportunity_scores where deal_key=any(v_keys) and opportunity_id<>v_id)
    or exists(select 1 from public.deal_hunter_crm_imports where (opportunity_id=v_id or deal_key=any(v_keys))
      and (submission_id is not null or opportunity_id is distinct from v_id))
    or exists(select 1 from public.deal_hunter_cim_requests where (opportunity_id=v_id or deal_key=any(v_keys))
      and (submission_id is not null or opportunity_id is distinct from v_id))
    or exists(select 1 from public.deal_hunter_dispositions d where d.disposition='dismissed' and d.id<>v_pass.id
      and d.deal_key=any(v_keys)) then return v_conflict; end if;
  update public.deal_hunter_dispositions set disposition='restored',updated_at=v_at,
    updated_by=p_input->>'actor',restored_at=v_at,restored_by=p_input->>'actor'
    where id=v_pass.id returning * into v_pass;
  update public.deal_hunter_opportunities set campaign_authority_revision=campaign_authority_revision+1 where opportunity_id=v_id;
  return jsonb_build_object('applied',true,'disposition',to_jsonb(v_pass));
end;
$$;
revoke all privileges on function public.restore_current_unlinked_opportunity(jsonb) from public,anon,authenticated;
grant execute on function public.restore_current_unlinked_opportunity(jsonb) to service_role;

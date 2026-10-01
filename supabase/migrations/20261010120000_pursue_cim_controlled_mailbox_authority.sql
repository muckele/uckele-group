-- P10B: make controlled-mailbox synthetic identity fields part of the
-- transactionally revalidated campaign authority revision.

create or replace function public.pursue_cim_bump_controlled_mailbox_authority_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'deal_hunter_opportunities' then
    update public.deal_hunter_opportunities
      set campaign_authority_revision = campaign_authority_revision + 1
      where opportunity_id = new.opportunity_id;
  elsif tg_table_name = 'contact_submissions' then
    update public.deal_hunter_opportunities
      set campaign_authority_revision = campaign_authority_revision + 1
      where opportunity_id in (old.deal_hunter_opportunity_id,
        new.deal_hunter_opportunity_id)
        or primary_submission_id in (old.id, new.id);
  end if;
  return new;
end;
$$;

revoke all on function public.pursue_cim_bump_controlled_mailbox_authority_v1()
  from public, anon, authenticated;
grant execute on function public.pursue_cim_bump_controlled_mailbox_authority_v1()
  to service_role;

drop trigger if exists trg_cim_campaign_revision_opportunity_identity_update
  on public.deal_hunter_opportunities;
create trigger trg_cim_campaign_revision_opportunity_identity_update
after update of canonical_name, primary_submission_id, identity_version, metadata
on public.deal_hunter_opportunities
for each row
when ((old.opportunity_id like 'p10b-%'
    or old.identity_version = 'p10b-synthetic-v1'
    or new.identity_version = 'p10b-synthetic-v1'
    or old.metadata @> '{"p10bSynthetic":true}'::jsonb
    or new.metadata @> '{"p10bSynthetic":true}'::jsonb)
  and (old.canonical_name is distinct from new.canonical_name
    or old.primary_submission_id is distinct from new.primary_submission_id
    or old.identity_version is distinct from new.identity_version
    or old.metadata is distinct from new.metadata))
execute function public.pursue_cim_bump_controlled_mailbox_authority_v1();

drop trigger if exists trg_cim_campaign_revision_submission_identity_update
  on public.contact_submissions;
create trigger trg_cim_campaign_revision_submission_identity_update
after update of source, metadata, deal_hunter_opportunity_id
on public.contact_submissions
for each row
when ((old.source = 'p10b-controlled-mailbox' or new.source = 'p10b-controlled-mailbox'
    or old.deal_hunter_opportunity_id like 'p10b-%'
    or new.deal_hunter_opportunity_id like 'p10b-%'
    or old.metadata @> '{"p10bSynthetic":true}'::jsonb
    or new.metadata @> '{"p10bSynthetic":true}'::jsonb)
  and (old.source is distinct from new.source
    or old.metadata is distinct from new.metadata
    or old.deal_hunter_opportunity_id is distinct from new.deal_hunter_opportunity_id))
execute function public.pursue_cim_bump_controlled_mailbox_authority_v1();

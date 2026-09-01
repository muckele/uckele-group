-- Atomic current-authority operator fact write. This is deliberately separate
-- from the historical upsert boundary: enrichment may only target an active
-- canonical opportunity at the instant the durable revision is inserted.
create or replace function public.insert_current_deal_hunter_opportunity_fact(
  p_id text, p_opportunity_id text, p_field text, p_value text, p_source text,
  p_verified boolean, p_actor text, p_note text, p_created_at timestamptz, p_updated_at timestamptz
)
returns public.deal_hunter_opportunity_facts
language plpgsql
security definer
set search_path = public
as $$
declare v_fact public.deal_hunter_opportunity_facts;
begin
  perform 1 from public.deal_hunter_opportunities
    where opportunity_id = p_opportunity_id and status = 'active' for update;
  if not found then
    raise exception 'current canonical opportunity is unavailable' using errcode = 'P0002';
  end if;
  insert into public.deal_hunter_opportunity_facts (
    id, opportunity_id, field, value, source, verified, actor, note, created_at, updated_at
  ) values (
    p_id, p_opportunity_id, p_field, p_value, p_source, p_verified, p_actor, p_note, p_created_at, p_updated_at
  ) returning * into v_fact;
  return v_fact;
end;
$$;

revoke all privileges on function public.insert_current_deal_hunter_opportunity_fact(
  text, text, text, text, text, boolean, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.insert_current_deal_hunter_opportunity_fact(
  text, text, text, text, text, boolean, text, text, timestamptz, timestamptz
) to service_role;

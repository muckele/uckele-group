do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'deal_hunter_cim_requests_canonical_id_check'
      and conrelid = 'public.deal_hunter_cim_requests'::regclass
  ) then
    alter table public.deal_hunter_cim_requests
      add constraint deal_hunter_cim_requests_canonical_id_check
      check ((id collate "C") ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$') not valid;
  end if;
end
$$;

create or replace function public.list_deal_hunter_cim_detail_authority(
  p_opportunity_ids text[],
  p_limit integer default 100
)
returns setof public.deal_hunter_cim_requests
language sql
stable
security invoker
set search_path = public
as $$
  select request.*
  from public.deal_hunter_cim_requests as request
  where request.opportunity_id = any(p_opportunity_ids)
    and (request.id collate "C") ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  order by
    request.updated_at desc nulls last,
    request.id collate "C" asc
  limit greatest(1, least(coalesce(p_limit, 100), 100000));
$$;

revoke all on function public.list_deal_hunter_cim_detail_authority(text[], integer)
  from public, anon, authenticated;
grant execute on function public.list_deal_hunter_cim_detail_authority(text[], integer)
  to service_role;

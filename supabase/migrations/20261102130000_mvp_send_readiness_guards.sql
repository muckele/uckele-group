-- MVP send readiness, pre-canary database guards.
--
-- Forward-only and re-runnable. Owner decision events are immutable evidence, so the
-- migration never rewrites a row: it first proves every existing row satisfies the new
-- guards and fails with a clear message otherwise, rather than adding the constraints
-- as NOT VALID.

do $$
begin
  if exists (
    select 1 from public.deal_hunter_owner_decision_events
    where policy_version not in ('owner-decision-v1', 'auto-pursue-v1')
      or (policy_version = 'auto-pursue-v1'
        and (actor <> 'automation-auto-pursue' or action <> 'pursue'))
  ) then
    raise exception 'owner_decision_events has rows violating policy guard';
  end if;
end;
$$;

-- Only the two known decision policies exist, and an automatic-policy event can only be
-- an automatic Pursue recorded by the automation actor.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.deal_hunter_owner_decision_events'::regclass
      and conname = 'deal_hunter_owner_decision_events_policy_version_check'
  ) then
    alter table public.deal_hunter_owner_decision_events
      add constraint deal_hunter_owner_decision_events_policy_version_check
      check (policy_version in ('owner-decision-v1', 'auto-pursue-v1'));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.deal_hunter_owner_decision_events'::regclass
      and conname = 'deal_hunter_owner_decision_events_auto_pursue_actor_check'
  ) then
    alter table public.deal_hunter_owner_decision_events
      add constraint deal_hunter_owner_decision_events_auto_pursue_actor_check
      check (policy_version <> 'auto-pursue-v1'
        or (actor = 'automation-auto-pursue' and action = 'pursue'));
  end if;
end;
$$;

-- The latest decision per opportunity is read on every inbox page.
create index if not exists idx_deal_hunter_owner_decision_events_opportunity_created
  on public.deal_hunter_owner_decision_events (opportunity_id, created_at desc);

create table if not exists public.admin_onboarding_progress (
  principal_id text not null,
  tour_key text not null,
  tour_version integer not null check (tour_version > 0),
  status text not null check (status in ('in_progress', 'completed', 'skipped')),
  last_completed_step_id text,
  started_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  skipped_at timestamptz,
  primary key (principal_id, tour_key, tour_version),
  check (
    (status = 'in_progress' and completed_at is null and skipped_at is null)
    or (status = 'completed' and completed_at is not null and skipped_at is null)
    or (status = 'skipped' and completed_at is null and skipped_at is not null)
  )
);

create index if not exists idx_admin_onboarding_progress_principal_updated
  on public.admin_onboarding_progress (principal_id, updated_at desc);

create or replace function public.upsert_admin_onboarding_progress(
  p_principal_id text,
  p_tour_key text,
  p_tour_version integer,
  p_status text,
  p_last_completed_step_id text,
  p_step_ids text[],
  p_started_at timestamptz,
  p_updated_at timestamptz,
  p_completed_at timestamptz,
  p_skipped_at timestamptz
)
returns public.admin_onboarding_progress
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_progress public.admin_onboarding_progress;
begin
  insert into public.admin_onboarding_progress (
    principal_id, tour_key, tour_version, status, last_completed_step_id,
    started_at, updated_at, completed_at, skipped_at
  ) values (
    p_principal_id, p_tour_key, p_tour_version, p_status, p_last_completed_step_id,
    p_started_at, p_updated_at, p_completed_at, p_skipped_at
  )
  on conflict (principal_id, tour_key, tour_version) do update set
    status = case
      when admin_onboarding_progress.status = 'completed' then admin_onboarding_progress.status
      when admin_onboarding_progress.status = 'skipped' and excluded.status <> 'completed' then admin_onboarding_progress.status
      else excluded.status
    end,
    last_completed_step_id = case
      when admin_onboarding_progress.status = 'completed' then admin_onboarding_progress.last_completed_step_id
      when admin_onboarding_progress.status = 'skipped' and excluded.status <> 'completed' then admin_onboarding_progress.last_completed_step_id
      when coalesce(array_position(p_step_ids, excluded.last_completed_step_id), 0)
        < coalesce(array_position(p_step_ids, admin_onboarding_progress.last_completed_step_id), 0)
        then admin_onboarding_progress.last_completed_step_id
      else excluded.last_completed_step_id
    end,
    updated_at = case
      when admin_onboarding_progress.status = 'completed' then admin_onboarding_progress.updated_at
      when admin_onboarding_progress.status = 'skipped' and excluded.status <> 'completed' then admin_onboarding_progress.updated_at
      when admin_onboarding_progress.status = 'in_progress'
        and excluded.status = 'in_progress'
        and coalesce(array_position(p_step_ids, excluded.last_completed_step_id), 0)
          <= coalesce(array_position(p_step_ids, admin_onboarding_progress.last_completed_step_id), 0)
        then admin_onboarding_progress.updated_at
      else excluded.updated_at
    end,
    completed_at = case
      when admin_onboarding_progress.status = 'completed' then admin_onboarding_progress.completed_at
      when excluded.status = 'completed' then excluded.completed_at
      else null
    end,
    skipped_at = case
      when admin_onboarding_progress.status = 'completed' then null
      when admin_onboarding_progress.status = 'skipped' and excluded.status <> 'completed' then admin_onboarding_progress.skipped_at
      when excluded.status = 'skipped' then excluded.skipped_at
      else null
    end
  returning * into v_progress;

  return v_progress;
end;
$$;

alter table public.admin_onboarding_progress enable row level security;
revoke all privileges on table public.admin_onboarding_progress from public, anon, authenticated;
grant all privileges on table public.admin_onboarding_progress to service_role;
revoke all on function public.upsert_admin_onboarding_progress(
  text, text, integer, text, text, text[], timestamptz, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.upsert_admin_onboarding_progress(
  text, text, integer, text, text, text[], timestamptz, timestamptz, timestamptz, timestamptz
) to service_role;

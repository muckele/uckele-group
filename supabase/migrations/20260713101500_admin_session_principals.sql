alter table public.admin_sessions
  add column if not exists principal_id text;

update public.admin_sessions
set principal_id = case
  when role = 'admin' then 'admin:primary'
  else 'viewer:identity:' || lower(btrim(username))
end
where principal_id is null or btrim(principal_id) = '';

alter table public.admin_sessions
  alter column principal_id set not null;

create index if not exists idx_admin_sessions_principal
  on public.admin_sessions (principal_id, created_at desc);

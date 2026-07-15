create table if not exists public.admin_magic_links (
  token_hash text primary key,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  email text not null,
  role text not null,
  requested_ip_hash text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_admin_magic_links_expires_at on public.admin_magic_links (expires_at);

create table if not exists public.admin_sessions (
  id uuid primary key,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null,
  revoked_at timestamptz,
  username text not null,
  role text not null,
  created_ip_hash text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_admin_sessions_username on public.admin_sessions (username, created_at desc);
create index if not exists idx_admin_sessions_expires_at on public.admin_sessions (expires_at);

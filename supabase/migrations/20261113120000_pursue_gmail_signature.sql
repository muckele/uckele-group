-- Pursue emails end with the owner's Gmail signature: storage for its snapshot.
--
-- Forward-only and re-runnable. One row holds the sanitized signature HTML read from Gmail
-- (users.settings.sendAs), its plain text and sha256 digest, the send-as address and when it
-- was fetched, plus the last refresh attempt and its error code. A failed refresh records only
-- the attempt and its code, so the snapshot is kept. Service-role only, written only through
-- the RPC below.

create table if not exists public.deal_hunter_gmail_signatures (
  id text primary key check (id = 'current'),
  send_as_address text check (send_as_address is null
    or (send_as_address = btrim(send_as_address) and char_length(send_as_address) between 3 and 320)),
  signature_html text check (signature_html is null or char_length(signature_html) <= 262144),
  signature_text text check (signature_text is null or char_length(signature_text) <= 131072),
  signature_digest text check (signature_digest is null or signature_digest ~ '^[0-9a-f]{64}$'),
  fetched_at timestamptz,
  last_attempt_at timestamptz not null,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'),
  constraint deal_hunter_gmail_signatures_snapshot check (
    (signature_digest is null) = (fetched_at is null)
    and (signature_digest is null) = (signature_html is null)
    and (signature_digest is null) = (signature_text is null)
    and (signature_digest is null) = (send_as_address is null))
);

alter table public.deal_hunter_gmail_signatures enable row level security;
revoke all on table public.deal_hunter_gmail_signatures
  from public, anon, authenticated, service_role;
grant select on table public.deal_hunter_gmail_signatures to service_role;

-- ok = true stores the snapshot (errorCode may say it was stored empty, e.g. too large);
-- ok = false records the attempt and its code and keeps the snapshot.
create or replace function public.deal_hunter_gmail_record_signature_refresh_v1(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := public.pursue_cim_required_instant_v1(p_command, 'now');
  v_ok boolean;
  v_error_code text;
  v_row public.deal_hunter_gmail_signatures%rowtype;
begin
  -- Each check runs on its own, so a malformed value is refused before it is ever cast.
  if pg_catalog.jsonb_typeof(p_command -> 'ok') is distinct from 'boolean' then
    raise exception 'Invalid Gmail signature refresh';
  end if;
  v_ok := (p_command ->> 'ok')::boolean;
  if coalesce(pg_catalog.jsonb_typeof(p_command -> 'errorCode'), 'null') not in ('string', 'null') then
    raise exception 'Invalid Gmail signature refresh';
  end if;
  v_error_code := p_command ->> 'errorCode';
  if v_error_code is not null and v_error_code !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Invalid Gmail signature refresh';
  end if;
  if not v_ok and v_error_code is null then
    raise exception 'Invalid Gmail signature refresh';
  end if;
  if v_ok then
    if pg_catalog.jsonb_typeof(p_command -> 'html') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_command -> 'text') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_command -> 'digest') is distinct from 'string' then
      raise exception 'Invalid Gmail signature refresh';
    end if;
    if (p_command ->> 'digest') !~ '^[0-9a-f]{64}$' then
      raise exception 'Invalid Gmail signature refresh';
    end if;
    insert into public.deal_hunter_gmail_signatures (id, send_as_address, signature_html,
      signature_text, signature_digest, fetched_at, last_attempt_at, last_error_code)
    values ('current', public.pursue_cim_required_text_v1(p_command, 'sendAsEmail', 320),
      p_command ->> 'html', p_command ->> 'text', p_command ->> 'digest', v_now, v_now, v_error_code)
    on conflict (id) do update set send_as_address = excluded.send_as_address,
      signature_html = excluded.signature_html, signature_text = excluded.signature_text,
      signature_digest = excluded.signature_digest, fetched_at = excluded.fetched_at,
      last_attempt_at = excluded.last_attempt_at, last_error_code = excluded.last_error_code
    returning * into v_row;
  else
    insert into public.deal_hunter_gmail_signatures (id, last_attempt_at, last_error_code)
    values ('current', v_now, v_error_code)
    on conflict (id) do update set last_attempt_at = excluded.last_attempt_at,
      last_error_code = excluded.last_error_code
    returning * into v_row;
  end if;
  return pg_catalog.to_jsonb(v_row);
end;
$$;
revoke all on function public.deal_hunter_gmail_record_signature_refresh_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.deal_hunter_gmail_record_signature_refresh_v1(jsonb) to service_role;

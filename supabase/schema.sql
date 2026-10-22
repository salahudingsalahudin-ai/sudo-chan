create table if not exists public.waitlist (
  id bigint generated always as identity primary key,
  email text not null unique,
  created_at timestamptz not null default now(),
  constraint waitlist_email_lowercase check (email = lower(email))
);

alter table public.waitlist enable row level security;

create table if not exists public.waitlist_rate_limits (
  hashed_ip text primary key check (hashed_ip ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts >= 0)
);

create index if not exists waitlist_rate_limits_window_started_at_idx
  on public.waitlist_rate_limits (window_started_at);

alter table public.waitlist_rate_limits enable row level security;
revoke all on table public.waitlist_rate_limits from public, anon, authenticated;
grant all on table public.waitlist_rate_limits to service_role;

create or replace function public.consume_waitlist_attempt(
  p_ip_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  current_attempt_count integer;
begin
  if p_ip_hash !~ '^[a-f0-9]{64}$' or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'Invalid rate-limit parameters.';
  end if;

  delete from public.waitlist_rate_limits
  where window_started_at <= now() - make_interval(secs => p_window_seconds);

  insert into public.waitlist_rate_limits (hashed_ip, window_started_at, attempts)
  values (p_ip_hash, now(), 1)
  on conflict (hashed_ip) do update
  set window_started_at = case
        when public.waitlist_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds)
          then now()
        else public.waitlist_rate_limits.window_started_at
      end,
      attempts = case
        when public.waitlist_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds)
          then 1
        else public.waitlist_rate_limits.attempts + 1
      end
  returning attempts into current_attempt_count;

  return query select current_attempt_count <= p_limit;
end;
$$;

revoke all on function public.consume_waitlist_attempt(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_waitlist_attempt(text, integer, integer) to service_role;

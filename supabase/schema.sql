create table if not exists public.waitlist (
  id bigint generated always as identity primary key,
  email text not null unique,
  created_at timestamptz not null default now(),
  constraint waitlist_email_lowercase check (email = lower(email))
);

alter table public.waitlist enable row level security;

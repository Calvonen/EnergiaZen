create or replace function public.jsonb_object_key_count(value jsonb)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select count(*)::integer
  from jsonb_object_keys(value);
$$;

create table if not exists public.temperature_drop_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_date date not null,
  timezone text not null default 'Europe/Helsinki',
  source_start timestamptz not null,
  source_end timestamptz not null,
  source_days smallint not null,
  hourly_drops jsonb not null,
  observation_days_by_hour jsonb not null,
  general_fallback double precision not null,
  algorithm_version text not null default 'weighted-70-30-v1',
  created_at timestamptz not null default now(),
  constraint temperature_drop_profiles_source_order
    check (source_end > source_start),
  constraint temperature_drop_profiles_source_days_range
    check (source_days between 1 and 30),
  constraint temperature_drop_profiles_timezone
    check (timezone = 'Europe/Helsinki'),
  constraint temperature_drop_profiles_hourly_drops_object
    check (
      jsonb_typeof(hourly_drops) = 'object'
      and public.jsonb_object_key_count(hourly_drops) = 24
    ),
  constraint temperature_drop_profiles_observation_days_object
    check (
      jsonb_typeof(observation_days_by_hour) = 'object'
      and public.jsonb_object_key_count(observation_days_by_hour) = 24
    ),
  constraint temperature_drop_profiles_general_fallback_nonnegative
    check (general_fallback >= 0),
  constraint temperature_drop_profiles_one_per_day
    unique (profile_date, timezone)
);

create index if not exists temperature_drop_profiles_latest_idx
  on public.temperature_drop_profiles (timezone, profile_date desc, created_at desc);

alter table public.temperature_drop_profiles enable row level security;

create policy "Authenticated users can read temperature drop profiles"
  on public.temperature_drop_profiles
  for select
  to authenticated
  using (true);

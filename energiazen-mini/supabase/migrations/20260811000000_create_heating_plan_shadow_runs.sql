-- Shadow-mode diagnostic table for the run-heating-optimizer Edge Function
-- (backend-side lämmitysoptimoinnin shadow mode). Each function invocation
-- inserts exactly one row here; the function never writes to heating_plans
-- itself - Shelly/app keep using only what the app publishes there until a
-- separate, explicitly-approved change makes a backend function the primary
-- writer. See that PR's report for column meanings and the shadow/app
-- comparison fields.
create table public.heating_plan_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null,
  source text not null default 'backend_shadow' check (source = 'backend_shadow'),
  today_plan_date date not null,
  today_planned_hours integer[],
  tomorrow_plan_date date not null,
  tomorrow_planned_hours integer[],
  target_hours integer,
  reason text not null,
  optimizer_valid boolean,
  optimizer_violations text[],
  input_price_fetched_at timestamptz,
  tank_reading_at timestamptz,
  heating_status boolean,
  fallback_used boolean not null default false,
  uncertainty_reason text,
  settings_source text not null,
  app_planned_hours_today integer[],
  planned_hours_match boolean,
  created_at timestamptz not null default now()
);

create index heating_plan_shadow_runs_run_at_idx
  on public.heating_plan_shadow_runs (run_at desc);

-- Service-role-only, same reasoning as device_monitor_state
-- (20260802020000_enable_device_monitor_state_rls.sql): enabling RLS with
-- no anon/authenticated policies removes public/anon default grants from
-- the row entirely, while service_role (used by the Edge Function) always
-- bypasses RLS. This is diagnostic data with no client-facing UI yet; add
-- an authenticated-read policy here if/when a debug screen needs one.
alter table public.heating_plan_shadow_runs enable row level security;

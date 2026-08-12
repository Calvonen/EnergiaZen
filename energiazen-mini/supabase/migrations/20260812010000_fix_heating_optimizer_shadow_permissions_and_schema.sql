-- Codifies the run-heating-optimizer shadow-mode database fixes that were
-- already applied by hand in production while verifying the real deploy
-- (see this repo's shadow-mode PR reports), so a fresh or other
-- environment ends up in the same state instead of relying on an
-- undocumented manual fix. Safe to re-run anywhere, including production
-- where some or all of this may already be in place: ADD COLUMN uses
-- IF NOT EXISTS, and GRANT is idempotent by nature (re-granting an
-- already-held privilege is a no-op, never an error).

-- 1. optimizer_reason was missing from the original heating_plan_shadow_runs
-- table (20260811000000_create_heating_plan_shadow_runs.sql), even though
-- buildShadowRunRow (supabase/functions/run-heating-optimizer/logic.ts)
-- has always written it - every insert failed with "column
-- optimizer_reason does not exist" until this was patched by hand.
alter table public.heating_plan_shadow_runs
  add column if not exists optimizer_reason text;

-- 2. run-heating-optimizer runs as service_role and needs read access to
-- every input it assembles. tank_readings and electricity_prices already
-- grant service_role select via 20260802010000 and 20260724010000 -
-- repeated here anyway so this migration is a complete, self-contained
-- record of what shadow mode needs; the repeat GRANTs are no-ops.
-- heating_control_settings, heating_plans and temperature_drop_profiles
-- never had a service_role grant at all (heating_control_settings and
-- heating_plans predate migration tracking - see docs/PROJECT_CONTEXT.md -
-- and temperature_drop_profiles' only prior grant,
-- 20260722020000_grant_temperature_drop_profile_read.sql, was to
-- authenticated, not service_role).
grant select on table public.tank_readings to service_role;
grant select on table public.heating_control_settings to service_role;
grant select on table public.electricity_prices to service_role;
grant select on table public.heating_plans to service_role;
grant select on table public.temperature_drop_profiles to service_role;

-- 3. heating_plan_shadow_runs was created with RLS enabled but no
-- service_role GRANT (20260811000000) - service_role always bypasses RLS,
-- but still needs the table-level GRANT regardless, same gap tank_readings
-- had before 20260802010000. Without this every shadow run's insert fails
-- with "permission denied for table heating_plan_shadow_runs".
grant insert on table public.heating_plan_shadow_runs to service_role;

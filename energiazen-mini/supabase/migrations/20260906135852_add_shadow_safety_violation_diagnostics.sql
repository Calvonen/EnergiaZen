alter table public.heating_plan_shadow_runs
  add column if not exists first_safety_violation_at timestamptz,
  add column if not exists first_safety_showers_before double precision,
  add column if not exists first_safety_showers_after double precision,
  add column if not exists first_safety_temperature_before double precision,
  add column if not exists first_safety_temperature_after double precision,
  add column if not exists first_safety_heating_selected boolean;

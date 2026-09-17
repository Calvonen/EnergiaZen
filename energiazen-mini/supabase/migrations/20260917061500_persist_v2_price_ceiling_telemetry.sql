alter table public.v2_energy_reserve_shadow_runs
  add column if not exists price_ceiling_setting_available boolean,
  add column if not exists price_ceiling_setting_enabled boolean,
  add column if not exists price_ceiling_max_billed_cents_kwh double precision,
  add column if not exists price_ceiling_setting_reason text;

comment on column public.v2_energy_reserve_shadow_runs.price_ceiling_setting_available is
  'Whether the V2 billed-price ceiling setting was parseable for this shadow run.';
comment on column public.v2_energy_reserve_shadow_runs.price_ceiling_setting_enabled is
  'Whether a finite billed-price ceiling was configured for this shadow run.';
comment on column public.v2_energy_reserve_shadow_runs.price_ceiling_max_billed_cents_kwh is
  'Configured maximum billed electricity price in cents/kWh for this shadow run, or NULL when disabled/unavailable.';
comment on column public.v2_energy_reserve_shadow_runs.price_ceiling_setting_reason is
  'Telemetry reason: configured, disabled, or invalid_setting.';

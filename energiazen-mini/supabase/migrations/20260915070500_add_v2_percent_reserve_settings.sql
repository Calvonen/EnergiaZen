alter table public.heating_control_settings
  add column if not exists v2_target_reserve_percent double precision not null default 75,
  add column if not exists v2_safety_reserve_percent double precision not null default 30;

alter table public.heating_control_settings
  drop constraint if exists heating_control_settings_v2_target_reserve_percent_check,
  add constraint heating_control_settings_v2_target_reserve_percent_check
    check (
      v2_target_reserve_percent >= 5
      and v2_target_reserve_percent <= 95
      and mod(v2_target_reserve_percent::numeric, 5) = 0
    ),
  drop constraint if exists heating_control_settings_v2_safety_reserve_percent_check,
  add constraint heating_control_settings_v2_safety_reserve_percent_check
    check (
      v2_safety_reserve_percent >= 0
      and v2_safety_reserve_percent <= 95
      and mod(v2_safety_reserve_percent::numeric, 5) = 0
    ),
  drop constraint if exists heating_control_settings_v2_reserve_percent_order_check,
  add constraint heating_control_settings_v2_reserve_percent_order_check
    check (v2_safety_reserve_percent <= v2_target_reserve_percent);

alter table public.v2_energy_reserve_shadow_runs
  add column if not exists energy_capacity_kwh double precision,
  add column if not exists safety_reserve_percent double precision,
  add column if not exists target_reserve_percent double precision;

alter table public.v2_energy_reserve_shadow_runs
  drop constraint if exists v2_energy_reserve_shadow_runs_safety_percent_check,
  add constraint v2_energy_reserve_shadow_runs_safety_percent_check
    check (safety_reserve_percent is null or (safety_reserve_percent >= 0 and safety_reserve_percent <= 100)),
  drop constraint if exists v2_energy_reserve_shadow_runs_target_percent_check,
  add constraint v2_energy_reserve_shadow_runs_target_percent_check
    check (target_reserve_percent is null or (target_reserve_percent >= 0 and target_reserve_percent <= 100));

-- The settings UI needs the same capacity denominator that the backend used
-- for its percentage-to-kWh conversion. Keep the shadow table otherwise
-- private: authenticated clients can read only the timestamp and capacity
-- columns, and only rows that actually contain a capacity value.
grant select (run_at, energy_capacity_kwh)
  on table public.v2_energy_reserve_shadow_runs
  to authenticated;

drop policy if exists authenticated_read_v2_energy_capacity
  on public.v2_energy_reserve_shadow_runs;
create policy authenticated_read_v2_energy_capacity
  on public.v2_energy_reserve_shadow_runs
  for select
  to authenticated
  using (energy_capacity_kwh is not null);

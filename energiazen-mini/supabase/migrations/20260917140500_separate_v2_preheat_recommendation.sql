-- Keep the hard reserve-threshold telemetry internally consistent now that
-- v2_target_reserve_percent in settings is a soft economic recommendation.
-- The recommendation gets its own shadow-run field; target_* remains reserved
-- for the ordered hard reserve policy used by evaluateEnergyReserve.
alter table public.v2_energy_reserve_shadow_runs
  add column if not exists recommended_preheat_percent integer;

alter table public.v2_energy_reserve_shadow_runs
  drop constraint if exists v2_energy_reserve_shadow_runs_recommended_preheat_percent_check;

alter table public.v2_energy_reserve_shadow_runs
  add constraint v2_energy_reserve_shadow_runs_recommended_preheat_percent_check
    check (
      recommended_preheat_percent is null
      or (
        recommended_preheat_percent >= 70
        and recommended_preheat_percent <= 95
        and mod(recommended_preheat_percent::numeric, 5) = 0
      )
    );

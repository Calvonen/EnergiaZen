-- Keep shadow-run telemetry aligned with the V2 target range exposed by the app.
-- 60% and 65% are now valid configured targets, so the matching preheat
-- telemetry must accept the same lower bound.
alter table public.v2_energy_reserve_shadow_runs
  drop constraint if exists v2_energy_reserve_shadow_runs_recommended_preheat_percent_check;

alter table public.v2_energy_reserve_shadow_runs
  add constraint v2_energy_reserve_shadow_runs_recommended_preheat_percent_check
    check (
      recommended_preheat_percent is null
      or (
        recommended_preheat_percent >= 60
        and recommended_preheat_percent <= 95
        and mod(recommended_preheat_percent::numeric, 5) = 0
      )
    );

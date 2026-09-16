alter table public.v2_energy_reserve_shadow_runs
  add column if not exists forecast_final_conservative_energy_kwh double precision;

drop function if exists public.get_v2_energy_reserve_home();
create function public.get_v2_energy_reserve_home()
returns table (
  run_at timestamptz,
  available boolean,
  conservative_energy_kwh double precision,
  energy_capacity_kwh double precision,
  safety_reserve_percent double precision,
  target_reserve_percent double precision,
  forecast_min_conservative_energy_kwh double precision,
  forecast_final_conservative_energy_kwh double precision,
  forecast_horizon_end_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select shadow.run_at, shadow.available, shadow.conservative_energy_kwh,
    shadow.energy_capacity_kwh, shadow.safety_reserve_percent, shadow.target_reserve_percent,
    shadow.forecast_min_conservative_energy_kwh, shadow.forecast_final_conservative_energy_kwh,
    shadow.forecast_horizon_end_at
  from public.v2_energy_reserve_shadow_runs as shadow
  order by shadow.run_at desc
  limit 1;
$$;
revoke all on function public.get_v2_energy_reserve_home() from public, anon;
grant execute on function public.get_v2_energy_reserve_home() to authenticated;

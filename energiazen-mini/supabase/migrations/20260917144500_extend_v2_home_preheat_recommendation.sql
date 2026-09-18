drop function if exists public.get_v2_energy_reserve_home();
create function public.get_v2_energy_reserve_home()
returns table (
  run_at timestamptz,
  available boolean,
  conservative_energy_kwh double precision,
  energy_capacity_kwh double precision,
  safety_reserve_percent double precision,
  target_reserve_percent double precision,
  recommended_preheat_percent integer,
  forecast_min_conservative_energy_kwh double precision,
  forecast_final_conservative_energy_kwh double precision,
  forecast_horizon_end_at timestamptz,
  latest_run_at timestamptz,
  latest_run_available boolean,
  latest_unavailable_reason text
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  with latest as (
    select shadow.run_at, shadow.available, shadow.unavailable_reason
    from public.v2_energy_reserve_shadow_runs as shadow
    order by shadow.run_at desc
    limit 1
  ), last_good as (
    select shadow.*
    from public.v2_energy_reserve_shadow_runs as shadow
    where shadow.available is true
      and shadow.conservative_energy_kwh is not null
      and shadow.energy_capacity_kwh is not null
      and shadow.forecast_min_conservative_energy_kwh is not null
      and shadow.forecast_final_conservative_energy_kwh is not null
      and shadow.forecast_horizon_end_at is not null
    order by shadow.run_at desc
    limit 1
  )
  select good.run_at, true, good.conservative_energy_kwh, good.energy_capacity_kwh,
    good.safety_reserve_percent, good.target_reserve_percent, good.recommended_preheat_percent,
    good.forecast_min_conservative_energy_kwh, good.forecast_final_conservative_energy_kwh,
    good.forecast_horizon_end_at, latest.run_at, latest.available, latest.unavailable_reason
  from last_good as good
  cross join latest
  where good.run_at >= now() - interval '30 minutes';
$$;
revoke all on function public.get_v2_energy_reserve_home() from public, anon;
grant execute on function public.get_v2_energy_reserve_home() to authenticated;

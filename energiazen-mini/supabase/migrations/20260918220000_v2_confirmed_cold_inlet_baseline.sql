create or replace function public.get_confirmed_cold_inlet_baseline(
  p_since timestamptz default now() - interval '56 days',
  p_until timestamptz default now()
)
returns double precision
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      p_since as history_start,
      (
        date_trunc('week', p_until at time zone 'Europe/Helsinki')
        at time zone 'Europe/Helsinki'
      ) as completed_week_end
  ),
  weekly as (
    select minimum_inlet_temp
    from bounds b
    cross join lateral public.get_weekly_minimum_inlet_temperature(
      b.history_start,
      b.completed_week_end
    )
    where minimum_inlet_temp between 1 and 30
  )
  select case
    when count(*) >= 2
      then percentile_cont(0.5) within group (order by minimum_inlet_temp)
    else null
  end::double precision
  from weekly;
$$;

comment on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
is 'Returns a robust learned cold-water baseline from the median of at least two completed historical weekly confirmed minima. The current Helsinki week is excluded so the active candidate window cannot influence its own baseline. Uses get_weekly_minimum_inlet_temperature so neighbor confirmation keeps indexed tank_readings timestamp lookups.';

revoke all on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
  to service_role;

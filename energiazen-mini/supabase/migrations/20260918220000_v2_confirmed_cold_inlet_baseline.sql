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
  with weekly as (
    select minimum_inlet_temp
    from public.get_weekly_minimum_inlet_temperature(p_since, p_until)
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
is 'Returns a robust learned cold-water baseline from the median of at least two historical weekly confirmed minima strictly before p_until. Callers pass the active replay start as p_until so the candidate window can never influence its own baseline. Uses get_weekly_minimum_inlet_temperature so neighbor confirmation keeps indexed tank_readings timestamp lookups.';

revoke all on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
  to service_role;

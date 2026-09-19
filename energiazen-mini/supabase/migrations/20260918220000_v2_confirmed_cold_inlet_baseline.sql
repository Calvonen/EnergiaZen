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
  with valid_readings as (
    select
      tr.created_at,
      tr.inlet_temp,
      date_trunc(
        'week',
        tr.created_at at time zone 'Europe/Helsinki'
      )::date as week_start
    from public.tank_readings tr
    where tr.created_at >= p_since
      and tr.created_at < p_until
      and tr.inlet_temp between 1 and 30
  ),
  confirmed_readings as (
    select v.week_start, v.inlet_temp
    from valid_readings v
    where exists (
      select 1
      from public.tank_readings n
      where n.created_at >= greatest(
          p_since,
          v.created_at - interval '3 minutes'
        )
        and n.created_at < least(
          p_until,
          v.created_at + interval '3 minutes' + interval '1 microsecond'
        )
        and n.created_at <> v.created_at
        and n.inlet_temp is not null
        and n.inlet_temp >= v.inlet_temp
        and n.inlet_temp <= v.inlet_temp + 2
    )
  ),
  weekly as (
    select week_start, min(inlet_temp) as minimum_inlet_temp
    from confirmed_readings
    group by week_start
  )
  select case
    when count(*) >= 2
      then percentile_cont(0.5) within group (order by minimum_inlet_temp)
    else null
  end::double precision
  from weekly;
$$;

comment on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
is 'Returns a robust learned cold-water baseline from the median of at least two historical weekly confirmed minima strictly inside [p_since, p_until). Both the candidate and its confirming neighbor are bounded to that interval, so active replay samples cannot influence the baseline. Neighbor lookups query tank_readings directly through created_at ranges so the timestamp index remains usable.';

revoke all on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
  to service_role;

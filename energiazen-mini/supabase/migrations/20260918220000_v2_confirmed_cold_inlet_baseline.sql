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
  with reliable_draws as (
    select
      w.id,
      w.event_started_at,
      w.event_ended_at,
      date_trunc(
        'week',
        w.event_started_at at time zone 'Europe/Helsinki'
      )::date as week_start
    from public.water_draw_labels w
    where w.event_started_at >= p_since
      and w.event_ended_at < p_until
      and w.energy_reliable = true
      and w.energy_quality_reason is null
      and w.estimated_water_draw_net_energy_kwh > 0
      and 'cold_inlet' = any(w.detection_kinds)
  ),
  draw_minima as (
    select
      d.week_start,
      d.id,
      min(tr.inlet_temp) as minimum_inlet_temp
    from reliable_draws d
    join public.tank_readings tr
      on tr.created_at >= d.event_started_at
      and tr.created_at <= d.event_ended_at
      and tr.inlet_temp between 1 and 30
    group by d.week_start, d.id
  ),
  weekly as (
    select
      week_start,
      min(minimum_inlet_temp) as minimum_inlet_temp
    from draw_minima
    group by week_start
    having
      (week_start::timestamp at time zone 'Europe/Helsinki') >= p_since
      and (
        (week_start::timestamp + interval '7 days')
        at time zone 'Europe/Helsinki'
      ) <= p_until
  )
  select case
    when count(*) >= 2
      then percentile_cont(0.5) within group (order by minimum_inlet_temp)
    else null
  end::double precision
  from weekly;
$$;

comment on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
is 'Returns a robust cold-water baseline from the median of at least two complete historical Helsinki weeks that contain energy-reliable, positive-energy water-draw labels with cold_inlet evidence. The inlet minimum is measured only inside those independently verified draw intervals, so recurring unlabeled nuisance plateaus cannot teach the baseline. Partial weeks at both history boundaries are excluded and p_until remains before the active replay.';

revoke all on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
  to service_role;

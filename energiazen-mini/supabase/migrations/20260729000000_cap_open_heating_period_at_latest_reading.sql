-- get_heating_periods aiemmin jatkoi avointa (paattymatonta) lammitysjaksoa
-- now()-hetkeen asti, jos monitorilta ei enaa tullut lukemia sen jalkeen kun
-- viimeinen tunnettu lukema oli heating = true. Jos monitori lakkasi
-- raportoimasta, jakso nayttaytyi jatkuvana vaikka todellisuudessa mitaan ei
-- tiedeta lukeman jalkeisesta ajasta. Rajataan avoin jakso sen sijaan
-- viimeisimpaan tunnettuun lukemaan.
create or replace function public.get_heating_periods(
  p_start timestamptz,
  p_end timestamptz
)
returns table (
  start_time timestamptz,
  end_time timestamptz,
  duration_minutes double precision
)
language sql
stable
security invoker
set search_path = public
as $$
with bounds as (
  select
    least(p_start, p_end) as range_start,
    greatest(p_start, p_end) as range_end
),
data_bounds as (
  select max(tr.created_at) as latest_reading_at
  from public.tank_readings tr
),
previous_reading as (
  select tr.created_at, tr.heating
  from public.tank_readings tr, bounds b
  where tr.created_at < b.range_start
    and tr.heating is not null
  order by tr.created_at desc
  limit 1
),
range_readings as (
  select tr.created_at, tr.heating
  from public.tank_readings tr, bounds b
  where tr.created_at >= b.range_start
    and tr.created_at < b.range_end
    and tr.heating is not null
),
ordered_readings as (
  select
    r.created_at,
    r.heating,
    lag(r.created_at) over (order by r.created_at) as previous_created_at,
    lag(r.heating) over (order by r.created_at) as previous_heating
  from (
    select * from previous_reading
    union all
    select * from range_readings
  ) r
),
period_starts as (
  select
    row_number() over (order by o.created_at) as period_index,
    greatest(o.created_at, b.range_start) as started_at
  from ordered_readings o
  cross join bounds b
  where o.heating is true
    and (
      o.previous_heating is distinct from true
      or o.created_at - o.previous_created_at > interval '10 minutes'
    )
),
period_ends as (
  select
    row_number() over (order by o.created_at) as period_index,
    least(
      case
        when o.created_at - o.previous_created_at > interval '10 minutes'
          then o.previous_created_at
        else o.created_at
      end,
      b.range_end
    ) as ended_at
  from ordered_readings o
  cross join bounds b
  where o.previous_heating is true
    and (
      o.heating is false
      or o.created_at - o.previous_created_at > interval '10 minutes'
    )
),
open_period_end as (
  select least(b.range_end, coalesce(db.latest_reading_at, b.range_start)) as ended_at
  from bounds b
  cross join data_bounds db
)
select
  s.started_at as start_time,
  coalesce(e.ended_at, o.ended_at) as end_time,
  greatest(
    0,
    extract(epoch from (coalesce(e.ended_at, o.ended_at) - s.started_at)) / 60
  ) as duration_minutes
from period_starts s
cross join open_period_end o
left join period_ends e on e.period_index = s.period_index
where coalesce(e.ended_at, o.ended_at) > s.started_at
order by s.started_at;
$$;

create index if not exists tank_readings_created_at_idx
  on public.tank_readings (created_at);

create index if not exists tank_readings_heating_created_at_idx
  on public.tank_readings (heating, created_at);

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
)
select
  s.started_at as start_time,
  coalesce(e.ended_at, least(b.range_end, now())) as end_time,
  greatest(
    0,
    extract(epoch from (coalesce(e.ended_at, least(b.range_end, now())) - s.started_at)) / 60
  ) as duration_minutes
from period_starts s
cross join bounds b
left join period_ends e on e.period_index = s.period_index
where coalesce(e.ended_at, least(b.range_end, now())) > s.started_at
order by s.started_at;
$$;

create or replace function public.get_temperature_history_points(
  p_start timestamptz,
  p_bucket_minutes integer,
  p_mode text default 'latest'
)
returns table (
  created_at timestamptz,
  top_temp double precision,
  bottom_temp double precision
)
language sql
stable
security invoker
set search_path = public
as $$
with settings as (
  select greatest(coalesce(p_bucket_minutes, 10), 1) * 60 as bucket_seconds
),
source_rows as (
  select tr.created_at, tr.top_temp, tr.bottom_temp
  from public.tank_readings tr
  where tr.created_at >= p_start
    and tr.top_temp is not null
    and tr.bottom_temp is not null
),
first_last_rows as (
  (select sr.created_at, sr.top_temp, sr.bottom_temp
   from source_rows sr
   order by sr.created_at asc
   limit 1)
  union
  (select sr.created_at, sr.top_temp, sr.bottom_temp
   from source_rows sr
   order by sr.created_at desc
   limit 1)
),
latest_bucket_rows as (
  select distinct on (
    floor(extract(epoch from sr.created_at) / settings.bucket_seconds)
  )
    sr.created_at,
    sr.top_temp,
    sr.bottom_temp
  from source_rows sr
  cross join settings
  where p_mode <> 'average'
  order by
    floor(extract(epoch from sr.created_at) / settings.bucket_seconds),
    sr.created_at desc
),
average_bucket_rows as (
  select
    min(sr.created_at) as created_at,
    avg(sr.top_temp) as top_temp,
    avg(sr.bottom_temp) as bottom_temp
  from source_rows sr
  where p_mode = 'average'
  group by date_trunc('hour', sr.created_at at time zone 'Europe/Helsinki')
),
combined_rows as (
  select * from first_last_rows
  union
  select * from latest_bucket_rows
  union
  select * from average_bucket_rows
)
select distinct on (cr.created_at)
  cr.created_at,
  cr.top_temp,
  cr.bottom_temp
from combined_rows cr
order by cr.created_at;
$$;

grant execute on function public.get_heating_periods(timestamptz, timestamptz)
  to authenticated;

grant execute on function public.get_temperature_history_points(
  timestamptz,
  integer,
  text
) to authenticated;

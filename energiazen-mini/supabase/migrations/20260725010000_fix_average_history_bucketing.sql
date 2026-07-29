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
    to_timestamp(
      floor(extract(epoch from sr.created_at) / settings.bucket_seconds) *
        settings.bucket_seconds
    ) as created_at,
    avg(sr.top_temp) as top_temp,
    avg(sr.bottom_temp) as bottom_temp
  from source_rows sr
  cross join settings
  where p_mode = 'average'
  group by
    floor(extract(epoch from sr.created_at) / settings.bucket_seconds),
    settings.bucket_seconds
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

grant execute on function public.get_temperature_history_points(
  timestamptz,
  integer,
  text
) to authenticated;

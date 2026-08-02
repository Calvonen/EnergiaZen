-- Palauttaa tulovesianturin (inlet_temp) alimman vahvistetun lukeman per
-- viikko, viimeisiltä p_weeks viikoilta - varaajan lämmityshistoria-sivulle
-- (app/history.tsx) tulevaa 12 viikon trendikäyrää varten. "Vahvistettu"
-- noudattaa samaa periaatetta kuin lib/inletTemperature.ts:n
-- calculateMinimumValidInletTemperature: yksittäistä lukemaa ei luoteta
-- ellei jokin toinen kelvollinen lukema samalta viikolta ole korkeintaan 3
-- minuutin päässä siitä eikä ole sitä yli 2 astetta lämpimämpi - näin
-- yksittäinen anturihäiriö ei vääristä viikon minimiä.
create or replace function public.get_weekly_minimum_inlet_temperature(
  p_weeks integer default 12
)
returns table (
  week_start date,
  minimum_inlet_temp double precision
)
language sql
stable
security invoker
set search_path = public
as $$
with bounds as (
  select
    date_trunc('week', now() at time zone 'Europe/Helsinki')::date as current_week_start,
    greatest(coalesce(p_weeks, 12), 1) as weeks
),
range_start as (
  select
    (b.current_week_start - ((b.weeks - 1) * 7))::timestamp
      at time zone 'Europe/Helsinki' as start_ts
  from bounds b
),
valid_readings as (
  select
    tr.created_at,
    tr.inlet_temp,
    date_trunc('week', tr.created_at at time zone 'Europe/Helsinki')::date
      as week_start
  from public.tank_readings tr, range_start r
  where tr.inlet_temp is not null
    and tr.inlet_temp >= 1
    and tr.inlet_temp <= 30
    and tr.created_at >= r.start_ts
),
confirmed_readings as (
  select v.week_start, v.inlet_temp
  from valid_readings v
  where exists (
    select 1
    from valid_readings n
    where n.week_start = v.week_start
      and n.created_at <> v.created_at
      and abs(extract(epoch from (n.created_at - v.created_at))) <= 180
      and n.inlet_temp >= v.inlet_temp
      and n.inlet_temp <= v.inlet_temp + 2
  )
)
select
  c.week_start,
  min(c.inlet_temp) as minimum_inlet_temp
from confirmed_readings c
group by c.week_start
order by c.week_start;
$$;

grant execute on function public.get_weekly_minimum_inlet_temperature(integer)
  to authenticated;

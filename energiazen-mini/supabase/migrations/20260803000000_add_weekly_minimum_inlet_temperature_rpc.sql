-- Palauttaa tulovesianturin (inlet_temp) alimman vahvistetun lukeman per
-- viikko annetulta aikaväliltä [p_start, p_end) - varaajan
-- lämmityshistoria-sivulle (app/history.tsx) tulevaa 3 kuukauden
-- trendikäyrää varten (ks. lib/inletTemperatureTrend.ts:n
-- getInletTrendPeriod, joka laskee jakson rajat). "Vahvistettu" noudattaa
-- samaa periaatetta kuin lib/inletTemperature.ts:n
-- calculateMinimumValidInletTemperature: yksittäistä lukemaa ei luoteta
-- ellei jokin toinen kelvollinen lukema samalta viikolta ole korkeintaan 3
-- minuutin päässä siitä eikä ole sitä yli 2 astetta lämpimämpi - näin
-- yksittäinen anturihäiriö ei vääristä viikon minimiä.

-- Poistaa mahdollisen aiemman (integer p_weeks) version, jos tämä
-- migraatio ehdittiin jo ajaa ennen aikaväliparametreihin siirtymistä.
drop function if exists public.get_weekly_minimum_inlet_temperature(integer);

create or replace function public.get_weekly_minimum_inlet_temperature(
  p_start timestamptz,
  p_end timestamptz
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
with valid_readings as (
  select
    tr.created_at,
    tr.inlet_temp,
    date_trunc('week', tr.created_at at time zone 'Europe/Helsinki')::date
      as week_start
  from public.tank_readings tr
  where tr.inlet_temp is not null
    and tr.inlet_temp >= 1
    and tr.inlet_temp <= 30
    and tr.created_at >= p_start
    and tr.created_at < p_end
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

grant execute on function public.get_weekly_minimum_inlet_temperature(
  timestamptz,
  timestamptz
) to authenticated;

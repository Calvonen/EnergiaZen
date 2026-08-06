-- ESP32:n ylasensori siirrettiin fyysisesti 9 cm:sta 16 cm:iin kannen alle
-- 2026-08-05T14:00:00Z (ks. energyModelV2/sensorGeometry.ts:n
-- topSensorMovedAt). Ennen tata migraatiota
-- recalculate_temperature_drop_profile() saattoi sekoittaa V1- ja
-- V2-geometrian aikaisia lukemia samaan 30 paivan oppimisikkunaan, ja
-- previous_profile-CTE saattoi kayttaa V1-geometrialla laskettua profiilia
-- fallbackina V2-profiilille, vaikka anturin fyysinen sijainti - ja siten
-- mitattu jaahtymiskayra - muuttui siirron myota.
--
-- Korjaus: oppimisikkunan alku ankkuroidaan aina vahintaan anturin
-- siirtohetkeen (v_source_start = greatest(source_end - 30pv, siirtohetki)),
-- ja previous_profile hyvaksyy vain profiileja joiden oma source_start on
-- siirtohetkella tai sen jalkeen - V1-aikainen profiili ei voi enaa paatya
-- V2-profiilin fallbackiksi (Codex-review, PR #156).
create or replace function public.recalculate_temperature_drop_profile()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fallback constant double precision := 0.25;
  v_minimum_observation_days constant integer := 7;
  v_profile_date date;
  v_source_end timestamptz := statement_timestamp();
  v_source_start timestamptz;
  v_top_sensor_moved_at constant timestamptz := '2026-08-05T14:00:00.000Z';
begin
  v_source_start := greatest(
    v_source_end - interval '30 days',
    v_top_sensor_moved_at
  );
  v_profile_date := (v_source_end at time zone 'Europe/Helsinki')::date;

  with ordered_readings as (
    select
      reading.created_at,
      reading.heating,
      case
        when reading.top_temp is not null
          and reading.bottom_temp is not null
        then reading.top_temp * 0.7 + reading.bottom_temp * 0.3
        else null
      end as weighted_temperature,
      lag(reading.created_at) over readings_in_time as previous_created_at,
      lag(reading.heating) over readings_in_time as previous_heating,
      lag(
        case
          when reading.top_temp is not null
            and reading.bottom_temp is not null
          then reading.top_temp * 0.7 + reading.bottom_temp * 0.3
          else null
        end
      ) over readings_in_time as previous_weighted_temperature
    from public.tank_readings as reading
    where reading.created_at >= v_source_start
      and reading.created_at <= v_source_end
    window readings_in_time as (order by reading.created_at)
  ),
  valid_drops as (
    select
      (ordered.previous_created_at at time zone 'Europe/Helsinki')::date
        as helsinki_date,
      extract(
        hour from ordered.previous_created_at at time zone 'Europe/Helsinki'
      )::integer as helsinki_hour,
      ordered.previous_weighted_temperature - ordered.weighted_temperature
        as temperature_drop
    from ordered_readings as ordered
    where ordered.previous_created_at is not null
      and ordered.previous_weighted_temperature is not null
      and ordered.weighted_temperature is not null
      and ordered.previous_heating is false
      and ordered.heating is false
      and ordered.created_at > ordered.previous_created_at
      and ordered.created_at - ordered.previous_created_at <= interval '30 minutes'
      and ordered.previous_weighted_temperature
        - ordered.weighted_temperature > 0
  ),
  daily_hour_drops as (
    select
      drop_row.helsinki_date,
      drop_row.helsinki_hour,
      sum(drop_row.temperature_drop)::double precision as daily_drop
    from valid_drops as drop_row
    group by drop_row.helsinki_date, drop_row.helsinki_hour
  ),
  hourly_statistics as (
    select
      daily.helsinki_hour,
      count(*)::integer as observation_days,
      percentile_cont(0.5) within group (order by daily.daily_drop)
        ::double precision as median_drop
    from daily_hour_drops as daily
    group by daily.helsinki_hour
  ),
  sufficient_hour_medians as (
    select hourly.median_drop
    from hourly_statistics as hourly
    where hourly.observation_days >= v_minimum_observation_days
  ),
  calculated_fallback as (
    select coalesce(
      percentile_cont(0.5) within group (
        order by sufficient.median_drop
      )::double precision,
      v_fallback
    ) as general_fallback
    from sufficient_hour_medians as sufficient
  ),
  previous_profile as (
    select profile.hourly_drops
    from public.temperature_drop_profiles as profile
    where profile.timezone = 'Europe/Helsinki'
      and profile.profile_date <= v_profile_date
      and profile.source_start >= v_top_sensor_moved_at
    order by profile.profile_date desc, profile.created_at desc
    limit 1
  ),
  complete_profile as (
    select
      jsonb_object_agg(
        hour_number::text,
        to_jsonb(
          case
            when coalesce(hourly.observation_days, 0)
              >= v_minimum_observation_days
            then hourly.median_drop
            else coalesce(
              (previous.hourly_drops ->> hour_number::text)::double precision,
              fallback.general_fallback,
              v_fallback
            )
          end
        ) order by hour_number
      ) as hourly_drops,
      jsonb_object_agg(
        hour_number::text,
        to_jsonb(coalesce(hourly.observation_days, 0))
        order by hour_number
      ) as observation_days_by_hour,
      fallback.general_fallback
    from generate_series(0, 23) as hour_number
    left join hourly_statistics as hourly
      on hourly.helsinki_hour = hour_number
    cross join calculated_fallback as fallback
    left join previous_profile as previous on true
    group by fallback.general_fallback
  )
  insert into public.temperature_drop_profiles (
    profile_date,
    timezone,
    source_start,
    source_end,
    source_days,
    hourly_drops,
    observation_days_by_hour,
    general_fallback,
    algorithm_version
  )
  select
    v_profile_date,
    'Europe/Helsinki',
    v_source_start,
    v_source_end,
    30,
    complete.hourly_drops,
    complete.observation_days_by_hour,
    complete.general_fallback,
    'weighted-70-30-v1'
  from complete_profile as complete
  on conflict (profile_date, timezone) do update
  set
    source_start = excluded.source_start,
    source_end = excluded.source_end,
    source_days = excluded.source_days,
    hourly_drops = excluded.hourly_drops,
    observation_days_by_hour = excluded.observation_days_by_hour,
    general_fallback = excluded.general_fallback,
    algorithm_version = excluded.algorithm_version,
    created_at = now();
end;
$$;

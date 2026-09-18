-- Feed the existing 30-day learned profile into V2 using the same physical
-- two-node energy geometry as the V2 ledger. Keep the legacy weighted 70/30
-- temperature profile for V1/UI consumers, but never convert that proxy to kWh.
alter table public.temperature_drop_profiles
  add column if not exists hourly_energy_losses_kwh jsonb,
  add column if not exists general_energy_loss_kwh double precision;

alter table public.v2_energy_reserve_shadow_runs
  add column if not exists learned_drop_profile_used boolean,
  add column if not exists learned_drop_profile_date date,
  add column if not exists learned_drop_profile_age_days double precision,
  add column if not exists maximum_modeled_loss_kwh_per_hour double precision;

create or replace function public.recalculate_temperature_drop_profile()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_temperature_fallback constant double precision := 0.25;
  -- Zero is safe here because V2 separately applies its physical Newton-loss
  -- floor. Insufficient learned data therefore cannot reduce forecast loss.
  v_energy_fallback constant double precision := 0;
  v_minimum_observation_days constant integer := 7;
  v_profile_date date;
  v_source_end timestamptz := statement_timestamp();
  v_source_start timestamptz;
  v_top_sensor_moved_at constant timestamptz := '2026-08-05T14:00:00.000Z';
  -- V2 geometry: 290 L, tank height 145 cm, top sensor 16 cm from top,
  -- bottom sensor 22 cm from bottom. Midpoint boundary is 75.5 cm, yielding
  -- exactly 151 kg bottom and 139 kg top at 1 kg/L.
  v_top_mass_kg constant double precision := 139;
  v_bottom_mass_kg constant double precision := 151;
  v_specific_heat_kwh_per_kg_c constant double precision := 0.001163;
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
      reading.top_temp::double precision as top_temp,
      reading.bottom_temp::double precision as bottom_temp,
      case
        when reading.top_temp is not null
          and reading.bottom_temp is not null
        then reading.top_temp * 0.7 + reading.bottom_temp * 0.3
        else null
      end as weighted_temperature,
      lag(reading.created_at) over readings_in_time as previous_created_at,
      lag(reading.heating) over readings_in_time as previous_heating,
      lag(reading.top_temp::double precision) over readings_in_time as previous_top_temp,
      lag(reading.bottom_temp::double precision) over readings_in_time as previous_bottom_temp,
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
  valid_intervals as (
    select
      (ordered.previous_created_at at time zone 'Europe/Helsinki')::date
        as helsinki_date,
      extract(
        hour from ordered.previous_created_at at time zone 'Europe/Helsinki'
      )::integer as helsinki_hour,
      ordered.previous_weighted_temperature - ordered.weighted_temperature
        as temperature_drop,
      extract(epoch from (ordered.created_at - ordered.previous_created_at)) / 60.0
        as valid_interval_minutes,
      (
        v_top_mass_kg * v_specific_heat_kwh_per_kg_c *
          (ordered.previous_top_temp - ordered.top_temp)
        +
        v_bottom_mass_kg * v_specific_heat_kwh_per_kg_c *
          (ordered.previous_bottom_temp - ordered.bottom_temp)
      )::double precision as physical_energy_drop_kwh
    from ordered_readings as ordered
    where ordered.previous_created_at is not null
      and ordered.previous_weighted_temperature is not null
      and ordered.weighted_temperature is not null
      and ordered.previous_top_temp is not null
      and ordered.previous_bottom_temp is not null
      and ordered.top_temp is not null
      and ordered.bottom_temp is not null
      and ordered.previous_heating is false
      and ordered.heating is false
      and ordered.created_at > ordered.previous_created_at
      and ordered.created_at - ordered.previous_created_at <= interval '30 minutes'
  ),
  daily_temperature_drops as (
    select
      interval_row.helsinki_date,
      interval_row.helsinki_hour,
      sum(interval_row.temperature_drop)::double precision as daily_drop
    from valid_intervals interval_row
    where interval_row.temperature_drop > 0
    group by interval_row.helsinki_date, interval_row.helsinki_hour
  ),
  daily_energy_losses as (
    select
      interval_row.helsinki_date,
      interval_row.helsinki_hour,
      greatest(
        sum(interval_row.physical_energy_drop_kwh)::double precision,
        0::double precision
      ) * (
        60.0 /
        sum(interval_row.valid_interval_minutes)::double precision
      ) as daily_energy_loss_kwh,
      sum(interval_row.valid_interval_minutes)::double precision
        as valid_minutes
    from valid_intervals interval_row
    group by interval_row.helsinki_date, interval_row.helsinki_hour
    having sum(interval_row.valid_interval_minutes) >= 55
  ),
  temperature_statistics as (
    select
      daily.helsinki_hour,
      count(*)::integer as observation_days,
      percentile_cont(0.5) within group (order by daily.daily_drop)
        ::double precision as median_drop
    from daily_temperature_drops daily
    group by daily.helsinki_hour
  ),
  energy_statistics as (
    select
      daily.helsinki_hour,
      count(*)::integer as observation_days,
      percentile_cont(0.5) within group (order by daily.daily_energy_loss_kwh)
        ::double precision as median_energy_loss_kwh
    from daily_energy_losses daily
    group by daily.helsinki_hour
  ),
  temperature_fallback as (
    select coalesce(
      percentile_cont(0.5) within group (
        order by stats.median_drop
      )::double precision,
      v_temperature_fallback
    ) as general_fallback
    from temperature_statistics stats
    where stats.observation_days >= v_minimum_observation_days
  ),
  energy_fallback as (
    select coalesce(
      percentile_cont(0.5) within group (
        order by stats.median_energy_loss_kwh
      )::double precision,
      v_energy_fallback
    ) as general_energy_loss_kwh
    from energy_statistics stats
    where stats.observation_days >= v_minimum_observation_days
  ),
  previous_profile as (
    select
      profile.hourly_drops
    from public.temperature_drop_profiles profile
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
            when coalesce(temp.observation_days, 0)
              >= v_minimum_observation_days
            then temp.median_drop
            else coalesce(
              (previous.hourly_drops ->> hour_number::text)::double precision,
              temp_fallback.general_fallback,
              v_temperature_fallback
            )
          end
        )
        order by hour_number
      ) as hourly_drops,
      jsonb_object_agg(
        hour_number::text,
        to_jsonb(
          case
            when coalesce(energy.observation_days, 0)
              >= v_minimum_observation_days
            then energy.median_energy_loss_kwh
            else coalesce(
              energy_fallback.general_energy_loss_kwh,
              v_energy_fallback
            )
          end
        )
        order by hour_number
      ) as hourly_energy_losses_kwh,
      jsonb_object_agg(
        hour_number::text,
        to_jsonb(coalesce(temp.observation_days, 0))
        order by hour_number
      ) as observation_days_by_hour,
      temp_fallback.general_fallback,
      energy_fallback.general_energy_loss_kwh
    from generate_series(0, 23) as hour_number
    left join temperature_statistics temp
      on temp.helsinki_hour = hour_number
    left join energy_statistics energy
      on energy.helsinki_hour = hour_number
    cross join temperature_fallback temp_fallback
    cross join energy_fallback energy_fallback
    left join previous_profile previous on true
    group by
      temp_fallback.general_fallback,
      energy_fallback.general_energy_loss_kwh
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
    hourly_energy_losses_kwh,
    general_energy_loss_kwh,
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
    complete.hourly_energy_losses_kwh,
    complete.general_energy_loss_kwh,
    'weighted-70-30-v1+physical-kwh-v3'
  from complete_profile complete
  on conflict (profile_date, timezone) do update
  set
    source_start = excluded.source_start,
    source_end = excluded.source_end,
    source_days = excluded.source_days,
    hourly_drops = excluded.hourly_drops,
    observation_days_by_hour = excluded.observation_days_by_hour,
    general_fallback = excluded.general_fallback,
    hourly_energy_losses_kwh = excluded.hourly_energy_losses_kwh,
    general_energy_loss_kwh = excluded.general_energy_loss_kwh,
    algorithm_version = excluded.algorithm_version,
    created_at = now();
end;
$function$;

-- Backfill today's row immediately from the already-collected V2-geometry
-- history so production does not need to wait for the weekly cron.
select public.recalculate_temperature_drop_profile();

create or replace function public.publish_v2_heating_plans_staged_with_cutover_state(
  p_plans jsonb,
  p_expected_plan_versions jsonb,
  p_expected_tank_snapshot jsonb,
  p_expected_tank_replay jsonb,
  p_expected_water_draw_snapshot jsonb,
  p_expected_settings_snapshot jsonb,
  p_constraint_plan_dates jsonb,
  p_expected_constraint_plans jsonb,
  p_expected_price_snapshot jsonb,
  p_price_fetch_end_at timestamptz,
  p_replay_start_at timestamptz,
  p_replay_end_at timestamptz,
  p_published_at timestamptz,
  p_forecast_horizon_end_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  publication_result text;
  cutover_enabled boolean;
  expected_profile jsonb;
  latest_profile public.temperature_drop_profiles%rowtype;
begin
  expected_profile := p_expected_settings_snapshot -> 'temperature_drop_profile';

  lock table public.temperature_drop_profiles in share mode;

  if expected_profile is null or expected_profile = 'null'::jsonb then
    if exists (
      select 1
      from public.temperature_drop_profiles
      where timezone = 'Europe/Helsinki'
    ) then
      cutover_enabled := public.get_v2_publication_cutover_enabled();
      return jsonb_build_object(
        'result', 'temperature_drop_profile_conflict',
        'cutover_enabled', cutover_enabled
      );
    end if;
  else
    if jsonb_typeof(expected_profile) <> 'object' then
      cutover_enabled := public.get_v2_publication_cutover_enabled();
      return jsonb_build_object(
        'result', 'temperature_drop_profile_conflict',
        'cutover_enabled', cutover_enabled
      );
    end if;

    select *
    into latest_profile
    from public.temperature_drop_profiles
    where timezone = 'Europe/Helsinki'
    order by profile_date desc, created_at desc
    limit 1;

    if not found then
      cutover_enabled := public.get_v2_publication_cutover_enabled();
      return jsonb_build_object(
        'result', 'temperature_drop_profile_conflict',
        'cutover_enabled', cutover_enabled
      );
    end if;

    begin
      if latest_profile.id::text is distinct from expected_profile ->> 'id'
        or latest_profile.profile_date is distinct from (expected_profile ->> 'profile_date')::date
        or latest_profile.timezone is distinct from expected_profile ->> 'timezone'
        or latest_profile.source_start is distinct from (expected_profile ->> 'source_start')::timestamptz
        or latest_profile.source_end is distinct from (expected_profile ->> 'source_end')::timestamptz
        or latest_profile.source_days is distinct from (expected_profile ->> 'source_days')::integer
        or latest_profile.hourly_drops is distinct from expected_profile -> 'hourly_drops'
        or latest_profile.observation_days_by_hour is distinct from expected_profile -> 'observation_days_by_hour'
        or latest_profile.general_fallback is distinct from (expected_profile ->> 'general_fallback')::double precision
        or latest_profile.hourly_energy_losses_kwh is distinct from expected_profile -> 'hourly_energy_losses_kwh'
        or latest_profile.general_energy_loss_kwh is distinct from (expected_profile ->> 'general_energy_loss_kwh')::double precision
        or latest_profile.algorithm_version is distinct from expected_profile ->> 'algorithm_version'
        or latest_profile.created_at is distinct from (expected_profile ->> 'created_at')::timestamptz
      then
        cutover_enabled := public.get_v2_publication_cutover_enabled();
        return jsonb_build_object(
          'result', 'temperature_drop_profile_conflict',
          'cutover_enabled', cutover_enabled
        );
      end if;
    exception when others then
      cutover_enabled := public.get_v2_publication_cutover_enabled();
      return jsonb_build_object(
        'result', 'temperature_drop_profile_conflict',
        'cutover_enabled', cutover_enabled
      );
    end;
  end if;

  publication_result := public.publish_v2_heating_plans_staged(
    p_plans,
    p_expected_plan_versions,
    p_expected_tank_snapshot,
    p_expected_tank_replay,
    p_expected_water_draw_snapshot,
    p_expected_settings_snapshot,
    p_constraint_plan_dates,
    p_expected_constraint_plans,
    p_expected_price_snapshot,
    p_price_fetch_end_at,
    p_replay_start_at,
    p_replay_end_at,
    p_published_at,
    p_forecast_horizon_end_at
  );

  cutover_enabled := public.get_v2_publication_cutover_enabled();

  return jsonb_build_object(
    'result', publication_result,
    'cutover_enabled', cutover_enabled
  );
end;
$function$;

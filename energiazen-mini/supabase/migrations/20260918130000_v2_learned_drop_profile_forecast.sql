-- V2 production forecast now consumes the learned 30-day hourly
-- temperature-drop profile. Persist which profile influenced each run and
-- bind staged publication to the exact latest profile under the same
-- transaction lock as the rest of the publication snapshot.
alter table public.v2_energy_reserve_shadow_runs
  add column if not exists learned_drop_profile_used boolean,
  add column if not exists learned_drop_profile_date date,
  add column if not exists learned_drop_profile_age_days double precision,
  add column if not exists maximum_modeled_loss_kwh_per_hour double precision;

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

  -- The profile is an optimizer input, so it must not change between planning
  -- and staged publication. SHARE prevents the weekly recalculation from
  -- replacing the latest profile until this publication transaction ends.
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

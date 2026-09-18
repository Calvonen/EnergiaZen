-- Fix V2 learned-profile CAS to compare stable row-version fields instead of
-- floating-point JSONB payloads rebuilt by the Edge Function.
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
      -- The learned profile contains floating-point JSON values. Rebuilding the
      -- snapshot through JavaScript can change their textual representation
      -- without changing the actual profile. Use stable row-version fields for
      -- CAS instead of exact JSONB equality. The recalculation path always
      -- updates created_at/source_end and the row is SHARE-locked here.
      if latest_profile.id::text is distinct from expected_profile ->> 'id'
        or latest_profile.profile_date is distinct from (expected_profile ->> 'profile_date')::date
        or latest_profile.timezone is distinct from expected_profile ->> 'timezone'
        or latest_profile.source_end is distinct from (expected_profile ->> 'source_end')::timestamptz
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

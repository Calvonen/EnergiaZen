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
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  publication_result text;
  cutover_enabled boolean;
begin
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

  -- publish_v2_heating_plans_staged() takes a lock on
  -- v2_heating_plan_publications that is retained to transaction end. Reading
  -- the trigger state here therefore cannot race an ENABLE/DISABLE TRIGGER
  -- operation between publication and this audit result.
  cutover_enabled := public.get_v2_publication_cutover_enabled();

  return jsonb_build_object(
    'result', publication_result,
    'cutover_enabled', cutover_enabled
  );
end;
$$;

revoke all on function public.publish_v2_heating_plans_staged_with_cutover_state(
  jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,
  timestamptz,timestamptz,timestamptz,timestamptz,timestamptz
) from public, anon, authenticated;

grant execute on function public.publish_v2_heating_plans_staged_with_cutover_state(
  jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,
  timestamptz,timestamptz,timestamptz,timestamptz,timestamptz
) to service_role;

comment on function public.publish_v2_heating_plans_staged_with_cutover_state(
  jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,
  timestamptz,timestamptz,timestamptz,timestamptz,timestamptz
) is
  'Publishes the staged V2 plan and returns the production mirror-trigger state from the same transaction for race-free audit telemetry.';

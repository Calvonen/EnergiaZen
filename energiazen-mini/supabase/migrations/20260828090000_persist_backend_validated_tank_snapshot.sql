-- Persist the exact tank_readings row used by each successfully validated
-- backend optimizer run so client diagnostics can correlate against the same
-- input snapshot instead of relying only on validation ordering.

alter table public.backend_heating_optimizer_state
  add column if not exists validated_tank_reading_at timestamptz;

do $$
begin
  if to_regprocedure(
    'public.publish_backend_heating_optimizer_plans(uuid,timestamp with time zone,jsonb,jsonb,jsonb,jsonb,jsonb,timestamp with time zone,text,date,integer[],text)'
  ) is not null and to_regprocedure(
    'public.publish_backend_heating_optimizer_plans_without_tank_identity(uuid,timestamp with time zone,jsonb,jsonb,jsonb,jsonb,jsonb,timestamp with time zone,text,date,integer[],text)'
  ) is null then
    alter function public.publish_backend_heating_optimizer_plans(
      uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz,
      text, date, integer[], text
    ) rename to publish_backend_heating_optimizer_plans_without_tank_identity;
  end if;
end;
$$;

revoke all on function public.publish_backend_heating_optimizer_plans_without_tank_identity(
  uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz,
  text, date, integer[], text
) from public, anon, authenticated, service_role;

alter function public.publish_backend_heating_optimizer_plans_without_tank_identity(
  uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz,
  text, date, integer[], text
) security invoker;

create or replace function public.publish_backend_heating_optimizer_plans(
  p_run_id uuid,
  p_run_started_at timestamptz,
  p_changed_plans jsonb,
  p_expected_settings jsonb,
  p_expected_plan_versions jsonb,
  p_expected_tank_snapshot jsonb,
  p_expected_price_snapshot jsonb,
  p_published_at timestamptz,
  p_publish_reason text,
  p_validated_plan_date date,
  p_validated_planned_hours integer[],
  p_validated_plan_fingerprint text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  result text;
  expected_created_at timestamptz;
begin
  if p_expected_tank_snapshot is null
    or jsonb_typeof(p_expected_tank_snapshot) <> 'object' then
    return 'tank_snapshot_conflict';
  end if;

  select snapshot.created_at
  into expected_created_at
  from jsonb_to_record(p_expected_tank_snapshot) as snapshot(
    created_at timestamptz
  );

  if expected_created_at is null then
    return 'tank_snapshot_conflict';
  end if;

  result := public.publish_backend_heating_optimizer_plans_without_tank_identity(
    p_run_id,
    p_run_started_at,
    p_changed_plans,
    p_expected_settings,
    p_expected_plan_versions,
    p_expected_tank_snapshot,
    p_expected_price_snapshot,
    p_published_at,
    p_publish_reason,
    p_validated_plan_date,
    p_validated_planned_hours,
    p_validated_plan_fingerprint
  );

  if result in ('published', 'no_changes') then
    update public.backend_heating_optimizer_state
    set validated_tank_reading_at = expected_created_at,
        updated_at = now()
    where id = 1
      and current_run_id = p_run_id
      and current_run_started_at = p_run_started_at;

    if not found then
      raise exception 'optimizer heartbeat ownership lost while persisting validated tank identity';
    end if;
  end if;

  return result;
end;
$$;

revoke all on function public.publish_backend_heating_optimizer_plans(
  uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz,
  text, date, integer[], text
) from public, anon, authenticated;

grant execute on function public.publish_backend_heating_optimizer_plans(
  uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz,
  text, date, integer[], text
) to service_role;

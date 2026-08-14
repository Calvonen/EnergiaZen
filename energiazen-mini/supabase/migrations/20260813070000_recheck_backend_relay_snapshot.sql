-- Recheck the optimizer's relay-state snapshot in the same transaction as
-- changed-plan publication or healthy no-change validation.

do $$
begin
  if to_regprocedure(
    'public.publish_backend_heating_optimizer_plans(uuid,timestamp with time zone,jsonb,jsonb,jsonb,timestamp with time zone,text,date,integer[],text)'
  ) is not null and to_regprocedure(
    'public.publish_backend_heating_optimizer_plans_checked_snapshots(uuid,timestamp with time zone,jsonb,jsonb,jsonb,timestamp with time zone,text,date,integer[],text)'
  ) is null then
    alter function public.publish_backend_heating_optimizer_plans(
      uuid,
      timestamptz,
      jsonb,
      jsonb,
      jsonb,
      timestamptz,
      text,
      date,
      integer[],
      text
    ) rename to publish_backend_heating_optimizer_plans_checked_snapshots;
  end if;
end;
$$;

revoke all on function public.publish_backend_heating_optimizer_plans_checked_snapshots(
  uuid,
  timestamptz,
  jsonb,
  jsonb,
  jsonb,
  timestamptz,
  text,
  date,
  integer[],
  text
) from public, anon, authenticated, service_role;

alter function public.publish_backend_heating_optimizer_plans_checked_snapshots(
  uuid,
  timestamptz,
  jsonb,
  jsonb,
  jsonb,
  timestamptz,
  text,
  date,
  integer[],
  text
) security invoker;

create or replace function public.publish_backend_heating_optimizer_plans(
  p_run_id uuid,
  p_run_started_at timestamptz,
  p_changed_plans jsonb,
  p_expected_settings jsonb,
  p_expected_plan_versions jsonb,
  p_expected_relay_snapshot jsonb,
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
  expected_relay_created_at timestamptz;
  expected_relay_heating boolean;
  latest_relay_created_at timestamptz;
begin
  if p_expected_relay_snapshot is null
    or jsonb_typeof(p_expected_relay_snapshot) <> 'object' then
    return 'relay_conflict';
  end if;

  select snapshot.created_at, snapshot.heating
  into expected_relay_created_at, expected_relay_heating
  from jsonb_to_record(p_expected_relay_snapshot) as snapshot(
    created_at timestamptz,
    heating boolean
  );

  -- Unknown relay state is never publication-ready, even if a caller tries
  -- to bypass the Edge Function's existing known-relay gate.
  if expected_relay_created_at is null or expected_relay_heating is null then
    return 'relay_conflict';
  end if;

  perform 1
  from public.backend_heating_optimizer_state
  where id = 1
    and current_run_id = p_run_id
    and current_run_started_at = p_run_started_at
  for update;

  if not found then
    return 'heartbeat_superseded';
  end if;

  -- SHARE blocks tank-reading inserts for the short remainder of this
  -- transaction, closing the gap between the relay recheck and the nested
  -- settings/plan checks plus write/healthy update.
  lock table public.tank_readings in share mode;

  select max(reading.created_at)
  into latest_relay_created_at
  from public.tank_readings reading
  where reading.created_at is not null;

  if latest_relay_created_at is null
    or latest_relay_created_at < expected_relay_created_at
    or not exists (
      select 1
      from public.tank_readings original_reading
      where original_reading.created_at = expected_relay_created_at
        and original_reading.heating is not distinct from expected_relay_heating
    )
    or exists (
      select 1
      from public.tank_readings latest_reading
      where latest_reading.created_at = latest_relay_created_at
        and latest_reading.heating is distinct from expected_relay_heating
    ) then
    return 'relay_conflict';
  end if;

  -- The renamed helper performs the existing heartbeat CAS, full settings
  -- snapshot, plan snapshot, optional plan writes and healthy update. A
  -- nested function call remains in this transaction and retains both locks.
  return public.publish_backend_heating_optimizer_plans_checked_snapshots(
    p_run_id,
    p_run_started_at,
    p_changed_plans,
    p_expected_settings,
    p_expected_plan_versions,
    p_published_at,
    p_publish_reason,
    p_validated_plan_date,
    p_validated_planned_hours,
    p_validated_plan_fingerprint
  );
end;
$$;

revoke all on function public.publish_backend_heating_optimizer_plans(
  uuid,
  timestamptz,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  timestamptz,
  text,
  date,
  integer[],
  text
) from public, anon, authenticated;
grant execute on function public.publish_backend_heating_optimizer_plans(
  uuid,
  timestamptz,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  timestamptz,
  text,
  date,
  integer[],
  text
) to service_role;

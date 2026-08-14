-- Recheck all current tank values and exactly the 60-minute price rows used
-- by the optimizer before entering the existing relay/settings/plan-safe
-- publication and no-change validation chain.

do $$
begin
  if to_regprocedure(
    'public.publish_backend_heating_optimizer_plans(uuid,timestamp with time zone,jsonb,jsonb,jsonb,jsonb,timestamp with time zone,text,date,integer[],text)'
  ) is not null and to_regprocedure(
    'public.publish_backend_heating_optimizer_plans_checked_relay_snapshot(uuid,timestamp with time zone,jsonb,jsonb,jsonb,jsonb,timestamp with time zone,text,date,integer[],text)'
  ) is null then
    alter function public.publish_backend_heating_optimizer_plans(
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
    ) rename to publish_backend_heating_optimizer_plans_checked_relay_snapshot;
  end if;
end;
$$;

revoke all on function public.publish_backend_heating_optimizer_plans_checked_relay_snapshot(
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
) from public, anon, authenticated, service_role;

alter function public.publish_backend_heating_optimizer_plans_checked_relay_snapshot(
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
  expected_bottom_temp double precision;
  expected_created_at timestamptz;
  expected_heating boolean;
  expected_top_temp double precision;
  latest_created_at timestamptz;
  price_conflict_count integer;
begin
  if p_expected_tank_snapshot is null
    or jsonb_typeof(p_expected_tank_snapshot) <> 'object' then
    return 'tank_snapshot_conflict';
  end if;
  if p_expected_price_snapshot is null
    or jsonb_typeof(p_expected_price_snapshot) <> 'array'
    or jsonb_array_length(p_expected_price_snapshot) = 0 then
    return 'price_snapshot_conflict';
  end if;

  select
    snapshot.bottom_temp,
    snapshot.created_at,
    snapshot.heating,
    snapshot.top_temp
  into
    expected_bottom_temp,
    expected_created_at,
    expected_heating,
    expected_top_temp
  from jsonb_to_record(p_expected_tank_snapshot) as snapshot(
    bottom_temp double precision,
    created_at timestamptz,
    heating boolean,
    top_temp double precision
  );

  if expected_bottom_temp is null
    or expected_created_at is null
    or expected_heating is null
    or expected_top_temp is null then
    return 'tank_snapshot_conflict';
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

  -- Hold both input sets stable until the nested relay/settings/plan checks,
  -- optional writes and healthy heartbeat update have completed.
  lock table public.tank_readings in share mode;
  lock table public.electricity_prices in share mode;

  select max(reading.created_at)
  into latest_created_at
  from public.tank_readings reading
  where reading.created_at is not null;

  if latest_created_at is null
    or latest_created_at < expected_created_at
    or not exists (
      select 1
      from public.tank_readings original_reading
      where original_reading.created_at = expected_created_at
        and original_reading.heating is not distinct from expected_heating
        and original_reading.top_temp is not distinct from expected_top_temp
        and original_reading.bottom_temp is not distinct from expected_bottom_temp
    )
    or exists (
      select 1
      from public.tank_readings latest_reading
      where latest_reading.created_at = latest_created_at
        and (
          latest_reading.heating is distinct from expected_heating
          or latest_reading.top_temp is distinct from expected_top_temp
          or latest_reading.bottom_temp is distinct from expected_bottom_temp
        )
    ) then
    return 'tank_snapshot_conflict';
  end if;

  with expected as (
    select *
    from jsonb_to_recordset(p_expected_price_snapshot) as price(
      ends_at timestamptz,
      region text,
      resolution_minutes integer,
      spot_price_cents_kwh numeric,
      starts_at timestamptz
    )
  ),
  invalid_expected as (
    select 1
    from expected
    where ends_at is null
      or region <> 'FI'
      or resolution_minutes <> 60
      or spot_price_cents_kwh is null
      or starts_at is null
  ),
  duplicate_expected as (
    select region, starts_at, resolution_minutes
    from expected
    group by region, starts_at, resolution_minutes
    having count(*) > 1
  ),
  mismatches as (
    select expected.starts_at
    from expected
    left join public.electricity_prices current_price
      on current_price.region = expected.region
      and current_price.starts_at = expected.starts_at
      and current_price.resolution_minutes = expected.resolution_minutes
    where current_price.id is null
      or current_price.ends_at is distinct from expected.ends_at
      or current_price.spot_price_cents_kwh is distinct from expected.spot_price_cents_kwh
  ),
  all_conflicts as (
    select null::timestamptz as starts_at from invalid_expected
    union all
    select starts_at from duplicate_expected
    union all
    select starts_at from mismatches
  )
  select count(*) into price_conflict_count
  from all_conflicts;

  if price_conflict_count > 0 then
    return 'price_snapshot_conflict';
  end if;

  return public.publish_backend_heating_optimizer_plans_checked_relay_snapshot(
    p_run_id,
    p_run_started_at,
    p_changed_plans,
    p_expected_settings,
    p_expected_plan_versions,
    p_expected_tank_snapshot,
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
  jsonb,
  timestamptz,
  text,
  date,
  integer[],
  text
) to service_role;

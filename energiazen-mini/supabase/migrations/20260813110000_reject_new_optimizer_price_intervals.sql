-- Reject FI/60-minute rows that appeared inside the optimizer's relevant
-- today/tomorrow window after Edge built its canonical price snapshot.

do $$
begin
  if to_regprocedure(
    'public.publish_backend_heating_optimizer_plans(uuid,timestamp with time zone,jsonb,jsonb,jsonb,jsonb,jsonb,timestamp with time zone,text,date,integer[],text)'
  ) is not null and to_regprocedure(
    'public.publish_backend_heating_optimizer_plans_checked_price_members(uuid,timestamp with time zone,jsonb,jsonb,jsonb,jsonb,jsonb,timestamp with time zone,text,date,integer[],text)'
  ) is null then
    alter function public.publish_backend_heating_optimizer_plans(
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
    ) rename to publish_backend_heating_optimizer_plans_checked_price_members;
  end if;
end;
$$;

revoke all on function public.publish_backend_heating_optimizer_plans_checked_price_members(
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
) from public, anon, authenticated, service_role;

alter function public.publish_backend_heating_optimizer_plans_checked_price_members(
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
begin
  if p_expected_price_snapshot is null
    or jsonb_typeof(p_expected_price_snapshot) <> 'array'
    or jsonb_array_length(p_expected_price_snapshot) = 0
    or p_published_at is null
    or p_validated_plan_date is null then
    return 'price_snapshot_conflict';
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

  -- Block price inserts/updates until the nested full snapshot checks,
  -- optional plan writes and healthy update finish in this transaction.
  lock table public.electricity_prices in share mode;

  if exists (
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
    relevant_current as (
      select
        current_price.ends_at,
        current_price.region,
        current_price.resolution_minutes,
        current_price.spot_price_cents_kwh,
        current_price.starts_at
      from public.electricity_prices current_price
      where current_price.region = 'FI'
        and current_price.resolution_minutes = 60
        and (
          (
            (current_price.starts_at at time zone 'Europe/Helsinki')::date =
              p_validated_plan_date
            and current_price.ends_at > p_published_at
          )
          or (current_price.starts_at at time zone 'Europe/Helsinki')::date =
            p_validated_plan_date + 1
        )
    )
    select 1
    from relevant_current current_price
    left join expected
      on expected.region = current_price.region
      and expected.starts_at = current_price.starts_at
      and expected.ends_at = current_price.ends_at
      and expected.resolution_minutes = current_price.resolution_minutes
      and expected.spot_price_cents_kwh is not distinct from
        current_price.spot_price_cents_kwh
    where expected.starts_at is null
  ) then
    return 'price_snapshot_conflict';
  end if;

  -- The renamed helper checks expected -> current membership, tank values,
  -- then delegates to the existing settings/plan/write/healthy chain. Nested
  -- calls retain this transaction's heartbeat row and price table locks.
  return public.publish_backend_heating_optimizer_plans_checked_price_members(
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

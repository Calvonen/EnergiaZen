-- Recheck the full optimizer settings snapshot and the validated-today plan
-- snapshot inside backend-primary publication.

drop function if exists public.publish_backend_heating_optimizer_plans(
  uuid,
  timestamptz,
  jsonb,
  text,
  jsonb,
  timestamptz,
  text,
  date,
  integer[],
  text
);

create or replace function public.publish_backend_heating_optimizer_plans(
  p_run_id uuid,
  p_run_started_at timestamptz,
  p_changed_plans jsonb,
  p_expected_settings jsonb,
  p_expected_plan_versions jsonb,
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
  changed_plan_count integer;
  settings_mismatch_count integer;
  version_mismatch_count integer;
  written_plan_count integer;
begin
  if jsonb_typeof(p_changed_plans) <> 'array' then
    raise exception 'p_changed_plans must be a JSON array';
  end if;
  if jsonb_typeof(p_expected_plan_versions) <> 'array' then
    raise exception 'p_expected_plan_versions must be a JSON array';
  end if;

  changed_plan_count := jsonb_array_length(p_changed_plans);
  if changed_plan_count = 0 then
    raise exception 'publish_backend_heating_optimizer_plans requires at least one changed plan';
  end if;
  if jsonb_typeof(p_expected_settings) <> 'object' then
    return 'settings_conflict';
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

  -- Prevent a row that was absent in the Edge snapshot from appearing between
  -- the version recheck and the insert/upsert below.
  lock table public.heating_plans in share row exclusive mode;

  perform 1
  from public.heating_control_settings
  where id = 1
  for update;

  if not found then
    return 'settings_conflict';
  end if;

  with expected as (
    select *
    from jsonb_to_record(p_expected_settings) as settings(
      automatic_max_heating_hours integer,
      full_tank_average_temperature double precision,
      full_tank_showers double precision,
      heating_gain_source text,
      heating_need_mode text,
      max_tank_temperature double precision,
      min_tank_temperature double precision,
      safety_shower_reserve double precision,
      target_shower_reserve double precision,
      updated_at timestamptz
    )
  ),
  mismatches as (
    select 1
    from expected
    left join public.heating_control_settings current_settings
      on current_settings.id = 1
    where current_settings.id is null
      or current_settings.heating_need_mode <> 'automatic'
      or current_settings.heating_need_mode is distinct from expected.heating_need_mode
      or current_settings.automatic_max_heating_hours is distinct from expected.automatic_max_heating_hours
      or current_settings.safety_shower_reserve is distinct from expected.safety_shower_reserve
      or current_settings.target_shower_reserve is distinct from expected.target_shower_reserve
      or current_settings.full_tank_showers is distinct from expected.full_tank_showers
      or current_settings.full_tank_average_temperature is distinct from expected.full_tank_average_temperature
      or current_settings.min_tank_temperature is distinct from expected.min_tank_temperature
      or current_settings.max_tank_temperature is distinct from expected.max_tank_temperature
      or current_settings.heating_gain_source is distinct from expected.heating_gain_source
      or current_settings.updated_at is distinct from expected.updated_at
  )
  select count(*) into settings_mismatch_count
  from mismatches;

  if settings_mismatch_count > 0 then
    return 'settings_conflict';
  end if;

  with expected as (
    select *
    from jsonb_to_recordset(p_expected_plan_versions) as version(
      plan_date date,
      existed boolean,
      expected_updated_at timestamptz
    )
  ),
  changed as (
    select *
    from jsonb_to_recordset(p_changed_plans) as plan(
      plan_date date
    )
  ),
  duplicate_expected as (
    select plan_date
    from expected
    group by plan_date
    having count(*) > 1
  ),
  missing_expected_for_changed as (
    select changed.plan_date
    from changed
    left join expected using (plan_date)
    where expected.plan_date is null
  ),
  missing_validated_today as (
    select 1
    where not exists (
      select 1
      from expected
      where plan_date = p_validated_plan_date
    )
  ),
  mismatches as (
    select expected.plan_date
    from expected
    left join public.heating_plans current_plan
      on current_plan.plan_date = expected.plan_date
    where (
        expected.existed
        and (
          current_plan.plan_date is null
          or current_plan.updated_at is distinct from expected.expected_updated_at
        )
      )
      or (
        not expected.existed
        and current_plan.plan_date is not null
      )
  ),
  all_conflicts as (
    select plan_date from duplicate_expected
    union all
    select plan_date from missing_expected_for_changed
    union all
    select null::date from missing_validated_today
    union all
    select plan_date from mismatches
  )
  select count(*) into version_mismatch_count
  from all_conflicts;

  if version_mismatch_count > 0 then
    return 'plan_conflict';
  end if;

  insert into public.heating_plans (
    mode,
    plan_date,
    planned_hours,
    reason,
    target_hours,
    updated_at
  )
  select
    plan.mode,
    plan.plan_date,
    coalesce(
      array(
        select value::integer
        from jsonb_array_elements_text(plan.planned_hours) as value
        order by value::integer
      ),
      array[]::integer[]
    ),
    plan.reason,
    plan.target_hours,
    plan.updated_at
  from jsonb_to_recordset(p_changed_plans) as plan(
    mode text,
    plan_date date,
    planned_hours jsonb,
    reason text,
    target_hours integer,
    updated_at timestamptz
  )
  on conflict (plan_date) do update
  set mode = excluded.mode,
      planned_hours = excluded.planned_hours,
      reason = excluded.reason,
      target_hours = excluded.target_hours,
      updated_at = excluded.updated_at;

  get diagnostics written_plan_count = row_count;
  if written_plan_count <> changed_plan_count then
    raise exception 'published % changed heating plan rows, expected %',
      written_plan_count,
      changed_plan_count;
  end if;

  update public.backend_heating_optimizer_state
  set health_status = 'healthy',
      last_outcome = 'published',
      reason = p_publish_reason,
      last_published_at = p_published_at,
      last_validated_plan_at = p_published_at,
      validated_plan_date = p_validated_plan_date,
      validated_planned_hours = p_validated_planned_hours,
      validated_plan_fingerprint = p_validated_plan_fingerprint,
      updated_at = now()
  where id = 1
    and current_run_id = p_run_id
    and current_run_started_at = p_run_started_at;

  return 'published';
end;
$$;

revoke all on function public.publish_backend_heating_optimizer_plans(
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
) from public, anon, authenticated;
grant execute on function public.publish_backend_heating_optimizer_plans(
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
) to service_role;

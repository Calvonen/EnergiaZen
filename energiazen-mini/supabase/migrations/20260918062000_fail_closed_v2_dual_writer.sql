create or replace function public.mirror_v2_heating_plan_to_production()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  configured_mode text;
  planning_date date;
  mirrored_hours smallint[];
  production_hours smallint[];
  production_mode text;
  v1_optimizer_active boolean;
begin
  if tg_op = 'DELETE' then
    select heating_need_mode into configured_mode
    from public.heating_control_settings
    where id = 1;

    if configured_mode = 'automatic' then
      select exists (
        select 1
        from cron.job
        where jobname = 'run-heating-optimizer-shadow-hourly'
          and active
      ) into v1_optimizer_active;

      if not v1_optimizer_active then
        delete from public.heating_plans
        where plan_date = old.plan_date
          and mode = 'automatic'
          and reason = 'V2 energy plan';
      end if;
    end if;

    return old;
  end if;

  -- Fixed mode remains app-owned. V2 staging may continue for diagnostics,
  -- but it must never overwrite a fixed/manual production plan.
  select heating_need_mode into configured_mode
  from public.heating_control_settings
  where id = 1;

  if configured_mode is distinct from 'automatic' then
    return new;
  end if;

  -- Fail closed if the legacy automatic optimizer has been re-enabled.
  -- Ownership telemetry reports this as a conflict, and the mirror refuses to
  -- create a second automatic writer until V1 is disabled again.
  select exists (
    select 1
    from cron.job
    where jobname = 'run-heating-optimizer-shadow-hourly'
      and active
  ) into v1_optimizer_active;

  if v1_optimizer_active then
    return new;
  end if;

  mirrored_hours := coalesce(
    array(
      select distinct h::smallint
      from unnest(new.planned_hours) as h
      where h between 0 and 23
      order by h::smallint
    ),
    '{}'::smallint[]
  );

  insert into public.heating_plans(
    plan_date,
    planned_hours,
    target_hours,
    mode,
    reason,
    timezone,
    updated_at
  )
  values (
    new.plan_date,
    mirrored_hours,
    cardinality(mirrored_hours)::smallint,
    'automatic',
    'V2 energy plan',
    'Europe/Helsinki',
    new.published_at
  )
  on conflict (plan_date) do update
  set planned_hours = excluded.planned_hours,
      target_hours = excluded.target_hours,
      mode = excluded.mode,
      reason = excluded.reason,
      timezone = excluded.timezone,
      updated_at = excluded.updated_at
  where public.heating_plans.mode = 'automatic';

  select planned_hours, mode
    into production_hours, production_mode
  from public.heating_plans
  where plan_date = new.plan_date;

  if production_mode is distinct from 'automatic'
     or production_hours is distinct from mirrored_hours then
    return new;
  end if;

  planning_date := (new.published_at at time zone 'Europe/Helsinki')::date;

  if new.plan_date = planning_date then
    update public.backend_heating_optimizer_state
    set last_run_attempt_at = new.published_at,
        last_validated_plan_at = new.published_at,
        last_published_at = new.published_at,
        health_status = 'healthy',
        last_outcome = 'published',
        reason = 'v2_energy_plan_cutover',
        updated_at = new.published_at,
        current_run_id = null,
        current_run_started_at = null,
        validated_plan_date = new.plan_date,
        validated_planned_hours = mirrored_hours,
        validated_plan_fingerprint = new.plan_date::text || '|' || array_to_string(mirrored_hours, ','),
        validated_tank_reading_at = new.anchor_tank_reading_at
    where id = 1;
  end if;

  return new;
end;
$$;

revoke all on function public.mirror_v2_heating_plan_to_production() from public, anon, authenticated;
grant execute on function public.mirror_v2_heating_plan_to_production() to service_role;

comment on function public.mirror_v2_heating_plan_to_production() is
  'Mirrors validated V2 staged plans to production only in automatic mode and only when the legacy V1 optimizer cron is inactive.';

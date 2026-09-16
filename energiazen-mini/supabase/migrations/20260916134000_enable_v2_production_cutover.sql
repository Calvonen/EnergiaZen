-- V2 production cutover.
--
-- The V2 edge function continues to publish through the already-reviewed
-- publish_v2_heating_plans_staged() transaction. This trigger mirrors only a
-- successfully committed staged publication into the existing heating_plans
-- control plane, so the app and Shelly keep one authoritative table during the
-- cutover. The old V1 optimizer cron is disabled in the same migration to avoid
-- two automatic writers racing each other.
--
-- Rollback is intentionally simple:
--   select cron.alter_job(jobid, active := true)
--   from cron.job where jobname = 'run-heating-optimizer-shadow-hourly';
--   drop trigger if exists mirror_v2_heating_plan_to_production on public.v2_heating_plan_publications;
-- Existing heating_plans rows remain usable by V1 after rollback.

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
begin
  if tg_op = 'DELETE' then
    select heating_need_mode into configured_mode
    from public.heating_control_settings
    where id = 1;

    if configured_mode = 'automatic' then
      delete from public.heating_plans
      where plan_date = old.plan_date
        and mode = 'automatic'
        and reason = 'V2 energy plan';
    end if;

    return old;
  end if;

  -- Fixed mode remains app-owned. A V2 staging publication may continue for
  -- diagnostics, but must never overwrite a fixed/manual production plan.
  select heating_need_mode into configured_mode
  from public.heating_control_settings
  where id = 1;

  if configured_mode is distinct from 'automatic' then
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
  -- Never replace a fixed row even if settings and plan rows are briefly out
  -- of sync during a mode change.
  where public.heating_plans.mode = 'automatic';

  select planned_hours, mode
    into production_hours, production_mode
  from public.heating_plans
  where plan_date = new.plan_date;

  if production_mode is distinct from 'automatic'
     or production_hours is distinct from mirrored_hours then
    -- Production row was protected (for example fixed mode). Do not refresh
    -- Shelly trust for a plan that did not actually become authoritative.
    return new;
  end if;

  planning_date := (new.published_at at time zone 'Europe/Helsinki')::date;

  -- Shelly validates today's heating_plans row against this heartbeat. Refresh
  -- it only from a successfully mirrored V2 publication. If V2 stops producing
  -- valid staged plans, this timestamp naturally ages out and Shelly falls back
  -- instead of trusting an indefinitely stale plan.
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

drop trigger if exists mirror_v2_heating_plan_to_production
  on public.v2_heating_plan_publications;

create trigger mirror_v2_heating_plan_to_production
after insert or update or delete
on public.v2_heating_plan_publications
for each row
execute function public.mirror_v2_heating_plan_to_production();

-- V2 becomes the sole automatic publisher. Keep the job definition in place
-- but inactive so rollback does not require reconstructing its schedule/body.
select cron.alter_job(jobid, active := false)
from cron.job
where jobname = 'run-heating-optimizer-shadow-hourly';

-- Seed the production control plane from the latest staged rows. UPDATE fires
-- the trigger without changing V2 publication timestamps, so Shelly receives
-- the exact staged plan and exact V2 validation time rather than a fabricated
-- fresh timestamp. A stale staged row therefore remains stale and fails closed.
update public.v2_heating_plan_publications
set updated_at = updated_at
where plan_date in (
  (now() at time zone 'Europe/Helsinki')::date,
  (now() at time zone 'Europe/Helsinki')::date + 1
);

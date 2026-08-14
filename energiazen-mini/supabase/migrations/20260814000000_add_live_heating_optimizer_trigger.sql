-- Live backend-primary trigger for publication-relevant input changes.
--
-- Codex P1 (PR #193): with app-side automatic publication disabled in
-- backend-primary mode, the hourly cron
-- (20260813080000_authenticate_heating_optimizer_cron.sql) was the ONLY
-- thing that could ever re-run the optimizer, so a tank reading or an
-- automatic setting change could sit unpublished for up to an hour. This
-- migration adds a second, input-driven path that requests the same run
-- sooner, while keeping the hourly cron exactly as-is for fallback and
-- reconciliation.
--
-- Design:
--   - Both new triggers call the SAME authenticated HTTP path the cron job
--     already uses: same project URL, same private
--     'heating_optimizer_cron_secret' header (checked by
--     isHeatingOptimizerCronSecretAuthorized in index.ts - the publishable
--     key alone is never sufficient), same run-heating-optimizer Edge
--     Function. This migration adds no new write surface into
--     heating_plans/heartbeat - it only asks the existing, already-hardened
--     pipeline to run sooner. Every CAS/snapshot/fail-safe protection added
--     across PR #193 applies identically to a request made this way.
--   - Debounce/coalescing: a singleton state row tracks the last dispatch
--     time. A request inside the debounce window only records a pending
--     flag instead of dispatching a second HTTP call. tank_readings land
--     roughly once a minute (README.md), so once the window elapses the
--     very next reading (or the next relevant settings change, or - worst
--     case - the existing hourly cron) becomes the trailing dispatch.
--     Nothing about the original event needs to be replayed: every dispatch
--     reads current tank/settings/price/plan data at call time.
--   - Trigger loop safety: the triggers below are only attached to
--     tank_readings and heating_control_settings, both of which
--     run-heating-optimizer only ever READS. It writes exclusively to
--     heating_plan_shadow_runs, backend_heating_optimizer_state and
--     heating_plans (via publish_backend_heating_optimizer_plans) - none of
--     those tables carry a trigger from this migration, so a
--     triggered run cannot re-trigger itself.
--   - Fail-safe: any error while requesting a run (missing Vault secret,
--     net.http_post failure, etc.) is caught inside the dispatch function
--     and logged as a WARNING, so it can never fail or roll back the
--     tank_readings insert / heating_control_settings update that fired it.

create table if not exists public.backend_heating_optimizer_trigger_state (
  id smallint primary key default 1 check (id = 1),
  last_dispatch_requested_at timestamptz,
  pending boolean not null default false,
  pending_reason text,
  pending_since timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.backend_heating_optimizer_trigger_state enable row level security;

-- No anon/authenticated policies: this table is only ever touched by the
-- SECURITY DEFINER dispatch function below, never directly by clients or
-- devices.

insert into public.backend_heating_optimizer_trigger_state (id)
values (1)
on conflict (id) do nothing;

create or replace function public.request_backend_heating_optimizer_run(
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_debounce_window constant interval := interval '30 seconds';
  v_last_dispatch timestamptz;
  v_project_url text;
  v_cron_secret text;
  v_publishable_key text;
begin
  select last_dispatch_requested_at
  into v_last_dispatch
  from public.backend_heating_optimizer_trigger_state
  where id = 1
  for update;

  if v_last_dispatch is not null and now() - v_last_dispatch < v_debounce_window then
    update public.backend_heating_optimizer_trigger_state
    set pending = true,
        pending_reason = p_reason,
        pending_since = coalesce(pending_since, now()),
        updated_at = now()
    where id = 1;
    return;
  end if;

  update public.backend_heating_optimizer_trigger_state
  set last_dispatch_requested_at = now(),
      pending = false,
      pending_reason = null,
      pending_since = null,
      updated_at = now()
  where id = 1;

  select rtrim(decrypted_secret, '/') into v_project_url
  from vault.decrypted_secrets
  where name = 'project_url'
  limit 1;

  select decrypted_secret into v_cron_secret
  from vault.decrypted_secrets
  where name = 'heating_optimizer_cron_secret'
  limit 1;

  select decrypted_secret into v_publishable_key
  from vault.decrypted_secrets
  where name = 'publishable_key'
  limit 1;

  if v_project_url is null or v_cron_secret is null or v_publishable_key is null then
    raise warning 'request_backend_heating_optimizer_run: missing project_url/heating_optimizer_cron_secret/publishable_key Vault secret, skipping dispatch (reason=%)', p_reason;
    return;
  end if;

  perform net.http_post(
    url := v_project_url || '/functions/v1/run-heating-optimizer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_publishable_key,
      'Authorization', 'Bearer ' || v_publishable_key,
      'x-energyzen-cron-secret', v_cron_secret,
      'x-energyzen-trigger-reason', p_reason
    ),
    body := '{}'::jsonb
  );
exception
  when others then
    raise warning 'request_backend_heating_optimizer_run: dispatch failed for reason=%: %', p_reason, sqlerrm;
end;
$$;

revoke all on function public.request_backend_heating_optimizer_run(text) from public, anon, authenticated;
grant execute on function public.request_backend_heating_optimizer_run(text) to service_role;

create or replace function public.trigger_backend_heating_optimizer_on_tank_reading()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.request_backend_heating_optimizer_run('tank_reading_inserted');
  return null;
end;
$$;

revoke all on function public.trigger_backend_heating_optimizer_on_tank_reading() from public, anon, authenticated;

drop trigger if exists trg_backend_heating_optimizer_tank_reading on public.tank_readings;
create trigger trg_backend_heating_optimizer_tank_reading
after insert on public.tank_readings
for each row
execute function public.trigger_backend_heating_optimizer_on_tank_reading();

create or replace function public.trigger_backend_heating_optimizer_on_settings_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.request_backend_heating_optimizer_run('heating_control_settings_changed');
  return null;
end;
$$;

revoke all on function public.trigger_backend_heating_optimizer_on_settings_change() from public, anon, authenticated;

-- Fire only when an optimizer-relevant column is both targeted by the
-- UPDATE and actually changes value - matches every field
-- resolveOptimizerSettings/runBackendHeatingOptimization reads from
-- heating_control_settings (see RawHeatingControlSettingsRow in logic.ts).
drop trigger if exists trg_backend_heating_optimizer_settings_change on public.heating_control_settings;
create trigger trg_backend_heating_optimizer_settings_change
after update of
  automatic_max_heating_hours,
  full_tank_average_temperature,
  full_tank_showers,
  heating_gain_source,
  heating_need_mode,
  max_tank_temperature,
  min_tank_temperature,
  safety_shower_reserve,
  target_shower_reserve
on public.heating_control_settings
for each row
when (
  old.automatic_max_heating_hours is distinct from new.automatic_max_heating_hours
  or old.full_tank_average_temperature is distinct from new.full_tank_average_temperature
  or old.full_tank_showers is distinct from new.full_tank_showers
  or old.heating_gain_source is distinct from new.heating_gain_source
  or old.heating_need_mode is distinct from new.heating_need_mode
  or old.max_tank_temperature is distinct from new.max_tank_temperature
  or old.min_tank_temperature is distinct from new.min_tank_temperature
  or old.safety_shower_reserve is distinct from new.safety_shower_reserve
  or old.target_shower_reserve is distinct from new.target_shower_reserve
)
execute function public.trigger_backend_heating_optimizer_on_settings_change();

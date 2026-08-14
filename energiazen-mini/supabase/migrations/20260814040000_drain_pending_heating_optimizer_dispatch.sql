-- Codex P1 follow-up (PR #193, third live-trigger finding): a material
-- tank change that arrived inside the 5-minute cooldown only ever set
-- pending = true - nothing ever drained it once the cooldown elapsed.
-- Combined with trigger_backend_heating_optimizer_on_tank_reading()
-- advancing backend_heating_optimizer_tank_trigger_baseline BEFORE the
-- (possibly coalesced) dispatch call, a coalesced material change whose
-- baseline had already moved could go completely undispatched if
-- subsequent readings stayed near that new baseline: no later reading
-- would ever look "material" again relative to it, so nothing would ever
-- re-request a run, and the change would silently wait for the hourly
-- cron fallback (up to ~55 more minutes) instead of getting the
-- guaranteed trailing run this trigger exists to provide.
--
-- This migration makes pending state self-draining and time-based instead
-- of depending on a future trigger event:
--   - min_interval moves from a per-call SQL literal into a persisted
--     column on backend_heating_optimizer_trigger_debounce, so both the
--     request path and the new drain path agree on exactly one definition
--     of each key's cooldown - no second, independently-maintained copy
--     of "5 minutes"/"30 seconds" to drift out of sync.
--   - The actual authenticated HTTP dispatch is factored out into
--     dispatch_backend_heating_optimizer_run(), reused unchanged by both
--     the immediate-dispatch path and the new drain path - so a drained
--     run authenticates and calls run-heating-optimizer exactly like every
--     other dispatch already does.
--   - drain_pending_backend_heating_optimizer_dispatch() is scheduled via
--     pg_cron every minute: it dispatches (and clears pending on) any
--     debounce_key still pending once now() - last_dispatch_requested_at
--     >= that key's own min_interval. This guarantees the trailing run
--     the earlier migration's comment promised but never actually
--     implemented, independent of whether any later tank_readings insert
--     or heating_control_settings update ever arrives. Because pending is
--     a single boolean per key, any number of material changes coalesced
--     during one cooldown window still produce exactly one trailing
--     dispatch. Settings and tank keys drain independently by design (each
--     row's own min_interval), so a pending settings dispatch is never
--     held up by the unrelated tank cooldown, and vice versa.
--
-- Nothing about authorization, the heartbeat CAS, or the hourly cron
-- fallback changes: the drain path calls the exact same
-- dispatch_backend_heating_optimizer_run() - same project_url, same
-- private heating_optimizer_cron_secret header, same run-heating-optimizer
-- Edge Function - and run-heating-optimizer's own
-- begin_backend_heating_optimizer_run/complete_backend_heating_optimizer_run
-- CAS (20260813010000_harden_backend_optimizer_heartbeat.sql) is untouched
-- and still the only thing that resolves overlapping runs. The hourly cron
-- (20260813080000_authenticate_heating_optimizer_cron.sql) is untouched
-- and remains the fallback/reconciliation path for anything this trigger
-- path still misses (e.g. Vault secrets missing, pg_cron itself down).

-- 1. Persist each key's own cooldown instead of passing it in per call.
alter table public.backend_heating_optimizer_trigger_debounce
  add column if not exists min_interval interval;

update public.backend_heating_optimizer_trigger_debounce
set min_interval = interval '30 seconds'
where debounce_key = 'settings'
  and min_interval is null;

update public.backend_heating_optimizer_trigger_debounce
set min_interval = interval '5 minutes'
where debounce_key = 'tank'
  and min_interval is null;

alter table public.backend_heating_optimizer_trigger_debounce
  alter column min_interval set not null;

-- 2. Factor the authenticated HTTP dispatch out of the debounce/coalescing
--    decision, so the drain path can reuse it verbatim.
create or replace function public.dispatch_backend_heating_optimizer_run(
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_url text;
  v_cron_secret text;
  v_publishable_key text;
begin
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
    raise warning 'dispatch_backend_heating_optimizer_run: missing project_url/heating_optimizer_cron_secret/publishable_key Vault secret, skipping dispatch (reason=%)', p_reason;
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
    raise warning 'dispatch_backend_heating_optimizer_run: dispatch failed for reason=%: %', p_reason, sqlerrm;
end;
$$;

revoke all on function public.dispatch_backend_heating_optimizer_run(text) from public, anon, authenticated;
grant execute on function public.dispatch_backend_heating_optimizer_run(text) to service_role;

-- 3. request_backend_heating_optimizer_run drops its p_min_interval
--    argument (now read from the row instead - see step 1) and delegates
--    the actual call to dispatch_backend_heating_optimizer_run. The old
--    3-arg overload is dropped explicitly, not just shadowed, matching
--    this PR's existing "no obsolete overload stays reachable" precedent.
drop function if exists public.request_backend_heating_optimizer_run(text, text, interval);

create or replace function public.request_backend_heating_optimizer_run(
  p_reason text,
  p_debounce_key text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_dispatch timestamptz;
  v_min_interval interval;
begin
  select last_dispatch_requested_at, min_interval
  into v_last_dispatch, v_min_interval
  from public.backend_heating_optimizer_trigger_debounce
  where debounce_key = p_debounce_key
  for update;

  if not found then
    raise warning 'request_backend_heating_optimizer_run: unknown debounce_key=%, skipping dispatch (reason=%)', p_debounce_key, p_reason;
    return;
  end if;

  if v_last_dispatch is not null and now() - v_last_dispatch < v_min_interval then
    update public.backend_heating_optimizer_trigger_debounce
    set pending = true,
        pending_reason = p_reason,
        pending_since = coalesce(pending_since, now()),
        updated_at = now()
    where debounce_key = p_debounce_key;
    return;
  end if;

  update public.backend_heating_optimizer_trigger_debounce
  set last_dispatch_requested_at = now(),
      pending = false,
      pending_reason = null,
      pending_since = null,
      updated_at = now()
  where debounce_key = p_debounce_key;

  perform public.dispatch_backend_heating_optimizer_run(p_reason);
end;
$$;

revoke all on function public.request_backend_heating_optimizer_run(text, text) from public, anon, authenticated;
grant execute on function public.request_backend_heating_optimizer_run(text, text) to service_role;

-- 4. Guarantee the trailing dispatch: any key still pending once its own
--    cooldown has elapsed gets dispatched and cleared here, independent of
--    any future trigger event. "for update skip locked" so this never
--    blocks on - or is blocked by - a concurrent tank/settings trigger
--    momentarily holding the same row; a skipped row is simply picked up
--    on the next minute's run.
create or replace function public.drain_pending_backend_heating_optimizer_dispatch()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  for v_row in
    select debounce_key, pending_reason
    from public.backend_heating_optimizer_trigger_debounce
    where pending
      and last_dispatch_requested_at is not null
      and now() - last_dispatch_requested_at >= min_interval
    for update skip locked
  loop
    update public.backend_heating_optimizer_trigger_debounce
    set last_dispatch_requested_at = now(),
        pending = false,
        pending_reason = null,
        pending_since = null,
        updated_at = now()
    where debounce_key = v_row.debounce_key;

    perform public.dispatch_backend_heating_optimizer_run(
      coalesce(v_row.pending_reason, 'trailing_dispatch_drain')
    );
  end loop;
end;
$$;

revoke all on function public.drain_pending_backend_heating_optimizer_dispatch() from public, anon, authenticated;
grant execute on function public.drain_pending_backend_heating_optimizer_dispatch() to service_role;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'drain-heating-optimizer-trigger-dispatch'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'drain-heating-optimizer-trigger-dispatch',
  '* * * * *',
  $cron$
  select public.drain_pending_backend_heating_optimizer_dispatch();
  $cron$
);

-- 5. Both trigger functions call the new 2-arg request signature; their
--    own signature (no args, returns trigger) is unchanged, so the
--    existing AFTER INSERT/AFTER UPDATE OF triggers from
--    20260814000000_add_live_heating_optimizer_trigger.sql keep pointing
--    at them without redeclaration.
create or replace function public.trigger_backend_heating_optimizer_on_settings_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.request_backend_heating_optimizer_run(
    'heating_control_settings_changed',
    'settings'
  );
  return null;
end;
$$;

create or replace function public.trigger_backend_heating_optimizer_on_tank_reading()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_baseline_heating boolean;
  v_baseline_top_temp double precision;
  v_baseline_bottom_temp double precision;
  v_is_material boolean;
  -- Unchanged from 20260814030000: reuses
  -- waterDrawDetectionLimits.minDropCelsius
  -- (supabase/functions/_shared/waterDrawDetection.ts), not a newly
  -- invented number.
  v_material_temp_delta constant double precision := 5;
begin
  select last_considered_heating, last_considered_top_temp, last_considered_bottom_temp
  into v_baseline_heating, v_baseline_top_temp, v_baseline_bottom_temp
  from public.backend_heating_optimizer_tank_trigger_baseline
  where id = 1
  for update;

  v_is_material :=
    new.heating is distinct from v_baseline_heating
    or (
      new.top_temp is distinct from v_baseline_top_temp
      and (
        new.top_temp is null
        or v_baseline_top_temp is null
        or abs(new.top_temp - v_baseline_top_temp) >= v_material_temp_delta
      )
    )
    or (
      new.bottom_temp is distinct from v_baseline_bottom_temp
      and (
        new.bottom_temp is null
        or v_baseline_bottom_temp is null
        or abs(new.bottom_temp - v_baseline_bottom_temp) >= v_material_temp_delta
      )
    );

  if v_is_material then
    update public.backend_heating_optimizer_tank_trigger_baseline
    set last_considered_heating = new.heating,
        last_considered_top_temp = new.top_temp,
        last_considered_bottom_temp = new.bottom_temp,
        updated_at = now()
    where id = 1;

    perform public.request_backend_heating_optimizer_run(
      'tank_reading_material_change',
      'tank'
    );
  end if;

  return null;
end;
$$;

revoke all on function public.trigger_backend_heating_optimizer_on_tank_reading() from public, anon, authenticated;
revoke all on function public.trigger_backend_heating_optimizer_on_settings_change() from public, anon, authenticated;

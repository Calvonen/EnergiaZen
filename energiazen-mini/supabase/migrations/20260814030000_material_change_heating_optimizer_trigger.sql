-- Codex P1 (PR #193, second live-trigger finding): tank_readings lands
-- roughly once a minute (README.md), so the original 30s debounce in
-- 20260814000000_add_live_heating_optimizer_trigger.sql had already
-- expired again by the time the next reading arrived - every single
-- insert could dispatch a full run-heating-optimizer invocation, up to
-- ~60/hour, each one reading heavy heating-gain/recovery history and able
-- to supersede an in-flight run's heartbeat ownership.
--
-- This migration replaces the tank-side trigger with a materiality check:
-- only a genuine state change (heating true/false/unknown transition, or a
-- top/bottom temperature move big enough to matter) requests a run at all,
-- and even a material tank change is additionally cooled down to at most
-- once per 5 minutes. heating_control_settings changes are rare and
-- user-driven, so they keep dispatching on the original fast, short
-- debounce - the two reasons now track their cooldowns independently so a
-- tank cooldown can never delay a settings-driven run.
--
-- Every existing protection is unchanged: the dispatch path is still the
-- exact same authenticated run-heating-optimizer call the cron job and the
-- previous live trigger already used (private
-- x-energyzen-cron-secret, never the publishable key alone), still only
-- attached to tank_readings/heating_control_settings (never heating_plans,
-- the heartbeat table, or heating_plan_shadow_runs - so no trigger loop is
-- possible), and the hourly cron
-- (20260813080000_authenticate_heating_optimizer_cron.sql) is untouched
-- and remains the fallback/reconciliation path. Overlapping runs are still
-- resolved purely by run-heating-optimizer's own begin/complete heartbeat
-- CAS (20260813010000_harden_backend_optimizer_heartbeat.sql) - this
-- migration only changes how OFTEN a run gets requested, never how a run
-- is authorized, retried, or published.

-- 1. Replace the single shared debounce timestamp with one row per
--    dispatch reason category, so a tank cooldown and a settings cooldown
--    never block each other.
drop table if exists public.backend_heating_optimizer_trigger_state;

create table public.backend_heating_optimizer_trigger_debounce (
  debounce_key text primary key check (debounce_key in ('settings', 'tank')),
  last_dispatch_requested_at timestamptz,
  pending boolean not null default false,
  pending_reason text,
  pending_since timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.backend_heating_optimizer_trigger_debounce enable row level security;

-- No anon/authenticated policies: only the SECURITY DEFINER dispatch
-- function below ever touches this table.

insert into public.backend_heating_optimizer_trigger_debounce (debounce_key)
values ('settings'), ('tank')
on conflict (debounce_key) do nothing;

-- 2. Replace the single-window dispatch function with a per-key one. The
--    old 1-arg overload is dropped explicitly (not just shadowed) so no
--    stale, unthrottled-per-category caller can remain reachable - the
--    same "drop the obsolete overload" hardening PR #193 already applied
--    to the publication RPC.
drop function if exists public.request_backend_heating_optimizer_run(text);

create or replace function public.request_backend_heating_optimizer_run(
  p_reason text,
  p_debounce_key text,
  p_min_interval interval
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_dispatch timestamptz;
  v_project_url text;
  v_cron_secret text;
  v_publishable_key text;
begin
  select last_dispatch_requested_at
  into v_last_dispatch
  from public.backend_heating_optimizer_trigger_debounce
  where debounce_key = p_debounce_key
  for update;

  if not found then
    raise warning 'request_backend_heating_optimizer_run: unknown debounce_key=%, skipping dispatch (reason=%)', p_debounce_key, p_reason;
    return;
  end if;

  if v_last_dispatch is not null and now() - v_last_dispatch < p_min_interval then
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

revoke all on function public.request_backend_heating_optimizer_run(text, text, interval) from public, anon, authenticated;
grant execute on function public.request_backend_heating_optimizer_run(text, text, interval) to service_role;

-- 3. heating_control_settings changes stay on the original fast, short
--    debounce (still just an anti-duplicate floor, not a meaningful
--    throttle) - "settings change must still cause a fast run".
create or replace function public.trigger_backend_heating_optimizer_on_settings_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.request_backend_heating_optimizer_run(
    'heating_control_settings_changed',
    'settings',
    interval '30 seconds'
  );
  return null;
end;
$$;

-- 4. tank_readings gets a materiality baseline: the last reading a
--    dispatch was actually requested for. Only a reading that differs
--    "enough" from that baseline updates it and requests a run: an
--    ordinary near-identical per-minute reading changes nothing here at
--    all, so it can never itself cause a dispatch - not "debounced away"
--    after already costing a check, simply not material in the first
--    place. A run through many small, individually-below-threshold steps
--    still crosses the threshold and fires, because the baseline only
--    ever moves on a material reading, not on every reading.
create table public.backend_heating_optimizer_tank_trigger_baseline (
  id smallint primary key default 1 check (id = 1),
  last_considered_heating boolean,
  last_considered_top_temp double precision,
  last_considered_bottom_temp double precision,
  updated_at timestamptz not null default now()
);

alter table public.backend_heating_optimizer_tank_trigger_baseline enable row level security;

insert into public.backend_heating_optimizer_tank_trigger_baseline (id)
values (1)
on conflict (id) do nothing;

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
  -- Reuses waterDrawDetectionLimits.minDropCelsius
  -- (supabase/functions/_shared/waterDrawDetection.ts) - the project's
  -- existing, already-justified threshold for "a big enough tank
  -- temperature move to mean something happened" (there: a real water
  -- draw vs. slow inlet-pipe drift). Applied here as a magnitude, not a
  -- direction, since a rise (heating recovering the tank) matters to the
  -- optimizer exactly as much as a drop (a shower/tap draw) does. Not a
  -- newly invented number.
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

    -- 5-minute cooldown: a hard backstop against a flapping relay/sensor
    -- turning every oscillation into a dispatch, while still reacting far
    -- faster than the hourly cron fallback to a real draw, heating-state
    -- change, or temperature move.
    perform public.request_backend_heating_optimizer_run(
      'tank_reading_material_change',
      'tank',
      interval '5 minutes'
    );
  end if;

  return null;
end;
$$;

-- The existing AFTER INSERT trigger on tank_readings and AFTER UPDATE OF
-- trigger on heating_control_settings (both from
-- 20260814000000_add_live_heating_optimizer_trigger.sql) already bind to
-- these two function names by name, not by signature - CREATE OR REPLACE
-- above is enough, no CREATE TRIGGER needed here.

revoke all on function public.trigger_backend_heating_optimizer_on_tank_reading() from public, anon, authenticated;
revoke all on function public.trigger_backend_heating_optimizer_on_settings_change() from public, anon, authenticated;

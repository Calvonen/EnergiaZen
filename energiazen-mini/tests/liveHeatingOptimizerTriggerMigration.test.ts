import { readFileSync } from "node:fs";
import { join } from "node:path";

// IMPORTANT: this is a lightweight SQL contract/source test, like its
// sibling *Migration.test.ts files. It does NOT execute the PL/pgSQL
// against a real PostgreSQL instance. The small TypeScript debounce model
// below guards the intended coalescing behaviour, but the migration's
// transactional behaviour still requires validation against the target
// PostgreSQL/Supabase environment before production deployment.

function assertSource(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runLiveHeatingOptimizerTriggerMigrationTests() {
  const sql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260814000000_add_live_heating_optimizer_trigger.sql",
    ),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const cronMigration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813080000_authenticate_heating_optimizer_cron.sql",
    ),
    "utf8",
  ).replace(/\r\n/g, "\n");

  assertSource(
    sql.includes("create table if not exists public.backend_heating_optimizer_trigger_state"),
    "migration must create a singleton debounce state table",
  );
  assertSource(
    sql.includes("alter table public.backend_heating_optimizer_trigger_state enable row level security") &&
      !sql.includes("backend_heating_optimizer_trigger_state for select to anon") &&
      !sql.includes("backend_heating_optimizer_trigger_state for select to authenticated"),
    "trigger debounce state must stay RLS-protected with no client-facing policy",
  );

  assertSource(
    sql.includes("create or replace function public.request_backend_heating_optimizer_run(") &&
      sql.includes("security definer") &&
      sql.includes("set search_path = public"),
    "dispatch function must be a locked-down SECURITY DEFINER function",
  );
  assertSource(
    sql.includes("where name = 'project_url'") &&
      sql.includes("where name = 'heating_optimizer_cron_secret'") &&
      sql.includes("where name = 'publishable_key'") &&
      sql.includes("'x-energyzen-cron-secret', v_cron_secret") &&
      sql.includes("net.http_post("),
    "live trigger must reuse the exact same authenticated HTTP path as the cron job",
  );
  assertSource(
    cronMigration.includes("where name = 'project_url'") &&
      cronMigration.includes("where name = 'heating_optimizer_cron_secret'") &&
      cronMigration.includes("where name = 'publishable_key'") &&
      cronMigration.includes("'x-energyzen-cron-secret'"),
    "cron must still use the same three Vault secrets the live trigger reuses",
  );
  assertSource(
    !sql.includes("'apikey', v_cron_secret") &&
      sql.includes("'apikey', v_publishable_key") &&
      sql.includes("'Authorization', 'Bearer ' || v_publishable_key"),
    "the publishable key alone must never be treated as sufficient authorization",
  );

  assertSource(
    sql.includes("v_debounce_window constant interval := interval '30 seconds'") &&
      sql.includes("now() - v_last_dispatch < v_debounce_window") &&
      sql.includes("pending = true"),
    "dispatch function must debounce/coalesce requests inside the debounce window",
  );
  assertSource(
    sql.includes("revoke all on function public.request_backend_heating_optimizer_run(text) from public, anon, authenticated") &&
      sql.includes("grant execute on function public.request_backend_heating_optimizer_run(text) to service_role"),
    "dispatch function must not be callable by anon/authenticated clients",
  );

  assertSource(
    sql.includes("exception\n  when others then") &&
      sql.includes("raise warning 'request_backend_heating_optimizer_run: dispatch failed"),
    "a dispatch failure must be caught and logged, never propagated to the caller",
  );

  assertSource(
    sql.includes("after insert on public.tank_readings") &&
      sql.includes("trigger_backend_heating_optimizer_on_tank_reading") &&
      sql.includes("request_backend_heating_optimizer_run('tank_reading_inserted')"),
    "a new tank_readings row must request a live optimizer run",
  );

  const settingsTriggerStart = sql.indexOf(
    "create trigger trg_backend_heating_optimizer_settings_change",
  );
  const settingsTriggerSource = sql.slice(settingsTriggerStart);
  assertSource(
    settingsTriggerStart !== -1 &&
      settingsTriggerSource.includes("after update of") &&
      settingsTriggerSource.includes("on public.heating_control_settings") &&
      sql.includes("request_backend_heating_optimizer_run('heating_control_settings_changed')"),
    "a relevant heating_control_settings change must request a live optimizer run",
  );
  for (const column of [
    "automatic_max_heating_hours",
    "full_tank_average_temperature",
    "full_tank_showers",
    "heating_gain_source",
    "heating_need_mode",
    "max_tank_temperature",
    "min_tank_temperature",
    "safety_shower_reserve",
    "target_shower_reserve",
  ]) {
    assertSource(
      settingsTriggerSource.includes(column) &&
        settingsTriggerSource.includes(
          `old.${column} is distinct from new.${column}`,
        ),
      `settings trigger must both target and value-check ${column}`,
    );
  }

  assertSource(
    !sql.includes("on public.heating_plans") &&
      !sql.includes("on public.backend_heating_optimizer_state") &&
      !sql.includes("on public.heating_plan_shadow_runs"),
    "no trigger may attach to heating_plans, heartbeat, or shadow tables - those are what run-heating-optimizer writes, and a trigger there would loop",
  );

  // Model the debounce predicate the SQL implements: a request inside the
  // window coalesces into "pending" instead of dispatching again; a request
  // once the window has elapsed dispatches and resets the window.
  const debounceWindowMs = 30_000;
  type DispatchState = { lastDispatchAt: number | null; pending: boolean };
  function requestRun(state: DispatchState, nowMs: number): DispatchState {
    if (
      state.lastDispatchAt !== null &&
      nowMs - state.lastDispatchAt < debounceWindowMs
    ) {
      return { lastDispatchAt: state.lastDispatchAt, pending: true };
    }
    return { lastDispatchAt: nowMs, pending: false };
  }

  let state: DispatchState = { lastDispatchAt: null, pending: false };
  state = requestRun(state, 0);
  assertSource(
    state.lastDispatchAt === 0 && !state.pending,
    "the first request must dispatch immediately",
  );
  state = requestRun(state, 5_000);
  assertSource(
    state.lastDispatchAt === 0 && state.pending,
    "a request inside the debounce window must coalesce instead of dispatching again",
  );
  state = requestRun(state, 20_000);
  assertSource(
    state.lastDispatchAt === 0 && state.pending,
    "repeated requests inside the window must keep coalescing without moving the dispatch time",
  );
  state = requestRun(state, 31_000);
  assertSource(
    state.lastDispatchAt === 31_000 && !state.pending,
    "a request once the debounce window has elapsed must dispatch again",
  );
}

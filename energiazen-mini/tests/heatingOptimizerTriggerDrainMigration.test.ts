import { readFileSync } from "node:fs";
import { join } from "node:path";

// IMPORTANT: this is a lightweight SQL contract/source test, like its
// sibling *Migration.test.ts files. It does NOT execute the PL/pgSQL
// against a real PostgreSQL instance. The pure TypeScript model below
// mirrors the SQL's debounce/drain predicates to give deterministic
// coverage of that logic, but the migration's transactional behaviour
// still requires validation against the target PostgreSQL/Supabase
// environment before production deployment.

function assertSource(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runHeatingOptimizerTriggerDrainMigrationTests() {
  const sql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260814040000_drain_pending_heating_optimizer_dispatch.sql",
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
  const heartbeatMigration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813010000_harden_backend_optimizer_heartbeat.sql",
    ),
    "utf8",
  ).replace(/\r\n/g, "\n");

  // --- min_interval becomes a single persisted source of truth ---
  assertSource(
    sql.includes("add column if not exists min_interval interval") &&
      sql.includes("min_interval = interval '30 seconds'") &&
      sql.includes("where debounce_key = 'settings'") &&
      sql.includes("min_interval = interval '5 minutes'") &&
      sql.includes("where debounce_key = 'tank'") &&
      sql.includes("alter column min_interval set not null"),
    "each debounce key's cooldown must be persisted once on the row, not re-passed by every caller",
  );

  // --- dispatch factored out and reused by both request and drain paths ---
  assertSource(
    sql.includes("create or replace function public.dispatch_backend_heating_optimizer_run(") &&
      sql.includes("net.http_post(") &&
      sql.includes("'x-energyzen-cron-secret', v_cron_secret") &&
      sql.includes("'apikey', v_publishable_key") &&
      !sql.includes("'apikey', v_cron_secret"),
    "the authenticated dispatch must be its own function, still using the private cron secret header separately from the publishable key",
  );
  assertSource(
    sql.includes(
      "revoke all on function public.dispatch_backend_heating_optimizer_run(text) from public, anon, authenticated",
    ) &&
      sql.includes(
        "grant execute on function public.dispatch_backend_heating_optimizer_run(text) to service_role",
      ),
    "the dispatch helper must stay locked down to service_role only",
  );

  // --- request path drops p_min_interval, old overload explicitly dropped ---
  assertSource(
    sql.includes(
      "drop function if exists public.request_backend_heating_optimizer_run(text, text, interval)",
    ),
    "the old 3-arg request function (inline min_interval) must be explicitly dropped, not just shadowed",
  );
  const requestFnStart = sql.indexOf(
    "create or replace function public.request_backend_heating_optimizer_run(\n  p_reason text,\n  p_debounce_key text\n)",
  );
  const requestFnEnd = sql.indexOf("\n$$;", requestFnStart);
  const requestFnSource = sql.slice(requestFnStart, requestFnEnd);
  assertSource(
    requestFnStart !== -1 &&
      requestFnSource.includes("select last_dispatch_requested_at, min_interval") &&
      requestFnSource.includes("now() - v_last_dispatch < v_min_interval") &&
      requestFnSource.includes("pending = true") &&
      requestFnSource.includes("perform public.dispatch_backend_heating_optimizer_run(p_reason)"),
    "request_backend_heating_optimizer_run must read min_interval from the row and delegate the actual call to the dispatch helper",
  );

  // --- the drain path guarantees a trailing dispatch without a future trigger event ---
  const drainFnStart = sql.indexOf(
    "create or replace function public.drain_pending_backend_heating_optimizer_dispatch()",
  );
  const drainFnEnd = sql.indexOf("\n$$;", drainFnStart);
  const drainFnSource = sql.slice(drainFnStart, drainFnEnd);
  assertSource(
    drainFnStart !== -1 &&
      drainFnSource.includes("where pending") &&
      drainFnSource.includes("last_dispatch_requested_at is not null") &&
      drainFnSource.includes("now() - last_dispatch_requested_at >= min_interval") &&
      drainFnSource.includes("for update skip locked"),
    "the drain function must select every still-pending key whose own cooldown has elapsed, without blocking on a concurrently-locked row",
  );
  assertSource(
    drainFnSource.includes("pending = false") &&
      drainFnSource.includes("perform public.dispatch_backend_heating_optimizer_run(") &&
      drainFnSource.indexOf("pending = false") < drainFnSource.indexOf("dispatch_backend_heating_optimizer_run("),
    "the drain function must clear pending and then dispatch through the same authenticated dispatch helper",
  );
  assertSource(
    sql.includes("'drain-heating-optimizer-trigger-dispatch'") &&
      sql.includes("'* * * * *'") &&
      sql.includes("select public.drain_pending_backend_heating_optimizer_dispatch();"),
    "the drain function must be scheduled every minute via pg_cron, independent of any tank/settings event",
  );

  // --- triggers call the new 2-arg signature ---
  assertSource(
    sql.includes("request_backend_heating_optimizer_run(\n    'heating_control_settings_changed',\n    'settings'\n  );"),
    "the settings trigger must call the new 2-arg request signature",
  );
  assertSource(
    sql.includes("request_backend_heating_optimizer_run(\n      'tank_reading_material_change',\n      'tank'\n    );"),
    "the tank trigger must call the new 2-arg request signature",
  );

  // --- no trigger loops, auth/CAS/cron fallback unchanged ---
  assertSource(
    !sql.includes("on public.heating_plans") &&
      !sql.includes("on public.backend_heating_optimizer_state") &&
      !sql.includes("on public.heating_plan_shadow_runs"),
    "no trigger may attach to heating_plans, heartbeat, or shadow tables - those are what run-heating-optimizer writes, and a trigger there would loop",
  );
  assertSource(
    !sql.includes("create or replace function public.begin_backend_heating_optimizer_run") &&
      !sql.includes("create or replace function public.complete_backend_heating_optimizer_run") &&
      !sql.includes("current_run_id =") &&
      !sql.includes("current_run_started_at ="),
    "this migration must not touch the heartbeat CAS functions - overlapping runs stay resolved purely by run-heating-optimizer's own begin/complete compare-and-set",
  );
  assertSource(
    heartbeatMigration.includes(
      "current_run_started_at is null or current_run_started_at < p_run_started_at",
    ),
    "the heartbeat CAS this migration relies on for overlap safety must still exist unmodified in its own migration",
  );
  assertSource(
    cronMigration.includes("'run-heating-optimizer-shadow-hourly'") &&
      cronMigration.includes("'20 * * * *'"),
    "the hourly cron must remain scheduled independently as the fallback/reconciliation path",
  );

  // --- deterministic model of the request/drain predicates ---
  type DebounceRow = {
    lastDispatchAtMs: number | null;
    minIntervalMs: number;
    pending: boolean;
    pendingReason: string | null;
  };

  function requestRun(
    row: DebounceRow,
    nowMs: number,
    reason: string,
  ): { dispatchedNowMs: number | null; row: DebounceRow } {
    if (
      row.lastDispatchAtMs !== null &&
      nowMs - row.lastDispatchAtMs < row.minIntervalMs
    ) {
      return {
        dispatchedNowMs: null,
        row: { ...row, pending: true, pendingReason: reason },
      };
    }
    return {
      dispatchedNowMs: nowMs,
      row: {
        ...row,
        lastDispatchAtMs: nowMs,
        pending: false,
        pendingReason: null,
      },
    };
  }

  function drainTick(
    row: DebounceRow,
    nowMs: number,
  ): { dispatchedNowMs: number | null; row: DebounceRow } {
    if (
      row.pending &&
      row.lastDispatchAtMs !== null &&
      nowMs - row.lastDispatchAtMs >= row.minIntervalMs
    ) {
      return {
        dispatchedNowMs: nowMs,
        row: {
          ...row,
          lastDispatchAtMs: nowMs,
          pending: false,
          pendingReason: null,
        },
      };
    }
    return { dispatchedNowMs: null, row };
  }

  const fiveMinutesMs = 5 * 60_000;
  const thirtySecondsMs = 30_000;
  const minuteMs = 60_000;

  // 1. material change at T0 dispatches
  let tank: DebounceRow = {
    lastDispatchAtMs: null,
    minIntervalMs: fiveMinutesMs,
    pending: false,
    pendingReason: null,
  };
  let step = requestRun(tank, 0, "tank_reading_material_change");
  tank = step.row;
  assertSource(
    step.dispatchedNowMs === 0,
    "1) a material tank change at T0 must dispatch immediately",
  );

  // 2. another material change at T+2m is coalesced
  step = requestRun(tank, 2 * minuteMs, "tank_reading_material_change");
  tank = step.row;
  assertSource(
    step.dispatchedNowMs === null && tank.pending,
    "2) a material change at T+2m (inside the 5-minute cooldown) must coalesce, not dispatch again",
  );

  // 3. no further tank changes occur (nothing to simulate - just continuing
  //    to drain the same `tank` state below without any more requestRun calls).

  // 4. exactly one trailing tank optimizer run still occurs at/after T+5m,
  //    driven purely by minute-by-minute drain ticks, never by another
  //    requestRun call.
  let trailingDispatches: number[] = [];
  for (let minute = 1; minute <= 10; minute += 1) {
    const nowMs = minute * minuteMs;
    const drained = drainTick(tank, nowMs);
    tank = drained.row;
    if (drained.dispatchedNowMs !== null) {
      trailingDispatches.push(drained.dispatchedNowMs);
    }
  }
  assertSource(
    trailingDispatches.length === 1,
    "4) exactly one trailing dispatch must occur once the cooldown elapses, with no further tank readings",
  );
  assertSource(
    trailingDispatches[0] >= fiveMinutesMs,
    "4) the trailing dispatch must occur at or after T+5m, never before the cooldown has elapsed",
  );
  assertSource(
    !tank.pending,
    "4) pending must be cleared once the trailing dispatch has fired",
  );

  // 5. several material changes during the cooldown still collapse into
  //    only one trailing run.
  let multiTank: DebounceRow = {
    lastDispatchAtMs: null,
    minIntervalMs: fiveMinutesMs,
    pending: false,
    pendingReason: null,
  };
  multiTank = requestRun(multiTank, 0, "tank_reading_material_change").row;
  for (const minute of [1, 2, 3, 4]) {
    const result = requestRun(
      multiTank,
      minute * minuteMs,
      "tank_reading_material_change",
    );
    assertSource(
      result.dispatchedNowMs === null,
      `5) a material change at T+${minute}m inside the cooldown must not dispatch again`,
    );
    multiTank = result.row;
  }
  let multiTrailingDispatches: number[] = [];
  for (let minute = 5; minute <= 12; minute += 1) {
    const drained = drainTick(multiTank, minute * minuteMs);
    multiTank = drained.row;
    if (drained.dispatchedNowMs !== null) {
      multiTrailingDispatches.push(drained.dispatchedNowMs);
    }
  }
  assertSource(
    multiTrailingDispatches.length === 1,
    "5) several material changes coalesced during one cooldown window must still produce exactly one trailing run",
  );

  // 6. a settings dispatch is not blocked by an active/pending tank cooldown
  //    - independent debounce_key, independent state.
  const settingsRow: DebounceRow = {
    lastDispatchAtMs: null,
    minIntervalMs: thirtySecondsMs,
    pending: false,
    pendingReason: null,
  };
  // multiTank is still mid-cooldown (pending cleared but lastDispatchAtMs
  // recent) at this point - the settings key must be entirely unaffected.
  const settingsResult = requestRun(
    settingsRow,
    2 * minuteMs + 1,
    "heating_control_settings_changed",
  );
  assertSource(
    settingsResult.dispatchedNowMs === 2 * minuteMs + 1,
    "6) a settings change must dispatch immediately on its own fast window even while the unrelated tank key is mid-cooldown",
  );
}

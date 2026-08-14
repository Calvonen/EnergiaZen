import { readFileSync } from "node:fs";
import { join } from "node:path";

import { waterDrawDetectionLimits } from "../lib/waterDrawDetection";

// IMPORTANT: this is a lightweight SQL contract/source test, like its
// sibling *Migration.test.ts files. It does NOT execute the PL/pgSQL
// against a real PostgreSQL instance. The pure TypeScript models below
// mirror the SQL's materiality/cooldown predicates to give deterministic
// coverage of that logic, but the migration's transactional behaviour
// still requires validation against the target PostgreSQL/Supabase
// environment before production deployment.

function assertSource(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runMaterialChangeHeatingOptimizerTriggerMigrationTests() {
  const sql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260814030000_material_change_heating_optimizer_trigger.sql",
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

  // --- per-reason debounce keys replace the single shared window ---
  assertSource(
    sql.includes("drop table if exists public.backend_heating_optimizer_trigger_state") &&
      sql.includes("create table public.backend_heating_optimizer_trigger_debounce") &&
      sql.includes("debounce_key text primary key check (debounce_key in ('settings', 'tank'))"),
    "the single shared debounce table must be replaced by a per-reason-key debounce table",
  );
  assertSource(
    sql.includes("drop function if exists public.request_backend_heating_optimizer_run(text)"),
    "the old single-window 1-arg dispatch function must be explicitly dropped, not just shadowed",
  );
  assertSource(
    sql.includes("create or replace function public.request_backend_heating_optimizer_run(") &&
      sql.includes("p_reason text,") &&
      sql.includes("p_debounce_key text,") &&
      sql.includes("p_min_interval interval"),
    "the replacement dispatch function must take an explicit per-call debounce key and minimum interval",
  );
  assertSource(
    sql.includes(
      "revoke all on function public.request_backend_heating_optimizer_run(text, text, interval) from public, anon, authenticated",
    ) &&
      sql.includes(
        "grant execute on function public.request_backend_heating_optimizer_run(text, text, interval) to service_role",
      ),
    "the new dispatch function signature must stay locked down to service_role only",
  );
  assertSource(
    sql.includes("where debounce_key = p_debounce_key") &&
      sql.includes("now() - v_last_dispatch < p_min_interval") &&
      sql.includes("pending = true"),
    "dispatch must debounce/coalesce per debounce_key using the caller-supplied minimum interval",
  );

  // --- settings changes keep a fast, short debounce ---
  const settingsTriggerFnStart = sql.indexOf(
    "create or replace function public.trigger_backend_heating_optimizer_on_settings_change()",
  );
  const settingsTriggerFnEnd = sql.indexOf("$$;", settingsTriggerFnStart);
  const settingsTriggerFnSource = sql.slice(settingsTriggerFnStart, settingsTriggerFnEnd);
  assertSource(
    settingsTriggerFnStart !== -1 &&
      settingsTriggerFnSource.includes("'heating_control_settings_changed'") &&
      settingsTriggerFnSource.includes("'settings'") &&
      settingsTriggerFnSource.includes("interval '30 seconds'"),
    "a heating_control_settings change must still dispatch on a fast, short debounce independent of the tank cooldown",
  );

  // --- tank_readings gets a materiality baseline, not a bare debounce ---
  assertSource(
    sql.includes("create table public.backend_heating_optimizer_tank_trigger_baseline") &&
      sql.includes("last_considered_heating boolean") &&
      sql.includes("last_considered_top_temp double precision") &&
      sql.includes("last_considered_bottom_temp double precision"),
    "a tank materiality baseline table must exist so an ordinary near-identical reading changes nothing",
  );
  const tankTriggerFnStart = sql.indexOf(
    "create or replace function public.trigger_backend_heating_optimizer_on_tank_reading()",
  );
  const tankTriggerFnEnd = sql.indexOf("\n$$;", tankTriggerFnStart);
  const tankTriggerFnSource = sql.slice(tankTriggerFnStart, tankTriggerFnEnd);
  assertSource(
    tankTriggerFnStart !== -1 &&
      tankTriggerFnSource.includes("new.heating is distinct from v_baseline_heating") &&
      tankTriggerFnSource.includes("new.top_temp is distinct from v_baseline_top_temp") &&
      tankTriggerFnSource.includes("new.bottom_temp is distinct from v_baseline_bottom_temp"),
    "the tank trigger must compare the new reading against a stored baseline, not fire unconditionally",
  );
  assertSource(
    tankTriggerFnSource.includes(
      `v_material_temp_delta constant double precision := ${waterDrawDetectionLimits.minDropCelsius}`,
    ),
    "the material temperature threshold must reuse waterDrawDetectionLimits.minDropCelsius, not an newly invented number",
  );
  assertSource(
    tankTriggerFnSource.includes("'tank_reading_material_change'") &&
      tankTriggerFnSource.includes("'tank'") &&
      tankTriggerFnSource.includes("interval '5 minutes'"),
    "a material tank change must dispatch through the 'tank' debounce key with a 5-minute cooldown",
  );
  assertSource(
    tankTriggerFnSource.includes("if v_is_material then") &&
      tankTriggerFnSource.indexOf(
        "update public.backend_heating_optimizer_tank_trigger_baseline",
      ) > tankTriggerFnSource.indexOf("if v_is_material then") &&
      tankTriggerFnSource.indexOf("request_backend_heating_optimizer_run(") >
        tankTriggerFnSource.indexOf(
          "update public.backend_heating_optimizer_tank_trigger_baseline",
        ),
    "the baseline must only move on a material reading, and only a material reading may request a run",
  );

  // --- no trigger loops ---
  assertSource(
    !sql.includes("on public.heating_plans") &&
      !sql.includes("on public.backend_heating_optimizer_state") &&
      !sql.includes("on public.heating_plan_shadow_runs"),
    "no trigger may attach to heating_plans, heartbeat, or shadow tables - those are what run-heating-optimizer writes, and a trigger there would loop",
  );

  // --- auth, CAS, and cron fallback stay untouched ---
  assertSource(
    sql.includes("'x-energyzen-cron-secret', v_cron_secret") &&
      sql.includes("'apikey', v_publishable_key") &&
      !sql.includes("'apikey', v_cron_secret"),
    "the private cron secret must remain a separate header from the publishable key, never used alone",
  );
  assertSource(
    !sql.includes("begin_backend_heating_optimizer_run") &&
      !sql.includes("complete_backend_heating_optimizer_run") &&
      !sql.includes("current_run_id") &&
      !sql.includes("current_run_started_at"),
    "this migration must not touch the heartbeat CAS functions - overlapping runs stay resolved purely by run-heating-optimizer's own begin/complete compare-and-set",
  );
  assertSource(
    heartbeatMigration.includes("current_run_started_at is null or current_run_started_at < p_run_started_at"),
    "the heartbeat CAS this migration relies on for overlap safety must still exist unmodified in its own migration",
  );
  assertSource(
    cronMigration.includes("'run-heating-optimizer-shadow-hourly'") &&
      cronMigration.includes("'20 * * * *'"),
    "the hourly cron must remain scheduled independently as the fallback/reconciliation path",
  );

  // --- deterministic model of the SQL predicates ---
  type TankReading = {
    heating: boolean | null;
    topTemp: number | null;
    bottomTemp: number | null;
  };
  const materialTempDelta = waterDrawDetectionLimits.minDropCelsius;

  function isMaterialTankChange(
    baseline: TankReading,
    reading: TankReading,
  ): boolean {
    const heatingChanged = reading.heating !== baseline.heating;
    const topChanged =
      reading.topTemp !== baseline.topTemp &&
      (reading.topTemp === null ||
        baseline.topTemp === null ||
        Math.abs(reading.topTemp - baseline.topTemp) >= materialTempDelta);
    const bottomChanged =
      reading.bottomTemp !== baseline.bottomTemp &&
      (reading.bottomTemp === null ||
        baseline.bottomTemp === null ||
        Math.abs(reading.bottomTemp - baseline.bottomTemp) >= materialTempDelta);

    return heatingChanged || topChanged || bottomChanged;
  }

  type DebounceState = { lastDispatchAtMs: number | null; pending: boolean };
  function requestRun(
    state: DebounceState,
    nowMs: number,
    minIntervalMs: number,
  ): DebounceState {
    if (
      state.lastDispatchAtMs !== null &&
      nowMs - state.lastDispatchAtMs < minIntervalMs
    ) {
      return { lastDispatchAtMs: state.lastDispatchAtMs, pending: true };
    }
    return { lastDispatchAtMs: nowMs, pending: false };
  }

  const baselineStart: TankReading = { heating: false, topTemp: 55, bottomTemp: 45 };

  // "minuutin välein tulevat lähes identtiset readingit eivät käynnistä
  // optimizeria joka kerta"
  let baseline = baselineStart;
  let materialCount = 0;
  for (let minute = 0; minute < 10; minute += 1) {
    const reading: TankReading = {
      heating: false,
      topTemp: 55 + (minute % 2 === 0 ? 0.3 : -0.3),
      bottomTemp: 45,
    };
    if (isMaterialTankChange(baseline, reading)) {
      materialCount += 1;
      baseline = reading;
    }
  }
  assertSource(
    materialCount === 0,
    "near-identical per-minute readings must never be classified as material",
  );

  // "material temperature change triggeröi"
  assertSource(
    isMaterialTankChange(baselineStart, {
      heating: false,
      topTemp: baselineStart.topTemp! + materialTempDelta,
      bottomTemp: 45,
    }),
    "a top_temp move at least as large as the reused threshold must be material",
  );
  assertSource(
    !isMaterialTankChange(baselineStart, {
      heating: false,
      topTemp: baselineStart.topTemp! + materialTempDelta - 0.5,
      bottomTemp: 45,
    }),
    "a top_temp move just under the threshold must not be material",
  );

  // "heating false -> true triggeröi" / "heating true -> false triggeröi"
  assertSource(
    isMaterialTankChange(
      { heating: false, topTemp: 55, bottomTemp: 45 },
      { heating: true, topTemp: 55, bottomTemp: 45 },
    ),
    "heating false -> true must be material regardless of temperature",
  );
  assertSource(
    isMaterialTankChange(
      { heating: true, topTemp: 55, bottomTemp: 45 },
      { heating: false, topTemp: 55, bottomTemp: 45 },
    ),
    "heating true -> false must be material regardless of temperature",
  );
  assertSource(
    isMaterialTankChange(
      { heating: null, topTemp: 55, bottomTemp: 45 },
      { heating: true, topTemp: 55, bottomTemp: 45 },
    ),
    "heating unknown -> known must be material",
  );

  // "cooldown/coalescing toimii deterministisesti"
  const fiveMinutesMs = 5 * 60 * 1000;
  let tankDebounce: DebounceState = { lastDispatchAtMs: null, pending: false };
  tankDebounce = requestRun(tankDebounce, 0, fiveMinutesMs);
  assertSource(
    tankDebounce.lastDispatchAtMs === 0 && !tankDebounce.pending,
    "the first material tank change must dispatch immediately",
  );
  tankDebounce = requestRun(tankDebounce, 60_000, fiveMinutesMs);
  assertSource(
    tankDebounce.lastDispatchAtMs === 0 && tankDebounce.pending,
    "a second material tank change inside the 5-minute cooldown must coalesce, not dispatch again",
  );
  tankDebounce = requestRun(tankDebounce, 5 * 60_000 + 1, fiveMinutesMs);
  assertSource(
    tankDebounce.lastDispatchAtMs === 5 * 60_000 + 1 && !tankDebounce.pending,
    "a material tank change once the 5-minute cooldown has elapsed must dispatch again",
  );

  // A settings-key dispatch must never be blocked by the tank-key cooldown
  // above - independent keys, independent state.
  const thirtySecondsMs = 30_000;
  let settingsDebounce: DebounceState = { lastDispatchAtMs: null, pending: false };
  settingsDebounce = requestRun(settingsDebounce, 61_000, thirtySecondsMs);
  assertSource(
    settingsDebounce.lastDispatchAtMs === 61_000 && !settingsDebounce.pending,
    "a settings change must still dispatch fast even while the unrelated tank cooldown is active",
  );
}

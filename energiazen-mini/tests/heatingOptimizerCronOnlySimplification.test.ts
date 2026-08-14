import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Regression coverage for the architecture-simplification pass: the
// live-trigger subsystem (tank materiality baseline, per-key debounce/
// pending state, and the minute-granularity drain cron) carried none of
// the required safety properties itself - those all live in
// run-heating-optimizer's heartbeat CAS and transactional publication RPC,
// unconditionally regardless of what asked for a run. A single, tightened
// pg_cron schedule gives materially the same real-world reaction latency
// (bounded well under the Shelly controller's 90-minute trust window) with
// none of that extra state. None of the removed migrations had been
// applied anywhere, so they were deleted outright rather than superseded.

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

const removedMigrationFilenames = [
  "20260814000000_add_live_heating_optimizer_trigger.sql",
  "20260814030000_material_change_heating_optimizer_trigger.sql",
  "20260814040000_drain_pending_heating_optimizer_dispatch.sql",
];

const removedIdentifiers = [
  "backend_heating_optimizer_trigger_state",
  "backend_heating_optimizer_trigger_debounce",
  "backend_heating_optimizer_tank_trigger_baseline",
  "request_backend_heating_optimizer_run",
  "dispatch_backend_heating_optimizer_run",
  "drain_pending_backend_heating_optimizer_dispatch",
  "trigger_backend_heating_optimizer_on_tank_reading",
  "trigger_backend_heating_optimizer_on_settings_change",
  "drain-heating-optimizer-trigger-dispatch",
  "x-energyzen-trigger-reason",
];

export function runHeatingOptimizerCronOnlySimplificationTests() {
  const migrationsDir = join(process.cwd(), "supabase/migrations");

  for (const filename of removedMigrationFilenames) {
    assertSource(
      !existsSync(join(migrationsDir, filename)),
      `the live-trigger migration ${filename} must be deleted outright, not left in history, since it was never applied anywhere`,
    );
  }

  const migrationFiles = readdirSync(migrationsDir).filter((entry) =>
    entry.endsWith(".sql"),
  );
  for (const filename of migrationFiles) {
    const source = readFileSync(join(migrationsDir, filename), "utf8");
    for (const identifier of removedIdentifiers) {
      assertSource(
        !source.includes(identifier),
        `${filename} must not reference removed live-trigger identifier "${identifier}"`,
      );
    }
  }

  const edgeSource = readFileSync(
    join(process.cwd(), "supabase/functions/run-heating-optimizer/index.ts"),
    "utf8",
  );
  for (const identifier of removedIdentifiers) {
    assertSource(
      !edgeSource.includes(identifier),
      `run-heating-optimizer/index.ts must not reference removed live-trigger identifier "${identifier}"`,
    );
  }

  // --- what must still exist, unchanged ---
  const cronMigration = readFileSync(
    join(migrationsDir, "20260813080000_authenticate_heating_optimizer_cron.sql"),
    "utf8",
  );
  assertSource(
    cronMigration.includes("'run-heating-optimizer-shadow-hourly'") &&
      cronMigration.includes("'*/5 * * * *'") &&
      cronMigration.includes("'x-energyzen-cron-secret'") &&
      cronMigration.includes("where name = 'heating_optimizer_cron_secret'"),
    "the single authenticated cron schedule must remain the sole dispatch path, tightened to every 5 minutes",
  );

  const heartbeatMigration = readFileSync(
    join(migrationsDir, "20260813010000_harden_backend_optimizer_heartbeat.sql"),
    "utf8",
  );
  assertSource(
    heartbeatMigration.includes(
      "current_run_started_at is null or current_run_started_at < p_run_started_at",
    ),
    "the heartbeat CAS must be unaffected by the live-trigger removal",
  );

  assertSource(
    existsSync(join(migrationsDir, "20260814010000_enable_heating_plans_realtime.sql")),
    "the Realtime heating-plan UI refresh migration must be preserved",
  );
  assertSource(
    existsSync(
      join(migrationsDir, "20260814020000_grant_heating_control_settings_client_select.sql"),
    ),
    "the settings-backfill grant migration must be preserved",
  );

  const contextSource = readFileSync(
    join(process.cwd(), "lib/settingsScenarioContext.tsx"),
    "utf8",
  );
  assertSource(
    contextSource.includes("ensureHeatingControlSettingsBackfilled({") &&
      contextSource.includes("isHeatingControlSettingsSynced"),
    "the settings backfill and legacy-app publisher rollout gate must be preserved",
  );

  const homeSource = readFileSync(
    join(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );
  assertSource(
    homeSource.includes('.channel("home-heating-plans-live")') &&
      homeSource.includes('"postgres_changes"'),
    "the Realtime storedHeatingPlans refresh must be preserved",
  );

  const controllerSource = readFileSync(
    join(process.cwd(), "shelly/energyzen-controller.js"),
    "utf8",
  );
  assertSource(
    controllerSource.includes("let BACKEND_PLAN_TRUST_ENABLED = false;"),
    "BACKEND_PLAN_TRUST_ENABLED must stay disabled - this simplification must not flip the device trust gate",
  );
}

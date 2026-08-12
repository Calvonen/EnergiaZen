import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

// Regression check for the run-heating-optimizer shadow-mode permissions/
// schema migration: the manual production fixes it codifies (missing
// optimizer_reason column, missing service_role grants) must stay present,
// and every fix must stay idempotent (ADD COLUMN IF NOT EXISTS; GRANT is
// idempotent by nature) so this migration is safe to re-run in an
// environment where some of it was already applied by hand.
export function runHeatingOptimizerShadowPermissionsMigrationTests() {
  const migrationSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260812010000_fix_heating_optimizer_shadow_permissions_and_schema.sql",
    ),
    "utf8",
  );

  assertSource(
    /alter table public\.heating_plan_shadow_runs\s+add column if not exists optimizer_reason text/.test(
      migrationSource,
    ),
    "migraation pitaa lisata optimizer_reason-sarake vain jos sita ei viela ole (IF NOT EXISTS)",
  );

  const requiredSelectGrants = [
    "tank_readings",
    "heating_control_settings",
    "electricity_prices",
    "heating_plans",
    "temperature_drop_profiles",
  ];
  for (const table of requiredSelectGrants) {
    assertSource(
      migrationSource.includes(`grant select on table public.${table} to service_role;`),
      `migraation pitaa grantata SELECT public.${table} service_role-roolille`,
    );
  }

  assertSource(
    migrationSource.includes(
      "grant insert on table public.heating_plan_shadow_runs to service_role;",
    ),
    "migraation pitaa grantata INSERT public.heating_plan_shadow_runs service_role-roolille",
  );

  // No DROP/REVOKE/DELETE - this migration only adds a column and grants,
  // never removes anything, so it stays safe to layer onto an environment
  // that already has part of this applied by hand.
  assertSource(
    !/\b(drop|revoke|delete|truncate)\b/i.test(migrationSource),
    "migraatio saa vain lisata (ADD COLUMN IF NOT EXISTS, GRANT) - ei poistaa/revokata mitaan",
  );
}

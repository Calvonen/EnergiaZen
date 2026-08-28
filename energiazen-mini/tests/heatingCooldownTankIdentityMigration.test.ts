import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runHeatingCooldownTankIdentityMigrationTests() {
  const migration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260828090000_persist_backend_validated_tank_snapshot.sql",
    ),
    "utf8",
  );
  const helper = readFileSync(
    join(process.cwd(), "lib/heatingCooldownMarker.ts"),
    "utf8",
  );

  assertSource(
    migration.includes("validated_tank_reading_at timestamptz") &&
      migration.includes("set validated_tank_reading_at = expected_created_at") &&
      migration.includes("result in ('published', 'no_changes')"),
    "successful backend validation must persist the exact tank reading timestamp",
  );
  assertSource(
    helper.includes("validatedTankReadingAt !== readingAt"),
    "cooldown marker trust must require exact app/backend tank snapshot identity",
  );
}

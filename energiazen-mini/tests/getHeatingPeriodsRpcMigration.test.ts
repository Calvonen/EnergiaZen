import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runGetHeatingPeriodsRpcMigrationTests() {
  const migrationSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260803020000_exclude_unknown_from_heating_period_bounds.sql",
    ),
    "utf8",
  );

  assertSource(
    migrationSource.includes(
      "create or replace function public.get_heating_periods",
    ),
    "migraation pitaa korvata get_heating_periods-RPC",
  );

  const dataBoundsStart = migrationSource.indexOf("data_bounds as (");
  const previousReadingStart = migrationSource.indexOf(
    "previous_reading as (",
  );

  assertSource(
    dataBoundsStart !== -1 && previousReadingStart > dataBoundsStart,
    "data_bounds-CTE:n pitaa loytya ennen previous_reading-CTE:ta",
  );

  const dataBoundsSource = migrationSource.slice(
    dataBoundsStart,
    previousReadingStart,
  );

  assertSource(
    dataBoundsSource.includes("where tr.heating is not null"),
    "data_bounds saa laskea latest_reading_at:n vain varmistetuista (ei-null) lukemista - muuten avoin lammitysjakso pitenisi koko UNKNOWN-katkon ajan (Codex-review, PR #147)",
  );
}

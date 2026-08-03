import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runRecalculateTemperatureDropProfileRpcMigrationTests() {
  const migrationSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260803030000_require_explicit_false_in_temperature_drop_profile.sql",
    ),
    "utf8",
  );

  assertSource(
    migrationSource.includes(
      "create or replace function public.recalculate_temperature_drop_profile",
    ),
    "migraation pitaa korvata recalculate_temperature_drop_profile-RPC",
  );

  const validDropsStart = migrationSource.indexOf("valid_drops as (");
  const dailyHourDropsStart = migrationSource.indexOf(
    "daily_hour_drops as (",
  );

  assertSource(
    validDropsStart !== -1 && dailyHourDropsStart > validDropsStart,
    "valid_drops-CTE:n pitaa loytya ennen daily_hour_drops-CTE:ta",
  );

  const validDropsSource = migrationSource.slice(
    validDropsStart,
    dailyHourDropsStart,
  );

  assertSource(
    validDropsSource.includes("ordered.previous_heating is false") &&
      validDropsSource.includes("ordered.heating is false"),
    "molempien paatepisteiden pitaa vaatia eksplisiittinen heating=false - null ei saa paasta jaahdytysprofiiliin (Codex-review, PR #147)",
  );
  assertSource(
    !validDropsSource.includes("is not true"),
    "vanha is not true -ehto (hyvaksyy myos nullin Postgresin kolmiarvoisessa logiikassa) ei saa enaa esiintya",
  );
}

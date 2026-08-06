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
      "supabase/migrations/20260806000000_split_temperature_learning_at_sensor_geometry_epoch.sql",
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
  assertSource(
    migrationSource.includes(
      "v_top_sensor_moved_at constant timestamptz := '2026-08-05T14:00:00.000Z'",
    ) && migrationSource.includes("v_source_start := greatest("),
    "jaahdytysprofiilin 30 paivan oppimisikkuna pitaa katkaista tuotannon sensorigeometrian vaihtumishetkeen",
  );

  const previousProfileStart = migrationSource.indexOf("previous_profile as (");
  const completeProfileStart = migrationSource.indexOf("complete_profile as (");
  const previousProfileSource = migrationSource.slice(
    previousProfileStart,
    completeProfileStart,
  );

  assertSource(
    previousProfileStart !== -1 && completeProfileStart > previousProfileStart,
    "previous_profile-CTE:n pitaa loytya ennen complete_profile-CTE:ta",
  );
  assertSource(
    previousProfileSource.includes(
      "profile.source_start >= v_top_sensor_moved_at",
    ),
    "V1-geometrialla opittua profiilia ei saa kayttaa V2-profiilin fallbackina",
  );
}

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

  const v2LearningMigrationSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260918130000_v2_learned_drop_profile_forecast.sql",
    ),
    "utf8",
  );

  const dailyEnergyLossesStart = v2LearningMigrationSource.indexOf(
    "daily_energy_losses as (",
  );
  const temperatureStatisticsStart = v2LearningMigrationSource.indexOf(
    "temperature_statistics as (",
  );

  assertSource(
    dailyEnergyLossesStart !== -1 &&
      temperatureStatisticsStart > dailyEnergyLossesStart,
    "daily_energy_losses-CTE:n pitaa loytya ennen temperature_statistics-CTE:ta",
  );

  const dailyEnergyLossesSource = v2LearningMigrationSource.slice(
    dailyEnergyLossesStart,
    temperatureStatisticsStart,
  );

  assertSource(
    dailyEnergyLossesSource.includes(
      "sum(row.physical_energy_drop_kwh)::double precision",
    ),
    "fyysiset energiadeltat pitaa summata ensin etumerkkeineen tuntitasolle",
  );
  assertSource(
    dailyEnergyLossesSource.includes("greatest("),
    "negatiivinen tuntitason nettoenergia pitaa leikata nollaan vasta aggregoinnin jalkeen",
  );
  assertSource(
    !dailyEnergyLossesSource.includes("physical_energy_drop_kwh > 0"),
    "yksittaisia negatiivisia intervalleja ei saa suodattaa ennen tuntisummaa",
  );
  assertSource(
    dailyEnergyLossesSource.includes(
      "having sum(interval_row.valid_interval_minutes) >= 55",
    ),
    "fyysisen V2-oppimisnaytteen pitaa kattaa vahintaan 55 minuuttia tunnista",
  );
  assertSource(
    dailyEnergyLossesSource.includes(
      "60.0 /\n        sum(interval_row.valid_interval_minutes)::double precision",
    ),
    "hyvaksytty fyysinen tuntinayte pitaa normalisoida 60 minuuttiin",
  );
  assertSource(
    !v2LearningMigrationSource.includes("from valid_intervals row"),
    "ROW-varattua sanaa ei saa kayttaa relaation aliaksena V2-migraatiossa",
  );

  const energyProfileFallbackStart = v2LearningMigrationSource.indexOf(
    "as hourly_energy_losses_kwh",
  );
  const observationDaysStart = v2LearningMigrationSource.indexOf(
    "as observation_days_by_hour",
    energyProfileFallbackStart,
  );
  const energyProfileFallbackSource = v2LearningMigrationSource.slice(
    Math.max(
      v2LearningMigrationSource.lastIndexOf(
        "jsonb_object_agg(",
        energyProfileFallbackStart,
      ),
      0,
    ),
    observationDaysStart,
  );

  assertSource(
    !energyProfileFallbackSource.includes("previous.hourly_energy_losses_kwh"),
    "V2:n fyysista tuntiarvoa ei saa kantaa edellisesta profiilista ilman tuoretta havaintokattavuutta",
  );
  assertSource(
    energyProfileFallbackSource.includes(
      "energy_fallback.general_energy_loss_kwh",
    ),
    "puutteellisesti havaitun V2-tunnin pitaa kayttaa tuoreesta kattavasta datasta laskettua yleista fallbackia",
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

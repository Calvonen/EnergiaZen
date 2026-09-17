import { selectRemainingFixedHeatingHours } from "./fixedHeatingPlan";
import { normalizeStoredHeatingHours } from "./heatingHourSettings";
import { getHeatingModeSettingKeys } from "./heatingModeSettings";
import { createHeatingOptimizationSettings } from "./heatingOptimizer";
import {
  currentSettingsStorageMigrationVersion,
  migrateStoredSettings,
} from "./settingsStorageMigration";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function hour(id: string, start: string, price: number) {
  const date = new Date(start);

  return {
    date,
    endDate: new Date(date.getTime() + 60 * 60 * 1000),
    id,
    price,
  };
}

export function runHeatingSettingsUnitTests() {
  const preservedLegacySeventyFive = migrateStoredSettings(
    { v2TargetReservePercent: 75 },
    null,
  );
  assertEqual(
    {
      changed: preservedLegacySeventyFive.changed,
      migrationVersion: preservedLegacySeventyFive.migrationVersion,
      value: preservedLegacySeventyFive.settings.v2TargetReservePercent,
    },
    {
      changed: false,
      migrationVersion: currentSettingsStorageMigrationVersion,
      value: 75,
    },
    "vanha 75 prosentin arvo sailyy koska sen alkuperaa oletuksena tai kayttajavalintana ei voida erottaa",
  );

  const alreadyVersionedUserChoice = migrateStoredSettings(
    { v2TargetReservePercent: 75 },
    currentSettingsStorageMigrationVersion,
  );
  assertEqual(
    {
      changed: alreadyVersionedUserChoice.changed,
      value: alreadyVersionedUserChoice.settings.v2TargetReservePercent,
    },
    { changed: false, value: 75 },
    "versionoidun migraation jalkeen kayttajan 75 prosenttia sailyy",
  );

  const existingCustomRecommendation = migrateStoredSettings(
    { v2TargetReservePercent: 80 },
    null,
  );
  assertEqual(
    {
      changed: existingCustomRecommendation.changed,
      value: existingCustomRecommendation.settings.v2TargetReservePercent,
    },
    { changed: false, value: 80 },
    "vanha ei-oletusarvoinen kayttajavalinta sailyy migraatiossa",
  );

  assertEqual(
    normalizeStoredHeatingHours({ heatingHoursPerDay: 4 }),
    { automaticMaxHeatingHours: 4, fixedHeatingHoursPerDay: 4 },
    "vanha tuntiasetus migroidaan molempien tilojen arvoksi",
  );

  assertEqual(
    normalizeStoredHeatingHours({
      automaticMaxHeatingHours: 3,
      fixedHeatingHoursPerDay: 2,
      heatingHoursPerDay: 6,
    }),
    { automaticMaxHeatingHours: 3, fixedHeatingHoursPerDay: 2 },
    "tilakohtaiset arvot sailyvat erillisina tilaa vaihdettaessa",
  );

  assertEqual(
    createHeatingOptimizationSettings(
      {
        automaticMaxHeatingHours: 5,
        fullTankAverageTemperature: 70,
        fullTankShowers: 6,
        minTankTemperature: 10,
        safetyShowerReserve: 2,
        targetShowerReserve: 4,
      },
      8,
    ).maxHeatingHours,
    5,
    "automaattinen optimointi kayttaa omaa enimmäistuntiarvoaan",
  );

  assertEqual(
    getHeatingModeSettingKeys("automatic"),
    [
      "targetShowerReserve",
      "safetyShowerReserve",
      "automaticMaxHeatingHours",
    ],
    "automaattitila nayttaa vain lampimavesivarauksen asetukset",
  );

  assertEqual(
    getHeatingModeSettingKeys("fixed"),
    ["fixedHeatingHoursPerDay"],
    "kiintea tila piilottaa automaattiasetukset ja nayttaa oman tuntikentan",
  );

  const selectedHours = selectRemainingFixedHeatingHours({
    completedHeatingHours: 0,
    fixedHeatingHoursPerDay: 2,
    hours: [
      hour("past", "2026-07-22T08:00:00.000Z", 0),
      hour("expensive", "2026-07-22T10:00:00.000Z", 10),
      hour("cheapest", "2026-07-22T11:00:00.000Z", 1),
      hour("second", "2026-07-22T12:00:00.000Z", 2),
    ],
    now: new Date("2026-07-22T09:30:00.000Z"),
  });

  assertEqual(
    selectedHours.map((item) => item.id),
    ["cheapest", "second"],
    "kiintea tila valitsee asetetun maaran jaljella olevia halvimpia tunteja",
  );

  assertEqual(
    selectRemainingFixedHeatingHours({
      completedHeatingHours: 1,
      fixedHeatingHoursPerDay: 2,
      hours: selectedHours,
      now: new Date("2026-07-22T09:30:00.000Z"),
    }).length,
    1,
    "toteutunut kiintea tunti vahentaa paivan jaljella olevaa tarvetta",
  );
}

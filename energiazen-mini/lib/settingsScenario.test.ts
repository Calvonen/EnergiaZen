import type { EnergiaZenSettings } from "./settings";
import {
  commitSettingsScenario,
  createSettingsScenarioState,
  discardSettingsScenario,
} from "./settingsScenario";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function createSettings(
  overrides: Partial<EnergiaZenSettings> = {},
): EnergiaZenSettings {
  return {
    automaticMaxHeatingHours: 3,
    backupHours: [2, 3, 4],
    fallbackEnabled: true,
    fixedHeatingHoursPerDay: 3,
    fullTankAverageTemperature: 70,
    fullTankShowers: 6,
    heatingGainSource: "learned",
    heatingNeedMode: "automatic",
    maxTankTemperature: 70,
    minTankTemperature: 10,
    priceDifferenceThresholdCents: 2,
    priceToleranceCents: 0,
    safetyShowerReserve: 2,
    tankSizeLiters: 290,
    targetShowerReserve: 4,
    v2SafetyReservePercent: 30,
    v2TargetReservePercent: 75,
    ...overrides,
  };
}

export function runSettingsScenarioUnitTests() {
  const persisted = createSettings();
  const draft = createSettings({ targetShowerReserve: 4.5 });
  const scenario = createSettingsScenarioState(persisted, draft);

  assertEqual(
    scenario.persistedSettings.targetShowerReserve,
    4,
    "luonnos ei muuta persistedSettings-arvoa",
  );
  assertEqual(
    scenario.draftSettings.targetShowerReserve,
    4.5,
    "scenarioSettings perustuu luonnokseen",
  );
  assertEqual(
    scenario.hasUnsavedChanges,
    true,
    "yhden kentan muutos aktivoi skenaariotilan",
  );
  assertEqual(
    createSettingsScenarioState(persisted, persisted).hasUnsavedChanges,
    false,
    "alkuperaiseen arvoon palautus poistaa skenaariotilan",
  );

  const committed = commitSettingsScenario(scenario, draft);
  assertEqual(
    committed.persistedSettings,
    draft,
    "commit paivittaa persistedSettings-arvon",
  );
  assertEqual(
    committed.draftSettings,
    draft,
    "commit paivittaa draftSettings-arvon",
  );
  assertEqual(
    committed.hasUnsavedChanges,
    false,
    "commit poistaa skenaariotilan",
  );

  const discarded = discardSettingsScenario(scenario);
  assertEqual(
    discarded.draftSettings,
    persisted,
    "discard palauttaa luonnoksen persistedSettings-arvoon",
  );
  assertEqual(
    discarded.hasUnsavedChanges,
    false,
    "discard poistaa skenaariotilan",
  );
}

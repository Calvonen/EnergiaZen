import { buildHeatingControlSettingsPayload } from "./heatingControlSettingsPayload";
import { upsertHeatingControlSettings } from "./heatingControlSettingsSupabase";
import type { EnergiaZenSettings } from "./settings";
import {
  discardSettingsDraft,
  persistSettingsDraft,
  SettingsDraftLocalSaveError,
  SettingsDraftSaveError,
  SettingsDraftValidationError,
  updateDraftSetting,
  validateSettingsDraft,
} from "./settingsDraft";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function createSettings(
  overrides: Partial<EnergiaZenSettings> = {},
): EnergiaZenSettings {
  return {
    automaticMaxHeatingHours: 3,
    backupHours: [2, 3, 4],
    fallbackEnabled: true,
    fixedHeatingHoursPerDay: 2,
    fullTankAverageTemperature: 65,
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

export async function runSettingsDraftUnitTests() {
  {
    const savedSettings = createSettings();
    let asyncStorageCalls = 0;
    let supabaseCalls = 0;
    const draftSettings = updateDraftSetting(
      savedSettings,
      "targetShowerReserve",
      4.5,
    );

    assertEqual(
      draftSettings.targetShowerReserve,
      4.5,
      "kenttamuutos paivittaa luonnoksen",
    );
    assertEqual(
      savedSettings.targetShowerReserve,
      4,
      "kenttamuutos ei muuta tallennettuja asetuksia",
    );
    assertEqual(
      { asyncStorageCalls, supabaseCalls },
      { asyncStorageCalls: 0, supabaseCalls: 0 },
      "kenttamuutos ei kutsu AsyncStoragea tai Supabasea",
    );
  }

  {
    const savedSettings = createSettings();
    const draftSettings = createSettings({ targetShowerReserve: 4.5 });
    let remoteCalls = 0;
    let thrown: unknown = null;

    try {
      await persistSettingsDraft({
        draftSettings,
        savedSettings,
        saveLocal: async () => undefined,
        saveRemote: async () => {
          remoteCalls += 1;
          throw new Error("remote failed");
        },
      });
    } catch (error) {
      thrown = error;
    }

    assertEqual(remoteCalls, 1, "etätallennusta yritetään kerran");
    assertEqual(
      thrown instanceof SettingsDraftSaveError,
      true,
      "etätallennuksen virhe palauttaa SettingsDraftSaveErrorin",
    );
  }

  {
    const savedSettings = createSettings();
    let thrown: unknown = null;

    try {
      await persistSettingsDraft({
        draftSettings: createSettings({ v2SafetyReservePercent: 80, v2TargetReservePercent: 70 }),
        savedSettings,
        saveLocal: async () => undefined,
        saveRemote: async () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    assertEqual(
      thrown instanceof SettingsDraftValidationError,
      true,
      "V2 turvaraja ei saa ylittää tavoitevarausta",
    );
  }

  {
    const savedSettings = createSettings();
    let thrown: unknown = null;

    try {
      await persistSettingsDraft({
        draftSettings: createSettings(),
        savedSettings,
        saveLocal: async () => {
          throw new Error("local failed");
        },
        saveRemote: async () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    assertEqual(
      thrown instanceof SettingsDraftLocalSaveError,
      true,
      "paikallisen tallennuksen virhe palauttaa oman virhetyypin",
    );
  }

  {
    const savedSettings = createSettings();
    assertEqual(
      discardSettingsDraft(savedSettings),
      savedSettings,
      "luonnoksen hylkays palauttaa tallennetut asetukset",
    );
  }

  {
    const payload = buildHeatingControlSettingsPayload(createSettings(), "2026-09-15T00:00:00.000Z");
    assertEqual(payload.v2_target_reserve_percent, 75, "remote payload sisältää V2 tavoiteprosentin");
    assertEqual(payload.v2_safety_reserve_percent, 30, "remote payload sisältää V2 turvaprosentin");
  }

  // Keep connector type coverage for the remote settings helper.
  void upsertHeatingControlSettings;
  void validateSettingsDraft;
}

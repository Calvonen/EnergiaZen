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
        saveLocal: async () => {
          throw new Error("AsyncStorage unavailable");
        },
        saveRemote: async () => {
          remoteCalls += 1;
        },
      });
    } catch (error) {
      thrown = error;
    }

    assertEqual(
      thrown instanceof SettingsDraftLocalSaveError,
      true,
      "paikallinen tallennusvirhe tunnistetaan erikseen",
    );
    assertEqual(
      remoteCalls,
      0,
      "Supabasea ei kutsuta jos paikallinen tallennus epaonnistuu",
    );
  }

  {
    const savedSettings = createSettings();
    let localCalls = 0;
    let remoteCalls = 0;
    const draftSettings = updateDraftSetting(
      savedSettings,
      "fullTankShowers",
      8,
    );
    const discarded = discardSettingsDraft(savedSettings);

    assertEqual(
      discarded,
      savedSettings,
      "peruminen palauttaa tallennetut asetukset",
    );
    assertEqual(
      draftSettings.fullTankShowers,
      8,
      "peruminen ei tarvitse tallennuskutsua luonnoksen palauttamiseen",
    );
    assertEqual(
      { localCalls, remoteCalls },
      { localCalls: 0, remoteCalls: 0 },
      "peruminen ei kutsu AsyncStoragea tai Supabasea",
    );
  }

  {
    const savedSettings = createSettings();
    const draftSettings = createSettings({ targetShowerReserve: 4.5 });
    const localWrites: EnergiaZenSettings[] = [];
    const remotePayloads: unknown[] = [];
    const persisted = await persistSettingsDraft({
      draftSettings,
      savedSettings,
      saveLocal: async (settings) => {
        localWrites.push(settings);
      },
      saveRemote: async (settings) => {
        await upsertHeatingControlSettings(
          {
            from(table) {
              assertEqual(
                table,
                "heating_control_settings",
                "Supabase-kohde on heating_control_settings",
              );
              return {
                async upsert(payload, options) {
                  remotePayloads.push(payload);
                  assertEqual(
                    options,
                    { onConflict: "id" },
                    "upsert kohdistuu id=1-riviin",
                  );
                  return { error: null };
                },
              };
            },
          },
          settings,
        );
      },
    });

    assertEqual(localWrites, [draftSettings], "tallennus kirjoittaa AsyncStorageen kerran");
    assertEqual(remotePayloads.length, 1, "tallennus upsertaa Supabaseen kerran");
    assertEqual(persisted, draftSettings, "onnistunut tallennus palauttaa uuden savedSettings-arvon");

    const payload = remotePayloads[0] as Record<string, unknown>;
    assertEqual(
      {
        backup_hours: payload.backup_hours,
        automatic_max_heating_hours: payload.automatic_max_heating_hours,
        fallback_enabled: payload.fallback_enabled,
        full_tank_average_temperature:
          payload.full_tank_average_temperature,
        full_tank_showers: payload.full_tank_showers,
        heating_gain_source: payload.heating_gain_source,
        heating_need_mode: payload.heating_need_mode,
        id: payload.id,
        max_tank_temperature: payload.max_tank_temperature,
        min_tank_temperature: payload.min_tank_temperature,
        safety_shower_reserve: payload.safety_shower_reserve,
        target_shower_reserve: payload.target_shower_reserve,
        timezone: payload.timezone,
        updatedAtIsString: typeof payload.updated_at === "string",
      },
      {
        backup_hours: [2, 3, 4],
        automatic_max_heating_hours: 3,
        fallback_enabled: true,
        full_tank_average_temperature: 65,
        full_tank_showers: 6,
        heating_gain_source: "learned",
        heating_need_mode: "automatic",
        id: 1,
        max_tank_temperature: 70,
        min_tank_temperature: 10,
        safety_shower_reserve: 2,
        target_shower_reserve: 4.5,
        timezone: "Europe/Helsinki",
        updatedAtIsString: true,
      },
      "upsert-payload sisaltaa kaikki ohjaimen tarvitsemat kentat",
    );
  }

  {
    const savedSettings = createSettings();
    const invalidDraft = createSettings({
      fullTankShowers: 4,
      targetShowerReserve: 5,
    });
    let localCalls = 0;
    let remoteCalls = 0;
    let thrown: unknown = null;

    try {
      await persistSettingsDraft({
        draftSettings: invalidDraft,
        savedSettings,
        saveLocal: async () => {
          localCalls += 1;
        },
        saveRemote: async () => {
          remoteCalls += 1;
        },
      });
    } catch (error) {
      thrown = error;
    }

    assertEqual(
      thrown instanceof SettingsDraftValidationError,
      true,
      "invalidi luonnos estaa tallennuksen",
    );
    assertEqual(
      { localCalls, remoteCalls },
      { localCalls: 0, remoteCalls: 0 },
      "invalidi luonnos ei kirjoita paikallisesti tai Supabaseen",
    );
  }

  {
    const savedSettings = createSettings();
    const warningDraft = createSettings({
      safetyShowerReserve: 1,
      targetShowerReserve: 1,
    });
    const validation = validateSettingsDraft(warningDraft, savedSettings);
    let localCalls = 0;
    let remoteCalls = 0;

    await persistSettingsDraft({
      draftSettings: warningDraft,
      savedSettings,
      saveLocal: async () => {
        localCalls += 1;
      },
      saveRemote: async () => {
        remoteCalls += 1;
      },
    });

    assertEqual(validation.errors, [], "varoitus ei ole estava virhe");
    assertEqual(validation.warnings.length > 0, true, "pieni tavoite antaa varoituksen");
    assertEqual(
      { localCalls, remoteCalls },
      { localCalls: 1, remoteCalls: 1 },
      "varoitus ei esta tallennusta",
    );
  }

  {
    const savedSettings = createSettings();
    const draftSettings = createSettings({ targetShowerReserve: 4.5 });
    const localWrites: EnergiaZenSettings[] = [];
    let thrown: unknown = null;

    try {
      await persistSettingsDraft({
        draftSettings,
        savedSettings,
        saveLocal: async (settings) => {
          localWrites.push(settings);
        },
        saveRemote: async () => {
          throw new Error("Supabase unavailable");
        },
      });
    } catch (error) {
      thrown = error;
    }

    assertEqual(
      thrown instanceof SettingsDraftSaveError &&
        thrown.rollbackSucceeded,
      true,
      "Supabase-virhe raportoi onnistuneen paikallisen rollbackin",
    );
    assertEqual(
      localWrites,
      [draftSettings, savedSettings],
      "Supabase-virhe palauttaa AsyncStoragen aiempaan kokonaisuuteen",
    );
    assertEqual(
      draftSettings.targetShowerReserve,
      4.5,
      "Supabase-virhe sailyttaa luonnoksen kayttajalle",
    );
    assertEqual(
      savedSettings.targetShowerReserve,
      4,
      "Supabase-virhe ei muuta savedSettings-arvoa",
    );
  }

  {
    const payload = buildHeatingControlSettingsPayload(
      createSettings(),
      "2026-07-26T12:00:00.000Z",
    );
    assertEqual(
      payload.updated_at,
      "2026-07-26T12:00:00.000Z",
      "payloadin updated_at asetetaan tallennushetkesta",
    );
  }

  for (const [previousSource, nextSource] of [
    ["learned", "fixed"],
    ["fixed", "learned"],
  ] as const) {
    const savedSettings = createSettings({ heatingGainSource: previousSource });
    const nextSettings = createSettings({
      automaticMaxHeatingHours: 5,
      heatingGainSource: nextSource,
      safetyShowerReserve: 1.5,
      targetShowerReserve: 3.5,
    });
    const remotePayloads: Record<string, unknown>[] = [];

    await persistSettingsDraft({
      draftSettings: nextSettings,
      savedSettings,
      saveLocal: async () => {},
      saveRemote: async (settings) => {
        await upsertHeatingControlSettings(
          {
            from() {
              return {
                async upsert(payload) {
                  remotePayloads.push(payload);
                  return { error: null };
                },
              };
            },
          },
          settings,
        );
      },
    });

    assertEqual(
      {
        automatic_max_heating_hours:
          remotePayloads[0]?.automatic_max_heating_hours,
        heating_gain_source: remotePayloads[0]?.heating_gain_source,
        heating_need_mode: remotePayloads[0]?.heating_need_mode,
        safety_shower_reserve: remotePayloads[0]?.safety_shower_reserve,
        target_shower_reserve: remotePayloads[0]?.target_shower_reserve,
      },
      {
        automatic_max_heating_hours: 5,
        heating_gain_source: nextSource,
        heating_need_mode: "automatic",
        safety_shower_reserve: 1.5,
        target_shower_reserve: 3.5,
      },
      `${previousSource} -> ${nextSource} writes the full authoritative settings payload`,
    );
  }

  {
    const invalidNumbers = {
      ...createSettings(),
      fullTankShowers: Number.NaN,
      maxTankTemperature: Number.POSITIVE_INFINITY,
    };
    assertEqual(
      validateSettingsDraft(invalidNumbers, createSettings()).errors.length >= 2,
      true,
      "NaN ja aareton arvo ovat estavia virheita",
    );
  }

  {
    const savedSettings = createSettings();
    const invalidRelations = validateSettingsDraft(
      createSettings({
        fullTankAverageTemperature: 71,
        maxTankTemperature: 70,
      }),
      savedSettings,
    );
    assertEqual(
      invalidRelations.errors.some(
        (issue) =>
          issue.field === "fullTankAverageTemperature" &&
          issue.message.includes("maksimilämpötilaa"),
      ),
      true,
      "tayden varaajan lampotila ei saa ylittaa maksimia",
    );
  }
}

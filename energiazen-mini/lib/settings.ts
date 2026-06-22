import AsyncStorage from "@react-native-async-storage/async-storage";

export const defaultTankTemperature = 58;

export const defaultSettings = {
  tankSizeLiters: 290,
  heatingHoursPerDay: 3,
  priceDifferenceThresholdCents: 2,
  minTankTemperature: 10,
  maxTankTemperature: 70,
  fullTankAverageTemperature: 70,
  fullTankShowers: 6,
};

export type EnergiaZenSettings = typeof defaultSettings;

export type EditableSettingKey =
  | "tankSizeLiters"
  | "heatingHoursPerDay"
  | "priceDifferenceThresholdCents"
  | "fullTankShowers"
  | "maxTankTemperature"
  | "fullTankAverageTemperature";

export const settingsStorageKey = "energiazen:settings";

const editableSettingRanges = {
  tankSizeLiters: { max: 1000, min: 50 },
  heatingHoursPerDay: { max: 6, min: 1 },
  priceDifferenceThresholdCents: { max: 10, min: 0 },
  fullTankShowers: { max: 10, min: 3 },
  maxTankTemperature: { max: 90, min: 40 },
  fullTankAverageTemperature: { max: 90, min: 20 },
} as const satisfies Record<EditableSettingKey, { max: number; min: number }>;

function clampSettingValue(key: EditableSettingKey, value: number) {
  const range = editableSettingRanges[key];
  const roundedValue = Math.round(value);

  return Math.min(Math.max(roundedValue, range.min), range.max);
}

type LegacySettings = Partial<EnergiaZenSettings> & {
  showersAtMaxTemperature?: number;
  tankVolumeLiters?: number;
};

export function normalizeSettings(
  settings: LegacySettings,
): EnergiaZenSettings {
  const tankSizeLiters = settings.tankSizeLiters ?? settings.tankVolumeLiters;
  const fullTankShowers =
    settings.fullTankShowers ?? settings.showersAtMaxTemperature;

  return {
    heatingHoursPerDay:
      typeof settings.heatingHoursPerDay === "number"
        ? clampSettingValue("heatingHoursPerDay", settings.heatingHoursPerDay)
        : defaultSettings.heatingHoursPerDay,
    priceDifferenceThresholdCents:
      typeof settings.priceDifferenceThresholdCents === "number"
        ? clampSettingValue(
            "priceDifferenceThresholdCents",
            settings.priceDifferenceThresholdCents,
          )
        : defaultSettings.priceDifferenceThresholdCents,
    minTankTemperature: defaultSettings.minTankTemperature,
    tankSizeLiters:
      typeof tankSizeLiters === "number"
        ? clampSettingValue("tankSizeLiters", tankSizeLiters)
        : defaultSettings.tankSizeLiters,
    fullTankShowers:
      typeof fullTankShowers === "number"
        ? clampSettingValue("fullTankShowers", fullTankShowers)
        : defaultSettings.fullTankShowers,
    maxTankTemperature:
      typeof settings.maxTankTemperature === "number"
        ? clampSettingValue("maxTankTemperature", settings.maxTankTemperature)
        : defaultSettings.maxTankTemperature,
    fullTankAverageTemperature:
      typeof settings.fullTankAverageTemperature === "number"
        ? clampSettingValue(
            "fullTankAverageTemperature",
            settings.fullTankAverageTemperature,
          )
        : typeof settings.maxTankTemperature === "number"
          ? clampSettingValue("maxTankTemperature", settings.maxTankTemperature)
          : defaultSettings.fullTankAverageTemperature,
  };
}

export async function loadSettings() {
  try {
    const storedSettings = await AsyncStorage.getItem(settingsStorageKey);

    if (!storedSettings) {
      return defaultSettings;
    }

    return normalizeSettings(JSON.parse(storedSettings));
  } catch {
    return defaultSettings;
  }
}

export async function saveSettings(settings: EnergiaZenSettings) {
  await AsyncStorage.setItem(
    settingsStorageKey,
    JSON.stringify(normalizeSettings(settings)),
  );
}

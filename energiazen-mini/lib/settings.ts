import AsyncStorage from "@react-native-async-storage/async-storage";

export const defaultSettings = {
  tankVolumeLiters: 300,
  heatingHoursPerDay: 3,
  priceDifferenceThresholdCents: 2,
  minTankTemperature: 20,
  maxTankTemperature: 80,
  showersAtMaxTemperature: 6,
};

export type EnergiaZenSettings = typeof defaultSettings;

export type EditableSettingKey =
  | "heatingHoursPerDay"
  | "priceDifferenceThresholdCents"
  | "showersAtMaxTemperature";

export const settingsStorageKey = "energiazen:settings";

const editableSettingRanges = {
  heatingHoursPerDay: { max: 6, min: 1 },
  priceDifferenceThresholdCents: { max: 10, min: 0 },
  showersAtMaxTemperature: { max: 10, min: 3 },
} as const satisfies Record<EditableSettingKey, { max: number; min: number }>;

function clampSettingValue(key: EditableSettingKey, value: number) {
  const range = editableSettingRanges[key];
  const roundedValue = Math.round(value);

  return Math.min(Math.max(roundedValue, range.min), range.max);
}

export function normalizeSettings(
  settings: Partial<EnergiaZenSettings>,
): EnergiaZenSettings {
  return {
    ...defaultSettings,
    ...settings,
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
    showersAtMaxTemperature:
      typeof settings.showersAtMaxTemperature === "number"
        ? clampSettingValue(
            "showersAtMaxTemperature",
            settings.showersAtMaxTemperature,
          )
        : defaultSettings.showersAtMaxTemperature,
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

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  defaultSafetyShowerReserve,
  defaultTargetShowerReserve,
  normalizeStoredShowerReserves,
} from "./showerReserveSettings";

export { normalizeStoredShowerReserves } from "./showerReserveSettings";

export const defaultTankTemperature = 58;

export type HeatingNeedMode = "automatic" | "fixed";

export const defaultSettings = {
  tankSizeLiters: 290,
  heatingNeedMode: "automatic" as HeatingNeedMode,
  fallbackEnabled: true,
  backupHours: [2, 3, 4],
  heatingHoursPerDay: 3,
  priceDifferenceThresholdCents: 2,
  minTankTemperature: 10,
  maxTankTemperature: 70,
  fullTankAverageTemperature: 70,
  fullTankShowers: 6,
  targetShowerReserve: defaultTargetShowerReserve,
  safetyShowerReserve: defaultSafetyShowerReserve,
};

export type EnergiaZenSettings = typeof defaultSettings;

export type EditableSettingKey =
  | "tankSizeLiters"
  | "heatingHoursPerDay"
  | "fullTankShowers"
  | "targetShowerReserve"
  | "safetyShowerReserve"
  | "maxTankTemperature"
  | "fullTankAverageTemperature";

export const settingsStorageKey = "energiazen:settings";

const editableSettingRanges = {
  tankSizeLiters: { max: 1000, min: 50 },
  heatingHoursPerDay: { max: 6, min: 1 },
  fullTankShowers: { max: 10, min: 3 },
  targetShowerReserve: { max: 10, min: 0.5 },
  safetyShowerReserve: { max: 9.5, min: 0 },
  maxTankTemperature: { max: 90, min: 40 },
  fullTankAverageTemperature: { max: 90, min: 20 },
} as const satisfies Record<EditableSettingKey, { max: number; min: number }>;

function clampSettingValue(key: EditableSettingKey, value: number) {
  const range = editableSettingRanges[key];
  const roundedValue =
    key === "targetShowerReserve" || key === "safetyShowerReserve"
      ? Math.round(value * 2) / 2
      : Math.round(value);

  return Math.min(Math.max(roundedValue, range.min), range.max);
}

type LegacySettings = Partial<EnergiaZenSettings> & {
  minimumShowersBeforeExpensiveTomorrow?: number;
  showersAtMaxTemperature?: number;
  tankVolumeLiters?: number;
};

export function normalizeSettings(
  settings: LegacySettings,
): EnergiaZenSettings {
  const tankSizeLiters = settings.tankSizeLiters ?? settings.tankVolumeLiters;
  const fullTankShowers =
    settings.fullTankShowers ?? settings.showersAtMaxTemperature;
  const normalizedFullTankShowers =
    typeof fullTankShowers === "number"
      ? clampSettingValue("fullTankShowers", fullTankShowers)
      : defaultSettings.fullTankShowers;
  const showerReserves = normalizeStoredShowerReserves({
    fullTankShowers: normalizedFullTankShowers,
    minimumShowersBeforeExpensiveTomorrow:
      settings.minimumShowersBeforeExpensiveTomorrow,
    safetyShowerReserve: settings.safetyShowerReserve,
    targetShowerReserve: settings.targetShowerReserve,
  });
  const backupHours = Array.isArray(settings.backupHours)
    ? [
        ...new Set(
          settings.backupHours.filter(
            (hour): hour is number =>
              Number.isInteger(hour) && hour >= 0 && hour <= 23,
          ),
        ),
      ].sort((a, b) => a - b)
    : defaultSettings.backupHours;

  return {
    heatingNeedMode:
      settings.heatingNeedMode === "fixed"
        ? "fixed"
        : defaultSettings.heatingNeedMode,
    fallbackEnabled:
      typeof settings.fallbackEnabled === "boolean"
        ? settings.fallbackEnabled
        : defaultSettings.fallbackEnabled,
    backupHours:
      backupHours.length > 0 ? backupHours : defaultSettings.backupHours,
    heatingHoursPerDay:
      typeof settings.heatingHoursPerDay === "number"
        ? clampSettingValue("heatingHoursPerDay", settings.heatingHoursPerDay)
        : defaultSettings.heatingHoursPerDay,
    priceDifferenceThresholdCents:
      typeof settings.priceDifferenceThresholdCents === "number"
        ? Math.min(
            Math.max(Math.round(settings.priceDifferenceThresholdCents), 0),
            10,
          )
        : defaultSettings.priceDifferenceThresholdCents,
    minTankTemperature: defaultSettings.minTankTemperature,
    tankSizeLiters:
      typeof tankSizeLiters === "number"
        ? clampSettingValue("tankSizeLiters", tankSizeLiters)
        : defaultSettings.tankSizeLiters,
    fullTankShowers: normalizedFullTankShowers,
    ...showerReserves,
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

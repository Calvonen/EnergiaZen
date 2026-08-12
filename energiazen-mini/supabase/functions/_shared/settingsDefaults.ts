// Pure settings defaults/types/normalization, split out of settings.ts so
// this half can be imported without pulling in AsyncStorage (settings.ts's
// loadSettings/saveSettings) - needed by anything that must also run outside
// React Native, e.g. Deno Edge Functions under supabase/functions/. Keep
// this file free of RN-only imports; settings.ts re-exports everything here
// so existing app callers are unaffected.
import {
  defaultSafetyShowerReserve,
  defaultTargetShowerReserve,
  normalizeStoredShowerReserves,
} from "./showerReserveSettings";
import {
  defaultAutomaticMaxHeatingHours,
  defaultFixedHeatingHoursPerDay,
  normalizeStoredHeatingHours,
} from "./heatingHourSettings";

export { normalizeStoredShowerReserves } from "./showerReserveSettings";

export const defaultTankTemperature = 58;

export type HeatingNeedMode = "automatic" | "fixed";

// "learned" (default): use the heating-gain value learned from real
// tank_readings once enough valid segments exist, otherwise the fixed
// fallback (see fallbackHeatingGainPerHour in lib/heatingGain.ts).
// "fixed": always use the fixed fallback, ignoring the learned value even
// when one is available - e.g. while distrusting a learned estimate that
// still has too little data behind it.
export type HeatingGainSource = "learned" | "fixed";

export const defaultSettings = {
  tankSizeLiters: 290,
  heatingNeedMode: "automatic" as HeatingNeedMode,
  fallbackEnabled: true,
  backupHours: [2, 3, 4],
  automaticMaxHeatingHours: defaultAutomaticMaxHeatingHours,
  fixedHeatingHoursPerDay: defaultFixedHeatingHoursPerDay,
  priceDifferenceThresholdCents: 2,
  minTankTemperature: 10,
  maxTankTemperature: 70,
  fullTankAverageTemperature: 70,
  fullTankShowers: 6,
  targetShowerReserve: defaultTargetShowerReserve,
  safetyShowerReserve: defaultSafetyShowerReserve,
  heatingGainSource: "learned" as HeatingGainSource,
};

export type EnergiaZenSettings = typeof defaultSettings;

export type EditableSettingKey =
  | "tankSizeLiters"
  | "automaticMaxHeatingHours"
  | "fixedHeatingHoursPerDay"
  | "fullTankShowers"
  | "targetShowerReserve"
  | "safetyShowerReserve"
  | "maxTankTemperature"
  | "fullTankAverageTemperature";

const editableSettingRanges = {
  tankSizeLiters: { max: 1000, min: 50 },
  automaticMaxHeatingHours: { max: 6, min: 1 },
  fixedHeatingHoursPerDay: { max: 6, min: 1 },
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

export type LegacySettings = Partial<EnergiaZenSettings> & {
  heatingHoursPerDay?: number;
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
  const heatingHours = normalizeStoredHeatingHours(settings);

  return {
    heatingNeedMode:
      settings.heatingNeedMode === "fixed"
        ? "fixed"
        : defaultSettings.heatingNeedMode,
    heatingGainSource:
      settings.heatingGainSource === "fixed"
        ? "fixed"
        : defaultSettings.heatingGainSource,
    fallbackEnabled:
      typeof settings.fallbackEnabled === "boolean"
        ? settings.fallbackEnabled
        : defaultSettings.fallbackEnabled,
    backupHours:
      backupHours.length > 0 ? backupHours : defaultSettings.backupHours,
    ...heatingHours,
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

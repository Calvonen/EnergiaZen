import type { HeatingNeedMode } from "./settings";

function formatHourRange(hour: number) {
  const nextHour = (hour + 1) % 24;

  return `${String(hour).padStart(2, "0")}–${String(nextHour).padStart(2, "0")}`;
}

export function getTankSettingsSummary({
  fullTankAverageTemperature,
  maxTankTemperature,
  tankSizeLiters,
}: {
  fullTankAverageTemperature: number;
  maxTankTemperature: number;
  tankSizeLiters: number;
}) {
  return `${tankSizeLiters} l · maksimi ${maxTankTemperature} °C · täysi keskilämpö ${fullTankAverageTemperature} °C`;
}

export function getShowerCalculationSummary(fullTankShowers: number) {
  return `Täysi varaaja ${fullTankShowers} suihkua`;
}

export function getWarmWaterReserveSummary({
  automaticMaxHeatingHours,
  safetyShowerReserve,
  targetShowerReserve,
}: {
  automaticMaxHeatingHours: number;
  safetyShowerReserve: number;
  targetShowerReserve: number;
}) {
  return `Tavoite ${targetShowerReserve} · turvaraja ${safetyShowerReserve} · enintään ${automaticMaxHeatingHours} h`;
}

export function getFallbackSettingsSummary({
  backupHours,
  fallbackEnabled,
}: {
  backupHours: number[];
  fallbackEnabled: boolean;
}) {
  if (!fallbackEnabled) {
    return "Pois käytöstä";
  }

  const hours = [...new Set(backupHours)].sort((first, second) => first - second);

  if (hours.length === 0) {
    return "Käytössä · ei valittuja tunteja";
  }

  if (hours.length > 3) {
    return `Käytössä · ${hours.length} valittua tuntia`;
  }

  const ranges = hours.map(formatHourRange);
  const formattedRanges =
    ranges.length === 1
      ? ranges[0]
      : `${ranges.slice(0, -1).join(", ")} ja ${ranges[ranges.length - 1]}`;

  return `Käytössä · tunnit ${formattedRanges}`;
}

export function isWarmWaterReserveSectionVisible(
  heatingNeedMode: HeatingNeedMode,
) {
  return heatingNeedMode === "automatic";
}

export function toggleExpandedSection<
  T extends Record<string, boolean>,
  K extends keyof T,
>(expandedSections: T, section: K): T {
  return {
    ...expandedSections,
    [section]: !expandedSections[section],
  } as T;
}

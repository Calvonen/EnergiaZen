import type { EnergiaZenSettings } from "./settings";

export type HeatingControlSettingsPayload = {
  backup_hours: number[];
  fallback_enabled: boolean;
  full_tank_average_temperature: number;
  full_tank_showers: number;
  id: 1;
  max_tank_temperature: number;
  min_tank_temperature: number;
  target_shower_reserve: number;
  timezone: "Europe/Helsinki";
  updated_at: string;
};

export function buildHeatingControlSettingsPayload(
  settings: EnergiaZenSettings,
  updatedAt = new Date().toISOString(),
): HeatingControlSettingsPayload {
  return {
    backup_hours: [...settings.backupHours],
    fallback_enabled: settings.fallbackEnabled,
    full_tank_average_temperature: settings.fullTankAverageTemperature,
    full_tank_showers: settings.fullTankShowers,
    id: 1,
    max_tank_temperature: settings.maxTankTemperature,
    min_tank_temperature: settings.minTankTemperature,
    target_shower_reserve: settings.targetShowerReserve,
    timezone: "Europe/Helsinki",
    updated_at: updatedAt,
  };
}

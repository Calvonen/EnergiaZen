import type { EnergiaZenSettings } from "./settings";

export type HeatingControlSettingsPayload = {
  automatic_max_heating_hours: number;
  backup_hours: number[];
  fallback_enabled: boolean;
  full_tank_average_temperature: number;
  full_tank_showers: number;
  heating_gain_source: "learned" | "fixed";
  heating_need_mode: "automatic" | "fixed";
  id: 1;
  max_tank_temperature: number;
  min_tank_temperature: number;
  safety_shower_reserve: number;
  target_shower_reserve: number;
  timezone: "Europe/Helsinki";
  updated_at: string;
};

export function buildHeatingControlSettingsPayload(
  settings: EnergiaZenSettings,
  updatedAt = new Date().toISOString(),
): HeatingControlSettingsPayload {
  return {
    automatic_max_heating_hours: settings.automaticMaxHeatingHours,
    backup_hours: [...settings.backupHours],
    fallback_enabled: settings.fallbackEnabled,
    full_tank_average_temperature: settings.fullTankAverageTemperature,
    full_tank_showers: settings.fullTankShowers,
    heating_gain_source: settings.heatingGainSource,
    heating_need_mode: settings.heatingNeedMode,
    id: 1,
    max_tank_temperature: settings.maxTankTemperature,
    min_tank_temperature: settings.minTankTemperature,
    safety_shower_reserve: settings.safetyShowerReserve,
    target_shower_reserve: settings.targetShowerReserve,
    timezone: "Europe/Helsinki",
    updated_at: updatedAt,
  };
}

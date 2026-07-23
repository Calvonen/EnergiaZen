import type { HeatingNeedMode } from "./settings";

export type HeatingModeSettingKey =
  | "automaticMaxHeatingHours"
  | "fixedHeatingHoursPerDay"
  | "safetyShowerReserve"
  | "targetShowerReserve";

export function getHeatingModeSettingKeys(
  heatingNeedMode: HeatingNeedMode,
): HeatingModeSettingKey[] {
  return heatingNeedMode === "automatic"
    ? [
        "targetShowerReserve",
        "safetyShowerReserve",
        "automaticMaxHeatingHours",
      ]
    : ["fixedHeatingHoursPerDay"];
}

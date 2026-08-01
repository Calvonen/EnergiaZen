import { clamp } from "./temperatureColors";
import { mixColors } from "./colorMixing";
import { defaultSettings, EnergiaZenSettings } from "./settings";

export function getTemperatureCardTheme(
  temperature: number,
  settings: EnergiaZenSettings = defaultSettings,
) {
  const ratio = clamp(
    (temperature - settings.minTankTemperature) /
      (settings.maxTankTemperature - settings.minTankTemperature),
    0,
    1,
  );
  const accent = mixColors("#188bff", "#ff3f46", ratio);
  const deepAccent = mixColors("#0b4f9f", "#8f151d", ratio);

  return {
    accent,
    backgroundColor: `${accent}33`,
    borderColor: `${accent}b8`,
    shadowColor: deepAccent,
  };
}

// Formats the pre-computed weekly-minimum inlet temperature for display.
// Deliberately returns a bare "--" (no degree sign) when there is no valid
// reading, rather than falling back to a default value or reusing the
// degree-sign format used for an actual number.
export function formatWeeklyMinimumInletTemperatureLabel(
  weeklyMinimumInletTemperature: number | null,
): string {
  if (weeklyMinimumInletTemperature === null) {
    return "--";
  }

  return `${Math.round(weeklyMinimumInletTemperature)}°`;
}

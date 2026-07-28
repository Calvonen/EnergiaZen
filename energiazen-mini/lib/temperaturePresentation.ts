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

import { mixColors } from "./colorMixing";
import { defaultSettings, EnergiaZenSettings } from "./settings";

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function getTemperatureColor(
  temperature: number,
  settings: EnergiaZenSettings = defaultSettings,
) {
  const normalizedTemperature = clamp(
    temperature,
    settings.minTankTemperature,
    settings.maxTankTemperature,
  );

  const temperatureRange = Math.max(
    settings.maxTankTemperature - settings.minTankTemperature,
    1,
  );
  const greenThreshold = settings.minTankTemperature + temperatureRange / 3;
  const orangeThreshold =
    settings.minTankTemperature + (temperatureRange * 2) / 3;

  if (normalizedTemperature <= greenThreshold) {
    return mixColors(
      "#188bff",
      "#26d9a2",
      (normalizedTemperature - settings.minTankTemperature) /
        (greenThreshold - settings.minTankTemperature),
    );
  }

  if (normalizedTemperature <= orangeThreshold) {
    return mixColors(
      "#26d9a2",
      "#ff9b30",
      (normalizedTemperature - greenThreshold) /
        (orangeThreshold - greenThreshold),
    );
  }

  return mixColors(
    "#ff9b30",
    "#ff3f46",
    (normalizedTemperature - orangeThreshold) /
      (settings.maxTankTemperature - orangeThreshold),
  );
}

export function getTemperatureBarSegmentColor(
  segmentIndex: number,
  segmentCount: number,
  topTemperature: number,
  bottomTemperature: number,
  settings: EnergiaZenSettings = defaultSettings,
) {
  const ratioFromTop =
    segmentCount <= 1 ? 0 : segmentIndex / (segmentCount - 1);
  const segmentTemperature =
    topTemperature + (bottomTemperature - topTemperature) * ratioFromTop;

  return getTemperatureColor(segmentTemperature, settings);
}

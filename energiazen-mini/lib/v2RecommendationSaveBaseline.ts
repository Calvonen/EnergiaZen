import type { EnergiaZenSettings } from "./settingsDefaults";

let loadedV2TargetReservePercent: number | null = null;
let effectiveSettingsPersister:
  | ((settings: EnergiaZenSettings) => Promise<void>)
  | null = null;

export function getLoadedV2TargetReservePercent() {
  return loadedV2TargetReservePercent;
}

export function setLoadedV2TargetReservePercent(value: number | null) {
  loadedV2TargetReservePercent = value;
}

export function registerEffectiveSettingsPersister(
  persister: (settings: EnergiaZenSettings) => Promise<void>,
) {
  effectiveSettingsPersister = persister;
}

export async function persistEffectiveSettingsLocally(
  settings: EnergiaZenSettings,
) {
  if (!effectiveSettingsPersister) {
    return false;
  }

  await effectiveSettingsPersister(settings);
  return true;
}

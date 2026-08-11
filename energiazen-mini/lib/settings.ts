import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  defaultSettings,
  normalizeSettings,
} from "./settingsDefaults";
import type { EnergiaZenSettings } from "./settingsDefaults";

// Pure defaults/types/normalization live in ./settingsDefaults so they can
// be imported without AsyncStorage (needed by anything that must also run
// outside React Native, e.g. Deno Edge Functions). Re-exported here
// unchanged so every existing "from ./settings" import keeps working.
export * from "./settingsDefaults";

export const settingsStorageKey = "energiazen:settings";

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

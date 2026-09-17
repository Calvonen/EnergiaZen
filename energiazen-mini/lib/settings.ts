import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  defaultSettings,
  normalizeSettings,
} from "./settingsDefaults";
import type { EnergiaZenSettings } from "./settingsDefaults";
import {
  currentSettingsStorageMigrationVersion,
  migrateStoredSettings,
} from "./settingsStorageMigration";
import { registerEffectiveSettingsPersister } from "./v2RecommendationSaveBaseline";

// Pure defaults/types/normalization live in ./settingsDefaults so they can
// be imported without AsyncStorage (needed by anything that must also run
// outside React Native, e.g. Deno Edge Functions). Re-exported here
// unchanged so every existing "from ./settings" import keeps working.
export * from "./settingsDefaults";

export const settingsStorageKey = "energiazen:settings";
export const settingsStorageMigrationVersionKey =
  "energiazen:settings:migration-version";

export async function loadSettings() {
  try {
    const [storedSettings, storedMigrationVersion] = await Promise.all([
      AsyncStorage.getItem(settingsStorageKey),
      AsyncStorage.getItem(settingsStorageMigrationVersionKey),
    ]);

    if (!storedSettings) {
      return defaultSettings;
    }

    const parsedSettings = JSON.parse(storedSettings);
    const parsedMigrationVersion = Number(storedMigrationVersion);
    const migration = migrateStoredSettings(
      parsedSettings,
      Number.isFinite(parsedMigrationVersion) ? parsedMigrationVersion : null,
    );
    const normalizedSettings = normalizeSettings(migration.settings);

    if (
      migration.changed ||
      parsedMigrationVersion !== currentSettingsStorageMigrationVersion
    ) {
      try {
        await AsyncStorage.multiSet([
          [settingsStorageKey, JSON.stringify(normalizedSettings)],
          [
            settingsStorageMigrationVersionKey,
            String(currentSettingsStorageMigrationVersion),
          ],
        ]);
      } catch {
        // The migrated in-memory value is still safer than falling back to
        // defaults. A later successful save/load can persist the marker.
      }
    }

    return normalizedSettings;
  } catch {
    return defaultSettings;
  }
}

export async function saveSettings(settings: EnergiaZenSettings) {
  await AsyncStorage.multiSet([
    [settingsStorageKey, JSON.stringify(normalizeSettings(settings))],
    [
      settingsStorageMigrationVersionKey,
      String(currentSettingsStorageMigrationVersion),
    ],
  ]);
}

registerEffectiveSettingsPersister(saveSettings);

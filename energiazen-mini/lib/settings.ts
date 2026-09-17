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

let loadedSettingsMigrationVersion = currentSettingsStorageMigrationVersion;

export async function loadSettings() {
  try {
    const [storedSettings, storedMigrationVersion] = await Promise.all([
      AsyncStorage.getItem(settingsStorageKey),
      AsyncStorage.getItem(settingsStorageMigrationVersionKey),
    ]);

    if (!storedSettings) {
      loadedSettingsMigrationVersion = currentSettingsStorageMigrationVersion;
      return defaultSettings;
    }

    const parsedSettings = JSON.parse(storedSettings);
    const parsedMigrationVersion = Number(storedMigrationVersion);
    const previousMigrationVersion = Number.isFinite(parsedMigrationVersion)
      ? parsedMigrationVersion
      : null;
    const migration = migrateStoredSettings(
      parsedSettings,
      previousMigrationVersion,
    );
    const normalizedSettings = normalizeSettings(migration.settings);
    loadedSettingsMigrationVersion = migration.migrationVersion;

    const isFutureVersion =
      previousMigrationVersion !== null &&
      previousMigrationVersion > currentSettingsStorageMigrationVersion;

    // A rolled-back binary must never rewrite settings created by a newer
    // binary. It can normalize a compatible in-memory view, but the durable
    // future-version payload and marker remain untouched until a newer binary
    // owns that migration version again.
    if (
      !isFutureVersion &&
      (migration.changed ||
        previousMigrationVersion !== migration.migrationVersion)
    ) {
      try {
        await AsyncStorage.multiSet([
          [settingsStorageKey, JSON.stringify(normalizedSettings)],
          [
            settingsStorageMigrationVersionKey,
            String(migration.migrationVersion),
          ],
        ]);
      } catch {
        // The migrated in-memory value is still safer than falling back to
        // defaults. A later successful save/load can persist the marker.
      }
    }

    return normalizedSettings;
  } catch {
    loadedSettingsMigrationVersion = currentSettingsStorageMigrationVersion;
    return defaultSettings;
  }
}

export async function saveSettings(settings: EnergiaZenSettings) {
  await AsyncStorage.multiSet([
    [settingsStorageKey, JSON.stringify(normalizeSettings(settings))],
    [
      settingsStorageMigrationVersionKey,
      String(
        Math.max(
          loadedSettingsMigrationVersion,
          currentSettingsStorageMigrationVersion,
        ),
      ),
    ],
  ]);
}

registerEffectiveSettingsPersister(saveSettings);
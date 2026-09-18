import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  defaultSettings,
  normalizeSettings,
} from "./settingsDefaults";
import type { EnergiaZenSettings } from "./settingsDefaults";
import {
  currentSettingsStorageMigrationVersion,
  mergeSettingsForStorage,
  migrateStoredSettings,
} from "./settingsStorageMigration";
import {
  hydratePendingV2Recommendation,
  registerEffectiveSettingsPersister,
  registerPendingV2RecommendationPersister,
  type PendingV2Recommendation,
} from "./v2RecommendationSaveBaseline";

// Pure defaults/types/normalization live in ./settingsDefaults so they can
// be imported without AsyncStorage (needed by anything that must also run
// outside React Native, e.g. Deno Edge Functions). Re-exported here
// unchanged so every existing "from ./settings" import keeps working.
export * from "./settingsDefaults";

export const settingsStorageKey = "energiazen:settings";
export const settingsStorageMigrationVersionKey =
  "energiazen:settings:migration-version";
export const pendingV2RecommendationStorageKey =
  "energiazen:v2-recommendation:pending";

let loadedSettingsMigrationVersion = currentSettingsStorageMigrationVersion;
let loadedRawSettingsPayload: unknown = null;

function parsePendingV2Recommendation(
  value: string | null,
): PendingV2Recommendation | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<PendingV2Recommendation>;
    if (
      typeof parsed.value === "number" &&
      Number.isFinite(parsed.value) &&
      typeof parsed.savedAt === "string" &&
      Number.isFinite(Date.parse(parsed.savedAt))
    ) {
      return { value: parsed.value, savedAt: parsed.savedAt };
    }
  } catch {
    // Ignore a corrupt marker and continue without pending-save precedence.
  }

  return null;
}

export async function loadSettings() {
  try {
    const [storedSettings, storedMigrationVersion, storedPendingRecommendation] =
      await Promise.all([
        AsyncStorage.getItem(settingsStorageKey),
        AsyncStorage.getItem(settingsStorageMigrationVersionKey),
        AsyncStorage.getItem(pendingV2RecommendationStorageKey),
      ]);

    hydratePendingV2Recommendation(
      parsePendingV2Recommendation(storedPendingRecommendation),
    );

    if (!storedSettings) {
      loadedSettingsMigrationVersion = currentSettingsStorageMigrationVersion;
      loadedRawSettingsPayload = null;
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
    loadedRawSettingsPayload = parsedSettings;

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
        loadedRawSettingsPayload = normalizedSettings;
      } catch {
        // The migrated in-memory value is still safer than falling back to
        // defaults. A later successful save/load can persist the marker.
      }
    }

    return normalizedSettings;
  } catch {
    loadedSettingsMigrationVersion = currentSettingsStorageMigrationVersion;
    loadedRawSettingsPayload = null;
    hydratePendingV2Recommendation(null);
    return defaultSettings;
  }
}

export async function saveSettings(settings: EnergiaZenSettings) {
  const normalizedSettings = normalizeSettings(settings);
  const migrationVersion = Math.max(
    loadedSettingsMigrationVersion,
    currentSettingsStorageMigrationVersion,
  );
  const settingsForStorage = mergeSettingsForStorage({
    migrationVersion,
    normalizedSettings,
    rawStoredSettings: loadedRawSettingsPayload,
  });

  await AsyncStorage.multiSet([
    [settingsStorageKey, JSON.stringify(settingsForStorage)],
    [settingsStorageMigrationVersionKey, String(migrationVersion)],
  ]);

  loadedSettingsMigrationVersion = migrationVersion;
  loadedRawSettingsPayload = settingsForStorage;
}

registerEffectiveSettingsPersister(saveSettings);
registerPendingV2RecommendationPersister(async (pending) => {
  if (pending) {
    await AsyncStorage.setItem(
      pendingV2RecommendationStorageKey,
      JSON.stringify(pending),
    );
    return;
  }

  await AsyncStorage.removeItem(pendingV2RecommendationStorageKey);
});

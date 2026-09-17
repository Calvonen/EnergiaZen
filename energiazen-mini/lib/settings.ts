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
import { supabase } from "./supabase";

// Pure defaults/types/normalization live in ./settingsDefaults so they can
// be imported without AsyncStorage (needed by anything that must also run
// outside React Native, e.g. Deno Edge Functions). Re-exported here
// unchanged so every existing "from ./settings" import keeps working.
export * from "./settingsDefaults";

export const settingsStorageKey = "energiazen:settings";
export const settingsStorageMigrationVersionKey =
  "energiazen:settings:migration-version";

let loadedV2TargetReservePercent: number | null = null;

export function getLoadedV2TargetReservePercent() {
  return loadedV2TargetReservePercent;
}

export function markV2TargetReservePercentSaved(value: number) {
  loadedV2TargetReservePercent = value;
}

function isPersistedReservePercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 5 &&
    value <= 95 &&
    value % 5 === 0
  );
}

async function hydrateAuthoritativeV2Recommendation(
  settings: EnergiaZenSettings,
): Promise<EnergiaZenSettings> {
  try {
    const { data, error } = await supabase
      .from("heating_control_settings")
      .select("v2_target_reserve_percent")
      .eq("id", 1)
      .maybeSingle();

    if (error || !isPersistedReservePercent(data?.v2_target_reserve_percent)) {
      return settings;
    }

    if (data.v2_target_reserve_percent === settings.v2TargetReservePercent) {
      return settings;
    }

    const hydrated = {
      ...settings,
      v2TargetReservePercent: data.v2_target_reserve_percent,
    };

    try {
      await AsyncStorage.setItem(settingsStorageKey, JSON.stringify(hydrated));
    } catch {
      // Keep the authoritative in-memory value even if this device cannot
      // persist the hydration yet. A later successful save/load can do so.
    }

    return hydrated;
  } catch {
    return settings;
  }
}

export async function loadSettings() {
  try {
    const [storedSettings, storedMigrationVersion] = await Promise.all([
      AsyncStorage.getItem(settingsStorageKey),
      AsyncStorage.getItem(settingsStorageMigrationVersionKey),
    ]);

    let normalizedSettings: EnergiaZenSettings;

    if (!storedSettings) {
      normalizedSettings = defaultSettings;
    } else {
      const parsedSettings = JSON.parse(storedSettings);
      const parsedMigrationVersion = Number(storedMigrationVersion);
      const migration = migrateStoredSettings(
        parsedSettings,
        Number.isFinite(parsedMigrationVersion) ? parsedMigrationVersion : null,
      );
      normalizedSettings = normalizeSettings(migration.settings);

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
    }

    const hydratedSettings = await hydrateAuthoritativeV2Recommendation(
      normalizedSettings,
    );
    loadedV2TargetReservePercent = hydratedSettings.v2TargetReservePercent;
    return hydratedSettings;
  } catch {
    loadedV2TargetReservePercent = defaultSettings.v2TargetReservePercent;
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

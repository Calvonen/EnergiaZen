import { defaultSettings, type LegacySettings } from "./settingsDefaults";

export const currentSettingsStorageMigrationVersion = 1;
export const legacyV2PreheatDefaultPercent = 75;

export function migrateStoredSettings(
  settings: LegacySettings,
  previousVersion: number | null,
) {
  const version = Number.isFinite(previousVersion) ? previousVersion as number : 0;
  const shouldMigrateLegacyPreheatDefault =
    version < currentSettingsStorageMigrationVersion &&
    settings.v2TargetReservePercent === legacyV2PreheatDefaultPercent;

  return {
    changed: shouldMigrateLegacyPreheatDefault,
    migrationVersion: currentSettingsStorageMigrationVersion,
    settings: shouldMigrateLegacyPreheatDefault
      ? {
          ...settings,
          v2TargetReservePercent: defaultSettings.v2TargetReservePercent,
        }
      : settings,
  };
}

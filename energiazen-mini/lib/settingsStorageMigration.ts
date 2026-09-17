import type { LegacySettings } from "./settingsDefaults";

export const currentSettingsStorageMigrationVersion = 1;

export function migrateStoredSettings(
  settings: LegacySettings,
  previousVersion: number | null,
) {
  const version = Number.isFinite(previousVersion) ? previousVersion as number : 0;

  // Version 1 intentionally does not rewrite v2TargetReservePercent. A stored
  // 75% value may be either the old default or an explicit user choice, and we
  // have no provenance that can distinguish the two safely. Preserve every
  // existing recommendation and only advance the migration marker.
  return {
    changed: false,
    migrationVersion: Math.max(version, currentSettingsStorageMigrationVersion),
    settings,
  };
}

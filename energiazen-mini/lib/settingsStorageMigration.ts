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

export function mergeSettingsForStorage({
  migrationVersion,
  normalizedSettings,
  rawStoredSettings,
}: {
  migrationVersion: number;
  normalizedSettings: LegacySettings;
  rawStoredSettings: unknown;
}) {
  if (
    migrationVersion <= currentSettingsStorageMigrationVersion ||
    rawStoredSettings === null ||
    typeof rawStoredSettings !== "object" ||
    Array.isArray(rawStoredSettings)
  ) {
    return normalizedSettings;
  }

  // A rolled-back binary knows only its older settings schema. Preserve every
  // unknown field from the future-version payload and overwrite only fields
  // this binary understands. Keeping the future migration marker is then safe:
  // a later upgrade still sees both its fields and its migration provenance.
  return {
    ...(rawStoredSettings as Record<string, unknown>),
    ...normalizedSettings,
  };
}

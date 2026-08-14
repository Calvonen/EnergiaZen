import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runHeatingGainSourceSyncSourceTests() {
  const learningSource = readFileSync(
    join(process.cwd(), "app/heating-learning.tsx"),
    "utf8",
  );
  const settingsSource = readFileSync(
    join(process.cwd(), "app/settings.tsx"),
    "utf8",
  );
  const gainSaveStart = learningSource.indexOf("const handleGainSourceChange");
  const gainSaveEnd = learningSource.indexOf("useEffect(() =>", gainSaveStart);
  const gainSaveSource = learningSource.slice(gainSaveStart, gainSaveEnd);

  assertSource(
    gainSaveSource.includes("persistSettingsDraft({") &&
      gainSaveSource.includes("saveLocal: saveSettings"),
    "heating-learning gain-source save must use the shared local+Supabase settings path",
  );
  assertSource(
    gainSaveSource.includes("...previousSettings") &&
      gainSaveSource.includes("heatingGainSource: nextSource"),
    "the local draft (AsyncStorage) must still carry every other setting unchanged - only the remote write is narrowed",
  );
  // Codex P2 (PR #193): the remote write itself must be narrowed to only
  // heating_gain_source (+ updated_at) - previousSettings can be stale for
  // every OTHER field, and a full upsert would silently revert those on
  // Supabase just because the user toggled gain source here.
  assertSource(
    !gainSaveSource.includes("upsertHeatingControlSettings"),
    "the gain-source save must not use the full-payload upsert helper",
  );
  const saveRemoteStart = gainSaveSource.indexOf("saveRemote: async (settings) => {");
  const saveRemoteEnd = gainSaveSource.indexOf("},", saveRemoteStart);
  assertSource(
    saveRemoteStart !== -1 && saveRemoteEnd > saveRemoteStart,
    "expected to find the gain-source saveRemote callback",
  );
  const saveRemoteSource = gainSaveSource.slice(saveRemoteStart, saveRemoteEnd);
  assertSource(
    saveRemoteSource.includes('.from("heating_control_settings")') &&
      saveRemoteSource.includes(".update({") &&
      saveRemoteSource.includes("heating_gain_source: settings.heatingGainSource") &&
      saveRemoteSource.includes("updated_at: new Date().toISOString()") &&
      saveRemoteSource.includes('.eq("id", 1)'),
    "the remote write must update only heating_gain_source and updated_at on the singleton row",
  );
  // Codex P2 follow-up: PostgREST can report no error while matching zero
  // rows (e.g. id=1 doesn't exist yet) - .select("id") must be chained so
  // the update reports which row(s) it actually matched, and an empty
  // result must be treated as a save failure rather than silently
  // succeeding. This must not become a fallback upsert - see the
  // "must not use the full-payload upsert helper" assertion above.
  assertSource(
    saveRemoteSource.includes('.select("id")'),
    "the update must select the matched row so a zero-row match can be detected",
  );
  assertSource(
    saveRemoteSource.includes("data") &&
      /data\.length\s*===\s*0/.test(saveRemoteSource) &&
      /throw new Error/.test(saveRemoteSource),
    "an update that matches zero rows must be treated as a save failure (thrown), not silently ignored",
  );
  for (const unrelatedField of [
    "heating_need_mode",
    "safety_shower_reserve",
    "target_shower_reserve",
    "full_tank_showers",
    "full_tank_average_temperature",
    "min_tank_temperature",
    "max_tank_temperature",
    "automatic_max_heating_hours",
    "backup_hours",
    "fallback_enabled",
  ]) {
    assertSource(
      !saveRemoteSource.includes(unrelatedField),
      `the gain-source remote write must not reference unrelated field "${unrelatedField}"`,
    );
  }
  assertSource(
    settingsSource.includes("persistSettingsDraft({") &&
      settingsSource.includes("upsertHeatingControlSettings(supabase, nextSettings)"),
    "the main settings screen must keep using the same authoritative settings path",
  );
}

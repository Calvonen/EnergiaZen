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
      gainSaveSource.includes("saveLocal: saveSettings") &&
      gainSaveSource.includes("upsertHeatingControlSettings(supabase, settings)"),
    "heating-learning gain-source save must use the authoritative local+Supabase settings path",
  );
  assertSource(
    gainSaveSource.includes("...previousSettings") &&
      gainSaveSource.includes("heatingGainSource: nextSource"),
    "gain-source save must preserve every other backend-primary setting",
  );
  assertSource(
    settingsSource.includes("persistSettingsDraft({") &&
      settingsSource.includes("upsertHeatingControlSettings(supabase, nextSettings)"),
    "the main settings screen must keep using the same authoritative settings path",
  );
}

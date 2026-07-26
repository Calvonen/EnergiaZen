import fs from "node:fs";
import path from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runSettingsDraftUiSourceTests() {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "app/settings.tsx"),
    "utf8",
  );
  const saveHandlerStart = source.indexOf("const handleSaveSettings");
  const remoteSaveCall = source.indexOf("upsertHeatingControlSettings(");
  const panelRender = source.indexOf("{settingsSavePanel}");
  const modeSelector = source.indexOf(
    '<View style={styles.modeSelector}>',
  );
  const detailedSettings = source.indexOf(
    "{section.rows.map",
    modeSelector,
  );
  const fallbackSection = source.indexOf(
    'title="Varakäyttö"',
    panelRender,
  );
  const profileSection = source.indexOf(
    '<View style={styles.profileCard}>',
    panelRender,
  );

  assertSource(
    source.includes("const [savedSettings, setSavedSettings]") &&
      source.includes("const [draftSettings, setDraftSettings]"),
    "asetussivulla pitaa olla erilliset saved- ja draft-tilat",
  );
  assertSource(
    !source.includes("saveUpdatedSettings") &&
      !source.includes("debounce") &&
      !source.includes("setTimeout("),
    "asetussivulle ei saa jaada autosave- tai debounce-polkua",
  );
  assertSource(
    source.includes("setSavedSettings(storedSettings)") &&
      source.includes("setDraftSettings(storedSettings)") &&
      remoteSaveCall > saveHandlerStart,
    "kaynnistys lataa molemmat tilat mutta Supabasea kutsutaan vain tallennuspainikkeesta",
  );
  assertSource(
    source.includes("Tallentamattomia muutoksia") &&
      source.includes("Tallenna asetukset") &&
      source.includes("Peru muutokset"),
    "luonnostila ja molemmat toimintopainikkeet nakyvat UI:ssa",
  );
  assertSource(
    source.includes("saveLocal: saveSettings") &&
      source.includes("persistSettingsDraft({") &&
      source.includes("setSavedSettings(persistedSettings)"),
    "savedSettings paivitetaan hallitun tallennuspolun jalkeen",
  );
  assertSource(
    modeSelector < panelRender &&
      panelRender < detailedSettings &&
      detailedSettings < fallbackSection &&
      fallbackSection < profileSection &&
      source.match(/\{settingsSavePanel\}/g)?.length === 1,
    "tallennuspaneeli renderoidaan kerran tilavalinnan jalkeen ennen tarkempia asetuksia, varakayttoa ja teknista profiilia",
  );
}

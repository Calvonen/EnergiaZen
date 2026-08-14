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
  const remoteSaveCall = source.lastIndexOf("upsertHeatingControlSettings(");
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
    source.includes("useSettingsScenario()") &&
      source.includes("persistedSettings: savedSettings") &&
      source.includes("draftSettings,"),
    "asetussivu kayttaa sovellustason persisted- ja draft-tiloja",
  );
  assertSource(
    !source.includes("saveUpdatedSettings") &&
      !source.includes("debounce") &&
      !source.includes("setTimeout("),
    "asetussivulle ei saa jaada autosave- tai debounce-polkua",
  );
  assertSource(
    source.includes("commitPersistedSettings(persistedSettings, draftSnapshot)") &&
      source.includes("discardDraftSettings()") &&
      source.includes("persistSettingsDraft({") &&
      remoteSaveCall !== -1 &&
      saveHandlerStart !== -1,
    "Supabasea kutsutaan vain tallennuspainikkeesta ja luonnos palautetaan yhteisen tilan kautta",
  );
  assertSource(
    source.includes("Tallentamattomia muutoksia") &&
      source.includes("Tallenna asetukset") &&
      source.includes("Hylkää muutokset"),
    "luonnostila ja molemmat toimintopainikkeet nakyvat UI:ssa",
  );
  assertSource(
    source.includes("saveLocal: saveSettings") &&
      source.includes("persistSettingsDraft({") &&
      source.includes("commitPersistedSettings(persistedSettings, draftSnapshot)"),
    "persistedSettings paivitetaan hallitun tallennuspolun jalkeen",
  );
  const draftSnapshotTaken = source.indexOf("const draftSnapshot = draftSettings;");
  const persistCallStart = source.indexOf(
    "await persistSettingsDraft({",
    saveHandlerStart,
  );
  assertSource(
    draftSnapshotTaken !== -1 &&
      draftSnapshotTaken > saveHandlerStart &&
      draftSnapshotTaken < persistCallStart &&
      source.includes("commitPersistedSettings(persistedSettings, draftSnapshot)"),
    "tallennuksen alussa otettu draftSnapshot suojaa tallennuksen aikana tehtya uudempaa luonnosmuutosta",
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

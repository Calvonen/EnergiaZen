import type { EnergiaZenSettings } from "./settings";
import { areSettingsEqual, discardSettingsDraft } from "./settingsDraft";

export type SettingsScenarioState = {
  draftSettings: EnergiaZenSettings;
  hasUnsavedChanges: boolean;
  persistedSettings: EnergiaZenSettings;
};

export function createSettingsScenarioState(
  persistedSettings: EnergiaZenSettings,
  draftSettings = persistedSettings,
): SettingsScenarioState {
  const persisted = discardSettingsDraft(persistedSettings);
  const draft = discardSettingsDraft(draftSettings);

  return {
    draftSettings: draft,
    hasUnsavedChanges: !areSettingsEqual(draft, persisted),
    persistedSettings: persisted,
  };
}

export function discardSettingsScenario(
  persistedSettings: EnergiaZenSettings,
): SettingsScenarioState {
  return createSettingsScenarioState(persistedSettings);
}

export function commitSettingsScenario(
  persistedSettings: EnergiaZenSettings,
): SettingsScenarioState {
  return createSettingsScenarioState(persistedSettings);
}

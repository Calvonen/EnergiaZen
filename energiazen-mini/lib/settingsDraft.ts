import type { EditableSettingKey, EnergiaZenSettings } from "./settings";

export type SettingsValidationField =
  | EditableSettingKey
  | "minTankTemperature"
  | "priceDifferenceThresholdCents";

export type SettingsValidationIssue = {
  field: SettingsValidationField;
  message: string;
};

export type SettingsDraftValidation = {
  errors: SettingsValidationIssue[];
  warnings: SettingsValidationIssue[];
};

const numericFields: SettingsValidationField[] = [
  "tankSizeLiters",
  "automaticMaxHeatingHours",
  "fixedHeatingHoursPerDay",
  "priceDifferenceThresholdCents",
  "minTankTemperature",
  "maxTankTemperature",
  "fullTankAverageTemperature",
  "fullTankShowers",
  "targetShowerReserve",
  "safetyShowerReserve",
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function areSettingsEqual(
  first: EnergiaZenSettings,
  second: EnergiaZenSettings,
) {
  return JSON.stringify(first) === JSON.stringify(second);
}

export function updateDraftSetting(
  draftSettings: EnergiaZenSettings,
  key: EditableSettingKey,
  value: number,
) {
  return { ...draftSettings, [key]: value };
}

export function discardSettingsDraft(savedSettings: EnergiaZenSettings) {
  return {
    ...savedSettings,
    backupHours: [...savedSettings.backupHours],
  };
}

export function validateSettingsDraft(
  draftSettings: Partial<EnergiaZenSettings>,
  savedSettings: EnergiaZenSettings,
): SettingsDraftValidation {
  const errors: SettingsValidationIssue[] = [];
  const warnings: SettingsValidationIssue[] = [];

  for (const field of numericFields) {
    if (!isFiniteNumber(draftSettings[field])) {
      errors.push({
        field,
        message: "Arvon pitää olla kelvollinen numero.",
      });
    }
  }

  const fullTankShowers = draftSettings.fullTankShowers;
  const targetShowerReserve = draftSettings.targetShowerReserve;
  const minTankTemperature = draftSettings.minTankTemperature;
  const maxTankTemperature = draftSettings.maxTankTemperature;
  const fullTankAverageTemperature =
    draftSettings.fullTankAverageTemperature;

  if (isFiniteNumber(fullTankShowers) && fullTankShowers <= 0) {
    errors.push({
      field: "fullTankShowers",
      message: "Täyden varaajan suihkumäärän pitää olla yli nolla.",
    });
  }

  if (isFiniteNumber(targetShowerReserve) && targetShowerReserve < 0) {
    errors.push({
      field: "targetShowerReserve",
      message: "Tavoitevaraus ei voi olla negatiivinen.",
    });
  }

  if (
    isFiniteNumber(targetShowerReserve) &&
    isFiniteNumber(fullTankShowers) &&
    targetShowerReserve > fullTankShowers
  ) {
    errors.push({
      field: "targetShowerReserve",
      message: "Tavoitevaraus ei voi ylittää täyden varaajan suihkumäärää.",
    });
  }

  if (
    isFiniteNumber(fullTankAverageTemperature) &&
    isFiniteNumber(minTankTemperature) &&
    fullTankAverageTemperature <= minTankTemperature
  ) {
    errors.push({
      field: "fullTankAverageTemperature",
      message: "Täyden varaajan lämpötilan pitää ylittää minimilämpötila.",
    });
  }

  if (
    isFiniteNumber(maxTankTemperature) &&
    isFiniteNumber(minTankTemperature) &&
    maxTankTemperature <= minTankTemperature
  ) {
    errors.push({
      field: "maxTankTemperature",
      message: "Maksimilämpötilan pitää ylittää minimilämpötila.",
    });
  }

  if (
    isFiniteNumber(fullTankAverageTemperature) &&
    isFiniteNumber(maxTankTemperature) &&
    fullTankAverageTemperature > maxTankTemperature
  ) {
    errors.push({
      field: "fullTankAverageTemperature",
      message: "Täyden varaajan lämpötila ei voi ylittää maksimilämpötilaa.",
    });
  }

  if (
    isFiniteNumber(targetShowerReserve) &&
    isFiniteNumber(fullTankShowers) &&
    fullTankShowers > 0 &&
    targetShowerReserve >= fullTankShowers * 0.9
  ) {
    warnings.push({
      field: "targetShowerReserve",
      message: "Tavoite on lähes täysi varaaja. Lämmitys voi käynnistyä usein.",
    });
  }

  if (isFiniteNumber(targetShowerReserve) && targetShowerReserve <= 1) {
    warnings.push({
      field: "targetShowerReserve",
      message: "Pieni turvaraja voi jättää liian vähän lämmintä vettä.",
    });
  }

  if (isFiniteNumber(minTankTemperature) && minTankTemperature >= 50) {
    warnings.push({
      field: "minTankTemperature",
      message: "Korkea minimilämpötila vähentää halpojen tuntien hyödyntämistä.",
    });
  }

  if (
    isFiniteNumber(fullTankAverageTemperature) &&
    fullTankAverageTemperature >= 70
  ) {
    warnings.push({
      field: "fullTankAverageTemperature",
      message: "Korkea täyden varaajan lämpötila lisää lämpöhäviöitä.",
    });
  }

  if (
    isFiniteNumber(fullTankShowers) &&
    isFiniteNumber(savedSettings.fullTankShowers) &&
    savedSettings.fullTankShowers > 0 &&
    Math.abs(fullTankShowers - savedSettings.fullTankShowers) /
      savedSettings.fullTankShowers >
      0.5
  ) {
    warnings.push({
      field: "fullTankShowers",
      message: "Arvo poikkeaa paljon aiemmasta kalibroinnista.",
    });
  }

  return { errors, warnings };
}

export class SettingsDraftValidationError extends Error {
  readonly validation: SettingsDraftValidation;

  constructor(validation: SettingsDraftValidation) {
    super("Settings draft validation failed");
    this.name = "SettingsDraftValidationError";
    this.validation = validation;
  }
}

export class SettingsDraftSaveError extends Error {
  readonly rollbackSucceeded: boolean;

  constructor(rollbackSucceeded: boolean) {
    super("Remote settings save failed");
    this.name = "SettingsDraftSaveError";
    this.rollbackSucceeded = rollbackSucceeded;
  }
}

export class SettingsDraftLocalSaveError extends Error {
  constructor() {
    super("Local settings save failed");
    this.name = "SettingsDraftLocalSaveError";
  }
}

export async function persistSettingsDraft({
  draftSettings,
  savedSettings,
  saveLocal,
  saveRemote,
}: {
  draftSettings: EnergiaZenSettings;
  savedSettings: EnergiaZenSettings;
  saveLocal: (settings: EnergiaZenSettings) => Promise<void>;
  saveRemote: (settings: EnergiaZenSettings) => Promise<void>;
}) {
  const validation = validateSettingsDraft(draftSettings, savedSettings);

  if (validation.errors.length > 0) {
    throw new SettingsDraftValidationError(validation);
  }

  try {
    await saveLocal(draftSettings);
  } catch {
    throw new SettingsDraftLocalSaveError();
  }

  try {
    await saveRemote(draftSettings);
  } catch {
    try {
      await saveLocal(savedSettings);
    } catch {
      throw new SettingsDraftSaveError(false);
    }

    throw new SettingsDraftSaveError(true);
  }

  return draftSettings;
}

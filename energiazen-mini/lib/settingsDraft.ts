import type { EditableSettingKey, EnergiaZenSettings } from "./settingsDefaults";
import {
  maxV2SafetyReservePercent,
  maxV2TargetReservePercent,
  minV2TargetReservePercent,
} from "./energyModelV2/energyReservePercent";
import { setLoadedV2TargetReservePercent } from "./v2RecommendationSaveBaseline";

export type SettingsValidationField =
  | EditableSettingKey
  | "backupHours"
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
  "priceToleranceCents",
  "minTankTemperature",
  "maxTankTemperature",
  "v2TargetReservePercent",
  "v2SafetyReservePercent",
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

  const v2TargetReservePercent = draftSettings.v2TargetReservePercent;
  const v2SafetyReservePercent = draftSettings.v2SafetyReservePercent;
  const minTankTemperature = draftSettings.minTankTemperature;
  const maxTankTemperature = draftSettings.maxTankTemperature;

  if (
    isFiniteNumber(v2TargetReservePercent) &&
    (v2TargetReservePercent < minV2TargetReservePercent ||
      v2TargetReservePercent > maxV2TargetReservePercent)
  ) {
    errors.push({
      field: "v2TargetReservePercent",
      message: `Esilämmityssuosituksen pitää olla välillä ${minV2TargetReservePercent}–${maxV2TargetReservePercent} %.`,
    });
  }

  if (
    isFiniteNumber(v2SafetyReservePercent) &&
    (v2SafetyReservePercent < 0 ||
      v2SafetyReservePercent > maxV2SafetyReservePercent)
  ) {
    errors.push({
      field: "v2SafetyReservePercent",
      message: `V2-turvarajan pitää olla välillä 0–${maxV2SafetyReservePercent} %.`,
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

  for (const field of [
    "automaticMaxHeatingHours",
    "fixedHeatingHoursPerDay",
  ] as const) {
    const value = draftSettings[field];

    if (
      isFiniteNumber(value) &&
      (!Number.isInteger(value) || value < 1 || value > 6)
    ) {
      errors.push({
        field,
        message: "Lämmitystuntien määrän pitää olla kokonaisluku välillä 1–6.",
      });
    }
  }

  if (
    !Array.isArray(draftSettings.backupHours) ||
    draftSettings.backupHours.some(
      (hour) => !Number.isInteger(hour) || hour < 0 || hour > 23,
    )
  ) {
    errors.push({
      field: "backupHours",
      message: "Varatuntien pitää olla kokonaislukuja välillä 0–23.",
    });
  } else if (new Set(draftSettings.backupHours).size !== draftSettings.backupHours.length) {
    errors.push({
      field: "backupHours",
      message: "Varatunnit eivät saa sisältää duplikaatteja.",
    });
  }

  if (
    isFiniteNumber(v2SafetyReservePercent) &&
    isFiniteNumber(v2TargetReservePercent) &&
    Math.abs(v2TargetReservePercent - v2SafetyReservePercent) <= 10
  ) {
    warnings.push({
      field: "v2SafetyReservePercent",
      message: "V2-turvaraja on hyvin lähellä esilämmityssuositusta.",
    });
  }

  if (
    isFiniteNumber(draftSettings.automaticMaxHeatingHours) &&
    draftSettings.automaticMaxHeatingHours <= 1
  ) {
    warnings.push({
      field: "automaticMaxHeatingHours",
      message: "Pieni enimmäistuntien määrä voi estää tavoitevarauksen saavuttamisen.",
    });
  }

  if (isFiniteNumber(minTankTemperature) && minTankTemperature >= 50) {
    warnings.push({
      field: "minTankTemperature",
      message: "Korkea minimilämpötila vähentää halpojen tuntien hyödyntämistä.",
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

  // Preserve whether the recommendation was actually edited in this draft.
  // The remote writer uses this loaded baseline to decide whether it may
  // merge the authoritative backend recommendation before a full-row upsert.
  setLoadedV2TargetReservePercent(savedSettings.v2TargetReservePercent);

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

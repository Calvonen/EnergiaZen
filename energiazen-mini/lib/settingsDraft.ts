import type { EditableSettingKey, EnergiaZenSettings } from "./settings";

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
  "fullTankAverageTemperature",
  "fullTankShowers",
  "targetShowerReserve",
  "safetyShowerReserve",
  "v2TargetReservePercent",
  "v2SafetyReservePercent",
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function areSettingsEqual(first: EnergiaZenSettings, second: EnergiaZenSettings) {
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
  return { ...savedSettings, backupHours: [...savedSettings.backupHours] };
}

export function validateSettingsDraft(
  draftSettings: Partial<EnergiaZenSettings>,
  savedSettings: EnergiaZenSettings,
): SettingsDraftValidation {
  const errors: SettingsValidationIssue[] = [];
  const warnings: SettingsValidationIssue[] = [];

  for (const field of numericFields) {
    if (!isFiniteNumber(draftSettings[field])) {
      errors.push({ field, message: "Arvon pitää olla kelvollinen numero." });
    }
  }

  const fullTankShowers = draftSettings.fullTankShowers;
  const targetShowerReserve = draftSettings.targetShowerReserve;
  const safetyShowerReserve = draftSettings.safetyShowerReserve;
  const v2TargetReservePercent = draftSettings.v2TargetReservePercent;
  const v2SafetyReservePercent = draftSettings.v2SafetyReservePercent;
  const minTankTemperature = draftSettings.minTankTemperature;
  const maxTankTemperature = draftSettings.maxTankTemperature;
  const fullTankAverageTemperature = draftSettings.fullTankAverageTemperature;

  if (isFiniteNumber(fullTankShowers) && fullTankShowers <= 0) errors.push({ field: "fullTankShowers", message: "Täyden varaajan suihkumäärän pitää olla yli nolla." });
  if (isFiniteNumber(targetShowerReserve) && targetShowerReserve < 0) errors.push({ field: "targetShowerReserve", message: "Tavoitevaraus ei voi olla negatiivinen." });
  if (isFiniteNumber(safetyShowerReserve) && safetyShowerReserve < 0) errors.push({ field: "safetyShowerReserve", message: "Turvaraja ei voi olla negatiivinen." });
  if (isFiniteNumber(safetyShowerReserve) && isFiniteNumber(targetShowerReserve) && safetyShowerReserve > targetShowerReserve) errors.push({ field: "safetyShowerReserve", message: "Turvaraja ei voi ylittää tavoitevarausta." });
  if (isFiniteNumber(targetShowerReserve) && isFiniteNumber(fullTankShowers) && targetShowerReserve > fullTankShowers) errors.push({ field: "targetShowerReserve", message: "Tavoitevaraus ei voi ylittää täyden varaajan suihkumäärää." });

  if (isFiniteNumber(v2TargetReservePercent) && (v2TargetReservePercent < 5 || v2TargetReservePercent > 100)) errors.push({ field: "v2TargetReservePercent", message: "V2-tavoitevarausten pitää olla välillä 5–100 %." });
  if (isFiniteNumber(v2SafetyReservePercent) && (v2SafetyReservePercent < 0 || v2SafetyReservePercent > 95)) errors.push({ field: "v2SafetyReservePercent", message: "V2-turvarajan pitää olla välillä 0–95 %." });
  if (isFiniteNumber(v2SafetyReservePercent) && isFiniteNumber(v2TargetReservePercent) && v2SafetyReservePercent > v2TargetReservePercent) errors.push({ field: "v2SafetyReservePercent", message: "V2-turvaraja ei voi ylittää tavoitevarausta." });

  if (isFiniteNumber(fullTankAverageTemperature) && isFiniteNumber(minTankTemperature) && fullTankAverageTemperature <= minTankTemperature) errors.push({ field: "fullTankAverageTemperature", message: "Täyden varaajan lämpötilan pitää ylittää minimilämpötila." });
  if (isFiniteNumber(fullTankAverageTemperature) && fullTankAverageTemperature <= 42) errors.push({ field: "fullTankAverageTemperature", message: "Täyden varaajan vertailulämpötilan pitää olla yli 42 °C." });
  if (isFiniteNumber(maxTankTemperature) && isFiniteNumber(minTankTemperature) && maxTankTemperature <= minTankTemperature) errors.push({ field: "maxTankTemperature", message: "Maksimilämpötilan pitää ylittää minimilämpötila." });
  if (isFiniteNumber(fullTankAverageTemperature) && isFiniteNumber(maxTankTemperature) && fullTankAverageTemperature > maxTankTemperature) errors.push({ field: "fullTankAverageTemperature", message: "Täyden varaajan lämpötila ei voi ylittää maksimilämpötilaa." });

  for (const field of ["automaticMaxHeatingHours", "fixedHeatingHoursPerDay"] as const) {
    const value = draftSettings[field];
    if (isFiniteNumber(value) && (!Number.isInteger(value) || value < 1 || value > 6)) errors.push({ field, message: "Lämmitystuntien määrän pitää olla kokonaisluku välillä 1–6." });
  }

  if (!Array.isArray(draftSettings.backupHours) || draftSettings.backupHours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
    errors.push({ field: "backupHours", message: "Varatuntien pitää olla kokonaislukuja välillä 0–23." });
  } else if (new Set(draftSettings.backupHours).size !== draftSettings.backupHours.length) {
    errors.push({ field: "backupHours", message: "Varatunnit eivät saa sisältää duplikaatteja." });
  }

  if (isFiniteNumber(targetShowerReserve) && isFiniteNumber(fullTankShowers) && fullTankShowers > 0 && targetShowerReserve >= fullTankShowers * 0.9) warnings.push({ field: "targetShowerReserve", message: "Tavoite on lähes täysi varaaja. Lämmitys voi käynnistyä usein." });
  if (isFiniteNumber(v2TargetReservePercent) && v2TargetReservePercent >= 90) warnings.push({ field: "v2TargetReservePercent", message: "Korkea V2-tavoite voi lisätä lämmityskertoja." });
  if (isFiniteNumber(v2SafetyReservePercent) && v2SafetyReservePercent <= 10) warnings.push({ field: "v2SafetyReservePercent", message: "Pieni V2-turvaraja jättää vähän energiapuskuria." });

  if (savedSettings.heatingNeedMode !== draftSettings.heatingNeedMode) warnings.push({ field: "automaticMaxHeatingHours", message: "Lämmitystilan vaihto muuttaa käytössä olevia optimointiasetuksia." });

  return { errors, warnings };
}

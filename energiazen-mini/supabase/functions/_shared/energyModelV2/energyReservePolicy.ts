export type EnergyReserveThresholds = {
  safetyEnergyKwh: number;
  targetEnergyKwh: number;
};

export type EnergyReserveCalibration = {
  heaterPowerKw: number;
  marginKwh: number;
  p95WaterDrawKwh: number;
  sampleCount: number;
  targetHeatingHours: number;
  thresholdStepKwh: number;
};

export type EnergyReserveState = {
  remainingEnergyKwh: number;
  uncertaintyKwh: number;
  quality: "valid" | "degraded" | "invalid";
};

export const defaultEnergyReserveCalibration: EnergyReserveCalibration = {
  // Production water-draw snapshot 2026-09-14: 43 reliable events,
  // p95 = 2.0510027 kWh. This deliberately does not use shower counts.
  heaterPowerKw: 3,
  marginKwh: 0.5,
  p95WaterDrawKwh: 2.0510027,
  sampleCount: 43,
  targetHeatingHours: 1,
  thresholdStepKwh: 0.5,
};

export function calibrateEnergyReserveThresholds(
  calibration: EnergyReserveCalibration,
): EnergyReserveThresholds {
  const step = positive(calibration.thresholdStepKwh, 0.5);
  const safetyEnergyKwh = roundUpToStep(
    nonNegative(calibration.p95WaterDrawKwh) + nonNegative(calibration.marginKwh),
    step,
  );
  const recoveryEnergyKwh =
    nonNegative(calibration.heaterPowerKw) * nonNegative(calibration.targetHeatingHours);

  return {
    safetyEnergyKwh,
    targetEnergyKwh: roundUpToStep(safetyEnergyKwh + recoveryEnergyKwh, step),
  };
}

export const defaultEnergyReserveThresholds = calibrateEnergyReserveThresholds(
  defaultEnergyReserveCalibration,
);

export type EnergyReserveBand =
  | "invalid"
  | "below_safety"
  | "recovery"
  | "target_met";

export type EnergyReserveDecision = {
  band: EnergyReserveBand;
  conservativeEnergyKwh: number;
  needsEnergyRecovery: boolean | null;
  safetySatisfied: boolean | null;
  targetSatisfied: boolean | null;
  thresholds: EnergyReserveThresholds;
};

/**
 * Evaluates V2 reserve state only in physical energy units.
 * Invalid authoritative state fails closed and produces no control decision.
 */
export function evaluateEnergyReserve(
  state: EnergyReserveState,
  thresholds: EnergyReserveThresholds = defaultEnergyReserveThresholds,
): EnergyReserveDecision {
  const normalizedThresholds = normalizeThresholds(thresholds);
  const conservativeEnergyKwh = Math.max(
    nonNegative(state.remainingEnergyKwh) - nonNegative(state.uncertaintyKwh),
    0,
  );

  if (state.quality === "invalid") {
    return {
      band: "invalid",
      conservativeEnergyKwh,
      needsEnergyRecovery: null,
      safetySatisfied: null,
      targetSatisfied: null,
      thresholds: normalizedThresholds,
    };
  }

  if (conservativeEnergyKwh < normalizedThresholds.safetyEnergyKwh) {
    return {
      band: "below_safety",
      conservativeEnergyKwh,
      needsEnergyRecovery: true,
      safetySatisfied: false,
      targetSatisfied: false,
      thresholds: normalizedThresholds,
    };
  }

  if (conservativeEnergyKwh < normalizedThresholds.targetEnergyKwh) {
    return {
      band: "recovery",
      conservativeEnergyKwh,
      needsEnergyRecovery: true,
      safetySatisfied: true,
      targetSatisfied: false,
      thresholds: normalizedThresholds,
    };
  }

  return {
    band: "target_met",
    conservativeEnergyKwh,
    needsEnergyRecovery: false,
    safetySatisfied: true,
    targetSatisfied: true,
    thresholds: normalizedThresholds,
  };
}

function normalizeThresholds(thresholds: EnergyReserveThresholds): EnergyReserveThresholds {
  const safetyEnergyKwh = nonNegative(thresholds.safetyEnergyKwh);
  return {
    safetyEnergyKwh,
    targetEnergyKwh: Math.max(nonNegative(thresholds.targetEnergyKwh), safetyEnergyKwh),
  };
}

function roundUpToStep(value: number, step: number) {
  return Math.ceil(value / step - 1e-12) * step;
}

function nonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function positive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

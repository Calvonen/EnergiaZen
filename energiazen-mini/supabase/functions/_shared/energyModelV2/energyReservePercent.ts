export type EnergyReservePercentSettings = {
  safetyPercent: number;
  targetPercent: number;
};

export type EnergyReserveCapacityInput = {
  inletTemperatureC: number;
  maxTankTemperatureC: number;
  fullTankAverageTemperatureC?: number | null;
  tankVolumeLiters: number;
  specificHeatKwhPerKgC?: number;
};

// v2TargetReservePercent is retained as the persisted/backend field name for
// compatibility. It is the planner's terminal reserve target; safetyPercent is
// the hard floor and must not exceed the target.
export const recommendedV2PreheatPercent = 90;
export const minV2TargetReservePercent = 60;
export const maxV2TargetReservePercent = 95;
export const minV2SafetyReservePercent = 0;
export const maxV2SafetyReservePercent = 95;
export const defaultV2ReservePercents: EnergyReservePercentSettings = {
  safetyPercent: 30,
  targetPercent: recommendedV2PreheatPercent,
};

export const defaultWaterSpecificHeatKwhPerKgC = 0.001163;

export function calculateV2EnergyCapacityKwh({
  inletTemperatureC,
  maxTankTemperatureC,
  fullTankAverageTemperatureC,
  tankVolumeLiters,
  specificHeatKwhPerKgC = defaultWaterSpecificHeatKwhPerKgC,
}: EnergyReserveCapacityInput) {
  if (
    !Number.isFinite(inletTemperatureC) ||
    !Number.isFinite(maxTankTemperatureC) ||
    !Number.isFinite(tankVolumeLiters) ||
    !Number.isFinite(specificHeatKwhPerKgC) ||
    maxTankTemperatureC <= inletTemperatureC ||
    tankVolumeLiters <= 0 ||
    specificHeatKwhPerKgC <= 0
  ) {
    return null;
  }

  const calibratedFullTemperatureC =
    typeof fullTankAverageTemperatureC === "number" &&
      Number.isFinite(fullTankAverageTemperatureC) &&
      fullTankAverageTemperatureC > inletTemperatureC &&
      fullTankAverageTemperatureC <= maxTankTemperatureC
      ? fullTankAverageTemperatureC
      : maxTankTemperatureC;

  return round(
    tankVolumeLiters *
      specificHeatKwhPerKgC *
      (calibratedFullTemperatureC - inletTemperatureC),
  );
}

export function reservePercentToKwh(percent: number, capacityKwh: number) {
  if (!Number.isFinite(percent) || !Number.isFinite(capacityKwh) || capacityKwh < 0) {
    return null;
  }
  return round(capacityKwh * clamp(percent, 0, 100) / 100);
}

export function reserveKwhToPercent(kwh: number, capacityKwh: number) {
  if (!Number.isFinite(kwh) || !Number.isFinite(capacityKwh) || capacityKwh <= 0) {
    return null;
  }
  // 100% is the calibrated practical-full reference, not a hard physical
  // ceiling. Values above it are meaningful and indicate that recalibration
  // may be appropriate.
  return round(Math.max(kwh / capacityKwh * 100, 0));
}

export function normalizeV2ReservePercents({
  safetyPercent,
  targetPercent,
}: Partial<EnergyReservePercentSettings>): EnergyReservePercentSettings {
  const target = clampAndRoundPercent(
    targetPercent,
    defaultV2ReservePercents.targetPercent,
    minV2TargetReservePercent,
    maxV2TargetReservePercent,
  );
  const safety = clampAndRoundPercent(
    safetyPercent,
    defaultV2ReservePercents.safetyPercent,
    minV2SafetyReservePercent,
    maxV2SafetyReservePercent,
  );
  return {
    safetyPercent: safety,
    targetPercent: Math.max(target, safety),
  };
}

function clampAndRoundPercent(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const normalized = Number.isFinite(value) ? value as number : fallback;
  return Math.round(clamp(normalized, min, max) / 5) * 5;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

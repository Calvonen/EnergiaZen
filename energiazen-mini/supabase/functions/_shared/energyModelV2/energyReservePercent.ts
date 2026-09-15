export type EnergyReservePercentSettings = {
  safetyPercent: number;
  targetPercent: number;
};

export type EnergyReserveCapacityInput = {
  inletTemperatureC: number;
  maxTankTemperatureC: number;
  tankVolumeLiters: number;
  specificHeatKwhPerKgC?: number;
};

export const defaultV2ReservePercents: EnergyReservePercentSettings = {
  safetyPercent: 30,
  targetPercent: 75,
};

export const defaultWaterSpecificHeatKwhPerKgC = 0.001163;

export function calculateV2EnergyCapacityKwh({
  inletTemperatureC,
  maxTankTemperatureC,
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

  return round(
    tankVolumeLiters *
      specificHeatKwhPerKgC *
      (maxTankTemperatureC - inletTemperatureC),
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
  return round(clamp(kwh / capacityKwh * 100, 0, 100));
}

export function normalizeV2ReservePercents({
  safetyPercent,
  targetPercent,
}: Partial<EnergyReservePercentSettings>): EnergyReservePercentSettings {
  const target = clampAndRoundPercent(targetPercent, defaultV2ReservePercents.targetPercent);
  const safety = Math.min(
    clampAndRoundPercent(safetyPercent, defaultV2ReservePercents.safetyPercent),
    target,
  );
  return { safetyPercent: safety, targetPercent: target };
}

function clampAndRoundPercent(value: number | undefined, fallback: number) {
  const normalized = Number.isFinite(value) ? value as number : fallback;
  return Math.round(clamp(normalized, 0, 100) / 5) * 5;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

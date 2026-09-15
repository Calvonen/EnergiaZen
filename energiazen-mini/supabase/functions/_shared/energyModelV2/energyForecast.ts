import {
  evaluateEnergyReserve,
  type EnergyReserveBand,
  type EnergyReserveThresholds,
  defaultEnergyReserveThresholds,
} from "./energyReservePolicy.ts";

export type EnergyForecastSegment = {
  acceptedRemovalKwh?: number;
  additionalUncertaintyKwh?: number;
  heatingSelected: boolean;
  id: string;
  modeledHeatLossKwh: number;
  segmentHours: number;
  startDate: string;
};

export type EnergyForecastPoint = {
  acceptedRemovalKwh: number;
  bandAfter: EnergyReserveBand;
  conservativeEnergyAfterKwh: number;
  deliveredHeatingEnergyKwh: number;
  heatingSelected: boolean;
  id: string;
  modeledHeatLossKwh: number;
  remainingEnergyAfterKwh: number;
  remainingEnergyBeforeKwh: number;
  segmentHours: number;
  startDate: string;
  uncertaintyAfterKwh: number;
};

export type EnergyForecastResult = {
  finalConservativeEnergyKwh: number;
  finalRemainingEnergyKwh: number;
  firstSafetyViolationAt: string | null;
  firstTargetMissAt: string | null;
  minimumConservativeEnergyKwh: number;
  points: EnergyForecastPoint[];
  thresholds: EnergyReserveThresholds;
};

export function forecastEnergyHorizon({
  energyCapacityKwh,
  heaterPowerKw,
  initialRemainingEnergyKwh,
  initialUncertaintyKwh,
  segments,
  thresholds = defaultEnergyReserveThresholds,
}: {
  energyCapacityKwh?: number;
  heaterPowerKw: number;
  initialRemainingEnergyKwh: number;
  initialUncertaintyKwh: number;
  segments: EnergyForecastSegment[];
  thresholds?: EnergyReserveThresholds;
}): EnergyForecastResult {
  const physicalCapacityKwh = positiveOrInfinity(energyCapacityKwh);
  let remainingEnergyKwh = Math.min(nonNegative(initialRemainingEnergyKwh), physicalCapacityKwh);
  let uncertaintyKwh = nonNegative(initialUncertaintyKwh);
  let minimumConservativeEnergyKwh = Math.max(remainingEnergyKwh - uncertaintyKwh, 0);
  let firstSafetyViolationAt: string | null = null;
  let firstTargetMissAt: string | null = null;

  const points = segments.map((segment): EnergyForecastPoint => {
    const segmentHours = clamp(segment.segmentHours, 0, 1);
    const deliveredHeatingEnergyKwh = segment.heatingSelected
      ? nonNegative(heaterPowerKw) * segmentHours
      : 0;
    const modeledHeatLossKwh = nonNegative(segment.modeledHeatLossKwh);
    const acceptedRemovalKwh = nonNegative(segment.acceptedRemovalKwh ?? 0);
    const remainingEnergyBeforeKwh = remainingEnergyKwh;

    remainingEnergyKwh = clamp(
      remainingEnergyKwh + deliveredHeatingEnergyKwh - modeledHeatLossKwh - acceptedRemovalKwh,
      0,
      physicalCapacityKwh,
    );
    uncertaintyKwh += nonNegative(segment.additionalUncertaintyKwh ?? 0);

    const reserve = evaluateEnergyReserve(
      {
        quality: "valid",
        remainingEnergyKwh,
        uncertaintyKwh,
      },
      thresholds,
    );

    minimumConservativeEnergyKwh = Math.min(
      minimumConservativeEnergyKwh,
      reserve.conservativeEnergyKwh,
    );
    if (!reserve.safetySatisfied && firstSafetyViolationAt === null) {
      firstSafetyViolationAt = segment.startDate;
    }
    if (!reserve.targetSatisfied && firstTargetMissAt === null) {
      firstTargetMissAt = segment.startDate;
    }

    return {
      acceptedRemovalKwh: round(acceptedRemovalKwh),
      bandAfter: reserve.band,
      conservativeEnergyAfterKwh: round(reserve.conservativeEnergyKwh),
      deliveredHeatingEnergyKwh: round(deliveredHeatingEnergyKwh),
      heatingSelected: segment.heatingSelected,
      id: segment.id,
      modeledHeatLossKwh: round(modeledHeatLossKwh),
      remainingEnergyAfterKwh: round(remainingEnergyKwh),
      remainingEnergyBeforeKwh: round(remainingEnergyBeforeKwh),
      segmentHours: round(segmentHours),
      startDate: segment.startDate,
      uncertaintyAfterKwh: round(uncertaintyKwh),
    };
  });

  const finalReserve = evaluateEnergyReserve(
    {
      quality: "valid",
      remainingEnergyKwh,
      uncertaintyKwh,
    },
    thresholds,
  );

  return {
    finalConservativeEnergyKwh: round(finalReserve.conservativeEnergyKwh),
    finalRemainingEnergyKwh: round(remainingEnergyKwh),
    firstSafetyViolationAt,
    firstTargetMissAt,
    minimumConservativeEnergyKwh: round(minimumConservativeEnergyKwh),
    points,
    thresholds: finalReserve.thresholds,
  };
}

function nonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function positiveOrInfinity(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : Number.POSITIVE_INFINITY;
}

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

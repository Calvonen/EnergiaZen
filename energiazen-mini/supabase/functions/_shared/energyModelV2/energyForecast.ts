import {
  evaluateEnergyReserve,
  type EnergyReserveBand,
  type EnergyReserveThresholds,
  defaultEnergyReserveThresholds,
} from "./energyReservePolicy.ts";

export type EnergyForecastSegment = {
  acceptedRemovalKwh?: number;
  frontLoadedDemandKwh?: number;
  additionalUncertaintyKwh?: number;
  heatingSelected: boolean;
  id: string;
  modeledHeatLossKwh: number;
  segmentHours: number;
  startDate: string;
};

export type EnergyForecastPoint = {
  acceptedRemovalKwh: number;
  frontLoadedDemandKwh: number;
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
  const initialEnergyKwh = nonNegative(initialRemainingEnergyKwh);
  const initialConservativeEnergyKwh = Math.max(
    initialEnergyKwh - nonNegative(initialUncertaintyKwh),
    0,
  );
  let remainingEnergyKwh = Math.min(initialEnergyKwh, physicalCapacityKwh);
  // If the nominal ledger exceeds physical capacity, clip its uncertainty by
  // the same overflow. This preserves the already-computed conservative lower
  // bound instead of effectively subtracting delivery uncertainty twice.
  let uncertaintyKwh = Math.max(
    remainingEnergyKwh - Math.min(initialConservativeEnergyKwh, physicalCapacityKwh),
    0,
  );
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
    const frontLoadedDemandKwh = nonNegative(segment.frontLoadedDemandKwh ?? 0);
    const remainingEnergyBeforeKwh = remainingEnergyKwh;

    // Learned hourly demand may contain discrete water draws. Apply that demand
    // before any same-segment heater credit and evaluate the hard reserve at
    // this intermediate point so later heat cannot hide a temporary violation.
    if (frontLoadedDemandKwh > 0) {
      remainingEnergyKwh = clamp(
        remainingEnergyKwh - frontLoadedDemandKwh,
        0,
        physicalCapacityKwh,
      );
      const preHeatingReserve = evaluateEnergyReserve(
        {
          quality: "valid",
          remainingEnergyKwh,
          uncertaintyKwh,
        },
        thresholds,
      );
      minimumConservativeEnergyKwh = Math.min(
        minimumConservativeEnergyKwh,
        preHeatingReserve.conservativeEnergyKwh,
      );
      if (!preHeatingReserve.safetySatisfied && firstSafetyViolationAt === null) {
        firstSafetyViolationAt = segment.startDate;
      }
      if (!preHeatingReserve.targetSatisfied && firstTargetMissAt === null) {
        firstTargetMissAt = segment.startDate;
      }
    }

    const energyDeltaKwh =
      deliveredHeatingEnergyKwh - modeledHeatLossKwh - acceptedRemovalKwh;
    const conservativeEnergyBeforeKwh = Math.max(
      remainingEnergyKwh - uncertaintyKwh,
      0,
    );
    const conservativeEnergyAfterKwh = clamp(
      conservativeEnergyBeforeKwh +
        energyDeltaKwh -
        nonNegative(segment.additionalUncertaintyKwh ?? 0),
      0,
      physicalCapacityKwh,
    );
    remainingEnergyKwh = clamp(
      remainingEnergyKwh + energyDeltaKwh,
      0,
      physicalCapacityKwh,
    );
    // Saturation clips the nominal and conservative endpoints independently.
    // Deriving uncertainty from those bounded endpoints prevents heater energy
    // above physical capacity from being counted as uncertainty a second time.
    uncertaintyKwh = Math.max(
      remainingEnergyKwh - conservativeEnergyAfterKwh,
      0,
    );

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
      frontLoadedDemandKwh: round(frontLoadedDemandKwh),
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

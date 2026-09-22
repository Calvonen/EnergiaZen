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
  // The calibrated full level is a heater-credit ceiling, not a hard clamp on
  // measured/stored energy. A tank may legitimately sit above its calibration
  // reference; keep that excess visible so >100% can signal recalibration.
  let remainingEnergyKwh = initialEnergyKwh;
  let uncertaintyKwh = Math.max(
    remainingEnergyKwh - initialConservativeEnergyKwh,
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
      remainingEnergyKwh = Math.max(
        remainingEnergyKwh - frontLoadedDemandKwh,
        0,
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

    const energyAfterLossesKwh = Math.max(
      remainingEnergyKwh - modeledHeatLossKwh - acceptedRemovalKwh,
      0,
    );
    const conservativeEnergyBeforeKwh = Math.max(
      remainingEnergyKwh - uncertaintyKwh,
      0,
    );
    const conservativeEnergyAfterLossesKwh = Math.max(
      conservativeEnergyBeforeKwh - modeledHeatLossKwh - acceptedRemovalKwh,
      0,
    );
    // The calibrated full level limits real heater headroom. Uncertainty is
    // not empty tank volume: heater credit may first close the conservative
    // gap, but it must never raise the nominal physical ledger above the
    // calibrated-full reference.
    const physicalHeadroomKwh = Number.isFinite(physicalCapacityKwh)
      ? Math.max(physicalCapacityKwh - energyAfterLossesKwh, 0)
      : deliveredHeatingEnergyKwh;
    const uncertaintyHeadroomKwh = Math.max(
      energyAfterLossesKwh - conservativeEnergyAfterLossesKwh,
      0,
    );
    const acceptedHeatingEnergyKwh = Math.min(
      deliveredHeatingEnergyKwh,
      physicalHeadroomKwh + uncertaintyHeadroomKwh,
    );
    const nominalHeatingEnergyKwh = Math.min(
      acceptedHeatingEnergyKwh,
      physicalHeadroomKwh,
    );
    const conservativeEnergyAfterKwh = Math.max(
      conservativeEnergyAfterLossesKwh +
        acceptedHeatingEnergyKwh -
        nonNegative(segment.additionalUncertaintyKwh ?? 0),
      0,
    );
    remainingEnergyKwh = energyAfterLossesKwh + nominalHeatingEnergyKwh;
    // Calibration is only a ceiling for new nominal heater credit. Existing
    // energy above the reference remains intact until losses/demand consume it.
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
      deliveredHeatingEnergyKwh: round(acceptedHeatingEnergyKwh),
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

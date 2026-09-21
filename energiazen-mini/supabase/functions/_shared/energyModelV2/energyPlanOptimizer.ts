import {
  forecastEnergyHorizon,
  type EnergyForecastResult,
  type EnergyForecastSegment,
} from "./energyForecast.ts";
import type { EnergyReserveThresholds } from "./energyReservePolicy.ts";
import { calculateBilledElectricityPriceCentsPerKwh } from "../heatingTariff.ts";

export type EnergyPlanCandidateSegment = Omit<EnergyForecastSegment, "heatingSelected"> & {
  priceCentsPerKwh: number;
};

export type EnergyPlanOptimizationResult = {
  candidateCount: number;
  evaluatedCombinationCount: number;
  forecast: EnergyForecastResult;
  selectedHeatingEnergyKwh: number;
  selectedHeatingHourIds: string[];
  totalCostCents: number;
  valid: boolean;
  violationReason: string | null;
};

export function optimizeEnergyPlan({
  energyCapacityKwh,
  forbiddenHeatingHourIds = [],
  heaterPowerKw,
  initialRemainingEnergyKwh,
  initialUncertaintyKwh,
  maxHeatingHours,
  requiredHeatingHourIds = [],
  segments,
  thresholds,
}: {
  energyCapacityKwh?: number;
  forbiddenHeatingHourIds?: string[];
  heaterPowerKw: number;
  initialRemainingEnergyKwh: number;
  initialUncertaintyKwh: number;
  maxHeatingHours: number;
  requiredHeatingHourIds?: string[];
  segments: EnergyPlanCandidateSegment[];
  thresholds?: EnergyReserveThresholds;
}): EnergyPlanOptimizationResult {
  const ordered = [...segments].sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
  const forbidden = new Set(forbiddenHeatingHourIds);
  const required = new Set(requiredHeatingHourIds);
  const byId = new Map(ordered.map((segment) => [segment.id, segment]));
  const maxSelected = Math.max(0, Math.floor(maxHeatingHours));

  if ([...required].some((id) => forbidden.has(id))) {
    return invalidResult("required_hour_is_forbidden", ordered, heaterPowerKw, initialRemainingEnergyKwh, initialUncertaintyKwh, thresholds, energyCapacityKwh);
  }
  if ([...required].some((id) => !byId.has(id))) {
    return invalidResult("required_hour_missing", ordered, heaterPowerKw, initialRemainingEnergyKwh, initialUncertaintyKwh, thresholds, energyCapacityKwh);
  }
  if (required.size > maxSelected) {
    return invalidResult("required_hours_exceed_max", ordered, heaterPowerKw, initialRemainingEnergyKwh, initialUncertaintyKwh, thresholds, energyCapacityKwh);
  }

  const optionalIds = ordered
    .map((segment) => segment.id)
    .filter((id) => !required.has(id) && !forbidden.has(id));

  let evaluatedCombinationCount = 0;
  let bestValid: EvaluatedPlan | null = null;
  let bestFallback: EvaluatedPlan | null = null;
  const maximumOptionalSelections = Math.max(0, maxSelected - required.size);

  for (let optionalCount = 0; optionalCount <= maximumOptionalSelections; optionalCount += 1) {
    for (const extraIds of combinations(optionalIds, optionalCount)) {
      const selected = new Set([...required, ...extraIds]);
      const evaluated = evaluateSelection({
        energyCapacityKwh,
        heaterPowerKw,
        initialRemainingEnergyKwh,
        initialUncertaintyKwh,
        ordered,
        selected,
        thresholds,
      });
      evaluatedCombinationCount += 1;

      if (evaluated.valid) {
        if (!bestValid || compareValidPlans(evaluated, bestValid) < 0) bestValid = evaluated;
      } else if (!bestFallback || compareFallbackPlans(evaluated, bestFallback) < 0) {
        bestFallback = evaluated;
      }
    }
  }

  const winner = bestValid ?? bestFallback ?? evaluateSelection({
    energyCapacityKwh,
    heaterPowerKw,
    initialRemainingEnergyKwh,
    initialUncertaintyKwh,
    ordered,
    selected: required,
    thresholds,
  });

  return {
    candidateCount: ordered.length,
    evaluatedCombinationCount,
    forecast: winner.forecast,
    selectedHeatingEnergyKwh: round(winner.selectedHeatingEnergyKwh),
    selectedHeatingHourIds: winner.selectedHeatingHourIds,
    totalCostCents: round(winner.totalCostCents),
    valid: winner.valid,
    violationReason: winner.valid ? null : winner.violationReason,
  };
}

type EvaluatedPlan = {
  forecast: EnergyForecastResult;
  selectedHeatingEnergyKwh: number;
  selectedHeatingHourIds: string[];
  totalCostCents: number;
  valid: boolean;
  violationReason: string | null;
};

function evaluateSelection({
  energyCapacityKwh,
  heaterPowerKw,
  initialRemainingEnergyKwh,
  initialUncertaintyKwh,
  ordered,
  selected,
  thresholds,
}: {
  energyCapacityKwh?: number;
  heaterPowerKw: number;
  initialRemainingEnergyKwh: number;
  initialUncertaintyKwh: number;
  ordered: EnergyPlanCandidateSegment[];
  selected: Set<string>;
  thresholds?: EnergyReserveThresholds;
}): EvaluatedPlan {
  const forecast = forecastEnergyHorizon({
    energyCapacityKwh,
    heaterPowerKw,
    initialRemainingEnergyKwh,
    initialUncertaintyKwh,
    segments: ordered.map((segment) => ({ ...segment, heatingSelected: selected.has(segment.id) })),
    thresholds,
  });

  const selectedSegments = ordered.filter((segment) => selected.has(segment.id));
  const selectedHeatingEnergyKwh = selectedSegments.reduce(
    (sum, segment) => sum + Math.max(0, heaterPowerKw) * clamp(segment.segmentHours, 0, 1),
    0,
  );
  const totalCostCents = selectedSegments.reduce((sum, segment) => {
    const billedPrice = calculateBilledElectricityPriceCentsPerKwh(segment.priceCentsPerKwh);
    return sum + Math.max(0, heaterPowerKw) * clamp(segment.segmentHours, 0, 1) * finitePrice(billedPrice);
  }, 0);

  const finalTargetSatisfied =
    forecast.finalConservativeEnergyKwh >= forecast.thresholds.targetEnergyKwh;
  const safetySatisfied = forecast.firstSafetyViolationAt === null;
  const valid = safetySatisfied && finalTargetSatisfied;

  return {
    forecast,
    selectedHeatingEnergyKwh,
    selectedHeatingHourIds: selectedSegments.map((segment) => segment.id),
    totalCostCents,
    valid,
    violationReason: !safetySatisfied
      ? "safety_reserve_would_be_violated"
      : !finalTargetSatisfied
        ? "target_reserve_not_reached"
        : null,
  };
}

function compareValidPlans(left: EvaluatedPlan, right: EvaluatedPlan) {
  // Once both plans satisfy the hard safety reserve, the primary objective is
  // billed electricity cost. The advisory target/preheat level is deliberately
  // not part of validity or ranking in this PR; later policy may elect to buy
  // extra cheap energy when the known future horizon justifies it.
  if (left.totalCostCents !== right.totalCostCents) {
    return left.totalCostCents - right.totalCostCents;
  }
  if (left.selectedHeatingEnergyKwh !== right.selectedHeatingEnergyKwh) {
    return left.selectedHeatingEnergyKwh - right.selectedHeatingEnergyKwh;
  }
  return left.selectedHeatingHourIds.join("|").localeCompare(right.selectedHeatingHourIds.join("|"));
}

function compareFallbackPlans(left: EvaluatedPlan, right: EvaluatedPlan) {
  if (left.forecast.minimumConservativeEnergyKwh !== right.forecast.minimumConservativeEnergyKwh) {
    return right.forecast.minimumConservativeEnergyKwh - left.forecast.minimumConservativeEnergyKwh;
  }
  if (left.forecast.finalConservativeEnergyKwh !== right.forecast.finalConservativeEnergyKwh) {
    return right.forecast.finalConservativeEnergyKwh - left.forecast.finalConservativeEnergyKwh;
  }
  if (left.selectedHeatingEnergyKwh !== right.selectedHeatingEnergyKwh) {
    return left.selectedHeatingEnergyKwh - right.selectedHeatingEnergyKwh;
  }
  return left.totalCostCents - right.totalCostCents;
}

function invalidResult(
  violationReason: string,
  segments: EnergyPlanCandidateSegment[],
  heaterPowerKw: number,
  initialRemainingEnergyKwh: number,
  initialUncertaintyKwh: number,
  thresholds?: EnergyReserveThresholds,
  energyCapacityKwh?: number,
): EnergyPlanOptimizationResult {
  const forecast = forecastEnergyHorizon({
    energyCapacityKwh,
    heaterPowerKw,
    initialRemainingEnergyKwh,
    initialUncertaintyKwh,
    segments: segments.map((segment) => ({ ...segment, heatingSelected: false })),
    thresholds,
  });
  return {
    candidateCount: segments.length,
    evaluatedCombinationCount: 0,
    forecast,
    selectedHeatingEnergyKwh: 0,
    selectedHeatingHourIds: [],
    totalCostCents: 0,
    valid: false,
    violationReason,
  };
}

function* combinations(values: string[], count: number, start = 0, prefix: string[] = []): Generator<string[]> {
  if (count === 0) {
    yield prefix;
    return;
  }
  for (let index = start; index <= values.length - count; index += 1) {
    yield* combinations(values, count - 1, index + 1, [...prefix, values[index]]);
  }
}

function finitePrice(value: number | null) {
  return typeof value === "number" && Number.isFinite(value)
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

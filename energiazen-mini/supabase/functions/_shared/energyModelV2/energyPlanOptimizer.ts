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
  const maxSelectedHours = Math.max(0, maxHeatingHours);
  const requiredHours = [...required].reduce(
    (sum, id) => sum + clamp(byId.get(id)?.segmentHours ?? 0, 0, 1),
    0,
  );

  if ([...required].some((id) => forbidden.has(id))) {
    return invalidResult("required_hour_is_forbidden", ordered, heaterPowerKw, initialRemainingEnergyKwh, initialUncertaintyKwh, thresholds, energyCapacityKwh);
  }
  if ([...required].some((id) => !byId.has(id))) {
    return invalidResult("required_hour_missing", ordered, heaterPowerKw, initialRemainingEnergyKwh, initialUncertaintyKwh, thresholds, energyCapacityKwh);
  }
  if (requiredHours > maxSelectedHours + 1e-9) {
    return invalidResult("required_hours_exceed_max", ordered, heaterPowerKw, initialRemainingEnergyKwh, initialUncertaintyKwh, thresholds, energyCapacityKwh);
  }

  const optionalIds = ordered
    .map((segment) => segment.id)
    .filter((id) => !required.has(id) && !forbidden.has(id));

  // Exhaustive combinations are useful for the legacy hourly horizon, but a
  // 15-minute day can contain 96 candidates. Use a deadline-driven safety
  // search for larger horizons: start with required intervals, then repeatedly
  // add the cheapest still-available interval no later than the first safety
  // violation. Every returned winner is still validated by the full forecast,
  // so this path can fail closed but can never publish an unsafe plan.
  // The current segment is prorated after its interval has begun, so its
  // segmentHours alone cannot identify the source resolution. Infer a
  // sub-hour feed from spacing between candidate starts instead; this keeps
  // live 60-minute production horizons on the exact optimizer.
  const orderedStartTimes = ordered
    // id is the immutable source interval start; startDate may be moved to
    // "now" for the partially elapsed current interval.
    .map((segment) => Date.parse(segment.id))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const usesSubHourlyFeed = orderedStartTimes.some(
    (start, index) => index > 0 && start - orderedStartTimes[index - 1] < 60 * 60 * 1000,
  );
  if (usesSubHourlyFeed) {
    return optimizeLargeIntervalHorizon({
      energyCapacityKwh,
      forbidden,
      heaterPowerKw,
      initialRemainingEnergyKwh,
      initialUncertaintyKwh,
      maxSelectedHours,
      ordered,
      required,
      thresholds,
    });
  }

  const maxSelected = Math.max(0, Math.floor(maxSelectedHours));
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

function optimizeLargeIntervalHorizon({
  energyCapacityKwh,
  forbidden,
  heaterPowerKw,
  initialRemainingEnergyKwh,
  initialUncertaintyKwh,
  maxSelectedHours,
  ordered,
  required,
  thresholds,
}: {
  energyCapacityKwh?: number;
  forbidden: Set<string>;
  heaterPowerKw: number;
  initialRemainingEnergyKwh: number;
  initialUncertaintyKwh: number;
  maxSelectedHours: number;
  ordered: EnergyPlanCandidateSegment[];
  required: Set<string>;
  thresholds?: EnergyReserveThresholds;
}): EnergyPlanOptimizationResult {
  const selected = new Set(required);
  const visitedSelections = new Set<string>();
  const selectionKey = (ids: Set<string>) => [...ids].sort().join("|");
  visitedSelections.add(selectionKey(selected));
  let selectedHours = ordered
    .filter((segment) => selected.has(segment.id))
    .reduce((sum, segment) => sum + clamp(segment.segmentHours, 0, 1), 0);
  let evaluatedCombinationCount = 0;
  let evaluated = evaluateSelection({
    energyCapacityKwh,
    heaterPowerKw,
    initialRemainingEnergyKwh,
    initialUncertaintyKwh,
    ordered,
    selected,
    thresholds,
  });
  evaluatedCombinationCount += 1;

  while (!evaluated.valid && evaluated.forecast.firstSafetyViolationAt !== null) {
    const violationMs = Date.parse(evaluated.forecast.firstSafetyViolationAt);
    const candidates = ordered
      .filter((segment) => {
        if (selected.has(segment.id) || forbidden.has(segment.id)) return false;
        const duration = clamp(segment.segmentHours, 0, 1);
        if (selectedHours + duration > maxSelectedHours + 1e-9) return false;
        const startsAtViolation = Date.parse(segment.startDate) === violationMs;
        const violationPoint = evaluated.forecast.points.find(
          (point) => point.startDate === evaluated.forecast.firstSafetyViolationAt,
        );
        const violationWasBeforeHeating =
          startsAtViolation &&
          (violationPoint?.frontLoadedDemandKwh ?? 0) > 0 &&
          violationPoint !== undefined &&
          Math.max(
            violationPoint.remainingEnergyBeforeKwh -
              violationPoint.frontLoadedDemandKwh -
              violationPoint.uncertaintyAfterKwh,
            0,
          ) < (thresholds?.safetyEnergyKwh ?? 0) - 1e-9;
        return violationWasBeforeHeating
          ? Date.parse(segment.startDate) < violationMs
          : Date.parse(segment.startDate) <= violationMs;
      })
      .sort((left, right) => {
        const leftPrice = finitePrice(calculateBilledElectricityPriceCentsPerKwh(left.priceCentsPerKwh));
        const rightPrice = finitePrice(calculateBilledElectricityPriceCentsPerKwh(right.priceCentsPerKwh));
        return leftPrice - rightPrice || Date.parse(left.startDate) - Date.parse(right.startDate);
      });

    let next = candidates[0];
    if (!next) {
      // A partially elapsed current interval can consume a fraction of the
      // duration cap and prevent the final full interval from fitting. If that
      // partial interval is optional, drop it and retry so the bounded search
      // can use the complete cap instead of failing because of fragmentation.
      const selectedOptional = ordered.filter(
        (segment) => selected.has(segment.id) && !required.has(segment.id),
      );
      const violationPoint = evaluated.forecast.points.find(
        (point) => point.startDate === evaluated.forecast.firstSafetyViolationAt,
      );
      const violationWasBeforeHeating =
        (violationPoint?.frontLoadedDemandKwh ?? 0) > 0 &&
        violationPoint !== undefined &&
        Math.max(
          violationPoint.remainingEnergyBeforeKwh -
            violationPoint.frontLoadedDemandKwh -
            violationPoint.uncertaintyAfterKwh,
          0,
        ) < (thresholds?.safetyEnergyKwh ?? 0) - 1e-9;
      const replacementCandidates = ordered
        .filter((segment) => {
          if (selected.has(segment.id) || forbidden.has(segment.id)) return false;
          const duration = clamp(segment.segmentHours, 0, 1);
          const startMs = Date.parse(segment.startDate);
          return (violationWasBeforeHeating ? startMs < violationMs : startMs <= violationMs) &&
            selectedHours + duration <= maxSelectedHours + 0.25 + 1e-9;
        })
        .sort((left, right) => {
          const leftPrice = finitePrice(calculateBilledElectricityPriceCentsPerKwh(left.priceCentsPerKwh));
          const rightPrice = finitePrice(calculateBilledElectricityPriceCentsPerKwh(right.priceCentsPerKwh));
          return leftPrice - rightPrice || Date.parse(left.startDate) - Date.parse(right.startDate);
        });
      let replacementCandidate: EnergyPlanCandidateSegment | undefined;
      let replaceablePartial: EnergyPlanCandidateSegment | undefined;
      for (const candidate of replacementCandidates) {
        const replacement = selectedOptional
            .filter((segment) =>
              selectedHours -
                clamp(segment.segmentHours, 0, 1) +
                clamp(candidate.segmentHours, 0, 1) <=
              maxSelectedHours + 1e-9)
            .sort((left, right) => {
              const leftDuration = clamp(left.segmentHours, 0, 1);
              const rightDuration = clamp(right.segmentHours, 0, 1);
              return leftDuration - rightDuration || Date.parse(left.startDate) - Date.parse(right.startDate);
            })
            .find((segment) => {
              const trial = new Set(selected);
              trial.delete(segment.id);
              trial.add(candidate.id);
              if (visitedSelections.has(selectionKey(trial))) return false;
              const trialResult = evaluateSelection({
                energyCapacityKwh,
                heaterPowerKw,
                initialRemainingEnergyKwh,
                initialUncertaintyKwh,
                ordered,
                selected: trial,
                thresholds,
              });
              evaluatedCombinationCount += 1;
              if (trialResult.valid || trialResult.forecast.firstSafetyViolationAt === null) return true;
              const trialViolationMs = Date.parse(trialResult.forecast.firstSafetyViolationAt);
              if (trialViolationMs > violationMs) return true;
              if (trialViolationMs !== violationMs) return false;
              const currentPoint = evaluated.forecast.points.find(
                (point) => point.startDate === evaluated.forecast.firstSafetyViolationAt,
              );
              const trialPoint = trialResult.forecast.points.find(
                (point) => point.startDate === trialResult.forecast.firstSafetyViolationAt,
              );
              if (!currentPoint || !trialPoint) return false;
              const currentPreDemandKwh = Math.max(
                currentPoint.remainingEnergyBeforeKwh -
                  currentPoint.frontLoadedDemandKwh -
                  currentPoint.uncertaintyAfterKwh,
                0,
              );
              const trialPreDemandKwh = Math.max(
                trialPoint.remainingEnergyBeforeKwh -
                  trialPoint.frontLoadedDemandKwh -
                  trialPoint.uncertaintyAfterKwh,
                0,
              );
              const safetyFloor = thresholds?.safetyEnergyKwh ?? 0;
              const currentIsPreDemand = currentPoint.frontLoadedDemandKwh > 0 &&
                currentPreDemandKwh < safetyFloor - 1e-9;
              const trialIsPreDemand = trialPoint.frontLoadedDemandKwh > 0 &&
                trialPreDemandKwh < safetyFloor - 1e-9;
              return (currentIsPreDemand && !trialIsPreDemand) ||
                trialPoint.conservativeEnergyAfterKwh >
                  currentPoint.conservativeEnergyAfterKwh + 1e-9;
            });
        if (replacement) {
          replacementCandidate = candidate;
          replaceablePartial = replacement;
          break;
        }
      }
      if (!replaceablePartial) {
        // A feasible quarter schedule can require several coordinated swaps
        // where no smaller intermediate schedule improves the first violation.
        // Enumerate bounded equal-size exchanges over a small frontier. The
        // horizon remains polynomially bounded in practice while supporting
        // the 3-for-3 cases that defeat greedy and pair recovery.
        // The selected side is naturally bounded by the configured heating
        // duration cap. Do not price-truncate the candidate side: a later,
        // dearer interval can be the only physically feasible replacement
        // because timing and capacity clipping dominate price during recovery.
        const optionalPool = selectedOptional;
        const candidatePool = replacementCandidates;
        let coordinated: { remove: EnergyPlanCandidateSegment[]; add: EnergyPlanCandidateSegment[]; result: EvaluatedPlan } | null = null;
        const combinations = <T,>(items: T[], count: number): T[][] => {
          const out: T[][] = [];
          const visit = (from: number, chosen: T[]) => {
            if (chosen.length === count) {
              out.push([...chosen]);
              return;
            }
            for (let i = from; i <= items.length - (count - chosen.length); i += 1) {
              chosen.push(items[i]);
              visit(i + 1, chosen);
              chosen.pop();
            }
          };
          visit(0, []);
          return out;
        };
        const maxExchange = Math.min(optionalPool.length, candidatePool.length);
        for (let exchange = 2; exchange <= maxExchange && !coordinated; exchange += 1) {
          for (const remove of combinations(optionalPool, exchange)) {
            if (coordinated) break;
            for (const add of combinations(candidatePool, exchange)) {
              const nextHours = selectedHours -
                remove.reduce((sum, segment) => sum + clamp(segment.segmentHours, 0, 1), 0) +
                add.reduce((sum, segment) => sum + clamp(segment.segmentHours, 0, 1), 0);
              if (nextHours > maxSelectedHours + 1e-9) continue;
              const trial = new Set(selected);
              remove.forEach((segment) => trial.delete(segment.id));
              add.forEach((segment) => trial.add(segment.id));
              const trialResult = evaluateSelection({
                energyCapacityKwh,
                heaterPowerKw,
                initialRemainingEnergyKwh,
                initialUncertaintyKwh,
                ordered,
                selected: trial,
                thresholds,
              });
              evaluatedCombinationCount += 1;
              if (trialResult.valid) {
                coordinated = { remove, add, result: trialResult };
                break;
              }
            }
          }
        }
        if (!coordinated) break;
        coordinated.remove.forEach((segment) => {
          selected.delete(segment.id);
          // Removed intervals remain eligible for later coordinated recovery;
          // complete-selection tracking prevents cycles.
        });
        coordinated.add.forEach((segment) => selected.add(segment.id));
        selectedHours = ordered
          .filter((segment) => selected.has(segment.id))
          .reduce((sum, segment) => sum + clamp(segment.segmentHours, 0, 1), 0);
        const coordinatedKey = selectionKey(selected);
        if (visitedSelections.has(coordinatedKey)) break;
        visitedSelections.add(coordinatedKey);
        evaluated = coordinated.result;
        continue;
      }
      const replacementSelection = new Set(selected);
      replacementSelection.delete(replaceablePartial.id);
      if (replacementCandidate) replacementSelection.add(replacementCandidate.id);
      const replacementKey = selectionKey(replacementSelection);
      if (visitedSelections.has(replacementKey)) {
        // The candidate search above normally excludes visited transitions.
        // If state changed unexpectedly, fall through to another recovery
        // iteration instead of terminating the whole bounded search.
        continue;
      }
      selected.clear();
      replacementSelection.forEach((id) => selected.add(id));
      selectedHours = ordered
        .filter((segment) => selected.has(segment.id))
        .reduce((sum, segment) => sum + clamp(segment.segmentHours, 0, 1), 0);
      visitedSelections.add(replacementKey);
      evaluated = evaluateSelection({
        energyCapacityKwh,
        heaterPowerKw,
        initialRemainingEnergyKwh,
        initialUncertaintyKwh,
        ordered,
        selected,
        thresholds,
      });
      evaluatedCombinationCount += 1;
      continue;
    }
    selected.add(next.id);
    selectedHours += clamp(next.segmentHours, 0, 1);
    evaluated = evaluateSelection({
      energyCapacityKwh,
      heaterPowerKw,
      initialRemainingEnergyKwh,
      initialUncertaintyKwh,
      ordered,
      selected,
      thresholds,
    });
    evaluatedCombinationCount += 1;
  }

  return {
    candidateCount: ordered.length,
    evaluatedCombinationCount,
    forecast: evaluated.forecast,
    selectedHeatingEnergyKwh: round(evaluated.selectedHeatingEnergyKwh),
    selectedHeatingHourIds: evaluated.selectedHeatingHourIds,
    totalCostCents: round(evaluated.totalCostCents),
    valid: evaluated.valid,
    violationReason: evaluated.valid ? null : evaluated.violationReason,
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

  // Safety is the only hard energy requirement. The target threshold remains in
  // the forecast as advisory/preheat metadata, but being below it must not force
  // the optimizer to buy electricity. A later price-horizon policy decides when
  // voluntarily preheating above safety is economically worthwhile.
  const safetySatisfied = forecast.firstSafetyViolationAt === null;
  const valid = safetySatisfied;

  return {
    forecast,
    selectedHeatingEnergyKwh,
    selectedHeatingHourIds: selectedSegments.map((segment) => segment.id),
    totalCostCents,
    valid,
    violationReason: safetySatisfied ? null : "safety_reserve_would_be_violated",
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

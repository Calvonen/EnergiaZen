import { calculateBilledElectricityPriceCentsPerKwh } from "../_shared/heatingTariff.ts";
import type { LiveEnergyPlanShadowResult, ShadowElectricityPrice } from "./planShadow.ts";
import { evaluateV2SoftPreheatLevel, type V2SoftPreheatLevel } from "./preheatLevel.ts";
import {
  evaluateV2MarginalPreheatCost,
  marginalPairKey,
  type V2MarginalPreheatCostResult,
  type V2MarginalPreheatPair,
} from "./preheatMarginalCost.ts";
import { evaluateV2PreheatHorizon, type V2PreheatHorizon } from "./preheatPolicy.ts";
import type { V2HeatingConstraints } from "./productionConstraints.ts";

export type V2MarginalPreheatAdvisory = {
  available: boolean;
  candidatePreheatHourIds: string[];
  displacedFutureHeatingHourIds: string[];
  level: V2SoftPreheatLevel;
  marginalCost: V2MarginalPreheatCostResult;
  maxPreheatHoursByHeadroom: number;
  retainedBaselineHeatingEnergyKwh: number;
  retainedBaselineHeatingHourIds: string[];
  reason:
    | "recommended"
    | "preheat_level_unavailable"
    | "preheat_not_needed"
    | "baseline_plan_unavailable"
    | "baseline_plan_invalid"
    | "insufficient_whole_hour_headroom"
    | V2PreheatHorizon["reason"]
    | Exclude<V2MarginalPreheatCostResult["reason"], "recommended">;
};

type SafeMatching = {
  marginalCost: V2MarginalPreheatCostResult;
  maxPreheatHoursByHeadroom: number;
  retainedBaselineHeatingEnergyKwh: number;
  retainedBaselineHeatingHourIds: string[];
};

type DisplacementState = {
  billedTotal: number;
  hourIds: string[];
};

const emptyConstraints: V2HeatingConstraints = {
  forbiddenHeatingHourIds: [],
  requiredHeatingHourIds: [],
};

export function buildV2MarginalPreheatAdvisory({
  baselinePlan,
  conservativeEnergyKwh,
  constraints = emptyConstraints,
  energyCapacityKwh,
  heaterPowerKw,
  maxPreheatHours,
  now,
  prices,
  remainingEnergyKwh,
}: {
  baselinePlan: LiveEnergyPlanShadowResult;
  conservativeEnergyKwh: number;
  constraints?: V2HeatingConstraints;
  energyCapacityKwh: number;
  heaterPowerKw: number;
  maxPreheatHours: number;
  now: Date;
  prices: ShadowElectricityPrice[];
  remainingEnergyKwh: number;
}): V2MarginalPreheatAdvisory {
  const level = evaluateV2SoftPreheatLevel({ conservativeEnergyKwh, energyCapacityKwh });
  if (!level.available || level.recommendedPreheatEnergyKwh === null) {
    return unavailable("preheat_level_unavailable", level);
  }
  if (level.recommendedPreheatEnergyKwh <= 0) {
    return unavailable("preheat_not_needed", level);
  }
  if (!baselinePlan.available) {
    return unavailable("baseline_plan_unavailable", level);
  }
  if (baselinePlan.valid !== true) {
    return unavailable("baseline_plan_invalid", level);
  }
  if (!Number.isFinite(heaterPowerKw) || heaterPowerKw <= 0) {
    return unavailable("invalid_max_preheat_hours", level);
  }
  if (!Number.isFinite(maxPreheatHours) || maxPreheatHours < 0) {
    return unavailable("invalid_max_preheat_hours", level);
  }

  const horizon = evaluateV2PreheatHorizon({ now, prices });
  if (!horizon.available) {
    return unavailable(horizon.reason, level);
  }

  const nowMs = now.getTime();
  const baselineSelectedHourIds = new Set(baselinePlan.selectedHeatingHourIds);
  const forbiddenHeatingHourIds = new Set(constraints.forbiddenHeatingHourIds);
  const requiredHeatingHourIds = new Set(constraints.requiredHeatingHourIds);
  const displacedFutureHeatingHourIds = [...baselineSelectedHourIds]
    .filter((hourId) => !requiredHeatingHourIds.has(hourId))
    .filter((hourId) => Number.isFinite(Date.parse(hourId)) && Date.parse(hourId) > nowMs)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const candidatePreheatHourIds = horizon.futureTodayHourIds.filter(
    (hourId) =>
      !baselineSelectedHourIds.has(hourId) &&
      !forbiddenHeatingHourIds.has(hourId) &&
      !requiredHeatingHourIds.has(hourId),
  );

  const configuredHourCap = Math.floor(maxPreheatHours);
  const physicalHeadroomKwh = Number.isFinite(remainingEnergyKwh)
    ? Math.max(energyCapacityKwh - remainingEnergyKwh, 0)
    : 0;
  const immediateWholeHourHeadroomKwh = Math.min(
    level.recommendedPreheatEnergyKwh,
    physicalHeadroomKwh,
  );
  const wholeHourHeadroomCap = Math.floor(immediateWholeHourHeadroomKwh / heaterPowerKw);
  const initialPairCap = Math.min(
    configuredHourCap,
    wholeHourHeadroomCap,
    candidatePreheatHourIds.length,
    displacedFutureHeatingHourIds.length,
  );

  if (initialPairCap <= 0) {
    return advisoryUnavailable({
      candidatePreheatHourIds,
      displacedFutureHeatingHourIds,
      level,
      marginalCost: { available: false, pairs: [], reason: "no_preheat_candidates" },
      maxPreheatHoursByHeadroom: 0,
      reason: "insufficient_whole_hour_headroom",
      retainedBaselineHeatingEnergyKwh: 0,
      retainedBaselineHeatingHourIds: [],
    });
  }

  let lastMarginalCost: V2MarginalPreheatCostResult = {
    available: false,
    pairs: [],
    reason: "no_preheat_candidates",
  };

  for (let pairCap = initialPairCap; pairCap >= 1; pairCap -= 1) {
    const safeMatching = findBestSafeMatching({
      baselineSelectedHourIds,
      candidatePreheatHourIds,
      configuredHourCap,
      displacedFutureHeatingHourIds,
      heaterPowerKw,
      immediateWholeHourHeadroomKwh,
      nowMs,
      pairCap,
      prices,
    });
    if (safeMatching) {
      return {
        available: true,
        candidatePreheatHourIds,
        displacedFutureHeatingHourIds,
        level,
        marginalCost: safeMatching.marginalCost,
        maxPreheatHoursByHeadroom: safeMatching.maxPreheatHoursByHeadroom,
        retainedBaselineHeatingEnergyKwh: safeMatching.retainedBaselineHeatingEnergyKwh,
        retainedBaselineHeatingHourIds: safeMatching.retainedBaselineHeatingHourIds,
        reason: "recommended",
      };
    }

    const fallback = evaluateV2MarginalPreheatCost({
      displacedFutureHeatingHourIds,
      maxPreheatHours: pairCap,
      preheatCandidateHourIds: candidatePreheatHourIds,
      prices,
    });
    lastMarginalCost = fallback;
    if (!fallback.available) break;
  }

  return advisoryUnavailable({
    candidatePreheatHourIds,
    displacedFutureHeatingHourIds,
    level,
    marginalCost: lastMarginalCost,
    maxPreheatHoursByHeadroom: 0,
    reason: lastMarginalCost.available
      ? "insufficient_whole_hour_headroom"
      : lastMarginalCost.reason,
    retainedBaselineHeatingEnergyKwh: 0,
    retainedBaselineHeatingHourIds: [],
  });
}

function findBestSafeMatching({
  baselineSelectedHourIds,
  candidatePreheatHourIds,
  configuredHourCap,
  displacedFutureHeatingHourIds,
  heaterPowerKw,
  immediateWholeHourHeadroomKwh,
  nowMs,
  pairCap,
  prices,
}: {
  baselineSelectedHourIds: Set<string>;
  candidatePreheatHourIds: string[];
  configuredHourCap: number;
  displacedFutureHeatingHourIds: string[];
  heaterPowerKw: number;
  immediateWholeHourHeadroomKwh: number;
  nowMs: number;
  pairCap: number;
  prices: ShadowElectricityPrice[];
}): SafeMatching | null {
  const priceById = new Map(prices.map((price) => [price.starts_at, price]));
  const candidates = [...candidatePreheatHourIds].sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  );
  const displaced = [...displacedFutureHeatingHourIds].sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  );

  let best: SafeMatching | null = null;
  for (const candidateHourIds of combinations(candidates, pairCap)) {
    const displacedHourIds = findBestDisplacementsForCandidates({
      baselineSelectedHourIds,
      candidateHourIds,
      displacedFutureHeatingHourIds: displaced,
      heaterPowerKw,
      immediateWholeHourHeadroomKwh,
      nowMs,
      priceById,
      prices,
    });
    if (!displacedHourIds) continue;

    const marginalCost = evaluateV2MarginalPreheatCost({
      displacedFutureHeatingHourIds: displacedHourIds,
      maxPreheatHours: pairCap,
      preheatCandidateHourIds: candidateHourIds,
      prices,
    });
    if (!marginalCost.available || marginalCost.pairs.length !== pairCap) continue;

    const safety = evaluateMatchingHeadroom({
      baselineSelectedHourIds,
      configuredHourCap,
      heaterPowerKw,
      immediateWholeHourHeadroomKwh,
      marginalCost,
      nowMs,
      prices,
    });
    if (!safety) continue;

    if (!best || compareSafeMatching(safety, best) < 0) {
      best = safety;
    }
  }

  return best;
}

function findBestDisplacementsForCandidates({
  baselineSelectedHourIds,
  candidateHourIds,
  displacedFutureHeatingHourIds,
  heaterPowerKw,
  immediateWholeHourHeadroomKwh,
  nowMs,
  priceById,
  prices,
}: {
  baselineSelectedHourIds: Set<string>;
  candidateHourIds: string[];
  displacedFutureHeatingHourIds: string[];
  heaterPowerKw: number;
  immediateWholeHourHeadroomKwh: number;
  nowMs: number;
  priceById: Map<string, ShadowElectricityPrice>;
  prices: ShadowElectricityPrice[];
}): string[] | null {
  const pairCount = candidateHourIds.length;
  const candidateBilledPrices = candidateHourIds.map((hourId) => billedPrice(hourId, priceById));
  if (candidateBilledPrices.some((value) => value === null)) return null;

  const states: Array<DisplacementState | null> = Array.from(
    { length: pairCount + 1 },
    () => null,
  );
  states[0] = { billedTotal: 0, hourIds: [] };

  for (const futureHourId of displacedFutureHeatingHourIds) {
    const futureBilledPrice = billedPrice(futureHourId, priceById);
    if (futureBilledPrice === null) return null;

    for (let selectedCount = pairCount - 1; selectedCount >= 0; selectedCount -= 1) {
      const previous = states[selectedCount];
      if (!previous) continue;

      const candidateHourId = candidateHourIds[selectedCount];
      const candidateBilledPrice = candidateBilledPrices[selectedCount];
      if (candidateBilledPrice === null) continue;
      if (Date.parse(candidateHourId) >= Date.parse(futureHourId)) continue;
      if (futureBilledPrice <= candidateBilledPrice) continue;
      if (
        !checkpointFitsHeadroom({
          baselineSelectedHourIds,
          candidateHourIds,
          checkpointHourId: futureHourId,
          heaterPowerKw,
          immediateWholeHourHeadroomKwh,
          nowMs,
          selectedDisplacementHourIds: previous.hourIds,
          prices,
        })
      ) {
        continue;
      }

      const next: DisplacementState = {
        billedTotal: previous.billedTotal + futureBilledPrice,
        hourIds: [...previous.hourIds, futureHourId],
      };
      const nextCount = selectedCount + 1;
      const current = states[nextCount];
      if (!current || betterDisplacementState(next, current)) {
        states[nextCount] = next;
      }
    }
  }

  return states[pairCount]?.hourIds ?? null;
}

function checkpointFitsHeadroom({
  baselineSelectedHourIds,
  candidateHourIds,
  checkpointHourId,
  heaterPowerKw,
  immediateWholeHourHeadroomKwh,
  nowMs,
  selectedDisplacementHourIds,
  prices,
}: {
  baselineSelectedHourIds: Set<string>;
  candidateHourIds: string[];
  checkpointHourId: string;
  heaterPowerKw: number;
  immediateWholeHourHeadroomKwh: number;
  nowMs: number;
  selectedDisplacementHourIds: string[];
  prices: ShadowElectricityPrice[];
}) {
  const checkpointMs = Date.parse(checkpointHourId);
  if (!Number.isFinite(checkpointMs)) return false;

  const baselineEnergyBeforeCheckpoint = [...baselineSelectedHourIds]
    .filter((hourId) => isStillActiveHour(hourId, nowMs, prices))
    .filter((hourId) => Date.parse(hourId) < checkpointMs)
    .reduce(
      (sum, hourId) => sum + retainedHeatingEnergyKwh(hourId, nowMs, heaterPowerKw, prices),
      0,
    );
  const displacedEnergyBeforeCheckpoint = selectedDisplacementHourIds
    .filter((hourId) => Date.parse(hourId) < checkpointMs)
    .reduce(
      (sum, hourId) => sum + retainedHeatingEnergyKwh(hourId, nowMs, heaterPowerKw, prices),
      0,
    );
  const preheatEnergyBeforeCheckpoint = candidateHourIds.filter(
    (hourId) => Date.parse(hourId) < checkpointMs,
  ).length * heaterPowerKw;

  return (
    baselineEnergyBeforeCheckpoint - displacedEnergyBeforeCheckpoint + preheatEnergyBeforeCheckpoint <=
    immediateWholeHourHeadroomKwh + 1e-9
  );
}

function evaluateMatchingHeadroom({
  baselineSelectedHourIds,
  configuredHourCap,
  heaterPowerKw,
  immediateWholeHourHeadroomKwh,
  marginalCost,
  nowMs,
  prices,
}: {
  baselineSelectedHourIds: Set<string>;
  configuredHourCap: number;
  heaterPowerKw: number;
  immediateWholeHourHeadroomKwh: number;
  marginalCost: V2MarginalPreheatCostResult;
  nowMs: number;
  prices: ShadowElectricityPrice[];
}): SafeMatching | null {
  if (!marginalCost.available) return null;

  const displacedIds = new Set(
    marginalCost.pairs.map((pair) => pair.displacedFutureHourId),
  );
  const displacementCheckpointsMs = [...new Set(
    marginalCost.pairs
      .map((pair) => Date.parse(pair.displacedFutureHourId))
      .filter(Number.isFinite),
  )].sort((left, right) => left - right);

  for (const checkpointMs of displacementCheckpointsMs) {
    const retainedBeforeCheckpoint = [...baselineSelectedHourIds]
      .filter((hourId) => !displacedIds.has(hourId))
      .filter((hourId) => isStillActiveHour(hourId, nowMs, prices))
      .filter((hourId) => Date.parse(hourId) < checkpointMs);
    const retainedEnergyBeforeCheckpoint = retainedBeforeCheckpoint.reduce(
      (sum, hourId) => sum + retainedHeatingEnergyKwh(hourId, nowMs, heaterPowerKw, prices),
      0,
    );
    const preheatEnergyBeforeCheckpoint = marginalCost.pairs.filter(
      (pair) => Date.parse(pair.preheatHourId) < checkpointMs,
    ).length * heaterPowerKw;

    if (
      retainedEnergyBeforeCheckpoint + preheatEnergyBeforeCheckpoint >
      immediateWholeHourHeadroomKwh + 1e-9
    ) {
      return null;
    }
  }

  const latestDisplacementMs = displacementCheckpointsMs.length
    ? displacementCheckpointsMs[displacementCheckpointsMs.length - 1]
    : nowMs;
  const retainedBaselineHeatingHourIds = [...baselineSelectedHourIds]
    .filter((hourId) => !displacedIds.has(hourId))
    .filter((hourId) => isStillActiveHour(hourId, nowMs, prices))
    .filter((hourId) => Date.parse(hourId) < latestDisplacementMs)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const retainedBaselineHeatingEnergyKwh = round(retainedBaselineHeatingHourIds.reduce(
    (sum, hourId) => sum + retainedHeatingEnergyKwh(hourId, nowMs, heaterPowerKw, prices),
    0,
  ));
  const safeWholeHourCapacityAfterRetained = Math.max(
    0,
    Math.floor(
      (immediateWholeHourHeadroomKwh - retainedBaselineHeatingEnergyKwh + 1e-9) /
        heaterPowerKw,
    ),
  );

  return {
    marginalCost,
    maxPreheatHoursByHeadroom: Math.min(
      configuredHourCap,
      safeWholeHourCapacityAfterRetained,
    ),
    retainedBaselineHeatingEnergyKwh,
    retainedBaselineHeatingHourIds,
  };
}

function combinations<T>(values: T[], count: number): T[][] {
  if (count === 0) return [[]];
  if (count < 0 || count > values.length) return [];

  const result: T[][] = [];
  const choose = (start: number, selected: T[]) => {
    if (selected.length === count) {
      result.push([...selected]);
      return;
    }
    const remainingNeeded = count - selected.length;
    for (let index = start; index <= values.length - remainingNeeded; index += 1) {
      selected.push(values[index]);
      choose(index + 1, selected);
      selected.pop();
    }
  };
  choose(0, []);
  return result;
}

function billedPrice(
  hourId: string,
  priceById: Map<string, ShadowElectricityPrice>,
) {
  const price = priceById.get(hourId);
  if (!price) return null;
  return calculateBilledElectricityPriceCentsPerKwh(price.spot_price_cents_kwh);
}

function betterDisplacementState(left: DisplacementState, right: DisplacementState) {
  if (left.billedTotal > right.billedTotal) return true;
  if (left.billedTotal < right.billedTotal) return false;
  return left.hourIds.join(",").localeCompare(right.hourIds.join(",")) < 0;
}

function compareSafeMatching(left: SafeMatching, right: SafeMatching) {
  const savingsDifference = totalSavings(right.marginalCost.pairs) - totalSavings(left.marginalCost.pairs);
  if (Math.abs(savingsDifference) > 1e-9) return savingsDifference;
  const leftKey = left.marginalCost.pairs
    .map((pair) => marginalPairKey(pair.preheatHourId, pair.displacedFutureHourId))
    .join(",");
  const rightKey = right.marginalCost.pairs
    .map((pair) => marginalPairKey(pair.preheatHourId, pair.displacedFutureHourId))
    .join(",");
  return leftKey.localeCompare(rightKey);
}

function totalSavings(pairs: V2MarginalPreheatPair[]) {
  return pairs.reduce((sum, pair) => sum + pair.savingsCentsPerKwh, 0);
}

function advisoryUnavailable({
  candidatePreheatHourIds,
  displacedFutureHeatingHourIds,
  level,
  marginalCost,
  maxPreheatHoursByHeadroom,
  reason,
  retainedBaselineHeatingEnergyKwh,
  retainedBaselineHeatingHourIds,
}: Omit<V2MarginalPreheatAdvisory, "available">): V2MarginalPreheatAdvisory {
  return {
    available: false,
    candidatePreheatHourIds,
    displacedFutureHeatingHourIds,
    level,
    marginalCost,
    maxPreheatHoursByHeadroom,
    retainedBaselineHeatingEnergyKwh,
    retainedBaselineHeatingHourIds,
    reason,
  };
}

function isStillActiveHour(
  hourId: string,
  nowMs: number,
  prices: ShadowElectricityPrice[],
) {
  const price = prices.find((row) => row.starts_at === hourId);
  if (!price) return false;
  const start = Date.parse(price.starts_at);
  const end = Date.parse(price.ends_at);
  return Number.isFinite(start) && Number.isFinite(end) && end > nowMs;
}

function retainedHeatingEnergyKwh(
  hourId: string,
  nowMs: number,
  heaterPowerKw: number,
  prices: ShadowElectricityPrice[],
) {
  const price = prices.find((row) => row.starts_at === hourId);
  if (!price) return 0;
  const start = Date.parse(price.starts_at);
  const end = Date.parse(price.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= nowMs) return 0;
  const remainingHours = Math.max(0, Math.min((end - Math.max(start, nowMs)) / 3_600_000, 1));
  return heaterPowerKw * remainingHours;
}

function unavailable(
  reason: Exclude<V2MarginalPreheatAdvisory["reason"], "recommended">,
  level: V2SoftPreheatLevel,
): V2MarginalPreheatAdvisory {
  return {
    available: false,
    candidatePreheatHourIds: [],
    displacedFutureHeatingHourIds: [],
    level,
    marginalCost: {
      available: false,
      pairs: [],
      reason:
        reason === "invalid_max_preheat_hours"
          ? "invalid_max_preheat_hours"
          : reason === "no_future_heating_to_displace"
            ? "no_future_heating_to_displace"
            : "no_preheat_candidates",
    },
    maxPreheatHoursByHeadroom: 0,
    retainedBaselineHeatingEnergyKwh: 0,
    retainedBaselineHeatingHourIds: [],
    reason,
  };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
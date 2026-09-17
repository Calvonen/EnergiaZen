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

type MatchingSearchState = {
  excludedPairKeys: string[];
  marginalCost: V2MarginalPreheatCostResult;
  savings: number;
};

const emptyConstraints: V2HeatingConstraints = {
  forbiddenHeatingHourIds: [],
  requiredHeatingHourIds: [],
};

const MAX_SAFE_MATCHING_SEARCH_STATES = 128;

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
  const initialPairCap = Math.min(configuredHourCap, wholeHourHeadroomCap);

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
  const visited = new Set<string>();
  const frontier: MatchingSearchState[] = [];

  const enqueue = (excludedPairKeys: string[]) => {
    const normalized = [...new Set(excludedPairKeys)].sort();
    const stateKey = normalized.join(",");
    if (visited.has(stateKey) || visited.size >= MAX_SAFE_MATCHING_SEARCH_STATES) return;
    visited.add(stateKey);

    const marginalCost = evaluateV2MarginalPreheatCost({
      displacedFutureHeatingHourIds,
      excludedPairKeys: normalized,
      maxPreheatHours: pairCap,
      preheatCandidateHourIds: candidatePreheatHourIds,
      prices,
    });
    if (!marginalCost.available) return;
    frontier.push({
      excludedPairKeys: normalized,
      marginalCost,
      savings: totalSavings(marginalCost.pairs),
    });
  };

  enqueue([]);

  while (frontier.length) {
    frontier.sort((left, right) => right.savings - left.savings || compareMatching(left, right));
    const state = frontier.shift();
    if (!state) break;

    const safety = evaluateMatchingHeadroom({
      baselineSelectedHourIds,
      configuredHourCap,
      heaterPowerKw,
      immediateWholeHourHeadroomKwh,
      marginalCost: state.marginalCost,
      nowMs,
      prices,
    });
    if (safety) return safety;

    for (const pair of state.marginalCost.pairs) {
      enqueue([
        ...state.excludedPairKeys,
        marginalPairKey(pair.preheatHourId, pair.displacedFutureHourId),
      ]);
    }
  }

  return null;
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

function totalSavings(pairs: V2MarginalPreheatPair[]) {
  return pairs.reduce((sum, pair) => sum + pair.savingsCentsPerKwh, 0);
}

function compareMatching(left: MatchingSearchState, right: MatchingSearchState) {
  const leftKey = left.marginalCost.pairs
    .map((pair) => marginalPairKey(pair.preheatHourId, pair.displacedFutureHourId))
    .join(",");
  const rightKey = right.marginalCost.pairs
    .map((pair) => marginalPairKey(pair.preheatHourId, pair.displacedFutureHourId))
    .join(",");
  return leftKey.localeCompare(rightKey);
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
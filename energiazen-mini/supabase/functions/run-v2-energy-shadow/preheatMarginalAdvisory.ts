import { calculateBilledElectricityPriceCentsPerKwh } from "../_shared/heatingTariff.ts";
import type { LiveEnergyPlanShadowResult, ShadowElectricityPrice } from "./planShadow.ts";
import { evaluateV2SoftPreheatLevel, type V2SoftPreheatLevel } from "./preheatLevel.ts";
import {
  evaluateV2MarginalPreheatCost,
  marginalPairKey,
  type V2MarginalPreheatCostResult,
  type V2MarginalPreheatPair,
} from "./preheatMarginalCost.ts";
import {
  evaluateV2PreheatHorizon,
  type V2PreheatHorizon,
  type V2PreheatOpportunity,
} from "./preheatPolicy.ts";
import type { V2HeatingConstraints } from "./productionConstraints.ts";

export type V2MarginalPreheatAdvisory = {
  available: boolean;
  candidatePreheatHourIds: string[];
  displacedFutureHeatingHourIds: string[];
  level: V2SoftPreheatLevel;
  marginalCost: V2MarginalPreheatCostResult;
  maxPreheatHoursByHeadroom: number;
  recommendedPreheatHourIds: string[];
  retainedBaselineHeatingEnergyKwh: number;
  retainedBaselineHeatingHourIds: string[];
  strategy: "marginal_displacement" | null;
  reason:
    | "recommended"
    | "preheat_level_unavailable"
    | "preheat_not_needed"
    | "baseline_plan_unavailable"
    | "baseline_plan_invalid"
    | "insufficient_whole_hour_headroom"
    | V2PreheatHorizon["reason"]
    | Exclude<V2PreheatOpportunity["reason"], "recommended">
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
  physicalEnergyCapacityKwh = energyCapacityKwh,
  heaterPowerKw,
  maxPreheatHours,
  now,
  prices,
  recommendedPreheatPercent,
  remainingEnergyKwh,
  evaluateHourSelection,
  priceReferencePrices = prices,
  priceToleranceCents = 0,
}: {
  baselinePlan: LiveEnergyPlanShadowResult;
  conservativeEnergyKwh: number;
  constraints?: V2HeatingConstraints;
  energyCapacityKwh: number;
  physicalEnergyCapacityKwh?: number;
  heaterPowerKw: number;
  maxPreheatHours: number;
  now: Date;
  prices: ShadowElectricityPrice[];
  recommendedPreheatPercent?: number;
  remainingEnergyKwh: number;
  evaluateHourSelection?: (selectedHourIds: string[]) => LiveEnergyPlanShadowResult;
  priceReferencePrices?: ShadowElectricityPrice[];
  priceToleranceCents?: number;
}): V2MarginalPreheatAdvisory {
  const level = evaluateV2SoftPreheatLevel({
    conservativeEnergyKwh,
    energyCapacityKwh,
    recommendedPreheatPercent,
  });
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
  const tomorrowOnlySoftFill =
    !horizon.available &&
    horizon.reason === "no_future_today_prices" &&
    Boolean(evaluateHourSelection) &&
    horizon.tomorrowHourIds.length > 0;
  const todayOnlySoftFill =
    !horizon.available &&
    horizon.reason === "tomorrow_prices_incomplete" &&
    Boolean(evaluateHourSelection) &&
    baselinePlan.selectedHeatingHourIds.length === 0 &&
    horizon.futureTodayHourIds.length > 0;
  if (!horizon.available && !tomorrowOnlySoftFill && !todayOnlySoftFill) {
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

  const softTargetKwh = level.recommendedPreheatTargetKwh;
  if (
    displacedFutureHeatingHourIds.length === 0 &&
    softTargetKwh !== null &&
    baselinePlan.finalConservativeEnergyKwh !== null &&
    baselinePlan.finalConservativeEnergyKwh + 1e-9 >= softTargetKwh
  ) {
    return unavailable("preheat_not_needed", level);
  }

  // A soft preheat target must never create heating demand by itself.
  // Preheat is only economical when it can move heating that the safety
  // baseline already needs later in the horizon to an earlier cheaper hour.
  // If the baseline needs no future heat, keep the advisory off even when the
  // forecast ends below the soft target. This prevents horizon_soft_fill from
  // turning the advisory percentage into a de-facto terminal reserve target.
  if (displacedFutureHeatingHourIds.length === 0) {
    return advisoryUnavailable({
      candidatePreheatHourIds,
      displacedFutureHeatingHourIds: [],
      level,
      marginalCost: {
        available: false,
        pairs: [],
        reason: "no_future_heating_to_displace",
      },
      maxPreheatHoursByHeadroom: 0,
      reason: "no_future_heating_to_displace",
      recommendedPreheatHourIds: [],
      retainedBaselineHeatingEnergyKwh: 0,
      retainedBaselineHeatingHourIds: [...baselineSelectedHourIds].sort(
        (left, right) => Date.parse(left) - Date.parse(right),
      ),
      strategy: null,
    });
  }

  const intervalHours = horizon.resolutionMinutes === 15 ? 0.25 : 1;
  const configuredHourCap = Math.floor(maxPreheatHours / intervalHours);
  const physicalHeadroomKwh =
    Number.isFinite(remainingEnergyKwh) &&
      Number.isFinite(physicalEnergyCapacityKwh) &&
      physicalEnergyCapacityKwh > 0
      ? Math.max(physicalEnergyCapacityKwh - remainingEnergyKwh, 0)
      : 0;
  const immediateWholeHourHeadroomKwh = Math.min(
    level.recommendedPreheatEnergyKwh,
    physicalHeadroomKwh,
  );
  const intervalEnergyKwh = heaterPowerKw * intervalHours;
  const wholeHourHeadroomCap = Math.floor(
    (immediateWholeHourHeadroomKwh + 1e-9) / intervalEnergyKwh,
  );
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
      recommendedPreheatHourIds: [],
      retainedBaselineHeatingEnergyKwh: 0,
      retainedBaselineHeatingHourIds: [],
      strategy: null,
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
      resolutionMinutes: horizon.resolutionMinutes,
    });
    if (safeMatching) {
      return {
        available: true,
        candidatePreheatHourIds,
        displacedFutureHeatingHourIds,
        level,
        marginalCost: safeMatching.marginalCost,
        maxPreheatHoursByHeadroom: safeMatching.maxPreheatHoursByHeadroom,
        recommendedPreheatHourIds: safeMatching.marginalCost.pairs
          .map((pair) => pair.preheatHourId)
          .sort((left, right) => Date.parse(left) - Date.parse(right)),
        retainedBaselineHeatingEnergyKwh: safeMatching.retainedBaselineHeatingEnergyKwh,
        retainedBaselineHeatingHourIds: safeMatching.retainedBaselineHeatingHourIds,
        strategy: "marginal_displacement",
        reason: "recommended",
      };
    }

    const fallback = evaluateV2MarginalPreheatCost({
      displacedFutureHeatingHourIds,
      maxPreheatHours: pairCap,
      preheatCandidateHourIds: candidatePreheatHourIds,
      prices,
      resolutionMinutes: horizon.resolutionMinutes ?? undefined,
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
    recommendedPreheatHourIds: [],
    retainedBaselineHeatingEnergyKwh: 0,
    retainedBaselineHeatingHourIds: [],
    strategy: null,
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
  resolutionMinutes,
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
  resolutionMinutes: 15 | 60 | null;
}): SafeMatching | null {
  if (resolutionMinutes !== 15 && resolutionMinutes !== 60) return null;
  const selectedFeedPrices = prices.filter(
    (price) => price.resolution_minutes === resolutionMinutes,
  );
  const priceById = new Map(selectedFeedPrices.map((price) => [price.starts_at, price]));
  const candidates = [...candidatePreheatHourIds].sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  );
  const displaced = [...displacedFutureHeatingHourIds].sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  );

  // Keep quarter-hour advisory work bounded. Marginal cost already uses DP;
  // here evaluate a small deterministic frontier of cheap/early candidate
  // subsets instead of every C(n,k) combination.
  const candidateSubsets = boundedCandidateSubsets(candidates, pairCap, priceById);
  let best: SafeMatching | null = null;
  for (const candidateHourIds of candidateSubsets) {
    const displacedHourIds = findBestDisplacementsForCandidates({
      baselineSelectedHourIds,
      candidateHourIds,
      displacedFutureHeatingHourIds: displaced,
      heaterPowerKw,
      immediateWholeHourHeadroomKwh,
      nowMs,
      priceById,
      prices: selectedFeedPrices,
    });
    if (!displacedHourIds) continue;

    const marginalCost = evaluateV2MarginalPreheatCost({
      displacedFutureHeatingHourIds: displacedHourIds,
      maxPreheatHours: pairCap,
      preheatCandidateHourIds: candidateHourIds,
      prices,
      requireExactPairCount: true,
      resolutionMinutes,
    });
    if (!marginalCost.available || marginalCost.pairs.length !== pairCap) continue;

    const safety = evaluateMatchingHeadroom({
      baselineSelectedHourIds,
      configuredHourCap,
      heaterPowerKw,
      immediateWholeHourHeadroomKwh,
      marginalCost,
      nowMs,
      prices: selectedFeedPrices,
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
  const preheatEnergyBeforeCheckpoint = candidateHourIds
    .filter((hourId) => Date.parse(hourId) < checkpointMs)
    .reduce(
      (sum, hourId) => sum + retainedHeatingEnergyKwh(hourId, nowMs, heaterPowerKw, prices),
      0,
    );

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
    const preheatEnergyBeforeCheckpoint = marginalCost.pairs
      .filter((pair) => Date.parse(pair.preheatHourId) < checkpointMs)
      .reduce(
        (sum, pair) => sum + retainedHeatingEnergyKwh(pair.preheatHourId, nowMs, heaterPowerKw, prices),
        0,
      );

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
  const matchedIntervalId = marginalCost.pairs[0]?.preheatHourId ?? null;
  const matchedPrice = matchedIntervalId
    ? prices.find((row) => row.starts_at === matchedIntervalId)
    : null;
  const matchedIntervalHours =
    matchedPrice?.resolution_minutes === 15 ? 0.25 : 1;
  const matchedIntervalEnergyKwh = heaterPowerKw * matchedIntervalHours;
  const safeWholeHourCapacityAfterRetained = Math.max(
    0,
    Math.floor(
      (immediateWholeHourHeadroomKwh - retainedBaselineHeatingEnergyKwh + 1e-9) /
        matchedIntervalEnergyKwh,
    ),
  );

  return {
    marginalCost,
    maxPreheatHoursByHeadroom: Math.min(
      configuredHourCap * matchedIntervalHours,
      safeWholeHourCapacityAfterRetained * matchedIntervalHours,
    ),
    retainedBaselineHeatingEnergyKwh,
    retainedBaselineHeatingHourIds,
  };
}

function boundedCandidateSubsets(
  candidates: string[],
  count: number,
  priceById: Map<string, ShadowElectricityPrice>,
): string[][] {
  if (count <= 0 || count > candidates.length) return [];
  const byPrice = [...candidates].sort((left, right) => {
    const leftPrice = billedPrice(left, priceById) ?? Number.POSITIVE_INFINITY;
    const rightPrice = billedPrice(right, priceById) ?? Number.POSITIVE_INFINITY;
    return leftPrice - rightPrice || Date.parse(left) - Date.parse(right);
  });
  const byTime = [...candidates].sort((left, right) => Date.parse(left) - Date.parse(right));
  const windows: string[][] = [];
  const add = (ids: string[]) => {
    const normalized = [...ids].sort((left, right) => Date.parse(left) - Date.parse(right));
    const key = normalized.join("|");
    if (!windows.some((existing) => existing.join("|") === key)) windows.push(normalized);
  };
  add(byPrice.slice(0, count));
  add(byTime.slice(0, count));
  const frontier = byPrice.slice(0, Math.min(byPrice.length, count + 8));
  for (let offset = 0; offset <= Math.min(8, frontier.length - count); offset += 1) {
    add(frontier.slice(offset, offset + count));
  }

  // Preserve bounded work while covering viable early candidates that can be
  // hidden behind many cheaper-but-too-late intervals. For each chronological
  // prefix, evaluate its cheapest count-sized subset. This adds at most O(n)
  // deterministic candidates instead of enumerating C(n,k).
  for (let end = count; end <= byTime.length; end += 1) {
    const cheapestPrefix = byTime
      .slice(0, end)
      .sort((left, right) => {
        const leftPrice = billedPrice(left, priceById) ?? Number.POSITIVE_INFINITY;
        const rightPrice = billedPrice(right, priceById) ?? Number.POSITIVE_INFINITY;
        return leftPrice - rightPrice || Date.parse(left) - Date.parse(right);
      })
      .slice(0, count);
    add(cheapestPrefix);
  }
  return windows;
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
  recommendedPreheatHourIds,
  retainedBaselineHeatingEnergyKwh,
  retainedBaselineHeatingHourIds,
  strategy,
}: Omit<V2MarginalPreheatAdvisory, "available">): V2MarginalPreheatAdvisory {
  return {
    available: false,
    candidatePreheatHourIds,
    displacedFutureHeatingHourIds,
    level,
    marginalCost,
    maxPreheatHoursByHeadroom,
    recommendedPreheatHourIds,
    retainedBaselineHeatingEnergyKwh,
    retainedBaselineHeatingHourIds,
    strategy,
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
    recommendedPreheatHourIds: [],
    retainedBaselineHeatingEnergyKwh: 0,
    retainedBaselineHeatingHourIds: [],
    strategy: null,
    reason,
  };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

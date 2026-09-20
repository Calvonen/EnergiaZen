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
  evaluateV2PreheatOpportunity,
  getCompleteHelsinkiDayMinimumBilledPrices,
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
  strategy: "marginal_displacement" | "soft_fill" | "horizon_soft_fill" | null;
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

  const configuredHourCap = Math.floor(maxPreheatHours);
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
  const wholeHourHeadroomCap = Math.floor(immediateWholeHourHeadroomKwh / heaterPowerKw);
  const initialPairCap = Math.min(configuredHourCap, wholeHourHeadroomCap);

  if (displacedFutureHeatingHourIds.length === 0 && evaluateHourSelection) {
    return buildHorizonSoftFillFallback({
      baselinePlan,
      baselineSelectedHourIds,
      configuredHourCap,
      constraints,
      evaluateHourSelection,
      horizon,
      level,
      prices,
      priceReferencePrices,
      priceToleranceCents,
    });
  }

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

  if (displacedFutureHeatingHourIds.length === 0) {
    return buildSoftFillFallback({
      baselineSelectedHourIds,
      candidatePreheatHourIds,
      configuredHourCap,
      heaterPowerKw,
      immediateWholeHourHeadroomKwh,
      level,
      now,
      nowMs,
      prices,
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


function buildHorizonSoftFillFallback({
  baselinePlan,
  baselineSelectedHourIds,
  configuredHourCap,
  constraints,
  evaluateHourSelection,
  horizon,
  level,
  prices,
  priceReferencePrices,
  priceToleranceCents,
}: {
  baselinePlan: LiveEnergyPlanShadowResult;
  baselineSelectedHourIds: Set<string>;
  configuredHourCap: number;
  constraints: V2HeatingConstraints;
  evaluateHourSelection: (selectedHourIds: string[]) => LiveEnergyPlanShadowResult;
  horizon: V2PreheatHorizon;
  level: V2SoftPreheatLevel;
  prices: ShadowElectricityPrice[];
  priceReferencePrices: ShadowElectricityPrice[];
  priceToleranceCents: number;
}): V2MarginalPreheatAdvisory {
  const targetKwh = level.recommendedPreheatTargetKwh;
  if (targetKwh === null || configuredHourCap <= 0) {
    return unavailable("insufficient_whole_hour_headroom", level);
  }

  if (
    baselinePlan.finalConservativeEnergyKwh !== null &&
    baselinePlan.finalConservativeEnergyKwh + 1e-9 >= targetKwh
  ) {
    return unavailable("preheat_not_needed", level);
  }

  const forbidden = new Set(constraints.forbiddenHeatingHourIds);
  const required = new Set(constraints.requiredHeatingHourIds);
  const priceById = new Map(prices.map((price) => [price.starts_at, price]));
  const dailyMinimumBilledPrices =
    getCompleteHelsinkiDayMinimumBilledPrices(priceReferencePrices);
  const normalizedPriceToleranceCents =
    Number.isFinite(priceToleranceCents) && priceToleranceCents > 0
      ? priceToleranceCents
      : 0;
  const candidatePreheatHourIds = [
    ...horizon.futureTodayHourIds,
    ...horizon.tomorrowHourIds,
  ]
    .filter((hourId) => !baselineSelectedHourIds.has(hourId))
    .filter((hourId) => !forbidden.has(hourId))
    .filter((hourId) => !required.has(hourId))
    .filter((hourId) => billedPrice(hourId, priceById) !== null)
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  const baselineIds = [...baselineSelectedHourIds].sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  );
  const marginalCost: V2MarginalPreheatCostResult = {
    available: false,
    pairs: [],
    reason: "no_future_heating_to_displace",
  };

  type Candidate = {
    addedHourIds: string[];
    effectiveCostCents: number;
    finalConservativeEnergyKwh: number;
    lastCandidateIndex: number;
    totalCostCents: number;
  };

  const maxAdditionalHours = Math.min(
    configuredHourCap,
    Math.max(configuredHourCap - baselineIds.length, 0),
  );
  const beamWidth = 24;
  const maxForecastEvaluations = 3000;
  let forecastEvaluations = 0;
  let beam: Candidate[] = [{
    addedHourIds: [],
    effectiveCostCents: 0,
    finalConservativeEnergyKwh: Math.max(
      targetKwh - (level.recommendedPreheatEnergyKwh ?? 0),
      0,
    ),
    lastCandidateIndex: -1,
    totalCostCents: baselineIds.reduce((sum, hourId) => {
      const price = billedPrice(hourId, priceById);
      return sum + (price ?? 0);
    }, 0),
  }];
  let bestReached: Candidate | null = null;
  let bestPartial: Candidate | null = null;

  for (let count = 1; count <= maxAdditionalHours; count += 1) {
    const expanded: Candidate[] = [];
    const seen = new Set<string>();

    for (const state of beam) {
      for (
        let candidateIndex = state.lastCandidateIndex + 1;
        candidateIndex < candidatePreheatHourIds.length;
        candidateIndex += 1
      ) {
        if (forecastEvaluations >= maxForecastEvaluations) break;

        const addedHourIds = [
          ...state.addedHourIds,
          candidatePreheatHourIds[candidateIndex],
        ];
        const key = addedHourIds.join("|");
        if (seen.has(key)) continue;
        seen.add(key);

        const selectedHourIds = [...new Set([...baselineIds, ...addedHourIds])].sort(
          (left, right) => Date.parse(left) - Date.parse(right),
        );
        if (selectedHourIds.length > configuredHourCap) continue;

        forecastEvaluations += 1;
        const simulated = evaluateHourSelection(selectedHourIds);
        if (
          !simulated.available ||
          simulated.valid !== true ||
          simulated.finalConservativeEnergyKwh === null ||
          simulated.totalCostCents === null
        ) {
          continue;
        }

        const effectiveCostCents = addedHourIds.reduce((sum, hourId) => {
          const price = effectiveBilledPrice(
            hourId,
            priceById,
            dailyMinimumBilledPrices,
            normalizedPriceToleranceCents,
          );
          return sum + (price ?? Number.POSITIVE_INFINITY);
        }, 0);
        if (!Number.isFinite(effectiveCostCents)) continue;

        const candidate: Candidate = {
          addedHourIds,
          effectiveCostCents,
          finalConservativeEnergyKwh: simulated.finalConservativeEnergyKwh,
          lastCandidateIndex: candidateIndex,
          totalCostCents: simulated.totalCostCents,
        };
        expanded.push(candidate);

        if (candidate.finalConservativeEnergyKwh + 1e-9 >= targetKwh) {
          if (
            !bestReached ||
            compareHorizonCandidate(
              candidate,
              bestReached,
              normalizedPriceToleranceCents > 0,
            ) < 0
          ) {
            bestReached = candidate;
          }
        } else if (
          !bestPartial ||
          candidate.finalConservativeEnergyKwh > bestPartial.finalConservativeEnergyKwh + 1e-9 ||
          (
            Math.abs(
              candidate.finalConservativeEnergyKwh -
                bestPartial.finalConservativeEnergyKwh,
            ) <= 1e-9 &&
            compareHorizonCandidate(
              candidate,
              bestPartial,
              normalizedPriceToleranceCents > 0,
            ) < 0
          )
        ) {
          bestPartial = candidate;
        }
      }
      if (forecastEvaluations >= maxForecastEvaluations) break;
    }

    if (bestReached) break;
    if (!expanded.length || forecastEvaluations >= maxForecastEvaluations) break;

    beam = selectDiverseBeam(
      expanded,
      beamWidth,
      normalizedPriceToleranceCents > 0,
    );
  }

  const winner = bestReached ?? bestPartial;
  if (!winner) {
    return advisoryUnavailable({
      candidatePreheatHourIds,
      displacedFutureHeatingHourIds: [],
      level,
      marginalCost,
      maxPreheatHoursByHeadroom: 0,
      reason: "no_preheat_candidates",
      recommendedPreheatHourIds: [],
      retainedBaselineHeatingEnergyKwh: 0,
      retainedBaselineHeatingHourIds: baselineIds,
      strategy: null,
    });
  }

  return {
    available: true,
    candidatePreheatHourIds,
    displacedFutureHeatingHourIds: [],
    level,
    marginalCost,
    maxPreheatHoursByHeadroom: winner.addedHourIds.length,
    recommendedPreheatHourIds: [...winner.addedHourIds].sort(
      (left, right) => Date.parse(left) - Date.parse(right),
    ),
    retainedBaselineHeatingEnergyKwh: 0,
    retainedBaselineHeatingHourIds: baselineIds,
    strategy: "horizon_soft_fill",
    reason: "recommended",
  };
}

function selectDiverseBeam<T extends {
  addedHourIds: string[];
  effectiveCostCents: number;
  finalConservativeEnergyKwh: number;
  totalCostCents: number;
}>(candidates: T[], width: number, preferLaterOnToleranceTie: boolean): T[] {
  if (candidates.length <= width) return candidates;

  const half = Math.max(1, Math.floor(width / 2));
  const byEnergy = [...candidates].sort((left, right) =>
    right.finalConservativeEnergyKwh - left.finalConservativeEnergyKwh ||
    compareHorizonCandidate(left, right, preferLaterOnToleranceTie)
  );
  const byCost = [...candidates].sort((left, right) =>
    compareHorizonCandidate(left, right, preferLaterOnToleranceTie) ||
    right.finalConservativeEnergyKwh - left.finalConservativeEnergyKwh
  );

  const selected: T[] = [];
  const seen = new Set<string>();
  for (const candidate of [...byEnergy.slice(0, half), ...byCost]) {
    const key = candidate.addedHourIds.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(candidate);
    if (selected.length >= width) break;
  }
  return selected;
}

const helsinkiPriceDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

function effectiveBilledPrice(
  hourId: string,
  priceById: Map<string, ShadowElectricityPrice>,
  dailyMinimumBilledPrices: Map<string, number>,
  priceToleranceCents: number,
) {
  const actual = billedPrice(hourId, priceById);
  if (actual === null || priceToleranceCents <= 0) return actual;
  const dateKey = helsinkiPriceDateFormatter.format(new Date(hourId));
  const dailyMinimum = dailyMinimumBilledPrices.get(dateKey);
  if (dailyMinimum === undefined) return actual;
  return actual <= dailyMinimum + priceToleranceCents + 1e-9
    ? dailyMinimum
    : actual;
}

function compareHorizonCandidate(
  left: {
    addedHourIds: string[];
    effectiveCostCents: number;
    totalCostCents: number;
  },
  right: {
    addedHourIds: string[];
    effectiveCostCents: number;
    totalCostCents: number;
  },
  preferLaterOnToleranceTie: boolean,
) {
  if (Math.abs(left.effectiveCostCents - right.effectiveCostCents) > 1e-9) {
    return left.effectiveCostCents - right.effectiveCostCents;
  }
  if (preferLaterOnToleranceTie) {
    const later = compareLaterSchedule(left.addedHourIds, right.addedHourIds);
    if (later !== 0) return later;
  }
  if (Math.abs(left.totalCostCents - right.totalCostCents) > 1e-9) {
    return left.totalCostCents - right.totalCostCents;
  }
  return left.addedHourIds.join("|").localeCompare(right.addedHourIds.join("|"));
}

function compareLaterSchedule(leftHourIds: string[], rightHourIds: string[]) {
  const left = [...leftHourIds].sort((a, b) => Date.parse(a) - Date.parse(b));
  const right = [...rightHourIds].sort((a, b) => Date.parse(a) - Date.parse(b));
  const count = Math.min(left.length, right.length);
  for (let offset = 1; offset <= count; offset += 1) {
    const leftMs = Date.parse(left[left.length - offset]);
    const rightMs = Date.parse(right[right.length - offset]);
    if (leftMs !== rightMs) return rightMs - leftMs;
  }
  return right.length - left.length;
}

function buildSoftFillFallback({
  baselineSelectedHourIds,
  candidatePreheatHourIds,
  configuredHourCap,
  heaterPowerKw,
  immediateWholeHourHeadroomKwh,
  level,
  now,
  nowMs,
  prices,
}: {
  baselineSelectedHourIds: Set<string>;
  candidatePreheatHourIds: string[];
  configuredHourCap: number;
  heaterPowerKw: number;
  immediateWholeHourHeadroomKwh: number;
  level: V2SoftPreheatLevel;
  now: Date;
  nowMs: number;
  prices: ShadowElectricityPrice[];
}): V2MarginalPreheatAdvisory {
  const opportunity = evaluateV2PreheatOpportunity({ now, prices });
  const retainedBaselineHeatingHourIds = [...baselineSelectedHourIds]
    .filter((hourId) => isStillActiveHour(hourId, nowMs, prices))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const retainedBaselineHeatingEnergyKwh = round(retainedBaselineHeatingHourIds.reduce(
    (sum, hourId) => sum + retainedHeatingEnergyKwh(hourId, nowMs, heaterPowerKw, prices),
    0,
  ));
  const availableHeadroomKwh = Math.max(
    immediateWholeHourHeadroomKwh - retainedBaselineHeatingEnergyKwh,
    0,
  );
  const remainingConfiguredHourCap = Math.max(
    configuredHourCap - retainedBaselineHeatingHourIds.length,
    0,
  );
  const maxPreheatHoursByHeadroom = Math.min(
    remainingConfiguredHourCap,
    Math.floor((availableHeadroomKwh + 1e-9) / heaterPowerKw),
  );
  const marginalCost: V2MarginalPreheatCostResult = {
    available: false,
    pairs: [],
    reason: "no_future_heating_to_displace",
  };

  if (maxPreheatHoursByHeadroom <= 0) {
    return advisoryUnavailable({
      candidatePreheatHourIds,
      displacedFutureHeatingHourIds: [],
      level,
      marginalCost,
      maxPreheatHoursByHeadroom: 0,
      reason: "insufficient_whole_hour_headroom",
      recommendedPreheatHourIds: [],
      retainedBaselineHeatingEnergyKwh,
      retainedBaselineHeatingHourIds,
      strategy: null,
    });
  }
  if (!opportunity.available) {
    return advisoryUnavailable({
      candidatePreheatHourIds,
      displacedFutureHeatingHourIds: [],
      level,
      marginalCost,
      maxPreheatHoursByHeadroom,
      reason: opportunity.reason,
      recommendedPreheatHourIds: [],
      retainedBaselineHeatingEnergyKwh,
      retainedBaselineHeatingHourIds,
      strategy: null,
    });
  }

  const eligible = new Set(opportunity.eligiblePreheatHourIds);
  const priceById = new Map(prices.map((price) => [price.starts_at, price]));
  const recommendedPreheatHourIds = candidatePreheatHourIds
    .filter((hourId) => eligible.has(hourId))
    .sort((left, right) => {
      const leftPrice = billedPrice(left, priceById) ?? Number.POSITIVE_INFINITY;
      const rightPrice = billedPrice(right, priceById) ?? Number.POSITIVE_INFINITY;
      if (leftPrice !== rightPrice) return leftPrice - rightPrice;
      return Date.parse(left) - Date.parse(right);
    })
    .slice(0, maxPreheatHoursByHeadroom)
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  if (!recommendedPreheatHourIds.length) {
    return advisoryUnavailable({
      candidatePreheatHourIds,
      displacedFutureHeatingHourIds: [],
      level,
      marginalCost,
      maxPreheatHoursByHeadroom,
      reason: "no_cheaper_preheat_interval",
      recommendedPreheatHourIds: [],
      retainedBaselineHeatingEnergyKwh,
      retainedBaselineHeatingHourIds,
      strategy: null,
    });
  }

  return {
    available: true,
    candidatePreheatHourIds,
    displacedFutureHeatingHourIds: [],
    level,
    marginalCost,
    maxPreheatHoursByHeadroom,
    recommendedPreheatHourIds,
    retainedBaselineHeatingEnergyKwh,
    retainedBaselineHeatingHourIds,
    strategy: "soft_fill",
    reason: "recommended",
  };
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
      requireExactPairCount: true,
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

import type { LiveEnergyPlanShadowResult, ShadowElectricityPrice } from "./planShadow.ts";
import { evaluateV2SoftPreheatLevel, type V2SoftPreheatLevel } from "./preheatLevel.ts";
import {
  evaluateV2MarginalPreheatCost,
  type V2MarginalPreheatCostResult,
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
}: {
  baselinePlan: LiveEnergyPlanShadowResult;
  conservativeEnergyKwh: number;
  constraints?: V2HeatingConstraints;
  energyCapacityKwh: number;
  heaterPowerKw: number;
  maxPreheatHours: number;
  now: Date;
  prices: ShadowElectricityPrice[];
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
  const displacedFutureHeatingHourIds = [...baselineSelectedHourIds]
    .filter((hourId) => Number.isFinite(Date.parse(hourId)) && Date.parse(hourId) > nowMs)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const candidatePreheatHourIds = horizon.futureTodayHourIds.filter(
    (hourId) => !baselineSelectedHourIds.has(hourId) && !forbiddenHeatingHourIds.has(hourId),
  );

  const configuredHourCap = Math.floor(maxPreheatHours);
  const physicalHeadroomKwh = Math.max(energyCapacityKwh - conservativeEnergyKwh, 0);
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
    const marginalCost = evaluateV2MarginalPreheatCost({
      displacedFutureHeatingHourIds,
      maxPreheatHours: pairCap,
      preheatCandidateHourIds: candidatePreheatHourIds,
      prices,
    });
    lastMarginalCost = marginalCost;
    if (!marginalCost.available) break;

    const displacedIds = new Set(
      marginalCost.pairs.map((pair) => pair.displacedFutureHourId),
    );
    const displacementCheckpointsMs = [...new Set(
      marginalCost.pairs
        .map((pair) => Date.parse(pair.displacedFutureHourId))
        .filter(Number.isFinite),
    )].sort((left, right) => left - right);

    let safeAtEveryDisplacement = true;
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
        safeAtEveryDisplacement = false;
        break;
      }
    }

    if (safeAtEveryDisplacement) {
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

      return {
        available: true,
        candidatePreheatHourIds,
        displacedFutureHeatingHourIds,
        level,
        marginalCost,
        maxPreheatHoursByHeadroom: pairCap,
        retainedBaselineHeatingEnergyKwh,
        retainedBaselineHeatingHourIds,
        reason: "recommended",
      };
    }
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

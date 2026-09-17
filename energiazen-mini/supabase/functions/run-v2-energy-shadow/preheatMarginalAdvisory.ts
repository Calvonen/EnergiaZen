import type { LiveEnergyPlanShadowResult, ShadowElectricityPrice } from "./planShadow.ts";
import { evaluateV2SoftPreheatLevel, type V2SoftPreheatLevel } from "./preheatLevel.ts";
import {
  evaluateV2MarginalPreheatCost,
  type V2MarginalPreheatCostResult,
} from "./preheatMarginalCost.ts";
import { evaluateV2PreheatHorizon, type V2PreheatHorizon } from "./preheatPolicy.ts";

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
    | V2PreheatHorizon["reason"]
    | Exclude<V2MarginalPreheatCostResult["reason"], "recommended">;
};

export function buildV2MarginalPreheatAdvisory({
  baselinePlan,
  conservativeEnergyKwh,
  energyCapacityKwh,
  heaterPowerKw,
  maxPreheatHours,
  now,
  prices,
}: {
  baselinePlan: LiveEnergyPlanShadowResult;
  conservativeEnergyKwh: number;
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
  const displacedFutureHeatingHourIds = [...baselineSelectedHourIds]
    .filter((hourId) => Number.isFinite(Date.parse(hourId)) && Date.parse(hourId) > nowMs)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const candidatePreheatHourIds = horizon.futureTodayHourIds.filter(
    (hourId) => !baselineSelectedHourIds.has(hourId),
  );

  const retainedBaselineHeatingHourIds = [...baselineSelectedHourIds]
    .filter((hourId) => isStillActiveHour(hourId, nowMs, prices))
    .filter((hourId) => !candidatePreheatHourIds.some(
      (candidateHourId) => Date.parse(candidateHourId) < Date.parse(hourId),
    ))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const retainedBaselineHeatingEnergyKwh = round(retainedBaselineHeatingHourIds.reduce(
    (sum, hourId) => sum + retainedHeatingEnergyKwh(hourId, nowMs, heaterPowerKw, prices),
    0,
  ));

  const configuredHourCap = Math.floor(maxPreheatHours);
  const remainingSoftHeadroomKwh = Math.max(
    level.recommendedPreheatEnergyKwh - retainedBaselineHeatingEnergyKwh,
    0,
  );
  const headroomHourCap = Math.ceil(remainingSoftHeadroomKwh / heaterPowerKw);
  const maxPreheatHoursByHeadroom = Math.min(configuredHourCap, headroomHourCap);
  if (maxPreheatHoursByHeadroom <= 0) {
    return {
      available: false,
      candidatePreheatHourIds,
      displacedFutureHeatingHourIds,
      level,
      marginalCost: { available: false, pairs: [], reason: "no_preheat_candidates" },
      maxPreheatHoursByHeadroom,
      retainedBaselineHeatingEnergyKwh,
      retainedBaselineHeatingHourIds,
      reason: "preheat_not_needed",
    };
  }

  const marginalCost = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds,
    maxPreheatHours: maxPreheatHoursByHeadroom,
    preheatCandidateHourIds: candidatePreheatHourIds,
    prices,
  });

  if (!marginalCost.available) {
    return {
      available: false,
      candidatePreheatHourIds,
      displacedFutureHeatingHourIds,
      level,
      marginalCost,
      maxPreheatHoursByHeadroom,
      retainedBaselineHeatingEnergyKwh,
      retainedBaselineHeatingHourIds,
      reason: marginalCost.reason,
    };
  }

  return {
    available: true,
    candidatePreheatHourIds,
    displacedFutureHeatingHourIds,
    level,
    marginalCost,
    maxPreheatHoursByHeadroom,
    retainedBaselineHeatingEnergyKwh,
    retainedBaselineHeatingHourIds,
    reason: "recommended",
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

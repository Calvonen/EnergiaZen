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

  const configuredHourCap = Math.floor(maxPreheatHours);
  const headroomHourCap = Math.ceil(level.recommendedPreheatEnergyKwh / heaterPowerKw);
  const maxPreheatHoursByHeadroom = Math.min(configuredHourCap, headroomHourCap);
  if (maxPreheatHoursByHeadroom <= 0) {
    return unavailable("preheat_not_needed", level);
  }

  const nowMs = now.getTime();
  const baselineSelectedHourIds = new Set(baselinePlan.selectedHeatingHourIds);
  const displacedFutureHeatingHourIds = [...baselineSelectedHourIds]
    .filter((hourId) => Number.isFinite(Date.parse(hourId)) && Date.parse(hourId) > nowMs)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const candidatePreheatHourIds = horizon.futureTodayHourIds.filter(
    (hourId) => !baselineSelectedHourIds.has(hourId),
  );

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
    reason: "recommended",
  };
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
    reason,
  };
}

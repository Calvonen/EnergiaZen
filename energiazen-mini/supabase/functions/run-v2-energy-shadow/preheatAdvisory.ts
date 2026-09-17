import type { ShadowElectricityPrice } from "./planShadow.ts";
import { evaluateV2SoftPreheatLevel, type V2SoftPreheatLevel } from "./preheatLevel.ts";
import { buildV2SoftPreheatPlan, type V2SoftPreheatPlan } from "./preheatPlan.ts";
import { evaluateV2PreheatOpportunity, type V2PreheatOpportunity } from "./preheatPolicy.ts";

export type V2LivePreheatAdvisory = {
  level: V2SoftPreheatLevel;
  opportunity: V2PreheatOpportunity;
  plan: V2SoftPreheatPlan;
};

export function buildV2LivePreheatAdvisory({
  conservativeEnergyKwh,
  energyCapacityKwh,
  heaterPowerKw,
  maxPreheatHours,
  now,
  prices,
}: {
  conservativeEnergyKwh: number;
  energyCapacityKwh: number;
  heaterPowerKw: number;
  maxPreheatHours: number;
  now: Date;
  prices: ShadowElectricityPrice[];
}): V2LivePreheatAdvisory {
  const level = evaluateV2SoftPreheatLevel({
    conservativeEnergyKwh,
    energyCapacityKwh,
  });
  const opportunity = evaluateV2PreheatOpportunity({ now, prices });
  const plan = buildV2SoftPreheatPlan({
    heaterPowerKw,
    level,
    maxPreheatHours,
    opportunity,
    prices,
  });

  return { level, opportunity, plan };
}

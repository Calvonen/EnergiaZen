import {
  maxV2TargetReservePercent,
  minV2TargetReservePercent,
  recommendedV2PreheatPercent,
} from "../_shared/energyModelV2/energyReservePercent.ts";

export type V2SoftPreheatLevel = {
  available: boolean;
  currentConservativePercent: number | null;
  preheatHeadroomKwh: number | null;
  recommendedPreheatEnergyKwh: number | null;
  recommendedPreheatPercent: number;
  recommendedPreheatTargetKwh: number | null;
  reason: "available" | "invalid_energy_capacity" | "invalid_conservative_energy";
};

export { recommendedV2PreheatPercent };

export function evaluateV2SoftPreheatLevel({
  conservativeEnergyKwh,
  energyCapacityKwh,
  recommendedPreheatPercent = recommendedV2PreheatPercent,
}: {
  conservativeEnergyKwh: number;
  energyCapacityKwh: number;
  recommendedPreheatPercent?: number;
}): V2SoftPreheatLevel {
  const configuredPreheatPercent = Number.isFinite(recommendedPreheatPercent)
    ? clamp(
        recommendedPreheatPercent,
        minV2TargetReservePercent,
        maxV2TargetReservePercent,
      )
    : recommendedV2PreheatPercent;

  if (!Number.isFinite(energyCapacityKwh) || energyCapacityKwh <= 0) {
    return unavailable("invalid_energy_capacity", configuredPreheatPercent);
  }
  if (!Number.isFinite(conservativeEnergyKwh) || conservativeEnergyKwh < 0) {
    return unavailable("invalid_conservative_energy", configuredPreheatPercent);
  }

  const targetKwh = energyCapacityKwh * configuredPreheatPercent / 100;
  const currentPercent = clamp(conservativeEnergyKwh / energyCapacityKwh * 100, 0, 100);
  const headroomKwh = Math.max(targetKwh - conservativeEnergyKwh, 0);

  return {
    available: true,
    currentConservativePercent: round(currentPercent),
    preheatHeadroomKwh: round(headroomKwh),
    recommendedPreheatEnergyKwh: round(headroomKwh),
    recommendedPreheatPercent: configuredPreheatPercent,
    recommendedPreheatTargetKwh: round(targetKwh),
    reason: "available",
  };
}

function unavailable(
  reason: Exclude<V2SoftPreheatLevel["reason"], "available">,
  recommendedPreheatPercent: number,
): V2SoftPreheatLevel {
  return {
    available: false,
    currentConservativePercent: null,
    preheatHeadroomKwh: null,
    recommendedPreheatEnergyKwh: null,
    recommendedPreheatPercent,
    recommendedPreheatTargetKwh: null,
    reason,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

export type V2SoftPreheatLevel = {
  available: boolean;
  currentConservativePercent: number | null;
  preheatHeadroomKwh: number | null;
  recommendedPreheatEnergyKwh: number | null;
  recommendedPreheatPercent: number;
  recommendedPreheatTargetKwh: number | null;
  reason: "available" | "invalid_energy_capacity" | "invalid_conservative_energy";
};

export const recommendedV2PreheatPercent = 90;

export function evaluateV2SoftPreheatLevel({
  conservativeEnergyKwh,
  energyCapacityKwh,
}: {
  conservativeEnergyKwh: number;
  energyCapacityKwh: number;
}): V2SoftPreheatLevel {
  if (!Number.isFinite(energyCapacityKwh) || energyCapacityKwh <= 0) {
    return unavailable("invalid_energy_capacity");
  }
  if (!Number.isFinite(conservativeEnergyKwh) || conservativeEnergyKwh < 0) {
    return unavailable("invalid_conservative_energy");
  }

  const targetKwh = energyCapacityKwh * recommendedV2PreheatPercent / 100;
  const currentPercent = clamp(conservativeEnergyKwh / energyCapacityKwh * 100, 0, 100);
  const headroomKwh = Math.max(targetKwh - conservativeEnergyKwh, 0);

  return {
    available: true,
    currentConservativePercent: round(currentPercent),
    preheatHeadroomKwh: round(headroomKwh),
    recommendedPreheatEnergyKwh: round(headroomKwh),
    recommendedPreheatPercent: recommendedV2PreheatPercent,
    recommendedPreheatTargetKwh: round(targetKwh),
    reason: "available",
  };
}

function unavailable(
  reason: Exclude<V2SoftPreheatLevel["reason"], "available">,
): V2SoftPreheatLevel {
  return {
    available: false,
    currentConservativePercent: null,
    preheatHeadroomKwh: null,
    recommendedPreheatEnergyKwh: null,
    recommendedPreheatPercent: recommendedV2PreheatPercent,
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

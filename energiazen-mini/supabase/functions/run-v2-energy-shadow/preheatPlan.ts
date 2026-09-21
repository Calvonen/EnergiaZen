import { calculateBilledElectricityPriceCentsPerKwh } from "../_shared/heatingTariff.ts";
import type { ShadowElectricityPrice } from "./planShadow.ts";
import type { V2SoftPreheatLevel } from "./preheatLevel.ts";
import type { V2PreheatOpportunity } from "./preheatPolicy.ts";

export type V2SoftPreheatPlan = {
  available: boolean;
  expectedOvershootKwh: number | null;
  recommendedHeatingEnergyKwh: number | null;
  recommendedHeatingHourIds: string[];
  requestedPreheatEnergyKwh: number | null;
  reason:
    | "recommended"
    | "no_preheat_opportunity"
    | "preheat_level_unavailable"
    | "preheat_not_needed"
    | "invalid_heater_power"
    | "invalid_max_preheat_hours"
    | "eligible_price_data_missing";
};

export function buildV2SoftPreheatPlan({
  heaterPowerKw,
  level,
  maxPreheatHours,
  opportunity,
  prices,
}: {
  heaterPowerKw: number;
  level: V2SoftPreheatLevel;
  maxPreheatHours: number;
  opportunity: V2PreheatOpportunity;
  prices: ShadowElectricityPrice[];
}): V2SoftPreheatPlan {
  if (!level.available || level.recommendedPreheatEnergyKwh === null) {
    return unavailable("preheat_level_unavailable");
  }
  if (level.recommendedPreheatEnergyKwh <= 0) {
    return {
      available: true,
      expectedOvershootKwh: 0,
      recommendedHeatingEnergyKwh: 0,
      recommendedHeatingHourIds: [],
      requestedPreheatEnergyKwh: 0,
      reason: "preheat_not_needed",
    };
  }
  if (!opportunity.available) return unavailable("no_preheat_opportunity");
  if (!Number.isFinite(heaterPowerKw) || heaterPowerKw <= 0) {
    return unavailable("invalid_heater_power");
  }
  if (!Number.isFinite(maxPreheatHours) || maxPreheatHours < 0) {
    return unavailable("invalid_max_preheat_hours");
  }

  if (maxPreheatHours === 0) {
    return {
      available: true,
      expectedOvershootKwh: 0,
      recommendedHeatingEnergyKwh: 0,
      recommendedHeatingHourIds: [],
      requestedPreheatEnergyKwh: round(level.recommendedPreheatEnergyKwh),
      reason: "recommended",
    };
  }

  const priceById = new Map(prices.map((price) => [price.starts_at, price]));
  const eligible = opportunity.eligiblePreheatHourIds.map((id) => {
    const price = priceById.get(id);
    if (!price || !isUsablePrice(price, opportunity.resolutionMinutes)) return null;
    const billed = calculateBilledElectricityPriceCentsPerKwh(price.spot_price_cents_kwh);
    if (billed === null || !Number.isFinite(billed)) return null;
    return { billed, durationHours: price.resolution_minutes / 60, id, startsAtMs: Date.parse(price.starts_at) };
  });

  if (eligible.some((item) => item === null)) {
    return unavailable("eligible_price_data_missing");
  }

  const ordered = eligible
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => left.billed - right.billed || left.startsAtMs - right.startsAtMs);

  const selected: typeof ordered = [];
  let selectedHours = 0;
  let deliveredEnergyKwh = 0;
  for (const interval of ordered) {
    if (deliveredEnergyKwh >= level.recommendedPreheatEnergyKwh) break;
    if (selectedHours + interval.durationHours > maxPreheatHours + 1e-9) continue;
    selected.push(interval);
    selectedHours += interval.durationHours;
    deliveredEnergyKwh += heaterPowerKw * interval.durationHours;
  }

  return {
    available: true,
    expectedOvershootKwh: round(Math.max(deliveredEnergyKwh - level.recommendedPreheatEnergyKwh, 0)),
    recommendedHeatingEnergyKwh: round(deliveredEnergyKwh),
    recommendedHeatingHourIds: selected.map((item) => item.id),
    requestedPreheatEnergyKwh: round(level.recommendedPreheatEnergyKwh),
    reason: "recommended",
  };
}

function isUsablePrice(
  price: ShadowElectricityPrice,
  requiredResolution: 15 | 60 | null,
) {
  const start = Date.parse(price.starts_at);
  const end = Date.parse(price.ends_at);
  const resolution = price.resolution_minutes;
  return (
    (resolution === 15 || resolution === 60) &&
    (requiredResolution === null || resolution === requiredResolution) &&
    Number.isFinite(price.spot_price_cents_kwh) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    end - start === resolution * 60 * 1000 &&
    isUtcIntervalBoundary(start, resolution) &&
    isUtcIntervalBoundary(end, resolution)
  );
}

function isUtcIntervalBoundary(timestampMs: number, resolutionMinutes: 15 | 60) {
  const date = new Date(timestampMs);
  return (
    date.getUTCMinutes() % resolutionMinutes === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

function unavailable(reason: Exclude<V2SoftPreheatPlan["reason"], "recommended" | "preheat_not_needed">): V2SoftPreheatPlan {
  return {
    available: false,
    expectedOvershootKwh: null,
    recommendedHeatingEnergyKwh: null,
    recommendedHeatingHourIds: [],
    requestedPreheatEnergyKwh: null,
    reason,
  };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

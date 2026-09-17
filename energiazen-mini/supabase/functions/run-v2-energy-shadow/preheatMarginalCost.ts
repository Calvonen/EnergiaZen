import { calculateBilledElectricityPriceCentsPerKwh } from "../_shared/heatingTariff.ts";
import type { ShadowElectricityPrice } from "./planShadow.ts";

export type V2MarginalPreheatPair = {
  displacedFutureHourId: string;
  displacedFuturePriceCentsPerKwh: number;
  preheatHourId: string;
  preheatPriceCentsPerKwh: number;
  savingsCentsPerKwh: number;
};

export type V2MarginalPreheatCostResult = {
  available: boolean;
  pairs: V2MarginalPreheatPair[];
  reason:
    | "recommended"
    | "no_preheat_candidates"
    | "no_future_heating_to_displace"
    | "no_positive_savings"
    | "invalid_max_preheat_hours"
    | "price_data_missing";
};

export function evaluateV2MarginalPreheatCost({
  displacedFutureHeatingHourIds,
  maxPreheatHours,
  preheatCandidateHourIds,
  prices,
}: {
  displacedFutureHeatingHourIds: string[];
  maxPreheatHours: number;
  preheatCandidateHourIds: string[];
  prices: ShadowElectricityPrice[];
}): V2MarginalPreheatCostResult {
  if (!Number.isFinite(maxPreheatHours) || maxPreheatHours < 0) {
    return unavailable("invalid_max_preheat_hours");
  }

  const maxHours = Math.floor(maxPreheatHours);
  if (!preheatCandidateHourIds.length || maxHours === 0) {
    return unavailable("no_preheat_candidates");
  }
  if (!displacedFutureHeatingHourIds.length) {
    return unavailable("no_future_heating_to_displace");
  }

  const priceById = new Map(prices.map((price) => [price.starts_at, price]));
  const pricedPreheat = priceIds(preheatCandidateHourIds, priceById);
  const pricedFuture = priceIds(displacedFutureHeatingHourIds, priceById);
  if (!pricedPreheat || !pricedFuture) {
    return unavailable("price_data_missing");
  }

  const candidates = pricedPreheat
    .sort((left, right) =>
      left.billedPriceCentsPerKwh - right.billedPriceCentsPerKwh ||
      Date.parse(left.hourId) - Date.parse(right.hourId)
    )
    .slice(0, maxHours);
  const displaced = pricedFuture.sort((left, right) =>
    right.billedPriceCentsPerKwh - left.billedPriceCentsPerKwh ||
    Date.parse(left.hourId) - Date.parse(right.hourId)
  );

  const pairs: V2MarginalPreheatPair[] = [];
  const pairCount = Math.min(candidates.length, displaced.length);
  for (let index = 0; index < pairCount; index += 1) {
    const candidate = candidates[index];
    const future = displaced[index];
    if (candidate.billedPriceCentsPerKwh >= future.billedPriceCentsPerKwh) {
      continue;
    }
    pairs.push({
      displacedFutureHourId: future.hourId,
      displacedFuturePriceCentsPerKwh: round(future.billedPriceCentsPerKwh),
      preheatHourId: candidate.hourId,
      preheatPriceCentsPerKwh: round(candidate.billedPriceCentsPerKwh),
      savingsCentsPerKwh: round(
        future.billedPriceCentsPerKwh - candidate.billedPriceCentsPerKwh,
      ),
    });
  }

  if (!pairs.length) {
    return unavailable("no_positive_savings");
  }

  return { available: true, pairs, reason: "recommended" };
}

function priceIds(
  hourIds: string[],
  priceById: Map<string, ShadowElectricityPrice>,
) {
  const result: { billedPriceCentsPerKwh: number; hourId: string }[] = [];
  for (const hourId of [...new Set(hourIds)]) {
    const price = priceById.get(hourId);
    if (!price || !isUsableHourlyPrice(price)) return null;
    const billed = calculateBilledElectricityPriceCentsPerKwh(
      price.spot_price_cents_kwh,
    );
    if (billed === null) return null;
    result.push({ billedPriceCentsPerKwh: billed, hourId });
  }
  return result;
}

function isUsableHourlyPrice(price: ShadowElectricityPrice) {
  const start = Date.parse(price.starts_at);
  const end = Date.parse(price.ends_at);
  return (
    price.resolution_minutes === 60 &&
    Number.isFinite(price.spot_price_cents_kwh) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end - start === 60 * 60 * 1000 &&
    start % (60 * 60 * 1000) === 0 &&
    end % (60 * 60 * 1000) === 0
  );
}

function unavailable(
  reason: Exclude<V2MarginalPreheatCostResult["reason"], "recommended">,
): V2MarginalPreheatCostResult {
  return { available: false, pairs: [], reason };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

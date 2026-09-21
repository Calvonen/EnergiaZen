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

type PricedHour = {
  billedPriceCentsPerKwh: number;
  hourId: string;
};

type MatchingState = {
  pairs: V2MarginalPreheatPair[];
  savings: number;
};

export function marginalPairKey(preheatHourId: string, displacedFutureHourId: string) {
  return `${preheatHourId}|${displacedFutureHourId}`;
}

export function evaluateV2MarginalPreheatCost({
  displacedFutureHeatingHourIds,
  excludedPairKeys = [],
  maxPreheatHours,
  preheatCandidateHourIds,
  prices,
  requireExactPairCount = false,
  resolutionMinutes: requestedResolutionMinutes,
}: {
  displacedFutureHeatingHourIds: string[];
  excludedPairKeys?: string[];
  maxPreheatHours: number;
  preheatCandidateHourIds: string[];
  prices: ShadowElectricityPrice[];
  requireExactPairCount?: boolean;
  resolutionMinutes?: 15 | 60;
}): V2MarginalPreheatCostResult {
  if (!Number.isFinite(maxPreheatHours) || maxPreheatHours < 0) {
    return unavailable("invalid_max_preheat_hours");
  }

  const requestedIds = [...new Set([
    ...preheatCandidateHourIds,
    ...displacedFutureHeatingHourIds,
  ])];
  const matchingResolutions = ([15, 60] as const).filter((resolutionMinutes) =>
    requestedIds.every((id) =>
      prices.some((price) =>
        price.starts_at === id &&
        price.resolution_minutes === resolutionMinutes &&
        isUsableIntervalPrice(price)
      )
    )
  );
  const resolutionMinutes = requestedResolutionMinutes ??
    (matchingResolutions.length === 1 ? matchingResolutions[0] : undefined);
  if (
    (resolutionMinutes !== 15 && resolutionMinutes !== 60) ||
    !matchingResolutions.includes(resolutionMinutes)
  ) return unavailable("price_data_missing");
  const priceById = new Map(
    prices
      .filter((price) => price.resolution_minutes === resolutionMinutes)
      .map((price) => [price.starts_at, price]),
  );
  const pricedPreheat = priceIds(preheatCandidateHourIds, priceById);
  const pricedFuture = priceIds(displacedFutureHeatingHourIds, priceById);
  if (!pricedPreheat || !pricedFuture) {
    return unavailable("price_data_missing");
  }
  const maxIntervals = Math.floor(maxPreheatHours / (resolutionMinutes / 60));
  if (!preheatCandidateHourIds.length || maxIntervals === 0) {
    return unavailable("no_preheat_candidates");
  }
  if (!displacedFutureHeatingHourIds.length) {
    return unavailable("no_future_heating_to_displace");
  }

  const candidates = [...pricedPreheat].sort(
    (left, right) => Date.parse(left.hourId) - Date.parse(right.hourId),
  );
  const displaced = [...pricedFuture].sort(
    (left, right) => Date.parse(left.hourId) - Date.parse(right.hourId),
  );
  const pairs = findBestMatching(
    candidates,
    displaced,
    maxIntervals,
    new Set(excludedPairKeys),
    requireExactPairCount,
  );

  if (!pairs.length) {
    return unavailable("no_positive_savings");
  }

  return { available: true, pairs, reason: "recommended" };
}

function findBestMatching(
  candidates: PricedHour[],
  displaced: PricedHour[],
  maxHours: number,
  excludedPairKeys: Set<string>,
  requireExactPairCount: boolean,
): V2MarginalPreheatPair[] {
  const pairLimit = Math.min(maxHours, candidates.length, displaced.length);
  const dp: MatchingState[][][] = Array.from({ length: candidates.length + 1 }, () =>
    Array.from({ length: displaced.length + 1 }, () =>
      Array.from({ length: pairLimit + 1 }, () => ({ pairs: [], savings: Number.NEGATIVE_INFINITY })),
    ),
  );

  for (let candidateIndex = 0; candidateIndex <= candidates.length; candidateIndex += 1) {
    for (let futureIndex = 0; futureIndex <= displaced.length; futureIndex += 1) {
      dp[candidateIndex][futureIndex][0] = { pairs: [], savings: 0 };
    }
  }

  for (let candidateIndex = 1; candidateIndex <= candidates.length; candidateIndex += 1) {
    for (let futureIndex = 1; futureIndex <= displaced.length; futureIndex += 1) {
      const candidate = candidates[candidateIndex - 1];
      const future = displaced[futureIndex - 1];

      for (let pairCount = 1; pairCount <= pairLimit; pairCount += 1) {
        let best = betterState(
          dp[candidateIndex - 1][futureIndex][pairCount],
          dp[candidateIndex][futureIndex - 1][pairCount],
        );

        const previous = dp[candidateIndex - 1][futureIndex - 1][pairCount - 1];
        const savings = future.billedPriceCentsPerKwh - candidate.billedPriceCentsPerKwh;
        const pairKey = marginalPairKey(candidate.hourId, future.hourId);
        if (
          Number.isFinite(previous.savings) &&
          Date.parse(candidate.hourId) < Date.parse(future.hourId) &&
          savings > 0 &&
          !excludedPairKeys.has(pairKey)
        ) {
          const matched: MatchingState = {
            savings: previous.savings + savings,
            pairs: [
              ...previous.pairs,
              {
                displacedFutureHourId: future.hourId,
                displacedFuturePriceCentsPerKwh: round(future.billedPriceCentsPerKwh),
                preheatHourId: candidate.hourId,
                preheatPriceCentsPerKwh: round(candidate.billedPriceCentsPerKwh),
                savingsCentsPerKwh: round(savings),
              },
            ],
          };
          best = betterState(best, matched);
        }

        dp[candidateIndex][futureIndex][pairCount] = best;
      }
    }
  }

  if (requireExactPairCount) {
    const exact = dp[candidates.length][displaced.length][pairLimit];
    return Number.isFinite(exact.savings) && exact.pairs.length === pairLimit ? exact.pairs : [];
  }

  let bestOverall: MatchingState = { pairs: [], savings: Number.NEGATIVE_INFINITY };
  for (let pairCount = 1; pairCount <= pairLimit; pairCount += 1) {
    bestOverall = betterFinalState(
      bestOverall,
      dp[candidates.length][displaced.length][pairCount],
    );
  }
  return Number.isFinite(bestOverall.savings) ? bestOverall.pairs : [];
}

function betterState(left: MatchingState, right: MatchingState) {
  if (right.savings > left.savings) return right;
  if (right.savings < left.savings) return left;
  return comparePairs(right.pairs, left.pairs) < 0 ? right : left;
}

function betterFinalState(left: MatchingState, right: MatchingState) {
  if (right.savings > left.savings) return right;
  if (right.savings < left.savings) return left;
  if (right.pairs.length > left.pairs.length) return right;
  if (right.pairs.length < left.pairs.length) return left;
  return comparePairs(right.pairs, left.pairs) < 0 ? right : left;
}

function comparePairs(left: V2MarginalPreheatPair[], right: V2MarginalPreheatPair[]) {
  const leftKey = left.map((pair) => marginalPairKey(pair.preheatHourId, pair.displacedFutureHourId)).join(",");
  const rightKey = right.map((pair) => marginalPairKey(pair.preheatHourId, pair.displacedFutureHourId)).join(",");
  return leftKey.localeCompare(rightKey);
}

function priceIds(
  hourIds: string[],
  priceById: Map<string, ShadowElectricityPrice>,
) {
  const result: PricedHour[] = [];
  for (const hourId of [...new Set(hourIds)]) {
    const price = priceById.get(hourId);
    if (!price || !isUsableIntervalPrice(price)) return null;
    const billed = calculateBilledElectricityPriceCentsPerKwh(
      price.spot_price_cents_kwh,
    );
    if (billed === null) return null;
    result.push({ billedPriceCentsPerKwh: billed, hourId });
  }
  return result;
}

function isUsableIntervalPrice(price: ShadowElectricityPrice) {
  const start = Date.parse(price.starts_at);
  const end = Date.parse(price.ends_at);
  return (
    (price.resolution_minutes === 15 || price.resolution_minutes === 60) &&
    Number.isFinite(price.spot_price_cents_kwh) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end - start === price.resolution_minutes * 60 * 1000 &&
    start % (price.resolution_minutes * 60 * 1000) === 0 &&
    end % (price.resolution_minutes * 60 * 1000) === 0
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

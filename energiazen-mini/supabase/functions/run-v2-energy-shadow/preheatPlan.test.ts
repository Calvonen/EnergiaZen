import { buildV2SoftPreheatPlan } from "./preheatPlan";
import type { V2SoftPreheatLevel } from "./preheatLevel";
import type { V2PreheatOpportunity } from "./preheatPolicy";
import type { ShadowElectricityPrice } from "./planShadow";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function price(startsAt: string, cents: number): ShadowElectricityPrice {
  const start = Date.parse(startsAt);
  return {
    starts_at: startsAt,
    ends_at: new Date(start + 3_600_000).toISOString(),
    resolution_minutes: 60,
    spot_price_cents_kwh: cents,
  };
}

function opportunity(ids: string[]): V2PreheatOpportunity {
  return {
    available: true,
    eligiblePreheatHourIds: ids,
    reason: "recommended",
    tomorrowCheapestBilledCentsPerKwh: 25,
  };
}

function unavailableOpportunity(): V2PreheatOpportunity {
  return {
    available: false,
    eligiblePreheatHourIds: [],
    reason: "tomorrow_prices_incomplete",
    tomorrowCheapestBilledCentsPerKwh: null,
  };
}

function level(requestedKwh: number): V2SoftPreheatLevel {
  return {
    available: true,
    currentConservativePercent: 60,
    preheatHeadroomKwh: requestedKwh,
    recommendedPreheatEnergyKwh: requestedKwh,
    recommendedPreheatPercent: 90,
    recommendedPreheatTargetKwh: 15,
    reason: "available",
  };
}

export function runV2PreheatPlanUnitTests() {
  const p18 = price("2026-09-17T15:00:00.000Z", 8);
  const p19 = price("2026-09-17T16:00:00.000Z", 2);
  const p20 = price("2026-09-17T17:00:00.000Z", 5);
  const prices = [p18, p19, p20];

  const cheapestFirst = buildV2SoftPreheatPlan({
    heaterPowerKw: 3,
    level: level(4.5),
    maxPreheatHours: 4,
    opportunity: opportunity(prices.map((item) => item.starts_at)),
    prices,
  });
  assert(cheapestFirst.available, "valid preheat inputs produce a plan");
  assertEqual(cheapestFirst.recommendedHeatingHourIds.length, 2, "4.5 kWh request needs two full hourly intervals");
  assertEqual(cheapestFirst.recommendedHeatingHourIds[0], p19.starts_at, "cheapest billed interval is selected first");
  assertEqual(cheapestFirst.recommendedHeatingHourIds[1], p20.starts_at, "second-cheapest interval is selected second");
  assertEqual(cheapestFirst.recommendedHeatingEnergyKwh, 6, "two 3 kW hours deliver 6 kWh");
  assertEqual(cheapestFirst.expectedOvershootKwh, 1.5, "hourly granularity overshoot is explicit rather than hidden");

  const capped = buildV2SoftPreheatPlan({
    heaterPowerKw: 3,
    level: level(8),
    maxPreheatHours: 1,
    opportunity: opportunity(prices.map((item) => item.starts_at)),
    prices,
  });
  assertEqual(capped.recommendedHeatingHourIds.length, 1, "preheat respects configured maximum heating hours");
  assertEqual(capped.recommendedHeatingHourIds[0], p19.starts_at, "hour cap still keeps the cheapest interval");
  assertEqual(capped.recommendedHeatingEnergyKwh, 3, "hour cap limits delivered preheat energy");

  const alreadyFull = buildV2SoftPreheatPlan({
    heaterPowerKw: 3,
    level: level(0),
    maxPreheatHours: 4,
    opportunity: opportunity(prices.map((item) => item.starts_at)),
    prices,
  });
  assert(alreadyFull.available, "no preheat need is an available advisory state");
  assertEqual(alreadyFull.reason, "preheat_not_needed", "zero headroom is explicit");
  assertEqual(alreadyFull.recommendedHeatingHourIds.length, 0, "zero headroom selects no hours");

  const alreadyFullWithoutPrices = buildV2SoftPreheatPlan({
    heaterPowerKw: 3,
    level: level(0),
    maxPreheatHours: 4,
    opportunity: unavailableOpportunity(),
    prices: [],
  });
  assert(alreadyFullWithoutPrices.available, "zero headroom does not require tomorrow price availability");
  assertEqual(alreadyFullWithoutPrices.reason, "preheat_not_needed", "zero headroom wins over missing price opportunity");
  assertEqual(alreadyFullWithoutPrices.recommendedHeatingHourIds.length, 0, "zero headroom with missing prices still selects no hours");

  const noOpportunity = buildV2SoftPreheatPlan({
    heaterPowerKw: 3,
    level: level(4),
    maxPreheatHours: 4,
    opportunity: {
      available: false,
      eligiblePreheatHourIds: [],
      reason: "no_cheaper_preheat_interval",
      tomorrowCheapestBilledCentsPerKwh: 10,
    },
    prices,
  });
  assert(!noOpportunity.available, "missing economic opportunity fails closed when preheat energy is requested");
  assertEqual(noOpportunity.reason, "no_preheat_opportunity", "missing opportunity has explicit reason");

  const missingPrice = buildV2SoftPreheatPlan({
    heaterPowerKw: 3,
    level: level(3),
    maxPreheatHours: 4,
    opportunity: opportunity(["2026-09-17T18:00:00.000Z"]),
    prices,
  });
  assert(!missingPrice.available, "eligible IDs without matching price data fail closed");
  assertEqual(missingPrice.reason, "eligible_price_data_missing", "missing eligible price is explicit");

  const malformedEnd = {
    ...p18,
    ends_at: "not-a-date",
  };
  const malformedEndPlan = buildV2SoftPreheatPlan({
    heaterPowerKw: 3,
    level: level(3),
    maxPreheatHours: 4,
    opportunity: opportunity([malformedEnd.starts_at]),
    prices: [malformedEnd],
  });
  assert(!malformedEndPlan.available, "malformed eligible end timestamp fails closed");
  assertEqual(malformedEndPlan.reason, "eligible_price_data_missing", "malformed end timestamp is rejected explicitly");

  const wrongDuration = {
    ...p19,
    ends_at: new Date(Date.parse(p19.starts_at) + 90 * 60_000).toISOString(),
  };
  const wrongDurationPlan = buildV2SoftPreheatPlan({
    heaterPowerKw: 3,
    level: level(3),
    maxPreheatHours: 4,
    opportunity: opportunity([wrongDuration.starts_at]),
    prices: [wrongDuration],
  });
  assert(!wrongDurationPlan.available, "non-hour eligible interval fails closed");
  assertEqual(wrongDurationPlan.reason, "eligible_price_data_missing", "wrong interval duration is rejected explicitly");
}

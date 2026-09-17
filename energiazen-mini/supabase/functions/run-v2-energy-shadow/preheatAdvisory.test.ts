import { buildV2LivePreheatAdvisory } from "./preheatAdvisory";
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

function completeTomorrow(startUtc: string, defaultCents: number) {
  const start = Date.parse(startUtc);
  return Array.from({ length: 24 }, (_, index) =>
    price(new Date(start + index * 3_600_000).toISOString(), defaultCents + index / 100),
  );
}

export function runV2PreheatAdvisoryUnitTests() {
  const now = new Date("2026-09-17T12:15:00.000Z");
  const todayCheapA = price("2026-09-17T13:00:00.000Z", 2);
  const todayCheapB = price("2026-09-17T14:00:00.000Z", 3);
  const tomorrow = completeTomorrow("2026-09-17T21:00:00.000Z", 10);
  const prices = [todayCheapA, todayCheapB, ...tomorrow];

  const advisory = buildV2LivePreheatAdvisory({
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(advisory.opportunity.available, "complete tomorrow prices expose an economic opportunity");
  assertEqual(advisory.level.recommendedPreheatEnergyKwh, 6, "60% reserve has 6 kWh headroom to the 90% recommendation");
  assert(advisory.plan.available, "valid live advisory produces an advisory plan");
  assertEqual(advisory.plan.recommendedHeatingHourIds.length, 2, "6 kWh advisory selects two 3 kW full hours");
  assertEqual(advisory.plan.recommendedHeatingHourIds[0], todayCheapA.starts_at, "cheapest eligible hour is selected first");
  assertEqual(advisory.plan.recommendedHeatingHourIds[1], todayCheapB.starts_at, "second eligible hour is selected second");

  const incompleteTomorrow = buildV2LivePreheatAdvisory({
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices: [todayCheapA, todayCheapB, ...tomorrow.slice(0, 23)],
  });
  assert(!incompleteTomorrow.opportunity.available, "incomplete tomorrow horizon disables proactive preheat");
  assertEqual(incompleteTomorrow.opportunity.reason, "tomorrow_prices_incomplete", "incomplete horizon has an explicit reason");
  assert(!incompleteTomorrow.plan.available, "positive headroom cannot preheat without a complete tomorrow horizon");
  assertEqual(incompleteTomorrow.plan.reason, "no_preheat_opportunity", "missing complete horizon fails closed");

  const alreadyAtRecommendation = buildV2LivePreheatAdvisory({
    conservativeEnergyKwh: 18.5,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices: [],
  });
  assert(alreadyAtRecommendation.plan.available, "zero headroom remains a valid no-op without price data");
  assertEqual(alreadyAtRecommendation.plan.reason, "preheat_not_needed", "90%+ reserve requires no proactive heat");
  assertEqual(alreadyAtRecommendation.plan.recommendedHeatingHourIds.length, 0, "no-op advisory selects no hours");

  const invalidThermalState = buildV2LivePreheatAdvisory({
    conservativeEnergyKwh: 12,
    energyCapacityKwh: Number.NaN,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(!invalidThermalState.level.available, "invalid energy capacity makes the preheat level unavailable");
  assert(!invalidThermalState.plan.available, "invalid level fails closed at plan composition");
  assertEqual(invalidThermalState.plan.reason, "preheat_level_unavailable", "invalid thermal state has an explicit plan reason");
}

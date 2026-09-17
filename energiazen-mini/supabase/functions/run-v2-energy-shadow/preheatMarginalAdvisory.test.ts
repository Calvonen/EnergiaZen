import type { LiveEnergyPlanShadowResult, ShadowElectricityPrice } from "./planShadow.ts";
import { buildV2MarginalPreheatAdvisory } from "./preheatMarginalAdvisory.ts";

function hourly(start: string, spot: number): ShadowElectricityPrice {
  const startMs = Date.parse(start);
  return {
    starts_at: start,
    ends_at: new Date(startMs + 60 * 60 * 1000).toISOString(),
    spot_price_cents_kwh: spot,
    resolution_minutes: 60,
  };
}

function completeTomorrow(startIso = "2026-09-17T21:00:00.000Z", spot = 10) {
  const start = Date.parse(startIso);
  return Array.from({ length: 24 }, (_, index) =>
    hourly(new Date(start + index * 3_600_000).toISOString(), spot + index / 100),
  );
}

function baseline(selectedHeatingHourIds: string[], valid = true): LiveEnergyPlanShadowResult {
  return {
    available: true,
    assumption: "standing_loss_only_no_future_draws",
    candidateCount: 0,
    evaluatedCombinationCount: 0,
    firstSafetyViolationAt: null,
    firstTargetMissAt: null,
    forecastHorizonEndAt: "2026-09-18T21:00:00.000Z",
    finalConservativeEnergyKwh: 10,
    minimumConservativeEnergyKwh: 8,
    reason: null,
    selectedHeatingEnergyKwh: selectedHeatingHourIds.length * 3,
    selectedHeatingHourIds,
    standingLossKwhPerHour: 0.1,
    totalCostCents: 0,
    valid,
  };
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

export function runV2MarginalPreheatAdvisoryUnitTests() {
  const now = new Date("2026-09-17T12:15:00.000Z");
  const tomorrow = completeTomorrow();
  const prices = [
    hourly("2026-09-17T13:00:00.000Z", 2),
    hourly("2026-09-17T14:00:00.000Z", 3),
    ...tomorrow,
  ];

  const recommended = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([
      "2026-09-17T22:00:00.000Z",
      "2026-09-17T23:00:00.000Z",
    ]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(recommended.available && recommended.reason === "recommended", "expected marginal preheat recommendation");
  assert(recommended.maxPreheatHoursByHeadroom === 2, "expected 6 kWh soft headroom to cap preheat at two hours");
  assert(recommended.marginalCost.pairs.length === 2, "expected two displaced future heating hours");
  assert(
    recommended.marginalCost.pairs.every((pair) =>
      Date.parse(pair.preheatHourId) < Date.parse(pair.displacedFutureHourId)
    ),
    "expected every advisory pair to preserve temporal order",
  );

  const baselineAlreadyUsesCheapToday = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([
      "2026-09-17T13:00:00.000Z",
      "2026-09-17T22:00:00.000Z",
    ]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(
    !baselineAlreadyUsesCheapToday.candidatePreheatHourIds.includes("2026-09-17T13:00:00.000Z"),
    "expected baseline-selected remaining-today heat to be excluded from additive preheat candidates",
  );
  assert(
    baselineAlreadyUsesCheapToday.marginalCost.pairs.every(
      (pair) => pair.preheatHourId !== "2026-09-17T13:00:00.000Z",
    ),
    "expected advisory never to reuse a baseline-selected heating hour as preheat",
  );

  const retainedBaselinePrices = [
    hourly("2026-09-17T13:00:00.000Z", 1),
    hourly("2026-09-17T14:00:00.000Z", 2),
    hourly("2026-09-17T15:00:00.000Z", 3),
    ...tomorrow,
  ];
  const retainedBaseline = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([
      "2026-09-17T13:00:00.000Z",
      "2026-09-17T22:00:00.000Z",
      "2026-09-17T23:00:00.000Z",
    ]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices: retainedBaselinePrices,
  });
  assert(
    retainedBaseline.retainedBaselineHeatingHourIds.length === 1 &&
      retainedBaseline.retainedBaselineHeatingHourIds[0] === "2026-09-17T13:00:00.000Z",
    "expected the earlier baseline hour to be retained because no candidate can precede it",
  );
  assert(
    retainedBaseline.retainedBaselineHeatingEnergyKwh === 3,
    "expected retained baseline hour to consume 3 kWh of soft headroom",
  );
  assert(
    retainedBaseline.maxPreheatHoursByHeadroom === 1,
    "expected retained baseline heat to reduce two-hour soft headroom to one additive preheat hour",
  );
  assert(
    retainedBaseline.marginalCost.pairs.length === 1,
    "expected at most one displacement pair after retained baseline headroom is reserved",
  );

  const incompleteTomorrow = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline(["2026-09-17T22:00:00.000Z"]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices: [hourly("2026-09-17T13:00:00.000Z", 2), ...tomorrow.slice(0, 23)],
  });
  assert(
    !incompleteTomorrow.available && incompleteTomorrow.reason === "tomorrow_prices_incomplete",
    "expected incomplete tomorrow prices to disable proactive preheat",
  );

  const noFutureHeat = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(
    !noFutureHeat.available && noFutureHeat.reason === "no_future_heating_to_displace",
    "expected no speculative preheat without baseline future heating",
  );

  const oneHourHeadroom = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([
      "2026-09-17T22:00:00.000Z",
      "2026-09-17T23:00:00.000Z",
    ]),
    conservativeEnergyKwh: 17,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(oneHourHeadroom.maxPreheatHoursByHeadroom === 1, "expected sub-3 kWh headroom to allow at most one full-hour preheat");
  assert(oneHourHeadroom.marginalCost.pairs.length === 1, "expected one whole-hour pair under soft headroom cap");

  const expensiveTodayPrices = [
    hourly("2026-09-17T13:00:00.000Z", 20),
    hourly("2026-09-17T14:00:00.000Z", 21),
    ...completeTomorrow("2026-09-17T21:00:00.000Z", 1),
  ];
  const cheaperTomorrow = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline(["2026-09-17T22:00:00.000Z"]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices: expensiveTodayPrices,
  });
  assert(
    !cheaperTomorrow.available && cheaperTomorrow.reason === "no_positive_savings",
    "expected expensive today preheat to defer to cheaper future heating",
  );

  const invalidBaseline = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline(["2026-09-17T22:00:00.000Z"], false),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(!invalidBaseline.available && invalidBaseline.reason === "baseline_plan_invalid", "expected invalid safety baseline to fail closed");
}

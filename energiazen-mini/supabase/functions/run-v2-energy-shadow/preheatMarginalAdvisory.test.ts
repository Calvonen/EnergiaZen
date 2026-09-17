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
    "expected the earlier baseline hour to remain reserved after matching",
  );
  assert(retainedBaseline.retainedBaselineHeatingEnergyKwh === 3, "expected retained baseline hour to consume 3 kWh of headroom");
  assert(retainedBaseline.maxPreheatHoursByHeadroom === 1, "expected retained baseline heat to reduce additive preheat to one hour");
  assert(retainedBaseline.marginalCost.pairs.length === 1, "expected one safe displacement pair after retained heat is accounted for");

  const unmatchedBaselinePrices = [
    hourly("2026-09-17T13:00:00.000Z", 1),
    hourly("2026-09-17T14:00:00.000Z", 0),
    hourly("2026-09-17T15:00:00.000Z", 2),
    hourly("2026-09-17T22:00:00.000Z", 20),
    hourly("2026-09-17T23:00:00.000Z", 21),
    ...tomorrow.filter((price) => !["2026-09-17T22:00:00.000Z", "2026-09-17T23:00:00.000Z"].includes(price.starts_at)),
  ];
  const unmatchedBaseline = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([
      "2026-09-17T14:00:00.000Z",
      "2026-09-17T22:00:00.000Z",
      "2026-09-17T23:00:00.000Z",
    ]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices: unmatchedBaselinePrices,
  });
  assert(unmatchedBaseline.available, "expected a reduced but still valid advisory when a cheap baseline hour is left unmatched");
  assert(unmatchedBaseline.marginalCost.pairs.length === 1, "expected matcher cap to shrink after actual unmatched baseline heat is known");
  assert(
    unmatchedBaseline.retainedBaselineHeatingHourIds.includes("2026-09-17T14:00:00.000Z"),
    "expected cheap baseline hour left unmatched by the chosen pair to reserve headroom",
  );

  const retainedAfterPreheat = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([
      "2026-09-17T14:00:00.000Z",
      "2026-09-17T22:00:00.000Z",
    ]),
    conservativeEnergyKwh: 15,
    constraints: {
      forbiddenHeatingHourIds: [],
      requiredHeatingHourIds: ["2026-09-17T14:00:00.000Z"],
    },
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(
    !retainedAfterPreheat.available && retainedAfterPreheat.reason === "insufficient_whole_hour_headroom",
    "expected required retained baseline heat after preheat but before displacement to consume headroom",
  );
  assert(
    !retainedAfterPreheat.displacedFutureHeatingHourIds.includes("2026-09-17T14:00:00.000Z"),
    "expected required heating hour to be excluded from displacement targets",
  );
  assert(
    retainedAfterPreheat.marginalCost.pairs.every(
      (pair) => pair.displacedFutureHourId !== "2026-09-17T14:00:00.000Z",
    ),
    "expected required heating hour never to be reported as displaced",
  );

  const tinySoftHeadroom = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline(["2026-09-17T22:00:00.000Z"]),
    conservativeEnergyKwh: 15,
    energyCapacityKwh: 16.864,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(
    !tinySoftHeadroom.available && tinySoftHeadroom.reason === "insufficient_whole_hour_headroom",
    "expected sub-hour soft/physical headroom to reject a whole-hour preheat interval",
  );
  assert(tinySoftHeadroom.maxPreheatHoursByHeadroom === 0, "expected no whole-hour capacity when less than 3 kWh fits");

  const forbiddenCandidate = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline(["2026-09-17T22:00:00.000Z"]),
    conservativeEnergyKwh: 12,
    constraints: {
      forbiddenHeatingHourIds: ["2026-09-17T13:00:00.000Z"],
      requiredHeatingHourIds: [],
    },
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(
    !forbiddenCandidate.candidatePreheatHourIds.includes("2026-09-17T13:00:00.000Z"),
    "expected production-forbidden cooldown hour to be excluded from preheat candidates",
  );
  assert(
    forbiddenCandidate.marginalCost.pairs.every((pair) => pair.preheatHourId !== "2026-09-17T13:00:00.000Z"),
    "expected forbidden hour never to appear in a marginal preheat pair",
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
    conservativeEnergyKwh: 15,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
  });
  assert(oneHourHeadroom.maxPreheatHoursByHeadroom === 1, "expected exactly one whole heater-hour to fit in 3 kWh soft headroom");
  assert(oneHourHeadroom.marginalCost.pairs.length === 1, "expected one whole-hour pair under exact headroom cap");

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

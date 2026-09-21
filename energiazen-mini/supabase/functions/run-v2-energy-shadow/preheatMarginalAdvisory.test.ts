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
    learnedDropProfileUsed: false,
    learnedDropProfileDate: null,
    learnedDropProfileAgeDays: null,
    maximumModeledLossKwhPerHour: 0.1,
  };
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

export function runV2MarginalPreheatAdvisoryUnitTests() {
  const now = new Date("2026-09-17T12:15:00.000Z");
  const tomorrow = completeTomorrow();
  const prices = [
    hourly("2026-09-17T12:00:00.000Z", 30),
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
    remainingEnergyKwh: 12,
  });
  assert(recommended.available && recommended.reason === "recommended", "expected marginal preheat recommendation");
  assert(recommended.strategy === "marginal_displacement", "expected baseline displacement to remain the primary strategy");
  assert(recommended.maxPreheatHoursByHeadroom === 2, "expected 6 kWh soft headroom to cap preheat at two hours");
  assert(recommended.marginalCost.pairs.length === 2, "expected two displaced future heating hours");
  assert(recommended.recommendedPreheatHourIds.length === 2, "expected explicit recommended preheat hour telemetry");
  assert(
    recommended.marginalCost.pairs.every((pair) =>
      Date.parse(pair.preheatHourId) < Date.parse(pair.displacedFutureHourId)
    ),
    "expected every advisory pair to preserve temporal order",
  );

  const nominalPhysicalHeadroom = buildV2MarginalPreheatAdvisory({
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
    remainingEnergyKwh: 19,
  });
  assert(
    !nominalPhysicalHeadroom.available && nominalPhysicalHeadroom.reason === "insufficient_whole_hour_headroom",
    "expected nominal stored energy to cap physical headroom even when conservative energy is much lower",
  );
  assert(
    nominalPhysicalHeadroom.maxPreheatHoursByHeadroom === 0,
    "expected only 1 kWh nominal physical headroom to reject a 3 kWh whole-hour preheat interval",
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
    remainingEnergyKwh: 12,
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
    hourly("2026-09-17T12:00:00.000Z", 30),
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
    remainingEnergyKwh: 12,
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
    hourly("2026-09-17T12:00:00.000Z", 30),
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
    remainingEnergyKwh: 12,
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
    remainingEnergyKwh: 15,
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
    remainingEnergyKwh: 15,
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
    remainingEnergyKwh: 12,
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
    prices: [hourly("2026-09-17T12:00:00.000Z", 30), hourly("2026-09-17T13:00:00.000Z", 2), ...tomorrow.slice(0, 23)],
    remainingEnergyKwh: 12,
  });
  assert(
    !incompleteTomorrow.available && incompleteTomorrow.reason === "tomorrow_prices_incomplete",
    "expected incomplete tomorrow prices to disable proactive preheat",
  );

  const midnightNow = new Date("2026-09-18T21:34:00.000Z"); // 00:34 Helsinki on Sep 19
  const remainingTodayAfterMidnight = Array.from({ length: 23 }, (_, index) => {
    const startsAt = new Date(Date.parse("2026-09-18T22:00:00.000Z") + index * 3_600_000).toISOString();
    const cheapMidday = ["2026-09-19T09:00:00.000Z", "2026-09-19T10:00:00.000Z", "2026-09-19T11:00:00.000Z"];
    return hourly(startsAt, cheapMidday.includes(startsAt) ? cheapMidday.indexOf(startsAt) + 1 : 30);
  });
  const midnightSoftFill = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([]),
    conservativeEnergyKwh: 10.909,
    energyCapacityKwh: 17.605,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now: midnightNow,
    prices: remainingTodayAfterMidnight,
    recommendedPreheatPercent: 80,
    remainingEnergyKwh: 11.159,
    evaluateHourSelection: (selectedHourIds) => {
      const priceById = new Map(
        remainingTodayAfterMidnight.map((price) => [price.starts_at, price.spot_price_cents_kwh]),
      );
      return {
        ...baseline(selectedHourIds),
        finalConservativeEnergyKwh: 10.909 + selectedHourIds.length * 1.1,
        totalCostCents: selectedHourIds.reduce((sum, hourId) => sum + (priceById.get(hourId) ?? 0), 0),
      };
    },
  });
  assert(
    !midnightSoftFill.available && midnightSoftFill.reason === "no_future_heating_to_displace",
    "expected a soft target not to create heating when the safety baseline needs no future heat",
  );

  const incompleteTomorrowWithBaseline = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline(["2026-09-19T22:00:00.000Z"]),
    conservativeEnergyKwh: 10.909,
    energyCapacityKwh: 17.605,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now: midnightNow,
    prices: [
      ...remainingTodayAfterMidnight,
      hourly("2026-09-19T21:00:00.000Z", 1),
      hourly("2026-09-19T22:00:00.000Z", 2),
    ],
    recommendedPreheatPercent: 80,
    remainingEnergyKwh: 11.159,
    evaluateHourSelection: (selectedHourIds) => baseline(selectedHourIds),
  });
  assert(
    !incompleteTomorrowWithBaseline.available &&
      incompleteTomorrowWithBaseline.reason === "tomorrow_prices_incomplete",
    "expected incomplete next-day prices to remain fail-closed when a baseline future hour could be displaced",
  );
  assert(
    midnightSoftFill.recommendedPreheatHourIds.length === 0,
    "expected no standalone soft-fill hours after date rollover",
  );

  const todayStartUtc = Date.parse("2026-09-16T21:00:00.000Z");
  const completeTodayForTolerance = Array.from({ length: 24 }, (_, index) => {
    const startsAt = new Date(todayStartUtc + index * 3_600_000).toISOString();
    const spot =
      index === 2 ? 1.8 :
      startsAt === "2026-09-17T13:00:00.000Z" ? 2.0 :
      startsAt === "2026-09-17T14:00:00.000Z" ? 2.6 :
      10;
    return hourly(startsAt, spot);
  });
  const toleranceFuturePrices = [
    hourly("2026-09-17T12:00:00.000Z", 30),
    hourly("2026-09-17T13:00:00.000Z", 2.0),
    hourly("2026-09-17T14:00:00.000Z", 2.6),
    ...completeTomorrow("2026-09-17T21:00:00.000Z", 20),
  ];
  const tolerancePriceById = new Map(
    toleranceFuturePrices.map((price) => [price.starts_at, price.spot_price_cents_kwh]),
  );
  const evaluateToleranceSelection = (selectedHourIds: string[]) => ({
    ...baseline(selectedHourIds),
    finalConservativeEnergyKwh: selectedHourIds.length ? 18.5 : 12,
    totalCostCents: selectedHourIds.reduce(
      (sum, hourId) => sum + (tolerancePriceById.get(hourId) ?? 0),
      0,
    ),
  });

  const zeroToleranceSoftFill = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 1,
    now,
    prices: toleranceFuturePrices,
    priceReferencePrices: [
      ...completeTodayForTolerance,
      ...completeTomorrow("2026-09-17T21:00:00.000Z", 20),
    ],
    priceToleranceCents: 0,
    recommendedPreheatPercent: 90,
    remainingEnergyKwh: 12,
    evaluateHourSelection: evaluateToleranceSelection,
  });
  assert(
    !zeroToleranceSoftFill.available &&
      zeroToleranceSoftFill.reason === "no_future_heating_to_displace",
    "expected price ranking not to manufacture demand without baseline future heat",
  );

  const oneCentToleranceSoftFill = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 1,
    now,
    prices: toleranceFuturePrices,
    priceReferencePrices: [
      ...completeTodayForTolerance,
      ...completeTomorrow("2026-09-17T21:00:00.000Z", 20),
    ],
    priceToleranceCents: 1,
    recommendedPreheatPercent: 90,
    remainingEnergyKwh: 12,
    evaluateHourSelection: evaluateToleranceSelection,
  });
  assert(
    !oneCentToleranceSoftFill.available &&
      oneCentToleranceSoftFill.reason === "no_future_heating_to_displace",
    "expected tolerance not to manufacture demand without baseline future heat",
  );
  assert(
    oneCentToleranceSoftFill.strategy === null,
    "expected no standalone horizon soft-fill strategy",
  );

  const laterScheduleTiePrices = [
    hourly("2026-09-17T12:00:00.000Z", 30),
    hourly("2026-09-17T13:00:00.000Z", 2.0),
    hourly("2026-09-17T14:00:00.000Z", 2.0),
    hourly("2026-09-17T15:00:00.000Z", 2.0),
    hourly("2026-09-17T18:00:00.000Z", 2.0),
    ...completeTomorrow("2026-09-17T21:00:00.000Z", 20),
  ];
  const laterSchedulePriceById = new Map(
    laterScheduleTiePrices.map((price) => [price.starts_at, price.spot_price_cents_kwh]),
  );
  const laterScheduleTie = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 2,
    now,
    prices: laterScheduleTiePrices,
    priceReferencePrices: [
      ...completeTodayForTolerance,
      ...completeTomorrow("2026-09-17T21:00:00.000Z", 20),
    ],
    priceToleranceCents: 1,
    recommendedPreheatPercent: 90,
    remainingEnergyKwh: 12,
    evaluateHourSelection: (selectedHourIds) => ({
      ...baseline(selectedHourIds),
      finalConservativeEnergyKwh: selectedHourIds.length >= 2 ? 18.5 : 14,
      totalCostCents: selectedHourIds.reduce(
        (sum, hourId) => sum + (laterSchedulePriceById.get(hourId) ?? 0),
        0,
      ),
    }),
  });
  assert(
    laterScheduleTie.recommendedPreheatHourIds.length === 0 &&
      laterScheduleTie.reason === "no_future_heating_to_displace",
    "expected tie-breaking to stay irrelevant when no future baseline heat exists",
  );

  const noFutureHeat = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
    remainingEnergyKwh: 12,
  });
  assert(
    !noFutureHeat.available && noFutureHeat.reason === "no_future_heating_to_displace",
    "expected soft target alone not to create heating even when today is cheaper",
  );
  assert(noFutureHeat.strategy === null, "expected standalone soft fill to stay disabled");
  assert(
    noFutureHeat.recommendedPreheatHourIds.length === 0,
    "expected no heating hours when there is no future baseline heat to displace",
  );
  assert(
    noFutureHeat.marginalCost.reason === "no_future_heating_to_displace",
    "expected soft fill telemetry to keep marginal displacement unavailable rather than inventing a fake pair",
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
    remainingEnergyKwh: 15,
  });
  assert(oneHourHeadroom.maxPreheatHoursByHeadroom === 1, "expected exactly one whole heater-hour to fit in 3 kWh soft headroom");
  assert(oneHourHeadroom.marginalCost.pairs.length === 1, "expected one whole-hour pair under exact headroom cap");

  const expensiveTodayPrices = [
    hourly("2026-09-17T12:00:00.000Z", 30),
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
    remainingEnergyKwh: 12,
  });
  assert(
    !cheaperTomorrow.available && cheaperTomorrow.reason === "no_positive_savings",
    "expected expensive today preheat to defer to cheaper future heating",
  );

  const noBaselineAndCheaperTomorrow = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices: expensiveTodayPrices,
    remainingEnergyKwh: 12,
  });
  assert(
    !noBaselineAndCheaperTomorrow.available && noBaselineAndCheaperTomorrow.reason === "no_future_heating_to_displace",
    "expected no baseline future heat to keep standalone soft fill disabled regardless of price spread",
  );
  assert(noBaselineAndCheaperTomorrow.recommendedPreheatHourIds.length === 0, "expected no standalone fill hours when there is no economic advantage");


  const longTodayStart = Date.parse("2026-09-17T01:00:00.000Z");
  const longHorizonPrices = [
    ...Array.from({ length: 20 }, (_, index) =>
      hourly(new Date(longTodayStart + index * 3_600_000).toISOString(), 5 + index / 10),
    ),
    ...completeTomorrow("2026-09-17T21:00:00.000Z", 1),
  ];
  let boundedEvaluations = 0;
  const boundedSearch = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now: new Date("2026-09-17T00:15:00.000Z"),
    prices: longHorizonPrices,
    remainingEnergyKwh: 12,
    evaluateHourSelection: (selectedHourIds) => {
      boundedEvaluations += 1;
      return {
        ...baseline(selectedHourIds),
        finalConservativeEnergyKwh: 12 + selectedHourIds.length,
        totalCostCents: selectedHourIds.length,
      };
    },
  });
  assert(
    !boundedSearch.available && boundedSearch.reason === "no_future_heating_to_displace",
    "expected unreachable soft target not to trigger standalone heating",
  );
  assert(
    boundedEvaluations === 0,
    `expected no forecast search without future baseline heat, got ${boundedEvaluations}`,
  );
  assert(
    boundedSearch.recommendedPreheatHourIds.length === 0,
    "expected unreachable soft target to add no heating hours",
  );


  let baselineOnlyEvaluations = 0;
  const requiredBaselineAlreadyReachesTarget = buildV2MarginalPreheatAdvisory({
    baselinePlan: {
      ...baseline(["2026-09-17T13:00:00.000Z"]),
      finalConservativeEnergyKwh: 18.5,
    },
    conservativeEnergyKwh: 12,
    constraints: {
      forbiddenHeatingHourIds: [],
      requiredHeatingHourIds: ["2026-09-17T13:00:00.000Z"],
    },
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
    remainingEnergyKwh: 12,
    evaluateHourSelection: (selectedHourIds) => {
      baselineOnlyEvaluations += 1;
      return {
        ...baseline(selectedHourIds),
        finalConservativeEnergyKwh: 18.5,
      };
    },
  });
  assert(
    !requiredBaselineAlreadyReachesTarget.available &&
      requiredBaselineAlreadyReachesTarget.reason === "preheat_not_needed",
    "expected required baseline heat that already reaches the soft target to suppress additive soft fill",
  );
  assert(
    baselineOnlyEvaluations === 0,
    "expected baseline target check to avoid any additive forecast search",
  );

  const lateEveningNow = new Date("2026-09-17T20:30:00.000Z");
  let tomorrowOnlyEvaluations = 0;
  const tomorrowOnlySoftFill = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline([]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now: lateEveningNow,
    prices: [hourly("2026-09-17T20:00:00.000Z", 30), ...completeTomorrow("2026-09-17T21:00:00.000Z", 1)],
    remainingEnergyKwh: 12,
    evaluateHourSelection: (selectedHourIds) => {
      tomorrowOnlyEvaluations += 1;
      return {
        ...baseline(selectedHourIds),
        finalConservativeEnergyKwh: 12 + selectedHourIds.length * 3,
        totalCostCents: selectedHourIds.length,
      };
    },
  });
  assert(
    !tomorrowOnlySoftFill.available &&
      tomorrowOnlySoftFill.reason === "no_future_heating_to_displace",
    "expected complete tomorrow prices not to create demand by themselves",
  );
  assert(
    tomorrowOnlySoftFill.recommendedPreheatHourIds.length === 0,
    "expected tomorrow-only soft target to add no heating hours",
  );
  assert(
    tomorrowOnlyEvaluations === 0,
    "expected no tomorrow-only forecast search without baseline demand",
  );

  const invalidBaseline = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline(["2026-09-17T22:00:00.000Z"], false),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 4,
    now,
    prices,
    remainingEnergyKwh: 12,
  });
  assert(!invalidBaseline.available && invalidBaseline.reason === "baseline_plan_invalid", "expected invalid safety baseline to fail closed");
}

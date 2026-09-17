import { evaluateV2MarginalPreheatCost } from "./preheatMarginalCost.ts";
import type { ShadowElectricityPrice } from "./planShadow.ts";

function hourly(start: string, spot: number): ShadowElectricityPrice {
  const startMs = Date.parse(start);
  return {
    starts_at: start,
    ends_at: new Date(startMs + 60 * 60 * 1000).toISOString(),
    spot_price_cents_kwh: spot,
    resolution_minutes: 60,
  };
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

export function runV2MarginalPreheatCostUnitTests() {
  const prices = [
    hourly("2026-09-17T17:00:00.000Z", 1),
    hourly("2026-09-17T18:00:00.000Z", 3),
    hourly("2026-09-17T22:00:00.000Z", 8),
    hourly("2026-09-17T23:00:00.000Z", 12),
  ];

  const result = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds: [
      "2026-09-17T22:00:00.000Z",
      "2026-09-17T23:00:00.000Z",
    ],
    maxPreheatHours: 2,
    preheatCandidateHourIds: [
      "2026-09-17T18:00:00.000Z",
      "2026-09-17T17:00:00.000Z",
    ],
    prices,
  });
  assert(result.available, "expected marginal preheat recommendation");
  assert(result.pairs.length === 2, "expected two profitable displacement pairs");
  assert(
    result.pairs.every((pair) => Date.parse(pair.preheatHourId) < Date.parse(pair.displacedFutureHourId)),
    "expected every recommended preheat interval to precede displaced heating",
  );
  assert(
    result.pairs.reduce((sum, pair) => sum + pair.savingsCentsPerKwh, 0) === 16,
    "expected globally optimal aggregate savings",
  );

  const capped = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds: [
      "2026-09-17T22:00:00.000Z",
      "2026-09-17T23:00:00.000Z",
    ],
    maxPreheatHours: 1,
    preheatCandidateHourIds: [
      "2026-09-17T17:00:00.000Z",
      "2026-09-17T18:00:00.000Z",
    ],
    prices,
  });
  assert(capped.pairs.length === 1, "expected max preheat hour cap to limit pairing");
  assert(capped.pairs[0].savingsCentsPerKwh === 11, "expected best one-hour savings under cap");

  const noSavings = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds: ["2026-09-17T17:00:00.000Z"],
    maxPreheatHours: 1,
    preheatCandidateHourIds: ["2026-09-17T23:00:00.000Z"],
    prices,
  });
  assert(!noSavings.available && noSavings.reason === "no_positive_savings", "expected expensive preheat to be rejected");

  const temporalOrderPrices = [
    hourly("2026-09-17T17:00:00.000Z", 20),
    hourly("2026-09-17T23:00:00.000Z", 0),
  ];
  const impossibleLatePreheat = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds: ["2026-09-17T17:00:00.000Z"],
    maxPreheatHours: 1,
    preheatCandidateHourIds: ["2026-09-17T23:00:00.000Z"],
    prices: temporalOrderPrices,
  });
  assert(
    !impossibleLatePreheat.available && impossibleLatePreheat.reason === "no_positive_savings",
    "expected cheaper but later preheat to be rejected as temporally impossible",
  );

  const globallyOptimalPrices = [
    hourly("2026-09-17T16:00:00.000Z", 0),
    hourly("2026-09-17T17:00:00.000Z", 9),
    hourly("2026-09-17T18:00:00.000Z", 2),
    hourly("2026-09-17T19:00:00.000Z", 10),
  ];
  const globallyOptimal = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds: [
      "2026-09-17T17:00:00.000Z",
      "2026-09-17T19:00:00.000Z",
    ],
    maxPreheatHours: 2,
    preheatCandidateHourIds: [
      "2026-09-17T16:00:00.000Z",
      "2026-09-17T18:00:00.000Z",
    ],
    prices: globallyOptimalPrices,
  });
  assert(globallyOptimal.available, "expected globally feasible recommendation");
  assert(globallyOptimal.pairs.length === 2, "expected matching to preserve two feasible pairs");
  assert(
    globallyOptimal.pairs.reduce((sum, pair) => sum + pair.savingsCentsPerKwh, 0) === 17,
    "expected global matching to beat greedy 16->19 choice",
  );
  assert(
    globallyOptimal.pairs.some((pair) =>
      pair.preheatHourId === "2026-09-17T16:00:00.000Z" &&
      pair.displacedFutureHourId === "2026-09-17T17:00:00.000Z"
    ) && globallyOptimal.pairs.some((pair) =>
      pair.preheatHourId === "2026-09-17T18:00:00.000Z" &&
      pair.displacedFutureHourId === "2026-09-17T19:00:00.000Z"
    ),
    "expected globally optimal temporal matching",
  );

  const savingsFirstPrices = [
    hourly("2026-09-17T16:00:00.000Z", 0),
    hourly("2026-09-17T17:00:00.000Z", 1),
    hourly("2026-09-17T18:00:00.000Z", 99),
    hourly("2026-09-17T19:00:00.000Z", 100),
  ];
  const savingsFirst = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds: [
      "2026-09-17T17:00:00.000Z",
      "2026-09-17T19:00:00.000Z",
    ],
    maxPreheatHours: 2,
    preheatCandidateHourIds: [
      "2026-09-17T16:00:00.000Z",
      "2026-09-17T18:00:00.000Z",
    ],
    prices: savingsFirstPrices,
  });
  assert(savingsFirst.available, "expected a profitable recommendation");
  assert(savingsFirst.pairs.length === 1, "expected cap to remain optional rather than force two pairs");
  assert(
    savingsFirst.pairs[0].preheatHourId === "2026-09-17T16:00:00.000Z" &&
      savingsFirst.pairs[0].displacedFutureHourId === "2026-09-17T19:00:00.000Z" &&
      savingsFirst.pairs[0].savingsCentsPerKwh === 100,
    "expected highest aggregate savings across all permitted pair counts",
  );

  const mixedOrderPrices = [
    hourly("2026-09-17T16:00:00.000Z", 2),
    hourly("2026-09-17T17:00:00.000Z", 20),
    hourly("2026-09-17T23:00:00.000Z", 0),
    hourly("2026-09-18T00:00:00.000Z", 10),
  ];
  const mixedOrder = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds: [
      "2026-09-17T17:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    ],
    maxPreheatHours: 2,
    preheatCandidateHourIds: [
      "2026-09-17T16:00:00.000Z",
      "2026-09-17T23:00:00.000Z",
    ],
    prices: mixedOrderPrices,
  });
  assert(mixedOrder.available && mixedOrder.pairs.length === 2, "expected two feasible temporal pairs");
  assert(
    mixedOrder.pairs.every((pair) => Date.parse(pair.preheatHourId) < Date.parse(pair.displacedFutureHourId)),
    "expected every recommended preheat interval to precede displaced heating",
  );

  const missing = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds: ["2026-09-17T22:00:00.000Z"],
    maxPreheatHours: 1,
    preheatCandidateHourIds: ["2026-09-17T16:00:00.000Z"],
    prices,
  });
  assert(!missing.available && missing.reason === "price_data_missing", "expected missing candidate price to fail closed");

  const noneToDisplace = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds: [],
    maxPreheatHours: 1,
    preheatCandidateHourIds: ["2026-09-17T17:00:00.000Z"],
    prices,
  });
  assert(
    !noneToDisplace.available && noneToDisplace.reason === "no_future_heating_to_displace",
    "expected no speculative preheat without future heat to displace",
  );

  const malformed = [
    ...prices,
    {
      starts_at: "2026-09-17T19:30:00.000Z",
      ends_at: "2026-09-17T20:30:00.000Z",
      spot_price_cents_kwh: 0,
      resolution_minutes: 60,
    },
  ];
  const malformedResult = evaluateV2MarginalPreheatCost({
    displacedFutureHeatingHourIds: ["2026-09-17T22:00:00.000Z"],
    maxPreheatHours: 1,
    preheatCandidateHourIds: ["2026-09-17T19:30:00.000Z"],
    prices: malformed,
  });
  assert(
    !malformedResult.available && malformedResult.reason === "price_data_missing",
    "expected off-hour candidate interval to fail closed",
  );
}

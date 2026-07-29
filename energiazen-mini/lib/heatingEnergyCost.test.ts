import {
  calculateHeatingCostEuros,
  calculateHeatingPeriodCostEuros,
  calculatePlannedHeatingPlanCostEuros,
} from "./heatingEnergyCost";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertClose(actual: number | null, expected: number, message: string) {
  if (actual === null || Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

export function runHeatingEnergyCostUnitTests() {
  assertClose(
    calculateHeatingCostEuros({
      energyKwh: 3,
      spotPriceCentsPerKwh: 0.9,
    }),
    0.2856,
    "3 kWh spot-hinnalla 0,9 c/kWh maksaa n. 0,2856 euroa",
  );

  assertClose(
    calculatePlannedHeatingPlanCostEuros({
      hours: [{ price: 0.9 }, { price: 1 }],
    }),
    0.2856 + 0.2886,
    "kaksi yhden tunnin jaksoa summataan oikein",
  );

  assertClose(
    calculateHeatingPeriodCostEuros({
      endedAt: "2026-07-22T02:25:00.000Z",
      priceIntervals: [
        {
          endDate: "2026-07-22T02:00:00.000Z",
          price: 1,
          startDate: "2026-07-22T01:00:00.000Z",
        },
        {
          endDate: "2026-07-22T03:00:00.000Z",
          price: 2,
          startDate: "2026-07-22T02:00:00.000Z",
        },
      ],
      startedAt: "2026-07-22T01:40:00.000Z",
    }),
    (3 * (20 / 60) * (1 + 0.4 + 8.22)) / 100 +
      (3 * (25 / 60) * (2 + 0.4 + 8.22)) / 100,
    "tuntirajan ylittava jakso kayttaa kahta eri hintaa",
  );

  assertEqual(
    calculatePlannedHeatingPlanCostEuros({ hours: [] }),
    0,
    "tyhja suunnitelma palauttaa 0 euroa",
  );
  assertEqual(
    calculatePlannedHeatingPlanCostEuros({ hours: [{ price: null }] }),
    null,
    "puuttuva hintatieto palauttaa null-arvon eika kaada laskentaa",
  );
  assertEqual(
    calculateHeatingPeriodCostEuros({
      endedAt: "2026-07-22T02:00:00.000Z",
      priceIntervals: [],
      startedAt: "2026-07-22T01:00:00.000Z",
    }),
    null,
    "puuttuvat jakson hintatiedot palauttavat null-arvon",
  );
}

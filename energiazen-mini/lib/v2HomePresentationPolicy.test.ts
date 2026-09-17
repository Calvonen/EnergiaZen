import { buildStoredHeatingPlanPresentation } from "./heatingPlanPresentation";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function runV2HomePresentationPolicyUnitTests() {
  const presentation = buildStoredHeatingPlanPresentation({
    currentOptimizerPresentation: null,
    forecast: null,
    selectedHours: [],
    v2EnergyReserve: {
      available: true,
      capacityKwh: 17.7,
      energyKwh: 12.0,
      forecastMinimumEnergyKwh: 10.8,
      forecastMinimumPercent: 61.0,
      forecastFinalEnergyKwh: 11.0,
      forecastFinalPercent: 62.1,
      percent: 67.8,
      safetyReservePercent: 30,
      targetReservePercent: 75,
      recommendedPreheatPercent: 90,
    },
  });

  assertEqual(presentation.forecastDetails, null, "V2 home presentation must not expose shower forecast details");
  assertEqual(presentation.forecastSectionLabel, "V2-energiavara", "V2 reserve must own the forecast section");
  assertEqual(presentation.limitsSummary, "Suositus 90,0 % · turvaraja 30,0 %", "home limits must expose soft 90% recommendation and hard 30% safety");
  assertEqual(presentation.priceToleranceSummary, null, "legacy shower optimizer price tolerance must stay hidden from V2 home card");

  const unavailable = buildStoredHeatingPlanPresentation({
    selectedHours: [],
  });
  assertEqual(unavailable.forecastDetails, null, "stored plan must never fall back to shower forecast details");
  assertEqual(unavailable.forecastSectionLabel, "V2-energiavara", "stored plan fallback must remain in V2 semantics");
  assertEqual(unavailable.priceToleranceSummary, null, "stored plan fallback must not expose legacy price tolerance");
  if (unavailable.forecastSummary.includes("suihku")) {
    throw new Error("stored plan fallback must not expose legacy shower forecast text");
  }
}

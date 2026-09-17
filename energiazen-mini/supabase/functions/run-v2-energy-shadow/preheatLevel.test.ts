import {
  evaluateV2SoftPreheatLevel,
  recommendedV2PreheatPercent,
} from "./preheatLevel";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

export function runV2SoftPreheatLevelUnitTests() {
  const belowRecommendation = evaluateV2SoftPreheatLevel({
    conservativeEnergyKwh: 10,
    energyCapacityKwh: 20,
  });
  assert(belowRecommendation.available, "valid energy inputs expose soft preheat metadata");
  assertEqual(recommendedV2PreheatPercent, 90, "default recommended preheat level is 90 percent");
  assertEqual(belowRecommendation.currentConservativePercent, 50, "current conservative reserve is reported as a percentage");
  assertEqual(belowRecommendation.recommendedPreheatTargetKwh, 18, "90 percent target converts to physical kWh");
  assertEqual(belowRecommendation.recommendedPreheatEnergyKwh, 8, "only the energy needed to reach the recommendation is advisory preheat");
  assertEqual(belowRecommendation.preheatHeadroomKwh, 8, "preheat headroom matches the advisory energy gap");

  const configuredRecommendation = evaluateV2SoftPreheatLevel({
    conservativeEnergyKwh: 14,
    energyCapacityKwh: 20,
    recommendedPreheatPercent: 80,
  });
  assert(configuredRecommendation.available, "configured preheat recommendation remains available");
  assertEqual(configuredRecommendation.recommendedPreheatPercent, 80, "configured recommendation is retained in telemetry");
  assertEqual(configuredRecommendation.recommendedPreheatTargetKwh, 16, "configured 80 percent recommendation converts to physical kWh");
  assertEqual(configuredRecommendation.recommendedPreheatEnergyKwh, 2, "configured recommendation controls advisory headroom");

  const alreadyAboveRecommendation = evaluateV2SoftPreheatLevel({
    conservativeEnergyKwh: 18.4,
    energyCapacityKwh: 20,
  });
  assert(alreadyAboveRecommendation.available, "reserve above the recommendation remains a valid state");
  assertEqual(alreadyAboveRecommendation.currentConservativePercent, 92, "reserve may legitimately exceed the recommendation");
  assertEqual(alreadyAboveRecommendation.recommendedPreheatEnergyKwh, 0, "90 percent is not a hard cap and does not request negative heating");
  assertEqual(alreadyAboveRecommendation.preheatHeadroomKwh, 0, "no optional preheat headroom remains above the recommendation");

  const abovePhysicalCapacity = evaluateV2SoftPreheatLevel({
    conservativeEnergyKwh: 21,
    energyCapacityKwh: 20,
  });
  assert(abovePhysicalCapacity.available, "temporary model overshoot does not make the policy unavailable");
  assertEqual(abovePhysicalCapacity.currentConservativePercent, 100, "display percentage is clamped to physical capacity");
  assertEqual(abovePhysicalCapacity.recommendedPreheatEnergyKwh, 0, "model overshoot never creates advisory preheat demand");

  const invalidCapacity = evaluateV2SoftPreheatLevel({
    conservativeEnergyKwh: 10,
    energyCapacityKwh: 0,
  });
  assert(!invalidCapacity.available, "non-positive capacity fails closed");
  assertEqual(invalidCapacity.reason, "invalid_energy_capacity", "invalid capacity has an explicit reason");

  const invalidReserve = evaluateV2SoftPreheatLevel({
    conservativeEnergyKwh: Number.NaN,
    energyCapacityKwh: 20,
  });
  assert(!invalidReserve.available, "invalid conservative reserve fails closed");
  assertEqual(invalidReserve.reason, "invalid_conservative_energy", "invalid reserve has an explicit reason");
}

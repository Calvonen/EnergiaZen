import { evaluateV2PriceCeilingPolicy } from "./priceCeilingPolicy";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

export function runV2PriceCeilingPolicyUnitTests() {
  const withinCeiling = evaluateV2PriceCeilingPolicy({
    maxBilledPriceCentsPerKwh: 15,
    safetyHeatingRequired: false,
    spotPriceCentsPerKwh: 5,
  });
  assert(withinCeiling.available, "valid tariff input is available");
  assertEqual(withinCeiling.billedPriceCentsPerKwh, 13.62, "policy compares the billed tariff rather than raw spot");
  assertEqual(withinCeiling.allowed, true, "billed price below the ceiling is allowed");
  assertEqual(withinCeiling.reason, "within_price_ceiling", "allowed price has an explicit reason");
  assertEqual(withinCeiling.emergencySafetyOverride, false, "normal allowed heat is not marked as emergency");

  const blocked = evaluateV2PriceCeilingPolicy({
    maxBilledPriceCentsPerKwh: 15,
    safetyHeatingRequired: false,
    spotPriceCentsPerKwh: 10,
  });
  assertEqual(blocked.billedPriceCentsPerKwh, 18.62, "grid, tax and margin are included before ceiling comparison");
  assertEqual(blocked.allowed, false, "non-safety heating above the ceiling is blocked");
  assertEqual(blocked.reason, "blocked_above_price_ceiling", "blocked heat exposes the ceiling reason");

  const safetyOverride = evaluateV2PriceCeilingPolicy({
    maxBilledPriceCentsPerKwh: 15,
    safetyHeatingRequired: true,
    spotPriceCentsPerKwh: 100,
  });
  assertEqual(safetyOverride.allowed, true, "hard safety heating may override the economic ceiling");
  assertEqual(safetyOverride.reason, "safety_override_above_price_ceiling", "safety override is explicit");
  assertEqual(safetyOverride.emergencySafetyOverride, true, "safety override is separately observable");

  const negativeCeiling = evaluateV2PriceCeilingPolicy({
    maxBilledPriceCentsPerKwh: -1,
    safetyHeatingRequired: false,
    spotPriceCentsPerKwh: -10,
  });
  assertEqual(negativeCeiling.billedPriceCentsPerKwh, -1.38, "negative billed prices remain valid inputs");
  assertEqual(negativeCeiling.allowed, true, "a finite negative ceiling works as a strict economic policy");

  const invalidSpot = evaluateV2PriceCeilingPolicy({
    maxBilledPriceCentsPerKwh: 15,
    safetyHeatingRequired: false,
    spotPriceCentsPerKwh: Number.NaN,
  });
  assert(!invalidSpot.available, "invalid spot price fails closed");
  assertEqual(invalidSpot.allowed, null, "invalid spot price does not guess an allow/block result");
  assertEqual(invalidSpot.reason, "invalid_spot_price", "invalid spot price has an explicit reason");

  const invalidCeiling = evaluateV2PriceCeilingPolicy({
    maxBilledPriceCentsPerKwh: Number.POSITIVE_INFINITY,
    safetyHeatingRequired: true,
    spotPriceCentsPerKwh: 1,
  });
  assert(!invalidCeiling.available, "invalid ceiling fails closed even when safety is requested");
  assertEqual(invalidCeiling.allowed, null, "invalid policy configuration cannot authorize heat");
  assertEqual(invalidCeiling.reason, "invalid_price_ceiling", "invalid ceiling has an explicit reason");
}

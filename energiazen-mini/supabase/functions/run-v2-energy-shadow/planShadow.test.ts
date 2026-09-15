import { runLiveEnergyPlanShadow, type ShadowElectricityPrice } from "./planShadow";
import type { LiveReserveShadowResult } from "./logic";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function reserve(remainingEnergyKwh: number, balanceUncertaintyKwh = 0.25): LiveReserveShadowResult {
  return {
    available: true,
    reason: null,
    readingCount: 10,
    reliableDrawCount: 0,
    unresolvedDrawDetected: false,
    remainingEnergyKwh,
    observedEnergyKwh: remainingEnergyKwh,
    sensorGapKwh: 0,
    balanceUncertaintyKwh,
    heaterDeliveryUncertaintyKwh: 0,
    heaterCreditGuardTopTempC: 63,
    conservativeEnergyKwh: Math.max(remainingEnergyKwh - balanceUncertaintyKwh, 0),
    safetyEnergyKwh: 3,
    targetEnergyKwh: 6,
    v2Band: remainingEnergyKwh - balanceUncertaintyKwh >= 6 ? "target_met" : "recovery",
    v2NeedsEnergyRecovery: remainingEnergyKwh - balanceUncertaintyKwh < 6,
    v1NeedsEnergyRecovery: null,
    comparison: "v1_unavailable",
  };
}

function price(startsAt: string, cents: number): ShadowElectricityPrice {
  const start = Date.parse(startsAt);
  return {
    starts_at: startsAt,
    ends_at: new Date(start + 60 * 60 * 1000).toISOString(),
    resolution_minutes: 60,
    spot_price_cents_kwh: cents,
  };
}

export function runLivePlanShadowUnitTests() {
  const now = new Date("2026-09-15T05:30:00.000Z");
  const contiguous = [
    price("2026-09-15T05:00:00.000Z", 10),
    price("2026-09-15T06:00:00.000Z", 2),
    price("2026-09-15T07:00:00.000Z", 5),
  ];

  const healthy = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: contiguous,
    reserve: reserve(13),
  });
  assert(healthy.available, "continuous current price horizon is available");
  assert(healthy.valid === true, "healthy reserve produces a valid no-heat plan");
  assertEqual(healthy.selectedHeatingHourIds.length, 0, "healthy horizon does not add heating");
  assert(healthy.standingLossKwhPerHour !== null && healthy.standingLossKwhPerHour > 0, "worst-case standing loss is explicit");
  assertEqual(healthy.forecastHorizonEndAt, "2026-09-15T08:00:00.000Z", "horizon end is persisted");

  const needsHeat = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: contiguous,
    reserve: reserve(5.4),
  });
  assert(needsHeat.available, "recoverable reserve still has a plan shadow");
  assert(needsHeat.valid === true, "optimizer finds a valid recovery plan");
  assertEqual(needsHeat.selectedHeatingHourIds.length, 1, "one segment is enough to restore target");
  assertEqual(needsHeat.selectedHeatingHourIds[0], "2026-09-15T05:00:00.000Z", "partial current hour wins when it delivers the least sufficient energy");
  assert(needsHeat.selectedHeatingEnergyKwh !== null && needsHeat.selectedHeatingEnergyKwh < 3, "partial current hour credits less than a full 3 kWh");

  const missingCurrent = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: [price("2026-09-15T06:00:00.000Z", 1)],
    reserve: reserve(5.4),
  });
  assert(!missingCurrent.available, "missing current price hour fails closed");
  assertEqual(missingCurrent.reason, "current_price_hour_missing", "missing current hour has an explicit reason");

  const gapped = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: [
      price("2026-09-15T05:00:00.000Z", 2),
      price("2026-09-15T07:00:00.000Z", 1),
    ],
    reserve: reserve(5.4),
  });
  assert(!gapped.available, "gapped price horizon fails closed");
  assertEqual(gapped.reason, "price_horizon_gap", "price gap reason is persisted");

  const capped = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 5,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: contiguous,
    reserve: reserve(5.4),
  });
  assert(!capped.available, "shadow refuses combinatorial settings above its tested cap");
  assertEqual(capped.reason, "max_heating_hours_above_shadow_limit", "shadow cap has an explicit reason");
}

import { runLiveEnergyPlanShadow, type ShadowElectricityPrice } from "./planShadow";
import type { LiveReserveShadowResult } from "./logic";
import type { LearnedTemperatureDropProfile } from "./learnedDropProfile";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function reserve(
  remainingEnergyKwh: number,
  balanceUncertaintyKwh = 0.25,
  targetEnergyKwh = 6,
): LiveReserveShadowResult {
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
    targetEnergyKwh,
    v2Band: remainingEnergyKwh - balanceUncertaintyKwh >= targetEnergyKwh ? "target_met" : "recovery",
    v2NeedsEnergyRecovery: remainingEnergyKwh - balanceUncertaintyKwh < targetEnergyKwh,
    v1NeedsEnergyRecovery: null,
    comparison: "v1_unavailable",
  };
}

function learnedProfile(createdAt: string, energyLossKwhPerHour: number): LearnedTemperatureDropProfile {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    profile_date: createdAt.slice(0, 10),
    timezone: "Europe/Helsinki",
    source_start: new Date(Date.parse(createdAt) - 30 * 24 * 60 * 60 * 1000).toISOString(),
    source_end: createdAt,
    source_days: 30,
    hourlyDrops: Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [hour, 0.5])),
    hourlyEnergyLossesKwh: Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [hour, energyLossKwhPerHour]),
    ),
    observationDaysByHour: Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [hour, 30])),
    general_fallback: 0.5,
    general_energy_loss_kwh: energyLossKwhPerHour,
    hourly_energy_losses_kwh: Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour), energyLossKwhPerHour]),
    ),
    algorithm_version: "weighted-70-30-v1+physical-kwh-v2",
    created_at: createdAt,
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

function quarterPrice(startsAt: string, cents: number): ShadowElectricityPrice {
  const start = Date.parse(startsAt);
  return {
    starts_at: startsAt,
    ends_at: new Date(start + 15 * 60 * 1000).toISOString(),
    resolution_minutes: 15,
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
    energyCapacityKwh: 16.864,
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


  const learned = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    energyCapacityKwh: 16.864,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: contiguous,
    reserve: reserve(13),
    learnedDropProfile: learnedProfile("2026-09-13T01:30:00.000Z", 2),
  });
  assert(learned.learnedDropProfileUsed, "fresh learned 30-day profile is used");
  assertEqual(learned.learnedDropProfileDate, "2026-09-13", "used profile date is exposed");
  assert(
    learned.maximumModeledLossKwhPerHour !== null &&
      learned.standingLossKwhPerHour !== null &&
      learned.maximumModeledLossKwhPerHour > learned.standingLossKwhPerHour,
    "learned hourly drop can raise modeled loss above the physical standing-loss floor",
  );

  const staleLearned = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    energyCapacityKwh: 16.864,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: contiguous,
    reserve: reserve(13),
    learnedDropProfile: learnedProfile("2026-08-01T01:30:00.000Z", 2),
  });
  assert(!staleLearned.learnedDropProfileUsed, "stale learned profile is ignored");
  assertEqual(
    staleLearned.maximumModeledLossKwhPerHour,
    staleLearned.standingLossKwhPerHour,
    "stale profile falls back to physical standing-loss forecast",
  );


  const frontLoadedDemandCannotBeHiddenBySameHourHeat = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    energyCapacityKwh: 16.864,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: contiguous,
    reserve: reserve(4.2),
    learnedDropProfile: learnedProfile("2026-09-13T01:30:00.000Z", 2),
  });
  assert(
    frontLoadedDemandCannotBeHiddenBySameHourHeat.valid === false,
    "front-loaded learned demand must expose a safety violation before same-hour heater credit",
  );
  assertEqual(
    frontLoadedDemandCannotBeHiddenBySameHourHeat.firstSafetyViolationAt,
    now.toISOString(),
    "partial current-hour learned demand is checked at the remaining segment start",
  );

  const belowTargetButSafe = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    energyCapacityKwh: 16.864,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: contiguous,
    reserve: reserve(5.4),
  });
  assert(belowTargetButSafe.available, "below-target reserve still has a plan shadow");
  assert(belowTargetButSafe.valid === true, "missing advisory target does not invalidate a safety-safe plan");
  assertEqual(belowTargetButSafe.selectedHeatingHourIds.length, 0, "advisory target alone must not buy electricity");
  assert(belowTargetButSafe.firstTargetMissAt !== null, "target miss remains visible as forecast metadata");

  const needsSafetyHeat = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    energyCapacityKwh: 16.864,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: contiguous,
    reserve: reserve(3.4),
  });
  assert(needsSafetyHeat.available, "safety-threatened reserve still has a plan shadow");
  assert(needsSafetyHeat.valid === true, "optimizer finds a safety-preserving recovery plan");
  assertEqual(needsSafetyHeat.selectedHeatingHourIds.length, 1, "one segment is enough to preserve safety");
  assertEqual(
    needsSafetyHeat.selectedHeatingHourIds[0],
    "2026-09-15T05:00:00.000Z",
    "billed tariff keeps the shorter current interval cheapest when safety requires heat",
  );
  assertEqual(needsSafetyHeat.selectedHeatingEnergyKwh, 1.5, "safety recovery may use the partial 1.5 kWh segment");
  assertEqual(needsSafetyHeat.totalCostCents, 27.93, "safety recovery cost includes spot margin plus grid and tax");

  const winterSpike = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    energyCapacityKwh: 16.864,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: [
      price("2026-09-15T05:00:00.000Z", 100),
      price("2026-09-15T06:00:00.000Z", 1),
      price("2026-09-15T07:00:00.000Z", 50),
    ],
    reserve: reserve(3.4),
  });
  assert(winterSpike.valid === true, "100 c/kWh spike scenario still finds a safe plan");
  assertEqual(
    winterSpike.selectedHeatingHourIds[0],
    "2026-09-15T06:00:00.000Z",
    "100 c/kWh partial current segment must lose to a 1 c/kWh future hour when safety can wait",
  );
  assertEqual(winterSpike.totalCostCents, 28.86, "winter spike comparison uses the billed 9.62 c/kWh future tariff");

  const moderatelyNegative = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    energyCapacityKwh: 16.864,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: [
      price("2026-09-15T05:00:00.000Z", -5),
      price("2026-09-15T06:00:00.000Z", -4),
      price("2026-09-15T07:00:00.000Z", 10),
    ],
    reserve: reserve(3.4),
  });
  assert(moderatelyNegative.valid === true, "moderately negative spot scenario remains safe");
  assertEqual(
    moderatelyNegative.selectedHeatingHourIds[0],
    "2026-09-15T05:00:00.000Z",
    "negative spot must still be compared using the positive billed tariff",
  );
  assertEqual(moderatelyNegative.totalCostCents, 5.43, "-5 c/kWh spot still bills 3.62 c/kWh after tariff additions");

  const missingCurrent = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    energyCapacityKwh: 16.864,
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
    energyCapacityKwh: 16.864,
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
    energyCapacityKwh: 16.864,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: contiguous,
    reserve: reserve(5.4),
  });
  assert(!capped.available, "shadow refuses combinatorial settings above its tested cap");
  assertEqual(capped.reason, "max_heating_hours_above_shadow_limit", "shadow cap has an explicit reason");

  const lockedHourIds = contiguous.map((item) => item.starts_at);
  const lockedAboveConfiguredCap = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 1,
    constraints: {
      forbiddenHeatingHourIds: [],
      requiredHeatingHourIds: lockedHourIds,
    },
    energyCapacityKwh: 16.864,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: contiguous,
    reserve: reserve(5.4),
  });
  assert(lockedAboveConfiguredCap.available, "locked active block remains available above configured cap");
  assert(lockedAboveConfiguredCap.reason !== "required_hours_exceed_max", "locked block expands the effective optimizer cap");
  assertEqual(lockedAboveConfiguredCap.selectedHeatingHourIds.length, 3, "every locked hour is preserved");
  assertEqual(lockedAboveConfiguredCap.selectedHeatingHourIds.join("|"), lockedHourIds.join("|"), "locked block selection remains intact");

  const advisoryTargetAboveCurrentReserve = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 1,
    energyCapacityKwh: 10,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: Array.from({ length: 10 }, (_, index) =>
      price(new Date(Date.parse("2026-09-15T05:00:00.000Z") + index * 3_600_000).toISOString(), index)
    ),
    reserve: reserve(9.4, 0.6, 10),
  });
  assert(advisoryTargetAboveCurrentReserve.available, "capacity-bound forecast remains available");
  assert(advisoryTargetAboveCurrentReserve.valid === true, "safe plan remains valid even when advisory target is not reached");
  assertEqual(advisoryTargetAboveCurrentReserve.selectedHeatingHourIds.length, 0, "advisory target does not force capacity-filling heat");
  assertEqual(advisoryTargetAboveCurrentReserve.reason, null, "safe below-target plan has no violation reason");
  const quarterHorizon = Array.from({ length: 40 }, (_, index) =>
    quarterPrice(
      new Date(Date.parse("2026-09-15T05:30:00.000Z") + index * 15 * 60_000).toISOString(),
      index === 4 ? 1 : 10,
    ),
  );
  const quarterHealthy = runLiveEnergyPlanShadow({
    automaticMaxHeatingHours: 4,
    energyCapacityKwh: 16.864,
    inletBaselineC: 12,
    maxTankTemperatureC: 65,
    now,
    prices: quarterHorizon,
    reserve: reserve(13),
  });
  assert(quarterHealthy.available, "continuous quarter-hour price horizon is available");
  assertEqual(quarterHealthy.candidateCount, 40, "quarter-hour horizon keeps every 15-minute candidate");
  assertEqual(quarterHealthy.selectedHeatingHourIds.length, 0, "healthy quarter-hour horizon does not add heating");
  assert(
    quarterHealthy.evaluatedCombinationCount <= 17,
    "large quarter-hour horizon uses bounded safety search instead of combinatorial enumeration",
  );


}

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

function baseline(selectedHeatingHourIds: string[]): LiveEnergyPlanShadowResult {
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
    valid: true,
  };
}

export function runV2MarginalPreheatAdvisoryCapUnitTests() {
  const now = new Date("2026-09-17T12:15:00.000Z");
  const tomorrowStart = Date.parse("2026-09-17T21:00:00.000Z");
  const prices = [
    hourly("2026-09-17T12:00:00.000Z", 1),
    hourly("2026-09-17T13:00:00.000Z", 2),
    ...Array.from({ length: 24 }, (_, index) =>
      hourly(new Date(tomorrowStart + index * 3_600_000).toISOString(), 10 + index / 100),
    ),
  ];

  const advisory = buildV2MarginalPreheatAdvisory({
    baselinePlan: baseline(["2026-09-17T12:00:00.000Z"]),
    conservativeEnergyKwh: 12,
    energyCapacityKwh: 20,
    heaterPowerKw: 3,
    maxPreheatHours: 1,
    now,
    prices,
    remainingEnergyKwh: 12,
  });

  if (advisory.available || advisory.recommendedPreheatHourIds.length !== 0) {
    throw new Error("expected active retained baseline hour to consume the configured one-hour cap");
  }
  if (advisory.maxPreheatHoursByHeadroom !== 0) {
    throw new Error(`expected zero remaining configured hours, got ${advisory.maxPreheatHoursByHeadroom}`);
  }
  if (!advisory.retainedBaselineHeatingHourIds.includes("2026-09-17T12:00:00.000Z")) {
    throw new Error("expected the active baseline hour to be retained and counted against the cap");
  }
}

import { evaluateV2PublicationGuard } from "./publicationGuard";
import type { LiveEnergyPlanShadowResult } from "./planShadow";

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function plan(overrides: Partial<LiveEnergyPlanShadowResult> = {}): LiveEnergyPlanShadowResult {
  return {
    available: true,
    assumption: "standing_loss_only_no_future_draws",
    candidateCount: 1,
    evaluatedCombinationCount: 1,
    firstSafetyViolationAt: null,
    firstTargetMissAt: null,
    forecastHorizonEndAt: "2026-09-16T21:00:00.000Z",
    minimumConservativeEnergyKwh: 6,
    reason: null,
    selectedHeatingEnergyKwh: 3,
    selectedHeatingHourIds: ["2026-09-15T20:00:00.000Z"],
    standingLossKwhPerHour: 0.1,
    totalCostCents: 10,
    valid: true,
    ...overrides,
  };
}

export function runV2PublicationGuardUnitTests() {
  const now = new Date("2026-09-15T12:00:00.000Z");
  const freshReading = "2026-09-15T11:55:00.000Z";
  const selected = ["2026-09-15T20:00:00.000Z"];

  assertEqual(evaluateV2PublicationGuard({ enabled: false, now, latestTankReadingAt: freshReading, plan: plan(), selectedHeatingHourIds: selected }).reason, "cutover_disabled", "cutover is fail-closed by default");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: null, plan: plan(), selectedHeatingHourIds: selected }).reason, "tank_reading_missing", "missing tank reading blocks publication");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: "2026-09-15T11:40:00.000Z", plan: plan(), selectedHeatingHourIds: selected }).reason, "tank_reading_stale", "stale tank reading blocks publication");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: plan({ available: false }), selectedHeatingHourIds: selected }).reason, "plan_unavailable", "unavailable plan blocks publication");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: plan({ valid: false }), selectedHeatingHourIds: selected }).reason, "plan_invalid", "invalid plan blocks publication");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: plan({ forecastHorizonEndAt: null }), selectedHeatingHourIds: selected }).reason, "forecast_horizon_missing", "missing forecast horizon blocks publication");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: plan(), selectedHeatingHourIds: [] }).reason, "selected_hours_mismatch", "changed selected hours block publication");

  const ready = evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: plan(), selectedHeatingHourIds: selected });
  assertEqual(ready.ready, true, "fully validated snapshot can become publication-ready");
  assertEqual(ready.reason, "ready", "ready decision is explicit");
}

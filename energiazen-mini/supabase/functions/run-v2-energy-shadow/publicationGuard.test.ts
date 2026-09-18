import { captureV2PublicationCandidate, evaluateV2PublicationGuard } from "./publicationGuard";
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
    finalConservativeEnergyKwh: 8,
    minimumConservativeEnergyKwh: 6,
    reason: null,
    selectedHeatingEnergyKwh: 3,
    selectedHeatingHourIds: ["2026-09-15T20:00:00.000Z"],
    standingLossKwhPerHour: 0.1,
    totalCostCents: 10,
    valid: true,
    learnedDropProfileUsed: false,
    learnedDropProfileDate: null,
    learnedDropProfileAgeDays: null,
    maximumModeledLossKwhPerHour: 0.1,
    ...overrides,
  };
}

export function runV2PublicationGuardUnitTests() {
  const now = new Date("2026-09-15T12:00:00.000Z");
  const freshReading = "2026-09-15T11:55:00.000Z";
  const basePlan = plan();
  const candidate = captureV2PublicationCandidate(basePlan);

  assertEqual(evaluateV2PublicationGuard({ enabled: false, now, latestTankReadingAt: freshReading, plan: basePlan, publicationCandidate: candidate }).reason, "cutover_disabled", "cutover is fail-closed by default");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: null, plan: basePlan, publicationCandidate: candidate }).reason, "tank_reading_missing", "missing tank reading blocks publication");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: "2026-09-15T11:40:00.000Z", plan: basePlan, publicationCandidate: candidate }).reason, "tank_reading_stale", "stale usable tank reading blocks publication");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: plan({ available: false }), publicationCandidate: candidate }).reason, "plan_unavailable", "unavailable plan blocks publication");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: plan({ valid: false }), publicationCandidate: candidate }).reason, "plan_invalid", "invalid plan blocks publication");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: plan({ forecastHorizonEndAt: null }), publicationCandidate: candidate }).reason, "forecast_horizon_missing", "missing forecast horizon blocks publication");
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: basePlan, publicationCandidate: null }).reason, "publication_candidate_missing", "missing independent publication candidate blocks publication");

  const mutatedCandidate = captureV2PublicationCandidate(basePlan);
  mutatedCandidate.selectedHeatingHourIds.length = 0;
  assertEqual(evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: basePlan, publicationCandidate: mutatedCandidate }).reason, "selected_hours_mismatch", "candidate mutation after capture is detected");
  assertEqual(basePlan.selectedHeatingHourIds.length, 1, "candidate snapshot does not alias the plan hour array");

  const ready = evaluateV2PublicationGuard({ enabled: true, now, latestTankReadingAt: freshReading, plan: basePlan, publicationCandidate: candidate });
  assertEqual(ready.ready, true, "fully validated independent snapshot can become publication-ready");
  assertEqual(ready.reason, "ready", "ready decision is explicit");
}

import type { LiveEnergyPlanShadowResult } from "./planShadow.ts";

export type V2PublicationCandidate = {
  selectedHeatingHourIds: string[];
};

export type V2PublicationGuardInput = {
  enabled: boolean;
  now: Date;
  latestTankReadingAt: string | null;
  plan: LiveEnergyPlanShadowResult;
  publicationCandidate: V2PublicationCandidate | null;
  expectedSelectedHeatingHourIds?: readonly string[];
};

export type V2PublicationGuardDecision = {
  ready: boolean;
  reason:
    | "cutover_disabled"
    | "tank_reading_missing"
    | "tank_reading_stale"
    | "plan_unavailable"
    | "plan_invalid"
    | "forecast_horizon_missing"
    | "publication_candidate_missing"
    | "selected_hours_mismatch"
    | "ready";
};

const maxTankReadingAgeMs = 15 * 60_000;

/**
 * Capture the independently publishable payload from a validated plan. The
 * copy is deliberate: the guard must compare two snapshots rather than two
 * references to the optimizer's mutable array. Callers may provide an
 * advisory-composed hour set while retaining the validated baseline plan for
 * readiness checks.
 */
export function captureV2PublicationCandidate(
  plan: LiveEnergyPlanShadowResult,
  selectedHeatingHourIds: readonly string[] = plan.selectedHeatingHourIds,
): V2PublicationCandidate {
  return { selectedHeatingHourIds: [...selectedHeatingHourIds] };
}

/**
 * Pure readiness gate for the future V2 publication/cutover path.
 *
 * This intentionally performs no database writes and does not alter Shelly
 * ownership. The default runtime call keeps cutover `enabled=false`, so
 * merging and deploying this guard cannot transfer control away from V1. A
 * later cutover PR must explicitly enable the gate and atomically publish the
 * independently captured candidate that passed this check.
 */
export function evaluateV2PublicationGuard({
  enabled,
  now,
  latestTankReadingAt,
  plan,
  publicationCandidate,
  expectedSelectedHeatingHourIds = plan.selectedHeatingHourIds,
}: V2PublicationGuardInput): V2PublicationGuardDecision {
  if (!enabled) return { ready: false, reason: "cutover_disabled" };

  const readingMs = latestTankReadingAt === null ? Number.NaN : Date.parse(latestTankReadingAt);
  if (!Number.isFinite(readingMs)) return { ready: false, reason: "tank_reading_missing" };
  const ageMs = now.getTime() - readingMs;
  if (ageMs < 0 || ageMs > maxTankReadingAgeMs) {
    return { ready: false, reason: "tank_reading_stale" };
  }

  if (!plan.available) return { ready: false, reason: "plan_unavailable" };
  if (plan.valid !== true) return { ready: false, reason: "plan_invalid" };
  if (!plan.forecastHorizonEndAt || !Number.isFinite(Date.parse(plan.forecastHorizonEndAt))) {
    return { ready: false, reason: "forecast_horizon_missing" };
  }
  if (publicationCandidate === null) {
    return { ready: false, reason: "publication_candidate_missing" };
  }
  if (!sameHourIds(expectedSelectedHeatingHourIds, publicationCandidate.selectedHeatingHourIds)) {
    return { ready: false, reason: "selected_hours_mismatch" };
  }

  return { ready: true, reason: "ready" };
}

function sameHourIds(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

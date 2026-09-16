"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureV2PublicationCandidate = captureV2PublicationCandidate;
exports.evaluateV2PublicationGuard = evaluateV2PublicationGuard;
const maxTankReadingAgeMs = 15 * 60000;
/**
 * Capture the independently publishable payload from a validated plan. The
 * copy is deliberate: the guard must compare two snapshots rather than two
 * references to the optimizer's mutable array.
 */
function captureV2PublicationCandidate(plan) {
    return { selectedHeatingHourIds: [...plan.selectedHeatingHourIds] };
}
/**
 * Pure readiness gate for the future V2 publication/cutover path.
 *
 * This intentionally performs no database writes and does not alter Shelly
 * ownership. The default runtime call keeps `enabled=false`, so merging and
 * deploying this guard cannot transfer control away from V1. A later cutover
 * PR must explicitly enable the gate and atomically publish the independently
 * captured candidate that passed this check.
 */
function evaluateV2PublicationGuard({ enabled, now, latestTankReadingAt, plan, publicationCandidate, }) {
    if (!enabled)
        return { ready: false, reason: "cutover_disabled" };
    const readingMs = latestTankReadingAt === null ? Number.NaN : Date.parse(latestTankReadingAt);
    if (!Number.isFinite(readingMs))
        return { ready: false, reason: "tank_reading_missing" };
    const ageMs = now.getTime() - readingMs;
    if (ageMs < 0 || ageMs > maxTankReadingAgeMs) {
        return { ready: false, reason: "tank_reading_stale" };
    }
    if (!plan.available)
        return { ready: false, reason: "plan_unavailable" };
    if (plan.valid !== true)
        return { ready: false, reason: "plan_invalid" };
    if (!plan.forecastHorizonEndAt || !Number.isFinite(Date.parse(plan.forecastHorizonEndAt))) {
        return { ready: false, reason: "forecast_horizon_missing" };
    }
    if (publicationCandidate === null) {
        return { ready: false, reason: "publication_candidate_missing" };
    }
    if (!sameHourIds(plan.selectedHeatingHourIds, publicationCandidate.selectedHeatingHourIds)) {
        return { ready: false, reason: "selected_hours_mismatch" };
    }
    return { ready: true, reason: "ready" };
}
function sameHourIds(left, right) {
    if (left.length !== right.length)
        return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index])
            return false;
    }
    return true;
}

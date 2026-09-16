"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tankMonitorAlertThresholdMinutes = void 0;
exports.computeTankReadingAgeMinutes = computeTankReadingAgeMinutes;
exports.computeTankReadingUiAgeMinutes = computeTankReadingUiAgeMinutes;
exports.isTankReadingStale = isTankReadingStale;
exports.shouldShowTankMonitorFault = shouldShowTankMonitorFault;
// Pidä tämä kynnys synkassa supabase/functions/check-tank-monitor-health/
// alertLogic.ts:n staleReadingAlertThresholdMinutes-vakion kanssa - appi
// näyttää virhebannerin ja Edge Function lähettää sähköpostihälytyksen
// samalla rajalla, jotta molemmat kertovat aina saman tilan käyttäjälle.
exports.tankMonitorAlertThresholdMinutes = 30;
function computeTankReadingAgeMinutes(readingCreatedAt, now) {
    if (!readingCreatedAt) {
        return null;
    }
    const readingTime = new Date(readingCreatedAt).getTime();
    if (Number.isNaN(readingTime)) {
        return null;
    }
    return (now.getTime() - readingTime) / (60 * 1000);
}
function computeTankReadingUiAgeMinutes(readingCreatedAt, now) {
    const ageMinutes = computeTankReadingAgeMinutes(readingCreatedAt, now);
    // `now` is UI state refreshed every 30 seconds, while a newly fetched
    // Supabase created_at can be newer. Both UI consumers treat that temporary
    // ordering gap as a reading from right now.
    return ageMinutes === null ? null : Math.max(0, ageMinutes);
}
function isTankReadingStale(ageMinutes) {
    return (ageMinutes === null ||
        ageMinutes < 0 ||
        ageMinutes > exports.tankMonitorAlertThresholdMinutes);
}
function shouldShowTankMonitorFault({ ageMinutes, hasInitialFetchSettled, isFocusRefreshPending, isResumeRefreshPending, }) {
    return (hasInitialFetchSettled &&
        !isFocusRefreshPending &&
        !isResumeRefreshPending &&
        isTankReadingStale(ageMinutes));
}

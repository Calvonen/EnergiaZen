// Pidä tämä kynnys synkassa supabase/functions/check-tank-monitor-health/
// alertLogic.ts:n staleReadingAlertThresholdMinutes-vakion kanssa - appi
// näyttää virhebannerin ja Edge Function lähettää sähköpostihälytyksen
// samalla rajalla, jotta molemmat kertovat aina saman tilan käyttäjälle.
export const tankMonitorAlertThresholdMinutes = 30;

export function computeTankReadingAgeMinutes(
  readingCreatedAt: string | null,
  now: Date,
): number | null {
  if (!readingCreatedAt) {
    return null;
  }

  const readingTime = new Date(readingCreatedAt).getTime();

  if (Number.isNaN(readingTime)) {
    return null;
  }

  return (now.getTime() - readingTime) / (60 * 1000);
}

export function computeTankReadingUiAgeMinutes(
  readingCreatedAt: string | null,
  now: Date,
): number | null {
  const ageMinutes = computeTankReadingAgeMinutes(readingCreatedAt, now);

  // `now` is UI state refreshed every 30 seconds, while a newly fetched
  // Supabase created_at can be newer. Both UI consumers treat that temporary
  // ordering gap as a reading from right now.
  return ageMinutes === null ? null : Math.max(0, ageMinutes);
}

export function isTankReadingStale(ageMinutes: number | null) {
  return (
    ageMinutes === null ||
    ageMinutes < 0 ||
    ageMinutes > tankMonitorAlertThresholdMinutes
  );
}

export function shouldShowTankMonitorFault({
  ageMinutes,
  hasInitialFetchSettled,
  isResumeRefreshPending,
}: {
  ageMinutes: number | null;
  hasInitialFetchSettled: boolean;
  isResumeRefreshPending: boolean;
}) {
  return (
    hasInitialFetchSettled &&
    !isResumeRefreshPending &&
    isTankReadingStale(ageMinutes)
  );
}

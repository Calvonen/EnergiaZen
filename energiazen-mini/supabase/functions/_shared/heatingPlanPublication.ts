import { formatHelsinkiDateKey, getHelsinkiHourNumber } from "./heatingLogic.ts";

export type ComparableHeatingPlan = {
  mode?: string | null;
  plan_date?: string | null;
  planned_hours?: unknown;
  target_hours?: number | null;
};

export type PublishedHeatingPlanState<TResult, THour> = {
  hours: THour[];
  inputKey: string;
  result: TResult | null;
  runId: number;
};

export type HeatingOptimizationRunSource = "active" | "scenario";

// Rollout gate for the legacy app publisher. Backend-primary owns automatic
// publications, while fixed plans remain explicit user-authored commands.
export function shouldPublishHeatingPlanFromApp({
  backendPrimaryEnabled,
  mode,
}: {
  backendPrimaryEnabled: boolean;
  mode: "automatic" | "fixed";
}): boolean {
  return mode === "fixed" || !backendPrimaryEnabled;
}

// Whether the heating_plans publish effect must defer entirely rather than
// upsert this cycle.
//  - isTodayPlanLoaded gates unconditionally, regardless of heating: with
//    storedHeatingPlansRef still empty, getChangedHeatingPlans compares
//    every hour against undefined, which never equals the real stored plan
//    - so every cold start would force an upsert whether or not the
//    optimizer's result actually differs from what's already published.
//    heating resolving quickly to a confirmed true/false (since PR #147)
//    made this race easy to hit: the publish effect no longer waits on
//    heating, so it now regularly runs while the separate stored-plan load
//    (keyed on visiblePlanDatesKey) is still in flight.
//  - heating === null additionally requires hasAttemptedTankReadingFetch,
//    since fixed heating mode isn't gated on the optimizer being ready, so
//    this effect can run before the relay-status fetch has ever settled
//    even once, while heating is still only its React-state initial value
//    and the unknown-anchor is still empty.
// Publishing anyway in either gap could replace a stored plan without ever
// getting a chance to preserve its currently running hour (Codex P1
// review, PR #147).
export function shouldDeferHeatingPlanPublicationForUnknownStatus({
  hasAttemptedTankReadingFetch,
  heating,
  isTodayPlanLoaded,
}: {
  hasAttemptedTankReadingFetch: boolean;
  heating: boolean | null;
  isTodayPlanLoaded: boolean;
}): boolean {
  return (
    !isTodayPlanLoaded ||
    (heating === null && !hasAttemptedTankReadingFetch)
  );
}

export function canPublishActiveHeatingPlan({
  isOptimizationCurrent,
  source,
}: {
  isOptimizationCurrent: boolean;
  source: HeatingOptimizationRunSource;
}) {
  return source === "active" && isOptimizationCurrent;
}

export function publishLatestHeatingPlan<
  TState extends PublishedHeatingPlanState<unknown, unknown>,
>(current: TState, next: TState): TState {
  if (!next.result || next.runId <= current.runId) {
    return current;
  }

  return next;
}

function normalizePlanHours(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((hour) => Number.isInteger(hour)))]
    .map(Number)
    .sort((first, second) => first - second);
}

export function areHeatingPlansOperationallyEqual(
  first: ComparableHeatingPlan | null | undefined,
  second: ComparableHeatingPlan | null | undefined,
) {
  return (
    first?.mode === second?.mode &&
    first?.plan_date === second?.plan_date &&
    first?.target_hours === second?.target_hours &&
    JSON.stringify(normalizePlanHours(first?.planned_hours)) ===
      JSON.stringify(normalizePlanHours(second?.planned_hours))
  );
}

export function getChangedHeatingPlans<T extends ComparableHeatingPlan>(
  currentPlans: Record<string, ComparableHeatingPlan | undefined>,
  nextPlans: T[],
) {
  return nextPlans.filter(
    (plan) =>
      !plan.plan_date ||
      !areHeatingPlansOperationallyEqual(
        currentPlans[plan.plan_date],
        plan,
      ),
  );
}

export type UnknownHeatingAnchor = {
  hourNumber: number;
  planDate: string;
};

// Computes the next unknownHeatingAnchorRef value for
// preserveCurrentHourWhileHeatingUnknown below. Must be called every time a
// tank_readings fetch resolves (success, query error, or thrown error) -
// not from a useEffect keyed on the `heating` state value, because two
// consecutive fetches can both resolve to heating=null (e.g. a persistent
// query error) without the STATE value ever changing, which would silently
// skip an effect but must not skip re-evaluating the anchor (Codex P1
// review, PR #147 follow-up).
//
// Prefers readingCreatedAt (the fetched row's own timestamp) over `now`:
// a fetch that straddles an hour boundary (typically an app cold start)
// can resolve after the boundary while the row it fetched - and the
// heating value it carries - is still genuinely from the hour before it.
// Anchoring to the reading's own hour degrades safely in that case: it
// names an hour that has already passed, which simply never matches
// "now" again in preserveCurrentHourWhileHeatingUnknown's comparison and
// so is never preserved, rather than wrongly anchoring the NEW current
// hour to status that was never actually observed for it. `now` is only
// used when there is no reading at all (a fetch that failed outright) -
// there is no row timestamp to prefer there.
export function computeNextUnknownHeatingAnchor({
  currentAnchor,
  heating,
  now,
  readingCreatedAt,
}: {
  currentAnchor: UnknownHeatingAnchor | null;
  heating: boolean | null;
  now: Date;
  readingCreatedAt: string | null;
}): UnknownHeatingAnchor | null {
  if (heating !== null) {
    return null;
  }

  if (currentAnchor !== null) {
    return currentAnchor;
  }

  const anchorInstant = readingCreatedAt ? new Date(readingCreatedAt) : now;

  return {
    hourNumber: getHelsinkiHourNumber(anchorInstant),
    planDate: formatHelsinkiDateKey(anchorInstant),
  };
}

// While the current hour's heating status is unknown (heating: null, e.g.
// ESP32 couldn't reach Shelly), an unrelated re-optimization must not be
// allowed to drop that hour from what's already published - the Shelly
// controller script turns the relay off the moment its own hour is missing
// from heating_plans, regardless of whether it's actually mid-cycle
// (Codex P1 review, PR #147). This only ever restores an hour that was
// ALREADY published for the current hour; it never adds a new hour, never
// touches any other hour, and never runs once heating is confirmed true or
// false again.
//
// unknownAnchorHourNumber must be the exact hour that was current the
// moment heating first became null (see index.tsx's unknownHeatingAnchorRef)
// - previousPlannedHours alone is not enough, since it can also contain
// hours that were merely scheduled for later that day. Without this extra
// check, a continuous null streak spanning an hour boundary could force-
// keep or even start a brand new hour's relay cycle on nothing but that
// streak, which is exactly the "don't add/continue future hours from null"
// guarantee this function must not violate (Codex P1 review, PR #147
// follow-up).
export function preserveCurrentHourWhileHeatingUnknown({
  currentHourNumber,
  heating,
  nextPlannedHours,
  previousPlannedHours,
  unknownAnchorHourNumber,
}: {
  currentHourNumber: number;
  heating: boolean | null;
  nextPlannedHours: number[];
  previousPlannedHours: number[];
  unknownAnchorHourNumber: number | null;
}): number[] {
  if (
    heating !== null ||
    unknownAnchorHourNumber !== currentHourNumber ||
    !previousPlannedHours.includes(currentHourNumber) ||
    nextPlannedHours.includes(currentHourNumber)
  ) {
    return nextPlannedHours;
  }

  return [...nextPlannedHours, currentHourNumber].sort(
    (first, second) => first - second,
  );
}

export function getHeatingPlanPresentationSource({
  hasPublishedOptimization,
  hasStoredPlan,
}: {
  hasPublishedOptimization: boolean;
  hasStoredPlan: boolean;
}) {
  if (hasPublishedOptimization) {
    return "optimizer" as const;
  }

  if (hasStoredPlan) {
    return "stored" as const;
  }

  return "none" as const;
}

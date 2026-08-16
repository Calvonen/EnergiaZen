// Pure orchestration layer around heatingPlanPublication.ts's safety
// primitives - the part of app/(tabs)/index.tsx's publish useEffect that
// decides WHAT to publish (today/tomorrow plan payloads, current-hour
// preservation while heating is unknown, duplicate-publish suppression)
// rather than HOW/WHEN a React component re-renders. Framework-agnostic
// (no React, no AsyncStorage) so it can run both in the app and in a
// Supabase Edge Function - see supabase/functions/run-heating-optimizer.
//
// This intentionally covers only the "automatic mode, optimizer produced a
// result" branch of index.tsx's publish effect. The "fixed" heating mode
// branch (selectHeatingRecommendation / getCheapestHours, no
// optimizeHeatingPlan involved) is out of scope here - see
// docs/PROJECT_CONTEXT.md and the backend-dependency notes in this repo's
// heating-optimizer shadow mode PR for why.
import type { HeatingOptimizationHour, HeatingOptimizationResult } from "./heatingOptimizer.ts";
import {
  computeNextUnknownHeatingAnchor,
  getChangedHeatingPlans,
  preserveCurrentHourWhileHeatingUnknown,
  shouldDeferHeatingPlanPublicationForUnknownStatus,
  type ComparableHeatingPlan,
  type UnknownHeatingAnchor,
} from "./heatingPlanPublication.ts";
import {
  getDateKeyOffset,
  getHelsinkiDateStart,
  getHelsinkiHourNumber,
} from "./heatingLogic.ts";

export type HeatingPlanDraft = {
  mode: "automatic";
  plan_date: string;
  planned_hours: number[];
  reason: string;
  target_hours: number;
  updated_at: string;
};

export type HeatingPlanPublicationDecision =
  | {
      status: "deferred";
      reason:
        | "today_plan_not_loaded"
        | "heating_status_unknown_and_unconfirmed"
        | "optimizer_result_unavailable";
    }
  | {
      status: "ready";
      today: HeatingPlanDraft;
      tomorrow: HeatingPlanDraft;
      /**
       * Subset of [today, tomorrow] that actually differ from storedPlans -
       * the rest are duplicate no-ops. Never contains a tomorrow entry when
       * tomorrowHasPriceData is false - see its own comment below.
       */
      changedPlans: HeatingPlanDraft[];
      /**
       * Whether `selectedHours` (the full optimizer input, not just the
       * chosen heating hours) covers tomorrowPlanDate's entire Helsinki-
       * local day with no gaps - see hasCompleteHelsinkiDayCoverage below
       * for the exact rule. False does NOT just mean zero tomorrow hours;
       * a non-empty but partial tomorrow window (e.g. only the first few
       * hours after midnight, because electricity_prices hadn't finished
       * receiving the rest yet) is also false - a plan computed from a
       * truncated tomorrow would silently miss real candidate hours later
       * in the day. False means tomorrow.planned_hours is [] only because
       * complete tomorrow price data was not available when this decision
       * was built - NOT because the optimizer looked at tomorrow's real,
       * complete prices and picked zero heating hours. Callers must not
       * publish a `tomorrow` draft built with this false as if it were a
       * genuine zero-heating decision (see run-heating-optimizer/index.ts
       * and its report for why: an empty-but-"healthy" tomorrow row is
       * indistinguishable from a real one to Shelly, which only checks
       * health_status + fingerprint, not how the row was derived).
       * Optional only so pre-existing test fixtures that hand-build a
       * "ready" decision without this field keep type-checking - every
       * decision actually produced by this function always sets it.
       */
      tomorrowHasCompletePriceData?: boolean;
    };

// Whether `hours` (the optimizer's full candidate input, not just its
// selected/heating subset) covers dateKey's entire Helsinki-local calendar
// day with no gaps: the earliest interval starts exactly at that day's
// Helsinki midnight, every interval is a contiguous 60-minute block (no
// overlaps, no holes), and the latest interval ends exactly at the NEXT
// Helsinki midnight. Deliberately NOT a fixed 24-row count check - Helsinki
// days are 23 or 25 real hours on the two annual DST transition days (see
// getHelsinkiDateStart) - so completeness is judged purely by the time
// boundaries and contiguity, the same way checkOptimizerReadiness
// (supabase/functions/run-heating-optimizer/logic.ts) already validates
// today's own coverage; this mirrors that rule for an arbitrary day instead
// of anchoring to `now`, since a future day like tomorrow has no "now" to
// anchor to.
//
// Exported (in addition to being used internally below) so the app's own
// Home screen can reuse this exact rule to decide whether tomorrow's prices
// are complete enough to show as "available" - see lib/heatingPlanOrchestration.ts's
// re-export and app/(tabs)/index.tsx. One canonical implementation, not a
// second parallel one - purely additive, no behavior change to this
// module's own callers (run-heating-optimizer).
export function hasCompleteHelsinkiDayCoverage(
  hours: HeatingOptimizationHour[],
  dateKey: string,
  dateKeyOf: (startDate: string) => string,
): boolean {
  const dayHours = hours
    .filter((hour) => dateKeyOf(hour.startDate) === dateKey)
    .sort((first, second) => first.date.getTime() - second.date.getTime());

  if (dayHours.length === 0) {
    return false;
  }

  const dayStart = getHelsinkiDateStart(dateKey);
  const dayEnd = getHelsinkiDateStart(getDateKeyOffset(1, dayStart));

  if (dayHours[0].date.getTime() !== dayStart.getTime()) {
    return false;
  }

  for (let index = 0; index < dayHours.length; index += 1) {
    const hour = dayHours[index];
    if (
      !Number.isFinite(hour.date.getTime()) ||
      !Number.isFinite(hour.endDate.getTime()) ||
      hour.endDate.getTime() - hour.date.getTime() !== 60 * 60 * 1000 ||
      (index > 0 && dayHours[index - 1].endDate.getTime() !== hour.date.getTime())
    ) {
      return false;
    }
  }

  return dayHours[dayHours.length - 1].endDate.getTime() === dayEnd.getTime();
}

function getHourNumbersForDate(
  selectedHours: HeatingOptimizationHour[],
  planDate: string,
  dateKeyOf: (startDate: string) => string,
) {
  return [
    ...new Set(
      selectedHours
        .filter((hour) => dateKeyOf(hour.startDate) === planDate)
        .map((hour) => getHelsinkiHourNumber(hour.date)),
    ),
  ].sort((first, second) => first - second);
}

// Mirrors the "isOptimizerPlanActive" branch of app/(tabs)/index.tsx's
// publish effect (heating_plans upsert), reusing the exact same
// heatingPlanPublication.ts primitives that effect uses, including every
// PR #147 safety fix (current-hour preservation while heating is unknown,
// stale/duplicate-publication suppression). Does not perform the actual
// Supabase read/write - callers pass in already-fetched state and receive
// back a plain decision to act on (or not act on, in shadow mode).
export function buildHeatingPlanPublicationDecision({
  currentHourNumber,
  dateKeyOf,
  hasAttemptedTankReadingFetch,
  heating,
  isTodayPlanLoaded,
  optimizerResult,
  optimizerSettings,
  now,
  selectedHours,
  storedPlans,
  todayPlanDate,
  tomorrowPlanDate,
  unknownHeatingAnchor,
}: {
  /** Helsinki-local hour number (0-23) for the instant this decision is being made. */
  currentHourNumber: number;
  /** Same convention as index.tsx's getFinnishDateKey. */
  dateKeyOf: (startDate: string) => string;
  hasAttemptedTankReadingFetch: boolean;
  heating: boolean | null;
  isTodayPlanLoaded: boolean;
  optimizerResult: HeatingOptimizationResult | null;
  optimizerSettings: { automaticMaxHeatingHours: number };
  now: Date;
  selectedHours: HeatingOptimizationHour[];
  storedPlans: Record<string, ComparableHeatingPlan | undefined>;
  todayPlanDate: string;
  tomorrowPlanDate: string;
  unknownHeatingAnchor: UnknownHeatingAnchor | null;
}): HeatingPlanPublicationDecision {
  if (
    shouldDeferHeatingPlanPublicationForUnknownStatus({
      hasAttemptedTankReadingFetch,
      heating,
      isTodayPlanLoaded,
    })
  ) {
    return {
      reason: !isTodayPlanLoaded
        ? "today_plan_not_loaded"
        : "heating_status_unknown_and_unconfirmed",
      status: "deferred",
    };
  }

  if (!optimizerResult) {
    return { reason: "optimizer_result_unavailable", status: "deferred" };
  }

  const selectedHourIds = new Set(optimizerResult.selectedHeatingHourIds);
  const selectedOptimizationHours = selectedHours.filter((hour) =>
    selectedHourIds.has(hour.id),
  );
  const todayHours = getHourNumbersForDate(
    selectedOptimizationHours,
    todayPlanDate,
    dateKeyOf,
  );
  const tomorrowHours = getHourNumbersForDate(
    selectedOptimizationHours,
    tomorrowPlanDate,
    dateKeyOf,
  );
  const unknownAnchorHourNumber =
    unknownHeatingAnchor !== null && unknownHeatingAnchor.planDate === todayPlanDate
      ? unknownHeatingAnchor.hourNumber
      : null;
  const previousTodayHours = normalizePlanHours(
    storedPlans[todayPlanDate]?.planned_hours,
  );
  const updatedAt = now.toISOString();
  const targetHours = selectedOptimizationHours.length;
  const reason = [
    `Optimointi valitsi ${targetHours} h yhteiselle aikaikkunalle.`,
    `Lämmitystuntien enimmäismäärä ${optimizerSettings.automaticMaxHeatingHours} h.`,
    `Tänään ${todayHours.length} h, huomenna ${tomorrowHours.length} h.`,
  ].join(" ");

  const today: HeatingPlanDraft = {
    mode: "automatic",
    plan_date: todayPlanDate,
    planned_hours: preserveCurrentHourWhileHeatingUnknown({
      currentHourNumber,
      heating,
      nextPlannedHours: todayHours,
      previousPlannedHours: previousTodayHours,
      unknownAnchorHourNumber,
    }),
    reason,
    target_hours: targetHours,
    updated_at: updatedAt,
  };
  const tomorrow: HeatingPlanDraft = {
    mode: "automatic",
    plan_date: tomorrowPlanDate,
    planned_hours: tomorrowHours,
    reason,
    target_hours: targetHours,
    updated_at: updatedAt,
  };

  // Signal, not a heuristic on tomorrowHours.length: a day with real,
  // COMPLETE tomorrow prices where the optimizer legitimately chose zero
  // heating hours also has tomorrowHours.length === 0, but
  // tomorrowHasCompletePriceData is true for it - that case must keep
  // publishing exactly as before. A single tomorrow-dated hour (or any
  // other partial, non-gapless subset of tomorrow's day) is NOT enough -
  // see hasCompleteHelsinkiDayCoverage above.
  const tomorrowHasCompletePriceData = hasCompleteHelsinkiDayCoverage(
    selectedHours,
    tomorrowPlanDate,
    dateKeyOf,
  );
  const allChangedPlans = getChangedHeatingPlans(storedPlans, [today, tomorrow]);
  // A tomorrow draft built from incomplete (including zero) optimizer-input
  // coverage for tomorrow is not a real "0 h needed tomorrow" decision - it
  // only means tomorrow's prices were not FULLY in electricity_prices yet
  // when this run's buildOptimizerHours ran. Publishing/overwriting the
  // stored tomorrow row with planned_hours: [] in that case would look
  // identical to a genuine zero-heating decision to every downstream reader
  // (Shelly's heartbeat/fingerprint check, this repo's own app UI), and a
  // plan computed from a truncated tomorrow window could also just be
  // wrong (missing real candidate hours later in the day) even when it
  // isn't empty - so such a draft must never be treated as a publishable
  // change. Today is never affected by this filter - only tomorrowPlanDate
  // can be removed from changedPlans - and canMarkHeatingPlanValidated/
  // heartbeat validation in run-heating-optimizer/index.ts keys exclusively
  // on todayPlanDate, so today's publication/validation behavior is
  // unchanged either way.
  const changedPlans = tomorrowHasCompletePriceData
    ? allChangedPlans
    : allChangedPlans.filter((plan) => plan.plan_date !== tomorrowPlanDate);

  return {
    changedPlans,
    status: "ready",
    today,
    tomorrow,
    tomorrowHasCompletePriceData,
  };
}

function normalizePlanHours(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((hour) => Number.isInteger(hour)))]
    .map(Number)
    .sort((first, second) => first - second);
}

// Thin re-export so callers only need this one module for the
// "unknown-heating anchor" primitive too - see heatingPlanPublication.ts
// for the full reasoning (PR #147).
export { computeNextUnknownHeatingAnchor };
export type { UnknownHeatingAnchor };

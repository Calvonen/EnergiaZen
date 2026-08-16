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
import { getHelsinkiHourNumber } from "./heatingLogic.ts";

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
       * chosen heating hours) contained at least one hour dated
       * tomorrowPlanDate. False means tomorrow.planned_hours is [] only
       * because electricity_prices had no rows for tomorrow yet when this
       * decision was built - NOT because the optimizer looked at tomorrow's
       * real prices and picked zero heating hours. Callers must not publish
       * a `tomorrow` draft built with this false as if it were a genuine
       * zero-heating decision (see run-heating-optimizer/index.ts and its
       * report for why: an empty-but-"healthy" tomorrow row is
       * indistinguishable from a real one to Shelly, which only checks
       * health_status + fingerprint, not how the row was derived).
       * Optional only so pre-existing test fixtures that hand-build a
       * "ready" decision without this field keep type-checking - every
       * decision actually produced by this function always sets it.
       */
      tomorrowHasPriceData?: boolean;
    };

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

  // Signal, not a heuristic on tomorrowHours.length: derived from whether
  // `selectedHours` (the optimizer's full candidate input, e.g.
  // buildOptimizerHours' output - NOT the optimizer's chosen subset) had
  // any tomorrow-dated hour at all. A day with real tomorrow prices where
  // the optimizer legitimately chose zero heating hours also has
  // tomorrowHours.length === 0, but tomorrowHasPriceData is true for it -
  // that case must keep publishing exactly as before.
  const tomorrowHasPriceData = selectedHours.some(
    (hour) => dateKeyOf(hour.startDate) === tomorrowPlanDate,
  );
  const allChangedPlans = getChangedHeatingPlans(storedPlans, [today, tomorrow]);
  // A tomorrow draft built from zero optimizer-input hours is not a real
  // "0 h needed tomorrow" decision - it only means tomorrow's prices were
  // not yet in electricity_prices when this run's buildOptimizerHours ran.
  // Publishing/overwriting the stored tomorrow row with planned_hours: []
  // in that case would look identical to a genuine zero-heating decision
  // to every downstream reader (Shelly's heartbeat/fingerprint check, this
  // repo's own app UI), so such a draft must never be treated as a
  // publishable change. Today is never affected by this filter - only
  // tomorrowPlanDate can be removed from changedPlans - and
  // canMarkHeatingPlanValidated/heartbeat validation in
  // run-heating-optimizer/index.ts keys exclusively on todayPlanDate, so
  // today's publication/validation behavior is unchanged either way.
  const changedPlans = tomorrowHasPriceData
    ? allChangedPlans
    : allChangedPlans.filter((plan) => plan.plan_date !== tomorrowPlanDate);

  return {
    changedPlans,
    status: "ready",
    today,
    tomorrow,
    tomorrowHasPriceData,
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

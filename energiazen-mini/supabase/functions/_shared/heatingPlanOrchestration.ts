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
      /** Subset of [today, tomorrow] that actually differ from storedPlans - the rest are duplicate no-ops. */
      changedPlans: HeatingPlanDraft[];
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

  return {
    changedPlans: getChangedHeatingPlans(storedPlans, [today, tomorrow]),
    status: "ready",
    today,
    tomorrow,
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

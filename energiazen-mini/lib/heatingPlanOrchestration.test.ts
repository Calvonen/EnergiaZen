import { buildHeatingPlanPublicationDecision } from "./heatingPlanOrchestration";
import type { HeatingOptimizationHour, HeatingOptimizationResult } from "./heatingOptimizer";
import type { ComparableHeatingPlan } from "./heatingPlanPublication";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function optimizerResult(
  selectedHeatingHourIds: string[],
): HeatingOptimizationResult {
  return {
    selectedHeatingHourIds,
  } as HeatingOptimizationResult;
}

export function runHeatingPlanOrchestrationUnitTests() {
  const todayPlanDate = "2026-08-12";
  const tomorrowPlanDate = "2026-08-13";
  const now = new Date("2026-08-12T13:30:00.000Z");
  const byId = new Map<string, { dateKey: string; helsinkiHour: number }>();
  const trackDateKeyOf = (startDate: string) => {
    const meta = byId.get(startDate);
    if (!meta) throw new Error(`Unmapped test hour ${startDate}`);
    return meta.dateKey;
  };
  function testHour(
    id: string,
    startDate: string,
    dateKey: string,
    helsinkiHour: number,
  ): HeatingOptimizationHour {
    byId.set(startDate, { dateKey, helsinkiHour });
    const date = new Date(startDate);
    return {
      date,
      endDate: new Date(date.getTime() + 60 * 60 * 1000),
      id,
      isCurrentHour: false,
      price: 5,
      segmentHours: 1,
      startDate,
    };
  }

  // 1. Deferred: today's stored plan hasn't loaded yet.
  assertEqual(
    buildHeatingPlanPublicationDecision({
      currentHourNumber: 14,
      dateKeyOf: trackDateKeyOf,
      hasAttemptedTankReadingFetch: true,
      heating: true,
      isTodayPlanLoaded: false,
      now,
      optimizerResult: optimizerResult([]),
      optimizerSettings: { automaticMaxHeatingHours: 3 },
      selectedHours: [],
      storedPlans: {},
      todayPlanDate,
      tomorrowPlanDate,
      unknownHeatingAnchor: null,
    }),
    { reason: "today_plan_not_loaded", status: "deferred" },
    "must defer until today's stored plan has loaded, matching heatingPlanPublication.ts",
  );

  // 2. Deferred: heating unknown and relay status never attempted.
  assertEqual(
    buildHeatingPlanPublicationDecision({
      currentHourNumber: 14,
      dateKeyOf: trackDateKeyOf,
      hasAttemptedTankReadingFetch: false,
      heating: null,
      isTodayPlanLoaded: true,
      now,
      optimizerResult: optimizerResult([]),
      optimizerSettings: { automaticMaxHeatingHours: 3 },
      selectedHours: [],
      storedPlans: {},
      todayPlanDate,
      tomorrowPlanDate,
      unknownHeatingAnchor: null,
    }),
    { reason: "heating_status_unknown_and_unconfirmed", status: "deferred" },
    "must defer while heating status is unknown and never confirmed once",
  );

  // 3. Deferred: no optimizer result yet (e.g. stale reading, missing inputs).
  assertEqual(
    buildHeatingPlanPublicationDecision({
      currentHourNumber: 14,
      dateKeyOf: trackDateKeyOf,
      hasAttemptedTankReadingFetch: true,
      heating: false,
      isTodayPlanLoaded: true,
      now,
      optimizerResult: null,
      optimizerSettings: { automaticMaxHeatingHours: 3 },
      selectedHours: [],
      storedPlans: {},
      todayPlanDate,
      tomorrowPlanDate,
      unknownHeatingAnchor: null,
    }),
    { reason: "optimizer_result_unavailable", status: "deferred" },
    "must defer (never publish stale/missing data) when the optimizer produced no result",
  );

  // 4. Ready: builds today/tomorrow plans from the optimizer's selected hours.
  const todayHourA = testHour("today-14", "2026-08-12T11:00:00.000Z", todayPlanDate, 14);
  const todayHourB = testHour("today-15", "2026-08-12T12:00:00.000Z", todayPlanDate, 15);
  const tomorrowHourA = testHour(
    "tomorrow-3",
    "2026-08-13T00:00:00.000Z",
    tomorrowPlanDate,
    3,
  );
  const readyDecision = buildHeatingPlanPublicationDecision({
    currentHourNumber: 14,
    dateKeyOf: trackDateKeyOf,
    hasAttemptedTankReadingFetch: true,
    heating: false,
    isTodayPlanLoaded: true,
    now,
    optimizerResult: optimizerResult(["today-14", "today-15", "tomorrow-3"]),
    optimizerSettings: { automaticMaxHeatingHours: 3 },
    selectedHours: [todayHourA, todayHourB, tomorrowHourA],
    storedPlans: {},
    todayPlanDate,
    tomorrowPlanDate,
    unknownHeatingAnchor: null,
  });
  assertEqual(readyDecision.status, "ready", "optimizer result + loaded plan must produce a ready decision");
  if (readyDecision.status === "ready") {
    assertEqual(readyDecision.today.plan_date, todayPlanDate, "today plan must use todayPlanDate");
    assertEqual(readyDecision.today.planned_hours, [14, 15], "today plan hours must come from selected optimizer hours");
    assertEqual(readyDecision.tomorrow.planned_hours, [3], "tomorrow plan hours must come from selected optimizer hours");
    assertEqual(readyDecision.today.target_hours, 3, "target_hours must equal the total selected hour count, matching index.tsx");
    assertEqual(readyDecision.changedPlans.length, 2, "both plans are new (no storedPlans yet) so both are changed");
  }

  // 5. Current-hour preservation: heating unknown mid-cycle must not drop
  // the hour the anchor points at, even though the optimizer's fresh result
  // no longer selects it (PR #147 safety, reused unmodified).
  const preservedDecision = buildHeatingPlanPublicationDecision({
    currentHourNumber: 14,
    dateKeyOf: trackDateKeyOf,
    hasAttemptedTankReadingFetch: true,
    heating: null,
    isTodayPlanLoaded: true,
    now,
    optimizerResult: optimizerResult(["today-15"]),
    optimizerSettings: { automaticMaxHeatingHours: 3 },
    selectedHours: [todayHourA, todayHourB],
    storedPlans: {
      [todayPlanDate]: { planned_hours: [14], plan_date: todayPlanDate } as ComparableHeatingPlan,
    },
    todayPlanDate,
    tomorrowPlanDate,
    unknownHeatingAnchor: { hourNumber: 14, planDate: todayPlanDate },
  });
  assertEqual(preservedDecision.status, "ready", "unknown heating with a prior confirmed hour must still be ready, not deferred");
  if (preservedDecision.status === "ready") {
    assertEqual(
      preservedDecision.today.planned_hours,
      [14, 15],
      "current hour 14 must be preserved from previousPlannedHours even though the fresh optimizer result dropped it",
    );
  }

  // 6. Duplicate suppression: identical plan vs. storedPlans yields no changed entries.
  const unchangedDecision = buildHeatingPlanPublicationDecision({
    currentHourNumber: 14,
    dateKeyOf: trackDateKeyOf,
    hasAttemptedTankReadingFetch: true,
    heating: false,
    isTodayPlanLoaded: true,
    now,
    optimizerResult: optimizerResult(["today-14"]),
    optimizerSettings: { automaticMaxHeatingHours: 3 },
    selectedHours: [todayHourA],
    storedPlans: {
      [todayPlanDate]: {
        mode: "automatic",
        plan_date: todayPlanDate,
        planned_hours: [14],
        target_hours: 1,
      } as ComparableHeatingPlan,
      [tomorrowPlanDate]: {
        mode: "automatic",
        plan_date: tomorrowPlanDate,
        planned_hours: [],
        target_hours: 1,
      } as ComparableHeatingPlan,
    },
    todayPlanDate,
    tomorrowPlanDate,
    unknownHeatingAnchor: null,
  });
  assertEqual(unchangedDecision.status, "ready", "identical plan must still be a ready decision");
  if (unchangedDecision.status === "ready") {
    assertEqual(
      unchangedDecision.changedPlans.length,
      0,
      "identical plans vs. storedPlans must be suppressed as duplicates, matching getChangedHeatingPlans",
    );
  }
}

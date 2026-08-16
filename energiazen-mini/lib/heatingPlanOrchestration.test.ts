import { buildHeatingPlanPublicationDecision } from "./heatingPlanOrchestration";
import type { HeatingOptimizationHour, HeatingOptimizationResult } from "./heatingOptimizer";
import type { ComparableHeatingPlan } from "./heatingPlanPublication";
import { getDateKeyOffset, getHelsinkiDateStart } from "./heatingLogic";

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

  // Every contiguous 60-minute hour of dateKey's actual Helsinki-local day
  // (23/24/25 hours depending on DST - never a hardcoded 24), registered in
  // the same byId map trackDateKeyOf reads from.
  function buildFullDayHours(
    dateKey: string,
    priceCentsPerKwh: number,
  ): HeatingOptimizationHour[] {
    const dayStart = getHelsinkiDateStart(dateKey);
    const dayEnd = getHelsinkiDateStart(getDateKeyOffset(1, dayStart));
    const hours: HeatingOptimizationHour[] = [];

    for (
      let cursor = dayStart.getTime();
      cursor < dayEnd.getTime();
      cursor += 60 * 60 * 1000
    ) {
      const date = new Date(cursor);
      const startDate = date.toISOString();
      byId.set(startDate, { dateKey, helsinkiHour: hours.length });
      hours.push({
        date,
        endDate: new Date(cursor + 60 * 60 * 1000),
        id: startDate,
        isCurrentHour: false,
        price: priceCentsPerKwh,
        segmentHours: 1,
        startDate,
      });
    }

    return hours;
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

  // 4. Ready: builds today/tomorrow plans from the optimizer's selected
  // hours. Tomorrow uses a FULL day of hours here (not a single one) so
  // tomorrowHasCompletePriceData is true and both plans are treated as
  // publishable changes, matching this test's original intent.
  const todayHourA = testHour("today-14", "2026-08-12T11:00:00.000Z", todayPlanDate, 14);
  const todayHourB = testHour("today-15", "2026-08-12T12:00:00.000Z", todayPlanDate, 15);
  const tomorrowFullDay = buildFullDayHours(tomorrowPlanDate, 5);
  const readyDecision = buildHeatingPlanPublicationDecision({
    currentHourNumber: 14,
    dateKeyOf: trackDateKeyOf,
    hasAttemptedTankReadingFetch: true,
    heating: false,
    isTodayPlanLoaded: true,
    now,
    optimizerResult: optimizerResult(["today-14", "today-15", tomorrowFullDay[3].id]),
    optimizerSettings: { automaticMaxHeatingHours: 3 },
    selectedHours: [todayHourA, todayHourB, ...tomorrowFullDay],
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
    assertEqual(readyDecision.tomorrowHasCompletePriceData, true, "a full tomorrow day of hours must report complete coverage");
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

  // 6a. Missing tomorrow price data: selectedHours (the optimizer's full
  // candidate input) has zero tomorrow-dated hours, so tomorrow's draft
  // must be diagnostically computed (planned_hours: []) but must NOT enter
  // changedPlans - an existing, previously-published real tomorrow plan
  // must not be silently replaced by a fabricated "0 h" one just because
  // this run's input never had tomorrow's prices. (Regression test 1.)
  const tomorrowStoredPlan: ComparableHeatingPlan = {
    mode: "automatic",
    plan_date: tomorrowPlanDate,
    planned_hours: [3, 4],
    target_hours: 2,
  };
  const zeroTomorrowHoursDecision = buildHeatingPlanPublicationDecision({
    currentHourNumber: 14,
    dateKeyOf: trackDateKeyOf,
    hasAttemptedTankReadingFetch: true,
    heating: false,
    isTodayPlanLoaded: true,
    now,
    optimizerResult: optimizerResult(["today-14"]),
    optimizerSettings: { automaticMaxHeatingHours: 3 },
    // Only today-dated hours in the optimizer's input - tomorrow's prices
    // were never fetched, matching electricity_prices having no rows yet.
    selectedHours: [todayHourA],
    storedPlans: {
      [todayPlanDate]: {
        mode: "automatic",
        plan_date: todayPlanDate,
        planned_hours: [15],
        target_hours: 1,
      } as ComparableHeatingPlan,
      [tomorrowPlanDate]: tomorrowStoredPlan,
    },
    todayPlanDate,
    tomorrowPlanDate,
    unknownHeatingAnchor: null,
  });
  assertEqual(
    zeroTomorrowHoursDecision.status,
    "ready",
    "zero tomorrow-dated input hours must still produce a ready decision for today",
  );
  if (zeroTomorrowHoursDecision.status === "ready") {
    assertEqual(
      zeroTomorrowHoursDecision.tomorrowHasCompletePriceData,
      false,
      "no tomorrow-dated hour anywhere in selectedHours must report tomorrowHasCompletePriceData: false",
    );
    assertEqual(
      zeroTomorrowHoursDecision.tomorrow.planned_hours,
      [],
      "the diagnostic tomorrow draft itself stays [] when there is nothing to select from",
    );
    assertEqual(
      zeroTomorrowHoursDecision.changedPlans.some(
        (plan) => plan.plan_date === tomorrowPlanDate,
      ),
      false,
      "a tomorrow draft built from zero input hours must never be published/overwrite the stored tomorrow plan",
    );
    assertEqual(
      zeroTomorrowHoursDecision.changedPlans.some(
        (plan) => plan.plan_date === todayPlanDate,
      ),
      true,
      "today's own genuinely changed plan must still publish normally alongside the suppressed tomorrow draft",
    );
  }

  // R2. Partial-but-gapless tomorrow coverage: only the first few hours
  // after Helsinki midnight are present (e.g. electricity_prices still
  // mid-ingest) - this must NOT count as complete, even though it is a
  // real, contiguous, midnight-anchored subset and not merely "zero hours".
  const partialTomorrowHours = buildFullDayHours(tomorrowPlanDate, 5).slice(0, 10);
  const partialTomorrowDecision = buildHeatingPlanPublicationDecision({
    currentHourNumber: 14,
    dateKeyOf: trackDateKeyOf,
    hasAttemptedTankReadingFetch: true,
    heating: false,
    isTodayPlanLoaded: true,
    now,
    optimizerResult: optimizerResult(["today-14"]),
    optimizerSettings: { automaticMaxHeatingHours: 3 },
    selectedHours: [todayHourA, ...partialTomorrowHours],
    storedPlans: { [tomorrowPlanDate]: tomorrowStoredPlan },
    todayPlanDate,
    tomorrowPlanDate,
    unknownHeatingAnchor: null,
  });
  assertEqual(partialTomorrowDecision.status, "ready", "a partial tomorrow window must still produce a ready decision for today");
  if (partialTomorrowDecision.status === "ready") {
    assertEqual(
      partialTomorrowDecision.tomorrowHasCompletePriceData,
      false,
      "a midnight-anchored but truncated (10 of tomorrow's hours) window must report tomorrowHasCompletePriceData: false",
    );
    assertEqual(
      partialTomorrowDecision.changedPlans.some((plan) => plan.plan_date === tomorrowPlanDate),
      false,
      "a plan computed from a truncated tomorrow window must never overwrite the stored tomorrow plan - it could miss real candidate hours later in the day",
    );
  }

  // R3. Tomorrow fully covered (real data): the optimizer's own selection
  // for tomorrow must publish normally.
  const completeTomorrowHours = buildFullDayHours(tomorrowPlanDate, 5);
  const completeTomorrowDecision = buildHeatingPlanPublicationDecision({
    currentHourNumber: 14,
    dateKeyOf: trackDateKeyOf,
    hasAttemptedTankReadingFetch: true,
    heating: false,
    isTodayPlanLoaded: true,
    now,
    optimizerResult: optimizerResult(["today-14", completeTomorrowHours[3].id]),
    optimizerSettings: { automaticMaxHeatingHours: 3 },
    selectedHours: [todayHourA, ...completeTomorrowHours],
    storedPlans: { [tomorrowPlanDate]: tomorrowStoredPlan },
    todayPlanDate,
    tomorrowPlanDate,
    unknownHeatingAnchor: null,
  });
  assertEqual(completeTomorrowDecision.status, "ready", "a fully covered tomorrow day must produce a ready decision");
  if (completeTomorrowDecision.status === "ready") {
    assertEqual(
      completeTomorrowDecision.tomorrowHasCompletePriceData,
      true,
      "a gapless, midnight-to-midnight tomorrow window must report tomorrowHasCompletePriceData: true",
    );
    assertEqual(completeTomorrowDecision.tomorrow.planned_hours, [3], "tomorrow's selected hour must come through unchanged");
    assertEqual(
      completeTomorrowDecision.changedPlans.some((plan) => plan.plan_date === tomorrowPlanDate),
      true,
      "a plan computed from a complete tomorrow window must publish normally, replacing the old stored tomorrow plan",
    );
  }

  // R4. Tomorrow fully covered but the optimizer genuinely selects 0 h for
  // it - this must publish exactly as before, since it is a real decision
  // made from real, complete data, not a missing one.
  const genuineZeroTomorrowDecision = buildHeatingPlanPublicationDecision({
    currentHourNumber: 14,
    dateKeyOf: trackDateKeyOf,
    hasAttemptedTankReadingFetch: true,
    heating: false,
    isTodayPlanLoaded: true,
    now,
    // Only today-14 selected - every one of tomorrow's hours was offered
    // but none was chosen.
    optimizerResult: optimizerResult(["today-14"]),
    optimizerSettings: { automaticMaxHeatingHours: 3 },
    selectedHours: [todayHourA, ...buildFullDayHours(tomorrowPlanDate, 5)],
    storedPlans: { [tomorrowPlanDate]: tomorrowStoredPlan },
    todayPlanDate,
    tomorrowPlanDate,
    unknownHeatingAnchor: null,
  });
  assertEqual(
    genuineZeroTomorrowDecision.status,
    "ready",
    "a complete tomorrow day where the optimizer chose nothing must still be ready",
  );
  if (genuineZeroTomorrowDecision.status === "ready") {
    assertEqual(
      genuineZeroTomorrowDecision.tomorrowHasCompletePriceData,
      true,
      "a complete tomorrow window must report tomorrowHasCompletePriceData: true even when zero hours were selected",
    );
    assertEqual(
      genuineZeroTomorrowDecision.tomorrow.planned_hours,
      [],
      "the optimizer's own genuine zero-hour choice for tomorrow stays []",
    );
    assertEqual(
      genuineZeroTomorrowDecision.changedPlans.some(
        (plan) => plan.plan_date === tomorrowPlanDate,
      ),
      true,
      "a genuine zero-heating-hours decision for tomorrow (real, complete price data, optimizer chose none) must publish normally, replacing the old stored tomorrow plan",
    );
  }

  // R5. DST: a tomorrowPlanDate whose real Helsinki-local day is not 24
  // hours must still be recognized as complete from full coverage (and as
  // incomplete once truncated) - no hardcoded 24-hour/24-row assumption.
  for (
    const dstFixture of [
      { dateKey: "2026-03-29", expectedHourCount: 23 }, // spring-forward
      { dateKey: "2026-10-25", expectedHourCount: 25 }, // fall-back
    ]
  ) {
    const dstTodayPlanDate = getDateKeyOffset(-1, getHelsinkiDateStart(dstFixture.dateKey));
    const dstNow = new Date(getHelsinkiDateStart(dstTodayPlanDate).getTime() + 60 * 60 * 1000);
    const dstTodayHour = testHour(
      "dst-today-0",
      getHelsinkiDateStart(dstTodayPlanDate).toISOString(),
      dstTodayPlanDate,
      0,
    );
    const dstFullDay = buildFullDayHours(dstFixture.dateKey, 5);
    assertEqual(
      dstFullDay.length,
      dstFixture.expectedHourCount,
      `DST fixture ${dstFixture.dateKey} must have its real Helsinki day length, not a hardcoded 24`,
    );

    const dstCompleteDecision = buildHeatingPlanPublicationDecision({
      currentHourNumber: 0,
      dateKeyOf: trackDateKeyOf,
      hasAttemptedTankReadingFetch: true,
      heating: false,
      isTodayPlanLoaded: true,
      now: dstNow,
      optimizerResult: optimizerResult([]),
      optimizerSettings: { automaticMaxHeatingHours: 3 },
      selectedHours: [dstTodayHour, ...dstFullDay],
      storedPlans: { [dstFixture.dateKey]: tomorrowStoredPlan },
      todayPlanDate: dstTodayPlanDate,
      tomorrowPlanDate: dstFixture.dateKey,
      unknownHeatingAnchor: null,
    });
    assertEqual(dstCompleteDecision.status, "ready", `DST fixture ${dstFixture.dateKey}: full coverage must be ready`);
    if (dstCompleteDecision.status === "ready") {
      assertEqual(
        dstCompleteDecision.tomorrowHasCompletePriceData,
        true,
        `DST fixture ${dstFixture.dateKey}: a full real-length day must report complete coverage`,
      );
    }

    const dstTruncatedDecision = buildHeatingPlanPublicationDecision({
      currentHourNumber: 0,
      dateKeyOf: trackDateKeyOf,
      hasAttemptedTankReadingFetch: true,
      heating: false,
      isTodayPlanLoaded: true,
      now: dstNow,
      optimizerResult: optimizerResult([]),
      optimizerSettings: { automaticMaxHeatingHours: 3 },
      selectedHours: [dstTodayHour, ...dstFullDay.slice(0, -1)],
      storedPlans: { [dstFixture.dateKey]: tomorrowStoredPlan },
      todayPlanDate: dstTodayPlanDate,
      tomorrowPlanDate: dstFixture.dateKey,
      unknownHeatingAnchor: null,
    });
    assertEqual(
      dstTruncatedDecision.status === "ready" && dstTruncatedDecision.tomorrowHasCompletePriceData,
      false,
      `DST fixture ${dstFixture.dateKey}: missing the final real-length hour must not be reported as complete`,
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

import {
  buildHeatingPlanFingerprint,
  buildHeatingPlanPublicationDecision,
  buildOptimizerHours,
  buildShadowRunRow,
  buildStoredPlansMap,
  checkOptimizerReadiness,
  createHeatingOptimizationSettings,
  getDateKeyOffset,
  getHelsinkiDateStart,
  latestPriceFetchedAt,
  resolveHourlyDropProfile,
  resolveOptimizerSettings,
  runBackendHeatingOptimization,
  wasHeartbeatCompareAndSetCommitted,
  type HeatingPlanPublicationDecision,
  type RawElectricityPriceRow,
  type RawHeatingControlSettingsRow,
  type RawHeatingPlanRow,
  type RawTankReading,
} from "./logic";
import { optimizeHeatingPlan } from "../../../lib/heatingOptimizer";
import { getFinnishDateKey, getHelsinkiHourNumber } from "../../../lib/heatingLogic";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

// Every hour from `fromHour` through `toHour` (inclusive, plain UTC hour on
// `dateKey`), one row each, all at the same price for a simple fixture.
// Callers must keep toHour <= 20 so the UTC->Helsinki (+3h in August)
// conversion never spills into the next calendar day - see
// getFinnishDateKey.
function priceRowsForDay(
  dateKey: string,
  fromHour: number,
  toHour: number,
  priceCentsPerKwh: number,
): RawElectricityPriceRow[] {
  const rows: RawElectricityPriceRow[] = [];

  for (let hour = fromHour; hour <= toHour; hour += 1) {
    const startsAt = `${dateKey}T${String(hour).padStart(2, "0")}:00:00.000Z`;
    const endsAt = new Date(new Date(startsAt).getTime() + 60 * 60 * 1000).toISOString();

    rows.push({ ends_at: endsAt, spot_price_cents_kwh: priceCentsPerKwh, starts_at: startsAt });
  }

  return rows;
}

function priceRowsBetween(start: Date, end: Date): RawElectricityPriceRow[] {
  const rows: RawElectricityPriceRow[] = [];
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += 60 * 60 * 1000) {
    rows.push({
      ends_at: new Date(cursor + 60 * 60 * 1000).toISOString(),
      spot_price_cents_kwh: 4,
      starts_at: new Date(cursor).toISOString(),
    });
  }
  return rows;
}

export function runRunHeatingOptimizerLogicUnitTests() {
  assertEqual(
    wasHeartbeatCompareAndSetCommitted(true),
    true,
    "literal true is the only committed heartbeat RPC result",
  );
  for (const lostOwnershipResult of [false, null, undefined, "true", 1]) {
    assertEqual(
      wasHeartbeatCompareAndSetCommitted(lostOwnershipResult),
      false,
      "false or malformed RPC data must never look heartbeat-committed",
    );
  }
  // Fixed instant used across the fixtures below: 2026-08-12T11:30:00Z is
  // 14:30 in Helsinki (EEST, UTC+3) in August.
  const now = new Date("2026-08-12T11:30:00.000Z");
  const todayPlanDate = "2026-08-12";
  const tomorrowPlanDate = "2026-08-13";
  const freshReading: RawTankReading = {
    bottom_temp: 35,
    created_at: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    heating: false,
    top_temp: 40,
  };
  const settingsRow: RawHeatingControlSettingsRow = {
    full_tank_average_temperature: 70,
    full_tank_showers: 6,
    max_tank_temperature: 70,
    min_tank_temperature: 10,
    target_shower_reserve: 4,
  };
  // UTC hours here are all treated as if they were the price API's own
  // starts_at/ends_at values - buildOptimizerHours only cares about
  // getFinnishDateKey(startsAt) and the raw endsAt/startsAt instants, not
  // about which literal UTC hour they carry, so plain UTC fixture rows are
  // fine as long as their Helsinki date key matches the intended day.
  const todayPrices = priceRowsForDay(todayPlanDate, 11, 20, 5); // 11:00Z.. = 14:00 Helsinki onward
  const tomorrowPrices = [
    ...priceRowsForDay(todayPlanDate, 21, 23, 3),
    ...priceRowsForDay(tomorrowPlanDate, 0, 20, 3),
  ];

  // 1. Full tomorrow prices + fresh tank reading -> backend optimizer
  // produces a plan (readiness ok, a HeatingOptimizationResult comes back).
  {
    const hours = buildOptimizerHours(
      [...todayPrices, ...tomorrowPrices],
      now,
      todayPlanDate,
      tomorrowPlanDate,
    );
    assert(hours.length > 0, "fixture must contain price hours for both days");
    const { settings } = resolveOptimizerSettings(settingsRow);
    const optimizationSettings = createHeatingOptimizationSettings(settings, 4.5);
    const run = runBackendHeatingOptimization({
      heatingGainHistory: [],
      hourlyDrops: {},
      hours,
      isCurrentlyHeating: false,
      latestReading: freshReading,
      now,
      settings: optimizationSettings,
    });

    assertEqual(run.readiness, { ok: true }, "fresh reading + available prices must be ready");
    assert(run.result !== null, "a ready run must produce an optimizer result");
    assert(
      Array.isArray(run.result?.selectedHeatingHourIds),
      "optimizer result must carry selectedHeatingHourIds",
    );
  }

  // 2. Tomorrow's prices are missing entirely -> today-only hours are still
  // usable (today's own price hours are non-empty), but there is nothing to
  // publish for tomorrowPlanDate; the plan decision must say so clearly
  // rather than silently publishing an empty/fabricated tomorrow plan.
  {
    const hours = buildOptimizerHours(todayPrices, now, todayPlanDate, tomorrowPlanDate);
    const tomorrowHours = hours.filter(
      (hour) => getFinnishDateKey(hour.startDate) === tomorrowPlanDate,
    );
    assertEqual(tomorrowHours.length, 0, "fixture must have zero tomorrow price hours");

    const { settings } = resolveOptimizerSettings(settingsRow);
    const optimizationSettings = createHeatingOptimizationSettings(settings, 4.5);
    const run = runBackendHeatingOptimization({
      heatingGainHistory: [],
      hourlyDrops: {},
      hours,
      isCurrentlyHeating: false,
      latestReading: freshReading,
      now,
      settings: optimizationSettings,
    });

    if (run.result) {
      const decision = buildHeatingPlanPublicationDecision({
        currentHourNumber: getHelsinkiHourNumber(now),
        dateKeyOf: getFinnishDateKey,
        hasAttemptedTankReadingFetch: true,
        heating: false,
        isTodayPlanLoaded: true,
        now,
        optimizerResult: run.result,
        optimizerSettings: { automaticMaxHeatingHours: optimizationSettings.maxHeatingHours },
        selectedHours: hours,
        storedPlans: {},
        todayPlanDate,
        tomorrowPlanDate,
        unknownHeatingAnchor: null,
      });
      assertEqual(decision.status, "ready", "today-only prices must still produce a decision");
      if (decision.status === "ready") {
        assertEqual(
          decision.tomorrow.planned_hours,
          [],
          "with zero tomorrow price hours, tomorrow's plan must have zero planned hours, not a fabricated one",
        );
      }
    }
  }

  // 3. Stale tank reading -> not treated as a reliable input, readiness
  // fails with an explicit reason instead of silently using old data.
  {
    const staleReading: RawTankReading = {
      ...freshReading,
      created_at: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
    };
    const readiness = checkOptimizerReadiness({
      latestReading: staleReading,
      now,
      priceHours: buildOptimizerHours(todayPrices, now, todayPlanDate, tomorrowPlanDate),
    });
    assertEqual(readiness, { ok: false, reason: "stale_tank_reading" }, "a 6h-old reading must be rejected as stale");
  }

  // Present but stale or holey price rows are not usable coverage.
  {
    const stalePrices = priceRowsForDay(todayPlanDate, 0, 5, 1);
    assertEqual(
      checkOptimizerReadiness({ latestReading: freshReading, now, priceHours: buildOptimizerHours(stalePrices, now, todayPlanDate, tomorrowPlanDate) }),
      { ok: false, reason: "no_price_hours_available" },
      "rows that end before now must not make the optimizer ready",
    );
    const holeyHours = buildOptimizerHours(todayPrices, now, todayPlanDate, tomorrowPlanDate).filter((_hour, index) => index !== 2);
    assertEqual(
      checkOptimizerReadiness({ latestReading: freshReading, now, priceHours: holeyHours }),
      { ok: false, reason: "incomplete_price_coverage" },
      "a gap in present prices must fail readiness",
    );
    assertEqual(
      checkOptimizerReadiness({ latestReading: freshReading, now, priceHours: buildOptimizerHours([...todayPrices, ...tomorrowPrices], now, todayPlanDate, tomorrowPlanDate) }),
      { ok: true },
      "contiguous coverage retains existing ready behavior",
    );
    const completeTodayHours = buildOptimizerHours(
      todayPrices,
      now,
      todayPlanDate,
      tomorrowPlanDate,
    );
    assertEqual(
      checkOptimizerReadiness({ latestReading: freshReading, now, priceHours: completeTodayHours }),
      { ok: true },
      "complete remaining today coverage is ready without tomorrow prices",
    );
    assertEqual(
      checkOptimizerReadiness({ latestReading: freshReading, now, priceHours: completeTodayHours.slice(0, 4) }),
      { ok: false, reason: "incomplete_price_coverage" },
      "a truncated current-plus-few-hours window must not be ready",
    );
    assertEqual(
      checkOptimizerReadiness({ latestReading: freshReading, now, priceHours: completeTodayHours.slice(0, -1) }),
      { ok: false, reason: "incomplete_price_coverage" },
      "missing the final hour before local day end must not be ready",
    );
    const validHours = buildOptimizerHours([...todayPrices, ...tomorrowPrices], now, todayPlanDate, tomorrowPlanDate);
    assertEqual(
      checkOptimizerReadiness({ latestReading: freshReading, now, priceHours: [validHours[0], validHours[0], ...validHours.slice(1)] }),
      { ok: false, reason: "incomplete_price_coverage" },
      "duplicate price rows must invalidate coverage",
    );
    const overlappingHours = validHours.map((hour) => ({ ...hour }));
    overlappingHours[1] = { ...overlappingHours[1], date: new Date(overlappingHours[1].date.getTime() - 30 * 60 * 1000) };
    assertEqual(
      checkOptimizerReadiness({ latestReading: freshReading, now, priceHours: overlappingHours }),
      { ok: false, reason: "incomplete_price_coverage" },
      "overlapping price intervals must invalidate coverage",
    );
    assertEqual(buildHeatingPlanFingerprint("2026-08-13", [5, 2, 5]), "2026-08-13|2,5", "plan fingerprint normalizes and sorts hours");
  }

  // Helsinki day-end coverage uses actual IANA-zone midnights. The spring
  // transition day is 23 real hours and the autumn transition day is 25.
  for (const fixture of [
    { dateKey: "2026-03-29", expectedHours: 23 },
    { dateKey: "2026-10-25", expectedHours: 25 },
  ]) {
    const dayStart = getHelsinkiDateStart(fixture.dateKey);
    const nextDateKey = getDateKeyOffset(1, new Date(dayStart.getTime() + 12 * 60 * 60 * 1000));
    const dayEnd = getHelsinkiDateStart(nextDateKey);
    assertEqual(
      (dayEnd.getTime() - dayStart.getTime()) / (60 * 60 * 1000),
      fixture.expectedHours,
      "DST fixture must have its real Helsinki day length",
    );
    const dstNow = new Date(dayStart.getTime() + 30 * 60 * 1000);
    const dstReading = { ...freshReading, created_at: dstNow.toISOString() };
    const dstHours = buildOptimizerHours(
      priceRowsBetween(dayStart, dayEnd),
      dstNow,
      fixture.dateKey,
      nextDateKey,
    );
    assertEqual(
      checkOptimizerReadiness({ latestReading: dstReading, now: dstNow, priceHours: dstHours }),
      { ok: true },
      "full DST-day remainder must reach the actual next Helsinki midnight",
    );
    assertEqual(
      checkOptimizerReadiness({ latestReading: dstReading, now: dstNow, priceHours: dstHours.slice(0, -1) }),
      { ok: false, reason: "incomplete_price_coverage" },
      "truncated DST-day remainder must fail coverage",
    );
  }

  // 4. Heating status unknown -> the publication decision defers rather
  // than risk dropping/adding the current hour on an unconfirmed read,
  // unless it was already attempted once (PR #147 safety, unmodified).
  {
    const decision = buildHeatingPlanPublicationDecision({
      currentHourNumber: 14,
      dateKeyOf: getFinnishDateKey,
      hasAttemptedTankReadingFetch: false,
      heating: null,
      isTodayPlanLoaded: true,
      now,
      optimizerResult: null,
      optimizerSettings: { automaticMaxHeatingHours: 3 },
      selectedHours: [],
      storedPlans: {},
      todayPlanDate,
      tomorrowPlanDate,
      unknownHeatingAnchor: null,
    });
    assertEqual(
      decision,
      { reason: "heating_status_unknown_and_unconfirmed", status: "deferred" },
      "unknown heating status without a completed fetch attempt must defer",
    );
  }

  // 5. Backend and app must reach the same planned_hours from identical
  // fixture inputs: build the settings/hours/dropProfile the way the
  // backend does, then call optimizeHeatingPlan a second, independent way
  // (mirroring how app/(tabs)/index.tsx would build the same call) and
  // compare selectedHeatingHourIds.
  {
    const hours = buildOptimizerHours(
      [...todayPrices, ...tomorrowPrices],
      now,
      todayPlanDate,
      tomorrowPlanDate,
    );
    const { settings } = resolveOptimizerSettings(settingsRow);
    const optimizationSettings = createHeatingOptimizationSettings(settings, 4.5);
    const dropProfile = resolveHourlyDropProfile({
      localReadings: [],
      now,
      storedProfile: null,
    });
    const backendRun = runBackendHeatingOptimization({
      heatingGainHistory: [],
      hourlyDrops: dropProfile.hourlyDrops,
      hours,
      isCurrentlyHeating: false,
      latestReading: freshReading,
      now,
      settings: optimizationSettings,
    });

    // Independently reconstructed "app-equivalent" call: same
    // optimizeHeatingPlan, same settings/hours/temps, built without going
    // through runBackendHeatingOptimization at all.
    const appEquivalentResult = optimizeHeatingPlan({
      currentBottomTemperature: freshReading.bottom_temp as number,
      currentTopTemperature: freshReading.top_temp as number,
      currentWeightedTemperature:
        (freshReading.top_temp as number) * 0.7 + (freshReading.bottom_temp as number) * 0.3,
      hourlyDrops: dropProfile.hourlyDrops,
      hours: hours.map((hour) => ({
        ...hour,
        isCurrentHour:
          hour.date.getTime() <= now.getTime() && hour.endDate.getTime() > now.getTime(),
      })),
      isCurrentlyHeating: false,
      recoveryDropEnabled: false,
      settings: optimizationSettings,
      tankReadings: [],
    });

    assertEqual(
      backendRun.result?.selectedHeatingHourIds,
      appEquivalentResult.selectedHeatingHourIds,
      "backend and an independently-built app-equivalent call must select the exact same hours from identical fixtures",
    );
  }

  // latestPriceFetchedAt: reports how stale electricity_prices itself is,
  // independent of how far into the future its rows happen to reach.
  assertEqual(
    latestPriceFetchedAt([
      { ends_at: "x", fetched_at: "2026-08-12T09:00:00.000Z", spot_price_cents_kwh: 1, starts_at: "a" },
      { ends_at: "x", fetched_at: "2026-08-12T13:10:00.000Z", spot_price_cents_kwh: 1, starts_at: "b" },
      { ends_at: "x", fetched_at: null, spot_price_cents_kwh: 1, starts_at: "c" },
    ]),
    "2026-08-12T13:10:00.000Z",
    "must report the newest fetched_at among the rows, ignoring rows without one",
  );
  assertEqual(latestPriceFetchedAt([]), null, "no price rows means no fetched_at to report");

  // buildStoredPlansMap / buildShadowRunRow: sanity-check the shadow row
  // shape and the app-vs-backend match/mismatch comparison.
  {
    const storedPlans = buildStoredPlansMap([
      { plan_date: todayPlanDate, planned_hours: [14, 15] } as RawHeatingPlanRow,
    ]);
    assertEqual(storedPlans[todayPlanDate]?.planned_hours, [14, 15], "buildStoredPlansMap must index by plan_date");

    const matchingDecision = buildHeatingPlanPublicationDecision({
      currentHourNumber: 14,
      dateKeyOf: getFinnishDateKey,
      hasAttemptedTankReadingFetch: true,
      heating: false,
      isTodayPlanLoaded: true,
      now,
      optimizerResult: { selectedHeatingHourIds: [] } as never,
      optimizerSettings: { automaticMaxHeatingHours: 3 },
      selectedHours: [],
      storedPlans: {},
      todayPlanDate,
      tomorrowPlanDate,
      unknownHeatingAnchor: null,
    });
    const row = buildShadowRunRow({
      appTodayPlan: { mode: "automatic", plan_date: todayPlanDate, planned_hours: [] } as RawHeatingPlanRow,
      decision: matchingDecision,
      heatingStatus: false,
      inputPriceFetchedAt: now.toISOString(),
      now,
      optimizerResult: null,
      readinessReason: null,
      settingsSource: "heating_control_settings+defaults",
      tankReadingAt: freshReading.created_at,
      todayPlanDate,
      tomorrowPlanDate,
    });
    assertEqual(row.source, "backend_shadow", "shadow row source must always be backend_shadow");
    assertEqual(row.planned_hours_match, true, "identical empty automatic-mode plans on both sides must match");
    assertEqual(row.uncertainty_reason, null, "confirmed heating status must not carry the stateless-anchor uncertainty note");
  }

  // PR #189 review fix 1: today/tomorrow must be derived from the Helsinki
  // calendar date via getDateKeyOffset, not a fixed +24h instant shift,
  // which silently breaks across DST transitions.
  {
    // 1. An ordinary day, no DST edge nearby.
    assertEqual(getDateKeyOffset(0, now), todayPlanDate, "ordinary day: today must be the current Helsinki calendar date");
    assertEqual(getDateKeyOffset(1, now), tomorrowPlanDate, "ordinary day: tomorrow must be the next Helsinki calendar date");

    // 2. DST spring-forward (Europe/Helsinki, 2026-03-29 03:00 EET ->
    // 04:00 EEST). 2026-03-28T21:30:00Z is 2026-03-28 23:30 in Helsinki
    // (still EET, UTC+2). A naive +24h instant shift lands at
    // 2026-03-29T21:30:00Z, which is already EEST (UTC+3) and formats as
    // 2026-03-30 in Helsinki - one calendar day too far, exactly the
    // "tomorrow jumps a day" bug from the review.
    const springForwardNow = new Date("2026-03-28T21:30:00.000Z");
    assertEqual(getDateKeyOffset(0, springForwardNow), "2026-03-28", "spring-forward eve: today must stay 2026-03-28");
    assertEqual(getDateKeyOffset(1, springForwardNow), "2026-03-29", "spring-forward eve: tomorrow must be the next Helsinki calendar day, not skip one");

    // 3. DST fall-back (Europe/Helsinki, 2026-10-25 04:00 EEST ->
    // 03:00 EET). 2026-10-24T21:30:00Z is 2026-10-25 00:30 in Helsinki
    // (still EEST, UTC+3, before that day's fall-back). A naive +24h
    // instant shift lands at 2026-10-25T21:30:00Z, which is already EET
    // (UTC+2) and formats as 2026-10-25 again in Helsinki - today and
    // tomorrow collapse onto the same calendar date, exactly the
    // "today === tomorrow" bug from the review.
    const fallBackNow = new Date("2026-10-24T21:30:00.000Z");
    assertEqual(getDateKeyOffset(0, fallBackNow), "2026-10-25", "fall-back day: today must be 2026-10-25");
    assertEqual(getDateKeyOffset(1, fallBackNow), "2026-10-26", "fall-back day: tomorrow must be the next Helsinki calendar day, not repeat today");

    // 4. today_plan_date !== tomorrow_plan_date must hold across all of the
    // instants above, including both DST edges.
    for (const instant of [now, springForwardNow, fallBackNow]) {
      assert(
        getDateKeyOffset(0, instant) !== getDateKeyOffset(1, instant),
        `today and tomorrow plan dates must never be equal (instant: ${instant.toISOString()})`,
      );
    }
  }

  // PR #189 review fix 2: planned_hours_match must only compare against an
  // app plan published in automatic mode - the backend never runs fixed
  // mode, so a fixed-mode app plan is not a meaningful parity signal.
  {
    function readyDecision(todayHours: number[]): HeatingPlanPublicationDecision {
      const draft = {
        mode: "automatic" as const,
        plan_date: todayPlanDate,
        planned_hours: todayHours,
        reason: "test fixture",
        target_hours: todayHours.length,
        updated_at: now.toISOString(),
      };
      const tomorrowDraft = { ...draft, plan_date: tomorrowPlanDate, planned_hours: [] };
      return { changedPlans: [], status: "ready", today: draft, tomorrow: tomorrowDraft };
    }

    function shadowRowFor(
      appTodayPlan: RawHeatingPlanRow | null,
      backendHours: number[],
    ) {
      return buildShadowRunRow({
        appTodayPlan,
        decision: readyDecision(backendHours),
        heatingStatus: false,
        inputPriceFetchedAt: now.toISOString(),
        now,
        optimizerResult: null,
        readinessReason: null,
        settingsSource: "heating_control_settings+defaults",
        tankReadingAt: freshReading.created_at,
        todayPlanDate,
        tomorrowPlanDate,
      });
    }

    // 1. automatic app plan + same hours -> true.
    assertEqual(
      shadowRowFor({ mode: "automatic", plan_date: todayPlanDate, planned_hours: [14, 15] }, [14, 15])
        .planned_hours_match,
      true,
      "automatic app plan with identical hours must match",
    );

    // 2. automatic app plan + different hours -> false.
    assertEqual(
      shadowRowFor({ mode: "automatic", plan_date: todayPlanDate, planned_hours: [14, 15] }, [10, 11])
        .planned_hours_match,
      false,
      "automatic app plan with different hours must mismatch",
    );

    // 3. fixed app plan + same hours -> null (not a meaningful comparison).
    assertEqual(
      shadowRowFor({ mode: "fixed", plan_date: todayPlanDate, planned_hours: [14, 15] }, [14, 15])
        .planned_hours_match,
      null,
      "fixed-mode app plan must never report a match, even with coincidentally identical hours",
    );

    // 4. fixed app plan + different hours -> null (not a false mismatch either).
    assertEqual(
      shadowRowFor({ mode: "fixed", plan_date: todayPlanDate, planned_hours: [14, 15] }, [10, 11])
        .planned_hours_match,
      null,
      "fixed-mode app plan must never report a mismatch",
    );

    // 5. missing app plan -> null.
    assertEqual(
      shadowRowFor(null, [14, 15]).planned_hours_match,
      null,
      "missing app plan must report null, not a match or mismatch",
    );

    // app_planned_hours_today stays populated for diagnostics even when the
    // mode makes it unsuitable for the match flag, and app_plan_mode
    // records which mode was actually compared (or null when there was no
    // app plan at all).
    const fixedRow = shadowRowFor(
      { mode: "fixed", plan_date: todayPlanDate, planned_hours: [14, 15] },
      [10, 11],
    );
    assertEqual(fixedRow.app_planned_hours_today, [14, 15], "app_planned_hours_today must stay visible for diagnostics regardless of mode");
    assertEqual(fixedRow.app_plan_mode, "fixed", "app_plan_mode must record the app plan's actual mode");
    assertEqual(shadowRowFor(null, [14, 15]).app_plan_mode, null, "app_plan_mode must be null when there is no app plan");
  }
}

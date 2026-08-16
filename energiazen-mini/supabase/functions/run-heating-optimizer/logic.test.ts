import {
  buildHeatingPlanFingerprint,
  buildExpectedElectricityPriceSnapshot,
  buildExpectedHeatingPlanVersions,
  buildExpectedOptimizerSettingsSnapshot,
  buildExpectedTankSnapshot,
  buildHeatingPlanPublicationDecision,
  buildOptimizerHours,
  buildShadowRunRow,
  buildStoredPlansMap,
  canMarkHeatingPlanValidated,
  checkOptimizerReadiness,
  combineBackendPublicationReadiness,
  createHeatingOptimizationSettings,
  doesHeartbeatRunTokenMatch,
  failedOptimizerInputFetch,
  getDateKeyOffset,
  getHelsinkiDateStart,
  latestPriceFetchedAt,
  isHeatingOptimizerCronSecretAuthorized,
  maxTankSnapshotPublicationRetries,
  resolveHourlyDropProfile,
  resolveOptimizerInputFetchReadiness,
  resolveOptimizerSettings,
  resolveTankSnapshotRetryAction,
  runBackendHeatingOptimization,
  successfulOptimizerInputFetch,
  wasHeartbeatCompareAndSetCommitted,
  type HeatingPlanPublicationDecision,
  type RawElectricityPriceRow,
  type RawHeatingControlSettingsRow,
  type RawHeatingPlanRow,
  type RawTankReading,
} from "./logic";
import { optimizeHeatingPlan, type HeatingOptimizationResult } from "../../../lib/heatingOptimizer";
import { getFinnishDateKey, getHelsinkiHourNumber } from "../../../lib/heatingLogic";
import type { ComparableHeatingPlan } from "../_shared/heatingPlanPublication";

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

    rows.push({ ends_at: endsAt, resolution_minutes: 60, spot_price_cents_kwh: priceCentsPerKwh, starts_at: startsAt });
  }

  return rows;
}

function priceRowsBetween(start: Date, end: Date): RawElectricityPriceRow[] {
  const rows: RawElectricityPriceRow[] = [];
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += 60 * 60 * 1000) {
    rows.push({
      ends_at: new Date(cursor + 60 * 60 * 1000).toISOString(),
      resolution_minutes: 60,
      spot_price_cents_kwh: 4,
      starts_at: new Date(cursor).toISOString(),
    });
  }
  return rows;
}

export function runRunHeatingOptimizerLogicUnitTests() {
  assertEqual(
    isHeatingOptimizerCronSecretAuthorized("private-cron-secret", "private-cron-secret"),
    true,
    "matching private cron secret authorizes the optimizer request",
  );
  for (const [provided, expected] of [
    [null, "private-cron-secret"],
    ["wrong-secret", "private-cron-secret"],
    ["publishable-key-only", undefined],
    ["", "private-cron-secret"],
  ] as const) {
    assertEqual(
      isHeatingOptimizerCronSecretAuthorized(provided, expected),
      false,
      "missing, wrong or merely publishable credentials must not authorize the optimizer",
    );
  }
  assertEqual(
    maxTankSnapshotPublicationRetries,
    1,
    "normal tank snapshot races must have exactly one deterministic retry",
  );
  assertEqual(
    doesHeartbeatRunTokenMatch({
      currentRunId: "run-1",
      currentRunStartedAt: "2026-08-13T10:00:00+00:00",
      expectedRunId: "run-1",
      expectedRunStartedAt: "2026-08-13T10:00:00.000Z",
    }),
    true,
    "heartbeat ownership must compare timestamptz instants rather than their JSON spelling",
  );
  assertEqual(
    doesHeartbeatRunTokenMatch({
      currentRunId: "newer-run",
      currentRunStartedAt: "2026-08-13T10:01:00+00:00",
      expectedRunId: "run-1",
      expectedRunStartedAt: "2026-08-13T10:00:00.000Z",
    }),
    false,
    "a newer heartbeat token must supersede the retrying run",
  );
  assertEqual(
    resolveTankSnapshotRetryAction({
      attemptIndex: 0,
      publicationResult: "tank_snapshot_conflict",
      stillOwnsRun: true,
    }),
    "retry",
    "the first owned tank snapshot conflict must retry",
  );
  assertEqual(
    resolveTankSnapshotRetryAction({
      attemptIndex: 1,
      publicationResult: "tank_snapshot_conflict",
      stillOwnsRun: true,
    }),
    "retry_exhausted",
    "a second tank conflict must exhaust the one-retry budget",
  );
  assertEqual(
    resolveTankSnapshotRetryAction({
      attemptIndex: 0,
      publicationResult: "tank_snapshot_conflict",
      stillOwnsRun: false,
    }),
    "superseded",
    "a superseded run must not retry a tank conflict",
  );
  for (const publicationResult of [
    "settings_conflict",
    "plan_conflict",
    "price_snapshot_conflict",
    "relay_conflict",
  ]) {
    assertEqual(
      resolveTankSnapshotRetryAction({
        attemptIndex: 0,
        publicationResult,
        stillOwnsRun: true,
      }),
      "terminal",
      `${publicationResult} must not enter the tank retry path`,
    );
  }
  {
    type SimulatedPublicationResult =
      | "heartbeat_superseded"
      | "no_changes"
      | "published"
      | "tank_snapshot_conflict";
    function simulateTankRetry(
      publicationResults: SimulatedPublicationResult[],
      readingIds: string[],
      stillOwnsRun = true,
    ) {
      const optimizedReadingIds: string[] = [];

      for (let attemptIndex = 0; attemptIndex < publicationResults.length; attemptIndex += 1) {
        optimizedReadingIds.push(readingIds[attemptIndex]);
        const publicationResult = publicationResults[attemptIndex];
        const retryAction = resolveTankSnapshotRetryAction({
          attemptIndex,
          publicationResult,
          stillOwnsRun,
        });
        if (retryAction === "retry") continue;
        if (retryAction === "superseded") {
          return {
            finalReadingId: readingIds[attemptIndex],
            health: "superseded",
            optimizedReadingIds,
            timestampsAdvanced: false,
            wrotePlan: false,
          };
        }
        if (retryAction === "retry_exhausted") {
          return {
            finalReadingId: readingIds[attemptIndex],
            health: "unhealthy/deferred",
            optimizedReadingIds,
            timestampsAdvanced: false,
            wrotePlan: false,
          };
        }
        return {
          finalReadingId: readingIds[attemptIndex],
          health: "healthy",
          optimizedReadingIds,
          timestampsAdvanced: true,
          wrotePlan: publicationResult === "published",
        };
      }

      throw new Error("simulated tank retry did not reach a final outcome");
    }

    assertEqual(
      simulateTankRetry(
        ["tank_snapshot_conflict", "published"],
        ["old-reading", "fresh-reading"],
      ),
      {
        finalReadingId: "fresh-reading",
        health: "healthy",
        optimizedReadingIds: ["old-reading", "fresh-reading"],
        timestampsAdvanced: true,
        wrotePlan: true,
      },
      "retry publication must rerun against and publish the fresh reading snapshot",
    );
    assertEqual(
      simulateTankRetry(
        ["tank_snapshot_conflict", "no_changes"],
        ["old-reading", "fresh-reading"],
      ),
      {
        finalReadingId: "fresh-reading",
        health: "healthy",
        optimizedReadingIds: ["old-reading", "fresh-reading"],
        timestampsAdvanced: true,
        wrotePlan: false,
      },
      "retry no_changes must validate the fresh reading snapshot without a plan write",
    );
    assertEqual(
      simulateTankRetry(
        ["tank_snapshot_conflict", "tank_snapshot_conflict"],
        ["old-reading", "newer-reading"],
      ),
      {
        finalReadingId: "newer-reading",
        health: "unhealthy/deferred",
        optimizedReadingIds: ["old-reading", "newer-reading"],
        timestampsAdvanced: false,
        wrotePlan: false,
      },
      "retry exhaustion must remain unhealthy and must not write or advance validation state",
    );
    assertEqual(
      simulateTankRetry(
        ["tank_snapshot_conflict", "published"],
        ["old-reading", "must-not-run"],
        false,
      ),
      {
        finalReadingId: "old-reading",
        health: "superseded",
        optimizedReadingIds: ["old-reading"],
        timestampsAdvanced: false,
        wrotePlan: false,
      },
      "a superseding run must stop before another optimizer attempt",
    );
  }
  assertEqual(
    buildExpectedTankSnapshot({
      bottom_temp: 45,
      created_at: "2026-08-13T10:00:00.000Z",
      heating: false,
      top_temp: 55,
    }),
    {
      bottom_temp: 45,
      created_at: "2026-08-13T10:00:00.000Z",
      heating: false,
      top_temp: 55,
    },
    "tank snapshot must carry every current reading value used by the optimizer",
  );
  assertEqual(
    buildExpectedTankSnapshot({
      bottom_temp: 45,
      created_at: "2026-08-13T10:00:00.000Z",
      heating: null,
      top_temp: 55,
    }),
    {
      bottom_temp: 45,
      created_at: "2026-08-13T10:00:00.000Z",
      heating: null,
      top_temp: 55,
    },
    "unknown original relay state must remain unknown in the full tank snapshot",
  );

  {
    const emptyGainHistory = successfulOptimizerInputFetch({ readings: [] });
    const emptyRecoveryHistory = successfulOptimizerInputFetch({ readings: [] });
    const missingDropProfile = successfulOptimizerInputFetch(null);
    const successfulEmptyReadiness = resolveOptimizerInputFetchReadiness([
      emptyGainHistory,
      emptyRecoveryHistory,
      missingDropProfile,
    ]);

    assertEqual(
      successfulEmptyReadiness,
      { failedReasons: [], ok: true, reason: null },
      "successful empty optimizer inputs must remain publication-ready",
    );
    assertEqual(
      [emptyGainHistory.value, emptyRecoveryHistory.value, missingDropProfile.value],
      [{ readings: [] }, { readings: [] }, null],
      "successful empty gain/recovery data and a missing drop profile keep intended fallback values",
    );

    for (const reason of [
      "heating_gain_history_fetch_failed",
      "recovery_history_fetch_failed",
      "drop_profile_fetch_failed",
    ] as const) {
      const failedFetch = failedOptimizerInputFetch(reason, null);
      assertEqual(
        resolveOptimizerInputFetchReadiness([failedFetch]),
        { failedReasons: [reason], ok: false, reason },
        `${reason} must block publication and preserve its diagnostic reason`,
      );
      assertEqual(
        failedFetch.value,
        null,
        `${reason} may still expose its fallback value for shadow calculation`,
      );
    }

    const multipleFailures = resolveOptimizerInputFetchReadiness([
      failedOptimizerInputFetch("heating_gain_history_fetch_failed", []),
      failedOptimizerInputFetch("recovery_history_fetch_failed", []),
      successfulOptimizerInputFetch(null),
    ]);
    assertEqual(
      multipleFailures,
      {
        failedReasons: [
          "heating_gain_history_fetch_failed",
          "recovery_history_fetch_failed",
        ],
        ok: false,
        reason:
          "optimizer_input_fetch_failed:heating_gain_history_fetch_failed,recovery_history_fetch_failed",
      },
      "multiple optimizer input failures must retain every source in deterministic order",
    );
    assertEqual(
      combineBackendPublicationReadiness(
        { ok: true, reason: null },
        multipleFailures,
      ),
      { ok: false, reason: multipleFailures.reason },
      "input failure must close the central publication readiness gate",
    );
    assertEqual(
      combineBackendPublicationReadiness(
        { ok: false, reason: "settings_incomplete" },
        successfulEmptyReadiness,
      ),
      { ok: false, reason: "settings_incomplete" },
      "successful input fetches must preserve existing settings fail-safe behavior",
    );
  }

  assertEqual(
    canMarkHeatingPlanValidated(true, true, false),
    true,
    "known heating=true may validate an otherwise valid unchanged plan",
  );
  assertEqual(
    canMarkHeatingPlanValidated(false, true, false),
    true,
    "known heating=false may validate an otherwise valid unchanged plan",
  );
  assertEqual(
    canMarkHeatingPlanValidated(false, true, true),
    false,
    "a changed today plan must remain unvalidated",
  );
  assertEqual(
    canMarkHeatingPlanValidated(false, true, false),
    true,
    "unchanged today remains valid independently of optional tomorrow changes",
  );
  const optionalTomorrowChange = { plan_date: "2026-08-13" };
  assertEqual(
    canMarkHeatingPlanValidated(
      false,
      true,
      [optionalTomorrowChange].some((plan) => plan.plan_date === "2026-08-12"),
    ),
    true,
    "a tomorrow-only draft change must not block today's healthy validation",
  );
  assertEqual(
    buildHeatingPlanFingerprint("2026-08-12", [2, 5]),
    "2026-08-12|2,5",
    "today validation fingerprints only the stored today plan identity",
  );
  for (const unknownHeating of [null, undefined]) {
    assertEqual(
      canMarkHeatingPlanValidated(unknownHeating, true, true),
      false,
      "unknown relay status must never be treated as false for heartbeat validation",
    );
  }
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
    automatic_max_heating_hours: 5,
    full_tank_average_temperature: 70,
    full_tank_showers: 6,
    heating_gain_source: "learned",
    heating_need_mode: "automatic",
    max_tank_temperature: 70,
    min_tank_temperature: 10,
    safety_shower_reserve: 2,
    target_shower_reserve: 4,
    updated_at: "2026-08-12T09:00:00.000Z",
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
      heatingGainSource: "learned",
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
      heatingGainSource: "learned",
      hours,
      isCurrentlyHeating: false,
      latestReading: freshReading,
      now,
      settings: optimizationSettings,
    });

    if (run.result) {
      // storedPlans is empty (no prior tomorrow row) AND a prior, real
      // tomorrow row case, so both "nothing published yet" and "would
      // overwrite an existing real plan" are covered.
      const priorTomorrowPlan: ComparableHeatingPlan = {
        mode: "automatic",
        plan_date: tomorrowPlanDate,
        planned_hours: [3, 4, 5],
        target_hours: 3,
      };
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
        storedPlans: { [tomorrowPlanDate]: priorTomorrowPlan },
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
        assertEqual(
          decision.tomorrowHasPriceData,
          false,
          "zero tomorrow-dated hours in the optimizer's input must report tomorrowHasPriceData: false",
        );
        assertEqual(
          decision.changedPlans.some((plan) => plan.plan_date === tomorrowPlanDate),
          false,
          "a fabricated empty tomorrow draft must never be published/overwrite the previously stored real tomorrow plan (regression test 1)",
        );
        assertEqual(
          decision.changedPlans.some((plan) => plan.plan_date === todayPlanDate),
          true,
          "today's own publication must be entirely unaffected by tomorrow's missing price data (regression test 3)",
        );
      }
    }
  }

  // 2b. Both today's and tomorrow's prices are available and the optimizer
  // genuinely selects zero heating hours for tomorrow (e.g. every tomorrow
  // hour fails a safety/price check) - this must publish exactly like
  // before, since real price data was actually used to reach that decision.
  {
    const hours = buildOptimizerHours(
      [...todayPrices, ...tomorrowPrices],
      now,
      todayPlanDate,
      tomorrowPlanDate,
    );
    const tomorrowHours = hours.filter(
      (hour) => getFinnishDateKey(hour.startDate) === tomorrowPlanDate,
    );
    assert(tomorrowHours.length > 0, "fixture must have real tomorrow price hours for this case");

    const decision = buildHeatingPlanPublicationDecision({
      currentHourNumber: getHelsinkiHourNumber(now),
      dateKeyOf: getFinnishDateKey,
      hasAttemptedTankReadingFetch: true,
      heating: false,
      isTodayPlanLoaded: true,
      now,
      // Optimizer result that only ever selects today's hours, even though
      // tomorrow's hours were fully present in `hours` - simulates a
      // genuine "optimizer looked at tomorrow and chose nothing" outcome
      // without depending on optimizeHeatingPlan's own selection heuristics.
      optimizerResult: {
        selectedHeatingHourIds: hours
          .filter((hour) => getFinnishDateKey(hour.startDate) === todayPlanDate)
          .slice(0, 1)
          .map((hour) => hour.id),
      } as HeatingOptimizationResult,
      optimizerSettings: { automaticMaxHeatingHours: 5 },
      selectedHours: hours,
      storedPlans: {
        [tomorrowPlanDate]: {
          mode: "automatic",
          plan_date: tomorrowPlanDate,
          planned_hours: [3, 4, 5],
          target_hours: 3,
        } as ComparableHeatingPlan,
      },
      todayPlanDate,
      tomorrowPlanDate,
      unknownHeatingAnchor: null,
    });
    assertEqual(decision.status, "ready", "full today+tomorrow coverage must produce a ready decision");
    if (decision.status === "ready") {
      assertEqual(
        decision.tomorrowHasPriceData,
        true,
        "real tomorrow price hours in the optimizer's input must report tomorrowHasPriceData: true even when none were selected",
      );
      assertEqual(
        decision.tomorrow.planned_hours,
        [],
        "the optimizer's own genuine zero-hour choice for tomorrow stays []",
      );
      assertEqual(
        decision.changedPlans.some((plan) => plan.plan_date === tomorrowPlanDate),
        true,
        "a genuine zero-heating-hours tomorrow decision (real price data, optimizer chose none) must publish normally (regression test 2)",
      );
    }
  }

  // 2c. Day rollover with literally zero price rows for the new "today" -
  // checkOptimizerReadiness (unmodified by this change) must keep failing
  // closed exactly as before, so the existing unhealthy/deferred heartbeat
  // path (and, downstream, Shelly's unmodified 3-cycle control-plane
  // debounce into backup_hours) still engages (regression test 4).
  {
    const readinessWithNoPricesAtAll = checkOptimizerReadiness({
      latestReading: freshReading,
      now,
      priceHours: [],
    });
    assertEqual(
      readinessWithNoPricesAtAll,
      { ok: false, reason: "no_price_hours_available" },
      "zero price rows for the current day (e.g. a rollover with no new-day data yet) must still fail readiness, unchanged by this PR",
    );
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
    const quarterHourRows = priceRowsBetween(
      new Date("2026-08-12T11:00:00.000Z"),
      new Date("2026-08-12T13:00:00.000Z"),
    ).flatMap((row) => {
      const start = new Date(row.starts_at).getTime();
      return [0, 15, 30, 45].map((offsetMinutes) => ({
        ...row,
        ends_at: new Date(start + (offsetMinutes + 15) * 60 * 1000).toISOString(),
        resolution_minutes: 15,
        starts_at: new Date(start + offsetMinutes * 60 * 1000).toISOString(),
      }));
    });
    assertEqual(
      buildOptimizerHours(
        [...todayPrices, ...quarterHourRows],
        now,
        todayPlanDate,
        tomorrowPlanDate,
      ).length,
      completeTodayHours.length,
      "mixed 15-minute rows must not disturb supported 60-minute optimizer input",
    );
    assertEqual(
      buildOptimizerHours(quarterHourRows, now, todayPlanDate, tomorrowPlanDate),
      [],
      "15-minute-only prices must leave the hourly optimizer not ready",
    );
    const expectedPriceSnapshot = buildExpectedElectricityPriceSnapshot(
      completeTodayHours,
    );
    assertEqual(
      expectedPriceSnapshot.length,
      completeTodayHours.length,
      "price snapshot must contain exactly the rows passed to the optimizer",
    );
    assertEqual(
      expectedPriceSnapshot[0],
      {
        ends_at: completeTodayHours[0].endDate.toISOString(),
        region: "FI",
        resolution_minutes: 60,
        spot_price_cents_kwh: completeTodayHours[0].price,
        starts_at: completeTodayHours[0].startDate,
      },
      "price snapshot must preserve each used interval and price canonically",
    );
    assert(
      expectedPriceSnapshot.every((price) => price.resolution_minutes === 60),
      "15-minute rows must never enter the hourly optimizer price snapshot",
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
      heatingGainSource: "learned",
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
      { ends_at: "x", resolution_minutes: 60, fetched_at: "2026-08-12T09:00:00.000Z", spot_price_cents_kwh: 1, starts_at: "a" },
      { ends_at: "x", resolution_minutes: 60, fetched_at: "2026-08-12T13:10:00.000Z", spot_price_cents_kwh: 1, starts_at: "b" },
      { ends_at: "x", resolution_minutes: 60, fetched_at: null, spot_price_cents_kwh: 1, starts_at: "c" },
    ]),
    "2026-08-12T13:10:00.000Z",
    "must report the newest fetched_at among the rows, ignoring rows without one",
  );
  assertEqual(latestPriceFetchedAt([]), null, "no price rows means no fetched_at to report");

  // Backend-primary publication must only use settings genuinely present in
  // heating_control_settings, and only while the user mode is automatic.
  {
    const automaticResolution = resolveOptimizerSettings(settingsRow);
    assertEqual(
      automaticResolution.publicationReadiness,
      { ok: true, reason: null },
      "automatic mode with every optimizer setting present is publication-ready",
    );
    assertEqual(
      automaticResolution.settingsSource,
      "heating_control_settings",
      "complete settings must not be reported as defaults-backed",
    );
    assertEqual(
      automaticResolution.settings.automaticMaxHeatingHours,
      5,
      "backend must use the user's Supabase automaticMaxHeatingHours value, not defaultSettings",
    );
    assertEqual(
      automaticResolution.settings.safetyShowerReserve,
      2,
      "backend must use the user's Supabase safetyShowerReserve value",
    );
    assertEqual(
      buildExpectedOptimizerSettingsSnapshot(settingsRow),
      {
        automatic_max_heating_hours: 5,
        full_tank_average_temperature: 70,
        full_tank_showers: 6,
        heating_gain_source: "learned",
        heating_need_mode: "automatic",
        max_tank_temperature: 70,
        min_tank_temperature: 10,
        safety_shower_reserve: 2,
        target_shower_reserve: 4,
        updated_at: "2026-08-12T09:00:00.000Z",
      },
      "settings snapshot must include every backend-primary optimizer setting and updated_at",
    );
    assertEqual(
      buildExpectedOptimizerSettingsSnapshot(null),
      null,
      "missing settings row cannot produce a publication settings snapshot",
    );

    const fixedGainResolution = resolveOptimizerSettings({
      ...settingsRow,
      heating_gain_source: "fixed",
    });
    assertEqual(
      fixedGainResolution.heatingGainSource,
      "fixed",
      "backend must use the synchronized Supabase gain source instead of a stale learned/default value",
    );

    const fixedResolution = resolveOptimizerSettings({
      ...settingsRow,
      heating_need_mode: "fixed",
    });
    assertEqual(
      fixedResolution.publicationReadiness,
      { ok: false, reason: "control_mode_not_automatic" },
      "fixed mode must block backend-primary publication even when changedPlans exist",
    );
    assertEqual(
      fixedResolution.settingsSource,
      "heating_control_settings",
      "fixed mode with complete settings is blocked by mode, not by defaults",
    );

    for (const [field, row] of [
      [
        "automaticMaxHeatingHours",
        { ...settingsRow, automatic_max_heating_hours: null },
      ],
      ["safetyShowerReserve", { ...settingsRow, safety_shower_reserve: null }],
      ["heatingGainSource", { ...settingsRow, heating_gain_source: null }],
    ] as const) {
      const resolution = resolveOptimizerSettings(row);
      assertEqual(
        resolution.publicationReadiness,
        { ok: false, reason: "settings_incomplete" },
        `${field} missing must block publication`,
      );
      assertEqual(
        resolution.settingsSource,
        "heating_control_settings+defaults",
        `${field} missing must not be reported as publication-ready settings_source`,
      );
    }

    for (const row of [
      null,
      { ...settingsRow, heating_need_mode: null },
      { ...settingsRow, heating_need_mode: "manual" },
    ]) {
      const resolution = resolveOptimizerSettings(row);
      assertEqual(
        resolution.publicationReadiness.ok,
        false,
        "missing/unknown/invalid control mode must fail safe",
      );
    }

    // price_tolerance_cents: missing/null DB value falls back to 0 (today's
    // behaviour, unchanged) and never blocks publication readiness - it is
    // not one of the required optimizer settings.
    assertEqual(
      resolveOptimizerSettings(settingsRow).settings.priceToleranceCents,
      0,
      "fixture row without price_tolerance_cents falls back to 0",
    );
    assertEqual(
      resolveOptimizerSettings({ ...settingsRow, price_tolerance_cents: null })
        .settings.priceToleranceCents,
      0,
      "explicit null price_tolerance_cents falls back to 0",
    );
    assertEqual(
      resolveOptimizerSettings({ ...settingsRow, price_tolerance_cents: 1.5 })
        .settings.priceToleranceCents,
      1.5,
      "a configured price_tolerance_cents value is threaded through to the optimizer settings",
    );
    assertEqual(
      resolveOptimizerSettings({ ...settingsRow, price_tolerance_cents: null })
        .publicationReadiness,
      { ok: true, reason: null },
      "missing price_tolerance_cents must not block backend-primary publication readiness",
    );
  }

  // buildStoredPlansMap / buildShadowRunRow: sanity-check the shadow row
  // shape and the app-vs-backend match/mismatch comparison.
  {
    const storedPlans = buildStoredPlansMap([
      {
        plan_date: todayPlanDate,
        planned_hours: [14, 15],
        updated_at: "2026-08-12T10:00:00.000Z",
      } as RawHeatingPlanRow,
    ]);
    assertEqual(storedPlans[todayPlanDate]?.planned_hours, [14, 15], "buildStoredPlansMap must index by plan_date");
    assertEqual(
      buildExpectedHeatingPlanVersions(
        [
          { plan_date: tomorrowPlanDate },
        ],
        [
          {
            plan_date: todayPlanDate,
            planned_hours: [14, 15],
            updated_at: "2026-08-12T10:00:00.000Z",
          },
        ] as RawHeatingPlanRow[],
        todayPlanDate,
      ),
      [
        {
          expected_planned_hours: [14, 15],
          expected_updated_at: "2026-08-12T10:00:00.000Z",
          existed: true,
          plan_date: todayPlanDate,
        },
        {
          expected_planned_hours: null,
          expected_updated_at: null,
          existed: false,
          plan_date: tomorrowPlanDate,
        },
      ],
      "expected plan versions must include validated today even when only tomorrow is changed",
    );
    assertEqual(
      buildExpectedHeatingPlanVersions(
        [],
        [
          {
            plan_date: todayPlanDate,
            planned_hours: [14, 15],
            updated_at: "2026-08-12T10:00:00.000Z",
          },
        ] as RawHeatingPlanRow[],
        todayPlanDate,
      ),
      [
        {
          expected_planned_hours: [14, 15],
          expected_updated_at: "2026-08-12T10:00:00.000Z",
          existed: true,
          plan_date: todayPlanDate,
        },
      ],
      "no_changes must still carry today's version and content identity",
    );
    assertEqual(
      buildExpectedHeatingPlanVersions([], [], todayPlanDate),
      [
        {
          expected_planned_hours: null,
          expected_updated_at: null,
          existed: false,
          plan_date: todayPlanDate,
        },
      ],
      "no_changes must preserve an absent-today snapshot for conflict detection",
    );

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

import {
  buildHeatingPlanPublicationDecision,
  buildOptimizerHours,
  buildShadowRunRow,
  buildStoredPlansMap,
  checkOptimizerReadiness,
  createHeatingOptimizationSettings,
  latestPriceFetchedAt,
  resolveHourlyDropProfile,
  resolveOptimizerSettings,
  runBackendHeatingOptimization,
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

export function runRunHeatingOptimizerLogicUnitTests() {
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
  const tomorrowPrices = priceRowsForDay(tomorrowPlanDate, 0, 20, 3);

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
      priceHoursCount: 5,
    });
    assertEqual(readiness, { ok: false, reason: "stale_tank_reading" }, "a 6h-old reading must be rejected as stale");
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
      appTodayPlan: { plan_date: todayPlanDate, planned_hours: [] } as RawHeatingPlanRow,
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
    assertEqual(row.planned_hours_match, true, "identical empty plans on both sides must match");
    assertEqual(row.uncertainty_reason, null, "confirmed heating status must not carry the stateless-anchor uncertainty note");
  }
}

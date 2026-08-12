// Pure logic for the run-heating-optimizer shadow-mode Edge Function -
// no Deno-only APIs here (no Deno.serve/Deno.env/network), so this file
// runs identically under Node (see logic.test.ts, wired into
// scripts/run-tank-temperature-forecast-tests.ts) and under the Deno Edge
// Runtime that actually executes index.ts. index.ts is the thin shell that
// does the Supabase reads/writes and calls into this file.
//
// Reuses the app's own optimizer/publication code directly (not a copy):
// heatingOptimizer.ts, heatingOptimizationRun.ts, heatingPlanOrchestration.ts,
// heatingPlanPublication.ts, tankTemperatureForecast.ts,
// temperatureDropProfile.ts, settingsDefaults.ts, heatingLogic.ts,
// tankReadingFreshness.ts, heatingGain.ts and their own transitive
// dependencies. All framework-agnostic (no React, no AsyncStorage), and all
// physically live under supabase/functions/_shared/ - NOT under lib/ -
// because Supabase's `--use-api` deploy bundler only resolves relative
// imports that stay inside supabase/functions/; an import reaching out to
// ../../../lib/... fails to bundle with "Module not found" even though it
// resolves fine locally under Node/tsc (see this PR's report). lib/ keeps a
// same-named re-export shim at each of these paths so every existing app
// import site is unaffected - supabase/functions/_shared/ is the one
// physical source of truth, not a second implementation.
import {
  optimizeHeatingPlan,
  type HeatingOptimizationHour,
  type HeatingOptimizationResult,
  type HeatingOptimizationSettings,
  type HeatingOptimizationSettingsSource,
} from "../_shared/heatingOptimizer.ts";
import { createHeatingOptimizationSettings } from "../_shared/heatingOptimizer.ts";
import {
  materializeHeatingOptimizationHours,
  shouldRunHeatingOptimization,
} from "../_shared/heatingOptimizationRun.ts";
import {
  buildHeatingPlanPublicationDecision,
  computeNextUnknownHeatingAnchor,
  type HeatingPlanPublicationDecision,
} from "../_shared/heatingPlanOrchestration.ts";
import type { ComparableHeatingPlan } from "../_shared/heatingPlanPublication.ts";
import {
  buildHourlyTemperatureDropProfileResult,
  fallbackHourlyTemperatureDrop,
  type HourlyTemperatureDropProfile,
  type TankTemperatureReading,
} from "../_shared/tankTemperatureForecast.ts";
import {
  fetchLatestTemperatureDropProfile,
  selectTemperatureDropProfile,
  type TemperatureDropProfile,
} from "../_shared/temperatureDropProfile.ts";
import { isTankReadingFreshForCalculation } from "../_shared/tankReadingFreshness.ts";
import { defaultSettings } from "../_shared/settingsDefaults.ts";
import {
  getDateKeyOffset,
  getFinnishDateKey,
  getHelsinkiHourNumber,
} from "../_shared/heatingLogic.ts";
import { fallbackHeatingGainPerHour, fetchHeatingGainHistory } from "../_shared/heatingGain.ts";

export type RawTankReading = {
  bottom_temp: number | null;
  created_at: string | null;
  heating: boolean | null;
  top_temp: number | null;
};

export type RawHeatingControlSettingsRow = {
  full_tank_average_temperature: number | null;
  full_tank_showers: number | null;
  max_tank_temperature: number | null;
  min_tank_temperature: number | null;
  target_shower_reserve: number | null;
};

export type RawElectricityPriceRow = {
  ends_at: string;
  fetched_at?: string | null;
  spot_price_cents_kwh: number;
  starts_at: string;
};

// Newest fetched_at among the given price rows - tells a shadow run reader
// how stale the underlying electricity_prices data itself is, independent
// of whether that data happens to cover tomorrow yet.
export function latestPriceFetchedAt(prices: RawElectricityPriceRow[]): string | null {
  return prices.reduce<string | null>((latest, price) => {
    if (!price.fetched_at) {
      return latest;
    }

    return !latest || price.fetched_at > latest ? price.fetched_at : latest;
  }, null);
}

export type RawHeatingPlanRow = {
  mode?: string | null;
  plan_date: string;
  planned_hours: unknown;
  target_hours?: number | null;
};

// automaticMaxHeatingHours and safetyShowerReserve are settings the
// optimizer needs that heating_control_settings does not (currently) carry
// - see the shadow-mode PR report for why. Both fall back to
// defaultSettings below, and settingsSource records that so shadow rows
// stay honest about it rather than silently pretending parity.
export type OptimizerSettingsResolution = {
  settings: HeatingOptimizationSettingsSource;
  settingsSource: "heating_control_settings+defaults" | "defaults_only";
};

export function resolveOptimizerSettings(
  row: RawHeatingControlSettingsRow | null,
): OptimizerSettingsResolution {
  const settings: HeatingOptimizationSettingsSource = {
    automaticMaxHeatingHours: defaultSettings.automaticMaxHeatingHours,
    fullTankAverageTemperature:
      row?.full_tank_average_temperature ?? defaultSettings.fullTankAverageTemperature,
    fullTankShowers: row?.full_tank_showers ?? defaultSettings.fullTankShowers,
    maxTankTemperature: row?.max_tank_temperature ?? defaultSettings.maxTankTemperature,
    minTankTemperature: row?.min_tank_temperature ?? defaultSettings.minTankTemperature,
    safetyShowerReserve: defaultSettings.safetyShowerReserve,
    targetShowerReserve: row?.target_shower_reserve ?? defaultSettings.targetShowerReserve,
  };

  return {
    settings,
    // automaticMaxHeatingHours and safetyShowerReserve always come from
    // defaultSettings today - heating_control_settings does not carry them
    // (see the shadow-mode PR report). The remaining fields come from the
    // row when one exists, defaultSettings otherwise.
    settingsSource: row
      ? "heating_control_settings+defaults"
      : "defaults_only",
  };
}

// Mirrors app/(tabs)/index.tsx's optimizerHours useMemo: today's remaining
// hours (from `now` onward) plus all of tomorrow's, sorted chronologically.
export function buildOptimizerHours(
  prices: RawElectricityPriceRow[],
  now: Date,
  todayPlanDate: string,
  tomorrowPlanDate: string,
): HeatingOptimizationHour[] {
  return prices
    .map((price) => {
      const date = new Date(price.starts_at);
      const endDate = new Date(price.ends_at);
      const dateKey = getFinnishDateKey(price.starts_at);

      return {
        date,
        dateKey,
        endDate,
        id: price.starts_at,
        isCurrentHour: date.getTime() <= now.getTime() && endDate.getTime() > now.getTime(),
        price: price.spot_price_cents_kwh,
        segmentHours: 1,
        startDate: price.starts_at,
      };
    })
    .filter(
      (hour) =>
        (hour.dateKey === todayPlanDate && hour.endDate.getTime() > now.getTime()) ||
        hour.dateKey === tomorrowPlanDate,
    )
    .sort((first, second) => first.date.getTime() - second.date.getTime())
    .map(({ dateKey: _dateKey, ...hour }) => hour);
}

export type OptimizerReadinessCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_tank_reading"
        | "incomplete_tank_reading"
        | "stale_tank_reading"
        | "no_price_hours_available";
    };

// Same gating as shouldRunHeatingOptimization, split into individual
// reasons for a diagnostic shadow row instead of one opaque boolean.
export function checkOptimizerReadiness({
  latestReading,
  now,
  priceHoursCount,
}: {
  latestReading: RawTankReading | null;
  now: Date;
  priceHoursCount: number;
}): OptimizerReadinessCheck {
  if (!latestReading) {
    return { ok: false, reason: "missing_tank_reading" };
  }
  if (
    typeof latestReading.top_temp !== "number" ||
    typeof latestReading.bottom_temp !== "number"
  ) {
    return { ok: false, reason: "incomplete_tank_reading" };
  }
  if (!isTankReadingFreshForCalculation(latestReading.created_at, now)) {
    return { ok: false, reason: "stale_tank_reading" };
  }
  if (priceHoursCount === 0) {
    return { ok: false, reason: "no_price_hours_available" };
  }

  return { ok: true };
}

export function resolveHourlyDropProfile({
  localReadings,
  now,
  storedProfile,
}: {
  localReadings: TankTemperatureReading[];
  now: Date;
  // Already parsed - callers fetch this the same way the app does, via
  // fetchLatestTemperatureDropProfile(supabase) in lib/temperatureDropProfile.ts.
  storedProfile: TemperatureDropProfile | null;
}): {
  generalFallback: number;
  hourlyDrops: HourlyTemperatureDropProfile;
  source: "supabase-30-day" | "local-7-day";
} {
  const local = buildHourlyTemperatureDropProfileResult(localReadings);
  const selected = selectTemperatureDropProfile({
    localGeneralFallback: local.generalFallback,
    localProfile: local.hourlyDrops,
    now,
    supabaseProfile: storedProfile,
  });

  return {
    generalFallback: selected.generalFallback,
    hourlyDrops: selected.hourlyTemperatureDropProfile,
    source: selected.profileSource,
  };
}

export type BackendOptimizationRun = {
  readiness: OptimizerReadinessCheck;
  result: HeatingOptimizationResult | null;
};

// Runs the exact same optimizeHeatingPlan() the app runs - no math changes.
// RecoveryDrop stays disabled here, matching what every production app
// build does (lib/recoveryDropEnvironment.ts only ever enables it on
// non-production Updates channels - there is no equivalent "channel"
// concept server-side, so this hardcodes the production behavior rather
// than inventing one).
export function runBackendHeatingOptimization({
  heatingGainHistory,
  hourlyDrops,
  hours,
  isCurrentlyHeating,
  latestReading,
  now,
  settings,
}: {
  heatingGainHistory: TankTemperatureReading[];
  hourlyDrops: HourlyTemperatureDropProfile;
  hours: HeatingOptimizationHour[];
  isCurrentlyHeating: boolean;
  latestReading: RawTankReading | null;
  now: Date;
  settings: HeatingOptimizationSettings;
}): BackendOptimizationRun {
  const readiness = checkOptimizerReadiness({
    latestReading,
    now,
    priceHoursCount: hours.length,
  });

  if (!readiness.ok || !latestReading) {
    return { readiness, result: null };
  }

  const currentTopTemperature = latestReading.top_temp as number;
  const currentBottomTemperature = latestReading.bottom_temp as number;
  const currentWeightedTemperature =
    currentTopTemperature * 0.7 + currentBottomTemperature * 0.3;

  if (
    !shouldRunHeatingOptimization({
      currentBottomTemperature,
      currentTopTemperature,
      currentWeightedTemperature,
      hoursCount: hours.length,
      isEnabled: true,
      mode: "automatic",
      now,
      readingCreatedAt: latestReading.created_at,
    })
  ) {
    return { readiness: { ok: false, reason: "stale_tank_reading" }, result: null };
  }

  // Recomputes isCurrentHour/segmentHours against the exact `now` this run
  // uses (a partial current hour must count as less than a full hour of
  // heating) - same step useHeatingOptimizationRun.ts performs right before
  // calling optimizeHeatingPlan, not the optimizerHours-level placeholder.
  const materializedHours = materializeHeatingOptimizationHours(hours, now);
  const result = optimizeHeatingPlan({
    currentBottomTemperature,
    currentTopTemperature,
    currentWeightedTemperature,
    hourlyDrops,
    hours: materializedHours,
    isCurrentlyHeating,
    recoveryDropEnabled: false,
    settings,
    tankReadings: heatingGainHistory,
  });

  return { readiness, result };
}

export type ShadowRunRow = {
  app_plan_mode: string | null;
  app_planned_hours_today: number[] | null;
  fallback_used: boolean;
  heating_status: boolean | null;
  input_price_fetched_at: string | null;
  optimizer_reason: string | null;
  optimizer_valid: boolean | null;
  optimizer_violations: string[] | null;
  planned_hours_match: boolean | null;
  reason: string;
  run_at: string;
  settings_source: string;
  source: "backend_shadow";
  tank_reading_at: string | null;
  target_hours: number | null;
  today_plan_date: string;
  today_planned_hours: number[] | null;
  tomorrow_plan_date: string;
  tomorrow_planned_hours: number[] | null;
  uncertainty_reason: string | null;
};

export function buildShadowRunRow({
  appTodayPlan,
  decision,
  heatingStatus,
  inputPriceFetchedAt,
  now,
  optimizerResult,
  readinessReason,
  settingsSource,
  tankReadingAt,
  todayPlanDate,
  tomorrowPlanDate,
}: {
  appTodayPlan: RawHeatingPlanRow | null;
  decision: HeatingPlanPublicationDecision;
  heatingStatus: boolean | null;
  inputPriceFetchedAt: string | null;
  now: Date;
  optimizerResult: HeatingOptimizationResult | null;
  readinessReason: string | null;
  settingsSource: string;
  tankReadingAt: string | null;
  todayPlanDate: string;
  tomorrowPlanDate: string;
}): ShadowRunRow {
  const todayPlannedHours =
    decision.status === "ready" ? decision.today.planned_hours : null;
  const appPlannedHours = appTodayPlan
    ? normalizePlanHoursForComparison(appTodayPlan.planned_hours)
    : null;
  // The backend only ever runs the automatic optimizer, so a match/mismatch
  // is only a meaningful signal against an app plan that was itself
  // published in automatic mode. Comparing against a "fixed"-mode app plan
  // would pollute planned_hours_match with coincidental true's and
  // meaningless false's, since fixed mode never went through
  // optimizeHeatingPlan() at all - see this PR's report.
  const appPlanIsAutomatic = appTodayPlan?.mode === "automatic";
  const plannedHoursMatch =
    appPlanIsAutomatic && todayPlannedHours && appPlannedHours
      ? JSON.stringify(todayPlannedHours) === JSON.stringify(appPlannedHours)
      : null;
  const uncertaintyReason =
    heatingStatus === null
      ? "stateless_unknown_anchor: shadow mode has no cross-run memory of when heating first became unknown, unlike the app's unknownHeatingAnchorRef - see report"
      : null;

  return {
    app_plan_mode: appTodayPlan?.mode ?? null,
    app_planned_hours_today: appPlannedHours,
    fallback_used: optimizerResult?.heatingGainEstimate.fallbackUsed ?? false,
    heating_status: heatingStatus,
    input_price_fetched_at: inputPriceFetchedAt,
    optimizer_reason: decision.status === "ready" ? decision.today.reason : null,
    optimizer_valid: optimizerResult?.valid ?? null,
    optimizer_violations: optimizerResult?.violations ?? null,
    planned_hours_match: plannedHoursMatch,
    reason: decision.status === "deferred" ? decision.reason : (readinessReason ?? "ready"),
    run_at: now.toISOString(),
    settings_source: settingsSource,
    source: "backend_shadow",
    tank_reading_at: tankReadingAt,
    target_hours: decision.status === "ready" ? decision.today.target_hours : null,
    today_plan_date: todayPlanDate,
    today_planned_hours: todayPlannedHours,
    tomorrow_plan_date: tomorrowPlanDate,
    tomorrow_planned_hours:
      decision.status === "ready" ? decision.tomorrow.planned_hours : null,
    uncertainty_reason: uncertaintyReason,
  };
}

function normalizePlanHoursForComparison(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return [...new Set(value.filter((hour) => Number.isInteger(hour)))]
    .map(Number)
    .sort((first, second) => first - second);
}

export function buildStoredPlansMap(
  rows: RawHeatingPlanRow[],
): Record<string, ComparableHeatingPlan> {
  const map: Record<string, ComparableHeatingPlan> = {};

  for (const row of rows) {
    map[row.plan_date] = row;
  }

  return map;
}

export {
  buildHeatingPlanPublicationDecision,
  computeNextUnknownHeatingAnchor,
  createHeatingOptimizationSettings,
  fallbackHeatingGainPerHour,
  fallbackHourlyTemperatureDrop,
  fetchHeatingGainHistory,
  fetchLatestTemperatureDropProfile,
  getDateKeyOffset,
  getFinnishDateKey,
  getHelsinkiHourNumber,
};
export type { HeatingPlanPublicationDecision, TankTemperatureReading };

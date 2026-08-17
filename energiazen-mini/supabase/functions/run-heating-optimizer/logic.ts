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
  getDailyMinimumPrices,
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
  getHelsinkiDateStart,
  getHelsinkiHourNumber,
} from "../_shared/heatingLogic.ts";
import { fallbackHeatingGainPerHour, fetchHeatingGainHistory } from "../_shared/heatingGain.ts";

export type RawTankReading = {
  bottom_temp: number | null;
  created_at: string | null;
  heating: boolean | null;
  top_temp: number | null;
};

export type ExpectedTankSnapshot = {
  bottom_temp: number | null;
  created_at: string | null;
  heating: boolean | null;
  top_temp: number | null;
};

export function buildExpectedTankSnapshot(
  reading: RawTankReading | null,
): ExpectedTankSnapshot {
  return {
    bottom_temp: reading?.bottom_temp ?? null,
    created_at: reading?.created_at ?? null,
    heating: reading?.heating ?? null,
    top_temp: reading?.top_temp ?? null,
  };
}

export function isHeatingOptimizerCronSecretAuthorized(
  providedSecret: string | null,
  expectedSecret: string | undefined,
): boolean {
  return Boolean(
    providedSecret &&
      expectedSecret &&
      providedSecret.length > 0 &&
      providedSecret === expectedSecret,
  );
}

export type RawHeatingControlSettingsRow = {
  automatic_max_heating_hours: number | null;
  full_tank_average_temperature: number | null;
  full_tank_showers: number | null;
  heating_gain_source: string | null;
  heating_need_mode: string | null;
  max_tank_temperature: number | null;
  min_tank_temperature: number | null;
  price_tolerance_cents?: number | null;
  safety_shower_reserve: number | null;
  target_shower_reserve: number | null;
  updated_at?: string | null;
};

export type RawElectricityPriceRow = {
  ends_at: string;
  fetched_at?: string | null;
  resolution_minutes: number;
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
  updated_at?: string | null;
};

// Cross-runtime plan identity used by the backend heartbeat and Shelly.
// Keeping the canonical representation deliberately simple avoids requiring
// a crypto implementation on the constrained Shelly runtime.
export function buildHeatingPlanFingerprint(
  planDate: string,
  plannedHours: unknown,
): string | null {
  const hours = normalizePlanHoursForComparison(plannedHours);
  return /^\d{4}-\d{2}-\d{2}$/.test(planDate) && hours
    ? `${planDate}|${hours.join(",")}`
    : null;
}

// Supabase RPC returns the PL/pgSQL boolean as `data`. Only literal true
// means the compare-and-set was committed; false/null/any unexpected shape
// must never be reported as a successful heartbeat ownership operation.
export function wasHeartbeatCompareAndSetCommitted(data: unknown): data is true {
  return data === true;
}

export function doesHeartbeatRunTokenMatch({
  currentRunId,
  currentRunStartedAt,
  expectedRunId,
  expectedRunStartedAt,
}: {
  currentRunId: string | null | undefined;
  currentRunStartedAt: string | null | undefined;
  expectedRunId: string;
  expectedRunStartedAt: string;
}): boolean {
  const currentStartedAt = Date.parse(currentRunStartedAt ?? "");
  const expectedStartedAt = Date.parse(expectedRunStartedAt);
  return (
    currentRunId === expectedRunId &&
    Number.isFinite(currentStartedAt) &&
    Number.isFinite(expectedStartedAt) &&
    currentStartedAt === expectedStartedAt
  );
}

export const maxTankSnapshotPublicationRetries = 1;

export type TankSnapshotRetryAction =
  | "retry"
  | "retry_exhausted"
  | "superseded"
  | "terminal";

export function resolveTankSnapshotRetryAction({
  attemptIndex,
  publicationResult,
  stillOwnsRun,
}: {
  attemptIndex: number;
  publicationResult: unknown;
  stillOwnsRun: boolean;
}): TankSnapshotRetryAction {
  if (publicationResult !== "tank_snapshot_conflict") {
    return "terminal";
  }
  if (!stillOwnsRun) {
    return "superseded";
  }
  return attemptIndex < maxTankSnapshotPublicationRetries
    ? "retry"
    : "retry_exhausted";
}

export function canMarkHeatingPlanValidated(
  heating: unknown,
  isValidReadyDecision: boolean,
  hasTodayChanges: boolean,
): boolean {
  return typeof heating === "boolean" && isValidReadyDecision && !hasTodayChanges;
}

export type OptimizerInputFetchFailureReason =
  | "heating_gain_history_fetch_failed"
  | "recovery_history_fetch_failed"
  | "drop_profile_fetch_failed";

export type OptimizerInputFetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: OptimizerInputFetchFailureReason; value: T };

export function successfulOptimizerInputFetch<T>(
  value: T,
): OptimizerInputFetchResult<T> {
  return { ok: true, value };
}

export function failedOptimizerInputFetch<T>(
  reason: OptimizerInputFetchFailureReason,
  fallbackValue: T,
): OptimizerInputFetchResult<T> {
  return { ok: false, reason, value: fallbackValue };
}

export type OptimizerInputFetchReadiness =
  | { failedReasons: []; ok: true; reason: null }
  | {
      failedReasons: OptimizerInputFetchFailureReason[];
      ok: false;
      reason:
        | OptimizerInputFetchFailureReason
        | `optimizer_input_fetch_failed:${string}`;
    };

export function resolveOptimizerInputFetchReadiness(
  fetches: readonly OptimizerInputFetchResult<unknown>[],
): OptimizerInputFetchReadiness {
  const failedReasons = fetches.flatMap((fetch) =>
    fetch.ok ? [] : [fetch.reason],
  );

  if (failedReasons.length === 0) {
    return { failedReasons: [], ok: true, reason: null };
  }

  return {
    failedReasons,
    ok: false,
    reason:
      failedReasons.length === 1
        ? failedReasons[0]
        : `optimizer_input_fetch_failed:${failedReasons.join(",")}`,
  };
}

export type BackendPublicationReadiness =
  | { ok: true; reason: null }
  | {
      ok: false;
      reason:
        | "control_mode_not_automatic"
        | "control_mode_missing"
        | "control_mode_invalid"
        | "settings_missing"
        | "settings_incomplete"
        | OptimizerInputFetchFailureReason
        | `optimizer_input_fetch_failed:${string}`;
    };

export function combineBackendPublicationReadiness(
  settingsReadiness: BackendPublicationReadiness,
  inputFetchReadiness: OptimizerInputFetchReadiness,
): BackendPublicationReadiness {
  if (!inputFetchReadiness.ok) {
    return { ok: false, reason: inputFetchReadiness.reason };
  }
  return settingsReadiness;
}

export type OptimizerSettingsResolution = {
  heatingGainSource: "learned" | "fixed";
  heatingNeedMode: "automatic" | "fixed" | null;
  publicationReadiness: BackendPublicationReadiness;
  settings: HeatingOptimizationSettingsSource;
  settingsSource: "heating_control_settings" | "heating_control_settings+defaults" | "defaults_only";
};

export function resolveOptimizerSettings(
  row: RawHeatingControlSettingsRow | null,
): OptimizerSettingsResolution {
  const missingRequiredSettings =
    !row ||
    !Number.isFinite(row.automatic_max_heating_hours) ||
    !Number.isFinite(row.full_tank_average_temperature) ||
    !Number.isFinite(row.full_tank_showers) ||
    !Number.isFinite(row.max_tank_temperature) ||
    !Number.isFinite(row.min_tank_temperature) ||
    !Number.isFinite(row.safety_shower_reserve) ||
    !Number.isFinite(row.target_shower_reserve) ||
    (row.heating_gain_source !== "learned" && row.heating_gain_source !== "fixed");
  const heatingNeedMode =
    row?.heating_need_mode === "automatic" || row?.heating_need_mode === "fixed"
      ? row.heating_need_mode
      : null;
  const heatingGainSource =
    row?.heating_gain_source === "fixed" ? "fixed" : defaultSettings.heatingGainSource;
  const settings: HeatingOptimizationSettingsSource = {
    automaticMaxHeatingHours:
      row?.automatic_max_heating_hours ?? defaultSettings.automaticMaxHeatingHours,
    fullTankAverageTemperature:
      row?.full_tank_average_temperature ?? defaultSettings.fullTankAverageTemperature,
    fullTankShowers: row?.full_tank_showers ?? defaultSettings.fullTankShowers,
    maxTankTemperature: row?.max_tank_temperature ?? defaultSettings.maxTankTemperature,
    minTankTemperature: row?.min_tank_temperature ?? defaultSettings.minTankTemperature,
    priceToleranceCents:
      row?.price_tolerance_cents ?? defaultSettings.priceToleranceCents,
    safetyShowerReserve:
      row?.safety_shower_reserve ?? defaultSettings.safetyShowerReserve,
    targetShowerReserve: row?.target_shower_reserve ?? defaultSettings.targetShowerReserve,
  };
  const publicationReadiness: BackendPublicationReadiness = (() => {
    if (!row) {
      return { ok: false, reason: "settings_missing" };
    }
    if (row.heating_need_mode === null) {
      return { ok: false, reason: "control_mode_missing" };
    }
    if (row.heating_need_mode !== "automatic" && row.heating_need_mode !== "fixed") {
      return { ok: false, reason: "control_mode_invalid" };
    }
    if (row.heating_need_mode !== "automatic") {
      return { ok: false, reason: "control_mode_not_automatic" };
    }
    if (missingRequiredSettings) {
      return { ok: false, reason: "settings_incomplete" };
    }
    return { ok: true, reason: null };
  })();

  return {
    heatingGainSource,
    heatingNeedMode,
    publicationReadiness,
    settings,
    settingsSource: !row
      ? "defaults_only"
      : missingRequiredSettings
        ? "heating_control_settings+defaults"
        : "heating_control_settings",
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
    .filter((price) => price.resolution_minutes === 60)
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

// Per-day reference price for optimizeHeatingPlan's price tolerance ranking
// (see heatingOptimizer.ts's dailyMinimumPrices and
// heatingPlanOrchestration.ts's getDailyMinimumPrices). Deliberately built
// from the SAME raw `prices` rows as buildOptimizerHours above but WITHOUT
// its "today's remaining hours only" filter - today's real cheapest hour
// may already be behind `now`, and the tolerance band must still be
// measured against it, not against whatever's left in the candidate
// window.
export function buildOptimizerDailyMinimumPrices(
  prices: RawElectricityPriceRow[],
  todayPlanDate: string,
  tomorrowPlanDate: string,
): Record<string, number> {
  const dayHours = prices
    .filter((price) => price.resolution_minutes === 60)
    .map((price) => ({
      date: new Date(price.starts_at),
      endDate: new Date(price.ends_at),
      price: price.spot_price_cents_kwh,
      startDate: price.starts_at,
    }))
    .filter((hour) => {
      const dateKey = getFinnishDateKey(hour.startDate);
      return dateKey === todayPlanDate || dateKey === tomorrowPlanDate;
    });

  return getDailyMinimumPrices(
    dayHours,
    [todayPlanDate, tomorrowPlanDate],
    getFinnishDateKey,
  );
}

export type ExpectedElectricityPriceSnapshotRow = {
  ends_at: string;
  region: string;
  resolution_minutes: 60;
  spot_price_cents_kwh: number;
  starts_at: string;
};

export function buildExpectedElectricityPriceSnapshot(
  hours: HeatingOptimizationHour[],
  region = "FI",
): ExpectedElectricityPriceSnapshotRow[] {
  return hours
    .map((hour) => ({
      ends_at: hour.endDate.toISOString(),
      region,
      resolution_minutes: 60 as const,
      spot_price_cents_kwh: hour.price,
      starts_at: hour.startDate,
    }))
    .sort((first, second) => first.starts_at.localeCompare(second.starts_at));
}

export type OptimizerReadinessCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_tank_reading"
        | "incomplete_tank_reading"
        | "stale_tank_reading"
        | "no_price_hours_available"
        | "incomplete_price_coverage";
    };

// Same gating as shouldRunHeatingOptimization, split into individual
// reasons for a diagnostic shadow row instead of one opaque boolean.
export function checkOptimizerReadiness({
  latestReading,
  now,
  priceHours,
  priceHoursCount,
}: {
  latestReading: RawTankReading | null;
  now: Date;
  priceHours?: HeatingOptimizationHour[];
  /** Simulator compatibility; production passes priceHours for coverage validation. */
  priceHoursCount?: number;
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
  const availableCount = priceHours?.length ?? priceHoursCount ?? 0;
  if (availableCount === 0) {
    return { ok: false, reason: "no_price_hours_available" };
  }

  if (!priceHours) return { ok: true };

  // Freshness is coverage-based rather than an arbitrary fetched_at age:
  // the first usable interval must cover `now`, and every interval in the
  // window actually handed to the optimizer must be contiguous. Thus old
  // rows, a missing current hour, and holes in otherwise-present rows all
  // fail closed without changing optimizer math or hour selection.
  const sorted = [...priceHours].sort(
    (first, second) => first.date.getTime() - second.date.getTime(),
  );
  if (
    sorted[0].date.getTime() > now.getTime() ||
    sorted[0].endDate.getTime() <= now.getTime()
  ) {
    return { ok: false, reason: "incomplete_price_coverage" };
  }
  for (let index = 0; index < sorted.length; index += 1) {
    const hour = sorted[index];
    if (
      !Number.isFinite(hour.date.getTime()) ||
      !Number.isFinite(hour.endDate.getTime()) ||
      hour.endDate.getTime() - hour.date.getTime() !== 60 * 60 * 1000 ||
      (index > 0 && sorted[index - 1].endDate.getTime() !== hour.date.getTime())
    ) {
      return { ok: false, reason: "incomplete_price_coverage" };
    }
  }

  // Tomorrow is optional, but today's remaining local hours are not. Resolve
  // next Helsinki midnight through the shared IANA-time-zone helper; DST days
  // can contain 23 or 25 real hours and must not use a fixed 24-hour offset.
  const nextHelsinkiMidnight = getHelsinkiDateStart(getDateKeyOffset(1, now));
  if (sorted[sorted.length - 1].endDate.getTime() < nextHelsinkiMidnight.getTime()) {
    return { ok: false, reason: "incomplete_price_coverage" };
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
  dailyMinimumPrices,
  heatingGainHistory,
  hourlyDrops,
  hours,
  heatingGainSource,
  isCurrentlyHeating,
  latestReading,
  now,
  settings,
}: {
  /** See buildOptimizerDailyMinimumPrices / heatingOptimizer.ts's optimizeHeatingPlan. */
  dailyMinimumPrices?: Record<string, number>;
  heatingGainHistory: TankTemperatureReading[];
  hourlyDrops: HourlyTemperatureDropProfile;
  hours: HeatingOptimizationHour[];
  heatingGainSource: "learned" | "fixed";
  isCurrentlyHeating: boolean;
  latestReading: RawTankReading | null;
  now: Date;
  settings: HeatingOptimizationSettings;
}): BackendOptimizationRun {
  const readiness = checkOptimizerReadiness({
    latestReading,
    now,
    priceHours: hours,
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
    dailyMinimumPrices,
    hourlyDrops,
    hours: materializedHours,
    heatingGainPerHour:
      heatingGainSource === "fixed" ? settings.fallbackHeatingGainPerHour : undefined,
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

export type ExpectedHeatingPlanVersion = {
  expected_planned_hours: unknown;
  expected_updated_at: string | null;
  existed: boolean;
  plan_date: string;
};

export function buildExpectedHeatingPlanVersions(
  changedPlans: { plan_date: string }[],
  storedRows: RawHeatingPlanRow[],
  validatedPlanDate?: string,
): ExpectedHeatingPlanVersion[] {
  const planDates = [
    ...new Set([
      ...(validatedPlanDate ? [validatedPlanDate] : []),
      ...changedPlans.map((plan) => plan.plan_date),
    ]),
  ];

  return planDates.map((planDate) => {
    const storedPlan = storedRows.find((row) => row.plan_date === planDate) ?? null;

    return {
      expected_planned_hours: storedPlan?.planned_hours ?? null,
      expected_updated_at: storedPlan?.updated_at ?? null,
      existed: storedPlan !== null,
      plan_date: planDate,
    };
  });
}

export type ExpectedOptimizerSettingsSnapshot = {
  automatic_max_heating_hours: number | null;
  full_tank_average_temperature: number | null;
  full_tank_showers: number | null;
  heating_gain_source: string | null;
  heating_need_mode: string | null;
  max_tank_temperature: number | null;
  min_tank_temperature: number | null;
  safety_shower_reserve: number | null;
  target_shower_reserve: number | null;
  updated_at: string | null;
};

export function buildExpectedOptimizerSettingsSnapshot(
  row: RawHeatingControlSettingsRow | null,
): ExpectedOptimizerSettingsSnapshot | null {
  if (!row) {
    return null;
  }

  return {
    automatic_max_heating_hours: row.automatic_max_heating_hours,
    full_tank_average_temperature: row.full_tank_average_temperature,
    full_tank_showers: row.full_tank_showers,
    heating_gain_source: row.heating_gain_source,
    heating_need_mode: row.heating_need_mode,
    max_tank_temperature: row.max_tank_temperature,
    min_tank_temperature: row.min_tank_temperature,
    safety_shower_reserve: row.safety_shower_reserve,
    target_shower_reserve: row.target_shower_reserve,
    updated_at: row.updated_at ?? null,
  };
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
  getHelsinkiDateStart,
  getHelsinkiHourNumber,
};
export type { HeatingPlanPublicationDecision, TankTemperatureReading };

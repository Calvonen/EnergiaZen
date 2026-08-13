// Offline, fixture-only fail-safe simulator for the backend heating
// optimizer pipeline (pg_cron -> run-heating-optimizer -> a published
// plan). Pure data in, pure data out - no network, no Supabase, no real
// Shelly, no email. Reuses the exact production domain functions from
// supabase/functions/run-heating-optimizer/logic.ts (the same file the
// real Edge Function runs, already unit-tested under logic.test.ts) and
// the new watchdog domain function in lib/heatingBackendWatchdog.ts -
// there is no parallel/copied optimizer here.
//
// Two entry points read this module:
//   - scripts/simulateHeatingBackendFailSafe.ts (npm run
//     simulate:heating-failsafe): prints the scenario report table.
//   - tests/heatingBackendFailSafeSimulation.test.ts (npm test): asserts
//     every scenario's actual outcome matches its declared expectation,
//     so a future change that breaks fail-safe behaviour fails the build
//     instead of only showing up in a console table nobody reads.
//
// IMPORTANT SCOPE NOTE: run-heating-optimizer does not write to
// heating_plans today (shadow mode only - see that function's own header
// comment). "published"/plan_status below describes what THIS simulator's
// own in-memory plan store records, standing in for a future
// backend-primary write - it is not a claim about what the real function
// currently does to heating_plans.
import {
  buildHeatingPlanPublicationDecision,
  buildOptimizerHours,
  checkOptimizerReadiness,
  createHeatingOptimizationSettings,
  fallbackHeatingGainPerHour,
  getDateKeyOffset,
  getFinnishDateKey,
  getHelsinkiHourNumber,
  resolveOptimizerSettings,
  runBackendHeatingOptimization,
  type HeatingPlanPublicationDecision,
  type RawElectricityPriceRow,
  type RawHeatingControlSettingsRow,
  type RawTankReading,
} from "../supabase/functions/run-heating-optimizer/logic";
import type { ComparableHeatingPlan } from "../supabase/functions/_shared/heatingPlanPublication";
// simulateHeatingPlan/HeatingOptimizationHour aren't re-exported from
// logic.ts (it only re-exports what run-heating-optimizer's own index.ts
// needs) - imported directly from the same real, unmodified production
// module logic.ts itself calls into, to replay exactly one hour of real
// tank physics for hours run-heating-optimizer did NOT produce a fresh
// forecast for (see advanceTankPhysicsThroughUnobservedHour below). Not a
// second/parallel physics model - the identical function optimizeHeatingPlan
// itself calls internally.
import {
  simulateHeatingPlan,
  type HeatingOptimizationHour,
} from "../supabase/functions/_shared/heatingOptimizer";
import type { HourlyTemperatureDropProfile } from "../lib/tankTemperatureForecast";
import {
  evaluateHeatingBackendHealth,
  type HeatingBackendHealthResult,
  type HeatingBackendRunOutcome,
  type HeatingBackendWatchdogConfig,
} from "../lib/heatingBackendWatchdog";

// Deliberately NOT an `asserts condition` type predicate: several callers
// below check a specific outcome value (e.g. tick.outcome === "deferred")
// purely as a fixture sanity check, then go on to compare that same union
// field against a DIFFERENT literal a few lines later
// (tick.outcome === "published") to compute planPublishedActual. A
// narrowing assertion would make TypeScript treat the second comparison
// as always-false and fail the build.
function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------
// Watchdog config used throughout this simulator/its regression test.
//
// These two numbers are ILLUSTRATIVE ONLY, chosen to make the nine
// scenarios below behave distinctly and deterministically. They are NOT a
// vetted production recommendation - see this simulator's report (in the
// PR description) for why evaluateHeatingBackendHealth requires them as
// explicit config rather than defaulting them, and what still needs to
// happen before any real number is chosen.
// ---------------------------------------------------------------------
export const illustrativeWatchdogConfig: HeatingBackendWatchdogConfig = {
  maxRunIntervalMinutes: 90,
  maxValidatedPlanAgeMinutes: 150,
};

const hourMs = 60 * 60 * 1000;
const minuteMs = 60 * 1000;

// A flat, deliberately simple "world physics" stand-in shared by every
// scenario: the tank loses a constant 0.4 degC/h whenever it is not
// currently heating - close to lib/tankTemperatureForecast.ts's own
// fallbackHourlyTemperatureDrop (0.25 degC/h), not an arbitrary guess.
// optimizeHeatingPlan()'s automaticMaxHeatingHours caps selectable hours
// across the WHOLE horizon it is given (today-remaining + tomorrow, up to
// ~48h - see buildOptimizerHours), not per calendar day, so this needs to
// stay close to the real fallback: a multi-degree-per-hour drop sustained
// over 48 real hours with only ~3 total heating hours available would make
// every combination fail the safety floor regardless of scenario, which
// would test nothing about fail-safe orchestration. This is not a claim
// about real thermal behaviour (lib/tankTemperatureForecast.ts owns that
// model) - it exists only to give
// optimizeHeatingPlan()/runBackendHeatingOptimization() a stable,
// reproducible input so this simulator's PASS/FAIL is about fail-safe
// *orchestration* behaviour, not about re-litigating the physical model.
const flatHourlyDrops: HourlyTemperatureDropProfile = Object.fromEntries(
  Array.from({ length: 24 }, (_, hour) => [hour, 0.4]),
);

const settingsRow: RawHeatingControlSettingsRow = {
  full_tank_average_temperature: 70,
  full_tank_showers: 6,
  max_tank_temperature: 70,
  min_tank_temperature: 10,
  target_shower_reserve: 4,
};

function isoMinutesBefore(reference: Date, minutes: number): string {
  return new Date(reference.getTime() - minutes * minuteMs).toISOString();
}

function isoHoursBefore(reference: Date, hours: number): string {
  return isoMinutesBefore(reference, hours * 60);
}

// Generates one price row per hour, from `fromDateKey T00:00Z` through
// `days` full calendar days, using `priceForHour` for the value. Mirrors
// logic.test.ts's priceRowsForDay, generalised to many days for the
// week-long scenarios.
function buildPriceRows(
  fromDateKey: string,
  days: number,
  priceForHour: (dayIndex: number, hour: number) => number,
): RawElectricityPriceRow[] {
  const rows: RawElectricityPriceRow[] = [];
  const start = new Date(`${fromDateKey}T00:00:00.000Z`);

  for (let dayIndex = 0; dayIndex < days; dayIndex += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const startsAt = new Date(start.getTime() + (dayIndex * 24 + hour) * hourMs);
      const endsAt = new Date(startsAt.getTime() + hourMs);

      rows.push({
        ends_at: endsAt.toISOString(),
        fetched_at: startsAt.toISOString(),
        spot_price_cents_kwh: priceForHour(dayIndex, hour),
        starts_at: startsAt.toISOString(),
      });
    }
  }

  return rows;
}

function defaultPriceForHour(_dayIndex: number, hour: number): number {
  // A simple day/night pattern (cheap at night, expensive in the evening)
  // so the optimizer has a real preference between hours, without needing
  // to be realistic.
  return 3 + Math.abs(((hour + 6) % 24) - 12) / 2;
}

export type SimulatedHeatingPlanStore = Record<string, ComparableHeatingPlan>;

export type BackendTickInput = {
  isCurrentlyHeating: boolean;
  latestReading: RawTankReading | null;
  now: Date;
  prices: RawElectricityPriceRow[];
  simulatePublicationFailure?: boolean;
  simulateRunError?: boolean;
  storedPlans: SimulatedHeatingPlanStore;
};

export type BackendTickResult = {
  decision: HeatingPlanPublicationDecision | null;
  now: Date;
  optimizerValid: boolean | null;
  outcome: HeatingBackendRunOutcome;
  reason: string;
  storedPlans: SimulatedHeatingPlanStore;
  topAfter: number | null;
  bottomAfter: number | null;
  heatingSelectedNow: boolean | null;
  violations: string[] | null;
};

// One simulated invocation of run-heating-optimizer, following the exact
// same call sequence its own index.ts uses (see logic.ts's exports):
// buildOptimizerHours -> checkOptimizerReadiness (via
// runBackendHeatingOptimization) -> optimizeHeatingPlan ->
// buildHeatingPlanPublicationDecision. The only two things this function
// adds on top of production logic.ts are (1) the optional
// simulateRunError/simulatePublicationFailure fixture hooks used by the
// EDGE_FUNCTION_FAILURE/PLAN_PUBLICATION_FAILURE scenarios, and (2) an
// explicit `!run.result.valid` check BEFORE trusting
// buildHeatingPlanPublicationDecision's "ready" status - see this
// simulator's report for why that check is necessary and is NOT currently
// enforced inside buildHeatingPlanPublicationDecision itself.
export function runOneBackendTick(input: BackendTickInput): BackendTickResult {
  const { now } = input;

  if (input.simulateRunError) {
    return {
      decision: null,
      now,
      optimizerValid: null,
      outcome: "run_error",
      reason: "simulated run-heating-optimizer execution failure (unhandled exception)",
      storedPlans: input.storedPlans,
      topAfter: null,
      bottomAfter: null,
      heatingSelectedNow: null,
      violations: null,
    };
  }

  const todayPlanDate = getDateKeyOffset(0, now);
  const tomorrowPlanDate = getDateKeyOffset(1, now);
  const hours = buildOptimizerHours(input.prices, now, todayPlanDate, tomorrowPlanDate);
  const readiness = checkOptimizerReadiness({
    latestReading: input.latestReading,
    now,
    priceHoursCount: hours.length,
  });

  const { settings } = resolveOptimizerSettings(settingsRow);
  const optimizationSettings = createHeatingOptimizationSettings(
    settings,
    fallbackHeatingGainPerHour,
  );

  const run = runBackendHeatingOptimization({
    heatingGainHistory: [],
    hourlyDrops: flatHourlyDrops,
    hours,
    isCurrentlyHeating: input.isCurrentlyHeating,
    latestReading: input.latestReading,
    now,
    settings: optimizationSettings,
  });

  if (!run.readiness.ok || !run.result) {
    return {
      decision: null,
      now,
      optimizerValid: null,
      outcome: "deferred",
      reason: `optimizer not ready: ${readiness.ok ? "unknown" : readiness.reason}`,
      storedPlans: input.storedPlans,
      topAfter: null,
      bottomAfter: null,
      heatingSelectedNow: null,
      violations: null,
    };
  }

  // Deliberately checked BEFORE buildHeatingPlanPublicationDecision is
  // trusted: that function only decides WHAT hours to publish from
  // optimizerResult.selectedHeatingHourIds, it does not itself gate on
  // optimizerResult.valid - see this simulator's report.
  if (!run.result.valid) {
    return {
      decision: null,
      now,
      optimizerValid: false,
      outcome: "optimizer_invalid",
      reason: `optimizer result invalid: ${run.result.violations.join("; ")}`,
      storedPlans: input.storedPlans,
      topAfter: null,
      bottomAfter: null,
      heatingSelectedNow: null,
      violations: run.result.violations,
    };
  }

  const decision = buildHeatingPlanPublicationDecision({
    currentHourNumber: getHelsinkiHourNumber(now),
    dateKeyOf: getFinnishDateKey,
    hasAttemptedTankReadingFetch: true,
    heating: input.latestReading?.heating ?? null,
    isTodayPlanLoaded: true,
    now,
    optimizerResult: run.result,
    optimizerSettings: { automaticMaxHeatingHours: optimizationSettings.maxHeatingHours },
    selectedHours: hours,
    storedPlans: input.storedPlans,
    todayPlanDate,
    tomorrowPlanDate,
    unknownHeatingAnchor: null,
  });

  const currentHourForecast = run.result.forecast.find(
    (hour) => hour.startDate === hours[0]?.id || hour.startDate === hours[0]?.startDate,
  ) ?? run.result.forecast[0] ?? null;

  if (decision.status === "deferred") {
    return {
      decision,
      now,
      optimizerValid: true,
      outcome: "deferred",
      reason: `publication deferred: ${decision.reason}`,
      storedPlans: input.storedPlans,
      topAfter: null,
      bottomAfter: null,
      heatingSelectedNow: null,
      violations: run.result.violations,
    };
  }

  // PR #191 review (Codex): buildHeatingPlanPublicationDecision's own
  // changedPlans is production's real duplicate-suppression signal - when
  // the optimizer computes a valid, ready decision whose today/tomorrow
  // plans are BOTH operationally identical to what's already stored
  // (heatingPlanPublication.ts's getChangedHeatingPlans/
  // areHeatingPlansOperationallyEqual), no durable write would actually
  // happen in production. Checked BEFORE simulatePublicationFailure:
  // there is nothing to fail to write when nothing changed, so a
  // publication-failure simulation is moot on a no-op tick.
  if (decision.changedPlans.length === 0) {
    return {
      decision,
      now,
      optimizerValid: true,
      outcome: "no_changes",
      reason:
        "valid plan computed but operationally identical to the already-published plan - no durable write, storedPlans untouched",
      storedPlans: input.storedPlans,
      topAfter: currentHourForecast?.topTemperatureAfter ?? null,
      bottomAfter: currentHourForecast?.bottomTemperatureAfter ?? null,
      heatingSelectedNow: currentHourForecast?.isHeatingSelected ?? null,
      violations: run.result.violations,
    };
  }

  if (input.simulatePublicationFailure) {
    return {
      decision,
      now,
      optimizerValid: true,
      outcome: "publication_failed",
      reason: "simulated plan write/publish failure after a valid optimizer result",
      storedPlans: input.storedPlans,
      topAfter: currentHourForecast?.topTemperatureAfter ?? null,
      bottomAfter: currentHourForecast?.bottomTemperatureAfter ?? null,
      heatingSelectedNow: currentHourForecast?.isHeatingSelected ?? null,
      violations: run.result.violations,
    };
  }

  // Apply ONLY decision.changedPlans - mirrors a real duplicate-suppressed
  // write (a real writer upserts exactly the changed rows, not blindly
  // both today+tomorrow every cycle regardless of whether either changed).
  const nextStoredPlans: SimulatedHeatingPlanStore = { ...input.storedPlans };
  for (const changedPlan of decision.changedPlans) {
    nextStoredPlans[changedPlan.plan_date] = changedPlan;
  }

  return {
    decision,
    now,
    optimizerValid: true,
    outcome: "published",
    reason: "valid plan published",
    storedPlans: nextStoredPlans,
    topAfter: currentHourForecast?.topTemperatureAfter ?? null,
    bottomAfter: currentHourForecast?.bottomTemperatureAfter ?? null,
    heatingSelectedNow: currentHourForecast?.isHeatingSelected ?? null,
    violations: run.result.violations,
  };
}

// ---------------------------------------------------------------------
// Watchdog history bookkeeping shared by every scenario below - derives
// evaluateHeatingBackendHealth's inputs from a plain list of past run
// attempts, so scenarios build up realistic history instead of
// hand-authoring watchdog input fields directly.
// ---------------------------------------------------------------------
export type BackendRunHistoryEntry = {
  at: Date;
  outcome: HeatingBackendRunOutcome;
  reason: string;
};

// PR #191 follow-up review (Codex): lastValidatedPlanAt and lastPublishedAt
// are derived from two DIFFERENT subsets of history, matching
// evaluateHeatingBackendHealth's own split - see its comments for why:
//  - lastPublishedAt: most recent entry with outcome "published"
//    (a genuine durable write) only, exactly as before.
//  - lastValidatedPlanAt: most recent entry with outcome "published" OR
//    "no_changes" - a duplicate-suppressed no-op still successfully
//    reconfirmed the stored plan is correct, even though nothing was
//    written. "publication_failed" deliberately does NOT count as either -
//    see HeatingBackendRunOutcome's own comment for why a changed-but-
//    unpersisted plan must not look like a validation.
export function evaluateHistory(
  history: BackendRunHistoryEntry[],
  now: Date,
  config: HeatingBackendWatchdogConfig = illustrativeWatchdogConfig,
): HeatingBackendHealthResult {
  const last = history.length > 0 ? history[history.length - 1] : null;
  const lastPublished = [...history].reverse().find((entry) => entry.outcome === "published") ?? null;
  const lastValidated =
    [...history]
      .reverse()
      .find((entry) => entry.outcome === "published" || entry.outcome === "no_changes") ?? null;

  return evaluateHeatingBackendHealth({
    config,
    lastPublishedAt: lastPublished ? lastPublished.at.toISOString() : null,
    lastRunAt: last ? last.at.toISOString() : null,
    lastRunOutcome: last ? last.outcome : null,
    lastRunReason: last ? last.reason : null,
    lastValidatedPlanAt: lastValidated ? lastValidated.at.toISOString() : null,
    now,
  });
}

// ---------------------------------------------------------------------
// Advances the GROUND-TRUTH tank state through exactly one hour that
// run-heating-optimizer did NOT produce a fresh forecast for (run_error,
// deferred, or optimizer_invalid all leave a tick's forecast unavailable -
// see runOneBackendTick). PR #191 review: a prior version of this
// simulator left the tank's temperature completely frozen for every hour
// of an outage and then re-stamped that frozen value as a brand new
// reading the moment the outage ended, which could make recovery look
// healthy for the wrong reason (a fabricated fresh timestamp on stale
// data) rather than because the modeled physical state was actually safe.
//
// Reuses simulateHeatingPlan (the exact same physics
// optimizeHeatingPlan's own combination search calls internally, exported
// from the real, unmodified _shared/heatingOptimizer.ts) for a
// single-hour window - not a second/parallel physics model.
//
// Heating credit is given ONLY when the current Helsinki hour is already
// in the last successfully PUBLISHED plan's planned_hours - i.e. "Shelly
// kept executing whatever heating_plans already said, independent of
// run-heating-optimizer's own health this particular hour", which is the
// real mechanism (Shelly reads heating_plans on its own 60s cadence, not
// run-heating-optimizer's live output - see this PR's Shelly audit).
// Deliberately does NOT model Shelly's backup_hours/fallback override
// (fill-ratio thresholds, debounce, "backup-fault-override" blind
// heating): there is no reusable non-Shelly domain function for that
// decision, and duplicating shelly/energyzen-controller.js's own logic
// here would be exactly the second independent implementation this task
// says not to build. An outage hour outside the last published plan is
// therefore modeled as pure heat loss - the conservative choice, since it
// never credits recovery for backup heating this simulator cannot verify
// actually happened.
function advanceTankPhysicsThroughUnobservedHour({
  currentReading,
  now,
  storedPlans,
}: {
  currentReading: RawTankReading;
  now: Date;
  storedPlans: SimulatedHeatingPlanStore;
}): { heatingApplied: boolean; reading: RawTankReading } {
  const planDate = getDateKeyOffset(0, now);
  const currentHourNumber = getHelsinkiHourNumber(now);
  const lastPublishedPlannedHours = storedPlans[planDate]?.planned_hours;
  const plannedHours = Array.isArray(lastPublishedPlannedHours)
    ? lastPublishedPlannedHours.filter(
        (hour): hour is number => typeof hour === "number",
      )
    : [];
  const shouldHeatThisHour = plannedHours.includes(currentHourNumber);

  const hourWindow: HeatingOptimizationHour[] = [
    {
      date: now,
      endDate: new Date(now.getTime() + hourMs),
      id: `unobserved:${now.toISOString()}`,
      isCurrentHour: true,
      price: 0,
      segmentHours: 1,
      startDate: now.toISOString(),
    },
  ];

  const { settings } = resolveOptimizerSettings(settingsRow);
  const optimizationSettings = createHeatingOptimizationSettings(
    settings,
    fallbackHeatingGainPerHour,
  );

  const steppedHour = simulateHeatingPlan({
    currentBottomTemperature: currentReading.bottom_temp as number,
    currentTopTemperature: currentReading.top_temp as number,
    heatingGainPerHour: fallbackHeatingGainPerHour,
    hourlyDrops: flatHourlyDrops,
    hours: hourWindow,
    isCurrentlyHeating: currentReading.heating === true,
    selectedHeatingHourIds: shouldHeatThisHour ? [hourWindow[0].id] : [],
    settings: optimizationSettings,
  }).forecast[0];

  // heatingGain > 0 (not isHeatingSelected) reflects whether heating was
  // actually APPLIED this hour - a selected hour can still be blocked by
  // the start-fill-ratio check (see heatingOptimizer.ts) if the tank was
  // already close to full, in which case no gain is added even though the
  // hour was nominally "planned".
  const heatingApplied = steppedHour.heatingGain > 0;

  return {
    heatingApplied,
    reading: {
      bottom_temp: steppedHour.bottomTemperatureAfter,
      created_at: now.toISOString(),
      heating: heatingApplied,
      top_temp: steppedHour.topTemperatureAfter,
    },
  };
}

// ---------------------------------------------------------------------
// Report row shape - matches the columns requested for this simulator.
// ---------------------------------------------------------------------
export type ScenarioReportRow = {
  scenario: string;
  passFail: "PASS" | "FAIL";
  optimizerStatus: string;
  planStatus: string;
  fallbackExpected: boolean;
  alertExpected: boolean;
  alertReason: string | null;
  /** How old the last run that VALIDATED the plan (published or no_changes) is - what watchdog health is actually judged on. */
  lastValidatedPlanAgeMinutes: string;
  /** How old the last actual durable WRITE is - diagnostic only, does not by itself gate health. */
  lastPublishedAgeMinutes: string;
  notes: string;
  failures: string[];
};

function optimizerStatusFor(tick: BackendTickResult): string {
  if (tick.outcome === "run_error") {
    return "error";
  }
  if (tick.outcome === "deferred") {
    return `deferred (${tick.reason})`;
  }
  if (tick.outcome === "optimizer_invalid") {
    return `invalid (${(tick.violations ?? []).join("; ")})`;
  }
  // "published", "no_changes", and "publication_failed" all reach here
  // with a genuinely valid optimizer result - they differ only in what
  // happened AFTER the optimizer succeeded (a real write, a
  // duplicate-suppressed no-op, or a failed write - see planStatusFor).
  return `valid${tick.optimizerValid === true ? "" : " (unexpected)"}`;
}

// Three distinct outcomes, not two - PR #191 review: a duplicate-
// suppressed no-op ("no_changes") is neither "published" (nothing was
// durably written) nor an ordinary "not_published" failure/deferral (the
// optimizer succeeded and the existing plan is still correct) - it needs
// its own label so the report table can't be misread either way.
function planStatusFor(tick: BackendTickResult): string {
  if (tick.outcome === "published") {
    return "published";
  }
  if (tick.outcome === "no_changes") {
    return "no_changes (duplicate suppressed, not published)";
  }
  return "not_published";
}

function buildReportRow({
  actual,
  alertExpected,
  fallbackExpected,
  notes,
  planPublishedExpected,
  scenario,
}: {
  actual: HeatingBackendHealthResult;
  alertExpected: boolean;
  fallbackExpected: boolean;
  notes: string;
  planPublishedExpected: boolean | null;
  scenario: string;
}): ScenarioReportRow {
  return {
    alertExpected,
    alertReason: actual.alertReason,
    failures: [],
    fallbackExpected,
    lastPublishedAgeMinutes:
      actual.lastPublishedAgeMinutes === null ? "n/a" : actual.lastPublishedAgeMinutes.toFixed(1),
    lastValidatedPlanAgeMinutes:
      actual.lastValidatedPlanAgeMinutes === null
        ? "n/a"
        : actual.lastValidatedPlanAgeMinutes.toFixed(1),
    notes,
    optimizerStatus: "",
    passFail: "PASS",
    planStatus: "",
    scenario,
  };
}

// expectedStatus is REQUIRED (not optional) - every single-tick scenario
// below must pin down exactly which of evaluateHeatingBackendHealth's four
// statuses it expects, not just the alert/fallbackRecommended booleans two
// different statuses could both produce (e.g. run_overdue and run_failed
// both alert with fallback recommended, but they are different failure
// categories with different operational meaning - see PR #191 review).
//
// expectedAlertReasonPrefix pins down the failure CATEGORY within that
// status for scenarios that specifically exercise one: null means "no
// alert reason expected" (only valid for status "healthy"), a string means
// actual.alertReason must start with it (evaluateHeatingBackendHealth
// always prefixes alertReason with "<category>: ..." - see
// lib/heatingBackendWatchdog.ts).
function checkExpectation({
  actual,
  expectedAlertReasonPrefix,
  expectedStatus,
  planPublishedActual,
  planPublishedExpected,
  row,
}: {
  actual: HeatingBackendHealthResult;
  expectedAlertReasonPrefix: string | null;
  expectedStatus: HeatingBackendHealthResult["status"];
  planPublishedActual: boolean | null;
  planPublishedExpected: boolean | null;
  row: ScenarioReportRow;
}): ScenarioReportRow {
  const failures: string[] = [];

  if (actual.alert !== row.alertExpected) {
    failures.push(`alert: expected ${row.alertExpected}, got ${actual.alert}`);
  }
  if (actual.fallbackRecommended !== row.fallbackExpected) {
    failures.push(
      `fallbackRecommended: expected ${row.fallbackExpected}, got ${actual.fallbackRecommended}`,
    );
  }
  if (actual.status !== expectedStatus) {
    failures.push(`status: expected "${expectedStatus}", got "${actual.status}"`);
  }
  if (expectedAlertReasonPrefix === null) {
    if (actual.alertReason !== null) {
      failures.push(`alertReason: expected null, got ${JSON.stringify(actual.alertReason)}`);
    }
  } else if (!actual.alertReason || !actual.alertReason.startsWith(expectedAlertReasonPrefix)) {
    failures.push(
      `alertReason: expected it to start with "${expectedAlertReasonPrefix}", got ${JSON.stringify(actual.alertReason)}`,
    );
  }
  if (planPublishedExpected !== null && planPublishedActual !== planPublishedExpected) {
    failures.push(
      `plan published: expected ${planPublishedExpected}, got ${planPublishedActual}`,
    );
  }

  return { ...row, failures, passFail: failures.length === 0 ? "PASS" : "FAIL" };
}

// ---------------------------------------------------------------------
// Scenario 1: NORMAL
// ---------------------------------------------------------------------
function scenarioNormal(): ScenarioReportRow {
  const now = new Date("2026-08-12T11:30:00.000Z"); // 14:30 Europe/Helsinki
  const prices = buildPriceRows("2026-08-12", 2, defaultPriceForHour);
  const reading: RawTankReading = {
    bottom_temp: 60,
    created_at: isoMinutesBefore(now, 5),
    heating: false,
    top_temp: 65,
  };

  const tick = runOneBackendTick({
    isCurrentlyHeating: false,
    latestReading: reading,
    now,
    prices,
    storedPlans: {},
  });

  const history: BackendRunHistoryEntry[] = [{ at: now, outcome: tick.outcome, reason: tick.reason }];
  const actual = evaluateHistory(history, now);

  const row = buildReportRow({
    actual,
    alertExpected: false,
    fallbackExpected: false,
    notes:
      "Tuoreet hinnat, tuore lukema, optimizer valid -> uusi suunnitelma julkaistaan, ei alerttia.",
    planPublishedExpected: true,
    scenario: "NORMAL",
  });
  row.optimizerStatus = optimizerStatusFor(tick);
  row.planStatus = planStatusFor(tick);

  return checkExpectation({
    actual,
    expectedAlertReasonPrefix: null,
    expectedStatus: "healthy",
    planPublishedActual: tick.outcome === "published",
    planPublishedExpected: true,
    row,
  });
}

// ---------------------------------------------------------------------
// Scenario 2: CRON_MISSING
// pg_cron itself never fired - there is no run attempt to simulate at
// all, so this scenario is pure watchdog-timestamp reasoning rather than
// a runOneBackendTick call.
// ---------------------------------------------------------------------
function scenarioCronMissing(): ScenarioReportRow {
  const now = new Date("2026-08-12T11:30:00.000Z");
  const history: BackendRunHistoryEntry[] = [
    { at: new Date(isoHoursBefore(now, 5)), outcome: "published", reason: "valid plan published" },
  ];
  const actual = evaluateHistory(history, now);

  const row = buildReportRow({
    actual,
    alertExpected: true,
    fallbackExpected: true,
    notes:
      "Viimeisin havaittu ajo 5 h sitten (> maxRunIntervalMinutes) - pg_cron ei ole laukaissut run-heating-optimizeria ajallaan. Watchdog tunnistaa cron_missing-tilan puhtaasti aikaleimoista, eikä väitä että uusi optimizer-plan olisi syntynyt.",
    planPublishedExpected: null,
    scenario: "CRON_MISSING",
  });
  row.optimizerStatus = "n/a (no run observed)";
  row.planStatus = "not_published (stale: last published 5h ago)";

  return checkExpectation({
    actual,
    expectedAlertReasonPrefix: "cron_missing:",
    expectedStatus: "run_overdue",
    planPublishedActual: null,
    planPublishedExpected: null,
    row,
  });
}

// ---------------------------------------------------------------------
// Scenario 3: EDGE_FUNCTION_FAILURE
// ---------------------------------------------------------------------
function scenarioEdgeFunctionFailure(): ScenarioReportRow {
  const now = new Date("2026-08-12T11:30:00.000Z");
  const tick = runOneBackendTick({
    isCurrentlyHeating: false,
    latestReading: null,
    now,
    prices: [],
    simulateRunError: true,
    storedPlans: {},
  });

  const history: BackendRunHistoryEntry[] = [
    {
      at: new Date(isoMinutesBefore(now, 20)),
      outcome: "published",
      reason: "valid plan published",
    },
    { at: now, outcome: tick.outcome, reason: tick.reason },
  ];
  const actual = evaluateHistory(history, now);

  const row = buildReportRow({
    actual,
    alertExpected: true,
    fallbackExpected: true,
    notes:
      "Cron kaynnistyy ajallaan mutta run-heating-optimizer heittaa poikkeuksen. Alert syntyy VALITTOMASTI (run_failed), ei vasta kun edellinen validi plani vanhenisi - edellinen plani oli tassa vasta 20 min vanha.",
    planPublishedExpected: false,
    scenario: "EDGE_FUNCTION_FAILURE",
  });
  row.optimizerStatus = optimizerStatusFor(tick);
  row.planStatus = planStatusFor(tick);

  return checkExpectation({
    actual,
    expectedAlertReasonPrefix: "run_error:",
    expectedStatus: "run_failed",
    planPublishedActual: tick.outcome === "published",
    planPublishedExpected: false,
    row,
  });
}

// ---------------------------------------------------------------------
// Scenario 4: STALE_PRICES
// electricity_prices has nothing covering the needed today-remaining +
// tomorrow window at all - the EXISTING checkOptimizerReadiness gate
// (no_price_hours_available) rejects it, exactly as it does in
// production today. See this simulator's report for the related
// architecture gap: a price row set that is merely old-but-still-present
// is NOT currently rejected by any freshness check - only a fully empty
// window is caught here.
// ---------------------------------------------------------------------
function scenarioStalePrices(): ScenarioReportRow {
  const now = new Date("2026-08-12T11:30:00.000Z");
  const reading: RawTankReading = {
    bottom_temp: 45,
    created_at: isoMinutesBefore(now, 5),
    heating: false,
    top_temp: 55,
  };

  const tick = runOneBackendTick({
    isCurrentlyHeating: false,
    latestReading: reading,
    now,
    prices: [],
    storedPlans: {},
  });
  assert(tick.outcome === "deferred", "STALE_PRICES fixture must hit the deferred path");
  assert(
    tick.reason.includes("no_price_hours_available"),
    "STALE_PRICES fixture must be rejected via the existing no_price_hours_available readiness reason",
  );

  const history: BackendRunHistoryEntry[] = [
    {
      at: new Date(isoHoursBefore(now, 5)),
      outcome: "published",
      reason: "valid plan published",
    },
    { at: now, outcome: tick.outcome, reason: tick.reason },
  ];
  const actual = evaluateHistory(history, now);

  const row = buildReportRow({
    actual,
    alertExpected: true,
    fallbackExpected: true,
    notes:
      "electricity_prices ei kata tarvittavaa ikkunaa lainkaan -> olemassa oleva no_price_hours_available-sääntö hylkää ajon, ei uutta valid plania. Alert syntyy koska viimeisin julkaistu plani on jo 5h vanha (ei valittomasti, koska tama ei ole run_error/publication_failed).",
    planPublishedExpected: false,
    scenario: "STALE_PRICES",
  });
  row.optimizerStatus = optimizerStatusFor(tick);
  row.planStatus = planStatusFor(tick);

  return checkExpectation({
    actual,
    expectedAlertReasonPrefix: "no_recent_valid_plan:",
    expectedStatus: "no_recent_valid_plan",
    planPublishedActual: tick.outcome === "published",
    planPublishedExpected: false,
    row,
  });
}

// ---------------------------------------------------------------------
// Scenario 5: STALE_TANK_READING
// ---------------------------------------------------------------------
function scenarioStaleTankReading(): ScenarioReportRow {
  const now = new Date("2026-08-12T11:30:00.000Z");
  const prices = buildPriceRows("2026-08-12", 2, defaultPriceForHour);
  const staleReading: RawTankReading = {
    bottom_temp: 45,
    created_at: isoMinutesBefore(now, 60),
    heating: false,
    top_temp: 55,
  };

  const tick = runOneBackendTick({
    isCurrentlyHeating: false,
    latestReading: staleReading,
    now,
    prices,
    storedPlans: {},
  });
  assert(tick.outcome === "deferred", "STALE_TANK_READING fixture must hit the deferred path");
  assert(
    tick.reason.includes("stale_tank_reading"),
    "STALE_TANK_READING fixture must be rejected via the existing stale_tank_reading readiness reason (tankReadingFreshness.ts, 30 min)",
  );

  const history: BackendRunHistoryEntry[] = [
    {
      at: new Date(isoHoursBefore(now, 5)),
      outcome: "published",
      reason: "valid plan published",
    },
    { at: now, outcome: tick.outcome, reason: tick.reason },
  ];
  const actual = evaluateHistory(history, now);

  const row = buildReportRow({
    actual,
    alertExpected: true,
    fallbackExpected: true,
    notes:
      "tank_readings-lukema on 60 min vanha (> 30 min tankMonitorAlertThresholdMinutes) -> sama raja jota isTankReadingFreshForCalculation jo kayttaa hylkaa ajon. Ei uutta valid plania; alert koska viimeisin julkaistu plani on jo 5h vanha.",
    planPublishedExpected: false,
    scenario: "STALE_TANK_READING",
  });
  row.optimizerStatus = optimizerStatusFor(tick);
  row.planStatus = planStatusFor(tick);

  return checkExpectation({
    actual,
    expectedAlertReasonPrefix: "no_recent_valid_plan:",
    expectedStatus: "no_recent_valid_plan",
    planPublishedActual: tick.outcome === "published",
    planPublishedExpected: false,
    row,
  });
}

// ---------------------------------------------------------------------
// Scenario 6: OPTIMIZER_INVALID
// The tank reading itself is already below settings.min_tank_temperature
// (an implausible/corrupted-sensor scenario) - optimizeHeatingPlan (real,
// unmodified) then reports violatedAbsoluteSafety on the very first
// forecast hour regardless of which hours get selected, so valid is
// guaranteed false. This is not a hand-picked "make it fail" shortcut in
// the optimizer - it is the optimizer's own real safety check firing on a
// physically-implausible input.
// ---------------------------------------------------------------------
function scenarioOptimizerInvalid(): ScenarioReportRow {
  const now = new Date("2026-08-12T11:30:00.000Z");
  const prices = buildPriceRows("2026-08-12", 2, defaultPriceForHour);
  const reading: RawTankReading = {
    bottom_temp: 4,
    created_at: isoMinutesBefore(now, 5),
    heating: false,
    top_temp: 4,
  };

  const tick = runOneBackendTick({
    isCurrentlyHeating: false,
    latestReading: reading,
    now,
    prices,
    storedPlans: {},
  });
  assert(
    tick.outcome === "optimizer_invalid",
    `OPTIMIZER_INVALID fixture must produce an invalid optimizer result, got outcome=${tick.outcome} reason=${tick.reason}`,
  );

  const history: BackendRunHistoryEntry[] = [
    {
      at: new Date(isoHoursBefore(now, 5)),
      outcome: "published",
      reason: "valid plan published",
    },
    { at: now, outcome: tick.outcome, reason: tick.reason },
  ];
  const actual = evaluateHistory(history, now);

  const row = buildReportRow({
    actual,
    alertExpected: true,
    fallbackExpected: true,
    notes:
      "Lukema (4 C) on jo lahtokohtaisesti alle absoluuttisen turvarajan (min_tank_temperature=10) -> optimizeHeatingPlan palauttaa valid:false riippumatta valituista tunneista. Tata invalidia tulosta EI hyvaksyta primary-planiksi (tarkistetaan ENNEN buildHeatingPlanPublicationDecisionia - ks. raportti). Alert koska viimeisin julkaistu plani on jo 5h vanha.",
    planPublishedExpected: false,
    scenario: "OPTIMIZER_INVALID",
  });
  row.optimizerStatus = optimizerStatusFor(tick);
  row.planStatus = planStatusFor(tick);

  return checkExpectation({
    actual,
    expectedAlertReasonPrefix: "no_recent_valid_plan:",
    expectedStatus: "no_recent_valid_plan",
    planPublishedActual: tick.outcome === "published",
    planPublishedExpected: false,
    row,
  });
}

// ---------------------------------------------------------------------
// Scenario 7: PLAN_PUBLICATION_FAILURE
// ---------------------------------------------------------------------
function scenarioPlanPublicationFailure(): ScenarioReportRow {
  const now = new Date("2026-08-12T11:30:00.000Z");
  const prices = buildPriceRows("2026-08-12", 2, defaultPriceForHour);
  const reading: RawTankReading = {
    bottom_temp: 60,
    created_at: isoMinutesBefore(now, 5),
    heating: false,
    top_temp: 65,
  };

  const tick = runOneBackendTick({
    isCurrentlyHeating: false,
    latestReading: reading,
    now,
    prices,
    simulatePublicationFailure: true,
    storedPlans: {},
  });
  assert(
    tick.outcome === "publication_failed",
    `PLAN_PUBLICATION_FAILURE fixture must reach the publish step with a valid result, got outcome=${tick.outcome}`,
  );

  const history: BackendRunHistoryEntry[] = [
    {
      at: new Date(isoMinutesBefore(now, 20)),
      outcome: "published",
      reason: "valid plan published",
    },
    { at: now, outcome: tick.outcome, reason: tick.reason },
  ];
  const actual = evaluateHistory(history, now);

  const row = buildReportRow({
    actual,
    alertExpected: true,
    fallbackExpected: true,
    notes:
      "Optimizer tuotti validin suunnitelman, mutta kirjoitusvaihe epaonnistuu simuloidusti -> watchdog nakee ettei uutta julkaistua valid plania syntynyt (publication_failed on run_failed, alert VALITTOMASTI). Edellista 20 min vanhaa plania ei pideta 'ikuisesti tuoreena' - se on silti vanha tieto siita etta VIIMEISIN yritys epaonnistui.",
    planPublishedExpected: false,
    scenario: "PLAN_PUBLICATION_FAILURE",
  });
  row.optimizerStatus = optimizerStatusFor(tick);
  row.planStatus = planStatusFor(tick);

  return checkExpectation({
    actual,
    expectedAlertReasonPrefix: "publication_failed:",
    expectedStatus: "run_failed",
    planPublishedActual: tick.outcome === "published",
    planPublishedExpected: false,
    row,
  });
}

// ---------------------------------------------------------------------
// Scenarios 8 & 9: week-long hourly replays.
// ---------------------------------------------------------------------
export type WeekTickRecord = {
  alert: boolean;
  alertReason: string | null;
  fallbackRecommended: boolean;
  groundTruthBottomTemp: number;
  groundTruthTopTemp: number;
  hourIndex: number;
  now: Date;
  outcome: HeatingBackendRunOutcome;
  reason: string;
  status: HeatingBackendHealthResult["status"];
};

// Two separate tank states are tracked through the week, deliberately kept
// apart (PR #191 review):
//
//  - groundTruthReading: what the tank is ACTUALLY doing, physically,
//    every single hour, regardless of whether run-heating-optimizer ran
//    successfully that hour. Advanced every hour via either the real
//    optimizer forecast (when a tick produced one) or
//    advanceTankPhysicsThroughUnobservedHour (when it didn't) - never
//    frozen, never skipped.
//  - the reading actually fed into runOneBackendTick as
//    "latest tank_readings row": only ever refreshed to the current
//    groundTruthReading, stamped with `now`, on an hour that is NEITHER
//    itself a simulated run_error hour NOR the first hour immediately
//    after one ends. That first post-outage hour deliberately still sees
//    the stale pre-outage reading, so it cannot become healthy merely
//    because run-heating-optimizer started executing again - only the
//    following hour, once a new simulated fresh tank observation has
//    "arrived", can. Outside any outage this reduces to the same
//    every-hour freshening WEEK_WITHOUT_APP already relies on.
function runWeek({
  hours,
  injectRunErrorAt,
}: {
  hours: number;
  injectRunErrorAt: (hourIndex: number) => boolean;
}): WeekTickRecord[] {
  const weekStart = new Date("2026-08-10T00:00:00.000Z");
  const prices = buildPriceRows("2026-08-09", 10, defaultPriceForHour);
  const history: BackendRunHistoryEntry[] = [];
  const records: WeekTickRecord[] = [];

  let storedPlans: SimulatedHeatingPlanStore = {};
  let groundTruthReading: RawTankReading = {
    bottom_temp: 60,
    created_at: weekStart.toISOString(),
    heating: false,
    top_temp: 65,
  };
  let observedReading: RawTankReading = groundTruthReading;
  let isCurrentlyHeating = false;
  let previousHourWasRunError = false;

  for (let hourIndex = 0; hourIndex < hours; hourIndex += 1) {
    const now = new Date(weekStart.getTime() + hourIndex * hourMs);
    const simulateRunError = injectRunErrorAt(hourIndex);
    const isFirstHourAfterOutage = !simulateRunError && previousHourWasRunError;

    if (!simulateRunError && !isFirstHourAfterOutage) {
      // A new simulated fresh tank observation "arrives": carry the
      // current ground-truth physical state forward as this hour's
      // tank_readings row.
      observedReading = { ...groundTruthReading, created_at: now.toISOString() };
    }
    // Otherwise (mid-outage, or the very first hour right after one)
    // deliberately leave `observedReading` untouched - still whatever was
    // last actually observed, aging exactly like a real stalled/unverified
    // sensor feed would.

    const tick = runOneBackendTick({
      isCurrentlyHeating,
      latestReading: observedReading,
      now,
      prices,
      simulateRunError,
      storedPlans,
    });

    storedPlans = tick.storedPlans;
    history.push({ at: now, outcome: tick.outcome, reason: tick.reason });

    // Ground truth ALWAYS advances by exactly one hour, whether or not
    // this tick produced a fresh forecast - reusing the real optimizer's
    // own forecast when it did (tick.topAfter/bottomAfter), or replaying
    // the same real physics for a single unobserved hour otherwise (see
    // advanceTankPhysicsThroughUnobservedHour) - never frozen.
    if (tick.topAfter !== null && tick.bottomAfter !== null) {
      groundTruthReading = {
        bottom_temp: tick.bottomAfter,
        created_at: now.toISOString(),
        heating: tick.heatingSelectedNow ?? false,
        top_temp: tick.topAfter,
      };
      isCurrentlyHeating = tick.heatingSelectedNow ?? false;
    } else {
      const stepped = advanceTankPhysicsThroughUnobservedHour({
        currentReading: groundTruthReading,
        now,
        storedPlans,
      });
      groundTruthReading = stepped.reading;
      isCurrentlyHeating = stepped.heatingApplied;
    }

    const watchdog = evaluateHistory(history, now);
    records.push({
      alert: watchdog.alert,
      alertReason: watchdog.alertReason,
      fallbackRecommended: watchdog.fallbackRecommended,
      groundTruthBottomTemp: groundTruthReading.bottom_temp as number,
      groundTruthTopTemp: groundTruthReading.top_temp as number,
      hourIndex,
      now,
      outcome: tick.outcome,
      reason: tick.reason,
      status: watchdog.status,
    });

    previousHourWasRunError = simulateRunError;
  }

  return records;
}

function longestConsecutiveRun(
  records: WeekTickRecord[],
  predicate: (record: WeekTickRecord) => boolean,
): number {
  let longest = 0;
  let current = 0;

  for (const record of records) {
    if (predicate(record)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

// ---------------------------------------------------------------------
// Scenario 8: WEEK_WITHOUT_APP
// ---------------------------------------------------------------------
function scenarioWeekWithoutApp(): ScenarioReportRow {
  const totalHours = 7 * 24;
  const records = runWeek({ hours: totalHours, injectRunErrorAt: () => false });

  const publishedCount = records.filter((record) => record.outcome === "published").length;
  const noChangesCount = records.filter((record) => record.outcome === "no_changes").length;
  const successCount = publishedCount + noChangesCount;
  const alertCount = records.filter((record) => record.alert).length;
  const nonHealthyRecords = records.filter((record) => record.status !== "healthy");
  const lastRecord = records[records.length - 1];

  const row = buildReportRow({
    actual: {
      alert: lastRecord.alert,
      alertReason: null,
      fallbackRecommended: lastRecord.fallbackRecommended,
      lastPublishedAgeMinutes: 0,
      lastRunAgeMinutes: 0,
      lastValidatedPlanAgeMinutes: 0,
      status: lastRecord.status,
    },
    alertExpected: false,
    fallbackExpected: false,
    notes:
      `7 vrk x 24 h = ${totalHours} tuntia simuloitu ilman etta appia "avataan" kertaakaan (appin tila ei ole ` +
      `input tahan ollenkaan). Optimizer onnistui JA VALIDOI suunnitelman KAIKKINA ${totalHours} tuntina (0 ` +
      `virhetta/lykkaysta/invalidia): ${publishedCount} tuntia todella JULKAISI (durable write, changedPlans ` +
      "epatyhja - lastPublishedAt edistyy), " +
      `${noChangesCount} tuntia oli duplikaattina hylatty no-op (changedPlans=[] - EI kirjoitusta, ` +
      "lastPublishedAt EI edisty naina tunteina) mutta VALIDOI silti tallennetun suunnitelman edelleen " +
      "oikeaksi (lastValidatedPlanAt EDISTYY joka onnistuneella ajolla, kirjoitti tai ei - PR #191 " +
      "follow-up review). Koska watchdogin terveys perustuu VALIDOINTIIN eika pelkkaan kirjoitukseen, koko " +
      `viikko pysyy TERVEENA (${alertCount}/${totalHours} tuntia alert=true) - duplicate suppression ei ` +
      "enaa itsessaan aiheuta false alerttia.",
    planPublishedExpected: null,
    scenario: "WEEK_WITHOUT_APP",
  });
  row.optimizerStatus =
    `success 168/168 -> validated ${successCount}/${totalHours} (published ${publishedCount}, no_changes ` +
    `${noChangesCount})`;
  row.planStatus =
    alertCount === 0
      ? `continuously healthy (validated every hour) - ${publishedCount} durable write(s), ${noChangesCount} duplicate-suppressed no-op(s)`
      : `${alertCount}h alert=true - unexpected for a failure-free week under correct validation semantics`;

  const failures: string[] = [];
  // The pipeline itself must never fail/defer/invalidate for a whole week
  // without the app - THAT is the real "app not required" invariant.
  // Whether any individual hour durably publishes or is a duplicate-
  // suppressed no-op is a separate, expected, still-healthy-pipeline
  // outcome (PR #191 review) and must not be conflated with a failure.
  if (successCount !== totalHours) {
    failures.push(
      `expected every one of the ${totalHours} simulated hours to succeed (published or no_changes), got ` +
        `${successCount} successful hour(s) (missing ${totalHours - successCount})`,
    );
  }
  // PR #191 follow-up review: with lastValidatedPlanAt correctly advancing
  // on BOTH "published" and "no_changes" outcomes (a duplicate-suppressed
  // no-op is a real validation, not merely a missed write), a fully
  // healthy failure-free week must produce ZERO alerts - duplicate
  // suppression alone must never cause a false alert, regardless of how
  // many consecutive hours the plan happens to stay unchanged.
  if (alertCount !== 0) {
    failures.push(
      "expected zero alert hours in a failure-free week now that duplicate no-ops correctly count as " +
        `validations, got ${alertCount}`,
    );
  }
  if (nonHealthyRecords.length > 0) {
    failures.push(
      `expected status "healthy" in every one of the ${totalHours} simulated hours, got a non-healthy ` +
        `status in ${nonHealthyRecords.length} hour(s) - first at hour ${nonHealthyRecords[0].hourIndex} ` +
        `(status: "${nonHealthyRecords[0].status}")`,
    );
  }
  // Fixture sanity check, not a behaviour assertion: this scenario is only
  // meaningful proof of the duplicate-suppression fix if it actually
  // exercises a real no_changes hour - if a future fixture change made
  // the optimizer publish every single hour, this whole scenario would
  // silently stop testing what it claims to.
  if (noChangesCount === 0) {
    failures.push(
      "expected this fixture to exercise at least one duplicate-suppressed no_changes hour - otherwise this " +
        "scenario is not actually exercising PR #191's duplicate-suppression fix",
    );
  }

  return { ...row, failures, passFail: failures.length === 0 ? "PASS" : "FAIL" };
}

// ---------------------------------------------------------------------
// Scenario 9: FAILURE_DURING_WEEK
// ---------------------------------------------------------------------
function scenarioFailureDuringWeek(): ScenarioReportRow {
  const totalHours = 7 * 24;
  const failureStartHour = 2 * 24 + 10; // day 3, 10:00
  const failureHours = 6; // "usean tunnin ajan"
  const failureEndHour = failureStartHour + failureHours; // exclusive

  const records = runWeek({
    hours: totalHours,
    injectRunErrorAt: (hourIndex) => hourIndex >= failureStartHour && hourIndex < failureEndHour,
  });

  const beforeFailure = records[failureStartHour - 1];
  const duringFailure = records.slice(failureStartHour, failureEndHour);
  // The tick right where simulateRunError flips back to false: run-heating-
  // optimizer executes again without throwing, but the tank reading it
  // sees is still the one from before the outage (runWeek deliberately
  // does not refresh it here - see runWeek's comment) - PR #191 review.
  const firstRecoveryHourIndex = failureEndHour;
  const firstRecoveryHour = records[firstRecoveryHourIndex];
  // One hour later, a new simulated fresh tank observation "arrives" -
  // only from here can the pipeline actually recover.
  const freshDataHourIndex = failureEndHour + 1;
  const freshDataHour = records[freshDataHourIndex];
  const beforeOutageBottomTemp = beforeFailure.groundTruthBottomTemp;
  const endOfOutageBottomTemp = records[failureEndHour - 1].groundTruthBottomTemp;

  const failures: string[] = [];
  if (beforeFailure.alert) {
    failures.push("expected no alert immediately before the injected outage");
  }
  // Status, not just the alert boolean, immediately before the outage -
  // must be the genuine "healthy" classification, not some other
  // non-alerting-but-not-healthy state (PR #191 review).
  if (beforeFailure.status !== "healthy") {
    failures.push(
      `expected status "healthy" immediately before the injected outage, got "${beforeFailure.status}"`,
    );
  }
  if (!duringFailure.every((record) => record.alert)) {
    failures.push("expected every hour during the injected outage to alert");
  }
  if (!duringFailure.every((record) => record.status === "run_failed")) {
    failures.push("expected every hour during the injected outage to report status run_failed");
  }
  // Category, not just the status: every during-outage hour must be
  // attributed to the run_error failure this scenario actually injects,
  // not some other run_failed cause (e.g. a stray publication_failed).
  if (!duringFailure.every((record) => record.alertReason?.startsWith("run_error:"))) {
    failures.push(
      'expected every hour during the injected outage to carry an alertReason starting with "run_error:"',
    );
  }
  // PR #191 review (Codex): the tank's ground-truth physical state must
  // genuinely move through the outage (heat loss, and/or heating credit
  // from the last published plan) rather than sit frozen at its
  // pre-outage value - a frozen value is exactly what let a later version
  // of this simulator fabricate a "fresh" reading on recovery that had
  // not actually experienced the outage.
  if (Math.abs(endOfOutageBottomTemp - beforeOutageBottomTemp) < 0.01) {
    failures.push(
      `expected the tank's ground-truth bottom temperature to change during the ${failureHours}-hour outage ` +
        `(heat loss and/or last-published-plan heating), got an unchanged ${beforeOutageBottomTemp.toFixed(2)} ` +
        "C before and after - the physical state must not stay frozen",
    );
  }
  // PR #191 review (Codex): the very first tick after run-heating-
  // optimizer starts succeeding again must NOT publish/become healthy -
  // it still only has the stale pre-outage tank reading available (no
  // fresh observation has "arrived" yet), so it must be rejected the same
  // way any real stalled sensor feed would be, via the EXISTING
  // stale_tank_reading readiness rule - not a special case invented for
  // this scenario.
  if (firstRecoveryHour.outcome === "published") {
    failures.push(
      "expected the very first tick after the outage to NOT publish - it must still see the pre-outage " +
        "(by now stale) tank reading rather than a fabricated fresh one",
    );
  }
  if (!firstRecoveryHour.reason.includes("stale_tank_reading")) {
    failures.push(
      "expected the very first tick after the outage to be rejected specifically via the existing " +
        `stale_tank_reading readiness rule, got reason: "${firstRecoveryHour.reason}"`,
    );
  }
  if (firstRecoveryHour.status === "healthy") {
    failures.push(
      "expected the very first tick after the outage to NOT report healthy - recovery must not pass from a " +
        "fabricated fresh reading",
    );
  }
  // PR #191 review (Codex): only once a genuinely fresh simulated tank
  // observation has arrived (one hour later) can recovery actually
  // happen, and only because the modeled physical state at that point is
  // legitimately acceptable to the real, unmodified optimizer.
  if (freshDataHour.outcome !== "published") {
    failures.push(
      "expected the hour after a fresh tank observation arrives to publish a valid plan again, got outcome " +
        `"${freshDataHour.outcome}"`,
    );
  }
  if (freshDataHour.alert) {
    failures.push("expected the alert to clear once a genuinely fresh tank observation arrives");
  }
  if (freshDataHour.status !== "healthy") {
    failures.push(
      `expected status "healthy" once a genuinely fresh tank observation arrives, got "${freshDataHour.status}"`,
    );
  }
  // PR #191 review (Codex): once genuinely fresh data resumes, recovery
  // must be SUSTAINED, not just one lucky healthy tick - the next few
  // hours immediately following it must all be healthy too.
  const sustainedRecoveryWindow = records.slice(freshDataHourIndex, freshDataHourIndex + 3);
  if (!sustainedRecoveryWindow.every((record) => record.status === "healthy")) {
    failures.push(
      `expected the ${sustainedRecoveryWindow.length} hours immediately following recovery (starting at hour ` +
        `${freshDataHourIndex}) to all be healthy, got: ` +
        sustainedRecoveryWindow.map((record) => `${record.hourIndex}:${record.status}`).join(", "),
    );
  }
  // The injected outage itself must never resurface later in the week -
  // from the moment fresh data resumes onward, run_error/run_overdue/
  // run_failed must never occur again. A later, ISOLATED
  // no_recent_valid_plan dip is expected and NOT itself evidence of the
  // outage lingering - WEEK_WITHOUT_APP shows the exact same benign
  // pattern (the optimizer legitimately recomputing an unchanged plan for
  // a few hours) with ZERO injected failures at all; only
  // run_overdue/run_failed/run_error would indicate the outage itself
  // resurfacing.
  const afterRecovery = records.slice(freshDataHourIndex);
  const outageArtifactsAfterRecovery = afterRecovery.filter(
    (record) =>
      record.status === "run_overdue" || record.status === "run_failed" || record.outcome === "run_error",
  );
  if (outageArtifactsAfterRecovery.length > 0) {
    failures.push(
      `expected the injected outage to never resurface after recovery (hour ${freshDataHourIndex} onward), ` +
        `got ${outageArtifactsAfterRecovery.length} hour(s) with a lingering run_overdue/run_failed/run_error ` +
        `- first at hour ${outageArtifactsAfterRecovery[0].hourIndex} (status: ` +
        `"${outageArtifactsAfterRecovery[0].status}", outcome: "${outageArtifactsAfterRecovery[0].outcome}")`,
    );
  }
  // Any later benign no_recent_valid_plan dip must still self-resolve
  // promptly, exactly like WEEK_WITHOUT_APP's own baseline pattern - it
  // must never turn into a prolonged/stuck condition.
  const longestPostRecoveryNonHealthyStreak = longestConsecutiveRun(
    afterRecovery,
    (record) => record.status !== "healthy",
  );
  if (longestPostRecoveryNonHealthyStreak > 6) {
    failures.push(
      "expected any post-recovery non-healthy stretch to self-resolve within a few hours, got a " +
        `${longestPostRecoveryNonHealthyStreak}h longest streak after hour ${freshDataHourIndex}`,
    );
  }

  const row: ScenarioReportRow = {
    alertExpected: true,
    alertReason: `run_failed during hours [${failureStartHour}, ${failureEndHour})`,
    failures,
    fallbackExpected: true,
    lastPublishedAgeMinutes: "varies (see notes)",
    lastValidatedPlanAgeMinutes: "varies (see notes)",
    notes:
      `Paiva 3, ${failureHours} peräkkäistä tuntia (index [${failureStartHour}, ${failureEndHour})) ` +
      "simuloi run-heating-optimizerin suorituksen epaonnistumista (simulateRunError), jonka ajan varaajan " +
      "todellinen (ground-truth) lampotila jatkaa kehittymistaan lammonhukkana ja/tai viimeisimman " +
      "julkaistun suunnitelman mukaisena lammityksena - ei jaadytettyna. Vika havaitaan valittomasti " +
      "(alert=true jo ensimmaisella epaonnistuneella tunnilla) ja pysyy paalla koko katkon ajan. Katkon " +
      "paattyessa (tunti " +
      String(firstRecoveryHourIndex) +
      ") run-heating-optimizer ajaa taas onnistuneesti, mutta nakee silti katkoa edeltavan (nyt vanhentuneen) " +
      "lukeman eika julkaise - vasta seuraavana tuntina (" +
      String(freshDataHourIndex) +
      "), kun uusi simuloitu tuore mittaus \"saapuu\", palautuminen tapahtuu - ja vain koska mallinnettu " +
      "fysikaalinen tila on silloin aidosti turvallinen. Jarjestelma ei jaa pysyvasti vikamoodiin.",
    optimizerStatus:
      `error during hours [${failureStartHour}, ${failureEndHour}), stale_tank_reading at hour ` +
      `${firstRecoveryHourIndex}, valid from hour ${freshDataHourIndex}`,
    passFail: failures.length === 0 ? "PASS" : "FAIL",
    planStatus:
      `not_published during outage and at hour ${firstRecoveryHourIndex} (stale reading), published resumes ` +
      `at hour ${freshDataHourIndex}`,
    scenario: "FAILURE_DURING_WEEK",
  };

  return row;
}

// ---------------------------------------------------------------------
// PR #191 review (Codex): a defensive check (not one of the 9 named
// scenarios) proving the exact evaluateHistory() path every scenario
// above funnels through can never report "healthy" for a nonsensical
// future run-history timestamp. lib/heatingBackendWatchdog.test.ts
// already covers evaluateHeatingBackendHealth directly; this guards the
// simulator's OWN history-derivation logic on top of it (which entry
// evaluateHistory picks as "last"/"lastPublished" from a list), so a
// future regression there would fail loudly too, not just a unit test
// nobody runs. Runs as part of runAllScenarios() so both entry points
// (npm run simulate:heating-failsafe and npm test) enforce it.
// ---------------------------------------------------------------------
function runFutureTimestampSafetyChecks(): void {
  const now = new Date("2026-08-12T11:30:00.000Z");

  // A run recorded with a future timestamp must never make the pipeline
  // look healthy, even though its own outcome is "published" (so it is
  // simultaneously both the most recent run AND the most recent
  // published plan).
  {
    const history: BackendRunHistoryEntry[] = [
      {
        at: new Date(now.getTime() + 10 * minuteMs),
        outcome: "published",
        reason: "valid plan published",
      },
    ];
    const result = evaluateHistory(history, now);
    assert(
      result.status !== "healthy",
      `a future-timestamped run history entry must never yield status "healthy" via evaluateHistory, got "${result.status}"`,
    );
    assert(
      result.alertReason?.startsWith("run_timestamp_in_future:") ?? false,
      `a future-timestamped run history entry must carry the run_timestamp_in_future category via evaluateHistory, got: ${result.alertReason}`,
    );
  }

  // A future-timestamped PUBLISHED plan must not make an otherwise-stale
  // pipeline look trusted, even when the most recent run attempt itself
  // is a normal, non-future, non-failing (merely deferred) one.
  {
    const history: BackendRunHistoryEntry[] = [
      {
        at: new Date(now.getTime() + 10 * minuteMs),
        outcome: "published",
        reason: "valid plan published",
      },
      {
        at: now,
        outcome: "deferred",
        reason: "optimizer not ready: stale_tank_reading",
      },
    ];
    const result = evaluateHistory(history, now);
    assert(
      result.status !== "healthy",
      `a future-timestamped published plan must never yield status "healthy" via evaluateHistory, got "${result.status}"`,
    );
    assert(
      result.alertReason?.startsWith("validated_plan_timestamp_in_future:") ?? false,
      `a future-timestamped published plan must carry the validated_plan_timestamp_in_future category via evaluateHistory, got: ${result.alertReason}`,
    );
  }
}

// ---------------------------------------------------------------------
// PR #191 review (Codex) + follow-up review: duplicate suppression
// regression coverage. The original bug had two parts: (1) treating a
// duplicate-suppressed no-op (buildHeatingPlanPublicationDecision's own
// changedPlans === []) as if it were a real publication, and (2) letting
// that false "publication" refresh watchdog plan freshness. The
// follow-up review then found the FIX itself over-corrected: a genuine
// no-op run - the optimizer successfully reconfirming the stored plan is
// still correct - was being treated as no confirmation at all, so a long
// run of healthy no-ops could still eventually alert. Both are now
// fixed by splitting "was the plan just VALIDATED" (lastValidatedPlanAt -
// advances on published OR no_changes) from "was the plan just durably
// WRITTEN" (lastPublishedAt - advances on published only) - see
// heatingBackendWatchdog.ts's own comments. This proves it end to end, at
// both the tick level (runOneBackendTick, storedPlans) and the watchdog
// level (evaluateHistory, lastValidatedPlanAgeMinutes/lastPublishedAgeMinutes).
// ---------------------------------------------------------------------
function runDuplicateSuppressionSafetyChecks(): void {
  const now = new Date("2026-08-12T11:30:00.000Z");
  const prices = buildPriceRows("2026-08-12", 2, defaultPriceForHour);
  const reading: RawTankReading = {
    bottom_temp: 60,
    created_at: isoMinutesBefore(now, 5),
    heating: false,
    top_temp: 65,
  };

  // 1. ready + changedPlans non-empty -> publication actually occurs, and
  // BOTH validation and publication freshness advance together (they are
  // the same event here).
  const firstTick = runOneBackendTick({
    isCurrentlyHeating: false,
    latestReading: reading,
    now,
    prices,
    storedPlans: {},
  });
  assert(
    firstTick.outcome === "published",
    `duplicate-suppression fixture's first tick must publish (both plan_dates are new), got outcome=${firstTick.outcome}`,
  );
  assert(
    Object.keys(firstTick.storedPlans).length > 0,
    "a published tick must actually persist storedPlans",
  );
  {
    const singleEntryHistory: BackendRunHistoryEntry[] = [
      { at: now, outcome: firstTick.outcome, reason: firstTick.reason },
    ];
    const freshCheck = evaluateHistory(singleEntryHistory, now);
    assert(
      freshCheck.status === "healthy",
      `immediately after a genuine publication the watchdog must be healthy, got "${freshCheck.status}"`,
    );
    assert(
      freshCheck.lastValidatedPlanAgeMinutes === 0,
      "a genuine publication must advance lastValidatedPlanAt (it is, among other things, a validation)",
    );
    assert(
      freshCheck.lastPublishedAgeMinutes === 0,
      "a genuine publication must advance lastPublishedAt (it is, specifically, a durable write)",
    );
  }

  // 2. Re-running the EXACT same tick (identical now/prices/reading, only
  // storedPlans now pre-populated from step 1) recomputes an operationally
  // identical decision -> changedPlans empty -> "no_changes", NOT
  // "published", and storedPlans must be left completely untouched (no
  // durable write at all, not even a redundant identical one).
  const secondTick = runOneBackendTick({
    isCurrentlyHeating: false,
    latestReading: reading,
    now,
    prices,
    storedPlans: firstTick.storedPlans,
  });
  assert(
    secondTick.outcome === "no_changes",
    `re-running an identical tick against its own already-published storedPlans must be a no-op, got outcome=${secondTick.outcome}`,
  );
  assert(
    JSON.stringify(secondTick.storedPlans) === JSON.stringify(firstTick.storedPlans),
    "a no_changes tick must leave storedPlans exactly as they were - nothing durably re-written",
  );

  // PR #191 follow-up review: a genuine no-op VALIDATES the stored plan is
  // still correct, even though nothing needed to be (re)written -
  // lastValidatedPlanAt must advance to the no-op's own time (the plan was
  // just reconfirmed), while lastPublishedAt must stay exactly where the
  // original publish left it (nothing was actually written this hour) -
  // and the watchdog must be healthy either way.
  {
    const historyAfterNoOp: BackendRunHistoryEntry[] = [
      { at: now, outcome: "published", reason: firstTick.reason },
      { at: new Date(now.getTime() + hourMs), outcome: "no_changes", reason: secondTick.reason },
    ];
    const afterNoOpCheck = evaluateHistory(historyAfterNoOp, new Date(now.getTime() + hourMs));
    assert(
      afterNoOpCheck.lastValidatedPlanAgeMinutes === 0,
      "a no_changes run must advance lastValidatedPlanAt to its OWN time - it just reconfirmed the plan - " +
        `got ${afterNoOpCheck.lastValidatedPlanAgeMinutes}`,
    );
    assert(
      afterNoOpCheck.lastPublishedAgeMinutes === 60,
      "a no_changes run must NOT advance lastPublishedAt - nothing was durably written this hour, it must " +
        `still point at the original publish (60 min old) - got ${afterNoOpCheck.lastPublishedAgeMinutes}`,
    );
    assert(
      afterNoOpCheck.status === "healthy",
      "a genuine no-op validation must keep the watchdog healthy - it just confirmed the stored plan is " +
        "still correct",
    );
  }

  // 3. changed plan + failed write -> validation must NOT make the system
  // healthy; publication failure wins. Even though the optimizer itself
  // found a valid, changed plan (in some loose sense "validated" it), that
  // plan was never durably persisted - production#s stored row is still
  // the stale pre-change one, so this must alert immediately exactly like
  // run_error does, regardless of how fresh a PRIOR real validation still
  // is (see HeatingBackendRunOutcome's own "publication_failed" comment -
  // it is deliberately excluded from evaluateHistory's validated-outcome
  // search).
  {
    const historyWithFailedWrite: BackendRunHistoryEntry[] = [
      { at: now, outcome: "published", reason: "valid plan published" },
      {
        at: new Date(now.getTime() + hourMs),
        outcome: "publication_failed",
        reason: "simulated plan write/publish failure after a valid optimizer result",
      },
    ];
    const failedWriteCheck = evaluateHistory(
      historyWithFailedWrite,
      new Date(now.getTime() + hourMs),
    );
    assert(
      failedWriteCheck.status === "run_failed",
      `a publication_failed run must win over any no-op-style leniency and alert immediately as run_failed, ` +
        `got "${failedWriteCheck.status}"`,
    );
    assert(
      failedWriteCheck.alert === true,
      "a failed write of a genuinely changed plan must alert, not be hidden by a still-fresh prior validation",
    );
    assert(
      failedWriteCheck.lastValidatedPlanAgeMinutes === 60,
      "publication_failed must NOT itself advance lastValidatedPlanAt - only the earlier real publish counts, " +
        `got ${failedWriteCheck.lastValidatedPlanAgeMinutes}`,
    );
  }

  // 4. invalid/deferred optimizer -> validation heartbeat does not
  // advance either (neither outcome confirms the stored plan is correct -
  // one is an unsafe result, the other never got far enough to check).
  for (const nonValidatingOutcome of ["optimizer_invalid", "deferred"] as const) {
    const historyWithNonValidatingRun: BackendRunHistoryEntry[] = [
      { at: now, outcome: "published", reason: "valid plan published" },
      {
        at: new Date(now.getTime() + hourMs),
        outcome: nonValidatingOutcome,
        reason: `simulated ${nonValidatingOutcome} run`,
      },
    ];
    const check = evaluateHistory(historyWithNonValidatingRun, new Date(now.getTime() + hourMs));
    assert(
      check.lastValidatedPlanAgeMinutes === 60,
      `a "${nonValidatingOutcome}" run must NOT advance lastValidatedPlanAt - got ${check.lastValidatedPlanAgeMinutes}`,
    );
  }

  // 5. cron/run failure (run_error) -> validation heartbeat does not
  // advance either - the run never even reached a result to validate.
  {
    const historyWithRunError: BackendRunHistoryEntry[] = [
      { at: now, outcome: "published", reason: "valid plan published" },
      {
        at: new Date(now.getTime() + hourMs),
        outcome: "run_error",
        reason: "simulated run-heating-optimizer execution failure (unhandled exception)",
      },
    ];
    const check = evaluateHistory(historyWithRunError, new Date(now.getTime() + hourMs));
    assert(
      check.lastValidatedPlanAgeMinutes === 60,
      `a run_error must NOT advance lastValidatedPlanAt - got ${check.lastValidatedPlanAgeMinutes}`,
    );
    assert(check.status === "run_failed", "a run_error must still win immediately as run_failed");
  }

  // 6. A long stretch of genuine hourly no-op validations must NOT cause a
  // false alert at any point along the way, no matter how long it runs -
  // each hour is itself a fresh reconfirmation, so lastValidatedPlanAt
  // never actually goes stale. Checked at EVERY hour along a stretch
  // deliberately much longer than maxValidatedPlanAgeMinutes (150 min),
  // not just at the end - proves this holds throughout, not by accident
  // at one sampled instant.
  {
    const longNoOpHistory: BackendRunHistoryEntry[] = [
      { at: now, outcome: "published", reason: "valid plan published" },
    ];
    const longNoOpHours = 12; // 12h, well beyond the 150 min threshold if it were NOT correctly refreshed hourly
    for (let hourIndex = 1; hourIndex <= longNoOpHours; hourIndex += 1) {
      const hourNow = new Date(now.getTime() + hourIndex * hourMs);
      longNoOpHistory.push({
        at: hourNow,
        outcome: "no_changes",
        reason:
          "valid plan computed but operationally identical to the already-published plan - no durable write, storedPlans untouched",
      });
      const checkAtThisHour = evaluateHistory(longNoOpHistory, hourNow);
      assert(
        checkAtThisHour.status === "healthy",
        `expected status "healthy" at hour ${hourIndex} of a long stretch of genuine hourly no-op ` +
          `validations, got "${checkAtThisHour.status}" (this is exactly the false alert PR #191's ` +
          "follow-up review reported)",
      );
    }
    // lastPublishedAt, meanwhile, correctly keeps aging the whole time -
    // it is still purely diagnostic and never itself gates health.
    const finalCheck = evaluateHistory(
      longNoOpHistory,
      new Date(now.getTime() + longNoOpHours * hourMs),
    );
    assert(
      finalCheck.lastPublishedAgeMinutes === longNoOpHours * 60,
      "lastPublishedAt must keep aging throughout a long no-op stretch even while healthy - it is diagnostic " +
        `only, got ${finalCheck.lastPublishedAgeMinutes}`,
    );

    // 7. If the optimizer stops running altogether (no new entries at all -
    // pg_cron itself breaks), a long, otherwise-perfectly-healthy no-op
    // history must NOT hide that - run_overdue must still fire once
    // enough time has passed with no new run attempt, exactly as if the
    // history were empty.
    const cronStoppedNow = new Date(
      now.getTime() +
        longNoOpHours * hourMs +
        (illustrativeWatchdogConfig.maxRunIntervalMinutes + 30) * minuteMs,
    );
    const cronStoppedCheck = evaluateHistory(longNoOpHistory, cronStoppedNow);
    assert(
      cronStoppedCheck.status === "run_overdue",
      "a long healthy no-op history must not mask a stopped cron - once no new run attempt has been seen " +
        `for long enough, status must be run_overdue regardless of how clean the history was, got ` +
        `"${cronStoppedCheck.status}"`,
    );
  }

  // 8. Once a genuinely changed plan is published again after a no-op
  // stretch, publication resumes and BOTH lastValidatedPlanAt and
  // lastPublishedAt immediately advance together.
  {
    const history: BackendRunHistoryEntry[] = [
      { at: now, outcome: "published", reason: "valid plan published" },
      {
        at: new Date(now.getTime() + hourMs),
        outcome: "no_changes",
        reason:
          "valid plan computed but operationally identical to the already-published plan - no durable write, storedPlans untouched",
      },
      { at: new Date(now.getTime() + 2 * hourMs), outcome: "published", reason: "valid plan published" },
    ];
    const recoveredCheckAt = new Date(now.getTime() + 2 * hourMs);
    const recoveredCheck = evaluateHistory(history, recoveredCheckAt);
    assert(
      recoveredCheck.status === "healthy",
      `a genuine publication after a no-op stretch must be healthy, got "${recoveredCheck.status}"`,
    );
    assert(
      recoveredCheck.lastValidatedPlanAgeMinutes === 0,
      `a fresh publication must reset lastValidatedPlanAgeMinutes to 0, got ${recoveredCheck.lastValidatedPlanAgeMinutes}`,
    );
    assert(
      recoveredCheck.lastPublishedAgeMinutes === 0,
      `a fresh publication must reset lastPublishedAgeMinutes to 0, got ${recoveredCheck.lastPublishedAgeMinutes}`,
    );
  }
}

export function runAllScenarios(): ScenarioReportRow[] {
  runFutureTimestampSafetyChecks();
  runDuplicateSuppressionSafetyChecks();

  return [
    scenarioNormal(),
    scenarioCronMissing(),
    scenarioEdgeFunctionFailure(),
    scenarioStalePrices(),
    scenarioStaleTankReading(),
    scenarioOptimizerInvalid(),
    scenarioPlanPublicationFailure(),
    scenarioWeekWithoutApp(),
    scenarioFailureDuringWeek(),
  ];
}

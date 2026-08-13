// Pure, framework-agnostic health/staleness evaluation for the backend
// heating-optimizer pipeline (pg_cron -> run-heating-optimizer -> a
// published plan). Nothing in production calls this yet -
// run-heating-optimizer still only writes to heating_plan_shadow_runs (see
// its own header comment); this module exists so the offline fail-safe
// simulator (scripts/heatingBackendFailSafeScenarios.ts) has a real,
// unit-tested domain function to exercise instead of ad-hoc scenario-local
// logic, and so a future backend-primary watchdog/alerting job has a
// starting point instead of being invented from scratch under deploy
// pressure. See that simulator's report for the full context.
//
// Deliberately timestamp/status-driven only - no UI concerns, no
// Supabase/network calls, and no knowledge of Shelly's own local
// fallback/backup_hours logic (that stays entirely on the Shelly device,
// unmodified - see docs/PROJECT_CONTEXT.md section 4, and
// energiazen-mini/shelly/energyzen-controller.js). This function only
// answers "does the backend optimizer pipeline look healthy enough right
// now to trust its latest plan", so a caller can decide whether to keep
// leaning on Shelly's own local fallback instead.

// What the most recent backend optimizer run ATTEMPT (any invocation,
// success or failure) resulted in:
//  - "published": a valid optimizer result was produced and durably
//    written as the new plan.
//  - "optimizer_invalid": the run completed but optimizeHeatingPlan()
//    itself reported valid: false (violations present) - never publishable.
//  - "deferred": the run completed but buildHeatingPlanPublicationDecision
//    (or the readiness pre-check in front of it) deferred publication
//    (e.g. stale/missing tank reading, no price hours available, unknown
//    heating status) - see run-heating-optimizer/logic.ts.
//  - "publication_failed": the run produced a valid, ready-to-publish
//    result, but the write/publish step itself failed.
//  - "run_error": the run attempt itself threw before producing a result
//    (e.g. an unhandled Edge Function exception, a fetch failure with no
//    fallback).
export type HeatingBackendRunOutcome =
  | "published"
  | "optimizer_invalid"
  | "deferred"
  | "publication_failed"
  | "run_error";

// Both thresholds are REQUIRED, not defaulted - the current codebase does
// not define how old a backend run/published plan may get before it's
// unsafe to trust (see this module's simulator report). Neither value
// supplied by a caller here is validated as a "correct" production
// number; that decision is explicitly out of scope for this module and
// must be made separately, deliberately, by someone who owns the
// production cron cadence and alerting policy.
export type HeatingBackendWatchdogConfig = {
  /**
   * How old the most recent run ATTEMPT (any outcome, including a failed
   * one - an "attempt" only requires the function to have been invoked)
   * may be before the cron cadence itself is considered broken.
   */
  maxRunIntervalMinutes: number;
  /**
   * How old the most recently PUBLISHED valid plan may be before it is no
   * longer trusted as fresh, independent of whether the most recent run
   * attempt(s) succeeded.
   */
  maxValidPlanAgeMinutes: number;
};

export type HeatingBackendHealthInput = {
  config: HeatingBackendWatchdogConfig;
  /** ISO timestamp of the most recent run ATTEMPT, or null if none has ever been observed. */
  lastRunAt: string | null;
  /** Outcome of that same most recent attempt, or null if none has ever been observed. */
  lastRunOutcome: HeatingBackendRunOutcome | null;
  /** Free-text diagnostic for lastRunOutcome (readiness reason, violations, error message, ...). */
  lastRunReason: string | null;
  /** ISO timestamp of the most recent successfully PUBLISHED valid plan, or null if none has ever been observed. */
  lastValidPlanAt: string | null;
  now: Date;
};

export type HeatingBackendHealthStatus =
  | "healthy"
  | "run_overdue"
  | "run_failed"
  | "no_recent_valid_plan";

export type HeatingBackendHealthResult = {
  alert: boolean;
  alertReason: string | null;
  fallbackRecommended: boolean;
  lastRunAgeMinutes: number | null;
  lastValidPlanAgeMinutes: number | null;
  status: HeatingBackendHealthStatus;
};

function ageMinutes(isoTimestamp: string | null, now: Date): number | null {
  if (!isoTimestamp) {
    return null;
  }

  const time = new Date(isoTimestamp).getTime();

  if (Number.isNaN(time)) {
    return null;
  }

  return (now.getTime() - time) / (60 * 1000);
}

// Three independent, individually-explainable checks, evaluated in this
// priority order when more than one applies at once:
//   1. run_overdue - the cron cadence itself looks broken (no attempt seen
//      recently, or ever). This is the most severe case: it means even
//      run_error/publication_failed outcomes have stopped arriving, so we
//      cannot even see WHY the pipeline is unhealthy.
//   2. run_failed - the most recent attempt itself reported failure
//      (run_error or publication_failed). Reported immediately, without
//      waiting for the plan to actually go stale - a failed run today is
//      worth knowing about today even if yesterday's plan is technically
//      still "fresh enough".
//   3. no_recent_valid_plan - no run attempt has outright failed, but
//      nothing valid has actually been published recently either (e.g. a
//      run of deferred/optimizer_invalid outcomes: stale inputs, or an
//      optimizer result that never clears its own safety violations).
// Any one of these sets alert + fallbackRecommended; none of them being
// true is the only "healthy" result.
export function evaluateHeatingBackendHealth({
  config,
  lastRunAt,
  lastRunOutcome,
  lastRunReason,
  lastValidPlanAt,
  now,
}: HeatingBackendHealthInput): HeatingBackendHealthResult {
  const lastRunAgeMinutes = ageMinutes(lastRunAt, now);
  const lastValidPlanAgeMinutes = ageMinutes(lastValidPlanAt, now);

  const runOverdue =
    lastRunAgeMinutes === null || lastRunAgeMinutes > config.maxRunIntervalMinutes;
  const runFailed = lastRunOutcome === "run_error" || lastRunOutcome === "publication_failed";
  const validPlanStale =
    lastValidPlanAgeMinutes === null || lastValidPlanAgeMinutes > config.maxValidPlanAgeMinutes;

  if (runOverdue) {
    return {
      alert: true,
      alertReason:
        lastRunAt === null
          ? "cron_missing: no backend optimizer run has ever been observed"
          : `cron_missing: last run attempt was ${lastRunAgeMinutes?.toFixed(1)} min ago, exceeding maxRunIntervalMinutes (${config.maxRunIntervalMinutes})`,
      fallbackRecommended: true,
      lastRunAgeMinutes,
      lastValidPlanAgeMinutes,
      status: "run_overdue",
    };
  }

  if (runFailed) {
    return {
      alert: true,
      alertReason: `${lastRunOutcome}: ${lastRunReason ?? "no further detail supplied"}`,
      fallbackRecommended: true,
      lastRunAgeMinutes,
      lastValidPlanAgeMinutes,
      status: "run_failed",
    };
  }

  if (validPlanStale) {
    return {
      alert: true,
      alertReason:
        lastValidPlanAt === null
          ? "no_recent_valid_plan: no published valid plan has ever been observed"
          : `no_recent_valid_plan: last published valid plan was ${lastValidPlanAgeMinutes?.toFixed(1)} min ago, exceeding maxValidPlanAgeMinutes (${config.maxValidPlanAgeMinutes})`,
      fallbackRecommended: true,
      lastRunAgeMinutes,
      lastValidPlanAgeMinutes,
      status: "no_recent_valid_plan",
    };
  }

  return {
    alert: false,
    alertReason: null,
    fallbackRecommended: false,
    lastRunAgeMinutes,
    lastValidPlanAgeMinutes,
    status: "healthy",
  };
}

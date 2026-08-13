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
//  - "published": a valid optimizer result was produced AND at least one
//    plan was actually durably written (buildHeatingPlanPublicationDecision's
//    own changedPlans was non-empty - see heatingPlanPublication.ts's
//    getChangedHeatingPlans/areHeatingPlansOperationallyEqual).
//  - "no_changes": the run completed and produced a valid, ready
//    decision, but every computed plan was operationally identical to
//    what's already stored (changedPlans was empty) - production's own
//    duplicate-suppression means no write would actually happen here. The
//    backend has nonetheless just successfully CONFIRMED the already-
//    stored plan is still correct - see the lastValidatedPlanAt/
//    lastPublishedAt split below for why this matters (PR #191 review).
//  - "optimizer_invalid": the run completed but optimizeHeatingPlan()
//    itself reported valid: false (violations present) - never publishable.
//  - "deferred": the run completed but buildHeatingPlanPublicationDecision
//    (or the readiness pre-check in front of it) deferred publication
//    (e.g. stale/missing tank reading, no price hours available, unknown
//    heating status) - see run-heating-optimizer/logic.ts.
//  - "publication_failed": the run produced a valid, ready-to-publish
//    result with at least one genuinely changed plan, but the write/
//    publish step itself failed. Deliberately NOT treated as a
//    validation either, even though the optimizer itself succeeded: the
//    plan that was actually confirmed valid is the CHANGED one, and that
//    one was never durably persisted - the stored row a future caller
//    would read back is the stale pre-change one, so nothing here should
//    be read as "the stored plan was just reconfirmed". Publication
//    failure must win over any no-op-style leniency (see report).
//  - "run_error": the run attempt itself threw before producing a result
//    (e.g. an unhandled Edge Function exception, a fetch failure with no
//    fallback).
export type HeatingBackendRunOutcome =
  | "published"
  | "no_changes"
  | "optimizer_invalid"
  | "deferred"
  | "publication_failed"
  | "run_error";

// Both thresholds are REQUIRED, not defaulted - the current codebase does
// not define how old a backend run/validated plan may get before it's
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
   * How old the most recently VALIDATED plan may be before it is no
   * longer trusted as fresh - see lastValidatedPlanAt below for exactly
   * what counts as a validation. Independent of whether the most recent
   * run attempt(s) succeeded, and independent of whether that validation
   * happened to also involve a durable write (see lastPublishedAt).
   */
  maxValidatedPlanAgeMinutes: number;
};

export type HeatingBackendHealthInput = {
  config: HeatingBackendWatchdogConfig;
  /** ISO timestamp of the most recent run ATTEMPT, or null if none has ever been observed. */
  lastRunAt: string | null;
  /** Outcome of that same most recent attempt, or null if none has ever been observed. */
  lastRunOutcome: HeatingBackendRunOutcome | null;
  /** Free-text diagnostic for lastRunOutcome (readiness reason, violations, error message, ...). */
  lastRunReason: string | null;
  /**
   * ISO timestamp of the most recent run that successfully CONFIRMED the
   * stored plan is still correct - either by durably publishing a changed
   * one ("published"), or by recomputing and finding the already-stored
   * plan still operationally identical ("no_changes" - a real
   * duplicate-suppressed no-op still IS a successful validation, just not
   * a write). Deliberately does NOT advance on "publication_failed": that
   * outcome means a *different*, unpersisted plan was found valid, not
   * that the currently-stored one was reconfirmed - see
   * HeatingBackendRunOutcome's own comment. null if no validation has
   * ever been observed.
   *
   * THIS is what gates the "no_recent_valid_plan" status below, not
   * lastPublishedAt - a long run of genuine no-op validations must never
   * look unhealthy purely because nothing needed to be (re)written (PR
   * #191 review).
   */
  lastValidatedPlanAt: string | null;
  /**
   * ISO timestamp of the most recent run that actually performed a
   * durable write (outcome "published" specifically - changedPlans was
   * non-empty and the write succeeded). Purely diagnostic here - it does
   * NOT by itself gate "healthy" (see lastValidatedPlanAt) - but is kept
   * as its own explicit, separately-tracked concept because a future
   * consumer (e.g. a Shelly-side "is this heating_plans row stale"
   * safeguard) cares specifically about when the row was last actually
   * touched, not merely when it was last reconfirmed correct. null if no
   * publication has ever been observed.
   */
  lastPublishedAt: string | null;
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
  lastPublishedAgeMinutes: number | null;
  lastRunAgeMinutes: number | null;
  lastValidatedPlanAgeMinutes: number | null;
  status: HeatingBackendHealthStatus;
};

// Can be negative - a supplied timestamp later than `now` (clock skew, a
// malformed row, a caller bug) is deliberately NOT clamped to 0 here. The
// caller (evaluateHeatingBackendHealth) is the one responsible for
// treating a negative age as untrustworthy rather than "very fresh" - see
// its own comment. Mirrors the same
// lib/tankMonitorAlert.ts/computeTankReadingAgeMinutes shape (also allowed
// to go negative, for the same reason: isTankReadingStale there already
// treats a negative age as stale, never as fresh).
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
//      recently, or ever - or lastRunAt is nonsensically in the future,
//      see below). This is the most severe case: it means even
//      run_error/publication_failed outcomes have stopped arriving, so we
//      cannot even see WHY the pipeline is unhealthy. A long, healthy-
//      looking run of validated no_changes entries in the past does NOT
//      protect against this - run_overdue is judged purely from
//      lastRunAt, so if the pipeline stops running altogether, this still
//      fires regardless of how clean its history was up to that point.
//   2. run_failed - the most recent attempt itself reported failure
//      (run_error or publication_failed). Reported immediately, without
//      waiting for the plan to actually go stale - a failed run today is
//      worth knowing about today even if yesterday's plan is technically
//      still "fresh enough". A changed-but-unpublished plan
//      (publication_failed) always wins here over any no-op leniency -
//      see lastValidatedPlanAt's own comment for why that outcome is
//      deliberately excluded from counting as a validation at all.
//   3. no_recent_valid_plan - no run attempt has outright failed, but
//      nothing has actually CONFIRMED the stored plan recently either
//      (e.g. a run of deferred/optimizer_invalid outcomes: stale inputs,
//      an optimizer result that never clears its own safety violations,
//      or lastValidatedPlanAt is nonsensically in the future, see below).
//      Judged against lastValidatedPlanAt, not lastPublishedAt - a
//      genuine duplicate-suppressed no-op (see "no_changes") counts as a
//      confirmation and keeps this healthy even though nothing was
//      written.
// Any one of these sets alert + fallbackRecommended; none of them being
// true is the only "healthy" result.
//
// Future timestamps (lastRunAgeMinutes/lastValidatedPlanAgeMinutes < 0): a
// clock-skewed, malformed, or otherwise impossible "in the future"
// timestamp must never be read as "very fresh" and must never produce
// status: "healthy" - same safety principle
// lib/tankReadingFreshness.ts/isTankReadingStale already applies to tank
// readings (a negative reading age is treated as stale, not fresh) is
// applied here to both watched timestamps. Folded into the SAME
// run_overdue/no_recent_valid_plan buckets and priority order a merely-
// old or missing timestamp would hit (requirement: preserve existing
// status priority semantics) rather than a new status value, but each
// gets its own explicit alertReason category
// ("run_timestamp_in_future"/"validated_plan_timestamp_in_future")
// distinct from the plain "cron_missing"/"no_recent_valid_plan" staleness
// wording, since "the timestamp claims to be from the future" is a
// materially different, more alarming condition than "the timestamp is
// merely old" and callers/logs should be able to tell them apart.
// lastPublishedAt is diagnostic only and is never checked for
// staleness/future-ness here - it doesn't gate anything.
export function evaluateHeatingBackendHealth({
  config,
  lastRunAt,
  lastRunOutcome,
  lastRunReason,
  lastValidatedPlanAt,
  lastPublishedAt,
  now,
}: HeatingBackendHealthInput): HeatingBackendHealthResult {
  const lastRunAgeMinutes = ageMinutes(lastRunAt, now);
  const lastValidatedPlanAgeMinutes = ageMinutes(lastValidatedPlanAt, now);
  const lastPublishedAgeMinutes = ageMinutes(lastPublishedAt, now);

  const lastRunIsInFuture = lastRunAgeMinutes !== null && lastRunAgeMinutes < 0;
  const lastValidatedPlanIsInFuture =
    lastValidatedPlanAgeMinutes !== null && lastValidatedPlanAgeMinutes < 0;

  const runOverdue =
    lastRunAgeMinutes === null ||
    lastRunIsInFuture ||
    lastRunAgeMinutes > config.maxRunIntervalMinutes;
  const runFailed = lastRunOutcome === "run_error" || lastRunOutcome === "publication_failed";
  const validatedPlanStale =
    lastValidatedPlanAgeMinutes === null ||
    lastValidatedPlanIsInFuture ||
    lastValidatedPlanAgeMinutes > config.maxValidatedPlanAgeMinutes;

  if (runOverdue) {
    return {
      alert: true,
      alertReason: lastRunIsInFuture
        ? `run_timestamp_in_future: last run attempt's timestamp (${lastRunAt}) is ${Math.abs(lastRunAgeMinutes as number).toFixed(1)} min ahead of now - an impossible timestamp is never treated as fresh`
        : lastRunAt === null
          ? "cron_missing: no backend optimizer run has ever been observed"
          : `cron_missing: last run attempt was ${lastRunAgeMinutes?.toFixed(1)} min ago, exceeding maxRunIntervalMinutes (${config.maxRunIntervalMinutes})`,
      fallbackRecommended: true,
      lastPublishedAgeMinutes,
      lastRunAgeMinutes,
      lastValidatedPlanAgeMinutes,
      status: "run_overdue",
    };
  }

  if (runFailed) {
    return {
      alert: true,
      alertReason: `${lastRunOutcome}: ${lastRunReason ?? "no further detail supplied"}`,
      fallbackRecommended: true,
      lastPublishedAgeMinutes,
      lastRunAgeMinutes,
      lastValidatedPlanAgeMinutes,
      status: "run_failed",
    };
  }

  if (validatedPlanStale) {
    return {
      alert: true,
      alertReason: lastValidatedPlanIsInFuture
        ? `validated_plan_timestamp_in_future: last validated plan's timestamp (${lastValidatedPlanAt}) is ${Math.abs(lastValidatedPlanAgeMinutes as number).toFixed(1)} min ahead of now - an impossible timestamp is never treated as trusted`
        : lastValidatedPlanAt === null
          ? "no_recent_valid_plan: no validated plan has ever been observed"
          : `no_recent_valid_plan: last validated plan was ${lastValidatedPlanAgeMinutes?.toFixed(1)} min ago, exceeding maxValidatedPlanAgeMinutes (${config.maxValidatedPlanAgeMinutes})`,
      fallbackRecommended: true,
      lastPublishedAgeMinutes,
      lastRunAgeMinutes,
      lastValidatedPlanAgeMinutes,
      status: "no_recent_valid_plan",
    };
  }

  return {
    alert: false,
    alertReason: null,
    fallbackRecommended: false,
    lastPublishedAgeMinutes,
    lastRunAgeMinutes,
    lastValidatedPlanAgeMinutes,
    status: "healthy",
  };
}

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

// Three DIFFERENT reasons a timestamp might not yield a usable age, kept
// explicitly distinct rather than collapsed into a single "null" the way
// an age-only helper would:
//  - "missing": the field was never populated at all (isoTimestamp is
//    null) - legitimate and expected on a cold start (e.g. no run has
//    ever been observed yet).
//  - "invalid": isoTimestamp is non-null but does not parse as a date at
//    all (a malformed row, a caller bug, truncated/corrupted data) - never
//    legitimate, and a materially different problem from "missing".
//  - "value": a genuine parsed instant, which the caller then separately
//    checks for being in the future (clock skew) or merely too old.
// Collapsing "invalid" into the same bucket as "missing" is exactly what
// previously produced misleading diagnostics like "last run attempt was
// undefined min ago" - the old code assumed a non-null timestamp always
// meant a parseable one, so a malformed-but-non-null value fell through
// into the "compute an age and format it" branch with nothing to format.
//
// The parsed "value" case can still be negative (now earlier than the
// timestamp - clock skew) - deliberately NOT clamped to 0 here, mirroring
// lib/tankMonitorAlert.ts/computeTankReadingAgeMinutes (also allowed to go
// negative, for the same reason: isTankReadingStale there already treats
// a negative age as stale, never as fresh). The caller
// (evaluateHeatingBackendHealth) is responsible for treating both a
// negative age and an "invalid" assessment as untrustworthy.
type TimestampAssessment =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "value"; ageMinutes: number };

function assessTimestamp(isoTimestamp: string | null, now: Date): TimestampAssessment {
  if (!isoTimestamp) {
    return { kind: "missing" };
  }

  const time = new Date(isoTimestamp).getTime();

  if (Number.isNaN(time)) {
    return { kind: "invalid" };
  }

  return { kind: "value", ageMinutes: (now.getTime() - time) / (60 * 1000) };
}

function ageMinutesOf(assessment: TimestampAssessment): number | null {
  return assessment.kind === "value" ? assessment.ageMinutes : null;
}

// Three independent, individually-explainable checks, evaluated in this
// priority order when more than one applies at once:
//   1. run_overdue - the cron cadence itself looks broken: no attempt seen
//      recently, or ever, or lastRunAt is unparsable, or it is
//      nonsensically in the future (see below). This is the most severe
//      case: it means even run_error/publication_failed outcomes have
//      stopped arriving, so we cannot even see WHY the pipeline is
//      unhealthy. A long, healthy-looking run of validated no_changes
//      entries in the past does NOT protect against this - run_overdue is
//      judged purely from lastRunAt, so if the pipeline stops running
//      altogether, this still fires regardless of how clean its history
//      was up to that point.
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
//      or lastValidatedPlanAt is unparsable or nonsensically in the
//      future, see below). Judged against lastValidatedPlanAt, not
//      lastPublishedAt - a genuine duplicate-suppressed no-op (see
//      "no_changes") counts as a confirmation and keeps this healthy even
//      though nothing was written.
// Any one of these sets alert + fallbackRecommended; none of them being
// true is the only "healthy" result.
//
// Untrustworthy timestamps - two distinct kinds, both folded into the SAME
// run_overdue/no_recent_valid_plan buckets and priority order a merely-old
// or missing timestamp would hit (preserving existing status priority
// semantics), but each with its own explicit alertReason category rather
// than a generic staleness message:
//  - Future (ageMinutes < 0): a clock-skewed or otherwise impossible
//    "in the future" timestamp must never be read as "very fresh" - same
//    safety principle lib/tankReadingFreshness.ts/isTankReadingStale
//    already applies to tank readings. Categories:
//    "run_timestamp_in_future"/"validated_plan_timestamp_in_future".
//  - Invalid (present but unparsable - a malformed row, a caller bug):
//    must never be silently treated as "missing" (which is a normal,
//    expected cold-start state) nor fall through into a staleness message
//    with nothing to format - that previously produced diagnostics like
//    "last run attempt was undefined min ago". Categories:
//    "run_timestamp_invalid"/"validated_plan_timestamp_invalid".
// lastPublishedAt is diagnostic only and is never checked for staleness/
// future-ness/validity here - it doesn't gate anything - but is still
// assessed via the same assessTimestamp so a malformed value there safely
// becomes null (like "missing") rather than producing a garbage age.
export function evaluateHeatingBackendHealth({
  config,
  lastRunAt,
  lastRunOutcome,
  lastRunReason,
  lastValidatedPlanAt,
  lastPublishedAt,
  now,
}: HeatingBackendHealthInput): HeatingBackendHealthResult {
  const lastRunAssessment = assessTimestamp(lastRunAt, now);
  const lastValidatedPlanAssessment = assessTimestamp(lastValidatedPlanAt, now);
  const lastPublishedAssessment = assessTimestamp(lastPublishedAt, now);

  const lastRunAgeMinutes = ageMinutesOf(lastRunAssessment);
  const lastValidatedPlanAgeMinutes = ageMinutesOf(lastValidatedPlanAssessment);
  const lastPublishedAgeMinutes = ageMinutesOf(lastPublishedAssessment);

  const lastRunIsInvalid = lastRunAssessment.kind === "invalid";
  const lastRunIsInFuture = lastRunAssessment.kind === "value" && lastRunAssessment.ageMinutes < 0;
  const lastValidatedPlanIsInvalid = lastValidatedPlanAssessment.kind === "invalid";
  const lastValidatedPlanIsInFuture =
    lastValidatedPlanAssessment.kind === "value" && lastValidatedPlanAssessment.ageMinutes < 0;

  const runOverdue =
    lastRunAssessment.kind === "missing" ||
    lastRunIsInvalid ||
    lastRunIsInFuture ||
    (lastRunAssessment.kind === "value" &&
      lastRunAssessment.ageMinutes > config.maxRunIntervalMinutes);
  const runFailed = lastRunOutcome === "run_error" || lastRunOutcome === "publication_failed";
  const validatedPlanStale =
    lastValidatedPlanAssessment.kind === "missing" ||
    lastValidatedPlanIsInvalid ||
    lastValidatedPlanIsInFuture ||
    (lastValidatedPlanAssessment.kind === "value" &&
      lastValidatedPlanAssessment.ageMinutes > config.maxValidatedPlanAgeMinutes);

  if (runOverdue) {
    return {
      alert: true,
      alertReason: lastRunIsInvalid
        ? `run_timestamp_invalid: last run attempt's timestamp (${JSON.stringify(lastRunAt)}) could not be parsed as a valid date - an unparsable timestamp is never treated as fresh`
        : lastRunIsInFuture
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
      alertReason: lastValidatedPlanIsInvalid
        ? `validated_plan_timestamp_invalid: last validated plan's timestamp (${JSON.stringify(lastValidatedPlanAt)}) could not be parsed as a valid date - an unparsable timestamp is never treated as trusted`
        : lastValidatedPlanIsInFuture
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

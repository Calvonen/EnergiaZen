import {
  evaluateHeatingBackendHealth,
  type HeatingBackendWatchdogConfig,
} from "./heatingBackendWatchdog";

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

export function runHeatingBackendWatchdogUnitTests() {
  const now = new Date("2026-08-12T11:30:00.000Z");
  const config: HeatingBackendWatchdogConfig = {
    maxRunIntervalMinutes: 90,
    maxValidatedPlanAgeMinutes: 150,
  };
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60 * 1000).toISOString();
  const minutesFromNow = (minutes: number) => minutesAgo(-minutes);

  // 1. Everything fresh and successful -> healthy, no alert, no fallback.
  // lastPublishedAt and lastValidatedPlanAt agree here (a genuine
  // "published" run advances both).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(5),
      now,
    });
    assertEqual(result.status, "healthy", "fresh successful run must be healthy");
    assertEqual(result.alert, false, "healthy state must not alert");
    assertEqual(result.fallbackRecommended, false, "healthy state must not recommend fallback");
    assertEqual(result.alertReason, null, "healthy state must not carry an alert reason");
  }

  // 2. No run has ever been observed at all -> run_overdue (covers a
  // brand-new/never-configured watchdog, and the extreme end of
  // CRON_MISSING).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: null,
      lastRunAt: null,
      lastRunOutcome: null,
      lastRunReason: null,
      lastValidatedPlanAt: null,
      now,
    });
    assertEqual(result.status, "run_overdue", "no run ever observed must be run_overdue");
    assertEqual(result.alert, true, "no run ever observed must alert");
    assertEqual(result.fallbackRecommended, true, "no run ever observed must recommend fallback");
    assert(
      result.alertReason?.startsWith("cron_missing:"),
      "no-run-ever alert reason must be a cron_missing reason",
    );
  }

  // 3. A run happened recently, but too long ago relative to
  // maxRunIntervalMinutes -> run_overdue (CRON_MISSING: pg_cron itself
  // stopped firing).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(200),
      lastRunAt: minutesAgo(200),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(200),
      now,
    });
    assertEqual(result.status, "run_overdue", "a run 200 min ago (> 90 min limit) must be run_overdue");
    assertEqual(result.alert, true, "an overdue run must alert");
    assertEqual(result.fallbackRecommended, true, "an overdue run must recommend fallback");
  }

  // 4. The most recent attempt itself failed (run_error) - must alert
  // IMMEDIATELY, even though the previous validated plan is still well
  // within maxValidatedPlanAgeMinutes. This is what lets
  // EDGE_FUNCTION_FAILURE be detected on the very run it happens, not
  // only once the plan goes stale.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(20),
      lastRunAt: minutesAgo(2),
      lastRunOutcome: "run_error",
      lastRunReason: "TypeError: fetch failed",
      lastValidatedPlanAt: minutesAgo(20),
      now,
    });
    assertEqual(result.status, "run_failed", "a run_error outcome must be run_failed");
    assertEqual(result.alert, true, "a failed run must alert even with a fresh prior plan");
    assertEqual(result.fallbackRecommended, true, "a failed run must recommend fallback");
    assert(
      result.alertReason?.startsWith("run_error:"),
      "run_error alert reason must name the outcome",
    );
  }

  // 5. Same as above but publication_failed - also run_failed. PR #191
  // follow-up review: a changed-but-unpublished plan must win over any
  // no-op leniency - even though the optimizer itself found a valid
  // plan, that plan was never durably persisted, so this must alert
  // immediately just like run_error does, regardless of how fresh the
  // PREVIOUS validation/publication still is.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(20),
      lastRunAt: minutesAgo(2),
      lastRunOutcome: "publication_failed",
      lastRunReason: "insert failed: connection reset",
      lastValidatedPlanAt: minutesAgo(20),
      now,
    });
    assertEqual(result.status, "run_failed", "a publication_failed outcome must be run_failed");
    assertEqual(result.alert, true, "a publication failure must alert");
  }

  // 6. The most recent attempt was merely deferred (e.g. stale inputs),
  // not an outright failure, but nothing has validated the plan recently
  // enough either -> no_recent_valid_plan, not run_failed.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(400),
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "deferred",
      lastRunReason: "optimizer not ready: stale_tank_reading",
      lastValidatedPlanAt: minutesAgo(400),
      now,
    });
    assertEqual(
      result.status,
      "no_recent_valid_plan",
      "a merely-deferred recent attempt with a stale prior validation must be no_recent_valid_plan",
    );
    assertEqual(result.alert, true, "a stale validated plan must alert");
    assert(
      result.alertReason?.startsWith("no_recent_valid_plan:"),
      "stale-plan alert reason must name the condition",
    );
  }

  // 7. A merely-deferred recent attempt is NOT itself an alert as long as
  // the last validated plan is still fresh enough - a single deferred run
  // (e.g. one stale tank reading) must not immediately page anyone while
  // the previous validation is still within its trusted window.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(30),
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "deferred",
      lastRunReason: "optimizer not ready: stale_tank_reading",
      lastValidatedPlanAt: minutesAgo(30),
      now,
    });
    assertEqual(
      result.status,
      "healthy",
      "a single deferred run must stay healthy while the prior validation is still fresh",
    );
    assertEqual(result.alert, false, "a single deferred run alone must not alert");
  }

  // 8. Recovery: after a failure, a fresh successful run immediately
  // clears the alert - the watchdog is driven entirely by current
  // state, not by remembering that a failure happened earlier (system
  // must not get stuck in a permanent fault mode).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(0),
      lastRunAt: minutesAgo(0),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(0),
      now,
    });
    assertEqual(result.status, "healthy", "an immediately-fresh successful run must be healthy");
    assertEqual(result.alert, false, "recovery must clear the alert");
    assertEqual(result.fallbackRecommended, false, "recovery must clear the fallback recommendation");
  }

  // 9. run_overdue takes priority even when lastRunOutcome would otherwise
  // read as a success - an old timestamp means the pipeline itself may be
  // dead, regardless of what outcome its last (long-ago) attempt reported.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(500),
      lastRunAt: minutesAgo(500),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(500),
      now,
    });
    assertEqual(
      result.status,
      "run_overdue",
      "an old timestamp must win over a stale 'published' outcome label",
    );
  }

  // ageMinutes reporting: sanity-check the numeric ages returned alongside
  // the status, since callers may want to display them.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(12),
      lastRunAt: minutesAgo(12),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(12),
      now,
    });
    assert(
      result.lastRunAgeMinutes !== null && Math.abs(result.lastRunAgeMinutes - 12) < 0.01,
      "lastRunAgeMinutes must reflect the supplied timestamp's age",
    );
    assert(
      result.lastValidatedPlanAgeMinutes !== null &&
        Math.abs(result.lastValidatedPlanAgeMinutes - 12) < 0.01,
      "lastValidatedPlanAgeMinutes must reflect the supplied timestamp's age",
    );
    assert(
      result.lastPublishedAgeMinutes !== null &&
        Math.abs(result.lastPublishedAgeMinutes - 12) < 0.01,
      "lastPublishedAgeMinutes must reflect the supplied timestamp's age",
    );
  }

  // 10. PR #191 review (Codex): a future lastRunAt (clock skew/malformed
  // row/caller bug) must NEVER be read as "very fresh" - it must be
  // treated as run_overdue, the same bucket a missing/too-old run hits,
  // with its own distinct alertReason category so it is not confused with
  // an ordinary staleness explanation. lastValidatedPlanAt is deliberately
  // fresh here too, to prove the future lastRunAt alone is what forces
  // the unhealthy result (nothing else in this fixture would).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: minutesFromNow(10),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(5),
      now,
    });
    assertEqual(
      result.status,
      "run_overdue",
      "a future lastRunAt must be treated as run_overdue, never as fresh",
    );
    assertEqual(result.alert, true, "a future lastRunAt must alert");
    assertEqual(result.fallbackRecommended, true, "a future lastRunAt must recommend fallback");
    assert(
      result.alertReason?.startsWith("run_timestamp_in_future:"),
      `future lastRunAt must carry its own distinct alertReason category, got: ${result.alertReason}`,
    );
    assert(
      result.lastRunAgeMinutes !== null && result.lastRunAgeMinutes < 0,
      "lastRunAgeMinutes must still report the actual (negative) computed age for diagnostics",
    );
  }

  // 11. Symmetric case: a future lastValidatedPlanAt must never let an old
  // plan appear trusted just because wall-clock time hasn't caught up to
  // its claimed timestamp yet. lastRunAt is fresh and successful here, so
  // only the future lastValidatedPlanAt can be what forces
  // no_recent_valid_plan.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesFromNow(10),
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesFromNow(10),
      now,
    });
    assertEqual(
      result.status,
      "no_recent_valid_plan",
      "a future lastValidatedPlanAt must be treated as no_recent_valid_plan, never as trusted",
    );
    assertEqual(result.alert, true, "a future lastValidatedPlanAt must alert");
    assertEqual(result.fallbackRecommended, true, "a future lastValidatedPlanAt must recommend fallback");
    assert(
      result.alertReason?.startsWith("validated_plan_timestamp_in_future:"),
      `future lastValidatedPlanAt must carry its own distinct alertReason category, got: ${result.alertReason}`,
    );
    assert(
      result.lastValidatedPlanAgeMinutes !== null && result.lastValidatedPlanAgeMinutes < 0,
      "lastValidatedPlanAgeMinutes must still report the actual (negative) computed age for diagnostics",
    );
  }

  // 12. Both timestamps future at once -> run_overdue wins (same priority
  // order a merely-old lastRunAt already takes over a merely-old
  // lastValidatedPlanAt - PR #191 review requirement to preserve existing
  // status priority semantics).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesFromNow(15),
      lastRunAt: minutesFromNow(15),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesFromNow(15),
      now,
    });
    assertEqual(
      result.status,
      "run_overdue",
      "when both timestamps are future, run_overdue must win over no_recent_valid_plan",
    );
    assertEqual(result.alert, true, "both-future must alert");
    assert(
      result.alertReason?.startsWith("run_timestamp_in_future:"),
      "both-future alertReason must be the run_timestamp_in_future category, not the validated-plan one",
    );
  }

  // 13. Boundary: a timestamp exactly equal to `now` (age === 0) is NOT a
  // future timestamp and must remain valid/fresh - only a STRICTLY
  // negative age is untrustworthy.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: now.toISOString(),
      lastRunAt: now.toISOString(),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: now.toISOString(),
      now,
    });
    assertEqual(
      result.status,
      "healthy",
      "a timestamp exactly equal to now (age 0) must remain healthy, not be treated as future",
    );
    assertEqual(result.alert, false, "age-zero timestamps must not alert");
    assertEqual(result.lastRunAgeMinutes, 0, "age-zero lastRunAt must report exactly 0, not negative");
    assertEqual(
      result.lastValidatedPlanAgeMinutes,
      0,
      "age-zero lastValidatedPlanAt must report exactly 0, not negative",
    );
  }

  // 14. Normal past timestamps still behave exactly as before this fix -
  // re-run of case 1's fixture, unchanged.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(5),
      now,
    });
    assertEqual(
      result.status,
      "healthy",
      "ordinary past timestamps must still resolve to healthy after the future-timestamp fix",
    );
    assertEqual(result.alert, false, "ordinary past timestamps must not alert");
    assertEqual(result.alertReason, null, "ordinary past timestamps must not carry an alert reason");
  }

  // --- PR #191 follow-up review: lastValidatedPlanAt vs lastPublishedAt ---
  // These prove evaluateHeatingBackendHealth's OWN health decision uses
  // lastValidatedPlanAt, never lastPublishedAt, for the no_recent_valid_plan
  // check - the fail-safe simulator's evaluateHistory() is responsible for
  // deriving these two timestamps correctly from run history (its own
  // dedicated tests cover that derivation), but the pure health function
  // itself must behave correctly no matter how far apart the two
  // timestamps are.

  // 15. A duplicate-suppressed no-op run keeps lastValidatedPlanAt fresh
  // even while lastPublishedAt is old - must be healthy, since the plan
  // was just reconfirmed correct even though nothing needed writing.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(400), // long-ago last durable write
      lastRunAt: minutesAgo(0),
      lastRunOutcome: "no_changes",
      lastRunReason:
        "valid plan computed but operationally identical to the already-published plan - no durable write, storedPlans untouched",
      lastValidatedPlanAt: minutesAgo(0), // just reconfirmed
      now,
    });
    assertEqual(
      result.status,
      "healthy",
      "a fresh no_changes validation must be healthy even with a very old lastPublishedAt",
    );
    assertEqual(result.alert, false, "a fresh validation-only no-op must not alert");
    assert(
      result.lastPublishedAgeMinutes !== null &&
        Math.abs(result.lastPublishedAgeMinutes - 400) < 0.01,
      "lastPublishedAgeMinutes must still accurately report how old the actual last write is, even while healthy",
    );
  }

  // 16. Symmetric failure case: lastValidatedPlanAt going stale must alert
  // even while lastPublishedAt happens to look "recent" in absolute terms
  // (e.g. a publish that happened, then a long run of readiness failures
  // with no further validation at all) - freshness is judged on
  // validation, not on how long ago SOME write once happened.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(200),
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "deferred",
      lastRunReason: "optimizer not ready: stale_tank_reading",
      lastValidatedPlanAt: minutesAgo(200),
      now,
    });
    assertEqual(
      result.status,
      "no_recent_valid_plan",
      "staleness must be judged on lastValidatedPlanAt, not on lastPublishedAt alone",
    );
    assertEqual(result.alert, true, "a stale validation must alert regardless of lastPublishedAt");
  }

  // --- PR #191 follow-up review (Codex): malformed (present but
  // unparsable) timestamps must never be confused with "missing" and must
  // never produce a garbage diagnostic like "last run attempt was
  // undefined min ago" - a non-null, non-date-parseable string is a
  // materially different (and never legitimate) condition from a
  // genuinely absent timestamp. ---
  const malformedTimestamp = "not-a-real-timestamp";

  // 17. Malformed lastRunAt alone (a fresh, valid lastValidatedPlanAt
  // proves the malformed lastRunAt alone is what forces the result).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: malformedTimestamp,
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(5),
      now,
    });
    assertEqual(
      result.status,
      "run_overdue",
      "a malformed lastRunAt must be treated as run_overdue, the same safe unhealthy bucket a missing one hits",
    );
    assertEqual(result.alert, true, "a malformed lastRunAt must alert");
    assertEqual(result.fallbackRecommended, true, "a malformed lastRunAt must recommend fallback");
    assert(
      result.alertReason?.startsWith("run_timestamp_invalid:"),
      `malformed lastRunAt must carry its own distinct alertReason category, got: ${result.alertReason}`,
    );
    assert(
      !result.alertReason?.includes("undefined"),
      `alertReason must never contain the literal text "undefined", got: ${result.alertReason}`,
    );
    assertEqual(
      result.lastRunAgeMinutes,
      null,
      "an unparsable lastRunAt must report lastRunAgeMinutes as null, not NaN or a garbage number",
    );
  }

  // 18. Malformed lastValidatedPlanAt alone (a fresh, valid lastRunAt with
  // a successful outcome proves the malformed validated-plan timestamp
  // alone is what forces the result, not run_overdue/run_failed).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: malformedTimestamp,
      now,
    });
    assertEqual(
      result.status,
      "no_recent_valid_plan",
      "a malformed lastValidatedPlanAt must be treated as no_recent_valid_plan, the same safe unhealthy " +
        "bucket a missing one hits",
    );
    assertEqual(result.alert, true, "a malformed lastValidatedPlanAt must alert");
    assertEqual(
      result.fallbackRecommended,
      true,
      "a malformed lastValidatedPlanAt must recommend fallback",
    );
    assert(
      result.alertReason?.startsWith("validated_plan_timestamp_invalid:"),
      `malformed lastValidatedPlanAt must carry its own distinct alertReason category, got: ${result.alertReason}`,
    );
    assert(
      !result.alertReason?.includes("undefined"),
      `alertReason must never contain the literal text "undefined", got: ${result.alertReason}`,
    );
    assertEqual(
      result.lastValidatedPlanAgeMinutes,
      null,
      "an unparsable lastValidatedPlanAt must report lastValidatedPlanAgeMinutes as null, not NaN or a garbage number",
    );
  }

  // 19. Both malformed at once -> run_overdue wins (same priority order a
  // merely-old/missing/future lastRunAt already takes over the
  // validated-plan checks).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: malformedTimestamp,
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: malformedTimestamp,
      now,
    });
    assertEqual(
      result.status,
      "run_overdue",
      "when both timestamps are malformed, run_overdue must win over no_recent_valid_plan",
    );
    assert(
      result.alertReason?.startsWith("run_timestamp_invalid:"),
      "both-malformed alertReason must be the run_timestamp_invalid category, not the validated-plan one",
    );
  }

  // 20. Malformed run timestamp + a genuinely VALID (fresh) plan
  // timestamp - run_overdue must still win (the cron cadence itself looks
  // broken/unverifiable, which is more severe than a fresh plan can
  // compensate for).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(2),
      lastRunAt: malformedTimestamp,
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(2),
      now,
    });
    assertEqual(
      result.status,
      "run_overdue",
      "a malformed lastRunAt must still force run_overdue even with an otherwise fresh, valid plan timestamp",
    );
    assert(
      result.alertReason?.startsWith("run_timestamp_invalid:"),
      `malformed lastRunAt must win with its own category even alongside a fresh valid plan timestamp, got: ${result.alertReason}`,
    );
  }

  // 21. A genuinely VALID (fresh) run timestamp + a malformed validated-
  // plan timestamp - no_recent_valid_plan must fire (run_overdue/
  // run_failed do not apply, so the malformed plan timestamp is what's
  // left to explain the alert).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(2),
      lastRunAt: minutesAgo(2),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: malformedTimestamp,
      now,
    });
    assertEqual(
      result.status,
      "no_recent_valid_plan",
      "a fresh, valid run timestamp must not mask a malformed validated-plan timestamp",
    );
    assert(
      result.alertReason?.startsWith("validated_plan_timestamp_invalid:"),
      `a fresh valid run timestamp must not mask a malformed validated-plan timestamp, got: ${result.alertReason}`,
    );
  }

  // 22. Malformed lastPublishedAt (diagnostic-only field) must be handled
  // safely too, even though it does not drive health status - it must
  // become null (like "missing"), never NaN or a value that corrupts an
  // otherwise-healthy result.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: malformedTimestamp,
      lastRunAt: minutesAgo(2),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(2),
      now,
    });
    assertEqual(
      result.status,
      "healthy",
      "a malformed lastPublishedAt must not itself break an otherwise healthy result - it is diagnostic only",
    );
    assertEqual(
      result.lastPublishedAgeMinutes,
      null,
      "a malformed lastPublishedAt must report lastPublishedAgeMinutes as null, not NaN",
    );
  }

  // 23. Normal null/missing timestamps still behave exactly as before
  // this fix (re-run of case 2's fixture, unchanged) - "missing" and
  // "invalid" must stay genuinely distinct outcomes of the same
  // run_overdue bucket, not accidentally merged back together.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: null,
      lastRunAt: null,
      lastRunOutcome: null,
      lastRunReason: null,
      lastValidatedPlanAt: null,
      now,
    });
    assertEqual(result.status, "run_overdue", "a missing lastRunAt must still be run_overdue");
    assert(
      result.alertReason?.startsWith("cron_missing:"),
      "a missing (not malformed) lastRunAt must still carry the cron_missing category, unchanged",
    );
  }

  // --- PR #191 final-cleanup review (Codex): an empty string ("") is a
  // non-null value that simply fails to parse as a date - assessTimestamp
  // previously used a truthiness check (!isoTimestamp), which treats ""
  // the same as null and misclassifies it as "missing" instead of
  // "invalid", risking the same "undefined min ago" style diagnostic this
  // whole malformed-timestamp fix exists to prevent. ---

  // 24. lastRunAt="" alone (a fresh, valid lastValidatedPlanAt proves the
  // empty-string lastRunAt alone is what forces the result).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: "",
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(5),
      now,
    });
    assertEqual(
      result.status,
      "run_overdue",
      'an empty-string lastRunAt ("") must be treated as run_overdue, the same safe unhealthy bucket a ' +
        "missing/malformed one hits",
    );
    assertEqual(result.alert, true, 'an empty-string lastRunAt ("") must alert');
    assert(
      result.alertReason?.startsWith("run_timestamp_invalid:"),
      `an empty-string lastRunAt must carry the run_timestamp_invalid category (not cron_missing), got: ${result.alertReason}`,
    );
    assert(
      !result.alertReason?.includes("undefined"),
      `alertReason must never contain the literal text "undefined", got: ${result.alertReason}`,
    );
    assertEqual(
      result.lastRunAgeMinutes,
      null,
      'an empty-string lastRunAt must report lastRunAgeMinutes as null, not NaN or a garbage number',
    );
  }

  // 25. lastValidatedPlanAt="" alone (a fresh, valid lastRunAt with a
  // successful outcome proves the empty-string validated-plan timestamp
  // alone is what forces the result).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: "",
      now,
    });
    assertEqual(
      result.status,
      "no_recent_valid_plan",
      'an empty-string lastValidatedPlanAt ("") must be treated as no_recent_valid_plan, the same safe ' +
        "unhealthy bucket a missing/malformed one hits",
    );
    assertEqual(result.alert, true, 'an empty-string lastValidatedPlanAt ("") must alert');
    assert(
      result.alertReason?.startsWith("validated_plan_timestamp_invalid:"),
      "an empty-string lastValidatedPlanAt must carry the validated_plan_timestamp_invalid category (not " +
        `no_recent_valid_plan's plain missing wording), got: ${result.alertReason}`,
    );
    assert(
      !result.alertReason?.includes("undefined"),
      `alertReason must never contain the literal text "undefined", got: ${result.alertReason}`,
    );
    assertEqual(
      result.lastValidatedPlanAgeMinutes,
      null,
      "an empty-string lastValidatedPlanAt must report lastValidatedPlanAgeMinutes as null, not NaN or a garbage number",
    );
  }

  // 26. Both empty strings at once -> run_overdue wins (same priority
  // order as both-malformed/both-future/both-missing).
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: "",
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: "",
      now,
    });
    assertEqual(
      result.status,
      "run_overdue",
      "when both timestamps are empty strings, run_overdue must win over no_recent_valid_plan",
    );
    assert(
      result.alertReason?.startsWith("run_timestamp_invalid:"),
      "both-empty-string alertReason must be the run_timestamp_invalid category, not the validated-plan one",
    );
  }

  // 27. null must still mean "missing" (cron_missing), genuinely distinct
  // from "" meaning "invalid" (run_timestamp_invalid) - re-confirms the
  // two are not accidentally merged back together by this fix either.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: null,
      lastRunOutcome: null,
      lastRunReason: null,
      lastValidatedPlanAt: minutesAgo(5),
      now,
    });
    assertEqual(result.status, "run_overdue", "a null lastRunAt must still be run_overdue");
    assert(
      result.alertReason?.startsWith("cron_missing:"),
      `a null lastRunAt must still carry the cron_missing category, not run_timestamp_invalid, got: ${result.alertReason}`,
    );
  }

  // 28. Normal valid past timestamps remain entirely unaffected by the
  // strict-null-check change.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastPublishedAt: minutesAgo(5),
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidatedPlanAt: minutesAgo(5),
      now,
    });
    assertEqual(
      result.status,
      "healthy",
      "ordinary past timestamps must still resolve to healthy after the empty-string fix",
    );
    assertEqual(result.alert, false, "ordinary past timestamps must not alert");
  }
}

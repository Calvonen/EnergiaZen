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
    maxValidPlanAgeMinutes: 150,
  };
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60 * 1000).toISOString();

  // 1. Everything fresh and successful -> healthy, no alert, no fallback.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidPlanAt: minutesAgo(5),
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
      lastRunAt: null,
      lastRunOutcome: null,
      lastRunReason: null,
      lastValidPlanAt: null,
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
      lastRunAt: minutesAgo(200),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidPlanAt: minutesAgo(200),
      now,
    });
    assertEqual(result.status, "run_overdue", "a run 200 min ago (> 90 min limit) must be run_overdue");
    assertEqual(result.alert, true, "an overdue run must alert");
    assertEqual(result.fallbackRecommended, true, "an overdue run must recommend fallback");
  }

  // 4. The most recent attempt itself failed (run_error) - must alert
  // IMMEDIATELY, even though the previous valid plan is still well within
  // maxValidPlanAgeMinutes. This is what lets EDGE_FUNCTION_FAILURE be
  // detected on the very run it happens, not only once the plan goes
  // stale.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastRunAt: minutesAgo(2),
      lastRunOutcome: "run_error",
      lastRunReason: "TypeError: fetch failed",
      lastValidPlanAt: minutesAgo(20),
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

  // 5. Same as above but publication_failed - also run_failed.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastRunAt: minutesAgo(2),
      lastRunOutcome: "publication_failed",
      lastRunReason: "insert failed: connection reset",
      lastValidPlanAt: minutesAgo(20),
      now,
    });
    assertEqual(result.status, "run_failed", "a publication_failed outcome must be run_failed");
    assertEqual(result.alert, true, "a publication failure must alert");
  }

  // 6. The most recent attempt was merely deferred (e.g. stale inputs),
  // not an outright failure, but no valid plan has been published
  // recently enough either -> no_recent_valid_plan, not run_failed.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "deferred",
      lastRunReason: "optimizer not ready: stale_tank_reading",
      lastValidPlanAt: minutesAgo(400),
      now,
    });
    assertEqual(
      result.status,
      "no_recent_valid_plan",
      "a merely-deferred recent attempt with a stale prior plan must be no_recent_valid_plan",
    );
    assertEqual(result.alert, true, "a stale valid plan must alert");
    assert(
      result.alertReason?.startsWith("no_recent_valid_plan:"),
      "stale-plan alert reason must name the condition",
    );
  }

  // 7. A merely-deferred recent attempt is NOT itself an alert as long as
  // the last published plan is still fresh enough - a single deferred run
  // (e.g. one stale tank reading) must not immediately page anyone while
  // the previously published plan is still within its trusted window.
  {
    const result = evaluateHeatingBackendHealth({
      config,
      lastRunAt: minutesAgo(5),
      lastRunOutcome: "deferred",
      lastRunReason: "optimizer not ready: stale_tank_reading",
      lastValidPlanAt: minutesAgo(30),
      now,
    });
    assertEqual(
      result.status,
      "healthy",
      "a single deferred run must stay healthy while the prior plan is still fresh",
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
      lastRunAt: minutesAgo(0),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidPlanAt: minutesAgo(0),
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
      lastRunAt: minutesAgo(500),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidPlanAt: minutesAgo(500),
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
      lastRunAt: minutesAgo(12),
      lastRunOutcome: "published",
      lastRunReason: "valid plan published",
      lastValidPlanAt: minutesAgo(12),
      now,
    });
    assert(
      result.lastRunAgeMinutes !== null && Math.abs(result.lastRunAgeMinutes - 12) < 0.01,
      "lastRunAgeMinutes must reflect the supplied timestamp's age",
    );
    assert(
      result.lastValidPlanAgeMinutes !== null &&
        Math.abs(result.lastValidPlanAgeMinutes - 12) < 0.01,
      "lastValidPlanAgeMinutes must reflect the supplied timestamp's age",
    );
  }
}

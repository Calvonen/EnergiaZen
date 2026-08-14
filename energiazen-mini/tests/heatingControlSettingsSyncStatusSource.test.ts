import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

// Codex P2 follow-up: isHeatingControlSettingsSynced used to be a plain
// boolean starting at false, so Home could not tell "the first
// completeness check hasn't resolved yet" apart from "it resolved and
// found the row unsynced" - both read as the same false, and the fail-safe
// legacy publisher treated a brand new mount as already-confirmed-unsynced,
// letting it publish an automatic plan from the app before the check had
// even run once. heatingControlSettingsSyncStatus replaces it with an
// explicit "pending" | "synced" | "unsynced" tri-state.
export function runHeatingControlSettingsSyncStatusSourceTests() {
  const contextSource = readFileSync(
    join(process.cwd(), "lib/settingsScenarioContext.tsx"),
    "utf8",
  );
  const homeSource = readFileSync(
    join(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );

  // Initial pending state -> the state must start on the explicit
  // "pending" literal, not a boolean default that reads the same as a
  // completed-unsynced result.
  assertSource(
    contextSource.includes(
      'export type HeatingControlSettingsSyncStatus = "pending" | "synced" | "unsynced";',
    ),
    "the tri-state type must be exactly pending | synced | unsynced",
  );
  assertSource(
    contextSource.includes(
      "useState<HeatingControlSettingsSyncStatus>(\"pending\")",
    ),
    "heatingControlSettingsSyncStatus must start as \"pending\", not a boolean false that is indistinguishable from a completed unsynced check",
  );

  // Initial pending state -> the automatic app publisher must be deferred:
  // shouldPublishHeatingPlanFromApp's backendPrimaryEnabled must be true
  // (i.e. app publication skipped) whenever the status is anything other
  // than the completed "unsynced" outcome - which includes "pending".
  const gateStart = homeSource.indexOf("!shouldPublishHeatingPlanFromApp({");
  const gateEnd = homeSource.indexOf("})", gateStart);
  assertSource(
    gateStart !== -1 && gateEnd > gateStart,
    "expected to find the shouldPublishHeatingPlanFromApp call gating automatic app publication",
  );
  const gateSource = homeSource.slice(gateStart, gateEnd);
  assertSource(
    gateSource.includes(
      'heatingControlSettingsSyncStatus !== "unsynced"',
    ),
    "app publication must only be enabled (backendPrimaryEnabled false) once the status is the completed \"unsynced\" outcome - both \"pending\" and \"synced\" must keep it deferred to the backend",
  );

  // Completed unsynced/error state -> the legacy automatic publisher must
  // remain available exactly as it did when the field was a plain boolean:
  // only the completed "unsynced" branch may flip backendPrimaryEnabled to
  // false, which is what allows shouldPublishHeatingPlanFromApp to return
  // true for automatic mode.
  assertSource(
    gateSource.includes("BACKEND_PRIMARY_HEATING_PLAN_ENABLED &&") &&
      gateSource.indexOf("BACKEND_PRIMARY_HEATING_PLAN_ENABLED &&") <
        gateSource.indexOf('heatingControlSettingsSyncStatus !== "unsynced"'),
    "the deploy-time flag and the completed-sync check must both still gate backendPrimaryEnabled together",
  );

  // Synced state -> the outcome resolver must map a successful check to
  // exactly "synced" (never staying "pending"), so the backend-primary
  // gate above sees heatingControlSettingsSyncStatus !== "unsynced" as
  // true and keeps deferring to the backend.
  assertSource(
    contextSource.includes(
      'setHeatingControlSettingsSyncStatus(synced ? "synced" : "unsynced");',
    ),
    "a completed check must resolve to exactly \"synced\" or \"unsynced\" - never remain \"pending\" once attemptSync has run",
  );

  // The retry loop for a failed/unsynced check must still exist, unchanged
  // in mechanism (same interval constant, same setTimeout-based retry) -
  // this fix only adds the pending distinction, it does not redesign sync.
  assertSource(
    contextSource.includes("if (!synced) {") &&
      contextSource.includes("retryTimeoutId = setTimeout(") &&
      contextSource.includes("heatingControlSettingsSyncRetryIntervalMs") &&
      contextSource.indexOf("if (!synced) {") <
        contextSource.indexOf("retryTimeoutId = setTimeout("),
    "a completed unsynced/failed check must still be retried on the existing interval - this fix must not remove or redesign the retry",
  );

  // Fixed-mode publication must remain unaffected: shouldPublishHeatingPlanFromApp
  // (supabase/functions/_shared/heatingPlanPublication.ts) already always
  // allows fixed mode regardless of backendPrimaryEnabled, and nothing in
  // this file introduces a new mode check ahead of that gate.
  assertSource(
    gateSource.includes("mode: settings.heatingNeedMode,"),
    "the gate must keep delegating the fixed-mode exemption to shouldPublishHeatingPlanFromApp itself, not reimplement it here",
  );
}

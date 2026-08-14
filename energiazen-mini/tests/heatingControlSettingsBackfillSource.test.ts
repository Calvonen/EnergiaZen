import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

const authoritativeFields = [
  "automatic_max_heating_hours",
  "full_tank_average_temperature",
  "full_tank_showers",
  "max_tank_temperature",
  "min_tank_temperature",
  "safety_shower_reserve",
  "target_shower_reserve",
];

export function runHeatingControlSettingsBackfillSourceTests() {
  const backendLogicSource = readFileSync(
    join(process.cwd(), "supabase/functions/run-heating-optimizer/logic.ts"),
    "utf8",
  );
  const backfillSource = readFileSync(
    join(process.cwd(), "lib/heatingControlSettingsBackfill.ts"),
    "utf8",
  );

  // Pins the app-side completeness check to the exact same field list
  // resolveOptimizerSettings uses to decide control_mode_missing/
  // settings_incomplete, so the two independent implementations can't
  // silently drift apart.
  for (const field of authoritativeFields) {
    assertSource(
      backendLogicSource.includes(`row.${field}`),
      `backend readiness check must still read ${field} (source contract baseline)`,
    );
    assertSource(
      backfillSource.includes(`row.${field}`) &&
        backfillSource.includes(`Number.isFinite(row.${field})`),
      `app-side completeness check must require row.${field} to be finite, matching the backend`,
    );
  }
  assertSource(
    backendLogicSource.includes("row.heating_need_mode === null") &&
      backendLogicSource.includes(
        'row.heating_need_mode !== "automatic" && row.heating_need_mode !== "fixed"',
      ),
    "backend readiness check must still gate on heating_need_mode presence/validity (source contract baseline)",
  );
  assertSource(
    backfillSource.includes('value === "automatic" || value === "fixed"') &&
      backfillSource.includes("isValidHeatingNeedMode(row.heating_need_mode)"),
    "app-side completeness check must require heating_need_mode to be a valid, present value",
  );
  assertSource(
    backendLogicSource.includes(
      'row.heating_gain_source !== "learned" && row.heating_gain_source !== "fixed"',
    ),
    "backend readiness check must still validate heating_gain_source (source contract baseline)",
  );
  assertSource(
    backfillSource.includes('value === "learned" || value === "fixed"') &&
      backfillSource.includes("isValidHeatingGainSource(row.heating_gain_source)"),
    "app-side completeness check must validate heating_gain_source the same way",
  );

  const payloadSource = readFileSync(
    join(process.cwd(), "lib/heatingControlSettingsPayload.ts"),
    "utf8",
  );
  assertSource(
    payloadSource.includes("heating_need_mode: settings.heatingNeedMode"),
    "the backfill write path must mirror the local heating_need_mode verbatim, never force automatic",
  );

  const contextSource = readFileSync(
    join(process.cwd(), "lib/settingsScenarioContext.tsx"),
    "utf8",
  );
  assertSource(
    contextSource.includes(
      "const [heatingControlSettingsSyncStatus, setHeatingControlSettingsSyncStatus] =\n    useState<HeatingControlSettingsSyncStatus>(\"pending\")",
    ),
    "heatingControlSettingsSyncStatus must default to the explicit \"pending\" state, distinct from a completed \"unsynced\" check, so Home can defer app publication until the first check resolves",
  );
  assertSource(
    contextSource.includes("ensureHeatingControlSettingsBackfilled({") &&
      contextSource.includes("buildHeatingControlSettingsPayload(settings)") &&
      contextSource.includes("localSettings: persistedSettingsRef.current"),
    "the context must run the backfill using the app's own current local settings via the existing payload builder",
  );
  // Codex P2 (startup backfill race): the write must be a compare-and-swap
  // gated on the exact row state observed by fetchRow(), never a blind
  // overwrite - see ensureHeatingControlSettingsBackfilled's own contract
  // (upsertIfUnchanged) enforced by lib/heatingControlSettingsBackfill.test.ts.
  const upsertIfUnchangedStart = contextSource.indexOf(
    "upsertIfUnchanged: async (settings, observedRow) => {",
  );
  const upsertIfUnchangedEnd = contextSource.indexOf(
    "\n        },\n      });",
    upsertIfUnchangedStart,
  );
  const upsertIfUnchangedSource =
    upsertIfUnchangedStart !== -1 && upsertIfUnchangedEnd !== -1
      ? contextSource.slice(upsertIfUnchangedStart, upsertIfUnchangedEnd)
      : "";
  assertSource(
    upsertIfUnchangedStart !== -1 && upsertIfUnchangedEnd !== -1,
    "the backfill write must be passed as upsertIfUnchanged, not an unconditional upsert",
  );
  assertSource(
    upsertIfUnchangedSource.includes("ignoreDuplicates: true") &&
      upsertIfUnchangedSource.includes('.is("updated_at", null)') &&
      upsertIfUnchangedSource.includes('.eq("updated_at", observedRow.updated_at)'),
    "the conditional write must use insert-only-if-absent for a missing row and an updated_at-gated update for an existing one",
  );
  assertSource(
    upsertIfUnchangedSource.includes('.select("id")') &&
      upsertIfUnchangedSource.includes("Array.isArray(data) && data.length > 0"),
    "the conditional write must report whether it actually matched/wrote a row, not assume success",
  );
  // Codex P2 (startup backfill follow-up): the write must merge the
  // observed row with the local payload, not write the local payload
  // verbatim - see mergeHeatingControlSettingsBackfillPayload's own
  // contract enforced by lib/heatingControlSettingsBackfill.test.ts.
  assertSource(
    upsertIfUnchangedSource.includes("buildHeatingControlSettingsPayload(settings)") &&
      upsertIfUnchangedSource.includes(
        "mergeHeatingControlSettingsBackfillPayload(",
      ),
    "the write must merge the local payload with the observed row, preserving already-authoritative remote fields",
  );
  assertSource(
    contextSource.includes("retryTimeoutId = setTimeout(") &&
      contextSource.includes("heatingControlSettingsSyncRetryIntervalMs"),
    "a failed sync attempt must be retried, not abandoned",
  );
  // Codex P2 follow-up: the tri-state status must only ever land on
  // "synced" or "unsynced" once a check has actually completed - never
  // back on "pending" - and the completed-unsynced branch must still
  // trigger the retry above exactly as the plain-boolean version did.
  assertSource(
    contextSource.includes(
      "const synced = isHeatingControlSettingsSyncOutcomeSynced(outcome);",
    ) &&
      contextSource.includes(
        'setHeatingControlSettingsSyncStatus(synced ? "synced" : "unsynced");',
      ),
    "a completed check must resolve heatingControlSettingsSyncStatus to exactly \"synced\" or \"unsynced\", never leave it on \"pending\"",
  );
  const valueMemoStart = contextSource.indexOf("const value = useMemo(");
  const valueMemoSource = contextSource.slice(valueMemoStart);
  assertSource(
    valueMemoStart !== -1 &&
      valueMemoSource.includes("...scenarioState,") &&
      valueMemoSource.includes("heatingControlSettingsSyncStatus,") &&
      valueMemoSource.indexOf("...scenarioState,") <
        valueMemoSource.indexOf("heatingControlSettingsSyncStatus,"),
    "heatingControlSettingsSyncStatus must be exposed on the context value",
  );

  const homeSource = readFileSync(
    join(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );
  assertSource(
    homeSource.includes("heatingControlSettingsSyncStatus,") &&
      homeSource.includes("} = useSettingsScenario();"),
    "the Home screen must read heatingControlSettingsSyncStatus from the shared settings context",
  );
  // Codex P2 follow-up: "pending" must gate exactly like "synced" here
  // (app publication deferred) - only a completed "unsynced" check may
  // fall back to the legacy publisher. Fixed-mode publication is
  // unaffected either way (shouldPublishHeatingPlanFromApp always allows
  // it regardless of backendPrimaryEnabled).
  assertSource(
    homeSource.includes(
      'backendPrimaryEnabled:\n          BACKEND_PRIMARY_HEATING_PLAN_ENABLED &&\n          heatingControlSettingsSyncStatus !== "unsynced",',
    ),
    "the legacy publisher gate must require both the deploy-time flag AND a completed, confirmed Supabase settings sync - pending or unsynced must not enable it",
  );
}

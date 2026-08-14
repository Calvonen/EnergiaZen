import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

// Codex P2: gain history is only actually consumed in "learned" mode
// (runBackendHeatingOptimization derives the learned per-hour gain from
// it) - "fixed" mode uses the explicit configured heatingGainPerHour and
// never reads it at all. A failed gain-history fetch must therefore not
// block publication in fixed mode; it must still block it in learned mode,
// where the history is actually required.
//
// Codex P2 follow-up: the local 7-day recovery history is likewise only
// actually consumed when resolveHourlyDropProfile ends up selecting it
// (dropProfile.source === "local-7-day") - when a fresh stored Supabase
// profile was selected instead, a recovery-history fetch failure must not
// by itself block publication. dropProfileResult - the fetch of the stored
// profile itself - stays unconditionally required regardless of source.
export function runHeatingOptimizerFixedGainReadinessSourceTests() {
  const edgeSource = readFileSync(
    join(
      process.cwd(),
      "supabase/functions/run-heating-optimizer/index.ts",
    ),
    "utf8",
  );

  const dropProfileStart = edgeSource.indexOf(
    "const dropProfile = resolveHourlyDropProfile({",
  );
  const readinessStart = edgeSource.indexOf(
    "const inputFetchReadiness = resolveOptimizerInputFetchReadiness(",
  );
  const readinessEnd = edgeSource.indexOf(");", readinessStart);
  assertSource(
    dropProfileStart !== -1 &&
      readinessStart !== -1 &&
      readinessEnd > readinessStart,
    "expected to find both the dropProfile resolution and the inputFetchReadiness assignment",
  );
  assertSource(
    dropProfileStart < readinessStart,
    "dropProfile must be resolved before the readiness check, so the check can see which profile source was actually selected",
  );
  const readinessSource = edgeSource.slice(readinessStart, readinessEnd);

  // Profile selection itself must be unchanged: same inputs, same helper.
  const dropProfileBlockEnd = edgeSource.indexOf("});", dropProfileStart);
  const dropProfileBlockSource = edgeSource.slice(
    dropProfileStart,
    dropProfileBlockEnd,
  );
  assertSource(
    dropProfileBlockSource.includes("localReadings: recoveryReadings,") &&
      dropProfileBlockSource.includes("now: attemptNow,") &&
      dropProfileBlockSource.includes(
        "storedProfile: dropProfileResult.value,",
      ),
    "resolveHourlyDropProfile must still be called with exactly the same inputs - this change only moved it earlier, it did not touch selection",
  );

  // Fixed mode + gain-history fetch failure -> publication may still
  // proceed: gainHistoryFetch must only be included in the readiness gate
  // when the authoritative heating_gain_source is "learned".
  assertSource(
    readinessSource.includes(
      '...(heatingGainSource === "learned" ? [gainHistoryFetch] : []),',
    ),
    "the gain-history fetch must only feed publication readiness when heating_gain_source is authoritatively learned",
  );

  // Stored/fresh Supabase drop profile selected + recovery-history fetch
  // failure -> publication may still proceed (recoveryReadingsFetch is only
  // included when dropProfile.source === "local-7-day"); local-7-day
  // profile selected + recovery-history fetch failure -> publication
  // remains blocked (recoveryReadingsFetch is included in that case).
  assertSource(
    readinessSource.includes(
      '...(dropProfile.source === "local-7-day" ? [recoveryReadingsFetch] : []),',
    ),
    "the recovery-history fetch must only feed publication readiness when the local 7-day profile was actually the one selected",
  );

  // dropProfileResult (fetching the stored profile itself) must remain
  // unconditionally required - not weakened by this change. A failure
  // there already forces selection down to local-7-day, which in turn
  // requires recoveryReadingsFetch via the check above.
  assertSource(
    readinessSource.includes("\n      dropProfileResult,\n") &&
      !readinessSource.includes("dropProfileResult ?") &&
      !readinessSource.includes("...(dropProfileResult"),
    "dropProfileResult must stay unconditionally included in the readiness array, never gated behind a ternary/spread",
  );

  // Other input-read failure checks must not be weakened: recovery
  // readings and the temperature drop profile must still be referenced.
  assertSource(
    readinessSource.includes("recoveryReadingsFetch") &&
      readinessSource.includes("dropProfileResult"),
    "recoveryReadingsFetch and dropProfileResult must still be able to feed readiness",
  );

  // Fixed mode must still use the explicit configured gain - the
  // calculation path itself (createHeatingOptimizationSettings,
  // fallbackHeatingGainPerHour, and the heatingGainSource/heatingGainHistory
  // handed to runBackendHeatingOptimization) must be untouched by this
  // readiness-only change.
  assertSource(
    edgeSource.includes(
      "const optimizationSettings = createHeatingOptimizationSettings(\n      optimizerSettingsSource,\n      fallbackHeatingGainPerHour,\n    );",
    ),
    "fixed-mode gain calculation (createHeatingOptimizationSettings with fallbackHeatingGainPerHour) must be unchanged",
  );
  assertSource(
    edgeSource.includes("heatingGainHistory: gainHistory,") &&
      edgeSource.includes("heatingGainSource,\n      hours,") &&
      edgeSource.includes("hourlyDrops: dropProfile.hourlyDrops,"),
    "runBackendHeatingOptimization must still receive the same gain history/source/drop-profile inputs it always did - only the readiness gate changed, not what is computed",
  );
}

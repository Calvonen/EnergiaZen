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
export function runHeatingOptimizerFixedGainReadinessSourceTests() {
  const edgeSource = readFileSync(
    join(
      process.cwd(),
      "supabase/functions/run-heating-optimizer/index.ts",
    ),
    "utf8",
  );

  const readinessStart = edgeSource.indexOf(
    "const inputFetchReadiness = resolveOptimizerInputFetchReadiness(",
  );
  const readinessEnd = edgeSource.indexOf(");", readinessStart);
  assertSource(
    readinessStart !== -1 && readinessEnd > readinessStart,
    "expected to find the inputFetchReadiness assignment",
  );
  const readinessSource = edgeSource.slice(readinessStart, readinessEnd);

  // Fixed mode + gain-history fetch failure -> publication may still
  // proceed: gainHistoryFetch must only be included in the readiness gate
  // when the authoritative heating_gain_source is "learned".
  assertSource(
    readinessSource.includes('heatingGainSource === "learned"'),
    "the gain-history fetch must only feed publication readiness when heating_gain_source is authoritatively learned",
  );
  assertSource(
    readinessSource.includes(
      "? [gainHistoryFetch, recoveryReadingsFetch, dropProfileResult]",
    ) &&
      readinessSource.includes(
        ": [recoveryReadingsFetch, dropProfileResult]",
      ),
    "learned mode must still gate readiness on gainHistoryFetch, and fixed mode must gate on the other inputs only - not on gain history",
  );

  // The learned branch must come first (the "if learned" case), confirming
  // learned-mode readiness still requires gainHistoryFetch exactly as
  // before - so learned mode + gain-history fetch failure remains blocked.
  assertSource(
    readinessSource.indexOf('heatingGainSource === "learned"') <
      readinessSource.indexOf("[gainHistoryFetch, recoveryReadingsFetch"),
    "the learned-mode branch must be the one requiring gainHistoryFetch",
  );

  // Other input-read failure checks must not be weakened: recovery
  // readings and the temperature drop profile must still be required in
  // both modes.
  assertSource(
    readinessSource.includes("recoveryReadingsFetch") &&
      readinessSource.includes("dropProfileResult"),
    "recoveryReadingsFetch and dropProfileResult must still feed readiness in every mode",
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
      edgeSource.includes("heatingGainSource,\n      hours,"),
    "runBackendHeatingOptimization must still receive the same gain history/source inputs it always did - only the readiness gate changed, not what is computed",
  );
}

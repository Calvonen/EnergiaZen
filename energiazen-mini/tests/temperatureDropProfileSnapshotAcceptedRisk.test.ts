import { readFileSync } from "node:fs";
import { join } from "node:path";

// Codex P2 (PR #193): temperature_drop_profiles' latest row is not part of
// publish_backend_heating_optimizer_plans' transactional snapshot recheck,
// unlike settings/plan/tank/price/relay. This was assessed and explicitly
// left unchanged (see README.md's "Tunnettu, hyväksytty jäännösriski"
// section for the full reasoning) rather than adding a sixth nested layer
// to the publish RPC's already deeply-accreted snapshot-check chain for a
// race that is narrow (re-fetched every retry attempt, so the window is
// one attempt's compute time, not the 5-minute cron interval), extremely
// low-probability (a once-weekly write against ~2016 runs/week), and
// non-safety-affecting (optimizeHeatingPlan's own absolute safety checks
// are independent of which week's drop profile was used) and
// self-correcting (next run, at most 5 minutes later, reads the fresh
// profile).
//
// This test pins the facts that decision depends on, so it fails loudly -
// forcing a conscious re-assessment - if any of them silently change in a
// way that would invalidate the reasoning (e.g. the profile no longer
// being re-fetched per attempt, or the recalculation cron running far more
// often).

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runTemperatureDropProfileSnapshotAcceptedRiskTests() {
  const edgeSource = readFileSync(
    join(process.cwd(), "supabase/functions/run-heating-optimizer/index.ts"),
    "utf8",
  );

  const retryLoopStart = edgeSource.indexOf(
    "optimizerAttempt <= maxTankSnapshotPublicationRetries",
  );
  const retryLoopEnd = edgeSource.indexOf(
    'throw new Error("Optimizer retry loop exited without a final outcome")',
  );
  assertSource(
    retryLoopStart !== -1 && retryLoopEnd > retryLoopStart,
    "expected to find run-heating-optimizer's per-attempt retry loop",
  );
  const retryLoopSource = edgeSource.slice(retryLoopStart, retryLoopEnd);
  assertSource(
    retryLoopSource.includes("fetchLatestTemperatureDropProfile(supabase)"),
    "the temperature drop profile must still be re-fetched on every retry attempt, not once per run - this is what bounds the race window to a single attempt's compute time rather than the full cron interval",
  );

  const publishRpcSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813110000_reject_new_optimizer_price_intervals.sql",
    ),
    "utf8",
  );
  assertSource(
    !publishRpcSource.includes("temperature_drop_profile") &&
      !publishRpcSource.includes("p_expected_drop_profile"),
    "the publish RPC must still not include a temperature-drop-profile snapshot parameter - if this changes, the accepted-risk note in README.md is stale and should be removed/updated alongside it",
  );

  const recalculationMigration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260722010000_recalculate_temperature_drop_profiles.sql",
    ),
    "utf8",
  );
  assertSource(
    recalculationMigration.includes(
      "'recalculate-temperature-drop-profile-weekly',\n      '30 1 * * 0',",
    ),
    "the recalculation job must still run only once a week - a materially more frequent schedule would invalidate the low-probability part of this accepted-risk reasoning",
  );

  const readmeSource = readFileSync(join(process.cwd(), "README.md"), "utf8");
  assertSource(
    readmeSource.includes("Tunnettu, hyväksytty jäännösriski: temperature drop -profiilin snapshot"),
    "the accepted-risk decision must stay documented in README.md",
  );
}

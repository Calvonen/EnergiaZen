import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runHeatingPlanFixedModeGuardSourceTests() {
  const homeSource = readFileSync(
    join(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );

  assertSource(
    homeSource.includes(
      'import {\n  canPublishFixedHeatingPlanFromApp,\n  resolveRemoteHeatingNeedModeForFixedPublish,\n} from "@/lib/heatingPlanFixedModeGuard";',
    ),
    "the Home screen must import the fixed-mode remote-verification guard",
  );

  const chainStart = homeSource.indexOf(
    "heatingPlanSaveChainRef.current = heatingPlanSaveChainRef.current",
  );
  const chainEnd = homeSource.indexOf(
    "\n  const selectedHeatingHoursCount",
    chainStart,
  );
  assertSource(
    chainStart !== -1 && chainEnd > chainStart,
    "expected to find the queued save chain callback",
  );
  const chainSource = homeSource.slice(chainStart, chainEnd);

  const noChangeReturnIndex = chainSource.indexOf(
    'debugLog("Heating plan upsert skipped"',
  );
  const guardCallIndex = chainSource.indexOf(
    'if (settings.heatingNeedMode === "fixed") {',
  );
  const upsertCallIndex = chainSource.indexOf(
    '.from("heating_plans")\n            .upsert(changedPlans',
  );

  assertSource(
    noChangeReturnIndex !== -1 &&
      guardCallIndex !== -1 &&
      upsertCallIndex !== -1 &&
      noChangeReturnIndex < guardCallIndex &&
      guardCallIndex < upsertCallIndex,
    "the remote-mode guard must run inside the queued save callback, after the no-op short-circuit and immediately before the heating_plans write - this is what makes it apply to the write as actually executed (queue time), not as originally computed",
  );

  const guardBlock = chainSource.slice(guardCallIndex, upsertCallIndex);
  assertSource(
    guardBlock.includes("resolveRemoteHeatingNeedModeForFixedPublish({") &&
      guardBlock.includes('.from("heating_control_settings")') &&
      guardBlock.includes('.select("heating_need_mode")') &&
      guardBlock.includes('.eq("id", 1)'),
    "the guard must read the authoritative heating_need_mode from heating_control_settings",
  );
  assertSource(
    guardBlock.includes("if (!canPublishFixedHeatingPlanFromApp(remoteModeOutcome)) {") &&
      guardBlock.indexOf("if (!canPublishFixedHeatingPlanFromApp(remoteModeOutcome)) {") <
        guardBlock.indexOf("return;", guardBlock.indexOf("if (!canPublishFixedHeatingPlanFromApp(remoteModeOutcome)) {")),
    "an outcome other than a confirmed fixed mode must return before reaching the write - fail closed",
  );
  assertSource(
    guardBlock.includes("if (saveVersion !== latestHeatingPlanSaveVersionRef.current) {"),
    "the guard must re-check saveVersion after its own await, matching the existing cancellation pattern used elsewhere in this chain",
  );

  // The guard is scoped to the fixed-mode write path only - it must not
  // touch or replace the separate automatic-mode backend-primary gate
  // (BACKEND_PRIMARY_HEATING_PLAN_ENABLED && isHeatingControlSettingsSynced),
  // which stays exactly as the prior PR #193 fix left it.
  assertSource(
    homeSource.includes(
      "backendPrimaryEnabled:\n          BACKEND_PRIMARY_HEATING_PLAN_ENABLED && isHeatingControlSettingsSynced,",
    ),
    "the existing automatic-mode backend-primary gate must remain unchanged",
  );

  // Preserve the simplified cron-only architecture: this fix must not
  // reintroduce live triggers, debounce, or a drain job.
  const forbiddenLiveTriggerIdentifiers = [
    "backend_heating_optimizer_trigger_debounce",
    "backend_heating_optimizer_tank_trigger_baseline",
    "drain_pending_backend_heating_optimizer_dispatch",
  ];
  for (const identifier of forbiddenLiveTriggerIdentifiers) {
    assertSource(
      !homeSource.includes(identifier),
      `this fix must not reference removed live-trigger identifier "${identifier}"`,
    );
  }
}

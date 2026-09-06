import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runBackendHeatingPlanPublicationMigrationTests() {
  const migrationSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813020000_publish_backend_heating_optimizer_plans.sql",
    ),
    "utf8",
  );
  const settingsMigrationSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813030000_add_backend_primary_optimizer_settings.sql",
    ),
    "utf8",
  );
  const snapshotRecheckMigrationSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813050000_recheck_full_backend_publication_snapshot.sql",
    ),
    "utf8",
  );
  const safeCompletionMigrationSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813060000_secure_no_changes_completion.sql",
    ),
    "utf8",
  );
  const edgeFunctionSource = readFileSync(
    join(process.cwd(), "supabase/functions/run-heating-optimizer/index.ts"),
    "utf8",
  );

  assertSource(
    migrationSource.includes("publish_backend_heating_optimizer_plans"),
    "migration must create the backend publication RPC",
  );
  assertSource(
    migrationSource.includes("for update") &&
      migrationSource.includes("current_run_id = p_run_id") &&
      migrationSource.includes("current_run_started_at = p_run_started_at"),
    "publication RPC must lock and CAS-check the current heartbeat owner before writing",
  );
  assertSource(
    migrationSource.includes("insert into public.heating_plans") &&
      migrationSource.includes("on conflict (plan_date) do update"),
    "publication RPC must upsert changed heating_plans rows by plan_date",
  );
  assertSource(
    migrationSource.includes("written_plan_count <> changed_plan_count") &&
      migrationSource.includes("raise exception"),
    "publication RPC must fail closed if not every changed row was written",
  );
  assertSource(
    migrationSource.includes("last_published_at = p_published_at") &&
      migrationSource.includes("last_validated_plan_at = p_published_at") &&
      migrationSource.includes("validated_plan_fingerprint = p_validated_plan_fingerprint"),
    "successful publication must advance publication and today's validated identity together",
  );
  assertSource(
    migrationSource.includes("'published'") &&
      migrationSource.includes("'publication_failed'"),
    "heartbeat outcome constraint must allow published and publication_failed",
  );
  assertSource(
    migrationSource.includes("grant insert, update on table public.heating_plans to service_role;"),
    "service_role must have the table privileges needed to publish heating plans",
  );
  assertSource(
    settingsMigrationSource.includes("heating_need_mode") &&
      settingsMigrationSource.includes("automatic_max_heating_hours") &&
      settingsMigrationSource.includes("safety_shower_reserve") &&
      settingsMigrationSource.includes("heating_gain_source"),
    "settings migration must add backend-primary optimizer/control-mode columns",
  );
  assertSource(
    snapshotRecheckMigrationSource.includes("returns text") &&
      snapshotRecheckMigrationSource.includes("p_expected_settings jsonb") &&
      snapshotRecheckMigrationSource.includes("p_expected_plan_versions jsonb"),
    "snapshot recheck migration must replace publication RPC with conflict-status return and full expected snapshots",
  );
  assertSource(
    snapshotRecheckMigrationSource.includes("lock table public.heating_plans in share row exclusive mode") &&
      snapshotRecheckMigrationSource.includes("from public.heating_control_settings") &&
      snapshotRecheckMigrationSource.includes("for update") &&
      snapshotRecheckMigrationSource.includes("current_settings.heating_need_mode <> 'automatic'"),
    "publication RPC must lock and recheck automatic control mode inside the transaction before plan writes",
  );
  for (const settingColumn of [
    "automatic_max_heating_hours",
    "safety_shower_reserve",
    "target_shower_reserve",
    "full_tank_showers",
    "full_tank_average_temperature",
    "min_tank_temperature",
    "max_tank_temperature",
    "heating_gain_source",
    "updated_at",
  ]) {
    assertSource(
      snapshotRecheckMigrationSource.includes(`current_settings.${settingColumn} is distinct from expected.${settingColumn}`),
      `publication RPC must recheck settings snapshot column ${settingColumn}`,
    );
  }
  assertSource(
    snapshotRecheckMigrationSource.includes("missing_validated_today") &&
      snapshotRecheckMigrationSource.includes("plan_date = p_validated_plan_date"),
    "publication RPC must require the validated today plan in the expected plan-version snapshot",
  );
  assertSource(
    snapshotRecheckMigrationSource.includes("current_plan.updated_at is distinct from expected.expected_updated_at") &&
      snapshotRecheckMigrationSource.includes("not expected.existed") &&
      snapshotRecheckMigrationSource.includes("current_plan.plan_date is not null") &&
      snapshotRecheckMigrationSource.includes("return 'plan_conflict'"),
    "publication RPC must reject changed rows and rows created after an absent-row snapshot",
  );
  assertSource(
    snapshotRecheckMigrationSource.includes("return 'settings_conflict'") &&
      snapshotRecheckMigrationSource.includes("return 'heartbeat_superseded'") &&
      snapshotRecheckMigrationSource.includes("return 'published'"),
    "publication RPC must expose controlled status values for success, superseded and stale snapshots",
  );
  assertSource(
    /drop function if exists public\.publish_backend_heating_optimizer_plans\(\s*uuid,\s*timestamptz,\s*jsonb,\s*timestamptz,\s*text,\s*date,\s*integer\[\],\s*text\s*\)/s.test(
      safeCompletionMigrationSource,
    ),
    "latest migration must drop the obsolete unsafe 8-argument publication overload",
  );
  assertSource(
    /drop function if exists public\.publish_backend_heating_optimizer_plans\(\s*uuid,\s*timestamptz,\s*jsonb,\s*text,\s*jsonb,\s*timestamptz,\s*text,\s*date,\s*integer\[\],\s*text\s*\)/s.test(
      safeCompletionMigrationSource,
    ),
    "latest migration must drop the obsolete control-mode-only 10-argument overload",
  );
  assertSource(
    /create or replace function public\.publish_backend_heating_optimizer_plans\(\s*p_run_id uuid,\s*p_run_started_at timestamptz,\s*p_changed_plans jsonb,\s*p_expected_settings jsonb,\s*p_expected_plan_versions jsonb,/s.test(
      safeCompletionMigrationSource,
    ) &&
      !/drop function if exists public\.publish_backend_heating_optimizer_plans\(\s*uuid,\s*timestamptz,\s*jsonb,\s*jsonb,\s*jsonb,/s.test(
        safeCompletionMigrationSource,
      ),
    "migration chain must retain only the current full-snapshot publication signature",
  );
  assertSource(
    safeCompletionMigrationSource.includes("if changed_plan_count > 0 then") &&
      safeCompletionMigrationSource.includes("else 'no_changes' end") &&
      safeCompletionMigrationSource.includes("return 'no_changes'") &&
      safeCompletionMigrationSource.includes("else last_published_at"),
    "empty changedPlans must validate as no_changes without advancing last_published_at",
  );
  assertSource(
    safeCompletionMigrationSource.includes("lock table public.heating_plans in share row exclusive mode") &&
      safeCompletionMigrationSource.includes("current_settings.heating_gain_source is distinct from expected.heating_gain_source") &&
      safeCompletionMigrationSource.includes("current_settings.updated_at is distinct from expected.updated_at") &&
      safeCompletionMigrationSource.includes("current_plan.updated_at is distinct from expected.expected_updated_at") &&
      safeCompletionMigrationSource.includes("to_jsonb(current_plan.planned_hours) is distinct from expected.expected_planned_hours") &&
      safeCompletionMigrationSource.includes("not expected.existed") &&
      safeCompletionMigrationSource.includes("current_plan.plan_date is not null"),
    "no_changes and publication must share settings, updated-row and absent-row snapshot checks",
  );
  const settingsConflictReturn = safeCompletionMigrationSource.indexOf(
    "return 'settings_conflict';",
    safeCompletionMigrationSource.indexOf("settings_mismatch_count > 0"),
  );
  const planConflictReturn = safeCompletionMigrationSource.indexOf(
    "return 'plan_conflict';",
  );
  const healthyUpdate = safeCompletionMigrationSource.indexOf(
    "update public.backend_heating_optimizer_state",
  );
  assertSource(
    settingsConflictReturn !== -1 &&
      planConflictReturn !== -1 &&
      healthyUpdate > settingsConflictReturn &&
      healthyUpdate > planConflictReturn,
    "settings/plan conflicts must return before healthy validation timestamps or fingerprint can advance",
  );
  assertSource(
    safeCompletionMigrationSource.includes(
      "grant execute on function public.publish_backend_heating_optimizer_plans(\n  uuid,\n  timestamptz,\n  jsonb,\n  jsonb,\n  jsonb,",
    ) &&
      !safeCompletionMigrationSource.includes(
        "grant execute on function public.publish_backend_heating_optimizer_plans(\n  uuid,\n  timestamptz,\n  jsonb,\n  timestamptz,",
      ),
    "service_role execute must be granted only for the current safe signature",
  );

  assertSource(
    edgeFunctionSource.includes("publicationReadiness") &&
      edgeFunctionSource.includes("publicationReadiness.ok"),
    "edge function must consult backend publication readiness",
  );
  assertSource(
    edgeFunctionSource.includes("successfulOptimizerInputFetch") &&
      edgeFunctionSource.includes("failedOptimizerInputFetch") &&
      edgeFunctionSource.includes("heating_gain_history_fetch_failed") &&
      edgeFunctionSource.includes("recovery_history_fetch_failed") &&
      edgeFunctionSource.includes("drop_profile_fetch_failed"),
    "optimizer input fetches must preserve success/failure separately from fallback values",
  );
  assertSource(
    edgeFunctionSource.includes("resolveOptimizerInputFetchReadiness") &&
      edgeFunctionSource.includes("combineBackendPublicationReadiness") &&
      edgeFunctionSource.includes("settingsPublicationReadiness") &&
      edgeFunctionSource.includes("inputFetchReadiness"),
    "all required optimizer input fetches must feed one central publication readiness gate",
  );
  assertSource(
    edgeFunctionSource.includes("typeof heating === \"boolean\"") &&
      edgeFunctionSource.includes("isValidReadyDecision") &&
      edgeFunctionSource.includes("publicationReadiness.ok"),
    "edge function must require known relay status, valid ready optimizer result, automatic mode and complete settings before publishing",
  );
  assertSource(
    edgeFunctionSource.includes("(hasChangedPlans && canPublishPlan) || canValidateNoChanges") &&
      edgeFunctionSource.includes("wroteToHeatingPlans = hasChangedPlans") &&
      edgeFunctionSource.includes(
        "publishedPlanCount = hasChangedPlans ? decision.changedPlans.length : 0",
      ),
    "safe RPC completion must write plans only for a changed, publishable ready result",
  );
  assertSource(
    edgeFunctionSource.includes("p_changed_plans: decision.changedPlans"),
    "edge function must pass only duplicate-suppressed changedPlans to the publication RPC",
  );
  assertSource(
    edgeFunctionSource.includes("buildExpectedHeatingPlanVersions") &&
      edgeFunctionSource.includes("buildExpectedOptimizerSettingsSnapshot") &&
      edgeFunctionSource.includes("p_expected_plan_versions: expectedPlanVersions") &&
      edgeFunctionSource.includes("p_expected_settings: expectedSettings") &&
      edgeFunctionSource.includes("todayPlanDate"),
    "edge function must pass full settings snapshot and plan updated_at snapshots including validated today to the publication RPC",
  );
  assertSource(
    edgeFunctionSource.includes("publishCommitted === \"settings_conflict\"") &&
      edgeFunctionSource.includes("publishCommitted === \"plan_conflict\"") &&
      edgeFunctionSource.includes("publication_conflict: publishCommitted"),
    "edge function must treat stale settings/plan snapshots as explicit fail-safe conflicts",
  );
  assertSource(
    edgeFunctionSource.includes("shouldUseSafeSnapshotCompletion") &&
      edgeFunctionSource.includes("(hasChangedPlans && canPublishPlan) || canValidateNoChanges") &&
      edgeFunctionSource.includes("successfulOutcome = hasChangedPlans ? \"published\" : \"no_changes\"") &&
      edgeFunctionSource.includes("p_changed_plans: decision.changedPlans"),
    "no_changes must use the same snapshot-protected RPC as changed-plan publication",
  );
  assertSource(
    edgeFunctionSource.includes("optimizer_input_fetch_failures: inputFetchReadiness.failedReasons") &&
      edgeFunctionSource.includes("const invalidOutcome = !publicationReadiness.ok") &&
      edgeFunctionSource.includes("!publicationReadiness.ok") &&
      edgeFunctionSource.includes("p_health_status: \"unhealthy\"") &&
      edgeFunctionSource.includes("p_validated_plan_at: null") &&
      edgeFunctionSource.includes("p_validated_plan_fingerprint: null") &&
      edgeFunctionSource.includes("p_validated_planned_hours: null"),
    "all publication-readiness failures must defer while changed/no_changes completion stays unhealthy and non-validating",
  );
  assertSource(
    edgeFunctionSource.includes("p_last_outcome: \"publication_failed\"") &&
      edgeFunctionSource.includes("Failed to publish heating plans"),
    "publication DB failure must complete heartbeat as unhealthy publication_failed",
  );
  assertSource(
    edgeFunctionSource.includes("p_last_outcome: outcome") &&
      edgeFunctionSource.includes("p_health_status: \"unhealthy\"") &&
      edgeFunctionSource.includes("p_validated_plan_at: null") &&
      edgeFunctionSource.indexOf("p_last_outcome: outcome") >
        edgeFunctionSource.indexOf("} else {", edgeFunctionSource.indexOf("shouldUseSafeSnapshotCompletion")),
    "unsafe direct heartbeat completion must remain limited to non-validating outcomes",
  );
}

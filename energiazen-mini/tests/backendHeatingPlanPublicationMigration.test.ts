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
    edgeFunctionSource.includes("publicationReadiness") &&
      edgeFunctionSource.includes("publicationReadiness.ok"),
    "edge function must consult backend publication readiness",
  );
  assertSource(
    edgeFunctionSource.includes("typeof heating === \"boolean\"") &&
      edgeFunctionSource.includes("isValidReadyDecision") &&
      edgeFunctionSource.includes("publicationReadiness.ok"),
    "edge function must require known relay status, valid ready optimizer result, automatic mode and complete settings before publishing",
  );
  assertSource(
    edgeFunctionSource.includes("if (hasChangedPlans && canPublishPlan && decision.status === \"ready\")"),
    "edge function must publish only changed ready plans",
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
    edgeFunctionSource.includes("p_validated_plan_at: canValidateNoChanges ? now.toISOString() : null") &&
      edgeFunctionSource.includes(") && publicationReadiness.ok"),
    "no_changes must not validate/mark healthy unless settings and control mode are publication-ready",
  );
  assertSource(
    edgeFunctionSource.includes("p_last_outcome: \"publication_failed\"") &&
      edgeFunctionSource.includes("Failed to publish heating plans"),
    "publication DB failure must complete heartbeat as unhealthy publication_failed",
  );
  assertSource(
    edgeFunctionSource.includes("p_last_outcome: outcome") &&
      edgeFunctionSource.includes("p_validated_plan_at: canValidateNoChanges ? now.toISOString() : null"),
    "no_changes must keep using validation-only heartbeat completion without touching last_published_at",
  );
}

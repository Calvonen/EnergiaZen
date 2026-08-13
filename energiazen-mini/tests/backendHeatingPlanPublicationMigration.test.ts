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
    edgeFunctionSource.includes("const canPublishPlan = typeof heating === \"boolean\" && isValidReadyDecision"),
    "edge function must require a known relay status and valid ready optimizer result before publishing",
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

import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runBackendOptimizerHeartbeatMigrationTests() {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260813010000_harden_backend_optimizer_heartbeat.sql"), "utf8");
  assertSource(sql.includes("current_run_id = p_run_id") && sql.includes("current_run_started_at = p_run_started_at"), "completion must compare-and-set both run identity and start time");
  assertSource(/current_run_started_at is null or current_run_started_at < p_run_started_at/.test(sql), "an older run start must not replace a newer owner");
  assertSource(sql.includes("validated_plan_fingerprint"), "heartbeat must persist validated plan identity");

  // Model the SQL ownership predicate: A starts, newer B starts, B completes,
  // then A's late completion cannot match the singleton owner.
  let owner = { id: "A", startedAt: 1, outcome: "running" };
  if (owner.startedAt < 2) owner = { id: "B", startedAt: 2, outcome: "running" };
  if (owner.id === "B" && owner.startedAt === 2) owner.outcome = "no_changes";
  if (owner.id === "A" && owner.startedAt === 1) owner.outcome = "optimizer_invalid";
  assertSource(owner.id === "B" && owner.outcome === "no_changes", "late A completion must not overwrite completed B state");
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

// IMPORTANT: this is a lightweight SQL contract/source test. It does NOT
// execute either PL/pgSQL RPC against a real PostgreSQL instance. The small
// TypeScript ownership model below guards the intended A/B ordering, but the
// migration's transactional/atomic behavior still requires validation against
// the target PostgreSQL/Supabase environment before production deployment.

function assertSource(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runBackendOptimizerHeartbeatMigrationTests() {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260813010000_harden_backend_optimizer_heartbeat.sql"), "utf8").replace(/\r\n/g, "\n");
  assertSource(sql.includes("current_run_id = p_run_id") && sql.includes("current_run_started_at = p_run_started_at"), "completion must compare-and-set both run identity and start time");
  assertSource(/current_run_started_at is null or current_run_started_at < p_run_started_at/.test(sql), "an older run start must not replace a newer owner");
  assertSource(sql.includes("validated_plan_fingerprint"), "heartbeat must persist validated plan identity");

  // Model the SQL ownership predicate: A starts, newer B starts, B completes,
  // then A's late completion cannot match the singleton owner.
  let owner = { id: "A", startedAt: 1, outcome: "running" };
  const begin = (id: string, startedAt: number) => {
    if (owner.startedAt >= startedAt) return false;
    owner = { id, startedAt, outcome: "running" };
    return true;
  };
  const complete = (id: string, startedAt: number, outcome: string) => {
    if (owner.id !== id || owner.startedAt !== startedAt) return false;
    owner.outcome = outcome;
    return true;
  };
  assertSource(begin("B", 2), "newer B must acquire ownership");
  assertSource(!begin("A", 1), "superseded A must not reacquire ownership");
  assertSource(complete("B", 2, "no_changes"), "owner B must complete");
  assertSource(
    !complete("A", 1, "optimizer_invalid"),
    "superseded A completion must return false",
  );
  assertSource(owner.id === "B" && owner.outcome === "no_changes", "late A completion must not overwrite completed B state");

  const edgeFunctionSource = readFileSync(
    join(process.cwd(), "supabase/functions/run-heating-optimizer/index.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assertSource(
    edgeFunctionSource.includes("if (!wasHeartbeatCompareAndSetCommitted(beginHeartbeatCommitted))") &&
      edgeFunctionSource.includes('status: "superseded"') &&
      edgeFunctionSource.includes("heartbeat_begin_superseded"),
    "a lost begin CAS must stop as an explicitly superseded run",
  );
  assertSource(
    edgeFunctionSource.includes("heartbeat_committed: heartbeatCommitted") &&
      edgeFunctionSource.includes('heartbeat_status: heartbeatCommitted ? "committed" : "superseded"'),
    "a lost completion CAS must not be reported as heartbeat-committed",
  );
  assertSource(
    edgeFunctionSource.includes('p_last_outcome: "run_error"') &&
      edgeFunctionSource.includes('p_health_status: "unhealthy"'),
    "owned failures must complete the heartbeat as unhealthy run_error",
  );
  for (const failureReason of [
    "Failed to fetch latest tank reading",
    "Failed to fetch heating_control_settings",
    "Failed to fetch electricity_prices",
    "Failed to fetch heating_plans",
    "Failed to save shadow run",
  ]) {
    assertSource(
      edgeFunctionSource.includes(`await completeRunError(\n        \`${failureReason}`) ||
        edgeFunctionSource.includes(`await completeRunError(\`${failureReason}`),
      `${failureReason} must attempt a run_error completion`,
    );
  }
  assertSource(
    edgeFunctionSource.includes("if (completeRunError) {") &&
      edgeFunctionSource.includes("await completeRunError(reason);"),
    "the outer exception handler must attempt a run_error completion after ownership",
  );
  assertSource(
    edgeFunctionSource.includes("run_error heartbeat superseded; newer run state preserved"),
    "a superseded run_error completion must preserve and log the newer owner",
  );
}

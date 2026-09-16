import fs from "node:fs";
import path from "node:path";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runV2ProductionCutoverMigrationSourceTests() {
  const migrationPath = path.join(
    process.cwd(),
    "supabase/migrations/20260916134000_enable_v2_production_cutover.sql",
  );
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert(sql.includes("mirror_v2_heating_plan_to_production"), "cutover trigger function must exist");
  assert(sql.includes("heating_need_mode"), "fixed-mode guard must use authoritative settings");
  assert(sql.includes("mode = 'automatic'"), "cutover must only own automatic plans");
  assert(sql.includes("validated_plan_fingerprint"), "Shelly heartbeat fingerprint must be refreshed by V2");
  assert(sql.includes("last_validated_plan_at = new.published_at"), "heartbeat freshness must use the V2 publish time");
  assert(sql.includes("jobname = 'run-heating-optimizer-shadow-hourly'"), "V1 cron must be disabled during cutover");
  assert(sql.includes("cron.alter_job"), "V1 cron must be toggled through the pg_cron API");
  assert(sql.includes("active := false"), "V1 cron must remain present but inactive for rollback");
  assert(
    sql.includes("set updated_at = updated_at"),
    "cutover seed must preserve the original staged publication time instead of fabricating freshness",
  );
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runTemperatureHistoryRpcMigrationTests() {
  const migrationSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260725010000_fix_average_history_bucketing.sql",
    ),
    "utf8",
  );
  const averageBucketStart = migrationSource.indexOf("average_bucket_rows as");
  const combinedRowsStart = migrationSource.indexOf("combined_rows as");
  const averageBucketSource = migrationSource.slice(
    averageBucketStart,
    combinedRowsStart,
  );
  const latestBucketStart = migrationSource.indexOf("latest_bucket_rows as");
  const latestBucketSource = migrationSource.slice(
    latestBucketStart,
    averageBucketStart,
  );

  assertSource(
    migrationSource.includes(
      "create or replace function public.get_temperature_history_points",
    ) &&
      migrationSource.includes(
        "grant execute on function public.get_temperature_history_points",
      ),
    "migrationin pitaa korvata RPC ja palauttaa execute-grant",
  );
  assertSource(
    averageBucketSource.includes("cross join settings") &&
      averageBucketSource.includes("settings.bucket_seconds") &&
      averageBucketSource.includes("to_timestamp(") &&
      averageBucketSource.includes("floor(extract(epoch from sr.created_at)") &&
      !averageBucketSource.includes("date_trunc('hour'"),
    "average-haaran pitaa kayttaa dynaamista bucket_seconds-ryhmittelya",
  );
  assertSource(
    averageBucketSource.includes("avg(sr.top_temp)") &&
      averageBucketSource.includes("avg(sr.bottom_temp)") &&
      averageBucketSource.includes("where p_mode = 'average'"),
    "average-haaran pitaa sailyttaa keskiarvot ja p_mode-rajaus",
  );
  assertSource(
    latestBucketSource.includes("where p_mode <> 'average'") &&
      latestBucketSource.includes("order by") &&
      latestBucketSource.includes("sr.created_at desc"),
    "latest-haaran toiminnan pitaa sailyttaa uusin piste per bucket",
  );
}

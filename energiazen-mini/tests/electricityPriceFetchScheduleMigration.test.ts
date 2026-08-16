import { readFileSync } from "node:fs";
import { join } from "node:path";

// IMPORTANT: this is a lightweight SQL contract/source test. It does NOT
// execute the migration against a real PostgreSQL/Supabase instance.

function assertSource(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runElectricityPriceFetchScheduleMigrationTests() {
  const originalSql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260724020000_schedule_electricity_price_fetch.sql",
    ),
    "utf8",
  );
  assertSource(
    originalSql.includes("'10 * * * *'"),
    "the original migration must be left untouched at its original hourly schedule",
  );

  const rescheduleSql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260816000000_reschedule_electricity_price_fetch_every_30min.sql",
    ),
    "utf8",
  );
  assertSource(
    rescheduleSql.includes("where jobname = 'fetch-electricity-prices-hourly'") &&
      /perform cron\.unschedule\(existing_job\.jobid\);/.test(rescheduleSql),
    "the reschedule migration must unschedule the existing same-named job before recreating it",
  );
  assertSource(
    rescheduleSql.includes("'fetch-electricity-prices-hourly'") &&
      rescheduleSql.includes("'20,50 * * * *'"),
    "fetch-electricity-prices-hourly must be rescheduled to run at minutes 20 and 50",
  );
  assertSource(
    rescheduleSql.includes("/functions/v1/fetch-electricity-prices"),
    "the reschedule migration must keep dispatching to the unmodified fetch-electricity-prices edge function",
  );
}

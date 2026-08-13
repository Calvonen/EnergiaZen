import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

type RelayReading = { created_at: string; heating: boolean | null };

function relaySnapshotMatches(
  expected: RelayReading,
  currentReadings: RelayReading[],
) {
  if (expected.heating === null || currentReadings.length === 0) {
    return false;
  }
  const originalExists = currentReadings.some(
    (reading) =>
      reading.created_at === expected.created_at &&
      reading.heating === expected.heating,
  );
  const latestCreatedAt = currentReadings.reduce(
    (latest, reading) =>
      reading.created_at > latest ? reading.created_at : latest,
    currentReadings[0].created_at,
  );
  const latestReadings = currentReadings.filter(
    (reading) => reading.created_at === latestCreatedAt,
  );

  return (
    originalExists &&
    latestCreatedAt >= expected.created_at &&
    latestReadings.every((reading) => reading.heating === expected.heating)
  );
}

export function runBackendHeatingOptimizerSecurityTests() {
  const edgeSource = readFileSync(
    join(process.cwd(), "supabase/functions/run-heating-optimizer/index.ts"),
    "utf8",
  );
  const relayMigration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813070000_recheck_backend_relay_snapshot.sql",
    ),
    "utf8",
  );
  const safeCompletionMigration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813060000_secure_no_changes_completion.sql",
    ),
    "utf8",
  );
  const cronMigration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813080000_authenticate_heating_optimizer_cron.sql",
    ),
    "utf8",
  );

  const authCheck = edgeSource.indexOf(
    "isHeatingOptimizerCronSecretAuthorized(providedCronSecret, cronSecret)",
  );
  const unauthorizedReturn = edgeSource.indexOf(
    'return jsonResponse({ error: "Unauthorized" }, 401)',
  );
  const createServiceClient = edgeSource.indexOf("const supabase = createClient(");
  const heartbeatBegin = edgeSource.indexOf('"begin_backend_heating_optimizer_run"');
  const shadowWrite = edgeSource.indexOf('.from("heating_plan_shadow_runs")');
  const publicationCall = edgeSource.indexOf('"publish_backend_heating_optimizer_plans"');

  assertSource(
    edgeSource.includes('Deno.env.get("HEATING_OPTIMIZER_CRON_SECRET")') &&
      edgeSource.includes('request.headers.get("x-energyzen-cron-secret")'),
    "Edge Function must compare a dedicated server-side secret with the cron header",
  );
  assertSource(
    authCheck !== -1 &&
      unauthorizedReturn > authCheck &&
      createServiceClient > unauthorizedReturn &&
      heartbeatBegin > unauthorizedReturn &&
      shadowWrite > unauthorizedReturn &&
      publicationCall > unauthorizedReturn,
    "unauthorized requests must return before service-role client creation or any optimizer write path",
  );
  assertSource(
    cronMigration.includes("from vault.decrypted_secrets") &&
      cronMigration.includes("where name = 'heating_optimizer_cron_secret'") &&
      cronMigration.includes("'x-energyzen-cron-secret'") &&
      cronMigration.includes("where name = 'publishable_key'"),
    "cron must load the private caller secret from Vault while retaining the publishable gateway credential",
  );

  assertSource(
    relayMigration.includes("p_expected_relay_snapshot jsonb") &&
      relayMigration.includes("expected_relay_created_at") &&
      relayMigration.includes("expected_relay_heating") &&
      edgeSource.includes("buildExpectedRelaySnapshot(latestReading)") &&
      edgeSource.includes("p_expected_relay_snapshot: expectedRelaySnapshot"),
    "Edge Function must pass reading identity and relay state to the publication transaction",
  );
  assertSource(
    relayMigration.includes("lock table public.tank_readings in share mode") &&
      relayMigration.includes("original_reading.created_at = expected_relay_created_at") &&
      relayMigration.includes("latest_reading.created_at = latest_relay_created_at") &&
      relayMigration.includes("latest_reading.heating is distinct from expected_relay_heating"),
    "RPC must lock readings and compare the original and latest relay snapshots before completion",
  );
  assertSource(
    relayMigration.lastIndexOf("return 'relay_conflict';") <
      relayMigration.indexOf(
        "return public.publish_backend_heating_optimizer_plans_checked_snapshots(",
      ) &&
      edgeSource.includes('publishCommitted === "relay_conflict"') &&
      safeCompletionMigration.includes("insert into public.heating_plans") &&
      safeCompletionMigration.includes("last_published_at = case") &&
      safeCompletionMigration.includes("last_validated_plan_at = p_published_at") &&
      safeCompletionMigration.includes("validated_plan_fingerprint = p_validated_plan_fingerprint"),
    "every relay conflict must return before the only plan-write and healthy timestamp/fingerprint helper",
  );
  assertSource(
    relayMigration.includes(
      "from public, anon, authenticated, service_role",
    ) &&
      relayMigration.includes("security invoker") &&
      relayMigration.includes("grant execute on function public.publish_backend_heating_optimizer_plans(") &&
      relayMigration.includes("to service_role"),
    "the old no-relay signature must become a private helper while service_role can call only the relay-safe RPC",
  );

  const falseSnapshot: RelayReading = {
    created_at: "2026-08-13T10:00:00.000Z",
    heating: false,
  };
  const trueSnapshot: RelayReading = {
    created_at: "2026-08-13T10:00:00.000Z",
    heating: true,
  };
  assertSource(
    relaySnapshotMatches(falseSnapshot, [falseSnapshot]),
    "unchanged false relay snapshot must remain publishable",
  );
  assertSource(
    relaySnapshotMatches(trueSnapshot, [trueSnapshot]),
    "unchanged true relay snapshot must remain publishable",
  );
  assertSource(
    !relaySnapshotMatches(falseSnapshot, [
      falseSnapshot,
      { created_at: "2026-08-13T10:01:00.000Z", heating: true },
    ]),
    "false to true relay transition must conflict",
  );
  assertSource(
    !relaySnapshotMatches(trueSnapshot, [
      trueSnapshot,
      { created_at: "2026-08-13T10:01:00.000Z", heating: false },
    ]),
    "true to false relay transition must conflict",
  );
  assertSource(
    relaySnapshotMatches(falseSnapshot, [
      falseSnapshot,
      { created_at: "2026-08-13T10:01:00.000Z", heating: false },
    ]),
    "a newer reading with the same relay state must not create a needless conflict",
  );
  assertSource(
    !relaySnapshotMatches(
      { created_at: "2026-08-13T10:00:00.000Z", heating: null },
      [{ created_at: "2026-08-13T10:00:00.000Z", heating: null }],
    ),
    "unknown original relay state must remain fail-safe",
  );
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

type TankReading = {
  bottom_temp: number | null;
  created_at: string;
  heating: boolean | null;
  top_temp: number | null;
};

function tankSnapshotMatches(
  expected: TankReading,
  currentReadings: TankReading[],
) {
  if (
    expected.bottom_temp === null ||
    expected.heating === null ||
    expected.top_temp === null ||
    currentReadings.length === 0
  ) {
    return false;
  }
  const originalExists = currentReadings.some(
    (reading) =>
      reading.created_at === expected.created_at &&
      reading.heating === expected.heating &&
      reading.top_temp === expected.top_temp &&
      reading.bottom_temp === expected.bottom_temp,
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
    latestReadings.every(
      (reading) =>
        reading.heating === expected.heating &&
        reading.top_temp === expected.top_temp &&
        reading.bottom_temp === expected.bottom_temp,
    )
  );
}

type PriceSnapshotRow = {
  ends_at: string;
  region: string;
  resolution_minutes: number;
  spot_price_cents_kwh: number;
  starts_at: string;
};

function priceSnapshotMatches(
  expectedRows: PriceSnapshotRow[],
  currentRows: PriceSnapshotRow[],
) {
  if (expectedRows.length === 0) return false;

  const expectedKeys = new Set<string>();
  return expectedRows.every((expected) => {
    const key = `${expected.region}|${expected.starts_at}|${expected.resolution_minutes}`;
    if (
      expected.region !== "FI" ||
      expected.resolution_minutes !== 60 ||
      expectedKeys.has(key)
    ) {
      return false;
    }
    expectedKeys.add(key);

    const current = currentRows.find(
      (row) =>
        row.region === expected.region &&
        row.starts_at === expected.starts_at &&
        row.resolution_minutes === expected.resolution_minutes,
    );
    return (
      current?.ends_at === expected.ends_at &&
      current.spot_price_cents_kwh === expected.spot_price_cents_kwh
    );
  });
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
  const inputSnapshotMigration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813090000_recheck_backend_tank_and_price_snapshots.sql",
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
  const shadowRetryMigration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260813100000_allow_optimizer_shadow_retry_updates.sql",
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

  const retryLoopStart = edgeSource.indexOf(
    "optimizerAttempt <= maxTankSnapshotPublicationRetries",
  );
  const retryLoopEnd = edgeSource.indexOf(
    'throw new Error("Optimizer retry loop exited without a final outcome")',
  );
  const retryLoopSource = edgeSource.slice(retryLoopStart, retryLoopEnd);
  assertSource(
    retryLoopStart > unauthorizedReturn &&
      retryLoopEnd > retryLoopStart &&
      retryLoopSource.includes('const attemptNow = new Date()') &&
      retryLoopSource.includes('.from("tank_readings")') &&
      retryLoopSource.includes('.from("heating_control_settings")') &&
      retryLoopSource.includes('fetchHeatingGainHistory(async (from, to) =>') &&
      retryLoopSource.includes('.from("electricity_prices")') &&
      retryLoopSource.includes('.from("heating_plans")') &&
      retryLoopSource.includes('fetchLatestTemperatureDropProfile(supabase)') &&
      retryLoopSource.includes('runBackendHeatingOptimization({') &&
      retryLoopSource.includes('buildExpectedTankSnapshot(latestReading)') &&
      retryLoopSource.includes('buildExpectedElectricityPriceSnapshot(') &&
      retryLoopSource.includes('"publish_backend_heating_optimizer_plans"'),
    "each retry must refetch every publication-relevant input, rerun the optimizer and rebuild publication snapshots",
  );
  const tankConflictBranch = retryLoopSource.indexOf(
    'publishCommitted === "tank_snapshot_conflict"',
  );
  const retryContinue = retryLoopSource.indexOf("continue;", tankConflictBranch);
  const terminalConflictBranch = retryLoopSource.indexOf(
    'publishCommitted === "settings_conflict"',
    tankConflictBranch,
  );
  assertSource(
    tankConflictBranch !== -1 &&
      retryLoopSource.indexOf("await stillOwnsHeartbeat()", tankConflictBranch) <
        retryContinue &&
      retryContinue < terminalConflictBranch &&
      !retryLoopSource
        .slice(tankConflictBranch, retryContinue)
        .includes("completePublicationFailure(") &&
      retryLoopSource.includes('"tank_snapshot_conflict_retry_exhausted"') &&
      retryLoopSource.includes("completeTankRetryExhausted(") &&
      edgeSource.includes('p_last_outcome: "deferred"') &&
      edgeSource.includes("p_validated_plan_at: null") &&
      edgeSource.includes("p_validated_plan_fingerprint: null"),
    "the first owned tank conflict must retry without terminal completion, while exhaustion stays deferred and non-validating",
  );
  assertSource(
    edgeSource.includes('.select("current_run_id,current_run_started_at")') &&
      edgeSource.includes("doesHeartbeatRunTokenMatch({") &&
      edgeSource.includes("expectedRunId: runId") &&
      edgeSource.includes("expectedRunStartedAt: runStartedAt") &&
      retryLoopSource.includes('reason: "heartbeat_superseded"') &&
      retryLoopSource.includes("wrote_to_heating_plans: false"),
    "retry must stop without writes when a newer run owns the heartbeat",
  );
  assertSource(
    retryLoopSource.includes('.insert({ id: shadowRunId, ...shadowRow })') &&
      retryLoopSource.includes('.update(shadowRow)') &&
      shadowRetryMigration.includes(
        "grant update on table public.heating_plan_shadow_runs to service_role",
      ),
    "retry must refresh the invocation's single shadow row instead of inserting duplicate diagnostics",
  );

  assertSource(
    inputSnapshotMigration.includes("p_expected_tank_snapshot jsonb") &&
      inputSnapshotMigration.includes("p_expected_price_snapshot jsonb") &&
      edgeSource.includes("buildExpectedTankSnapshot(latestReading)") &&
      edgeSource.includes("buildExpectedElectricityPriceSnapshot(") &&
      edgeSource.includes("p_expected_tank_snapshot: expectedTankSnapshot") &&
      edgeSource.includes("p_expected_price_snapshot: expectedPriceSnapshot"),
    "Edge Function must pass exact tank and used-price snapshots to the publication transaction",
  );
  assertSource(
    inputSnapshotMigration.includes("lock table public.tank_readings in share mode") &&
      inputSnapshotMigration.includes("lock table public.electricity_prices in share mode") &&
      inputSnapshotMigration.includes("original_reading.created_at = expected_created_at") &&
      inputSnapshotMigration.includes("latest_reading.heating is distinct from expected_heating") &&
      inputSnapshotMigration.includes("latest_reading.top_temp is distinct from expected_top_temp") &&
      inputSnapshotMigration.includes("latest_reading.bottom_temp is distinct from expected_bottom_temp"),
    "RPC must lock inputs and compare every tank value used by the optimizer",
  );
  assertSource(
    inputSnapshotMigration.includes("from jsonb_to_recordset(p_expected_price_snapshot)") &&
      inputSnapshotMigration.includes("current_price.region = expected.region") &&
      inputSnapshotMigration.includes("current_price.starts_at = expected.starts_at") &&
      inputSnapshotMigration.includes("current_price.resolution_minutes = expected.resolution_minutes") &&
      inputSnapshotMigration.includes("current_price.ends_at is distinct from expected.ends_at") &&
      inputSnapshotMigration.includes("current_price.spot_price_cents_kwh is distinct from expected.spot_price_cents_kwh"),
    "RPC must compare only the canonical keys and values in the optimizer's hourly price window",
  );
  const nestedSafeCall = inputSnapshotMigration.indexOf(
    "return public.publish_backend_heating_optimizer_plans_checked_relay_snapshot(",
  );
  assertSource(
    inputSnapshotMigration.lastIndexOf("return 'tank_snapshot_conflict';") < nestedSafeCall &&
      inputSnapshotMigration.lastIndexOf("return 'price_snapshot_conflict';") < nestedSafeCall &&
      !inputSnapshotMigration.includes("insert into public.heating_plans") &&
      edgeSource.includes('publishCommitted === "relay_conflict"') &&
      edgeSource.includes('publishCommitted === "tank_snapshot_conflict"') &&
      edgeSource.includes('publishCommitted === "price_snapshot_conflict"') &&
      safeCompletionMigration.includes("insert into public.heating_plans") &&
      safeCompletionMigration.includes("last_published_at = case") &&
      safeCompletionMigration.includes("last_validated_plan_at = p_published_at") &&
      safeCompletionMigration.includes("validated_plan_fingerprint = p_validated_plan_fingerprint"),
    "tank and price conflicts must return before the only plan-write and healthy completion helper",
  );
  assertSource(
    edgeSource.includes(
      "(hasChangedPlans && canPublishPlan) || canValidateNoChanges",
    ) &&
      edgeSource.includes(
        'successfulOutcome = hasChangedPlans ? "published" : "no_changes"',
      ) &&
      edgeSource.includes("publication_conflict: publishCommitted") &&
      edgeSource.includes("wrote_to_heating_plans: false"),
    "changed-plan and no_changes completion must share snapshot checks and report zero writes on conflict",
  );
  assertSource(
    inputSnapshotMigration.includes("from public, anon, authenticated, service_role") &&
      inputSnapshotMigration.includes("security invoker") &&
      inputSnapshotMigration.includes("grant execute on function public.publish_backend_heating_optimizer_plans(") &&
      inputSnapshotMigration.includes("to service_role") &&
      relayMigration.includes("p_expected_relay_snapshot jsonb"),
    "the obsolete relay-only signature must be private while service_role can call only the full snapshot RPC",
  );

  const falseSnapshot: TankReading = {
    bottom_temp: 41,
    created_at: "2026-08-13T10:00:00.000Z",
    heating: false,
    top_temp: 52,
  };
  const trueSnapshot: TankReading = { ...falseSnapshot, heating: true };
  assertSource(
    tankSnapshotMatches(falseSnapshot, [falseSnapshot]),
    "unchanged tank snapshot must remain publishable",
  );
  assertSource(
    !tankSnapshotMatches(falseSnapshot, [
      falseSnapshot,
      { ...falseSnapshot, created_at: "2026-08-13T10:01:00.000Z", top_temp: 48 },
    ]),
    "same relay state with changed top temperature must conflict",
  );
  assertSource(
    !tankSnapshotMatches(falseSnapshot, [
      falseSnapshot,
      { ...falseSnapshot, bottom_temp: 37, created_at: "2026-08-13T10:01:00.000Z" },
    ]),
    "same relay state with changed bottom temperature must conflict",
  );
  assertSource(
    !tankSnapshotMatches(trueSnapshot, [
      trueSnapshot,
      { ...trueSnapshot, created_at: "2026-08-13T10:01:00.000Z", heating: false },
    ]),
    "same temperatures with changed relay state must conflict",
  );
  assertSource(
    tankSnapshotMatches(falseSnapshot, [
      falseSnapshot,
      { ...falseSnapshot, created_at: "2026-08-13T10:01:00.000Z" },
    ]),
    "a newer reading with identical relevant values must remain publishable",
  );
  assertSource(
    !tankSnapshotMatches({ ...falseSnapshot, top_temp: null }, [
      { ...falseSnapshot, top_temp: null },
    ]),
    "unknown relevant temperature must remain fail-safe",
  );

  const usedPrice: PriceSnapshotRow = {
    ends_at: "2026-08-13T11:00:00.000Z",
    region: "FI",
    resolution_minutes: 60,
    spot_price_cents_kwh: 4.25,
    starts_at: "2026-08-13T10:00:00.000Z",
  };
  const unusedPrice: PriceSnapshotRow = {
    ...usedPrice,
    ends_at: "2026-08-15T11:00:00.000Z",
    spot_price_cents_kwh: 8,
    starts_at: "2026-08-15T10:00:00.000Z",
  };
  assertSource(
    priceSnapshotMatches([usedPrice], [usedPrice]),
    "unchanged used price snapshot must remain publishable",
  );
  assertSource(
    !priceSnapshotMatches([usedPrice], [
      { ...usedPrice, spot_price_cents_kwh: 9.5 },
    ]),
    "a changed used hourly price must conflict",
  );
  assertSource(
    !priceSnapshotMatches([usedPrice], []),
    "a deleted used hourly price must conflict",
  );
  assertSource(
    !priceSnapshotMatches([usedPrice], [
      { ...usedPrice, ends_at: "2026-08-13T11:30:00.000Z" },
    ]),
    "a replacement row with conflicting interval data must conflict",
  );
  assertSource(
    priceSnapshotMatches([usedPrice], [usedPrice, unusedPrice]),
    "an unused future price row must not block publication",
  );
  assertSource(
    priceSnapshotMatches([usedPrice], [
      usedPrice,
      {
        ...usedPrice,
        ends_at: "2026-08-13T10:15:00.000Z",
        resolution_minutes: 15,
        spot_price_cents_kwh: 99,
      },
    ]),
    "15-minute rows must not interfere with the used 60-minute snapshot",
  );
}

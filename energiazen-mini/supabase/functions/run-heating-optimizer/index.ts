// EnergyZen backend-primary heating optimizer.
//
// Runs the exact same optimizeHeatingPlan() the React Native app runs,
// using production Supabase price/tank/settings data, keeps the diagnostic
// heating_plan_shadow_runs row, and publishes changed automatic plans only
// after the existing readiness, optimizer validity, relay-status, duplicate-
// suppression and heartbeat ownership gates all pass.
//
// All actual optimizer/publication logic lives in ./logic.ts (no Deno-only
// APIs, unit-tested under Node - see logic.test.ts). This file is only the
// Supabase I/O shell: fetch inputs with the service role, call logic.ts,
// insert one shadow_runs row. Not independently verified against a real
// `supabase functions deploy` in this environment (no Deno CLI available
// here) - see the PR report for what to check before trusting this
// operationally.
import { createClient } from "npm:@supabase/supabase-js@2";

import {
  buildHeatingPlanPublicationDecision,
  buildHeatingPlanFingerprint,
  buildExpectedElectricityPriceSnapshot,
  buildExpectedHeatingPlanVersions,
  buildExpectedOptimizerSettingsSnapshot,
  buildExpectedTankSnapshot,
  buildOptimizerDailyMinimumPrices,
  buildOptimizerHours,
  buildShadowRunRow,
  buildStoredPlansMap,
  canMarkHeatingPlanValidated,
  combineBackendPublicationReadiness,
  computeNextUnknownHeatingAnchor,
  createHeatingOptimizationSettings,
  doesHeartbeatRunTokenMatch,
  fallbackHeatingGainPerHour,
  failedOptimizerInputFetch,
  fetchHeatingGainHistory,
  fetchLatestTemperatureDropProfile,
  getDateKeyOffset,
  getFinnishDateKey,
  getHelsinkiHourNumber,
  latestPriceFetchedAt,
  isHeatingOptimizerCronSecretAuthorized,
  maxTankSnapshotPublicationRetries,
  resolveOptimizerInputFetchReadiness,
  resolveHourlyDropProfile,
  resolveOptimizerSettings,
  resolvePostHeatingCooldownHourStart,
  resolveTankSnapshotRetryAction,
  runBackendHeatingOptimization,
  successfulOptimizerInputFetch,
  type RawElectricityPriceRow,
  type RawHeatingControlSettingsRow,
  type RawHeatingPlanRow,
  type RawTankReading,
  type TankTemperatureReading,
  wasHeartbeatCompareAndSetCommitted,
} from "./logic.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const electricityPriceRegion = "FI";
const heatingGainHistoryDays = 30;
const recoveryReadingsWindowDays = 7;
const postHeatingCooldownSafetyTopTemperature = 50;
const postHeatingCooldownPenaltyCents = 1_000_000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: jsonHeaders, status });
}

Deno.serve(async (request) => {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const cronSecret = Deno.env.get("HEATING_OPTIMIZER_CRON_SECRET");
  const providedCronSecret = request.headers.get("x-energyzen-cron-secret");
  if (!isHeatingOptimizerCronSecretAuthorized(providedCronSecret, cronSecret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let completeRunError: ((reason: string) => Promise<void>) | null = null;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse(
        { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
        500,
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const now = new Date();
    const runId = crypto.randomUUID();
    const runStartedAt = now.toISOString();

    // A crash before this write (or pg_cron never invoking the function)
    // cannot self-report. A persisted "running" state is intentionally
    // unhealthy, so a crash after this point fails safe on the Shelly.
    const { data: beginHeartbeatCommitted, error: beginHeartbeatError } = await supabase.rpc(
      "begin_backend_heating_optimizer_run",
      { p_run_id: runId, p_run_started_at: runStartedAt },
    );
    if (beginHeartbeatError) {
      throw new Error(`Failed to begin optimizer heartbeat: ${beginHeartbeatError.message}`);
    }
    if (!wasHeartbeatCompareAndSetCommitted(beginHeartbeatCommitted)) {
      console.warn(
        "run-heating-optimizer: run superseded before begin; optimizer pipeline skipped",
        { run_id: runId, run_started_at: runStartedAt },
      );
      return jsonResponse(
        {
          heartbeat_committed: false,
          reason: "heartbeat_begin_superseded",
          run_id: runId,
          status: "superseded",
          wrote_to_heating_plans: false,
        },
        409,
      );
    }
    completeRunError = async (reason: string) => {
      try {
        const { data, error } = await supabase.rpc(
          "complete_backend_heating_optimizer_run",
          {
            p_health_status: "unhealthy",
            p_last_outcome: "run_error",
            p_reason: reason,
            p_run_id: runId,
            p_run_started_at: runStartedAt,
            p_validated_plan_at: null,
            p_validated_plan_date: null,
            p_validated_plan_fingerprint: null,
            p_validated_planned_hours: null,
          },
        );
        if (error) {
          console.error(
            "run-heating-optimizer: failed to persist run_error heartbeat",
            { heartbeat_error: error.message, reason, run_id: runId },
          );
        } else if (!wasHeartbeatCompareAndSetCommitted(data)) {
          console.warn(
            "run-heating-optimizer: run_error heartbeat superseded; newer run state preserved",
            { reason, run_id: runId, run_started_at: runStartedAt },
          );
        }
      } catch (heartbeatError) {
        console.error(
          "run-heating-optimizer: run_error heartbeat threw; original error preserved",
          { heartbeat_error: heartbeatError, reason, run_id: runId },
        );
      }
    };
    const completePublicationFailure = async (reason: string) => {
      const { data, error } = await supabase.rpc(
        "complete_backend_heating_optimizer_run",
        {
          p_health_status: "unhealthy",
          p_last_outcome: "publication_failed",
          p_reason: reason,
          p_run_id: runId,
          p_run_started_at: runStartedAt,
          p_validated_plan_at: null,
          p_validated_plan_date: null,
          p_validated_plan_fingerprint: null,
          p_validated_planned_hours: null,
        },
      );
      if (error) {
        throw new Error(`Failed to persist publication failure heartbeat: ${error.message}`);
      }
      return wasHeartbeatCompareAndSetCommitted(data);
    };
    const completeTankRetryExhausted = async (reason: string) => {
      const { data, error } = await supabase.rpc(
        "complete_backend_heating_optimizer_run",
        {
          p_health_status: "unhealthy",
          p_last_outcome: "deferred",
          p_reason: reason,
          p_run_id: runId,
          p_run_started_at: runStartedAt,
          p_validated_plan_at: null,
          p_validated_plan_date: null,
          p_validated_plan_fingerprint: null,
          p_validated_planned_hours: null,
        },
      );
      if (error) {
        throw new Error(`Failed to persist tank retry exhaustion: ${error.message}`);
      }
      return wasHeartbeatCompareAndSetCommitted(data);
    };
    const stillOwnsHeartbeat = async () => {
      const { data, error } = await supabase
        .from("backend_heating_optimizer_state")
        .select("current_run_id,current_run_started_at")
        .eq("id", 1)
        .maybeSingle();
      if (error) {
        throw new Error(`Failed to verify optimizer heartbeat ownership: ${error.message}`);
      }
      return doesHeartbeatRunTokenMatch({
        currentRunId: data?.current_run_id,
        currentRunStartedAt: data?.current_run_started_at,
        expectedRunId: runId,
        expectedRunStartedAt: runStartedAt,
      });
    };
    const shadowRunId = crypto.randomUUID();
    let shadowRunSaved = false;

    for (
      let optimizerAttempt = 0;
      optimizerAttempt <= maxTankSnapshotPublicationRetries;
      optimizerAttempt += 1
    ) {
      const attemptNow = new Date();
    // getDateKeyOffset reads the Helsinki calendar date and shifts by whole
    // calendar days - unlike a fixed +24h instant shift, it stays correct
    // across DST transitions (spring-forward/fall-back days are 23h/25h
    // long in real time, so a literal 24h add can land on the wrong
    // Helsinki calendar date). Same helper app/(tabs)/index.tsx uses for
    // today/tomorrow (getChartDayKey, fetchHourlyPrices) - no parallel date
    // logic here.
    const todayPlanDate = getDateKeyOffset(0, attemptNow);
    const tomorrowPlanDate = getDateKeyOffset(1, attemptNow);
    const priceWindowStartIso = new Date(
      attemptNow.getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const gainHistoryStartIso = new Date(
      attemptNow.getTime() - heatingGainHistoryDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const recoveryReadingsStartIso = new Date(
      attemptNow.getTime() - recoveryReadingsWindowDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    // The two tank_readings history fetches must stay paginated via
    // fetchHeatingGainHistory (same helper, same reasoning app/(tabs)/
    // index.tsx already documents at its own call sites): PostgREST caps a
    // single response well under a 30-day/7-day reading count, so a plain
    // .limit(N) here would silently return only the oldest slice of the
    // window instead of the full one (see PR #125 in the app).
    const [
      latestReadingResult,
      settingsResult,
      gainHistoryFetch,
      recoveryReadingsFetch,
      priceResult,
      heatingPlansResult,
      dropProfileResult,
    ] = await Promise.all([
      supabase
        .from("tank_readings")
        .select("created_at,top_temp,bottom_temp,heating")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("heating_control_settings")
        .select(
          "automatic_max_heating_hours,full_tank_average_temperature,full_tank_showers,heating_gain_source,heating_need_mode,max_tank_temperature,min_tank_temperature,price_tolerance_cents,safety_shower_reserve,target_shower_reserve,updated_at",
        )
        .eq("id", 1)
        .maybeSingle(),
      fetchHeatingGainHistory(async (from, to) => {
        const { data, error } = await supabase
          .from("tank_readings")
          .select("created_at,top_temp,bottom_temp,inlet_temp,heating")
          .eq("heating", true)
          .gte("created_at", gainHistoryStartIso)
          .lte("created_at", attemptNow.toISOString())
          .order("created_at", { ascending: true })
          .range(from, to);

        return { data: (data ?? []) as TankTemperatureReading[], error };
      })
        .then(successfulOptimizerInputFetch)
        .catch((error: unknown) => {
          console.warn("run-heating-optimizer: heating gain history fetch failed", error);
          return failedOptimizerInputFetch("heating_gain_history_fetch_failed", {
            fetchedRowCount: 0,
            pageCount: 0,
            readings: [] as TankTemperatureReading[],
          });
        }),
      fetchHeatingGainHistory(async (from, to) => {
        const { data, error } = await supabase
          .from("tank_readings")
          .select("created_at,top_temp,bottom_temp,inlet_temp,heating")
          .gte("created_at", recoveryReadingsStartIso)
          .order("created_at", { ascending: true })
          .range(from, to);

        return { data: (data ?? []) as TankTemperatureReading[], error };
      })
        .then(successfulOptimizerInputFetch)
        .catch((error: unknown) => {
          console.warn("run-heating-optimizer: recovery readings fetch failed", error);
          return failedOptimizerInputFetch("recovery_history_fetch_failed", {
            fetchedRowCount: 0,
            pageCount: 0,
            readings: [] as TankTemperatureReading[],
          });
        }),
      supabase
        .from("electricity_prices")
        .select("starts_at,ends_at,spot_price_cents_kwh,fetched_at,resolution_minutes")
        .eq("region", electricityPriceRegion)
        .eq("resolution_minutes", 60)
        .gte("starts_at", priceWindowStartIso)
        .order("starts_at", { ascending: true }),
      supabase
        .from("heating_plans")
        .select("plan_date,planned_hours,mode,target_hours,updated_at")
        .in("plan_date", [todayPlanDate, tomorrowPlanDate]),
      fetchLatestTemperatureDropProfile(supabase)
        .then(successfulOptimizerInputFetch)
        .catch((error: unknown) => {
          console.warn("run-heating-optimizer: temperature drop profile fetch failed", error);
          return failedOptimizerInputFetch("drop_profile_fetch_failed", null);
        }),
    ]);

    if (latestReadingResult.error) {
      await completeRunError(
        `Failed to fetch latest tank reading: ${latestReadingResult.error.message}`,
      );
      return jsonResponse(
        { error: "Failed to fetch latest tank reading", message: latestReadingResult.error.message },
        502,
      );
    }
    if (settingsResult.error) {
      await completeRunError(
        `Failed to fetch heating_control_settings: ${settingsResult.error.message}`,
      );
      return jsonResponse(
        { error: "Failed to fetch heating_control_settings", message: settingsResult.error.message },
        502,
      );
    }
    if (priceResult.error) {
      await completeRunError(
        `Failed to fetch electricity_prices: ${priceResult.error.message}`,
      );
      return jsonResponse(
        { error: "Failed to fetch electricity_prices", message: priceResult.error.message },
        502,
      );
    }
    if (heatingPlansResult.error) {
      await completeRunError(
        `Failed to fetch heating_plans: ${heatingPlansResult.error.message}`,
      );
      return jsonResponse(
        { error: "Failed to fetch heating_plans", message: heatingPlansResult.error.message },
        502,
      );
    }

    const latestReading = (latestReadingResult.data ?? null) as RawTankReading | null;
    const settingsRow = (settingsResult.data ?? null) as RawHeatingControlSettingsRow | null;
    const gainHistory = gainHistoryFetch.value.readings;
    const recoveryReadings = recoveryReadingsFetch.value.readings;
    const prices = (priceResult.data ?? []) as RawElectricityPriceRow[];
    const heatingPlanRows = (heatingPlansResult.data ?? []) as RawHeatingPlanRow[];
    const appTodayPlan = heatingPlanRows.find((row) => row.plan_date === todayPlanDate) ?? null;

    const {
      heatingGainSource,
      publicationReadiness: settingsPublicationReadiness,
      settings: optimizerSettingsSource,
      settingsSource,
    } = resolveOptimizerSettings(settingsRow);
    // Codex P2 follow-up: resolved before the readiness check below so the
    // check can see which profile source selectTemperatureDropProfile
    // actually picked - selection itself is unaffected by this move, it
    // only now runs a few lines earlier.
    const dropProfile = resolveHourlyDropProfile({
      localReadings: recoveryReadings,
      now: attemptNow,
      storedProfile: dropProfileResult.value,
    });
    // Codex P2: gain history is only actually consumed in "learned" mode
    // (runBackendHeatingOptimization derives the learned per-hour gain from
    // it); "fixed" mode uses the explicit configured heatingGainPerHour and
    // never reads this history at all. A failed gain-history fetch must
    // therefore not block publication in fixed mode - only include it in
    // the readiness check when the authoritative heating_gain_source is
    // "learned", so a fixed-mode install stays publishable on an input it
    // doesn't use.
    //
    // Codex P2 follow-up: the local 7-day recovery history is likewise only
    // actually consumed when resolveHourlyDropProfile ends up selecting it
    // (dropProfile.source === "local-7-day") - when a fresh stored Supabase
    // profile was selected instead, recovery-history fetch failure must not
    // by itself block publication. dropProfileResult (the fetch of the
    // stored profile itself) stays unconditionally required either way: a
    // failure there already forces selection down to local-7-day (no
    // stored profile to select), which in turn requires recoveryReadingsFetch.
    const inputFetchReadiness = resolveOptimizerInputFetchReadiness([
      ...(heatingGainSource === "learned" ? [gainHistoryFetch] : []),
      ...(dropProfile.source === "local-7-day" ? [recoveryReadingsFetch] : []),
      dropProfileResult,
    ]);
    const publicationReadiness = combineBackendPublicationReadiness(
      settingsPublicationReadiness,
      inputFetchReadiness,
    );
    const optimizationSettings = createHeatingOptimizationSettings(
      optimizerSettingsSource,
      fallbackHeatingGainPerHour,
    );
    const hours = buildOptimizerHours(
      prices,
      attemptNow,
      todayPlanDate,
      tomorrowPlanDate,
    );
    const dailyMinimumPrices = buildOptimizerDailyMinimumPrices(
      prices,
      todayPlanDate,
      tomorrowPlanDate,
    );
    const heating = latestReading?.heating ?? null;
    const storedTodayHours =
      appTodayPlan?.mode === "automatic" && Array.isArray(appTodayPlan.planned_hours)
        ? appTodayPlan.planned_hours
            .filter((hour): hour is number => Number.isInteger(hour))
            .map(Number)
        : [];
    const currentTopTemperature = latestReading?.top_temp;
    const cooldownHourStart = resolvePostHeatingCooldownHourStart({
      hours,
      latestHeating: heating,
      now: attemptNow,
      recentReadings: recoveryReadings,
      safetyTopTemperature: postHeatingCooldownSafetyTopTemperature,
      storedTodayHours,
      todayPlanDate,
      topTemperature: currentTopTemperature,
    });
    // Keep normal optimization running, but make the actual chronologically
    // adjacent price interval after the already-started stored block a
    // last-resort safety choice instead of letting repeated 5-minute
    // recalculations extend the active block one hour at a time. Checking
    // the next interval's Helsinki-local hour rather than currentHour + 1
    // keeps both occurrences of the repeated DST hour covered by the same
    // stored planned-hour number. Measured top temperature below 50 C also
    // disables the cooldown penalty so the existing safety logic can react
    // immediately.
    const optimizerHours = hours.map((hour) =>
      cooldownHourStart !== null && hour.date.getTime() === cooldownHourStart
        ? { ...hour, price: hour.price + postHeatingCooldownPenaltyCents }
        : hour,
    );
    const run = runBackendHeatingOptimization({
      dailyMinimumPrices,
      heatingGainHistory: gainHistory,
      hourlyDrops: dropProfile.hourlyDrops,
      heatingGainSource,
      hours: optimizerHours,
      isCurrentlyHeating: heating === true,
      latestReading,
      now: attemptNow,
      settings: optimizationSettings,
    });

    // Stateless by design (see report): each run treats "unknown just
    // started this instant" rather than tracking how long heating has been
    // unreadable across runs the way the app's unknownHeatingAnchorRef
    // does. Recorded as uncertainty_reason on the shadow row whenever
    // heating is null, not silently hidden.
    const unknownHeatingAnchor = computeNextUnknownHeatingAnchor({
      currentAnchor: null,
      heating,
      now: attemptNow,
      readingCreatedAt: latestReading?.created_at ?? null,
    });
    const decision = buildHeatingPlanPublicationDecision({
      currentHourNumber: getHelsinkiHourNumber(attemptNow),
      dateKeyOf: getFinnishDateKey,
      hasAttemptedTankReadingFetch: true,
      heating,
      isTodayPlanLoaded: true,
      now: attemptNow,
      optimizerResult: run.result,
      optimizerSettings: { automaticMaxHeatingHours: optimizationSettings.maxHeatingHours },
      selectedHours: hours,
      storedPlans: buildStoredPlansMap(heatingPlanRows),
      todayPlanDate,
      tomorrowPlanDate,
      unknownHeatingAnchor,
    });

    const shadowRow = buildShadowRunRow({
      appTodayPlan,
      decision,
      heatingStatus: heating,
      inputPriceFetchedAt: latestPriceFetchedAt(prices),
      now: attemptNow,
      optimizerResult: run.result,
      readinessReason: inputFetchReadiness.ok
        ? (run.readiness.ok ? null : run.readiness.reason)
        : inputFetchReadiness.reason,
      settingsSource,
      tankReadingAt: latestReading?.created_at ?? null,
      todayPlanDate,
      tomorrowPlanDate,
    });

    const shadowWrite = shadowRunSaved
      ? await supabase
          .from("heating_plan_shadow_runs")
          .update(shadowRow)
          .eq("id", shadowRunId)
      : await supabase
          .from("heating_plan_shadow_runs")
          .insert({ id: shadowRunId, ...shadowRow });
    const insertError = shadowWrite.error;

    if (insertError) {
      console.error("run-heating-optimizer: shadow row insert failed", {
        message: insertError.message,
        details: insertError.details,
        hint: insertError.hint,
        code: insertError.code,
      });
      await completeRunError(`Failed to save shadow run: ${insertError.message}`);
      return jsonResponse(
        { error: "Failed to save shadow run", message: insertError.message },
        500,
      );
    }
    shadowRunSaved = true;
    const isValidReadyDecision = decision.status === "ready" && run.result?.valid === true;
    const todayChanged =
      decision.status === "ready" &&
      decision.changedPlans.some((plan) => plan.plan_date === todayPlanDate);
    const canValidateNoChanges = canMarkHeatingPlanValidated(
      heating,
      isValidReadyDecision,
      todayChanged,
    ) && publicationReadiness.ok;
    const hasChangedPlans = decision.status === "ready" && decision.changedPlans.length > 0;
    const canPublishPlan =
      typeof heating === "boolean" &&
      isValidReadyDecision &&
      publicationReadiness.ok;
    const invalidOutcome = !inputFetchReadiness.ok
      ? "deferred"
      : canValidateNoChanges
        ? "no_changes"
        : typeof heating !== "boolean"
          ? "deferred"
          : run.result?.valid === false
            ? "optimizer_invalid"
            : "deferred";

    const validatedHours =
      (canValidateNoChanges || (hasChangedPlans && canPublishPlan)) &&
      decision.status === "ready"
      ? decision.today.planned_hours
      : null;
    const validatedFingerprint = validatedHours
      ? buildHeatingPlanFingerprint(todayPlanDate, validatedHours)
      : null;

    let outcome = invalidOutcome;
    let heartbeatCommitted = false;
    let wroteToHeatingPlans = false;
    let publishedPlanCount = 0;
    const shouldUseSafeSnapshotCompletion =
      (hasChangedPlans && canPublishPlan) || canValidateNoChanges;
    if (shouldUseSafeSnapshotCompletion && decision.status === "ready") {
      const expectedPlanVersions = buildExpectedHeatingPlanVersions(
        decision.changedPlans,
        heatingPlanRows,
        todayPlanDate,
      );
      const expectedSettings = buildExpectedOptimizerSettingsSnapshot(settingsRow);
      const expectedTankSnapshot = buildExpectedTankSnapshot(latestReading);
      const expectedPriceSnapshot = buildExpectedElectricityPriceSnapshot(
        prices,
        todayPlanDate,
        tomorrowPlanDate,
        electricityPriceRegion,
      );
      const successfulOutcome = hasChangedPlans ? "published" : "no_changes";
      const { data: publishCommitted, error: publishError } = await supabase.rpc(
        "publish_backend_heating_optimizer_plans",
        {
          p_changed_plans: decision.changedPlans,
          p_expected_plan_versions: expectedPlanVersions,
          p_expected_price_snapshot: expectedPriceSnapshot,
          p_expected_settings: expectedSettings,
          p_expected_tank_snapshot: expectedTankSnapshot,
          p_publish_reason: hasChangedPlans ? "valid plan published" : shadowRow.reason,
          p_published_at: attemptNow.toISOString(),
          p_run_id: runId,
          p_run_started_at: runStartedAt,
          p_validated_plan_date: todayPlanDate,
          p_validated_plan_fingerprint: validatedFingerprint,
          p_validated_planned_hours: validatedHours,
        },
      );
      if (publishError) {
        console.error("run-heating-optimizer: safe plan completion failed", {
          code: publishError.code,
          details: publishError.details,
          hint: publishError.hint,
          message: publishError.message,
          run_id: runId,
        });
        const failureCommitted = await completePublicationFailure(
          `publication_failed: ${publishError.message}`,
        );
        return jsonResponse(
          {
            decision: decision.status,
            error: hasChangedPlans
              ? "Failed to publish heating plans"
              : "Failed to validate unchanged heating plan",
            heartbeat_committed: failureCommitted,
            heartbeat_status: failureCommitted ? "committed" : "superseded",
            message: publishError.message,
            reason: "publication_failed",
            run_id: runId,
            wrote_to_heating_plans: false,
          },
          500,
        );
      }
      if (publishCommitted === "tank_snapshot_conflict") {
        const hasRetryBudget =
          optimizerAttempt < maxTankSnapshotPublicationRetries;
        const retryAction = resolveTankSnapshotRetryAction({
          attemptIndex: optimizerAttempt,
          publicationResult: publishCommitted,
          stillOwnsRun: hasRetryBudget ? await stillOwnsHeartbeat() : true,
        });

        if (retryAction === "retry") {
          console.warn(
            "run-heating-optimizer: tank snapshot changed; retrying all optimizer inputs",
            {
              next_attempt: optimizerAttempt + 1,
              run_id: runId,
              tank_snapshot_retry_limit: maxTankSnapshotPublicationRetries,
            },
          );
          continue;
        }
        if (retryAction === "superseded") {
          return jsonResponse(
            {
              decision: decision.status,
              heartbeat_committed: false,
              heartbeat_status: "superseded",
              reason: "heartbeat_superseded",
              run_id: runId,
              wrote_to_heating_plans: false,
            },
            409,
          );
        }

        const retryExhaustedReason =
          "tank_snapshot_conflict_retry_exhausted";
        const failureCommitted = await completeTankRetryExhausted(
          retryExhaustedReason,
        );
        return jsonResponse(
          {
            decision: decision.status,
            heartbeat_committed: failureCommitted,
            heartbeat_status: failureCommitted ? "committed" : "superseded",
            publication_conflict: publishCommitted,
            reason: retryExhaustedReason,
            run_id: runId,
            tank_snapshot_retry_count: optimizerAttempt,
            wrote_to_heating_plans: false,
          },
          409,
        );
      }
      if (
        publishCommitted === "settings_conflict" ||
        publishCommitted === "plan_conflict" ||
        publishCommitted === "relay_conflict" ||
        publishCommitted === "price_snapshot_conflict"
      ) {
        const failureCommitted = await completePublicationFailure(
          `publication_failed: ${publishCommitted}`,
        );
        return jsonResponse(
          {
            decision: decision.status,
            heartbeat_committed: failureCommitted,
            heartbeat_status: failureCommitted ? "committed" : "superseded",
            publication_conflict: publishCommitted,
            reason: publishCommitted,
            run_id: runId,
            wrote_to_heating_plans: false,
          },
          409,
        );
      }
      heartbeatCommitted = publishCommitted === successfulOutcome;
      if (publishCommitted === "heartbeat_superseded" || !heartbeatCommitted) {
        const failureCommitted = await completePublicationFailure(
          "publication_failed: heartbeat ownership lost before safe completion",
        );
        return jsonResponse(
          {
            decision: decision.status,
            heartbeat_committed: failureCommitted,
            heartbeat_status: failureCommitted ? "committed" : "superseded",
            reason: "publication_ownership_lost",
            run_id: runId,
            wrote_to_heating_plans: false,
          },
          409,
        );
      }
      outcome = successfulOutcome;
      wroteToHeatingPlans = hasChangedPlans;
      publishedPlanCount = hasChangedPlans ? decision.changedPlans.length : 0;
    } else {
      const { data: completeHeartbeatCommitted, error: completeHeartbeatError } =
        await supabase.rpc(
          "complete_backend_heating_optimizer_run",
          {
            p_health_status: "unhealthy",
            p_last_outcome: outcome,
            p_reason:
              !publicationReadiness.ok
                ? publicationReadiness.reason
                : typeof heating !== "boolean"
                  ? "relay_status_unknown"
                  : shadowRow.reason,
            p_run_id: runId,
            p_run_started_at: runStartedAt,
            p_validated_plan_at: null,
            p_validated_plan_date: null,
            p_validated_plan_fingerprint: null,
            p_validated_planned_hours: null,
          },
        );
      if (completeHeartbeatError) {
        throw new Error(`Failed to complete optimizer heartbeat: ${completeHeartbeatError.message}`);
      }
      heartbeatCommitted = wasHeartbeatCompareAndSetCommitted(
        completeHeartbeatCommitted,
      );
    }
    if (!heartbeatCommitted) {
      console.warn(
        "run-heating-optimizer: run lost heartbeat ownership before completion",
        { run_id: runId, run_started_at: runStartedAt },
      );
    }

    return jsonResponse({
      decision: decision.status,
      changed_plan_count:
        decision.status === "ready" ? decision.changedPlans.length : 0,
      heartbeat_committed: heartbeatCommitted,
      heartbeat_status: heartbeatCommitted ? "committed" : "superseded",
      last_outcome: outcome,
      optimizer_input_fetch_failures: inputFetchReadiness.failedReasons,
      planned_hours_match: shadowRow.planned_hours_match,
      publication_ready: publicationReadiness.ok,
      publication_ready_reason: publicationReadiness.reason,
      published_plan_count: publishedPlanCount,
      reason: publicationReadiness.ok ? shadowRow.reason : publicationReadiness.reason,
      settings_source: settingsSource,
      tank_snapshot_retry_count: optimizerAttempt,
      today_plan_date: todayPlanDate,
      today_planned_hours: shadowRow.today_planned_hours,
      tomorrow_plan_date: tomorrowPlanDate,
      tomorrow_planned_hours: shadowRow.tomorrow_planned_hours,
      // Diagnostic only (HTTP response body, not a persisted column - see
      // buildHeatingPlanPublicationDecision's own comment): true/false only
      // when decision.status === "ready", so an operator/log reader can
      // tell a genuine "optimizer saw tomorrow's COMPLETE prices and chose
      // 0 h" plan apart from "tomorrow's prices weren't fully in
      // electricity_prices yet (missing entirely or only a partial window),
      // so no tomorrow plan was published this run" without needing a new
      // database column.
      tomorrow_price_data_complete:
        decision.status === "ready" ? decision.tomorrowHasCompletePriceData : null,
      wrote_to_heating_plans: wroteToHeatingPlans,
    });
    }
    throw new Error("Optimizer retry loop exited without a final outcome");
  } catch (error) {
    console.error("run-heating-optimizer failed", error);
    const reason =
      error instanceof Error
        ? error.message
        : "Unexpected run-heating-optimizer error";
    if (completeRunError) {
      await completeRunError(reason);
    }
    return jsonResponse(
      {
        error: reason,
      },
      500,
    );
  }
});

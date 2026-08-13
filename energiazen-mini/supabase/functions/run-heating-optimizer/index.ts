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
  buildExpectedHeatingPlanVersions,
  buildExpectedOptimizerSettingsSnapshot,
  buildOptimizerHours,
  buildShadowRunRow,
  buildStoredPlansMap,
  canMarkHeatingPlanValidated,
  computeNextUnknownHeatingAnchor,
  createHeatingOptimizationSettings,
  fallbackHeatingGainPerHour,
  fetchHeatingGainHistory,
  fetchLatestTemperatureDropProfile,
  getDateKeyOffset,
  getFinnishDateKey,
  getHelsinkiHourNumber,
  latestPriceFetchedAt,
  resolveHourlyDropProfile,
  resolveOptimizerSettings,
  runBackendHeatingOptimization,
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: jsonHeaders, status });
}

Deno.serve(async (request) => {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
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
    // getDateKeyOffset reads the Helsinki calendar date and shifts by whole
    // calendar days - unlike a fixed +24h instant shift, it stays correct
    // across DST transitions (spring-forward/fall-back days are 23h/25h
    // long in real time, so a literal 24h add can land on the wrong
    // Helsinki calendar date). Same helper app/(tabs)/index.tsx uses for
    // today/tomorrow (getChartDayKey, fetchHourlyPrices) - no parallel date
    // logic here.
    const todayPlanDate = getDateKeyOffset(0, now);
    const tomorrowPlanDate = getDateKeyOffset(1, now);
    const priceWindowStartIso = new Date(
      now.getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const gainHistoryStartIso = new Date(
      now.getTime() - heatingGainHistoryDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const recoveryReadingsStartIso = new Date(
      now.getTime() - recoveryReadingsWindowDays * 24 * 60 * 60 * 1000,
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
          "automatic_max_heating_hours,full_tank_average_temperature,full_tank_showers,heating_gain_source,heating_need_mode,max_tank_temperature,min_tank_temperature,safety_shower_reserve,target_shower_reserve,updated_at",
        )
        .eq("id", 1)
        .maybeSingle(),
      fetchHeatingGainHistory(async (from, to) => {
        const { data, error } = await supabase
          .from("tank_readings")
          .select("created_at,top_temp,bottom_temp,inlet_temp,heating")
          .eq("heating", true)
          .gte("created_at", gainHistoryStartIso)
          .lte("created_at", now.toISOString())
          .order("created_at", { ascending: true })
          .range(from, to);

        return { data: (data ?? []) as TankTemperatureReading[], error };
      }).catch((error: unknown) => {
        console.warn("run-heating-optimizer: heating gain history fetch failed", error);
        return { fetchedRowCount: 0, pageCount: 0, readings: [] as TankTemperatureReading[] };
      }),
      fetchHeatingGainHistory(async (from, to) => {
        const { data, error } = await supabase
          .from("tank_readings")
          .select("created_at,top_temp,bottom_temp,inlet_temp,heating")
          .gte("created_at", recoveryReadingsStartIso)
          .order("created_at", { ascending: true })
          .range(from, to);

        return { data: (data ?? []) as TankTemperatureReading[], error };
      }).catch((error: unknown) => {
        console.warn("run-heating-optimizer: recovery readings fetch failed", error);
        return { fetchedRowCount: 0, pageCount: 0, readings: [] as TankTemperatureReading[] };
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
      fetchLatestTemperatureDropProfile(supabase).catch((error: unknown) => {
        console.warn("run-heating-optimizer: temperature drop profile fetch failed", error);
        return null;
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
    const gainHistory = gainHistoryFetch.readings;
    const recoveryReadings = recoveryReadingsFetch.readings;
    const prices = (priceResult.data ?? []) as RawElectricityPriceRow[];
    const heatingPlanRows = (heatingPlansResult.data ?? []) as RawHeatingPlanRow[];
    const appTodayPlan = heatingPlanRows.find((row) => row.plan_date === todayPlanDate) ?? null;

    const {
      heatingGainSource,
      publicationReadiness,
      settings: optimizerSettingsSource,
      settingsSource,
    } = resolveOptimizerSettings(settingsRow);
    const optimizationSettings = createHeatingOptimizationSettings(
      optimizerSettingsSource,
      fallbackHeatingGainPerHour,
    );
    const hours = buildOptimizerHours(prices, now, todayPlanDate, tomorrowPlanDate);
    const dropProfile = resolveHourlyDropProfile({
      localReadings: recoveryReadings,
      now,
      storedProfile: dropProfileResult,
    });
    const heating = latestReading?.heating ?? null;
    const run = runBackendHeatingOptimization({
      heatingGainHistory: gainHistory,
      hourlyDrops: dropProfile.hourlyDrops,
      heatingGainSource,
      hours,
      isCurrentlyHeating: heating === true,
      latestReading,
      now,
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
      now,
      readingCreatedAt: latestReading?.created_at ?? null,
    });
    const decision = buildHeatingPlanPublicationDecision({
      currentHourNumber: getHelsinkiHourNumber(now),
      dateKeyOf: getFinnishDateKey,
      hasAttemptedTankReadingFetch: true,
      heating,
      isTodayPlanLoaded: true,
      now,
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
      now,
      optimizerResult: run.result,
      readinessReason: run.readiness.ok ? null : run.readiness.reason,
      settingsSource,
      tankReadingAt: latestReading?.created_at ?? null,
      todayPlanDate,
      tomorrowPlanDate,
    });

    const { error: insertError } = await supabase
      .from("heating_plan_shadow_runs")
      .insert(shadowRow);

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
    const invalidOutcome = canValidateNoChanges
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
      const successfulOutcome = hasChangedPlans ? "published" : "no_changes";
      const { data: publishCommitted, error: publishError } = await supabase.rpc(
        "publish_backend_heating_optimizer_plans",
        {
          p_changed_plans: decision.changedPlans,
          p_expected_plan_versions: expectedPlanVersions,
          p_expected_settings: expectedSettings,
          p_publish_reason: hasChangedPlans ? "valid plan published" : shadowRow.reason,
          p_published_at: now.toISOString(),
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
      if (publishCommitted === "settings_conflict" || publishCommitted === "plan_conflict") {
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
              typeof heating !== "boolean"
                ? "relay_status_unknown"
                : publicationReadiness.ok
                  ? shadowRow.reason
                  : publicationReadiness.reason,
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
      planned_hours_match: shadowRow.planned_hours_match,
      publication_ready: publicationReadiness.ok,
      publication_ready_reason: publicationReadiness.reason,
      published_plan_count: publishedPlanCount,
      reason: publicationReadiness.ok ? shadowRow.reason : publicationReadiness.reason,
      settings_source: settingsSource,
      today_plan_date: todayPlanDate,
      today_planned_hours: shadowRow.today_planned_hours,
      tomorrow_plan_date: tomorrowPlanDate,
      tomorrow_planned_hours: shadowRow.tomorrow_planned_hours,
      wrote_to_heating_plans: wroteToHeatingPlans,
    });
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

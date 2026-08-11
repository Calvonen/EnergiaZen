// EnergyZen backend heating-optimizer SHADOW MODE.
//
// Runs the exact same optimizeHeatingPlan() the React Native app runs,
// using production Supabase price/tank/settings data, and writes the
// result to heating_plan_shadow_runs for comparison. Deliberately does NOT
// write to heating_plans - Shelly/ESP keeps reading only what the app
// publishes there until a separate, explicitly-approved change makes this
// function (or another one) the primary writer. See this PR's report for
// the phased plan to get there.
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
  buildOptimizerHours,
  buildShadowRunRow,
  buildStoredPlansMap,
  computeNextUnknownHeatingAnchor,
  createHeatingOptimizationSettings,
  fallbackHeatingGainPerHour,
  fetchLatestTemperatureDropProfile,
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
} from "./logic.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const electricityPriceRegion = "FI";
const heatingGainHistoryDays = 30;
const recoveryReadingsWindowDays = 7;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: jsonHeaders, status });
}

// yyyy-mm-dd for a UTC instant shifted by offsetDays, read in Europe/Helsinki.
function helsinkiDateKey(date: Date, offsetDays: number): string {
  const shifted = new Date(date.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(shifted);
}

Deno.serve(async (request) => {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

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
    const todayPlanDate = helsinkiDateKey(now, 0);
    const tomorrowPlanDate = helsinkiDateKey(now, 1);
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
          "full_tank_average_temperature,full_tank_showers,max_tank_temperature,min_tank_temperature,target_shower_reserve",
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
        .select("starts_at,ends_at,spot_price_cents_kwh,fetched_at")
        .eq("region", electricityPriceRegion)
        .gte("starts_at", priceWindowStartIso)
        .order("starts_at", { ascending: true }),
      supabase
        .from("heating_plans")
        .select("plan_date,planned_hours,mode,target_hours")
        .in("plan_date", [todayPlanDate, tomorrowPlanDate]),
      fetchLatestTemperatureDropProfile(supabase).catch((error: unknown) => {
        console.warn("run-heating-optimizer: temperature drop profile fetch failed", error);
        return null;
      }),
    ]);

    if (latestReadingResult.error) {
      return jsonResponse(
        { error: "Failed to fetch latest tank reading", message: latestReadingResult.error.message },
        502,
      );
    }
    if (settingsResult.error) {
      return jsonResponse(
        { error: "Failed to fetch heating_control_settings", message: settingsResult.error.message },
        502,
      );
    }
    if (priceResult.error) {
      return jsonResponse(
        { error: "Failed to fetch electricity_prices", message: priceResult.error.message },
        502,
      );
    }
    if (heatingPlansResult.error) {
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

    const { settings: optimizerSettingsSource, settingsSource } =
      resolveOptimizerSettings(settingsRow);
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
      return jsonResponse(
        { error: "Failed to save shadow run", message: insertError.message },
        500,
      );
    }

    return jsonResponse({
      decision: decision.status,
      planned_hours_match: shadowRow.planned_hours_match,
      reason: shadowRow.reason,
      settings_source: settingsSource,
      today_plan_date: todayPlanDate,
      today_planned_hours: shadowRow.today_planned_hours,
      tomorrow_plan_date: tomorrowPlanDate,
      tomorrow_planned_hours: shadowRow.tomorrow_planned_hours,
      wrote_to_heating_plans: false,
    });
  } catch (error) {
    console.error("run-heating-optimizer failed", error);
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unexpected run-heating-optimizer error",
      },
      500,
    );
  }
});

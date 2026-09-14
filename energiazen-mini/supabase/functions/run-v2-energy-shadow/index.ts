import { createClient } from "npm:@supabase/supabase-js@2";

import {
  runLiveReserveShadow,
  type ReliableWaterDraw,
  type ShadowTankReading,
  type V1ShadowSnapshot,
} from "./logic.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const replayWindowHours = 6;
const pageSize = 1000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: jsonHeaders, status });
}

Deno.serve(async (request) => {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const expectedSecret = Deno.env.get("HEATING_OPTIMIZER_CRON_SECRET");
  const suppliedSecret = request.headers.get("x-energyzen-cron-secret");
  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase runtime configuration" }, 500);
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const now = new Date();
    const replayStart = new Date(now.getTime() - replayWindowHours * 60 * 60 * 1000);
    const readings = await fetchTankReadings(supabase, replayStart.toISOString(), now.toISOString());

    const [drawsResult, v1Result] = await Promise.all([
      supabase
        .from("water_draw_labels")
        .select(
          "event_started_at,event_ended_at,estimated_water_draw_net_energy_kwh,energy_reliable,energy_quality_reason",
        )
        .gte("event_ended_at", replayStart.toISOString())
        .lte("event_started_at", now.toISOString())
        .order("event_started_at", { ascending: true }),
      supabase
        .from("heating_plan_shadow_runs")
        .select("id,run_at,target_hours")
        .gte("run_at", new Date(now.getTime() - 15 * 60 * 1000).toISOString())
        .order("run_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (drawsResult.error) {
      throw new Error(`Failed to fetch water draw labels: ${drawsResult.error.message}`);
    }
    if (v1Result.error) {
      throw new Error(`Failed to fetch V1 shadow snapshot: ${v1Result.error.message}`);
    }

    const v1Shadow = (v1Result.data ?? null) as V1ShadowSnapshot | null;
    const result = runLiveReserveShadow({
      now,
      readings,
      reliableDraws: (drawsResult.data ?? []) as ReliableWaterDraw[],
      v1Shadow,
    });

    const latestReadingAt = readings.length > 0 ? readings[readings.length - 1].created_at : null;
    const { error: insertError } = await supabase.from("v2_energy_reserve_shadow_runs").insert({
      run_at: now.toISOString(),
      replay_start_at: replayStart.toISOString(),
      replay_end_at: now.toISOString(),
      latest_tank_reading_at: latestReadingAt,
      reading_count: result.readingCount,
      reliable_draw_count: result.reliableDrawCount,
      unresolved_draw_detected: result.unresolvedDrawDetected,
      available: result.available,
      unavailable_reason: result.reason,
      remaining_energy_kwh: result.remainingEnergyKwh,
      observed_energy_kwh: result.observedEnergyKwh,
      sensor_gap_kwh: result.sensorGapKwh,
      balance_uncertainty_kwh: result.balanceUncertaintyKwh,
      conservative_energy_kwh: result.conservativeEnergyKwh,
      safety_energy_kwh: result.safetyEnergyKwh,
      target_energy_kwh: result.targetEnergyKwh,
      v2_band: result.v2Band,
      v2_needs_energy_recovery: result.v2NeedsEnergyRecovery,
      v1_shadow_run_id: v1Shadow?.id ?? null,
      v1_run_at: v1Shadow?.run_at ?? null,
      v1_target_hours: v1Shadow?.target_hours ?? null,
      v1_needs_energy_recovery: result.v1NeedsEnergyRecovery,
      comparison: result.comparison,
      source: "v2_energy_reserve_live_shadow",
    });

    if (insertError) {
      throw new Error(`Failed to persist V2 energy shadow: ${insertError.message}`);
    }

    return jsonResponse({
      status: "ok",
      available: result.available,
      comparison: result.comparison,
      remaining_energy_kwh: result.remainingEnergyKwh,
      conservative_energy_kwh: result.conservativeEnergyKwh,
      v2_band: result.v2Band,
      v2_needs_energy_recovery: result.v2NeedsEnergyRecovery,
      v1_needs_energy_recovery: result.v1NeedsEnergyRecovery,
      reason: result.reason,
    });
  } catch (error) {
    console.error("run-v2-energy-shadow failed", error);
    return jsonResponse(
      { error: "V2 energy shadow failed", message: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});

async function fetchTankReadings(
  supabase: ReturnType<typeof createClient>,
  startIso: string,
  endIso: string,
): Promise<ShadowTankReading[]> {
  const rows: ShadowTankReading[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("tank_readings")
      .select("created_at,top_temp,bottom_temp,inlet_temp,heating")
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Failed to fetch tank readings: ${error.message}`);
    }

    const page = (data ?? []) as ShadowTankReading[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  return rows;
}

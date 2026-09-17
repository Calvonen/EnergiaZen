import { createClient } from "npm:@supabase/supabase-js@2";

import {
  applyReserveThresholds,
  deriveUsableReadingInletBaselineC,
  liveReserveShadowConfig,
  runLiveReserveShadow,
  type ReliableWaterDraw,
  type ShadowTankReading,
  type V1ShadowSnapshot,
} from "./logic.ts";
import { runLiveEnergyPlanShadow, type ShadowElectricityPrice } from "./planShadow.ts";
import { buildV2MarginalPreheatAdvisory } from "./preheatMarginalAdvisory.ts";
import { buildV2PriceCeilingSettingTelemetry } from "./priceCeilingSetting.ts";
import {
  resolveV2HeatingConstraints,
  type ShadowStoredHeatingPlan,
} from "./productionConstraints.ts";
import { captureV2PublicationCandidate, evaluateV2PublicationGuard } from "./publicationGuard.ts";
import { buildV2StagedPublicationArgs, type StoredStagedPlanVersion } from "./stagedPublication.ts";
import { sensorGeometryV2 } from "../_shared/energyModelV2/sensorGeometry.ts";
import {
  calculateV2EnergyCapacityKwh,
  normalizeV2ReservePercents,
  reservePercentToKwh,
} from "../_shared/energyModelV2/energyReservePercent.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const replayWindowHours = 6;
const priceFetchWindowHours = 48;
const pageSize = 1000;
const activeBlockSafetyTopTemperatureC = 50;
const v2StagedPublicationEnabled = true;
const v2PublicationCutoverEnabled = false;
const helsinkiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit", month: "2-digit", timeZone: "Europe/Helsinki", year: "numeric",
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: jsonHeaders, status });
}

Deno.serve(async (request) => {
  if (request.method !== "GET" && request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const expectedSecret = Deno.env.get("HEATING_OPTIMIZER_CRON_SECRET");
  const suppliedSecret = request.headers.get("x-energyzen-cron-secret");
  if (!expectedSecret || suppliedSecret !== expectedSecret) return jsonResponse({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Missing Supabase runtime configuration" }, 500);

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const now = new Date();
    const replayStart = new Date(now.getTime() - replayWindowHours * 3_600_000);
    const priceFetchEnd = new Date(now.getTime() + priceFetchWindowHours * 3_600_000);
    const [readings, draws] = await Promise.all([
      fetchTankReadings(supabase, replayStart.toISOString(), now.toISOString()),
      fetchWaterDraws(supabase, replayStart.toISOString(), now.toISOString()),
    ]);
    const today = helsinkiDateKey(now);
    const tomorrow = helsinkiDateKeyOffset(now, 1);

    const [v1Result, settingsResult, pricesResult, heatingPlansResult, stagedVersionsResult] = await Promise.all([
      supabase.from("heating_plan_shadow_runs").select("id,run_at,target_hours")
        .gte("run_at", new Date(now.getTime() - 15 * 60_000).toISOString())
        .order("run_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("heating_control_settings")
        .select("max_tank_temperature,automatic_max_heating_hours,v2_target_reserve_percent,v2_safety_reserve_percent,v2_max_billed_price_cents_kwh")
        .eq("id", 1).maybeSingle(),
      supabase.from("electricity_prices")
        .select("starts_at,ends_at,spot_price_cents_kwh,resolution_minutes")
        .eq("region", "FI").eq("resolution_minutes", 60).gt("ends_at", now.toISOString())
        .lte("starts_at", priceFetchEnd.toISOString()).order("starts_at", { ascending: true }),
      supabase.from("heating_plans").select("plan_date,planned_hours,mode")
        .in("plan_date", [today, tomorrow]),
      supabase.from("v2_heating_plan_publications").select("plan_date,updated_at")
        .in("plan_date", [today, tomorrow]),
    ]);

    if (v1Result.error) throw new Error(`Failed to fetch V1 shadow snapshot: ${v1Result.error.message}`);
    if (settingsResult.error) throw new Error(`Failed to fetch heating settings: ${settingsResult.error.message}`);
    if (pricesResult.error) throw new Error(`Failed to fetch electricity prices: ${pricesResult.error.message}`);
    if (heatingPlansResult.error) throw new Error(`Failed to fetch heating plans: ${heatingPlansResult.error.message}`);
    if (stagedVersionsResult.error) throw new Error(`Failed to fetch V2 staged plan versions: ${stagedVersionsResult.error.message}`);
    if (!settingsResult.data) throw new Error("Heating settings row is missing");

    const v1Shadow = (v1Result.data ?? null) as V1ShadowSnapshot | null;
    const prices = (pricesResult.data ?? []) as ShadowElectricityPrice[];
    const storedPlans = (heatingPlansResult.data ?? []) as ShadowStoredHeatingPlan[];
    const storedStagedVersions = (stagedVersionsResult.data ?? []) as StoredStagedPlanVersion[];
    const maxTankTemperatureC = Number(settingsResult.data.max_tank_temperature);
    const automaticMaxHeatingHours = Number(settingsResult.data.automatic_max_heating_hours);
    const reservePercents = normalizeV2ReservePercents({
      targetPercent: Number(settingsResult.data.v2_target_reserve_percent),
      safetyPercent: Number(settingsResult.data.v2_safety_reserve_percent),
    });
    const priceCeilingSetting = buildV2PriceCeilingSettingTelemetry(
      settingsResult.data.v2_max_billed_price_cents_kwh,
    );

    const inletBaselineC = deriveUsableReadingInletBaselineC(readings) ?? Number.NaN;
    const energyCapacityKwh = calculateV2EnergyCapacityKwh({
      inletTemperatureC: inletBaselineC,
      maxTankTemperatureC,
      tankVolumeLiters: sensorGeometryV2.tank.nominalVolumeLiters,
    });
    const targetEnergyKwh = energyCapacityKwh === null ? null : reservePercentToKwh(reservePercents.targetPercent, energyCapacityKwh);
    const safetyEnergyKwh = energyCapacityKwh === null ? null : reservePercentToKwh(reservePercents.safetyPercent, energyCapacityKwh);

    const baseResult = runLiveReserveShadow({
      maxTankTemperatureC,
      now,
      readings,
      reliableDraws: draws,
      v1Shadow: null,
    });
    const result = applyReserveThresholds(baseResult, safetyEnergyKwh, targetEnergyKwh);
    const constraints = resolveV2HeatingConstraints({
      now,
      priceHourIds: prices.map((price) => price.starts_at),
      readings,
      safetyTopTemperatureC: activeBlockSafetyTopTemperatureC,
      storedPlans,
    });
    const plan = runLiveEnergyPlanShadow({
      automaticMaxHeatingHours,
      constraints,
      energyCapacityKwh: energyCapacityKwh ?? Number.NaN,
      inletBaselineC,
      maxTankTemperatureC,
      now,
      prices,
      reserve: result,
    });
    const preheatAdvisory = buildV2MarginalPreheatAdvisory({
      baselinePlan: plan,
      conservativeEnergyKwh: result.conservativeEnergyKwh ?? Number.NaN,
      constraints,
      energyCapacityKwh: energyCapacityKwh ?? Number.NaN,
      heaterPowerKw: liveReserveShadowConfig.heaterPowerKw,
      maxPreheatHours: automaticMaxHeatingHours,
      now,
      prices,
      remainingEnergyKwh: result.remainingEnergyKwh ?? Number.NaN,
    });

    const latestRawReadingAt = readings.length ? readings[readings.length - 1].created_at : null;
    const latestUsableReadingAt = deriveLatestUsableReadingAt(readings);
    const latestPublishableReadingAt = deriveLatestPublishableReadingAt(readings);
    const publicationCandidate = captureV2PublicationCandidate(plan);
    const stagedPublicationReadiness = evaluateV2PublicationGuard({
      enabled: v2StagedPublicationEnabled,
      latestTankReadingAt: latestPublishableReadingAt,
      now,
      plan,
      publicationCandidate,
    });
    const cutoverPublicationReadiness = evaluateV2PublicationGuard({
      enabled: v2PublicationCutoverEnabled,
      latestTankReadingAt: latestPublishableReadingAt,
      now,
      plan,
      publicationCandidate,
    });

    let stagedPublicationResult: string | null = null;
    if (stagedPublicationReadiness.ready && latestPublishableReadingAt) {
      const rpcArgs = buildV2StagedPublicationArgs({
        candidate: publicationCandidate,
        constraintPlans: storedPlans,
        draws,
        latestUsableReadingAt: latestPublishableReadingAt,
        now,
        plan,
        prices,
        priceFetchEnd,
        readings,
        replayStart,
        settings: {
          max_tank_temperature: Number(settingsResult.data.max_tank_temperature),
          automatic_max_heating_hours: Number(settingsResult.data.automatic_max_heating_hours),
          v2_target_reserve_percent: Number(settingsResult.data.v2_target_reserve_percent),
          v2_safety_reserve_percent: Number(settingsResult.data.v2_safety_reserve_percent),
        },
        storedStagedVersions,
        today,
        tomorrow,
      });
      const { data: publishResult, error: publishError } = await supabase.rpc("publish_v2_heating_plans_staged", rpcArgs);
      if (publishError) throw new Error(`Failed to publish V2 staged plan: ${publishError.message}`);
      stagedPublicationResult = typeof publishResult === "string" ? publishResult : String(publishResult);
      if (stagedPublicationResult !== "published") console.warn("V2 staged publication rejected", stagedPublicationResult);
    }

    const { error: insertError } = await supabase.from("v2_energy_reserve_shadow_runs").insert({
      run_at: now.toISOString(), replay_start_at: replayStart.toISOString(), replay_end_at: now.toISOString(),
      latest_tank_reading_at: latestRawReadingAt, reading_count: result.readingCount,
      reliable_draw_count: result.reliableDrawCount, unresolved_draw_detected: result.unresolvedDrawDetected,
      available: result.available, unavailable_reason: result.reason,
      remaining_energy_kwh: result.remainingEnergyKwh, observed_energy_kwh: result.observedEnergyKwh,
      sensor_gap_kwh: result.sensorGapKwh, balance_uncertainty_kwh: result.balanceUncertaintyKwh,
      heater_delivery_uncertainty_kwh: result.heaterDeliveryUncertaintyKwh,
      heater_credit_guard_top_temp_c: result.heaterCreditGuardTopTempC,
      conservative_energy_kwh: result.conservativeEnergyKwh, energy_capacity_kwh: energyCapacityKwh,
      safety_reserve_percent: reservePercents.safetyPercent, target_reserve_percent: reservePercents.targetPercent,
      safety_energy_kwh: result.safetyEnergyKwh, target_energy_kwh: result.targetEnergyKwh,
      v2_band: result.v2Band, v2_needs_energy_recovery: result.v2NeedsEnergyRecovery,
      v1_shadow_run_id: v1Shadow?.id ?? null, v1_run_at: v1Shadow?.run_at ?? null,
      v1_target_hours: v1Shadow?.target_hours ?? null, v1_needs_energy_recovery: null,
      comparison: "v1_unavailable", plan_available: plan.available, plan_valid: plan.valid,
      plan_unavailable_reason: plan.available ? null : plan.reason, plan_assumption: plan.assumption,
      forecast_horizon_end_at: plan.forecastHorizonEndAt,
      forecast_standing_loss_kwh_per_hour: plan.standingLossKwhPerHour,
      forecast_final_conservative_energy_kwh: plan.finalConservativeEnergyKwh,
      forecast_min_conservative_energy_kwh: plan.minimumConservativeEnergyKwh,
      forecast_first_target_miss_at: plan.firstTargetMissAt,
      forecast_first_safety_violation_at: plan.firstSafetyViolationAt,
      plan_selected_heating_hour_ids: plan.selectedHeatingHourIds,
      plan_selected_heating_energy_kwh: plan.selectedHeatingEnergyKwh,
      plan_total_cost_cents: plan.totalCostCents, plan_candidate_count: plan.candidateCount,
      plan_evaluated_combination_count: plan.evaluatedCombinationCount,
      preheat_advisory: preheatAdvisory,
      source: "v2_energy_reserve_live_shadow",
    });
    if (insertError) throw new Error(`Failed to persist V2 energy shadow: ${insertError.message}`);

    return jsonResponse({
      status: "ok", available: result.available, comparison: "v1_unavailable",
      energy_capacity_kwh: energyCapacityKwh, safety_reserve_percent: reservePercents.safetyPercent,
      target_reserve_percent: reservePercents.targetPercent, safety_energy_kwh: result.safetyEnergyKwh,
      target_energy_kwh: result.targetEnergyKwh, remaining_energy_kwh: result.remainingEnergyKwh,
      conservative_energy_kwh: result.conservativeEnergyKwh,
      heater_delivery_uncertainty_kwh: result.heaterDeliveryUncertaintyKwh,
      heater_credit_guard_top_temp_c: result.heaterCreditGuardTopTempC,
      v2_band: result.v2Band, v2_needs_energy_recovery: result.v2NeedsEnergyRecovery,
      v1_needs_energy_recovery: null, reason: result.reason, plan_available: plan.available,
      plan_valid: plan.valid, plan_reason: plan.reason,
      plan_required_heating_hour_ids: constraints.requiredHeatingHourIds,
      plan_forbidden_heating_hour_ids: constraints.forbiddenHeatingHourIds,
      plan_selected_heating_hour_ids: plan.selectedHeatingHourIds,
      plan_selected_heating_energy_kwh: plan.selectedHeatingEnergyKwh,
      plan_total_cost_cents: plan.totalCostCents, forecast_horizon_end_at: plan.forecastHorizonEndAt,
      forecast_final_conservative_energy_kwh: plan.finalConservativeEnergyKwh,
      forecast_min_conservative_energy_kwh: plan.minimumConservativeEnergyKwh,
      preheat_advisory: preheatAdvisory,
      price_ceiling_setting: priceCeilingSetting,
      staged_publication_enabled: v2StagedPublicationEnabled,
      staged_publication_ready: stagedPublicationReadiness.ready,
      staged_publication_ready_reason: stagedPublicationReadiness.reason,
      staged_publication_result: stagedPublicationResult,
      publication_cutover_enabled: v2PublicationCutoverEnabled,
      publication_ready: cutoverPublicationReadiness.ready,
      publication_ready_reason: cutoverPublicationReadiness.reason,
      publication_latest_usable_tank_reading_at: latestUsableReadingAt,
      publication_latest_publishable_tank_reading_at: latestPublishableReadingAt,
      wrote_to_heating_plans: false,
    });
  } catch (error) {
    console.error("run-v2-energy-shadow failed", error);
    return jsonResponse({ error: "V2 energy shadow failed", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});

async function fetchTankReadings(supabase: ReturnType<typeof createClient>, startIso: string, endIso: string): Promise<ShadowTankReading[]> {
  const rows: ShadowTankReading[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from("tank_readings")
      .select("created_at,top_temp,bottom_temp,inlet_temp,heating")
      .gte("created_at", startIso).lte("created_at", endIso)
      .order("created_at", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`Failed to fetch tank readings: ${error.message}`);
    const page = (data ?? []) as ShadowTankReading[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchWaterDraws(supabase: ReturnType<typeof createClient>, startIso: string, endIso: string): Promise<ReliableWaterDraw[]> {
  const rows: ReliableWaterDraw[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from("water_draw_labels")
      .select("event_started_at,event_ended_at,estimated_water_draw_net_energy_kwh,energy_reliable,energy_quality_reason")
      .gte("event_ended_at", startIso).lte("event_started_at", endIso)
      .order("event_started_at", { ascending: true }).order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Failed to fetch water draw labels: ${error.message}`);
    const page = (data ?? []) as ReliableWaterDraw[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

export function deriveLatestUsableReadingAt(readings: ShadowTankReading[]) {
  return deriveLatestReadingAt(readings, false);
}

export function deriveLatestPublishableReadingAt(readings: ShadowTankReading[]) {
  return deriveLatestReadingAt(readings, true);
}

function deriveLatestReadingAt(readings: ShadowTankReading[], requireRelayState: boolean) {
  let latestAt: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const reading of readings) {
    const createdMs = Date.parse(reading.created_at);
    if (
      Number.isFinite(createdMs) &&
      Number.isFinite(reading.top_temp) &&
      Number.isFinite(reading.bottom_temp) &&
      Number.isFinite(reading.inlet_temp) &&
      (!requireRelayState || typeof reading.heating === "boolean") &&
      createdMs > latestMs
    ) {
      latestMs = createdMs;
      latestAt = reading.created_at;
    }
  }
  return latestAt;
}

function helsinkiDateKey(date: Date) {
  const parts = helsinkiDateFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function helsinkiDateKeyOffset(date: Date, offset: number) {
  const [year, month, day] = helsinkiDateKey(date).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return "";
  return helsinkiDateKey(new Date(Date.UTC(year, month - 1, day + offset, 12)));
}

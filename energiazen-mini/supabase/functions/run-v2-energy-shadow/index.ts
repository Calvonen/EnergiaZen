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
import {
  parseLearnedTemperatureDropProfile,
  type LearnedTemperatureDropProfileRow,
} from "./learnedDropProfile.ts";
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

    const [v1Result, settingsResult, pricesResult, heatingPlansResult, stagedVersionsResult, controlPlaneStateResult, temperatureDropProfileResult, coldInletBaselineResult] = await Promise.all([
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
      supabase.rpc("get_heating_control_plane_state"),
      supabase.from("temperature_drop_profiles")
        .select("id,profile_date,timezone,source_start,source_end,source_days,hourly_drops,observation_days_by_hour,general_fallback,hourly_energy_losses_kwh,general_energy_loss_kwh,algorithm_version,created_at")
        .eq("timezone", "Europe/Helsinki")
        .order("profile_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.rpc("get_confirmed_cold_inlet_baseline", {
        p_since: new Date(now.getTime() - 56 * 24 * 3_600_000).toISOString(),
        p_until: now.toISOString(),
      }),
    ]);

    if (v1Result.error) throw new Error(`Failed to fetch V1 shadow snapshot: ${v1Result.error.message}`);
    if (settingsResult.error) throw new Error(`Failed to fetch heating settings: ${settingsResult.error.message}`);
    if (pricesResult.error) throw new Error(`Failed to fetch electricity prices: ${pricesResult.error.message}`);
    if (heatingPlansResult.error) throw new Error(`Failed to fetch heating plans: ${heatingPlansResult.error.message}`);
    if (stagedVersionsResult.error) throw new Error(`Failed to fetch V2 staged plan versions: ${stagedVersionsResult.error.message}`);
    if (controlPlaneStateResult.error) throw new Error(`Failed to resolve heating control-plane state: ${controlPlaneStateResult.error.message}`);
    if (temperatureDropProfileResult.error) throw new Error(`Failed to fetch learned temperature drop profile: ${temperatureDropProfileResult.error.message}`);
    if (coldInletBaselineResult.error) throw new Error(`Failed to fetch confirmed cold inlet baseline: ${coldInletBaselineResult.error.message}`);
    if (!settingsResult.data) throw new Error("Heating settings row is missing");

    const v1Shadow = (v1Result.data ?? null) as V1ShadowSnapshot | null;
    const prices = (pricesResult.data ?? []) as ShadowElectricityPrice[];
    const storedPlans = (heatingPlansResult.data ?? []) as ShadowStoredHeatingPlan[];
    const storedStagedVersions = (stagedVersionsResult.data ?? []) as StoredStagedPlanVersion[];
    const learnedDropProfile = temperatureDropProfileResult.data
      ? parseLearnedTemperatureDropProfile(
          temperatureDropProfileResult.data as unknown as LearnedTemperatureDropProfileRow,
        )
      : null;
    if (temperatureDropProfileResult.data && !learnedDropProfile) {
      throw new Error("Latest learned temperature drop profile is invalid");
    }
    const controlPlaneState =
      controlPlaneStateResult.data && typeof controlPlaneStateResult.data === "object" && !Array.isArray(controlPlaneStateResult.data)
        ? controlPlaneStateResult.data as {
            heating_need_mode?: unknown;
            v2_mirror_trigger_active?: unknown;
            v1_optimizer_cron_active?: unknown;
            v2_producer_cron_active?: unknown;
            owner?: unknown;
            healthy?: unknown;
          }
        : null;
    if (
      !controlPlaneState ||
      typeof controlPlaneState.v2_mirror_trigger_active !== "boolean" ||
      typeof controlPlaneState.v1_optimizer_cron_active !== "boolean" ||
      typeof controlPlaneState.v2_producer_cron_active !== "boolean" ||
      typeof controlPlaneState.owner !== "string" ||
      typeof controlPlaneState.healthy !== "boolean"
    ) {
      throw new Error("Heating control-plane state payload is invalid");
    }
    let v2PublicationCutoverEnabled = controlPlaneState.v2_mirror_trigger_active;
    const maxTankTemperatureC = Number(settingsResult.data.max_tank_temperature);
    const automaticMaxHeatingHours = Number(settingsResult.data.automatic_max_heating_hours);
    const reservePercents = normalizeV2ReservePercents({
      targetPercent: Number(settingsResult.data.v2_target_reserve_percent),
      safetyPercent: Number(settingsResult.data.v2_safety_reserve_percent),
    });
    const recommendedPreheatPercent = reservePercents.targetPercent;
    // The ordered reserve-threshold model now represents hard safety only.
    // Keep its target equal to the safety floor and carry the configurable
    // economic preheat recommendation separately into advisory telemetry.
    const hardTargetPercent = reservePercents.safetyPercent;
    const priceCeilingSetting = buildV2PriceCeilingSettingTelemetry(
      settingsResult.data.v2_max_billed_price_cents_kwh,
    );

    const inletBaselineC = deriveUsableReadingInletBaselineC(readings) ?? Number.NaN;
    const energyCapacityKwh = calculateV2EnergyCapacityKwh({
      inletTemperatureC: inletBaselineC,
      maxTankTemperatureC,
      tankVolumeLiters: sensorGeometryV2.tank.nominalVolumeLiters,
    });
    const targetEnergyKwh = energyCapacityKwh === null ? null : reservePercentToKwh(hardTargetPercent, energyCapacityKwh);
    const safetyEnergyKwh = energyCapacityKwh === null ? null : reservePercentToKwh(reservePercents.safetyPercent, energyCapacityKwh);

    const baseResult = runLiveReserveShadow({
      coldInletDrawBaselineC:
        typeof coldInletBaselineResult.data === "number"
          ? coldInletBaselineResult.data
          : null,
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
      learnedDropProfile,
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
      recommendedPreheatPercent,
      remainingEnergyKwh: result.remainingEnergyKwh ?? Number.NaN,
      evaluateHourSelection: (selectedHourIds) => {
        const selected = new Set(selectedHourIds);
        return runLiveEnergyPlanShadow({
          automaticMaxHeatingHours,
          constraints: {
            requiredHeatingHourIds: selectedHourIds,
            forbiddenHeatingHourIds: prices
              .map((price) => price.starts_at)
              .filter((hourId) => !selected.has(hourId)),
          },
          energyCapacityKwh: energyCapacityKwh ?? Number.NaN,
          inletBaselineC,
          maxTankTemperatureC,
          now,
          prices,
          reserve: result,
          learnedDropProfile,
        });
      },
    });

    const publicationSelectedHeatingHourIds = (() => {
      if (!preheatAdvisory.available || preheatAdvisory.reason !== "recommended") {
        return [...plan.selectedHeatingHourIds];
      }

      const actuallyDisplacedBaselineHourIds = new Set(
        preheatAdvisory.strategy === "marginal_displacement" && preheatAdvisory.marginalCost.available
          ? preheatAdvisory.marginalCost.pairs.map((pair) => pair.displacedFutureHourId)
          : [],
      );
      const preservedBaselineHourIds = plan.selectedHeatingHourIds.filter(
        (hourId) => !actuallyDisplacedBaselineHourIds.has(hourId),
      );

      return [...new Set([
        ...preservedBaselineHourIds,
        ...preheatAdvisory.recommendedPreheatHourIds,
      ])].sort((left, right) => Date.parse(left) - Date.parse(right));
    })();

    // Re-run the forecast with the exact composed publication hours forced as
    // required and every other priced hour forbidden. This makes validation,
    // persisted shadow telemetry, Home forecast and the staged candidate all
    // describe the same plan instead of mixing the safety baseline forecast
    // with a different advisory-composed publication schedule.
    const publicationHourIdSet = new Set(publicationSelectedHeatingHourIds);
    const publicationPlan = runLiveEnergyPlanShadow({
      automaticMaxHeatingHours,
      constraints: {
        requiredHeatingHourIds: publicationSelectedHeatingHourIds,
        forbiddenHeatingHourIds: prices
          .map((price) => price.starts_at)
          .filter((hourId) => !publicationHourIdSet.has(hourId)),
      },
      energyCapacityKwh: energyCapacityKwh ?? Number.NaN,
      inletBaselineC,
      maxTankTemperatureC,
      now,
      prices,
      reserve: result,
      learnedDropProfile,
    });

    const latestRawReadingAt = readings.length ? readings[readings.length - 1].created_at : null;
    const latestUsableReadingAt = deriveLatestUsableReadingAt(readings);
    const latestPublishableReadingAt = deriveLatestPublishableReadingAt(readings);
    // Staged publication composes the validated hard-safety baseline with the
    // economic preheat advisory. Only baseline hours that the advisory actually
    // pairs for displacement may be removed; every unmatched safety hour is
    // preserved. Production cutover remains disabled here.
    const publicationCandidate = captureV2PublicationCandidate(
      publicationPlan,
      publicationSelectedHeatingHourIds,
    );
    const stagedPublicationReadiness = evaluateV2PublicationGuard({
      enabled: v2StagedPublicationEnabled,
      expectedSelectedHeatingHourIds: publicationSelectedHeatingHourIds,
      latestTankReadingAt: latestPublishableReadingAt,
      now,
      plan: publicationPlan,
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
        plan: publicationPlan,
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
        temperatureDropProfile: learnedDropProfile,
        today,
        tomorrow,
      });
      const { data: publishOutcome, error: publishError } = await supabase.rpc(
        "publish_v2_heating_plans_staged_with_cutover_state",
        rpcArgs,
      );
      if (publishError) throw new Error(`Failed to publish V2 staged plan: ${publishError.message}`);

      const outcome = publishOutcome && typeof publishOutcome === "object" && !Array.isArray(publishOutcome)
        ? publishOutcome as { result?: unknown; cutover_enabled?: unknown }
        : null;
      stagedPublicationResult = typeof outcome?.result === "string"
        ? outcome.result
        : String(outcome?.result ?? "");
      if (typeof outcome?.cutover_enabled !== "boolean") {
        throw new Error("V2 staged publication did not return cutover state");
      }
      // The wrapper reads the trigger state in the same DB transaction after
      // publication. The inner publication lock remains held until transaction
      // end, so this value describes the control-plane state of this publication
      // rather than an earlier snapshot.
      v2PublicationCutoverEnabled = outcome.cutover_enabled;
      if (stagedPublicationResult !== "published") console.warn("V2 staged publication rejected", stagedPublicationResult);
    }

    const cutoverPublicationReadiness = evaluateV2PublicationGuard({
      enabled: v2PublicationCutoverEnabled,
      expectedSelectedHeatingHourIds: publicationSelectedHeatingHourIds,
      latestTankReadingAt: latestPublishableReadingAt,
      now,
      plan: publicationPlan,
      publicationCandidate,
    });

    // Once V2 owns automatic production, a later reserve/plan-unavailable run
    // must invalidate Shelly's trust in an older validated plan. Otherwise a
    // previously healthy empty (or otherwise stale) plan can remain trusted for
    // MAX_BACKEND_VALIDATION_AGE_SECONDS even though V2 has just lost the
    // physical state needed to validate it. Preserve the last validated plan
    // fields for diagnostics/recovery, but mark the control plane unhealthy
    // with a non-optimizer_invalid outcome so Shelly's existing trust logic
    // debounces into backup_hours instead of continuing to execute the old plan.
    if (
      v2PublicationCutoverEnabled &&
      controlPlaneState.heating_need_mode === "automatic" &&
      (!result.available || !publicationPlan.available)
    ) {
      const unavailableReason =
        result.reason ??
        publicationPlan.reason ??
        "plan_unavailable";
      const { error: heartbeatError } = await supabase
        .from("backend_heating_optimizer_state")
        .update({
          last_run_attempt_at: now.toISOString(),
          health_status: "unhealthy",
          last_outcome: "deferred",
          reason: `v2_${unavailableReason}`,
          updated_at: now.toISOString(),
        })
        .eq("id", 1);

      if (heartbeatError) {
        throw new Error(
          `Failed to invalidate V2 backend heartbeat: ${heartbeatError.message}`,
        );
      }
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
      safety_reserve_percent: reservePercents.safetyPercent, target_reserve_percent: hardTargetPercent,
      recommended_preheat_percent: recommendedPreheatPercent,
      safety_energy_kwh: result.safetyEnergyKwh, target_energy_kwh: result.targetEnergyKwh,
      v2_band: result.v2Band, v2_needs_energy_recovery: result.v2NeedsEnergyRecovery,
      v1_shadow_run_id: v1Shadow?.id ?? null, v1_run_at: v1Shadow?.run_at ?? null,
      v1_target_hours: v1Shadow?.target_hours ?? null, v1_needs_energy_recovery: null,
      comparison: "v1_unavailable", plan_available: publicationPlan.available, plan_valid: publicationPlan.valid,
      plan_unavailable_reason: publicationPlan.available ? null : publicationPlan.reason, plan_assumption: publicationPlan.assumption,
      forecast_horizon_end_at: publicationPlan.forecastHorizonEndAt,
      forecast_standing_loss_kwh_per_hour: publicationPlan.standingLossKwhPerHour,
      forecast_final_conservative_energy_kwh: publicationPlan.finalConservativeEnergyKwh,
      forecast_min_conservative_energy_kwh: publicationPlan.minimumConservativeEnergyKwh,
      forecast_first_target_miss_at: publicationPlan.firstTargetMissAt,
      forecast_first_safety_violation_at: publicationPlan.firstSafetyViolationAt,
      plan_selected_heating_hour_ids: publicationPlan.selectedHeatingHourIds,
      plan_selected_heating_energy_kwh: publicationPlan.selectedHeatingEnergyKwh,
      plan_total_cost_cents: publicationPlan.totalCostCents, plan_candidate_count: publicationPlan.candidateCount,
      plan_evaluated_combination_count: publicationPlan.evaluatedCombinationCount,
      learned_drop_profile_used: publicationPlan.learnedDropProfileUsed,
      learned_drop_profile_date: publicationPlan.learnedDropProfileDate,
      learned_drop_profile_age_days: publicationPlan.learnedDropProfileAgeDays,
      maximum_modeled_loss_kwh_per_hour: publicationPlan.maximumModeledLossKwhPerHour,
      preheat_advisory: preheatAdvisory,
      staged_publication_ready: stagedPublicationReadiness.ready,
      staged_publication_ready_reason: stagedPublicationReadiness.reason,
      staged_publication_result: stagedPublicationResult,
      publication_cutover_enabled: v2PublicationCutoverEnabled,
      publication_ready: cutoverPublicationReadiness.ready,
      publication_ready_reason: cutoverPublicationReadiness.reason,
      publication_latest_publishable_tank_reading_at: latestPublishableReadingAt,
      control_plane_state: controlPlaneState,
      source: "v2_energy_reserve_live_shadow",
    });
    if (insertError) throw new Error(`Failed to persist V2 energy shadow: ${insertError.message}`);

    return jsonResponse({
      status: "ok", available: result.available, comparison: "v1_unavailable",
      energy_capacity_kwh: energyCapacityKwh, safety_reserve_percent: reservePercents.safetyPercent,
      target_reserve_percent: hardTargetPercent, recommended_preheat_percent: recommendedPreheatPercent,
      safety_energy_kwh: result.safetyEnergyKwh,
      target_energy_kwh: result.targetEnergyKwh, remaining_energy_kwh: result.remainingEnergyKwh,
      conservative_energy_kwh: result.conservativeEnergyKwh,
      heater_delivery_uncertainty_kwh: result.heaterDeliveryUncertaintyKwh,
      heater_credit_guard_top_temp_c: result.heaterCreditGuardTopTempC,
      v2_band: result.v2Band, v2_needs_energy_recovery: result.v2NeedsEnergyRecovery,
      v1_needs_energy_recovery: null, reason: result.reason, plan_available: publicationPlan.available,
      plan_valid: publicationPlan.valid, plan_reason: publicationPlan.reason,
      plan_required_heating_hour_ids: constraints.requiredHeatingHourIds,
      plan_forbidden_heating_hour_ids: constraints.forbiddenHeatingHourIds,
      plan_selected_heating_hour_ids: publicationPlan.selectedHeatingHourIds,
      plan_selected_heating_energy_kwh: publicationPlan.selectedHeatingEnergyKwh,
      plan_total_cost_cents: publicationPlan.totalCostCents, forecast_horizon_end_at: publicationPlan.forecastHorizonEndAt,
      forecast_final_conservative_energy_kwh: publicationPlan.finalConservativeEnergyKwh,
      forecast_min_conservative_energy_kwh: publicationPlan.minimumConservativeEnergyKwh,
      preheat_advisory: preheatAdvisory,
      learned_drop_profile_used: publicationPlan.learnedDropProfileUsed,
      learned_drop_profile_date: publicationPlan.learnedDropProfileDate,
      learned_drop_profile_age_days: publicationPlan.learnedDropProfileAgeDays,
      maximum_modeled_loss_kwh_per_hour: publicationPlan.maximumModeledLossKwhPerHour,
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
      control_plane_state: controlPlaneState,
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

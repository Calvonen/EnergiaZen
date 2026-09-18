import { createClient } from "npm:@supabase/supabase-js@2";

import {
  applyReserveThresholds,
  deriveUsableReadingInletBaselineC,
  liveReserveShadowConfig,
  runLiveReserveShadow,
  type ReliableWaterDraw,
  type ShadowTankReading,
} from "../run-v2-energy-shadow/logic.ts";
import {
  runLiveEnergyPlanShadow,
  type ShadowElectricityPrice,
} from "../run-v2-energy-shadow/planShadow.ts";
import { buildV2MarginalPreheatAdvisory } from "../run-v2-energy-shadow/preheatMarginalAdvisory.ts";
import {
  resolveV2HeatingConstraints,
  type ShadowStoredHeatingPlan,
} from "../run-v2-energy-shadow/productionConstraints.ts";
import {
  captureV2PublicationCandidate,
  evaluateV2PublicationGuard,
} from "../run-v2-energy-shadow/publicationGuard.ts";
import {
  parseLearnedTemperatureDropProfile,
  type LearnedTemperatureDropProfileRow,
} from "../run-v2-energy-shadow/learnedDropProfile.ts";
import { sensorGeometryV2 } from "../_shared/energyModelV2/sensorGeometry.ts";
import {
  calculateV2EnergyCapacityKwh,
  normalizeV2ReservePercents,
  reservePercentToKwh,
} from "../_shared/energyModelV2/energyReservePercent.ts";

const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};
const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8",
};
const replayWindowHours = 6;
const priceFetchWindowHours = 48;
const pageSize = 1000;
const activeBlockSafetyTopTemperatureC = 50;
const helsinkiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

type PreviewRequest = {
  automaticMaxHeatingHours?: unknown;
  maxTankTemperature?: unknown;
  v2SafetyReservePercent?: unknown;
  v2TargetReservePercent?: unknown;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: jsonHeaders, status });
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase runtime configuration" }, 500);
  }

  try {
    const body = await request.json() as PreviewRequest;
    const automaticMaxHeatingHours = finiteNumber(body.automaticMaxHeatingHours);
    const maxTankTemperatureC = finiteNumber(body.maxTankTemperature);
    const targetPercent = finiteNumber(body.v2TargetReservePercent);
    const safetyPercent = finiteNumber(body.v2SafetyReservePercent);

    if (
      automaticMaxHeatingHours === null ||
      maxTankTemperatureC === null ||
      targetPercent === null ||
      safetyPercent === null
    ) {
      return jsonResponse({ error: "Invalid preview settings" }, 400);
    }

    const reservePercents = normalizeV2ReservePercents({
      targetPercent,
      safetyPercent,
    });
    if (
      reservePercents.targetPercent !== targetPercent ||
      reservePercents.safetyPercent !== safetyPercent ||
      !Number.isInteger(automaticMaxHeatingHours) ||
      automaticMaxHeatingHours < 1 ||
      automaticMaxHeatingHours > 6 ||
      maxTankTemperatureC < 40 ||
      maxTankTemperatureC > 90
    ) {
      return jsonResponse({ error: "Preview settings outside supported V2 range" }, 400);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const now = new Date();
    const replayStart = new Date(now.getTime() - replayWindowHours * 3_600_000);
    const priceFetchEnd = new Date(now.getTime() + priceFetchWindowHours * 3_600_000);
    const today = helsinkiDateKey(now);
    const tomorrow = helsinkiDateKeyOffset(now, 1);

    const [readings, draws, pricesResult, heatingPlansResult, temperatureDropProfileResult] =
      await Promise.all([
        fetchTankReadings(supabase, replayStart.toISOString(), now.toISOString()),
        fetchWaterDraws(supabase, replayStart.toISOString(), now.toISOString()),
        supabase
          .from("electricity_prices")
          .select("starts_at,ends_at,spot_price_cents_kwh,resolution_minutes")
          .eq("region", "FI")
          .eq("resolution_minutes", 60)
          .gt("ends_at", now.toISOString())
          .lte("starts_at", priceFetchEnd.toISOString())
          .order("starts_at", { ascending: true }),
        supabase
          .from("heating_plans")
          .select("plan_date,planned_hours,mode")
          .in("plan_date", [today, tomorrow]),
        supabase
          .from("temperature_drop_profiles")
          .select("id,profile_date,timezone,source_start,source_end,source_days,hourly_drops,observation_days_by_hour,general_fallback,hourly_energy_losses_kwh,general_energy_loss_kwh,algorithm_version,created_at")
          .eq("timezone", "Europe/Helsinki")
          .order("profile_date", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    if (pricesResult.error) {
      throw new Error(`Failed to fetch electricity prices: ${pricesResult.error.message}`);
    }
    if (heatingPlansResult.error) {
      throw new Error(`Failed to fetch heating plans: ${heatingPlansResult.error.message}`);
    }
    if (temperatureDropProfileResult.error) {
      throw new Error(`Failed to fetch learned profile: ${temperatureDropProfileResult.error.message}`);
    }

    const prices = (pricesResult.data ?? []) as ShadowElectricityPrice[];
    const storedPlans = (heatingPlansResult.data ?? []) as ShadowStoredHeatingPlan[];
    const learnedDropProfile = temperatureDropProfileResult.data
      ? parseLearnedTemperatureDropProfile(
          temperatureDropProfileResult.data as unknown as LearnedTemperatureDropProfileRow,
        )
      : null;
    if (temperatureDropProfileResult.data && !learnedDropProfile) {
      throw new Error("Latest learned profile is invalid");
    }

    const inletBaselineC = deriveUsableReadingInletBaselineC(readings) ?? Number.NaN;
    const energyCapacityKwh = calculateV2EnergyCapacityKwh({
      inletTemperatureC: inletBaselineC,
      maxTankTemperatureC,
      tankVolumeLiters: sensorGeometryV2.tank.nominalVolumeLiters,
    });
    const hardTargetPercent = reservePercents.safetyPercent;
    const safetyEnergyKwh =
      energyCapacityKwh === null
        ? null
        : reservePercentToKwh(reservePercents.safetyPercent, energyCapacityKwh);
    const targetEnergyKwh =
      energyCapacityKwh === null
        ? null
        : reservePercentToKwh(hardTargetPercent, energyCapacityKwh);

    const baseReserve = runLiveReserveShadow({
      maxTankTemperatureC,
      now,
      readings,
      reliableDraws: draws,
      v1Shadow: null,
    });
    const reserve = applyReserveThresholds(
      baseReserve,
      safetyEnergyKwh,
      targetEnergyKwh,
    );

    const constraints = resolveV2HeatingConstraints({
      now,
      priceHourIds: prices.map((price) => price.starts_at),
      readings,
      safetyTopTemperatureC: activeBlockSafetyTopTemperatureC,
      storedPlans,
    });

    const baselinePlan = runLiveEnergyPlanShadow({
      automaticMaxHeatingHours,
      constraints,
      energyCapacityKwh: energyCapacityKwh ?? Number.NaN,
      inletBaselineC,
      maxTankTemperatureC,
      now,
      prices,
      reserve,
      learnedDropProfile,
    });

    const preheatAdvisory = buildV2MarginalPreheatAdvisory({
      baselinePlan,
      conservativeEnergyKwh: reserve.conservativeEnergyKwh ?? Number.NaN,
      constraints,
      energyCapacityKwh: energyCapacityKwh ?? Number.NaN,
      heaterPowerKw: liveReserveShadowConfig.heaterPowerKw,
      maxPreheatHours: automaticMaxHeatingHours,
      now,
      prices,
      recommendedPreheatPercent: reservePercents.targetPercent,
      remainingEnergyKwh: reserve.remainingEnergyKwh ?? Number.NaN,
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
          reserve,
          learnedDropProfile,
        });
      },
    });

    const selectedHeatingHourIds = composePublicationHours(
      baselinePlan.selectedHeatingHourIds,
      preheatAdvisory,
    );
    const selected = new Set(selectedHeatingHourIds);
    const previewPlan = runLiveEnergyPlanShadow({
      automaticMaxHeatingHours,
      constraints: {
        requiredHeatingHourIds: selectedHeatingHourIds,
        forbiddenHeatingHourIds: prices
          .map((price) => price.starts_at)
          .filter((hourId) => !selected.has(hourId)),
      },
      energyCapacityKwh: energyCapacityKwh ?? Number.NaN,
      inletBaselineC,
      maxTankTemperatureC,
      now,
      prices,
      reserve,
      learnedDropProfile,
    });

    const latestPublishableReadingAt = deriveLatestPublishableReadingAt(readings);
    const publicationCandidate = captureV2PublicationCandidate(
      previewPlan,
      selectedHeatingHourIds,
    );
    const publicationReadiness = evaluateV2PublicationGuard({
      enabled: true,
      expectedSelectedHeatingHourIds: selectedHeatingHourIds,
      latestTankReadingAt: latestPublishableReadingAt,
      now,
      plan: previewPlan,
      publicationCandidate,
    });

    return jsonResponse({
      available:
        reserve.available &&
        previewPlan.available &&
        previewPlan.valid === true &&
        publicationReadiness.ready,
      reason:
        reserve.reason ??
        previewPlan.reason ??
        (previewPlan.valid === false ? "plan_invalid" : null) ??
        (publicationReadiness.ready ? null : publicationReadiness.reason),
      current_conservative_energy_kwh: reserve.conservativeEnergyKwh,
      energy_capacity_kwh: energyCapacityKwh,
      current_percent:
        reserve.conservativeEnergyKwh !== null && energyCapacityKwh
          ? round((reserve.conservativeEnergyKwh / energyCapacityKwh) * 100)
          : null,
      safety_reserve_percent: reservePercents.safetyPercent,
      recommended_preheat_percent: reservePercents.targetPercent,
      selected_heating_hour_ids: previewPlan.selectedHeatingHourIds,
      selected_heating_energy_kwh: previewPlan.selectedHeatingEnergyKwh,
      total_cost_cents: previewPlan.totalCostCents,
      forecast_min_conservative_energy_kwh: previewPlan.minimumConservativeEnergyKwh,
      forecast_final_conservative_energy_kwh: previewPlan.finalConservativeEnergyKwh,
      forecast_horizon_end_at: previewPlan.forecastHorizonEndAt,
      forecast_min_percent:
        previewPlan.minimumConservativeEnergyKwh !== null && energyCapacityKwh
          ? round((previewPlan.minimumConservativeEnergyKwh / energyCapacityKwh) * 100)
          : null,
      forecast_final_percent:
        previewPlan.finalConservativeEnergyKwh !== null && energyCapacityKwh
          ? round((previewPlan.finalConservativeEnergyKwh / energyCapacityKwh) * 100)
          : null,
      strategy: preheatAdvisory.strategy,
      plan_valid: previewPlan.valid,
      learned_drop_profile_used: previewPlan.learnedDropProfileUsed,
      publication_ready: publicationReadiness.ready,
      publication_ready_reason: publicationReadiness.reason,
      latest_publishable_tank_reading_at: latestPublishableReadingAt,
      preview_only: true,
    });
  } catch (error) {
    console.error("preview-v2-energy-plan failed", error);
    return jsonResponse(
      {
        error: "V2 preview failed",
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

function composePublicationHours(
  baselineHourIds: string[],
  preheatAdvisory: ReturnType<typeof buildV2MarginalPreheatAdvisory>,
) {
  if (!preheatAdvisory.available || preheatAdvisory.reason !== "recommended") {
    return [...baselineHourIds];
  }
  const displaced = new Set(
    preheatAdvisory.strategy === "marginal_displacement" &&
      preheatAdvisory.marginalCost.available
      ? preheatAdvisory.marginalCost.pairs.map(
          (pair) => pair.displacedFutureHourId,
        )
      : [],
  );
  return [...new Set([
    ...baselineHourIds.filter((hourId) => !displaced.has(hourId)),
    ...preheatAdvisory.recommendedPreheatHourIds,
  ])].sort((left, right) => Date.parse(left) - Date.parse(right));
}

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
    if (error) throw new Error(`Failed to fetch tank readings: ${error.message}`);
    const page = (data ?? []) as ShadowTankReading[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchWaterDraws(
  supabase: ReturnType<typeof createClient>,
  startIso: string,
  endIso: string,
): Promise<ReliableWaterDraw[]> {
  const rows: ReliableWaterDraw[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("water_draw_labels")
      .select("event_started_at,event_ended_at,estimated_water_draw_net_energy_kwh,energy_reliable,energy_quality_reason")
      .gte("event_ended_at", startIso)
      .lte("event_started_at", endIso)
      .order("event_started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Failed to fetch water draw labels: ${error.message}`);
    const page = (data ?? []) as ReliableWaterDraw[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function deriveLatestPublishableReadingAt(readings: ShadowTankReading[]) {
  let latestAt: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const reading of readings) {
    const createdMs = Date.parse(reading.created_at);
    if (
      Number.isFinite(createdMs) &&
      Number.isFinite(reading.top_temp) &&
      Number.isFinite(reading.bottom_temp) &&
      Number.isFinite(reading.inlet_temp) &&
      typeof reading.heating === "boolean" &&
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
  return helsinkiDateKey(
    new Date(Date.UTC(year, month - 1, day + offset, 12)),
  );
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

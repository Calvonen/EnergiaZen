import { supabase } from "@/lib/supabase";
import { estimateRecoveryDropPerHour } from "../heatingRecoveryDrop";
import { calculateDashboardV2TankState } from "./dashboardReplay";
import type { TankState } from "./energyModelCore";
import { topSensorMovedAt } from "./sensorGeometry";

type DashboardReading = {
  bottom_temp: number | null;
  created_at: string;
  heating: boolean | null;
  inlet_temp: number | null;
  top_temp: number | null;
};

export type EnergyModelDashboardData = {
  coolingPeriods: number;
  estimatedInletTemperature: number | null;
  fullHeatings: number;
  latest: DashboardReading | null;
  missingMeasurements: number;
  recoverySamples: number;
  validReplayDays: number;
  v1Readings: number;
  v2Readings: number;
  waterDraws: number;
  v2TankState: TankState | null;
};

const EXPECTED_INTERVAL_MS = 60 * 1000;
const PERIOD_GAP_MS = 20 * 60 * 1000;
const READINGS_PAGE_SIZE = 1000;
const VALID_REPLAY_DAY_MINIMUM_READINGS =
  (20 * 60 * 60 * 1000) / EXPECTED_INTERVAL_MS;

export function summarizeDashboardReadings(
  readings: DashboardReading[],
): Pick<EnergyModelDashboardData, "coolingPeriods" | "fullHeatings" | "missingMeasurements" | "validReplayDays" | "waterDraws"> {
  const ordered = [...readings].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  let coolingPeriods = 0;
  let fullHeatings = 0;
  let missingMeasurements = 0;
  let waterDraws = 0;
  let previous: DashboardReading | null = null;
  const dayCounts = new Map<string, number>();

  for (const reading of ordered) {
    dayCounts.set(reading.created_at.slice(0, 10), (dayCounts.get(reading.created_at.slice(0, 10)) ?? 0) + 1);
    if (previous) {
      const gap = new Date(reading.created_at).getTime() - new Date(previous.created_at).getTime();
      if (gap > EXPECTED_INTERVAL_MS * 1.5) {
        missingMeasurements += Math.max(0, Math.round(gap / EXPECTED_INTERVAL_MS) - 1);
      }
      if (reading.heating === false && previous.heating === true) fullHeatings += 1;
      if (reading.heating === false && (previous.heating !== false || gap > PERIOD_GAP_MS)) coolingPeriods += 1;
      if (
        gap <= 5 * 60 * 1000 &&
        typeof previous.inlet_temp === "number" &&
        typeof reading.inlet_temp === "number" &&
        previous.inlet_temp - reading.inlet_temp >= 5
      ) waterDraws += 1;
    } else if (reading.heating === false) {
      coolingPeriods += 1;
    }
    previous = reading;
  }

  return {
    coolingPeriods,
    fullHeatings,
    missingMeasurements,
    validReplayDays: [...dayCounts.values()].filter(
      (count) => count >= VALID_REPLAY_DAY_MINIMUM_READINGS,
    ).length,
    waterDraws,
  };
}

async function countReadings(before?: string, after?: string) {
  let query = supabase.from("tank_readings").select("created_at", { count: "exact", head: true });
  if (before) query = query.lt("created_at", before);
  if (after) query = query.gte("created_at", after);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export async function fetchEnergyModelDashboardData(): Promise<EnergyModelDashboardData> {
  const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [readings, v1Readings, v2Readings] = await Promise.all([
    fetchReadingsSince(windowStart),
    countReadings(topSensorMovedAt),
    countReadings(undefined, topSensorMovedAt),
  ]);
  const v2TankState = calculateDashboardV2TankState(readings);
  return {
    ...summarizeDashboardReadings(readings),
    estimatedInletTemperature: v2TankState?.inletTemperatureC ?? null,
    latest: readings.at(-1) ?? null,
    recoverySamples: estimateRecoveryDropPerHour(readings).sampleCount,
    v1Readings,
    v2Readings,
    v2TankState,
  };
}

async function fetchReadingsSince(windowStart: string) {
  const readings: DashboardReading[] = [];

  for (let from = 0; ; from += READINGS_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("tank_readings")
      .select("created_at, top_temp, bottom_temp, inlet_temp, heating")
      .gte("created_at", windowStart)
      .order("created_at", { ascending: true })
      .range(from, from + READINGS_PAGE_SIZE - 1);

    if (error) throw error;
    const page = (data ?? []) as DashboardReading[];
    readings.push(...page);

    if (page.length < READINGS_PAGE_SIZE) break;
  }

  return readings;
}

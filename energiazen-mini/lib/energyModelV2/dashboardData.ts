import { supabase } from "@/lib/supabase";
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
  fullHeatings: number;
  latest: DashboardReading | null;
  missingMeasurements: number;
  validReplayDays: number;
  v1Readings: number;
  v2Readings: number;
  waterDraws: number;
};

const EXPECTED_INTERVAL_MS = 5 * 60 * 1000;
const PERIOD_GAP_MS = 20 * 60 * 1000;

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
    validReplayDays: [...dayCounts.values()].filter((count) => count >= 240).length,
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
  const [{ data, error }, v1Readings, v2Readings] = await Promise.all([
    supabase
      .from("tank_readings")
      .select("created_at, top_temp, bottom_temp, inlet_temp, heating")
      .gte("created_at", windowStart)
      .order("created_at", { ascending: true })
      .limit(10000),
    countReadings(topSensorMovedAt),
    countReadings(undefined, topSensorMovedAt),
  ]);
  if (error) throw error;
  const readings = (data ?? []) as DashboardReading[];
  return {
    ...summarizeDashboardReadings(readings),
    latest: readings.at(-1) ?? null,
    v1Readings,
    v2Readings,
  };
}

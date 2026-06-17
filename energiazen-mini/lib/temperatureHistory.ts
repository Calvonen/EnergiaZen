import { supabase } from "@/lib/supabase";

export type TemperatureHistoryPoint = {
  timestamp: string;
  topTemp: number;
  bottomTemp: number;
  heating: boolean;
  showers: number;
};

type TankReadingRow = {
  created_at?: string | null;
  top_temp?: number | null;
  bottom_temp?: number | null;
  heating?: boolean | null;
  showers?: number | null;
};

const pollingIntervalMs = 60 * 1000;
const historyRetentionMs = 7 * 24 * 60 * 60 * 1000;

let temperatureHistory: TemperatureHistoryPoint[] = [];
let pollingTimer: ReturnType<typeof setInterval> | null = null;
const historyListeners = new Set<(points: TemperatureHistoryPoint[]) => void>();

function mapTankReadingToHistoryPoint(
  reading: TankReadingRow,
): TemperatureHistoryPoint | null {
  if (
    !reading.created_at ||
    typeof reading.top_temp !== "number" ||
    typeof reading.bottom_temp !== "number"
  ) {
    return null;
  }

  return {
    bottomTemp: reading.bottom_temp,
    heating: reading.heating ?? false,
    showers: reading.showers ?? 0,
    timestamp: reading.created_at,
    topTemp: reading.top_temp,
  };
}

function pruneHistory(now = new Date()) {
  const retentionStart = now.getTime() - historyRetentionMs;
  temperatureHistory = temperatureHistory.filter(
    (point) => new Date(point.timestamp).getTime() >= retentionStart,
  );
}

function notifyHistoryListeners() {
  const snapshot = [...temperatureHistory];

  historyListeners.forEach((listener) => listener(snapshot));
}

async function fetchTemperatureHistory() {
  const retentionStart = new Date(
    Date.now() - historyRetentionMs,
  ).toISOString();
  const { data, error } = await supabase
    .from("tank_readings")
    .select("created_at, top_temp, bottom_temp, heating, showers")
    .gte("created_at", retentionStart)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  temperatureHistory = ((data as TankReadingRow[] | null) ?? [])
    .map(mapTankReadingToHistoryPoint)
    .filter((point): point is TemperatureHistoryPoint => point !== null);
  pruneHistory();
  notifyHistoryListeners();

  return [...temperatureHistory];
}

export async function refreshTemperatureHistory() {
  return fetchTemperatureHistory();
}

export function startTemperatureLogging() {
  if (pollingTimer) {
    return;
  }

  void fetchTemperatureHistory().catch(() => undefined);
  pollingTimer = setInterval(() => {
    void fetchTemperatureHistory().catch(() => undefined);
  }, pollingIntervalMs);
}

export function stopTemperatureLogging() {
  if (!pollingTimer) {
    return;
  }

  clearInterval(pollingTimer);
  pollingTimer = null;
}

export async function getTemperatureHistory() {
  return fetchTemperatureHistory();
}

export function subscribeToTemperatureHistory(
  listener: (points: TemperatureHistoryPoint[]) => void,
) {
  historyListeners.add(listener);
  listener([...temperatureHistory]);

  return () => {
    historyListeners.delete(listener);
  };
}

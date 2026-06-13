export type TemperatureHistoryPoint = {
  timestamp: string;
  topTemp: number;
  bottomTemp: number;
  heating: boolean;
};

const loggingIntervalMs = 60 * 1000;
const historyRetentionMs = 7 * 24 * 60 * 60 * 1000;
const initialHistoryHours = 24;

let temperatureHistory: TemperatureHistoryPoint[] = createInitialMockHistory();
let loggingTimer: ReturnType<typeof setInterval> | null = null;
const historyListeners = new Set<(points: TemperatureHistoryPoint[]) => void>();

function roundTemperature(value: number) {
  return Math.round(value * 10) / 10;
}

function createMockHistoryPoint(date: Date): TemperatureHistoryPoint {
  const hour = date.getHours();
  const minuteRatio = date.getMinutes() / 60;
  const dayProgress = (hour + minuteRatio) / 24;
  const dayCurve = Math.sin(dayProgress * Math.PI * 2 - Math.PI / 2);
  const shortCycle = Math.sin((date.getTime() / loggingIntervalMs) * 0.35);
  const heating = [3, 4, 5, 15, 16, 22].includes(hour);
  const heatingBoost = heating ? 4.8 : 0;

  return {
    timestamp: date.toISOString(),
    topTemp: roundTemperature(
      57 + dayCurve * 5 + shortCycle * 0.4 + heatingBoost,
    ),
    bottomTemp: roundTemperature(
      43 + dayCurve * 3.5 + shortCycle * 0.25 + heatingBoost * 0.72,
    ),
    heating,
  };
}

function createInitialMockHistory() {
  const now = new Date();
  const startTime =
    now.getTime() - initialHistoryHours * 60 * loggingIntervalMs;
  const points: TemperatureHistoryPoint[] = [];

  for (let time = startTime; time <= now.getTime(); time += loggingIntervalMs) {
    points.push(createMockHistoryPoint(new Date(time)));
  }

  return points;
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

export function saveHistoryPoint(point = createMockHistoryPoint(new Date())) {
  temperatureHistory = [...temperatureHistory, point].sort(
    (firstPoint, secondPoint) =>
      new Date(firstPoint.timestamp).getTime() -
      new Date(secondPoint.timestamp).getTime(),
  );
  pruneHistory(new Date(point.timestamp));
  notifyHistoryListeners();

  return point;
}

export function startTemperatureLogging() {
  if (loggingTimer) {
    return;
  }

  saveHistoryPoint();
  loggingTimer = setInterval(() => {
    saveHistoryPoint();
  }, loggingIntervalMs);
}

export function stopTemperatureLogging() {
  if (!loggingTimer) {
    return;
  }

  clearInterval(loggingTimer);
  loggingTimer = null;
}

export async function getTemperatureHistory() {
  pruneHistory();

  return [...temperatureHistory];
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

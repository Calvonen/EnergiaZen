import {
  getHeatingOptimizationSegmentHours,
  type HeatingOptimizationHour,
  type HeatingOptimizationSettings,
} from "./heatingOptimizer";
import type {
  TankTemperatureReading,
} from "./tankTemperatureForecast";

export type HeatingOptimizationInputSnapshot = {
  currentBottomTemperature: number | null;
  currentTopTemperature: number | null;
  currentWeightedTemperature: number | null;
  heatingHistory: TankTemperatureReading[];
  hourlyDrops: Record<number, number>;
  hours: HeatingOptimizationHour[];
  isCurrentlyHeating: boolean;
  manualRefreshRevision: number;
  mode: string;
  readingCreatedAt: string | null;
  settings: HeatingOptimizationSettings;
};

export function materializeHeatingOptimizationHours(
  hours: HeatingOptimizationHour[],
  forecastStart: Date,
) {
  return hours.map((hour) => ({
    ...hour,
    isCurrentHour:
      hour.date.getTime() <= forecastStart.getTime() &&
      hour.endDate.getTime() > forecastStart.getTime(),
    segmentHours: getHeatingOptimizationSegmentHours({
      endDate: hour.endDate,
      forecastStart,
      startDate: hour.date,
    }),
  }));
}

export function createHeatingOptimizationInputKey(
  snapshot: HeatingOptimizationInputSnapshot,
) {
  return JSON.stringify({
    currentBottomTemperature: snapshot.currentBottomTemperature,
    currentTopTemperature: snapshot.currentTopTemperature,
    currentWeightedTemperature: snapshot.currentWeightedTemperature,
    heatingHistory: snapshot.heatingHistory.map((reading) => [
      reading.created_at ?? null,
      reading.top_temp ?? null,
      reading.bottom_temp ?? null,
      reading.heating ?? null,
    ]),
    hourlyDrops: Array.from(
      { length: 24 },
      (_, hour) => snapshot.hourlyDrops[hour] ?? null,
    ),
    hours: snapshot.hours.map((hour) => [
      hour.id,
      hour.isCurrentHour,
      hour.startDate,
      hour.endDate.toISOString(),
      hour.price,
    ]),
    isCurrentlyHeating: snapshot.isCurrentlyHeating,
    manualRefreshRevision: snapshot.manualRefreshRevision,
    mode: snapshot.mode,
    readingCreatedAt: snapshot.readingCreatedAt,
    settings: snapshot.settings,
  });
}

export function createHeatingOptimizationRunController() {
  let latestRunId = 0;
  let latestInputKey: string | null = null;

  return {
    canCommit(runId: number) {
      return runId === latestRunId;
    },
    invalidate() {
      latestInputKey = null;
      latestRunId += 1;
    },
    start(inputKey: string) {
      if (inputKey === latestInputKey) {
        return null;
      }

      latestInputKey = inputKey;
      latestRunId += 1;

      return latestRunId;
    },
  };
}

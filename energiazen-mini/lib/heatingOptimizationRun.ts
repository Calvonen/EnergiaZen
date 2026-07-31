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
  // Unfiltered (both heating states) readings used only for the opt-in
  // RecoveryDrop estimate - see recoveryDropEnvironment.ts. Optional so
  // existing snapshots/tests that predate RecoveryDrop stay valid.
  recoveryReadings?: TankTemperatureReading[];
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
    // Cheap fingerprint rather than mapping every reading like
    // heatingHistory above - this array can be much larger since it isn't
    // filtered to heating=true only.
    recoveryReadingsFingerprint: [
      snapshot.recoveryReadings?.length ?? 0,
      snapshot.recoveryReadings?.[snapshot.recoveryReadings.length - 1]
        ?.created_at ?? null,
    ],
    settings: snapshot.settings,
  });
}

export function shouldRunHeatingOptimization({
  currentBottomTemperature,
  currentTopTemperature,
  currentWeightedTemperature,
  hoursCount,
  isEnabled,
  mode,
}: {
  currentBottomTemperature: number | null;
  currentTopTemperature: number | null;
  currentWeightedTemperature: number | null;
  hoursCount: number;
  isEnabled: boolean;
  mode: string;
}) {
  return (
    mode === "automatic" &&
    isEnabled &&
    currentWeightedTemperature !== null &&
    currentTopTemperature !== null &&
    currentBottomTemperature !== null &&
    hoursCount > 0
  );
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

import {
  getHeatingOptimizationSegmentHours,
  type HeatingOptimizationHour,
  type HeatingOptimizationSettings,
} from "./heatingOptimizer";
import type { HeatingGainSource } from "./settings";
import type {
  TankTemperatureReading,
} from "./tankTemperatureForecast";
import { isTankReadingFreshForCalculation } from "./tankReadingFreshness";

export type HeatingOptimizationInputSnapshot = {
  currentBottomTemperature: number | null;
  currentTopTemperature: number | null;
  currentWeightedTemperature: number | null;
  heatingGainSource: HeatingGainSource;
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
    // heatingGainSource itself isn't part of snapshot.settings (the
    // "fixed" override is applied separately - see
    // useHeatingOptimizationRun.ts) so it must be listed explicitly here,
    // or toggling it wouldn't change this key and the run controller
    // would treat it as "no change" and skip re-optimizing.
    heatingGainSource: snapshot.heatingGainSource,
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
  now,
  readingCreatedAt,
}: {
  currentBottomTemperature: number | null;
  currentTopTemperature: number | null;
  currentWeightedTemperature: number | null;
  hoursCount: number;
  isEnabled: boolean;
  mode: string;
  now: Date;
  readingCreatedAt: string | null;
}) {
  return (
    mode === "automatic" &&
    isEnabled &&
    currentWeightedTemperature !== null &&
    currentTopTemperature !== null &&
    currentBottomTemperature !== null &&
    hoursCount > 0 &&
    // A stale reading must not drive a new automatic recommendation or a
    // new heating_plans publish - this is the only path allowed to
    // publish (see useHeatingOptimizationRun.ts), so gating it here also
    // covers the publish requirement without a separate check.
    isTankReadingFreshForCalculation(readingCreatedAt, now)
  );
}

// inputKey alone doesn't catch a reading going stale while the app stays
// open: readingCreatedAt is fixed once a reading arrives, so inputKey stays
// unchanged as time passes without a new one arriving. A cached result must
// still stop being exposed once that fixed reading crosses the freshness
// threshold against the live clock, even though nothing about the snapshot
// itself changed.
export function isHeatingOptimizationResultUsable({
  inputKey,
  now,
  readingCreatedAt,
  resultInputKey,
}: {
  inputKey: string;
  now: Date;
  readingCreatedAt: string | null;
  resultInputKey: string;
}) {
  return (
    resultInputKey === inputKey &&
    isTankReadingFreshForCalculation(readingCreatedAt, now)
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

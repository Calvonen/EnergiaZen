import { runEnergyModelCoreReplay, type TankState } from "./energyModelCore";
import { sensorGeometryEpochs, type SensorGeometryEpoch } from "./sensorGeometry";
import {
  collectHeatLossDiagnostics,
  type HeatLossDiagnostics,
  type WaterDrawEnergyDiagnostic,
} from "./heatLossDiagnostics";

export type DashboardReplayReading = {
  bottom_temp: number | null;
  created_at: string;
  heating: boolean | null;
  inlet_temp: number | null;
  top_temp: number | null;
};

export function calculateDashboardV2TankState(
  readings: DashboardReplayReading[],
): TankState | null {
  return calculateDashboardV2Replay(readings).tankState;
}

export function calculateDashboardV2Replay(readings: DashboardReplayReading[]): {
  heatLossDiagnostics: HeatLossDiagnostics;
  tankState: TankState | null;
  waterDrawEvents: WaterDrawEnergyDiagnostic[];
} {
  const currentEpoch = getCurrentSensorGeometryEpoch();
  const currentEpochReadings = readings
    .filter((reading) => isReadingInEpoch(reading, currentEpoch))
    .sort((first, second) => first.created_at.localeCompare(second.created_at));
  const firstCompleteReadingIndex = currentEpochReadings.findIndex(
    isCompleteV2Reading,
  );

  if (firstCompleteReadingIndex === -1) {
    const heatLossDiagnostics = collectHeatLossDiagnostics([]);
    return {
      heatLossDiagnostics,
      tankState: null,
      waterDrawEvents: heatLossDiagnostics.waterDrawEvents,
    };
  }

  const replay = runEnergyModelCoreReplay({
    readings: currentEpochReadings.slice(firstCompleteReadingIndex),
    sensorGeometryEpochs: [currentEpoch],
  });

  const heatLossDiagnostics = collectHeatLossDiagnostics(replay.steps);
  return {
    heatLossDiagnostics,
    tankState: replay.finalState,
    waterDrawEvents: heatLossDiagnostics.waterDrawEvents,
  };
}

function getCurrentSensorGeometryEpoch(): SensorGeometryEpoch {
  const currentEpoch = sensorGeometryEpochs.find(
    (epoch) => epoch.effectiveUntilExclusive === null,
  );

  if (!currentEpoch) {
    throw new Error("Current sensor geometry epoch is not configured");
  }

  return currentEpoch;
}

function isReadingInEpoch(
  reading: DashboardReplayReading,
  epoch: SensorGeometryEpoch,
) {
  const timestamp = new Date(reading.created_at).getTime();
  if (!Number.isFinite(timestamp)) return false;

  const startsAt = epoch.effectiveFromInclusive
    ? new Date(epoch.effectiveFromInclusive).getTime()
    : Number.NEGATIVE_INFINITY;
  const endsAt = epoch.effectiveUntilExclusive
    ? new Date(epoch.effectiveUntilExclusive).getTime()
    : Number.POSITIVE_INFINITY;

  return timestamp >= startsAt && timestamp < endsAt;
}

function isCompleteV2Reading(reading: DashboardReplayReading) {
  return (
    Number.isFinite(new Date(reading.created_at).getTime()) &&
    typeof reading.top_temp === "number" &&
    Number.isFinite(reading.top_temp) &&
    typeof reading.bottom_temp === "number" &&
    Number.isFinite(reading.bottom_temp) &&
    typeof reading.inlet_temp === "number" &&
    Number.isFinite(reading.inlet_temp)
  );
}

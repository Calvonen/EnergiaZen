import {
  resolveSensorGeometryForTimestamp,
  type SensorGeometryEpoch,
} from "./sensorGeometry";
import {
  assertTankDnaMatchesReplayGeometry,
  type EnergyModelPhysicsVersion,
  type TankDnaProfile,
} from "./tankDna";
import type { TankTemperatureReading } from "../tankTemperatureForecast";

export type ReplayReading = TankTemperatureReading & {
  created_at: string;
};

export type ReplayStepContext = {
  dnaProfile: TankDnaProfile | null;
  geometry: SensorGeometryEpoch;
  index: number;
  modelVersion: EnergyModelPhysicsVersion;
  previousReading: ReplayReading | null;
  reading: ReplayReading;
  segmentMinutes: number | null;
};

export type ReplayStepResult<State> = {
  state: State;
};

export type ReplayEngineOptions<State> = {
  dnaProfiles?: TankDnaProfile[];
  initialState: State;
  modelVersion: EnergyModelPhysicsVersion;
  sensorGeometryEpochs: SensorGeometryEpoch[];
  step: (state: State, context: ReplayStepContext) => ReplayStepResult<State>;
};

export type ReplayEngineResult<State> = {
  finalState: State;
  processedReadings: number;
  steps: Array<ReplayStepContext & { state: State }>;
};

export function runTankReadingsReplay<State>(
  readings: TankTemperatureReading[],
  options: ReplayEngineOptions<State>,
): ReplayEngineResult<State> {
  const orderedReadings = normalizeReplayReadings(readings);
  let state = options.initialState;
  const steps: Array<ReplayStepContext & { state: State }> = [];

  for (let index = 0; index < orderedReadings.length; index += 1) {
    const reading = orderedReadings[index];
    const previousReading = orderedReadings[index - 1] ?? null;
    const geometry = resolveSensorGeometryForTimestamp({
      epochs: options.sensorGeometryEpochs,
      timestamp: reading.created_at,
    });
    const dnaProfile = selectTankDnaProfileForReplayStep({
      geometryVersion: geometry.version,
      modelVersion: options.modelVersion,
      profiles: options.dnaProfiles ?? [],
      timestamp: reading.created_at,
    });

    if (dnaProfile) {
      assertTankDnaMatchesReplayGeometry({
        profile: dnaProfile,
        sensorGeometryVersion: geometry.version,
      });
    }

    const context: ReplayStepContext = {
      dnaProfile,
      geometry,
      index,
      modelVersion: options.modelVersion,
      previousReading,
      reading,
      segmentMinutes: previousReading
        ? (new Date(reading.created_at).getTime() -
            new Date(previousReading.created_at).getTime()) /
          60000
        : null,
    };
    const result = options.step(state, context);

    state = result.state;
    steps.push({ ...context, state });
  }

  return {
    finalState: state,
    processedReadings: orderedReadings.length,
    steps,
  };
}

export function normalizeReplayReadings(
  readings: TankTemperatureReading[],
): ReplayReading[] {
  return readings
    .filter((reading): reading is ReplayReading => {
      if (typeof reading.created_at !== "string") {
        return false;
      }

      return Number.isFinite(new Date(reading.created_at).getTime());
    })
    .sort((first, second) => first.created_at.localeCompare(second.created_at));
}

export function selectTankDnaProfileForReplayStep({
  geometryVersion,
  modelVersion,
  profiles,
  timestamp,
}: {
  geometryVersion: SensorGeometryEpoch["version"];
  modelVersion: EnergyModelPhysicsVersion;
  profiles: TankDnaProfile[];
  timestamp: string;
}): TankDnaProfile | null {
  const time = new Date(timestamp).getTime();

  return (
    profiles
      .filter((profile) => {
        if (profile.modelVersion !== modelVersion) {
          return false;
        }
        if (profile.sensorGeometryVersion !== geometryVersion) {
          return false;
        }

        const startsAt = new Date(
          profile.calibrationEpoch.calibrationStartedAt,
        ).getTime();
        const endsAt = profile.calibrationEpoch.calibrationEndedAt
          ? new Date(profile.calibrationEpoch.calibrationEndedAt).getTime()
          : Number.POSITIVE_INFINITY;

        return time >= startsAt && time < endsAt;
      })
      .sort((first, second) =>
        second.calibrationEpoch.calibrationStartedAt.localeCompare(
          first.calibrationEpoch.calibrationStartedAt,
        ),
      )[0] ?? null
  );
}

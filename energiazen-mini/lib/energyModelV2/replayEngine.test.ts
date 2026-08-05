import { runTankReadingsReplay } from "./replayEngine";
import { createSensorGeometryEpochs } from "./sensorGeometry";
import { createTankDnaProfile } from "./tankDna";

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

export function runReplayEngineUnitTests() {
  const movedAt = "2026-08-01T12:00:00.000Z";
  const sensorGeometryEpochs = createSensorGeometryEpochs({
    topSensorMovedAt: movedAt,
  });
  const v1Dna = createTankDnaProfile({
    calibrationEpoch: {
      calibrationEndedAt: movedAt,
      calibrationStartedAt: "2026-07-01T00:00:00.000Z",
    },
    createdAt: "2026-07-15T00:00:00.000Z",
    modelVersion: "physical-model-v2-foundation-v1",
    profileId: "dna-v1",
    sensorGeometryVersion: "V1",
    status: "active",
  });
  const v2Dna = createTankDnaProfile({
    calibrationEpoch: {
      calibrationEndedAt: null,
      calibrationStartedAt: movedAt,
    },
    createdAt: movedAt,
    modelVersion: "physical-model-v2-foundation-v1",
    profileId: "dna-v2",
    sensorGeometryVersion: "V2",
    status: "candidate",
  });

  const replay = runTankReadingsReplay(
    [
      {
        bottom_temp: 35,
        created_at: "2026-08-01T12:01:00.000Z",
        heating: false,
        inlet_temp: 8,
        top_temp: 54,
      },
      {
        bottom_temp: 34,
        created_at: "2026-08-01T11:59:00.000Z",
        heating: null,
        inlet_temp: 8,
        top_temp: 53,
      },
    ],
    {
      dnaProfiles: [v1Dna, v2Dna],
      initialState: { seen: [] as string[] },
      modelVersion: "physical-model-v2-foundation-v1",
      sensorGeometryEpochs,
      step: (state, context) => ({
        state: {
          seen: [
            ...state.seen,
            `${context.geometry.version}:${context.dnaProfile?.profileId ?? "none"}:${context.segmentMinutes ?? "start"}`,
          ],
        },
      }),
    },
  );

  assertEqual(replay.processedReadings, 2, "replay processes valid readings");
  assertEqual(
    replay.finalState.seen.join("|"),
    "V1:dna-v1:start|V2:dna-v2:2",
    "replay sorts readings and switches geometry/DNA at the move timestamp",
  );
}

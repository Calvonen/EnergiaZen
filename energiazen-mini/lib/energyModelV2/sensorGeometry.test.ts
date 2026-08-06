import {
  areTimestampsInSameSensorGeometryEpoch,
  createSensorGeometryEpochs,
  filterToLatestSensorGeometryEpoch,
  resolveSensorGeometryForTimestamp,
  sensorGeometryV1,
  sensorGeometryV2,
  sensorGeometryEpochs,
  topSensorMovedAt,
} from "./sensorGeometry";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

export function runSensorGeometryUnitTests() {
  const movedAt = "2026-08-05T14:00:00.000Z";
  const epochs = createSensorGeometryEpochs({ topSensorMovedAt: movedAt });

  assertEqual(sensorGeometryV1.topSensorDistanceFromTopCm, 9, "V1 top sensor distance");
  assertEqual(sensorGeometryV2.topSensorDistanceFromTopCm, 16, "V2 top sensor distance");
  assertEqual(sensorGeometryV1.bottomSensorHeightFromBottomCm, 22, "V1 bottom sensor height");
  assertEqual(sensorGeometryV2.bottomSensorHeightFromBottomCm, 22, "V2 bottom sensor height");

  assertEqual(
    resolveSensorGeometryForTimestamp({
      epochs,
      timestamp: "2026-08-05T13:59:59.000Z",
    }).version,
    "V1",
    "timestamp before top sensor move uses V1",
  );
  assertEqual(
    resolveSensorGeometryForTimestamp({
      epochs,
      timestamp: movedAt,
    }).version,
    "V2",
    "timestamp at top sensor move uses V2",
  );
  assert(
    epochs[0].effectiveUntilExclusive === epochs[1].effectiveFromInclusive,
    "geometry epochs are contiguous at the sensor move timestamp",
  );
  assertEqual(
    topSensorMovedAt,
    movedAt,
    "production sensor move timestamp is canonical",
  );
  assertEqual(
    sensorGeometryEpochs[1].effectiveFromInclusive,
    topSensorMovedAt,
    "production V2 epoch starts at the canonical move timestamp",
  );
  assert(
    !areTimestampsInSameSensorGeometryEpoch(
      "2026-08-05T13:59:59.000Z",
      topSensorMovedAt,
    ),
    "learning window must not cross the production geometry boundary",
  );
  assert(
    areTimestampsInSameSensorGeometryEpoch(
      topSensorMovedAt,
      "2026-08-05T14:00:01.000Z",
    ),
    "timestamps inside V2 remain in the same learning epoch",
  );
  assertEqual(
    filterToLatestSensorGeometryEpoch([
      { created_at: "2026-08-05T13:59:59.000Z", value: "V1" },
      { created_at: topSensorMovedAt, value: "V2 start" },
      { created_at: "2026-08-05T14:00:01.000Z", value: "V2 latest" },
    ])
      .map((reading) => reading.value)
      .join(","),
    "V2 start,V2 latest",
    "mixed learning history keeps only the latest geometry epoch",
  );
}

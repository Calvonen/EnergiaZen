import {
  calculateValidationMetrics,
  exportReplayValidationCsv,
  validateReplay,
  type ReplayValidationStep,
} from "./replayValidation";
import { createSensorGeometryEpochs } from "./sensorGeometry";

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

function assertClose(actual: number | null, expected: number, message: string) {
  if (actual === null || Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${String(actual)}`);
  }
}

function createMetricStep({
  bottomMeasured,
  bottomModel,
  topMeasured,
  topModel,
}: {
  bottomMeasured: number;
  bottomModel: number;
  topMeasured: number;
  topModel: number;
}) {
  return {
    bottomMeasured,
    bottomModel,
    topMeasured,
    topModel,
  };
}

function createCsvStep(): ReplayValidationStep {
  return {
    bottomMeasured: 45,
    bottomModel: 44.5,
    heating: true,
    immediateEnergy: 10.5,
    physicsVersion: "energy-model-core-v1",
    quality: "valid",
    reserveEnergy: 1.5,
    sensorGeometryVersion: "V2",
    storedEnergy: 12,
    timestamp: "2026-08-01T12:00:00.000Z",
    topMeasured: 60,
    topModel: 59.5,
    uncertainty: 0,
    uncertaintyReasons: [],
    usableEnergy: 10.5,
  };
}

export function runReplayValidationUnitTests() {
  const metrics = calculateValidationMetrics([
    createMetricStep({
      bottomMeasured: 40,
      bottomModel: 39,
      topMeasured: 60,
      topModel: 58,
    }),
    createMetricStep({
      bottomMeasured: 42,
      bottomModel: 45,
      topMeasured: 61,
      topModel: 62,
    }),
  ]);

  assertClose(metrics.top.mae, 1.5, "top MAE is calculated correctly");
  assertClose(
    metrics.top.rmse,
    Math.round(Math.sqrt((4 + 1) / 2) * 1_000_000) / 1_000_000,
    "top RMSE is calculated correctly",
  );
  assertClose(metrics.top.maxError, 2, "top max error is calculated correctly");
  assertClose(metrics.bottom.mae, 2, "bottom MAE is calculated correctly");
  assertClose(
    metrics.bottom.rmse,
    Math.round(Math.sqrt((1 + 9) / 2) * 1_000_000) / 1_000_000,
    "bottom RMSE is calculated correctly",
  );
  assertClose(metrics.bottom.maxError, 3, "bottom max error is calculated correctly");

  const csv = exportReplayValidationCsv([createCsvStep()]);
  const csvLines = csv.split("\n");

  assertEqual(
    csvLines[0],
    "timestamp,topMeasured,topModel,bottomMeasured,bottomModel,storedEnergy,usableEnergy,immediateEnergy,reserveEnergy,heating,quality,uncertainty,sensorGeometryVersion,physicsVersion",
    "CSV header includes validation columns",
  );
  assertEqual(
    csvLines[1],
    "2026-08-01T12:00:00.000Z,60,59.5,45,44.5,12,10.5,10.5,1.5,true,valid,0,V2,energy-model-core-v1",
    "CSV row serializes validation values",
  );

  const validation = validateReplay({
    readings: [
      {
        bottom_temp: 60,
        created_at: "2026-08-01T12:00:00.000Z",
        heating: false,
        inlet_temp: 12,
        top_temp: 65,
      },
      {
        created_at: "2026-08-01T13:00:00.000Z",
        heating: true,
        inlet_temp: 12,
      },
      {
        bottom_temp: 40,
        created_at: "2026-08-01T13:10:00.000Z",
        heating: false,
        inlet_temp: 12,
        top_temp: 50,
      },
      {
        bottom_temp: 39,
        created_at: "2026-08-01T13:20:00.000Z",
        heating: false,
        inlet_temp: 12,
        top_temp: 49,
      },
    ],
    sensorGeometryEpochs: createSensorGeometryEpochs({
      topSensorMovedAt: "2026-08-01T00:00:00.000Z",
    }),
  });

  assertEqual(validation.report.observationCount, 4, "Replay Report includes observation count");
  assertEqual(validation.report.durationMinutes, 80, "Replay Report includes replay duration");
  assert(
    validation.report.energyRanges.storedEnergy.min !== null &&
      validation.report.energyRanges.storedEnergy.max !== null &&
      validation.report.energyRanges.storedEnergy.max >=
        validation.report.energyRanges.storedEnergy.min,
    "Replay Report includes stored energy range",
  );
  assertEqual(
    validation.report.physicsVersion,
    "energy-model-core-v1",
    "Replay Report includes physics version",
  );
  assertEqual(
    validation.report.sensorGeometryVersions.join(","),
    "V2",
    "Replay Report includes sensor geometry version",
  );
  assertEqual(
    validation.report.eventCounts["heating-start"],
    1,
    "Event Detection finds heating start",
  );
  assertEqual(
    validation.report.eventCounts["heating-stop"],
    1,
    "Event Detection finds heating stop",
  );
  assert(
    validation.report.eventCounts["water-draw"] >= 1,
    "Event Detection finds water draw",
  );
  assert(
    validation.events.some((event) => event.type === "water-draw"),
    "Validation API returns water-draw event details",
  );
  assert(
    validation.visualizationData.length === validation.report.observationCount,
    "Validation API returns visualization data for each replay step",
  );
  assert(
    validation.csv.includes("sensorGeometryVersion,physicsVersion"),
    "Validation API returns CSV export",
  );
}

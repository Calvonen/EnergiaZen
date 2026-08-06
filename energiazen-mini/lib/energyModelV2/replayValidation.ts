import {
  advanceState,
  createTankObservationFromReplayStep,
  runEnergyModelCoreReplay,
  type TankState,
} from "./energyModelCore";
import type { SensorGeometryVersion } from "./sensorGeometry";
import type { SensorGeometryEpoch } from "./sensorGeometry";
import type { EnergyModelPhysicsVersion } from "./tankDna";
import type { TankTemperatureReading } from "../tankTemperatureForecast";

export type SensorValidationMetrics = {
  mae: number | null;
  maxError: number | null;
  rmse: number | null;
  sampleCount: number;
};

export type ReplayValidationMetrics = {
  bottom: SensorValidationMetrics;
  top: SensorValidationMetrics;
};

export type ReplayValidationEventType =
  | "heating-start"
  | "heating-stop"
  | "invalid-observation"
  | "large-mixing-event"
  | "uncertain-period"
  | "water-draw";

export type ReplayValidationEvent = {
  details: string;
  timestamp: string;
  type: ReplayValidationEventType;
};

export type ReplayVisualizationPoint = {
  bottomMeasured: number | null;
  bottomModel: number | null;
  heating: boolean | null;
  storedEnergy: number | null;
  timestamp: string;
  topMeasured: number | null;
  topModel: number | null;
  usableEnergy: number | null;
};

export type ReplayValidationStep = ReplayVisualizationPoint & {
  immediateEnergy: number | null;
  physicsVersion: EnergyModelPhysicsVersion;
  quality: TankState["quality"] | "missing-state";
  reserveEnergy: number | null;
  sensorGeometryVersion: SensorGeometryVersion;
  uncertainty: number | null;
  uncertaintyReasons: string[];
};

export type ReplayValidationReport = {
  averageUncertainty: number | null;
  durationMinutes: number;
  energyRanges: {
    immediateEnergy: ValueRange;
    reserveEnergy: ValueRange;
    storedEnergy: ValueRange;
    usableEnergy: ValueRange;
  };
  eventCounts: Record<ReplayValidationEventType, number>;
  invalidObservations: number;
  metrics: ReplayValidationMetrics;
  modelVersion: "EnergyModelV2";
  observationCount: number;
  physicsVersion: EnergyModelPhysicsVersion;
  sensorGeometryVersions: SensorGeometryVersion[];
  tankDnaVersion: string | null;
};

export type ReplayValidationResult = {
  csv: string;
  events: ReplayValidationEvent[];
  metrics: ReplayValidationMetrics;
  report: ReplayValidationReport;
  steps: ReplayValidationStep[];
  visualizationData: ReplayVisualizationPoint[];
};

type ValueRange = {
  max: number | null;
  min: number | null;
};

type ErrorSample = {
  measured: number;
  model: number;
};

export function validateReplay({
  readings,
  sensorGeometryEpochs,
}: {
  readings: TankTemperatureReading[];
  sensorGeometryEpochs: SensorGeometryEpoch[];
}): ReplayValidationResult {
  const replay = runEnergyModelCoreReplay({ readings, sensorGeometryEpochs });
  const physicsVersion = "energy-model-core-v1";
  const steps = replay.steps.map((step, index) => {
    const previousState = replay.steps[index - 1]?.state ?? null;
    const predictionState = previousState && step.segmentMinutes !== null
      ? advanceState(
          previousState,
          {
            ...createTankObservationFromReplayStep(step),
            bottomTempC: null,
            topTempC: null,
          },
          step.segmentMinutes,
        )
      : step.state;

    return createValidationStep({
      physicsVersion,
      predictionState,
      reading: step.reading,
      sensorGeometryVersion: step.geometry.version,
      state: step.state,
    });
  });
  const events = detectReplayValidationEvents(steps);
  const metrics = calculateValidationMetrics(steps);
  const report = createReplayValidationReport({
    events,
    metrics,
    physicsVersion,
    steps,
  });

  return {
    csv: exportReplayValidationCsv(steps),
    events,
    metrics,
    report,
    steps,
    visualizationData: steps.map((step) => ({
      bottomMeasured: step.bottomMeasured,
      bottomModel: step.bottomModel,
      heating: step.heating,
      storedEnergy: step.storedEnergy,
      timestamp: step.timestamp,
      topMeasured: step.topMeasured,
      topModel: step.topModel,
      usableEnergy: step.usableEnergy,
    })),
  };
}

export function calculateValidationMetrics(
  steps: Pick<
    ReplayValidationStep,
    "bottomMeasured" | "bottomModel" | "topMeasured" | "topModel"
  >[],
): ReplayValidationMetrics {
  return {
    bottom: calculateSensorValidationMetrics(
      steps
        .map((step) => createErrorSample(step.bottomMeasured, step.bottomModel))
        .filter((sample): sample is ErrorSample => sample !== null),
    ),
    top: calculateSensorValidationMetrics(
      steps
        .map((step) => createErrorSample(step.topMeasured, step.topModel))
        .filter((sample): sample is ErrorSample => sample !== null),
    ),
  };
}

export function exportReplayValidationCsv(steps: ReplayValidationStep[]) {
  const header = [
    "timestamp",
    "topMeasured",
    "topModel",
    "bottomMeasured",
    "bottomModel",
    "storedEnergy",
    "usableEnergy",
    "immediateEnergy",
    "reserveEnergy",
    "heating",
    "quality",
    "uncertainty",
    "sensorGeometryVersion",
    "physicsVersion",
  ];

  return [
    header.join(","),
    ...steps.map((step) =>
      [
        step.timestamp,
        formatCsvValue(step.topMeasured),
        formatCsvValue(step.topModel),
        formatCsvValue(step.bottomMeasured),
        formatCsvValue(step.bottomModel),
        formatCsvValue(step.storedEnergy),
        formatCsvValue(step.usableEnergy),
        formatCsvValue(step.immediateEnergy),
        formatCsvValue(step.reserveEnergy),
        formatCsvValue(step.heating),
        step.quality,
        formatCsvValue(step.uncertainty),
        step.sensorGeometryVersion,
        step.physicsVersion,
      ].join(","),
    ),
  ].join("\n");
}

function createValidationStep({
  physicsVersion,
  reading,
  sensorGeometryVersion,
  predictionState,
  state,
}: {
  physicsVersion: EnergyModelPhysicsVersion;
  reading: TankTemperatureReading & { created_at: string };
  sensorGeometryVersion: SensorGeometryVersion;
  predictionState: TankState | null;
  state: TankState | null;
}): ReplayValidationStep {
  const uncertainty = state
    ? state.uncertainty.energyKwh +
      state.uncertainty.topTemperatureC +
      state.uncertainty.bottomTemperatureC
    : null;

  return {
    bottomMeasured: finiteNumberOrNull(reading.bottom_temp),
    bottomModel: predictionState?.bottomNodeTemperatureC ?? null,
    heating: reading.heating ?? null,
    immediateEnergy: state?.immediateEnergy.kwh ?? null,
    physicsVersion,
    quality: state?.quality ?? "missing-state",
    reserveEnergy: state?.reserveEnergy.kwh ?? null,
    sensorGeometryVersion,
    storedEnergy: state?.storedEnergy.kwh ?? null,
    timestamp: reading.created_at,
    topMeasured: finiteNumberOrNull(reading.top_temp),
    topModel: predictionState?.topNodeTemperatureC ?? null,
    uncertainty,
    uncertaintyReasons: state?.uncertainty.reasons ?? [],
    usableEnergy: state?.usableEnergy.kwh ?? null,
  };
}

function detectReplayValidationEvents(
  steps: ReplayValidationStep[],
): ReplayValidationEvent[] {
  const events: ReplayValidationEvent[] = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const previous = steps[index - 1] ?? null;

    if (previous?.heating !== true && step.heating === true) {
      events.push({
        details: "Heating changed from not-heating/unknown to heating.",
        timestamp: step.timestamp,
        type: "heating-start",
      });
    }
    if (previous?.heating === true && step.heating === false) {
      events.push({
        details: "Heating changed from heating to confirmed off.",
        timestamp: step.timestamp,
        type: "heating-stop",
      });
    }
    if (step.quality === "invalid") {
      events.push({
        details: "EnergyModelCore returned invalid state for this observation.",
        timestamp: step.timestamp,
        type: "invalid-observation",
      });
    }
    if (step.quality === "degraded") {
      events.push({
        details: "EnergyModelCore marked this period as uncertain.",
        timestamp: step.timestamp,
        type: "uncertain-period",
      });
    }
    if (isWaterDrawStep(step, previous)) {
      events.push({
        details: "Measured temperatures dropped below the model trend.",
        timestamp: step.timestamp,
        type: "water-draw",
      });
    }
    if (isLargeMixingStep(step, previous)) {
      events.push({
        details: "Measured stratification changed abruptly.",
        timestamp: step.timestamp,
        type: "large-mixing-event",
      });
    }
  }

  return events;
}

function createReplayValidationReport({
  events,
  metrics,
  physicsVersion,
  steps,
}: {
  events: ReplayValidationEvent[];
  metrics: ReplayValidationMetrics;
  physicsVersion: EnergyModelPhysicsVersion;
  steps: ReplayValidationStep[];
}): ReplayValidationReport {
  const timestamps = steps.map((step) => new Date(step.timestamp).getTime());
  const durationMinutes = timestamps.length >= 2
    ? (timestamps[timestamps.length - 1] - timestamps[0]) / 60000
    : 0;
  const eventCounts = createEmptyEventCounts();

  for (const event of events) {
    eventCounts[event.type] += 1;
  }

  return {
    averageUncertainty: average(
      steps
        .map((step) => step.uncertainty)
        .filter((value): value is number => value !== null),
    ),
    durationMinutes,
    energyRanges: {
      immediateEnergy: calculateValueRange(steps.map((step) => step.immediateEnergy)),
      reserveEnergy: calculateValueRange(steps.map((step) => step.reserveEnergy)),
      storedEnergy: calculateValueRange(steps.map((step) => step.storedEnergy)),
      usableEnergy: calculateValueRange(steps.map((step) => step.usableEnergy)),
    },
    eventCounts,
    invalidObservations: steps.filter((step) => step.quality === "invalid").length,
    metrics,
    modelVersion: "EnergyModelV2",
    observationCount: steps.length,
    physicsVersion,
    sensorGeometryVersions: [...new Set(steps.map((step) => step.sensorGeometryVersion))],
    tankDnaVersion: null,
  };
}

function calculateSensorValidationMetrics(
  samples: ErrorSample[],
): SensorValidationMetrics {
  if (samples.length === 0) {
    return { mae: null, maxError: null, rmse: null, sampleCount: 0 };
  }

  const absoluteErrors = samples.map((sample) =>
    Math.abs(sample.measured - sample.model),
  );
  const squaredErrors = samples.map((sample) =>
    (sample.measured - sample.model) ** 2,
  );

  return {
    mae: roundMetric(average(absoluteErrors) as number),
    maxError: roundMetric(Math.max(...absoluteErrors)),
    rmse: roundMetric(Math.sqrt((average(squaredErrors) as number))),
    sampleCount: samples.length,
  };
}

function createErrorSample(
  measured: number | null,
  model: number | null,
): ErrorSample | null {
  if (measured === null || model === null) {
    return null;
  }

  return { measured, model };
}

function isWaterDrawStep(
  step: ReplayValidationStep,
  previous: ReplayValidationStep | null,
) {
  if (!previous) {
    return false;
  }

  const topDrop = calculateDrop(previous.topMeasured, step.topMeasured);
  const bottomDrop = calculateDrop(previous.bottomMeasured, step.bottomMeasured);

  return (
    step.uncertaintyReasons.includes(
      "water-draw-or-mixing-corrected-from-sensors",
    ) ||
    topDrop >= 5 ||
    bottomDrop >= 5
  );
}

function isLargeMixingStep(
  step: ReplayValidationStep,
  previous: ReplayValidationStep | null,
) {
  if (!previous) {
    return false;
  }
  if (
    step.topMeasured === null ||
    step.bottomMeasured === null ||
    previous.topMeasured === null ||
    previous.bottomMeasured === null
  ) {
    return false;
  }

  const previousStratification = previous.topMeasured - previous.bottomMeasured;
  const currentStratification = step.topMeasured - step.bottomMeasured;

  return Math.abs(currentStratification - previousStratification) >= 10;
}

function createEmptyEventCounts(): Record<ReplayValidationEventType, number> {
  return {
    "heating-start": 0,
    "heating-stop": 0,
    "invalid-observation": 0,
    "large-mixing-event": 0,
    "uncertain-period": 0,
    "water-draw": 0,
  };
}

function calculateDrop(previous: number | null, current: number | null) {
  if (previous === null || current === null) {
    return 0;
  }

  return previous - current;
}

function calculateValueRange(values: Array<number | null>): ValueRange {
  const finiteValues = values.filter((value): value is number => value !== null);

  if (finiteValues.length === 0) {
    return { max: null, min: null };
  }

  return {
    max: Math.max(...finiteValues),
    min: Math.min(...finiteValues),
  };
}

function average(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteNumberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatCsvValue(value: boolean | number | string | null) {
  if (value === null) {
    return "";
  }

  return String(value);
}

function roundMetric(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

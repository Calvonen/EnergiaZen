import {
  calculateTankStateFromObservation,
  type TankState,
} from "./energyModelCore";
import type { ReplayReading } from "./replayEngine";
import type { SensorGeometryEpoch } from "./sensorGeometry";
import { detectsWaterDraw } from "../waterDrawDetection";

const MAX_SEGMENT_MINUTES = 2;
const MIN_OBSERVATION_MINUTES = 10;
const MAX_INLET_CHANGE_C = 1;
const MAX_SENSOR_CHANGE_C = 0.75;
const MAX_SENSOR_RISE_C = 0.2;
const MAX_NATURAL_LOSS_KWH_PER_HOUR = 0.5;

export type HeatLossObservation = {
  bottomNodeTemperatureC: number;
  durationMinutes: number;
  endedAt: string;
  energyLossKwh: number;
  energyLossKwhPerHour: number;
  estimatedInletTemperatureC: number;
  startedAt: string;
  storedEnergyEndKwh: number;
  storedEnergyStartKwh: number;
  topNodeTemperatureC: number;
  usableEnergyEndKwh: number;
  usableEnergyStartKwh: number;
};

export type HeatLossDiagnostics = {
  averageLossKwhPerHour: number | null;
  latestObservation: HeatLossObservation | null;
  maximumLossKwhPerHour: number | null;
  minimumLossKwhPerHour: number | null;
  observations: HeatLossObservation[];
};

type DiagnosticStep = {
  geometry: SensorGeometryEpoch;
  reading: ReplayReading;
  segmentMinutes: number | null;
  state: TankState | null;
};

/** Collects conservative no-heating periods without feeding data back to replay. */
export function collectHeatLossDiagnostics(steps: DiagnosticStep[]): HeatLossDiagnostics {
  const observations: HeatLossObservation[] = [];
  let candidateStartIndex: number | null = null;

  const finishCandidate = (endIndex: number) => {
    if (candidateStartIndex === null || endIndex <= candidateStartIndex) return;
    const observation = createObservation(
      steps.slice(candidateStartIndex, endIndex + 1),
    );
    if (observation) observations.push(observation);
  };

  for (let index = 1; index < steps.length; index += 1) {
    if (isCleanTransition(steps[index - 1], steps[index])) {
      candidateStartIndex ??= index - 1;
      continue;
    }
    finishCandidate(index - 1);
    candidateStartIndex = null;
  }
  finishCandidate(steps.length - 1);

  const rates = observations.map(({ energyLossKwhPerHour }) => energyLossKwhPerHour);
  return {
    averageLossKwhPerHour: rates.length
      ? round(rates.reduce((sum, rate) => sum + rate, 0) / rates.length)
      : null,
    latestObservation: observations[observations.length - 1] ?? null,
    maximumLossKwhPerHour: rates.length ? Math.max(...rates) : null,
    minimumLossKwhPerHour: rates.length ? Math.min(...rates) : null,
    observations,
  };
}

function isCleanTransition(previous: DiagnosticStep, current: DiagnosticStep) {
  if (
    previous.reading.heating !== false || current.reading.heating !== false ||
    previous.state?.quality !== "valid" || current.state?.quality !== "valid" ||
    current.segmentMinutes === null || current.segmentMinutes <= 0 ||
    current.segmentMinutes > MAX_SEGMENT_MINUTES
  ) return false;

  const values = [
    previous.state.inletTemperatureC, current.state.inletTemperatureC,
    previous.state.topNodeTemperatureC, current.state.topNodeTemperatureC,
    previous.state.bottomNodeTemperatureC, current.state.bottomNodeTemperatureC,
  ];
  if (!values.every(isFiniteNumber)) return false;

  return (
    Math.abs(current.state.inletTemperatureC! - previous.state.inletTemperatureC!) < MAX_INLET_CHANGE_C &&
    Math.abs(current.state.topNodeTemperatureC! - previous.state.topNodeTemperatureC!) <= MAX_SENSOR_CHANGE_C &&
    Math.abs(current.state.bottomNodeTemperatureC! - previous.state.bottomNodeTemperatureC!) <= MAX_SENSOR_CHANGE_C
  );
}

function createObservation(candidateSteps: DiagnosticStep[]): HeatLossObservation | null {
  const start = candidateSteps[0];
  const end = candidateSteps[candidateSteps.length - 1];
  if (!start.state || !end.state) return null;
  const inletBaselineC = start.state.inletTemperatureC;
  if (!isFiniteNumber(inletBaselineC)) return null;
  const startEnergyState = calculateEnergyStateWithInletBaseline(
    start,
    inletBaselineC,
  );
  const endEnergyState = calculateEnergyStateWithInletBaseline(
    end,
    inletBaselineC,
  );
  if (!startEnergyState || !endEnergyState) return null;
  const durationMinutes = (new Date(end.reading.created_at).getTime() - new Date(start.reading.created_at).getTime()) / 60000;
  const energyLossKwh = startEnergyState.storedEnergy.kwh - endEnergyState.storedEnergy.kwh;
  const lossRate = energyLossKwh / (durationMinutes / 60);

  if (
    durationMinutes < MIN_OBSERVATION_MINUTES || energyLossKwh <= 0 || lossRate <= 0 ||
    lossRate > MAX_NATURAL_LOSS_KWH_PER_HOUR ||
    candidateSteps.some((step) => !isFiniteNumber(step.reading.inlet_temp)) ||
    detectsWaterDraw(candidateSteps.map((step) => ({
      inletTemperatureC: step.reading.inlet_temp as number,
      time: new Date(step.reading.created_at).getTime(),
    }))) ||
    candidateSteps.some((step) =>
      !step.state ||
      !isFiniteNumber(step.state.topNodeTemperatureC) ||
      !isFiniteNumber(step.state.bottomNodeTemperatureC) ||
      step.state.topNodeTemperatureC > start.state!.topNodeTemperatureC! + MAX_SENSOR_RISE_C ||
      step.state.bottomNodeTemperatureC > start.state!.bottomNodeTemperatureC! + MAX_SENSOR_RISE_C
    ) ||
    !isFiniteNumber(start.state.topNodeTemperatureC) ||
    !isFiniteNumber(start.state.bottomNodeTemperatureC)
  ) return null;

  return {
    bottomNodeTemperatureC: start.state.bottomNodeTemperatureC,
    durationMinutes: round(durationMinutes),
    endedAt: end.reading.created_at,
    energyLossKwh: round(energyLossKwh),
    energyLossKwhPerHour: round(lossRate),
    estimatedInletTemperatureC: inletBaselineC,
    startedAt: start.reading.created_at,
    storedEnergyEndKwh: endEnergyState.storedEnergy.kwh,
    storedEnergyStartKwh: startEnergyState.storedEnergy.kwh,
    topNodeTemperatureC: start.state.topNodeTemperatureC,
    usableEnergyEndKwh: endEnergyState.usableEnergy.kwh,
    usableEnergyStartKwh: startEnergyState.usableEnergy.kwh,
  };
}

function calculateEnergyStateWithInletBaseline(
  step: DiagnosticStep,
  inletBaselineC: number,
) {
  if (
    !step.state ||
    !isFiniteNumber(step.state.topNodeTemperatureC) ||
    !isFiniteNumber(step.state.bottomNodeTemperatureC)
  ) return null;

  return calculateTankStateFromObservation({
    geometry: step.geometry,
    observation: {
      bottomTempC: step.state.bottomNodeTemperatureC,
      heating: false,
      inletTempC: inletBaselineC,
      timestamp: step.reading.created_at,
      topTempC: step.state.topNodeTemperatureC,
    },
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

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
  acceptance: HeatLossAcceptanceDiagnostics;
  averageLossKwhPerHour: number | null;
  latestObservation: HeatLossObservation | null;
  maximumLossKwhPerHour: number | null;
  minimumLossKwhPerHour: number | null;
  observations: HeatLossObservation[];
};

export type HeatLossRejectionReason =
  | "heating_detected"
  | "water_draw"
  | "inlet_temperature_change"
  | "missing_inlet_data"
  | "rapid_temperature_change"
  | "too_short"
  | "measurement_gap";

export type RejectedHeatLossObservation = {
  endedAt: string;
  reason: HeatLossRejectionReason;
  startedAt: string;
};

export type HeatLossAcceptanceDiagnostics = {
  acceptedCount: number;
  examinedCount: number;
  latestRejections: RejectedHeatLossObservation[];
  rejectionCounts: Record<HeatLossRejectionReason, number>;
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
  const rejections: RejectedHeatLossObservation[] = [];
  let periodStartIndex = 0;
  let periodReason: HeatLossRejectionReason | null | undefined;

  const finishPeriod = (endIndex: number) => {
    if (endIndex <= periodStartIndex) return;
    const candidateSteps = steps.slice(periodStartIndex, endIndex + 1);
    const result = periodReason
      ? { reason: periodReason }
      : evaluateObservation(candidateSteps);
    if ("observation" in result) observations.push(result.observation);
    else rejections.push({
      endedAt: candidateSteps[candidateSteps.length - 1].reading.created_at,
      reason: result.reason,
      startedAt: candidateSteps[0].reading.created_at,
    });
  };

  for (let index = 1; index < steps.length; index += 1) {
    const reason = getTransitionRejectionReason(steps[index - 1], steps[index]);
    if (periodReason === undefined) {
      periodReason = reason;
      periodStartIndex = index - 1;
    } else if (reason !== periodReason) {
      finishPeriod(index - 1);
      periodStartIndex = index - 1;
      periodReason = reason;
    }
  }
  if (periodReason !== undefined) finishPeriod(steps.length - 1);

  const rates = observations.map(({ energyLossKwhPerHour }) => energyLossKwhPerHour);
  return {
    acceptance: {
      acceptedCount: observations.length,
      examinedCount: observations.length + rejections.length,
      latestRejections: rejections.slice(-3).reverse(),
      rejectionCounts: countRejections(rejections),
    },
    averageLossKwhPerHour: rates.length
      ? round(rates.reduce((sum, rate) => sum + rate, 0) / rates.length)
      : null,
    latestObservation: observations[observations.length - 1] ?? null,
    maximumLossKwhPerHour: rates.length ? Math.max(...rates) : null,
    minimumLossKwhPerHour: rates.length ? Math.min(...rates) : null,
    observations,
  };
}

function getTransitionRejectionReason(
  previous: DiagnosticStep,
  current: DiagnosticStep,
): HeatLossRejectionReason | null {
  if (previous.reading.heating !== false || current.reading.heating !== false) {
    return "heating_detected";
  }
  if (!isFiniteNumber(previous.reading.inlet_temp) || !isFiniteNumber(current.reading.inlet_temp)) {
    return "missing_inlet_data";
  }
  if (
    isFiniteNumber(previous.reading.top_temp) && isFiniteNumber(current.reading.top_temp) &&
    Math.abs(current.reading.top_temp - previous.reading.top_temp) > MAX_SENSOR_CHANGE_C ||
    isFiniteNumber(previous.reading.bottom_temp) && isFiniteNumber(current.reading.bottom_temp) &&
    Math.abs(current.reading.bottom_temp - previous.reading.bottom_temp) > MAX_SENSOR_CHANGE_C
  ) return "rapid_temperature_change";
  if (
    previous.state?.quality !== "valid" || current.state?.quality !== "valid" ||
    current.segmentMinutes === null || current.segmentMinutes <= 0 ||
    current.segmentMinutes > MAX_SEGMENT_MINUTES
  ) return "measurement_gap";

  const values = [
    previous.state.inletTemperatureC, current.state.inletTemperatureC,
    previous.state.topNodeTemperatureC, current.state.topNodeTemperatureC,
    previous.state.bottomNodeTemperatureC, current.state.bottomNodeTemperatureC,
  ];
  if (!values.every(isFiniteNumber)) return "measurement_gap";

  if (Math.abs(current.state.inletTemperatureC! - previous.state.inletTemperatureC!) >= MAX_INLET_CHANGE_C) {
    return "inlet_temperature_change";
  }
  if (
    Math.abs(current.state.topNodeTemperatureC! - previous.state.topNodeTemperatureC!) > MAX_SENSOR_CHANGE_C ||
    Math.abs(current.state.bottomNodeTemperatureC! - previous.state.bottomNodeTemperatureC!) > MAX_SENSOR_CHANGE_C
  ) return "rapid_temperature_change";
  return null;
}

function evaluateObservation(candidateSteps: DiagnosticStep[]):
  | { observation: HeatLossObservation }
  | { reason: HeatLossRejectionReason } {
  const start = candidateSteps[0];
  const end = candidateSteps[candidateSteps.length - 1];
  if (!start.state || !end.state) return { reason: "measurement_gap" };
  const inletBaselineC = start.state.inletTemperatureC;
  if (!isFiniteNumber(inletBaselineC)) return { reason: "missing_inlet_data" };
  const startEnergyState = calculateEnergyStateWithInletBaseline(
    start,
    inletBaselineC,
  );
  const endEnergyState = calculateEnergyStateWithInletBaseline(
    end,
    inletBaselineC,
  );
  if (!startEnergyState || !endEnergyState) return { reason: "measurement_gap" };
  const durationMinutes = (new Date(end.reading.created_at).getTime() - new Date(start.reading.created_at).getTime()) / 60000;
  const energyLossKwh = startEnergyState.storedEnergy.kwh - endEnergyState.storedEnergy.kwh;
  const lossRate = energyLossKwh / (durationMinutes / 60);

  if (durationMinutes < MIN_OBSERVATION_MINUTES) return { reason: "too_short" };
  if (energyLossKwh <= 0 || lossRate <= 0 || lossRate > MAX_NATURAL_LOSS_KWH_PER_HOUR) {
    return { reason: "rapid_temperature_change" };
  }
  if (candidateSteps.some((step) => !isFiniteNumber(step.reading.inlet_temp))) {
    return { reason: "missing_inlet_data" };
  }
  if (detectsWaterDraw(candidateSteps.map((step) => ({
      inletTemperatureC: step.reading.inlet_temp as number,
      time: new Date(step.reading.created_at).getTime(),
    })))) return { reason: "water_draw" };
  if (candidateSteps.some((step) =>
      !step.state ||
      !isFiniteNumber(step.state.topNodeTemperatureC) ||
      !isFiniteNumber(step.state.bottomNodeTemperatureC) ||
      step.state.topNodeTemperatureC > start.state!.topNodeTemperatureC! + MAX_SENSOR_RISE_C ||
      step.state.bottomNodeTemperatureC > start.state!.bottomNodeTemperatureC! + MAX_SENSOR_RISE_C
    )) return { reason: "rapid_temperature_change" };
  if (!isFiniteNumber(start.state.topNodeTemperatureC) || !isFiniteNumber(start.state.bottomNodeTemperatureC)) {
    return { reason: "measurement_gap" };
  }

  return { observation: {
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
  } };
}

function countRejections(rejections: RejectedHeatLossObservation[]) {
  const counts: Record<HeatLossRejectionReason, number> = {
    heating_detected: 0,
    inlet_temperature_change: 0,
    measurement_gap: 0,
    missing_inlet_data: 0,
    rapid_temperature_change: 0,
    too_short: 0,
    water_draw: 0,
  };
  rejections.forEach(({ reason }) => { counts[reason] += 1; });
  return counts;
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

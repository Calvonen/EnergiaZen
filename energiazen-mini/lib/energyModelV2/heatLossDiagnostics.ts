import {
  calculateTankStateFromObservation,
  type TankState,
} from "./energyModelCore";
import type { ReplayReading } from "./replayEngine";
import type { SensorGeometryEpoch } from "./sensorGeometry";
import { detectsWaterDraw, waterDrawDetectionLimits } from "../waterDrawDetection";

const MAX_SEGMENT_MINUTES = 2;
const MIN_OBSERVATION_MINUTES = 10;
const MAX_INLET_CHANGE_C = 1;
const MAX_SENSOR_CHANGE_C = 0.75;
const MAX_SENSOR_RISE_C = 0.2;
const MAX_NATURAL_LOSS_KWH_PER_HOUR = 0.5;
export const COLD_INLET_MARGIN_C = 2;
export const MIN_COLD_INLET_DURATION_MINUTES = 3;
export const INLET_RECOVERY_MARGIN_C = 4;
export const MIN_INLET_RECOVERY_DURATION_MINUTES = 3;
export const PRE_WATER_DRAW_GUARD_MINUTES = 20;

export type WaterDrawDetectionKind = "rapid_drop" | "cold_inlet";

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
  | "pre_water_draw_guard"
  | "inlet_recovery"
  | "inlet_temperature_change"
  | "missing_inlet_data"
  | "rapid_temperature_change"
  | "too_short"
  | "measurement_gap";

export type RejectedHeatLossObservation = {
  endedAt: string;
  reason: HeatLossRejectionReason;
  startedAt: string;
  waterDrawDetectionKind?: WaterDrawDetectionKind;
};

export type HeatLossAcceptanceDiagnostics = {
  acceptedCount: number;
  examinedCount: number;
  latestRejections: RejectedHeatLossObservation[];
  rejectionCounts: Record<HeatLossRejectionReason, number>;
  waterDrawDetectionCounts: Record<WaterDrawDetectionKind, number>;
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
  const coldInletPeriods = findColdInletPeriods(steps);
  const coldInletPeriodByStart = new Map(coldInletPeriods.map((period) => [period.startIndex, period]));
  const coldInletIndexes = new Set(coldInletPeriods.flatMap(({ startIndex, endIndex }) =>
    Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset)
  ));
  const waterDrawStartIndexes = findWaterDrawStartIndexes(steps, coldInletPeriods, coldInletIndexes);
  const preWaterDrawGuardIndexes = findPreWaterDrawGuardIndexes(steps, waterDrawStartIndexes);
  const preWaterDrawGuardPeriods = findContiguousPeriods(preWaterDrawGuardIndexes);
  let periodStartIndex: number | null = steps.length &&
    !getStepRejectionReason(steps[0]) && !coldInletIndexes.has(0) &&
    !preWaterDrawGuardIndexes.has(0) ? 0 : null;
  let recoveringAfterWaterDraw = false;
  let recoveryPeriodStartIndex: number | null = null;
  let warmRecoveryStartTime: number | null = null;

  const finishPeriod = (endIndex: number) => {
    if (periodStartIndex === null || endIndex <= periodStartIndex) return;
    const candidateSteps = steps.slice(periodStartIndex, endIndex + 1);
    const result = evaluateObservation(candidateSteps);
    if ("observation" in result) observations.push(result.observation);
    else rejections.push({
      endedAt: candidateSteps[candidateSteps.length - 1].reading.created_at,
      reason: result.reason,
      startedAt: candidateSteps[0].reading.created_at,
    });
  };

  const rejectBoundary = (
    reason: HeatLossRejectionReason,
    startIndex: number,
    endIndex: number,
    waterDrawDetectionKind?: WaterDrawDetectionKind,
  ) => rejections.push({
    endedAt: steps[endIndex].reading.created_at,
    reason,
    startedAt: steps[startIndex].reading.created_at,
    waterDrawDetectionKind,
  });

  const enterRecovery = (startIndex: number) => {
    recoveringAfterWaterDraw = true;
    recoveryPeriodStartIndex ??= startIndex;
    warmRecoveryStartTime = null;
    periodStartIndex = null;
  };

  const finishRecovery = (endIndex: number) => {
    if (recoveryPeriodStartIndex !== null && endIndex >= recoveryPeriodStartIndex) {
      rejectBoundary("inlet_recovery", recoveryPeriodStartIndex, endIndex);
    }
    recoveringAfterWaterDraw = false;
    recoveryPeriodStartIndex = null;
    warmRecoveryStartTime = null;
  };

  // Record each merged guard as one meaningful diagnostic segment. The guard
  // may contain another draw; merging prevents one event from producing a
  // rejection for every individual reading.
  preWaterDrawGuardPeriods.forEach(({ startIndex, endIndex }) =>
    rejectBoundary("pre_water_draw_guard", startIndex, endIndex));

  const initialColdPeriod = coldInletPeriodByStart.get(0);
  if (initialColdPeriod) {
    rejectBoundary("water_draw", 0, initialColdPeriod.endIndex, "cold_inlet");
    enterRecovery(initialColdPeriod.endIndex + 1);
  } else if (steps.length && periodStartIndex === null) {
    rejectBoundary(getStepRejectionReason(steps[0])!, 0, 0);
  }

  for (let index = 1; index < steps.length; index += 1) {
    const coldPeriod = coldInletPeriodByStart.get(index);
    if (coldPeriod) {
      finishPeriod(index - 1);
      rejectBoundary("water_draw", index, coldPeriod.endIndex, "cold_inlet");
      enterRecovery(coldPeriod.endIndex + 1);
      continue;
    }
    if (coldInletIndexes.has(index)) continue;

    const rapidDropStartsHere = waterDrawStartIndexes.has(index);
    if (rapidDropStartsHere) {
      finishPeriod(index - 1);
      rejectBoundary("water_draw", Math.max(0, index - 1), index, "rapid_drop");
      enterRecovery(index + 1);
      continue;
    }

    if (preWaterDrawGuardIndexes.has(index)) {
      finishPeriod(index - 1);
      periodStartIndex = null;
      continue;
    }

    if (recoveringAfterWaterDraw) {
      const stepReason = getStepRejectionReason(steps[index]);
      const transitionReason = stepReason ? null : getTransitionRejectionReason(
        steps[index - 1],
        steps[index],
        recentSteps(steps, index),
      );
      if (transitionReason === "water_draw") {
        rejectBoundary("water_draw", Math.max(0, index - 1), index, "rapid_drop");
        warmRecoveryStartTime = null;
        continue;
      }
      if (stepReason || transitionReason) {
        rejectBoundary(stepReason ?? transitionReason!, Math.max(0, index - 1), index);
        warmRecoveryStartTime = null;
        continue;
      }

      const rawInletC = steps[index].reading.inlet_temp;
      const estimatedInletC = steps[index].state?.inletTemperatureC;
      const time = new Date(steps[index].reading.created_at).getTime();
      const previousTime = new Date(steps[index - 1].reading.created_at).getTime();
      const isContinuouslyWarm = isFiniteNumber(rawInletC) && isFiniteNumber(estimatedInletC) &&
        rawInletC >= estimatedInletC + INLET_RECOVERY_MARGIN_C &&
        time > previousTime && time - previousTime <= MAX_SEGMENT_MINUTES * 60_000;
      if (!isContinuouslyWarm) {
        warmRecoveryStartTime = null;
        continue;
      }
      warmRecoveryStartTime ??= time;
      if (time - warmRecoveryStartTime < MIN_INLET_RECOVERY_DURATION_MINUTES * 60_000) continue;

      finishRecovery(index - 1);
      periodStartIndex = index;
      continue;
    }
    const stepReason = getStepRejectionReason(steps[index]);
    const transitionReason = stepReason ? null : getTransitionRejectionReason(
      steps[index - 1],
      steps[index],
      recentSteps(steps, index),
    );
    const candidateRise = periodStartIndex === null || stepReason || transitionReason
      ? false
      : hasRapidRise(steps[periodStartIndex], steps[index]);
    const reason = stepReason ?? transitionReason ?? (candidateRise ? "rapid_temperature_change" : null);

    if (reason) {
      finishPeriod(index - 1);
      rejectBoundary(reason, Math.max(0, index - 1), index,
        reason === "water_draw" ? "rapid_drop" : undefined);
      // A transition separates two valid readings. The current reading is the
      // first valid anchor on its far side; a bad reading itself is skipped.
      periodStartIndex = stepReason || reason === "water_draw" ? null : index;
      if (reason === "water_draw") enterRecovery(index + 1);
    } else if (periodStartIndex === null) {
      periodStartIndex = index;
    }
  }
  if (recoveringAfterWaterDraw) finishRecovery(steps.length - 1);
  finishPeriod(steps.length - 1);

  const rates = observations.map(({ energyLossKwhPerHour }) => energyLossKwhPerHour);
  return {
    acceptance: {
      acceptedCount: observations.length,
      examinedCount: observations.length + rejections.length,
      latestRejections: rejections.slice(-3).reverse(),
      rejectionCounts: countRejections(rejections),
      waterDrawDetectionCounts: countWaterDrawDetections(rejections),
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

function getStepRejectionReason(step: DiagnosticStep): HeatLossRejectionReason | null {
  if (step.reading.heating !== false) return "heating_detected";
  if (!isFiniteNumber(step.reading.inlet_temp)) return "missing_inlet_data";
  if (
    !isFiniteNumber(step.reading.top_temp) ||
    !isFiniteNumber(step.reading.bottom_temp) ||
    !step.state
  ) return "measurement_gap";
  return null;
}

type ColdInletPeriod = { startIndex: number; endIndex: number };

function findColdInletPeriods(steps: DiagnosticStep[]): ColdInletPeriod[] {
  const periods: ColdInletPeriod[] = [];
  let startIndex: number | null = null;
  let candidateBaselineC: number | null = null;
  let priorIdleBaselineC: number | null = null;

  const finish = (endIndex: number) => {
    if (startIndex === null) return;
    const durationMs = new Date(steps[endIndex].reading.created_at).getTime() -
      new Date(steps[startIndex].reading.created_at).getTime();
    if (durationMs >= MIN_COLD_INLET_DURATION_MINUTES * 60_000) {
      periods.push({ startIndex, endIndex });
    }
    startIndex = null;
    candidateBaselineC = null;
  };

  steps.forEach((step, index) => {
    const rawInletC = step.reading.inlet_temp;
    const estimatedInletC = step.state?.inletTemperatureC;
    const previousTime = index > 0 ? new Date(steps[index - 1].reading.created_at).getTime() : NaN;
    const currentTime = new Date(step.reading.created_at).getTime();
    const followsContinuously = startIndex === null || (
      currentTime > previousTime && currentTime - previousTime <= MAX_SEGMENT_MINUTES * 60_000
    );
    const isValid = !getStepRejectionReason(step) &&
      isFiniteNumber(rawInletC) && isFiniteNumber(estimatedInletC);
    const isCold = isValid && isFiniteNumber(candidateBaselineC) &&
      rawInletC <= candidateBaselineC + COLD_INLET_MARGIN_C;

    if (!isCold || !followsContinuously) finish(index - 1);
    if (
      startIndex === null && isValid && isFiniteNumber(priorIdleBaselineC) &&
      rawInletC <= priorIdleBaselineC + COLD_INLET_MARGIN_C
    ) {
      startIndex = index;
      candidateBaselineC = priorIdleBaselineC;
    } else if (
      startIndex === null && isValid &&
      rawInletC > estimatedInletC + COLD_INLET_MARGIN_C
    ) {
      // A baseline learned from this warm idle sample predates any later cold
      // candidate. A replay that starts cold therefore cannot self-seed a draw.
      priorIdleBaselineC = estimatedInletC;
    }
  });
  if (steps.length) finish(steps.length - 1);
  return periods;
}

function getTransitionRejectionReason(
  previous: DiagnosticStep,
  current: DiagnosticStep,
  waterDrawWindow: DiagnosticStep[],
): HeatLossRejectionReason | null {
  const elapsedMinutes = (
    new Date(current.reading.created_at).getTime() -
    new Date(previous.reading.created_at).getTime()
  ) / 60_000;
  if (
    !Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0 ||
    elapsedMinutes > MAX_SEGMENT_MINUTES
  ) return "measurement_gap";
  if (getStepRejectionReason(previous)) return null;
  if (currentSampleStartsWaterDraw(waterDrawWindow)) return "water_draw";
  if (
    isFiniteNumber(previous.reading.top_temp) && isFiniteNumber(current.reading.top_temp) &&
    Math.abs(current.reading.top_temp - previous.reading.top_temp) > MAX_SENSOR_CHANGE_C ||
    isFiniteNumber(previous.reading.bottom_temp) && isFiniteNumber(current.reading.bottom_temp) &&
    Math.abs(current.reading.bottom_temp - previous.reading.bottom_temp) > MAX_SENSOR_CHANGE_C
  ) return "rapid_temperature_change";
  if (
    previous.state?.quality !== "valid" || current.state?.quality !== "valid"
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

function currentSampleStartsWaterDraw(waterDrawWindow: DiagnosticStep[]) {
  const current = waterDrawWindow[waterDrawWindow.length - 1].reading.inlet_temp;
  const previous = waterDrawWindow[waterDrawWindow.length - 2]?.reading.inlet_temp;
  if (
    !isFiniteNumber(current) ||
    !isFiniteNumber(previous) ||
    current >= previous
  ) return false;

  return waterDrawWindow.slice(0, -1).some(({ reading }) =>
    isFiniteNumber(reading.inlet_temp) &&
    reading.inlet_temp - current >= waterDrawDetectionLimits.minDropCelsius
  );
}

function recentSteps(steps: DiagnosticStep[], endIndex: number) {
  const endTime = new Date(steps[endIndex].reading.created_at).getTime();
  let startIndex = endIndex;
  while (
    startIndex > 0 &&
    endTime - new Date(steps[startIndex - 1].reading.created_at).getTime() <=
      waterDrawDetectionLimits.windowMinutes * 60_000
  ) startIndex -= 1;
  return steps.slice(startIndex, endIndex + 1);
}

function findWaterDrawStartIndexes(
  steps: DiagnosticStep[],
  coldInletPeriods: ColdInletPeriod[],
  coldInletIndexes: Set<number>,
) {
  const indexes = new Set(coldInletPeriods.map(({ startIndex }) => startIndex));
  for (let index = 1; index < steps.length; index += 1) {
    if (coldInletIndexes.has(index) || getStepRejectionReason(steps[index])) continue;
    const elapsedMs = new Date(steps[index].reading.created_at).getTime() -
      new Date(steps[index - 1].reading.created_at).getTime();
    if (
      elapsedMs > 0 && elapsedMs <= MAX_SEGMENT_MINUTES * 60_000 &&
      !getStepRejectionReason(steps[index - 1]) &&
      currentSampleStartsWaterDraw(recentSteps(steps, index))
    ) indexes.add(index);
  }
  return indexes;
}

function findPreWaterDrawGuardIndexes(steps: DiagnosticStep[], waterDrawStartIndexes: Set<number>) {
  const indexes = new Set<number>();
  waterDrawStartIndexes.forEach((waterDrawStartIndex) => {
    const startTime = new Date(steps[waterDrawStartIndex].reading.created_at).getTime();
    const cutoffTime = startTime - PRE_WATER_DRAW_GUARD_MINUTES * 60_000;
    // The sample on the cutoff is retained as the clean candidate's final
    // anchor. Every later pre-draw sample is protected.
    steps.forEach((step, index) => {
      const time = new Date(step.reading.created_at).getTime();
      if (time > cutoffTime && time < startTime) indexes.add(index);
    });
  });
  return indexes;
}

function findContiguousPeriods(indexes: Set<number>) {
  const sorted = [...indexes].sort((a, b) => a - b);
  const periods: { startIndex: number; endIndex: number }[] = [];
  sorted.forEach((index) => {
    const latest = periods[periods.length - 1];
    if (latest && index === latest.endIndex + 1) latest.endIndex = index;
    else periods.push({ startIndex: index, endIndex: index });
  });
  return periods;
}

function hasRapidRise(start: DiagnosticStep, current: DiagnosticStep) {
  return isFiniteNumber(start.state?.topNodeTemperatureC) &&
    isFiniteNumber(start.state?.bottomNodeTemperatureC) &&
    isFiniteNumber(current.state?.topNodeTemperatureC) &&
    isFiniteNumber(current.state?.bottomNodeTemperatureC) && (
      current.state.topNodeTemperatureC > start.state.topNodeTemperatureC + MAX_SENSOR_RISE_C ||
      current.state.bottomNodeTemperatureC > start.state.bottomNodeTemperatureC + MAX_SENSOR_RISE_C
    );
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
    inlet_recovery: 0,
    measurement_gap: 0,
    missing_inlet_data: 0,
    rapid_temperature_change: 0,
    pre_water_draw_guard: 0,
    too_short: 0,
    water_draw: 0,
  };
  rejections.forEach(({ reason }) => { counts[reason] += 1; });
  return counts;
}

function countWaterDrawDetections(rejections: RejectedHeatLossObservation[]) {
  const counts: Record<WaterDrawDetectionKind, number> = {
    cold_inlet: 0,
    rapid_drop: 0,
  };
  rejections.forEach(({ waterDrawDetectionKind }) => {
    if (waterDrawDetectionKind) counts[waterDrawDetectionKind] += 1;
  });
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

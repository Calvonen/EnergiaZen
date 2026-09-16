import { detectsWaterDraw } from "../_shared/waterDrawDetection.ts";

export type LiveDrawReading = {
  created_at: string;
  top_temp: number | null;
  bottom_temp: number | null;
  inlet_temp: number | null;
  heating: boolean | null;
};

export type LiveReliableDraw = {
  event_started_at: string;
  event_ended_at: string;
};

export type LiveDrawReanchorResolution = {
  detectedUnlabeledDrawCount: number;
  reanchorIndexes: number[];
  unresolved: boolean;
};

// Keep these deliberately aligned with the existing V2 heat-loss/water-draw
// diagnostics. The live shadow is more conservative than the diagnostic: it
// does not guess removed kWh for an unlabeled draw. It waits for inlet
// recovery plus a quiet tank period, then re-anchors the physical balance to
// the measured post-draw state.
const INLET_RECOVERY_MARGIN_C = 4;
const MIN_INLET_RECOVERY_DURATION_MINUTES = 3;
const MIN_TANK_STABILIZATION_MINUTES = 15;
const MAX_SENSOR_CHANGE_C = 0.75;
const MAX_SEGMENT_MINUTES = 2;
const LABEL_MATCH_MARGIN_MINUTES = 5;
const HEATING_DRAW_RESPONSE_TOLERANCE_C = 0.05;

export function resolveLiveDrawReanchors({
  coldInletBaselineC,
  readings,
  reliableDraws,
}: {
  coldInletBaselineC: number;
  readings: LiveDrawReading[];
  reliableDraws: LiveReliableDraw[];
}): LiveDrawReanchorResolution {
  if (!Number.isFinite(coldInletBaselineC) || readings.length < 2) {
    return { detectedUnlabeledDrawCount: 0, reanchorIndexes: [], unresolved: false };
  }

  const reanchorIndexes: number[] = [];
  let detectedUnlabeledDrawCount = 0;
  let mode: "normal" | "recovery" | "stabilizing" = "normal";
  let warmRecoveryStartMs: number | null = null;
  let stableTankStartMs: number | null = null;

  for (let index = 1; index < readings.length; index += 1) {
    const current = readings[index];
    const previous = readings[index - 1];
    const currentMs = Date.parse(current.created_at);
    const previousMs = Date.parse(previous.created_at);
    if (!Number.isFinite(currentMs) || !Number.isFinite(previousMs) || currentMs <= previousMs) {
      if (mode !== "normal") {
        warmRecoveryStartMs = null;
        stableTankStartMs = null;
      }
      continue;
    }

    const drawDetected = currentSampleHasDrawSignal(readings, index);
    const matchedReliableDraw = drawDetected && isMatchedByReliableDraw(currentMs, reliableDraws);
    const unmatchedDraw = drawDetected && !matchedReliableDraw;

    if (mode === "normal") {
      if (unmatchedDraw) {
        detectedUnlabeledDrawCount += 1;
        mode = "recovery";
        warmRecoveryStartMs = null;
        stableTankStartMs = null;
      }
      continue;
    }

    if (unmatchedDraw) {
      if (mode !== "recovery") detectedUnlabeledDrawCount += 1;
      mode = "recovery";
      warmRecoveryStartMs = null;
      stableTankStartMs = null;
      continue;
    }

    if (mode === "recovery") {
      const inletC = current.inlet_temp;
      const gapMinutes = (currentMs - previousMs) / 60_000;
      const continuouslyWarm =
        typeof inletC === "number" &&
        Number.isFinite(inletC) &&
        inletC >= coldInletBaselineC + INLET_RECOVERY_MARGIN_C &&
        gapMinutes > 0 &&
        gapMinutes <= MAX_SEGMENT_MINUTES;

      if (!continuouslyWarm || current.heating === true) {
        warmRecoveryStartMs = null;
        continue;
      }

      warmRecoveryStartMs ??= currentMs;
      if (currentMs - warmRecoveryStartMs < MIN_INLET_RECOVERY_DURATION_MINUTES * 60_000) {
        continue;
      }

      mode = "stabilizing";
      stableTankStartMs = currentMs;
      continue;
    }

    // Stabilization is intentionally strict. Any heating, sampling gap or
    // rapid tank-sensor movement resets the quiet-period clock. We stay in
    // stabilizing mode so the shadow can recover once the tank is quiet again.
    const gapMinutes = (currentMs - previousMs) / 60_000;
    const stableTransition =
      current.heating !== true &&
      gapMinutes > 0 &&
      gapMinutes <= MAX_SEGMENT_MINUTES &&
      finiteTemperature(current.top_temp) &&
      finiteTemperature(previous.top_temp) &&
      finiteTemperature(current.bottom_temp) &&
      finiteTemperature(previous.bottom_temp) &&
      Math.abs((current.top_temp as number) - (previous.top_temp as number)) <= MAX_SENSOR_CHANGE_C &&
      Math.abs((current.bottom_temp as number) - (previous.bottom_temp as number)) <= MAX_SENSOR_CHANGE_C;

    if (!stableTransition) {
      stableTankStartMs = null;
      continue;
    }

    stableTankStartMs ??= currentMs;
    if (currentMs - stableTankStartMs < MIN_TANK_STABILIZATION_MINUTES * 60_000) {
      continue;
    }

    reanchorIndexes.push(index);
    mode = "normal";
    warmRecoveryStartMs = null;
    stableTankStartMs = null;
  }

  return {
    detectedUnlabeledDrawCount,
    reanchorIndexes,
    unresolved: mode !== "normal",
  };
}

function currentSampleHasDrawSignal(readings: LiveDrawReading[], index: number) {
  const currentTime = Date.parse(readings[index].created_at);
  const windowStartMs = currentTime - 5 * 60_000;
  const window = readings
    .slice(0, index + 1)
    .filter((reading) => Date.parse(reading.created_at) >= windowStartMs);
  const inletSamples = window.map((reading) => ({
    inletTemperatureC: reading.inlet_temp,
    time: Date.parse(reading.created_at),
  }));

  if (inletSamples.length < 2 || !detectsWaterDraw(inletSamples)) {
    return false;
  }

  // Production showed the stagnant inlet probe cycling cold while the 3 kW
  // heater was continuously on. During that event the bottom sensor kept
  // rising monotonically, which is the opposite of a cold-water replacement
  // response. Do not turn that heater-only inlet oscillation into an
  // unresolved draw. This suppression is deliberately fail-closed: every
  // sample in the full detection window must be heating, every bottom reading
  // must be finite, adjacent samples must be contiguous, and the bottom
  // temperature must not fall materially. A gap, interrupted heating, missing
  // bottom data or a bottom-temperature drop keeps the original draw signal.
  if (isContinuousHeatingWithoutTankDrawResponse(window)) {
    return false;
  }

  return true;
}

function isContinuousHeatingWithoutTankDrawResponse(readings: LiveDrawReading[]) {
  if (readings.length < 2 || readings.some((reading) => reading.heating !== true)) {
    return false;
  }

  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1];
    const current = readings[index];
    const previousMs = Date.parse(previous.created_at);
    const currentMs = Date.parse(current.created_at);
    const gapMinutes = (currentMs - previousMs) / 60_000;
    if (
      !Number.isFinite(previousMs) ||
      !Number.isFinite(currentMs) ||
      gapMinutes <= 0 ||
      gapMinutes > MAX_SEGMENT_MINUTES
    ) {
      return false;
    }

    const previousBottom = previous.bottom_temp;
    const currentBottom = current.bottom_temp;
    if (!finiteTemperature(previousBottom) || !finiteTemperature(currentBottom)) {
      return false;
    }
    if (currentBottom < previousBottom - HEATING_DRAW_RESPONSE_TOLERANCE_C) {
      return false;
    }
  }

  return true;
}

function isMatchedByReliableDraw(currentMs: number, draws: LiveReliableDraw[]) {
  const marginMs = LABEL_MATCH_MARGIN_MINUTES * 60_000;
  return draws.some((draw) => {
    const start = Date.parse(draw.event_started_at) - marginMs;
    const end = Date.parse(draw.event_ended_at) + marginMs;
    return Number.isFinite(start) && Number.isFinite(end) && currentMs >= start && currentMs <= end;
  });
}

function finiteTemperature(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

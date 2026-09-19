import {
  detectsWaterDraw,
  waterDrawDetectionLimits,
} from "../_shared/waterDrawDetection.ts";

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
const INLET_DRAW_CONFIRM_MARGIN_C = 1;
const MIN_INLET_DRAW_CONFIRM_DURATION_MINUTES = 1;
const INLET_RECOVERY_MARGIN_C = 4;
const MIN_INLET_RECOVERY_DURATION_MINUTES = 3;
const MIN_TANK_STABILIZATION_MINUTES = 15;
const MAX_SENSOR_CHANGE_C = 0.75;
const MAX_SEGMENT_MINUTES = 2;
const LABEL_MATCH_MARGIN_MINUTES = 5;

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

    // Inlet evidence remains authoritative even while the heater is on. A real
    // draw can be thermally masked by the 3 kW heater, so a flat or rising
    // bottom sensor cannot safely prove that the inlet drop was sensor-only.
    // Treat that situation as ambiguous and fail closed. Once the inlet has
    // recovered and the unheated tank has been quiet long enough, re-anchor to
    // the measured tank state instead of estimating how much energy the draw
    // removed. This handles both a real draw and a heater-induced inlet probe
    // oscillation without ever crediting uncertain energy to the live ledger.
    const drawCandidateMs = currentSampleDrawCandidateMs(
      readings,
      index,
      coldInletBaselineC,
    );
    const drawDetected = drawCandidateMs !== null;
    const matchedReliableDraw =
      drawCandidateMs !== null &&
      isMatchedByReliableDraw(drawCandidateMs, reliableDraws);
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

function currentSampleDrawCandidateMs(
  readings: LiveDrawReading[],
  index: number,
  coldInletBaselineC: number,
): number | null {
  const currentTime = Date.parse(readings[index].created_at);
  // Keep the original relative-drop candidate in scope while the required cold
  // dwell completes. A drop can occur at the very edge of the 5-minute detector
  // window and only become confirmable one minute later.
  const windowStartMs =
    currentTime -
    (
      waterDrawDetectionLimits.windowMinutes +
      MAX_SEGMENT_MINUTES
    ) * 60_000;
  const window = readings
    .slice(0, index + 1)
    .filter((reading) => Date.parse(reading.created_at) >= windowStartMs);
  const inletSamples = window.map((reading) => ({
    inletTemperatureC: reading.inlet_temp,
    time: Date.parse(reading.created_at),
  }));
  const currentInletC = readings[index].inlet_temp;
  const currentIsCold =
    typeof currentInletC === "number" &&
    Number.isFinite(currentInletC) &&
    currentInletC <= coldInletBaselineC + INLET_DRAW_CONFIRM_MARGIN_C;

  // Emit a draw signal only while the current sample is itself in the confirmed
  // cold band. The historical window may retain the candidate long enough to
  // finish its dwell, but once the inlet warms the same old candidate must not
  // keep retriggering recovery on every later sample.
  if (
    !currentIsCold ||
    inletSamples.length < 2 ||
    !detectsWaterDraw(inletSamples)
  ) {
    return null;
  }

  const coldDwellStartIndex = confirmedColdInletDwellStartIndex(
    window,
    coldInletBaselineC,
  );
  if (coldDwellStartIndex === null) {
    return null;
  }

  // Bind the trailing cold dwell to the most recent qualifying drop that
  // occurred no later than the start of that dwell. Later cold samples inside
  // the same dwell can also satisfy the raw relative-drop threshold, but they
  // are confirmation samples, not new draw candidates.
  const drawCandidate = findLatestDrawCandidate(
    inletSamples,
    coldDwellStartIndex,
  );
  if (drawCandidate === null) {
    return null;
  }

  // During a continuous heating response the inlet probe can cool sharply even
  // though both tank sensors keep rising. Treat that production-shaped pattern
  // as heater-induced probe oscillation, not a draw. Any relay interruption,
  // sampling gap, missing tank value or material tank-temperature drop keeps the
  // original fail-closed draw classification.
  const candidateWindow = window.slice(drawCandidate.comparatorIndex);
  return isHeaterOnlyInletOscillation(candidateWindow)
    ? null
    : inletSamples[drawCandidate.dropIndex].time;
}

function findLatestDrawCandidate(
  samples: { inletTemperatureC: number | null; time: number }[],
  maxDropIndex: number,
): { dropIndex: number; comparatorIndex: number } | null {
  // The retained window can contain more than one qualifying inlet drop. The
  // current confirmation dwell belongs to the most recent qualifying drop, not
  // an older already-labeled event that merely remains inside retention.
  for (
    let laterIndex = Math.min(maxDropIndex, samples.length - 1);
    laterIndex >= 1;
    laterIndex -= 1
  ) {
    const later = samples[laterIndex];
    if (
      later.inletTemperatureC === null ||
      !Number.isFinite(later.inletTemperatureC) ||
      !Number.isFinite(later.time)
    ) {
      continue;
    }

    for (let earlierIndex = laterIndex - 1; earlierIndex >= 0; earlierIndex -= 1) {
      const earlier = samples[earlierIndex];
      const minutesApart = (later.time - earlier.time) / 60_000;

      if (minutesApart > waterDrawDetectionLimits.windowMinutes) {
        break;
      }
      if (
        earlier.inletTemperatureC === null ||
        !Number.isFinite(earlier.inletTemperatureC) ||
        !Number.isFinite(earlier.time)
      ) {
        continue;
      }
      if (
        earlier.inletTemperatureC - later.inletTemperatureC >=
        waterDrawDetectionLimits.minDropCelsius
      ) {
        return { dropIndex: laterIndex, comparatorIndex: earlierIndex };
      }
    }
  }

  return null;
}

function confirmedColdInletDwellStartIndex(
  window: LiveDrawReading[],
  coldInletBaselineC: number,
): number | null {
  if (window.length < 2) {
    return null;
  }

  const maxConfirmedColdC = coldInletBaselineC + INLET_DRAW_CONFIRM_MARGIN_C;
  const currentIndex = window.length - 1;
  const current = window[currentIndex];
  const currentMs = Date.parse(current.created_at);
  const currentInletC = current.inlet_temp;

  if (
    !Number.isFinite(currentMs) ||
    typeof currentInletC !== "number" ||
    !Number.isFinite(currentInletC) ||
    currentInletC > maxConfirmedColdC
  ) {
    return null;
  }

  let dwellStartIndex = currentIndex;
  let dwellStartMs = currentMs;
  let laterMs = currentMs;

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const reading = window[index];
    const readingMs = Date.parse(reading.created_at);
    const inletC = reading.inlet_temp;
    const gapMinutes = (laterMs - readingMs) / 60_000;

    const isContiguousCold =
      Number.isFinite(readingMs) &&
      typeof inletC === "number" &&
      Number.isFinite(inletC) &&
      inletC <= maxConfirmedColdC &&
      Number.isFinite(gapMinutes) &&
      gapMinutes > 0 &&
      gapMinutes <= MAX_SEGMENT_MINUTES;

    if (!isContiguousCold) {
      break;
    }

    dwellStartIndex = index;
    dwellStartMs = readingMs;
    laterMs = readingMs;
  }

  return currentMs - dwellStartMs >=
      MIN_INLET_DRAW_CONFIRM_DURATION_MINUTES * 60_000
    ? dwellStartIndex
    : null;
}

function isHeaterOnlyInletOscillation(window: LiveDrawReading[]) {
  if (
    window.length < 2 ||
    window.some(
      (reading) =>
        reading.heating !== true ||
        !finiteTemperature(reading.top_temp) ||
        !finiteTemperature(reading.bottom_temp),
    )
  ) {
    return false;
  }

  const maxAllowedDropC = 0.25;
  for (let index = 1; index < window.length; index += 1) {
    const current = window[index];
    const previous = window[index - 1];
    const gapMinutes =
      (Date.parse(current.created_at) - Date.parse(previous.created_at)) / 60_000;

    if (
      !Number.isFinite(gapMinutes) ||
      gapMinutes <= 0 ||
      gapMinutes > MAX_SEGMENT_MINUTES ||
      (current.top_temp as number) < (previous.top_temp as number) - maxAllowedDropC ||
      (current.bottom_temp as number) <
        (previous.bottom_temp as number) - maxAllowedDropC
    ) {
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

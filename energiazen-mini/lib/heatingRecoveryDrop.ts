import { findValidHeatingSegments, getMedian } from "./heatingGain";
import { isValidInletTemperature } from "./inletTemperature";
import { fallbackHourlyTemperatureDrop } from "./tankTemperatureForecast";
import type { TankTemperatureReading } from "./tankTemperatureForecast";
import { detectsWaterDraw, waterDrawDetectionLimits } from "./waterDrawDetection";

// v1 keeps the recovery window fixed at one simulation hour rather than
// deriving it from heating duration - see docs/PROJECT_CONTEXT.md's
// heating-gain notes for why a duration-dependent window was deferred.
export const recoveryDropLearningLimits = {
  minValidSamples: 3,
  recoveryWindowHours: 1,
  recoveryWindowToleranceMinutes: 15,
} as const;

export type RecoveryDropEstimate = {
  dropPerHour: number;
  fallbackUsed: boolean;
  sampleCount: number;
  samples: number[];
};

type OrderedReading = {
  heating: boolean | null;
  inletTemperatureC: number | null;
  time: number;
  weightedTemperature: number;
};

function getOrderedReadings(
  readings: TankTemperatureReading[],
): OrderedReading[] {
  return readings
    .map((reading): OrderedReading | null => {
      const time = reading.created_at
        ? new Date(reading.created_at).getTime()
        : Number.NaN;
      const topTemperature = reading.top_temp;
      const bottomTemperature = reading.bottom_temp;

      if (
        !Number.isFinite(time) ||
        typeof topTemperature !== "number" ||
        typeof bottomTemperature !== "number" ||
        !Number.isFinite(topTemperature) ||
        !Number.isFinite(bottomTemperature)
      ) {
        return null;
      }

      return {
        // Preserved as a tri-state rather than collapsed to boolean: an
        // unreadable Shelly status (heating: null) must not be usable as
        // evidence of an off-transition below, only an explicit false may
        // anchor the recovery window.
        heating: reading.heating ?? null,
        inletTemperatureC: isValidInletTemperature(reading.inlet_temp)
          ? reading.inlet_temp
          : null,
        time,
        weightedTemperature: topTemperature * 0.7 + bottomTemperature * 0.3,
      };
    })
    .filter((reading): reading is OrderedReading => reading !== null)
    .sort((first, second) => first.time - second.time);
}

// Walks forward in time from segmentEndTime looking for the first confirmed
// heating=false reading. Unlike a plain .find(), this stops and gives up
// (returns null) as soon as it hits a heating=true reading first - without
// that, a later, unrelated heating cycle's own off-transition could get
// picked up as if it belonged to THIS segment, silently swallowing the
// entire intervening cycle into what looks like one clean recovery window
// (Codex review, PR #147). heating=null readings are skipped over (neither
// stop nor match), since an unreadable Shelly status is not evidence either
// way - findValidHeatingSegments already only builds `segments` from
// confirmed heating=true readings, so that later cycle gets its own correct
// anchor from its own iteration of this same loop.
function findOffTransitionReading(
  orderedReadings: OrderedReading[],
  segmentEndTime: number,
): OrderedReading | null {
  for (const reading of orderedReadings) {
    if (reading.time <= segmentEndTime) {
      continue;
    }

    if (reading.heating === true) {
      return null;
    }

    if (reading.heating === false) {
      return reading;
    }
  }

  return null;
}

// For each accepted heating segment, looks one recovery window past the
// segment's own end for the nearest clean (no intervening heating, no
// detected water draw) reading, and samples the observed drop rate across
// that window. Mirrors estimateHeatingGainPerHour's shape but measures the
// hour after heating ends rather than the heating window itself.
export function estimateRecoveryDropPerHour(
  readings: TankTemperatureReading[],
  fallbackDropPerHour = fallbackHourlyTemperatureDrop,
): RecoveryDropEstimate {
  const { segments } = findValidHeatingSegments(readings);
  const orderedReadings = getOrderedReadings(readings);
  const windowMilliseconds =
    recoveryDropLearningLimits.recoveryWindowHours * 60 * 60 * 1000;
  const toleranceMilliseconds =
    recoveryDropLearningLimits.recoveryWindowToleranceMinutes * 60 * 1000;
  const waterDrawDetectionWindowMilliseconds =
    waterDrawDetectionLimits.windowMinutes * 60 * 1000;
  const samples: number[] = [];

  for (const segment of segments) {
    const segmentEndTime = new Date(segment.endTime).getTime();

    // segment.endTime is the LAST heating=true reading, which can still be
    // mid-heating if the poll interval straddles the real off-transition -
    // the heater may keep running until the following poll. Anchor the
    // recovery window on the first confirmed heating=false reading instead,
    // both for its start time and its baseline temperature, so the tail of
    // active heating isn't folded into the learned recovery rate (flagged
    // in PR #121 review).
    const offTransitionReading = findOffTransitionReading(
      orderedReadings,
      segmentEndTime,
    );

    if (!offTransitionReading) {
      continue;
    }

    const recoveryStartTime = offTransitionReading.time;
    const targetTime = recoveryStartTime + windowMilliseconds;
    const candidates = orderedReadings.filter(
      (reading) =>
        reading.time > recoveryStartTime &&
        reading.time <= targetTime + toleranceMilliseconds,
    );

    let nearest: OrderedReading | null = null;
    let nearestDifference = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const difference = Math.abs(candidate.time - targetTime);

      if (difference < nearestDifference) {
        nearestDifference = difference;
        nearest = candidate;
      }
    }

    if (!nearest || nearestDifference > toleranceMilliseconds) {
      continue;
    }

    // Every reading up to (and including) the selected `nearest` endpoint
    // must be positive evidence of "not heating" - an unreadable Shelly
    // status (heating: null) provides no such evidence and must contaminate
    // the measured interval exactly like a confirmed true would (Codex
    // review, PR #147). Readings later in the tolerance tail than `nearest`
    // never touch the drop calculation, so - same principle as
    // precedingReadings below - they must not be able to discard an
    // otherwise clean sample either (Codex review, PR #147 follow-up).
    const measuredIntervalReadings = candidates.filter(
      (reading) => reading.time <= nearest.time,
    );

    if (measuredIntervalReadings.some((reading) => reading.heating !== false)) {
      continue;
    }

    // Draw detection covers everything from waterDrawDetectionWindowMinutes
    // before the off-transition (so a draw already under way at that point
    // is still visible as a drop against its own recent past) through the
    // selected `nearest` endpoint - not the full, more generous candidates
    // range. Activity after `nearest` never touches the drop calculation
    // (only offTransitionReading and nearest do), so it must not be able to
    // discard an otherwise clean sample either.
    const precedingReadings = orderedReadings.filter(
      (reading) =>
        reading.time < recoveryStartTime &&
        reading.time >= recoveryStartTime - waterDrawDetectionWindowMilliseconds,
    );
    const drawDetectionReadings = [
      ...precedingReadings,
      offTransitionReading,
      ...candidates.filter((candidate) => candidate.time <= nearest.time),
    ];

    if (detectsWaterDraw(drawDetectionReadings)) {
      continue;
    }

    const elapsedHours =
      (nearest.time - recoveryStartTime) / (60 * 60 * 1000);

    if (elapsedHours <= 0) {
      continue;
    }

    const drop =
      offTransitionReading.weightedTemperature - nearest.weightedTemperature;
    const dropPerHour = drop / elapsedHours;

    if (Number.isFinite(dropPerHour)) {
      samples.push(dropPerHour);
    }
  }

  const hasEnoughSamples =
    samples.length >= recoveryDropLearningLimits.minValidSamples;
  const learnedDropPerHour = hasEnoughSamples ? getMedian(samples) : null;

  return {
    dropPerHour: learnedDropPerHour ?? fallbackDropPerHour,
    fallbackUsed: learnedDropPerHour === null,
    sampleCount: samples.length,
    samples,
  };
}

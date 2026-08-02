import { findValidHeatingSegments, getMedian } from "./heatingGain";
import { isValidInletTemperature } from "./inletTemperature";
import { fallbackHourlyTemperatureDrop } from "./tankTemperatureForecast";
import type { TankTemperatureReading } from "./tankTemperatureForecast";

// v1 keeps the recovery window fixed at one simulation hour rather than
// deriving it from heating duration - see docs/PROJECT_CONTEXT.md's
// heating-gain notes for why a duration-dependent window was deferred.
export const recoveryDropLearningLimits = {
  minValidSamples: 3,
  recoveryWindowHours: 1,
  recoveryWindowToleranceMinutes: 15,
} as const;

// A stagnant inlet pipe sits several degrees above the true mains-water
// temperature (confirmed against real hardware: ~15.7 idle vs. ~12.2
// flowing), so a fast drop mid-recovery is a reliable sign that someone
// drew hot water (and so cold makeup water) during the window - which
// would otherwise silently corrupt the learned drop rate, since only the
// two window endpoints feed the final calculation. "Fast" is judged over a
// short trailing window rather than adjacent readings only, since a poll
// gap could otherwise hide a real draw between two samples.
const waterDrawDetectionLimits = {
  minDropCelsius: 2,
  windowMinutes: 5,
} as const;

export type RecoveryDropEstimate = {
  dropPerHour: number;
  fallbackUsed: boolean;
  sampleCount: number;
  samples: number[];
};

type OrderedReading = {
  heating: boolean;
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
        heating: reading.heating === true,
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

// True if any reading in windowReadings (chronological, starting with the
// recovery baseline) is at least minDropCelsius colder than some earlier
// reading within windowMinutes of it. Readings without a valid inlet
// sensor value (no sensor installed, or pre-1.8.2026 data) are simply
// skipped, so segments are judged exactly as before whenever inlet data
// isn't available.
function detectsWaterDraw(windowReadings: OrderedReading[]): boolean {
  for (let laterIndex = 1; laterIndex < windowReadings.length; laterIndex++) {
    const later = windowReadings[laterIndex];

    if (later.inletTemperatureC === null) {
      continue;
    }

    for (let earlierIndex = laterIndex - 1; earlierIndex >= 0; earlierIndex--) {
      const earlier = windowReadings[earlierIndex];
      const minutesApart = (later.time - earlier.time) / (60 * 1000);

      if (minutesApart > waterDrawDetectionLimits.windowMinutes) {
        break;
      }
      if (earlier.inletTemperatureC === null) {
        continue;
      }
      if (
        earlier.inletTemperatureC - later.inletTemperatureC >=
        waterDrawDetectionLimits.minDropCelsius
      ) {
        return true;
      }
    }
  }

  return false;
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
    const offTransitionReading = orderedReadings.find(
      (reading) => reading.time > segmentEndTime && !reading.heating,
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

    if (candidates.some((reading) => reading.heating)) {
      continue;
    }

    if (detectsWaterDraw([offTransitionReading, ...candidates])) {
      continue;
    }

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

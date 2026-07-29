import {
  fallbackHeatingGainPerHour,
  findValidHeatingSegments,
  getMedian,
  heatingGainLearningLimits,
  HeatingGainSegment,
  HeatingGainSegmentDiscovery,
} from "./heatingGain";
import type { TankTemperatureReading } from "./tankTemperatureForecast";

export type HeatingGainBacktestSegment = {
  absoluteErrorCelsius: number;
  actualGainPerHour: number;
  actualRiseCelsius: number;
  durationHours: number;
  endTime: string;
  errorCelsius: number;
  predictedFromFallback: boolean;
  predictedGainPerHour: number;
  predictedRiseCelsius: number;
  startTime: string;
};

export type HeatingGainBacktestResult = {
  meanAbsoluteErrorCelsius: number | null;
  meanBiasCelsius: number | null;
  segmentDiscovery: HeatingGainSegmentDiscovery;
  segmentCount: number;
  segments: HeatingGainBacktestSegment[];
};

// Backtests the heating-gain model against real heating segments: for each
// segment, predicts its temperature rise using EXACTLY the decision
// estimateHeatingGainPerHour would have made from the OTHER accepted
// segments alone (leave-one-out) - including falling back to
// fallbackGainPerHour when fewer than
// heatingGainLearningLimits.minValidSegments other segments are available,
// the same threshold production uses. This makes the backtest evaluate the
// model that would actually have been in use at that point in history, not
// an idealized always-learned version of it. Using the segment's own value
// to predict itself would trivially minimize error, so it's excluded from
// "other segments" in every case.
//
// errorCelsius = actual - predicted. A positive meanBiasCelsius means the
// model systematically UNDERpredicts the rise (actual runs hotter than
// predicted); negative means it OVERpredicts.
export function backtestHeatingGainEstimate(
  readings: TankTemperatureReading[],
  fallbackGainPerHour = fallbackHeatingGainPerHour,
): HeatingGainBacktestResult {
  const segmentDiscovery = findValidHeatingSegments(readings);
  const { segments } = segmentDiscovery;

  if (segments.length === 0) {
    return {
      meanAbsoluteErrorCelsius: null,
      meanBiasCelsius: null,
      segmentDiscovery,
      segmentCount: 0,
      segments: [],
    };
  }

  const backtestSegments = segments.map((segment) =>
    buildBacktestSegment(segment, segments, fallbackGainPerHour),
  );
  const meanAbsoluteErrorCelsius =
    backtestSegments.reduce(
      (sum, item) => sum + item.absoluteErrorCelsius,
      0,
    ) / backtestSegments.length;
  const meanBiasCelsius =
    backtestSegments.reduce((sum, item) => sum + item.errorCelsius, 0) /
    backtestSegments.length;

  return {
    meanAbsoluteErrorCelsius,
    meanBiasCelsius,
    segmentDiscovery,
    segmentCount: backtestSegments.length,
    segments: backtestSegments,
  };
}

function buildBacktestSegment(
  segment: HeatingGainSegment,
  allSegments: HeatingGainSegment[],
  fallbackGainPerHour: number,
): HeatingGainBacktestSegment {
  const otherGains = allSegments
    .filter((other) => other !== segment)
    .map((other) => other.weightedGainPerHour);
  const hasEnoughOtherSegments =
    otherGains.length >= heatingGainLearningLimits.minValidSegments;
  const predictedFromFallback = !hasEnoughOtherSegments;
  const predictedGainPerHour = hasEnoughOtherSegments
    ? (getMedian(otherGains) as number)
    : fallbackGainPerHour;
  const predictedRiseCelsius = predictedGainPerHour * segment.durationHours;
  const actualRiseCelsius =
    segment.weightedGainPerHour * segment.durationHours;
  const errorCelsius = actualRiseCelsius - predictedRiseCelsius;

  return {
    absoluteErrorCelsius: Math.abs(errorCelsius),
    actualGainPerHour: segment.weightedGainPerHour,
    actualRiseCelsius,
    durationHours: segment.durationHours,
    endTime: segment.endTime,
    errorCelsius,
    predictedFromFallback,
    predictedGainPerHour,
    predictedRiseCelsius,
    startTime: segment.startTime,
  };
}

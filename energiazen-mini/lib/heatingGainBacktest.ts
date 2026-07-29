import {
  findValidHeatingSegments,
  getMedian,
  HeatingGainSegment,
} from "./heatingGain";
import type { TankTemperatureReading } from "./tankTemperatureForecast";

export type HeatingGainBacktestSegment = {
  absoluteErrorCelsius: number;
  actualGainPerHour: number;
  actualRiseCelsius: number;
  durationHours: number;
  endTime: string;
  errorCelsius: number;
  predictedGainPerHour: number;
  predictedRiseCelsius: number;
  startTime: string;
};

export type HeatingGainBacktestResult = {
  meanAbsoluteErrorCelsius: number | null;
  meanBiasCelsius: number | null;
  segmentCount: number;
  segments: HeatingGainBacktestSegment[];
};

// Backtests the heating-gain model against real heating segments: for each
// segment, predicts its temperature rise using the median gainPerHour of
// every OTHER accepted segment (leave-one-out), then compares that
// prediction to what the tank actually did. Using the segment's own value to
// predict itself would trivially minimize error, so it's excluded.
//
// errorCelsius = actual - predicted. A positive meanBiasCelsius means the
// model systematically UNDERpredicts the rise (actual runs hotter than
// predicted); negative means it OVERpredicts.
export function backtestHeatingGainEstimate(
  readings: TankTemperatureReading[],
): HeatingGainBacktestResult {
  const { segments } = findValidHeatingSegments(readings);

  if (segments.length < 2) {
    return {
      meanAbsoluteErrorCelsius: null,
      meanBiasCelsius: null,
      segmentCount: segments.length,
      segments: [],
    };
  }

  const backtestSegments = segments.map((segment) =>
    buildBacktestSegment(segment, segments),
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
    segmentCount: backtestSegments.length,
    segments: backtestSegments,
  };
}

function buildBacktestSegment(
  segment: HeatingGainSegment,
  allSegments: HeatingGainSegment[],
): HeatingGainBacktestSegment {
  const otherGains = allSegments
    .filter((other) => other !== segment)
    .map((other) => other.weightedGainPerHour);
  // allSegments.length >= 2 is guaranteed by the caller, so otherGains is
  // always non-empty and getMedian never returns null here.
  const predictedGainPerHour = getMedian(otherGains) as number;
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
    predictedGainPerHour,
    predictedRiseCelsius,
    startTime: segment.startTime,
  };
}

import type { TankTemperatureReading } from "./tankTemperatureForecast";

export const heatingGainHistoryDays = 30;
export const heatingGainHistoryPageSize = 1000;

// A conservative weighted-temperature fallback stays slightly below the
// repeatedly observed roughly 4.7 C/h gain and avoids overstating one hour.
export const fallbackHeatingGainPerHour = 4.5;

export const heatingGainLearningLimits = {
  maxCurveDeviationCelsius: 1.5,
  maxComponentGainPerHour: 20,
  maxGapMinutes: 10,
  maxAbsoluteStepGainPerHour: 30,
  maxNegativeStepCount: 1,
  maxNegativeTemperatureStepCelsius: 0.5,
  maxSegmentHours: 6,
  maxWeightedGainPerHour: 8,
  maxValidTemperature: 100,
  minComponentGainPerHour: -5,
  minReadingsPerSegment: 4,
  minSegmentHours: 0.5,
  minValidTemperature: 0,
  minValidSegments: 3,
  minWeightedGainPerHour: 0.5,
} as const;

export type HeatingGainEstimate = {
  acceptedSegmentCount: number;
  bottomGainPerHour: number | null;
  discoveredSegmentCount: number;
  fallbackUsed: boolean;
  gainPerHour: number;
  rejectedSegmentCount: number;
  sampleCount: number;
  samples: number[];
  segmentDiscovery: HeatingGainSegmentDiscovery;
  topGainPerHour: number | null;
};

export type HeatingGainRejectionReason =
  | "component_gain_out_of_range"
  | "excessive_duration"
  | "insufficient_duration"
  | "insufficient_gain"
  | "insufficient_readings"
  | "negative_temperature_change"
  | "non_finite_gain"
  | "unrealistic_gain";

export type HeatingGainWarningReason =
  | "sensor_anomaly"
  | "unstable_curve";

export type HeatingGainSegmentQuality = {
  maxCurveDeviationCelsius: number | null;
  maxGapMinutes: number;
  maxAbsoluteStepGainPerHour: number | null;
  negativeStepCount: number;
};

export type HeatingGainSegment = {
  bottomGainPerHour: number;
  durationHours: number;
  endTime: string;
  readingCount: number;
  startTime: string;
  status: "accepted" | "accepted_with_warnings";
  topGainPerHour: number;
  weightedGainPerHour: number;
  warnings: HeatingGainWarningReason[];
  quality: HeatingGainSegmentQuality;
};

export type HeatingGainRejectedSegment = {
  bottomGainPerHour: number | null;
  durationHours: number;
  endTime: string;
  readingCount: number;
  reasons: HeatingGainRejectionReason[];
  startTime: string;
  status: "rejected";
  topGainPerHour: number | null;
  weightedGainPerHour: number | null;
  warnings: HeatingGainWarningReason[];
  quality: HeatingGainSegmentQuality;
};

export type HeatingGainSegmentDiscovery = {
  acceptedSegmentCount: number;
  acceptedWithWarningsSegmentCount: number;
  discoveredSegmentCount: number;
  rejectedSegments: HeatingGainRejectedSegment[];
  rejectedSegmentCount: number;
  rejectionReasonCounts: Partial<Record<HeatingGainRejectionReason, number>>;
  segments: HeatingGainSegment[];
  warningReasonCounts: Partial<Record<HeatingGainWarningReason, number>>;
};

type ValidHeatingReading = {
  bottomTemperature: number;
  time: number;
  topTemperature: number;
  weightedTemperature: number;
};

type HeatingGainHistoryPage = {
  data: TankTemperatureReading[] | null;
  error: unknown | null;
};

export function getMedian(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function getValidHeatingReading(
  reading: TankTemperatureReading,
): ValidHeatingReading | null {
  const time = reading.created_at
    ? new Date(reading.created_at).getTime()
    : Number.NaN;
  const topTemperature = reading.top_temp;
  const bottomTemperature = reading.bottom_temp;

  if (
    reading.heating !== true ||
    !Number.isFinite(time) ||
    typeof topTemperature !== "number" ||
    typeof bottomTemperature !== "number" ||
    !Number.isFinite(topTemperature) ||
    !Number.isFinite(bottomTemperature) ||
    topTemperature < heatingGainLearningLimits.minValidTemperature ||
    topTemperature > heatingGainLearningLimits.maxValidTemperature ||
    bottomTemperature < heatingGainLearningLimits.minValidTemperature ||
    bottomTemperature > heatingGainLearningLimits.maxValidTemperature
  ) {
    return null;
  }

  return {
    bottomTemperature,
    time,
    topTemperature,
    weightedTemperature: topTemperature * 0.7 + bottomTemperature * 0.3,
  };
}

export function findValidHeatingSegments(
  readings: TankTemperatureReading[],
): HeatingGainSegmentDiscovery {
  const sortedReadings = [...readings].sort((first, second) =>
    String(first.created_at ?? "").localeCompare(
      String(second.created_at ?? ""),
    ),
  );
  const segments: HeatingGainSegment[] = [];
  const rejectedSegments: HeatingGainRejectedSegment[] = [];
  const rejectionReasonCounts: Partial<
    Record<HeatingGainRejectionReason, number>
  > = {};
  const warningReasonCounts: Partial<
    Record<HeatingGainWarningReason, number>
  > = {};
  let currentSegment: ValidHeatingReading[] = [];
  let discoveredSegmentCount = 0;

  const closeSegment = () => {
    if (currentSegment.length === 0) {
      return;
    }

    discoveredSegmentCount += 1;
    const first = currentSegment[0];
    const last = currentSegment[currentSegment.length - 1];
    const durationHours = (last.time - first.time) / (60 * 60 * 1000);
    const weightedGainPerHour =
      (last.weightedTemperature - first.weightedTemperature) / durationHours;
    const topGainPerHour =
      (last.topTemperature - first.topTemperature) / durationHours;
    const bottomGainPerHour =
      (last.bottomTemperature - first.bottomTemperature) / durationHours;
    const reasons = getRejectionReasons({
      bottomGainPerHour,
      durationHours,
      readingCount: currentSegment.length,
      topGainPerHour,
      weightedGainPerHour,
    });
    const quality = getSegmentQuality(currentSegment);
    const warnings = getSegmentWarnings(quality);

    if (reasons.length === 0) {
      for (const warning of warnings) {
        warningReasonCounts[warning] =
          (warningReasonCounts[warning] ?? 0) + 1;
      }

      segments.push({
        bottomGainPerHour,
        durationHours,
        endTime: new Date(last.time).toISOString(),
        readingCount: currentSegment.length,
        startTime: new Date(first.time).toISOString(),
        status: warnings.length > 0 ? "accepted_with_warnings" : "accepted",
        topGainPerHour,
        weightedGainPerHour,
        warnings,
        quality,
      });
    } else {
      for (const reason of reasons) {
        rejectionReasonCounts[reason] =
          (rejectionReasonCounts[reason] ?? 0) + 1;
      }

      rejectedSegments.push({
        bottomGainPerHour: finiteOrNull(bottomGainPerHour),
        durationHours,
        endTime: new Date(last.time).toISOString(),
        readingCount: currentSegment.length,
        reasons,
        startTime: new Date(first.time).toISOString(),
        status: "rejected",
        topGainPerHour: finiteOrNull(topGainPerHour),
        weightedGainPerHour: finiteOrNull(weightedGainPerHour),
        warnings,
        quality,
      });
    }

    currentSegment = [];
  };

  for (const reading of sortedReadings) {
    const validReading = getValidHeatingReading(reading);

    if (!validReading) {
      closeSegment();
      continue;
    }

    const previous = currentSegment[currentSegment.length - 1];
    const gapMinutes = previous
      ? (validReading.time - previous.time) / (60 * 1000)
      : 0;

    if (
      previous &&
      (gapMinutes <= 0 ||
        gapMinutes > heatingGainLearningLimits.maxGapMinutes)
    ) {
      closeSegment();
    }

    currentSegment.push(validReading);
  }

  closeSegment();

  return {
    acceptedSegmentCount: segments.length,
    acceptedWithWarningsSegmentCount: segments.filter(
      (segment) => segment.status === "accepted_with_warnings",
    ).length,
    discoveredSegmentCount,
    rejectedSegments,
    rejectedSegmentCount: rejectedSegments.length,
    rejectionReasonCounts,
    segments,
    warningReasonCounts,
  };
}

function finiteOrNull(value: number) {
  return Number.isFinite(value) ? value : null;
}

function getRejectionReasons({
  bottomGainPerHour,
  durationHours,
  readingCount,
  topGainPerHour,
  weightedGainPerHour,
}: {
  bottomGainPerHour: number;
  durationHours: number;
  readingCount: number;
  topGainPerHour: number;
  weightedGainPerHour: number;
}): HeatingGainRejectionReason[] {
  const reasons: HeatingGainRejectionReason[] = [];

  if (readingCount < heatingGainLearningLimits.minReadingsPerSegment) {
    reasons.push("insufficient_readings");
  }
  if (durationHours < heatingGainLearningLimits.minSegmentHours) {
    reasons.push("insufficient_duration");
  }
  if (durationHours > heatingGainLearningLimits.maxSegmentHours) {
    reasons.push("excessive_duration");
  }
  if (!Number.isFinite(weightedGainPerHour)) {
    reasons.push("non_finite_gain");
  } else if (weightedGainPerHour <= 0) {
    reasons.push("negative_temperature_change");
  } else if (
    weightedGainPerHour < heatingGainLearningLimits.minWeightedGainPerHour
  ) {
    reasons.push("insufficient_gain");
  } else if (
    weightedGainPerHour > heatingGainLearningLimits.maxWeightedGainPerHour
  ) {
    reasons.push("unrealistic_gain");
  }
  if (
    Number.isFinite(topGainPerHour) &&
    Number.isFinite(bottomGainPerHour) &&
    (topGainPerHour < heatingGainLearningLimits.minComponentGainPerHour ||
      topGainPerHour > heatingGainLearningLimits.maxComponentGainPerHour ||
      bottomGainPerHour < heatingGainLearningLimits.minComponentGainPerHour ||
      bottomGainPerHour > heatingGainLearningLimits.maxComponentGainPerHour)
  ) {
    reasons.push("component_gain_out_of_range");
  }

  return reasons;
}

function getSegmentQuality(
  readings: ValidHeatingReading[],
): HeatingGainSegmentQuality {
  const first = readings[0];
  const last = readings[readings.length - 1];
  const durationMilliseconds = last.time - first.time;
  let maxGapMinutes = 0;
  let maxAbsoluteStepGainPerHour = 0;
  let negativeStepCount = 0;

  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1];
    const current = readings[index];
    const stepHours = (current.time - previous.time) / (60 * 60 * 1000);
    const temperatureChange =
      current.weightedTemperature - previous.weightedTemperature;

    maxGapMinutes = Math.max(maxGapMinutes, stepHours * 60);
    if (stepHours > 0) {
      maxAbsoluteStepGainPerHour = Math.max(
        maxAbsoluteStepGainPerHour,
        Math.abs(temperatureChange / stepHours),
      );
    }
    if (
      temperatureChange <
      -heatingGainLearningLimits.maxNegativeTemperatureStepCelsius
    ) {
      negativeStepCount += 1;
    }
  }

  const maxCurveDeviationCelsius =
    durationMilliseconds > 0
      ? readings.reduce((maximum, reading) => {
          const progress = (reading.time - first.time) / durationMilliseconds;
          const expected =
            first.weightedTemperature +
            (last.weightedTemperature - first.weightedTemperature) * progress;
          return Math.max(
            maximum,
            Math.abs(reading.weightedTemperature - expected),
          );
        }, 0)
      : null;

  return {
    maxCurveDeviationCelsius,
    maxGapMinutes,
    maxAbsoluteStepGainPerHour:
      readings.length > 1 ? maxAbsoluteStepGainPerHour : null,
    negativeStepCount,
  };
}

function getSegmentWarnings(
  quality: HeatingGainSegmentQuality,
): HeatingGainWarningReason[] {
  const warnings: HeatingGainWarningReason[] = [];

  if (
    quality.maxAbsoluteStepGainPerHour !== null &&
    quality.maxAbsoluteStepGainPerHour >
      heatingGainLearningLimits.maxAbsoluteStepGainPerHour
  ) {
    warnings.push("sensor_anomaly");
  }
  if (
    quality.negativeStepCount > heatingGainLearningLimits.maxNegativeStepCount ||
    (quality.maxCurveDeviationCelsius !== null &&
      quality.maxCurveDeviationCelsius >
        heatingGainLearningLimits.maxCurveDeviationCelsius)
  ) {
    warnings.push("unstable_curve");
  }

  return warnings;
}

export function estimateHeatingGainPerHour(
  readings: TankTemperatureReading[],
  fallbackGainPerHour = fallbackHeatingGainPerHour,
): HeatingGainEstimate {
  const segmentDiscovery = findValidHeatingSegments(readings);
  const { discoveredSegmentCount, rejectedSegmentCount, segments } =
    segmentDiscovery;
  const weightedSamples = segments.map((segment) => segment.weightedGainPerHour);
  const topSamples = segments.map((segment) => segment.topGainPerHour);
  const bottomSamples = segments.map((segment) => segment.bottomGainPerHour);
  const hasEnoughSegments =
    weightedSamples.length >= heatingGainLearningLimits.minValidSegments;
  const learnedGain = hasEnoughSegments
    ? getMedian(weightedSamples)
    : null;

  return {
    acceptedSegmentCount: weightedSamples.length,
    bottomGainPerHour: hasEnoughSegments ? getMedian(bottomSamples) : null,
    discoveredSegmentCount,
    fallbackUsed: learnedGain === null,
    gainPerHour: learnedGain ?? fallbackGainPerHour,
    rejectedSegmentCount,
    sampleCount: weightedSamples.length,
    samples: weightedSamples,
    segmentDiscovery,
    topGainPerHour: hasEnoughSegments ? getMedian(topSamples) : null,
  };
}

export async function fetchHeatingGainHistory(
  fetchPage: (
    from: number,
    to: number,
  ) => Promise<HeatingGainHistoryPage>,
  pageSize = heatingGainHistoryPageSize,
) {
  const readings: TankTemperatureReading[] = [];
  let pageCount = 0;

  while (true) {
    const from = pageCount * pageSize;
    const { data, error } = await fetchPage(from, from + pageSize - 1);

    if (error) {
      throw error;
    }

    const page = data ?? [];
    readings.push(...page);
    pageCount += 1;

    if (page.length < pageSize) {
      break;
    }
  }

  readings.sort((first, second) =>
    String(first.created_at ?? "").localeCompare(
      String(second.created_at ?? ""),
    ),
  );

  return {
    fetchedRowCount: readings.length,
    pageCount,
    readings,
  };
}

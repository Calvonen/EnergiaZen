import type { TankTemperatureReading } from "./tankTemperatureForecast";

export const heatingGainHistoryDays = 30;
export const heatingGainHistoryPageSize = 1000;

// A conservative weighted-temperature fallback stays slightly below the
// repeatedly observed roughly 4.7 C/h gain and avoids overstating one hour.
export const fallbackHeatingGainPerHour = 4.5;

export const heatingGainLearningLimits = {
  maxComponentGainPerHour: 20,
  maxGapMinutes: 10,
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
  topGainPerHour: number | null;
};

export type HeatingGainSegment = {
  bottomGainPerHour: number;
  durationHours: number;
  endTime: string;
  readingCount: number;
  startTime: string;
  topGainPerHour: number;
  weightedGainPerHour: number;
};

export type HeatingGainSegmentDiscovery = {
  discoveredSegmentCount: number;
  rejectedSegmentCount: number;
  segments: HeatingGainSegment[];
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
  let currentSegment: ValidHeatingReading[] = [];
  let discoveredSegmentCount = 0;
  let rejectedSegmentCount = 0;

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
    const valid =
      currentSegment.length >=
        heatingGainLearningLimits.minReadingsPerSegment &&
      durationHours >= heatingGainLearningLimits.minSegmentHours &&
      durationHours <= heatingGainLearningLimits.maxSegmentHours &&
      Number.isFinite(weightedGainPerHour) &&
      weightedGainPerHour >=
        heatingGainLearningLimits.minWeightedGainPerHour &&
      weightedGainPerHour <=
        heatingGainLearningLimits.maxWeightedGainPerHour &&
      topGainPerHour >= heatingGainLearningLimits.minComponentGainPerHour &&
      topGainPerHour <= heatingGainLearningLimits.maxComponentGainPerHour &&
      bottomGainPerHour >=
        heatingGainLearningLimits.minComponentGainPerHour &&
      bottomGainPerHour <=
        heatingGainLearningLimits.maxComponentGainPerHour;

    if (valid) {
      segments.push({
        bottomGainPerHour,
        durationHours,
        endTime: new Date(last.time).toISOString(),
        readingCount: currentSegment.length,
        startTime: new Date(first.time).toISOString(),
        topGainPerHour,
        weightedGainPerHour,
      });
    } else {
      rejectedSegmentCount += 1;
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

  return { discoveredSegmentCount, rejectedSegmentCount, segments };
}

export function estimateHeatingGainPerHour(
  readings: TankTemperatureReading[],
  fallbackGainPerHour = fallbackHeatingGainPerHour,
): HeatingGainEstimate {
  const { discoveredSegmentCount, rejectedSegmentCount, segments } =
    findValidHeatingSegments(readings);
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

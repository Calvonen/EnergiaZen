import { heatingEnergyCostSettings } from "./heatingEnergyCost";
import { getHelsinkiElectricityDateKey, getTotalPriceCentsPerKwh } from "./electricityPrices";

export const heatingMarkers = {
  actual: "\u{1F525}",
  missed: "\u26A0\uFE0F",
  planned: "\u2B50",
} as const;

export type HeatingMarkerStatus = keyof typeof heatingMarkers;

export function normalizeStoredHeatingPlanHours(plannedHours: unknown) {
  if (!Array.isArray(plannedHours)) {
    return [];
  }

  return [
    ...new Set(
      plannedHours.filter(
        (hour): hour is number =>
          Number.isInteger(hour) && hour >= 0 && hour <= 23,
      ),
    ),
  ].sort((first, second) => first - second);
}

export function getHeatingHourStatus({
  endsAt,
  isActual,
  isPlanned,
  now = new Date(),
}: {
  endsAt: Date | string;
  isActual: boolean;
  isPlanned: boolean;
  now?: Date;
}): HeatingMarkerStatus | null {
  if (isActual) {
    return "actual";
  }

  if (!isPlanned) {
    return null;
  }

  return new Date(endsAt).getTime() <= now.getTime() ? "missed" : "planned";
}

export function getHeatingHourMarker(
  input: Parameters<typeof getHeatingHourStatus>[0],
) {
  const status = getHeatingHourStatus(input);
  return status ? heatingMarkers[status] : null;
}

type TimelinePrice = {
  ends_at: string;
  resolution_minutes: number;
  spot_price_cents_kwh: number;
  starts_at: string;
};

export type ActualTimelineSegment = {
  costEuros: number;
  endedAt: string;
  energyKwh: number;
  priceCentsPerKwh: number;
  spotPriceCentsPerKwh: number;
  startedAt: string;
};

export type HeatingTimelineItem = ActualTimelineSegment & {
  marker: (typeof heatingMarkers)[HeatingMarkerStatus];
  status: HeatingMarkerStatus;
};

const helsinkiHourFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

function getHelsinkiHour(value: string) {
  return Number(helsinkiHourFormatter.format(new Date(value)));
}

// Hourly price segments (from calculateHeatedPriceHistory) split one
// continuous heating run at every price-hour boundary, so a run that
// spills 30-40s past the hour (Shelly's typical shutoff lag) shows up as
// an extra near-instant segment. Segments this close together - including
// perfectly back-to-back ones from several planned hours in a row - are
// merged into a single displayed event; cost/energy are summed and the
// price fields become duration-weighted averages across the merge.
export const maxActualHeatingSegmentGapMinutes = 2;

export function mergeAdjacentActualHeatingSegments(
  segments: ActualTimelineSegment[],
  maxGapMinutes = maxActualHeatingSegmentGapMinutes,
): ActualTimelineSegment[] {
  const sortedSegments = [...segments].sort(
    (first, second) =>
      Date.parse(first.startedAt) - Date.parse(second.startedAt),
  );
  const maxGapMs = maxGapMinutes * 60 * 1000;
  const mergedSegments: ActualTimelineSegment[] = [];

  for (const segment of sortedSegments) {
    const previous = mergedSegments[mergedSegments.length - 1];
    const gapMs = previous
      ? Date.parse(segment.startedAt) - Date.parse(previous.endedAt)
      : Infinity;

    if (!previous || gapMs > maxGapMs) {
      mergedSegments.push(segment);
      continue;
    }

    const previousMinutes =
      (Date.parse(previous.endedAt) - Date.parse(previous.startedAt)) /
      60_000;
    const segmentMinutes =
      (Date.parse(segment.endedAt) - Date.parse(segment.startedAt)) / 60_000;
    const totalMinutes = previousMinutes + segmentMinutes;

    mergedSegments[mergedSegments.length - 1] = {
      costEuros: previous.costEuros + segment.costEuros,
      endedAt: segment.endedAt,
      energyKwh: previous.energyKwh + segment.energyKwh,
      priceCentsPerKwh:
        totalMinutes > 0
          ? (previous.priceCentsPerKwh * previousMinutes +
              segment.priceCentsPerKwh * segmentMinutes) /
            totalMinutes
          : segment.priceCentsPerKwh,
      spotPriceCentsPerKwh:
        totalMinutes > 0
          ? (previous.spotPriceCentsPerKwh * previousMinutes +
              segment.spotPriceCentsPerKwh * segmentMinutes) /
            totalMinutes
          : segment.spotPriceCentsPerKwh,
      startedAt: previous.startedAt,
    };
  }

  return mergedSegments;
}

export type PlannedHeatingHourEntry = {
  dateKey: string;
  hour: number;
};

export function buildTodayHeatingTimeline({
  actualSegments,
  now = new Date(),
  plannedHours,
  prices,
  windowEndIso,
  windowStartIso,
}: {
  actualSegments: ActualTimelineSegment[];
  now?: Date;
  plannedHours: PlannedHeatingHourEntry[];
  prices: TimelinePrice[];
  windowEndIso: string;
  windowStartIso: string;
}): HeatingTimelineItem[] {
  const windowStartMs = Date.parse(windowStartIso);
  const windowEndMs = Date.parse(windowEndIso);
  const windowActualSegments = actualSegments.filter(
    (segment) =>
      Date.parse(segment.endedAt) > windowStartMs &&
      Date.parse(segment.startedAt) < windowEndMs,
  );
  const mergedActualSegments = mergeAdjacentActualHeatingSegments(
    windowActualSegments,
  );
  const actualItems: HeatingTimelineItem[] = mergedActualSegments.map(
    (segment) => ({
      ...segment,
      marker: heatingMarkers.actual,
      status: "actual",
    }),
  );
  const plannedItems = plannedHours.flatMap(
    ({ dateKey, hour: plannedHour }): HeatingTimelineItem[] => {
      const hourPrices = prices.filter(
        (price) =>
          getHelsinkiElectricityDateKey(price.starts_at) === dateKey &&
          getHelsinkiHour(price.starts_at) === plannedHour,
      );

      if (hourPrices.length === 0) {
        return [];
      }

      const startedAt = hourPrices.reduce((earliest, price) =>
        Date.parse(price.starts_at) < Date.parse(earliest)
          ? price.starts_at
          : earliest,
      hourPrices[0].starts_at);
      const endedAt = hourPrices.reduce((latest, price) =>
        Date.parse(price.ends_at) > Date.parse(latest) ? price.ends_at : latest,
      hourPrices[0].ends_at);

      if (
        Date.parse(endedAt) <= windowStartMs ||
        Date.parse(startedAt) >= windowEndMs
      ) {
        return [];
      }

      const overlapsActual = mergedActualSegments.some(
        (segment) =>
          Date.parse(segment.startedAt) < Date.parse(endedAt) &&
          Date.parse(segment.endedAt) > Date.parse(startedAt),
      );

      if (overlapsActual) {
        return [];
      }

      const durationMinutes = hourPrices.reduce(
        (sum, price) => sum + price.resolution_minutes,
        0,
      );
      const spotPriceCentsPerKwh =
        hourPrices.reduce(
          (sum, price) =>
            sum + price.spot_price_cents_kwh * price.resolution_minutes,
          0,
        ) / durationMinutes;
      const priceCentsPerKwh = getTotalPriceCentsPerKwh(
        spotPriceCentsPerKwh,
      );
      const energyKwh =
        (durationMinutes / 60) * heatingEnergyCostSettings.heaterPowerKw;
      const status = getHeatingHourStatus({
        endsAt: endedAt,
        isActual: false,
        isPlanned: true,
        now,
      });

      if (!status) {
        return [];
      }

      return [{
        costEuros: (energyKwh * priceCentsPerKwh) / 100,
        endedAt,
        energyKwh,
        marker: heatingMarkers[status],
        priceCentsPerKwh,
        spotPriceCentsPerKwh,
        startedAt,
        status,
      }];
    },
  );

  return [...actualItems, ...plannedItems].sort(
    (first, second) => Date.parse(first.startedAt) - Date.parse(second.startedAt),
  );
}

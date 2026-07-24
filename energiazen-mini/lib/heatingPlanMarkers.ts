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

type ActualTimelineSegment = {
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

export function buildTodayHeatingTimeline({
  actualSegments,
  dateKey,
  now = new Date(),
  plannedHours,
  prices,
}: {
  actualSegments: ActualTimelineSegment[];
  dateKey: string;
  now?: Date;
  plannedHours: number[];
  prices: TimelinePrice[];
}): HeatingTimelineItem[] {
  const actualItems: HeatingTimelineItem[] = actualSegments.map((segment) => ({
    ...segment,
    marker: heatingMarkers.actual,
    status: "actual",
  }));
  const plannedItems = normalizeStoredHeatingPlanHours(plannedHours).flatMap(
    (plannedHour): HeatingTimelineItem[] => {
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
      const overlapsActual = actualSegments.some(
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

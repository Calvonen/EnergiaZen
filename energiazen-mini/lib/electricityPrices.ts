import {
  calculateTotalElectricityPriceCentsPerKwh,
  heatingEnergyCostSettings,
} from "./heatingEnergyCost";
import type { HeatingEnergyPeriod } from "./heatingHistory";

export const electricityPriceRegion = "FI";
export const spotMarginCentsPerKwh =
  heatingEnergyCostSettings.spotMarginCentsPerKwh;
export const gridAndTaxCentsPerKwh =
  heatingEnergyCostSettings.gridAndTaxCentsPerKwh;

export type ElectricityPriceRange = 1 | 7 | 30;

export type ElectricityPriceRecord = {
  ends_at: string;
  fetched_at?: string;
  region: string;
  resolution_minutes: number;
  spot_price_cents_kwh: number;
  starts_at: string;
};

export type ElectricityPriceDay = {
  averageSpotPrice: number;
  averageTotalPrice: number;
  dateKey: string;
  highestSpotPrice: number;
  highestTotalPrice: number;
  isPartial: boolean;
  lowestSpotPrice: number;
  lowestTotalPrice: number;
  prices: ElectricityPriceRecord[];
};

export type HeatedPriceSegment = {
  costEuros: number;
  durationMinutes: number;
  endedAt: string;
  energyKwh: number;
  priceCentsPerKwh: number;
  spotPriceCentsPerKwh: number;
  startedAt: string;
};

export type HeatedPriceDay = {
  costEuros: number;
  coveredMinutes: number;
  dateKey: string;
  durationMinutes: number;
  energyKwh: number;
  isPartial: boolean;
  segments: HeatedPriceSegment[];
  weightedAveragePrice: number | null;
  weightedAverageSpotPrice: number | null;
};

const helsinkiDateKeyFormatter = new Intl.DateTimeFormat("sv-SE", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

const helsinkiDateTimePartsFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

const finnishHistoryDateFormatter = new Intl.DateTimeFormat("fi-FI", {
  day: "numeric",
  month: "numeric",
  timeZone: "Europe/Helsinki",
  weekday: "short",
  year: "numeric",
});

export function getTotalPriceCentsPerKwh(spotPriceCentsPerKwh: number) {
  return (
    calculateTotalElectricityPriceCentsPerKwh(spotPriceCentsPerKwh) ??
    spotPriceCentsPerKwh
  );
}

export function getHelsinkiElectricityDateKey(value: string | Date) {
  return helsinkiDateKeyFormatter.format(
    value instanceof Date ? value : new Date(value),
  );
}

export function formatFinnishHistoryDate(dateKey: string) {
  const parts = finnishHistoryDateFormatter.formatToParts(
    new Date(`${dateKey}T12:00:00Z`),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const weekday = part("weekday").replace(".", "");

  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${Number(part("day"))}.${Number(part("month"))}.${part("year")}`;
}

export function getHelsinkiDateStartIso(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const targetTimestamp = Date.UTC(year, month - 1, day);
  let utcTimestamp = targetTimestamp;

  for (let index = 0; index < 3; index += 1) {
    const parts = helsinkiDateTimePartsFormatter.formatToParts(
      new Date(utcTimestamp),
    );
    const getPart = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const localTimestamp = Date.UTC(
      getPart("year"),
      getPart("month") - 1,
      getPart("day"),
      getPart("hour"),
      getPart("minute"),
      getPart("second"),
    );
    utcTimestamp += targetTimestamp - localTimestamp;
  }

  return new Date(utcTimestamp).toISOString();
}

export function offsetDateKey(dateKey: string, dayOffset: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + dayOffset, 12))
    .toISOString()
    .slice(0, 10);
}

const millisecondsPerHour = 3_600_000;

// "Viimeiset 24 h" is a rolling, hour-aligned window - not the calendar day -
// so a heating event from just before midnight is still visible the next
// morning. The window covers exactly 24 whole hourly slots, ending with the
// (possibly still ongoing) current hour.
export function getRollingHistoryWindowRangeIso(now = new Date()) {
  const currentHourStartMs =
    Math.floor(now.getTime() / millisecondsPerHour) * millisecondsPerHour;

  return {
    endIso: new Date(currentHourStartMs + millisecondsPerHour).toISOString(),
    startIso: new Date(
      currentHourStartMs - 23 * millisecondsPerHour,
    ).toISOString(),
  };
}

export function getElectricityHistoryRangeStartIso(
  range: ElectricityPriceRange,
  now = new Date(),
) {
  if (range === 1) {
    return getRollingHistoryWindowRangeIso(now).startIso;
  }

  const todayKey = getHelsinkiElectricityDateKey(now);
  return getHelsinkiDateStartIso(offsetDateKey(todayKey, -(range - 1)));
}

export function filterElectricityPricesByRange(
  prices: ElectricityPriceRecord[],
  range: ElectricityPriceRange,
  now = new Date(),
) {
  const start = new Date(getElectricityHistoryRangeStartIso(range, now)).getTime();
  const end = now.getTime();
  return prices.filter((price) => {
    const timestamp = new Date(price.starts_at).getTime();
    return timestamp >= start && timestamp <= end;
  });
}

export function filterHeatingPeriodsByRange(
  periods: HeatingEnergyPeriod[],
  range: ElectricityPriceRange,
  now = new Date(),
) {
  const start = Date.parse(getElectricityHistoryRangeStartIso(range, now));
  const end = now.getTime();

  return periods.filter(
    (period) => Date.parse(period.ended_at) > start && Date.parse(period.started_at) <= end,
  );
}

export function getHeatingDayEmptyLabel(day?: HeatedPriceDay) {
  return day ? null : "Ei lämmitystä";
}

export function getElectricityPriceUpsertKey(
  price: Pick<ElectricityPriceRecord, "region" | "resolution_minutes" | "starts_at">,
) {
  return `${price.region}|${new Date(price.starts_at).toISOString()}|${price.resolution_minutes}`;
}

export function deduplicateElectricityPrices(prices: ElectricityPriceRecord[]) {
  return [
    ...new Map(
      prices.map((price) => [getElectricityPriceUpsertKey(price), price]),
    ).values(),
  ];
}

export function getResolutionMinutes(startsAt: string, endsAt: string) {
  return Math.round(
    (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000,
  );
}

export function groupElectricityPricesByHelsinkiDay(
  prices: ElectricityPriceRecord[],
): ElectricityPriceDay[] {
  const groups = new Map<string, ElectricityPriceRecord[]>();
  for (const price of deduplicateElectricityPrices(prices)) {
    const dateKey = getHelsinkiElectricityDateKey(price.starts_at);
    groups.set(dateKey, [...(groups.get(dateKey) ?? []), price]);
  }

  return [...groups.entries()]
    .map(([dateKey, dayPrices]) => {
      const sortedPrices = [...dayPrices].sort(
        (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
      );
      const values = sortedPrices.map((price) => price.spot_price_cents_kwh);
      const totalValues = values.map(getTotalPriceCentsPerKwh);
      const dayMinutes =
        (Date.parse(getHelsinkiDateStartIso(offsetDateKey(dateKey, 1))) -
          Date.parse(getHelsinkiDateStartIso(dateKey))) /
        60_000;
      const availableMinutes = sortedPrices.reduce(
        (sum, price) => sum + price.resolution_minutes,
        0,
      );

      const averageSpotPrice =
        sortedPrices.reduce(
            (sum, price) =>
              sum + price.spot_price_cents_kwh * price.resolution_minutes,
            0,
          ) / availableMinutes;

      return {
        averageSpotPrice,
        averageTotalPrice: getTotalPriceCentsPerKwh(averageSpotPrice),
        dateKey,
        highestSpotPrice: Math.max(...values),
        highestTotalPrice: Math.max(...totalValues),
        isPartial: availableMinutes < dayMinutes,
        lowestSpotPrice: Math.min(...values),
        lowestTotalPrice: Math.min(...totalValues),
        prices: sortedPrices,
      };
    })
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}

export type ElectricityPriceWindowSummary = Omit<ElectricityPriceDay, "dateKey">;

// Same per-slot math as groupElectricityPricesByHelsinkiDay, but for an
// arbitrary [startIso, endIso) window instead of a calendar day - used by
// the "Viimeiset 24 h" rolling window view.
export function summarizeElectricityPriceWindow(
  prices: ElectricityPriceRecord[],
  startIso: string,
  endIso: string,
): ElectricityPriceWindowSummary | null {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const windowPrices = deduplicateElectricityPrices(prices)
    .filter((price) => {
      const timestamp = Date.parse(price.starts_at);
      return timestamp >= startMs && timestamp < endMs;
    })
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));

  if (windowPrices.length === 0) {
    return null;
  }

  const values = windowPrices.map((price) => price.spot_price_cents_kwh);
  const totalValues = values.map(getTotalPriceCentsPerKwh);
  const windowMinutes = (endMs - startMs) / 60_000;
  const availableMinutes = windowPrices.reduce(
    (sum, price) => sum + price.resolution_minutes,
    0,
  );
  const averageSpotPrice =
    windowPrices.reduce(
      (sum, price) => sum + price.spot_price_cents_kwh * price.resolution_minutes,
      0,
    ) / availableMinutes;

  return {
    averageSpotPrice,
    averageTotalPrice: getTotalPriceCentsPerKwh(averageSpotPrice),
    highestSpotPrice: Math.max(...values),
    highestTotalPrice: Math.max(...totalValues),
    isPartial: availableMinutes < windowMinutes,
    lowestSpotPrice: Math.min(...values),
    lowestTotalPrice: Math.min(...totalValues),
    prices: windowPrices,
  };
}

function splitHeatingPeriodsByHelsinkiDay(periods: HeatingEnergyPeriod[]) {
  return periods.flatMap((period) => {
    const periodEnd = Date.parse(period.ended_at);
    let cursor = Date.parse(period.started_at);
    const slices: { dateKey: string; end: number; start: number }[] = [];

    if (!Number.isFinite(cursor) || !Number.isFinite(periodEnd)) {
      return slices;
    }

    while (cursor < periodEnd) {
      const dateKey = getHelsinkiElectricityDateKey(new Date(cursor));
      const dayEnd = Date.parse(
        getHelsinkiDateStartIso(offsetDateKey(dateKey, 1)),
      );
      const end = Math.min(periodEnd, dayEnd);
      slices.push({ dateKey, end, start: cursor });
      cursor = end;
    }

    return slices;
  });
}

export function calculateHeatedPriceHistory(
  periods: HeatingEnergyPeriod[],
  prices: ElectricityPriceRecord[],
): HeatedPriceDay[] {
  const uniquePrices = deduplicateElectricityPrices(prices);
  const days = new Map<string, HeatedPriceDay>();

  for (const slice of splitHeatingPeriodsByHelsinkiDay(periods)) {
    const durationMinutes = (slice.end - slice.start) / 60_000;
    const day = days.get(slice.dateKey) ?? {
      costEuros: 0,
      coveredMinutes: 0,
      dateKey: slice.dateKey,
      durationMinutes: 0,
      energyKwh: 0,
      isPartial: false,
      segments: [],
      weightedAveragePrice: null,
      weightedAverageSpotPrice: null,
    };
    day.durationMinutes += durationMinutes;
    day.energyKwh +=
      (durationMinutes / 60) * heatingEnergyCostSettings.heaterPowerKw;

    for (const price of uniquePrices) {
      const overlapStart = Math.max(slice.start, Date.parse(price.starts_at));
      const overlapEnd = Math.min(slice.end, Date.parse(price.ends_at));
      if (overlapEnd <= overlapStart) {
        continue;
      }

      const segmentMinutes = (overlapEnd - overlapStart) / 60_000;
      const energyKwh =
        (segmentMinutes / 60) * heatingEnergyCostSettings.heaterPowerKw;
      const totalPrice = getTotalPriceCentsPerKwh(price.spot_price_cents_kwh);
      const costEuros = (energyKwh * totalPrice) / 100;
      day.coveredMinutes += segmentMinutes;
      day.costEuros += costEuros;
      day.segments.push({
        costEuros,
        durationMinutes: segmentMinutes,
        endedAt: new Date(overlapEnd).toISOString(),
        energyKwh,
        priceCentsPerKwh: totalPrice,
        spotPriceCentsPerKwh: price.spot_price_cents_kwh,
        startedAt: new Date(overlapStart).toISOString(),
      });
    }
    days.set(slice.dateKey, day);
  }

  return [...days.values()]
    .map((day) => ({
      ...day,
      isPartial: day.coveredMinutes + 0.001 < day.durationMinutes,
      segments: day.segments.sort(
        (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
      ),
      weightedAveragePrice:
        day.coveredMinutes > 0
          ? day.segments.reduce(
              (sum, segment) =>
                sum + segment.priceCentsPerKwh * segment.durationMinutes,
              0,
            ) / day.coveredMinutes
          : null,
      weightedAverageSpotPrice:
        day.coveredMinutes > 0
          ? day.segments.reduce(
              (sum, segment) =>
                sum +
                segment.spotPriceCentsPerKwh * segment.durationMinutes,
              0,
            ) / day.coveredMinutes
          : null,
    }))
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}

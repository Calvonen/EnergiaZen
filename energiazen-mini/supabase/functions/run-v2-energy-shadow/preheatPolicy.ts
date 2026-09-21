import { calculateBilledElectricityPriceCentsPerKwh } from "../_shared/heatingTariff.ts";
import type { ShadowElectricityPrice } from "./planShadow.ts";

export type V2PreheatOpportunity = {
  available: boolean;
  eligiblePreheatHourIds: string[];
  resolutionMinutes: 15 | 60 | null;
  reason:
    | "recommended"
    | "tomorrow_prices_incomplete"
    | "no_future_today_prices"
    | "no_cheaper_preheat_interval";
  tomorrowCheapestBilledCentsPerKwh: number | null;
};

export type V2PreheatHorizon =
  | {
    available: true;
    futureTodayHourIds: string[];
    reason: "available";
    resolutionMinutes: 15 | 60;
    tomorrowHourIds: string[];
  }
  | {
    available: false;
    futureTodayHourIds: string[];
    reason: "tomorrow_prices_incomplete" | "no_future_today_prices";
    resolutionMinutes: 15 | 60 | null;
    tomorrowHourIds: string[];
  };

const helsinkiDateFormatter = new Intl.DateTimeFormat("en-CA", {
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

export function evaluateV2PreheatHorizon({
  now,
  prices,
}: {
  now: Date;
  prices: ShadowElectricityPrice[];
}): V2PreheatHorizon {
  const today = helsinkiDateKey(now);
  const tomorrow = helsinkiDateKeyOffset(now, 1);
  const dayAfterTomorrow = helsinkiDateKeyOffset(now, 2);
  const tomorrowStartMs = helsinkiDateStartMs(tomorrow);
  const tomorrowEndMs = helsinkiDateStartMs(dayAfterTomorrow);
  const nowMs = now.getTime();

  // Prefer quarter-hour prices when a complete tomorrow horizon exists. Fall
  // back to the legacy hourly feed so this shadow-only change is backwards
  // compatible while production remains on 60-minute publication.
  const resolutionMinutes = ([15, 60] as const).find((resolution) => {
    const usable = prices.filter((price) => isUsablePrice(price, resolution));
    const tomorrowPrices = usable
      .filter((price) => {
        const start = Date.parse(price.starts_at);
        const end = Date.parse(price.ends_at);
        return start >= tomorrowStartMs && end <= tomorrowEndMs;
      })
      .sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at));
    const hasFutureToday = usable.some(
      (price) =>
        helsinkiDateKey(new Date(price.starts_at)) === today &&
        Date.parse(price.starts_at) > nowMs,
    );
    const noFutureTodayAtAnyResolution = !prices.some(
      (price) =>
        (price.resolution_minutes === 15 || price.resolution_minutes === 60) &&
        helsinkiDateKey(new Date(price.starts_at)) === today &&
        Date.parse(price.starts_at) > nowMs,
    );
    return (hasFutureToday || noFutureTodayAtAnyResolution) &&
      hasCompleteCoverage(tomorrowPrices, tomorrowStartMs, tomorrowEndMs);
  }) ?? null;

  if (resolutionMinutes === null) {
    return {
      available: false,
      futureTodayHourIds: [],
      reason: "tomorrow_prices_incomplete",
      resolutionMinutes: null,
      tomorrowHourIds: [],
    };
  }

  const usable = prices.filter((price) => isUsablePrice(price, resolutionMinutes));
  const futureTodayPrices = usable
    .filter((price) =>
      helsinkiDateKey(new Date(price.starts_at)) === today && Date.parse(price.starts_at) > nowMs
    )
    .sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at));
  const tomorrowPrices = usable
    .filter((price) => {
      const start = Date.parse(price.starts_at);
      const end = Date.parse(price.ends_at);
      return start >= tomorrowStartMs && end <= tomorrowEndMs;
    })
    .sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at));

  if (!futureTodayPrices.length) {
    return {
      available: false,
      futureTodayHourIds: [],
      reason: "no_future_today_prices",
      resolutionMinutes,
      tomorrowHourIds: tomorrowPrices.map((price) => price.starts_at),
    };
  }

  return {
    available: true,
    futureTodayHourIds: futureTodayPrices.map((price) => price.starts_at),
    reason: "available",
    resolutionMinutes,
    tomorrowHourIds: tomorrowPrices.map((price) => price.starts_at),
  };
}

export function getCompleteHelsinkiDayMinimumBilledPrices(
  prices: ShadowElectricityPrice[],
): Map<string, number> {
  const grouped = new Map<string, ShadowElectricityPrice[]>();
  for (const price of prices) {
    if (!isUsablePrice(price)) continue;
    const key = helsinkiDateKey(new Date(price.starts_at));
    if (!key) continue;
    const bucket = grouped.get(key) ?? [];
    bucket.push(price);
    grouped.set(key, bucket);
  }

  const result = new Map<string, number>();
  for (const [dateKey, dayPrices] of grouped) {
    const dayStartMs = helsinkiDateStartMs(dateKey);
    const nextDayStartMs = helsinkiDateStartMs(dateKeyOffset(dateKey, 1));
    const ordered = [...dayPrices].sort(
      (left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at),
    );
    if (!hasCompleteCoverage(ordered, dayStartMs, nextDayStartMs)) continue;

    const billed = ordered
      .map((price) => calculateBilledElectricityPriceCentsPerKwh(price.spot_price_cents_kwh))
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (billed.length === ordered.length && billed.length > 0) {
      result.set(dateKey, Math.min(...billed));
    }
  }
  return result;
}

export function evaluateV2PreheatOpportunity({
  now,
  prices,
}: {
  now: Date;
  prices: ShadowElectricityPrice[];
}): V2PreheatOpportunity {
  const horizon = evaluateV2PreheatHorizon({ now, prices });
  const priceById = new Map(prices.map((price) => [price.starts_at, price]));
  const tomorrowBilledPrices = horizon.tomorrowHourIds
    .map((hourId) => priceById.get(hourId))
    .filter((price): price is ShadowElectricityPrice => Boolean(price))
    .map((price) => calculateBilledElectricityPriceCentsPerKwh(price.spot_price_cents_kwh))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const tomorrowCheapestBilledCentsPerKwh = tomorrowBilledPrices.length
    ? Math.min(...tomorrowBilledPrices)
    : null;

  if (!horizon.available) {
    return unavailable(horizon.reason, tomorrowCheapestBilledCentsPerKwh);
  }
  if (tomorrowCheapestBilledCentsPerKwh === null) {
    return unavailable("tomorrow_prices_incomplete");
  }

  const eligiblePreheatHourIds = horizon.futureTodayHourIds
    .filter((hourId) => {
      const price = priceById.get(hourId);
      if (!price) return false;
      const billed = calculateBilledElectricityPriceCentsPerKwh(price.spot_price_cents_kwh);
      return billed !== null && billed < tomorrowCheapestBilledCentsPerKwh;
    });

  if (!eligiblePreheatHourIds.length) {
    return unavailable("no_cheaper_preheat_interval", tomorrowCheapestBilledCentsPerKwh);
  }

  return {
    available: true,
    eligiblePreheatHourIds,
    resolutionMinutes: horizon.resolutionMinutes,
    reason: "recommended",
    tomorrowCheapestBilledCentsPerKwh: round(tomorrowCheapestBilledCentsPerKwh),
  };
}

function isUsablePrice(
  price: ShadowElectricityPrice,
  requiredResolution?: 15 | 60,
) {
  const start = Date.parse(price.starts_at);
  const end = Date.parse(price.ends_at);
  const resolution = price.resolution_minutes;
  return (
    (resolution === 15 || resolution === 60) &&
    (requiredResolution === undefined || resolution === requiredResolution) &&
    Number.isFinite(price.spot_price_cents_kwh) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end - start === resolution * 60 * 1000
  );
}

function hasCompleteCoverage(
  prices: ShadowElectricityPrice[],
  expectedStartMs: number,
  expectedEndMs: number,
) {
  if (!Number.isFinite(expectedStartMs) || !Number.isFinite(expectedEndMs) || !prices.length) {
    return false;
  }
  let cursor = expectedStartMs;
  for (const price of prices) {
    const start = Date.parse(price.starts_at);
    const end = Date.parse(price.ends_at);
    if (start !== cursor || end <= start) return false;
    cursor = end;
  }
  return cursor === expectedEndMs;
}

function helsinkiDateKey(date: Date) {
  const parts = helsinkiDateFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function dateKeyOffset(dateKey: string, dayOffset: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return "";
  return new Date(Date.UTC(year, month - 1, day + dayOffset, 12)).toISOString().slice(0, 10);
}

function helsinkiDateKeyOffset(date: Date, dayOffset: number) {
  return dateKeyOffset(helsinkiDateKey(date), dayOffset);
}

function helsinkiDateStartMs(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const targetTimestamp = Date.UTC(year, month - 1, day);
  let utcTimestamp = targetTimestamp;
  for (let index = 0; index < 3; index += 1) {
    const parts = helsinkiDateTimePartsFormatter.formatToParts(new Date(utcTimestamp));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const localTimestamp = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
      value("second"),
    );
    utcTimestamp += targetTimestamp - localTimestamp;
  }
  return utcTimestamp;
}

function unavailable(
  reason: Exclude<V2PreheatOpportunity["reason"], "recommended">,
  tomorrowCheapestBilledCentsPerKwh: number | null = null,
): V2PreheatOpportunity {
  return {
    available: false,
    eligiblePreheatHourIds: [],
    resolutionMinutes: null,
    reason,
    tomorrowCheapestBilledCentsPerKwh:
      tomorrowCheapestBilledCentsPerKwh === null
        ? null
        : round(tomorrowCheapestBilledCentsPerKwh),
  };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

export const helsinkiTimeZone = "Europe/Helsinki";
export const dayHistoryBucketMinutes = 30;

const dayKeyFormatter = new Intl.DateTimeFormat("sv-SE", {
  day: "2-digit",
  month: "2-digit",
  timeZone: helsinkiTimeZone,
  year: "numeric",
});

const dayLabelFormatter = new Intl.DateTimeFormat("fi-FI", {
  day: "numeric",
  month: "numeric",
  timeZone: helsinkiTimeZone,
  weekday: "short",
});

function getDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
) {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function getHelsinkiDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: helsinkiTimeZone,
    year: "numeric",
  }).formatToParts(date);

  return {
    day: Number(getDatePart(parts, "day")),
    hour: Number(getDatePart(parts, "hour")),
    minute: Number(getDatePart(parts, "minute")),
    month: Number(getDatePart(parts, "month")),
    second: Number(getDatePart(parts, "second")),
    year: Number(getDatePart(parts, "year")),
  };
}

function parseDayKey(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);

  if (!year || !month || !day) {
    throw new Error(`Invalid Helsinki day key: ${dayKey}`);
  }

  return { day, month, year };
}

function getUtcDateForHelsinkiLocalTime({
  day,
  hour = 0,
  minute = 0,
  month,
  second = 0,
  year,
}: {
  day: number;
  hour?: number;
  minute?: number;
  month: number;
  second?: number;
  year: number;
}) {
  const targetUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const initialDate = new Date(targetUtcMs);
  const initialParts = getHelsinkiDateParts(initialDate);
  const initialLocalAsUtcMs = Date.UTC(
    initialParts.year,
    initialParts.month - 1,
    initialParts.day,
    initialParts.hour,
    initialParts.minute,
    initialParts.second,
  );

  return new Date(targetUtcMs - (initialLocalAsUtcMs - targetUtcMs));
}

export function getHelsinkiDayKey(date = new Date()) {
  return dayKeyFormatter.format(date);
}

export function getTodayHelsinkiDayKey(now = new Date()) {
  return getHelsinkiDayKey(now);
}

export function addHelsinkiCalendarDays(dayKey: string, days: number) {
  const parsed = parseDayKey(dayKey);
  const dateAtNoonUtc = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day + days, 12),
  );

  return getHelsinkiDayKey(dateAtNoonUtc);
}

export function isTodayHelsinkiDay(dayKey: string, now = new Date()) {
  return dayKey === getTodayHelsinkiDayKey(now);
}

export function isFutureHelsinkiDay(dayKey: string, now = new Date()) {
  return dayKey > getTodayHelsinkiDayKey(now);
}

export function getHelsinkiDayRange(dayKey: string) {
  const parsed = parseDayKey(dayKey);
  const start = getUtcDateForHelsinkiLocalTime(parsed);
  const nextDay = parseDayKey(addHelsinkiCalendarDays(dayKey, 1));
  const end = getUtcDateForHelsinkiLocalTime(nextDay);

  return {
    endIso: end.toISOString(),
    startIso: start.toISOString(),
  };
}

export function formatHelsinkiDaySelectorLabel(dayKey: string) {
  const parsed = parseDayKey(dayKey);
  const date = getUtcDateForHelsinkiLocalTime({ ...parsed, hour: 12 });
  const parts = dayLabelFormatter.formatToParts(date);
  const weekday = getDatePart(parts, "weekday").replace(".", "");
  const day = getDatePart(parts, "day");
  const month = getDatePart(parts, "month");
  const normalizedWeekday =
    weekday.charAt(0).toUpperCase() + weekday.slice(1);

  return `${normalizedWeekday} ${day}.${month}.`;
}

export function createTemperatureHistoryDayCache<T>() {
  const cache = new Map<string, T>();

  return {
    get(dayKey: string) {
      return cache.get(dayKey);
    },
    has(dayKey: string) {
      return cache.has(dayKey);
    },
    set(dayKey: string, value: T) {
      cache.set(dayKey, value);
    },
  };
}

export function getTemperatureHistoryDayCacheKey({
  bucketMinutes = dayHistoryBucketMinutes,
  dayKey,
  view = "day",
}: {
  bucketMinutes?: number;
  dayKey: string;
  view?: string;
}) {
  return `${view}:${bucketMinutes}m:${dayKey}`;
}

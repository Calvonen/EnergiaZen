import {
  addHelsinkiCalendarDays,
  createTemperatureHistoryDayCache,
  formatHelsinkiDaySelectorLabel,
  getHelsinkiDayRange,
  getTemperatureHistoryDayCacheKey,
  getTodayHelsinkiDayKey,
  isFutureHelsinkiDay,
  isTodayHelsinkiDay,
} from "./temperatureHistoryDay";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runTemperatureHistoryDayUnitTests() {
  const now = new Date("2026-07-25T10:00:00.000Z");
  const todayKey = getTodayHelsinkiDayKey(now);

  assert(todayKey === "2026-07-25", "oletuspäivä on tänään Helsingissä");
  assert(
    addHelsinkiCalendarDays(todayKey, -1) === "2026-07-24",
    "vasen nuoli siirtää edelliseen päivään",
  );
  assert(
    isTodayHelsinkiDay(todayKey, now) &&
      !isFutureHelsinkiDay(todayKey, now) &&
      isFutureHelsinkiDay("2026-07-26", now),
    "oikea nuoli ei saa siirtyä tulevaisuuteen",
  );

  const summerRange = getHelsinkiDayRange("2026-07-25");
  assert(
    summerRange.startIso === "2026-07-24T21:00:00.000Z" &&
      summerRange.endIso === "2026-07-25T21:00:00.000Z",
    "Helsingin kesäajan päivän rajat ovat 00.00-00.00 paikallista aikaa",
  );

  const winterRange = getHelsinkiDayRange("2026-01-25");
  assert(
    winterRange.startIso === "2026-01-24T22:00:00.000Z" &&
      winterRange.endIso === "2026-01-25T22:00:00.000Z",
    "Helsingin talviajan päivän rajat ovat 00.00-00.00 paikallista aikaa",
  );

  const cache = createTemperatureHistoryDayCache<number[]>();
  const day30MinuteCacheKey = getTemperatureHistoryDayCacheKey({
    bucketMinutes: 30,
    dayKey: "2026-07-25",
    view: "day",
  });
  const day60MinuteCacheKey = getTemperatureHistoryDayCacheKey({
    bucketMinutes: 60,
    dayKey: "2026-07-25",
    view: "day",
  });
  cache.set(day30MinuteCacheKey, [1, 2, 3]);
  assert(
    cache.has(day30MinuteCacheKey) &&
      cache.get(day30MinuteCacheKey)?.length === 3 &&
      !cache.has(day60MinuteCacheKey),
    "päiväcache estää saman päivän turhan uuden haun mutta erottaa bucket-koon",
  );

  assert(
    formatHelsinkiDaySelectorLabel("2026-07-25") === "La 25.7.",
    "päivävalitsimen otsikko näyttää viikonpäivän ja päivämäärän",
  );
}

// Tulovesianturin viikoittainen trendikäyrä (app/history.tsx). Datan
// laskee palvelinpuolella get_weekly_minimum_inlet_temperature-RPC (ks.
// supabase/migrations/20260803000000_add_weekly_minimum_inlet_temperature_rpc.sql),
// joka käyttää samaa "vahvistetun minimin" periaatetta kuin
// lib/inletTemperature.ts:n calculateMinimumValidInletTemperature - tämä
// tiedosto vain muuntaa RPC:n rivit näyttöä varten, ei laske minimiä
// itse.
//
// Näkymä on jaettu kiinteisiin vuosineljänneksiin (tammi-maalis,
// huhti-kesä, heinä-syys, loka-joulu), joita voi selata taaksepäin
// samaan tapaan kuin päivähistorian ‹ › -nuolilla (ks. getInletTrendPeriod).
import {
  addHelsinkiCalendarDays,
  getHelsinkiDateParts,
  getHelsinkiDayKey,
  getUtcDateForHelsinkiLocalTime,
} from "./temperatureHistoryDay";

export const weeklyInletTemperatureChartMinC = 0;
export const weeklyInletTemperatureChartMaxC = 20;

const finnishMonthNames = [
  "tammikuu",
  "helmikuu",
  "maaliskuu",
  "huhtikuu",
  "toukokuu",
  "kesäkuu",
  "heinäkuu",
  "elokuu",
  "syyskuu",
  "lokakuu",
  "marraskuu",
  "joulukuu",
];

export type WeeklyInletTemperaturePoint = {
  minimumInletTempC: number;
  weekStart: string;
};

type WeeklyInletTemperatureRow = {
  minimum_inlet_temp?: number | null;
  week_start?: string | null;
};

export function mapWeeklyInletTemperatureRows(
  rows: WeeklyInletTemperatureRow[] | null | undefined,
): WeeklyInletTemperaturePoint[] {
  return (rows ?? [])
    .filter(
      (
        row,
      ): row is { minimum_inlet_temp: number; week_start: string } =>
        typeof row.week_start === "string" &&
        typeof row.minimum_inlet_temp === "number" &&
        Number.isFinite(row.minimum_inlet_temp),
    )
    .map((row) => ({
      minimumInletTempC: row.minimum_inlet_temp,
      weekStart: row.week_start,
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// Pisteen korkeus prosentteina 0-20 asteen asteikolla (0 astetta = kortin
// pohja, 20 astetta = kortin yläreuna), rajattuna asteikon ulkopuolelta
// tulevilta arvoilta.
export function getWeeklyInletTemperaturePointHeightPercent(
  minimumInletTempC: number,
): number {
  const clampedTemperature = Math.min(
    Math.max(minimumInletTempC, weeklyInletTemperatureChartMinC),
    weeklyInletTemperatureChartMaxC,
  );

  return (
    ((clampedTemperature - weeklyInletTemperatureChartMinC) /
      (weeklyInletTemperatureChartMaxC - weeklyInletTemperatureChartMinC)) *
    100
  );
}

export type InletTrendPeriod = {
  endIso: string;
  isCurrent: boolean;
  label: string;
  startIso: string;
};

function stripFinnishMonthSuffix(monthName: string) {
  return monthName.endsWith("kuu") ? monthName.slice(0, -3) : monthName;
}

function capitalizeFirstLetter(text: string) {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function formatInletTrendPeriodLabel(
  firstMonth: number,
  lastMonth: number,
  year: number,
) {
  const firstMonthLabel = stripFinnishMonthSuffix(
    finnishMonthNames[firstMonth - 1],
  );
  const lastMonthLabel = finnishMonthNames[lastMonth - 1];

  return capitalizeFirstLetter(`${firstMonthLabel}–${lastMonthLabel} ${year}`);
}

// offset 0 = kuluva vuosineljännes (tammi-maalis, huhti-kesä, heinä-syys tai
// loka-joulu, sen mukaan mihin kuluva kuukausi osuu), offset 1 = edellinen
// vuosineljännes jne. Jaksot ovat siis kiinteitä kalenterikvartaaleja, ei
// liukuvia kuukausi-ikkunoita, jolloin koko vuosi jakautuu neljään
// jaksoon eikä esim. elokuu jää kahden eri näkymän väliin.
export function getInletTrendPeriod(
  offset: number,
  now = new Date(),
): InletTrendPeriod {
  const clampedOffset = Math.max(offset, 0);
  const nowParts = getHelsinkiDateParts(now);
  const currentQuarterOrdinal =
    nowParts.year * 4 + Math.floor((nowParts.month - 1) / 3);
  const targetQuarterOrdinal = currentQuarterOrdinal - clampedOffset;

  const targetYear = Math.floor(targetQuarterOrdinal / 4);
  const targetQuarterIndex = targetQuarterOrdinal % 4;
  const firstMonth = targetQuarterIndex * 3 + 1;
  const lastMonth = firstMonth + 2;

  const start = getUtcDateForHelsinkiLocalTime({
    day: 1,
    month: firstMonth,
    year: targetYear,
  });
  const end = getUtcDateForHelsinkiLocalTime({
    day: 1,
    month: lastMonth + 1,
    year: targetYear,
  });

  return {
    endIso: end.toISOString(),
    isCurrent: clampedOffset === 0,
    label: formatInletTrendPeriodLabel(firstMonth, lastMonth, targetYear),
    startIso: start.toISOString(),
  };
}

export type InletTrendSlot = {
  minimumInletTempC: number | null;
  weekStart: string;
};

// Kaikkien jakson kalenteriviikkojen (maanantaista alkaen, sama sääntö
// kuin RPC:n date_trunc('week', ...)) alkupäivät. Käytetään pisteiden
// sijoitteluun niin, että viikko, jolta ei löytynyt vahvistettua lukemaa,
// jää tyhjäksi kohdakseen sen sijaan että jäljellä olevat pisteet
// litistyisivät vierekkäin ja vääristäisivät trendin kaltevuutta.
export function getInletTrendPeriodWeekStarts(period: InletTrendPeriod) {
  const startDayKey = getHelsinkiDayKey(new Date(period.startIso));
  const endDayKeyExclusive = getHelsinkiDayKey(new Date(period.endIso));
  const startWeekday = new Date(`${startDayKey}T12:00:00.000Z`).getUTCDay();
  const mondayOffset = (startWeekday + 6) % 7;

  const weekStarts: string[] = [];
  let weekStartKey = addHelsinkiCalendarDays(startDayKey, -mondayOffset);

  while (weekStartKey < endDayKeyExclusive) {
    weekStarts.push(weekStartKey);
    weekStartKey = addHelsinkiCalendarDays(weekStartKey, 7);
  }

  return weekStarts;
}

export function buildInletTrendSlots(
  period: InletTrendPeriod,
  points: WeeklyInletTemperaturePoint[],
): InletTrendSlot[] {
  const minimumInletTempCByWeekStart = new Map(
    points.map((point) => [point.weekStart, point.minimumInletTempC]),
  );

  return getInletTrendPeriodWeekStarts(period).map((weekStart) => ({
    minimumInletTempC: minimumInletTempCByWeekStart.get(weekStart) ?? null,
    weekStart,
  }));
}

function formatDayKeyAsShortFinnishDate(dayKey: string) {
  const [, month, day] = dayKey.split("-");

  return `${Number(day)}.${Number(month)}.`;
}

// "week_start" on aina viikon maanantai, mikä voi harhaanjohtaa (esim.
// asennuspäivä osuu viikon loppuun, jolloin "2026-07-27" näyttää
// vanhemmalta kuin data oikeasti on). Tämä muotoilee koko viikon rangen
// esim. "27.7.–2.8." pelkän alkupäivän sijaan.
export function formatInletTrendWeekRangeLabel(weekStart: string) {
  const weekEnd = addHelsinkiCalendarDays(weekStart, 6);

  return `${formatDayKeyAsShortFinnishDate(weekStart)}–${formatDayKeyAsShortFinnishDate(weekEnd)}`;
}

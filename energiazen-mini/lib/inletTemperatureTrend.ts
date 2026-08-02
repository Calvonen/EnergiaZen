// Tulovesianturin viikoittainen trendikäyrä (app/history.tsx). Datan
// laskee palvelinpuolella get_weekly_minimum_inlet_temperature-RPC (ks.
// supabase/migrations/20260803000000_add_weekly_minimum_inlet_temperature_rpc.sql),
// joka käyttää samaa "vahvistetun minimin" periaatetta kuin
// lib/inletTemperature.ts:n calculateMinimumValidInletTemperature - tämä
// tiedosto vain muuntaa RPC:n rivit näyttöä varten, ei laske minimiä
// itse.
//
// Näkymä on jaettu 3 kuukauden jaksoihin (kuten touko-heinäkuu), joita
// voi selata taaksepäin samaan tapaan kuin päivähistorian ‹ › -nuolilla
// (ks. getInletTrendPeriod).
import {
  getHelsinkiDateParts,
  getUtcDateForHelsinkiLocalTime,
} from "./temperatureHistoryDay";

export const weeklyInletTemperaturePeriodMonths = 3;
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
  firstYear: number,
  lastMonth: number,
  lastYear: number,
) {
  const lastMonthLabel = finnishMonthNames[lastMonth - 1];

  if (firstYear !== lastYear) {
    const firstMonthLabel = finnishMonthNames[firstMonth - 1];

    return capitalizeFirstLetter(
      `${firstMonthLabel} ${firstYear} – ${lastMonthLabel} ${lastYear}`,
    );
  }

  const firstMonthLabel = stripFinnishMonthSuffix(
    finnishMonthNames[firstMonth - 1],
  );

  return capitalizeFirstLetter(`${firstMonthLabel}–${lastMonthLabel} ${lastYear}`);
}

// offset 0 = viimeiset weeklyInletTemperaturePeriodMonths kuukautta (kuluva
// kuukausi mukaan lukien), offset 1 = sitä edeltävä jakso jne. Jaksot eivät
// ole sidottuja kalenterivuosineljänneksiin vaan liukuvat kuluvasta
// kuukaudesta taaksepäin, kuten päivähistorian ‹ › -selain liikkuu päivä
// kerrallaan.
export function getInletTrendPeriod(
  offset: number,
  now = new Date(),
): InletTrendPeriod {
  const clampedOffset = Math.max(offset, 0);
  const nowParts = getHelsinkiDateParts(now);
  const lastMonthOrdinal =
    nowParts.year * 12 +
    (nowParts.month - 1) -
    clampedOffset * weeklyInletTemperaturePeriodMonths;
  const firstMonthOrdinal =
    lastMonthOrdinal - (weeklyInletTemperaturePeriodMonths - 1);

  const firstYear = Math.floor(firstMonthOrdinal / 12);
  const firstMonth = (firstMonthOrdinal % 12) + 1;
  const lastYear = Math.floor(lastMonthOrdinal / 12);
  const lastMonth = (lastMonthOrdinal % 12) + 1;

  const start = getUtcDateForHelsinkiLocalTime({
    day: 1,
    month: firstMonth,
    year: firstYear,
  });
  const end = getUtcDateForHelsinkiLocalTime({
    day: 1,
    month: lastMonth + 1,
    year: lastYear,
  });

  return {
    endIso: end.toISOString(),
    isCurrent: clampedOffset === 0,
    label: formatInletTrendPeriodLabel(firstMonth, firstYear, lastMonth, lastYear),
    startIso: start.toISOString(),
  };
}

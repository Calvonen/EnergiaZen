// Tulovesianturin viikoittainen trendikäyrä (app/history.tsx). Datan
// laskee palvelinpuolella get_weekly_minimum_inlet_temperature-RPC (ks.
// supabase/migrations/20260803000000_add_weekly_minimum_inlet_temperature_rpc.sql),
// joka käyttää samaa "vahvistetun minimin" periaatetta kuin
// lib/inletTemperature.ts:n calculateMinimumValidInletTemperature - tämä
// tiedosto vain muuntaa RPC:n rivit näyttöä varten, ei laske minimiä
// itse.
export const weeklyInletTemperatureTrendWeeks = 12;
export const weeklyInletTemperatureChartMinC = 0;
export const weeklyInletTemperatureChartMaxC = 20;

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

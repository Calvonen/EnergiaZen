import {
  getWeeklyInletTemperaturePointHeightPercent,
  mapWeeklyInletTemperatureRows,
  weeklyInletTemperatureChartMaxC,
  weeklyInletTemperatureChartMinC,
} from "./inletTemperatureTrend";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runInletTemperatureTrendUnitTests() {
  assertEqual(
    mapWeeklyInletTemperatureRows(null),
    [],
    "puuttuva rivijoukko tuottaa tyhjän listan",
  );
  assertEqual(
    mapWeeklyInletTemperatureRows([]),
    [],
    "tyhjä rivijoukko tuottaa tyhjän listan",
  );
  assertEqual(
    mapWeeklyInletTemperatureRows([
      { minimum_inlet_temp: 8.5, week_start: "2026-07-20" },
      { minimum_inlet_temp: null, week_start: "2026-07-27" },
      { minimum_inlet_temp: 9.2, week_start: null },
      { minimum_inlet_temp: Number.NaN, week_start: "2026-08-03" },
    ]),
    [{ minimumInletTempC: 8.5, weekStart: "2026-07-20" }],
    "puutteelliset ja virheelliset rivit suodatetaan pois",
  );
  assertEqual(
    mapWeeklyInletTemperatureRows([
      { minimum_inlet_temp: 9.1, week_start: "2026-08-03" },
      { minimum_inlet_temp: 8.5, week_start: "2026-07-20" },
      { minimum_inlet_temp: 8.9, week_start: "2026-07-27" },
    ]),
    [
      { minimumInletTempC: 8.5, weekStart: "2026-07-20" },
      { minimumInletTempC: 8.9, weekStart: "2026-07-27" },
      { minimumInletTempC: 9.1, weekStart: "2026-08-03" },
    ],
    "rivit järjestetään viikon alkupäivän mukaan",
  );

  assertEqual(
    getWeeklyInletTemperaturePointHeightPercent(weeklyInletTemperatureChartMinC),
    0,
    "asteikon alaraja on 0 %",
  );
  assertEqual(
    getWeeklyInletTemperaturePointHeightPercent(weeklyInletTemperatureChartMaxC),
    100,
    "asteikon yläraja on 100 %",
  );
  assertEqual(
    getWeeklyInletTemperaturePointHeightPercent(10),
    50,
    "asteikon keskikohta on 50 %",
  );
  assertEqual(
    getWeeklyInletTemperaturePointHeightPercent(-5),
    0,
    "asteikon alle jäävä arvo rajataan 0 %:iin",
  );
  assertEqual(
    getWeeklyInletTemperaturePointHeightPercent(25),
    100,
    "asteikon yli menevä arvo rajataan 100 %:iin",
  );
}

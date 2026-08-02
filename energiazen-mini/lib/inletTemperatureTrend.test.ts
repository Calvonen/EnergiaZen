import {
  getInletTrendPeriod,
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

  const summerNow = new Date("2026-08-02T10:00:00.000Z");
  const currentPeriod = getInletTrendPeriod(0, summerNow);
  assertEqual(
    currentPeriod,
    {
      endIso: "2026-08-31T21:00:00.000Z",
      isCurrent: true,
      label: "Kesä–elokuu 2026",
      startIso: "2026-05-31T21:00:00.000Z",
    },
    "kuluva jakso on kolme viimeisintä kuukautta kuluva kuukausi mukaan lukien",
  );

  const previousPeriod = getInletTrendPeriod(1, summerNow);
  assertEqual(
    previousPeriod,
    {
      endIso: "2026-05-31T21:00:00.000Z",
      isCurrent: false,
      label: "Maalis–toukokuu 2026",
      startIso: "2026-02-28T22:00:00.000Z",
    },
    "edellinen jakso jatkuu saumattomasti kuluvan jakson alusta taaksepäin",
  );

  const winterNow = new Date("2026-01-15T10:00:00.000Z");
  const yearCrossingPeriod = getInletTrendPeriod(0, winterNow);
  assertEqual(
    yearCrossingPeriod,
    {
      endIso: "2026-01-31T22:00:00.000Z",
      isCurrent: true,
      label: "Marraskuu 2025 – tammikuu 2026",
      startIso: "2025-10-31T22:00:00.000Z",
    },
    "vuodenvaihteen ylittävä jakso näyttää molemmat vuodet",
  );

  assertEqual(
    getInletTrendPeriod(-1, summerNow),
    currentPeriod,
    "negatiivinen offset rajataan kuluvaan jaksoon",
  );
}

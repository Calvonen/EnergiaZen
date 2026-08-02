import {
  buildInletTrendSlots,
  formatInletTrendWeekRangeLabel,
  getInletTrendPeriod,
  getInletTrendPeriodWeekStarts,
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
      endIso: "2026-09-30T21:00:00.000Z",
      isCurrent: true,
      label: "Heinä–syyskuu 2026",
      startIso: "2026-06-30T21:00:00.000Z",
    },
    "elokuu osuu heinä-syyskuun kvartaaliin, kuluva jakso on kiinteä kalenterikvartaali",
  );

  const previousPeriod = getInletTrendPeriod(1, summerNow);
  assertEqual(
    previousPeriod,
    {
      endIso: "2026-06-30T21:00:00.000Z",
      isCurrent: false,
      label: "Huhti–kesäkuu 2026",
      startIso: "2026-03-31T21:00:00.000Z",
    },
    "edellinen jakso on edellinen kalenterikvartaali (huhti-kesäkuu)",
  );

  const twoQuartersBackPeriod = getInletTrendPeriod(2, summerNow);
  assertEqual(
    twoQuartersBackPeriod,
    {
      endIso: "2026-03-31T21:00:00.000Z",
      isCurrent: false,
      label: "Tammi–maaliskuu 2026",
      startIso: "2025-12-31T22:00:00.000Z",
    },
    "kaksi kvartaalia taaksepäin on tammi-maaliskuu",
  );

  const yearCrossingPeriod = getInletTrendPeriod(3, summerNow);
  assertEqual(
    yearCrossingPeriod,
    {
      endIso: "2025-12-31T22:00:00.000Z",
      isCurrent: false,
      label: "Loka–joulukuu 2025",
      startIso: "2025-09-30T21:00:00.000Z",
    },
    "kolme kvartaalia taaksepäin ylittää vuodenvaihteen ja on kokonaan edellisvuonna",
  );

  assertEqual(
    getInletTrendPeriod(-1, summerNow),
    currentPeriod,
    "negatiivinen offset rajataan kuluvaan jaksoon",
  );

  assertEqual(
    getInletTrendPeriodWeekStarts(currentPeriod),
    [
      "2026-06-29",
      "2026-07-06",
      "2026-07-13",
      "2026-07-20",
      "2026-07-27",
      "2026-08-03",
      "2026-08-10",
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
    ],
    "jakson viikot alkavat maanantaisin ja kattavat koko kvartaalin",
  );

  assertEqual(
    buildInletTrendSlots(currentPeriod, [
      { minimumInletTempC: 8.5, weekStart: "2026-07-20" },
      { minimumInletTempC: 8.1, weekStart: "2026-08-03" },
    ]).map((slot) => slot.minimumInletTempC),
    [
      null, null, null,
      8.5, null,
      8.1, null, null, null, null, null, null, null, null,
    ],
    "viikot, joilta ei löytynyt vahvistettua lukemaa, jäävät tyhjiksi eivätkä siirrä muita pisteitä",
  );

  assertEqual(
    formatInletTrendWeekRangeLabel("2026-07-27"),
    "27.7.–2.8.",
    "viikon range näyttää koko maanantaista sunnuntaihin ulottuvan jakson, ei pelkkää alkupäivää",
  );
}

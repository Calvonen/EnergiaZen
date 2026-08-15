import fs from "node:fs";
import path from "node:path";

import { getFinnishDateKey, getHelsinkiHourNumber } from "../lib/heatingLogic";
import { normalizeStoredHeatingPlanHours } from "../lib/heatingPlanMarkers";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

type MockHourlyPrice = { date: Date; endDate: Date; startDate: string };
type MockOptimizerHour = { date: Date; id: string; startDate: string };

function helsinkiHourInterval(day: number, helsinkiHour: number): MockHourlyPrice {
  const startDate = new Date(Date.UTC(2026, 7, day, helsinkiHour - 3));
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

  return { date: startDate, endDate, startDate: startDate.toISOString() };
}

// Mallintaa (samoilla, oikeilla getFinnishDateKey/getHelsinkiHourNumber-
// funktioilla) app/(tabs)/index.tsx:n storedHeatingPlanPresentation-useMemon
// tavan mapata yksi backendin planned_hours-tunti optimizer-hour-ID:ksi.
function findOptimizerHourId(
  optimizerHours: MockOptimizerHour[],
  planDate: string,
  hour: number,
): string | null {
  const match = optimizerHours.find(
    (item) =>
      getFinnishDateKey(item.startDate) === planDate &&
      getHelsinkiHourNumber(item.date) === hour,
  );

  return match ? match.id : null;
}

// Mallintaa index.tsx:n relevantStoredPlanHours-suodattimen: huomisen tunnit
// ovat aina relevantteja, mutta tanaan jo paattynyt tunti (endDate <=
// currentHourStart) ei ole enaa relevantti - forecast alkaa nykyisesta
// tankkitilasta, joten sita ei tarvitse loytaa optimizer-hour-ikkunasta.
function isRelevantStoredHour({
  currentHourStart,
  hour,
  hourlyPrices,
  planDate,
  todayPlanDate,
}: {
  currentHourStart: Date;
  hour: number;
  hourlyPrices: MockHourlyPrice[];
  planDate: string;
  todayPlanDate: string;
}): boolean {
  if (planDate !== todayPlanDate) {
    return true;
  }

  const priceHour = hourlyPrices.find(
    (item) =>
      getFinnishDateKey(item.startDate) === planDate &&
      getHelsinkiHourNumber(item.date) === hour,
  );

  return (
    !priceHour || priceHour.endDate.getTime() > currentHourStart.getTime()
  );
}

export function runStoredHeatingPlanForecastFailClosedSourceTests() {
  const todayPlanDate = "2026-08-15";

  // --- Skenaario 1: backend today [1, 15], optimizerHours sisaltaa vain
  // tulevan klo 15:n (klo 01 on jo paattynyt eika kuulu enaa optimoijan
  // aikaikkunaan). ---
  const currentHourStart = helsinkiHourInterval(15, 15).date; // "nyt" = tasan klo 15 Helsinkia
  const hourlyPrices = [
    helsinkiHourInterval(15, 1),
    helsinkiHourInterval(15, 15),
  ];
  const optimizerHoursWithHour15: MockOptimizerHour[] = [
    {
      date: helsinkiHourInterval(15, 15).date,
      id: "opt:2026-08-15:15",
      startDate: helsinkiHourInterval(15, 15).startDate,
    },
  ];

  const plannedHoursToday = normalizeStoredHeatingPlanHours([1, 15]);
  assertEqual(
    plannedHoursToday,
    [1, 15],
    "testiskenaarion backend-tunnit normalisoituvat odotetusti",
  );

  const relevantHoursToday = plannedHoursToday.filter((hour) =>
    isRelevantStoredHour({
      currentHourStart,
      hour,
      hourlyPrices,
      planDate: todayPlanDate,
      todayPlanDate,
    }),
  );
  assertEqual(
    relevantHoursToday,
    [15],
    "klo 01 on jo paattynyt eika ole enaa relevantti ennusteen mapping/count-tarkistukselle - vain klo 15 jaa relevantiksi",
  );

  const storedPlannedHourCount = relevantHoursToday.length;
  const storedSelectedHeatingHourIds = relevantHoursToday.flatMap((hour) => {
    const id = findOptimizerHourId(optimizerHoursWithHour15, todayPlanDate, hour);

    return id ? [id] : [];
  });

  assertEqual(
    storedSelectedHeatingHourIds,
    ["opt:2026-08-15:15"],
    "relevantti klo 15 mapataan yksikasitteisesti optimizer-hour-ID:ksi ja simuloidaan",
  );
  assertEqual(
    storedSelectedHeatingHourIds.length === storedPlannedHourCount,
    true,
    "klo 01:n puuttuminen optimizerHoursista ei fail-closedaa ennustetta, koska se ei ole enaa relevantti aikaikkunan ulkopuolelle jaaneena",
  );

  // Jos relevantti klo 15 PUUTTUU optimizerHoursista (esim. hinnat eivat
  // viela latautuneet talle tunnille), fail-closed laukeaa edelleen.
  const optimizerHoursWithoutHour15: MockOptimizerHour[] = [];
  const storedSelectedHeatingHourIdsMissingHour15 = relevantHoursToday.flatMap(
    (hour) => {
      const id = findOptimizerHourId(
        optimizerHoursWithoutHour15,
        todayPlanDate,
        hour,
      );

      return id ? [id] : [];
    },
  );
  assertEqual(
    storedSelectedHeatingHourIdsMissingHour15.length === storedPlannedHourCount,
    false,
    "jos relevantti klo 15 puuttuu optimizerHoursista, fail-closed laukeaa edelleen (forecast=null)",
  );

  // --- Skenaario 2 (aiempi regressiotesti): kaksi relevanttia tuntia,
  // joista vain toinen loytyy -> forecast=null. ---
  const mismatchOptimizerHours: MockOptimizerHour[] = [
    {
      date: helsinkiHourInterval(15, 10).date,
      id: "opt:2026-08-15:10",
      startDate: helsinkiHourInterval(15, 10).startDate,
    },
  ];
  const mismatchPlannedHours = normalizeStoredHeatingPlanHours([10, 11]);
  const mismatchStoredSelectedHeatingHourIds = mismatchPlannedHours.flatMap(
    (hour) => {
      const id = findOptimizerHourId(mismatchOptimizerHours, todayPlanDate, hour);

      return id ? [id] : [];
    },
  );
  assertEqual(
    mismatchStoredSelectedHeatingHourIds.length === mismatchPlannedHours.length,
    false,
    "matched ID:iden maara (1) ei vastaa backendin suunniteltujen tuntien maaraa (2), kun yksi tunti puuttuu optimizerHoursista",
  );
  const forecast =
    mismatchStoredSelectedHeatingHourIds.length === mismatchPlannedHours.length
      ? "ennuste_simuloitaisiin_tassa"
      : null;
  assertEqual(
    forecast,
    null,
    "kun backendin kaksi tuntia loytyvat vain osittain optimizerHoursista, stored-planin ennuste jaa neutraaliksi eika naytata vajaalla tuntijoukolla simuloitua ennustetta",
  );

  // Tyhja backend-suunnitelma (0 tuntia) on validi eika saa laueta fail-closediin.
  const emptyPlannedHours = normalizeStoredHeatingPlanHours([]);
  assertEqual(
    emptyPlannedHours.length === 0,
    true,
    "tyhja backend-suunnitelma (0 tuntia) on validi eika saa epaonnistua fail-closed-tarkistuksessa",
  );

  // --- Rakenteellinen ankkuri app/(tabs)/index.tsx:aan - varmistaa etta
  // fail-closed- ja aikaikkunarajausehdot ovat oikeasti koodissa talla
  // samalla kaavalla, eika tama testi ole eriytynyt todellisesta koodista. ---
  const homeSource = fs.readFileSync(
    path.resolve(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );
  const storedMemoStart = homeSource.indexOf(
    "const storedHeatingPlanPresentation = useMemo(",
  );
  const relevantStart = homeSource.indexOf(
    "const relevantStoredPlanHours = storedPlans.flatMap(",
    storedMemoStart,
  );
  const countStart = homeSource.indexOf(
    "const storedPlannedHourCount = relevantStoredPlanHours.length;",
    storedMemoStart,
  );
  const idsStart = homeSource.indexOf(
    "const storedSelectedHeatingHourIds = relevantStoredPlanHours.flatMap(",
    storedMemoStart,
  );
  const forecastStart = homeSource.indexOf(
    "const forecast =",
    storedMemoStart,
  );
  const forecastEnd = homeSource.indexOf(
    "return buildStoredHeatingPlanPresentation(",
    storedMemoStart,
  );
  const relevantBlock =
    relevantStart !== -1 && countStart !== -1
      ? homeSource.slice(relevantStart, countStart)
      : "";
  const forecastBlock =
    forecastStart !== -1 && forecastEnd !== -1
      ? homeSource.slice(forecastStart, forecastEnd)
      : "";

  assertSource(
    storedMemoStart !== -1 &&
      relevantStart > storedMemoStart &&
      countStart > relevantStart &&
      idsStart > countStart &&
      forecastStart > idsStart &&
      forecastEnd > forecastStart,
    "storedHeatingPlanPresentation must compute the relevant (within-window) planned hours, then the total count and the matched IDs, before deciding whether to build the forecast",
  );
  assertSource(
    relevantBlock.includes("planDate !== todayPlanDate") &&
      relevantBlock.includes(
        "priceHour.endDate.getTime() > currentHourStart.getTime()",
      ),
    "jo paattyneet tamanpaivaiset backend-tunnit rajataan pois relevanttien tuntien joukosta - huomisen tunnit ovat aina relevantteja",
  );
  assertSource(
    forecastBlock.includes(
      "storedSelectedHeatingHourIds.length === storedPlannedHourCount",
    ) &&
      forecastBlock.includes("? buildStoredHeatingPlanForecastFields(") &&
      forecastBlock.includes(": null;"),
    "ennuste (forecast) rakennetaan VAIN kun jokainen relevantti backendin suunniteltu tunti on loytynyt yksikasitteisesti optimizer-hour-ID:na - muuten forecast=null eika vajaalla tuntijoukolla simuloitua ennustetta nayteta",
  );
  assertSource(
    homeSource.includes(
      "getFinnishDateKey(item.startDate) === planDate &&\n              getHelsinkiHourNumber(item.date) === hour,",
    ),
    "tunnin mapatus optimizer-hour-ID:ksi kayttaa paivamaaraa JA Helsinki-tuntinumeroa - sama logiikka jota talla testilla mallinnetaan findOptimizerHourId-avulla",
  );
}

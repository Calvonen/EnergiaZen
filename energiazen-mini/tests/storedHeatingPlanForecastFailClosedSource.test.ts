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

// Mallintaa (samoilla, oikeilla getFinnishDateKey/getHelsinkiHourNumber-
// funktioilla) app/(tabs)/index.tsx:n storedHeatingPlanPresentation-useMemon
// tavan mapata yksi backendin planned_hours-tunti optimizer-hour-ID:ksi.
function findOptimizerHourId(
  optimizerHours: { date: Date; id: string; startDate: string }[],
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

export function runStoredHeatingPlanForecastFailClosedSourceTests() {
  const planDate = "2026-08-15";
  // Vain klo 10 loytyy optimizer-hour-listasta - klo 11 on jo poistunut
  // aktiivisen optimoijan aikaikkunasta (esim. tunti on jo mennyt tai
  // hinnat eivat ole viela latautuneet talle tunnille).
  const optimizerHours = [
    {
      date: new Date("2026-08-15T07:00:00.000Z"),
      id: "opt:2026-08-15:10",
      startDate: "2026-08-15T07:00:00.000Z",
    },
  ];

  // Backend on tallentanut KAKSI suunniteltua tuntia (klo 10 ja klo 11).
  const plannedHours = normalizeStoredHeatingPlanHours([10, 11]);
  assertEqual(
    plannedHours,
    [10, 11],
    "testiskenaarion oletustunnit normalisoituvat odotetusti",
  );

  const storedPlannedHourCount = plannedHours.length;
  const storedSelectedHeatingHourIds = plannedHours.flatMap((hour) => {
    const id = findOptimizerHourId(optimizerHours, planDate, hour);

    return id ? [id] : [];
  });

  assertEqual(
    storedSelectedHeatingHourIds,
    ["opt:2026-08-15:10"],
    "vain toinen kahdesta backend-tunnista loytyy optimizerHours-listasta talla testiskenaariolla",
  );
  assertEqual(
    storedSelectedHeatingHourIds.length === storedPlannedHourCount,
    false,
    "matched ID:iden maara (1) ei vastaa backendin suunniteltujen tuntien maaraa (2), kun yksi tunti puuttuu optimizerHoursista",
  );

  // Sama fail-closed-ehto kuin index.tsx:n storedHeatingPlanPresentation
  // kayttaa forecastin rakentamiseen: mismatch => forecast jaa neutraaliksi
  // (null) eika vajaalla tuntijoukolla simuloitua ennustetta nayteta.
  const forecast =
    storedSelectedHeatingHourIds.length === storedPlannedHourCount
      ? "ennuste_simuloitaisiin_tassa"
      : null;
  assertEqual(
    forecast,
    null,
    "kun backendin kaksi suunniteltua tuntia loytyvat vain osittain optimizerHoursista, stored-planin ennuste jaa neutraaliksi eika naytata vajaalla yhdella tunnilla simuloitua ennustetta",
  );

  // Tyhja backend-suunnitelma (0 tuntia) on validi eika saa laueta fail-closediin.
  const emptyPlannedHours = normalizeStoredHeatingPlanHours([]);
  const emptyStoredSelectedHeatingHourIds = emptyPlannedHours.flatMap(
    (hour) => {
      const id = findOptimizerHourId(optimizerHours, planDate, hour);

      return id ? [id] : [];
    },
  );
  assertEqual(
    emptyStoredSelectedHeatingHourIds.length === emptyPlannedHours.length,
    true,
    "tyhja backend-suunnitelma (0 tuntia) on validi eika saa epaonnistua fail-closed-tarkistuksessa",
  );

  // Rakenteellinen ankkuri app/(tabs)/index.tsx:aan - varmistaa etta yllattava
  // fail-closed-ehto on oikeasti koodissa talla samalla kaavalla, eika vain
  // talla testilla mallinnettu kaava ole eriytynyt todellisesta koodista.
  const homeSource = fs.readFileSync(
    path.resolve(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );
  const storedMemoStart = homeSource.indexOf(
    "const storedHeatingPlanPresentation = useMemo(",
  );
  const countStart = homeSource.indexOf(
    "const storedPlannedHourCount = storedPlans.reduce(",
    storedMemoStart,
  );
  const idsStart = homeSource.indexOf(
    "const storedSelectedHeatingHourIds = storedPlans.flatMap(",
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
  const forecastBlock =
    forecastStart !== -1 && forecastEnd !== -1
      ? homeSource.slice(forecastStart, forecastEnd)
      : "";

  assertSource(
    storedMemoStart !== -1 &&
      countStart > storedMemoStart &&
      idsStart > countStart &&
      forecastStart > idsStart &&
      forecastEnd > forecastStart,
    "storedHeatingPlanPresentation must compute the total planned-hour count and the matched IDs before deciding whether to build the forecast",
  );
  assertSource(
    forecastBlock.includes(
      "storedSelectedHeatingHourIds.length === storedPlannedHourCount",
    ) &&
      forecastBlock.includes("? buildStoredHeatingPlanForecastFields(") &&
      forecastBlock.includes(": null;"),
    "ennuste (forecast) rakennetaan VAIN kun jokainen backendin suunniteltu tunti on loytynyt yksikasitteisesti optimizer-hour-ID:na - muuten forecast=null eika vajaalla tuntijoukolla simuloitua ennustetta nayteta",
  );
  assertSource(
    homeSource.includes(
      "getFinnishDateKey(item.startDate) === planDate &&\n              getHelsinkiHourNumber(item.date) === hour,",
    ),
    "tunnin mapatus optimizer-hour-ID:ksi kayttaa paivamaaraa JA Helsinki-tuntinumeroa - sama logiikka jota talla testilla mallinnetaan findOptimizerHourId-avulla",
  );
}

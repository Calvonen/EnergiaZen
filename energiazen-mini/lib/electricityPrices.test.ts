import {
  calculateHeatedPriceHistory,
  deduplicateElectricityPrices,
  ElectricityPriceRecord,
  filterElectricityPricesByRange,
  filterHeatingPeriodsByRange,
  formatFinnishHistoryDate,
  getElectricityHistoryRangeStartIso,
  getHelsinkiElectricityDateKey,
  getHeatingDayEmptyLabel,
  getResolutionMinutes,
  getRollingHistoryWindowRangeIso,
  getTotalPriceCentsPerKwh,
  groupElectricityPricesByHelsinkiDay,
  summarizeElectricityPriceWindow,
} from "./electricityPrices";
import type { HeatingEnergyPeriod } from "./heatingHistory";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function price(
  startsAt: string,
  resolutionMinutes = 60,
  spotPrice = 0.9,
): ElectricityPriceRecord {
  return {
    ends_at: new Date(Date.parse(startsAt) + resolutionMinutes * 60_000).toISOString(),
    region: "FI",
    resolution_minutes: resolutionMinutes,
    spot_price_cents_kwh: spotPrice,
    starts_at: startsAt,
  };
}

function heatingPeriod(
  startedAt: string,
  endedAt: string,
): HeatingEnergyPeriod {
  const durationMinutes = (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000;
  return {
    duration_minutes: durationMinutes,
    ended_at: endedAt,
    energy_source: "estimated",
    estimated_energy_kwh: (durationMinutes / 60) * 3,
    measured_energy_kwh: null,
    started_at: startedAt,
  };
}

export function runElectricityPricesUnitTests() {
  assertEqual(
    formatFinnishHistoryDate("2026-07-24"),
    "Pe 24.7.2026",
    "päivämäärä näytetään suomalaisessa muodossa ilman etunollia",
  );
  assertEqual(
    getTotalPriceCentsPerKwh(0.9),
    9.52,
    "spot 0,90 muodostaa kokonaishinnan 9,52 c/kWh",
  );
  assertEqual(
    getTotalPriceCentsPerKwh(-2),
    6.62,
    "negatiivinen spot-hinta käsitellään oikein",
  );

  const sameStart = "2026-07-24T10:00:00.000Z";
  assertEqual(
    deduplicateElectricityPrices([
      price(sameStart),
      price(sameStart),
      price(sameStart, 15),
    ]).length,
    2,
    "upsert-avain poistaa duplikaatin mutta säilyttää eri resoluution",
  );
  assertEqual(
    getResolutionMinutes(sameStart, "2026-07-24T11:00:00.000Z"),
    60,
    "tunnin jakso tunnistetaan 60 minuutiksi",
  );
  assertEqual(
    getResolutionMinutes(sameStart, "2026-07-24T10:15:00.000Z"),
    15,
    "tietomalli hyväksyy 15 minuutin jakson",
  );
  assertEqual(
    getHelsinkiElectricityDateKey("2026-07-23T21:30:00.000Z"),
    "2026-07-24",
    "päiväryhmittely käyttää Europe/Helsinki-aikaa",
  );
  assertEqual(
    groupElectricityPricesByHelsinkiDay([]),
    [],
    "tyhjä historia ei kaada näkymämallia",
  );
  assertEqual(
    groupElectricityPricesByHelsinkiDay([
      price("2026-07-24T01:00:00.000Z", 60, 10),
      price("2026-07-24T02:00:00.000Z", 15, 20),
    ])[0].averageSpotPrice,
    12,
    "päivän keskihinta painotetaan hintajaksojen kestolla",
  );

  const now = new Date("2026-07-24T12:00:00.000Z");
  const rows = [
    price("2026-07-24T08:00:00.000Z"),
    price("2026-07-18T08:00:00.000Z"),
    price("2026-07-17T08:00:00.000Z"),
    price("2026-06-25T08:00:00.000Z"),
    price("2026-06-24T08:00:00.000Z"),
  ];
  assertEqual(
    filterElectricityPricesByRange(rows, 7, now).length,
    2,
    "7 päivän rajaus toimii",
  );
  assertEqual(
    filterElectricityPricesByRange(rows, 30, now).length,
    4,
    "30 päivän rajaus toimii",
  );
  const dailyPrices = groupElectricityPricesByHelsinkiDay([
    price("2026-07-24T01:00:00.000Z", 60, -2),
    price("2026-07-24T02:00:00.000Z", 60, 10),
  ])[0];
  assertEqual(
    [
      dailyPrices.averageSpotPrice,
      dailyPrices.averageTotalPrice,
      dailyPrices.lowestSpotPrice,
      dailyPrices.lowestTotalPrice,
      dailyPrices.highestSpotPrice,
      dailyPrices.highestTotalPrice,
    ],
    [4, 12.62, -2, 6.62, 10, 18.62],
    "keski-, alin- ja korkein spot- ja kokonaishinta lasketaan rinnakkain",
  );

  const oneHourPeriod = heatingPeriod(
    "2026-07-24T01:00:00.000Z",
    "2026-07-24T02:00:00.000Z",
  );
  const oneHourHeated = calculateHeatedPriceHistory(
    [oneHourPeriod],
    [price("2026-07-24T01:00:00.000Z", 60, 10)],
  )[0];
  assertEqual(oneHourHeated.energyKwh, 3, "60 min lämmitys 3 kW teholla on 3,0 kWh");

  const partialPeriod = heatingPeriod(
    "2026-07-24T02:15:00.000Z",
    "2026-07-24T03:00:00.000Z",
  );
  const partialHeated = calculateHeatedPriceHistory(
    [partialPeriod],
    [price("2026-07-24T02:00:00.000Z", 60, 10)],
  )[0];
  assertEqual(partialHeated.energyKwh, 2.25, "45 min jakso on 2,25 kWh");
  assertEqual(
    Math.round(partialHeated.costEuros * 100_000) / 100_000,
    0.41895,
    "osittaisen lämmitysjakson kustannus käyttää kokonaishintaa",
  );

  const crossingPeriod = heatingPeriod(
    "2026-07-24T01:40:00.000Z",
    "2026-07-24T02:25:00.000Z",
  );
  const crossingPrices = [
    price("2026-07-24T01:00:00.000Z", 60, 10),
    price("2026-07-24T02:00:00.000Z", 60, 20),
  ];
  const crossing = calculateHeatedPriceHistory(
    [crossingPeriod],
    crossingPrices,
  )[0];
  assertEqual(
    crossing.segments.map((segment) => segment.durationMinutes),
    [20, 25],
    "tuntirajan ylittävä jakso jaetaan kahdelle hinnalle",
  );
  assertEqual(
    Math.round(crossing.costEuros * 100_000) / 100_000,
    0.54395,
    "hintarajan ylittävän jakson kokonaishintaiset kustannukset summataan osuuksittain",
  );
  assertEqual(
    Math.round((crossing.weightedAveragePrice ?? 0) * 100) / 100,
    24.18,
    "lämmitetty kokonaishinta painotetaan ajan mukaan",
  );
  assertEqual(
    Math.round((crossing.weightedAverageSpotPrice ?? 0) * 100) / 100,
    15.56,
    "lämmitetyn jakson spot-hinta säilyy erillisenä lisätietona",
  );
  assertEqual(
    getHeatingDayEmptyLabel(undefined),
    "Ei lämmitystä",
    "päivä ilman lämmitystä näyttää Ei lämmitystä",
  );

  const missingPrice = calculateHeatedPriceHistory(
    [oneHourPeriod],
    [price("2026-07-24T01:00:00.000Z", 30, 10)],
  )[0];
  assertEqual(
    [missingPrice.coveredMinutes, missingPrice.durationMinutes, missingPrice.isPartial],
    [30, 60, true],
    "puuttuvasta hintajaksosta lasketaan vain tunnettu osuus",
  );

  const negativeSpotHeated = calculateHeatedPriceHistory(
    [oneHourPeriod],
    [price("2026-07-24T01:00:00.000Z", 60, -10)],
  )[0];
  assertEqual(
    [
      oneHourHeated.weightedAveragePrice,
      oneHourHeated.weightedAverageSpotPrice,
      negativeSpotHeated.weightedAveragePrice,
      negativeSpotHeated.weightedAverageSpotPrice,
    ],
    [18.62, 10, -1.38, -10],
    "lämmitetyn tunnin pääarvo on aina kokonaishinta ja negatiivinen spot säilyy",
  );

  const heatingRows = [
    heatingPeriod("2026-07-24T08:00:00.000Z", "2026-07-24T09:00:00.000Z"),
    heatingPeriod("2026-07-18T08:00:00.000Z", "2026-07-18T09:00:00.000Z"),
    heatingPeriod("2026-07-17T08:00:00.000Z", "2026-07-17T09:00:00.000Z"),
    heatingPeriod("2026-06-25T08:00:00.000Z", "2026-06-25T09:00:00.000Z"),
    heatingPeriod("2026-06-24T08:00:00.000Z", "2026-06-24T09:00:00.000Z"),
  ];
  assertEqual(
    [
      filterHeatingPeriodsByRange(heatingRows, 7, now).length,
      filterHeatingPeriodsByRange(heatingRows, 30, now).length,
    ],
    [2, 4],
    "7 ja 30 päivän rajaus toimii myös lämmitysdatalla",
  );

  assertEqual(
    getRollingHistoryWindowRangeIso(new Date("2026-07-24T08:37:12.345Z")),
    {
      endIso: "2026-07-24T09:00:00.000Z",
      startIso: "2026-07-23T09:00:00.000Z",
    },
    "viimeisen 24 h ikkuna pyoristyy nykyisen tunnin alkuun ja kattaa 24 tasatuntia",
  );
  assertEqual(
    getRollingHistoryWindowRangeIso(new Date("2026-07-24T00:00:00.000Z")),
    {
      endIso: "2026-07-24T01:00:00.000Z",
      startIso: "2026-07-23T01:00:00.000Z",
    },
    "ikkuna toimii myos tasan tunnin vaihtuessa keskiyolla",
  );
  assertEqual(
    getElectricityHistoryRangeStartIso(1, new Date("2026-07-24T08:37:12.345Z")),
    "2026-07-23T09:00:00.000Z",
    "range 1 kayttaa liukuvaa 24 h ikkunaa, ei kalenteripaivan alkua",
  );

  const rollingWindowPrices = [
    price("2026-07-23T08:00:00.000Z", 60, 0.5),
    price("2026-07-23T10:00:00.000Z", 60, 0.6),
    price("2026-07-24T08:00:00.000Z", 60, 0.8),
    price("2026-07-24T10:00:00.000Z", 60, 0.9),
  ];
  const windowSummary = summarizeElectricityPriceWindow(
    rollingWindowPrices,
    "2026-07-23T09:00:00.000Z",
    "2026-07-24T09:00:00.000Z",
  );
  assertEqual(
    windowSummary?.prices.map((entry) => entry.starts_at),
    ["2026-07-23T10:00:00.000Z", "2026-07-24T08:00:00.000Z"],
    "ikkunayhteenveto sisaltaa vain ikkunan sisalla alkavat hinnat kahdelta kalenteripaivalta",
  );
  assertEqual(
    [windowSummary?.lowestSpotPrice, windowSummary?.highestSpotPrice],
    [0.6, 0.8],
    "ikkunayhteenveto laskee alimman ja korkeimman spot-hinnan vain ikkunan sisalta",
  );
  assertEqual(
    windowSummary?.isPartial,
    true,
    "ikkunayhteenveto merkitsee osittaiseksi kun kaikkia 24 tuntia ei ole katettu",
  );
  assertEqual(
    summarizeElectricityPriceWindow(
      rollingWindowPrices,
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ),
    null,
    "ikkunayhteenveto on null kun ikkunassa ei ole yhtaan hintaa",
  );
}

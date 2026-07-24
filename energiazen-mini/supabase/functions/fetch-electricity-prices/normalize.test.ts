import {
  electricityPriceConflictColumns,
  getElectricityPriceConflictKey,
  getHelsinkiPriceDate,
  getPriceResolutionMinutes,
  normalizeSpotPriceResponse,
  selectCurrentAndNextAvailableDays,
} from "./normalize";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runElectricityPriceFunctionUnitTests() {
  const fetchedAt = "2026-07-24T12:00:00.000Z";
  const fifteenMinuteRows = normalizeSpotPriceResponse(
    [{ DateTime: "2026-07-23T21:15:00.000Z", PriceWithTax: 0.05 }],
    { fetchedAt, resolutionMinutes: 15 },
  );
  assertEqual(
    fifteenMinuteRows[0],
    {
      end_date: "2026-07-23T21:30:00.000Z",
      ends_at: "2026-07-23T21:30:00.000Z",
      fetched_at: fetchedAt,
      price: 5,
      price_date: "2026-07-24",
      region: "FI",
      resolution_minutes: 15,
      spot_price_cents_kwh: 5,
      start_date: "2026-07-23T21:15:00.000Z",
      starts_at: "2026-07-23T21:15:00.000Z",
    },
    "lähdedata muunnetaan electricity_prices-taulun tietomalliin",
  );
  assertEqual(
    [
      getPriceResolutionMinutes(
        fifteenMinuteRows[0].starts_at,
        fifteenMinuteRows[0].ends_at,
      ),
      getPriceResolutionMinutes(
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T01:00:00.000Z",
      ),
    ],
    [15, 60],
    "resolution_minutes lasketaan oikein 15 ja 60 minuutin jaksoille",
  );
  assertEqual(
    getHelsinkiPriceDate("2026-07-23T21:15:00.000Z"),
    "2026-07-24",
    "price_date muodostuu Suomen paikallisajan mukaan",
  );
  assertEqual(
    normalizeSpotPriceResponse(
      [
        null,
        { DateTime: "not-a-date", PriceWithTax: 5 },
        { DateTime: "2026-07-24T00:00:00.000Z", PriceWithTax: "5" },
        { DateTime: "2026-07-24T00:00:00.000Z" },
      ],
      { fetchedAt, resolutionMinutes: 60 },
    ),
    [],
    "virheellinen lähdedata hylätään",
  );

  const duplicateRows = normalizeSpotPriceResponse(
    [
      { DateTime: "2026-07-24T00:00:00.000Z", PriceWithTax: 5 },
      { DateTime: "2026-07-24T00:00:00.000Z", PriceWithTax: 5 },
    ],
    { fetchedAt, resolutionMinutes: 60 },
  );
  assertEqual(
    [
      duplicateRows.length,
      getElectricityPriceConflictKey(duplicateRows[0]),
      electricityPriceConflictColumns,
    ],
    [
      1,
      "FI|2026-07-24T00:00:00.000Z|60",
      "region,starts_at,resolution_minutes",
    ],
    "sama hinta käyttää vakaata upsert-avainta eikä muodosta duplikaattia",
  );

  const availableDays = normalizeSpotPriceResponse(
    [
      { DateTime: "2026-07-24T00:00:00.000Z", PriceWithTax: 5 },
      { DateTime: "2026-07-26T00:00:00.000Z", PriceWithTax: 6 },
      { DateTime: "2026-07-27T00:00:00.000Z", PriceWithTax: 7 },
    ],
    { fetchedAt, resolutionMinutes: 60 },
  );
  assertEqual(
    selectCurrentAndNextAvailableDays(
      availableDays,
      new Date("2026-07-24T12:00:00.000Z"),
    ).map((row) => row.price_date),
    ["2026-07-24", "2026-07-26"],
    "nykyinen ja seuraava saatavilla oleva vuorokausi valitaan",
  );
}

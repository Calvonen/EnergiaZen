import {
  getSortedUniqueHelsinkiHourNumbers,
  normalizePriceToCents,
} from "./priceUtils";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runPriceUtilsUnitTests() {
  assertEqual(
    normalizePriceToCents(12.5),
    12.5,
    "jo senteissa oleva tavallinen arvo sailyy sellaisenaan",
  );
  assertEqual(
    normalizePriceToCents(1),
    1,
    "raja-arvo 1 tulkitaan jo senteiksi",
  );
  assertEqual(
    normalizePriceToCents(0.5),
    50,
    "alle yhden oleva desimaaliarvo kerrotaan sadalla",
  );
  assertEqual(normalizePriceToCents(0), 0, "nolla pysyy nollana");
  assertEqual(
    normalizePriceToCents(-2),
    -200,
    "negatiivinen hinta kerrotaan sadalla, koska se on alle yhden",
  );

  assertEqual(
    getSortedUniqueHelsinkiHourNumbers([
      { date: new Date("2026-01-10T13:00:00Z") }, // Helsinki 15
      { date: new Date("2026-01-10T01:00:00Z") }, // Helsinki 3
      { date: new Date("2026-01-10T07:00:00Z") }, // Helsinki 9
    ]),
    [3, 9, 15],
    "tunnit palautetaan nousevassa jarjestyksessa syotejarjestyksesta riippumatta",
  );
  assertEqual(
    getSortedUniqueHelsinkiHourNumbers([
      { date: new Date("2026-01-10T13:00:00Z") }, // Helsinki 15
      { date: new Date("2026-01-10T13:00:00Z") }, // sama ajanhetki uudelleen
      { date: new Date("2026-01-12T13:00:00Z") }, // eri paiva, sama Helsinki-tunti 15
    ]),
    [15],
    "sama tunnin numero eri ajanhetkilta ja eri paivilta tiivistyy yhdeksi",
  );
  assertEqual(
    getSortedUniqueHelsinkiHourNumbers([]),
    [],
    "tyhja lista palauttaa tyhjan listan",
  );
}

import {
  calculateRealizedHeatingHours,
  fetchAllHeatingHistory,
  HeatingHistoryReading,
} from "./heatingHistory";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export async function runHeatingHistoryUnitTests() {
  const earlierRows: HeatingHistoryReading[] = Array.from(
    { length: 1000 },
    (_, index) => ({
      created_at: new Date(
        Date.parse("2026-07-20T21:00:00.000Z") + index * 60_000,
      ).toISOString(),
      heating: false,
    }),
  );
  const todayHeatingRows: HeatingHistoryReading[] = Array.from(
    { length: 15 },
    (_, index) => ({
      created_at: new Date(
        Date.parse("2026-07-22T00:00:00.000Z") + index * 60_000,
      ).toISOString(),
      heating: true,
    }),
  );
  const source = [...earlierRows, ...todayHeatingRows];
  const result = await fetchAllHeatingHistory(async (from, to) => ({
    data: source.slice(from, to + 1),
    error: null,
  }));
  const realized = calculateRealizedHeatingHours(
    result.readings,
    "2026-07-22",
    "2026-07-21",
    (createdAt) => createdAt.slice(0, 10),
    (createdAt) => new Date(createdAt).getUTCHours(),
  );

  assertEqual(result.pageCount, 2, "yli 1000 rivin historia sivutetaan");
  assertEqual(result.readings.length, 1015, "kaikki sivut yhdistetään");
  assertEqual(
    realized.today,
    [0],
    "viimeisen sivun 15 minuutin lämmitys tunnistetaan",
  );
}

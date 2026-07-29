import {
  calculateHeatingEnergyConsumption,
  calculateRealizedHeatingHours,
  fetchAllHeatingHistory,
  HeatingHistoryReading,
  mapHeatingPeriodRowsToEnergyConsumption,
} from "./heatingHistory";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function createHeatingRows(
  startIso: string,
  durationMinutes: number,
): HeatingHistoryReading[] {
  return Array.from({ length: durationMinutes + 1 }, (_, index) => ({
    created_at: new Date(Date.parse(startIso) + index * 60_000).toISOString(),
    heating: true,
  }));
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

  const oneHourConsumption = calculateHeatingEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    readings: createHeatingRows("2026-07-22T00:00:00.000Z", 60),
    todayKey: "2026-07-22",
  });
  assertClose(
    oneHourConsumption.today_estimated_energy_kwh,
    3,
    "60 minuuttia lammitysta vastaa 3,0 kWh",
  );
  assertClose(
    oneHourConsumption.periods[0].duration_minutes,
    60,
    "60 minuutin jakson kesto lasketaan havaintojen valeista",
  );

  const halfHourConsumption = calculateHeatingEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    readings: createHeatingRows("2026-07-22T01:00:00.000Z", 30),
    todayKey: "2026-07-22",
  });
  assertClose(
    halfHourConsumption.today_estimated_energy_kwh,
    1.5,
    "30 minuuttia lammitysta vastaa 1,5 kWh",
  );

  const periodClosedByFalseReading = calculateHeatingEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    readings: [
      { created_at: "2026-07-22T02:00:00.000Z", heating: true },
      { created_at: "2026-07-22T02:05:00.000Z", heating: true },
      { created_at: "2026-07-22T02:10:00.000Z", heating: true },
      { created_at: "2026-07-22T02:15:00.000Z", heating: false },
    ],
    todayKey: "2026-07-22",
  });
  assertClose(
    periodClosedByFalseReading.periods[0].duration_minutes,
    15,
    "ensimmainen false-havainto paattaa aktiivisen lammitysjakson",
  );
  assertClose(
    periodClosedByFalseReading.today_estimated_energy_kwh,
    0.75,
    "15 minuuttia lammitysta vastaa 0,75 kWh",
  );

  const helsinkiDayConsumption = calculateHeatingEnergyConsumption({
    readings: createHeatingRows("2026-07-21T21:30:00.000Z", 30),
    todayKey: "2026-07-22",
  });
  assertClose(
    helsinkiDayConsumption.today_estimated_energy_kwh,
    1.5,
    "kulutus ryhmitellaan oletuksena Europe/Helsinki-paivan mukaan",
  );

  const separatePeriods = calculateHeatingEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    readings: [
      ...createHeatingRows("2026-07-22T02:00:00.000Z", 20),
      ...createHeatingRows("2026-07-22T03:00:00.000Z", 20),
    ],
    todayKey: "2026-07-22",
  });
  assertEqual(
    separatePeriods.periods.length,
    2,
    "kaksi erillista lammitysjaksoa pysyvat erillaan",
  );

  const longGap = calculateHeatingEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    maxSampleGapMinutes: 10,
    readings: [
      { created_at: "2026-07-22T04:00:00.000Z", heating: true },
      { created_at: "2026-07-22T06:00:00.000Z", heating: true },
    ],
    todayKey: "2026-07-22",
  });
  assertEqual(
    longGap.periods.map((period) => period.duration_minutes),
    [0, 0],
    "pitka katkos mittausdatassa ei muutu lammitysajaksi",
  );
  assertClose(
    longGap.today_estimated_energy_kwh,
    0,
    "pitka katkos ei kasvata energiankulutusta",
  );

  const emptyConsumption = calculateHeatingEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    readings: [],
    todayKey: "2026-07-22",
  });
  assertEqual(emptyConsumption.periods, [], "tyhja data ei muodosta jaksoja");
  assertClose(
    emptyConsumption.today_estimated_energy_kwh,
    0,
    "tyhja data palauttaa 0 kWh",
  );

  const periodStartedBeforeRange = mapHeatingPeriodRowsToEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    rows: [
      {
        duration_minutes: 45,
        end_time: "2026-07-22T00:45:00.000Z",
        start_time: "2026-07-22T00:00:00.000Z",
      },
    ],
    todayKey: "2026-07-22",
  });
  assertEqual(
    periodStartedBeforeRange.periods[0].started_at,
    "2026-07-22T00:00:00.000Z",
    "ennen aikavalia alkanut rpc-jakso alkaa laskennassa aikavalin alusta",
  );
  assertClose(
    periodStartedBeforeRange.today_estimated_energy_kwh,
    2.25,
    "45 minuutin rpc-jakso kuluttaa 2,25 kWh",
  );

  const periodEndedInsideRange = mapHeatingPeriodRowsToEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    rows: [
      {
        duration_minutes: 15,
        end_time: "2026-07-22T02:15:00.000Z",
        start_time: "2026-07-22T02:00:00.000Z",
      },
    ],
    todayKey: "2026-07-22",
  });
  assertClose(
    periodEndedInsideRange.periods[0].duration_minutes,
    15,
    "aikavalilla paattyvan rpc-jakson kesto sailyy",
  );

  const openPeriodEndedAtRangeEnd = mapHeatingPeriodRowsToEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    rows: [
      {
        duration_minutes: null,
        end_time: "2026-07-22T04:00:00.000Z",
        start_time: "2026-07-22T03:00:00.000Z",
      },
    ],
    todayKey: "2026-07-22",
  });
  assertClose(
    openPeriodEndedAtRangeEnd.periods[0].duration_minutes,
    60,
    "avoin rpc-jakso paattyy p_end-aikaan ja kesto lasketaan aikaleimoista",
  );

  const multipleRpcPeriods = mapHeatingPeriodRowsToEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    rows: [
      {
        duration_minutes: 10,
        end_time: "2026-07-22T05:10:00.000Z",
        start_time: "2026-07-22T05:00:00.000Z",
      },
      {
        duration_minutes: 20,
        end_time: "2026-07-22T06:20:00.000Z",
        start_time: "2026-07-22T06:00:00.000Z",
      },
    ],
    todayKey: "2026-07-22",
  });
  assertEqual(
    multipleRpcPeriods.periods.length,
    2,
    "useat rpc paalle/pois-jaksot palautuvat erillisina jaksoina",
  );
  assertClose(
    multipleRpcPeriods.today_estimated_energy_kwh,
    1.5,
    "useiden rpc-jaksojen energia summataan",
  );

  const emptyRpcPeriods = mapHeatingPeriodRowsToEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    rows: [],
    todayKey: "2026-07-22",
  });
  assertEqual(
    emptyRpcPeriods.periods,
    [],
    "tyhja rpc-historia ei muodosta jaksoja",
  );

  const rawKnownConsumption = calculateHeatingEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    readings: [
      { created_at: "2026-07-22T07:00:00.000Z", heating: true },
      { created_at: "2026-07-22T07:05:00.000Z", heating: true },
      { created_at: "2026-07-22T07:10:00.000Z", heating: true },
      { created_at: "2026-07-22T07:15:00.000Z", heating: false },
      { created_at: "2026-07-22T08:00:00.000Z", heating: true },
      { created_at: "2026-07-22T08:10:00.000Z", heating: false },
    ],
    todayKey: "2026-07-22",
  });
  const rpcKnownConsumption = mapHeatingPeriodRowsToEnergyConsumption({
    getDateKey: (createdAt) => createdAt.slice(0, 10),
    rows: [
      {
        duration_minutes: 15,
        end_time: "2026-07-22T07:15:00.000Z",
        start_time: "2026-07-22T07:00:00.000Z",
      },
      {
        duration_minutes: 10,
        end_time: "2026-07-22T08:10:00.000Z",
        start_time: "2026-07-22T08:00:00.000Z",
      },
    ],
    todayKey: "2026-07-22",
  });
  assertEqual(
    rpcKnownConsumption.periods.map((period) => period.duration_minutes),
    rawKnownConsumption.periods.map((period) => period.duration_minutes),
    "rpc-jaksot tuottavat samat kestot kuin tunnettu raakadata",
  );
  assertClose(
    rpcKnownConsumption.today_estimated_energy_kwh,
    rawKnownConsumption.today_estimated_energy_kwh,
    "rpc-jaksot tuottavat saman energiankulutuksen kuin tunnettu raakadata",
  );
}

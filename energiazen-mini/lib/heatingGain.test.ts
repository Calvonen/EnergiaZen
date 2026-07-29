import {
  estimateHeatingGainPerHour,
  fallbackHeatingGainPerHour,
  fetchHeatingGainHistory,
  heatingGainLearningLimits,
} from "./heatingGain";
import type { TankTemperatureReading } from "./tankTemperatureForecast";

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

function createHeatingSegment(
  start: string,
  gainPerHour: number,
  initialTemperature = 40,
): TankTemperatureReading[] {
  const startTime = new Date(start).getTime();

  return [0, 10, 20, 30].map((minutes) => ({
    bottom_temp: initialTemperature + gainPerHour * (minutes / 60),
    created_at: new Date(startTime + minutes * 60 * 1000).toISOString(),
    heating: true,
    top_temp: initialTemperature + gainPerHour * (minutes / 60),
  }));
}

function createLearnableHistory(gains = [4, 4.5, 5]) {
  return gains.flatMap((gain, index) =>
    createHeatingSegment(
      `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      gain,
    ),
  );
}

export async function runHeatingGainUnitTests() {
  {
    const estimate = estimateHeatingGainPerHour([
      ...createLearnableHistory(),
      {
        bottom_temp: 99,
        created_at: "2026-07-10T00:00:00.000Z",
        heating: false,
        top_temp: 99,
      },
    ]);

    assertClose(
      estimate.gainPerHour,
      4.5,
      "heating=false-rivi ei vaikuta mediaaniin",
    );
    assertEqual(estimate.acceptedSegmentCount, 3, "kolme jaksoa hyvaksytaan");
    assertEqual(estimate.fallbackUsed, false, "riittava historia opitaan");
  }

  {
    const invalidSegment = createHeatingSegment(
      "2026-07-04T00:00:00.000Z",
      4,
      101,
    );
    const estimate = estimateHeatingGainPerHour(invalidSegment);

    assertEqual(estimate.acceptedSegmentCount, 0, "virheelliset lampotilat hylataan");
    assertEqual(estimate.fallbackUsed, true, "virheellinen historia kayttaa fallbackia");
  }

  {
    const shortSegment = createHeatingSegment(
      "2026-07-04T00:00:00.000Z",
      4,
    ).slice(0, 3);
    const estimate = estimateHeatingGainPerHour(shortSegment);

    assertEqual(estimate.acceptedSegmentCount, 0, "liian lyhyt jakso hylataan");
    assertEqual(estimate.rejectedSegmentCount, 1, "hylatty jakso diagnosoidaan");
  }

  {
    const estimate = estimateHeatingGainPerHour(
      createLearnableHistory([4, 4.5, 7.5]),
    );

    assertClose(estimate.gainPerHour, 4.5, "mediaani kestaa suuren poikkeaman");
  }

  {
    const estimate = estimateHeatingGainPerHour(
      createLearnableHistory([4, 5]),
    );

    assertClose(
      estimate.gainPerHour,
      fallbackHeatingGainPerHour,
      "riittamaton historia kayttaa keskitettya fallbackia",
    );
    assertEqual(estimate.fallbackUsed, true, "fallback diagnosoidaan");
  }

  {
    const estimate = estimateHeatingGainPerHour(
      createLearnableHistory([4, 5, 6, 9]),
    );

    assertEqual(estimate.acceptedSegmentCount, 3, "eparealistinen jakso hylataan");
    assertEqual(estimate.rejectedSegmentCount, 1, "rajanylitys diagnosoidaan");
    assertEqual(
      estimate.gainPerHour <= heatingGainLearningLimits.maxWeightedGainPerHour,
      true,
      "opittu arvo ei ylita sallittua rajaa",
    );
  }

  {
    const sourceRows: TankTemperatureReading[] = Array.from(
      { length: 1000 },
      (_, index) => ({
        bottom_temp: 40,
        created_at: new Date(
          Date.parse("2026-06-01T00:00:00.000Z") + index * 60 * 1000,
        ).toISOString(),
        heating: false,
        top_temp: 40,
      }),
    );
    sourceRows.push(...createLearnableHistory());
    const requestedRanges: [number, number][] = [];
    const history = await fetchHeatingGainHistory(async (from, to) => {
      requestedRanges.push([from, to]);

      return { data: sourceRows.slice(from, to + 1), error: null };
    });
    const estimate = estimateHeatingGainPerHour(history.readings);

    assertEqual(history.fetchedRowCount, 1012, "kaikki sivutetut rivit haetaan");
    assertEqual(history.pageCount, 2, "yli 1000 rivia haetaan kahdella sivulla");
    assertEqual(
      requestedRanges,
      [
        [0, 999],
        [1000, 1999],
      ],
      "Supabase range etenee sivu kerrallaan",
    );
    assertEqual(
      estimate.acceptedSegmentCount,
      3,
      "ensimmaisen 1000 rivin jalkeiset lammitysjaksot loytyvat",
    );
    assertClose(estimate.gainPerHour, 4.5, "sivutettu historia antaa mediaanin");
  }
}

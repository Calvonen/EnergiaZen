import {
  estimateHeatingGainPerHour,
  fallbackHeatingGainPerHour,
  fetchHeatingGainHistory,
  findValidHeatingSegments,
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
    assertEqual(
      estimate.segmentDiscovery.rejectedSegments[0].reasons,
      ["insufficient_readings", "insufficient_duration"],
      "hylatylle jaksolle tallennetaan kaikki selkeat syyt",
    );
    assertEqual(
      estimate.segmentDiscovery.rejectionReasonCounts,
      { insufficient_readings: 1, insufficient_duration: 1 },
      "hylkayssyiden jakauma lasketaan valmiiksi",
    );
  }

  {
    const negativeSegment = createHeatingSegment(
      "2026-07-05T00:00:00.000Z",
      -1,
    );
    const discovery = findValidHeatingSegments(negativeSegment);

    assertEqual(discovery.rejectedSegmentCount, 1, "laskeva jakso hylataan");
    assertEqual(
      discovery.rejectedSegments[0].reasons,
      ["negative_temperature_change"],
      "laskeva jakso saa yksiselitteisen syyn",
    );
  }

  {
    const startTime = Date.parse("2026-07-06T00:00:00.000Z");
    const temperatures = [40, 46, 40.7, 42];
    const unstableSegment = temperatures.map((temperature, index) => ({
      bottom_temp: temperature,
      created_at: new Date(startTime + index * 10 * 60 * 1000).toISOString(),
      heating: true,
      top_temp: temperature,
    }));
    const discovery = findValidHeatingSegments(unstableSegment);

    assertEqual(discovery.acceptedSegmentCount, 1, "epatasainen jakso hyvaksytaan");
    assertEqual(
      discovery.acceptedWithWarningsSegmentCount,
      1,
      "epatasainen jakso erotellaan varoituksella",
    );
    assertEqual(
      discovery.segments[0].warnings,
      ["sensor_anomaly", "unstable_curve"],
      "kayran laatuongelmat ovat diagnostiikkaa",
    );
    assertEqual(
      discovery.segments[0].status,
      "accepted_with_warnings",
      "varoitus ei muuta segmenttia hylatyksi",
    );

    const estimate = estimateHeatingGainPerHour([
      ...unstableSegment,
      ...createHeatingSegment("2026-07-07T00:00:00.000Z", 5),
      ...createHeatingSegment("2026-07-08T00:00:00.000Z", 6),
    ]);
    assertClose(
      estimate.gainPerHour,
      5,
      "varoituksellinen jakso osallistuu edelleen tuotannon mediaaniin",
    );
    assertEqual(
      estimate.fallbackUsed,
      false,
      "kolme hyvaksyttya jaksoa riittaa myos varoituksen kanssa",
    );
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
      estimate.segmentDiscovery.rejectionReasonCounts,
      { unrealistic_gain: 1 },
      "eparealistisen gainin syy raportoidaan",
    );
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

  {
    // Todellinen tapaus: kayttaja huomasi ettei lammitysjakso hylkaantynyt
    // vaikka tulovesianturi nakisi selvan vedenoton kesken lammityksen (ks.
    // lib/waterDrawDetection.ts) - sama neljan lukeman jakso kuin
    // createHeatingSegment(start, 4) tuottaisi, plus yksi ylimaarainen
    // lukema 3 min viimeisen jalkeen jossa tulovesi putoaa nopeasti.
    const start = "2026-07-09T00:00:00.000Z";
    const startTime = new Date(start).getTime();
    const inletTemperaturesC = [15.7, 15.8, 15.9, 16.0];
    const segmentReadings: TankTemperatureReading[] = [0, 10, 20, 30].map(
      (minutes, index) => ({
        bottom_temp: 40 + 4 * (minutes / 60),
        created_at: new Date(startTime + minutes * 60 * 1000).toISOString(),
        heating: true,
        inlet_temp: inletTemperaturesC[index],
        top_temp: 40 + 4 * (minutes / 60),
      }),
    );
    const drawReading: TankTemperatureReading = {
      bottom_temp: 40 + 4 * (33 / 60),
      created_at: new Date(startTime + 33 * 60 * 1000).toISOString(),
      heating: true,
      inlet_temp: 12.2,
      top_temp: 40 + 4 * (33 / 60),
    };
    const discovery = findValidHeatingSegments([
      ...segmentReadings,
      drawReading,
    ]);

    assertEqual(
      discovery.rejectedSegmentCount,
      1,
      "vedenotto kesken lammitysjakson hylkaa jakson",
    );
    assertEqual(
      discovery.rejectedSegments[0].reasons,
      ["water_draw_detected"],
      "hylkayssyy on vedenotto, ei muu laatuongelma",
    );
  }

  {
    // Vastaesimerkki: vakaa (nouseva mutta hidas) tulovesilampotila ei saa
    // hylata jaksoa - varmistaa ettei tarkistus laukea pelkasta
    // anturidatan lasnaolosta.
    const start = "2026-07-10T00:00:00.000Z";
    const startTime = new Date(start).getTime();
    const inletTemperaturesC = [15.7, 15.8, 15.9, 16.0];
    const segmentReadings: TankTemperatureReading[] = [0, 10, 20, 30].map(
      (minutes, index) => ({
        bottom_temp: 40 + 4 * (minutes / 60),
        created_at: new Date(startTime + minutes * 60 * 1000).toISOString(),
        heating: true,
        inlet_temp: inletTemperaturesC[index],
        top_temp: 40 + 4 * (minutes / 60),
      }),
    );
    const discovery = findValidHeatingSegments(segmentReadings);

    assertEqual(
      discovery.acceptedSegmentCount,
      1,
      "vakaa tulovesilampotila ei hylkaa lammitysjaksoa",
    );
  }

  {
    // Todellinen tapaus: yolammitys pysahtyi varaajan mekaaniseen
    // termostaattiin (jakso saavutti 60 astetta), ei appin omaan
    // paatokseen - jakson mitattu nousunopeus ei silloin enaa edusta
    // lammittimen todellista tehoa.
    const segment = createHeatingSegment("2026-07-11T00:00:00.000Z", 4, 58);
    const discovery = findValidHeatingSegments(segment);

    assertEqual(
      discovery.rejectedSegmentCount,
      1,
      "60 astetta saavuttava jakso hylataan - termostaatti on saattanut katkaista lammityksen",
    );
    assertEqual(
      discovery.rejectedSegments[0].reasons,
      ["max_temperature_reached"],
      "hylkayssyy on maksimilampotila, ei muu laatuongelma",
    );
  }

  {
    const segment = createHeatingSegment("2026-07-12T00:00:00.000Z", 4, 57.9);
    const discovery = findValidHeatingSegments(segment);

    assertEqual(
      discovery.acceptedSegmentCount,
      1,
      "juuri alle kynnysarvon jaava jakso hyvaksytaan normaalisti",
    );
  }
}

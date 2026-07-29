import { backtestHeatingGainEstimate } from "./heatingGainBacktest";
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
  durationMinutes = 30,
  initialTemperature = 40,
): TankTemperatureReading[] {
  // Readings must stay <= maxGapMinutes (10) apart or they get split into
  // separate (too-short) segments, regardless of total duration.
  const startTime = new Date(start).getTime();
  const stepMinutes = 10;
  const stepCount = Math.max(3, Math.round(durationMinutes / stepMinutes));

  return Array.from({ length: stepCount + 1 }, (_, index) => {
    const minutes = index * (durationMinutes / stepCount);

    return {
      bottom_temp: initialTemperature + gainPerHour * (minutes / 60),
      created_at: new Date(startTime + minutes * 60 * 1000).toISOString(),
      heating: true,
      top_temp: initialTemperature + gainPerHour * (minutes / 60),
    };
  });
}

export function runHeatingGainBacktestUnitTests() {
  {
    const result = backtestHeatingGainEstimate([]);

    assertEqual(result.segmentCount, 0, "ei lukemia -> nolla segmenttia");
    assertEqual(result.meanAbsoluteErrorCelsius, null, "MAE puuttuu ilman segmenttejä");
    assertEqual(result.meanBiasCelsius, null, "harha puuttuu ilman segmenttejä");
  }

  {
    const readings = createHeatingSegment("2026-08-01T00:00:00.000Z", 4, 60);
    const result = backtestHeatingGainEstimate(readings);

    assertEqual(
      result.segmentCount,
      1,
      "yksi segmentti ei riitä ristiinvalidointiin",
    );
    assertEqual(result.segments.length, 0, "yhtä segmenttiä ei voi verrata muihin");
    assertEqual(result.meanAbsoluteErrorCelsius, null, "MAE puuttuu yhdellä segmentillä");
  }

  {
    // Kaksi segmenttiä: kumpikin ennustaa toisensa perusteella (jätä oma
    // arvo pois - leave-one-out).
    const readings = [
      ...createHeatingSegment("2026-08-01T00:00:00.000Z", 2, 60),
      ...createHeatingSegment("2026-08-02T00:00:00.000Z", 8, 60),
    ];
    const result = backtestHeatingGainEstimate(readings);

    assertEqual(result.segmentCount, 2, "kaksi segmenttia loytyy");
    assertClose(
      result.segments[0].predictedGainPerHour,
      8,
      "segmentti A:n ennuste tulee yksinomaan segmentista B",
    );
    assertClose(
      result.segments[1].predictedGainPerHour,
      2,
      "segmentti B:n ennuste tulee yksinomaan segmentista A",
    );
    assertClose(result.meanAbsoluteErrorCelsius as number, 6, "MAE kahdella segmentilla");
    assertClose(result.meanBiasCelsius as number, 0, "symmetrinen tapaus tuottaa nollaharhan");
  }

  {
    // Kolme segmenttiä eri kestoilla: varmistaa että NOUSU (gain * kesto)
    // vertaillaan, ei pelkkä °C/h-nopeus, ja että harha ei aina nollaudu.
    const readings = [
      ...createHeatingSegment("2026-08-01T00:00:00.000Z", 2, 60), // A: nousu 2 °C, 1 h
      ...createHeatingSegment("2026-08-02T00:00:00.000Z", 4, 60), // B: nousu 4 °C, 1 h
      ...createHeatingSegment("2026-08-03T00:00:00.000Z", 4, 120), // C: nousu 8 °C, 2 h
    ];
    const result = backtestHeatingGainEstimate(readings);
    const [segmentA, segmentB, segmentC] = result.segments;

    assertEqual(result.segmentCount, 3, "kolme segmenttia loytyy");

    assertClose(segmentA.actualRiseCelsius, 2, "A:n toteutunut nousu");
    assertClose(segmentA.predictedGainPerHour, 4, "A:n ennustettu nopeus (mediaani B:sta ja C:sta)");
    assertClose(segmentA.predictedRiseCelsius, 4, "A:n ennustettu nousu");
    assertClose(segmentA.errorCelsius, -2, "A: toteuma alle ennusteen");

    assertClose(segmentB.actualRiseCelsius, 4, "B:n toteutunut nousu");
    assertClose(segmentB.predictedGainPerHour, 3, "B:n ennustettu nopeus (mediaani A:sta ja C:sta)");
    assertClose(segmentB.predictedRiseCelsius, 3, "B:n ennustettu nousu");
    assertClose(segmentB.errorCelsius, 1, "B: toteuma yli ennusteen");

    assertClose(segmentC.actualRiseCelsius, 8, "C:n toteutunut nousu");
    assertClose(segmentC.predictedGainPerHour, 3, "C:n ennustettu nopeus (mediaani A:sta ja B:sta)");
    assertClose(segmentC.predictedRiseCelsius, 6, "C:n ennustettu nousu (nopeus x 2 h kesto)");
    assertClose(segmentC.errorCelsius, 2, "C: toteuma yli ennusteen");

    assertClose(
      result.meanAbsoluteErrorCelsius as number,
      5 / 3,
      "MAE on virheiden itseisarvojen keskiarvo",
    );
    assertClose(
      result.meanBiasCelsius as number,
      1 / 3,
      "keskimääräinen harha on virheiden (etumerkillinen) keskiarvo",
    );
  }
}

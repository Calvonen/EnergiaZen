import { backtestHeatingGainEstimate } from "./heatingGainBacktest";
import { fallbackHeatingGainPerHour, heatingGainLearningLimits } from "./heatingGain";
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

function createSegmentsOnConsecutiveDays(
  gainsAndDurations: [gainPerHour: number, durationMinutes: number][],
): TankTemperatureReading[] {
  return gainsAndDurations.flatMap(([gainPerHour, durationMinutes], index) =>
    createHeatingSegment(
      `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      gainPerHour,
      durationMinutes,
    ),
  );
}

export function runHeatingGainBacktestUnitTests() {
  {
    const result = backtestHeatingGainEstimate([]);

    assertEqual(result.segmentCount, 0, "ei lukemia -> nolla segmenttia");
    assertEqual(
      result.segmentDiscovery.rejectedSegmentCount,
      0,
      "tyhja backtest raportoi myos tyhjan diagnostiikan",
    );
    assertEqual(result.meanAbsoluteErrorCelsius, null, "MAE puuttuu ilman segmenttejä");
    assertEqual(result.meanBiasCelsius, null, "harha puuttuu ilman segmenttejä");
  }

  {
    const accepted = createHeatingSegment(
      "2026-08-01T00:00:00.000Z",
      4,
      60,
    );
    const rejected = createHeatingSegment(
      "2026-08-02T00:00:00.000Z",
      9,
      60,
    );
    const result = backtestHeatingGainEstimate([...accepted, ...rejected]);

    assertEqual(result.segmentCount, 1, "backtest kayttaa vain hyvaksytyn jakson");
    assertEqual(
      result.segmentDiscovery.rejectedSegmentCount,
      1,
      "backtest raportoi hylattyjen jaksojen maaran",
    );
    assertEqual(
      result.segmentDiscovery.rejectionReasonCounts,
      { unrealistic_gain: 1 },
      "backtest raportoi hylkayssyiden jakauman",
    );
  }

  {
    // Yksi segmentti: ei yhtään "muuta" segmenttiä verrattavaksi, joten
    // tuotantokoodikin olisi käyttänyt fallbackia (0 < minValidSegments).
    const readings = createHeatingSegment("2026-08-01T00:00:00.000Z", 4, 60);
    const result = backtestHeatingGainEstimate(readings);

    assertEqual(result.segmentCount, 1, "yksi segmentti loytyy");
    assertEqual(result.segments.length, 1, "yhtakin segmenttia voi verrata fallbackiin");
    assertEqual(
      result.segments[0].predictedFromFallback,
      true,
      "0 muuta segmenttia < minValidSegments -> fallback",
    );
    assertClose(
      result.segments[0].predictedGainPerHour,
      fallbackHeatingGainPerHour,
      "ennuste on fallback-arvo",
    );
    assertClose(result.segments[0].actualRiseCelsius, 4, "toteutunut nousu");
    assertClose(
      result.segments[0].predictedRiseCelsius,
      fallbackHeatingGainPerHour,
      "ennustettu nousu 1h jaksolla on fallback sellaisenaan",
    );
  }

  {
    // Kolme segmenttiä: jokaisen leave-one-out-vertailu jättää vain 2 MUUTA
    // segmenttiä, mikä on alle minValidSegments (3) - tuotantokoodi olisi
    // käyttänyt fallbackia tässä historiatilanteessa jokaiselle, joten
    // backtestin pitää tehdä sama, EI laskea mediaania niistä 2:sta.
    if (heatingGainLearningLimits.minValidSegments !== 3) {
      throw new Error(
        "Testi olettaa minValidSegments=3 - päivitä testi jos raja muuttuu",
      );
    }

    const readings = createSegmentsOnConsecutiveDays([
      [2, 60],
      [4, 60],
      [6, 60],
    ]);
    const customFallback = 4.5;
    const result = backtestHeatingGainEstimate(readings, customFallback);

    assertEqual(result.segmentCount, 3, "kolme segmenttia loytyy");
    for (const segment of result.segments) {
      assertEqual(
        segment.predictedFromFallback,
        true,
        "2 muuta segmenttia < minValidSegments -> fallback jokaiselle",
      );
      assertClose(
        segment.predictedGainPerHour,
        customFallback,
        "annettu fallback-arvo valittyy lapi, ei 2 muun segmentin mediaani",
      );
    }
  }

  {
    // Neljä segmenttiä: leave-one-out jättää täsmälleen 3 muuta segmenttiä =
    // minValidSegments, joten tuotantokoodi olisi käyttänyt opittua
    // mediaania - backtestin pitää tehdä sama.
    if (heatingGainLearningLimits.minValidSegments !== 3) {
      throw new Error(
        "Testi olettaa minValidSegments=3 - päivitä testi jos raja muuttuu",
      );
    }

    const readings = createSegmentsOnConsecutiveDays([
      [2, 60], // A: nousu 2 °C, 1 h
      [4, 60], // B: nousu 4 °C, 1 h
      [6, 60], // C: nousu 6 °C, 1 h
      [8, 120], // D: nousu 16 °C, 2 h
    ]);
    const result = backtestHeatingGainEstimate(readings);
    const [segmentA, segmentB, segmentC, segmentD] = result.segments;

    assertEqual(result.segmentCount, 4, "nelja segmenttia loytyy");
    for (const segment of result.segments) {
      assertEqual(
        segment.predictedFromFallback,
        false,
        "3 muuta segmenttia == minValidSegments -> opittu mediaani, ei fallback",
      );
    }

    assertClose(segmentA.predictedGainPerHour, 6, "A: mediaani B:sta, C:sta ja D:sta");
    assertClose(segmentA.predictedRiseCelsius, 6, "A: ennustettu nousu");
    assertClose(segmentA.errorCelsius, -4, "A: toteuma alle ennusteen");

    assertClose(segmentB.predictedGainPerHour, 6, "B: mediaani A:sta, C:sta ja D:sta");
    assertClose(segmentB.errorCelsius, -2, "B: toteuma alle ennusteen");

    assertClose(segmentC.predictedGainPerHour, 4, "C: mediaani A:sta, B:sta ja D:sta");
    assertClose(segmentC.errorCelsius, 2, "C: toteuma yli ennusteen");

    assertClose(segmentD.predictedGainPerHour, 4, "D: mediaani A:sta, B:sta ja C:sta");
    assertClose(
      segmentD.predictedRiseCelsius,
      8,
      "D: ennustettu nousu skaalautuu 2h kestolla, ei pelkka nopeus",
    );
    assertClose(segmentD.actualRiseCelsius, 16, "D: toteutunut nousu (8 C/h * 2h)");
    assertClose(segmentD.errorCelsius, 8, "D: toteuma selvasti yli ennusteen");

    assertClose(
      result.meanAbsoluteErrorCelsius as number,
      4,
      "MAE nelja segmentin joukolla",
    );
    assertClose(
      result.meanBiasCelsius as number,
      1,
      "epasymmetrinen kesto tuottaa nollasta poikkeavan harhan",
    );
  }
}

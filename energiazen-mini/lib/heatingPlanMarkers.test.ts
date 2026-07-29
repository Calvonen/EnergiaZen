import {
  ActualTimelineSegment,
  buildTodayHeatingTimeline,
  getHeatingHourMarker,
  heatingMarkers,
  mergeAdjacentActualHeatingSegments,
} from "./heatingPlanMarkers";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runHeatingPlanMarkerUnitTests() {
  const now = new Date("2026-07-24T10:00:00.000Z");
  assertEqual(
    getHeatingHourMarker({
      endsAt: "2026-07-24T13:00:00.000Z",
      isActual: false,
      isPlanned: true,
      now,
    }),
    heatingMarkers.planned,
    "tuleva suunniteltu jakso saa tähden",
  );
  assertEqual(
    getHeatingHourMarker({
      endsAt: "2026-07-24T02:00:00.000Z",
      isActual: true,
      isPlanned: true,
      now,
    }),
    heatingMarkers.actual,
    "toteutunut jakso saa liekin suunnitelmasta riippumatta",
  );
  assertEqual(
    getHeatingHourMarker({
      endsAt: "2026-07-24T02:00:00.000Z",
      isActual: false,
      isPlanned: true,
      now,
    }),
    heatingMarkers.missed,
    "suunniteltu mutta toteutumaton jakso saa varoituksen",
  );

  const timeline = buildTodayHeatingTimeline({
    actualSegments: [
      {
        costEuros: 0.3,
        endedAt: "2026-07-24T00:00:00.000Z",
        energyKwh: 3,
        priceCentsPerKwh: 10,
        spotPriceCentsPerKwh: 1.38,
        startedAt: "2026-07-23T23:00:00.000Z",
      },
    ],
    dateKey: "2026-07-24",
    now,
    plannedHours: [2, 5, 15],
    prices: [
      {
        ends_at: "2026-07-24T00:00:00.000Z",
        resolution_minutes: 60,
        spot_price_cents_kwh: 1.38,
        starts_at: "2026-07-23T23:00:00.000Z",
      },
      {
        ends_at: "2026-07-24T03:00:00.000Z",
        resolution_minutes: 60,
        spot_price_cents_kwh: 0.9,
        starts_at: "2026-07-24T02:00:00.000Z",
      },
      {
        ends_at: "2026-07-24T13:00:00.000Z",
        resolution_minutes: 60,
        spot_price_cents_kwh: 0.9,
        starts_at: "2026-07-24T12:00:00.000Z",
      },
    ],
  });

  assertEqual(
    timeline.map((item) => item.status),
    ["actual", "missed", "planned"],
    "menneet ja tulevat jaksot järjestetään ajallisesti oikeilla merkeillä",
  );
  assertEqual(
    timeline.filter((item) => item.status === "actual").length,
    1,
    "toteutunut suunniteltu jakso ei näy kahdesti",
  );
  assertEqual(
    timeline.map((item) => item.energyKwh),
    [3, 3, 3],
    "suunnitelluille jaksoille lasketaan arvioitu energia erillisinä riveinä",
  );

  assertEqual(
    mergeAdjacentActualHeatingSegments([]),
    [],
    "tyhja segmenttilista pysyy tyhjana",
  );

  const singleSegment: ActualTimelineSegment[] = [
    {
      costEuros: 0.5,
      endedAt: "2026-07-24T13:00:00.000Z",
      energyKwh: 3,
      priceCentsPerKwh: 10,
      spotPriceCentsPerKwh: 8,
      startedAt: "2026-07-24T12:00:00.000Z",
    },
  ];
  assertEqual(
    mergeAdjacentActualHeatingSegments(singleSegment),
    singleSegment,
    "yksittainen segmentti pysyy muuttumattomana",
  );

  // Shellyn n. 90 s ylimenevä katkaisuviive tunnin vaihtuessa: kaksi
  // hintatunnin rajalla katkeavaa segmenttia yhdistyy yhdeksi tapahtumaksi.
  const shellyOverrunSegments: ActualTimelineSegment[] = [
    {
      costEuros: 0.6,
      endedAt: "2026-07-24T13:00:00.000Z",
      energyKwh: 3,
      priceCentsPerKwh: 10,
      spotPriceCentsPerKwh: 8,
      startedAt: "2026-07-24T12:00:00.000Z",
    },
    {
      costEuros: 0.02,
      endedAt: "2026-07-24T13:02:00.000Z",
      energyKwh: 0.1,
      priceCentsPerKwh: 20,
      spotPriceCentsPerKwh: 16,
      startedAt: "2026-07-24T13:01:30.000Z",
    },
  ];
  const mergedOverrun = mergeAdjacentActualHeatingSegments(
    shellyOverrunSegments,
  );
  assertEqual(
    mergedOverrun.length,
    1,
    "90 sekunnin ylimenevä katkaisuviive yhdistetaan yhdeksi tapahtumaksi",
  );
  assertEqual(
    mergedOverrun[0].startedAt,
    "2026-07-24T12:00:00.000Z",
    "yhdistetty tapahtuma alkaa ensimmaisesta segmentista",
  );
  assertEqual(
    mergedOverrun[0].endedAt,
    "2026-07-24T13:02:00.000Z",
    "yhdistetty tapahtuma paattyy viimeiseen segmenttiin",
  );
  assertEqual(
    mergedOverrun[0].costEuros,
    0.62,
    "yhdistetyn tapahtuman kustannus on segmenttien summa",
  );
  assertEqual(
    mergedOverrun[0].energyKwh,
    3.1,
    "yhdistetyn tapahtuman energia on segmenttien summa",
  );
  assertEqual(
    mergedOverrun[0].priceCentsPerKwh,
    (10 * 60 + 20 * 0.5) / 60.5,
    "yhdistetyn tapahtuman hinta on kestolla painotettu keskiarvo",
  );
  assertEqual(
    mergedOverrun[0].spotPriceCentsPerKwh,
    (8 * 60 + 16 * 0.5) / 60.5,
    "yhdistetyn tapahtuman spot-hinta on kestolla painotettu keskiarvo",
  );

  const farApartSegments: ActualTimelineSegment[] = [
    {
      costEuros: 0.3,
      endedAt: "2026-07-24T12:00:00.000Z",
      energyKwh: 1,
      priceCentsPerKwh: 10,
      spotPriceCentsPerKwh: 8,
      startedAt: "2026-07-24T11:30:00.000Z",
    },
    {
      costEuros: 0.3,
      endedAt: "2026-07-24T13:00:00.000Z",
      energyKwh: 1,
      priceCentsPerKwh: 10,
      spotPriceCentsPerKwh: 8,
      startedAt: "2026-07-24T12:30:00.000Z",
    },
  ];
  assertEqual(
    mergeAdjacentActualHeatingSegments(farApartSegments).length,
    2,
    "yli kahden minuutin valilla olevat segmentit pysyvat erillisina",
  );

  // Kolme perakkaista, tasan toisiinsa kiinni olevaa tuntisegmenttia
  // (esim. jatkuva lammitys klo 13-16) yhdistyvat yhdeksi tapahtumaksi.
  const consecutiveHourSegments: ActualTimelineSegment[] = [
    {
      costEuros: 0.3,
      endedAt: "2026-07-24T14:00:00.000Z",
      energyKwh: 3,
      priceCentsPerKwh: 10,
      spotPriceCentsPerKwh: 8,
      startedAt: "2026-07-24T13:00:00.000Z",
    },
    {
      costEuros: 0.33,
      endedAt: "2026-07-24T15:00:00.000Z",
      energyKwh: 3,
      priceCentsPerKwh: 11,
      spotPriceCentsPerKwh: 9,
      startedAt: "2026-07-24T14:00:00.000Z",
    },
    {
      costEuros: 0.36,
      endedAt: "2026-07-24T16:00:00.000Z",
      energyKwh: 3,
      priceCentsPerKwh: 12,
      spotPriceCentsPerKwh: 10,
      startedAt: "2026-07-24T15:00:00.000Z",
    },
  ];
  const mergedConsecutiveHours = mergeAdjacentActualHeatingSegments(
    consecutiveHourSegments,
  );
  assertEqual(
    mergedConsecutiveHours.length,
    1,
    "useampi perakkainen tasan toisiinsa kiinni oleva lammitystunti yhdistyy yhdeksi tapahtumaksi",
  );
  assertEqual(
    mergedConsecutiveHours[0].startedAt,
    "2026-07-24T13:00:00.000Z",
    "kolmen tunnin lammitysjakso alkaa ensimmaisesta tunnista",
  );
  assertEqual(
    mergedConsecutiveHours[0].endedAt,
    "2026-07-24T16:00:00.000Z",
    "kolmen tunnin lammitysjakso paattyy viimeiseen tuntiin",
  );
  assertEqual(
    mergedConsecutiveHours[0].energyKwh,
    9,
    "kolmen tunnin lammitysjakson energia on tuntien summa",
  );
}

import {
  buildTodayHeatingTimeline,
  getHeatingHourMarker,
  heatingMarkers,
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
}

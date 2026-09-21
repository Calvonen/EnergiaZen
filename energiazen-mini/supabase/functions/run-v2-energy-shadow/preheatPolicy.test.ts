import { evaluateV2PreheatHorizon, evaluateV2PreheatOpportunity } from "./preheatPolicy.ts";
import type { ShadowElectricityPrice } from "./planShadow.ts";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function price(startsAt: string, cents: number): ShadowElectricityPrice {
  const start = Date.parse(startsAt);
  return {
    starts_at: startsAt,
    ends_at: new Date(start + 60 * 60 * 1000).toISOString(),
    resolution_minutes: 60,
    spot_price_cents_kwh: cents,
  };
}

function hourlyRange(startIso: string, hours: number, cents: number) {
  const start = Date.parse(startIso);
  return Array.from({ length: hours }, (_, index) =>
    price(new Date(start + index * 60 * 60 * 1000).toISOString(), cents),
  );
}

export function runV2PreheatPolicyUnitTests() {
  const now = new Date("2026-09-17T12:30:00.000Z"); // 15:30 Helsinki
  const tomorrow = hourlyRange("2026-09-17T21:00:00.000Z", 24, 20);
  const ordinary = evaluateV2PreheatOpportunity({
    now,
    prices: [
      price("2026-09-17T12:00:00.000Z", 30),
      price("2026-09-17T13:00:00.000Z", 5), // 16-17 Helsinki, cheaper than every tomorrow hour
      price("2026-09-17T14:00:00.000Z", 25),
      ...tomorrow,
    ],
  });
  assert(ordinary.available, "complete tomorrow horizon enables preheat evaluation");
  assertEqual(ordinary.reason, "recommended", "cheaper remaining today interval recommends preheat");
  assertEqual(ordinary.eligiblePreheatHourIds.length, 1, "only strictly cheaper today interval is eligible");
  assertEqual(
    ordinary.eligiblePreheatHourIds[0],
    "2026-09-17T13:00:00.000Z",
    "eligible interval is the cheaper future today hour",
  );
  assertEqual(
    ordinary.tomorrowCheapestBilledCentsPerKwh,
    28.62,
    "comparison uses billed tariff, not raw spot",
  );

  const missingTomorrowHour = evaluateV2PreheatOpportunity({
    now,
    prices: [price("2026-09-17T13:00:00.000Z", 1), ...tomorrow.slice(0, 23)],
  });
  assert(!missingTomorrowHour.available, "incomplete tomorrow horizon suppresses preheat");
  assertEqual(
    missingTomorrowHour.reason,
    "tomorrow_prices_incomplete",
    "incomplete horizon has explicit reason",
  );

  const missingTomorrowHorizon = evaluateV2PreheatHorizon({
    now,
    prices: [price("2026-09-17T13:00:00.000Z", 1), ...tomorrow.slice(0, 23)],
  });
  assert(!missingTomorrowHorizon.available, "incomplete tomorrow remains unavailable for cross-day comparison");
  assertEqual(
    missingTomorrowHorizon.futureTodayHourIds.length,
    1,
    "incomplete tomorrow must preserve known remaining-today hours for bounded soft fill",
  );
  assertEqual(
    missingTomorrowHorizon.futureTodayHourIds[0],
    "2026-09-17T13:00:00.000Z",
    "remaining-today horizon survives missing tomorrow prices",
  );

  const tomorrowCheaper = evaluateV2PreheatOpportunity({
    now,
    prices: [price("2026-09-17T12:00:00.000Z", 30), price("2026-09-17T13:00:00.000Z", 10), ...hourlyRange("2026-09-17T21:00:00.000Z", 24, 1)],
  });
  assert(!tomorrowCheaper.available, "cheaper tomorrow does not recommend preheat");
  assertEqual(
    tomorrowCheaper.reason,
    "no_cheaper_preheat_interval",
    "tomorrow-cheaper case is explicit",
  );

  const currentHourExcluded = evaluateV2PreheatOpportunity({
    now,
    prices: [
      price("2026-09-17T12:00:00.000Z", -20), // already started at 15:00 Helsinki
      price("2026-09-17T13:00:00.000Z", 30),
      ...tomorrow,
    ],
  });
  assert(!currentHourExcluded.available, "already-started cheap hour cannot create a new preheat recommendation");
  assertEqual(
    currentHourExcluded.reason,
    "no_cheaper_preheat_interval",
    "mid-hour cheap price is ignored by preheat policy",
  );

  const noFutureToday = evaluateV2PreheatOpportunity({
    now: new Date("2026-09-17T20:30:00.000Z"), // 23:30 Helsinki
    prices: [price("2026-09-17T20:00:00.000Z", 30), ...tomorrow],
  });
  assert(!noFutureToday.available, "no remaining today interval cannot create a preheat recommendation");
  assertEqual(noFutureToday.reason, "no_future_today_prices", "late-day branch stays explicit");
  assertEqual(
    noFutureToday.tomorrowCheapestBilledCentsPerKwh,
    28.62,
    "late-day telemetry preserves the known tomorrow billed minimum",
  );

  const dstNow = new Date("2026-10-24T12:00:00.000Z");
  const dstTomorrow = hourlyRange("2026-10-24T21:00:00.000Z", 25, 20);
  const dstComplete = evaluateV2PreheatOpportunity({
    now: dstNow,
    prices: [price("2026-10-24T12:00:00.000Z", 30), price("2026-10-24T13:00:00.000Z", 1), ...dstTomorrow],
  });
  assert(dstComplete.available, "25-hour Helsinki fall-back day is accepted as complete");

  const dstMissingHour = evaluateV2PreheatOpportunity({
    now: dstNow,
    prices: [price("2026-10-24T12:00:00.000Z", 30), price("2026-10-24T13:00:00.000Z", 1), ...dstTomorrow.slice(0, 24)],
  });
  assert(!dstMissingHour.available, "24 rows are incomplete on a 25-hour Helsinki day");
  assertEqual(dstMissingHour.reason, "tomorrow_prices_incomplete", "DST gap remains fail-closed");
  const quarterPrice = (startsAt: string, cents: number): ShadowElectricityPrice => ({
    starts_at: startsAt,
    ends_at: new Date(Date.parse(startsAt) + 15 * 60_000).toISOString(),
    resolution_minutes: 15,
    spot_price_cents_kwh: cents,
  });
  const quarterTomorrowStart = Date.parse("2026-09-17T21:00:00.000Z");
  const quarterTomorrow = Array.from({ length: 96 }, (_, index) =>
    quarterPrice(new Date(quarterTomorrowStart + index * 15 * 60_000).toISOString(), 20),
  );
  const quarterOpportunity = evaluateV2PreheatOpportunity({
    now,
    prices: [
      quarterPrice("2026-09-17T12:45:00.000Z", 5),
      quarterPrice("2026-09-17T13:00:00.000Z", 25),
      ...quarterTomorrow,
    ],
  });
  assert(quarterOpportunity.available, "complete 15-minute tomorrow horizon enables preheat");
  assertEqual(quarterOpportunity.resolutionMinutes, 15, "quarter-hour horizon reports its resolution");
  assertEqual(quarterOpportunity.eligiblePreheatHourIds.length, 1, "only cheaper future quarter is eligible");
  assertEqual(
    quarterOpportunity.eligiblePreheatHourIds[0],
    "2026-09-17T12:45:00.000Z",
    "quarter-hour opportunity preserves exact interval start",
  );

}

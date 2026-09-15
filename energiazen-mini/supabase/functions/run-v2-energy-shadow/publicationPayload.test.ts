import { buildExpectedV2PlanVersions, buildV2PriceSnapshot, buildV2StagedPlans, buildV2TankSnapshot } from "./publicationPayload";

function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}
function assertThrows(fn: () => unknown, message: string) {
  let rejected = false;
  try { fn(); } catch { rejected = true; }
  assertEqual(rejected, true, message);
}

export function runV2PublicationPayloadUnitTests() {
  const covered = [
    "2026-09-15T20:00:00.000Z",
    "2026-09-15T21:00:00.000Z",
    "2026-09-15T22:00:00.000Z",
  ];
  const plans = buildV2StagedPlans({ selectedHeatingHourIds: [
    "2026-09-15T21:00:00.000Z",
    "2026-09-15T22:00:00.000Z",
  ] }, covered);
  assertDeepEqual(plans, [
    { plan_date: "2026-09-15", planned_hours: [] },
    { plan_date: "2026-09-16", planned_hours: [0, 1] },
  ], "Helsinki grouping emits empty covered dates");

  assertDeepEqual(buildV2StagedPlans({ selectedHeatingHourIds: [] }, covered), [
    { plan_date: "2026-09-15", planned_hours: [] },
    { plan_date: "2026-09-16", planned_hours: [] },
  ], "no-heat decision clears all covered dates");
  assertThrows(() => buildV2StagedPlans({ selectedHeatingHourIds: [] }, []), "covered horizon required");
  assertThrows(() => buildV2StagedPlans({ selectedHeatingHourIds: ["not-a-date"] }, covered), "malformed hour rejected");
  assertThrows(() => buildV2StagedPlans({ selectedHeatingHourIds: ["2026-09-15T19:00:00.000Z"] }, covered), "selected hour must be exact covered instant");

  const dstCovered = ["2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z"];
  assertThrows(() => buildV2StagedPlans({ selectedHeatingHourIds: [dstCovered[0]] }, dstCovered), "first repeated DST occurrence rejected");
  assertThrows(() => buildV2StagedPlans({ selectedHeatingHourIds: [dstCovered[1]] }, dstCovered), "second repeated DST occurrence rejected");
  assertThrows(() => buildV2StagedPlans({ selectedHeatingHourIds: dstCovered }, dstCovered), "both repeated DST occurrences rejected");

  assertDeepEqual(buildV2StagedPlans(
    { selectedHeatingHourIds: ["2026-09-15T10:00:00+00:00"] },
    ["2026-09-15T10:00:00Z"],
  ), [{ plan_date: "2026-09-15", planned_hours: [13] }], "equivalent timestamp spellings accepted");

  const readings = [
    { created_at: "2026-09-15T10:00:00Z", top_temp: 55, bottom_temp: 40, inlet_temp: 10, heating: false },
    { created_at: "2026-09-15T10:05:00Z", top_temp: Number.NaN, bottom_temp: 40, inlet_temp: 10, heating: false },
  ];
  assertDeepEqual(buildV2TankSnapshot(readings, readings[0].created_at), {
    created_at: readings[0].created_at, top_temp: 55, bottom_temp: 40, inlet_temp: 10, heating: false,
  }, "exact usable anchor includes relay state");
  assertEqual(buildV2TankSnapshot(readings, readings[1].created_at), null, "unusable anchor rejected");

  assertDeepEqual(buildExpectedV2PlanVersions(
    [{ plan_date: "2026-09-15", planned_hours: [2, 3] }, { plan_date: "2026-09-16", planned_hours: [] }],
    [{ plan_date: "2026-09-15", updated_at: "2026-09-15T09:00:00Z" }],
  ), [
    { plan_date: "2026-09-15", updated_at: "2026-09-15T09:00:00Z" },
    { plan_date: "2026-09-16", updated_at: null },
  ], "CAS versions cover every plan date");
  assertThrows(() => buildExpectedV2PlanVersions([
    { plan_date: "2026-09-15", planned_hours: [] },
    { plan_date: "2026-09-15", planned_hours: [2] },
  ], []), "duplicate plan dates rejected");

  assertThrows(() => buildV2PriceSnapshot([
    { starts_at: "2026-09-15T10:00:00.000Z", ends_at: "2026-09-15T11:00:00.000Z", spot_price_cents_kwh: 1, resolution_minutes: 60 },
    { starts_at: "2026-09-15T10:00:00Z", ends_at: "2026-09-15T11:00:00Z", spot_price_cents_kwh: 1, resolution_minutes: 60 },
  ]), "duplicate equivalent price intervals rejected");
}

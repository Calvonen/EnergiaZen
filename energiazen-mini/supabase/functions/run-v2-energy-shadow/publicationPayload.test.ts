import { buildExpectedV2PlanVersions, buildV2StagedPlans, buildV2TankSnapshot } from "./publicationPayload";

function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

export function runV2PublicationPayloadUnitTests() {
  const plans = buildV2StagedPlans({ selectedHeatingHourIds: [
    "2026-09-15T21:00:00.000Z",
    "2026-09-15T22:00:00.000Z",
  ] });
  assertDeepEqual(plans, [{ plan_date: "2026-09-16", planned_hours: [0, 1] }], "Helsinki grouping");

  let rejected = false;
  try { buildV2StagedPlans({ selectedHeatingHourIds: ["not-a-date"] }); } catch { rejected = true; }
  assertEqual(rejected, true, "malformed hour rejected");

  const readings = [
    { created_at: "2026-09-15T10:00:00Z", top_temp: 55, bottom_temp: 40, inlet_temp: 10, heating: false },
    { created_at: "2026-09-15T10:05:00Z", top_temp: Number.NaN, bottom_temp: 40, inlet_temp: 10, heating: false },
  ];
  assertDeepEqual(buildV2TankSnapshot(readings, readings[0].created_at), {
    created_at: readings[0].created_at, top_temp: 55, bottom_temp: 40, inlet_temp: 10,
  }, "exact usable anchor");
  assertEqual(buildV2TankSnapshot(readings, readings[1].created_at), null, "unusable anchor rejected");

  assertDeepEqual(buildExpectedV2PlanVersions(
    [{ plan_date: "2026-09-15", planned_hours: [2, 3] }, { plan_date: "2026-09-16", planned_hours: [1] }],
    [{ plan_date: "2026-09-15", updated_at: "2026-09-15T09:00:00Z" }],
  ), [
    { plan_date: "2026-09-15", updated_at: "2026-09-15T09:00:00Z" },
    { plan_date: "2026-09-16", updated_at: null },
  ], "CAS versions");
}

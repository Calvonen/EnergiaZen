import assert from "node:assert/strict";
import test from "node:test";
import { buildExpectedV2PlanVersions, buildV2StagedPlans, buildV2TankSnapshot } from "./publicationPayload.ts";

test("groups selected UTC hour ids into Helsinki plan dates and hours", () => {
  const plans = buildV2StagedPlans({ selectedHeatingHourIds: [
    "2026-09-15T21:00:00.000Z",
    "2026-09-15T22:00:00.000Z",
  ] });
  assert.deepEqual(plans, [
    { plan_date: "2026-09-16", planned_hours: [0, 1] },
  ]);
});

test("rejects malformed selected hour ids", () => {
  assert.throws(() => buildV2StagedPlans({ selectedHeatingHourIds: ["not-a-date"] }));
});

test("tank snapshot must be the exact usable anchor row", () => {
  const readings = [
    { created_at: "2026-09-15T10:00:00Z", top_temp: 55, bottom_temp: 40, inlet_temp: 10, heating: false },
    { created_at: "2026-09-15T10:05:00Z", top_temp: Number.NaN, bottom_temp: 40, inlet_temp: 10, heating: false },
  ];
  assert.deepEqual(buildV2TankSnapshot(readings, readings[0].created_at), {
    created_at: readings[0].created_at, top_temp: 55, bottom_temp: 40, inlet_temp: 10,
  });
  assert.equal(buildV2TankSnapshot(readings, readings[1].created_at), null);
});

test("captures independent staged-plan CAS versions", () => {
  assert.deepEqual(buildExpectedV2PlanVersions(
    [{ plan_date: "2026-09-15", planned_hours: [2, 3] }, { plan_date: "2026-09-16", planned_hours: [1] }],
    [{ plan_date: "2026-09-15", updated_at: "2026-09-15T09:00:00Z" }],
  ), [
    { plan_date: "2026-09-15", updated_at: "2026-09-15T09:00:00Z" },
    { plan_date: "2026-09-16", updated_at: null },
  ]);
});

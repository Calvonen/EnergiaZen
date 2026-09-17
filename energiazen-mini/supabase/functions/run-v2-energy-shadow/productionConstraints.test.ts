import { resolveV2HeatingConstraints } from "./productionConstraints";
import type { ShadowTankReading } from "./logic";

function assertArray(actual: string[], expected: string[], message: string) {
  if (actual.join("|") !== expected.join("|")) {
    throw new Error(`${message}: expected ${expected.join(",")}, got ${actual.join(",")}`);
  }
}

function reading(createdAt: string, heating: boolean, top = 56): ShadowTankReading {
  return { created_at: createdAt, top_temp: top, bottom_temp: 35, inlet_temp: 12, heating };
}

export function runProductionConstraintUnitTests() {
  const ids = [
    "2026-09-15T11:00:00.000Z", // 14 Helsinki
    "2026-09-15T12:00:00.000Z", // 15
    "2026-09-15T13:00:00.000Z", // 16
    "2026-09-15T14:00:00.000Z", // 17
  ];
  const now = new Date("2026-09-15T11:23:00.000Z");

  const active = resolveV2HeatingConstraints({
    now,
    priceHourIds: ids,
    readings: [reading("2026-09-15T11:22:00.000Z", true)],
    storedPlans: [{ plan_date: "2026-09-15", planned_hours: [14, 15], mode: "automatic" }],
  });
  assertArray(active.requiredHeatingHourIds, ids.slice(0, 2), "active block must remain required");
  assertArray(active.forbiddenHeatingHourIds, [ids[2]], "first hour after active block must be forbidden");

  const safetyOverride = resolveV2HeatingConstraints({
    now,
    priceHourIds: ids,
    readings: [reading("2026-09-15T11:22:00.000Z", true, 49.9)],
    storedPlans: [{ plan_date: "2026-09-15", planned_hours: [14, 15], mode: "automatic" }],
  });
  assertArray(safetyOverride.requiredHeatingHourIds, [], "low top temperature must release block lock");
  assertArray(safetyOverride.forbiddenHeatingHourIds, [], "already committed current hour remains selectable after block release");

  const cooldownNow = new Date("2026-09-15T12:05:00.000Z");
  const cooldown = resolveV2HeatingConstraints({
    now: cooldownNow,
    priceHourIds: ids,
    readings: [
      reading("2026-09-15T11:40:00.000Z", true),
      reading("2026-09-15T12:04:00.000Z", false),
    ],
    storedPlans: [{ plan_date: "2026-09-15", planned_hours: [14], mode: "automatic" }],
  });
  assertArray(cooldown.requiredHeatingHourIds, [], "cooldown must not require current hour");
  assertArray(cooldown.forbiddenHeatingHourIds, [ids[1]], "hour after actual heating must be forbidden");

  const plannedConsecutive = resolveV2HeatingConstraints({
    now: cooldownNow,
    priceHourIds: ids,
    readings: [
      reading("2026-09-15T11:40:00.000Z", true),
      reading("2026-09-15T12:04:00.000Z", false),
    ],
    storedPlans: [{ plan_date: "2026-09-15", planned_hours: [14, 15], mode: "automatic" }],
  });
  assertArray(plannedConsecutive.forbiddenHeatingHourIds, [], "already planned consecutive hour must remain selectable");

  const fixedIgnored = resolveV2HeatingConstraints({
    now,
    priceHourIds: ids,
    readings: [reading("2026-09-15T11:22:00.000Z", true)],
    storedPlans: [{ plan_date: "2026-09-15", planned_hours: [14, 15], mode: "fixed" }],
  });
  assertArray(fixedIgnored.requiredHeatingHourIds, [], "fixed plan must not become V2 automatic constraint");
  assertArray(fixedIgnored.forbiddenHeatingHourIds, [ids[0]], "fixed plan must not authorize a new V2 mid-hour start");

  const incidentIds = [
    "2026-09-16T17:00:00.000Z", // 20 Helsinki
    "2026-09-16T18:00:00.000Z", // 21
    "2026-09-16T22:00:00.000Z", // 01 next day
    "2026-09-16T23:00:00.000Z", // 02 next day
  ];
  const incident = resolveV2HeatingConstraints({
    now: new Date("2026-09-16T17:04:01.318Z"),
    priceHourIds: incidentIds,
    readings: [reading("2026-09-16T17:04:00.000Z", false, 59)],
    storedPlans: [
      { plan_date: "2026-09-16", planned_hours: [], mode: "automatic" },
      { plan_date: "2026-09-17", planned_hours: [1, 2], mode: "automatic" },
    ],
  });
  assertArray(incident.requiredHeatingHourIds, [], "20:04 replay must not require the current hour");
  assertArray(
    incident.forbiddenHeatingHourIds,
    [incidentIds[0]],
    "20:04 replay must forbid adding the already-started 20-21 hour",
  );

  const precommittedCurrent = resolveV2HeatingConstraints({
    now: new Date("2026-09-16T17:04:01.318Z"),
    priceHourIds: incidentIds,
    readings: [reading("2026-09-16T17:04:00.000Z", false, 59)],
    storedPlans: [
      { plan_date: "2026-09-16", planned_hours: [20], mode: "automatic" },
      { plan_date: "2026-09-17", planned_hours: [1, 2], mode: "automatic" },
    ],
  });
  assertArray(
    precommittedCurrent.forbiddenHeatingHourIds,
    [],
    "a current hour committed before its start must remain eligible after the boundary",
  );
}

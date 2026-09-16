import { buildV2StagedPublicationArgs } from "./stagedPublication";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}
function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function runV2StagedPublicationUnitTests() {
  const now = new Date("2026-09-15T20:15:00.000Z");
  const prices = [
    { starts_at: "2026-09-15T20:00:00.000Z", ends_at: "2026-09-15T21:00:00.000Z", spot_price_cents_kwh: 2, resolution_minutes: 60 },
    { starts_at: "2026-09-15T21:00:00.000Z", ends_at: "2026-09-15T22:00:00.000Z", spot_price_cents_kwh: 1, resolution_minutes: 60 },
    { starts_at: "2026-09-16T21:00:00.000Z", ends_at: "2026-09-16T22:00:00.000Z", spot_price_cents_kwh: 3, resolution_minutes: 60 },
  ];
  const args = buildV2StagedPublicationArgs({
    candidate: { selectedHeatingHourIds: ["2026-09-15T21:00:00.000Z"] },
    constraintPlans: [{ plan_date: "2026-09-15", planned_hours: [23], mode: "automatic" }],
    draws: [],
    latestUsableReadingAt: "2026-09-15T20:14:00.000Z",
    now,
    plan: {
      available: true, assumption: "standing_loss_only_no_future_draws", candidateCount: 1,
      evaluatedCombinationCount: 1, firstSafetyViolationAt: null, firstTargetMissAt: null,
      forecastHorizonEndAt: "2026-09-16T22:00:00.000Z", minimumConservativeEnergyKwh: 10,
      reason: null, selectedHeatingEnergyKwh: 3, selectedHeatingHourIds: ["2026-09-15T21:00:00.000Z"],
      standingLossKwhPerHour: 0.1, totalCostCents: 3, valid: true,
    },
    prices,
    priceFetchEnd: new Date("2026-09-17T20:15:00.000Z"),
    readings: [{ created_at: "2026-09-15T20:14:00.000Z", top_temp: 55, bottom_temp: 40, inlet_temp: 10, heating: false }],
    replayStart: new Date("2026-09-15T14:15:00.000Z"),
    settings: { max_tank_temperature: 80, automatic_max_heating_hours: 4, v2_target_reserve_percent: 75, v2_safety_reserve_percent: 30 },
    storedStagedVersions: [{ plan_date: "2026-09-16", updated_at: "2026-09-15T20:00:00.000Z" }],
    today: "2026-09-15", tomorrow: "2026-09-16",
  });

  assertEqual(args.p_expected_price_snapshot.length, 3, "raw price query snapshot is preserved");
  assertDeepEqual(args.p_expected_plan_versions, [
    { plan_date: "2026-09-15", updated_at: null },
    { plan_date: "2026-09-16", updated_at: "2026-09-15T20:00:00.000Z" },
  ], "CAS snapshots both planning dates");
  assertEqual(args.p_replay_start_at, "2026-09-15T14:15:00.000Z", "six-hour replay start preserved");
  assertEqual(args.p_replay_end_at, "2026-09-15T20:15:00.000Z", "captured planning clock preserved");
  assertEqual(args.p_price_fetch_end_at, "2026-09-17T20:15:00.000Z", "48-hour query end preserved");
  assertDeepEqual(args.p_constraint_plan_dates, ["2026-09-15", "2026-09-16"], "constraint scope covers both dates");
}

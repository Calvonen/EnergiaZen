import { runLiveReserveShadow, type ReliableWaterDraw, type ShadowTankReading } from "./logic";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number | null, expected: number, message: string) {
  if (actual === null || Math.abs(actual - expected) > 0.001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function reading(
  timestamp: string,
  topTemp: number,
  bottomTemp: number,
  inletTemp: number,
  heating: boolean,
): ShadowTankReading {
  return {
    created_at: timestamp,
    top_temp: topTemp,
    bottom_temp: bottomTemp,
    inlet_temp: inletTemp,
    heating,
  };
}

export function runLiveV2EnergyShadowUnitTests() {
  const laggingSensors = runLiveReserveShadow({
    now: new Date("2026-09-08T11:21:00.000Z"),
    readings: [
      reading("2026-09-08T11:00:00.000Z", 56.2, 22.9, 12, true),
      reading("2026-09-08T11:10:00.000Z", 56.2, 23.0, 12, true),
      reading("2026-09-08T11:20:00.000Z", 56.2, 23.1, 12, true),
    ],
    reliableDraws: [],
    v1Shadow: { id: "v1", run_at: "2026-09-08T11:20:00.000Z", target_hours: 1 },
  });

  assert(laggingSensors.available, "lagging sensors remain available without a removal signal");
  assert(
    (laggingSensors.remainingEnergyKwh ?? 0) > (laggingSensors.observedEnergyKwh ?? 0),
    "known 3 kW heater input survives sensor lag",
  );
  assert(
    (laggingSensors.sensorGapKwh ?? 0) > 0,
    "sensor lag is retained as a diagnostic gap",
  );
  assertClose(
    laggingSensors.conservativeEnergyKwh,
    (laggingSensors.remainingEnergyKwh ?? 0) - 0.25,
    "reserve safety subtracts balance uncertainty, not the sensor gap",
  );
  assert(
    laggingSensors.safetyEnergyKwh === 3 && laggingSensors.targetEnergyKwh === 6,
    "live shadow uses the shared V2 reserve thresholds",
  );

  const unresolvedDraw = runLiveReserveShadow({
    now: new Date("2026-09-09T10:06:00.000Z"),
    readings: [
      reading("2026-09-09T10:00:00.000Z", 55, 40, 25, false),
      reading("2026-09-09T10:04:00.000Z", 55, 39.8, 25, false),
      reading("2026-09-09T10:05:00.000Z", 54, 35, 15, false),
    ],
    reliableDraws: [],
    v1Shadow: { id: "v1", run_at: "2026-09-09T10:05:00.000Z", target_hours: 0 },
  });
  assert(!unresolvedDraw.available, "unresolved inlet draw fails closed");
  assert(
    unresolvedDraw.reason === "unresolved_water_draw_detected",
    "unresolved draw explains shadow unavailability",
  );
  assert(unresolvedDraw.comparison === "v2_unavailable", "failed-closed V2 is reported unavailable");

  const acceptedDraw: ReliableWaterDraw = {
    event_started_at: "2026-09-09T10:04:00.000Z",
    event_ended_at: "2026-09-09T10:05:00.000Z",
    estimated_water_draw_net_energy_kwh: 0.8,
    energy_reliable: true,
    energy_quality_reason: null,
  };
  const resolvedDraw = runLiveReserveShadow({
    now: new Date("2026-09-09T10:11:00.000Z"),
    readings: [
      reading("2026-09-09T10:00:00.000Z", 55, 40, 25, false),
      reading("2026-09-09T10:04:00.000Z", 55, 40, 25, false),
      reading("2026-09-09T10:05:00.000Z", 54, 35, 15, false),
      reading("2026-09-09T10:10:00.000Z", 54, 35, 15, false),
    ],
    reliableDraws: [acceptedDraw],
    v1Shadow: { id: "v1", run_at: "2026-09-09T10:10:00.000Z", target_hours: 0 },
  });
  assert(resolvedDraw.available, "reliable energy removal resolves detected inlet draw");
  assert(resolvedDraw.reliableDrawCount === 1, "reliable draw is counted once");
  assert(resolvedDraw.v1NeedsEnergyRecovery === false, "zero V1 target hours maps to no recovery need");

  const staleGap = runLiveReserveShadow({
    now: new Date("2026-09-09T10:21:00.000Z"),
    readings: [
      reading("2026-09-09T10:00:00.000Z", 55, 40, 15, false),
      reading("2026-09-09T10:20:00.000Z", 55, 40, 15, false),
    ],
    reliableDraws: [],
    v1Shadow: null,
  });
  assert(!staleGap.available, "reading gaps over 15 minutes fail closed");
  assert(staleGap.reason === "tank_reading_gap_too_long", "long gap reason is persisted");
  assert(staleGap.comparison === "v1_unavailable", "missing V1 snapshot is explicit");

  const staleLatest = runLiveReserveShadow({
    now: new Date("2026-09-09T12:00:00.000Z"),
    readings: [
      reading("2026-09-09T10:00:00.000Z", 55, 40, 15, false),
      reading("2026-09-09T10:05:00.000Z", 55, 40, 15, false),
    ],
    reliableDraws: [],
    v1Shadow: { id: "v1", run_at: "2026-09-09T11:58:00.000Z", target_hours: 1 },
  });
  assert(!staleLatest.available, "stale latest reading fails closed even when pairwise gaps are short");
  assert(
    staleLatest.reason === "latest_tank_reading_stale",
    "stale latest reading has its own diagnostic reason",
  );
}

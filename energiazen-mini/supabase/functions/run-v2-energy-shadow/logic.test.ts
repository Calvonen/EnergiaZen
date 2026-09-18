import {
  applyReserveThresholds,
  deriveUsableReadingInletBaselineC,
  runLiveReserveShadow,
  type ReliableWaterDraw,
  type ShadowTankReading,
} from "./logic";

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

const maxTankTemperatureC = 65;

export function runLiveV2EnergyShadowUnitTests() {
  const capacityBaseline = deriveUsableReadingInletBaselineC([
    reading("invalid", 55, 40, 2, false),
    reading("2026-09-08T10:00:00.000Z", Number.NaN, 40, 4, false),
    reading("2026-09-08T10:05:00.000Z", 55, 40, 12, false),
    reading("2026-09-08T10:10:00.000Z", 55, 40, 14, false),
  ]);
  assertClose(
    capacityBaseline,
    12,
    "capacity baseline excludes the same unusable readings as the reserve replay",
  );

  const laggingSensors = runLiveReserveShadow({
    maxTankTemperatureC,
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
    "known relay-on heater input survives sensor lag below the thermostat guard",
  );
  assert((laggingSensors.sensorGapKwh ?? 0) > 0, "sensor lag remains a diagnostic gap");
  assertClose(laggingSensors.heaterDeliveryUncertaintyKwh, 0, "ordinary heating below guard has no delivery uncertainty");
  assertClose(
    laggingSensors.conservativeEnergyKwh,
    (laggingSensors.remainingEnergyKwh ?? 0) - 0.25,
    "reserve safety subtracts balance uncertainty, not the sensor gap",
  );
  assert(
    laggingSensors.safetyEnergyKwh === 3 && laggingSensors.targetEnergyKwh === 6,
    "live shadow uses the shared V2 reserve thresholds",
  );
  assertClose(laggingSensors.heaterCreditGuardTopTempC, 63, "65 C max setting creates a 63 C heater credit guard");

  const warmerSensorsWithoutInput = runLiveReserveShadow({
    maxTankTemperatureC,
    now: new Date("2026-09-09T09:06:00.000Z"),
    readings: [
      reading("2026-09-09T09:00:00.000Z", 50, 35, 15, false),
      reading("2026-09-09T09:05:00.000Z", 54, 40, 15, false),
    ],
    reliableDraws: [],
    v1Shadow: null,
  });
  assert(warmerSensorsWithoutInput.available, "warmer sensor observation alone is still diagnosable");
  assert(
    (warmerSensorsWithoutInput.remainingEnergyKwh ?? 0) < (warmerSensorsWithoutInput.observedEnergyKwh ?? 0),
    "warmer sensors cannot mint physical energy without an explicit source",
  );
  assert(
    (warmerSensorsWithoutInput.sensorGapKwh ?? 0) < 0,
    "model below observation is retained as a signed diagnostic gap",
  );

  const thermostatTransition = runLiveReserveShadow({
    maxTankTemperatureC,
    now: new Date("2026-09-09T09:12:00.000Z"),
    readings: [
      reading("2026-09-09T09:10:00.000Z", 62.5, 45, 15, true),
      reading("2026-09-09T09:11:00.000Z", 63.1, 45.1, 15, false),
    ],
    reliableDraws: [],
    v1Shadow: null,
  });
  assert(thermostatTransition.available, "heater transition remains shadow-evaluable");
  assertClose(
    thermostatTransition.heaterDeliveryUncertaintyKwh,
    0.05,
    "one uncertain minute at 3 kW contributes 0.05 kWh delivery uncertainty",
  );
  assertClose(
    thermostatTransition.balanceUncertaintyKwh,
    0.3,
    "heater delivery uncertainty is added to the 0.25 kWh baseline",
  );

  const unresolvedDraw = runLiveReserveShadow({
    coldInletDrawBaselineC: 12.2,
    maxTankTemperatureC,
    now: new Date("2026-09-09T10:07:00.000Z"),
    readings: [
      reading("2026-09-09T10:00:00.000Z", 55, 40, 25, false),
      reading("2026-09-09T10:04:00.000Z", 55, 39.8, 25, false),
      reading("2026-09-09T10:05:00.000Z", 54.5, 37, 12.5, false),
      reading("2026-09-09T10:06:00.000Z", 54, 35, 12.4, false),
    ],
    reliableDraws: [],
    v1Shadow: { id: "v1", run_at: "2026-09-09T10:06:00.000Z", target_hours: 0 },
  });
  assert(!unresolvedDraw.available, "active inlet draw fails closed");
  assert(unresolvedDraw.reason === "unresolved_water_draw_detected", "active draw explains shadow unavailability");
  assert(unresolvedDraw.comparison === "v2_unavailable", "failed-closed V2 is reported unavailable");

  const stabilizedUnlabeledReadings: ShadowTankReading[] = [];
  for (let minute = 0; minute <= 30; minute += 1) {
    const timestamp = new Date(Date.UTC(2026, 8, 9, 11, minute, 0)).toISOString();
    const beforeDraw = minute <= 4;
    const duringDraw = minute >= 5 && minute <= 8;
    const inletTemp = beforeDraw ? 21 : duringDraw ? 12.5 : 20;
    const topTemp = beforeDraw ? 55 : 52;
    const bottomTemp = beforeDraw ? 40 : 35;
    stabilizedUnlabeledReadings.push(reading(timestamp, topTemp, bottomTemp, inletTemp, false));
  }
  const stabilizedUnlabeledDraw = runLiveReserveShadow({
    coldInletDrawBaselineC: 12.2,
    maxTankTemperatureC,
    now: new Date("2026-09-09T11:31:00.000Z"),
    readings: stabilizedUnlabeledReadings,
    reliableDraws: [],
    v1Shadow: { id: "v1", run_at: "2026-09-09T11:30:00.000Z", target_hours: 0 },
  });
  assert(
    stabilizedUnlabeledDraw.available,
    "unlabeled draw becomes available again after inlet recovery and 15 quiet minutes",
  );
  assert(
    !stabilizedUnlabeledDraw.unresolvedDrawDetected,
    "completed stabilized draw is not kept unresolved for the whole replay window",
  );
  assert(
    Math.abs((stabilizedUnlabeledDraw.sensorGapKwh ?? 99)) < 0.2,
    "post-draw re-anchor keeps the forward physical balance close to the stabilized observation",
  );

  const acceptedDraw: ReliableWaterDraw = {
    event_started_at: "2026-09-09T10:04:00.000Z",
    event_ended_at: "2026-09-09T10:05:00.000Z",
    estimated_water_draw_net_energy_kwh: 0.8,
    energy_reliable: true,
    energy_quality_reason: null,
  };
  const resolvedDraw = runLiveReserveShadow({
    maxTankTemperatureC,
    now: new Date("2026-09-09T10:11:00.000Z"),
    readings: [
      reading("2026-09-09T10:00:00.000Z", 55, 40, 25, false),
      reading("2026-09-09T10:04:00.000Z", 55, 40, 25, false),
      reading("2026-09-09T10:05:00.000Z", 54, 35, 15, false),
      reading("2026-09-09T10:10:00.000Z", 56, 41, 15, false),
    ],
    reliableDraws: [acceptedDraw],
    v1Shadow: { id: "v1", run_at: "2026-09-09T10:10:00.000Z", target_hours: 0 },
  });
  assert(resolvedDraw.available, "reliable energy removal resolves detected inlet draw");
  assert(resolvedDraw.reliableDrawCount === 1, "reliable draw is counted once");
  assert(
    (resolvedDraw.remainingEnergyKwh ?? Infinity) < (resolvedDraw.observedEnergyKwh ?? -Infinity),
    "later warm sensor data cannot add the accepted water-draw removal back",
  );
  assert(resolvedDraw.v1NeedsEnergyRecovery === false, "zero V1 target hours maps to no recovery need");

  const telemetryGap = runLiveReserveShadow({
    maxTankTemperatureC,
    now: new Date("2026-09-09T10:21:00.000Z"),
    readings: [
      reading("2026-09-09T10:00:00.000Z", 55, 40, 15, true),
      reading("2026-09-09T10:20:00.000Z", 53, 37, 15, false),
    ],
    reliableDraws: [],
    v1Shadow: null,
  });
  assert(telemetryGap.available, "a recovered telemetry gap re-anchors instead of poisoning the full replay window");
  assertClose(telemetryGap.sensorGapKwh, 0, "post-gap measurement becomes the new physical anchor");
  assertClose(telemetryGap.heaterDeliveryUncertaintyKwh, 0, "pre-gap relay uncertainty is discarded at the new anchor");
  assertClose(telemetryGap.balanceUncertaintyKwh, 0.25, "post-gap replay keeps only baseline balance uncertainty");

  const staleLatest = runLiveReserveShadow({
    maxTankTemperatureC,
    now: new Date("2026-09-09T12:00:00.000Z"),
    readings: [
      reading("2026-09-09T10:00:00.000Z", 55, 40, 15, false),
      reading("2026-09-09T10:05:00.000Z", 55, 40, 15, false),
    ],
    reliableDraws: [],
    v1Shadow: { id: "v1", run_at: "2026-09-09T11:58:00.000Z", target_hours: 1 },
  });
  assert(!staleLatest.available, "stale latest reading fails closed even when pairwise gaps are short");
  assert(staleLatest.reason === "latest_tank_reading_stale", "stale latest reading has its own diagnostic reason");

  const unavailableWithDerivedThresholds = applyReserveThresholds(staleLatest, 5.4, 17.1);
  assert(!unavailableWithDerivedThresholds.available, "thresholds do not mask replay unavailability");
  assert(
    unavailableWithDerivedThresholds.reason === "latest_tank_reading_stale",
    "derived thresholds preserve the replay failure reason",
  );
  assertClose(
    unavailableWithDerivedThresholds.safetyEnergyKwh,
    5.4,
    "unavailable runs persist the percentage-derived safety threshold",
  );
  assertClose(
    unavailableWithDerivedThresholds.targetEnergyKwh,
    17.1,
    "unavailable runs persist the percentage-derived target threshold",
  );
}

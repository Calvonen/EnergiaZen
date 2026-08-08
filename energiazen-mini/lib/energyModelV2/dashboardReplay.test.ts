import { calculateDashboardV2Replay, calculateDashboardV2TankState, type DashboardReplayReading } from "./dashboardReplay";
import { topSensorMovedAt } from "./sensorGeometry";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runDashboardReplayUnitTests() {
  const beforeCurrentEpoch = new Date(
    new Date(topSensorMovedAt).getTime() - 60_000,
  ).toISOString();
  const afterCurrentEpoch = new Date(
    new Date(topSensorMovedAt).getTime() + 60_000,
  ).toISOString();
  const completeReading: DashboardReplayReading = {
    bottom_temp: 45,
    created_at: afterCurrentEpoch,
    heating: false,
    inlet_temp: 12,
    top_temp: 60,
  };

  const state = calculateDashboardV2TankState([
    { ...completeReading, created_at: beforeCurrentEpoch },
    { ...completeReading, bottom_temp: null, created_at: topSensorMovedAt },
    completeReading,
  ]);

  assert(state?.quality === "valid", "dashboard replay starts at the first complete reading");
  assert(state?.timestamp === afterCurrentEpoch, "dashboard replay uses the current geometry epoch");

  const oneDayLater = new Date(new Date(afterCurrentEpoch).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const stateWithWarmLatestSensor = calculateDashboardV2TankState([
    { ...completeReading, inlet_temp: 8 },
    { ...completeReading, created_at: oneDayLater, inlet_temp: 21 },
  ]);

  assert(
    stateWithWarmLatestSensor?.inletTemperatureC === 8,
    "dashboard replay uses the seven-day minimum inlet temperature instead of the latest raw value",
  );

  const dailyWarmReadings = Array.from({ length: 9 }, (_, index) => ({
    ...completeReading,
    created_at: new Date(
      new Date(afterCurrentEpoch).getTime() + (index + 1) * 24 * 60 * 60 * 1000,
    ).toISOString(),
    inlet_temp: 21,
  }));
  const rawReadingsAcrossEstimateExpiry = [
    { ...completeReading, inlet_temp: 8 },
    ...dailyWarmReadings,
  ];
  const stateAfterEstimateExpires = calculateDashboardV2TankState(
    rawReadingsAcrossEstimateExpiry,
  );

  assert(
    stateAfterEstimateExpires?.inletTemperatureC === 21,
    "a derived inlet estimate never renews its timestamp as a new measurement",
  );
  assert(
    rawReadingsAcrossEstimateExpiry[1].inlet_temp === 21,
    "inlet estimates do not overwrite raw replay readings",
  );

  const stateWithoutCurrentCompleteReading = calculateDashboardV2TankState([
    { ...completeReading, created_at: beforeCurrentEpoch, inlet_temp: null },
    { ...completeReading, inlet_temp: null },
  ]);

  assert(
    stateWithoutCurrentCompleteReading === null,
    "dashboard replay does not initialize from a previous geometry epoch",
  );

  const coolingStart = new Date(new Date(topSensorMovedAt).getTime() + 60_000).toISOString();
  const coolingReadings: DashboardReplayReading[] = Array.from({ length: 21 }, (_, minutes) => ({
    bottom_temp: 45 - minutes / 100,
    created_at: new Date(new Date(coolingStart).getTime() + minutes * 60_000).toISOString(),
    heating: false,
    inlet_temp: 12,
    top_temp: 60 - minutes / 100,
  }));
  const coolingReplay = calculateDashboardV2Replay(coolingReadings);
  const observation = coolingReplay.heatLossDiagnostics.latestObservation;

  assert(
    coolingReplay.heatLossDiagnostics.observations.length === 1,
    "heat-loss diagnostics accepts a stable no-heating period",
  );
  assert(
    coolingReplay.heatLossDiagnostics.acceptance.examinedCount === 1 &&
      coolingReplay.heatLossDiagnostics.acceptance.acceptedCount === 1,
    "heat-loss diagnostics counts every examined and accepted period",
  );
  assert(observation?.durationMinutes === 20, "heat-loss observation includes its duration");
  assert(
    typeof observation?.energyLossKwhPerHour === "number" && observation.energyLossKwhPerHour > 0,
    "heat-loss observation includes a realistic hourly loss",
  );
  assert(
    observation?.usableEnergyStartKwh !== undefined && observation.usableEnergyEndKwh !== undefined,
    "heat-loss observation captures usable energy endpoints",
  );

  const heatingReplay = calculateDashboardV2Replay(
    coolingReadings.map((reading, index) => ({ ...reading, heating: index === 10 })),
  );
  assert(
    heatingReplay.heatLossDiagnostics.observations.length === 0,
    "heat-loss diagnostics excludes periods containing heating",
  );
  assert(
    heatingReplay.heatLossDiagnostics.acceptance.rejectionCounts.heating_detected === 1,
    "heat-loss diagnostics records heating as the first rejection reason",
  );

  const waterDrawReplay = calculateDashboardV2Replay(
    coolingReadings.map((reading, index) =>
      index === 10 ? { ...reading, top_temp: 55 } : reading,
    ),
  );
  assert(
    waterDrawReplay.heatLossDiagnostics.observations.length === 0,
    "heat-loss diagnostics excludes rapid sensor changes",
  );
  assert(
    waterDrawReplay.heatLossDiagnostics.acceptance.rejectionCounts.rapid_temperature_change === 1,
    "heat-loss diagnostics records a rapid temperature change rejection",
  );

  const temperatureJumpAfterGapReplay = calculateDashboardV2Replay([
    { ...completeReading, created_at: coolingStart },
    {
      ...completeReading,
      created_at: new Date(new Date(coolingStart).getTime() + 3 * 60_000).toISOString(),
      top_temp: completeReading.top_temp! - 1,
    },
  ]);
  assert(
    temperatureJumpAfterGapReplay.heatLossDiagnostics.acceptance.rejectionCounts.measurement_gap === 1 &&
      temperatureJumpAfterGapReplay.heatLossDiagnostics.acceptance.rejectionCounts.rapid_temperature_change === 0,
    "a temperature jump after a gap longer than two minutes is classified as a measurement gap",
  );

  const temperatureJumpWithinIntervalReplay = calculateDashboardV2Replay([
    { ...completeReading, created_at: coolingStart },
    {
      ...completeReading,
      created_at: new Date(new Date(coolingStart).getTime() + 2 * 60_000).toISOString(),
      top_temp: completeReading.top_temp! - 1,
    },
  ]);
  assert(
    temperatureJumpWithinIntervalReplay.heatLossDiagnostics.acceptance.rejectionCounts.rapid_temperature_change === 1 &&
      temperatureJumpWithinIntervalReplay.heatLossDiagnostics.acceptance.rejectionCounts.measurement_gap === 0,
    "a temperature jump within a two-minute interval remains a rapid temperature change",
  );

  const inletSignatureReplay = calculateDashboardV2Replay(
    coolingReadings.map((reading, index) => ({
      ...reading,
      inlet_temp: index === 0 ? 10 : index < 14 ? 20 : 15,
    })),
  );
  assert(
    inletSignatureReplay.heatLossDiagnostics.observations.length === 0,
    "heat-loss diagnostics excludes a raw inlet water-draw signature even when the estimated inlet stays stable",
  );
  assert(
    inletSignatureReplay.heatLossDiagnostics.acceptance.rejectionCounts.water_draw === 1,
    "heat-loss diagnostics records a water-draw signature rejection",
  );

  const missingInletReadings: DashboardReplayReading[] = Array.from(
    { length: 31 },
    (_, minute) => ({
      bottom_temp: 45 - minute / 100,
      created_at: new Date(
        new Date(coolingStart).getTime() + minute * 60_000,
      ).toISOString(),
      heating: false,
      inlet_temp: minute === 15 ? null : 12,
      top_temp: 60 - minute / 100,
    }),
  );
  const missingInletReplay = calculateDashboardV2Replay(missingInletReadings);
  assert(
    missingInletReplay.heatLossDiagnostics.acceptance.rejectionCounts.missing_inlet_data === 1,
    "heat-loss diagnostics records missing inlet data and groups the interrupted period",
  );
  assert(
    missingInletReplay.heatLossDiagnostics.observations.length === 2,
    "missing raw inlet data splits otherwise usable heat-loss observations",
  );
  assert(
    missingInletReplay.heatLossDiagnostics.observations[0].startedAt ===
      missingInletReadings[0].created_at &&
      missingInletReplay.heatLossDiagnostics.observations[0].endedAt ===
        missingInletReadings[14].created_at,
    "the first observation ends at the last complete reading before missing inlet data",
  );
  assert(
    missingInletReplay.heatLossDiagnostics.observations[1].startedAt ===
      missingInletReadings[16].created_at &&
      missingInletReplay.heatLossDiagnostics.observations[1].endedAt ===
        missingInletReadings[30].created_at,
    "the second observation starts at the first complete reading after missing inlet data",
  );

  const mixingReplay = calculateDashboardV2Replay(Array.from({ length: 21 }, (_, minutes) => ({
    bottom_temp: 45 + (minutes / 20) * 0.3,
    created_at: new Date(new Date(coolingStart).getTime() + minutes * 60_000).toISOString(),
    heating: false,
    inlet_temp: 12,
    top_temp: 60 - (minutes / 20) * 0.4,
  })));
  assert(
    mixingReplay.heatLossDiagnostics.observations.length === 0,
    "heat-loss diagnostics excludes compensating node movement that can hide water use or mixing",
  );

  const inletMinimumTimestamp = new Date(
    new Date(topSensorMovedAt).getTime() + 60_000,
  );
  const inletBaselineExpiryReadings: DashboardReplayReading[] = [
    {
      ...completeReading,
      created_at: inletMinimumTimestamp.toISOString(),
      inlet_temp: 12,
    },
    ...Array.from({ length: 121 }, (_, minute) => ({
      bottom_temp: 45 - minute * 0.002,
      created_at: new Date(
        inletMinimumTimestamp.getTime() +
          (7 * 24 * 60 - 60 + minute) * 60_000,
      ).toISOString(),
      heating: false,
      inlet_temp: 12.8,
      top_temp: 60 - minute * 0.002,
    })),
  ];
  const baselineExpiryReplay = calculateDashboardV2Replay(
    inletBaselineExpiryReadings,
  );
  const fixedBaselineReplay = calculateDashboardV2Replay(
    inletBaselineExpiryReadings.map((reading) => ({
      ...reading,
      inlet_temp: 12,
    })),
  );
  const baselineExpiryObservation =
    baselineExpiryReplay.heatLossDiagnostics.latestObservation;
  const fixedBaselineObservation =
    fixedBaselineReplay.heatLossDiagnostics.latestObservation;

  assert(
    baselineExpiryReplay.tankState?.inletTemperatureC === 12.8,
    "the replay inlet estimate changes when the old seven-day minimum expires",
  );
  assert(
    baselineExpiryObservation?.estimatedInletTemperatureC === 12,
    "the heat-loss observation locks the inlet estimate from its first step",
  );
  assert(
    baselineExpiryObservation !== null && fixedBaselineObservation !== null &&
      baselineExpiryObservation.energyLossKwh === fixedBaselineObservation.energyLossKwh &&
      baselineExpiryObservation.storedEnergyStartKwh === fixedBaselineObservation.storedEnergyStartKwh &&
      baselineExpiryObservation.storedEnergyEndKwh === fixedBaselineObservation.storedEnergyEndKwh,
    "observation endpoint energies use one inlet baseline even when the replay estimate changes",
  );
}

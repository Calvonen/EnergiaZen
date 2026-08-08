import { calculateDashboardV2Replay, calculateDashboardV2TankState, type DashboardReplayReading } from "./dashboardReplay";
import { topSensorMovedAt } from "./sensorGeometry";
import {
  mergeLatestRejections,
  type HeatLossRejectionReason,
  type RejectedHeatLossObservation,
} from "./heatLossDiagnostics";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runDashboardReplayUnitTests() {
  const rejection = (
    reason: HeatLossRejectionReason,
    startMinute: number,
    endMinute: number,
  ): RejectedHeatLossObservation => ({
    reason,
    startedAt: new Date(Date.UTC(2026, 0, 1, 17, startMinute)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 0, 1, 17, endMinute)).toISOString(),
  });
  const samples = (...minutes: number[]) => minutes.map((minute) =>
    new Date(Date.UTC(2026, 0, 1, 17, minute)).toISOString()
  );
  const consecutiveHeating = [
    rejection("heating_detected", 23, 24),
    rejection("heating_detected", 24, 25),
    rejection("heating_detected", 25, 26),
  ];
  const mergedHeating = mergeLatestRejections(consecutiveHeating, [], samples(23, 24, 25, 26));
  assert(
    mergedHeating.length === 1 &&
      mergedHeating[0].startedAt === consecutiveHeating[0].startedAt &&
      mergedHeating[0].endedAt === consecutiveHeating[2].endedAt,
    "consecutive heating rejections are presented as one diagnostic event",
  );
  assert(
    mergeLatestRejections([
      rejection("heating_detected", 10, 11),
      rejection("heating_detected", 20, 21),
    ], [], samples(10, 11, 20, 21)).length === 2,
    "same-reason rejections separated by a long gap remain separate events",
  );
  assert(
    mergeLatestRejections([
      rejection("heating_detected", 10, 11),
      rejection("measurement_gap", 11, 12),
    ], [], samples(10, 11, 12)).length === 2,
    "consecutive rejections with different reasons remain separate events",
  );
  (["pre_water_draw_guard", "inlet_recovery", "tank_stabilization"] as const).forEach((reason) => {
    assert(
      mergeLatestRejections(
        [rejection(reason, 10, 11), rejection(reason, 11, 12)],
        [],
        samples(10, 11, 12),
      ).length === 1,
      `${reason} rejections merge only with the same reason`,
    );
  });
  const acceptedBetween = {
    startedAt: new Date(Date.UTC(2026, 0, 1, 17, 11, 10)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 0, 1, 17, 11, 50)).toISOString(),
  };
  assert(
    mergeLatestRejections([
      rejection("heating_detected", 10, 11),
      rejection("heating_detected", 12, 13),
    ], [acceptedBetween], samples(10, 11, 12, 13)).length === 2,
    "an accepted heat-loss observation prevents rejection events from merging",
  );
  const sparseHeating = [
    rejection("heating_detected", 0, 10),
    rejection("heating_detected", 10, 20),
  ];
  assert(
    mergeLatestRejections(sparseHeating, [], samples(0, 10, 20)).length === 2,
    "same-reason boundaries do not merge across underlying ten-minute sampling gaps",
  );
  const minuteHeating = [
    rejection("heating_detected", 0, 1),
    rejection("heating_detected", 1, 2),
    rejection("heating_detected", 2, 3),
  ];
  assert(
    mergeLatestRejections(minuteHeating, [], samples(0, 1, 2, 3)).length === 1,
    "one-minute heating samples are presented as one continuous event",
  );

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
  const coolingReadings: DashboardReplayReading[] = Array.from({ length: 47 }, (_, minutes) => ({
    bottom_temp: 45 - minutes / 100,
    created_at: new Date(new Date(coolingStart).getTime() + minutes * 60_000).toISOString(),
    heating: false,
    inlet_temp: minutes === 0 ? 12 : 15,
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
  assert(observation?.durationMinutes === 46, "heat-loss observation includes its duration");
  assert(
    typeof observation?.energyLossKwhPerHour === "number" && observation.energyLossKwhPerHour > 0,
    "heat-loss observation includes a realistic hourly loss",
  );
  assert(
    observation?.usableEnergyStartKwh !== undefined && observation.usableEnergyEndKwh !== undefined,
    "heat-loss observation captures usable energy endpoints",
  );

  const coolingReadingsForDuration = (durationSeconds: number): DashboardReplayReading[] => {
    const sampleSeconds = [
      ...Array.from(
        { length: Math.floor(durationSeconds / 60) + 1 },
        (_, minute) => minute * 60,
      ),
      ...(durationSeconds % 60 === 0 ? [] : [durationSeconds]),
    ];

    return sampleSeconds.map((elapsedSeconds, index) => ({
      bottom_temp: 45 - elapsedSeconds / 6_000,
      created_at: new Date(new Date(coolingStart).getTime() + elapsedSeconds * 1_000).toISOString(),
      heating: false,
      inlet_temp: index === 0 ? 12 : 15,
      top_temp: 60 - elapsedSeconds / 6_000,
    }));
  };
  const justUnderMinimumReplay = calculateDashboardV2Replay(coolingReadingsForDuration(44 * 60 + 59));
  const exactMinimumReplay = calculateDashboardV2Replay(coolingReadingsForDuration(45 * 60));
  const overMinimumReplay = calculateDashboardV2Replay(coolingReadingsForDuration(46 * 60));

  assert(
    justUnderMinimumReplay.heatLossDiagnostics.observations.length === 0 &&
      justUnderMinimumReplay.heatLossDiagnostics.acceptance.rejectionCounts.too_short === 1,
    "a 44 minute 59 second heat-loss candidate is rejected as too short",
  );
  assert(
    exactMinimumReplay.heatLossDiagnostics.acceptance.rejectionCounts.too_short === 0,
    "an exact 45 minute heat-loss candidate proceeds past the duration check",
  );
  assert(
    overMinimumReplay.heatLossDiagnostics.acceptance.rejectionCounts.too_short === 0,
    "a 46 minute heat-loss candidate proceeds past the duration check",
  );
  assert(
    [coolingReplay, exactMinimumReplay, overMinimumReplay].every((replay) =>
      replay.heatLossDiagnostics.observations.every(({ durationMinutes }) => durationMinutes >= 45)
    ),
    "dashboard diagnostics never include accepted 16, 24, 27, or other sub-45-minute observations",
  );

  const heatingReplay = calculateDashboardV2Replay(
    coolingReadings.map((reading, index) => ({ ...reading, heating: index === 10 })),
  );
  assert(
    heatingReplay.heatLossDiagnostics.observations.length === 0,
    "heat-loss diagnostics excludes periods containing heating",
  );
  assert(
    heatingReplay.heatLossDiagnostics.acceptance.rejectionCounts.heating_detected === 1 &&
      heatingReplay.heatLossDiagnostics.acceptance.rejectionCounts.measurement_gap === 0,
    "a heating reading creates one heating boundary without a recovery measurement gap",
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
    waterDrawReplay.heatLossDiagnostics.acceptance.rejectionCounts.rapid_temperature_change >= 1,
    "heat-loss diagnostics records the rapid temperature change boundaries",
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
    inletSignatureReplay.heatLossDiagnostics.observations.length === 0 &&
      inletSignatureReplay.heatLossDiagnostics.acceptance.rejectionCounts.pre_water_draw_guard === 1,
    "a candidate wholly inside the rapid-drop guard is excluded",
  );
  const initialGuardAcceptance = inletSignatureReplay.heatLossDiagnostics.acceptance;
  const initialGuardRejectionCounts = Object.values(initialGuardAcceptance.rejectionCounts);
  assert(
    !Object.prototype.hasOwnProperty.call(initialGuardAcceptance.rejectionCounts, "null") &&
      initialGuardRejectionCounts.every(Number.isFinite),
    "an initial guard creates neither a null rejection count nor a NaN count",
  );
  assert(
    initialGuardAcceptance.latestRejections.every(({ reason }) => reason !== null),
    "an initial guard never exposes a null reason in recent diagnostics",
  );
  assert(
    initialGuardAcceptance.examinedCount === initialGuardAcceptance.acceptedCount +
      initialGuardRejectionCounts.reduce((sum, count) => sum + count, 0),
    "an initial guard does not inflate examined count with an artificial boundary",
  );
  assert(
    inletSignatureReplay.heatLossDiagnostics.acceptance.rejectionCounts.water_draw === 1,
    "heat-loss diagnostics records a water-draw signature rejection",
  );
  assert(
    inletSignatureReplay.heatLossDiagnostics.acceptance.waterDrawDetectionCounts.rapid_drop === 1,
    "the existing rapid-drop detector remains attributed independently",
  );

  const longCoolingReadings: DashboardReplayReading[] = Array.from({ length: 41 }, (_, minute) => ({
    bottom_temp: 45 - minute / 100,
    created_at: new Date(new Date(coolingStart).getTime() + minute * 60_000).toISOString(),
    heating: false,
    inlet_temp: minute === 0 ? 12 : minute === 19 ? 22 : 17,
    top_temp: 60 - minute / 100,
  }));
  const splitByWaterDraw = calculateDashboardV2Replay(longCoolingReadings);
  assert(
      splitByWaterDraw.heatLossDiagnostics.observations.length === 0 &&
      splitByWaterDraw.heatLossDiagnostics.acceptance.rejectionCounts.tank_stabilization === 1,
    "a rapid-drop guard, recovery, and stabilization gate the next candidate",
  );

  const guardedLongCoolingReadings: DashboardReplayReading[] = Array.from(
    { length: 86 },
    (_, minute) => ({
      bottom_temp: 45 - minute / 100,
      created_at: new Date(new Date(coolingStart).getTime() + minute * 60_000).toISOString(),
      heating: false,
      inlet_temp: minute === 0 ? 12 : minute === 65 ? 12 : 17,
      top_temp: 60 - minute / 100,
    }),
  );
  const guardedLongCoolingReplay = calculateDashboardV2Replay(guardedLongCoolingReadings);
  assert(
    guardedLongCoolingReplay.heatLossDiagnostics.observations[0]?.durationMinutes === 45 &&
      guardedLongCoolingReplay.heatLossDiagnostics.observations[0]?.endedAt ===
        guardedLongCoolingReadings[45].created_at,
    "a rapid drop trims exactly twenty minutes from a sixty-five-minute candidate",
  );

  const shortGuardRemainderReadings = guardedLongCoolingReadings.slice(0, 47).map(
    (reading, minute) => ({
      ...reading,
      heating: minute === 0,
      inlet_temp: minute === 0 ? 12 : minute === 26 ? 12 : 17,
    }),
  );
  const shortGuardRemainderReplay = calculateDashboardV2Replay(shortGuardRemainderReadings);
  assert(
    shortGuardRemainderReplay.heatLossDiagnostics.acceptance.rejectionCounts.tank_stabilization === 1,
    "a short post-draw remainder stays in tank stabilization",
  );

  const coldInletReadings: DashboardReplayReading[] = Array.from({ length: 41 }, (_, minute) => ({
    bottom_temp: 45 - minute / 100,
    created_at: new Date(new Date(coolingStart).getTime() + minute * 60_000).toISOString(),
    heating: false,
    inlet_temp: minute === 0 ? 12.1 : minute >= 15 && minute <= 20 ? 13 + (minute % 2) * 0.8 : 17,
    top_temp: 60 - minute / 100,
  }));

  const coldReplayStart = calculateDashboardV2Replay(coldInletReadings.map((reading) => ({
    ...reading,
    inlet_temp: 14,
  })));
  assert(
    coldReplayStart.heatLossDiagnostics.acceptance.waterDrawDetectionCounts.cold_inlet === 0,
    "a replay that starts with raw inlet equal to its new estimate does not self-seed a cold-inlet draw",
  );

  const varyingColdReplayStart = calculateDashboardV2Replay(coldInletReadings.map((reading, minute) => ({
    ...reading,
    inlet_temp: 13.2 + (minute % 2) * 0.5,
  })));
  assert(
    varyingColdReplayStart.heatLossDiagnostics.acceptance.waterDrawDetectionCounts.cold_inlet === 0,
    "several initially cold minutes do not trigger without an earlier valid idle baseline",
  );

  const coldInletReplay = calculateDashboardV2Replay(coldInletReadings);
  assert(
    coldInletReplay.heatLossDiagnostics.acceptance.waterDrawDetectionCounts.cold_inlet === 1,
    "five minutes of raw inlet readings within two degrees of the estimate is a water draw",
  );

  const delayedColdInletReadings = guardedLongCoolingReadings.map((reading, minute) => ({
    ...reading,
    inlet_temp: minute === 0 ? 12 : minute >= 65 && minute <= 69 ? 13 : 17,
  }));
  const delayedColdInletReplay = calculateDashboardV2Replay(delayedColdInletReadings);
  assert(
    delayedColdInletReplay.heatLossDiagnostics.observations[0]?.endedAt ===
      delayedColdInletReadings[45].created_at,
    "the cold-inlet guard is based on the cold candidate start, not its delayed confirmation",
  );
  assert(
    coldInletReplay.heatLossDiagnostics.observations.length === 0 &&
      coldInletReplay.heatLossDiagnostics.acceptance.rejectionCounts.tank_stabilization === 1,
    "a confirmed cold-inlet period requires recovery and tank stabilization afterward",
  );

  const shortColdInletReplay = calculateDashboardV2Replay(coldInletReadings.map((reading, minute) => ({
    ...reading,
    inlet_temp: minute === 0 ? 12.1 : minute >= 15 && minute <= 17 ? 13.8 : 15,
  })));
  assert(
    shortColdInletReplay.heatLossDiagnostics.acceptance.waterDrawDetectionCounts.cold_inlet === 0,
    "a cold inlet dip lasting only two minutes does not trigger the duration detector",
  );

  const showerLikeReplay = calculateDashboardV2Replay(coldInletReadings.map((reading, minute) => ({
    ...reading,
    inlet_temp: minute === 0 ? 12.1 : minute >= 15 && minute <= 25 ? 12.2 + (minute % 2) * 0.8 : 15,
  })));
  assert(
    showerLikeReplay.heatLossDiagnostics.acceptance.waterDrawDetectionCounts.cold_inlet === 1,
    "a ten-minute shower-like cold inlet period is reliably detected",
  );

  const unchangedBottomReplay = calculateDashboardV2Replay(coldInletReadings.map((reading) => ({
    ...reading,
    bottom_temp: 45,
  })));
  assert(
    unchangedBottomReplay.heatLossDiagnostics.acceptance.waterDrawDetectionCounts.cold_inlet === 1,
    "cold-inlet water draw detection does not depend on a bottom-temperature change",
  );

  const recoveryReadings: DashboardReplayReading[] = Array.from({ length: 65 }, (_, minute) => ({
    bottom_temp: 45 - minute / 100,
    created_at: new Date(new Date(coolingStart).getTime() + minute * 60_000).toISOString(),
    heating: false,
    // The first warm attempt lasts only one minute. A second draw resets it,
    // after which four readings provide three continuous warm minutes.
    inlet_temp: minute === 0 ? 12.1
      : (minute >= 15 && minute <= 34) || (minute >= 37 && minute <= 42) ? 13
      : 17,
    top_temp: 60 - minute / 100,
  }));
  const recoveryReplay = calculateDashboardV2Replay(recoveryReadings);
  assert(
    recoveryReplay.heatLossDiagnostics.acceptance.waterDrawDetectionCounts.cold_inlet === 2,
    "two cold-inlet draws before recovery remain independently detected",
  );
  assert(
    recoveryReplay.heatLossDiagnostics.acceptance.rejectionCounts.inlet_recovery === 1,
    "one continuous recovery interval is diagnosed across both draws",
  );
  assert(
    recoveryReplay.heatLossDiagnostics.observations.length === 0 &&
      recoveryReplay.heatLossDiagnostics.acceptance.rejectionCounts.tank_stabilization === 1,
    "recovered inlet alone does not admit data before tank stabilization",
  );

  const stabilizationReadings: DashboardReplayReading[] = Array.from(
    { length: 36 },
    (_, minute) => ({
      bottom_temp: 45 - minute / 100,
      created_at: new Date(new Date(coolingStart).getTime() + minute * 60_000).toISOString(),
      heating: false,
      inlet_temp: minute === 0 || minute === 6 ? 12 : 17,
      top_temp: 60 - minute / 100,
    }),
  );
  const unsettledBottomReplay = calculateDashboardV2Replay(
    stabilizationReadings.slice(0, 25).map((reading, minute) => ({
      ...reading,
      bottom_temp: minute >= 11 ? 45 - (minute - 10) : reading.bottom_temp,
    })),
  );
  assert(
    unsettledBottomReplay.heatLossDiagnostics.observations.length === 0 &&
      unsettledBottomReplay.heatLossDiagnostics.acceptance.rejectionCounts.tank_stabilization === 1,
    "a bottom sensor that keeps dropping leaves tank stabilization active",
  );

  const tenStableMinutesReplay = calculateDashboardV2Replay(stabilizationReadings.slice(0, 21));
  assert(
    tenStableMinutesReplay.heatLossDiagnostics.observations.length === 0 &&
      tenStableMinutesReplay.heatLossDiagnostics.acceptance.rejectionCounts.tank_stabilization === 1,
    "ten stable tank minutes after inlet recovery do not start a candidate",
  );

  const stabilizedReplay = calculateDashboardV2Replay([
    ...stabilizationReadings,
    ...Array.from({ length: 35 }, (_, offset) => {
      const minute = offset + 36;
      return {
        bottom_temp: 45 - minute / 100,
        created_at: new Date(new Date(coolingStart).getTime() + minute * 60_000).toISOString(),
        heating: false,
        inlet_temp: 17,
        top_temp: 60 - minute / 100,
      };
    }),
  ]);
  assert(
    stabilizedReplay.heatLossDiagnostics.observations.length === 1 &&
      stabilizedReplay.heatLossDiagnostics.observations[0].startedAt ===
        stabilizationReadings[25].created_at,
    "fifteen stable top and bottom minutes permit a new heat-loss candidate",
  );

  const rapidChangeDuringStabilization: DashboardReplayReading[] = Array.from(
    { length: 83 },
    (_, minute) => ({
      bottom_temp: 45 - minute / 100 - (minute >= 20 ? 1 : 0),
      created_at: new Date(new Date(coolingStart).getTime() + minute * 60_000).toISOString(),
      heating: false,
      inlet_temp: minute === 0 || minute === 6 ? 12 : 17,
      top_temp: 60 - minute / 100 - (minute >= 20 ? 1 : 0),
    }),
  );
  const rapidChangeDuringStabilizationReplay = calculateDashboardV2Replay(
    rapidChangeDuringStabilization,
  );
  assert(
    rapidChangeDuringStabilizationReplay.heatLossDiagnostics.observations[0]?.startedAt ===
      rapidChangeDuringStabilization[37].created_at &&
      rapidChangeDuringStabilizationReplay.heatLossDiagnostics.acceptance.rejectionCounts
        .rapid_temperature_change === 1,
    "a rapid tank change resets the stabilization timer before a candidate can start",
  );

  const newDrawDuringStabilizationReplay = calculateDashboardV2Replay(
    stabilizationReadings.map((reading, minute) => ({
      ...reading,
      inlet_temp: minute === 14 ? 12 : reading.inlet_temp,
    })),
  );
  assert(
      newDrawDuringStabilizationReplay.heatLossDiagnostics.observations.length === 0 &&
      newDrawDuringStabilizationReplay.heatLossDiagnostics.acceptance.rejectionCounts.water_draw === 2 &&
      newDrawDuringStabilizationReplay.heatLossDiagnostics.acceptance.rejectionCounts.inlet_recovery === 1,
    "a new water draw during stabilization returns to the draw and recovery chain",
  );

  const recoveryDisturbanceReadings: DashboardReplayReading[] = Array.from(
    { length: 45 },
    (_, minute) => ({
      bottom_temp: 45 - minute / 100,
      created_at: new Date(new Date(coolingStart).getTime() + minute * 60_000).toISOString(),
      heating: false,
      inlet_temp: minute === 0 ? 12 : minute === 14 ? 22 : minute === 15 ? 13 : 17,
      top_temp: 60 - minute / 100,
    }),
  );
  const assertRecoveryDisturbance = (
    readings: DashboardReplayReading[],
    reason: "heating_detected" | "missing_inlet_data" | "measurement_gap" | "rapid_temperature_change",
  ) => {
    const replay = calculateDashboardV2Replay(readings);
    assert(
      replay.heatLossDiagnostics.acceptance.rejectionCounts[reason] === 1,
      `${reason} inside inlet recovery remains visible in diagnostics`,
    );
    assert(
      replay.heatLossDiagnostics.acceptance.rejectionCounts.inlet_recovery === 1 &&
        replay.heatLossDiagnostics.acceptance.rejectionCounts.tank_stabilization === 1 &&
        replay.heatLossDiagnostics.observations.length === 0,
      `${reason} resets the warm timer before recovery proceeds to stabilization`,
    );
  };

  assertRecoveryDisturbance(recoveryDisturbanceReadings.map((reading, minute) => ({
    ...reading,
    heating: minute === 18,
  })), "heating_detected");
  assertRecoveryDisturbance(recoveryDisturbanceReadings.map((reading, minute) => ({
    ...reading,
    inlet_temp: minute === 18 ? null : reading.inlet_temp,
  })), "missing_inlet_data");
  assertRecoveryDisturbance(recoveryDisturbanceReadings.map((reading, minute) => ({
    ...reading,
    created_at: new Date(
      new Date(reading.created_at).getTime() + (minute >= 18 ? 3 * 60_000 : 0),
    ).toISOString(),
  })), "measurement_gap");
  assertRecoveryDisturbance(recoveryDisturbanceReadings.map((reading, minute) => ({
    ...reading,
    top_temp: reading.top_temp! - (minute >= 18 ? 1 : 0),
  })), "rapid_temperature_change");

  const repeatedWaterDrawReadings: DashboardReplayReading[] = Array.from(
    { length: 41 },
    (_, minute) => ({
      bottom_temp: 45 - minute / 100,
      created_at: new Date(
        new Date(coolingStart).getTime() + minute * 60_000,
      ).toISOString(),
      heating: false,
      inlet_temp: minute === 0 ? 12 : minute === 14 || minute === 17 ? 22 : 17,
      top_temp: 60 - minute / 100,
    }),
  );
  const repeatedWaterDrawReplay = calculateDashboardV2Replay(
    repeatedWaterDrawReadings,
  );
  assert(
    repeatedWaterDrawReplay.heatLossDiagnostics.acceptance.rejectionCounts.water_draw === 2,
    "each inlet drop creates its own water-draw boundary inside one five-minute window",
  );
  assert(
    repeatedWaterDrawReplay.heatLossDiagnostics.observations.length === 0 &&
      repeatedWaterDrawReplay.heatLossDiagnostics.acceptance.rejectionCounts.tank_stabilization === 1,
    "candidates cross neither repeated water draw and post-draw cooling must stabilize",
  );

  const rapidChangeReadings = longCoolingReadings.map((reading, minute) => ({
    ...reading,
    inlet_temp: minute === 0 ? 12 : 15,
    top_temp: reading.top_temp! - (minute >= 20 ? 1 : 0),
  }));
  const splitByRapidChange = calculateDashboardV2Replay(rapidChangeReadings);
  assert(
    splitByRapidChange.heatLossDiagnostics.observations.length === 0 &&
      splitByRapidChange.heatLossDiagnostics.acceptance.rejectionCounts.too_short === 2,
    "a rapid temperature transition splits both sub-45-minute candidates",
  );

  const gapReadings = longCoolingReadings.map((reading, minute) => ({
    ...reading,
    inlet_temp: minute === 0 ? 12 : 15,
    created_at: new Date(
      new Date(coolingStart).getTime() + (minute + (minute >= 20 ? 3 : 0)) * 60_000,
    ).toISOString(),
  }));
  const splitByGap = calculateDashboardV2Replay(gapReadings);
  assert(
    splitByGap.heatLossDiagnostics.observations.length === 0 &&
      splitByGap.heatLossDiagnostics.acceptance.rejectionCounts.too_short === 2,
    "a measurement gap does not admit sub-45-minute cooling candidates on either side",
  );

  const shortBeforeHeatingReadings = coolingReadingsForDuration(51 * 60)
    .map((reading, index) => ({ ...reading, heating: index === 5 }));
  const splitWithShortCandidate = calculateDashboardV2Replay(shortBeforeHeatingReadings);
  assert(
    splitWithShortCandidate.heatLossDiagnostics.observations.length === 1 &&
      splitWithShortCandidate.heatLossDiagnostics.acceptance.rejectionCounts.too_short === 1 &&
      splitWithShortCandidate.heatLossDiagnostics.acceptance.rejectionCounts.heating_detected === 1,
    "only the sub-45-minute side of a disturbance boundary is rejected as too short",
  );

  const missingInletReadings: DashboardReplayReading[] = Array.from(
    { length: 31 },
    (_, minute) => ({
      bottom_temp: 45 - minute / 100,
      created_at: new Date(
        new Date(coolingStart).getTime() + minute * 60_000,
      ).toISOString(),
      heating: false,
      inlet_temp: minute === 15 ? null : minute === 0 ? 12 : 15,
      top_temp: 60 - minute / 100,
    }),
  );
  const missingInletReplay = calculateDashboardV2Replay(missingInletReadings);
  assert(
    missingInletReplay.heatLossDiagnostics.acceptance.rejectionCounts.missing_inlet_data === 1 &&
      missingInletReplay.heatLossDiagnostics.acceptance.rejectionCounts.measurement_gap === 0,
    "missing inlet data creates one boundary without a recovery measurement gap",
  );
  assert(
    missingInletReplay.heatLossDiagnostics.observations.length === 0 &&
      missingInletReplay.heatLossDiagnostics.acceptance.rejectionCounts.too_short === 2,
    "missing raw inlet data leaves both sub-45-minute sides rejected",
  );

  const mixingReplay = calculateDashboardV2Replay(Array.from({ length: 21 }, (_, minutes) => ({
    bottom_temp: 45 + (minutes / 20) * 0.3,
    created_at: new Date(new Date(coolingStart).getTime() + minutes * 60_000).toISOString(),
    heating: false,
    inlet_temp: minutes === 0 ? 12 : 15,
    top_temp: 60 - (minutes / 20) * 0.4,
  })));
  assert(
    mixingReplay.heatLossDiagnostics.observations.length === 0 &&
      mixingReplay.heatLossDiagnostics.acceptance.rejectionCounts.too_short >= 1 &&
      mixingReplay.heatLossDiagnostics.acceptance.rejectionCounts.rapid_temperature_change === 1,
    "compensating node movement becomes a boundary without admitting the short period before it",
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
      inlet_temp: minute === 0 ? 12.8 : 15.8,
      top_temp: 60 - minute * 0.002,
    })),
  ];
  const baselineExpiryReplay = calculateDashboardV2Replay(
    inletBaselineExpiryReadings,
  );
  const fixedBaselineReplay = calculateDashboardV2Replay(
    inletBaselineExpiryReadings.map((reading, index) => ({
      ...reading,
      inlet_temp: index <= 1 ? reading.inlet_temp : 15.8,
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

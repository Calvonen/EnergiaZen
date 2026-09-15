import { runPhysicalEnergyReplay } from "./physicalEnergyReplay";
import { sensorGeometryV2 } from "./sensorGeometry";
import type { WaterDrawEventSnapshot } from "./waterDrawLabelDomain";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertNonDecreasing(values: number[], message: string) {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] + 0.000001 < values[index - 1]) {
      throw new Error(`${message}: ${values[index - 1]} -> ${values[index]}`);
    }
  }
}

export function runPhysicalEnergyReplayUnitTests() {
  // Production-shaped samples from 2026-09-08 14:00-15:00 Europe/Helsinki.
  // Top stayed essentially flat while the bottom sensor rose from 22.9 C to
  // 36.2 C. The V1 optimizer became more pessimistic mid-heating; V2 must
  // still account for the full 3 kWh physically delivered during the hour.
  const september8 = runPhysicalEnergyReplay({
    geometry: sensorGeometryV2,
    readings: [
      { bottomTempC: 22.9, heating: true, inletTempC: 19.4, timestamp: "2026-09-08T11:00:55.000Z", topTempC: 56.2 },
      { bottomTempC: 25.8, heating: true, inletTempC: 19.1, timestamp: "2026-09-08T11:20:55.000Z", topTempC: 56.1 },
      { bottomTempC: 31.1, heating: true, inletTempC: 19.4, timestamp: "2026-09-08T11:40:55.000Z", topTempC: 56.1 },
      { bottomTempC: 36.2, heating: false, inletTempC: 12.7, timestamp: "2026-09-08T12:00:55.000Z", topTempC: 56.0 },
    ],
  });

  assert(september8.finalLedger !== null, "8 Sep replay produces a physical ledger");
  if (!september8.finalLedger) return;
  assertClose(
    september8.finalLedger.cumulativeDeliveredHeatingEnergyKwh,
    3,
    "8 Sep one-hour heating block preserves exactly 3 kWh delivered energy",
  );
  assertNonDecreasing(
    september8.steps.map((step) => step.ledger.modeledStoredEnergyKwh),
    "8 Sep physical energy cannot fall during uninterrupted heating without an accepted removal",
  );

  // Production-shaped samples from the 2026-09-06 incident. The top sensor
  // initially drifted down from about 51 C while the bottom climbed steadily;
  // V1 remained safety-invalid for part of this period. There was no accepted
  // energy-removing event, so the known 3 kW input must remain monotonic.
  const september6 = runPhysicalEnergyReplay({
    geometry: sensorGeometryV2,
    readings: [
      { bottomTempC: 32.1, heating: true, inletTempC: 19.6, timestamp: "2026-09-06T12:25:54.000Z", topTempC: 51.0 },
      { bottomTempC: 34.9, heating: true, inletTempC: 15.0, timestamp: "2026-09-06T12:45:54.000Z", topTempC: 50.9 },
      { bottomTempC: 38.0, heating: true, inletTempC: 16.4, timestamp: "2026-09-06T13:04:54.000Z", topTempC: 49.7 },
      { bottomTempC: 40.8, heating: true, inletTempC: 17.7, timestamp: "2026-09-06T13:25:54.000Z", topTempC: 51.3 },
      { bottomTempC: 43.1, heating: true, inletTempC: 34.7, timestamp: "2026-09-06T13:45:54.000Z", topTempC: 53.7 },
      { bottomTempC: 45.6, heating: true, inletTempC: 41.3, timestamp: "2026-09-06T14:05:54.000Z", topTempC: 56.2 },
    ],
  });

  assert(september6.finalLedger !== null, "6 Sep replay produces a physical ledger");
  if (!september6.finalLedger) return;
  assertClose(
    september6.finalLedger.cumulativeDeliveredHeatingEnergyKwh,
    5,
    "6 Sep 100-minute production sequence preserves 5 kWh delivered energy",
  );
  assertNonDecreasing(
    september6.steps.map((step) => step.ledger.modeledStoredEnergyKwh),
    "6 Sep physical energy cannot become more pessimistic while heater input is known and no removal is accepted",
  );

  const acceptedDraw: WaterDrawEventSnapshot = {
    detectionKinds: [],
    durationMinutes: 5,
    endedAt: "2026-09-09T10:10:00.000Z",
    energyAfterStabilizationKwh: 6.9,
    energyBeforeKwh: 7.75,
    energyQualityReason: null,
    energyReliable: true,
    estimatedNaturalLossKwh: 0.05,
    estimatedWaterDrawNetEnergyKwh: 0.8,
    rawEnergyChangeKwh: -0.85,
    startedAt: "2026-09-09T10:05:00.000Z",
  };
  const withAcceptedDraw = runPhysicalEnergyReplay({
    acceptedWaterDrawEvents: [acceptedDraw],
    geometry: sensorGeometryV2,
    readings: [
      { bottomTempC: 40, heating: false, inletTempC: 15, timestamp: "2026-09-09T10:00:00.000Z", topTempC: 55 },
      { bottomTempC: 40, heating: false, inletTempC: 15, timestamp: "2026-09-09T10:05:00.000Z", topTempC: 55 },
      { bottomTempC: 25, heating: false, inletTempC: 15, timestamp: "2026-09-09T10:10:00.000Z", topTempC: 45 },
    ],
  });

  assert(withAcceptedDraw.finalLedger !== null, "accepted-draw replay produces a physical ledger");
  if (!withAcceptedDraw.finalLedger) return;
  assertClose(
    withAcceptedDraw.finalLedger.cumulativeAcceptedRemovalKwh,
    0.8,
    "replay applies only the validated 0.8 kWh water-draw removal",
  );
  const beforeDraw = withAcceptedDraw.steps[1].ledger.modeledStoredEnergyKwh;
  assertClose(
    beforeDraw - withAcceptedDraw.finalLedger.modeledStoredEnergyKwh,
    0.8,
    "cold sensor observation cannot remove more energy than the accepted draw estimate",
  );
}

import { runPhysicalEnergyReplay } from "./physicalEnergyReplay";
import { sensorGeometryV2 } from "./sensorGeometry";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

export function runAuthoritativeEnergyReplayUnitTests() {
  const replay = runPhysicalEnergyReplay({
    geometry: sensorGeometryV2,
    readings: [
      { bottomTempC: 22.9, heating: true, inletTempC: 19.4, timestamp: "2026-09-08T11:00:55.000Z", topTempC: 56.2 },
      { bottomTempC: 25.8, heating: true, inletTempC: 19.1, timestamp: "2026-09-08T11:20:55.000Z", topTempC: 56.1 },
      { bottomTempC: 31.1, heating: true, inletTempC: 19.4, timestamp: "2026-09-08T11:40:55.000Z", topTempC: 56.1 },
      { bottomTempC: 36.2, heating: false, inletTempC: 12.7, timestamp: "2026-09-08T12:00:55.000Z", topTempC: 56.0 },
    ],
  });

  assert(replay.finalLedger !== null, "replay produces ledger");
  assert(replay.finalAuthoritativeEnergy !== null, "replay produces authoritative energy");
  if (!replay.finalLedger || !replay.finalAuthoritativeEnergy) return;

  assertClose(
    replay.finalAuthoritativeEnergy.remainingEnergyKwh,
    replay.finalLedger.modeledStoredEnergyKwh,
    "authoritative remaining energy equals reconciled physical ledger",
  );
  assert(
    replay.finalAuthoritativeEnergy.remainingEnergyKwh >= replay.finalAuthoritativeEnergy.observedEnergyKwh,
    "lagging sensors cannot lower authoritative energy below the physical balance",
  );
  assert(
    replay.finalAuthoritativeEnergy.observedUsableEnergyKwh <= replay.finalAuthoritativeEnergy.observedEnergyKwh,
    "observed usable energy remains a bounded observation",
  );
  assert(
    !("showersLeft" in replay.finalAuthoritativeEnergy),
    "V2 authoritative energy state has no shower-count control field",
  );
}

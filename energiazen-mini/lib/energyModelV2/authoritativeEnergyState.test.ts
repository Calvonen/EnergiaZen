import { createAuthoritativeEnergyState } from "./authoritativeEnergyState";
import { calculateTankStateFromObservation } from "./energyModelCore";
import { createPhysicalEnergyLedger } from "./physicalEnergyLedger";
import { sensorGeometryV2 } from "./sensorGeometry";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

export function runAuthoritativeEnergyStateUnitTests() {
  const observed = calculateTankStateFromObservation({
    geometry: sensorGeometryV2,
    observation: {
      bottomTempC: 25.8,
      heating: true,
      inletTempC: 19.1,
      timestamp: "2026-09-08T11:20:55.000Z",
      topTempC: 56.1,
    },
  });
  const baseLedger = createPhysicalEnergyLedger({
    observedStoredEnergyKwh: observed.storedEnergy.kwh,
    timestamp: observed.timestamp ?? "2026-09-08T11:20:55.000Z",
  });

  const reconciled = createAuthoritativeEnergyState({
    ledger: {
      ...baseLedger,
      modeledStoredEnergyKwh: baseLedger.observedStoredEnergyKwh + 1,
      sensorCorrectionGapKwh: 1,
    },
    observedState: observed,
  });
  assertClose(reconciled.remainingEnergyKwh, observed.storedEnergy.kwh + 1, "authoritative remaining energy follows the physical ledger");
  assert(reconciled.quality === "valid", "a one-kWh sensor lag does not invalidate the physical state");
  assertClose(reconciled.uncertaintyKwh, 0, "plain sensor lag is not physical balance uncertainty");

  const sensorCorrectionOnly = createAuthoritativeEnergyState({
    ledger: baseLedger,
    observedState: {
      ...observed,
      quality: "degraded",
      uncertainty: {
        ...observed.uncertainty,
        energyKwh: 0.1,
        reasons: ["water-draw-or-mixing-corrected-from-sensors"],
      },
    },
  });
  assertClose(sensorCorrectionOnly.uncertaintyKwh, 0, "sensor correction's generic 0.1 kWh stays diagnostic only");

  const longGap = createAuthoritativeEnergyState({
    ledger: baseLedger,
    observedState: {
      ...observed,
      quality: "degraded",
      uncertainty: {
        ...observed.uncertainty,
        energyKwh: 0.55,
        reasons: ["water-draw-or-mixing-corrected-from-sensors", "long-replay-gap"],
      },
    },
  });
  assertClose(longGap.uncertaintyKwh, 0.55, "real long-gap balance uncertainty remains fail-closed");

  const degraded = createAuthoritativeEnergyState({
    ledger: {
      ...baseLedger,
      modeledStoredEnergyKwh: baseLedger.observedStoredEnergyKwh + 2,
      sensorCorrectionGapKwh: 2,
    },
    observedState: observed,
  });
  assert(degraded.quality === "degraded", "larger model/sensor gap degrades diagnostics");
  assertClose(degraded.uncertaintyKwh, 0, "diagnostic sensor gap is separate from physical balance uncertainty");

  const largeLag = createAuthoritativeEnergyState({
    ledger: {
      ...baseLedger,
      modeledStoredEnergyKwh: baseLedger.observedStoredEnergyKwh + 4.5,
      sensorCorrectionGapKwh: 4.5,
    },
    observedState: observed,
  });
  assert(largeLag.quality === "degraded", "even a large positive sensor lag alone cannot invalidate known remaining energy");
  assertClose(largeLag.uncertaintyKwh, 0, "large sensor lag still does not erase known physical energy");
}

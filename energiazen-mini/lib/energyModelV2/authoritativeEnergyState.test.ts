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

  assertClose(
    reconciled.remainingEnergyKwh,
    observed.storedEnergy.kwh + 1,
    "authoritative remaining energy follows the physical ledger",
  );
  assertClose(
    reconciled.observedEnergyKwh,
    observed.storedEnergy.kwh,
    "sensor-derived total energy remains visible as observation",
  );
  assertClose(
    reconciled.observedUsableEnergyKwh,
    observed.usableEnergy.kwh,
    "usable energy remains explicitly sensor-derived in this phase",
  );
  assert(
    reconciled.quality === "valid",
    "a one-kWh sensor lag does not invalidate the physical state",
  );
  assertClose(
    reconciled.uncertaintyKwh,
    observed.uncertainty.energyKwh,
    "known heater energy is not reclassified as balance uncertainty",
  );

  const degraded = createAuthoritativeEnergyState({
    ledger: {
      ...baseLedger,
      modeledStoredEnergyKwh: baseLedger.observedStoredEnergyKwh + 2,
      sensorCorrectionGapKwh: 2,
    },
    observedState: observed,
  });
  assert(degraded.quality === "degraded", "larger model/sensor gap degrades diagnostics");
  assert(
    degraded.reasons.includes("physical/sensor energy gap exceeds degraded threshold"),
    "degraded state explains the model/sensor disagreement",
  );
  assertClose(
    degraded.uncertaintyKwh,
    observed.uncertainty.energyKwh,
    "diagnostic sensor gap is separate from physical balance uncertainty",
  );

  const largeLag = createAuthoritativeEnergyState({
    ledger: {
      ...baseLedger,
      modeledStoredEnergyKwh: baseLedger.observedStoredEnergyKwh + 4.5,
      sensorCorrectionGapKwh: 4.5,
    },
    observedState: observed,
  });
  assert(
    largeLag.quality === "degraded",
    "even a large positive sensor lag alone cannot invalidate known remaining energy",
  );
  assertClose(
    largeLag.uncertaintyKwh,
    observed.uncertainty.energyKwh,
    "large sensor lag still does not erase known physical energy",
  );
}

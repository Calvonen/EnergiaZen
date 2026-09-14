import type { AuthoritativeEnergyState } from "./authoritativeEnergyState";
import {
  calibrateEnergyReserveThresholds,
  defaultEnergyReserveCalibration,
  defaultEnergyReserveThresholds,
  evaluateEnergyReserve,
} from "./energyReservePolicy";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function state(overrides: Partial<AuthoritativeEnergyState> = {}): AuthoritativeEnergyState {
  return {
    observedEnergyKwh: 6,
    observedUsableEnergyKwh: 4,
    quality: "valid",
    reasons: [],
    remainingEnergyKwh: 6,
    sensorGapKwh: 0,
    timestamp: "2026-09-14T17:30:00.000Z",
    uncertaintyKwh: 0,
    ...overrides,
  };
}

export function runEnergyReservePolicyUnitTests() {
  const calibrated = calibrateEnergyReserveThresholds(defaultEnergyReserveCalibration);
  assertClose(calibrated.safetyEnergyKwh, 3, "p95 + margin calibrates safety to 3.0 kWh");
  assertClose(calibrated.targetEnergyKwh, 6, "one 3 kW recovery hour calibrates target to 6.0 kWh");
  assertClose(defaultEnergyReserveThresholds.safetyEnergyKwh, 3, "default safety is 3.0 kWh");
  assertClose(defaultEnergyReserveThresholds.targetEnergyKwh, 6, "default target is 6.0 kWh");

  const safe = evaluateEnergyReserve(state({ remainingEnergyKwh: 6.5, uncertaintyKwh: 0.25 }));
  assert(safe.band === "target_met", "energy above target after uncertainty needs no recovery");
  assert(safe.needsEnergyRecovery === false, "target-met state does not request recovery");

  const recovery = evaluateEnergyReserve(state({ remainingEnergyKwh: 5, uncertaintyKwh: 0.5 }));
  assert(recovery.band === "recovery", "between safety and target enters recovery band");
  assert(recovery.safetySatisfied === true, "recovery band still satisfies safety");
  assert(recovery.targetSatisfied === false, "recovery band has not restored target");

  const uncertain = evaluateEnergyReserve(state({ remainingEnergyKwh: 3.4, uncertaintyKwh: 0.5 }));
  assertClose(uncertain.conservativeEnergyKwh, 2.9, "uncertainty is subtracted before safety evaluation");
  assert(uncertain.band === "below_safety", "uncertainty can conservatively move state below safety");

  const invalid = evaluateEnergyReserve(state({ quality: "invalid", remainingEnergyKwh: 10 }));
  assert(invalid.band === "invalid", "invalid authoritative state fails closed");
  assert(invalid.needsEnergyRecovery === null, "invalid state emits no control recommendation");
  assert(invalid.safetySatisfied === null, "invalid state does not claim safety");
}

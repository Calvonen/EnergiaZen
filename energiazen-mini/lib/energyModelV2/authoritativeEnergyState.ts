import type { TankState, TankStateQuality } from "./energyModelCore";
import type { PhysicalEnergyLedger } from "./physicalEnergyLedger";

export type AuthoritativeEnergyQuality = TankStateQuality;

export type AuthoritativeEnergyState = {
  /**
   * V2 primary reserve value: physical thermal energy still remaining in the
   * tank relative to inlet water. This is the reconciled ledger value and is
   * intentionally not a shower-count estimate.
   */
  remainingEnergyKwh: number;
  /** Sensor-derived total energy, retained as an observation/diagnostic. */
  observedEnergyKwh: number;
  /** Sensor-derived energy currently above the use-temperature threshold. */
  observedUsableEnergyKwh: number;
  /** Difference between physical ledger and instantaneous sensor estimate. */
  sensorGapKwh: number;
  quality: AuthoritativeEnergyQuality;
  /**
   * Uncertainty in the physical energy balance itself. Sensor lag is kept
   * separate in sensorGapKwh: known electrical heater input must not become
   * uncertain merely because stratified sensors have not reacted yet.
   */
  uncertaintyKwh: number;
  reasons: string[];
  timestamp: string;
};

export type AuthoritativeEnergyStateConfig = {
  degradedSensorGapKwh: number;
};

export const defaultAuthoritativeEnergyStateConfig: AuthoritativeEnergyStateConfig = {
  degradedSensorGapKwh: 1.5,
};

export function createAuthoritativeEnergyState({
  config = defaultAuthoritativeEnergyStateConfig,
  ledger,
  observedState,
}: {
  config?: AuthoritativeEnergyStateConfig;
  ledger: PhysicalEnergyLedger;
  observedState: TankState;
}): AuthoritativeEnergyState {
  const sensorGapKwh = Math.max(ledger.sensorCorrectionGapKwh, 0);
  const reasons = [...observedState.uncertainty.reasons];
  let quality: AuthoritativeEnergyQuality = observedState.quality;
  if (sensorGapKwh >= config.degradedSensorGapKwh && quality === "valid") {
    quality = "degraded";
    reasons.push("physical/sensor energy gap exceeds degraded threshold");
  }
  return {
    observedEnergyKwh: nonNegative(observedState.storedEnergy.kwh),
    observedUsableEnergyKwh: nonNegative(observedState.usableEnergy.kwh),
    quality,
    reasons: unique(reasons),
    remainingEnergyKwh: nonNegative(ledger.modeledStoredEnergyKwh),
    sensorGapKwh,
    timestamp: ledger.timestamp,
    uncertaintyKwh: nonNegative(observedState.uncertainty.energyKwh),
  };
}

function nonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}
function unique(values: string[]) {
  return [...new Set(values)];
}

import type { TankState, TankStateQuality } from "./energyModelCore";
import type { PhysicalEnergyLedger } from "./physicalEnergyLedger";

export type AuthoritativeEnergyQuality = TankStateQuality;

export type AuthoritativeEnergyState = {
  remainingEnergyKwh: number;
  observedEnergyKwh: number;
  observedUsableEnergyKwh: number;
  sensorGapKwh: number;
  quality: AuthoritativeEnergyQuality;
  uncertaintyKwh: number;
  reasons: string[];
  timestamp: string;
};

export type AuthoritativeEnergyStateConfig = { degradedSensorGapKwh: number };
export const defaultAuthoritativeEnergyStateConfig: AuthoritativeEnergyStateConfig = { degradedSensorGapKwh: 1.5 };

export function createAuthoritativeEnergyState({ config = defaultAuthoritativeEnergyStateConfig, ledger, observedState }: { config?: AuthoritativeEnergyStateConfig; ledger: PhysicalEnergyLedger; observedState: TankState }): AuthoritativeEnergyState {
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

function nonNegative(value: number) { return Number.isFinite(value) ? Math.max(value, 0) : 0; }
function unique(values: string[]) { return [...new Set(values)]; }

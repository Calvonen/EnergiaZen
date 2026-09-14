import type { TankState } from "./energyModelCore";
import {
  advancePhysicalEnergyLedger,
  createPhysicalEnergyLedger,
  type PhysicalEnergyLedger,
} from "./physicalEnergyLedger";

export function createLedgerFromTankState(state: TankState): PhysicalEnergyLedger | null {
  if (!state.timestamp || state.quality === "invalid") {
    return null;
  }

  return createPhysicalEnergyLedger({
    observedStoredEnergyKwh: state.storedEnergy.kwh,
    timestamp: state.timestamp,
  });
}

/**
 * Bridges the existing sensor-derived TankState to the V2 physical energy
 * ledger without changing TankState semantics yet.
 *
 * This is intentionally a one-way bridge: the current state remains an
 * observation, while the ledger conserves known heater input independently.
 * A later integration step can promote the ledger to the authoritative energy
 * state once accepted-removal and loss models have their replay coverage.
 */
export function advanceLedgerFromTankState({
  acceptedRemovalEnergyKwh = 0,
  deltaTimeMinutes,
  heaterPowerKwhPerHour,
  heating,
  modeledHeatLossKwh,
  observedState,
  previousLedger,
}: {
  acceptedRemovalEnergyKwh?: number;
  deltaTimeMinutes: number;
  heaterPowerKwhPerHour: number;
  heating: boolean;
  modeledHeatLossKwh: number;
  observedState: TankState;
  previousLedger: PhysicalEnergyLedger;
}): PhysicalEnergyLedger {
  return advancePhysicalEnergyLedger(previousLedger, {
    acceptedRemovalEnergyKwh,
    deltaHours: Math.max(deltaTimeMinutes, 0) / 60,
    heaterPowerKwhPerHour,
    heating,
    modeledHeatLossKwh,
    observedStoredEnergyKwh: observedState.storedEnergy.kwh,
    timestamp: observedState.timestamp ?? previousLedger.timestamp,
  });
}

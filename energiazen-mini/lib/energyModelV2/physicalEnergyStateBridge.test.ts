import {
  advanceState,
  calculateTankStateFromObservation,
  defaultEnergyModelCoreConfig,
} from "./energyModelCore";
import {
  advanceLedgerFromTankState,
  createLedgerFromTankState,
} from "./physicalEnergyStateBridge";
import { sensorGeometryV2 } from "./sensorGeometry";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

export function runPhysicalEnergyStateBridgeUnitTests() {
  const initial = calculateTankStateFromObservation({
    geometry: sensorGeometryV2,
    observation: {
      bottomTempC: 45,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-09-08T11:00:00.000Z",
      topTempC: 50,
    },
  });
  const initialLedger = createLedgerFromTankState(initial);
  assert(initialLedger !== null, "valid TankState creates a physical energy ledger");
  if (!initialLedger) return;

  // Reproduce the core failure mode: the heater has physically delivered
  // 1.0 kWh during 20 minutes, while the two sensors have only moved by 0.1 C.
  // The current TankState follows those observations; the V2 ledger must not
  // forget the known electrical energy input.
  const laggingSensorState = advanceState(
    initial,
    {
      bottomTempC: 45.1,
      heating: true,
      inletTempC: 12,
      timestamp: "2026-09-08T11:20:00.000Z",
      topTempC: 50.1,
    },
    20,
  );
  const afterTwentyMinutes = advanceLedgerFromTankState({
    deltaTimeMinutes: 20,
    heaterPowerKwhPerHour: defaultEnergyModelCoreConfig.heatingPowerKwhPerHour,
    heating: true,
    modeledHeatLossKwh: 0,
    observedState: laggingSensorState,
    previousLedger: initialLedger,
  });

  assertClose(
    afterTwentyMinutes.cumulativeDeliveredHeatingEnergyKwh,
    1,
    "20 minutes at 3 kW records exactly 1 kWh delivered energy",
  );
  assertClose(
    afterTwentyMinutes.modeledStoredEnergyKwh,
    initialLedger.modeledStoredEnergyKwh + 1,
    "lagging sensors cannot erase known heater input",
  );
  assert(
    afterTwentyMinutes.sensorCorrectionGapKwh > 0,
    "sensor lag is exposed as a positive model/observation gap",
  );

  const afterAcceptedDraw = advanceLedgerFromTankState({
    acceptedRemovalEnergyKwh: 0.7,
    deltaTimeMinutes: 5,
    heaterPowerKwhPerHour: defaultEnergyModelCoreConfig.heatingPowerKwhPerHour,
    heating: false,
    modeledHeatLossKwh: 0.02,
    observedState: {
      ...laggingSensorState,
      storedEnergy: {
        kwh: Math.max(afterTwentyMinutes.observedStoredEnergyKwh - 0.7, 0),
      },
      timestamp: "2026-09-08T11:25:00.000Z",
    },
    previousLedger: afterTwentyMinutes,
  });

  assertClose(
    afterAcceptedDraw.cumulativeAcceptedRemovalKwh,
    0.7,
    "accepted water-draw energy is tracked separately",
  );
  assert(
    afterAcceptedDraw.modeledStoredEnergyKwh < afterTwentyMinutes.modeledStoredEnergyKwh,
    "explicit accepted removal is allowed to reduce physical energy",
  );
}

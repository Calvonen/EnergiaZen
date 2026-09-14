import {
  advancePhysicalEnergyLedger,
  createPhysicalEnergyLedger,
} from "./physicalEnergyLedger";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

export function runPhysicalEnergyLedgerUnitTests() {
  const initial = createPhysicalEnergyLedger({
    observedStoredEnergyKwh: 8,
    timestamp: "2026-09-08T14:00:00.000+03:00",
  });

  const laggingSensorsDuringHeating = advancePhysicalEnergyLedger(initial, {
    deltaHours: 20 / 60,
    heaterPowerKwhPerHour: 3,
    heating: true,
    modeledHeatLossKwh: 0.05,
    observedStoredEnergyKwh: 8.1,
    timestamp: "2026-09-08T14:20:00.000+03:00",
  });

  assertClose(
    laggingSensorsDuringHeating.cumulativeDeliveredHeatingEnergyKwh,
    1,
    "20 minutes at 3 kW records one delivered kWh",
  );
  assertClose(
    laggingSensorsDuringHeating.modeledStoredEnergyKwh,
    8.95,
    "lagging sensor observation cannot erase delivered heater energy",
  );
  assert(
    laggingSensorsDuringHeating.sensorCorrectionGapKwh > 0,
    "sensor lag is exposed as an energy gap instead of silently overwriting the model",
  );

  const warmerObservation = advancePhysicalEnergyLedger(
    laggingSensorsDuringHeating,
    {
      deltaHours: 10 / 60,
      heaterPowerKwhPerHour: 3,
      heating: true,
      modeledHeatLossKwh: 0.02,
      observedStoredEnergyKwh: 9.7,
      timestamp: "2026-09-08T14:30:00.000+03:00",
    },
  );

  assertClose(
    warmerObservation.modeledStoredEnergyKwh,
    9.7,
    "warmer observation may raise modeled stored energy immediately",
  );
  assertClose(
    warmerObservation.sensorCorrectionGapKwh,
    0,
    "accepted warmer observation closes the sensor correction gap",
  );

  const afterValidatedDraw = advancePhysicalEnergyLedger(warmerObservation, {
    acceptedRemovalEnergyKwh: 1.5,
    deltaHours: 5 / 60,
    heaterPowerKwhPerHour: 3,
    heating: false,
    modeledHeatLossKwh: 0.01,
    observedStoredEnergyKwh: 8.05,
    timestamp: "2026-09-08T14:35:00.000+03:00",
  });

  assertClose(
    afterValidatedDraw.modeledStoredEnergyKwh,
    8.19,
    "validated removal lowers the physical balance only by accepted removal plus modeled loss",
  );
  assert(
    afterValidatedDraw.modeledStoredEnergyKwh > afterValidatedDraw.observedStoredEnergyKwh,
    "a colder sensor observation cannot erase additional unaccepted energy",
  );
  assertClose(
    afterValidatedDraw.cumulativeAcceptedRemovalKwh,
    1.5,
    "validated removal is recorded explicitly in the ledger",
  );

  const noHeatingRest = advancePhysicalEnergyLedger(afterValidatedDraw, {
    deltaHours: 1,
    heaterPowerKwhPerHour: 3,
    heating: false,
    modeledHeatLossKwh: 0.2,
    observedStoredEnergyKwh: 7.7,
    timestamp: "2026-09-08T15:35:00.000+03:00",
  });

  assertClose(
    noHeatingRest.modeledStoredEnergyKwh,
    7.99,
    "without accepted removal, ordinary cooling follows modeled loss instead of a larger unexplained sensor drop",
  );
  assertClose(
    noHeatingRest.cumulativeDeliveredHeatingEnergyKwh,
    1.5,
    "delivered heater energy remains cumulative across later states",
  );
}

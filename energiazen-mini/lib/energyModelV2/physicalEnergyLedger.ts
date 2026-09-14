export type PhysicalEnergyLedger = {
  cumulativeAcceptedRemovalKwh: number;
  cumulativeDeliveredHeatingEnergyKwh: number;
  cumulativeModeledHeatLossKwh: number;
  modeledStoredEnergyKwh: number;
  observedStoredEnergyKwh: number;
  sensorCorrectionGapKwh: number;
  timestamp: string;
};

export type PhysicalEnergyLedgerAdvance = {
  acceptedRemovalEnergyKwh?: number;
  deltaHours: number;
  heaterPowerKwhPerHour: number;
  heating: boolean;
  modeledHeatLossKwh: number;
  observedStoredEnergyKwh: number;
  timestamp: string;
};

export function createPhysicalEnergyLedger({
  observedStoredEnergyKwh,
  timestamp,
}: {
  observedStoredEnergyKwh: number;
  timestamp: string;
}): PhysicalEnergyLedger {
  const observed = nonNegative(observedStoredEnergyKwh);

  return {
    cumulativeAcceptedRemovalKwh: 0,
    cumulativeDeliveredHeatingEnergyKwh: 0,
    cumulativeModeledHeatLossKwh: 0,
    modeledStoredEnergyKwh: observed,
    observedStoredEnergyKwh: observed,
    sensorCorrectionGapKwh: 0,
    timestamp,
  };
}

/**
 * Advances the V2 physical energy balance independently from instantaneous
 * sensor temperatures.
 *
 * Known heater input is conserved. Downward movement is limited to explicit
 * physical terms: modeled heat loss and accepted removal energy. A sensor
 * observation may move modeled energy upward immediately, but a colder sensor
 * observation cannot silently remove more energy than those accepted terms.
 */
export function advancePhysicalEnergyLedger(
  previous: PhysicalEnergyLedger,
  input: PhysicalEnergyLedgerAdvance,
): PhysicalEnergyLedger {
  const deltaHours = nonNegative(input.deltaHours);
  const heaterPowerKwhPerHour = nonNegative(input.heaterPowerKwhPerHour);
  const modeledHeatLossKwh = nonNegative(input.modeledHeatLossKwh);
  const acceptedRemovalEnergyKwh = nonNegative(input.acceptedRemovalEnergyKwh ?? 0);
  const observedStoredEnergyKwh = nonNegative(input.observedStoredEnergyKwh);
  const deliveredHeatingEnergyKwh = input.heating
    ? heaterPowerKwhPerHour * deltaHours
    : 0;

  const predictedStoredEnergyKwh = nonNegative(
    previous.modeledStoredEnergyKwh +
      deliveredHeatingEnergyKwh -
      modeledHeatLossKwh -
      acceptedRemovalEnergyKwh,
  );

  // A warmer observation can reveal energy that the model underestimated.
  // A colder observation is diagnostic only: it may not erase additional
  // energy beyond the explicitly accepted loss/removal terms above.
  const modeledStoredEnergyKwh = Math.max(
    predictedStoredEnergyKwh,
    observedStoredEnergyKwh,
  );

  return {
    cumulativeAcceptedRemovalKwh:
      previous.cumulativeAcceptedRemovalKwh + acceptedRemovalEnergyKwh,
    cumulativeDeliveredHeatingEnergyKwh:
      previous.cumulativeDeliveredHeatingEnergyKwh + deliveredHeatingEnergyKwh,
    cumulativeModeledHeatLossKwh:
      previous.cumulativeModeledHeatLossKwh + modeledHeatLossKwh,
    modeledStoredEnergyKwh,
    observedStoredEnergyKwh,
    sensorCorrectionGapKwh: modeledStoredEnergyKwh - observedStoredEnergyKwh,
    timestamp: input.timestamp,
  };
}

function nonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

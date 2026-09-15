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
 * After the initial observation anchors the ledger, total modeled energy may
 * change only through explicit physical terms: heater input, modeled standing
 * loss, and accepted removal energy. Sensor observations remain diagnostic;
 * they neither erase known heater energy nor mint energy back into the ledger
 * after an accepted water draw.
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

  const modeledStoredEnergyKwh = nonNegative(
    previous.modeledStoredEnergyKwh +
      deliveredHeatingEnergyKwh -
      modeledHeatLossKwh -
      acceptedRemovalEnergyKwh,
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

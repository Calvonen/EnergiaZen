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
 * Known heater input is conserved. An observation may move modeled energy
 * upward immediately, but it cannot erase already-accounted heater energy
 * unless the caller supplies explicit acceptedRemovalEnergyKwh (for example
 * a validated water draw). This is intentionally stricter than V1's direct
 * sensor overwrite and provides the invariant required by V2-BUG-007.
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

  // Without explicit evidence of an energy-removing event, sensor lag,
  // stratification or mixing may not erase physically delivered heater
  // energy. A warmer-than-predicted observation is safe to accept because it
  // only reveals energy the model had underestimated.
  const modeledStoredEnergyKwh = acceptedRemovalEnergyKwh > 0
    ? observedStoredEnergyKwh
    : Math.max(predictedStoredEnergyKwh, observedStoredEnergyKwh);

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

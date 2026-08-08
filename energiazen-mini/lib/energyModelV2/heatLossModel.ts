export type HeatLossModelObservation = {
  energyLossKwhPerHour: number;
  storedEnergyStartKwh: number;
};

export type DiagnosticHeatLossModel = {
  interceptKwhPerHour: number;
  meanAbsoluteErrorKwhPerHour: number;
  observationCount: number;
  rootMeanSquaredErrorKwhPerHour: number;
  slopeKwhPerHourPerKwh: number;
};

/**
 * Fits the first diagnostic-only heat-loss model with ordinary least squares.
 * The input is deliberately the already accepted observation list; this model
 * is not used by EnergyModelCore or production forecasts.
 */
export function fitDiagnosticHeatLossModel(
  observations: HeatLossModelObservation[],
): DiagnosticHeatLossModel | null {
  const valid = observations.filter(({ energyLossKwhPerHour, storedEnergyStartKwh }) =>
    Number.isFinite(energyLossKwhPerHour) && Number.isFinite(storedEnergyStartKwh)
  );
  if (valid.length < 2) return null;

  const meanEnergy = average(valid.map(({ storedEnergyStartKwh }) => storedEnergyStartKwh));
  const meanLoss = average(valid.map(({ energyLossKwhPerHour }) => energyLossKwhPerHour));
  const energyVariance = valid.reduce(
    (sum, observation) => sum + (observation.storedEnergyStartKwh - meanEnergy) ** 2,
    0,
  );
  if (energyVariance <= Number.EPSILON) return null;

  const covariance = valid.reduce(
    (sum, observation) => sum +
      (observation.storedEnergyStartKwh - meanEnergy) *
      (observation.energyLossKwhPerHour - meanLoss),
    0,
  );
  const slopeKwhPerHourPerKwh = covariance / energyVariance;
  const interceptKwhPerHour = meanLoss - slopeKwhPerHourPerKwh * meanEnergy;
  const errors = valid.map((observation) =>
    interceptKwhPerHour + slopeKwhPerHourPerKwh * observation.storedEnergyStartKwh -
    observation.energyLossKwhPerHour
  );

  return {
    interceptKwhPerHour,
    meanAbsoluteErrorKwhPerHour: average(errors.map(Math.abs)),
    observationCount: valid.length,
    rootMeanSquaredErrorKwhPerHour: Math.sqrt(average(errors.map((error) => error ** 2))),
    slopeKwhPerHourPerKwh,
  };
}

export function predictDiagnosticHeatLoss(
  model: Pick<DiagnosticHeatLossModel, "interceptKwhPerHour" | "slopeKwhPerHourPerKwh">,
  storedEnergyKwh: number,
) {
  return model.interceptKwhPerHour + model.slopeKwhPerHourPerKwh * storedEnergyKwh;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

import { fitDiagnosticHeatLossModel, predictDiagnosticHeatLoss } from "./heatLossModel";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runHeatLossModelUnitTests() {
  assert(fitDiagnosticHeatLossModel([]) === null, "an empty accepted set does not produce a model");
  assert(
    fitDiagnosticHeatLossModel([
      { storedEnergyStartKwh: 5, energyLossKwhPerHour: 0.1 },
      { storedEnergyStartKwh: 5, energyLossKwhPerHour: 0.2 },
    ]) === null,
    "a model is not reported when the energy axis has no variation",
  );

  const model = fitDiagnosticHeatLossModel([
    { storedEnergyStartKwh: 2, energyLossKwhPerHour: 0.09 },
    { storedEnergyStartKwh: 6, energyLossKwhPerHour: 0.17 },
    { storedEnergyStartKwh: 10, energyLossKwhPerHour: 0.25 },
  ]);
  assert(model !== null, "varying accepted observations produce a model");
  assert(Math.abs(model!.interceptKwhPerHour - 0.05) < 1e-12, "intercept is fitted");
  assert(Math.abs(model!.slopeKwhPerHourPerKwh - 0.02) < 1e-12, "slope is fitted");
  assert(model!.observationCount === 3, "model reports its accepted observation count");
  assert(model!.meanAbsoluteErrorKwhPerHour < 1e-12, "MAE compares predicted and measured loss");
  assert(model!.rootMeanSquaredErrorKwhPerHour < 1e-12, "RMSE compares predicted and measured loss");
  assert(Math.abs(predictDiagnosticHeatLoss(model!, 8) - 0.21) < 1e-12, "prediction uses fitted parameters");
}

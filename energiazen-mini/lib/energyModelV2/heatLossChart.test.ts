import { getVisibleHeatLossTrendSegment } from "./heatLossChart";
import { predictDiagnosticHeatLoss } from "./heatLossModel";

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 1e-12) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

export function runHeatLossChartUnitTests() {
  const positiveModel = { interceptKwhPerHour: 0.05, slopeKwhPerHourPerKwh: 0.02 };
  const positive = getVisibleHeatLossTrendSegment(positiveModel, 2, 10)!;
  assertClose(positive.start.energyKwh, 2, "a positive fitted line retains its left endpoint");
  assertClose(positive.start.lossKwhPerHour, 0.09, "the left endpoint retains its prediction");
  assertClose(positive.end.energyKwh, 10, "a positive fitted line retains its right endpoint");
  assertClose(positive.end.lossKwhPerHour, 0.25, "the right endpoint retains its prediction");

  const risingModel = { interceptKwhPerHour: -0.1, slopeKwhPerHourPerKwh: 0.02 };
  const rising = getVisibleHeatLossTrendSegment(risingModel, 2, 10)!;
  assertClose(rising.start.energyKwh, 5, "a rising line starts at its true zero crossing");
  assertClose(rising.start.lossKwhPerHour, 0, "the rising zero crossing is on the axis");
  assertClose(rising.end.lossKwhPerHour, 0.1, "the positive rising endpoint is unchanged");

  const fallingModel = { interceptKwhPerHour: 0.2, slopeKwhPerHourPerKwh: -0.02 };
  const falling = getVisibleHeatLossTrendSegment(fallingModel, 2, 12)!;
  assertClose(falling.start.lossKwhPerHour, 0.16, "the positive falling endpoint is unchanged");
  assertClose(falling.end.energyKwh, 10, "a falling line ends at its true zero crossing");
  assertClose(falling.end.lossKwhPerHour, 0, "the falling zero crossing is on the axis");

  const intermediateEnergy = (rising.start.energyKwh + rising.end.energyKwh) / 2;
  const renderedIntermediateLoss =
    (rising.start.lossKwhPerHour + rising.end.lossKwhPerHour) / 2;
  assertClose(
    renderedIntermediateLoss,
    predictDiagnosticHeatLoss(risingModel, intermediateEnergy),
    "intermediate rendered values preserve the reported slope and intercept",
  );
}

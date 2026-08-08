import {
  predictDiagnosticHeatLoss,
  type DiagnosticHeatLossModel,
} from "./heatLossModel";

export type HeatLossTrendPoint = {
  energyKwh: number;
  lossKwhPerHour: number;
};

export type VisibleHeatLossTrendSegment = {
  end: HeatLossTrendPoint;
  start: HeatLossTrendPoint;
};

/** Returns the non-negative part of the fitted line without changing its slope. */
export function getVisibleHeatLossTrendSegment(
  model: Pick<DiagnosticHeatLossModel, "interceptKwhPerHour" | "slopeKwhPerHourPerKwh">,
  minimumEnergyKwh: number,
  maximumEnergyKwh: number,
): VisibleHeatLossTrendSegment | null {
  const minimumLoss = predictDiagnosticHeatLoss(model, minimumEnergyKwh);
  const maximumLoss = predictDiagnosticHeatLoss(model, maximumEnergyKwh);

  if (minimumLoss < 0 && maximumLoss < 0) return null;
  if (minimumLoss >= 0 && maximumLoss >= 0) {
    return {
      end: { energyKwh: maximumEnergyKwh, lossKwhPerHour: maximumLoss },
      start: { energyKwh: minimumEnergyKwh, lossKwhPerHour: minimumLoss },
    };
  }

  const energyZero = -model.interceptKwhPerHour / model.slopeKwhPerHourPerKwh;
  const zeroCrossing = { energyKwh: energyZero, lossKwhPerHour: 0 };
  return minimumLoss < 0
    ? {
        end: { energyKwh: maximumEnergyKwh, lossKwhPerHour: maximumLoss },
        start: zeroCrossing,
      }
    : {
        end: zeroCrossing,
        start: { energyKwh: minimumEnergyKwh, lossKwhPerHour: minimumLoss },
      };
}

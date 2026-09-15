import { forecastEnergyHorizon } from "./energyForecast";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

export function runEnergyForecastUnitTests() {
  const noHeating = forecastEnergyHorizon({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 8,
    initialUncertaintyKwh: 0.25,
    segments: [
      {
        heatingSelected: false,
        id: "h1",
        modeledHeatLossKwh: 0.2,
        segmentHours: 1,
        startDate: "2026-09-15T06:00:00.000Z",
      },
      {
        heatingSelected: false,
        id: "h2",
        modeledHeatLossKwh: 0.2,
        segmentHours: 1,
        startDate: "2026-09-15T07:00:00.000Z",
      },
    ],
  });

  assertClose(noHeating.finalRemainingEnergyKwh, 7.6, "standing loss reduces physical energy");
  assertClose(noHeating.finalConservativeEnergyKwh, 7.35, "initial uncertainty is conserved");
  assert(noHeating.firstSafetyViolationAt === null, "healthy reserve stays above safety");

  const oneHeatingHour = forecastEnergyHorizon({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 4,
    initialUncertaintyKwh: 0.25,
    segments: [
      {
        heatingSelected: true,
        id: "heat",
        modeledHeatLossKwh: 0.2,
        segmentHours: 1,
        startDate: "2026-09-15T06:00:00.000Z",
      },
    ],
  });

  assertClose(oneHeatingHour.points[0].deliveredHeatingEnergyKwh, 3, "one selected hour credits 3 kWh");
  assertClose(oneHeatingHour.finalRemainingEnergyKwh, 6.8, "heater input and loss reconcile in kWh");
  assert(oneHeatingHour.points[0].bandAfter === "target_met", "one hour can restore target reserve");

  const partialCurrentHour = forecastEnergyHorizon({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 5,
    initialUncertaintyKwh: 0,
    segments: [
      {
        heatingSelected: true,
        id: "partial",
        modeledHeatLossKwh: 0.05,
        segmentHours: 0.25,
        startDate: "2026-09-15T06:45:00.000Z",
      },
    ],
  });

  assertClose(partialCurrentHour.points[0].deliveredHeatingEnergyKwh, 0.75, "partial current hour credits only remaining duration");
  assertClose(partialCurrentHour.finalRemainingEnergyKwh, 5.7, "partial-hour balance is physical");

  const explicitRemoval = forecastEnergyHorizon({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 7,
    initialUncertaintyKwh: 0.25,
    segments: [
      {
        acceptedRemovalKwh: 1.5,
        heatingSelected: false,
        id: "draw",
        modeledHeatLossKwh: 0.1,
        segmentHours: 1,
        startDate: "2026-09-15T06:00:00.000Z",
      },
    ],
  });

  assertClose(explicitRemoval.finalRemainingEnergyKwh, 5.4, "accepted draw is removed exactly once");
  assert(explicitRemoval.points[0].bandAfter === "recovery", "post-draw reserve can enter recovery band");

  const safetyCrossing = forecastEnergyHorizon({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 3.4,
    initialUncertaintyKwh: 0.25,
    segments: [
      {
        heatingSelected: false,
        id: "safe",
        modeledHeatLossKwh: 0.1,
        segmentHours: 1,
        startDate: "2026-09-15T06:00:00.000Z",
      },
      {
        heatingSelected: false,
        id: "unsafe",
        modeledHeatLossKwh: 0.2,
        segmentHours: 1,
        startDate: "2026-09-15T07:00:00.000Z",
      },
    ],
  });

  assert(safetyCrossing.firstSafetyViolationAt === "2026-09-15T07:00:00.000Z", "first safety crossing is timestamped");
  assertClose(safetyCrossing.minimumConservativeEnergyKwh, 2.85, "minimum conservative reserve is persisted");

  const uncertaintyGrowth = forecastEnergyHorizon({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 6.5,
    initialUncertaintyKwh: 0.25,
    segments: [
      {
        additionalUncertaintyKwh: 0.5,
        heatingSelected: false,
        id: "uncertain",
        modeledHeatLossKwh: 0,
        segmentHours: 1,
        startDate: "2026-09-15T06:00:00.000Z",
      },
    ],
  });

  assertClose(uncertaintyGrowth.points[0].uncertaintyAfterKwh, 0.75, "forecast uncertainty accumulates separately from physical energy");
  assertClose(uncertaintyGrowth.finalRemainingEnergyKwh, 6.5, "uncertainty cannot delete physical energy");
}

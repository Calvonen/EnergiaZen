import {
  calculateV2EnergyCapacityKwh,
  normalizeV2ReservePercents,
  recommendedV2PreheatPercent,
  reserveKwhToPercent,
  reservePercentToKwh,
} from "./energyReservePercent";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number | null, expected: number, tolerance: number, message: string) {
  if (actual === null || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${expected}, got ${String(actual)}`);
  }
}

export function runEnergyReservePercentUnitTests() {
  const capacity = calculateV2EnergyCapacityKwh({
    inletTemperatureC: 15,
    maxTankTemperatureC: 65,
    tankVolumeLiters: 290,
  });
  assertClose(capacity, 16.864, 0.001, "290 l tank capacity from 15 C to 65 C");

  const calibratedCapacity = calculateV2EnergyCapacityKwh({
    inletTemperatureC: 15,
    maxTankTemperatureC: 65,
    fullTankAverageTemperatureC: 59,
    tankVolumeLiters: 290,
  });
  assertClose(
    calibratedCapacity,
    14.841,
    0.001,
    "calibrated 59 C full-tank temperature defines practical 100 percent capacity",
  );

  const invalidCalibrationFallsBack = calculateV2EnergyCapacityKwh({
    inletTemperatureC: 15,
    maxTankTemperatureC: 65,
    fullTankAverageTemperatureC: 70,
    tankVolumeLiters: 290,
  });
  assertClose(
    invalidCalibrationFallsBack,
    capacity as number,
    0.001,
    "calibration above configured max falls back to theoretical max-temperature capacity",
  );
  assertClose(reservePercentToKwh(90, capacity as number), 15.178, 0.001, "90 percent preheat recommendation converts to kWh");
  assertClose(reservePercentToKwh(30, capacity as number), 5.059, 0.001, "30 percent safety converts to kWh");
  assertClose(reserveKwhToPercent(12.648, capacity as number), 75, 0.01, "kWh converts back to percent");
  assertClose(
    reserveKwhToPercent((calibratedCapacity as number) * 1.04, calibratedCapacity as number),
    104,
    0.01,
    "reserve above calibrated full remains visible above 100 percent",
  );
  assert(recommendedV2PreheatPercent === 90, "default soft preheat recommendation is 90 percent");

  const defaults = normalizeV2ReservePercents({});
  assert(defaults.targetPercent === 90, "missing preheat recommendation defaults to 90 percent");
  assert(defaults.safetyPercent === 30, "missing safety reserve defaults to 30 percent");

  const rounded = normalizeV2ReservePercents({ targetPercent: 83, safetyPercent: 32 });
  assert(rounded.targetPercent === 85, "preheat recommendation rounds to nearest 5 percent");
  assert(rounded.safetyPercent === 30, "safety rounds to nearest 5 percent");

  const ordered = normalizeV2ReservePercents({ targetPercent: 70, safetyPercent: 95 });
  assert(ordered.targetPercent === 95, "shared normalization raises target to preserve an inverted safety floor");
  assert(ordered.safetyPercent === 95, "shared normalization never lowers the configured safety floor");

  const boundedLow = normalizeV2ReservePercents({ targetPercent: -20, safetyPercent: -10 });
  assert(boundedLow.targetPercent === 70, "preheat recommendation is clamped to the 70 percent UI minimum");
  assert(boundedLow.safetyPercent === 0, "safety is clamped to the database/UI minimum");

  const boundedHigh = normalizeV2ReservePercents({ targetPercent: 130, safetyPercent: 130 });
  assert(boundedHigh.targetPercent === 95, "preheat recommendation is capped at the 95 percent UI maximum");
  assert(boundedHigh.safetyPercent === 95, "safety is clamped to the database/UI maximum");

  assert(
    calculateV2EnergyCapacityKwh({ inletTemperatureC: 65, maxTankTemperatureC: 65, tankVolumeLiters: 290 }) === null,
    "non-positive temperature range fails closed",
  );
}

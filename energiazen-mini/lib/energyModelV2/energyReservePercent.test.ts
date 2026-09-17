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
  assertClose(reservePercentToKwh(75, capacity as number), 12.648, 0.001, "75 percent legacy target converts to kWh");
  assertClose(reservePercentToKwh(30, capacity as number), 5.059, 0.001, "30 percent safety converts to kWh");
  assertClose(reserveKwhToPercent(12.648, capacity as number), 75, 0.01, "kWh converts back to percent");
  assert(recommendedV2PreheatPercent === 90, "soft preheat recommendation is 90 percent");

  const rounded = normalizeV2ReservePercents({ targetPercent: 73, safetyPercent: 32 });
  assert(rounded.targetPercent === 75, "legacy target rounds to nearest 5 percent");
  assert(rounded.safetyPercent === 30, "safety rounds to nearest 5 percent");

  const independent = normalizeV2ReservePercents({ targetPercent: 40, safetyPercent: 65 });
  assert(independent.targetPercent === 40, "legacy target stays at configured normalized value");
  assert(independent.safetyPercent === 65, "safety is independent from hidden legacy target");

  const boundedLow = normalizeV2ReservePercents({ targetPercent: -20, safetyPercent: -10 });
  assert(boundedLow.targetPercent === 5, "legacy target is clamped to the database/UI minimum");
  assert(boundedLow.safetyPercent === 0, "safety is clamped to the database/UI minimum");

  const boundedHigh = normalizeV2ReservePercents({ targetPercent: 130, safetyPercent: 130 });
  assert(boundedHigh.targetPercent === 95, "legacy target is capped below the displayed physical-full state");
  assert(boundedHigh.safetyPercent === 95, "safety is clamped to the database/UI maximum");

  assert(
    calculateV2EnergyCapacityKwh({ inletTemperatureC: 65, maxTankTemperatureC: 65, tankVolumeLiters: 290 }) === null,
    "non-positive temperature range fails closed",
  );
}

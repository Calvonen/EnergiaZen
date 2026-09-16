"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runEnergyReservePercentUnitTests = runEnergyReservePercentUnitTests;
const energyReservePercent_1 = require("./energyReservePercent");
function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
function assertClose(actual, expected, tolerance, message) {
    if (actual === null || Math.abs(actual - expected) > tolerance) {
        throw new Error(`${message}: expected ${expected}, got ${String(actual)}`);
    }
}
function runEnergyReservePercentUnitTests() {
    const capacity = (0, energyReservePercent_1.calculateV2EnergyCapacityKwh)({
        inletTemperatureC: 15,
        maxTankTemperatureC: 65,
        tankVolumeLiters: 290,
    });
    assertClose(capacity, 16.864, 0.001, "290 l tank capacity from 15 C to 65 C");
    assertClose((0, energyReservePercent_1.reservePercentToKwh)(75, capacity), 12.648, 0.001, "75 percent target converts to kWh");
    assertClose((0, energyReservePercent_1.reservePercentToKwh)(30, capacity), 5.059, 0.001, "30 percent safety converts to kWh");
    assertClose((0, energyReservePercent_1.reserveKwhToPercent)(12.648, capacity), 75, 0.01, "kWh converts back to percent");
    const rounded = (0, energyReservePercent_1.normalizeV2ReservePercents)({ targetPercent: 73, safetyPercent: 32 });
    assert(rounded.targetPercent === 75, "target rounds to nearest 5 percent");
    assert(rounded.safetyPercent === 30, "safety rounds to nearest 5 percent");
    const ordered = (0, energyReservePercent_1.normalizeV2ReservePercents)({ targetPercent: 40, safetyPercent: 65 });
    assert(ordered.targetPercent === 40, "target stays at configured normalized value");
    assert(ordered.safetyPercent === 40, "safety is capped to target");
    const boundedLow = (0, energyReservePercent_1.normalizeV2ReservePercents)({ targetPercent: -20, safetyPercent: -10 });
    assert(boundedLow.targetPercent === 5, "target is clamped to the database/UI minimum");
    assert(boundedLow.safetyPercent === 0, "safety is clamped to the database/UI minimum");
    const boundedHigh = (0, energyReservePercent_1.normalizeV2ReservePercents)({ targetPercent: 130, safetyPercent: 130 });
    assert(boundedHigh.targetPercent === 95, "target is capped below the displayed physical-full state");
    assert(boundedHigh.safetyPercent === 95, "safety is clamped to the database/UI maximum");
    assert((0, energyReservePercent_1.calculateV2EnergyCapacityKwh)({ inletTemperatureC: 65, maxTankTemperatureC: 65, tankVolumeLiters: 290 }) === null, "non-positive temperature range fails closed");
}

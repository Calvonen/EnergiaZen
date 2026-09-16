"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.maxV2SafetyReservePercent = exports.minV2SafetyReservePercent = exports.maxV2TargetReservePercent = exports.minV2TargetReservePercent = exports.defaultWaterSpecificHeatKwhPerKgC = exports.defaultV2ReservePercents = void 0;
exports.calculateV2EnergyCapacityKwh = calculateV2EnergyCapacityKwh;
exports.reservePercentToKwh = reservePercentToKwh;
exports.reserveKwhToPercent = reserveKwhToPercent;
exports.normalizeV2ReservePercents = normalizeV2ReservePercents;
exports.defaultV2ReservePercents = {
    safetyPercent: 30,
    targetPercent: 75,
};
exports.defaultWaterSpecificHeatKwhPerKgC = 0.001163;
exports.minV2TargetReservePercent = 5;
exports.maxV2TargetReservePercent = 95;
exports.minV2SafetyReservePercent = 0;
exports.maxV2SafetyReservePercent = 95;
function calculateV2EnergyCapacityKwh({ inletTemperatureC, maxTankTemperatureC, tankVolumeLiters, specificHeatKwhPerKgC = exports.defaultWaterSpecificHeatKwhPerKgC, }) {
    if (!Number.isFinite(inletTemperatureC) ||
        !Number.isFinite(maxTankTemperatureC) ||
        !Number.isFinite(tankVolumeLiters) ||
        !Number.isFinite(specificHeatKwhPerKgC) ||
        maxTankTemperatureC <= inletTemperatureC ||
        tankVolumeLiters <= 0 ||
        specificHeatKwhPerKgC <= 0) {
        return null;
    }
    return round(tankVolumeLiters *
        specificHeatKwhPerKgC *
        (maxTankTemperatureC - inletTemperatureC));
}
function reservePercentToKwh(percent, capacityKwh) {
    if (!Number.isFinite(percent) || !Number.isFinite(capacityKwh) || capacityKwh < 0) {
        return null;
    }
    return round(capacityKwh * clamp(percent, 0, 100) / 100);
}
function reserveKwhToPercent(kwh, capacityKwh) {
    if (!Number.isFinite(kwh) || !Number.isFinite(capacityKwh) || capacityKwh <= 0) {
        return null;
    }
    return round(clamp(kwh / capacityKwh * 100, 0, 100));
}
function normalizeV2ReservePercents({ safetyPercent, targetPercent, }) {
    const target = clampAndRoundPercent(targetPercent, exports.defaultV2ReservePercents.targetPercent, exports.minV2TargetReservePercent, exports.maxV2TargetReservePercent);
    const safety = Math.min(clampAndRoundPercent(safetyPercent, exports.defaultV2ReservePercents.safetyPercent, exports.minV2SafetyReservePercent, exports.maxV2SafetyReservePercent), target);
    return { safetyPercent: safety, targetPercent: target };
}
function clampAndRoundPercent(value, fallback, min, max) {
    const normalized = Number.isFinite(value) ? value : fallback;
    return Math.round(clamp(normalized, min, max) / 5) * 5;
}
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function round(value) {
    return Math.round(value * 1000) / 1000;
}

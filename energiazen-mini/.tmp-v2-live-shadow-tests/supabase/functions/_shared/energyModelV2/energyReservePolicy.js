"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultEnergyReserveThresholds = exports.defaultEnergyReserveCalibration = void 0;
exports.calibrateEnergyReserveThresholds = calibrateEnergyReserveThresholds;
exports.evaluateEnergyReserve = evaluateEnergyReserve;
exports.defaultEnergyReserveCalibration = {
    // Production water-draw snapshot 2026-09-14: 43 reliable events,
    // p95 = 2.0510027 kWh. This deliberately does not use shower counts.
    heaterPowerKw: 3,
    marginKwh: 0.5,
    p95WaterDrawKwh: 2.0510027,
    sampleCount: 43,
    targetHeatingHours: 1,
    thresholdStepKwh: 0.5,
};
function calibrateEnergyReserveThresholds(calibration) {
    const step = positive(calibration.thresholdStepKwh, 0.5);
    const safetyEnergyKwh = roundUpToStep(nonNegative(calibration.p95WaterDrawKwh) + nonNegative(calibration.marginKwh), step);
    const recoveryEnergyKwh = nonNegative(calibration.heaterPowerKw) * nonNegative(calibration.targetHeatingHours);
    return {
        safetyEnergyKwh,
        targetEnergyKwh: roundUpToStep(safetyEnergyKwh + recoveryEnergyKwh, step),
    };
}
exports.defaultEnergyReserveThresholds = calibrateEnergyReserveThresholds(exports.defaultEnergyReserveCalibration);
/**
 * Evaluates V2 reserve state only in physical energy units.
 * Invalid authoritative state fails closed and produces no control decision.
 */
function evaluateEnergyReserve(state, thresholds = exports.defaultEnergyReserveThresholds) {
    const normalizedThresholds = normalizeThresholds(thresholds);
    const conservativeEnergyKwh = Math.max(nonNegative(state.remainingEnergyKwh) - nonNegative(state.uncertaintyKwh), 0);
    if (state.quality === "invalid") {
        return {
            band: "invalid",
            conservativeEnergyKwh,
            needsEnergyRecovery: null,
            safetySatisfied: null,
            targetSatisfied: null,
            thresholds: normalizedThresholds,
        };
    }
    if (conservativeEnergyKwh < normalizedThresholds.safetyEnergyKwh) {
        return {
            band: "below_safety",
            conservativeEnergyKwh,
            needsEnergyRecovery: true,
            safetySatisfied: false,
            targetSatisfied: false,
            thresholds: normalizedThresholds,
        };
    }
    if (conservativeEnergyKwh < normalizedThresholds.targetEnergyKwh) {
        return {
            band: "recovery",
            conservativeEnergyKwh,
            needsEnergyRecovery: true,
            safetySatisfied: true,
            targetSatisfied: false,
            thresholds: normalizedThresholds,
        };
    }
    return {
        band: "target_met",
        conservativeEnergyKwh,
        needsEnergyRecovery: false,
        safetySatisfied: true,
        targetSatisfied: true,
        thresholds: normalizedThresholds,
    };
}
function normalizeThresholds(thresholds) {
    const safetyEnergyKwh = nonNegative(thresholds.safetyEnergyKwh);
    return {
        safetyEnergyKwh,
        targetEnergyKwh: Math.max(nonNegative(thresholds.targetEnergyKwh), safetyEnergyKwh),
    };
}
function roundUpToStep(value, step) {
    return Math.ceil(value / step - 1e-12) * step;
}
function nonNegative(value) {
    return Number.isFinite(value) ? Math.max(value, 0) : 0;
}
function positive(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

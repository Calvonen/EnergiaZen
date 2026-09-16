"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forecastEnergyHorizon = forecastEnergyHorizon;
const energyReservePolicy_ts_1 = require("./energyReservePolicy.js");
function forecastEnergyHorizon({ energyCapacityKwh, heaterPowerKw, initialRemainingEnergyKwh, initialUncertaintyKwh, segments, thresholds = energyReservePolicy_ts_1.defaultEnergyReserveThresholds, }) {
    const physicalCapacityKwh = positiveOrInfinity(energyCapacityKwh);
    const initialEnergyKwh = nonNegative(initialRemainingEnergyKwh);
    const initialConservativeEnergyKwh = Math.max(initialEnergyKwh - nonNegative(initialUncertaintyKwh), 0);
    let remainingEnergyKwh = Math.min(initialEnergyKwh, physicalCapacityKwh);
    // If the nominal ledger exceeds physical capacity, clip its uncertainty by
    // the same overflow. This preserves the already-computed conservative lower
    // bound instead of effectively subtracting delivery uncertainty twice.
    let uncertaintyKwh = Math.max(remainingEnergyKwh - Math.min(initialConservativeEnergyKwh, physicalCapacityKwh), 0);
    let minimumConservativeEnergyKwh = Math.max(remainingEnergyKwh - uncertaintyKwh, 0);
    let firstSafetyViolationAt = null;
    let firstTargetMissAt = null;
    const points = segments.map((segment) => {
        const segmentHours = clamp(segment.segmentHours, 0, 1);
        const deliveredHeatingEnergyKwh = segment.heatingSelected
            ? nonNegative(heaterPowerKw) * segmentHours
            : 0;
        const modeledHeatLossKwh = nonNegative(segment.modeledHeatLossKwh);
        const acceptedRemovalKwh = nonNegative(segment.acceptedRemovalKwh ?? 0);
        const remainingEnergyBeforeKwh = remainingEnergyKwh;
        const energyDeltaKwh = deliveredHeatingEnergyKwh - modeledHeatLossKwh - acceptedRemovalKwh;
        const conservativeEnergyBeforeKwh = Math.max(remainingEnergyKwh - uncertaintyKwh, 0);
        const conservativeEnergyAfterKwh = clamp(conservativeEnergyBeforeKwh +
            energyDeltaKwh -
            nonNegative(segment.additionalUncertaintyKwh ?? 0), 0, physicalCapacityKwh);
        remainingEnergyKwh = clamp(remainingEnergyKwh + energyDeltaKwh, 0, physicalCapacityKwh);
        // Saturation clips the nominal and conservative endpoints independently.
        // Deriving uncertainty from those bounded endpoints prevents heater energy
        // above physical capacity from being counted as uncertainty a second time.
        uncertaintyKwh = Math.max(remainingEnergyKwh - conservativeEnergyAfterKwh, 0);
        const reserve = (0, energyReservePolicy_ts_1.evaluateEnergyReserve)({
            quality: "valid",
            remainingEnergyKwh,
            uncertaintyKwh,
        }, thresholds);
        minimumConservativeEnergyKwh = Math.min(minimumConservativeEnergyKwh, reserve.conservativeEnergyKwh);
        if (!reserve.safetySatisfied && firstSafetyViolationAt === null) {
            firstSafetyViolationAt = segment.startDate;
        }
        if (!reserve.targetSatisfied && firstTargetMissAt === null) {
            firstTargetMissAt = segment.startDate;
        }
        return {
            acceptedRemovalKwh: round(acceptedRemovalKwh),
            bandAfter: reserve.band,
            conservativeEnergyAfterKwh: round(reserve.conservativeEnergyKwh),
            deliveredHeatingEnergyKwh: round(deliveredHeatingEnergyKwh),
            heatingSelected: segment.heatingSelected,
            id: segment.id,
            modeledHeatLossKwh: round(modeledHeatLossKwh),
            remainingEnergyAfterKwh: round(remainingEnergyKwh),
            remainingEnergyBeforeKwh: round(remainingEnergyBeforeKwh),
            segmentHours: round(segmentHours),
            startDate: segment.startDate,
            uncertaintyAfterKwh: round(uncertaintyKwh),
        };
    });
    const finalReserve = (0, energyReservePolicy_ts_1.evaluateEnergyReserve)({
        quality: "valid",
        remainingEnergyKwh,
        uncertaintyKwh,
    }, thresholds);
    return {
        finalConservativeEnergyKwh: round(finalReserve.conservativeEnergyKwh),
        finalRemainingEnergyKwh: round(remainingEnergyKwh),
        firstSafetyViolationAt,
        firstTargetMissAt,
        minimumConservativeEnergyKwh: round(minimumConservativeEnergyKwh),
        points,
        thresholds: finalReserve.thresholds,
    };
}
function nonNegative(value) {
    return Number.isFinite(value) ? Math.max(value, 0) : 0;
}
function positiveOrInfinity(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : Number.POSITIVE_INFINITY;
}
function clamp(value, minimum, maximum) {
    if (!Number.isFinite(value))
        return minimum;
    return Math.min(Math.max(value, minimum), maximum);
}
function round(value) {
    return Math.round(value * 1000) / 1000;
}

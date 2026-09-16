"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveReserveShadowConfig = void 0;
exports.deriveUsableReadingInletBaselineC = deriveUsableReadingInletBaselineC;
exports.applyReserveThresholds = applyReserveThresholds;
exports.runLiveReserveShadow = runLiveReserveShadow;
const sensorGeometry_ts_1 = require("../_shared/energyModelV2/sensorGeometry.js");
const energyReservePolicy_ts_1 = require("../_shared/energyModelV2/energyReservePolicy.js");
const energyReserveShadow_ts_1 = require("../_shared/energyModelV2/energyReserveShadow.js");
const tankReadingFreshness_ts_1 = require("../_shared/tankReadingFreshness.js");
const liveWaterDrawReanchor_ts_1 = require("./liveWaterDrawReanchor.js");
exports.liveReserveShadowConfig = {
    heaterPowerKw: 3,
    ambientTempC: 21,
    topHeatLossTimeConstantHours: 96,
    bottomHeatLossTimeConstantHours: 120,
    specificHeatKwhPerKgC: 0.001163,
    baselineBalanceUncertaintyKwh: 0.25,
    maxReadingGapMinutes: 15,
    heaterGuardMarginC: 2,
};
function deriveUsableReadingInletBaselineC(readings) {
    const usableReadings = readings.filter(isUsableReading);
    return usableReadings.length > 0
        ? Math.min(...usableReadings.map((reading) => reading.inlet_temp))
        : null;
}
function applyReserveThresholds(baseResult, safetyEnergyKwh, targetEnergyKwh) {
    if (safetyEnergyKwh === null || targetEnergyKwh === null) {
        return {
            ...baseResult,
            available: false,
            reason: "v2_percent_thresholds_unavailable",
            safetyEnergyKwh: safetyEnergyKwh ?? baseResult.safetyEnergyKwh,
            targetEnergyKwh: targetEnergyKwh ?? baseResult.targetEnergyKwh,
            v2Band: "invalid",
            v2NeedsEnergyRecovery: null,
        };
    }
    if (!baseResult.available || baseResult.remainingEnergyKwh === null) {
        return { ...baseResult, safetyEnergyKwh, targetEnergyKwh };
    }
    const decision = (0, energyReservePolicy_ts_1.evaluateEnergyReserve)({
        quality: "valid",
        remainingEnergyKwh: baseResult.remainingEnergyKwh,
        uncertaintyKwh: baseResult.balanceUncertaintyKwh,
    }, { safetyEnergyKwh, targetEnergyKwh });
    return {
        ...baseResult,
        conservativeEnergyKwh: decision.conservativeEnergyKwh,
        safetyEnergyKwh: decision.thresholds.safetyEnergyKwh,
        targetEnergyKwh: decision.thresholds.targetEnergyKwh,
        v2Band: decision.band,
        v2NeedsEnergyRecovery: decision.needsEnergyRecovery,
    };
}
function runLiveReserveShadow({ maxTankTemperatureC, now, readings, reliableDraws, v1Shadow, }) {
    const ordered = readings
        .filter(isUsableReading)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    // This optional comparison remains useful for isolated unit-level experiments
    // where the caller can supply a semantically equivalent current-state V1
    // boolean. Production live-shadow deliberately passes null because V1's
    // persisted target_hours is a planning-horizon output, not such a boolean.
    const v1NeedsEnergyRecovery = v1Shadow === null ? null : Math.max(v1Shadow.target_hours ?? 0, 0) > 0;
    const heaterCreditGuardTopTempC = Number.isFinite(maxTankTemperatureC) && maxTankTemperatureC > exports.liveReserveShadowConfig.heaterGuardMarginC
        ? maxTankTemperatureC - exports.liveReserveShadowConfig.heaterGuardMarginC
        : null;
    if (heaterCreditGuardTopTempC === null) {
        return unavailable("invalid_max_tank_temperature", ordered.length, 0, false, v1NeedsEnergyRecovery, null);
    }
    if (ordered.length < 2) {
        return unavailable("insufficient_tank_readings", ordered.length, 0, false, v1NeedsEnergyRecovery, heaterCreditGuardTopTempC);
    }
    const latest = ordered[ordered.length - 1];
    if (!(0, tankReadingFreshness_ts_1.isTankReadingFreshForCalculation)(latest.created_at, now)) {
        return unavailable("latest_tank_reading_stale", ordered.length, 0, false, v1NeedsEnergyRecovery, heaterCreditGuardTopTempC);
    }
    // `ordered` is the authoritative replay input. Derive the baseline from it so
    // reserve energy and percentage capacity always use identical observations.
    const inletBaseline = deriveUsableReadingInletBaselineC(ordered);
    const draws = reliableDraws.filter(isReliableDraw);
    const drawResolution = (0, liveWaterDrawReanchor_ts_1.resolveLiveDrawReanchors)({
        coldInletBaselineC: inletBaseline,
        readings: ordered,
        reliableDraws: draws,
    });
    if (drawResolution.unresolved) {
        return unavailable("unresolved_water_draw_detected", ordered.length, draws.length, true, v1NeedsEnergyRecovery, heaterCreditGuardTopTempC);
    }
    const reanchorIndexes = new Set(drawResolution.reanchorIndexes);
    // The first observation anchors this finite replay window. After that point,
    // sensors are diagnostic except when we explicitly re-anchor. A recovered
    // water draw creates one kind of conservative physical anchor. A telemetry
    // gap longer than maxReadingGapMinutes creates another: the post-gap measured
    // state is safer than either guessing relay/draw activity inside the blind
    // interval or poisoning the complete six-hour replay until that gap ages out.
    let remainingEnergyKwh = observedStoredEnergyKwh(ordered[0], inletBaseline);
    let heaterDeliveryUncertaintyKwh = 0;
    for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        const previousMs = Date.parse(previous.created_at);
        const currentMs = Date.parse(current.created_at);
        const deltaHours = Math.max((currentMs - previousMs) / 3600000, 0);
        const gapMinutes = deltaHours * 60;
        if (gapMinutes > exports.liveReserveShadowConfig.maxReadingGapMinutes) {
            remainingEnergyKwh = observedStoredEnergyKwh(current, inletBaseline);
            // Nothing inside the blind interval is credited. The first trustworthy
            // post-gap sensor observation becomes a fresh physical anchor, so any
            // pre-gap heater-delivery uncertainty no longer propagates forward.
            heaterDeliveryUncertaintyKwh = 0;
            continue;
        }
        const deliveredEnergyKwh = previous.heating === true
            ? exports.liveReserveShadowConfig.heaterPowerKw * deltaHours
            : 0;
        // tank_readings.heating is a boolean state, not power telemetry. A true->
        // false transition means the exact switch-off instant inside the sampling
        // interval is unknown. Likewise, close to the configured upper tank limit
        // the mechanical thermostat may interrupt the element even if the relay
        // state still looks on. Keep nominal energy in the ledger, but subtract the
        // whole potentially unconfirmed interval from safety via uncertainty.
        if (deliveredEnergyKwh > 0 &&
            (current.heating !== true ||
                Math.max(previous.top_temp, current.top_temp) >=
                    heaterCreditGuardTopTempC)) {
            heaterDeliveryUncertaintyKwh += deliveredEnergyKwh;
        }
        const modeledHeatLossKwh = estimateHeatLossKwh(previous, inletBaseline, deltaHours);
        const acceptedRemovalKwh = draws.reduce((sum, draw) => {
            const endedAt = Date.parse(draw.event_ended_at);
            if (endedAt > previousMs && endedAt <= currentMs) {
                return sum + draw.estimated_water_draw_net_energy_kwh;
            }
            return sum;
        }, 0);
        remainingEnergyKwh = Math.max(remainingEnergyKwh + deliveredEnergyKwh - modeledHeatLossKwh - acceptedRemovalKwh, 0);
        if (reanchorIndexes.has(index)) {
            remainingEnergyKwh = observedStoredEnergyKwh(current, inletBaseline);
            // The measured post-draw state becomes a new conservative physical
            // anchor, so uncertainty about heater delivery before that anchor no
            // longer affects the forward balance.
            heaterDeliveryUncertaintyKwh = 0;
        }
    }
    const observedEnergyKwh = observedStoredEnergyKwh(latest, inletBaseline);
    const sensorGapKwh = remainingEnergyKwh - observedEnergyKwh;
    // Sensor/model disagreement is diagnostic. Safety subtracts only uncertainty
    // in the physical balance itself: baseline model uncertainty plus heater
    // energy that cannot be proven from the boolean relay samples.
    const balanceUncertaintyKwh = exports.liveReserveShadowConfig.baselineBalanceUncertaintyKwh + heaterDeliveryUncertaintyKwh;
    const v2Decision = (0, energyReservePolicy_ts_1.evaluateEnergyReserve)({
        quality: "valid",
        remainingEnergyKwh,
        uncertaintyKwh: balanceUncertaintyKwh,
    });
    const v2NeedsEnergyRecovery = v2Decision.needsEnergyRecovery;
    const comparison = v1NeedsEnergyRecovery === null
        ? "v1_unavailable"
        : (0, energyReserveShadow_ts_1.compareEnergyReserveShadow)({
            v1NeedsEnergyRecovery,
            v2Decision,
        }).classification;
    return {
        available: v2NeedsEnergyRecovery !== null,
        reason: v2NeedsEnergyRecovery === null ? "reserve_policy_unavailable" : null,
        readingCount: ordered.length,
        reliableDrawCount: draws.length,
        unresolvedDrawDetected: false,
        remainingEnergyKwh: round(remainingEnergyKwh),
        observedEnergyKwh: round(observedEnergyKwh),
        sensorGapKwh: round(sensorGapKwh),
        balanceUncertaintyKwh: round(balanceUncertaintyKwh),
        heaterDeliveryUncertaintyKwh: round(heaterDeliveryUncertaintyKwh),
        heaterCreditGuardTopTempC,
        conservativeEnergyKwh: round(v2Decision.conservativeEnergyKwh),
        safetyEnergyKwh: v2Decision.thresholds.safetyEnergyKwh,
        targetEnergyKwh: v2Decision.thresholds.targetEnergyKwh,
        v2Band: v2Decision.band,
        v2NeedsEnergyRecovery,
        v1NeedsEnergyRecovery,
        comparison,
    };
}
function unavailable(reason, readingCount, reliableDrawCount, unresolvedDrawDetected, v1NeedsEnergyRecovery, heaterCreditGuardTopTempC) {
    return {
        available: false,
        reason,
        readingCount,
        reliableDrawCount,
        unresolvedDrawDetected,
        remainingEnergyKwh: null,
        observedEnergyKwh: null,
        sensorGapKwh: null,
        balanceUncertaintyKwh: exports.liveReserveShadowConfig.baselineBalanceUncertaintyKwh,
        heaterDeliveryUncertaintyKwh: 0,
        heaterCreditGuardTopTempC,
        conservativeEnergyKwh: null,
        safetyEnergyKwh: energyReservePolicy_ts_1.defaultEnergyReserveThresholds.safetyEnergyKwh,
        targetEnergyKwh: energyReservePolicy_ts_1.defaultEnergyReserveThresholds.targetEnergyKwh,
        v2Band: "invalid",
        v2NeedsEnergyRecovery: null,
        v1NeedsEnergyRecovery,
        comparison: v1NeedsEnergyRecovery === null ? "v1_unavailable" : "v2_unavailable",
    };
}
function isUsableReading(reading) {
    return Number.isFinite(reading.top_temp) &&
        Number.isFinite(reading.bottom_temp) &&
        Number.isFinite(reading.inlet_temp) &&
        Number.isFinite(Date.parse(reading.created_at));
}
function isReliableDraw(draw) {
    return draw.energy_reliable === true &&
        draw.energy_quality_reason === null &&
        typeof draw.estimated_water_draw_net_energy_kwh === "number" &&
        Number.isFinite(draw.estimated_water_draw_net_energy_kwh) &&
        draw.estimated_water_draw_net_energy_kwh > 0;
}
function observedStoredEnergyKwh(reading, inletTempC) {
    const tank = sensorGeometry_ts_1.sensorGeometryV2.tank;
    const topHeight = tank.heightCm - sensorGeometry_ts_1.sensorGeometryV2.topSensorDistanceFromTopCm;
    const boundary = (topHeight + sensorGeometry_ts_1.sensorGeometryV2.bottomSensorHeightFromBottomCm) / 2;
    const bottomMassKg = tank.nominalVolumeLiters * Math.max(0, Math.min(boundary / tank.heightCm, 1));
    const topMassKg = tank.nominalVolumeLiters - bottomMassKg;
    const bottomEnergy = layerEnergy(bottomMassKg, reading.bottom_temp, inletTempC);
    const topEnergy = layerEnergy(topMassKg, reading.top_temp, inletTempC);
    return bottomEnergy + topEnergy;
}
function estimateHeatLossKwh(reading, inletTempC, deltaHours) {
    if (deltaHours <= 0)
        return 0;
    const cooledTop = applyNewtonCooling(reading.top_temp, exports.liveReserveShadowConfig.topHeatLossTimeConstantHours, deltaHours);
    const cooledBottom = applyNewtonCooling(reading.bottom_temp, exports.liveReserveShadowConfig.bottomHeatLossTimeConstantHours, deltaHours);
    const before = observedStoredEnergyKwh(reading, inletTempC);
    const after = observedStoredEnergyKwh({ ...reading, top_temp: cooledTop, bottom_temp: cooledBottom }, inletTempC);
    return Math.max(before - after, 0);
}
function applyNewtonCooling(temperatureC, timeConstantHours, deltaHours) {
    return exports.liveReserveShadowConfig.ambientTempC +
        (temperatureC - exports.liveReserveShadowConfig.ambientTempC) * Math.exp(-deltaHours / timeConstantHours);
}
function layerEnergy(massKg, temperatureC, inletTempC) {
    return Math.max(massKg * exports.liveReserveShadowConfig.specificHeatKwhPerKgC * (temperatureC - inletTempC), 0);
}
function round(value) {
    return Math.round(value * 1000) / 1000;
}

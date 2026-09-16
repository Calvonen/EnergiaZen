"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runLiveEnergyPlanShadow = runLiveEnergyPlanShadow;
const sensorGeometry_ts_1 = require("../_shared/energyModelV2/sensorGeometry.js");
const energyPlanOptimizer_ts_1 = require("../_shared/energyModelV2/energyPlanOptimizer.js");
const logic_ts_1 = require("./logic.js");
const assumption = "standing_loss_only_no_future_draws";
const maxShadowHeatingHours = 4;
const helsinkiDateFormatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Helsinki",
    year: "numeric",
});
function runLiveEnergyPlanShadow({ automaticMaxHeatingHours, constraints = { forbiddenHeatingHourIds: [], requiredHeatingHourIds: [] }, energyCapacityKwh, inletBaselineC, maxTankTemperatureC, now, prices, reserve, }) {
    if (!reserve.available || reserve.remainingEnergyKwh === null || !Number.isFinite(reserve.remainingEnergyKwh)) {
        return unavailable("reserve_state_unavailable");
    }
    if (!Number.isFinite(automaticMaxHeatingHours) || automaticMaxHeatingHours < 0) {
        return unavailable("invalid_max_heating_hours");
    }
    if (automaticMaxHeatingHours > maxShadowHeatingHours) {
        return unavailable("max_heating_hours_above_shadow_limit");
    }
    if (!Number.isFinite(maxTankTemperatureC) || !Number.isFinite(inletBaselineC) || !Number.isFinite(energyCapacityKwh) || energyCapacityKwh <= 0) {
        return unavailable("invalid_thermal_inputs");
    }
    const standingLossKwhPerHour = worstCaseStandingLossKwhPerHour({ inletBaselineC, maxTankTemperatureC });
    const horizon = buildPriceHorizon({ now, prices, standingLossKwhPerHour });
    if (!horizon.ok)
        return unavailable(horizon.reason, standingLossKwhPerHour);
    // A production-locked active block is authoritative even if it is longer than
    // the current configured daily maximum (for example after a mid-block setting
    // reduction or across midnight). Preserve every required hour while keeping
    // the normal combinatorial cap for optional optimizer selections.
    const effectiveMaxHeatingHours = Math.max(automaticMaxHeatingHours, constraints.requiredHeatingHourIds.length);
    const plan = (0, energyPlanOptimizer_ts_1.optimizeEnergyPlan)({
        energyCapacityKwh,
        forbiddenHeatingHourIds: constraints.forbiddenHeatingHourIds,
        heaterPowerKw: logic_ts_1.liveReserveShadowConfig.heaterPowerKw,
        initialRemainingEnergyKwh: reserve.remainingEnergyKwh,
        initialUncertaintyKwh: reserve.balanceUncertaintyKwh,
        maxHeatingHours: effectiveMaxHeatingHours,
        requiredHeatingHourIds: constraints.requiredHeatingHourIds,
        segments: horizon.segments,
        thresholds: {
            safetyEnergyKwh: reserve.safetyEnergyKwh,
            targetEnergyKwh: reserve.targetEnergyKwh,
        },
    });
    return {
        available: true,
        assumption,
        candidateCount: plan.candidateCount,
        evaluatedCombinationCount: plan.evaluatedCombinationCount,
        firstSafetyViolationAt: plan.forecast.firstSafetyViolationAt,
        firstTargetMissAt: plan.forecast.firstTargetMissAt,
        forecastHorizonEndAt: horizon.horizonEndAt,
        minimumConservativeEnergyKwh: plan.forecast.minimumConservativeEnergyKwh,
        reason: plan.violationReason,
        selectedHeatingEnergyKwh: plan.selectedHeatingEnergyKwh,
        selectedHeatingHourIds: plan.selectedHeatingHourIds,
        standingLossKwhPerHour: round(standingLossKwhPerHour),
        totalCostCents: plan.totalCostCents,
        valid: plan.valid,
    };
}
function buildPriceHorizon({ now, prices, standingLossKwhPerHour }) {
    const today = helsinkiDateKey(now);
    const tomorrow = helsinkiDateKeyOffset(now, 1);
    const nowMs = now.getTime();
    const ordered = prices
        .filter((price) => price.resolution_minutes === 60 &&
        Number.isFinite(price.spot_price_cents_kwh) &&
        Number.isFinite(Date.parse(price.starts_at)) &&
        Number.isFinite(Date.parse(price.ends_at)) &&
        Date.parse(price.ends_at) > nowMs &&
        [today, tomorrow].includes(helsinkiDateKey(new Date(price.starts_at))))
        .sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at));
    if (!ordered.length)
        return { ok: false, reason: "no_price_hours_available" };
    const firstStart = Date.parse(ordered[0].starts_at);
    const firstEnd = Date.parse(ordered[0].ends_at);
    if (!(firstStart <= nowMs && firstEnd > nowMs))
        return { ok: false, reason: "current_price_hour_missing" };
    for (let index = 1; index < ordered.length; index += 1) {
        if (Date.parse(ordered[index - 1].ends_at) !== Date.parse(ordered[index].starts_at)) {
            return { ok: false, reason: "price_horizon_gap" };
        }
    }
    const segments = ordered.map((price) => {
        const startMs = Math.max(Date.parse(price.starts_at), nowMs);
        const endMs = Date.parse(price.ends_at);
        const segmentHours = Math.max(0, Math.min((endMs - startMs) / 3600000, 1));
        return {
            id: price.starts_at,
            modeledHeatLossKwh: standingLossKwhPerHour * segmentHours,
            priceCentsPerKwh: price.spot_price_cents_kwh,
            segmentHours,
            startDate: new Date(startMs).toISOString(),
        };
    });
    return { ok: true, horizonEndAt: ordered[ordered.length - 1].ends_at, segments };
}
function worstCaseStandingLossKwhPerHour({ inletBaselineC, maxTankTemperatureC }) {
    const tank = sensorGeometry_ts_1.sensorGeometryV2.tank;
    const topHeight = tank.heightCm - sensorGeometry_ts_1.sensorGeometryV2.topSensorDistanceFromTopCm;
    const boundary = (topHeight + sensorGeometry_ts_1.sensorGeometryV2.bottomSensorHeightFromBottomCm) / 2;
    const bottomMassKg = tank.nominalVolumeLiters * Math.max(0, Math.min(boundary / tank.heightCm, 1));
    const topMassKg = tank.nominalVolumeLiters - bottomMassKg;
    const topAfter = applyNewtonCooling(maxTankTemperatureC, logic_ts_1.liveReserveShadowConfig.topHeatLossTimeConstantHours);
    const bottomAfter = applyNewtonCooling(maxTankTemperatureC, logic_ts_1.liveReserveShadowConfig.bottomHeatLossTimeConstantHours);
    const before = layerEnergy(topMassKg, maxTankTemperatureC, inletBaselineC) + layerEnergy(bottomMassKg, maxTankTemperatureC, inletBaselineC);
    const after = layerEnergy(topMassKg, topAfter, inletBaselineC) + layerEnergy(bottomMassKg, bottomAfter, inletBaselineC);
    return Math.max(before - after, 0);
}
function applyNewtonCooling(temperatureC, timeConstantHours) {
    return logic_ts_1.liveReserveShadowConfig.ambientTempC + (temperatureC - logic_ts_1.liveReserveShadowConfig.ambientTempC) * Math.exp(-1 / timeConstantHours);
}
function layerEnergy(massKg, temperatureC, inletTempC) {
    return Math.max(massKg * logic_ts_1.liveReserveShadowConfig.specificHeatKwhPerKgC * (temperatureC - inletTempC), 0);
}
function helsinkiDateKey(date) {
    const parts = helsinkiDateFormatter.formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    return year && month && day ? `${year}-${month}-${day}` : "";
}
function helsinkiDateKeyOffset(date, dayOffset) {
    const key = helsinkiDateKey(date);
    const [year, month, day] = key.split("-").map(Number);
    if (![year, month, day].every(Number.isFinite))
        return "";
    return helsinkiDateKey(new Date(Date.UTC(year, month - 1, day + dayOffset, 12)));
}
function unavailable(reason, standingLossKwhPerHour = null) {
    return {
        available: false,
        assumption,
        candidateCount: 0,
        evaluatedCombinationCount: 0,
        firstSafetyViolationAt: null,
        firstTargetMissAt: null,
        forecastHorizonEndAt: null,
        minimumConservativeEnergyKwh: null,
        reason,
        selectedHeatingEnergyKwh: null,
        selectedHeatingHourIds: [],
        standingLossKwhPerHour: standingLossKwhPerHour === null ? null : round(standingLossKwhPerHour),
        totalCostCents: null,
        valid: null,
    };
}
function round(value) {
    return Math.round(value * 1000) / 1000;
}

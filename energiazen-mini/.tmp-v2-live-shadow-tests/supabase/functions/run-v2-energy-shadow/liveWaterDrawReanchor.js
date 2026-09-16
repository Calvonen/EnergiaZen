"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveLiveDrawReanchors = resolveLiveDrawReanchors;
const waterDrawDetection_ts_1 = require("../_shared/waterDrawDetection.js");
// Keep these deliberately aligned with the existing V2 heat-loss/water-draw
// diagnostics. The live shadow is more conservative than the diagnostic: it
// does not guess removed kWh for an unlabeled draw. It waits for inlet
// recovery plus a quiet tank period, then re-anchors the physical balance to
// the measured post-draw state.
const INLET_RECOVERY_MARGIN_C = 4;
const MIN_INLET_RECOVERY_DURATION_MINUTES = 3;
const MIN_TANK_STABILIZATION_MINUTES = 15;
const MAX_SENSOR_CHANGE_C = 0.75;
const MAX_SEGMENT_MINUTES = 2;
const LABEL_MATCH_MARGIN_MINUTES = 5;
function resolveLiveDrawReanchors({ coldInletBaselineC, readings, reliableDraws, }) {
    if (!Number.isFinite(coldInletBaselineC) || readings.length < 2) {
        return { detectedUnlabeledDrawCount: 0, reanchorIndexes: [], unresolved: false };
    }
    const reanchorIndexes = [];
    let detectedUnlabeledDrawCount = 0;
    let mode = "normal";
    let warmRecoveryStartMs = null;
    let stableTankStartMs = null;
    for (let index = 1; index < readings.length; index += 1) {
        const current = readings[index];
        const previous = readings[index - 1];
        const currentMs = Date.parse(current.created_at);
        const previousMs = Date.parse(previous.created_at);
        if (!Number.isFinite(currentMs) || !Number.isFinite(previousMs) || currentMs <= previousMs) {
            if (mode !== "normal") {
                warmRecoveryStartMs = null;
                stableTankStartMs = null;
            }
            continue;
        }
        // Inlet evidence remains authoritative even while the heater is on. A real
        // draw can be thermally masked by the 3 kW heater, so a flat or rising
        // bottom sensor cannot safely prove that the inlet drop was sensor-only.
        // Treat that situation as ambiguous and fail closed. Once the inlet has
        // recovered and the unheated tank has been quiet long enough, re-anchor to
        // the measured tank state instead of estimating how much energy the draw
        // removed. This handles both a real draw and a heater-induced inlet probe
        // oscillation without ever crediting uncertain energy to the live ledger.
        const drawDetected = currentSampleHasDrawSignal(readings, index);
        const matchedReliableDraw = drawDetected && isMatchedByReliableDraw(currentMs, reliableDraws);
        const unmatchedDraw = drawDetected && !matchedReliableDraw;
        if (mode === "normal") {
            if (unmatchedDraw) {
                detectedUnlabeledDrawCount += 1;
                mode = "recovery";
                warmRecoveryStartMs = null;
                stableTankStartMs = null;
            }
            continue;
        }
        if (unmatchedDraw) {
            if (mode !== "recovery")
                detectedUnlabeledDrawCount += 1;
            mode = "recovery";
            warmRecoveryStartMs = null;
            stableTankStartMs = null;
            continue;
        }
        if (mode === "recovery") {
            const inletC = current.inlet_temp;
            const gapMinutes = (currentMs - previousMs) / 60000;
            const continuouslyWarm = typeof inletC === "number" &&
                Number.isFinite(inletC) &&
                inletC >= coldInletBaselineC + INLET_RECOVERY_MARGIN_C &&
                gapMinutes > 0 &&
                gapMinutes <= MAX_SEGMENT_MINUTES;
            if (!continuouslyWarm || current.heating === true) {
                warmRecoveryStartMs = null;
                continue;
            }
            warmRecoveryStartMs ?? (warmRecoveryStartMs = currentMs);
            if (currentMs - warmRecoveryStartMs < MIN_INLET_RECOVERY_DURATION_MINUTES * 60000) {
                continue;
            }
            mode = "stabilizing";
            stableTankStartMs = currentMs;
            continue;
        }
        // Stabilization is intentionally strict. Any heating, sampling gap or
        // rapid tank-sensor movement resets the quiet-period clock. We stay in
        // stabilizing mode so the shadow can recover once the tank is quiet again.
        const gapMinutes = (currentMs - previousMs) / 60000;
        const stableTransition = current.heating !== true &&
            gapMinutes > 0 &&
            gapMinutes <= MAX_SEGMENT_MINUTES &&
            finiteTemperature(current.top_temp) &&
            finiteTemperature(previous.top_temp) &&
            finiteTemperature(current.bottom_temp) &&
            finiteTemperature(previous.bottom_temp) &&
            Math.abs(current.top_temp - previous.top_temp) <= MAX_SENSOR_CHANGE_C &&
            Math.abs(current.bottom_temp - previous.bottom_temp) <= MAX_SENSOR_CHANGE_C;
        if (!stableTransition) {
            stableTankStartMs = null;
            continue;
        }
        stableTankStartMs ?? (stableTankStartMs = currentMs);
        if (currentMs - stableTankStartMs < MIN_TANK_STABILIZATION_MINUTES * 60000) {
            continue;
        }
        reanchorIndexes.push(index);
        mode = "normal";
        warmRecoveryStartMs = null;
        stableTankStartMs = null;
    }
    return {
        detectedUnlabeledDrawCount,
        reanchorIndexes,
        unresolved: mode !== "normal",
    };
}
function currentSampleHasDrawSignal(readings, index) {
    const currentTime = Date.parse(readings[index].created_at);
    const windowStartMs = currentTime - 5 * 60000;
    const window = readings
        .slice(0, index + 1)
        .filter((reading) => Date.parse(reading.created_at) >= windowStartMs);
    const inletSamples = window.map((reading) => ({
        inletTemperatureC: reading.inlet_temp,
        time: Date.parse(reading.created_at),
    }));
    return inletSamples.length >= 2 && (0, waterDrawDetection_ts_1.detectsWaterDraw)(inletSamples);
}
function isMatchedByReliableDraw(currentMs, draws) {
    const marginMs = LABEL_MATCH_MARGIN_MINUTES * 60000;
    return draws.some((draw) => {
        const start = Date.parse(draw.event_started_at) - marginMs;
        const end = Date.parse(draw.event_ended_at) + marginMs;
        return Number.isFinite(start) && Number.isFinite(end) && currentMs >= start && currentMs <= end;
    });
}
function finiteTemperature(value) {
    return typeof value === "number" && Number.isFinite(value);
}

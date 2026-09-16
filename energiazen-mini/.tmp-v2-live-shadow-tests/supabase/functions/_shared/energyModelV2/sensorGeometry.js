"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sensorGeometryEpochs = exports.topSensorMovedAt = exports.sensorGeometryV2 = exports.sensorGeometryV1 = exports.jaspiVlm300SGeometry = void 0;
exports.createSensorGeometryEpochs = createSensorGeometryEpochs;
exports.areTimestampsInSameSensorGeometryEpoch = areTimestampsInSameSensorGeometryEpoch;
exports.filterToLatestSensorGeometryEpoch = filterToLatestSensorGeometryEpoch;
exports.assertValidSensorGeometryEpochs = assertValidSensorGeometryEpochs;
exports.resolveSensorGeometryForTimestamp = resolveSensorGeometryForTimestamp;
exports.jaspiVlm300SGeometry = {
    heightCm: 145,
    model: "Jäspi VLM-300 S",
    nominalVolumeLiters: 290,
};
exports.sensorGeometryV1 = {
    bottomSensorHeightFromBottomCm: 22,
    effectiveFromInclusive: null,
    effectiveUntilExclusive: null,
    notes: "Historical geometry before the top sensor was moved; top sensor was 9 cm below the tank lid.",
    tank: exports.jaspiVlm300SGeometry,
    topSensorDistanceFromTopCm: 9,
    version: "V1",
};
exports.sensorGeometryV2 = {
    bottomSensorHeightFromBottomCm: 22,
    effectiveFromInclusive: null,
    effectiveUntilExclusive: null,
    notes: "Current geometry after the top sensor move; top sensor is 16 cm below the tank lid.",
    tank: exports.jaspiVlm300SGeometry,
    topSensorDistanceFromTopCm: 16,
    version: "V2",
};
// The top sensor was physically moved from 9 cm to 16 cm below the lid at
// this instant. Keep this as the single production boundary for every model
// and learning pipeline; timestamps before it are V1 and timestamps at or
// after it are V2.
exports.topSensorMovedAt = "2026-08-05T14:00:00.000Z";
function createSensorGeometryEpochs({ topSensorMovedAt, }) {
    assertValidIsoTimestamp(topSensorMovedAt, "topSensorMovedAt");
    return [
        {
            ...exports.sensorGeometryV1,
            effectiveUntilExclusive: topSensorMovedAt,
        },
        {
            ...exports.sensorGeometryV2,
            effectiveFromInclusive: topSensorMovedAt,
        },
    ];
}
exports.sensorGeometryEpochs = createSensorGeometryEpochs({
    topSensorMovedAt: exports.topSensorMovedAt,
});
function areTimestampsInSameSensorGeometryEpoch(firstTimestamp, secondTimestamp) {
    try {
        return (resolveSensorGeometryForTimestamp({
            epochs: exports.sensorGeometryEpochs,
            timestamp: firstTimestamp,
        }).version ===
            resolveSensorGeometryForTimestamp({
                epochs: exports.sensorGeometryEpochs,
                timestamp: secondTimestamp,
            }).version);
    }
    catch {
        return false;
    }
}
function filterToLatestSensorGeometryEpoch(readings) {
    const resolved = readings
        .map((reading) => {
        if (!reading.created_at) {
            return null;
        }
        try {
            return {
                epoch: resolveSensorGeometryForTimestamp({
                    epochs: exports.sensorGeometryEpochs,
                    timestamp: reading.created_at,
                }),
                reading,
            };
        }
        catch {
            return null;
        }
    })
        .filter((item) => item !== null);
    const latestEpochStart = resolved.reduce((latest, item) => Math.max(latest, item.epoch.effectiveFromInclusive
        ? new Date(item.epoch.effectiveFromInclusive).getTime()
        : Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
    return resolved
        .filter((item) => {
        const epochStart = item.epoch.effectiveFromInclusive
            ? new Date(item.epoch.effectiveFromInclusive).getTime()
            : Number.NEGATIVE_INFINITY;
        return epochStart === latestEpochStart;
    })
        .map((item) => item.reading);
}
function assertValidSensorGeometryEpochs(epochs) {
    if (epochs.length === 0) {
        throw new Error("At least one sensor geometry epoch is required");
    }
    const sortedEpochs = [...epochs].sort(compareEpochStart);
    for (let index = 0; index < sortedEpochs.length; index += 1) {
        const epoch = sortedEpochs[index];
        if (epoch.effectiveFromInclusive !== null) {
            assertValidIsoTimestamp(epoch.effectiveFromInclusive, `epochs[${index}].effectiveFromInclusive`);
        }
        if (epoch.effectiveUntilExclusive !== null) {
            assertValidIsoTimestamp(epoch.effectiveUntilExclusive, `epochs[${index}].effectiveUntilExclusive`);
        }
        if (epoch.effectiveFromInclusive !== null &&
            epoch.effectiveUntilExclusive !== null &&
            new Date(epoch.effectiveFromInclusive).getTime() >=
                new Date(epoch.effectiveUntilExclusive).getTime()) {
            throw new Error(`Sensor geometry epoch ${epoch.version} has an empty range`);
        }
        const nextEpoch = sortedEpochs[index + 1];
        if (!nextEpoch || epoch.effectiveUntilExclusive === null) {
            continue;
        }
        if (nextEpoch.effectiveFromInclusive !== epoch.effectiveUntilExclusive) {
            throw new Error(`Sensor geometry epochs must be contiguous between ${epoch.version} and ${nextEpoch.version}`);
        }
    }
}
function resolveSensorGeometryForTimestamp({ epochs, timestamp, }) {
    assertValidIsoTimestamp(timestamp, "timestamp");
    assertValidSensorGeometryEpochs(epochs);
    const time = new Date(timestamp).getTime();
    const match = epochs.find((epoch) => {
        const startsAt = epoch.effectiveFromInclusive
            ? new Date(epoch.effectiveFromInclusive).getTime()
            : Number.NEGATIVE_INFINITY;
        const endsAt = epoch.effectiveUntilExclusive
            ? new Date(epoch.effectiveUntilExclusive).getTime()
            : Number.POSITIVE_INFINITY;
        return time >= startsAt && time < endsAt;
    });
    if (!match) {
        throw new Error(`No sensor geometry epoch covers timestamp ${timestamp}`);
    }
    return match;
}
function compareEpochStart(first, second) {
    const firstStart = first.effectiveFromInclusive
        ? new Date(first.effectiveFromInclusive).getTime()
        : Number.NEGATIVE_INFINITY;
    const secondStart = second.effectiveFromInclusive
        ? new Date(second.effectiveFromInclusive).getTime()
        : Number.NEGATIVE_INFINITY;
    return firstStart - secondStart;
}
function assertValidIsoTimestamp(value, label) {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) {
        throw new Error(`${label} must be a valid ISO timestamp`);
    }
}

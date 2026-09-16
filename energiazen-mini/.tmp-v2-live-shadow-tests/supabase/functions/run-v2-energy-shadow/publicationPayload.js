"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildV2StagedPlans = buildV2StagedPlans;
exports.buildV2TankSnapshot = buildV2TankSnapshot;
exports.buildV2PriceSnapshot = buildV2PriceSnapshot;
exports.buildExpectedV2PlanVersions = buildExpectedV2PlanVersions;
const HELSINKI_PARTS = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});
function buildV2StagedPlans(candidate, coveredHourIds) {
    if (coveredHourIds.length === 0)
        throw new Error("V2 publication requires a covered forecast horizon");
    const coveredInstants = new Set();
    const coveredSlots = new Map();
    const byDate = new Map();
    for (const id of coveredHourIds) {
        const instant = parseHourId(id);
        requireUtcClockHour(instant, id);
        const ms = instant.getTime();
        if (coveredInstants.has(ms))
            throw new Error(`Duplicate covered V2 hour: ${id}`);
        coveredInstants.add(ms);
        const { date, hour } = helsinkiDateHour(instant);
        const slot = `${date}:${hour}`;
        coveredSlots.set(slot, (coveredSlots.get(slot) ?? 0) + 1);
        if (!byDate.has(date))
            byDate.set(date, new Set());
    }
    for (const id of candidate.selectedHeatingHourIds) {
        const instant = parseHourId(id);
        requireUtcClockHour(instant, id);
        if (!coveredInstants.has(instant.getTime()))
            throw new Error(`Selected V2 hour is outside covered horizon: ${id}`);
        const { date, hour } = helsinkiDateHour(instant);
        if ((coveredSlots.get(`${date}:${hour}`) ?? 0) !== 1)
            throw new Error(`Ambiguous Helsinki V2 hour: ${date} ${hour}`);
        byDate.get(date).add(hour);
    }
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([plan_date, hours]) => ({
        plan_date,
        planned_hours: [...hours].sort((a, b) => a - b),
    }));
}
function buildV2TankSnapshot(rows, anchorAt) {
    const row = rows.find((candidate) => candidate.created_at === anchorAt);
    if (!row || ![row.top_temp, row.bottom_temp, row.inlet_temp].every(Number.isFinite) || typeof row.heating !== "boolean")
        return null;
    return {
        created_at: row.created_at,
        top_temp: row.top_temp,
        bottom_temp: row.bottom_temp,
        inlet_temp: row.inlet_temp,
        heating: row.heating,
    };
}
function buildV2PriceSnapshot(prices) {
    const seen = new Set();
    return prices.map((price) => {
        const startsAt = parseHourId(price.starts_at);
        requireUtcClockHour(startsAt, price.starts_at);
        const startsAtMs = startsAt.getTime();
        if (seen.has(startsAtMs))
            throw new Error(`Duplicate V2 price snapshot interval: ${price.starts_at}`);
        seen.add(startsAtMs);
        return {
            starts_at: price.starts_at,
            ends_at: price.ends_at,
            spot_price_cents_kwh: price.spot_price_cents_kwh,
            resolution_minutes: 60,
        };
    });
}
function buildExpectedV2PlanVersions(planningDates, stored) {
    const seen = new Set();
    return planningDates.map((plan_date) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(plan_date))
            throw new Error(`Invalid V2 planning date: ${plan_date}`);
        if (seen.has(plan_date))
            throw new Error(`Duplicate V2 planning date: ${plan_date}`);
        seen.add(plan_date);
        return {
            plan_date,
            updated_at: stored.find((row) => row.plan_date === plan_date)?.updated_at ?? null,
        };
    });
}
function parseHourId(id) {
    const instant = new Date(id);
    if (!Number.isFinite(instant.getTime()))
        throw new Error(`Invalid V2 hour id: ${id}`);
    return instant;
}
function requireUtcClockHour(instant, id) {
    if (instant.getUTCMinutes() !== 0 || instant.getUTCSeconds() !== 0 || instant.getUTCMilliseconds() !== 0) {
        throw new Error(`V2 hour is not aligned to a UTC clock hour: ${id}`);
    }
}
function helsinkiDateHour(instant) {
    const parts = Object.fromEntries(HELSINKI_PARTS.formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

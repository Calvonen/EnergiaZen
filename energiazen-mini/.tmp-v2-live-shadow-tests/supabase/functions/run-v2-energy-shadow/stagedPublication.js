"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildV2StagedPublicationArgs = buildV2StagedPublicationArgs;
const publicationPayload_ts_1 = require("./publicationPayload.js");
function buildV2StagedPublicationArgs({ candidate, constraintPlans, draws, latestUsableReadingAt, now, plan, prices, priceFetchEnd, readings, replayStart, settings, storedStagedVersions, today, tomorrow, }) {
    if (!plan.forecastHorizonEndAt)
        throw new Error("V2 staged publication requires a forecast horizon");
    const nowMs = now.getTime();
    const coveredHourIds = prices
        .filter((price) => price.resolution_minutes === 60 &&
        Number.isFinite(price.spot_price_cents_kwh) &&
        Number.isFinite(Date.parse(price.starts_at)) &&
        Number.isFinite(Date.parse(price.ends_at)) &&
        Date.parse(price.ends_at) > nowMs &&
        [today, tomorrow].includes(helsinkiDateKey(new Date(price.starts_at))))
        .sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at))
        .map((price) => price.starts_at);
    const plans = (0, publicationPayload_ts_1.buildV2StagedPlans)(candidate, coveredHourIds);
    const tankSnapshot = (0, publicationPayload_ts_1.buildV2TankSnapshot)(readings, latestUsableReadingAt);
    if (!tankSnapshot)
        throw new Error("V2 staged publication anchor is not publishable");
    return {
        p_plans: plans,
        p_expected_plan_versions: (0, publicationPayload_ts_1.buildExpectedV2PlanVersions)([today, tomorrow], storedStagedVersions),
        p_expected_tank_snapshot: tankSnapshot,
        p_expected_tank_replay: readings.map((row) => ({
            created_at: row.created_at,
            top_temp: row.top_temp,
            bottom_temp: row.bottom_temp,
            inlet_temp: row.inlet_temp,
            heating: row.heating,
        })),
        p_expected_water_draw_snapshot: draws.map((draw) => ({
            event_started_at: draw.event_started_at,
            event_ended_at: draw.event_ended_at,
            estimated_water_draw_net_energy_kwh: draw.estimated_water_draw_net_energy_kwh,
            energy_reliable: draw.energy_reliable,
            energy_quality_reason: draw.energy_quality_reason,
        })),
        p_expected_settings_snapshot: { id: 1, ...settings },
        p_constraint_plan_dates: [today, tomorrow],
        p_expected_constraint_plans: constraintPlans.map((stored) => ({
            plan_date: stored.plan_date,
            planned_hours: stored.planned_hours,
            mode: stored.mode,
        })),
        // This is deliberately the complete raw 48h query result, not the modeled
        // today/tomorrow subset. The RPC rechecks the exact query scope under lock.
        p_expected_price_snapshot: (0, publicationPayload_ts_1.buildV2PriceSnapshot)(prices),
        p_price_fetch_end_at: priceFetchEnd.toISOString(),
        p_replay_start_at: replayStart.toISOString(),
        p_replay_end_at: now.toISOString(),
        p_published_at: now.toISOString(),
        p_forecast_horizon_end_at: plan.forecastHorizonEndAt,
    };
}
const helsinkiDateFormatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit", month: "2-digit", timeZone: "Europe/Helsinki", year: "numeric",
});
function helsinkiDateKey(date) {
    const parts = helsinkiDateFormatter.formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    return year && month && day ? `${year}-${month}-${day}` : "";
}

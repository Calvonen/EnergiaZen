import type { ShadowElectricityPrice } from "./planShadow.ts";
import type { ShadowTankReading } from "./logic.ts";
import type { V2PublicationCandidate } from "./publicationGuard.ts";

export type V2StagedPlan = { plan_date: string; planned_hours: number[] };
export type V2StagedPlanVersion = { plan_date: string; updated_at: string | null };

const helsinkiDate = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit", month: "2-digit", timeZone: "Europe/Helsinki", year: "numeric",
});
const helsinkiHour = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Helsinki",
});

export function buildV2StagedPlans(candidate: V2PublicationCandidate): V2StagedPlan[] {
  const byDate = new Map<string, Set<number>>();
  for (const id of candidate.selectedHeatingHourIds) {
    const instant = new Date(id);
    if (!Number.isFinite(instant.getTime())) throw new Error(`Invalid V2 selected hour id: ${id}`);
    const date = dateKey(instant);
    const hour = Number(helsinkiHour.format(instant));
    if (!date || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`Invalid V2 selected hour: ${id}`);
    const hours = byDate.get(date) ?? new Set<number>();
    hours.add(hour);
    byDate.set(date, hours);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([plan_date, hours]) => ({ plan_date, planned_hours: [...hours].sort((a, b) => a - b) }));
}

export function buildV2TankSnapshot(readings: ShadowTankReading[], anchorAt: string | null) {
  if (!anchorAt) return null;
  const row = readings.find((reading) => reading.created_at === anchorAt);
  if (!row || ![row.top_temp, row.bottom_temp, row.inlet_temp].every(Number.isFinite)) return null;
  return { created_at: row.created_at, top_temp: row.top_temp, bottom_temp: row.bottom_temp, inlet_temp: row.inlet_temp };
}

export function buildV2PriceSnapshot(prices: ShadowElectricityPrice[]) {
  return prices.map((price) => ({
    starts_at: price.starts_at,
    ends_at: price.ends_at,
    spot_price_cents_kwh: price.spot_price_cents_kwh,
    resolution_minutes: price.resolution_minutes,
  }));
}

export function buildExpectedV2PlanVersions(
  plans: V2StagedPlan[],
  stored: Array<{ plan_date: string; updated_at: string }>,
): V2StagedPlanVersion[] {
  return plans.map((plan) => ({
    plan_date: plan.plan_date,
    updated_at: stored.find((row) => row.plan_date === plan.plan_date)?.updated_at ?? null,
  }));
}

function dateKey(date: Date) {
  const parts = helsinkiDate.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

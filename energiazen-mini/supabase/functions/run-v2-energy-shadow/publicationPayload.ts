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

export function buildV2StagedPlans(
  candidate: V2PublicationCandidate,
  coveredHourIds: string[] = candidate.selectedHeatingHourIds,
): V2StagedPlan[] {
  const byDate = new Map<string, Set<number>>();
  for (const id of coveredHourIds) {
    const instant = parseHourId(id);
    const date = dateKey(instant);
    if (!date) throw new Error(`Invalid V2 covered hour: ${id}`);
    if (!byDate.has(date)) byDate.set(date, new Set<number>());
  }

  const localSlots = new Map<string, string>();
  for (const id of candidate.selectedHeatingHourIds) {
    const instant = parseHourId(id);
    const date = dateKey(instant);
    const hour = Number(helsinkiHour.format(instant));
    if (!date || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`Invalid V2 selected hour: ${id}`);
    if (!byDate.has(date)) throw new Error(`Selected V2 hour is outside publication horizon: ${id}`);
    const localSlot = `${date}:${hour}`;
    const previousUtcId = localSlots.get(localSlot);
    if (previousUtcId && previousUtcId !== id) {
      throw new Error(`Ambiguous Helsinki DST hour cannot be staged safely: ${previousUtcId}, ${id}`);
    }
    localSlots.set(localSlot, id);
    byDate.get(date)!.add(hour);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([plan_date, hours]) => ({ plan_date, planned_hours: [...hours].sort((a, b) => a - b) }));
}

export function buildV2TankSnapshot(readings: ShadowTankReading[], anchorAt: string | null) {
  if (!anchorAt) return null;
  const row = readings.find((reading) => reading.created_at === anchorAt);
  if (!row || ![row.top_temp, row.bottom_temp, row.inlet_temp].every(Number.isFinite) || typeof row.heating !== "boolean") return null;
  return {
    created_at: row.created_at,
    top_temp: row.top_temp,
    bottom_temp: row.bottom_temp,
    inlet_temp: row.inlet_temp,
    heating: row.heating,
  };
}

export function buildV2PriceSnapshot(prices: ShadowElectricityPrice[]) {
  const seen = new Set<string>();
  return prices.map((price) => {
    const resolutionMinutes = 60;
    const key = `${price.starts_at}|${resolutionMinutes}`;
    if (seen.has(key)) throw new Error(`Duplicate V2 price snapshot interval: ${key}`);
    seen.add(key);
    return {
      starts_at: price.starts_at,
      ends_at: price.ends_at,
      spot_price_cents_kwh: price.spot_price_cents_kwh,
      resolution_minutes: resolutionMinutes,
    };
  });
}

export function buildExpectedV2PlanVersions(
  plans: V2StagedPlan[],
  stored: Array<{ plan_date: string; updated_at: string }>,
): V2StagedPlanVersion[] {
  const seen = new Set<string>();
  return plans.map((plan) => {
    if (seen.has(plan.plan_date)) throw new Error(`Duplicate V2 plan date: ${plan.plan_date}`);
    seen.add(plan.plan_date);
    return {
      plan_date: plan.plan_date,
      updated_at: stored.find((row) => row.plan_date === plan.plan_date)?.updated_at ?? null,
    };
  });
}

function parseHourId(id: string) {
  const instant = new Date(id);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== id) {
    throw new Error(`Invalid V2 hour id: ${id}`);
  }
  return instant;
}

function dateKey(date: Date) {
  const parts = helsinkiDate.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

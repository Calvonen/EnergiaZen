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
  coveredHourIds: string[],
): V2StagedPlan[] {
  if (!coveredHourIds.length) throw new Error("V2 publication horizon is empty");
  const byDate = new Map<string, Set<number>>();
  const coveredInstants = new Set<number>();
  const coveredLocalSlots = new Map<string, number>();
  const ambiguousLocalSlots = new Set<string>();

  for (const id of coveredHourIds) {
    const instant = parseHourId(id);
    requireUtcClockHour(instant, id);
    const instantMs = instant.getTime();
    if (coveredInstants.has(instantMs)) throw new Error(`Duplicate V2 covered hour: ${id}`);
    coveredInstants.add(instantMs);
    const date = dateKey(instant);
    const hour = Number(helsinkiHour.format(instant));
    if (!date || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`Invalid V2 covered hour: ${id}`);
    if (!byDate.has(date)) byDate.set(date, new Set<number>());
    const localSlot = `${date}:${hour}`;
    const previousInstantMs = coveredLocalSlots.get(localSlot);
    if (previousInstantMs !== undefined && previousInstantMs !== instantMs) ambiguousLocalSlots.add(localSlot);
    else coveredLocalSlots.set(localSlot, instantMs);
  }

  const selectedInstants = new Set<number>();
  for (const id of candidate.selectedHeatingHourIds) {
    const instant = parseHourId(id);
    requireUtcClockHour(instant, id);
    const instantMs = instant.getTime();
    if (selectedInstants.has(instantMs)) throw new Error(`Duplicate V2 selected hour: ${id}`);
    selectedInstants.add(instantMs);
    if (!coveredInstants.has(instantMs)) throw new Error(`Selected V2 hour is outside publication horizon: ${id}`);
    const date = dateKey(instant);
    const hour = Number(helsinkiHour.format(instant));
    if (!date || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`Invalid V2 selected hour: ${id}`);
    const localSlot = `${date}:${hour}`;
    if (ambiguousLocalSlots.has(localSlot)) {
      throw new Error(`Ambiguous Helsinki DST hour cannot be staged safely: ${id}`);
    }
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
  const seen = new Set<number>();
  return prices.map((price) => {
    const startsAt = parseHourId(price.starts_at);
    requireUtcClockHour(startsAt, price.starts_at);
    const startsAtMs = startsAt.getTime();
    if (seen.has(startsAtMs)) throw new Error(`Duplicate V2 price snapshot interval: ${price.starts_at}`);
    seen.add(startsAtMs);
    return {
      starts_at: price.starts_at,
      ends_at: price.ends_at,
      spot_price_cents_kwh: price.spot_price_cents_kwh,
      resolution_minutes: 60,
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
  if (!Number.isFinite(instant.getTime())) throw new Error(`Invalid V2 hour id: ${id}`);
  return instant;
}

function requireUtcClockHour(instant: Date, id: string) {
  if (instant.getUTCMinutes() !== 0 || instant.getUTCSeconds() !== 0 || instant.getUTCMilliseconds() !== 0) {
    throw new Error(`V2 hour is not aligned to a UTC clock-hour boundary: ${id}`);
  }
}

function dateKey(date: Date) {
  const parts = helsinkiDate.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

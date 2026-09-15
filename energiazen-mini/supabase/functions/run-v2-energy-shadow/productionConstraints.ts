import type { ShadowTankReading } from "./logic.ts";

export type ShadowStoredHeatingPlan = {
  mode?: string | null;
  plan_date: string;
  planned_hours: unknown;
};

export type V2HeatingConstraints = {
  forbiddenHeatingHourIds: string[];
  requiredHeatingHourIds: string[];
};

const helsinkiParts = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

export function resolveV2HeatingConstraints({
  now,
  priceHourIds,
  readings,
  storedPlans,
  safetyTopTemperatureC = 50,
}: {
  now: Date;
  priceHourIds: string[];
  readings: ShadowTankReading[];
  storedPlans: ShadowStoredHeatingPlan[];
  safetyTopTemperatureC?: number;
}): V2HeatingConstraints {
  const empty = { forbiddenHeatingHourIds: [], requiredHeatingHourIds: [] };
  const latest = readings[readings.length - 1];
  if (!latest || typeof latest.top_temp !== "number" || latest.top_temp < safetyTopTemperatureC) {
    return empty;
  }

  const ordered = [...new Set(priceHourIds)]
    .filter((id) => Number.isFinite(Date.parse(id)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const nowMs = now.getTime();
  const currentIndex = ordered.findIndex((id) => {
    const start = Date.parse(id);
    return start <= nowMs && start + 60 * 60 * 1000 > nowMs;
  });
  if (currentIndex < 0) return empty;

  const automaticPlans = new Map<string, Set<number>>();
  for (const plan of storedPlans) {
    if (plan.mode !== "automatic") continue;
    const hours = normalizeHours(plan.planned_hours);
    if (hours) automaticPlans.set(plan.plan_date, new Set(hours));
  }

  const isStoredAutomaticHour = (id: string) => {
    const local = helsinkiDateAndHour(id);
    return local !== null && automaticPlans.get(local.dateKey)?.has(local.hour) === true;
  };

  const currentId = ordered[currentIndex];
  if (latest.heating === true && isStoredAutomaticHour(currentId)) {
    const requiredHeatingHourIds: string[] = [];
    let expectedStart = Date.parse(currentId);
    let index = currentIndex;
    for (; index < ordered.length; index += 1) {
      const id = ordered[index];
      if (Date.parse(id) !== expectedStart || !isStoredAutomaticHour(id)) break;
      requiredHeatingHourIds.push(id);
      expectedStart += 60 * 60 * 1000;
    }

    const nextId = ordered[index];
    return {
      requiredHeatingHourIds,
      forbiddenHeatingHourIds:
        nextId && Date.parse(nextId) === expectedStart ? [nextId] : [],
    };
  }

  // A current hour already present in the authoritative automatic plan is
  // never cooldown-blocked. This preserves an intentionally consecutive
  // planned block even if the relay toggled at the hour boundary.
  if (isStoredAutomaticHour(currentId)) return empty;

  const currentStart = Date.parse(currentId);
  const previousStart = currentStart - 60 * 60 * 1000;
  const previousIntervalActuallyHeated = readings.some((reading) => {
    if (reading.heating !== true || !reading.created_at) return false;
    const at = Date.parse(reading.created_at);
    return Number.isFinite(at) && at >= previousStart && at < currentStart;
  });

  return previousIntervalActuallyHeated
    ? { forbiddenHeatingHourIds: [currentId], requiredHeatingHourIds: [] }
    : empty;
}

function normalizeHours(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))]
    .map(Number)
    .sort((left, right) => left - right);
}

function helsinkiDateAndHour(iso: string): { dateKey: string; hour: number } | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = helsinkiParts.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = Number(value("hour"));
  return year && month && day && Number.isInteger(hour)
    ? { dateKey: `${year}-${month}-${day}`, hour }
    : null;
}

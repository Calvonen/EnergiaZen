export type LearnedTemperatureDropProfileRow = {
  id: string;
  profile_date: string;
  timezone: string;
  source_start: string;
  source_end: string;
  source_days: number;
  hourly_drops: unknown;
  observation_days_by_hour: unknown;
  general_fallback: number;
  hourly_energy_losses_kwh: unknown;
  general_energy_loss_kwh: number | null;
  algorithm_version: string;
  created_at: string;
};

export type LearnedTemperatureDropProfile = Omit<
  LearnedTemperatureDropProfileRow,
  "hourly_drops" | "observation_days_by_hour"
> & {
  hourlyDrops: Record<number, number>;
  hourlyEnergyLossesKwh: Record<number, number>;
  observationDaysByHour: Record<number, number>;
};

const PROFILE_MAX_AGE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseHourRecord(value: unknown, integersOnly: boolean) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const parsed: Record<number, number> = {};

  for (let hour = 0; hour < 24; hour += 1) {
    const item = record[String(hour)];
    if (
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      item < 0 ||
      (integersOnly && !Number.isInteger(item))
    ) {
      return null;
    }
    parsed[hour] = item;
  }

  return Object.keys(record).length === 24 ? parsed : null;
}

export function parseLearnedTemperatureDropProfile(
  row: LearnedTemperatureDropProfileRow,
): LearnedTemperatureDropProfile | null {
  const hourlyDrops = parseHourRecord(row.hourly_drops, false);
  const hourlyEnergyLossesKwh = parseHourRecord(row.hourly_energy_losses_kwh, false);
  const observationDaysByHour = parseHourRecord(row.observation_days_by_hour, true);

  if (
    row.timezone !== "Europe/Helsinki" ||
    !row.id ||
    !row.profile_date ||
    !row.created_at ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    !Number.isFinite(row.general_fallback) ||
    row.general_fallback < 0 ||
    row.general_energy_loss_kwh === null ||
    !Number.isFinite(row.general_energy_loss_kwh) ||
    row.general_energy_loss_kwh < 0 ||
    !hourlyDrops ||
    !hourlyEnergyLossesKwh ||
    !observationDaysByHour
  ) {
    return null;
  }

  return {
    ...row,
    hourlyDrops,
    hourlyEnergyLossesKwh,
    observationDaysByHour,
  };
}

export function learnedTemperatureDropProfileAgeDays(
  profile: LearnedTemperatureDropProfile,
  now: Date,
) {
  const createdAt = Date.parse(profile.created_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(now.getTime())) return null;
  return Math.max(0, (now.getTime() - createdAt) / DAY_MS);
}

export function isLearnedTemperatureDropProfileFresh(
  profile: LearnedTemperatureDropProfile,
  now: Date,
) {
  const ageDays = learnedTemperatureDropProfileAgeDays(profile, now);
  return ageDays !== null && ageDays <= PROFILE_MAX_AGE_DAYS;
}

export function buildLearnedTemperatureDropProfileSnapshot(
  profile: LearnedTemperatureDropProfile | null,
) {
  if (!profile) return null;
  return {
    id: profile.id,
    profile_date: profile.profile_date,
    timezone: profile.timezone,
    source_start: profile.source_start,
    source_end: profile.source_end,
    source_days: profile.source_days,
    hourly_drops: Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour), profile.hourlyDrops[hour]]),
    ),
    observation_days_by_hour: Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour), profile.observationDaysByHour[hour]]),
    ),
    hourly_energy_losses_kwh: Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour), profile.hourlyEnergyLossesKwh[hour]]),
    ),
    general_fallback: profile.general_fallback,
    general_energy_loss_kwh: profile.general_energy_loss_kwh,
    algorithm_version: profile.algorithm_version,
    created_at: profile.created_at,
  };
}

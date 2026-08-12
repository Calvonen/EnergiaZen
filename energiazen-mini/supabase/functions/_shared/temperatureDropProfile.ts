import type { SupabaseClient } from "@supabase/supabase-js";

import {
  fallbackHourlyTemperatureDrop,
  HourlyTemperatureDropProfile,
} from "./tankTemperatureForecast";

export type TemperatureDropProfileRow = {
  algorithm_version: string | null;
  created_at: string | null;
  general_fallback: number | null;
  hourly_drops: unknown;
  observation_days_by_hour: unknown;
  profile_date: string | null;
  source_days: number | null;
  source_end: string | null;
  source_start: string | null;
  timezone: string | null;
};

export type TemperatureDropProfile = Omit<
  TemperatureDropProfileRow,
  "hourly_drops" | "observation_days_by_hour"
> & {
  hourlyDrops: HourlyTemperatureDropProfile;
  observationDaysByHour: Record<number, number>;
};

export type TemperatureDropProfileSource =
  | "supabase-30-day"
  | "local-7-day";

export type SelectedTemperatureDropProfile = {
  generalFallback: number;
  hourlyTemperatureDropProfile: HourlyTemperatureDropProfile;
  profileAgeDays: number | null;
  profileDate: string | null;
  profileSource: TemperatureDropProfileSource;
};

const profileMaxAgeDays = 14;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const temperatureDropProfileColumns = [
  "profile_date",
  "timezone",
  "source_start",
  "source_end",
  "source_days",
  "hourly_drops",
  "observation_days_by_hour",
  "general_fallback",
  "algorithm_version",
  "created_at",
].join(",");

function parseHourRecord(
  value: unknown,
  allowDecimals: boolean,
): Record<number, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (Object.keys(record).length !== 24) {
    return null;
  }

  const entries = Array.from({ length: 24 }, (_, hour) => {
    const item = record[String(hour)];

    if (
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      item < 0 ||
      (!allowDecimals && !Number.isInteger(item))
    ) {
      return null;
    }

    return [hour, item] as const;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as [number, number][]);
}

export function parseTemperatureDropProfile(
  value: TemperatureDropProfileRow,
): TemperatureDropProfile | null {
  const hourlyDrops = parseHourRecord(value.hourly_drops, true);
  const observationDaysByHour = parseHourRecord(
    value.observation_days_by_hour,
    false,
  );

  if (
    value.timezone !== "Europe/Helsinki" ||
    !value.profile_date ||
    !value.created_at ||
    typeof value.general_fallback !== "number" ||
    !Number.isFinite(value.general_fallback) ||
    value.general_fallback < 0 ||
    !hourlyDrops ||
    !observationDaysByHour
  ) {
    return null;
  }

  return {
    ...value,
    hourlyDrops,
    observationDaysByHour,
  };
}

export function getTemperatureDropProfileAgeDays(
  profile: TemperatureDropProfile,
  now = new Date(),
) {
  const timestamps = [profile.created_at, profile.profile_date]
    .map((value) => new Date(value ?? "").getTime())
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0 || Number.isNaN(now.getTime())) {
    return null;
  }

  return Math.max(0, (now.getTime() - Math.max(...timestamps)) / millisecondsPerDay);
}

export function isTemperatureDropProfileFresh(
  profile: TemperatureDropProfile,
  now = new Date(),
) {
  const ageDays = getTemperatureDropProfileAgeDays(profile, now);

  return ageDays !== null && ageDays <= profileMaxAgeDays;
}

export function selectTemperatureDropProfile({
  localGeneralFallback,
  localProfile,
  now = new Date(),
  supabaseProfile,
}: {
  localGeneralFallback?: number;
  localProfile: HourlyTemperatureDropProfile;
  now?: Date;
  supabaseProfile: TemperatureDropProfile | null;
}): SelectedTemperatureDropProfile {
  const profileAgeDays = supabaseProfile
    ? getTemperatureDropProfileAgeDays(supabaseProfile, now)
    : null;

  if (supabaseProfile && isTemperatureDropProfileFresh(supabaseProfile, now)) {
    return {
      generalFallback:
        supabaseProfile.general_fallback ?? fallbackHourlyTemperatureDrop,
      hourlyTemperatureDropProfile: supabaseProfile.hourlyDrops,
      profileAgeDays,
      profileDate: supabaseProfile.profile_date,
      profileSource: "supabase-30-day",
    };
  }

  return {
    generalFallback:
      localGeneralFallback ?? fallbackHourlyTemperatureDrop,
    hourlyTemperatureDropProfile: localProfile,
    profileAgeDays,
    profileDate: supabaseProfile?.profile_date ?? null,
    profileSource: "local-7-day",
  };
}

export function getTemperatureDropProfileHours(
  profile: TemperatureDropProfile,
) {
  return Array.from({ length: 24 }, (_, hour) => ({
    drop: profile.hourlyDrops[hour],
    hour,
    observationDays: profile.observationDaysByHour[hour],
  }));
}

export async function fetchLatestTemperatureDropProfile(
  client: SupabaseClient,
) {
  const { data, error } = await client
    .from("temperature_drop_profiles")
    .select(temperatureDropProfileColumns)
    .eq("timezone", "Europe/Helsinki")
    .order("profile_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const profile = parseTemperatureDropProfile(
    data as unknown as TemperatureDropProfileRow,
  );

  if (!profile) {
    throw new Error("Invalid temperature drop profile returned by Supabase");
  }

  return profile;
}

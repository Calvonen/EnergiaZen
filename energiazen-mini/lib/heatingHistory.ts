export type HeatingHistoryReading = {
  created_at?: string | null;
  heating?: boolean | null;
};

export type HeatingEnergyPeriod = {
  duration_minutes: number;
  ended_at: string;
  energy_source: "estimated" | "measured";
  estimated_energy_kwh: number;
  measured_energy_kwh: number | null;
  started_at: string;
};

export type HeatingEnergyConsumptionSummary = {
  energy_source: "estimated" | "measured";
  estimated_energy_kwh: number;
  measured_energy_kwh: number | null;
  periods: HeatingEnergyPeriod[];
  today_estimated_energy_kwh: number;
  today_measured_energy_kwh: number | null;
};

export type HeatingPeriodRpcRow = {
  duration_minutes?: number | null;
  end_time?: string | null;
  start_time?: string | null;
};

const defaultHeaterPowerKw = 3.0;
const defaultMaxHeatingSampleGapMinutes = 10;
const helsinkiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

type HeatingHistoryPage = {
  data: HeatingHistoryReading[] | null;
  error: unknown | null;
};

export async function fetchAllHeatingHistory(
  fetchPage: (from: number, to: number) => Promise<HeatingHistoryPage>,
  pageSize = 1000,
) {
  const readings: HeatingHistoryReading[] = [];
  let pageCount = 0;

  while (true) {
    const from = pageCount * pageSize;
    const { data, error } = await fetchPage(from, from + pageSize - 1);

    if (error) {
      throw error;
    }

    const page = data ?? [];
    readings.push(...page);
    pageCount += 1;

    if (page.length < pageSize) {
      break;
    }
  }

  readings.sort((first, second) =>
    String(first.created_at ?? "").localeCompare(
      String(second.created_at ?? ""),
    ),
  );

  return { pageCount, readings };
}

export function calculateRealizedHeatingHours(
  readings: HeatingHistoryReading[],
  todayKey: string,
  yesterdayKey: string,
  getDateKey: (createdAt: string) => string,
  getHour: (createdAt: string) => number,
) {
  const heatingHourCounts = {
    today: new Map<number, number>(),
    yesterday: new Map<number, number>(),
  };

  for (const reading of readings) {
    if (!reading.created_at || reading.heating !== true) {
      continue;
    }

    const dateKey = getDateKey(reading.created_at);
    const day =
      dateKey === todayKey
        ? "today"
        : dateKey === yesterdayKey
          ? "yesterday"
          : null;

    if (day) {
      const hour = getHour(reading.created_at);
      heatingHourCounts[day].set(
        hour,
        (heatingHourCounts[day].get(hour) ?? 0) + 1,
      );
    }
  }

  return {
    today: [...heatingHourCounts.today]
      .filter(([, count]) => count >= 5)
      .map(([hour]) => hour)
      .sort((a, b) => a - b),
    yesterday: [...heatingHourCounts.yesterday]
      .filter(([, count]) => count >= 5)
      .map(([hour]) => hour)
      .sort((a, b) => a - b),
  };
}

function toValidHeatingReading(reading: HeatingHistoryReading) {
  if (!reading.created_at || typeof reading.heating !== "boolean") {
    return null;
  }

  const timestamp = new Date(reading.created_at).getTime();

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return {
    created_at: reading.created_at,
    heating: reading.heating,
    timestamp,
  };
}

function buildHeatingEnergyPeriod({
  endedAt,
  heaterPowerKw,
  startedAt,
}: {
  endedAt: { created_at: string; timestamp: number };
  heaterPowerKw: number;
  startedAt: { created_at: string; timestamp: number };
}): HeatingEnergyPeriod {
  const durationMinutes = Math.max(
    0,
    (endedAt.timestamp - startedAt.timestamp) / (60 * 1000),
  );

  return {
    duration_minutes: durationMinutes,
    ended_at: endedAt.created_at,
    energy_source: "estimated",
    estimated_energy_kwh: (durationMinutes / 60) * heaterPowerKw,
    measured_energy_kwh: null,
    started_at: startedAt.created_at,
  };
}

function summarizeHeatingEnergyPeriods({
  getDateKey,
  periods,
  todayKey,
}: {
  getDateKey: (createdAt: string) => string;
  periods: HeatingEnergyPeriod[];
  todayKey: string;
}): HeatingEnergyConsumptionSummary {
  const todayPeriods = periods.filter(
    (period) => getDateKey(period.started_at) === todayKey,
  );
  const todayEstimatedEnergyKwh = todayPeriods.reduce(
    (sum, period) => sum + period.estimated_energy_kwh,
    0,
  );

  return {
    energy_source: "estimated",
    estimated_energy_kwh: periods.reduce(
      (sum, period) => sum + period.estimated_energy_kwh,
      0,
    ),
    measured_energy_kwh: null,
    periods,
    today_estimated_energy_kwh: todayEstimatedEnergyKwh,
    today_measured_energy_kwh: null,
  };
}

export function mapHeatingPeriodRowsToEnergyConsumption({
  getDateKey = (createdAt) => helsinkiDateFormatter.format(new Date(createdAt)),
  heaterPowerKw = defaultHeaterPowerKw,
  rows,
  todayKey,
}: {
  getDateKey?: (createdAt: string) => string;
  heaterPowerKw?: number;
  rows: HeatingPeriodRpcRow[];
  todayKey: string;
}): HeatingEnergyConsumptionSummary {
  const periods = rows
    .map((row): HeatingEnergyPeriod | null => {
      if (!row.start_time || !row.end_time) {
        return null;
      }

      const startedAt = new Date(row.start_time).getTime();
      const endedAt = new Date(row.end_time).getTime();

      if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
        return null;
      }

      const fallbackDurationMinutes = Math.max(
        0,
        (endedAt - startedAt) / (60 * 1000),
      );
      const durationMinutes =
        typeof row.duration_minutes === "number" &&
        Number.isFinite(row.duration_minutes)
          ? Math.max(0, row.duration_minutes)
          : fallbackDurationMinutes;

      return {
        duration_minutes: durationMinutes,
        ended_at: row.end_time,
        energy_source: "estimated",
        estimated_energy_kwh: (durationMinutes / 60) * heaterPowerKw,
        measured_energy_kwh: null,
        started_at: row.start_time,
      };
    })
    .filter((period): period is HeatingEnergyPeriod => period !== null)
    .sort((first, second) =>
      first.started_at.localeCompare(second.started_at),
    );

  return summarizeHeatingEnergyPeriods({
    getDateKey,
    periods,
    todayKey,
  });
}

export function calculateHeatingEnergyConsumption({
  getDateKey = (createdAt) => helsinkiDateFormatter.format(new Date(createdAt)),
  heaterPowerKw = defaultHeaterPowerKw,
  maxSampleGapMinutes = defaultMaxHeatingSampleGapMinutes,
  readings,
  todayKey,
}: {
  getDateKey?: (createdAt: string) => string;
  heaterPowerKw?: number;
  maxSampleGapMinutes?: number;
  readings: HeatingHistoryReading[];
  todayKey: string;
}): HeatingEnergyConsumptionSummary {
  const maxSampleGapMs = Math.max(0, maxSampleGapMinutes) * 60 * 1000;
  const heatingReadings = readings
    .map(toValidHeatingReading)
    .filter((reading): reading is NonNullable<typeof reading> => reading !== null)
    .sort((first, second) => first.timestamp - second.timestamp);
  const periods: HeatingEnergyPeriod[] = [];
  let periodStart: (typeof heatingReadings)[number] | null = null;
  let previousReading: (typeof heatingReadings)[number] | null = null;

  for (const reading of heatingReadings) {
    const sampleGapMs = previousReading
      ? reading.timestamp - previousReading.timestamp
      : 0;
    const hasExceededSampleGap = previousReading && sampleGapMs > maxSampleGapMs;

    if (periodStart && previousReading && hasExceededSampleGap) {
      periods.push(
        buildHeatingEnergyPeriod({
          endedAt: previousReading,
          heaterPowerKw,
          startedAt: periodStart,
        }),
      );
      periodStart = null;
    }

    if (reading.heating) {
      if (!periodStart) {
        periodStart = reading;
      }

      previousReading = reading;
      continue;
    }

    if (periodStart && previousReading && !hasExceededSampleGap) {
      periods.push(
        buildHeatingEnergyPeriod({
          endedAt: reading,
          heaterPowerKw,
          startedAt: periodStart,
        }),
      );
      periodStart = null;
    }

    previousReading = reading;
  }

  if (periodStart && previousReading) {
    periods.push(
      buildHeatingEnergyPeriod({
        endedAt: previousReading,
        heaterPowerKw,
        startedAt: periodStart,
      }),
    );
  }

  return summarizeHeatingEnergyPeriods({
    getDateKey,
    periods,
    todayKey,
  });
}

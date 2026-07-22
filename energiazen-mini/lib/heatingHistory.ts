export type HeatingHistoryReading = {
  created_at?: string | null;
  heating?: boolean | null;
};

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

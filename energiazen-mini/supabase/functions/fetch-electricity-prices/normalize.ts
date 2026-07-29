export const electricityPriceConflictColumns =
  "region,starts_at,resolution_minutes";

export type SpotPriceSourceRow = {
  DateTime?: unknown;
  PriceNoTax?: unknown;
  PriceWithTax?: unknown;
  StartDate?: unknown;
  startDate?: unknown;
};

export type ElectricityPriceUpsertRow = {
  end_date: string;
  ends_at: string;
  fetched_at: string;
  price: number;
  price_date: string;
  region: string;
  resolution_minutes: 15 | 60;
  spot_price_cents_kwh: number;
  start_date: string;
  starts_at: string;
};

const helsinkiDateFormatter = new Intl.DateTimeFormat("sv-SE", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

export function getHelsinkiPriceDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return helsinkiDateFormatter.format(date);
}

export function getPriceResolutionMinutes(startsAt: string, endsAt: string) {
  const duration = Date.parse(endsAt) - Date.parse(startsAt);
  return Number.isFinite(duration) ? Math.round(duration / 60_000) : null;
}

export function getElectricityPriceConflictKey(
  row: Pick<
    ElectricityPriceUpsertRow,
    "region" | "resolution_minutes" | "starts_at"
  >,
) {
  return `${row.region}|${new Date(row.starts_at).toISOString()}|${row.resolution_minutes}`;
}

function normalizePriceToCents(value: number) {
  // Vastaa sovelluksen nykyistä spot-hinta.fi-normalisointia.
  return value < 1 ? value * 100 : value;
}

export function normalizeSpotPriceResponse(
  sourceData: unknown,
  {
    fetchedAt,
    region = "FI",
    resolutionMinutes,
  }: {
    fetchedAt: string;
    region?: string;
    resolutionMinutes: 15 | 60;
  },
) {
  if (!Array.isArray(sourceData) || !Number.isFinite(Date.parse(fetchedAt))) {
    return [];
  }

  const rows = sourceData.flatMap((source): ElectricityPriceUpsertRow[] => {
    if (!source || typeof source !== "object") {
      return [];
    }

    const item = source as SpotPriceSourceRow;
    const startValue = item.startDate ?? item.StartDate ?? item.DateTime;
    const priceValue = item.PriceWithTax ?? item.PriceNoTax;
    if (typeof startValue !== "string" || typeof priceValue !== "number") {
      return [];
    }

    const start = new Date(startValue);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(priceValue)) {
      return [];
    }

    const startsAt = start.toISOString();
    const endsAt = new Date(
      start.getTime() + resolutionMinutes * 60_000,
    ).toISOString();
    const priceDate = getHelsinkiPriceDate(start);
    if (!priceDate) {
      return [];
    }

    const spotPriceCentsPerKwh = normalizePriceToCents(priceValue);
    return [{
      end_date: endsAt,
      ends_at: endsAt,
      fetched_at: new Date(fetchedAt).toISOString(),
      price: spotPriceCentsPerKwh,
      price_date: priceDate,
      region,
      resolution_minutes: resolutionMinutes,
      spot_price_cents_kwh: spotPriceCentsPerKwh,
      start_date: startsAt,
      starts_at: startsAt,
    }];
  });

  return [
    ...new Map(
      rows.map((row) => [getElectricityPriceConflictKey(row), row]),
    ).values(),
  ].sort((first, second) => first.starts_at.localeCompare(second.starts_at));
}

export function selectCurrentAndNextAvailableDays(
  rows: ElectricityPriceUpsertRow[],
  now = new Date(),
) {
  const currentDate = getHelsinkiPriceDate(now);
  if (!currentDate) {
    return [];
  }

  const availableDates = [
    ...new Set(rows.map((row) => row.price_date)),
  ].sort();
  const nextAvailableDate = availableDates.find((date) => date > currentDate);
  const selectedDates = new Set(
    [currentDate, nextAvailableDate].filter(
      (date): date is string => typeof date === "string",
    ),
  );

  return rows.filter((row) => selectedDates.has(row.price_date));
}

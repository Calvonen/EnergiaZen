import { getHelsinkiHourNumber, HourlyPrice } from "./heatingLogic";

export function normalizePriceToCents(value: number) {
  return value < 1 ? value * 100 : value;
}

export function getSortedUniqueHelsinkiHourNumbers(
  prices: Pick<HourlyPrice, "date">[],
) {
  return [...new Set(prices.map((item) => getHelsinkiHourNumber(item.date)))].sort(
    (a, b) => a - b,
  );
}

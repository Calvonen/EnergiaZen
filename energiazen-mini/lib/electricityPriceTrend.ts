import { offsetDateKey } from "./electricityPrices";

export type ElectricityPriceTrendData = "all" | "heated";

export type ElectricityPriceTrendPoint = {
  dateKey: string;
  value: number | null;
};

export type ElectricityPriceTrend = {
  average: number | null;
  axisMaximum: number;
  axisMinimum: number;
  axisTicks: number[];
  dateLabels: { dateKey: string; index: number; label: string }[];
  highest: number | null;
  latest: number | null;
  lowest: number | null;
  points: ElectricityPriceTrendPoint[];
};

function getNiceStep(rawStep: number) {
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const fraction = rawStep / magnitude;
  const niceFraction = [1, 1.5, 2, 2.5, 5, 10].find(
    (candidate) => candidate >= fraction,
  ) ?? 10;

  return niceFraction * magnitude;
}

export function buildPriceAxis(values: number[]) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) {
    return { maximum: 1, minimum: 0, ticks: [] as number[] };
  }

  const dataMinimum = Math.min(...finiteValues);
  const dataMaximum = Math.max(...finiteValues);
  const dataSpan = dataMaximum - dataMinimum;
  const padding =
    dataSpan > 0
      ? dataSpan * 0.12
      : Math.max(Math.abs(dataMinimum) * 0.05, 0.5);
  const paddedMinimum = dataMinimum - padding;
  const paddedMaximum = dataMaximum + padding;
  let step = getNiceStep((paddedMaximum - paddedMinimum) / 4);
  let minimum = Math.floor(paddedMinimum / step) * step;
  let maximum = Math.ceil(paddedMaximum / step) * step;
  let intervalCount = Math.round((maximum - minimum) / step);

  while (intervalCount > 4) {
    step = getNiceStep(step * 1.01);
    minimum = Math.floor(paddedMinimum / step) * step;
    maximum = Math.ceil(paddedMaximum / step) * step;
    intervalCount = Math.round((maximum - minimum) / step);
  }

  while (intervalCount < 3) {
    const addBelow = dataMinimum - minimum <= maximum - dataMaximum;
    if (addBelow) {
      minimum -= step;
    } else {
      maximum += step;
    }
    intervalCount += 1;
  }

  const precision = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const round = (value: number) => Number(value.toFixed(precision));
  const ticks = Array.from({ length: intervalCount + 1 }, (_, index) =>
    round(minimum + index * step),
  );

  return {
    maximum: ticks[ticks.length - 1],
    minimum: ticks[0],
    ticks,
  };
}

function formatShortDate(dateKey: string) {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${day}.${month}.`;
}

export function buildTrendDateLabels(
  points: ElectricityPriceTrendPoint[],
) {
  const indices =
    points.length <= 7
      ? points.map((_, index) => index)
      : points
          .map((_, index) => index)
          .filter(
            (index) =>
              index === 0 || index === points.length - 1 || index % 5 === 0,
          );

  return indices.map((index) => ({
    dateKey: points[index].dateKey,
    index,
    label: formatShortDate(points[index].dateKey),
  }));
}

export function buildElectricityPriceTrend({
  dataFilter,
  heatedDays,
  priceDays,
  range,
  todayKey,
}: {
  dataFilter: ElectricityPriceTrendData;
  heatedDays: { dateKey: string; weightedAveragePrice: number | null }[];
  priceDays: { averageTotalPrice: number; dateKey: string }[];
  range: 7 | 30;
  todayKey: string;
}): ElectricityPriceTrend {
  const valuesByDate =
    dataFilter === "heated"
      ? new Map(
          heatedDays.map((day) => [day.dateKey, day.weightedAveragePrice]),
        )
      : new Map(priceDays.map((day) => [day.dateKey, day.averageTotalPrice]));
  const points = Array.from({ length: range }, (_, index) => {
    const dateKey = offsetDateKey(todayKey, index - range + 1);
    const value = valuesByDate.get(dateKey);

    return {
      dateKey,
      value:
        typeof value === "number" && Number.isFinite(value) ? value : null,
    };
  });
  const validValues = points.flatMap((point) =>
    point.value === null ? [] : [point.value],
  );
  const axis = buildPriceAxis(validValues);

  return {
    average:
      validValues.length > 0
        ? validValues.reduce((sum, value) => sum + value, 0) /
          validValues.length
        : null,
    axisMaximum: axis.maximum,
    axisMinimum: axis.minimum,
    axisTicks: axis.ticks,
    dateLabels: buildTrendDateLabels(points),
    highest: validValues.length > 0 ? Math.max(...validValues) : null,
    latest:
      validValues.length > 0 ? validValues[validValues.length - 1] : null,
    lowest: validValues.length > 0 ? Math.min(...validValues) : null,
    points,
  };
}

import {
  defaultSettings,
  defaultTankTemperature,
  EnergiaZenSettings,
} from "@/lib/settings";

const warmWaterHoursForPlanningAtDefaultTemperature = 17;
const maintenanceHeatingHours = 1;

export type DaySelection = "yesterday" | "today" | "tomorrow";

export type HourlyPrice = {
  date: Date;
  endDate: Date;
  hourLabel: string;
  id: string;
  price: number;
};

export type HeatingPlanStatus = "completed" | "planned" | "missed";

export type HeatingPlanHour = HourlyPrice & {
  status: HeatingPlanStatus;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getWarmWaterHoursForPlanning(
  tankTemperature: number,
  settings: EnergiaZenSettings,
) {
  const defaultTemperatureRange = Math.max(
    defaultTankTemperature - settings.minTankTemperature,
    1,
  );
  const currentTemperatureRange = clamp(
    tankTemperature - settings.minTankTemperature,
    0,
    defaultTemperatureRange,
  );

  return Math.round(
    (currentTemperatureRange / defaultTemperatureRange) *
      warmWaterHoursForPlanningAtDefaultTemperature,
  );
}

const helsinkiDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

const helsinkiHourFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

export function formatHelsinkiDateKey(date: Date) {
  return helsinkiDateKeyFormatter.format(date);
}

export function getHelsinkiHourNumber(date: Date) {
  const hour = Number(helsinkiHourFormatter.format(date));

  return hour === 24 ? 0 : hour;
}

export function getCheapestHours(prices: HourlyPrice[], count: number) {
  return [...prices]
    .sort((a, b) => {
      if (a.price === b.price) {
        return a.date.getTime() - b.date.getTime();
      }

      return a.price - b.price;
    })
    .slice(0, count);
}

export function sortHoursChronologically(prices: HourlyPrice[]) {
  return [...prices].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function getAveragePrice(prices: HourlyPrice[]) {
  if (prices.length === 0) {
    return null;
  }

  return prices.reduce((sum, item) => sum + item.price, 0) / prices.length;
}

export function selectHeatingRecommendation(
  prices: HourlyPrice[],
  currentHourStart: Date,
  heatedHourNumbers: Set<number>,
  settings: EnergiaZenSettings = defaultSettings,
  tankTemperature = defaultTankTemperature,
) {
  const todayKey = formatHelsinkiDateKey(currentHourStart);
  const tomorrowKey = formatHelsinkiDateKey(
    new Date(currentHourStart.getTime() + 24 * 60 * 60 * 1000),
  );
  const todayPrices = prices.filter(
    (item) => formatHelsinkiDateKey(item.date) === todayKey,
  );
  const remainingTodayPrices = todayPrices.filter(
    (item) => item.endDate.getTime() > currentHourStart.getTime(),
  );
  const plannedTodayHours = getCheapestHours(
    todayPrices,
    settings.heatingHoursPerDay,
  );
  const completedTodayHours = sortHoursChronologically(
    todayPrices.filter(
      (item) =>
        heatedHourNumbers.has(getHelsinkiHourNumber(item.date)) &&
        item.date.getTime() <= currentHourStart.getTime(),
    ),
  ).slice(0, settings.heatingHoursPerDay);
  const completedHourIds = new Set(completedTodayHours.map((item) => item.id));
  const completedHourNumbers = new Set(
    completedTodayHours.map((item) => getHelsinkiHourNumber(item.date)),
  );
  const missedPlannedTodayHours = plannedTodayHours.filter(
    (item) =>
      !completedHourIds.has(item.id) &&
      item.endDate.getTime() <= currentHourStart.getTime(),
  );
  const remainingHeatingNeed = Math.max(
    settings.heatingHoursPerDay -
      completedTodayHours.length -
      missedPlannedTodayHours.length,
    0,
  );
  const tomorrowPrices = prices.filter(
    (item) => formatHelsinkiDateKey(item.date) === tomorrowKey,
  );
  const cheapestTodayHours = getCheapestHours(
    remainingTodayPrices,
    settings.heatingHoursPerDay,
  );
  const cheapestTomorrowHours = getCheapestHours(
    tomorrowPrices,
    settings.heatingHoursPerDay,
  );
  const averageTodayPrice = getAveragePrice(cheapestTodayHours);
  const averageTomorrowPrice =
    cheapestTomorrowHours.length === settings.heatingHoursPerDay
      ? getAveragePrice(cheapestTomorrowHours)
      : null;
  const toPlanHours = (selectedHours: HourlyPrice[]) => {
    const plannedById = new Map<string, HourlyPrice>();

    for (const item of selectedHours) {
      plannedById.set(item.id, item);
    }

    for (const item of completedTodayHours) {
      plannedById.set(item.id, item);
    }

    for (const item of missedPlannedTodayHours) {
      plannedById.set(item.id, item);
    }

    return sortHoursChronologically([...plannedById.values()]).map(
      (item): HeatingPlanHour => {
        const isCompleted = completedHourIds.has(item.id);
        const isMissed =
          !isCompleted && item.endDate.getTime() <= currentHourStart.getTime();

        return {
          ...item,
          status: isCompleted ? "completed" : isMissed ? "missed" : "planned",
        };
      },
    );
  };
  const futureCandidates = (source: HourlyPrice[]) =>
    source.filter(
      (item) =>
        item.endDate.getTime() > currentHourStart.getTime() &&
        !completedHourIds.has(item.id) &&
        !completedHourNumbers.has(getHelsinkiHourNumber(item.date)),
    );

  if (remainingHeatingNeed === 0) {
    return {
      hours: toPlanHours([]),
      realizedHours: completedTodayHours.length,
      reason: `Päivän ${settings.heatingHoursPerDay} h lämmitystavoite on täynnä`,
    };
  }

  if (averageTomorrowPrice === null || averageTodayPrice === null) {
    return {
      hours: toPlanHours(
        getCheapestHours(
          futureCandidates(remainingTodayPrices),
          remainingHeatingNeed,
        ),
      ),
      realizedHours: completedTodayHours.length,
      reason: `Normaali ${settings.heatingHoursPerDay} h lämmitys`,
    };
  }

  const firstCheapTomorrowHour = sortHoursChronologically(
    cheapestTomorrowHours,
  )[0];
  const hoursUntilFirstCheapTomorrow = Math.max(
    0,
    Math.ceil(
      (firstCheapTomorrowHour.date.getTime() - currentHourStart.getTime()) /
        (60 * 60 * 1000),
    ),
  );
  const warmWaterHoursForPlanning = getWarmWaterHoursForPlanning(
    tankTemperature,
    settings,
  );
  const warmWaterCanWait =
    warmWaterHoursForPlanning >= hoursUntilFirstCheapTomorrow;
  const tomorrowIsClearlyCheaper =
    averageTodayPrice - averageTomorrowPrice >
    settings.priceDifferenceThresholdCents;

  if (tomorrowIsClearlyCheaper && warmWaterCanWait) {
    return {
      hours: toPlanHours(
        getCheapestHours(
          futureCandidates(remainingTodayPrices),
          Math.min(maintenanceHeatingHours, remainingHeatingNeed),
        ),
      ),
      realizedHours: completedTodayHours.length,
      reason: "Huomenna selvästi halvempaa – säästetään varaajaa",
    };
  }

  const acceptableTodayHours = remainingTodayPrices.filter(
    (item) =>
      item.price <
      averageTomorrowPrice + settings.priceDifferenceThresholdCents,
  );
  const selectedHours = getCheapestHours(
    futureCandidates(
      acceptableTodayHours.length >= remainingHeatingNeed
        ? acceptableTodayHours
        : remainingTodayPrices,
    ),
    remainingHeatingNeed,
  );
  const todayIsClearlyCheaper =
    averageTomorrowPrice - averageTodayPrice >
    settings.priceDifferenceThresholdCents;

  return {
    hours: toPlanHours(selectedHours),
    realizedHours: completedTodayHours.length,
    reason: todayIsClearlyCheaper
      ? "Tänään edullisempaa kuin huomenna"
      : `Normaali ${settings.heatingHoursPerDay} h lämmitys`,
  };
}

import {
  defaultSettings,
  defaultTankTemperature,
  EnergiaZenSettings,
} from "./settingsDefaults";
import { selectRemainingFixedHeatingHours } from "./fixedHeatingPlan";

const maintenanceHeatingHours = 1;

function getTemperatureBasedHeatingNeed(tankTemperature: number) {
  if (tankTemperature < 50) {
    return {
      hours: 3,
      reason: "Varaaja alle 50 °C → 3 h lämmitys",
    };
  }

  if (tankTemperature < 65) {
    return {
      hours: 2,
      reason: "Varaaja 50–64 °C → 2 h lämmitys",
    };
  }

  return {
    hours: 1,
    reason: "Varaaja yli 65 °C → 1 h lämmitys",
  };
}

export function getEffectiveHeatingHours(
  settings: EnergiaZenSettings = defaultSettings,
  tankTemperature = defaultTankTemperature,
) {
  return Math.min(
    settings.automaticMaxHeatingHours,
    getTemperatureBasedHeatingNeed(tankTemperature).hours,
  );
}

export type DaySelection = "yesterday" | "today" | "tomorrow";

export type HourlyPrice = {
  date: Date;
  startDate: string;
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

export function getHeatingNeedFromShowers(
  showersLeft: number,
  settings: EnergiaZenSettings = defaultSettings,
) {
  const fullTankShowers = Math.max(settings.fullTankShowers, 1);
  const fillRatio = clamp(showersLeft / fullTankShowers, 0, 1);

  if (fillRatio < 0.6) {
    return {
      fillRatio,
      hours: Math.min(
        settings.automaticMaxHeatingHours,
        settings.automaticMaxHeatingHours,
      ),
      reason: "Varaus alle 60 % → täysi lämmitystarve",
    };
  }

  if (fillRatio < 0.85) {
    return {
      fillRatio,
      hours: Math.min(settings.automaticMaxHeatingHours, 2),
      reason: "Varaus 60–84 % → enintään 2 h lämmitys",
    };
  }

  if (fillRatio < 0.95) {
    return {
      fillRatio,
      hours: Math.min(settings.automaticMaxHeatingHours, 1),
      reason: "Varaus 85–94 % → enintään 1 h lämmitys",
    };
  }

  return {
    fillRatio,
    hours: 0,
    reason: "Varaus vähintään 95 % → ei lämmitystarvetta",
  };
}

const helsinkiDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

const helsinkiDatePartsFormatter = new Intl.DateTimeFormat("en-CA", {
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

export function getFinnishDateKey(dateString: string): string {
  return helsinkiDateKeyFormatter.format(new Date(dateString));
}

export function getDateKeyOffset(offsetDays: number, date = new Date()): string {
  const parts = helsinkiDatePartsFormatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    return helsinkiDateKeyFormatter.format(date);
  }

  const offsetDate = new Date(Date.UTC(year, month - 1, day + offsetDays));

  return [
    String(offsetDate.getUTCFullYear()),
    String(offsetDate.getUTCMonth() + 1).padStart(2, "0"),
    String(offsetDate.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function formatHelsinkiDateKey(date: Date) {
  return getFinnishDateKey(date.toISOString());
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

function formatFinnishDecimal(value: number) {
  return value.toLocaleString("fi-FI", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  });
}

function getAutomaticHeatingReasonPrefix(
  showerHeatingNeed: ReturnType<typeof getHeatingNeedFromShowers> | null,
  temperatureBasedHeatingNeed: ReturnType<typeof getTemperatureBasedHeatingNeed>,
) {
  if (!showerHeatingNeed) {
    return temperatureBasedHeatingNeed.reason;
  }

  const fillPercent = Math.round(showerHeatingNeed.fillRatio * 100);

  if (showerHeatingNeed.hours === 0) {
    return `Varaus ${fillPercent} % → ei lämmitystarvetta`;
  }

  return `Varaus ${fillPercent} % → ${showerHeatingNeed.hours} h lämmitys`;
}

function getTodayHeatingReason(
  heatingReason: string,
  tomorrowPriceDifference: number,
  warmWaterCanWait: boolean,
  targetShowerReserve: number,
) {
  const priceDifferenceReason =
    tomorrowPriceDifference >= 0
      ? `Huominen on ${formatFinnishDecimal(
          tomorrowPriceDifference,
        )} snt/kWh halvempi`
      : `Huominen on ${formatFinnishDecimal(
          Math.abs(tomorrowPriceDifference),
        )} snt/kWh kalliimpi`;
  const reserveReason = warmWaterCanWait
    ? "varausta on riittävästi"
    : `varausta on alle ${targetShowerReserve} suihkua`;
  const conjunction = warmWaterCanWait ? "ja" : "mutta";

  return `${heatingReason}. ${priceDifferenceReason} ${conjunction} ${reserveReason}, joten lämmitys tehdään tänään.`;
}

export function selectHeatingRecommendation(
  prices: HourlyPrice[],
  currentHourStart: Date,
  heatedHourNumbers: Set<number>,
  settings: EnergiaZenSettings = defaultSettings,
  tankTemperature = defaultTankTemperature,
  showersLeft: number | null = null,
  minimumAutomaticHeatingHours = 0,
) {
  const temperatureBasedHeatingNeed =
    getTemperatureBasedHeatingNeed(tankTemperature);
  const showerHeatingNeed =
    showersLeft !== null && Number.isFinite(showersLeft)
      ? getHeatingNeedFromShowers(showersLeft, settings)
      : null;
  const temperatureBasedEffectiveHeatingHours = getEffectiveHeatingHours(
    settings,
    tankTemperature,
  );
  const isFixedHeatingNeed = settings.heatingNeedMode === "fixed";
  const automaticBaseHeatingHours =
    showerHeatingNeed?.hours ?? temperatureBasedEffectiveHeatingHours;
  const automaticEffectiveHeatingHours = Math.max(
    automaticBaseHeatingHours,
    minimumAutomaticHeatingHours,
  );
  const { effectiveHeatingHours, heatingReason } =
    isFixedHeatingNeed
      ? {
          effectiveHeatingHours: settings.fixedHeatingHoursPerDay,
          heatingReason: `Kiinteä lämmitys ${settings.fixedHeatingHoursPerDay} h/vrk vuorokauden halvimmilla tunneilla.`,
        }
      : {
          effectiveHeatingHours: automaticEffectiveHeatingHours,
          heatingReason:
            automaticEffectiveHeatingHours > automaticBaseHeatingHours
              ? `Ennuste seuraavan lämmityksen alkuun → ${automaticEffectiveHeatingHours} h lämmitys`
              : getAutomaticHeatingReasonPrefix(
                  showerHeatingNeed,
                  temperatureBasedHeatingNeed,
                ),
        };
  const todayKey = formatHelsinkiDateKey(currentHourStart);
  const todayPrices = prices.filter(
    (item) => formatHelsinkiDateKey(item.date) === todayKey,
  );
  const remainingTodayPrices = todayPrices.filter(
    (item) => item.endDate.getTime() > currentHourStart.getTime(),
  );
  const plannedTodayHours = getCheapestHours(
    todayPrices,
    effectiveHeatingHours,
  );
  const completedTodayHours = sortHoursChronologically(
    todayPrices.filter(
      (item) =>
        heatedHourNumbers.has(getHelsinkiHourNumber(item.date)) &&
        item.date.getTime() <= currentHourStart.getTime(),
    ),
  );
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
    effectiveHeatingHours -
      completedTodayHours.length -
      (isFixedHeatingNeed ? 0 : missedPlannedTodayHours.length),
    0,
  );
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
      reason: heatingReason,
      targetHours: effectiveHeatingHours,
    };
  }

  if (isFixedHeatingNeed) {
    return {
      hours: toPlanHours(
        selectRemainingFixedHeatingHours({
          completedHeatingHours: completedTodayHours.length,
          fixedHeatingHoursPerDay: settings.fixedHeatingHoursPerDay,
          hours: futureCandidates(remainingTodayPrices),
          now: currentHourStart,
        }),
      ),
      realizedHours: completedTodayHours.length,
      reason: heatingReason,
      targetHours: effectiveHeatingHours,
    };
  }

  const tomorrowKey = formatHelsinkiDateKey(
    new Date(currentHourStart.getTime() + 24 * 60 * 60 * 1000),
  );
  const tomorrowPrices = prices.filter(
    (item) => formatHelsinkiDateKey(item.date) === tomorrowKey,
  );
  const cheapestTodayHours = getCheapestHours(
    remainingTodayPrices,
    effectiveHeatingHours,
  );
  const cheapestTomorrowHours = getCheapestHours(
    tomorrowPrices,
    effectiveHeatingHours,
  );
  const averageTodayPrice = getAveragePrice(cheapestTodayHours);
  const averageTomorrowPrice =
    cheapestTomorrowHours.length === effectiveHeatingHours
      ? getAveragePrice(cheapestTomorrowHours)
      : null;

  if (averageTomorrowPrice === null || averageTodayPrice === null) {
    return {
      hours: toPlanHours(
        getCheapestHours(
          futureCandidates(remainingTodayPrices),
          remainingHeatingNeed,
        ),
      ),
      realizedHours: completedTodayHours.length,
      reason: `${heatingReason}. Tämän ja huomisen halvimpien tuntien keskihintaeroa ei voitu laskea, joten lämmitys tehdään tänään.`,
      targetHours: effectiveHeatingHours,
    };
  }

  const warmWaterCanWait =
    showersLeft !== null &&
    Number.isFinite(showersLeft) &&
    showersLeft >= settings.targetShowerReserve;
  const tomorrowIsClearlyCheaper =
    averageTodayPrice - averageTomorrowPrice >
    settings.priceDifferenceThresholdCents;
  const tomorrowPriceDifference = averageTodayPrice - averageTomorrowPrice;

  if (tomorrowIsClearlyCheaper && warmWaterCanWait) {
    return {
      hours: toPlanHours(
        getCheapestHours(
          futureCandidates(remainingTodayPrices),
          Math.min(maintenanceHeatingHours, remainingHeatingNeed),
        ),
      ),
      realizedHours: completedTodayHours.length,
      reason: `${heatingReason}. Huominen on ${formatFinnishDecimal(
        tomorrowPriceDifference,
      )} snt/kWh halvempi ja varausta on riittävästi, joten lämmitys siirrettiin huomiseen.`,
      targetHours: effectiveHeatingHours,
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
  return {
    hours: toPlanHours(selectedHours),
    realizedHours: completedTodayHours.length,
    reason: getTodayHeatingReason(
      heatingReason,
      tomorrowPriceDifference,
      warmWaterCanWait,
      settings.targetShowerReserve,
    ),
    targetHours: effectiveHeatingHours,
  };
}

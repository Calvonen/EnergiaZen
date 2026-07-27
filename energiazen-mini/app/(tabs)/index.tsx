import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import {
  Animated,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { debugLog } from "@/lib/debug";
import {
  electricityPriceRegion,
  getHelsinkiElectricityDateKey,
  getResolutionMinutes,
  getTotalPriceCentsPerKwh,
} from "@/lib/electricityPrices";
import {
  calculatePlannedHeatingHourCostEuros,
} from "@/lib/heatingEnergyCost";
import {
  calculateHeatingEnergyConsumption,
  calculateRealizedHeatingHours,
  fetchAllHeatingHistory,
} from "@/lib/heatingHistory";
import {
  fallbackHeatingGainPerHour,
  fetchHeatingGainHistory,
  heatingGainHistoryDays,
} from "@/lib/heatingGain";
import {
  getHeatingHourMarker,
  heatingMarkers,
  normalizeStoredHeatingPlanHours,
} from "@/lib/heatingPlanMarkers";
import {
  calculateStratifiedShowersLeft,
  HeatingOptimizationHour,
  HeatingOptimizationResult,
} from "@/lib/heatingOptimizer";
import { useHeatingOptimizationRun } from "@/lib/useHeatingOptimizationRun";
import {
  buildHeatingPlanPresentation,
  buildStoredHeatingPlanPresentation,
  hasCheaperSafetyRejectedPlan,
} from "@/lib/heatingPlanPresentation";
import {
  canPublishActiveHeatingPlan,
  getChangedHeatingPlans,
  getHeatingPlanPresentationSource,
} from "@/lib/heatingPlanPublication";
import {
  DaySelection,
  getCheapestHours,
  getDateKeyOffset,
  getFinnishDateKey,
  getHelsinkiHourNumber,
  HourlyPrice,
  selectHeatingRecommendation,
  sortHoursChronologically,
} from "@/lib/heatingLogic";
import {
  defaultSettings,
  defaultTankTemperature,
  EnergiaZenSettings,
} from "@/lib/settings";
import { validateSettingsDraft } from "@/lib/settingsDraft";
import { useSettingsScenario } from "@/lib/settingsScenarioContext";
import { supabase } from "@/lib/supabase";
import {
  buildHourlyTemperatureDropProfileResult,
  getCurrentWeightedTemperature,
  getForecastTargetHeatingStart,
  getForecastHeatingHours,
  isHeatingShiftedToTomorrow,
  predictWeightedTemperature,
  TankTemperatureReading,
} from "@/lib/tankTemperatureForecast";
import {
  fetchLatestTemperatureDropProfile,
  selectTemperatureDropProfile,
  TemperatureDropProfile,
} from "@/lib/temperatureDropProfile";

const DEBUG_HISTORY_PERFORMANCE = false;
const DEBUG_HOME_DAY_TAB_PERFORMANCE = false;

function logHistoryNavigationTap(target: "electricity-history" | "history") {
  if (!DEBUG_HISTORY_PERFORMANCE) {
    return;
  }

  console.log("[EnergyZen perf][navigation]", {
    event: "navigation tap",
    target,
    timestamp: Date.now(),
  });
}

function logHomeDayTabPerformance(
  event: string,
  data: Record<string, unknown> = {},
) {
  if (!DEBUG_HOME_DAY_TAB_PERFORMANCE) {
    return;
  }

  console.log("[EnergyZen perf][home-day-tabs]", {
    event,
    ...data,
  });
}

const priceApiUrl =
  "https://api.spot-hinta.fi/TodayAndDayForward?region=FI&priceResolution=60";
const chartPriceStep = 5;
const chartPlotHeight = 96;
const chartGridMaxPosition = chartPlotHeight - 1;
const chartMinimumBarHeight = 8;
const temperatureBarSegmentCount = 8;
const storedElectricityPriceColumns = "start_date,end_date,price";
const storedHeatingPlanColumns =
  "plan_date,planned_hours,target_hours,reason,mode,updated_at";
const helsinkiHourFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});
const helsinkiTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "Europe/Helsinki",
});
const helsinkiDateTimePartsFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

type TankReading = TankTemperatureReading & {
  showers?: number | null;
};

type SpotPriceResponse = {
  DateTime?: string | null;
  StartDate?: string | null;
  startDate?: string | null;
  PriceNoTax?: number | null;
  PriceWithTax?: number | null;
};

type StoredElectricityPrice = {
  start_date?: string | null;
  end_date?: string | null;
  price?: number | null;
};

type StoredHeatingPlan = {
  mode?: string | null;
  plan_date?: string | null;
  planned_hours?: unknown;
  reason?: string | null;
  target_hours?: number | null;
  updated_at?: string | null;
};

type ElectricityPriceInsert = {
  start_date: string;
  end_date: string;
  ends_at: string;
  fetched_at: string;
  price: number;
  price_date: string;
  region: string;
  resolution_minutes: number;
  spot_price_cents_kwh: number;
  starts_at: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function hexToRgb(hexColor: string) {
  const normalizedColor = hexColor.replace("#", "");

  return {
    r: parseInt(normalizedColor.slice(0, 2), 16),
    g: parseInt(normalizedColor.slice(2, 4), 16),
    b: parseInt(normalizedColor.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }) {
  const toHex = (channel: number) =>
    Math.round(channel).toString(16).padStart(2, "0");

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mixColors(startColor: string, endColor: string, ratio: number) {
  const start = hexToRgb(startColor);
  const end = hexToRgb(endColor);

  return rgbToHex({
    r: start.r + (end.r - start.r) * ratio,
    g: start.g + (end.g - start.g) * ratio,
    b: start.b + (end.b - start.b) * ratio,
  });
}

function getTemperatureColor(temperature: number, settings = defaultSettings) {
  const normalizedTemperature = clamp(
    temperature,
    settings.minTankTemperature,
    settings.maxTankTemperature,
  );

  const temperatureRange = Math.max(
    settings.maxTankTemperature - settings.minTankTemperature,
    1,
  );
  const greenThreshold = settings.minTankTemperature + temperatureRange / 3;
  const orangeThreshold =
    settings.minTankTemperature + (temperatureRange * 2) / 3;

  if (normalizedTemperature <= greenThreshold) {
    return mixColors(
      "#188bff",
      "#26d9a2",
      (normalizedTemperature - settings.minTankTemperature) /
        (greenThreshold - settings.minTankTemperature),
    );
  }

  if (normalizedTemperature <= orangeThreshold) {
    return mixColors(
      "#26d9a2",
      "#ff9b30",
      (normalizedTemperature - greenThreshold) /
        (orangeThreshold - greenThreshold),
    );
  }

  return mixColors(
    "#ff9b30",
    "#ff3f46",
    (normalizedTemperature - orangeThreshold) /
      (settings.maxTankTemperature - orangeThreshold),
  );
}

function getTemperatureBarSegmentColor(
  segmentIndex: number,
  segmentCount: number,
  topTemperature: number,
  bottomTemperature: number,
  settings = defaultSettings,
) {
  const ratioFromTop =
    segmentCount <= 1 ? 0 : segmentIndex / (segmentCount - 1);
  const segmentTemperature =
    topTemperature + (bottomTemperature - topTemperature) * ratioFromTop;

  return getTemperatureColor(segmentTemperature, settings);
}

function getTemperatureCardTheme(
  temperature: number,
  settings = defaultSettings,
) {
  const ratio = clamp(
    (temperature - settings.minTankTemperature) /
      (settings.maxTankTemperature - settings.minTankTemperature),
    0,
    1,
  );
  const accent = mixColors("#188bff", "#ff3f46", ratio);
  const deepAccent = mixColors("#0b4f9f", "#8f151d", ratio);

  return {
    accent,
    backgroundColor: `${accent}33`,
    borderColor: `${accent}b8`,
    shadowColor: deepAccent,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getWarmWaterEstimate(
  topTemperature: number | null,
  bottomTemperature: number | null,
  settings = defaultSettings,
) {
  if (topTemperature === null || bottomTemperature === null) {
    return null;
  }

  const fullTankTemp =
    settings.fullTankAverageTemperature ?? settings.maxTankTemperature;
  const temperatureRange = Math.max(
    fullTankTemp - settings.minTankTemperature,
    1,
  );
  const averageTemp = (topTemperature + bottomTemperature) / 2;
  const fillRatio = clamp(
    (averageTemp - settings.minTankTemperature) / temperatureRange,
    0,
    1,
  );

  return {
    averageTemp,
    fillRatio,
    showersLeft: fillRatio * settings.fullTankShowers,
    tankSizeLiters: settings.tankSizeLiters,
  };
}

// Rinnakkainen kerrostumismalli testausta varten.
function getStratifiedWarmWaterEstimate(
  topTemperature: number | null,
  bottomTemperature: number | null,
  settings = defaultSettings,
) {
  if (topTemperature === null || bottomTemperature === null) {
    return null;
  }

  const estimate = calculateStratifiedShowersLeft({
    bottomTemperature,
    fullTankAverageTemperature: settings.fullTankAverageTemperature,
    fullTankShowers: settings.fullTankShowers,
    maxTankTemperature: settings.maxTankTemperature,
    minTankTemperature: settings.minTankTemperature,
    topTemperature,
  });

  return {
    weightedTemperature: estimate.weightedTemperature,
    energyRatio: estimate.energyRatio,
    topUsability: estimate.topUsability,
    fillRatio: estimate.fillRatio,
    showersLeft: estimate.showersLeft,
    tankSizeLiters: settings.tankSizeLiters,
  };
}

function getWarmWaterCardTheme() {
  const accent = "#26d9d2";

  return {
    backgroundColor: `${accent}2b`,
    borderColor: `${accent}a8`,
    fillColor: accent,
    shadowColor: "#16bfc8",
    surfaceColor: "#d9fff9",
  };
}

function getHeatingMarkerLabel(marker: string | null) {
  if (marker === heatingMarkers.planned) {
    return "Valittu lämmitykseen";
  }

  if (marker === heatingMarkers.actual) {
    return "Lämmitys toteutui";
  }

  if (marker === heatingMarkers.missed) {
    return "Suunniteltu, ei toteutunut";
  }

  return null;
}

function getPriceTheme(price: number) {
  if (price <= 3) {
    return { ringColor: "#72ff9d" };
  }

  if (price <= 8) {
    return { ringColor: "#36f4d4" };
  }

  if (price < 15) {
    return { ringColor: "#ffad4d" };
  }

  return { ringColor: "#ff5f6d" };
}

function normalizePriceToCents(value: number) {
  return value < 1 ? value * 100 : value;
}

function getSortedUniqueHelsinkiHourNumbers(
  prices: Pick<HourlyPrice, "date">[],
) {
  return [...new Set(prices.map((item) => getHelsinkiHourNumber(item.date)))]
    .sort((a, b) => a - b);
}

function formatFinnishDecimal(value: number) {
  return value.toFixed(1).replace(".", ",");
}

function formatSignedFinnishDecimal(value: number) {
  return formatFinnishDecimal(value);
}

function splitHeatingHourLabel(label: string) {
  const [timeLabel, priceLabel, costLabel] = label.split(" · ");

  return { costLabel, priceLabel, timeLabel: timeLabel ?? label };
}

function splitPlanCostSummary(summary: string) {
  const match = summary.match(/^(Suunnitelman arvioitu hinta) (.+)$/);

  return match
    ? { label: match[1], value: match[2] }
    : { label: summary, value: null };
}

function splitForecastSummary(summary: string) {
  const match = summary.match(
    /^Nyt ([^ ]+) · alimmillaan ([^ ]+) · (.+) ([^ ]+) suihkua$/,
  );

  return match
    ? {
        currentShowers: match[1],
        endLabel: match[3],
        finalShowers: match[4],
        minimumShowers: match[2],
      }
    : null;
}

function splitLimitsSummary(summary: string) {
  const match = summary.match(
    /^Tavoite ([^ ]+) suihkua · turvaraja ([^ ]+) suihkua$/,
  );

  return match
    ? { safetyReserve: match[2], targetReserve: match[1] }
    : null;
}

function joinFinnishList(items: string[]) {
  if (items.length === 0) {
    return "";
  }

  if (items.length === 1) {
    return items[0];
  }

  return `${items.slice(0, -1).join(", ")} ja ${items[items.length - 1]}`;
}

function formatManualHeatingHours(
  day: DaySelection,
  hours: Pick<HourlyPrice, "date">[],
) {
  if (hours.length === 0) {
    return "Ei valittuja lämmitystunteja.";
  }

  return `${getDayLabel(day)} ${joinFinnishList(
    hours.map((hour) => formatHeatingHourRange(hour.date)),
  )}`;
}

function formatHourLabel(date: Date) {
  return `${helsinkiHourFormatter.format(date).replace(".", "")}:00`;
}

function formatHeatingHourRange(date: Date) {
  const startHour = getHelsinkiHourNumber(date);
  const endHour = (startHour + 1) % 24;

  return `${String(startHour).padStart(2, "0")}–${String(endHour).padStart(2, "0")}`;
}

function getForecastEndLabel({
  endDate,
  startDate,
  todayDateKey,
  tomorrowDateKey,
}: {
  endDate: Date;
  startDate: string;
  todayDateKey: string;
  tomorrowDateKey: string;
}) {
  const startDateKey = getFinnishDateKey(startDate);

  if (
    startDateKey === tomorrowDateKey &&
    getHelsinkiHourNumber(new Date(startDate)) === 23
  ) {
    return "huomenna vuorokauden lopussa";
  }

  const endTime = helsinkiTimeFormatter.format(endDate).replace(".", ":");

  if (startDateKey === tomorrowDateKey) {
    return `huomenna klo ${endTime}`;
  }

  if (startDateKey === todayDateKey) {
    return `tänään klo ${endTime}`;
  }

  return `suunnittelujakson päättyessä klo ${endTime}`;
}

function getTankUpdatedStatus(updatedAt: string | null, now = new Date()) {
  if (!updatedAt) {
    return null;
  }

  const updatedDate = new Date(updatedAt);

  if (Number.isNaN(updatedDate.getTime())) {
    return null;
  }

  const ageInMinutes = Math.max(
    0,
    Math.floor((now.getTime() - updatedDate.getTime()) / (60 * 1000)),
  );

  if (ageInMinutes < 2) {
    return {
      isWarning: false,
      text: "Päivitetty juuri nyt",
    };
  }

  if (ageInMinutes > 10) {
    return {
      isWarning: true,
      text: `Päivitetty ${ageInMinutes} min sitten`,
    };
  }

  return {
    isWarning: false,
    text: `Päivitetty ${helsinkiTimeFormatter.format(updatedDate)}`,
  };
}

function getChartDayKey(day: DaySelection) {
  if (day === "yesterday") {
    return getDateKeyOffset(-1);
  }

  if (day === "today") {
    return getDateKeyOffset(0);
  }

  return getDateKeyOffset(1);
}

function getDateHourKey(dateKey: string, hour: number) {
  return `${dateKey}:${String(hour).padStart(2, "0")}`;
}

function getHourlyPriceDateHourKey(item: HourlyPrice) {
  return getDateHourKey(
    getFinnishDateKey(item.startDate),
    getHelsinkiHourNumber(item.date),
  );
}

function formatHelsinkiDateHour(
  item: Pick<HourlyPrice, "date" | "startDate">,
) {
  return `${getFinnishDateKey(item.startDate)} ${String(
    getHelsinkiHourNumber(item.date),
  ).padStart(2, "0")}:00`;
}

function isStoredHeatingPlanNewerOrSame(
  incomingPlan: StoredHeatingPlan,
  currentPlan: StoredHeatingPlan | undefined,
) {
  if (!currentPlan?.updated_at || !incomingPlan.updated_at) {
    return true;
  }

  return (
    new Date(incomingPlan.updated_at).getTime() >=
    new Date(currentPlan.updated_at).getTime()
  );
}

function getHelsinkiDateStartIso(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const targetTimestamp = Date.UTC(year, month - 1, day);
  let utcTimestamp = targetTimestamp;

  for (let index = 0; index < 2; index += 1) {
    const parts = helsinkiDateTimePartsFormatter.formatToParts(
      new Date(utcTimestamp),
    );
    const getPart = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const localTimestamp = Date.UTC(
      getPart("year"),
      getPart("month") - 1,
      getPart("day"),
      getPart("hour"),
      getPart("minute"),
      getPart("second"),
    );

    utcTimestamp += targetTimestamp - localTimestamp;
  }

  return new Date(utcTimestamp).toISOString();
}

function getDayLabel(day: DaySelection) {
  if (day === "yesterday") {
    return "Eilen";
  }

  if (day === "today") {
    return "Tänään";
  }

  return "Huomenna";
}

function startOfCurrentHour(date = new Date()) {
  const currentHour = new Date(date);
  currentHour.setMinutes(0, 0, 0);
  return currentHour;
}

function getChartScale(prices: HourlyPrice[]) {
  if (prices.length === 0) {
    return {
      max: chartPriceStep,
      min: 0,
      range: chartPriceStep,
      values: [0, chartPriceStep],
    };
  }

  const priceValues = prices.map((item) => item.price);
  const minPrice = Math.min(...priceValues);
  const maxPrice = Math.max(...priceValues);
  const min =
    minPrice >= 0 ? 0 : Math.floor(minPrice / chartPriceStep) * chartPriceStep;
  let max =
    maxPrice <= 0 ? 0 : Math.ceil(maxPrice / chartPriceStep) * chartPriceStep;

  if (max === min) {
    max += chartPriceStep;
  }

  const range = max - min;

  return {
    max,
    min,
    range,
    values: Array.from(
      { length: range / chartPriceStep + 1 },
      (_, index) => min + index * chartPriceStep,
    ),
  };
}

function toHourlyPrice(
  startDate: string,
  price: number,
  endDate?: string | null,
  shouldNormalizePriceToCents = true,
) {
  const date = new Date(startDate);
  const parsedEndDate = endDate ? new Date(endDate) : null;

  if (Number.isNaN(date.getTime()) || Number.isNaN(price)) {
    return null;
  }

  return {
    date,
    startDate,
    endDate:
      parsedEndDate && !Number.isNaN(parsedEndDate.getTime())
        ? parsedEndDate
        : new Date(date.getTime() + 60 * 60 * 1000),
    hourLabel: formatHourLabel(date),
    id: startDate,
    price: shouldNormalizePriceToCents ? normalizePriceToCents(price) : price,
  } satisfies HourlyPrice;
}

function normalizeSpotPrices(data: SpotPriceResponse[]) {
  return data
    .map((item) => {
      const price = item.PriceWithTax ?? item.PriceNoTax;
      const startDate = item.startDate ?? item.StartDate ?? item.DateTime;
      const date = startDate ? new Date(startDate) : null;

      if (
        !date ||
        Number.isNaN(date.getTime()) ||
        typeof price !== "number" ||
        Number.isNaN(price)
      ) {
        return null;
      }

      return toHourlyPrice(startDate ?? date.toISOString(), price);
    })
    .filter((item): item is HourlyPrice => item !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function saveElectricityPrices(prices: HourlyPrice[]) {
  try {
    const fetchedAt = new Date().toISOString();
    const electricityPrices = prices.map((item) => {
      const endsAt = item.endDate.toISOString();

      return {
        start_date: item.startDate,
        end_date: endsAt,
        ends_at: endsAt,
        fetched_at: fetchedAt,
        price: item.price,
        price_date: getHelsinkiElectricityDateKey(item.startDate),
        region: electricityPriceRegion,
        resolution_minutes: getResolutionMinutes(item.startDate, endsAt),
        spot_price_cents_kwh: item.price,
        starts_at: item.startDate,
      };
    }) satisfies ElectricityPriceInsert[];

    if (electricityPrices.length === 0) {
      debugLog("Saved electricity prices: 0 rows");
      return;
    }

    // Historia karttuu tässä vaiheessa vain sovelluksen hakiessa hinnat.
    // Ajastettua taustahakua tai Edge Functionia ei vielä ole.
    const { error } = await supabase
      .from("electricity_prices")
      .upsert(electricityPrices, {
        onConflict: "region,starts_at,resolution_minutes",
      });

    if (error) {
      console.warn("Electricity price save failed", error);
      return;
    }

    debugLog(`Upserted electricity prices: ${electricityPrices.length} rows`);
  } catch (error) {
    console.warn("Electricity price save failed", error);
  }
}

function normalizeStoredElectricityPrices(data: StoredElectricityPrice[]) {
  return data
    .map((item) => {
      const price = item.price;

      if (!item.start_date || typeof price !== "number") {
        return null;
      }

      return toHourlyPrice(item.start_date, price, item.end_date, false);
    })
    .filter((item): item is HourlyPrice => item !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function buildOptimizerHeatingPlanPresentation({
  optimizationResult,
  optimizerHours,
  runSettings,
  todayPlanDate,
  tomorrowPlanDate,
}: {
  optimizationResult: HeatingOptimizationResult | null;
  optimizerHours: HeatingOptimizationHour[];
  runSettings: EnergiaZenSettings;
  todayPlanDate: string;
  tomorrowPlanDate: string;
}) {
  if (!optimizationResult || runSettings.heatingNeedMode !== "automatic") {
    return null;
  }

  const selectedHourIds = new Set(optimizationResult.selectedHeatingHourIds);
  const selectedHeatingHours = optimizerHours.filter((hour) =>
    selectedHourIds.has(hour.id),
  );
  const pricesById = new Map(
    optimizerHours.map((hour) => [hour.id, hour.price]),
  );
  const startTimesById = new Map(
    optimizerHours.map((hour) => [hour.id, hour.date.getTime()]),
  );
  const firstSelectedStartTime = Math.min(
    ...optimizationResult.selectedHeatingHourIds.map(
      (id) => startTimesById.get(id) ?? Number.POSITIVE_INFINITY,
    ),
  );
  const cheaperPlanRejectedForSafety = hasCheaperSafetyRejectedPlan({
    rejectedPlans: optimizationResult.diagnostics.rejectedShifts.map(
      (rejectedPlan) => ({
        cost: rejectedPlan.selectedHeatingHourIds.reduce(
          (sum, id) => sum + (pricesById.get(id) ?? 0),
          0,
        ),
        laterThanSelected:
          rejectedPlan.selectedHeatingHourIds.length > 0 &&
          rejectedPlan.selectedHeatingHourIds.every(
            (id) =>
              (startTimesById.get(id) ?? Number.NEGATIVE_INFINITY) >
              firstSelectedStartTime,
          ),
        selectedHourCount: rejectedPlan.selectedHeatingHourIds.length,
        violations: rejectedPlan.reason.split("; "),
      }),
    ),
    selectedCost: optimizationResult.totalCost,
    selectedHourCount: optimizationResult.selectedHeatingHourIds.length,
  });
  const optimizerSelectedHourLabels = selectedHeatingHours.map((hour) => ({
    estimatedCostEuros: calculatePlannedHeatingHourCostEuros({
      spotPriceCentsPerKwh: hour.price,
    }),
    label: formatHeatingHourRange(hour.date),
    period:
      getFinnishDateKey(hour.startDate) === todayPlanDate
        ? ("Tänään" as const)
        : ("Huomenna" as const),
    price: hour.price,
  }));
  const finalShowers =
    optimizationResult.forecast[optimizationResult.forecast.length - 1]
      ?.showersLeftAfter ?? optimizationResult.minimumPredictedShowersLeft;
  const lastForecastHour = optimizerHours[optimizerHours.length - 1];
  const forecastEndLabel = lastForecastHour
    ? getForecastEndLabel({
        endDate: lastForecastHour.endDate,
        startDate: lastForecastHour.startDate,
        todayDateKey: todayPlanDate,
        tomorrowDateKey: tomorrowPlanDate,
      })
    : "suunnittelujakson päättyessä";
  const fallbackInUse =
    runSettings.fallbackEnabled &&
    !optimizationResult.valid &&
    optimizationResult.selectedHeatingHourIds.length === 0;
  const selectedHours = fallbackInUse
    ? runSettings.backupHours.map((hour) => ({
        label: `${String(hour).padStart(2, "0")}–${String(
          (hour + 1) % 24,
        ).padStart(2, "0")}`,
        period: "Tänään" as const,
      }))
    : optimizerSelectedHourLabels;

  return buildHeatingPlanPresentation({
    automaticMaxHeatingHours: runSettings.automaticMaxHeatingHours,
    cheaperPlanRejectedForSafety,
    currentShowers: optimizationResult.diagnostics.currentShowers,
    forecastEndLabel,
    fallbackInUse,
    finalShowers,
    fixedHeatingHoursPerDay: runSettings.fixedHeatingHoursPerDay,
    heatingNeedMode: runSettings.heatingNeedMode,
    minimumShowers: optimizationResult.minimumPredictedShowersLeft,
    planValid: optimizationResult.valid,
    safetyShowerReserve: runSettings.safetyShowerReserve,
    selectedHours,
    targetShowerReserve: runSettings.targetShowerReserve,
  });
}

export default function HomeScreen() {
  const homeRenderStartedAt = Date.now();
  logHomeDayTabPerformance("HomeScreen render start");
  const router = useRouter();
  const pulseAnimation = useRef(new Animated.Value(0)).current;
  const [hourlyPrices, setHourlyPrices] = useState<HourlyPrice[]>([]);
  const [isPriceLoading, setIsPriceLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<DaySelection>("today");
  const {
    areSettingsLoaded,
    draftSettings: scenarioSettings,
    hasUnsavedChanges,
    persistedSettings: activeSettings,
  } = useSettingsScenario();
  const [planView, setPlanView] = useState<"active" | "scenario">("active");
  // The legacy UI reads active (persisted) settings. Draft settings only ever
  // feed the separate scenario optimization pipeline below, never publication.
  const settings = activeSettings;
  const scenarioValidation = useMemo(
    () => validateSettingsDraft(scenarioSettings, activeSettings),
    [activeSettings, scenarioSettings],
  );
  const [selectedHourlyPrice, setSelectedHourlyPrice] =
    useState<HourlyPrice | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [topTemp, setTopTemp] = useState<number | null>(null);
  const [bottomTemp, setBottomTemp] = useState<number | null>(null);
  const [tankTemperatureHistory, setTankTemperatureHistory] = useState<
    TankTemperatureReading[]
  >([]);
  const [heatingGainHistory, setHeatingGainHistory] = useState<
    TankTemperatureReading[]
  >([]);
  const [heatingGainHistoryFetch, setHeatingGainHistoryFetch] = useState({
    fetchedRowCount: 0,
    pageCount: 0,
  });
  const [storedTemperatureDropProfile, setStoredTemperatureDropProfile] =
    useState<TemperatureDropProfile | null>(null);
  const [storedHeatingPlans, setStoredHeatingPlans] = useState<
    Record<string, StoredHeatingPlan>
  >({});
  const storedHeatingPlansRef = useRef(storedHeatingPlans);
  const [heating, setHeating] = useState(false);
  const [actualHeatingHours, setActualHeatingHours] = useState<
    Partial<Record<DaySelection, number[]>>
  >({
    today: [],
    yesterday: [],
  });
  const [tankUpdatedAt, setTankUpdatedAt] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [manualOptimizationRevision, setManualOptimizationRevision] =
    useState(0);
  const heatingPlanSaveChainRef = useRef(Promise.resolve());
  const latestHeatingPlanSaveVersionRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const handleSelectedDayChange = useCallback((day: DaySelection) => {
    const startedAt = Date.now();

    logHomeDayTabPerformance("tab press", { day });
    setSelectedDay(day);
    logHomeDayTabPerformance("setSelectedDay", {
      day,
      durationMs: Date.now() - startedAt,
    });
  }, []);
  const handleClearSelectedHourlyPrice = useCallback(() => {
    setSelectedHourlyPrice(null);
  }, []);
  const handleSelectHourlyPrice = useCallback((item: HourlyPrice) => {
    setSelectedHourlyPrice(item);
  }, []);
  useEffect(() => {
    storedHeatingPlansRef.current = storedHeatingPlans;
  }, [storedHeatingPlans]);
  const currentHourStartTimestamp = startOfCurrentHour(currentTime).getTime();
  const currentHourStart = useMemo(
    () => new Date(currentHourStartTimestamp),
    [currentHourStartTimestamp],
  );
  const chartDayKey = getChartDayKey(selectedDay);
  const pricesByDay = useMemo(() => {
    const startedAt = Date.now();
    const nextPricesByDay: Record<DaySelection, HourlyPrice[]> = {
      today: [],
      tomorrow: [],
      yesterday: [],
    };

    for (const item of hourlyPrices) {
      const priceDayKey = getFinnishDateKey(item.startDate);

      if (priceDayKey === getChartDayKey("yesterday")) {
        nextPricesByDay.yesterday.push(item);
      } else if (priceDayKey === getChartDayKey("today")) {
        nextPricesByDay.today.push(item);
      } else if (priceDayKey === getChartDayKey("tomorrow")) {
        nextPricesByDay.tomorrow.push(item);
      }
    }

    logHomeDayTabPerformance("pricesByDay formed", {
      durationMs: Date.now() - startedAt,
      today: nextPricesByDay.today.length,
      tomorrow: nextPricesByDay.tomorrow.length,
      yesterday: nextPricesByDay.yesterday.length,
    });

    return nextPricesByDay;
  }, [hourlyPrices]);
  const chartHourlyPrices = useMemo(
    () => pricesByDay[selectedDay],
    [pricesByDay, selectedDay],
  );
  const currentPriceItem = hourlyPrices.find(
    (item) =>
      item.date.getTime() <= Date.now() && item.endDate.getTime() > Date.now(),
  );
  const currentPrice = currentPriceItem?.price ?? null;
  const currentTotalPrice =
    currentPrice === null ? null : getTotalPriceCentsPerKwh(currentPrice);
  const { ringColor } =
    currentPrice === null
      ? { ringColor: "#36f4d4" }
      : getPriceTheme(currentPrice);
  const chartScaleByDay = useMemo(() => {
    const startedAt = Date.now();
    const nextChartScaleByDay = {
      today: getChartScale(pricesByDay.today),
      tomorrow: getChartScale(pricesByDay.tomorrow),
      yesterday: getChartScale(pricesByDay.yesterday),
    };

    logHomeDayTabPerformance("chartScale formed", {
      durationMs: Date.now() - startedAt,
    });

    return nextChartScaleByDay;
  }, [pricesByDay]);
  const chartScale = chartScaleByDay[selectedDay];
  useEffect(() => {
    const chartPrices = chartHourlyPrices.map((item) => item.price);

    debugLog("Electricity price chart debug", {
      selectedPriceTab: getDayLabel(selectedDay),
      maxPrice: chartPrices.length > 0 ? Math.max(...chartPrices) : null,
      minPrice: chartPrices.length > 0 ? Math.min(...chartPrices) : null,
      prices: chartHourlyPrices.map((item) => ({
        hour: item.hourLabel,
        price: item.price,
      })),
    });
  }, [chartHourlyPrices, selectedDay]);
  const todayActualHeatingHourNumbers = useMemo(
    () => new Set(actualHeatingHours.today ?? []),
    [actualHeatingHours.today],
  );
  const currentWeightedTemperature =
    getCurrentWeightedTemperature(topTemp, bottomTemp);
  const tankTemperature = topTemp ?? defaultTankTemperature;
  const displayedTopTemp = topTemp === null ? "--" : `${Math.round(topTemp)}`;
  const displayedBottomTemp =
    bottomTemp === null ? "--" : `${Math.round(bottomTemp)}`;
  const warmWaterEstimate = getStratifiedWarmWaterEstimate(
    topTemp,
    bottomTemp,
    settings,
  );
  const localTemperatureDropProfile = useMemo(
    () => buildHourlyTemperatureDropProfileResult(tankTemperatureHistory),
    [tankTemperatureHistory],
  );
  const selectedTemperatureDropProfile = useMemo(
    () =>
      selectTemperatureDropProfile({
        localGeneralFallback: localTemperatureDropProfile.generalFallback,
        localProfile: localTemperatureDropProfile.hourlyDrops,
        now: currentTime,
        supabaseProfile: storedTemperatureDropProfile,
      }),
    [currentTime, localTemperatureDropProfile, storedTemperatureDropProfile],
  );
  const hourlyTemperatureDropProfile =
    selectedTemperatureDropProfile.hourlyTemperatureDropProfile;
  const heatingRecommendationForecast = useMemo(() => {
    const heatingHoursBeforeForecast = selectHeatingRecommendation(
      hourlyPrices,
      currentHourStart,
      todayActualHeatingHourNumbers,
      settings,
      tankTemperature,
      warmWaterEstimate?.showersLeft ?? null,
    );
    const preliminaryTomorrowHeatingHours = sortHoursChronologically(
      getCheapestHours(
        hourlyPrices.filter(
          (item) =>
            getFinnishDateKey(item.startDate) === getChartDayKey("tomorrow"),
        ),
        heatingHoursBeforeForecast.targetHours,
      ),
    );
    const nextHeatingStart = getForecastTargetHeatingStart({
      currentTime,
      isShiftedToTomorrow: isHeatingShiftedToTomorrow(
        heatingHoursBeforeForecast.reason,
      ),
      preliminaryTodayHeatingHours: heatingHoursBeforeForecast.hours,
      tomorrowHeatingHours: preliminaryTomorrowHeatingHours,
    });

    if (
      settings.heatingNeedMode === "fixed" ||
      !nextHeatingStart ||
      currentWeightedTemperature === null
    ) {
      return {
        heatingHoursBeforeForecast:
          heatingHoursBeforeForecast.targetHours,
        heatingHoursAfterForecast: heatingHoursBeforeForecast.targetHours,
        nextHeatingStart,
        predictedWeightedTemperature: currentWeightedTemperature,
        recommendation: heatingHoursBeforeForecast,
      };
    }

    const predictedWeightedTemperature = predictWeightedTemperature({
      currentTemperature: currentWeightedTemperature,
      from: currentTime,
      hourlyDropProfile: hourlyTemperatureDropProfile,
      to: nextHeatingStart,
    });
    const heatingHoursAfterForecast = getForecastHeatingHours({
      currentHeatingHours: heatingHoursBeforeForecast.targetHours,
      predictedTemperature: predictedWeightedTemperature,
      settingsHeatingHoursPerDay: settings.automaticMaxHeatingHours,
    });
    const recommendation = selectHeatingRecommendation(
      hourlyPrices,
      currentHourStart,
      todayActualHeatingHourNumbers,
      settings,
      predictedWeightedTemperature,
      warmWaterEstimate?.showersLeft ?? null,
      heatingHoursAfterForecast,
    );

    return {
      heatingHoursBeforeForecast: heatingHoursBeforeForecast.targetHours,
      heatingHoursAfterForecast: recommendation.targetHours,
      nextHeatingStart,
      predictedWeightedTemperature,
      recommendation,
    };
  }, [
    currentHourStart,
    currentTime,
    currentWeightedTemperature,
    hourlyPrices,
    hourlyTemperatureDropProfile,
    settings,
    tankTemperature,
    todayActualHeatingHourNumbers,
    warmWaterEstimate?.showersLeft,
  ]);
  const heatingRecommendation = heatingRecommendationForecast.recommendation;
  useEffect(() => {
    debugLog("Tank temperature forecast debug", {
      currentWeightedTemperature,
      generalFallback: selectedTemperatureDropProfile.generalFallback,
      heatingHoursAfterForecast:
        heatingRecommendationForecast.heatingHoursAfterForecast,
      heatingHoursBeforeForecast:
        heatingRecommendationForecast.heatingHoursBeforeForecast,
      hourlyTemperatureDropProfile,
      profileAgeDays: selectedTemperatureDropProfile.profileAgeDays,
      profileDate: selectedTemperatureDropProfile.profileDate,
      profileSource: selectedTemperatureDropProfile.profileSource,
      nextHeatingStart:
        heatingRecommendationForecast.nextHeatingStart?.toISOString() ?? null,
      predictedWeightedTemperature:
        heatingRecommendationForecast.predictedWeightedTemperature,
    });
  }, [
    currentWeightedTemperature,
    heatingRecommendationForecast.heatingHoursAfterForecast,
    heatingRecommendationForecast.heatingHoursBeforeForecast,
    heatingRecommendationForecast.nextHeatingStart,
    heatingRecommendationForecast.predictedWeightedTemperature,
    hourlyTemperatureDropProfile,
    selectedTemperatureDropProfile.generalFallback,
    selectedTemperatureDropProfile.profileAgeDays,
    selectedTemperatureDropProfile.profileDate,
    selectedTemperatureDropProfile.profileSource,
  ]);
  const recommendedHeatingHours = heatingRecommendation.hours;
  const tomorrowTargetHours =
    settings.heatingNeedMode === "automatic"
      ? heatingRecommendationForecast.heatingHoursAfterForecast
      : settings.fixedHeatingHoursPerDay;
  const configuredHeatingHours =
    settings.heatingNeedMode === "automatic"
      ? settings.automaticMaxHeatingHours
      : settings.fixedHeatingHoursPerDay;
  const tomorrowPlannedHeatingHours = useMemo(() => {
    const tomorrowKey = getChartDayKey("tomorrow");

    return sortHoursChronologically(
      getCheapestHours(
        hourlyPrices.filter(
          (item) => getFinnishDateKey(item.startDate) === tomorrowKey,
        ),
        tomorrowTargetHours,
      ),
    );
  }, [hourlyPrices, tomorrowTargetHours]);
  const todayPlanDate = getChartDayKey("today");
  const tomorrowPlanDate = getChartDayKey("tomorrow");
  const oldTodayPlannedHeatingHours = useMemo(
    () => recommendedHeatingHours.filter((item) => item.status === "planned"),
    [recommendedHeatingHours],
  );
  const optimizerHours = useMemo<HeatingOptimizationHour[]>(() => {
    const todayKey = getChartDayKey("today");
    const tomorrowKey = getChartDayKey("tomorrow");

    return sortHoursChronologically(
      hourlyPrices.filter((item) => {
        const dateKey = getFinnishDateKey(item.startDate);

        return (
          (dateKey === todayKey &&
            item.endDate.getTime() > currentHourStart.getTime()) ||
          dateKey === tomorrowKey
        );
      }),
    ).map((item) => ({
      date: item.date,
      endDate: item.endDate,
      id: item.id,
      isCurrentHour:
        item.date.getTime() <= currentHourStart.getTime() &&
        item.endDate.getTime() > currentHourStart.getTime(),
      price: item.price,
      segmentHours: 1,
      startDate: item.startDate,
    }));
  }, [currentHourStart, hourlyPrices]);
  // Two independent optimization pipelines. Active always runs on persisted
  // settings and is the only one allowed to publish to heating_plans. Scenario
  // only runs while there is an unsaved, valid draft and is preview-only.
  const activeOptimizationRun = useHeatingOptimizationRun({
    appSettings: activeSettings,
    currentBottomTemperature: bottomTemp,
    currentTopTemperature: topTemp,
    currentWeightedTemperature,
    fallbackHeatingGainPerHour,
    heatingHistory: heatingGainHistory,
    hourlyDrops: hourlyTemperatureDropProfile,
    hours: optimizerHours,
    isCurrentlyHeating: heating,
    isEnabled: true,
    manualRefreshRevision: manualOptimizationRevision,
    mode: activeSettings.heatingNeedMode,
    readingCreatedAt: tankUpdatedAt,
    todayPlanDate,
    tomorrowPlanDate,
  });
  const scenarioOptimizationRun = useHeatingOptimizationRun({
    appSettings: scenarioSettings,
    currentBottomTemperature: bottomTemp,
    currentTopTemperature: topTemp,
    currentWeightedTemperature,
    fallbackHeatingGainPerHour,
    heatingHistory: heatingGainHistory,
    hourlyDrops: hourlyTemperatureDropProfile,
    hours: optimizerHours,
    isCurrentlyHeating: heating,
    isEnabled: hasUnsavedChanges && scenarioValidation.errors.length === 0,
    manualRefreshRevision: manualOptimizationRevision,
    mode: scenarioSettings.heatingNeedMode,
    readingCreatedAt: tankUpdatedAt,
    todayPlanDate,
    tomorrowPlanDate,
  });

  const activeHeatingOptimization = activeOptimizationRun.result;
  const heatingOptimization = activeHeatingOptimization;
  const publishedOptimizerHours = activeOptimizationRun.hours;
  const publishedOptimizationSettings = activeOptimizationRun.appSettings;
  const publishedTodayPlanDate =
    activeOptimizationRun.todayPlanDate ?? todayPlanDate;
  const publishedTomorrowPlanDate =
    activeOptimizationRun.tomorrowPlanDate ?? tomorrowPlanDate;
  const optimizerSelectedHeatingHourIds = useMemo(
    () => new Set(heatingOptimization?.selectedHeatingHourIds ?? []),
    [heatingOptimization?.selectedHeatingHourIds],
  );
  const optimizerSelectedHeatingHours = useMemo(
    () =>
      publishedOptimizerHours.filter((item) =>
        optimizerSelectedHeatingHourIds.has(item.id),
      ),
    [publishedOptimizerHours, optimizerSelectedHeatingHourIds],
  );
  const optimizerTodayHeatingHours = useMemo(
    () =>
      optimizerSelectedHeatingHours.filter(
        (item) => getFinnishDateKey(item.startDate) === publishedTodayPlanDate,
      ),
    [optimizerSelectedHeatingHours, publishedTodayPlanDate],
  );
  const optimizerTomorrowHeatingHours = useMemo(
    () =>
      optimizerSelectedHeatingHours.filter(
        (item) =>
          getFinnishDateKey(item.startDate) === publishedTomorrowPlanDate,
      ),
    [optimizerSelectedHeatingHours, publishedTomorrowPlanDate],
  );
  const isOptimizerPlanActive =
    settings.heatingNeedMode === "automatic" && heatingOptimization !== null;
  const finalTodayPlannedHeatingHours = isOptimizerPlanActive
    ? optimizerTodayHeatingHours
    : oldTodayPlannedHeatingHours;
  const finalTomorrowPlannedHeatingHours = isOptimizerPlanActive
    ? optimizerTomorrowHeatingHours
    : tomorrowPlannedHeatingHours;
  const finalTargetHours = isOptimizerPlanActive
    ? optimizerSelectedHeatingHours.length
    : heatingRecommendation.targetHours;
  const finalTomorrowTargetHours = isOptimizerPlanActive
    ? optimizerSelectedHeatingHours.length
    : tomorrowTargetHours;
  const optimizerReason =
    settings.heatingNeedMode === "automatic" && heatingOptimization
    ? [
        `Optimointi valitsi ${optimizerSelectedHeatingHours.length} h yhteiselle aikaikkunalle.`,
        `Lämmitystuntien enimmäismäärä ${publishedOptimizationSettings.automaticMaxHeatingHours} h.`,
        `Tänään ${optimizerTodayHeatingHours.length} h, huomenna ${optimizerTomorrowHeatingHours.length} h.`,
        `Alin ennustettu suihkuvaraus ${formatSignedFinnishDecimal(
          heatingOptimization.minimumPredictedShowersLeft,
        )}, tavoite ${formatSignedFinnishDecimal(
          publishedOptimizationSettings.targetShowerReserve,
        )} ja turvaraja ${formatSignedFinnishDecimal(
          publishedOptimizationSettings.safetyShowerReserve,
        )}.`,
        `Lämmityksen nousuarvio ${formatSignedFinnishDecimal(
          heatingOptimization.heatingGainEstimate.gainPerHour,
        )} °C/h.`,
        heatingOptimization.heatingGainEstimate.fallbackUsed
          ? "Nousuarviossa käytettiin fallback-arvoa."
          : "Nousuarvio laskettiin historiasta.",
      ].join(" ")
      : null;
  const activeOptimizerPresentation = useMemo(
    () =>
      buildOptimizerHeatingPlanPresentation({
        optimizationResult: activeOptimizationRun.result,
        optimizerHours: activeOptimizationRun.hours,
        runSettings: activeOptimizationRun.appSettings,
        todayPlanDate: publishedTodayPlanDate,
        tomorrowPlanDate: publishedTomorrowPlanDate,
      }),
    [activeOptimizationRun, publishedTodayPlanDate, publishedTomorrowPlanDate],
  );
  const scenarioOptimizerPresentation = useMemo(
    () =>
      buildOptimizerHeatingPlanPresentation({
        optimizationResult: scenarioOptimizationRun.result,
        optimizerHours: scenarioOptimizationRun.hours,
        runSettings: scenarioOptimizationRun.appSettings,
        todayPlanDate: scenarioOptimizationRun.todayPlanDate ?? todayPlanDate,
        tomorrowPlanDate:
          scenarioOptimizationRun.tomorrowPlanDate ?? tomorrowPlanDate,
      }),
    [scenarioOptimizationRun, todayPlanDate, tomorrowPlanDate],
  );
  const storedHeatingPlanPresentation = useMemo(() => {
    if (settings.heatingNeedMode !== "automatic") {
      return null;
    }

    const storedPlans = [
      storedHeatingPlans[todayPlanDate],
      storedHeatingPlans[tomorrowPlanDate],
    ].filter((plan): plan is StoredHeatingPlan => Boolean(plan));

    if (storedPlans.length === 0) {
      return null;
    }

    const selectedHours = storedPlans.flatMap((plan) => {
      const planDate = plan.plan_date;

      if (!planDate) {
        return [];
      }

      return normalizeStoredHeatingPlanHours(plan.planned_hours).map((hour) => {
        const priceHour = hourlyPrices.find(
          (item) =>
            getFinnishDateKey(item.startDate) === planDate &&
            getHelsinkiHourNumber(item.date) === hour,
        );

        return {
          estimatedCostEuros: priceHour
            ? calculatePlannedHeatingHourCostEuros({
                spotPriceCentsPerKwh: priceHour.price,
              })
            : null,
          label: priceHour
            ? formatHeatingHourRange(priceHour.date)
            : `${String(hour).padStart(2, "0")}:00-${String(
                (hour + 1) % 24,
              ).padStart(2, "0")}:00`,
          period:
            planDate === todayPlanDate
              ? ("Tänään" as const)
              : ("Huomenna" as const),
          price: priceHour?.price ?? null,
        };
      });
    });

    return buildStoredHeatingPlanPresentation({
      currentShowers: warmWaterEstimate?.showersLeft ?? null,
      safetyShowerReserve: settings.safetyShowerReserve,
      selectedHours,
      targetShowerReserve: settings.targetShowerReserve,
    });
  }, [
    hourlyPrices,
    settings.heatingNeedMode,
    settings.safetyShowerReserve,
    settings.targetShowerReserve,
    storedHeatingPlans,
    todayPlanDate,
    tomorrowPlanDate,
    warmWaterEstimate?.showersLeft,
  ]);
  useEffect(() => {
    setPlanView(hasUnsavedChanges ? "scenario" : "active");
  }, [hasUnsavedChanges]);

  const activePlanPresentation =
    storedHeatingPlanPresentation ?? activeOptimizerPresentation;
  const scenarioPlanPresentation =
    hasUnsavedChanges && scenarioValidation.errors.length === 0
      ? scenarioOptimizerPresentation
      : null;
  const heatingPlanPresentation = hasUnsavedChanges
    ? planView === "scenario"
      ? scenarioPlanPresentation
      : activePlanPresentation
    : activePlanPresentation;
  const heatingPlanPresentationSource = getHeatingPlanPresentationSource({
    hasPublishedOptimization:
      heatingPlanPresentation === scenarioPlanPresentation &&
      scenarioPlanPresentation !== null,
    hasStoredPlan:
      heatingPlanPresentation === activePlanPresentation &&
      activePlanPresentation !== null,
  });

  useEffect(() => {
    debugLog("Heating plan presentation source", {
      optimizerRunId: activeOptimizationRun.runId,
      source: heatingPlanPresentationSource,
    });
  }, [
    activeOptimizationRun.runId,
    heatingPlanPresentationSource,
  ]);
  useEffect(() => {
    if (!heatingOptimization) {
      return;
    }

    const gainEstimate = heatingOptimization.heatingGainEstimate;
    const firstForecastSegment = heatingOptimization.forecast[0] ?? null;
    const projectedShowers =
      heatingOptimization.forecast.at(-1)?.showersLeftAfter ?? null;
    const optimizationStatus =
      heatingOptimization.selectedHeatingHourIds.length > 0
        ? "planned"
        : heatingOptimization.valid
          ? "not-needed"
          : heatingOptimization.violations.join("; ") || "no-valid-plan";

    console.log(
      "[EnergyZen heating gain]",
      JSON.stringify({
        bottomMedian: gainEstimate.bottomGainPerHour,
        gainPerHour: gainEstimate.gainPerHour,
        historyRows: heatingGainHistoryFetch.fetchedRowCount,
        pagesFetched: heatingGainHistoryFetch.pageCount,
        segmentsAccepted: gainEstimate.acceptedSegmentCount,
        segmentsFound: gainEstimate.discoveredSegmentCount,
        source: gainEstimate.fallbackUsed ? "fallback" : "learned",
        topMedian: gainEstimate.topGainPerHour,
        weightedMedian: gainEstimate.fallbackUsed
          ? null
          : gainEstimate.gainPerHour,
      }),
    );
    console.log(
      "[EnergyZen optimization]",
      JSON.stringify({
        currentShowers: heatingOptimization.diagnostics.currentShowers,
        currentFillRatio:
          heatingOptimization.diagnostics.currentFillRatio,
        currentHourStartBlockedByFillRatio:
          heatingOptimization.diagnostics
            .currentHourStartBlockedByFillRatio,
        firstAppliedDrop: firstForecastSegment?.appliedDrop ?? null,
        firstHourDrop: firstForecastSegment?.hourlyDrop ?? null,
        firstSegmentHours: firstForecastSegment?.segmentHours ?? null,
        fullTankShowers: heatingOptimization.diagnostics.fullTankShowers,
        heatingStartFillRatioDiagnostics:
          heatingOptimization.diagnostics.heatingStartFillRatioDiagnostics,
        heatingGainPerHour: gainEstimate.gainPerHour,
        plannedHours: heatingOptimization.selectedHeatingHourIds,
        projectedShowers,
        reasonOrStatus: optimizationStatus,
        startHeatingThresholdShowers:
          heatingOptimization.diagnostics.startHeatingThresholdShowers,
        targetShowers: publishedOptimizationSettings.targetShowerReserve,
      }),
    );
  }, [
    heatingGainHistoryFetch.fetchedRowCount,
    heatingGainHistoryFetch.pageCount,
    heatingOptimization,
    publishedOptimizationSettings.targetShowerReserve,
  ]);
  useEffect(() => {
    debugLog("Heating optimizer debug", {
      optimizerHeatingGainEstimate:
        heatingOptimization?.heatingGainEstimate ?? null,
      heatingGainHistory: {
        acceptedSegmentCount:
          heatingOptimization?.heatingGainEstimate.acceptedSegmentCount ?? 0,
        bottomMedianGainPerHour:
          heatingOptimization?.heatingGainEstimate.bottomGainPerHour ?? null,
        discoveredSegmentCount:
          heatingOptimization?.heatingGainEstimate.discoveredSegmentCount ?? 0,
        fallbackUsed:
          heatingOptimization?.heatingGainEstimate.fallbackUsed ?? true,
        fetchedPageCount: heatingGainHistoryFetch.pageCount,
        fetchedRowCount: heatingGainHistoryFetch.fetchedRowCount,
        rejectedSegmentCount:
          heatingOptimization?.heatingGainEstimate.rejectedSegmentCount ?? 0,
        selectedGainPerHour:
          heatingOptimization?.heatingGainEstimate.gainPerHour ??
          fallbackHeatingGainPerHour,
        topMedianGainPerHour:
          heatingOptimization?.heatingGainEstimate.topGainPerHour ?? null,
        weightedMedianGainPerHour:
          heatingOptimization?.heatingGainEstimate.fallbackUsed === false
            ? heatingOptimization.heatingGainEstimate.gainPerHour
            : null,
      },
      optimizerHours: optimizerHours.map((item) => ({
        helsinkiDateHour: formatHelsinkiDateHour(item),
        id: item.id,
        price: item.price,
      })),
      optimizerMinimumPredictedShowersLeft:
        heatingOptimization?.minimumPredictedShowersLeft ?? null,
      optimizerSelectedHeatingHourIds:
        heatingOptimization?.selectedHeatingHourIds ?? [],
      optimizerSelectedHourCount:
        heatingOptimization?.selectedHeatingHourIds.length ?? 0,
      optimizerTodayHours: optimizerTodayHeatingHours.map((item) => ({
        helsinkiDateHour: formatHelsinkiDateHour(item),
        id: item.id,
      })),
      optimizerTomorrowHours: optimizerTomorrowHeatingHours.map((item) => ({
        helsinkiDateHour: formatHelsinkiDateHour(item),
        id: item.id,
      })),
      oldTodayHours: oldTodayPlannedHeatingHours.map((item) => ({
        helsinkiDateHour: formatHelsinkiDateHour(item),
        id: item.id,
      })),
      oldTomorrowHours: tomorrowPlannedHeatingHours.map((item) => ({
        helsinkiDateHour: formatHelsinkiDateHour(item),
        id: item.id,
      })),
    });
  }, [
    heatingOptimization,
    heatingGainHistoryFetch.fetchedRowCount,
    heatingGainHistoryFetch.pageCount,
    oldTodayPlannedHeatingHours,
    optimizerHours,
    optimizerTodayHeatingHours,
    optimizerTomorrowHeatingHours,
    tomorrowPlannedHeatingHours,
  ]);
  const visiblePlanDatesKey = [
    getChartDayKey("yesterday"),
    todayPlanDate,
    tomorrowPlanDate,
  ].join(",");
  const todayPlannedHourNumbersKey = getSortedUniqueHelsinkiHourNumbers(
    finalTodayPlannedHeatingHours,
  ).join(",");
  const tomorrowPlannedHourNumbersKey = getSortedUniqueHelsinkiHourNumbers(
    finalTomorrowPlannedHeatingHours,
  ).join(",");

  useEffect(() => {
    const planDates = visiblePlanDatesKey.split(",");
    let isActive = true;

    async function loadHeatingPlans() {
      try {
        const { data, error } = await supabase
          .from("heating_plans")
          .select(storedHeatingPlanColumns)
          .in("plan_date", planDates);

        if (error) {
          console.warn("Failed to load heating plans", error);
          return;
        }

        if (!isActive) {
          return;
        }

        setStoredHeatingPlans((currentPlans) => {
          const nextPlans = { ...currentPlans };

          for (const planDate of planDates) {
            delete nextPlans[planDate];
          }

          for (const plan of (data ?? []) as StoredHeatingPlan[]) {
            if (plan.plan_date) {
              const currentPlan = nextPlans[plan.plan_date];

              if (isStoredHeatingPlanNewerOrSame(plan, currentPlan)) {
                nextPlans[plan.plan_date] = plan;
              }
            }
          }

          debugLog("Heating plans loaded into local state", {
            loadedPlans: (data ?? []).map((plan) => ({
              plan_date: plan.plan_date,
              planned_hours: normalizeStoredHeatingPlanHours(
                plan.planned_hours,
              ),
              target_hours: plan.target_hours,
              updated_at: plan.updated_at,
            })),
            storedHeatingPlansAfterLoad: planDates.map((planDate) => ({
              plan_date: planDate,
              planned_hours: normalizeStoredHeatingPlanHours(
                nextPlans[planDate]?.planned_hours,
              ),
              target_hours: nextPlans[planDate]?.target_hours ?? null,
              updated_at: nextPlans[planDate]?.updated_at ?? null,
            })),
          });

          return nextPlans;
        });
      } catch (error) {
        console.warn("Failed to load heating plans", error);
      }
    }

    void loadHeatingPlans();

    return () => {
      isActive = false;
    };
  }, [visiblePlanDatesKey]);

  useEffect(() => {
    // This effect only ever reads activeOptimizationRun/activeHeatingOptimization
    // (persistedSettings-based). The scenario pipeline's result is never in
    // scope here, so it structurally cannot reach heating_plans.
    const isOptimizationCurrent =
      settings.heatingNeedMode !== "automatic" || activeHeatingOptimization !== null;

    if (
      !areSettingsLoaded ||
      !canPublishActiveHeatingPlan({
        isOptimizationCurrent,
        source: "active",
      })
    ) {
      debugLog("Heating plan publication skipped", {
        plannedHours: heatingOptimization?.selectedHeatingHourIds ?? [],
      });
      return;
    }

    if (
      settings.heatingNeedMode === "automatic" &&
      !activeHeatingOptimization
    ) {
      debugLog("Heating plan save skipped until optimizer is ready", {
        currentWeightedTemperature,
        optimizerHourCount: optimizerHours.length,
        optimizerSelectedHeatingHourIds: [],
      });
      return;
    }

    const getHourNumbersFromKey = (key: string) =>
      key.length === 0 ? [] : key.split(",").map(Number);
    const updatedAt = new Date().toISOString();
    const todayPlan = {
      mode: settings.heatingNeedMode,
      plan_date: todayPlanDate,
      planned_hours: getHourNumbersFromKey(todayPlannedHourNumbersKey),
      reason: optimizerReason ?? heatingRecommendation.reason,
      target_hours: finalTargetHours,
      updated_at: updatedAt,
    };
    const tomorrowPlan = {
      mode: settings.heatingNeedMode,
      plan_date: tomorrowPlanDate,
      planned_hours: getHourNumbersFromKey(tomorrowPlannedHourNumbersKey),
      reason:
        optimizerReason ??
        (settings.heatingNeedMode === "automatic"
          ? `Lämpötilaennusteen mukainen alustava lämmityssuunnitelma → ${finalTomorrowTargetHours} h`
          : `Kiinteä lämmitys ${settings.fixedHeatingHoursPerDay} h/vrk vuorokauden halvimmilla tunneilla.`),
      target_hours: finalTomorrowTargetHours,
      updated_at: updatedAt,
    };
    const upsertPayload = [todayPlan, tomorrowPlan];

    const saveVersion = latestHeatingPlanSaveVersionRef.current + 1;
    latestHeatingPlanSaveVersionRef.current = saveVersion;

    debugLog("Heating plan upsert payload debug", {
      optimizerRunId: activeOptimizationRun.runId,
      optimizerSelectedHeatingHourIds:
        heatingOptimization?.selectedHeatingHourIds ?? [],
      optimizerSelectedHourCount:
        heatingOptimization?.selectedHeatingHourIds.length ?? 0,
      reasonToday: todayPlan.reason,
      reasonTomorrow: tomorrowPlan.reason,
      storedHeatingPlansBeforeUpsert: {
        [todayPlanDate]:
          storedHeatingPlansRef.current[todayPlanDate] ?? null,
        [tomorrowPlanDate]:
          storedHeatingPlansRef.current[tomorrowPlanDate] ?? null,
      },
      supabaseUpsertPayload: upsertPayload,
      todayPlanPlannedHours: todayPlan.planned_hours,
      tomorrowPlanPlannedHours: tomorrowPlan.planned_hours,
    });

    heatingPlanSaveChainRef.current = heatingPlanSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (saveVersion !== latestHeatingPlanSaveVersionRef.current) {
          return;
        }

        const changedPlans = getChangedHeatingPlans(
          storedHeatingPlansRef.current,
          upsertPayload,
        );

        if (changedPlans.length === 0) {
          debugLog("Heating plan upsert skipped", {
            identicalUpsertSkipped: true,
            optimizerRunId: activeOptimizationRun.runId,
            plannedHours: upsertPayload.map((plan) => ({
              planDate: plan.plan_date,
              plannedHours: plan.planned_hours,
            })),
          });
          return;
        }

        try {
          const { error } = await supabase
            .from("heating_plans")
            .upsert(changedPlans, { onConflict: "plan_date" });

          if (error) {
            console.warn("Failed to save heating plans", error);
            return;
          }

          if (saveVersion !== latestHeatingPlanSaveVersionRef.current) {
            return;
          }

          setStoredHeatingPlans((currentPlans) => {
            const nextPlans = { ...currentPlans };

            for (const plan of changedPlans) {
              nextPlans[plan.plan_date] = plan;
            }

            storedHeatingPlansRef.current = nextPlans;
            return nextPlans;
          });
          debugLog("Heating plans stored locally after upsert", {
            identicalUpsertSkipped: false,
            optimizerRunId: activeOptimizationRun.runId,
            plannedHours: changedPlans.map((plan) => ({
              planDate: plan.plan_date,
              plannedHours: plan.planned_hours,
            })),
          });
        } catch (error) {
          console.warn("Failed to save heating plans", error);
        }
      });
  }, [
    activeHeatingOptimization,
    areSettingsLoaded,
    currentWeightedTemperature,
    heatingRecommendation.reason,
    heatingOptimization,
    activeOptimizationRun.runId,
    finalTargetHours,
    finalTomorrowTargetHours,
    optimizerReason,
    optimizerHours.length,
    settings.heatingNeedMode,
    settings.fixedHeatingHoursPerDay,
    todayPlanDate,
    todayPlannedHourNumbersKey,
    tomorrowPlanDate,
    tomorrowPlannedHourNumbersKey,
  ]);
  const selectedHeatingHoursCount = useMemo(() => {
    if (selectedDay === "yesterday") {
      return configuredHeatingHours;
    }

    return selectedDay === "today"
      ? finalTodayPlannedHeatingHours.length
      : finalTomorrowPlannedHeatingHours.length;
  }, [
    finalTodayPlannedHeatingHours.length,
    finalTomorrowPlannedHeatingHours.length,
    selectedDay,
    configuredHeatingHours,
  ]);
  const todayActualHeatingHoursCount = actualHeatingHours.today?.length ?? 0;
  const remainingPlannedHeatingHoursCount = finalTodayPlannedHeatingHours.length;
  const showSeparatedTodayHeatingHours =
    selectedDay === "today" &&
    settings.heatingNeedMode === "automatic" &&
    todayActualHeatingHoursCount > 0;
  const explanationVisible =
    selectedHeatingHoursCount !== configuredHeatingHours;
  const manualSelectedHeatingHours = useMemo(() => {
    if (settings.heatingNeedMode !== "fixed") {
      return [];
    }

    if (selectedDay === "today") {
      return finalTodayPlannedHeatingHours;
    }

    if (selectedDay === "tomorrow") {
      return finalTomorrowPlannedHeatingHours;
    }

    return [];
  }, [
    finalTodayPlannedHeatingHours,
    finalTomorrowPlannedHeatingHours,
    selectedDay,
    settings.heatingNeedMode,
  ]);
  const manualSelectedHeatingHoursText = useMemo(
    () => formatManualHeatingHours(selectedDay, manualSelectedHeatingHours),
    [manualSelectedHeatingHours, selectedDay],
  );
  const isManualHeatingHourNow = useMemo(
    () =>
      settings.heatingNeedMode === "fixed" &&
      finalTodayPlannedHeatingHours.some(
        (item) =>
          item.date.getTime() <= currentHourStart.getTime() &&
          item.endDate.getTime() > currentHourStart.getTime(),
      ),
    [currentHourStart, finalTodayPlannedHeatingHours, settings.heatingNeedMode],
  );
  const forecastHeatingHours =
    heatingRecommendationForecast.heatingHoursAfterForecast;
  const forecastHeatingDuration =
    forecastHeatingHours === 1
      ? "1 tunnin"
      : `${forecastHeatingHours} tuntia`;
  const tomorrowPricesAvailable = hourlyPrices.some(
    (item) =>
      getFinnishDateKey(item.startDate) === getChartDayKey("tomorrow"),
  );
  useEffect(() => {
    debugLog("Heating mode debug", {
      activeHeatingMode:
        settings.heatingNeedMode === "fixed"
          ? "fixed/manual"
          : "temperature-based/forecast",
      heatingNeedMode: settings.heatingNeedMode,
      configuredHeatingHours,
      temperatureDropProfileAffectsForecast:
        settings.heatingNeedMode === "automatic" &&
        heatingRecommendationForecast.nextHeatingStart !== null &&
        currentWeightedTemperature !== null,
      temperatureDropProfileBypassReason:
        settings.heatingNeedMode === "fixed"
          ? "fixed/manual mode uses fixedHeatingHoursPerDay and bypasses forecast"
          : heatingRecommendationForecast.nextHeatingStart === null
            ? "forecast mode has no future heating start"
            : currentWeightedTemperature === null
              ? "forecast mode has no current weighted tank temperature"
              : null,
      tomorrowTargetHours,
      tomorrowTargetHoursSource:
        settings.heatingNeedMode === "automatic"
          ? "temperature forecast"
          : "fixedHeatingHoursPerDay setting",
    });
  }, [
    currentWeightedTemperature,
    heatingRecommendationForecast.nextHeatingStart,
    configuredHeatingHours,
    settings.heatingNeedMode,
    tomorrowTargetHours,
  ]);
  const currentSavedPlan = storedHeatingPlans[chartDayKey] ?? null;
  const plannedHeatingHourIds = useMemo(() => {
    const plannedHours = normalizeStoredHeatingPlanHours(
      currentSavedPlan?.planned_hours,
    );

    return new Set(
      plannedHours.map((hour) => getDateHourKey(chartDayKey, hour)),
    );
  }, [chartDayKey, currentSavedPlan?.planned_hours]);
  const heatedHourIds = useMemo(
    () =>
      new Set(
        (actualHeatingHours[selectedDay] ?? []).map((hour) =>
          getDateHourKey(chartDayKey, hour),
        ),
      ),
    [actualHeatingHours, chartDayKey, selectedDay],
  );
  const missedHeatingHourIds = useMemo(
    () =>
      new Set(
        selectedDay === "today"
          ? chartHourlyPrices
              .filter((item) => {
                const dateHourKey = getHourlyPriceDateHourKey(item);

                return getHeatingHourMarker({
                  endsAt: item.endDate,
                  isActual: heatedHourIds.has(dateHourKey),
                  isPlanned: plannedHeatingHourIds.has(dateHourKey),
                  now: currentHourStart,
                }) === heatingMarkers.missed;
              })
              .map(getHourlyPriceDateHourKey)
          : [],
      ),
    [
      chartHourlyPrices,
      currentHourStart,
      heatedHourIds,
      plannedHeatingHourIds,
      selectedDay,
    ],
  );
  const chartHeatingMarkers = useMemo(() => {
    const startedAt = Date.now();
    const markers = chartHourlyPrices
        .map((item) => {
          const dateHourKey = getHourlyPriceDateHourKey(item);
          const isInCurrentSavedPlan =
            plannedHeatingHourIds.has(dateHourKey);
          const marker = getHeatingHourMarker({
            endsAt: item.endDate,
            isActual: heatedHourIds.has(dateHourKey),
            isPlanned: isInCurrentSavedPlan,
            now: currentHourStart,
          });
          const markerSource = heatedHourIds.has(dateHourKey)
            ? "actualHeatingHours"
            : missedHeatingHourIds.has(dateHourKey)
              ? "missedHeatingHourIds + Supabase heating_plans"
              : isInCurrentSavedPlan
                ? "plannedHeatingHourIds + Supabase heating_plans"
                : null;

          return {
            chartDateKey: chartDayKey,
            dateHourKey,
            helsinkiDateHour: formatHelsinkiDateHour(item),
            isInCurrentSavedPlan,
            itemId: item.id,
            marker,
            markerSource,
          };
        })
        .filter((item) => item.marker !== null);

    logHomeDayTabPerformance("heating markers formed", {
      durationMs: Date.now() - startedAt,
      markerCount: markers.length,
      selectedDay,
    });

    return markers;
  }, [
      chartDayKey,
      chartHourlyPrices,
      currentHourStart,
      heatedHourIds,
      missedHeatingHourIds,
      plannedHeatingHourIds,
      selectedDay,
    ],
  );
  useEffect(() => {
    for (const item of chartHeatingMarkers) {
      debugLog("Heating marker debug", {
        chartDateKey: item.chartDateKey,
        dateHourKey: item.dateHourKey,
        helsinkiDateHour: item.helsinkiDateHour,
        isInCurrentSavedPlan: item.isInCurrentSavedPlan,
        itemId: item.itemId,
        marker: item.marker,
        markerSource: item.markerSource,
      });
    }
  }, [chartHeatingMarkers]);
  const isHeatingNow = recommendedHeatingHours.some(
    (item) =>
      item.date.getTime() <= currentHourStart.getTime() &&
      item.endDate.getTime() > currentHourStart.getTime(),
  );
  const isTankHeating = heating || isHeatingNow;
  const temperatureCardTheme = getTemperatureCardTheme(
    tankTemperature,
    settings,
  );
  const warmWaterCardTheme = getWarmWaterCardTheme();
  const warmWaterFillPercent = Math.round(
    (warmWaterEstimate?.fillRatio ?? 0) * 100,
  );
  const warmWaterShowersValue = warmWaterEstimate
    ? formatFinnishDecimal(warmWaterEstimate.showersLeft)
    : "--";
  const warmWaterShowersLabel = `${warmWaterShowersValue} 🚿`;
  const warmWaterAverageTempLabel = warmWaterEstimate
    ? `${Math.round(warmWaterEstimate.weightedTemperature)}°`
    : "--°";
  const warmWaterShowersAccessibilityLabel = `${warmWaterShowersValue} suihkua`;
  const tankUpdatedStatus = getTankUpdatedStatus(tankUpdatedAt, currentTime);
  const cheapestHour = chartHourlyPrices.reduce<HourlyPrice | null>(
    (cheapest, item) =>
      !cheapest || item.price < cheapest.price ? item : cheapest,
    null,
  );
  const averageSpotPrice = useMemo(
    () =>
      chartHourlyPrices.length > 0
        ? chartHourlyPrices.reduce((sum, item) => sum + item.price, 0) /
          chartHourlyPrices.length
        : null,
    [chartHourlyPrices],
  );
  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      supabase.auth
        .getUser()
        .then(
          ({ data }: { data: { user: { email?: string | null } | null } }) => {
            if (!isActive) {
              return;
            }

            if (!data.user) {
              router.replace("/login");
              return;
            }

            setUserEmail(data.user.email ?? null);
          },
        );

      let tankReadingsRefreshInFlight = false;

      const refreshTankReadings = async () => {
        if (tankReadingsRefreshInFlight) {
          debugLog("tank_readings refresh skipped while request is in flight");
          return;
        }

        tankReadingsRefreshInFlight = true;
        debugLog("tank_readings refreshed");

        try {
          const startOfYesterdayIso = getHelsinkiDateStartIso(
            getDateKeyOffset(-1),
          );
          const historyEndIso = new Date().toISOString();
          const sevenDaysAgoIso = new Date(
            Date.now() - 7 * 24 * 60 * 60 * 1000,
          ).toISOString();
          const heatingGainHistoryStartIso = new Date(
            Date.now() - heatingGainHistoryDays * 24 * 60 * 60 * 1000,
          ).toISOString();
          const [
            latestReadingResult,
            heatingHistoryResult,
            heatingGainHistoryResult,
            temperatureHistoryResult,
            temperatureDropProfileResult,
          ] =
            await Promise.all([
              supabase
                .from("tank_readings")
                .select("*")
                .order("created_at", { ascending: false })
                .limit(1)
                .single(),
              fetchAllHeatingHistory(async (from, to) => {
                const { data, error } = await supabase
                  .from("tank_readings")
                  .select("created_at,heating")
                  .gte("created_at", startOfYesterdayIso)
                  .lte("created_at", historyEndIso)
                  .order("created_at", { ascending: true })
                  .range(from, to);

                return { data, error };
              }),
              fetchHeatingGainHistory(async (from, to) => {
                const { data, error } = await supabase
                  .from("tank_readings")
                  .select("created_at,top_temp,bottom_temp,heating")
                  .eq("heating", true)
                  .gte("created_at", heatingGainHistoryStartIso)
                  .lte("created_at", historyEndIso)
                  .order("created_at", { ascending: true })
                  .range(from, to);

                return {
                  data: (data ?? []) as TankTemperatureReading[],
                  error,
                };
              }).catch((error) => ({
                error,
                fetchedRowCount: 0,
                pageCount: 0,
                readings: [] as TankTemperatureReading[],
              })),
              supabase
                .from("tank_readings")
                .select("created_at,top_temp,bottom_temp,heating")
                .gte("created_at", sevenDaysAgoIso)
                .order("created_at", { ascending: true }),
              fetchLatestTemperatureDropProfile(supabase).catch((error) => {
                console.warn("Failed to load temperature drop profile", error);
                return null;
              }),
            ]);

          if (!isActive) {
            return;
          }

          if (latestReadingResult.error) {
            console.error(latestReadingResult.error);
          } else {
            const reading = latestReadingResult.data as TankReading | null;

            setTopTemp(reading?.top_temp ?? null);
            setBottomTemp(reading?.bottom_temp ?? null);
            setHeating(reading?.heating ?? false);
            setTankUpdatedAt(reading?.created_at ?? null);
          }

          const todayKey = getDateKeyOffset(0);
          const yesterdayKey = getDateKeyOffset(-1);
          const realizedHeatingHours = calculateRealizedHeatingHours(
            heatingHistoryResult.readings,
            todayKey,
            yesterdayKey,
            getFinnishDateKey,
            (createdAt) => getHelsinkiHourNumber(new Date(createdAt)),
          );
          const heatingEnergy = calculateHeatingEnergyConsumption({
            getDateKey: getFinnishDateKey,
            readings: heatingHistoryResult.readings,
            todayKey,
          });

          debugLog("Heating history pagination debug", {
            actualHeatingHours: realizedHeatingHours,
            fetchedPages: heatingHistoryResult.pageCount,
            firstCreatedAt:
              heatingHistoryResult.readings[0]?.created_at ?? null,
            heatingEnergy,
            lastCreatedAt:
              heatingHistoryResult.readings.at(-1)?.created_at ?? null,
            rowCount: heatingHistoryResult.readings.length,
          });
          setActualHeatingHours(realizedHeatingHours);
          setStoredTemperatureDropProfile(temperatureDropProfileResult);

          if ("error" in heatingGainHistoryResult) {
            console.warn(
              "Failed to load paginated heating gain history",
              heatingGainHistoryResult.error,
            );
            setHeatingGainHistory([]);
            setHeatingGainHistoryFetch({ fetchedRowCount: 0, pageCount: 0 });
          } else {
            setHeatingGainHistory(heatingGainHistoryResult.readings);
            setHeatingGainHistoryFetch({
              fetchedRowCount: heatingGainHistoryResult.fetchedRowCount,
              pageCount: heatingGainHistoryResult.pageCount,
            });
          }

          if (temperatureHistoryResult.error) {
            console.error(temperatureHistoryResult.error);
            setTankTemperatureHistory([]);
          } else {
            setTankTemperatureHistory(
              (temperatureHistoryResult.data ?? []) as TankTemperatureReading[],
            );
          }
        } catch {
          if (!isActive) {
            return;
          }

          setTopTemp(null);
          setBottomTemp(null);
          setHeatingGainHistory([]);
          setHeatingGainHistoryFetch({ fetchedRowCount: 0, pageCount: 0 });
          setTankTemperatureHistory([]);
          setStoredTemperatureDropProfile(null);
          setHeating(false);
          setTankUpdatedAt(null);
        } finally {
          tankReadingsRefreshInFlight = false;

          if (isActive) {
            setLoading(false);
          }
        }
      };

      setLoading(true);
      void refreshTankReadings();

      const tankReadingsInterval = setInterval(() => {
        void refreshTankReadings();
      }, 30000);

      return () => {
        isActive = false;
        clearInterval(tankReadingsInterval);
      };
    }, [router]),
  );

  const fetchHourlyPrices = useCallback(async (signal?: AbortSignal) => {
    try {
      const yesterdayKey = getDateKeyOffset(-1);
      const todayKey = getDateKeyOffset(0);
      const tomorrowKey = getDateKeyOffset(1);

      const [
        { data: storedYesterdayData, error: storedYesterdayError },
        response,
      ] = await Promise.all([
        supabase
          .from("electricity_prices")
          .select(storedElectricityPriceColumns)
          .order("start_date", { ascending: true }),
        fetch(priceApiUrl, {
          signal,
        }),
      ]);

      if (!response.ok) {
        throw new Error("Price fetch failed");
      }

      const storedYesterdayFetchSucceeded = !storedYesterdayError;

      if (storedYesterdayError) {
        console.warn("Stored yesterday prices unavailable", {
          columns: storedElectricityPriceColumns,
          error: storedYesterdayError,
          storedYesterdayFetchSucceeded,
        });
      }

      const data = (await response.json()) as SpotPriceResponse[];
      const apiPrices = normalizeSpotPrices(data);
      const apiPriceDateKeys = Array.from(
        new Set(apiPrices.map((item) => getFinnishDateKey(item.startDate))),
      ).sort();
      const currentApiPrices = apiPrices.filter((item) => {
        const helsinkiDateKey = getFinnishDateKey(item.startDate);

        return helsinkiDateKey === todayKey || helsinkiDateKey === tomorrowKey;
      });
      await saveElectricityPrices(currentApiPrices);
      const storedYesterdayPrices = normalizeStoredElectricityPrices(
        (storedYesterdayData ?? []) as StoredElectricityPrice[],
      ).filter((item) => getFinnishDateKey(item.startDate) === yesterdayKey);
      const prices = [...storedYesterdayPrices, ...currentApiPrices].sort(
        (a, b) => a.date.getTime() - b.date.getTime(),
      );
      const todayCount = currentApiPrices.filter(
        (item) => getFinnishDateKey(item.startDate) === todayKey,
      ).length;
      const tomorrowCount = currentApiPrices.filter(
        (item) => getFinnishDateKey(item.startDate) === tomorrowKey,
      ).length;

      debugLog("Spot prices debug", {
        totalPricesCount: apiPrices.length,
        todayCount,
        tomorrowCount,
        firstStartDate: apiPrices[0]?.startDate ?? null,
        lastStartDate: apiPrices[apiPrices.length - 1]?.startDate ?? null,
        dateKeys: apiPriceDateKeys,
        storedYesterdayCount: storedYesterdayPrices.length,
        storedYesterdayColumns: storedElectricityPriceColumns,
        storedYesterdayFetchSucceeded,
      });

      if (currentApiPrices.length === 0) {
        throw new Error("Current hourly prices missing from response");
      }

      setHourlyPrices(prices);
      setSelectedHourlyPrice((selected) =>
        selected
          ? (prices.find((item) => item.id === selected.id) ?? null)
          : null,
      );
      setPriceError(null);
    } catch {
      if (!signal?.aborted) {
        setPriceError(
          "Hintojen päivitys epäonnistui. Näytetään aiemmat tiedot.",
        );
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    setIsPriceLoading(true);
    fetchHourlyPrices(controller.signal).finally(() => {
      if (!controller.signal.aborted) {
        setIsPriceLoading(false);
      }
    });

    return () => controller.abort();
  }, [fetchHourlyPrices]);

  useEffect(() => {
    const currentTimeInterval = setInterval(() => {
      setCurrentTime(new Date());
    }, 30000);

    return () => clearInterval(currentTimeInterval);
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);

    try {
      await fetchHourlyPrices();
    } finally {
      setManualOptimizationRevision((current) => current + 1);
      setIsRefreshing(false);
    }
  }, [fetchHourlyPrices]);

  useEffect(() => {
    setSelectedHourlyPrice((selected) =>
      selected && chartHourlyPrices.some((item) => item.id === selected.id)
        ? selected
        : null,
    );
  }, [chartHourlyPrices]);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnimation, {
          toValue: 1,
          duration: 1600,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnimation, {
          toValue: 0,
          duration: 1600,
          useNativeDriver: true,
        }),
      ]),
    );

    animation.start();

    return () => animation.stop();
  }, [pulseAnimation]);

  const pulseStyle = useMemo(
    () => ({
      opacity: pulseAnimation.interpolate({
        inputRange: [0, 1],
        outputRange: [0.35, 0.08],
      }),
      transform: [
        {
          scale: pulseAnimation.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 1.16],
          }),
        },
      ],
    }),
    [pulseAnimation],
  );
  const heatingCardPulseStyle = useMemo(
    () => ({
      transform: [
        {
          scale: pulseAnimation.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 1.018],
          }),
        },
      ],
    }),
    [pulseAnimation],
  );
  logHomeDayTabPerformance("HomeScreen render end", {
    durationMs: Date.now() - homeRenderStartedAt,
    estimatedElementCount: 220,
    selectedDay,
  });

  return (
    <View style={styles.screen}>
      <View style={[styles.glow, styles.greenGlow]} />
      <View style={[styles.glow, styles.blueGlow]} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            colors={["#36f4d4"]}
            onRefresh={handleRefresh}
            progressBackgroundColor="#050816"
            refreshing={isRefreshing}
            tintColor="#36f4d4"
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>EnergyZen</Text>
          <Text style={styles.subtitle}>Älykäs varaajan ohjaus</Text>
          {userEmail ? (
            <Text style={styles.loggedInText}>Kirjautunut: {userEmail}</Text>
          ) : null}
          {priceError ? (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {priceError}
            </Text>
          ) : null}
        </View>

        <View style={styles.ringStage}>
          <Animated.View
            style={[
              styles.pulse,
              pulseStyle,
              { borderColor: ringColor, shadowColor: ringColor },
            ]}
          />
          <Pressable
            accessibilityHint="Avaa sähkön hintahistorian"
            accessibilityLabel={
              currentPrice === null
                ? "Sähkön hintaa ei saatavilla"
                : `Spot-hinta ${formatFinnishDecimal(currentPrice)} senttiä kilowattitunnilta, yhteensä ${formatFinnishDecimal(currentTotalPrice ?? currentPrice)} senttiä kilowattitunnilta`
            }
            accessibilityRole="button"
            android_ripple={{ color: "rgba(255,255,255,0.1)" }}
            onPress={() => {
              logHistoryNavigationTap("electricity-history");
              router.push("/electricity-history");
            }}
            style={({ pressed }) => [
              styles.ring,
              { borderColor: ringColor, shadowColor: ringColor },
              pressed && styles.pressedRing,
            ]}
          >
            {currentPrice === null ? (
              <Text style={styles.priceMessage}>
                {isPriceLoading ? "Haetaan hintaa..." : "Hintaa ei saatavilla"}
              </Text>
            ) : (
              <>
                <Text style={styles.price}>
                  {formatFinnishDecimal(currentPrice)}
                </Text>
                <Text style={styles.unit}>c/kWh</Text>
                <View style={styles.totalPriceBlock}>
                  <Text style={styles.totalPriceLabel}>Yhteensä</Text>
                  <Text style={styles.totalPriceValue}>
                    {formatFinnishDecimal(currentTotalPrice ?? currentPrice)}
                    {" c/kWh"}
                  </Text>
                </View>
              </>
            )}
          </Pressable>
        </View>

        <View style={styles.cardsRow}>
          <Animated.View
            style={[
              styles.metricCard,
              styles.temperatureCard,
              {
                backgroundColor: temperatureCardTheme.backgroundColor,
                borderColor: temperatureCardTheme.borderColor,
                shadowColor: temperatureCardTheme.shadowColor,
              },
              isTankHeating && heatingCardPulseStyle,
            ]}
          >
            <Pressable
              accessibilityLabel={`Varaajan lämpötila ${displayedTopTemp} astetta${
                isTankHeating ? ", lämmitys käynnissä" : ""
              }${loading ? ", tietoja haetaan" : ""}`}
              accessibilityRole="button"
              android_ripple={{ color: "rgba(255,255,255,0.1)" }}
              onPress={() => {
                logHistoryNavigationTap("history");
                router.push("/history");
              }}
              style={({ pressed }) => [
                styles.metricCardPressable,
                pressed && styles.pressedMetricCard,
              ]}
            >
              <View style={styles.cardLabelRow}>
                <Text style={styles.cardIcon}>🔥</Text>
                <Text style={styles.cardLabel}>Varaaja</Text>
              </View>
              <View style={styles.temperatureStack}>
                <View style={styles.temperatureValues}>
                  <View style={styles.temperatureReadings}>
                    <View style={styles.temperatureTopSensor}>
                      <Text style={styles.temperatureValue}>
                        {displayedTopTemp}°
                      </Text>
                    </View>
                    <View style={styles.temperatureBottomSensor}>
                      <Text style={styles.temperatureLowValue}>
                        {displayedBottomTemp}°
                      </Text>
                    </View>
                  </View>
                  {tankUpdatedStatus ? (
                    <Text
                      style={[
                        styles.tankUpdatedText,
                        tankUpdatedStatus.isWarning &&
                          styles.tankUpdatedWarningText,
                      ]}
                    >
                      {tankUpdatedStatus.text}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.temperatureBar} accessible={false}>
                  {Array.from({ length: temperatureBarSegmentCount }).map(
                    (_, segmentIndex) => {
                      const segmentColor = getTemperatureBarSegmentColor(
                        segmentIndex,
                        temperatureBarSegmentCount,
                        tankTemperature,
                        bottomTemp ?? defaultTankTemperature,
                        settings,
                      );

                      return (
                        <View
                          key={`temperature-segment-${segmentIndex}`}
                          style={[
                            styles.temperatureBarSegment,
                            {
                              backgroundColor: segmentColor,
                              shadowColor: segmentColor,
                            },
                          ]}
                        />
                      );
                    },
                  )}
                </View>
              </View>
            </Pressable>
          </Animated.View>

          <View
            style={[
              styles.metricCard,
              styles.waterCard,
              {
                backgroundColor: warmWaterCardTheme.backgroundColor,
                borderColor: warmWaterCardTheme.borderColor,
                shadowColor: warmWaterCardTheme.shadowColor,
              },
            ]}
          >
            <Pressable
              accessibilityLabel={`Lämmintä vettä ${warmWaterShowersAccessibilityLabel}`}
              accessibilityRole="button"
              android_ripple={{ color: "rgba(255,255,255,0.1)" }}
              onPress={() => router.push("/settings")}
              style={({ pressed }) => [
                styles.metricCardPressable,
                pressed && styles.pressedMetricCard,
              ]}
            >
              <View style={styles.cardLabelRow}>
                <Text style={styles.cardIcon}>💧</Text>
                <Text style={styles.cardLabel}>Lämmin vesi</Text>
              </View>
              <View style={styles.warmWaterContent}>
                <View style={styles.warmWaterTankArea}>
                  <View style={styles.tankVisual}>
                    <View
                      style={[
                        styles.tankFill,
                        {
                          backgroundColor: warmWaterCardTheme.fillColor,
                          height: `${warmWaterFillPercent}%`,
                          shadowColor: warmWaterCardTheme.shadowColor,
                        },
                      ]}
                    />
                    <View
                      style={[
                        styles.tankSurface,
                        {
                          backgroundColor: warmWaterCardTheme.surfaceColor,
                          bottom: `${warmWaterFillPercent}%`,
                        },
                      ]}
                    />
                    <View style={[styles.tankBubble, styles.tankBubbleOne]} />
                    <View style={[styles.tankBubble, styles.tankBubbleTwo]} />
                    <View style={[styles.tankBubble, styles.tankBubbleThree]} />
                    <Text style={styles.tankAverageTemperature}>
                      {warmWaterAverageTempLabel}
                    </Text>
                  </View>
                </View>
                <View style={styles.waterShowersInfo}>
                  <Text style={styles.waterValue}>{warmWaterShowersLabel}</Text>
                  <Text numberOfLines={1} style={styles.waterDescriptionText}>
                    Lämmintä suihkua jäljellä
                  </Text>
                </View>
              </View>
            </Pressable>
          </View>
        </View>

        <View style={styles.chartCard}>
          <View style={styles.daySelector}>
            {(["yesterday", "today", "tomorrow"] as const).map((day) => {
              const isActive = selectedDay === day;
              const label = getDayLabel(day);

              return (
                <Pressable
                  accessibilityLabel={`Näytä ${label.toLowerCase()} hintakaavio`}
                  accessibilityRole="button"
                  key={day}
                  onPress={() => handleSelectedDayChange(day)}
                  style={[
                    styles.daySelectorButton,
                    isActive && styles.activeDaySelectorButton,
                  ]}
                >
                  <Text
                    style={[
                      styles.daySelectorText,
                      isActive && styles.activeDaySelectorText,
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.chartContent}>
            {isPriceLoading && hourlyPrices.length === 0 ? (
              <View style={styles.chartEmptyState}>
                <Text style={styles.chartMessage}>
                  Haetaan päivän hintoja...
                </Text>
              </View>
            ) : chartHourlyPrices.length === 0 ? (
              <View style={styles.chartEmptyState}>
                <Text style={styles.chartMessage}>
                  {selectedDay === "tomorrow"
                    ? "Huomisen hinnat eivät ole vielä saatavilla"
                    : selectedDay === "yesterday"
                      ? "Ei tallennettua hintadataa eiliselle"
                      : "Hintakaaviota ei saatavilla"}
                </Text>
              </View>
            ) : (
              <>
                <Pressable
                  accessibilityLabel="Tyhjennä kaavion valinta"
                  onPress={handleClearSelectedHourlyPrice}
                  style={styles.chartTouchArea}
                >
                  <View style={styles.chartPlotRow}>
                    <View pointerEvents="none" style={styles.chartScale}>
                      {chartScale.values.map((value) => (
                        <Text
                          key={value}
                          style={[
                            styles.chartScaleLabel,
                            {
                              bottom:
                                ((value - chartScale.min) / chartScale.range) *
                                chartGridMaxPosition,
                            },
                          ]}
                        >
                          {value}
                        </Text>
                      ))}
                    </View>

                    <View style={styles.chartPlot}>
                      <Text pointerEvents="none" style={styles.chartInnerUnit}>
                        c/kWh
                      </Text>
                      <View pointerEvents="none" style={styles.chartGrid}>
                        {chartScale.values.map((value) => (
                          <View
                            key={value}
                            style={[
                              styles.chartGridLine,
                              {
                                bottom:
                                  ((value - chartScale.min) /
                                    chartScale.range) *
                                  chartGridMaxPosition,
                              },
                            ]}
                          />
                        ))}
                      </View>

                      <View style={styles.chartBars}>
                        {chartHourlyPrices.map((item) => {
                          const isCurrentHour =
                            item.date.getTime() <= currentHourStart.getTime() &&
                            item.endDate.getTime() > currentHourStart.getTime();
                          const isPastHour =
                            selectedDay === "yesterday" ||
                            (selectedDay === "today" &&
                              item.endDate.getTime() <=
                                currentHourStart.getTime());
                          const isCheapest = cheapestHour?.id === item.id;
                          const isSelected =
                            selectedHourlyPrice?.id === item.id;
                          const dateHourKey = getHourlyPriceDateHourKey(item);
                          const isHeatedHour =
                            heatedHourIds.has(dateHourKey);
                          const heatingMarker = getHeatingHourMarker({
                            endsAt: item.endDate,
                            isActual: isHeatedHour,
                            isPlanned: plannedHeatingHourIds.has(dateHourKey),
                            now: currentHourStart,
                          });
                          const heatingMarkerLabel =
                            getHeatingMarkerLabel(heatingMarker);
                          const zeroBottom =
                            ((0 - chartScale.min) / chartScale.range) *
                            chartPlotHeight;
                          const barBottom =
                            item.price >= 0
                              ? zeroBottom
                              : ((item.price - chartScale.min) /
                                  chartScale.range) *
                                chartPlotHeight;
                          const availableBarHeight =
                            item.price >= 0
                              ? chartPlotHeight - zeroBottom
                              : zeroBottom;
                          const barHeight = Math.max(
                            (Math.abs(item.price) / chartScale.range) *
                              chartPlotHeight,
                            chartMinimumBarHeight,
                          );
                          const cappedBarHeight = Math.min(
                            barHeight,
                            availableBarHeight,
                          );
                          const barColor = isCheapest
                            ? "#72ff9d"
                            : getPriceTheme(item.price).ringColor;

                          return (
                            <Pressable
                              accessibilityHint="Näyttää valitun tunnin hinnan kaavion yläpuolella."
                              accessibilityLabel={`${item.hourLabel}, ${formatFinnishDecimal(item.price)} senttiä kilowattitunnilta${heatingMarkerLabel ? `, ${heatingMarkerLabel}` : ""}`}
                              accessibilityRole="button"
                              key={item.id}
                              onPress={(event) => {
                                event.stopPropagation();
                                handleSelectHourlyPrice(item);
                              }}
                              style={styles.chartBarButton}
                            >
                              {isSelected ? (
                                <View
                                  pointerEvents="none"
                                  style={[
                                    styles.chartTooltip,
                                    {
                                      bottom:
                                        item.price >= 0
                                          ? barBottom + cappedBarHeight + 12
                                          : zeroBottom + 12,
                                    },
                                  ]}
                                >
                                  <Text style={styles.chartTooltipTime}>
                                    {item.hourLabel}
                                  </Text>
                                  <Text style={styles.chartTooltipPrice}>
                                    {formatFinnishDecimal(item.price)} c/kWh
                                  </Text>
                                  {heatingMarkerLabel ? (
                                    <Text style={styles.chartTooltipMarker}>
                                      {heatingMarker} {heatingMarkerLabel}
                                    </Text>
                                  ) : null}
                                  <View style={styles.chartTooltipArrow} />
                                </View>
                              ) : null}

                              {heatingMarker ? (
                                <Text
                                  pointerEvents="none"
                                  style={[
                                    styles.chartHourMarker,
                                    {
                                      bottom:
                                        item.price >= 0
                                          ? barBottom + cappedBarHeight + 2
                                          : zeroBottom + 2,
                                    },
                                  ]}
                                >
                                  {heatingMarker}
                                </Text>
                              ) : null}

                              <View
                                style={[
                                  styles.chartBar,
                                  {
                                    backgroundColor: barColor,
                                    borderColor: isSelected
                                      ? "#ffffff"
                                      : isCurrentHour
                                        ? "rgba(255,255,255,0.74)"
                                        : "transparent",
                                    bottom: barBottom,
                                    height: cappedBarHeight,
                                    shadowColor: barColor,
                                  },
                                  isPastHour && styles.pastChartBar,
                                  isCurrentHour && styles.currentChartBar,
                                  isSelected && styles.selectedChartBar,
                                ]}
                              />
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  </View>
                </Pressable>

                <View style={styles.chartTimes}>
                  <Text style={styles.chartTime}>
                    {chartHourlyPrices[0]?.hourLabel ?? "00:00"}
                  </Text>
                  <Text style={styles.chartTime}>
                    {chartHourlyPrices[Math.floor(chartHourlyPrices.length / 2)]
                      ?.hourLabel ?? "12:00"}
                  </Text>
                  <Text style={styles.chartTime}>
                    {chartHourlyPrices[chartHourlyPrices.length - 1]
                      ?.hourLabel ?? "23:00"}
                  </Text>
                </View>

                <View style={styles.dailyAveragePriceInfo}>
                  <Text style={styles.dailyAveragePriceText}>
                    Päivän keskihinta{" "}
                    {averageSpotPrice === null
                      ? "--"
                      : formatFinnishDecimal(averageSpotPrice)}{" "}
                    c/kWh
                  </Text>
                </View>

                {hasUnsavedChanges ? (
                  <View style={styles.scenarioBanner}>
                    <Text style={styles.scenarioBannerTitle}>
                      Skenaariotila käytössä
                    </Text>
                    <Text style={styles.scenarioBannerText}>
                      Näytettävä suunnitelma perustuu tallentamattomiin asetuksiin. Shelly käyttää edelleen viimeksi tallennettuja asetuksia ja käytössä olevaa lämmityssuunnitelmaa.
                    </Text>
                    <View style={styles.scenarioViewToggle}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setPlanView("scenario")}
                        style={[
                          styles.scenarioViewButton,
                          planView === "scenario" && styles.scenarioViewButtonActive,
                        ]}
                      >
                        <Text style={styles.scenarioViewButtonText}>Skenaario</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setPlanView("active")}
                        style={[
                          styles.scenarioViewButton,
                          planView === "active" && styles.scenarioViewButtonActive,
                        ]}
                      >
                        <Text style={styles.scenarioViewButtonText}>Käytössä oleva</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}

                {hasUnsavedChanges &&
                planView === "scenario" &&
                scenarioValidation.errors.length > 0 ? (
                  <View style={styles.scenarioError}>
                    <Text style={styles.scenarioErrorTitle}>
                      Skenaariota ei voida laskea
                    </Text>
                    {scenarioValidation.errors.map((issue) => (
                      <Text key={`${issue.field}-${issue.message}`} style={styles.scenarioErrorText}>
                        {issue.message}
                      </Text>
                    ))}
                  </View>
                ) : hasUnsavedChanges &&
                  planView === "scenario" &&
                  !heatingPlanPresentation ? (
                  <View style={styles.heatingPlanInfo}>
                    <Text style={styles.heatingPlanInfoTitle}>
                      Skenaariota lasketaan
                    </Text>
                  </View>
                ) : heatingPlanPresentation ? (
                  <View style={styles.heatingPlanInfo}>
                    <Text style={styles.heatingPlanInfoTitle}>
                      {hasUnsavedChanges && planView === "scenario"
                        ? "Lämmityssuunnitelma · Skenaario"
                        : "Lämmityssuunnitelma"}
                    </Text>
                    {heatingPlanPresentation.selectedHours.length > 0 ? (
                      <View style={styles.heatingPlanHourList}>
                        {heatingPlanPresentation.selectedHours.map(
                          (hour, index) => {
                            const { costLabel, priceLabel, timeLabel } =
                              splitHeatingHourLabel(hour.label);

                            return (
                              <Text
                                key={`${hour.period}-${hour.label}-${index}`}
                                style={styles.heatingPlanHourText}
                              >
                                ⭐ {hour.period} {timeLabel}
                                {priceLabel ? (
                                  <>
                                    {" · "}
                                    <Text style={styles.heatingPlanHourPrice}>
                                      {priceLabel}
                                    </Text>
                                  </>
                                ) : null}
                                {costLabel ? (
                                  <>
                                    {" · "}
                                    <Text style={styles.heatingPlanHourCost}>
                                      {costLabel}
                                    </Text>
                                  </>
                                ) : null}
                              </Text>
                            );
                          },
                        )}
                      </View>
                    ) : (
                      <Text style={styles.heatingPlanInfoText}>
                        {heatingPlanPresentation.emptyPlanLabel}
                      </Text>
                    )}
                    {heatingPlanPresentation.planCostSummary ? (
                      (() => {
                        const { label, value } = splitPlanCostSummary(
                          heatingPlanPresentation.planCostSummary,
                        );

                        return (
                          <View style={styles.planEstimatedPriceRow}>
                            <Text style={styles.planEstimatedPriceLabel}>
                              {label}
                            </Text>
                            <Text style={styles.planEstimatedPriceValue}>
                              {value ?? ""}
                            </Text>
                          </View>
                        );
                      })()
                    ) : null}

                    <Text style={styles.heatingPlanForecastSubtitle}>
                      Ennuste
                    </Text>
                    {(() => {
                      const forecastParts = splitForecastSummary(
                        heatingPlanPresentation.forecastSummary,
                      );

                      return forecastParts ? (
                        <Text style={styles.heatingPlanForecastText}>
                          Nyt{" "}
                          <Text style={styles.heatingPlanForecastValue}>
                            {forecastParts.currentShowers}
                          </Text>
                          {" · alimmillaan "}
                          <Text style={styles.heatingPlanForecastMinimumValue}>
                            {forecastParts.minimumShowers}
                          </Text>
                          {" · "}
                          {forecastParts.endLabel}{" "}
                          <Text style={styles.heatingPlanForecastValue}>
                            {forecastParts.finalShowers}
                          </Text>{" "}
                          suihkua
                        </Text>
                      ) : (
                        <Text style={styles.heatingPlanForecastText}>
                          {heatingPlanPresentation.forecastSummary}
                        </Text>
                      );
                    })()}

                    <Text style={styles.heatingPlanLimitsSubtitle}>
                      Käytetyt rajat
                    </Text>
                    {(() => {
                      const limitsParts = splitLimitsSummary(
                        heatingPlanPresentation.limitsSummary,
                      );

                      return limitsParts ? (
                        <Text style={styles.heatingPlanLimitsText}>
                          Tavoite{" "}
                          <Text style={styles.heatingPlanLimitValue}>
                            {limitsParts.targetReserve}
                          </Text>{" "}
                          suihkua · turvaraja{" "}
                          <Text style={styles.heatingPlanLimitValue}>
                            {limitsParts.safetyReserve}
                          </Text>{" "}
                          suihkua
                        </Text>
                      ) : (
                        <Text style={styles.heatingPlanLimitsText}>
                          {heatingPlanPresentation.limitsSummary}
                        </Text>
                      );
                    })()}
                  </View>
                ) : settings.heatingNeedMode === "fixed" ? (
                  <View style={styles.heatingPlanInfo}>
                    <Text style={styles.heatingPlanInfoTitle}>
                      Manuaalinen ohjaus
                    </Text>
                    <Text style={styles.manualHeatingInfoText}>
                      Lämmitys toimii valitsemiesi tuntien mukaan.
                    </Text>

                    <Text style={styles.manualHeatingSectionTitle}>
                      Valitut tunnit
                    </Text>
                    <Text style={styles.manualHeatingHoursText}>
                      {manualSelectedHeatingHoursText}
                    </Text>
                    {heating && isManualHeatingHourNow ? (
                      <Text style={styles.manualHeatingStatusText}>
                        Lämmitys käynnissä valitun tunnin mukaan.
                      </Text>
                    ) : null}
                  </View>
                ) : explanationVisible ? (
                  <View style={styles.heatingPlanInfo}>
                    <Text style={styles.heatingPlanInfoTitle}>
                      Lämmityssuunnitelma muuttui
                    </Text>
                    <Text style={styles.heatingPlanInfoText}>
                      {showSeparatedTodayHeatingHours ? (
                        <>
                          Lämmitystuntien enimmäismäärä{" "}
                          on {configuredHeatingHours} h / vrk.{"\n"}
                          Toteutunut {todayActualHeatingHoursCount} h, jäljellä{" "}
                          {remainingPlannedHeatingHoursCount} h.
                        </>
                      ) : (
                        <>
                          Lämmitystuntien enimmäismäärä{" "}
                          on {configuredHeatingHours} h / vrk, mutta suunnitelmaan valittiin{" "}
                          {selectedHeatingHoursCount} h.
                        </>
                      )}
                    </Text>
                    <Text style={styles.heatingPlanInfoReason}>
                      Lämpötilaennusteen perusteella varaaja tarvitsee{" "}
                      {forecastHeatingDuration} lämmitystä ennen seuraavaa{" "}
                      lämmityskertaa. {tomorrowPricesAvailable
                        ? "Tunnit valittiin tämän ja huomisen halvimpien hintojen perusteella."
                        : "Huomisen hintoja ei ole vielä saatavilla, joten tunnit valittiin tältä päivältä."}
                    </Text>
                  </View>
                ) : null}
              </>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#050816",
    overflow: "hidden",
  },
  content: {
    alignItems: "center",
    flexGrow: 1,
    justifyContent: "center",
    paddingBottom: 28,
    paddingHorizontal: 20,
    paddingTop: 58,
  },
  glow: {
    borderRadius: 999,
    height: 280,
    opacity: 0.27,
    position: "absolute",
    shadowOpacity: 0.55,
    shadowRadius: 72,
    width: 280,
  },
  greenGlow: {
    backgroundColor: "#54eaa0",
    boxShadow: "0 0 92px 44px rgba(84,234,160,0.32)",
    right: -150,
    shadowColor: "#54eaa0",
    top: 80,
  },
  blueGlow: {
    backgroundColor: "#5aa7ff",
    bottom: 70,
    boxShadow: "0 0 96px 46px rgba(90,167,255,0.3)",
    left: -170,
    shadowColor: "#5aa7ff",
  },
  header: {
    alignItems: "center",
    marginBottom: 12,
  },
  title: {
    color: "#f7fbff",
    fontSize: 28,
    fontWeight: "900",
    letterSpacing: -0.4,
    textAlign: "center",
  },
  subtitle: {
    color: "#b9d7ff",
    fontSize: 15,
    fontWeight: "700",
    marginTop: 5,
    textAlign: "center",
  },
  loggedInText: {
    color: "#8ea4cf",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 6,
    textAlign: "center",
  },
  errorText: {
    color: "#ffad4d",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 6,
    textAlign: "center",
  },
  scenarioBanner: {
    alignSelf: "stretch",
    backgroundColor: "rgba(255, 181, 71, 0.16)",
    borderColor: "rgba(255, 181, 71, 0.52)",
    borderRadius: 8,
    borderWidth: 1,
    gap: 7,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  scenarioBannerTitle: {
    color: "#ffe1a6",
    fontSize: 14,
    fontWeight: "900",
  },
  scenarioBannerText: {
    color: "#f7d8a0",
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
  scenarioViewToggle: {
    flexDirection: "row",
    gap: 8,
    marginTop: 2,
  },
  scenarioViewButton: {
    alignItems: "center",
    borderColor: "rgba(255, 225, 166, 0.42)",
    borderRadius: 6,
    borderWidth: 1,
    flex: 1,
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  scenarioViewButtonActive: {
    backgroundColor: "rgba(255, 213, 135, 0.22)",
    borderColor: "#ffe1a6",
  },
  scenarioViewButtonText: {
    color: "#fff2d2",
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center",
  },
  scenarioError: {
    alignSelf: "stretch",
    backgroundColor: "rgba(255, 95, 109, 0.13)",
    borderColor: "rgba(255, 95, 109, 0.44)",
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  scenarioErrorTitle: {
    color: "#ffc3c8",
    fontSize: 14,
    fontWeight: "900",
  },
  scenarioErrorText: {
    color: "#ffd4d8",
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
  heatingPlanInfo: {
    alignSelf: "stretch",
    backgroundColor: "rgba(54,244,212,0.12)",
    borderColor: "rgba(54,244,212,0.36)",
    borderRadius: 18,
    borderWidth: 1,
    gap: 7,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  heatingPlanInfoTitle: {
    color: "#f7fbff",
    fontSize: 14,
    fontWeight: "900",
  },
  heatingPlanInfoSubtitle: {
    color: "#dffefa",
    fontSize: 12,
    fontWeight: "900",
    marginTop: 4,
  },
  heatingPlanForecastSubtitle: {
    color: "#f7fbff",
    fontSize: 12,
    fontWeight: "900",
    marginTop: 3,
  },
  heatingPlanLimitsSubtitle: {
    color: "#9fc7ff",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 4,
  },
  heatingPlanHourList: {
    gap: 2,
  },
  heatingPlanHourText: {
    color: "#cfe9ff",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  heatingPlanHourPrice: {
    color: "#72ff9d",
    fontWeight: "800",
  },
  heatingPlanHourCost: {
    color: "#9df5d5",
    fontWeight: "800",
  },
  heatingPlanInfoText: {
    color: "#cfe9ff",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  planEstimatedPriceRow: {
    alignItems: "baseline",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 3,
    minHeight: 20,
  },
  planEstimatedPriceLabel: {
    color: "#9fc7ff",
    flex: 1,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 18,
  },
  planEstimatedPriceValue: {
    color: "#72ff9d",
    fontSize: 14,
    fontWeight: "700",
    flexShrink: 0,
    lineHeight: 20,
    marginLeft: 12,
    textAlign: "right",
  },
  heatingPlanForecastText: {
    color: "#cfe9ff",
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 18,
  },
  heatingPlanForecastValue: {
    color: "#72ff9d",
    fontSize: 14,
    fontWeight: "700",
  },
  heatingPlanForecastMinimumValue: {
    color: "#9df5d5",
    fontSize: 14,
    fontWeight: "700",
  },
  heatingPlanLimitsText: {
    color: "#9fc7ff",
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
  heatingPlanLimitValue: {
    fontWeight: "700",
  },
  heatingPlanInfoReason: {
    color: "#9fc7ff",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17,
  },
  manualHeatingInfoText: {
    color: "#9fc7ff",
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 18,
  },
  manualHeatingSectionTitle: {
    color: "#f7fbff",
    fontSize: 12,
    fontWeight: "900",
    marginTop: 4,
  },
  manualHeatingHoursText: {
    color: "#dffefa",
    fontSize: 13,
    fontWeight: "800",
    lineHeight: 18,
  },
  manualHeatingStatusText: {
    color: "#9df5d5",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17,
  },
  ringStage: {
    alignItems: "center",
    height: 286,
    justifyContent: "center",
    marginBottom: 18,
    width: 286,
  },
  pulse: {
    borderRadius: 143,
    borderWidth: 2,
    height: 286,
    position: "absolute",
    shadowOpacity: 0.8,
    shadowRadius: 32,
    width: 286,
  },
  ring: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderRadius: 122,
    borderWidth: 5,
    height: 244,
    justifyContent: "center",
    shadowOpacity: 0.85,
    shadowRadius: 34,
    width: 244,
  },
  pressedRing: {
    opacity: 0.86,
    transform: [{ scale: 0.98 }],
  },
  price: {
    color: "#ffffff",
    fontSize: 68,
    fontWeight: "900",
    letterSpacing: -2,
  },
  priceMessage: {
    color: "#ffffff",
    fontSize: 23,
    fontWeight: "900",
    lineHeight: 31,
    paddingHorizontal: 28,
    textAlign: "center",
  },
  unit: {
    color: "#cfe9ff",
    fontSize: 18,
    fontWeight: "700",
    marginTop: -4,
  },
  totalPriceBlock: {
    alignItems: "center",
    marginTop: 9,
  },
  totalPriceLabel: {
    color: "#9fc7df",
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 15,
  },
  totalPriceValue: {
    color: "#e9fbff",
    fontSize: 17,
    fontWeight: "900",
    lineHeight: 21,
  },
  cardsRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 14,
    width: "100%",
  },
  metricCard: {
    alignItems: "center",
    borderRadius: 28,
    borderWidth: 1.5,
    flex: 1,
    justifyContent: "space-between",
    minHeight: 160,
    overflow: "hidden",
    paddingHorizontal: 14,
    paddingVertical: 13,
    shadowOpacity: 0.38,
    shadowRadius: 24,
  },
  metricCardPressable: {
    alignItems: "center",
    flex: 1,
    justifyContent: "space-between",
    position: "relative",
    width: "100%",
  },
  temperatureCard: {
    borderWidth: 1.5,
    position: "relative",
  },
  waterCard: {
    shadowOpacity: 0.42,
  },
  warmWaterContent: {
    alignItems: "stretch",
    alignSelf: "stretch",
    flex: 1,
    justifyContent: "center",
    marginTop: 10,
    width: "100%",
  },
  warmWaterTankArea: {
    alignItems: "center",
    alignSelf: "stretch",
    flex: 1,
    justifyContent: "center",
    minHeight: 108,
    width: "100%",
  },
  pressedMetricCard: {
    opacity: 0.82,
  },
  cardLabelRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 24,
  },
  cardIcon: {
    fontSize: 18,
    lineHeight: 22,
    textAlign: "center",
  },
  cardLabel: {
    color: "rgba(247,251,255,0.82)",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.3,
    textAlign: "center",
    textTransform: "uppercase",
  },
  tankUpdatedText: {
    alignSelf: "stretch",
    color: "rgba(247,251,255,0.62)",
    fontSize: 9,
    fontWeight: "800",
    lineHeight: 11,
    marginBottom: 1,
    textAlign: "left",
  },
  tankUpdatedWarningText: {
    color: "#ffcf7a",
  },
  temperatureStack: {
    alignItems: "stretch",
    alignSelf: "stretch",
    flex: 1,
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    marginRight: -5,
    marginTop: 8,
    paddingRight: 2,
    width: "100%",
  },
  temperatureValues: {
    alignSelf: "stretch",
    flex: 1,
    justifyContent: "space-between",
    minWidth: 0,
    paddingBottom: 1,
    paddingLeft: 4,
    paddingRight: 4,
  },
  temperatureReadings: {
    alignItems: "flex-start",
    flex: 1,
    justifyContent: "space-around",
    paddingBottom: 14,
    paddingTop: 2,
  },
  temperatureTopSensor: {
    alignItems: "flex-start",
    alignSelf: "center",
    marginRight: 6,
  },
  temperatureBottomSensor: {
    alignItems: "flex-start",
    alignSelf: "center",
    marginLeft: 4,
    marginTop: 12,
  },
  temperatureValue: {
    color: "#ffffff",
    fontSize: 46,
    fontWeight: "900",
    letterSpacing: -1.6,
    lineHeight: 48,
    textAlign: "right",
    textShadowColor: "rgba(0,0,0,0.24)",
    textShadowOffset: { height: 2, width: 0 },
    textShadowRadius: 10,
  },
  temperatureBar: {
    alignItems: "center",
    alignSelf: "stretch",
    gap: 4,
    justifyContent: "space-between",
    marginRight: 0,
  },
  temperatureBarSegment: {
    borderRadius: 7,
    flex: 1,
    minHeight: 8,
    shadowOpacity: 0.28,
    shadowRadius: 6,
    width: 13,
  },
  temperatureLowValue: {
    color: "rgba(247,251,255,0.86)",
    fontSize: 24,
    fontWeight: "900",
    letterSpacing: -0.6,
    lineHeight: 26,
    textAlign: "right",
    textShadowColor: "rgba(0,0,0,0.2)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 8,
  },
  tankVisual: {
    backgroundColor: "rgba(2,11,30,0.42)",
    borderColor: "rgba(221,247,255,0.72)",
    borderRadius: 26,
    borderWidth: 2,
    height: 112,
    overflow: "hidden",
    position: "relative",
    width: 82,
  },
  tankFill: {
    backgroundColor: "#40d9ff",
    borderTopColor: "rgba(255,255,255,0.42)",
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    shadowColor: "#40d9ff",
    shadowOpacity: 0.56,
    shadowRadius: 16,
  },
  tankSurface: {
    backgroundColor: "rgba(255,255,255,0.78)",
    borderRadius: 999,
    height: 3,
    left: 8,
    marginBottom: -1.5,
    position: "absolute",
    right: 8,
  },
  tankBubble: {
    backgroundColor: "rgba(255,255,255,0.78)",
    borderRadius: 999,
    height: 5,
    position: "absolute",
    width: 5,
  },
  tankBubbleOne: {
    bottom: 14,
    left: 16,
  },
  tankBubbleTwo: {
    bottom: 34,
    right: 14,
  },
  tankBubbleThree: {
    bottom: 48,
    left: 25,
    opacity: 0.72,
  },
  tankAverageTemperature: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "900",
    left: 0,
    letterSpacing: -0.4,
    lineHeight: 32,
    position: "absolute",
    right: 0,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.34)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 8,
    top: 39,
  },
  waterShowersInfo: {
    alignItems: "center",
    alignSelf: "stretch",
    marginTop: 8,
    width: "100%",
  },
  waterValue: {
    alignSelf: "stretch",
    color: "#f8fbff",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: -0.2,
    lineHeight: 22,
    textAlign: "center",
  },
  waterDescriptionText: {
    alignSelf: "stretch",
    color: "rgba(247,251,255,0.66)",
    fontSize: 9,
    fontWeight: "800",
    lineHeight: 11,
    marginTop: 1,
    textAlign: "center",
  },
  chartCard: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 24,
    borderWidth: 1,
    padding: 16,
    width: "100%",
  },
  daySelector: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    marginBottom: 8,
    padding: 5,
  },
  daySelectorButton: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 10,
  },
  activeDaySelectorButton: {
    backgroundColor: "rgba(54,244,212,0.18)",
    borderColor: "rgba(191,255,238,0.38)",
    borderWidth: 1,
    shadowColor: "#36f4d4",
    shadowOpacity: 0.28,
    shadowRadius: 12,
  },
  daySelectorText: {
    color: "#8ea4cf",
    fontSize: 14,
    fontWeight: "900",
  },
  activeDaySelectorText: {
    color: "#f8fbff",
  },
  chartContent: {
    minHeight: 214,
  },
  chartEmptyState: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: 214,
  },
  chartTouchArea: {
    height: 124,
    justifyContent: "flex-end",
  },
  chartPlotRow: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 8,
    overflow: "visible",
  },
  chartScale: {
    height: chartPlotHeight,
    position: "relative",
    width: 24,
  },
  chartScaleLabel: {
    color: "rgba(207,233,255,0.52)",
    fontSize: 10,
    fontWeight: "800",
    lineHeight: 12,
    position: "absolute",
    right: 0,
    transform: [{ translateY: 6 }],
  },
  chartPlot: {
    flex: 1,
    height: chartPlotHeight,
    overflow: "visible",
    position: "relative",
  },
  chartInnerUnit: {
    color: "rgba(207,233,255,0.58)",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.2,
    lineHeight: 12,
    position: "absolute",
    right: 0,
    top: -16,
  },
  chartGrid: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  chartGridLine: {
    backgroundColor: "rgba(207,233,255,0.1)",
    height: 1,
    left: 0,
    position: "absolute",
    right: 0,
  },
  chartBars: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 4,
    height: chartPlotHeight,
    overflow: "visible",
  },
  chartBarButton: {
    alignItems: "center",
    flex: 1,
    height: chartPlotHeight,
    justifyContent: "flex-end",
    overflow: "visible",
    position: "relative",
  },
  chartHourMarker: {
    fontSize: 11,
    lineHeight: 13,
    marginBottom: 2,
    position: "absolute",
    textAlign: "center",
  },
  chartBar: {
    borderRadius: 8,
    borderWidth: 1.5,
    opacity: 0.9,
    position: "absolute",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    width: "100%",
  },
  pastChartBar: {
    opacity: 0.28,
    shadowOpacity: 0.08,
  },
  currentChartBar: {
    borderWidth: 2,
    opacity: 1,
    shadowColor: "#ffffff",
    shadowOpacity: 0.42,
    shadowRadius: 12,
  },
  selectedChartBar: {
    borderWidth: 2,
    opacity: 1,
    shadowOpacity: 0.95,
    shadowRadius: 18,
    transform: [{ translateY: -4 }],
  },
  chartTooltip: {
    alignItems: "center",
    backgroundColor: "rgba(8,13,31,0.96)",
    borderColor: "rgba(255,255,255,0.22)",
    borderRadius: 14,
    borderWidth: 1,
    left: "50%",
    marginLeft: -55,
    paddingHorizontal: 10,
    paddingVertical: 8,
    position: "absolute",
    shadowColor: "#36f4d4",
    shadowOpacity: 0.32,
    shadowRadius: 16,
    width: 110,
    zIndex: 10,
  },
  chartTooltipTime: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "900",
    lineHeight: 17,
  },
  chartTooltipPrice: {
    color: "#bfffee",
    fontSize: 12,
    fontWeight: "900",
    lineHeight: 16,
  },
  chartTooltipMarker: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
    marginTop: 4,
    textAlign: "center",
  },
  chartTooltipArrow: {
    borderLeftColor: "transparent",
    borderLeftWidth: 6,
    borderRightColor: "transparent",
    borderRightWidth: 6,
    borderTopColor: "rgba(8,13,31,0.96)",
    borderTopWidth: 7,
    bottom: -7,
    height: 0,
    position: "absolute",
    width: 0,
  },
  chartTimes: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  chartTime: {
    color: "#8190b5",
    fontSize: 12,
    fontWeight: "800",
  },
  chartMessage: {
    color: "#cfe9ff",
    fontSize: 15,
    fontWeight: "800",
    textAlign: "center",
  },
  dailyAveragePriceInfo: {
    borderTopColor: "rgba(255,255,255,0.1)",
    borderTopWidth: 1,
    marginTop: 14,
    paddingTop: 14,
  },
  dailyAveragePriceText: {
    color: "#8190b5",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
});

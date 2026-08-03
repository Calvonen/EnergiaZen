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

import { PriceCard } from "@/components/home/price-card";
import { PriceChart } from "@/components/home/price-chart";
import { TemperatureCard } from "@/components/home/temperature-card";
import { WarmWaterCard } from "@/components/home/warm-water-card";
import { debugLog } from "@/lib/debug";
import { getTemperatureBarSegmentColor } from "@/lib/temperatureColors";
import {
  computeTankReadingAgeMinutes,
  isTankReadingStale,
} from "@/lib/tankMonitorAlert";
import { isTankReadingFreshForCalculation } from "@/lib/tankReadingFreshness";
import {
  formatWeeklyMinimumInletTemperatureAccessibilityText,
  formatWeeklyMinimumInletTemperatureLabel,
  getTemperatureCardTheme,
} from "@/lib/temperaturePresentation";
import { getPriceTheme } from "@/lib/pricePresentation";
import {
  getSortedUniqueHelsinkiHourNumbers,
  normalizePriceToCents,
} from "@/lib/priceUtils";
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
import { backtestHeatingGainEstimate } from "@/lib/heatingGainBacktest";
import {
  getHeatingHourMarker,
  heatingMarkers,
  normalizeStoredHeatingPlanHours,
} from "@/lib/heatingPlanMarkers";
import {
  calculateStratifiedShowersLeft,
  HeatingOptimizationHour,
  HeatingOptimizationResult,
  HourlyHeatingForecast,
} from "@/lib/heatingOptimizer";
import { useHeatingOptimizationRun } from "@/lib/useHeatingOptimizationRun";
import {
  buildHeatingPlanPresentation,
  buildStoredHeatingPlanPresentation,
  hasCheaperSafetyRejectedPlan,
  selectActiveHeatingPlanPresentation,
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
import { calculateMinimumValidInletTemperature } from "@/lib/inletTemperature";
import {
  fetchLatestTemperatureDropProfile,
  selectTemperatureDropProfile,
  TemperatureDropProfile,
} from "@/lib/temperatureDropProfile";

const DEBUG_HISTORY_PERFORMANCE = false;
const DEBUG_HOME_DAY_TAB_PERFORMANCE = false;
const DEBUG_HEATING_OPTIMIZATION = false;

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

function formatFinnishDecimal(value: number) {
  return value.toFixed(1).replace(".", ",");
}

function formatSignedFinnishDecimal(value: number) {
  return formatFinnishDecimal(value);
}

function capitalizeFirstLetter(text: string) {
  return text.length > 0 ? text[0].toLocaleUpperCase("fi-FI") + text.slice(1) : text;
}

function splitHeatingHourLabel(label: string) {
  const [timeLabel, priceLabel, costLabel] = label.split(" · ");

  return { costLabel, priceLabel, timeLabel: timeLabel ?? label };
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

function getPointInTimeLabel({
  date,
  todayDateKey,
  tomorrowDateKey,
}: {
  date: Date;
  todayDateKey: string;
  tomorrowDateKey: string;
}) {
  const dateKey = getFinnishDateKey(date.toISOString());
  const time = helsinkiTimeFormatter.format(date).replace(".", ":");

  if (dateKey === todayDateKey) {
    return `tänään klo ${time}`;
  }

  if (dateKey === tomorrowDateKey) {
    return `huomenna klo ${time}`;
  }

  return `klo ${time}`;
}

// "Alimmillaan"-lukeman pitaa kuvata lahiaikaista pohjaa - alinta
// ennustettua suihkumaaraa ennen SEURAAVAA suunniteltua lammitysta - eika
// koko ennustejakson minimia. Koko jakson minimi osuu usein jakson
// viimeiseen tuntiin (nayttaen samalta kuin "lopussa"-rivi), varsinkin
// kun tulevaisuudessa ei viela ole toista lammityskertaa naissa. Siksi
// haku pysahtyy ensimmaiseen valittuun lammitystuntiin: sen showersLeftBefore
// otetaan viela mukaan (pohja juuri ennen lammityksen alkua), mutta
// showersLeftAfter (lammityksen jalkeinen, jo noussut arvo) ei enaa.
function findMinimumShowersBeforeNextHeating(
  forecast: Pick<
    HourlyHeatingForecast,
    | "isHeatingSelected"
    | "showersLeftAfter"
    | "showersLeftBefore"
    | "segmentHours"
    | "startDate"
  >[],
): { date: Date; value: number } | null {
  let minimum: { date: Date; value: number } | null = null;

  const updateMinimum = (value: number, date: Date) => {
    if (!minimum || value < minimum.value) {
      minimum = { date, value };
    }
  };

  for (const hour of forecast) {
    const startDate = new Date(hour.startDate);

    updateMinimum(hour.showersLeftBefore, startDate);

    if (hour.isHeatingSelected) {
      break;
    }

    updateMinimum(
      hour.showersLeftAfter,
      new Date(startDate.getTime() + hour.segmentHours * 60 * 60 * 1000),
    );
  }

  return minimum;
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
  // setMinutes(...) truncates using the JS engine's own local Date/timezone
  // handling, which is not guaranteed to agree with Europe/Helsinki (unlike
  // every other Helsinki-based date computation in this file, which goes
  // through an explicit timeZone: "Europe/Helsinki" Intl formatter). Read
  // the Helsinki wall-clock minute/second directly instead, the same way,
  // and subtract only that elapsed time from the (timezone-agnostic) instant.
  const parts = helsinkiDateTimePartsFormatter.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const elapsedMsInHelsinkiHour =
    getPart("minute") * 60000 + getPart("second") * 1000 + (date.getTime() % 1000);

  return new Date(date.getTime() - elapsedMsInHelsinkiHour);
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
  const minimumBeforeNextHeating = findMinimumShowersBeforeNextHeating(
    optimizationResult.forecast,
  );
  const minimumShowersTimeLabel = minimumBeforeNextHeating
    ? getPointInTimeLabel({
        date: minimumBeforeNextHeating.date,
        todayDateKey: todayPlanDate,
        tomorrowDateKey: tomorrowPlanDate,
      })
    : null;

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
    minimumShowersBeforeNextHeating:
      minimumBeforeNextHeating?.value ??
      optimizationResult.minimumPredictedShowersLeft,
    minimumShowersTimeLabel,
    planValid: optimizationResult.valid,
    safetyShowerReserve: runSettings.safetyShowerReserve,
    selectedHours,
    targetCheckShowersLeft: optimizationResult.targetCheckShowersLeft,
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
  // See calculateMinimumValidInletTemperature for how this value is
  // filtered (a confirmation window, not a raw minimum).
  const [weeklyMinimumInletTemperature, setWeeklyMinimumInletTemperature] =
    useState<number | null>(null);
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
  const priceCardAccessibilityLabel =
    currentPrice === null
      ? "Sähkön hintaa ei saatavilla"
      : `Spot-hinta ${formatFinnishDecimal(currentPrice)} senttiä kilowattitunnilta, yhteensä ${formatFinnishDecimal(currentTotalPrice ?? currentPrice)} senttiä kilowattitunnilta`;
  const priceCardPriceLabel =
    currentPrice === null ? "" : formatFinnishDecimal(currentPrice);
  const priceCardTotalPriceLabel =
    currentPrice === null
      ? ""
      : formatFinnishDecimal(currentTotalPrice ?? currentPrice);
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
  // Evenly spaced reference points independent of chartPriceStep, so a low
  // price range (e.g. 0-5 c/kWh, chartPriceStep's own two values) still gets
  // enough lines to read a single bar's price by eye. Grid lines and their
  // left-axis numbers share this one source so a line never renders without
  // its value (and vice versa).
  const chartAxisValues = useMemo(() => {
    const divisions = 4;

    return Array.from(
      { length: divisions + 1 },
      (_, index) => chartScale.min + (index / divisions) * chartScale.range,
    );
  }, [chartScale.min, chartScale.range]);
  const chartGridLineValues = useMemo(
    () => chartAxisValues.slice(1, -1),
    [chartAxisValues],
  );
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
  const displayedWeeklyMinimumInletTemp =
    formatWeeklyMinimumInletTemperatureLabel(weeklyMinimumInletTemperature);
  // Gates the calculations listed in isTankReadingFreshForCalculation's own
  // doc comment (shower estimate, forecast, automatic heating need,
  // heating_plans publish) - topTemp/bottomTemp/tankUpdatedAt themselves
  // stay as the last known values so the temperature card can keep
  // displaying them (marked stale via tankUpdatedStatus below), per
  // CLAUDE.md scope: this is a targeted safety fix, not a display rewrite.
  const isTankReadingFresh = isTankReadingFreshForCalculation(
    tankUpdatedAt,
    currentTime,
  );
  const warmWaterEstimate = isTankReadingFresh
    ? getStratifiedWarmWaterEstimate(topTemp, bottomTemp, settings)
    : null;
  // Same gating for the forecast below: a stale reading must not be
  // extrapolated forward as if it were a trustworthy starting point.
  const freshWeightedTemperature = isTankReadingFresh
    ? currentWeightedTemperature
    : null;
  // selectHeatingRecommendation's tankTemperature param isn't nullable, so a
  // stale reading falls back to the same defaultTankTemperature it already
  // uses when there is no reading at all, instead of letting the automatic
  // heating-need decision act on an outdated temperature. This is a
  // deliberate conservative no-data placeholder, not a real measurement -
  // it only ever reaches heatingRecommendation below, the legacy/manual-mode
  // display recommendation. It is never published to heating_plans: that
  // publish path is activeOptimizationRun.result (see useHeatingOptimizationRun.ts),
  // which runs through the fully independent heatingOptimizer pipeline and is
  // gated separately by shouldRunHeatingOptimization/isHeatingOptimizationResultUsable.
  // isOptimizerPlanActive below prefers that optimizer result over
  // heatingRecommendation whenever automatic mode has one, so this fallback
  // is visible to the user only as a fixed-mode suggestion or a transient
  // "no fresh optimizer result yet" placeholder, never as a silently
  // temperature-driven automatic decision.
  const tankTemperatureForCalculation = isTankReadingFresh
    ? tankTemperature
    : defaultTankTemperature;
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
      tankTemperatureForCalculation,
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
      freshWeightedTemperature === null
    ) {
      return {
        heatingHoursBeforeForecast:
          heatingHoursBeforeForecast.targetHours,
        heatingHoursAfterForecast: heatingHoursBeforeForecast.targetHours,
        nextHeatingStart,
        predictedWeightedTemperature: freshWeightedTemperature,
        recommendation: heatingHoursBeforeForecast,
      };
    }

    const predictedWeightedTemperature = predictWeightedTemperature({
      currentTemperature: freshWeightedTemperature,
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
    freshWeightedTemperature,
    hourlyPrices,
    hourlyTemperatureDropProfile,
    settings,
    tankTemperatureForCalculation,
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
    now: currentTime,
    readingCreatedAt: tankUpdatedAt,
    recoveryReadings: tankTemperatureHistory,
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
    now: currentTime,
    readingCreatedAt: tankUpdatedAt,
    recoveryReadings: tankTemperatureHistory,
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

  const activePlanPresentation = selectActiveHeatingPlanPresentation(
    activeOptimizerPresentation,
    storedHeatingPlanPresentation,
  );
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
      (heatingPlanPresentation === activeOptimizerPresentation &&
        activeOptimizerPresentation !== null) ||
      (heatingPlanPresentation === scenarioPlanPresentation &&
        scenarioPlanPresentation !== null),
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
  const heatingGainBacktest = useMemo(
    () =>
      DEBUG_HEATING_OPTIMIZATION
        ? backtestHeatingGainEstimate(heatingGainHistory)
        : null,
    [heatingGainHistory],
  );
  useEffect(() => {
    if (!DEBUG_HEATING_OPTIMIZATION || !heatingOptimization) {
      return;
    }

    const gainEstimate = heatingOptimization.heatingGainEstimate;
    const firstForecastSegment = heatingOptimization.forecast[0] ?? null;
    const projectedShowers =
      heatingOptimization.forecast.at(-1)?.showersLeftAfter ?? null;
    const optimizationStatus =
      heatingOptimization.selectedHeatingHourIds.length > 0
        ? heatingOptimization.valid
          ? "planned"
          : "planned-invalid-fallback"
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
        segmentsAcceptedWithWarnings:
          gainEstimate.segmentDiscovery.acceptedWithWarningsSegmentCount,
        segmentsFound: gainEstimate.discoveredSegmentCount,
        segmentsRejected: gainEstimate.rejectedSegmentCount,
        rejectionReasonCounts:
          gainEstimate.segmentDiscovery.rejectionReasonCounts,
        source: gainEstimate.fallbackUsed ? "fallback" : "learned",
        topMedian: gainEstimate.topGainPerHour,
        weightedMedian: gainEstimate.fallbackUsed
          ? null
          : gainEstimate.gainPerHour,
      }),
    );
    if (heatingGainBacktest) {
      console.log(
        "[EnergyZen heating gain backtest]",
        JSON.stringify({
          meanAbsoluteErrorCelsius: heatingGainBacktest.meanAbsoluteErrorCelsius,
          meanBiasCelsius: heatingGainBacktest.meanBiasCelsius,
          rejectionReasonCounts:
            heatingGainBacktest.segmentDiscovery.rejectionReasonCounts,
          rejectedSegmentCount:
            heatingGainBacktest.segmentDiscovery.rejectedSegmentCount,
          segmentCount: heatingGainBacktest.segmentCount,
          warningReasonCounts:
            heatingGainBacktest.segmentDiscovery.warningReasonCounts,
        }),
      );
    }
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
        finalShowersLeft: heatingOptimization.finalShowersLeft,
        plannedHours: heatingOptimization.selectedHeatingHourIds,
        projectedShowers,
        reasonOrStatus: optimizationStatus,
        startHeatingThresholdShowers:
          heatingOptimization.diagnostics.startHeatingThresholdShowers,
        targetCheckShowersLeft: heatingOptimization.targetCheckShowersLeft,
        targetCheckTime: heatingOptimization.targetCheckTime,
        targetShowers: publishedOptimizationSettings.targetShowerReserve,
        valid: heatingOptimization.valid,
      }),
    );
  }, [
    heatingGainBacktest,
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
  // A stale heating=true must not read as "still heating" - only isHeatingNow
  // (schedule-derived, not sensor-derived) can keep the indicator on then.
  const isTankHeating = (isTankReadingFresh && heating) || isHeatingNow;
  const temperatureCardTheme = getTemperatureCardTheme(
    tankTemperature,
    settings,
  );
  const temperatureCardAccessibilityLabel = `Varaajan lämpötila ${displayedTopTemp} astetta${
    isTankHeating ? ", lämmitys käynnissä" : ""
  }${loading ? ", tietoja haetaan" : ""}, ${formatWeeklyMinimumInletTemperatureAccessibilityText(weeklyMinimumInletTemperature)}`;
  const temperatureBarSegmentColors = Array.from(
    { length: temperatureBarSegmentCount },
    (_, segmentIndex) =>
      getTemperatureBarSegmentColor(
        segmentIndex,
        temperatureBarSegmentCount,
        tankTemperature,
        bottomTemp ?? defaultTankTemperature,
        settings,
      ),
  );
  const warmWaterFillPercent = Math.round(
    (warmWaterEstimate?.fillRatio ?? 0) * 100,
  );
  const warmWaterShowersValue = warmWaterEstimate
    ? formatFinnishDecimal(warmWaterEstimate.showersLeft)
    : "--";
  const warmWaterShowersAccessibilityLabel = `${warmWaterShowersValue} suihkua`;
  const tankUpdatedStatus = getTankUpdatedStatus(tankUpdatedAt, currentTime);
  // Sama kynnys jota supabase/functions/check-tank-monitor-health kayttaa
  // sahkopostihalytykseen - banneri ja sahkoposti kertovat aina saman
  // tilan. Toisin kuin sahkoposti, tama lasketaan aina tuoreesta
  // tankUpdatedAt-arvosta, joten se katoaa automaattisesti heti kun uusi
  // lukema saapuu, eika vaadi erillista "palautunut"-tilaa.
  // "loading" on true vain ihan ensimmäisen haun ajan (ks. useFocusEffect
  // alla) - sita ennen tankUpdatedAt on vaistamatta viela null, koska
  // mitaan ei ole ehditty hakea. Ilman tata ehtoa banneri vilahti
  // virheellisesti nakyviin sovelluksen jokaisella kaynnistyksella.
  const tankMonitorFault =
    !loading &&
    isTankReadingStale(computeTankReadingAgeMinutes(tankUpdatedAt, currentTime));
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
                  .select("created_at,top_temp,bottom_temp,inlet_temp,heating")
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
              // Must stay paginated: this is unfiltered (both heating
              // states), and at one reading/minute a 7-day window holds
              // ~10,000 rows - PostgREST's default response cap is 1,000
              // rows per request, so an unbounded .select() here would
              // silently return only the oldest slice of the window, not a
              // rolling 7 days. Verified directly against the database
              // before this was fixed - see PR #125.
              fetchHeatingGainHistory(async (from, to) => {
                const { data, error } = await supabase
                  .from("tank_readings")
                  .select("created_at,top_temp,bottom_temp,inlet_temp,heating")
                  .gte("created_at", sevenDaysAgoIso)
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

          if ("error" in temperatureHistoryResult) {
            console.warn(
              "Failed to load paginated tank temperature history",
              temperatureHistoryResult.error,
            );
            setTankTemperatureHistory([]);
            setWeeklyMinimumInletTemperature(null);
          } else {
            setTankTemperatureHistory(temperatureHistoryResult.readings);
            setWeeklyMinimumInletTemperature(
              calculateMinimumValidInletTemperature(
                temperatureHistoryResult.readings,
              ),
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
          setWeeklyMinimumInletTemperature(null);
          setStoredTemperatureDropProfile(null);
          setHeating(false);
          // EI setTankUpdatedAt(null) tässä - tämä haku toistuu 30s
          // välein (ei vain alkulatauksessa), ja yksittäinen ohimenevä
          // verkkovirhe ei tarkoita että edellinen lukema olisi
          // vanhentunut. Nollaus sai anturivikabannerin vilahtamaan
          // näkyviin ohimenevistä katkoista, ei vain aidoista vioista -
          // säilytetään viimeisin tunnettu arvo kunnes seuraava haku
          // joko onnistuu tai lukema oikeasti vanhenee (30 min raja,
          // lib/tankMonitorAlert.ts).
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
  const averageSpotPriceLabel =
    averageSpotPrice === null ? "--" : formatFinnishDecimal(averageSpotPrice);
  const chartAxisLabels = useMemo(
    () =>
      chartAxisValues.map((value) => ({
        bottom:
          ((value - chartScale.min) / chartScale.range) *
          chartGridMaxPosition,
        label: formatFinnishDecimal(value),
        value,
      })),
    [chartAxisValues, chartScale.min, chartScale.range],
  );
  const chartGridLines = useMemo(
    () =>
      chartGridLineValues.map((value) => ({
        bottom:
          ((value - chartScale.min) / chartScale.range) *
          chartGridMaxPosition,
        value,
      })),
    [chartGridLineValues, chartScale.min, chartScale.range],
  );
  const chartBars = useMemo(
    () =>
      chartHourlyPrices.map((item, index) => {
        const isCurrentHour =
          item.date.getTime() <= currentHourStart.getTime() &&
          item.endDate.getTime() > currentHourStart.getTime();
        const isPastHour =
          selectedDay === "yesterday" ||
          (selectedDay === "today" &&
            item.endDate.getTime() <= currentHourStart.getTime());
        const isCheapest = cheapestHour?.id === item.id;
        const isSelected = selectedHourlyPrice?.id === item.id;
        const dateHourKey = getHourlyPriceDateHourKey(item);
        const isHeatedHour = heatedHourIds.has(dateHourKey);
        const heatingMarker = getHeatingHourMarker({
          endsAt: item.endDate,
          isActual: isHeatedHour,
          isPlanned: plannedHeatingHourIds.has(dateHourKey),
          now: currentHourStart,
        });
        const heatingMarkerLabel = getHeatingMarkerLabel(heatingMarker);
        const zeroBottom =
          ((0 - chartScale.min) / chartScale.range) * chartPlotHeight;
        const barBottom =
          item.price >= 0
            ? zeroBottom
            : ((item.price - chartScale.min) / chartScale.range) *
              chartPlotHeight;
        const availableBarHeight =
          item.price >= 0 ? chartPlotHeight - zeroBottom : zeroBottom;
        const barHeight = Math.max(
          (Math.abs(item.price) / chartScale.range) * chartPlotHeight,
          chartMinimumBarHeight,
        );
        const cappedBarHeight = Math.min(barHeight, availableBarHeight);
        const barColor = isCheapest
          ? "#72ff9d"
          : getPriceTheme(item.price).ringColor;

        return {
          accessibilityLabel: `${item.hourLabel}, ${formatFinnishDecimal(item.price)} senttiä kilowattitunnilta${heatingMarkerLabel ? `, ${heatingMarkerLabel}` : ""}`,
          barBottom,
          barColor,
          cappedBarHeight,
          heatingMarker,
          heatingMarkerLabel,
          hourLabel: item.hourLabel,
          id: item.id,
          isCurrentHour,
          isFirstTimeLabel: index === 0,
          isLastTimeLabel: index === chartHourlyPrices.length - 1,
          isMiddleTimeLabel:
            index === Math.floor(chartHourlyPrices.length / 2),
          isPastHour,
          isSelected,
          item,
          markerBottom:
            item.price >= 0 ? barBottom + cappedBarHeight + 2 : zeroBottom + 2,
          priceLabel: formatFinnishDecimal(item.price),
          tooltipBottom:
            item.price >= 0
              ? barBottom + cappedBarHeight + 12
              : zeroBottom + 12,
        };
      }),
    [
      chartHourlyPrices,
      currentHourStart,
      selectedDay,
      cheapestHour,
      selectedHourlyPrice,
      heatedHourIds,
      plannedHeatingHourIds,
      chartScale.min,
      chartScale.range,
    ],
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

        {tankMonitorFault ? (
          <View style={styles.tankMonitorFaultBanner}>
            <Text
              accessibilityRole="alert"
              style={styles.tankMonitorFaultText}
            >
              Varaajan mittaus ei toimi, käytetään valittuja varatunteja
            </Text>
          </View>
        ) : null}

        <PriceCard
          accessibilityLabel={priceCardAccessibilityLabel}
          hasPrice={currentPrice !== null}
          isPriceLoading={isPriceLoading}
          onPress={() => {
            logHistoryNavigationTap("electricity-history");
            router.push("/electricity-history");
          }}
          priceLabel={priceCardPriceLabel}
          pulseStyle={pulseStyle}
          ringColor={ringColor}
          totalPriceLabel={priceCardTotalPriceLabel}
        />

        <View style={styles.cardsRow}>
          <TemperatureCard
            accessibilityLabel={temperatureCardAccessibilityLabel}
            bottomTempLabel={displayedBottomTemp}
            inletTempLabel={displayedWeeklyMinimumInletTemp}
            isTankHeating={isTankHeating}
            onPress={() => {
              logHistoryNavigationTap("history");
              router.push("/history");
            }}
            pulseStyle={heatingCardPulseStyle}
            segmentColors={temperatureBarSegmentColors}
            tankUpdatedStatus={tankUpdatedStatus}
            theme={temperatureCardTheme}
            topTempLabel={displayedTopTemp}
          />

          <WarmWaterCard
            fillPercent={warmWaterFillPercent}
            fullTankShowers={settings.fullTankShowers}
            onPress={() => router.push("/settings")}
            safetyShowerReserve={settings.safetyShowerReserve}
            showersAccessibilityLabel={warmWaterShowersAccessibilityLabel}
            showersValueLabel={warmWaterShowersValue}
            targetShowerReserve={settings.targetShowerReserve}
          />
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
                <PriceChart
                  averageSpotPriceLabel={averageSpotPriceLabel}
                  axisLabels={chartAxisLabels}
                  bars={chartBars}
                  gridLines={chartGridLines}
                  onClearSelection={handleClearSelectedHourlyPrice}
                  onSelectBar={handleSelectHourlyPrice}
                />

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
                                    <Text style={styles.heatingPlanHourPrice}>
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
                    <Text style={styles.heatingPlanForecastSubtitle}>
                      Ennuste
                    </Text>
                    {heatingPlanPresentation.forecastDetails ? (
                      <>
                        <Text style={styles.heatingPlanForecastText}>
                          Nyt{" "}
                          <Text style={styles.heatingPlanForecastValue}>
                            {
                              heatingPlanPresentation.forecastDetails
                                .currentShowersLabel
                            }
                          </Text>
                        </Text>
                        <Text style={styles.heatingPlanForecastText}>
                          Alimmillaan{" "}
                          <Text style={styles.heatingPlanForecastValue}>
                            {
                              heatingPlanPresentation.forecastDetails
                                .minimumShowersLabel
                            }
                          </Text>
                          {heatingPlanPresentation.forecastDetails
                            .minimumShowersTimeLabel
                            ? ` (${heatingPlanPresentation.forecastDetails.minimumShowersTimeLabel})`
                            : ""}
                        </Text>
                        <Text style={styles.heatingPlanForecastText}>
                          {capitalizeFirstLetter(
                            heatingPlanPresentation.forecastDetails
                              .finalShowersTimeLabel,
                          )}{" "}
                          <Text style={styles.heatingPlanForecastValue}>
                            {
                              heatingPlanPresentation.forecastDetails
                                .finalShowersLabel
                            }
                          </Text>{" "}
                          suihkua
                        </Text>
                      </>
                    ) : (
                      <Text style={styles.heatingPlanForecastText}>
                        {heatingPlanPresentation.forecastSummary}
                      </Text>
                    )}

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
  tankMonitorFaultBanner: {
    alignSelf: "stretch",
    backgroundColor: "rgba(255, 95, 109, 0.16)",
    borderColor: "rgba(255, 95, 109, 0.52)",
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  tankMonitorFaultText: {
    color: "#ffb3ba",
    fontSize: 13,
    fontWeight: "800",
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
  heatingPlanInfoText: {
    color: "#cfe9ff",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
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
  cardsRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 14,
    width: "100%",
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
  chartMessage: {
    color: "#cfe9ff",
    fontSize: 15,
    fontWeight: "800",
    textAlign: "center",
  },
});

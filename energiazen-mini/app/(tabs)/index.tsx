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
  DaySelection,
  getCheapestHours,
  getDateKeyOffset,
  getFinnishDateKey,
  getEffectiveHeatingHours,
  getHelsinkiHourNumber,
  HourlyPrice,
  selectHeatingRecommendation,
  sortHoursChronologically,
} from "@/lib/heatingLogic";
import {
  defaultSettings,
  defaultTankTemperature,
  loadSettings,
} from "@/lib/settings";
import { supabase } from "@/lib/supabase";

const priceApiUrl =
  "https://api.spot-hinta.fi/TodayAndDayForward?region=FI&priceResolution=60";
const chartPriceStep = 5;
const chartMinimumScaleMax = 10;
const chartPlotHeight = 96;
const chartGridMaxPosition = chartPlotHeight - 1;
const chartMinimumBarHeight = 8;
const temperatureBarSegmentCount = 8;
const storedElectricityPriceColumns = "start_date,end_date,price";

const actualHeatingHours: Partial<Record<DaySelection, number[]>> = {
  today: [],
  yesterday: [],
};
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

type TankReading = {
  created_at?: string | null;
  top_temp?: number | null;
  bottom_temp?: number | null;
  showers?: number | null;
  heating?: boolean | null;
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

type ElectricityPriceInsert = {
  start_date: string;
  end_date: string;
  price: number;
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

  const weightedTemperature = topTemperature * 0.7 + bottomTemperature * 0.3;
  const fullTankTemp =
    settings.fullTankAverageTemperature ?? settings.maxTankTemperature;
  const energyTemperatureRange = Math.max(
    fullTankTemp - settings.minTankTemperature,
    1,
  );
  const energyRatio = clamp(
    (weightedTemperature - settings.minTankTemperature) /
      energyTemperatureRange,
    0,
    1,
  );
  const minimumUsableTopTemperature = 42;
  const topUsabilityTemperatureRange = Math.max(
    fullTankTemp - minimumUsableTopTemperature,
    1,
  );
  const topUsability = clamp(
    (topTemperature - minimumUsableTopTemperature) /
      topUsabilityTemperatureRange,
    0,
    1,
  );
  const fillRatio = energyRatio * topUsability;
  const showersLeft = fillRatio * settings.fullTankShowers;

  return {
    weightedTemperature,
    energyRatio,
    topUsability,
    fillRatio,
    showersLeft,
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
  if (marker === "⭐") {
    return "Valittu lämmitykseen";
  }

  if (marker === "🔥") {
    return "Lämmitys toteutui";
  }

  if (marker === "⚠️") {
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

function getAveragePrice(prices: HourlyPrice[]) {
  if (prices.length === 0) {
    return null;
  }

  return prices.reduce((sum, item) => sum + item.price, 0) / prices.length;
}

function haveSameHourIds(first: HourlyPrice[], second: HourlyPrice[]) {
  if (first.length !== second.length) {
    return false;
  }

  const secondIds = new Set(second.map((item) => item.id));

  return first.every((item) => secondIds.has(item.id));
}

function formatFinnishDecimal(value: number) {
  return value.toFixed(1).replace(".", ",");
}

function formatHourLabel(date: Date) {
  return `${helsinkiHourFormatter.format(date).replace(".", "")}:00`;
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

function getChartScaleValues(maxPrice: number) {
  const roundedMax = Math.max(
    Math.ceil(maxPrice / chartPriceStep) * chartPriceStep,
    chartMinimumScaleMax,
  );

  return Array.from(
    { length: roundedMax / chartPriceStep + 1 },
    (_, index) => index * chartPriceStep,
  );
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
    const electricityPrices = prices.map((item) => ({
      start_date: item.startDate,
      end_date: item.endDate.toISOString(),
      price: item.price,
    })) satisfies ElectricityPriceInsert[];

    if (electricityPrices.length === 0) {
      debugLog("Saved electricity prices: 0 rows");
      debugLog("Existing electricity prices: 0 rows");
      return;
    }

    const startDates = electricityPrices.map((item) => item.start_date);
    const { data: existingPrices, error: existingPricesError } = await supabase
      .from("electricity_prices")
      .select("start_date")
      .in("start_date", startDates);

    if (existingPricesError) {
      console.warn(
        "Electricity price duplicate check failed",
        existingPricesError,
      );
      return;
    }

    const existingStartDates = new Set(
      ((existingPrices ?? []) as Pick<StoredElectricityPrice, "start_date">[])
        .map((item) =>
          item.start_date ? new Date(item.start_date).toISOString() : null,
        )
        .filter((startDate): startDate is string => Boolean(startDate)),
    );
    const newElectricityPrices = electricityPrices.filter(
      (item) =>
        !existingStartDates.has(new Date(item.start_date).toISOString()),
    );

    if (newElectricityPrices.length > 0) {
      const { error: insertError } = await supabase
        .from("electricity_prices")
        .insert(newElectricityPrices);

      if (insertError) {
        console.warn("Electricity price save failed", insertError);
        return;
      }
    }

    debugLog(`Saved electricity prices: ${newElectricityPrices.length} rows`);
    debugLog(`Existing electricity prices: ${existingStartDates.size} rows`);
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

export default function HomeScreen() {
  const router = useRouter();
  const pulseAnimation = useRef(new Animated.Value(0)).current;
  const [hourlyPrices, setHourlyPrices] = useState<HourlyPrice[]>([]);
  const [isPriceLoading, setIsPriceLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<DaySelection>("today");
  const [settings, setSettings] = useState(defaultSettings);
  const [selectedHourlyPrice, setSelectedHourlyPrice] =
    useState<HourlyPrice | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [topTemp, setTopTemp] = useState<number | null>(null);
  const [bottomTemp, setBottomTemp] = useState<number | null>(null);
  const [heating, setHeating] = useState(false);
  const [tankUpdatedAt, setTankUpdatedAt] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const currentHourStart = startOfCurrentHour();
  const chartDayKey = getChartDayKey(selectedDay);
  const chartHourlyPrices = useMemo(
    () =>
      hourlyPrices.filter(
        (item) => getFinnishDateKey(item.startDate) === chartDayKey,
      ),
    [chartDayKey, hourlyPrices],
  );
  const currentPriceItem = hourlyPrices.find(
    (item) =>
      item.date.getTime() <= Date.now() && item.endDate.getTime() > Date.now(),
  );
  const currentPrice = currentPriceItem?.price ?? null;
  const { ringColor } =
    currentPrice === null
      ? { ringColor: "#36f4d4" }
      : getPriceTheme(currentPrice);
  const maxChartPrice = Math.max(
    ...chartHourlyPrices.map((item) => Math.max(item.price, 0)),
    0,
  );
  const chartScaleValues = useMemo(
    () => getChartScaleValues(maxChartPrice),
    [maxChartPrice],
  );
  const chartScaleMax = chartScaleValues[chartScaleValues.length - 1];
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
    [],
  );
  const tankTemperature = topTemp ?? defaultTankTemperature;
  const displayedTopTemp = topTemp === null ? "--" : `${Math.round(topTemp)}`;
  const displayedBottomTemp =
    bottomTemp === null ? "--" : `${Math.round(bottomTemp)}`;
  const warmWaterEstimate = getStratifiedWarmWaterEstimate(
    topTemp,
    bottomTemp,
    settings,
  );
  const heatingRecommendation = useMemo(
    () =>
      selectHeatingRecommendation(
        hourlyPrices,
        currentHourStart,
        todayActualHeatingHourNumbers,
        settings,
        tankTemperature,
        warmWaterEstimate?.showersLeft ?? null,
      ),
    [
      currentHourStart,
      hourlyPrices,
      settings,
      tankTemperature,
      todayActualHeatingHourNumbers,
      warmWaterEstimate?.showersLeft,
    ],
  );
  const recommendedHeatingHours = heatingRecommendation.hours;
  const effectiveHeatingHours = getEffectiveHeatingHours(
    settings,
    tankTemperature,
  );
  const tomorrowPlannedHeatingHours = useMemo(() => {
    const tomorrowKey = getChartDayKey("tomorrow");

    return sortHoursChronologically(
      getCheapestHours(
        hourlyPrices.filter(
          (item) => getFinnishDateKey(item.startDate) === tomorrowKey,
        ),
        effectiveHeatingHours,
      ),
    );
  }, [effectiveHeatingHours, hourlyPrices]);
  const selectedHeatingHoursCount = useMemo(() => {
    if (selectedDay === "yesterday") {
      return settings.heatingHoursPerDay;
    }

    return selectedDay === "today"
      ? recommendedHeatingHours.length
      : tomorrowPlannedHeatingHours.length;
  }, [
    recommendedHeatingHours.length,
    selectedDay,
    settings.heatingHoursPerDay,
    tomorrowPlannedHeatingHours.length,
  ]);
  const explanationVisible =
    selectedHeatingHoursCount !== settings.heatingHoursPerDay;
  const plannedHeatingHourIds = useMemo(() => {
    if (selectedDay === "yesterday") {
      return new Set<string>();
    }

    const plannedHours =
      selectedDay === "today"
        ? recommendedHeatingHours.filter((item) => item.status === "planned")
        : tomorrowPlannedHeatingHours;

    return new Set(plannedHours.map((item) => item.id));
  }, [recommendedHeatingHours, selectedDay, tomorrowPlannedHeatingHours]);
  const missedHeatingHourIds = useMemo(() => {
    if (selectedDay !== "today") {
      return new Set<string>();
    }

    return new Set(
      recommendedHeatingHours
        .filter((item) => item.status === "missed")
        .map((item) => item.id),
    );
  }, [recommendedHeatingHours, selectedDay]);
  const heatedHourNumbers = useMemo(
    () => new Set(actualHeatingHours[selectedDay] ?? []),
    [selectedDay],
  );
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
  const heatingPlanExplanation = useMemo(() => {
    const todayKey = getChartDayKey("today");
    const tomorrowKey = getChartDayKey("tomorrow");
    const remainingTodayPrices = hourlyPrices.filter(
      (item) =>
        getFinnishDateKey(item.startDate) === todayKey &&
        item.endDate.getTime() > currentHourStart.getTime(),
    );
    const tomorrowPrices = hourlyPrices.filter(
      (item) => getFinnishDateKey(item.startDate) === tomorrowKey,
    );
    const normalHeatingHours = sortHoursChronologically(
      getCheapestHours(remainingTodayPrices, settings.heatingHoursPerDay),
    );
    const plannedFutureHours = sortHoursChronologically(
      recommendedHeatingHours.filter((item) => item.status === "planned"),
    );

    if (
      plannedFutureHours.length === 0 ||
      haveSameHourIds(plannedFutureHours, normalHeatingHours)
    ) {
      return null;
    }

    const normalHourIds = new Set(normalHeatingHours.map((item) => item.id));
    const additionalHours = plannedFutureHours.filter(
      (item) => !normalHourIds.has(item.id),
    );
    const averageTodayPrice = getAveragePrice(
      getCheapestHours(remainingTodayPrices, settings.heatingHoursPerDay),
    );
    const averageTomorrowPrice = getAveragePrice(
      getCheapestHours(tomorrowPrices, settings.heatingHoursPerDay),
    );
    const firstCheapTomorrowHour = sortHoursChronologically(
      getCheapestHours(tomorrowPrices, settings.heatingHoursPerDay),
    )[0];
    const minimumReserveHours = firstCheapTomorrowHour
      ? Math.max(
          0,
          Math.ceil(
            (firstCheapTomorrowHour.date.getTime() -
              currentHourStart.getTime()) /
              (60 * 60 * 1000),
          ),
        )
      : null;
    const tomorrowIsMoreExpensive =
      averageTodayPrice !== null &&
      averageTomorrowPrice !== null &&
      averageTomorrowPrice - averageTodayPrice >
        settings.priceDifferenceThresholdCents;

    return {
      additionalHoursCount: additionalHours.length,
      minimumReserveHours,
      description: tomorrowIsMoreExpensive
        ? "Huomenna on kalliimpaa ja lämmintä vettä on alle vähimmäisvarauksen. Lisätään lämmitystä tänään halvimmille tunneille."
        : "Suunnitelma poikkeaa tavallisesta halvimpien tuntien valinnasta tämänhetkisen varaaja- ja hintatilanteen takia.",
      title: tomorrowIsMoreExpensive
        ? "Ennakoiva lämmitys"
        : "Lämmityssuunnitelman poikkeama",
    };
  }, [
    currentHourStart,
    hourlyPrices,
    recommendedHeatingHours,
    settings.heatingHoursPerDay,
    settings.priceDifferenceThresholdCents,
  ]);
  const tankUpdatedStatus = getTankUpdatedStatus(tankUpdatedAt, currentTime);
  const cheapestHour = chartHourlyPrices.reduce<HourlyPrice | null>(
    (cheapest, item) =>
      !cheapest || item.price < cheapest.price ? item : cheapest,
    null,
  );
  const mostExpensiveHour = chartHourlyPrices.reduce<HourlyPrice | null>(
    (mostExpensive, item) =>
      !mostExpensive || item.price > mostExpensive.price ? item : mostExpensive,
    null,
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

      loadSettings().then((storedSettings) => {
        if (isActive) {
          setSettings(storedSettings);
        }
      });

      const refreshTankReadings = async () => {
        debugLog("tank_readings refreshed");

        try {
          const { data, error } = await supabase
            .from("tank_readings")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

          if (!isActive) {
            return;
          }

          if (error) {
            console.error(error);
            return;
          }

          const reading = data as TankReading | null;

          setTopTemp(reading?.top_temp ?? null);
          setBottomTemp(reading?.bottom_temp ?? null);
          setHeating(reading?.heating ?? false);
          setTankUpdatedAt(reading?.created_at ?? null);
        } catch {
          if (!isActive) {
            return;
          }

          setTopTemp(null);
          setBottomTemp(null);
          setHeating(false);
          setTankUpdatedAt(null);
        } finally {
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
          <View
            style={[
              styles.ring,
              { borderColor: ringColor, shadowColor: ringColor },
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
              </>
            )}
          </View>
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
              onPress={() => router.push("/history")}
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

        {heatingPlanExplanation ? (
          <View style={styles.heatingPlanInfoCard}>
            <View style={styles.heatingPlanHeaderRow}>
              <Text style={styles.heatingPlanIcon}>💡</Text>
              <Text style={styles.heatingPlanTitle}>
                {heatingPlanExplanation.title}
              </Text>
            </View>
            <Text style={styles.heatingPlanDescription}>
              {heatingPlanExplanation.description}
            </Text>
            <View style={styles.heatingPlanDetailsGrid}>
              <View style={styles.heatingPlanDetailItem}>
                <Text style={styles.heatingPlanDetailLabel}>Suihkuarvio</Text>
                <Text style={styles.heatingPlanDetailValue}>
                  {warmWaterShowersLabel}
                </Text>
              </View>
              <View style={styles.heatingPlanDetailItem}>
                <Text style={styles.heatingPlanDetailLabel}>
                  Vähimmäisvaraus
                </Text>
                <Text style={styles.heatingPlanDetailValue}>
                  {heatingPlanExplanation.minimumReserveHours === null
                    ? "-- h"
                    : `${heatingPlanExplanation.minimumReserveHours} h`}
                </Text>
              </View>
              <View style={styles.heatingPlanDetailItem}>
                <Text style={styles.heatingPlanDetailLabel}>Hintaeron raja</Text>
                <Text style={styles.heatingPlanDetailValue}>
                  {formatFinnishDecimal(settings.priceDifferenceThresholdCents)}
                  c
                </Text>
              </View>
              <View style={styles.heatingPlanDetailItem}>
                <Text style={styles.heatingPlanDetailLabel}>Lisätunnit</Text>
                <Text style={styles.heatingPlanDetailValue}>
                  {heatingPlanExplanation.additionalHoursCount} h
                </Text>
              </View>
            </View>
          </View>
        ) : null}

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
                  onPress={() => setSelectedDay(day)}
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
                  onPress={() => setSelectedHourlyPrice(null)}
                  style={styles.chartTouchArea}
                >
                  <View style={styles.chartPlotRow}>
                    <View pointerEvents="none" style={styles.chartScale}>
                      {chartScaleValues.map((value) => (
                        <Text
                          key={value}
                          style={[
                            styles.chartScaleLabel,
                            {
                              bottom:
                                (value / chartScaleMax) * chartGridMaxPosition,
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
                        {chartScaleValues.map((value) => (
                          <View
                            key={value}
                            style={[
                              styles.chartGridLine,
                              {
                                bottom:
                                  (value / chartScaleMax) *
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
                            selectedDay === "today" &&
                            item.endDate.getTime() <=
                              currentHourStart.getTime();
                          const isCheapest = cheapestHour?.id === item.id;
                          const isSelected =
                            selectedHourlyPrice?.id === item.id;
                          const isHeatedHour =
                            heatedHourNumbers.has(
                              getHelsinkiHourNumber(item.date),
                            ) &&
                            (selectedDay !== "today" ||
                              item.endDate.getTime() <=
                                currentHourStart.getTime());
                          const heatingMarker = isHeatedHour
                            ? "🔥"
                            : missedHeatingHourIds.has(item.id)
                              ? "⚠️"
                              : plannedHeatingHourIds.has(item.id)
                                ? "⭐"
                                : null;
                          const heatingMarkerLabel =
                            getHeatingMarkerLabel(heatingMarker);
                          const barHeight = Math.max(
                            (Math.max(item.price, 0) / chartScaleMax) *
                              chartPlotHeight,
                            chartMinimumBarHeight,
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
                                setSelectedHourlyPrice(item);
                              }}
                              style={styles.chartBarButton}
                            >
                              {isSelected ? (
                                <View
                                  pointerEvents="none"
                                  style={[
                                    styles.chartTooltip,
                                    { bottom: barHeight + 12 },
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
                                  style={styles.chartHourMarker}
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
                                    height: barHeight,
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

                <View style={styles.extremePrices}>
                  <Text style={styles.extremePriceText}>
                    Halvin tunti:{" "}
                    {cheapestHour
                      ? `${cheapestHour.hourLabel} (${formatFinnishDecimal(cheapestHour.price)} c/kWh)`
                      : "--"}
                  </Text>
                  <Text style={styles.extremePriceText}>
                    Kallein tunti:{" "}
                    {mostExpensiveHour
                      ? `${mostExpensiveHour.hourLabel} (${formatFinnishDecimal(mostExpensiveHour.price)} c/kWh)`
                      : "--"}
                  </Text>
                </View>

                {explanationVisible ? (
                  <View style={styles.heatingPlanInfo}>
                    <Text style={styles.heatingPlanInfoTitle}>
                      Lämmityssuunnitelma muuttui
                    </Text>
                    <Text style={styles.heatingPlanInfoText}>
                      Asetettu lämmitystarve on {settings.heatingHoursPerDay} h
                      / vrk, mutta suunnitelmaan valittiin {selectedHeatingHoursCount}
                      h.
                    </Text>
                    <Text style={styles.heatingPlanInfoReason}>
                      Syynä on hintavertailu / huomisen hinta / saatavilla
                      olevat tunnit.
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
  heatingPlanInfo: {
    alignSelf: "stretch",
    backgroundColor: "rgba(54,244,212,0.12)",
    borderColor: "rgba(54,244,212,0.36)",
    borderRadius: 18,
    borderWidth: 1,
    gap: 6,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  heatingPlanInfoTitle: {
    color: "#f7fbff",
    fontSize: 14,
    fontWeight: "900",
  },
  heatingPlanInfoText: {
    color: "#cfe9ff",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  heatingPlanInfoReason: {
    color: "#9fc7ff",
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
  heatingPlanInfoCard: {
    backgroundColor: "rgba(54,244,212,0.11)",
    borderColor: "rgba(191,255,238,0.24)",
    borderRadius: 22,
    borderWidth: 1,
    gap: 12,
    marginBottom: 14,
    padding: 16,
    shadowColor: "#36f4d4",
    shadowOpacity: 0.18,
    shadowRadius: 18,
    width: "100%",
  },
  heatingPlanHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  heatingPlanIcon: {
    fontSize: 18,
    lineHeight: 22,
  },
  heatingPlanTitle: {
    color: "#f8fbff",
    flex: 1,
    fontSize: 17,
    fontWeight: "900",
  },
  heatingPlanDescription: {
    color: "#d9e9ff",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 19,
  },
  heatingPlanDetailsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  heatingPlanDetailItem: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.11)",
    borderRadius: 14,
    borderWidth: 1,
    flexBasis: "48%",
    flexGrow: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  heatingPlanDetailLabel: {
    color: "rgba(207,233,255,0.68)",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  heatingPlanDetailValue: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "900",
    marginTop: 3,
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
  },
  chartHourMarker: {
    fontSize: 11,
    lineHeight: 13,
    marginBottom: 2,
    textAlign: "center",
  },
  chartBar: {
    borderRadius: 8,
    borderWidth: 1.5,
    opacity: 0.9,
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
  extremePrices: {
    borderTopColor: "rgba(255,255,255,0.1)",
    borderTopWidth: 1,
    gap: 6,
    marginTop: 14,
    paddingTop: 14,
  },
  extremePriceText: {
    color: "#d9e9ff",
    fontSize: 14,
    fontWeight: "800",
    textAlign: "center",
  },
});

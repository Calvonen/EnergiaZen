import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

const tankTemperature = 58;
const warmWaterHours = 17;
const priceApiUrl =
  "https://api.spot-hinta.fi/TodayAndDayForward?region=FI&priceResolution=60";
const dailyHeatingHours = 3;
const maintenanceHeatingHours = 1;
const priceDifferenceThreshold = 2;
const chartPriceStep = 5;
const chartMinimumScaleMax = 10;
const chartPlotHeight = 96;
const chartGridMaxPosition = chartPlotHeight - 1;
const chartMinimumBarHeight = 8;
const yesterdayHeatedHours = [1, 4, 6];
const todayHeatedHours = [0, 5];

type DaySelection = "yesterday" | "today" | "tomorrow";

const helsinkiDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

const helsinkiTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

const helsinkiHourFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

type SpotPriceResponse = {
  DateTime?: string | null;
  PriceNoTax?: number | null;
  PriceWithTax?: number | null;
};

type HourlyPrice = {
  date: Date;
  endDate: Date;
  hourLabel: string;
  id: string;
  price: number;
};

type HeatingPlanStatus = "completed" | "planned" | "missed";

type HeatingPlanHour = HourlyPrice & {
  status: HeatingPlanStatus;
};

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

function formatFinnishDecimal(value: number) {
  return value.toFixed(1).replace(".", ",");
}

function formatHourLabel(date: Date) {
  return `${helsinkiTimeFormatter.format(date).replace(".", "")}:00`;
}

function formatHelsinkiDateKey(date: Date) {
  return helsinkiDateKeyFormatter.format(date);
}

function getChartDayKey(day: DaySelection, date = new Date()) {
  if (day === "yesterday") {
    return formatHelsinkiDateKey(
      new Date(date.getTime() - 24 * 60 * 60 * 1000),
    );
  }

  if (day === "today") {
    return formatHelsinkiDateKey(date);
  }

  return formatHelsinkiDateKey(new Date(date.getTime() + 24 * 60 * 60 * 1000));
}

function getHelsinkiHourNumber(date: Date) {
  const hour = Number(helsinkiHourFormatter.format(date));

  return hour === 24 ? 0 : hour;
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

function getCheapestHours(prices: HourlyPrice[], count: number) {
  return [...prices]
    .sort((a, b) => {
      if (a.price === b.price) {
        return a.date.getTime() - b.date.getTime();
      }

      return a.price - b.price;
    })
    .slice(0, count);
}

function sortHoursChronologically(prices: HourlyPrice[]) {
  return [...prices].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function getAveragePrice(prices: HourlyPrice[]) {
  if (prices.length === 0) {
    return null;
  }

  return prices.reduce((sum, item) => sum + item.price, 0) / prices.length;
}

function selectHeatingRecommendation(
  prices: HourlyPrice[],
  currentHourStart: Date,
  heatedHourNumbers: Set<number>,
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
  const plannedTodayHours = getCheapestHours(todayPrices, dailyHeatingHours);
  const completedTodayHours = sortHoursChronologically(
    todayPrices.filter(
      (item) =>
        heatedHourNumbers.has(getHelsinkiHourNumber(item.date)) &&
        item.date.getTime() <= currentHourStart.getTime(),
    ),
  ).slice(0, dailyHeatingHours);
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
    dailyHeatingHours -
      completedTodayHours.length -
      missedPlannedTodayHours.length,
    0,
  );
  const tomorrowPrices = prices.filter(
    (item) => formatHelsinkiDateKey(item.date) === tomorrowKey,
  );
  const cheapestTodayHours = getCheapestHours(
    remainingTodayPrices,
    dailyHeatingHours,
  );
  const cheapestTomorrowHours = getCheapestHours(
    tomorrowPrices,
    dailyHeatingHours,
  );
  const averageTodayPrice = getAveragePrice(cheapestTodayHours);
  const averageTomorrowPrice =
    cheapestTomorrowHours.length === dailyHeatingHours
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
      reason: "Päivän 3 h lämmitystavoite on täynnä",
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
      reason: "Normaali 3 h lämmitys",
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
  const warmWaterCanWait = warmWaterHours >= hoursUntilFirstCheapTomorrow;
  const tomorrowIsClearlyCheaper =
    averageTodayPrice - averageTomorrowPrice > priceDifferenceThreshold;

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
    (item) => item.price < averageTomorrowPrice + priceDifferenceThreshold,
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
    averageTomorrowPrice - averageTodayPrice > priceDifferenceThreshold;

  return {
    hours: toPlanHours(selectedHours),
    realizedHours: completedTodayHours.length,
    reason: todayIsClearlyCheaper
      ? "Tänään edullisempaa kuin huomenna"
      : "Normaali 3 h lämmitys",
  };
}

function normalizeSpotPrices(data: SpotPriceResponse[]) {
  return data
    .map((item) => {
      const price = item.PriceWithTax ?? item.PriceNoTax;
      const date = item.DateTime ? new Date(item.DateTime) : null;

      if (
        !date ||
        Number.isNaN(date.getTime()) ||
        typeof price !== "number" ||
        Number.isNaN(price)
      ) {
        return null;
      }

      return {
        date,
        endDate: new Date(date.getTime() + 60 * 60 * 1000),
        hourLabel: formatHourLabel(date),
        id: item.DateTime ?? date.toISOString(),
        price: normalizePriceToCents(price),
      } satisfies HourlyPrice;
    })
    .filter((item): item is HourlyPrice => item !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

export default function HomeScreen() {
  const pulseAnimation = useRef(new Animated.Value(0)).current;
  const [hourlyPrices, setHourlyPrices] = useState<HourlyPrice[]>([]);
  const [isPriceLoading, setIsPriceLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<DaySelection>("today");
  const [selectedHourlyPrice, setSelectedHourlyPrice] =
    useState<HourlyPrice | null>(null);
  const currentHourStart = startOfCurrentHour();
  const chartDayKey = getChartDayKey(selectedDay);
  const chartHourlyPrices = useMemo(
    () =>
      hourlyPrices.filter(
        (item) => formatHelsinkiDateKey(item.date) === chartDayKey,
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
  const todayHeatedHourNumbers = useMemo(() => new Set(todayHeatedHours), []);
  const heatingRecommendation = useMemo(
    () =>
      selectHeatingRecommendation(
        hourlyPrices,
        currentHourStart,
        todayHeatedHourNumbers,
      ),
    [currentHourStart, hourlyPrices, todayHeatedHourNumbers],
  );
  const recommendedHeatingHours = heatingRecommendation.hours;
  const tomorrowPlannedHeatingHours = useMemo(() => {
    const tomorrowKey = getChartDayKey("tomorrow");

    return sortHoursChronologically(
      getCheapestHours(
        hourlyPrices.filter(
          (item) => formatHelsinkiDateKey(item.date) === tomorrowKey,
        ),
        dailyHeatingHours,
      ),
    );
  }, [hourlyPrices]);
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
  const heatedHourNumbers = useMemo(() => {
    if (selectedDay === "yesterday") {
      return new Set(yesterdayHeatedHours);
    }

    if (selectedDay === "today") {
      return new Set(todayHeatedHours);
    }

    return new Set<number>();
  }, [selectedDay]);
  const isHeatingNow = recommendedHeatingHours.some(
    (item) =>
      item.date.getTime() <= currentHourStart.getTime() &&
      item.endDate.getTime() > currentHourStart.getTime(),
  );
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

  const fetchHourlyPrices = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(priceApiUrl, {
        signal,
      });

      if (!response.ok) {
        throw new Error("Price fetch failed");
      }

      const data = (await response.json()) as SpotPriceResponse[];
      const prices = normalizeSpotPrices(data);

      if (prices.length === 0) {
        throw new Error("Hourly prices missing from response");
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
          <Text style={styles.title}>⚡ EnergiaZen Mini</Text>
          <Text style={styles.subtitle}>Älykäs varaajan ohjaus</Text>
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
              isHeatingNow && [styles.heatingMetricCard, heatingCardPulseStyle],
            ]}
          >
            <Text style={styles.cardIcon}>🔥</Text>
            <Text style={styles.cardValue}>{tankTemperature} °C</Text>
          </Animated.View>

          <View style={styles.metricCard}>
            <Text style={styles.cardIcon}>💧</Text>
            <Text style={styles.cardValue}>{warmWaterHours} h</Text>
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
                      ? "Eilisen hintoja ei ole saatavilla"
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
                              item.date.getTime() <=
                                currentHourStart.getTime());
                          const heatingMarker = isHeatedHour
                            ? "🔥"
                            : missedHeatingHourIds.has(item.id)
                              ? "⚠️"
                              : plannedHeatingHourIds.has(item.id)
                                ? "⭐"
                                : null;
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
                              accessibilityLabel={`${item.hourLabel}, ${formatFinnishDecimal(item.price)} senttiä kilowattitunnilta`}
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
  errorText: {
    color: "#ffad4d",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 6,
    textAlign: "center",
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
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(125,232,255,0.24)",
    borderRadius: 24,
    borderWidth: 1,
    flex: 1,
    minHeight: 104,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowColor: "#1df4c2",
    shadowOpacity: 0.18,
    shadowRadius: 18,
  },
  heatingMetricCard: {
    backgroundColor: "rgba(255,95,109,0.14)",
    borderColor: "rgba(255,95,109,0.58)",
    borderWidth: 1.5,
    shadowColor: "#ff5f6d",
    shadowOpacity: 0.62,
    shadowRadius: 26,
  },
  cardIcon: {
    fontSize: 22,
    lineHeight: 26,
    marginBottom: 2,
    textAlign: "center",
  },
  cardValue: {
    color: "#ffffff",
    fontSize: 32,
    fontWeight: "900",
    letterSpacing: -0.8,
    lineHeight: 38,
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
  },
  chartHourMarker: {
    fontSize: 15,
    lineHeight: 17,
    marginBottom: 3,
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
    marginLeft: -43,
    paddingHorizontal: 10,
    paddingVertical: 8,
    position: "absolute",
    shadowColor: "#36f4d4",
    shadowOpacity: 0.32,
    shadowRadius: 16,
    width: 86,
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

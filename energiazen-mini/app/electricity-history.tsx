import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  InteractionManager,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  electricityPriceRegion,
  calculateHeatedPriceHistory,
  ElectricityPriceRange,
  ElectricityPriceRecord,
  formatFinnishHistoryDate,
  getElectricityHistoryRangeStartIso,
  getHelsinkiDateStartIso,
  getHelsinkiElectricityDateKey,
  getHeatingDayEmptyLabel,
  getTotalPriceCentsPerKwh,
  groupElectricityPricesByHelsinkiDay,
  offsetDateKey,
} from "@/lib/electricityPrices";
import {
  buildElectricityPriceTrend,
  ElectricityPriceTrend,
} from "@/lib/electricityPriceTrend";
import {
  HeatingEnergyPeriod,
  HeatingPeriodRpcRow,
  mapHeatingPeriodRowsToEnergyConsumption,
} from "@/lib/heatingHistory";
import {
  buildTodayHeatingTimeline,
  normalizeStoredHeatingPlanHours,
} from "@/lib/heatingPlanMarkers";
import { supabase } from "@/lib/supabase";

type HistoryDataFilter = "all" | "heated";

type ElectricityHistoryCacheEntry = {
  error: string | null;
  fetchedAt: number;
  heatingError: string | null;
  heatingPeriods: HeatingEnergyPeriod[];
  plannedHeatingHours: number[];
  prices: ElectricityPriceRecord[];
};

const DEBUG_HISTORY_PERFORMANCE = false;
const ranges: { label: string; value: ElectricityPriceRange }[] = [
  { label: "Tänään", value: 1 },
  { label: "7 päivää", value: 7 },
  { label: "30 päivää", value: 30 },
];

function getPerformanceNow() {
  return Date.now();
}

function getRangeLogLabel(range: ElectricityPriceRange) {
  return range === 1 ? "Tanaan" : `${range} paivaa`;
}

function logElectricityHistoryPerformance(
  range: ElectricityPriceRange,
  event: string,
  data: Record<string, unknown>,
) {
  if (!DEBUG_HISTORY_PERFORMANCE) {
    return;
  }

  console.log("[EnergyZen perf][electricity-history]", {
    event,
    range: getRangeLogLabel(range),
    ...data,
  });
}

const electricityHistoryCache: Partial<
  Record<ElectricityPriceRange, ElectricityHistoryCacheEntry>
> = {};

const hourFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "Europe/Helsinki",
});

function formatPrice(value: number) {
  return value.toFixed(2).replace(".", ",");
}

function formatDuration(minutes: number) {
  const roundedMinutes = Math.round(minutes);
  const hours = Math.floor(roundedMinutes / 60);
  const remainingMinutes = roundedMinutes % 60;
  return hours > 0
    ? `${hours} h ${String(remainingMinutes).padStart(2, "0")} min`
    : `${remainingMinutes} min`;
}

function formatEnergy(value: number) {
  return `${value.toLocaleString("fi-FI", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 1,
  })} kWh`;
}

function formatTime(value: string) {
  return hourFormatter.format(new Date(value)).replace(":", ".");
}

function formatAxisPrice(value: number) {
  return value.toLocaleString("fi-FI", { maximumFractionDigits: 2 });
}

function PriceTrendChart({ trend }: { trend: ElectricityPriceTrend }) {
  const [width, setWidth] = useState(0);
  const chartHeight = 82;
  const valueRange = Math.max(trend.axisMaximum - trend.axisMinimum, 1);
  const getY = (value: number) =>
    ((trend.axisMaximum - value) / valueRange) * chartHeight;
  const getPosition = (index: number, value: number) => ({
    x:
      trend.points.length <= 1
        ? width / 2
        : (index / (trend.points.length - 1)) * width,
    y: getY(value),
  });
  const segments = trend.points.flatMap((point, index) => {
    const previous = trend.points[index - 1];
    if (index === 0 || point.value === null || previous.value === null) {
      return [];
    }

    const start = getPosition(index - 1, previous.value);
    const end = getPosition(index, point.value);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const angle = Math.atan2(end.y - start.y, end.x - start.x);

    return [{ angle, end, length, start }];
  });

  return (
    <View style={styles.trendCard}>
      <View style={styles.trendHeader}>
        <Text style={styles.trendTitle}>Hintakehitys</Text>
      </View>
      <View style={styles.trendChartRow}>
        <View style={[styles.trendYAxis, { height: chartHeight + 19 }]}>
          {trend.axisTicks.map((tick) => (
            <Text
              key={tick}
              style={[styles.trendAxisLabel, { top: getY(tick) - 7 }]}
            >
              {formatAxisPrice(tick)}
            </Text>
          ))}
          <Text style={styles.trendAxisUnit}>c/kWh</Text>
        </View>
        <View style={styles.trendPlotColumn}>
          <View
            accessibilityLabel={`Hintakehitys. Alin ${trend.lowest === null ? "ei tietoa" : formatPrice(trend.lowest)}, korkein ${trend.highest === null ? "ei tietoa" : formatPrice(trend.highest)}, viimeisin ${trend.latest === null ? "ei tietoa" : formatPrice(trend.latest)} senttiä kilowattitunnilta.`}
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
            style={[styles.trendPlot, { height: chartHeight }]}
          >
            {trend.axisTicks.map((tick) => (
              <View
                key={tick}
                style={[styles.trendGridLine, { top: getY(tick) }]}
              />
            ))}
            {width > 0
              ? segments.map((segment, index) => (
                  <View
                    key={`segment-${index}`}
                    style={[
                      styles.trendLine,
                      {
                        left:
                          (segment.start.x + segment.end.x - segment.length) /
                          2,
                        top: (segment.start.y + segment.end.y) / 2 - 1,
                        transform: [{ rotate: `${segment.angle}rad` }],
                        width: segment.length,
                      },
                    ]}
                  />
                ))
              : null}
            {width > 0
              ? trend.points.map((point, index) => {
                  if (point.value === null) {
                    return null;
                  }
                  const position = getPosition(index, point.value);
                  return (
                    <View
                      key={point.dateKey}
                      style={[
                        styles.trendPoint,
                        { left: position.x - 3, top: position.y - 3 },
                      ]}
                    />
                  );
                })
              : null}
          </View>
          <View style={styles.trendXAxis}>
            {width > 0
              ? trend.dateLabels.map((dateLabel) => {
                  const x =
                    (dateLabel.index / (trend.points.length - 1)) * width;
                  const isFirst = dateLabel.index === 0;
                  const isLast = dateLabel.index === trend.points.length - 1;
                  return (
                    <Text
                      key={dateLabel.dateKey}
                      style={[
                        styles.trendDateLabel,
                        isFirst
                          ? styles.trendFirstDateLabel
                          : isLast
                            ? styles.trendLastDateLabel
                            : { left: x - 18 },
                      ]}
                    >
                      {dateLabel.label}
                    </Text>
                  );
                })
              : null}
          </View>
        </View>
      </View>
      <View style={styles.trendStats}>
        {[
          ["Alin", trend.lowest],
          ["Korkein", trend.highest],
          ["Viimeisin", trend.latest],
        ].map(([label, value]) => (
          <View key={String(label)} style={styles.trendStat}>
            <Text style={styles.trendStatLabel}>{label}</Text>
            <Text style={styles.trendStatValue}>
              {typeof value === "number" ? formatPrice(value) : "--"}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export default function ElectricityHistoryScreen() {
  const router = useRouter();
  const mountedAtRef = useRef(getPerformanceNow());
  const initialRangeRef = useRef<ElectricityPriceRange>(1);
  const firstRenderLoggedRef = useRef(false);
  const fetchCountRef = useRef(0);
  const cacheRef = useRef<
    Partial<Record<ElectricityPriceRange, ElectricityHistoryCacheEntry>>
  >(electricityHistoryCache);
  const inFlightRef = useRef<Partial<Record<ElectricityPriceRange, boolean>>>(
    {},
  );
  const [range, setRange] = useState<ElectricityPriceRange>(1);
  const [dataFilter, setDataFilter] = useState<HistoryDataFilter>("heated");
  const [prices, setPrices] = useState<ElectricityPriceRecord[]>(
    electricityHistoryCache[1]?.prices ?? [],
  );
  const [heatingPeriods, setHeatingPeriods] = useState<HeatingEnergyPeriod[]>(
    electricityHistoryCache[1]?.heatingPeriods ?? [],
  );
  const [plannedHeatingHours, setPlannedHeatingHours] = useState<number[]>(
    electricityHistoryCache[1]?.plannedHeatingHours ?? [],
  );
  const [isInteractionComplete, setIsInteractionComplete] = useState(false);
  const [isLoading, setIsLoading] = useState(!electricityHistoryCache[1]);
  const [isHeatingLoading, setIsHeatingLoading] = useState(
    !electricityHistoryCache[1],
  );
  const [error, setError] = useState<string | null>(
    electricityHistoryCache[1]?.error ?? null,
  );
  const [heatingError, setHeatingError] = useState<string | null>(
    electricityHistoryCache[1]?.heatingError ?? null,
  );
  const [, setCache] = useState<
    Partial<Record<ElectricityPriceRange, ElectricityHistoryCacheEntry>>
  >({});

  const updateCacheEntry = useCallback(
    (
      nextRange: ElectricityPriceRange,
      updater: (
        previousEntry: ElectricityHistoryCacheEntry | undefined,
      ) => ElectricityHistoryCacheEntry,
    ) => {
      const nextCache = {
        ...cacheRef.current,
        [nextRange]: updater(cacheRef.current[nextRange]),
      };
      Object.assign(electricityHistoryCache, nextCache);
      cacheRef.current = nextCache;
      setCache(nextCache);
    },
    [],
  );

  const fetchHistory = useCallback(async (nextRange = range, force = false) => {
    if (inFlightRef.current[nextRange]) {
      return;
    }
    if (!force && cacheRef.current[nextRange]) {
      return;
    }

    inFlightRef.current[nextRange] = true;
    fetchCountRef.current += 1;
    const viewLoadStartedAt = getPerformanceNow();
    const hasCachedData = Boolean(cacheRef.current[nextRange]);
    setIsLoading(!hasCachedData);
    setIsHeatingLoading(true);
    setError(cacheRef.current[nextRange]?.error ?? null);
    setHeatingError(cacheRef.current[nextRange]?.heatingError ?? null);
    const rangeStart = getElectricityHistoryRangeStartIso(nextRange);
    const tomorrowKey = offsetDateKey(
      getHelsinkiElectricityDateKey(new Date()),
      1,
    );
    const rangeEnd = getHelsinkiDateStartIso(tomorrowKey);

    logElectricityHistoryPerformance(nextRange, "query started", {
      fetchCount: fetchCountRef.current,
      force,
      hasCachedData,
    });

    try {
      const electricityPricesStartedAt = getPerformanceNow();
      const { data, error: queryError } = await supabase
        .from("electricity_prices")
        .select(
          "starts_at,ends_at,spot_price_cents_kwh,resolution_minutes,region,fetched_at",
        )
        .eq("region", electricityPriceRegion)
        .gte("starts_at", rangeStart)
        .lt("starts_at", rangeEnd)
        .order("starts_at", { ascending: true });

      if (queryError) {
        throw queryError;
      }
      logElectricityHistoryPerformance(nextRange, "electricity_prices query", {
        durationMs: getPerformanceNow() - electricityPricesStartedAt,
        rowCount: data?.length ?? 0,
      });
      setPrices((data ?? []) as ElectricityPriceRecord[]);
      updateCacheEntry(nextRange, (previousEntry) => ({
        error: null,
        fetchedAt: getPerformanceNow(),
        heatingError: previousEntry?.heatingError ?? null,
        heatingPeriods: previousEntry?.heatingPeriods ?? [],
        plannedHeatingHours: previousEntry?.plannedHeatingHours ?? [],
        prices: (data ?? []) as ElectricityPriceRecord[],
      }));
    } catch {
      setError("Hintahistorian hakeminen epäonnistui. Yritä myöhemmin uudelleen.");
    } finally {
      setIsLoading(false);
    }

    try {
      const tankReadingsStartedAt = getPerformanceNow();
      const { data, error: heatingPeriodsError } = await supabase.rpc(
        "get_heating_periods",
        {
          p_end: rangeEnd,
          p_start: rangeStart,
        },
      );

      if (heatingPeriodsError) {
        throw heatingPeriodsError;
      }

      const heatingPeriodRows = (data ?? []) as HeatingPeriodRpcRow[];
      logElectricityHistoryPerformance(nextRange, "tank_readings queries", {
        durationMs: getPerformanceNow() - tankReadingsStartedAt,
        fetchAllHeatingHistoryPages: 0,
        heatingPeriodRowCount: heatingPeriodRows.length,
        tankReadingsRowCount: 0,
      });
      const heatingCalculationStartedAt = getPerformanceNow();
      const consumption = mapHeatingPeriodRowsToEnergyConsumption({
        rows: heatingPeriodRows,
        todayKey: getHelsinkiElectricityDateKey(new Date()),
      });
      logElectricityHistoryPerformance(nextRange, "heating periods calculation", {
        durationMs: getPerformanceNow() - heatingCalculationStartedAt,
        heatingPeriodCount: consumption.periods.length,
        tankReadingsRowCount: 0,
      });
      const nextHeatingPeriods = consumption.periods.filter(
        (period) => period.duration_minutes > 0,
      );
      setHeatingPeriods(nextHeatingPeriods);
      updateCacheEntry(nextRange, (previousEntry) => ({
        error: previousEntry?.error ?? null,
        fetchedAt: getPerformanceNow(),
        heatingError: null,
        heatingPeriods: nextHeatingPeriods,
        plannedHeatingHours: previousEntry?.plannedHeatingHours ?? [],
        prices: previousEntry?.prices ?? [],
      }));

      const todayKey = getHelsinkiElectricityDateKey(new Date());
      const planResult = await supabase
        .from("heating_plans")
        .select("planned_hours")
        .eq("plan_date", todayKey)
        .limit(1);

      if (planResult.error) {
        console.warn("Lämmityssuunnitelmaa ei saatu ladattua.", planResult.error);
      } else {
        const plan = (planResult.data as { planned_hours?: unknown }[] | null)?.[0];
        const nextPlannedHeatingHours = normalizeStoredHeatingPlanHours(
          plan?.planned_hours,
        );
        setHeatingPeriods(nextHeatingPeriods);
        setPlannedHeatingHours(nextPlannedHeatingHours);
        updateCacheEntry(nextRange, (previousEntry) => ({
          error: previousEntry?.error ?? null,
          fetchedAt: getPerformanceNow(),
          heatingError: null,
          heatingPeriods: nextHeatingPeriods,
          plannedHeatingHours: nextPlannedHeatingHours,
          prices: previousEntry?.prices ?? [],
        }));
      }
    } catch {
      setHeatingError("Lämmityshistoriaa ei saatu ladattua.");
    } finally {
      inFlightRef.current[nextRange] = false;
      setIsHeatingLoading(false);
      logElectricityHistoryPerformance(nextRange, "query completed", {
        durationMs: getPerformanceNow() - viewLoadStartedAt,
        fetchCount: fetchCountRef.current,
      });
      logElectricityHistoryPerformance(nextRange, "view load", {
        durationMs: getPerformanceNow() - viewLoadStartedAt,
      });
    }
  }, [range, updateCacheEntry]);

  useEffect(() => {
    if (!isInteractionComplete) {
      return;
    }

    const cachedEntry = cacheRef.current[range];
    if (cachedEntry) {
      setPrices(cachedEntry.prices);
      setHeatingPeriods(cachedEntry.heatingPeriods);
      setPlannedHeatingHours(cachedEntry.plannedHeatingHours);
      setError(cachedEntry.error);
      setHeatingError(cachedEntry.heatingError);
      setIsLoading(false);
      setIsHeatingLoading(false);
    }

    const shouldRefresh =
      cachedEntry &&
      getPerformanceNow() - cachedEntry.fetchedAt > 60 * 1000;

    void fetchHistory(range, Boolean(shouldRefresh));
  }, [fetchHistory, isInteractionComplete, range]);

  useEffect(() => {
    logElectricityHistoryPerformance(initialRangeRef.current, "navigation mounted", {
      fetchCount: fetchCountRef.current,
    });
  }, []);

  useEffect(() => {
    if (firstRenderLoggedRef.current) {
      return;
    }
    firstRenderLoggedRef.current = true;
    const elapsedMs = getPerformanceNow() - mountedAtRef.current;

    logElectricityHistoryPerformance(initialRangeRef.current, "first render", {
      durationMs: elapsedMs,
      estimatedElementCount: 24,
      targetUnderMs: 100,
    });
    logElectricityHistoryPerformance(initialRangeRef.current, "first content visible", {
      durationMs: elapsedMs,
      estimatedElementCount: 24,
      targetUnderMs: 100,
    });
  }, []);

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setIsInteractionComplete(true);
      logElectricityHistoryPerformance(
        initialRangeRef.current,
        "interaction completed",
        {
          durationMs: getPerformanceNow() - mountedAtRef.current,
        },
      );
    });

    return () => task.cancel();
  }, []);

  const days = useMemo(
    () =>
      isInteractionComplete ? groupElectricityPricesByHelsinkiDay(prices) : [],
    [isInteractionComplete, prices],
  );
  const heatedDays = useMemo(
    () =>
      isInteractionComplete
        ? calculateHeatedPriceHistory(heatingPeriods, prices)
        : [],
    [heatingPeriods, isInteractionComplete, prices],
  );
  const heatedDaysByKey = useMemo(
    () => new Map(heatedDays.map((day) => [day.dateKey, day])),
    [heatedDays],
  );
  const daysByKey = useMemo(
    () => new Map(days.map((day) => [day.dateKey, day])),
    [days],
  );
  const todayKey = getHelsinkiElectricityDateKey(new Date());
  const displayedDays = useMemo(
    () => {
      if (dataFilter === "all") {
        return days;
      }

      const heatedDateKeys = new Set(heatedDays.map((day) => day.dateKey));
      if (range === 1 && plannedHeatingHours.length > 0) {
        heatedDateKeys.add(todayKey);
      }

      return [...heatedDateKeys]
        .map(
          (dateKey) =>
            daysByKey.get(dateKey) ?? {
                averageSpotPrice: 0,
                averageTotalPrice: 0,
                dateKey,
                highestSpotPrice: 0,
                highestTotalPrice: 0,
                isPartial: true,
                lowestSpotPrice: 0,
                lowestTotalPrice: 0,
                prices: [],
              },
        )
        .sort((first, second) => second.dateKey.localeCompare(first.dateKey));
    },
    [
      dataFilter,
      days,
      daysByKey,
      heatedDays,
      plannedHeatingHours.length,
      range,
      todayKey,
    ],
  );
  const heatingSummary = useMemo(
    () =>
      heatedDays.reduce(
        (summary, day) => ({
          costEuros: summary.costEuros + day.costEuros,
          coveredMinutes: summary.coveredMinutes + day.coveredMinutes,
          durationMinutes: summary.durationMinutes + day.durationMinutes,
          energyKwh: summary.energyKwh + day.energyKwh,
          isPartial: summary.isPartial || day.isPartial,
          weightedPriceMinutes:
            summary.weightedPriceMinutes +
            day.segments.reduce(
              (sum, segment) =>
                sum + segment.priceCentsPerKwh * segment.durationMinutes,
              0,
            ),
          weightedSpotPriceMinutes:
            summary.weightedSpotPriceMinutes +
            day.segments.reduce(
              (sum, segment) =>
                sum +
                segment.spotPriceCentsPerKwh * segment.durationMinutes,
              0,
            ),
        }),
        {
          costEuros: 0,
          coveredMinutes: 0,
          durationMinutes: 0,
          energyKwh: 0,
          isPartial: false,
          weightedPriceMinutes: 0,
          weightedSpotPriceMinutes: 0,
        },
      ),
    [heatedDays],
  );
  const todayHeatingTimeline = useMemo(
    () =>
      isInteractionComplete
        ? buildTodayHeatingTimeline({
            actualSegments: heatedDaysByKey.get(todayKey)?.segments ?? [],
            dateKey: todayKey,
            plannedHours: plannedHeatingHours,
            prices,
          })
        : [],
    [heatedDaysByKey, isInteractionComplete, plannedHeatingHours, prices, todayKey],
  );
  const priceTrend = useMemo(() => {
    const trendStartedAt = getPerformanceNow();
    const trend =
      !isInteractionComplete || range === 1
        ? null
        : buildElectricityPriceTrend({
            dataFilter,
            heatedDays,
            priceDays: days,
            range,
            todayKey,
          });

    logElectricityHistoryPerformance(range, "trend data build", {
      dataFilter,
      durationMs: getPerformanceNow() - trendStartedAt,
      heatedDayCount: heatedDays.length,
      priceDayCount: days.length,
      trendPointCount: trend?.points.length ?? 0,
    });

    return trend;
  }, [dataFilter, days, heatedDays, isInteractionComplete, range, todayKey]);
  const displayedValues = isInteractionComplete
    ? prices.flatMap((price) => [
        price.spot_price_cents_kwh,
        getTotalPriceCentsPerKwh(price.spot_price_cents_kwh),
      ])
    : [];
  const chartMin = displayedValues.length ? Math.min(...displayedValues, 0) : 0;
  const chartMax = displayedValues.length ? Math.max(...displayedValues, 0) : 1;
  const chartRange = Math.max(chartMax - chartMin, 1);
  const backgroundRefreshing =
    Boolean(cacheRef.current[range]) && (isLoading || isHeatingLoading);

  const renderHistoryDay = useCallback(
    ({ item: day }: { item: (typeof displayedDays)[number] }) => {
      const priceSummaries = [
        ["Keskihinta", day.averageTotalPrice, day.averageSpotPrice],
        ["Alin", day.lowestTotalPrice, day.lowestSpotPrice],
        ["Korkein", day.highestTotalPrice, day.highestSpotPrice],
      ] as const;
      const heatedDay = heatedDaysByKey.get(day.dateKey);
      const showPartial =
        dataFilter === "all" ? day.isPartial : Boolean(heatedDay?.isPartial);

      return (
        <View style={styles.dayCard}>
          <View style={styles.dayHeader}>
            <Text style={styles.dayTitle}>
              {formatFinnishHistoryDate(day.dateKey)}
            </Text>
            {showPartial ? <Text style={styles.partial}>Osittainen</Text> : null}
          </View>
          {dataFilter === "all" ? (
            <>
              <View style={styles.summaryRow}>
                {priceSummaries.map(([label, totalPrice, spotPrice]) => (
                  <View key={String(label)} style={styles.summaryItem}>
                    <Text style={styles.summaryLabel}>{label}</Text>
                    <Text style={styles.summaryValue}>
                      {formatPrice(totalPrice)}
                    </Text>
                    <Text style={styles.summarySpotValue}>
                      spot {formatPrice(spotPrice)}
                    </Text>
                  </View>
                ))}
              </View>
              <Text style={styles.unitLabel}>c/kWh</Text>
            </>
          ) : range !== 1 ? (
            heatedDay ? (
              <View style={styles.heatedSummaryGrid}>
                {[
                  [
                    "Lämmitetty keskihinta",
                    heatedDay.weightedAveragePrice === null
                      ? "Hintatieto puuttuu"
                      : `${formatPrice(heatedDay.weightedAveragePrice)} c/kWh`,
                  ],
                  ["Lämmitys", formatDuration(heatedDay.durationMinutes)],
                  ["Energia", formatEnergy(heatedDay.energyKwh)],
                  ["Kustannus", `n. ${formatPrice(heatedDay.costEuros)} €`],
                ].map(([label, value]) => (
                  <View key={label} style={styles.heatedSummaryItem}>
                    <Text style={styles.summaryLabel}>{label}</Text>
                    <Text style={styles.heatedSummaryValue}>{value}</Text>
                    {label === "Lämmitetty keskihinta" &&
                    heatedDay.weightedAverageSpotPrice !== null ? (
                      <Text style={styles.summarySpotValue}>
                        spot {formatPrice(heatedDay.weightedAverageSpotPrice)} c/kWh
                      </Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.noHeatingText}>
                {getHeatingDayEmptyLabel(heatedDay)}
              </Text>
            )
          ) : null}
          {range === 1 && dataFilter === "all" ? (
            <View style={styles.hourList}>
              {day.prices.map((price) => {
                const spotPrice = price.spot_price_cents_kwh;
                const totalPrice = getTotalPriceCentsPerKwh(spotPrice);
                const zeroPosition = ((0 - chartMin) / chartRange) * 100;
                const totalPosition =
                  ((totalPrice - chartMin) / chartRange) * 100;
                const spotPosition =
                  ((spotPrice - chartMin) / chartRange) * 100;
                const totalLeft = Math.min(zeroPosition, totalPosition);
                const totalWidth = Math.max(
                  Math.abs(totalPosition - zeroPosition),
                  1.5,
                );

                return (
                  <View
                    key={`${price.region}-${price.starts_at}-${price.resolution_minutes}`}
                    style={styles.hourRow}
                  >
                    <Text style={styles.hourLabel}>
                      {hourFormatter.format(new Date(price.starts_at))}
                    </Text>
                    <View style={styles.barTrack}>
                      <View
                        style={[styles.zeroLine, { left: `${zeroPosition}%` }]}
                      />
                      <View
                        style={[
                          styles.bar,
                          { left: `${totalLeft}%`, width: `${totalWidth}%` },
                        ]}
                      />
                      <View
                        style={[
                          styles.spotMarker,
                          { left: `${spotPosition}%` },
                        ]}
                      />
                    </View>
                    <View style={styles.hourPriceBlock}>
                      <Text style={styles.hourPrice}>
                        {formatPrice(totalPrice)} c/kWh
                      </Text>
                      <Text style={styles.hourSpotPrice}>
                        spot {formatPrice(spotPrice)} c/kWh
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : range === 1 && day.dateKey === todayKey ? (
            <View style={styles.heatedSegmentList}>
              {todayHeatingTimeline.map((segment) => (
                <View
                  key={`${segment.status}-${segment.startedAt}-${segment.endedAt}`}
                  style={styles.heatedSegmentRow}
                >
                  <Text style={styles.heatedSegmentTime}>
                    {segment.marker} {formatTime(segment.startedAt)}–
                    {formatTime(segment.endedAt)}
                  </Text>
                  <Text style={styles.heatedSegmentDetails}>
                    {formatPrice(segment.priceCentsPerKwh)} c/kWh ·{" "}
                    {formatEnergy(segment.energyKwh)} · n.{" "}
                    {formatPrice(segment.costEuros)} €
                  </Text>
                  <Text style={styles.heatedSegmentSpotPrice}>
                    spot {formatPrice(segment.spotPriceCentsPerKwh)} c/kWh
                  </Text>
                </View>
              ))}
              {todayHeatingTimeline.length === 0 ? (
                <Text style={styles.noHeatingText}>Ei lämmitystä</Text>
              ) : null}
            </View>
          ) : range === 1 ? (
            <Text style={styles.noHeatingText}>
              {getHeatingDayEmptyLabel(heatedDay)}
            </Text>
          ) : null}
        </View>
      );
    },
    [
      chartMin,
      chartRange,
      dataFilter,
      heatedDaysByKey,
      range,
      todayHeatingTimeline,
      todayKey,
    ],
  );

  return (
    <View style={styles.screen}>
      <View style={[styles.glow, styles.greenGlow]} />
      <View style={[styles.glow, styles.blueGlow]} />
      <Pressable
        accessibilityLabel="Takaisin"
        accessibilityRole="button"
        onPress={() => router.back()}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      >
        <Text style={styles.backButtonText}>‹</Text>
      </Pressable>
      <FlatList
        contentContainerStyle={styles.content}
        data={
          isInteractionComplete &&
          !isLoading &&
          !error &&
          !(dataFilter === "heated" && heatingError)
            ? displayedDays
            : []
        }
        initialNumToRender={6}
        keyExtractor={(day) => day.dateKey}
        ListHeaderComponent={
          <>
        <View style={styles.header}>
          <Text style={styles.title}>Hintahistoria</Text>
          <Text style={styles.subtitle}>Suomi · Europe/Helsinki</Text>
        </View>

        <View style={styles.selector}>
          {ranges.map((option) => (
            <Pressable
              key={option.value}
              onPress={() => setRange(option.value)}
              style={[
                styles.selectorButton,
                range === option.value && styles.activeButton,
              ]}
            >
              <Text
                style={[
                  styles.selectorText,
                  range === option.value && styles.activeText,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.filterGroup}>
          <Text style={styles.filterLabel}>Tarkasteltava data</Text>
          <View style={styles.dataSelector}>
            {(["heated", "all"] as const).map((value) => (
              <Pressable
                key={value}
                onPress={() => setDataFilter(value)}
                style={[styles.modeButton, dataFilter === value && styles.activeButton]}
              >
                <Text
                  style={[
                    styles.selectorText,
                    dataFilter === value && styles.activeText,
                  ]}
                >
                  {value === "all" ? "Kaikki hinnat" : "Lämmitetyt tunnit"}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <Text style={styles.costNote}>
          Kokonaishinta: spot + 0,40 c/kWh marginaali + 8,22 c/kWh siirto ja
          verot. Kiinteitä kuukausimaksuja ei lasketa mukaan.
        </Text>

        {backgroundRefreshing ? (
          <View style={styles.heatingLoadingCard}>
            <ActivityIndicator color="#36f4d4" size="small" />
            <Text style={styles.heatingLoadingText}>Päivitetään...</Text>
          </View>
        ) : null}

        {isLoading ? (
          <View style={styles.loadingCard}>
            <Text style={styles.loadingTitle}>Ladataan hintatietoja...</Text>
            <View style={styles.skeletonLineWide} />
            <View style={styles.skeletonLine} />
          </View>
        ) : error ? (
          <View style={styles.emptyCard}>
            <Text accessibilityRole="alert" style={styles.emptyText}>{error}</Text>
          </View>
        ) : dataFilter === "heated" && heatingError ? (
          <View style={styles.emptyCard}>
            <Text accessibilityRole="alert" style={styles.emptyText}>
              {heatingError} Kaikki hinnat ovat edelleen käytettävissä.
            </Text>
          </View>
        ) : displayedDays.length === 0 &&
          !(dataFilter === "heated" && isHeatingLoading) ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>
              {dataFilter === "heated"
                ? "Ei lämmitystä valitulla ajanjaksolla."
                : "Hintahistoriaa alkaa kertyä, kun EnergyZen hakee uusia hintoja."}
            </Text>
          </View>
        ) : (
          <>
          {priceTrend ? <PriceTrendChart trend={priceTrend} /> : null}
          {dataFilter === "heated" && isHeatingLoading ? (
            <View style={styles.heatingLoadingCard}>
              <ActivityIndicator color="#36f4d4" size="small" />
              <Text style={styles.heatingLoadingText}>
                Ladataan lämmitettyjä tunteja...
              </Text>
            </View>
          ) : null}
          {dataFilter === "heated" && range !== 1 ? (
            <View style={styles.rangeSummaryCard}>
              <View style={styles.dayHeader}>
                <Text style={styles.rangeSummaryTitle}>
                  {range} päivän lämmitysyhteenveto
                </Text>
                {heatingSummary.isPartial ? (
                  <Text style={styles.partial}>Osittainen</Text>
                ) : null}
              </View>
              <View style={styles.heatedSummaryGrid}>
                {[
                  [
                    "Lämmitetty keskihinta",
                    heatingSummary.coveredMinutes > 0
                      ? `${formatPrice(
                          heatingSummary.weightedPriceMinutes /
                            heatingSummary.coveredMinutes,
                        )} c/kWh`
                      : "Hintatieto puuttuu",
                  ],
                  ["Lämmitys", formatDuration(heatingSummary.durationMinutes)],
                  ["Energia", formatEnergy(heatingSummary.energyKwh)],
                  ["Kustannus", `n. ${formatPrice(heatingSummary.costEuros)} €`],
                ].map(([label, value]) => (
                  <View key={label} style={styles.heatedSummaryItem}>
                    <Text style={styles.summaryLabel}>{label}</Text>
                    <Text style={styles.heatedSummaryValue}>{value}</Text>
                    {label === "Lämmitetty keskihinta" &&
                    heatingSummary.coveredMinutes > 0 ? (
                      <Text style={styles.summarySpotValue}>
                        spot {formatPrice(
                          heatingSummary.weightedSpotPriceMinutes /
                            heatingSummary.coveredMinutes,
                        )} c/kWh
                      </Text>
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}
          {false && displayedDays.map((day) => {
            const priceSummaries = [
              ["Keskihinta", day.averageTotalPrice, day.averageSpotPrice],
              ["Alin", day.lowestTotalPrice, day.lowestSpotPrice],
              ["Korkein", day.highestTotalPrice, day.highestSpotPrice],
            ] as const;
            const heatedDay = heatedDaysByKey.get(day.dateKey);
            const showPartial =
              dataFilter === "all" ? day.isPartial : Boolean(heatedDay?.isPartial);
            return (
              <View key={day.dateKey} style={styles.dayCard}>
                <View style={styles.dayHeader}>
                  <Text style={styles.dayTitle}>
                    {formatFinnishHistoryDate(day.dateKey)}
                  </Text>
                  {showPartial ? <Text style={styles.partial}>Osittainen</Text> : null}
                </View>
                {dataFilter === "all" ? (
                  <>
                    <View style={styles.summaryRow}>
                      {priceSummaries.map(([label, totalPrice, spotPrice]) => (
                        <View key={String(label)} style={styles.summaryItem}>
                          <Text style={styles.summaryLabel}>{label}</Text>
                          <Text style={styles.summaryValue}>
                            {formatPrice(totalPrice)}
                          </Text>
                          <Text style={styles.summarySpotValue}>
                            spot {formatPrice(spotPrice)}
                          </Text>
                        </View>
                      ))}
                    </View>
                    <Text style={styles.unitLabel}>c/kWh</Text>
                  </>
                ) : range !== 1 ? (
                  heatedDay ? (
                    <View style={styles.heatedSummaryGrid}>
                      {[
                        [
                          "Lämmitetty keskihinta",
                          heatedDay.weightedAveragePrice === null
                            ? "Hintatieto puuttuu"
                            : `${formatPrice(heatedDay.weightedAveragePrice)} c/kWh`,
                        ],
                        ["Lämmitys", formatDuration(heatedDay.durationMinutes)],
                        ["Energia", formatEnergy(heatedDay.energyKwh)],
                        ["Kustannus", `n. ${formatPrice(heatedDay.costEuros)} €`],
                      ].map(([label, value]) => (
                      <View key={label} style={styles.heatedSummaryItem}>
                        <Text style={styles.summaryLabel}>{label}</Text>
                        <Text style={styles.heatedSummaryValue}>{value}</Text>
                        {label === "Lämmitetty keskihinta" &&
                        heatedDay.weightedAverageSpotPrice !== null ? (
                          <Text style={styles.summarySpotValue}>
                            spot {formatPrice(heatedDay.weightedAverageSpotPrice)} c/kWh
                          </Text>
                        ) : null}
                      </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.noHeatingText}>
                      {getHeatingDayEmptyLabel(heatedDay)}
                    </Text>
                  )
                ) : null}
                {range === 1 && dataFilter === "all" ? (
                  <View style={styles.hourList}>
                    {day.prices.map((price) => {
                      const spotPrice = price.spot_price_cents_kwh;
                      const totalPrice = getTotalPriceCentsPerKwh(spotPrice);
                      const zeroPosition = ((0 - chartMin) / chartRange) * 100;
                      const totalPosition =
                        ((totalPrice - chartMin) / chartRange) * 100;
                      const spotPosition =
                        ((spotPrice - chartMin) / chartRange) * 100;
                      const totalLeft = Math.min(zeroPosition, totalPosition);
                      const totalWidth = Math.max(
                        Math.abs(totalPosition - zeroPosition),
                        1.5,
                      );
                      return (
                        <View
                          key={`${price.region}-${price.starts_at}-${price.resolution_minutes}`}
                          style={styles.hourRow}
                        >
                          <Text style={styles.hourLabel}>
                            {hourFormatter.format(new Date(price.starts_at))}
                          </Text>
                          <View style={styles.barTrack}>
                            <View
                              style={[styles.zeroLine, { left: `${zeroPosition}%` }]}
                            />
                            <View
                              style={[
                                styles.bar,
                                { left: `${totalLeft}%`, width: `${totalWidth}%` },
                              ]}
                            />
                            <View
                              style={[
                                styles.spotMarker,
                                { left: `${spotPosition}%` },
                              ]}
                            />
                          </View>
                          <View style={styles.hourPriceBlock}>
                            <Text style={styles.hourPrice}>
                              {formatPrice(totalPrice)} c/kWh
                            </Text>
                            <Text style={styles.hourSpotPrice}>
                              spot {formatPrice(spotPrice)} c/kWh
                            </Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : range === 1 && day.dateKey === todayKey ? (
                  <View style={styles.heatedSegmentList}>
                    {todayHeatingTimeline.map((segment) => (
                      <View
                        key={`${segment.status}-${segment.startedAt}-${segment.endedAt}`}
                        style={styles.heatedSegmentRow}
                      >
                        <Text style={styles.heatedSegmentTime}>
                          {segment.marker} {formatTime(segment.startedAt)}–
                          {formatTime(segment.endedAt)}
                        </Text>
                        <Text style={styles.heatedSegmentDetails}>
                          {formatPrice(segment.priceCentsPerKwh)} c/kWh ·{" "}
                          {formatEnergy(segment.energyKwh)} · n. {formatPrice(segment.costEuros)} €
                        </Text>
                        <Text style={styles.heatedSegmentSpotPrice}>
                          spot {formatPrice(segment.spotPriceCentsPerKwh)} c/kWh
                        </Text>
                      </View>
                    ))}
                    {todayHeatingTimeline.length === 0 ? (
                      <Text style={styles.noHeatingText}>Ei lämmitystä</Text>
                    ) : null}
                  </View>
                ) : range === 1 ? (
                  <Text style={styles.noHeatingText}>
                    {getHeatingDayEmptyLabel(heatedDay)}
                  </Text>
                ) : null}
              </View>
            );
          })}
          </>
        )}
          </>
        }
        maxToRenderPerBatch={6}
        renderItem={renderHistoryDay}
        showsVerticalScrollIndicator={false}
        windowSize={5}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#050816", flex: 1, overflow: "hidden" },
  content: { paddingBottom: 40, paddingHorizontal: 20, paddingTop: 72 },
  glow: { borderRadius: 999, height: 280, opacity: 0.22, position: "absolute", width: 280 },
  greenGlow: { backgroundColor: "#54eaa0", right: -160, top: 60 },
  blueGlow: { backgroundColor: "#5aa7ff", bottom: 50, left: -180 },
  backButton: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 999, height: 44, justifyContent: "center", left: 18, position: "absolute", top: 48, width: 44, zIndex: 10 },
  backButtonText: { color: "#f7fbff", fontSize: 27, fontWeight: "900" },
  pressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },
  header: { alignItems: "center", marginBottom: 18 },
  title: { color: "#f7fbff", fontSize: 28, fontWeight: "900" },
  subtitle: { color: "#b9d7ff", fontSize: 14, fontWeight: "700", marginTop: 5 },
  selector: { backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 999, flexDirection: "row", gap: 5, marginBottom: 10, padding: 5 },
  selectorButton: { alignItems: "center", borderRadius: 999, flex: 1, paddingVertical: 10 },
  filterGroup: { marginBottom: 10 },
  filterLabel: { color: "#9fc7df", fontSize: 11, fontWeight: "800", marginBottom: 5, textAlign: "center" },
  dataSelector: { backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 999, flexDirection: "row", padding: 4, width: "100%" },
  modeButton: { alignItems: "center", borderRadius: 999, flex: 1, paddingVertical: 8 },
  activeButton: { backgroundColor: "rgba(54,244,212,0.18)" },
  selectorText: { color: "#8ea4cf", fontSize: 13, fontWeight: "900" },
  activeText: { color: "#f8fbff" },
  costNote: { color: "#9fc7df", fontSize: 12, lineHeight: 17, marginBottom: 12, textAlign: "center" },
  loader: { marginTop: 64 },
  loadingCard: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 24, marginTop: 12, padding: 18 },
  loadingTitle: { color: "#cfe9ff", fontSize: 15, fontWeight: "900", marginBottom: 14 },
  skeletonLine: { backgroundColor: "rgba(207,233,255,0.16)", borderRadius: 999, height: 12, marginTop: 10, width: "58%" },
  skeletonLineWide: { backgroundColor: "rgba(207,233,255,0.16)", borderRadius: 999, height: 12, width: "86%" },
  emptyCard: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 24, marginTop: 12, padding: 30 },
  emptyText: { color: "#cfe9ff", fontSize: 16, fontWeight: "800", lineHeight: 23, textAlign: "center" },
  dayCard: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 24, marginBottom: 12, padding: 16 },
  rangeSummaryCard: { backgroundColor: "rgba(54,244,212,0.1)", borderColor: "rgba(54,244,212,0.24)", borderRadius: 24, borderWidth: 1, marginBottom: 12, padding: 16 },
  rangeSummaryTitle: { color: "#f7fbff", fontSize: 17, fontWeight: "900" },
  trendCard: { backgroundColor: "rgba(90,167,255,0.09)", borderColor: "rgba(90,167,255,0.2)", borderRadius: 24, borderWidth: 1, marginBottom: 12, padding: 16 },
  trendHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  trendTitle: { color: "#f7fbff", fontSize: 17, fontWeight: "900" },
  trendChartRow: { flexDirection: "row", marginTop: 10 },
  trendYAxis: { position: "relative", width: 39 },
  trendAxisLabel: { color: "#7182a3", fontSize: 9, fontWeight: "700", position: "absolute", right: 6, textAlign: "right" },
  trendAxisUnit: { bottom: 0, color: "#7182a3", fontSize: 8, fontWeight: "700", position: "absolute", right: 5 },
  trendPlotColumn: { flex: 1 },
  trendPlot: { overflow: "visible", position: "relative" },
  trendGridLine: { backgroundColor: "rgba(207,233,255,0.1)", height: 1, left: 0, position: "absolute", right: 0 },
  trendLine: { backgroundColor: "rgba(54,244,212,0.72)", borderRadius: 999, height: 2, position: "absolute" },
  trendPoint: { backgroundColor: "#36f4d4", borderColor: "#dffefa", borderRadius: 999, borderWidth: 1, height: 6, position: "absolute", width: 6 },
  trendXAxis: { height: 19, position: "relative" },
  trendDateLabel: { color: "#7182a3", fontSize: 8, fontWeight: "700", position: "absolute", textAlign: "center", top: 5, width: 36 },
  trendFirstDateLabel: { left: 0, textAlign: "left" },
  trendLastDateLabel: { right: 0, textAlign: "right" },
  trendStats: { flexDirection: "row", gap: 8, marginTop: 8 },
  trendStat: { backgroundColor: "rgba(5,8,22,0.38)", borderRadius: 12, flex: 1, paddingHorizontal: 9, paddingVertical: 7 },
  trendStatLabel: { color: "#8190b5", fontSize: 10, fontWeight: "800" },
  trendStatValue: { color: "#f7fbff", fontSize: 14, fontWeight: "900", marginTop: 2 },
  heatingLoadingCard: { alignItems: "center", backgroundColor: "rgba(54,244,212,0.1)", borderColor: "rgba(54,244,212,0.24)", borderRadius: 16, borderWidth: 1, flexDirection: "row", gap: 10, marginBottom: 12, paddingHorizontal: 14, paddingVertical: 12 },
  heatingLoadingText: { color: "#cfe9ff", fontSize: 13, fontWeight: "800" },
  dayHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  dayTitle: { color: "#f7fbff", fontSize: 18, fontWeight: "900", textTransform: "capitalize" },
  partial: { backgroundColor: "rgba(255,173,77,0.16)", borderRadius: 999, color: "#ffbf73", fontSize: 11, fontWeight: "900", overflow: "hidden", paddingHorizontal: 9, paddingVertical: 4 },
  summaryRow: { flexDirection: "row", gap: 8 },
  summaryItem: { backgroundColor: "rgba(5,8,22,0.46)", borderRadius: 14, flex: 1, padding: 9 },
  summaryLabel: { color: "#9fc7df", fontSize: 11, fontWeight: "800" },
  summaryValue: { color: "#f7fbff", fontSize: 21, fontWeight: "900", marginTop: 2 },
  summarySpotValue: { color: "#78a9c7", fontSize: 11, fontWeight: "700", marginTop: 2 },
  heatedSummaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  heatedSummaryItem: { backgroundColor: "rgba(5,8,22,0.46)", borderRadius: 14, minHeight: 64, padding: 10, width: "48%" },
  heatedSummaryValue: { color: "#f7fbff", fontSize: 16, fontWeight: "900", marginTop: 4 },
  noHeatingText: { color: "#9fc7df", fontSize: 15, fontWeight: "800", paddingVertical: 18, textAlign: "center" },
  unitLabel: { color: "#8190b5", fontSize: 11, fontWeight: "800", marginTop: 6, textAlign: "right" },
  hourList: { gap: 7, marginTop: 16 },
  hourRow: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 38 },
  hourLabel: { color: "#b9d7ff", fontSize: 12, fontWeight: "800", width: 40 },
  barTrack: { backgroundColor: "rgba(207,233,255,0.08)", borderRadius: 999, flex: 1, height: 12, overflow: "hidden", position: "relative" },
  zeroLine: { backgroundColor: "rgba(247,251,255,0.38)", height: 12, position: "absolute", width: 1 },
  bar: { backgroundColor: "#36f4d4", borderRadius: 999, height: 8, position: "absolute", top: 2 },
  spotMarker: { backgroundColor: "#71a7ff", borderRadius: 999, height: 12, marginLeft: -1, position: "absolute", width: 2 },
  hourPriceBlock: { alignItems: "flex-end", width: 108 },
  hourPrice: { color: "#f7fbff", fontSize: 12, fontWeight: "900", textAlign: "right" },
  hourSpotPrice: { color: "#78a9c7", fontSize: 10, fontWeight: "700", marginTop: 1, textAlign: "right" },
  heatedSegmentList: { gap: 8 },
  heatedSegmentRow: { backgroundColor: "rgba(5,8,22,0.46)", borderRadius: 12, paddingHorizontal: 11, paddingVertical: 9 },
  heatedSegmentTime: { color: "#f7fbff", fontSize: 13, fontWeight: "900" },
  heatedSegmentDetails: { color: "#b9d7ff", fontSize: 12, fontWeight: "700", marginTop: 3 },
  heatedSegmentSpotPrice: { color: "#78a9c7", fontSize: 11, fontWeight: "700", marginTop: 2 },
});

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  GestureResponderEvent,
  InteractionManager,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { debugLog } from "@/lib/debug";
import { defaultSettings } from "@/lib/settings";
import { supabase } from "@/lib/supabase";

type HistoryTab = "24h" | "7d";

type TemperatureHistoryPoint = {
  timestamp: string;
  topTemp: number;
  bottomTemp: number;
  averageTemp: number;
};

type SelectedHistoryPoint = {
  index: number;
  point: TemperatureHistoryPoint | HourlyTemperatureHistoryPoint;
  x: number;
};

type HourlyTemperatureHistoryPoint = {
  timestamp: string;
  hourKey: string;
  hourLabel: string;
  topTempAvg: number;
  bottomTempAvg: number;
  averageTempAvg: number;
};

type TankReadingRow = {
  created_at?: string | null;
  top_temp?: number | null;
  bottom_temp?: number | null;
};

type XAxisLabel = {
  align: "left" | "center" | "right";
  text: string;
};

const DEBUG_HISTORY_PERFORMANCE = false;
const chartHeight = 190;
const chartMinTemp = defaultSettings.minTankTemperature;
const chartMaxTemp = 70;
const closePointOffset = 2;
const tooltipWidth = 144;
const topTemperatureColor = "#FF8A4C";
const averageTemperatureColor = "#2DD4BF";
const bottomTemperatureColor = "#60A5FA";
const tooltipBottomOffset = 28;

function getPerformanceNow() {
  return Date.now();
}

function logTemperatureHistoryPerformance(
  range: string,
  event: string,
  data: Record<string, unknown>,
) {
  if (!DEBUG_HISTORY_PERFORMANCE) {
    return;
  }

  console.log("[EnergyZen perf][temperature-history]", {
    event,
    range,
    ...data,
  });
}

const temperatureHistoryCache: Record<HistoryTab, TemperatureHistoryPoint[]> = {
  "24h": [],
  "7d": [],
};
const temperatureHistoryLoaded: Record<HistoryTab, boolean> = {
  "24h": false,
  "7d": false,
};

const timeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

const tooltipTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "Europe/Helsinki",
});

const tooltipDateFormatter = new Intl.DateTimeFormat("fi-FI", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  weekday: "short",
});

const axisDateFormatter = new Intl.DateTimeFormat("fi-FI", {
  day: "numeric",
  month: "numeric",
  timeZone: "Europe/Helsinki",
});

const tooltipClockFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "numeric",
  hour12: false,
  minute: "2-digit",
  timeZone: "Europe/Helsinki",
});

const dayKeyFormatter = new Intl.DateTimeFormat("sv-SE", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

const hourKeyFormatter = new Intl.DateTimeFormat("sv-SE", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

const weekdayFormatter = new Intl.DateTimeFormat("fi-FI", {
  timeZone: "Europe/Helsinki",
  weekday: "short",
});

function formatHour(timestamp: string) {
  return `${timeFormatter.format(new Date(timestamp)).replace(".", "")}:00`;
}

function formatTooltipTime(timestamp: string) {
  return tooltipTimeFormatter.format(new Date(timestamp)).replace(".", ":");
}

function formatTooltipDateTime(timestamp: string) {
  const dateParts = tooltipDateFormatter.formatToParts(new Date(timestamp));
  const weekday = getDatePart(dateParts, "weekday").replace(".", "");
  const day = getDatePart(dateParts, "day");
  const month = getDatePart(dateParts, "month");
  const time = tooltipClockFormatter
    .format(new Date(timestamp))
    .replace(":", ".");

  return `${weekday} ${day}.${month}. klo ${time}`;
}

function formatWeekday(timestamp: string) {
  const weekday = weekdayFormatter.format(new Date(timestamp)).replace(".", "");

  return weekday.charAt(0).toUpperCase() + weekday.slice(1);
}

function formatAxisDay(timestamp: string) {
  const date = axisDateFormatter.format(new Date(timestamp));

  return `${formatWeekday(timestamp)} ${date}`;
}

function getDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
) {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function getHourKey(timestamp: string) {
  return hourKeyFormatter.format(new Date(timestamp));
}

function roundTemperature(value: number) {
  return Math.round(value * 10) / 10;
}

function calculateWeightedTemperature(topTemp: number, bottomTemp: number) {
  return topTemp * 0.7 + bottomTemp * 0.3;
}

function getHistoryRangeStart(rangeMs: number) {
  return new Date(Date.now() - rangeMs).toISOString();
}

function sortHistoryByCreatedAtAscending(history: TemperatureHistoryPoint[]) {
  return [...history].sort(
    (firstPoint, secondPoint) =>
      new Date(firstPoint.timestamp).getTime() -
      new Date(secondPoint.timestamp).getTime(),
  );
}

function mapTankReadingToHistoryPoint(
  reading: TankReadingRow,
): TemperatureHistoryPoint | null {
  if (
    !reading.created_at ||
    typeof reading.top_temp !== "number" ||
    typeof reading.bottom_temp !== "number"
  ) {
    return null;
  }

  return {
    averageTemp: calculateWeightedTemperature(
      reading.top_temp,
      reading.bottom_temp,
    ),
    bottomTemp: reading.bottom_temp,
    timestamp: reading.created_at,
    topTemp: reading.top_temp,
  };
}

async function fetchTemperatureHistoryPoints(
  startIso: string,
  rangeLabel: string,
  bucketMinutes: number,
  mode: "average" | "latest",
) {
  const fetchStartedAt = getPerformanceNow();
  const { data, error } = await supabase.rpc("get_temperature_history_points", {
    p_bucket_minutes: bucketMinutes,
    p_mode: mode,
    p_start: startIso,
  });

  if (error) {
    throw error;
  }

  const history = sortHistoryByCreatedAtAscending(
    ((data ?? []) as TankReadingRow[])
      .map(mapTankReadingToHistoryPoint)
      .filter((point): point is TemperatureHistoryPoint => point !== null),
  );

  logTemperatureHistoryPerformance(rangeLabel, "temperature history fetch", {
    bucketMinutes,
    durationMs: getPerformanceNow() - fetchStartedAt,
    mode,
    rawRowCount: history.length,
    rowCount: history.length,
  });

  return history;
}

function getVisibleHistory(
  history: TemperatureHistoryPoint[],
  selectedTab: HistoryTab,
) {
  if (selectedTab === "24h") {
    return history.length > 144
      ? sampleHistoryByLatestPoint(history, 10 * 60 * 1000)
      : history;
  }

  return getHourlyHistory(history);
}

function sampleHistoryByLatestPoint(
  history: TemperatureHistoryPoint[],
  bucketSizeMs: number,
) {
  const latestPointByBucket = new Map<number, TemperatureHistoryPoint>();

  history.forEach((point) => {
    const pointTime = new Date(point.timestamp).getTime();
    const bucket = Math.floor(pointTime / bucketSizeMs);
    latestPointByBucket.set(bucket, point);
  });

  return [...latestPointByBucket.values()].sort(
    (firstPoint, secondPoint) =>
      new Date(firstPoint.timestamp).getTime() -
      new Date(secondPoint.timestamp).getTime(),
  );
}

function getHourlyHistory(history: TemperatureHistoryPoint[]) {
  const hourlyBuckets = new Map<
    string,
    {
      bottomTempSum: number;
      count: number;
      timestamp: string;
      topTempSum: number;
    }
  >();

  history.forEach((point) => {
    const hourKey = getHourKey(point.timestamp);
    const bucket = hourlyBuckets.get(hourKey);

    if (!bucket) {
      hourlyBuckets.set(hourKey, {
        bottomTempSum: point.bottomTemp,
        count: 1,
        timestamp: point.timestamp,
        topTempSum: point.topTemp,
      });
      return;
    }

    bucket.bottomTempSum += point.bottomTemp;
    bucket.count += 1;
    bucket.topTempSum += point.topTemp;
  });

  return [...hourlyBuckets.entries()]
    .map(([hourKey, bucket]) => {
      const topTempAvg = roundTemperature(bucket.topTempSum / bucket.count);
      const bottomTempAvg = roundTemperature(
        bucket.bottomTempSum / bucket.count,
      );

      return {
        averageTempAvg: roundTemperature(
          calculateWeightedTemperature(topTempAvg, bottomTempAvg),
        ),
        bottomTempAvg,
        hourKey,
        hourLabel: `${formatWeekday(bucket.timestamp)} ${formatHour(
          bucket.timestamp,
        )}`,
        timestamp: bucket.timestamp,
        topTempAvg,
      };
    })
    .sort(
      (firstPoint, secondPoint) =>
        new Date(firstPoint.timestamp).getTime() -
        new Date(secondPoint.timestamp).getTime(),
    );
}

function getTopTemperature(
  point: TemperatureHistoryPoint | HourlyTemperatureHistoryPoint,
) {
  return "topTempAvg" in point ? point.topTempAvg : point.topTemp;
}

function getBottomTemperature(
  point: TemperatureHistoryPoint | HourlyTemperatureHistoryPoint,
) {
  return "bottomTempAvg" in point ? point.bottomTempAvg : point.bottomTemp;
}

function getAverageTemperature(
  point: TemperatureHistoryPoint | HourlyTemperatureHistoryPoint,
) {
  return "averageTempAvg" in point ? point.averageTempAvg : point.averageTemp;
}

function isHourlyHistoryPoint(
  point: TemperatureHistoryPoint | HourlyTemperatureHistoryPoint,
): point is HourlyTemperatureHistoryPoint {
  return "topTempAvg" in point;
}

function getPointBottom(temperature: number) {
  const ratio = Math.min(
    Math.max((temperature - chartMinTemp) / (chartMaxTemp - chartMinTemp), 0),
    1,
  );

  return ratio * chartHeight;
}

function getAdjustedPointBottoms(
  topTemperature: number,
  bottomTemperature: number,
) {
  const topBottom = getPointBottom(topTemperature);
  const bottomBottom = getPointBottom(bottomTemperature);

  if (Math.abs(topBottom - bottomBottom) > closePointOffset * 2) {
    return { bottomBottom, topBottom };
  }

  return {
    bottomBottom: Math.max(bottomBottom - closePointOffset, 0),
    topBottom: Math.min(topBottom + closePointOffset, chartHeight),
  };
}

function shouldShowXAxisLabel(
  index: number,
  historyLength: number,
) {
  if (historyLength <= 5) {
    return true;
  }

  const labelCount = 5;
  const interval = (historyLength - 1) / (labelCount - 1);

  return Array.from({ length: labelCount }).some(
    (_, labelIndex) => index === Math.round(labelIndex * interval),
  );
}

function getSevenDayXAxisLabels(
  history: (TemperatureHistoryPoint | HourlyTemperatureHistoryPoint)[],
) {
  const dayBuckets: {
    firstIndex: number;
    lastIndex: number;
    timestamp: string;
  }[] = [];
  const dayBucketByKey = new Map<string, (typeof dayBuckets)[number]>();

  history.forEach((point, index) => {
    const dayKey = dayKeyFormatter.format(new Date(point.timestamp));
    const bucket = dayBucketByKey.get(dayKey);

    if (!bucket) {
      const nextBucket = {
        firstIndex: index,
        lastIndex: index,
        timestamp: point.timestamp,
      };
      dayBucketByKey.set(dayKey, nextBucket);
      dayBuckets.push(nextBucket);
      return;
    }

    bucket.lastIndex = index;
  });

  const labels = new Map<number, XAxisLabel>();
  const labelCount = Math.min(dayBuckets.length, 4);

  Array.from({ length: labelCount }).forEach((_, labelIndex) => {
    const dayIndex =
      labelCount === 1
        ? 0
        : Math.round((labelIndex * (dayBuckets.length - 1)) / (labelCount - 1));
    const bucket = dayBuckets[dayIndex];
    const isFirstLabel = labelIndex === 0;
    const isLastLabel = labelIndex === labelCount - 1;
    const pointIndex = isFirstLabel
      ? bucket.firstIndex
      : isLastLabel
        ? bucket.lastIndex
        : Math.round((bucket.firstIndex + bucket.lastIndex) / 2);

    labels.set(pointIndex, {
      align: isFirstLabel ? "left" : isLastLabel ? "right" : "center",
      text: formatAxisDay(bucket.timestamp),
    });
  });

  return labels;
}

type ChartLineSegment = {
  angle: string;
  color: string;
  height: number;
  key: string;
  left: number;
  top: number;
  width: number;
};

function getChartLineSegments(
  history: (TemperatureHistoryPoint | HourlyTemperatureHistoryPoint)[],
  chartWidth: number,
) {
  if (history.length < 2 || chartWidth <= 0) {
    return [];
  }

  const columnWidth = chartWidth / history.length;
  const segments: ChartLineSegment[] = [];

  history.slice(0, -1).forEach((point, index) => {
    const nextPoint = history[index + 1];
    const currentTemps = getAdjustedPointBottoms(
      getTopTemperature(point),
      getBottomTemperature(point),
    );
    const nextTemps = getAdjustedPointBottoms(
      getTopTemperature(nextPoint),
      getBottomTemperature(nextPoint),
    );
    const currentAverageBottom = getPointBottom(getAverageTemperature(point));
    const nextAverageBottom = getPointBottom(getAverageTemperature(nextPoint));
    const currentX = columnWidth * index + columnWidth / 2;
    const nextX = columnWidth * (index + 1) + columnWidth / 2;

    [
      {
        color: topTemperatureColor,
        currentBottom: currentTemps.topBottom,
        keyPrefix: "top",
        nextBottom: nextTemps.topBottom,
      },
      {
        color: bottomTemperatureColor,
        currentBottom: currentTemps.bottomBottom,
        keyPrefix: "bottom",
        nextBottom: nextTemps.bottomBottom,
      },
      {
        color: averageTemperatureColor,
        currentBottom: currentAverageBottom,
        keyPrefix: "average",
        lineHeight: 1.5,
        nextBottom: nextAverageBottom,
      },
    ].forEach(
      ({ color, currentBottom, keyPrefix, lineHeight = 2, nextBottom }) => {
        const currentY = chartHeight - currentBottom;
        const nextY = chartHeight - nextBottom;
        const deltaX = nextX - currentX;
        const deltaY = nextY - currentY;
        const width = Math.hypot(deltaX, deltaY);
        const angle = `${Math.atan2(deltaY, deltaX)}rad`;

        segments.push({
          angle,
          color,
          height: lineHeight,
          key: `${keyPrefix}-${index}`,
          left: currentX,
          top: currentY,
          width,
        });
      },
    );
  });

  return segments;
}

export default function TemperatureHistoryScreen() {
  const router = useRouter();
  const mountedAtRef = useRef(getPerformanceNow());
  const initialTabRef = useRef<HistoryTab>("24h");
  const firstRenderLoggedRef = useRef(false);
  const firstContentLoggedRef = useRef(false);
  const fetchCountRef = useRef(0);
  const hasLoadedRef = useRef<Record<HistoryTab, boolean>>({
    "24h": temperatureHistoryLoaded["24h"],
    "7d": temperatureHistoryLoaded["7d"],
  });
  const inFlightRef = useRef<Record<HistoryTab, boolean>>({
    "24h": false,
    "7d": false,
  });
  const [selectedTab, setSelectedTab] = useState<HistoryTab>("24h");
  const [history24h, setHistory24h] = useState<TemperatureHistoryPoint[]>(
    temperatureHistoryCache["24h"],
  );
  const [history7d, setHistory7d] = useState<TemperatureHistoryPoint[]>(
    temperatureHistoryCache["7d"],
  );
  const [isInteractionComplete, setIsInteractionComplete] = useState(false);
  const [isLoading24h, setIsLoading24h] = useState(false);
  const [isLoading7d, setIsLoading7d] = useState(false);
  const [backgroundRefreshingTab, setBackgroundRefreshingTab] =
    useState<HistoryTab | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [selectedHistoryPoint, setSelectedHistoryPoint] =
    useState<SelectedHistoryPoint | null>(null);

  const loadHistoryTab = useCallback(async (tab: HistoryTab, force = false) => {
    if (inFlightRef.current[tab]) {
      return;
    }
    if (!force && hasLoadedRef.current[tab]) {
      return;
    }

    inFlightRef.current[tab] = true;
    fetchCountRef.current += 1;
    const viewLoadStartedAt = getPerformanceNow();
    const rangeStart =
      tab === "24h"
        ? getHistoryRangeStart(24 * 60 * 60 * 1000)
        : getHistoryRangeStart(7 * 24 * 60 * 60 * 1000);
    const bucketMinutes = tab === "24h" ? 10 : 60;
    const mode = tab === "24h" ? "latest" : "average";
    const hasCachedData = hasLoadedRef.current[tab];

    logTemperatureHistoryPerformance(tab, "query started", {
      fetchCount: fetchCountRef.current,
      force,
      hasCachedData,
    });

    if (hasCachedData) {
      setBackgroundRefreshingTab(tab);
    } else if (tab === "24h") {
      setIsLoading24h(true);
    } else {
      setIsLoading7d(true);
    }

    try {
      const nextHistory = await fetchTemperatureHistoryPoints(
        rangeStart,
        tab,
        bucketMinutes,
        mode,
      );

      if (tab === "24h") {
        temperatureHistoryCache["24h"] = nextHistory;
        setHistory24h(nextHistory);
      } else {
        temperatureHistoryCache["7d"] = nextHistory;
        setHistory7d(nextHistory);
      }
      hasLoadedRef.current[tab] = true;
      temperatureHistoryLoaded[tab] = true;

      logTemperatureHistoryPerformance(tab, "query completed", {
        durationMs: getPerformanceNow() - viewLoadStartedAt,
        fetchCount: fetchCountRef.current,
        rowCount: nextHistory.length,
      });
      logTemperatureHistoryPerformance(tab, "view load", {
        durationMs: getPerformanceNow() - viewLoadStartedAt,
        rowCount: nextHistory.length,
      });
    } catch (error) {
      console.warn(
        "Lämpöhistorian haku epäonnistui",
        error instanceof Error ? error.message : error,
      );
    } finally {
      inFlightRef.current[tab] = false;
      setBackgroundRefreshingTab((currentTab) =>
        currentTab === tab ? null : currentTab,
      );
      if (tab === "24h") {
        setIsLoading24h(false);
      } else {
        setIsLoading7d(false);
      }
    }
  }, []);

  useEffect(() => {
    logTemperatureHistoryPerformance(initialTabRef.current, "navigation mounted", {
      fetchCount: fetchCountRef.current,
    });
  }, []);

  useEffect(() => {
    if (firstRenderLoggedRef.current) {
      return;
    }
    firstRenderLoggedRef.current = true;
    const elapsedMs = getPerformanceNow() - mountedAtRef.current;

    logTemperatureHistoryPerformance(initialTabRef.current, "first render", {
      durationMs: elapsedMs,
      estimatedElementCount: 18,
      targetUnderMs: 100,
    });
    logTemperatureHistoryPerformance(initialTabRef.current, "first content visible", {
      durationMs: elapsedMs,
      estimatedElementCount: 18,
      targetUnderMs: 100,
    });
    firstContentLoggedRef.current = true;
  }, []);

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setIsInteractionComplete(true);
      logTemperatureHistoryPerformance(
        initialTabRef.current,
        "interaction completed",
        {
          durationMs: getPerformanceNow() - mountedAtRef.current,
        },
      );
      void loadHistoryTab(selectedTab);
    });

    return () => task.cancel();
  }, [loadHistoryTab, selectedTab]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      void loadHistoryTab(selectedTab, true);
    }, 60 * 1000);

    return () => clearInterval(intervalId);
  }, [loadHistoryTab, selectedTab]);

  useEffect(() => {
    if (selectedTab === "7d") {
      setSelectedHistoryPoint(null);
    }

    return () => setSelectedHistoryPoint(null);
  }, [selectedTab]);

  useEffect(() => {
    debugLog("history loaded", {
      h24: history24h.length,
      d7: history7d.length,
      first24h: history24h[0]?.timestamp,
      latest24h: history24h.at(-1)?.timestamp,
      first7d: history7d[0]?.timestamp,
      latest7d: history7d.at(-1)?.timestamp,
    });
  }, [history24h, history7d]);

  const visibleHistory = useMemo(() => {
    const trendStartedAt = getPerformanceNow();
    const sourceHistory = selectedTab === "24h" ? history24h : history7d;
    const nextVisibleHistory = isInteractionComplete
      ? getVisibleHistory(sourceHistory, selectedTab)
      : [];

    logTemperatureHistoryPerformance(selectedTab, "trend data build", {
      durationMs: getPerformanceNow() - trendStartedAt,
      sourceRowCount: sourceHistory.length,
      visibleRowCount: nextVisibleHistory.length,
    });

    return nextVisibleHistory;
  }, [history24h, history7d, isInteractionComplete, selectedTab]);
  const latestPoint = visibleHistory[visibleHistory.length - 1];
  const chartScale = useMemo(() => [70, 60, 50, 40, 30, 20, 10], []);
  const isSevenDayView = selectedTab === "7d";
  const isSelectedTabLoading =
    (selectedTab === "24h" ? isLoading24h : isLoading7d) ||
    backgroundRefreshingTab === selectedTab;
  const selectedTooltipLeft = selectedHistoryPoint
    ? Math.min(
        Math.max(selectedHistoryPoint.x - tooltipWidth / 2, 0),
        Math.max(chartWidth - tooltipWidth, 0),
      )
    : 0;
  const lineSegments = useMemo(
    () => getChartLineSegments(visibleHistory, chartWidth),
    [chartWidth, visibleHistory],
  );
  const sevenDayXAxisLabels = useMemo(
    () => (isSevenDayView ? getSevenDayXAxisLabels(visibleHistory) : null),
    [isSevenDayView, visibleHistory],
  );

  const updateSelectedHistoryPoint = useCallback(
    (event: GestureResponderEvent) => {
      if (chartWidth <= 0) {
        return;
      }

      const chartData = visibleHistory;

      if (chartData.length === 0) {
        setSelectedHistoryPoint(null);
        return;
      }

      const touchX = Math.min(
        Math.max(event.nativeEvent.locationX, 0),
        chartWidth,
      );
      const columnWidth = chartWidth / chartData.length;
      const nearestIndex = Math.min(
        Math.max(Math.round((touchX - columnWidth / 2) / columnWidth), 0),
        chartData.length - 1,
      );

      setSelectedHistoryPoint({
        index: nearestIndex,
        point: chartData[nearestIndex],
        x: columnWidth * nearestIndex + columnWidth / 2,
      });
    },
    [chartWidth, visibleHistory],
  );

  return (
    <View style={styles.screen}>
      <View style={[styles.glow, styles.greenGlow]} />
      <View style={[styles.glow, styles.blueGlow]} />

      <Pressable
        accessibilityLabel="Palaa etusivulle"
        accessibilityRole="button"
        onPress={() => router.back()}
        style={styles.backButton}
      >
        <Text style={styles.backButtonText}>←</Text>
      </Pressable>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>📈 Lämpöhistoria</Text>
          <Text style={styles.subtitle}>Varaajan ylä- ja ala-anturi</Text>
        </View>

        <View style={styles.tabSelector}>
          {(["24h", "7d"] as const).map((tab) => {
            const isActive = selectedTab === tab;

            return (
              <Pressable
                accessibilityLabel={`Näytä ${tab === "24h" ? "24 tunnin" : "7 vuorokauden"} lämpöhistoria`}
                accessibilityRole="button"
                key={tab}
                onPress={() => setSelectedTab(tab)}
                style={[styles.tabButton, isActive && styles.activeTabButton]}
              >
                <Text
                  style={[styles.tabText, isActive && styles.activeTabText]}
                >
                  {tab === "24h" ? "24 h" : "7 vrk"}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {isSelectedTabLoading ? (
          <View style={styles.tabLoader}>
            <ActivityIndicator color="#36f4d4" size="small" />
            <Text style={styles.tabLoaderText}>
              {backgroundRefreshingTab === selectedTab
                ? "Päivitetään..."
                : `Ladataan ${selectedTab === "24h" ? "24 h" : "7 vrk"} historiaa...`}
            </Text>
          </View>
        ) : null}

        {!isInteractionComplete ? (
          <View style={styles.placeholderCard}>
            <Text style={styles.placeholderText}>Lämpöhistoria valmistuu...</Text>
          </View>
        ) : (
        <View style={styles.historyCard}>
          <View style={styles.summaryRow}>
            <View style={styles.summaryPill}>
              <Text numberOfLines={1} style={styles.summaryLabel}>
                Ylä °C
              </Text>
              <Text style={styles.topSummaryValue}>
                {latestPoint
                  ? roundTemperature(getTopTemperature(latestPoint)).toFixed(1)
                  : "--"}
              </Text>
            </View>
            <View style={styles.summaryPill}>
              <Text numberOfLines={1} style={styles.summaryLabel}>
                70/30 °C
              </Text>
              <Text style={styles.averageSummaryValue}>
                {latestPoint
                  ? roundTemperature(
                      calculateWeightedTemperature(
                        getTopTemperature(latestPoint),
                        getBottomTemperature(latestPoint),
                      ),
                    ).toFixed(1)
                  : "--"}
              </Text>
            </View>
            <View style={styles.summaryPill}>
              <Text numberOfLines={1} style={styles.summaryLabel}>
                Ala °C
              </Text>
              <Text style={styles.bottomSummaryValue}>
                {latestPoint
                  ? roundTemperature(getBottomTemperature(latestPoint)).toFixed(
                      1,
                    )
                  : "--"}
              </Text>
            </View>
          </View>

          <View style={styles.legendRow}>
            <Text style={styles.legendTop}>
              Ylä
            </Text>
            <Text style={styles.legendAverage}>
              70/30
            </Text>
            <Text style={styles.legendBottom}>
              Ala
            </Text>
          </View>

          {visibleHistory.length === 0 ? (
            <Text style={styles.emptyHistoryText}>
              Ei vielä lämpöhistoriaa.
            </Text>
          ) : (
            <>
              <View style={styles.chartRow}>
                <View style={styles.scaleColumn}>
                  {chartScale.map((value) => (
                    <Text key={value} style={styles.scaleText}>
                      {value}°
                    </Text>
                  ))}
                </View>

                <View
                  onLayout={(event) =>
                    setChartWidth(event.nativeEvent.layout.width)
                  }
                  onMoveShouldSetResponder={() => true}
                  onResponderGrant={updateSelectedHistoryPoint}
                  onResponderMove={updateSelectedHistoryPoint}
                  onStartShouldSetResponder={() => true}
                  style={styles.chartArea}
                >
                  {chartScale.map((value) => (
                    <View
                      key={value}
                      style={[
                        styles.gridLine,
                        { bottom: getPointBottom(value) },
                      ]}
                    />
                  ))}

                  {lineSegments.map((segment) => (
                    <View
                      key={segment.key}
                      style={[
                        styles.chartLine,
                        {
                          backgroundColor: segment.color,
                          height: segment.height,
                          left: segment.left,
                          top: segment.top,
                          transform: [{ rotateZ: segment.angle }],
                          width: segment.width,
                        },
                      ]}
                    />
                  ))}

                  {selectedHistoryPoint ? (
                    <>
                      <View
                        pointerEvents="none"
                        style={[
                          styles.selectedMarkerLine,
                          { left: selectedHistoryPoint.x },
                        ]}
                      />
                      <View
                        pointerEvents="none"
                        style={[
                          styles.historyTooltip,
                          { left: selectedTooltipLeft },
                        ]}
                      >
                        <Text style={styles.historyTooltipTime}>
                          {isSevenDayView
                            ? formatTooltipDateTime(
                                selectedHistoryPoint.point.timestamp,
                              )
                            : formatTooltipTime(
                                selectedHistoryPoint.point.timestamp,
                              )}
                        </Text>
                        <Text style={styles.historyTooltipTop}>
                          Ylä{" "}
                          {roundTemperature(
                            getTopTemperature(selectedHistoryPoint.point),
                          ).toFixed(1)}{" "}
                          °C
                        </Text>
                        <Text style={styles.historyTooltipBottom}>
                          Ala{" "}
                          {roundTemperature(
                            getBottomTemperature(selectedHistoryPoint.point),
                          ).toFixed(1)}{" "}
                          °C
                        </Text>
                        <Text style={styles.historyTooltipAverage}>
                          70/30{" "}
                          {roundTemperature(
                            getAverageTemperature(selectedHistoryPoint.point),
                          ).toFixed(1)}{" "}
                          °C
                        </Text>
                      </View>
                    </>
                  ) : null}

                  <View style={styles.historyColumns}>
                    {visibleHistory.map((point, index) => {
                      const topTemperature = getTopTemperature(point);
                      const bottomTemperature = getBottomTemperature(point);
                      const averageTemperature = getAverageTemperature(point);
                      const defaultXAxisLabel = isHourlyHistoryPoint(point)
                        ? point.hourLabel
                        : formatHour(point.timestamp);
                      const sevenDayXAxisLabel =
                        sevenDayXAxisLabels?.get(index);
                      const xAxisLabel =
                        sevenDayXAxisLabel?.text ?? defaultXAxisLabel;
                      const { bottomBottom, topBottom } =
                        getAdjustedPointBottoms(
                          topTemperature,
                          bottomTemperature,
                        );

                      return (
                        <View
                          accessibilityLabel={`${xAxisLabel}, yläanturi ${topTemperature} astetta, ala-anturi ${bottomTemperature} astetta, painotettu lämpö ${averageTemperature} astetta`}
                          key={
                            isHourlyHistoryPoint(point)
                              ? point.hourKey
                              : point.timestamp
                          }
                          style={styles.historyColumn}
                        >
                          <View
                            style={[
                              styles.tempDot,
                              styles.topTempDot,
                              { bottom: topBottom },
                            ]}
                          />
                          <View
                            style={[
                              styles.tempDot,
                              styles.bottomTempDot,
                              { bottom: bottomBottom },
                            ]}
                          />
                          <View
                            style={[
                              styles.tempDot,
                              styles.averageTempDot,
                              { bottom: getPointBottom(averageTemperature) },
                            ]}
                          />
                          {(isSevenDayView
                            ? sevenDayXAxisLabel
                            : shouldShowXAxisLabel(
                                index,
                                visibleHistory.length,
                              )) ? (
                            <Text
                              style={[
                                styles.hourLabel,
                                sevenDayXAxisLabel?.align === "left" &&
                                  styles.hourLabelLeft,
                                sevenDayXAxisLabel?.align === "right" &&
                                  styles.hourLabelRight,
                              ]}
                            >
                              {xAxisLabel}
                            </Text>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                </View>
              </View>
            </>
          )}
        </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#050816", overflow: "hidden" },
  content: {
    alignItems: "center",
    flexGrow: 1,
    paddingBottom: 32,
    paddingHorizontal: 20,
    paddingTop: 72,
  },
  glow: {
    borderRadius: 999,
    height: 280,
    opacity: 0.24,
    position: "absolute",
    shadowOpacity: 0.5,
    shadowRadius: 72,
    width: 280,
  },
  greenGlow: { backgroundColor: "#54eaa0", right: -150, top: 80 },
  blueGlow: { backgroundColor: "#5aa7ff", bottom: 70, left: -170 },
  backButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.18)",
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    left: 18,
    position: "absolute",
    top: 48,
    width: 44,
    zIndex: 20,
  },
  backButtonText: {
    color: "#f7fbff",
    fontSize: 26,
    fontWeight: "900",
    lineHeight: 30,
  },
  header: { alignItems: "center", marginBottom: 18 },
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
  tabSelector: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    marginBottom: 16,
    padding: 5,
    width: "100%",
  },
  tabButton: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 10,
  },
  activeTabButton: {
    backgroundColor: "rgba(54,244,212,0.18)",
    borderColor: "rgba(191,255,238,0.38)",
    shadowColor: "#36f4d4",
    shadowOpacity: 0.28,
    shadowRadius: 12,
  },
  tabText: { color: "#8ea4cf", fontSize: 14, fontWeight: "900" },
  activeTabText: { color: "#f8fbff" },
  tabLoader: {
    alignItems: "center",
    backgroundColor: "rgba(54,244,212,0.1)",
    borderColor: "rgba(54,244,212,0.24)",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    width: "100%",
  },
  tabLoaderText: { color: "#cfe9ff", fontSize: 13, fontWeight: "800" },
  historyCard: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 24,
    borderWidth: 1,
    padding: 16,
    width: "100%",
  },
  summaryRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
  summaryPill: {
    backgroundColor: "rgba(5,8,22,0.46)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  summaryLabel: {
    color: "#b9d7ff",
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "900",
  },
  topSummaryValue: {
    color: topTemperatureColor,
    fontSize: 29,
    fontWeight: "900",
    marginTop: 3,
  },
  averageSummaryValue: {
    color: averageTemperatureColor,
    fontSize: 29,
    fontWeight: "900",
    marginTop: 3,
  },
  bottomSummaryValue: {
    color: bottomTemperatureColor,
    fontSize: 29,
    fontWeight: "900",
    marginTop: 3,
  },
  legendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 16,
  },
  legendTop: { color: topTemperatureColor, fontSize: 12, fontWeight: "900" },
  legendBottom: { color: bottomTemperatureColor, fontSize: 12, fontWeight: "900" },
  legendAverage: { color: averageTemperatureColor, fontSize: 12, fontWeight: "900" },
  emptyHistoryText: {
    color: "#cfe9ff",
    fontSize: 15,
    fontWeight: "900",
    paddingVertical: 48,
    textAlign: "center",
  },
  chartRow: { flexDirection: "row", gap: 8 },
  scaleColumn: {
    height: chartHeight,
    justifyContent: "space-between",
    width: 32,
  },
  scaleText: {
    color: "rgba(207,233,255,0.52)",
    fontSize: 10,
    fontWeight: "800",
    textAlign: "right",
  },
  chartArea: { flex: 1, height: chartHeight + 58, position: "relative" },
  gridLine: {
    backgroundColor: "rgba(207,233,255,0.1)",
    height: 1,
    left: 0,
    position: "absolute",
    right: 0,
  },
  chartLine: {
    borderRadius: 999,
    opacity: 0.78,
    position: "absolute",
    transformOrigin: "left center",
    zIndex: 1,
  },
  historyColumns: { flexDirection: "row", height: chartHeight + 58 },
  historyColumn: {
    flex: 1,
    height: chartHeight,
    justifyContent: "flex-end",
    overflow: "visible",
    position: "relative",
  },
  tempDot: {
    borderRadius: 999,
    height: 7,
    left: "50%",
    marginBottom: -3.5,
    marginLeft: -3.5,
    position: "absolute",
    width: 7,
    zIndex: 2,
  },
  topTempDot: {
    backgroundColor: topTemperatureColor,
    shadowColor: topTemperatureColor,
    shadowOpacity: 0.7,
    shadowRadius: 8,
  },
  bottomTempDot: {
    backgroundColor: bottomTemperatureColor,
    shadowColor: bottomTemperatureColor,
    shadowOpacity: 0.7,
    shadowRadius: 8,
  },
  averageTempDot: {
    backgroundColor: averageTemperatureColor,
    shadowColor: averageTemperatureColor,
    shadowOpacity: 0.7,
    shadowRadius: 8,
  },
  selectedMarkerLine: {
    backgroundColor: "rgba(247,251,255,0.38)",
    bottom: 58,
    height: chartHeight,
    position: "absolute",
    width: 1,
    zIndex: 4,
  },
  historyTooltip: {
    backgroundColor: "rgba(5,8,22,0.92)",
    borderColor: "rgba(255,255,255,0.18)",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    bottom: tooltipBottomOffset,
    position: "absolute",
    width: tooltipWidth,
    zIndex: 5,
  },
  historyTooltipTime: {
    color: "#f7fbff",
    fontSize: 12,
    fontWeight: "900",
    marginBottom: 4,
  },
  historyTooltipTop: { color: topTemperatureColor, fontSize: 11, fontWeight: "900" },
  historyTooltipBottom: {
    color: bottomTemperatureColor,
    fontSize: 11,
    fontWeight: "900",
    marginTop: 2,
  },
  historyTooltipAverage: {
    color: averageTemperatureColor,
    fontSize: 11,
    fontWeight: "900",
    marginTop: 2,
  },
  hourLabel: {
    bottom: -52,
    color: "#8190b5",
    fontSize: 9,
    fontWeight: "800",
    left: -32,
    position: "absolute",
    textAlign: "center",
    width: 64,
  },
  hourLabelLeft: {
    left: 0,
    textAlign: "left",
  },
  hourLabelRight: {
    left: -64,
    textAlign: "right",
  },
  placeholderCard: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 24,
    borderWidth: 1,
    minHeight: 220,
    justifyContent: "center",
    padding: 24,
    width: "100%",
  },
  placeholderIcon: { fontSize: 38, marginBottom: 12 },
  placeholderText: {
    color: "#cfe9ff",
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
  },
});

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GestureResponderEvent,
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
  point: TemperatureHistoryPoint | DailyTemperatureHistoryPoint;
  x: number;
};

type DailyTemperatureHistoryPoint = {
  timestamp: string;
  dayKey: string;
  dayLabel: string;
  topTempAvg: number;
  bottomTempAvg: number;
  averageTempAvg: number;
};

type TankReadingRow = {
  created_at?: string | null;
  top_temp?: number | null;
  bottom_temp?: number | null;
};

const chartHeight = 190;
const chartMinTemp = defaultSettings.minTankTemperature;
const chartMaxTemp = 70;
const closePointOffset = 2;
const tooltipWidth = 116;
const topTemperatureColor = "#FF8A4C";
const averageTemperatureColor = "#2DD4BF";
const bottomTemperatureColor = "#60A5FA";
const tooltipBottomOffset = 28;

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

const dayKeyFormatter = new Intl.DateTimeFormat("sv-SE", {
  day: "2-digit",
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

function formatWeekday(timestamp: string) {
  const weekday = weekdayFormatter.format(new Date(timestamp)).replace(".", "");

  return weekday.charAt(0).toUpperCase() + weekday.slice(1);
}

function roundTemperature(value: number) {
  return Math.round(value * 10) / 10;
}

function calculateAverageTemperature(topTemp: number, bottomTemp: number) {
  return (topTemp + bottomTemp) / 2;
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
    averageTemp: calculateAverageTemperature(
      reading.top_temp,
      reading.bottom_temp,
    ),
    bottomTemp: reading.bottom_temp,
    timestamp: reading.created_at,
    topTemp: reading.top_temp,
  };
}

async function fetchTankReadingsSince(startIso: string, maxRows: number) {
  const pageSize = 1000;
  const selectColumns = "created_at, top_temp, bottom_temp";
  const rows: TankReadingRow[] = [];

  while (rows.length < maxRows) {
    const from = rows.length;
    const to = Math.min(from + pageSize, maxRows) - 1;
    const { data, error } = await supabase
      .from("tank_readings")
      .select(selectColumns)
      .gte("created_at", startIso)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) {
      throw error;
    }

    const pageRows = (data ?? []) as TankReadingRow[];
    rows.push(...pageRows);

    if (pageRows.length < pageSize) {
      break;
    }
  }

  return sortHistoryByCreatedAtAscending(
    rows
      .map(mapTankReadingToHistoryPoint)
      .filter((point): point is TemperatureHistoryPoint => point !== null),
  );
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

  return getDailyHistory(history);
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

function getDailyHistory(history: TemperatureHistoryPoint[]) {
  const dailyBuckets = new Map<
    string,
    {
      averageTempSum: number;
      bottomTempSum: number;
      count: number;
      timestamp: string;
      topTempSum: number;
    }
  >();

  history.forEach((point) => {
    const dayKey = dayKeyFormatter.format(new Date(point.timestamp));
    const bucket = dailyBuckets.get(dayKey);

    if (!bucket) {
      dailyBuckets.set(dayKey, {
        averageTempSum: point.averageTemp,
        bottomTempSum: point.bottomTemp,
        count: 1,
        timestamp: point.timestamp,
        topTempSum: point.topTemp,
      });
      return;
    }

    bucket.averageTempSum += point.averageTemp;
    bucket.bottomTempSum += point.bottomTemp;
    bucket.count += 1;
    bucket.topTempSum += point.topTemp;
  });

  return [...dailyBuckets.entries()]
    .map(([dayKey, bucket]) => ({
      averageTempAvg: roundTemperature(bucket.averageTempSum / bucket.count),
      bottomTempAvg: roundTemperature(bucket.bottomTempSum / bucket.count),
      dayKey,
      dayLabel: formatWeekday(bucket.timestamp),
      timestamp: bucket.timestamp,
      topTempAvg: roundTemperature(bucket.topTempSum / bucket.count),
    }))
    .sort(
      (firstPoint, secondPoint) =>
        new Date(firstPoint.timestamp).getTime() -
        new Date(secondPoint.timestamp).getTime(),
    );
}

function getTopTemperature(
  point: TemperatureHistoryPoint | DailyTemperatureHistoryPoint,
) {
  return "topTempAvg" in point ? point.topTempAvg : point.topTemp;
}

function getBottomTemperature(
  point: TemperatureHistoryPoint | DailyTemperatureHistoryPoint,
) {
  return "bottomTempAvg" in point ? point.bottomTempAvg : point.bottomTemp;
}

function getAverageTemperature(
  point: TemperatureHistoryPoint | DailyTemperatureHistoryPoint,
) {
  return "averageTempAvg" in point ? point.averageTempAvg : point.averageTemp;
}

function isDailyHistoryPoint(
  point: TemperatureHistoryPoint | DailyTemperatureHistoryPoint,
): point is DailyTemperatureHistoryPoint {
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
  isDailyView: boolean,
) {
  if (isDailyView || historyLength <= 5) {
    return true;
  }

  const labelCount = 5;
  const interval = (historyLength - 1) / (labelCount - 1);

  return Array.from({ length: labelCount }).some(
    (_, labelIndex) => index === Math.round(labelIndex * interval),
  );
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
  history: (TemperatureHistoryPoint | DailyTemperatureHistoryPoint)[],
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
  const [selectedTab, setSelectedTab] = useState<HistoryTab>("24h");
  const [history24h, setHistory24h] = useState<TemperatureHistoryPoint[]>([]);
  const [history7d, setHistory7d] = useState<TemperatureHistoryPoint[]>([]);
  const [chartWidth, setChartWidth] = useState(0);
  const [selectedHistoryPoint, setSelectedHistoryPoint] =
    useState<SelectedHistoryPoint | null>(null);

  const loadHistory = useCallback(async () => {
    const h24Start = getHistoryRangeStart(24 * 60 * 60 * 1000);
    const d7Start = getHistoryRangeStart(7 * 24 * 60 * 60 * 1000);

    try {
      const next24h = await fetchTankReadingsSince(h24Start, 2000);
      const next7d = await fetchTankReadingsSince(d7Start, 10000);

      setHistory24h(next24h);
      setHistory7d(next7d);
    } catch (error) {
      console.warn(
        "Lämpöhistorian haku epäonnistui",
        error instanceof Error ? error.message : error,
      );
      setHistory24h([]);
      setHistory7d([]);
    }
  }, []);

  useEffect(() => {
    void loadHistory();

    const intervalId = setInterval(() => {
      void loadHistory();
    }, 60 * 1000);

    return () => clearInterval(intervalId);
  }, [loadHistory, selectedTab]);

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

  const visibleHistory = useMemo(
    () =>
      selectedTab === "24h"
        ? getVisibleHistory(history24h, selectedTab)
        : getVisibleHistory(history7d, selectedTab),
    [history24h, history7d, selectedTab],
  );
  const latestPoint = visibleHistory[visibleHistory.length - 1];
  const chartScale = useMemo(() => [70, 60, 50, 40, 30, 20, 10], []);
  const isDailyView = selectedTab === "7d";
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
                Keski °C
              </Text>
              <Text style={styles.averageSummaryValue}>
                {latestPoint
                  ? roundTemperature(
                      calculateAverageTemperature(
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
              ● Yläanturi {isDailyView ? "keskiarvo" : ""}
            </Text>
            <Text style={styles.legendBottom}>
              ● Ala-anturi {isDailyView ? "keskiarvo" : ""}
            </Text>
            <Text style={styles.legendAverage}>
              ● Keskilämpö {isDailyView ? "keskiarvo" : ""}
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
                          {formatTooltipTime(
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
                          Keski{" "}
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
                      const xAxisLabel = isDailyHistoryPoint(point)
                        ? point.dayLabel
                        : formatHour(point.timestamp);
                      const { bottomBottom, topBottom } =
                        getAdjustedPointBottoms(
                          topTemperature,
                          bottomTemperature,
                        );

                      return (
                        <View
                          accessibilityLabel={`${xAxisLabel}, yläanturi ${topTemperature} astetta, ala-anturi ${bottomTemperature} astetta, keskilämpö ${averageTemperature} astetta`}
                          key={
                            isDailyHistoryPoint(point)
                              ? point.dayKey
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
                          {shouldShowXAxisLabel(
                            index,
                            visibleHistory.length,
                            isDailyView,
                          ) ? (
                            <Text style={styles.hourLabel}>{xAxisLabel}</Text>
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
    left: -14,
    position: "absolute",
    textAlign: "center",
    width: 36,
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

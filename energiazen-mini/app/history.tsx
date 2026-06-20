import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { defaultSettings } from "@/lib/settings";
import { supabase } from "@/lib/supabase";

type HistoryTab = "24h" | "7d";

type TemperatureHistoryPoint = {
  timestamp: string;
  topTemp: number;
  bottomTemp: number;
};

type DailyTemperatureHistoryPoint = {
  timestamp: string;
  dayKey: string;
  dayLabel: string;
  topTempAvg: number;
  bottomTempAvg: number;
  topTempMax: number;
  topTempMin: number;
  bottomTempMax: number;
  bottomTempMin: number;
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

const timeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
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

function formatWeekday(timestamp: string) {
  const weekday = weekdayFormatter
    .format(new Date(timestamp))
    .replace(".", "");

  return weekday.charAt(0).toUpperCase() + weekday.slice(1);
}

function roundTemperature(value: number) {
  return Math.round(value * 10) / 10;
}

function getHistoryRangeStart(rangeMs: number) {
  return new Date(Date.now() - rangeMs).toISOString();
}

function sortHistoryByCreatedAtAscending(
  history: TemperatureHistoryPoint[],
) {
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
    bottomTemp: reading.bottom_temp,
    timestamp: reading.created_at,
    topTemp: reading.top_temp,
  };
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
      bottomTempMax: number;
      bottomTempMin: number;
      bottomTempSum: number;
      count: number;
      timestamp: string;
      topTempMax: number;
      topTempMin: number;
      topTempSum: number;
    }
  >();

  history.forEach((point) => {
    const dayKey = dayKeyFormatter.format(new Date(point.timestamp));
    const bucket = dailyBuckets.get(dayKey);

    if (!bucket) {
      dailyBuckets.set(dayKey, {
        bottomTempMax: point.bottomTemp,
        bottomTempMin: point.bottomTemp,
        bottomTempSum: point.bottomTemp,
        count: 1,
        timestamp: point.timestamp,
        topTempMax: point.topTemp,
        topTempMin: point.topTemp,
        topTempSum: point.topTemp,
      });
      return;
    }

    bucket.bottomTempMax = Math.max(bucket.bottomTempMax, point.bottomTemp);
    bucket.bottomTempMin = Math.min(bucket.bottomTempMin, point.bottomTemp);
    bucket.bottomTempSum += point.bottomTemp;
    bucket.count += 1;
    bucket.topTempMax = Math.max(bucket.topTempMax, point.topTemp);
    bucket.topTempMin = Math.min(bucket.topTempMin, point.topTemp);
    bucket.topTempSum += point.topTemp;
  });

  return [...dailyBuckets.entries()]
    .map(([dayKey, bucket]) => ({
      bottomTempAvg: roundTemperature(bucket.bottomTempSum / bucket.count),
      bottomTempMax: bucket.bottomTempMax,
      bottomTempMin: bucket.bottomTempMin,
      dayKey,
      dayLabel: formatWeekday(bucket.timestamp),
      timestamp: bucket.timestamp,
      topTempAvg: roundTemperature(bucket.topTempSum / bucket.count),
      topTempMax: bucket.topTempMax,
      topTempMin: bucket.topTempMin,
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
    const currentX = columnWidth * index + columnWidth / 2;
    const nextX = columnWidth * (index + 1) + columnWidth / 2;

    [
      {
        color: "#ffad4d",
        currentBottom: currentTemps.topBottom,
        keyPrefix: "top",
        nextBottom: nextTemps.topBottom,
      },
      {
        color: "#36f4d4",
        currentBottom: currentTemps.bottomBottom,
        keyPrefix: "bottom",
        nextBottom: nextTemps.bottomBottom,
      },
    ].forEach(({ color, currentBottom, keyPrefix, nextBottom }) => {
      const currentY = chartHeight - currentBottom;
      const nextY = chartHeight - nextBottom;
      const deltaX = nextX - currentX;
      const deltaY = nextY - currentY;
      const width = Math.hypot(deltaX, deltaY);
      const angle = `${Math.atan2(deltaY, deltaX)}rad`;

      segments.push({
        angle,
        color,
        key: `${keyPrefix}-${index}`,
        left: currentX,
        top: currentY,
        width,
      });
    });
  });

  return segments;
}

export default function TemperatureHistoryScreen() {
  const router = useRouter();
  const [selectedTab, setSelectedTab] = useState<HistoryTab>("24h");
  const [history24h, setHistory24h] = useState<TemperatureHistoryPoint[]>([]);
  const [history7d, setHistory7d] = useState<TemperatureHistoryPoint[]>([]);
  const [chartWidth, setChartWidth] = useState(0);

  const loadHistory = useCallback(async () => {
    const selectColumns = "created_at, top_temp, bottom_temp";
    const h24Start = getHistoryRangeStart(24 * 60 * 60 * 1000);
    const d7Start = getHistoryRangeStart(7 * 24 * 60 * 60 * 1000);

    const [h24Result, d7Result] = await Promise.all([
      supabase
        .from("tank_readings")
        .select(selectColumns)
        .gte("created_at", h24Start)
        .order("created_at", { ascending: false })
        .limit(2000),
      supabase
        .from("tank_readings")
        .select(selectColumns)
        .gte("created_at", d7Start)
        .order("created_at", { ascending: false })
        .limit(10000),
    ]);

    if (h24Result.error || d7Result.error) {
      console.warn(
        "Lämpöhistorian haku epäonnistui",
        h24Result.error?.message ?? d7Result.error?.message,
      );
      setHistory24h([]);
      setHistory7d([]);
      return;
    }

    const mapRows = (data: TankReadingRow[] | null) =>
      sortHistoryByCreatedAtAscending(
        (data ?? [])
          .map(mapTankReadingToHistoryPoint)
          .filter((point): point is TemperatureHistoryPoint => point !== null),
      );

    setHistory24h(mapRows(h24Result.data as TankReadingRow[] | null));
    setHistory7d(mapRows(d7Result.data as TankReadingRow[] | null));
  }, []);

  useEffect(() => {
    void loadHistory();

    const intervalId = setInterval(() => {
      void loadHistory();
    }, 60 * 1000);

    return () => clearInterval(intervalId);
  }, [loadHistory, selectedTab]);

  useEffect(() => {
    console.log("history loaded", {
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
  const lineSegments = useMemo(
    () => getChartLineSegments(visibleHistory, chartWidth),
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
                {latestPoint ? getTopTemperature(latestPoint) : "--"}
              </Text>
            </View>
            <View style={styles.summaryPill}>
              <Text numberOfLines={1} style={styles.summaryLabel}>
                Ala °C
              </Text>
              <Text style={styles.bottomSummaryValue}>
                {latestPoint ? getBottomTemperature(latestPoint) : "--"}
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
                          left: segment.left,
                          top: segment.top,
                          transform: [{ rotateZ: segment.angle }],
                          width: segment.width,
                        },
                      ]}
                    />
                  ))}

                  <View style={styles.historyColumns}>
                    {visibleHistory.map((point, index) => {
                      const topTemperature = getTopTemperature(point);
                      const bottomTemperature = getBottomTemperature(point);
                      const xAxisLabel = isDailyHistoryPoint(point)
                        ? point.dayLabel
                        : formatHour(point.timestamp);
                      const { bottomBottom, topBottom } = getAdjustedPointBottoms(
                        topTemperature,
                        bottomTemperature,
                      );

                      return (
                        <View
                          accessibilityLabel={`${xAxisLabel}, yläanturi ${topTemperature} astetta, ala-anturi ${bottomTemperature} astetta`}
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

              {isDailyView ? (
                <View style={styles.dailyDetailsGrid}>
                  {visibleHistory.filter(isDailyHistoryPoint).map((point) => (
                    <View
                      key={`${point.dayKey}-details`}
                      style={styles.dailyDetailCard}
                    >
                      <Text style={styles.dailyDetailDay}>
                        {point.dayLabel}
                      </Text>
                      <Text style={styles.dailyDetailLine}>
                        ▲ ylä {point.topTempMax}° / ▼ ylä {point.topTempMin}°
                      </Text>
                      <Text style={styles.dailyDetailLine}>
                        ▲ ala {point.bottomTempMax}° / ▼ ala{" "}
                        {point.bottomTempMin}°
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
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
    color: "#ffad4d",
    fontSize: 29,
    fontWeight: "900",
    marginTop: 3,
  },
  bottomSummaryValue: {
    color: "#36f4d4",
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
  legendTop: { color: "#ffad4d", fontSize: 12, fontWeight: "900" },
  legendBottom: { color: "#36f4d4", fontSize: 12, fontWeight: "900" },
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
    height: 2,
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
    backgroundColor: "#ffad4d",
    shadowColor: "#ffad4d",
    shadowOpacity: 0.7,
    shadowRadius: 8,
  },
  bottomTempDot: {
    backgroundColor: "#36f4d4",
    shadowColor: "#36f4d4",
    shadowOpacity: 0.7,
    shadowRadius: 8,
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
  dailyDetailsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14,
  },
  dailyDetailCard: {
    backgroundColor: "rgba(5,8,22,0.42)",
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 14,
    borderWidth: 1,
    flexBasis: "31%",
    flexGrow: 1,
    padding: 9,
  },
  dailyDetailDay: {
    color: "#f7fbff",
    fontSize: 12,
    fontWeight: "900",
    marginBottom: 5,
  },
  dailyDetailLine: {
    color: "#cfe9ff",
    fontSize: 10,
    fontWeight: "800",
    lineHeight: 14,
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

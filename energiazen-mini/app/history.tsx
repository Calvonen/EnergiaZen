import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { supabase } from "@/lib/supabase";

type HistoryTab = "24h" | "7d";

type TemperatureHistoryPoint = {
  timestamp: string;
  topTemp: number;
  bottomTemp: number;
  heating: boolean;
  showers: number;
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
  heating: boolean;
  showers: number;
};

type TankReadingRow = {
  created_at?: string | null;
  top_temp?: number | null;
  bottom_temp?: number | null;
  heating?: boolean | null;
  showers?: number | null;
};

const chartHeight = 190;
const chartMinTemp = 30;
const chartMaxTemp = 70;

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

function getHistoryRangeStart(selectedTab: HistoryTab) {
  const rangeMs =
    selectedTab === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

  return new Date(Date.now() - rangeMs).toISOString();
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
    heating: reading.heating ?? false,
    showers: reading.showers ?? 0,
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
      heating: boolean;
      showers: number;
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
        heating: point.heating,
        showers: point.showers,
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
    bucket.heating = bucket.heating || point.heating;
    bucket.showers = Math.max(bucket.showers, point.showers);
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
      heating: bucket.heating,
      showers: bucket.showers,
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

export default function TemperatureHistoryScreen() {
  const router = useRouter();
  const [selectedTab, setSelectedTab] = useState<HistoryTab>("24h");
  const [history, setHistory] = useState<TemperatureHistoryPoint[]>([]);

  const fetchHistory = useCallback(async () => {
    const { data, error } = await supabase
      .from("tank_readings")
      .select("created_at, top_temp, bottom_temp, heating, showers")
      .gte("created_at", getHistoryRangeStart(selectedTab))
      .order("created_at", { ascending: true });

    if (error) {
      console.warn("Lämpöhistorian haku epäonnistui", error.message);
      setHistory([]);
      return;
    }

    const points = ((data as TankReadingRow[] | null) ?? [])
      .map(mapTankReadingToHistoryPoint)
      .filter((point): point is TemperatureHistoryPoint => point !== null);

    setHistory(points);
  }, [selectedTab]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  const visibleHistory = useMemo(
    () => getVisibleHistory(history, selectedTab),
    [history, selectedTab],
  );
  const latestPoint = visibleHistory[visibleHistory.length - 1];
  const chartScale = useMemo(() => [70, 60, 50, 40, 30], []);
  const showerTotal = latestPoint?.showers ?? 0;
  const isDailyView = selectedTab === "7d";

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
            <View style={styles.summaryPill}>
              <Text numberOfLines={1} style={styles.summaryLabel}>
                Suihkut
              </Text>
              <Text style={styles.showerSummaryValue}>🚿 {showerTotal}</Text>
            </View>
          </View>

          <View style={styles.legendRow}>
            <Text style={styles.legendTop}>
              ● Yläanturi {isDailyView ? "keskiarvo" : ""}
            </Text>
            <Text style={styles.legendBottom}>
              ● Ala-anturi {isDailyView ? "keskiarvo" : ""}
            </Text>
            <Text style={styles.legendHeating}>🔥 Lämmitys päällä</Text>
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

                <View style={styles.chartArea}>
                  {chartScale.map((value) => (
                    <View
                      key={value}
                      style={[
                        styles.gridLine,
                        { bottom: getPointBottom(value) },
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
                      const previousPoint = visibleHistory[index - 1];
                      const visibleShowerCount = isDailyHistoryPoint(point)
                        ? point.showers
                        : Math.max(
                            point.showers - (previousPoint?.showers ?? 0),
                            0,
                          );

                      return (
                        <View
                          accessibilityLabel={`${xAxisLabel}, yläanturi ${topTemperature} astetta, ala-anturi ${bottomTemperature} astetta${point.heating ? ", lämmitys päällä" : ""}${visibleShowerCount > 0 ? `, ${visibleShowerCount} suihkua` : ""}`}
                          key={
                            isDailyHistoryPoint(point)
                              ? point.dayKey
                              : point.timestamp
                          }
                          style={styles.historyColumn}
                        >
                          {point.heating ? (
                            <>
                              <View style={styles.heatingShade} />
                              <Text
                                accessibilityElementsHidden
                                importantForAccessibility="no-hide-descendants"
                                style={styles.heatingIcon}
                              >
                                🔥
                              </Text>
                            </>
                          ) : null}
                          <View
                            style={[
                              styles.tempDot,
                              styles.topTempDot,
                              { bottom: getPointBottom(topTemperature) },
                            ]}
                          />
                          <View
                            style={[
                              styles.tempDot,
                              styles.bottomTempDot,
                              { bottom: getPointBottom(bottomTemperature) },
                            ]}
                          />
                          {visibleShowerCount > 0 ? (
                            <View
                              accessibilityElementsHidden
                              importantForAccessibility="no-hide-descendants"
                              style={styles.showerMarker}
                            >
                              {visibleShowerCount > 1 ? (
                                <Text style={styles.showerCount}>
                                  {visibleShowerCount}
                                </Text>
                              ) : null}
                              <Text style={styles.showerIcon}>🚿</Text>
                            </View>
                          ) : null}
                          {isDailyView ||
                          index % 6 === 0 ||
                          index === visibleHistory.length - 1 ? (
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
                      <Text style={styles.dailyDetailLine}>
                        🚿 {point.showers}
                      </Text>
                      {point.heating ? (
                        <Text style={styles.dailyHeatingLine}>🔥 Lämmitys</Text>
                      ) : null}
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
  showerSummaryValue: {
    color: "#f7fbff",
    fontSize: 26,
    fontWeight: "900",
    marginTop: 7,
  },
  legendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 16,
  },
  legendTop: { color: "#ffad4d", fontSize: 12, fontWeight: "900" },
  legendBottom: { color: "#36f4d4", fontSize: 12, fontWeight: "900" },
  legendHeating: { color: "#ffe58f", fontSize: 12, fontWeight: "900" },
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
  historyColumns: { flexDirection: "row", height: chartHeight + 58 },
  historyColumn: {
    flex: 1,
    height: chartHeight,
    justifyContent: "flex-end",
    overflow: "visible",
    position: "relative",
  },
  heatingShade: {
    backgroundColor: "rgba(255,211,77,0.12)",
    bottom: 0,
    left: "28%",
    position: "absolute",
    right: "28%",
    top: 0,
    zIndex: 0,
  },
  heatingIcon: {
    fontSize: 11,
    left: "50%",
    lineHeight: 13,
    marginLeft: -6,
    position: "absolute",
    textAlign: "center",
    top: 2,
    width: 12,
    zIndex: 3,
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
  showerMarker: {
    alignItems: "center",
    bottom: -34,
    justifyContent: "center",
    left: "50%",
    marginLeft: -13,
    position: "absolute",
    width: 26,
    zIndex: 4,
  },
  showerIcon: {
    color: "#f7fbff",
    fontSize: 15,
    fontWeight: "900",
    lineHeight: 17,
  },
  showerCount: {
    color: "#f7fbff",
    fontSize: 9,
    fontWeight: "900",
    lineHeight: 9,
    marginBottom: -1,
    textAlign: "center",
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
  dailyHeatingLine: {
    color: "#ffe58f",
    fontSize: 10,
    fontWeight: "900",
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

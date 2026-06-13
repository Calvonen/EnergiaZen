import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import {
  getTemperatureHistory,
  startTemperatureLogging,
  subscribeToTemperatureHistory,
  TemperatureHistoryPoint,
} from "@/lib/temperatureHistory";

type HistoryTab = "24h" | "7d";

const chartHeight = 190;
const chartMinTemp = 30;
const chartMaxTemp = 70;
const mockShowerTimes = ["07:10", "19:05", "19:45", "21:00", "21:20", "21:50"];

function getShowerCountsByHour(showerTimes: string[]) {
  return showerTimes.reduce<Record<string, number>>((counts, showerTime) => {
    const [hour] = showerTime.split(":");
    const hourLabel = `${hour}:00`;

    counts[hourLabel] = (counts[hourLabel] ?? 0) + 1;

    return counts;
  }, {});
}

const timeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

function formatHour(timestamp: string) {
  return `${timeFormatter.format(new Date(timestamp)).replace(".", "")}:00`;
}

function getVisibleHistory(
  history: TemperatureHistoryPoint[],
  selectedTab: HistoryTab,
) {
  const now = Date.now();
  const visibleRangeMs =
    selectedTab === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const bucketSizeMs =
    selectedTab === "24h" ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  const latestPointByBucket = new Map<number, TemperatureHistoryPoint>();

  history
    .filter(
      (point) => new Date(point.timestamp).getTime() >= now - visibleRangeMs,
    )
    .forEach((point) => {
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

  useEffect(() => {
    let isActive = true;

    startTemperatureLogging();

    getTemperatureHistory().then((points) => {
      if (isActive) {
        setHistory(points);
      }
    });

    const unsubscribe = subscribeToTemperatureHistory((points) => {
      if (isActive) {
        setHistory(points);
      }
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, []);

  const visibleHistory = useMemo(
    () => getVisibleHistory(history, selectedTab),
    [history, selectedTab],
  );
  const latestPoint = visibleHistory[visibleHistory.length - 1];
  const chartScale = useMemo(() => [70, 60, 50, 40, 30], []);
  const showerCountsByHour = useMemo(
    () => getShowerCountsByHour(mockShowerTimes),
    [],
  );
  const showerTotal = mockShowerTimes.length;

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
                Ylä
              </Text>
              <Text style={styles.topSummaryValue}>
                {latestPoint?.topTemp ?? "--"}<Text style={styles.summaryUnit}>°C</Text>
              </Text>
            </View>
            <View style={styles.summaryPill}>
              <Text numberOfLines={1} style={styles.summaryLabel}>
                Ala
              </Text>
              <Text style={styles.bottomSummaryValue}>
                {latestPoint?.bottomTemp ?? "--"}<Text style={styles.summaryUnit}>°C</Text>
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
            <Text style={styles.legendTop}>● Yläanturi</Text>
            <Text style={styles.legendBottom}>● Ala-anturi</Text>
            <Text style={styles.legendHeating}>🔥 Lämmitys päällä</Text>
          </View>

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
                  style={[styles.gridLine, { bottom: getPointBottom(value) }]}
                />
              ))}

              <View style={styles.historyColumns}>
                {visibleHistory.map((point, index) => {
                  const hourLabel = formatHour(point.timestamp);
                  const showerCount = showerCountsByHour[hourLabel] ?? 0;
                  const hasEarlierSameHour = visibleHistory
                    .slice(0, index)
                    .some(
                      (previousPoint) =>
                        formatHour(previousPoint.timestamp) === hourLabel,
                    );
                  const visibleShowerCount = hasEarlierSameHour
                    ? 0
                    : showerCount;

                  return (
                    <View
                      accessibilityLabel={`${hourLabel}, yläanturi ${point.topTemp} astetta, ala-anturi ${point.bottomTemp} astetta${point.heating ? ", lämmitys päällä" : ""}${visibleShowerCount > 0 ? `, ${visibleShowerCount} suihkua` : ""}`}
                      key={point.timestamp}
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
                          { bottom: getPointBottom(point.topTemp) },
                        ]}
                      />
                      <View
                        style={[
                          styles.tempDot,
                          styles.bottomTempDot,
                          { bottom: getPointBottom(point.bottomTemp) },
                        ]}
                      />
                      {visibleShowerCount > 0 ? (
                        <View
                          accessibilityElementsHidden
                          importantForAccessibility="no-hide-descendants"
                          style={styles.showerMarker}
                        >
                          <Text style={styles.showerIcon}>🚿</Text>
                          {visibleShowerCount > 1 ? (
                            <Text style={styles.showerSuperscript}>
                              {visibleShowerCount}
                            </Text>
                          ) : null}
                        </View>
                      ) : null}
                      {index % 6 === 0 ||
                      index === visibleHistory.length - 1 ? (
                        <Text style={styles.hourLabel}>{hourLabel}</Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            </View>
          </View>
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
  summaryRow: { flexDirection: "row", gap: 12, marginBottom: 14 },
  summaryPill: {
    backgroundColor: "rgba(5,8,22,0.46)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    padding: 12,
  },
  summaryLabel: {
    color: "#b9d7ff",
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "900",
  },
  topSummaryValue: {
    color: "#ffad4d",
    fontSize: 34,
    fontWeight: "900",
    marginTop: 4,
  },
  bottomSummaryValue: {
    color: "#36f4d4",
    fontSize: 34,
    fontWeight: "900",
    marginTop: 4,
  },
  summaryUnit: {
    fontSize: 22,
    fontWeight: "900",
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
    alignItems: "flex-start",
    bottom: -32,
    flexDirection: "row",
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
  showerSuperscript: {
    color: "#f7fbff",
    fontSize: 8,
    fontWeight: "900",
    lineHeight: 8,
    marginLeft: -1,
    marginTop: -3,
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

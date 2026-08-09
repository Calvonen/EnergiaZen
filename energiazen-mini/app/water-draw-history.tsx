import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { WaterDrawLabelModal } from "@/components/water-draw-label-modal";
import { fetchEnergyModelDashboardData } from "@/lib/energyModelV2/dashboardData";
import type { WaterDrawEnergyDiagnostic } from "@/lib/energyModelV2/heatLossDiagnostics";
import { buildWaterDrawHistory, countWaterDrawLabels, fetchWaterDrawLabels, getWaterDrawLabelTitle, waterDrawLabelOptions, type WaterDrawHistoryEvent, type WaterDrawLabel } from "@/lib/energyModelV2/waterDrawLabels";

const dateTime = new Intl.DateTimeFormat("fi-FI", { dateStyle: "short", timeStyle: "short" });
const PAGE_SIZE = 50;

export default function WaterDrawHistoryScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<WaterDrawEnergyDiagnostic[]>([]);
  const [labels, setLabels] = useState<WaterDrawLabel[]>([]);
  const [filter, setFilter] = useState<"labeled" | "all">("labeled");
  const [selected, setSelected] = useState<WaterDrawHistoryEvent | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const replayPromise = fetchEnergyModelDashboardData().catch((error) => {
      console.warn("Failed to load replay events for water draw history", error);
      return null;
    });
    try {
      const savedLabels = await fetchWaterDrawLabels();
      setLabels(savedLabels);
    } finally { setLoading(false); }
    const dashboard = await replayPromise;
    if (dashboard) setEvents(dashboard.waterDrawEvents);
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const visible = useMemo(() => buildWaterDrawHistory(events, labels, filter).slice(0, PAGE_SIZE), [events, filter, labels]);
  const labelCounts = useMemo(() => countWaterDrawLabels(labels), [labels]);
  const selectedLabel = selected?.userLabel ?? null;

  return <SafeAreaView style={styles.screen}>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.back}><Text style={styles.backText}>‹</Text></Pressable>
        <View><Text style={styles.eyebrow}>ENERGYMODEL V2 · GROUND TRUTH</Text><Text style={styles.title}>📋 Vedenkäyttöhistoria</Text></View>
      </View>
      <View style={styles.summaryCard}>
        <View style={styles.summaryHeader}>
          <Text style={styles.summaryTitle}>Merkityt tapahtumat</Text>
          <Text style={styles.summaryTotal}>{labels.length}</Text>
        </View>
        {waterDrawLabelOptions.map((option) => (
          <View key={option.label} style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>{option.title}</Text>
            <Text style={styles.summaryCount}>{labelCounts[option.label]}</Text>
          </View>
        ))}
      </View>
      <View style={styles.filters}>
        {(["labeled", "all"] as const).map((value) => <Pressable key={value} onPress={() => setFilter(value)}
          style={[styles.filter, filter === value && styles.filterActive]}><Text style={[styles.filterText, filter === value && styles.filterTextActive]}>{value === "labeled" ? "Merkityt" : "Kaikki"}</Text></Pressable>)}
      </View>
      {loading ? <ActivityIndicator color="#36f4d4" style={styles.loader} /> : visible.length ? visible.map((event) => (
        <Pressable key={`${event.startedAt}-${event.endedAt}`} onPress={() => setSelected(event)} style={styles.card}>
          <Text style={styles.time}>{dateTime.format(new Date(event.startedAt))}</Text>
          <Text style={event.userLabel ? styles.label : styles.unlabeled}>{event.userLabel ? `🏷️ ${getWaterDrawLabelTitle(event.userLabel.label)}` : "Ei käyttäjän merkintää"}</Text>
          <Text style={styles.details}>Kesto {Math.round(event.durationMinutes)} min · {event.estimatedWaterDrawNetEnergyKwh?.toFixed(2) ?? "–"} kWh</Text>
          <Text style={styles.details}>Havainto: {event.detectionKinds.join(" / ")}</Text>
          {event.userLabel?.note ? <Text style={styles.note}>{event.userLabel.note}</Text> : null}
        </Pressable>
      )) : <Text style={styles.empty}>{filter === "labeled" ? "Ei merkittyjä tapahtumia." : "Ei vedenkäyttötapahtumia."}</Text>}
      <Text style={styles.limit}>Näytetään enintään {PAGE_SIZE} uusinta tapahtumaa.</Text>
    </ScrollView>
    <WaterDrawLabelModal event={selected} label={selectedLabel} onChanged={load} onClose={() => setSelected(null)} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#050816", flex: 1 }, content: { padding: 20, paddingBottom: 40 },
  header: { alignItems: "center", flexDirection: "row", gap: 14, marginBottom: 22 }, back: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 22, height: 44, justifyContent: "center", width: 44 }, backText: { color: "#fff", fontSize: 34, fontWeight: "700" },
  eyebrow: { color: "#36f4d4", fontSize: 10, fontWeight: "900", letterSpacing: 1 }, title: { color: "#fff", fontSize: 21, fontWeight: "900" },
  summaryCard: { backgroundColor: "#0c1326", borderColor: "rgba(54,244,212,0.22)", borderRadius: 14, borderWidth: 1, marginBottom: 16, padding: 14 },
  summaryHeader: { alignItems: "baseline", flexDirection: "row", gap: 12, justifyContent: "space-between", marginBottom: 8 },
  summaryTitle: { color: "#eaf1ff", flex: 1, flexShrink: 1, fontSize: 15, fontWeight: "900" },
  summaryTotal: { color: "#36f4d4", fontSize: 20, fontVariant: ["tabular-nums"], fontWeight: "900", minWidth: 30, textAlign: "right" },
  summaryRow: { alignItems: "flex-start", flexDirection: "row", gap: 12, justifyContent: "space-between", paddingVertical: 4 },
  summaryLabel: { color: "#b8c5df", flex: 1, flexShrink: 1, fontSize: 13, fontWeight: "700" },
  summaryCount: { color: "#fff", fontSize: 14, fontVariant: ["tabular-nums"], fontWeight: "900", minWidth: 30, textAlign: "right" },
  filters: { backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 13, flexDirection: "row", marginBottom: 16, padding: 4 }, filter: { alignItems: "center", borderRadius: 10, flex: 1, padding: 10 }, filterActive: { backgroundColor: "#36f4d4" }, filterText: { color: "#9fb0d2", fontWeight: "900" }, filterTextActive: { color: "#07111d" },
  card: { backgroundColor: "#0c1326", borderColor: "rgba(255,255,255,0.1)", borderRadius: 14, borderWidth: 1, marginBottom: 10, padding: 14 }, time: { color: "#fff", fontSize: 14, fontWeight: "900" }, label: { color: "#ffcf70", fontSize: 13, fontWeight: "900", marginTop: 7 }, unlabeled: { color: "#7889aa", fontSize: 13, fontWeight: "800", marginTop: 7 }, details: { color: "#9fb0d2", fontSize: 12, fontWeight: "700", marginTop: 5 }, note: { color: "#eaf1ff", fontSize: 12, marginTop: 8 }, empty: { color: "#9fb0d2", fontWeight: "700", paddingVertical: 30, textAlign: "center" }, limit: { color: "#657495", fontSize: 11, marginTop: 8, textAlign: "center" }, loader: { marginTop: 50 },
});

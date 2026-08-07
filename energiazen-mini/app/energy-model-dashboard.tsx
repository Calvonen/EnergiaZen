import { useCallback, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { DashboardCard, DashboardMetric } from "@/components/developer-dashboard/dashboard-card";
import {
  EnergyModelDashboardData,
  fetchEnergyModelDashboardData,
} from "@/lib/energyModelV2/dashboardData";
import { sensorGeometryV2, topSensorMovedAt } from "@/lib/energyModelV2/sensorGeometry";
import {
  calculateStratifiedShowersLeft,
  getStratifiedShowerLimitingFactor,
} from "@/lib/heatingOptimizer";
import { EnergiaZenSettings, loadSettings } from "@/lib/settings";

const dateTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  dateStyle: "short",
  timeStyle: "short",
});

const NOT_AVAILABLE = "Not available";

function formatNumber(value: number | null | undefined, digits: number, unit: string) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`
    : NOT_AVAILABLE;
}

function formatFinnishRatio(value: number) {
  return value.toFixed(2).replace(".", ",");
}

function sensorStatus(value: number | null | undefined, latestAt?: string): DashboardMetric["tone"] {
  if (typeof value !== "number" || !latestAt) return "warning";
  return Date.now() - new Date(latestAt).getTime() < 15 * 60 * 1000 ? "good" : "warning";
}

function learningStatus(count: number) {
  return count > 0 ? ({ tone: "good", value: "Dataa saatavilla" } as const) : ({ tone: "warning", value: "Odottaa dataa" } as const);
}

export default function EnergyModelDashboardScreen() {
  const router = useRouter();
  const [data, setData] = useState<EnergyModelDashboardData | null>(null);
  const [settings, setSettings] = useState<EnergiaZenSettings | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [dashboardData, savedSettings] = await Promise.all([
        fetchEnergyModelDashboardData(),
        loadSettings(),
      ]);
      setData(dashboardData);
      setSettings(savedSettings);
    } catch (loadError) {
      console.warn("Failed to load EnergyModel Dashboard", loadError);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => void load(), [load]));

  const latestAt = data?.latest?.created_at;
  const latestLabel = latestAt ? dateTimeFormatter.format(new Date(latestAt)) : "Ei mittauksia";
  const showerEstimate =
    typeof data?.latest?.top_temp === "number" &&
    typeof data.latest.bottom_temp === "number" &&
    settings
      ? calculateStratifiedShowersLeft({
          bottomTemperature: data.latest.bottom_temp,
          fullTankAverageTemperature: settings.fullTankAverageTemperature,
          fullTankShowers: settings.fullTankShowers,
          maxTankTemperature: settings.maxTankTemperature,
          minTankTemperature: settings.minTankTemperature,
          topTemperature: data.latest.top_temp,
        })
      : null;
  const limitingFactor = showerEstimate
    ? getStratifiedShowerLimitingFactor(showerEstimate)
    : null;
  const limitingFactorContent = limitingFactor
    ? limitingFactor.factor === "energyRatio"
      ? {
          explanation: "Varaajan käytettävissä olevan energian suhde rajoittaa suihkuarviota tällä hetkellä yläosan käyttökelpoisuutta enemmän.",
          name: "Energiasuhde",
        }
      : limitingFactor.factor === "topUsability"
        ? {
            explanation: "Varaajan yläosan käyttökelpoisuus rajoittaa suihkuarviota tällä hetkellä energiasuhdetta enemmän.",
            name: "Yläosan käyttökelpoisuus",
          }
        : {
            explanation: "Energiasuhde ja yläosan käyttökelpoisuus rajoittavat suihkuarviota yhtä paljon, joten yhtä suurinta rajoitetta ei ole.",
            name: "Tasapainossa",
          }
    : null;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.glow} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Palaa asetuksiin" accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <View>
            <Text style={styles.eyebrow}>DEVELOPER · V1</Text>
            <Text style={styles.heading}>EnergyModel Dashboard</Text>
          </View>
        </View>

        {loading && !data ? <ActivityIndicator color="#36f4d4" size="large" style={styles.loader} /> : null}
        {error ? (
          <Pressable accessibilityRole="button" onPress={load} style={styles.errorCard}>
            <Text style={styles.errorTitle}>Datan lataus epäonnistui</Text>
            <Text style={styles.errorText}>Yritä uudelleen napauttamalla.</Text>
          </Pressable>
        ) : null}

        {data ? (
          <View style={styles.grid}>
            <DashboardCard title="🚿 Shower Calculation" metrics={[
              { label: "Input · Top sensor", value: formatNumber(data.latest?.top_temp, 1, "°C") },
              { label: "Input · Bottom sensor", value: formatNumber(data.latest?.bottom_temp, 1, "°C") },
              { label: "1 · Weighted temperature", value: formatNumber(showerEstimate?.weightedTemperature, 2, "°C") },
              { label: "Input · Full tank average", value: formatNumber(settings?.fullTankAverageTemperature, 1, "°C") },
              { label: "Input · Maximum temperature", value: formatNumber(settings?.maxTankTemperature, 1, "°C") },
              { label: "2 · Effective full tank temp", value: formatNumber(showerEstimate?.fullTankTemp, 1, "°C") },
              { label: "Input · Minimum temperature", value: formatNumber(settings?.minTankTemperature, 1, "°C") },
              { label: "3 · Energy temperature range", value: formatNumber(showerEstimate?.energyTemperatureRange, 1, "°C") },
              { label: "4 · Energy ratio", value: formatNumber(showerEstimate?.energyRatio, 3, "") },
              { label: "5 · Minimum usable top", value: formatNumber(showerEstimate?.minimumUsableTopTemperature, 1, "°C") },
              { label: "6 · Top usability range", value: formatNumber(showerEstimate?.topUsabilityTemperatureRange, 1, "°C") },
              { label: "7 · Top usability", value: formatNumber(showerEstimate?.topUsability, 3, "") },
              { label: "8 · Fill ratio", value: formatNumber(showerEstimate?.fillRatio, 3, "") },
              { label: "Input · Full tank setting", value: formatNumber(settings?.fullTankShowers, 1, "showers") },
              { label: "9 · Current estimate", value: formatNumber(showerEstimate?.showersLeft, 1, "showers") },
              { label: "Context · Inlet temperature", value: formatNumber(data.latest?.inlet_temp, 1, "°C") },
              { label: "Usable energy", value: NOT_AVAILABLE, tone: "muted" },
              { label: "Model used", value: "EnergyModel V1" },
              { label: "Last calculation", value: latestLabel },
            ]}>
              <View style={styles.limitingFactorSection}>
                <Text style={styles.limitingFactorTitle}>🚿 Arviota rajoittava tekijä</Text>
                <Text style={styles.limitingFactorName}>{limitingFactorContent?.name ?? NOT_AVAILABLE}</Text>
                <Text style={styles.limitingFactorLabel}>Nykyinen arvo</Text>
                <Text style={styles.limitingFactorValue}>
                  {limitingFactor ? formatFinnishRatio(limitingFactor.value) : NOT_AVAILABLE}
                </Text>
                <Text style={styles.limitingFactorLabel}>Vaikutus</Text>
                <Text style={styles.limitingFactorImpact}>
                  {limitingFactor ? (limitingFactor.factor === "balanced" ? "Yhtä suuri" : "Suurin V1-rajoite") : NOT_AVAILABLE}
                </Text>
                <Text style={styles.limitingFactorLabel}>Selitys</Text>
                <Text style={styles.limitingFactorExplanation}>
                  {limitingFactorContent?.explanation ?? NOT_AVAILABLE}
                </Text>
              </View>
            </DashboardCard>
            <DashboardCard title="Data Quality" metrics={[
              { label: "Yläanturi", value: typeof data.latest?.top_temp === "number" ? "OK" : "Puuttuu", tone: sensorStatus(data.latest?.top_temp, latestAt) },
              { label: "Ala-anturi", value: typeof data.latest?.bottom_temp === "number" ? "OK" : "Puuttuu", tone: sensorStatus(data.latest?.bottom_temp, latestAt) },
              { label: "Tuloanturi", value: typeof data.latest?.inlet_temp === "number" ? "OK" : "Ei dataa", tone: sensorStatus(data.latest?.inlet_temp, latestAt) },
              { label: "Viimeisin mittaus", value: latestLabel },
              { label: "Puuttuvat mittaukset (30 pv)", value: String(data.missingMeasurements), tone: data.missingMeasurements === 0 ? "good" : "warning" },
            ]} />
            <DashboardCard title="Learning Status" metrics={[
              { label: "Heating Gain", ...learningStatus(data.fullHeatings) },
              { label: "Recovery", ...learningStatus(data.recoverySamples) },
              { label: "Cooling", ...learningStatus(data.coolingPeriods) },
              { label: "Replay", ...learningStatus(data.validReplayDays) },
            ]} />
            <DashboardCard title="Tank DNA">
              <Text style={styles.placeholder}>Tulossa myöhemmässä sprintissä</Text>
            </DashboardCard>
            <DashboardCard title="Replay Readiness" metrics={[
              { label: "Täydet lämmitykset", value: String(data.fullHeatings) },
              { label: "Cooling-jaksot", value: String(data.coolingPeriods) },
              { label: "Vedenotot", value: String(data.waterDraws) },
              { label: "Kelvolliset replay-päivät", value: String(data.validReplayDays), tone: data.validReplayDays > 0 ? "good" : "warning" },
            ]} />
            <DashboardCard title="Sensor Geometry" metrics={[
              { label: "Aktiivinen geometry", value: sensorGeometryV2.version, tone: "good" },
              { label: "Epoch", value: `${dateTimeFormatter.format(new Date(topSensorMovedAt))} →` },
              { label: "V1 datamäärä", value: data.v1Readings.toLocaleString("fi-FI") },
              { label: "V2 datamäärä", value: data.v2Readings.toLocaleString("fi-FI") },
            ]} />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#050816", flex: 1, overflow: "hidden" },
  glow: { backgroundColor: "#36f4d4", borderRadius: 999, height: 260, opacity: 0.12, position: "absolute", right: -150, top: 40, width: 260 },
  content: { paddingBottom: 40, paddingHorizontal: 20, paddingTop: 12 },
  header: { alignItems: "center", flexDirection: "row", gap: 14, marginBottom: 22 },
  backButton: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.15)", borderRadius: 22, borderWidth: 1, height: 44, justifyContent: "center", width: 44 },
  backText: { color: "#fff", fontSize: 34, fontWeight: "700", lineHeight: 36, marginTop: -3 },
  eyebrow: { color: "#36f4d4", fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  heading: { color: "#fff", fontSize: 21, fontWeight: "900" },
  grid: { gap: 14 },
  loader: { marginTop: 70 },
  errorCard: { backgroundColor: "rgba(255,95,109,0.12)", borderColor: "rgba(255,95,109,0.35)", borderRadius: 18, borderWidth: 1, padding: 18 },
  errorTitle: { color: "#ff9aa4", fontSize: 15, fontWeight: "900" },
  errorText: { color: "#c9a5ad", fontSize: 13, marginTop: 5 },
  placeholder: { color: "#7889aa", fontSize: 13, fontWeight: "700", paddingBottom: 18 },
  limitingFactorSection: { borderTopColor: "rgba(255,255,255,0.12)", borderTopWidth: 1, paddingBottom: 18, paddingTop: 18 },
  limitingFactorTitle: { color: "#36f4d4", fontSize: 14, fontWeight: "900", marginBottom: 12 },
  limitingFactorName: { color: "#fff", fontSize: 17, fontWeight: "900", marginBottom: 16 },
  limitingFactorLabel: { color: "#7889aa", fontSize: 11, fontWeight: "800", letterSpacing: 0.6, marginTop: 10, textTransform: "uppercase" },
  limitingFactorValue: { color: "#eaf1ff", fontSize: 20, fontWeight: "900", marginTop: 3 },
  limitingFactorImpact: { color: "#ffcf70", fontSize: 14, fontWeight: "900", marginTop: 4 },
  limitingFactorExplanation: { color: "#b8c5df", fontSize: 13, fontWeight: "600", lineHeight: 19, marginTop: 5 },
});

import { useCallback, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { DashboardCard, DashboardMetric } from "@/components/developer-dashboard/dashboard-card";
import { WaterDrawLabelModal } from "@/components/water-draw-label-modal";
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
import type {
  HeatLossObservation,
  HeatLossRejectionReason,
  WaterDrawEnergyDiagnostic,
} from "@/lib/energyModelV2/heatLossDiagnostics";
import { getVisibleHeatLossTrendSegment } from "@/lib/energyModelV2/heatLossChart";
import type { DiagnosticHeatLossModel } from "@/lib/energyModelV2/heatLossModel";
import { fetchWaterDrawLabels, getWaterDrawLabelTitle, joinWaterDrawLabels, type WaterDrawLabel } from "@/lib/energyModelV2/waterDrawLabels";

const dateTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  dateStyle: "short",
  timeStyle: "short",
});

const observationDateFormatter = new Intl.DateTimeFormat("fi-FI", {
  day: "numeric",
  month: "numeric",
  year: "numeric",
});

const observationTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "numeric",
  minute: "2-digit",
});

const NOT_AVAILABLE = "Not available";

const heatLossRejectionLabels: Record<HeatLossRejectionReason, string> = {
  heating_detected: "🔥 Lämmitys havaittu",
  inlet_recovery: "♻️ Vedenkäytön jälkeinen palautuminen",
  tank_stabilization: "⏳ Varaajan tasaantuminen",
  pre_water_draw_guard: "⏪ Vedenkäytön ennakkosuoja",
  inlet_temperature_change: "🌡 Tuloveden muutos",
  measurement_gap: "📶 Mittauskatkos",
  missing_inlet_data: "📡 Puuttuva tulovesidata",
  rapid_temperature_change: "📉 Liian nopea lämpömuutos",
  too_short: "⏱ Liian lyhyt havainto",
  water_draw: "🚿 Vedenkäyttö",
};

function formatNumber(value: number | null | undefined, digits: number, unit: string) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`
    : NOT_AVAILABLE;
}

function formatFinnishRatio(value: number) {
  return value.toFixed(2).replace(".", ",");
}

function formatObservationRange(observation: HeatLossObservation) {
  const start = new Date(observation.startedAt);
  const end = new Date(observation.endedAt);
  const endLabel = start.toDateString() === end.toDateString()
    ? observationTimeFormatter.format(end)
    : `${observationDateFormatter.format(end)} klo ${observationTimeFormatter.format(end)}`;
  return `${observationDateFormatter.format(start)} klo ${observationTimeFormatter.format(start)}–${endLabel}`;
}

function formatDuration(minutes: number) {
  const roundedMinutes = Math.round(minutes);
  const hours = Math.floor(roundedMinutes / 60);
  const remainder = roundedMinutes % 60;
  return [hours ? `${hours} h` : null, remainder ? `${remainder} min` : null]
    .filter(Boolean)
    .join(" ") || "0 min";
}

const storedEnergyBands = [
  { label: "< 4 kWh", maximum: 4 },
  { label: "4–7 kWh", maximum: 7 },
  { label: "7–10 kWh", maximum: 10 },
  { label: "≥ 10 kWh", maximum: Number.POSITIVE_INFINITY },
];

function HeatLossTrend({
  model,
  observations,
}: {
  model: DiagnosticHeatLossModel | null;
  observations: HeatLossObservation[];
}) {
  const [chartWidth, setChartWidth] = useState(0);
  if (!observations.length) return null;

  const energies = observations.map(({ storedEnergyStartKwh }) => storedEnergyStartKwh);
  const losses = observations.map(({ energyLossKwhPerHour }) => energyLossKwhPerHour);
  const minimumEnergy = Math.min(...energies);
  const maximumEnergy = Math.max(...energies);
  const fittedSegment = model
    ? getVisibleHeatLossTrendSegment(model, minimumEnergy, maximumEnergy)
    : null;
  const maximumLoss = Math.max(
    ...losses,
    ...(fittedSegment
      ? [fittedSegment.start.lossKwhPerHour, fittedSegment.end.lossKwhPerHour]
      : []),
    0,
  );
  const plotWidth = Math.max(0, chartWidth - 42);
  const plotHeight = 130;
  const chartX = (energy: number) => 34 + (maximumEnergy - minimumEnergy
    ? (energy - minimumEnergy) / (maximumEnergy - minimumEnergy)
    : 0.5) * plotWidth;
  const chartY = (loss: number) => 8 + (maximumLoss
    ? 1 - loss / maximumLoss
    : 0.5) * (plotHeight - 16);
  const trendStart = fittedSegment ? {
    x: chartX(fittedSegment.start.energyKwh),
    y: chartY(fittedSegment.start.lossKwhPerHour),
  } : null;
  const trendEnd = fittedSegment ? {
    x: chartX(fittedSegment.end.energyKwh),
    y: chartY(fittedSegment.end.lossKwhPerHour),
  } : null;
  const trendLength = trendStart && trendEnd
    ? Math.hypot(trendEnd.x - trendStart.x, trendEnd.y - trendStart.y)
    : 0;
  const trendAngle = trendStart && trendEnd
    ? Math.atan2(trendEnd.y - trendStart.y, trendEnd.x - trendStart.x) * 180 / Math.PI
    : 0;

  return (
    <View style={styles.trendSection}>
      <Text style={styles.diagnosticsSubtitle}>📈 Häviötrendi</Text>
      <Text style={styles.trendDescription}>Alkutilan energia → mitattu lämpöhäviö</Text>
      <View onLayout={(event) => setChartWidth(event.nativeEvent.layout.width)} style={styles.chart}>
        <View style={styles.chartYAxis} />
        <View style={styles.chartXAxis} />
        {chartWidth > 0 && trendStart && trendEnd ? (
          <View style={[styles.chartTrendLine, {
            left: (trendStart.x + trendEnd.x - trendLength) / 2,
            top: (trendStart.y + trendEnd.y) / 2,
            transform: [{ rotate: `${trendAngle}deg` }],
            width: trendLength,
          }]} />
        ) : null}
        {chartWidth > 0 ? observations.map((observation) => {
          const x = chartX(observation.storedEnergyStartKwh);
          const y = chartY(observation.energyLossKwhPerHour);
          return <View key={`${observation.startedAt}-point`} style={[styles.chartPoint, { left: x - 4, top: y - 4 }]} />;
        }) : null}
        <Text style={styles.chartYLabel}>kWh/h</Text>
        <Text style={styles.chartXMinimum}>{minimumEnergy.toFixed(1)}</Text>
        <Text style={styles.chartXMaximum}>{maximumEnergy.toFixed(1)} kWh</Text>
      </View>
    </View>
  );
}

function sensorStatus(value: number | null | undefined, latestAt?: string): DashboardMetric["tone"] {
  if (typeof value !== "number" || !latestAt) return "warning";
  return Date.now() - new Date(latestAt).getTime() < 15 * 60 * 1000 ? "good" : "warning";
}

function learningStatus(count: number) {
  return count > 0 ? ({ tone: "good", value: "Dataa saatavilla" } as const) : ({ tone: "warning", value: "Odottaa dataa" } as const);
}

function qualityMetric(quality: "valid" | "degraded" | "invalid" | undefined): DashboardMetric {
  if (quality === "valid") return { label: "Tilan laatu", tone: "good", value: "Valid" };
  if (quality === "degraded") return { label: "Tilan laatu", tone: "warning", value: "Degraded" };
  if (quality === "invalid") return { label: "Tilan laatu", tone: "warning", value: "Invalid" };
  return { label: "Tilan laatu", tone: "muted", value: NOT_AVAILABLE };
}

export default function EnergyModelDashboardScreen() {
  const router = useRouter();
  const [data, setData] = useState<EnergyModelDashboardData | null>(null);
  const [settings, setSettings] = useState<EnergiaZenSettings | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [labels, setLabels] = useState<WaterDrawLabel[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<WaterDrawEnergyDiagnostic | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [dashboardData, savedSettings, savedLabels] = await Promise.all([
        fetchEnergyModelDashboardData(),
        loadSettings(),
        fetchWaterDrawLabels(),
      ]);
      setData(dashboardData);
      setSettings(savedSettings);
      setLabels(savedLabels);
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
  const v2State = data?.v2TankState;
  const labeledWaterDrawEvents = joinWaterDrawLabels(data?.waterDrawEvents ?? [], labels);
  const v2TimestampLabel = v2State?.timestamp
    ? dateTimeFormatter.format(new Date(v2State.timestamp))
    : NOT_AVAILABLE;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.glow} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Palaa asetuksiin" accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <View>
            <Text style={styles.eyebrow}>DEVELOPER · V1 + V2</Text>
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
            <DashboardCard title="⚡ EnergyModel V2 Diagnostics" metrics={v2State ? [
              { label: "Suihkuarvio", value: NOT_AVAILABLE, tone: "muted" },
              { label: "Käyttökelpoinen energia", value: formatNumber(v2State.usableEnergy.kwh, 2, "kWh") },
              { label: "Välittömästi käytettävä energia", value: formatNumber(v2State.immediateEnergy.kwh, 2, "kWh") },
              { label: "Varastoitu energia", value: formatNumber(v2State.storedEnergy.kwh, 2, "kWh") },
              { label: "Varaenergia", value: formatNumber(v2State.reserveEnergy.kwh, 2, "kWh") },
              { label: "Energian epävarmuus", value: formatNumber(v2State.uncertainty.energyKwh, 2, "kWh") },
              { label: "Ylälämpötilan epävarmuus", value: formatNumber(v2State.uncertainty.topTemperatureC, 1, "°C") },
              { label: "Alalämpötilan epävarmuus", value: formatNumber(v2State.uncertainty.bottomTemperatureC, 1, "°C") },
              qualityMetric(v2State.quality),
              { label: "Epävarmuuden syyt", value: v2State.uncertainty.reasons.length ? v2State.uncertainty.reasons.join(", ") : "Ei syitä" },
              { label: "Yläsolmun lämpötila", value: formatNumber(v2State.topNodeTemperatureC, 1, "°C") },
              { label: "Alasolmun lämpötila", value: formatNumber(v2State.bottomNodeTemperatureC, 1, "°C") },
              { label: "Tulovesianturi (raakadata)", value: formatNumber(data.latest?.inlet_temp, 1, "°C") },
              { label: "Arvioitu tuloveden lämpötila (käytetään laskennassa)", value: formatNumber(data.estimatedInletTemperature, 1, "°C") },
              { label: "Yläkerroksen massa", value: formatNumber(v2State.layerMassesKg.top, 1, "kg") },
              { label: "Alakerroksen massa", value: formatNumber(v2State.layerMassesKg.bottom, 1, "kg") },
              { label: "Malli", value: "EnergyModel V2" },
              { label: "Viimeisin laskenta", value: v2TimestampLabel },
            ] : [
              { label: "Tila", value: "Ei riittävästi dataa", tone: "warning" },
            ]}>
              <View style={styles.observationSection}>
                <View style={styles.sectionHeadingRow}>
                  <Text style={styles.diagnosticsSubtitle}>🚰 Viimeisimmät vedenkäyttötapahtumat</Text>
                  <Pressable onPress={() => router.push("/water-draw-history")}><Text style={styles.historyLink}>📋 Historia</Text></Pressable>
                </View>
                {data.waterDrawEvents.length ? (
                  labeledWaterDrawEvents.slice(-10).reverse().map((event) => (
                    <Pressable accessibilityHint="Avaa käyttäjän ground truth -merkintä" accessibilityRole="button"
                      key={`${event.startedAt}-${event.stabilizedAt}`} onPress={() => setSelectedEvent(event)} style={styles.observationCard}>
                      <Text style={styles.observationTime}>
                        🚰 {dateTimeFormatter.format(new Date(event.startedAt))} – {dateTimeFormatter.format(new Date(event.endedAt))}
                      </Text>
                      {[
                        ["Kesto", formatDuration(event.durationMinutes)],
                        ["Havainto", event.detectionKinds.join(" / ")],
                        ["Energia ennen tapahtumaa", formatNumber(event.energyBeforeKwh, 2, "kWh")],
                        ["Energia stabiloitumisen jälkeen", formatNumber(event.energyAfterStabilizationKwh, 2, "kWh")],
                        ["Stabiloitunut", dateTimeFormatter.format(new Date(event.stabilizedAt))],
                        ["Raakamuutos", formatNumber(event.rawEnergyChangeKwh, 2, "kWh")],
                        ["Luonnollinen lämpöhäviö tapahtumaikkunassa", formatNumber(event.estimatedNaturalLossKwh, 2, "kWh")],
                        ["Vedenkäytön nettoenergia", formatNumber(event.estimatedWaterDrawNetEnergyKwh, 2, "kWh")],
                      ].map(([label, value]) => (
                        <View key={label} style={styles.observationMetricRow}>
                          <Text style={styles.observationMetricLabel}>{label}</Text>
                          <Text style={styles.observationMetricValue}>{value}</Text>
                        </View>
                      ))}
                      {event.userLabel ? <View style={styles.userLabelBox}>
                        <Text style={styles.userLabelText}>🏷️ {getWaterDrawLabelTitle(event.userLabel.label)}</Text>
                        {event.userLabel.note ? <Text style={styles.userLabelNote}>{event.userLabel.note}</Text> : null}
                        <Text style={styles.groundTruthCaption}>Käyttäjän antama ground truth</Text>
                      </View> : null}
                    </Pressable>
                  ))
                ) : (
                  <Text style={styles.noRejections}>Ei stabiloituneita vedenkäyttötapahtumia</Text>
                )}
              </View>
            </DashboardCard>
            <DashboardCard title="📉 Lämpöhäviödiagnostiikka" metrics={[
              { label: "Hyväksyttyjä havaintoja", value: String(data.heatLossDiagnostics.observations.length) },
              { label: "Viimeisin havainto", value: data.heatLossDiagnostics.latestObservation ? `${dateTimeFormatter.format(new Date(data.heatLossDiagnostics.latestObservation.startedAt))} – ${dateTimeFormatter.format(new Date(data.heatLossDiagnostics.latestObservation.endedAt))}` : NOT_AVAILABLE },
              { label: "Keskimääräinen häviö", value: formatNumber(data.heatLossDiagnostics.averageLossKwhPerHour, 3, "kWh/h") },
              { label: "Suurin havaittu häviö", value: formatNumber(data.heatLossDiagnostics.maximumLossKwhPerHour, 3, "kWh/h") },
              { label: "Pienin havaittu häviö", value: formatNumber(data.heatLossDiagnostics.minimumLossKwhPerHour, 3, "kWh/h") },
              { label: "Mallin havainnot", value: data.heatLossDiagnostics.model ? String(data.heatLossDiagnostics.model.observationCount) : NOT_AVAILABLE },
              { label: "Mallin vakiotermi", value: formatNumber(data.heatLossDiagnostics.model?.interceptKwhPerHour, 4, "kWh/h") },
              { label: "Mallin kulmakerroin", value: formatNumber(data.heatLossDiagnostics.model?.slopeKwhPerHourPerKwh, 4, "(kWh/h)/kWh") },
              { label: "Predicted vs measured MAE", value: formatNumber(data.heatLossDiagnostics.model?.meanAbsoluteErrorKwhPerHour, 4, "kWh/h") },
              { label: "Predicted vs measured RMSE", value: formatNumber(data.heatLossDiagnostics.model?.rootMeanSquaredErrorKwhPerHour, 4, "kWh/h") },
            ]}>
              <View style={styles.acceptanceSection}>
                <Text style={styles.acceptanceTitle}>🔍 Havaintojen hyväksyntä</Text>
                <View style={styles.acceptanceMetrics}>
                  {[
                    ["Tutkittuja jaksoja", data.heatLossDiagnostics.acceptance.examinedCount],
                    ["✅ Hyväksyttyjä", data.heatLossDiagnostics.acceptance.acceptedCount],
                    ...Object.entries(heatLossRejectionLabels).map(([reason, label]) => [
                      label,
                      data.heatLossDiagnostics.acceptance.rejectionCounts[reason as HeatLossRejectionReason],
                    ]),
                    ["↳ 🚿 Vedenkäyttö – nopea pudotus", data.heatLossDiagnostics.acceptance.waterDrawDetectionCounts.rapid_drop],
                    ["↳ 🚿 Vedenkäyttö – pitkä kylmä inlet", data.heatLossDiagnostics.acceptance.waterDrawDetectionCounts.cold_inlet],
                  ].map(([label, value]) => (
                    <View key={String(label)} style={styles.acceptanceMetricRow}>
                      <Text style={styles.acceptanceMetricLabel}>{label}</Text>
                      <Text style={styles.acceptanceMetricValue}>{value}</Text>
                    </View>
                  ))}
                </View>

                <Text style={styles.rejectionsTitle}>Viimeisimmät hylkäykset</Text>
                {data.heatLossDiagnostics.acceptance.latestRejections.length ? (
                  data.heatLossDiagnostics.acceptance.latestRejections.map((rejection) => (
                    <View key={`${rejection.startedAt}-${rejection.reason}`} style={styles.rejectionRow}>
                      <Text style={styles.rejectionTime}>
                        ❌ {dateTimeFormatter.format(new Date(rejection.startedAt))} – {dateTimeFormatter.format(new Date(rejection.endedAt))}
                      </Text>
                      <Text style={styles.rejectionReason}>{heatLossRejectionLabels[rejection.reason]}</Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.noRejections}>Ei hylättyjä havaintoja</Text>
                )}
              </View>
              <View style={styles.observationSection}>
                <Text style={styles.diagnosticsSubtitle}>🌡 Lämpöhäviö energiatason mukaan</Text>
                {storedEnergyBands.map((band, index) => {
                  const minimum = index ? storedEnergyBands[index - 1].maximum : Number.NEGATIVE_INFINITY;
                  const matches = data.heatLossDiagnostics.observations.filter(
                    ({ storedEnergyStartKwh }) => storedEnergyStartKwh >= minimum && storedEnergyStartKwh < band.maximum,
                  );
                  if (!matches.length) return null;
                  const average = matches.reduce((sum, item) => sum + item.energyLossKwhPerHour, 0) / matches.length;
                  return (
                    <View key={band.label} style={styles.energyBandRow}>
                      <Text style={styles.energyBandLabel}>{band.label}</Text>
                      <Text style={styles.energyBandValue}>{average.toFixed(3)} kWh/h</Text>
                      <Text style={styles.energyBandCount}>(n={matches.length})</Text>
                    </View>
                  );
                })}
              </View>
              <HeatLossTrend
                model={data.heatLossDiagnostics.model}
                observations={data.heatLossDiagnostics.observations}
              />
              <View style={styles.observationSection}>
                <Text style={styles.diagnosticsSubtitle}>✅ Viimeisimmät hyväksytyt havainnot</Text>
                {data.heatLossDiagnostics.observations.length ? (
                  data.heatLossDiagnostics.observations.slice(-10).reverse().map((observation) => (
                    <View key={observation.startedAt} style={styles.observationCard}>
                      <Text style={styles.observationTime}>✅ {formatObservationRange(observation)}</Text>
                      {[
                        ["Kesto", formatDuration(observation.durationMinutes)],
                        ["Ylälämpö alussa", formatNumber(observation.topNodeTemperatureC, 1, "°C")],
                        ["Alalämpö alussa", formatNumber(observation.bottomNodeTemperatureC, 1, "°C")],
                        ["Tulovesi", formatNumber(observation.estimatedInletTemperatureC, 1, "°C")],
                        ["Energia alussa", formatNumber(observation.storedEnergyStartKwh, 2, "kWh")],
                        ["Energia lopussa", formatNumber(observation.storedEnergyEndKwh, 2, "kWh")],
                        ["Häviö", formatNumber(observation.energyLossKwh, 2, "kWh")],
                        ["Häviönopeus", formatNumber(observation.energyLossKwhPerHour, 3, "kWh/h")],
                      ].map(([label, value]) => (
                        <View key={label} style={styles.observationMetricRow}>
                          <Text style={styles.observationMetricLabel}>{label}</Text>
                          <Text style={styles.observationMetricValue}>{value}</Text>
                        </View>
                      ))}
                    </View>
                  ))
                ) : (
                  <Text style={styles.noRejections}>Ei hyväksyttyjä havaintoja</Text>
                )}
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
      <WaterDrawLabelModal event={selectedEvent} label={selectedEvent ? joinWaterDrawLabels([selectedEvent], labels)[0].userLabel : null}
        onChanged={load} onClose={() => setSelectedEvent(null)} />
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
  acceptanceSection: { borderTopColor: "rgba(255,255,255,0.12)", borderTopWidth: 1, paddingBottom: 18, paddingTop: 18 },
  acceptanceTitle: { color: "#36f4d4", fontSize: 14, fontWeight: "900", marginBottom: 14 },
  acceptanceMetrics: { gap: 9 },
  acceptanceMetricRow: { alignItems: "center", flexDirection: "row", gap: 12, justifyContent: "space-between" },
  acceptanceMetricLabel: { color: "#b8c5df", flex: 1, fontSize: 13, fontWeight: "700" },
  acceptanceMetricValue: { color: "#fff", fontSize: 14, fontWeight: "900" },
  rejectionsTitle: { color: "#fff", fontSize: 14, fontWeight: "900", marginBottom: 4, marginTop: 22 },
  rejectionRow: { borderTopColor: "rgba(255,255,255,0.08)", borderTopWidth: 1, paddingVertical: 12 },
  rejectionTime: { color: "#eaf1ff", fontSize: 12, fontWeight: "800" },
  rejectionReason: { color: "#ffcf70", fontSize: 13, fontWeight: "800", marginTop: 5 },
  noRejections: { color: "#7889aa", fontSize: 13, fontWeight: "700", marginTop: 8 },
  observationSection: { borderTopColor: "rgba(255,255,255,0.12)", borderTopWidth: 1, paddingBottom: 18, paddingTop: 18 },
  diagnosticsSubtitle: { color: "#36f4d4", fontSize: 14, fontWeight: "900", marginBottom: 14 },
  sectionHeadingRow: { alignItems: "flex-start", flexDirection: "row", gap: 10, justifyContent: "space-between" },
  historyLink: { color: "#ffcf70", fontSize: 12, fontWeight: "900" },
  energyBandRow: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 34 },
  energyBandLabel: { color: "#b8c5df", flex: 1, fontSize: 13, fontWeight: "700" },
  energyBandValue: { color: "#fff", fontSize: 13, fontWeight: "900" },
  energyBandCount: { color: "#7889aa", fontSize: 12, fontWeight: "700", width: 42 },
  observationCard: { backgroundColor: "rgba(54,244,212,0.05)", borderColor: "rgba(54,244,212,0.16)", borderRadius: 14, borderWidth: 1, marginTop: 10, padding: 12 },
  observationTime: { color: "#eaf1ff", fontSize: 13, fontWeight: "900", marginBottom: 9 },
  observationMetricRow: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 27 },
  observationMetricLabel: { color: "#9fb0d2", flex: 1, fontSize: 12, fontWeight: "700" },
  observationMetricValue: { color: "#fff", fontSize: 12, fontWeight: "900", textAlign: "right" },
  userLabelBox: { backgroundColor: "rgba(255,207,112,0.09)", borderRadius: 10, marginTop: 10, padding: 10 },
  userLabelText: { color: "#ffcf70", fontSize: 13, fontWeight: "900" },
  userLabelNote: { color: "#eaf1ff", fontSize: 12, marginTop: 5 },
  groundTruthCaption: { color: "#7889aa", fontSize: 10, fontWeight: "700", marginTop: 5 },
  trendSection: { borderTopColor: "rgba(255,255,255,0.12)", borderTopWidth: 1, paddingBottom: 20, paddingTop: 18 },
  trendDescription: { color: "#7889aa", fontSize: 11, fontWeight: "700", marginBottom: 8, marginTop: -8 },
  chart: { height: 154, position: "relative" },
  chartYAxis: { backgroundColor: "rgba(255,255,255,0.18)", bottom: 24, left: 32, position: "absolute", top: 4, width: 1 },
  chartXAxis: { backgroundColor: "rgba(255,255,255,0.18)", bottom: 24, left: 32, position: "absolute", right: 4, height: 1 },
  chartPoint: { backgroundColor: "#36f4d4", borderColor: "#bafff3", borderRadius: 5, borderWidth: 1, height: 9, position: "absolute", width: 9 },
  chartTrendLine: { backgroundColor: "#ffcf70", height: 2, position: "absolute" },
  chartYLabel: { color: "#7889aa", fontSize: 9, fontWeight: "800", left: 0, position: "absolute", top: 1 },
  chartXMinimum: { bottom: 4, color: "#7889aa", fontSize: 9, fontWeight: "700", left: 28, position: "absolute" },
  chartXMaximum: { bottom: 4, color: "#7889aa", fontSize: 9, fontWeight: "700", position: "absolute", right: 0 },
});

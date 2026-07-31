import { useEffect, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  estimateHeatingGainPerHour,
  fetchHeatingGainHistory,
  heatingGainHistoryDays,
  HeatingGainRejectedSegment,
  HeatingGainRejectionReason,
  HeatingGainSegment,
  HeatingGainWarningReason,
} from "@/lib/heatingGain";
import { backtestHeatingGainEstimate } from "@/lib/heatingGainBacktest";
import { supabase } from "@/lib/supabase";
import type { TankTemperatureReading } from "@/lib/tankTemperatureForecast";

// Kevyt, laajennettava rivi diagnostiikkanäkymää varten. Uusia rivejä
// voi lisätä myöhemmin (esim. hylkäyssyyt) vain lisäämällä niitä
// buildLearningInfoRows-listaan - rakenne ei muutu.
type LearningInfoRow = {
  description: string;
  id: string;
  label: string;
  value: string;
};

function formatCelsius(value: number, options: { forceSign?: boolean } = {}) {
  const formatted = Math.abs(value).toFixed(1).replace(".", ",");
  const sign = options.forceSign ? (value >= 0 ? "+" : "-") : "";
  return `${sign}${formatted} °C`;
}

function buildLearningInfoRows(
  gainEstimate: ReturnType<typeof estimateHeatingGainPerHour>,
  backtest: ReturnType<typeof backtestHeatingGainEstimate>,
): LearningInfoRow[] {
  const rows: LearningInfoRow[] = [];

  rows.push({
    id: "gainPerHour",
    label: "Nykyinen lämmitysteho",
    value: `${gainEstimate.gainPerHour.toFixed(1).replace(".", ",")} °C/h`,
    description: gainEstimate.fallbackUsed
      ? "Arvio siitä, kuinka paljon varaajan lämpötila nousee tunnissa lämmityksen aikana. Dataa ei vielä ole riittävästi, joten käytössä on kiinteä oletusarvo."
      : `Arvio siitä, kuinka paljon varaajan lämpötila nousee tunnissa lämmityksen aikana. Opittu ${gainEstimate.acceptedSegmentCount} lämmitysjaksosta viimeisen ${heatingGainHistoryDays} päivän ajalta.`,
  });

  rows.push({
    id: "source",
    label: "Arvon lähde",
    value: gainEstimate.fallbackUsed ? "Kiinteä oletusarvo" : "Opittu datasta",
    description: gainEstimate.fallbackUsed
      ? "Hyväksyttyjä lämmitysjaksoja on vielä liian vähän, joten laskennassa käytetään kiinteää oletusarvoa opitun arvon sijaan."
      : "Lämmitysteho on opittu mitatusta datasta, ei kiinteästä oletusarvosta.",
  });

  rows.push({
    id: "accepted",
    label: "Hyväksytyt lämmitysjaksot",
    value: `${gainEstimate.acceptedSegmentCount} kpl`,
    description: `Nämä jaksot täyttivät laatuvaatimukset ja niitä käytettiin lämmitystehon laskentaan viimeisen ${heatingGainHistoryDays} päivän ajalta.`,
  });

  rows.push({
    id: "rejected",
    label: "Hylätyt lämmitysjaksot",
    value: `${gainEstimate.rejectedSegmentCount} kpl`,
    description: "Nämä jaksot olivat esimerkiksi liian lyhyitä, liian pitkiä tai lämpötilamuutos oli epäuskottava, joten niitä ei käytetty laskentaan.",
  });

  rows.push({
    id: "mae",
    label: "Ennusteen keskimääräinen virhe",
    value:
      backtest.meanAbsoluteErrorCelsius === null
        ? "Ei vielä laskettavissa"
        : `±${formatCelsius(backtest.meanAbsoluteErrorCelsius)}`,
    description:
      backtest.meanAbsoluteErrorCelsius === null
        ? "Tarkkuutta ei voitu vielä laskea, koska hyväksyttyjä lämmitysjaksoja ei ole yhtään."
        : "Kuinka paljon malli keskimäärin erehtyy ennustaessaan lämpötilan nousua yhden lämmitysjakson aikana. Laskettu vertaamalla jokaista jaksoa muiden jaksojen perusteella tehtyyn ennusteeseen (ristiinvalidointi).",
  });

  const bias = backtest.meanBiasCelsius;
  rows.push({
    id: "bias",
    label: "Systemaattinen harha",
    value: bias === null ? "Ei vielä laskettavissa" : formatCelsius(bias, { forceSign: true }),
    description:
      bias === null
        ? "Tarkkuutta ei voitu vielä laskea."
        : Math.abs(bias) < 0.3
          ? "Malli ei yli- tai aliarvioi lämpötilan nousua merkittävästi."
          : bias > 0
            ? "Malli aliarvioi lämpötilan nousun hieman keskimäärin - todellisuudessa varaaja lämpenee ennustettua enemmän."
            : "Malli yliarvioi lämpötilan nousun hieman keskimäärin - todellisuudessa varaaja lämpenee ennustettua vähemmän.",
  });

  rows.push({
    id: "backtestSegments",
    label: "Taustatestin jaksomäärä",
    value: `${backtest.segmentCount} kpl`,
    description: "Kuinka moneen todelliseen lämmitysjaksoon tarkkuusarvio (yllä) perustuu.",
  });

  return rows;
}

function LearningInfoCard({ row }: { row: LearningInfoRow }) {
  return (
    <View style={styles.infoCard}>
      <Text style={styles.infoLabel}>{row.label}</Text>
      <Text style={styles.infoValue}>{row.value}</Text>
      <Text style={styles.infoDescription}>{row.description}</Text>
    </View>
  );
}

// Kehittäjän debug-loki: kaikki 30 päivän ikkunassa löydetyt
// lämmitysjaksot (hyväksytyt ja hylätyt) samassa, aikajärjestykseen
// lajitellussa listassa. Lukee vain jo lasketut kentät
// findValidHeatingSegments-funktion palauttamista segmenteistä -
// ei omaa laskentaa eikä vaikutusta tuotannon hyväksymispäätökseen.
type DebugSegmentRow = {
  accepted: boolean;
  bottomGainPerHour: number | null;
  endTime: string;
  endWeightedTemperature: number;
  id: string;
  reasons: HeatingGainRejectionReason[];
  startTime: string;
  startWeightedTemperature: number;
  status: HeatingGainSegment["status"] | HeatingGainRejectedSegment["status"];
  topGainPerHour: number | null;
  warnings: HeatingGainWarningReason[];
  weightedGainPerHour: number | null;
};

const rejectionReasonLabels: Record<HeatingGainRejectionReason, string> = {
  component_gain_out_of_range: "Ylä- tai alasensorin nousu epärealistinen",
  excessive_duration: "Jakso liian pitkä",
  insufficient_duration: "Jakso liian lyhyt",
  insufficient_gain: "Nousu liian pieni",
  insufficient_readings: "Liian vähän mittauksia",
  negative_temperature_change: "Lämpötila laski jakson aikana",
  non_finite_gain: "Nousua ei voitu laskea",
  unrealistic_gain: "Nousu epärealistisen suuri",
};

const warningReasonLabels: Record<HeatingGainWarningReason, string> = {
  sensor_anomaly: "Anturipoikkeama havaittu",
  unstable_curve: "Epävakaa lämpötilakäyrä",
};

function buildDebugSegmentRows(
  gainEstimate: ReturnType<typeof estimateHeatingGainPerHour>,
): DebugSegmentRow[] {
  const { rejectedSegments, segments } = gainEstimate.segmentDiscovery;

  const acceptedRows: DebugSegmentRow[] = segments.map((segment) => ({
    accepted: true,
    bottomGainPerHour: segment.bottomGainPerHour,
    endTime: segment.endTime,
    endWeightedTemperature: segment.endWeightedTemperature,
    id: `accepted-${segment.startTime}`,
    reasons: [],
    startTime: segment.startTime,
    startWeightedTemperature: segment.startWeightedTemperature,
    status: segment.status,
    topGainPerHour: segment.topGainPerHour,
    warnings: segment.warnings,
    weightedGainPerHour: segment.weightedGainPerHour,
  }));

  const rejectedRows: DebugSegmentRow[] = rejectedSegments.map((segment) => ({
    accepted: false,
    bottomGainPerHour: segment.bottomGainPerHour,
    endTime: segment.endTime,
    endWeightedTemperature: segment.endWeightedTemperature,
    id: `rejected-${segment.startTime}`,
    reasons: segment.reasons,
    startTime: segment.startTime,
    startWeightedTemperature: segment.startWeightedTemperature,
    status: segment.status,
    topGainPerHour: segment.topGainPerHour,
    warnings: segment.warnings,
    weightedGainPerHour: segment.weightedGainPerHour,
  }));

  return [...acceptedRows, ...rejectedRows].sort((first, second) =>
    second.startTime.localeCompare(first.startTime),
  );
}

const debugDateTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
});

function formatDebugDateTime(iso: string) {
  return debugDateTimeFormatter.format(new Date(iso)).replace(",", " klo");
}

function formatDebugTemperature(value: number) {
  return `${value.toFixed(1).replace(".", ",")} °C`;
}

function formatDebugGain(value: number | null) {
  return value === null ? "—" : `${value.toFixed(2).replace(".", ",")} °C/h`;
}

function getDebugStatusLabel(status: DebugSegmentRow["status"]) {
  if (status === "accepted") {
    return "Hyväksytty";
  }
  if (status === "accepted_with_warnings") {
    return "Hyväksytty (varoituksia)";
  }
  return "Hylätty";
}

function DebugSegmentCard({ row }: { row: DebugSegmentRow }) {
  return (
    <View
      style={[
        styles.debugSegmentCard,
        row.accepted
          ? styles.debugSegmentCardAccepted
          : styles.debugSegmentCardRejected,
      ]}
    >
      <View style={styles.debugSegmentHeaderRow}>
        <Text style={styles.debugSegmentTime}>
          {formatDebugDateTime(row.startTime)} – {formatDebugDateTime(row.endTime)}
        </Text>
        <Text
          style={[
            styles.debugSegmentStatus,
            row.accepted
              ? styles.debugSegmentStatusAccepted
              : styles.debugSegmentStatusRejected,
          ]}
        >
          {getDebugStatusLabel(row.status)}
        </Text>
      </View>

      <View style={styles.debugSegmentValuesRow}>
        <Text style={styles.debugSegmentValue}>
          {formatDebugTemperature(row.startWeightedTemperature)} {"->"}{" "}
          {formatDebugTemperature(row.endWeightedTemperature)}
        </Text>
        <Text style={styles.debugSegmentValue}>
          {formatDebugGain(row.weightedGainPerHour)}
        </Text>
      </View>

      {row.reasons.length > 0 ? (
        <Text style={styles.debugSegmentReasonText}>
          Hylkäyksen syy: {row.reasons.map((reason) => rejectionReasonLabels[reason]).join(", ")}
        </Text>
      ) : null}

      {row.warnings.length > 0 ? (
        <Text style={styles.debugSegmentWarningText}>
          Varoitukset: {row.warnings.map((warning) => warningReasonLabels[warning]).join(", ")}
        </Text>
      ) : null}

      <Text style={styles.debugSegmentMeta}>
        Lämmitys päättyi: {formatDebugDateTime(row.endTime)}
      </Text>
    </View>
  );
}

export default function HeatingLearningScreen() {
  const router = useRouter();
  const [readings, setReadings] = useState<TankTemperatureReading[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDebugSectionOpen, setIsDebugSectionOpen] = useState(false);

  useEffect(() => {
    let isActive = true;

    const load = async () => {
      setError(null);

      try {
        const startIso = new Date(
          Date.now() - heatingGainHistoryDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const endIso = new Date().toISOString();

        const result = await fetchHeatingGainHistory(async (from, to) => {
          const { data, error: queryError } = await supabase
            .from("tank_readings")
            .select("created_at,top_temp,bottom_temp,heating")
            .eq("heating", true)
            .gte("created_at", startIso)
            .lte("created_at", endIso)
            .order("created_at", { ascending: true })
            .range(from, to);

          return { data: (data ?? []) as TankTemperatureReading[], error: queryError };
        });

        if (!isActive) {
          return;
        }

        setReadings(result.readings);
      } catch {
        if (!isActive) {
          return;
        }

        setError("Lämmitysdatan hakeminen epäonnistui. Yritä myöhemmin uudelleen.");
        setReadings([]);
      }
    };

    void load();

    return () => {
      isActive = false;
    };
  }, []);

  const rows = useMemo(() => {
    if (!readings) {
      return null;
    }

    const gainEstimate = estimateHeatingGainPerHour(readings);
    const backtest = backtestHeatingGainEstimate(readings);

    return buildLearningInfoRows(gainEstimate, backtest);
  }, [readings]);

  const debugSegmentRows = useMemo(() => {
    if (!readings) {
      return null;
    }

    return buildDebugSegmentRows(estimateHeatingGainPerHour(readings));
  }, [readings]);

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
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.title}>Lämmitystehon oppiminen</Text>
          <Text style={styles.subtitle}>
            Viimeisen {heatingGainHistoryDays} päivän lämmitysjaksot
          </Text>
        </View>

        <View style={styles.introCard}>
          <Text style={styles.introText}>
            Lämmitysteho kertoo, kuinka nopeasti varaajan lämpötila nousee
            tunnissa lämmityksen aikana. Se opitaan automaattisesti
            viimeisen {heatingGainHistoryDays} päivän onnistuneista
            lämmitysjaksoista, ja opittua arvoa käytetään lämmitysennusteissa
            ja -suunnitelmissa.
          </Text>
        </View>

        {error ? (
          <View style={styles.emptyCard}>
            <Text accessibilityRole="alert" style={styles.emptyText}>
              {error}
            </Text>
          </View>
        ) : !rows ? (
          <View style={styles.loadingCard}>
            <ActivityIndicator color="#36f4d4" size="small" />
            <Text style={styles.loadingText}>Ladataan lämmitysdataa...</Text>
          </View>
        ) : (
          <>
            {rows.map((row) => (
              <LearningInfoCard key={row.id} row={row} />
            ))}

            <Pressable
              accessibilityLabel={
                isDebugSectionOpen
                  ? "Piilota kehittäjän debug-tiedot"
                  : "Näytä kehittäjän debug-tiedot"
              }
              accessibilityRole="button"
              onPress={() => setIsDebugSectionOpen((current) => !current)}
              style={({ pressed }) => [
                styles.debugToggle,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.debugToggleText}>
                Kehittäjän debug-tiedot ({debugSegmentRows?.length ?? 0} jaksoa)
              </Text>
              <Text style={styles.debugToggleChevron}>
                {isDebugSectionOpen ? "⌃" : "⌄"}
              </Text>
            </Pressable>

            {isDebugSectionOpen ? (
              <View style={styles.debugSection}>
                <Text style={styles.debugSectionIntro}>
                  Kaikki viimeisen {heatingGainHistoryDays} päivän aikana
                  löydetyt lämmitysjaksot, hyväksytyt ja hylätyt, uusin
                  ensin. Tarkoitus on tehdä oppimisalgoritmin päätöksistä
                  jäljitettäviä.
                </Text>
                {debugSegmentRows && debugSegmentRows.length > 0 ? (
                  debugSegmentRows.map((row) => (
                    <DebugSegmentCard key={row.id} row={row} />
                  ))
                ) : (
                  <Text style={styles.debugEmptyText}>
                    Ei lämmitysjaksoja tarkasteluikkunassa.
                  </Text>
                )}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
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
  title: { color: "#f7fbff", fontSize: 26, fontWeight: "900", textAlign: "center" },
  subtitle: { color: "#b9d7ff", fontSize: 14, fontWeight: "700", marginTop: 5 },
  introCard: { backgroundColor: "rgba(90,167,255,0.09)", borderColor: "rgba(90,167,255,0.2)", borderRadius: 20, borderWidth: 1, marginBottom: 12, padding: 16 },
  introText: { color: "#cfe9ff", fontSize: 13, fontWeight: "600", lineHeight: 19 },
  loadingCard: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 24, gap: 10, marginTop: 12, padding: 30 },
  loadingText: { color: "#cfe9ff", fontSize: 14, fontWeight: "800" },
  emptyCard: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 24, marginTop: 12, padding: 30 },
  emptyText: { color: "#cfe9ff", fontSize: 16, fontWeight: "800", lineHeight: 23, textAlign: "center" },
  infoCard: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 20, marginBottom: 12, padding: 16 },
  infoLabel: { color: "#9fc7df", fontSize: 12, fontWeight: "800" },
  infoValue: { color: "#f7fbff", fontSize: 24, fontWeight: "900", marginTop: 4 },
  infoDescription: { color: "#b9d7ff", fontSize: 13, fontWeight: "600", lineHeight: 19, marginTop: 8 },
  debugToggle: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 16, flexDirection: "row", justifyContent: "space-between", marginTop: 8, paddingHorizontal: 16, paddingVertical: 13 },
  debugToggleText: { color: "#9fc7df", fontSize: 13, fontWeight: "800" },
  debugToggleChevron: { color: "#9fc7df", fontSize: 16, fontWeight: "900" },
  debugSection: { marginTop: 10 },
  debugSectionIntro: { color: "#8190b5", fontSize: 12, fontWeight: "600", lineHeight: 17, marginBottom: 10 },
  debugEmptyText: { color: "#8190b5", fontSize: 13, fontWeight: "700", paddingVertical: 12, textAlign: "center" },
  debugSegmentCard: { borderRadius: 14, borderWidth: 1, marginBottom: 8, padding: 12 },
  debugSegmentCardAccepted: { backgroundColor: "rgba(84,234,160,0.07)", borderColor: "rgba(84,234,160,0.22)" },
  debugSegmentCardRejected: { backgroundColor: "rgba(255,95,109,0.06)", borderColor: "rgba(255,95,109,0.2)" },
  debugSegmentHeaderRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  debugSegmentTime: { color: "#cfe9ff", fontSize: 11, fontWeight: "800" },
  debugSegmentStatus: { borderRadius: 999, fontSize: 10, fontWeight: "900", overflow: "hidden", paddingHorizontal: 8, paddingVertical: 3 },
  debugSegmentStatusAccepted: { backgroundColor: "rgba(84,234,160,0.16)", color: "#8ff0bd" },
  debugSegmentStatusRejected: { backgroundColor: "rgba(255,95,109,0.16)", color: "#ff9aa4" },
  debugSegmentValuesRow: { flexDirection: "row", gap: 14, marginTop: 6 },
  debugSegmentValue: { color: "#f7fbff", fontSize: 13, fontWeight: "800" },
  debugSegmentReasonText: { color: "#ff9aa4", fontSize: 11, fontWeight: "700", marginTop: 6 },
  debugSegmentWarningText: { color: "#ffcf7a", fontSize: 11, fontWeight: "700", marginTop: 4 },
  debugSegmentMeta: { color: "#5f7093", fontSize: 10, fontWeight: "600", marginTop: 6 },
});

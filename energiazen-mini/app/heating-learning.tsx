import { useEffect, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  estimateHeatingGainPerHour,
  fetchHeatingGainHistory,
  heatingGainHistoryDays,
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

export default function HeatingLearningScreen() {
  const router = useRouter();
  const [readings, setReadings] = useState<TankTemperatureReading[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          rows.map((row) => <LearningInfoCard key={row.id} row={row} />)
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
  loadingCard: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 24, gap: 10, marginTop: 12, padding: 30 },
  loadingText: { color: "#cfe9ff", fontSize: 14, fontWeight: "800" },
  emptyCard: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 24, marginTop: 12, padding: 30 },
  emptyText: { color: "#cfe9ff", fontSize: 16, fontWeight: "800", lineHeight: 23, textAlign: "center" },
  infoCard: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 20, marginBottom: 12, padding: 16 },
  infoLabel: { color: "#9fc7df", fontSize: 12, fontWeight: "800" },
  infoValue: { color: "#f7fbff", fontSize: 24, fontWeight: "900", marginTop: 4 },
  infoDescription: { color: "#b9d7ff", fontSize: 13, fontWeight: "600", lineHeight: 19, marginTop: 8 },
});

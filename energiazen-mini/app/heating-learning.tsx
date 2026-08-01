import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import * as Updates from "expo-updates";

import {
  estimateHeatingGainPerHour,
  fallbackHeatingGainPerHour,
  fetchHeatingGainHistory,
  heatingGainHistoryDays,
  HeatingGainRejectedSegment,
  HeatingGainRejectionReason,
  HeatingGainSegment,
  HeatingGainWarningReason,
} from "@/lib/heatingGain";
import { backtestHeatingGainEstimate } from "@/lib/heatingGainBacktest";
import {
  estimateRecoveryDropPerHour,
  type RecoveryDropEstimate,
} from "@/lib/heatingRecoveryDrop";
import { isRecoveryDropEnabledForChannel } from "@/lib/recoveryDropEnvironment";
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  type EnergiaZenSettings,
  type HeatingGainSource,
} from "@/lib/settings";
import { supabase } from "@/lib/supabase";
import type { TankTemperatureReading } from "@/lib/tankTemperatureForecast";

// Sama portti jota lib/useHeatingOptimizationRun.ts käyttää oikeassa
// lämmityssuunnitelmassa - ei kovakoodattu arvo, jottei tämä rivi jää
// jälkeen todellisesta tilasta.
const recoveryDropEnabled = isRecoveryDropEnabledForChannel(Updates.channel);

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
  heatingGainSource: HeatingGainSource,
): LearningInfoRow[] {
  const rows: LearningInfoRow[] = [];
  // "Nykyinen lämmitysteho"/"Arvon lähde" kuvaavat aina sitä arvoa jota
  // oikea lämmityssuunnitelma OIKEASTI käyttää juuri nyt
  // (lib/useHeatingOptimizationRun.ts), ei pelkkää tämän näytön omaa,
  // riippumatonta arviota - jos käyttäjä on pakottanut kiinteän arvon alla
  // olevasta valinnasta, se näkyy tässä eikä opittua arvoa näytetä
  // harhaanjohtavasti käytössä olevana.
  const isForcedFixed = heatingGainSource === "fixed";
  const effectiveGainPerHour = isForcedFixed
    ? fallbackHeatingGainPerHour
    : gainEstimate.gainPerHour;

  rows.push({
    id: "gainPerHour",
    label: "Nykyinen lämmitysteho",
    value: `${effectiveGainPerHour.toFixed(1).replace(".", ",")} °C/h`,
    description: isForcedFixed
      ? "Arvio siitä, kuinka paljon varaajan lämpötila nousee tunnissa lämmityksen aikana. Käytössä on manuaalisesti valittu kiinteä oletusarvo - vaihda tämä yllä olevasta valinnasta."
      : gainEstimate.fallbackUsed
        ? "Arvio siitä, kuinka paljon varaajan lämpötila nousee tunnissa lämmityksen aikana. Dataa ei vielä ole riittävästi, joten käytössä on kiinteä oletusarvo."
        : `Arvio siitä, kuinka paljon varaajan lämpötila nousee tunnissa lämmityksen aikana. Opittu ${gainEstimate.acceptedSegmentCount} lämmitysjaksosta viimeisen ${heatingGainHistoryDays} päivän ajalta.`,
  });

  rows.push({
    id: "source",
    label: "Arvon lähde",
    value: isForcedFixed
      ? "Kiinteä (valittu asetuksista)"
      : gainEstimate.fallbackUsed
        ? "Kiinteä oletusarvo"
        : "Opittu datasta",
    description: isForcedFixed
      ? "Olet valinnut käytettäväksi kiinteän oletusarvon opitun arvon sijaan, kunnes dataa on enemmän."
      : gainEstimate.fallbackUsed
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

// RecoveryDrop on kytketty päälle development-/preview-kanavilla
// (lib/useHeatingOptimizationRun.ts, lib/recoveryDropEnvironment.ts) mutta
// pysyy pois päältä tuotannossa. "recoveryDropEnabled" yllä käyttää samaa
// isRecoveryDropEnabledForChannel-porttia, joten tämä rivi ei voi jäädä
// jälkeen todellisesta tilasta.
function buildRecoveryDebugRows(
  recoveryEstimate: RecoveryDropEstimate | null,
): LearningInfoRow[] {
  const rows: LearningInfoRow[] = [];

  rows.push({
    id: "recoveryEnabled",
    label: "RecoveryDrop käytössä",
    value: recoveryDropEnabled ? "Kyllä" : "Ei",
    description: recoveryDropEnabled
      ? "RecoveryDrop on käytössä tässä ympäristössä (development/preview-kanava) ja vaikuttaa oikeaan lämmityssuunnitelmaan."
      : "RecoveryDrop on toteutettu feature flagin taakse, mutta se on käytössä vain development-/preview-kanavilla. Tässä ympäristössä (esim. tuotanto) se pysyy pois päältä.",
  });

  rows.push({
    id: "recoveryDropPerHour",
    label: "Opittu recoveryDropPerHour",
    value: !recoveryEstimate
      ? "Ladataan…"
      : `${recoveryEstimate.dropPerHour >= 0 ? "+" : ""}${recoveryEstimate.dropPerHour
          .toFixed(2)
          .replace(".", ",")} °C/h`,
    description: !recoveryEstimate
      ? "Lasketaan historiadatasta."
      : recoveryEstimate.fallbackUsed
        ? "Hyväksyttyjä lämmitysjaksoja, joilla on siisti palautumisikkuna, on vielä liian vähän, joten arvo on kiinteä oletusarvo."
        : "Negatiivinen arvo tarkoittaa, että painotettu lämpötila keskimäärin vielä nousee tunnin sisällä lämmityksen päättymisestä.",
  });

  rows.push({
    id: "recoverySampleCount",
    label: "RecoveryDrop-opetukseen käytetyt jaksot",
    value: !recoveryEstimate ? "Ladataan…" : `${recoveryEstimate.sampleCount} kpl`,
    description:
      "Kuinka moni hyväksytty lämmitysjakso tuotti kelvollisen, häiriöttömän tunnin mittaisen näytteen lämmityksen jälkeisestä lämpötilakehityksestä.",
  });

  rows.push({
    id: "recoveryActiveThisHour",
    label: "RecoveryDrop aktiivinen tässä simulaatiotunnissa",
    value: "Ei sovellettavissa",
    description:
      "Tämä näkymä ei näytä elävää lämmityssuunnitelmaa eikä siis tiedä mikä simulaatiotunti on käynnissä - se lasketaan erikseen etusivun lämmitysoptimoinnissa.",
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
  // RecoveryDrop-opetus tarvitsee myös heating=false-lukemat (löytääkseen
  // lämmityksen jälkeisen siirtymän), toisin kuin lämmitystehon oppiminen
  // yllä - siksi tämä on oma, kevyempi haku joka käynnistyy vasta kun
  // kehittäjän debug-osio avataan ensimmäistä kertaa.
  const [recoveryReadings, setRecoveryReadings] = useState<
    TankTemperatureReading[] | null
  >(null);
  const hasRequestedRecoveryReadings = useRef(false);
  const [settings, setSettings] = useState<EnergiaZenSettings>(defaultSettings);
  const [areSettingsLoaded, setAreSettingsLoaded] = useState(false);
  const [isSavingGainSource, setIsSavingGainSource] = useState(false);

  useEffect(() => {
    let isActive = true;

    void loadSettings().then((loadedSettings) => {
      if (isActive) {
        setSettings(loadedSettings);
        setAreSettingsLoaded(true);
      }
    });

    return () => {
      isActive = false;
    };
  }, []);

  const handleGainSourceChange = (useLearnedValue: boolean) => {
    const nextSource: HeatingGainSource = useLearnedValue ? "learned" : "fixed";
    const nextSettings: EnergiaZenSettings = {
      ...settings,
      heatingGainSource: nextSource,
    };

    setSettings(nextSettings);
    setIsSavingGainSource(true);
    void saveSettings(nextSettings).finally(() => setIsSavingGainSource(false));
  };

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

    return buildLearningInfoRows(
      gainEstimate,
      backtest,
      settings.heatingGainSource,
    );
  }, [readings, settings.heatingGainSource]);

  const debugSegmentRows = useMemo(() => {
    if (!readings) {
      return null;
    }

    return buildDebugSegmentRows(estimateHeatingGainPerHour(readings));
  }, [readings]);

  useEffect(() => {
    if (!isDebugSectionOpen || hasRequestedRecoveryReadings.current) {
      return;
    }

    hasRequestedRecoveryReadings.current = true;
    let isActive = true;

    const load = async () => {
      try {
        const startIso = new Date(
          Date.now() - heatingGainHistoryDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const endIso = new Date().toISOString();

        const result = await fetchHeatingGainHistory(async (from, to) => {
          const { data, error: queryError } = await supabase
            .from("tank_readings")
            .select("created_at,top_temp,bottom_temp,heating")
            .gte("created_at", startIso)
            .lte("created_at", endIso)
            .order("created_at", { ascending: true })
            .range(from, to);

          return { data: (data ?? []) as TankTemperatureReading[], error: queryError };
        });

        if (isActive) {
          setRecoveryReadings(result.readings);
        } else {
          // Debug-osio suljettiin ennen kuin haku ehti valmistua - vapauta
          // lippu, jotta seuraava avaus yrittaa hakea uudelleen sen sijaan
          // etta jaisi pysyvasti "Ladataan..."-tilaan.
          hasRequestedRecoveryReadings.current = false;
        }
      } catch {
        if (isActive) {
          setRecoveryReadings([]);
        } else {
          hasRequestedRecoveryReadings.current = false;
        }
      }
    };

    void load();

    return () => {
      isActive = false;
    };
  }, [isDebugSectionOpen]);

  const recoveryEstimate = useMemo(() => {
    if (!recoveryReadings) {
      return null;
    }

    return estimateRecoveryDropPerHour(recoveryReadings);
  }, [recoveryReadings]);

  const recoveryDebugRows = useMemo(
    () => buildRecoveryDebugRows(recoveryEstimate),
    [recoveryEstimate],
  );

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

        <View style={styles.gainSourceCard}>
          <View style={styles.gainSourceRow}>
            <View style={styles.settingTextGroup}>
              <Text style={styles.settingLabel}>Käytä opittua lämmitystehoa</Text>
              <Text style={styles.settingDescription}>
                {settings.heatingGainSource === "fixed"
                  ? `Pois päältä: käytössä on kiinteä ${fallbackHeatingGainPerHour
                      .toFixed(1)
                      .replace(".", ",")} °C/h -oletusarvo, ei opittua arvoa.`
                  : "Päällä: opittua arvoa käytetään heti kun dataa on tarpeeksi, muuten kiinteää oletusarvoa."}
              </Text>
            </View>
            <Switch
              accessibilityLabel="Käytä opittua lämmitystehoa"
              disabled={!areSettingsLoaded || isSavingGainSource}
              onValueChange={handleGainSourceChange}
              thumbColor={
                settings.heatingGainSource !== "fixed" ? "#36f4d4" : "#9aaaca"
              }
              trackColor={{ false: "#39445d", true: "#238b7c" }}
              value={settings.heatingGainSource !== "fixed"}
            />
          </View>
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
                <Text style={styles.debugSectionSubheading}>
                  RecoveryDrop (lämmityksen jälkeinen palautumisvaihe)
                </Text>
                {recoveryDebugRows.map((row) => (
                  <LearningInfoCard key={row.id} row={row} />
                ))}

                <Text style={[styles.debugSectionSubheading, styles.debugSectionSubheadingSpaced]}>
                  Lämmitysjaksot
                </Text>
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
  gainSourceCard: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 20, marginBottom: 12, padding: 16 },
  gainSourceRow: { alignItems: "center", flexDirection: "row", gap: 12 },
  settingTextGroup: { flex: 1, gap: 4 },
  settingLabel: { color: "#d9e9ff", fontSize: 15, fontWeight: "800" },
  settingDescription: { color: "#8ea4cf", fontSize: 12, fontWeight: "700", lineHeight: 16 },
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
  debugSectionSubheading: { color: "#9fc7df", fontSize: 12, fontWeight: "800", marginBottom: 8, textTransform: "uppercase" },
  debugSectionSubheadingSpaced: { marginTop: 14 },
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  defaultSettings,
  EditableSettingKey,
  loadSettings,
  saveSettings,
} from "@/lib/settings";
import { supabase } from "@/lib/supabase";

type SettingsRow = {
  accent: string;
  key?: EditableSettingKey;
  label: string;
  value: string;
};

type TankReadingCalibrationRow = {
  bottom_temp: number | null;
  created_at: string;
  top_temp: number | null;
};

type CalibrationCandidate = {
  averageTemp: number;
  bottomTemp: number;
  createdAt: string;
  topTemp: number;
};

type EditableSettingOption = {
  max?: number;
  min?: number;
  options?: readonly number[];
  unit: string;
};

const editableSettings: Record<EditableSettingKey, EditableSettingOption> = {
  tankSizeLiters: {
    options: [200, 250, 290, 300, 500],
    unit: "l",
  },
  heatingHoursPerDay: {
    max: 6,
    min: 1,
    unit: "h / vrk",
  },
  priceDifferenceThresholdCents: {
    max: 10,
    min: 0,
    unit: "c/kWh",
  },
  fullTankShowers: {
    max: 10,
    min: 3,
    unit: "suihkua",
  },
  minimumShowersBeforeExpensiveTomorrow: {
    max: 8,
    min: 1,
    unit: "suihkua",
  },
  maxTankTemperature: {
    options: [55, 60, 65, 70, 75, 80],
    unit: "°C",
  },
  fullTankAverageTemperature: {
    max: 90,
    min: 20,
    unit: "°C",
  },
};

export default function SettingsScreen() {
  const router = useRouter();
  const [settings, setSettings] = useState(defaultSettings);
  const [selectedSettingKey, setSelectedSettingKey] =
    useState<EditableSettingKey | null>(null);
  const [isCalibratingFullTank, setIsCalibratingFullTank] = useState(false);

  const settingsRows = useMemo(
    (): SettingsRow[] => [
      {
        accent: "#36f4d4",
        key: "tankSizeLiters",
        label: "Varaajan koko",
        value: `${settings.tankSizeLiters} l`,
      },
      {
        accent: "#54eaa0",
        key: "heatingHoursPerDay",
        label: "Lämmitystarve",
        value: `${settings.heatingHoursPerDay} h / vrk`,
      },
      {
        accent: "#ffcf5a",
        key: "priceDifferenceThresholdCents",
        label: "Hintaeron raja",
        value: `${settings.priceDifferenceThresholdCents} c/kWh`,
      },
      {
        accent: "#5aa7ff",
        label: "Minimilämpö",
        value: `${settings.minTankTemperature} °C`,
      },
      {
        accent: "#ff5f6d",
        key: "maxTankTemperature",
        label: "Maksimilämpö",
        value: `${settings.maxTankTemperature} °C`,
      },
      {
        accent: "#ff9b30",
        key: "fullTankAverageTemperature",
        label: "Täyden varaajan keskilämpö",
        value: `${settings.fullTankAverageTemperature} °C`,
      },
      {
        accent: "#b889ff",
        key: "fullTankShowers",
        label: "Täysi varaaja",
        value: `${settings.fullTankShowers} suihkua`,
      },
      {
        accent: "#36f4d4",
        key: "minimumShowersBeforeExpensiveTomorrow",
        label: "Vähimmäisvaraus",
        value: `${settings.minimumShowersBeforeExpensiveTomorrow} suihkua`,
      },
    ],
    [settings],
  );

  const selectedRow = settingsRows.find(
    (row) => row.key === selectedSettingKey,
  );
  const selectedSetting = selectedSettingKey
    ? editableSettings[selectedSettingKey]
    : null;
  const selectedSettingOptions = selectedSetting
    ? selectedSetting.options ??
      Array.from(
        { length: selectedSetting.max! - selectedSetting.min! + 1 },
        (_, index) => selectedSetting.min! + index,
      )
    : [];

  useEffect(() => {
    let isMounted = true;

    loadSettings().then((storedSettings) => {
      if (isMounted) {
        setSettings(storedSettings);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const saveUpdatedSettings = (updatedSettings: typeof settings) => {
    setSettings(updatedSettings);
    saveSettings(updatedSettings).catch(() => undefined);
  };

  const updateSetting = (key: EditableSettingKey, value: number) => {
    saveUpdatedSettings({
      ...settings,
      [key]: value,
    });
    setSelectedSettingKey(null);
  };

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      supabase.auth.getSession().then(({ data: { session } }) => {
        if (isActive && !session) {
          router.replace("/login");
        }
      });

      return () => {
        isActive = false;
      };
    }, [router]),
  );

  const formatCalibrationTime = (createdAt: string) => {
    const calibrationDate = new Date(createdAt);
    const day = String(calibrationDate.getDate()).padStart(2, "0");
    const month = String(calibrationDate.getMonth() + 1).padStart(2, "0");
    const hours = String(calibrationDate.getHours()).padStart(2, "0");
    const minutes = String(calibrationDate.getMinutes()).padStart(2, "0");

    return `${day}.${month}. klo ${hours}:${minutes}`;
  };

  const confirmFullTankCalibration = (candidate: CalibrationCandidate) => {
    const roundedAverageTemp = Math.round(candidate.averageTemp);
    const currentAverageTemp = settings.fullTankAverageTemperature;
    const calibrationDetails = [
      `Löytyi korkein keskilämpö: ${roundedAverageTemp} °C`,
      `Nykyinen asetus: ${currentAverageTemp} °C`,
      `Ylä: ${Math.round(candidate.topTemp)} °C`,
      `Ala: ${Math.round(candidate.bottomTemp)} °C`,
      `Ajankohta: ${formatCalibrationTime(candidate.createdAt)}`,
    ];

    if (Math.abs(roundedAverageTemp - currentAverageTemp) < 1) {
      Alert.alert(
        "Kalibroi täysi varaaja",
        [
          "Nykyinen kalibrointi on jo ajan tasalla.",
          "",
          ...calibrationDetails,
        ].join("\n"),
        [{ text: "OK" }],
      );
      return;
    }

    Alert.alert(
      "Kalibroi täysi varaaja",
      calibrationDetails.join("\n"),
      [
        { text: "Peruuta", style: "cancel" },
        {
          text: "Käytä tätä",
          onPress: () =>
            updateSetting("fullTankAverageTemperature", roundedAverageTemp),
        },
      ],
    );
  };

  const calibrateFullTankFromWeek = async () => {
    if (isCalibratingFullTank) {
      return;
    }

    setIsCalibratingFullTank(true);

    try {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const pageSize = 1000;
      let from = 0;
      let readings: TankReadingCalibrationRow[] = [];

      while (true) {
        const { data, error } = await supabase
          .from("tank_readings")
          .select("created_at, top_temp, bottom_temp")
          .gte("created_at", weekAgo.toISOString())
          .order("created_at", { ascending: true })
          .range(from, from + pageSize - 1);

        if (error) {
          throw error;
        }

        const page = (data ?? []) as TankReadingCalibrationRow[];
        readings = readings.concat(page);

        if (page.length < pageSize) {
          break;
        }

        from += pageSize;
      }

      const bestCandidate = readings.reduce<CalibrationCandidate | null>(
        (best, reading) => {
          if (
            typeof reading.top_temp !== "number" ||
            typeof reading.bottom_temp !== "number"
          ) {
            return best;
          }

          const averageTemp = (reading.top_temp + reading.bottom_temp) / 2;

          if (!best || averageTemp > best.averageTemp) {
            return {
              averageTemp,
              bottomTemp: reading.bottom_temp,
              createdAt: reading.created_at,
              topTemp: reading.top_temp,
            };
          }

          return best;
        },
        null,
      );


      if (!bestCandidate) {
        Alert.alert(
          "Kalibrointia ei voitu tehdä",
          "Viimeiseltä 7 päivältä ei löytynyt kelvollisia lämpötilarivejä.",
        );
        return;
      }

      confirmFullTankCalibration(bestCandidate);
    } catch {
      Alert.alert(
        "Kalibrointi epäonnistui",
        "Viikon lämpötiladataa ei voitu hakea. Yritä hetken kuluttua uudelleen.",
      );
    } finally {
      setIsCalibratingFullTank(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={[styles.glow, styles.greenGlow]} />
      <View style={[styles.glow, styles.blueGlow]} />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Pressable
            accessibilityLabel="Palaa etusivulle"
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Text style={styles.backButtonText}>‹</Text>
          </Pressable>
          <View style={styles.headerTextGroup}>
            <Text style={styles.eyebrow}>Lämmityslogiikka</Text>
            <Text style={styles.title}>Asetukset</Text>
          </View>
        </View>

        <View style={styles.heroCard}>
          <Text style={styles.heroIcon}>⚙️</Text>
          <Text style={styles.heroTitle}>Perusarvot</Text>
          <Text style={styles.heroDescription}>
            Näitä arvoja käytetään varaajan ohjauksen ja lämpimän veden arvion
            perustana.
          </Text>
        </View>

        <View style={styles.settingsCard}>
          {settingsRows.map((row) => {
            const rowContent = (
              <>
                <View
                  style={[
                    styles.settingAccent,
                    { backgroundColor: row.accent },
                  ]}
                />
                <Text style={styles.settingLabel}>{row.label}</Text>
                <Text style={styles.settingValue}>{row.value}</Text>
              </>
            );

            if (row.key) {
              const rowKey = row.key;

              if (rowKey === "fullTankAverageTemperature") {
                return (
                  <View key={row.label} style={styles.settingRowWithAction}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setSelectedSettingKey(rowKey)}
                      style={styles.settingRowMainAction}
                    >
                      {rowContent}
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={isCalibratingFullTank}
                      onPress={calibrateFullTankFromWeek}
                      style={({ pressed }) => [
                        styles.calibrateButton,
                        (pressed || isCalibratingFullTank) &&
                          styles.calibrateButtonPressed,
                      ]}
                    >
                      <Text style={styles.calibrateButtonText}>
                        {isCalibratingFullTank
                          ? "Kalibroidaan..."
                          : "Kalibroi viikon datasta"}
                      </Text>
                    </Pressable>
                  </View>
                );
              }

              return (
                <Pressable
                  accessibilityRole="button"
                  key={row.label}
                  onPress={() => setSelectedSettingKey(rowKey)}
                  style={styles.settingRow}
                >
                  {rowContent}
                </Pressable>
              );
            }

            return (
              <View key={row.label} style={styles.settingRow}>
                {rowContent}
              </View>
            );
          })}
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={handleSignOut}
          style={styles.signOutButton}
        >
          <Text style={styles.signOutButtonText}>Kirjaudu ulos</Text>
        </Pressable>
      </ScrollView>

      <Modal
        animationType="fade"
        onRequestClose={() => setSelectedSettingKey(null)}
        transparent
        visible={selectedSettingKey !== null}
      >
        <Pressable
          accessibilityRole="button"
          onPress={() => setSelectedSettingKey(null)}
          style={styles.selectorOverlay}
        >
          <Pressable style={styles.selectorCard}>
            <Text style={styles.selectorTitle}>{selectedRow?.label}</Text>
            {selectedSettingKey && selectedSetting ? (
              <ScrollView
                showsVerticalScrollIndicator={false}
                style={styles.selectorOptions}
              >
                {selectedSettingOptions.map((option) => (
                  <Pressable
                    accessibilityRole="button"
                    key={option}
                    onPress={() => updateSetting(selectedSettingKey, option)}
                    style={styles.selectorOption}
                  >
                    <Text style={styles.selectorOptionText}>
                      {option} {selectedSetting.unit}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: "#050816",
    flex: 1,
    overflow: "hidden",
  },
  content: {
    flexGrow: 1,
    paddingBottom: 34,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  glow: {
    borderRadius: 999,
    height: 280,
    opacity: 0.24,
    position: "absolute",
    shadowOpacity: 0.55,
    shadowRadius: 72,
    width: 280,
  },
  greenGlow: {
    backgroundColor: "#54eaa0",
    boxShadow: "0 0 92px 44px rgba(84,234,160,0.28)",
    right: -150,
    shadowColor: "#54eaa0",
    top: 80,
  },
  blueGlow: {
    backgroundColor: "#5aa7ff",
    bottom: 70,
    boxShadow: "0 0 96px 46px rgba(90,167,255,0.26)",
    left: -170,
    shadowColor: "#5aa7ff",
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    marginBottom: 20,
  },
  backButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    shadowColor: "#36f4d4",
    shadowOpacity: 0.2,
    shadowRadius: 14,
    width: 44,
  },
  backButtonText: {
    color: "#f7fbff",
    fontSize: 34,
    fontWeight: "700",
    lineHeight: 36,
    marginTop: -3,
  },
  headerTextGroup: {
    flex: 1,
  },
  eyebrow: {
    color: "#36f4d4",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  title: {
    color: "#f7fbff",
    fontSize: 32,
    fontWeight: "900",
    letterSpacing: -0.8,
    marginTop: 3,
  },
  heroCard: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 28,
    borderWidth: 1,
    marginBottom: 16,
    paddingHorizontal: 22,
    paddingVertical: 24,
    shadowColor: "#36f4d4",
    shadowOpacity: 0.18,
    shadowRadius: 24,
  },
  heroIcon: {
    fontSize: 34,
    lineHeight: 40,
    marginBottom: 8,
  },
  heroTitle: {
    color: "#ffffff",
    fontSize: 23,
    fontWeight: "900",
    letterSpacing: -0.3,
  },
  heroDescription: {
    color: "#b9d7ff",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
    marginTop: 9,
    textAlign: "center",
  },
  settingsCard: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 24,
    borderWidth: 1,
    overflow: "hidden",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sectionLabel: {
    color: "#8ea4cf",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1,
    marginTop: 16,
    paddingBottom: 2,
    textTransform: "uppercase",
  },
  settingRow: {
    alignItems: "center",
    borderBottomColor: "rgba(255,255,255,0.09)",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 66,
    paddingVertical: 14,
  },
  settingAccent: {
    borderRadius: 999,
    height: 10,
    shadowOpacity: 0.5,
    shadowRadius: 10,
    width: 10,
  },
  settingLabel: {
    color: "#d9e9ff",
    flex: 1,
    fontSize: 15,
    fontWeight: "800",
  },
  settingInputGroup: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    marginLeft: "auto",
  },
  settingInput: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
    minWidth: 44,
    padding: 0,
    textAlign: "right",
  },
  settingRowWithAction: {
    borderBottomColor: "rgba(255,255,255,0.09)",
    borderBottomWidth: 1,
    paddingVertical: 14,
  },
  settingRowMainAction: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 38,
  },
  settingValue: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: -0.2,
    textAlign: "right",
  },
  calibrateButton: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: "rgba(54,244,212,0.14)",
    borderColor: "rgba(54,244,212,0.34)",
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  calibrateButtonPressed: {
    opacity: 0.62,
  },
  calibrateButtonText: {
    color: "#dffefa",
    fontSize: 13,
    fontWeight: "900",
  },
  signOutButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,95,109,0.14)",
    borderColor: "rgba(255,95,109,0.38)",
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 16,
    paddingVertical: 14,
  },
  signOutButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "900",
  },
  selectorCard: {
    backgroundColor: "#10172a",
    borderColor: "rgba(255,255,255,0.16)",
    borderRadius: 24,
    borderWidth: 1,
    padding: 18,
    width: "82%",
  },
  selectorOption: {
    borderBottomColor: "rgba(255,255,255,0.09)",
    borderBottomWidth: 1,
    paddingVertical: 14,
  },
  selectorOptions: {
    marginTop: 8,
    maxHeight: 360,
  },
  selectorOptionText: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
  },
  selectorOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(5,8,22,0.72)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  selectorTitle: {
    color: "#d9e9ff",
    fontSize: 18,
    fontWeight: "900",
    textAlign: "center",
  },
});
